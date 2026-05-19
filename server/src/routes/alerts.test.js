import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, {
  ownedAlert,
  listAlertsHandler,
  createAlertHandler,
  deleteAlertHandler,
  toggleAlertHandler,
  firedAlertHandler,
  MAX_ACTIVE_ALERTS,
} from './alerts.js';

// Same harness-free precedent watchlist.test.js / terminal.quotes.test.js
// follow: no supertest in the repo, so each exported handler is driven
// directly with a minimal fake req/res and an injected prisma-like
// stub — never a real DB. The stub models only the WatchlistAlert
// surface alerts.js touches, scoped enough to exercise the owned-check
// security invariant, the per-user scoping, validation, the active
// cap, the one-shot /fired (lastFiredAt + active=false, idempotent)
// and the never-5xx contract.

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

// A tiny in-memory Prisma double. Models watchlistAlert.{findMany,
// findUnique,count,create,update,delete}. Ids autoincrement; createdAt
// is monotonic so ordering is deterministic. A fixed `now` is injected
// so /fired's lastFiredAt is assertable without a real clock. `failOn`
// forces a thrown rejection from any one method to prove the
// never-5xx try/catch.
function makeDb(seed = {}, opts = {}) {
  const state = {
    alerts: [], // { id, userId, ticker, metric, direction, threshold,
    //               active, lastFiredAt, createdAt }
    seq: 1,
    clock: 1,
  };
  for (const a of seed.alerts || []) {
    state.alerts.push({
      id: a.id ?? state.seq++,
      userId: a.userId,
      ticker: a.ticker,
      metric: a.metric ?? 'price',
      direction: a.direction ?? 'above',
      threshold: a.threshold ?? 100,
      active: a.active ?? true,
      lastFiredAt: a.lastFiredAt ?? null,
      createdAt: a.createdAt ?? state.clock++,
    });
    if (a.id != null && a.id >= state.seq) state.seq = a.id + 1;
  }

  const failOn = opts.failOn || null;
  const maybeFail = (key) => {
    if (failOn === key) throw new Error(`stub forced failure: ${key}`);
  };

  return {
    _state: state,
    watchlistAlert: {
      async findMany({ where, orderBy } = {}) {
        maybeFail('watchlistAlert.findMany');
        let rows = state.alerts.filter((a) =>
          where?.userId != null ? a.userId === where.userId : true
        );
        if (orderBy?.createdAt === 'asc') {
          rows = rows.slice().sort((a, b) => a.createdAt - b.createdAt);
        }
        return rows.map((a) => ({ ...a }));
      },
      async findUnique({ where } = {}) {
        maybeFail('watchlistAlert.findUnique');
        const a = state.alerts.find((x) => x.id === where.id);
        return a ? { ...a } : null;
      },
      async count({ where } = {}) {
        maybeFail('watchlistAlert.count');
        return state.alerts.filter(
          (a) =>
            (where?.userId == null || a.userId === where.userId) &&
            (where?.active == null || a.active === where.active)
        ).length;
      },
      async create({ data } = {}) {
        maybeFail('watchlistAlert.create');
        const row = {
          id: state.seq++,
          userId: data.userId,
          ticker: data.ticker,
          metric: data.metric,
          direction: data.direction,
          threshold: data.threshold,
          active: data.active ?? true,
          lastFiredAt: data.lastFiredAt ?? null,
          createdAt: state.clock++,
        };
        state.alerts.push(row);
        return { ...row };
      },
      async update({ where, data } = {}) {
        maybeFail('watchlistAlert.update');
        const a = state.alerts.find((x) => x.id === where.id);
        if (!a) {
          const e = new Error('Record to update not found');
          e.code = 'P2025';
          throw e;
        }
        if (data.active !== undefined) a.active = data.active;
        if (data.lastFiredAt !== undefined) a.lastFiredAt = data.lastFiredAt;
        return { ...a };
      },
      async delete({ where } = {}) {
        maybeFail('watchlistAlert.delete');
        const idx = state.alerts.findIndex((x) => x.id === where.id);
        if (idx === -1) {
          const e = new Error('Record to delete does not exist');
          e.code = 'P2025';
          throw e;
        }
        const [removed] = state.alerts.splice(idx, 1);
        return { ...removed };
      },
    },
  };
}

const asUser = (id) => ({ user: { id } });
const NOW = new Date('2026-05-18T15:30:00.000Z');

