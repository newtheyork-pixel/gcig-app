import api, { API_BASE } from './client.js';

// Helpers for working with file references stored in the app's
// existing URL columns (Report.fileUrl, Pitch.slideshowUrl, etc.).
//
// We use a small scheme convention so legacy external links + new
// OneDrive-hosted files coexist without breaking older rows:
//
//   `onedrive:ITEM_ID`       → hosted in OneDrive; download via our
//                              authenticated /api/files endpoint.
//   `http(s)://...`          → external link (Google Drive, Dropbox,
//                              whatever); opens in a new tab.
//
// Callers should prefer these helpers over hand-rolling URL logic so
// we only have one place to update if the scheme ever changes.

export function isManagedFile(url) {
  return typeof url === 'string' && url.startsWith('onedrive:');
}

export function extractItemId(url) {
  if (!isManagedFile(url)) return null;
  return url.slice('onedrive:'.length);
}

// Fetch {id, name, size, webUrl} for a managed file so the UI can
// display the filename without hardcoding it. Returns null on
// failures or for non-managed URLs.
export async function fetchFileMetadata(url) {
  const id = extractItemId(url);
  if (!id) return null;
  try {
    const { data } = await api.get(`/files/${encodeURIComponent(id)}/info`);
    return data;
  } catch {
    return null;
  }
}

// Trigger a download. Handles both managed (onedrive:) and plain URL
// values. Managed files can't just be `<a href>`-linked because the
// download endpoint needs an Authorization header — so we fetch with
// auth, build a blob URL, and programmatically click a hidden anchor.
export async function downloadFile(url, filename) {
  if (!isManagedFile(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const id = extractItemId(url);
  const token = localStorage.getItem('gcig_token');
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick to let the browser start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
