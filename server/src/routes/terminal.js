import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { llmChat, llmChatStreamLocal, canStreamLocally } from '../services/llm.js';
import { getHistory, getIntraday } from '../services/priceHistory.js';
import { getFundamentals, getStatements } from '../services/secFundamentals.js';
import { getPortfolioMovers, getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getSupplyChain } from '../services/secSupplyChain.js';
import { getFacilities, sitesNearStorm } from '../services/facilities.js';
import { resolveCik } from '../services/secFundamentals.js';
import { getProxyStatement } from '../services/proxyStatement.js';
import { getExecutiveBios } from '../services/executiveBios.js';
import { wikipediaBio } from '../services/wikipediaBio.js';
import { filingBio } from '../services/filingBio.js';
import { saveProfiles, storedProfiles } from '../services/personProfiles.js';
import { parseLeadership, parseBoard, parseComp, buildNetwork } from '../services/governanceParsers.js';
import { getOfficerRoster, mergeLeadership, mergeBoard } from '../services/officerRoster.js';
import { getCustomerConcentration } from '../services/xbrlConcentration.js';
import { getPeers, getPeerSnapshot, getEarnings, getConsensus } from '../services/marketData.js';
import { getNewsForTicker } from '../services/news.js';
import { getWorldIndices, REGION_ORDER } from '../services/worldIndices.js';
import { getInsiderTransactions } from '../services/insiderTx.js';
import { getLiveQuotes } from '../services/liveQuotes.js';
import { searchSymbols, getRecentFilings, getCompanyIdentity } from '../services/secFilings.js';
import { getWeatherImpact } from '../services/weatherSignals.js';
import { getActiveAlerts } from '../services/wxAlerts.js';
import { getMacroSensitivity } from '../services/factorSensitivity.js';
import { scanUniverse as scanInsiderClusters } from '../services/insiderClusters.js';
import {
  listResearch,
  getResearchItem,
  summariesFor,
} from '../services/internalResearch.js';
import { extractFileText } from '../services/fileSummarizer.js';
import { getWireHeadlines, getWireHealth } from '../services/newsFeeds.js';
import {
  scoreBreaking,
  filterBreaking,
  BREAKING_THRESHOLD,
} from '../services/breakingClassifier.js';

// Terminal — AI-driven endpoints that back the /terminal workstation.
// Quote/news/fundamentals data is reused from /api/holdings/* (already
// gated by verifyJwt). This router only owns the AI-shaped endpoints:
//   POST /api/terminal/annotate       AI brief for a panel
//   POST /api/terminal/parse-command  Natural language -> mnemonic command
//   POST /api/terminal/chat           Free-form chat with workspace context
//
// Gated to Analyst and above, plus the Advisory Board / Faculty Advisor.
// It was executive-only until the FLD field-research panel landed, which
// made that gate wrong: /api/research is requireRole('Analyst'), so the
// members most likely to be making the calls could do the fieldwork but
// could not open the surface built for it. JuniorAnalyst stays out — it
// is the default role for every Google self-signup. Advisory members are
// read-only across the rest of the app; the Terminal is a research
// surface that grants no operational permissions.

const router = Router();
router.use(verifyJwt);
router.use(requireTerminalAccess);

