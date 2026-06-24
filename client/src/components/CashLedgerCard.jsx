import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Wallet, Plus, Trash2 } from 'lucide-react';
import api from '../api/client.js';
import Card from './Card.jsx';
import Button from './Button.jsx';
import ResetBookButton from './ResetBookButton.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// The fund's cash, straight off the Transaction ledger: the running balance up
// top, every movement below. Buy/Sell rows arrive from trade settlement and are
// read-only here; the super admin can add the manual ones (a contribution, a
// withdrawal, a money-market dividend, a fee) and remove a mistaken manual row.
const MANUAL_KINDS = ['Deposit', 'Withdraw', 'Dividend', 'Fee'];
const MANUAL = new Set(MANUAL_KINDS);

function fmtMoney(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export default function CashLedgerCard({ onReset } = {}) {
  const { isSuperAdmin } = useAuth();
  const [cash, setCash] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [kind, setKind] = useState('Deposit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/holdings/transactions', { params: { limit: 50 } });
      setRows(data.transactions || []);
      setCash(data.cash ?? null);
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load ledger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addMovement() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('Enter a positive amount');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.post('/holdings/transactions', { kind, amount: amt, note: note || null });
      setAmount('');
      setNote('');
      await load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to add movement');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!window.confirm('Delete this cash movement?')) return;
    try {
      await api.delete(`/holdings/transactions/${id}`);
      await load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to delete');
    }
  }

  return (
    <div className="mt-6">
      <Card title="Cash ledger" kicker="Treasury">
        <div className="flex items-center gap-2 text-sm">
          <Wallet className="h-4 w-4 text-navy-400" />
          <span className="text-navy-400">Spendable cash</span>
          <span className="ml-auto text-lg font-bold tabular-nums text-navy">{fmtMoney(cash)}</span>
        </div>

        {isSuperAdmin && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-navy-50 pt-4">
            <div>
              <label className="block text-xs text-navy-400">Type</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="mt-1 rounded border border-navy-100 px-2 py-1 text-sm"
              >
                {MANUAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-navy-400">Amount ($)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-28 rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <label className="block text-xs text-navy-400">Note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <Button onClick={addMovement} disabled={saving} variant="gold">
              <Plus className="h-4 w-4" />
              {saving ? 'Adding…' : 'Add'}
            </Button>
          </div>
        )}

        {err && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
        )}

        <div className="mt-4">
          {loading ? (
            <div className="py-6 text-center text-xs text-navy-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-6 text-center text-xs text-navy-400">No cash movements yet.</div>
          ) : (
            <ul className="divide-y divide-navy-50 rounded-lg border border-navy-100">
              {rows.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      t.cashDelta >= 0
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {t.kind}
                  </span>
                  <span className="min-w-0 truncate text-navy">
                    {t.ticker ? <span className="font-semibold">{t.ticker} </span> : null}
                    {t.note ||
                      (t.shares != null
                        ? `${t.shares} sh @ $${Number(t.pricePerShare).toFixed(2)}`
                        : '')}
                  </span>
                  <span className="ml-auto whitespace-nowrap text-xs text-navy-400">
                    {t.executedAt ? format(new Date(t.executedAt), 'MMM d') : ''}
                  </span>
                  <span
                    className={`w-24 text-right font-semibold tabular-nums ${
                      t.cashDelta >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {t.cashDelta >= 0 ? '+' : '−'}
                    {fmtMoney(Math.abs(t.cashDelta))}
                  </span>
                  {isSuperAdmin && MANUAL.has(t.kind) && (
                    <button
                      type="button"
                      onClick={() => remove(t.id)}
                      className="text-navy-300 hover:text-red-600"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ResetBookButton
          onReset={() => {
            load();
            onReset?.();
          }}
        />
      </Card>
    </div>
  );
}
