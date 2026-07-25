import crypto from 'node:crypto';

// Short-lived capability tokens for a single OneDrive item.
//
// Why this exists: an `<iframe src=…>` is a top-level browser GET. It
// can't carry our `Authorization: Bearer` header, so the JWT-guarded
// /api/files routes 401 the moment you try to embed them. The usual
// escape hatch — Microsoft Graph's `/preview` action — is unavailable
// to us (see the note in oneDriveStorage.streamPreview), so we mint
// our own grant instead: an HMAC over {item, expiry} that rides in the
// query string and authorizes exactly one file for a few minutes.
//
// The token is a bearer capability. Anyone holding the URL can read
// that one document until it expires, so keep the TTL short and never
// log the full URL. It is signed with JWT_SECRET, which means a
// secret rotation invalidates every outstanding preview link — the
// correct blast radius.

// Long enough that a member can open a deck, read it, and scroll back
// without the pane dying under them; short enough that a URL leaked
// out of a browser history or a pasted link is worthless by the time
// anyone tries it.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error('JWT_SECRET is not set — cannot sign file preview URLs');
  }
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Mint a preview grant for one OneDrive item.
 *
 * @param {string} itemId - OneDrive item id (no scheme prefix)
 * @param {object} opts
 * @param {number} opts.ttlMs - Lifetime in ms (default 15 min)
 * @param {number|null} opts.userId - Who asked, carried for audit only
 * @returns {string} `<payload>.<signature>`, both base64url
 */
export function signFileToken(itemId, { ttlMs = DEFAULT_TTL_MS, userId = null } = {}) {
  if (!itemId) throw new Error('signFileToken requires an itemId');
  const claims = { i: String(itemId), u: userId ?? null, e: Date.now() + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a grant and return its claims, or null if the token is
 * malformed, forged, or expired. Never throws on bad input — a
 * garbage query param is a 403, not a 500.
 *
 * @param {string} token
 * @returns {{itemId: string, userId: number|null}|null}
 */
export function verifyFileToken(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  let expected;
  try {
    expected = Buffer.from(sign(payload), 'utf8');
  } catch {
    return null; // JWT_SECRET missing — fail closed, not loudly
  }
  // timingSafeEqual throws on a length mismatch, so screen for that
  // first; the length of an HMAC is not a secret.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims.i !== 'string' || typeof claims.e !== 'number') {
    return null;
  }
  if (Date.now() > claims.e) return null;
  return { itemId: claims.i, userId: claims.u ?? null };
}
