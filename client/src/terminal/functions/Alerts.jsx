import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// ALRT — what the club's own charter says somebody should be told.
//
// A straight port of the mac AlertsPanel: the IPS has hard numbers in
// it (10% single-position cap, 5% cash floor, the mandatory-review
// rule past a 15% decline) and the server evaluates them at
// GET /alerts. The design rule carries over: every alert shows the
// number, the threshold, and then quotes the charter, so a member who
// has never read the IPS learns what it says from the alert — and a
// rule that could not run reads as NOT CHECKED in the color of a
// problem, never as a pass.

const TONE = {
  breach: 'var(--term-negative)',
  action: 'var(--term-amber)',
  watch: 'var(--term-cyan, #6ec1d4)',
};

const BADGE = {
  breach: 'BREACH',
  action: 'ACTION',
  watch: 'WATCH',
};

export default function Alerts({ onOpen }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setErr(null);
    api
      .get('/alerts')
      .then(({ data }) => setData(data))
      .catch((e) => setErr(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading && !data) return <div className="term-panel"><div className="term-loading">Checking the book against the IPS…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;

  const alerts = data?.alerts || [];
  const s = data?.summary || {};
  const unchecked = s.unchecked || 0;

  const count = (label, n, tone) => (
    <div style={{ marginRight: 16 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--term-blue)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: n > 0 ? tone : 'var(--term-fg-muted)' }}>{n || 0}</div>
    </div>
  );

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="name">Policy alerts</span>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, marginLeft: 8 }}>
          against the club&apos;s own IPS
        </span>
        <button className="term-btn" style={{ marginLeft: 'auto' }} onClick={load}>RECHECK</button>
      </div>

      <div style={{ display: 'flex', padding: '6px 0' }}>
        {count('BREACH', s.breach, TONE.breach)}
        {count('ACTION', s.action, TONE.action)}
        {count('WATCH', s.watch, TONE.watch)}
        {unchecked > 0 && count('NOT CHECKED', unchecked, TONE.breach)}
      </div>
      {unchecked > 0 && (
        <div style={{ color: TONE.breach, fontSize: 10, fontWeight: 700, paddingBottom: 6 }}>
          Some rules could not run. Silence below is not compliance.
        </div>
      )}

      {alerts.length === 0 ? (
        <div style={{ color: 'var(--term-positive)', fontSize: 11, padding: '10px 0' }}>
          Nothing to raise. Every rule ran and every one passed.
        </div>
      ) : (
        alerts.map((a) => (
          <div
            key={a.id}
            style={{
              borderLeft: `2px solid ${TONE[a.kind] || TONE.breach}`,
              padding: '7px 10px',
              borderBottom: '1px solid var(--term-border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{
                  fontSize: 8, fontWeight: 700, padding: '1px 4px',
                  background: TONE[a.kind] || TONE.breach, color: 'var(--term-bg)',
                }}
              >
                {BADGE[a.kind] || 'NOT CHECKED'}
              </span>
              <span style={{ fontWeight: 700, fontSize: 11 }}>{a.title || '—'}</span>
              {a.ticker && (
                <a
                  href="#"
                  style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 10 }}
                  onClick={(e) => { e.preventDefault(); onOpen?.({ ticker: a.ticker, fn: 'DES' }); }}
                >
                  {a.ticker}
                </a>
              )}
            </div>
            {a.detail && (
              <div style={{ fontSize: 10, color: 'var(--term-fg-dim)', marginTop: 3 }}>{a.detail}</div>
            )}
            {a.source && (
              // Where the rule comes from, so nobody has to take the
              // alert on trust.
              <div style={{ fontSize: 9, color: 'var(--term-fg-muted)', marginTop: 2 }}>{a.source}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
