import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { auditReq } from '../services/audit.js';
import { ensureRecurringMeetings } from '../services/recurringMeetings.js';
import { easternDateKey } from '../services/easternTime.js';
import { parseSeriesInput, describeSeries } from '../services/eventSeriesInput.js';

// The club's weekly meetings, kept on the Attendance page. It was a
// constant in code, so moving the meeting took a deploy. Any change here
// reshapes UPCOMING meetings only (services/recurringMeetings.js); what
// already happened, and the attendance taken at it, never moves.
//
// Ending a series is an edit (endsOn), and so is resuming one (endsOn:
// null). Nothing deletes a series: its past meetings still point at it.
const router = Router();
router.use(verifyJwt, requireExecutive);

function present(series, today) {
  return {
    ...series,
    summary: describeSeries(series),
    active: !series.endsOn || series.endsOn >= today,
  };
}

router.get('/', async (_req, res) => {
  const today = easternDateKey(new Date());
  const list = await prisma.eventSeries.findMany({ orderBy: { createdAt: 'asc' } });
  res.json(list.map((s) => present(s, today)));
});

router.post('/', async (req, res) => {
  const today = easternDateKey(new Date());
  const parsed = parseSeriesInput(req.body, { today });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const series = await prisma.eventSeries.create({ data: parsed.data });
  const changes = await ensureRecurringMeetings({ seriesId: series.id });
  await auditReq(req, 'event_series.created', 'event_series', series.id, {
    title: series.title,
    schedule: describeSeries(series),
    startsOn: series.startsOn,
    endsOn: series.endsOn,
  });
  res.status(201).json({ series: present(series, today), changes });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = Number.isInteger(id) ? await prisma.eventSeries.findUnique({ where: { id } }) : null;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const parsed = parseSeriesInput(req.body, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  if (parsed.data.endsOn && parsed.data.endsOn < existing.startsOn) {
    return res.status(400).json({ error: 'The last meeting cannot come before the first.' });
  }

  const today = easternDateKey(new Date());
  const series = await prisma.eventSeries.update({ where: { id }, data: parsed.data });
  const changes = await ensureRecurringMeetings({ seriesId: id });
  await auditReq(req, 'event_series.updated', 'event_series', id, {
    from: { title: existing.title, schedule: describeSeries(existing), location: existing.location, endsOn: existing.endsOn },
    to: { title: series.title, schedule: describeSeries(series), location: series.location, endsOn: series.endsOn },
  });
  res.json({ series: present(series, today), changes });
});

export default router;
