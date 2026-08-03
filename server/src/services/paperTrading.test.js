import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planOrder, wouldFill, tick, score, sessionAdvice, better, HALF_SPREAD_PCT,
} from './paperTrading.js';

test('a buy rests below the market and a sell rests above it', () => {
  // The bug that would make this whole test read as a triumph: a limit on
  // the wrong side crosses instantly, fills every time, and reports a
  // spectacular fill rate for a strategy that is simply paying up.
  const b = planOrder({ side: 'buy', price: 100, shares: 10 });
  const s = planOrder({ side: 'sell', price: 100, shares: 10 });
  assert.ok(b.limitPrice < 100, 'a buy must rest below');
  assert.ok(s.limitPrice > 100, 'a sell must rest above');
  assert.ok(Math.abs(b.limitPrice - 100 * (1 - HALF_SPREAD_PCT / 100)) < 1e-6);
});

test('a fill needs the market to come to the price, on the right side', () => {
  const b = planOrder({ side: 'buy', price: 100, shares: 1 });
  assert.equal(wouldFill(b, 99.0), true);
  assert.equal(wouldFill(b, 100.5), false, 'a buy does not fill on the way up');
  const s = planOrder({ side: 'sell', price: 100, shares: 1 });
  assert.equal(wouldFill(s, 101), true);
  assert.equal(wouldFill(s, 99.5), false);
  // A missing or nonsense quote is never a fill.
  assert.equal(wouldFill(b, NaN), false);
  assert.equal(wouldFill(b, 0), false);
});

test('a filled order is recorded at the LIMIT, not at the print', () => {
  // Resting at a price is a claim to be filled AT it. Booking the last
  // trade instead would credit the strategy with a better fill than it
  // ever asked for, which is the quiet way a paper blotter flatters
  // itself.
  const o = {
    id: 1, ticker: 'AAPL', side: 'buy', limitPrice: 99.9, polls: 0,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const now = new Date();
  return tick([o], {
    now: () => now,
    getLiveQuotes: async () => ({ AAPL: { last: 98.0 } }),
  }).then((out) => {
    assert.equal(out[0].data.status, 'filled');
    assert.equal(out[0].data.fillPrice, 99.9, 'the limit, not the 98.00 print');
  });
});

test('an expired order crosses and pays the far side', async () => {
  const o = {
    id: 2, ticker: 'GD', side: 'buy', limitPrice: 90, polls: 4,
    expiresAt: new Date(Date.now() - 1000), bestSeen: 91,
  };
  const out = await tick([o], { getLiveQuotes: async () => ({ GD: { last: 100 } }) });
  assert.equal(out[0].data.status, 'crossed');
  assert.ok(out[0].data.fillPrice > 100, 'crossing pays through the last');
});

test('a quote outage changes nothing at all', async () => {
  // The dangerous failure: treating "we could not see the market" as
  // "the market did not come to us", which would expire orders and book
  // fills against prices nobody saw.
  const o = {
    id: 3, ticker: 'GD', side: 'buy', limitPrice: 90, polls: 0,
    expiresAt: new Date(Date.now() - 1000),
  };
  const out = await tick([o], {
    getLiveQuotes: async () => { throw new Error('finnhub down'); },
  });
  assert.deepEqual(out, [], 'no updates, so the order stays open');
});

test('an order that never sees a quote is abandoned, not filled', async () => {
  const o = {
    id: 4, ticker: 'ZZZZ', side: 'buy', limitPrice: 5, polls: 9,
    expiresAt: new Date(Date.now() - 1000),
  };
  const out = await tick([o], { getLiveQuotes: async () => ({}) });
  assert.equal(out[0].data.status, 'abandoned');
  assert.equal(out[0].data.fillPrice, null, 'no price means no claim about one');
});

test('how close the market came is tracked on the correct side', () => {
  assert.equal(better('buy', 100, 99), 99, 'lower is better when buying');
  assert.equal(better('sell', 100, 99), 100, 'higher is better when selling');
  assert.equal(better('buy', undefined, 99), 99);
  assert.equal(better('buy', 99, NaN), 99);
});

test('shortfall is signed so negative is good on both sides', () => {
  // A sell filled ABOVE arrival is a good outcome. Reporting the raw
  // percentage would file every good sell as a loss.
  const s = score([
    { side: 'buy', arrivalPrice: 100, fillPrice: 99, status: 'filled' },
    { side: 'sell', arrivalPrice: 100, fillPrice: 101, status: 'filled' },
  ]);
  assert.equal(s.n, 2);
  assert.ok(s.avgShortfall < 0, 'both were good fills');
  assert.equal(s.fillRate, 100);
});

test('nothing settled yet reports null rather than zero', () => {
  const s = score([{ side: 'buy', arrivalPrice: 100, fillPrice: null, status: 'open' }]);
  assert.equal(s.n, 0);
  assert.equal(s.fillRate, null, 'no data is not a 0% fill rate');
  assert.equal(s.avgShortfall, null);
});

test('the session gate names WHICH objection it has', () => {
  // "Shut" and "it is 09:41" are different facts, and a disabled button
  // that collapses them teaches nobody anything.
  const sat = sessionAdvice(new Date('2026-08-01T15:00:00Z'));   // Saturday
  assert.equal(sat.phase, 'weekend');
  const early = sessionAdvice(new Date('2026-08-03T13:40:00Z')); // 09:40 ET
  assert.equal(early.phase, 'opening');
  assert.match(early.reason, /minutes until the spread settles/);
  const good = sessionAdvice(new Date('2026-08-03T17:00:00Z'));  // 13:00 ET
  assert.equal(good.ok, true);
  const late = sessionAdvice(new Date('2026-08-03T19:58:00Z'));  // 15:58 ET
  assert.equal(late.ok, false);
});
