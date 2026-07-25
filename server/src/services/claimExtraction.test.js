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

test('refuses to attribute a quote that crosses a speaker change', () => {
  // The span is genuinely present, but half of it is the interviewer.
  // Attributing it to either voice would be an invention, so speaker is
  // null and the caller can see the quote is unattributable.
  const hit = locateQuote(WORDS, 'changed? We cut');
  assert.ok(hit, 'the span does exist');
  assert.equal(hit.speaker, null);
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
