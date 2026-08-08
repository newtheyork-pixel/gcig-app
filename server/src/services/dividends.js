// Dividend history off NASDAQ's public quote API — the same keyless
// api.nasdaq.com host the price cache already leans on, chosen for the
// same reason: it tolerates Render's datacenter egress IPs where Yahoo
// 429s them (see priceHistory.js). Values arrive as display strings
// ("$0.24", "0.35%", "N/A") and dates as MM/DD/YYYY, so everything is
// parsed to numbers and ISO days before it leaves this module.
//
// One coverage truth, learned by asking (Aug '26): this endpoint
// serves NASDAQ-LISTED symbols only. A NYSE name — JNJ, GD, SCHD —
// answers 200 with null rows and the sentence "Dividend History for
// Non-Nasdaq symbols is not available". That is a licensing wall, not
// a failure, and not the same thing as a company that pays no
// dividend, so the upstream's own sentence rides through as `note`
// and the panel can say WHY the table is empty instead of implying a
// payout history that never existed.

const HTTP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10_000;

// Dividend records change quarterly at best, so a day of cache is
// conservative. The cap is FIFO by first sighting — 200 tickers is
// several times the book plus the watchlist, and evicting the oldest
// name someone looked up beats growing without bound on a 512MB dyno.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map(); // ticker → { at, value }

// Never cache a failure under a success's TTL — the same rule
// marketData.js earned from Finnhub: one throttled minute must not
// read as "no dividend history" for a day. A failed fetch is stored
// backdated so it retries within about two minutes.
const FAILURE_TTL_MS = 2 * 60 * 1000;
function failureAt(ttlMs) {
  return Date.now() - ttlMs + FAILURE_TTL_MS;
}

// Strip "$0.24" / "3.25396" → number. Null for blank or "N/A" — the
// same honesty parseMoney keeps in priceHistory.js, which is not
// exported, hence the local copy.
function parseMoney(s) {
  if (s == null) return null;
  const t = String(s).replace(/[$,\s]/g, '');
  if (!t || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// "0.35%" → 0.0035. Fractions, not percent points, because that is
// the convention the terminal panels' formatters already speak.
function parsePct(s) {
  if (s == null) return null;
  const t = String(s).replace(/[%\s+]/g, '');
  if (!t || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n / 100 : null;
}

// NASDAQ dates are en-US MM/DD/YYYY. Normalized to YYYY-MM-DD as a
// plain string — no Date object, so no timezone can slip a payment a
// day. "N/A" and anything malformed come back null.
function parseDate(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// The pure parse, exported for the colocated suite. Takes the raw
// response JSON and returns { yield, annualized, exDate, rows, note }
// with every display string converted and every miss an honest null.
// Rows keep the upstream's newest-first order.
export function parseDividends(json) {
  const note =
    typeof json?.message === 'string' && json.message.trim()
      ? json.message.trim()
      : null;
  const d = json && typeof json === 'object' ? json.data : null;
  if (!d || typeof d !== 'object') {
    return { yield: null, annualized: null, exDate: null, rows: [], note };
  }

  const rawRows = Array.isArray(d.dividends?.rows) ? d.dividends.rows : [];
  const rows = [];
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;
    const exDate = parseDate(r.exOrEffDate);
    const amount = parseMoney(r.amount);
    // A row with neither an ex-date nor an amount anchors nothing;
    // one with either is kept, missing half honestly null.
    if (exDate == null && amount == null) continue;
    rows.push({
      exDate,
      payDate: parseDate(r.paymentDate),
      recordDate: parseDate(r.recordDate),
      declared: parseDate(r.declarationDate),
      amount,
    });
  }

  // The header's ex-date is the next (or most recent) one. When the
  // header says N/A but rows exist, the newest row stands in rather
  // than showing a dash above a table that plainly knows the answer.
  const exDate = parseDate(d.exDividendDate) ?? rows[0]?.exDate ?? null;

  return {
    yield: parsePct(d.yield),
    annualized: parseMoney(d.annualizedDividend),
    exDate,
    rows,
    note,
  };
}

// One asset-class bucket. Null means "this bucket doesn't know the
// symbol" — the caller tries the other one; genuine transport trouble
// throws so it can be cached as a failure, not an empty history.
async function fetchNasdaqDividends(ticker, assetclass) {
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/dividends` +
    `?assetclass=${assetclass}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': HTTP_UA,
        Accept: 'application/json, text/plain, */*',
        // NASDAQ's edge sometimes 403s requests without a plausible
        // Referer/Origin pair. Same set priceHistory sends.
        Referer: 'https://www.nasdaq.com/',
        Origin: 'https://www.nasdaq.com',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 400) return null;
      const err = new Error(`NASDAQ dividends HTTP ${res.status}`);
      err.status = 502;
      throw err;
    }
    const json = await res.json();
    // rCode 200 is success. A wrong asset class answers rCode 400
    // ("Symbol not exists.") inside an HTTP 200 — treat it as "try
    // the other bucket", exactly like the price fetchers do.
    if (json?.status?.rCode !== 200) return null;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Did a bucket actually say anything — rows, a header figure, or the
// upstream's own explanation? Separates "answered empty, with a
// reason" from "never knew the symbol at all".
function saidAnything(p) {
  return (
    p.rows.length > 0 ||
    p.note != null ||
    p.yield != null ||
    p.annualized != null ||
    p.exDate != null
  );
}

function emptyPayload(ticker) {
  return {
    ticker,
    yield: null,
    annualized: null,
    exDate: null,
    rows: [],
    note: null,
    source: 'nasdaq.com',
    fetchedAt: new Date().toISOString(),
  };
}

// Public: the DVD panel's whole payload. Never throws — a bad ticker,
// an unknown symbol, or an upstream outage all degrade to empty rows
// with nulls, and only the outage is cached on the short failure
// clock. Shape: { ticker, yield, annualized, exDate, rows: [{ exDate,
// payDate, recordDate, declared, amount }], note, source, fetchedAt }.
export async function getDividends(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return emptyPayload(ticker || null);
  }

  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value;
  let failed = false;
  try {
    // Equities first, ETFs second — the same bucket split the price
    // fetchers use, since most of our universe is common stock. The
    // ETF pass runs whenever the stocks bucket produced no rows: a
    // NASDAQ-listed ETF like QQQ lives only in the etf bucket.
    const stocks = parseDividends(await fetchNasdaqDividends(ticker, 'stocks'));
    let parsed = stocks;
    if (stocks.rows.length === 0) {
      const etf = parseDividends(await fetchNasdaqDividends(ticker, 'etf'));
      // Prefer whichever bucket produced rows. Failing both, keep the
      // one that at least answered — its note carries the upstream's
      // reason for the empty table.
      if (etf.rows.length > 0 || (!saidAnything(stocks) && saidAnything(etf))) {
        parsed = etf;
      }
    }
    value = {
      ticker,
      yield: parsed.yield,
      annualized: parsed.annualized,
      exDate: parsed.exDate,
      rows: parsed.rows,
      note: parsed.note,
      source: 'nasdaq.com',
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`dividends(${ticker}) failed:`, err.message);
    value = emptyPayload(ticker);
    failed = true;
  }

  if (!cache.has(ticker) && cache.size >= MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(ticker, { at: failed ? failureAt(TTL_MS) : Date.now(), value });
  return value;
}
