import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';
import Button from './Button.jsx';

// The global watchlist-alert notifier. Mounted in Layout exactly like
// PitchNotification / VoteNotification / PresidentReviewNotification —
// a logged-in-only poller that renders a dismissible popup. The
// difference from those (which fetch once on mount) is that an alert
// can cross at any time, so this one *polls* on a gentle interval.
//
// The honest, repeatedly-stated limitation (spec §"Locked decisions"):
// alerts are evaluated client-side, ONLY while the user has the app
// open and the tab visible. There is no server cron and no logged-out
// push — a server-side evaluator polling Finnhub for every user's
// tickers would blow the free 60-rpm budget, and the app's existing
// notifications already work exactly this way. The popup copy and the
// Watchlist panel both say so.
//
// Each cycle: GET /api/alerts → keep the active ones → if any, GET
// /terminal/quotes for their distinct tickers (the same rate-bounded
// tap the terminal uses; no new fetch) → evaluate each rule → for each
// crossed rule, queue a popup and POST /api/alerts/:id/fired so the
// rule one-shots server-side (active=false) and can't re-spam on the
// next poll. Any failure degrades silently — a notifier must never
// block or error the app.
//
// Scheduling mirrors useLiveRefresh's discipline: a single
// self-rescheduling setTimeout (never setInterval, so a slow fetch
// can't stack ticks), an `alive` ref flipped false on unmount / hidden
// tab so a request resolving after we've stopped caring drops its
// result, and a visibilitychange listener that pauses the loop on a
// hidden tab and does an immediate catch-up tick on return.

// Gentle cadence — the spec asks for ~30-60s. 45s keeps the alert
// latency tolerable for a "tell me when it hits a level" feature while
// staying easy on the shared Finnhub budget (the quote tap is already
// per-ticker cached at 20s server-side, so this mostly hits warm
// cache).
const POLL_MS = 45_000;

// Whole-percent convention. /terminal/quotes' changePct is Finnhub's
// `dp`, already a percent (1.23 == +1.23%). A `pct` rule's threshold
// is entered as a percent too, so we compare the two DIRECTLY — no
// ×100, no /100. (This is the one place the unit matters; the
// Watchlist table divides by 100 only because its formatter speaks the
// fraction convention — that's a display concern, not this one.)
function crossed(rule, quote) {
  if (!quote) return false;
  const value =
    rule.metric === 'price'
      ? quote.last
      : rule.metric === 'pct'
      ? quote.changePct
      : null;
  if (value == null || Number.isNaN(value)) return false;
  return rule.direction === 'above'
    ? value >= rule.threshold
    : value <= rule.threshold;
}

// Honest one-line description of what just happened, e.g.
// "AAPL crossed above $190 (now $190.40)" or
// "TSLA crossed below -3% (now -3.7%)".
function describe(rule, quote) {
  const dir = rule.direction === 'above' ? 'above' : 'below';
  if (rule.metric === 'price') {
    const now =
      quote && quote.last != null ? `$${Number(quote.last).toFixed(2)}` : '—';
    return `${rule.ticker} crossed ${dir} $${rule.threshold} (now ${now})`;
  }
  const now =
    quote && quote.changePct != null
      ? `${Number(quote.changePct).toFixed(2)}%`
      : '—';
  return `${rule.ticker} crossed ${dir} ${rule.threshold}% on the day (now ${now})`;
}

