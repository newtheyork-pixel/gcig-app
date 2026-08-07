// An executive's biography from the SEC's own record.
//
// When a company appoints an officer, the 8-K announcing it (Item 5.02)
// nearly always carries the paragraph MGMT wants: "Kevan Parekh, 53, as
// Apple's Senior Vice President, Chief Financial Officer... joined
// Apple in June 2013... Prior to joining Apple, held senior leadership
// roles at Thomson Reuters and General Motors." Proxies carry the same
// shape for some filers. EDGAR's full-text search finds the filing that
// mentions the person; the extractor below finds the paragraph that
// DESCRIBES them rather than one they merely signed.
//
// Trust-wise this sits above Wikipedia and below the 10-K's own officer
// section: it is a primary SEC document about exactly this person at
// exactly this company, but assembled by search rather than by the
// filer's table of contents.

import { secFetch } from './secFetch.js';
import { SEC_UA } from './secFilings.js';

const FTS = 'https://efts.sec.gov/LATEST/search-index';
const MAX_DOC_BYTES = 3 * 1024 * 1024;
const MAX_DOCS_PER_PERSON = 2;
const cache = new Map(); // "cik|name" -> { at, value }
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function normalize(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|td|tr|li|h[1-6])>/gi, '\n\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
}

/**
 * The best bio-shaped paragraph about `name` in a filing's HTML, or
 * null. Pure and exported for tests.
 *
 * What separates a bio from a signature block or a compensation table
 * is its VERBS: joined, served, previously, prior to. A block that
 * names the person without telling their story scores nothing, and the
 * signature page is rejected outright.
 */
export function extractBio(html, name) {
  const surname = String(name || '').trim().split(/\s+/).pop();
  if (!surname || surname.length < 3) return null;
  const surnameRe = new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

  const blocks = normalize(html)
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length >= 200 && b.length <= 4000 && surnameRe.test(b));

  let best = null;
  let bestScore = 0;
  for (const b of blocks) {
    if (/duly caused|signed on its behalf|power of attorney|signature/i.test(b)) continue;
    // The paragraph must be ABOUT the person, not merely mention them:
    // a successor's appointment names the departing officer too
    // ("succeeding Katherine Adams"), and that is a bio of the OTHER
    // person. In a real bio the subject arrives early and recurs.
    const mentions = (b.match(new RegExp(surnameRe.source, 'gi')) || []).length;
    const firstAt = b.search(surnameRe);
    if (firstAt > b.length * 0.4 && mentions < 3) continue;
    // Whose appointment IS this? "announced that Jennifer Newstead
    // will become General Counsel, succeeding Katherine Adams" is a
    // block about Newstead however many times it discusses Adams. If
    // the appointment verbs name a subject and none of them is our
    // person, the block belongs to somebody else.
    const subjects = [...b.matchAll(
      /\b(?:appointed|named|announced that|promoted)\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,2})|\b([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,2})\s+(?:will become|has been appointed|was appointed|has been named)/g
    )].map((m) => (m[1] || m[2] || ''));
    if (subjects.length > 0 && !subjects.some((s) => surnameRe.test(s))) continue;
    let score = 0;
    if (/\b(joined|previously|prior to|has served|served as|assumed)\b/i.test(b)) score += 2;
    if (new RegExp(`${surname}[^.]{0,40},\\s*\\d{2},`).test(b)) score += 3; // "Parekh, 53,"
    if (/\b(positions?|roles?|leadership|career)\b/i.test(b)) score += 1;
    // Compensation-table narrative names people constantly without
    // saying who they are — "the RSUs granted to Ms. Adams" is about a
    // grant, not a person. Real appointment bios survive the penalty
    // because they carry the age pattern and career verbs.
    if (/\b(RSUs?|restricted stock|vest(ing|ed)?|grant(ed|s)? of|equity award)\b/i.test(b)) score -= 3;
    if (score >= 2 && score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (!best) return null;
  return best.length > 1800 ? `${best.slice(0, 1800).replace(/\s+\S*$/, '')}…` : best;
}

