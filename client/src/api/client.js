import axios from 'axios';
import {
  adoptToken,
  isSessionOver,
  shouldEndSession,
  rotationTokenFromHeaders,
} from './session.js';

export { isSessionOver, adoptToken, shouldEndSession } from './session.js';

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
//
// The API now sends Cache-Control: private, no-store, so a 304 from the
// BROWSER cache should not happen. Express can still 304 if a client
// sends If-None-Match; keeping 304 as success remains correct.
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
//
// And even then, only adopt a header whose `iat` is newer than what
// we hold. A cached 200 can replay yesterday's rotation looking
// exactly like one minted a second ago; iat is the second lock.
function maybeRotateToken(res) {
  if (!res) return;
  const ok =
    (res.status >= 200 && res.status < 300) || res.status === 304;
  if (!ok) return;
  const fresh = rotationTokenFromHeaders(res.headers);
  if (!fresh) return;
  const sent = res.config?._tokenAtSend;
  const current = localStorage.getItem('gcig_token');
  if (sent && current && sent !== current) return; // raced; discard
  adoptToken(fresh);
}

api.interceptors.response.use(
  (res) => {
    maybeRotateToken(res);
    return res;
  },
  (err) => {
    const sent = err.config?._tokenAtSend;
    const now = localStorage.getItem('gcig_token');
    if (shouldEndSession(err, { sent, current: now })) {
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
