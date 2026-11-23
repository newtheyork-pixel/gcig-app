import test from 'node:test';
import assert from 'node:assert/strict';
import { getPortfolioMovers, parsePortfolioCsv } from './sheetPortfolio.js';

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

// The club's sheet as its CSV export writes it: a date cell above the
// header, a blank row, the header, positions, cash, then the totals.
function sheetCsv(dayCells) {
  const header = [
    '', 'Name', 'Ticker', 'Sector', 'Shares Owned', 'Price on X Date:', 'Current Price',
    'Average Purchase Price', 'Current Market Value', '% of Portfolio', 'Day Change',
    'Trend 30d', 'Trend 180d', '$ Return', 'YTD Return', '% Return Since Purchase',
  ];
  const line = (cells) => cells.map((c) => `"${c}"`).join(',');
  return [
    line(['', '', '', '', '', '1/1/2026']),
    '',
    line(header),
    line(['', 'Vanguard S&P 500 ETF', 'VOO', 'Multi-Sector', '95', '628.3', '677.98', '$640.91',
      '$64,408.10', '47.25%', dayCells.VOO, '', '', '$3,521.65', '7.91%', '5.78%']),
    line(['', 'Mesa Laboratories Inc', 'MLAB', 'Health Care', '121', '79.43', '118.56', '$84.96',
      '$14,345.76', '10.53%', dayCells.MLAB, '', '', '$4,065.60', '49.26%', '39.55%']),
    line(['', 'Cash', '', 'Cash and Cash Equivalents', '1', '', '', '', '$8,935.56', '6.56%']),
    line(['', '', '', '', '', '', '', '', '$87,689.42']),
    line(['', 'Total Portfolio Value:', '', '', '', '', '', '', '$87,689.42']),
  ].join('\n');
}

test('a Day Change written as a percentage becomes the per-share move', async () => {
  // Read as dollars, "-3.80%" made VOO's day a 0.56% dip.
  const { holdings } = parsePortfolioCsv(sheetCsv({ VOO: '-3.80%', MLAB: '-6.05%' }));
  const voo = holdings.find((h) => h.ticker === 'VOO');
  const prior = 677.98 / (1 - 0.038);
  assert.ok(Math.abs(voo.dayChange - (677.98 - prior)) < 1e-9);

  // Every screen derives the percentage back from price and dayChange,
  // so the sheet's own figure has to survive the round trip.
  const out = await getPortfolioMovers({
    getSheetPortfolio: async () => ({ fetchedAt: null, holdings }),
    resolveQuotes: async () => ({}),
  });
  const pct = Object.fromEntries(out.rows.map((r) => [r.ticker, r.changePct]));
  assert.ok(Math.abs(pct.VOO - -0.038) < 1e-12, `VOO ${pct.VOO}`);
  assert.ok(Math.abs(pct.MLAB - -0.0605) < 1e-12, `MLAB ${pct.MLAB}`);
  assert.equal(out.unpriced, 0);
});

test('a Day Change written in dollars is still read as dollars', () => {
  const { holdings } = parsePortfolioCsv(sheetCsv({ VOO: '$-26.78', MLAB: '-7.65' }));
  assert.equal(holdings.find((h) => h.ticker === 'VOO').dayChange, -26.78);
  assert.equal(holdings.find((h) => h.ticker === 'MLAB').dayChange, -7.65);
});

test('a percentage with nothing to scale by is left for the quote fallback', () => {
  const csv = sheetCsv({ VOO: '-3.80%', MLAB: '-100.00%' }).replace('"677.98"', '"#N/A"');
  const { holdings } = parsePortfolioCsv(csv);
  assert.equal(holdings.find((h) => h.ticker === 'VOO').dayChange, null, 'no price');
  assert.equal(holdings.find((h) => h.ticker === 'MLAB').dayChange, null, 'a 100% fall');
  // Cash is never given a move.
  assert.equal(holdings.find((h) => h.isCash).dayChange, null);
});
