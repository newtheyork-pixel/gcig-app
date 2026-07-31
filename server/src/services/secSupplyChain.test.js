import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, gatherPassages, scorePassage } from './secSupplyChain.js';

test('a regulator named all over a filing is not a customer', () => {
  const out = sanitize({
    summary: 's', concentration: null,
    customers: [
      { name: 'U.S. Department of Justice', pct: null, note: 'investigations' },
      { name: 'Food and Drug Administration', pct: null, note: 'approvals' },
      { name: 'McKesson', pct: 12, note: 'distributor' },
    ],
    suppliers: [], materials: [],
  });
  assert.deepEqual(out.customers.map((c) => c.name), ['McKesson']);
});

test('a government that genuinely buys survives on its stated percentage', () => {
  const out = sanitize({
    summary: 's', concentration: 'concentrated with the U.S. government',
    customers: [{ name: 'U.S. government', pct: 68, note: 'defense' }],
    suppliers: [], materials: [],
  });
  assert.equal(out.customers[0].pct, 68);
});

test('the concentration disclosure outranks the opening pages', () => {
  // A filing whose relationship language sits early and whose actual
  // disclosure sits late — the shape that lost General Dynamics its
  // customer list.
  const filler = Array.from({ length: 40 },
    (_, i) => `We serve customers across many markets and procure from suppliers in region ${i}, `
      + 'with distributors supporting our principal channels throughout the year worldwide.').join('\n');
  const gold = 'In 2025, 68% of our consolidated revenue was from the U.S. government, with the '
    + 'remainder from commercial customers.';
  const picked = gatherPassages(`${filler}\n${gold}`, 3000);
  assert.ok(picked.includes(gold), 'the quantified disclosure must survive the cap');
});

test('scoring prefers a stated percentage over generic relationship prose', () => {
  const generic = 'We rely on distributors and vendors to reach customers in many regions worldwide.';
  const quantified = 'One customer accounted for 14% of net sales in fiscal 2025.';
  assert.ok(scorePassage(quantified) > scorePassage(generic));
});
