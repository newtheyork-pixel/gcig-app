import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// ECO — the economic calendar. No ticker; the payload is club-wide
// (GET /api/eco). Two halves: the next 14 days of scheduled data
// releases, then the most recent prints of a fixed high-signal set.
//
// Two honesty notes baked into the rendering rather than left to a
// footer nobody reads. FRED publishes no consensus estimates, so the
// Forecast column is a dash by design — the tooltip says so, because
// a silent dash reads as "we failed to load it". And FOMC decisions
// are not a FRED release: they arrive on the Fed press-release wire
// in Top News, so this panel deliberately does not guess at meeting
// dates; H.15 Selected Interest Rates is the closest watched release.

const NO_CONSENSUS =
  'FRED carries no consensus estimates. The dash is deliberate, not a load failure.';

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

// Value formatting keyed off the service's cosmetic unit: '%' is a
// suffix, 'claims' is a big integer with thousands separators, ''
// (the NFCI index) is a bare 2dp number.
const fmtValue = (v, unit) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (unit === '%') return `${Number(v).toFixed(2)}%`;
  if (unit === 'claims') return Number(v).toLocaleString();
  return Number(v).toFixed(2);
};

const sectionStyle = {
  color: 'var(--term-fg-dim)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  margin: '10px 0 4px',
};

export default function Economic() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get('/eco')
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
        <div className="term-loading">Loading economic calendar…</div>
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

  // The server says explicitly when it has no FRED key — render that
  // as configuration, not as a suspiciously quiet fortnight.
  if (data.configured === false) {
    return (
      <div className="term-panel">
        <div className="term-panel-header">
          <span className="ticker">ECO</span>
          <span className="name">Economic Calendar</span>
        </div>
        <div className="term-loading">
          FRED_API_KEY is not configured on the server, so the calendar
          has no source. The key is free from the St. Louis Fed.
        </div>
      </div>
    );
  }

  const upcoming = data.upcoming || [];
  const watched = upcoming.filter((r) => r.watched);
  const rows = showAll ? upcoming : watched;
  const hidden = upcoming.length - watched.length;
  const prints = data.prints || [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">ECO</span>
        <span className="name">Economic Calendar</span>
        {data.fetchedAt ? (
          <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
            {new Date(data.fetchedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={sectionStyle}>NEXT 14 DAYS</div>
        {/* The unwatched majority (regional Feds, weekly energy stats)
            stays behind this flag so the releases the club actually
            plans around are what the pane opens on. */}
        {hidden > 0 ? (
          <>
            <button
              className={`term-tab${!showAll ? ' active' : ''}`}
              onClick={() => setShowAll(false)}
            >
              Watched
            </button>
            <button
              className={`term-tab${showAll ? ' active' : ''}`}
              onClick={() => setShowAll(true)}
            >
              All ({upcoming.length})
            </button>
          </>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="term-loading">
          {data.upcomingFailed
            ? 'Could not reach FRED for the release schedule. Retrying shortly.'
            : upcoming.length === 0
            ? 'No scheduled releases came back from FRED for the next 14 days.'
            : 'No watched releases inside 14 days. Switch to All to see the rest.'}
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>In</th>
              <th>Release</th>
              <th className="num" title={NO_CONSENSUS}>
                Forecast
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const days = daysAway(r.date);
              return (
                <tr key={`${r.releaseId ?? r.release}:${r.date}`}>
                  <td>{fmtDate(r.date)}</td>
                  <td style={days != null && days <= 1 ? { color: 'var(--term-amber)', fontWeight: 700 } : {}}>
                    {days == null ? '—' : days <= 0 ? 'TODAY' : `${days}d`}
                  </td>
                  <td style={r.watched ? { fontWeight: 700 } : {}}>{r.release}</td>
                  {/* forecast is null by contract — FRED has no
                      consensus numbers and the server does not invent
                      them. Rendered as a dash with the reason on
                      hover. */}
                  <td className="num" title={NO_CONSENSUS}>
                    —
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={sectionStyle}>RECENT PRINTS</div>
      {prints.length === 0 ? (
        <div className="term-loading">No recent prints came back from FRED.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Series</th>
              <th className="num">Value</th>
              <th className="num">Prior</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {prints.map((p) => (
              <tr key={p.series}>
                <td title={p.series}>{p.label}</td>
                <td className="num">{fmtValue(p.value, p.unit)}</td>
                <td className="num">{fmtValue(p.prior, p.unit)}</td>
                <td>{fmtDate(p.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Source: FRED (St. Louis Fed) · release schedule + latest prints,
        cached ~1h. FRED publishes no consensus forecasts. FOMC decisions
        are not a FRED release; they arrive on the Fed wire in Top News.
      </div>
    </div>
  );
}
