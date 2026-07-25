import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, stripInventedCitations, buildEvidence } from './synthesis.js';
import { COVERAGE } from './questionCoverage.js';

// A fabricated citation is worse than a missing one: it looks checkable
// and isn't, so a reader who spot-checks two real references trusts the
// rest. These tests pin the gate that removes them.

test('keeps citations that resolve to real evidence', () => {
  const { text, removed } = stripInventedCitations('Rebates fell [C47].', new Set([47]));
  assert.equal(text, 'Rebates fell [C47].');
  assert.equal(removed, 0);
});

test('strips a citation the model invented', () => {
  const { text, removed } = stripInventedCitations('Margins collapsed [C999].', new Set([47]));
  assert.equal(removed, 1);
  assert.ok(!text.includes('C999'));
  assert.ok(!text.includes('[]'), 'no empty bracket is left behind');
});

test('prunes only the invalid ids from a mixed group', () => {
  const { text, removed } = stripInventedCitations('Both [C47, C999] agree.', new Set([47]));
  assert.equal(removed, 1);
  assert.match(text, /\[C47\]/);
  assert.ok(!text.includes('C999'));
});

test('leaves ordinary prose brackets alone', () => {
  const src = 'The company [formerly Acme] restructured [C47].';
  const { text } = stripInventedCitations(src, new Set([47]));
  assert.match(text, /\[formerly Acme\]/);
  assert.match(text, /\[C47\]/);
});

test('cleans up the space a removed citation leaves before punctuation', () => {
  const { text } = stripInventedCitations('Rebates fell [C999].', new Set([47]));
  assert.equal(text, 'Rebates fell.');
});

test('handles junk input without throwing', () => {
  for (const bad of [null, undefined, '', 123]) {
    assert.doesNotThrow(() => stripInventedCitations(bad, new Set([1])));
  }
  assert.doesNotThrow(() => stripInventedCitations('x [C1]', null));
});

// ── evidence assembly ────────────────────────────────────────────────

const PROJECT = {
  name: 'Retail channel check',
  ticker: 'XYZ',
  brief: 'Are rebates being cut?',
  claims: [
    {
      id: 47, questionId: 1, kind: 'fact', text: 'Rebate cut 200bp in Q2',
      interview: { source: { alias: 'Fmr distributor', relationship: 'Distributor' } },
    },
    {
      id: 48, questionId: null, kind: 'opinion', text: 'They are losing the independents',
      interview: { source: { alias: 'Competitor rep', relationship: 'Competitor' } },
    },
  ],
  visits: [
    { location: 'Store 1247', dayPart: 'Sat 2pm', siteObservations: [{ text: 'Two facings gone' }] },
  ],
};

const COV = {
  questions: [
    { questionId: 1, text: 'Are rebates being cut?', coverage: COVERAGE.THIN, independentLines: 1, observationCount: 0, distinctLocations: 0 },
    { questionId: 2, text: 'Is traffic falling?', coverage: COVERAGE.UNADDRESSED, independentLines: 0, observationCount: 0, distinctLocations: 0 },
  ],
};

test('evidence block states support level per question', () => {
  const ev = buildEvidence(PROJECT, COV);
  assert.match(ev, /QUESTION 1: Are rebates being cut\?/);
  assert.match(ev, /SUPPORT: THIN/);
  assert.match(ev, /SUPPORT: NO EVIDENCE/);
});

test('a question with nothing behind it is shown as empty, not omitted', () => {
  // The most dangerous memo is the one that reads complete because the
  // holes were left out.
  const ev = buildEvidence(PROJECT, COV);
  assert.match(ev, /QUESTION 2: Is traffic falling\?/);
  assert.match(ev, /\(no evidence gathered\)/);
});

test('claim kind and source relationship reach the model', () => {
  // "a former distributor stated" and "a competitor speculated" are not
  // the same sentence, and the model cannot tell them apart unaided.
  const ev = buildEvidence(PROJECT, COV);
  assert.match(ev, /C47 \[fact\] \(Fmr distributor, Distributor\)/);
});

test('evidence answering no question is passed along, not dropped', () => {
  const ev = buildEvidence(PROJECT, COV);
  assert.match(ev, /EVIDENCE NOT LINKED TO ANY QUESTION/);
  assert.match(ev, /C48/);
});

test('direct observations are labelled as seen, not reported', () => {
  const ev = buildEvidence(PROJECT, COV);
  assert.match(ev, /DIRECT OBSERVATIONS/);
  assert.match(ev, /Store 1247 \(Sat 2pm\): Two facings gone/);
});

// ── synthesis ────────────────────────────────────────────────────────

test('refuses to draft when there is no evidence at all', async () => {
  const out = await synthesize({ name: 'x', claims: [], visits: [] }, COV, {
    llmChat: async () => { throw new Error('must not be called'); },
  });
  assert.equal(out.unavailable, true);
  assert.match(out.reason, /no evidence/i);
});

test('will draft from observations alone, with no interviews', async () => {
  let called = false;
  const out = await synthesize(
    { name: 'x', claims: [], visits: PROJECT.visits },
    COV,
    { llmChat: async () => { called = true; return 'Store checks found gaps.'; } }
  );
  assert.equal(called, true);
  assert.equal(out.draft, 'Store checks found gaps.');
});

test('invented citations are removed from the draft and counted', async () => {
  const out = await synthesize(PROJECT, COV, {
    llmChat: async () => 'Rebates fell [C47] and margins collapsed [C999].',
  });
  assert.equal(out.removedCitations, 1);
  assert.ok(!out.draft.includes('C999'));
  assert.match(out.draft, /\[C47\]/);
});

test('a down model degrades to unavailable rather than an empty memo', async () => {
  const out = await synthesize(PROJECT, COV, { llmChat: async () => null });
  assert.equal(out.unavailable, true);
  assert.equal(out.draft, null);
});

test('counts how many distinct claims the draft actually rests on', async () => {
  const out = await synthesize(PROJECT, COV, {
    llmChat: async () => 'One [C47]. Two [C48]. Again [C47].',
  });
  assert.equal(out.citedCount, 2, 'distinct ids, not total references');
  assert.equal(out.evidenceCount, 2);
});
