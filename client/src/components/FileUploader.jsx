import { useEffect, useRef, useState } from 'react';
import { Upload, Link as LinkIcon, X, FileText, ExternalLink, Loader2 } from 'lucide-react';
import api from '../api/client.js';
import {
  isManagedFile,
  fetchFileMetadata,
} from '../api/fileHelpers.js';

// Reusable file picker + URL fallback input. One component for every
// "upload a file or paste a link" field in the app.
//
// Props:
//   value          string | null  — current stored reference
//                                   (onedrive:ITEM_ID or a plain URL)
//   onChange(ref)  function       — called with the new ref after
//                                   upload or paste
//   label          string         — field label shown above the input
//   required       boolean        — whether the field is required
//   hint           string         — helper text shown below (optional)
//
// Behavior:
//   - When value is empty: shows an "Upload file" button + a URL
//     text input. Picking a file uploads it and sets value to
//     `onedrive:ITEM_ID`. Typing in the URL input sets value directly.
//   - When value is a managed file: shows a compact chip with the
//     filename + a Remove (✕) button.
//   - When value is an external URL: shows the URL as an inline link
//     + a Remove button.

export default function FileUploader({
  value,
  onChange,
  label = 'File',
  required = false,
  hint = null,
}) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [metadata, setMetadata] = useState(null);
  const [localUrl, setLocalUrl] = useState(
    isManagedFile(value) ? '' : value || ''
  );

  // Resolve filename for managed files so the chip can read "pitch.pdf"
  // instead of a meaningless item id.
  useEffect(() => {
    let cancelled = false;
    if (isManagedFile(value)) {
      setMetadata(null);
      fetchFileMetadata(value).then((m) => {
        if (!cancelled) setMetadata(m);
      });
    } else {
      setMetadata(null);
    }
    // Keep the URL input in sync when value changes externally.
    if (!isManagedFile(value)) {
      setLocalUrl(value || '');
    } else {
      setLocalUrl('');
    }
    return () => {
      cancelled = true;
    };
  }, [value]);

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setProgress(0);
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post('/files/upload', form, {
        onUploadProgress: (evt) => {
          if (evt.total) {
            setProgress(Math.round((evt.loaded / evt.total) * 100));
          }
        },
      });
      onChange(data.ref);
      // Seed metadata so the chip can render immediately without a
      // second round trip.
      setMetadata({ id: data.itemId, name: data.name, size: data.size });
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      setProgress(0);
      // Reset input so picking the same file again re-triggers.
      e.target.value = '';
    }
  }

  function handleRemove() {
    onChange('');
    setMetadata(null);
    setLocalUrl('');
    setError('');
  }

  function handleUrlChange(e) {
    const next = e.target.value;
    setLocalUrl(next);
    onChange(next);
  }

  // ── Render: existing value (chip + remove) ────────────────────────
  if (value && !uploading) {
    const managed = isManagedFile(value);
    const displayName = managed
      ? metadata?.name || 'Loading file…'
      : value;
    return (
      <div>
        {label && (
          <label className="block text-sm font-medium text-navy">
            {label}
            {required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
        )}
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm">
          {managed ? (
            <FileText className="h-4 w-4 flex-shrink-0 text-gold" />
          ) : (
            <LinkIcon className="h-4 w-4 flex-shrink-0 text-navy-400" />
          )}
          <div className="min-w-0 flex-1 truncate">
            {managed ? (
              <span className="font-semibold text-navy">{displayName}</span>
            ) : (
              <a
                href={value}
                target="_blank"
                rel="noreferrer"
                className="text-navy underline decoration-navy-200 hover:decoration-gold"
              >
                {displayName}
              </a>
            )}
            {managed && metadata?.size != null && (
              <span className="ml-2 text-[11px] text-navy-400">
                {(metadata.size / 1024).toFixed(0)} KB
              </span>
            )}
          </div>
          {!managed && (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className="text-navy-400 hover:text-navy"
              title="Open link"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={handleRemove}
            aria-label="Remove file"
            className="text-navy-300 transition hover:text-red-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {hint && <p className="mt-1 text-xs text-navy-400">{hint}</p>}
      </div>
    );
  }

  // ── Render: empty (picker + URL input) ────────────────────────────
  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-navy">
          {label}
          {required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <button
          type="button"
          onClick={pickFile}
          disabled={uploading}
          className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-semibold text-navy transition hover:border-gold hover:bg-gold-100/40 disabled:opacity-50"
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Uploading {progress > 0 ? `${progress}%` : '…'}
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              Upload file
            </>
          )}
        </button>
        <div className="flex flex-shrink-0 items-center text-[11px] font-semibold uppercase tracking-wider text-navy-300 sm:px-1">
          or
        </div>
        <input
          type="url"
          value={localUrl}
          onChange={handleUrlChange}
          placeholder="Paste a Google Drive / Docs link…"
          disabled={uploading}
          className="min-w-0 flex-1 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:opacity-50"
        />
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
      {hint && <p className="mt-1 text-xs text-navy-400">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs font-semibold text-red-700">{error}</p>
      )}
    </div>
  );
}
