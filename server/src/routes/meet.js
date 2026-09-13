import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt, denyGuest, serializeUser } from '../middleware/auth.js';
import { mintJitsiToken, meetingUrl, isConfigured } from '../services/jitsiToken.js';
import { sendMeetingLinkEmail } from '../services/email.js';

// Meetings on the club's own server.
//
// The meeting server has no memory. A Jitsi room exists while people are in
// it and is gone afterwards, so everything that has to outlive the call —
// the code, the title, when it starts, who called it — lives here.
//
// Access works the way the meeting server is configured, and the two halves
// are easy to get backwards:
//
//   opening a room requires a token, and only this file mints them
//   joining a room that is already open requires nothing
//
// That is deliberate. A link can be forwarded to an outside expert without
// giving them an account, and a link that leaks before the meeting starts
// opens nothing. It also means a room code that is not in this table can
// never be opened at all, which is what stops meet.thegriffinfund.org
// becoming a free conferencing service for whoever finds it.

// Ambiguous characters are left out. These codes get read aloud on the
// phone and typed off a screen, and 0/O and 1/l/I are where that goes wrong.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

export function randomSuffix(len = 6, rng = () => Math.random()) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return out;
}

// A code is the slug plus random characters. The slug is there so a member
// can tell two links apart in their inbox; the random part is what makes the
// code unguessable. The slug alone would mean "pitch-review" collides every
// term and, worse, is trivially guessable by anyone who knows the club's
// calendar.
export function buildCode(title, rng) {
  const base = slugify(title);
  const suffix = randomSuffix(6, rng);
  return base ? `${base}-${suffix}` : `meeting-${suffix}`;
}

// Who gets moderator powers in the room: mute others, remove people, end it
// for everyone. The person who called the meeting, plus the club's officers.
// Everyone else joins as a participant.
//
// Note this is NOT the same as who may open the room. Any member's token
// opens it, and auto-owner promotes whoever arrives first, so a meeting is
// never locked out because its organiser is running late.
const MODERATOR_ROLES = new Set(['President', 'CIO', 'DirectorOfResearch', 'PortfolioManager']);

export function isModerator(user, meeting) {
  if (!user) return false;
  if (meeting && meeting.createdById === user.id) return true;
  const roles = [user.role, ...(user.extraRoles || [])];
  return roles.some((r) => MODERATOR_ROLES.has(r));
}

function publicMeeting(m, { origin } = {}) {
  return {
    code: m.code,
    title: m.title,
    startsAt: m.startsAt,
    durationMinutes: m.durationMinutes,
    eventId: m.eventId,
    endedAt: m.endedAt,
    cancelledAt: m.cancelledAt,
    createdAt: m.createdAt,
    createdBy: m.createdBy
      ? { id: m.createdBy.id, name: m.createdBy.name }
      : { id: m.createdById },
    // The shareable link carries NO token. A token is minted per person when
    // they ask to join, so the thing that gets pasted into an email cannot
    // be replayed by whoever it is forwarded to.
    url: meetingUrl({ code: m.code, title: m.title, base: origin }),
  };
}

// ---------------------------------------------------------------------------
// Handlers, exported so the tests can drive them with an injected db.
// ---------------------------------------------------------------------------

export async function createMeetingHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  const rng = deps.rng;
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (title.length > 120) return res.status(400).json({ error: 'Title is too long' });

  let startsAt = null;
  if (req.body?.startsAt) {
    const d = new Date(req.body.startsAt);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'startsAt is not a date' });
    startsAt = d;
  }

  const durationMinutes = Number(req.body?.durationMinutes) || 60;
  if (durationMinutes < 5 || durationMinutes > 8 * 60) {
    return res.status(400).json({ error: 'durationMinutes must be between 5 and 480' });
  }

  const eventId = req.body?.eventId ? Number(req.body.eventId) : null;
  if (eventId !== null && !Number.isInteger(eventId)) {
    return res.status(400).json({ error: 'eventId must be a number' });
  }

  // Retry on collision rather than trusting six random characters to be
  // unique forever. The unique index is the real guarantee; this just keeps
  // a one-in-a-billion clash from surfacing as a 500.
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    const code = buildCode(title, rng);
    try {
      created = await db.meeting.create({
        data: {
          code,
          title,
          startsAt,
          durationMinutes,
          eventId,
          createdById: req.user.id,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
    }
  }
  if (!created) return res.status(500).json({ error: 'Could not allocate a meeting code' });

  return res.status(201).json(publicMeeting(created, { origin: deps.origin }));
}

export async function listMeetingsHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  const now = deps.now ? new Date(deps.now) : new Date();
  // Anything scheduled from an hour ago onward is still "upcoming": a
  // meeting that started twenty minutes ago is the one you are trying to
  // join, and dropping it off the list the moment it begins is the single
  // most annoying thing this page could do.
  const since = new Date(now.getTime() - 60 * 60 * 1000);

  const rows = await db.meeting.findMany({
    where: {
      cancelledAt: null,
      endedAt: null,
      OR: [{ startsAt: null, createdAt: { gte: since } }, { startsAt: { gte: since } }],
    },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
    take: 50,
  });

  return res.json({ meetings: rows.map((m) => publicMeeting(m, { origin: deps.origin })) });
}

