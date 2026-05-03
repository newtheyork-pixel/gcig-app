// Zillow Observed Rent Index (ZORI) feed.
//
// Why this matters: shelter is ~33% of CPI (the LARGEST single component).
// The BLS measures shelter via Owners' Equivalent Rent and tenant lease
// prices, both of which lag market rents by 6-12 months because they
// re-survey leases that were typically signed months ago. Zillow's ZORI
// uses asking rents on actively-listed units — it captures the marginal
// rent buyer's experience TODAY, leading BLS shelter by 6-12 months.
//
// Zillow Research publishes free CSVs at:
//   https://www.zillow.com/research/data/
// The national ZORI series filename has been stable as:
//   https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv
//
// CSV layout (Metro-level, "United States" is RegionID=102001 / RegionType=country):
//   RegionID,SizeRank,RegionName,RegionType,StateName,YYYY-MM-DD,YYYY-MM-DD,...
//   102001,0,United States,country,, 1234.5, 1245.6, ...
//
// We pull the United States row, parse the trailing date columns into a
// monthly time series, and compute YoY / MoM changes for the latest 36
// months. The Python nowcaster uses lag-0/6/12 of YoY to predict shelter.
//
// Cache: 6h. Zillow updates monthly, so 6h shields us from rate-limiting
// and reduces churn on Render.
//
// Fallback: if Zillow returns 404 / changes URL / parses badly, we fall
// back to FRED's CSUSHPISA (Case-Shiller National Home Price Index) as
// a (much weaker) proxy for housing momentum. Case-Shiller is monthly,
// freely available without an API key, and at least correlates with
// rental demand. We mark `usedFallback: true` and `source: 'case_shiller'`
// when this path is taken so the Python side knows to be honest about
// what it's actually using.

import https from 'node:https';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT_MS = 30_000;

// Pretend to be a normal browser. Zillow's CDN may return 403 to a
// generic UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Primary URL — Zillow's "smoothed, seasonally adjusted, all homes"
// national ZORI feed.
const ZORI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv';

// Fallback proxy: FRED's Case-Shiller National Home Price Index. This is
// served as a CSV without an API key from FRED's `fredgraph.csv` endpoint.
const CASE_SHILLER_URL =
  'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CSUSHPISA';

let cache = { at: 0, data: null };

// Generic CSV/text fetch with redirect support and a real-browser UA.
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const doGet = (target, hops) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = https.get(
        target,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'text/csv,text/plain,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            const loc = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, target).toString();
            return doGet(loc, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} on ${target}`));
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve(buf));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`timeout fetching ${target}`));
      });
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

// Minimal CSV row splitter. ZORI / Case-Shiller don't use embedded quotes
// or commas inside fields, so a plain split on `,` is safe. We strip CR
// to handle Windows line endings.
function splitCsvLine(line) {
  return line.replace(/\r$/, '').split(',');
}

// Parse a YYYY-MM-DD style header into a Date. Returns null if not a date.
function parseDateHeader(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-01`; // normalize to month-start
}

