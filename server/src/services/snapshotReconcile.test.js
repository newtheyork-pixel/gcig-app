import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSnapshotCorrections,
  makeCloseLookup,
  toIso,
} from './snapshotReconcile.js';

// A tiny two-name rebalance: buy 10 X, sell 5 Y, and $100 net cash freed.
const legs = [
  { side: 'Buy', ticker: 'X', shares: 10 },
  { side: 'Sell', ticker: 'Y', shares: 5 },
];

// Ascending daily bars, exactly what makeCloseLookup expects.
const bars = {
  X: [
    { date: '2026-06-23', close: 50 },
    { date: '2026-06-24', close: 60 },
  ],
  Y: [
    { date: '2026-06-23', close: 20 },
    { date: '2026-06-24', close: 30 },
  ],
};

test('per-day delta is valued at that day’s close, not a flat offset', () => {
  const closeFor = makeCloseLookup(bars);
  const snapshots = [
    { date: new Date('2026-06-23T00:00:00Z'), totalValue: 1000, cashValue: 200 },
    { date: new Date('2026-06-24T00:00:00Z'), totalValue: 1100, cashValue: 200 },
  ];
  const rows = computeSnapshotCorrections({ snapshots, legs, netCashDelta: 100, closeFor });

  // Day 1: bought 10·50=500, sold 5·20=100 → delta 500-100+100 = 500.
  assert.equal(rows[0].delta, 500);
  assert.equal(rows[0].after.totalValue, 1500);
  assert.equal(rows[0].after.cashValue, 300);

  // Day 2: bought 10·60=600, sold 5·30=150 → delta 600-150+100 = 550. The two
  // baskets have drifted apart, so the correction is NOT the same as day 1.
  assert.equal(rows[1].delta, 550);
  assert.equal(rows[1].after.totalValue, 1650);
  assert.equal(rows[1].after.cashValue, 300);
});

test('a weekend snapshot resolves to the prior trading day’s close', () => {
  const closeFor = makeCloseLookup(bars);
  // 2026-06-27 is a Saturday; no bar exists, so it must use 06-24’s closes.
  const snapshots = [{ date: new Date('2026-06-27T00:00:00Z'), totalValue: 1200, cashValue: 200 }];
  const rows = computeSnapshotCorrections({ snapshots, legs, netCashDelta: 100, closeFor });
  assert.equal(rows[0].delta, 550); // same as 06-24: 600-150+100
  assert.equal(rows[0].missing.length, 0);
});

test('a day with no price for a traded ticker is flagged, not zeroed', () => {
  // Y has no bar on or before 2026-06-22, so that leg can’t be valued.
  const closeFor = makeCloseLookup({
    X: [{ date: '2026-06-20', close: 40 }],
    Y: [{ date: '2026-06-23', close: 20 }],
  });
  const snapshots = [{ date: new Date('2026-06-22T00:00:00Z'), totalValue: 1000, cashValue: null }];
  const rows = computeSnapshotCorrections({ snapshots, legs, netCashDelta: 100, closeFor });
  assert.deepEqual(rows[0].missing, ['Y']);
  // Cash stays null when the snapshot never carried a cash figure.
  assert.equal(rows[0].after.cashValue, null);
});

test('execution-day delta is roughly minus the fees (value-neutral swap)', () => {
  // Value the legs at their fill prices and pass the true net cash. The book
  // should come out essentially flat — only the broker’s fee leaves.
  const closeFor = makeCloseLookup({
    X: [{ date: '2026-06-23', close: 100 }], // buy 10 → $1,000 out
    Y: [{ date: '2026-06-23', close: 200 }], // sell 5 → $1,000 in
  });
  const snapshots = [{ date: new Date('2026-06-23T00:00:00Z'), totalValue: 50000, cashValue: 5000 }];
  // Net cash the broker actually moved: +$1,000 in − $1,000 out − $8 fees.
  const rows = computeSnapshotCorrections({ snapshots, legs, netCashDelta: -8, closeFor });
  // delta = bought 1000 − sold 1000 + (−8) = −8.
  assert.equal(rows[0].delta, -8);
  assert.equal(rows[0].after.totalValue, 49992);
});

test('toIso normalizes Date and string alike', () => {
  assert.equal(toIso(new Date('2026-06-23T14:00:00Z')), '2026-06-23');
  assert.equal(toIso('2026-06-23'), '2026-06-23');
});
