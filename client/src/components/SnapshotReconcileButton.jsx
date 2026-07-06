import { useState } from 'react';
import { History, Check, AlertTriangle } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

// Retro-fit a late-recorded trade basket into the historical value chart. The
// PortfolioSnapshot rows from the trade date onward were captured against the
// old book — they still count what we sold and miss what we bought — so this
// re-marks each affected day from price history. Dry-run first (a full
// before→after table), commit second. Super-admin only.
//
// The defaults are the Jun 23 2026 rebalance the broker confirmed late, so the
// common case is preview → commit. Every field is editable for the next time.
const DEFAULT_LEGS = [
  'BUY GD 13',
  'BUY BN 99',
  'BUY APLD 183',
  'BUY SCHD 168',
  'BUY JNJ 10',
  'SELL HD 5',
  'SELL VOO 30',
  'SELL NOC 4',
  'SELL IBRX 176',
].join('\n');
const DEFAULT_NET_CASH = '1194.09';
const DEFAULT_START = '2026-06-23';

function usd(n) {
  return n == null
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// One leg per line: "BUY GD 13" / "SELL VOO 30". Extra columns (price, net
// amount) are ignored, so pasting raw broker rows works too.
function parseLegs(text) {
  const legs = [];
  for (const raw of text.split('\n')) {
    const tokens = raw.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length < 3) continue;
    const side = /^buy$/i.test(tokens[0]) ? 'Buy' : /^sell$/i.test(tokens[0]) ? 'Sell' : null;
    if (!side) continue;
    const ticker = tokens[1].toUpperCase();
    const shares = Number(tokens[2].replace(/,/g, ''));
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker) || !Number.isFinite(shares) || shares <= 0) continue;
    legs.push({ side, ticker, shares });
  }
  return legs;
}

export default function SnapshotReconcileButton({ onDone }) {
  const { isSuperAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [legsText, setLegsText] = useState(DEFAULT_LEGS);
  const [netCash, setNetCash] = useState(DEFAULT_NET_CASH);
  const [startDate, setStartDate] = useState(DEFAULT_START);
  const [endDate, setEndDate] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [committed, setCommitted] = useState(false);

  if (!isSuperAdmin) return null;

  function start() {
    setPreview(null);
    setError('');
    setCommitted(false);
    setOpen(true);
  }

  async function run(commit) {
    setBusy(true);
    setError('');
    try {
      const legs = parseLegs(legsText);
      if (legs.length === 0) throw new Error('No legs parsed — each line needs BUY/SELL, a symbol, and a share count.');
      const { data } = await api.post('/holdings/snapshot/reconcile', {
        startDate,
        endDate: endDate || undefined,
        legs,
        netCashDelta: Number(netCash),
        commit,
      });
      setPreview(data);
      if (data.committed) {
        setCommitted(true);
        onDone?.();
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Reconcile failed');
    } finally {
      setBusy(false);
    }
  }

  const rows = preview?.rows || [];
  const anyMissing = preview?.anyMissing || (preview?.missingTickers?.length ?? 0) > 0;

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="flex items-center gap-1.5 text-xs font-semibold text-navy-500 hover:text-navy-800"
      >
        <History className="h-3.5 w-3.5" />
        Reconcile chart for a late trade
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Reconcile value chart" size="xl">
        <div className="space-y-4">
          <p className="text-xs text-navy-400">
            Fixes the historical <span className="font-semibold">Performance Over Time</span> line when a trade
            basket executed on a past date but was recorded late. Every snapshot from the start date on is re-marked
            from price history. <span className="font-semibold">Preview first</span> — nothing is written until you
            commit. Run this while still on the sheet, before switching to database mode.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-navy-500">
              Trade / execution date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </label>
            <label className="text-xs font-semibold text-navy-500">
              Through (blank = today)
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </label>
          </div>

          <label className="block text-xs font-semibold text-navy-500">
            Net cash the basket moved (sells − buys, broker net amounts)
            <input
              type="text"
              inputMode="decimal"
              value={netCash}
              onChange={(e) => setNetCash(e.target.value)}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm tabular-nums focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </label>

          <label className="block text-xs font-semibold text-navy-500">
            Legs — one per line: <span className="font-mono font-normal">BUY GD 13</span> / <span className="font-mono font-normal">SELL VOO 30</span>
            <textarea
              rows={6}
              value={legsText}
              onChange={(e) => {
                setLegsText(e.target.value);
                setPreview(null);
              }}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 font-mono text-xs focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {preview && rows.length === 0 && !error && (
            <div className="rounded-lg bg-gold-50 px-3 py-2 text-xs text-gold-800">
              {preview.note || 'No snapshots fall in that date range.'}
            </div>
          )}

          {rows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-lg border border-navy-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-navy-50 text-[11px] uppercase tracking-wider text-navy-400">
                  <tr>
                    <th className="px-3 py-1.5 text-left">Date</th>
                    <th className="px-3 py-1.5 text-right">Chart shows</th>
                    <th className="px-3 py-1.5 text-right">Correction</th>
                    <th className="px-3 py-1.5 text-right">Corrected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {rows.map((r) => (
                    <tr key={r.date} className={r.missing?.length ? 'bg-red-50' : ''}>
                      <td className="px-3 py-1.5 tabular-nums text-navy">{r.date}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-navy-400">{usd(r.before.totalValue)}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-semibold tabular-nums ${
                          r.delta >= 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {r.delta >= 0 ? '+' : '−'}
                        {usd(Math.abs(r.delta))}
                        {r.missing?.length ? ' ⚠' : ''}
                      </td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-navy">
                        {usd(r.after.totalValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && anyMissing && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Some days (highlighted) have no price for a traded ticker, so they can't be committed yet. Open the GP
              chart for {(preview?.missingTickers || []).join(', ') || 'those tickers'} once to warm the price cache,
              then preview again.
            </div>
          )}

          {committed && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <Check className="h-4 w-4" />
              Corrected {preview?.count ?? rows.length} snapshot{(preview?.count ?? rows.length) === 1 ? '' : 's'}. The
              chart will refresh.
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {committed ? 'Done' : 'Cancel'}
            </Button>
            {!committed && (
              <>
                <Button variant="gold" onClick={() => run(false)} disabled={busy}>
                  {busy ? 'Working…' : 'Preview'}
                </Button>
                {preview && rows.length > 0 && !anyMissing && (
                  <Button onClick={() => run(true)} disabled={busy}>
                    {busy ? 'Writing…' : `Commit ${rows.length} day${rows.length === 1 ? '' : 's'}`}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
