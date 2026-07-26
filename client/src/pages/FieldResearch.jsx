import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, ShieldAlert, Check, Loader2, Users, FileText } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';

// Field research — the evidence chain behind primary reporting.
//
// The workflow this page exists to serve, in order: register a source,
// open an interview, record consent, upload the audio, let the model pull
// claims out of the transcript, then read the claim ledger grouped by
// what the sources actually agree on.
//
// Two things are deliberately not possible here, because making them
// possible would quietly destroy the value of everything else:
//
//   You cannot type a claim. Every claim on this page was located in a
//   transcript by matching the speaker's own words, which is what makes
//   a citation walk back to real audio. A hand-typed claim with a
//   hand-typed timestamp looks identical and means nothing.
//
//   You cannot upload audio before recording consent. The server refuses
//   it, and the form refuses it here too so the failure is understood
//   before someone has waited out an upload.

const RELATIONSHIPS = [
  ['FormerEmployee', 'Former employee'],
  ['CurrentEmployee', 'Current employee'],
  ['Customer', 'Customer'],
  ['Distributor', 'Distributor'],
  ['Supplier', 'Supplier'],
  ['Competitor', 'Competitor'],
  ['IndustryExpert', 'Industry expert'],
  ['Other', 'Other'],
];

// How much independent backing a topic has. Wording matters here — the
// difference between "two people said it" and "two independent people
// said it" is the difference between evidence and an echo.
const SUPPORT_STYLE = {
  corroborated: { label: 'Corroborated', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  clustered: { label: 'Same employer', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'single-source': { label: 'Single source', cls: 'bg-navy-50 text-navy-500 border-navy-200' },
  contested: { label: 'Contested', cls: 'bg-red-50 text-red-800 border-red-200' },
};

const KIND_STYLE = {
  fact: 'text-navy',
  opinion: 'text-navy-400 italic',
  forecast: 'text-navy-400',
};

export default function FieldResearch() {
  const [ticker, setTicker] = useState('');
  const [sources, setSources] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [ledger, setLedger] = useState({ claims: [], topics: [] });
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    const qs = ticker ? `?ticker=${encodeURIComponent(ticker)}` : '';
    try {
      const [s, i, c, pr] = await Promise.all([
        api.get(`/research/sources${qs}`).then((r) => r.data),
        api.get(`/research/interviews${qs}`).then((r) => r.data),
        api.get(`/research/claims${qs}`).then((r) => r.data),
        api.get(`/research/projects${qs}`).then((r) => r.data).catch(() => []),
      ]);
      setSources(s || []);
      setInterviews(i || []);
      setLedger(c || { claims: [], topics: [] });
      setProjects(pr || []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    load();
  }, [load]);

  async function runExtract(id) {
    setBusy(`extract-${id}`);
    setFlash(null);
    try {
      const { data } = await api.post(`/research/interviews/${id}/extract`);
      setFlash({
        kind: data.droppedUnlocatable > 0 ? 'warn' : 'ok',
        // The dropped count is surfaced, not buried. A run that discards
        // several claims means the model was paraphrasing rather than
        // quoting, and that output deserves a second look.
        text:
          `Extracted ${data.extracted} claim${data.extracted === 1 ? '' : 's'}.` +
          (data.droppedUnlocatable > 0
            ? ` ${data.droppedUnlocatable} discarded — the quoted words were not found in the transcript.`
            : ''),
      });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', text: e.response?.data?.error || 'Extraction failed' });
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader
        kicker="Primary Research"
        title="Research"
        subtitle="Interviews with people who touch the business — and the claim ledger built from them."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="Filter by ticker"
          className="w-40 rounded-lg border border-navy-100 px-3 py-1.5 text-sm"
        />
        <span className="text-xs text-navy-400">
          {sources.length} source{sources.length === 1 ? '' : 's'} ·{' '}
          {interviews.length} interview{interviews.length === 1 ? '' : 's'} ·{' '}
          {ledger.claims.length} claim{ledger.claims.length === 1 ? '' : 's'}
        </span>
      </div>

      {flash ? (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            flash.kind === 'err'
              ? 'border-red-200 bg-red-50 text-red-800'
              : flash.kind === 'warn'
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {flash.text}
        </div>
      ) : null}
      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-navy-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading field research…
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <ProjectList projects={projects} />
            <NewSource onDone={load} />
            <NewInterview sources={sources} onDone={load} />
            <InterviewList
              interviews={interviews}
              busy={busy}
              onExtract={runExtract}
              onUploaded={load}
              setFlash={setFlash}
            />
          </div>
          <Ledger ledger={ledger} onChanged={load} />
        </div>
      )}
    </>
  );
}

function Card({ title, icon: Icon, children }) {
  return (
    <section className="rounded-xl border border-navy-100 bg-white p-4">
      <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-navy">
        {Icon ? <Icon className="h-4 w-4 text-navy-400" /> : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

const input = 'w-full rounded-lg border border-navy-100 px-3 py-1.5 text-sm';
const btn =
  'inline-flex items-center gap-1.5 rounded-lg bg-navy px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40';

function NewSource({ onDone }) {
  const [f, setF] = useState({ alias: '', relationship: 'FormerEmployee', employer: '', role: '', tickers: '' });
  const [saving, setSaving] = useState(false);
  const [e, setE] = useState('');

  async function submit(ev) {
    ev.preventDefault();
    setSaving(true);
    setE('');
    try {
      await api.post('/research/sources', {
        ...f,
        tickers: f.tickers.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setF({ alias: '', relationship: 'FormerEmployee', employer: '', role: '', tickers: '' });
      onDone();
    } catch (err) {
      setE(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Add a source" icon={Users}>
      <form onSubmit={submit} className="space-y-2">
        <input
          className={input}
          placeholder="Alias — how they're cited (e.g. Former regional distributor)"
          value={f.alias}
          onChange={(ev) => setF({ ...f, alias: ev.target.value })}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            className={input}
            value={f.relationship}
            onChange={(ev) => setF({ ...f, relationship: ev.target.value })}
          >
            {RELATIONSHIPS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <input
            className={input}
            placeholder="Employer"
            value={f.employer}
            onChange={(ev) => setF({ ...f, employer: ev.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className={input}
            placeholder="Role"
            value={f.role}
            onChange={(ev) => setF({ ...f, role: ev.target.value })}
          />
          <input
            className={input}
            placeholder="Tickers (comma separated)"
            value={f.tickers}
            onChange={(ev) => setF({ ...f, tickers: ev.target.value })}
          />
        </div>
        {/* Employer is what makes two voices independent rather than one
            echo, so it is worth nagging for. */}
        {!f.employer ? (
          <p className="text-[11px] text-navy-400">
            Employer is used to tell independent corroboration from two
            colleagues repeating each other — worth filling in.
          </p>
        ) : null}
        {f.relationship === 'CurrentEmployee' ? (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-800">
            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            Current employees carry material non-public information risk.
            Interviews with them open at elevated risk and should avoid
            unreleased financials, guidance, and anything under NDA.
          </p>
        ) : null}
        {e ? <p className="text-xs text-red-700">{e}</p> : null}
        <button className={btn} disabled={saving || !f.alias}>
          {saving ? 'Saving…' : 'Add source'}
        </button>
      </form>
    </Card>
  );
}

function NewInterview({ sources, onDone }) {
  const [f, setF] = useState({ sourceId: '', title: '', ticker: '', consentObtained: false, consentNote: '' });
  const [saving, setSaving] = useState(false);
  const [e, setE] = useState('');

  async function submit(ev) {
    ev.preventDefault();
    setSaving(true);
    setE('');
    try {
      await api.post('/research/interviews', f);
      setF({ sourceId: '', title: '', ticker: '', consentObtained: false, consentNote: '' });
      onDone();
    } catch (err) {
      setE(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Log an interview" icon={FileText}>
      <form onSubmit={submit} className="space-y-2">
        <select
          className={input}
          value={f.sourceId}
          onChange={(ev) => setF({ ...f, sourceId: ev.target.value })}
        >
          <option value="">Select a source…</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.alias}{s.employer ? ` — ${s.employer}` : ''}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <input
            className={input}
            placeholder="Title"
            value={f.title}
            onChange={(ev) => setF({ ...f, title: ev.target.value })}
          />
          <input
            className={input}
            placeholder="Ticker"
            value={f.ticker}
            onChange={(ev) => setF({ ...f, ticker: ev.target.value.toUpperCase() })}
          />
        </div>
        <label className="flex items-start gap-2 text-xs text-navy">
          <input
            type="checkbox"
            checked={f.consentObtained}
            onChange={(ev) => setF({ ...f, consentObtained: ev.target.checked })}
            className="mt-0.5"
          />
          <span>
            The source consented to being recorded.{' '}
            <span className="text-navy-400">
              Required before any audio can be uploaded — recording without
              consent is unlawful in two-party-consent states.
            </span>
          </span>
        </label>
        {f.consentObtained ? (
          <input
            className={input}
            placeholder="How consent was given (e.g. verbal, on tape, 00:12)"
            value={f.consentNote}
            onChange={(ev) => setF({ ...f, consentNote: ev.target.value })}
          />
        ) : null}
        {e ? <p className="text-xs text-red-700">{e}</p> : null}
        <button className={btn} disabled={saving || !f.sourceId || !f.title}>
          {saving ? 'Saving…' : 'Log interview'}
        </button>
      </form>
    </Card>
  );
}

function InterviewList({ interviews, busy, onExtract, onUploaded, setFlash }) {
  return (
    <Card title="Interviews" icon={Mic}>
      {interviews.length === 0 ? (
        <p className="text-sm text-navy-400">No interviews yet.</p>
      ) : (
        <ul className="divide-y divide-navy-50">
          {interviews.map((i) => (
            <InterviewRow
              key={i.id}
              interview={i}
              busy={busy}
              onExtract={onExtract}
              onUploaded={onUploaded}
              setFlash={setFlash}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function InterviewRow({ interview: i, busy, onExtract, onUploaded, setFlash }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    setFlash(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/recording`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setFlash({
        kind: data.diarizationWarning ? 'warn' : 'ok',
        text: data.diarizationWarning
          ? `Transcribed ${data.wordCount} words. ${data.diarizationWarning}`
          : `Transcribed ${data.wordCount} words across ${data.speakerCount} speakers.`,
      });
      onUploaded();
    } catch (err) {
      setFlash({ kind: 'err', text: err.response?.data?.error || 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const canExtract = i.status === 'Transcribed' || i.status === 'Extracted';

  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-navy">
            {i.ticker ? <span className="text-navy-400">{i.ticker} · </span> : null}
            {i.title}
          </p>
          <p className="truncate text-xs text-navy-400">
            {i.source?.alias}
            {i.source?.employer ? ` · ${i.source.employer}` : ''} ·{' '}
            {new Date(i.conductedAt).toLocaleDateString()} · {i._count?.claims ?? 0} claims
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{i.status}</Chip>
            {!i.consentObtained ? <Chip tone="warn">No consent recorded</Chip> : null}
            {i.mnpiRisk !== 'low' ? <Chip tone="warn">MNPI {i.mnpiRisk}</Chip> : null}
            {i.quarantined ? <Chip tone="err">Quarantined — not citable</Chip> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <button
            className="rounded-lg border border-navy-100 px-2.5 py-1 text-xs font-semibold text-navy disabled:opacity-40"
            disabled={uploading || !i.consentObtained}
            title={
              i.consentObtained
                ? 'Upload the recording and transcribe it'
                : 'Consent must be recorded before uploading audio'
            }
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? 'Transcribing…' : i.recordingRef ? 'Re-upload' : 'Upload audio'}
          </button>
          <button
            className="rounded-lg border border-navy-100 px-2.5 py-1 text-xs font-semibold text-navy disabled:opacity-40"
            disabled={!canExtract || busy === `extract-${i.id}` || i.quarantined}
            onClick={() => onExtract(i.id)}
          >
            {busy === `extract-${i.id}` ? 'Extracting…' : 'Extract claims'}
          </button>
        </div>
      </div>
    </li>
  );
}

function Chip({ children, tone }) {
  const cls =
    tone === 'err'
      ? 'border-red-200 bg-red-50 text-red-800'
      : tone === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-navy-100 bg-navy-50 text-navy-500';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function Ledger({ ledger, onChanged }) {
  const byTopic = new Map();
  for (const c of ledger.claims) {
    const k = c.topic || '(untopiced)';
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(c);
  }

  return (
    <Card title="Claim ledger">
      {ledger.claims.length === 0 ? (
        <p className="text-sm text-navy-400">
          No claims yet. Upload a recording and extract to build the ledger.
        </p>
      ) : (
        <div className="space-y-5">
          {ledger.topics.map((t) => (
            <div key={t.topic}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-navy">{t.topic}</h3>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                    (SUPPORT_STYLE[t.support] || SUPPORT_STYLE['single-source']).cls
                  }`}
                >
                  {(SUPPORT_STYLE[t.support] || {}).label || t.support}
                </span>
                <span className="text-[11px] text-navy-400">
                  {t.distinctSources} source{t.distinctSources === 1 ? '' : 's'} ·{' '}
                  {t.independentLines} independent · {t.factCount} fact
                  {t.opinionCount ? ` · ${t.opinionCount} opinion` : ''}
                  {t.forecastCount ? ` · ${t.forecastCount} forecast` : ''}
                </span>
              </div>
              <ul className="space-y-2">
                {(byTopic.get(t.topic) || []).map((c) => (
                  <ClaimRow key={c.id} claim={c} onChanged={onChanged} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ClaimRow({ claim: c, onChanged }) {
  const [working, setWorking] = useState(false);

  async function toggleVerify() {
    setWorking(true);
    try {
      await api.post(`/research/claims/${c.id}/verify`, { unverify: !!c.verifiedById });
      onChanged();
    } catch {
      /* the row simply stays as it was */
    } finally {
      setWorking(false);
    }
  }

  return (
    <li className="rounded-lg border border-navy-50 bg-navy-50/40 p-2.5">
      <p className={`text-sm ${KIND_STYLE[c.kind] || ''}`}>{c.text}</p>
      {c.quote ? (
        // The verbatim words are shown, not just the tidy summary. The
        // summary is the model's; the quote is the source's, and a reader
        // deciding whether to lean on a claim should see both.
        <blockquote className="mt-1 border-l-2 border-navy-200 pl-2 text-xs italic text-navy-500">
          “{c.quote}”
        </blockquote>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-navy-400">
        <span className="font-mono">{c.citation}</span>
        <Chip>{c.kind}</Chip>
        {c.extractionConfidence != null ? (
          <span>pin {Math.round(c.extractionConfidence * 100)}%</span>
        ) : null}
        <button
          onClick={toggleVerify}
          disabled={working}
          className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-semibold ${
            c.verifiedById
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-navy-100 text-navy-500'
          }`}
          title={
            c.verifiedById
              ? 'Verified by a person who listened back'
              : 'Mark verified once you have listened back and agree the pin is right'
          }
        >
          <Check className="h-3 w-3" />
          {c.verifiedById ? 'Verified' : 'Verify'}
        </button>
      </div>
    </li>
  );
}

// Projects, on the page that predates them.
//
// This page was built before ResearchProject existed and only ever
// listed sources, interviews and the claim ledger — so it and the
// terminal's FLD panel described different worlds. Someone working here
// could see seventeen interviews and have no idea which project they
// belonged to, or that questions, site visits and an outreach funnel
// existed at all.
//
// Deliberately read-only. Running a project — writing the brief, setting
// questions, working the funnel — belongs in FLD where the whole process
// is in one pane. This is the signpost, not a second implementation of
// the same thing.
function ProjectList({ projects }) {
  if (!projects || projects.length === 0) return null;
  return (
    <Card title="Research projects" icon={FileText}>
      <ul className="divide-y divide-navy-50">
        {projects.map((p) => (
          <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-navy">
                {p.ticker ? <span className="text-navy-400">{p.ticker} · </span> : null}
                {p.name}
              </p>
              <p className="text-xs text-navy-400">
                {p._count?.interviews ?? 0} interview
                {(p._count?.interviews ?? 0) === 1 ? '' : 's'} ·{' '}
                {p._count?.artifacts ?? 0} file
                {(p._count?.artifacts ?? 0) === 1 ? '' : 's'} · {p.status}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-navy-400">
              open with{' '}
              <span className="font-mono text-navy">
                {p.ticker ? `${p.ticker} FLD` : 'FLD'}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-navy-400">
        Questions, coverage, the outreach funnel and site visits live in the
        terminal's FLD panel, where the whole project is in one place. This
        page covers sources, interviews and the claim ledger.
      </p>
    </Card>
  );
}
