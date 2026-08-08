import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// HALT — the live trading-halt tape, merged from the Nasdaq and NYSE
// wires server-side. Active halts sit on top in the negative color
// because a halt IS negative-color news until proven otherwise;
// today's resolved halts sit below, dimmer, so "it reopened" is one
// glance and not a memory test. Rows the server flagged held:true
// carry a HELD chip — the flag is the server's call (the route
// accepts ?held=… for it) and this panel simply renders whatever
// arrived, so wiring holdings in later is a query-string change, not
// a panel change.
//
// Polls every 60s — halts are the one panel where staleness bites in
// minutes — but never from a hidden tab (the News.jsx lesson: a raw
// interval kept burning the data caps from background tabs).

const POLL_INTERVAL_MS = 60_000;
const ET = 'America/New_York';

// Halt times are Eastern events and are shown as ET regardless of
// where the member sits — "halted 19:50" must mean the same instant
// to everyone reading the same tape.
function fmtEt(iso, nowMs) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = d.toLocaleDateString('en-US', { timeZone: ET, month: '2-digit', day: '2-digit' });
  const today = new Date(nowMs).toLocaleDateString('en-US', { timeZone: ET, month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return day === today ? time : `${day} ${time}`;
}

function HeldChip() {
  return (
    <span
      style={{
        border: '1px solid var(--term-cyan)',
        color: 'var(--term-cyan)',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.5px',
        padding: '0 4px',
        marginLeft: 6,
        borderRadius: 2,
        verticalAlign: 'middle',
      }}
    >
      HELD
    </span>
  );
}

function HaltTable({ rows, dim, nowMs, onOpen }) {
  const color = dim ? 'var(--term-fg-muted)' : 'var(--term-negative)';
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
  return (
    <table className="term-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Exch</th>
          <th>Halted</th>
          <th>Reason</th>
          <th>{dim ? 'Resumed' : 'Resumes'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr
            key={`${h.symbol}-${h.haltedAt}`}
            className="term-row-link"
            role="button"
            tabIndex={0}
            style={{ color }}
            onClick={() => onOpen?.({ ticker: h.symbol, fn: 'DES' })}
            onKeyDown={rowKey(() => onOpen?.({ ticker: h.symbol, fn: 'DES' }))}
            title={h.name ? `${h.name} — open DES` : `Open ${h.symbol} DES`}
          >
            <td className="sym" style={{ color, whiteSpace: 'nowrap' }}>
              {h.symbol}
              {h.held ? <HeldChip /> : null}
            </td>
            <td>{h.exchange || '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{fmtEt(h.haltedAt, nowMs)}</td>
            <td>
              {h.reason}
              {/* The raw code rides along dimly — the decode is ours,
                  the code is the exchange's, and anyone who knows the
                  codes reads them faster. */}
              {h.reasonCode ? (
                <span style={{ color: 'var(--term-fg-muted)' }}> [{h.reasonCode}]</span>
              ) : null}
            </td>
            <td style={{ whiteSpace: 'nowrap' }}>{fmtEt(h.resumptionAt, nowMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Halts({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchHalts = (isInitial) => {
    api
      .get('/halts')
      .then(({ data }) => {
        setData(data);
        setErr(null);
        setLastRefresh(new Date());
      })
      .catch((e) => {
        // A failed poll keeps the last good tape on screen; only the
        // very first load has nothing better to show than the error.
        if (isInitial) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (isInitial) setLoading(false);
      });
  };

  useEffect(() => {
    fetchHalts(true);
    const id = setInterval(() => {
      if (!document.hidden) fetchHalts(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading halt tape…</div>
      </div>
    );
  }
  if (err && !data) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (!data) return null;

  const nowMs = Date.now();
  const halts = data.halts || [];
  const active = halts.filter((h) => !h.resumed);
  const resolved = halts.filter((h) => h.resumed);
  const sources = data.sources || {};

  const sectionLabel = (text, color) => (
    <div
      style={{
        color,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.5px',
        margin: '8px 0 2px',
      }}
    >
      {text}
    </div>
  );

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">HALT</span>
        <span className="name">Trading Halts · Nasdaq + NYSE wires</span>
        {/* Live only when BOTH wires answered this cycle. A wire serving
            its last snapshot can show a halt that has since resumed, so
            the badge must not claim live over a stale tape. */}
        {sources.nasdaqLive !== false && sources.nyseLive !== false ? (
          <span className="term-live-badge">● LIVE</span>
        ) : (
          <span className="term-live-badge" style={{ color: 'var(--term-amber)' }}>● STALE</span>
        )}
        {lastRefresh && (
          <span className="term-refresh-ts">
            {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}
          </span>
        )}
      </div>

      {/* A wire that brought zero rows is either a very quiet day or a
          dead feed — say which wires answered so the difference is on
          screen, not discovered months later. */}
      {sources.nasdaq === 0 && sources.nyse === 0 ? (
        <div className="term-error" style={{ fontSize: 11 }}>
          Neither halt wire returned data — the tape below may be stale.
        </div>
      ) : sources.nasdaqLive === false || sources.nyseLive === false ? (
        <div className="term-error" style={{ fontSize: 11 }}>
          {sources.nasdaqLive === false ? 'Nasdaq' : 'NYSE'} wire did not answer
          {' '}({Math.round((sources.nasdaqStaleSeconds || sources.nyseStaleSeconds || 0) / 60)}m ago). Its
          halts below are from the last good pull and a resumed one may still read as active.
        </div>
      ) : null}

      {sectionLabel(`ACTIVE HALTS (${active.length})`, 'var(--term-negative)')}
      {active.length === 0 ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11, padding: '2px 0 6px' }}>
          No active halts on either wire.
        </div>
      ) : (
        <HaltTable rows={active} dim={false} nowMs={nowMs} onOpen={onOpen} />
      )}

      {sectionLabel(`RESOLVED TODAY (${resolved.length})`, 'var(--term-fg-muted)')}
      {resolved.length === 0 ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11, padding: '2px 0 6px' }}>
          Nothing has resumed yet today.
        </div>
      ) : (
        <HaltTable rows={resolved} dim nowMs={nowMs} onOpen={onOpen} />
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11, marginTop: 8 }}>
        Nasdaq wire {sources.nasdaq ?? 0} · NYSE wire {sources.nyse ?? 0} · all
        times ET · refreshes every 60s while visible · click a row for DES.
      </div>
    </div>
  );
}