// Parse Zillow's national ZORI CSV. Returns an array of {date, level}
// sorted ascending by date, or null if parsing fails.
function parseZoriCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  // Find the index of the first date column. Zillow's metadata columns
  // come first (RegionID, SizeRank, RegionName, RegionType, StateName).
  const dateIdx = [];
  for (let i = 0; i < header.length; i++) {
    const d = parseDateHeader(header[i]);
    if (d) dateIdx.push({ i, date: d });
  }
  if (dateIdx.length < 13) return null;

  // Find column positions for RegionName / RegionType / SizeRank.
  let nameCol = -1;
  let typeCol = -1;
  let sizeRankCol = -1;
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (h === 'regionname') nameCol = i;
    else if (h === 'regiontype') typeCol = i;
    else if (h === 'sizerank') sizeRankCol = i;
  }
  if (nameCol < 0) return null;

  // Find the United States row. Zillow uses RegionType="country" and
  // RegionName="United States" for the national series. SizeRank=0 is
  // also a reliable selector.
  let usRow = null;
  for (let r = 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    if (cols.length < header.length) continue;
    const name = cols[nameCol];
    const type = typeCol >= 0 ? cols[typeCol] : '';
    const rank = sizeRankCol >= 0 ? cols[sizeRankCol] : '';
    if (
      name === 'United States' ||
      type === 'country' ||
      rank === '0'
    ) {
      usRow = cols;
      break;
    }
  }
  if (!usRow) return null;

  const out = [];
  for (const { i, date } of dateIdx) {
    const raw = usRow[i];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out.push({ date, level: n });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Parse FRED's `fredgraph.csv` for a single series. Format:
//   DATE,VALUE
//   2024-01-01,310.123
//   2024-02-01,.
// `.` = no observation. Returns array of {date, level} sorted ascending.
function parseFredGraphCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  if (header.length < 2) return null;
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    if (cols.length < 2) continue;
    const dateRaw = cols[0];
    const valRaw = cols[1];
    const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    if (valRaw === '.' || valRaw === '' || valRaw === undefined) continue;
    const n = Number(valRaw);
    if (!Number.isFinite(n)) continue;
    out.push({ date: `${m[1]}-${m[2]}-01`, level: n });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Compute YoY / MoM percent changes and trim to the latest `n` months.
function annotateHistory(series, n) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const indexed = series.map((p, i) => ({ ...p, idx: i }));
  const out = [];
  for (let i = 0; i < indexed.length; i++) {
    const cur = indexed[i];
    const prevMo = indexed[i - 1];
    const prevYr = indexed[i - 12];
    const mom =
      prevMo && prevMo.level > 0
        ? ((cur.level / prevMo.level) - 1) * 100
        : null;
    const yoy =
      prevYr && prevYr.level > 0
        ? ((cur.level / prevYr.level) - 1) * 100
        : null;
    out.push({
      date: cur.date,
      level: Number(cur.level.toFixed(4)),
      yoy: yoy === null ? null : Number(yoy.toFixed(4)),
      mom: mom === null ? null : Number(mom.toFixed(4)),
    });
  }
  // Keep only the trailing n months — but we need yoy populated, so we
  // don't trim before computing YoY.
  return out.slice(-n);
}

// Public: returns
//   {
//     ok: true,
//     fetchedAt: ISO,
//     source: 'zillow_zori' | 'case_shiller',
//     usedFallback: bool,
//     history: [{date, level, yoy, mom}, ...]   // up to 36 months
//   }
// On total failure:
//   { ok: false, fetchedAt: ISO, source: null, usedFallback: false,
//     history: [], error: '...' }
export async function getZillowRent({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const fetchedAt = new Date().toISOString();
  let zoriErr = null;

  // 1) Try Zillow ZORI.
  try {
    const raw = await fetchText(ZORI_URL);
    const series = parseZoriCsv(raw);
    if (!series || series.length < 13) {
      throw new Error(
        `ZORI parse returned ${series ? series.length : 'null'} points`,
      );
    }
    const history = annotateHistory(series, 36);
    const data = {
      ok: true,
      fetchedAt,
      source: 'zillow_zori',
      usedFallback: false,
      history,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    zoriErr = err.message || String(err);
    console.warn('zillowFeed: ZORI scrape failed —', zoriErr);
  }

  // 2) Fallback: Case-Shiller via FRED CSV.
  try {
    const raw = await fetchText(CASE_SHILLER_URL);
    const series = parseFredGraphCsv(raw);
    if (!series || series.length < 13) {
      throw new Error(
        `Case-Shiller parse returned ${series ? series.length : 'null'} points`,
      );
    }
    const history = annotateHistory(series, 36);
    const data = {
      ok: true,
      fetchedAt,
      source: 'case_shiller',
      usedFallback: true,
      history,
      zoriError: zoriErr,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn('zillowFeed: Case-Shiller fallback failed —', err.message);
    const data = {
      ok: false,
      fetchedAt,
      source: null,
      usedFallback: false,
      history: [],
      error: `zori: ${zoriErr || 'n/a'}; caseShiller: ${err.message}`,
    };
    // Cache the failure briefly so we recover quickly when the upstream
    // is back up.
    cache = { at: Date.now() - (CACHE_TTL_MS - 5 * 60 * 1000), data };
    return data;
  }
}
