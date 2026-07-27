import test from 'node:test';
import assert from 'node:assert/strict';

// Resolution priority, pinned as pure logic.
//
// MOVR ranked one holding of twelve and reported the other eleven as
// impossible to price, while /terminal/quotes returned a previous close
// for every one of them. The cause was here: Google supplies a last
// price for most names and no previous close, and the resolver treated
// "has a price" as resolved — so it never asked Finnhub, which does
// carry one.
const decide = (g, fh) => {
  const usable = g && g.price != null && (g.prevClose != null || g.changePct != null);
  if (usable) return 'google';
  if (fh && fh.last != null) return 'finnhub';
  if (g && g.price != null) return 'google-price-only';
  return 'unpriced';
};

test('a Google row with no previous close falls through to Finnhub', () => {
  // The exact bug: a price, nothing to compute a day move from.
  assert.equal(decide({ price: 347.06 }, { last: 346.69, prevClose: 347.06 }), 'finnhub');
});

test('a complete Google row is used and Finnhub is not called', () => {
  assert.equal(decide({ price: 33.49, prevClose: 33.29 }, { last: 33.5 }), 'google');
  // changePct alone is enough — the shape can derive from either.
  assert.equal(decide({ price: 33.49, changePct: 0.6 }, null), 'google');
});

test('a price with no day move still keeps the position in the book', () => {
  // A $5,529 holding that nothing can price for the day is still a
  // holding. It keeps its price and its day move stays null rather than
  // being invented.
  assert.equal(decide({ price: 347.06 }, null), 'google-price-only');
  assert.equal(decide({ price: 347.06 }, { last: null }), 'google-price-only');
});

test('nothing anywhere is unpriced, not zero', () => {
  assert.equal(decide(null, null), 'unpriced');
  assert.equal(decide({ price: null }, { last: null }), 'unpriced');
});
