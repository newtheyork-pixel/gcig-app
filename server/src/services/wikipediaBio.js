// A biography for an executive the SEC documents decline to describe.
//
// Plenty of filers — Apple among them — incorporate the officer section
// by reference and never print a word about their own executives, so a
// parser that only reads filings shows an empty MGMT card for the most
// covered management team on earth. For people at that level, Wikipedia
// has a sourced article, and its REST API is keyless.
//
// The dangerous failure here is the WRONG person, not a missing one:
// "Jeff Williams" is a disambiguation page with a senator on it. Two
// guards, both mandatory: the lookup goes through search scoped by the
// company's name rather than a bare title fetch, and the summary is
// rejected unless its own text mentions the company. A bio we cannot
// tie to the company is treated as nobody, never as close enough.

const UA = 'GriffinFund/1.0 (https://thegriffinfund.org; research terminal)';
const TIMEOUT_MS = 8_000;
const cache = new Map(); // "name|company" -> { at, value }
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/// Does the article text plausibly tie this person to this company?
/// The full legal name rarely appears ("Apple Inc."), so the match is
/// against the name with its suffix stripped, case-insensitively.
export function mentionsCompany(text, companyName) {
  const t = String(text || '').toLowerCase();
  const stripped = String(companyName || '')
    .replace(/,? (inc|corp(oration)?|co|company|ltd|plc|holdings?)\.?$/i, '')
    .trim()
    .toLowerCase();
  return stripped.length >= 3 && t.includes(stripped);
}

/**
 * Best-effort Wikipedia bio for one person at one company.
 *
 * Returns { bio, url, source: 'Wikipedia' } or null. Never throws.
 */
export async function wikipediaBio(personName, companyName) {
  const name = String(personName || '').trim();
  const company = String(companyName || '').trim();
  if (!name || !company) return null;

  const key = `${name}|${company}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // Search with the company in the query, so "Jeff Williams Apple"
  // finds the COO and not the senator. Top few results only — if the
  // right article is not near the top, it is not clearly the right
  // article.
  const q = encodeURIComponent(`${name} ${company}`);
  const found = await getJson(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${q}&limit=3`
  );
  const pages = Array.isArray(found?.pages) ? found.pages : [];

  let value = null;
  for (const page of pages) {
    if (!page?.key) continue;
    // The article title must contain the person's surname — a search
    // for "John Ternus Apple" happily returns "Apple Inc." itself.
    const surname = name.split(/\s+/).pop().toLowerCase();
    if (!String(page.title || '').toLowerCase().includes(surname)) continue;
    const sum = await getJson(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}?redirect=true`
    );
    if (!sum || sum.type !== 'standard') continue;
    const extract = String(sum.extract || '').trim();
    if (extract.length < 60) continue;
    if (!mentionsCompany(extract, company)) continue;
    value = {
      bio: extract,
      url: sum.content_urls?.desktop?.page || null,
      source: 'Wikipedia',
    };
    break;
  }

  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
