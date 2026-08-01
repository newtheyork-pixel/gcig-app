// The words inside our uploaded research, put where things can read them.
//
// Twenty-six documents sit on the C.H. Robinson project and nineteen of
// them hold no readable text anywhere in the app: they are OneDrive
// references, and the only thing that ever turned one into words was the
// reader, on demand, into a cache that dies with the process. So the
// project search cannot find a phrase in a court filing, and the
// assistant — asked what the casebook says — has never seen a word of it.
//
// Extraction is now stored on the artifact. The five states matter more
// than the text: `never` is nobody has tried, which is not a failure and
// must not render as one; `empty` is a scanned PDF whose extraction
// SUCCEEDED and returned nothing, which used to paint a blank pane with
// no explanation; `unsupported` is a type we cannot parse; `failed` is
// worth retrying and `ok` is done.

import { getAccessToken } from './oneDriveStorage.js';
import { extractTextFromBuffer } from './fileSummarizer.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/// Long enough for a court opinion, short enough that one document
/// cannot dominate a table. The FULL length is recorded separately, so
/// a stored text shorter than `extractChars` is a truncated one and the
/// UI can say so rather than presenting a clipped opinion as complete.
export const MAX_STORE_CHARS = 600_000;

export function itemIdFrom(fileRef) {
  const s = String(fileRef || '');
  return s.startsWith('onedrive:') ? s.slice('onedrive:'.length) : null;
}

async function fetchBytes(itemId, deps = {}) {
  const token = await (deps.getAccessToken || getAccessToken)();
  const res = await (deps.fetch || fetch)(
    `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' }
  );
  if (!res.ok) {
    const err = new Error(`Graph ${res.status}`);
    err.status = res.status;
    // Graph asks politely to be left alone; the caller has to hear it.
    err.retryAfterMs = Number(res.headers?.get?.('retry-after') || 0) * 1000 || null;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Read one artifact's file and return the row update describing what
 * happened. Never throws: every outcome is a state, because a thrown
 * error here would leave the row looking untried.
 */
export async function extractForArtifact(artifact, deps = {}) {
  const stamp = { extractAttemptedAt: new Date(), extractAttempts: { increment: 1 } };
  const itemId = itemIdFrom(artifact.fileRef);
  if (!itemId) {
    return { ...stamp, extractStatus: 'unsupported', extractError: 'Not a stored file.' };
  }
  try {
    const buffer = await fetchBytes(itemId, deps);
    const extract = deps.extractTextFromBuffer || extractTextFromBuffer;
    const text = String((await extract(buffer, artifact.filename)) || '');
    if (!text.trim()) {
      // A PDF with no text layer is a scan. The extraction worked; there
      // is simply nothing in it to read, and saying so beats a blank pane.
      return {
        ...stamp,
        extractStatus: 'empty',
        extractedText: null,
        extractChars: 0,
        extractError: null,
      };
    }
    return {
      ...stamp,
      extractStatus: 'ok',
      extractedText: text.slice(0, MAX_STORE_CHARS),
      extractChars: text.length,
      extractError: null,
    };
  } catch (err) {
    if (err?.code === 'UNSUPPORTED_TYPE') {
      return { ...stamp, extractStatus: 'unsupported', extractError: err.message, extractedText: null };
    }
    const out = { ...stamp, extractStatus: 'failed', extractError: String(err.message || err).slice(0, 400) };
    if (err?.retryAfterMs) out._retryAfterMs = err.retryAfterMs;
    return out;
  }
}

/// What a reader should be told, per state. Kept beside the states so a
/// new one cannot be added without deciding what it says out loud.
export function extractionNote(a) {
  // An artifact typed into the app has no file to read, so it has no
  // extraction state worth reporting. Saying "not read yet" about a memo
  // somebody wrote in full is a sentence about nothing.
  if (!a?.fileRef) return null;
  switch (a?.extractStatus) {
    case 'ok':
      return a.extractChars > (a.extractedText?.length ?? 0)
        ? `Showing the first ${(a.extractedText?.length ?? 0).toLocaleString()} of ${a.extractChars.toLocaleString()} characters.`
        : null;
    case 'empty':
      return 'No text layer in this document — it is almost certainly a scan. Reading it would need OCR.';
    case 'unsupported':
      return a.extractError || 'We cannot read the text of this file type.';
    case 'failed':
      return 'Could not read this document. It will be retried.';
    case 'never':
    default:
      return 'Not read yet.';
  }
}
