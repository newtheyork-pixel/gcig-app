// The forward test of the execution rules.
//
// Two rules came out of measuring ~4,000 historical orders. Stay out of
// the first thirty minutes, where the spread runs 2.6x its midday level.
// And rest at the bid rather than crossing it, which was worth 0.034% of
// the order at an 83% fill rate — about twice the timing rule.
//
// Both were measured on history, which is where a rule always looks its
// best. This watches them live.
//
// WHAT THIS CAN AND CANNOT ESTABLISH, because somebody will read the
// blotter later without the context. It CAN establish whether the market
// traded through the price the rule asked for — a real fact about the
// rule, and the thing that would break first if the study were fitted to
// a quiet sixty days. It CANNOT establish that OUR order would have been
// filled there. A resting limit sits in a queue behind everyone who was
// already at that price, and a broker routing to a wholesaler may never
// post it publicly at all. That is a question about a broker, answered
// by their Rule 605 report.
//
// The polling interval is the honest weakness and it fails in the right
// direction. Quotes are read about once a minute, so a touch that lasts
// twenty seconds is invisible and the order is recorded as unfilled. The
// live fill rate will therefore come in BELOW the true one, and a rule
// that still looks good under that handicap is a rule worth having.

import { getLiveQuotes } from './liveQuotes.js';

/// Ten minutes, matching the study. Stored per order so the horizon can
/// change without silently rewriting what older rows meant.
export const REST_MINUTES = 10;

/// The session, in minutes from 09:30 ET. The first thirty are the ones
/// the study says to avoid.
export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const AVOID_UNTIL = 30;

/// Roughly the calm-period half-spread from the Corwin-Schultz study,
/// which is what "rest at the bid" costs to express as a limit. Named
/// rather than inlined because it is an ESTIMATE from a sixty-day sample
/// and not a quoted spread — we cannot see the book.
export const HALF_SPREAD_PCT = 0.0097;

export function etMinutes(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { minutes: et.getHours() * 60 + et.getMinutes() - OPEN_MIN, day: et.getDay() };
}

/**
 * Is this a moment the rules would place an order?
 *
 * Returns a reason rather than a bare boolean: "the market is shut" and
 * "it is 09:41 and the spread is triple" are different objections, and a
 * panel that collapses them into a disabled button teaches nobody
 * anything.
 */
export function sessionAdvice(now = new Date()) {
  const { minutes, day } = etMinutes(now);
  if (day === 0 || day === 6) {
    return { ok: false, phase: 'weekend', reason: 'Market shut. Nothing to test until Monday.' };
  }
  if (minutes < 0) {
    return { ok: false, phase: 'premarket', reason: 'Market not open yet.' };
  }
  if (minutes >= CLOSE_MIN - OPEN_MIN) {
    return { ok: false, phase: 'closed', reason: 'Market shut for the day.' };
  }
  if (minutes < AVOID_UNTIL) {
    return {
      ok: false,
      phase: 'opening',
      reason: `${AVOID_UNTIL - minutes} minutes until the spread settles. `
        + 'The first half hour runs about 2.6x the midday spread.',
    };
  }
  // Resting for ten minutes into the closing bell is not resting, it is
  // being crossed at the worst print of the day.
  if (minutes > CLOSE_MIN - OPEN_MIN - REST_MINUTES - 5) {
    return { ok: false, phase: 'late', reason: 'Too close to the bell to rest an order.' };
  }
  return { ok: true, phase: 'calm', reason: 'Inside the window the study prefers.' };
}

/**
 * The order the rules imply.
 *
 * A BUY rests BELOW the market and a SELL rests ABOVE it. Getting that
 * backwards produces an order that crosses instantly and looks like a
 * spectacular fill rate, which is exactly the bug that would make this
 * whole test read as a success.
 */
export function planOrder({ side, price, shares }) {
  const s = String(side || 'buy').toLowerCase();
  const sign = s === 'sell' ? +1 : -1;
  const limit = price * (1 + (sign * HALF_SPREAD_PCT) / 100);
  return {
    side: s,
    shares,
    arrivalPrice: price,
    limitPrice: Number(limit.toFixed(4)),
    rationale: `rest ${s === 'sell' ? 'above' : 'below'} the mid by `
      + `${HALF_SPREAD_PCT}%, cross after ${REST_MINUTES}m if unfilled`,
  };
}

