// Cleveland Fed Inflation Nowcast scraper.
//
// The Cleveland Fed publishes a daily-updated inflation nowcast at:
//   https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting
//
// The HTML page renders charts via FusionCharts that read JSON data from
// these (publicly served) static files:
//   /-/media/files/webcharts/inflationnowcasting/nowcast_month.json
//   /-/media/files/webcharts/inflationnowcasting/nowcast_year.json
//
// Each JSON is a list of chart objects, one per (year, month). Each chart
// has a `subcaption` like "2026-4", a `_comment` carrying the asOf date,
// and a `dataset` list with named series:
//   "CPI Inflation"          — headline CPI nowcast (MoM% on month JSON,
//                              YoY% on year JSON)
//   "Core CPI Inflation"     — core CPI nowcast
//   "PCE Inflation"          — headline PCE
//   "Core PCE Inflation"     — core PCE
//   "Actual CPI Inflation"   — once BLS releases, the realized number
// Each series's `data` array aligns 1:1 with `categories[0].category`
// (the daily timeline). Empty-string `value` means "no nowcast for that
// day" (CPI nowcasts aren't published every day in the early part of the
// month). The last non-empty entry is the current nowcast for that month.
//
// We extract the LATEST nowcast for the current month (last chart that
// matches the asOf comment's month) and the next month if Cleveland is
// already publishing it (their nowcast for next month typically appears
// on the day BLS releases the prior month's CPI).
//
// Cache: 1h. Cleveland updates daily, so 1h is plenty fresh and shields
// us from rate-limiting if a downstream client polls aggressively.
//
// Scraping is wrapped in try/except. If the JSON shape changes or fetch
// fails, we return an empty result with `ok: false` rather than throwing
// — the Python side falls back to using the FRED median CPI proxy.

import https from 'node:https';

const BASE = 'https://www.clevelandfed.org';
const MONTH_JSON = '/-/media/files/webcharts/inflationnowcasting/nowcast_month.json?sc_lang=en';
const YEAR_JSON = '/-/media/files/webcharts/inflationnowcasting/nowcast_year.json?sc_lang=en';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 20_000;

// Pretend to be a normal browser. The Cleveland Fed CDN returns 403 to
// generic scripted UA strings (fetch/curl default), but accepts a
// real-looking Chrome UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cache = { at: 0, data: null };