export default function WatchlistAlertNotification() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // A queue of fired popups. Multiple rules can cross in one poll
  // (several tickers, or price + pct on the same name) — we stack them
  // and show one at a time, dismiss advancing to the next, the same
  // "one modal at a time" feel the other notifiers have.
  const [queue, setQueue] = useState([]);

  // Ids we've already fired this session, so even if a /fired POST is
  // slow or fails the next poll's still-active rule doesn't re-queue
  // the same crossing. The server-side active=false is the durable
  // dedupe; this is the within-session belt-and-braces.
  const firedRef = useRef(new Set());

  useEffect(() => {
    // Logged out → the notifier is fully idle: no poll loop is ever
    // armed. (Login is a full reload — see CLAUDE.md Auth model — so
    // this effect re-runs with a real user and starts the loop then.)
    if (!user) return undefined;

    let alive = true;
    let timer = null;

    async function evaluateOnce() {
      // GET the caller's rules. Never-5xx route → on a soft fault this
      // is { alerts: [] }; a hard/network failure throws and the catch
      // below swallows it. Either way: degrade silently.
      const { data } = await api.get('/alerts');
      const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
      const active = alerts.filter(
        (a) => a && a.active && !firedRef.current.has(a.id)
      );
      if (active.length === 0) return;

      // One quote tap for the distinct tickers across the active
      // rules — the same rate-bounded endpoint the terminal uses, not
      // a new fetch. Empty/junk degrades to {} server-side.
      const tickers = [
        ...new Set(active.map((a) => String(a.ticker).toUpperCase())),
      ];
      const { data: quotes } = await api.get('/terminal/quotes', {
        params: { tickers: tickers.join(',') },
      });
      if (!alive) return;

      const newlyFired = [];
      for (const rule of active) {
        const q = quotes ? quotes[String(rule.ticker).toUpperCase()] : null;
        if (!crossed(rule, q)) continue;
        // Mark fired in-session immediately so a second poll racing
        // the /fired POST can't double-queue it.
        firedRef.current.add(rule.id);
        newlyFired.push({
          id: rule.id,
          ticker: rule.ticker,
          message: describe(rule, q),
        });
        // Tell the server it fired → it stamps lastFiredAt and flips
        // active=false (one-shot). Best-effort: a failure here is fine,
        // the in-session set already prevents a re-queue this session,
        // and the user simply re-arms a rule that didn't deactivate.
        api.post(`/alerts/${rule.id}/fired`).catch(() => {});
      }
      if (newlyFired.length > 0 && alive) {
        setQueue((cur) => [...cur, ...newlyFired]);
      }
    }

    // Run, then arm the next tick from inside the resolve so a slow
    // request can't let ticks stack. Every failure is swallowed — the
    // loop keeps going and the app is never blocked or errored.
    async function tick() {
      if (!alive) return;
      try {
        await evaluateOnce();
      } catch {
        /* degrade silently — never block the app */
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    }

    // Visibility is the rate-safety net, same as useLiveRefresh:
    // hiding the tab drops `alive` and clears the pending timer (an
    // in-flight request sees !alive on resolve and discards); coming
    // back re-arms and does an immediate catch-up tick before resuming
    // the cadence, so a level crossed while the tab was hidden still
    // surfaces promptly on return.
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        if (alive) return;
        alive = true;
        tick();
      } else {
        alive = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    // Only start polling if the tab is visible at mount; otherwise idle
    // and let the visibility listener pick up the hidden→visible edge.
    if (document.visibilityState === 'visible') {
      tick();
    } else {
      alive = false;
    }

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user]);

  if (!user) return null;
  const current = queue[0];
  if (!current) return null;

  function dismiss() {
    // Advance to the next queued crossing, if any.
    setQueue((cur) => cur.slice(1));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy/70 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="bg-gradient-to-r from-navy to-navy-700 p-6 text-white">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
                Watchlist Alert
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Bell className="h-7 w-7 text-gold" />
                <div className="text-3xl font-bold">{current.ticker}</div>
              </div>
            </div>
            <button
              onClick={dismiss}
              className="rounded-lg p-1 text-white/80 hover:bg-white/20 hover:text-white"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm font-medium text-navy">{current.message}</p>
          {queue.length > 1 && (
            <div className="mt-3 text-xs text-navy-400">
              +{queue.length - 1} more alert
              {queue.length - 1 === 1 ? '' : 's'} crossed
            </div>
          )}
          <div className="mt-4 rounded-lg border border-navy-100 bg-navy-50/40 px-3 py-2 text-[11px] leading-relaxed text-navy-400">
            This alert is now disabled so it won't repeat — re-arm it
            from the Terminal's W panel. Alerts are only checked while
            you have the app open.
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={dismiss}>
              Dismiss
            </Button>
            <Button
              onClick={() => {
                dismiss();
                navigate('/terminal');
              }}
            >
              Open Terminal
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
