import { llmChat } from './llm.js';

// Pulls citable claims out of an interview transcript.
//
// The house rule is that nothing enters a report without a pinned
// source. This module is where that gets enforced rather than merely
// intended: a claim is only kept if its supporting quote is found
// verbatim in the transcript, which is what lets us resolve it to a real
// millisecond offset. A model that paraphrases, embellishes, or invents
// a quote produces a claim that fails to locate and is dropped.
//
// That check is the whole design. Asking an LLM for timestamps directly
// invites confident, wrong numbers; asking it for the exact words it is
// relying on, and then locating those words ourselves, makes fabrication
// self-defeating.
//
// Three distinctions the extractor must preserve, because collapsing
// them is how research goes wrong:
//   fact     — something the speaker observed or did ("we cut the rebate")
//   opinion  — their read ("I think they're losing share")
//   forecast — a claim about the future ("they'll raise price in Q3")
// A forecast from a distributor is not evidence in the way an invoice
// fact is, and a report that blurs them is overstating what it knows.

// Per-window budget, not a per-transcript one. See chunkTurns below for
// why the difference matters.
//
// Deliberately small. The model degrades badly on long inputs and does
// so silently: given 30k characters of a real interview it returned a
// bare `{}` rather than the requested shape, which reads downstream as
// "no claims here" and is indistinguishable from a quiet transcript. The
// same window at 12k produced four claims and at 6k produced six. Cost
// is more round trips; the alternative is confidently losing evidence.
const MAX_TRANSCRIPT_CHARS = 8_000;
// Windows overlap so a claim spoken across the seam is still wholly
// inside at least one of them.
const WINDOW_OVERLAP_TURNS = 6;

const SYSTEM_PROMPT = `You extract citable claims from an interview transcript for an investment research team. The interview is with an industry source — a former employee, distributor, customer, or competitor of a company under study.

Extract every substantive claim the SOURCE makes. Ignore the interviewer's questions, greetings, scheduling talk, and pleasantries.

For each claim return:
  "text"   — the claim in one clear sentence, in plain language. This is what a reader sees.
  "quote"  — the EXACT words from the transcript that support it, copied character for character. Do not paraphrase, correct grammar, fix typos, or join separated passages. It must appear verbatim in the transcript or the claim will be discarded.
  "topic"  — a short normalized subject, 1-3 words, lowercase (e.g. "rebate structure", "store traffic", "lead times"). Reuse the same wording for the same subject so claims from different interviews group together.
  "kind"   — one of: fact | opinion | forecast
             fact     = something the speaker directly observed, did, or handled
             opinion  = their interpretation or judgement
             forecast = a claim about the future
  "confidence" — 0.0 to 1.0, how confident you are that "text" faithfully represents what was said. This is NOT whether the claim is true.

Rules:
- Prefer specifics. "Rebates were cut about 200 basis points in Q2" is a claim; "things got worse" is not.
- One assertion per claim. Split compound statements.
- Never infer beyond the words. If the source implies something without saying it, do not extract it.
- If the source hedges ("I think", "maybe"), that is an opinion, not a fact.
- The quote must be a contiguous span of the transcript, long enough to locate but not a whole paragraph.

Reply with strict JSON only, no prose, no code fences:
{"claims":[{"text":"...","quote":"...","topic":"...","kind":"fact","confidence":0.9}]}
If the transcript contains no substantive claims, return {"claims":[]}.`;

// Collapse to comparable text: the model reliably drifts on whitespace,
// smart quotes and casing even when told not to, and none of those
// change what was said. Anything beyond this — reordered or reworded —
// should fail to match, which is the point.
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9'"\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find a quote in the word stream and return its millisecond span.
 *
 * Works on the normalized token sequence rather than the rendered
 * transcript so the result maps straight back to word offsets. Returns
 * null when the quote isn't present — the caller MUST drop the claim
 * rather than store it with a guessed time.
 *
 * Exported for tests: this function is the integrity gate.
 */
export function locateQuote(words, quote) {
  const needle = normalizeForMatch(quote).split(' ').filter(Boolean);
  if (needle.length === 0) return null;

  // Token list parallel to `words`, so an index here is an index there.
  const hay = words.map((w) => normalizeForMatch(w.text));

  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      const first = words[i];
      const last = words[i + needle.length - 1];
      return {
        startMs: first.startMs,
        endMs: last.endMs ?? last.startMs,
        // Attribution comes from the transcript, never from the model.
        // If the span crosses a speaker change the quote is spliced and
        // cannot be safely attributed to anyone.
        speaker: spanSpeaker(words, i, i + needle.length - 1),
      };
    }
  }
  return null;
}

