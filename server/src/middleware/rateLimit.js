import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';

// A NOTE ON KEYS, WHICH IS THE WHOLE STORY HERE.
//
// express-rate-limit keys on `req.ip` by default, and for most services
// that is the right instinct: one address, one client. It is wrong for
// this one. Our members are a school club, and when they are in the
// building they are all behind a single public address — so an IP
// bucket is not a per-member allowance, it is one allowance the entire
// club shares, and the more of them who show up the faster everybody
// runs out.
//
// What that looked like from a chair: sign in, get a 429 on the very
// next call, and the client (which treated any failed /auth/me as proof
// the token was dead) deleted a perfectly good session. "I logged in
// and then I could not see anything."
//
// So an authenticated caller is keyed by their TOKEN. Anonymous traffic
// still keys by address, which is what it is for.
export function perCallerKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    // Hashed, and truncated: the key ends up in an in-memory map and in
    // any store we might add later, and a raw JWT is a credential. 22
    // base64url characters is 132 bits — collisions are not a concern
    // and neither is reversing it.
    return `t:${createHash('sha256').update(auth.slice(7)).digest('base64url').slice(0, 22)}`;
  }
  return `ip:${req.ip}`;
}

// Tight limit on authentication endpoints to blunt brute force attacks.
// Window is 5 minutes; after the limit the client must wait.
//
// Keyed by ADDRESS AND ACCOUNT together, for the same shared-address
// reason. Ten attempts per address meant one member fumbling their
// password ten times locked every other member in the room out of
// signing in, which is a denial of service we were performing on
// ourselves. Per address-and-account, an attacker grinding one account
// from one place still gets ten tries per five minutes — the property
// this limiter actually exists for — and the person next to them is
// unaffected.
export function perAccountKey(req) {
  const account = String(req.body?.email || req.body?.code || '')
    .trim()
    .toLowerCase();
  return account ? `${req.ip}|${account}` : `${req.ip}`;
}

export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: perAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait a few minutes and try again.' },
});

// Even tighter for verification code and reset links — these are brute-force
// targets because the code/token space is smaller.
export const codeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyGenerator: perAccountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please request a new code.' },
});

// Generic ceiling so a single client can't spam any one endpoint thousands
// of times per minute.
//
// Per caller, not per address — see perCallerKey. 200 a minute is a
// generous allowance for one person and was a mean one for a room of
// them, and this limiter sits in front of EVERY route, so exhausting it
// took the whole application away rather than one feature.
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: perCallerKey,
  standardHeaders: true,
  legacyHeaders: false,
  // Say which ceiling was hit. "Too many requests" with no subject sends
  // somebody to look at their own polling when the answer is that they
  // share a building with fifteen other members.
  message: { error: 'Rate limit reached for this session. Wait a minute and try again.' },
});
