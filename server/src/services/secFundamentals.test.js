import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConcept, extractFundamentals } from './secFundamentals.js';

// The brittle part of XBRL is that a single 10-K tags the full year and
// the trailing quarters under the same concept, that concept names drift
// between filers, and that restatements re-tag a year that was already
// reported. These fixtures pin the duration filter, the concept
// fallback, the latest-filed dedupe, and the derived margins on the
// {start,end,val,fy,fp,form,filed} shape SEC returns under
// facts['us-gaap'][Concept].units[unit].
function facts() {
  return {
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              { start: '2022-01-01', end: '2022-12-31', val: 1000, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-02-01' },
              { start: '2023-01-01', end: '2023-12-31', val: 1200, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' },
              // Same FY2023, restated and filed later — must win the dedupe.
              { start: '2023-01-01', end: '2023-12-31', val: 1250, fy: 2023, fp: 'FY', form: '10-K/A', filed: '2024-06-01' },
              // A quarter inside 2023 — must not count as an annual point.
              { start: '2023-01-01', end: '2023-03-31', val: 300, fy: 2023, fp: 'Q1', form: '10-Q', filed: '2023-05-01' },
            ],
          },
        },
        GrossProfit: {
          units: { USD: [{ start: '2023-01-01', end: '2023-12-31', val: 500, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' }] },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { start: '2022-01-01', end: '2022-12-31', val: 100, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-02-01' },
              { start: '2023-01-01', end: '2023-12-31', val: 150, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' },
            ],
          },
        },
        EarningsPerShareDiluted: {
          units: { 'USD/shares': [{ start: '2023-01-01', end: '2023-12-31', val: 1.5, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' }] },
        },
      },
    },
  };
}

test('annual extract dedupes a fiscal year to the latest filing', () => {
  const m = extractConcept(facts(), ['Revenues'], { unit: 'USD', freq: 'annual' });
  assert.equal(m.get('FY2023').val, 1250); // restated value wins
  assert.equal(m.get('FY2022').val, 1000);
  assert.equal(m.size, 2); // the Q1 row is not an annual point
});

test('concept fallback resolves the first reported tag', () => {
  const m = extractConcept(
    facts(),
    ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'],
    { unit: 'USD', freq: 'annual' }
  );
  assert.equal(m.get('FY2023').val, 1250);
});

test('quarterly extract keeps the ~90-day period and drops the full year', () => {
  const m = extractConcept(facts(), ['Revenues'], { unit: 'USD', freq: 'quarterly' });
  assert.equal(m.size, 1);
  assert.equal(m.get('2023 Q1').val, 300);
});

test('fundamentals rows carry derived margins, oldest first', () => {
  const rows = extractFundamentals(facts(), 'annual');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].period, 'FY2022');
  assert.equal(rows[1].period, 'FY2023');

  const fy23 = rows[1];
  assert.equal(fy23.revenue, 1250);
  assert.equal(fy23.grossProfit, 500);
  assert.equal(fy23.netIncome, 150);
  assert.equal(fy23.epsDiluted, 1.5);
  assert.ok(Math.abs(fy23.grossMargin - 500 / 1250) < 1e-9);
  assert.ok(Math.abs(fy23.netMargin - 150 / 1250) < 1e-9);

  // FY2022 tagged no gross profit → its gross margin is null, not zero.
  assert.equal(rows[0].grossMargin, null);
  assert.ok(Math.abs(rows[0].netMargin - 100 / 1000) < 1e-9);
});

test('a directory outage is never reported as "not a filer"', async () => {
  // The regression this guards: EDGAR rate-limited the symbol directory
  // on a fresh boot, every symbol failed to resolve, and MLAB, AIT and
  // GD all came back "not an SEC operating filer" in the same minute.
  const { unresolvedError } = await import('./secFundamentals.js');

  const outage = unresolvedError(false);
  assert.equal(outage.status, 503);
  assert.match(outage.message, /our outage/);
  assert.doesNotMatch(outage.message, /not an SEC operating filer/i);

  // With the directory in hand, an unknown symbol really is not a filer.
  const notAFiler = unresolvedError(true);
  assert.equal(notAFiler.status, 404);
  assert.match(notAFiler.message, /ETFs and funds/);
});

