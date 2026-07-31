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

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = 'https://data.epa.gov/efservice';
// The estate does not change between Tuesday and Wednesday.
const REFETCH_MS = 30 * 24 * 60 * 60 * 1000;
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

  // Stored rows first. Re-pulling 270 facilities because somebody opened
  // a panel is work nobody asked for, and the coordinates we geocoded
  // ourselves live here — losing those to a process restart was the
  // expensive part.
  const stored = await prisma.facility.findMany({ where: { term, closed: false } });
  if (stored.length && Date.now() - new Date(stored[0].fetchedAt).getTime() < REFETCH_MS) {
    const value = shape(term, stored, false);
    cache.set(term, { at: Date.now(), value });
    fillCoordinates(term).catch(() => {});
    return value;
  }

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

  // Written once, read for a month. The upsert means a re-pull refreshes
  // a row instead of duplicating it, and never clears coordinates we
  // worked out ourselves — EPA's blank must not overwrite our answer.
  for (const f of facilities) {
    if (!f.id) continue;
    const base = {
      term, name: f.name, parent: f.parent, address: f.address, city: f.city,
      county: f.county, state: f.state, zip: f.zip, closed: f.closed,
      fetchedAt: new Date(),
    };
    await prisma.facility.upsert({
      where: { id: f.id },
      update: f.lat != null ? { ...base, lat: f.lat, lon: f.lon } : base,
      create: { id: f.id, ...base, lat: f.lat, lon: f.lon },
    });
  }

  const saved = await prisma.facility.findMany({ where: { term, closed: false } });
  const value = shape(term, saved, list.length >= 1000);
  cache.set(term, { at: Date.now(), value });
  fillCoordinates(term).catch(() => {});
  return value;
}

function shape(term, rows, truncated) {
  const facilities = rows
    .map((r) => ({
      id: r.id, name: r.name, parent: r.parent, address: r.address, city: r.city,
      county: r.county, state: r.state, zip: r.zip, lat: r.lat, lon: r.lon,
      geocoded: r.geocoded, closed: r.closed,
    }))
    .sort((a, b) => (a.state || '').localeCompare(b.state || '') || (a.name || '').localeCompare(b.name || ''));
  return {
    term,
    facilities,
    truncated,
    mapped: facilities.filter((f) => f.lat != null).length,
    unplaced: facilities.filter((f) => f.lat == null).length,
  };
}

/// Work out coordinates for the sites EPA never placed.
///
/// Half of Berkshire's estate arrives without a position but every row
/// has a street address, and an address IS a position — the US Census
/// geocoder resolves them free, with no key, and it is authoritative for
/// exactly this data. Brittain Machine in Wichita went from a blank to
/// 37.6496, -97.3798 on the first try.
///
/// Runs in the background and writes as it goes, so a panel opens on what
/// is known and fills in rather than waiting on 135 lookups. Bounded per
/// pass, and a row that fails is marked tried so a bad address is not
/// retried forever.
const geocoding = new Set();

export async function fillCoordinates(term, { limit = 40, deps = {} } = {}) {
  if (geocoding.has(term)) return 0;
  geocoding.add(term);
  const doFetch = deps.fetch || fetch;
  let placed = 0;
  try {
    const todo = await prisma.facility.findMany({
      where: { term, closed: false, lat: null, geoTried: false, address: { not: null } },
      take: limit,
    });
    for (const f of todo) {
      const line = [f.address, f.city, f.state, f.zip].filter(Boolean).join(', ');
      let lat = null;
      let lon = null;
      try {
        const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
          + `?address=${encodeURIComponent(line)}&benchmark=Public_AR_Current&format=json`;
        const res = await doFetch(url);
        if (res.ok) {
          const body = await res.json();
          const m = body?.result?.addressMatches?.[0]?.coordinates;
          if (m && Number.isFinite(m.y) && Number.isFinite(m.x)) {
            lat = m.y;
            lon = m.x;
          }
        }
      } catch {
        /* leave it unplaced; geoTried still gets set below */
      }
      await prisma.facility.update({
        where: { id: f.id },
        data: lat != null ? { lat, lon, geocoded: true, geoTried: true } : { geoTried: true },
      });
      if (lat != null) placed += 1;
    }
    // The shaped cache is now stale for this term.
    cache.delete(term);
  } finally {
    geocoding.delete(term);
  }
  return placed;
}

export function _resetFacilitiesCache() {
  cache.clear();
}

/// How close a storm is to a company's plants.
///
/// This is what makes a weather panel worth opening. "Active storm, 28N
/// 92W" and "we hold PEP" are two facts a reader has to join by hand;
/// "the storm is 40 miles from PepsiCo's plant in Houma" is the one they
/// wanted. Sites without coordinates are excluded rather than guessed at
/// — an address is not a position, and a plant placed by assumption is
/// worse than a plant left out.
export function sitesNearStorm(facilities, storm, withinMiles = 300) {
  const lat = Number(storm?.latitude);
  const lon = Number(storm?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const out = [];
  for (const f of facilities || []) {
    if (f.lat == null || f.lon == null) continue;
    const dLat = rad(f.lat - lat);
    const dLon = rad(f.lon - lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat)) * Math.cos(rad(f.lat)) * Math.sin(dLon / 2) ** 2;
    const miles = Math.round(2 * R * Math.asin(Math.sqrt(h)));
    if (miles <= withinMiles) out.push({ ...f, milesFromStorm: miles });
  }
  return out.sort((a, b) => a.milesFromStorm - b.milesFromStorm);
}
