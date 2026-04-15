import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Plus, TrendingUp, Minus, TrendingDown, Search, Trash2 } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const ACTION_META = {
  Buy: {
    icon: TrendingUp,
    label: 'Buy',
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    ring: 'ring-emerald-500',
  },
  Hold: {
    icon: Minus,
    label: 'Hold',
    badge: 'bg-gold-100 text-gold-800 border-gold-300',
    ring: 'ring-gold',
  },
  Sell: {
    icon: TrendingDown,
    label: 'Sell',
    badge: 'bg-red-100 text-red-800 border-red-200',
    ring: 'ring-red-500',
  },
};

function emptyForm() {
  return { ticker: '', action: 'Buy', note: '' };
}

export default function Votes() {
  const { isAdmin } = useAuth();
  const [votes, setVotes] = useState([]);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    const { data } = await api.get('/votes');
    setVotes(data);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return votes;
    return votes.filter(
      (v) =>
        v.ticker.toLowerCase().includes(q) ||
        v.action.toLowerCase().includes(q) ||
        (v.note || '').toLowerCase().includes(q) ||
        (v.creator?.name || '').toLowerCase().includes(q)
    );
  }, [votes, query]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/votes', form);
      setModalOpen(false);
      setForm(emptyForm());
      load();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this vote?')) return;
    await api.delete(`/votes/${id}`);
    load();
  }

  return (
    <>
      <PageHeader
        title="Voting"
        subtitle="Official club decisions on pitches — Buy, Hold, or Sell."
        actions={
          <AdminOnly>
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Cast Vote
            </Button>
          </AdminOnly>
        }
      />

      <Card>
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-navy-100 px-3 py-2">
          <Search className="h-4 w-4 text-navy-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ticker, action, note, or member…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-navy-400">
            {votes.length === 0
              ? 'No votes cast yet.'
              : 'No votes match your search.'}
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((v) => {
              const meta = ACTION_META[v.action] || ACTION_META.Hold;
              const Icon = meta.icon;
              return (
                <li
                  key={v.id}
                  className="flex items-start gap-4 rounded-lg border border-navy-100 p-4"
                >
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border ${meta.badge}`}
                  >
                    <Icon className="h-6 w-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-bold text-navy">{v.ticker}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${meta.badge}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-xs text-navy-400">
                        {format(new Date(v.createdAt), 'MMM d, yyyy • h:mm a')}
                      </span>
                    </div>
                    {v.note && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-navy">
                        {v.note}
                      </p>
                    )}
                    {v.creator && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-navy-400">
                        <span>Cast by {v.creator.name}</span>
                        <RoleBadge role={v.creator.role} />
                      </div>
                    )}
                  </div>
                  <AdminOnly>
                    <button
                      onClick={() => handleDelete(v.id)}
                      className="rounded-lg p-2 text-red-600 hover:bg-red-50"
                      aria-label="Delete vote"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </AdminOnly>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Cast a Vote">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-navy">Ticker</label>
            <input
              required
              value={form.ticker}
              onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
              placeholder="AAPL"
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-navy">Decision</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {Object.keys(ACTION_META).map((a) => {
                const meta = ACTION_META[a];
                const Icon = meta.icon;
                const selected = form.action === a;
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setForm({ ...form, action: a })}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-3 py-3 text-sm font-semibold transition ${
                      selected
                        ? `${meta.badge} ring-2 ${meta.ring}`
                        : 'border-navy-100 bg-white text-navy hover:bg-navy-50'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-navy">Reason / Note</label>
            <textarea
              rows={4}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Why this decision? Members will see your reasoning."
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Casting…' : 'Cast Vote'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
