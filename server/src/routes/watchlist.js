import express from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getLiveQuotes } from '../services/liveQuotes.js';

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

router.get('/', async (req, res) => {
  try {
    const [rows, sheet] = await Promise.all([
      prisma.watchlistItem.findMany({
        orderBy: [{ source: 'asc' }, { ticker: 'asc' }],
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

    res.json({
      items: items.map((i) => ({ ...i, quote: quotes[i.ticker] || null })),
      counts: {
        holdings: items.filter((i) => i.source === 'holding').length,
        seg13f: items.filter((i) => i.source === 'seg13f').length,
        manual: items.filter((i) => i.source === 'manual').length,
      },
      // Said once, at the top, so nothing downstream has to remember it:
      // a 13F is US-listed long equity as of a quarter-end already 45
      // days stale when it publishes. No shorts, no bonds, no cash, and
      // nothing listed abroad — which is exactly why Lindt would never
      // appear on one.
      caveat:
        'A 13F shows only US-listed long equity positions as of the quarter-end shown, published up to 45 days later. It excludes shorts, debt, cash and every foreign listing.',
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
  try {
    const row = await prisma.watchlistItem.upsert({
      where: { ticker_source: { ticker, source } },
      // Re-adding a name refreshes what we know about it rather than
      // erroring; the unique index is there to stop duplicates, not to
      // stop updates.
      update: {
        name: req.body?.name ? String(req.body.name).slice(0, 200) : undefined,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : undefined,
        asOf: req.body?.asOf ? new Date(req.body.asOf) : undefined,
      },
      create: {
        ticker,
        source,
        name: req.body?.name ? String(req.body.name).slice(0, 200) : null,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : null,
        asOf: req.body?.asOf ? new Date(req.body.asOf) : null,
        addedById: req.user?.id ?? null,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('watchlist add failed:', err.message);
    res.status(500).json({ error: 'Could not add it' });
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
    await prisma.watchlistItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'No such item' });
  }
});

export default router;
