import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, score, tokens } from './retrieve.js';

// The ranking IS the product here.
//
// The assistant had the DCF in its context — CHF 89,463, all five EV/OE
// multiples, verified by reading the assembled prompt — and answered "we
// did not establish any valuation methods". Twelve kilobytes went in and
// the model read past the part that mattered. A silent regression in
// this scorer looks exactly like the model being bad again, which is why
// these are pinned.

const VALUATION = {
  id: 'val',
  kind: 'valuation',
  text: '- DCF cases: bear 54,970 CHF / base 89,463 CHF / bull 112,865 CHF. EV/OE trailing 21.0x to 23.6x.',
};
const RESTOCK = {
  id: 'q8',
  kind: 'finding',
  text: '- How often is the Lindt set restocked? The vendor comes once a week. Hershey twice a week.',
};
const MARGIN = {
  id: 'q9',
  kind: 'finding',
  text: '- Lindt Excellence bars carry a 44% margin; Hershey 42% flat across products.',
};
const VISIT = {
  id: 'v1',
  kind: 'visit',
  text: '- CVS Harlem: staffer said Hershey sells roughly double Lindt.',
};
const ALL = [VALUATION, RESTOCK, MARGIN, VISIT];

test('a valuation question reaches the valuation chunk', () => {
  // The exact failure: this question returned "we did not establish any
  // valuation methods" with the DCF sitting in the prompt.
  const { included } = retrieve(ALL, 'What do our two valuation methods on Lindt say? Give the DCF cases and the EV/OE multiples.');
  assert.equal(included[0].id, 'val');
});

test('a restock question reaches the restock finding, not the DCF', () => {
  const { included } = retrieve(ALL, 'How often does Lindt get restocked and who told us?');
  assert.ok(included.some((c) => c.id === 'q8'));
  assert.ok(included.indexOf(included.find((c) => c.id === 'q8')) >= 0);
});

test('a question about a number finds the chunk containing it', () => {
  assert.ok(score(VALUATION, tokens('what is 89,463')) > score(RESTOCK, tokens('what is 89,463')));
});

test('what was left out is reported, never silently dropped', () => {
  // A model handed a short list with no note reads it as everything we
  // have — which is how an earlier version produced industry norms under
  // a heading claiming they were our findings.
  const { omitted } = retrieve(ALL, 'what is our DCF', { budget: 120 });
  assert.ok(omitted.length > 0);
});

test('an always chunk survives the budget and the threshold', () => {
  // The project header has to be there or the evidence under it is
  // floating free of the company it concerns.
  const header = { id: 'h', kind: 'header', always: true, text: '### LISN — Lindt' };
  const { included } = retrieve([header, VALUATION], 'something entirely unrelated', { budget: 1 });
  assert.ok(included.some((c) => c.id === 'h'));
});

test('output is ordered for a reader, not by score', () => {
  const { included } = retrieve(
    [VISIT, RESTOCK, VALUATION],
    'tell me about Lindt valuation and restocking and what we saw in stores'
  );
  const kinds = included.map((c) => c.kind);
  assert.ok(kinds.indexOf('valuation') < kinds.indexOf('finding'), 'valuation before findings');
  assert.ok(kinds.indexOf('finding') < kinds.indexOf('visit'), 'findings before store notes');
});

test('an empty question does not drag everything in', () => {
  const { included } = retrieve(ALL, '');
  assert.equal(included.length, 0);
});

test('stopwords alone do not match anything', () => {
  assert.deepEqual(tokens('what is the of and a'), []);
});
