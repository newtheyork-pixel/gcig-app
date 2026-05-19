import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';

// Per-user price / day-%-move alert rules. A logged-in member sets any
// number of rules (bounded — see the active cap) on tickers; the
// Layout-mounted poller (client-side, while the app is open) reads the
// caller's active rules, taps the rate-bounded /terminal/quotes for
// their tickers, evaluates crossings in the browser, fires the in-app
// popup, and POSTs /:id/fired so the rule one-shots. There is no
// server cron and no logged-out push — a server-side evaluator polling
// Finnhub for every user's tickers would blow the free 60-rpm budget,
// and the app's existing notifications already work exactly this way.
// That limitation is stated in the spec, the UI, and to the user.
//
// A rule is deliberately independent of any Watchlist — just
// user + ticker + condition — so it survives a ticker leaving a list
// and doesn't care which list (if any) it's on. The whole contract
// rests on the same security invariant Watchlist's `ownedList`
// enforces: every read or mutation is scoped by req.user.id, and
// `ownedAlert` is the single chokepoint — an alert id whose
// alert.userId doesn't match the caller is indistinguishable from one
// that doesn't exist (both → null → the caller answers 404), so the
// endpoint never reveals, confirms, or touches another user's data.
//
// Every handler is never-5xx, the same posture watchlist.js / the
// terminal quote routes promise: known cases get an honest 4xx
// (404 not-owned, 409 cap, 400 bad input), and a *truly unexpected*
// fault is caught and degraded to a benign, leak-free 200 rather than
// thrown — GET to `{ alerts: [] }` (the panel shows an honest empty
// state, never an error), a mutation to `{ ok:false, error }` with NO
// `alerts` key, so the client keeps the state it already had and just
// surfaces a soft inline notice. The endpoint can therefore never 5xx.
//
// Handlers are exported and take an injectable `db` (defaulting to the
// shared prisma) so the route suite can drive them with an in-memory
// prisma-double — the same harness-free, injected-deps testing
// precedent watchlist.test.js / terminal.quotes.test.js set. /fired
// also takes an injectable `now` so its lastFiredAt stamp is testable
// without a real clock.

const router = Router();
router.use(verifyJwt);

// Bounds the live-quote fan-out the Layout poller drives: it fetches
// /terminal/quotes for the distinct tickers across the caller's ACTIVE
// rules, and /terminal/quotes itself caps a single request at 40
// symbols. 50 active rules per user is roomy for a personal watchlist
// and, after de-duping tickers, sits comfortably under that cap.
// Inactive (fired/disabled) rules don't poll, so they don't count
// against this — only an *active* rule consumes the budget, so only
// active rules consume the cap.
export const MAX_ACTIVE_ALERTS = 50;

const METRICS = new Set(['price', 'pct']);
const DIRECTIONS = new Set(['above', 'below']);

// Same ticker convention as the watchlist / terminal routes: trimmed,
// upper-cased, constrained to the symbol charset. Returns the
// normalized symbol or null (the caller turns null into a 400).
const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;
function normalizeTicker(raw) {
  const t = String(raw ?? '').trim().toUpperCase();
  if (!t || !TICKER_RE.test(t)) return null;
  return t;
}

// An alert id arrives as a path param; only a clean positive integer
// is a valid id. Anything else (non-numeric, float, negative, empty)
// is a 400 before we touch the DB — never a 404, because it isn't a
// well-formed reference to begin with. Same shape as watchlist.js's
// parseListId.
function parseAlertId(raw) {
  const s = String(raw ?? '');
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// THE security chokepoint. Loads an alert by id and returns it only if
// it belongs to `userId`; otherwise null. A wrong owner and a missing
// row are deliberately the same answer — the caller responds 404 to
// both, so an attacker probing alert ids can't distinguish "not yours"
// from "doesn't exist", and no read or write ever lands on another
// user's row. Every mutation routes through this.
export async function ownedAlert(db, userId, id) {
  const alert = await db.watchlistAlert.findUnique({ where: { id } });
  if (!alert || alert.userId !== userId) return null;
  return alert;
}

// The caller's full rule set, oldest-first, each shaped to exactly
// what the poller / management UI needs. The single source of truth
// the client re-renders from after every mutation.
async function loadAll(db, userId) {
  const rows = await db.watchlistAlert.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((a) => ({
    id: a.id,
    ticker: a.ticker,
    metric: a.metric,
    direction: a.direction,
    threshold: a.threshold,
    active: a.active,
    lastFiredAt: a.lastFiredAt,
    createdAt: a.createdAt,
  }));
}

// GET /api/alerts — the caller's alerts. Never 5xx: an unexpected read
// fault degrades to an honest empty set, exactly like watchlist GET
// degrading to { lists: [] } / terminal /quotes degrading to {}.
export async function listAlertsHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    return res.json({ alerts: await loadAll(db, userId) });
  } catch (err) {
    console.error('alerts GET / failed:', err.message);
    return res.json({ alerts: [] });
  }
}

