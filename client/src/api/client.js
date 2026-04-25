import axios from 'axios';

// In dev, Vite proxies `/api` → http://localhost:4000. In prod, set
// VITE_API_BASE_URL (e.g. https://gcig-api.onrender.com) at build time.
const BASE =
  (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '') + '/api';

export const API_BASE = BASE;

const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gcig_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Silent token rotation. The server's verifyJwt middleware sets
// `X-New-Token` on responses whenever the caller's JWT is past its
// 12h half-life. We swap it into localStorage transparently so the
// next request carries the fresh token — active users never hit the
// 24h expiration, inactive users do (which is the whole point).
function maybeRotateToken(res) {
  const fresh =
    res?.headers?.['x-new-token'] ||
    res?.headers?.['X-New-Token'];
  if (fresh && typeof fresh === 'string') {
    const prev = localStorage.getItem('gcig_token');
    if (fresh !== prev) {
      localStorage.setItem('gcig_token', fresh);
    }
  }
}

api.interceptors.response.use(
  (res) => {
    maybeRotateToken(res);
    return res;
  },
  (err) => {
    // Even on errors, the server may have rotated the token.
    maybeRotateToken(err?.response);
    if (err.response?.status === 401) {
      localStorage.removeItem('gcig_token');
      localStorage.removeItem('gcig_user');
      const path = window.location.pathname;
      const publicPaths = ['/login', '/accept-invite', '/forgot-password', '/reset-password'];
      if (!publicPaths.includes(path)) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
