import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { execBiosHandler } from './terminal.js';

// The repo has no route-test precedent and no supertest/HTTP harness;
// every existing suite (executiveBios.test.js, the service tests)
// drives the unit directly with injected deps and never touches the
// network or the DB. This follows that precedent exactly: the express
// handler is a thin wrapper around the exported execBiosHandler, which
// takes the service injected the same way Task 2's tests inject
// filingsFetch/docFetch. A minimal fake req/res captures the response.
// The handler now consults four live sources plus the DB; tests pin
// every one of them so nothing escapes to the network. Merge behavior
// gets its own cases below.
const quietDeps = {
  getOfficerRoster: async () => ({ officers: [] }),
  filingBio: async () => null,
  getCompanyIdentity: async () => null,
  wikipediaBio: async () => null,
  storedProfiles: async () => [],
  saveProfiles: async () => {},
};

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

// A ticker whose injected service yields officers returns 200 with the
// { ticker, source, officers:[{name,bio}] } shape — the same fields the
// client's PersonModal consumes.
test('GET /governance/:ticker/exec-bios: 200 with officers when the service yields them', async () => {
  const res = fakeRes();
  await execBiosHandler(
    { params: { ticker: 'amzn' } },
    res,
    {
      ...quietDeps,
      getExecutiveBios: async (ticker) => {
        assert.equal(ticker, 'AMZN');
        return {
          ticker: 'AMZN',
          source: 'https://x/amzn.htm',
          asOf: '2026-02-06',
          officers: [
            { name: 'Andrew R. Jassy', bio: 'President and CEO since July 2021.' },
            { name: 'Brian T. Olsavsky', bio: 'SVP and CFO since June 2015.' },
          ],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'AMZN');
  assert.equal(res.body.source, 'https://x/amzn.htm');
  assert.equal(Array.isArray(res.body.officers), true);
  assert.equal(res.body.officers.length, 2);
  assert.equal(res.body.officers[0].name, 'Andrew R. Jassy');
  assert.equal(res.body.officers[0].bio, 'President and CEO since July 2021.');
  assert.equal(res.body.officers[0].bioSource, '10-K');
});

// The parse-miss / incorporated-by-reference tier (MLAB, AAPL): the
// service returns its honest empty stub. That is a normal 200 with an
// empty officers array, NOT a 4xx/5xx — the panel renders "no bios
// disclosed", it does not error.
test('GET /governance/:ticker/exec-bios: 200 + empty officers on a parse miss (never 4xx/5xx)', async () => {
  const res = fakeRes();
  await execBiosHandler(
    { params: { ticker: 'MLAB' } },
    res,
    {
      ...quietDeps,
      getExecutiveBios: async () => ({
        ticker: 'MLAB',
        source: null,
        asOf: null,
        officers: [],
      }),
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'MLAB');
  assert.equal(res.body.source, null);
  assert.deepEqual(res.body.officers, []);
});

// An invalid ticker is the one acceptable non-200 — it mirrors the
// sibling /governance/:ticker route's own input guard exactly
// (/^[A-Z0-9.\-]{1,12}$/ → 400 'Invalid ticker'). No service call.
test('GET /governance/:ticker/exec-bios: 400 on an invalid ticker, like the sibling route', async () => {
  const res = fakeRes();
  let called = false;
  await execBiosHandler(
    { params: { ticker: 'not a ticker!!' } },
    res,
    { ...quietDeps, getExecutiveBios: async () => { called = true; return {}; } }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(called, false, 'service must not be called for an invalid ticker');
});

// The service is contractually never-throws, but the handler must not
// assume that: if the service (or anything in the handler) were to
// reject, the handler catches and degrades to a 200 honest-empty stub.
// It must NEVER 5xx — the contract the route comment promises.
test('GET /governance/:ticker/exec-bios: never 5xx even if the service rejects', async () => {
  const res = fakeRes();
  await execBiosHandler(
    { params: { ticker: 'BOOM' } },
    res,
    {
      ...quietDeps,
      getExecutiveBios: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'BOOM');
  assert.equal(res.body.source, null);
  assert.deepEqual(res.body.officers, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route.
// The terminal router applies auth + the AI limiter once, at module
// scope (router.use(verifyJwt); router.use(requireTerminalAccess);
// router.use(aiLimiter)), and /governance/:ticker carries NO per-route
// middleware — it simply inherits that chain. The faithful, harness-
// free way to assert "same auth/limiter as the sibling" is to prove
// the new route sits on the same router stack, after those same three
// global middlewares, with no extra/different per-route middleware
// than the sibling. Both routes then provably traverse an identical
// verifyJwt → requireTerminalAccess → aiLimiter chain.
test('exec-bios inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
  const layers = router.stack;

  // The three global middlewares, in order, before any route.
  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  const vIdx = globalMw.indexOf('verifyJwt');
  const eIdx = globalMw.indexOf('requireTerminalAccess');
  assert.ok(vIdx >= 0, 'verifyJwt must be a global middleware on the terminal router');
  assert.ok(eIdx > vIdx, 'requireTerminalAccess must follow verifyJwt globally');
  // The rate limiter is an anonymous express-rate-limit middleware
  // registered immediately after the auth pair.
  assert.ok(
    layers.filter((l) => !l.route).length >= 3,
    'expected verifyJwt + requireTerminalAccess + aiLimiter as global middlewares'
  );

  const findRoute = (p) =>
    layers.find((l) => l.route && l.route.path === p);
  const sibling = findRoute('/governance/:ticker');
  const target = findRoute('/governance/:ticker/exec-bios');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/governance/:ticker/exec-bios route must be registered');

  // Neither route adds its own auth/limiter middleware — both rely
  // solely on the shared global chain, so their auth is identical by
  // construction. (Each route layer has exactly one handler: the
  // route handler itself.)
  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'exec-bios must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});

// The Apple tier: the 10-K describes nobody, the roster names the
// officers, Wikipedia tells their stories. The panel gets real people
// with labelled sources instead of "no bios disclosed".
test('exec-bios: roster names + Wikipedia bios cover the incorporated-by-reference tier', async () => {
  const res = fakeRes();
  const saved = [];
  await execBiosHandler(
    { params: { ticker: 'AAPL' } },
    res,
    {
      ...quietDeps,
      getExecutiveBios: async () => ({ ticker: 'AAPL', source: null, officers: [] }),
      getOfficerRoster: async () => ({
        officers: [
          { name: 'Tim Cook', office: 'Chief Executive Officer' },
          { name: 'Jeff Williams', office: 'Chief Operating Officer' },
        ],
      }),
      getCompanyIdentity: async () => ({ legalName: 'Apple Inc.' }),
      wikipediaBio: async (name, company) => {
        assert.equal(company, 'Apple Inc.');
        return name === 'Tim Cook'
          ? { bio: 'Timothy Donald Cook is an American business executive.', url: 'https://en.wikipedia.org/wiki/Tim_Cook', source: 'Wikipedia' }
          : null;
      },
      saveProfiles: async (t, people, kind) => { saved.push({ t, n: people.length, kind }); },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.officers.length, 2);
  const cook = res.body.officers.find((o) => o.name === 'Tim Cook');
  assert.equal(cook.bioSource, 'Wikipedia');
  assert.equal(cook.title, 'Chief Executive Officer');
  const williams = res.body.officers.find((o) => o.name === 'Jeff Williams');
  assert.equal(williams.bio, null);
  assert.deepEqual(saved, [{ t: 'AAPL', n: 2, kind: 'exec' }]);
});

// Every live source empty: the stored rows stand in, flagged as such.
test('exec-bios: serves last-known-good from the DB when every live source is empty', async () => {
  const res = fakeRes();
  await execBiosHandler(
    { params: { ticker: 'AAPL' } },
    res,
    {
      ...quietDeps,
      getExecutiveBios: async () => ({ ticker: 'AAPL', source: null, officers: [] }),
      storedProfiles: async (t, kind) => {
        assert.equal(kind, 'exec');
        return [{ name: 'Tim Cook', title: 'CEO', bio: 'Stored bio.', bioSource: 'Wikipedia', bioUrl: 'https://x' }];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, true);
  assert.equal(res.body.officers[0].bio, 'Stored bio.');
});
