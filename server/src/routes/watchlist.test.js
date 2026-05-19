import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, {
  ownedList,
  listAllHandler,
  createListHandler,
  renameListHandler,
  deleteListHandler,
  addItemHandler,
  removeItemHandler,
  MAX_LISTS,
  MAX_ITEMS_PER_LIST,
} from './watchlist.js';

// Same precedent every existing route suite follows (terminal.quotes /
// terminal.execbios): no supertest/HTTP harness in the repo, so each
// exported handler is driven directly with a minimal fake req/res and
// an injected prisma-like stub — never a real DB connection. The stub
// here is an in-memory model of the two tables plus the relational
// reads/writes the handlers actually make, scoped enough to exercise
// the owned-list security invariant, the lazy default, the caps,
// idempotency, unique-name and the never-5xx contract.

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

// A tiny in-memory Prisma double. Models only the surface watchlist.js
// touches: watchlist.{findMany,findUnique,count,create,update,delete}
// and watchlistItem.{count,upsert,deleteMany}. Ids autoincrement;
// createdAt is monotonic so "earliest list" ordering is deterministic.
// `failOn` lets a test force a thrown rejection from any one method to
// prove the never-5xx try/catch.
function makeDb(seed = {}, opts = {}) {
  const state = {
    lists: [], // { id, userId, name, createdAt }
    items: [], // { id, watchlistId, ticker, addedAt }
    seqList: 1,
    seqItem: 1,
    clock: 1,
  };
  for (const l of seed.lists || []) {
    state.lists.push({
      id: l.id ?? state.seqList++,
      userId: l.userId,
      name: l.name,
      createdAt: l.createdAt ?? state.clock++,
    });
    if (l.id != null && l.id >= state.seqList) state.seqList = l.id + 1;
  }
  for (const it of seed.items || []) {
    state.items.push({
      id: it.id ?? state.seqItem++,
      watchlistId: it.watchlistId,
      ticker: it.ticker,
      addedAt: it.addedAt ?? state.clock++,
    });
  }

  const failOn = opts.failOn || null;
  const maybeFail = (key) => {
    if (failOn === key) throw new Error(`stub forced failure: ${key}`);
  };

  function withItems(list) {
    return {
      ...list,
      items: state.items
        .filter((i) => i.watchlistId === list.id)
        .sort((a, b) => a.addedAt - b.addedAt)
        .map((i) => ({ ticker: i.ticker, addedAt: i.addedAt })),
    };
  }

  return {
    _state: state,
    watchlist: {
      async findMany({ where, orderBy, include } = {}) {
        maybeFail('watchlist.findMany');
        let rows = state.lists.filter((l) =>
          where?.userId != null ? l.userId === where.userId : true
        );
        if (orderBy?.createdAt === 'asc') {
          rows = rows.slice().sort((a, b) => a.createdAt - b.createdAt);
        }
        return rows.map((l) => (include?.items ? withItems(l) : { ...l }));
      },
      async findUnique({ where, include } = {}) {
        maybeFail('watchlist.findUnique');
        const l = state.lists.find((x) => x.id === where.id);
        if (!l) return null;
        return include?.items ? withItems(l) : { ...l };
      },
      async count({ where } = {}) {
        maybeFail('watchlist.count');
        return state.lists.filter((l) =>
          where?.userId != null ? l.userId === where.userId : true
        ).length;
      },
      async create({ data } = {}) {
        maybeFail('watchlist.create');
        const dup = state.lists.find(
          (l) => l.userId === data.userId && l.name === data.name
        );
        if (dup) {
          const e = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row = {
          id: state.seqList++,
          userId: data.userId,
          name: data.name,
          createdAt: state.clock++,
        };
        state.lists.push(row);
        return { ...row };
      },
      async update({ where, data } = {}) {
        maybeFail('watchlist.update');
        const l = state.lists.find((x) => x.id === where.id);
        if (!l) {
          const e = new Error('Record to update not found');
          e.code = 'P2025';
          throw e;
        }
        if (data.name != null) {
          const dup = state.lists.find(
            (x) =>
              x.userId === l.userId && x.name === data.name && x.id !== l.id
          );
          if (dup) {
            const e = new Error('Unique constraint failed');
            e.code = 'P2002';
            throw e;
          }
          l.name = data.name;
        }
        return { ...l };
      },
      async delete({ where } = {}) {
        maybeFail('watchlist.delete');
        const idx = state.lists.findIndex((x) => x.id === where.id);
        if (idx === -1) {
          const e = new Error('Record to delete does not exist');
          e.code = 'P2025';
          throw e;
        }
        const [removed] = state.lists.splice(idx, 1);
        // Emulate the DB-level ON DELETE CASCADE to WatchlistItem.
        state.items = state.items.filter(
          (i) => i.watchlistId !== removed.id
        );
        return { ...removed };
      },
    },
    watchlistItem: {
      async count({ where } = {}) {
        maybeFail('watchlistItem.count');
        return state.items.filter(
          (i) =>
            i.watchlistId === where.watchlistId &&
            (where.ticker == null || i.ticker === where.ticker)
        ).length;
      },
      async upsert({ where, create } = {}) {
        maybeFail('watchlistItem.upsert');
        const key = where.watchlistId_ticker;
        const existing = state.items.find(
          (i) =>
            i.watchlistId === key.watchlistId && i.ticker === key.ticker
        );
        if (existing) return { ...existing };
        const row = {
          id: state.seqItem++,
          watchlistId: create.watchlistId,
          ticker: create.ticker,
          addedAt: state.clock++,
        };
        state.items.push(row);
        return { ...row };
      },
      async deleteMany({ where } = {}) {
        maybeFail('watchlistItem.deleteMany');
        const before = state.items.length;
        state.items = state.items.filter(
          (i) =>
            !(
              i.watchlistId === where.watchlistId &&
              i.ticker === where.ticker
            )
        );
        return { count: before - state.items.length };
      },
    },
  };
}

const asUser = (id) => ({ user: { id } });

// ── The security invariant ─────────────────────────────────────────
// "every list/item read or mutation is scoped by req.user.id; any
// operation on a list id whose watchlist.userId !== req.user.id → 404
// (honest, never reveals or touches another user's data)." This is the
// load-bearing test: it must hold across every mutation route, by id.

test('ownedList: returns the list only when it belongs to the user', async () => {
  const db = makeDb({ lists: [{ id: 7, userId: 1, name: 'Mine' }] });
  const mine = await ownedList(db, 1, 7);
  assert.equal(mine?.id, 7);
  // Another user's id for the same list → null (caller turns this into
  // a 404). A non-existent id → null too. Same outcome: never reveals
  // existence or ownership.
  assert.equal(await ownedList(db, 2, 7), null);
  assert.equal(await ownedList(db, 1, 999), null);
});

test('security: user B cannot read user A\'s data — GET only ever returns B\'s own lists', async () => {
  const db = makeDb({
    lists: [
      { id: 1, userId: 1, name: 'A-list' },
      { id: 2, userId: 2, name: 'B-list' },
    ],
    items: [{ watchlistId: 1, ticker: 'AAPL' }],
  });
  const res = fakeRes();
  await listAllHandler({ ...asUser(2) }, res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lists.length, 1);
  assert.equal(res.body.lists[0].name, 'B-list');
  assert.ok(
    !res.body.lists.some((l) => l.name === 'A-list'),
    'must never surface another user\'s list'
  );
});

test('security: user B cannot rename / delete / add to / remove from user A\'s list (404, untouched)', async () => {
  const seed = {
    lists: [{ id: 10, userId: 1, name: 'A-secret' }],
    items: [{ watchlistId: 10, ticker: 'AAPL' }],
  };

  // PATCH another user's list by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await renameListHandler(
      { ...asUser(2), params: { id: '10' }, body: { name: 'hacked' } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.equal(
      db._state.lists.find((l) => l.id === 10).name,
      'A-secret',
      'victim list name must be untouched'
    );
  }

  // DELETE another user's list by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await deleteListHandler(
      { ...asUser(2), params: { id: '10' } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.ok(
      db._state.lists.some((l) => l.id === 10),
      'victim list must still exist'
    );
  }

  // POST an item onto another user's list by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await addItemHandler(
      { ...asUser(2), params: { id: '10' }, body: { ticker: 'TSLA' } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.ok(
      !db._state.items.some(
        (i) => i.watchlistId === 10 && i.ticker === 'TSLA'
      ),
      'must not have written into the victim list'
    );
  }

  // DELETE an item from another user's list by id.
  {
    const db = makeDb(seed);
    const res = fakeRes();
    await removeItemHandler(
      { ...asUser(2), params: { id: '10', ticker: 'AAPL' } },
      res,
      db
    );
    assert.equal(res.statusCode, 404);
    assert.ok(
      db._state.items.some(
        (i) => i.watchlistId === 10 && i.ticker === 'AAPL'
      ),
      'victim item must still be there'
    );
  }
});

// ── Lazy default list ──────────────────────────────────────────────

test('GET lazily creates the default "Watchlist" when the user has none', async () => {
  const db = makeDb({ lists: [] });
  const res = fakeRes();
  await listAllHandler({ ...asUser(5) }, res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lists.length, 1);
  assert.equal(res.body.lists[0].name, 'Watchlist');
  assert.deepEqual(res.body.lists[0].items, []);
  // The lazily-created row is real and persisted, scoped to the caller.
  assert.equal(db._state.lists.length, 1);
  assert.equal(db._state.lists[0].userId, 5);
});

test('GET returns existing lists ordered by createdAt, with items, no spurious default', async () => {
  const db = makeDb({
    lists: [
      { id: 1, userId: 9, name: 'First', createdAt: 1 },
      { id: 2, userId: 9, name: 'Second', createdAt: 2 },
    ],
    items: [
      { watchlistId: 2, ticker: 'MSFT' },
      { watchlistId: 1, ticker: 'AAPL' },
    ],
  });
  const res = fakeRes();
  await listAllHandler({ ...asUser(9) }, res, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lists.length, 2);
  assert.equal(res.body.lists[0].name, 'First');
  assert.equal(res.body.lists[1].name, 'Second');
  assert.deepEqual(
    res.body.lists[0].items.map((i) => i.ticker),
    ['AAPL']
  );
});

// ── List CRUD: unique name, caps, rename ───────────────────────────

test('POST /lists creates a uniquely-named list and returns the full set', async () => {
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'Watchlist' }] });
  const res = fakeRes();
  await createListHandler(
    { ...asUser(1), body: { name: '  Tech  ' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  // Name is trimmed; response carries the whole {lists}.
  assert.ok(res.body.lists.some((l) => l.name === 'Tech'));
  assert.equal(res.body.lists.length, 2);
});

test('POST /lists rejects an empty / whitespace name (400), no row written', async () => {
  for (const name of ['', '   ', null, undefined]) {
    const db = makeDb({ lists: [] });
    const res = fakeRes();
    await createListHandler({ ...asUser(1), body: { name } }, res, db);
    assert.equal(res.statusCode, 400, `name=${JSON.stringify(name)}`);
    assert.equal(db._state.lists.length, 0);
  }
});

test('POST /lists enforces the unique-per-user name (409 honest)', async () => {
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'Tech' }] });
  const res = fakeRes();
  await createListHandler(
    { ...asUser(1), body: { name: 'Tech' } },
    res,
    db
  );
  assert.equal(res.statusCode, 409);
  assert.equal(
    db._state.lists.filter((l) => l.name === 'Tech').length,
    1,
    'no duplicate row'
  );
});

