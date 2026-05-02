import { Router } from 'express';
import { Parser } from 'json2csv';
import prisma from '../db.js';
import {
  verifyJwt,
  requireExecutive,
  requireSuperAdmin,
} from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// Advisory roles (Advisory Board, Faculty Advisor). Members can hold these
// as their PRIMARY role OR carry them as extraRoles (e.g. a President who
// also serves on the advisory board). Both count for audience gating.
const ADVISORY_ROLES = ['AdvisoryBoardMember', 'FacultyAdvisory'];

// Roles that sit entirely outside attendance. Advisory roles have their own
// attendance at advisory-tagged events, but Chief of Communication doesn't
// attend meetings in a counted capacity at all. Anyone whose PRIMARY role is
// in this set is invisible to the attendance UI and their /mine endpoint
// returns an opt-out payload instead of a 0% card.
const ATTENDANCE_EXEMPT_ROLES = [...ADVISORY_ROLES, 'ChiefOfCommunication'];

// Regular-event roster: exclude everyone whose PRIMARY role is attendance-
// exempt. Leadership (Presidents/PMs) who happen to carry advisory as an
// extraRole still attend regular meetings, so we only filter on primary.
const ATTENDEE_WHERE = { role: { notIn: ATTENDANCE_EXEMPT_ROLES } };

// For advisory events, the roster is "anyone with advisory in primary OR
// extra roles". Prisma `hasSome` covers the extras side. Chief of
// Communication is NOT included here — they're exempt from all attendance.
const ADVISORY_ROSTER_WHERE = {
  OR: [
    { role: { in: ADVISORY_ROLES } },
    { extraRoles: { hasSome: ADVISORY_ROLES } },
  ],
};

function isAdvisoryUser(target) {
  if (!target) return false;
  if (ADVISORY_ROLES.includes(target.role)) return true;
  const extras = target.extraRoles || [];
  return extras.some((r) => ADVISORY_ROLES.includes(r));
}

// Full matrix — President only.
// Only show events from 3 months ago through 2 weeks from now —
// no one needs to mark attendance for meetings months in the future.
// Advisory-audience events are excluded: they have their own roster
// (Advisory Board + Faculty) and shouldn't dilute the club-wide stat.
router.get('/', requireExecutive, async (_req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const [users, events] = await Promise.all([
    prisma.user.findMany({
      where: ATTENDEE_WHERE,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: from, lte: to }, audience: 'all' },
      select: { id: true, title: true, date: true },
      orderBy: { date: 'asc' },
    }),
  ]);
  // Scope attendance records to just the events in the matrix — keeps any
  // advisory-event records out of the Club Attendance % calculation.
  const records = await prisma.attendance.findMany({
    where: { eventId: { in: events.map((e) => e.id) } },
  });
  res.json({ users, events, records });
});

