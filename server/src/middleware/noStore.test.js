import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noStoreApi } from './noStore.js';

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
  };
}

test('marks API responses uncacheable so a browser cannot replay X-New-Token', () => {
  const res = fakeRes();
  let next = false;
  noStoreApi({}, res, () => {
    next = true;
  });
  assert.equal(res.getHeader('Cache-Control'), 'private, no-store');
  assert.equal(next, true);
});
