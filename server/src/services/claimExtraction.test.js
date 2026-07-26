import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, locateQuote } from './claimExtraction.js';

// locateQuote is the integrity gate of the whole evidence chain. If it
// matches loosely, a paraphrased or invented quote gets stored with a
// real-looking timestamp and a reader following the citation hears
// something else. If it matches too strictly, honest claims are thrown
// away. These tests pin both edges.

// "we cut the rebate by two hundred basis points in Q2" across two
// speakers, one word per 500ms.
const WORDS = [
  { text: 'So', startMs: 0, endMs: 400, speaker: 'speaker_0' },
  { text: 'what', startMs: 500, endMs: 900, speaker: 'speaker_0' },
  { text: 'changed?', startMs: 1000, endMs: 1400, speaker: 'speaker_0' },
  { text: 'We', startMs: 2000, endMs: 2400, speaker: 'speaker_1' },
  { text: 'cut', startMs: 2500, endMs: 2900, speaker: 'speaker_1' },
  { text: 'the', startMs: 3000, endMs: 3400, speaker: 'speaker_1' },
  { text: 'rebate', startMs: 3500, endMs: 3900, speaker: 'speaker_1' },
  { text: 'by', startMs: 4000, endMs: 4400, speaker: 'speaker_1' },
  { text: '200', startMs: 4500, endMs: 4900, speaker: 'speaker_1' },
  { text: 'basis', startMs: 5000, endMs: 5400, speaker: 'speaker_1' },
  { text: 'points', startMs: 5500, endMs: 5900, speaker: 'speaker_1' },
  { text: 'in', startMs: 6000, endMs: 6400, speaker: 'speaker_1' },
  { text: 'Q2.', startMs: 6500, endMs: 6900, speaker: 'speaker_1' },
];

test('locates a verbatim quote and returns its true span', () => {
  const hit = locateQuote(WORDS, 'cut the rebate by 200 basis points');
  assert.equal(hit.startMs, 2500);
  assert.equal(hit.endMs, 5900);
  assert.equal(hit.speaker, 'speaker_1');
});

test('tolerates casing, smart quotes and punctuation drift', () => {
  // The model reliably normalizes these even when told not to, and none
  // of them change what was said.
  assert.ok(locateQuote(WORDS, 'CUT THE REBATE'));
  assert.ok(locateQuote(WORDS, 'in Q2'));
  assert.ok(locateQuote(WORDS, 'points in Q2.'));
});

test('rejects a paraphrase', () => {
  // The substance is right but the words were never said. This is
  // exactly the failure the pinned-source rule exists to catch.
  assert.equal(locateQuote(WORDS, 'we reduced the rebate by 200bp'), null);
});

test('rejects an invented quote outright', () => {
  assert.equal(locateQuote(WORDS, 'margins collapsed in the fourth quarter'), null);
});

test('rejects a reordered quote', () => {
  assert.equal(locateQuote(WORDS, 'rebate the cut'), null);
});

test('rejects a spliced quote that skips words', () => {
  // "cut the rebate ... in Q2" is not a contiguous span; joining them
  // would misrepresent a sentence.
  assert.equal(locateQuote(WORDS, 'cut the rebate in Q2'), null);
});

test('rejects a quote that spans two speakers', () => {
  // Half of this is the interviewer's question and half the source's
  // answer. It reads as a contiguous span in the file but it is not a
  // statement by one person, so it must not become a citable claim at
  // all. (An earlier version returned it with a null speaker; refusing
  // outright is the stricter and more honest answer.)
  assert.equal(locateQuote(WORDS, 'changed? We cut'), null);
});

test('steps over a short interviewer backchannel mid-sentence', () => {
  // The single most common shape in a real interview: the source is
  // talking, the interviewer says "Yeah", the source continues. That is
  // one statement and must remain quotable.
  const words = [
    { text: 'it', startMs: 0, endMs: 100, speaker: 'speaker_1' },
    { text: 'is', startMs: 100, endMs: 200, speaker: 'speaker_1' },
    { text: 'easier', startMs: 200, endMs: 300, speaker: 'speaker_1' },
    { text: 'Yeah', startMs: 300, endMs: 400, speaker: 'speaker_0' },
    { text: 'close', startMs: 400, endMs: 500, speaker: 'speaker_1' },
    { text: 'to', startMs: 500, endMs: 600, speaker: 'speaker_1' },
    { text: 'consumption', startMs: 600, endMs: 700, speaker: 'speaker_1' },
  ];
  const hit = locateQuote(words, 'it is easier close to consumption');
  assert.ok(hit, 'the interjection must not break the quote');
  assert.equal(hit.speaker, 'speaker_1');
  assert.equal(hit.startMs, 0);
  assert.equal(hit.endMs, 700);
});

