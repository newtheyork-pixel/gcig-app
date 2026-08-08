import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// EVTS — when the book reports, in one view.
//
// Port of the mac EarningsCalendarPanel: GET /holdings/earnings serves
// every held name's next report inside 60 days with bmo/amc/dmh
// timing, and until now only the mac rendered it. "Two of the twelve
// report Tuesday" should never require opening twelve EARN panes.

const HOUR = {
  bmo: 'before open',
  amc: 'after close',
  dmh: 'during hours',
};

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${m}/${day}/${y}`;
};

const daysAway = (d) => {
  if (!d) return null;
  const target = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  return Math.round((target - Date.now()) / 86400000);
};

export default function EarningsCalendar({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api
      .get('/holdings/earnings')
      .then(({ data }) => setRows(data.upcoming || []))
      .catch((e) => setErr(e.response?.data?.error || e.message));
  }, []);

  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!rows) return <div className="term-panel"><div className="term-loading">Loading the book&apos;s calendar…</div></div>;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="name">Earnings calendar</span>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, marginLeft: 8 }}>
          every holding, next 60 days
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="term-loading">No holding reports inside 60 days.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Sym</th><th>Name</th><th>Date</th><th>In</th><th>When</th><th className="num">EPS est</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const days = daysAway(r.date);
              return (
                <tr key={r.ticker}>
                  <td className="sym">
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpen?.({ ticker: r.ticker, fn: 'EARN' }); }}>
                      {r.ticker}
                    </a>
                  </td>
                  <td>{r.name || '—'}</td>
                  <td>{fmtDate(r.date)}</td>
                  <td style={days != null && days <= 2 ? { color: 'var(--term-amber)', fontWeight: 700 } : {}}>
                    {days == null ? '—' : days <= 0 ? 'TODAY' : `${days}d`}
                  </td>
                  {/* bmo/amc decides whether the print lands while the
                      market can react or overnight — worth a column. */}
                  <td>{HOUR[r.hour] || '—'}</td>
                  <td className="num">{r.epsEstimate != null ? r.epsEstimate.toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
