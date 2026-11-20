import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionKind, prepareBallot, computeTally, resolveSellShares } from './votes.js';

test('resolveSessionKind defaults to buy and rejects junk', () => {
  assert.equal(resolveSessionKind(undefined), 'buy');
  assert.equal(resolveSessionKind('buy'), 'buy');
  assert.equal(resolveSessionKind('sell'), 'sell');
  assert.equal(resolveSessionKind('SELL'), 'sell');
  assert.equal(resolveSessionKind('nonsense'), null);
});

test('prepareBallot — buy session keeps existing Buy/Hold/Sell rules', () => {
  assert.deepEqual(prepareBallot('buy', { action: 'Buy', investmentAmount: 2000 }), {
    action: 'Buy', investmentAmount: 2000,
  });
  assert.deepEqual(prepareBallot('buy', { action: 'Hold', investmentAmount: 5000 }), {
    action: 'Hold', investmentAmount: null,
  });
  // Band is $1,500–$25,000; the old $10k ceiling is inside it now.
  assert.deepEqual(prepareBallot('buy', { action: 'Buy', investmentAmount: 25000 }), {
    action: 'Buy', investmentAmount: 25000,
  });
  assert.equal(prepareBallot('buy', { action: 'Buy', investmentAmount: 100 }).error !== undefined, true);
  assert.equal(prepareBallot('buy', { action: 'Buy', investmentAmount: 25001 }).error !== undefined, true);
  assert.equal(prepareBallot('buy', { action: 'Nope' }).error !== undefined, true);
});

test('prepareBallot — sell session allows only Sell/Hold and never an amount', () => {
  assert.deepEqual(prepareBallot('sell', { action: 'Sell', investmentAmount: 9999 }), {
    action: 'Sell', investmentAmount: null,
  });
  assert.deepEqual(prepareBallot('sell', { action: 'Hold' }), {
    action: 'Hold', investmentAmount: null,
  });
  const buyOnSell = prepareBallot('sell', { action: 'Buy', investmentAmount: 2000 });
  assert.equal(buyOnSell.error !== undefined, true);
  assert.match(buyOnSell.error, /Sell or Hold/i);
});

test('prepareBallot — fixed buy session is Buy/No (Hold) only, never an amount', () => {
  const session = { kind: 'buy', amountMode: 'fixed', fixedAmount: 5000 };
  // Buy ratifies the pinned figure; the per-voter amount is ignored.
  assert.deepEqual(prepareBallot(session, { action: 'Buy', investmentAmount: 9999 }), {
    action: 'Buy', investmentAmount: null,
  });
  // "No" arrives as Hold from the client.
  assert.deepEqual(prepareBallot(session, { action: 'Hold' }), {
    action: 'Hold', investmentAmount: null,
  });
  // Sell isn't an option in fixed mode.
  const sell = prepareBallot(session, { action: 'Sell' });
  assert.equal(sell.error !== undefined, true);
  assert.match(sell.error, /Buy or No/i);
});

test('computeTally — President / DoR / CIO Buy amounts count double in the average', () => {
  const users = [
    { id: 1, role: 'JuniorAnalyst' },
    { id: 2, role: 'Analyst' },
    { id: 3, role: 'President' },
    { id: 4, role: 'DirectorOfResearch' },
    { id: 5, role: 'CIO' },
  ];
  // Flat mean of 5k/5k/10k would be ~6.7k; with the three seats at 2×
  // the mean is pulled up: (5+5 + 2×10 + 2×10 + 2×10) / (1+1+2+2+2) = 70/8 = 8750.
  const t = computeTally(
    [
      { userId: 1, action: 'Buy', investmentAmount: 5000 },
      { userId: 2, action: 'Buy', investmentAmount: 5000 },
      { userId: 3, action: 'Buy', investmentAmount: 10000 },
      { userId: 4, action: 'Buy', investmentAmount: 10000 },
      { userId: 5, action: 'Buy', investmentAmount: 10000 },
    ],
    users
  );
  assert.equal(t.buyAmountStats.count, 5);
  assert.equal(t.buyAmountStats.avg, 8750);
  assert.equal(t.buyAmountStats.min, 5000);
  assert.equal(t.buyAmountStats.max, 10000);
  assert.equal(t.buyAmountStats.amountWeighted, true);
  assert.equal(t.buyAmountStats.doubledCount, 3);
});