test('POST /lists is per-user: the same name on a different user is allowed', async () => {
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'Tech' }] });
  const res = fakeRes();
  await createListHandler(
    { ...asUser(2), body: { name: 'Tech' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.equal(db._state.lists.length, 2);
});

test(`POST /lists caps at ${MAX_LISTS} lists per user`, async () => {
  const lists = Array.from({ length: MAX_LISTS }, (_, i) => ({
    id: i + 1,
    userId: 1,
    name: `L${i}`,
  }));
  const db = makeDb({ lists });
  const res = fakeRes();
  await createListHandler(
    { ...asUser(1), body: { name: 'OneTooMany' } },
    res,
    db
  );
  assert.ok(
    res.statusCode === 400 || res.statusCode === 409,
    `cap hit must be a 4xx, got ${res.statusCode}`
  );
  assert.equal(db._state.lists.length, MAX_LISTS, 'no row past the cap');
});

test('PATCH /lists/:id renames an owned list; collision → 409', async () => {
  const db = makeDb({
    lists: [
      { id: 1, userId: 1, name: 'Old' },
      { id: 2, userId: 1, name: 'Taken' },
    ],
  });
  // Happy rename.
  {
    const res = fakeRes();
    await renameListHandler(
      { ...asUser(1), params: { id: '1' }, body: { name: 'New' } },
      res,
      db
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      db._state.lists.find((l) => l.id === 1).name,
      'New'
    );
  }
  // Rename onto a name the same user already uses → 409.
  {
    const res = fakeRes();
    await renameListHandler(
      { ...asUser(1), params: { id: '1' }, body: { name: 'Taken' } },
      res,
      db
    );
    assert.equal(res.statusCode, 409);
    assert.equal(
      db._state.lists.find((l) => l.id === 1).name,
      'New',
      'name unchanged on collision'
    );
  }
});

test('DELETE /lists/:id removes an owned list and cascades its items', async () => {
  const db = makeDb({
    lists: [
      { id: 1, userId: 1, name: 'Doomed' },
      { id: 2, userId: 1, name: 'Keep' },
    ],
    items: [
      { watchlistId: 1, ticker: 'AAPL' },
      { watchlistId: 1, ticker: 'MSFT' },
      { watchlistId: 2, ticker: 'TSLA' },
    ],
  });
  const res = fakeRes();
  await deleteListHandler(
    { ...asUser(1), params: { id: '1' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.ok(!db._state.lists.some((l) => l.id === 1));
  assert.equal(
    db._state.items.filter((i) => i.watchlistId === 1).length,
    0,
    'items under the deleted list are gone (cascade)'
  );
  assert.ok(
    db._state.items.some((i) => i.watchlistId === 2),
    'other lists\' items untouched'
  );
  // Response still carries the (now smaller) full set.
  assert.equal(res.body.lists.length, 1);
  assert.equal(res.body.lists[0].name, 'Keep');
});

test('DELETE the last list is allowed; the next GET respawns the default', async () => {
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'Only' }] });
  const del = fakeRes();
  await deleteListHandler(
    { ...asUser(1), params: { id: '1' } },
    del,
    db
  );
  assert.equal(del.statusCode, 200);
  assert.equal(db._state.lists.length, 0);
  // Next load respawns "Watchlist".
  const get = fakeRes();
  await listAllHandler({ ...asUser(1) }, get, db);
  assert.equal(get.body.lists.length, 1);
  assert.equal(get.body.lists[0].name, 'Watchlist');
});

