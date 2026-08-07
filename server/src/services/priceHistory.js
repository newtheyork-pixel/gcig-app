import prisma from '../db.js';

// Daily price-bar cache. Powers the Terminal GP chart and any future
// time-series feature (screener, total return, COMP overlays).
//
// Strategy:
//   - Lazy 5y backfill on first request for an unknown ticker.
//   - Read-through cache on subsequent requests: if the most recent
//     bar in the DB is from today (or the most recent trading day),
//     we serve from DB. Otherwise we top up from the upstream.
//   - Daily cron (see index.js) refreshes the universe at 21:00 ET so
//     the next morning's reads are warm.
//
// NASDAQ's public historical endpoint (api.nasdaq.com) is the upstream
// here. Yahoo's /v8/finance/chart used to be the go-to but it rate-
// limits Render's egress IPs aggressively, so even the first backfill
// returns 429 and the chart panel never paints. NASDAQ tolerates
// datacenter IPs, doesn't require a key, and returns the same OHLCV
// surface (just stringy — "$298.21" / "35,324,920" — so we parse).
// Two asset-class buckets are exposed: `stocks` and `etf`. We try
// stocks first and fall back to etf, since most tickers in our
// universe are common equities.

const HTTP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VALID_RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const VALID_INTERVALS = new Set(['1d', '5d', '1wk', '1mo']);

// How fresh is fresh enough before we top-up the cache?
// 18 hours: serves all weekend traffic from cache; weekday morning
// triggers a top-up to pull in yesterday's close.
const FRESHNESS_MS = 18 * 60 * 60 * 1000;

