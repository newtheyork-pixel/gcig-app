import test from 'node:test';
import assert from 'node:assert/strict';
import { regimeFor, ALL_PARTY_PHONE_STATES } from './recordingConsent.js';

// The bias under test: every ambiguity resolves toward all-party, which
// costs a deleted recording and never costs an unlawful one.

test('both ends one-party keeps the tape', () => {
  assert.equal(regimeFor({ storeState: 'OH' }).regime, 'one-party');
  assert.equal(regimeFor({ storeState: 'TX', callerState: 'NY' }).regime, 'one-party');
});

test('either end being all-party is enough', () => {
  // A call from New York to California touches both states. Reading only
  // the end you happened to think of picks whichever answer is convenient.
  assert.equal(regimeFor({ storeState: 'CA', callerState: 'NY' }).regime, 'all-party');
  assert.equal(regimeFor({ storeState: 'OH', callerState: 'CA' }).regime, 'all-party');
  assert.equal(regimeFor({ storeState: 'IL', callerState: 'IL' }).regime, 'all-party');
});

test('a store with no state recorded is treated as the strict case', () => {
  const r = regimeFor({ storeState: null });
  assert.equal(r.regime, 'all-party');
  assert.equal(r.unknownEnd, true);
  assert.match(r.reason, /No state recorded/);
});

test('junk in the state field is not a state', () => {
  for (const junk of ['', '  ', 'Ohio', 'O', 'OHIO', '12', undefined]) {
    assert.equal(regimeFor({ storeState: junk }).regime, 'all-party', JSON.stringify(junk));
  }
});

test('case and whitespace do not change the answer', () => {
  assert.equal(regimeFor({ storeState: ' ca ' }).regime, 'all-party');
  assert.equal(regimeFor({ storeState: 'oh' }).regime, 'one-party');
});

test('the phone-call list is the phone-call list', () => {
  // Connecticut and Nevada are all-party BY PHONE while allowing
  // one-party in person, so they belong here. Missouri and Oregon are
  // the mirror image and must not.
  for (const s of ['CT', 'NV']) assert.ok(ALL_PARTY_PHONE_STATES.has(s), s);
  for (const s of ['MO', 'OR']) assert.ok(!ALL_PARTY_PHONE_STATES.has(s), s);
  // Hawaii and Maine are all-party only in private places, which a
  // retail store's published number is not.
  for (const s of ['HI', 'ME']) assert.ok(!ALL_PARTY_PHONE_STATES.has(s), s);
  assert.equal(ALL_PARTY_PHONE_STATES.size, 13);
});

test('the reason says which state forced it, because a person has to check', () => {
  assert.match(regimeFor({ storeState: 'CA' }).reason, /CA requires/);
  assert.match(regimeFor({ storeState: 'CA', callerState: 'IL' }).reason, /require/);
});
