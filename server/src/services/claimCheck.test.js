import test from 'node:test';
import assert from 'node:assert/strict';
import { entails } from './claimCheck.js';

// The checker's job is to catch the failure that wears a perfect
// citation. These tests pin its contract rather than the model's
// judgement — what it does with a verdict, what it refuses to do, and
// what it does when it cannot get one.

const saying = (obj) => async () => JSON.stringify(obj);

test('a rejection is a rejection', async () => {
  const v = await entails(saying({ supported: false }), null, 'the vendor comes once a week', 'The Lindt vendor comes weekly.');
  assert.equal(v.supported, false);
});

test('a narrowed answer comes back narrowed', async () => {
  const v = await entails(
    saying({ supported: true, partial: false, answer: 'The vendor comes once a week.' }),
    'How often are Lindt reps in the store?',
    'the vendor comes once a week',
    'The Lindt vendor comes once a week.'
  );
  assert.equal(v.answer, 'The vendor comes once a week.');
  assert.equal(v.partial, false);
});

test('anything other than an explicit yes is a no', async () => {
  // supported must be exactly true. A model answering "maybe", or
  // omitting the field, or wrapping it in a string, is not a pass — the
  // whole point is that this gate fails closed.
  for (const body of [{}, { supported: 'true' }, { supported: 1 }, { supported: null }, { partial: true }]) {
    const v = await entails(saying(body), null, 'quote here', 'claim here');
    assert.equal(v.supported, false, JSON.stringify(body));
  }
});

test('an unreachable or incoherent checker rejects', async () => {
  // An unverifiable claim is not a claim. Failing open here would be
  // worse than having no check at all, because the ledger would then
  // carry claims that look checked.
  for (const bad of [
    async () => null,
    async () => '',
    async () => 'not json at all',
    async () => { throw new Error('tunnel down'); },
  ]) {
    assert.equal((await entails(bad, null, 'quote here', 'claim here')).supported, false);
  }
});

test('nothing to check is not something that passes', async () => {
  let called = false;
  const spy = async () => { called = true; return JSON.stringify({ supported: true }); };
  assert.equal((await entails(spy, null, '', 'claim here')).supported, false);
  assert.equal((await entails(spy, null, 'quote here', '')).supported, false);
  assert.equal(called, false, 'should not have gone to the model at all');
});

test('context is passed through when given, and not fabricated when not', async () => {
  let seen = null;
  const spy = async ({ messages }) => { seen = messages; return JSON.stringify({ supported: true }); };
  await entails(spy, null, 'once a week', 'The Lindt vendor comes weekly.', 'Speaker 0: how often does Lindt restock?');
  assert.match(seen[1].content, /CONTEXT\nSpeaker 0: how often does Lindt restock\?/);
  await entails(spy, null, 'once a week', 'They come weekly.');
  assert.doesNotMatch(seen[1].content, /CONTEXT/);
});

test('a question is offered to the checker when there is one, and not invented when there is not', async () => {
  let seen = null;
  const spy = async ({ messages }) => {
    seen = messages;
    return JSON.stringify({ supported: true });
  };
  await entails(spy, 'How often do reps come?', 'once a week', 'They come weekly.');
  assert.match(seen[1].content, /QUESTION\nHow often do reps come\?/);

  await entails(spy, null, 'once a week', 'They come weekly.');
  assert.doesNotMatch(seen[1].content, /QUESTION/);
  // A standalone claim is read with no question beside it, so the
  // conversation around the quote is the only thing that can supply a
  // subject — and the checker is told to look there.
  assert.match(seen[0].content, /no question beside them|no question beside it/);
});
