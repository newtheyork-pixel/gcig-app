import { llmChat, extractJson } from './llm.js';

// Decides which headlines are ACTUALLY breaking news.
//
// The terminal's strip is labelled "breaking" but has only ever been the
// market-wide wire with a per-outlet cap — so a Tuesday column about
// index funds sat under the same banner as a rate decision. This module
// is the missing judgement: every headline gets a 0-10 urgency score and
// the strip shows only what clears the bar.
//
// Urgency is NOT materiality. articleRanker.js already scores how much a
// story should move a thesis; a deeply material earnings preview is still
// not breaking. The question here is narrower and purely temporal: did
// something just happen, and does it change what a reader believes right
// now? Analysis, previews, recaps and explainers all score low no matter
// how important their subject.
//
// Scores are cached in memory by URL. The same reasoning breakingNews.js
// documents applies — the strip refreshes on a 30-minute cadence and the
// cache is shared across every member, so a table would buy little. A
// restart just re-scores the current wire once.

const SCORE_CACHE_MAX = 600;
const BATCH_MAX = 25; // headlines per LLM call
const LLM_TIMEOUT_MS = 20_000;

// Clears the bar for the strip. Deliberately mid-scale, not the
// dashboard's 9+: this surface is "relevant right now", a tier below the
// once-a-week push alert, and an empty strip all day would read as broken.
export const BREAKING_THRESHOLD = 6;

const cache = new Map(); // url -> { score, reason }

// Terminal opens are bursty — a meeting starts and six members load the
// workspace at once. Without this, every one of them finds the same
// unscored URLs, and they all fire the same LLM call before the first
// reply populates the cache. One pass at a time: later arrivals wait for
// the in-flight pass, then re-read the cache it just filled.
let inFlight = null;

