import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementMetrics, grokPromptFor, parseGrokVerdict } from './outreachLabeling.js';
import { SYSTEM_PROMPT } from '../services/outreachScreen.js';

// The live loop measures where the screen and GROK disagree, and which way
// the screen erred. Over-flagging (the screen stricter than Grok) is the
// failure that started this: it is how a flag becomes noise people click
// past. Under-flagging is the screen laxer than Grok. The arithmetic that
// separates them is worth pinning.

test('perfect agreement counts every row and no error either way', () => {
  const m = agreementMetrics([
    { screenRisk: 'low', humanRisk: 'low', grokRisk: 'low' },
    { screenRisk: 'elevated', humanRisk: 'elevated', grokRisk: 'elevated' },
  ]);
  assert.equal(m.total, 2);
  assert.equal(m.screenVsGrok.compared, 2);
  assert.equal(m.screenVsGrok.agree, 2);
  assert.equal(m.screenVsGrok.overFlag, 0);
  assert.equal(m.screenVsGrok.underFlag, 0);
  assert.equal(m.screenVsHuman.agree, 2);
});

test('the screen calling low drafts elevated is counted as over-flagging', () => {
  // These are the four PetSmart/jewellery drafts: the screen said elevated,
  // Grok says low.
  const m = agreementMetrics([
    { screenRisk: 'elevated', grokRisk: 'low' },
    { screenRisk: 'elevated', grokRisk: 'low' },
    { screenRisk: 'prohibited', grokRisk: 'low' },
  ]);
  assert.equal(m.screenVsGrok.overFlag, 3);
  assert.equal(m.screenVsGrok.underFlag, 0);
  assert.equal(m.screenVsGrok.agree, 0);
});

test('the screen missing a real flag is counted as under-flagging', () => {
  const m = agreementMetrics([
    { screenRisk: 'low', grokRisk: 'prohibited' },
    { screenRisk: 'elevated', grokRisk: 'prohibited' },
  ]);
  assert.equal(m.screenVsGrok.underFlag, 2);
  assert.equal(m.screenVsGrok.overFlag, 0);
});

test('a missing screen or grok verdict is skipped, not scored as agreement', () => {
  const m = agreementMetrics([
    { screenRisk: null, grokRisk: 'low' },
    { screenRisk: 'low', grokRisk: 'low' },
  ]);
  assert.equal(m.total, 2);
  assert.equal(m.screenVsGrok.compared, 1, 'the null-screen row is not compared');
  assert.equal(m.screenVsGrok.agree, 1);
});

test('the optional human column is scored separately from Grok', () => {
  const m = agreementMetrics([
    { screenRisk: 'elevated', grokRisk: 'low', humanRisk: 'low' }, // both say the screen over-flagged
    { screenRisk: 'elevated', grokRisk: 'low' }, // Grok only, no human weighed in
  ]);
  assert.equal(m.screenVsGrok.compared, 2);
  assert.equal(m.screenVsGrok.overFlag, 2);
  assert.equal(m.screenVsHuman.compared, 1, 'only the row with a human verdict counts');
  assert.equal(m.screenVsHuman.overFlag, 1);
});

test('a row Grok never graded contributes nothing but the total', () => {
  const m = agreementMetrics([{ screenRisk: 'elevated', grokRisk: undefined }]);
  assert.equal(m.total, 1);
  assert.equal(m.screenVsGrok.compared, 0);
  assert.equal(m.screenVsHuman.compared, 0);
});

test("Grok's verdict is parsed out of the pasted reply, no retyping", () => {
  // The strict-JSON happy path.
  const clean = parseGrokVerdict('{"risk":"low","reason":"Ordinary published-work outreach","concerns":[]}');
  assert.equal(clean.risk, 'low');
  assert.match(clean.reason, /published-work/);

  // Wrapped in a code fence and prose, the way a chat model tends to answer.
  const fenced = parseGrokVerdict('Sure — here you go:\n```json\n{"risk":"elevated","reason":"asks a sitting exec"}\n```\nHope that helps!');
  assert.equal(fenced.risk, 'elevated');
  assert.match(fenced.reason, /sitting exec/);

  // No JSON at all, just a sentence: fall back to the bare verdict word.
  assert.equal(parseGrokVerdict('I would call this prohibited, honestly.').risk, 'prohibited');

  // Nothing legible: risk is null so the caller refuses to save it.
  assert.equal(parseGrokVerdict('no idea, sorry').risk, null);
  assert.equal(parseGrokVerdict('').risk, null);
  assert.equal(parseGrokVerdict(null).risk, null);

  // An unknown risk value in otherwise-valid JSON is not trusted.
  assert.equal(parseGrokVerdict('{"risk":"catastrophic"}').risk, null);
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