// One speaker across the whole span, or null. A quote that straddles a
// turn boundary has no single author, and attributing it to either voice
// would be an invention.
function spanSpeaker(words, from, to) {
  const first = words[from]?.speaker ?? null;
  for (let i = from; i <= to; i++) {
    if ((words[i]?.speaker ?? null) !== first) return null;
  }
  return first;
}

function renderTurns(turns) {
  return turns
    .map((t) => `${t.speaker ? t.speaker.replace(/^speaker_/, 'Speaker ') : 'Unknown'}: ${t.text}`)
    .join('\n');
}

// Split a long interview into overlapping windows.
//
// This replaces a hard head-truncation, which was silently the worst
// possible choice for exactly the interviews worth having. A 39-minute
// expert call opens with rapport — schools, where everyone grew up —
// and gets to the substance later. Cutting at 40k characters fed the
// model the small talk and threw away the economics, so the richest
// transcript in the corpus yielded zero claims while three-minute store
// chats yielded plenty. Long conversations are now covered end to end.
export function chunkTurns(turns, budget = MAX_TRANSCRIPT_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const t of turns) {
    const len = (t.text || '').length + 16; // + speaker label
    if (size + len > budget && current.length) {
      chunks.push(current);
      // Carry the tail forward so a claim spanning the boundary is
      // wholly present in the next window too.
      current = current.slice(-WINDOW_OVERLAP_TURNS);
      size = current.reduce((n, x) => n + (x.text || '').length + 16, 0);
    }
    current.push(t);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Extract claims from a transcript, each pinned to a verified offset.
 *
 * Returns `{ claims, dropped }`. `dropped` counts claims the model
 * produced whose quotes could not be found — a number worth surfacing,
 * because a sudden spike means the model started paraphrasing and the
 * extraction should not be trusted that run.
 *
 * @param {object} interview - { words, turns }
 * @param {object} deps - injectable chat, for tests
 */
export async function extractClaims(interview, deps = {}) {
  const words = interview?.words || [];
  const turns = interview?.turns || [];
  if (words.length === 0) return { claims: [], dropped: 0, unavailable: true };

  const chat = deps.llmChat || llmChat;
  const windows = chunkTurns(turns);

  const rows = [];
  let anyResponse = false;
  let failedWindows = 0;
  for (const [i, window] of windows.entries()) {
    const label = windows.length > 1 ? ` (part ${i + 1} of ${windows.length})` : '';
    const raw = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript${label}:\n${renderTurns(window)}` },
      ],
      jsonMode: true,
      temperature: 0,
      timeoutMs: 120_000,
      preferQuality: true,
    });
    if (!raw) { failedWindows += 1; continue; }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // One unparseable window shouldn't cost the rest of the call.
    }
    // A reply with no `claims` array is the model failing to answer, NOT
    // a window with nothing in it. Conflating the two is how a silent
    // model failure gets reported as a finding.
    if (!parsed || !Array.isArray(parsed.claims)) {
      failedWindows += 1;
      continue;
    }
    anyResponse = true;
    rows.push(...parsed.claims);
  }
  if (!anyResponse) return { claims: [], dropped: 0, unavailable: true, failedWindows };
  const claims = [];
  let dropped = 0;

  for (const row of rows) {
    const text = String(row?.text || '').trim();
    const quote = String(row?.quote || '').trim();
    if (!text || !quote) {
      dropped += 1;
      continue;
    }
    const located = locateQuote(words, quote);
    if (!located) {
      // The model cited words that aren't in the transcript. Dropping is
      // the only safe move: a claim with no locatable evidence is
      // exactly the thing the pinned-source rule exists to prevent.
      dropped += 1;
      continue;
    }
    const kind = ['fact', 'opinion', 'forecast'].includes(row?.kind)
      ? row.kind
      : 'fact';
    const confidence = Number(row?.confidence);
    claims.push({
      text,
      quote,
      topic: String(row?.topic || '').trim().toLowerCase().slice(0, 60) || null,
      kind,
      extractionConfidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : null,
      startMs: located.startMs,
      endMs: located.endMs,
      speaker: located.speaker,
    });
  }

  // Overlapping windows can surface the same statement twice. Dedupe on
  // where it was said, not on the wording, since two windows can phrase
  // the same claim slightly differently.
  const seen = new Set();
  const unique = [];
  for (const c of claims) {
    const key = `${c.startMs}:${c.quote.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  // Chronological: a claim ledger reads as the conversation went.
  unique.sort((a, b) => a.startMs - b.startMs);
  // failedWindows is surfaced so a partial extraction is never mistaken
  // for a complete one — a transcript that returned claims from four of
  // six windows has not been fully read.
  return { claims: unique, dropped, failedWindows, windows: windows.length };
}
