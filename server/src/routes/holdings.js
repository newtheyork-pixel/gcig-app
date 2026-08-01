import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import YahooFinance from 'yahoo-finance2';
// yahoo-finance2 v2.14 ships the class as the default export; instantiate once.
// Only `quote` / `autoc` are exposed — profile/sector data is fetched via a
// direct HTTP call to Yahoo's quoteSummary endpoint below.
const yahooFinance = new YahooFinance();

// Finnhub is our primary data source when FINNHUB_API_KEY is configured.
// Free tier: 60 calls/min, real-time US quotes, company profile included.
async function fetchFinnhub(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const base = 'https://finnhub.io/api/v1';
  try {
    const [quoteRes, profileRes, metricRes] = await Promise.all([
      fetch(`${base}/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`),
      fetch(`${base}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`),
      fetch(`${base}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`),
    ]);
    if (!quoteRes.ok) return null;
    const [q, profile, metric] = await Promise.all([
      quoteRes.json(),
      profileRes.ok ? profileRes.json() : {},
      metricRes.ok ? metricRes.json() : {},
    ]);
    // Finnhub returns c=0 for unknown tickers.
    if (!q || !q.c) return null;
    const m = metric?.metric || {};
    return {
      ticker,
      name: profile?.name || ticker,
      exchange: profile?.exchange || null,
      currency: profile?.currency || 'USD',
      sector: profile?.finnhubIndustry || null,
      industry: profile?.finnhubIndustry || null,
      website: profile?.weburl || null,
      summary: null, // Finnhub profile2 has no business summary on free tier
      employees: null,
      country: profile?.country || null,
      price: q.c,
      previousClose: q.pc,
      dayHigh: q.h,
      dayLow: q.l,
      fiftyTwoWeekHigh: m['52WeekHigh'] ?? null,
      fiftyTwoWeekLow: m['52WeekLow'] ?? null,
      // Finnhub returns marketCapitalization in millions.
      marketCap:
        profile?.marketCapitalization != null
          ? profile.marketCapitalization * 1e6
          : null,
      trailingPE: m.peBasicExclExtraTTM ?? m.peInclExtraTTM ?? null,
      forwardPE: m.peNormalizedAnnual ?? null,
      dividendYield:
        m.currentDividendYieldTTM != null
          ? m.currentDividendYieldTTM / 100
          : null,
      beta: m.beta ?? null,
      volume: null,
      avgVolume: m['10DayAverageTradingVolume']
        ? m['10DayAverageTradingVolume'] * 1e6
        : null,
      _source: 'finnhub',
    };
  } catch (err) {
    console.warn(`finnhub(${ticker}) failed:`, err.message);
    return null;
  }
}

// Fallback: Yahoo's v8 chart endpoint returns meta with current price + previous
// close + 52w range WITHOUT needing a crumb. Used if the library's quote() call
// fails because of rate limiting / cookie issues.
async function fetchChartMeta(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json?.chart?.result?.[0]?.meta || null;
  } catch {
    return null;
  }
}

// Fetch profile/sector/summary from Yahoo's public quoteSummary endpoint.
// This is a best-effort call; Yahoo sometimes returns 401 without a crumb,
// in which case we return null and the caller falls back to quote-only data.
async function fetchQuoteSummary(ticker) {
  const modules = 'summaryProfile,summaryDetail,price,defaultKeyStatistics';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json?.quoteSummary?.result?.[0] || null;
  } catch {
    return null;
  }
}
import prisma from '../db.js';
import { verifyJwt, requireSuperAdmin, requireRole } from '../middleware/auth.js';
import { getSheetPortfolio, withResolvedDayChange } from '../services/sheetPortfolio.js';
import { getNewsForTicker, extractArticle } from '../services/news.js';
import { getBusinessProfile } from '../services/secBusinessSummary.js';
import { tickerWhere, groupByTicker } from '../services/tickerKey.js';
import { buildScoreboard, summarize } from '../services/decisionRecord.js';
import { computeTally } from './votes.js';
import { getCompanyIdentity } from '../services/secFilings.js';
import {
  generateRiskCommentary,
  detectThesisDrift,
  checkThesisAgainstNews,
} from '../services/riskCommentary.js';
import {
  getUpcomingEarnings,
  getUpcomingEarningsBatch,
  getAnalystConsensus,
} from '../services/marketData.js';
import { getRecentFilings } from '../services/secFilings.js';
import { computeCashInterest } from '../services/cashInterest.js';
import { scrapeAndStoreDailyRates } from '../services/gsamRates.js';
import { backfillFgtxxFromEdgar } from '../services/secNmfp.js';
import {
  recomputeHoldingFromLots,
  getCashBalance,
  executeDirectTrade,
  executeBulkTrades,
  TradeExecutionError,
} from '../services/tradeExecution.js';
import { importFromSheet, PortfolioImportError } from '../services/portfolioImport.js';
import { enrichHoldingsMeta } from '../services/holdingMeta.js';
import { getHistory } from '../services/priceHistory.js';
import {
  computeSnapshotCorrections,
  computeSnapshotRebuild,
  makeCloseLookup,
} from '../services/snapshotReconcile.js';

const router = Router();