function startOfDayUTC(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function rangeToCutoff(range) {
  const now = Date.now();
  switch (range) {
    case '1mo': return new Date(now - 31 * 86400_000);
    case '3mo': return new Date(now - 95 * 86400_000);
    case '6mo': return new Date(now - 190 * 86400_000);
    case '1y':  return new Date(now - 372 * 86400_000);
    case '2y':  return new Date(now - 740 * 86400_000);
    case '5y':  return new Date(now - 1830 * 86400_000);
    case '10y': return new Date(now - 3660 * 86400_000);
    case 'ytd': {
      const d = new Date();
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'max':
    default:    return new Date(0);
  }
}

// Strip "$1,234.56" → 1234.56. Returns null if the cell is blank or
// "N/A", which NASDAQ uses for missing intraday fields on bonus days.
function parseMoney(s) {
  if (s == null) return null;
  const t = String(s).replace(/[$,\s]/g, '');
  if (!t || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Strip "12,345,678" → 12345678 (returns null for empty cells).
function parseInt0(s) {
  if (s == null) return null;
  const t = String(s).replace(/[,\s]/g, '');
  if (!t || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function rangeStart(range) {
  // NASDAQ wants explicit fromdate/todate; map our range bucket to a
  // start date a touch wider than needed so trading-day boundaries
  // never trim the response short.
  const cutoff = rangeToCutoff(range);
  return cutoff.toISOString().slice(0, 10);
}

// Pull from NASDAQ for one asset-class bucket. Returns null on 404 so
// the caller can retry the other bucket; other failures throw.
async function fetchNasdaqRows(ticker, range, assetclass) {
  const today = new Date().toISOString().slice(0, 10);
  const from = rangeStart(range);
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical` +
    `?assetclass=${assetclass}&fromdate=${from}&todate=${today}&limit=9999`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': HTTP_UA,
      Accept: 'application/json, text/plain, */*',
      // NASDAQ's edge sometimes 403s requests without a plausible
      // Referer/Origin pair. These match what their own site sends.
      Referer: 'https://www.nasdaq.com/',
      Origin: 'https://www.nasdaq.com',
    },
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) return null;
    const err = new Error(`NASDAQ HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  const code = json?.status?.rCode;
  // rCode 200 is success; anything else (typically 400 = "bad asset
  // class") is treated as "wrong bucket, try the other one".
  if (code !== 200) return null;
  const rawRows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rawRows)) return null;
  return rawRows;
}

// Fetch + parse one range from NASDAQ, trying the equities bucket
// first and ETFs second. Returns parsed bar rows; throws 404 when
// neither bucket knows the symbol.
async function fetchNasdaqBars(ticker, range) {
  let raw = await fetchNasdaqRows(ticker, range, 'stocks');
  if (raw == null || raw.length === 0) {
    raw = await fetchNasdaqRows(ticker, range, 'etf');
  }
  if (raw == null) {
    const e = new Error('Ticker not found');
    e.status = 404;
    throw e;
  }

  const rows = [];
  for (const r of raw) {
    // NASDAQ dates come back as MM/DD/YYYY in en-US format.
    const m = String(r.date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const close = parseMoney(r.close);
    if (close == null) continue;
    const date = startOfDayUTC(new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])));
    const vol = parseInt0(r.volume);
    rows.push({
      ticker,
      date,
      open: parseMoney(r.open),
      high: parseMoney(r.high),
      low: parseMoney(r.low),
      close,
      adjClose: close,
      volume: vol != null ? BigInt(vol) : null,
      source: 'nasdaq',
    });
  }
  return rows;
}

// A close that moved after the fact is not a price update, it is a
// restatement: NASDAQ back-adjusts the whole series on a split or
// dividend adjustment, so the bars stored last month describe a share
// that no longer exists. Appending fresh bars onto the old series
// would manufacture a cliff at the splice date — a 10-for-1 split
// reads as a 90% crash. Returns the first mismatch (for the log line)
// or null. 0.5% is far above float noise and far below any real
// corporate action. Exported for the colocated suite — pure, no DB.
export function detectRestatement(fetched, stored, tolerance = 0.005) {
  const key = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
  const prior = new Map();
  for (const b of stored || []) {
    if (b && b.close != null) prior.set(key(b.date), b.close);
  }
  for (const r of fetched || []) {
    if (!r || r.close == null) continue;
    const old = prior.get(key(r.date));
    if (old == null || !(old > 0)) continue;
    if (Math.abs(r.close - old) / old > tolerance) {
      return { date: key(r.date), stored: old, fetched: r.close };
    }
  }
  return null;
}

// Pull from NASDAQ and upsert. Returns the number of rows written.
// `interval` is accepted for signature compatibility; NASDAQ only
// serves daily, so weekly buckets are downsampled at read time.
async function fetchNasdaqAndStore(ticker, range = '5y', interval = '1d') {
  if (!VALID_RANGES.has(range)) range = '5y';
  if (!VALID_INTERVALS.has(interval)) interval = '1d';

  let rows = await fetchNasdaqBars(ticker, range);
  if (rows.length === 0) return 0;

  // Where the fetch overlaps bars already stored, the closes must
  // agree. If they don't, the stored history is stale (restated after
  // a split/adjustment) — wipe it and take the full series fresh
  // rather than appending a discontinuity.
  const minDate = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
  const stored = await prisma.priceBar.findMany({
    where: { ticker, date: { gte: minDate } },
    select: { date: true, close: true },
  });
  const restated = detectRestatement(rows, stored);
  if (restated) {
    console.warn(
      `priceHistory(${ticker}): close on ${restated.date} restated ` +
        `${restated.stored} -> ${restated.fetched} — wiping stale series and re-backfilling`
    );
    await prisma.priceBar.deleteMany({ where: { ticker } });
    rows = await fetchNasdaqBars(ticker, 'max');
    if (rows.length === 0) return 0;
  }

  // Upsert one bar at a time. Prisma doesn't expose ON CONFLICT-batched
  // updates for SQLite/Postgres uniformly, but the row count is small
  // enough that per-row upsert is fine in practice.
  for (const r of rows) {
    await prisma.priceBar.upsert({
      where: { ticker_date: { ticker: r.ticker, date: r.date } },
      create: r,
      update: {
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        adjClose: r.adjClose,
        volume: r.volume,
        source: 'nasdaq',
        fetchedAt: new Date(),
      },
    });
  }

  return rows.length;
}

// Size a top-up to the actual hole. A fixed '1mo' pull assumes the
// series went stale yesterday; a ticker nobody has charted since
// spring has a season-long gap that a month of bars would silently
// bridge with one long line. Thresholds sit a few days inside
// rangeToCutoff's windows so the chosen range always reaches past the
// newest stored bar; a gap beyond every range means a full backfill.
// Exported for the colocated suite — pure, no DB.
export function rangeForGap(newestBarDate) {
  const gapDays = (Date.now() - new Date(newestBarDate).getTime()) / 86400_000;
  if (gapDays <= 25) return '1mo';
  if (gapDays <= 85) return '3mo';
  if (gapDays <= 180) return '6mo';
  if (gapDays <= 360) return '1y';
  if (gapDays <= 730) return '2y';
  if (gapDays <= 1820) return '5y';
  if (gapDays <= 3650) return '10y';
  return 'max';
}

// Public: read history from cache. Backfills if missing or stale.
// Returns array of { date (ISO string), open, high, low, close, adjClose, volume }.
export async function getHistory(rawTicker, range = '6mo') {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const err = new Error('Invalid ticker');
    err.status = 400;
    throw err;
  }
  if (!VALID_RANGES.has(range)) range = '6mo';

  // Check current cache state.
  const latest = await prisma.priceBar.findFirst({
    where: { ticker },
    orderBy: { date: 'desc' },
    select: { date: true, fetchedAt: true },
  });

  const isEmpty = !latest;
  const isStale = latest && Date.now() - latest.fetchedAt.getTime() > FRESHNESS_MS;

  if (isEmpty) {
    // First sighting of this ticker — backfill 5y so future range
    // requests up to 5y are served from cache.
    try {
      await fetchNasdaqAndStore(ticker, '5y', '1d');
    } catch (err) {
      if (err.status === 404) {
        const e = new Error('Ticker not found');
        e.status = 404;
        throw e;
      }
      // Other failures: degrade to whatever we have (nothing) rather
      // than throwing — caller can decide to retry or fall back to a
      // direct fetch.
      console.warn(`priceHistory(${ticker}) backfill failed:`, err.message);
    }
  } else if (isStale) {
    // Top up with a pull sized to the gap — a month when the series
    // went stale yesterday, wider when the ticker sat unrequested —
    // so we neither blow the rate budget on a full 5y refetch nor
    // leave a hole behind a fixed month. The unique index dedupes
    // overlapping bars.
    try {
      await fetchNasdaqAndStore(ticker, rangeForGap(latest.date), '1d');
    } catch (err) {
      console.warn(`priceHistory(${ticker}) top-up failed:`, err.message);
    }
  }

  const cutoff = rangeToCutoff(range);
  const bars = await prisma.priceBar.findMany({
    where: { ticker, date: { gte: cutoff } },
    orderBy: { date: 'asc' },
    select: { date: true, open: true, high: true, low: true, close: true, adjClose: true, volume: true },
  });

  return bars.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    adjClose: b.adjClose,
    volume: b.volume != null ? Number(b.volume) : null,
  }));
}

