import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secDocProxyHandler } from './secDocProxy.js';
import { fetchSecDoc } from '../services/secDocProxy.js';

// Mirrors the existing colocated route-test pattern (terminal.quotes,
// terminal.filings, terminal.execbios): no supertest, no server boot.
// The exported handler is driven directly with a fake req/res and an
// injected service (deps.fetchSecDoc), so this suite never touches the
// network or SEC EDGAR. Same precedent the rest of the terminal route
// suites follow.

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    removedHeaders: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    removeHeader(name) {
      this.removedHeaders.push(name);
      delete this.headers[name];
      return this;
    },
    getHeader(name) {
      return this.headers[name];
    },
  };
}

// A minimal upstream-fetch double that mirrors the shape fetch()
// returns: a headers object with .get(name), plus text() / arrayBuffer()
// promises. fetchSecDoc consumes only these properties.
function fakeUpstream({ status = 200, contentType = 'text/html; charset=utf-8', text, body } = {}) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async text() {
      return text != null ? text : '';
    },
    async arrayBuffer() {
      // Buffer instances are accepted by ArrayBuffer.isView; tests
      // pass either a Buffer or a string here.
      if (body && typeof body !== 'string') {
        // Slice into a clean ArrayBuffer so Buffer.from in the
        // service sees only the meaningful bytes.
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      }
      const s = String(body || '');
      return new TextEncoder().encode(s).buffer;
    },
  };
}

// 1. Missing url query → 400 with the documented shape, no service
// call. Matches the input-guard pattern the sibling /filings/:ticker
// route uses for malformed input.
test('GET /sec-doc-proxy: 400 when url is missing, no service call', async () => {
  const res = fakeRes();
  let called = false;
  await secDocProxyHandler(
    { query: {} },
    res,
    {
      fetchSecDoc: async () => {
        called = true;
        return null;
      },
    }
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'url required' });
  assert.equal(called, false, 'service must not be called when url is missing');
});

