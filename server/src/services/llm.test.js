import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextFor } from './llm.js';

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
