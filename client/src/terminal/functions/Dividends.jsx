import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// DVD — one ticker's cash dividend history off the keyless NASDAQ
// quote API: yield and annualized rate up top, then every payment
// with its ex/pay/declaration dates. Rows arrive newest-first, so the
// chronological predecessor of row i is row i+1 — that comparison
// drives the raise/cut marker, which is the one thing a dividend
// table is really read for.
//
// Coverage is honest about its edges: the upstream only carries
// NASDAQ-listed names, and for a NYSE symbol it sends empty rows plus
// its own one-line reason, which the server passes through as `note`.
// An empty table with the reason beats a table implying a company
// never paid.

const fmt = {
  date: (s) => s || '—',
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`),
  // Amounts run from AAPL's $0.27 to QQQ's $0.81349 — show at least
  // cents, keep the upstream's extra precision when it sent some.
  amt: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const frac = String(v).split('.')[1] || '';
    return `$${Number(v).toFixed(Math.min(5, Math.max(2, frac.length)))}`;
  },
};

// The raise/cut marker for one row against its chronological
// predecessor. Null when either amount is missing or nothing changed
// — a dash where an arrow would be a guess.
function changeMark(row, prev) {
  if (!prev || row.amount == null || prev.amount == null) return null;
  if (row.amount > prev.amount) {
    return { cls: 'pos', glyph: '▲', title: `Raised from ${fmt.amt(prev.amount)}` };
  }
  if (row.amount < prev.amount) {
    return { cls: 'neg', glyph: '▼', title: `Cut from ${fmt.amt(prev.amount)}` };
  }
  return null;
}

export default function Dividends({ ticker }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    api
      .get(`/terminal/dividends/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (!cancelled) setData(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load dividend history.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading dividends for {ticker.toUpperCase()}…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (!data) return null;

  const rows = Array.isArray(data.rows) ? data.rows : [];

  const headerStat = (label, value) => (
    <span style={{ fontSize: 12, display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span
        style={{
          color: 'var(--term-fg-dim)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  );

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{(data.ticker || ticker).toUpperCase()}</span>
        <span className="name">Dividend History</span>
      </div>

      <div
        style={{
          border: '1px solid var(--term-border)',
          padding: '8px 12px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 22px',
        }}
      >
        {headerStat('Yield', fmt.pct(data.yield))}
        {headerStat('Annualized', fmt.amt(data.annualized))}
        {headerStat('Ex-date', fmt.date(data.exDate))}
      </div>

      {rows.length === 0 ? (
        <div className="term-loading">
          {/* The upstream's own sentence when it gave one (a NYSE
              listing it may not serve), otherwise a plain no-history
              line. Neither is a zero. */}
          {data.note
            ? `${data.note} — no dividend rows for ${(data.ticker || ticker).toUpperCase()}.`
            : `No dividend history on file for ${(data.ticker || ticker).toUpperCase()}.`}
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Ex-date</th>
              <th className="num">Amount</th>
              <th style={{ width: 18 }} aria-label="Change vs prior" />
              <th>Pay date</th>
              <th>Declared</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const mark = changeMark(r, rows[i + 1]);
              return (
                <tr key={`${r.exDate || 'none'}-${i}`}>
                  <td className="sym">{fmt.date(r.exDate)}</td>
                  <td className="num">{fmt.amt(r.amount)}</td>
                  <td className={mark ? mark.cls : ''} title={mark ? mark.title : undefined}>
                    {mark ? mark.glyph : ''}
                  </td>
                  <td>{fmt.date(r.payDate)}</td>
                  <td>{fmt.date(r.declared)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Source: nasdaq.com · newest first · 24h cache. Arrows mark a raise
        (green) or cut (red) vs the prior payment.
      </div>
    </div>
  );
}
