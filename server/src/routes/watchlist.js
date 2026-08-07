import express from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getLiveQuotes } from '../services/liveQuotes.js';
import { getHistory } from '../services/priceHistory.js';
import { ytdPriceReturn } from './terminal.js';

const prisma = new PrismaClient();
const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

// The watchlist: names worth following, and where each one came from.
//
// Provenance is the whole design. A ticker we own, a ticker a manager we
// respect disclosed, and a ticker somebody typed in are three different
// claims about how much attention a name deserves, and a list that
// flattens them into one column cannot be weighed.
//
// The holdings side is derived rather than stored: the sheet is the
// system of record for what we own, and a second copy in this table
// would drift the first time somebody trades. Stored rows carry the
// names we are watching but do NOT own.
const SOURCES = new Set(['seg13f', 'manual']);

// Who may change or remove a stored row. A private row (userId set)
// answers only to its owner; a shared row belongs to the club, so
// touching it is an executive act — the same President/CIO tier
// requireExecutive gates elsewhere, plus the super admin, who bypasses
// every role gate. requireTerminalAccess on the mount only says who may
// LOOK; it says nothing about who may erase.
const EXEC_ROLES = new Set(['President', 'CIO']);
function mayMutate(row, user) {
  if (!user) return false;
  if (row.userId != null) return row.userId === user.id;
  return user.isSuperAdmin || EXEC_ROLES.has(user.role);
}

router.get('/', async (req, res) => {
  try {
    const [rows, sheet] = await Promise.all([
      prisma.watchlistItem.findMany({
        // The club's list, plus this member's own. Someone else's private
        // list is not theirs to see.
        where: { OR: [{ userId: null }, { userId: req.user?.id ?? -1 }] },
        orderBy: [{ ticker: 'asc' }],
        include: { addedBy: { select: { id: true, name: true } } },
      }),
      getSheetPortfolio().catch(() => null),
    ]);

    const held = new Map();
    for (const h of sheet?.holdings || []) {
      if (h?.isCash || !h?.ticker) continue;
      held.set(String(h.ticker).toUpperCase(), h);
    }

    const items = [
      // What we own, straight off the sheet.
      ...[...held.entries()].map(([ticker, h]) => ({
        id: `holding:${ticker}`,
        ticker,
        name: h.name || null,
        source: 'holding',
        note: null,
        asOf: sheet?.fetchedAt || null,
        shares: h.shares ?? null,
        weight: h.portfolioPct ?? null,
      })),
      ...rows.map((r) => ({
        ...r,
        id: String(r.id),
        // A name can be on a filing AND in the book. Saying so is the
        // most interesting thing the list can tell you.
        alsoHeld: held.has(r.ticker),
      })),
    ];

    const tickers = [...new Set(items.map((i) => i.ticker))].slice(0, 120);
    // Quotes are best-effort. A vendor miss leaves a row without a price
    // rather than dropping the row, because the list is the point and the
    // price is decoration.
    let quotes = {};
    try {
      quotes = await getLiveQuotes(tickers);
    } catch {
      quotes = {};
    }

    // Volume and the longer performance windows, from the same bar
    // history the charts use. Best-effort per ticker and bounded, because
    // a watchlist of 120 names must not turn into 120 serial fetches on
    // every open — a name whose history is unavailable renders without
    // the columns rather than holding up the list.
    const stats = {};
    await Promise.all(
      tickers.slice(0, 60).map(async (t) => {
        try {
          const bars = (await getHistory(t, '1y')) || [];
          const closes = bars.filter((b) => b?.close != null);
          if (closes.length < 2) return;
          const last = closes[closes.length - 1];
          const at = (n) => closes[Math.max(0, closes.length - 1 - n)]?.close;
          const pct = (from) => (from ? ((last.close - from) / from) * 100 : null);
          // Average volume over the last twenty sessions, which is what
          // "is this liquid enough for us" actually asks. A single day's
          // print answers a different and less useful question.
          const vols = closes.slice(-20).map((b) => b.volume).filter((v) => v != null);
          stats[t] = {
            avgVolume20d: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
            pct1m: pct(at(21)),
            pct3m: pct(at(63)),
            pct1y: pct(closes[0].close),
            ytd: await ytdPriceReturn(t, last.close),
          };
        } catch {
          /* no history for this one; the row still renders */
        }
      })
    );

    res.json({
      items: items.map((i) => ({ ...i, quote: quotes[i.ticker] || null, stats: stats[i.ticker] || null })),
      counts: {
        holdings: items.filter((i) => i.source === 'holding').length,
        seg13f: items.filter((i) => i.source === 'seg13f').length,
        manual: items.filter((i) => i.source === 'manual').length,
      },
      quotesAvailable: Object.keys(quotes).length > 0,
    });
  } catch (err) {
    console.error('watchlist read failed:', err.message);
    res.status(500).json({ error: 'Could not load the watchlist' });
  }
});

