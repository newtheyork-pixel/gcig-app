import test from 'node:test';
import assert from 'node:assert/strict';
import { readableDescription, sanitize } from './companyDescription.js';

const ITEM1 = 'We are a global aerospace and defense company. '.repeat(12);

test('first person surviving is a rejection, not a description', () => {
  // The single most visible failure: the whole point is to stop the
  // panel reading like the brochure it was lifted from, so a paragraph
  // that still says "we" has failed at the only job it had.
  assert.equal(sanitize('We design and manufacture combat vehicles for defence customers worldwide, across four operating segments and a large services arm.'), null);
  assert.ok(sanitize('The company designs and manufactures combat vehicles for defence customers worldwide, across four operating segments and a large services arm.'));
});

test('a list is not a description, and neither is a refusal', () => {
  assert.equal(sanitize('- designs vehicles\n- builds ships\n- sells services to governments worldwide every year'), null);
  assert.equal(sanitize("I'm sorry, the document does not contain enough information to summarise this business properly."), null);
  assert.equal(sanitize('As an AI language model I cannot summarise the filing you have provided here today.'), null);
});

test('wrapping quotes and lead-ins are stripped, not rejected', () => {
  const out = sanitize('"Description: The company builds ships and combat vehicles for government customers across several continents."');
  assert.ok(out);
  assert.ok(!out.startsWith('"'));
  assert.ok(!/^description:/i.test(out));
});

test('too short is nothing, too long is trimmed at a word', () => {
  assert.equal(sanitize('Makes things.'), null);
  const long = sanitize('The company ' + 'makes industrial components and sells them to distributors. '.repeat(60));
  assert.ok(long.length <= 1201);
  assert.ok(long.endsWith('…'));
});

test('a thin filing produces nothing rather than a guess', async () => {
  // Below the floor there is not enough to rewrite, and inventing a
  // description from a fragment is exactly the failure the prompt spends
  // its first rule preventing.
  assert.equal(await readableDescription('GD', 'Short.'), null);
  assert.equal(await readableDescription('', ITEM1), null);
});

test('an unreachable model yields null, never a partial sentence', async () => {
  const out = await readableDescription('ZZZ1', ITEM1, {
    llmChat: async () => { throw new Error('local llm down'); },
  });
  assert.equal(out, null);
});

test('a good rewrite is returned with its provenance', async () => {
  const out = await readableDescription('ZZZ2', ITEM1, {
    llmChat: async () => 'The company designs and manufactures aerospace and defence equipment, '
      + 'operating through segments covering business aviation, marine systems and combat vehicles, '
      + 'and sells primarily to government customers.',
  });
  assert.ok(out.text.startsWith('The company designs'));
  assert.equal(out.source, 'sec-10k-item1');
});