// ── Item add/remove: validation, idempotency, dedupe, cap ──────────

test('POST item: validates + uppercases the ticker, returns the full set', async () => {
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'L' }] });
  const res = fakeRes();
  await addItemHandler(
    { ...asUser(1), params: { id: '1' }, body: { ticker: ' aapl ' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.ok(
    db._state.items.some(
      (i) => i.watchlistId === 1 && i.ticker === 'AAPL'
    ),
    'ticker stored upper-cased and trimmed'
  );
  const l = res.body.lists.find((x) => x.id === 1);
  assert.deepEqual(l.items.map((i) => i.ticker), ['AAPL']);
});

test('POST item: an invalid ticker is a 400, nothing written', async () => {
  for (const t of ['', '   ', 'NOT A TICKER', 'TOOOOOOOOOOOONG', '<x>']) {
    const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'L' }] });
    const res = fakeRes();
    await addItemHandler(
      { ...asUser(1), params: { id: '1' }, body: { ticker: t } },
      res,
      db
    );
    assert.equal(res.statusCode, 400, `ticker=${JSON.stringify(t)}`);
    assert.equal(db._state.items.length, 0);
  }
});

test('POST item is idempotent: re-adding the same ticker is a no-op success (dedupe via unique key)', async () => {
  const db = makeDb({
    lists: [{ id: 1, userId: 1, name: 'L' }],
    items: [{ watchlistId: 1, ticker: 'AAPL' }],
  });
  const res = fakeRes();
  await addItemHandler(
    { ...asUser(1), params: { id: '1' }, body: { ticker: 'aapl' } },
    res,
    db
  );
  assert.equal(res.statusCode, 200);
  assert.equal(
    db._state.items.filter(
      (i) => i.watchlistId === 1 && i.ticker === 'AAPL'
    ).length,
    1,
    'no duplicate row — the unique key dedupes'
  );
});

