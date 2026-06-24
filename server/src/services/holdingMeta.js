import prisma from '../db.js';

// Fills in a holding's company name + sector from Finnhub when a trade created
// it with just a ticker. Settlement stays network-free (no slow calls inside a
// DB transaction), so this runs as a cheap follow-up — fire-and-forget after a
// trade, and as a self-healing pass on portfolio reads. Best-effort: no key or
// a Finnhub hiccup just leaves the name as the ticker rather than erroring.
const FINNHUB = 'https://finnhub.io/api/v1';
const TIMEOUT_MS = 8000;

// Curated metadata for tickers Finnhub doesn't classify — chiefly ETFs, whose
// company profiles carry no sector. Takes precedence over Finnhub during
// enrichment. Mirrors how the sheet labeled broad ETFs ("Multi-Sector"). Add
// rows here as the club buys new funds.
const STATIC_META = {
  SCHD: { name: 'Schwab US Dividend Equity ETF', sector: 'Multi-Sector' },
  VOO: { name: 'Vanguard S&P 500 ETF', sector: 'Multi-Sector' },
  QQQ: { name: 'Invesco QQQ Trust, Series 1', sector: 'Information Technology' },
  VGT: { name: 'Vanguard Information Technology Index Fund ETF', sector: 'Information Technology' },
  ROBO: { name: 'ROBO Global Robotics and Automation Index ETF', sector: 'Industrials' },
  SHLD: { name: 'Global X Defense Tech ETF', sector: 'Industrials' },
};

export async function fetchTickerProfile(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const p = await res.json();
    const name = p?.name || null;
    const sector = p?.finnhubIndustry || null;
    if (!name && !sector) return null; // unknown symbol / empty profile
    return { name, sector };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Module-level guard so overlapping reads/trades don't all kick off a pass at
// once — one runs, the rest no-op.
let running = false;

// Fill name/sector for every open holding that's missing them (name absent or
// equal to the ticker, or sector absent). Rate-limited in small chunks to stay
// inside Finnhub's free tier. Returns { updated }. Never throws.
export async function enrichHoldingsMeta() {
  if (running) return { updated: 0, skipped: true };
  running = true;
  try {
    const holdings = await prisma.holding.findMany({ where: { closedAt: null, isCash: false } });
    const needs = holdings.filter((h) => !h.name || h.name === h.ticker || !h.sector);
    let updated = 0;
    const CHUNK = 6;
    for (let i = 0; i < needs.length; i += CHUNK) {
      const slice = needs.slice(i, i + CHUNK);
      // Only hit Finnhub for tickers the static map doesn't fully cover.
      const profiles = await Promise.all(
        slice.map((h) => (STATIC_META[h.ticker]?.name && STATIC_META[h.ticker]?.sector ? null : fetchTickerProfile(h.ticker)))
      );
      for (let k = 0; k < slice.length; k++) {
        const h = slice[k];
        const stat = STATIC_META[h.ticker] || {};
        const prof = profiles[k] || {};
        const name = stat.name || prof.name || null; // curated first, Finnhub fallback
        const sector = stat.sector || prof.sector || null;
        const data = {};
        if ((!h.name || h.name === h.ticker) && name) data.name = name;
        if (!h.sector && sector) data.sector = sector;
        if (Object.keys(data).length) {
          await prisma.holding.update({ where: { ticker: h.ticker }, data }).catch(() => {});
          updated += 1;
        }
      }
    }
    return { updated };
  } catch {
    return { updated: 0 };
  } finally {
    running = false;
  }
}

// Does any open holding still need a name/sector? Cheap check for the read path
// to decide whether to kick off a background pass.
export async function holdingsNeedMeta() {
  const holdings = await prisma.holding.findMany({
    where: { closedAt: null, isCash: false },
    select: { ticker: true, name: true, sector: true },
  });
  return holdings.some((h) => !h.name || h.name === h.ticker || !h.sector);
}
