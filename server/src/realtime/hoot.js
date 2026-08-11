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
// keyed-up, mute, target and activity are JSON TEXT frames.
//
// Each CONNECTION is its own participant on the desk, keyed by a
// per-connection id rather than the account id. The same account signed
// in on two devices therefore shows as two entries and each hears the
// other — only your own connection is ever muted back to you. That is
// what makes one account usable across devices, and testing with a single
// account work at all (two logins of the same account are two
// participants, not one person talking to themselves).
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
        // The desk is club-only: a guest collaborator does not join it.
        if (!user || !hasTerminalAccess(user) || user.isGuest) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user));
      })
      .catch(() => socket.destroy());
  });

  // One roster entry per CONNECTION, keyed by connId. idleMs is stamped at
  // send time and the client ticks it forward locally between broadcasts.
  // The client hides its own entry by matching the connId it was handed in
  // `welcome`, so a second login of the same account is just another peer.
  function roster() {
    const t = now();
    return [...peers.entries()].map(([cid, p]) => ({
      id: cid,
      name: p.user.name,
      talking: p.talking,
      muted: p.muted,
      target: p.target ?? null,
      idleMs: Math.max(0, t - p.lastActive),
    }));
  }

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

  function sendToConn(connId, frame) {
    const p = peers.get(connId);
    if (p && p.ws.readyState === p.ws.OPEN) {
      try {
        p.ws.send(frame, { binary: true });
      } catch {
        /* reaped by heartbeat */
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
      target: null, // null = Trade Desk; a connId = direct line to that connection
      lastActive: now(),
      alive: true,
    };
    peers.set(connId, me);

    try {
      ws.send(JSON.stringify({ t: 'welcome', self: { id: connId, name: user.name }, members: roster() }));
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
        header.writeUInt32BE(connId >>> 0, 0);
        const frame = Buffer.concat([header, data]);
        if (me.target == null) {
          for (const [cid, p] of peers) {
            if (cid === connId) continue; // never back to the speaker's own connection
            if (p.ws.readyState === p.ws.OPEN) {
              try {
                p.ws.send(frame, { binary: true });
              } catch {
                /* reaped */
              }
            }
          }
        } else {
          sendToConn(me.target, frame);
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
            me.talking = on;
            broadcastText({ t: 'ptt', id: connId, name: user.name, on, target: me.target ?? null });
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
