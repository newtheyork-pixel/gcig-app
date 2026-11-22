// The request emails print the day a member picked. On a server running
// in UTC they always had, by accident; pin New York, where the website
// was already showing the day before, before anything reads a date.
process.env.TZ = 'America/New_York';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { requestDateLabel } = await import('./email.js');

test('the email names the day that was picked, whatever zone the server is in', () => {
  // What the request form stores for a date input of 2026-12-02.
  const stored = new Date('2026-12-02').toISOString();
  assert.equal(
    new Date(stored).toLocaleDateString('en-US', { weekday: 'long' }),
    'Tuesday',
    'read in the server zone it is the day before'
  );
  assert.equal(requestDateLabel(stored), 'Wednesday, December 2, 2026');
  assert.equal(requestDateLabel(new Date(stored)), 'Wednesday, December 2, 2026');
});

test('no date, or a broken one, gives null', () => {
  assert.equal(requestDateLabel(null), null);
  assert.equal(requestDateLabel('not a date'), null);
});
