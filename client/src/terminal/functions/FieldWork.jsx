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

      <ComplianceStrip interviews={p.interviews} onOpen={() => setTab('mnpi')} />

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
          ['mnpi', 'Compliance'],
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
      {tab === 'mnpi' ? <Compliance project={p} onChanged={load} /> : null}
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

const RELATIONSHIPS = [
  ['FormerEmployee', 'Former employee'],
  ['CurrentEmployee', 'Current employee'],
  ['Customer', 'Customer'],
  ['Distributor', 'Distributor / retailer'],
  ['Supplier', 'Supplier'],
  ['Competitor', 'Competitor'],
  ['IndustryExpert', 'Industry expert'],
  ['Other', 'Other'],
];

// Alias is what appears in every citation; the real name never leaves
// the server. Relationship is not bookkeeping — a current employee
// starts the interview at elevated MNPI risk on the strength of this
// field alone, which is why it is required and not free text.
function NewSource({ ticker, onDone }) {
  const [f, setF] = useState({ alias: '', fullName: '', role: '', employer: '', relationship: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const { data } = await api.post('/research/sources', {
        ...f,
        tickers: ticker ? [ticker] : [],
      });
      onDone(data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not add the source');
      setSaving(false);
    }
  }

  return (
    <div style={{ border: '1px solid var(--term-border)', padding: 8, display: 'grid', gap: 6 }}>
      <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5 }}>
        NEW SOURCE
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          style={{ ...termInput, flex: '1 1 150px' }}
          placeholder="Alias — how they appear in citations"
          value={f.alias}
          onChange={(e) => setF({ ...f, alias: e.target.value })}
        />
        <select
          style={{ ...termInput, flex: '1 1 150px' }}
          value={f.relationship}
          onChange={(e) => setF({ ...f, relationship: e.target.value })}
        >
          <option value="">Relationship to the company…</option>
          {RELATIONSHIPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          style={{ ...termInput, flex: '1 1 130px' }}
          placeholder="Real name (never cited)"
          value={f.fullName}
          onChange={(e) => setF({ ...f, fullName: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '1 1 110px' }}
          placeholder="Role"
          value={f.role}
          onChange={(e) => setF({ ...f, role: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '1 1 110px' }}
          placeholder="Employer"
          value={f.employer}
          onChange={(e) => setF({ ...f, employer: e.target.value })}
        />
      </div>
      {err ? <div style={{ color: 'var(--term-negative)', fontSize: 11 }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <TermButton onClick={save} disabled={saving || !f.alias || !f.relationship}>
          {saving ? 'Adding…' : 'Add source'}
        </TermButton>
        <TermButton onClick={() => onDone(null)} disabled={saving}>Cancel</TermButton>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
          Only the alias is ever cited.
        </span>
      </div>
    </div>
  );
}

function Interviews({ project, onChanged, setFlash }) {
  const [sources, setSources] = useState([]);
  const [form, setForm] = useState({ sourceId: '', title: '', consent: false, attested: false });
  const [saving, setSaving] = useState(false);
  const [newSource, setNewSource] = useState(false);

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
        attested: form.attested,
      });
      setForm({ sourceId: '', title: '', consent: false, attested: false });
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Could not create' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {newSource ? (
        <NewSource
          ticker={project.ticker}
          onDone={(created) => {
            setNewSource(false);
            if (created) {
              setSources((prev) => [created, ...prev]);
              setForm((f) => ({ ...f, sourceId: String(created.id) }));
            }
          }}
        />
      ) : null}
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select
            style={{ ...termInput, flex: '1 1 180px' }}
            value={form.sourceId}
            onChange={(e) => {
              if (e.target.value === '__new') { setNewSource(true); return; }
              setForm({ ...form, sourceId: e.target.value });
            }}
          >
            <option value="">Source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.alias}{s.employer ? ` — ${s.employer}` : ''}
              </option>
            ))}
            {/* You meet the source before you log them. Sending someone
                to another page to write down who they just spoke to is
                how a call ends up never being recorded at all. */}
            <option value="__new">+ someone new…</option>
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
        {/* The attestation is the part that changes behaviour. The
            screen reads the transcript afterwards; this is read before
            the call, which is when it can still stop a question being
            asked. */}
        <label style={{ color: 'var(--term-fg-dim)', fontSize: 11, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={form.attested}
            onChange={(e) => setForm({ ...form, attested: e.target.checked })}
            style={{ marginTop: 2 }}
          />
          <span>
            I will not ask for material non-public information.
            <span style={{ color: 'var(--term-fg-muted)' }}>
              {' '}Off limits: unreleased results, guidance not yet issued,
              unannounced deals or contracts, pending regulatory action,
              departures not yet public. Their own commercial terms, what
              they observed, and industry conditions are all fair game.
            </span>
          </span>
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
  const [pasting, setPasting] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [text, setText] = useState('');
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

  async function importText() {
    setBusy('text');
    setFlash(null);
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/transcript`, { text });
      const bits = [`Imported ${data.wordCount ?? ''} words.`.replace('  ', ' ')];
      // The screen runs on the way in, and its verdict is the thing
      // worth saying — an import that quietly landed something flagged
      // would be the whole point of the screen defeated.
      if (data.mnpiRisk && data.mnpiRisk !== 'low') {
        bits.push(`MNPI screen: ${String(data.mnpiRisk).toUpperCase()}. See Compliance.`);
      }
      setFlash({ bad: data.quarantined, text: bits.join(' ') });
      setText('');
      setPasting(false);
      onChanged();
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Could not import the transcript' });
    } finally {
      setBusy(null);
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
          {/* Not every conversation is a recording. Plenty are a call
              you took notes on, or a transcript that already exists
              somewhere else — and without a way in, those never become
              evidence at all. */}
          <TermButton
            onClick={() => { setPasting((v) => !v); setViewing(false); }}
            disabled={!i.consentObtained}
            title={i.consentObtained ? 'Paste a transcript or your notes' : 'Consent required first'}
          >
            {pasting ? 'Cancel' : 'Text'}
          </TermButton>
          {i.transcript ? (
            <TermButton
              onClick={() => { setViewing((v) => !v); setPasting(false); }}
              title="Read the transcript"
            >
              {viewing ? 'Hide' : 'Transcript'}
            </TermButton>
          ) : null}
          <TermButton
            onClick={extract}
            disabled={busy === 'extract' || i.quarantined || i.status === 'Draft'}
          >
            {busy === 'extract' ? 'Extracting…' : 'Extract'}
          </TermButton>
        </div>
      </div>

      {pasting ? (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <textarea
            style={{ ...termInput, resize: 'vertical', minHeight: 120 }}
            placeholder={'Paste the transcript, or type up what was said.\n\n[00:00] Speaker 0: …\n[00:14] Speaker 1: …\n\nTimestamps are read per turn if you have them. Without them the whole thing lands as one turn, which still cites but cannot point at a moment.'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <TermButton onClick={importText} disabled={busy === 'text' || !text.trim()}>
              {busy === 'text' ? 'Importing…' : 'Save transcript'}
            </TermButton>
            <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
              Screened for MNPI on the way in, the same as a recording.
            </span>
          </div>
        </div>
      ) : null}

      {viewing ? (
        <pre
          style={{
            marginTop: 6, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap',
            color: 'var(--term-fg-dim)', fontSize: 11, fontFamily: 'inherit',
            border: '1px solid var(--term-border)', padding: 8,
          }}
        >
          {i.transcript}
        </pre>
      ) : null}
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
  const [openQ, setOpenQ] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState(null);
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

  // Re-reads every transcript asking each unanswered question directly.
  // The extractor sweeps for what is substantive and links afterwards,
  // which misses answers that do not read as assertions — "pack the
  // whole thing" is not a claim about anything until you know it was the
  // reply to how many units go back on the shelf.
  // One request per question, not one for the lot.
  //
  // Reading seventeen transcripts against one question is already a
  // minute of model time; doing it for every open question in a single
  // request runs past the proxy's patience and comes back 502 with
  // nothing to show for the work already done. Looping keeps each
  // request short, lets the count climb while it runs, and means a
  // question that times out costs only itself.
  async function scanAnswers() {
    const open = (cov.questions || []).filter((q) => q.claimCount === 0);
    if (open.length === 0) {
      setScanNote({ text: 'Every question already has evidence behind it.' });
      return;
    }
    setScanning(true);
    setScanNote(null);
    let found = 0;
    let created = 0;
    let linked = 0;
    let failed = 0;
    for (const [n, q] of open.entries()) {
      setScanNote({ text: `Reading the tape against question ${n + 1} of ${open.length}…` });
      try {
        const { data } = await api.post(`/research/projects/${project.id}/answer-scan`, {
          questionIds: [q.questionId],
        });
        if (data.found) found += 1;
        created += data.created || 0;
        linked += data.linkedExisting || 0;
      } catch {
        // A question that times out or errors costs only itself, but it
        // has NOT been searched and must not be counted as searched.
        failed += 1;
      }
    }
    setScanNote({
      bad: failed > 0 && found === 0,
      text:
        (found === 0
          ? `No answers in the tape for ${open.length - failed} question${open.length - failed === 1 ? '' : 's'}. They are genuinely unasked or unanswered.`
          : `Answered ${found} of ${open.length - failed} (${created} new, ${linked} already extracted but never linked).`) +
        (failed ? ` ${failed} question${failed === 1 ? '' : 's'} could not be searched — re-run to cover ${failed === 1 ? 'it' : 'them'}.` : ''),
    });
    setScanning(false);
    onChanged();
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

      {(s.unaddressed || 0) > 0 && project.interviews?.some((i) => i.transcript) ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <TermButton onClick={scanAnswers} disabled={scanning}>
            {scanning ? 'Reading transcripts…' : `Scan tape for the ${s.unaddressed} unanswered`}
          </TermButton>
          <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
            Asks each one against every transcript. Quotes still have to locate.
          </span>
        </div>
      ) : null}
      {scanNote ? (
        <div
          style={{
            fontSize: 11,
            color: scanNote.bad ? 'var(--term-negative)' : 'var(--term-fg-muted)',
          }}
        >
          {scanNote.text}
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
              {/* A coverage label is a summary of evidence, and a summary
                  nobody can open is just an assertion. One click gets to
                  the words somebody actually said. */}
              <span
                onClick={() => setOpenQ(openQ === q.questionId ? null : q.questionId)}
                style={{
                  color: 'var(--term-white)', fontSize: 12, flex: 1, minWidth: 200,
                  cursor: q.claimCount ? 'pointer' : 'default',
                }}
                title={q.claimCount ? 'Show the evidence' : undefined}
              >
                {q.claimCount ? (openQ === q.questionId ? '▾ ' : '▸ ') : ''}
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

            {/* The answer itself, not just a count of answers. A row
                reading "SUPPORTED · 3 claims" tells you a question was
                answered without telling you what the answer was, which
                is the only part anyone actually wants. Show the best one
                inline; the rest are a click away. */}
            {openQ !== q.questionId && q.claimCount > 0 ? (() => {
              const top = (project.claims || [])
                .filter((c) => c.questionId === q.questionId)
                .sort((a, b) => (b.extractionConfidence || 0) - (a.extractionConfidence || 0))[0];
              if (!top) return null;
              return (
                <div style={{ fontSize: 11, paddingLeft: 14, marginTop: 2 }}>
                  <span style={{ color: 'var(--term-white)' }}>{top.text}</span>
                  {top.quote ? (
                    <span style={{ color: 'var(--term-fg-muted)', fontStyle: 'italic' }}>
                      {' '}— “{top.quote.length > 90 ? `${top.quote.slice(0, 90)}…` : top.quote}”
                    </span>
                  ) : null}
                  {q.claimCount > 1 ? (
                    <span style={{ color: 'var(--term-fg-muted)' }}>
                      {' '}+{q.claimCount - 1} more
                    </span>
                  ) : null}
                </div>
              );
            })() : null}

            {openQ === q.questionId ? (
              <div style={{ display: 'grid', gap: 6, margin: '6px 0 4px 14px' }}>
                {(project.claims || [])
                  .filter((c) => c.questionId === q.questionId)
                  .map((c) => (
                    <div key={c.id} style={{ fontSize: 11 }}>
                      <span style={{ color: 'var(--term-fg-muted)' }}>
                        {c.origin === 'answer-scan' ? 'scan' : 'extract'}
                        {c.topic === 'answer (partial)' ? ' · answers part of it' : ''}
                        {' · '}{c.stamp}
                      </span>
                      <div style={{ color: 'var(--term-white)' }}>{c.text}</div>
                      {c.quote ? (
                        <div style={{ color: 'var(--term-fg-muted)', fontStyle: 'italic' }}>
                          “{c.quote}”
                        </div>
                      ) : null}
                      <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
                        {c.citation}
                      </div>
                    </div>
                  ))}
              </div>
            ) : null}
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

// Compliance at a glance, above the tabs.
//
// The MNPI screen runs on every transcript at ingest, but its result
// only lived on individual interview rows — so a project could hold a
// quarantined interview and nothing said so until you went looking.
// Compliance state is the kind of thing that has to be visible without
// being asked for, because the failure mode is someone citing evidence
// they were never allowed to use.
function ComplianceStrip({ interviews, onOpen }) {
  const list = interviews || [];
  if (list.length === 0) return null;

  const quarantined = list.filter((i) => i.quarantined);
  const elevated = list.filter((i) => !i.quarantined && i.mnpiRisk === 'elevated');
  const unscreened = list.filter((i) => !i.screenedAt);
  const noConsent = list.filter((i) => !i.consentObtained);

  // Silence is the normal state and should read as reassurance, not as
  // an absence of checking.
  const clean =
    !quarantined.length && !elevated.length && !unscreened.length && !noConsent.length;

  // A count with no way through to the thing counted is a dead end: the
  // strip said ELEVATED: 1 and there was no route from there to which
  // interview, or why. Every chip now opens the panel that explains it.
  const chip = (label, n, color, title) =>
    n > 0 ? (
      <span
        title={`${title} Click to review.`}
        onClick={onOpen}
        style={{ color, fontSize: 10, letterSpacing: 0.5, marginRight: 12, cursor: 'pointer', textDecoration: 'underline dotted' }}
      >
        {label}: {n}
      </span>
    ) : null;

  return (
    <div
      style={{
        borderTop: '1px solid var(--term-border)',
        borderBottom: '1px solid var(--term-border)',
        padding: '4px 0',
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5, marginRight: 12 }}>
        MNPI
      </span>
      {clean ? (
        <span style={{ color: 'var(--term-positive)', fontSize: 10, letterSpacing: 0.5 }}>
          {list.length} interview{list.length === 1 ? '' : 's'} screened · none flagged
        </span>
      ) : (
        <>
          {chip('QUARANTINED', quarantined.length, 'var(--term-negative)',
            'Screened as containing material non-public information. Claims excluded from the ledger and from any memo.')}
          {chip('ELEVATED', elevated.length, 'var(--term-amber, var(--term-white))',
            'Brushes something sensitive, or the source is a current employee. Read before citing.')}
          {chip('UNSCREENED', unscreened.length, 'var(--term-amber, var(--term-white))',
            'No MNPI screen has run on this transcript yet.')}
          {chip('NO CONSENT', noConsent.length, 'var(--term-negative)',
            'Consent to record was never recorded for this interview.')}
          <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
            of {list.length}
          </span>
        </>
      )}
    </div>
  );
}

// What the screen caught, and nothing else.
//
// The first version of this listed every interview missing an
// attestation and asked the reader to write what they concluded about
// each one. That inverted the job: the model is supposed to do the
// catching, and seventeen empty note boxes buried the single interview
// that had actually been flagged. Now the panel states the finding, shows
// the phrase that tripped it, and offers one decision.
function Compliance({ project, onChanged }) {
  const list = project.interviews || [];
  // Missing attestation is a pre-call gap, not a review item — it says
  // nothing about whether this transcript contains anything wrong.
  const flagged = list.filter(
    (i) => !i.reviewedAt && (i.quarantined || i.mnpiRisk !== 'low' || !i.consentObtained || !i.screenedAt)
  );
  const noAttestation = list.filter((i) => !i.attestedAt).length;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {flagged.length === 0 ? (
        <div style={{ color: 'var(--term-positive)', fontSize: 12 }}>
          Screened {list.length} interview{list.length === 1 ? '' : 's'}. Nothing flagged
          — no material non-public information found, consent recorded throughout.
        </div>
      ) : (
        <>
          <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
            The screen flagged {flagged.length} of {list.length} interview
            {list.length === 1 ? '' : 's'}. Everything else came back clean.
          </div>
          {flagged.map((i) => (
            <ComplianceRow key={i.id} interview={i} onChanged={onChanged} />
          ))}
        </>
      )}

      {noAttestation > 0 ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}>
          {noAttestation} interview{noAttestation === 1 ? '' : 's'} carry no pre-call
          attestation. These were imported, so there was no call to attest to —
          new interviews opened here record one.
        </div>
      ) : null}
    </div>
  );
}

function ComplianceRow({ interview: i, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const screen = i.screenResult || {};

  async function rescreen() {
    setBusy(true);
    try {
      await api.post(`/research/interviews/${i.id}/screen`);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function decide(action) {
    setBusy(true);
    try {
      await api.post(`/research/interviews/${i.id}/review`, {
        note: note || null,
        release: action === 'release',
        quarantine: action === 'quarantine',
      });
      onChanged();
    } catch {
      setBusy(false);
    }
  }

  // Lead with what the model found, in its words.
  //
  // The last fallback used to read "Flagged for review", which is the
  // one thing a reviewer cannot act on: a risk level and no reason for
  // it. That is exactly the state interviews ingested before the screen
  // recorded its findings are in, and the elevated one in the Lindt
  // project sat there with nothing behind the word. Say plainly that the
  // reason was never stored, and offer to go and get it.
  const noFinding = !screen.reason && !i.quarantineNote && i.consentObtained && i.screenedAt;
  const finding =
    screen.reason ||
    i.quarantineNote ||
    (!i.consentObtained ? 'No consent to record was captured for this interview.' : null) ||
    (!i.screenedAt ? 'This transcript has not been screened yet.' : null) ||
    `Risk is ${String(i.mnpiRisk).toUpperCase()} but no reason was recorded — this interview was screened before findings were stored. Re-screen it before deciding.`;

  return (
    <div style={{ borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span
          style={{
            color: i.quarantined ? 'var(--term-negative)' : 'var(--term-amber, var(--term-white))',
            fontSize: 10, letterSpacing: 0.5,
          }}
        >
          {i.quarantined ? 'QUARANTINED' : !i.consentObtained ? 'NO CONSENT' : `MNPI ${String(i.mnpiRisk).toUpperCase()}`}
        </span>
        <span style={{ color: 'var(--term-white)', fontSize: 12 }}>{i.title}</span>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
          {i.source?.alias}
          {i.source?.relationship === 'CurrentEmployee' ? ' · current employee' : ''}
        </span>
      </div>

      <div style={{ color: 'var(--term-fg-dim)', fontSize: 11, marginTop: 2 }}>{finding}</div>

      {/* The phrases that tripped the keyword pass, so the reader can
          judge without opening the transcript. */}
      {(screen.hits || []).slice(0, 3).map((h, n) => (
        <div key={n} style={{ color: 'var(--term-fg-muted)', fontSize: 10, paddingLeft: 8 }}>
          · {h.why}: “{String(h.excerpt).slice(0, 110)}”
        </div>
      ))}
      {screen.modelAvailable === false ? (
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, paddingLeft: 8 }}>
          · keyword pass only — the model was unavailable, so this is not a full clearance
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Offered first where there is no finding: deciding is the wrong
            next action when nothing has told you what you are deciding
            about. */}
        {noFinding || screen.modelAvailable === false ? (
          <TermButton onClick={rescreen} disabled={busy}>
            {busy ? 'Screening…' : 'Re-screen'}
          </TermButton>
        ) : null}
        <TermButton onClick={() => decide(i.quarantined ? 'release' : 'note')} disabled={busy}>
          {i.quarantined ? 'Release' : 'Cleared'}
        </TermButton>
        {!i.quarantined ? (
          <TermButton onClick={() => decide('quarantine')} disabled={busy}>Quarantine</TermButton>
        ) : null}
        <a
          href="#"
          style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}
          onClick={(e) => { e.preventDefault(); setShowNote((v) => !v); }}
        >
          {showNote ? 'hide note' : 'add a note'}
        </a>
        {showNote ? (
          <input
            style={{ ...termInput, flex: '1 1 200px', fontSize: 11 }}
            placeholder="Optional — why you decided that"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        ) : null}
      </div>
    </div>
  );
}
