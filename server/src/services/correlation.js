import { getSheetPortfolio } from './sheetPortfolio.js';
import { getStoredHistoryBatch } from './priceHistory.js';

// CORR — pairwise Pearson correlation of daily log returns across the
// book, from STORED price bars only. No upstream fetch lives on this
// path: a name the nightly warmer hasn't reached yet shows null cells
// until it does, which is honest, and the whole matrix costs one DB
// query however many holdings are in the book.
//
// Two windows, both in trading days: 3m (63) and 1y (252). Pairs are
// aligned by DATE INTERSECTION — two tickers may have different
// coverage, so each cell is computed on the dates both names actually
// traded, and a pair with too few common observations renders null
// rather than a number. A correlation from 12 points is noise wearing
// a number, and the minimums below are where we stop pretending
// otherwise.
//
// Basis is close-to-close with dividends excluded — the PriceBar cache
// carries no dividend history, so a high-yield name reads slightly
// less correlated with its total-return self than it really is. The
// payload says so; keep saying so until dividend data lands.

const WINDOWS = {
  '3m': { tradingDays: 63, minObservations: 40 },
  '1y': { tradingDays: 252, minObservations: 120 },
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = null; // { at, value } — successes only; a failure is never cached

export function resetCorrelationCache() {
  cache = null;
}

// Standard Pearson. Null when it cannot be a correlation: fewer than
// two points, mismatched lengths, or a degenerate (flat) series whose
// variance is zero — 0/0 is not a relationship. Clamped to [-1, 1]
// because float arithmetic on identical series lands at 1.0000000002.
export function pearson(xs, ys) {
  const n = xs?.length ?? 0;
  if (n < 2 || !ys || ys.length !== n) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  const r = cov / Math.sqrt(vx * vy);
  return Math.max(-1, Math.min(1, r));
}

// Align two bar series on their common dates, then take log returns
// over consecutive COMMON dates — so both return series span identical
// date pairs and a day one name didn't trade never manufactures a
// mismatched observation. Bars are assumed date-ascending, which is
// what getStoredHistoryBatch returns.
export function pairLogReturns(barsA, barsB) {
  const closeB = new Map();
  for (const b of barsB || []) {
    if (b && b.close > 0) closeB.set(b.date, b.close);
  }
  const common = (barsA || []).filter((b) => b && b.close > 0 && closeB.has(b.date));
  const ra = [];
  const rb = [];
  for (let i = 1; i < common.length; i++) {
    ra.push(Math.log(common[i].close / common[i - 1].close));
    rb.push(Math.log(closeB.get(common[i].date) / closeB.get(common[i - 1].date)));
  }
  return { ra, rb };
}

// One ticker's log returns keyed by the LATER date of each consecutive
// bar pair, from its own series. Feeds the rest-of-book average below.
// A return over a gap (holiday, missed bar) spans more than one day —
// acceptable for a score, and cheaper than pretending to interpolate.
export function dateKeyedReturns(bars) {
  const out = new Map();
  const clean = (bars || []).filter((b) => b && b.close > 0);
  for (let i = 1; i < clean.length; i++) {
    out.set(clean[i].date, Math.log(clean[i].close / clean[i - 1].close));
  }
  return out;
}

// The last N trading days of a series is its last N+1 bars — a window
// of 63 returns needs 64 closes.
function sliceWindow(bars, tradingDays) {
  const clean = (bars || []).filter((b) => b && b.close > 0);
  return clean.length > tradingDays + 1 ? clean.slice(-(tradingDays + 1)) : clean;
}

// Pure core: the full windows payload from a bars map and a ticker
// list. Everything above the DB and the sheet lives here, which is
// what the colocated suite exercises with synthetic bars.
export function computeCorrelation(barsByTicker, tickers) {
  const windows = {};
  for (const [key, spec] of Object.entries(WINDOWS)) {
    const { tradingDays, minObservations } = spec;
    const sliced = tickers.map((t) => sliceWindow(barsByTicker?.[t], tradingDays));

    const n = tickers.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(null));
    const observations = Array.from({ length: n }, () => Array(n).fill(0));

    // Upper triangle once, mirrored — including the diagonal through
    // the same path, so a name with too little history is null against
    // ITSELF too rather than a lone confident 1.00 in a row of dashes.
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const { ra, rb } = pairLogReturns(sliced[i], sliced[j]);
        observations[i][j] = ra.length;
        observations[j][i] = ra.length;
        if (ra.length < minObservations) continue;
        const r = pearson(ra, rb);
        matrix[i][j] = r;
        matrix[j][i] = r;
      }
    }

    // The diversifier score: each name against the equal-weight
    // average return of the REST of the book. Cheap on purpose — it
    // answers "does this name move with everything else we own", not
    // "what is its beta to our exact weights".
    const keyed = sliced.map((bars) => dateKeyedReturns(bars));
    const avgToBook = tickers.map((_, i) => {
      if (n < 2) return null;
      const xs = [];
      const ys = [];
      for (const [date, r] of keyed[i]) {
        let sum = 0;
        let count = 0;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const rj = keyed[j].get(date);
          if (rj != null) {
            sum += rj;
            count += 1;
          }
        }
        if (count === 0) continue;
        xs.push(r);
        ys.push(sum / count);
      }
      if (xs.length < minObservations) return null;
      return pearson(xs, ys);
    });

    windows[key] = { tradingDays, minObservations, matrix, observations, avgToBook };
  }
  return windows;
}

function emptyWindows() {
  const out = {};
  for (const [key, spec] of Object.entries(WINDOWS)) {
    out[key] = { ...spec, matrix: [], observations: [], avgToBook: [] };
  }
  return out;
}

const NOTE =
  'Cells need at least 40 (3m) / 120 (1y) common return observations; ' +
  'thinner pairs render as null rather than a number. Stored bars only — ' +
  'a name the nightly warmer has not reached shows null until it does.';

// Public: the whole matrix payload. Never throws — the route serves
// whatever this returns, and a sheet outage or empty DB comes back as
// a well-shaped empty result with the reason on it. Successes cache
// for 6h; failures are never cached (never cache a failure under a
// success's TTL — the watchlist learned that one the hard way).
export async function getCorrelationMatrix(deps = {}) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const loadBook = deps.getSheetPortfolio || getSheetPortfolio;
  const loadBars = deps.getStoredHistoryBatch || getStoredHistoryBatch;

  try {
    const sheet = await loadBook();
    const tickers = [
      ...new Set(
        (sheet?.holdings || [])
          .filter((h) => h && !h.isCash && h.ticker)
          .map((h) => String(h.ticker).trim().toUpperCase())
          .filter(Boolean)
      ),
    ].sort();

    const barsByTicker = tickers.length ? await loadBars(tickers) : {};
    const value = {
      tickers,
      windows: computeCorrelation(barsByTicker, tickers),
      note: NOTE,
      priceBasis: 'close-to-close, dividends excluded',
      fetchedAt: new Date().toISOString(),
    };
    cache = { at: now, value };
    return value;
  } catch (err) {
    console.warn('correlation matrix failed:', err?.message || err);
    return {
      tickers: [],
      windows: emptyWindows(),
      note: NOTE,
      priceBasis: 'close-to-close, dividends excluded',
      fetchedAt: new Date().toISOString(),
      error: `Could not compute the matrix: ${String(err?.message || err).slice(0, 200)}`,
    };
  }
}
