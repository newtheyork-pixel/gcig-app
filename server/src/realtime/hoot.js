import { WebSocketServer } from 'ws';
import { authenticateToken, hasTerminalAccess } from '../middleware/auth.js';

// The desk squawk box ("hoot"). One club-wide channel: a member holds a
// button, their microphone streams to us, and we fan it out live to
// everyone else on the channel. It is routed THROUGH the server rather
// than peer-to-peer on purpose — everyone already holds one authenticated
// socket to us, so there is no NAT to punch, no STUN/TURN to run, and no
// third-party audio stack on the native client. The cost is our
// bandwidth, which is fine because push-to-talk means one voice at a time.
//
// Wire format: audio is raw 16 kHz mono little-endian Int16 PCM in BINARY
// frames; everything else (who is here, who is keyed up) is JSON TEXT
// frames. Outgoing audio is prefixed with the speaker's id (4-byte BE
// uint32) so listeners can label and mix it.
//
// A member may hold several connections at once (web terminal + native
// app, or two tabs) — presence is deduped to one entry per person, and a
// member's own voice is never echoed back to any of their own devices.
//
// Single-instance assumption: the roster lives in memory, so this is
// correct only while the API runs on one dyno. If it is ever scaled out,
// the fan-out needs a shared bus (Redis pub/sub) — until then, do not.

const MAX_FRAME = 64 * 1024; // a keyed PCM frame is ~20-40ms; cap the rest as abuse

export function attachHoot(server) {
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Map(); // connId -> { ws, user, talking, alive }
  let nextConnId = 1;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    // This is the only WebSocket surface; anything else is a mistake.
    if (url.pathname !== '/ws/hoot') return socket.destroy();

    // Browsers cannot set an Authorization header on a WebSocket, so the
    // JWT rides in the query string. Same secret + tokenVersion check as
    // every HTTP route, and the same terminal-access gate.
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

  // One roster entry per PERSON, not per connection; a member counts as
  // talking if any of their devices is keyed up.
  function roster() {
    const byMember = new Map();
    for (const p of peers.values()) {
      const cur = byMember.get(p.user.id);
      if (cur) cur.talking = cur.talking || p.talking;
      else byMember.set(p.user.id, { id: p.user.id, name: p.user.name, talking: p.talking });
    }
    return [...byMember.values()];
  }
  const memberTalking = (memberId) => {
    for (const p of peers.values()) if (p.user.id === memberId && p.talking) return true;
    return false;
  };

  function broadcastText(obj) {
    const s = JSON.stringify(obj);
    for (const p of peers.values()) {
      if (p.ws.readyState === p.ws.OPEN) {
        try {
          p.ws.send(s);
        } catch {
          /* a dead socket is reaped by the heartbeat */
        }
      }
    }
  }
  const sendPresence = () => broadcastText({ t: 'presence', members: roster() });

  wss.on('connection', (ws, user) => {
    const connId = nextConnId++;
    const me = { ws, user, talking: false, alive: true };
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
        // Audio only flows while this connection is actually keyed up, so
        // no one can hold the channel open silently.
        if (!me.talking || data.length > MAX_FRAME) return;
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(user.id >>> 0, 0);
        const frame = Buffer.concat([header, data]);
        for (const p of peers.values()) {
          if (p.user.id === user.id) continue; // never back to the speaker's own devices
          if (p.ws.readyState === p.ws.OPEN) {
            try {
              p.ws.send(frame, { binary: true });
            } catch {
              /* reaped by heartbeat */
            }
          }
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'ptt') {
        const on = !!msg.on;
        if (me.talking !== on) {
          const was = memberTalking(user.id);
          me.talking = on;
          const now = memberTalking(user.id);
          // Only announce a change at the PERSON level, so a second device
          // toggling doesn't flap the light while they're still talking.
          if (was !== now) broadcastText({ t: 'ptt', id: user.id, name: user.name, on: now });
        }
      }
    });

    const drop = () => {
      if (peers.delete(connId)) sendPresence();
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  // Heartbeat: a socket that stops answering pings is gone (a closed
  // laptop leaves no FIN), so reap it or it lingers on the roster forever.
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
