import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeTradeRequest,
  executeDirectTrade,
  executeBulkTrades,
  TradeExecutionError,
} from './tradeExecution.js';

// Exercises the whole settlement orchestration — buying-power guard, sells
// funding buys, FIFO realized P/L, soft-close, idempotency — against an
// in-memory fake of the Prisma client injected via the `db` param. It can't
// catch a real SQL/constraint issue (that needs a Postgres integration test),
// but it pins the money logic that lives above the database.

function makeFakeDb(initial = {}) {
  const state = {
    holdings: (initial.holdings || []).map((h) => ({ ...h })),
    lots: (initial.lots || []).map((l) => ({ ...l })),
    transactions: (initial.transactions || []).map((t) => ({ ...t })),
    tradeRequests: (initial.tradeRequests || []).map((r) => ({ ...r })),
    seq: 1000,
  };
  const nextId = () => (state.seq += 1);
  const tval = (d) => (d && typeof d.getTime === 'function' ? d.getTime() : Number(d) || 0);

  const tx = {
    // The settlement takes a FOR UPDATE row lock first; the fake has no real
    // locking, so this is a no-op that just lets the call resolve.
    $queryRaw: async () => [],
    holding: {
      findUnique: async ({ where }) =>
        state.holdings.find((h) => h.ticker === where.ticker) || null,
      update: async ({ where, data }) => {
        const h = state.holdings.find((x) => x.ticker === where.ticker);
        Object.assign(h, data);
        return h;
      },
      create: async ({ data }) => {
        const h = { id: nextId(), closedAt: null, ...data };
        state.holdings.push(h);
        return h;
      },
    },
    holdingLot: {
      findMany: async ({ where }) =>
        state.lots
          .filter((l) => l.ticker === where.ticker)
          .sort((a, b) => tval(a.buyDate) - tval(b.buyDate) || a.id - b.id),
      count: async ({ where }) => state.lots.filter((l) => l.ticker === where.ticker).length,
      create: async ({ data }) => {
        const l = { id: nextId(), ...data };
        state.lots.push(l);
        return l;
      },
      update: async ({ where, data }) => {
        const l = state.lots.find((x) => x.id === where.id);
        Object.assign(l, data);
        return l;
      },
      delete: async ({ where }) => {
        const i = state.lots.findIndex((x) => x.id === where.id);
        state.lots.splice(i, 1);
        return {};
      },
    },
    transaction: {
      aggregate: async () => ({
        _sum: { cashDelta: state.transactions.reduce((s, t) => s + t.cashDelta, 0) },
      }),
      count: async ({ where }) =>
        state.transactions.filter((t) =>
          where?.tradeRequestId == null ? true : t.tradeRequestId === where.tradeRequestId
        ).length,
      create: async ({ data }) => {
        const t = { id: nextId(), ...data };
        state.transactions.push(t);
        return t;
      },
    },
    tradeRequest: {
      findUnique: async ({ where }) =>
        state.tradeRequests.find((r) => r.id === where.id) || null,
      update: async ({ where, data }) => {
        const r = state.tradeRequests.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
    },
  };

  return {
    $transaction: async (fn) => fn(tx),
    _state: state,
    cash: () => state.transactions.reduce((s, t) => s + t.cashDelta, 0),
    holding: (ticker) => state.holdings.find((h) => h.ticker === ticker),
    lotsFor: (ticker) => state.lots.filter((l) => l.ticker === ticker),
    txns: () => state.transactions,
  };
}

const olderDate = new Date('2026-01-01T00:00:00Z');
const newerDate = new Date('2026-03-01T00:00:00Z');

function tr(id, items, extra = {}) {
  return { id, executedAt: null, executedByName: null, docusignStatus: 'completed', items, ...extra };
}

test('buy a brand-new ticker — creates holding, lot, ledger row, debits cash', async () => {
  const db = makeFakeDb({
    transactions: [{ id: 1, kind: 'Opening', cashDelta: 10000 }],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Buy', ticker: 'NEW', shares: 10, pricePerShare: 100, votingSessionId: 7 }])],
  });
  const res = await executeTradeRequest({ tradeRequestId: 1, actorName: 'Exec', db });

  const h = db.holding('NEW');
  assert.equal(h.shares, 10);
  assert.equal(h.costBasis, 100);
  assert.equal(h.closedAt, null);
  assert.equal(db.lotsFor('NEW').length, 1);
  assert.equal(db.cash(), 9000); // 10000 - 10*100
  const buy = db.txns().find((t) => t.kind === 'Buy');
  assert.equal(buy.cashDelta, -1000);
  assert.equal(buy.tradeRequestId, 1);
  assert.equal(buy.votingSessionId, 7);
  assert.ok(res.tradeRequest.executedAt);
});

test('partial sell relieves lots FIFO and books realized P/L vs the lots consumed', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 15, costBasis: 36.67, isCash: false, closedAt: null }],
    lots: [
      { id: 1, ticker: 'AAA', shares: 5, pricePerShare: 30, buyDate: olderDate },
      { id: 2, ticker: 'AAA', shares: 10, pricePerShare: 40, buyDate: newerDate },
    ],
    transactions: [],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Sell', ticker: 'AAA', shares: 7, pricePerShare: 50, votingSessionId: null }])],
  });
  await executeTradeRequest({ tradeRequestId: 1, actorName: 'Exec', db });

  const sell = db.txns().find((t) => t.kind === 'Sell');
  // (50-30)*5 from the oldest lot + (50-40)*2 from the next = 100 + 20
  assert.equal(sell.realizedPnl, 120);
  assert.equal(sell.cashDelta, 350); // 7 * 50
  assert.equal(db.cash(), 350);
  const h = db.holding('AAA');
  assert.equal(h.shares, 8); // 15 - 7
  assert.equal(h.costBasis, 40); // only the $40 lot remains
  assert.equal(db.lotsFor('AAA').length, 1);
  assert.equal(db.lotsFor('AAA')[0].shares, 8);
});

