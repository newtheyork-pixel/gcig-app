import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// SI — short interest for the focused ticker, off two keyless FINRA
// feeds that answer different questions: the consolidated bi-monthly
// settlement file (how big the short position IS, twice a month, on a
// lag) and the Reg SHO daily short-volume file (what share of today's
// off-exchange prints were short sales — flow, not position). The two
// are labelled separately and degrade separately: a feed that refused
// the deployment says so in a sentence, never as a zero.

const fmt = {
  num: (v) =>
    v == null || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US'),
  // Chip-sized share counts. 146,547,784 belongs in the table; the
  // headline wants 146.5M.
  compact: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  },
  // FINRA's changePercent is already in percent units (-7.97 means
  // -7.97%) — sign it, don't rescale it.
  pctSigned: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
  // The daily short-volume share arrives as a fraction (0..1).
  fracPct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`,
  dtc: (v) => (v == null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(2)}x`),
};

// One headline chip: dim label, the number, an optional muted sub-line
// (usually the as-of date). `tone` colors the value pos/neg the way
// the other panels speak direction.
function Chip({ label, value, sub, tone }) {
  const color =
    tone === 'pos'
      ? 'var(--term-positive)'
      : tone === 'neg'
        ? 'var(--term-negative)'
        : undefined;
  return (
    <div
      style={{
        border: '1px solid var(--term-border)',
        padding: '8px 12px',
        minWidth: 120,
        flex: '1 1 auto',
      }}
    >
      <div
        style={{
          color: 'var(--term-fg-dim)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11, marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export default function ShortInterest({ ticker }) {
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
      .get(`/short-interest/${encodeURIComponent(ticker)}`)
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
        <div className="term-loading">Enter a ticker to load short interest.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading short interest for {ticker.toUpperCase()}…</div>
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

  const settlements = Array.isArray(data.settlements) ? data.settlements : [];
  const latest = settlements[0] || null;
  const daily = data.dailyShortPct || null;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{(data.ticker || ticker).toUpperCase()}</span>
        <span className="name">Short Interest</span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Chip
          label="Shares Short"
          value={fmt.compact(latest?.shares)}
          sub={latest ? `settled ${latest.date}` : null}
        />
        <Chip
          label="vs Prior"
          value={fmt.pctSigned(latest?.changePct)}
          sub={latest?.prior != null ? `prior ${fmt.compact(latest.prior)}` : null}
          // More shares short is pressure on the name, so growth reads
          // red and a cover reads green — the inverse of a price move.
          tone={
            latest?.changePct == null ? undefined : latest.changePct > 0 ? 'neg' : 'pos'
          }
        />
        <Chip label="Days to Cover" value={fmt.dtc(latest?.daysToCover)} />
        <Chip
          label="Daily Short Vol"
          value={fmt.fracPct(daily?.pct)}
          sub={daily ? daily.date : null}
        />
      </div>

      {/* A feed that refused this deployment is an outage of OURS and
          is said in those words. Zeros here would read as a company
          nobody shorts, which is a different claim entirely. */}
      {!data.consolidatedAvailable ? (
        <div className="term-loading">
          Consolidated short interest is not available from this deployment —
          FINRA's API refused the request.
        </div>
      ) : settlements.length === 0 ? (
        <div className="term-loading">
          No consolidated short interest on file for {(data.ticker || ticker).toUpperCase()}.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Settlement</th>
              <th className="num">Shares Short</th>
              <th className="num">Prior</th>
              <th className="num">Chg %</th>
              <th className="num">Days/Cover</th>
              <th className="num">ADV</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((s) => (
              <tr key={s.date}>
                <td className="sym">{s.date}</td>
                <td className="num">{fmt.num(s.shares)}</td>
                <td className="num">{fmt.num(s.prior)}</td>
                <td
                  className={`num ${s.changePct == null ? '' : s.changePct > 0 ? 'neg' : 'pos'}`}
                >
                  {fmt.pctSigned(s.changePct)}
                </td>
                <td className="num">{fmt.dtc(s.daysToCover)}</td>
                <td className="num">{fmt.num(s.adv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!data.dailyAvailable ? (
        <div className="term-loading">
          Daily short volume is not available from this deployment — FINRA's
          file server refused the request.
        </div>
      ) : daily == null ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
          No off-exchange short-volume row for this symbol on the latest
          trading day's file.
        </div>
      ) : (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
          {daily.date}: {fmt.num(daily.shortVol)} of {fmt.num(daily.totalVol)}{' '}
          off-exchange shares sold short ({fmt.fracPct(daily.pct)}).
        </div>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        FINRA consolidated short interest, bi-monthly settlement — positions
        publish on a lag, so the newest print can be weeks old · FINRA Reg SHO
        daily short volume, off-exchange — flow, not the position.
      </div>
    </div>
  );
}
