import { parse } from 'csv-parse/sync';

// Live quotes pulled from a prices-ONLY Google Sheet tab, kept apart from the
// holdings sheet on purpose. The portfolio is moving into the database, but
// GOOGLEFINANCE() is still the cheapest source of a live last price and the
// previous close — and it only re-renders as cells inside a sheet, never as a
// standalone API. So we keep a tiny tab whose only job is one row per ticker
// (Ticker, Price, Prev Close, Change, Change %) and read it the same way the
// old holdings sheet was read: a cache-busted CSV export that forces Google to
// re-evaluate the formulas server-side at fetch time.
//
// This is deliberately a sibling of sheetPortfolio.js, not a refactor of it —
// once holdings live in the DB, that file's reason to exist is gone, but this
// price feed should outlive it.

// Falls back to the holdings spreadsheet's ID so a single document can carry
// both the (eventually retired) holdings tab and the prices tab.
const PRICES_SHEET_ID = process.env.GCIG_PRICES_SHEET_ID || process.env.GCIG_SHEET_ID;
// Reference the prices tab by NAME via the gviz endpoint — it's what a human
// actually knows and it survives a tab reorder, unlike the opaque numeric gid.
// Defaults to the "prices_needed" tab the club already maintains. Setting
// GCIG_PRICES_GID switches to addressing the tab by gid through the plain CSV
// export instead.
const PRICES_TAB = process.env.GCIG_PRICES_TAB || 'prices_needed';
const PRICES_SHEET_GID = process.env.GCIG_PRICES_GID || null;
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes, matching the holdings read

let cached = null; // { at: number, data: PriceFeed }

// Both endpoints re-render GOOGLEFINANCE() server-side and accept the same
// cache-buster param; without it Google hands back a stale snapshot that may
// be hours old whenever no human has the sheet open. gviz addresses the tab by
// name; the export path needs the numeric gid.
function csvUrl() {
  const bust = `_=${Date.now()}`;
  if (PRICES_SHEET_GID != null) {
    return `https://docs.google.com/spreadsheets/d/${PRICES_SHEET_ID}/export?format=csv&gid=${PRICES_SHEET_GID}&${bust}`;
  }
  return `https://docs.google.com/spreadsheets/d/${PRICES_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(PRICES_TAB)}&headers=1&${bust}`;
}

// "$142.05", "1.93%", "  -0.42 " → number. Empty / dashes / #N/A → null. A
// loading GOOGLEFINANCE cell briefly reads "#N/A", so null here means "not a
// real quote yet", not zero.
function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '—' || s === '#N/A' || /loading/i.test(s)) return null;
  // Accounting negatives "(0.42)" and the unicode minus "−" both mean a
  // negative; bare Number() reads them as NaN and would silently drop a real
  // down-move.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/−/g, '-');
  const cleaned = s.replace(/[$,%\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

const HEADER_ALIASES = {
  ticker: ['ticker', 'symbol'],
  price: ['price', 'current price', 'last price', 'last'],
  prevClose: ['prev close', 'previous close', 'close yesterday', 'closeyest', 'prior close'],
  change: ['change', 'day change', '$ change', 'chg'],
  changePct: ['change %', 'change pct', '% change', 'changepct', 'pct change'],
};

function matchHeaderIndex(headerRow) {
  const lower = headerRow.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) {
      const idx = lower.indexOf(a);
      if (idx !== -1) {
        map[key] = idx;
        break;
      }
    }
  }
  return map;
}

// Returns { bySymbol: { TICKER: quote }, fetchedAt }. A quote is
// { ticker, price, prevClose, change, dayChange, changePct } where dayChange is
// the per-share dollar move — derived from price - prevClose when both are
// present (the sheet's own Change column is only a fallback, since a half-loaded
// row can carry a price with a stale change). Rows whose price hasn't resolved
// are dropped so a consumer never multiplies shares by a null.
export async function getGooglePrices({ forceFresh = false } = {}) {
  if (!PRICES_SHEET_ID) {
    throw new Error('GCIG_PRICES_SHEET_ID (or GCIG_SHEET_ID) is not set in .env');
  }
  if (!forceFresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(csvUrl(), {
    redirect: 'follow',
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Google prices fetch failed (${res.status}). Make sure the prices tab is shared as "Anyone with the link can view". ${text.slice(0, 200)}`
    );
  }
  const csvText = await res.text();

  // gviz answers 200 with an HTML sign-in page (or a google.visualization JSON
  // wrapper) when the tab name is wrong or the sheet isn't link-shared — which
  // would otherwise surface downstream as a confusing "no Ticker header" error.
  // Catch it here and say what's actually wrong.
  const head = csvText.slice(0, 200).trimStart();
  if (head.startsWith('<') || /google\.visualization\.Query\.setResponse/.test(head)) {
    throw new Error(
      `Google prices fetch returned non-CSV — check that the "${PRICES_TAB}" tab exists and ` +
        `the sheet is shared "Anyone with the link can view". Body starts: ${head.slice(0, 120)}`
    );
  }

  const rows = parse(csvText, { skip_empty_lines: false, relax_column_count: true });

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => String(c).trim().toLowerCase() === 'ticker')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find a "Ticker" header row in the prices tab');
  }
  const colMap = matchHeaderIndex(rows[headerIdx]);
  if (colMap.ticker == null) {
    throw new Error('Prices tab has no Ticker column');
  }

  const bySymbol = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const ticker = String(row[colMap.ticker] || '').trim().toUpperCase();
    if (!ticker) continue;

    const price = toNumber(row[colMap.price]);
    if (price == null) continue; // unresolved GOOGLEFINANCE row — skip

    const prevClose = colMap.prevClose != null ? toNumber(row[colMap.prevClose]) : null;
    const changeCol = colMap.change != null ? toNumber(row[colMap.change]) : null;
    const dayChange = prevClose != null ? price - prevClose : changeCol;
    let changePct = colMap.changePct != null ? toNumber(row[colMap.changePct]) : null;
    if (changePct == null && prevClose != null && prevClose !== 0) {
      changePct = ((price - prevClose) / prevClose) * 100;
    }

    bySymbol[ticker] = { ticker, price, prevClose, change: changeCol, dayChange, changePct };
  }

  const data = { bySymbol, fetchedAt: new Date().toISOString() };
  cached = { at: Date.now(), data };
  return data;
}

// Convenience for a single ticker. Returns the quote object or null.
export async function getGoogleQuote(ticker, opts = {}) {
  if (!ticker) return null;
  const { bySymbol } = await getGooglePrices(opts);
  return bySymbol[String(ticker).trim().toUpperCase()] || null;
}

// Convenience for a known set of tickers — returns a keyed object containing
// only the ones that resolved, so a missing/unlisted ticker is simply absent.
export async function getGoogleQuotes(tickers = [], opts = {}) {
  const { bySymbol } = await getGooglePrices(opts);
  const out = {};
  for (const t of tickers) {
    const key = String(t || '').trim().toUpperCase();
    if (key && bySymbol[key]) out[key] = bySymbol[key];
  }
  return out;
}
