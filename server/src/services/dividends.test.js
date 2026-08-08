import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDividends } from './dividends.js';

// These fixtures are trimmed from live curls of the real endpoint
// (Aug 2026), not invented shapes — the point of the suite is that
// the parser survives what NASDAQ actually sends: dollar-sign display
// strings, "N/A" where a value is missing, null rows on the
// non-NASDAQ licensing wall, and a message field that explains an
// empty table.

// AAPL, assetclass=stocks. Every field populated; note the amounts
// carry "$" and the yield carries "%".
const aaplFixture = {
  data: {
    dividendHeaderValues: [
      { label: 'Ex-Dividend Date', value: '05/11/2026' },
      { label: 'Dividend Yield', value: '0.35%' },
      { label: 'Annual Dividend', value: '$1.08' },
      { label: 'P/E Ratio', value: '51.05' },
    ],
    exDividendDate: '05/11/2026',
    dividendPaymentDate: '05/14/2026',
    yield: '0.35%',
    annualizedDividend: '1.08',
    payoutRatio: '51.05',
    dividends: {
      asOf: null,
      headers: {
        exOrEffDate: 'Ex/EFF Date',
        type: 'Type',
        amount: 'Cash Amount',
        declarationDate: 'Declaration Date',
        recordDate: 'Record Date',
        paymentDate: 'Payment Date',
      },
      rows: [
        { exOrEffDate: '08/10/2026', type: 'Cash', amount: '$0.27', declarationDate: '07/30/2026', recordDate: '08/10/2026', paymentDate: '08/13/2026', currency: 'USD' },
        { exOrEffDate: '05/11/2026', type: 'Cash', amount: '$0.27', declarationDate: '04/30/2026', recordDate: '05/11/2026', paymentDate: '05/14/2026', currency: 'USD' },
        { exOrEffDate: '02/09/2026', type: 'Cash', amount: '$0.26', declarationDate: '01/29/2026', recordDate: '02/09/2026', paymentDate: '02/12/2026', currency: 'USD' },
        { exOrEffDate: '02/09/2024', type: 'Cash', amount: '$0.24', declarationDate: '02/01/2024', recordDate: '02/12/2024', paymentDate: '02/15/2024', currency: 'USD' },
      ],
    },
  },
  message: null,
  status: { rCode: 200, bCodeMessage: null, developerMessage: null },
};

// QQQ, assetclass=etf. ETFs declare nothing in advance, so
// declarationDate arrives as the string "N/A"; the annualized figure
// arrives without a dollar sign and with five decimals.
const qqqFixture = {
  data: {
    exDividendDate: '06/22/2026',
    dividendPaymentDate: '07/10/2026',
    yield: '0.46%',
    annualizedDividend: '3.25396',
    payoutRatio: 'N/A',
    dividends: {
      asOf: null,
      rows: [
        { exOrEffDate: '06/22/2026', type: 'Cash', amount: '$0.81349', declarationDate: 'N/A', recordDate: '06/22/2026', paymentDate: '07/10/2026', currency: 'USD' },
        { exOrEffDate: '03/23/2026', type: 'Cash', amount: '$0.73282', declarationDate: 'N/A', recordDate: '03/23/2026', paymentDate: '03/27/2026', currency: 'USD' },
      ],
    },
  },
  message: null,
  status: { rCode: 200, bCodeMessage: null, developerMessage: null },
};

// JNJ (and every other non-NASDAQ listing): HTTP 200, rCode 200, all
// headers "N/A", rows null, and the reason in `message`. This is the
// licensing wall, not an outage, and not a zero-dividend company.
const nonNasdaqFixture = {
  data: {
    dividendHeaderValues: [
      { label: 'Ex-Dividend Date', value: 'N/A' },
      { label: 'Dividend Yield', value: 'N/A' },
      { label: 'Annual Dividend', value: 'N/A' },
      { label: 'P/E Ratio', value: 'N/A' },
    ],
    exDividendDate: 'N/A',
    dividendPaymentDate: 'N/A',
    yield: 'N/A',
    annualizedDividend: 'N/A',
    payoutRatio: 'N/A',
    dividends: { asOf: null, headers: null, rows: null },
  },
  message: 'Dividend History for Non-Nasdaq symbols is not available',
  status: { rCode: 200, bCodeMessage: null, developerMessage: null },
};

