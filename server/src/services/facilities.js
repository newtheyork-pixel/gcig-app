// Where a company's plants actually are.
//
// EPA's Envirofacts carries every US facility that reports to the Toxics
// Release Inventory, with its street address, coordinates, and — the part
// that makes this work — the PARENT company. So a ticker resolves to a
// list of real places rather than a line in a 10-K saying "we operate 40
// manufacturing facilities."
//
// Free, no key, no rate limit published. It is also the only public
// dataset that ties plants to their owner: SEC Item 2 lists properties in
// prose, and prose does not go on a map.
//
// What it is NOT: complete. TRI covers manufacturers above a reporting
// threshold, so a bank has no facilities here and a software company has
// almost none. Absence means "does not report to TRI", never "has no
// operations", and the panel has to say so or it reads as a claim.

const BASE = 'https://data.epa.gov/efservice';
const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

/// Words that are in a registered company name and never in EPA's parent
/// field. Searching "C. H. ROBINSON WORLDWIDE, INC." matches nothing;
/// "ROBINSON" matches too much. The first substantial token is the
/// compromise that works on real names.
const NOISE = /\b(INC|CORP|CORPORATION|CO|COMPANY|PLC|LTD|LIMITED|HOLDINGS|HLDGS|GROUP|THE|LLC|LP|SA|AG|NV)\b/gi;

export function searchTermFor(name) {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  // Single letters are initials, not a name. "C. H. ROBINSON WORLDWIDE,
  // INC." reduced to "C H", which matched sixty-eight unrelated plants
  // belonging to every company whose parent starts with those letters —
  // for a freight broker that owns no factories at all.
  //
  // The floor is two characters rather than three, because 3M is a real
  // company and a three-character floor threw it away.
  const words = cleaned.split(' ').filter((w) => w.length >= 2);
  if (!words.length) return null;

  // One word, because EPA matches on substring: searching "COCA COLA"
  // finds nothing, since the parent is recorded as "COCA-COLA". The
  // first real word is both the most permissive and the most accurate
  // thing to ask for.
  //
  // The exception is a first word too generic to mean a company on its
  // own, where the second narrows it without the substring problem —
  // those names are spaced rather than hyphenated in practice.
  const generic = /^(GENERAL|AMERICAN|NATIONAL|UNITED|FIRST|GLOBAL|INTERNATIONAL|NEW|GREAT|STANDARD)$/;
  if (words.length > 1 && generic.test(words[0])) return `${words[0]} ${words[1]}`;
  return words[0];
}

/// EPA stores longitude for the western hemisphere as a POSITIVE number.
/// Passing it through unchanged puts every American factory in Asia,
/// which is the sort of error a map makes obvious and a table hides.
function normalise(row) {
  const lat = Number(row.pref_latitude);
  const lonRaw = Number(row.pref_longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lonRaw) && lat !== 0;
  const lon = hasCoords ? (lonRaw > 0 ? -lonRaw : lonRaw) : null;
  return {
    id: row.tri_facility_id || null,
    name: row.facility_name || null,
    parent: row.parent_co_name || null,
    address: row.street_address || null,
    city: row.city_name || null,
    county: row.county_name || null,
    state: row.state_abbr || null,
    zip: row.zip_code || null,
    lat: hasCoords ? lat : null,
    lon,
    closed: row.fac_closed_ind === 'Y',
  };
}

/**
 * Facilities whose PARENT matches a company name.
 *
 * @param {string} companyName  a registered name, e.g. from SEC EDGAR
 * @param {object} deps         injectable fetch, for tests
 */
export async function getFacilities(companyName, deps = {}) {
  const term = searchTermFor(companyName);
  if (!term) return { term: null, facilities: [], truncated: false };

  const hit = cache.get(term);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const doFetch = deps.fetch || fetch;
  const url = `${BASE}/tri_facility/parent_co_name/CONTAINING/${encodeURIComponent(term)}/rows/0:999/JSON`;
  const res = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`EPA Envirofacts ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const rows = await res.json();
  const list = Array.isArray(rows) ? rows : [];
  const facilities = list
    .map(normalise)
    .filter((f) => !f.closed && f.name)
    // Alphabetical inside a state, so a reader scanning for one place
    // can find it, and states group together.
    .sort((a, b) => (a.state || '').localeCompare(b.state || '') || (a.name || '').localeCompare(b.name || ''));

  const value = {
    term,
    facilities,
    // A thousand rows means the query hit the page limit and there are
    // more. Saying so beats presenting a truncated list as the whole.
    truncated: list.length >= 1000,
    mapped: facilities.filter((f) => f.lat != null).length,
  };
  cache.set(term, { at: Date.now(), value });
  return value;
}

export function _resetFacilitiesCache() {
  cache.clear();
}
