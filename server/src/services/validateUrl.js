// Guard against XSS via javascript: / data: / vbscript: URIs when a user
// supplies a link that we render as <a href="...">. Allow only plain
// http(s) URLs — or our internal `onedrive:ITEM_ID` scheme, which
// isn't a real URL but is a safe opaque reference we resolve server-
// side before anything hits <a href>.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Managed-file references follow `onedrive:<alphanumeric+-_!>` —
// Microsoft Graph item IDs contain letters, digits, dashes, and !.
const MANAGED_REF_RE = /^onedrive:[A-Za-z0-9!_\-.]+$/;

export function isSafeHttpUrl(raw) {
  if (!raw) return true; // empty/null is fine — caller decides if it's required
  const trimmed = String(raw).trim();
  if (MANAGED_REF_RE.test(trimmed)) return true;
  try {
    const u = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

export function assertSafeHttpUrl(raw, fieldName = 'URL') {
  if (!isSafeHttpUrl(raw)) {
    const err = new Error(
      `${fieldName} must be a valid http:// or https:// link (or an uploaded file)`
    );
    err.status = 400;
    throw err;
  }
}
