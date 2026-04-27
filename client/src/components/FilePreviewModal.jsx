import { useEffect, useState } from 'react';
import { X, ExternalLink, Download, Loader2 } from 'lucide-react';
import { API_BASE } from '../api/client.js';
import {
  isManagedFile,
  extractItemId,
  downloadFile,
} from '../api/fileHelpers.js';

// In-app PDF / file preview. Two paths:
//
//   onedrive:ITEM_ID — fetched from /api/files/:id with the user's JWT,
//                      turned into a blob URL, embedded so it never
//                      leaves the page. Always works for PDFs.
//
//   http(s)://...    — embedded directly via <iframe>. Works for sites
//                      that don't set X-Frame-Options: DENY (Google
//                      Drive's preview URLs do work). Falls back to an
//                      "Open in new tab" button if the iframe fails.
//
// `filename` is used for the download fallback so the saved file has a
// sensible name. `title` is the modal header. Both optional.
export default function FilePreviewModal({ url, title, filename, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);

  const managed = isManagedFile(url);

  useEffect(() => {
    if (!url || !managed) return;
    let cancelled = false;
    let revoke = null;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const id = extractItemId(url);
        const token = localStorage.getItem('gcig_token');
        const res = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          let msg = `Preview failed (${res.status})`;
          try {
            const body = await res.json();
            if (body?.error) msg = body.error;
          } catch {
            /* not JSON */
          }
          throw new Error(msg);
        }
        const blob = await res.blob();
        if (cancelled) return;
        const obj = URL.createObjectURL(blob);
        revoke = obj;
        setBlobUrl(obj);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Preview failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [url, managed]);

  if (!url) return null;

  // External URL we'll iframe directly. Google Drive `/preview` URLs work;
  // raw `/view` URLs sometimes block; we leave it to the user's fallback.
  const externalEmbedUrl = !managed ? toEmbedUrl(url) : null;

  async function handleDownload() {
    try {
      await downloadFile(url, filename);
    } catch (err) {
      setLoadError(err.message || 'Download failed');
    }
  }

  function handleOpenExternal() {
    if (managed) {
      // For managed files there's no "external" page — fall back to
      // downloading.
      handleDownload();
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-center bg-navy/70 md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-white shadow-xl md:h-[90vh] md:max-h-[90vh] md:max-w-5xl md:overflow-hidden md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-navy-50 px-4 py-3 md:px-5 md:py-4">
          <h2 className="truncate text-base font-semibold text-navy md:text-lg">
            {title || filename || 'Document preview'}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="hidden items-center gap-1 rounded-lg border border-navy-100 px-2.5 py-1 text-xs font-semibold text-navy hover:bg-navy-50 sm:inline-flex"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
            <button
              onClick={handleOpenExternal}
              className="hidden items-center gap-1 rounded-lg border border-navy-100 px-2.5 py-1 text-xs font-semibold text-navy hover:bg-navy-50 sm:inline-flex"
              title="Open in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {managed ? 'Download' : 'Open'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-navy-400 hover:bg-navy-50 hover:text-navy"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-navy-50">
          {managed ? (
            loading ? (
              <div className="flex h-full items-center justify-center text-sm text-navy-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading preview…
              </div>
            ) : loadError ? (
              <PreviewError
                message={loadError}
                onDownload={handleDownload}
              />
            ) : blobUrl ? (
              // <embed> uses the browser's built-in PDF viewer — works
              // everywhere desktop Chrome/Safari/Firefox + iOS/Android.
              <embed
                src={blobUrl}
                type="application/pdf"
                className="h-full w-full"
              />
            ) : null
          ) : (
            <iframe
              src={externalEmbedUrl}
              title={title || 'Document preview'}
              className="h-full w-full"
              // We can't reliably detect X-Frame-Options block from JS,
              // so the bottom strip below offers the new-tab fallback.
            />
          )}
        </div>

        {/* Mobile / fallback action strip. Always visible on small screens
            (where the header buttons are hidden) and on external embeds
            in case the iframe got blocked. */}
        <div className="flex flex-wrap gap-2 border-t border-navy-50 px-4 py-2 sm:hidden">
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 text-xs font-semibold text-navy"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          <button
            onClick={handleOpenExternal}
            className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 text-xs font-semibold text-navy"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {managed ? 'Save copy' : 'Open in new tab'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewError({ message, onDownload }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-red-700">{message}</p>
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-1 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy"
      >
        <Download className="h-3.5 w-3.5" />
        Try downloading instead
      </button>
    </div>
  );
}

// Best-effort URL massage so common share links actually render in an
// iframe. Google Drive's "/view" routes redirect to the gated UI which
// blocks framing; "/preview" allows it. Other providers we hand back
// untouched and trust the iframe attempt.
function toEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('drive.google.com')) {
      // /file/d/<id>/view → /file/d/<id>/preview
      u.pathname = u.pathname.replace(/\/view\b.*/, '/preview');
      return u.toString();
    }
    if (u.hostname.endsWith('docs.google.com')) {
      // /presentation/d/<id>/edit → /presentation/d/<id>/preview
      u.pathname = u.pathname.replace(/\/edit\b.*/, '/preview');
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}
