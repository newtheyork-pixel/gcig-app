// One desk connection for the whole web terminal. The bar and the HOOT
// panel both read this; a second WebSocket would show up as a second
// person, which is how one account on two devices is supposed to look
// and exactly wrong for two widgets in the same tab.

const RATE = 16000;

function hootUrl() {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  const token = localStorage.getItem('gcig_token') || '';
  const base = apiBase
    ? apiBase.replace(/^http/, 'ws')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${base}/ws/hoot?token=${encodeURIComponent(token)}`;
}

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

const listeners = new Set();

const state = {
  status: 'off', // connecting | on | off
  members: [],
  talking: false,
  muted: false,
  target: null, // null = Trade Desk; adopted from the server on welcome
  micDenied: false,
  selfId: null,
  selfName: null,
};

let closed = true;
let ws = null;
let retry = null;
let talking = false;
// Held is the finger on the button. talking is "the server thinks we
// are keyed up". They are distinct because getUserMedia is async: a
// tap that releases before the prompt resolves used to miss the up
// (talking was still false) and then key the mic forever.
let held = false;
let micCtx = null;
let micStream = null;
let proc = null;
let playCtx = null;
let nextTime = 0;

function emit() {
  const snap = { ...state };
  for (const fn of listeners) fn(snap);
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* drop */
  }
}

function adoptServerTarget() {
  if (state.selfId == null) {
    state.target = null;
    return;
  }
  const me = state.members.find((m) => m.id === state.selfId);
  state.target = me?.target ?? null;
}

function resendState() {
  // Mute and keyed-up are about THIS connection. A target is a
  // per-connection id and must not be replayed after a reconnect —
  // the id can belong to someone else, and the server already cleared
  // lines aimed at a peer that has gone.
  if (state.muted) send({ t: 'mute', on: true });
  if (talking) send({ t: 'ptt', on: true });
}

function playFrame(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength <= 4) return;
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (playCtx.state === 'suspended') playCtx.resume().catch(() => {});
  const pcm = new Int16Array(buf, 4);
  const f32 = int16ToFloat(pcm);
  const ab = playCtx.createBuffer(1, f32.length, RATE);
  ab.getChannelData(0).set(f32);
  const src = playCtx.createBufferSource();
  src.buffer = ab;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  let t = nextTime;
  if (t < now + 0.02 || t > now + 0.5) t = now + 0.08;
  src.start(t);
  nextTime = t + ab.duration;
}

async function ensureMic() {
  if (micStream) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    micStream = stream;
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = micCtx.createMediaStreamSource(stream);
    proc = micCtx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (ev) => {
      if (!talking || state.muted) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const rs = resampleTo16k(input, micCtx.sampleRate);
      ws.send(floatToInt16(rs).buffer);
    };
    source.connect(proc);
    const sink = micCtx.createGain();
    sink.gain.value = 0;
    proc.connect(sink);
    sink.connect(micCtx.destination);
    state.micDenied = false;
    emit();
    return true;
  } catch {
    state.micDenied = true;
    emit();
    return false;
  }
}

function connect() {
  if (closed) return;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  let socket;
  try {
    socket = new WebSocket(hootUrl());
  } catch {
    state.status = 'off';
    emit();
    retry = setTimeout(connect, 3000);
    return;
  }
  socket.binaryType = 'arraybuffer';
  ws = socket;
  state.status = 'connecting';
  emit();

  socket.onopen = () => {
    state.status = 'on';
    emit();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    talking = false;
    held = false;
    state.talking = false;
    state.status = 'off';
    emit();
    if (!closed) retry = setTimeout(connect, 3000);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* onclose retries */
    }
  };
  socket.onmessage = (e) => {
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
      state.selfId = msg.self?.id ?? null;
      state.selfName = msg.self?.name ?? null;
      state.members = msg.members || [];
      state.status = 'on';
      adoptServerTarget();
      resendState();
      emit();
    } else if (msg.t === 'presence') {
      state.members = msg.members || [];
      adoptServerTarget();
      emit();
    } else if (msg.t === 'ptt') {
      state.members = state.members.map((m) =>
        m.id === msg.id ? { ...m, talking: msg.on } : m
      );
      emit();
    }
  };
}

export function getHootState() {
  return { ...state };
}

export function subscribeHoot(fn) {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}

export function startHoot() {
  if (!closed) return;
  closed = false;
  connect();
}

export function stopHoot() {
  closed = true;
  held = false;
  talking = false;
  state.talking = false;
  state.muted = false;
  state.target = null;
  clearTimeout(retry);
  retry = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  try {
    proc?.disconnect();
  } catch {
    /* ignore */
  }
  proc = null;
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
  try {
    micCtx?.close();
    playCtx?.close();
  } catch {
    /* ignore */
  }
  micCtx = null;
  playCtx = null;
  state.status = 'off';
  state.members = [];
  emit();
}

export function setHootTarget(memberId) {
  state.target = memberId ?? null;
  send({ t: 'target', to: memberId == null ? 'desk' : memberId });
  emit();
}

export function toggleHootMute() {
  state.muted = !state.muted;
  if (state.muted && talking) {
    talking = false;
    held = false;
    state.talking = false;
    send({ t: 'ptt', on: false });
  }
  send({ t: 'mute', on: state.muted });
  emit();
}

export async function pressToTalk() {
  if (held || state.muted) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  held = true;
  const ok = await ensureMic();
  if (!held) return;
  if (!ok) return;
  if (micCtx?.state === 'suspended') micCtx.resume().catch(() => {});
  talking = true;
  state.talking = true;
  send({ t: 'ptt', on: true });
  emit();
}

export function releaseToTalk() {
  const wasTalking = talking;
  held = false;
  talking = false;
  if (state.talking) {
    state.talking = false;
    emit();
  }
  if (wasTalking) send({ t: 'ptt', on: false });
}