// Constant-time secret compare — avoids leaking the secret a byte at a time via
// response timing, consistent with the sea/cpi/docusign ingest checks.
function secretMatches(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Tiny in-memory cache so clicking the same ticker twice doesn't hammer Yahoo.
// 15-minute TTL — fundamentals don't change intraday. Bounded so a member
// iterating distinct ticker strings can't grow it without limit (the cache is
// keyed per ticker, which otherwise defeats both the cache and memory).
const tickerCache = new Map();
const TICKER_TTL_MS = 15 * 60 * 1000;
const TICKER_CACHE_MAX = 500;
function setTickerCache(key, value) {
  if (tickerCache.size >= TICKER_CACHE_MAX) {
    tickerCache.delete(tickerCache.keys().next().value); // evict oldest (insertion order)
  }
  tickerCache.set(key, value);
}

// Per-member limiter on the routes that fan out to Finnhub/Yahoo/EDGAR/LLM per
// distinct ticker — the global 200/min is too loose to protect Finnhub's
// 60/min free tier from one member iterating tickers. Runs after verifyJwt, so
// it keys per user (falls back to IP).
const tickerDataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `ticker-data:${req.user?.id || req.ip}`,
  message: { error: 'Too many ticker lookups — slow down and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Machine-to-machine endpoint for the daily cron. Authed via shared secret,
// NOT JWT. Mounted before verifyJwt so no user login is needed.
router.post('/snapshot/daily', async (req, res) => {
  if (!secretMatches(req.headers['x-cron-secret'], process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  try {
    // Skip the 20-min memory cache so the cron always gets a fresh read of
    // the sheet (otherwise a user who opened the page 15 min earlier could
    // freeze today's snapshot at pre-close prices).
    const data = await getSheetPortfolio({ forceFresh: true });
    if (data.totals.totalValue <= 0) {
      return res.status(400).json({ error: 'Sheet returned zero total value' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const snap = await prisma.portfolioSnapshot.upsert({
      where: { date: today },
      update: {
        totalValue: data.totals.totalValue,
        cashValue: data.totals.cashValue,
      },
      create: {
        date: today,
        totalValue: data.totals.totalValue,
        cashValue: data.totals.cashValue,
      },
    });
    res.json({
      ok: true,
      date: snap.date,
      totalValue: snap.totalValue,
      cashValue: snap.cashValue,
    });
  } catch (err) {
    // This endpoint precedes verifyJwt, so a reflected err.message could leak
    // internals (the private sheet id, Prisma errors) to an unauthenticated
    // caller. Log the detail, return a generic message.
    console.error('Daily snapshot cron failed:', err.message);
    res.status(500).json({ error: 'Snapshot failed' });
  }
});

router.use(verifyJwt);

// Live portfolio pulled from the club's Google Sheet.
// The sheet IS the source of truth — the local Holding table is unused
// in this mode.

// The DES description, and the corporate particulars Bloomberg prints
// beside it.
//
// Two sources with two different jobs. The 10-K's Item 1 supplies the
// prose and the facts a company states about itself in it; the
// submissions feed supplies head office, industry code and fiscal year
// end, which are FIELDS and therefore cannot be misread the way a
// sentence can. Both are best-effort — a description is worth waiting a
// moment for, but never worth failing a live quote over.
async function describeCompany(ticker, data) {
  const [profile, identity] = await Promise.all([
    getBusinessProfile(ticker).catch(() => null),
    getCompanyIdentity(ticker).catch(() => null),
  ]);
  const out = { ...data };
  if (!out.summary && profile?.summary) out.summary = profile.summary;
  if (profile?.summary) {
    // Where the words came from, so a reader can go and check them.
    out.summarySource = { form: '10-K', filedAt: profile.filedAt, url: profile.url };
  }
  // A vendor headcount, where one exists, beats our extraction; ours
  // fills the gap rather than overwriting anybody.
  if (out.employees == null && profile?.employees != null) out.employees = profile.employees;
  if (profile?.founded != null) out.founded = profile.founded;
  if (identity) {
    out.headquarters = identity.headquarters ?? null;
    out.street = identity.street ?? null;
    out.phone = identity.phone ?? null;
    out.sicDescription = identity.sicDescription ?? null;
    out.fiscalYearEnd = identity.fiscalYearEnd ?? null;
    out.stateOfIncorporation = identity.stateOfIncorporation ?? null;
    out.formerNames = identity.formerNames ?? [];
    out.legalName = identity.legalName ?? null;
    out.cik = identity.cik ?? null;
    if (!out.exchange && identity.exchanges?.length) out.exchange = identity.exchanges.join(', ');
  }
  return out;
}

router.get('/quotes', async (_req, res) => {
  try {
    const raw = await getSheetPortfolio();
    // The sheet's day-change cells are formulas and are frequently blank
    // — twelve of thirteen positions on the day this was found — which
    // left the holdings table showing a dash for almost every row. Fill
    // from a live quote where it can.
    const data = { ...raw, holdings: await withResolvedDayChange(raw.holdings) };

    // Write a daily snapshot for today from the sheet total + cash.
    if (data.totals.totalValue > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await prisma.portfolioSnapshot.upsert({
        where: { date: today },
        update: {
          totalValue: data.totals.totalValue,
          cashValue: data.totals.cashValue,
        },
        create: {
          date: today,
          totalValue: data.totals.totalValue,
          cashValue: data.totals.cashValue,
        },
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Sheet portfolio error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Fetch basic company/quote info for a ticker from Yahoo Finance.
// Used by the portfolio holding detail modal.
router.get('/info/:ticker', tickerDataLimiter, async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  // Tickers are ASCII letters, digits, dot, dash (e.g. BRK.B, RDS-A). Reject anything else.
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const cached = tickerCache.get(raw);
  if (cached && Date.now() - cached.at < TICKER_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    // Primary: Finnhub (reliable, real-time, no rate-limit issues).
    if (process.env.FINNHUB_API_KEY) {
      const finnhubData = await fetchFinnhub(raw);
      if (finnhubData) {
        // Finnhub's free tier has no business summary, so DES would
        // render quote + brief with no prose. Yahoo's profile endpoint is
        // the obvious source but it's 429/401-blocked from datacenter IPs
        // (the same wall as the GSAM scraper). EDGAR's 10-K Item 1 is
        // reachable from Render; use it. Best-effort and cached a week —
        // never let it block the live quote we already have.
        const enriched = await describeCompany(raw, finnhubData);
        setTickerCache(raw, { at: Date.now(), data: enriched });
        return res.json(enriched);
      }
    }

    // Fallback: Yahoo Finance. Yahoo rate-limits aggressively on the crumb
    // endpoint, so we also try chart meta + quoteSummary directly.
    const opts = { validateResult: false };
    const [quoteResult, summaryResult, chartResult] = await Promise.allSettled([
      yahooFinance.quote(raw, {}, opts),
      fetchQuoteSummary(raw),
      fetchChartMeta(raw),
    ]);
    let quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    const chartMeta = chartResult.status === 'fulfilled' ? chartResult.value : null;
    if (quoteResult.status === 'rejected') {
      console.warn(`yahoo quote(${raw}) failed:`, quoteResult.reason?.message);
    }

    // If the library's quote failed (often rate-limited crumb), synthesize a
    // minimal quote object from the chart meta so the modal still renders
    // price, prev close, 52w range, exchange.
    if (!quote && chartMeta) {
      quote = {
        longName: chartMeta.longName || chartMeta.shortName,
        shortName: chartMeta.shortName,
        fullExchangeName: chartMeta.fullExchangeName || chartMeta.exchangeName,
        currency: chartMeta.currency,
        regularMarketPrice: chartMeta.regularMarketPrice,
        regularMarketPreviousClose:
          chartMeta.chartPreviousClose ?? chartMeta.previousClose,
        regularMarketDayHigh: chartMeta.regularMarketDayHigh,
        regularMarketDayLow: chartMeta.regularMarketDayLow,
        fiftyTwoWeekHigh: chartMeta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: chartMeta.fiftyTwoWeekLow,
        regularMarketVolume: chartMeta.regularMarketVolume,
      };
    }

    if (!quote && !summary) {
      const reason = quoteResult.reason?.message || 'Ticker not found';
      return res.status(404).json({ error: reason });
    }

    const profile = summary?.summaryProfile || {};
    const detail = summary?.summaryDetail || {};
    const price = summary?.price || {};
    const stats = summary?.defaultKeyStatistics || {};

    // Yahoo wraps numbers as { raw: 12345, fmt: "12.3K" } — unwrap .raw.
    const r = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);

    let data = {
      ticker: raw,
      name:
        quote?.longName ||
        quote?.shortName ||
        r(price?.longName) ||
        r(price?.shortName) ||
        raw,
      exchange: quote?.fullExchangeName || r(price?.exchangeName) || null,
      currency: quote?.currency || r(price?.currency) || 'USD',
      sector: profile.sector || null,
      industry: profile.industry || null,
      website: profile.website || null,
      summary: profile.longBusinessSummary || null,
      employees: r(profile.fullTimeEmployees) || null,
      country: profile.country || null,
      price: quote?.regularMarketPrice ?? r(price?.regularMarketPrice) ?? null,
      previousClose:
        quote?.regularMarketPreviousClose ?? r(detail?.previousClose) ?? null,
      dayHigh: quote?.regularMarketDayHigh ?? r(detail?.dayHigh) ?? null,
      dayLow: quote?.regularMarketDayLow ?? r(detail?.dayLow) ?? null,
      fiftyTwoWeekHigh:
        quote?.fiftyTwoWeekHigh ?? r(detail?.fiftyTwoWeekHigh) ?? null,
      fiftyTwoWeekLow:
        quote?.fiftyTwoWeekLow ?? r(detail?.fiftyTwoWeekLow) ?? null,
      marketCap: quote?.marketCap ?? r(price?.marketCap) ?? null,
      trailingPE: quote?.trailingPE ?? r(detail?.trailingPE) ?? null,
      forwardPE: quote?.forwardPE ?? r(detail?.forwardPE) ?? null,
      dividendYield: r(detail?.dividendYield) ?? null,
      beta: r(stats?.beta) ?? r(detail?.beta) ?? null,
      volume: quote?.regularMarketVolume ?? r(detail?.volume) ?? null,
      avgVolume:
        quote?.averageDailyVolume3Month ?? r(detail?.averageVolume) ?? null,
    };

    // Yahoo's longBusinessSummary is usually empty from datacenter IPs;
    // fall back to EDGAR so the description still loads when Finnhub is
    // down and we're on this path.
    data = await describeCompany(raw, data);

    setTickerCache(raw, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(`Ticker info fetch failed for ${raw}:`, err);
    res.status(502).json({ error: err.message || 'Failed to fetch ticker info' });
  }
});

// Full-text extraction of a single article URL. Fetched server-side so we
// bypass CORS, run Mozilla's Readability to pull the main content, and
// sanitize the result before sending it back. 1-hour cache per URL.
router.get('/news/article', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const data = await extractArticle(url);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.warn(`article extract failed for ${url}: ${err.message}`);
    res.status(status).json({ error: err.message || 'Failed to extract article' });
  }
});

// Recent news headlines for a ticker, sourced from newsapi.org. The service
// caches 15 minutes so a rapid round of holding clicks doesn't burn quota.
router.get('/news/:ticker', tickerDataLimiter, async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  // Company name optionally passed via ?name= so the query can be scoped to
  // the actual company rather than the ticker string (which collides with
  // common words).
  const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 80) : '';
  try {
    const data = await getNewsForTicker(raw, name);
    res.json(data);
  } catch (err) {
    console.error(`news(${raw}) failed:`, err.message);
    res.status(err.status || 502).json({ error: err.message || 'Failed to fetch news' });
  }
});

// Research coverage for a ticker: pitches and reports the club has produced.
// Returned alongside ticker info in the holding detail modal.
/**
 * The club's own record across the WHOLE book, one row per security.
 *
 * The per-ticker version answers "what do we know about this name".
 * This answers the question nobody could ask before: which of our
 * positions has any club work behind it at all. That is an audit of
 * ourselves, and it is not flattering — a name we own with no pitch and
 * no vote on file is money at risk that no one in the room ever argued
 * for on the record.
 *
 * Deliberately compact. This feeds a COLUMN, not a panel, so it carries
 * counts and the one most recent decision rather than every ballot.
 */
/**
 * TRK — the club's own report card.
 *
 * Every closed vote, what the room decided, and what the price did
 * afterwards, scored against the index because the honest alternative to
 * owning a name is owning SPY. This is the screen a bought terminal
 * cannot sell us: Bloomberg knows everything about General Dynamics and
 * nothing about the fact that we voted to buy it on 5 June with five
 * ballots.
 *
 * It is expected to be uncomfortable. A report card that could only
 * flatter would not be worth opening.
 */
router.get('/decisions/record', async (_req, res) => {
  try {
    const [sessions, allUsers] = await Promise.all([
      prisma.votingSession.findMany({
        where: { status: 'closed' },
        orderBy: { closedAt: 'desc' },
        include: { ballots: true },
      }),
      prisma.user.findMany({ select: { id: true, name: true, role: true, extraRoles: true } }),
    ]);

    const decisions = sessions
      .filter((v) => v.ticker && v.closedAt)
      .map((v) => {
        const tally = computeTally(v.ballots, allUsers, v);
        return {
          id: v.id,
          ticker: String(v.ticker).trim().toUpperCase(),
          kind: v.kind,
          closedAt: v.closedAt,
          decision: tally.finalDecision,
          ballots: v.ballots.length,
          proposed: tally.buyAmountStats?.avg ?? null,
        };
      });

    const board = await buildScoreboard(decisions);
    res.json({ ...board, summary: summarize(board.rows) });
  } catch (err) {
    console.error('decisions/record failed:', err);
    res.status(500).json({ error: 'Failed to build the decision record' });
  }
});

router.get('/coverage', async (_req, res) => {
  try {
    // Four small tables read whole and grouped in memory. A groupBy in
    // Postgres cannot apply the dot/dash and case rules the resolver
    // owns, and doing it per ticker would be twenty-five round trips to
    // paint one column.
    const [pitches, reports, sessions, allUsers] = await Promise.all([
      prisma.pitch.findMany({
        select: { id: true, ticker: true, date: true, slideshowUrl: true },
      }),
      prisma.report.findMany({ select: { id: true, ticker: true, date: true } }),
      prisma.votingSession.findMany({
        where: { status: 'closed' },
        orderBy: { closedAt: 'desc' },
        include: { ballots: true },
      }),
      prisma.user.findMany({ select: { id: true, name: true, role: true, extraRoles: true } }),
    ]);

    const byPitch = groupByTicker(pitches);
    const byReport = groupByTicker(reports);
    const bySession = groupByTicker(sessions);

    const out = {};
    const touch = (key) => {
      if (!out[key]) out[key] = { pitches: 0, reports: 0, votes: 0, lastDecision: null, deck: false };
      return out[key];
    };

    for (const [key, rows] of byPitch) {
      const e = touch(key);
      e.pitches = rows.length;
      // A pitch with no deck attached is a pitch nobody can re-read.
      e.deck = rows.some((r) => !!r.slideshowUrl);
      e.lastPitch = rows.map((r) => r.date).filter(Boolean).sort().pop() ?? null;
    }
    for (const [key, rows] of byReport) touch(key).reports = rows.length;
    for (const [key, rows] of bySession) {
      const e = touch(key);
      e.votes = rows.length;
      // Sessions arrive newest first; the same computeTally the votes
      // page uses, so one screen can never disagree with another.
      const newest = rows[0];
      const tally = computeTally(newest.ballots, allUsers, newest);
      e.lastDecision = {
        decision: tally.finalDecision,
        kind: newest.kind,
        closedAt: newest.closedAt,
        ballots: newest.ballots.length,
      };
    }
    res.json({ coverage: out, asOf: new Date().toISOString() });
  } catch (err) {
    console.error('coverage() failed:', err);
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});

router.get('/coverage/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    // Matched through the shared resolver rather than one route's own
    // rule. Six tables carry ticker as free text with no foreign key,
    // and the codebase had three different opinions about matching them
    // — a club block that shows two of three pitches teaches a member
    // the club has no history on a name when it does.
    const where = tickerWhere(raw);
    const [pitches, reports, holding, sessions, allUsers] = await Promise.all([
      prisma.pitch.findMany({
        where,
        orderBy: { date: 'desc' },
        include: {
          industry: { select: { id: true, name: true } },
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.report.findMany({ where, orderBy: { date: 'desc' } }),
      prisma.holding.findFirst({ where: { ...where, isCash: false } }),
      prisma.votingSession.findMany({
        where: { ...where, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        include: { ballots: true },
      }),
      prisma.user.findMany({ select: { id: true, name: true, role: true, extraRoles: true } }),
    ]);

    // The decision is COMPUTED, never stored, so it has to be recomputed
    // here from the same function the votes page uses. Reimplementing
    // the weighting would be how the club block and the vote page start
    // disagreeing about what the club decided.
    const decisions = sessions.map((v) => {
      const tally = computeTally(v.ballots, allUsers, v);
      return {
        id: v.id,
        ticker: v.ticker,
        kind: v.kind,
        closedAt: v.closedAt,
        decision: tally.finalDecision,
        ballots: v.ballots.length,
        // What the room proposed, against what was actually deployed —
        // the gap is the thing a member cannot see anywhere today.
        proposed: tally.buyAmountStats ?? null,
        synthesis: v.synthesis || null,
        pitchId: v.pitchId ?? null,
      };
    });
    res.json({
      ticker: raw,
      // Do we own it, and what did we pay. A dash here is a fact about
      // the book, not a hole in the panel.
      holding: holding
        ? {
          shares: holding.shares,
          costBasis: holding.costBasis,
          name: holding.name ?? null,
          sector: holding.sector ?? null,
          addedAt: holding.addedAt,
        }
        : null,
      decisions,
      pitches: pitches.map((p) => ({
        id: p.id,
        date: p.date,
        slideshowUrl: p.slideshowUrl,
        location: p.location,
        industry: p.industry,
        presenters:
          p.presenters.length > 0
            ? p.presenters.map((pp) => pp.user.name)
            : [p.pitcherName],
      })),
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        date: r.date,
        description: r.description,
        fileUrl: r.fileUrl,
      })),
    });
  } catch (err) {
    console.error(`coverage(${raw}) failed:`, err);
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});


// ── Holding Lots ─────────────────────────────────────────────────────
// Per-purchase cost basis tracking. Anyone authed can read; only the super
// admin can mutate.

function validTicker(t) {
  return !!t && /^[A-Z0-9.\-]{1,10}$/.test(t);
}

router.get('/lots/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!validTicker(raw)) return res.status(400).json({ error: 'Invalid ticker' });
  const lots = await prisma.holdingLot.findMany({
    where: { ticker: raw },
    orderBy: { buyDate: 'asc' },
  });
  res.json(lots);
});

// Lots are authoritative for a position's shares + blended cost, so every
// mutation refolds the matching Holding row in the same transaction — the
// derived position can never drift from the lot history.
router.post('/lots', requireSuperAdmin, async (req, res, next) => {
  try {
    const { ticker, shares, pricePerShare, buyDate, note } = req.body || {};
    const t = String(ticker || '').trim().toUpperCase();
    const s = Number(shares);
    const p = Number(pricePerShare);
    const d = buyDate ? new Date(buyDate) : null;
    if (!validTicker(t)) return res.status(400).json({ error: 'Invalid ticker' });
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'Invalid shares' });
    if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Invalid price' });
    if (!d || Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid buy date' });
    const lot = await prisma.$transaction(async (tx) => {
      const created = await tx.holdingLot.create({
        data: { ticker: t, shares: s, pricePerShare: p, buyDate: d, note: note || null },
      });
      await recomputeHoldingFromLots(tx, t);
      return created;
    });
    res.status(201).json(lot);
  } catch (err) {
    next(err);
  }
});

router.put('/lots/:id', requireSuperAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { shares, pricePerShare, buyDate, note } = req.body || {};
  const data = {};
  if (shares !== undefined) {
    const s = Number(shares);
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'Invalid shares' });
    data.shares = s;
  }
  if (pricePerShare !== undefined) {
    const p = Number(pricePerShare);
    if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Invalid price' });
    data.pricePerShare = p;
  }
  if (buyDate !== undefined) {
    const d = new Date(buyDate);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid buy date' });
    data.buyDate = d;
  }
  if (note !== undefined) data.note = note || null;
  try {
    const lot = await prisma.$transaction(async (tx) => {
      const updated = await tx.holdingLot.update({ where: { id }, data });
      await recomputeHoldingFromLots(tx, updated.ticker);
      return updated;
    });
    res.json(lot);
  } catch (err) {
    // P2025 = record-to-update not found; anything else is a real fault that
    // must surface as a 500, not get masked as "not found".
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Lot not found' });
    next(err);
  }
});

router.delete('/lots/:id', requireSuperAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const found = await prisma.$transaction(async (tx) => {
      const lot = await tx.holdingLot.findUnique({ where: { id } });
      if (!lot) return false;
      await tx.holdingLot.delete({ where: { id } });
      await recomputeHoldingFromLots(tx, lot.ticker);
      return true;
    });
    if (!found) return res.status(404).json({ error: 'Lot not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Positions + cash ledger (DB-backed book) ─────────────────────────
// The positions list and the running cash balance, plus the manual cash
// movements that aren't trades. Reads are open to any member (cash isn't
// sensitive — same posture as cash-yield); writes are super-admin only.
// Trade-driven Buy/Sell rows are written by settlement (tradeExecution.js),
// never here, and can't be deleted here either.

const MANUAL_TX_KINDS = new Set(['Deposit', 'Withdraw', 'Dividend', 'Fee']);

router.get('/positions', async (_req, res, next) => {
  try {
    const rows = await prisma.holding.findMany({ orderBy: { ticker: 'asc' } });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Direct buy/sell on the portfolio — no vote, no envelope. Debits/credits cash,
// relieves lots FIFO on a sell (with realized P/L), guards buying power +
// over-sell. Super-admin only. Body: { side: "Buy"|"Sell", ticker, shares,
// pricePerShare, note? }.
router.post('/trade', requireSuperAdmin, async (req, res, next) => {
  try {
    const { side, ticker, shares, pricePerShare, note, buyDate, noCash, name, sector } = req.body || {};
    const result = await executeDirectTrade({
      side,
      ticker,
      shares,
      pricePerShare,
      buyDate: buyDate || null,
      noCash: noCash === true,
      name: name || null,
      sector: sector || null,
      note: note || null,
      actorName: req.user?.name || null,
    });
    enrichHoldingsMeta().catch(() => {}); // backfill name/sector for any new ticker
    res.json(result);
  } catch (err) {
    if (err instanceof TradeExecutionError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// Bulk-record a batch of buys/sells — a broker-statement import. All-or-nothing
// in one transaction, sells executed before buys so proceeds fund the buys.
// Super-admin only. Body: { trades: [{ side, ticker, shares, pricePerShare }] }.
router.post('/trades', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await executeBulkTrades({ trades: req.body?.trades, actorName: req.user?.name || null });
    enrichHoldingsMeta().catch(() => {}); // backfill name/sector for any new tickers
    res.json(result);
  } catch (err) {
    if (err instanceof TradeExecutionError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// Backfill company name + sector from Finnhub for any holding still missing them
// (a position a trade created with just a ticker). Super-admin.
router.post('/enrich-meta', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json(await enrichHoldingsMeta());
  } catch (err) {
    next(err);
  }
});

// Run the one-time sheet → DB import (the cutover's data step) from the app, so
// no database URL has to leave the server. Dry-run by default; { commit: true }
// writes the held positions + opening cash and reconciles to the dollar,
// rolling back on any mismatch. Super-admin only.
router.post('/import-from-sheet', requireSuperAdmin, async (req, res, next) => {
  try {
    const commit = req.body?.commit === true;
    const reset = req.body?.reset === true;
    const force = req.body?.force === true;
    const report = await importFromSheet({ commit, reset, force });
    res.json(report);
  } catch (err) {
    if (err instanceof PortfolioImportError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// Edit metadata that isn't derived from lots. Shares + cost basis follow the
// lots — adjust those via /lots.
router.put('/positions/:ticker', requireSuperAdmin, async (req, res, next) => {
  const t = String(req.params.ticker || '').trim().toUpperCase();
  if (!validTicker(t)) return res.status(400).json({ error: 'Invalid ticker' });
  const { name, sector } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = name || null;
  if (sector !== undefined) data.sector = sector || null;
  try {
    const row = await prisma.holding.update({ where: { ticker: t }, data });
    res.json(row);
  } catch (err) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Holding not found' });
    next(err);
  }
});

// Remove a position entirely — drops the Holding and all its lots. For an
// erroneous / test position that shouldn't be in the book at all. Does NOT move
// cash (use Trade → Sell to record a real sale that credits cash).
router.delete('/positions/:ticker', requireSuperAdmin, async (req, res, next) => {
  try {
    const t = String(req.params.ticker || '').trim().toUpperCase();
    if (!validTicker(t)) return res.status(400).json({ error: 'Invalid ticker' });
    const removed = await prisma.$transaction(async (tx) => {
      const h = await tx.holding.findUnique({ where: { ticker: t } });
      if (!h) return false;
      await tx.holdingLot.deleteMany({ where: { ticker: t } });
      await tx.holding.delete({ where: { ticker: t } });
      return true;
    });
    if (!removed) return res.status(404).json({ error: 'Holding not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/cash', async (_req, res, next) => {
  try {
    res.json({ cash: await getCashBalance() });
  } catch (err) {
    next(err);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const take = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await prisma.transaction.findMany({
      orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
      take,
    });
    res.json({ transactions: rows, cash: await getCashBalance() });
  } catch (err) {
    next(err);
  }
});

router.post('/transactions', requireSuperAdmin, async (req, res, next) => {
  try {
    const { kind, amount, note, ticker, executedAt } = req.body || {};
    const k = String(kind || '').trim();
    if (!MANUAL_TX_KINDS.has(k)) {
      return res
        .status(400)
        .json({ error: `kind must be one of ${[...MANUAL_TX_KINDS].join(', ')}` });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount (positive number) required' });
    }
    // Withdrawals + fees remove cash; deposits + dividends add it. The caller
    // always sends a positive amount; the sign is ours to set.
    const sign = k === 'Withdraw' || k === 'Fee' ? -1 : 1;
    const when = executedAt ? new Date(executedAt) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid executedAt' });
    // A future-dated movement would distort every historical snapshot.
    if (when.getTime() > Date.now() + 60_000) {
      return res.status(400).json({ error: 'executedAt cannot be in the future' });
    }
    // A withdrawal/fee can't take the book below zero (matches the trade paths).
    if (sign < 0) {
      const bal = await getCashBalance();
      if (bal - amt < -1e-6) {
        return res.status(400).json({
          error: `Insufficient cash: ${k} of $${amt.toFixed(2)} exceeds the $${bal.toFixed(2)} balance.`,
        });
      }
    }
    const row = await prisma.transaction.create({
      data: {
        kind: k,
        cashDelta: sign * amt,
        ticker: ticker ? String(ticker).toUpperCase() : null,
        note: note || null,
        executedByName: req.user?.name || null,
        executedAt: when,
      },
    });
    res.status(201).json({ transaction: row, cash: await getCashBalance() });
  } catch (err) {
    next(err);
  }
});

router.delete('/transactions/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const tx = await prisma.transaction.findUnique({ where: { id } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    // Buy/Sell/Opening rows are settlement facts tied to trades + lots; deleting
    // one would desync the book. Only manual cash movements can be removed here.
    if (!MANUAL_TX_KINDS.has(tx.kind)) {
      return res.status(400).json({
        error: `Can't delete a ${tx.kind} row here — it's tied to a trade. Reverse it with an opposing entry instead.`,
      });
    }
    await prisma.transaction.delete({ where: { id } });
    res.json({ ok: true, cash: await getCashBalance() });
  } catch (err) {
    next(err);
  }
});

// Super-admin-only: overwrite a single day's snapshot. Used to correct days
// where Google Sheets served a stale CSV (the known Apr 14–17 flat stretch).
router.put('/snapshot/:date', requireSuperAdmin, async (req, res) => {
  const iso = String(req.params.date || '').trim();
  // Accept YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const { totalValue, cashValue } = req.body || {};
  const tv = Number(totalValue);
  if (!Number.isFinite(tv) || tv <= 0) {
    return res.status(400).json({ error: 'totalValue (positive number) required' });
  }
  const cv = cashValue == null || cashValue === '' ? null : Number(cashValue);
  if (cv != null && !Number.isFinite(cv)) {
    return res.status(400).json({ error: 'cashValue must be a number if provided' });
  }
  // Snapshots are stored at UTC midnight.
  const date = new Date(`${iso}T00:00:00Z`);
  const snap = await prisma.portfolioSnapshot.upsert({
    where: { date },
    update: { totalValue: tv, cashValue: cv },
    create: { date, totalValue: tv, cashValue: cv },
  });
  res.json(snap);
});

router.delete('/snapshot/:date', requireSuperAdmin, async (req, res) => {
  const iso = String(req.params.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const date = new Date(`${iso}T00:00:00Z`);
  try {
    await prisma.portfolioSnapshot.delete({ where: { date } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Snapshot not found' });
  }
});

// Super-admin: retro-fit a late-recorded trade basket into the value chart. Each
// snapshot from `startDate` to `endDate` was frozen against the OLD book — it
// still counts what we sold and misses what we bought — so the line is wrong by
// the day-to-day drift between the two baskets. This re-marks every affected day
// using the PriceBar cache (the same source the GP chart reads), applying the
// per-day correction from snapshotReconcile. Dry-run by default: it returns the
// full before→after table and only writes when `commit:true`. It refuses to
// commit any day it can't fully price, so a missing bar never silently zeroes a
// leg and understates the book.
//
// Run this BEFORE flipping PORTFOLIO_SOURCE to db: while still on the sheet,
// every snapshot in the window reflects the same stale book, so the correction
// is uniform. Afterwards the daily capture reads the (now correct) db book and
// needs no fixing.
router.post('/snapshot/reconcile', requireSuperAdmin, async (req, res, next) => {
  try {
    const { startDate, endDate, legs, netCashDelta, commit } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
      return res.status(400).json({ error: 'startDate (YYYY-MM-DD) is required' });
    }
    const end =
      endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
        ? endDate
        : new Date().toISOString().slice(0, 10);
    if (end < startDate) {
      return res.status(400).json({ error: 'endDate is before startDate' });
    }

    if (!Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: 'legs (a non-empty array) is required' });
    }
    const cleanLegs = [];
    for (const l of legs) {
      const ticker = String(l?.ticker || '').trim().toUpperCase();
      const side = l?.side === 'Buy' || l?.side === 'Sell' ? l.side : null;
      const shares = Number(l?.shares);
      if (!validTicker(ticker)) return res.status(400).json({ error: `Invalid ticker: ${l?.ticker}` });
      if (!side) return res.status(400).json({ error: `Each leg needs side "Buy" or "Sell" (${ticker})` });
      if (!Number.isFinite(shares) || shares <= 0) {
        return res.status(400).json({ error: `Shares for ${ticker} must be a positive number` });
      }
      cleanLegs.push({ ticker, side, shares });
    }

    const cash = Number(netCashDelta);
    if (!Number.isFinite(cash)) {
      return res.status(400).json({ error: 'netCashDelta must be a number' });
    }

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        date: { gte: new Date(`${startDate}T00:00:00Z`), lte: new Date(`${end}T23:59:59Z`) },
      },
      orderBy: { date: 'asc' },
    });
    if (snapshots.length === 0) {
      return res.json({ committed: false, rows: [], missingTickers: [], note: 'No snapshots in that range.' });
    }

    // Daily closes per traded ticker. 3mo comfortably spans the window and
    // getHistory backfills the PriceBar cache from NASDAQ on a miss.
    const tickers = [...new Set(cleanLegs.map((l) => l.ticker))];
    const barsByTicker = {};
    const missingTickers = [];
    for (const t of tickers) {
      try {
        const bars = await getHistory(t, '3mo');
        barsByTicker[t] = bars
          .filter((b) => b.close != null)
          .map((b) => ({ date: b.date, close: b.close }));
        if (barsByTicker[t].length === 0) missingTickers.push(t);
      } catch {
        barsByTicker[t] = [];
        missingTickers.push(t);
      }
    }

    const closeFor = makeCloseLookup(barsByTicker);
    const rows = computeSnapshotCorrections({ snapshots, legs: cleanLegs, netCashDelta: cash, closeFor });
    const anyMissing = rows.some((r) => r.missing.length > 0);

    if (commit !== true) {
      return res.json({ committed: false, rows, missingTickers, anyMissing });
    }
    if (anyMissing) {
      return res.status(400).json({
        error:
          'Refusing to commit — some days have no price for a traded ticker, which would understate the book. Retry once the price history fills in.',
        rows,
        missingTickers,
      });
    }

    // Update in place against each snapshot's own stored date, so we never
    // depend on how midnight was constructed when the row was first written.
    for (let i = 0; i < rows.length; i++) {
      await prisma.portfolioSnapshot.update({
        where: { date: snapshots[i].date },
        data: { totalValue: rows[i].after.totalValue, cashValue: rows[i].after.cashValue },
      });
    }
    res.json({ committed: true, rows, missingTickers: [], count: rows.length });
  } catch (err) {
    next(err);
  }
});

// Super-admin: rebuild the value chart from the live book — the idempotent
// repair. For each snapshot in the range it SETS the day's value to the current
// holdings valued at that day's close plus the current cash — the very same
// math the live page runs for today, walked backwards. Because it sets rather
// than nudges, running it once fixes a chart no matter what state it's in
// (including a delta reconcile that was applied twice). Dry-run by default;
// refuses to commit a day it can't fully price.
//
// Assumes the book has been static across the window (a single late basket is
// the only change) and cash hasn't moved since — record a Dividend/Deposit
// separately if it has. Meant for the tail end of the chart (the trade date
// forward), not for rewriting deep history the current book never reflected.
router.post('/snapshot/rebuild', requireSuperAdmin, async (req, res, next) => {
  try {
    const { startDate, endDate, commit } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
      return res.status(400).json({ error: 'startDate (YYYY-MM-DD) is required' });
    }
    const end =
      endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
        ? endDate
        : new Date().toISOString().slice(0, 10);
    if (end < startDate) {
      return res.status(400).json({ error: 'endDate is before startDate' });
    }

    const positions = await prisma.holding.findMany({
      where: { closedAt: null, isCash: false },
      select: { ticker: true, shares: true },
    });
    if (positions.length === 0) {
      return res.status(400).json({
        error: 'No open positions in the book — rebuild needs a db-mode book. Import the sheet first.',
      });
    }
    const cash = await getCashBalance();

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        date: { gte: new Date(`${startDate}T00:00:00Z`), lte: new Date(`${end}T23:59:59Z`) },
      },
      orderBy: { date: 'asc' },
    });
    if (snapshots.length === 0) {
      return res.json({ committed: false, rows: [], missingTickers: [], cash, note: 'No snapshots in that range.' });
    }

    // Daily closes for every held ticker. 3mo spans the window and getHistory
    // backfills the PriceBar cache from NASDAQ on a miss.
    const tickers = [...new Set(positions.map((p) => p.ticker))];
    const barsByTicker = {};
    const missingTickers = [];
    for (const t of tickers) {
      try {
        const bars = await getHistory(t, '3mo');
        barsByTicker[t] = bars.filter((b) => b.close != null).map((b) => ({ date: b.date, close: b.close }));
        if (barsByTicker[t].length === 0) missingTickers.push(t);
      } catch {
        barsByTicker[t] = [];
        missingTickers.push(t);
      }
    }

    const closeFor = makeCloseLookup(barsByTicker);
    const rows = computeSnapshotRebuild({ snapshots, positions, cash, closeFor });
    const anyMissing = rows.some((r) => r.missing.length > 0);

    if (commit !== true) {
      return res.json({ committed: false, rows, missingTickers, anyMissing, cash });
    }
    if (anyMissing) {
      return res.status(400).json({
        error:
          'Refusing to commit — some days have no price for a held ticker, which would understate the book. Open the GP chart for those names once to warm the cache, then retry.',
        rows,
        missingTickers,
      });
    }

    for (let i = 0; i < rows.length; i++) {
      await prisma.portfolioSnapshot.update({
        where: { date: snapshots[i].date },
        data: { totalValue: rows[i].after.totalValue, cashValue: rows[i].after.cashValue },
      });
    }
    res.json({ committed: true, rows, missingTickers: [], count: rows.length });
  } catch (err) {
    next(err);
  }
});

// Batch beta lookup for every non-cash position in the current sheet.
// Used by the PM+ risk panel. Cached for 30 min — betas don't move intraday.
// Each ticker goes through the same Finnhub → Yahoo fallback as /info/:ticker
// but we only ask for the number we need.
const betasCache = { at: 0, data: null };
const BETAS_TTL_MS = 30 * 60 * 1000;

async function fetchBetaOnly(ticker) {
  // Try Finnhub metric endpoint first (1 call for beta).
  const key = process.env.FINNHUB_API_KEY;
  if (key) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`
      );
      if (r.ok) {
        const j = await r.json();
        const b = j?.metric?.beta;
        if (typeof b === 'number' && Number.isFinite(b)) return { beta: b, source: 'finnhub' };
      }
    } catch {
      /* fall through */
    }
  }
  // Fallback: Yahoo quoteSummary.
  const summary = await fetchQuoteSummary(ticker);
  const stats = summary?.defaultKeyStatistics;
  const detail = summary?.summaryDetail;
  const raw =
    (stats?.beta && typeof stats.beta === 'object' ? stats.beta.raw : stats?.beta) ??
    (detail?.beta && typeof detail.beta === 'object' ? detail.beta.raw : detail?.beta);
  if (typeof raw === 'number' && Number.isFinite(raw)) return { beta: raw, source: 'yahoo' };
  return { beta: null, source: null };
}

router.get('/betas', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    if (betasCache.data && Date.now() - betasCache.at < BETAS_TTL_MS) {
      return res.json(betasCache.data);
    }
    const portfolio = await getSheetPortfolio();
    const tickers = portfolio.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker);
    // Parallel but cap fan-out at 6 at a time to stay inside Finnhub's 60/min free tier.
    const byTicker = {};
    const CHUNK = 6;
    for (let i = 0; i < tickers.length; i += CHUNK) {
      const slice = tickers.slice(i, i + CHUNK);
      const results = await Promise.all(slice.map((t) => fetchBetaOnly(t)));
      slice.forEach((t, idx) => {
        byTicker[t] = results[idx];
      });
    }
    const payload = { byTicker, fetchedAt: new Date().toISOString() };
    betasCache.at = Date.now();
    betasCache.data = payload;
    res.json(payload);
  } catch (err) {
    console.error('betas fetch failed:', err.message);
    res.status(502).json({ error: err.message || 'Failed to fetch betas' });
  }
});

router.get('/history', async (_req, res) => {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { date: 'asc' },
    take: 365,
  });

  // Snapshots are the sheet's own totals, which already carry the cash
  // sleeves: the leftover FGTXX cash is the sheet's CASH line, and every
  // dollar drawn out of BDA/FGTXX became a stock the sheet prices. We
  // used to layer a simulated cash-interest accrual on top here — that
  // double-counted money the club had actually spent. Return the raw
  // snapshots untouched.
  res.json(snapshots);
});

// Per-equity returns across timeframes for the Portfolio holdings table:
// { [ticker]: { '1D': {pct,usd}, '1W': …, '1M': …, '1Y': …, purchase: {pct,usd} } }
//
// 1D and purchase come straight off the sheet (dayChange is a PER-SHARE
// dollar figure — see getPortfolioMovers — and percentReturn/dollarReturn
// are the since-purchase columns). 1W/1M/1Y need each ticker's close at
// the lookback date, which the PriceBar cache (services/priceHistory.js)
// already holds for the terminal's GP chart — same source, no new vendor.
// pct is the share-price move over the period; usd scales it by the
// position's share count.
//
// The whole payload is memoized for 15 minutes and the per-ticker reads
// run sequentially, so a page load never stampedes NASDAQ — on a warm
// cache this is a handful of Postgres reads. Never 500s: a gap is a null
// cell, and an upstream failure serves the last good payload (or {}).
const periodReturnsCache = { at: 0, data: null };
const PERIOD_RETURNS_TTL_MS = 15 * 60 * 1000;

const PERIOD_LOOKBACKS = [
  { key: '1W', days: 7 },
  { key: '1M', days: 30 },
  { key: '1Y', days: 365 },
];

// Latest close on or before the target day (bars ascending, ISO dates).
function closeOnOrBefore(bars, targetIso) {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= targetIso && bars[i].close != null) return bars[i].close;
  }
  return null;
}

router.get('/period-returns', async (_req, res) => {
  if (periodReturnsCache.data && Date.now() - periodReturnsCache.at < PERIOD_RETURNS_TTL_MS) {
    return res.json(periodReturnsCache.data);
  }
  try {
    const raw = await getSheetPortfolio();
    // 1D comes off the same blank-prone column as the holdings table.
    const sheet = { ...raw, holdings: await withResolvedDayChange(raw.holdings) };
    const out = {};
    for (const h of sheet.holdings) {
      if (h.isCash) continue;
      const ticker = String(h.ticker || '').trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) continue;

      const shares = Number.isFinite(h.shares) ? h.shares : null;
      const entry = {};

      const prior =
        h.price != null && h.dayChange != null ? h.price - h.dayChange : null;
      entry['1D'] = {
        pct: prior > 0 ? (h.dayChange / prior) * 100 : null,
        usd: h.dayChange != null && shares != null ? h.dayChange * shares : null,
      };
      entry.purchase = {
        pct: h.percentReturn ?? null,
        usd:
          h.dollarReturn ??
          (h.marketValue != null && shares != null && h.costBasis != null
            ? h.marketValue - shares * h.costBasis
            : null),
      };

      let bars = [];
      try {
        bars = await getHistory(ticker, '2y');
      } catch {
        bars = []; // this ticker's lookbacks go null; the rest still fill
      }
      const last = bars.length ? bars[bars.length - 1] : null;
      const current = h.price ?? last?.close ?? null;
      for (const { key, days } of PERIOD_LOOKBACKS) {
        const target = new Date(Date.now() - days * 86400_000)
          .toISOString()
          .slice(0, 10);
        // Refuse to price a period the cache doesn't reach back to (a
        // recent IPO): using the earliest bar would misstate the return.
        const past =
          bars.length && bars[0].date <= target
            ? closeOnOrBefore(bars, target)
            : null;
        entry[key] =
          current != null && past > 0
            ? {
                pct: ((current - past) / past) * 100,
                usd: shares != null ? (current - past) * shares : null,
              }
            : { pct: null, usd: null };
      }
      out[ticker] = entry;
    }
    periodReturnsCache.at = Date.now();
    periodReturnsCache.data = out;
    res.json(out);
  } catch (err) {
    console.error('period-returns failed:', err.message);
    res.json(periodReturnsCache.data || {});
  }
});

// Upcoming earnings for every held equity ticker (next 60 days). Pulled
// from Finnhub with a 12h per-ticker cache, then filtered + sorted so
// the client can render a clean "next up" list.
router.get('/earnings', async (_req, res) => {
  try {
    const sheet = await getSheetPortfolio();
    const tickers = sheet.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker.toUpperCase());
    if (tickers.length === 0) return res.json({ upcoming: [] });

    const byTicker = await getUpcomingEarningsBatch(tickers, { daysAhead: 60 });
    // Flatten to a sorted list — soonest first. Include the company name
    // alongside the ticker so clients don't need to re-lookup.
    const holdingByTicker = new Map(
      sheet.holdings
        .filter((h) => !h.isCash && h.ticker)
        .map((h) => [h.ticker.toUpperCase(), h])
    );
    const upcoming = Object.entries(byTicker)
      .map(([ticker, row]) => {
        const h = holdingByTicker.get(ticker);
        return {
          ticker,
          name: h?.name || ticker,
          sector: h?.sector || null,
          date: row.date, // 'YYYY-MM-DD'
          hour: row.hour || null, // 'bmo' | 'amc' | 'dmh' | null
          epsEstimate: row.epsEstimate ?? null,
          revenueEstimate: row.revenueEstimate ?? null,
          quarter: row.quarter ?? null,
          year: row.year ?? null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ upcoming });
  } catch (err) {
    console.error('earnings fetch failed:', err.message);
    res.status(502).json({ error: 'Failed to fetch earnings calendar' });
  }
});

// Analyst consensus for a single ticker. Latest row + ~3-month prior so
// the client can show a "current + trend" chip.
router.get('/:ticker/consensus', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const data = await getAnalystConsensus(ticker);
  if (!data) return res.json({ ticker, covered: false });
  res.json({ ticker, covered: true, ...data });
});

// Recent SEC filings for a ticker. Free EDGAR data, no API key —
// 6h cache per ticker server-side.
router.get('/:ticker/filings', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const filings = await getRecentFilings(ticker, { limit: 10 });
    res.json({ ticker, filings });
  } catch (err) {
    console.error(`filings(${ticker}) failed:`, err.message);
    res.status(502).json({ error: 'Failed to fetch SEC filings' });
  }
});

// Single-ticker earnings lookup — convenience for the holding detail modal
// so it doesn't have to fetch the whole portfolio's earnings just to show
// one row.
router.get('/:ticker/earnings', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const row = await getUpcomingEarnings(ticker);
  if (!row) return res.json({ ticker, covered: false });
  res.json({ ticker, covered: true, ...row });
});

// ── Investment thesis per ticker ──────────────────────────────────────
// Readable by any authed member. Editable by super-admin only (same tier
// that manages lots and snapshot overrides).

function normalizeTicker(raw) {
  return String(raw || '').trim().toUpperCase();
}

router.get('/:ticker/thesis', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const row = await prisma.holdingThesis.findUnique({ where: { ticker } });
  // 200 + empty so the UI can render an "Add thesis" affordance cleanly
  // instead of having to handle a 404.
  res.json(row || { ticker, thesis: null });
});

router.put('/:ticker/thesis', requireSuperAdmin, async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const raw = req.body?.thesis;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'thesis (string) required' });
  }
  const thesis = raw.trim();
  if (!thesis) return res.status(400).json({ error: 'thesis cannot be empty' });
  if (thesis.length > 5000) {
    return res.status(400).json({ error: 'thesis must be 5000 characters or fewer' });
  }
  const updatedByName = req.user?.name || null;
  const row = await prisma.holdingThesis.upsert({
    where: { ticker },
    update: { thesis, updatedByName },
    create: { ticker, thesis, updatedByName },
  });
  res.json(row);
});

router.delete('/:ticker/thesis', requireSuperAdmin, async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  await prisma.holdingThesis.deleteMany({ where: { ticker } });
  res.json({ ok: true });
});

// 1-2 sentence AI read on whether recent news supports or challenges the
// stored thesis. Readable by any authed member (same tier as thesis GET).
router.get('/:ticker/thesis-check', tickerDataLimiter, async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const row = await prisma.holdingThesis.findUnique({ where: { ticker } });
    if (!row?.thesis) return res.json({ reading: null });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const articles = await prisma.articleRanking.findMany({
      where: { ticker, createdAt: { gte: since }, score: { gte: 5 } },
      orderBy: { score: 'desc' },
      take: 5,
    });
    const normalizedArticles = articles.map((a) => ({
      title: a.reason || a.summary?.slice(0, 120) || null,
      description: a.summary || null,
      score: a.score,
      reason: a.reason,
      url: a.url,
    }));
    const result = await checkThesisAgainstNews({
      ticker,
      thesis: row.thesis,
      articles: normalizedArticles,
    });
    res.json(result || { reading: null });
  } catch (err) {
    console.error('thesis-check failed:', err.message);
    res.json({ reading: null });
  }
});

// ── AI risk commentary ───────────────────────────────────────────────
// Client POSTs the already-computed risk metrics (weights, beta, vol,
// drawdown, HHI, cash %). Server calls the LLM, caches daily, returns a
// 3-4 sentence narrative or null if the LLM is unreachable.
router.post(
  '/risk-commentary',
  requireRole('PortfolioManager'),
  async (req, res) => {
    try {
      const metrics = req.body || {};
      const result = await generateRiskCommentary(metrics);
      res.json(result || { commentary: null });
    } catch (err) {
      console.error('risk-commentary failed:', err.message);
      // Fail open — panel keeps showing metrics without the narrative.
      res.json({ commentary: null });
    }
  }
);

// ── Thesis-vs-news drift ─────────────────────────────────────────────
// For each held non-cash ticker with both a thesis and recent ranked
// news, ask the LLM whether the news materially contradicts the thesis.
// Returns an array of flagged tickers only — tickers with drift:false
// are omitted so the UI can render a clean alert list.
router.get('/thesis-drift', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    const portfolio = await getSheetPortfolio();
    const tickers = portfolio.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker);
    if (tickers.length === 0) return res.json({ alerts: [] });

    const theses = await prisma.holdingThesis.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, thesis: true },
    });
    const thesisByTicker = new Map(theses.map((t) => [t.ticker, t.thesis]));
    const tickersWithThesis = tickers.filter((t) => thesisByTicker.has(t));
    if (tickersWithThesis.length === 0) return res.json({ alerts: [] });

    // 30-day window for materiality. Articles the club never surfaced
    // (no ranking) are ignored — we don't want the drift check to drive
    // new newsapi calls.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const articles = await prisma.articleRanking.findMany({
      where: {
        ticker: { in: tickersWithThesis },
        createdAt: { gte: since },
        score: { gte: 5 },
      },
      orderBy: { score: 'desc' },
      take: 100,
    });

    const articlesByTicker = new Map();
    for (const a of articles) {
      if (!articlesByTicker.has(a.ticker)) articlesByTicker.set(a.ticker, []);
      articlesByTicker.get(a.ticker).push({
        // ArticleRanking stores the rank + reason, not the headline text.
        // Pull from summary when present; fall back to ranker's 12-word reason.
        title: a.reason || a.summary?.slice(0, 120) || null,
        description: a.summary || null,
        score: a.score,
        reason: a.reason,
        url: a.url,
      });
    }

    // Concurrency-limited LLM fan-out so we don't spam the provider.
    const alerts = [];
    const CHUNK = 3;
    for (let i = 0; i < tickersWithThesis.length; i += CHUNK) {
      const slice = tickersWithThesis.slice(i, i + CHUNK);
      const results = await Promise.all(
        slice.map(async (t) => {
          const arts = articlesByTicker.get(t);
          if (!arts || arts.length === 0) return null;
          const drift = await detectThesisDrift({
            ticker: t,
            thesis: thesisByTicker.get(t),
            articles: arts,
          });
          if (!drift?.drift) return null;
          return {
            ticker: t,
            severity: drift.severity,
            reason: drift.reason,
            articleCount: arts.length,
          };
        })
      );
      for (const r of results) if (r) alerts.push(r);
    }

    // High severity first, then medium, then low.
    const rank = { high: 3, medium: 2, low: 1 };
    alerts.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));
    res.json({ alerts, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error('thesis-drift failed:', err.message);
    res.json({ alerts: [] });
  }
});

// YTD interest earned on the club's cash position, split between the
// FGTXX money-market sleeve and the Bank USA deposit sleeve. Open to
// every logged-in member — the cash sleeve isn't sensitive and the
// numbers are useful context for the dashboard.
router.get('/cash-yield', async (_req, res) => {
  try {
    const data = await computeCashInterest();
    // Strip the verbose per-day series for the default response; clients
    // that want the daily breakdown can pass ?series=1.
    const { series, ...summary } = data;
    if (_req.query.series === '1') {
      return res.json({ ...summary, series });
    }
    return res.json(summary);
  } catch (err) {
    console.error('cash-yield failed:', err.message);
    res.status(500).json({ error: 'Failed to compute cash interest' });
  }
});

// Manual trigger so an admin can force a re-scrape if the cron missed
// a day or the PDF was published late. The daily cron handles the
// happy path; this is the "fix it now" button.
router.post('/cash-yield/refresh', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    const rows = await scrapeAndStoreDailyRates(['FGTXX']);
    res.json({ scraped: rows.length, latest: rows[0] || null });
  } catch (err) {
    console.error('gsam scrape failed:', err.message);
    res.status(502).json({ error: err.message || 'Scrape failed' });
  }
});

// One-shot historical backfill from SEC N-MFP3 filings. Idempotent — safe
// to re-hit. Super-admin only because it talks to EDGAR and writes a
// chunk of rows; we don't want this firing accidentally.
router.post('/cash-yield/backfill', requireSuperAdmin, async (_req, res) => {
  try {
    const stats = await backfillFgtxxFromEdgar();
    res.json(stats);
  } catch (err) {
    console.error('n-mfp backfill failed:', err.message);
    res.status(502).json({ error: err.message || 'Backfill failed' });
  }
});

export default router;
