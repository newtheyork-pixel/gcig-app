import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRestatement, rangeForGap } from './priceHistory.js';

// The failure these tests pin down is a quiet one: NASDAQ back-adjusts
// the whole series after a split or dividend adjustment, and a top-up
// that appends the new bars onto the old ones manufactures a cliff at
// the splice date — a 10-for-1 split reads as a 90% crash on the chart.
// The overlap between what we fetched and what we stored is the tell.

const bar = (date, close) => ({ date, close });

test('agreeing overlap is not a restatement', () => {
  const stored = [bar(new Date('2026-07-01'), 100), bar(new Date('2026-07-02'), 101)];
  const fetched = [bar(new Date('2026-07-02'), 101), bar(new Date('2026-07-03'), 102)];
  assert.equal(detectRestatement(fetched, stored), null);
});

test('float noise inside the 0.5% band is tolerated', () => {
  // A vendor re-serving 298.21 as 298.2 is rounding, not a split.
  const stored = [bar(new Date('2026-07-02'), 298.21)];
  const fetched = [bar(new Date('2026-07-02'), 298.2)];
  assert.equal(detectRestatement(fetched, stored), null);
});

test('a split-adjusted overlap is flagged with the offending date', () => {
  // 10-for-1: the stored close describes a share that no longer exists.
  const stored = [
    bar(new Date('2026-07-01'), 1000),
    bar(new Date('2026-07-02'), 1010),
  ];
  const fetched = [
    bar(new Date('2026-07-01'), 100),
    bar(new Date('2026-07-02'), 101),
    bar(new Date('2026-07-03'), 102),
  ];
  const hit = detectRestatement(fetched, stored);
  assert.ok(hit, 'the restatement must be detected');
  assert.equal(hit.date, '2026-07-01');
  assert.equal(hit.stored, 1000);
  assert.equal(hit.fetched, 100);
});

test('a small dividend-style adjustment past the band is still flagged', () => {
  // ~1% back-adjustment — well past 0.5%, well short of a split.
  const stored = [bar(new Date('2026-07-02'), 100)];
  const fetched = [bar(new Date('2026-07-02'), 99)];
  assert.ok(detectRestatement(fetched, stored));
});

test('no overlap means nothing to compare — never a false positive', () => {
  const stored = [bar(new Date('2026-06-01'), 90)];
  const fetched = [bar(new Date('2026-07-01'), 100)];
  assert.equal(detectRestatement(fetched, stored), null);
});

test('null closes and empty inputs are ignored, not compared', () => {
  assert.equal(detectRestatement([], []), null);
  assert.equal(detectRestatement(null, undefined), null);
  const stored = [bar(new Date('2026-07-02'), null)];
  const fetched = [bar(new Date('2026-07-02'), 100)];
  assert.equal(detectRestatement(fetched, stored), null);
});

test('rangeForGap widens with the hole and falls back to a full backfill', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000);
  assert.equal(rangeForGap(daysAgo(1)), '1mo');
  assert.equal(rangeForGap(daysAgo(40)), '3mo');
  assert.equal(rangeForGap(daysAgo(120)), '6mo');
  assert.equal(rangeForGap(daysAgo(300)), '1y');
  assert.equal(rangeForGap(daysAgo(700)), '2y');
  assert.equal(rangeForGap(daysAgo(1500)), '5y');
  assert.equal(rangeForGap(daysAgo(3000)), '10y');
  // A gap no range covers means the top-up IS a backfill.
  assert.equal(rangeForGap(daysAgo(4000)), 'max');
});
