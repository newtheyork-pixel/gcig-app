import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jwtIssuedAt,
  adoptToken,
  isSessionOver,
  shouldEndSession,
  rotationTokenFromHeaders,
} from './session.js';

function jwtWithIat(iat) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url'
  );
  const payload = Buffer.from(JSON.stringify({ iat })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function memoryStore(initial = null) {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

function err({ status = 401, code, error = 'no' } = {}) {
  return { response: { status, data: { code, error } } };
}

test('jwtIssuedAt reads a numeric iat and restores stripped padding', () => {
  const token = jwtWithIat(1_700_000_000);
  assert.equal(jwtIssuedAt(token), 1_700_000_000);
});

test('jwtIssuedAt refuses garbage rather than guessing', () => {
  assert.equal(jwtIssuedAt(null), null);
  assert.equal(jwtIssuedAt(''), null);
  assert.equal(jwtIssuedAt('not.a.jwt'), null);
  assert.equal(jwtIssuedAt('only-one-part'), null);
  assert.equal(jwtIssuedAt(jwtWithIat('this-morning')), null);
});

test('adoptToken refuses to invent a session from a rotation header', () => {
  const store = memoryStore(null);
  const taken = adoptToken(jwtWithIat(2), store);
  assert.equal(taken, false);
  assert.equal(store.read(), null);
});

test('adoptToken refuses a replayed older rotation', () => {
  const live = jwtWithIat(100);
  const stale = jwtWithIat(50);
  const store = memoryStore(live);
  assert.equal(adoptToken(stale, store), false);
  assert.equal(store.read(), live);
});

test('adoptToken refuses an equally-old header (same-second replay)', () => {
  const live = jwtWithIat(100);
  const store = memoryStore(live);
  assert.equal(adoptToken(jwtWithIat(100), store), false);
  assert.equal(store.read(), live);
});

test('adoptToken takes a genuinely newer token', () => {
  const live = jwtWithIat(100);
  const fresh = jwtWithIat(200);
  const store = memoryStore(live);
  assert.equal(adoptToken(fresh, store), true);
  assert.equal(store.read(), fresh);
});

test('adoptToken replaces an unreadable current token with a well-formed one', () => {
  const fresh = jwtWithIat(200);
  const store = memoryStore('truncated');
  assert.equal(adoptToken(fresh, store), true);
  assert.equal(store.read(), fresh);
});

test('isSessionOver is true only for 401 AUTH', () => {
  assert.equal(isSessionOver(err({ code: 'AUTH' })), true);
  assert.equal(isSessionOver(err({ status: 401, error: 'Invalid credentials' })), false);
  assert.equal(isSessionOver(err({ status: 403, code: 'AUTH' })), false);
  assert.equal(isSessionOver(err({ status: 429 })), false);
  assert.equal(isSessionOver(err({ status: 502 })), false);
  assert.equal(isSessionOver({}), false);
  assert.equal(isSessionOver(undefined), false);
});

test('a 401 AUTH on a request that sent nothing does not end a live session', () => {
  // The post-login race: unauthenticated calls still in flight, login
  // has already written a token, verifyJwt answers "Missing token".
  const live = jwtWithIat(200);
  assert.equal(
    shouldEndSession(err({ code: 'AUTH', error: 'Missing token' }), {
      sent: undefined,
      current: live,
    }),
    false
  );
});

test('a 401 AUTH for a token that has since been replaced is ignored', () => {
  assert.equal(
    shouldEndSession(err({ code: 'AUTH' }), {
      sent: jwtWithIat(1),
      current: jwtWithIat(2),
    }),
    false
  );
});

test('a 401 AUTH for the token we still hold is a verdict', () => {
  const token = jwtWithIat(1);
  assert.equal(
    shouldEndSession(err({ code: 'AUTH' }), { sent: token, current: token }),
    true
  );
});

test('a login 401 (no AUTH code) never ends a session, sent or not', () => {
  assert.equal(
    shouldEndSession(err({ error: 'Invalid credentials' }), { sent: undefined, current: null }),
    false
  );
  assert.equal(
    shouldEndSession(err({ error: 'Invalid credentials' }), {
      sent: jwtWithIat(1),
      current: jwtWithIat(1),
    }),
    false
  );
});

test('rotationTokenFromHeaders reads axios and Fetch header shapes', () => {
  assert.equal(
    rotationTokenFromHeaders({ 'x-new-token': 'abc', 'X-New-Token': 'nope' }),
    'abc'
  );
  const headers = new Headers({ 'X-New-Token': 'from-fetch' });
  assert.equal(rotationTokenFromHeaders(headers), 'from-fetch');
  assert.equal(rotationTokenFromHeaders(null), null);
});