// Attendance for a single event — President only.
// Returns the attendee roster for the event's audience + an object
// { userId: status } of existing records.
//
// Audience handling:
//   'advisory' — return ONLY Advisory Board / Faculty Advisory members.
//                Regular members don't attend these meetings.
//   'all' (default) — return every non-exempt operational member, same
//                     as the club-wide attendance matrix.
router.get('/event/:id', requireExecutive, async (req, res) => {
  const eventId = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const userWhere =
    event.audience === 'advisory' ? ADVISORY_ROSTER_WHERE : ATTENDEE_WHERE;

  const [defaultUsers, records] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.attendance.findMany({ where: { eventId } }),
  ]);

  // Super-admin overrides: any user with an attendance record on this event
  // appears in the roster, even if their role normally excludes them. Lets
  // the owner add anyone to any event without changing role configuration.
  let users = defaultUsers;
  const inRoster = new Set(defaultUsers.map((u) => u.id));
  const extraIds = records
    .map((r) => r.userId)
    .filter((id) => !inRoster.has(id));
  if (extraIds.length > 0) {
    const extras = await prisma.user.findMany({
      where: { id: { in: extraIds } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    users = [...defaultUsers, ...extras].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  const byUser = {};
  for (const r of records) byUser[r.userId] = r.status;
  res.json({ event, users, records: byUser });
});

// Full member directory for the super-admin "add someone" picker. Returns
// every user the super admin could possibly add to an event roster — i.e.
// anyone NOT currently in the visible roster for the given event.
router.get('/event/:id/addable', requireSuperAdmin, async (req, res) => {
  const eventId = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const userWhere =
    event.audience === 'advisory' ? ADVISORY_ROSTER_WHERE : ATTENDEE_WHERE;
  const [defaultUsers, records, allUsers] = await Promise.all([
    prisma.user.findMany({ where: userWhere, select: { id: true } }),
    prisma.attendance.findMany({
      where: { eventId },
      select: { userId: true },
    }),
    prisma.user.findMany({
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const inRoster = new Set([
    ...defaultUsers.map((u) => u.id),
    ...records.map((r) => r.userId),
  ]);
  const addable = allUsers.filter((u) => !inRoster.has(u.id));
  res.json({ users: addable });
});

// Current user's own record + percentage
router.get('/mine', async (req, res) => {
  // Attendance-exempt roles aren't tracked — return a clear opt-out response
  // instead of an empty 0% card that looks like a bad attendance record.
  if (ATTENDANCE_EXEMPT_ROLES.includes(req.user.role)) {
    return res.json({
      exempt: true,
      records: [],
      total: 0,
      present: 0,
      excused: 0,
      percentage: null,
    });
  }
  const records = await prisma.attendance.findMany({
    where: { userId: req.user.id },
    include: { event: { select: { id: true, title: true, date: true } } },
    orderBy: { event: { date: 'desc' } },
  });
  const total = records.length;
  const present = records.filter((r) => r.status === 'Present').length;
  const excused = records.filter((r) => r.status === 'Excused').length;
  const pct = total > 0 ? Math.round(((present + excused) / total) * 100) : 0;
  res.json({ records, total, present, excused, percentage: pct });
});

// Upsert one attendance mark. The user-role gate matches the event audience:
//   advisory event  → only advisory users are valid attendees
//   regular event   → only non-exempt users are valid attendees
router.post('/', requireExecutive, async (req, res) => {
  const { userId, eventId, status } = req.body || {};
  if (!userId || !eventId || !status) {
    return res.status(400).json({ error: 'userId, eventId, status required' });
  }
  if (!['Present', 'Absent', 'Excused'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const [target, event] = await Promise.all([
    prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { role: true, extraRoles: true },
    }),
    prisma.event.findUnique({
      where: { id: Number(eventId) },
      select: { audience: true },
    }),
  ]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Super admin bypasses role gating entirely — they can mark anyone on
  // any event (the "add Bob to the advisory meeting" override).
  if (!req.user?.isSuperAdmin) {
    const targetIsAdvisory = isAdvisoryUser(target);
    if (event.audience === 'advisory') {
      if (!targetIsAdvisory) {
        return res.status(400).json({
          error: 'Only Advisory Board / Faculty Advisors attend Advisory Board events',
        });
      }
    } else if (target && ATTENDANCE_EXEMPT_ROLES.includes(target.role)) {
      // Refuse regular-event marking when the user's PRIMARY role is attendance-
      // exempt. Leadership who also has advisory as an extraRole still attends
      // regular meetings.
      return res.status(400).json({
        error: 'Attendance is not tracked for this role',
      });
    }
  }
  const record = await prisma.attendance.upsert({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
    update: { status },
    create: { userId: Number(userId), eventId: Number(eventId), status },
  });
  res.json(record);
});

// Remove one attendance row. Super-admin only — used by the "remove from
// roster" button to clear a user's mark on a specific event. If the user
// is in the default audience roster they'll reappear unmarked next load;
// if they were a manual super-admin add they disappear from the roster.
router.delete('/:userId/:eventId', requireSuperAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(userId) || !Number.isInteger(eventId)) {
    return res.status(400).json({ error: 'Bad userId or eventId' });
  }
  await prisma.attendance.deleteMany({ where: { userId, eventId } });
  res.json({ ok: true });
});

// Wipe every attendance row for a given event. Used when an exec
// accidentally took attendance against the wrong meeting (typically the
// "current" pin pointed at the next week before midnight). The Event
// row itself stays — only the per-member status records are cleared.
router.delete('/event/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Bad event id' });
  }
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const result = await prisma.attendance.deleteMany({ where: { eventId: id } });
  res.json({ ok: true, cleared: result.count });
});

router.get('/export.csv', requireExecutive, async (_req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const [users, events] = await Promise.all([
    prisma.user.findMany({
      where: ATTENDEE_WHERE,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: from, lte: to }, audience: 'all' },
      select: { id: true, title: true, date: true },
      orderBy: { date: 'asc' },
    }),
  ]);
  const records = await prisma.attendance.findMany({
    where: { eventId: { in: events.map((e) => e.id) } },
  });

  const recordMap = new Map();
  for (const r of records) {
    recordMap.set(`${r.userId}:${r.eventId}`, r.status);
  }

  const eventColumns = events.map((e) => `${e.title} (${new Date(e.date).toISOString().slice(0, 10)})`);
  const rows = users.map((u) => {
    const row = { Name: u.name, Role: u.role };
    events.forEach((e, i) => {
      row[eventColumns[i]] = recordMap.get(`${u.id}:${e.id}`) || '';
    });
    return row;
  });

  const fields = ['Name', 'Role', ...eventColumns];
  const parser = new Parser({ fields });
  const csv = parser.parse(rows);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="gcig-attendance.csv"');
  res.send(csv);
});

export default router;
