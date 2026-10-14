import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrder,
  chooseAutoPick,
  decideExpiry,
  canMakePick,
  pickDecision,
  canEditQueue,
  queueDecision,
  isDraftAdmin,
  validateSetup,
  selectPodRosters,
  toExpiryState,
  afterPick,
  collectTracks,
} from './analystDraft.js';

const pm = (id) => ({ id, role: 'PortfolioManager' });
const analyst = (id) => ({ id, role: 'Analyst' });
const president = { id: 1, role: 'President' };

function room({
  status = 'live',
  pickIndex = 0,
  seats = 3,
  rounds = 2,
  snake = true,
  clockEndsAt = new Date('2026-10-14T12:00:00Z'),
  pickSeconds = 30,
  available = [
    { id: 101, name: 'Amy', hitRate: 0.25, buys: 1 },
    { id: 102, name: 'Bea', hitRate: 0.8, buys: 4 },
    { id: 103, name: 'Cal', hitRate: 0, buys: 0 },
    { id: 104, name: 'Dee', hitRate: 0.5, buys: 1 },
  ],
  queue = [],
} = {}) {
  const seatRows = Array.from({ length: seats }, (_, slot) => ({
    slot,
    userId: 10 + slot,
  }));
  const draft = {
    status,
    pickIndex,
    rounds,
    snake,
    clockEndsAt,
    pickSeconds,
    seats: seatRows,
    pool: available.map((a) => ({ userId: a.id })),
    picks: [],
    queue,
  };
  return toExpiryState(draft, available);
}

test('snake order reverses every other round', () => {
  const order = buildOrder(3, 2, true);
  assert.deepEqual(
    order.map((p) => p.slot + 1),
    [1, 2, 3, 3, 2, 1]
  );
  assert.deepEqual(
    order.map((p) => p.round),
    [1, 1, 1, 2, 2, 2]
  );
  assert.equal(order[3].slotInRound, 1);
  assert.equal(order[3].pickNumber, 4);
});

test('a third round starts again at the front of the order', () => {
  const slots = buildOrder(3, 3, true).map((p) => p.slot + 1);
  assert.deepEqual(slots, [1, 2, 3, 3, 2, 1, 1, 2, 3]);
});

test('turning snake off repeats the same order every round', () => {
  assert.deepEqual(
    buildOrder(3, 2, false).map((p) => p.slot + 1),
    [1, 2, 3, 1, 2, 3]
  );
});

test('one seat is the same list with or without the snake', () => {
  assert.deepEqual(buildOrder(1, 3, true).map((p) => p.slot), [0, 0, 0]);
  assert.deepEqual(buildOrder(1, 3, false).map((p) => p.slot), [0, 0, 0]);
});

test('an empty draft produces no picks', () => {
  assert.deepEqual(buildOrder(0, 4, true), []);
  assert.deepEqual(buildOrder(3, 0, true), []);
});

test('an expired clock takes the top queued analyst still available', () => {
  const state = room({
    queue: [
      { pmId: 10, analystId: 103, rank: 1 },
      { pmId: 10, analystId: 101, rank: 2 },
    ],
  });
  const decision = decideExpiry(state, new Date('2026-10-14T12:00:01Z'));
  assert.equal(decision.kind, 'pick');
  assert.equal(decision.analystId, 103);
  assert.equal(decision.source, 'queue');
  assert.equal(decision.pmId, 10);
  assert.equal(decision.pickNumber, 1);
  assert.equal(decision.next.pickIndex, 1);
  assert.equal(decision.next.status, 'live');
});

test('a queue skips names that have already been drafted', () => {
  const state = room({
    available: [
      { id: 101, name: 'Amy', hitRate: 0.25, buys: 1 },
      { id: 102, name: 'Bea', hitRate: 0.8, buys: 4 },
    ],
  });
  const choice = chooseAutoPick([999, 101], state.available);
  assert.deepEqual(choice, { analystId: 101, source: 'queue' });
});

test('an empty queue takes the best record, then the most buys, then the name', () => {
  const available = [
    { id: 1, name: 'Zoe', hitRate: 0.5, buys: 1 },
    { id: 2, name: 'Amy', hitRate: 0.5, buys: 2 },
    { id: 3, name: 'Bea', hitRate: 0.8, buys: 4 },
    { id: 4, name: 'Cal', hitRate: 0, buys: 0 },
    { id: 5, name: 'Ada', hitRate: 0, buys: 0 },
  ];
  assert.equal(chooseAutoPick([], available).analystId, 3);
  assert.equal(chooseAutoPick([], available).source, 'auto');
  const tied = available.filter((a) => a.hitRate === 0.5);
  assert.equal(chooseAutoPick([], tied).analystId, 2);
  const blanks = available.filter((a) => a.hitRate === 0);
  assert.equal(chooseAutoPick([], blanks).analystId, 5);
});

test('a paused clock does not auto-pick', () => {
  const state = room({ status: 'paused', clockEndsAt: null });
  assert.equal(decideExpiry(state, new Date('2026-10-14T13:00:00Z')), null);
});

