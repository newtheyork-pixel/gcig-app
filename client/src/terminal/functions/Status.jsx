import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// STATUS — the terminal reporting on itself.
//
// Two self-reports that existed for months with no reader: the quote
// scheduler's honest census (tracked, priced, cycle time, oldest
// quote) and the news wires' per-feed roll call, added after the WSJ
// feed spent eighteen months dead while returning HTTP 200. A wire
// whose newest item is days old renders in the color of a problem —
// this panel exists so the next silent death is noticed in a day.

const ageOf = (iso) => {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3600000; // hours
};

export default function Status() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    api
      .get('/terminal/status')
      .then(({ data }) => setData(data))
      .catch((e) => setErr(e.response?.data?.error || e.message));
  };
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => clearInterval(id);
  }, []);

  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!data) return <div className="term-panel"><div className="term-loading">Reading the plumbing…</div></div>;

  const q = data.quotes || {};
  return (
    <div className="term-panel">
      <div className="term-panel-header"><span className="name">System status</span></div>

      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--term-blue)', margin: '6px 0 2px' }}>QUOTE SCHEDULER</div>
      <div style={{ fontSize: 11 }}>
        {q.priced ?? '—'} of {q.tracked ?? '—'} names priced · full cycle ~{q.cycleMinutes ?? '—'}m · oldest quote{' '}
        <span style={{ color: (q.oldestSeconds ?? 0) > 2700 ? 'var(--term-negative)' : 'inherit' }}>
          {q.oldestSeconds != null ? `${Math.round(q.oldestSeconds / 60)}m` : '—'}
        </span>
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--term-blue)', margin: '10px 0 2px' }}>NEWS WIRES</div>
      <table className="term-table">
        <thead><tr><th>Feed</th><th className="num">Items</th><th>Newest</th></tr></thead>
        <tbody>
          {(data.feeds || []).map((f) => {
            const hours = ageOf(f.newest);
            const deadish = f.items === 0 || (hours != null && hours > 48);
            return (
              <tr key={f.id}>
                <td>{f.source}</td>
                <td className="num">{f.items}</td>
                <td style={deadish ? { color: 'var(--term-negative)', fontWeight: 700 } : {}}>
                  {hours == null ? '—' : hours < 1 ? `${Math.round(hours * 60)}m ago` : `${Math.round(hours)}h ago`}
                  {deadish ? ' · CHECK THIS FEED' : ''}
                </td>
              </tr>
            );
          })}
          {(data.feeds || []).length === 0 && (
            <tr><td colSpan={3} style={{ color: 'var(--term-fg-muted)' }}>No wire fetch yet this process. Open TOP once and recheck.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
