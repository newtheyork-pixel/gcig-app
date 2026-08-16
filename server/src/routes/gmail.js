import express from 'express';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { verifyJwt, requireRole } from '../middleware/auth.js';
import {
  gmailConfigured, consentUrl, exchangeCode, connectionFor, disconnect,
  inboundOnThread, classify, maySendMail, gmailSenders,
} from '../services/gmail.js';

const prisma = new PrismaClient();
const router = express.Router();

// Connecting a mailbox, and pulling what comes back into the ledger.
//
// The OAuth callback is the one route here that CANNOT carry a bearer
// token: Google redirects the browser to it, and a top-level navigation
// carries no Authorization header. So identity travels in the `state`
// parameter, signed with JWT_SECRET and valid for ten minutes. Unsigned
// state would let anyone who guessed a user id bind their own mailbox to
// another member's account.

// The state is signed AND single use AND bound to the browser that started
// the flow, because signing alone only proves who MINTED the URL. A signed
// state that leaks inside its window is a working invitation for a stranger
// to bind their mailbox to the member's account, and the URL is exactly the
// kind of thing somebody pastes into a chat while asking for help.
// In process, which is a real limitation worth naming: the API restarting
// between /connect and /callback loses the nonce and the member has to
// start again, and this would need to move to the database the day the API
// runs on more than one instance. Both failures are a retry, never a
// wrongly-bound mailbox, which is the right way round.
const NONCES = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of NONCES) if (v.at < cutoff) NONCES.delete(k);
}, 60_000).unref?.();

function signState(userId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  NONCES.set(nonce, { userId, at: Date.now() });
  const payload = `${userId}.${nonce}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  return { state: `${payload}.${mac}`, nonce };
}

function readState(state, cookieNonce) {
  const [userId, nonce, ts, mac] = String(state || '').split('.');
  if (!userId || !nonce || !ts || !mac) return null;
  const expect = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`${userId}.${nonce}.${ts}`).digest('hex');
  // Constant time, and length-checked first because timingSafeEqual throws
  // on a length mismatch rather than returning false.
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(ts) > 10 * 60_000) return null;
  // Consumed, not merely read. Deleting before returning is what makes it
  // single use, and doing it here rather than at the call site means two
  // concurrent callbacks cannot both pass.
  const held = NONCES.get(nonce);
  if (!held || held.userId !== Number(userId)) return null;
  NONCES.delete(nonce);
  // The cookie is the browser binding. A forwarded consent URL fails here
  // even before the mailbox allowlist, because the stranger's browser was
  // never issued this nonce.
  if (!cookieNonce || cookieNonce !== nonce) return null;
  return Number(userId);
}

/**
 * The first-party hop. Validates the ninety-second handoff, sets the nonce
 * cookie on the API's own origin, and sends the browser on to Google.
 *
 * Unauthenticated by necessity, like the callback: this is a top-level
 * navigation and carries no bearer header. The handoff token is signed with
 * a different prefix from the state MAC so one can never be replayed as the
 * other.
 */
router.get('/start', (req, res) => {
  const [userId, ts, mac] = String(req.query.t || '').split('.');
  if (!userId || !ts || !mac) return res.status(400).send('Bad link. Start again from the terminal.');
  const expect = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`start.${userId}.${ts}`).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).send('Bad link. Start again from the terminal.');
  }
  // Ninety seconds, the same window the app's native sign-in handoff uses.
  // A link that opens a consent screen should be used immediately or not
  // at all.
  if (Date.now() - Number(ts) > 90_000) {
    return res.status(400).send('That link expired. Start again from the terminal.');
  }
  const { state, nonce } = signState(Number(userId));
  res.cookie('gmail_oauth_nonce', nonce, {
    httpOnly: true, secure: true, sameSite: 'lax',
    path: '/api/gmail', maxAge: 10 * 60_000,
  });
  res.redirect(consentUrl(state));
});

function nonceCookie(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith('gmail_oauth_nonce='));
  return hit ? decodeURIComponent(hit.slice('gmail_oauth_nonce='.length)) : null;
}

router.get('/callback', async (req, res) => {
  const userId = readState(req.query.state, nonceCookie(req));
  res.clearCookie?.('gmail_oauth_nonce', { path: '/api/gmail' });
  if (!userId) return res.status(400).send('That sign-in link expired. Start again from the terminal.');
  if (req.query.error) return res.status(400).send(`Google refused: ${req.query.error}`);
  try {
    const address = await exchangeCode(String(req.query.code || ''), userId);
    res.send(`<html><body style="font-family:system-ui;background:#14120f;color:#e8e2d8;padding:48px">
      <h2 style="font-weight:600">${address} is connected.</h2>
      <p>You can close this tab and go back to the terminal.</p></body></html>`);
  } catch (err) {
    console.error('gmail callback failed:', err.message);
    res.status(500).send(`Could not finish connecting: ${err.message}`);
  }
});

router.use(verifyJwt);

// Says plainly that this is not for you, rather than showing a Connect
// button that 403s. A permission you can see and cannot use reads as a bug.
const senderOnly = (req, res, next) => {
  if (!maySendMail(req.user)) {
    return res.status(403).json({
      error: 'Sending mail from the terminal is limited to named senders.',
      code: 'NOT_A_SENDER',
    });
  }
  next();
};

router.get('/status', async (req, res) => {
  if (!gmailConfigured()) return res.json({ configured: false, connected: false, allowed: false });
  const allowed = maySendMail(req.user);
  if (!allowed) return res.json({ configured: true, allowed: false, connected: false });
  res.json({ configured: true, allowed: true, senders: gmailSenders().length,
             ...(await connectionFor(req.user.id)) });
});

/**
 * Hand the member a URL to OPEN, rather than one to follow in the
 * background.
 *
 * The first version set the nonce cookie on this response and returned
 * Google's URL directly, and it could never have worked. The client lives
 * on thegriffinfund.org and the API on gcig-api.onrender.com, which are
 * different sites, so a cookie set on a cross-site XHR response is dropped
 * by the browser unless it is SameSite=None. Making it None would work and
 * would also mean shipping a cross-site cookie for one flow.
 *
 * So the browser goes to the API itself instead. /start below is a
 * top-level navigation, which makes the cookie first-party to the API, and
 * the callback then arrives at the same origin that set it. No cross-site
 * cookie anywhere, and the nonce binding still holds.
 */
router.get('/connect', senderOnly, async (req, res) => {
  if (!gmailConfigured()) return res.status(503).json({ error: 'Gmail is not configured on this server' });
  const payload = `${req.user.id}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`start.${payload}`).digest('hex');
  const base = (process.env.API_PUBLIC_URL || 'https://gcig-api.onrender.com').replace(/\/+$/, '');
  res.json({ url: `${base}/api/gmail/start?t=${encodeURIComponent(`${payload}.${mac}`)}`,
             open: 'browser' });
});