test('a clock that has not run out does not auto-pick', () => {
  const state = room({ clockEndsAt: new Date('2026-10-14T12:02:00Z') });
  assert.equal(decideExpiry(state, new Date('2026-10-14T12:01:00Z')), null);
});

test('the moment the clock hits zero, the pick is due', () => {
  const at = new Date('2026-10-14T12:00:00Z');
  const state = room({ clockEndsAt: at, queue: [{ pmId: 10, analystId: 101, rank: 1 }] });
  const decision = decideExpiry(state, at);
  assert.equal(decision.kind, 'pick');
  assert.equal(decision.analystId, 101);
});

test('a long outage catches up one pick per timer', () => {
  const start = new Date('2026-10-14T12:00:00Z');
  const wall = new Date(start.getTime() + 125_000);
  let state = room({
    seats: 2,
    rounds: 4,
    clockEndsAt: start,
    pickSeconds: 30,
    available: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({
      id,
      name: `A${id}`,
      hitRate: 0,
      buys: 0,
    })),
  });
  const picks = [];
  for (let i = 0; i < 12; i++) {
    const decision = decideExpiry(state, wall);
    if (!decision || decision.kind !== 'pick') break;
    picks.push(decision);
    state = {
      ...state,
      pickIndex: decision.next.pickIndex,
      status: decision.next.status,
      clockEndsAt: decision.next.clockEndsAt,
      available: state.available.filter((a) => a.id !== decision.analystId),
    };
  }
  // Clocks due at t, t+30, t+60, t+90 and t+120. t+150 is still ahead.
  assert.equal(picks.length, 5);
  assert.equal(state.status, 'live');
  assert.ok(state.clockEndsAt.getTime() > wall.getTime());
  assert.deepEqual(
    picks.map((p) => p.pmId),
    [10, 11, 11, 10, 10]
  );
});

test('the last available analyst completes the draft', () => {
  const state = room({
    seats: 2,
    rounds: 3,
    available: [{ id: 7, name: 'Only', hitRate: 0, buys: 0 }],
  });
  const decision = decideExpiry(state, new Date('2026-10-14T12:00:01Z'));
  assert.equal(decision.kind, 'pick');
  assert.equal(decision.next.status, 'complete');
  assert.equal(decision.next.clockEndsAt, null);
});

test('an expired clock with nobody left completes without a pick', () => {
  const state = room({ available: [] });
  const decision = decideExpiry(state, new Date('2026-10-14T12:00:01Z'));
  assert.deepEqual(decision, { kind: 'complete' });
});