// ── The security invariant ─────────────────────────────────────────
// Same load-bearing contract Watchlist's ownedList carries: every
// read/mutation is scoped by req.user.id, and any operation on an
// alert id whose userId !== req.user.id is a 404 — indistinguishable
// from a missing row, never revealing or touching another user's data.
// This must hold across DELETE / PATCH / POST-fired, by id.

test('ownedAlert: returns the alert only when it belongs to the user', async () => {
  const db = makeDb({ alerts: [{ id: 7, userId: 1, ticker: 'AAPL' }] });
  const mine = await ownedAlert(db, 1, 7);
  assert.equal(mine?.id, 7);
  // Another user for the same id → null; a missing id → null. Same
  // answer: the caller turns both into a 404, so a prober can't tell
  // "not yours" from "doesn't exist".
  assert.equal(await ownedAlert(db, 2, 7), null);
  assert.equal(await ownedAlert(db, 1, 999), null);
});

test("security: GET only ever returns the caller's own alerts", async () => {
  const db = makeDb({
    alerts: [
      { id: 1, userId: 1, ticker: 'AAA' },
      { id: 2, userId: 2, ticker: 'BBB' },
    ],
  });
  const res = fakeRes();
  await listAlertsHandler({ ...asUser(2) }, res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].ticker, 'BBB');
  assert.ok(
    !res.body.alerts.some((a) => a.ticker === 'AAA'),
    "must never surface another user's alert"
  );
});

test('security: user B cannot delete / toggle / fire user A\'s alert (404, untouched)', async () => {
  const seed = {
    alerts: [
      {
        id: 10,
        userId: 1,
        ticker: 'AAPL',
        metric: 'price',
        direction: 'above',
        threshold: 190,
        active: true,
        lastFiredAt: null,
      },
    ],
  };

  // DELETE another user's alert by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await deleteAlertHandler(
      { ...asUser(2), params: { id: '10' } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.ok(
      db._state.alerts.some((a) => a.id === 10),
      'victim alert must still exist'
    );
  }

  // PATCH (toggle active) another user's alert by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await toggleAlertHandler(
      { ...asUser(2), params: { id: '10' }, body: { active: false } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.equal(
      db._state.alerts.find((a) => a.id === 10).active,
      true,
      "victim alert's active flag must be untouched"
    );
  }

  // POST /:id/fired on another user's alert by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await firedAlertHandler(
      { ...asUser(2), params: { id: '10' } },
      res,
      db,
      () => NOW
    );
    assert.equal(res.statusCode, 404);
    const v = db._state.alerts.find((a) => a.id === 10);
    assert.equal(v.active, true, 'victim must not be deactivated');
    assert.equal(v.lastFiredAt, null, 'victim must not be stamped fired');
  }
});

// ── GET ────────────────────────────────────────────────────────────

test('GET returns the caller alerts ordered by createdAt', async () => {
  const db = makeDb({
    alerts: [
      { id: 1, userId: 9, ticker: 'AAA', createdAt: 2 },
      { id: 2, userId: 9, ticker: 'BBB', createdAt: 1 },
      { id: 3, userId: 5, ticker: 'CCC', createdAt: 3 },
    ],
  });
  const res = fakeRes();
  await listAlertsHandler({ ...asUser(9) }, res, db);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.alerts.map((a) => a.ticker),
    ['BBB', 'AAA']
  );
});

// ── POST: validation, cap, normalization ───────────────────────────

