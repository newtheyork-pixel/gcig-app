import { useEffect, useState } from 'react';
import { Download, ShieldCheck, Loader2, AlertCircle, Monitor } from 'lucide-react';
import api from '../api/client';

// Where a member gets the Mac terminal.
//
// Behind the login on purpose. The club's terminal is a members' benefit
// and the build is served from our own API rather than a public bucket,
// so downloading it needs the same account that opens it. That also
// means the link cannot be forwarded to somebody outside the club and
// still work.
export default function DownloadTerminal() {
  const [rel, setRel] = useState(null);
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api
      .get('/app/latest')
      .then((r) => {
        setRel(r.data);
        setState(r.data?.version ? 'ready' : 'none');
      })
      .catch(() => setState('error'));
  }, []);

  // Fetched through axios rather than a plain href, because the route is
  // members-only and an anchor cannot carry the Authorization header. The
  // blob is handed to a temporary link so the browser still shows its
  // normal download UI.
  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.get('/app/download', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GriffinTerminal-${rel?.version || 'latest'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(
        e?.response?.status === 404
          ? 'No build has been published yet.'
          : 'The download failed. Try again, or tell Thomas if it keeps happening.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Monitor className="h-7 w-7 text-navy-700" />
        <div>
          <h1 className="text-2xl font-semibold text-navy-900">Griffin Terminal</h1>
          <p className="text-sm text-navy-500">
            The club's research terminal, native for Mac. Free to every member.
          </p>
        </div>
      </div>

      {state === 'loading' && (
        <div className="flex items-center gap-2 text-navy-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking for a build…
        </div>
      )}

      {state === 'error' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Could not reach the server to check for a build.
        </div>
      )}

      {/* Distinguishable from a failure: the server answered, and there
          simply is not a build yet. */}
      {state === 'none' && (
        <div className="rounded-lg border border-navy-200 bg-navy-50 p-4 text-sm text-navy-700">
          No build has been published yet. This page will offer it as soon as one is.
        </div>
      )}

      {state === 'ready' && (
        <div className="rounded-xl border border-navy-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-baseline justify-between">
            <span className="text-lg font-medium text-navy-900">
              Version {rel.version}
            </span>
            {rel.bytes ? (
              <span className="text-sm text-navy-500">
                {(rel.bytes / 1048576).toFixed(1)} MB
              </span>
            ) : null}
          </div>

          {rel.notes ? (
            <p className="mb-4 text-sm text-navy-600">{rel.notes}</p>
          ) : null}

          <button
            onClick={download}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-800 px-5 py-2.5 font-medium text-white hover:bg-navy-900 disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Downloading…
              </>
            ) : (
              <>
                <Download className="h-4 w-4" /> Download for Mac
              </>
            )}
          </button>

          {err && (
            <div className="mt-3 flex items-start gap-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{err}</span>
            </div>
          )}

          {/* Said plainly, because an unexplained Apple prompt is the
              thing that makes somebody give up on an install. There
              should not be one — the build is notarized — and if there
              is, a member should know it means something is wrong rather
              than that this is normal. */}
          <div className="mt-6 flex items-start gap-2 border-t border-navy-100 pt-4 text-sm text-navy-600">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-700" />
            <span>
              Signed and notarized by Apple. Unzip it, drag Griffin Terminal to
              Applications, and open it — there should be no security warning. It
              updates itself after that.
            </span>
          </div>

          <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-navy-600">
            <li>Download and unzip.</li>
            <li>Drag <span className="font-medium">Griffin Terminal</span> into Applications.</li>
            <li>Open it, and sign in through the browser when it asks.</li>
          </ol>

          <p className="mt-4 text-xs text-navy-400">
            macOS 14 or later, Apple Silicon or Intel. There is no Windows build.
          </p>
        </div>
      )}
    </div>
  );
}
