import prisma from '../db.js';

// OneDrive (Microsoft Graph) file storage. Single-account model: one
// super admin runs the OAuth flow once, the refresh token gets stored
// in FileProviderToken, and every member's upload lands in that admin's
// OneDrive inside a configurable folder (default: GriffinFund/Uploads).
//
// Why single-account: the app owns the files, not individual members.
// When a member leaves the club we don't lose their pitch deck. Uniform
// storage for audit + discovery + search.
//
// Auth flow:
//   1. Super admin hits GET /api/files/oauth/start
//   2. Server redirects to Microsoft authorize URL with CSRF state
//   3. User consents, Microsoft redirects back with ?code=...
//   4. Server POSTs the code to Microsoft's token endpoint, gets
//      access_token + refresh_token, saves to DB.
//   5. From here on: every upload calls getAccessToken() which
//      refreshes if the access token is close to expiry.

const AUTHORITY = 'https://login.microsoftonline.com/common';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite offline_access User.Read';
const SMALL_UPLOAD_MAX = 4 * 1024 * 1024; // 4 MB — above this, use resumable upload session

function requireConfig() {
  const id = process.env.ONEDRIVE_CLIENT_ID;
  const secret = process.env.ONEDRIVE_CLIENT_SECRET;
  const redirect = process.env.ONEDRIVE_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    const missing = [
      !id && 'ONEDRIVE_CLIENT_ID',
      !secret && 'ONEDRIVE_CLIENT_SECRET',
      !redirect && 'ONEDRIVE_REDIRECT_URI',
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(`OneDrive not configured — set: ${missing}`);
  }
  return { id, secret, redirect };
}

export function isConfigured() {
  return !!(
    process.env.ONEDRIVE_CLIENT_ID &&
    process.env.ONEDRIVE_CLIENT_SECRET &&
    process.env.ONEDRIVE_REDIRECT_URI
  );
}

// Build the Microsoft authorize URL. `state` is a random CSRF nonce
// the caller stores + verifies when Microsoft redirects back.
export function getAuthorizeUrl(state) {
  const { id, redirect } = requireConfig();
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirect,
    response_mode: 'query',
    scope: SCOPES,
    state,
    // Force the consent screen so Microsoft issues a refresh_token
    // every time — without this, a re-auth can return only an access
    // token and we lose long-term access.
    prompt: 'consent',
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function postForm(body) {
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Microsoft token endpoint ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

// Fetch the authenticated user's email so we can display which
// OneDrive account the tokens are bound to in the admin UI.
async function fetchMe(accessToken) {
  try {
    const r = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.userPrincipalName || data.mail || null;
  } catch {
    return null;
  }
}

async function saveTokens(tokens, prevRefresh = null) {
  // Some refresh responses omit a new refresh_token — in that case
  // keep the existing one (refresh tokens from Microsoft typically
  // rotate but not always).
  const refreshToken = tokens.refresh_token || prevRefresh;
  if (!refreshToken) {
    throw new Error('Missing refresh_token from Microsoft — cannot persist session');
  }
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  const email = await fetchMe(tokens.access_token);
  await prisma.fileProviderToken.upsert({
    where: { provider: 'onedrive' },
    create: {
      provider: 'onedrive',
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      scope: tokens.scope || null,
      email,
    },
    update: {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      scope: tokens.scope || null,
      email,
    },
  });
}

export async function exchangeCodeForTokens(code) {
  const { id, secret, redirect } = requireConfig();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    code,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    scope: SCOPES,
  });
  const tokens = await postForm(body);
  await saveTokens(tokens);
  return tokens;
}

async function loadTokens() {
  return prisma.fileProviderToken.findUnique({ where: { provider: 'onedrive' } });
}

// Returns a currently-valid access token, refreshing if within 30s
// of expiry (or already expired). Throws if the provider isn't
// authorized yet.
export async function getAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) {
    const err = new Error('OneDrive is not authorized. A super admin must connect it first.');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }
  const now = Date.now();
  if (tokens.expiresAt.getTime() > now + 30_000) {
    return tokens.accessToken;
  }
  const { id, secret } = requireConfig();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES,
  });
  const fresh = await postForm(body);
  await saveTokens(fresh, tokens.refreshToken);
  return fresh.access_token;
}

