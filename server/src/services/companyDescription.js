// A company description a person would actually read.
//
// The raw material is already here and has been for months: the 10-K's
// Item 1, pulled by secBusinessSummary. The problem was never the source,
// it was the register. Item 1 is written by the company about itself, in
// the first person, at length — General Dynamics arrives as 3,438
// characters beginning "We offer a broad portfolio of products and
// services in business aviation" — and next to a vendor's tight
// third-person paragraph it reads like a brochure, because it is one.
//
// Yahoo's is the comparison people reach for and it is not available:
// their quoteSummary endpoint now answers 401 without a cookie-and-crumb
// handshake, from a laptop as much as from a datacenter, and working
// around that is defeating an access control rather than using an API.
//
// So the filing is rewritten instead of replaced. Everything below comes
// from a document the company filed itself, which is a better provenance
// than a vendor's paraphrase, and the prompt's entire job is to stop the
// model adding anything to it.

import { llmChat } from './llm.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;   // matches the filing's own cache
const MAX_ENTRIES = 200;
const cache = new Map();

/// Deliberately narrow. A description that runs past a short paragraph
/// is the thing we started with.
const SYSTEM = `You rewrite a company's own 10-K "Item 1. Business" text into a
short factual description, in the register a financial data provider uses.

RULES, in order of importance:
1. Use ONLY the supplied text. You may not add a fact from your own
   knowledge, however certain — not a founding year, not a headquarters,
   not a competitor, not a figure. If the text does not say it, it does
   not appear.
2. Third person. The filing says "we design and manufacture"; you write
   "The company designs and manufactures".
3. Three or four sentences, roughly 60 to 90 words. What the business
   does, what its segments or main products are, and who it sells to.
4. No marketing language. Drop "world-class", "leading", "state-of-the-art",
   "innovative", "best-in-class" and every cousin of them, even where the
   filing insists.
5. No numbers unless the text states them plainly, and no percentages at
   all — a share of revenue quoted without its period is worse than none.

Return the paragraph and nothing else. No preamble, no heading, no quotes.`;

function evict() {
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/**
 * A clean description for one company, from its own filing.
 *
 * Returns `{ text, source }` or null. Null rather than a placeholder: a
 * panel that can tell "we have no description" from "here is a bad one"
 * can say so, and the raw Item 1 is still available beside it.
 */
export async function readableDescription(ticker, itemOneText, deps = {}) {
  const key = String(ticker || '').toUpperCase();
  const raw = String(itemOneText || '').trim();
  if (!key || raw.length < 200) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const chat = deps.llmChat || llmChat;
  // The first few thousand characters carry what the company does; the
  // rest of Item 1 is regulation, seasonality and human capital. Sending
  // all of it would cost tokens to bury the answer.
  const excerpt = raw.slice(0, 6000);

  let text = null;
  try {
    text = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Company: ${key}\n\nItem 1 text:\n${excerpt}` },
      ],
      temperature: 0.2,
      timeoutMs: 45_000,
    });
  } catch {
    text = null;
  }

  const clean = sanitize(text);
  // A failure caches for two minutes, not a week. The model being
  // unreachable for one request is not a fact about the company, and
  // storing it under the filing's TTL would cost a name its description
  // for seven days.
  const value = clean ? { text: clean, source: 'sec-10k-item1' } : null;
  cache.set(key, { at: clean ? Date.now() : Date.now() - TTL_MS + 120_000, value });
  evict();
  return value;
}

/**
 * Reject the shapes that mean the model ignored the brief.
 *
 * An LLM asked for a paragraph returns a paragraph most of the time and
 * a preamble, a bulleted list or a refusal the rest of it. None of those
 * belong on a company snapshot, and a half-parsed one looks like a bug
 * in the panel rather than in the prompt.
 */
export function sanitize(out) {
  let t = String(out || '').trim();
  if (!t) return null;
  // Strip a wrapping quote or a "Description:" lead-in.
  t = t.replace(/^["'`]+|["'`]+$/g, '').replace(/^\s*(description|summary)\s*:\s*/i, '').trim();
  if (t.length < 80) return null;
  if (t.length > 1200) t = `${t.slice(0, 1200).replace(/\s+\S*$/, '')}…`;
  // A list is not a description.
  if (/^\s*[-*•]\s/m.test(t)) return null;
  // The model declining, or narrating itself.
  if (/^(i\b|as an ai|sorry|i'm sorry|the (text|document) (does not|doesn't))/i.test(t)) return null;
  // First person survived: the one rule whose failure is most visible,
  // since it is exactly what the raw filing already read like.
  if (/\b(we|our|us)\b/i.test(t.slice(0, 200))) return null;
  return t;
}
