import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesOccurrences, planSeries } from './recurringMeetings.js';

// Wednesday 7 October 2026, 11:00 in New York (15:00 UTC).
const NOW = new Date('2026-10-07T15:00:00Z');

const WEDNESDAY = {
  id: 1,
  title: 'Griffin Fund Weekly Meeting',
  dayOfWeek: 3,
  startHour: 13,
  startMinute: 50,
  durationMinutes: 30,
  location: null,
  description: 'Weekly club meeting (1:50 – 2:20 PM)',
  startsOn: '2026-04-15',
  endsOn: null,
};

function row(id, iso, extra = {}) {
  return {
    id,
    date: new Date(iso),
    title: WEDNESDAY.title,
    location: null,
    description: WEDNESDAY.description,
    durationMinutes: 30,
    ...extra,
  };
}

test('occurrences fall on the series weekday at New York time, inside its dates', () => {
  const out = seriesOccurrences({ ...WEDNESDAY, endsOn: '2026-11-04' }, '2026-10-05', '2026-12-31');
  assert.deepEqual(out.map((o) => o.key), ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']);
  assert.equal(out[0].date.toISOString(), '2026-10-07T17:50:00.000Z');
  assert.equal(out[4].date.toISOString(), '2026-11-04T18:50:00.000Z'); // after DST ends
});

test('a meeting that has already happened is never moved, removed or doubled', () => {
  // Stored at 13:50 UTC (9:50 AM New York) by the old server-local code:
  // this morning's meeting has started, so it stays exactly as it is,
  // even though the schedule now says 1:50 PM.
  const thisMorning = row(7, '2026-10-07T13:50:00Z');
  const plan = planSeries(WEDNESDAY, [thisMorning], NOW);
  assert.equal(plan.update.find((u) => u.id === 7), undefined);
  assert.equal(plan.remove.includes(7), false);
  assert.equal(plan.create.some((c) => c.date.toISOString().startsWith('2026-10-07')), false);
});

test('an ended series removes upcoming meetings, never past ones', () => {
  const past = row(1, '2026-09-30T17:50:00Z');
  const future = row(2, '2026-10-14T17:50:00Z');
  const plan = planSeries({ ...WEDNESDAY, endsOn: '2026-10-06' }, [past, future], NOW);
  assert.deepEqual(plan.remove, [2]);
  assert.equal(plan.create.length, 0);
});

test('an upcoming meeting keeps its id when the time changes', () => {
  // Next week's row was stored at the wrong hour; it is moved, not
  // replaced, so attendance marked ahead and a cancellation survive.
  const nextWeek = row(8, '2026-10-14T13:50:00Z', { cancelledAt: new Date() });
  const plan = planSeries(WEDNESDAY, [nextWeek], NOW);
  const u = plan.update.find((x) => x.id === 8);
  assert.equal(u.data.date.toISOString(), '2026-10-14T17:50:00.000Z');
  assert.equal(plan.remove.includes(8), false);
  assert.equal('cancelledAt' in u.data, false, 'a cancellation is not the schedule’s to undo');
});

test('moving the meeting to Thursday replaces upcoming Wednesdays only', () => {
  const thursday = { ...WEDNESDAY, dayOfWeek: 4 };
  const nextWed = row(9, '2026-10-14T17:50:00Z');
  const plan = planSeries(thursday, [nextWed], NOW);
  assert.deepEqual(plan.remove, [9]);
  assert.equal(plan.create[0].date.toISOString(), '2026-10-08T17:50:00.000Z');
  assert.equal(plan.create[0].seriesId, 1);
  assert.equal(plan.create[0].recurring, true);
});

test('a second upcoming occurrence on the same day is removed', () => {
  const a = row(10, '2026-10-14T17:50:00Z');
  const b = row(11, '2026-10-14T18:00:00Z');
  const plan = planSeries(WEDNESDAY, [a, b], NOW);
  assert.deepEqual(plan.remove, [11]);
});

// The June rebrand left every Wednesday under its old title as well, at
// the same instant as the new row. The migration links both to the series.
const OLD_TITLE = { title: 'GCIG Weekly Meeting' };

test('of a renamed pair, the older row is kept and takes the series title', () => {
  const old = row(12, '2026-10-21T13:50:00Z', OLD_TITLE);
  const copy = row(40, '2026-10-21T13:50:00Z');
  const plan = planSeries(WEDNESDAY, [copy, old], NOW);
  assert.deepEqual(plan.remove, [40]);
  const u = plan.update.find((x) => x.id === 12);
  assert.equal(u.data.title, 'Griffin Fund Weekly Meeting');
  assert.equal(u.data.date.toISOString(), '2026-10-21T17:50:00.000Z');
});

test('the row somebody was marked at is the one kept', () => {
  const old = row(12, '2026-10-21T13:50:00Z', OLD_TITLE);
  const marked = row(40, '2026-10-21T13:50:00Z', { records: 1 });
  const plan = planSeries(WEDNESDAY, [old, marked], NOW);
  assert.deepEqual(plan.remove, [12]);
  assert.ok(plan.update.some((x) => x.id === 40));
});

test('a duplicate carrying a record is never removed', () => {
  const a = row(12, '2026-10-21T13:50:00Z', { ...OLD_TITLE, records: 1 });
  const b = row(40, '2026-10-21T13:50:00Z', { records: 2 });
  const plan = planSeries(WEDNESDAY, [a, b], NOW);
  assert.deepEqual(plan.remove, []);
});

test('a pair that has already met is left as it is', () => {
  const old = row(13, '2026-10-07T13:50:00Z', OLD_TITLE);
  const copy = row(41, '2026-10-07T13:50:00Z');
  const plan = planSeries(WEDNESDAY, [old, copy], NOW);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.update.some((u) => u.id === 13 || u.id === 41), false);
  assert.equal(plan.create.some((c) => c.date.toISOString().startsWith('2026-10-07')), false);
});
