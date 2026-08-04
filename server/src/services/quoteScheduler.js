// Prices for a long list of tickers, without asking for all of them at
// once.
//
// The watchlist grew to 162 names and `getQuotes` answered by firing 162
// concurrent fetches. Yahoo rate-limits per IP, so most of them failed;
// every failure then fell through to yahoo-finance2's quote(), which
// needs a crumb, and the crumb endpoint answered 429. What a member saw
// was "Failed to get crumb, status 429" on a red screen, and a watchlist
// where 0 of 162 rows carried a price.
//
// THE FIX IS PACING, NOT RETRIES. A burst that fails and retries is the
// same burst twice. Each ticker is refreshed on its own clock, spread
// evenly across a fifteen-minute cycle, so 162 names cost about one
// request every five seconds instead of 162 in one instant. Nothing is
// ever fetched to answer a request: the API serves whatever the cache
// holds and says how old it is.
//
// A minute-old price on a watchlist nobody is trading from is worth
// nothing over a fifteen-minute-old one. A blank row is worth much less
// than either, and that is the trade this file makes.

const CYCLE_MS = 15 * 60 * 1000;      // every ticker refreshed this often
const MIN_GAP_MS = 1_200;             // floor between upstream calls
const MAX_GAP_MS = 20_000;            // and a ceiling, for tiny lists
const STALE_AFTER_MS = 45 * 60 * 1000; // past this, say so rather than show it

/// ticker → { price, change, changePercent, currency, name, at }
const store = new Map();
/// Round-robin cursor over the tracked list.
let order = [];
let cursor = 0;
let timer = null;
let fetcher = null;

/**
 * Tickers this process should keep warm.
 *
 * Replacing the list preserves what is already known — a watchlist edit
 * must not blank every other row — and NEW tickers go to the front, since
 * somebody who just added a name is looking at it now.
 */
export function track(tickers) {
  const want = [...new Set((tickers || [])
    .map((t) => String(t || '').trim().toUpperCase())
    .filter(Boolean))];
  const known = new Set(order);
  const fresh = want.filter((t) => !known.has(t));
  order = [...fresh, ...want.filter((t) => known.has(t))];
  for (const t of [...store.keys()]) if (!want.includes(t)) store.delete(t);
  // Rewind so the new names at the front are actually reached next.
  // Without this the cursor keeps its old position and a ticker somebody
  // just added waits a full cycle — up to fifteen minutes of a blank row
  // on the one name they are looking at.
  if (fresh.length) cursor = 0;
  return { tracked: order.length, added: fresh.length };
}

/// Gap between upstream calls so one full pass takes about CYCLE_MS.
export function gapMs(n = order.length) {
  if (n <= 0) return MAX_GAP_MS;
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round(CYCLE_MS / n)));
}

/**
 * Refresh exactly one ticker. Called on a timer, never by a request.
 *
 * One at a time is the entire point. Two would double the rate for no
 * benefit a member could perceive, and the failure this replaced was
 * caused by concurrency rather than by volume.
 */
export async function tick(deps = {}) {
  const fetchOne = deps.fetchOne || fetcher;
  if (!fetchOne || !order.length) return null;
  const ticker = order[cursor % order.length];
  cursor = (cursor + 1) % order.length;
  try {
    const q = await fetchOne(ticker);
    if (q && q.price != null) {
      store.set(ticker, { ...q, ticker, at: Date.now() });
      return ticker;
    }
  } catch {
    // Deliberately silent per ticker. One symbol Yahoo will not answer
    // is normal; logging it every fifteen minutes forever is noise that
    // buries the outages worth seeing.
  }
  return null;
}

export function start(fetchOne) {
  fetcher = fetchOne;
  stop();
  const schedule = () => {
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, gapMs());
  };
  schedule();
}

export function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * What we hold for these tickers, right now, without fetching anything.
 *
 * Every row carries `asOf` and `stale`. A price with no age on it invites
 * a reader to assume it is live, and on a fifteen-minute cycle it is
 * usually not — saying so is the difference between a slow quote and a
 * wrong one.
 */
export function read(tickers) {
  const now = Date.now();
  return (tickers || []).map((raw) => {
    const t = String(raw || '').trim().toUpperCase();
    const hit = store.get(t);
    if (!hit) {
      return { ticker: t, price: null, change: null, changePercent: null,
               currency: 'USD', name: t, asOf: null, stale: null, pending: true };
    }
    return {
      ...hit,
      asOf: new Date(hit.at).toISOString(),
      ageSeconds: Math.round((now - hit.at) / 1000),
      stale: now - hit.at > STALE_AFTER_MS,
      pending: false,
    };
  });
}

/// For the panel that wants to say "162 names, 148 priced, oldest 14m".
export function status() {
  const now = Date.now();
  const ages = [...store.values()].map((v) => now - v.at);
  return {
    tracked: order.length,
    priced: store.size,
    gapMs: gapMs(),
    cycleMinutes: Math.round((gapMs() * order.length) / 60000),
    oldestSeconds: ages.length ? Math.round(Math.max(...ages) / 1000) : null,
  };
}

export function _reset() {
  stop();
  store.clear();
  order = [];
  cursor = 0;
  fetcher = null;
}
