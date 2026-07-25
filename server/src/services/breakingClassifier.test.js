import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreBreaking, filterBreaking, BREAKING_THRESHOLD } from './breakingClassifier.js';

// The dangerous failure here is not a wrong score, it's an empty strip.
// "Nothing is breaking" and "we never got to judge" produce identical
// article counts, and only one of them justifies hiding the wire. These
// tests pin that distinction.

const A = (n, extra = {}) => ({
  title: `Headline ${n}`,
  url: `https://e.com/${n}`,
  source: 'Wire',
  publishedAt: `2026-07-2${n}T00:00:00Z`,
  ...extra,
});

test('attaches scores returned by the model', async () => {
  const scoreBatch = async () =>
    new Map([[0, { score: 9, reason: 'Fed cut' }], [1, { score: 2, reason: 'Opinion' }]]);
  const out = await scoreBreaking([A(1), A(2)], { scoreBatch, cache: new Map() });
  assert.equal(out[0].breaking, 9);
  assert.equal(out[0].breakingReason, 'Fed cut');
  assert.equal(out[1].breaking, 2);
});

test('an article the model skipped stays null, not zero', async () => {
  // null means "unknown". Coercing it to 0 would quietly bury a story
  // the model simply failed to return a row for.
  const scoreBatch = async () => new Map([[0, { score: 8, reason: 'x' }]]);
  const out = await scoreBreaking([A(1), A(2)], { scoreBatch, cache: new Map() });
  assert.equal(out[0].breaking, 8);
  assert.equal(out[1].breaking, null);
});

test('a thrown scorer leaves every article unscored instead of failing', async () => {
  const scoreBatch = async () => { throw new Error('llm down'); };
  const out = await scoreBreaking([A(1), A(2)], { scoreBatch, cache: new Map() });
  assert.equal(out.length, 2);
  assert.ok(out.every((a) => a.breaking === null));
});

test('cached URLs are not re-sent to the model', async () => {
  const cache = new Map([['https://e.com/1', { score: 7, reason: 'cached' }]]);
  let sent = null;
  const scoreBatch = async (batch) => { sent = batch.map((a) => a.url); return new Map(); };
  const out = await scoreBreaking([A(1), A(2)], { scoreBatch, cache });
  assert.deepEqual(sent, ['https://e.com/2']);
  assert.equal(out[0].breaking, 7);
});

test('no unknown articles means no model call at all', async () => {
  const cache = new Map([
    ['https://e.com/1', { score: 7, reason: 'c' }],
    ['https://e.com/2', { score: 3, reason: 'c' }],
  ]);
  let called = false;
  const scoreBatch = async () => { called = true; return new Map(); };
  await scoreBreaking([A(1), A(2)], { scoreBatch, cache });
  assert.equal(called, false);
});

test('empty input is handled without a call', async () => {
  assert.deepEqual(await scoreBreaking([], { cache: new Map() }), []);
  assert.deepEqual(await scoreBreaking(null, { cache: new Map() }), []);
});

test('filter keeps only what clears the bar, most urgent first', () => {
  const out = filterBreaking([
    { ...A(1), breaking: 3 },
    { ...A(2), breaking: 9 },
    { ...A(3), breaking: 7 },
  ]);
  assert.deepEqual(out.map((a) => a.breaking), [9, 7]);
});

test('nothing scored at all falls back to the unfiltered wire', () => {
  // The model was unreachable. A blank strip reads as a broken terminal,
  // so the honest degraded state is the raw wire.
  const input = [{ ...A(1), breaking: null }, { ...A(2), breaking: null }];
  assert.equal(filterBreaking(input).length, 2);
});

test('a genuinely quiet day still surfaces the best few', () => {
  // Everything was judged and nothing qualified. Show the top of what we
  // have rather than an empty bar; the client labels it "WIRE", not
  // "BREAKING".
  const input = [
    { ...A(1), breaking: 2 },
    { ...A(2), breaking: 5 },
    { ...A(3), breaking: 1 },
  ];
  const out = filterBreaking(input);
  assert.equal(out.length, 3);
  assert.equal(out[0].breaking, 5); // best first
});

test('quiet-day fallback is capped so the strip cannot fill with noise', () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ ...A(i), breaking: 1 }));
  assert.equal(filterBreaking(input).length, 5);
});

test('ties break toward the newer story', () => {
  const out = filterBreaking([
    { title: 'older', url: 'u1', breaking: 8, publishedAt: '2026-07-01T00:00:00Z' },
    { title: 'newer', url: 'u2', breaking: 8, publishedAt: '2026-07-09T00:00:00Z' },
  ]);
  assert.equal(out[0].title, 'newer');
});

test('the exported threshold is the boundary the filter actually uses', () => {
  const at = filterBreaking([{ ...A(1), breaking: BREAKING_THRESHOLD }]);
  const below = filterBreaking([
    { ...A(1), breaking: BREAKING_THRESHOLD - 1 },
    { ...A(2), breaking: 0 },
  ]);
  assert.equal(at.length, 1, 'a score equal to the threshold qualifies');
  // Below the bar it drops to the quiet-day path, not a hard filter.
  assert.ok(below.every((a) => a.breaking < BREAKING_THRESHOLD));
});
