import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relieveLotsFifo } from './tradeExecution.js';

// Lots are oldest-first, the order applySell reads them in.
const lots = (...rows) => rows.map(([id, shares, pricePerShare]) => ({ id, shares, pricePerShare }));

test('single lot, exact sell — booked as a gain, lot deleted', () => {
  const r = relieveLotsFifo(lots([1, 10, 100]), 10, 120);
  assert.equal(r.remaining, 0);
  assert.equal(r.realizedPnl, 200); // (120-100)*10
  assert.deepEqual(r.deletes, [1]);
  assert.deepEqual(r.updates, []);
});

test('partial sell of one lot — lot shrinks, no delete', () => {
  const r = relieveLotsFifo(lots([1, 10, 100]), 4, 90);
  assert.equal(r.remaining, 0);
  assert.equal(r.realizedPnl, -40); // (90-100)*4, a loss
  assert.deepEqual(r.deletes, []);
  assert.deepEqual(r.updates, [{ id: 1, shares: 6 }]);
});

test('FIFO across lots — oldest consumed first, P/L per lot', () => {
  // Sell 12 @ $50. Oldest lot 5 @ $30 fully, then 7 of the 10 @ $40 lot.
  const r = relieveLotsFifo(lots([1, 5, 30], [2, 10, 40]), 12, 50);
  assert.equal(r.remaining, 0);
  assert.equal(r.realizedPnl, (50 - 30) * 5 + (50 - 40) * 7); // 100 + 70 = 170
  assert.deepEqual(r.deletes, [1]); // first lot exhausted
  assert.deepEqual(r.updates, [{ id: 2, shares: 3 }]); // second lot has 3 left
});

test('sell consuming several whole lots deletes them all', () => {
  const r = relieveLotsFifo(lots([1, 5, 30], [2, 5, 40]), 10, 45);
  assert.equal(r.remaining, 0);
  assert.equal(r.realizedPnl, (45 - 30) * 5 + (45 - 40) * 5); // 75 + 25 = 100
  assert.deepEqual(r.deletes, [1, 2]);
  assert.deepEqual(r.updates, []);
});

test('lots short of the sale — surfaces leftover remaining (caller rejects)', () => {
  const r = relieveLotsFifo(lots([1, 5, 30]), 8, 50);
  assert.equal(r.remaining, 3); // 8 requested, only 5 in lots
  assert.deepEqual(r.deletes, [1]);
});

test('floating-point lot quantities net to a clean close', () => {
  const r = relieveLotsFifo(lots([1, 0.1, 10], [2, 0.2, 20]), 0.3, 25);
  assert.ok(Math.abs(r.remaining) < 1e-9);
  assert.deepEqual(r.deletes, [1, 2]);
});
