import { createContext, useContext, useEffect, useState } from 'react';
import api, { isSessionOver } from '../api/client.js';

const AuthContext = createContext(null);

function saveSession(token, user) {
  localStorage.setItem('gcig_token', token);
  localStorage.setItem('gcig_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('gcig_token');
  localStorage.removeItem('gcig_user');
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    // Safari has occasionally been observed to leave malformed JSON in
    // localStorage after a forced reload mid-write. Treat any parse
    // failure as "no user" instead of crashing the whole app — the
    // /auth/me call below will recover if a valid token is present.
    const raw = localStorage.getItem('gcig_user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      localStorage.removeItem('gcig_user');
      return null;
    }
  });
  const [loading, setLoading] = useState(!!localStorage.getItem('gcig_token'));
  // Whether the API answered us at all. Distinct from being signed out,
  // and that distinction is the fix below: a member who cannot reach the
  // server is still a member.
  const [serverReachable, setServerReachable] = useState(true);

  // Bootstrap the session from the stored token.
  //
  // THE RULE THIS ENFORCES: only the server may end a session. It used
  // to be that any failure here ran clearSession() — so a 429, a 502
  // while Render woke the API up, or a dropped connection deleted a
  // token the server had never once refused. The member was bounced to
  // /login, signed in again, and hit the same wall on the next reload.
  // That is the bug, and it was in the client the entire time.
  //
  // What replaces it: a verdict (`code: 'AUTH'`) clears the session and
  // nothing else does. A transient failure stops blocking the UI —
  // there is a cached user and an unrejected token, which is enough to
  // render — and retries quietly behind it. Render's free dyno can take
  // most of a minute to wake, so the backoff is sized to outlast a cold
  // start rather than to look busy.
  useEffect(() => {
    const initialToken = localStorage.getItem('gcig_token');
    if (!initialToken) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const res = await api.get('/auth/me');
          if (cancelled) return;
          // 304 with an empty body would set user to undefined and kick
          // the user to /login on the next render. The /auth/me route
          // sets Cache-Control: no-store so 304 shouldn't happen here,
          // but be defensive in case a proxy or older deploy serves one.
          if (res && res.data && typeof res.data === 'object') {
            setUser(res.data);
            localStorage.setItem('gcig_user', JSON.stringify(res.data));
          }
          setServerReachable(true);
          setLoading(false);
          return;
        } catch (err) {
          if (cancelled) return;
          // Something else signed us in while this was in flight (a
          // concurrent Google sign-in on Safari is the observed case).
          // This answer is about the previous session; drop it.
          if (localStorage.getItem('gcig_token') !== initialToken) {
            setLoading(false);
            return;
          }
          if (isSessionOver(err)) {
            clearSession();
            setUser(null);
            setLoading(false);
            return;
          }
          // Could not ask. Let the app render on what we already know
          // and keep trying — roughly 1.5s, 3s, 6s, 12s, then stop and
          // leave it to the next navigation.
          setServerReachable(false);
          setLoading(false);
          if (attempt >= 3) return;
          await sleep(1500 * 2 ** attempt);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Returns either { user } on full success, or { twoFactorRequired, challengeToken }
  // when the user has 2FA enabled. The caller then collects a code and calls
  // verifyTwoFactor().
  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.twoFactorRequired) {
      return {
        twoFactorRequired: true,
        challengeToken: res.data.challengeToken,
        methods: res.data.methods || {}, // { totp: bool, email: bool }
      };
    }
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return { user: res.data.user };
  }

  async function verifyTwoFactor(challengeToken, code) {
    const res = await api.post('/2fa/login', { challengeToken, code });
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return res.data.user;
  }

  async function googleSignIn(credential) {
    const res = await api.post('/auth/google', { credential });
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return res.data.user;
  }

  async function signup(name, email, password) {
    const res = await api.post('/auth/signup', { name, email, password });
    return res.data;
  }

  async function verify(email, code) {
    const res = await api.post('/auth/verify', { email, code });
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return res.data.user;
  }

  async function resendCode(email) {
    const res = await api.post('/auth/resend-code', { email });
    return res.data;
  }

  async function forgotPassword(email) {
    await api.post('/auth/forgot-password', { email });
  }

  async function resetPassword(token, password) {
    await api.post(`/auth/reset/${token}`, { password });
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    clearSession();
    setUser(null);
  }

  async function logoutEverywhere() {
    await api.post('/auth/logout-everywhere');
    clearSession();
    setUser(null);
  }

  const isAdmin = user?.role === 'President';
  const isExecutive =
    user?.role === 'President' || user?.role === 'DirectorOfResearch' || user?.role === 'CIO';
  // Portfolio Manager and above: PMs, Senior PMs, CIO, President. Mirrors
  // requireRole('PortfolioManager') on the server. Used to gate management
  // tools (e.g. the Participation ranking) that PMs need for planning but
  // junior analysts don't.
  const isPmOrAbove =
    user?.role === 'President' ||
    user?.role === 'DirectorOfResearch' ||
    user?.role === 'DirectorOfResearch' ||
    user?.role === 'CIO' ||
    user?.role === 'SeniorPortfolioManager' ||
    user?.role === 'PortfolioManager';
  // Analyst and above. Mirrors requireRole('Analyst') on the server,
  // which is the gate on /api/research — so whoever can do fieldwork can
  // also open the surface built for it.
  //
  // JuniorAnalyst is deliberately NOT in this list: it ranks below
  // Analyst on the server (4 vs 5) and is the default role every Google
  // self-signup lands on. Including it would hand the terminal to anyone
  // who found the login page.
  const isAnalystOrAbove =
    user?.role === 'President' ||
    user?.role === 'CIO' ||
    user?.role === 'SeniorPortfolioManager' ||
    user?.role === 'PortfolioManager' ||
    user?.role === 'SeniorAnalyst' ||
    user?.role === 'Analyst';
  const isAdvisory =
    user?.role === 'AdvisoryBoardMember' || user?.role === 'FacultyAdvisory';
  // Owner-only tier above President. Identified by email via SUPER_ADMIN_EMAIL
  // on the server. Gates irreversible / sensitive operations.
  const isSuperAdmin = !!user?.isSuperAdmin;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        serverReachable,
        login,
        verifyTwoFactor,
        googleSignIn,
        signup,
        verify,
        resendCode,
        forgotPassword,
        resetPassword,
        logout,
        logoutEverywhere,
        isAdmin,
        isExecutive,
        isPmOrAbove,
        isAnalystOrAbove,
        isAdvisory,
        isSuperAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
