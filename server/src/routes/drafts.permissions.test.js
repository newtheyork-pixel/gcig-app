import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHandler, queueHandler } from './drafts.js';

// A live two-manager draft, first pick on the clock for user 10.
// The handlers are driven with this object and a write spy, so a
// refusal is visible as "the write was never called" rather than as
// a status code that a later bug could return after saving.
function liveDraft() {
  return {
    status: 'live',
    pickIndex: 0,
    rounds: 1,
    snake: true,
    pickSeconds: 30,
    clockEndsAt: new Date(Date.now() + 60_000),
    seats: [
      { slot: 0, userId: 10, user: { id: 10, name: 'Ada', role: 'PortfolioManager' } },
      { slot: 1, userId: 11, user: { id: 11, name: 'Ben', role: 'PortfolioManager' } },
    ],
    pool: [{ userId: 20 }, { userId: 21 }],
    picks: [],
    queue: [],
    analysts: [
      { id: 20, name: 'Cara', hitRate: 0, buys: 0 },
      { id: 21, name: 'Dee', hitRate: 0.5, buys: 1 },
    ],
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function deps(draft, writes) {
  return {
    load: async () => draft,
    commitPick: async () => {
      writes.pick = true;
    },
    saveQueue: async () => {
      writes.queue = true;
    },
    present: async () => ({ ok: true }),
  };
}

async function pick(user, analystId = 20, draft = liveDraft()) {
  const writes = { pick: false, queue: false };
  const res = fakeRes();
  await pickHandler(
    { params: { id: '4' }, body: { analystId }, user },
    res,
    deps(draft, writes)
  );
  return { res, writes };
}

test('an analyst watching the room cannot pick', async () => {
  const { res, writes } = await pick({ id: 20, role: 'Analyst' });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /on the clock/);
  assert.equal(writes.pick, false);
});

test('a portfolio manager who is not on the clock cannot pick', async () => {
  const { res, writes } = await pick({ id: 11, role: 'PortfolioManager' });
  assert.equal(res.statusCode, 403);
  assert.equal(writes.pick, false);
});

test('the portfolio manager on the clock can pick', async () => {
  const { res, writes } = await pick({ id: 10, role: 'PortfolioManager' });
  assert.equal(res.statusCode, 200);
  assert.equal(writes.pick, true);
});

test('an admin can assign the pick, including while the clock is paused', async () => {
  const paused = liveDraft();
  paused.status = 'paused';
  const { res, writes } = await pick({ id: 1, role: 'President' }, 21, paused);
  assert.equal(res.statusCode, 200);
  assert.equal(writes.pick, true);
});

test('the on-clock manager cannot pick while the draft is paused', async () => {
  const paused = liveDraft();
  paused.status = 'paused';
  const { res, writes } = await pick({ id: 10, role: 'PortfolioManager' }, 20, paused);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /paused/);
  assert.equal(writes.pick, false);
});

test('a junior analyst cannot rank a portfolio manager queue', async () => {
  const writes = { pick: false, queue: false };
  const res = fakeRes();
  await queueHandler(
    {
      params: { id: '4' },
      body: { pmId: 10, analystIds: [20, 21] },
      user: { id: 30, role: 'JuniorAnalyst' },
    },
    res,
    deps(liveDraft(), writes)
  );
  assert.equal(res.statusCode, 403);
  assert.equal(writes.queue, false);
});

test('another portfolio manager cannot rewrite the queue', async () => {
  const writes = { pick: false, queue: false };
  const res = fakeRes();
  await queueHandler(
    {
      params: { id: '4' },
      body: { pmId: 10, analystIds: [21] },
      user: { id: 11, role: 'PortfolioManager' },
    },
    res,
    deps(liveDraft(), writes)
  );
  assert.equal(res.statusCode, 403);
  assert.equal(writes.queue, false);
});

test('the portfolio manager on a seat can save their own queue', async () => {
  const writes = { pick: false, queue: false };
  const res = fakeRes();
  await queueHandler(
    {
      params: { id: '4' },
      body: { analystIds: [21, 20] },
      user: { id: 10, role: 'PortfolioManager' },
    },
    res,
    deps(liveDraft(), writes)
  );
  assert.equal(res.statusCode, 200);
  assert.equal(writes.queue, true);
});
