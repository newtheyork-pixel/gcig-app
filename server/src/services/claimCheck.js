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

// Shown the quote and the conversation immediately around it, and
// nothing further.
//
// The first cut showed the quote alone, reasoning that a reader
// following the footnote hears only the quote. Run against the 62 claims
// already in the Lindt ledger it rejected 37 of them — and most of those
// were honest. "The vendor comes like once a week", written up as a
// claim about Lindt's restock frequency, is not a fabrication; the
// speaker was plainly discussing Lindt, and the citation in this system
// walks back to audio a reader can simply play. A check that cannot tell
// that from "44% to Amazon, 60% to Lindt" becoming a 44/56 split would
// have gutted a real research ledger to catch a handful of inventions.
//
// So context licenses the SUBJECT and never the CONTENT: a figure or a
// comparison present in neither the quote nor the surrounding turns was
// invented, and no amount of context makes it supported.
const COMMON = `You may also be shown CONTEXT — the conversation immediately around the quote. A claim may lean on it for the SUBJECT under discussion: if the speaker was plainly talking about Lindt, "the vendor comes once a week" supports a claim about Lindt's vendor. Prefer to narrow such a claim rather than reject it.

What CONTEXT does not license is content. A number, brand, comparison or direction appearing in neither the quote nor the context was invented, and no amount of context makes it supported.

Reject the proposed claim if it states anything the quote and context do not say. Be strict about these, which are the failures that actually happen:
  - naming a brand, product, number, direction or comparison the quote never mentions
  - changing a figure, including "tidying" two numbers so they sum to 100
  - turning "I'm not sure", "I guess" or a hedge into a finding

If you accept it but the wording goes beyond the quote, rewrite it in "answer" so it says only what the quote says.

Reply with strict JSON only:
{"supported": true, "partial": false, "answer": "..."}
or
{"supported": false}`;

const CHECK_PROMPT = `You are checking whether a proposed answer is honestly supported by a quote.

You will see a QUESTION, a verbatim QUOTE from an interview, the CONTEXT around it, and a PROPOSED ANSWER written from it. You do not get the rest of the transcript.

${COMMON}

Also reject it if it answers a different question than the one asked.

Accept it if the quote plainly says it, allowing for the QUESTION to supply the subject — asked "How often do reps come?", the quote "once a week" is a complete answer.

If the quote supports only part of what was asked, accept it with "partial": true.`;

// The extractor's claims are read with no question beside them, so the
// conversation around the quote is the only thing that can supply a
// subject — which is exactly why it is shown.
const STANDALONE_PROMPT = `You are checking whether a claim pulled from an interview is honestly supported by the quote cited for it.

You will see a verbatim QUOTE, the CONTEXT around it, and a PROPOSED CLAIM written from it. You do not get the rest of the transcript.

This claim will be read on its own, with no question beside it. Where the claim names a subject the quote omits, check the context: if the speaker was clearly discussing it, that is fair. If nothing in either mentions it, it was added.

${COMMON}`;

// Returns { supported, partial, answer }. A checker that cannot be
// reached rejects — an unverifiable claim is not a claim, and the whole
// reason this pass exists is that the failure it catches looks perfect
// from the outside.
// `question` may be null, for the extractor's standalone claims.
export async function entails(chat, question, quote, proposed, context = null) {
  if (!quote || !proposed) return { supported: false };
  const ctx = context ? `\n\nCONTEXT\n${String(context).slice(0, 4000)}` : '';
  let raw;
  try {
    raw = await chat({
    job: 'claims',
      messages: [
        { role: 'system', content: question ? CHECK_PROMPT : STANDALONE_PROMPT },
        {
          role: 'user',
          content: question
            ? `QUESTION\n${question}\n\nQUOTE\n"${quote}"${ctx}\n\nPROPOSED ANSWER\n${proposed}`
            : `QUOTE\n"${quote}"${ctx}\n\nPROPOSED CLAIM\n${proposed}`,
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