test(`POST item caps at ${MAX_ITEMS_PER_LIST} tickers per list`, async () => {
  const items = Array.from({ length: MAX_ITEMS_PER_LIST }, (_, i) => ({
    watchlistId: 1,
    ticker: `T${i}`,
  }));
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'L' }], items });
  const res = fakeRes();
  await addItemHandler(
    { ...asUser(1), params: { id: '1' }, body: { ticker: 'ZZZZ' } },
    res,
    db
  );
  assert.ok(
    res.statusCode === 400 || res.statusCode === 409,
    `cap hit must be a 4xx, got ${res.statusCode}`
  );
  assert.equal(
    db._state.items.length,
    MAX_ITEMS_PER_LIST,
    'no item past the cap'
  );
});

test('POST item: re-adding an existing ticker at the cap is still an idempotent success (not a false cap-hit)', async () => {
  const items = Array.from({ length: MAX_ITEMS_PER_LIST }, (_, i) => ({
    watchlistId: 1,
    ticker: `T${i}`,
  }));
  const db = makeDb({ lists: [{ id: 1, userId: 1, name: 'L' }], items });
  const res = fakeRes();
  await addItemHandler(
    { ...asUser(1), params: { id: '1' }, body: { ticker: 'T0' } },
    res,
    db
  );
  assert.equal(
    res.statusCode,
    200,
    're-adding an already-present ticker must succeed even at the cap'
  );
  assert.equal(db._state.items.length, MAX_ITEMS_PER_LIST);
});

