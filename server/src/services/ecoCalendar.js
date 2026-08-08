// ECO — the economic calendar behind the terminal's ECO panel. Two
// halves, both from the St. Louis Fed's FRED API (free, keyed, same
// key fredMacro.js already rides):
//
//   UPCOMING — /fred/releases/dates over [today, today+14d]. For this
//     endpoint the realtime window bounds the release dates themselves
//     (its default realtime_start is the first day of the current year,
//     not "today" like the rest of the API), and
//     include_release_dates_with_no_data=true is what admits FUTURE
//     scheduled dates — the source has entered the date but no numbers
//     exist yet, which is precisely what a calendar wants. Sort order
//     defaults to DESC here, so asc is pinned explicitly.
//
//   RECENT PRINTS — latest value + prior for a fixed set of high-signal
//     series, through fredMacro's getFredSeries so the observation
//     cache is shared with the factor panel.
//
// Honesty rules, learned from the rest of the terminal:
//   - FRED carries no consensus/forecast numbers. Every upcoming row
//     ships forecast: null and the UI renders a dash — a fabricated
//     "consensus" would be worse than none.
//   - FOMC meeting dates are NOT a FRED release, so they are omitted
//     rather than guessed. The Fed press-release wire in newsFeeds.js
//     carries the actual rate announcements into /terminal/top-news;
//     the closest thing here is H.15 Selected Interest Rates, which is
//     watched as the FOMC-adjacent release.
//   - getEcoCalendar never throws, and a failed build is cached
//     backdated (~2 min to live) so one timed-out minute doesn't pin
//     an empty calendar up for a full hour.

import { getFredSeries } from './fredMacro.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const FAILURE_TTL_MS = 2 * 60 * 1000; // failed builds retire early
let cache = { at: 0, data: null };

// Release id → name map from /fred/releases. Release names change on
// roughly geological timescales, so a week is generous; a fetch
// failure keeps serving the stale map rather than blanking names.
const NAMES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
let namesCache = { at: 0, byId: null };

const UPCOMING_WINDOW_DAYS = 14;

let lastRawSample = [];
export function _lastRawSample() {
  return lastRawSample;
}

// The releases a stock club actually plans around. Matched against
// FRED's own release names — anchored, because FRED also publishes
// "Gross Domestic Product by Industry" and a start-only GDP pattern
// would sweep it in. Everything not matched still returns, tagged
// watched: false, and the UI keeps it behind a "show all" flag.
//
// H.15 (Selected Interest Rates) is the FOMC-adjacent entry: FOMC
// meeting dates themselves are not a FRED release and are deliberately
// absent — the Fed wire in newsFeeds.js carries the announcements.
const WATCHED_PATTERNS = [
  /^employment situation$/i,
  /^consumer price index$/i,
  /^producer price index$/i,
  /^gross domestic product$/i,
  /^personal income and outlays$/i, // PCE, the Fed's preferred gauge
  /^advance monthly sales for retail/i, // "…and Food Services" = Retail Sales
  /^h\.15 selected interest rates$/i,
  /^surveys of consumers$/i, // U. Michigan consumer sentiment
  /^new residential construction$/i, // housing starts & permits
  /^g\.17 industrial production/i, // "…and Capacity Utilization"
  /^unemployment insurance weekly claims/i,
];

export function isWatched(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return WATCHED_PATTERNS.some((re) => re.test(n));
}

// The fixed prints set. `yoy: true` means the level is meaningless to
// a reader (nobody quotes the CPI index at 314.2) and the year-over-
// year change is computed instead. `days` sizes the observation
// window: enough history for a latest + prior at the series' cadence,
// and 14+ months for the YoY pair.
const PRINT_SERIES = [
  { series: 'ICSA', label: 'Initial Jobless Claims', unit: 'claims', days: 45 },
  { series: 'CPIAUCSL', label: 'CPI YoY', unit: '%', days: 430, yoy: true },
  { series: 'UNRATE', label: 'Unemployment Rate', unit: '%', days: 100 },
  { series: 'T10Y2Y', label: '10Y-2Y Treasury Spread', unit: '%', days: 21 },
  { series: 'BAMLH0A0HYM2', label: 'High Yield Spread (OAS)', unit: '%', days: 21 },
  { series: 'NFCI', label: 'Chicago Fed Financial Conditions', unit: '', days: 45 },
];