test('POST creates a valid alert, uppercases the ticker, returns the full set', async () => {
  const db = makeDb({ alerts: [] });
  const res = fakeRes();
  await createAlertHandler(
    {
      ...asUser(1),
      body: {
        ticker: ' aapl ',
        metric: 'price',
        direction: 'above',
        threshold: 190.5,
      },
    },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  const row = db._state.alerts[0];
  assert.equal(row.ticker, 'AAPL', 'ticker stored upper-cased + trimmed');
  assert.equal(row.metric, 'price');
  assert.equal(row.direction, 'above');
  assert.equal(row.threshold, 190.5);
  assert.equal(row.active, true, 'a new alert is armed');
  assert.ok(
    res.body.alerts.some((a) => a.ticker === 'AAPL'),
    'response carries the full {alerts}'
  );
});

test('POST accepts the pct metric and a negative threshold (down-move alert)', async () => {
  const db = makeDb({ alerts: [] });
  const res = fakeRes();
  await createAlertHandler(
    {
      ...asUser(1),
      body: {
        ticker: 'TSLA',
        metric: 'pct',
        direction: 'below',
        threshold: -3,
      },
    },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.equal(db._state.alerts[0].metric, 'pct');
  assert.equal(db._state.alerts[0].threshold, -3);
});

test('POST rejects a bad metric (4xx), nothing written', async () => {
  for (const metric of ['volume', '', null, undefined, 'PRICE ']) {
    const db = makeDb({ alerts: [] });
    const res = fakeRes();
    await createAlertHandler(
      {
        ...asUser(1),
        body: { ticker: 'AAPL', metric, direction: 'above', threshold: 1 },
      },
      res,
      db
    );
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `metric=${JSON.stringify(metric)} must be a 4xx`
    );
    assert.equal(db._state.alerts.length, 0);
  }
});

test('POST rejects a bad direction (4xx), nothing written', async () => {
  for (const direction of ['up', 'down', '', null, 'ABOVE ']) {
    const db = makeDb({ alerts: [] });
    const res = fakeRes();
    await createAlertHandler(
      {
        ...asUser(1),
        body: { ticker: 'AAPL', metric: 'price', direction, threshold: 1 },
      },
      res,
      db
    );
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `direction=${JSON.stringify(direction)} must be a 4xx`
    );
    assert.equal(db._state.alerts.length, 0);
  }
});

test('POST rejects a non-finite / missing threshold (4xx), nothing written', async () => {
  for (const threshold of [undefined, null, 'abc', NaN, Infinity, -Infinity, {}]) {
    const db = makeDb({ alerts: [] });
    const res = fakeRes();
    await createAlertHandler(
      {
        ...asUser(1),
        body: { ticker: 'AAPL', metric: 'price', direction: 'above', threshold },
      },
      res,
      db
    );
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `threshold=${JSON.stringify(threshold)} must be a 4xx`
    );
    assert.equal(db._state.alerts.length, 0);
  }
});

test('POST rejects an invalid ticker (4xx), nothing written', async () => {
  for (const t of ['', '   ', 'NOT A TICKER', 'TOOOOOOOOOOOONG', '<x>']) {
    const db = makeDb({ alerts: [] });
    const res = fakeRes();
    await createAlertHandler(
      {
        ...asUser(1),
        body: { ticker: t, metric: 'price', direction: 'above', threshold: 1 },
      },
      res,
      db
    );
    assert.equal(res.statusCode, 400, `ticker=${JSON.stringify(t)}`);
    assert.equal(db._state.alerts.length, 0);
  }
});

test(`POST caps at ${MAX_ACTIVE_ALERTS} ACTIVE alerts per user (409)`, async () => {
  const alerts = Array.from({ length: MAX_ACTIVE_ALERTS }, (_, i) => ({
    id: i + 1,
    userId: 1,
    ticker: `T${i}`,
    active: true,
  }));
  const db = makeDb({ alerts });
  const res = fakeRes();
  await createAlertHandler(
    {
      ...asUser(1),
      body: {
        ticker: 'ZZZZ',
        metric: 'price',
        direction: 'above',
        threshold: 1,
      },
    },
    res,
    db
  );
  assert.equal(res.statusCode, 409, 'cap hit must be a 409');
  assert.equal(
    db._state.alerts.length,
    MAX_ACTIVE_ALERTS,
    'no row past the active cap'
  );
});

test('POST cap counts only ACTIVE alerts — inactive ones do not block a new one', async () => {
  const alerts = Array.from({ length: MAX_ACTIVE_ALERTS }, (_, i) => ({
    id: i + 1,
    userId: 1,
    ticker: `T${i}`,
    active: false, // all fired/disabled — they must not occupy the cap
  }));
  const db = makeDb({ alerts });
  const res = fakeRes();
  await createAlertHandler(
    {
      ...asUser(1),
      body: {
        ticker: 'NEW',
        metric: 'price',
        direction: 'above',
        threshold: 1,
      },
    },
    res,
    db
  );
  assert.equal(
    res.statusCode,
    200,
    'inactive alerts must not count against the active cap'
  );
  assert.equal(db._state.alerts.length, MAX_ACTIVE_ALERTS + 1);
});