function docUrl(cikRaw, id) {
  // FTS ids read "0001140361-25-000228:ef20040370_8k.htm".
  const [accession, filename] = String(id || '').split(':');
  if (!accession || !filename || /\.pdf$/i.test(filename)) return null;
  const cik = String(parseInt(cikRaw, 10));
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${filename}`;
}

// ── The no-search path ───────────────────────────────────────────────
//
// efts.sec.gov (full-text search) is behind an edge that refuses cloud
// datacenter IPs, so the FTS route above works from a laptop and
// returns nothing from Render. The submissions feed — the endpoint the
// whole terminal already lives on and that Render provably reaches —
// marks every 8-K with its item numbers, and Item 5.02 IS the officer
// appointment/departure item. The documents that carry bios are
// therefore enumerable without any search at all.

const companyDocsCache = new Map(); // cik -> { at, docs }
const docTextCache = new Map(); // url -> { at, text }
const DOC_CACHE_MAX = 40;

async function candidateDocs(cikStr, fetcher) {
  const hit = companyDocsCache.get(cikStr);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.docs;
  const docs = [];
  try {
    const res = await fetcher(
      `https://data.sec.gov/submissions/CIK${cikStr.padStart(10, '0')}.json`,
      { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } }
    );
    const j = await res.json();
    const r = j?.filings?.recent || {};
    const cikNum = String(parseInt(cikStr, 10));
    const rows = (r.form || []).map((form, i) => ({
      form,
      items: r.items?.[i] || '',
      accession: r.accessionNumber?.[i] || '',
      doc: r.primaryDocument?.[i] || '',
      date: r.filingDate?.[i] || '',
    }));
    let proxies = 0;
    for (const row of rows) {
      if (!row.accession || !row.doc || /\.pdf$/i.test(row.doc)) continue;
      const isAppointment = row.form === '8-K' && row.items.includes('5.02');
      const isProxy = row.form === 'DEF 14A' && proxies < 1;
      if (!isAppointment && !isProxy) continue;
      if (isProxy) proxies += 1;
      docs.push({
        form: row.form,
        date: row.date,
        url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${row.accession.replace(/-/g, '')}/${row.doc}`,
      });
      if (docs.length >= 12) break;
    }
  } catch {
    /* an empty list is the honest miss */
  }
  companyDocsCache.set(cikStr, { at: Date.now(), docs });
  if (companyDocsCache.size > 100) {
    companyDocsCache.delete(companyDocsCache.keys().next().value);
  }
  return docs;
}

async function docText(url, fetcher) {
  const hit = docTextCache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  let text = null;
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': SEC_UA } });
    text = (await res.text()).slice(0, MAX_DOC_BYTES);
  } catch {
    text = null;
  }
  // Cached even as a null: fifteen officers walking the same dead URL
  // is fifteen times one failure otherwise.
  docTextCache.set(url, { at: Date.now(), text });
  if (docTextCache.size > DOC_CACHE_MAX) {
    docTextCache.delete(docTextCache.keys().next().value);
  }
  return text;
}

/**
 * Best-effort SEC-sourced bio for one person at one company (by CIK).
 * Returns { bio, url, source: '8-K'|'DEF 14A'|... } or null. Never
 * throws; every miss is a null.
 */
export async function filingBio(name, cik, deps = {}) {
  const person = String(name || '').trim();
  const cikStr = String(cik || '').replace(/\D/g, '');
  if (!person || !cikStr) return null;

  const key = `${cikStr}|${person}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const fetcher = deps.secFetch || secFetch;
  let value = null;
  try {
    // The surname plus a bio verb narrows the search to filings that
    // tell the story, not the dozens of earnings 8-Ks the person
    // merely signed.
    const surname = person.split(/\s+/).pop();
    const q = encodeURIComponent(`"${surname}" "previously"`);
    const res = await fetcher(
      `${FTS}?q=${q}&ciks=${cikStr.padStart(10, '0')}`,
      { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } }
    );
    const json = await res.json();
    const hits = json?.hits?.hits || [];

    let tried = 0;
    for (const h of hits) {
      if (tried >= MAX_DOCS_PER_PERSON) break;
      const url = docUrl(cikStr, h._id);
      if (!url) continue;
      tried += 1;
      const html = await docText(url, fetcher);
      if (!html) continue;
      const bio = extractBio(html, person);
      if (bio) {
        value = { bio, url, source: h._source?.file_type || 'SEC filing' };
        break;
      }
    }
  } catch {
    value = null;
  }

  // The search host refused or found nothing: walk the appointment
  // 8-Ks and the newest proxy directly. The list and every document
  // are cached per company, so a fifteen-officer panel costs the same
  // handful of fetches as a one-officer one.
  if (!value) {
    const docs = await candidateDocs(cikStr, fetcher);
    for (const d of docs) {
      const html = await docText(d.url, fetcher);
      if (!html) continue;
      const bio = extractBio(html, person);
      if (bio) {
        value = { bio, url: d.url, source: d.form };
        break;
      }
    }
  }

  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
