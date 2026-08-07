// Public RSS wires — a second, keyless news source alongside Finnhub.
//
// Why add anything at all: Finnhub's general feed is finance-trade press.
// It is good at company news and thin on the things that actually warrant
// interrupting someone — a Fed policy statement, a systemic shock. The
// Federal Reserve publishes its own press releases as RSS the moment they
// go out, which is the single highest-signal breaking source available to
// us and costs nothing.
//
// Why RSS rather than another JSON API: the club stays on free tiers
// deliberately, and this deploy has a history of datacenter-IP blocking
// (GSAM 403s, Yahoo profile 429s from Render). GDELT's free endpoint asks
// for one request per five seconds and enforces it hard, which is a
// liability on a shared egress IP. Wire RSS has no key, no quota, and is
// published to be machine-read, so it degrades gracefully where those do
// not.
//
// Everything here is best-effort. A feed that 404s, times out, or serves
// malformed XML is skipped silently — news must never be blocked by one
// bad publisher.

const CACHE_TTL_MS = 10 * 60 * 1000; // matches the Finnhub news cache
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PER_FEED = 15;

// Sent on every request — some publishers 403 an empty or scripted agent.
const UA = 'Mozilla/5.0 (compatible; GriffinFund/1.0; +https://thegriffinfund.org)';

// Ordered by signal, not volume. The Fed feed is first on purpose: it is
// the only one here that routinely carries a genuine "stop and look up"
// event, and it publishes maybe a few items a week.
export const FEEDS = [
  {
    id: 'fed',
    source: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    // Central-bank primary source: a rate decision or emergency facility
    // lands here before any wire writes it up.
    weight: 'primary',
  },
  {
    id: 'wsj-markets',
    source: 'WSJ Markets',
    // Dow Jones abandoned feeds.a.dj.com without turning it off: the old
    // URL kept answering 200 with content frozen at January 2025, and
    // because only *errors* skip a feed, we counted it healthy for
    // eighteen months. The feed lives on their current CDN host now, and
    // the per-item age gate below is the structural guard against the
    // next silent freeze.
    url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
    weight: 'wire',
  },
  {
    id: 'cnbc',
    source: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    weight: 'wire',
  },
  {
    id: 'marketwatch',
    source: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    weight: 'wire',
  },
  // The two big press-release wires. Earnings releases, M&A announcements
  // and guidance changes cross here the second the company publishes,
  // usually minutes before any journalist writes them up — which is
  // exactly the event class the breaking classifier's "scheduled print
  // just landed" band wants to catch. Both keyless.
  {
    id: 'globenewswire',
    source: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies',
    weight: 'wire',
  },
  {
    id: 'prnewswire',
    source: 'PR Newswire',
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss',
    weight: 'wire',
  },
];

// Reject items older than this at parse. A wire headline older than a
// week is not news, and a feed whose *newest* item is older than this is
// dead upstream no matter what its HTTP status says — the WSJ freeze
// proved that liveness cannot be inferred from a 200.
const MAX_ITEM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cache = { at: 0, articles: [], health: [] };

// ── Parsing ──────────────────────────────────────────────────────────
// A regex reader rather than an XML dependency, the same shape
// fileSummarizer.js already uses for Office XML. Feeds are small and
// well-formed in practice; anything we mis-parse simply drops out.

function stripCdata(s) {
  // Unwrap every CDATA section in place, not just a value that is one
  // whole block: publishers mix plain text and CDATA in a single title,
  // and the whole-block-only version left the wrapper for the tag
  // stripper to eat, words and all.
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(s) {
  return (
    String(s)
      // Numeric entities first, and they matter more than they look:
      // Dow Jones feeds publish curly quotes as &#x2019;, so without this
      // every MarketWatch headline reads "Here&#x2019;s the net worth…".
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // The common typographic names some wires use instead of numeric
      // forms; anything rarer degrades to showing its entity, not to a
      // parse failure.
      .replace(/&rsquo;/g, '’')
      .replace(/&lsquo;/g, '‘')
      .replace(/&rdquo;/g, '”')
      .replace(/&ldquo;/g, '“')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&hellip;/g, '…')
      // Ampersand last, or it would mangle the entities decoded above.
      .replace(/&amp;/g, '&')
  );
}