test('still refuses to skip the speaker\'s OWN words', () => {
  // Stepping over the other voice is tolerance for conversation.
  // Stepping over this speaker's own words would stitch two separate
  // statements into one sentence they never said — the exact
  // fabrication this gate exists to prevent.
  const words = [
    { text: 'we', startMs: 0, endMs: 100, speaker: 'speaker_1' },
    { text: 'cut', startMs: 100, endMs: 200, speaker: 'speaker_1' },
    { text: 'rebates', startMs: 200, endMs: 300, speaker: 'speaker_1' },
    { text: 'and', startMs: 300, endMs: 400, speaker: 'speaker_1' },
    { text: 'raised', startMs: 400, endMs: 500, speaker: 'speaker_1' },
    { text: 'prices', startMs: 500, endMs: 600, speaker: 'speaker_1' },
  ];
  assert.equal(locateQuote(words, 'we cut prices'), null);
});

test('a long interjection is not stepped over', () => {
  // A brief "Yeah" is backchannel. Ten words from the other party is a
  // different exchange, and joining across it would misrepresent both.
  const words = [
    { text: 'it', startMs: 0, endMs: 100, speaker: 'speaker_1' },
    ...Array.from({ length: 12 }, (_, i) => ({
      text: `w${i}`, startMs: 100 + i * 10, endMs: 110 + i * 10, speaker: 'speaker_0',
    })),
    { text: 'happened', startMs: 400, endMs: 500, speaker: 'speaker_1' },
  ];
  assert.equal(locateQuote(words, 'it happened'), null);
});

test('empty or junk quotes locate nothing', () => {
  for (const q of ['', '   ', null, undefined, '...']) {
    assert.equal(locateQuote(WORDS, q), null);
  }
});

const INTERVIEW = {
  words: WORDS,
  turns: [
    { speaker: 'speaker_0', startMs: 0, endMs: 1400, text: 'So what changed?' },
    { speaker: 'speaker_1', startMs: 2000, endMs: 6900, text: 'We cut the rebate by 200 basis points in Q2.' },
  ],
};

test('keeps a locatable claim and pins it to the transcript', async () => {
  const llmChat = async () =>
    JSON.stringify({
      claims: [{
        text: 'The rebate was cut by 200 basis points in Q2.',
        quote: 'cut the rebate by 200 basis points',
        topic: 'Rebate Structure',
        kind: 'fact',
        confidence: 0.92,
      }],
    });
  const { claims, dropped } = await extractClaims(INTERVIEW, { llmChat });
  assert.equal(dropped, 0);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].startMs, 2500);
  assert.equal(claims[0].speaker, 'speaker_1');
  assert.equal(claims[0].topic, 'rebate structure', 'topics normalize for grouping');
  assert.equal(claims[0].extractionConfidence, 0.92);
});

test('drops a claim whose quote is not in the transcript', async () => {
  // A hallucinated claim must never reach the ledger, however plausible.
  const llmChat = async () =>
    JSON.stringify({
      claims: [
        { text: 'Real', quote: 'cut the rebate', kind: 'fact', confidence: 0.9 },
        { text: 'Invented', quote: 'we lost the Walmart account', kind: 'fact', confidence: 0.99 },
      ],
    });
  const { claims, dropped } = await extractClaims(INTERVIEW, { llmChat });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].text, 'Real');
  assert.equal(dropped, 1, 'the drop is counted so a spike is visible');
});

test('an unknown kind falls back to fact rather than being invented', async () => {
  const llmChat = async () =>
    JSON.stringify({ claims: [{ text: 'T', quote: 'in Q2', kind: 'speculation', confidence: 1 }] });
  const { claims } = await extractClaims(INTERVIEW, { llmChat });
  assert.equal(claims[0].kind, 'fact');
});

test('confidence is clamped into range', async () => {
  const llmChat = async () =>
    JSON.stringify({
      claims: [
        { text: 'A', quote: 'in Q2', kind: 'fact', confidence: 4.5 },
        { text: 'B', quote: 'cut the rebate', kind: 'fact', confidence: -2 },
      ],
    });
  const { claims } = await extractClaims(INTERVIEW, { llmChat });
  const byText = Object.fromEntries(claims.map((c) => [c.text, c.extractionConfidence]));
  assert.equal(byText.A, 1);
  assert.equal(byText.B, 0);
});

test('claims come back in chronological order', async () => {
  const llmChat = async () =>
    JSON.stringify({
      claims: [
        { text: 'later', quote: 'in Q2', kind: 'fact', confidence: 1 },
        { text: 'earlier', quote: 'We cut', kind: 'fact', confidence: 1 },
      ],
    });
  const { claims } = await extractClaims(INTERVIEW, { llmChat });
  assert.deepEqual(claims.map((c) => c.text), ['earlier', 'later']);
});

test('a down model yields no claims and says so, rather than throwing', async () => {
  for (const bad of [async () => null, async () => 'not json', async () => '{"claims":"nope"}']) {
    const out = await extractClaims(INTERVIEW, { llmChat: bad });
    assert.equal(out.claims.length, 0);
  }
});

test('an empty transcript is not sent to the model at all', async () => {
  let called = false;
  const llmChat = async () => { called = true; return '{"claims":[]}'; };
  const out = await extractClaims({ words: [], turns: [] }, { llmChat });
  assert.equal(called, false);
  assert.equal(out.unavailable, true);
});

