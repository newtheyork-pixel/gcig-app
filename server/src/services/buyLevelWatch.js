import prisma from '../db.js';
import { resolveQuotes } from './portfolioQuotes.js';

// Watches the gap between what we think a name is worth and what it costs.
//
// A valuation concluding the shares are cheap is an opinion until
// somebody is watching, and nobody refreshes a quote every morning for a
// name they do not own yet. So the work sits in a spreadsheet, the price
// comes to the level for a fortnight in October, and the club finds out
// in January.
//
// Two rules stop this becoming noise, and they are the whole design:
//
//   Report a crossing ONCE. A name that sits below the level for three
//   weeks is one piece of news, not twenty-one. `alertedAt` records the
//   announcement and is cleared when the price climbs back above, so the
//   next crossing is news again.
//
//   Say when the valuation is stale. A DCF written before an earnings
//   report is a claim about facts that have since been restated, and a
//   price alert fired off a stale model is worse than no alert — it
//   carries the authority of work nobody has revisited. Past its
//   reviewBy date the alert still fires, and says so loudly.

// A crossing is worth reporting; a rounding error is not.
const HYSTERESIS = 0.005; // 0.5%

/**
 * @param {object} deps - injectable quote resolver, for tests
 * @returns {Promise<{checked, crossed, cleared, unpriced, alerts}>}
 */
export async function checkBuyLevels(deps = {}) {
  const resolve = deps.resolveQuotes || resolveQuotes;

  const watched = await prisma.researchValuation.findMany({
    where: { buyBelow: { not: null }, ticker: { not: null } },
    include: { project: { select: { id: true, name: true, status: true } } },
  });
  if (watched.length === 0) {
    return { checked: 0, crossed: 0, cleared: 0, unpriced: 0, alerts: [] };
  }

  const tickers = [...new Set(watched.map((v) => v.ticker.toUpperCase()))];
  let quotes = {};
  try {
    quotes = (await resolve(tickers)) || {};
  } catch {
    quotes = {};
  }

  const alerts = [];
  let crossed = 0;
  let cleared = 0;
  let unpriced = 0;

  for (const v of watched) {
    const q = quotes[v.ticker.toUpperCase()];
    if (!q || q.price == null) {
      // A name we cannot price is not a name that failed to cross. It is
      // one we did not check, and the summary has to keep them apart.
      unpriced += 1;
      continue;
    }

    const price = Number(q.price);
    const level = Number(v.buyBelow);
    const below = price <= level * (1 - HYSTERESIS);
    const clearlyAbove = price > level * (1 + HYSTERESIS);

    if (below && !v.alertedAt) {
      await prisma.researchValuation.update({
        where: { id: v.id },
        data: { alertedAt: new Date() },
      });
      crossed += 1;
      const stale = v.reviewBy ? new Date(v.reviewBy).getTime() < Date.now() : false;
      alerts.push({
        valuationId: v.id,
        projectId: v.project?.id ?? null,
        project: v.project?.name ?? null,
        ticker: v.ticker,
        name: v.name,
        price,
        buyBelow: level,
        currency: v.currency || 'USD',
        base: v.base ?? null,
        // Carried on the alert itself rather than left for the reader to
        // check. Someone acting on a price is not going to go and look
        // up when the model was last revisited.
        stale,
        reviewBy: v.reviewBy ?? null,
        source: q.source || null,
      });
    } else if (clearlyAbove && v.alertedAt) {
      // Re-arm. Without this the second crossing is silent, which is the
      // one people actually wait for.
      await prisma.researchValuation.update({
        where: { id: v.id },
        data: { alertedAt: null },
      });
      cleared += 1;
    }
  }

  return { checked: watched.length, crossed, cleared, unpriced, alerts };
}
