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
  ['model', 'Valuation model / DCF'],
  ['filing', 'Filing or earnings call'],
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
        <span className="name">Research</span>
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

      <ProjectStatus project={p} />

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
          // Counts on a tab should say where the work is, not how much
          // furniture is behind it. "Questions (31)" is the size of the
          // guide; the number worth surfacing is how many still have
          // nothing against them.
          ['coverage', `Questions (${p.questions?.length ?? 0})`, p.coverage?.summary?.unaddressed || 0],
          // A draft waiting on YOUR signature is the one thing here that
          // blocks someone else, so it outranks the funnel count. Falls
          // back to "ready to send" when nothing needs this reader.
          [
            'targets',
            `Outreach (${p.funnel?.total ?? 0})`,
            p.outreachQueue?.awaitingMe || p.outreachQueue?.readyToSend || 0,
          ],
          ['interviews', `Interviews (${p.interviews.length})`],
          ['visits', `Visits (${p.visits?.length ?? 0})`],
          ['valuation', `Valuation (${p.valuations?.length ?? 0})`],
          ['ledger', `Ledger (${p.claims.length})`],
          ['files', `Files (${p.artifacts.length})`],
          [
            'mnpi',
            'Compliance',
            (p.interviews || []).filter(
              (i) => !i.reviewedAt && (i.quarantined || i.mnpiRisk !== 'low' || !i.consentObtained)
            ).length,
          ],
        ].map(([k, label, pending]) => (
          <button
            key={k}
            className={`term-tab${tab === k ? ' active' : ''}`}
            onClick={() => setTab(k)}
            title={pending ? `${pending} outstanding` : undefined}
          >
            {label}
            {pending ? <span className="term-tab-n"> {pending}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'coverage' ? <Coverage project={p} onChanged={load} /> : null}
      {tab === 'valuation' ? <Valuation project={p} onChanged={load} setFlash={setFlash} /> : null}
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
  // Linking a claim to a question is a per-claim dropdown, which is fine
  // for six claims and useless for seventy: the two dozen that answer
  // nothing yet are scattered through the topics and there was no way to
  // see them as a set. They are the actual work queue.
  const [only, setOnly] = useState('all');
  const unlinked = project.claims.filter((c) => !c.questionId).length;
  const unverified = project.claims.filter((c) => !c.verifiedById).length;

  if (project.claims.length === 0) {
    return (
      <div className="term-loading">
        No claims yet. Add an interview, upload the recording, then extract.
      </div>
    );
  }
  const match = (c) =>
    only === 'all' ||
    (only === 'unlinked' && !c.questionId) ||
    (only === 'unverified' && !c.verifiedById) ||
    (only === 'scan' && c.origin === 'answer-scan');

  const byTopic = new Map();
  for (const c of project.claims) {
    if (!match(c)) continue;
    const k = c.topic || '(untopiced)';
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(c);
  }
  const shown = [...byTopic.values()].reduce((n, a) => n + a.length, 0);

  const chip = (key, label) => (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); setOnly(key); }}
      style={{
        fontSize: 10, letterSpacing: 0.5, marginRight: 10,
        color: only === key ? 'var(--term-white)' : 'var(--term-fg-muted)',
        textDecoration: only === key ? 'underline' : 'none',
      }}
    >
      {label}
    </a>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        {chip('all', `ALL ${project.claims.length}`)}
        {chip('unlinked', `ANSWERS NOTHING ASKED ${unlinked}`)}
        {chip('unverified', `NOT LISTENED BACK ${unverified}`)}
        {chip('scan', 'FOUND BY SCAN')}
        {only !== 'all' && shown === 0 ? (
          <span style={{ color: 'var(--term-positive)', fontSize: 11 }}>— none, nothing to do here</span>
        ) : null}
      </div>
      {project.topics.map((t) =>
        (byTopic.get(t.topic) || []).length === 0 ? null : (
        <div key={t.topic}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--term-white)', fontWeight: 700 }}>{t.topic}</span>
            <span style={{ color: SUPPORT_COLOR[t.support], fontSize: 10, letterSpacing: 0.5 }}>
              {SUPPORT_LABEL[t.support] || t.support}
            </span>
            {/* Triangulation is computed across the whole topic, so with
                a filter on it would sit above a subset and describe
                something the reader cannot see. Say what is shown
                instead of implying the corroboration applies to it. */}
            <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
              {only === 'all' ? (
                <>
                  {t.distinctSources} src · {t.independentLines} independent
                  {t.opinionCount ? ` · ${t.opinionCount} opinion` : ''}
                  {t.forecastCount ? ` · ${t.forecastCount} forecast` : ''}
                </>
              ) : (
                `${(byTopic.get(t.topic) || []).length} of ${t.claimCount ?? '?'} shown · support is for the whole topic`
              )}
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
        )
      )}
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
            Pick a source, or add someone new above.
          </span>
        </div>
      </div>

      {project.interviews.length === 0 ? (
        <div className="term-loading">No interviews on this project yet.</div>
      ) : (
        <>
          {/* What the list owes you, before scrolling it. */}
          {(() => {
            const iv = project.interviews;
            const noTranscript = iv.filter((x) => !x.quarantined && !x.transcript).length;
            const notExtracted = iv.filter(
              (x) => !x.quarantined && x.transcript && (x._count?.claims ?? 0) === 0
            ).length;
            if (!noTranscript && !notExtracted) return null;
            return (
              <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
                {noTranscript ? `${noTranscript} awaiting a transcript` : ''}
                {noTranscript && notExtracted ? ' · ' : ''}
                {notExtracted ? `${notExtracted} transcribed but never extracted` : ''}
              </div>
            );
          })()}
          {project.interviews.map((i) => (
            <InterviewRow key={i.id} interview={i} onChanged={onChanged} setFlash={setFlash} />
          ))}
        </>
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
    <div
      style={{
        borderTop: '1px dotted var(--term-border)',
        // The state of an interview is the thing you scan this list for
        // — which ones still owe you work — and it was a word buried in
        // a muted meta line between the employer and the claim count.
        borderLeft: `2px solid ${
          i.quarantined || !i.consentObtained
            ? 'var(--term-negative)'
            : !i.transcript
            ? 'var(--term-amber, var(--term-white))'
            : (i._count?.claims ?? 0) === 0
            ? 'var(--term-amber, var(--term-white))'
            : 'var(--term-positive)'
        }`,
        paddingTop: 6,
        paddingLeft: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--term-white)', fontSize: 12 }}>
            {i.title}
            {/* What this row still needs, in the words of the next
                action rather than a status noun. "Transcribed" does not
                tell you that nothing has been pulled out of it yet. */}
            {i.quarantined ? (
              <span style={{ color: 'var(--term-negative)', fontSize: 10 }}> · QUARANTINED</span>
            ) : !i.consentObtained ? (
              <span style={{ color: 'var(--term-negative)', fontSize: 10 }}> · NO CONSENT</span>
            ) : !i.transcript ? (
              <span style={{ color: 'var(--term-amber, var(--term-white))', fontSize: 10 }}> · needs a transcript</span>
            ) : (i._count?.claims ?? 0) === 0 ? (
              <span style={{ color: 'var(--term-amber, var(--term-white))', fontSize: 10 }}> · not extracted yet</span>
            ) : null}
          </div>
          <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
            {i.source?.alias}
            {i.source?.employer ? ` · ${i.source.employer}` : ''} · {fmtDate(i.conductedAt)}
            {' · '}
            <span style={{ color: (i._count?.claims ?? 0) ? 'var(--term-white)' : undefined }}>
              {i._count?.claims ?? 0} claims
            </span>
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

// What the work concluded a share is worth, and what it assumed.
//
// Three cases rather than one number, because a single point estimate
// hides how much of the answer is the assumptions — and the assumptions
// sit underneath where they can be read. An assumption that cites a claim
// came off a recording at a timestamp; one that cites nothing is a figure
// somebody chose. Both are legitimate and they must not look alike.
const VAL_KINDS = [
  ['dcf', 'DCF'],
  ['merger', 'Merger / M&A'],
  ['comps', 'Comps'],
  ['other', 'Other'],
];

// The inputs each kind of model actually turns on. Offered as a starting
// set so the assumption list is not a blank box — a merger model is
// asking what multiple was paid, not what the cash flows are worth.
const SUGGESTED = {
  dcf: ['Revenue growth', 'EBIT margin', 'WACC', 'Terminal growth', 'Tax rate', 'Shares out'],
  merger: ['Offer price', 'P/E paid', 'Target P/E before', 'EV/EBITDA paid', 'Premium to undisturbed', 'Synergies', 'Accretion / dilution'],
  comps: ['Peer P/E', 'Peer EV/EBITDA', 'Our P/E', 'Growth vs peers'],
  other: ['P/E', 'Growth'],
};

const money = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`);

function upside(target, ref) {
  if (target == null || !ref) return null;
  return ((Number(target) - Number(ref)) / Number(ref)) * 100;
}

function Valuation({ project, onChanged, setFlash }) {
  const [adding, setAdding] = useState(false);
  const list = project.valuations || [];

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {adding ? (
        <ValuationForm
          project={project}
          onDone={(saved) => { setAdding(false); if (saved) onChanged(); }}
          setFlash={setFlash}
        />
      ) : (
        <div>
          <TermButton onClick={() => setAdding(true)}>+ New valuation</TermButton>
        </div>
      )}

      {list.length === 0 ? (
        <div className="term-loading">
          No valuation yet. The spreadsheet can go in Files — this is the
          part someone can argue with without opening it.
        </div>
      ) : (
        list.map((v) => <ValuationRow key={v.id} v={v} project={project} onChanged={onChanged} />)
      )}
    </div>
  );
}

function ValuationRow({ v, project, onChanged }) {
  const [open, setOpen] = useState(false);
  const ref = v.priceAtWrite;
  const claimById = new Map((project.claims || []).map((c) => [c.id, c]));
  const kindLabel = (VAL_KINDS.find(([k]) => k === v.kind) || [null, v.kind])[1];

  async function remove() {
    await api.delete(`/research/valuations/${v.id}`).catch(() => {});
    onChanged();
  }

  const cell = (label, val) => {
    const up = upside(val, ref);
    return (
      <div style={{ minWidth: 92 }}>
        <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5 }}>{label}</div>
        <div style={{ color: 'var(--term-white)', fontSize: 13 }}>{money(val)}</div>
        {up === null ? null : (
          <div style={{ fontSize: 10, color: up >= 0 ? 'var(--term-positive)' : 'var(--term-negative)' }}>
            {up >= 0 ? '+' : ''}{up.toFixed(0)}%
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ borderTop: '1px dotted var(--term-border)', paddingTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5 }}>
          {String(kindLabel).toUpperCase()}
        </span>
        <span style={{ color: 'var(--term-white)', fontSize: 12, flex: 1, minWidth: 160 }}>{v.name}</span>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
          {fmtDate(v.asOf)}{v.createdBy?.name ? ` · ${v.createdBy.name}` : ''}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 18, marginTop: 4, flexWrap: 'wrap' }}>
        {cell('BEAR', v.bear)}
        {cell('BASE', v.base)}
        {cell('BULL', v.bull)}
        {/* Upside is meaningless without saying what it is against, and a
            stale reference price quietly turns into a wrong percentage. */}
        <div style={{ minWidth: 92 }}>
          <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5 }}>
            {ref ? 'VS' : 'NO REF PRICE'}
          </div>
          <div style={{ color: 'var(--term-fg-dim)', fontSize: 13 }}>{ref ? money(ref) : '—'}</div>
          {ref ? (
            <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>at write</div>
          ) : (
            <div style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>upside not shown</div>
          )}
        </div>
      </div>

      {/* The watch. A valuation saying a name is cheap does nothing on
          its own — somebody has to be looking on the day it gets there,
          and nobody refreshes a quote daily for a name they do not own. */}
      {v.buyBelow ? (
        <div style={{ fontSize: 11, marginTop: 3 }}>
          <span style={{ color: 'var(--term-fg-muted)' }}>watching for </span>
          <span style={{ color: 'var(--term-white)' }}>{money(v.buyBelow, v.currency)}</span>
          {v.alertedAt ? (
            <span style={{ color: 'var(--term-positive)' }}> · reached {fmtDate(v.alertedAt)}</span>
          ) : (
            <span style={{ color: 'var(--term-fg-muted)' }}> · not there yet</span>
          )}
          {/* A watch with nobody on it fires into a log file. Worth
              saying on the row rather than discovering the day it
              triggers. */}
          {(v.watchers || []).length === 0 ? (
            <span style={{ color: 'var(--term-amber, var(--term-white))' }}> · NOBODY IS EMAILED</span>
          ) : (
            <span style={{ color: 'var(--term-fg-muted)' }}> · emails {v.watchers.length}</span>
          )}
          {/* A model written before the last earnings report is a claim
              about facts that have since been restated. Acting on a
              price alert off one is the failure this label exists to
              prevent. */}
          {v.reviewBy && new Date(v.reviewBy) < new Date() ? (
            <span style={{ color: 'var(--term-negative)' }}>
              {' '}· PAST REVIEW ({fmtDate(v.reviewBy)}) — re-run before acting
            </span>
          ) : v.reviewBy ? (
            <span style={{ color: 'var(--term-fg-muted)' }}> · review by {fmtDate(v.reviewBy)}</span>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <a
          href="#"
          style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}
          onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        >
          {open ? 'hide assumptions' : `${(v.assumptions || []).length} assumption${(v.assumptions || []).length === 1 ? '' : 's'}`}
        </a>
        <a
          href="#"
          style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}
          onClick={(e) => { e.preventDefault(); if (window.confirm(`Delete "${v.name}"?`)) remove(); }}
        >
          delete
        </a>
      </div>

      {open ? (
        <div style={{ display: 'grid', gap: 3, marginTop: 4, paddingLeft: 8 }}>
          {(v.assumptions || []).length === 0 ? (
            <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
              None recorded — the cases above cannot be restated without the file.
            </div>
          ) : (
            (v.assumptions || []).map((a, i) => {
              const c = a.claimId ? claimById.get(a.claimId) : null;
              return (
                <div key={i} style={{ fontSize: 11 }}>
                  <span style={{ color: 'var(--term-fg-dim)' }}>{a.label}</span>{' '}
                  <span style={{ color: 'var(--term-white)' }}>{a.value}{a.unit ? ` ${a.unit}` : ''}</span>
                  {c ? (
                    <span style={{ color: 'var(--term-positive)', fontSize: 10 }}>
                      {' '}· from the tape: “{(c.quote || c.text || '').slice(0, 70)}” {c.stamp}
                    </span>
                  ) : a.note ? (
                    // A figure off a filing is sourced, not assumed —
                    // "assumed · AR2025 p.169" says two contradictory
                    // things about the same number. Where provenance was
                    // recorded, it replaces the word rather than
                    // trailing it.
                    <span style={{ color: 'var(--term-fg-dim)', fontSize: 10 }}> · {a.note}</span>
                  ) : (
                    <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}> · assumed</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {v.note ? (
        <div style={{ color: 'var(--term-fg-dim)', fontSize: 11, marginTop: 3 }}>{v.note}</div>
      ) : null}
    </div>
  );
}

function ValuationForm({ project, onDone, setFlash }) {
  const [f, setF] = useState({ kind: 'dcf', name: '', bear: '', base: '', bull: '', priceAtWrite: '', note: '', currency: 'USD', buyBelow: '', reviewBy: '', watchers: '' });
  const [rows, setRows] = useState(() => SUGGESTED.dcf.map((label) => ({ label, value: '', claimId: '' })));
  const [saving, setSaving] = useState(false);

  function setKind(kind) {
    setF((p) => ({ ...p, kind }));
    // Only replace a template the user has not typed into.
    setRows((prev) =>
      prev.some((r) => r.value)
        ? prev
        : (SUGGESTED[kind] || []).map((label) => ({ label, value: '', claimId: '' }))
    );
  }

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.post(`/research/projects/${project.id}/valuations`, {
        ...f,
        watchers: String(f.watchers || '').split(',').map((x) => x.trim()).filter(Boolean),
        assumptions: rows
          .filter((r) => r.label && r.value)
          .map((r) => ({ label: r.label, value: r.value, claimId: r.claimId ? Number(r.claimId) : null })),
      });
      if (data.droppedCitations) {
        setFlash({
          bad: true,
          text: `Saved, but ${data.droppedCitations} assumption citation(s) pointed at a claim that is not in this project and were cleared.`,
        });
      }
      onDone(true);
    } catch (e) {
      setFlash({ bad: true, text: e.response?.data?.error || 'Could not save the valuation' });
      setSaving(false);
    }
  }

  const claims = project.claims || [];

  return (
    <div style={{ border: '1px solid var(--term-border)', padding: 8, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <select style={{ ...termInput, flex: '0 1 130px' }} value={f.kind} onChange={(e) => setKind(e.target.value)}>
          {VAL_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          style={{ ...termInput, flex: '2 1 200px' }}
          placeholder="Name — e.g. Base DCF, Jul 26"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '0 1 70px' }}
          placeholder="CCY"
          maxLength={3}
          title="Currency of the three cases — CHF, EUR, GBP. Defaults to USD."
          value={f.currency}
          onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull'], ['priceAtWrite', 'Price now'], ['buyBelow', 'Tell me below']].map(([k, ph]) => (
          <input
            key={k}
            style={{ ...termInput, flex: '1 1 88px' }}
            placeholder={ph}
            inputMode="decimal"
            value={f[k]}
            onChange={(e) => setF({ ...f, [k]: e.target.value })}
          />
        ))}
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5, marginTop: 2 }}>
        ASSUMPTIONS — cite a claim where the number came from the research
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            style={{ ...termInput, flex: '1 1 130px' }}
            placeholder="Input"
            value={r.label}
            onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))}
          />
          <input
            style={{ ...termInput, flex: '0 1 90px' }}
            placeholder="Value"
            value={r.value}
            onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, value: e.target.value } : x)))}
          />
          <select
            style={{ ...termInput, flex: '1 1 170px' }}
            value={r.claimId}
            onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, claimId: e.target.value } : x)))}
          >
            <option value="">assumed (no source)</option>
            {claims.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.text || '').slice(0, 60)} — {c.stamp}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div>
        <a
          href="#"
          style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}
          onClick={(e) => { e.preventDefault(); setRows([...rows, { label: '', value: '', claimId: '' }]); }}
        >
          + another input
        </a>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>Email when hit</span>
        <input
          style={{ ...termInput, flex: '1 1 240px' }}
          placeholder="comma-separated addresses"
          title="Who gets the email when the buy level is reached. Stored on this valuation, not derived from roles — officers change, watches should not."
          value={f.watchers}
          onChange={(e) => setF({ ...f, watchers: e.target.value })}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>Re-check after</span>
        <input
          style={{ ...termInput, flex: '0 1 140px' }}
          type="date"
          title="Usually the next reporting date. Past this, the panel says the model is stale rather than letting it look current."
          value={f.reviewBy}
          onChange={(e) => setF({ ...f, reviewBy: e.target.value })}
        />
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>
          usually the next earnings date
        </span>
      </div>

      <textarea
        style={{ ...termInput, resize: 'vertical', minHeight: 50 }}
        placeholder="What drives the spread between the cases?"
        value={f.note}
        onChange={(e) => setF({ ...f, note: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <TermButton onClick={save} disabled={saving || !f.name}>{saving ? 'Saving…' : 'Save'}</TermButton>
        <TermButton onClick={() => onDone(false)} disabled={saving}>Cancel</TermButton>
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
// Where the project actually stands, above the tabs.
//
// Opening a project gave you its name, its brief and a row of tabs — an
// index of what is inside, and no answer to the question anyone actually
// arrives with, which is whether this is nearly done or barely started.
// That answer existed, spread across three tabs as numbers you had to
// hold in your head and compare.
//
// The bar is the questions, in the proportion they are actually in.
// Everything else is a count with a name next to it, and the ones that
// represent work outstanding are coloured; the rest stay muted so they
// do not compete.
function ProjectStatus({ project }) {
  const cov = project.coverage?.summary || {};
  const supported = cov.supported || 0;
  const thin = cov.thin || 0;
  const contested = cov.contested || 0;
  const none = cov.unaddressed || 0;
  const total = supported + thin + contested + none;

  const interviews = project.interviews?.length || 0;
  const transcribed = (project.interviews || []).filter((i) => i.transcript).length;
  const claims = project.claims?.length || 0;
  const unlinked = cov.unlinkedClaims || 0;
  const flagged = (project.interviews || []).filter(
    (i) => !i.reviewedAt && (i.quarantined || i.mnpiRisk !== 'low' || !i.consentObtained)
  ).length;

  if (total === 0 && interviews === 0) return null;

  const seg = (n, color, label) =>
    n === 0 ? null : (
      <div
        key={label}
        title={`${n} ${label}`}
        style={{ width: `${(n / total) * 100}%`, background: color, height: '100%' }}
      />
    );

  const stat = (value, label, tone) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: tone || 'var(--term-white)', fontWeight: 700 }}>{value}</span>{' '}
      <span style={{ color: 'var(--term-fg-muted)' }}>{label}</span>
    </span>
  );

  return (
    <div style={{ display: 'grid', gap: 5 }}>
      {total > 0 ? (
        <>
          <div
            style={{
              display: 'flex', height: 6, width: '100%', overflow: 'hidden',
              border: '1px solid var(--term-border)', background: 'var(--term-bg, #000)',
            }}
          >
            {seg(supported, 'var(--term-positive)', 'supported')}
            {seg(thin, 'var(--term-amber, #C9A84C)', 'thin')}
            {seg(contested, 'var(--term-negative)', 'contested')}
            {seg(none, 'var(--term-border)', 'no evidence')}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
            {stat(supported, 'supported', 'var(--term-positive)')}
            {stat(thin, 'thin', 'var(--term-amber, var(--term-white))')}
            {contested ? stat(contested, 'contested', 'var(--term-negative)') : null}
            {stat(none, 'no evidence', none ? 'var(--term-white)' : undefined)}
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
        {/* Transcribed is called out separately from interviews because an
            interview with no transcript yields no claims — it is logged
            work, not evidence, and the two counts drifting apart is the
            thing worth seeing. */}
        {stat(interviews, interviews === 1 ? 'interview' : 'interviews')}
        {transcribed !== interviews
          ? stat(interviews - transcribed, 'awaiting transcript', 'var(--term-amber, var(--term-white))')
          : null}
        {stat(claims, claims === 1 ? 'claim' : 'claims')}
        {unlinked ? stat(unlinked, 'answering nothing asked', 'var(--term-amber, var(--term-white))') : null}
        {flagged ? stat(flagged, 'needing a compliance decision', 'var(--term-negative)') : null}
      </div>
    </div>
  );
}

function Coverage({ project, onChanged }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState(null);
  const [openQ, setOpenQ] = useState(null);
  const [qFilter, setQFilter] = useState('all');
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

      {/* Thirty-one questions in one flat list is a wall, and the ones
          that matter — the open ones with nothing behind them — are
          scattered through it in guide order. */}
      {cov.questions.length > 6 ? (
        <div style={{ fontSize: 10, letterSpacing: 0.5 }}>
          {[
            ['all', `ALL ${cov.questions.length}`],
            ['open', `STILL OPEN ${cov.questions.filter((q) => q.coverage === 'unaddressed' || q.coverage === 'thin').length}`],
            ['none', `NO EVIDENCE ${s.unaddressed || 0}`],
            ['done', `SUPPORTED ${s.supported || 0}`],
          ].map(([k, label]) => (
            <a
              key={k}
              href="#"
              onClick={(e) => { e.preventDefault(); setQFilter(k); }}
              style={{
                marginRight: 12,
                color: qFilter === k ? 'var(--term-white)' : 'var(--term-fg-muted)',
                textDecoration: qFilter === k ? 'underline' : 'none',
              }}
            >
              {label}
            </a>
          ))}
        </div>
      ) : null}

      {cov.questions.length === 0 ? (
        <div className="term-loading">
          No questions yet. Write what the project is meant to answer before
          the calls start — it is what tells you when you are done.
        </div>
      ) : (
        cov.questions
          .filter(
            (q) =>
              qFilter === 'all' ||
              (qFilter === 'open' && (q.coverage === 'unaddressed' || q.coverage === 'thin')) ||
              (qFilter === 'none' && q.coverage === 'unaddressed') ||
              (qFilter === 'done' && q.coverage === 'supported')
          )
          .map((q) => (
          <div
            key={q.questionId}
            style={{
              borderTop: '1px dotted var(--term-border)',
              // A coloured edge makes the state scannable down the list
              // without reading a single label.
              borderLeft: `2px solid ${COVERAGE_COLOR[q.coverage] || 'var(--term-border)'}`,
              paddingTop: 6,
              paddingLeft: 8,
            }}
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
              {/* Independence, site spread and forecast counts are what
                  you want when weighing ONE question, not while scanning
                  thirty. They move to the tooltip and to the expanded
                  view; the row keeps the one number that says whether
                  there is anything here at all. */}
              <span
                style={{ color: 'var(--term-fg-muted)', fontSize: 10, whiteSpace: 'nowrap' }}
                title={[
                  `${q.claimCount} claim${q.claimCount === 1 ? '' : 's'}`,
                  `${q.independentLines} independent line${q.independentLines === 1 ? '' : 's'}`,
                  q.observationCount
                    ? `${q.observationCount} observed at ${q.distinctLocations} site${q.distinctLocations === 1 ? '' : 's'}`
                    : null,
                  q.forecastCount ? `${q.forecastCount} forecast` : null,
                ].filter(Boolean).join(' · ')}
              >
                {q.claimCount || '—'}
              </span>
              {/* Closing a question is a person's call. Coverage informs
                  it; it never makes it. Shown as a mark rather than a
                  button because thirty buttons down a list is most of
                  what made this screen shout. */}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setStatus(q.questionId, q.status === 'Answered' ? 'Open' : 'Answered');
                }}
                title={q.status === 'Answered' ? 'Reopen this question' : 'Mark this question answered'}
                style={{
                  fontSize: 10,
                  color: q.status === 'Answered' ? 'var(--term-positive)' : 'var(--term-fg-muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {q.status === 'Answered' ? '✓ answered' : 'mark answered'}
              </a>
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
                // One line. The answer and its quote and a "+2 more" was
                // three lines of text per question, thirty-one times over
                // — the answer alone is what you are scanning for, and
                // the quote is one click away with everything else.
                <div
                  style={{
                    fontSize: 11, paddingLeft: 14, marginTop: 1, color: 'var(--term-fg-dim)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={top.quote ? `“${top.quote}”` : undefined}
                >
                  {top.text}
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

      {/* A filter that matches nothing is good news on this screen, and
          a blank pane does not say so. */}
      {cov.questions.length > 0 &&
      qFilter !== 'all' &&
      cov.questions.filter(
        (q) =>
          (qFilter === 'open' && (q.coverage === 'unaddressed' || q.coverage === 'thin')) ||
          (qFilter === 'none' && q.coverage === 'unaddressed') ||
          (qFilter === 'done' && q.coverage === 'supported')
      ).length === 0 ? (
        <div style={{ color: 'var(--term-positive)', fontSize: 11 }}>
          {qFilter === 'done'
            ? 'Nothing is fully supported yet.'
            : 'None — nothing outstanding in this bucket.'}
        </div>
      ) : null}
    </div>
  );
}

// What this person can tell us, which is not the same fact as how they
// touch the business. Two former employees are both FormerEmployee even
// when one was present for the thing we are investigating and the other
// left years before it — working them as one bucket is how a list of
// fourteen names reads as fourteen witnesses.
//
// Colour carries the distinction that matters most: white for the
// people who were actually there, dim amber for everyone else. The
// label is free text, so an unrecognised tier still renders rather than
// vanishing.
const TIER_TONE = {
  witness: 'var(--term-white)',
  baseline: 'var(--term-cyan)',
  competitor: 'var(--term-fg-dim)',
  buyer: 'var(--term-fg-dim)',
};

function TierChip({ tier }) {
  if (!tier) return <span style={{ color: 'var(--term-fg-muted)' }}>—</span>;
  const tone = TIER_TONE[String(tier).toLowerCase()] || 'var(--term-fg-dim)';
  return (
    <span
      style={{
        color: tone,
        border: `1px solid ${tone}`,
        borderRadius: 2,
        padding: '0 4px',
        fontSize: 10,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {tier}
    </span>
  );
}

// Where a draft has got to, at a glance.
//
// The whole point of the approval gate is that somebody can see, from
// the list, what is waiting on them. That fact living only inside the
// person's detail view is how a fully-approved email sits unsent for a
// week — so the stage travels with the row.
//
// "No draft" is a real state and gets said, rather than rendered as an
// empty cell that reads like a rendering bug.
const STAGE_TONE = {
  awaiting: ['var(--term-fg-dim)', '0 of 2'],
  'one-approval': ['var(--term-amber, var(--term-white))', '1 of 2'],
  ready: ['var(--term-positive)', 'READY'],
  sent: ['var(--term-fg-muted)', 'SENT'],
  rejected: ['var(--term-negative)', 'REJECTED'],
  blocked: ['var(--term-negative)', 'BLOCKED'],
};

function StageChip({ draft }) {
  if (!draft) return <span style={{ color: 'var(--term-fg-muted)', fontSize: 10 }}>no draft</span>;
  const [tone, label] = STAGE_TONE[draft.stage] || ['var(--term-fg-dim)', draft.stage];
  const who = draft.approvedByNames?.length ? ` (${draft.approvedByNames.join(', ')})` : '';

  // A flag that does not say what it caught is worse than no flag: it
  // reads as a vague accusation, and the only way to act on it is to go
  // looking. So anything other than a clean screen says why, on the
  // row, without a hover.
  const explain =
    draft.screenState === 'elevated' || draft.screenState === 'prohibited'
      ? draft.screenReason
      : draft.screenState === 'clear-keyword-only'
      ? 'Model was unreachable. Only the keyword pass ran, so this is not a clean read.'
      : draft.screenState === 'unscreened'
      ? 'Nothing has read this yet.'
      : null;

  return (
    <div style={{ minWidth: 150 }}>
      <span style={{ whiteSpace: 'nowrap' }}>
        <span title={`${label}${who}`} style={{ color: tone, fontSize: 10, letterSpacing: 0.5 }}>
          {label}
        </span>
        <ScreenChip draft={draft} />
      </span>
      {explain ? (
        <div
          style={{
            fontSize: 9,
            lineHeight: 1.35,
            color: 'var(--term-fg-muted)',
            marginTop: 2,
            whiteSpace: 'normal',
          }}
        >
          {explain}
        </div>
      ) : null}
    </div>
  );
}

// The compliance verdict, and the two states that must never be
// mistaken for a pass.
//
// `unscreened` means nothing has read this yet. `clear-keyword-only`
// means the model was unreachable and only the crude pass ran, which is
// a weaker statement than a clean read and is shown as its own thing
// rather than as a tick. Presenting either as "clear" is the failure
// this whole screen exists to avoid.
const SCREEN_TONE = {
  prohibited: ['var(--term-negative)', 'BLOCKED', 'The compliance screen will not pass this as written'],
  elevated: ['var(--term-amber, var(--term-white))', 'FLAGGED', 'The compliance screen wants a person to read this'],
  clear: ['var(--term-positive)', 'screened', 'Read by the keyword pass and the model'],
  'clear-keyword-only': ['var(--term-amber, var(--term-white))', 'part-screened', 'The model was unreachable. Only the keyword pass ran, so this is not a clean bill of health'],
  unscreened: ['var(--term-fg-muted)', 'unscreened', 'Nothing has read this yet'],
};

function ScreenChip({ draft }) {
  const s = SCREEN_TONE[draft?.screenState];
  if (!s) return null;
  const [tone, label, title] = s;
  return (
    <span
      title={draft.screenReason ? `${title}: ${draft.screenReason}` : title}
      style={{ color: tone, fontSize: 9, letterSpacing: 0.4, marginLeft: 6, opacity: 0.9 }}
    >
      {label}
    </span>
  );
}

// Outreach — the front of the funnel. Without it there are no
// interviews, and "who haven't we tried yet" is what actually paces a
// project.
function Targets({ project, onChanged }) {
  const [f, setF] = useState({ name: '', relationship: 'FormerEmployee', employer: '', email: '', tier: '', channel: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(null);
  // Ninety-seven names in one table, and the only one that matters on a
  // given afternoon is "who have we not tried yet". The funnel line
  // counts them; without this there is no way to look at just them.
  const [only, setOnly] = useState('all');
  const fn = project.funnel || {};
  const q = project.outreachQueue || {};
  const open = (project.targets || []).find((t) => t.id === openId);

  // One person, everything we have on them. The list is for scanning;
  // this is for actually reading what was said — which is why the reply
  // and the email we sent live here in full rather than truncated.
  if (open) {
    return <TargetDetail target={open} onBack={() => setOpenId(null)} onChanged={onChanged} />;
  }

  async function add() {
    setSaving(true);
    setErr('');
    try {
      await api.post(`/research/projects/${project.id}/targets`, f);
      setF({ name: '', relationship: 'FormerEmployee', employer: '', email: '', tier: '', channel: '' });
      onChanged();
    } catch (e) {
      // A rejected address has to say so. Clearing the form on a failed
      // save loses the typing and tells the user nothing.
      setErr(e.response?.data?.error || 'Could not add that target.');
    } finally {
      setSaving(false);
    }
  }

  const shown = (project.targets || []).filter((t) =>
    only === 'all'
      ? true
      : only === 'dead'
      ? t.status === 'Declined' || t.status === 'Unreachable'
      : t.status === only
  );

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

      {/* Where the outreach queue actually stands. Without this line the
          approval state is invisible until you open a person, which is
          how a fully-approved email sits unsent for a week. */}
      {q.awaitingReview || q.readyToSend || q.rejected || q.screenBlocked || q.unscreened || q.keywordOnly ? (
        <div style={{ fontSize: 11 }}>
          {q.awaitingMe ? (
            <span style={{ color: 'var(--term-white)', marginRight: 12 }}>
              {q.awaitingMe} waiting on your approval
            </span>
          ) : null}
          {q.awaitingReview ? (
            <span style={{ color: 'var(--term-fg-dim)', marginRight: 12 }}>
              {q.awaitingReview} awaiting sign-off
            </span>
          ) : null}
          {q.readyToSend ? (
            <span style={{ color: 'var(--term-positive)', marginRight: 12 }}>
              {q.readyToSend} approved, ready to send
            </span>
          ) : null}
          {q.rejected ? (
            <span style={{ color: 'var(--term-negative)', marginRight: 12 }}>
              {q.rejected} rejected
            </span>
          ) : null}
          {/* Compliance state belongs on the same line as the approval
              state, because "approved" and "screened" are different
              claims and a reader who sees only the first will assume
              the second. */}
          {q.screenBlocked ? (
            <span style={{ color: 'var(--term-negative)', marginRight: 12 }}>
              {q.screenBlocked} blocked by the screen
            </span>
          ) : null}
          {q.screenElevated ? (
            <span style={{ color: 'var(--term-amber, var(--term-white))', marginRight: 12 }}>
              {q.screenElevated} flagged for a read
            </span>
          ) : null}
          {q.unscreened || q.keywordOnly ? (
            <span style={{ color: 'var(--term-amber, var(--term-white))', marginRight: 12 }}>
              {(q.unscreened || 0) + (q.keywordOnly || 0)} not fully screened
            </span>
          ) : null}
        </div>
      ) : null}

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
          style={{ ...termInput, flex: '1 1 160px' }}
          placeholder="Email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '0 1 110px' }}
          placeholder="Category"
          title="What they can tell us — e.g. Witness, Baseline, Competitor, Buyer"
          value={f.tier}
          onChange={(e) => setF({ ...f, tier: e.target.value })}
        />
        <input
          style={{ ...termInput, flex: '1 1 140px' }}
          placeholder="Other channel"
          value={f.channel}
          onChange={(e) => setF({ ...f, channel: e.target.value })}
        />
        <TermButton onClick={add} disabled={saving || !f.name}>Add</TermButton>
      </div>
      {err ? <div style={{ color: 'var(--term-negative)', fontSize: 11 }}>{err}</div> : null}

      {(project.targets || []).length > 8 ? (
        <div style={{ fontSize: 10, letterSpacing: 0.5 }}>
          {[
            ['all', `ALL ${(project.targets || []).length}`],
            ['Identified', `NOT TRIED ${fn.Identified || 0}`],
            ['Contacted', `WAITING ${fn.Contacted || 0}`],
            ['Scheduled', `SCHEDULED ${fn.Scheduled || 0}`],
            ['Completed', `DONE ${fn.Completed || 0}`],
            ['dead', `DEAD ${(fn.Declined || 0) + (fn.Unreachable || 0)}`],
          ].map(([k, label]) => (
            <a
              key={k}
              href="#"
              onClick={(e) => { e.preventDefault(); setOnly(k); }}
              style={{
                marginRight: 12,
                color: only === k ? 'var(--term-white)' : 'var(--term-fg-muted)',
                textDecoration: only === k ? 'underline' : 'none',
              }}
            >
              {label}
            </a>
          ))}
          {/* An empty bucket is good news here, and a blank table does
              not say so. */}
          {only !== 'all' && shown.length === 0 ? (
            <span style={{ color: 'var(--term-positive)' }}>— none in this bucket</span>
          ) : null}
        </div>
      ) : null}

      {!project.targets || project.targets.length === 0 ? (
        <div className="term-loading">
          No targets yet. Map the value chain — former staff, distributors,
          customers, suppliers, competitors — then work the list.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 24 }}>#</th>
              <th>Name</th>
              <th>Category</th>
              <th>Employer</th>
              <th>Email</th>
              <th>Draft</th>
              <th>Status</th>
              <th>Last try</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td style={{ color: 'var(--term-fg-muted)' }}>{t.priority ?? '—'}</td>
                <td className="sym">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); setOpenId(t.id); }}
                    title="Open the full record"
                  >
                    {t.name}
                  </a>
                </td>
                <td>
                  <TierChip tier={t.tier} />
                  {/* The relationship stays visible under the badge.
                      The badge says what they can tell us, which is a
                      different fact from how they touch the business,
                      and dropping either one loses something. */}
                  <div style={{ fontSize: 10, color: 'var(--term-fg-muted)' }}>{t.relationship}</div>
                </td>
                <td>{t.employer || '—'}</td>
                <td>
                  {/* Clickable, because a list you have to retype is a
                      list nobody works through. */}
                  {t.email ? (
                    <a href={`mailto:${t.email}`} title={`Email ${t.name}`}>{t.email}</a>
                  ) : (
                    <span style={{ color: 'var(--term-fg-muted)' }}>
                      {t.channel ? t.channel.slice(0, 40) : 'no address'}
                    </span>
                  )}
                </td>
                <td><StageChip draft={(t.drafts || [])[0]} /></td>
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
        {t.priority != null ? (
          <span style={{ color: 'var(--term-fg-muted)', fontSize: 10, letterSpacing: 0.5 }}>
            #{t.priority} TO CALL
          </span>
        ) : null}
      </div>

      <div style={{ color: 'var(--term-fg-dim)', fontSize: 12 }}>
        {[t.role, t.employer].filter(Boolean).join(' · ') || 'No title or employer recorded'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <TierChip tier={t.tier} />
        <span style={{ color: 'var(--term-fg-muted)' }}>{t.relationship}</span>
        {/* The address gets its own line and its own link. This is the
            page someone is on when they decide to actually write. */}
        {t.email ? (
          <a href={`mailto:${t.email}`} style={{ color: 'var(--term-white)' }}>{t.email}</a>
        ) : (
          <span style={{ color: 'var(--term-fg-muted)' }}>no address on file</span>
        )}
        {t.channel ? <span style={{ color: 'var(--term-fg-muted)' }}>{t.channel}</span> : null}
        <span style={{ color: 'var(--term-fg-muted)' }}>
          {t.lastContactAt ? `last contact ${fmtDate(t.lastContactAt)}` : 'never contacted'}
        </span>
      </div>

      <Drafts target={t} onChanged={onChanged} />

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

// The outreach email and its two sign-offs.
//
// The app does not send the mail — it goes from a real person's school
// address, which is the only way a cold email from a student club is
// going to be read. So what this panel owes the user is the text,
// verbatim and copyable, plus an honest account of who has signed off
// and who has not. "Copy" is the send button here, and it is only
// enabled once both approvals are in.
function Drafts({ target, onChanged }) {
  const drafts = target.drafts || [];
  const [composing, setComposing] = useState(false);
  const [f, setF] = useState({ subject: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(null);

  async function run(fn) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(d) {
    // Subject and body together, because pasting them separately is two
    // chances to paste the wrong one.
    const text = `Subject: ${d.subject}\n\n${d.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(d.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr('Could not reach the clipboard — select the text below and copy it by hand.');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--term-border)', paddingTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 10, letterSpacing: 0.6, color: 'var(--term-white)' }}>OUTREACH EMAIL</span>
        {!composing ? (
          <TermButton onClick={() => { setComposing(true); setF({ subject: '', body: '' }); }}>
            {drafts.length ? 'New draft' : 'Write one'}
          </TermButton>
        ) : null}
      </div>

      {err ? <div style={{ color: 'var(--term-negative)', fontSize: 11 }}>{err}</div> : null}

      {composing ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <input
            style={termInput}
            placeholder="Subject"
            value={f.subject}
            onChange={(e) => setF({ ...f, subject: e.target.value })}
          />
          <textarea
            style={{ ...termInput, resize: 'vertical', minHeight: 200, lineHeight: 1.5 }}
            placeholder="The email itself."
            value={f.body}
            onChange={(e) => setF({ ...f, body: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <TermButton
              disabled={busy || !f.subject || !f.body}
              onClick={() => run(async () => {
                await api.post(`/research/targets/${target.id}/drafts`, f);
                setComposing(false);
              })}
            >
              Save draft
            </TermButton>
            <TermButton onClick={() => { setComposing(false); setErr(''); }}>Cancel</TermButton>
          </div>
        </div>
      ) : null}

      {drafts.length === 0 && !composing ? (
        <div className="term-loading" style={{ fontSize: 11 }}>
          Nothing drafted. Anything written here needs two sign-offs before it can go out.
        </div>
      ) : null}

      {drafts.map((d) => (
        <DraftCard
          key={d.id}
          d={d}
          target={target}
          busy={busy}
          copied={copied === d.id}
          onCopy={() => copy(d)}
          onRun={run}
        />
      ))}
    </div>
  );
}

function DraftCard({ d, target, busy, copied, onCopy, onRun }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ subject: d.subject, body: d.body });
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // The state line has to be readable in one glance and must never
  // overstate where a draft has got to — "ready" on something with one
  // approval is how an unreviewed email goes out.
  const state = d.sentAt
    ? { text: `SENT ${fmtDate(d.sentAt)}${d.sentBy ? ` by ${d.sentBy.name}` : ''}`, tone: 'var(--term-fg-muted)' }
    : d.rejectedAt
    ? { text: `REJECTED by ${d.rejectedBy?.name || 'someone'} — ${d.reviewNote || 'no reason given'}`, tone: 'var(--term-negative)' }
    : d.screenBlocked
    ? { text: 'BLOCKED by the compliance screen — cannot be approved or sent as written', tone: 'var(--term-negative)' }
    : d.fullyApproved
    ? { text: `APPROVED by ${d.approvedByNames.join(' and ')} — ready to send`, tone: 'var(--term-positive)' }
    : {
        text: `${d.approvalCount} of ${d.approvalsNeeded} approvals${d.approvalCount ? ` — ${d.approvedByNames.join(', ')}` : ''}`,
        tone: 'var(--term-fg-dim)',
      };

  const findings = d.screenFindings?.hits || [];
  const concerns = d.screenFindings?.concerns || [];

  return (
    <div style={{ border: '1px solid var(--term-border)', padding: 8, display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, color: state.tone }}>{state.text}</div>

      {/* The compliance read, with what it actually found. A verdict
          nobody can act on gets clicked past, so the findings are here
          rather than behind a tooltip. */}
      <div style={{ fontSize: 10 }}>
        <ScreenChip draft={d} />
        {d.screenReason ? (
          <span style={{ color: 'var(--term-fg-muted)', marginLeft: 6 }}>{d.screenReason}</span>
        ) : null}
        {d.screenState === 'clear-keyword-only' || d.screenState === 'unscreened' ? (
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); onRun(() => api.post(`/research/drafts/${d.id}/screen`)); }}
            style={{ marginLeft: 8 }}
          >
            run the full screen
          </a>
        ) : null}
      </div>

      {findings.length || concerns.length ? (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, color: 'var(--term-fg-dim)' }}>
          {findings.map((h, i) => (
            <li key={`h${i}`}>
              {h.why}
              {h.excerpt ? (
                <span style={{ color: 'var(--term-fg-muted)' }}> — “{h.excerpt.slice(0, 90)}”</span>
              ) : null}
            </li>
          ))}
          {concerns.map((c, i) => <li key={`c${i}`}>{c}</li>)}
        </ul>
      ) : null}

      {editing ? (
        <>
          <input
            style={termInput}
            value={f.subject}
            onChange={(e) => setF({ ...f, subject: e.target.value })}
          />
          <textarea
            style={{ ...termInput, resize: 'vertical', minHeight: 220, lineHeight: 1.5 }}
            value={f.body}
            onChange={(e) => setF({ ...f, body: e.target.value })}
          />
          {/* Said before they commit, not after. Someone fixing a typo
              on a fully-approved draft needs to know it costs both
              sign-offs. */}
          {d.approvalCount > 0 ? (
            <div style={{ color: 'var(--term-negative)', fontSize: 10 }}>
              Saving a change clears {d.approvalCount === 1 ? 'the approval' : `both approvals`} — the draft goes back for review.
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 6 }}>
            <TermButton
              disabled={busy}
              onClick={() => onRun(async () => {
                await api.patch(`/research/drafts/${d.id}`, f);
                setEditing(false);
              })}
            >
              Save
            </TermButton>
            <TermButton onClick={() => { setF({ subject: d.subject, body: d.body }); setEditing(false); }}>
              Cancel
            </TermButton>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--term-white)' }}>{d.subject}</div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 11,
              lineHeight: 1.5,
              color: 'var(--term-fg-dim)',
              margin: 0,
              maxHeight: 300,
              overflowY: 'auto',
            }}
          >
            {d.body}
          </pre>
        </>
      )}

      {!editing && !d.sentAt ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {d.canIApprove ? (
            <TermButton disabled={busy} onClick={() => onRun(() => api.post(`/research/drafts/${d.id}/approve`))}>
              Approve
            </TermButton>
          ) : null}
          {d.iApproved && !d.sentAt ? (
            <TermButton disabled={busy} onClick={() => onRun(() => api.delete(`/research/drafts/${d.id}/approve`))}>
              Withdraw my approval
            </TermButton>
          ) : null}
          {d.canIApprove ? (
            <TermButton disabled={busy} onClick={() => setRejecting(!rejecting)}>Reject</TermButton>
          ) : null}
          <TermButton disabled={busy} onClick={() => setEditing(true)}>Edit</TermButton>

          {/* Copy is the send button, so it stays shut until both
              sign-offs are in. A greyed control with a reason attached
              teaches the rule; a hidden one just looks broken. */}
          <TermButton
            disabled={busy || !d.fullyApproved}
            title={d.fullyApproved ? `Copy, then send from your school address to ${target.email || 'them'}` : 'Needs two approvals first'}
            onClick={onCopy}
          >
            {copied ? 'Copied' : 'Copy to send'}
          </TermButton>
          {d.fullyApproved ? (
            <TermButton disabled={busy} onClick={() => onRun(() => api.post(`/research/drafts/${d.id}/sent`))}>
              Mark sent
            </TermButton>
          ) : null}
        </div>
      ) : null}

      {rejecting ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ ...termInput, flex: 1 }}
            placeholder="What is wrong with it?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <TermButton
            disabled={busy || !note}
            onClick={() => onRun(async () => {
              await api.post(`/research/drafts/${d.id}/reject`, { note });
              setRejecting(false);
              setNote('');
            })}
          >
            Confirm reject
          </TermButton>
        </div>
      ) : null}
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
