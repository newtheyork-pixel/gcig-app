import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import './asyncErrors.js';

// Without asyncErrors.js a rejected async handler is an unhandled
// rejection, which ends a Node 22 process — this test's included.
test('a rejected async handler answers 500 and the server keeps serving', async () => {
  const app = express();
  const router = express.Router();
  router.get('/boom', async () => {
    throw new Error('boom');
  });
  app.use('/r', router);
  app.get('/silent', () => Promise.reject());
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const boom = await fetch(`${base}/r/boom`, { signal: AbortSignal.timeout(5000) });
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).error, 'boom');

    const silent = await fetch(`${base}/silent`, { signal: AbortSignal.timeout(5000) });
    assert.equal(silent.status, 500, 'a rejection with no reason is still an error');

    const ok = await fetch(`${base}/ok`, { signal: AbortSignal.timeout(5000) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('synchronous throws and ordinary handlers behave as before', async () => {
  const app = express();
  app.get('/throw', () => {
    throw new Error('sync');
  });
  app.get('/next', (_req, _res, next) => next());
  app.get('/next', (_req, res) => res.send('second'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).send(err.message));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const thrown = await fetch(`${base}/throw`, { signal: AbortSignal.timeout(5000) });
    assert.equal(thrown.status, 500);
    assert.equal(await thrown.text(), 'sync');
    const chained = await fetch(`${base}/next`, { signal: AbortSignal.timeout(5000) });
    assert.equal(await chained.text(), 'second');
  } finally {
    server.close();
  }
});
