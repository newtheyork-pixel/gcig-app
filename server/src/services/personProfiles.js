// The durable record of people at covered companies.
//
// Every parser output used to live in a 24-hour memory cache: a deploy
// re-parsed the world, and one throttled SEC minute rendered MGMT as if
// the company had no management. What has been seen once is now kept —
// parses refresh rows, they never have to succeed twice for the same
// fact to stay on screen.

import prisma from '../db.js';

/**
 * Record people for a ticker. Best-effort: a DB hiccup must never take
 * a panel down, so failures log and return rather than throw.
 *
 * A row's bio is only overwritten by a bio — a parse that found the
 * person but not their story must not blank the story a better source
 * already saved. Filing-sourced bios outrank Wikipedia ones.
 */
export async function saveProfiles(ticker, people, kind) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym || !Array.isArray(people)) return;
  for (const p of people) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    try {
      const existing = await prisma.personProfile.findUnique({
        where: { ticker_name_kind: { ticker: sym, name, kind } },
      });
      const incomingBio = p.bio ? String(p.bio).slice(0, 8000) : null;
      const keepOldBio =
        existing?.bio &&
        (!incomingBio ||
          (existing.bioSource !== 'Wikipedia' && p.bioSource === 'Wikipedia'));
      await prisma.personProfile.upsert({
        where: { ticker_name_kind: { ticker: sym, name, kind } },
        create: {
          ticker: sym, name, kind,
          title: p.title || null,
          bio: incomingBio,
          bioSource: incomingBio ? p.bioSource || null : null,
          bioUrl: incomingBio ? p.bioUrl || null : null,
        },
        update: {
          title: p.title || existing?.title || null,
          ...(keepOldBio
            ? {}
            : incomingBio
              ? { bio: incomingBio, bioSource: p.bioSource || null, bioUrl: p.bioUrl || null }
              : {}),
        },
      });
    } catch (err) {
      console.warn(`personProfiles save(${sym}/${name}) failed:`, err.message);
      return; // one DB failure means they all fail; stop hammering
    }
  }
}

/// Last-known-good people for a ticker, newest-updated first.
export async function storedProfiles(ticker, kind) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return [];
  try {
    return await prisma.personProfile.findMany({
      where: { ticker: sym, ...(kind ? { kind } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
  } catch {
    return [];
  }
}
