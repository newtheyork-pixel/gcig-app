// Truflation US CPI Inflation Index scraper.
//
// Truflation publishes a daily-updated, blockchain-verified US inflation
// index. They claim it leads the BLS headline CPI print by ~30 days, so
// it's a strong candidate as a feature in our nowcaster.
//
// The marketing site (https://truflation.com/marketplace/us-inflation-rate)
// is a Nuxt SPA. The dashboard SPA fetches from these PUBLIC, KEY-FREE
// proxy endpoints on truflation.com itself (it proxies the underlying
// api.truflation.com calls server-side so the API key stays on Nuxt):
//
//   GET https://truflation.com/api/index-data/us-inflation-rate
//        -> { index: ["YYYY-MM-DD", ...],
//             truflation_us_cpi_frozen_yoy: [<percent>, ...],
//             start_date: "..." }
//        ~6000 daily entries from 2010-01-01 onward, the YoY% headline
//        inflation rate (e.g. 1.81 means +1.81%).
//
//   GET https://truflation.com/api/index-data/us-inflation-rate-raw
//        -> { index: ["YYYY-MM-DD", ...],
//             truflation_us_cpi_frozen_index: [<level>, ...] }
//        Same dates, but as the LEVEL of the index (base 100 in 2010),
//        which lets us compute MoM% server-side.
//
// We hit BOTH (in parallel) because the level data lets us derive MoM,
// which is the metric the BLS publishes and the one our model trains on.
//
// Cache: 1h. Truflation updates daily, so 1h is plenty fresh.
//
// On any failure we return `{ ok: false }` with empty fields. The Python
// side gracefully degrades to its base feature set.

import https from 'node:https';

const BASE = 'https://truflation.com';
const YOY_PATH = '/api/index-data/us-inflation-rate';
const LEVEL_PATH = '/api/index-data/us-inflation-rate-raw';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 25_000;
const HISTORY_DAYS = 60; // last 60 daily YoY observations

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cache = { at: 0, data: null };

// Plain GET with a normal-looking UA. The Nuxt server in front of truflation.com
// returns 404 on bare path matches but accepts these proxy slugs.
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
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE}${res.headers.location}`;
          https
            .get(
              loc,
              { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' }, timeout: REQUEST_TIMEOUT_MS },
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

// Parse the {index: [...], <metric>: [...]} shape into [[date, value], ...]
// Returns rows sorted by date ascending; entries with non-finite values
// are dropped.
function parsePairs(raw, valueKey) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.index) || !Array.isArray(parsed[valueKey])) {
    throw new Error(`unexpected shape (no index/${valueKey} arrays)`);
  }
  const dates = parsed.index;
  const vals = parsed[valueKey];
  const n = Math.min(dates.length, vals.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = String(dates[i] || '').slice(0, 10);
    const v = Number(vals[i]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!Number.isFinite(v)) continue;
    rows.push([d, v]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

// Build a date->level map so we can compute MoM = (today_level / prior_eom_level - 1)*100.
function indexByDate(rows) {
  const m = new Map();
  for (const [d, v] of rows) m.set(d, v);
  return m;
}

// First trading day on/before the given YYYY-MM-DD anchor. If the anchor
// itself is in the index, returns it. Used to find the level on a target
// date by walking back through weekends/missing days.
function levelOnOrBefore(byDate, ymd) {
  let d = ymd;
  for (let k = 0; k < 14; k++) {
    if (byDate.has(d)) return { date: d, value: byDate.get(d) };
    // Decrement one day in plain string math.
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    d = dt.toISOString().slice(0, 10);
  }
  return null;
}

// Given the latest level, compute MoM% relative to the level on the last
// day of the prior calendar month.
function computeMom(byDate, asOfYmd) {
  const today = byDate.get(asOfYmd);
  if (!Number.isFinite(today)) return null;
  // Last day of prior month
  const dt = new Date(`${asOfYmd}T00:00:00Z`);
  dt.setUTCDate(1);
  dt.setUTCDate(0); // -> last day of prior month
  const priorEom = dt.toISOString().slice(0, 10);
  const prior = levelOnOrBefore(byDate, priorEom);
  if (!prior || !Number.isFinite(prior.value) || prior.value === 0) return null;
  return (today / prior.value - 1.0) * 100.0;
}

// Public: fetch + cache. Returns the documented response shape.
export async function getTruflationFeed({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const fetchedAt = new Date().toISOString();
  try {
    // Parallel fetch — independent endpoints.
    const [yoyRaw, levelRaw] = await Promise.all([
      fetchText(YOY_PATH),
      fetchText(LEVEL_PATH),
    ]);
    const yoyRows = parsePairs(yoyRaw, 'truflation_us_cpi_frozen_yoy');
    const levelRows = parsePairs(levelRaw, 'truflation_us_cpi_frozen_index');
    if (yoyRows.length === 0) throw new Error('empty YoY series');

    const asOfDate = yoyRows[yoyRows.length - 1][0];
    const yoy = yoyRows[yoyRows.length - 1][1];

    // MoM from levels (preferred). Falls back to YoY-diff if level series
    // missing.
    let mom = null;
    if (levelRows.length > 0) {
      const byDate = indexByDate(levelRows);
      mom = computeMom(byDate, asOfDate);
    }

    // Build last-N daily history for the python client.
    const cutoffIdx = Math.max(0, yoyRows.length - HISTORY_DAYS);
    const history = yoyRows.slice(cutoffIdx).map(([date, val]) => ({
      date,
      yoy: val,
    }));

    // Also expose the FULL series — the Python side trains on month-end
    // YoY values per backtest cut, so it needs more than 60 days. We pack
    // it under `seriesYoy` keyed by date for cheap lookup.
    const seriesYoy = {};
    for (const [d, v] of yoyRows) seriesYoy[d] = v;
    const seriesLevel = {};
    for (const [d, v] of levelRows) seriesLevel[d] = v;

    const data = {
      ok: true,
      fetchedAt,
      asOfDate,
      yoy: Number.isFinite(yoy) ? Number(yoy) : null,
      mom: Number.isFinite(mom) ? Number(mom) : null,
      history,
      seriesYoy,    // map "YYYY-MM-DD" -> yoy% (full history, ~6000 days)
      seriesLevel,  // map "YYYY-MM-DD" -> level (base 100), full history
      source: 'truflation.com/api/index-data',
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn('truflationFeed: fetch failed —', err.message);
    const data = {
      ok: false,
      fetchedAt,
      asOfDate: null,
      yoy: null,
      mom: null,
      history: [],
      seriesYoy: {},
      seriesLevel: {},
      error: err.message,
    };
    // Cache failure briefly (5 min) so we recover quickly.
    cache = { at: Date.now() - (CACHE_TTL_MS - 5 * 60 * 1000), data };
    return data;
  }
}
