import { llmChat } from './llm.js';
import { locateQuote } from './claimExtraction.js';

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

If there is an answer, return:
  "answer" — one plain sentence stating what the answer is.
  "quote"  — the EXACT words from the transcript, copied character for character, including "um", "uh", false starts and filler. It must appear verbatim or the answer is discarded. Prefer a short exact quote over a long tidied one.
  "confidence" — 0.0 to 1.0 that this really does answer the question.

Reply with strict JSON only:
{"found": true, "answer": "...", "quote": "...", "confidence": 0.8}
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

  let best = null;
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
        preferQuality: true,
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

    const conf = Number(parsed.confidence);
    const score = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
    // Several windows can each offer an answer; keep the most confident
    // rather than the first, since the clearest statement is often later
    // in a conversation than the first mention.
    if (!best || score > best.extractionConfidence) {
      best = {
        text: String(parsed.answer).trim().slice(0, 500),
        quote: String(parsed.quote).trim(),
        startMs: located.startMs,
        endMs: located.endMs,
        speaker: located.speaker,
        extractionConfidence: score,
      };
    }
  }
  return best;
}
