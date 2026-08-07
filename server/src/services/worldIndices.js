// WEI data. Yahoo's quote *and* chart endpoints both rate-limit/403
// from Render's datacenter IP (same class of block as the GSAM PDF
// issue), so the World Indices panel went blank no matter how we
// called Yahoo. Stooq's keyless light-CSV endpoint works fine from
// datacenter IPs and — with the `p` field — carries last *and* prior
// close in a single batched request, enough to derive the day move.
// The handful of indices Stooq doesn't expose for free fall back to
// Finnhub (already our quote/news provider) via a liquid US-listed
// proxy ETF; the ETF's %-move tracks the index closely even though its
// absolute level differs, so those rows are flagged `approx`.

const FINNHUB_URL = 'https://finnhub.io/api/v1/quote';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// `yahoo` is the index's own symbol; `proxy` is a fund that tracks it,
// used only when the index itself cannot be read (verified against the
// null where Stooq has no free feed). `proxy` is the Finnhub ETF stand-in
// used only when Stooq misses. Array order is render order.
export const WORLD_INDICES = [
  { name: 'S&P 500', region: 'Americas', yahoo: '^GSPC', fred: 'SP500', proxy: 'SPY' },
  { name: 'Dow Jones Industrial', region: 'Americas', yahoo: '^DJI', fred: 'DJIA', proxy: 'DIA' },
  { name: 'Nasdaq Composite', region: 'Americas', yahoo: '^IXIC', fred: 'NASDAQCOM', proxy: 'ONEQ' },
  { name: 'Russell 2000', region: 'Americas', yahoo: '^RUT', proxy: 'IWM' },
  { name: 'S&P/TSX Composite', region: 'Americas', yahoo: '^GSPTSE', proxy: 'EWC' },
  { name: 'Bovespa', region: 'Americas', yahoo: '^BVSP', proxy: 'EWZ' },
  { name: 'Euro Stoxx 50', region: 'EMEA', yahoo: '^STOXX50E', proxy: 'FEZ' },
  { name: 'FTSE 100', region: 'EMEA', yahoo: '^FTSE', proxy: 'EWU' },
  { name: 'CAC 40', region: 'EMEA', yahoo: '^FCHI', proxy: 'EWQ' },
  { name: 'DAX', region: 'EMEA', yahoo: '^GDAXI', proxy: 'EWG' },
  { name: 'IBEX 35', region: 'EMEA', yahoo: '^IBEX', proxy: 'EWP' },
  { name: 'FTSE MIB', region: 'EMEA', yahoo: 'FTSEMIB.MI', proxy: 'EWI' },
  { name: 'OMX Stockholm 30', region: 'EMEA', yahoo: '^OMX', proxy: 'EWD' },
  { name: 'Swiss Market', region: 'EMEA', yahoo: '^SSMI', proxy: 'EWL' },
  { name: 'Nikkei 225', region: 'Asia-Pacific', yahoo: '^N225', proxy: 'EWJ' },
  { name: 'Hang Seng', region: 'Asia-Pacific', yahoo: '^HSI', proxy: 'EWH' },
  { name: 'CSI 300', region: 'Asia-Pacific', yahoo: '000300.SS', proxy: 'FXI' },
  { name: 'S&P/ASX 200', region: 'Asia-Pacific', yahoo: '^AXJO', proxy: 'EWA' },
  { name: 'Nifty 50', region: 'Asia-Pacific', yahoo: '^NSEI', proxy: 'INDA' },
  { name: 'KOSPI', region: 'Asia-Pacific', yahoo: '^KS11', proxy: 'EWY' },
  { name: 'CBOE Volatility', region: 'Volatility', yahoo: '^VIX', fred: 'VIXCLS', proxy: 'VIXY' },
];

export const REGION_ORDER = ['Americas', 'EMEA', 'Asia-Pacific', 'Volatility'];

const CACHE_TTL_MS = 60_000;
let cache = null; // { at, rows }

// CSV header: Symbol,Date,Time,Open,High,Low,Close,Volume,Prev
// Unknown symbols come back as a row of "N/D" — Number() makes those
// NaN, which we drop so they cleanly fall through to the proxy.
/// The index itself, from Yahoo's chart endpoint.
///
/// This exists because the panel was showing SPY's share price under the
/// heading "S&P 500" — 747 where the index is near 7,500. Stooq was the
/// real source and its quote endpoint now 404s on every symbol, so every
/// row silently fell through to an ETF proxy. A proxy tracks the index's
/// PERCENTAGE well and its LEVEL not at all, and a wrong number under
/// the right name is worse than a dash.
///
/// The chart endpoint is used rather than the quote one because quote
/// requires a crumb cookie and answers 429 from a datacenter; chart
/// needs neither and carries both the last price and the prior close in
/// its meta block.
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

