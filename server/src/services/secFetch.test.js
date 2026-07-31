import test from 'node:test';
import assert from 'node:assert/strict';
import { secFetch } from './secFetch.js';

function stub(sequence) {
  let i = 0;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const s = sequence[Math.min(i++, sequence.length - 1)];
    if (s instanceof Error) throw s;
    return { ok: s < 400, status: s, json: async () => ({ ok: true }) };
  };
  return calls;
}

const realFetch = global.fetch;
test.after(() => { global.fetch = realFetch; });

test('a throttled request is made again', async () => {
  const calls = stub([429, 200]);
  const res = await secFetch('https://data.sec.gov/x');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('403 counts as throttling, because that is how EDGAR says it', async () => {
  const calls = stub([403, 403, 200]);
  const res = await secFetch('https://data.sec.gov/x');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test('a 404 is an answer and is never retried', async () => {
  const calls = stub([404]);
  await assert.rejects(() => secFetch('https://data.sec.gov/x'), (e) => e.status === 404);
  assert.equal(calls.length, 1);
});

test('exhausting the retries names throttling as the cause', async () => {
  stub([429, 429, 429]);
  await assert.rejects(() => secFetch('https://data.sec.gov/x'),
    (e) => e.status === 502 && /rate-limiting/.test(e.message));
});

test('a network error is retried, then surfaces', async () => {
  const calls = stub([new Error('socket hang up')]);
  await assert.rejects(() => secFetch('https://data.sec.gov/x'), /socket hang up/);
  assert.equal(calls.length, 3);
});
