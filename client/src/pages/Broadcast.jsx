import { useEffect, useMemo, useState } from 'react';
import { Send, Users, Building2, Layers, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// Club-wide + targeted email sender for CIO+. Builds an audience picker from
// /broadcasts/audiences, previews recipient counts on change, then POSTs to
// /broadcasts/send. The actual send goes BCC'd so no one sees anyone else's
// email.

const AUDIENCE_KINDS = [
  { value: 'all', label: 'All members', icon: Users },
  { value: 'rank_gte', label: 'Rank and above', icon: Layers },
  { value: 'role', label: 'Specific role', icon: Layers },
  { value: 'industry', label: 'Industry pod', icon: Building2 },
];

export default function Broadcast() {
  const { user, isExecutive } = useAuth();
  const [audiences, setAudiences] = useState({ industries: [], roles: [] });
  const [kind, setKind] = useState('all');
  const [industryId, setIndustryId] = useState('');
  const [role, setRole] = useState('');
  const [minRole, setMinRole] = useState('SeniorAnalyst');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    api.get('/broadcasts/audiences').then(({ data }) => {
      setAudiences(data);
      if (data.industries?.length) setIndustryId(String(data.industries[0].id));
    });
  }, []);

  // Build the audience string sent to the server.
  const audience = useMemo(() => {
    if (kind === 'all') return 'all';
    if (kind === 'industry') return industryId ? `industry:${industryId}` : '';
    if (kind === 'role') return role ? `role:${role}` : '';
    if (kind === 'rank_gte') return minRole ? `rank_gte:${minRole}` : '';
    return '';
  }, [kind, industryId, role, minRole]);

  // Debounced preview on audience change.
  useEffect(() => {
    if (!audience) {
      setPreview(null);
      setPreviewError('');
      return;
    }
    setPreview(null);
    setPreviewError('');
    const handle = setTimeout(async () => {
      try {
        const { data } = await api.get('/broadcasts/preview', { params: { audience } });
        setPreview(data);
      } catch (err) {
        setPreviewError(err.response?.data?.error || 'Could not preview');
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [audience]);

  if (!isExecutive) {
    return (
      <>
        <PageHeader title="Broadcast" />
        <Card>
          <p className="text-sm text-navy-400">
            Sending club-wide emails is restricted to CIOs and the President.
          </p>
        </Card>
      </>
    );
  }

  async function doSend() {
    setSending(true);
    setError('');
    setSent(null);
    try {
      const { data } = await api.post('/broadcasts/send', { audience, subject, body });
      setSent(data);
      setSubject('');
      setBody('');
      setShowConfirm(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send');
      setShowConfirm(false);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSent(null);
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (!body.trim()) {
      setError('Body is required');
      return;
    }
    if (!preview || preview.count === 0) {
      setError('No recipients resolved for the selected audience');
      return;
    }
    setShowConfirm(true);
  }

  return (
    <>
      <PageHeader
        title="Broadcast"
        subtitle="Send a single email to the whole club, a specific pod, or a specific rank."
      />

      <Card>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-navy-400">
              Audience
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
              {AUDIENCE_KINDS.map((a) => {
                const Icon = a.icon;
                const active = kind === a.value;
                return (
                  <button
                    key={a.value}
                    type="button"
                    onClick={() => setKind(a.value)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                      active
                        ? 'border-gold bg-gold-100/40 text-navy font-semibold'
                        : 'border-navy-100 bg-white text-navy-400 hover:bg-navy-50'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {a.label}
                  </button>
                );
              })}
            </div>

            {kind === 'industry' && (
              <select
                value={industryId}
                onChange={(e) => setIndustryId(e.target.value)}
                className="mt-3 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none"
              >
                <option value="">Select a pod…</option>
                {audiences.industries.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
            {kind === 'role' && (
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-3 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none"
              >
                <option value="">Select a role…</option>
                {audiences.roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            {kind === 'rank_gte' && (
              <select
                value={minRole}
                onChange={(e) => setMinRole(e.target.value)}
                className="mt-3 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none"
              >
                {audiences.roles.map((r) => (
                  <option key={r} value={r}>
                    {r} and above
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Live recipient preview */}
          <div className="rounded-lg border border-navy-100 bg-navy-50/40 px-4 py-3 text-sm">
            {previewError ? (
              <span className="text-red-600">{previewError}</span>
            ) : preview ? (
              <>
                <span className="font-semibold text-navy">
                  {preview.count} recipient{preview.count === 1 ? '' : 's'}
                </span>
                {preview.sample.length > 0 && (
                  <span className="text-navy-400">
                    {' '}· {preview.sample.map((u) => u.name).slice(0, 6).join(', ')}
                    {preview.count > 6 ? ` + ${preview.count - 6} more` : ''}
                  </span>
                )}
                {preview.skipped > 0 && (
                  <span className="text-navy-400"> · {preview.skipped} without email skipped</span>
                )}
              </>
            ) : (
              <span className="text-navy-400">Resolving audience…</span>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-navy-400">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={150}
              placeholder="Meeting change, weekly update, pitch reminder…"
              className="mt-2 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-navy-400">
              Message
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              maxLength={10000}
              placeholder={`Hi everyone,\n\n…\n\nThanks,\n${user?.name || ''}`}
              className="mt-2 w-full resize-none rounded-lg border border-navy-100 px-3 py-2 font-mono text-sm leading-6 focus:border-gold focus:outline-none"
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-navy-400">
              <span>Plain text · new lines are preserved in the email</span>
              <span>{body.length} / 10000</span>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertTriangle className="mr-1 inline h-4 w-4" /> {error}
            </div>
          )}
          {sent && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="mr-1 inline h-4 w-4" />
              Sent to {sent.recipientCount} recipient{sent.recipientCount === 1 ? '' : 's'} ({sent.audience}).
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-[11px] text-navy-400">
              Emails are BCC'd — recipients don't see each other's addresses.
            </div>
            <Button
              type="submit"
              variant="gold"
              disabled={sending || !preview || preview?.count === 0 || !subject.trim() || !body.trim()}
            >
              <Send className="h-4 w-4" />
              Review &amp; send
            </Button>
          </div>
        </form>
      </Card>

      {showConfirm && preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 p-4"
          onClick={() => !sending && setShowConfirm(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-navy">Confirm broadcast</h3>
            <p className="mt-2 text-sm text-navy-400">
              This will email{' '}
              <span className="font-bold text-navy">
                {preview.count} recipient{preview.count === 1 ? '' : 's'}
              </span>
              . You can't undo this.
            </p>
            <div className="mt-4 rounded-lg border border-navy-100 bg-navy-50 p-3 text-sm">
              <div className="text-[10px] uppercase tracking-wider text-navy-400">Subject</div>
              <div className="font-semibold text-navy">{subject}</div>
              <div className="mt-2 text-[10px] uppercase tracking-wider text-navy-400">Preview</div>
              <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-navy">
                {body.slice(0, 500)}
                {body.length > 500 ? '…' : ''}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={sending}>
                Cancel
              </Button>
              <Button variant="gold" onClick={doSend} disabled={sending}>
                {sending ? 'Sending…' : `Send to ${preview.count}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
