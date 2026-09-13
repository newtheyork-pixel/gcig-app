import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { attachHoot } from './hoot.js';

const root = path.join(import.meta.dirname, '..', '..', '..');

test('HOOT parses as a function, not a ticker', () => {
  const registry = fs.readFileSync(
    path.join(root, 'client', 'src', 'terminal', 'registry.js'),
    'utf8'
  );
  const ids = new Set();
  for (const m of registry.matchAll(/\bid:\s*'([A-Z0-9]+)'/g)) ids.add(m[1]);
  for (const m of registry.matchAll(/aliases:\s*\[([^\]]+)\]/g)) {
    for (const a of m[1].matchAll(/'([A-Z0-9]+)'/g)) ids.add(a[1]);
  }
  function parse(input) {
    const cleaned = String(input || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
    if (!cleaned) return null;
    const parts = cleaned.split(' ');
    if (parts.length === 1) {
      const tok = parts[0];
      if (ids.has(tok)) return { ticker: null, function: tok };
      if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(tok)) {
        return { ticker: tok, function: 'DES' };
      }
      return null;
    }
    return null;
  }
  assert.deepEqual(parse('HOOT'), { ticker: null, function: 'HOOT' });
  assert.deepEqual(parse('squawk'), { ticker: null, function: 'SQUAWK' });
  assert.deepEqual(parse('desk'), { ticker: null, function: 'DESK' });
  assert.deepEqual(parse('ZZZZ'), { ticker: 'ZZZZ', function: 'DES' });
});

test('vite proxies /ws so local HOOT reaches the API', () => {
  const vite = fs.readFileSync(
    path.join(root, 'client', 'vite.config.js'),
    'utf8'
  );
  assert.match(vite, /['"]\/ws['"]/);
  assert.match(vite, /ws:\s*true/);
});

test('hoot websocket server disables permessage-deflate', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, 'hoot.js'),
    'utf8'
  );
  assert.match(src, /perMessageDeflate:\s*false/);
});

test('production CSP allows the hoot websocket and the microphone', () => {
  const yaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(yaml, /wss:\/\/gcig-api\.onrender\.com/);
  assert.match(yaml, /microphone=\(self\)/);
});