// POST /api/alerts { ticker, metric, direction, threshold } — create a
// rule. Validates the enum-ish fields and a finite threshold, caps the
// caller at MAX_ACTIVE_ALERTS *active* rules (inactive ones don't poll,
// so they don't occupy the budget), creates, returns the full set.
export async function createAlertHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const body = req.body || {};

    const ticker = normalizeTicker(body.ticker);
    if (!ticker) {
      return res.status(400).json({ error: 'Invalid ticker' });
    }
    // Strict equality, no trimming/casing — a rule's metric/direction
    // is a closed vocabulary, not free text, so 'PRICE ' is a bad
    // request, not silently coerced.
    if (!METRICS.has(body.metric)) {
      return res
        .status(400)
        .json({ error: "metric must be 'price' or 'pct'" });
    }
    if (!DIRECTIONS.has(body.direction)) {
      return res
        .status(400)
        .json({ error: "direction must be 'above' or 'below'" });
    }
    // A threshold the evaluator can't compare is a 400, never a stored
    // rule that silently never (or always) fires. Reject the empty-ish
    // values up front — Number(null) and Number('') are 0, which would
    // otherwise sail past the finite check as a real "0" threshold —
    // then accept a JSON number or a numeric string and require the
    // result be finite (NaN / ±Infinity / objects all fall out here).
    // A negative threshold is legitimate: a "pct below -3" down-move
    // alert.
    const rawThreshold = body.threshold;
    const threshold =
      rawThreshold === null ||
      rawThreshold === undefined ||
      rawThreshold === '' ||
      typeof rawThreshold === 'boolean'
        ? NaN
        : Number(rawThreshold);
    if (!Number.isFinite(threshold)) {
      return res
        .status(400)
        .json({ error: 'threshold must be a finite number' });
    }

    // Cap counts only ACTIVE rules — a fired/disabled rule doesn't
    // poll, so it doesn't consume the live-quote budget the cap
    // protects. A new rule is born active, so it would push the
    // active count up by one.
    const activeCount = await db.watchlistAlert.count({
      where: { userId, active: true },
    });
    if (activeCount >= MAX_ACTIVE_ALERTS) {
      return res.status(409).json({
        error: `You can have at most ${MAX_ACTIVE_ALERTS} active alerts — delete or disable one first`,
      });
    }

    await db.watchlistAlert.create({
      data: {
        userId,
        ticker,
        metric: body.metric,
        direction: body.direction,
        threshold,
        active: true,
      },
    });

    return res.json({ alerts: await loadAll(db, userId) });
  } catch (err) {
    console.error('alerts POST / failed:', err.message);
    return res.json({ ok: false, error: 'Failed to create alert' });
  }
}

// DELETE /api/alerts/:id — delete an owned rule. Ownership-checked via
// ownedAlert (not-owned/not-found → 404, the same indistinguishability
// as Watchlist). Returns the full {alerts}.
export async function deleteAlertHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseAlertId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }

    const owned = await ownedAlert(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    await db.watchlistAlert.delete({ where: { id } });
    return res.json({ alerts: await loadAll(db, userId) });
  } catch (err) {
    console.error('alerts DELETE /:id failed:', err.message);
    return res.json({ ok: false, error: 'Failed to delete alert' });
  }
}

// PATCH /api/alerts/:id { active } — re-arm (true) or disable (false)
// an owned rule. Ownership-checked. `active` must be a real boolean —
// this is the one toggle, not a free-form patch. No cap gate here on
// purpose: the active cap is a create-time guard, and a re-arm of an
// existing rule must not be falsely blocked just because the user is
// at the cap (they can always disable another). Returns the full
// {alerts}.
export async function toggleAlertHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseAlertId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }
    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'active must be true or false' });
    }

    const owned = await ownedAlert(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    await db.watchlistAlert.update({
      where: { id },
      data: { active },
    });
    return res.json({ alerts: await loadAll(db, userId) });
  } catch (err) {
    console.error('alerts PATCH /:id failed:', err.message);
    return res.json({ ok: false, error: 'Failed to update alert' });
  }
}

// POST /api/alerts/:id/fired — the poller calls this the moment it
// shows the popup for a crossed rule. Ownership-checked, then stamps
// lastFiredAt=now and flips active=false so the same crossing can't
// re-spam the popup on the next poll (the one-shot dedupe). Idempotent:
// firing an already-fired rule is a clean 200 that just re-stamps the
// time — calling it twice (a double poll, a retry) is harmless. `now`
// is injectable so the stamp is testable without a real clock.
export async function firedAlertHandler(
  req,
  res,
  db = prisma,
  now = () => new Date()
) {
  try {
    const userId = req.user.id;
    const id = parseAlertId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }

    const owned = await ownedAlert(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    await db.watchlistAlert.update({
      where: { id },
      data: { lastFiredAt: now(), active: false },
    });
    return res.json({ alerts: await loadAll(db, userId) });
  } catch (err) {
    console.error('alerts POST /:id/fired failed:', err.message);
    return res.json({ ok: false, error: 'Failed to record alert' });
  }
}

router.get('/', (req, res) => listAlertsHandler(req, res));
router.post('/', (req, res) => createAlertHandler(req, res));
router.delete('/:id', (req, res) => deleteAlertHandler(req, res));
router.patch('/:id', (req, res) => toggleAlertHandler(req, res));
router.post('/:id/fired', (req, res) => firedAlertHandler(req, res));

export default router;
