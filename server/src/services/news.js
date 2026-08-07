// News service backed by Finnhub. Returns a normalized list of articles for
// a ticker, cached in memory so repeat clicks don't burn quota.
//
// We picked Finnhub over newsapi.org because:
//   - Free tier is 60 req/minute with NO daily cap (newsapi = 100/day)
//   - Financial-news-only → fewer irrelevant hits (no Bayonetta for QQQ)
//   - Same API key already powers /holdings/info quote lookups
//
// Endpoints:
//   /company-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD   per-ticker
//   /news?category=general                                     market-wide
//
// We also extract full article bodies server-side (see extractArticle below)
// so members can read the whole story without leaving the app.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { llmConfigured } from './llm.js';
import { rankArticles } from './articleRanker.js';
import { summarizeTickerNews, summarizeArticle } from './articleSummarizer.js';

// 10 minutes — the terminal needs near-real-time headlines. Finnhub's free
// tier allows 60 req/min so a 10-min cache is well within budget while
// keeping stories fresh enough to feel like a live wire. LLM ranking is
// cached separately in the DB (ArticleRanking) so repeat fetches only
// re-rank genuinely new URLs.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key = ticker|name, value = { at, data }

function cacheKey(ticker, name) {
  return `${ticker}|${name || ''}`.toLowerCase();
}

// Format a JS date as YYYY-MM-DD for Finnhub's from/to params.
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Broad-market / sector ETFs that should use the general market feed rather
// than per-symbol company news. Finnhub's "general" category is the curated
// financial headlines stream — better than trying to search for "news about
// the SPDR S&P 500 ETF", which mostly returns fund-mechanics articles.
const TICKER_TOPIC_OVERRIDES = {
  VOO: { topic: 'Market news' },
  SPY: { topic: 'Market news' },
  QQQ: { topic: 'Market news' },
  VGT: { topic: 'Market news' },
  XLK: { topic: 'Market news' },
  XLV: { topic: 'Market news' },
};

