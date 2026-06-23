import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

// Direct Buy/Sell on the portfolio — no vote, no envelope. Posts to
// /holdings/trade, which debits/credits cash, relieves lots FIFO on a sell
// (with realized P/L), and guards buying power + over-sell. Advisory guards
// here just disable the button early; the server is authoritative.
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const inputCls =
  'mt-1 w-full rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

function usd(n) {
  return n == null
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-navy-400">{label}</span>
      {children}
    </label>
  );
}

function Warn({ children }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </div>
  );
}

export default function TradeButton({ holdings = [], cash = 0, onDone }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState('Buy');
  const [ticker, setTicker] = useState('');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const held = useMemo(() => holdings.filter((h) => !h.isCash && h.ticker), [holdings]);
  const heldByTicker = useMemo(() => {
    const m = {};
    for (const h of held) m[h.ticker] = h;
    return m;
  }, [held]);

  function start() {
    setSide('Buy');
    setTicker('');
    setShares('');
    setPrice('');
    setError('');
    setOpen(true);
  }

  const t = ticker.trim().toUpperCase();
  const s = Number(shares);
  const p = Number(price);
  const position = heldByTicker[t];
  const baseValid =
    TICKER_RE.test(t) && Number.isInteger(s) && s > 0 && Number.isFinite(p) && p > 0;
  const total = baseValid ? s * p : null;
  const overSell = side === 'Sell' && position && s > position.shares;
  const noPosition = side === 'Sell' && !!t && !position;
  const overSpend = side === 'Buy' && total != null && total > cash + 1e-6;
  const canSubmit = baseValid && !overSell && !noPosition && !overSpend && !submitting;

  // Default the price to the position's current price when selling a holding.
  function setTickerSell(tk) {
    setTicker(tk);
    const pos = heldByTicker[tk];
    if (pos?.price != null) setPrice(String(pos.price));
  }

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      await api.post('/holdings/trade', { side, ticker: t, shares: s, pricePerShare: p });
      setOpen(false);
      onDone?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Trade failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="gold" onClick={start}>
        <ArrowLeftRight className="h-4 w-4" />
        Trade
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Trade" size="lg">
        <div className="space-y-4">
          <div className="inline-flex rounded-lg border border-navy-100 p-0.5">
            <button
              type="button"
              onClick={() => setSide('Buy')}
              className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold ${
                side === 'Buy' ? 'bg-emerald-600 text-white' : 'text-navy-500'
              }`}
            >
              <TrendingUp className="h-4 w-4" />
              Buy
            </button>
            <button
              type="button"
              onClick={() => setSide('Sell')}
              className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold ${
                side === 'Sell' ? 'bg-red-600 text-white' : 'text-navy-500'
              }`}
            >
              <TrendingDown className="h-4 w-4" />
              Sell
            </button>
          </div>

          {side === 'Sell' ? (
            <Field label="Position">
              <select value={t} onChange={(e) => setTickerSell(e.target.value)} className={inputCls}>
                <option value="">Select a holding…</option>
                {held.map((h) => (
                  <option key={h.ticker} value={h.ticker}>
                    {h.ticker} — {h.shares} sh held
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Ticker">
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="AAPL"
                className={inputCls}
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Shares">
              <input
                type="number"
                min={1}
                step={1}
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                className={inputCls}
              />
              {side === 'Sell' && position && (
                <button
                  type="button"
                  className="mt-1 text-[11px] font-semibold text-gold-700 underline"
                  onClick={() => setShares(String(position.shares))}
                >
                  sell all {position.shares}
                </button>
              )}
            </Field>
            <Field label="Price / share ($)">
              <input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {total != null && (
            <div className="rounded-lg border border-navy-100 bg-navy-50 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-navy-400">{side === 'Buy' ? 'Cost' : 'Proceeds'}</span>
                <span className="font-semibold text-navy">{usd(total)}</span>
              </div>
              {side === 'Buy' && (
                <div className="flex justify-between">
                  <span className="text-navy-400">Cash after</span>
                  <span className={`font-semibold ${cash - total < 0 ? 'text-red-700' : 'text-navy'}`}>
                    {usd(cash - total)}
                  </span>
                </div>
              )}
              {side === 'Sell' && position && (
                <div className="flex justify-between">
                  <span className="text-navy-400">Est. realized P/L</span>
                  <span
                    className={`font-semibold ${
                      (p - position.costBasis) * s >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {usd((p - position.costBasis) * s)}
                  </span>
                </div>
              )}
            </div>
          )}

          {overSell && <Warn>That's more than the {position.shares} shares held.</Warn>}
          {noPosition && <Warn>You don't hold {t} — nothing to sell.</Warn>}
          {overSpend && <Warn>Cost exceeds available cash ({usd(cash)}). Record a deposit first.</Warn>}
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

          <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? 'Working…' : `${side}${s > 0 ? ` ${s}` : ''}${t ? ` ${t}` : ''}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
