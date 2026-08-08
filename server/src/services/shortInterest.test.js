import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShortVolumeFile,
  normalizeSettlements,
  dailyFileCandidates,
} from './shortInterest.js';

// Fixtures are trimmed literals from the live feeds (probed
// 2026-08-07), not invented shapes — the parser has to survive what
// FINRA actually serves: a header, fractional-share volumes, slashed
// share classes, and a bare record-count trailer line.

const CNMS_FIXTURE = [
  'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market',
  '20260806|A|176779.078848|0|323438.701002|B,Q,N',
  '20260806|AAPL|8381448.469567|40260.500000|16462467.524916|B,Q,N',
  '20260806|BRK/B|585840.839964|6045|1529757.462531|B,Q,N',
  '20260806|GD|67834.186898|0|237260.977123|B,Q,N',
  '12173',
].join('\n');

test('CNMS parser reads the real pipe shape and skips header + trailer', () => {
  const m = parseShortVolumeFile(CNMS_FIXTURE);
  assert.equal(m.size, 4);
  // The trailer is a record count, not a symbol; the header is not a
  // row. Either leaking through would poison a lookup.
  assert.equal(m.has('12173'), false);
  assert.equal(m.has('Date'), false);

  const gd = m.get('GD');
  assert.equal(gd.date, '2026-08-06');
  assert.equal(gd.shortVol, 67834.186898);
  assert.equal(gd.shortExemptVol, 0);
  assert.equal(gd.totalVol, 237260.977123);

  // Fractional shares are real in this file — parseInt would silently
  // floor AAPL's exempt volume from 40260.5 to 40260.
  assert.equal(m.get('AAPL').shortExemptVol, 40260.5);
  // Share classes arrive slashed.
  assert.ok(m.has('BRK/B'));

  // The pct the service derives from these volumes, as a fraction.
  assert.ok(Math.abs(gd.shortVol / gd.totalVol - 0.2859) < 0.001);
});

test('CNMS parser returns an empty map for junk without throwing', () => {
  assert.equal(parseShortVolumeFile('').size, 0);
  assert.equal(parseShortVolumeFile(null).size, 0);
  assert.equal(parseShortVolumeFile('<html>Access Denied</html>').size, 0);
});

// Real GD rows in the order the API actually serves them: the default
// sort starts in the OLDEST region of the dataset (the first live
// probe returned 2020 rows), and server-side sorting is refused (400,
// partition-key rule). normalizeSettlements owns the correction.
const GD_SERVED_ORDER = [
  { settlementDate: '2020-04-15', currentShortPositionQuantity: 2839114, previousShortPositionQuantity: 3180120, changePercent: -10.72, daysToCoverQuantity: 1.77, averageDailyVolumeQuantity: 1605595 },
  { settlementDate: '2020-03-31', currentShortPositionQuantity: 3180120, previousShortPositionQuantity: 3892775, changePercent: -18.31, daysToCoverQuantity: 1.12, averageDailyVolumeQuantity: 2847365 },
  { settlementDate: '2026-06-30', currentShortPositionQuantity: 3141061, previousShortPositionQuantity: 3057023, changePercent: 2.75, daysToCoverQuantity: 1.87, averageDailyVolumeQuantity: 1677799 },
  { settlementDate: '2026-07-15', currentShortPositionQuantity: 2890568, previousShortPositionQuantity: 3141061, changePercent: -7.97, daysToCoverQuantity: 2.62, averageDailyVolumeQuantity: 1101959 },
  { settlementDate: '2026-06-15', currentShortPositionQuantity: 3057023, previousShortPositionQuantity: 2618198, changePercent: 16.76, daysToCoverQuantity: 2.66, averageDailyVolumeQuantity: 1147884 },
];

test('settlements come out newest first regardless of served order', () => {
  const rows = normalizeSettlements(GD_SERVED_ORDER);
  assert.deepEqual(
    rows.map((r) => r.date),
    ['2026-07-15', '2026-06-30', '2026-06-15', '2020-04-15', '2020-03-31']
  );
  // The newest print is the one the headline chips read — if the
  // sort correction slips, the panel quotes 2020 as current.
  assert.equal(rows[0].shares, 2890568);
  assert.equal(rows[0].prior, 3141061);
  assert.equal(rows[0].changePct, -7.97);
});

test('settlements cap at 8 rows', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    settlementDate: `2026-0${(i % 6) + 1}-${String(i + 1).padStart(2, '0')}`,
    currentShortPositionQuantity: i,
  }));
  assert.equal(normalizeSettlements(many).length, 8);
});

test('days to cover passes through untouched, absent reads as null', () => {
  const [newest] = normalizeSettlements(GD_SERVED_ORDER);
  assert.equal(newest.daysToCover, 2.62);
  assert.equal(newest.adv, 1101959);

  const [bare] = normalizeSettlements([{ settlementDate: '2026-07-15' }]);
  assert.equal(bare.daysToCover, null);
  assert.equal(bare.shares, null);
  assert.equal(bare.prior, null);
  assert.equal(bare.changePct, null);
  assert.equal(bare.adv, null);
});

test('normalizeSettlements survives junk input', () => {
  assert.deepEqual(normalizeSettlements(null), []);
  assert.deepEqual(normalizeSettlements([null, {}, { symbolCode: 'GD' }]), []);
});

test('daily walk-back candidates: today in New York, then back 5', () => {
  // Noon ET on Friday 2026-08-07.
  const noonET = Date.parse('2026-08-07T16:00:00Z');
  const days = dailyFileCandidates(noonET);
  assert.deepEqual(days, [
    '20260807',
    '20260806',
    '20260805',
    '20260804',
    '20260803',
    '20260802',
  ]);
});

test('daily walk-back is anchored to the US trading day, not UTC', () => {
  // 10pm ET Friday is already Saturday in UTC. Leading with the UTC
  // date would ask the CDN for a file that cannot exist yet.
  const lateFriday = Date.parse('2026-08-08T02:00:00Z');
  assert.equal(dailyFileCandidates(lateFriday)[0], '20260807');
});

test('daily walk-back respects maxBack', () => {
  const noonET = Date.parse('2026-08-07T16:00:00Z');
  const days = dailyFileCandidates(noonET, 2);
  assert.deepEqual(days, ['20260807', '20260806', '20260805']);
});
