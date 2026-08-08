// FINRA short interest for the SI panel — two keyless feeds that
// answer different questions and degrade independently.
//
// 1. Consolidated short interest (bi-monthly settlements): POST
//    api.finra.org/data/group/otcMarket/name/consolidatedShortInterest.
//    Probed live 2026-08-07 against GD and AAPL: a symbol's full
//    history is ~206 rows (2017 → present), an unknown symbol answers
//    HTTP 204 with an EMPTY body (res.json() would throw — 204 is a
//    real answer, not a failure), and asking the server to sort is
//    refused outright: sortFields ["-settlementDate"] gets a 400
//    ("Sorting is allowed only if all partition keys are specified in
//    EQUAL CompareFilter"). The default order starts in the OLDEST
//    region of the dataset, so a limited fetch without our own sort
//    would serve 2020 as if it were current. We pull the whole
//    history in one request and sort here.
//
// 2. Reg SHO daily short-sale volume: one pipe-delimited file per
//    trading day on cdn.finra.org covering EVERY symbol, so it is
//    fetched and parsed once and serves the whole terminal. A missing
//    day (weekend, holiday) is a 403 AccessDenied from the CDN — not
//    a 404 — so a single 403 means "walk back a day" and only the
//    whole candidate window failing means the feed itself is off.
//
// Neither feed has been proven reachable from Render's datacenter IP.
// If either refuses us there, the result says so (`available:false`)
// instead of dressing the outage up as a company with no shorts, and
// the status code is logged once rather than on every panel open.

const FINRA_SI_URL =
  'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const CNMS_DAILY_BASE = 'https://cdn.finra.org/equity/regsho/daily';
const DEFAULT_TIMEOUT_MS = 10_000;

export const SOURCE_LABELS = {
  consolidated: 'FINRA consolidated short interest, bi-monthly settlement',
  daily: 'FINRA Reg SHO daily short volume, off-exchange',
};

// Settlements are bi-monthly and the daily file changes once per
// trading day, so 12h TTLs keep both feeds to a handful of fetches a
// day. Failures are backdated so they retry within two minutes — the
// same failureAt rule marketData.js and secFetch earned: never cache
// an outage under the TTL meant for an answer.
const SETTLEMENT_TTL_MS = 12 * 60 * 60 * 1000;
const DAILY_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
function failureAt(ttlMs) {
  return Date.now() - ttlMs + FAILURE_TTL_MS;
}

const settlementCache = new Map(); // ticker → { at, data: { settlements, available } }
let dailyCache = null; // { at, date, bySymbol, available }

