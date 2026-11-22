// The bug only shows where the browser runs behind UTC, which is
// everywhere the club is. Pin New York before anything reads a date.
process.env.TZ = 'America/New_York';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { format } = await import('date-fns');
const { requestDay } = await import('./requestDay.js');

test('a Wednesday request reads as Wednesday in New York', () => {
  // Exactly what RequestPitchModal sends for a date input of 2026-12-02.
  const stored = new Date('2026-12-02').toISOString();
  assert.equal(format(new Date(stored), 'EEE, MMM d'), 'Tue, Dec 1', 'the old reading');
  assert.equal(format(requestDay(stored), 'EEE, MMM d, yyyy'), 'Wed, Dec 2, 2026');
});

test('the day survives the clocks changing', () => {
  for (const [stored, want] of [
    ['2026-03-09T00:00:00.000Z', 'Mon, Mar 9'], // the day after DST starts
    ['2026-11-02T00:00:00.000Z', 'Mon, Nov 2'], // the day after it ends
    ['2026-12-31T00:00:00.000Z', 'Thu, Dec 31'],
  ]) {
    assert.equal(format(requestDay(stored), 'EEE, MMM d'), want);
  }
});

test('no date, or a broken one, is null rather than a guess', () => {
  assert.equal(requestDay(null), null);
  assert.equal(requestDay(''), null);
  assert.equal(requestDay('not a date'), null);
});
