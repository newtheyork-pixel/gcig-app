// The club's own track record: every decision it made, and what
// happened next.
//
// This is the one screen a real terminal cannot sell us. Bloomberg knows
// what General Dynamics did; it has no idea that this club voted to buy
// it on 5 June with five ballots and a $4,400 average proposal. The
// record of our own judgment exists only here, and until now it existed
// only as rows in a votes table that nobody reads after the meeting
// ends.
//
// THE RULES THIS FILE EXISTS TO ENFORCE.
//
// Measure against the alternative, not against zero. A buy that returned
// 4% while the index returned 11% lost the club money it would otherwise
// have had. Every decision is scored as excess return over SPY across
// the identical window, because the honest counterfactual for "should we
// own this" is "or should we have left it in the index".
//
// Score the decision, not the direction. A Sell that avoided a 20% fall
// is a good decision and shows as +20%; the same arithmetic that makes a
// Buy look good when the stock rises has to be inverted, or the club's
// best exits would appear in the report card as its worst calls.
//
// Never rank on a sample that cannot carry a rank. A vote closed nine
// days ago has no verdict in it, and a report card that sorted a
// nine-day 6% move above a year-long 40% one would teach members to
// trust noise. Anything under the maturity floor is reported with its
// number and explicitly marked too early to judge.

import { getHistory } from './priceHistory.js';

/// The alternative use of the money. Not a neutral choice — it is the
/// club's actual default, and picking a sector ETF or an equal-weight
/// index instead would flatter or punish decisions for reasons that have
/// nothing to do with whether the decision was right.
export const BENCHMARK = 'SPY';

/// Below this a decision is reported but not ranked. Roughly a quarter,
/// which is the shortest window over which a thesis about a business can
/// begin to be wrong for the reasons it was argued about rather than for
/// reasons nobody mentioned.
export const MATURITY_DAYS = 90;

const DAY_MS = 86_400_000;

/// The close on or immediately before a date.
///
/// A vote closes on whatever day the meeting ran, which is regularly a
/// day the market did not open. Searching forward would price a Friday
/// decision at Monday's open and hand the club credit or blame for a
/// weekend it had no part in; searching backward prices it at the last
/// print anybody in the room could actually have seen.
export function closeOnOrBefore(bars, when) {
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return null;
  let best = null;
  for (const b of bars || []) {
    const bt = new Date(b.date).getTime();
    if (!Number.isFinite(bt) || bt > t) continue;
    if (!best || bt > new Date(best.date).getTime()) best = b;
  }
  // adjClose where the source gives it: a decision measured across a
  // dividend or a split has to be measured on the same basis the
  // benchmark is, or the club gets charged for a stock split.
  if (!best) return null;
  const px = Number(best.adjClose ?? best.close);
  return Number.isFinite(px) && px > 0 ? { date: best.date, close: px } : null;
}

/// The last close in a series.
export function lastClose(bars) {
  let best = null;
  for (const b of bars || []) {
    if (!best || new Date(b.date).getTime() > new Date(best.date).getTime()) best = b;
  }
  if (!best) return null;
  const px = Number(best.adjClose ?? best.close);
  return Number.isFinite(px) && px > 0 ? { date: best.date, close: px } : null;
}

/**
 * Score one decision.
 *
 * `sign` is what makes a Sell legible. For a Buy the club wanted the
 * price to rise, so its excess return is the stock's less the
 * benchmark's. For a Sell or a NoBuy the club wanted to be out of it,
 * so the same excess is negated: avoiding a fall is a win, and missing
 * a rise is a loss.
 */
