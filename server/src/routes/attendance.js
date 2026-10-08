import { Router } from 'express';
import { Parser } from 'json2csv';
import prisma from '../db.js';
import {
  verifyJwt,
  requireExecutive,
  requireSuperAdmin,
  requirePresidentOrSuperAdmin,
  isPresidentOrSuperAdmin,
} from '../middleware/auth.js';
import { auditReq } from '../services/audit.js';
import {
  ACTIVE,
  MEMBER_STATUSES,
  NOTE_MAX,
  isActive,
  statusLabel,
  parseStatusUpdate,
} from '../services/memberStatus.js';

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
//
// Director of Public Relations is the same rank and is deliberately not
// here. Exemption is a fact about the communications office, not a
// property of every non-investment officer. A member assigned the PR
// office stays on the weekly roster. The profile route
// (routes/users.js) keeps its own copy of this list; the two move
// together.
const ATTENDANCE_EXEMPT_ROLES = [...ADVISORY_ROLES, 'ChiefOfCommunication'];

// Regular-event roster: exclude everyone whose PRIMARY role is attendance-
// exempt. Leadership (Presidents/PMs) who happen to carry advisory as an
// extraRole still attend regular meetings, so we only filter on primary.
// A president can also take a member off the weekly roster by standing
// (alumni, advisory capacity, on leave — services/memberStatus.js)
// without touching their role, so standing is part of the rule too.
// Advisory events keep their own roster and ignore standing: an alum on
// the advisory board still belongs at those.
const ATTENDEE_WHERE = {
  role: { notIn: ATTENDANCE_EXEMPT_ROLES },
  memberStatus: ACTIVE,
};

// Who is off the weekly roster by standing, and why. The note and the
// who/when are for executives: a president reading the list next year
// should be able to tell an alum from someone on a semester abroad.
const OFF_ROSTER_SELECT = {
  id: true,
  name: true,
  role: true,
  memberStatus: true,
  memberStatusNote: true,
  memberStatusAt: true,
  memberStatusBy: { select: { name: true } },
};

function serializeOffRoster(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    status: u.memberStatus,
    statusLabel: statusLabel(u.memberStatus),
    note: u.memberStatusNote,
    changedAt: u.memberStatusAt,
    changedBy: u.memberStatusBy?.name ?? null,
  };
}

// The opt-out payload for a member whose attendance isn't tracked. The
// web page and the iPhone app both key off `exempt`, so a member off the
// roster by standing gets the same shape as the exempt roles; `reason`
// lets the page say why.
function exemptPayload(reason = null) {
  return {
    exempt: true,
    reason,
    records: [],
    total: 0,
    present: 0,
    excused: 0,
    percentage: null,
  };
}

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
router.get('/', requireExecutive, async (req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const [users, events, offRoster] = await Promise.all([
    prisma.user.findMany({
      where: ATTENDEE_WHERE,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: from, lte: to }, audience: 'all' },
      select: {
        id: true,
        title: true,
        date: true,
        recurring: true,
        cancelledAt: true,
        cancelReason: true,
        cancelledBy: { select: { name: true } },
      },
      orderBy: { date: 'asc' },
    }),
    prisma.user.findMany({
      where: { memberStatus: { not: ACTIVE } },
      select: OFF_ROSTER_SELECT,
      orderBy: { name: 'asc' },
    }),
  ]);
  // A cancelled meeting is shown, so it can be restored, but its marks
  // are left out of what the page counts: nobody can be absent from a
  // meeting that did not happen. They stay in the database for a restore.
  const heldIds = events.filter((e) => !e.cancelledAt).map((e) => e.id);
  // Scope attendance records to just the events in the matrix — keeps any
  // advisory-event records out of the Club Attendance % calculation. A
  // member taken off the roster drops out of the rate as well: their row
  // is gone from the grid, and a percentage built partly from people
  // nobody can see is one nobody can check. Their marks stay in the
  // database and come back if they're restored.
  const records = await prisma.attendance.findMany({
    where: {
      eventId: { in: heldIds },
      userId: { notIn: offRoster.map((u) => u.id) },
    },
  });
  res.json({
    users,
    events: events.map(({ cancelledBy, ...e }) => ({ ...e, cancelledBy: cancelledBy?.name || null })),
    records,
    offRoster: offRoster.map(serializeOffRoster),
    // The choices for taking someone off the roster, from the one list
    // the PUT below validates against.
    memberStatuses: MEMBER_STATUSES.filter((s) => s.value !== ACTIVE),
    noteMax: NOTE_MAX,
    canManageRoster: isPresidentOrSuperAdmin(req.user),
  });
});

