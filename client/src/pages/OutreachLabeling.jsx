import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Copy, Check, AlertTriangle } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';

// The calibration bench for the outreach screen. Every draft the screen
// has read is walked here and given a human verdict; where the screen and
// the human disagree is the list that improves the prompt. Grok's call is
// recorded by hand beside the human's as a second opinion you can still
// watch disagree. Nothing recorded here is fed back to the model as an
// example — this is the answer key, kept off the exam.

const RISKS = [
  { value: 'low', label: 'Low', hint: 'ordinary, well-bounded research' },
  { value: 'elevated', label: 'Elevated', hint: 'a person should read before it goes' },
  { value: 'prohibited', label: 'Prohibited', hint: 'must not be sent as written' },
];

const RISK_STYLE = {
  low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  elevated: 'bg-amber-50 text-amber-700 border-amber-200',
  prohibited: 'bg-red-50 text-red-700 border-red-200',
  null: 'bg-navy-50 text-navy-400 border-navy-100',
};

function RiskPill({ risk }) {
  const key = risk || 'null';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${RISK_STYLE[key] || RISK_STYLE.null}`}
    >
      {risk || 'unscreened'}
    </span>
  );
}

const FILTERS = [
  { key: 'all', label: 'All screened' },
  { key: 'unlabeled', label: 'Not yet graded' },
  { key: 'disagreements', label: 'Screen vs you' },
];

const EMPTY_FORM = { humanRisk: '', humanCategory: '', humanNote: '', grokRisk: '', grokNote: '' };

export default function OutreachLabeling() {
  const { isExecutive, isSuperAdmin } = useAuth();
  const allowed = isExecutive || isSuperAdmin;

  const [filter, setFilter] = useState('all');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  // Prefetched so the copy runs inside the click gesture. Safari refuses a
  // clipboard write that happens after an await (the network fetch spends
  // the user activation), so the prompt is fetched on open and held here.
  const [grokPrompt, setGrokPrompt] = useState('');

  useEffect(() => {
    if (!allowed) return;
    api
      .get('/outreach-labeling/config')
      .then((r) => setCategories(r.data?.categories || []))
      .catch(() => {});
  }, [allowed]);

  const loadQueue = () => {
    setLoading(true);
    api
      .get('/outreach-labeling/queue', { params: { filter } })
      .then((r) => setRows(r.data?.rows || []))
      .catch(() => setError('Could not load the queue'))
      .finally(() => setLoading(false));
  };
  const loadMetrics = () => {
    api
      .get('/outreach-labeling/metrics')
      .then((r) => setMetrics(r.data?.metrics || null))
      .catch(() => {});
  };

  useEffect(() => {
    if (!allowed) return;
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, filter]);
  useEffect(() => {
    if (allowed) loadMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const openDraft = (row) => {
    setSelectedId(row.id);
    setCopied(false);
    setError('');
    setGrokPrompt('');
    setForm(
      row.label
        ? {
            humanRisk: row.label.humanRisk || '',
            humanCategory: row.label.humanCategory || '',
            humanNote: row.label.humanNote || '',
            grokRisk: row.label.grokRisk || '',
            grokNote: row.label.grokNote || '',
          }
        : EMPTY_FORM
    );
    // Fetch the paste-into-Grok prompt now, so the button can copy it
    // without a network round-trip standing between the click and the
    // clipboard write.
    api
      .get(`/outreach-labeling/${row.id}/grok-prompt`)
      .then((r) => setGrokPrompt(r.data?.prompt || ''))
      .catch(() => setGrokPrompt(''));
  };

  // Write within the gesture; fall back to the legacy textarea path when
  // the async Clipboard API is missing or refuses (older Safari, non-secure
  // contexts).
  const writeClipboard = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const copyForGrok = async () => {
    if (!selected) return;
    setError('');
    let text = grokPrompt;
    if (!text) {
      // Prefetch hasn't landed yet — fetch it now. Outside Safari this is
      // fine; on Safari the prefetch normally beats the click.
      try {
        const r = await api.get(`/outreach-labeling/${selected.id}/grok-prompt`);
        text = r.data?.prompt || '';
        setGrokPrompt(text);
      } catch {
        setError('Could not load the prompt');
        return;
      }
    }
    const ok = await writeClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } else {
      setError('Could not copy. The prompt is loaded; try once more.');
    }
  };

  const save = async () => {
    if (!selected || !form.humanRisk) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        humanRisk: form.humanRisk,
        humanCategory: form.humanRisk === 'low' ? null : form.humanCategory || null,
        humanNote: form.humanNote || null,
        grokRisk: form.grokRisk || null,
        grokNote: form.grokNote || null,
      };
      const r = await api.post(`/outreach-labeling/${selected.id}`, payload);
      const updated = r.data?.row;
      if (updated) setRows((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      loadMetrics();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save the label');
    } finally {
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader kicker="Compliance" title="Outreach Screen Labeling" />
        <Card className="p-6 text-sm text-navy-400">
          This calibration bench is limited to the members who sign off on outreach.
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        kicker="Compliance"
        title="Outreach Screen Labeling"
        subtitle="Grade the screen against your own call to find where it over-flags. Nothing here is fed back to the model as an example."
      />

      {metrics && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Graded" value={metrics.screen.compared} />
          <Stat label="Screen agrees" value={metrics.screen.agree} tone="emerald" />
          <Stat label="Over-flags" value={metrics.screen.overFlag} tone="amber" hint="stricter than you" />
          <Stat label="Under-flags" value={metrics.screen.underFlag} tone="red" hint="missed what you caught" />
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              filter === f.key
                ? 'border-navy bg-navy text-white'
                : 'border-navy-100 bg-white text-navy-400 hover:border-navy'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Queue */}
        <div className="space-y-2">
          {loading ? (
            <Card className="p-6 text-sm text-navy-400">Loading…</Card>
          ) : rows.length === 0 ? (
            <Card className="p-6 text-sm text-navy-400">Nothing to show for this filter.</Card>
          ) : (
            rows.map((row) => {
              const disagrees =
                row.label && row.label.screenRiskAtLabel && row.label.humanRisk !== row.label.screenRiskAtLabel;
              return (
                <button
                  key={row.id}
                  onClick={() => openDraft(row)}
                  className={`w-full rounded-xl border bg-white p-4 text-left shadow-card transition hover:border-navy ${
                    selectedId === row.id ? 'border-navy ring-1 ring-navy' : 'border-navy-100'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-serif text-[15px] font-semibold text-navy">
                      {row.subject || '(no subject)'}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-navy-300">{row.stage}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-navy-400">
                    {row.target?.name || 'unknown'}
                    {row.target?.relationship ? ` · ${row.target.relationship}` : ''}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-navy-300">screen</span>
                    <RiskPill risk={row.screenRisk} />
                    {row.label && (
                      <>
                        <span className="text-[10px] uppercase tracking-wide text-navy-300">you</span>
                        <RiskPill risk={row.label.humanRisk} />
                      </>
                    )}
                    {disagrees && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
                        <AlertTriangle size={12} /> disagree
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Detail + grading */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          {!selected ? (
            <Card className="p-6 text-sm text-navy-400">Pick a draft to grade it.</Card>
          ) : (
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
                  {selected.target?.name || 'unknown'} · {selected.target?.relationship || 'unknown'}
                </div>
                <Button variant="outline" onClick={copyForGrok} className="!px-3 !py-1.5">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy for Grok'}
                </Button>
              </div>

              <h2 className="font-serif text-lg font-semibold text-navy">{selected.subject}</h2>
              <p className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg border border-navy-50 bg-navy-50/40 p-3 text-sm leading-relaxed text-navy-600">
                {selected.body}
              </p>

              <div className="mt-4 flex items-center gap-2 rounded-lg bg-navy-50/60 px-3 py-2">
                <ShieldCheck size={15} className="text-navy-400" />
                <span className="text-xs text-navy-500">
                  Screen said <RiskPill risk={selected.screenRisk} />
                  {selected.screenReason ? ` — ${selected.screenReason}` : ''}
                </span>
              </div>

              {/* Your verdict */}
              <div className="mt-5">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-navy-400">
                  Your verdict
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {RISKS.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => setForm((f) => ({ ...f, humanRisk: r.value }))}
                      className={`rounded-lg border px-2 py-2 text-center transition ${
                        form.humanRisk === r.value
                          ? 'border-navy bg-navy text-white'
                          : 'border-navy-100 bg-white text-navy hover:border-navy'
                      }`}
                    >
                      <div className="text-xs font-semibold">{r.label}</div>
                    </button>
                  ))}
                </div>

                {form.humanRisk && form.humanRisk !== 'low' && (
                  <div className="mt-3">
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-navy-400">
                      Which flag did it match?
                    </label>
                    <select
                      value={form.humanCategory}
                      onChange={(e) => setForm((f) => ({ ...f, humanCategory: e.target.value }))}
                      className="w-full rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy"
                    >
                      <option value="">Name the behaviour…</option>
                      {categories.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-navy-300">
                      If you cannot name one, the right verdict is Low.
                    </p>
                  </div>
                )}

                <textarea
                  value={form.humanNote}
                  onChange={(e) => setForm((f) => ({ ...f, humanNote: e.target.value }))}
                  placeholder="Why (optional)"
                  rows={2}
                  className="mt-3 w-full rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy"
                />
              </div>

              {/* Grok's verdict, typed by hand */}
              <div className="mt-5 border-t border-navy-50 pt-4">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-navy-400">
                  Grok's verdict <span className="normal-case text-navy-300">(paste the draft in, record what it says)</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {RISKS.map((r) => (
                    <button
                      key={r.value}
                      onClick={() =>
                        setForm((f) => ({ ...f, grokRisk: f.grokRisk === r.value ? '' : r.value }))
                      }
                      className={`rounded-lg border px-2 py-1.5 text-center text-xs font-semibold transition ${
                        form.grokRisk === r.value
                          ? 'border-gold bg-gold text-navy'
                          : 'border-navy-100 bg-white text-navy hover:border-navy'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={form.grokNote}
                  onChange={(e) => setForm((f) => ({ ...f, grokNote: e.target.value }))}
                  placeholder="What Grok said (optional)"
                  rows={2}
                  className="mt-3 w-full rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy"
                />
              </div>

              {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

              <div className="mt-5 flex items-center justify-end gap-3">
                {selected.label && (
                  <span className="text-[11px] text-navy-300">
                    last graded by {selected.label.labeledBy || 'someone'}
                  </span>
                )}
                <Button onClick={save} disabled={!form.humanRisk || saving}>
                  {saving ? 'Saving…' : selected.label ? 'Update grade' : 'Save grade'}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'navy', hint }) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
      ? 'text-red-700'
      : 'text-navy';
  return (
    <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-card">
      <div className={`font-serif text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-navy-400">{label}</div>
      {hint && <div className="text-[10px] text-navy-300">{hint}</div>}
    </div>
  );
}