export function scoreDecision({ decision, closedAt, bars, benchBars, now = null }) {
  const entry = closeOnOrBefore(bars, closedAt);
  const benchEntry = closeOnOrBefore(benchBars, closedAt);
  const exit = lastClose(bars);
  const benchExit = lastClose(benchBars);

  // Four distinct reasons there is no score, and they are not the same
  // fact. "We have no prices for this ticker" is our gap; "the vote
  // closed before our price history starts" is a limit of the archive.
  if (!entry || !exit) {
    return { scored: false, reason: bars?.length ? 'No price on the decision date' : 'No price history' };
  }
  if (!benchEntry || !benchExit) {
    return { scored: false, reason: 'No benchmark history for that window' };
  }

  const ret = (exit.close / entry.close - 1) * 100;
  const bench = (benchExit.close / benchEntry.close - 1) * 100;
  const sign = signFor(decision);
  if (sign === 0) {
    return { scored: false, reason: `A ${decision || 'Hold'} decision has no direction to score` };
  }

  const days = Math.round(
    ((now ? new Date(now).getTime() : new Date(exit.date).getTime())
      - new Date(entry.date).getTime()) / DAY_MS,
  );

  return {
    scored: true,
    entryDate: entry.date,
    entryPrice: entry.close,
    lastPrice: exit.close,
    ret,
    bench,
    // The number that matters. Everything else on the row is working.
    excess: (ret - bench) * sign,
    // Which way the club was pointed, kept so a reader can tell a Sell
    // that avoided a fall from a Buy that caught a rise.
    sign,
    days,
    // A verdict needs a window. Below the floor the number is real and
    // the ranking would not be.
    mature: days >= MATURITY_DAYS,
  };
}

function signFor(decision) {
  switch (String(decision || '')) {
    case 'Buy': return 1;
    case 'Sell': return -1;
    // NoBuy is a decision. The club looked at a name, argued about it,
    // and chose not to own it — and whether that was right is exactly as
    // answerable as whether a purchase was. Leaving it unscored would
    // quietly grade the club only on the trades it made.
    case 'NoBuy': return -1;
    default: return 0;   // Hold says nothing about what we expected
  }
}

/**
 * The whole scoreboard.
 *
 * Sessions come in already tallied — this file does not recompute the
 * club's weighting rules, because a second implementation of them is how
 * the report card and the votes page start disagreeing about what was
 * decided.
 */
export async function buildScoreboard(decisions, deps = {}) {
  const history = deps.getHistory || getHistory;
  const range = deps.range || '5y';

  let benchBars = [];
  let benchError = null;
  try {
    benchBars = await history(BENCHMARK, range);
  } catch (err) {
    // Without the benchmark nothing can be scored, and saying so once is
    // better than printing the same "no benchmark" against thirty rows.
    benchError = String(err?.message || err);
  }

  const tickers = [...new Set(decisions.map((d) => d.ticker).filter(Boolean))];
  const bars = new Map();
  for (const t of tickers) {
    try {
      bars.set(t, await history(t, range));
    } catch {
      bars.set(t, []);
    }
  }

  const rows = decisions.map((d) => ({
    ...d,
    ...scoreDecision({
      decision: d.decision,
      closedAt: d.closedAt,
      bars: bars.get(d.ticker) || [],
      benchBars,
    }),
  }));

  return { rows, benchmark: BENCHMARK, benchError, maturityDays: MATURITY_DAYS };
}

/**
 * The club's record in one line.
 *
 * Mature decisions only, and the count of what was excluded travels with
 * it — a hit rate quoted over four decisions is not a hit rate, and the
 * only defence against reading it as one is showing the denominator.
 */
export function summarize(rows) {
  const scored = (rows || []).filter((r) => r.scored);
  const mature = scored.filter((r) => r.mature);
  const wins = mature.filter((r) => r.excess > 0).length;
  const sum = mature.reduce((a, r) => a + r.excess, 0);
  return {
    decisions: (rows || []).length,
    scored: scored.length,
    mature: mature.length,
    tooEarly: scored.length - mature.length,
    unscored: (rows || []).length - scored.length,
    wins,
    losses: mature.length - wins,
    // Averaged, not compounded. These are parallel judgments about
    // different names, not a sequence of positions in one account, and
    // chaining them would invent a portfolio nobody held.
    avgExcess: mature.length ? sum / mature.length : null,
    hitRate: mature.length ? (wins / mature.length) * 100 : null,
  };
}
