import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { weatherImpactHandler } from './terminal.js';

// Mirrors terminal.earnings.test.js / terminal.filings.test.js exactly:
// the repo carries no route-test harness or supertest, so the express
// handler is a thin wrapper over the exported weatherImpactHandler,
// driven directly with injected services (deps.getWeatherImpact /
// deps.getSheetPortfolio) and a minimal fake req/res — never the
// network, the sheet, or HURDAT2. Same precedent every existing suite
// follows.
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

// Happy path: the injected getSheetPortfolio yields the book (cash
// included; the handler filters cash out), the injected
// getWeatherImpact yields the assembled shape, and the response is the
// { asOf, activeStorms, exposures } envelope the panel consumes.
test('GET /weather-impact: 200 with { asOf, activeStorms, exposures } when both services yield data', async () => {
  const res = fakeRes();
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => ({
        holdings: [
          { ticker: 'XOM', isCash: false },
          { ticker: 'CASH', isCash: true },
          { ticker: 'TRV', isCash: false },
        ],
      }),
      getWeatherImpact: async (holdings) => {
        // Cash must have been stripped before reaching the service.
        assert.deepEqual(holdings, ['XOM', 'TRV']);
        return {
          asOf: '2026-05-20T00:00:00.000Z',
          activeStorms: [
            { name: 'Foo', classification: 'TS', intensity: 45, lastUpdate: '2026-05-19T12:00:00Z' },
          ],
          exposures: [
            {
              exposure: { id: 'gulf_oil_gas', label: 'Gulf O&G', tickers: ['XOM'], rationale: 'r' },
              holdingsOverlap: ['XOM'],
              study: { perWindow: { '1d': { mean: 0.01, median: 0.01, std: 0, n: 1, tStat: 0 }, '5d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 }, '20d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 } }, perEvent: [] },
            },
          ],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.asOf, '2026-05-20T00:00:00.000Z');
  assert.equal(Array.isArray(res.body.activeStorms), true);
  assert.equal(res.body.activeStorms.length, 1);
  assert.equal(Array.isArray(res.body.exposures), true);
  assert.equal(res.body.exposures.length, 1);
  assert.equal(res.body.exposures[0].exposure.id, 'gulf_oil_gas');
});

// getWeatherImpact rejecting (anything past the contract's never-throws
// promise) must NOT 5xx. The handler degrades to the honest-empty
// envelope: { activeStorms:[], exposures:[] } with an asOf timestamp so
// the panel can render "no data right now" without a fetch error.
test('GET /weather-impact: never 5xx when getWeatherImpact rejects — degrades to empty envelope', async () => {
  const res = fakeRes();
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => ({ holdings: [] }),
      getWeatherImpact: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.activeStorms, []);
  assert.deepEqual(res.body.exposures, []);
});

// getSheetPortfolio rejecting (the sheet is unreachable from Render
// briefly, the sheet ID is mis-set, etc.) must NOT 5xx either. The
// service is still called with an empty holdings list — the historical
// playbook stands without the holdings overlay.
test('GET /weather-impact: 200 when getSheetPortfolio rejects (holdings overlap empty, study still runs)', async () => {
  const res = fakeRes();
  let calledWith = null;
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => {
        throw new Error('sheet unreachable');
      },
      getWeatherImpact: async (holdings) => {
        calledWith = holdings;
        return {
          asOf: '2026-05-20T00:00:00.000Z',
          activeStorms: [],
          exposures: [],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calledWith, [], 'an unreachable sheet still passes an empty list through');
  assert.deepEqual(res.body.activeStorms, []);
  assert.deepEqual(res.body.exposures, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.earnings.test.js /
// terminal.filings.test.js use: prove the new /weather-impact route
// sits on the same router stack, after the same three module-scope
// middlewares (verifyJwt → requireTerminalAccess → aiLimiter), with no
// extra/different per-route middleware than the sibling. Both routes
// then provably traverse an identical auth chain.
test('weather-impact inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
  const layers = router.stack;

  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  const vIdx = globalMw.indexOf('verifyJwt');
  const eIdx = globalMw.indexOf('requireTerminalAccess');
  assert.ok(vIdx >= 0, 'verifyJwt must be a global middleware on the terminal router');
  assert.ok(eIdx > vIdx, 'requireTerminalAccess must follow verifyJwt globally');
  assert.ok(
    layers.filter((l) => !l.route).length >= 3,
    'expected verifyJwt + requireTerminalAccess + aiLimiter as global middlewares'
  );

  const findRoute = (p) =>
    layers.find((l) => l.route && l.route.path === p);
  const sibling = findRoute('/governance/:ticker');
  const target = findRoute('/weather-impact');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/weather-impact route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'weather-impact must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});

// A storm with a position, and the club's own plants inside its reach.
//
// This is the join the panel existed to make and could not: "there is an
// active storm" and "we hold GD" are two facts a reader had to put
// together themselves. Facilities carry coordinates now, so the answer
// is computable.
test('GET /weather-impact: a placed storm names the holdings sites inside its reach', async () => {
  const res = fakeRes();
  await weatherImpactHandler({}, res, {
    getSheetPortfolio: async () => ({ holdings: [{ ticker: 'GD', isCash: false }] }),
    getWeatherImpact: async () => ({
      asOf: '2026-08-01T00:00:00.000Z',
      activeStorms: [{ name: 'Genevieve', classification: 'TS', latitude: 29.9, longitude: -90.1 }],
      exposures: [],
    }),
    resolveCik: async () => ({ cik: '0000040533', name: 'GENERAL DYNAMICS CORP' }),
    getFacilities: async () => ({
      term: 'GENERAL',
      facilities: [
        // New Orleans: inside the 300-mile ring.
        { id: '1', name: 'Avondale Yard', city: 'New Orleans', state: 'LA', lat: 29.95, lon: -90.2 },
        // Maine: far outside it.
        { id: '2', name: 'Bath Iron Works', city: 'Bath', state: 'ME', lat: 43.9, lon: -69.8 },
        // No coordinates: skipped rather than guessed at.
        { id: '3', name: 'Unplaced Plant', city: 'Somewhere', state: 'LA', lat: null, lon: null },
      ],
    }),
  });

  const exp = res.body.stormExposure;
  assert.equal(exp.length, 1);
  assert.equal(exp[0].storm, 'Genevieve');
  assert.deepEqual(exp[0].sites.map((s) => s.name), ['Avondale Yard']);
  assert.equal(exp[0].sites[0].ticker, 'GD');
  assert.ok(exp[0].sites[0].milesFromStorm < 300);
});

test('GET /weather-impact: a storm with no position places nothing', async () => {
  const res = fakeRes();
  await weatherImpactHandler({}, res, {
    getSheetPortfolio: async () => ({ holdings: [{ ticker: 'GD', isCash: false }] }),
    getWeatherImpact: async () => ({
      asOf: '2026-08-01T00:00:00.000Z',
      // The case the panel used to render as "active storm, location
      // unknown" — there is nothing to compute against.
      activeStorms: [{ name: 'Unknown', classification: 'TD' }],
      exposures: [],
    }),
    resolveCik: async () => { throw new Error('must not be called'); },
    getFacilities: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(res.body.stormExposure, []);
});