export async function getStatus() {
  const tokens = await loadTokens();
  if (!tokens) {
    return { connected: false, configured: isConfigured() };
  }
  return {
    connected: true,
    configured: true,
    email: tokens.email,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    updatedAt: tokens.updatedAt,
    folder: process.env.ONEDRIVE_FOLDER || 'GriffinFund/Uploads',
  };
}

// Disconnect — wipes the stored tokens. Super admin runs this if they
// want to re-authorize or switch accounts.
export async function disconnect() {
  await prisma.fileProviderToken.deleteMany({ where: { provider: 'onedrive' } });
}

// ── Uploads ──────────────────────────────────────────────────────────

function encodeGraphPath(segments) {
  // Each segment encoded individually so slashes between folders stay
  // literal, but the filename's special chars become %xx.
  return segments.map(encodeURIComponent).join('/');
}

// Upload a buffer to OneDrive at `{folder}/{filename}`. Uses the simple
// content-PUT for small files, or an upload session for files >4 MB.
// Returns the Microsoft Graph DriveItem (contains id, name, size, webUrl).
export async function uploadFile({ buffer, filename, contentType }) {
  const token = await getAccessToken();
  const folder = process.env.ONEDRIVE_FOLDER || 'GriffinFund/Uploads';
  const folderSegments = folder.split('/').filter(Boolean);
  const fullSegments = [...folderSegments, filename];
  const pathEncoded = encodeGraphPath(fullSegments);

  if (buffer.length <= SMALL_UPLOAD_MAX) {
    const url = `${GRAPH}/me/drive/root:/${pathEncoded}:/content?@microsoft.graph.conflictBehavior=rename`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: buffer,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OneDrive upload failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  // Resumable upload session for larger files. Chunk size must be a
  // multiple of 320 KiB per Graph docs; 5 MB is a safe standard.
  const sessionUrl = `${GRAPH}/me/drive/root:/${pathEncoded}:/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'rename' },
    }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text().catch(() => '');
    throw new Error(
      `OneDrive upload session failed (${sessionRes.status}): ${text.slice(0, 300)}`
    );
  }
  const { uploadUrl } = await sessionRes.json();
  const CHUNK = 5 * 1024 * 1024;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, buffer.length);
    const chunk = buffer.slice(offset, end);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${buffer.length}`,
      },
      body: chunk,
    });
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Chunk upload failed (${res.status}) at ${offset}-${end - 1}: ${text.slice(0, 300)}`
      );
    }
    if (res.status === 200 || res.status === 201) {
      return res.json();
    }
    // 202 Accepted → more chunks expected
  }
  throw new Error('Upload session finished without a final response');
}

// Stream a file from OneDrive to an Express response. Proxies the
// Content-Type and Content-Disposition so the browser handles
// inline preview / download correctly.
//
// `options.inline` is the opt-in for the in-app PDF modal. When set
// AND the upstream content-type is application/pdf, the disposition
// header is rewritten to `inline; filename="…"` so the browser
// previews instead of saves. The original filename is taken from the
// upstream Content-Disposition; if Graph didn't give us one we fall
// back to a bare `inline` (still valid per RFC 6266). The default
// (no inline flag) preserves Graph's attachment behavior 1:1 — every
// existing download call site is unaffected.
//
// Non-PDF responses never get an inline override even when the flag
// is set: silently inlining a PPTX would surface a download prompt in
// some browsers and an unreadable XML blob in others. Honesty wins —
// embedding falls back to the modal's "open in new tab" panel.
export async function streamDownload(itemId, res, options = {}) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Download failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  const cl = r.headers.get('content-length');
  if (cl) res.setHeader('Content-Length', cl);
  const upstreamCd = r.headers.get('content-disposition');
  const wantInline =
    options.inline === true && /^application\/pdf\b/i.test(ct);
  if (wantInline) {
    // Reuse the filename Graph reported (parsed loosely — `filename=`
    // or `filename*=` UTF-8). If neither is present we still emit
    // `inline` alone so the browser knows to preview.
    const filename = parseFilename(upstreamCd);
    res.setHeader(
      'Content-Disposition',
      filename ? `inline; filename="${filename}"` : 'inline'
    );
  } else if (upstreamCd) {
    res.setHeader('Content-Disposition', upstreamCd);
  }

  const reader = r.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

// Best-effort Content-Disposition filename extractor. Looks for a
// quoted `filename="…"` first, then an unquoted `filename=…`, then a
// URL-encoded `filename*=UTF-8''…`. Returns null when nothing's
// usable — callers should treat that as "emit `inline` with no name".
function parseFilename(header) {
  if (!header) return null;
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = header.match(/filename=([^;]+)/i);
  if (bare) return bare[1].trim();
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  return null;
}

// Fetch the file's bytes into memory. Used for email attachments where
// we need the buffer + filename in one shot. Don't use this for large
// downloads to a client — use streamDownload instead so we don't buffer
// 25 MB in Node memory just to forward it.
export async function downloadBuffer(itemId) {
  const token = await getAccessToken();
  const [contentRes, meta] = await Promise.all([
    fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    }),
    getMetadata(itemId),
  ]);
  if (!contentRes.ok) {
    const text = await contentRes.text().catch(() => '');
    throw new Error(`Download failed (${contentRes.status}): ${text.slice(0, 300)}`);
  }
  const arrayBuf = await contentRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    filename: meta.name,
    contentType: contentRes.headers.get('content-type') || 'application/octet-stream',
  };
}

/// List what is inside a folder, by path or by item id.
///
/// Read-only and additive: nothing else in this service could enumerate
/// the drive, only fetch an item we already had an id for, so importing
/// an existing folder tree was impossible without it.
export async function listChildren({ path, itemId } = {}) {
  const token = await getAccessToken();
  const base = itemId
    ? `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/children`
    : path
    ? `${GRAPH}/me/drive/root:/${encodeGraphPath(String(path).split('/').filter(Boolean))}:/children`
    : `${GRAPH}/me/drive/root/children`;
  const out = [];
  let url = `${base}?$top=200&$select=id,name,size,folder,file,webUrl,lastModifiedDateTime`;
  // Graph pages at 200. A research folder with three hundred PDFs in it
  // would silently come back truncated without this.
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    for (const it of body.value || []) {
      out.push({
        id: it.id,
        name: it.name,
        size: it.size ?? null,
        isFolder: !!it.folder,
        childCount: it.folder?.childCount ?? null,
        modified: it.lastModifiedDateTime ?? null,
      });
    }
    url = body['@odata.nextLink'] || null;
  }
  return out;
}

export async function getMetadata(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Metadata fetch failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return r.json();
}

// ── In-app preview ───────────────────────────────────────────────────
//
// We render previews ourselves rather than handing the browser an
// Office Online embed URL. That isn't a preference — Graph's
// `POST /me/drive/items/{id}/preview` action does not exist for this
// account. Microsoft's reference is explicit: "The preview action is
// currently only available on SharePoint and OneDrive for Business,"
// and its permissions table lists delegated personal-Microsoft-account
// access as "Not supported." Our storage is a single consumer OneDrive
// (the OAuth authority is /common), so every call came back
// `400 invalidRequest — API not found`. No retry or reconnect fixes
// that; the route simply isn't served for consumer drives.
//
// So: fetch the bytes with our own credentials and stream them to the
// member. PDFs go straight through. Office documents are converted by
// Graph on the way out via `?format=pdf`, which *is* supported on
// personal accounts. Images and plain text pass through as themselves.
// Everything else is refused honestly so the client can offer a
// download instead of painting an empty frame.

// Source extensions Graph will convert to PDF. Taken from the format
// table in the "Convert to other formats" reference — trimmed to the
// types our upload allowlist actually admits, plus the legacy Office
// formats old decks still arrive in.
const PDF_CONVERTIBLE = new Set([
  'doc', 'docx', 'dot', 'dotx', 'dotm',
  'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx',
  'xls', 'xlsx', 'xlsm',
  'odt', 'odp', 'ods',
  'rtf', 'epub', 'htm', 'html', 'md', 'markdown', 'msg', 'eml',
  'tif', 'tiff',
]);

// Types a browser renders natively in an iframe, so conversion would
// only cost us latency and fidelity.
const PASSTHROUGH_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
};

function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide how a file would preview without fetching a byte of it.
 * Lets the caller reject unsupported types up front — a fast 415 beats
 * streaming half a ZIP into an iframe.
 *
 * @returns {{mode: 'passthrough'|'convert'|'unsupported', contentType: string|null, ext: string}}
 */
export function previewPlan(filename) {
  const ext = extensionOf(filename);
  if (PASSTHROUGH_TYPES[ext]) {
    return { mode: 'passthrough', contentType: PASSTHROUGH_TYPES[ext], ext };
  }
  if (PDF_CONVERTIBLE.has(ext)) {
    return { mode: 'convert', contentType: 'application/pdf', ext };
  }
  return { mode: 'unsupported', contentType: null, ext };
}

// Copy a Graph response body into an Express response. Kept separate
// from streamDownload because the preview path overrides the headers
// wholesale (we know the type better than Graph does after a format
// conversion) instead of proxying them through.
async function pipeBody(upstream, res) {
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

/**
 * Stream a file to `res` shaped for inline display in an iframe.
 * Converts Office documents to PDF on the way through.
 *
 * Throws with `code = 'UNSUPPORTED_PREVIEW'` for types we can't render,
 * so the route can answer 415 and the client can fall back to download.
 *
 * @param {string} itemId - OneDrive item id
 * @param {object} res - Express response
 * @param {object} meta - Optional pre-fetched Graph metadata, to skip a round trip
 */
export async function streamPreview(itemId, res, meta = null) {
  const item = meta || (await getMetadata(itemId));
  const plan = previewPlan(item?.name);
  if (plan.mode === 'unsupported') {
    const err = new Error(
      `Can't preview ${plan.ext ? `.${plan.ext}` : 'this'} files inline — download it to view.`
    );
    err.code = 'UNSUPPORTED_PREVIEW';
    throw err;
  }

  const token = await getAccessToken();
  const base = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`;
  const url = plan.mode === 'convert' ? `${base}?format=pdf` : base;

  // Graph answers a conversion with 302 → a short-lived preauthenticated
  // URL on a *.files.1drv.com host. undici follows it and drops the
  // Authorization header across the origin change, which is exactly
  // right: that URL carries its own grant.
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const verb = plan.mode === 'convert' ? 'PDF conversion' : 'Preview fetch';
    throw new Error(`${verb} failed (${r.status}): ${text.slice(0, 300)}`);
  }

  res.setHeader('Content-Type', plan.contentType);
  const cl = r.headers.get('content-length');
  if (cl) res.setHeader('Content-Length', cl);
  // Name the download after the source file so a "save" from inside the
  // browser's PDF viewer lands with a sensible filename. Converted docs
  // get a .pdf suffix because that's genuinely what the bytes are now.
  const stem = String(item?.name || 'document').replace(/\.[^.]+$/, '');
  const outName =
    plan.mode === 'convert' ? `${stem}.pdf` : item?.name || 'document';
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${outName.replace(/["\\]/g, '')}"`
  );
  // The URL already carries an expiry in its signature; tell shared
  // caches to keep out of it regardless.
  res.setHeader('Cache-Control', 'private, no-store');

  await pipeBody(r, res);
}

export async function deleteFile(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 means already gone — idempotent.
  if (!r.ok && r.status !== 404) {
    const text = await r.text().catch(() => '');
    throw new Error(`Delete failed (${r.status}): ${text.slice(0, 300)}`);
  }
}
