import { Router, raw } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { uploadFile, streamDownload } from '../services/oneDriveStorage.js';

const prisma = new PrismaClient();
const router = Router();

// WebDAV, so the research files appear in Finder under Locations.
//
// The thing Thomas asked for is an entry in the Finder SIDEBAR called
// Griffin Fund that you click and browse. A folder dragged there lands in
// Favorites, not Locations — Locations holds volumes and File Providers,
// which is why syncing a folder to disk was never going to produce it.
//
// A File Provider extension needs an App Group entitlement and a
// provisioning profile, which needs an Apple ID in Xcode, which will not
// launch on this machine. A mounted volume needs none of that: macOS has
// shipped a WebDAV client since forever, mount_webdav is in /sbin, and a
// mounted share appears in Locations under whatever name it is given.
//
// The tree is the project structure, not a copy of it:
//
//   /dav/                       every project, as a folder per ticker
//   /dav/LISN/                  the artifact folders
//   /dav/LISN/model/            the files
//   /dav/LISN/model/DCF.xlsx    the bytes, streamed from OneDrive
//
// Artifact titles already carry their path, so no migration was needed to
// give this a shape: model/Lindt DCF.xlsx has always meant a folder and a
// file, and this is the first thing to read it that way.
//
// Auth is Basic, because that is what the macOS WebDAV client speaks. The
// password is the member's own session token, which Keychain then stores
// once. No new credential exists: a token that works here is a token that
// already worked everywhere else, and revoking a session revokes the
// mount with it.

const DAV_HEADERS = {
  DAV: '1, 2',
  'MS-Author-Via': 'DAV',
  Allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK',
};

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="Griffin Fund"');
  return res.status(401).end();
}

/// Basic auth carrying our own JWT as the password.
function davAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return unauthorized(res);
  let token = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    token = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return unauthorized(res);
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return unauthorized(res);
  }
  next();
}

router.use(davAuth);
// Finder sends bodies on PROPFIND and PUT. Raw, because a PUT body is a
// file and express.json would try to parse a spreadsheet.
router.use(raw({ type: () => true, limit: '200mb' }));

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/// One <response> element. Finder needs displayname, resourcetype and,
/// for files, a length — a listing without lengths shows every file as
/// zero bytes and Finder refuses to open them.
function entry(href, { isDir, size = 0, modified = new Date(), name }) {
  const when = new Date(modified).toUTCString();
  return `<D:response>
  <D:href>${xmlEscape(href)}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${xmlEscape(name)}</D:displayname>
      <D:getlastmodified>${when}</D:getlastmodified>
      ${isDir
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : `<D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength>`}
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

function multistatus(res, entries) {
  res.status(207);
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${entries.join('\n')}
</D:multistatus>`);
}

/// Split a DAV path into ticker, folder and filename.
function parse(rawPath) {
  const parts = decodeURIComponent(rawPath).split('/').filter(Boolean);
  return { ticker: parts[0] || null, rest: parts.slice(1) };
}

