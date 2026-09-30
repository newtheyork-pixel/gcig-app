import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAnalystConsensus } from './marketData.js';

// getAnalystConsensus read a variable it never declared, so every
// uncached call threw, and the route that called it took the whole API
// down with it. These run the real function against a stubbed fetch,
// once failing and once succeeding; each ticker is distinct so the
// module's cache cannot answer for another test.

const realFetch = globalThis.fetch;
const realKey = process.env.FINNHUB_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FINNHUB_API_KEY;
  else process.env.FINNHUB_API_KEY = realKey;
});

test('a refused consensus call resolves to null instead of throwing', async () => {
  process.env.FINNHUB_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response('API limit reached', { status: 429 });
  assert.equal(await getAnalystConsensus('ZZCONA'), null);
});

test('an unreachable Finnhub resolves to null instead of throwing', async () => {
  process.env.FINNHUB_API_KEY = 'test-key';
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await getAnalystConsensus('ZZCONB'), null);
});

test('a good answer returns the latest period and the prior one', async () => {
  process.env.FINNHUB_API_KEY = 'test-key';
  const rows = [
    { period: '2026-09-01', strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, symbol: 'ZZCONC' },
    { period: '2026-06-01', strongBuy: 4, buy: 9, hold: 4, sell: 1, strongSell: 0, symbol: 'ZZCONC' },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const out = await getAnalystConsensus('ZZCONC');
  assert.equal(out.period, '2026-09-01');
  assert.equal(out.total, 19);
  assert.equal(out.prior.period, '2026-06-01');
});