// 2. An off-allowlist URL bottoms out at the service (the real
// fetchSecDoc returns null for anything that isn't (www|data).sec.gov)
// and the handler maps that to 400. Driven against the real service so
// the allowlist regression is caught here too — a future widening of
// the allowlist would have to update both this assertion and the
// service.
test('GET /sec-doc-proxy: 400 when url is off the SEC allowlist (real service)', async () => {
  const res = fakeRes();
  await secDocProxyHandler(
    { query: { url: 'https://example.com/notsec.html' } },
    res,
    { fetchSecDoc }
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid or unfetchable url' });
});

// 3. The happy path: an allowed SEC URL → 200, the framing-refusal
// X-Frame-Options header is stripped, and the Content-Security-Policy
// frame-ancestors directive lists 'self' plus every CLIENT_ORIGIN env
// entry. The env is set inside the test and restored after — the
// handler re-parses CLIENT_ORIGIN per request so the test sees its
// updates without a service restart.
test('GET /sec-doc-proxy: 200 on allowed URL with X-Frame-Options removed and CSP frame-ancestors including CLIENT_ORIGIN', async () => {
  const prev = process.env.CLIENT_ORIGIN;
  process.env.CLIENT_ORIGIN = 'https://thegriffinfund.org,https://gcig-client.onrender.com';
  try {
    const res = fakeRes();
    await secDocProxyHandler(
      { query: { url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/a8k.htm' } },
      res,
      {
        fetchSecDoc: async () => ({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<html><head><base href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/"></head><body>hi</body></html>',
        }),
      }
    );
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.removedHeaders.includes('X-Frame-Options'),
      'X-Frame-Options must be explicitly removed before the response is sent'
    );
    assert.equal(res.headers['X-Frame-Options'], undefined, 'X-Frame-Options must not be present in the response headers');
    const csp = res.headers['Content-Security-Policy'];
    assert.ok(csp, 'Content-Security-Policy must be set');
    assert.match(csp, /frame-ancestors/);
    assert.match(csp, /'self'/);
    assert.match(csp, /https:\/\/thegriffinfund\.org/);
    assert.match(csp, /https:\/\/gcig-client\.onrender\.com/);
    assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['Cache-Control'], 'public, max-age=300');
  } finally {
    if (prev === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = prev;
  }
});

// 4. The HTML body returned by fetchSecDoc carries the injected
// <base href> tag. Driven against the REAL service with an injected
// docFetch double so the injection logic in secDocProxy.js itself is
// covered end-to-end (the route handler trusts whatever bytes the
// service produced — the injection has to happen down there or it
// never happens).
test('GET /sec-doc-proxy: HTML response includes <base href> pointing at the URL directory', async () => {
  const res = fakeRes();
  const url = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/a8k.htm';
  await secDocProxyHandler(
    { query: { url } },
    res,
    {
      fetchSecDoc: (u) =>
        fetchSecDoc(u, {
          docFetch: async () =>
            fakeUpstream({
              contentType: 'text/html; charset=utf-8',
              text: '<html><head><title>x</title></head><body><img src="exhibit1.jpg"></body></html>',
            }),
        }),
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body, 'string', 'HTML body should be a string');
  assert.match(
    res.body,
    /<base href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019326000050\/">/,
    'a <base href> pointing at the URL directory must be injected so relative SEC asset paths still resolve back to sec.gov'
  );
  // The base tag must land inside <head>, before the existing <title>.
  assert.match(res.body, /<head><base href="[^"]+"><title>x<\/title><\/head>/);
});

// 5. Non-HTML (PDF) flows through as a Buffer with byte-identity —
// the proxy never rewrites a binary stream. Verified end-to-end
// against the real service so the type-switch and the arrayBuffer
// path are both exercised.
test('GET /sec-doc-proxy: non-HTML (PDF) body passes through byte-identical', async () => {
  const res = fakeRes();
  const url = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/exhibit99.pdf';
  const pdfBytes = Buffer.from('%PDF-1.4\n%binary\n', 'utf8');
  await secDocProxyHandler(
    { query: { url } },
    res,
    {
      fetchSecDoc: (u) =>
        fetchSecDoc(u, {
          docFetch: async () =>
            fakeUpstream({
              contentType: 'application/pdf',
              body: pdfBytes,
            }),
        }),
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(res.body), 'PDF body must be returned as a Buffer (no string coercion)');
  assert.equal(
    Buffer.compare(res.body, pdfBytes),
    0,
    'binary body must be byte-identical to what the upstream returned'
  );
});

// 6. Upstream fetch failure (the injected docFetch throws) is caught
// inside the service and returns null; the route maps null to a 400.
// The point of the assertion is the never-5xx posture: an upstream
// blowup must not spill an internal error to the client.
test('GET /sec-doc-proxy: upstream fetch failure → 4xx, never 5xx', async () => {
  const res = fakeRes();
  const url = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/a8k.htm';
  await secDocProxyHandler(
    { query: { url } },
    res,
    {
      fetchSecDoc: (u) =>
        fetchSecDoc(u, {
          docFetch: async () => {
            throw new Error('econnreset from sec.gov');
          },
        }),
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid or unfetchable url' });
});

// 7. The handler itself never throws. Even if the injected service
// rejects (a contract violation; the real service is never-throws), the
// handler must catch and degrade rather than letting the rejection
// bubble out into the express error pipeline.
test('GET /sec-doc-proxy: handler never throws even if the service rejects', async () => {
  const res = fakeRes();
  let threw = false;
  try {
    await secDocProxyHandler(
      { query: { url: 'https://www.sec.gov/x.htm' } },
      res,
      {
        fetchSecDoc: async () => {
          throw new Error('unexpected: service contract violated');
        },
      }
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'handler must not throw');
  assert.ok(res.statusCode < 500 || res.statusCode === 502, `degraded status, got ${res.statusCode}`);
  // 502 with an empty body is the documented degraded path for a
  // service-contract violation; the body must not leak the error.
  if (res.statusCode === 502) {
    assert.equal(res.body, '');
  }
});