test('only the portfolio manager on the clock, or an admin, can pick', () => {
  assert.equal(canMakePick({ user: analyst(20), status: 'live', onClockUserId: 10 }), false);
  assert.equal(canMakePick({ user: pm(11), status: 'live', onClockUserId: 10 }), false);
  assert.equal(canMakePick({ user: pm(10), status: 'live', onClockUserId: 10 }), true);
  assert.equal(canMakePick({ user: president, status: 'live', onClockUserId: 10 }), true);
  assert.equal(
    canMakePick({
      user: { id: 9, role: 'JuniorAnalyst', isSuperAdmin: true },
      status: 'live',
      onClockUserId: 10,
    }),
    true
  );
  assert.equal(canMakePick({ user: pm(10), status: 'paused', onClockUserId: 10 }), false);
  assert.equal(canMakePick({ user: president, status: 'paused', onClockUserId: 10 }), true);
  assert.equal(canMakePick({ user: pm(10), status: 'complete', onClockUserId: 10 }), false);
  assert.equal(canMakePick({ user: president, status: 'setup', onClockUserId: null }), false);

  const pool = [101, 102];
  const blocked = pickDecision({
    user: analyst(20),
    status: 'live',
    onClockUserId: 10,
    analystId: 101,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(blocked.status, 403);
  assert.match(blocked.error, /on the clock/);

  const otherPm = pickDecision({
    user: pm(11),
    status: 'live',
    onClockUserId: 10,
    analystId: 101,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(otherPm.status, 403);

  const pausedPm = pickDecision({
    user: pm(10),
    status: 'paused',
    onClockUserId: 10,
    analystId: 101,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(pausedPm.status, 403);
  assert.match(pausedPm.error, /paused/);

  const allowed = pickDecision({
    user: pm(10),
    status: 'live',
    onClockUserId: 10,
    analystId: 101,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.source, 'board');
  assert.equal(allowed.pmId, 10);

  const assigned = pickDecision({
    user: president,
    status: 'paused',
    onClockUserId: 10,
    analystId: 102,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.source, 'admin');

  const taken = pickDecision({
    user: pm(10),
    status: 'live',
    onClockUserId: 10,
    analystId: 101,
    poolIds: pool,
    takenIds: [101],
  });
  assert.equal(taken.status, 409);

  const outsider = pickDecision({
    user: pm(10),
    status: 'live',
    onClockUserId: 10,
    analystId: 999,
    poolIds: pool,
    takenIds: [],
  });
  assert.equal(outsider.status, 400);
});

test('draft controls belong to the president, the director of research, the CIO, and the owner', () => {
  assert.equal(isDraftAdmin(president), true);
  assert.equal(isDraftAdmin({ role: 'DirectorOfResearch' }), true);
  assert.equal(isDraftAdmin({ role: 'CIO' }), true);
  assert.equal(isDraftAdmin({ role: 'JuniorAnalyst', isSuperAdmin: true }), true);
  assert.equal(isDraftAdmin(pm(10)), false);
  assert.equal(isDraftAdmin(analyst(20)), false);
  assert.equal(isDraftAdmin(null), false);
});

test('a portfolio manager ranks only their own queue, and not after the draft', () => {
  assert.equal(canEditQueue({ user: pm(10), status: 'live', seatUserId: 10 }), true);
  assert.equal(canEditQueue({ user: pm(11), status: 'live', seatUserId: 10 }), false);
  assert.equal(canEditQueue({ user: analyst(20), status: 'live', seatUserId: 10 }), false);
  assert.equal(canEditQueue({ user: president, status: 'live', seatUserId: 10 }), true);
  assert.equal(canEditQueue({ user: pm(10), status: 'complete', seatUserId: 10 }), false);
  const denied = queueDecision({
    user: analyst(20),
    status: 'live',
    seatUserId: 10,
    analystIds: [101],
    poolIds: [101],
  });
  assert.equal(denied.status, 403);
});

test('setup rejects a one-manager draft and a timer outside the band', () => {
  const bad = validateSetup({
    name: 'Fall',
    rounds: 2,
    pickSeconds: 5,
    pmIds: [1],
    analystIds: [2],
  });
  assert.equal(bad.ok, false);
  const ok = validateSetup({
    name: 'Fall 2026',
    rounds: 3,
    pmIds: [2, 3],
    analystIds: [4, 5],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.pickSeconds, 30);
  assert.equal(ok.value.snake, true);
});

test('a pick made while paused banks a full clock and stays paused', () => {
  const next = afterPick({
    pickIndex: 0,
    orderLength: 4,
    availableCount: 4,
    pickSeconds: 30,
    now: new Date('2026-10-14T12:00:00Z'),
    paused: true,
  });
  assert.equal(next.status, 'paused');
  assert.equal(next.clockEndsAt, null);
  assert.equal(next.pausedRemainingMs, 30_000);
});

test('the newest completed draft owns the pod, and an analyst is only on one', () => {
  const map = selectPodRosters([
    {
      id: 1,
      status: 'complete',
      completedAt: 100,
      pmIds: [10, 11],
      picks: [
        { pmId: 10, analystId: 101, pickNumber: 1 },
        { pmId: 11, analystId: 102, pickNumber: 2 },
      ],
    },
    {
      id: 2,
      status: 'complete',
      completedAt: 200,
      pmIds: [10],
      picks: [{ pmId: 10, analystId: 102, pickNumber: 1 }],
    },
    {
      id: 3,
      status: 'live',
      completedAt: 300,
      pmIds: [11],
      picks: [{ pmId: 11, analystId: 103, pickNumber: 1 }],
    },
  ]);
  assert.deepEqual(map.get(10).analystIds, [102]);
  assert.equal(map.get(10).draftId, 2);
  // 102 moved to the later draft, so the earlier pod loses them.
  assert.deepEqual(map.get(11).analystIds, []);
  assert.equal(map.has(11), true);
});

test('a pitch filed only under the pitcher name still belongs to that member', () => {
  const users = [
    { id: 20, name: 'Carter Bayard' },
    { id: 21, name: 'August Potter' },
  ];
  const tracks = collectTracks(users, [
    {
      id: 1,
      pitcherName: 'Carter Bayard',
      presenterIds: [],
      votedOutcome: 'Buy',
      industryName: '',
    },
    {
      id: 2,
      pitcherName: 'Carter Bayard, August Potter',
      presenterIds: [],
      votedOutcome: 'NoBuy',
      industryName: 'Technology',
    },
    {
      id: 3,
      pitcherName: 'Technology pod',
      presenterIds: [21],
      votedOutcome: null,
      industryName: 'Technology',
    },
    {
      id: 1,
      pitcherName: 'Carter Bayard',
      presenterIds: [20],
      votedOutcome: 'Buy',
      industryName: '',
    },
    {
      id: 4,
      pitcherName: 'Carter Bayard',
      presenterIds: [],
      votedOutcome: 'Buy',
      industryName: 'SEG historical',
    },
  ]);
  const carter = tracks.get(20);
  assert.equal(carter.pitches, 2);
  assert.equal(carter.buys, 1);
  assert.equal(carter.decided, 2);
  const august = tracks.get(21);
  assert.equal(august.pitches, 2);
  assert.equal(august.decided, 1);
  assert.equal(august.buys, 0);
});
