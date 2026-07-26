import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';
import PDFModal from '../../components/PDFModal.jsx';

// FLD — the entire field-research process for a company, in the terminal.
//
// A project is the container: the brief, the question guides, the
// interviews and their transcripts, the store photos, the pricing sheets,
// and the claim ledger built out of all of it. `FLD` lists projects,
// `AIT FLD` scopes to a ticker, and opening one shows everything in a
// single pane rather than scattering it across four screens.
//
// Anything can be attached. A guide typed straight in and a PDF dragged
// over land in the same list, because forcing the file shape on written
// text just means people keep their scripts somewhere else and the
// project stops being the whole record.
//
// The one thing you cannot do here is type a claim. Every claim was
// located in a transcript by matching the speaker's own words, which is
// what lets a citation walk back to real audio. A hand-typed claim would
// look identical and mean nothing.

const KINDS = [
  ['guide', 'Interview guide'],
  ['script', 'Script'],
  ['document', 'Document'],
  ['data', 'Data'],
  ['photo', 'Photo'],
  ['memo', 'Memo'],
  ['other', 'Other'],
];

const SUPPORT_COLOR = {
  corroborated: 'var(--term-positive)',
  clustered: 'var(--term-amber, var(--term-white))',
  'single-source': 'var(--term-fg-muted)',
  contested: 'var(--term-negative)',
};

const SUPPORT_LABEL = {
  corroborated: 'CORROBORATED',
  clustered: 'SAME EMPLOYER',
  'single-source': 'SINGLE SOURCE',
  contested: 'CONTESTED',
};

const COVERAGE_COLOR = {
  supported: 'var(--term-positive)',
  thin: 'var(--term-amber, var(--term-white))',
  unaddressed: 'var(--term-fg-muted)',
  contested: 'var(--term-negative)',
};
const COVERAGE_LABEL = {
  supported: 'SUPPORTED',
  thin: 'THIN',
  unaddressed: 'NO EVIDENCE',
  contested: 'CONTESTED',
};

const TARGET_STATUSES = [
  'Identified', 'Contacted', 'Scheduled', 'Completed', 'Declined', 'Unreachable',
];

const fmtDate = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(2)}`;
};

export default function FieldWork({ ticker }) {
  const [projects, setProjects] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const loadList = useCallback(() => {
    setLoading(true);
    setErr(null);
    const qs = ticker ? `?ticker=${encodeURIComponent(ticker)}` : '';
    api
      .get(`/research/projects${qs}`)
      .then(({ data }) => setProjects(data || []))
      .catch((e) => setErr(e.response?.data?.error || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [ticker]);

  useEffect(() => {
    setOpenId(null);
    loadList();
  }, [loadList]);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading field research…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (openId) {
    return <ProjectPane id={openId} onBack={() => { setOpenId(null); loadList(); }} />;
  }

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        {ticker ? <span className="ticker">{ticker.toUpperCase()}</span> : null}
        <span className="name">Field Research</span>
      </div>

      <NewProject ticker={ticker} onDone={loadList} />

      {!projects || projects.length === 0 ? (
        <div className="term-loading">
          No projects{ticker ? ` for ${ticker.toUpperCase()}` : ''} yet.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Sym</th>
              <th>Project</th>
              <th className="num">Calls</th>
              <th className="num">Files</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td className="sym">{p.ticker || '—'}</td>
                <td>
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); setOpenId(p.id); }}
                  >
                    {p.name}
                  </a>
                </td>
                <td className="num">{p._count?.interviews ?? 0}</td>
                <td className="num">{p._count?.artifacts ?? 0}</td>
                <td>{p.status}</td>
                <td>{fmtDate(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        A project holds the brief, guides, recordings, files and the claim
        ledger for one company. Open one to add to it.
      </div>
    </div>
  );
}

const termInput = {
  background: 'var(--term-bg, #000)',
  color: 'var(--term-white)',
  border: '1px solid var(--term-border)',
  padding: '5px 8px',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
};

function TermButton({ children, onClick, disabled, title, type = 'button' }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="term-btn"
      style={{
        background: 'transparent',
        color: disabled ? 'var(--term-fg-muted)' : 'var(--term-white)',
        border: '1px solid var(--term-border)',
        padding: '4px 10px',
        fontFamily: 'inherit',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function NewProject({ ticker, onDone }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await api.post('/research/projects', { name, brief, ticker: ticker || null });
      setName('');
      setBrief('');
      setOpen(false);
      onDone();
    } catch {
      /* the form stays up with the text intact */
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div>
        <TermButton onClick={() => setOpen(true)}>+ New project</TermButton>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <input
        style={termInput}
        placeholder={`Project name${ticker ? ` — ${ticker.toUpperCase()}` : ''}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {/* The brief is written before the fieldwork, so the project can be
          judged against what it set out to answer rather than whatever it
          happened to turn up. */}
      <textarea
        style={{ ...termInput, resize: 'vertical', minHeight: 60 }}
        placeholder="Brief — what are we trying to find out?"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <TermButton onClick={submit} disabled={saving || !name}>
          {saving ? 'Creating…' : 'Create'}
        </TermButton>
        <TermButton onClick={() => setOpen(false)}>Cancel</TermButton>
      </div>
    </div>
  );
}

