import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateKey,
  easternDateKey,
  easternInstant,
  addDaysToKey,
  weekdayOfKey,
} from './easternTime.js';

test('1:50 PM in New York is 17:50 UTC in summer and 18:50 UTC in winter', () => {
  assert.equal(easternInstant('2026-10-07', 13, 50).toISOString(), '2026-10-07T17:50:00.000Z');
  assert.equal(easternInstant('2026-11-04', 13, 50).toISOString(), '2026-11-04T18:50:00.000Z');
});

test('the days the clocks change still land on the right wall-clock time', () => {
  // DST ends 2026-11-01 and begins 2027-03-14.
  assert.equal(easternInstant('2026-11-01', 13, 50).toISOString(), '2026-11-01T18:50:00.000Z');
  assert.equal(easternInstant('2027-03-14', 13, 50).toISOString(), '2027-03-14T17:50:00.000Z');
});

test('a New York day is not a UTC day', () => {
  // 02:00 UTC on the 8th is still the evening of the 7th in New York.
  assert.equal(easternDateKey(new Date('2026-10-08T02:00:00Z')), '2026-10-07');
  assert.equal(easternDateKey(new Date('2026-10-08T05:00:00Z')), '2026-10-08');
});

test('date keys: arithmetic, weekdays and validation', () => {
  assert.equal(addDaysToKey('2026-12-30', 7), '2027-01-06');
  assert.equal(addDaysToKey('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOfKey('2026-10-07'), 3); // a Wednesday
  assert.equal(isDateKey('2026-02-29'), false);
  assert.equal(isDateKey('2028-02-29'), true);
  assert.equal(isDateKey('2026-1-7'), false);
  assert.equal(isDateKey(null), false);
});
