// Board interlocks from the SEC's ownership record, not from prose.
//
// The proxy-bio route to "which other boards does this director sit
// on" parses whatever sentence a filer chose to write, and for many
// proxies (Apple's included) extracts nothing. But every director
// files Forms 3/4 at EVERY company they serve, under one personal CIK
// — so the authoritative interlock map is sitting in EDGAR as
// structured data. Per person: one atom listing of their Form 4s,
// deduped by file number (one per issuer relationship), then a single
// filing per issuer for the issuerName / issuerTradingSymbol / role
// flags. Everything through declared-UA endpoints that Render's IP
// reaches (the full-text search host is the blocked one; these are
// not).

import { secFetch } from './secFetch.js';
import { SEC_UA } from './secFilings.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ownerCache = new Map(); // ownerCik -> { at, issuers }
const MAX_ISSUERS_PER_PERSON = 6;

function headers() {
  return { headers: { 'User-Agent': SEC_UA } };
}

/**
 * The companies one person files ownership documents at.
 * Returns [{ cik, name, ticker, isDirector, isOfficer, lastFiled }].
 * Never throws; a miss is an empty array.
 */
export async function ownerIssuers(ownerCik, deps = {}) {
  const cik = String(ownerCik || '').replace(/\D/g, '');
  if (!cik) return [];
  const hit = ownerCache.get(cik);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.issuers;

  const fetcher = deps.secFetch || secFetch;
  const issuers = [];
  try {
    const res = await fetcher(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik.padStart(10, '0')}&type=4&output=atom&count=40`,
      headers()
    );
    const atom = await res.text();
    // One entry per filing; the file number identifies the issuer
    // relationship, so the first filing per file number is enough.
    const entries = [...atom.matchAll(
      /<file-number>([^<]+)<\/file-number>[\s\S]*?<filing-date>([^<]+)<\/filing-date>[\s\S]*?<filing-href>([^<]+)<\/filing-href>/g
    )];
    const byFile = new Map();
    for (const [, fileNo, date, href] of entries) {
      if (!byFile.has(fileNo)) byFile.set(fileNo, { date, href });
      if (byFile.size >= MAX_ISSUERS_PER_PERSON) break;
    }

    for (const [, { date, href }] of byFile) {
      // .../000178052526000008/0001780525-26-000008-index.htm → the
      // folder listing, then the first real XML in it is the form.
      const folder = String(href).replace(/\/[^/]*-index\.htm.*$/i, '');
      try {
        const idxRes = await fetcher(`${folder}/index.json`, headers());
        const idx = await idxRes.json();
        const xml = (idx?.directory?.item || []).find(
          (f) => /\.xml$/i.test(f?.name || '') && !/^xsl/i.test(f?.name || '')
        );
        if (!xml) continue;
        const docRes = await fetcher(`${folder}/${xml.name}`, headers());
        const doc = await docRes.text();
        const t = (name) =>
          (doc.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i')) || [])[1] || null;
        const issuerCik = String(t('issuerCik') || '').replace(/\D/g, '');
        const name = t('issuerName');
        if (!issuerCik || !name) continue;
        // A seat someone LEFT stops generating filings — Newstead's
        // Meta Form 4s are history, not an interlock. The atom is
        // newest-first, so `date` is the freshest filing at this
        // issuer; anything without one in two years is an old job.
        if (date < new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
          continue;
        }
        issuers.push({
          cik: issuerCik,
          name,
          ticker: (t('issuerTradingSymbol') || '').toUpperCase() || null,
          isDirector: /<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(doc),
          isOfficer: /<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(doc),
          lastFiled: date,
        });
      } catch {
        /* one unreadable relationship costs itself, not the map */
      }
    }
  } catch {
    /* an empty list is the honest miss */
  }

  ownerCache.set(cik, { at: Date.now(), issuers });
  if (ownerCache.size > 300) ownerCache.delete(ownerCache.keys().next().value);
  return issuers;
}

// ── The per-ticker network, computed in the background ───────────────

const networkCache = new Map(); // focus ticker -> { at, edges }
const NETWORK_TTL_MS = 24 * 60 * 60 * 1000;

/// What the last background pass computed for this ticker, or null.
export function cachedInterlocks(focusTicker) {
  const hit = networkCache.get(String(focusTicker || '').toUpperCase());
  return hit && Date.now() - hit.at < NETWORK_TTL_MS ? hit.edges : null;
}

/**
 * Compute and cache ownership-based interlock edges for a company.
 * `people` is the roster: current directors and officers with
 * ownerCiks. Sequential per person — this walks EDGAR and the club is
 * a polite guest. Meant to run off the request path.
 */
export async function computeInterlocks(focusTicker, people, holdings, deps = {}) {
  const f = String(focusTicker || '').toUpperCase();
  if (!f) return [];
  const held = new Map(
    (holdings || [])
      .filter((h) => h?.ticker && !h.isCash)
      .map((h) => [String(h.ticker).toUpperCase(), h])
  );
  const edges = [];
  const seen = new Set();
  const roster = (people || [])
    .filter((p) => p?.ownerCik && !p.former && (p.isDirector || p.isOfficer))
    .slice(0, 12);
  for (const p of roster) {
    const issuers = await ownerIssuers(p.ownerCik, deps);
    for (const isr of issuers) {
      const label = isr.ticker || isr.name;
      if (!label || String(label).toUpperCase() === f) continue;
      const key = `${p.name}|${label}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        person: p.name,
        a: f,
        b: label,
        held: isr.ticker ? held.has(isr.ticker) : false,
        // Say what the seat IS — a director's other directorship and
        // an officer's day job are different facts.
        role: isr.isDirector ? 'director' : isr.isOfficer ? 'officer' : 'owner',
        source: 'Forms 3/4',
        // A seat is as current as its newest filing. A reader seeing
        // "officer at META, last filed 2025-11" beside "at Apple since
        // January" can date the transition themselves; hiding recently
        // ended roles would guess, and guessing is the prose parser's
        // failure mode all over again.
        lastFiled: isr.lastFiled || null,
      });
    }
  }
  edges.sort((x, y) => Number(y.held) - Number(x.held) || String(x.person).localeCompare(String(y.person)));
  networkCache.set(f, { at: Date.now(), edges });
  if (networkCache.size > 100) networkCache.delete(networkCache.keys().next().value);
  return edges;
}
