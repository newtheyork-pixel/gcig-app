import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transformReleaseDates,
  isWatched,
  computeYoY,
  latestAndPrior,
} from './ecoCalendar.js';

// The transform is pinned to a fixture shaped exactly like FRED's
// /fred/releases/dates JSON (release_id + release_name + date per
// row), so the suite runs without a key and a FRED payload change
// breaks a test instead of the panel.

const WINDOW = { start: '2026-08-07', end: '2026-08-21' };

const FIXTURE = {
  realtime_start: '2026-08-07',
  realtime_end: '2026-08-21',
  order_by: 'release_date',
  sort_order: 'asc',
  count: 8,
  offset: 0,
  limit: 1000,
  release_dates: [
    { release_id: 50, release_name: 'Employment Situation', date: '2026-08-07' },
    { release_id: 10, release_name: 'Consumer Price Index', date: '2026-08-12' },
    // Exact duplicate — FRED can repeat a row across realtime windows.
    { release_id: 10, release_name: 'Consumer Price Index', date: '2026-08-12' },
    { release_id: 466, release_name: 'Gasoline and Diesel Fuel Update', date: '2026-08-10' },
    // Same day as an unwatched release, arrives after it in the feed —
    // the watched one should still lead within the day.
    { release_id: 180, release_name: 'Unemployment Insurance Weekly Claims Report', date: '2026-08-10' },
    // No release_name on the row — resolved through the /fred/releases map.
    { release_id: 999, date: '2026-08-11' },
    // Outside the 14-day window — must be clamped out even if FRED
    // returns it.
    { release_id: 53, release_name: 'Gross Domestic Product', date: '2026-09-01' },
    // No date at all — dropped, not guessed.
    { release_id: 46, release_name: 'Producer Price Index' },
  ],
};

test('transforms a release-dates payload: clamp, dedupe, sort, name fallback', () => {
  const rows = transformReleaseDates(FIXTURE, {
    ...WINDOW,
    nameById: { 999: 'Treasury International Capital' },
  });

  // 8 fixture rows → 5 survivors: dupe collapsed, out-of-window
  // clamped, dateless dropped.
  assert.equal(rows.length, 5);

  // Date-ascending, watched leading within a shared day.
  assert.deepEqual(
    rows.map((r) => `${r.date} ${r.release}`),
    [
      '2026-08-07 Employment Situation',
      '2026-08-10 Unemployment Insurance Weekly Claims Report',
      '2026-08-10 Gasoline and Diesel Fuel Update',
      '2026-08-11 Treasury International Capital',
      '2026-08-12 Consumer Price Index',
    ]
  );

  // Watched tagging rode through the transform.
  assert.deepEqual(
    rows.map((r) => r.watched),
    [true, true, false, false, true]
  );

  // FRED carries no consensus numbers: every row must say so
  // explicitly rather than omit the field.
  for (const r of rows) {
    assert.ok('forecast' in r, `${r.release} is missing the forecast field`);
    assert.equal(r.forecast, null);
  }
});

test('a row with no name anywhere still surfaces, labeled by id', () => {
  const rows = transformReleaseDates(
    { release_dates: [{ release_id: 777, date: '2026-08-09' }] },
    WINDOW
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].release, 'Release 777');
  assert.equal(rows[0].watched, false);
});

test('malformed payloads transform to an empty list, never a throw', () => {
  assert.deepEqual(transformReleaseDates(null, WINDOW), []);
  assert.deepEqual(transformReleaseDates({}, WINDOW), []);
  assert.deepEqual(transformReleaseDates({ release_dates: 'nope' }, WINDOW), []);
});

// ---------------------------------------------------------------------------
// The watched set, against FRED's own canonical release names.

test('every club-relevant release name is watched', () => {
  const canonical = [
    'Employment Situation',
    'Consumer Price Index',
    'Producer Price Index',
    'Gross Domestic Product',
    'Personal Income and Outlays',
    'Advance Monthly Sales for Retail and Food Services',
    'H.15 Selected Interest Rates',
    'Surveys of Consumers',
    'New Residential Construction',
    'G.17 Industrial Production and Capacity Utilization',
    'Unemployment Insurance Weekly Claims Report',
  ];
  for (const name of canonical) {
    assert.ok(isWatched(name), `expected watched: ${name}`);
  }
});

test('near-miss release names stay unwatched', () => {
  // The anchors exist for exactly these: FRED publishes sibling
  // releases whose names extend a watched one.
  const unwatched = [
    'Gross Domestic Product by Industry',
    'Consumer Price Index for All Urban Consumers: Research Series',
    'Gasoline and Diesel Fuel Update',
    'FOMC Press Release', // not a real FRED release — and must not match
    '',
    null,
  ];
  for (const name of unwatched) {
    assert.equal(isWatched(name), false, `expected unwatched: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// YoY computation (CPI). Observations arrive oldest-first, matching
// getFredSeries' contract.

function monthlyObs(startYear, startMonth, values) {
  return values.map((value, i) => {
    const m = startMonth + i;
    const y = startYear + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    return { date: `${y}-${String(mm).padStart(2, '0')}-01`, value };
  });
}

test('computes YoY from the calendar-month pair, with a prior-month YoY', () => {
  // 14 months: Jun 2025 .. Jul 2026. Index walks 100 → 104 over the
  // year to Jul 2026 (4.00%), and 100 → 103 over the year to Jun 2026
  // (3.00%) — chosen so both YoY figures are exact at 2dp.
  const values = [100, 100, 100.5, 101, 101.2, 101.5, 102, 102.2, 102.5, 102.8, 103.2, 103.5, 103, 104];
  const obs = monthlyObs(2025, 6, values);
  const out = computeYoY(obs);
  assert.equal(out.date, '2026-07-01');
  assert.equal(out.value, 4); // (104 - 100) / 100
  assert.equal(out.prior, 3); // Jun 2026 vs Jun 2025: (103 - 100) / 100
});

test('YoY is null when the year-ago month is missing, not offset-guessed', () => {
  // 13 consecutive months would put the year-ago reading 12 slots
  // back; delete that month and an offset-based lookup would land on
  // the wrong one. The month-keyed lookup must return null instead.
  const obs = monthlyObs(2025, 7, [100, 100.2, 100.4, 100.6, 100.8, 101, 101.2, 101.4, 101.6, 101.8, 102, 102.2, 104]);
  assert.equal(computeYoY(obs).value, 4); // sanity: intact series works
  const gapped = obs.filter((o) => o.date !== '2025-07-01');
  const out = computeYoY(gapped);
  assert.equal(out.value, null);
  assert.equal(out.prior, null);
});

test('YoY on short or empty history is null', () => {
  assert.equal(computeYoY([]).value, null);
  assert.equal(computeYoY(monthlyObs(2026, 1, [100, 101, 102])).value, null);
});

// ---------------------------------------------------------------------------
// latestAndPrior — the simple half of the prints table.

test('latest and prior come off the tail of an oldest-first feed', () => {
  const out = latestAndPrior([
    { date: '2026-07-25', value: 224000 },
    { date: '2026-08-01', value: 218000 },
  ]);
  assert.deepEqual(out, { value: 218000, prior: 224000, date: '2026-08-01' });
});

test('a single observation yields a null prior; none yields all nulls', () => {
  assert.deepEqual(latestAndPrior([{ date: '2026-08-01', value: 4.2 }]), {
    value: 4.2,
    prior: null,
    date: '2026-08-01',
  });
  assert.deepEqual(latestAndPrior([]), { value: null, prior: null, date: null });
  assert.deepEqual(latestAndPrior(undefined), { value: null, prior: null, date: null });
});
