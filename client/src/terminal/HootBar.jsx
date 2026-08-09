import { useEffect, useRef, useState } from 'react';

// The desk squawk box, always on while the terminal is open. Hold the
// button (or spacebar) and your voice goes out live to everyone else on
// the desk; let go and you are listening again. Audio rides our own
// WebSocket to the server, which fans it out — no calls, no accounts, no
// peer-to-peer.
//
// Wire format matches server/src/realtime/hoot.js: 16 kHz mono Int16 PCM
// in binary frames; presence and keyed-up state in JSON. Incoming audio
// is prefixed with a 4-byte big-endian speaker id.

const RATE = 16000;

function hootUrl() {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  const token = localStorage.getItem('gcig_token') || '';
  const base = apiBase
    ? apiBase.replace(/^http/, 'ws')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${base}/ws/hoot?token=${encodeURIComponent(token)}`;
}

// Linear resample an arbitrary-rate mono Float32 buffer down to 16 kHz.
function resampleTo16k(input, inRate) {
  if (inRate === RATE) return input;
  const ratio = inRate / RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000;
  return out;
}

export default function HootBar() {
  const [status, setStatus] = useState('connecting'); // connecting | on | off
  const [members, setMembers] = useState([]); // [{id,name,talking}]
  const [talking, setTalking] = useState(false); // am I keyed up
  const [micDenied, setMicDenied] = useState(false);
  const selfIdRef = useRef(null);

  const wsRef = useRef(null);
  const talkingRef = useRef(false);
  // Capture
  const micCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const procRef = useRef(null);
  // Playback
  const playCtxRef = useRef(null);
  const nextTimeRef = useRef(0);

  // ---- connection ----
  useEffect(() => {
    let closed = false;
    let retry;

    const connect = () => {
      if (closed) return;
      let ws;
      try {
        ws = new WebSocket(hootUrl());
      } catch {
        setStatus('off');
        retry = setTimeout(connect, 3000);
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => setStatus('on');
      ws.onclose = () => {
        setStatus('off');
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* onclose handles retry */
        }
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          playFrame(e.data);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          selfIdRef.current = msg.self?.id ?? null;
          setMembers(msg.members || []);
        } else if (msg.t === 'presence') {
          setMembers(msg.members || []);
        } else if (msg.t === 'ptt') {
          setMembers((prev) =>
            prev.map((m) => (m.id === msg.id ? { ...m, talking: msg.on } : m))
          );
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      stopCapture();
      try {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        micCtxRef.current?.close();
        playCtxRef.current?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- playback ----
  function playFrame(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength <= 4) return;
    let ctx = playCtxRef.current;
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      playCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const pcm = new Int16Array(buf, 4);
    const f32 = int16ToFloat(pcm);
    const ab = ctx.createBuffer(1, f32.length, RATE);
    ab.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    // Small jitter buffer: schedule just ahead of the clock, and resync if
    // we ever drift more than a beat behind or ahead.
    const now = ctx.currentTime;
    let t = nextTimeRef.current;
    if (t < now + 0.02 || t > now + 0.5) t = now + 0.08;
    src.start(t);
    nextTimeRef.current = t + ab.duration;
  }

  // ---- capture ----
  async function ensureMic() {
    if (micStreamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      micCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but universally supported and needs
      // no separate worklet file to ship. 2048 frames keeps latency low.
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (ev) => {
        if (!talkingRef.current) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const input = ev.inputBuffer.getChannelData(0);
        const rs = resampleTo16k(input, ctx.sampleRate);
        ws.send(floatToInt16(rs).buffer);
      };
      source.connect(proc);
      // A muted sink keeps the processor pulling without echoing to speakers.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      proc.connect(sink);
      sink.connect(ctx.destination);
      procRef.current = proc;
      setMicDenied(false);
      return true;
    } catch {
      setMicDenied(true);
      return false;
    }
  }

  function stopCapture() {
    try {
      procRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    procRef.current = null;
  }

  // ---- push to talk ----
  async function keyDown() {
    if (talkingRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const ok = await ensureMic();
    if (!ok) return;
    if (micCtxRef.current?.state === 'suspended') micCtxRef.current.resume().catch(() => {});
    talkingRef.current = true;
    setTalking(true);
    try {
      ws.send(JSON.stringify({ t: 'ptt', on: true }));
    } catch {
      /* ignore */
    }
  }

  function keyUp() {
    if (!talkingRef.current) return;
    talkingRef.current = false;
    setTalking(false);
    const ws = wsRef.current;
    try {
      ws?.send(JSON.stringify({ t: 'ptt', on: false }));
    } catch {
      /* ignore */
    }
  }

  // Spacebar as the hold key, unless the user is typing somewhere.
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
      keyDown();
    };
    const up = (e) => {
      if (e.code !== 'Space' || typing()) return;
      e.preventDefault();
      keyUp();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const others = members.filter((m) => m.id !== selfIdRef.current);
  const liveNames = members.filter((m) => m.talking).map((m) => m.name);
  const dot = status === 'on' ? 'var(--term-positive)' : status === 'off' ? 'var(--term-negative)' : 'var(--term-amber)';

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
        onMouseDown={keyDown}
        onMouseUp={keyUp}
        onMouseLeave={keyUp}
        onTouchStart={(e) => {
          e.preventDefault();
          keyDown();
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          keyUp();
        }}
        disabled={status !== 'on'}
        title="Hold to talk (or hold the spacebar)"
        style={{
          border: `1px solid ${talking ? 'var(--term-negative)' : 'var(--term-border)'}`,
          background: talking ? 'var(--term-negative)' : 'transparent',
          color: talking ? '#fff' : 'var(--term-fg)',
          padding: '3px 12px',
          borderRadius: 4,
          cursor: status === 'on' ? 'pointer' : 'not-allowed',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {talking ? '● LIVE' : 'HOLD TO TALK'}
      </button>

      {/* Who's on the desk, and who is speaking right now. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}>
        {status !== 'on' ? (
          <span style={{ color: 'var(--term-fg-dim)' }}>
            {status === 'connecting' ? 'joining the desk…' : 'reconnecting…'}
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

      {micDenied ? (
        <span style={{ color: 'var(--term-negative)', marginLeft: 'auto' }}>
          mic blocked — allow the microphone to talk
        </span>
      ) : null}
    </div>
  );
}