// Take a member off the weekly roster, or put them back. Presidents (and
// the owner) only: this changes who the club counts, so it sits with the
// people who run the meeting. Nothing is deleted. Past marks stay on the
// record and reappear in the grid if the member is restored, and the
// audit log keeps every change, not just the latest.
router.put('/roster/:userId', requirePresidentOrSuperAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Bad userId' });
  }
  const parsed = parseStatusUpdate(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { memberStatus: true },
  });
  if (!target) return res.status(404).json({ error: 'Member not found' });

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      memberStatus: parsed.status,
      memberStatusNote: parsed.note,
      memberStatusAt: new Date(),
      memberStatusById: req.user.id,
    },
    select: OFF_ROSTER_SELECT,
  });
  await auditReq(req, 'member.roster_status', 'user', userId, {
    from: target.memberStatus,
    to: parsed.status,
  });
  res.json(serializeOffRoster(updated));
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
// Compose the visible roster for an event, applying the default audience
// (role, and for regular events standing) AND super-admin overrides.
// Returns Sets of user ids — caller hydrates them into name/role objects.
// A member taken off the roster still appears on past meetings they have
// a mark for, through `recorded` below, so history reads as it happened.
//
//   excludedIds = users super admin removed via × (overrides.included=false)
//   includedIds = users super admin added via picker (overrides.included=true)
//   recordedIds = users with an Attendance row for the event
//
// Final roster = (default audience − excluded) ∪ included ∪ recorded
async function rosterIdsForEvent(event) {
  const userWhere =
    event.audience === 'advisory' ? ADVISORY_ROSTER_WHERE : ATTENDEE_WHERE;
  const [defaultUsers, overrides, records] = await Promise.all([
    prisma.user.findMany({ where: userWhere, select: { id: true } }),
    prisma.eventRosterOverride.findMany({
      where: { eventId: event.id },
      select: { userId: true, included: true },
    }),
    prisma.attendance.findMany({
      where: { eventId: event.id },
      select: { userId: true },
    }),
  ]);
  const excluded = new Set();
  const included = new Set();
  for (const o of overrides) {
    if (o.included) included.add(o.userId);
    else excluded.add(o.userId);
  }
  const ids = new Set();
  for (const u of defaultUsers) {
    if (!excluded.has(u.id)) ids.add(u.id);
  }
  for (const id of included) ids.add(id);
  for (const r of records) {
    // Attendance record forces inclusion only if not explicitly excluded
    // (× also clears the record, so this rarely happens; defensive only).
    if (!excluded.has(r.userId)) ids.add(r.userId);
  }
  return { ids, excluded, included };
}

router.get('/event/:id', requireExecutive, async (req, res) => {
  const eventId = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const [{ ids }, records] = await Promise.all([
    rosterIdsForEvent(event),
    prisma.attendance.findMany({ where: { eventId } }),
  ]);

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  });

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

  const [{ ids }, allUsers] = await Promise.all([
    rosterIdsForEvent(event),
    prisma.user.findMany({
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const addable = allUsers.filter((u) => !ids.has(u.id));
  res.json({ users: addable });
});

// Persist a manual roster addition. Used by the "add member" picker so
// the addition survives a reload before any status is set. Idempotent —
// upserts an `included=true` override row.
router.post('/event/:id/include/:userId', requireSuperAdmin, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isInteger(eventId) || !Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Bad eventId or userId' });
  }
  const [event, user] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId } }),
    prisma.user.findUnique({ where: { id: userId } }),
  ]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await prisma.eventRosterOverride.upsert({
    where: { eventId_userId: { eventId, userId } },
    update: { included: true },
    create: { eventId, userId, included: true },
  });
  res.json({ ok: true });
});