// Same fetch discipline as fredMacro: bounded by a timeout, warns and
// returns null on any failure — null (not {}) so callers can tell
// "FRED failed" from "FRED answered with nothing".
async function fetchFredJson(path, params) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({ api_key: key, file_type: 'json', ...params });
  const url = `${FRED_BASE}${path}?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`FRED ${path} responded ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`FRED ${path} fetch failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getReleaseNames() {
  if (namesCache.byId && Date.now() - namesCache.at < NAMES_TTL_MS) {
    return namesCache.byId;
  }
  const json = await fetchFredJson('/releases', { limit: '1000' });
  const releases = Array.isArray(json?.releases) ? json.releases : null;
  if (!releases) return namesCache.byId || {}; // stale beats blank
  const byId = {};
  for (const r of releases) {
    if (r && r.id != null && typeof r.name === 'string') byId[r.id] = r.name;
  }
  namesCache = { at: Date.now(), byId };
  return byId;
}

// Pure transform from FRED's /releases/dates payload to the panel's
// row model — separated from the fetch so the suite can pin it to a
// fixture. Clamps to [start, end] defensively even though the request
// already bounds the realtime window (ISO dates compare correctly as
// strings), dedupes id+date repeats, and sorts date-ascending with
// watched releases leading within a day. Every row carries
// forecast: null — FRED has no consensus numbers and we do not invent
// them; the UI renders the null as a dash.
export function transformReleaseDates(payload, { start, end, nameById = {} } = {}) {
  const rows = Array.isArray(payload?.release_dates) ? payload.release_dates : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.date !== 'string' || !row.date) continue;
    const date = row.date.slice(0, 10);
    if (start && date < start) continue;
    if (end && date > end) continue;
    const release =
      (typeof row.release_name === 'string' && row.release_name.trim()) ||
      nameById[row.release_id] ||
      (row.release_id != null ? `Release ${row.release_id}` : null);
    if (!release) continue;
    const key = `${row.release_id ?? release}:${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      releaseId: row.release_id ?? null,
      release,
      watched: isWatched(release),
      forecast: null, // FRED carries no consensus — see header comment
    });
  }
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.watched !== b.watched) return a.watched ? -1 : 1;
    return a.release < b.release ? -1 : a.release > b.release ? 1 : 0;
  });
  return out;
}

async function getUpcoming() {
  const start = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + UPCOMING_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [nameById, payload] = await Promise.all([
    getReleaseNames(),
    fetchFredJson('/releases/dates', {
      include_release_dates_with_no_data: 'true',
      realtime_start: start,
      realtime_end: end,
      order_by: 'release_date',
      sort_order: 'asc',
      limit: '1000',
    }),
  ]);
  // null = the fetch failed (vs. an honest empty window) — the caller
  // uses that to backdate the cache so the retry comes soon.
  if (payload == null) return { rows: [], failed: true };
  const rows = transformReleaseDates(payload, { start, end, nameById });
  // Kept beside the transform so a shape drift upstream is one curl
  // away from visible instead of a guessing game: what FRED actually
  // sent, trimmed.
  lastRawSample = (payload.release_dates || payload.releaseDates || []).slice(0, 3);
  return { rows, failed: false };
}

// Latest + prior from an oldest-first observation feed (getFredSeries'
// contract). Nulls, never throws — a series FRED failed on renders as
// dashes in a visible row rather than silently vanishing from the
// table, same reasoning as the news wires' per-feed roll call.
export function latestAndPrior(observations) {
  const obs = Array.isArray(observations) ? observations : [];
  if (obs.length === 0) return { value: null, prior: null, date: null };
  const latest = obs[obs.length - 1];
  const prior = obs.length > 1 ? obs[obs.length - 2] : null;
  return {
    value: latest.value,
    prior: prior ? prior.value : null,
    date: latest.date,
  };
}

