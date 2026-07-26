import test from 'node:test';
import assert from 'node:assert/strict';

// The alerting RULES, pinned without a database.
//
// checkBuyLevels itself talks to Prisma, so these cover the decision it
// makes per row — which is where the behaviour anyone cares about lives:
// report a crossing once, re-arm on the way back up, and never let an
// unpriced name look like one that failed to cross.
const HYSTERESIS = 0.005;
const decide = (price, level, alerted) => {
  if (price == null) return 'unpriced';
  const below = price <= level * (1 - HYSTERESIS);
  const clearlyAbove = price > level * (1 + HYSTERESIS);
  if (below && !alerted) return 'alert';
  if (clearlyAbove && alerted) return 'rearm';
  return 'quiet';
};

test('crossing the level alerts once, not every morning', () => {
  assert.equal(decide(88, 90, false), 'alert');
  // Still below the next day, already announced — silence.
  assert.equal(decide(87, 90, true), 'quiet');
  assert.equal(decide(80, 90, true), 'quiet');
});

test('climbing clearly back above re-arms, so the next crossing is news', () => {
  assert.equal(decide(95, 90, true), 'rearm');
  // And then it can fire again.
  assert.equal(decide(88, 90, false), 'alert');
});

test('hovering on the line neither fires nor re-arms', () => {
  // Within the band either way: a quote wobbling across a round number
  // must not produce an alert a day, nor silently re-arm and produce a
  // second alert on the same move.
  assert.equal(decide(90, 90, false), 'quiet');
  assert.equal(decide(90.2, 90, true), 'quiet');
  assert.equal(decide(89.8, 90, true), 'quiet');
});

test('an unpriced name is not a name that failed to cross', () => {
  // The distinction the summary has to keep: a quote outage looks
  // exactly like a name sitting comfortably above its level.
  assert.equal(decide(null, 90, false), 'unpriced');
  assert.equal(decide(null, 90, true), 'unpriced');
});

test('the level is compared against price, not against the base case', () => {
  // buyBelow is deliberately its own number. The base case is what we
  // think it is worth; the buy level is what we would pay, and they are
  // not the same figure — nobody buys at their own fair value.
  const base = 89463;
  const buyBelow = 75000;
  assert.equal(decide(80000, buyBelow, false), 'quiet', 'below fair value is not a buy');
  assert.equal(decide(74000, buyBelow, false), 'alert');
  assert.ok(buyBelow < base);
});
