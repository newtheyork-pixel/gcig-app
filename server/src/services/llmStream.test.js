import test from 'node:test';
import assert from 'node:assert/strict';

// A stream arrives in whatever pieces the network chose, and Ollama's
// newline-delimited JSON does not respect them: a chunk boundary lands
// mid-object routinely. A parser that treats each chunk as a whole
// message silently loses every token that straddled one, which reads as
// a model that skips words rather than as a transport bug.
function chunkedBody(chunks) {
  return {
    ok: true,
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => (i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined }),
        };
      },
    },
    text: async () => '',
  };
}

const line = (c, done = false) => `${JSON.stringify({ message: { content: c }, done })}\n`;

test('tokens split across chunk boundaries are not lost', async () => {
  process.env.LOCAL_LLM_URL = 'http://local.test/v1';
  const { llmChatStreamLocal } = await import('./llm.js');

  const whole = line('Hello') + line(' world') + line('!', true);
  // Cut the stream in the worst place: mid-JSON-object, twice.
  const cut1 = Math.floor(whole.length * 0.3);
  const cut2 = Math.floor(whole.length * 0.72);
  const real = global.fetch;
  global.fetch = async () => chunkedBody([
    whole.slice(0, cut1), whole.slice(cut1, cut2), whole.slice(cut2),
  ]);
  try {
    const seen = [];
    const full = await llmChatStreamLocal({
      messages: [{ role: 'user', content: 'hi' }],
      onToken: (p) => seen.push(p),
    });
    assert.equal(full, 'Hello world!');
    assert.deepEqual(seen, ['Hello', ' world', '!']);
  } finally {
    global.fetch = real;
  }
});

test('a stream that produces nothing is a failure, not an empty answer', async () => {
  process.env.LOCAL_LLM_URL = 'http://local.test/v1';
  const { llmChatStreamLocal } = await import('./llm.js');
  const real = global.fetch;
  global.fetch = async () => chunkedBody(['\n', '{"done":true}\n']);
  try {
    // Silence must throw so the caller falls back, rather than saving an
    // empty assistant turn that reads as the model having nothing to say.
    await assert.rejects(
      () => llmChatStreamLocal({ messages: [{ role: 'user', content: 'hi' }] }),
      /no text/
    );
  } finally {
    global.fetch = real;
  }
});

test('a non-ok response throws rather than returning a partial', async () => {
  process.env.LOCAL_LLM_URL = 'http://local.test/v1';
  const { llmChatStreamLocal } = await import('./llm.js');
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, body: null, text: async () => 'busy' });
  try {
    await assert.rejects(
      () => llmChatStreamLocal({ messages: [{ role: 'user', content: 'hi' }] }),
      /503/
    );
  } finally {
    global.fetch = real;
  }
});

test('malformed lines are skipped without killing the stream', async () => {
  process.env.LOCAL_LLM_URL = 'http://local.test/v1';
  const { llmChatStreamLocal } = await import('./llm.js');
  const real = global.fetch;
  global.fetch = async () => chunkedBody([
    line('good'), 'this is not json\n', line(' more', true),
  ]);
  try {
    const full = await llmChatStreamLocal({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(full, 'good more');
  } finally {
    global.fetch = real;
  }
});
