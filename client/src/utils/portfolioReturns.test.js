import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustedReturn } from './portfolioReturns.js';

test('fully invested is the equity sleeve, never book plus cash-weight times equity', () => {
  // The numbers on the page the day this was caught: real +14.41%,
  // equity-only +14.59%, 10.3% average cash. The mix printed +15.92%
  // — above the sleeve, which is not a cash-drag adjustment.
  const bookPct = 14.41;
  const equityPct = 14.59;
  const cashRatio = 0.103;
  const mixed = bookPct + cashRatio * equityPct;
  assert.ok(mixed > equityPct);

  const out = adjustedReturn({ equityPct, cashRatio });
  assert.equal(out.pct, equityPct);
  assert.equal(out.cashRatio, cashRatio);
  assert.ok(out.pct <= equityPct);
});

test('missing inputs are a blank tile, not a zero that looks like a flat year', () => {
  assert.equal(adjustedReturn({ equityPct: 14.59, cashRatio: null }), null);
  assert.equal(adjustedReturn({ equityPct: null, cashRatio: 0.1 }), null);
  assert.equal(adjustedReturn({ equityPct: NaN, cashRatio: 0.1 }), null);
});