/**
 * Would this order have filled, given a quote we just saw?
 *
 * A buy fills when the market trades at or below the limit; a sell when
 * it trades at or above. `last` is the only price we have — no book, no
 * bid or offer — so this is a genuine touch of the limit rather than a
 * claim about queue position.
 */
export function wouldFill(order, last) {
  if (!Number.isFinite(last) || last <= 0) return false;
  return order.side === 'sell' ? last >= order.limitPrice : last <= order.limitPrice;
}

/// Better of two prices FOR THE SIDE, used to record how close the market
/// came on orders that never filled. On a buy, lower is better.
export function better(side, a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return side === 'sell' ? Math.max(a, b) : Math.min(a, b);
}

/**
 * Advance every open order by one tick.
 *
 * Pure but for the quote fetch and the writes the caller performs: it
 * takes the open rows and returns the updates, so the whole state machine
 * is testable without a database.
 */
export async function tick(open, deps = {}) {
  const quotes = deps.getLiveQuotes || getLiveQuotes;
  const now = deps.now ? deps.now() : new Date();
  if (!open.length) return [];

  const tickers = [...new Set(open.map((o) => o.ticker))];
  let live = {};
  try {
    live = await quotes(tickers);
  } catch {
    // A quote outage is not a trading decision. Leave every order open
    // and try again next minute; the alternative is recording fills and
    // expiries that the market never saw.
    return [];
  }

  const out = [];
  for (const o of open) {
    const q = live[o.ticker];
    const last = Number(q?.last ?? q?.price ?? NaN);
    const expired = new Date(o.expiresAt).getTime() <= now.getTime();

    if (Number.isFinite(last) && wouldFill(o, last)) {
      out.push({
        id: o.id,
        data: {
          status: 'filled',
          filledAt: now,
          // The LIMIT, not the last trade. Resting at a price is a claim
          // to be filled AT it; recording the print instead would credit
          // the strategy with a better fill than it asked for.
          fillPrice: o.limitPrice,
          polls: o.polls + 1,
          bestSeen: better(o.side, o.bestSeen, last),
        },
      });
      continue;
    }

    if (expired) {
      out.push({
        id: o.id,
        data: {
          status: Number.isFinite(last) ? 'crossed' : 'abandoned',
          filledAt: now,
          // Gave up and crossed: you pay the far side, which is what
          // makes an unfilled passive order expensive and is the entire
          // cost the study charged it with.
          fillPrice: Number.isFinite(last)
            ? Number((last * (1 + (o.side === 'sell' ? -1 : 1) * HALF_SPREAD_PCT / 100)).toFixed(4))
            : null,
          polls: o.polls + 1,
          bestSeen: better(o.side, o.bestSeen, last),
        },
      });
      continue;
    }

    out.push({
      id: o.id,
      data: { polls: o.polls + 1, bestSeen: better(o.side, o.bestSeen, last) },
    });
  }
  return out;
}

/**
 * What the blotter says so far.
 *
 * Shortfall is signed so that NEGATIVE IS GOOD on both sides: a buy
 * filled below arrival and a sell filled above it both come out
 * negative. Reporting a raw percentage would have every sell looking
 * like a loss.
 */
export function score(rows) {
  const done = rows.filter((r) => r.fillPrice && r.arrivalPrice);
  if (!done.length) {
    return { n: 0, filled: 0, fillRate: null, avgShortfall: null, vsCrossing: null };
  }
  const shortfall = (r) => {
    const raw = (r.fillPrice / r.arrivalPrice - 1) * 100;
    return r.side === 'sell' ? -raw : raw;
  };
  const xs = done.map(shortfall);
  const filled = done.filter((r) => r.status === 'filled').length;
  return {
    n: done.length,
    filled,
    fillRate: (filled / done.length) * 100,
    avgShortfall: xs.reduce((a, b) => a + b, 0) / xs.length,
    // What crossing immediately would have cost: half a spread, every
    // time, no fill risk. The number the passive rule has to beat.
    vsCrossing: HALF_SPREAD_PCT,
  };
}
