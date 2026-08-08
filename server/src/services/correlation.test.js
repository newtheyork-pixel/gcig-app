import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pearson,
  pairLogReturns,
  dateKeyedReturns,
  computeCorrelation,
  getCorrelationMatrix,
  resetCorrelationCache,
} from './correlation.js';

// Synthetic bars only — the failure modes worth pinning here are all
// arithmetic and alignment, not I/O: a pair computed on mismatched
// dates, a thin overlap wearing a confident number, log returns that
// drift from the hand calculation. Dates are real weekdays so the
// series look like the cache's.

// Weekday date strings starting Monday 2026-01-05.
function weekdays(n) {
  const out = [];
  const d = new Date(Date.UTC(2026, 0, 5));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Deterministic varying log returns — no RNG, no flakes, non-flat.
const ret = (i) => 0.01 * Math.sin(i * 1.7) + 0.003 * Math.cos(i * 0.9);

// Build bars over `dates` with log return scale*ret(i) between
// consecutive dates. scale -1 inverts the series exactly.
function series(dates, { scale = 1, start = 100 } = {}) {
  const bars = [{ date: dates[0], close: start, volume: 1000 }];
  for (let i = 1; i < dates.length; i++) {
    bars.push({
      date: dates[i],
      close: bars[i - 1].close * Math.exp(scale * ret(i)),
      volume: 1000,
    });
  }
  return bars;
}

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ── Pearson, by hand ─────────────────────────────────────────────────

test('pearson: exact linear relationships land on ±1', () => {
  close(pearson([1, 2, 3], [2, 4, 6]), 1);
  close(pearson([1, 2, 3], [6, 4, 2]), -1);
});

test('pearson: hand-computed mid value', () => {
  // means 2 and 2; deviations [-1,0,1] and [-1,1,0];
  // cov = 1, var = 2 and 2, r = 1/sqrt(4) = 0.5.
  close(pearson([1, 2, 3], [1, 3, 2]), 0.5);
});

test('pearson: degenerate inputs are null, not NaN', () => {
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null); // flat series
  assert.equal(pearson([1], [2]), null); // one point
  assert.equal(pearson([1, 2], [1, 2, 3]), null); // length mismatch
  assert.equal(pearson([], []), null);
});

// ── Log-return math, by hand ─────────────────────────────────────────

test('pairLogReturns: 3-point series matches the hand calculation', () => {
  const dates = weekdays(3);
  const a = [
    { date: dates[0], close: 100 },
    { date: dates[1], close: 110 },
    { date: dates[2], close: 99 },
  ];
  // Same returns at half the price level — log returns ignore scale.
  const b = [
    { date: dates[0], close: 50 },
    { date: dates[1], close: 55 },
    { date: dates[2], close: 49.5 },
  ];
  const { ra, rb } = pairLogReturns(a, b);
  assert.equal(ra.length, 2);
  close(ra[0], Math.log(110 / 100), 1e-12);
  close(ra[1], Math.log(99 / 110), 1e-12);
  close(rb[0], Math.log(55 / 50), 1e-12);
  close(rb[1], Math.log(49.5 / 55), 1e-12);
});

test('dateKeyedReturns keys each return by the later date', () => {
  const dates = weekdays(3);
  const keyed = dateKeyedReturns([
    { date: dates[0], close: 100 },
    { date: dates[1], close: 110 },
    { date: dates[2], close: 99 },
  ]);
  assert.equal(keyed.size, 2);
  close(keyed.get(dates[1]), Math.log(1.1), 1e-12);
  close(keyed.get(dates[2]), Math.log(0.9), 1e-12);
});

// ── The matrix ───────────────────────────────────────────────────────

test('perfectly correlated series read ~1.0; thin 1y window reads null', () => {
  const dates = weekdays(80);
  const bars = {
    AAA: series(dates),
    BBB: series(dates, { start: 300 }), // same returns, 3x the price
  };
  const w = computeCorrelation(bars, ['AAA', 'BBB']);

  close(w['3m'].matrix[0][1], 1);
  close(w['3m'].matrix[1][0], 1);
  close(w['3m'].matrix[0][0], 1); // diagonal through the same path
  // 3m slices to the last 64 bars → 63 return observations.
  assert.equal(w['3m'].observations[0][1], 63);

  // 79 observations is under the 1y minimum of 120 — null, everywhere,
  // diagonal included. Not a smaller number: no number.
  assert.equal(w['1y'].matrix[0][1], null);
  assert.equal(w['1y'].matrix[0][0], null);
});

test('an exactly inverted series reads ~-1.0', () => {
  const dates = weekdays(80);
  const bars = {
    AAA: series(dates),
    CCC: series(dates, { scale: -1 }),
  };
  const w = computeCorrelation(bars, ['AAA', 'CCC']);
  close(w['3m'].matrix[0][1], -1);
});

