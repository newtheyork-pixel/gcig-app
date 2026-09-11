import test from 'node:test';
import assert from 'node:assert/strict';
import { inferOutcome } from './callOutcome.js';

// The failure worth designing against: an outcome nobody could
// establish being filed as NoAnswer. That value flatters the refusal
// rate and is indistinguishable, afterwards, from a store that really
// did not pick up.

const chatReturning = (payload) => async () => JSON.stringify(payload);

test('the phone settles a ring-out without asking a model to read silence', async () => {
  let asked = false;
  const out = await inferOutcome(
    { transcript: '', record: { answered: false, durationMs: 0 } },
    { llmChat: async () => { asked = true; return null; } }
  );
  assert.equal(out.outcome, 'NoAnswer');
  assert.equal(out.source, 'callrecord');
  assert.equal(asked, false, 'no model call is needed or made');
});

test('no transcript and nothing from the phone is UNESTABLISHED, not NoAnswer', async () => {
  // A recorder that failed and a store that never picked up produce the
  // same emptiness. Guessing between them invents a data point.
  const out = await inferOutcome({ transcript: '', record: null }, { llmChat: async () => null });
  assert.equal(out.outcome, null);
  assert.equal(out.source, 'none');
  assert.match(out.reason, /unestablished/);
});

test('a refusal is read as a refusal', async () => {
  const out = await inferOutcome(
    { transcript: "we're not allowed to discuss pricing over the phone" },
    { llmChat: chatReturning({ outcome: 'Refused', confidence: 0.9, reason: 'declined to discuss pricing' }) }
  );
  assert.equal(out.outcome, 'Refused');
  assert.equal(out.confidence, 0.9);
  assert.equal(out.source, 'model');
});

test('a model that did not answer is not a finding', async () => {
  const out = await inferOutcome(
    { transcript: 'the one and a half is 4,999' },
    { llmChat: async () => { throw new Error('tunnel down'); } }
  );
  assert.equal(out.outcome, null);
  assert.equal(out.modelAvailable, false);
  assert.match(out.reason, /unavailable/);
});

test('an outcome outside the list is refused rather than stored', async () => {
  for (const bad of [{ outcome: 'Maybe' }, { outcome: '' }, { nope: 1 }]) {
    const out = await inferOutcome({ transcript: 'hello' }, { llmChat: chatReturning(bad) });
    assert.equal(out.outcome, null, JSON.stringify(bad));
  }
});

test('unparseable output does not throw', async () => {
  const out = await inferOutcome({ transcript: 'hello' }, { llmChat: async () => 'not json at all' });
  assert.equal(out.outcome, null);
});

test('confidence is clamped, because a model will hand you 1.4', async () => {
  const out = await inferOutcome(
    { transcript: 'hello' },
    { llmChat: chatReturning({ outcome: 'Answered', confidence: 1.4 }) }
  );
  assert.equal(out.confidence, 1);
});

test('an answered call with a transcript still goes to the model', async () => {
  // The phone knows somebody picked up; only the transcript knows
  // whether they talked, refused, or were an answering machine.
  const out = await inferOutcome(
    { transcript: 'you have reached Kay Jewelers, our hours are', record: { answered: true } },
    { llmChat: chatReturning({ outcome: 'Voicemail', confidence: 0.95, reason: 'recorded message' }) }
  );
  assert.equal(out.outcome, 'Voicemail');
});
