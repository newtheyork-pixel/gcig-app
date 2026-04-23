// Finnhub market-data fetchers beyond plain news + quotes. Free tier
// allows both /calendar/earnings and /stock/recommendation at 60 rpm,
// so both are safe to pull on every dashboard / holding-detail load
// with sensible caching.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const DEFAULT_TIMEOUT_MS = 8_000;

// In-memory caches. Earnings rarely change intra-day; recommendation
// trends update roughly weekly. Long TTLs keep the Finnhub budget
// nowhere near the 60 rpm cap even with heavy dashboard use.
const EARNINGS_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const CONSENSUS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const earningsCache = new Map(); // ticker → { at, data }
const consensusCache = new Map(); // ticker → { at, data }

async function finnhubFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`finnhub responded ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Earnings calendar for a single ticker, windowed daysAhead into the
// future (default 60). Returns the upcoming earnings row from Finnhub
// or null if nothing is scheduled / the ticker doesn't have consensus
// coverage (ETFs, illiquid names).
//
// Finnhub response shape: { earningsCalendar: [{ date, epsEstimate,
//   epsActual, hour: 'bmo'|'amc'|'dmh', quarter, year, symbol,
//   revenueEstimate, revenueActual }, ...] }. `hour` is 'bmo' = before
// market open, 'amc' = after market close, 'dmh' = during market hours.
export async function getUpcomingEarnings(ticker, { daysAhead = 60 } = {}) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return null;
  const upper = String(ticker).toUpperCase();

  const cached = earningsCache.get(upper);
  if (cached && Date.now() - cached.at < EARNINGS_TTL_MS) {
    return cached.data;
  }

  const now = new Date();
  const from = fmtDate(now);
  const to = fmtDate(new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000));
  const url =
    `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}` +
    `&symbol=${encodeURIComponent(upper)}&token=${encodeURIComponent(key)}`;

  let data = null;
  try {
    const json = await finnhubFetch(url);
    const rows = Array.isArray(json?.earningsCalendar) ? json.earningsCalendar : [];
    // Pick the soonest row at/after today. The endpoint can return
    // past-reported quarters when the window straddles a release.
    const today = fmtDate(now);
    const upcoming = rows
      .filter((r) => r && r.date && r.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    data = upcoming[0] || null;
  } catch (err) {
    console.warn(`earnings(${upper}) failed:`, err.message);
    data = null;
  }
  earningsCache.set(upper, { at: Date.now(), data });
  return data;
}

// Batch helper for dashboards / AI briefs. Runs per-ticker in parallel
// (each call respects its own 12h cache, so a cold fetch happens at
// most every 12 hours per ticker).
export async function getUpcomingEarningsBatch(tickers, opts = {}) {
  const list = Array.from(new Set((tickers || []).filter(Boolean).map((t) =>
    String(t).toUpperCase()
  )));
  const rows = await Promise.all(list.map((t) => getUpcomingEarnings(t, opts)));
  const out = {};
  list.forEach((t, i) => {
    if (rows[i]) out[t] = rows[i];
  });
  return out;
}

// Analyst recommendation trend. Finnhub returns the most recent few
// months as separate rows. We keep the latest, plus a 3-month-ago
// row if one exists, so callers can show "current + delta".
//
// Row shape: { period (YYYY-MM-DD), strongBuy, buy, hold, sell,
//   strongSell, symbol }.
export async function getAnalystConsensus(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return null;
  const upper = String(ticker).toUpperCase();

  const cached = consensusCache.get(upper);
  if (cached && Date.now() - cached.at < CONSENSUS_TTL_MS) {
    return cached.data;
  }

  const url =
    `${FINNHUB_BASE}/stock/recommendation?symbol=${encodeURIComponent(upper)}` +
    `&token=${encodeURIComponent(key)}`;

  let data = null;
  try {
    const json = await finnhubFetch(url);
    if (Array.isArray(json) && json.length > 0) {
      const sorted = [...json].sort((a, b) => (b.period || '').localeCompare(a.period || ''));
      const latest = sorted[0];
      // Find a row ~90 days older than latest to form a trend delta.
      const latestDate = new Date(latest.period);
      const threeMonthsAgo = new Date(latestDate.getTime() - 90 * 24 * 60 * 60 * 1000);
      const prior = sorted.find((r) => new Date(r.period) <= threeMonthsAgo) || null;

      const total = (x) =>
        (x.strongBuy || 0) + (x.buy || 0) + (x.hold || 0) + (x.sell || 0) + (x.strongSell || 0);
      const bullishShare = (x) => {
        const t = total(x);
        return t > 0 ? ((x.strongBuy || 0) + (x.buy || 0)) / t : null;
      };

      data = {
        ticker: upper,
        period: latest.period,
        strongBuy: latest.strongBuy || 0,
        buy: latest.buy || 0,
        hold: latest.hold || 0,
        sell: latest.sell || 0,
        strongSell: latest.strongSell || 0,
        total: total(latest),
        bullishShare: bullishShare(latest), // 0..1 or null
        prior: prior
          ? {
              period: prior.period,
              strongBuy: prior.strongBuy || 0,
              buy: prior.buy || 0,
              hold: prior.hold || 0,
              sell: prior.sell || 0,
              strongSell: prior.strongSell || 0,
              total: total(prior),
              bullishShare: bullishShare(prior),
            }
          : null,
      };
    }
  } catch (err) {
    console.warn(`consensus(${upper}) failed:`, err.message);
    data = null;
  }
  consensusCache.set(upper, { at: Date.now(), data });
  return data;
}