test('insufficient overlap is null while the rest of the row stands', () => {
  const dates = weekdays(80);
  const bars = {
    AAA: series(dates),
    // Only the last 20 sessions on file — 19 return observations,
    // under the 3m minimum of 40.
    DDD: series(dates.slice(-20)),
  };
  const w = computeCorrelation(bars, ['AAA', 'DDD']);
  assert.equal(w['3m'].matrix[0][1], null);
  assert.equal(w['3m'].observations[0][1], 19);
  close(w['3m'].matrix[0][0], 1); // AAA is still whole against itself
});

test('misaligned dates are handled by intersection, not by index', () => {
  const dates = weekdays(100);
  const full = series(dates);
  // Same underlying walk, but every 5th session is missing — as if the
  // warmer skipped days. Intersection makes each return span the same
  // two dates on both sides, so the correlation survives intact.
  const gappyDates = dates.filter((_, i) => i % 5 !== 4);
  const gappy = series(dates).filter((b) => gappyDates.includes(b.date));
  const w = computeCorrelation({ AAA: full, EEE: gappy }, ['AAA', 'EEE']);
  close(w['3m'].matrix[0][1], 1);
  assert.ok(
    w['3m'].observations[0][1] < 63,
    'the gaps must have cost observations'
  );
  assert.ok(w['3m'].observations[0][1] >= 40, 'but not below the minimum');
});

test('avgToBook: a name inverted against the book reads ~-1', () => {
  const dates = weekdays(80);
  const bars = {
    AAA: series(dates),
    BBB: series(dates, { start: 200 }), // same returns as AAA
    CCC: series(dates, { scale: -0.5 }), // leans against the book
  };
  const w = computeCorrelation(bars, ['AAA', 'BBB', 'CCC']);
  // CCC's rest-of-book is the average of two identical return series —
  // exactly AAA's returns — and CCC is a negative multiple of that.
  close(w['3m'].avgToBook[2], -1);
  // AAA's rest-of-book is (r + -0.5r)/2 = 0.25r: a positive multiple.
  close(w['3m'].avgToBook[0], 1);
  // 1y stays null — same observation floor as the matrix.
  assert.equal(w['1y'].avgToBook[0], null);
});

test('a one-name book has no rest-of-book to correlate against', () => {
  const dates = weekdays(80);
  const w = computeCorrelation({ AAA: series(dates) }, ['AAA']);
  assert.equal(w['3m'].avgToBook[0], null);
});

// ── The orchestrator ─────────────────────────────────────────────────

const SHEET = {
  holdings: [
    { ticker: 'AAA', isCash: false },
    { ticker: 'bbb', isCash: false }, // case-normalized on the way in
    { ticker: 'FGTXX', isCash: true }, // cash never enters the matrix
  ],
  fetchedAt: new Date().toISOString(),
};

test('getCorrelationMatrix: shape, cash exclusion, and the 6h cache', async () => {
  resetCorrelationCache();
  const dates = weekdays(80);
  let barCalls = 0;
  const deps = {
    getSheetPortfolio: async () => SHEET,
    getStoredHistoryBatch: async (tickers) => {
      barCalls += 1;
      assert.deepEqual(tickers, ['AAA', 'BBB']);
      return { AAA: series(dates), BBB: series(dates, { start: 50 }) };
    },
  };

  const out = await getCorrelationMatrix(deps);
  assert.deepEqual(out.tickers, ['AAA', 'BBB']);
  assert.equal(out.priceBasis, 'close-to-close, dividends excluded');
  assert.ok(out.fetchedAt);
  assert.ok(out.note);
  close(out.windows['3m'].matrix[0][1], 1);

  // Second call is the cache, not a second read.
  const again = await getCorrelationMatrix(deps);
  assert.equal(again, out);
  assert.equal(barCalls, 1);
});

test('getCorrelationMatrix never throws, and a failure is not cached', async () => {
  resetCorrelationCache();
  const failing = {
    getSheetPortfolio: async () => {
      throw new Error('sheet unreachable');
    },
  };
  const out = await getCorrelationMatrix(failing);
  assert.deepEqual(out.tickers, []);
  assert.ok(out.error?.includes('sheet unreachable'));
  assert.deepEqual(out.windows['3m'].matrix, []);

  // The very next call with a healthy loader succeeds — the failure
  // did not sit in the cache wearing a 6h TTL.
  const dates = weekdays(80);
  const healthy = {
    getSheetPortfolio: async () => SHEET,
    getStoredHistoryBatch: async () => ({
      AAA: series(dates),
      BBB: series(dates, { start: 50 }),
    }),
  };
  const ok = await getCorrelationMatrix(healthy);
  assert.deepEqual(ok.tickers, ['AAA', 'BBB']);
  assert.equal(ok.error, undefined);
  resetCorrelationCache();
});