// Two limiters, because the router serves two kinds of traffic.
//
// The AI routes (annotate, chat, parse-command) each burn an LLM call
// and deserve a tight cap. Everything else is cache-backed data, and
// the native terminal POLLS it: the focus quote every 20s, intraday
// every 30s, news every 60s. Mounting the AI cap router-wide — which
// is what this used to do — meant a member with three live panels
// open hit "AI rate limit reached" from requests that never touched
// a model, and the terminal went dark for ten minutes.
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => `terminal-ai:${req.user?.id || req.ip}`,
  message: { error: 'Terminal AI rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dataLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 900,
  keyGenerator: (req) => `terminal-data:${req.user?.id || req.ip}`,
  message: { error: 'Terminal rate limit reached. Slow the polling down and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(dataLimiter);

const KNOWN_FUNCTIONS = [
  { id: 'DES', label: 'Description', summary: 'Company snapshot: quote, fundamentals, business summary, AI brief.' },
  { id: 'GP', label: 'Chart', summary: 'Price chart with selectable interval.' },
  { id: 'GIP', label: 'Intraday Price', summary: 'Today\'s intraday price line with pre/post-market, vs prior close.' },
  { id: 'CN', label: 'Company News', summary: 'Latest news headlines for the focused ticker.' },
  { id: 'FA', label: 'Financial Analysis', summary: 'Multi-year fundamentals deep dive.' },
  { id: 'GF', label: 'Graph Fundamentals', summary: 'Revenue, margins, EPS and cash flow plotted over time from SEC XBRL.' },
  { id: 'FIL', label: 'Filings', summary: 'Recent SEC filings (8-K / 10-Q / 10-K / DEF 14A / Form 4) with an AI read of each.' },
  { id: 'PEER', label: 'Peers', summary: 'Sector peer comparison table.' },
  { id: 'INSDR', label: 'Insider Activity', summary: 'Form 4 insider buys/sells overlaid on the price chart.' },
  { id: 'EARN', label: 'Earnings', summary: 'Next report date + estimate and a trailing EPS beat/miss history.' },
  { id: 'CON', label: 'Analyst Consensus', summary: 'Analyst buy/hold/sell breakdown and recent trend.' },
  { id: 'CMP', label: 'Compare', summary: '2–4 tickers side by side: live price, day %, and key valuation.' },
  { id: 'ICLUSTER', label: 'Insider Clusters', summary: 'Multi-insider open-market buy clusters across the book (last 60d).' },
  { id: 'NOTE', label: 'Notes', summary: 'Your private research notes for this ticker, saved to your profile.' },
  { id: 'MGMT', label: 'Management & Board', summary: 'CEO, executives, board, compensation, and interlocking-board network from the latest DEF 14A.' },
  { id: 'BI', label: 'Bloomberg Intelligence', summary: 'Free-form research chat with workspace context.' },
  { id: 'WEI', label: 'World Equity Indices', summary: 'Global index snapshot.' },
  { id: 'TOP', label: 'Top News', summary: 'Market-wide top headlines.' },
  { id: 'MOVR', label: 'Movers', summary: 'Day\'s biggest gainers and losers.' },
  { id: 'PM', label: 'Portfolio Manager', summary: 'The whole book: positions, weights, live value and P&L, sector allocation.' },
  { id: 'SPLC', label: 'Supply Chain', summary: 'Customers, suppliers and key inputs named in the latest 10-K, with stated revenue concentration.' },
  { id: 'ECO', label: 'Economic Calendar', summary: 'Upcoming releases and central bank events.' },
  { id: 'WX', label: 'Weather Impact', summary: 'Named-storm landfalls vs. Gulf O&G + P&C insurer baskets; historical playbook + active-storm feed.' },
  { id: 'RDR', label: 'Weather Radar', summary: 'Live US NEXRAD radar + active NWS warning polygons (tornado / severe TS / flood / winter / tropical).' },
  { id: 'ORG', label: 'Organization', summary: 'The club org chart: leadership tiers and industry groups (PM and above).' },
  { id: 'MACRO', label: 'Macro Sensitivity', summary: 'Portfolio β to 10Y / WTI / USD / VIX / SPY (252-day OLS), top contributors, scenario preview.' },
  { id: 'RSCH', label: 'Research', summary: 'The whole research effort on one company — the brief and questions it set out to answer, who we reached out to, interviews and transcripts, site visits, valuation models, filings and data, and the claim ledger with each claim pinned to a source and timestamp. Also answers to FLD, which is what it was called when it only held fieldwork.' },
  { id: 'FLD', label: 'Research', summary: 'Alias for RSCH.' },
  { id: 'ARCH', label: 'Archive', summary: 'The club\'s own archive — research reports and pitch decks we have already written, readable in full with their AI summaries. Ticker-scoped or searched across everything. Finished write-ups; RSCH is the work and the evidence they were built from.' },
  { id: 'HELP', label: 'Help', summary: 'List of available terminal functions.' },
];

router.get('/functions', (_req, res) => {
  res.json({ functions: KNOWN_FUNCTIONS });
});

// Chart history. Reads from the PriceBar cache (services/priceHistory.js)
// which lazy-backfills 5y on first sighting of a ticker and tops up daily
// via the price-cache cron. Falls back to a direct Yahoo proxy if the
// cache layer throws unexpectedly so a single bad row doesn't kill GP.
router.get('/chart/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  const range = String(req.query.range || '6mo');
  if (!/^(1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/.test(range)) {
    return res.status(400).json({ error: 'Invalid range' });
  }
  try {
    const bars = await getHistory(raw, range);
    // Forward the whole OHLCV bar, not just the close. GP draws the close
    // line but reads open/high/low/volume for its session header, and a
    // candlestick mode would want them too — the PriceBar cache already
    // carries them, so collapsing to {t, close} here only made the panel
    // re-derive what we'd just thrown away.
    const points = bars.map((b) => ({
      t: new Date(b.date).getTime(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    res.json({ ticker: raw, range, interval: '1d', points, _source: 'cache' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Ticker not found' });
    console.error(`terminal/chart(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Chart fetch failed' });
  }
});

// GIP — today's intraday line (NASDAQ chart endpoint, ~1-min points,
// pre/post-market included). Ephemeral; no PriceBar cache involved.
router.get('/intraday/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    res.json(await getIntraday(raw));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Ticker not found' });
    if (err.status === 400) return res.status(400).json({ error: 'Invalid ticker' });
    console.error(`terminal/intraday(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Intraday fetch failed' });
  }
});

// GF — graph fundamentals. Structured income-statement / cash-flow
// figures from SEC XBRL companyfacts (services/secFundamentals.js),
// normalized to annual or quarterly period rows with derived margins.
// Best-effort and US-centric: a ticker SEC doesn't tag (many ADRs,
// funds) comes back as an empty rows array, not an error.
router.get('/fundamentals/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  const freq = req.query.freq === 'quarterly' ? 'quarterly' : 'annual';
  try {
    res.json(await getFundamentals(raw, freq));
  } catch (err) {
    if (err.status === 404)
      // The service knows WHY — a fund, a foreign filer, an unknown
      // symbol — and replacing that with one flat sentence threw the
      // only useful part away.
      return res.status(404).json({ error: err.message || 'No SEC fundamentals for this ticker' });
    // Our outage, not a fact about the company. A different status so
    // the panel can offer a retry rather than an explanation.
    if (err.status === 503) return res.status(503).json({ error: err.message });
    if (err.status === 400)
      return res.status(400).json({ error: 'Invalid ticker' });
    // The real message, not a bare "failed". A panel that says only
    // that a fetch failed sends somebody to the server logs for a fact
    // the response could have carried, and on Render that is a slow
    // trip for a one-line answer.
    console.error(`terminal/fundamentals(${raw}) failed:`, err.message);
    res.status(502).json({ error: `Fundamentals fetch failed: ${err.message}` });
  }
});

// FA — the full income statement, balance sheet, and cash-flow statement
// line by line, periods as columns. Annual or quarterly (Q4 derived).
router.get('/statements/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  const freq = req.query.freq === 'quarterly' ? 'quarterly' : 'annual';
  try {
    res.json(await getStatements(raw, freq));
  } catch (err) {
    if (err.status === 404)
      return res.status(404).json({ error: err.message || 'No SEC statements for this ticker' });
    // Our outage, not a fact about the company. A different status so
    // the panel can offer a retry rather than an explanation.
    if (err.status === 503) return res.status(503).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: 'Invalid ticker' });
    console.error(`terminal/statements(${raw}) failed:`, err.message);
    res.status(502).json({ error: `Statements fetch failed: ${err.message}` });
  }
});

// INSDR — insider Form 4 activity for a ticker. Service is best-effort
// (Finnhub primary, SEC EDGAR fallback) and never throws; an empty
// result is a normal 200 so the panel can say "no activity".
router.get('/insiders/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const data = await getInsiderTransactions(raw);
    res.json(data);
  } catch (err) {
    console.error(`terminal/insiders(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Insider data unavailable' });
  }
});

// MGMT — leadership, board, comp and interlocking-board network for a
// ticker, all from its latest DEF 14A. Every section is best-effort
// and independently nullable; an unparseable proxy is a normal 200.
// Background bio hunt for directors the proxy left storyless. Same
// ladder as the officers — the SEC's own documents first, Wikipedia
// after — run off the request path and persisted, so each governance
// open gets a little richer than the last without ever waiting.
// Sequential and capped: directors are many and EDGAR is patient with
// the polite.
async function enrichDirectorBios(ticker, fullBoard) {
  const missing = (fullBoard || []).filter((d) => d?.name && !d.bio).slice(0, 6);
  if (missing.length === 0) return;
  const identity = await getCompanyIdentity(ticker).catch(() => null);
  const companyName = identity?.legalName || identity?.name || ticker;
  const enriched = [];
  for (const d of missing) {
    let found = null;
    if (identity?.cik) {
      found = await filingBio(d.name, identity.cik).catch(() => null);
    }
    if (!found) {
      const w = await wikipediaBio(d.name, companyName).catch(() => null);
      if (w) found = { bio: w.bio, url: w.url, source: 'Wikipedia' };
    }
    if (found) {
      enriched.push({
        name: d.name, title: d.title || null,
        bio: found.bio, bioSource: found.source, bioUrl: found.url,
      });
    }
  }
  if (enriched.length > 0) {
    await saveProfiles(ticker, enriched, 'director');
  }
}

router.get('/governance/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const proxy = await getProxyStatement(raw);
    const parsed = parseLeadership(proxy.html);
    const board = parseBoard(proxy.html);
    const comp = parseComp(proxy.html);

    // The proxy names who was PAID last year; ownership filings name who
    // holds the office today. Where they disagree the filings win, and
    // they disagree whenever somebody changed jobs mid-year — which is
    // the only time anyone is looking. Best-effort: an unreachable
    // roster leaves the proxy reading exactly as it did before.
    const roster = await getOfficerRoster(raw).catch(() => null);
    const { ceo, execs, leadership } = mergeLeadership(parsed, roster, { proxyFiledAt: proxy.filedAt });
    let holdings = [];
    try {
      const hp = await getSheetPortfolio();
      const arr = Array.isArray(hp) ? hp : (hp?.holdings || []);
      holdings = arr.map((h) => ({ ticker: h.ticker || '', name: h.name || '' }));
    } catch {
      holdings = [];
    }
    const fullBoard = mergeBoard(board, roster);
    const network = buildNetwork(raw, fullBoard, holdings);

    // A director the proxy parse left storyless gets the saved bio if
    // one exists — the panel reads from the union of this parse and
    // every parse and enrichment before it.
    try {
      const savedRows = await storedProfiles(raw, 'director');
      const savedByName = new Map(savedRows.map((r) => [r.name, r]));
      for (const d of fullBoard || []) {
        const s = d?.name ? savedByName.get(d.name) : null;
        if (s?.bio && !d.bio) {
          d.bio = s.bio;
          d.bioSource = s.bioSource;
          d.bioUrl = s.bioUrl;
        }
      }
    } catch {
      /* the live parse stands alone */
    }

    // Remember everyone. The proxy parse only has to succeed ONCE for
    // the board to survive every future throttle and restart; the old
    // memory-cache-only design re-earned the same facts daily and
    // showed an empty panel whenever it lost.
    saveProfiles(
      raw,
      (fullBoard || []).map((d) => ({
        name: d.name, title: d.title || null, bio: d.bio || null,
        bioSource: d.bio ? (d.bioSource || 'DEF 14A') : null,
        bioUrl: d.bio ? (d.bioUrl || proxy._source || null) : null,
      })),
      'director'
    ).catch(() => {});

    // Directors the proxy never described get the same fallback ladder
    // the officers got — in the background, because a governance open
    // must not wait on a walk through EDGAR. This request serves what
    // it has; the enrichment lands in PersonProfile and the NEXT open
    // (and the merge above) shows it.
    enrichDirectorBios(raw, fullBoard).catch(() => {});

    res.json({
      ticker: raw, asOf: proxy.filedAt, source: proxy._source,
      ceo, execs, board: fullBoard, comp, network,
      // The provenance of the two halves, said out loud: the roster is
      // days old, the pay figures are a year old, and a reader deciding
      // whether to trust a name needs to know which they are looking at.
      leadership,
    });
  } catch (err) {
    console.error(`terminal/governance(${raw}) failed:`, err.message);
    // Before admitting defeat, serve what previous successes banked.
    // A day-old board beats a blank one on every question this panel
    // answers; `stored` flags the vintage so the client can say so.
    try {
      const rows = await storedProfiles(raw, 'director');
      if (rows.length > 0) {
        return res.json({
          ticker: raw, asOf: null, source: null, stored: true,
          ceo: null, execs: [], comp: null, network: null, leadership: null,
          board: rows.map((r) => ({ name: r.name, title: r.title, bio: r.bio })),
        });
      }
    } catch {
      /* the 502 below is the honest answer */
    }
    res.status(502).json({ error: 'Governance data unavailable' });
  }
});

// MGMT, executive half — per-officer bios pulled lazily from the 10-K
// (directors' bios already ride the DEF 14A in /governance above; the
// SEC puts the officer disclosure in the 10-K, not the proxy). Split
// out as its own endpoint so the panel only pays the second filing
// fetch when a user actually opens an exec card.
//
// Unlike /governance, the service here (executiveBios.js) is itself
// never-throws and returns an honest empty stub on any miss — no 10-K,
// fetch error, or the incorporated-by-reference filers (MLAB, AAPL)
// that carry no officer section at all. So a parse miss is a normal
// 200 with officers:[], never a 5xx; the modal renders "no bios
// disclosed" rather than an error. The handler is extracted with an
// injectable service (same shape executiveBios.test.js uses to stay
// off the network) and still wraps the call in its own try/catch:
// even though the service contract is never-throws, the route does not
// rely on that to hold — any unexpected rejection still degrades to
// the same honest-empty 200, so this endpoint can never 5xx.
export async function execBiosHandler(req, res, deps = {}) {
  const fetchBios = deps.getExecutiveBios || getExecutiveBios;
  const fetchRoster = deps.getOfficerRoster || getOfficerRoster;
  const fetchWiki = deps.wikipediaBio || wikipediaBio;
  const fetchFilingBio = deps.filingBio || filingBio;
  const fetchIdentity = deps.getCompanyIdentity || getCompanyIdentity;
  const loadStored = deps.storedProfiles || storedProfiles;
  const persist = deps.saveProfiles || saveProfiles;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    // Three sources, in trust order. The 10-K's own officer section is
    // the primary; the Form 3/4 roster supplies the NAMES for filers
    // (Apple among them) that incorporate the section by reference and
    // describe nobody; Wikipedia fills a missing story for people
    // public enough to have one, clearly labelled. Everything lands in
    // PersonProfile, so once seen, a bio survives restarts, throttles
    // and parser regressions — "no bios" was mostly "not saved".
    const [kBios, roster, identity] = await Promise.all([
      fetchBios(raw).catch(() => ({ source: null, officers: [] })),
      fetchRoster(raw).catch(() => ({ officers: [] })),
      fetchIdentity(raw).catch(() => null),
    ]);

    const byName = new Map();
    for (const o of kBios.officers || []) {
      if (!o?.name) continue;
      byName.set(o.name, { name: o.name, title: o.title || null, bio: o.bio || null,
                           bioSource: o.bio ? '10-K' : null, bioUrl: o.bio ? kBios.source : null });
    }
    for (const o of roster.officers || []) {
      const name = o?.name;
      if (!name) continue;
      // Directors file Forms 3/4 too, so the roster carries them — but
      // a board seat is not an office, and Art Levinson does not belong
      // on the executive card. Officers only; the board tab has the
      // rest. The departed stay off the card as well.
      if (o.former) continue;
      if (!(o.isOfficer || o.office || o.title)) continue;
      const hit = byName.get(name);
      if (hit) {
        if (!hit.title && (o.office || o.title)) hit.title = o.office || o.title;
      } else {
        byName.set(name, { name, title: o.office || o.title || null, bio: null,
                           bioSource: null, bioUrl: null });
      }
    }

    // For the bio-less, two fallback tiers in trust order. First the
    // SEC's own record: the appointment 8-K or proxy paragraph EDGAR
    // full-text search can find ("Kevan Parekh, 53, ... joined Apple
    // in June 2013"), which is a primary document about exactly this
    // person. Sequential, not fanned out — these are SEC requests and
    // bursts are how panels go dark. Then Wikipedia for whoever the
    // filings still leave untold, in parallel because it is keyless
    // and rate-generous.
    const companyName = identity?.legalName || identity?.name || raw;
    const missing = [...byName.values()].filter((p) => !p.bio).slice(0, 8);
    if (identity?.cik) {
      for (const p of missing) {
        if (p.bio) continue;
        const f = await fetchFilingBio(p.name, identity.cik).catch(() => null);
        if (f) {
          p.bio = f.bio;
          p.bioSource = f.source;
          p.bioUrl = f.url;
        }
      }
    }
    await Promise.all(
      missing.filter((p) => !p.bio).map(async (p) => {
        const w = await fetchWiki(p.name, companyName).catch(() => null);
        if (w) {
          p.bio = w.bio;
          p.bioSource = 'Wikipedia';
          p.bioUrl = w.url;
        }
      })
    );

    let officers = [...byName.values()];
    let source = kBios.source || null;
    let stored = false;
    if (officers.length === 0) {
      // Every live source came back empty — a throttled minute, most
      // likely. Serve what the table remembers rather than an empty
      // panel that reads as "this company has no management".
      const rows = await loadStored(raw, 'exec');
      officers = rows.map((r) => ({ name: r.name, title: r.title, bio: r.bio,
                                    bioSource: r.bioSource, bioUrl: r.bioUrl }));
      stored = officers.length > 0;
    } else {
      persist(raw, officers, 'exec').catch(() => {});
    }

    res.json({ ticker: raw, source, officers, stored });
  } catch (err) {
    console.warn(`terminal/exec-bios(${raw}) degraded:`, err.message);
    const rows = await loadStored(raw, 'exec').catch(() => []);
    res.json({
      ticker: raw, source: null, stored: rows.length > 0,
      officers: rows.map((r) => ({ name: r.name, title: r.title, bio: r.bio,
                                   bioSource: r.bioSource, bioUrl: r.bioUrl })),
    });
  }
}

router.get('/governance/:ticker/exec-bios', (req, res) =>
  execBiosHandler(req, res)
);

// EARN — a ticker's next scheduled report (date + EPS estimate) and a
// trailing beat/miss record (EPS estimate vs. actual + surprise %),
// off the same Finnhub /calendar/earnings feed PEER/holdings already
// use (one widened window; getEarnings owns the split + the shared
// 12h cache). The service is never-throws and returns its honest
// empty stub on any miss — ETFs, illiquid names, or no consensus
// coverage — so a coverage gap is a normal 200 with upcoming:null /
// history:[], never a 5xx; the panel says "no earnings data" and
// suppresses the AI brief rather than erroring. Handler extracted with
// an injectable service (the shape terminal.earnings.test.js uses to
// stay off the network) and wrapped in its own try/catch: even though
// the service contract is never-throws, the route does not lean on
// that — any unexpected rejection still degrades to the same honest-
// empty 200 with a warn, so this endpoint can never 5xx.
export async function earningsHandler(req, res, deps = {}) {
  const fetchEarnings = deps.getEarnings || getEarnings;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const { upcoming, history } = await fetchEarnings(raw);
    res.json({ ticker: raw, upcoming, history });
  } catch (err) {
    console.warn(`terminal/earnings(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, upcoming: null, history: [] });
  }
}

router.get('/earnings/:ticker', (req, res) => earningsHandler(req, res));

// CON — a ticker's analyst buy/hold/sell breakdown (the latest period)
// plus the recent trend, off the same Finnhub /stock/recommendation
// feed Peers already consumes; getConsensus owns the newest-first
// reshape and shares the recommendation cache (its own namespaced
// key). The service is never-throws and returns its honest empty stub
// on any miss — ETFs, illiquid names, or no analyst coverage — so a
// coverage gap is a normal 200 with latest:null / trend:[], never a
// 5xx; the panel says "no analyst coverage" and suppresses the AI
// brief rather than erroring. Handler extracted with an injectable
// service (the shape terminal.consensus.test.js uses to stay off the
// network) and wrapped in its own try/catch: even though the service
// contract is never-throws, the route does not lean on that — any
// unexpected rejection still degrades to the same honest-empty 200
// with a warn, so this endpoint can never 5xx.
export async function consensusHandler(req, res, deps = {}) {
  const fetchConsensus = deps.getConsensus || getConsensus;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const { latest, trend } = await fetchConsensus(raw);
    res.json({ ticker: raw, latest, trend });
  } catch (err) {
    console.warn(`terminal/consensus(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, latest: null, trend: [] });
  }
}

router.get('/consensus/:ticker', (req, res) => consensusHandler(req, res));

// GET /quotes?tickers=A,B,C — the only live-price tap the terminal's
// quote panels (DES, Peers, MOVR) draw on. Thin by design: it owns the
// abuse net, not the cache. liveQuotes.js already de-dupes/upper-cases
// and deliberately does not cap (a caller passes only its on-screen
// set); the route caps at 40 so a hand-crafted ?tickers= can't fan a
// single request into a Finnhub burst — on-screen sets are an order of
// magnitude smaller, so a legitimate panel never trips it. A simply-
// empty list is not an error: unlike the single-path-param governance
// routes (which 400 a malformed ticker), this takes a free-form list
// and the service itself degrades empty/junk to {}, so the lenient,
// honest answer is a 200 {} — the same never-error posture as exec-bios
// rather than a 4xx.
//
// Handler extracted with an injectable service (the shape
// terminal.quotes.test.js uses to stay off the network) and wrapped in
// its own try/catch: liveQuotes.js is contractually never-throws, but
// the route does not lean on that — any unexpected rejection still
// degrades to a 200 {} with a warn, so this endpoint can never 5xx and
// a failed poll just leaves the panel on its last good values.
// Which US equity session the wall clock is in, New York time.
// Half-days and holidays are not modelled: on a holiday the extended
// merge simply finds no fresher print and changes nothing, which is
// the correct degraded behaviour for free data.
export function usSession(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return 'closed';
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'regular';
  if (mins >= 16 * 60 && mins < 20 * 60) return 'post';
  return 'closed';
}

// How many tickers per request get the NASDAQ extended-hours lookup.
// The scrape is memoized 45s per ticker server-side, so a polling
// client warms its set once and then rides the cache — but a first
// call for forty names would still be forty scrapes, and NASDAQ's
// patience is not a renewable resource.
const EXTENDED_MERGE_CAP = 20;

export async function quotesHandler(req, res, deps = {}) {
  const fetchQuotes = deps.getLiveQuotes || getLiveQuotes;
  // Clock and intraday source are injectable for the same reason the
  // quote service is: the extended-hours merge depends on the wall
  // clock and a network scrape, and a unit test that inherits either
  // from reality is a test that fails at 4:30pm and passes at noon.
  const nowFn = deps.now || (() => new Date());
  const fetchIntraday = deps.getIntraday || getIntraday;
  const list = Array.from(
    new Set(
      String(req.query?.tickers || '')
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 40);
  if (list.length === 0) return res.json({});
  try {
    const out = await fetchQuotes(list);

    // Outside regular hours Finnhub's free quote freezes at the close,
    // which starved the terminals' tick-flash for a third of the
    // trading day people actually watch. NASDAQ's intraday feed (the
    // one GIP already scrapes) carries pre- and post-market prints, so
    // in those windows the freshest print wins. Semantics kept honest:
    //   last        — the extended print
    //   close       — today's regular close (what `last` used to freeze at)
    //   changePct   — still vs prevClose, so the number reads
    //                 continuously with what the panel showed at 3:59
    //   extendedPct — the extended move vs today's close, separately,
    //                 because Bloomberg is right to show them apart
    const session = usSession(nowFn());
    if (session === 'pre' || session === 'post') {
      const targets = list.slice(0, EXTENDED_MERGE_CAP);
      const results = await Promise.allSettled(targets.map((t) => fetchIntraday(t)));
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled' || r.value?.last == null) return;
        const t = targets[i];
        const base = out[t];
        const close = base?.last ?? null;
        const prevClose = base?.prevClose ?? r.value.prevClose ?? null;
        const last = r.value.last;
        // A print identical to the close is not extended information —
        // leave the quote untouched rather than dressing it up.
        if (close != null && last === close) {
          out[t] = { ...base, session };
          return;
        }
        out[t] = {
          last,
          prevClose,
          changePct: prevClose ? ((last - prevClose) / prevClose) * 100 : base?.changePct ?? null,
          close,
          extendedPct: close ? ((last - close) / close) * 100 : null,
          session,
        };
      });
    }
    res.json(out);
  } catch (err) {
    console.warn('terminal/quotes degraded:', err.message);
    res.json({});
  }
}

router.get('/quotes', (req, res) => quotesHandler(req, res));

// CMP — 2–4 tickers side by side: the comparison columns Peers
// already shows (name, mkt cap, P/E, fwd P/E, div, beta) for an
// arbitrary user-picked set rather than a sector peer list. Pure
// reuse of getPeerSnapshot — the same per-name fundamentals bundle
// PEER lifts, one snapshot per requested ticker, sharing its 15m
// cache; there is no new Finnhub path here. Live price + day % are
// not this route's job: the panel overlays /terminal/quotes via
// useLiveRefresh exactly like Peers/Movers, so /compare stays the
// slow fundamentals snapshot only.
//
// The ?tickers list is normalized by the identical rule
// quotesHandler uses (split, trim, upper-case, drop empties, dedupe)
// but capped at 4 — the panel never compares more than four, and the
// cap keeps a hand-crafted list from fanning into a snapshot burst.
// One row per requested ticker is the contract: a snapshot miss
// (unknown symbol, Finnhub gap, or even a per-ticker rejection) keeps
// the row with every fundamental nulled so the panel still renders a
// column for every name the user asked for. An empty list is the
// lenient honest 200 { tickers:[], rows:[] }, not a 4xx — the same
// free-form-list posture as /quotes, not the single-path-param
// governance guards.
//
// Handler extracted with an injectable service (the shape
// terminal.compare.test.js uses to stay off the network) and wrapped
// in its own try/catch around both the per-ticker fetch and the
// whole pass: getPeerSnapshot is contractually never-throws, but the
// route does not lean on that — a per-ticker rejection degrades that
// row, and any handler-level failure degrades to a 200
// { tickers:[], rows:[] } with a warn, so this endpoint can never
// 5xx.
export async function compareHandler(req, res, deps = {}) {
  const fetchSnapshot = deps.getPeerSnapshot || getPeerSnapshot;
  try {
    const list = Array.from(
      new Set(
        String(req.query?.tickers || '')
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean)
      )
    ).slice(0, 4);
    if (list.length === 0) return res.json({ tickers: [], rows: [] });

    const snaps = await Promise.all(
      list.map((t) => Promise.resolve(fetchSnapshot(t)).catch(() => null))
    );

    const rows = list.map((t, i) => {
      const s = snaps[i];
      return {
        ticker: t,
        name: s?.name ?? null,
        marketCap: s?.marketCap ?? null,
        peRatio: s?.trailingPE ?? null,
        forwardPE: s?.forwardPE ?? null,
        dividendYield: s?.dividendYield ?? null,
        beta: s?.beta ?? null,
      };
    });
    res.json({ tickers: list, rows });
  } catch (err) {
    console.warn('terminal/compare degraded:', err.message);
    res.json({ tickers: [], rows: [] });
  }
}

router.get('/compare', (req, res) => compareHandler(req, res));

// FIL — a ticker's recent SEC filings (8-K, 10-Q, 10-K, DEF 14A,
// Form 4 …) straight off the EDGAR submissions feed. Pure reuse of
// secFilings.js: getRecentFilings already backs holdings.js and owns
// its own 6h per-ticker cache, ticker→CIK resolution (including the
// dot/dash share-class convention), and the never-throws empty
// degrade — there is no new SEC fetch path here. We pull a 40-row
// window: deep enough that an annual DEF 14A or 10-K isn't buried
// behind a torrent of 8-Ks/Form 4s for an active large-cap, while
// still a single cached JSON read.
//
// Handler extracted with an injectable service (the shape
// terminal.filings.test.js uses to stay off the network) and wrapped
// in its own try/catch: getRecentFilings is contractually never-
// throws (it returns [] on any miss), but the route does not lean on
// that — any unexpected rejection still degrades to a 200
// { ticker, filings: [] } with a warn, so this endpoint can never
// 5xx and the panel says "no recent filings" rather than erroring.
// A malformed path param is the one 400, matching the sibling
// /governance and exec-bios input guards exactly.
export async function filingsHandler(req, res, deps = {}) {
  const fetchFilings = deps.getRecentFilings || getRecentFilings;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const filings = await fetchFilings(raw, { limit: 40 });
    res.json({ ticker: raw, filings: Array.isArray(filings) ? filings : [] });
  } catch (err) {
    console.warn(`terminal/filings(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, filings: [] });
  }
}

router.get('/filings/:ticker', (req, res) => filingsHandler(req, res));

// WX — Weather Impact. Maps US-landfall named storms (the HURDAT2
// archive, 2020-present) to two curated exposure baskets — Gulf O&G
// and US P&C insurers — and runs a SPY-relative forward-return
// event-study against the price-bar cache. The output is a historical
// playbook, not a forecast: the same eventStudy primitive shipped here
// powers the next sub-project (macro factor sensitivity) and gets the
// math right once. The route folds in the user's holdings (cash
// excluded) so the panel can call out where the user is overlapped on
// each basket. The NHC live active-storm feed is best-effort and
// degrades silently — historical playbook still works without it.
//
// Handler extracted with injectable services (deps.getWeatherImpact +
// deps.getSheetPortfolio for the holdings) and wrapped in its own
// try/catch: the weatherSignals service is contractually never-throws
// (it owns its own NHC + per-exposure try/catches), but the route does
// not lean on that — any unexpected rejection still degrades to a
// 200 honest-empty { activeStorms:[], exposures:[] } with a warn, so
// this endpoint can never 5xx. An unreachable sheet just collapses
// the holdings overlap to []; the exposures still surface their
// historical study.
export async function weatherImpactHandler(req, res, deps = {}) {
  const fetchImpact = deps.getWeatherImpact || getWeatherImpact;
  const fetchPortfolio = deps.getSheetPortfolio || getSheetPortfolio;
  try {
    let holdings = [];
    try {
      const hp = await fetchPortfolio();
      const arr = Array.isArray(hp) ? hp : hp?.holdings || [];
      holdings = arr
        .filter((h) => !h?.isCash)
        .map((h) => String(h?.ticker || '').toUpperCase())
        .filter(Boolean);
    } catch (err) {
      console.warn('terminal/weather-impact: sheet read failed:', err.message);
      holdings = [];
    }
    const data = await fetchImpact(holdings);
    // "There is an active storm" and "we hold GD" are two facts a reader
    // has to join by hand. The one they wanted is which of OUR plants
    // the storm is actually near, and that is answerable now that
    // facilities carry coordinates.
    res.json({ ...data, stormExposure: await stormExposure(data.activeStorms, holdings, deps) });
  } catch (err) {
    console.warn('terminal/weather-impact degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      activeStorms: [],
      exposures: [],
    });
  }
}

// RDR — Weather Radar. The radar imagery is NEXRAD tiles the client
// pulls browser-side from the Iowa Mesonet, so this endpoint only
// proxies the warning polygons: NWS requires a User-Agent header a
// browser fetch can't set, the same wall the SEC services work around.
// wxAlerts is contractually never-throws, but the route wraps it
// anyway so an unexpected rejection still degrades to a 200
// honest-empty FeatureCollection rather than a 5xx.

/// Our own sites inside a storm's reach.
///
/// Bounded on purpose. This runs on a panel open, and resolving the
/// estate of a dozen holdings is a dozen EPA reads — so only tickers we
/// already hold are considered, only storms with a position, and a site
/// with no coordinates is skipped rather than guessed at. An address is
/// not a position, and a plant placed by assumption is worse than a
/// plant left out.
async function stormExposure(storms, holdings, deps = {}) {
  const placed = (storms || []).filter(
    (s) => Number.isFinite(Number(s?.latitude)) && Number.isFinite(Number(s?.longitude))
  );
  if (!placed.length || !holdings.length) return [];
  const facilitiesFor = deps.getFacilities || getFacilities;
  const cikFor = deps.resolveCik || resolveCik;
  const out = [];
  for (const storm of placed) {
    const near = [];
    for (const ticker of holdings.slice(0, 15)) {
      try {
        // The registered name, because EPA's parent field carries the
        // legal entity rather than the ticker.
        const info = await cikFor(ticker);
        if (!info?.name) continue;
        const { facilities } = await facilitiesFor(info.name);
        const hits = sitesNearStorm(facilities, storm, 300);
        for (const h of hits.slice(0, 6)) near.push({ ticker, ...h });
      } catch {
        // One unreachable estate must not empty the whole answer.
      }
    }
    near.sort((a, b) => a.milesFromStorm - b.milesFromStorm);
    out.push({
      storm: storm.name || 'Unnamed',
      classification: storm.classification || null,
      sites: near.slice(0, 25),
      // Said out loud, because "no sites near this storm" and "none of
      // these companies report plants to EPA" are different findings.
      checked: holdings.slice(0, 15).length,
    });
  }
  return out;
}

export async function weatherAlertsHandler(req, res, deps = {}) {
  const fetchAlerts = deps.getActiveAlerts || getActiveAlerts;
  try {
    res.json(await fetchAlerts());
  } catch (err) {
    console.warn('terminal/wx-alerts degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      total: 0,
      mappedCount: 0,
      areaOnlyCount: 0,
      counts: {},
      features: { type: 'FeatureCollection', features: [] },
      list: [],
    });
  }
}

// MACRO — portfolio sensitivity to the five macro factors (10Y yield,
// WTI oil, USD index, VIX, SPY) over a 252-trading-day OLS. The whole
// matrix is assembled by factorSensitivity.js: every holding × every
// factor's daily regression, aggregated to a portfolio β per factor
// with the n≥60 filter + weight redistribution + top-3 contributors
// + a default-shock scenario preview. The service is never-throws and
// returns honest empty (lookbackDays only, factors:[], holdings:[],
// marketValues:{}) on any failure mode — a missing FRED_API_KEY, a
// sheet outage, a NASDAQ 502 on the price-bar refresh — so the panel
// always paints a stable frame and the empty-state copy ("FRED
// unavailable") never collapses into a 5xx splash.
//
// Handler extracted with an injectable service (the shape
// terminal.macroSensitivity.test.js uses to stay off both the FRED
// observation feed and the price-bar cache) and wrapped in its own
// try/catch: getMacroSensitivity is contractually never-throws, but
// the route does not lean on that — any unexpected rejection still
// degrades to the same honest-empty 200 with a warn, so this endpoint
// can never 5xx.
export async function macroSensitivityHandler(req, res, deps = {}) {
  const fetchMatrix = deps.getMacroSensitivity || getMacroSensitivity;
  try {
    const data = await fetchMatrix();
    res.json(data);
  } catch (err) {
    console.warn('terminal/macro-sensitivity degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      lookbackDays: 252,
      factors: [],
      holdings: [],
      marketValues: {},
    });
  }
}

// ICLUSTER — multi-insider open-market buy clusters across a small
// universe (v1 = the fund's holdings, optionally + watchlist if its
// route ships). The whole methodology — 60d window, ≥3 distinct
// insiders, code-P only, role-weighted score, into-weakness flag — is
// the cluster service's call; this route owns the universe-building
// (cash filter, watchlist loose-coupling, ?tickers= override, 50-
// ticker defensive cap) and the honest-empty degrade.
//
// The watchlist is loose-coupled per the spec: PR #32 hasn't merged on
// this branch, so we attempt a dynamic import of the future watchlist
// service and silently fall back to "holdings only" when it isn't
// there. Once #32 ships, the same import resolves and a default
// watchlist provider is mixed in without touching this file. A test-
// injected deps.getWatchlistTickers wins outright (a throw is also
// degraded so a flaky watchlist read never breaks the cluster scan).
//
// scanUniverse is contractually never-throws (per-ticker errors are
// absorbed by getTickerCluster), but the route does not lean on that —
// any unexpected rejection still degrades to a 200 honest-empty
// { asOf, universe:[], results:[] } with a console.warn so this
// endpoint can never 5xx.
//
// IMPORTANT FRAMING: per the spec this is a SCREEN, not a backtested
// signal. The panel footer and the AI brief both carry that line —
// the data layer surfaces the pattern, the UI never overstates it.
export async function insiderClustersHandler(req, res, deps = {}) {
  const scan = deps.scanUniverse || scanInsiderClusters;
  const fetchPortfolio = deps.getSheetPortfolio || getSheetPortfolio;
  // The watchlist provider on this branch doesn't exist yet. When the
  // tests inject one, it wins; otherwise we try the dynamic import,
  // and if that yields nothing useful we skip it silently.
  let fetchWatchlist = deps.getWatchlistTickers;
  if (!fetchWatchlist) {
    try {
      const mod = await import('./watchlist.js');
      if (mod && typeof mod.getWatchlistTickers === 'function') {
        fetchWatchlist = mod.getWatchlistTickers;
      }
    } catch {
      // ERR_MODULE_NOT_FOUND on this branch — expected; nothing to do.
    }
  }

  try {
    // ?tickers=A,B,C overrides the computed universe entirely — the
    // same split/trim/upper-case/dedupe normalization /quotes uses.
    const raw = String(req.query?.tickers || '').trim();
    let list;
    if (raw) {
      list = Array.from(
        new Set(
          raw
            .split(',')
            .map((t) => t.trim().toUpperCase())
            .filter(Boolean)
        )
      );
    } else {
      const holdings = await (async () => {
        try {
          const p = await fetchPortfolio();
          const arr = Array.isArray(p) ? p : p?.holdings || [];
          return arr
            .filter((h) => h && !h.isCash)
            .map((h) => String(h.ticker || '').trim().toUpperCase())
            .filter(Boolean);
        } catch (err) {
          console.warn('insiderClusters portfolio degraded:', err.message);
          return [];
        }
      })();
      const watch = fetchWatchlist
        ? await (async () => {
            try {
              const arr = await fetchWatchlist();
              return Array.isArray(arr)
                ? arr.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean)
                : [];
            } catch (err) {
              // A missing or throwing watchlist provider is honestly
              // degraded — the universe falls back to holdings only.
              console.warn('insiderClusters watchlist degraded:', err.message);
              return [];
            }
          })()
        : [];
      list = Array.from(new Set([...holdings, ...watch]));
    }
    // Defensive cap so a hand-crafted ?tickers= can't fan one
    // request into a Finnhub burst. Legitimate universes are an
    // order of magnitude below this.
    list = list.slice(0, 50);

    const results = await scan(list);
    res.json({
      asOf: new Date().toISOString(),
      universe: list,
      results: Array.isArray(results) ? results : [],
    });
  } catch (err) {
    console.warn('terminal/insider-clusters degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      universe: [],
      results: [],
    });
  }
}