test('computeTally — Buy average stays flat when no double-weight seat voted Buy', () => {
  const users = [
    { id: 1, role: 'JuniorAnalyst' },
    { id: 2, role: 'Analyst' },
    { id: 9, role: 'President' },
  ];
  const t = computeTally(
    [
      { userId: 1, action: 'Buy', investmentAmount: 2000 },
      { userId: 2, action: 'Buy', investmentAmount: 8000 },
      { userId: 9, action: 'Hold', investmentAmount: null },
    ],
    users
  );
  assert.equal(t.buyAmountStats.avg, 5000);
  assert.equal(t.buyAmountStats.amountWeighted, false);
  assert.equal(t.buyAmountStats.doubledCount, 0);
});

test('computeTally — fixed session derives buyAmountStats from fixedAmount', () => {
  const users = [
    { id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' },
    { id: 3, role: 'JuniorAnalyst' }, { id: 9, role: 'President' },
  ];
  // Three Buy ratifications, one Hold. Buy ballots carry no amount.
  const ballots = [
    { userId: 1, action: 'Buy', investmentAmount: null },
    { userId: 2, action: 'Buy', investmentAmount: null },
    { userId: 3, action: 'Hold', investmentAmount: null },
    { userId: 9, action: 'Buy', investmentAmount: null },
  ];
  const t = computeTally(ballots, users, { amountMode: 'fixed', fixedAmount: 5000 });
  assert.equal(t.finalDecision, 'Buy');
  assert.deepEqual(t.buyAmountStats, {
    count: 3, avg: 5000, min: 5000, max: 5000, fixed: true,
  });
});

test('computeTally — fixed session with no Buy ratifications has null stats', () => {
  const users = [{ id: 1, role: 'JuniorAnalyst' }];
  const ballots = [{ userId: 1, action: 'Hold', investmentAmount: null }];
  const t = computeTally(ballots, users, { amountMode: 'fixed', fixedAmount: 5000 });
  assert.equal(t.buyAmountStats, null);
});

test('computeTally weights a sell session (Sell vs Hold) like a buy vote', () => {
  // 3 general-body Sell, 0 Hold; one leadership Sell. No Buy ballots.
  const users = [
    { id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' },
    { id: 3, role: 'JuniorAnalyst' }, { id: 9, role: 'President' },
  ];
  const ballots = [
    { userId: 1, action: 'Sell', investmentAmount: null },
    { userId: 2, action: 'Sell', investmentAmount: null },
    { userId: 3, action: 'Hold', investmentAmount: null },
    { userId: 9, action: 'Sell', investmentAmount: null },
  ];
  const t = computeTally(ballots, users);
  assert.equal(t.finalDecision, 'Sell');
  assert.equal(t.buyAmountStats, null);
  assert.equal(t.weights.Sell, 4); // general-body bloc (3) + 1 leadership
});

test('resolveSellShares: blank means the whole position, else a positive whole number', () => {
  assert.deepEqual(resolveSellShares(undefined), { sellShares: null });
  assert.deepEqual(resolveSellShares(''), { sellShares: null });
  assert.deepEqual(resolveSellShares('40'), { sellShares: 40 });
  assert.deepEqual(resolveSellShares(7), { sellShares: 7 });
  assert.match(resolveSellShares(0).error, /whole number/);
  assert.match(resolveSellShares(-3).error, /whole number/);
  assert.match(resolveSellShares(2.5).error, /whole number/);
  assert.match(resolveSellShares('abc').error, /whole number/);
});

test('prepareBallot: sell vote sized by voters needs shares on a Sell ballot', () => {
  const session = { kind: 'sell', amountMode: 'vote' };
  assert.deepEqual(prepareBallot(session, { action: 'Sell', sellShares: '30' }), {
    action: 'Sell', investmentAmount: null, sellShares: 30,
  });
  assert.match(prepareBallot(session, { action: 'Sell' }).error, /how many shares/);
  assert.match(prepareBallot(session, { action: 'Sell', sellShares: 1.5 }).error, /whole number/);
  assert.deepEqual(prepareBallot(session, { action: 'Hold', sellShares: 30 }), {
    action: 'Hold', investmentAmount: null,
  });
});

test('computeTally averages Sell ballot share counts', () => {
  const users = [{ id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' }, { id: 3, role: 'President' }];
  const t = computeTally([
    { userId: 1, action: 'Sell', sellShares: 20 },
    { userId: 2, action: 'Sell', sellShares: 41 },
    { userId: 3, action: 'Hold', sellShares: null },
  ], users, { kind: 'sell', amountMode: 'vote' });
  assert.deepEqual(t.sellShareStats, { count: 2, avg: 31, min: 20, max: 41 });
});
