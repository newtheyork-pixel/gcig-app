import { llmChat } from './llm.js';

// Screens an interview transcript for material non-public information.
//
// This is the layer that keeps field research on the right side of the
// line. A student calling a former distributor is ordinary diligence; a
// student who gets unreleased quarterly numbers out of someone still
// inside the company has received MNPI, and the fund trades — which is
// what turns a research problem into a securities problem.
//
// Two passes, deliberately in this order:
//
//   1. A keyword pass that cannot fail. Regexes over the transcript for
//      the phrases that accompany a disclosure — unreleased figures,
//      guidance, board decisions, pending deals. Crude and noisy, but it
//      runs with no model, no network, and no way to be unavailable.
//   2. A model pass that reads for meaning, because the dangerous cases
//      are phrased innocuously ("between us, the quarter came in at").
//
// The passes are combined pessimistically: either one firing raises the
// risk. A screen that can be talked out of a flag is not a screen.
//
// Nothing here auto-quarantines. The screen flags and explains; a person
// decides. Automatic suppression would teach people to route around it,
// and the audit trail matters more than the automation.

export const RISK = { LOW: 'low', ELEVATED: 'elevated', PROHIBITED: 'prohibited' };

// Phrases that tend to sit next to a disclosure. Each carries why it
// matters, so a flag is explicable rather than a mystery.
const PATTERNS = [
  { re: /\b(?:before|ahead of|prior to)\s+(?:the\s+)?(?:earnings|print|announcement|release)\b/i,
    why: 'Discusses information ahead of a scheduled release' },
  { re: /\b(?:unreleased|not\s+(?:yet\s+)?public|non-?public|hasn'?t\s+been\s+announced|before\s+it'?s\s+public)\b/i,
    why: 'Explicitly refers to information that is not public' },
  { re: /\b(?:guidance|forecast)\s+(?:we|they)\s+(?:haven'?t|have\s+not)\s+(?:given|issued|released)\b/i,
    why: 'Refers to guidance not yet issued' },
  { re: /\b(?:the\s+)?board\s+(?:has\s+)?(?:decided|approved|voted)\b/i,
    why: 'Refers to a board decision, which is usually non-public until announced' },
  { re: /\b(?:pending|unannounced)\s+(?:acquisition|merger|deal|transaction)\b/i,
    why: 'Refers to an unannounced transaction' },
  { re: /\bunder\s+(?:an?\s+)?NDA\b/i,
    why: 'Source indicates they are under a non-disclosure agreement' },
  { re: /\b(?:don'?t|do\s+not)\s+(?:tell|share|repeat)\s+(?:anyone|this)\b/i,
    why: 'Source asked for the information not to be shared' },
  { re: /\b(?:this\s+is\s+)?(?:confidential|off\s+the\s+record|between\s+(?:you\s+and\s+me|us))\b/i,
    why: 'Source framed the information as confidential' },
  { re: /\b(?:internal|company)\s+(?:numbers|figures|forecast|projections|model)\b/i,
    why: 'Refers to internal company figures' },
  { re: /\bQ[1-4]\s+(?:came|will\s+come)\s+in\s+at\b/i,
    why: 'States a specific quarterly result' },
];

/**
 * Deterministic keyword pass. No network, no model, cannot be
 * unavailable — which is the point: the floor of the screen must always
 * run, even when everything else is down.
 *
 * Exported for tests.
 */
export function keywordScreen(text) {
  const hits = [];
  const body = String(text || '');
  for (const p of PATTERNS) {
    const m = p.re.exec(body);
    if (!m) continue;
    // A little surrounding context, so a reviewer can judge without
    // opening the full transcript.
    const at = Math.max(0, m.index - 60);
    hits.push({
      why: p.why,
      excerpt: body.slice(at, Math.min(body.length, m.index + m[0].length + 60)).trim(),
    });
  }
  return hits;
}

const SYSTEM_PROMPT = `You are a compliance reviewer for an investment research team. You are reading a transcript of an interview a student analyst conducted with an industry source.

Decide whether the conversation contains MATERIAL NON-PUBLIC INFORMATION about a publicly traded company.

Material non-public information is specific, not-yet-disclosed information a reasonable investor would want before trading: unreleased financial results, guidance not yet issued, an unannounced acquisition or major contract, a pending regulatory action, an executive departure not yet public.

NOT MNPI, and must not be flagged:
- A former employee describing how the business worked while they were there
- Industry conditions, competitor behaviour, pricing trends generally observable
- A distributor or customer describing their OWN commercial terms and experience
- Opinion, prediction, and speculation, however confident
- Anything already public in filings or press

Judge what was actually said, not what the topic sounds like. Discussing rebates is normal channel work; being told next quarter's unreleased revenue is not.

Reply with strict JSON only:
{"risk":"low|elevated|prohibited","reason":"one sentence","excerpts":["quoted phrase"]}

  low        — ordinary industry diligence
  elevated   — brushes something sensitive, a human should read it
  prohibited — contains specific non-public information; must not be used

Default to "low" when the conversation is ordinary. Reserve "prohibited" for a genuine, specific disclosure, not for an uneasy feeling.`;

const ORDER = { low: 0, elevated: 1, prohibited: 2 };

/**
 * Screen a transcript. Never throws — a screen that errors must fail
 * toward caution, not toward silence.
 *
 * @param {string} transcript
 * @param {object} opts - { relationship } of the source
 * @param {object} deps - injectable chat, for tests
 * @returns {Promise<{risk, reason, hits, modelRisk, modelAvailable}>}
 */
export async function screenTranscript(transcript, opts = {}, deps = {}) {
  const hits = keywordScreen(transcript);

  // A current employee starts elevated regardless of what the screen
  // finds. The relationship itself is the risk factor; the transcript
  // only ever raises it.
  let risk =
    opts.relationship === 'CurrentEmployee' ? RISK.ELEVATED : RISK.LOW;
  if (hits.length > 0 && ORDER[RISK.ELEVATED] > ORDER[risk]) risk = RISK.ELEVATED;

  let modelRisk = null;
  let modelReason = null;
  let modelAvailable = false;

  const chat = deps.llmChat || llmChat;
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(transcript || '').slice(0, 30_000) },
      ],
      jsonMode: true,
      temperature: 0,
      timeoutMs: 60_000,
      preferQuality: true,
    });
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.risk && ORDER[parsed.risk] != null) {
        modelAvailable = true;
        modelRisk = parsed.risk;
        modelReason = String(parsed.reason || '').slice(0, 300);
        // Pessimistic combine: the model can raise the risk, never lower
        // what the keyword pass or the relationship already established.
        if (ORDER[modelRisk] > ORDER[risk]) risk = modelRisk;
      }
    }
  } catch {
    /* model unavailable — the keyword floor still stands */
  }

  const reason =
    modelReason ||
    (hits.length
      ? `${hits.length} phrase(s) associated with non-public information`
      : risk === RISK.ELEVATED
      ? 'Source is a current employee'
      : 'No indicators found');

  return {
    risk,
    reason,
    hits,
    modelRisk,
    // Surfaced so a "low" result is not mistaken for a clean bill of
    // health when only the crude pass actually ran.
    modelAvailable,
  };
}
