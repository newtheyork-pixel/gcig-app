import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';

// Screens an outreach email BEFORE it goes out.
//
// The MNPI screen in mnpiScreen.js reads what a source told us and asks
// whether we may use it. This is the mirror image and the earlier
// problem: what are we about to ASK a stranger for, and does the
// question itself put them, or us, somewhere neither should be.
//
// The distinction matters because the risks are not the same ones.
// Nothing has been disclosed yet, so there is no MNPI to find. What
// there can be is a request that invites it, a claim about who we are
// that is not true, an implied payment, or a sentence that leans on
// somebody to breach an obligation they owe their employer. All four
// are things a person can write in complete good faith at eleven at
// night, and all four land in a stranger's inbox under the name of a
// school.
//
// Same two-pass shape as the MNPI screen, for the same reason: the
// keyword floor needs no network and cannot be unavailable, and the
// model pass catches the politely-phrased version the regex misses.
// Combined pessimistically. A screen that can be talked out of a flag
// is not a screen.

export const RISK = { LOW: 'low', ELEVATED: 'elevated', PROHIBITED: 'prohibited' };

// Phrases that change what an email is asking for. Each carries why,
// because a flag nobody can act on just gets clicked past.
const PATTERNS = [
  { re: /\b(?:current|latest|this)\s+(?:quarter|month)'?s?\s+(?:numbers|figures|revenue|results|volumes?)\b/i,
    why: 'Asks for current-period figures, which is a request for non-public information' },
  { re: /\b(?:unreleased|not\s+yet\s+public|non-?public|before\s+(?:it|they)\s+announce)\b/i,
    why: 'Explicitly asks for something that is not public' },
  { re: /\b(?:off\s+the\s+record|between\s+(?:us|you\s+and\s+me)|keep\s+this\s+(?:quiet|between))\b/i,
    why: 'Frames the conversation as confidential, which invites a disclosure rather than deterring one' },
  { re: /\b(?:internal|confidential)\s+(?:numbers|figures|documents?|reports?|data|forecast)\b/i,
    why: 'Asks for internal or confidential material by name' },
  { re: /\b(?:we|I)\s+(?:can|could|will|would)\s+(?:pay|compensate|offer)\b/i,
    why: 'Implies payment. This club does not pay for calls and must not suggest otherwise' },
  { re: /\b(?:consulting|hourly)\s+(?:fee|rate)\b/i,
    why: 'Refers to a fee arrangement we do not have' },
  { re: /\b(?:hedge\s+fund|our\s+firm|our\s+clients|portfolio\s+managers?\s+(?:here|at))\b/i,
    why: 'Language that overstates what we are. We are a school investment club and saying otherwise is a misrepresentation' },
  { re: /\b(?:your\s+)?(?:NDA|non-?disclosure|confidentiality\s+agreement)\b/i,
    why: 'Raises the recipient\'s confidentiality obligations, which we should not be navigating for them' },
  { re: /\b(?:don'?t\s+worry\s+about|no\s+one\s+(?:will|needs?\s+to)\s+know|nobody\s+has\s+to\s+know)\b/i,
    why: 'Reassures the recipient that a disclosure would go unnoticed' },
  { re: /\bguidance\s+(?:they|the\s+company)\s+(?:has|have)\s*n[o']?t\s+(?:given|issued)\b/i,
    why: 'Asks about guidance that has not been issued' },
];

// Things a cold email from a student club owes its recipient. Their
// ABSENCE is the finding, which no keyword list can catch by matching,
// so they are checked separately.
const REQUIRED = [
  {
    key: 'identifies-us',
    test: (t) => /grace church school|griffin fund|investment club/i.test(t),
    why: 'Does not say who we are. A cold email that does not identify the sender is indistinguishable from a phishing attempt',
  },
  {
    key: 'no-fee',
    test: (t) => /no\s+fee|nothing\s+commercial|not\s+(?:a\s+)?paid|unpaid/i.test(t),
    why: 'Does not say the call is unpaid. Expert networks pay for exactly this kind of conversation, so silence lets the recipient assume we do too',
  },
  {
    key: 'scope',
    test: (t) => /not\s+asking\s+about|nothing\s+confidential|already\s+public|business\s+today/i.test(t),
    why: 'Does not bound what we are asking for. Recently departed employees need to know we are not after their former employer\'s current business',
  },
];

/**
 * Deterministic pass. No network, no model, cannot be unavailable —
 * which is the point: the floor of the screen must run even when
 * everything else is down.
 *
 * Exported for tests.
 */
export function keywordScreen(text) {
  const body = String(text || '');
  const hits = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(body);
    if (!m) continue;
    const at = Math.max(0, m.index - 60);
    hits.push({
      kind: 'phrase',
      why: p.why,
      excerpt: body.slice(at, Math.min(body.length, m.index + m[0].length + 60)).trim(),
    });
  }
  for (const r of REQUIRED) {
    if (!r.test(body)) hits.push({ kind: 'missing', key: r.key, why: r.why, excerpt: null });
  }
  return hits;
}

const SYSTEM_PROMPT = `You are a compliance reviewer for a school investment club. Students manage part of their school's endowment and are writing cold emails to industry professionals as primary research.

You are reading an email BEFORE it is sent. Nothing has been disclosed yet. Judge the REQUEST, not any answer.

Flag it if the email:
- asks for information that would be material and non-public (current-period results, unissued guidance, unannounced deals)
- pressures or encourages the recipient to breach a confidentiality obligation to a current or former employer
- misrepresents who the senders are, for example implying a fund, firm, clients, or professional status
- offers or implies payment when none is on offer
- is written to a person whose position makes the request itself inappropriate, for example a sitting executive of the company being researched, asked about that company's operations

Do NOT flag:
- asking a FORMER employee how their job worked while they were there
- asking about industry conditions, competitors, or generally observable trends
- asking a customer or supplier about their own experience of a vendor
- asking for opinion, judgement, or historical context
- ordinary politeness, flattery about someone's background, or an explanation of why we are asking

An email that clearly states the club is unpaid, identifies the school, and bounds its questions to a person's own past experience is normally low risk. Reserve "prohibited" for a request that should not be sent as written, not for an uneasy feeling.

Reply with strict JSON only:
{"risk":"low|elevated|prohibited","reason":"one sentence","concerns":["short phrase"]}

  low        — ordinary, well-bounded research outreach
  elevated   — a person should read this before it goes
  prohibited — must not be sent as written`;

const ORDER = { low: 0, elevated: 1, prohibited: 2 };

/**
 * Screen one outreach email. Never throws.
 *
 * A screen that errors must fail toward caution rather than toward
 * silence, so a model that cannot be reached leaves `modelAvailable`
 * false and the caller is expected to say so rather than present the
 * keyword floor as a clean bill of health.
 *
 * @param {{subject:string, body:string}} draft
 * @param {object} target - { name, relationship, employer, tier }
 * @param {object} deps - injectable chat, for tests
 */
export async function screenOutreach(draft, target = {}, deps = {}) {
  const text = `Subject: ${draft?.subject || ''}\n\n${draft?.body || ''}`;
  const hits = keywordScreen(text);

  let risk = RISK.LOW;
  // Writing to somebody still inside the company we are researching is
  // the one relationship where the email itself is the exposure,
  // whatever it says. It starts elevated and the screen can only raise
  // it from there.
  if (target?.relationship === 'CurrentEmployee') risk = RISK.ELEVATED;
  if (hits.length > 0 && ORDER[RISK.ELEVATED] > ORDER[risk]) risk = RISK.ELEVATED;

  let modelRisk = null;
  let modelReason = null;
  let modelConcerns = [];
  let modelAvailable = false;

  const chat = deps.llmChat || llmChat;
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Recipient: ${target?.name || 'unknown'}` +
            `\nTheir relationship to the company we are researching: ${target?.relationship || 'unknown'}` +
            `\nCurrent employer: ${target?.employer || 'unknown'}` +
            `\n\n${text}`.slice(0, 20_000),
        },
      ],
      jsonMode: true,
      temperature: 0,
      timeoutMs: 60_000,
      preferQuality: true,
      localModel: RESEARCH_LOCAL_MODEL,
    });
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.risk && ORDER[parsed.risk] != null) {
        modelAvailable = true;
        modelRisk = parsed.risk;
        modelReason = String(parsed.reason || '').slice(0, 300);
        modelConcerns = Array.isArray(parsed.concerns)
          ? parsed.concerns.slice(0, 6).map((c) => String(c).slice(0, 160))
          : [];
        // Pessimistic combine: the model raises, never lowers.
        if (ORDER[modelRisk] > ORDER[risk]) risk = modelRisk;
      }
    }
  } catch {
    /* model unavailable — the keyword floor still stands */
  }

  const missing = hits.filter((h) => h.kind === 'missing');
  const phrases = hits.filter((h) => h.kind === 'phrase');
  const reason =
    modelReason ||
    (phrases.length
      ? `${phrases.length} phrase(s) that change what this email is asking for`
      : missing.length
      ? `Missing ${missing.length} thing(s) a cold email from this club should say`
      : risk === RISK.ELEVATED
      ? 'Recipient is a current employee of the company being researched'
      : 'Nothing found');

  return {
    risk,
    reason,
    hits,
    concerns: modelConcerns,
    modelRisk,
    // Surfaced so a "low" is not mistaken for a clean bill of health
    // when only the crude pass actually ran.
    modelAvailable,
    screenedAt: new Date().toISOString(),
  };
}
