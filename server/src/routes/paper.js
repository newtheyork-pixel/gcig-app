// PAPER — the blotter for trades nobody placed.
//
// Nothing here can reach Holding, HoldingLot, Transaction or
// VotingSession, and that separation is deliberate rather than
// incidental. The club manages real endowment money through those
// tables; a simulated fill that leaks into them becomes a cost basis
// somebody later reconciles against a custodian statement and cannot
// explain.

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { getLiveQuotes } from '../services/liveQuotes.js';
import {
  REST_MINUTES, planOrder, score, sessionAdvice, tick,
} from '../services/paperTrading.js';

const prisma = new PrismaClient();
const router = express.Router();

const TICKER = /^[A-Z0-9.\-]{1,10}$/;

/// Whether the rules would place an order right now, and why not if not.
router.get('/session', (_req, res) => {
  res.json({ ...sessionAdvice(), restMinutes: REST_MINUTES });
});

/**
 * Place one.
 *
 * The arrival price is taken HERE, from the live quote, and frozen. It is
 * the benchmark every later number is measured against, and letting the
 * client supply it would mean grading the strategy against a price the
 * strategy chose.
 */
router.post('/orders', async (req, res) => {
  const ticker = String(req.body?.ticker || '').trim().toUpperCase();
  const side = String(req.body?.side || 'buy').toLowerCase();
  const shares = Number(req.body?.shares);

  if (!TICKER.test(ticker)) return res.status(400).json({ error: 'Invalid ticker' });
  if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: 'side must be buy or sell' });
  if (!Number.isFinite(shares) || shares <= 0 || shares > 100_000) {
    return res.status(400).json({ error: 'shares must be a positive number' });
  }

  try {
    const quotes = await getLiveQuotes([ticker]);
    const last = Number(quotes?.[ticker]?.last);
    if (!Number.isFinite(last) || last <= 0) {
      // Never invent an arrival price. Without one there is no benchmark
      // and the order would be unscoreable forever.
      return res.status(503).json({ error: `No live quote for ${ticker}; cannot set a benchmark.` });
    }

    const plan = planOrder({ side, price: last, shares });
    const advice = sessionAdvice();
    const row = await prisma.paperOrder.create({
      data: {
        ticker,
        side: plan.side,
        shares,
        arrivalPrice: plan.arrivalPrice,
        limitPrice: plan.limitPrice,
        rationale: plan.rationale,
        expiresAt: new Date(Date.now() + REST_MINUTES * 60_000),
        placedById: req.user?.id ?? null,
        // Orders placed outside the preferred window are ACCEPTED and
        // labelled, not refused. Refusing them would leave the blotter
        // with only the trades the rule likes, which is the one sample
        // that cannot test the rule.
        note: advice.ok ? null : `placed outside the window (${advice.phase})`,
      },
    });
    res.status(201).json({ ...row, sessionAdvice: advice });
  } catch (err) {
    console.error('paper order failed:', err.message);
    res.status(500).json({ error: 'Could not place the paper order' });
  }
});

/// The blotter, newest first, with the running score.
router.get('/orders', async (req, res) => {
  try {
    const rows = await prisma.paperOrder.findMany({
      orderBy: { placedAt: 'desc' },
      take: Math.min(200, Number(req.query.limit) || 100),
      include: { placedBy: { select: { id: true, name: true } } },
    });
    res.json({
      orders: rows,
      score: score(rows),
      restMinutes: REST_MINUTES,
      // Said with the numbers, every time, because the blotter will
      // outlive the conversation that produced it.
      caveat: 'A touch of the limit is a fact about the market, not proof our '
        + 'order would have filled there. Quotes are polled about once a minute, '
        + 'so brief touches are missed and the fill rate reads LOW.',
    });
  } catch (err) {
    console.error('paper blotter failed:', err.message);
    res.status(500).json({ error: 'Could not load the blotter' });
  }
});

/**
 * Advance every open order. Called by the scheduler and exposed so a
 * panel can force one without waiting for the minute to turn.
 */
export async function runTick() {
  const open = await prisma.paperOrder.findMany({ where: { status: 'open' } });
  if (!open.length) return { checked: 0, updated: 0 };
  const updates = await tick(open);
  for (const u of updates) {
    await prisma.paperOrder.update({ where: { id: u.id }, data: u.data });
  }
  return { checked: open.length, updated: updates.length };
}

router.post('/tick', async (_req, res) => {
  try {
    res.json(await runTick());
  } catch (err) {
    console.error('paper tick failed:', err.message);
    res.status(500).json({ error: 'Tick failed' });
  }
});

/// Cancel one that has not settled. Kept because a forward test somebody
/// cannot abandon is a forward test they stop starting.
router.delete('/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const row = await prisma.paperOrder.update({
      where: { id },
      data: { status: 'abandoned', filledAt: new Date() },
    });
    res.json(row);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
