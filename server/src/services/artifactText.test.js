import test from 'node:test';
import assert from 'node:assert/strict';
import { extractForArtifact, extractionNote, itemIdFrom, MAX_STORE_CHARS } from './artifactText.js';

const artifact = { id: 1, fileRef: 'onedrive:ITEM', filename: 'brief.pdf', title: 'Brief' };
const okFetch = (body = 'x') => async () => ({
  ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});
const deps = (over = {}) => ({
  getAccessToken: async () => 'token',
  fetch: okFetch(),
  extractTextFromBuffer: async () => 'the text of the document',
  ...over,
});

test('a readable document is stored with its full length recorded', async () => {
  const u = await extractForArtifact(artifact, deps());
  assert.equal(u.extractStatus, 'ok');
  assert.equal(u.extractedText, 'the text of the document');
  assert.equal(u.extractChars, 24);
  assert.equal(u.extractError, null);
  // Every attempt is stamped and counted, successful or not.
  assert.ok(u.extractAttemptedAt instanceof Date);
  assert.deepEqual(u.extractAttempts, { increment: 1 });
});

test('a scan is "empty", which is not a failure', async () => {
  // A PDF with no text layer extracts SUCCESSFULLY and returns nothing.
  // Reported as failed it invites a pointless retry; reported as ok it
  // paints a blank pane with no explanation, which is the silent
  // failure this whole state machine exists to prevent.
  const u = await extractForArtifact(artifact, deps({ extractTextFromBuffer: async () => '   \n ' }));
  assert.equal(u.extractStatus, 'empty');
  assert.equal(u.extractedText, null);
  assert.equal(u.extractChars, 0);
  assert.match(extractionNote({ extractStatus: 'empty' }), /scan/i);
});

test('a type we cannot parse is "unsupported", and is not retried as a failure', async () => {
  const u = await extractForArtifact(artifact, deps({
    extractTextFromBuffer: async () => {
      const e = new Error('Readable types are PDF, DOCX…');
      e.code = 'UNSUPPORTED_TYPE';
      throw e;
    },
  }));
  assert.equal(u.extractStatus, 'unsupported');
  assert.equal(u.extractedText, null);
  assert.match(u.extractError, /Readable types/);
});

test('a transport error is "failed" and carries its reason', async () => {
  const u = await extractForArtifact(artifact, deps({
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => null } }),
  }));
  assert.equal(u.extractStatus, 'failed');
  assert.match(u.extractError, /503/);
});

test('a throttle tells the caller how long to wait', async () => {
  // Graph throttles the application, so the pause has to be honoured
  // globally rather than by the one worker that heard about it.
  const u = await extractForArtifact(artifact, deps({
    fetch: async () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '30' : null) } }),
  }));
  assert.equal(u.extractStatus, 'failed');
  assert.equal(u._retryAfterMs, 30_000);
});

test('an artifact with no stored file is not a failure to read one', async () => {
  const u = await extractForArtifact({ id: 2, fileRef: null, filename: null }, deps());
  assert.equal(u.extractStatus, 'unsupported');
  assert.match(u.extractError, /Not a stored file/);
});

test('a very long document is stored truncated and says so', async () => {
  const long = 'a'.repeat(MAX_STORE_CHARS + 5000);
  const u = await extractForArtifact(artifact, deps({ extractTextFromBuffer: async () => long }));
  assert.equal(u.extractedText.length, MAX_STORE_CHARS);
  assert.equal(u.extractChars, long.length);
  // The stored length being short of the real one IS the truncation
  // flag — no extra column, and a clipped court opinion never presents
  // itself as complete.
  const note = extractionNote({ extractStatus: 'ok', extractChars: u.extractChars, extractedText: u.extractedText });
  assert.match(note, /Showing the first/);
  assert.equal(extractionNote({ extractStatus: 'ok', extractChars: 10, extractedText: 'a'.repeat(10) }), null);
});

test('never-attempted reads as not-yet-read, never as an error', () => {
  assert.match(extractionNote({ extractStatus: 'never' }), /Not read yet/);
  assert.match(extractionNote({ extractStatus: 'failed' }), /retried/);
});

test('the OneDrive scheme is stripped, and nothing else is accepted', () => {
  assert.equal(itemIdFrom('onedrive:ABC123'), 'ABC123');
  assert.equal(itemIdFrom('s3:ABC123'), null);
  assert.equal(itemIdFrom(null), null);
});