async function fetchIndexLevel(symbol, deps = {}) {
  const doFetch = deps.fetch || fetch;
  // Yahoo answers a burst with 429 and recovers in seconds. Twenty-one
  // symbols IS a burst, so one patient retry turns a half-empty panel
  // into a full one — and giving up here means falling back to an ETF
  // proxy, which is the wrong number rather than a missing one.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      // range=1d, because chartPreviousClose is the close before the
      // WINDOW: ask for 2d and "prev" is two sessions back, which
      // doubles up the day move. quotes.js makes the same call with 1d
      // for the same reason.
      const r = await doFetch(
        `${CHART_URL}/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
        { signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } }
      );
      if (r.status === 429 || r.status >= 500) {
        clearTimeout(timer);
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
          continue;
        }
        return null;
      }
      if (!r.ok) return null;
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      const last = Number(meta?.regularMarketPrice);
      if (!Number.isFinite(last)) return null;
      const prevRaw = meta?.chartPreviousClose ?? meta?.previousClose;
      const prev = Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : null;
      return { last, prev, currency: meta?.currency || null };
    } catch {
      if (attempt >= 2) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}


/// The index level from FRED, where FRED publishes it.
///
/// Yahoo's chart endpoint gives every index we want and works from a
/// laptop; it does not work from Render. Measured across three cache
/// cycles in production: zero real levels, eighteen proxies. That is the
/// same datacenter block the GSAM scraper and Yahoo's profile endpoint
/// already hit, and no retry fixes an IP.
///
/// FRED does work from Render — the macro strip has used it for months —
/// and publishes the US headline indices. It is a DAILY CLOSE, not a
/// live tick, and that trade is the right way round: a correct level one
/// close old beats a live number that belongs to a different instrument.
/// The intraday percentage still comes from the proxy, which tracks the
/// move faithfully even though its level does not.
async function fetchFredLevel(seriesId, deps = {}) {
  const key = process.env.FRED_API_KEY;
  if (!key || !seriesId) return null;
  const doFetch = deps.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await doFetch(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}`
      + `&api_key=${key}&file_type=json&sort_order=desc&limit=6`,
      { signal: controller.signal }
    );
    if (!r.ok) return null;
    const obs = (await r.json())?.observations;
    if (!Array.isArray(obs)) return null;
    // FRED writes "." for a day the series did not publish.
    const pts = obs
      .map((o) => ({ date: o.date, val: Number(o.value) }))
      .filter((o) => Number.isFinite(o.val));
    if (!pts.length) return null;
    return { last: pts[0].val, prev: pts[1]?.val ?? null, asOf: pts[0].date };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/// A handful at a time. Twenty-one sequential requests is a slow panel
/// and twenty-one at once is a rate limit.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

async function fetchFinnhubProxy(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${FINNHUB_URL}?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    // Finnhub: c=current, d=change, dp=%change, pc=prev close.
    // c===0 is Finnhub's "no data" sentinel for unknown symbols.
    if (!j || j.c == null || j.c === 0) return null;
    return { last: j.c, change: j.d ?? null, changePercent: j.dp ?? null };
  } catch {
    return null;
  }
}

// One row per index, Stooq first then the Finnhub proxy. A total miss
// still returns a stub so the panel renders "—" rather than failing.
export async function getWorldIndices(deps = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  // The index level first, always. The ETF proxy is a fallback and is
  // marked as one — it tracks the percentage and not the level, so a
  // reader has to be able to tell which number they are looking at.
  // Yahoo first because it is live and covers everything; FRED second
  // because it is authoritative and actually reachable from here.
  const levels = await mapLimited(WORLD_INDICES, 3, async (idx) => {
    const live = idx.yahoo ? await fetchIndexLevel(idx.yahoo, deps) : null;
    if (live) return { ...live, via: 'yahoo' };
    const fred = await (deps.fetchFred || fetchFredLevel)(idx.fred, deps);
    return fred ? { ...fred, via: 'fred' } : null;
  });

  const rows = await Promise.all(
    WORLD_INDICES.map(async (idx, n) => {
      const base = { name: idx.name, region: idx.region };
      const hit = levels[n];
      if (hit) {
        let change = hit.prev != null ? hit.last - hit.prev : null;
        // A FRED level is a close, so its own percentage is yesterday's
        // move. The proxy's percentage is today's and tracks the index
        // faithfully — so the row carries the right LEVEL from one
        // source and the right MOVE from the other, and says so.
        let pct = change != null && hit.prev ? (change / hit.prev) * 100 : null;
        let moveFrom = hit.via;
        if (hit.via === 'fred' && idx.proxy) {
          const live = await (deps.fetchProxy || fetchFinnhubProxy)(idx.proxy);
          if (live?.changePercent != null) {
            pct = live.changePercent;
            moveFrom = `finnhub:${idx.proxy}`;
            // The point change must follow the percentage it now sits
            // beside. Leaving FRED's day-old point move next to the
            // proxy's live percentage let the pair disagree in sign on
            // a reversal day. Re-derive it from the level we show:
            // prev = last / (1 + pct/100), change = last - prev.
            change =
              Number.isFinite(hit.last) && pct !== -100
                ? (hit.last * pct) / (100 + pct)
                : null;
          }
        }
        return {
          ...base,
          symbol: idx.yahoo || idx.fred,
          last: hit.last,
          change,
          changePercent: pct,
          currency: hit.currency ?? null,
          asOf: hit.asOf ?? null,
          source: hit.via,
          moveSource: moveFrom,
          // The level is the index's own. Nothing here is a fund price.
          approx: false,
        };
      }

      if (idx.proxy) {
        const p = await (deps.fetchProxy || fetchFinnhubProxy)(idx.proxy);
        if (p && p.last != null) {
          return {
            ...base,
            symbol: idx.proxy,
            last: p.last,
            change: p.change,
            changePercent: p.changePercent,
            source: `finnhub:${idx.proxy}`,
            // The panel MUST render this differently. It is the share
            // price of a fund that tracks the index, not the index, and
            // printing it plainly under the index's name is the bug
            // this whole rewrite exists to fix.
            approx: true,
          };
        }
      }

      return {
        ...base,
        symbol: idx.yahoo || idx.proxy || '',
        last: null,
        change: null,
        changePercent: null,
        source: null,
        approx: false,
      };
    })
  );

  cache = { at: Date.now(), rows };
  return rows;
}

