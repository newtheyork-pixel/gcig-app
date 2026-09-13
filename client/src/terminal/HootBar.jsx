import { useEffect, useState } from 'react';
import {
  startHoot,
  stopHoot,
  subscribeHoot,
  pressToTalk,
  releaseToTalk,
} from './hootClient.js';

// The desk strip. Presence runs for the whole terminal session; the
// HOOT command opens the full panel. Both share one socket — two would
// show up as two people in this tab.

export default function HootBar() {
  const [s, setS] = useState(() => ({
    status: 'connecting',
    members: [],
    talking: false,
    micDenied: false,
    selfId: null,
  }));

  useEffect(() => {
    startHoot();
    const unsub = subscribeHoot(setS);
    return () => {
      unsub();
      stopHoot();
    };
  }, []);

  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    const down = (e) => {
      if (e.code !== 'Space' || e.repeat || typing()) return;
      e.preventDefault();
      pressToTalk();
    };
    const up = (e) => {
      if (e.code !== 'Space' || typing()) return;
      e.preventDefault();
      releaseToTalk();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const others = s.members.filter((m) => m.id !== s.selfId);
  const liveNames = s.members.filter((m) => m.talking).map((m) => m.name);
  const dot =
    s.status === 'on'
      ? 'var(--term-positive)'
      : s.status === 'off'
        ? 'var(--term-negative)'
        : 'var(--term-amber)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 10px',
        borderBottom: '1px solid var(--term-border)',
        background: 'var(--term-bg)',
        fontSize: 11,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--term-fg-muted)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />
        <span style={{ letterSpacing: 0.5 }}>HOOT</span>
      </span>

      <button
        type="button"
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
        disabled={s.status !== 'on'}
        title="Hold to talk (or hold the spacebar). Type HOOT for the full desk."
        style={{
          border: `1px solid ${s.talking ? 'var(--term-negative)' : 'var(--term-border)'}`,
          background: s.talking ? 'var(--term-negative)' : 'transparent',
          color: s.talking ? '#fff' : 'var(--term-fg)',
          padding: '3px 12px',
          borderRadius: 4,
          cursor: s.status === 'on' ? 'pointer' : 'not-allowed',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {s.talking ? '● LIVE' : 'HOLD TO TALK'}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}>
        {s.status !== 'on' ? (
          <span style={{ color: 'var(--term-fg-dim)' }}>
            {s.status === 'connecting' ? 'joining the desk…' : 'reconnecting…'}
          </span>
        ) : liveNames.length ? (
          <span style={{ color: 'var(--term-positive)', whiteSpace: 'nowrap' }}>
            {liveNames.join(', ')} {liveNames.length === 1 ? 'is' : 'are'} live
          </span>
        ) : (
          <span style={{ color: 'var(--term-fg-dim)', whiteSpace: 'nowrap' }}>
            {others.length ? `${others.length} on the desk` : 'you are the only one here'}
          </span>
        )}
        <span style={{ display: 'flex', gap: 6, overflow: 'hidden' }}>
          {others.map((m) => (
            <span
              key={m.id}
              title={m.name}
              style={{
                color: m.talking ? 'var(--term-positive)' : 'var(--term-fg-muted)',
                whiteSpace: 'nowrap',
                fontWeight: m.talking ? 700 : 400,
              }}
            >
              {m.talking ? '◉' : '○'} {m.name?.split(' ')[0]}
            </span>
          ))}
        </span>
      </div>

      {s.micDenied ? (
        <span style={{ color: 'var(--term-negative)', marginLeft: 'auto' }}>
          mic blocked — allow the microphone to talk
        </span>
      ) : null}
    </div>
  );
}
