import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { fetchSecDoc } from '../services/secDocProxy.js';

// Mount lives at /api/terminal/sec-doc-proxy in index.js, registered
// BEFORE the auth-gated /api/terminal router so this route is not
// covered by verifyJwt or requireExecutive. That is deliberate: SEC
// content is public, the iframe in PDFModal can't carry a Bearer
// header anyway, and the abuse surface is constrained by two
// independent gates — the tight SEC-only allowlist inside fetchSecDoc
// (any other host yields 400 before a fetch is attempted) and the
// per-IP rate limit below. Same posture as a CDN edge proxy: it can
// only ever reflect SEC URLs, and only at a polite rate.

// CLIENT_ORIGIN is the comma-separated list the rest of index.js
// already parses for CORS. Re-parsing here keeps the proxy router
// self-contained and lets the test inject env without booting the
// full app. 'self' is always allowed so the same-origin iframe from
// our own client works in any deploy that hasn't set the env var.
function parseAllowedOrigins() {
  return (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 60 req/min/IP is generous for a human clicking through a filings
// panel (a power user might click two or three docs a minute), yet
// tight enough to blunt a scripted scrape that would try to use this
// as a public SEC mirror. Keyed on req.ip so a shared-NAT classroom
// shares one bucket — express trusts Render's proxy via app.set
// trust proxy in index.js.
export const secProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `sec-proxy:${req.ip}`,
  message: { error: 'SEC proxy rate limit reached. Try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Handler extracted with an injectable service the same way the
// sibling terminal handlers (filings/quotes/exec-bios) do for tests.
// Never 5xx: any unexpected rejection out of fetchSecDoc degrades to a
// 502 with an honest empty body, matching the never-5xx posture every
// other terminal route holds to. A missing or off-allowlist url is the
// one 4xx — it's the caller's fault, not an internal failure.
export async function secDocProxyHandler(req, res, deps = {}) {
  const fetcher = deps.fetchSecDoc || fetchSecDoc;
  const url = typeof req.query?.url === 'string' ? req.query.url : '';
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }
  let result;
  try {
    result = await fetcher(url);
  } catch (err) {
    // fetchSecDoc is contractually never-throws, but the handler does
    // not lean on that — any leaked rejection degrades to an honest
    // 502 with an empty body rather than spilling a 5xx with an
    // internal stack trace.
    console.warn(`sec-doc-proxy(${url}) handler degraded:`, err.message);
    return res.status(502).send('');
  }
  if (!result) {
    return res.status(400).json({ error: 'invalid or unfetchable url' });
  }

  // Strip the framing-refusal headers helmet sets by default
  // (X-Frame-Options: SAMEORIGIN comes from frameguard). Replace with
  // a permissive frame-ancestors directive listing our own origin
  // plus every configured client origin so the iframe in PDFModal can
  // load this response same-origin. CSP is the modern, browser-
  // honored gate; X-Frame-Options is the legacy one and must be
  // removed for the policy to relax cleanly in older browsers.
  res.removeHeader('X-Frame-Options');
  const origins = parseAllowedOrigins();
  const frameAncestors = ["'self'", ...origins].join(' ');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('Content-Type', result.contentType);
  // SEC documents at a given URL are effectively immutable (each
  // accession is a frozen snapshot), so a short public cache is fine
  // and saves a round trip on the common second-click-same-doc.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(result.status).send(result.body);
}

const router = Router();
router.get('/', secProxyLimiter, (req, res) => secDocProxyHandler(req, res));

export default router;
