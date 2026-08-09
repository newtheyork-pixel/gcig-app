import { WebSocketServer } from 'ws';
import { authenticateToken, hasTerminalAccess } from '../middleware/auth.js';

// The desk squawk box. Presence for the whole terminal plus push-to-talk
// voice, relayed through the server (no peer-to-peer, no NAT, no third-
// party audio stack on the native client). Two ways to be heard:
//
//   - the shared "Trade Desk": your keyed audio reaches everyone present;
//   - a direct line to one person: your keyed audio reaches only them.
//
// A direct line opens without the other person's say-so — this is a
// turret intercom, not a phone call — but it is push-to-talk, so nothing
// is heard until someone holds the button, and presence shows everyone
// whose line they are on.
//
// Wire format: audio is 16 kHz mono little-endian Int16 PCM in BINARY
// frames prefixed with the speaker's 4-byte big-endian id; presence,
// keyed-up, mute, target and activity are JSON TEXT frames. A member may
// hold several connections (web + native); presence is deduped to one
// entry per person and a member never hears their own voice.
//
// Single-instance assumption: the roster lives in memory, correct only
// while the API runs on one dyno. Scaling out needs a shared bus.

const MAX_FRAME = 64 * 1024; // a keyed PCM frame is ~20-40ms; cap the rest

export function attachHoot(server) {
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Map(); // connId -> { ws, user, talking, muted, target, lastActive, alive }
  let nextConnId = 1;
  const now = () => Date.now();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/ws/hoot') return socket.destroy();
    authenticateToken(url.searchParams.get('token'))
      .then((user) => {
        if (!user || !hasTerminalAccess(user)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user));
      })
      .catch(() => socket.destroy());
  });

  // One roster entry per person. talking is OR across their devices; a
  // member counts as muted only if every device is muted; target and
  // last-active take the most recent. idleMs is stamped at send time and
  // the client ticks it forward locally between broadcasts.
  function roster() {
    const t = now();
    const byMember = new Map();
    for (const p of peers.values()) {
      const cur = byMember.get(p.user.id);
      if (cur) {
        cur.talking = cur.talking || p.talking;
        cur.muted = cur.muted && p.muted;
        cur.target = p.target ?? cur.target;
        cur._active = Math.max(cur._active, p.lastActive);
      } else {
        byMember.set(p.user.id, {
          id: p.user.id,
          name: p.user.name,
          talking: p.talking,
          muted: p.muted,
          target: p.target ?? null,
          _active: p.lastActive,
        });
      }
    }
    return [...byMember.values()].map((m) => ({
      id: m.id,
      name: m.name,
      talking: m.talking,
      muted: m.muted,
      target: m.target,
      idleMs: Math.max(0, t - m._active),
    }));
  }
  const memberTalking = (id) => {
    for (const p of peers.values()) if (p.user.id === id && p.talking) return true;
    return false;
  };

  function broadcastText(obj) {
    const s = JSON.stringify(obj);
    for (const p of peers.values()) {
      if (p.ws.readyState === p.ws.OPEN) {
        try {
          p.ws.send(s);
        } catch {
          /* reaped by heartbeat */
        }
      }
    }
  }
  const sendPresence = () => broadcastText({ t: 'presence', members: roster() });

  function sendToMember(memberId, frame) {
    for (const p of peers.values()) {
      if (p.user.id !== memberId) continue;
      if (p.ws.readyState === p.ws.OPEN) {
        try {
          p.ws.send(frame, { binary: true });
        } catch {
          /* reaped by heartbeat */
        }
      }
    }
  }

  wss.on('connection', (ws, user) => {
    const connId = nextConnId++;
    const me = {
      ws,
      user,
      talking: false,
      muted: false,
      target: null, // null = Trade Desk; a member id = direct line
      lastActive: now(),
      alive: true,
    };
    peers.set(connId, me);

    try {
      ws.send(JSON.stringify({ t: 'welcome', self: { id: user.id, name: user.name }, members: roster() }));
    } catch {
      /* ignore */
    }
    sendPresence();

    ws.on('pong', () => {
      me.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Audio flows only while keyed up and not muted.
        if (me.muted || !me.talking || data.length > MAX_FRAME) return;
        me.lastActive = now();
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(user.id >>> 0, 0);
        const frame = Buffer.concat([header, data]);
        if (me.target == null) {
          for (const p of peers.values()) {
            if (p.user.id === user.id) continue; // never back to the speaker
            if (p.ws.readyState === p.ws.OPEN) {
              try {
                p.ws.send(frame, { binary: true });
              } catch {
                /* reaped */
              }
            }
          }
        } else {
          sendToMember(me.target, frame);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      me.lastActive = now();
      switch (msg.t) {
        case 'ptt': {
          const on = !!msg.on;
          if (me.talking !== on) {
            const was = memberTalking(user.id);
            me.talking = on;
            const nowTalking = memberTalking(user.id);
            if (was !== nowTalking) {
              broadcastText({ t: 'ptt', id: user.id, name: user.name, on: nowTalking, target: me.target ?? null });
            }
          }
          break;
        }
        case 'mute':
          me.muted = !!msg.on;
          sendPresence();
          break;
        case 'target': {
          const to = msg.to;
          if (to === 'desk' || to == null) me.target = null;
          else {
            const id = Number(to);
            me.target = Number.isFinite(id) ? id : null;
          }
          sendPresence();
          break;
        }
        case 'active':
          sendPresence();
          break;
        default:
          break;
      }
    });

    const drop = () => {
      if (peers.delete(connId)) sendPresence();
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  // Heartbeat: reap sockets that stop answering pings (a closed laptop
  // leaves no FIN) so they do not linger on the roster.
  const heartbeat = setInterval(() => {
    let reaped = false;
    for (const [id, p] of peers) {
      if (!p.alive) {
        try {
          p.ws.terminate();
        } catch {
          /* ignore */
        }
        peers.delete(id);
        reaped = true;
        continue;
      }
      p.alive = false;
      try {
        p.ws.ping();
      } catch {
        /* ignore */
      }
    }
    if (reaped) sendPresence();
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
