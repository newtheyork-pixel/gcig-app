import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// The bridge between the website and the Mac terminal.
//
// The Mac app opens this page in the real browser. The user signs in
// however they normally do — Google, password, 2FA, all of it already
// works here — and this page trades that session for a short-lived code
// and hands it back over a custom URL scheme.
//
// The app never sees a password and never reimplements a login flow,
// which is the whole reason to do it this way: there are three ways into
// this account and an app that rebuilt them would own three chances to
// get auth wrong.
//
// What crosses in the URL is a ninety-second single-use code, never the
// JWT. A bearer token in the address bar is a bearer token in browser
// history.
const SCHEME = 'griffin-terminal://auth';

export default function NativeAuth() {
  const { user } = useAuth();
  const [state, setState] = useState('working'); // working | handed | failed
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post('/auth/native/handoff');
        if (cancelled) return;
        if (!data?.code) throw new Error('The server did not return a code.');
        const target = `${SCHEME}?code=${encodeURIComponent(data.code)}`;
        setUrl(target);
        setState('handed');
        // Navigating to a custom scheme is what actually wakes the app.
        window.location.href = target;
      } catch (e) {
        if (cancelled) return;
        setError(e.response?.data?.error || e.message || 'Could not create a sign-in code.');
        setState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d0d0f] px-6">
      <div className="max-w-md w-full text-center space-y-4">
        <div>
          <h1 className="text-[#C9A84C] text-xl font-serif">The Griffin Fund</h1>
          <p className="text-[#8a8a92] text-[11px] tracking-[0.2em] uppercase mt-1">
            Terminal sign-in
          </p>
        </div>

        {state === 'working' && (
          <p className="text-[#d8d8de] text-sm">
            Signed in as {user?.name || 'you'}. Creating a sign-in code…
          </p>
        )}

        {state === 'handed' && (
          <div className="space-y-3">
            <p className="text-[#d8d8de] text-sm">
              Sent to Griffin Terminal. You can close this tab.
            </p>
            {/* The browser only auto-opens a custom scheme once, and some
                block it silently. A visible link means a blocked redirect
                is a click rather than a dead end. */}
            <a
              href={url}
              className="inline-block text-[#C9A84C] text-sm underline underline-offset-4"
            >
              Nothing happened? Open Griffin Terminal
            </a>
            <p className="text-[#6f6f77] text-[11px]">
              The code expires in 90 seconds and can only be used once.
            </p>
          </div>
        )}

        {state === 'failed' && (
          <div className="space-y-3">
            <p className="text-[#d05a5a] text-sm">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-[#C9A84C] text-sm underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
