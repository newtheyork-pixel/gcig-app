import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';

// Per-user multiple watchlists. A logged-in member keeps any number of
// named lists of tickers (bounded — see the caps below), persisted on
// their profile so they survive logout/reload. The terminal's W panel
// reads and mutates these; the DES ★ adds/removes a ticker on the
// user's default list. Two relational tables (Watchlist ->
// WatchlistItem) mirroring the project's per-user persistence pattern
// (cf. presidentReview.js).
//
// The whole contract rests on the security invariant: every list/item
// read or mutation is scoped by req.user.id. `ownedList` is the single
// chokepoint that enforces it — a list id whose watchlist.userId
// doesn't match the caller is indistinguishable from one that doesn't
// exist (both → null → the caller answers 404), so the endpoint never
// reveals, confirms, or touches another user's data.
//
// Every handler is never-5xx, the same posture the terminal's
// quotes/exec-bios routes promise: known cases get an honest 4xx
// (404 not-owned, 409 unique/cap, 400 bad input), and a *truly
// unexpected* fault is caught and degraded to a benign, leak-free
// 200 rather than thrown — GET to `{ lists: [] }` (the panel shows an
// honest empty state, never an error page), a mutation to
// `{ ok:false, error }` with NO `lists` key, so the client keeps the
// list state it already had and just surfaces a soft inline notice
// (the same keep-last-good philosophy useLiveRefresh applies to a
// failed quote poll). The endpoint can therefore never 5xx.
//
// Handlers are exported and take an injectable `db` (defaulting to the
// shared prisma) so the route suite can drive them with an in-memory
// prisma-double — the same harness-free, injected-deps testing
// precedent terminal.execbios.test.js / terminal.quotes.test.js set.

const router = Router();
router.use(verifyJwt);

// Bounds the live-quote fan-out within the rate discipline the
// terminal's demand-driven poller already enforces: only the active
// list is ever polled, and a list can't grow without limit. 20 lists /
// 50 tickers is roomy for a personal watchlist and still well under
// what /terminal/quotes caps a single request at (40 symbols).
export const MAX_LISTS = 20;
export const MAX_ITEMS_PER_LIST = 50;

// The lazily-spawned list's name. If a user has zero lists (new user,
// or they deleted their last one) GET creates exactly this one and
// returns it, so the panel is never permanently empty of lists.
const DEFAULT_LIST_NAME = 'Watchlist';

// Same ticker convention as the terminal routes: trimmed, upper-cased,
// and constrained to the symbol charset. Returns the normalized symbol
// or null if it doesn't validate (the caller turns null into a 400).
const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;
function normalizeTicker(raw) {
  const t = String(raw ?? '').trim().toUpperCase();
  if (!t || !TICKER_RE.test(t)) return null;
  return t;
}

// A list id arrives as a path param; only a clean positive integer is
// a valid id. Anything else (non-numeric, float, negative, empty) is a
// 400 before we ever touch the DB — never a 404, because it isn't a
// well-formed reference to begin with.
function parseListId(raw) {
  const s = String(raw ?? '');
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// THE security chokepoint. Loads a list by id and returns it only if
// it belongs to `userId`; otherwise null. A wrong owner and a missing
// row are deliberately the same answer — the caller responds 404 to
// both, so an attacker probing list ids can't distinguish "not yours"
// from "doesn't exist", and no read or write ever lands on another
// user's row. Every list/item mutation routes through this.
export async function ownedList(db, userId, id, { withItems = false } = {}) {
  const list = await db.watchlist.findUnique({
    where: { id },
    ...(withItems ? { include: { items: true } } : {}),
  });
  if (!list || list.userId !== userId) return null;
  return list;
}

// The user's full set, ordered oldest-first (the first element is the
// implicit default the DES ★ targets), each list carrying its items
// ordered by when they were added. The single source of truth the
// client re-renders from after every mutation.
async function loadAll(db, userId) {
  const lists = await db.watchlist.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: { items: true },
  });
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    createdAt: l.createdAt,
    items: (l.items || []).map((i) => ({
      ticker: i.ticker,
      addedAt: i.addedAt,
    })),
  }));
}

// Prisma's unique-violation code, raised when two requests race the
// same (userId, name) or (watchlistId, ticker) — we map it to an
// honest 409 rather than letting it become a 500.
function isUniqueViolation(err) {
  return err && err.code === 'P2002';
}

// GET /api/watchlist — the user's lists+items. Lazily creates the
// default "Watchlist" if they have none (a documented write-on-GET:
// idempotent, user-scoped, bounded — see the spec's open-items note),
// then returns the full set. Never 5xx: any fault degrades to a
// guarded 500 with no internal detail, but the common paths are 200.
export async function listAllHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    let lists = await loadAll(db, userId);
    if (lists.length === 0) {
      // Lazy default. A unique-violation here means a concurrent GET
      // already created it — treat that as success and just re-read.
      try {
        await db.watchlist.create({
          data: { userId, name: DEFAULT_LIST_NAME },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      lists = await loadAll(db, userId);
    }
    return res.json({ lists });
  } catch (err) {
    // Never 5xx: an unexpected read fault degrades to an honest empty
    // set — the panel shows "no lists" rather than an error, exactly
    // like terminal /quotes degrading to {}.
    console.error('watchlist GET / failed:', err.message);
    return res.json({ lists: [] });
  }
}

// POST /api/watchlist/lists { name } — create a uniquely-named list,
// capped at MAX_LISTS. Returns the full {lists} so the client can
// re-render from one source of truth.
export async function createListHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }
    if (name.length > 60) {
      return res
        .status(400)
        .json({ error: 'List name is too long (max 60 characters)' });
    }

    const count = await db.watchlist.count({ where: { userId } });
    if (count >= MAX_LISTS) {
      return res.status(409).json({
        error: `You can have at most ${MAX_LISTS} watchlists`,
      });
    }

    try {
      await db.watchlist.create({ data: { userId, name } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res
          .status(409)
          .json({ error: 'You already have a list with that name' });
      }
      throw err;
    }

    return res.json({ lists: await loadAll(db, userId) });
  } catch (err) {
    console.error('watchlist POST /lists failed:', err.message);
    return res.json({ ok: false, error: 'Failed to create list' });
  }
}

