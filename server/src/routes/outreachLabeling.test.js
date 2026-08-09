import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementMetrics, grokPromptFor } from './outreachLabeling.js';
import { SYSTEM_PROMPT } from '../services/outreachScreen.js';

// The whole point of the labeling tool is to measure where the screen and
// a human disagree, and which way the screen erred. Over-flagging — the
// screen stricter than the truth — is the failure that started this: it is
// how a flag becomes noise people click past. Under-flagging is the screen
// missing what a person caught. The arithmetic that separates them is
// worth pinning.

test('perfect agreement counts every row and no error either way', () => {
  const m = agreementMetrics([
    { screenRisk: 'low', humanRisk: 'low', grokRisk: 'low' },
    { screenRisk: 'elevated', humanRisk: 'elevated', grokRisk: 'elevated' },
  ]);
  assert.equal(m.total, 2);
  assert.equal(m.screen.compared, 2);
  assert.equal(m.screen.agree, 2);
  assert.equal(m.screen.overFlag, 0);
  assert.equal(m.screen.underFlag, 0);
  assert.equal(m.grok.agree, 2);
});

test('the screen calling low drafts elevated is counted as over-flagging', () => {
  // These are the four PetSmart/jewellery drafts: the screen said elevated,
  // the human says low.
  const m = agreementMetrics([
    { screenRisk: 'elevated', humanRisk: 'low' },
    { screenRisk: 'elevated', humanRisk: 'low' },
    { screenRisk: 'prohibited', humanRisk: 'low' },
  ]);
  assert.equal(m.screen.overFlag, 3);
  assert.equal(m.screen.underFlag, 0);
  assert.equal(m.screen.agree, 0);
});

test('the screen missing a real flag is counted as under-flagging', () => {
  const m = agreementMetrics([
    { screenRisk: 'low', humanRisk: 'prohibited' },
    { screenRisk: 'elevated', humanRisk: 'prohibited' },
  ]);
  assert.equal(m.screen.underFlag, 2);
  assert.equal(m.screen.overFlag, 0);
});

test('a missing screen or grok verdict is skipped, not scored as agreement', () => {
  const m = agreementMetrics([
    { screenRisk: null, humanRisk: 'low', grokRisk: null },
    { screenRisk: 'low', humanRisk: 'low' },
  ]);
  assert.equal(m.total, 2);
  assert.equal(m.screen.compared, 1, 'the null-screen row is not compared');
  assert.equal(m.screen.agree, 1);
  assert.equal(m.grok.compared, 0, 'no grok verdict anywhere to compare');
});

test('a row with no human verdict contributes nothing but the total', () => {
  const m = agreementMetrics([{ screenRisk: 'elevated', humanRisk: undefined, grokRisk: 'low' }]);
  assert.equal(m.total, 1);
  assert.equal(m.screen.compared, 0);
  assert.equal(m.grok.compared, 0);
});

test('the Grok prompt carries the ENTIRE screen prompt, self-contained', () => {
  // Grok has no system message and none of our context, so the copied
  // block has to be everything the model was given — the full rules and
  // this one email — or Grok is grading a different task than the screen.
  const draft = {
    subject: 'Your time at PetSmart',
    body: 'How did the private-label buying process work while you were there?',
    target: { name: 'A. Rivera', relationship: 'FormerEmployee', employer: 'Retired' },
  };
  const p = grokPromptFor(draft);
  // The complete instructions travel verbatim, including the binding rules
  // the calibration fix added and the JSON reply format.
  assert.ok(p.includes(SYSTEM_PROMPT), 'the whole SYSTEM_PROMPT is present, unabridged');
  assert.match(p, /return low unless/);
  assert.match(p, /Reply with strict JSON only/);
  // And the specific email + recipient, so it grades these exact words.
  assert.match(p, /A\. Rivera/);
  assert.match(p, /FormerEmployee/);
  assert.match(p, /Your time at PetSmart/);
  assert.match(p, /while you were there/);
});

test('a draft with no target still yields a complete, unambiguous prompt', () => {
  const p = grokPromptFor({ subject: 'Hi', body: 'Body text', target: null });
  assert.ok(p.includes(SYSTEM_PROMPT));
  assert.match(p, /Recipient: unknown/);
  assert.match(p, /Subject: Hi/);
  assert.match(p, /Body text/);
});

test('grok is scored independently of the screen', () => {
  const m = agreementMetrics([
    { screenRisk: 'elevated', humanRisk: 'low', grokRisk: 'low' }, // screen over-flags, grok agrees with human
  ]);
  assert.equal(m.screen.overFlag, 1);
  assert.equal(m.grok.agree, 1);
  assert.equal(m.grok.disagree, 0);
});