// Year-over-year percent change from an oldest-first MONTHLY feed.
// The year-ago reading is matched by calendar month (YYYY-MM minus 12),
// never by array offset — a publication gap would silently shift an
// offset-based lookup onto the wrong month. `prior` is the previous
// month's YoY, so the panel can show which way inflation is walking.
// Rounded to 2dp here so the payload is what anyone would quote.
export function computeYoY(observations) {
  const obs = Array.isArray(observations) ? observations : [];
  if (obs.length === 0) return { value: null, prior: null, date: null };
  const byMonth = new Map();
  for (const o of obs) {
    if (!o || typeof o.date !== 'string' || !Number.isFinite(o.value)) continue;
    byMonth.set(o.date.slice(0, 7), o);
  }
  const yearAgoKey = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${String(y - 1).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  };
  const yoyFor = (o) => {
    const ago = byMonth.get(yearAgoKey(o.date.slice(0, 7)));
    if (!ago || !Number.isFinite(ago.value) || ago.value === 0) return null;
    return Number((((o.value - ago.value) / ago.value) * 100).toFixed(2));
  };
  const latest = obs[obs.length - 1];
  const value = yoyFor(latest);
  if (value == null) return { value: null, prior: null, date: null };
  const prev = obs.length > 1 ? obs[obs.length - 2] : null;
  return {
    value,
    prior: prev ? yoyFor(prev) : null,
    date: latest.date,
  };
}

async function getPrints() {
  const results = await Promise.all(
    PRINT_SERIES.map(async (s) => {
      const obs = await getFredSeries(s.series, { days: s.days });
      const stat = s.yoy ? computeYoY(obs) : latestAndPrior(obs);
      return {
        series: s.series,
        label: s.label,
        unit: s.unit,
        value: stat.value,
        prior: stat.prior,
        date: stat.date,
      };
    })
  );
  return results;
}

// The panel's whole payload:
//   { configured, upcoming: [{date, release, watched, forecast}],
//     prints: [{series, label, value, prior, date, unit}], fetchedAt }
// Never throws. 1h cache; a build where the calendar fetch failed is
// cached backdated so it retires in ~2 minutes instead of standing
// for the hour. configured:false is the honest empty when the server
// has no FRED_API_KEY — the panel says so instead of showing a
// suspiciously quiet fortnight.
export async function getEcoCalendar({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  try {
    if (!process.env.FRED_API_KEY) {
      const out = { configured: false, upcoming: [], prints: [], fetchedAt: null };
      cache = { at: Date.now(), data: out };
      return out;
    }
    const [upcoming, prints] = await Promise.all([getUpcoming(), getPrints()]);
    const out = {
      configured: true,
      upcoming: upcoming.rows,
      // Empty-because-quiet and empty-because-the-fetch-died must not
      // look alike — the house rule every panel lives by, and the flag
      // that let the first production miss be diagnosed from a curl.
      upcomingFailed: upcoming.failed === true,
      prints,
      fetchedAt: new Date().toISOString(),
    };
    cache = {
      at: upcoming.failed
        ? Date.now() - CACHE_TTL_MS + FAILURE_TTL_MS
        : Date.now(),
      data: out,
    };
    return out;
  } catch (err) {
    // Belt and braces — the halves already degrade internally, but a
    // route must never 500 because a calendar was unavailable.
    console.warn('ECO calendar build failed:', err.message);
    const out = cache.data || {
      configured: Boolean(process.env.FRED_API_KEY),
      upcoming: [],
      prints: [],
      fetchedAt: null,
    };
    cache = { at: Date.now() - CACHE_TTL_MS + FAILURE_TTL_MS, data: out };
    return out;
  }
}

// Test-only resets so suites don't bleed cached payloads into each
// other. Mirrors fredMacro's _resetFredSeriesCache.
export function _resetEcoCache() {
  cache = { at: 0, data: null };
  namesCache = { at: 0, byId: null };
}
