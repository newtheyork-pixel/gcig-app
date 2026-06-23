import { useState } from 'react';
import { Plus } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

// Seeds a position outside the trade flow — a transfer-in, an account opening,
// or a correction. There's no "buy" to settle here, so we create the holding
// directly by writing its opening lot (shares + average cost are derived from
// the lots server-side), then optionally stamp the name/sector. Day-to-day
// positions still change through the vote -> Mark Filled flow; this is the
// manual escape hatch a super admin occasionally needs.
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const inputCls =
  'mt-1 w-full rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-navy-400">{label}</span>
      {children}
    </label>
  );
}

export default function AddPositionButton({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    ticker: '',
    shares: '',
    pricePerShare: '',
    buyDate: todayISO(),
    name: '',
    sector: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function start() {
    setForm({ ticker: '', shares: '', pricePerShare: '', buyDate: todayISO(), name: '', sector: '' });
    setError('');
    setOpen(true);
  }

  const ticker = form.ticker.trim().toUpperCase();
  const shares = Number(form.shares);
  const price = Number(form.pricePerShare);
  const tickerOk = TICKER_RE.test(ticker);
  const valid =
    tickerOk &&
    Number.isFinite(shares) &&
    shares > 0 &&
    Number.isFinite(price) &&
    price > 0 &&
    !!form.buyDate;

  async function submit() {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      // The opening lot creates the Holding (recompute derives shares + cost).
      await api.post('/holdings/lots', {
        ticker,
        shares,
        pricePerShare: price,
        buyDate: form.buyDate,
        note: 'manual add',
      });
      // Name/sector aren't carried on a lot — stamp them if provided.
      if (form.name.trim() || form.sector.trim()) {
        await api.put(`/holdings/positions/${encodeURIComponent(ticker)}`, {
          name: form.name.trim() || undefined,
          sector: form.sector.trim() || undefined,
        });
      }
      setOpen(false);
      onAdded?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to add position');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="gold" onClick={start}>
        <Plus className="h-4 w-4" />
        Add position
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a position" size="lg">
        <div className="space-y-3">
          <p className="text-xs text-navy-400">
            Seeds a position outside the trade flow — a transfer-in or a
            correction. Creates the holding with one opening lot; shares and
            average cost come from the lots. Day-to-day buys should go through
            the trade-approval flow instead.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Ticker">
              <input
                value={form.ticker}
                onChange={(e) => setForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))}
                placeholder="AAPL"
                className={inputCls}
              />
            </Field>
            <Field label="Buy date">
              <input
                type="date"
                value={form.buyDate}
                onChange={(e) => setForm((f) => ({ ...f, buyDate: e.target.value }))}
                className={inputCls}
              />
            </Field>
            <Field label="Shares">
              <input
                type="number"
                min={0}
                step="any"
                value={form.shares}
                onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))}
                className={inputCls}
              />
            </Field>
            <Field label="Cost / share ($)">
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.pricePerShare}
                onChange={(e) => setForm((f) => ({ ...f, pricePerShare: e.target.value }))}
                className={inputCls}
              />
            </Field>
            <Field label="Name (optional)">
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Apple Inc"
                className={inputCls}
              />
            </Field>
            <Field label="Sector (optional)">
              <input
                value={form.sector}
                onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))}
                placeholder="Information Technology"
                className={inputCls}
              />
            </Field>
          </div>
          {form.ticker && !tickerOk && (
            <div className="text-xs text-red-700">
              Ticker must be 1–10 letters/digits (dots and dashes allowed).
            </div>
          )}
          {valid && (
            <div className="text-xs text-navy-400">
              Opening cost: <span className="font-semibold text-navy">${(shares * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              {' '}— recorded as a lot, not a cash movement.
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!valid || saving}>
              {saving ? 'Adding…' : 'Add position'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
