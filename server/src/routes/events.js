import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// Who can see Advisory Board events: the Advisory Board itself, Faculty
// Advisors, and the operational leadership (Presidents + CIO) who schedule
// and run them. Every other member sees only audience='all' events.
const ADVISORY_VISIBLE_ROLES = new Set([
  'AdvisoryBoardMember',
  'FacultyAdvisory',
  'President',
  'CIO',
]);

export function canSeeAdvisoryEvents(role) {
  return ADVISORY_VISIBLE_ROLES.has(role);
}

// Prisma `where` fragment that hides advisory events from members who
// shouldn't see them. Callers spread this into their own where clause.
export function eventAudienceWhere(role) {
  return canSeeAdvisoryEvents(role) ? {} : { audience: 'all' };
}

router.get('/', async (req, res) => {
  const events = await prisma.event.findMany({
    where: eventAudienceWhere(req.user.role),
    orderBy: { date: 'desc' },
  });
  res.json(events);
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return res.status(404).json({ error: 'Not found' });
  // Advisory events are invisible to members who don't have visibility.
  // Return 404 (not 403) so we don't leak the existence of the event.
  if (event.audience === 'advisory' && !canSeeAdvisoryEvents(req.user.role)) {
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
  const { title, date, location, description, audience } = req.body || {};
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date required' });
  }
  const event = await prisma.event.create({
    data: {
      title,
      date: new Date(date),
      location: location || null,
      description: description || null,
      audience: normalizeAudience(audience),
    },
  });
  res.status(201).json(event);
});

router.put('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.recurring) {
    return res.status(400).json({ error: 'Recurring meetings are managed in code' });
  }
  const { title, date, location, description, audience } = req.body || {};
  const data = {};
  if (title !== undefined) data.title = title;
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (description !== undefined) data.description = description || null;
  if (audience !== undefined) data.audience = normalizeAudience(audience);
  const event = await prisma.event.update({ where: { id }, data });
  res.json(event);
});

router.delete('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.recurring) {
    return res.status(400).json({ error: 'Recurring meetings are managed in code' });
  }
  await prisma.event.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
