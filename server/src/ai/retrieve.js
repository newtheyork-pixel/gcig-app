// Pick the evidence a question actually needs.
//
// The research section was assembled by dumping everything we had and
// hoping: twelve kilobytes of findings, valuations and store notes on
// every message. Reading the assembled prompt showed the material was
// genuinely there — the DCF, all five EV/OE multiples — and the model
// still answered "we did not establish any valuation methods". Content
// present, not retrieved. More stuffing cannot fix that; the fix is to
// send less and make it the right less.
//
// Deliberately not embeddings. This runs on every message, it has to be
// fast, and it has to be TESTABLE — a scorer whose behaviour I can pin
// in a unit test is worth more here than one that is marginally better
// at synonyms. Term overlap with a few weightings gets the DCF question
// to the DCF chunk, which is the whole job.

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'what', 'whats', 'how', 'why', 'when', 'where', 'which', 'who', 'our',
  'we', 'us', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'about', 'from', 'by', 'as', 'can', 'could', 'would', 'should', 'say',
  'says', 'said', 'give', 'get', 'tell', 'me', 'have', 'has', 'had', 'any',
  'all', 'so', 'if', 'not', 'no', 'yes', 'please', 'there', 'their',
]);

export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9./%-]+/)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Words that mean "this is a question about the model, not the fieldwork".
// A question naming none of the interview vocabulary but asking for a
// price target has to reach the valuation chunk, and term overlap alone
// will not get it there — "DCF" appears in the chunk, but "cases" and
// "multiples" may not.
const KIND_HINTS = {
  valuation: [
    'dcf', 'valuation', 'valuations', 'value', 'worth', 'multiple', 'multiples',
    'ev', 'ebit', 'ebitda', 'oe', 'target', 'targets', 'bear', 'base', 'bull',
    'wacc', 'terminal', 'fair', 'intrinsic', 'price', 'cheap', 'expensive',
    'upside', 'downside', 'buy', 'level', 'watching', 'comps', 'peer', 'pe',
  ],
  finding: [
    'found', 'finding', 'findings', 'research', 'interview', 'interviews',
    'source', 'sources', 'evidence', 'restock', 'shelf', 'sell', 'sells',
    'store', 'stores', 'staff', 'said', 'told', 'learn', 'learned', 'corroborat',
  ],
  visit: ['visit', 'visited', 'store', 'stores', 'saw', 'shelf', 'site', 'observ'],
};

/**
 * Score one chunk against the question.
 *
 * Exported for the tests, because the ranking is the whole product here
 * and a silent regression in it looks exactly like the model being bad.
 */
export function score(chunk, qTokens) {
  if (qTokens.length === 0) return 0;
  const body = new Set(tokens(chunk.text));
  let hits = 0;
  for (const t of qTokens) if (body.has(t)) hits += 1;

  // Overlap as a share of the question, not an absolute count, so a long
  // chunk does not win simply by containing more words.
  let s = hits / qTokens.length;

  // A question that is clearly about valuation should reach the
  // valuation chunk even when it shares few literal words with it.
  const hints = KIND_HINTS[chunk.kind] || [];
  const hinted = qTokens.filter((t) => hints.some((h) => t.startsWith(h))).length;
  if (hinted) s += 0.35 * Math.min(hinted, 3);

  // An exact number or ticker in the question is a strong signal — "what
  // does 89,463 refer to" should land on the DCF.
  for (const t of qTokens) {
    if (/^\d/.test(t) && body.has(t)) s += 0.5;
  }

  return s + (chunk.boost || 0);
}

/**
 * Choose chunks for this question within a character budget.
 *
 * Returns { text, included, omitted }. Omission is reported rather than
 * silent — a model handed a short list with no note reads it as the
 * whole truth, which is how the first version of this section produced
 * industry norms under a heading claiming they were our findings.
 */
export function retrieve(chunks, question, { budget = 5000, minScore = 0.15 } = {}) {
  const q = tokens(question);
  const ranked = chunks
    .map((c) => ({ chunk: c, s: score(c, q) }))
    .sort((a, b) => b.s - a.s);

  const included = [];
  const omitted = [];
  let used = 0;

  for (const { chunk, s } of ranked) {
    // `always` beats the budget and the threshold both: a project header
    // nobody matched on still has to be there, or the evidence under it
    // is floating free of the company it concerns.
    const wanted = chunk.always || s >= minScore;
    if (wanted && (chunk.always || used + chunk.text.length <= budget)) {
      included.push(chunk);
      used += chunk.text.length;
    } else {
      omitted.push(chunk);
    }
  }

  // Back into the order the reader expects rather than score order —
  // valuation above findings above notes — since a prompt that jumps
  // between kinds reads as a pile.
  const rank = { header: 0, valuation: 1, finding: 2, visit: 3, open: 4 };
  included.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));

  return { text: included.map((c) => c.text).join('\n'), included, omitted };
}