// FAC — where a company's plants are.
router.get('/facilities/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(raw)) return res.status(400).json({ error: 'Bad ticker' });
  try {
    const info = await resolveCik(raw);
    if (!info) return res.status(404).json({ error: `${raw} is not in SEC EDGAR.` });
    const out = await getFacilities(info.name);
    res.json({
      ticker: raw,
      company: info.name,
      ...out,
      // Said with the data, not in a tooltip: TRI covers manufacturers
      // over a reporting threshold, so an empty list means "does not
      // report to TRI" and never "has no operations".
      source: 'EPA Toxics Release Inventory, facilities whose parent company matches',
      caveat: 'TRI covers manufacturing and processing sites above a reporting threshold. Banks, insurers and most software companies file nothing here, so an empty list is not evidence of no operations.',
    });
  } catch (err) {
    console.error('facilities failed:', err.message);
    res.status(502).json({ error: `Could not reach the EPA facility registry: ${err.message}` });
  }
});

router.get('/weather-impact', (req, res) => weatherImpactHandler(req, res));
router.get('/wx-alerts', (req, res) => weatherAlertsHandler(req, res));
router.get('/macro-sensitivity', (req, res) => macroSensitivityHandler(req, res));
router.get('/insider-clusters', (req, res) => insiderClustersHandler(req, res));

