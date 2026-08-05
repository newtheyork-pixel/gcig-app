import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimate, spreadMultipleAt, ledger, TIMING_EDGE_PCT, POSTING_EDGE_PCT,
} from './executionSaving.js';

const at = (h, m) => new Date(`2026-08-06T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-04:00`);

test('the saving scales linearly, which is the whole point', () => {
  // The rules cost the same effort at any size, so a reader needs to see
  // that they are worth ten times as much on ten times the order.
  const a = estimate({ notional: 10_000, now: at(13, 0) });
  const b = estimate({ notional: 100_000, now: at(13, 0) });
  assert.ok(Math.abs(b.total - a.total * 10) < 0.01);
  assert.ok(Math.abs(a.total - 5.39) < 0.02, `expected ~$5.39, got ${a.total}`);
  assert.ok(Math.abs(b.total - 53.9) < 0.2, `expected ~$53.90, got ${b.total}`);
});

test('the flattering number never travels without the honest one', () => {
  // Against a market order at the bell the timing rule is worth $19.70
  // per $100k. Against trading at some sensible hour anyway it is $0.90.
  // Quoting only the first would be a lie of omission.
  const e = estimate({ notional: 100_000, now: at(13, 0) });
  assert.ok(Math.abs(e.timing - 19.7) < 0.1);
  assert.ok(Math.abs(e.timingVsRandom - 0.9) < 0.1);
  assert.ok(e.timingVsRandom < e.timing / 10, 'the realistic figure is far smaller');
});

test('posting is worth more than timing, and the panel must not invert them', () => {
  assert.ok(POSTING_EDGE_PCT > TIMING_EDGE_PCT * 1.5);
  const e = estimate({ notional: 50_000, now: at(13, 0) });
  assert.ok(e.posting > e.timing);
});

test('the spread curve knows the open is expensive', () => {
  assert.ok(spreadMultipleAt(0) > 2.5, 'the bell is 2.6x midday');
  assert.ok(spreadMultipleAt(270) < 1.1, 'mid afternoon is the calm');
  assert.ok(spreadMultipleAt(0) / spreadMultipleAt(270) > 2.5);
  // Outside the session there is no answer, and null is the answer.
  assert.equal(spreadMultipleAt(-10), null);
  assert.equal(spreadMultipleAt(500), null);
});

test('the session phase names what to do', () => {
  assert.equal(estimate({ notional: 1000, now: at(9, 35) }).session.phase, 'opening');
  assert.equal(estimate({ notional: 1000, now: at(13, 0) }).session.phase, 'calm');
  assert.equal(estimate({ notional: 1000, now: at(15, 58) }).session.phase, 'closing');
  assert.equal(estimate({ notional: 1000, now: at(8, 0) }).session.phase, 'premarket');
  assert.equal(estimate({ notional: 1000, now: at(17, 0) }).session.phase, 'closed');
  // Saturday.
  assert.equal(estimate({ notional: 1000, now: new Date('2026-08-08T17:00:00Z') }).session.phase, 'weekend');
});

test('it says how long until the cheap window', () => {
  const e = estimate({ notional: 1000, now: at(10, 0) });
  assert.equal(e.session.minutesUntilCalm, 90, '10:00 is 90 minutes from 11:30');
  assert.equal(estimate({ notional: 1000, now: at(13, 0) }).session.minutesUntilCalm, 0);
});

test('a nonsense size is nothing, not zero', () => {
  // Zero would render as "this trade saves $0.00", which reads as a
  // finding rather than as a missing input.
  assert.equal(estimate({ notional: 0 }), null);
  assert.equal(estimate({ notional: -5 }), null);
  assert.equal(estimate({ notional: 'abc' }), null);
  assert.equal(estimate({}), null);
});

test('the ledger counts only trades actually taken', () => {
  // A saving nobody executed is a model output. The record has to be
  // trades that happened or the total is fiction.
  const l = ledger([
    { notional: 10_000, estimatedSaving: 5.39, executedAt: '2026-08-04' },
    { notional: 20_000, estimatedSaving: 10.78, executedAt: '2026-08-05' },
    { notional: 50_000, estimatedSaving: 26.95, executedAt: null },
  ]);
  assert.equal(l.trades, 2);
  assert.equal(l.pending, 1);
  assert.equal(l.notional, 30_000);
  assert.ok(Math.abs(l.saved - 16.17) < 0.01);
});
