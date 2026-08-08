// SEC document proxy. SEC.gov refuses third-party framing with
// X-Frame-Options: SAMEORIGIN plus a Content-Security-Policy
// frame-ancestors directive, so the FIL terminal's in-app PDFModal
// paints blank for every Form 4/A, 10-K, DEF 14A pulled straight off
// EDGAR. The fix is the obvious one: a same-origin proxy that fetches
// the SEC page with our existing keyless SEC_UA plumbing, strips the
// framing-refusal headers, and lets our client iframe the result. Pure
// SEC-only allowlist — there is no general open relay here; the
// service rejects any URL outside (www|data).sec.gov before a fetch is
// even attempted. Public by design (SEC content is public), rate-
// limited at the route layer, never-throws.
//
// Mirrors the proxyStatement.js / executiveBios.js service contract
// 1:1: declarative SEC_UA, generous-but-bounded size cap, injectable
// deps.docFetch for tests, console.warn on degraded paths, an honest
// null on any failure rather than a thrown exception that would spill
// a 5xx out the handler.
import { SEC_UA } from './secFilings.js';
import { takeSlot } from './secFetch.js';

// 16 MB cap. SEC primary HTML docs are typically ≤2 MB; the KO proxy
// we already pull is ~6 MB; capping at 16 MB safely covers any HTML
// or small inline PDF the SEC archive serves while keeping a hostile
// stream from running away with the API memory budget.
const MAX_DOC = 16 * 1024 * 1024;

// Tight allowlist: only the two SEC host families we ever link to from
// the FIL panel. www.sec.gov serves the Archives/EDGAR primary docs,
// data.sec.gov serves the submissions JSON (the latter never reaches
// this proxy in practice, but it's included so a future code path that
// embeds a submissions feed doesn't have to widen the gate). Either
// http: or https: passes — EDGAR redirects http to https itself, but
// not narrowing the scheme keeps the allowlist boring and obvious.
function isAllowedSecUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.hostname === 'www.sec.gov' || u.hostname === 'data.sec.gov';
}

// The HTML <head> injection. SEC docs use relative paths for sibling
// exhibits, images and stylesheets (the primary 8-K HTML pulls in
// exhibit1.jpg and a tiny css file from the same accession directory),
// and once the iframe loads from /api/terminal/sec-doc-proxy those
// relative URLs would resolve back to OUR origin and 404 instantly.
// Injecting <base href="<original-dir>/"> makes the browser resolve
// them back to sec.gov, where they belong. baseHref is the directory
// portion of the original URL — everything up to and including the
// final slash. Case-insensitive regex on <head> tag so a filer who
// writes <HEAD ...> still matches; if the document has no <head> we
// synthesize one right after <html ...>; if it has neither (a fragment
// HTML — uncommon but possible), we prepend <base> bare, which is a
// degraded-but-functional fallback.
function htmlEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function injectBaseHref(html, url) {
  // Build the base href from the PARSED, normalized URL (not the raw request
  // string) and HTML-escape it. The raw string can carry literal " < > that
  // `new URL()` tolerates in the path — interpolating it unescaped let an
  // attacker break out of the attribute and inject <script> (XSS on this
  // origin). Parsing + escaping closes that.
  let dir;
  try {
    const u = new URL(url);
    dir = u.href.substring(0, u.href.lastIndexOf('/') + 1);
  } catch {
    dir = '';
  }
  const baseTag = `<base href="${htmlEscapeAttr(dir)}">`;
  if (/<head([^>]*)>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${baseTag}`);
  }
  if (/<html([^>]*)>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (_m, attrs) => `<html${attrs}><head>${baseTag}</head>`);
  }
  return baseTag + html;
}

async function defaultDocFetch(url) {
  // Counts against the same process-wide SEC budget as every other
  // EDGAR reader; the FIL viewer used to fetch outside it entirely.
  await takeSlot();
  // Mirrors the proxyStatement.js docFetch shape: SEC_UA + a permissive
  // Accept (HTML, then anything) so a binary exhibit in the same path
  // still flows through unchanged. redirect:'manual' so the upstream can't 30x
  // us off the SEC allowlist (SSRF / DNS-rebinding); a single same-allowlist
  // hop is re-validated and followed below.
  return fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'text/html,*/*' },
    redirect: 'manual',
  });
}

function locationOf(upstream) {
  if (!upstream || !upstream.headers) return null;
  return typeof upstream.headers.get === 'function'
    ? upstream.headers.get('location')
    : upstream.headers['location'];
}

// { status, contentType, body }. Body is a string for HTML / XHTML
// (with <base href> injected), a Buffer for everything else. Returns
// null when the URL is off the allowlist or the upstream fetch fails
// outright — the caller responds 400 in either case rather than 5xx.
// Never throws.
export async function fetchSecDoc(url, deps = {}) {
  if (!isAllowedSecUrl(url)) return null;
  const docFetch = deps.docFetch || defaultDocFetch;
  try {
    let upstream = await docFetch(url);
    if (!upstream) return null;
    // Follow at most one redirect, and only if it stays on the SEC allowlist —
    // so EDGAR's own http→https / canonical redirects work, but the upstream
    // can't bounce us to an internal or attacker host.
    if (typeof upstream.status === 'number' && upstream.status >= 300 && upstream.status < 400) {
      const loc = locationOf(upstream);
      let next = null;
      try {
        next = loc ? new URL(loc, url).href : null;
      } catch {
        next = null;
      }
      if (!next || !isAllowedSecUrl(next)) return null;
      upstream = await docFetch(next);
      if (!upstream) return null;
      if (typeof upstream.status === 'number' && upstream.status >= 300 && upstream.status < 400) return null;
      url = next; // the base href + body now reflect the final URL
    }
    const contentType =
      (upstream.headers &&
        (typeof upstream.headers.get === 'function'
          ? upstream.headers.get('content-type')
          : upstream.headers['content-type'])) ||
      'application/octet-stream';
    const isHtml = /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
    let body;
    if (isHtml) {
      const text = await upstream.text();
      const truncated = String(text || '').slice(0, MAX_DOC);
      body = injectBaseHref(truncated, url);
    } else {
      const buf = await upstream.arrayBuffer();
      const view = Buffer.from(buf);
      body = view.length > MAX_DOC ? view.subarray(0, MAX_DOC) : view;
    }
    return {
      status: typeof upstream.status === 'number' ? upstream.status : 200,
      contentType,
      body,
    };
  } catch (err) {
    console.warn(`secDocProxy(${url}) failed:`, err.message);
    return null;
  }
}
