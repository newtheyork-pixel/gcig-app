import { useEffect, useState } from 'react';
import {
  startHoot,
  subscribeHoot,
  setHootTarget,
  toggleHootMute,
  pressToTalk,
  releaseToTalk,
} from '../hootClient.js';

// HOOT — the desk squawk box as a function, matching the Mac panel.
// Presence itself is started by the always-on bar; this is who is on
// the desk, which line you are on, and hold-to-talk aimed at them.

function idleLabel(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 30) return 'active';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m idle`;
  return `${Math.floor(m / 60)}h idle`;
}

function firstName(name) {
  return String(name || '').split(' ')[0] || name;
}

export default function Hoot() {
  const [s, setS] = useState(null);
  useEffect(() => {
    startHoot();
    const unsub = subscribeHoot(setS);
    return () => {
      releaseToTalk();
      unsub();
    };
  }, []);

  if (!s) return <div className="term-panel">joining the desk…</div>;

  const others = s.members.filter((m) => m.id !== s.selfId);
  const callingMe = others.filter((m) => m.target === s.selfId);
  const targetName =
    s.target != null
      ? firstName(s.members.find((m) => m.id === s.target)?.name) || 'line'
      : 'Trade Desk';
  const dot =
    s.status === 'on'
      ? 'var(--term-positive)'
      : s.status === 'off'
        ? 'var(--term-negative)'
        : 'var(--term-amber)';
  const statusLabel =
    s.status === 'on'
      ? `${others.length + 1} on the desk`
      : s.status === 'connecting'
        ? 'joining…'
        : 'offline';

  return (
    <div className="term-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="term-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dot,
            flexShrink: 0,
          }}
        />
        <span className="ticker">TRADE DESK</span>
        <span style={{ marginLeft: 'auto', color: 'var(--term-fg-muted)', fontSize: 11 }}>
          {statusLabel}
        </span>
      </div>

      {callingMe.length ? (
        <div style={{ color: 'var(--term-positive)', fontSize: 11, padding: '0 12px 8px' }}>
          {callingMe.map((m) => m.name).join(', ')} on your line
        </div>
      ) : null}

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Row
          selected={s.target == null}
          onClick={() => setHootTarget(null)}
        >
          <span>Trade Desk</span>
          <span style={{ marginLeft: 'auto', color: 'var(--term-fg-dim)', fontSize: 11 }}>
            everyone
          </span>
        </Row>
        {others.map((m) => {
          const selected = s.target === m.id;
          return (
            <Row
              key={m.id}
              selected={selected}
              onClick={() => setHootTarget(selected ? null : m.id)}
            >
              <span style={{ color: m.talking ? 'var(--term-positive)' : 'var(--term-fg-muted)' }}>
                {m.talking ? '◉' : '○'}
              </span>
              <span style={{ fontWeight: m.talking ? 700 : 400 }}>{m.name}</span>
              {s.selfName && m.name === s.selfName ? (
                <span style={{ color: 'var(--term-cyan)', fontSize: 11 }}>· your other device</span>
              ) : null}
              {m.target === s.selfId ? (
                <span style={{ color: 'var(--term-positive)', fontSize: 11 }}>→ you</span>
              ) : null}
              <span style={{ marginLeft: 'auto', color: 'var(--term-fg-muted)', fontSize: 11 }}>
                {idleLabel(m.idleMs)}
              </span>
            </Row>
          );
        })}
        {others.length === 0 ? (
          <div style={{ color: 'var(--term-fg-dim)', fontSize: 11, padding: 12 }}>
            nobody else on the terminal right now
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 12,
          borderTop: '1px solid var(--term-border)',
        }}
      >
        <button
          type="button"
          disabled={s.status !== 'on' || s.muted}
          onMouseDown={pressToTalk}
          onMouseUp={releaseToTalk}
          onMouseLeave={releaseToTalk}
          onTouchStart={(e) => {
            e.preventDefault();
            pressToTalk();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            releaseToTalk();
          }}
          style={{
            flex: 1,
            border: `1px solid ${s.talking ? 'var(--term-negative)' : 'var(--term-border)'}`,
            background: s.talking ? 'var(--term-negative)' : 'transparent',
            color: s.talking ? '#fff' : s.muted ? 'var(--term-fg-muted)' : 'var(--term-fg)',
            padding: '8px 12px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            cursor: s.status === 'on' && !s.muted ? 'pointer' : 'not-allowed',
            opacity: s.muted ? 0.5 : 1,
          }}
        >
          {s.talking ? `● LIVE · ${targetName}` : `HOLD TO TALK · ${targetName}`}
        </button>
        <button
          type="button"
          onClick={toggleHootMute}
          title={s.muted ? 'Unmute' : 'Mute your mic'}
          style={{
            width: 48,
            border: '1px solid var(--term-border)',
            background: 'transparent',
            color: s.muted ? 'var(--term-negative)' : 'var(--term-fg)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          {s.muted ? 'MUTE' : 'MIC'}
        </button>
      </div>
      {s.micDenied ? (
        <div style={{ color: 'var(--term-negative)', fontSize: 11, padding: '0 12px 10px' }}>
          mic blocked — allow the microphone to talk
        </div>
      ) : null}
    </div>
  );
}

function Row({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        background: selected ? 'var(--term-bg-panel-hover)' : 'transparent',
        border: 0,
        color: 'var(--term-fg)',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <span style={{ color: selected ? 'var(--term-positive)' : 'var(--term-fg-muted)' }}>
        {selected ? '◉' : '○'}
      </span>
      {children}
    </button>
  );
}
