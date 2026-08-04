import test from 'node:test';
import assert from 'node:assert/strict';
import { newer } from './app.js';

test('versions compare numerically, not as text', () => {
  // The bug this exists to prevent: "0.10.0" sorts BEFORE "0.9.0" as a
  // string, so the tenth release would look older than the ninth and
  // every client would sit on a stale build believing it was current.
  assert.equal(newer('0.10.0', '0.9.0'), true);
  assert.equal(newer('0.9.0', '0.10.0'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.2.0', '0.2.0'), false, 'equal is not newer');
  assert.equal(newer('0.2.1', '0.2.0'), true);
  assert.equal(newer('2.0.0', '10.0.0'), false);
});

test('a missing or malformed version is treated as ancient', () => {
  // Erring toward offering the update: a client that cannot say what it
  // is running is the client most likely to need a new one.
  assert.equal(newer('0.1.0', ''), true);
  assert.equal(newer('0.1.0', 'garbage'), true);
});