// ── Intraday (GIP) ────────────────────────────────────────────────────
// NASDAQ's chart endpoint returns the current session as ~1-minute
// points (epoch-ms timestamp + price), pre- and post-market included,
// alongside the day's quote header (last, previous close, volume). This
// is the one place we want *intraday* rather than the daily PriceBar
// cache, so it bypasses the DB entirely — intraday is ephemeral. A short
// in-memory cache keeps a burst of GIP polls off NASDAQ's edge.
const intradayCache = new Map(); // ticker → { at, value }
const INTRADAY_TTL_MS = 45 * 1000;

function parsePct(s) {
  if (s == null) return null;
  const t = String(s).replace(/[%\s+]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n / 100 : null;
}

async function fetchNasdaqChart(ticker, assetclass) {
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/chart?assetclass=${assetclass}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': HTTP_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nasdaq.com/',
      Origin: 'https://www.nasdaq.com',
    },
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) return null;
    const e = new Error(`NASDAQ chart HTTP ${res.status}`);
    e.status = 502;
    throw e;
  }
  const json = await res.json();
  if (json?.status?.rCode !== 200) return null;
  if (!Array.isArray(json?.data?.chart)) return null;
  return json.data;
}

// Public: today's intraday line for a ticker. Returns the session points
// plus a quote header; throws { status } on a bad ticker / upstream miss.
export async function getIntraday(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const e = new Error('Invalid ticker');
    e.status = 400;
    throw e;
  }
  const hit = intradayCache.get(ticker);
  if (hit && Date.now() - hit.at < INTRADAY_TTL_MS) return hit.value;

  // Equities first, ETFs as the fallback bucket — same split the daily
  // path uses.
  let data = await fetchNasdaqChart(ticker, 'stocks');
  if (!data) data = await fetchNasdaqChart(ticker, 'etf');
  if (!data) {
    const e = new Error('Ticker not found');
    e.status = 404;
    throw e;
  }

  const points = [];
  for (const c of data.chart) {
    const price = Number(c?.y);
    const t = Number(c?.x);
    if (!Number.isFinite(price) || !Number.isFinite(t)) continue;
    points.push({ t, price });
  }
  const last = parseMoney(data.lastSalePrice);
  const prevClose = parseMoney(data.previousClose);
  const value = {
    ticker,
    company: data.company || null,
    exchange: data.exchange || null,
    asOf: data.timeAsOf || null,
    last,
    prevClose,
    netChange: last != null && prevClose != null ? last - prevClose : parseMoney(data.netChange),
    pctChange: last != null && prevClose ? (last - prevClose) / prevClose : parsePct(data.percentageChange),
    volume: parseInt0(data.volume),
    points,
  };
  intradayCache.set(ticker, { at: Date.now(), value });
  return value;
}

// Universe = distinct tickers we already have any bars for. Cron job
// refreshes all of them nightly. Empty on a fresh DB; grows naturally
// as users hit GP for new tickers.
export async function getTrackedTickers() {
  const rows = await prisma.priceBar.groupBy({
    by: ['ticker'],
    _count: { ticker: true },
  });
  return rows.map((r) => r.ticker);
}

// Cron entry point: top-up the latest bar for every tracked ticker.
// Throttled to avoid Yahoo rate-limiting (one request every 250ms).
export async function refreshUniverse() {
  const tickers = await getTrackedTickers();
  let ok = 0;
  let failed = 0;
  for (const ticker of tickers) {
    try {
      // Same gap-sizing as the read path: the nightly run usually needs
      // a month, but a ticker the cron missed for a stretch (redeploy
      // gaps, upstream outages) needs however much it actually missed.
      const latest = await prisma.priceBar.findFirst({
        where: { ticker },
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      await fetchNasdaqAndStore(ticker, latest ? rangeForGap(latest.date) : '5y', '1d');
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`refreshUniverse(${ticker}) failed:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { tickers: tickers.length, ok, failed };
}