function ProjectPane({ id, onBack }) {
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('coverage');
  const [flash, setFlash] = useState(null);
  const [doc, setDoc] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get(`/research/projects/${id}`)
      .then(({ data }) => setP(data))
      .catch((e) => setErr(e.response?.data?.error || e.message || 'Failed'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Opening project…</div>
      </div>
    );
  }
  if (err || !p) {
    return (
      <div className="term-panel">
        <TermButton onClick={onBack}>← Projects</TermButton>
        <div className="term-error">Error: {err || 'Not found'}</div>
      </div>
    );
  }

  return (
    <div className="term-panel">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TermButton onClick={onBack}>← Projects</TermButton>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
          {p.interviews.length} interview{p.interviews.length === 1 ? '' : 's'} ·{' '}
          {p.artifacts.length} file{p.artifacts.length === 1 ? '' : 's'} ·{' '}
          {p.claims.length} claim{p.claims.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="term-panel-header">
        {p.ticker ? <span className="ticker">{p.ticker}</span> : null}
        <span className="name">{p.name}</span>
      </div>

      {p.brief ? (
        <div style={{ color: 'var(--term-fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
          {p.brief}
        </div>
      ) : null}

      {/* Transcription is a paid API configured server-side. If the key
          isn't set, say so here rather than letting someone wait out a
          long upload to be told at the end. */}
      {!p.transcriptionReady ? (
        <div className="term-error" style={{ fontSize: 11 }}>
          Transcription is not configured — set ELEVENLABS_API_KEY on the
          API. Recordings can still be attached as files.
        </div>
      ) : null}

      {flash ? (
        <div
          style={{
            fontSize: 11,
            color: flash.bad ? 'var(--term-negative)' : 'var(--term-positive)',
          }}
        >
          {flash.text}
        </div>
      ) : null}

      <div className="term-tabs">
        {[
          ['coverage', `Questions (${p.questions?.length ?? 0})`],
          ['targets', `Outreach (${p.funnel?.total ?? 0})`],
          ['interviews', `Interviews (${p.interviews.length})`],
          ['visits', `Visits (${p.visits?.length ?? 0})`],
          ['ledger', `Ledger (${p.claims.length})`],
          ['files', `Files (${p.artifacts.length})`],
        ].map(([k, label]) => (
          <button
            key={k}
            className={`term-tab${tab === k ? ' active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'coverage' ? <Coverage project={p} onChanged={load} /> : null}
      {tab === 'targets' ? <Targets project={p} onChanged={load} /> : null}
      {tab === 'visits' ? <Visits project={p} onChanged={load} setFlash={setFlash} /> : null}
      {tab === 'ledger' ? <Ledger project={p} onChanged={load} /> : null}
      {tab === 'interviews' ? (
        <Interviews project={p} onChanged={load} setFlash={setFlash} />
      ) : null}
      {tab === 'files' ? (
        <Files project={p} onChanged={load} setFlash={setFlash} onOpenDoc={setDoc} />
      ) : null}

      <PDFModal
        url={doc?.url}
        title={doc?.title}
        onClose={() => setDoc(null)}
      />
    </div>
  );
}

function Ledger({ project, onChanged }) {
  if (project.claims.length === 0) {
    return (
      <div className="term-loading">
        No claims yet. Add an interview, upload the recording, then extract.
      </div>
    );
  }
  const byTopic = new Map();
  for (const c of project.claims) {
    const k = c.topic || '(untopiced)';
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(c);
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {project.topics.map((t) => (
        <div key={t.topic}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--term-white)', fontWeight: 700 }}>{t.topic}</span>
            <span style={{ color: SUPPORT_COLOR[t.support], fontSize: 10, letterSpacing: 0.5 }}>
              {SUPPORT_LABEL[t.support] || t.support}
            </span>
            <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
              {t.distinctSources} src · {t.independentLines} independent
              {t.opinionCount ? ` · ${t.opinionCount} opinion` : ''}
              {t.forecastCount ? ` · ${t.forecastCount} forecast` : ''}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {(byTopic.get(t.topic) || []).map((c) => (
              <div
                key={c.id}
                style={{
                  borderLeft: '2px solid var(--term-border)',
                  paddingLeft: 8,
                }}
              >
                <div style={{ color: 'var(--term-white)', fontSize: 12 }}>{c.text}</div>
                {c.quote ? (
                  // The source's own words sit next to the tidy summary.
                  // The summary is the model's; the quote is the evidence.
                  <div style={{ color: 'var(--term-fg-dim)', fontSize: 11, fontStyle: 'italic' }}>
                    “{c.quote}”
                  </div>
                ) : null}
                <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>
                    {c.citation} · {c.kind}
                    {c.verifiedById ? ' · verified' : ''}
                  </span>
                  {/* Which question this bears on. The extractor knows
                      what was said; only a person knows what we set out
                      to learn, so the join stays a human judgement. */}
                  <select
                    style={{ ...termInput, padding: '1px 4px', fontSize: 10, maxWidth: 200 }}
                    value={c.questionId || ''}
                    onChange={async (e) => {
                      await api
                        .post(`/research/claims/${c.id}/link`, {
                          questionId: e.target.value ? Number(e.target.value) : null,
                        })
                        .catch(() => {});
                      onChanged?.();
                    }}
                  >
                    <option value="">— answers no question yet —</option>
                    {(project.questions || []).map((q) => (
                      <option key={q.id} value={q.id}>{q.text.slice(0, 44)}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Interviews({ project, onChanged, setFlash }) {
  const [sources, setSources] = useState([]);
  const [form, setForm] = useState({ sourceId: '', title: '', consent: false });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/research/sources').then(({ data }) => setSources(data || [])).catch(() => {});
  }, []);

  async function create() {
    setSaving(true);
    try {
      await api.post('/research/interviews', {
        sourceId: form.sourceId,
        title: form.title,
        ticker: project.ticker,
        projectId: project.id,
        consentObtained: form.consent,
      });
      setForm({ sourceId: '', title: '', consent: false });
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Could not create' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select
            style={{ ...termInput, flex: '1 1 180px' }}
            value={form.sourceId}
            onChange={(e) => setForm({ ...form, sourceId: e.target.value })}
          >
            <option value="">Source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.alias}{s.employer ? ` — ${s.employer}` : ''}
              </option>
            ))}
          </select>
          <input
            style={{ ...termInput, flex: '2 1 200px' }}
            placeholder="Interview title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <label style={{ color: 'var(--term-fg-dim)', fontSize: 11, display: 'flex', gap: 6 }}>
          <input
            type="checkbox"
            checked={form.consent}
            onChange={(e) => setForm({ ...form, consent: e.target.checked })}
          />
          {/* Consent is checked before audio is accepted, not after —
              recording without it is unlawful in two-party states. */}
          Source consented to recording (required before audio upload)
        </label>
        <div>
          <TermButton onClick={create} disabled={saving || !form.sourceId || !form.title}>
            {saving ? 'Adding…' : 'Add interview'}
          </TermButton>
          <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, marginLeft: 8 }}>
            Add sources on the Field Research page.
          </span>
        </div>
      </div>

      {project.interviews.length === 0 ? (
        <div className="term-loading">No interviews on this project yet.</div>
      ) : (
        project.interviews.map((i) => (
          <InterviewRow key={i.id} interview={i} onChanged={onChanged} setFlash={setFlash} />
        ))
      )}
    </div>
  );
}

function InterviewRow({ interview: i, onChanged, setFlash }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState('');

  async function upload(file) {
    if (!file) return;
    setBusy('upload');
    setFlash(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/recording`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Compliance first, quality second. If the screen quarantined this
      // interview that is the only thing worth saying — the word count
      // is irrelevant next to it.
      const sc = data.screen || {};
      const parts = [`Transcribed ${data.wordCount} words, ${data.speakerCount} speakers.`];
      if (data.quarantined) {
        parts.unshift(`QUARANTINED — ${sc.reason}. Its claims cannot be cited until a person releases it.`);
      } else if (sc.risk === 'elevated') {
        parts.push(`MNPI screen: elevated — ${sc.reason}. Read it before extracting.`);
      } else if (sc.risk === 'low' && sc.modelAvailable === false) {
        // Do not let a keyword-only pass read as an all-clear.
        parts.push('MNPI screen ran on keywords only (model unavailable) — not a full clearance.');
      }
      if (data.diarizationWarning) parts.push(data.diarizationWarning);
      setFlash({
        bad: !!(data.quarantined || data.diarizationWarning || sc.risk === 'elevated'),
        text: parts.join(' '),
      });
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Upload failed' });
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function extract() {
    setBusy('extract');
    setFlash(null);
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/extract`);
      setFlash({
        bad: data.droppedUnlocatable > 0,
        text:
          `Extracted ${data.extracted} claims.` +
          (data.droppedUnlocatable
            ? ` ${data.droppedUnlocatable} discarded — quoted words not found in the transcript.`
            : ''),
      });
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Extraction failed' });
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--term-white)', fontSize: 12 }}>{i.title}</div>
          <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
            {i.source?.alias}
            {i.source?.employer ? ` · ${i.source.employer}` : ''} · {fmtDate(i.conductedAt)} ·{' '}
            {i.status} · {i._count?.claims ?? 0} claims
            {!i.consentObtained ? ' · NO CONSENT' : ''}
            {i.quarantined ? ' · QUARANTINED' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/*"
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <TermButton
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'upload' || !i.consentObtained}
            title={i.consentObtained ? 'Upload + transcribe' : 'Consent required first'}
          >
            {busy === 'upload' ? 'Transcribing…' : 'Audio'}
          </TermButton>
          <TermButton
            onClick={extract}
            disabled={busy === 'extract' || i.quarantined || i.status === 'Draft'}
          >
            {busy === 'extract' ? 'Extracting…' : 'Extract'}
          </TermButton>
        </div>
      </div>
    </div>
  );
}

function Files({ project, onChanged, setFlash, onOpenDoc }) {
  const fileRef = useRef(null);
  const [kind, setKind] = useState('document');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(file) {
    setBusy(true);
    setFlash(null);
    const form = new FormData();
    if (file) form.append('file', file);
    if (body) form.append('body', body);
    form.append('kind', kind);
    form.append('title', title || file?.name || 'Untitled');
    try {
      await api.post(`/research/projects/${project.id}/artifacts`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setTitle('');
      setBody('');
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Attach failed' });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select style={{ ...termInput, flex: '0 0 150px' }} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input
            style={{ ...termInput, flex: '1 1 200px' }}
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {/* Either shape works: paste a guide as text, or attach a file.
            Both become artifacts on the same list. */}
        <textarea
          style={{ ...termInput, resize: 'vertical', minHeight: 56 }}
          placeholder="Paste a guide, script or memo here — or attach a file instead"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => send(e.target.files?.[0])}
          />
          <TermButton onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : 'Attach file'}
          </TermButton>
          <TermButton onClick={() => send(null)} disabled={busy || !body || !title}>
            Save text
          </TermButton>
        </div>
      </div>

      {project.artifacts.length === 0 ? (
        <div className="term-loading">Nothing attached yet.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr><th>Kind</th><th>Title</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {project.artifacts.map((a) => (
              <tr key={a.id}>
                <td className="sym">{a.kind}</td>
                <td>
                  {a.fileRef ? (
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); onOpenDoc({ url: a.fileRef, title: a.title }); }}
                    >
                      {a.title}
                    </a>
                  ) : (
                    <details>
                      <summary style={{ cursor: 'pointer' }}>{a.title}</summary>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'inherit',
                          fontSize: 11,
                          color: 'var(--term-fg-dim)',
                          margin: '4px 0 0',
                        }}
                      >
                        {a.body}
                      </pre>
                    </details>
                  )}
                </td>
                <td>{fmtDate(a.createdAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <a
                    href="#"
                    style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}
                    onClick={async (e) => {
                      e.preventDefault();
                      await api.delete(`/research/artifacts/${a.id}`).catch(() => {});
                      onChanged();
                    }}
                  >
                    remove
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Coverage — what we set out to learn, and how much we actually know.
// The first thing you should see on opening a project, because "which
// questions are still open with nothing behind them" is next week's
// call list.
function Coverage({ project, onChanged }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState(null);
  const cov = project.coverage || { questions: [], summary: {} };
  const s = cov.summary || {};

  async function draftMemo() {
    setDrafting(true);
    setDraftNote(null);
    try {
      const { data } = await api.post(`/research/projects/${project.id}/synthesize`);
      setDraftNote({
        bad: data.removedCitations > 0,
        text:
          `Draft saved to Files — cites ${data.citedCount} of ${data.evidenceCount} claims.` +
          (data.removedCitations
            ? ` ${data.removedCitations} invented citation(s) were removed; read it closely.`
            : ''),
      });
      onChanged();
    } catch (e) {
      setDraftNote({ bad: true, text: e.response?.data?.error || 'Could not draft the memo' });
    } finally {
      setDrafting(false);
    }
  }

  async function add() {
    setSaving(true);
    try {
      await api.post(`/research/projects/${project.id}/questions`, {
        text,
        rank: (project.questions?.length || 0) + 1,
      });
      setText('');
      onChanged();
    } catch {
      /* leave the text in place to retry */
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id, status) {
    await api.patch(`/research/questions/${id}`, { status }).catch(() => {});
    onChanged();
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...termInput, flex: 1 }}
          placeholder="What do we need to find out? (one question)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text) add(); }}
        />
        <TermButton onClick={add} disabled={saving || !text}>Add</TermButton>
      </div>

      {cov.questions.length > 0 ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
          {s.supported || 0} supported · {s.thin || 0} thin ·{' '}
          {s.unaddressed || 0} no evidence
          {s.contested ? ` · ${s.contested} contested` : ''}
          {s.openAndUnaddressed
            ? ` — ${s.openAndUnaddressed} still open with nothing behind them`
            : ''}
          {s.unlinkedClaims
            ? ` · ${s.unlinkedClaims} claim${s.unlinkedClaims === 1 ? '' : 's'} answering something we never asked`
            : ''}
        </div>
      ) : null}

      {/* Drafting is only offered once there is evidence to draft from.
          A memo written from nothing is the single most misleading thing
          this system could produce. */}
      {project.claims.length > 0 || (project.visits || []).some((v) => v.siteObservations?.length) ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <TermButton onClick={draftMemo} disabled={drafting}>
            {drafting ? 'Drafting…' : 'Draft memo'}
          </TermButton>
          <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
            Writes only from this project's evidence, every sentence cited.
          </span>
        </div>
      ) : null}
      {draftNote ? (
        <div
          style={{
            fontSize: 11,
            color: draftNote.bad ? 'var(--term-negative)' : 'var(--term-positive)',
          }}
        >
          {draftNote.text}
        </div>
      ) : null}

      {cov.questions.length === 0 ? (
        <div className="term-loading">
          No questions yet. Write what the project is meant to answer before
          the calls start — it is what tells you when you are done.
        </div>
      ) : (
        cov.questions.map((q) => (
          <div
            key={q.questionId}
            style={{ borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: COVERAGE_COLOR[q.coverage], fontSize: 10, letterSpacing: 0.5 }}>
                {COVERAGE_LABEL[q.coverage]}
              </span>
              <span style={{ color: 'var(--term-white)', fontSize: 12, flex: 1, minWidth: 200 }}>
                {q.text}
              </span>
              <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
                {q.claimCount} claim{q.claimCount === 1 ? '' : 's'} ·{' '}
                {q.independentLines} independent
                {q.observationCount
                  ? ` · ${q.observationCount} observed at ${q.distinctLocations} site${q.distinctLocations === 1 ? '' : 's'}`
                  : ''}
                {q.forecastCount ? ` · ${q.forecastCount} forecast` : ''}
              </span>
              {/* Closing a question is a person's call. Coverage informs
                  it; it never makes it. */}
              <TermButton
                onClick={() => setStatus(q.questionId, q.status === 'Answered' ? 'Open' : 'Answered')}
                title={q.status === 'Answered' ? 'Reopen' : 'Mark answered'}
              >
                {q.status === 'Answered' ? 'Answered' : 'Mark answered'}
              </TermButton>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// Outreach — the front of the funnel. Without it there are no
// interviews, and "who haven't we tried yet" is what actually paces a
// project.
function Targets({ project, onChanged }) {
  const [f, setF] = useState({ name: '', relationship: 'FormerEmployee', employer: '', channel: '' });
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const fn = project.funnel || {};
  const open = (project.targets || []).find((t) => t.id === openId);

  // One person, everything we have on them. The list is for scanning;
  // this is for actually reading what was said — which is why the reply
  // and the email we sent live here in full rather than truncated.
  if (open) {
    return <TargetDetail target={open} onBack={() => setOpenId(null)} onChanged={onChanged} />;
  }

  async function add() {
    setSaving(true);
    try {
      await api.post(`/research/projects/${project.id}/targets`, f);
      setF({ name: '', relationship: 'FormerEmployee', employer: '', channel: '' });
      onChanged();
    } catch {
      /* keep the form */
    } finally {
      setSaving(false);
    }
  }

  async function move(id, status) {
    await api.patch(`/research/targets/${id}`, { status }).catch(() => {});
    onChanged();
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        {fn.Identified || 0} not yet tried · {fn.Contacted || 0} contacted ·{' '}
        {fn.Scheduled || 0} scheduled · {fn.Completed || 0} done ·{' '}
        {(fn.Declined || 0) + (fn.Unreachable || 0)} dead
        {fn.conversionPct != null ? ` · ${fn.conversionPct}% conversion` : ''}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          style={{ ...termInput, flex: '1 1 140px' }}
          placeholder="Name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <select
          style={{ ...termInput, flex: '0 0 150px' }}
          value={f.relationship}
          onChange={(e) => setF({ ...f, relationship: e.target.value })}
        >
          {['FormerEmployee', 'CurrentEmployee', 'Customer', 'Distributor', 'Supplier', 'Competitor', 'Landlord', 'IndustryExpert', 'Other'].map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input
          style={{ ...termInput, flex: '1 1 120px' }}
          placeholder="Employer"
          value={f.employer}
          onChange={(e) => setF({ ...f, employer: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '1 1 140px' }}
          placeholder="How to reach them"
          value={f.channel}
          onChange={(e) => setF({ ...f, channel: e.target.value })}
        />
        <TermButton onClick={add} disabled={saving || !f.name}>Add</TermButton>
      </div>

      {!project.targets || project.targets.length === 0 ? (
        <div className="term-loading">
          No targets yet. Map the value chain — former staff, distributors,
          customers, suppliers, competitors — then work the list.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Employer</th><th>Status</th><th>Last try</th></tr>
          </thead>
          <tbody>
            {project.targets.map((t) => (
              <tr key={t.id}>
                <td className="sym">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); setOpenId(t.id); }}
                    title="Open the full record"
                  >
                    {t.name}
                  </a>
                </td>
                <td>{t.relationship}</td>
                <td>{t.employer || '—'}</td>
                <td>
                  <select
                    style={{ ...termInput, padding: '1px 4px', fontSize: 11 }}
                    value={t.status}
                    onChange={(e) => move(t.id, e.target.value)}
                  >
                    {TARGET_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                </td>
                <td>{t.lastContactAt ? fmtDate(t.lastContactAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Site visits — going and looking rather than asking. For a retail name
// this is most of the fieldwork. Observations recorded here are counted
// toward question coverage but never merged with transcript claims:
// what someone saw has no tape to walk back to.
function Visits({ project, onChanged, setFlash }) {
  const [f, setF] = useState({ location: '', banner: '', dayPart: '', notes: '' });
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try {
      await api.post(`/research/projects/${project.id}/visits`, f);
      setF({ location: '', banner: '', dayPart: '', notes: '' });
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Could not log visit' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          style={{ ...termInput, flex: '2 1 200px' }}
          placeholder="Location — e.g. Store #1247, Atlantic Terminal"
          value={f.location}
          onChange={(e) => setF({ ...f, location: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '1 1 110px' }}
          placeholder="Banner"
          value={f.banner}
          onChange={(e) => setF({ ...f, banner: e.target.value })}
        />
        {/* Day-part is not optional colour: a Tuesday 11am traffic read
            says nothing about a Saturday, and comparing the two is how
            channel checks mislead. */}
        <input
          style={{ ...termInput, flex: '1 1 110px' }}
          placeholder="Day part (Sat 2pm)"
          value={f.dayPart}
          onChange={(e) => setF({ ...f, dayPart: e.target.value })}
        />
        <TermButton onClick={add} disabled={saving || !f.location}>Log visit</TermButton>
      </div>
      <textarea
        style={{ ...termInput, resize: 'vertical', minHeight: 48 }}
        placeholder="What did you see? Shelf state, pricing, staffing, traffic, stock gaps."
        value={f.notes}
        onChange={(e) => setF({ ...f, notes: e.target.value })}
      />

      {!project.visits || project.visits.length === 0 ? (
        <div className="term-loading">
          No visits logged. For a retail name this is most of the work —
          and three different stores beat three trips to one.
        </div>
      ) : (
        project.visits.map((v) => (
          <VisitRow key={v.id} visit={v} project={project} onChanged={onChanged} />
        ))
      )}
    </div>
  );
}

function VisitRow({ visit: v, project, onChanged }) {
  const [text, setText] = useState('');
  const [questionId, setQuestionId] = useState('');

  async function addObs() {
    await api
      .post(`/research/visits/${v.id}/observations`, { text, questionId: questionId || null })
      .catch(() => {});
    setText('');
    onChanged();
  }

  return (
    <div style={{ borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}>
      <div style={{ color: 'var(--term-white)', fontSize: 12 }}>
        {v.location}
        {v.banner ? <span style={{ color: 'var(--term-fg-muted)' }}> · {v.banner}</span> : null}
      </div>
      <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
        {fmtDate(v.visitedAt)}
        {v.dayPart ? ` · ${v.dayPart}` : ''}
        {v.visitor?.name ? ` · ${v.visitor.name}` : ''}
        {` · ${v.siteObservations?.length || 0} observation${v.siteObservations?.length === 1 ? '' : 's'}`}
      </div>
      {v.notes ? (
        <div style={{ color: 'var(--term-fg-dim)', fontSize: 11, marginTop: 2 }}>{v.notes}</div>
      ) : null}

      {(v.siteObservations || []).map((o) => (
        <div key={o.id} style={{ color: 'var(--term-fg-dim)', fontSize: 11, paddingLeft: 10 }}>
          · {o.text}
          {o.questionId ? (
            <span style={{ color: 'var(--term-positive)', fontSize: 10 }}> [linked]</span>
          ) : null}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input
          style={{ ...termInput, flex: 1, fontSize: 11 }}
          placeholder="Add an observation"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text) addObs(); }}
        />
        <select
          style={{ ...termInput, flex: '0 0 160px', fontSize: 11 }}
          value={questionId}
          onChange={(e) => setQuestionId(e.target.value)}
        >
          <option value="">Not linked</option>
          {(project.questions || []).map((q) => (
            <option key={q.id} value={q.id}>{q.text.slice(0, 40)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Everything held on one outreach contact.
//
// The notes field carries the whole correspondence in labelled sections —
// why they were approached, the email sent, their reply, the outcome —
// because a list row can only ever show a summary, and the reply is the
// part that decides what to do next. Rendered as sections rather than a
// wall of text so the reply is findable at a glance.
function TargetDetail({ target: t, onBack, onChanged }) {
  const [status, setStatus] = useState(t.status);
  const [saving, setSaving] = useState(false);

  // Notes are stored as "HEADING\ntext" blocks separated by blank lines.
  // Anything that doesn't match that shape is shown as-is rather than
  // dropped — an older record should still be readable.
  const sections = String(t.notes || '')
    .split(/\n\n+/)
    .map((block) => {
      const nl = block.indexOf('\n');
      const head = nl > 0 ? block.slice(0, nl) : null;
      const isHeading = head && /^[A-Z][A-Z \-/&]{3,}$/.test(head.trim());
      return isHeading
        ? { heading: head.trim(), body: block.slice(nl + 1).trim() }
        : { heading: null, body: block.trim() };
    })
    .filter((s) => s.body);

  async function move(next) {
    setSaving(true);
    setStatus(next);
    await api.patch(`/research/targets/${t.id}`, { status: next }).catch(() => {});
    setSaving(false);
    onChanged();
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TermButton onClick={onBack}>← Outreach</TermButton>
        <select
          style={{ ...termInput, flex: '0 0 150px' }}
          value={status}
          disabled={saving}
          onChange={(e) => move(e.target.value)}
        >
          {TARGET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="term-panel-header">
        <span className="name">{t.name}</span>
      </div>

      <div style={{ color: 'var(--term-fg-dim)', fontSize: 12 }}>
        {[t.role, t.employer].filter(Boolean).join(' · ') || 'No title or employer recorded'}
      </div>
      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        {t.relationship}
        {t.channel ? ` · ${t.channel}` : ''}
        {t.lastContactAt ? ` · last contact ${fmtDate(t.lastContactAt)}` : ' · never contacted'}
      </div>

      {sections.length === 0 ? (
        <div className="term-loading">Nothing recorded beyond the name.</div>
      ) : (
        sections.map((s, i) => (
          <div key={i}>
            {s.heading ? (
              <div
                style={{
                  color: 'var(--term-amber, var(--term-white))',
                  fontSize: 10,
                  letterSpacing: 0.6,
                  marginBottom: 2,
                }}
              >
                {s.heading}
              </div>
            ) : null}
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--term-fg-dim)',
                margin: 0,
                // The sent email runs long; cap it so the reply below
                // stays reachable without a scroll hunt.
                maxHeight: 260,
                overflowY: 'auto',
                borderLeft: '2px solid var(--term-border)',
                paddingLeft: 8,
              }}
            >
              {s.body}
            </pre>
          </div>
        ))
      )}
    </div>
  );
}
