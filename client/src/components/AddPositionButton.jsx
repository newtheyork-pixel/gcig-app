import { useState } from 'react';
import { Plus } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

// Adds a position by BUYING it — debits cash, creates the holding + an opening
// lot (with an optional custom date and name/sector). For the rare case where
// shares arrive without the fund paying (a transfer-in, donation, or
// correction), tick "transfer in" to skip the cash movement. Routes through the
// same /holdings/trade engine as the Trade button, so the accounting matches.
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const inputCls =
  'mt-1 w-full rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

function usd(n) {
  return n == null
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

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

export default function AddPositionButton({ onAdded, cash = 0 }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    ticker: '',
    shares: '',
    pricePerShare: '',
    buyDate: todayISO(),
    name: '',
    sector: '',
  });
  const [transfer, setTransfer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function start() {
    setForm({ ticker: '', shares: '', pricePerShare: '', buyDate: todayISO(), name: '', sector: '' });
    setTransfer(false);
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
  const cost = valid ? shares * price : null;
  const overSpend = !transfer && cost != null && cost > cash + 1e-6;
  const canSubmit = valid && !overSpend && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/holdings/trade', {
        side: 'Buy',
        ticker,
        shares,
        pricePerShare: price,
        buyDate: form.buyDate,
        name: form.name.trim() || undefined,
        sector: form.sector.trim() || undefined,
        noCash: transfer,
      });
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
            Buys a position and <span className="font-semibold">debits cash</span> — creates the holding with an
            opening lot. For shares that arrived without the fund paying (a transfer-in or correction), tick
            "transfer in" below to skip the cash movement.
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
                min={1}
                step={1}
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

          <label className="flex items-center gap-2 text-xs text-navy-600">
            <input
              type="checkbox"
              checked={transfer}
              onChange={(e) => setTransfer(e.target.checked)}
              className="h-4 w-4 rounded border-navy-200 text-gold focus:ring-gold"
            />
            Transfer in — record the shares without subtracting cash (donation / correction)
          </label>

          {form.ticker && !tickerOk && (
            <div className="text-xs text-red-700">
              Ticker must be 1–10 letters/digits (dots and dashes allowed).
            </div>
          )}
          {valid && (
            <div className="rounded-lg border border-navy-100 bg-navy-50 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-navy-400">{transfer ? 'Cost basis' : 'Cost'}</span>
                <span className="font-semibold text-navy">{usd(cost)}</span>
              </div>
              {!transfer && (
                <div className="flex justify-between">
                  <span className="text-navy-400">Cash after</span>
                  <span className={`font-semibold ${cash - cost < 0 ? 'text-red-700' : 'text-navy'}`}>
                    {usd(cash - cost)}
                  </span>
                </div>
              )}
            </div>
          )}
          {overSpend && (
            <div className="text-xs font-semibold text-red-700">
              Cost exceeds available cash ({usd(cash)}). Tick "transfer in", or record a deposit first.
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {saving ? 'Adding…' : transfer ? 'Add (transfer)' : 'Buy position'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