// MOVR — every holding and how much it's up or down today, read live
// from the positions sheet (same source as the dashboard). Not the
// tickers charted in the terminal: the actual book. The sheet service
// caches 20m internally, so hitting this often is cheap. If the sheet
// is unreachable we surface that rather than a half-empty list — the
// panel renders the message.
// SECF, effectively: partial ticker or company name -> ranked matches
// from the SEC's registrant directory. Powers the command bar's
// security autocomplete on both terminals. Free data, 24h-cached map,
// in-memory scan — cheap enough to hit per keystroke behind the
// client's debounce.
router.get('/symbol-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length > 40) return res.json({ query: q, matches: [] });
  const matches = await searchSymbols(q, 8);
  if (matches === null) {
    return res.status(502).json({ error: 'Symbol directory unavailable right now.' });
  }
  res.json({ query: q, matches });
});

router.get('/movers', async (_req, res) => {
  try {
    const data = await getPortfolioMovers();
    res.json(data);
  } catch (err) {
    console.error('terminal/movers failed:', err.message);
    res.status(502).json({ error: 'Portfolio unavailable — could not read the positions sheet.' });
  }
});

// PM — the whole book, not just the day's movers: every position with
// its shares, average cost, market value, weight, and day / unrealized
// P&L, plus the fund totals. Same live sheet as MOVR (the system of
// record for what's actually held), but here we hand back the full row
// rather than the trimmed move. The panel overlays /quotes for live
// price and recomputes value, weight, and P&L on top — the way PORT
// keeps marks current between sheet reads.
// Year-to-date price return per position, derived rather than read.
//
// The positions sheet has a ytdReturn column in its header map and
// nobody fills it, so every holding came back with ytdReturn: null and
// both terminals had a column of dashes. The number is recoverable from
// price history we already cache: last close of the previous year
// against the current price.
//
// It is a PRICE return, not a total return. Dividends are not in the
// bar cache, so a name that pays them is understated, and the panels
// label the column so nobody reads it as performance including income.
// A stated approximation beats a silent one.
const ytdCache = new Map(); // ticker -> { at, pct }
const YTD_TTL_MS = 60 * 60 * 1000;