// The comparatives-collapse bug, which put General Dynamics' calendar
// 2023 income statement on screen under the heading FY2025.
//
// One 10-K carries three years and stamps all three with the FILING's
// fiscal year. Keyed on that field they collapsed to a single row, the
// tiebreak could not separate them, and SEC returns the array sorted by
// `end` ascending — so the oldest won and every label was two years
// ahead of its data.
function threeYearTenK() {
  const row = (start, end, val) => ({
    start, end, val, fy: 2025, fp: 'FY', form: '10-K',
    accn: '0000040533-26-000006', filed: '2026-01-30',
  });
  return {
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              row('2023-01-01', '2023-12-31', 42272000000),
              row('2024-01-01', '2024-12-31', 47716000000),
              row('2025-01-01', '2025-12-31', 52550000000),
            ],
          },
        },
      },
    },
  };
}

test('each comparative in a filing keeps its own fiscal year', () => {
  const m = extractConcept(threeYearTenK(), ['Revenues'], { unit: 'USD', freq: 'annual' });
  assert.equal(m.size, 3, 'all three years survive; they used to collapse to one');
  assert.equal(m.get('FY2025').val, 52550000000);
  assert.equal(m.get('FY2024').val, 47716000000);
  assert.equal(m.get('FY2023').val, 42272000000);
  // The label and the period end must agree. This is the assertion that
  // would have caught the original bug: FY2025 held 2023-12-31.
  for (const [period, p] of m) {
    assert.equal(new Date(p.t).getUTCFullYear(), Number(period.slice(2)),
      `${period} must end in its own year`);
  }
});

test('a 52/53-week year ending in January keeps the prior year label', () => {
  // Johnson & Johnson's fiscal 2020 ended on 3 January 2021. Any
  // arithmetic on calendar years labels it 2021; counting position
  // inside the filing gets it right.
  const jnj = {
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              { start: '2018-12-31', end: '2019-12-29', val: 82059000000, fy: 2020, fp: 'FY', accn: 'A', filed: '2021-02-22' },
              { start: '2019-12-30', end: '2021-01-03', val: 82584000000, fy: 2020, fp: 'FY', accn: 'A', filed: '2021-02-22' },
            ],
          },
        },
      },
    },
  };
  const m = extractConcept(jnj, ['Revenues'], { unit: 'USD', freq: 'annual' });
  assert.deepEqual([...m.keys()].sort(), ['FY2019', 'FY2020']);
  assert.equal(new Date(m.get('FY2020').t).toISOString().slice(0, 10), '2021-01-03');
});

test('a restatement in a later filing still wins its year', () => {
  const original = {
    start: '2024-01-01', end: '2024-12-31', val: 100, fy: 2024, fp: 'FY',
    accn: 'OLD', filed: '2025-01-30',
  };
  const restated = {
    start: '2024-01-01', end: '2024-12-31', val: 111, fy: 2025, fp: 'FY',
    accn: 'NEW', filed: '2026-01-30',
  };
  const current = {
    start: '2025-01-01', end: '2025-12-31', val: 222, fy: 2025, fp: 'FY',
    accn: 'NEW', filed: '2026-01-30',
  };
  const m = extractConcept(
    { facts: { 'us-gaap': { Revenues: { units: { USD: [original, restated, current] } } } } },
    ['Revenues'], { unit: 'USD', freq: 'annual' }
  );
  assert.equal(m.get('FY2024').val, 111, 'the later filing supersedes the original');
  assert.equal(m.get('FY2025').val, 222);
});

test('quarterly comparatives are separated the same way', () => {
  // A 10-Q carries this quarter and the same quarter a year ago, both
  // stamped with the filing's fiscal year.
  const q = (start, end, val) => ({
    start, end, val, fy: 2025, fp: 'Q3', accn: 'Q', filed: '2025-10-29',
  });
  const m = extractConcept(
    { facts: { 'us-gaap': { Revenues: { units: { USD: [
      q('2024-07-01', '2024-09-29', 11), q('2025-06-30', '2025-09-28', 12),
    ] } } } } },
    ['Revenues'], { unit: 'USD', freq: 'quarterly' }
  );
  assert.equal(m.get('2025 Q3').val, 12);
  assert.equal(m.get('2024 Q3').val, 11);
});
