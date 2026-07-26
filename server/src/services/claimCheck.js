import { RESEARCH_LOCAL_MODEL } from './llm.js';

// The second integrity gate, and the one that took longest to see the
// need for.
//
// locateQuote proves the words were spoken. It says nothing about
// whether the sentence written above them is a fair reading of them, and
// a claim that fails there is far more dangerous than one that fails to
// locate: the citation is perfect. The timestamp is real, the speaker is
// right, the quote is verbatim, and the assertion is invented. Nothing
// about it looks wrong.
//
// It is not hypothetical. In the Lindt ledger, "It's like 44% to Amazon,
// 60% to Lindt" had been written up as a 44/56 split — the model tidied
// the numbers so they would sum to 100 — and "But the stuff over there
// sell a lot" became a ranking of three named brands the speaker never
// mentioned.

// Deliberately shown the question and the quote and NOTHING else — no
// surrounding transcript. That is exactly what a reader following the
// footnote gets, and a claim that needs more context than the citation
// carries is a claim the citation does not support.
const COMMON = `Reject the proposed claim if it states anything the quote does not say. Be strict about these, which are the failures that actually happen:
  - naming a brand, product, number, direction or comparison the quote never mentions
  - changing a figure, including "tidying" two numbers so they sum to 100
  - turning "I'm not sure", "I guess" or a hedge into a finding

If you accept it but the wording goes beyond the quote, rewrite it in "answer" so it says only what the quote says.

Reply with strict JSON only:
{"supported": true, "partial": false, "answer": "..."}
or
{"supported": false}`;

const CHECK_PROMPT = `You are checking whether a proposed answer is honestly supported by a quote.

You will see a QUESTION, a verbatim QUOTE from an interview, and a PROPOSED ANSWER written from it. You do NOT get the rest of the transcript, on purpose: a reader following this citation will hear only this quote.

${COMMON}

Also reject it if it answers a different question than the one asked.

Accept it if the quote plainly says it, allowing for the QUESTION to supply the subject — asked "How often do reps come?", the quote "once a week" is a complete answer.

If the quote supports only part of what was asked, accept it with "partial": true.`;

// The extractor's claims stand alone — there is no question to supply a
// subject, so an unstated subject is exactly the kind of drift to catch.
// "The vendor comes once a week" is not evidence about Lindt unless the
// speaker said Lindt.
const STANDALONE_PROMPT = `You are checking whether a claim pulled from an interview is honestly supported by the quote cited for it.

You will see a verbatim QUOTE and a PROPOSED CLAIM written from it. You do NOT get the rest of the transcript, on purpose: a reader following this citation will hear only this quote.

This claim will be read on its own, with no question beside it, so it must stand up on its own. If the quote says "the vendor comes once a week" and the claim says "the Lindt vendor comes once a week", the claim has added a fact the citation does not carry — narrow it rather than accepting it.

${COMMON}`;

// Returns { supported, partial, answer }. A checker that cannot be
// reached rejects — an unverifiable claim is not a claim, and the whole
// reason this pass exists is that the failure it catches looks perfect
// from the outside.
// `question` may be null, for the extractor's standalone claims.
export async function entails(chat, question, quote, proposed) {
  if (!quote || !proposed) return { supported: false };
  let raw;
  try {
    raw = await chat({
      messages: [
        { role: 'system', content: question ? CHECK_PROMPT : STANDALONE_PROMPT },
        {
          role: 'user',
          content: question
            ? `QUESTION\n${question}\n\nQUOTE\n"${quote}"\n\nPROPOSED ANSWER\n${proposed}`
            : `QUOTE\n"${quote}"\n\nPROPOSED CLAIM\n${proposed}`,
        },
      ],
      jsonMode: true,
      temperature: 0,
      timeoutMs: 60_000,
      localModel: RESEARCH_LOCAL_MODEL,
    });
  } catch {
    return { supported: false };
  }
  if (!raw) return { supported: false };
  try {
    const p = JSON.parse(raw);
    if (p?.supported !== true) return { supported: false };
    return {
      supported: true,
      partial: p.partial === true,
      answer: typeof p.answer === 'string' && p.answer.trim()
        ? p.answer.trim().slice(0, 500)
        : null,
    };
  } catch {
    return { supported: false };
  }
}
