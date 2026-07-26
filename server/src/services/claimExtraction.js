import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';
import { entails } from './claimCheck.js';

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

COPYING THE QUOTE IS THE PART THAT MATTERS MOST. This is spoken conversation, transcribed as spoken. It is full of "um", "uh", "like", "you know", false starts, repeated words and stray "Okay" / "Yeah" / "Right". Copy all of it, exactly as it appears, including the filler. Do NOT tidy the sentence.

  Transcript:  So they kind of have fallen off a little bit on terms of competition. Okay. So I feel like Lindt
  WRONG quote: "fallen off a little bit on terms of competition. So I feel like Lindt"   <- dropped "Okay."
  RIGHT quote: "fallen off a little bit on terms of competition"                        <- stop before the filler

If cleaning it up is tempting, choose a SHORTER span that needs no cleaning. A short exact quote is worth far more than a long tidied one, because a quote that does not match the transcript character for character is discarded and the claim is lost with it. When in doubt, quote less.

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
// A real interview is full of backchannel: the interviewer says "Yeah",
// "Right", "Mm-hmm" while the source is mid-sentence. The source's
// sentence is one statement, and the transcript splits it in three. A
// strictly contiguous match rejects those quotes, which on a 39-minute
// expert call threw away more real claims than it caught.
//
// So a match may step over words belonging to a DIFFERENT speaker, up to
// this many in a row. It may never step over the speaker's own words —
// that would let two separate things they said be stitched into one
// sentence they never uttered, which is exactly the fabrication this
// gate exists to stop.
const MAX_INTERJECTION_WORDS = 8;

export function locateQuote(words, quote) {
  // An ellipsis is the model telling us where it left material out —
  // ordinary quoting convention, and it turned out to be the single
  // largest cause of dropped claims on a real interview. Honour it:
  // every fragment still has to appear verbatim, in order, from one
  // speaker. Nothing is taken on trust, we simply stop pretending the
  // speaker said one unbroken sentence when the model said otherwise.
  const parts = String(quote || '')
    .split(/\s*(?:\.{3,}|…)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length > 1) return locateElided(words, parts);

  const needle = normalizeForMatch(quote).split(' ').filter(Boolean);
  if (needle.length === 0) return null;

  const hay = words.map((w) => normalizeForMatch(w.text));

  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    const speaker = words[i].speaker ?? null;
    let j = 1;      // next needle word to match
    let k = i + 1;  // cursor in the transcript
    let lastHit = i;
    let ok = true;

    while (j < needle.length && k < hay.length) {
      if ((words[k].speaker ?? null) !== speaker) {
        // Someone else spoke. Allow a short interjection, then give up.
        let skipped = 0;
        while (k < hay.length && (words[k].speaker ?? null) !== speaker && skipped < MAX_INTERJECTION_WORDS) {
          k += 1;
          skipped += 1;
        }
        if (k >= hay.length || (words[k].speaker ?? null) !== speaker) { ok = false; break; }
        continue;
      }
      // Same speaker: the next word must be the next word of the quote.
      // Skipping here would splice two separate statements together.
      if (hay[k] !== needle[j]) { ok = false; break; }
      lastHit = k;
      j += 1;
      k += 1;
    }

    if (ok && j === needle.length) {
      return {
        startMs: words[i].startMs,
        endMs: words[lastHit].endMs ?? words[lastHit].startMs,
        // Every matched word belongs to one speaker by construction, so
        // attribution is safe. Unlabelled audio still yields null rather
        // than a guess.
        speaker,
      };
    }
  }
  return null;
}

