import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSections } from './clubBrief.js';

// Assembling only what the question needs.
//
// The whole brief used to ship on every message. At ~40 KB the local
// model stopped answering what it was asked and answered from whichever
// block was biggest — asked the price of Apple it fetched the quote
// correctly, then wrote three paragraphs on JNJ litigation.

const SECTIONS = [
  { id: 'portfolio', title: '### Portfolio', body: 'AIT 16 shares', always: true, topics: ['holding'] },
  { id: 'news', title: '### News', body: 'JNJ talc verdict '.repeat(200), topics: ['news', 'latest'] },
  { id: 'macro', title: '### Macro', body: '10Y 4.71%', topics: ['rate', 'inflation'] },
  { id: 'roster', title: '### Members', body: 'Thomas — President', always: true, topics: ['who'] },
];

test('an unrelated question does not drag the news block in', () => {
  const out = selectSections(SECTIONS, 'what is the price of Apple');
  assert.ok(!out.includes('talc'), 'news must stay out');
  assert.ok(out.includes('AIT 16 shares'), 'portfolio is always in');
  assert.ok(out.includes('Thomas — President'), 'roster is always in');
});

test('asking for it pulls it in', () => {
  assert.ok(selectSections(SECTIONS, 'any news on our holdings?').includes('talc'));
  assert.ok(selectSections(SECTIONS, 'what are rates doing').includes('10Y 4.71%'));
});

test('what was left out is named, not silently dropped', () => {
  // The failure this guards: a prompt quietly missing the news block
  // looks to the model exactly like a club with no news.
  const out = selectSections(SECTIONS, 'what is the price of Apple');
  assert.ok(out.includes('Not loaded for this question'));
  assert.ok(out.includes('News'));
  assert.ok(/do NOT answer from memory/i.test(out));
});

test('a long section cannot push out an always-on one', () => {
  // Budget governs the optional sections only. If a heavy news day
  // could evict the roster, the assistant would start saying it does
  // not know who anyone is.
  const huge = [...SECTIONS, { id: 'big', title: '### Big', body: 'x'.repeat(50_000), topics: ['news'] }];
  const out = selectSections(huge, 'news please');
  assert.ok(out.includes('Thomas — President'), 'roster survives');
  assert.ok(out.includes('AIT 16 shares'), 'portfolio survives');
  assert.ok(out.includes('Not loaded'), 'and the evicted one is named');
});

test('naming a ticker pulls in the section about it', () => {
  const withTickers = [{ id: 'intel', title: '### Intel', body: 'JNJ coverage note', tickers: ['JNJ'] }];
  assert.ok(selectSections(withTickers, 'tell me about JNJ').includes('JNJ coverage note'));
  assert.ok(!selectSections(withTickers, 'tell me about Apple').includes('JNJ coverage note'));
});

// Policy gating. The IPS and Internal Policies are ~10 KB and were
// going in on every message — dead weight in front of "what is Apple
// trading at", which is the question the assistant kept failing by
// answering from whatever else was in the prompt.
import { getClubSystemPrompt } from './clubBrief.js';

test('a price question does not carry the policy documents', async () => {
  const p = await getClubSystemPrompt({ topic: 'what is the price of Apple' });
  assert.ok(!/Investment Policy Statement\n\n[A-Za-z]/.test(p), 'IPS body must be absent');
  // And absence is stated, not silent — otherwise the model invents a
  // rule when someone follows up about voting.
  assert.match(p, /not loaded for this question/i);
  assert.match(p, /do NOT state a rule from memory/i);
});

test('a policy question carries them in full', async () => {
  const p = await getClubSystemPrompt({ topic: 'what is the quorum for a vote?' });
  assert.match(p, /# Reference: Investment Policy Statement/);
  assert.match(p, /# Reference: Internal Club Policies/);
});

// The prompt must not advertise a capability the process does not have.
test('the prompt only claims a capability the process actually has', async () => {
  // The bug this pins: the Tools section was unconditional, so with
  // tools disabled the model was told "you can fetch things rather than
  // guessing" — and then reported a cached portfolio price as
  // "currently trading at" because it had nothing to fetch with.
  const prev = process.env.AI_CHAT_TOOLS;
  try {
    process.env.AI_CHAT_TOOLS = '0';
    const off = await getClubSystemPrompt({ topic: 'what is AIT trading at', forceFresh: true });
    assert.match(off, /You cannot look anything up/);
    assert.match(off, /as of our last sync/);
    assert.ok(!/You can fetch things rather than guessing/.test(off));

    delete process.env.AI_CHAT_TOOLS;
    const on = await getClubSystemPrompt({ topic: 'what is AIT trading at', forceFresh: true });
    assert.match(on, /get_quote/);
    assert.ok(!/You cannot look anything up/.test(on));
  } finally {
    if (prev === undefined) delete process.env.AI_CHAT_TOOLS;
    else process.env.AI_CHAT_TOOLS = prev;
  }
});