export async function ytdPriceReturn(ticker, currentPrice) {
  if (!ticker || currentPrice == null) return null;
  const hit = ytdCache.get(ticker);
  if (hit && Date.now() - hit.at < YTD_TTL_MS) return hit.pct;
  try {
    // getHistory returns a plain ARRAY of bars. The { points: [...] }
    // shape belongs to the /chart route, which maps them for the client
    // — and reading hist.points here silently yielded undefined for
    // every ticker, which the guard below then reported as "no usable
    // history". The endpoint worked, the function worked, and the two
    // were never speaking the same shape.
    //
    // The base is the previous year's FINAL close, which the 'ytd'
    // range cannot supply — its first bar is the first trading day of
    // this year, so anchoring there silently dropped the year's opening
    // session from every YTD figure. Pull a year of bars and walk to
    // the last one dated on or before Dec 31.
    const bars = await getHistory(ticker, '1y');
    const points = (Array.isArray(bars) ? bars : []).filter((b) => b?.close != null);
    if (points.length < 2) return null;
    const boundary = `${new Date().getFullYear() - 1}-12-31`;
    let base = null;
    for (const b of points) {
      // Bars arrive date-ascending, so the last one at or before the
      // boundary is the prior year's closing print.
      if (String(b.date) <= boundary) base = b.close;
      else break;
    }
    // No prior-year bar (an IPO this year, or history that thin): the
    // first bar of the current year is the honest fallback — exactly
    // the old behavior.
    if (base == null) base = points[0].close;
    if (!(base > 0)) return null;
    const pct = ((currentPrice - base) / base) * 100;
    ytdCache.set(ticker, { at: Date.now(), pct });
    return pct;
  } catch (err) {
    // A missing history must not cost the whole book its numbers, but
    // silence here is what made a systemic failure look like sparse
    // data. Say it once per ticker per hour.
    console.warn(`ytd ${ticker}: ${err.message}`);
    return null;
  }
}

router.get('/portfolio', async (_req, res) => {
  try {
    const data = await getSheetPortfolio();
    const rows = data?.holdings || [];
    // Only the positions actually missing it, so a sheet that starts
    // carrying the column wins and this stays a fallback.
    const need = rows.filter((h) => !h.isCash && h.ticker && h.ytdReturn == null && h.price != null);
    // Sequential, not a twelve-way fan-out. getHistory can reach the
    // upstream when a range is cold, and twelve of those at once is the
    // shape that gets rate-limited into returning nothing at all — which
    // is exactly what the first cut did: every position null, no error
    // anywhere, a column of dashes that looked like missing data rather
    // than a throttled fetch. Warm calls are DB reads and cost nothing.
    let filled = 0;
    let lastError = null;
    for (const h of need) {
      try {
        const pct = await ytdPriceReturn(h.ticker, h.price);
        if (pct != null) {
          h.ytdReturn = pct;
          h.ytdSource = 'price';
          filled += 1;
        } else if (!lastError) {
          lastError = `${h.ticker}: no usable history`;
        }
      } catch (err) {
        if (!lastError) lastError = `${h.ticker}: ${err.message}`;
      }
    }
    // Reported, not swallowed. A column of dashes is indistinguishable
    // from data the source never had, which is how this spent an hour
    // being debugged from the outside with no signal to work from. The
    // panel can now say which of the two it is looking at.
    data.ytdStatus = { needed: need.length, filled, lastError };
    res.json(data);
  } catch (err) {
    console.error('terminal/portfolio failed:', err.message);
    res.status(502).json({ error: 'Portfolio unavailable — could not read the positions sheet.' });
  }
});

