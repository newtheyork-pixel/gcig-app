import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { mentionsSegLabel } from '../services/segLabel.js';
import { auditReq } from '../services/audit.js';

const router = Router();
router.use(verifyJwt);

// Who can see Advisory Board events:
//   - Anyone with an advisory role (primary OR extra):
//     AdvisoryBoardMember, FacultyAdvisory
//   - Operational leadership (Presidents + CIO) who schedule and run them
// Everyone else sees only audience='all' events.
const ADVISORY_ROLES = ['AdvisoryBoardMember', 'FacultyAdvisory'];
const LEADERSHIP_ROLES = ['President', 'CIO'];

export function canSeeAdvisoryEvents(user) {
  // Back-compat: accept either a full user object or a bare role string.
  if (typeof user === 'string') {
    return ADVISORY_ROLES.includes(user) || LEADERSHIP_ROLES.includes(user);
  }
  if (!user) return false;
  if (LEADERSHIP_ROLES.includes(user.role)) return true;
  if (ADVISORY_ROLES.includes(user.role)) return true;
  const extras = user.extraRoles || [];
  return extras.some((r) => ADVISORY_ROLES.includes(r));
}

// Prisma `where` fragment that hides advisory events from members who
// shouldn't see them. Callers spread this into their own where clause.
export function eventAudienceWhere(user) {
  return canSeeAdvisoryEvents(user) ? {} : { audience: 'all' };
}

function eventShowsLabel(event) {
  return mentionsSegLabel(event?.title)
    || mentionsSegLabel(event?.location)
    || mentionsSegLabel(event?.description);
}

router.get('/', async (req, res) => {
  // Cancelled meetings are left out unless asked for. The website's
  // calendar asks, so it can mark them; the iPhone app's Club tab does
  // not, and would otherwise list a cancelled meeting as a real one.
  const includeCancelled = req.query.includeCancelled === '1';
  const events = await prisma.event.findMany({
    where: {
      ...eventAudienceWhere(req.user),
      ...(includeCancelled ? {} : { cancelledAt: null }),
    },
    orderBy: { date: 'desc' },
    ...(includeCancelled ? { include: { cancelledBy: { select: { name: true } } } } : {}),
  });
  res.json(events.filter((event) => !eventShowsLabel(event)));
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event || eventShowsLabel(event)) return res.status(404).json({ error: 'Not found' });
  // Advisory events are invisible to members who don't have visibility.
  // Return 404 (not 403) so we don't leak the existence of the event.
  if (event.audience === 'advisory' && !canSeeAdvisoryEvents(req.user)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(event);
});

// Accepted audience values. Anything else gets coerced to 'all'.
const VALID_AUDIENCES = new Set(['all', 'advisory']);
function normalizeAudience(raw) {
  return VALID_AUDIENCES.has(raw) ? raw : 'all';
}

router.post('/', requireExecutive, async (req, res) => {
  const { title, date, location, description, audience, slideshowUrl, durationMinutes } =
    req.body || {};
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date required' });
  }
  if (Number.isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: 'That date could not be read.' });
  }
  const minutes = durationMinutes === undefined ? undefined : Number(durationMinutes);
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 5 || minutes > 480)) {
    return res.status(400).json({ error: 'A meeting runs between 5 minutes and 8 hours.' });
  }
  if (mentionsSegLabel(title) || mentionsSegLabel(location) || mentionsSegLabel(description)) {
    return res.status(400).json({ error: 'That name cannot be shown on the site.' });
  }
  const event = await prisma.event.create({
    data: {
      title,
      date: new Date(date),
      location: location || null,
      description: description || null,
      audience: normalizeAudience(audience),
      slideshowUrl: slideshowUrl || null,
      ...(minutes !== undefined ? { durationMinutes: minutes } : {}),
    },
  });
  res.status(201).json(event);
});

router.put('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, date, location, description, audience, slideshowUrl } =
    req.body || {};
  // A weekly meeting follows its series (title, date, location), which is
  // edited as a whole on the Attendance page. The only field execs may
  // update on one occurrence is the attached slideshow — it's a
  // per-occurrence asset, not part of the schedule.
  if (
    existing.recurring &&
    (title !== undefined ||
      date !== undefined ||
      location !== undefined ||
      description !== undefined ||
      audience !== undefined)
  ) {
    return res.status(400).json({
      error:
        'This is a weekly meeting. Change the weekly schedule on the Attendance page; only its slideshow is edited here.',
    });
  }
  const data = {};
  if (title !== undefined) data.title = title;
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (description !== undefined) data.description = description || null;
  if (audience !== undefined) data.audience = normalizeAudience(audience);
  if (slideshowUrl !== undefined) data.slideshowUrl = slideshowUrl || null;
  if (['title', 'location', 'description'].some((k) => mentionsSegLabel(data[k]))) {
    return res.status(400).json({ error: 'That name cannot be shown on the site.' });
  }
  const event = await prisma.event.update({ where: { id }, data });
  if (eventShowsLabel(event)) return res.status(404).json({ error: 'Not found' });
  res.json(event);
});

router.delete('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.recurring) {
    return res.status(400).json({
      error: 'This is a weekly meeting. Cancel this week instead, so attendance stays right.',
    });
  }
  await prisma.event.delete({ where: { id } });
  res.json({ ok: true });
});

// Cancel one meeting, weekly or one-off. It stays on the calendar saying
// so, nobody can be marked at it, and it counts toward nobody's rate.
// Marks already taken are kept rather than deleted, so a restore puts
// the meeting back exactly as it was.
export const CANCEL_REASON_MAX = 200;

router.post('/:id/cancel', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length > CANCEL_REASON_MAX) {
    return res.status(400).json({ error: `Keep the reason under ${CANCEL_REASON_MAX} characters.` });
  }
  if (mentionsSegLabel(reason)) {
    return res.status(400).json({ error: 'That name cannot be shown on the site.' });
  }
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing || eventShowsLabel(existing)) return res.status(404).json({ error: 'Not found' });
  const event = await prisma.event.update({
    where: { id },
    data: { cancelledAt: new Date(), cancelReason: reason || null, cancelledById: req.user.id },
  });
  await auditReq(req, 'event.cancelled', 'event', id, {
    title: existing.title,
    date: existing.date,
    reason: reason || null,
  });
  res.json(event);
});

router.post('/:id/restore', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing || eventShowsLabel(existing)) return res.status(404).json({ error: 'Not found' });
  const event = await prisma.event.update({
    where: { id },
    data: { cancelledAt: null, cancelReason: null, cancelledById: null },
  });
  await auditReq(req, 'event.restored', 'event', id, { title: existing.title, date: existing.date });
  res.json(event);
});

export default router;