// Pull 12 normalized articles from Finnhub. Throws with .status on error.
async function fetchFinnhubArticles(ticker, key) {
  const override = TICKER_TOPIC_OVERRIDES[ticker];
  let url;
  if (override) {
    url = `https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`;
  } else {
    // 60-day window. Small-caps (MLAB, GD, NOC etc.) often have stretches
    // of quiet coverage; a tight window made them look newsless even when
    // a material 30-day-old story was the best available.
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      symbol: ticker,
      from: isoDate(from),
      to: isoDate(to),
      token: key,
    });
    url = `https://finnhub.io/api/v1/company-news?${params.toString()}`;
  }

  const res = await fetch(url, { headers: { 'User-Agent': 'GriffinFund/1.0' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`finnhub responded ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  const json = await res.json();
  const raw = Array.isArray(json) ? json : [];

  // Normalize to the shape the rest of the pipeline expects. Finnhub
  // delivers: { headline, summary, url, source, datetime (unix seconds),
  // image, id, category, related }. Dedupe by URL — Finnhub occasionally
  // returns the same article under multiple sources.
  const seen = new Set();
  return raw
    .filter((a) => a.headline && a.url && !seen.has(a.url) && seen.add(a.url))
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .slice(0, 12)
    .map((a) => ({
      title: a.headline,
      description: a.summary || null,
      url: a.url,
      source: a.source || null,
      author: null,
      publishedAt: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      imageUrl: a.image || null,
    }));
}

export async function getNewsForTicker(ticker, name) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    const err = new Error('FINNHUB_API_KEY is not set');
    err.status = 501;
    throw err;
  }
  const ck = cacheKey(ticker, name);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // If the cached batch was fetched while the LLM was unreachable, try to
    // rank it again on cache hit — cheap when every URL is already in the
    // ArticleRanking DB, and will retry the LLM for the unknown ones.
    const data = cached.data;
    const hasRankings = data.articles.some((a) => typeof a.score === 'number');
    if (!hasRankings && llmConfigured()) {
      try {
        const retried = await rankArticles(data.articles, { ticker });
        data.articles = retried;
        data.ranked = retried.some((a) => typeof a.score === 'number');
        if (!data.narrative) {
          data.narrative = await summarizeTickerNews(ticker, retried);
        }
      } catch {
        /* keep original cached payload */
      }
    }
    return data;
  }

  const override = TICKER_TOPIC_OVERRIDES[ticker];
  const topic = override?.topic || null;

  let rawArticles;
  try {
    rawArticles = await fetchFinnhubArticles(ticker, key);
  } catch (err) {
    // Any upstream failure serves the stale batch when one exists,
    // flagged so the UI can say "news may be outdated". A minutes-old
    // cache beats a red panel whether Finnhub said 429, 502, or the
    // socket just died — the 429-only version of this rule threw away
    // perfectly good headlines over transient 5xx blips.
    if (cached) {
      return {
        ...cached.data,
        stale: true,
        staleReason: err.status === 429 ? 'rate_limit' : 'upstream_error',
      };
    }
    throw err;
  }

  // Best-effort rank via the local LLM. Returns articles unchanged if
  // LOCAL_LLM_URL is unset or the call fails/times out. Ranking runs
  // in-line so it's cached alongside the articles and not recomputed
  // every request.
  const articles = await rankArticles(rawArticles, { ticker });

  // Ticker-level narrative. Summarizer caches by URL set so repeat
  // fetches don't re-call the LLM.
  const narrative = await summarizeTickerNews(ticker, articles);

  const data = {
    ticker,
    topic,
    fetchedAt: new Date().toISOString(),
    // Client uses this to decide whether to show score badges.
    ranked: articles.some((a) => typeof a.score === 'number'),
    narrative,
    articles,
  };

  // Only cache when we actually got something. An empty batch is usually
  // a transient blip (Finnhub briefly returning nothing, or a small-cap
  // ticker in a quiet week) — caching that for 24h would keep the News
  // section empty long after new stories hit the wire.
  if (articles.length > 0) {
    cache.set(ck, { at: Date.now(), data });
  }
  return data;
}

// ── Article extraction ─────────────────────────────────────────────────
//
// Fetches the article URL server-side (the feed item carries the publisher URL),
// parses it with JSDOM, runs Mozilla's Readability (same algorithm as
// Firefox's reader view), then sanitizes the resulting HTML before returning
// it to the client. Sanitization is non-negotiable because Readability hands
// back whatever was on the page — including <script> and inline event
// handlers in a worst case.
//
// Cache is separate from the headline cache, keyed by URL, 1-hour TTL. News
// articles don't change after publish, so a longer TTL is safe.

const articleCache = new Map();
const ARTICLE_TTL_MS = 60 * 60 * 1000;
// Hard cap on cached articles. Keyed by member-supplied URL and holding
// full sanitized HTML, an uncapped map here is the same 512MB-dyno
// failure class as the companyfacts cache: the TTL was only ever
// checked on read, so entries outlived their hour forever. Insertion
// order is eviction order — close enough to LRU for a reader cache.
const ARTICLE_CACHE_MAX = 200;
const MAX_ARTICLE_BYTES = 2_000_000; // 2 MB ceiling on any fetched page

// Very conservative allowlist. Semantic + inline formatting tags, plus links
// and images. Everything else (scripts, iframes, forms, styles) is stripped.
const SANITIZE_OPTS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'mark', 'small', 'sub', 'sup',
    'ul', 'ol', 'li',
    'blockquote', 'cite', 'q',
    'figure', 'figcaption',
    'img',
    'a',
    'span', 'div',
    'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // Open every surviving link in a new tab with safe rel.
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noreferrer noopener',
      },
    }),
  },
};

// SSRF guard. This endpoint fetches a member-supplied URL server-side, so it
// must never be steerable at an internal address (cloud metadata at
// 169.254.169.254, localhost, the private RFC1918 / CGNAT / IPv6 ULA ranges,
// internal Render services). A bare protocol check isn't enough — we resolve
// the host and reject any non-public IP, reject odd ports, and (below) follow
// redirects manually so a public-looking URL can't 30x into an internal host.
function isPrivateIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local + cloud metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    return false;
  }
  if (fam === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4-mapped
    return false;
  }
  return true; // not an IP literal we recognize → reject
}

async function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    const e = new Error('Invalid article URL');
    e.status = 400;
    throw e;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const e = new Error('Invalid article URL');
    e.status = 400;
    throw e;
  }
  if (u.port && u.port !== '80' && u.port !== '443') {
    const e = new Error('Refusing to fetch a non-standard port');
    e.status = 400;
    throw e;
  }
  let ips;
  if (net.isIP(u.hostname)) {
    ips = [u.hostname];
  } else {
    try {
      ips = (await dns.lookup(u.hostname, { all: true })).map((r) => r.address);
    } catch {
      ips = [];
    }
  }
  if (ips.length === 0 || ips.some(isPrivateIp)) {
    const e = new Error('Refusing to fetch a non-public address');
    e.status = 400;
    throw e;
  }
  return u.href;
}

const ARTICLE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The dispatcher every article fetch goes through. Its lookup runs at
// CONNECT time, so the address the socket actually opens is the address
// that passed the private-IP check — assertPublicHttpUrl alone had a
// time-of-check/time-of-use gap where a short-TTL DNS record could
// answer the check with a public IP and the fetch with 169.254.169.254.
const publicOnlyAgent = new Agent({
  connect: {
    lookup(hostname, opts, cb) {
      dns
        .lookup(hostname, { all: true, verbatim: true })
        .then((rows) => {
          if (rows.length === 0 || rows.some((r) => isPrivateIp(r.address))) {
            const e = new Error('Refusing to connect to a non-public address');
            e.code = 'ENOTFOUND';
            cb(e);
            return;
          }
          if (opts && opts.all) cb(null, rows);
          else cb(null, rows[0].address, rows[0].family);
        })
        .catch(cb);
    },
  },
});

export async function extractArticle(url) {
  const cached = articleCache.get(url);
  if (cached && Date.now() - cached.at < ARTICLE_TTL_MS) {
    return cached.data;
  }

  // Resolve + fetch manually, re-validating the host on every redirect hop so a
  // public URL can't bounce to an internal one. Max 4 hops.
  let current = await assertPublicHttpUrl(url);
  let res;
  for (let hop = 0; hop < 4; hop++) {
    res = await undiciFetch(current, {
      redirect: 'manual',
      dispatcher: publicOnlyAgent,
      headers: {
        'User-Agent': ARTICLE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = await assertPublicHttpUrl(new URL(res.headers.get('location'), current).href);
      continue;
    }
    break;
  }
  if (res.status >= 300 && res.status < 400) {
    const err = new Error('Too many redirects');
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Publisher returned ${res.status}`);
    err.status = 502;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    const err = new Error('Not an HTML page');
    err.status = 415;
    throw err;
  }

  // Read up to MAX_ARTICLE_BYTES. Some news sites serve surprisingly large
  // pages (tracking SDKs, embedded videos). Cutting here bounds memory.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ARTICLE_BYTES) {
      const err = new Error('Article page too large');
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString('utf8');

  const dom = new JSDOM(html, { url });
  if (!isProbablyReaderable(dom.window.document)) {
    const err = new Error('This page does not look like a readable article');
    err.status = 422;
    throw err;
  }
  const reader2 = new Readability(dom.window.document);
  const parsed = reader2.parse();
  if (!parsed || !parsed.content) {
    const err = new Error('Could not extract the article');
    err.status = 422;
    throw err;
  }

  const safeContent = sanitizeHtml(parsed.content, SANITIZE_OPTS);

  // Generate / load the AI summary for this article. Cached in DB so
  // subsequent opens don't re-summarize. Best-effort; null if LLM off.
  const plain = parsed.textContent || ''; // Readability gives clean plain text separately
  const summary = await summarizeArticle(url, plain);

  const data = {
    url,
    title: parsed.title || null,
    byline: parsed.byline || null,
    siteName: parsed.siteName || null,
    excerpt: parsed.excerpt || null,
    publishedTime: parsed.publishedTime || null,
    length: parsed.length || null,
    contentHtml: safeContent,
    summary,
    fetchedAt: new Date().toISOString(),
  };
  articleCache.set(url, { at: Date.now(), data });
  if (articleCache.size > ARTICLE_CACHE_MAX) {
    for (const [k, v] of articleCache) {
      if (articleCache.size <= ARTICLE_CACHE_MAX && Date.now() - v.at < ARTICLE_TTL_MS) break;
      articleCache.delete(k);
    }
  }
  return data;
}