// A malformed entity should leave the text alone, not throw out of a
// parse and cost us the whole feed.
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return null;
  // Order matters: strip real markup FIRST, then decode. Decoding first
  // turns an escaped "&lt;the telco&gt;" into live angle brackets that the
  // tag-stripper then eats, silently deleting words from the headline.
  const v = decodeEntities(stripCdata(m[1]).replace(/<[^>]+>/g, '')).trim();
  return v || null;
}

// Atom puts the URL in an attribute (<link href="…"/>) instead of a body.
function atomLink(block) {
  const m = /<link[^>]*\shref=["']([^"']+)["'][^>]*>/i.exec(block);
  return m ? decodeEntities(m[1]).trim() : null;
}

function toIso(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFeed(xml, feed, now = Date.now()) {
  const out = [];
  // <item> is RSS, <entry> is Atom. Both appear across these publishers.
  const blocks = String(xml || '').match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    const url = tag(block, 'link') || atomLink(block);
    if (!title || !url) continue;
    // Dated-and-stale is rejected; undated is kept — these publishers
    // all stamp pubDate, so a missing date is a parse oddity on a live
    // item, not a sign of age.
    const published =
      toIso(tag(block, 'pubDate')) || toIso(tag(block, 'published')) || toIso(tag(block, 'updated'));
    if (published && now - new Date(published).getTime() > MAX_ITEM_AGE_MS) continue;
    out.push({
      title,
      description: tag(block, 'description') || tag(block, 'summary') || null,
      url,
      source: feed.source,
      author: null,
      publishedAt: published,
      imageUrl: null,
      feedId: feed.id,
      feedWeight: feed.weight,
    });
    if (out.length >= MAX_PER_FEED) break;
  }
  return out;
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) return [];
    return parseFeed(await res.text(), feed);
  } catch {
    // Timeout, DNS, TLS, malformed body — all the same to us: skip it.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every configured wire, newest first, deduped by URL.
 * Never throws and never returns null — an all-feeds-down result is an
 * empty array, which callers already handle as "no extra headlines".
 *
 * @param {object} deps - Injectable fetcher, for tests
 */
export async function getWireHeadlines(deps = {}) {
  const now = Date.now();
  if (!deps.fetchFeed && now - cache.at < CACHE_TTL_MS && cache.articles.length) {
    return cache.articles;
  }
  const fetcher = deps.fetchFeed || fetchFeed;
  const feeds = deps.feeds || FEEDS;

  // Parallel: one slow publisher shouldn't hold up the rest, and the
  // per-request timeout already bounds the worst case.
  const batches = await Promise.all(feeds.map((f) => fetcher(f)));

  // Per-feed health, so a dead wire is visible in the terminal the way
  // a wire-status row is on a real terminal, instead of silently
  // contributing zero items until someone notices months later.
  const health = feeds.map((f, i) => {
    const items = batches[i] || [];
    const newest = items.reduce(
      (m, a) => (a.publishedAt && a.publishedAt > m ? a.publishedAt : m),
      ''
    );
    return { id: f.id, source: f.source, items: items.length, newest: newest || null };
  });

  const seen = new Set();
  const merged = [];
  for (const article of batches.flat()) {
    const key = String(article.url).split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(article);
  }
  merged.sort(
    (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
  );

  if (!deps.fetchFeed) cache = { at: now, articles: merged, health };
  return merged;
}

// The most recent fetch's per-feed roll call. Serves /top-news's sources
// block; empty until the first wire fetch of the process.
export function getWireHealth() {
  return cache.health || [];
}
