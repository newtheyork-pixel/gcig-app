import { API_BASE } from './client.js';

// Read a chat answer as it is written.
//
// Not axios and not EventSource. Axios buffers the whole body, which is
// the exact thing being avoided; EventSource cannot carry an
// Authorization header and this route is authenticated. fetch plus a
// reader is the only combination that does both.
//
// Returns the final { sessionId, title } when the answer completed, or
// null when the server declined to stream — the caller then falls back
// to the ordinary blocking POST rather than showing nothing.
export async function streamReply(message, { sessionId, onOpen, onToken, onRetract } = {}) {
  const token = localStorage.getItem('gcig_token');
  let res;
  try {
    res = await fetch(`${API_BASE}/ai-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ sessionId: sessionId ?? undefined, message, stream: true }),
    });
  } catch {
    return null;
  }

  // The server answers a stream request with ordinary JSON when it
  // cannot stream — a hosted fallback, tools switched on. That is a
  // valid answer, not a failure, so hand it back to the caller.
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !res.body || !type.includes('text/event-stream')) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let retracted = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events are separated by a blank line, and a chunk boundary lands
    // mid-event often enough that the tail has to be carried forward.
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const evLine = part.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
      if (!evLine || !dataLine) continue;
      const event = evLine.slice(6).trim();
      let data;
      try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (event === 'open') onOpen?.(data.sessionId);
      else if (event === 'token') onToken?.(data);
      else if (event === 'retract') { retracted = true; onRetract?.(data.reason); }
      else if (event === 'done') result = data;
      else if (event === 'error') throw new Error(data.error);
    }
  }

  // A retraction is a completed exchange with nothing to keep. Returning
  // the result would make the caller draw a bubble it was just told to
  // take down.
  if (retracted) return { sessionId: sessionId ?? null, title: null, retracted: true };
  if (!result) throw new Error('The answer stopped part way through. Nothing was saved — try again.');
  return result;
}
