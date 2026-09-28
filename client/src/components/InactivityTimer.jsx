import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { idleTooLong, lastActiveAt, markActive } from '../api/session.js';

// Sign out after two hours with nobody at the keyboard. Defends against
// a stolen unlocked laptop — the attacker still has to beat the clock.
//
// The clock lives in session.js and is shared by every tab; see the note
// there for why a per-tab clock read as tokens expiring early. What this
// component adds is the listening, and it listens for reading as well as
// typing. It used to count only clicks, keys, touches and WINDOW scroll,
// and the app scrolls inside <main>, so window scroll never fires: a
// member reading the book with a trackpad for two hours was signed out
// mid-sentence. Scroll does not bubble, so it is caught in the capture
// phase; pointermove and wheel cover the rest.
//
// On every event the idle check runs BEFORE the event is allowed to
// count. Otherwise the first touch after a long absence — the lid of a
// laptop left open in a common room — would rescue the session instead
// of ending it. Arriving on a page is different: a load or a reload is
// somebody choosing to be here, and a sign-in has already reset the
// clock, so mounting counts as activity outright.
const CHECK_EVERY_MS = 30 * 1000;
// pointermove fires dozens of times a second; one write every few
// seconds is ample against a two-hour limit.
const WRITE_EVERY_MS = 5 * 1000;
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];

export default function InactivityTimer() {
  const { user, logout } = useAuth();
  // logout is a new function on every provider render; holding it in a
  // ref keeps the listeners from being torn down and re-added each time.
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  const signedIn = !!user;

  useEffect(() => {
    if (!signedIn) return undefined;
    let signingOut = false;

    const expired = () => {
      if (signingOut || !idleTooLong()) return signingOut;
      signingOut = true;
      Promise.resolve(logoutRef.current()).finally(() => {
        window.location.href = '/login?timedOut=1';
      });
      return true;
    };
    const touch = () => {
      if (expired()) return;
      const now = Date.now();
      const at = lastActiveAt();
      if (at == null || now - at >= WRITE_EVERY_MS) markActive(now);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') touch();
    };

    markActive();
    const opts = { capture: true, passive: true };
    EVENTS.forEach((e) => document.addEventListener(e, touch, opts));
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(expired, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
      EVENTS.forEach((e) => document.removeEventListener(e, touch, opts));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedIn]);

  return null;
}