async function projects() {
  return prisma.researchProject.findMany({
    select: { id: true, ticker: true, name: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
}

async function artifactsFor(ticker) {
  const p = await prisma.researchProject.findFirst({
    where: { ticker: { equals: ticker, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!p) return null;
  const rows = await prisma.researchArtifact.findMany({
    where: { projectId: p.id, fileRef: { not: null } },
    select: { id: true, title: true, filename: true, fileRef: true, updatedAt: true },
  });
  return { projectId: p.id, rows };
}

router.options('*', (_req, res) => res.set(DAV_HEADERS).status(200).end());

// Finder locks before it writes. Nothing here is concurrent enough to
// need real locks, but refusing the verb makes the volume read-only in
// Finder's eyes, so this issues a token and forgets it.
router.lock('*', (req, res) => {
  res.set({ ...DAV_HEADERS, 'Lock-Token': '<opaquelocktoken:griffin>' });
  res.status(200).send(`<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>opaquelocktoken:griffin</D:href></D:locktoken>
</D:activelock></D:lockdiscovery></D:prop>`);
});
router.unlock('*', (_req, res) => res.status(204).end());

router.propfind('*', async (req, res) => {
  const depth = req.headers.depth === '0' ? 0 : 1;
  const base = req.baseUrl;
  const { ticker, rest } = parse(req.path);
  try {
    // The root: one folder per project.
    if (!ticker) {
      const list = await projects();
      const out = [entry(`${base}/`, { isDir: true, name: 'Griffin Fund' })];
      if (depth === 1) {
        for (const p of list) {
          if (!p.ticker) continue;
          out.push(entry(`${base}/${encodeURIComponent(p.ticker)}/`,
                         { isDir: true, name: p.ticker, modified: p.updatedAt }));
        }
      }
      return multistatus(res, out);
    }

    const data = await artifactsFor(ticker);
    if (!data) return res.status(404).end();
    const prefix = rest.join('/');
    const here = `${base}/${encodeURIComponent(ticker)}${prefix ? '/' + rest.map(encodeURIComponent).join('/') : ''}`;

    // A file, addressed directly.
    const exact = data.rows.find((r) => r.title === prefix);
    if (exact) {
      return multistatus(res, [entry(here, {
        isDir: false, name: (exact.title.split('/').pop()),
        size: Number(req.headers['x-known-size'] || 0), modified: exact.updatedAt,
      })]);
    }

    const out = [entry(here + '/', { isDir: true, name: rest.length ? rest[rest.length - 1] : ticker })];
    if (depth === 1) {
      const seen = new Set();
      for (const r of data.rows) {
        if (prefix && !r.title.startsWith(prefix + '/')) continue;
        const tail = prefix ? r.title.slice(prefix.length + 1) : r.title;
        const cut = tail.indexOf('/');
        if (cut >= 0) {
          const dir = tail.slice(0, cut);
          if (seen.has(dir)) continue;
          seen.add(dir);
          out.push(entry(`${here}/${encodeURIComponent(dir)}/`, { isDir: true, name: dir }));
        } else {
          out.push(entry(`${here}/${encodeURIComponent(tail)}`, {
            isDir: false, name: tail, size: 1, modified: r.updatedAt,
          }));
        }
      }
    }
    return multistatus(res, out);
  } catch (err) {
    console.error('dav propfind failed:', err.message);
    res.status(500).end();
  }
});

router.get('*', async (req, res) => {
  const { ticker, rest } = parse(req.path);
  if (!ticker || !rest.length) return res.status(404).end();
  const data = await artifactsFor(ticker);
  const row = data?.rows.find((r) => r.title === rest.join('/'));
  if (!row) return res.status(404).end();
  const itemId = String(row.fileRef).replace('onedrive:', '');
  try {
    await streamDownload(itemId, res);
  } catch (err) {
    console.error('dav get failed:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
});

router.put('*', async (req, res) => {
  const { ticker, rest } = parse(req.path);
  if (!ticker || !rest.length) return res.status(400).end();
  const title = rest.join('/');
  const name = rest[rest.length - 1];
  // Finder writes its own bookkeeping files into any volume it opens.
  // Storing them would put .DS_Store in the project's file list.
  if (name.startsWith('.') || name.startsWith('~$')) return res.status(201).end();
  const data = await artifactsFor(ticker);
  if (!data) return res.status(404).end();
  try {
    const stored = await uploadFile({
      buffer: req.body,
      filename: name,
      contentType: req.headers['content-type'] || 'application/octet-stream',
    });
    if (!stored?.id) return res.status(502).end();
    const existing = data.rows.find((r) => r.title === title);
    if (existing) {
      await prisma.researchArtifact.update({
        where: { id: existing.id },
        data: { fileRef: `onedrive:${stored.id}`, filename: name },
      });
    } else {
      await prisma.researchArtifact.create({
        data: {
          projectId: data.projectId,
          kind: 'document',
          title,
          filename: name,
          fileRef: `onedrive:${stored.id}`,
          uploadedById: req.user?.id ?? null,
        },
      });
    }
    res.status(201).end();
  } catch (err) {
    console.error('dav put failed:', err.message);
    res.status(500).end();
  }
});

// Creating a folder is a no-op that succeeds. Folders here are implied by
// the paths of the files in them, so an empty one has nothing to exist
// as — but failing the verb would make Finder refuse to create anything.
router.mkcol('*', (_req, res) => res.status(201).end());

export default router;
