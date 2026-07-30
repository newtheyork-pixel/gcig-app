import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, nativeChatURL } from './llm.js';

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
