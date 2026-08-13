import { test } from 'node:test';
import assert from 'node:assert/strict';

import { perCallerKey, perAccountKey } from './rateLimit.js';

// The bug these pin is not "the limit is wrong", it is "the limit is
// shared". Our members are a school club and are all behind one public
// address when they are in the building, so an address-keyed bucket is
// one allowance for the whole club — and the general limiter sits in
// front of every route, so running it out took the application away
// rather than one feature. What people then reported was a session
// problem, because the client deleted a perfectly good token the moment
// a call failed.

function req({ ip = '1.2.3.4', token, body = {} } = {}) {
  return { ip, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
}

test('two members behind one address get separate general-limit buckets', () => {
  const key = perCallerKey;
  const a = key(req({ token: 'member-a-jwt' }));
  const b = key(req({ token: 'member-b-jwt' }));
  assert.notEqual(a, b, 'same address, different tokens must not share a bucket');
});

test('the general-limit key never contains the raw token', () => {
  const token = 'a.very.secret.jwt.value';
  const key = perCallerKey(req({ token }));
  assert.ok(!key.includes(token), 'a rate-limit key is stored and logged; it may not be a credential');
  assert.ok(!key.includes('secret'));
});

test('anonymous callers still key by address', () => {
  const key = perCallerKey;
  assert.equal(key(req({ ip: '9.9.9.9' })), key(req({ ip: '9.9.9.9' })));
  assert.notEqual(key(req({ ip: '9.9.9.9' })), key(req({ ip: '8.8.8.8' })));
});

test('one member fumbling their password does not lock out the room', () => {
  const key = perAccountKey;
  const clumsy = key(req({ body: { email: 'clumsy@school.org' } }));
  const nextPerson = key(req({ body: { email: 'someone@school.org' } }));
  assert.notEqual(clumsy, nextPerson);
});

test('brute force against ONE account from one address is still capped together', () => {
  const key = perAccountKey;
  const first = key(req({ body: { email: 'target@school.org', password: 'guess1' } }));
  const second = key(req({ body: { email: 'TARGET@school.org ', password: 'guess2' } }));
  assert.equal(first, second, 'case and whitespace must not open a fresh allowance');
});

test('a login with no email falls back to the address alone', () => {
  const key = perAccountKey;
  assert.equal(key(req({ ip: '5.5.5.5' })), '5.5.5.5');
});