router.delete('/connection', senderOnly, async (req, res) => {
  await disconnect(req.user.id);
  res.json({ ok: true });
});

/**
 * Pull replies on every thread we started, and write the new ones in.
 *
 * Idempotent by construction: `gmailMessageId` is unique on OutreachMessage,
 * so a sweep that runs twice, or two members sweeping the same project,
 * cannot log a reply twice. That matters more than it sounds, because the
 * whole follow-up clock keys off whether somebody answered.
 *
 * Scoped to the caller's own sent threads. A member cannot sweep a mailbox
 * they did not connect, and the query below can only find threads their own
 * drafts recorded.
 */
router.post('/sync', senderOnly, async (req, res) => {
  try {
    const drafts = await prisma.outreachDraft.findMany({
      where: {
        gmailThreadId: { not: null },
        authorId: req.user.id,
      },
      select: { id: true, targetId: true, gmailThreadId: true },
      orderBy: { id: 'desc' },
      take: 300,
    });

    let found = 0, added = 0;
    const errors = [];
    for (const d of drafts) {
      let msgs;
      try {
        msgs = await inboundOnThread(req.user.id, d.gmailThreadId);
      } catch (err) {
        errors.push(`${d.gmailThreadId}: ${err.message}`);
        continue;
      }
      found += msgs.length;
      for (const m of msgs) {
        try {
          await prisma.outreachMessage.create({
            data: {
              targetId: d.targetId,
              // Attached to the draft it answers. Ten replies once went in
              // without this and rendered nowhere, because the client shows
              // a thread under the draft that started it.
              draftId: d.id,
              direction: 'in',
              kind: classify(m),
              occurredAt: m.occurredAt,
              body: m.body?.slice(0, 20_000) || null,
              gmailMessageId: m.gmailMessageId,
              recordedById: null,
            },
          });
          added += 1;
        } catch (err) {
          // P2002 is the unique constraint doing its job: we already have it.
          if (err?.code !== 'P2002') errors.push(`${m.gmailMessageId}: ${err.message}`);
        }
      }
    }

    await prisma.gmailAccount.updateMany({
      where: { userId: req.user.id },
      data: { lastSyncAt: new Date() },
    });

    // Errors are REPORTED, never swallowed. A sweep that quietly skipped
    // half the threads and said "0 new" is indistinguishable from a quiet
    // week, and the quiet week is the one that ends a contact.
    res.json({ threads: drafts.length, seen: found, added, errors: errors.slice(0, 10),
               errorCount: errors.length });
  } catch (err) {
    console.error('gmail sync failed:', err.message);
    res.status(500).json({ error: 'Could not read replies' });
  }
});

export default router;
