// What version of the Mac terminal members should be running.
//
// The updater's whole job is to make shipping stop being an event: build,
// publish a row, and every open copy offers the new one within the hour.
// That only works if the check is cheap and the answer is trustworthy, so
// this route is small and the hash is mandatory.

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isSuperAdminEmail } from '../middleware/auth.js';
import { streamDownload, uploadFile } from '../services/oneDriveStorage.js';

const prisma = new PrismaClient();
const router = express.Router();

const SEMVER = /^\d+\.\d+\.\d+$/;
/// Where clients reach us. Overridable so a staging deploy does not hand
/// members a download URL pointing at production.
const PUBLIC_API = (process.env.PUBLIC_API_URL || 'https://gcig-api.onrender.com/api').replace(/\/$/, '');
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

/**
 * The build itself, for a member who is signed in.
 *
 * Members only, which is the whole reason this is a route rather than a
 * link to a public bucket. The bytes live in OneDrive beside the club's
 * research; this streams them through our auth boundary so the download
 * needs the same login the terminal does.
 *
 * The Mac updater hits this too, with its session token, so one path
 * serves both the first install and every update after it.
 */
router.get('/download', async (req, res) => {
  try {
    const rows = await prisma.appRelease.findMany({
      where: { live: true, fileRef: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    if (!rows.length) return res.status(404).json({ error: 'No build published yet.' });
    const wanted = String(req.query.version || '').trim();
    const pick = wanted
      ? rows.find((r) => r.version === wanted)
      : rows.reduce((best, r) => (newer(r.version, best.version) ? r : best), rows[0]);
    if (!pick) return res.status(404).json({ error: `No build ${wanted}.` });

    const itemId = String(pick.fileRef).replace(/^onedrive:/, '');
    res.setHeader('Content-Disposition',
      `attachment; filename="GriffinTerminal-${pick.version}.zip"`);
    await streamDownload(itemId, res, { contentType: 'application/zip' });
  } catch (err) {
    console.error('app/download failed:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Could not fetch the build.' });
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

/**
 * Upload a built zip and publish it in one call.
 *
 * Super admin only. Takes the raw bytes, stores them in OneDrive, and
 * writes the release row pointing at them with a hash the uploader
 * computed. The hash is NOT recomputed here on purpose: it is the
 * publisher's assertion about the artifact they built and notarized, and
 * a server that recomputes it would happily bless whatever it received.
 */
router.post('/releases/:version/upload', async (req, res) => {
  if (!isSuperAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  const version = String(req.params.version || '');
  if (!SEMVER.test(version)) return res.status(400).json({ error: 'version must be x.y.z' });
  const sha256 = String(req.query.sha256 || '').toLowerCase();
  if (!SHA256.test(sha256)) return res.status(400).json({ error: 'sha256 query param required' });

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) return res.status(400).json({ error: 'empty body' });
      const up = await uploadFile({
        buffer,
        filename: `GriffinTerminal-${version}.zip`,
        contentType: 'application/zip',
      });
      const ref = up?.id ? `onedrive:${up.id}` : null;
      if (!ref) return res.status(502).json({ error: 'upload did not return an item id' });
      const row = await prisma.appRelease.upsert({
        where: { version },
        // The URL is our own members-only route, not a OneDrive link.
        // A Graph URL would be anonymous and non-expiring, which is the
        // exact thing the signed-stream pattern exists to avoid.
        create: { version, url: `${PUBLIC_API}/app/download?version=${version}`,
                  sha256, bytes: buffer.length, fileRef: ref },
        update: { url: `${PUBLIC_API}/app/download?version=${version}`,
                  sha256, bytes: buffer.length, fileRef: ref, live: true },
      });
      res.status(201).json(row);
    } catch (err) {
      console.error('app upload failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });
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
