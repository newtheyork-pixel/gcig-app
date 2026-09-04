import test from 'node:test';
import assert from 'node:assert/strict';
import { sendBlockReason } from './outreachSendGuard.js';

const ok = { sentAt: null, rejectedAt: null, screenedAt: new Date(), screenRisk: 'low',
             scheduledFor: null, queuedAt: null };

test('a screened, unsent, unscheduled draft may be sent by hand', () => {
  assert.equal(sendBlockReason(ok), null);
});

test('a scheduled draft is refused, and the reason names the time', () => {
  const at = new Date('2026-09-04T12:00:00Z');
  const why = sendBlockReason({ ...ok, scheduledFor: at });
  assert.match(why, /scheduled for 2026-09-04T12:00:00/);
  assert.match(why, /Unschedule it/);
});

test('a queued draft is refused', () => {
  assert.match(sendBlockReason({ ...ok, queuedAt: new Date() }), /already queued/);
});

// The scheduler sets sentAt as it goes. A draft it has already sent must
// read as sent rather than as scheduled, or the message tells somebody to
// unschedule a letter that has already left.
test('a scheduled draft that has since been sent reads as sent', () => {
  const why = sendBlockReason({ ...ok, scheduledFor: new Date(), sentAt: new Date() });
  assert.equal(why, 'Already sent.');
});

test('the existing guards still fire', () => {
  assert.match(sendBlockReason({ ...ok, rejectedAt: new Date() }), /rejected/);
  assert.match(sendBlockReason({ ...ok, screenedAt: null }), /screened/);
  assert.match(sendBlockReason({ ...ok, screenRisk: 'prohibited' }), /compliance screen/);
  assert.equal(sendBlockReason(null), 'No such draft');
});