function remember(url, value) {
  cache.delete(url);
  cache.set(url, value);
  if (cache.size > SCORE_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

const SYSTEM_PROMPT = `You score news headlines for a live "breaking news" ticker in an investment terminal. For each headline, rate 0-10 how genuinely BREAKING it is right now.

Breaking means: a discrete event just happened and a reader's understanding changes because of it. It does NOT mean important, interesting, or well-written.

Calibration:
  9-10  System-shaking event confirmed: central-bank rate decision or emergency action, bank failure, sovereign default, war outbreak or major escalation, market-wide crash with a named catalyst.
  7-8   Hard, confirmed, market-relevant event: major company bankruptcy, completed M&A with named parties, CEO ouster at a large cap, major regulatory ruling, a scheduled macro print that just landed with a surprise.
  5-6   Real news but routine: an earnings report released, a named analyst action, a product launch, an official appointment, a notable single-stock move with a stated cause.
  3-4   Soft or derivative: "stocks drift", market wrap-ups, previews of things that have not happened, "what to watch this week".
  0-2   Not news: opinion, explainers, personal finance advice, listicles, sponsored content, evergreen features, "here's why you should".

Rules:
- A headline about what MIGHT or WILL happen is a preview, not breaking. Cap it at 4.
- A recap of a session that already closed is not breaking. Cap it at 4.
- Judge only the headline text. Do not assume detail that is not written there.
- Most headlines on an ordinary day score 3-5. Be strict; a ticker that flags everything flags nothing.

Reply with strict JSON only, no prose, no code fences:
{"scores":[{"index":0,"score":7,"reason":"Fed cut rates 50bp"}]}
"index" is the 0-based input position. "reason" is at most 8 words, describing the event, not your rating.`;

function buildList(articles) {
  return articles
    .map((a, i) => `${i}. [${a.source || 'wire'}] ${a.title}`)
    .join('\n');
}

// One LLM pass over a batch. Returns a Map of index -> {score, reason}.
// Any failure yields an empty map, which the caller treats as "unscored"
// rather than "not breaking" — a down model must not silently empty the
// strip.
async function scoreBatch(articles) {
  const raw = await llmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Headlines:\n${buildList(articles)}` },
    ],
    jsonMode: true,
    temperature: 0,
    timeoutMs: LLM_TIMEOUT_MS,
    preferQuality: true,
  });
  if (!raw) return new Map();

  // Tolerate fenced/sentinel-wrapped JSON — Anthropic is first in the
  // preferQuality order and only promises JSON by prompt, not contract.
  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return new Map();
  }
  const rows = Array.isArray(parsed?.scores) ? parsed.scores : [];
  const out = new Map();
  for (const row of rows) {
    const i = Number(row?.index);
    const score = Number(row?.score);
    if (!Number.isInteger(i) || i < 0 || i >= articles.length) continue;
    if (!Number.isFinite(score)) continue;
    out.set(i, {
      // Clamp rather than discard: an out-of-range score is a formatting
      // slip, not a reason to lose the judgement.
      score: Math.max(0, Math.min(10, score)),
      reason: String(row?.reason || '').slice(0, 80),
    });
  }
  return out;
}

/**
 * Attach `breaking` (0-10) and `breakingReason` to each article.
 *
 * Articles already scored in this process are served from cache and never
 * re-sent. Anything the model doesn't return a score for keeps
 * `breaking: null`, which callers must read as "unknown", not "boring".
 *
 * Never throws — ranking is an enhancement, not a dependency.
 *
 * @param {Array} articles
 * @param {object} deps - Injectable scorer, for tests
 */
export async function scoreBreaking(articles, deps = {}) {
  const list = Array.isArray(articles) ? articles : [];
  if (list.length === 0) return [];
  const scorer = deps.scoreBatch || scoreBatch;
  const store = deps.cache || cache;

  // Tests inject their own cache and scorer and want deterministic,
  // un-shared behavior; the in-flight guard is a production concern.
  const shared = !deps.cache;

  // Wait out any pass already running, so we score against the cache it
  // leaves behind rather than duplicating its work.
  if (shared && inFlight) {
    await inFlight.catch(() => {});
  }

  const unscored = list.filter((a) => a?.url && !store.has(a.url));

  // Only the unknowns cost a call, and only up to a batch — the strip
  // shows a dozen headlines, so there is no reason to classify a long
  // tail nobody will see.
  if (unscored.length > 0) {
    const batch = unscored.slice(0, BATCH_MAX);
    const pass = (async () => {
      const scored = await scorer(batch);
      for (const [i, value] of scored) {
        const article = batch[i];
        if (article?.url) {
          if (deps.cache) store.set(article.url, value);
          else remember(article.url, value);
        }
      }
    })();
    if (shared) inFlight = pass;
    try {
      await pass;
    } catch {
      /* leave them unscored */
    } finally {
      if (shared && inFlight === pass) inFlight = null;
    }
  }

  return list.map((a) => {
    const hit = a?.url ? store.get(a.url) : null;
    return {
      ...a,
      breaking: hit ? hit.score : null,
      breakingReason: hit ? hit.reason : null,
    };
  });
}

/**
 * Keep only headlines that clear the bar, most urgent first.
 *
 * When nothing has been scored at all — the model is down, or every
 * article is new and the call failed — this returns the input untouched
 * rather than an empty list. A blank strip reads as a broken terminal;
 * the honest degraded state is the unfiltered wire.
 */
export function filterBreaking(articles, threshold = BREAKING_THRESHOLD) {
  const list = Array.isArray(articles) ? articles : [];
  const scored = list.filter((a) => typeof a.breaking === 'number');
  if (scored.length === 0) return list;

  const kept = scored.filter((a) => a.breaking >= threshold);
  // Everything scored, nothing qualified: a genuinely quiet day. Fall
  // back to the best of what we have so the strip still says something,
  // and let the caller label it honestly.
  if (kept.length === 0) {
    return [...scored].sort((a, b) => b.breaking - a.breaking).slice(0, 5);
  }
  return kept.sort((a, b) => {
    if (b.breaking !== a.breaking) return b.breaking - a.breaking;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });
}