test('DELETE item: removes an owned ticker; absent ticker is a no-op success', async () => {
  const db = makeDb({
    lists: [{ id: 1, userId: 1, name: 'L' }],
    items: [{ watchlistId: 1, ticker: 'AAPL' }],
  });
  // Remove the present one.
  {
    const res = fakeRes();
    await removeItemHandler(
      { ...asUser(1), params: { id: '1', ticker: 'aapl' } },
      res,
      db
    );
    assert.equal(res.statusCode, 200);
    assert.equal(db._state.items.length, 0);
  }
  // Removing one that isn't there is a benign success, not a 404.
  {
    const res = fakeRes();
    await removeItemHandler(
      { ...asUser(1), params: { id: '1', ticker: 'GONE' } },
      res,
      db
    );
    assert.equal(res.statusCode, 200);
  }
});

// ── Never-5xx contract ─────────────────────────────────────────────
// Every handler wraps its work in try/catch and degrades to an honest
// 4xx/5xx-free response on an unexpected stub rejection — the same
// never-throws posture the terminal routes promise.

test('never 5xx: a rejecting stub on any handler degrades, never throws a 500', async () => {
  const cases = [
    ['watchlist.findMany', listAllHandler, { ...asUser(1) }],
    [
      'watchlist.create',
      createListHandler,
      { ...asUser(1), body: { name: 'X' } },
    ],
    [
      'watchlist.findUnique',
      renameListHandler,
      { ...asUser(1), params: { id: '1' }, body: { name: 'Y' } },
    ],
    [
      'watchlist.findUnique',
      deleteListHandler,
      { ...asUser(1), params: { id: '1' } },
    ],
    [
      'watchlistItem.upsert',
      addItemHandler,
      { ...asUser(1), params: { id: '1' }, body: { ticker: 'AAPL' } },
    ],
    [
      'watchlistItem.deleteMany',
      removeItemHandler,
      { ...asUser(1), params: { id: '1', ticker: 'AAPL' } },
    ],
  ];
  for (const [failKey, handler, req] of cases) {
    const db = makeDb(
      { lists: [{ id: 1, userId: 1, name: 'L' }] },
      { failOn: failKey }
    );
    const res = fakeRes();
    await handler(req, res, db);
    assert.ok(
      res.statusCode < 500,
      `${handler.name} with ${failKey} failing must not 5xx, got ${res.statusCode}`
    );
  }
});

test('handlers reject a non-numeric / missing list id with a 4xx, no DB call', async () => {
  for (const bad of ['abc', '', undefined, '1.5', '-3']) {
    const db = makeDb({ lists: [] });
    const res = fakeRes();
    await addItemHandler(
      { ...asUser(1), params: { id: bad }, body: { ticker: 'AAPL' } },
      res,
      db
    );
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `id=${JSON.stringify(bad)} must be a 4xx`
    );
  }
});

// ── Auth parity ────────────────────────────────────────────────────
// The router applies verifyJwt once at module scope (router.use(
// verifyJwt)) and no route adds its own auth — same shape as the other
// per-user routers. Asserting the global middleware + that routes carry
// no extra per-route auth proves every endpoint is behind verifyJwt.

test('verifyJwt is a global middleware on the watchlist router; routes add none of their own', () => {
  const layers = router.stack;
  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  assert.ok(
    globalMw.includes('verifyJwt'),
    'verifyJwt must be a global middleware on the watchlist router'
  );

  const routes = layers.filter((l) => l.route).map((l) => l.route);
  assert.ok(routes.length >= 6, 'expected the full route set registered');
  for (const r of routes) {
    const handlerCount = r.stack.filter((s) => s.method).length;
    assert.equal(
      handlerCount,
      1,
      `route ${r.path} must carry exactly one handler — auth is global, not per-route`
    );
  }
});