test('selling the whole position soft-closes the holding', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 10, costBasis: 45, isCash: false, closedAt: null }],
    lots: [{ id: 1, ticker: 'AAA', shares: 10, pricePerShare: 45, buyDate: olderDate }],
    transactions: [],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Sell', ticker: 'AAA', shares: 10, pricePerShare: 50 }])],
  });
  await executeTradeRequest({ tradeRequestId: 1, db });
  const h = db.holding('AAA');
  assert.equal(h.shares, 0);
  assert.ok(h.closedAt, 'closedAt should be set when shares reach 0');
  assert.equal(db.lotsFor('AAA').length, 0);
});

test('a sell funds a buy in the same basket (net-cash buying power)', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 10, costBasis: 45, isCash: false, closedAt: null }],
    lots: [{ id: 1, ticker: 'AAA', shares: 10, pricePerShare: 45, buyDate: olderDate }],
    transactions: [], // zero cash to start — only the sell makes the buy affordable
    tradeRequests: [
      tr(1, [
        { id: 11, kind: 'Sell', ticker: 'AAA', shares: 10, pricePerShare: 50 },
        { id: 12, kind: 'Buy', ticker: 'BBB', shares: 4, pricePerShare: 100 },
      ]),
    ],
  });
  await executeTradeRequest({ tradeRequestId: 1, db });
  assert.equal(db.cash(), 100); // 0 + 500 (sell) - 400 (buy)
  assert.equal(db.holding('BBB').shares, 4);
  assert.ok(db.holding('AAA').closedAt);
});

test('insufficient cash is rejected before anything is written', async () => {
  const db = makeFakeDb({
    transactions: [{ id: 1, kind: 'Opening', cashDelta: 100 }],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Buy', ticker: 'XYZ', shares: 10, pricePerShare: 50 }])],
  });
  await assert.rejects(
    () => executeTradeRequest({ tradeRequestId: 1, db }),
    (e) => e instanceof TradeExecutionError && /Insufficient cash/.test(e.message)
  );
  assert.equal(db.cash(), 100); // unchanged
  assert.equal(db.holding('XYZ'), undefined); // nothing created
});

test('an already-filled request cannot execute twice (idempotency)', async () => {
  const db = makeFakeDb({
    transactions: [{ id: 1, kind: 'Opening', cashDelta: 10000 }],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Buy', ticker: 'NEW', shares: 1, pricePerShare: 100 }], { executedAt: new Date() })],
  });
  await assert.rejects(
    () => executeTradeRequest({ tradeRequestId: 1, db }),
    (e) => e instanceof TradeExecutionError && /already/.test(e.message)
  );
});