// Locate a quote the model wrote with elisions. Each fragment must be
// found verbatim, each after the last, and all from the same speaker —
// so this can never join two different people, nor reorder what one
// person said. The reported span runs from the first fragment's start to
// the last fragment's end, which is the honest extent of the passage.
function locateElided(words, parts) {
  let cursor = 0;
  let speaker;
  let startMs = null;
  let endMs = null;

  for (const part of parts) {
    const tail = words.slice(cursor);
    const hit = locateQuote(tail, part);
    if (!hit) return null;
    if (speaker === undefined) speaker = hit.speaker;
    // Every fragment must come from the same voice. A quote assembled
    // from two speakers is not a statement anyone made.
    else if (hit.speaker !== speaker) return null;
    if (startMs === null) startMs = hit.startMs;
    endMs = hit.endMs;
    // Advance past this fragment so the next one must follow it.
    const at = tail.findIndex((w) => w.startMs === hit.startMs);
    cursor += (at === -1 ? 0 : at) + 1;
  }
  if (startMs === null || !speaker) return null;
  return { startMs, endMs, speaker };
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
const REPAIR_PROMPT = `You wrote a claim from an interview transcript, but the quote you gave for it does not appear in the transcript word for word — so it cannot be used.

You will see the TRANSCRIPT and the CLAIM. Find the words that support the claim and copy them EXACTLY as they appear: same wording, same punctuation, same "um" and "uh" and false starts. Do not tidy anything.

Two hard rules:
  - ONE contiguous run of words. Do not join passages from different places, even if both support the claim. Stitching a speaker's separated words into one sentence puts words in their mouth they never said in that order.
  - ONE speaker. If the support is split across a question and an answer, quote only the answer.

If no single contiguous passage supports the claim, say so — that is a normal and correct outcome, and far better than a quote that does not exist.

Reply with strict JSON only:
{"quote": "..."}
or
{"quote": null}`;

// One more attempt at the exact words, before a claim is thrown away.
//
// Returns the repaired quote or null. Anchors nothing itself — the
// caller still has to locate it — so this can only recover claims, never
// admit one that could not be found.
async function repairQuote(chat, context, claim) {
  if (!context || !claim) return null;
  let raw;
  try {
    raw = await chat({
      messages: [
        { role: 'system', content: REPAIR_PROMPT },
        { role: 'user', content: `TRANSCRIPT\n${context}\n\nCLAIM\n${claim}` },
      ],
      jsonMode: true,
      temperature: 0,
      timeoutMs: 60_000,
      localModel: RESEARCH_LOCAL_MODEL,
    });
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const q = JSON.parse(raw)?.quote;
    return typeof q === 'string' && q.trim() ? q.trim() : null;
  } catch {
    return null;
  }
}

export async function extractClaims(interview, deps = {}) {
  const words = interview?.words || [];
  const turns = interview?.turns || [];
  if (words.length === 0) return { claims: [], dropped: 0, unavailable: true };

  const chat = deps.llmChat || llmChat;
  const check = deps.entails || entails;
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
      localModel: RESEARCH_LOCAL_MODEL,
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
    // Carry the window each claim came out of, so the check can see the
    // conversation the speaker was having and tell a subject supplied by
    // context from one invented outright.
    const ctx = renderTurns(window);
    rows.push(...parsed.claims.map((c) => (c && typeof c === 'object' ? { ...c, __context: ctx } : c)));
  }
  if (!anyResponse) return { claims: [], dropped: 0, unavailable: true, failedWindows };
  const claims = [];
  let dropped = 0;
  let unsupported = 0;

  for (const row of rows) {
    const text = String(row?.text || '').trim();
    const quote = String(row?.quote || '').trim();
    if (!text || !quote) {
      dropped += 1;
      continue;
    }
    let located = locateQuote(words, quote);
    let finalQuote = quote;
    if (!located) {
      // The model cited words that aren't in the transcript verbatim.
      // Usually that is not invention, it is tidying: it summarised
      // across two sentences, or stitched a speaker's separated words
      // into one. locateQuote refuses both, correctly — but the drop
      // rate is not evenly spread. Short store-visit exchanges lose
      // nothing; a 47,000-character call with an economist lost 29 of
      // 40, and that is the single most substantive source in the
      // project being read at a quarter of its value.
      //
      // So ask once more for the actual words before giving up. This
      // loosens nothing: the repaired quote faces the same locateQuote
      // and the same entailment check, and a claim that still cannot be
      // anchored is still dropped.
      const repaired = await repairQuote(chat, row.__context, text);
      located = repaired ? locateQuote(words, repaired) : null;
      if (!located) {
        dropped += 1;
        continue;
      }
      finalQuote = repaired;
    }
    // Locating the quote proves the words were spoken. It does not prove
    // the claim written above them is a fair reading, and that failure
    // wears a perfect citation — real timestamp, right speaker, verbatim
    // quote, invented assertion. It reached the Lindt ledger: "It's like
    // 44% to Amazon, 60% to Lindt" was written up as a 44/56 split
    // because 44 and 56 sum to 100, and "But the stuff over there sell a
    // lot" became a ranking of three brands nobody named.
    // The window this claim came out of is the context that can supply
    // a subject the quote leaves implicit.
    const verdict = await check(chat, null, finalQuote, text, row.__context || null);
    if (!verdict.supported) {
      unsupported += 1;
      continue;
    }
    const kind = ['fact', 'opinion', 'forecast'].includes(row?.kind)
      ? row.kind
      : 'fact';
    const confidence = Number(row?.confidence);
    claims.push({
      // Narrowed to what the quote carries where the checker rewrote it.
      text: verdict.answer || text,
      quote: finalQuote,
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
  return { claims: unique, dropped, unsupported, failedWindows, windows: windows.length };
}
