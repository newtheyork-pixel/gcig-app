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
  const [code, setCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post('/auth/native/handoff');
        if (cancelled) return;
        if (!data?.code) throw new Error('The server did not return a code.');
        const target = `${SCHEME}?code=${encodeURIComponent(data.code)}`;
        setCode(data.code);
        setUrl(target);
        setState('handed');
        // No automatic navigation. Browsers refuse a custom scheme
        // without user activation, and an attempt that silently fails
        // is worse than none: it makes the page look finished while the
        // app waits forever. The button below carries the gesture.
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
          <div className="space-y-4">
            <p className="text-[#d8d8de] text-sm">
              Signed in as {user?.name || 'you'}. One more click.
            </p>

            {/* A CLICK, not a redirect.
                The first version navigated to the custom scheme
                automatically from an effect, which Chrome and Safari
                both refuse: scheme handoffs need user activation. It
                failed silently, the page looked like it had worked, and
                the app sat on "waiting for the browser" forever. The
                button carries the user gesture that makes the handoff
                legal. */}
            <a
              href={url}
              className="block w-full bg-[#C9A84C] hover:bg-[#d9b85c] text-[#0d0d0f] text-sm font-medium rounded px-4 py-3 transition-colors"
            >
              Open Griffin Terminal
            </a>

            <p className="text-[#6f6f77] text-[11px]">
              Your browser may ask permission to open the app. Allow it.
            </p>

            <div className="pt-2 space-y-1 border-t border-[#22222a]">
              <p className="text-[#6f6f77] text-[11px] pt-3">
                If that does nothing, paste this code into the app:
              </p>
              <button
                onClick={() => navigator.clipboard?.writeText(code)}
                className="w-full font-mono text-[11px] text-[#d8d8de] bg-[#17171b] border border-[#2a2a30] rounded px-2 py-2 break-all hover:border-[#C9A84C] transition-colors"
                title="Click to copy"
              >
                {code}
              </button>
              <p className="text-[#6f6f77] text-[11px]">
                Expires in 90 seconds and works once.
              </p>
            </div>
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