function fetchText(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${path}`;
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        // Follow simple redirects (Cleveland Fed sometimes 301s the path).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE}${res.headers.location}`;
          // Recurse via a fresh https.get on the absolute URL.
          https
            .get(
              loc,
              {
                headers: {
                  'User-Agent': UA,
                  Accept: 'application/json,text/plain,*/*',
                },
                timeout: REQUEST_TIMEOUT_MS,
              },
              (res2) => {
                if (res2.statusCode !== 200) {
                  res2.resume();
                  return reject(new Error(`HTTP ${res2.statusCode} on ${loc}`));
                }
                let buf = '';
                res2.setEncoding('utf8');
                res2.on('data', (c) => (buf += c));
                res2.on('end', () => resolve(buf));
              },
            )
            .on('error', reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(buf));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

// Parse "YYYY-M" or "YYYY-MM" subcaption -> "YYYY-MM".
function normalizeSubcaption(sub) {
  if (typeof sub !== 'string') return null;
  const m = sub.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const yyyy = m[1];
  const mm = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

// Last numeric value in a `data` array. Each entry is `{value, tooltext}`
// where `value` is either a numeric string or "" (meaning "no nowcast on
// this day"). Returns null if no numeric values are present.
function lastNumericValue(dataArr) {
  if (!Array.isArray(dataArr)) return null;
  for (let i = dataArr.length - 1; i >= 0; i--) {
    const raw = dataArr[i]?.value;
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Extract { headline, core } MoM or YoY for one chart object.
function extractFromChart(chart) {
  const out = { headline: null, core: null };
  if (!chart || !Array.isArray(chart.dataset)) return out;
  for (const ds of chart.dataset) {
    if (!ds || typeof ds.seriesname !== 'string') continue;
    const name = ds.seriesname;
    // Strip "Inflation" suffix and trim
    const v = lastNumericValue(ds.data);
    if (v === null) continue;
    if (name === 'CPI Inflation') {
      out.headline = v;
    } else if (name === 'Core CPI Inflation') {
      out.core = v;
    }
  }
  return out;
}

// Pick the chart entries for current month and next month from the parsed
// JSON list. We trust the order (Cleveland's JSON is sorted ascending) and
// keep the LAST chart that has any CPI nowcast value present, plus the
// chart immediately after it (next month) if that exists and also has
// nowcast values.
function pickCurrentAndNext(charts) {
  // Walk from the end. The very last chart can be a single-day stub
  // (e.g., subcaption "2026-5" with only "05/01" entry). We treat any
  // chart that has a non-null headline nowcast as candidate.
  const candidates = [];
  for (let i = charts.length - 1; i >= 0 && candidates.length < 6; i--) {
    const ch = charts[i];
    const sub = normalizeSubcaption(ch?.chart?.subcaption);
    if (!sub) continue;
    const ext = extractFromChart(ch);
    if (ext.headline === null && ext.core === null) continue;
    candidates.push({ idx: i, sub, ext });
  }
  if (candidates.length === 0) return { current: null, next: null };
  // The most-recent month with values is `current`. If a more-recent month
  // also has values, the most-recent IS the next month forecast.
  // Cleveland's convention: while still in month M, they publish a nowcast
  // for M (current month). Once BLS releases M, they additionally publish
  // for M+1 (next month). When both are present, candidates[0] is M+1
  // and candidates[1] is M.
  candidates.sort((a, b) => b.idx - a.idx);
  const newest = candidates[0];
  const second = candidates[1] ?? null;
  // Heuristic: "current" is the prior calendar month if the newest stub
  // has only 1-2 days of data; otherwise "current" is the newest.
  // Practically: if both newest and second exist, treat newest as next
  // and second as current. If only newest exists, treat it as current.
  if (second) {
    return { current: second, next: newest };
  }
  return { current: newest, next: null };
}

// Build a historical archive: for each chart whose subcaption is a valid
// YYYY-MM, extract the nowcast value at "around day-N" of that month.
// We look for the LATEST data point inside the target month with day <= N.
// This mirrors what would have been published during real-time forecasting:
// "what was Cleveland's CPI nowcast on day N of month M?"
//
// Returns a map keyed by "YYYY-MM" -> {headline, core} for each available
// chart. Entries with both values null are dropped.
function buildHistoricalAtDay(charts, day) {
  const out = {};
  if (!Array.isArray(charts)) return out;
  for (const ch of charts) {
    const sub = normalizeSubcaption(ch?.chart?.subcaption);
    if (!sub) continue;
    const targetMo = parseInt(sub.slice(5, 7), 10);
    const cats = ch?.categories?.[0]?.category;
    if (!Array.isArray(cats)) continue;
    // Index of the latest in-month label whose dd <= day
    let bestIdx = -1;
    for (let i = 0; i < cats.length; i++) {
      const lbl = cats[i]?.label;
      if (typeof lbl !== 'string' || !lbl.includes('/')) continue;
      const parts = lbl.split('/');
      if (parts.length !== 2) continue;
      const mm = parseInt(parts[0], 10);
      const dd = parseInt(parts[1], 10);
      if (!Number.isFinite(mm) || !Number.isFinite(dd)) continue;
      if (mm !== targetMo) continue;
      if (dd <= day) bestIdx = i;
      else break;
    }
    if (bestIdx < 0) continue;
    let head = null;
    let core = null;
    for (const ds of ch.dataset || []) {
      if (!Array.isArray(ds.data) || bestIdx >= ds.data.length) continue;
      const raw = ds.data[bestIdx]?.value;
      if (raw === '' || raw === null || raw === undefined) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (ds.seriesname === 'CPI Inflation') head = n;
      else if (ds.seriesname === 'Core CPI Inflation') core = n;
    }
    if (head !== null || core !== null) {
      out[sub] = { headline: head, core };
    }
  }
  return out;
}

// Combine MoM + YoY extracts into the response shape the user expects.
function combine(monthCharts, yearCharts) {
  const m = pickCurrentAndNext(monthCharts);
  const y = pickCurrentAndNext(yearCharts);

  function pack(monthEntry, yearEntry) {
    if (!monthEntry && !yearEntry) return null;
    return {
      yoy: yearEntry?.ext?.headline ?? null,
      mom: monthEntry?.ext?.headline ?? null,
      coreYoy: yearEntry?.ext?.core ?? null,
      coreMom: monthEntry?.ext?.core ?? null,
      month: monthEntry?.sub ?? yearEntry?.sub ?? null,
    };
  }

  const cur = pack(m.current, y.current);
  const nxt = pack(m.next, y.next);

  // Reshape to user-requested form: { headline, core } each with currentMonth
  // and nextMonth.
  const headline = {};
  const core = {};
  if (cur) {
    headline.currentMonth = { yoy: cur.yoy, mom: cur.mom, month: cur.month };
    core.currentMonth = { yoy: cur.coreYoy, mom: cur.coreMom, month: cur.month };
  }
  if (nxt) {
    headline.nextMonth = { yoy: nxt.yoy, mom: nxt.mom, month: nxt.month };
    core.nextMonth = { yoy: nxt.coreYoy, mom: nxt.coreMom, month: nxt.month };
  }
  return { headline, core };
}

// Extract the "as of" date that Cleveland stamps on each chart's
// `_comment` field (e.g. "2026-05-01 00:00"). Take the maximum across all
// charts as a defensive measure.
function extractAsOf(charts) {
  let best = null;
  for (const ch of charts) {
    const c = ch?.chart?._comment;
    if (typeof c !== 'string') continue;
    const m = c.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const ymd = `${m[1]}-${m[2]}-${m[3]}`;
    if (best === null || ymd > best) best = ymd;
  }
  return best;
}

// Public: returns
//   {
//     ok: true,
//     fetchedAt: ISO,
//     asOfDate: "YYYY-MM-DD" | null,
//     headline: { currentMonth?: {yoy, mom, month}, nextMonth?: {...} },
//     core:     { currentMonth?: {yoy, mom, month}, nextMonth?: {...} },
//   }
// On parse/fetch failure:
//   { ok: false, fetchedAt: ISO, asOfDate: null, headline: {}, core: {}, error: "..." }
export async function getClevelandNowcast({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const fetchedAt = new Date().toISOString();
  try {
    // Parallel fetch of both data feeds.
    const [monthRaw, yearRaw] = await Promise.all([
      fetchText(MONTH_JSON),
      fetchText(YEAR_JSON),
    ]);
    let monthData;
    let yearData;
    try {
      monthData = JSON.parse(monthRaw);
    } catch (e) {
      throw new Error(`month JSON parse failed: ${e.message}`);
    }
    try {
      yearData = JSON.parse(yearRaw);
    } catch (e) {
      throw new Error(`year JSON parse failed: ${e.message}`);
    }
    if (!Array.isArray(monthData) || !Array.isArray(yearData)) {
      throw new Error('unexpected JSON shape (not arrays)');
    }

    const { headline, core } = combine(monthData, yearData);
    const asOfDate = extractAsOf(monthData) || extractAsOf(yearData);

    // Historical archive of "what Cleveland's nowcast was on day-20 of
    // each past month". Used by the Python backtest to add Cleveland's
    // nowcast as a feature for prior cuts. Day-20 is the typical nowcast
    // as-of for our quantile_rich strategy.
    const histAtDay20Mom = buildHistoricalAtDay(monthData, 20);
    const histAtDay20Yoy = buildHistoricalAtDay(yearData, 20);
    const historical = {};
    const allMonths = new Set([
      ...Object.keys(histAtDay20Mom),
      ...Object.keys(histAtDay20Yoy),
    ]);
    for (const mo of allMonths) {
      historical[mo] = {
        mom: histAtDay20Mom[mo]?.headline ?? null,
        coreMom: histAtDay20Mom[mo]?.core ?? null,
        yoy: histAtDay20Yoy[mo]?.headline ?? null,
        coreYoy: histAtDay20Yoy[mo]?.core ?? null,
      };
    }

    const data = {
      ok: true,
      fetchedAt,
      asOfDate,
      headline,
      core,
      historical, // map: "YYYY-MM" -> {mom, coreMom, yoy, coreYoy} at day-20
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn('clevelandNowcast: scrape failed —', err.message);
    // Return shape but with empty data so the API can still respond 200
    // and the Python side gracefully falls back.
    const data = {
      ok: false,
      fetchedAt,
      asOfDate: null,
      headline: {},
      core: {},
      historical: {},
      error: err.message,
    };
    // Cache the failure too — but only briefly (5 min) so we recover quickly
    // when Cleveland's site is back up.
    cache = { at: Date.now() - (CACHE_TTL_MS - 5 * 60 * 1000), data };
    return data;
  }
}
