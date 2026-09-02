import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessTarget, assessOutreach, workingDaysBetween, addWorkingDays, isWorkingDay,
} from './followUp.js';

const sent = (at) => ({ sentAt: at });
const msg = (direction, kind, at) => ({ direction, kind, occurredAt: at });

test('the weekend is not waiting time', () => {
  // Friday the 24th to Monday the 27th is one working day, not three.
  assert.equal(workingDaysBetween('2026-07-24', '2026-07-27'), 1);
  assert.equal(workingDaysBetween('2026-07-24', '2026-07-31'), 5);
});

test('July 4th and its long weekend are skipped', () => {
  // 2026-07-04 is a Saturday, so the holiday is observed on Friday the
  // 3rd — the long weekend Thomas described.
  assert.equal(isWorkingDay('2026-07-03'), false);
  assert.equal(isWorkingDay('2026-07-06'), true);
  assert.equal(workingDaysBetween('2026-07-02', '2026-07-06'), 1);
});

test('a due date can never land on a weekend', () => {
  for (let d = 1; d <= 28; d++) {
    const from = `2026-09-${String(d).padStart(2, '0')}`;
    for (const n of [5, 8]) {
      const due = addWorkingDays(from, n);
      assert.ok(isWorkingDay(due), `${from} + ${n} landed on ${due.toISOString()}`);
    }
  }
});

test('sent Friday, still too early on Monday', () => {
  const r = assessTarget(
    { id: 1, name: 'Stamm', drafts: [sent('2026-07-24T21:00:00Z')], messages: [] },
    new Date('2026-07-27T14:00:00Z'));
  assert.equal(r.state, 'waiting');
  assert.equal(r.workingDaysWaited, 1);
  // Five working days from Friday is the following Friday.
  assert.equal(r.dueAt, '2026-07-31');
  assert.equal(r.dueDay, 'Friday');
});

test('five working days on, it is due', () => {
  const r = assessTarget(
    { id: 1, name: 'Stamm', drafts: [sent('2026-07-24T21:00:00Z')], messages: [] },
    new Date('2026-07-31T14:00:00Z'));
  assert.equal(r.state, 'due');
  assert.match(r.recommendation, /Send the follow-up/);
});

test('the ledger row a send writes is the same letter, not a chase', () => {
  // Send-all marks the draft and logs the outbound row in one transaction,
  // milliseconds apart; the sweep logs our own letter again off Gmail's
  // clock, seconds apart. Both are one letter. Troy Searles, 26 Aug 2026:
  // one email, shown as waiting for his second follow-up.
  const r = assessTarget(
    { id: 7, name: 'Searles', status: 'Contacted',
      drafts: [sent('2026-08-26T12:55:12.825Z')],
      messages: [msg('out', 'Other', '2026-08-26T12:55:12.834Z'),
                 msg('out', 'Reply', '2026-08-26T12:55:19.000Z')] },
    new Date('2026-09-02T12:00:00Z'));
  assert.equal(r.attempts, 1);
  assert.equal(r.waitTarget, 5);
  assert.equal(r.state, 'due');
  assert.match(r.recommendation, /Send the follow-up/);
});

test('a chase logged from Gmail days later still counts as one', () => {
  const r = assessTarget(
    { id: 8, name: 'Chased', status: 'Contacted',
      drafts: [sent('2026-08-17T12:05:00Z')],
      messages: [msg('out', 'Other', '2026-08-17T12:05:00.400Z'),
                 msg('out', 'Reply', '2026-08-25T13:00:00Z')] },
    new Date('2026-09-02T12:00:00Z'));
  assert.equal(r.attempts, 2);
  assert.equal(r.waitTarget, 8);
});

test('a human reply ends the chase; an auto-reply does not', () => {
  const base = { id: 2, name: 'Oran', drafts: [sent('2026-07-20T09:00:00Z')] };
  const auto = assessTarget(
    { ...base, messages: [msg('in', 'AutoReply', '2026-07-20T09:05:00Z')] },
    new Date('2026-07-30T09:00:00Z'));
  assert.notEqual(auto.state, 'answered');
  assert.equal(auto.autoReplyReset, true);

  const real = assessTarget(
    { ...base, messages: [msg('in', 'Interested', '2026-07-22T09:00:00Z')] },
    new Date('2026-07-30T09:00:00Z'));
  assert.equal(real.state, 'owed');
});

test('a bounce asks for a new address, never another send', () => {
  const r = assessTarget(
    { id: 3, name: 'Bad', drafts: [sent('2026-07-01T09:00:00Z')],
      messages: [msg('in', 'Bounce', '2026-07-01T09:01:00Z')] },
    new Date('2026-07-30T09:00:00Z'));
  assert.equal(r.state, 'bounced');
  assert.match(r.recommendation, /another route/);
});

test('two unanswered chases is an answer', () => {
  const r = assessTarget(
    { id: 4, name: 'Quiet',
      drafts: [sent('2026-06-01T09:00:00Z')],
      messages: [msg('out', 'FollowUp', '2026-06-08T09:00:00Z'),
                 msg('out', 'FollowUp', '2026-06-18T09:00:00Z')] },
    new Date('2026-07-30T09:00:00Z'));
  assert.equal(r.state, 'exhausted');
});

test('a declined target is never chased', () => {
  const r = assessTarget(
    { id: 5, name: 'No', status: 'Declined', drafts: [sent('2026-06-01T09:00:00Z')], messages: [] },
    new Date('2026-07-30T09:00:00Z'));
  assert.equal(r.state, 'closed');
  assert.equal(r.recommendation, null);
});

test('nothing sent is not a follow-up', () => {
  const r = assessTarget({ id: 6, name: 'New', drafts: [], messages: [] }, new Date());
  assert.equal(r.state, 'none');
});

test('the queue counts what is actionable and when the next one lands', () => {
  const now = new Date('2026-07-31T14:00:00Z');
  const out = assessOutreach([
    { id: 1, name: 'Due', drafts: [sent('2026-07-24T09:00:00Z')], messages: [] },
    { id: 2, name: 'Waiting', drafts: [sent('2026-07-30T09:00:00Z')], messages: [] },
    { id: 3, name: 'Answered', drafts: [sent('2026-07-01T09:00:00Z')],
      messages: [msg('in', 'Interested', '2026-07-02T09:00:00Z'),
                 msg('out', 'Reply', '2026-07-03T09:00:00Z')] },
  ], now);
  assert.equal(out.dueNow, 1);
  assert.equal(out.counts.answered, 1);
  assert.equal(out.nextDueAt, '2026-08-06');
});
