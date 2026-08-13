import axios from 'axios';

// In dev, Vite proxies `/api` → http://localhost:4000. In prod, set
// VITE_API_BASE_URL (e.g. https://gcig-api.onrender.com) at build time.
const BASE =
  (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '') + '/api';

export const API_BASE = BASE;

// Default axios validateStatus is 2xx only — 304 Not Modified would land in
// the error branch. We treat 304 as a success because Express returns it
// when the cached body still matches (ETag), and we still need to read
// `X-New-Token` off those responses (see maybeRotateToken). Without this,
// dashboards that mostly hit ETag-cached endpoints could let a token age
// past its 24h expiry without ever rotating, then 401 in a single click.
const api = axios.create({
  baseURL: BASE,
  validateStatus: (status) =>
    (status >= 200 && status < 300) || status === 304,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gcig_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    // Stash the exact token we sent so the response interceptor can
    // tell "token genuinely expired" (sent === current) from "token
    // got rotated while this request was in flight" (sent !== current).
    config._tokenAtSend = token;
  }
  return config;
});

// Silent token rotation. The server's verifyJwt middleware sets
// `X-New-Token` on responses whenever the caller's JWT is past its
// 12h half-life. We swap it into localStorage transparently so the
// next request carries the fresh token — active users never hit the
// 24h expiration, inactive users do (which is the whole point).
//
// Rotate on 2xx AND 304 responses. 304 is the case that bit us before:
// Express returns 304 when an ETag-matched body would have been sent,
// and verifyJwt has already run + set X-New-Token on the response. Per
// HTTP/1.1, 304 carries fresh metadata (incl. headers) which the cache
// merges with the stored body — so the new token reaches us even when
// the body doesn't. Skipping 304 lets tokens silently age out on pages
// that mostly hit ETag-cached endpoints (e.g. the Dashboard).
//
// Error responses (401/403/etc.) can't have come from a successful
// verifyJwt → no valid X-New-Token could have been set. Reading from
// those responses risks writing garbage into localStorage from a
// malicious or buggy reverse proxy.
//
// Also: only rotate if the token in localStorage is still the SAME
// one we sent. If a concurrent login (e.g. Google sign-in completing
// while a /auth/me is still in flight on Safari) has already written
// a fresh token, the X-New-Token here is for the previous session —
// writing it would clobber the new login.
function maybeRotateToken(res) {
  if (!res) return;
  const ok =
    (res.status >= 200 && res.status < 300) || res.status === 304;
  if (!ok) return;
  const fresh =
    res?.headers?.['x-new-token'] || res?.headers?.['X-New-Token'];
  if (!fresh || typeof fresh !== 'string' || fresh.length < 20) return;
  const sent = res.config?._tokenAtSend;
  const current = localStorage.getItem('gcig_token');
  if (sent && current && sent !== current) return; // raced; discard
  if (fresh !== current) {
    localStorage.setItem('gcig_token', fresh);
  }
}

// Stale-401 detection. When something rotates the user's token mid-
// flight (server-side tokenVersion bump from /2fa/disable, password
// change, etc.), already-in-flight requests carrying the OLD token
// will 401 even though the SESSION is fine — localStorage already
// holds the new token from the same response.
//
// The precise check: did the token in localStorage change between
// when this request was sent and when its 401 came back? If yes,
// it's a stale 401 — ignore it. If no, the session is genuinely
// expired and we wipe + redirect.
//
// Unlike a time-window grace period, this can't be falsely warmed
// by public/unauthed responses (they don't change the token), and
// it can't accidentally suppress a real expired-session 401 (it
// only fires when localStorage was actively updated mid-flight).

// Endpoints whose 401 is authoritative — i.e. the response represents a
// real verdict on the session. Everything else is treated as a per-route
// permission/data bug, not proof the session is dead. The Calendar page
// fanning out a dozen GETs in parallel made this matter: one stray 401
// from a single data endpoint would wipe localStorage and bounce the
// user mid-render, even though every other call on the page succeeded.
/**
 * Did the SERVER say this session is over?
 *
 * This is the one question allowed to end a session, and it has exactly
 * one right answer: verifyJwt tags every verdict it reaches about the
 * token itself — absent, malformed, expired, revoked, user deleted —
 * with `code: 'AUTH'`. Nothing else qualifies.
 *
 * Everything else is us failing to ask. A 429 because fifteen members
 * share the school's public address, a 502 while Render wakes the API
 * up, a request that died in a stairwell between two access points: not
 * one of those is evidence about the token, and treating them as
 * evidence is how a valid login got thrown away. That is the whole of
 * the bug people described as "I sign in and then I can't see
 * anything" — the token was fine every time, and we deleted it.
 *
 * `err.response` being absent is the important case and the easiest to
 * get wrong: no response means the question never reached anybody.
 */
export function isSessionOver(err) {
  const res = err?.response;
  if (!res || res.status !== 401) return false;
  return res.data?.code === 'AUTH';
}

api.interceptors.response.use(
  (res) => {
    maybeRotateToken(res);
    return res;
  },
  (err) => {
    if (err.response?.status === 401) {
      const sent = err.config?._tokenAtSend;
      const now = localStorage.getItem('gcig_token');
      if (sent && now && sent !== now) {
        // Token rotated since this request was sent. The 401 is from
        // the old version — ignore and let the caller see a regular
        // promise rejection.
        return Promise.reject(err);
      }
      // The server's tag, on ANY endpoint, or no token was sent at all.
      //
      // The path list is deliberately no longer part of this. It used to
      // be, so that a 401 on /auth/me ended the session whatever the
      // body said — but verifyJwt is the only thing that can 401 that
      // route and it always tags, so the only 401s the path rule could
      // still catch were the ones NOBODY of ours sent: a proxy's error
      // page, a gateway between us and Render. Those are outages, and an
      // outage must never be able to log the club out.
      const sessionVerdict = isSessionOver(err) || !sent;
      if (!sessionVerdict) {
        return Promise.reject(err);
      }
      localStorage.removeItem('gcig_token');
      localStorage.removeItem('gcig_user');
      const path = window.location.pathname;
      const publicPaths = ['/login', '/accept-invite', '/forgot-password', '/reset-password'];
      if (!publicPaths.includes(path)) {
        // Carry where they were, so signing back in returns them to the
        // page they lost rather than to the dashboard.
        const next = encodeURIComponent(path + window.location.search);
        window.location.href = `/login?next=${next}`;
      }
    }
    return Promise.reject(err);
  }
);

export default api;
