import test from 'node:test';
import assert from 'node:assert/strict';
import { getPortfolioMovers } from './sheetPortfolio.js';

// MOVR is the whole book ranked by today's move. The failure that
// prompted these tests was quiet: the sheet's day-change cells are
// spreadsheet formulas and 12 of 13 were empty, so the panel ranked one
// holding and read as a flat market rather than a missing column.

const BOOK = {
  fetchedAt: '2026-07-26T12:00:00Z',
  holdings: [
    { ticker: 'SCHD', name: 'Schwab Dividend', price: 33.29, dayChange: 0.49 },
    { ticker: 'AIT', name: 'Applied Industrial', price: 347.06, dayChange: null },
    { ticker: 'JNJ', name: 'Johnson & Johnson', price: 160.0, dayChange: null },
    { ticker: 'CASH', name: 'Cash', price: null, dayChange: null, isCash: true },
  ],
};
const book = async () => BOOK;

test('a position the sheet cannot price falls back to a quote', async () => {
  const out = await getPortfolioMovers({
    getSheetPortfolio: book,
    resolveQuotes: async (tickers) => {
      // Only the positions the sheet left blank are asked for.
      assert.deepEqual([...tickers].sort(), ['AIT', 'JNJ']);
      return {
        AIT: { price: 347.06, prevClose: 340.0, dayChange: 7.06, source: 'finnhub' },
        JNJ: { price: 160.0, prevClose: 162.0, dayChange: -2.0, source: 'finnhub' },
      };
    },
  });
  assert.equal(out.count, 3, 'all three positions ranked');
  assert.equal(out.unpriced, 0);
  assert.equal(out.positions, 3, 'cash is not a position');
  // Best to worst.
  assert.deepEqual(out.rows.map((r) => r.ticker), ['AIT', 'SCHD', 'JNJ']);
  // Per-share move over the PRIOR share price, not over position value.
  assert.ok(Math.abs(out.rows[0].changePct - 7.06 / 340) < 1e-9);
  // Where each row came from, because a list mixing stale sheet rows
  // with live quotes is worse than either if you cannot tell.
  assert.equal(out.rows.find((r) => r.ticker === 'SCHD').source, 'sheet');
  assert.equal(out.rows.find((r) => r.ticker === 'AIT').source, 'finnhub');
});

test('a quote outage never costs the rows the sheet did supply', async () => {
  for (const bad of [async () => { throw new Error('finnhub down'); }, async () => null, async () => ({})]) {
    const out = await getPortfolioMovers({ getSheetPortfolio: book, resolveQuotes: bad });
    assert.equal(out.count, 1, 'SCHD survives');
    // And the two it could not price are counted rather than vanishing —
    // 1 of 3 must not read as a one-holding book.
    assert.equal(out.unpriced, 2);
    assert.equal(out.positions, 3);
  }
});

test('the sheet is not asked for quotes it already has', async () => {
  let called = false;
  const out = await getPortfolioMovers({
    getSheetPortfolio: async () => ({ fetchedAt: null, holdings: [BOOK.holdings[0]] }),
    resolveQuotes: async () => { called = true; return {}; },
  });
  assert.equal(called, false);
  assert.equal(out.count, 1);
  assert.equal(out.unpriced, 0);
});

test('a nonsensical prior price is dropped rather than ranked', async () => {
  // dayChange >= price would make prior <= 0 and the percentage
  // meaningless or infinite.
  const out = await getPortfolioMovers({
    getSheetPortfolio: async () => ({
      fetchedAt: null,
      holdings: [{ ticker: 'ODD', price: 5, dayChange: 5 }],
    }),
    resolveQuotes: async () => ({}),
  });
  assert.equal(out.count, 0);
  assert.equal(out.unpriced, 1);
});
