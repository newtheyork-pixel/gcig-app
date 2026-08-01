// One download of a filing, shared by everything that reads it.
//
// SPLC reads a company's latest 10-K twice: once to find named
// relationships in the prose, and once to read the concentration
// percentages out of the inline XBRL. Those are two different questions
// answered from the same document, and until this existed they were two
// separate multi-megabyte downloads of the same bytes — Mesa's 10-K is
// 3.5MB, Johnson & Johnson's 3.7MB, and both were being pulled twice per
// panel open.
//
// Bounded deliberately small. A cached 10-K is megabytes of string, and
// the point is to collapse the two reads of ONE panel open into one
// fetch, not to hold a library in memory on a 512MB Render dyno.

import { getLatestFilingByForm, SEC_UA } from './secFilings.js';
import { secFetch } from './secFetch.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 3;
const cache = new Map();

export function _resetFilingDocumentCache() {
  cache.clear();
}

/**
 * The latest filing of a form, and its text.
 *
 * Returns `{ filing, html }`, or null when the ticker has no such
 * filing. Throws only on a transport failure, so a caller can still tell
 * "no 10-K exists" from "EDGAR would not talk to us".
 */
export async function getFilingDocument(ticker, formRe = /^10-K(405|SB)?$/i, deps = {}) {
  const key = `${String(ticker || '').toUpperCase()}#${formRe.source}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    // Refresh recency: Map keeps insertion order, so delete+set moves
    // this entry to the back of the eviction queue.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  const findFiling = deps.getLatestFilingByForm || getLatestFilingByForm;
  const get = deps.secFetch || secFetch;

  const filing = await findFiling(ticker, formRe);
  if (!filing?.url) return null;
  const res = await get(filing.url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'text/html' },
    timeoutMs: 30_000,
  });
  const value = { filing, html: await res.text() };

  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
