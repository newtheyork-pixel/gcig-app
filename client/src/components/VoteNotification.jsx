import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { TrendingUp, Minus, TrendingDown, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import Button from './Button.jsx';

const STORAGE_KEY = 'gcig_last_seen_vote_id';

const ACTION_META = {
  Buy: {
    icon: TrendingUp,
    color: 'from-emerald-500 to-emerald-700',
    text: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
  },
  Hold: {
    icon: Minus,
    color: 'from-gold-500 to-gold-700',
    text: 'text-gold-800',
    bg: 'bg-gold-50',
    border: 'border-gold-300',
  },
  Sell: {
    icon: TrendingDown,
    color: 'from-red-500 to-red-700',
    text: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-200',
  },
};

export default function VoteNotification() {
  const [vote, setVote] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get('/votes/latest')
      .then(({ data }) => {
        if (cancelled || !data) return;
        const lastSeen = Number(localStorage.getItem(STORAGE_KEY) || 0);
        if (data.id > lastSeen) setVote(data);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    if (vote) localStorage.setItem(STORAGE_KEY, String(vote.id));
    setVote(null);
  }

  if (!vote) return null;

  const meta = ACTION_META[vote.action] || ACTION_META.Hold;
  const Icon = meta.icon;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy/70 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Colored header strip */}
        <div
          className={`bg-gradient-to-r ${meta.color} p-6 text-white`}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider opacity-90">
                New Investment Decision
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Icon className="h-8 w-8" />
                <div>
                  <div className="text-3xl font-bold">{vote.action.toUpperCase()}</div>
                  <div className="text-xl font-bold">{vote.ticker}</div>
                </div>
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
          {vote.note && (
            <div className={`rounded-lg border p-4 ${meta.bg} ${meta.border}`}>
              <div className="text-xs font-semibold uppercase tracking-wider text-navy-400">
                Reasoning
              </div>
              <p className={`mt-2 whitespace-pre-wrap text-sm ${meta.text}`}>
                {vote.note}
              </p>
            </div>
          )}

          {vote.creator && (
            <div className="mt-4 text-xs text-navy-400">
              Cast by <span className="font-semibold text-navy">{vote.creator.name}</span>
              {' • '}
              {format(new Date(vote.createdAt), 'MMM d, yyyy • h:mm a')}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={dismiss}>
              Got it
            </Button>
            <Button
              onClick={() => {
                dismiss();
                navigate('/votes');
              }}
            >
              See all votes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