test('POST cap is per-user: another user at the cap does not block me', async () => {
  const alerts = Array.from({ length: MAX_ACTIVE_ALERTS }, (_, i) => ({
    id: i + 1,
    userId: 1,
    ticker: `T${i}`,
    active: true,
  }));
  const db = makeDb({ alerts });
  const res = fakeRes();
  await createAlertHandler(
    {
      ...asUser(2),
      body: {
        ticker: 'MINE',
        metric: 'price',
        direction: 'below',
        threshold: 1,
      },
    },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.ok(db._state.alerts.some((a) => a.userId === 2));
});

// ── DELETE ─────────────────────────────────────────────────────────

test('DELETE removes an owned alert and returns the full set', async () => {
  const db = makeDb({
    alerts: [
      { id: 1, userId: 1, ticker: 'AAA' },
      { id: 2, userId: 1, ticker: 'BBB' },
    ],
  });
  const res = fakeRes();
  await deleteAlertHandler(
    { ...asUser(1), params: { id: '1' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.ok(!db._state.alerts.some((a) => a.id === 1));
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].ticker, 'BBB');
});

test('DELETE / PATCH / fired reject a non-numeric or missing id with a 4xx, no DB write', async () => {
  for (const bad of ['abc', '', undefined, '1.5', '-3']) {
    {
      const db = makeDb({ alerts: [{ id: 1, userId: 1, ticker: 'A' }] });
      const res = fakeRes();
      await deleteAlertHandler(
        { ...asUser(1), params: { id: bad } },
        res,
        db
      );
      assert.ok(
        res.statusCode >= 400 && res.statusCode < 500,
        `DELETE id=${JSON.stringify(bad)} must be a 4xx`
      );
    }
    {
      const db = makeDb({ alerts: [{ id: 1, userId: 1, ticker: 'A' }] });
      const res = fakeRes();
      await toggleAlertHandler(
        { ...asUser(1), params: { id: bad }, body: { active: false } },
        res,
        db
      );
      assert.ok(
        res.statusCode >= 400 && res.statusCode < 500,
        `PATCH id=${JSON.stringify(bad)} must be a 4xx`
      );
    }
    {
      const db = makeDb({ alerts: [{ id: 1, userId: 1, ticker: 'A' }] });
      const res = fakeRes();
      await firedAlertHandler(
        { ...asUser(1), params: { id: bad } },
        res,
        db,
        () => NOW
      );
      assert.ok(
        res.statusCode >= 400 && res.statusCode < 500,
        `fired id=${JSON.stringify(bad)} must be a 4xx`
      );
    }
  }
});

// ── PATCH: re-arm / disable ────────────────────────────────────────

test('PATCH toggles active true→false and false→true on an owned alert', async () => {
  const db = makeDb({
    alerts: [{ id: 1, userId: 1, ticker: 'AAA', active: true }],
  });
  // Disable.
  {
    const res = fakeRes();
    await toggleAlertHandler(
      { ...asUser(1), params: { id: '1' }, body: { active: false } },
      res,
      db
    );
    assert.equal(res.statusCode, 200);
    assert.equal(db._state.alerts[0].active, false);
  }
  // Re-arm.
  {
    const res = fakeRes();
    await toggleAlertHandler(
      { ...asUser(1), params: { id: '1' }, body: { active: true } },
      res,
      db
    );
    assert.equal(res.statusCode, 200);
    assert.equal(db._state.alerts[0].active, true);
  }
});

test('PATCH rejects a non-boolean active (4xx), state untouched', async () => {
  for (const active of ['yes', 1, 0, null, undefined, 'true']) {
    const db = makeDb({
      alerts: [{ id: 1, userId: 1, ticker: 'A', active: true }],
    });
    const res = fakeRes();
    await toggleAlertHandler(
      { ...asUser(1), params: { id: '1' }, body: { active } },
      res,
      db
    );
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `active=${JSON.stringify(active)} must be a 4xx`
    );
    assert.equal(db._state.alerts[0].active, true, 'state untouched');
  }
});

test('PATCH re-arm at the active cap is allowed (toggle is not a create)', async () => {
  // MAX active alerts already, plus one disabled one we re-arm. The cap
  // gate lives on POST (create); a re-arm must not be falsely blocked.
  const alerts = Array.from({ length: MAX_ACTIVE_ALERTS }, (_, i) => ({
    id: i + 1,
    userId: 1,
    ticker: `T${i}`,
    active: true,
  }));
  alerts.push({
    id: MAX_ACTIVE_ALERTS + 1,
    userId: 1,
    ticker: 'REARM',
    active: false,
  });
  const db = makeDb({ alerts });
  const res = fakeRes();
  await toggleAlertHandler(
    {
      ...asUser(1),
      params: { id: String(MAX_ACTIVE_ALERTS + 1) },
      body: { active: true },
    },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.equal(
    db._state.alerts.find((a) => a.id === MAX_ACTIVE_ALERTS + 1).active,
    true
  );
});

// ── POST /:id/fired — one-shot dedupe ──────────────────────────────

test('POST /:id/fired stamps lastFiredAt and deactivates the owned alert', async () => {
  const db = makeDb({
    alerts: [
      {
        id: 1,
        userId: 1,
        ticker: 'AAPL',
        active: true,
        lastFiredAt: null,
      },
    ],
  });
  const res = fakeRes();
  await firedAlertHandler(
    { ...asUser(1), params: { id: '1' } },
    res,
    db,
    () => NOW
  );
  assert.equal(res.statusCode, 200);
  const a = db._state.alerts[0];
  assert.equal(a.active, false, 'fired alert deactivates (one-shot)');
  assert.equal(
    +new Date(a.lastFiredAt),
    +NOW,
    'lastFiredAt stamped from the injected clock'
  );
});

test('POST /:id/fired is idempotent — a second fire is still a clean 200, still inactive', async () => {
  const db = makeDb({
    alerts: [{ id: 1, userId: 1, ticker: 'AAPL', active: true }],
  });
  const first = fakeRes();
  await firedAlertHandler(
    { ...asUser(1), params: { id: '1' } },
    first,
    db,
    () => NOW
  );
  assert.equal(first.statusCode, 200);

  const LATER = new Date('2026-05-18T16:00:00.000Z');
  const second = fakeRes();
  await firedAlertHandler(
    { ...asUser(1), params: { id: '1' } },
    second,
    db,
    () => LATER
  );
  assert.equal(second.statusCode, 200, 're-firing must not error');
  const a = db._state.alerts[0];
  assert.equal(a.active, false, 'still inactive');
  assert.equal(
    +new Date(a.lastFiredAt),
    +LATER,
    'lastFiredAt advances on a repeat fire (still idempotent in effect)'
  );
});

// ── Never-5xx contract ─────────────────────────────────────────────
// Every handler wraps its work in try/catch and degrades to an honest
// 4xx/5xx-free response on an unexpected stub rejection — the same
// posture watchlist.js / the terminal routes promise.

test('never 5xx: a rejecting stub on any handler degrades, never throws a 500', async () => {
  const cases = [
    ['watchlistAlert.findMany', listAlertsHandler, { ...asUser(1) }],
    [
      'watchlistAlert.count',
      createAlertHandler,
      {
        ...asUser(1),
        body: {
          ticker: 'AAPL',
          metric: 'price',
          direction: 'above',
          threshold: 1,
        },
      },
    ],
    [
      'watchlistAlert.findUnique',
      deleteAlertHandler,
      { ...asUser(1), params: { id: '1' } },
    ],
    [
      'watchlistAlert.findUnique',
      toggleAlertHandler,
      { ...asUser(1), params: { id: '1' }, body: { active: false } },
    ],
    [
      'watchlistAlert.findUnique',
      firedAlertHandler,
      { ...asUser(1), params: { id: '1' } },
    ],
  ];
  for (const [failKey, handler, req] of cases) {
    const db = makeDb(
      { alerts: [{ id: 1, userId: 1, ticker: 'A', active: true }] },
      { failOn: failKey }
    );
    const res = fakeRes();
    await handler(req, res, db, () => NOW);
    assert.ok(
      res.statusCode < 500,
      `${handler.name} with ${failKey} failing must not 5xx, got ${res.statusCode}`
    );
  }
});

// ── Auth parity ────────────────────────────────────────────────────
// The router applies verifyJwt once at module scope and no route adds
// its own — same shape as the other per-user routers. Asserting the
// global middleware + that each route carries exactly one handler
// proves every endpoint is behind verifyJwt.

test('verifyJwt is a global middleware on the alerts router; routes add none of their own', () => {
  const layers = router.stack;
  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  assert.ok(
    globalMw.includes('verifyJwt'),
    'verifyJwt must be a global middleware on the alerts router'
  );

  const routes = layers.filter((l) => l.route).map((l) => l.route);
  assert.ok(routes.length >= 5, 'expected the full route set registered');
  for (const r of routes) {
    const handlerCount = r.stack.filter((s) => s.method).length;
    assert.equal(
      handlerCount,
      1,
      `route ${r.path} must carry exactly one handler — auth is global, not per-route`
    );
  }
});
