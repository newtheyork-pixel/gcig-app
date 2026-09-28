import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jwtIssuedAt,
  adoptToken,
  isSessionOver,
  shouldEndSession,
  rotationTokenFromHeaders,
  sessionUser,
  IDLE_LIMIT_MS,
  lastActiveAt,
  markActive,
  clearActive,
  idleTooLong,
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

// ── A user with no token is not a session ───────────────────────────

test('sessionUser needs the token AND the user', () => {
  const user = JSON.stringify({ id: 1, name: 'Maya Brooks' });
  assert.deepEqual(sessionUser(jwtWithIat(1), user), { id: 1, name: 'Maya Brooks' });
  // The dead end: user left in storage, token gone. Starting from it
  // bounced /login to a dashboard on which every call failed.
  assert.equal(sessionUser(null, user), null);
  assert.equal(sessionUser(jwtWithIat(1), null), null);
  assert.equal(sessionUser(jwtWithIat(1), '{not json'), null);
  assert.equal(sessionUser(jwtWithIat(1), 'null'), null);
  assert.equal(sessionUser(jwtWithIat(1), '5'), null);
});

// ── One idle clock for every tab ─────────────────────────────────────

// Stands in for localStorage, which every tab shares.
function sharedClock(initial = null) {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    remove: () => {
      value = null;
    },
  };
}

const T0 = 1_790_000_000_000;

test('no record is never a reason to sign out', () => {
  const store = sharedClock();
  assert.equal(lastActiveAt(store), null);
  assert.equal(idleTooLong(T0, { store }), false);
  assert.equal(idleTooLong(T0, { store: sharedClock('garbage') }), false);
});

test('two hours is the line, not a moment before', () => {
  const store = sharedClock(String(T0));
  assert.equal(idleTooLong(T0 + IDLE_LIMIT_MS, { store }), false);
  assert.equal(idleTooLong(T0 + IDLE_LIMIT_MS + 1, { store }), true);
});

test('activity in one tab keeps every other tab signed in', () => {
  // Tab A was last touched at T0 and has been left alone since. The
  // member has been working in tab B the whole time. This is the case
  // that used to delete tab B's token when tab A's own clock ran out.
  const store = sharedClock(String(T0));
  const later = T0 + IDLE_LIMIT_MS - 60_000;
  markActive(later, store); // tab B
  assert.equal(idleTooLong(T0 + IDLE_LIMIT_MS + 1, { store }), false); // tab A checks
  assert.equal(idleTooLong(later + IDLE_LIMIT_MS + 1, { store }), true);
});

test('a sign-in starts the clock again, so the last session cannot end this one', () => {
  // Signed in and immediately signed out: the previous session's
  // idleness, still on the clock, judged the new one.
  const store = sharedClock(String(T0));
  const signIn = T0 + 3 * 60 * 60 * 1000;
  assert.equal(idleTooLong(signIn, { store }), true);
  markActive(signIn, store);
  assert.equal(idleTooLong(signIn + 1000, { store }), false);
});

test('signing out clears the clock for whoever signs in next', () => {
  const store = sharedClock(String(T0));
  clearActive(store);
  assert.equal(lastActiveAt(store), null);
  assert.equal(idleTooLong(T0 + 10 * IDLE_LIMIT_MS, { store }), false);
});