// The wrong asset-class bucket: HTTP 200 wrapping an rCode 400 with
// data null. fetchNasdaqDividends screens these out before the parser
// ever sees them, but the parser must survive one anyway.
const wrongBucketFixture = {
  data: null,
  message: null,
  status: {
    rCode: 400,
    bCodeMessage: [{ code: 1001, errorMessage: 'Symbol not exists.' }],
    developerMessage: null,
  },
};

test('parses the live AAPL shape: display strings to numbers, dates to ISO', () => {
  const p = parseDividends(aaplFixture);
  assert.equal(p.yield, 0.35 / 100);
  assert.equal(p.annualized, 1.08);
  assert.equal(p.exDate, '2026-05-11');
  assert.equal(p.note, null);
  assert.equal(p.rows.length, 4);
  assert.deepEqual(p.rows[0], {
    exDate: '2026-08-10',
    payDate: '2026-08-13',
    recordDate: '2026-08-10',
    declared: '2026-07-30',
    amount: 0.27,
  });
  // The "$0.24" shape from the older rows parses the same way.
  assert.equal(p.rows[3].amount, 0.24);
  assert.equal(p.rows[3].declared, '2024-02-01');
});

test('ETF rows keep their honest nulls: "N/A" declaration dates, unprefixed annualized', () => {
  const p = parseDividends(qqqFixture);
  assert.equal(p.annualized, 3.25396);
  assert.equal(p.yield, 0.46 / 100);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].amount, 0.81349);
  assert.equal(p.rows[0].declared, null);
  assert.equal(p.rows[0].payDate, '2026-07-10');
});

test('the non-NASDAQ wall is empty rows plus the upstream reason, never zeros', () => {
  const p = parseDividends(nonNasdaqFixture);
  assert.deepEqual(p.rows, []);
  assert.equal(p.yield, null);
  assert.equal(p.annualized, null);
  assert.equal(p.exDate, null);
  assert.equal(p.note, 'Dividend History for Non-Nasdaq symbols is not available');
});

test('a wrong-bucket rCode 400 body parses to nothing without throwing', () => {
  const p = parseDividends(wrongBucketFixture);
  assert.deepEqual(p.rows, []);
  assert.equal(p.note, null);
});

test('a header N/A ex-date falls back to the newest row', () => {
  const p = parseDividends({
    data: {
      exDividendDate: 'N/A',
      yield: 'N/A',
      annualizedDividend: 'N/A',
      dividends: {
        rows: [
          { exOrEffDate: '03/03/2026', amount: '$0.50' },
          { exOrEffDate: '12/02/2025', amount: '$0.50' },
        ],
      },
    },
    message: null,
    status: { rCode: 200 },
  });
  assert.equal(p.exDate, '2026-03-03');
});

test('a row missing one half keeps the other; a row with neither is dropped', () => {
  const p = parseDividends({
    data: {
      dividends: {
        rows: [
          { exOrEffDate: '01/15/2026', amount: 'N/A' },
          { exOrEffDate: 'N/A', amount: '$1.25' },
          { exOrEffDate: 'N/A', amount: 'N/A' },
          { exOrEffDate: 'garbage', amount: '' },
        ],
      },
    },
  });
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], {
    exDate: '2026-01-15',
    payDate: null,
    recordDate: null,
    declared: null,
    amount: null,
  });
  assert.equal(p.rows[1].exDate, null);
  assert.equal(p.rows[1].amount, 1.25);
});

test('null-safety: nothing NASDAQ could send makes the parser throw', () => {
  for (const junk of [null, undefined, {}, { data: null }, { data: {} }, { data: { dividends: {} } }, { data: { dividends: { rows: [null, 'x', 7] } } }, 'not json', 42]) {
    const p = parseDividends(junk);
    assert.deepEqual(p.rows, []);
    assert.equal(p.yield, null);
    assert.equal(p.annualized, null);
    assert.equal(p.exDate, null);
  }
});
