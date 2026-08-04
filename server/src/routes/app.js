// What version of the Mac terminal members should be running.
//
// The updater's whole job is to make shipping stop being an event: build,
// publish a row, and every open copy offers the new one within the hour.
// That only works if the check is cheap and the answer is trustworthy, so
// this route is small and the hash is mandatory.

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isSuperAdminEmail } from '../middleware/auth.js';

const prisma = new PrismaClient();
const router = express.Router();

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

/**
 * Compare two semantic versions numerically.
 *
 * String comparison is the bug this exists to avoid: "0.10.0" < "0.9.0"
 * as text, so the tenth release would look older than the ninth and every
 * client would sit on a stale build believing it was current.
 */
export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newest live build, and whether the caller needs it.
 *
 * `?current=` is what the app has installed. The comparison happens HERE
 * rather than in the client so that a broken client can still be told it
 * is broken — a version check the old build performs is a version check
 * the old build can get wrong.
 */
router.get('/latest', async (req, res) => {
  try {
    const rows = await prisma.appRelease.findMany({
      where: { live: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    if (!rows.length) return res.json({ available: false, reason: 'No published build.' });

    // Newest by VERSION, not by row order: a hotfix for an older line can
    // be published after a newer build and must not become "latest".
    const latest = rows.reduce((best, r) => (newer(r.version, best.version) ? r : best), rows[0]);
    const current = String(req.query.current || '').trim();
    const behind = SEMVER.test(current) ? newer(latest.version, current) : true;

    res.json({
      available: behind,
      current: current || null,
      version: latest.version,
      url: latest.url,
      sha256: latest.sha256,
      bytes: latest.bytes,
      notes: latest.notes,
      // Any build between what they have and the newest that was marked
      // mandatory makes this update non-optional — skipping the middle of
      // a chain must not skip the reason the chain existed.
      mandatory: rows.some(
        (r) => r.mandatory && newer(r.version, current || '0.0.0') && !newer(r.version, latest.version),
      ),
    });
  } catch (err) {
    console.error('app/latest failed:', err.message);
    res.status(500).json({ error: 'Could not check for updates' });
  }
});

/// Publish a build. Super admin only: this hands every member's machine a
/// URL and tells it to run what comes back.
router.post('/releases', async (req, res) => {
  if (!isSuperAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  const { version, url, sha256, bytes, notes, mandatory } = req.body || {};
  if (!SEMVER.test(String(version || ''))) {
    return res.status(400).json({ error: 'version must be x.y.z' });
  }
  if (!SHA256.test(String(sha256 || ''))) {
    // Refused rather than defaulted. An updater that will install an
    // unverified download is a remote-code-execution hole with a
    // friendly button on it.
    return res.status(400).json({ error: 'sha256 must be a 64-character hex digest' });
  }
  if (!/^https:\/\//i.test(String(url || ''))) {
    return res.status(400).json({ error: 'url must be https' });
  }
  try {
    const row = await prisma.appRelease.upsert({
      where: { version },
      create: { version, url, sha256: String(sha256).toLowerCase(), bytes: bytes ?? null, notes: notes ?? null, mandatory: !!mandatory },
      update: { url, sha256: String(sha256).toLowerCase(), bytes: bytes ?? null, notes: notes ?? null, mandatory: !!mandatory, live: true },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('app/releases failed:', err.message);
    res.status(500).json({ error: 'Could not publish the release' });
  }
});

/// Every build ever offered, so a withdrawal leaves a trace.
router.get('/releases', async (req, res) => {
  if (!isSuperAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  res.json(await prisma.appRelease.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
});

/// Pull a build without deleting the record of it.
router.post('/releases/:version/withdraw', async (req, res) => {
  if (!isSuperAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  try {
    res.json(await prisma.appRelease.update({
      where: { version: req.params.version },
      data: { live: false },
    }));
  } catch {
    res.status(404).json({ error: 'No such version' });
  }
});

export default router;
