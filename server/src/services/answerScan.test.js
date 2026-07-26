import test from 'node:test';
import assert from 'node:assert/strict';
import { scanForAnswer } from './answerScan.js';

// The scan asks one question against a transcript, which makes it more
// suggestible than the general extractor — it has been told what it is
// hoping to find. These tests pin the places that suggestibility could
// turn into a fabricated citation, and the places where a real answer
// must not be thrown away.

// "how many boxes do you put back" / "pack the whole thing" — the
// exchange that started this. One word per 500ms.
const WORDS = [
  { text: 'How', startMs: 0, endMs: 400, speaker: 'speaker_1' },
  { text: 'many', startMs: 500, endMs: 900, speaker: 'speaker_1' },
  { text: 'boxes', startMs: 1000, endMs: 1400, speaker: 'speaker_1' },
  { text: 'do', startMs: 1500, endMs: 1900, speaker: 'speaker_1' },
  { text: 'you', startMs: 2000, endMs: 2400, speaker: 'speaker_1' },
  { text: 'put', startMs: 2500, endMs: 2900, speaker: 'speaker_1' },
  { text: 'back?', startMs: 3000, endMs: 3400, speaker: 'speaker_1' },
  { text: 'Pack', startMs: 4000, endMs: 4400, speaker: 'speaker_2' },
  { text: 'the', startMs: 4500, endMs: 4900, speaker: 'speaker_2' },
  { text: 'whole', startMs: 5000, endMs: 5400, speaker: 'speaker_2' },
  { text: 'thing.', startMs: 5500, endMs: 5900, speaker: 'speaker_2' },
];
const TURNS = [
  { speaker: 'speaker_1', text: 'How many boxes do you put back?' },
  { speaker: 'speaker_2', text: 'Pack the whole thing.' },
];
const IV = { words: WORDS, turns: TURNS };
const Q = 'When restocking, how many units go back on the shelf?';

// Two model passes run per window — find the answer, then check the
// answer is what the quote says — so a stub has to answer both. Default
// the checker to "supported" so each test exercises the one thing it is
// about.
const isCheck = (m) => /checking whether a proposed answer/.test(m[0].content);
const reply = (scan, check = { supported: true }) => async ({ messages }) =>
  JSON.stringify(isCheck(messages) ? check : scan);

test('pins a located answer to its real span and speaker', async () => {
  const hit = await scanForAnswer(IV, Q, {
    llmChat: reply({
      found: true,
      answer: 'They refill to capacity.',
      quote: 'Pack the whole thing.',
      confidence: 0.9,
    }),
  });
  assert.equal(hit.startMs, 4000);
  assert.equal(hit.endMs, 5900);
  assert.equal(hit.speaker, 'speaker_2');
  assert.equal(hit.partial, false);
});

test('drops an answer whose quote is not in the tape', async () => {
  // The whole point. Told what answer to look for, a model will
  // sometimes produce a plausible one — "about a dozen" is exactly the
  // shape of reply this question invites, and nobody said it.
  const hit = await scanForAnswer(IV, Q, {
    llmChat: reply({
      found: true,
      answer: 'They put back about a dozen.',
      quote: 'we put back about a dozen',
      confidence: 0.95,
    }),
  });
  assert.equal(hit, null);
});

test('a partial answer is kept, and marked partial', async () => {
  // Half of a compound question answered is evidence. Discarding it
  // makes the question look like one nobody was ever asked.
  const hit = await scanForAnswer(IV, Q, {
    llmChat: reply({
      found: true,
      answer: 'They refill to capacity, but did not split it by brand.',
      quote: 'Pack the whole thing.',
      partial: true,
      confidence: 0.8,
    }),
  });
  assert.equal(hit.partial, true);
});

test('a whole answer beats a more confident partial one', async () => {
  // A model is often surest about the easy half, so ranking on
  // confidence alone would let a fragment outrank the full answer.
  // Long enough to split into two windows, which is what gives the scan
  // two replies to choose between.
  const long = { words: WORDS, turns: [...TURNS, ...Array.from({ length: 400 }, () => ({ speaker: 'speaker_1', text: 'and so on and so forth' }))] };
  let n = 0;
  const hit = await scanForAnswer(long, Q, {
    llmChat: async ({ messages }) => {
      if (isCheck(messages)) return JSON.stringify({ supported: true });
      n += 1;
      return JSON.stringify(
        n === 1
          ? { found: true, answer: 'half of it', quote: 'Pack the', partial: true, confidence: 0.99 }
          : { found: true, answer: 'all of it', quote: 'Pack the whole thing.', partial: false, confidence: 0.6 }
      );
    },
  });
  assert.ok(n > 1, 'expected more than one window');
  assert.equal(hit.partial, false);
  assert.equal(hit.text, 'all of it');
});

test('drops a claim the quote does not actually say', async () => {
  // The real failure this gate exists for. Every word of the quote was
  // spoken and locates cleanly; the Hershey comparison in the claim
  // above it was invented. locateQuote cannot catch this — the citation
  // is perfect, which is exactly what makes it dangerous.
  const hit = await scanForAnswer(
    IV,
    'When restocking, how many Lindt units go back up versus Hershey?',
    {
      llmChat: reply(
        {
          found: true,
          answer: 'Lindt refills to capacity while Hershey restocks more often and in larger quantities.',
          quote: 'Pack the whole thing.',
          confidence: 0.9,
        },
        { supported: false }
      ),
    }
  );
  assert.equal(hit, null);
});

test('the checker may narrow an overstated claim, and may add caution', async () => {
  const hit = await scanForAnswer(IV, Q, {
    llmChat: reply(
      { found: true, answer: 'They put back twelve units.', quote: 'Pack the whole thing.', partial: false, confidence: 0.9 },
      { supported: true, partial: true, answer: 'They refill to capacity.' }
    ),
  });
  assert.equal(hit.text, 'They refill to capacity.');
  // Neither pass may talk the other out of its caution.
  assert.equal(hit.partial, true);
});

test('an unreachable checker rejects rather than waves through', async () => {
  for (const bad of [async () => null, async () => 'not json', async () => { throw new Error('down'); }]) {
    const hit = await scanForAnswer(IV, Q, {
      llmChat: async ({ messages }) =>
        isCheck(messages)
          ? bad()
          : JSON.stringify({ found: true, answer: 'They refill to capacity.', quote: 'Pack the whole thing.', confidence: 0.9 }),
    });
    assert.equal(hit, null);
  }
});

test('a model that answers nothing is not an answer', async () => {
  assert.equal(await scanForAnswer(IV, Q, { llmChat: reply({ found: false }) }), null);
  assert.equal(await scanForAnswer(IV, Q, { llmChat: async () => null }), null);
  assert.equal(await scanForAnswer(IV, Q, { llmChat: async () => 'not json' }), null);
  // found:true with nothing behind it is the same as no answer.
  assert.equal(await scanForAnswer(IV, Q, { llmChat: reply({ found: true }) }), null);
});

test('a provider that throws does not take the scan down with it', async () => {
  const hit = await scanForAnswer(IV, Q, {
    llmChat: async () => { throw new Error('tunnel down'); },
  });
  assert.equal(hit, null);
});

test('no transcript and no question are both no-ops', async () => {
  assert.equal(await scanForAnswer({ words: [], turns: [] }, Q, { llmChat: reply({}) }), null);
  assert.equal(await scanForAnswer(IV, '', { llmChat: reply({}) }), null);
});