router.post('/', async (req, res) => {
  const ticker = String(req.body?.ticker || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z.\-]{0,11}$/.test(ticker)) {
    return res.status(400).json({ error: 'A ticker is required' });
  }
  const source = SOURCES.has(req.body?.source) ? req.body.source : 'manual';
  // The default scope is the SHARED club list: a member adding a name
  // adds it for everyone unless they ask for scope:"mine". Clients
  // lean on that default, so keeping a name to yourself is the
  // deliberate act here.
  const mine = req.body?.scope === 'mine';
  const userId = mine ? req.user?.id ?? null : null;
  try {
    // findFirst + create/update rather than upsert.
    //
    // upsert needs the compound unique key by its generated name, which
    // ties this handler to the exact shape of the index. That coupling
    // broke the moment the key gained a column, and the failure surfaced
    // as a bare 500 with nothing to read. This does the same job without
    // naming the index at all.
    const existing = await prisma.watchlistItem.findFirst({ where: { ticker, source, userId } });
    // findFirst can only surface the requester's own private row or a
    // shared one, so the case this catches is a member overwriting the
    // club list's note. Same rule as DELETE below: the shared list is
    // the club's record, and rewriting it is an executive act.
    if (existing && !mayMutate(existing, req.user)) {
      return res.status(403).json({ error: 'Only an executive can edit the club list entry' });
    }
    const data = {
      name: req.body?.name ? String(req.body.name).slice(0, 200) : undefined,
      note: req.body?.note !== undefined ? String(req.body.note).slice(0, 500) : undefined,
      asOf: req.body?.asOf ? new Date(req.body.asOf) : undefined,
    };
    const row = existing
      ? await prisma.watchlistItem.update({ where: { id: existing.id }, data })
      : await prisma.watchlistItem.create({
          data: { ticker, source, userId, ...data, addedById: req.user?.id ?? null },
        });
    res.status(201).json(row);
  } catch (err) {
    console.error('watchlist add failed:', err);
    // The message, not just "could not". A 500 with nothing in it is how
    // a schema mismatch looks exactly like a network problem.
    res.status(500).json({ error: `Could not add it: ${String(err?.message || err).slice(0, 200)}` });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    // Holdings are derived from the sheet and have string ids. Removing
    // one here would be pretending we can sell from a watchlist.
    return res.status(400).json({ error: 'Holdings come from the sheet and cannot be removed here.' });
  }
  try {
    // Look before deleting: the id alone says nothing about whose row
    // this is, and an unchecked delete let any member erase another
    // member's private row — or the club's shared list — by id.
    const row = await prisma.watchlistItem.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: 'No such item' });
    if (!mayMutate(row, req.user)) {
      return res.status(403).json({
        error: row.userId != null
          ? 'Only the member who added this can remove it'
          : 'Only an executive can remove a name from the club list',
      });
    }
    await prisma.watchlistItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'No such item' });
  }
});

export default router;
