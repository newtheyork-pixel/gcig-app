import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// CORR — how the book hangs together. Pairwise Pearson correlation of
// daily log returns across every holding, from the server's stored
// bar cache, on two windows (3m / 1y). The cell color carries the
// reading: red is a pair that moves together, green is a pair that
// leans against each other, and a dash is a pair with too few common
// observations to deserve a number at all. The "vs BOOK" column is
// the cheap diversifier score — each name against the equal-weight
// average of everything else we own.
//
// The basis line at the bottom is not decoration: these are
// close-to-close returns with dividends excluded, and until dividend
// data lands the panel should keep saying so.

const fmt = {
  rho: (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(2)),
};

// Background by signed ρ: red for co-movement, green for a hedge,
// alpha scaled by |ρ| so the hot pairs read from across the room.
// Null cells stay unpainted — absence of evidence should look like
// absence, not like zero.
function cellStyle(rho) {
  if (rho == null || Number.isNaN(rho)) {
    return { color: 'var(--term-fg-muted)' };
  }
  const a = 0.06 + 0.5 * Math.min(1, Math.abs(rho));
  const bg = rho >= 0 ? `rgba(224, 66, 47, ${a})` : `rgba(62, 207, 132, ${a})`;
  return { background: bg };
}

// The first column stays put while the matrix scrolls under it — a
// 12x12 book plus the diversifier column is wider than the pane, and
// a row without its label is unreadable.
const sticky = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--term-bg-panel)',
};

export default function Correlation({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [win, setWin] = useState('3m');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get('/correlation')
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
  }, []);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Computing correlations…</div>
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

  const tickers = data.tickers || [];
  const w = data.windows?.[win] || null;

  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  // Tooltip carries what the cell cannot: the exact value and how many
  // observations stand behind it — or why there is no value at all.
  const cellTitle = (a, b, rho, obs) =>
    rho == null
      ? `${a} × ${b} — under the minimum (${obs ?? 0} of ${w?.minObservations ?? '?'} common observations)`
      : `${a} × ${b} — ρ ${rho.toFixed(3)} on ${obs} observations`;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">CORR</span>
        <span className="name">
          Portfolio correlation
          {tickers.length ? ` · ${tickers.length} holdings` : ''}
          {data.fetchedAt ? ` · as of ${String(data.fetchedAt).slice(0, 10)}` : ''}
        </span>
      </div>

      <div className="term-gp-ranges" style={{ margin: '4px 0' }}>
        {['3m', '1y'].map((k) => (
          <button
            key={k}
            type="button"
            className={`term-gp-btn${k === win ? ' active' : ''}`}
            onClick={() => setWin(k)}
          >
            {k.toUpperCase()}
          </button>
        ))}
        {w ? (
          <span className="term-gp-interval">
            {w.tradingDays} trading days · min {w.minObservations} shared obs per pair
          </span>
        ) : null}
      </div>

      {data.error ? <div className="term-error">{data.error}</div> : null}

      {tickers.length === 0 || !w ? (
        <div className="term-loading">
          No holdings to correlate — the positions sheet returned no non-cash
          names{data.error ? '' : ', or the matrix is still warming'}.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="term-table" style={{ width: 'max-content', minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={sticky} />
                <th
                  className="num"
                  title="Correlation to the equal-weight average return of the rest of the book — low or negative means this name diversifies what we already own"
                  style={{ borderRight: '1px solid var(--term-border)' }}
                >
                  vs BOOK
                </th>
                {tickers.map((t) => (
                  <th key={t} className="num">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickers.map((rowT, i) => (
                <tr key={rowT}>
                  <td
                    className="sym term-row-link"
                    style={{ ...sticky, cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen?.({ ticker: rowT, fn: 'DES' })}
                    onKeyDown={rowKey(() => onOpen?.({ ticker: rowT, fn: 'DES' }))}
                    title={`Open ${rowT} DES`}
                  >
                    {rowT}
                  </td>
                  <td
                    className="num"
                    style={{
                      ...cellStyle(w.avgToBook?.[i]),
                      borderRight: '1px solid var(--term-border)',
                    }}
                    title={
                      w.avgToBook?.[i] == null
                        ? `${rowT} vs rest of book — insufficient common observations`
                        : `${rowT} vs equal-weight rest of book — ρ ${w.avgToBook[i].toFixed(3)}`
                    }
                  >
                    {fmt.rho(w.avgToBook?.[i])}
                  </td>
                  {tickers.map((colT, j) => (
                    <td
                      key={colT}
                      className="num"
                      style={
                        i === j
                          ? { color: 'var(--term-fg-muted)' }
                          : cellStyle(w.matrix?.[i]?.[j])
                      }
                      title={cellTitle(rowT, colT, w.matrix?.[i]?.[j], w.observations?.[i]?.[j])}
                    >
                      {fmt.rho(w.matrix?.[i]?.[j])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Pearson on close-to-close log returns, dividends excluded · pairs aligned
        on common trading dates, stored bars only · red moves with, green moves
        against · dash = under {w ? w.minObservations : 'the minimum'} shared
        observations · cash excluded · click a row label for DES.
      </div>
    </div>
  );
}