// Long interviews were silently losing their substance: a hard 40k-char
// head-truncation fed the model a 39-minute expert call's opening small
// talk and discarded the economics, so the richest transcript in the
// corpus produced zero claims while three-minute store chats produced
// plenty. These pin the windowing that replaced it.
import { chunkTurns } from './claimExtraction.js';

const bigTurns = (n, len) =>
  Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 ? 'speaker_1' : 'speaker_0',
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `t${i} ` + 'x'.repeat(len),
  }));

test('a short interview stays a single window', () => {
  assert.equal(chunkTurns(bigTurns(5, 50)).length, 1);
});

test('a long interview is split rather than truncated', () => {
  // ~60k chars of turns against a 30k budget.
  const chunks = chunkTurns(bigTurns(120, 500));
  assert.ok(chunks.length >= 2, `expected multiple windows, got ${chunks.length}`);
});

test('every turn survives somewhere — nothing is dropped off the end', () => {
  const turns = bigTurns(120, 500);
  const chunks = chunkTurns(turns);
  const seen = new Set(chunks.flat().map((t) => t.text));
  // The old behaviour kept only the head; the failure it caused was
  // invisible precisely because nothing errored.
  assert.equal(seen.size, turns.length);
  assert.ok(seen.has(turns[turns.length - 1].text), 'the final turn must be covered');
});

test('windows overlap so a claim on the seam is wholly inside one of them', () => {
  const chunks = chunkTurns(bigTurns(120, 500));
  const firstEnd = chunks[0][chunks[0].length - 1].text;
  assert.ok(chunks[1].some((t) => t.text === firstEnd), 'tail of window 1 repeats in window 2');
});

test('a single oversized turn still yields a window rather than an empty set', () => {
  const chunks = chunkTurns([{ speaker: 'speaker_0', startMs: 0, endMs: 1, text: 'y'.repeat(90_000) }]);
  assert.equal(chunks.length, 1);
});

test('overlap does not duplicate claims in the output', async () => {
  // Both windows report the same statement; the ledger must show it once.
  const words = [
    { text: 'we', startMs: 0, endMs: 100, speaker: 'speaker_1' },
    { text: 'cut', startMs: 100, endMs: 200, speaker: 'speaker_1' },
    { text: 'rebates', startMs: 200, endMs: 300, speaker: 'speaker_1' },
  ];
  const turns = [{ speaker: 'speaker_1', startMs: 0, endMs: 300, text: 'we cut rebates' }];
  const llmChat = async () =>
    JSON.stringify({ claims: [{ text: 'Rebates were cut', quote: 'we cut rebates', kind: 'fact', confidence: 1 }] });
  const { claims } = await extractClaims({ words, turns }, { llmChat });
  assert.equal(claims.length, 1);
});

// The model fails silently on long inputs: it returns a bare `{}`
// instead of the requested shape. Treating that as "no claims in this
// window" is how a model failure gets reported as a research finding.
test('a reply with no claims array counts as a failed window, not an empty one', async () => {
  const words = [{ text: 'we', startMs: 0, endMs: 100, speaker: 'speaker_1' }];
  const turns = [{ speaker: 'speaker_1', startMs: 0, endMs: 100, text: 'we' }];
  const out = await extractClaims({ words, turns }, { llmChat: async () => '{}' });
  assert.equal(out.claims.length, 0);
  assert.equal(out.unavailable, true, 'no window answered, so the run is unavailable');
});

test('a genuinely empty window is not counted as a failure', async () => {
  const words = [{ text: 'we', startMs: 0, endMs: 100, speaker: 'speaker_1' }];
  const turns = [{ speaker: 'speaker_1', startMs: 0, endMs: 100, text: 'we' }];
  const out = await extractClaims({ words, turns }, { llmChat: async () => '{"claims":[]}' });
  assert.equal(out.failedWindows, 0, 'an explicit empty array is a real answer');
  assert.ok(!out.unavailable);
});

test('a partial read reports how much of the transcript actually answered', async () => {
  // Long enough to need several windows; every other one bails.
  const turns = Array.from({ length: 60 }, (_, i) => ({
    speaker: 'speaker_1', startMs: i * 1000, endMs: i * 1000 + 900,
    text: `we cut rebates ${i} ` + 'z'.repeat(400),
  }));
  const words = turns.flatMap((t) =>
    t.text.split(' ').map((w) => ({ text: w, startMs: t.startMs, endMs: t.endMs, speaker: t.speaker }))
  );
  let n = 0;
  const llmChat = async () => (n++ % 2 ? '{}' : '{"claims":[{"text":"x","quote":"we cut rebates 0","kind":"fact","confidence":1}]}');
  const out = await extractClaims({ words, turns }, { llmChat });
  assert.ok(out.windows > 1, 'this transcript needs several windows');
  assert.ok(out.failedWindows > 0, 'the bailing windows are counted');
  assert.ok(out.failedWindows < out.windows, 'and some did answer');
});
