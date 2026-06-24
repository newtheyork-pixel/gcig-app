import { useState } from 'react';
import { ListPlus, TrendingUp, TrendingDown, Check } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

// Bulk "record trades" — paste a broker statement (or any rows that carry a
// BUY/SELL, a symbol, a quantity, and a price) and it parses, previews, then
// applies them all in one transaction. The server runs sells before buys, so
// the order you paste in doesn't matter.
function usd(n) {
  return n == null
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// Tolerant parser. Flattens the whole paste into a token stream (splitting on
// tabs, newlines, and runs of 2+ spaces — single spaces stay so multi-word
// columns like an account name remain one token), then walks it: each BUY/SELL
// token starts a record whose symbol is the next token and whose quantity +
// price are the next two numbers. This handles BOTH tab-separated rows AND
// one-value-per-line pastes, and ignores account/net-amount columns + headers.
export function parseTrades(text) {
  const tokens = text
    .split(/[\t\n]+|\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean);
  const rows = [];
  let sideTokens = 0;
  let i = 0;
  while (i < tokens.length) {
    if (!/^(buy|sell)$/i.test(tokens[i])) {
      i++;
      continue;
    }
    sideTokens += 1;
    const side = /buy/i.test(tokens[i]) ? 'Buy' : 'Sell';
    const ticker = (tokens[i + 1] || '').toUpperCase();
    const nums = [];
    let j = i + 2;
    while (j < tokens.length && nums.length < 2 && !/^(buy|sell)$/i.test(tokens[j])) {
      const n = Number(tokens[j].replace(/,/g, ''));
      if (Number.isFinite(n)) nums.push(n);
      j += 1;
    }
    const shares = nums[0];
    const price = nums[1];
    if (/^[A-Z0-9.\-]{1,10}$/.test(ticker) && Number.isInteger(shares) && shares > 0 && price > 0) {
      rows.push({ side, ticker, shares, pricePerShare: price });
      i = j;
    } else {
      i += 1;
    }
  }
  return { rows, sideTokens };
}

export default function BulkTradeButton({ onDone }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  function start() {
    setText('');
    setParsed(null);
    setError('');
    setResult(null);
    setOpen(true);
  }

  const buyTotal = parsed?.rows
    ?.filter((r) => r.side === 'Buy')
    .reduce((s, r) => s + r.shares * r.pricePerShare, 0);
  const sellTotal = parsed?.rows
    ?.filter((r) => r.side === 'Sell')
    .reduce((s, r) => s + r.shares * r.pricePerShare, 0);

  async function execute() {
    if (!parsed?.rows?.length) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/holdings/trades', { trades: parsed.rows });
      setResult(data);
      onDone?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Bulk trade failed — nothing was recorded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="gold" onClick={start}>
        <ListPlus className="h-4 w-4" />
        Record trades
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Record trades" size="xl">
        <div className="space-y-4">
          {!result ? (
            <>
              <p className="text-xs text-navy-400">
                Paste your broker rows — each needs a <span className="font-semibold">BUY/SELL</span>, a{' '}
                <span className="font-semibold">symbol</span>, a <span className="font-semibold">quantity</span>, and
                an <span className="font-semibold">avg price</span>. Extra columns (account, net amount) are
                ignored. Sells run before buys automatically, and it's all-or-nothing.
              </p>
              <textarea
                rows={7}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setParsed(null);
                }}
                placeholder={'BUY\tGD\t13\t344.69\nSELL\tVOO\t30\t675.80'}
                className="w-full rounded-lg border border-navy-100 px-3 py-2 font-mono text-xs focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />

              {!parsed ? (
                <Button variant="gold" onClick={() => setParsed(parseTrades(text))} disabled={!text.trim()}>
                  Preview
                </Button>
              ) : (
                <>
                  {parsed.rows.length === 0 ? (
                    <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                      No trades found. Each line needs BUY/SELL, a symbol, a quantity, and a price.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-navy-100">
                      <table className="w-full text-sm">
                        <thead className="bg-navy-50 text-[11px] uppercase tracking-wider text-navy-400">
                          <tr>
                            <th className="px-3 py-1.5 text-left">Side</th>
                            <th className="px-3 py-1.5 text-left">Symbol</th>
                            <th className="px-3 py-1.5 text-right">Shares</th>
                            <th className="px-3 py-1.5 text-right">Price</th>
                            <th className="px-3 py-1.5 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-50">
                          {parsed.rows.map((r, i) => (
                            <tr key={i}>
                              <td className="px-3 py-1.5">
                                <span
                                  className={`inline-flex items-center gap-1 font-semibold ${
                                    r.side === 'Buy' ? 'text-emerald-700' : 'text-red-700'
                                  }`}
                                >
                                  {r.side === 'Buy' ? (
                                    <TrendingUp className="h-3.5 w-3.5" />
                                  ) : (
                                    <TrendingDown className="h-3.5 w-3.5" />
                                  )}
                                  {r.side}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 font-semibold text-navy">{r.ticker}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{r.shares}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.pricePerShare)}</td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-navy">
                                {usd(r.shares * r.pricePerShare)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {parsed.sideTokens !== parsed.rows.length && (
                    <div className="rounded-lg border border-gold-200 bg-gold-50 px-3 py-2 text-xs text-gold-800">
                      Found {parsed.sideTokens} BUY/SELL row(s) but could only read {parsed.rows.length} — check the
                      pasted data before recording.
                    </div>
                  )}

                  {parsed.rows.length > 0 && (
                    <div className="flex flex-wrap gap-4 text-xs text-navy-400">
                      <span>
                        Buys: <span className="font-semibold text-navy">{usd(buyTotal)}</span>
                      </span>
                      <span>
                        Sells: <span className="font-semibold text-navy">{usd(sellTotal)}</span>
                      </span>
                      <span>
                        Net cash:{' '}
                        <span className={`font-semibold ${sellTotal - buyTotal >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                          {sellTotal - buyTotal >= 0 ? '+' : '−'}
                          {usd(Math.abs(sellTotal - buyTotal))}
                        </span>
                      </span>
                    </div>
                  )}
                </>
              )}

              {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

              <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                {parsed && parsed.rows.length > 0 && (
                  <Button onClick={execute} disabled={busy}>
                    {busy ? 'Recording…' : `Record ${parsed.rows.length} trade${parsed.rows.length === 1 ? '' : 's'}`}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <Check className="h-4 w-4" />
                Recorded {result.count} trade{result.count === 1 ? '' : 's'}.
              </div>
              <div className="flex flex-wrap gap-4 text-sm text-navy-600">
                <span>
                  Realized P/L:{' '}
                  <span className={`font-semibold ${result.realizedPnl >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {result.realizedPnl >= 0 ? '+' : '−'}
                    {usd(Math.abs(result.realizedPnl))}
                  </span>
                </span>
                <span>
                  Cash now: <span className="font-semibold text-navy">{usd(result.cashAfter)}</span>
                </span>
              </div>
              <div className="flex justify-end border-t border-navy-50 pt-3">
                <Button onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