// SPLC — supply-chain relationships extracted from the focused ticker's
// latest 10-K. Null when there's no US 10-K (foreign filers, ETFs); the
// panel renders that as "no filing" rather than an error.
router.get('/supply-chain/:ticker', async (req, res) => {
  try {
    // Two readings of the same filing, and they answer different
    // questions. The model finds NAMES in prose; the XBRL carries
    // QUANTIFIED shares, including for filers who disclose a customer
    // without naming them. Johnson & Johnson tags three wholesalers at
    // 21.8%, 15.5% and 11.1% of net sales and names none of them, so the
    // prose read alone reported no customers at all for a company that
    // sells nearly half its output through three counterparties.
    const [data, concentration] = await Promise.all([
      getSupplyChain(req.params.ticker),
      getCustomerConcentration(req.params.ticker).catch(() => null),
    ]);
    if (!data) return res.status(404).json({ error: 'No 10-K supply-chain disclosure found for this ticker.' });
    res.json({ ...data, concentrationFacts: concentration });
  } catch (err) {
    console.error('terminal/supply-chain failed:', err.message);
    res.status(502).json({ error: 'Supply-chain read failed — could not reach EDGAR.' });
  }
});

// PEER — sector peer comparison for the focused ticker. Finnhub's peer
// set (free tier), then a compact fundamentals snapshot for the focus
// plus up to 6 peers, fetched a few at a time so a single load never
// bursts the 60 rpm budget. Snapshots cache 15m; a peer that fails
// just renders blank cells rather than failing the panel. An empty
// peer set (common for ETFs) still returns the focus row with a flag.
router.get('/peers/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const list = await getPeers(raw);
    const peers = [...new Set(list)].filter((t) => t !== raw).slice(0, 6);
    const symbols = [raw, ...peers];

    // Small concurrency window — never fire all snapshots at once.
    const snaps = [];
    const POOL = 4;
    for (let i = 0; i < symbols.length; i += POOL) {
      const batch = symbols.slice(i, i + POOL);
      snaps.push(...(await Promise.all(batch.map((s) => getPeerSnapshot(s)))));
    }

    const rows = symbols.map((s, i) => {
      const snap = snaps[i];
      return {
        ticker: s,
        isFocus: s === raw,
        name: snap?.name || s,
        price: snap?.price ?? null,
        changePct: snap?.changePct ?? null,
        marketCap: snap?.marketCap ?? null,
        trailingPE: snap?.trailingPE ?? null,
        forwardPE: snap?.forwardPE ?? null,
        dividendYield: snap?.dividendYield ?? null,
        beta: snap?.beta ?? null,
      };
    });

    if (peers.length === 0 && rows[0]?.price == null) {
      return res.status(404).json({ error: 'No data for this ticker' });
    }
    res.json({ ticker: raw, count: peers.length, rows });
  } catch (err) {
    console.error(`terminal/peers(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Peer comparison failed' });
  }
});

// TOP — market-wide general news. Finnhub's general category feed via the
// news service, merged with the keyless public wires (Fed press releases,
// WSJ Markets, CNBC, MarketWatch) so central-bank and macro events show up
// here even when the finance-trade feed is quiet on them.
//
// Every headline is then scored for how genuinely BREAKING it is, which is
// what the strip filters on. Scoring is best-effort: if the model is
// unreachable the articles come back with `breaking: null` and the client
// falls back to the unfiltered wire rather than an empty strip.
//
// `?all=1` returns the unfiltered merge — TOP is a reading panel and wants
// the whole feed, while the strip wants only what's urgent.
router.get('/top-news', async (req, res) => {
  try {
    // Finnhub is the primary and must not be blocked by a slow publisher;
    // the wire fetch already bounds itself and degrades to []. The
    // portfolio read is only for badging held names and must never cost
    // the feed anything.
    const [data, wire, book] = await Promise.all([
      getNewsForTicker('SPY', '').catch(() => null),
      getWireHeadlines().catch(() => []),
      getSheetPortfolio().catch(() => null),
    ]);

    // Nothing older than two days may reach the classifier. The scorer
    // judges headline text alone and never sees a date, so without this
    // gate a frozen feed's 18-month-old crash headline could run on the
    // strip as BREAKING the moment the fresh sources thinned out.
    const freshCutoff = Date.now() - 48 * 60 * 60 * 1000;

    const seen = new Set();
    const merged = [];
    for (const a of [...(data?.articles || []), ...wire]) {
      if (!a?.title || !a?.url) continue;
      if (a.publishedAt && new Date(a.publishedAt).getTime() < freshCutoff) continue;
      const key = String(a.url).split('?')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(a);
    }
    if (merged.length === 0 && !data) {
      return res.status(502).json({ error: 'Top news unavailable' });
    }
    merged.sort(
      (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
    );

    // Tag headlines that mention a held name — the club's wire, not just
    // a wire. Ticker must stand alone as an uppercase token (so GD does
    // not fire inside a word); the company name matches with its legal
    // suffix stripped.
    const held = (book?.holdings || [])
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => ({
        ticker: String(h.ticker).toUpperCase(),
        re: new RegExp(`(^|[^A-Za-z0-9])${String(h.ticker).toUpperCase()}([^A-Za-z0-9]|$)`),
        name: String(h.name || '')
          .replace(/,? (inc|corp(oration)?|co|ltd|plc|etf|trust|fund)\.?$/i, '')
          .trim()
          .toLowerCase(),
      }))
      .filter((h) => h.ticker.length >= 2 || h.name.length >= 4);
    for (const a of merged) {
      const title = String(a.title);
      const lower = title.toLowerCase();
      const hit = held.find(
        (h) => h.re.test(title) || (h.name.length >= 4 && lower.includes(h.name))
      );
      if (hit) a.heldTicker = hit.ticker;
    }

    const scored = await scoreBreaking(merged.slice(0, 25));
    const wantAll = req.query.all === '1' || req.query.all === 'true';
    const selected = wantAll ? scored : filterBreaking(scored);

    res.json({
      articles: selected.slice(0, 20).map((a) => ({
        title: a.title,
        url: a.url,
        source: a.source,
        publishedAt: a.publishedAt,
        score: a.score ?? null,
        breaking: a.breaking ?? null,
        breakingReason: a.breakingReason ?? null,
        heldTicker: a.heldTicker ?? null,
      })),
      // Lets the client tell "nothing is breaking" apart from "we never
      // got to judge" — two states that must not look alike.
      classified: scored.some((a) => typeof a.breaking === 'number'),
      threshold: BREAKING_THRESHOLD,
      sources: {
        finnhub: (data?.articles || []).length,
        wire: wire.length,
        // Per-feed roll call, so a wire that dies upstream while
        // returning 200 is visible here instead of eighteen months later.
        feeds: getWireHealth(),
      },
      fetchedAt: data?.fetchedAt || new Date().toISOString(),
    });
  } catch (err) {
    console.error('terminal/top-news failed:', err.message);
    res.status(502).json({ error: 'Top news unavailable' });
  }
});

// GET /api/terminal/indices — world index snapshot. Data sourcing and
// the Stooq→Finnhub fallback live in services/worldIndices.js (Yahoo is
// unreachable from Render's IP). The service never throws and stubs any
// miss, so a bad feed degrades a row to "—" rather than failing here.
router.get('/indices', async (_req, res) => {
  try {
    const rows = await getWorldIndices();
    res.json({ asOf: new Date().toISOString(), regions: REGION_ORDER, rows });
  } catch (err) {
    console.error('terminal/indices failed:', err.message);
    res.status(502).json({ error: 'Index snapshot failed' });
  }
});

// ── Function-specific AI prompts ────────────────────────────────────
// Each panel gets a tailored system prompt so the AI acts like a domain
// expert rather than a generic summarizer. All share the same grounding
// rules (exact figures, no guessing), but the analytical lens differs.

const GROUNDING_RULES =
  'IMPORTANT: Use ONLY the exact figures provided in the panel data. Never estimate, round differently, or invent numbers. ' +
  'If a value is missing from the data, do not guess it. ' +
  'No bullet lists. No disclaimers. ' +
  'If the context is empty or the data is missing, write a single line: "Data unavailable."';

const FN_PROMPTS = {
  DES:
    'You are a senior equity analyst annotating a company snapshot for the Griffin Fund, a student investment fund. ' +
    'Write a 2–4 sentence brief that contextualizes the fundamentals. ' +
    'Highlight what stands out: is the P/E rich or cheap vs. the sector? Is the stock near a 52-week extreme? ' +
    'Does the dividend yield or beta suggest anything about risk/reward? ' +
    'Connect the numbers to the business summary when possible. ' +
    GROUNDING_RULES,

  CN:
    'You are a newsroom analyst at the Griffin Fund, a student investment fund. ' +
    'Read the headlines below and write a 2–3 sentence synthesis of the dominant narrative. ' +
    'What is the market focused on for this name right now? Is the tone bullish, bearish, or mixed? ' +
    'Flag if multiple sources are converging on the same story — that amplifies signal. ' +
    'If headlines are stale (all older than a day), note the lack of fresh catalysts. ' +
    GROUNDING_RULES,

  TOP:
    'You are a macro strategist at the Griffin Fund, a student investment fund. ' +
    'Scan these market-wide headlines and write a 2–3 sentence brief on the prevailing market narrative. ' +
    'What themes dominate: rates, earnings, geopolitics, sector rotation? ' +
    'Is the overall tone risk-on or risk-off? Flag any headline that could move markets in the next session. ' +
    GROUNDING_RULES,

  PEER:
    'You are a sector analyst at the Griffin Fund, a student investment fund, comparing a company against its peer group. ' +
    'Write a 2–4 sentence brief. How does the focus stock\'s valuation (P/E, forward P/E) compare to the group median? ' +
    'Is it trading at a premium or discount, and does its growth or dividend profile justify it? ' +
    'Call out the cheapest and most expensive names. Note any outlier betas. ' +
    GROUNDING_RULES,

  INSDR:
    'You are a forensic analyst at the Griffin Fund, a student investment fund, interpreting Form 4 insider transactions. ' +
    'Write a 2–4 sentence brief. Is the pattern net buying or net selling? Are the buyers C-suite or directors? ' +
    'Cluster buys from multiple insiders in the same period are a strong signal — flag them. ' +
    'Large option exercises followed by immediate sells are routine, not bearish — distinguish them from open-market conviction buys. ' +
    GROUNDING_RULES,

  EARN:
    'You are an earnings analyst at the Griffin Fund, a student investment fund, reading a company\'s report history. ' +
    'Write a 2–3 sentence brief. When is the next report, and is it near? ' +
    'Has the recent record been a beat or miss streak, and is the EPS surprise trend widening or narrowing? ' +
    'Flag if the estimate set is thin (few quarters) or stale, which makes the next print less predictable. ' +
    GROUNDING_RULES,

  MOVR:
    'You are a portfolio risk analyst at the Griffin Fund, a student investment fund, reviewing today\'s performance across the book. ' +
    'Write a 2–3 sentence brief. Is the fund broadly green or red? How concentrated is the move — is one name driving most of the P&L? ' +
    'Flag any holding moving more than ±3% as it likely has a catalyst. Note if the portfolio is moving with or against the broader market. ' +
    GROUNDING_RULES,

  PM:
    'You are the portfolio manager at the Griffin Fund, a student investment fund, reviewing the book position by position. ' +
    'Write a 3–4 sentence brief. Lead with posture: net asset value, today\'s P&L, and total unrealized gain/loss. ' +
    'Address concentration — the largest position\'s weight and whether the top few names dominate the book — and name the biggest winner and loser by unrealized P&L. ' +
    'Note the cash level and what it implies about dry powder. ' +
    GROUNDING_RULES,

  MGMT:
    'You are a governance analyst at the Griffin Fund, a student investment fund. ' +
    'Write a 2–3 sentence brief on the leadership team. Note CEO tenure and any recent turnover. ' +
    'Flag if compensation appears outsized relative to company size, or if the board has notable interlocking directorships with portfolio companies. ' +
    GROUNDING_RULES,

  FIL:
    'You are a filings analyst at the Griffin Fund, a student investment fund, reading a ticker\'s recent SEC submissions. ' +
    'Write a 2–3 sentence brief on what is notable. Flag a fresh 10-K or 10-Q, a material 8-K, or a new DEF 14A, and note clustered Form 4s in a short window. ' +
    'Distinguish substantive filings from routine boilerplate (144s, ownership amendments). ' +
    'If nothing has been filed recently or the feed is stale, say so plainly rather than overstating thin activity. ' +
    GROUNDING_RULES,

  CON:
    'You are a sell-side-coverage analyst at the Griffin Fund, a student investment fund, reading a ticker\'s analyst recommendation distribution. ' +
    'Write a 2–3 sentence brief. What is the current skew — is the latest period weighted to buy, hold, or sell? ' +
    'Comparing the recent periods, is sentiment improving (upgrades, buys rising) or deteriorating (downgrades, holds/sells rising)? ' +
    'Flag thin or absent coverage (only a handful of analysts, or none), which makes the consensus weak signal. ' +
    GROUNDING_RULES,

  CMP:
    'You are a relative-value analyst at the Griffin Fund, a student investment fund, comparing a small hand-picked set of tickers head to head. ' +
    'Write a 2–3 sentence brief. Which name looks rich and which looks cheap on P/E (and forward P/E) relative to the group, and does any growth, yield, or beta difference justify that gap? ' +
    'Name the clear outlier — the cheapest, the most expensive, or the one whose risk profile (beta) or income (dividend) sets it apart. ' +
    'If the set is too small or fundamentals are missing for most names, say so plainly rather than forcing a comparison. ' +
    GROUNDING_RULES,

  WEI:
    'You are a global macro analyst at the Griffin Fund, a student investment fund. ' +
    'Write a 2–3 sentence brief on the global equity picture. Which regions are leading and lagging? ' +
    'Is there a risk-on or risk-off pattern across geographies? Note any index moving more than ±1.5% as it likely has a story behind it. ' +
    GROUNDING_RULES,

  WX:
    'You are a climate event-study analyst at the Griffin Fund, a student investment fund, reading a historical playbook of US-landfall named storms against curated sector baskets (Gulf O&G, P&C insurers). ' +
    'Write a 2–3 sentence brief. If a named storm is currently active in the NHC feed, lead with its name and intensity. ' +
    'Cite the historical mean abnormal return (5-day, SPY-relative) for each basket and the n behind it; note where the user\'s holdings sit inside the affected basket. ' +
    'Explicitly frame the output as a historical playbook, not a forecast — past landfalls inform the basket\'s typical reaction, not the next one. ' +
    GROUNDING_RULES,

  RDR:
    'You are a weather-risk analyst at the Griffin Fund, a student investment fund, reading a live snapshot of active US NWS warnings (the panel also shows NEXRAD radar). ' +
    'Write a 2–3 sentence brief. Lead with the most severe / highest-impact warnings (tornado, severe thunderstorm, flash flood) and roughly where they cluster by region or state from the area descriptions, and give counts by type. ' +
    'These are current conditions, not a forecast or a market call — describe the weather picture plainly and do not infer ticker-level impact unless the panel data names a holding. ' +
    GROUNDING_RULES,

  MACRO:
    'You are a macro factor analyst at the Griffin Fund, a student investment fund, reading the portfolio\'s sensitivity to 10Y yields, WTI oil, USD index, VIX, and SPY from a 252-trading-day OLS regression. ' +
    'Write a 2–3 sentence brief. Cite the portfolio β per factor with its sign (a negative β to 10Y means the book falls when yields rise) and name the 1–3 dominant contributing tickers along with their individual β. ' +
    'Summarize what the default scenario implies in plain language (e.g. "if 10Y rises 50bps, the book is expected down ~X%"), and mention R² and n so the reader knows how predictive past sensitivity has been — single-factor R² on individual stocks is typically low (0.05–0.30), which is honest, not a bug. ' +
    'Frame this explicitly as past sensitivity, not a forecast: rolling betas drift across regimes, so the scenario is a "what the book did when this factor moved historically" cue, not a prediction. ' +
    GROUNDING_RULES,

  ICLUSTER:
    'You are a forensic analyst at the Griffin Fund, a student investment fund, reading a cluster-scanner output across the book. ' +
    'Write a 2–3 sentence brief. Flag the top scoring names by their role composition and total dollars committed, and distinguish into-weakness clusters (insiders buying after a drawdown) from into-strength clusters. ' +
    'Frame this explicitly as a SCREEN, not a standalone signal — evidence to bring to a fundamentals thesis, not a trade trigger on its own. ' +
    GROUNDING_RULES,
};

const DEFAULT_PROMPT =
  'You are the AI annotation layer inside a Bloomberg-style terminal at the Griffin Fund, a student investment fund. ' +
  'For the panel and data below, write a 2–4 sentence brief that adds insight, not restatement. ' +
  'Be concrete: cite numbers from the context when relevant. ' +
  GROUNDING_RULES;

// AI brief for a single panel. Body: { ticker, function, context }
// Returns: { brief: string }
router.post('/annotate', aiLimiter, async (req, res) => {
  const { ticker, function: fn, context } = req.body || {};
  if (!fn) return res.status(400).json({ error: 'function is required' });
  const safeTicker = typeof ticker === 'string' ? ticker.toUpperCase().slice(0, 12) : '';
  const safeFn = String(fn).toUpperCase().slice(0, 8);
  const safeContext = typeof context === 'string' ? context.slice(0, 6000) : '';

  const fnDoc = KNOWN_FUNCTIONS.find((f) => f.id === safeFn);
  const fnLabel = fnDoc?.label || safeFn;

  const messages = [
    {
      role: 'system',
      content: FN_PROMPTS[safeFn] || DEFAULT_PROMPT,
    },
    {
      role: 'user',
      content:
        `Panel: ${safeFn} (${fnLabel})` +
        (safeTicker ? `\nTicker: ${safeTicker}` : '') +
        (safeContext ? `\n\nPanel data:\n${safeContext}` : ''),
    },
  ];

  // preferQuality: route panel briefs to the best reasoning model available
  // (cloud first, local fallback) — a weak local model makes the amber "AI
  // BRIEF" line read as filler instead of insight.
  const brief = await llmChat({
    messages,
    temperature: 0.3,
    timeoutMs: 20_000,
    preferQuality: true,
  });
  res.json({ brief: brief || 'Data unavailable.' });
});

// Natural language -> mnemonic command parser. Body: { input }
// Returns: { ticker, function, args, explanation }
// Falls back to a heuristic parse if the LLM is unreachable.
router.post('/parse-command', aiLimiter, async (req, res) => {
  const input = String(req.body?.input || '').trim();
  if (!input) return res.status(400).json({ error: 'input is required' });

  // Heuristic first: if it already looks like a mnemonic, skip the LLM.
  const heuristic = mnemonicParse(input);
  if (heuristic) return res.json({ ...heuristic, explanation: null, _source: 'heuristic' });

  const functionIds = KNOWN_FUNCTIONS.map((f) => f.id).join(', ');
  const messages = [
    {
      role: 'system',
      content:
        'You translate natural language into a terminal command for a Bloomberg-style workstation at the Griffin Fund, a student investment fund.\n' +
        `Available functions: ${functionIds}.\n` +
        'Rules:\n' +
        '- Reply with strict JSON only, no prose, no code fences.\n' +
        '- Shape: {"ticker": string|null, "function": string, "args": string|null, "explanation": string}\n' +
        '- "function" must be one of the listed IDs. "ticker" is uppercase if present.\n' +
        '- Map intent to the best function: "news about Apple" → AAPL CN, "who runs Tesla" → TSLA MGMT, ' +
        '"compare Nike to peers" → NKE PEER, "insider buying at JPM" → JPM INSDR, "market overview" → TOP, ' +
        '"what\'s moving" → MOVR, "global markets" → WEI.\n' +
        '- If the user names a company, resolve it to the standard ticker (e.g. "Home Depot" → HD, "Google" → GOOGL).\n' +
        '- "explanation" is one short sentence describing what the command does.',
    },
    { role: 'user', content: input },
  ];

  const raw = await llmChat({
    messages,
    jsonMode: true,
    temperature: 0,
    timeoutMs: 12_000,
    preferQuality: true,
  });
  if (!raw) {
    return res.json({
      ticker: null,
      function: 'HELP',
      args: null,
      explanation: 'Could not interpret. Try TICKER FUNCTION, e.g. AAPL DES.',
      _source: 'fallback',
    });
  }
  try {
    const parsed = JSON.parse(raw);
    const fn = String(parsed.function || '').toUpperCase();
    if (!KNOWN_FUNCTIONS.find((f) => f.id === fn)) {
      throw new Error('unknown function');
    }
    res.json({
      ticker: parsed.ticker ? String(parsed.ticker).toUpperCase().slice(0, 12) : null,
      function: fn,
      args: parsed.args ? String(parsed.args).slice(0, 80) : null,
      explanation: String(parsed.explanation || '').slice(0, 240),
      _source: 'llm',
    });
  } catch {
    res.json({
      ticker: null,
      function: 'HELP',
      args: null,
      explanation: 'Could not interpret. Try TICKER FUNCTION, e.g. AAPL DES.',
      _source: 'fallback',
    });
  }
});

// Free-form chat for the BI panel. Body: { messages: [{role, content}], context }
// `context` is the live workspace summary the client builds (current ticker, panes, etc.)
// Returns: { reply }
router.post('/chat', aiLimiter, async (req, res) => {
  const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const context = typeof req.body?.context === 'string' ? req.body.context.slice(0, 6000) : '';
  if (userMessages.length === 0) return res.status(400).json({ error: 'messages required' });

  const trimmed = userMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const messages = [
    {
      role: 'system',
      content:
        'You are the Bloomberg Intelligence research console at the Griffin Fund, a student-run investment fund. ' +
        'You think like a buy-side analyst: rigorous, quantitative, and opinionated when the data supports it.\n' +
        `Today's date is ${new Date().toISOString().slice(0, 10)}.\n\n` +
        'Guidelines:\n' +
        '- Lead with the answer, then support it. Don\'t hedge everything.\n' +
        '- Cite specific numbers from the workspace context when available.\n' +
        '- When comparing companies, use relative valuation (P/E vs. peers, EV/EBITDA, PEG).\n' +
        '- For "why is X up/down" questions, distinguish between catalysts (earnings, news) and technicals (positioning, flows).\n' +
        '- For bull/bear cases, identify the 2–3 key variables that matter most, not a laundry list.\n' +
        '- If asked about a holding in the Griffin Fund portfolio, frame the analysis around position sizing and conviction.\n' +
        '- Keep responses under 200 words unless the question demands depth.\n' +
        '- Use short paragraphs, not bullet lists. Write like a morning research note, not a chatbot.\n' +
        '- If you genuinely don\'t know or the data is insufficient, say so in one sentence.' +
        (context ? `\n\nWorkspace context:\n${context}` : ''),
    },
    ...trimmed,
  ];

  // Stream when asked, for the same reason the web chat does: the model
  // writes at roughly twenty tokens a second, and a research note is not
  // a short answer. A client that does not ask, or a box that cannot
  // stream, gets the blocking reply exactly as before.
  if (req.body?.stream === true && canStreamLocally()) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await llmChatStreamLocal({
        messages,
        temperature: 0.3,
        timeoutMs: 90_000,
        onToken: (piece) => send('token', piece),
      });
      send('done', {});
    } catch (err) {
      console.warn('terminal/chat stream failed:', err.message);
      // Nothing partial is kept or claimed. A stream that died halfway
      // has produced a fragment, and a fragment presented as an answer
      // is worse than an honest failure.
      send('error', { error: 'The answer stopped part way through. Try again.' });
    }
    return res.end();
  }

  const reply = await llmChat({
    messages,
    temperature: 0.3,
    timeoutMs: 90_000,
    preferQuality: true,
  });
  res.json({ reply: reply || 'AI is unavailable right now. Try again in a moment.' });
});

