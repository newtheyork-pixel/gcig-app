import test from 'node:test';
import assert from 'node:assert/strict';
import { screenTranscript, keywordScreen, RISK } from './mnpiScreen.js';

// Both directions of error are costly here. A screen that flags ordinary
// channel work teaches people to click through warnings, which is worse
// than no screen. A screen that misses a real disclosure is how a
// student's phone call becomes a securities problem.

const ORDINARY =
  'They cut our volume rebate by about 200 basis points in the second quarter. ' +
  'Our margin on the line went from roughly 14 percent to just under 12. ' +
  'Two of the regionals I know dropped the line entirely.';

const DISCLOSURE =
  'Look, this is confidential, but Q3 came in at 412 million, they have not ' +
  'announced it yet. The board has decided to take the guidance down.';

test('ordinary channel work does not trip the keyword pass', () => {
  assert.equal(keywordScreen(ORDINARY).length, 0);
});

test('a real disclosure trips several patterns', () => {
  const hits = keywordScreen(DISCLOSURE);
  assert.ok(hits.length >= 2, `expected multiple hits, got ${hits.length}`);
  assert.ok(hits.every((h) => h.why && h.excerpt), 'each hit explains itself');
});

test('hits carry surrounding context for the reviewer', () => {
  const [hit] = keywordScreen('Some preamble here. This is confidential, do not repeat it. More after.');
  assert.match(hit.excerpt, /confidential/);
  assert.ok(hit.excerpt.length > 'confidential'.length);
});

test('the keyword pass never throws on junk', () => {
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.doesNotThrow(() => keywordScreen(bad));
  }
});

test('ordinary interview screens low when the model agrees', async () => {
  const llmChat = async () => JSON.stringify({ risk: 'low', reason: 'Routine channel diligence' });
  const r = await screenTranscript(ORDINARY, {}, { llmChat });
  assert.equal(r.risk, RISK.LOW);
  assert.equal(r.modelAvailable, true);
});

test('a current employee starts elevated even on a clean transcript', async () => {
  // The relationship is itself the risk factor; the transcript can only
  // raise it.
  const llmChat = async () => JSON.stringify({ risk: 'low', reason: 'nothing found' });
  const r = await screenTranscript(ORDINARY, { relationship: 'CurrentEmployee' }, { llmChat });
  assert.equal(r.risk, RISK.ELEVATED);
});

test('the model can raise risk above the keyword floor', async () => {
  const llmChat = async () =>
    JSON.stringify({ risk: 'prohibited', reason: 'Specific unreleased revenue figure' });
  const r = await screenTranscript(ORDINARY, {}, { llmChat });
  assert.equal(r.risk, RISK.PROHIBITED);
  assert.match(r.reason, /unreleased/i);
});

test('the model can NEVER lower risk the keyword pass established', async () => {
  // A screen that can be talked out of a flag is not a screen.
  const llmChat = async () => JSON.stringify({ risk: 'low', reason: 'looks fine to me' });
  const r = await screenTranscript(DISCLOSURE, {}, { llmChat });
  assert.equal(r.risk, RISK.ELEVATED, 'keyword hits hold the floor');
  assert.ok(r.hits.length > 0);
});

test('a current employee flagged low by the model stays elevated', async () => {
  const llmChat = async () => JSON.stringify({ risk: 'low', reason: 'fine' });
  const r = await screenTranscript(ORDINARY, { relationship: 'CurrentEmployee' }, { llmChat });
  assert.equal(r.risk, RISK.ELEVATED);
});

test('a down model leaves the keyword floor standing and says so', async () => {
  for (const bad of [async () => null, async () => 'not json', async () => { throw new Error('down'); }]) {
    const r = await screenTranscript(DISCLOSURE, {}, { llmChat: bad });
    assert.equal(r.risk, RISK.ELEVATED, 'the deterministic pass still ran');
    assert.equal(r.modelAvailable, false, 'and the caller can tell it was only that');
  }
});

test('a low result reports whether the model actually ran', async () => {
  // Otherwise "low" reads as a clean bill of health when only the crude
  // pass happened.
  const r = await screenTranscript(ORDINARY, {}, { llmChat: async () => null });
  assert.equal(r.risk, RISK.LOW);
  assert.equal(r.modelAvailable, false);
});

test('an unknown risk value from the model is ignored, not trusted', async () => {
  const llmChat = async () => JSON.stringify({ risk: 'catastrophic', reason: 'x' });
  const r = await screenTranscript(ORDINARY, {}, { llmChat });
  assert.equal(r.risk, RISK.LOW);
  assert.equal(r.modelAvailable, false);
});

test('common non-MNPI phrasings stay clean', async () => {
  // These are the ones that would train people to ignore the warning.
  const benign = [
    'Lead times went from four weeks to nine weeks after the plant consolidation.',
    'I think they are losing share to the private label guys.',
    'We saw a four percent list price increase in January and it stuck.',
    'Their stores in my region always looked understaffed on weekends.',
  ];
  for (const t of benign) {
    assert.equal(keywordScreen(t).length, 0, `should not flag: ${t}`);
  }
});
