// Session rules the rest of the client has to share.
//
// Two questions, and only two:
//
//   1. May we replace the token we hold with this one?
//   2. Did the server say THIS session is over?
//
// Getting either one wrong is the bug members describe as "I signed
// in and then nothing works". The token was fine. We threw it away.

/**
 * The `iat` claim, read without verifying anything. Same job as the
 * Mac `TokenStore.issuedAt`: the question is not whether the token is
 * authentic (the server settles that on the next call) but whether it
 * is NEWER than what we already hold.
 *
 * base64url, padding stripped on the wire — restoring it is the
 * detail hand-rolled decoders get wrong, and the symptom is a decode
 * that silently fails on two tokens in three.
 */
export function jwtIssuedAt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(payload));
    const iat = json?.iat;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
    return iat;
  } catch {
    return null;
  }
}

const localStore = {
  read: () => {
    try {
      return localStorage.getItem('gcig_token');
    } catch {
      return null;
    }
  },
  write: (value) => {
    localStorage.setItem('gcig_token', value);
  },
};

/**
 * Take a rotated token only when it is genuinely newer than the one
 * we hold.
 *
 * The rotation header cannot be trusted on its own, because a
 * response can be a REPLAY. A browser cache that kept a 200 from
 * breakfast (Express used to send ETags and no Cache-Control) hands
 * it back at lunch with that morning's `X-New-Token`. Adopting
 * unconditionally writes an expired credential over the live one,
 * the next call 401s AUTH, and a member who did nothing wrong is
 * signed out. The Mac and iOS clients learned this; the website was
 * still taking whatever the header said.
 *
 * Rotation also presumes a session. With nothing in the store there
 * is nothing to rotate: a response still in flight after a logout
 * (or after a login that has not yet written) must not put a token
 * back, and must not overwrite a login that landed while it flew.
 *
 * `store` is injectable so the suite does not have to pretend to be
 * a browser.
 */
export function adoptToken(fresh, store = localStore) {
  if (!fresh || typeof fresh !== 'string') return false;
  const candidate = fresh.trim();
  const freshIat = jwtIssuedAt(candidate);
  if (freshIat == null) return false;

  const current = store.read();
  if (!current) return false;

  const currentIat = jwtIssuedAt(current);
  if (currentIat == null) {
    store.write(candidate);
    return true;
  }
  if (freshIat <= currentIat) return false;
  if (candidate !== current) store.write(candidate);
  return true;
}

export function rotationTokenFromHeaders(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get('X-New-Token') || headers.get('x-new-token');
  }
  const fresh = headers['x-new-token'] || headers['X-New-Token'];
  return typeof fresh === 'string' ? fresh : null;
}

export function adoptFromResponseHeaders(headers, store = localStore) {
  const fresh = rotationTokenFromHeaders(headers);
  if (!fresh) return false;
  return adoptToken(fresh, store);
}

/**
 * Did the SERVER say this session is over?
 *
 * verifyJwt tags every verdict it reaches about the token itself —
 * absent, malformed, expired, revoked, user deleted — with
 * `code: 'AUTH'`. Nothing else qualifies. A 429, a 502, a dropped
 * connection, a data route's own 401: not one of those is evidence
 * about the token.
 */
export function isSessionOver(err) {
  const res = err?.response;
  if (!res || res.status !== 401) return false;
  return res.data?.code === 'AUTH';
}

/**
 * Should we throw the stored token away?
 *
 * isSessionOver is necessary and not sufficient. A 401 AUTH on a
 * request that carried NO credential is what verifyJwt says to a
 * missing Bearer, and from the server's side it cannot tell an
 * unauthenticated caller from an expired one. We can. A request we
 * sent without a credential is evidence about our own race — a
 * poller that fired while the store was empty, or a login 401 —
 * and never evidence that the credential we now hold is dead.
 *
 * The web interceptor used to treat `!sent` as a verdict. That is
 * the inverted Mac bug: a late "Missing token" from a request that
 * left before login wiped the token login had just written, and the
 * member landed on the dashboard holding nothing.
 *
 * A 401 for a token that has since been replaced is the same shape
 * from the other side (in-flight request, rotation or a new login)
 * and is ignored the same way.
 */
export function shouldEndSession(err, { sent, current } = {}) {
  if (!isSessionOver(err)) return false;
  if (!sent) return false;
  if (current && sent !== current) return false;
  return true;
}
