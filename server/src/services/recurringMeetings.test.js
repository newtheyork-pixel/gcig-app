import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleInstanceIds } from './recurringMeetings.js';

// The startup run used to delete every recurring row outside a window
// reaching three months back, so each deploy erased the oldest weeks of
// attendance. Past meetings are history and must survive any schedule.

const NOW = new Date('2026-10-07T12:00:00Z');
const T = 'Griffin Fund Weekly Meeting';
const key = (e) => `${e.title}::${new Date(e.date).toISOString()}`;

test('a meeting that already happened is never pruned, inside or outside the window', () => {
  const existing = [
    { id: 1, title: T, date: new Date('2026-04-15T13:50:00Z') }, // the first meeting
    { id: 2, title: T, date: new Date('2026-06-10T13:50:00Z') }, // > 3 months back
    { id: 3, title: T, date: new Date('2026-10-07T11:00:00Z') }, // earlier today
  ];
  assert.deepEqual(staleInstanceIds(existing, new Set(), NOW), []);
});

test('a future meeting that fell off the schedule is pruned', () => {
  const kept = { id: 10, title: T, date: new Date('2026-10-14T13:50:00Z') };
  const dropped = { id: 11, title: T, date: new Date('2026-10-21T13:50:00Z') };
  const retired = { id: 12, title: 'Old Meeting', date: new Date('2026-11-04T13:50:00Z') };
  const expected = new Set([key(kept)]);
  assert.deepEqual(staleInstanceIds([kept, dropped, retired], expected, NOW), [11, 12]);
});
