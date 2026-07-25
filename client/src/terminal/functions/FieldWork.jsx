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
  const [tab, setTab] = useState('ledger');
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
          ['ledger', `Ledger (${p.claims.length})`],
          ['interviews', `Interviews (${p.interviews.length})`],
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

      {tab === 'ledger' ? <Ledger project={p} /> : null}
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

function Ledger({ project }) {
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
                <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
                  {c.citation} · {c.kind}
                  {c.verifiedById ? ' · verified' : ''}
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
      setFlash({
        bad: !!data.diarizationWarning,
        text: data.diarizationWarning
          ? `Transcribed ${data.wordCount} words. ${data.diarizationWarning}`
          : `Transcribed ${data.wordCount} words, ${data.speakerCount} speakers.`,
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
