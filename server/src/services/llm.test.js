import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, nativeChatURL, extractJson } from './llm.js';

// Ollama defaults to 2048 tokens and truncates from the front, taking the
// system prompt with it. That turned every long-transcript screen into a
// model that answered {} without ever seeing its instructions, which the
// callers correctly read as "unavailable" and quietly downgraded to their
// keyword floor. These pin the sizing so it cannot regress to the default.
describe('contextFor', () => {
  it('never asks for less than a usable window', () => {
    assert.equal(contextFor([{ content: 'hi' }]), 4096);
  });

  it('covers a full-length interview transcript', () => {
    // 30k chars is the slice mnpiScreen sends. It measured 9,339 real
    // tokens, so anything at or above that is enough to read the whole
    // prompt; the default 2048 was not.
    const n = contextFor([{ content: 'x'.repeat(30_000) }]);
    assert.ok(n >= 9339, `expected room for the real prompt, got ${n}`);
  });

  it('clamps rather than asking for a window the box cannot hold', () => {
    assert.equal(contextFor([{ content: 'x'.repeat(500_000) }]), 16_384);
  });

  it('counts every message, not just the last one', () => {
    const split = contextFor([{ content: 'x'.repeat(15_000) }, { content: 'x'.repeat(15_000) }]);
    assert.equal(split, contextFor([{ content: 'x'.repeat(30_000) }]));
  });
});

// The compat endpoint silently ignores num_ctx: measured twice on the same
// 9,339-token prompt, it reported 2,050 evaluated and returned {}, even
// straight after the model had been loaded at 16k. Only Ollama's own
// endpoint honours the window, so the local path has to reach it.
describe('nativeChatURL', () => {
  it('drops the OpenAI-compat suffix', () => {
    assert.equal(nativeChatURL('https://llm.example.org/v1'), 'https://llm.example.org/api/chat');
  });

  it('works when the base has no suffix', () => {
    assert.equal(nativeChatURL('https://llm.example.org'), 'https://llm.example.org/api/chat');
  });

  it('is nothing when no local endpoint is configured', () => {
    assert.equal(nativeChatURL(''), null);
  });
});

// Qwen appends a bare <tool_call> sentinel after the closing brace when no
// tools were offered. Every caller does JSON.parse and catches the throw by
// falling back, so a good verdict was being recorded as "model unavailable".
describe('extractJson', () => {
  it('drops a trailing tool-call sentinel', () => {
    const raw = '{"risk":"low","reason":"fine"}<tool_call>';
    assert.deepEqual(JSON.parse(extractJson(raw)), { risk: 'low', reason: 'fine' });
  });

  it('survives braces inside quoted excerpts', () => {
    const raw = '{"quote":"he said {this} and }that{","ok":true} trailing junk';
    assert.deepEqual(JSON.parse(extractJson(raw)), { quote: 'he said {this} and }that{', ok: true });
  });

  it('handles escaped quotes inside strings', () => {
    const raw = '{"excerpts":["\\"Hershey?\\",\\"Way more?\\""]}<tool_call>';
    assert.equal(JSON.parse(extractJson(raw)).excerpts.length, 1);
  });

  it('unwraps a fenced code block', () => {
    assert.deepEqual(JSON.parse(extractJson('```json\n{"a":1}\n```')), { a: 1 });
  });

  it('takes arrays too', () => {
    assert.deepEqual(JSON.parse(extractJson('[1,2,3] and then some words')), [1, 2, 3]);
  });

  it('leaves an unbalanced value alone so the parse fails honestly', () => {
    assert.equal(extractJson('{"a":1'), '{"a":1');
  });
});
