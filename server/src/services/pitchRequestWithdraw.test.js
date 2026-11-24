import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_CLOCK_SLACK_MS,
  meetingTime,
  pitchMadeByApproval,
  withdrawRefusal,
} from './pitchRequestWithdraw.js';

const decidedAt = '2026-11-24T20:46:18.287Z';
const approved = {
  id: 8,
  status: 'Approved',
  ticker: 'TEST',
  requesterId: 16,
  requester: { name: 'Sander Olinick' },
  proposedDate: '2026-12-02T00:00:00.000Z',
  proposedStartTime: '13:50',
  presidentDecidedAt: decidedAt,
};
const madeWithIt = {
  id: 35,
  date: '2026-12-02T18:50:00.000Z',
  createdAt: '2026-11-24T20:46:18.301Z',
  votingSessionCount: 0,
};
const before = new Date('2026-11-24T21:00:00Z');

test('the pitch written in the approval transaction is the approval’s to take back', () => {
  assert.equal(pitchMadeByApproval(madeWithIt, approved), true);
  // A little clock disagreement between the decision and the insert.
  const skewed = { ...madeWithIt, createdAt: new Date(Date.parse(decidedAt) - 30_000) };
  assert.equal(pitchMadeByApproval(skewed, approved), true);
});

test('a pitch that was on the calendar first stays on it', () => {
  // Scheduled by hand two days earlier, then adopted by the approval.
  const byHand = { ...madeWithIt, createdAt: '2026-11-22T15:00:00Z' };
  assert.equal(pitchMadeByApproval(byHand, approved), false);
  // Written by the boot backfill long after an old approval. Back then
  // presidents scheduled these by hand, so it may be adopting one.
  const backfilled = { ...madeWithIt, createdAt: '2026-11-30T09:00:00Z' };
  assert.equal(pitchMadeByApproval(backfilled, approved), false);
  const edge = {
    ...madeWithIt,
    createdAt: new Date(Date.parse(decidedAt) + APPROVAL_CLOCK_SLACK_MS + 1),
  };
  assert.equal(pitchMadeByApproval(edge, approved), false);
});

test('without both clocks nothing is claimed', () => {
  assert.equal(pitchMadeByApproval(null, approved), false);
  assert.equal(pitchMadeByApproval(madeWithIt, { ...approved, presidentDecidedAt: null }), false);
  assert.equal(pitchMadeByApproval({ ...madeWithIt, createdAt: 'not a date' }, approved), false);
});

test('the meeting is the pitch’s clock, else the lunch that was picked', () => {
  const moved = { ...madeWithIt, date: '2026-12-03T17:00:00.000Z' };
  assert.equal(meetingTime(approved, moved).toISOString(), '2026-12-03T17:00:00.000Z');
  // 1:50 PM in New York on December 2.
  assert.equal(meetingTime(approved, null).toISOString(), '2026-12-02T18:50:00.000Z');
});

test('an approval for a meeting still ahead can be withdrawn', () => {
  assert.equal(withdrawRefusal(approved, madeWithIt, before), null);
});

test('only an approved request can be withdrawn', () => {
  assert.match(withdrawRefusal({ ...approved, status: 'Pending' }, madeWithIt, before), /Only an approved/);
  assert.match(withdrawRefusal({ ...approved, status: 'Declined' }, null, before), /Only an approved/);
  assert.match(withdrawRefusal(null, null, before), /Only an approved/);
});

test('a vote on the pitch makes the approval part of the record', () => {
  const voted = { ...madeWithIt, votingSessionCount: 1 };
  assert.match(withdrawRefusal(approved, voted, before), /vote has already been opened/);
});

test('a meeting that has started is history', () => {
  const during = new Date('2026-12-02T18:50:00.000Z');
  assert.match(withdrawRefusal(approved, madeWithIt, during), /already happened/);
  assert.match(withdrawRefusal(approved, madeWithIt, new Date('2026-12-05T12:00:00Z')), /already happened/);
});
