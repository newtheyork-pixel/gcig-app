import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

// Auto-logout after 2 hours of no user interaction. Defends against a
// stolen unlocked laptop — the attacker still has to beat the clock.
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export default function InactivityTimer() {
  const { user, logout } = useAuth();

  useEffect(() => {
    if (!user) return;
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await logout();
        window.location.href = '/login?timedOut=1';
      }, IDLE_TIMEOUT_MS);
    };
    reset();

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout]);

  return null;
}