// ── RSCH — the club's own research ───────────────────────────────────
//
// Everything the Griffin Fund has written, readable inside the terminal
// instead of only as a file to download. Two endpoints: an index, and a
// reader that returns the document's extracted text plus its cached AI
// summary.
//
// The point is that reading our own research never depends on a
// document viewer working. Text extraction runs against the bytes, so a
// deck stays readable here even when nothing can render it inline.

// Full text is capped on the way out. A long 10-K-flavored report can
// extract to hundreds of KB, which is a slow response and more than
// anyone scrolls in a terminal pane. The client shows a truncation
// notice and links to the file for the rest.
const RESEARCH_TEXT_MAX = 120_000;

router.get('/research', async (req, res) => {
  try {
    const items = await listResearch({
      ticker: req.query.ticker || null,
      q: req.query.q || null,
    });
    const summaries = await summariesFor(items.map((i) => i.fileRef));
    res.json({
      items: items.map((it) => ({
        ...it,
        // Surface what the reader can expect before they open it: a
        // one-click AI read, or a document we'd have to parse first.
        hasSummary: !!(it.fileRef && summaries[it.fileRef]),
        managed: !!(it.fileRef && it.fileRef.startsWith('onedrive:')),
      })),
      counts: {
        reports: items.filter((i) => i.kind === 'report').length,
        pitches: items.filter((i) => i.kind === 'pitch').length,
      },
    });
  } catch (err) {
    console.error('RSCH index failed:', err.message);
    res.status(500).json({ error: 'Could not load the research archive.' });
  }
});

