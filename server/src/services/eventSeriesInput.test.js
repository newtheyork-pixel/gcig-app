import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeriesInput, describeSeries } from './eventSeriesInput.js';

const NEW = { title: 'Griffin Fund Weekly Meeting', dayOfWeek: 4, time: '14:00', durationMinutes: 45 };

test('a complete new series parses, starting today by default', () => {
  const { data, error } = parseSeriesInput(NEW, { today: '2026-10-07' });
  assert.equal(error, undefined);
  assert.deepEqual(data, {
    title: 'Griffin Fund Weekly Meeting',
    dayOfWeek: 4,
    startHour: 14,
    startMinute: 0,
    durationMinutes: 45,
    startsOn: '2026-10-07',
  });
});

test('a new series needs a title, a day and a time', () => {
  assert.match(parseSeriesInput({ ...NEW, title: '  ' }, { today: '2026-10-07' }).error, /Title/);
  assert.match(parseSeriesInput({ ...NEW, dayOfWeek: 7 }, { today: '2026-10-07' }).error, /day/);
  assert.match(parseSeriesInput({ ...NEW, time: '2pm' }, { today: '2026-10-07' }).error, /HH:MM/);
  assert.match(parseSeriesInput({ ...NEW, time: '24:00' }, { today: '2026-10-07' }).error, /HH:MM/);
  assert.match(parseSeriesInput({ ...NEW, durationMinutes: 0 }, { today: '2026-10-07' }).error, /minutes/);
});

test('an edit changes only what it sends, and can clear a location or an end date', () => {
  assert.deepEqual(parseSeriesInput({ time: '13:50' }, { partial: true }).data, {
    startHour: 13,
    startMinute: 50,
  });
  assert.deepEqual(parseSeriesInput({ location: '', endsOn: null }, { partial: true }).data, {
    location: null,
    endsOn: null,
  });
  assert.match(parseSeriesInput({ title: '' }, { partial: true }).error, /Title/);
});

test('dates are real calendar days, and a series cannot end before it starts', () => {
  assert.match(parseSeriesInput({ ...NEW, startsOn: '2026-02-30' }, {}).error, /first meeting/);
  assert.match(parseSeriesInput({ endsOn: 'soon' }, { partial: true }).error, /last meeting/);
  assert.match(
    parseSeriesInput({ ...NEW, startsOn: '2026-10-07', endsOn: '2026-10-01' }, {}).error,
    /before the first/
  );
});

test('describeSeries reads like the calendar', () => {
  const s = { dayOfWeek: 3, startHour: 13, startMinute: 50, durationMinutes: 30 };
  assert.equal(describeSeries(s), 'Wednesdays, 1:50 PM–2:20 PM');
  assert.equal(describeSeries({ ...s, startHour: 11, startMinute: 30, durationMinutes: 60 }), 'Wednesdays, 11:30 AM–12:30 PM');
});
