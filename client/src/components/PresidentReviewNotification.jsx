import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ClipboardList, X } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';

// Per-cycle dismiss key. Stored in localStorage so the prompt survives a
// page reload but the user can choose to silence it for the rest of the
// cycle. The key bakes in the cycle string so a fresh academic year
// re-opens the prompt automatically.
//
// Unmounted from Layout while the review is closed to the membership
// (Sep '26). Super-admin still reaches the archive at /president-review.
// Leave this file in place so flipping the review back on is a one-line
// import, not a rewrite.
const DISMISS_KEY_PREFIX = 'gcig_president_review_dismissed_';

// Login is a full reload to /dashboard (see CLAUDE.md > Auth model). We
// mount in Layout so the modal can fire on the first authenticated page
// load. It only renders when (a) the API says the user still owes one or
// more reviews this cycle and (b) the user hasn't already silenced the
// prompt for this cycle.
export default function PresidentReviewNotification() {
  const [status, setStatus] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    api
      .get('/president-review/status')
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (!data.pending || data.pending.length === 0) return;
        if (localStorage.getItem(DISMISS_KEY_PREFIX + data.cycle)) return;
        setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide the modal on the review page itself — it would be weird to
  // overlay it on top of the form the user just opened.
  if (!status) return null;
  if (location.pathname.startsWith('/president-review')) return null;

  function dismiss() {
    if (status) localStorage.setItem(DISMISS_KEY_PREFIX + status.cycle, '1');
    setStatus(null);
  }

  function goReview() {
    if (status) localStorage.setItem(DISMISS_KEY_PREFIX + status.cycle, '1');
    setStatus(null);
    navigate('/president-review');
  }

  const remaining = status.pending.length;
  const cycleLabel = status.cycle;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-xl">
        <div className="h-0.5 bg-gold" />
        <div className="px-6 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
                End of year · {cycleLabel}
              </div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <ClipboardList className="h-5 w-5 text-navy" />
                <div className="text-xl font-semibold tracking-tight text-navy">
                  President Review
                </div>
              </div>
            </div>
            <button
              onClick={dismiss}
              className="rounded-lg p-1 text-navy-400 hover:bg-black/[0.04] hover:text-navy"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm text-navy">
            Please rate this year's {remaining === 1 ? 'president' : 'presidents'}{' '}
            on a few quick questions. It takes under a minute per president.
          </p>

          <div className="mt-4 rounded-lg border border-navy-100 bg-navy-50/40 px-3 py-2 text-xs text-navy">
            <span className="font-semibold">Still to review:</span>{' '}
            {status.pending.map((p) => p.name).join(', ')}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={dismiss}>
              Later
            </Button>
            <Button onClick={goReview}>
              Review now
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
