import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';
import { locateQuote } from './claimExtraction.js';
import { entails } from './claimCheck.js';

// Reads a transcript looking for the answer to one specific question.
//
// This is the opposite direction from claimExtraction, which sweeps a
// transcript for whatever is substantive and leaves the linking until
// later. That misses answers that do not look like claims. Asked "how
// many boxes do you put back", a stocker replied "pack the whole thing";
// asked when they restock, "like 30% done". Both answer the question the
// research was built around — replacement count times restock frequency
// — and neither reads as an assertion worth extracting on its own.
//
// The integrity rule is unchanged and non-negotiable: the model must
// return the exact words it is relying on, we locate those words in the
// transcript ourselves, and an answer whose quote cannot be found is
// discarded. Asking a targeted question does not lower the bar for what
// counts as evidence.

const MAX_CHARS = 8_000;

const SYSTEM_PROMPT = `You are reading part of a field-research interview transcript, looking for the answer to ONE specific question.

The question will be given to you. Decide whether anyone in this passage actually answers it.

An answer does not have to be phrased like the question. Real answers in interviews are oblique:
  Q: "When restocking, how many units go back up?"
  A: "Pack the whole thing"                     -> yes. They refill to capacity.
  Q: "When do you restock?"
  A: "like 30% done"                            -> yes. They restock when about 30% is left.
  Q: "How does it sell?"
  A: "the sales for these are basically one or zero"  -> yes. That is the velocity.

But do not stretch. If nobody addresses the question, say so. The interviewer ASKING the question is not an answer — only what the source says back counts.

Some questions ask for several things at once — a count AND a comparison across brands, say. If the passage answers PART of it, that still counts: report it with "partial": true and say in the answer which part is covered and which is not. A partial answer is real evidence. Discarding it is how a question ends up looking like nobody was ever asked.

If there is an answer, return:
  "answer" — one plain sentence stating what the answer is.
  "quote"  — the EXACT words from the transcript, copied character for character, including "um", "uh", false starts and filler. It must appear verbatim or the answer is discarded. Prefer a short exact quote over a long tidied one.
  "partial" — true if it answers only part of what was asked.
  "confidence" — 0.0 to 1.0 that this really does answer the question.

Reply with strict JSON only:
{"found": true, "answer": "...", "quote": "...", "partial": false, "confidence": 0.8}
or
{"found": false}`;

function windows(turns, budget = MAX_CHARS) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const t of turns) {
    const len = (t.text || '').length + 16;
    if (size + len > budget && cur.length) {
      out.push(cur);
      cur = cur.slice(-6);
      size = cur.reduce((n, x) => n + (x.text || '').length + 16, 0);
    }
    cur.push(t);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

const render = (turns) =>
  turns
    .map((t) => `${t.speaker ? t.speaker.replace(/^speaker_/, 'Speaker ') : 'Unknown'}: ${t.text}`)
    .join('\n');

/**
 * Scan one transcript for the answer to one question.
 *
 * Returns the best located answer, or null. Never throws — a scan is an
 * enhancement, and one bad window must not cost the rest.
 *
 * @param {object} interview - { words, turns }
 * @param {string} question
 * @param {object} deps - injectable chat, for tests
 */
export async function scanForAnswer(interview, question, deps = {}) {
  const words = interview?.words || [];
  const turns = interview?.turns || [];
  if (words.length === 0 || !question) return null;
  const chat = deps.llmChat || llmChat;
  const verify = deps.entails || entails;

  let best = null;
  let rejected = 0;
  for (const win of windows(turns)) {
    let raw;
    try {
      raw = await chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `QUESTION\n${question}\n\nTRANSCRIPT\n${render(win)}` },
        ],
        jsonMode: true,
        temperature: 0,
        timeoutMs: 90_000,
        localModel: RESEARCH_LOCAL_MODEL,
      });
    } catch {
      continue;
    }
    if (!raw) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed?.found || !parsed.quote || !parsed.answer) continue;

    // Same gate as every other claim: the words must be in the tape.
    const located = locateQuote(words, parsed.quote);
    if (!located) continue;

    // And the second gate, which locateQuote cannot provide: the claim
    // has to be what the quote SAYS. Locating a quote proves the words
    // were spoken, not that the sentence written above them is a fair
    // reading of them. On the first live run this scan produced "Lindt
    // restocks to full capacity, while Hershey's restocks more
    // frequently and in larger quantities" over a verbatim quote that
    // mentions neither Hershey nor capacity. Every word of the citation
    // checked out and the claim was invented — the worst possible
    // combination, and more likely here than in the general extractor
    // because this pass has been told what it is hoping to find.
    const check = await verify(chat, question, parsed.quote, parsed.answer);
    if (!check.supported) {
      rejected += 1;
      continue;
    }

    const conf = Number(parsed.confidence);
    const score = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
    // Several windows can each offer an answer; keep the most confident
    // rather than the first, since the clearest statement is often later
    // in a conversation than the first mention.
    // A whole answer beats a partial one even if the partial came back
    // more confident — a model is often surest about the easy half.
    const rank = (a) => (a.partial ? 0 : 1) * 10 + a.extractionConfidence;
    const candidate = {
      quote: String(parsed.quote).trim(),
      startMs: located.startMs,
      endMs: located.endMs,
      speaker: located.speaker,
      // The checker sees the citation as a reader will, so when it
      // rewrites the answer to fit the quote, its wording wins.
      text: check.answer || String(parsed.answer).trim().slice(0, 500),
      // Pessimistic: either pass may call it partial, neither may
      // downgrade the other's caution.
      partial: parsed.partial === true || check.partial === true,
      extractionConfidence: score,
    };
    if (!best || rank(candidate) > rank(best)) best = candidate;
  }
  if (best) best.rejected = rejected;
  return best;
}