test('server mnemonic list answers to SQUAWK and DESK', () => {
  const src = fs.readFileSync(
    path.join(root, 'server', 'src', 'routes', 'terminal.js'),
    'utf8'
  );
  const block = src.slice(
    src.indexOf('const KNOWN_FUNCTIONS'),
    src.indexOf("router.get('/functions'")
  );
  const ids = new Set([...block.matchAll(/\{\s*id:\s*'([A-Z0-9]+)'/g)].map((m) => m[1]));
  assert.ok(ids.has('HOOT'));
  assert.ok(ids.has('SQUAWK'));
  assert.ok(ids.has('DESK'));
});

function analyst(id, name) {
  return { id, name, role: 'Analyst', extraRoles: [], isGuest: false };
}

async function withDesk(fn) {
  const server = http.createServer();
  const users = {
    alice: analyst(10, 'Alice'),
    bob: analyst(11, 'Bob'),
    carol: analyst(12, 'Carol'),
    guest: { id: 13, name: 'Guest', role: 'Analyst', extraRoles: [], isGuest: true },
    junior: { id: 14, name: 'Junior', role: 'JuniorAnalyst', extraRoles: [], isGuest: false },
  };
  const wss = attachHoot(server, {
    authenticateToken: async (token) => users[token] ?? null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn({ port });
  } finally {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    wss.close();
    await new Promise((r) => server.close(r));
  }
}

function waitUntil(pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('wait timed out'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function openPeer(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/hoot?token=${encodeURIComponent(token)}`);
    const texts = [];
    const bins = [];
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`open ${token} timed out`));
    }, 4000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) bins.push(Buffer.from(data));
      else texts.push(JSON.parse(String(data)));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    const settle = () => {
      const welcome = texts.find((m) => m.t === 'welcome');
      if (welcome) {
        clearTimeout(timer);
        resolve({ ws, texts, bins, welcome });
        return;
      }
      setTimeout(settle, 15);
    };
    ws.once('open', settle);
  });
}

function rejectPeer(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/hoot?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`expected ${token} to be refused`));
    }, 4000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`${token} was admitted`));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

test('a missing or unknown token is refused', async () => {
  await withDesk(async ({ port }) => {
    const status = await rejectPeer(port, 'nope');
    if (typeof status === 'number') assert.equal(status, 401);
  });
});

test('guests and juniors do not join the desk', async () => {
  await withDesk(async ({ port }) => {
    const guest = await rejectPeer(port, 'guest');
    const junior = await rejectPeer(port, 'junior');
    if (typeof guest === 'number') assert.equal(guest, 401);
    if (typeof junior === 'number') assert.equal(junior, 401);
  });
});

test('two analysts see each other and the desk relays keyed PCM', async () => {
  await withDesk(async ({ port }) => {
    const alice = await openPeer(port, 'alice');
    const bob = await openPeer(port, 'bob');
    await waitUntil(() =>
      alice.texts.some((m) => m.t === 'presence' && m.members.length === 2)
    );
    await waitUntil(() =>
      bob.texts.some((m) => m.t === 'presence' && m.members.length === 2)
    );

    const aliceId = alice.welcome.self.id;
    const bobId = bob.welcome.self.id;
    assert.notEqual(aliceId, bobId);
    assert.equal(alice.welcome.self.name, 'Alice');
    assert.ok(bob.welcome.members.some((m) => m.id === aliceId && m.name === 'Alice'));

    alice.ws.send(JSON.stringify({ t: 'ptt', on: true }));
    await waitUntil(() =>
      bob.texts.some((m) => m.t === 'ptt' && m.id === aliceId && m.on === true)
    );

    const pcm = Buffer.alloc(320);
    pcm.writeInt16LE(1234, 0);
    alice.ws.send(pcm);
    await waitUntil(() => bob.bins.length > 0);
    assert.equal(bob.bins[0].readUInt32BE(0), aliceId);
    assert.equal(alice.bins.length, 0);
    assert.equal(bob.bins[0].subarray(4).readInt16LE(0), 1234);

    alice.ws.close();
    bob.ws.close();
  });
});

test('JSON that arrives as a binary frame still keys the mic', async () => {
  await withDesk(async ({ port }) => {
    const alice = await openPeer(port, 'alice');
    const bob = await openPeer(port, 'bob');
    alice.ws.send(Buffer.from(JSON.stringify({ t: 'ptt', on: true })));
    await waitUntil(() =>
      bob.texts.some((m) => m.t === 'ptt' && m.id === alice.welcome.self.id && m.on === true)
    );
    alice.ws.close();
    bob.ws.close();
  });
});

test('a direct line reaches only the named connection', async () => {
  await withDesk(async ({ port }) => {
    const alice = await openPeer(port, 'alice');
    const bob = await openPeer(port, 'bob');
    const carol = await openPeer(port, 'carol');
    await waitUntil(() =>
      alice.texts.some((m) => m.t === 'presence' && m.members.length === 3)
    );

    alice.ws.send(JSON.stringify({ t: 'target', to: bob.welcome.self.id }));
    alice.ws.send(JSON.stringify({ t: 'ptt', on: true }));
    await waitUntil(() =>
      bob.texts.some((m) => m.t === 'ptt' && m.id === alice.welcome.self.id)
    );

    const pcm = Buffer.alloc(64);
    pcm.writeInt16LE(99, 0);
    alice.ws.send(pcm);
    await waitUntil(() => bob.bins.length > 0);
    assert.equal(bob.bins[0].readUInt32BE(0), alice.welcome.self.id);
    assert.equal(carol.bins.length, 0);

    alice.ws.close();
    bob.ws.close();
    carol.ws.close();
  });
});

test('a stale or self target is ignored', async () => {
  await withDesk(async ({ port }) => {
    const alice = await openPeer(port, 'alice');
    const bob = await openPeer(port, 'bob');
    await waitUntil(() =>
      alice.texts.some((m) => m.t === 'presence' && m.members.length === 2)
    );
    const before = alice.texts.length;
    alice.ws.send(JSON.stringify({ t: 'target', to: 999 }));
    await waitUntil(() => alice.texts.length > before);
    const last = [...alice.texts].reverse().find((m) => m.t === 'presence');
    const me = last.members.find((m) => m.id === alice.welcome.self.id);
    assert.equal(me.target, null);

    alice.ws.send(JSON.stringify({ t: 'target', to: alice.welcome.self.id }));
    await waitUntil(() =>
      alice.texts.filter((m) => m.t === 'presence').length >
        alice.texts.slice(0, before + 1).filter((m) => m.t === 'presence').length
    );
    const afterSelf = [...alice.texts].reverse().find((m) => m.t === 'presence');
    const me2 = afterSelf.members.find((m) => m.id === alice.welcome.self.id);
    assert.equal(me2.target, null);

    alice.ws.close();
    bob.ws.close();
  });
});
