import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// MOVR — biggest gainers and losers, ranked close-to-close over the
// tickers GCIG Terminal caches. No ticker input: it's a market-wide
// (well, universe-wide) panel. Mirrors DES/CN: fetch, then hand the
// list to the shared /annotate AI brief.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  chg: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`,
  pct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
};

export default function Movers() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/movers', { params: { limit: 10 } })
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

  useEffect(() => {
    if (!data || (!data.gainers?.length && !data.losers?.length)) return;
    let cancelled = false;
    setBriefLoading(true);
    const line = (m) => `${m.ticker} ${fmt.pct(m.changePct)} (last ${fmt.px(m.last)})`;
    const context = [
      `As of ${data.asOf || 'n/a'} — ${data.ranked}/${data.universe} cached names ranked`,
      `Gainers: ${data.gainers.map(line).join(', ') || 'none'}`,
      `Losers: ${data.losers.map(line).join(', ') || 'none'}`,
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'MOVR', context })
      .then(({ data }) => {
        if (!cancelled) setBrief(data.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading movers…</div>
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

  const empty = !data.gainers?.length && !data.losers?.length;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">MOVR</span>
        <span className="name">
          Movers{data.asOf ? ` · as of ${data.asOf}` : ''}
          {data.universe ? ` · ${data.ranked}/${data.universe} names` : ''}
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {empty ? (
        <div className="term-loading">
          Universe is still warming up. Movers populate as tickers get charted
          (GP) and the nightly price-cache refresh runs.
        </div>
      ) : (
        <div className="term-movers">
          <MoversTable title="▲ GAINERS" rows={data.gainers} dir="pos" />
          <MoversTable title="▼ LOSERS" rows={data.losers} dir="neg" />
        </div>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Close-to-close across the tickers GCIG Terminal caches — not a live
        whole-market tape.
      </div>
    </div>
  );
}

function MoversTable({ title, rows, dir }) {
  return (
    <div className="term-movers-col">
      <div className="term-movers-title">{title}</div>
      {rows.length === 0 ? (
        <div className="term-loading">None.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 22 }}>#</th>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Chg</th>
              <th className="num">Chg %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.ticker}>
                <td className="rank">{i + 1}</td>
                <td className="sym">{m.ticker}</td>
                <td className="num">{fmt.px(m.last)}</td>
                <td className={`num ${dir}`}>{fmt.chg(m.change)}</td>
                <td className={`num ${dir}`}>{fmt.pct(m.changePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
