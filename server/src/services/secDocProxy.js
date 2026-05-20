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
function injectBaseHref(html, url) {
  const baseHref = url.substring(0, url.lastIndexOf('/') + 1);
  const baseTag = `<base href="${baseHref}">`;
  if (/<head([^>]*)>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${baseTag}`);
  }
  if (/<html([^>]*)>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (_m, attrs) => `<html${attrs}><head>${baseTag}</head>`);
  }
  return baseTag + html;
}

async function defaultDocFetch(url) {
  // Mirrors the proxyStatement.js docFetch shape: SEC_UA + a permissive
  // Accept (HTML, then anything) so a binary exhibit in the same path
  // still flows through unchanged.
  return fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'text/html,*/*' },
  });
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
    const upstream = await docFetch(url);
    if (!upstream) return null;
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