export async function getMeetingHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  const m = await db.meeting.findUnique({
    where: { code: String(req.params.code) },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  if (!m) return res.status(404).json({ error: 'No such meeting' });
  return res.json(publicMeeting(m, { origin: deps.origin }));
}

// The one endpoint that matters. Everything else is bookkeeping; this is
// what decides whether a person may open a room on our server.
export async function meetingTokenHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  if (!isConfigured()) {
    return res.status(503).json({ error: 'The meeting server is not configured on this deployment' });
  }

  const m = await db.meeting.findUnique({ where: { code: String(req.params.code) } });
  // A code we did not issue gets nothing. This is the check that keeps the
  // meeting server from being usable by anyone who finds the address.
  if (!m) return res.status(404).json({ error: 'No such meeting' });
  if (m.cancelledAt) return res.status(410).json({ error: 'That meeting was cancelled' });
  if (m.endedAt) return res.status(410).json({ error: 'That meeting has ended' });

  const token = mintJitsiToken({
    room: m.code,
    user: req.user,
    moderator: isModerator(req.user, m),
  });

  return res.json({
    code: m.code,
    title: m.title,
    moderator: isModerator(req.user, m),
    // This URL carries the caller's own token and is not shareable.
    joinUrl: meetingUrl({ code: m.code, token, title: m.title, base: deps.origin }),
  });
}

export async function emailMeetingHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  const send = deps.send || sendMeetingLinkEmail;
  const m = await db.meeting.findUnique({
    where: { code: String(req.params.code) },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  if (!m) return res.status(404).json({ error: 'No such meeting' });

  // Deliberately only ever to the caller's own address, never to one supplied
  // in the request. Mailing a meeting link to an arbitrary recipient is
  // outreach, and outreach in this codebase is staged for a human to send,
  // never sent by a handler. Inviting other people is a compose step the
  // member takes themselves with the link this puts in their inbox.
  const to = req.user.email;
  if (!to) return res.status(400).json({ error: 'Your account has no email address' });

  try {
    await send(to, {
      name: req.user.name,
      title: m.title,
      startsAt: m.startsAt,
      durationMinutes: m.durationMinutes,
      url: meetingUrl({ code: m.code, title: m.title, base: deps.origin }),
      organiser: m.createdBy?.name || null,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not send the email', detail: String(err.message || err) });
  }
  return res.json({ sent: true, to });
}

export async function endMeetingHandler(req, res, deps = {}) {
  const db = deps.db || prisma;
  const field = req.method === 'DELETE' ? 'cancelledAt' : 'endedAt';
  const m = await db.meeting.findUnique({ where: { code: String(req.params.code) } });
  if (!m) return res.status(404).json({ error: 'No such meeting' });
  if (!isModerator(req.user, m)) {
    return res.status(403).json({ error: 'Only the organiser or an officer can do that' });
  }
  const updated = await db.meeting.update({
    where: { code: m.code },
    data: { [field]: new Date() },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  return res.json(publicMeeting(updated, { origin: deps.origin }));
}

// ---------------------------------------------------------------------------

const router = Router();

// Creating meetings is cheap but not free: each one is a row and a mail.
const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40 });
const emailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

router.use(verifyJwt, denyGuest);

router.post('/meetings', createLimiter, (req, res, next) =>
  createMeetingHandler(req, res).catch(next));
router.get('/meetings', (req, res, next) =>
  listMeetingsHandler(req, res).catch(next));
router.get('/meetings/:code', (req, res, next) =>
  getMeetingHandler(req, res).catch(next));
router.post('/meetings/:code/token', (req, res, next) =>
  meetingTokenHandler(req, res).catch(next));
router.post('/meetings/:code/email', emailLimiter, (req, res, next) =>
  emailMeetingHandler(req, res).catch(next));
router.post('/meetings/:code/end', (req, res, next) =>
  endMeetingHandler(req, res).catch(next));
router.delete('/meetings/:code', (req, res, next) =>
  endMeetingHandler(req, res).catch(next));

export default router;
