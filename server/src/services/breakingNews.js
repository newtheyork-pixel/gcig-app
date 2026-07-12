// Daily "breaking news" for the app Dashboard: at most ONE genuinely
// market-moving global headline per calendar day, chosen from the market-wide
// wire by the LLM. This is deliberately a high bar — the Dashboard banner
// should fire only for the kind of story a portfolio manager would want to
// know before markets open (a central-bank decision, a systemic shock, a
// major geopolitical or macro surprise), not routine single-stock noise.
//
// The decision is computed once per NY calendar day and cached in memory, so
// every member sees the same headline and we make one LLM call a day, not one
// per page load. If the LLM is unavailable we show nothing (and retry on a
// throttle) rather than guessing — "super important only" means silence is
// the correct default when we can't confidently classify.

import { getNewsForTicker } from './news.js';
import { llmChat } from './llm.js';

const CANDIDATE_COUNT = 15; // how many recent headlines the model ranks
const RETRY_THROTTLE_MS = 30 * 60 * 1000; // after a failed attempt, wait 30m

// NY calendar day (YYYY-MM-DD). The club and custodian run on New York time,
// so a pre-open headline should count toward that trading day.
function nyDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Cache is a single slot: the decision (or lack of one) for the current day.
//   { day, computed, result, lastTryAt }
// `computed:true` means we reached a definitive verdict for `day` (a headline
// or a confident "nothing critical"). `lastTryAt` throttles retries after a
// transient failure so a down LLM doesn't get hammered every page load.
let cache = { day: null, computed: false, result: null, lastTryAt: 0 };

function pickCandidates(articles) {
  return [...(articles || [])]
    .filter((a) => a && a.title && a.url)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, CANDIDATE_COUNT);
}

async function classify(candidates) {
  const list = candidates
    .map((a, i) => `${i}. [${a.source || 'wire'}] ${a.title}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        'You are the morning editor for a student investment fund. From a list of market-wide news headlines, ' +
        'identify AT MOST ONE that is genuinely market-moving on a global or systemic scale — the single story a ' +
        'portfolio manager must know before the open. Qualifying examples: a central-bank rate decision or surprise ' +
        'policy shift, a major macro surprise (CPI/jobs shock), a systemic financial event, a major geopolitical ' +
        'shock (war, sanctions, sovereign default), or a market-wide selloff/rally with a clear catalyst. ' +
        'Routine single-company news, analyst notes, earnings of one firm, and opinion pieces do NOT qualify. ' +
        'Be strict: most days there is NOTHING that clears this bar, and returning nothing is the right answer then.\n\n' +
        'Reply with strict JSON only, no prose, no code fences. Shape: ' +
        '{"critical": boolean, "index": number|null, "why": string}. ' +
        'If nothing qualifies, return {"critical": false, "index": null, "why": ""}. ' +
        '"index" is the 0-based position of the chosen headline. "why" is one short sentence (max 18 words).',
    },
    { role: 'user', content: `Headlines:\n${list}` },
  ];

  const raw = await llmChat({
    messages,
    jsonMode: true,
    temperature: 0,
    timeoutMs: 15_000,
    preferQuality: true,
  });
  if (!raw) return { unavailable: true };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unavailable: true };
  }
  if (!parsed || parsed.critical !== true) return { headline: null };

  const idx = Number(parsed.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    return { headline: null };
  }
  const a = candidates[idx];
  return {
    headline: {
      title: a.title,
      url: a.url,
      source: a.source || null,
      publishedAt: a.publishedAt || null,
      why: String(parsed.why || '').slice(0, 160),
    },
  };
}

// Returns { headline, day } where headline is the chosen story or null.
// Never throws — on any failure it returns a null headline for today.
export async function getDailyCriticalHeadline() {
  const day = nyDay();

  // New day — reset the slot.
  if (cache.day !== day) {
    cache = { day, computed: false, result: null, lastTryAt: 0 };
  }
  // Definitive verdict already cached for today.
  if (cache.computed) return { headline: cache.result, day };
  // A recent attempt failed — hold off so a down provider isn't hammered.
  if (cache.lastTryAt && Date.now() - cache.lastTryAt < RETRY_THROTTLE_MS) {
    return { headline: null, day };
  }

  try {
    const data = await getNewsForTicker('SPY', '');
    const candidates = pickCandidates(data?.articles);
    if (candidates.length === 0) {
      // No wire at all — treat as transient, allow a retry later today.
      cache = { day, computed: false, result: null, lastTryAt: Date.now() };
      return { headline: null, day };
    }

    const verdict = await classify(candidates);
    if (verdict.unavailable) {
      cache = { day, computed: false, result: null, lastTryAt: Date.now() };
      return { headline: null, day };
    }

    // Definitive verdict (a headline, or a confident "nothing"): cache for
    // the rest of the day so everyone sees the same thing and we stop calling.
    cache = { day, computed: true, result: verdict.headline || null, lastTryAt: Date.now() };
    return { headline: cache.result, day };
  } catch {
    cache = { day, computed: false, result: null, lastTryAt: Date.now() };
    return { headline: null, day };
  }
}
