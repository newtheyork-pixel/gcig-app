import prisma from '../db.js';
import { resolveQuotes } from './portfolioQuotes.js';
import { sendBuyLevelEmail } from './email.js';

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
      crossed += 1;
      const stale = v.reviewBy ? new Date(v.reviewBy).getTime() < Date.now() : false;
      const alert = {
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
      };

      // Send BEFORE marking it announced. The other order means a send
      // that fails leaves the row flagged as told-about and the crossing
      // is never mentioned again — the one event the whole watch exists
      // to catch, lost to a transient SMTP error.
      const to = (v.watchers || []).filter((e) => /@/.test(e));
      let notified = false;
      if (to.length) {
        try {
          await sendBuyLevelEmail(to, alert);
          notified = true;
        } catch (err) {
          console.error(`[buy-levels] email failed for ${v.ticker}:`, err.message);
        }
      }

      // Only mark it announced if somebody was actually told, or there
      // was nobody to tell. A failed send stays un-announced so tomorrow
      // tries again.
      if (notified || to.length === 0) {
        await prisma.researchValuation.update({
          where: { id: v.id },
          data: { alertedAt: new Date() },
        });
      }
      alerts.push({ ...alert, notified, recipients: to.length });
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

/**
 * The staleness half of the watch: a valuation past its reviewBy date
 * whose owner has not been told. The buy-level path only mentions
 * staleness when a price happens to cross, which inverted the intent —
 * a model that quietly ages past its review date is exactly the one
 * nobody is looking at. Once per staleness: reviewAlertedAt arms the
 * shot and moving reviewBy forward re-arms it, the same pattern
 * alertedAt uses for crossings.
 */
export async function checkStaleValuations() {
  const now = new Date();
  const stale = await prisma.researchValuation.findMany({
    where: {
      reviewBy: { lt: now },
      reviewAlertedAt: null,
      project: { status: { not: 'Closed' } },
    },
    include: { project: { select: { id: true, name: true, status: true } } },
  });
  let notified = 0;
  for (const v of stale) {
    const to = (v.watchers || []).filter((e) => /@/.test(e));
    let sent = false;
    if (to.length) {
      try {
        await sendBuyLevelEmail(to, {
          ticker: v.ticker,
          name: v.name,
          project: v.project?.name || null,
          price: null,
          buyBelow: v.buyBelow,
          currency: v.currency || 'USD',
          base: v.base ?? null,
          stale: true,
          reviewBy: v.reviewBy,
          source: 'review-date scan',
        });
        sent = true;
        notified += 1;
      } catch (err) {
        console.error(`[review-scan] email failed for ${v.ticker || v.name}:`, err.message);
      }
    }
    // Same discipline as crossings: a failed send stays un-announced so
    // tomorrow tries again; no watchers means the log line is the alert.
    if (sent || to.length === 0) {
      await prisma.researchValuation.update({
        where: { id: v.id },
        data: { reviewAlertedAt: now },
      });
    }
  }
  return { stale: stale.length, notified };
}