// PATCH /api/watchlist/lists/:id { name } — rename an owned list.
// Ownership-checked via ownedList (not-owned/not-found → 404); a name
// already used by the same user → 409. Returns the full {lists}.
export async function renameListHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseListId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid list id' });
    }
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }
    if (name.length > 60) {
      return res
        .status(400)
        .json({ error: 'List name is too long (max 60 characters)' });
    }

    const owned = await ownedList(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    try {
      await db.watchlist.update({ where: { id }, data: { name } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res
          .status(409)
          .json({ error: 'You already have a list with that name' });
      }
      throw err;
    }

    return res.json({ lists: await loadAll(db, userId) });
  } catch (err) {
    console.error('watchlist PATCH /lists/:id failed:', err.message);
    return res.json({ ok: false, error: 'Failed to rename list' });
  }
}

// DELETE /api/watchlist/lists/:id — delete an owned list; its items
// cascade (DB-level ON DELETE CASCADE). Deleting the last list is
// allowed — the next GET respawns the default. Returns the full
// {lists}, possibly empty.
export async function deleteListHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseListId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid list id' });
    }

    const owned = await ownedList(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    await db.watchlist.delete({ where: { id } });
    return res.json({ lists: await loadAll(db, userId) });
  } catch (err) {
    console.error('watchlist DELETE /lists/:id failed:', err.message);
    return res.json({ ok: false, error: 'Failed to delete list' });
  }
}

// POST /api/watchlist/lists/:id/items { ticker } — add a ticker to an
// owned list. Validated/upper-cased; idempotent (upsert on the
// (watchlistId, ticker) unique key — a re-add is a benign no-op
// success, never a duplicate row or an error); capped at
// MAX_ITEMS_PER_LIST. Returns the full {lists}.
export async function addItemHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseListId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid list id' });
    }
    const ticker = normalizeTicker(req.body?.ticker);
    if (!ticker) {
      return res.status(400).json({ error: 'Invalid ticker' });
    }

    const owned = await ownedList(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    // The cap counts distinct tickers. Re-adding one that's already on
    // the list must stay an idempotent success even when the list is
    // at the cap — only a genuinely new ticker beyond the cap is
    // rejected, so we check membership before the count gate.
    const existing = await db.watchlistItem.count({
      where: { watchlistId: id, ticker },
    });
    if (existing === 0) {
      const total = await db.watchlistItem.count({
        where: { watchlistId: id },
      });
      if (total >= MAX_ITEMS_PER_LIST) {
        return res.status(409).json({
          error: `A list can hold at most ${MAX_ITEMS_PER_LIST} tickers`,
        });
      }
    }

    // Upsert on the unique key: present → no-op, absent → insert.
    // Either way the result is the list containing the ticker exactly
    // once, so a double-add is harmless.
    await db.watchlistItem.upsert({
      where: { watchlistId_ticker: { watchlistId: id, ticker } },
      create: { watchlistId: id, ticker },
      update: {},
    });

    return res.json({ lists: await loadAll(db, userId) });
  } catch (err) {
    console.error(
      'watchlist POST /lists/:id/items failed:',
      err.message
    );
    return res.json({ ok: false, error: 'Failed to add ticker' });
  }
}

// DELETE /api/watchlist/lists/:id/items/:ticker — remove a ticker from
// an owned list. Absent ticker is a benign no-op success (deleteMany
// over the unique key removes 0 or 1 row, never errors on a miss).
// Returns the full {lists}.
export async function removeItemHandler(req, res, db = prisma) {
  try {
    const userId = req.user.id;
    const id = parseListId(req.params?.id);
    if (id == null) {
      return res.status(400).json({ error: 'Invalid list id' });
    }
    // The ticker to remove is a path param; normalize it the same way
    // so 'aapl' removes 'AAPL'. A malformed one can't match any stored
    // row anyway, so we treat it as a no-op success rather than a 400
    // — removal is idempotent by contract.
    const ticker = normalizeTicker(req.params?.ticker);

    const owned = await ownedList(db, userId, id);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    if (ticker) {
      await db.watchlistItem.deleteMany({
        where: { watchlistId: id, ticker },
      });
    }

    return res.json({ lists: await loadAll(db, userId) });
  } catch (err) {
    console.error(
      'watchlist DELETE /lists/:id/items/:ticker failed:',
      err.message
    );
    return res.json({ ok: false, error: 'Failed to remove ticker' });
  }
}

router.get('/', (req, res) => listAllHandler(req, res));
router.post('/lists', (req, res) => createListHandler(req, res));
router.patch('/lists/:id', (req, res) => renameListHandler(req, res));
router.delete('/lists/:id', (req, res) => deleteListHandler(req, res));
router.post('/lists/:id/items', (req, res) => addItemHandler(req, res));
router.delete('/lists/:id/items/:ticker', (req, res) =>
  removeItemHandler(req, res)
);

export default router;