// Current user's own record + percentage
router.get('/mine', async (req, res) => {
  // Attendance-exempt roles aren't tracked — return a clear opt-out response
  // instead of an empty 0% card that looks like a bad attendance record.
  if (ATTENDANCE_EXEMPT_ROLES.includes(req.user.role)) {
    return res.json(exemptPayload());
  }
  // Standing isn't on req.user (verifyJwt selects a fixed set), so read
  // it. The president's note is deliberately not sent: it was written for
  // the executives, and this is the member reading about themselves.
  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { memberStatus: true },
  });
  if (!isActive(me?.memberStatus)) {
    return res.json(exemptPayload(statusLabel(me.memberStatus)));
  }
  // A cancelled meeting is nobody's absence, whatever was marked first.
  const records = await prisma.attendance.findMany({
    where: { userId: req.user.id, event: { cancelledAt: null } },
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
      select: { name: true, role: true, extraRoles: true, memberStatus: true },
    }),
    prisma.event.findUnique({
      where: { id: Number(eventId) },
      select: { audience: true, cancelledAt: true },
    }),
  ]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.cancelledAt) {
    return res.status(409).json({
      error: 'This meeting was cancelled. Restore it on the Attendance page to take attendance.',
    });
  }
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
    } else if (target && !isActive(target.memberStatus)) {
      // Off the weekly roster by standing. Refuse rather than mark: a mark
      // would put them back into the rate without anyone deciding they
      // had returned. Restoring them is one click on the same page.
      return res.status(400).json({
        error: `${target.name} is off the weekly roster (${statusLabel(target.memberStatus)}). Restore them on the Attendance page to mark attendance.`,
      });
    }
  }
  const record = await prisma.attendance.upsert({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
    update: { status },
    create: { userId: Number(userId), eventId: Number(eventId), status },
  });
  // Marking a status implies the user is on the roster. If they were
  // previously × removed, clear any "excluded" override so they don't
  // get filtered out next load. We also write an "included" override
  // so a non-default-audience user (e.g. a regular member marked on an
  // advisory event) persists if their record is later cleared.
  await prisma.eventRosterOverride.upsert({
    where: {
      eventId_userId: { eventId: Number(eventId), userId: Number(userId) },
    },
    update: { included: true },
    create: { eventId: Number(eventId), userId: Number(userId), included: true },
  });
  res.json(record);
});

// Remove one user from an event's roster. Super-admin only.
//   1. deletes any Attendance row for that (user, event), and
//   2. writes an `included=false` override so the user stays hidden
//      from the roster on subsequent loads, even if they're a default
//      audience member.
// Re-add via the "add member" picker (which flips the override to
// included=true) or by marking attendance (which does the same).
router.delete('/:userId/:eventId', requireSuperAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(userId) || !Number.isInteger(eventId)) {
    return res.status(400).json({ error: 'Bad userId or eventId' });
  }
  await prisma.$transaction([
    prisma.attendance.deleteMany({ where: { userId, eventId } }),
    prisma.eventRosterOverride.upsert({
      where: { eventId_userId: { eventId, userId } },
      update: { included: false },
      create: { eventId, userId, included: false },
    }),
  ]);
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
    // A cancelled meeting is not a column: the export is the record of
    // meetings that happened.
    prisma.event.findMany({
      where: { date: { gte: from, lte: to }, audience: 'all', cancelledAt: null },
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