router.get('/research/:ref', async (req, res) => {
  const ref = req.params.ref;
  try {
    const item = await getResearchItem(ref);
    if (!item) return res.status(404).json({ error: 'No such research item.' });

    // Nothing was ever uploaded for this row, or it points at an
    // external link we don't host. Either way there's no text to pull —
    // return the record so the panel can still show what it knows.
    if (!item.fileRef || !item.fileRef.startsWith('onedrive:')) {
      return res.json({
        ...item,
        summary: null,
        text: null,
        unavailable: item.fileRef
          ? 'This document is an external link — open it to read.'
          : 'No document was uploaded for this entry.',
      });
    }

    const itemId = item.fileRef.slice('onedrive:'.length);
    const summaries = await summariesFor([item.fileRef]);
    const summary = summaries[item.fileRef] || null;

    // A failed extraction must not take the whole panel down — the
    // record and any existing summary are still worth showing. Image-
    // only PDFs and unsupported types land here routinely.
    let text = null;
    let chars = null;
    let unavailable = null;
    // The stored extraction first. Re-downloading and re-parsing a
    // multi-megabyte filing every time somebody scrolls back to it was
    // the only reason this was ever slow, and the stored copy is the
    // same bytes the search and the assistant are reading — so the
    // reader showing something different from what the assistant quotes
    // is now impossible rather than merely unlikely.
    if (item.extractStatus === 'ok' && item.extractedText) {
      chars = item.extractChars ?? item.extractedText.length;
      text = item.extractedText.slice(0, RESEARCH_TEXT_MAX);
    } else if (item.extractStatus === 'empty') {
      unavailable = 'No text layer in this document — it is almost certainly a scan. Reading it would need OCR.';
    } else {
      try {
        const extracted = await extractFileText(itemId);
        chars = extracted.chars;
        text = extracted.text.slice(0, RESEARCH_TEXT_MAX);
      } catch (err) {
        unavailable =
          err.code === 'UNSUPPORTED_TYPE'
            ? err.message
            : 'Could not read the text of this document.';
      }
    }

    res.json({
      ...item,
      summary: summary ? summary.summary : null,
      summaryModel: summary ? summary.model : null,
      text,
      chars,
      truncated: chars != null && chars > RESEARCH_TEXT_MAX,
      unavailable,
    });
  } catch (err) {
    console.error('RSCH read failed:', err.message);
    res.status(500).json({ error: 'Could not open that research item.' });
  }
});

// Mnemonic parser: TICKER FUNCTION [ARGS] -> structured form.
// Also accepts function-only commands like "HELP" or "WEI".
function mnemonicParse(input) {
  const cleaned = String(input).trim().replace(/\s+/g, ' ').toUpperCase();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  const fnIds = new Set(KNOWN_FUNCTIONS.map((f) => f.id));

  // Single token: either a function (HELP, WEI, TOP, MOVR, ECO) or a ticker alone (defaults to DES).
  if (parts.length === 1) {
    const tok = parts[0];
    if (fnIds.has(tok)) return { ticker: null, function: tok, args: null };
    if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(tok)) return { ticker: tok, function: 'DES', args: null };
    return null;
  }

  // First token is ticker, second is function.
  const [t, f, ...rest] = parts;
  if (fnIds.has(f) && /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)) {
    return { ticker: t, function: f, args: rest.length ? rest.join(' ').slice(0, 80) : null };
  }
  // First token is function, second... rest are args (e.g. "HELP DES")
  if (fnIds.has(t)) {
    return { ticker: null, function: t, args: rest.length ? [f, ...rest].join(' ').slice(0, 80) : f };
  }
  return null;
}

export default router;
