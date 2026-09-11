import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';

// What happened on a call, worked out rather than typed in.
//
// The outcome used to be eight buttons somebody pressed at the end of
// every dial. That is the wrong tax: an analyst who has just hung up is
// thinking about what the manager said, and a queue that demands a
// button before it will move is a queue people stop working. Worse, the
// buttons were the ONLY way to close a call, so a forgotten press left a
// row open forever and the timer ran on.
//
// Two sources answer it between them, and they are asked in this order
// because the cheap one is also the more reliable one:
//
//   THE PHONE'S OWN RECORD settles the cases that are not about content
//   at all. A call the handset says was never answered is NoAnswer, and
//   no model should be asked to infer that from an empty transcript,
//   because an empty transcript is also what a recorder failure looks
//   like. Zero duration and not answered is a fact; silence is not.
//
//   THE TRANSCRIPT settles the rest, and only the rest. Somebody picked
//   up: were they willing to talk, was it a machine, was it the wrong
//   number? That is a reading question and it is what the local model is
//   for.
//
// It fails OPEN, to null, and says so. An outcome nobody could establish
// has to be visibly missing rather than quietly filed as NoAnswer, which
// is the value that would flatter the refusal rate.

export const OUTCOMES = [
  'Answered', 'NoAnswer', 'Busy', 'Voicemail',
  'Refused', 'WrongNumber', 'CallBackLater', 'Failed',
];

const SYSTEM_PROMPT = `You classify what happened on a short telephone call that a research analyst placed to a retail store.

You are given the transcript. Answer with JSON only:
{"outcome": "<one of Answered|Voicemail|Refused|WrongNumber|CallBackLater>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}

Definitions, and the distinctions that matter:
- Answered: a person picked up and engaged with at least one question about the store.
- Refused: a person picked up and declined to discuss it, or said they are not allowed to. A polite deflection is still Refused.
- Voicemail: an answering machine, an automated menu, or a recorded message. No live person spoke.
- WrongNumber: the number did not reach the business named, or reached a disconnected line.
- CallBackLater: a person picked up and asked to be called another time without answering anything.

Rules:
- Refused and Answered are different findings and must not be blurred. If they answered one substantive question and then declined the rest, that is Answered.
- If the transcript is too short or too garbled to tell, use confidence below 0.4 and pick your best reading anyway.
- Never invent a reason that is not in the transcript.`;

/**
 * @param {object} args
 * @param {string} [args.transcript]
 * @param {object} [args.record] what the phone logged: { answered, durationMs }
 * @param {object} [deps] test seams
 * @returns {Promise<{outcome: string|null, confidence: number|null, reason: string,
 *                    source: 'callrecord'|'model'|'none', modelAvailable: boolean}>}
 */
export async function inferOutcome({ transcript, record } = {}, deps = {}) {
  const chat = deps.llmChat || llmChat;

  // The handset's own answer, where it has one. A call nobody picked up
  // needs no reading and must not get one.
  if (record && record.answered === false) {
    return {
      outcome: 'NoAnswer',
      confidence: 1,
      reason: 'The phone recorded the call as never answered.',
      source: 'callrecord',
      modelAvailable: true,
    };
  }

  const text = String(transcript || '').trim();
  if (!text) {
    // No transcript and no record saying otherwise. This is exactly the
    // case that must NOT be guessed: a recorder that failed and a store
    // that never picked up produce the same emptiness.
    return {
      outcome: null,
      confidence: null,
      reason: 'No transcript and nothing from the phone, so the outcome is unestablished.',
      source: 'none',
      modelAvailable: true,
    };
  }

  let raw;
  try {
    raw = await chat({
      job: 'screen',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 20_000) },
      ],
      jsonMode: true,
      temperature: 0,
      localModel: RESEARCH_LOCAL_MODEL,
    });
  } catch {
    raw = null;
  }

  if (!raw) {
    // A model that did not answer is not a finding. Saying so beats
    // filing every call of an outage as whatever the default was.
    return {
      outcome: null,
      confidence: null,
      reason: 'The classifier was unavailable, so nobody has read this call yet.',
      source: 'none',
      modelAvailable: false,
    };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    parsed = null;
  }
  const outcome = OUTCOMES.includes(parsed?.outcome) ? parsed.outcome : null;
  if (!outcome) {
    return {
      outcome: null,
      confidence: null,
      reason: 'The classifier returned something that is not an outcome.',
      source: 'none',
      modelAvailable: true,
    };
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : null;

  return {
    outcome,
    confidence,
    reason: String(parsed.reason || '').slice(0, 300),
    source: 'model',
    modelAvailable: true,
  };
}
