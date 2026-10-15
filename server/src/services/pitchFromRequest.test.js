import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easternDateKey } from './easternTime.js';
import {
  pitchFieldsFromRequest,
  pickExistingPitch,
  requestDayKey,
  shouldMaterialize,
} from './pitchFromRequest.js';

const REQUEST = {
  id: 7,
  status: 'Approved',
  pitchId: null,
  requesterId: 4,
  requester: { name: 'Ada Lovelace' },
  pmId: 9,
  ticker: 'ait',
  proposedDate: '2026-10-15T00:00:00.000Z',
  proposedStartTime: '12:15',
  room: 'LIBRARY',
  deckRef: 'onedrive:deck-1',
  industryId: 3,
};

test('the meeting is the New York lunch on the day that was picked', () => {
  const fields = pitchFieldsFromRequest(REQUEST);
  // 12:15 PM EDT is 16:15 UTC. The stored date is UTC midnight, which
  // Eastern reads as the previous evening — the pitch must not move
  // to October 14.
  assert.equal(easternDateKey(new Date(REQUEST.proposedDate)), '2026-10-14');
  assert.equal(fields.date.toISOString(), '2026-10-15T16:15:00.000Z');
  assert.equal(easternDateKey(fields.date), '2026-10-15');
  assert.equal(fields.dayKey, '2026-10-15');
});

test('a winter lunch is five hours from UTC, not four', () => {
  const fields = pitchFieldsFromRequest({
    ...REQUEST,
    proposedDate: '2026-11-16',
    proposedStartTime: '12:00',
  });
  assert.equal(fields.date.toISOString(), '2026-11-16T17:00:00.000Z');
});

test('the pitch is the requester, with the PM beside them', () => {
  const fields = pitchFieldsFromRequest(REQUEST);
  assert.equal(fields.ticker, 'AIT');
  assert.equal(fields.pitcherName, 'Ada Lovelace');
  assert.equal(fields.location, 'Library (near smart board / printers)');
  assert.equal(fields.slideshowUrl, 'onedrive:deck-1');
  assert.equal(fields.industryId, 3);
  assert.deepEqual(fields.presenterIds, [4, 9]);
});

test('the requester is not listed twice when they lead the pod', () => {
  const fields = pitchFieldsFromRequest({ ...REQUEST, pmId: 4 });
  assert.deepEqual(fields.presenterIds, [4]);
});

test('a day with no start time lands at noon, not the previous evening', () => {
  const fields = pitchFieldsFromRequest({
    ...REQUEST,
    proposedStartTime: null,
  });
  assert.equal(fields.date.toISOString(), '2026-10-15T16:00:00.000Z');
  assert.equal(easternDateKey(fields.date), '2026-10-15');
});

test('a request with no date keeps the moment it was approved', () => {
  const decided = new Date('2026-10-15T18:00:00.000Z');
  const fields = pitchFieldsFromRequest({
    ...REQUEST,
    proposedDate: null,
    proposedStartTime: null,
    presidentDecidedAt: decided,
  });
  assert.equal(fields.date.toISOString(), decided.toISOString());
  assert.equal(fields.dayKey, null);
  assert.equal(requestDayKey(null), null);
  assert.equal(requestDayKey('not-a-date'), null);
});

test('only an approved request that is not already a pitch is materialized', () => {
  assert.equal(shouldMaterialize(REQUEST), true);
  assert.equal(shouldMaterialize({ ...REQUEST, status: 'Pending' }), false);
  assert.equal(shouldMaterialize({ ...REQUEST, status: 'Declined' }), false);
  assert.equal(shouldMaterialize({ ...REQUEST, pitchId: 12 }), false);
});

test('an unlinked pitch on the same New York day is the one to reuse', () => {
  const fields = pitchFieldsFromRequest(REQUEST);
  const handScheduled = {
    id: 2,
    date: new Date('2026-10-15T16:30:00.000Z'),
    linked: false,
  };
  const alreadyLinked = {
    id: 1,
    date: new Date('2026-10-15T16:10:00.000Z'),
    linked: true,
  };
  const otherDay = {
    id: 3,
    date: new Date('2026-10-16T16:15:00.000Z'),
    linked: false,
  };
  const picked = pickExistingPitch(fields.date, fields.dayKey, [
    otherDay,
    alreadyLinked,
    handScheduled,
  ]);
  assert.equal(picked.id, 2);
});

test('two unlinked pitches the same day: the closer start time wins', () => {
  const target = new Date('2026-10-15T16:15:00.000Z');
  const earlier = { id: 8, date: new Date('2026-10-15T16:00:00.000Z'), linked: false };
  const closer = { id: 4, date: new Date('2026-10-15T16:20:00.000Z'), linked: false };
  const picked = pickExistingPitch(target, '2026-10-15', [earlier, closer]);
  assert.equal(picked.id, 4);
});

test('nothing to reuse when the day does not match or every pitch is taken', () => {
  const target = new Date('2026-10-15T16:15:00.000Z');
  assert.equal(
    pickExistingPitch(target, '2026-10-15', [
      { id: 1, date: target, linked: true },
    ]),
    null
  );
  assert.equal(pickExistingPitch(target, null, []), null);
});