// One log line per feed+status for the life of the process. The
// interesting event is "Render's IP turned out to be blocked", which
// is worth exactly one line, not one per panel open.
const loggedStatuses = new Set();
function logStatusOnce(feed, status) {
  const key = `${feed}:${status}`;
  if (loggedStatuses.has(key)) return;
  loggedStatuses.add(key);
  console.warn(
    `shortInterest: ${feed} responded ${status} — if this persists from the deployed API, ` +
      'the feed is refusing this deployment\'s IP and the panel will say so'
  );
}

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Raw FINRA settlement rows → the panel's shape: newest first, capped.
// The cap is 8 (four months of bi-monthly prints) because the panel is
// a read of the current setup, not an archive. Exported for tests —
// this is where the served-order gotcha is corrected.
export function normalizeSettlements(rows, cap = 8) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.settlementDate)
    .map((r) => ({
      date: r.settlementDate,
      shares: r.currentShortPositionQuantity ?? null,
      prior: r.previousShortPositionQuantity ?? null,
      changePct: r.changePercent ?? null,
      daysToCover: r.daysToCoverQuantity ?? null,
      adv: r.averageDailyVolumeQuantity ?? null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cap);
}

// The API's symbolCode concatenates share classes: BRK.B is BRKB,
// BF.B is BFB (probed live — the dotted, dashed and slashed spellings
// all answer 204). The vendor-convention ticker is tried as-is first
// so plain symbols cost one request; the stripped spelling is the
// share-class retry.
function siSymbolCandidates(upper) {
  const stripped = upper.replace(/[.\-/ ]/g, '');
  return stripped !== upper ? [upper, stripped] : [upper];
}

async function fetchSettlements(upper) {
  for (const symbol of siSymbolCandidates(upper)) {
    const res = await timedFetch(FINRA_SI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // No sortFields — the API rejects sorting on settlementDate
      // (400, partition-key rule). limit 1000 comfortably clears the
      // ~206 rows a full history runs to today; normalizeSettlements
      // owns the ordering.
      body: JSON.stringify({
        compareFilters: [
          { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol },
        ],
        limit: 1000,
      }),
    });
    // 204: FINRA has nothing filed under this spelling. An answer,
    // not an outage — try the next spelling, then report empty.
    if (res.status === 204) continue;
    if (!res.ok) {
      logStatusOnce('consolidated short interest', res.status);
      const err = new Error(`FINRA consolidated SI responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const settlements = normalizeSettlements(json);
    if (settlements.length) return settlements;
  }
  return [];
}

async function getSettlements(upper) {
  const cached = settlementCache.get(upper);
  if (cached && Date.now() - cached.at < SETTLEMENT_TTL_MS) return cached.data;

  let data;
  let failed = false;
  try {
    data = { settlements: await fetchSettlements(upper), available: true };
  } catch (err) {
    console.warn(`shortInterest settlements(${upper}) failed:`, err.message);
    data = { settlements: [], available: false };
    failed = true;
  }
  settlementCache.set(upper, {
    at: failed ? failureAt(SETTLEMENT_TTL_MS) : Date.now(),
    data,
  });
  return data;
}

// The CNMS file's candidate days, newest first: today in New York,
// then up to `maxBack` days behind it. Anchored to America/New_York
// because the file is named for the US trading day — a UTC evening is
// already "tomorrow" and would lead with a file that cannot exist yet
// (harmless, it 403s and we walk back, but the ET anchor means the
// common case hits on the first or second try). The Set guards the
// DST edges where stepping 24h can land twice on one wall-clock day.
// Exported for tests.
export function dailyFileCandidates(now = Date.now(), maxBack = 5) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const out = new Set();
  for (let i = 0; i <= maxBack; i++) {
    out.add(fmt.format(new Date(now - i * 86_400_000)).replace(/-/g, ''));
  }
  return [...out];
}

// Parse one day's CNMS file into symbol → volumes. Shape (verified
// live): a header line, then Date|Symbol|ShortVolume|ShortExempt-
// Volume|TotalVolume|Market rows, then a bare record-count trailer
// ("12173") that must not be read as a symbol. Volumes carry decimals
// — fractional-share prints are real in this file — so parseFloat,
// not parseInt. Exported for tests.
export function parseShortVolumeFile(text) {
  const bySymbol = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length !== 6) continue; // trailer, blanks
    const [date, symbol, shortVol, exemptVol, totalVol] = parts;
    if (!/^\d{8}$/.test(date)) continue; // header
    bySymbol.set(symbol, {
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      shortVol: parseFloat(shortVol),
      shortExemptVol: parseFloat(exemptVol),
      totalVol: parseFloat(totalVol),
    });
  }
  return bySymbol;
}

async function loadDailyFile() {
  if (dailyCache && Date.now() - dailyCache.at < DAILY_TTL_MS) return dailyCache;

  let failed = false;
  let next = null;
  try {
    let lastStatus = null;
    for (const day of dailyFileCandidates()) {
      const res = await timedFetch(`${CNMS_DAILY_BASE}/CNMSshvol${day}.txt`);
      if (res.ok) {
        const bySymbol = parseShortVolumeFile(await res.text());
        // A 200 that parses to nothing is not a trading day's file,
        // it is a stub or an error page. Keep walking.
        if (bySymbol.size > 0) {
          next = { at: Date.now(), date: day, bySymbol, available: true };
          break;
        }
        lastStatus = 'empty-200';
        continue;
      }
      // 403 (AccessDenied) is how the CDN spells "no file for that
      // day" — expected for weekends and holidays. Any 6-day window
      // contains a weekday, so exhausting every candidate means the
      // feed is refusing us, not that the market never opened.
      lastStatus = res.status;
    }
    if (!next) {
      logStatusOnce('Reg SHO daily short volume', lastStatus ?? 'no-file');
      next = { at: Date.now(), date: null, bySymbol: new Map(), available: false };
      failed = true;
    }
  } catch (err) {
    console.warn('shortInterest daily file failed:', err.message);
    next = { at: Date.now(), date: null, bySymbol: new Map(), available: false };
    failed = true;
  }
  if (failed) next.at = failureAt(DAILY_TTL_MS);
  dailyCache = next;
  return next;
}

// The daily file spells share classes with a slash (BRK/B, BF/B —
// verified in the live file) where the rest of the app says BRK.B and
// EDGAR says BRK-B. Map lookups are free, so try every spelling.
function dailySymbolCandidates(upper) {
  const out = new Set([upper]);
  out.add(upper.replace(/[.\-]/g, '/'));
  out.add(upper.replace(/[.\-/]/g, ''));
  return [...out];
}

async function getDailyShortPct(upper) {
  const day = await loadDailyFile();
  if (!day.available) return { row: null, available: false };
  let hit = null;
  for (const symbol of dailySymbolCandidates(upper)) {
    hit = day.bySymbol.get(symbol);
    if (hit) break;
  }
  if (!hit) return { row: null, available: true };
  return {
    available: true,
    row: {
      date: hit.date,
      // A fraction (0..1), the convention the panels' formatters
      // multiply by 100 — same contract as the sheet's changePct.
      pct: hit.totalVol > 0 ? hit.shortVol / hit.totalVol : null,
      shortVol: hit.shortVol,
      totalVol: hit.totalVol,
    },
  };
}

// The SI panel's whole read for one ticker. Never throws: a feed that
// refused us comes back available:false with the settlements empty /
// the daily row null, and the panel renders the honest sentence
// instead of a book of zeros. A 204 or an absent row with the feed
// healthy is the other, quieter answer: nothing on file.
export async function getShortInterest(ticker) {
  const upper = String(ticker || '').toUpperCase().trim();
  const empty = {
    ticker: upper,
    settlements: [],
    consolidatedAvailable: true,
    dailyShortPct: null,
    dailyAvailable: true,
    sources: SOURCE_LABELS,
    fetchedAt: new Date().toISOString(),
  };
  if (!/^[A-Z][A-Z0-9.\-/]{0,11}$/.test(upper)) return empty;

  const [settle, daily] = await Promise.all([
    getSettlements(upper).catch(() => ({ settlements: [], available: false })),
    getDailyShortPct(upper).catch(() => ({ row: null, available: false })),
  ]);

  return {
    ...empty,
    settlements: settle.settlements,
    consolidatedAvailable: settle.available,
    dailyShortPct: daily.row,
    dailyAvailable: daily.available,
    fetchedAt: new Date().toISOString(),
  };
}
