// What following the execution rules is worth, in dollars, on a real order.
//
// The first version of this was a paper blotter that simulated resting
// orders and scored them. It answered a question nobody had. The question
// the club actually has is: we are buying $100,000 of something on
// Thursday, what does doing it properly save us against doing it badly?
//
// So this is a calculator and a ledger, not a simulator.
//
// THE TWO RULES, AND WHERE THE NUMBERS COME FROM. Both were measured
// rather than assumed, on 60 days of 5-minute bars across 17 liquid US
// names, with the bid-ask spread estimated by Corwin-Schultz (2012) from
// high-low ranges since no free source publishes quoted spreads.
//
//   1. Do not trade in the first thirty minutes. The estimated spread at
//      09:30 is 0.0510% against 0.0193% midday, a ratio of 2.64. A buyer
//      crosses half of it, so waiting is worth half the difference:
//      0.0158%. Measured against a market order at the bell it is
//      0.0197%; against a random moment in the day only 0.0009%. The
//      whole edge sits in that first half hour.
//
//   2. Post at the bid rather than crossing it. Crossing costs half a
//      spread; resting and being met saves half a spread. Across the
//      same names, resting for ten minutes beat crossing by 0.0342% of
//      the order at an 83% fill rate, positive on every single name.
//
// WHY THESE ARE HONEST NUMBERS AND NOT A SALES PITCH. They are small.
// On $10,000 the pair is worth about $5.50 and on $100,000 about $55.
// Everything larger that was tested lost money: multi-day limit ladders,
// eight chart entry signals, trend following. These two survive because
// they are structural rather than predictive. The open is violent
// because the overnight order book clears into it, every day, whatever
// anybody believes.
//
// The saving is an ESTIMATE and the panel must say so. It rests on a
// spread model, on a 60-day sample, and on a fill assumption that is a
// fact about the market rather than about our broker's queue.

/// Cost of crossing the spread at the open versus in the calm window,
/// as a fraction of the order. Half the spread difference, because a
/// buyer pays half of a spread and not all of it.
export const TIMING_EDGE_PCT = 0.0197;

/// Posting at the bid rather than crossing, same sample.
export const POSTING_EDGE_PCT = 0.0342;

/// What each is worth against a REALISTIC alternative rather than the
/// worst one. Quoted so nobody reports the flattering figure by
/// accident: against a random moment in the day the timing rule is worth
/// almost nothing, and past 10:30 it is worth about a penny per $10,000.
export const TIMING_VS_RANDOM_PCT = 0.0009;

/// Spread as a multiple of the calm-window level, by minutes from the
/// 09:30 open. Pooled across 17 names, 60 days.
export const SPREAD_CURVE = [
  [0, 2.64], [15, 2.85], [30, 2.60], [45, 1.95], [60, 1.97],
  [90, 1.54], [120, 1.36], [150, 0.98], [180, 1.06], [210, 0.95],
  [240, 1.24], [270, 0.84], [300, 1.08], [330, 0.96], [360, 1.00],
];

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
export const CALM_FROM = 120;   // 11:30
export const CALM_TO = 330;     // 15:00

export function etMinutes(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { minutes: et.getHours() * 60 + et.getMinutes() - OPEN_MIN, day: et.getDay() };
}

/// Spread multiple at a moment, interpolated between measured points.
export function spreadMultipleAt(minutes) {
  if (minutes < 0 || minutes > CLOSE_MIN - OPEN_MIN) return null;
  let prev = SPREAD_CURVE[0];
  for (const point of SPREAD_CURVE) {
    if (point[0] >= minutes) {
      if (point[0] === prev[0]) return point[1];
      const t = (minutes - prev[0]) / (point[0] - prev[0]);
      return prev[1] + t * (point[1] - prev[1]);
    }
    prev = point;
  }
  return prev[1];
}

/**
 * What this order is worth doing properly.
 *
 * `notional` is the dollar size. Everything scales linearly with it,
 * which is the single most important thing for a reader to understand:
 * these are fractions of the order, so the rules are worth ten times as
 * much on a $100,000 trade as on a $10,000 one, and the effort is the
 * same either way.
 */
export function estimate({ notional, now = new Date() } = {}) {
  const size = Number(notional);
  if (!Number.isFinite(size) || size <= 0) return null;

  const { minutes, day } = etMinutes(now);
  const weekend = day === 0 || day === 6;
  const open = !weekend && minutes >= 0 && minutes < CLOSE_MIN - OPEN_MIN;
  const mult = open ? spreadMultipleAt(minutes) : null;
  const inCalm = open && minutes >= CALM_FROM && minutes <= CALM_TO;

  const timing = (TIMING_EDGE_PCT / 100) * size;
  const posting = (POSTING_EDGE_PCT / 100) * size;

  return {
    notional: size,
    // Both rules followed, against the worst realistic alternative: a
    // market order at the opening bell.
    total: timing + posting,
    timing,
    posting,
    // The honest smaller number, against trading at some sensible hour
    // anyway. Reported beside the headline so the headline cannot be
    // quoted alone.
    timingVsRandom: (TIMING_VS_RANDOM_PCT / 100) * size,
    pct: TIMING_EDGE_PCT + POSTING_EDGE_PCT,
    session: {
      weekend,
      open,
      minutes,
      spreadMultiple: mult,
      inCalm,
      phase: phaseOf({ weekend, open, minutes, inCalm }),
      minutesUntilCalm: open && minutes < CALM_FROM ? CALM_FROM - minutes : 0,
    },
    // Where the numbers come from, carried with them, because a saving
    // quoted without its provenance becomes a promise.
    basis: '17 names, 60 days of 5-minute bars, spread estimated by Corwin-Schultz (2012)',
  };
}

function phaseOf({ weekend, open, minutes, inCalm }) {
  if (weekend) return 'weekend';
  if (!open) return minutes < 0 ? 'premarket' : 'closed';
  if (minutes < 30) return 'opening';      // the expensive half hour
  if (inCalm) return 'calm';
  if (minutes > 375) return 'closing';
  return 'ok';
}

/// A running total across trades actually taken, so the claim stops
/// being a model and becomes a record.
export function ledger(rows) {
  const done = (rows || []).filter((r) => r.executedAt);
  const saved = done.reduce((a, r) => a + (r.estimatedSaving || 0), 0);
  return {
    trades: done.length,
    notional: done.reduce((a, r) => a + (r.notional || 0), 0),
    saved,
    pending: (rows || []).length - done.length,
  };
}