test('direct buy of a new ticker debits cash and creates the position', async () => {
  const db = makeFakeDb({ transactions: [{ id: 1, kind: 'Opening', cashDelta: 10000 }] });
  await executeDirectTrade({ side: 'Buy', ticker: 'NEW', shares: 10, pricePerShare: 100, db });
  assert.equal(db.holding('NEW').shares, 10);
  assert.equal(db.cash(), 9000);
  assert.equal(db.txns().find((t) => t.kind === 'Buy').cashDelta, -1000);
});

test('direct sell relieves lots, books realized P/L, credits cash', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 10, costBasis: 45, isCash: false, closedAt: null }],
    lots: [{ id: 1, ticker: 'AAA', shares: 10, pricePerShare: 45, buyDate: olderDate }],
  });
  await executeDirectTrade({ side: 'Sell', ticker: 'AAA', shares: 4, pricePerShare: 50, db });
  const sell = db.txns().find((t) => t.kind === 'Sell');
  assert.equal(sell.realizedPnl, 20); // (50-45)*4
  assert.equal(sell.cashDelta, 200);
  assert.equal(db.cash(), 200);
  assert.equal(db.holding('AAA').shares, 6);
});

test('direct buy with noCash adds shares without moving cash (transfer-in)', async () => {
  const db = makeFakeDb({ transactions: [{ id: 1, kind: 'Opening', cashDelta: 1000 }] });
  await executeDirectTrade({ side: 'Buy', ticker: 'GIFT', shares: 5, pricePerShare: 100, noCash: true, db });
  assert.equal(db.holding('GIFT').shares, 5);
  assert.equal(db.cash(), 1000); // unchanged — no cash spent
  assert.equal(db.txns().filter((t) => t.kind === 'Buy').length, 0); // no ledger row
});

test('direct buy beyond available cash is rejected', async () => {
  const db = makeFakeDb({ transactions: [{ id: 1, kind: 'Opening', cashDelta: 100 }] });
  await assert.rejects(
    () => executeDirectTrade({ side: 'Buy', ticker: 'XYZ', shares: 10, pricePerShare: 50, db }),
    (e) => e instanceof TradeExecutionError && /Insufficient cash/.test(e.message)
  );
  assert.equal(db.cash(), 100);
});

test('direct sell beyond the held position is rejected', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 5, costBasis: 45, isCash: false, closedAt: null }],
    lots: [{ id: 1, ticker: 'AAA', shares: 5, pricePerShare: 45, buyDate: olderDate }],
  });
  await assert.rejects(
    () => executeDirectTrade({ side: 'Sell', ticker: 'AAA', shares: 10, pricePerShare: 50, db }),
    (e) => e instanceof TradeExecutionError && /only 5 held/.test(e.message)
  );
});

test('bulk trades run sells before buys so proceeds fund the buys', async () => {
  const db = makeFakeDb({
    holdings: [{ ticker: 'AAA', name: 'AAA', shares: 10, costBasis: 45, isCash: false, closedAt: null }],
    lots: [{ id: 1, ticker: 'AAA', shares: 10, pricePerShare: 45, buyDate: olderDate }],
    transactions: [{ id: 2, kind: 'Opening', cashDelta: 100 }], // only $100 cash to start
  });
  // Buy listed FIRST but needs $400 with only $100 on hand — the $500 sell must
  // run first or the whole batch fails.
  await executeBulkTrades({
    trades: [
      { side: 'Buy', ticker: 'BBB', shares: 4, pricePerShare: 100 },
      { side: 'Sell', ticker: 'AAA', shares: 10, pricePerShare: 50 },
    ],
    db,
  });
  assert.equal(db.holding('BBB').shares, 4);
  assert.ok(db.holding('AAA').closedAt);
  assert.equal(db.cash(), 200); // 100 + 500 sell − 400 buy
});

test('editable fills override the recorded quote-at-send', async () => {
  const db = makeFakeDb({
    transactions: [{ id: 1, kind: 'Opening', cashDelta: 10000 }],
    tradeRequests: [tr(1, [{ id: 11, kind: 'Buy', ticker: 'NEW', shares: 10, pricePerShare: 100 }])],
  });
  // Broker actually filled 9 shares at $102.50.
  await executeTradeRequest({ tradeRequestId: 1, fills: [{ itemId: 11, shares: 9, pricePerShare: 102.5 }], db });
  assert.equal(db.holding('NEW').shares, 9);
  assert.equal(db.holding('NEW').costBasis, 102.5);
  assert.equal(db.cash(), 10000 - 9 * 102.5);
});
