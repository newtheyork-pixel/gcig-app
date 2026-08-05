// ALRT — what the club's own charter says somebody should be told.
//
// Assembles the inputs and hands them to the rules. Deliberately thin:
// the judgement lives in services/alerts.js where it is tested without a
// network, and this file only decides what to feed it.

import express from 'express';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getCashBalance } from '../services/tradeExecution.js';
import { getUpcomingEarningsBatch } from '../services/marketData.js';
import { evaluate, summarize, IPS } from '../services/alerts.js';

const router = express.Router();


// Everything below needs a signed-in member.
//
// This router shipped without it. `req.user` was therefore always
// undefined, which had two consequences: every super-admin check
// silently failed closed, and — the real problem — the members-only
// routes were not members-only at all. Confirmed against production
// with no token: /api/alerts answered 200.
//
// A gate that is missing looks exactly like a gate that is passing, from
// the outside, right up until somebody checks.
router.use(verifyJwt);
router.get('/', async (_req, res) => {
  try {
    // Each input is optional and each failure is visible downstream: a
    // rule whose data did not load reports "not checked" rather than
    // passing, so an outage can never render as compliance.
    const [sheet, cash] = await Promise.all([
      getSheetPortfolio().catch(() => ({ holdings: [] })),
      getCashBalance().catch(() => null),
    ]);

    const held = (sheet.holdings || [])
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker.toUpperCase());
    // Cached 12h per ticker upstream, so this costs nothing on a warm
    // process and at most a dozen calls on a cold one.
    const byTicker = held.length
      ? await getUpcomingEarningsBatch(held, { daysAhead: 14 }).catch(() => ({}))
      : {};
    const earnings = Object.entries(byTicker).map(([ticker, row]) => ({
      ticker, date: row?.date, hour: row?.hour,
    })).filter((e) => e.date);

    const alerts = evaluate({
      holdings: sheet.holdings || [],
      cash: typeof cash === 'number' ? cash : cash?.balance ?? null,
      earnings,
    });
    res.json({ alerts, summary: summarize(alerts), policy: IPS });
  } catch (err) {
    console.error('alerts failed:', err.message);
    res.status(500).json({ error: 'Could not evaluate alerts' });
  }
});

export default router;
