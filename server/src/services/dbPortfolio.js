import prisma from '../db.js';
import { resolveQuotes } from './portfolioQuotes.js';
import { enrichHoldingsMeta } from './holdingMeta.js';

// The database-backed portfolio, assembled to be a drop-in for the sheet read.
// It returns the EXACT shape getSheetPortfolio() returns — { holdings, totals,
// fetchedAt } with the same per-holding keys — so every one of the ~15
// consumers (and getPortfolioMovers) keeps working untouched once the cutover
// flag flips. The only behavioral difference is provenance: positions come
// from the Holding table, live prices from the quote resolver (Google for held
// names, Finnhub for the rest), and cash from the Transaction ledger rather
// than a sheet cell.
//
// Held with no live quote: we don't drop the row or zero it — the position
// shows at cost (price = costBasis, no day move) and we warn, so a transient
// quote outage degrades to "flat at cost" instead of vanishing AUM.

export async function getDbPortfolio({ forceFresh = false } = {}) {
  // Live positions only — a fully-sold name keeps its row with closedAt set
  // for history but is not part of the book. Cash is never a Holding here; it
  // is derived from the ledger below.
  const positions = await prisma.holding.findMany({
    where: { closedAt: null, isCash: false },
    orderBy: { ticker: 'asc' },
  });

  // Self-heal: a position a trade created with just a ticker gets its company
  // name + sector filled from Finnhub in the background. Fire-and-forget — this
  // read returns immediately and the names appear on the next refresh.
  if (positions.some((p) => !p.name || p.name === p.ticker || !p.sector)) {
    enrichHoldingsMeta().catch(() => {});
  }

  // Cash = running sum of every cash movement. No stored balance.
  const cashAgg = await prisma.transaction.aggregate({ _sum: { cashDelta: true } });
  const cashValue = cashAgg._sum.cashDelta ?? 0;

  const quotes = await resolveQuotes(
    positions.map((p) => p.ticker),
    { google: { forceFresh } }
  );

  const holdings = [];
  for (const p of positions) {
    const q = quotes[p.ticker];
    const priced = !!q && q.price != null;
    if (!priced) {
      console.warn(`getDbPortfolio: no live quote for ${p.ticker}; valuing at cost, return unknown`);
    }
    // A held name we can't price doesn't get a faked flat 0% return — the sheet
    // returned null here, and pitches/movers/clubBrief key off that to show
    // "—". We value it at cost so total AUM stays continuous, but leave price,
    // day-change, and both returns null so nothing asserts a confident move.
    const valuation = priced ? q.price : p.costBasis;
    const marketValue = p.shares != null ? p.shares * valuation : null;
    const dollarReturn =
      priced && p.shares != null && p.costBasis != null ? (q.price - p.costBasis) * p.shares : null;
    const percentReturn =
      priced && p.costBasis > 0 ? ((q.price - p.costBasis) / p.costBasis) * 100 : null;

    holdings.push({
      ticker: p.ticker,
      name: p.name || p.ticker,
      sector: p.sector || null,
      shares: p.shares,
      price: priced ? q.price : null,
      costBasis: p.costBasis,
      marketValue,
      portfolioPct: null, // filled once we know the total
      dayChange: priced ? q.dayChange : null, // per-share dollar move, matching the sheet
      dollarReturn,
      // The prices feed carries no year-start anchor, so YTD isn't derivable
      // here yet. Add a "YTD Start" GOOGLEFINANCE column to surface it again.
      ytdReturn: null,
      percentReturn,
      isCash: false,
    });
  }

  // Cash rides as a holding row exactly like the sheet did: market value = the
  // cash balance, cost = value (cash carries no unrealized P/L).
  holdings.push({
    ticker: 'CASH',
    name: 'Cash',
    sector: 'Cash and Cash Equivalents',
    shares: 1,
    price: null,
    costBasis: cashValue,
    marketValue: cashValue,
    portfolioPct: null,
    dayChange: null,
    dollarReturn: null,
    ytdReturn: null,
    percentReturn: null,
    isCash: true,
  });

  // Totals, mirroring sheetPortfolio.js exactly: cash counts at value with zero
  // cost; positions at shares × price and shares × costBasis.
  let totalValue = 0;
  let totalCost = 0;
  for (const h of holdings) {
    const mv = h.marketValue != null ? h.marketValue : 0;
    let cost = 0;
    if (h.isCash) {
      cost = mv;
    } else if (h.shares != null && h.costBasis != null) {
      cost = h.shares * h.costBasis;
    }
    totalValue += mv;
    totalCost += cost;
  }
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;

  // Now that the total is known, fill each holding's weight.
  for (const h of holdings) {
    h.portfolioPct = totalValue > 0 && h.marketValue != null ? (h.marketValue / totalValue) * 100 : null;
  }

  return {
    holdings,
    totals: { totalValue, totalCost, totalGainLoss, totalGainLossPct, cashValue },
    fetchedAt: new Date().toISOString(),
    source: 'db',
  };
}
