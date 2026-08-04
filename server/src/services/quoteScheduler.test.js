import test from 'node:test';
import assert from 'node:assert/strict';
import { track, gapMs, tick, read, status, _reset } from './quoteScheduler.js';

const px = (t) => ({ price: 100, change: 1, changePercent: 1, currency: 'USD', name: t });

test('the pace scales with the list, so a long one is not a burst', () => {
  // 162 names is the case that broke: fired at once they rate-limited
  // Yahoo, fell through to the crumb endpoint, and returned 429 for
  // every row. Spread over fifteen minutes it is one call every ~5s.
  _reset();
  track(Array.from({ length: 162 }, (_, i) => `T${i}`));
  const g = gapMs();
  assert.ok(g >= 1200 && g <= 20000);
  assert.ok(Math.abs(g - (15 * 60 * 1000) / 162) < 100, `expected ~5.5s, got ${g}ms`);
  // A tiny list must not hammer: the floor is a ceiling here.
  _reset();
  track(['AAPL']);
  assert.equal(gapMs(), 20000);
});

test('one tick fetches exactly one ticker, round robin', async () => {
  _reset();
  track(['A', 'B', 'C']);
  const seen = [];
  const fetchOne = async (t) => { seen.push(t); return px(t); };
  await tick({ fetchOne });
  await tick({ fetchOne });
  assert.deepEqual(seen, ['A', 'B'], 'one per tick, in order');
  await tick({ fetchOne });
  await tick({ fetchOne });
  assert.deepEqual(seen, ['A', 'B', 'C', 'A'], 'wraps around');
});

test('reading never fetches, and says how old each price is', async () => {
  _reset();
  track(['A', 'B']);
  await tick({ fetchOne: async (t) => px(t) });
  const [a, b] = read(['A', 'B']);
  assert.equal(a.price, 100);
  assert.ok(a.asOf);
  assert.equal(a.stale, false);
  // Never fetched yet is PENDING, not a null price pretending to be an
  // answer — the row can say "waiting" instead of rendering a dash that
  // looks like a dead symbol.
  assert.equal(b.pending, true);
  assert.equal(b.price, null);
});

test('a failing ticker does not poison the rest', async () => {
  _reset();
  track(['GOOD', 'BAD']);
  const fetchOne = async (t) => {
    if (t === 'BAD') throw new Error('yahoo 429');
    return px(t);
  };
  await tick({ fetchOne });
  await tick({ fetchOne });
  assert.equal(read(['GOOD'])[0].price, 100);
  assert.equal(read(['BAD'])[0].pending, true);
});

test('editing the list keeps what is known and puts new names first', async () => {
  // A watchlist edit must not blank every other row, and somebody who
  // just added a name is looking at it now.
  _reset();
  track(['A', 'B']);
  await tick({ fetchOne: async (t) => px(t) });
  assert.equal(read(['A'])[0].price, 100);

  const r = track(['A', 'B', 'ZZ']);
  assert.equal(r.added, 1);
  assert.equal(read(['A'])[0].price, 100, 'existing prices survive');

  const seen = [];
  await tick({ fetchOne: async (t) => { seen.push(t); return px(t); } });
  assert.equal(seen[0], 'ZZ', 'the new name is refreshed first');
});

test('dropping a ticker forgets it rather than serving it forever', async () => {
  _reset();
  track(['A', 'B']);
  await tick({ fetchOne: async (t) => px(t) });
  track(['B']);
  assert.equal(read(['A'])[0].pending, true);
  assert.equal(status().tracked, 1);
});
