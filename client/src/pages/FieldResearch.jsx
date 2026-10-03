import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// Fieldwork is a project for one company, and the project is a list of
// questions. A conversation is how a question gets evidence. A claim
// still cannot be typed: it has to be found in a transcript. Closing a
// question is a person's decision, not a count of how much was said.

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

const COVERAGE_WORD = {
  unaddressed: 'Nothing yet',
  thin: 'One voice',
  supported: 'Corroborated',
  contested: 'Contested',
};

const input = 'w-full rounded-lg border border-navy/10 bg-white px-3 py-1.5 text-sm text-navy';
const textBtn =
  'text-sm font-medium text-navy underline decoration-gold decoration-2 underline-offset-4 disabled:opacity-40';

function errText(e, fallback) {
  return e.response?.data?.error || e.message || fallback;
}

export default function FieldResearch() {
  const { isAnalystOrAbove, user } = useAuth();
  const canWrite =
    isAnalystOrAbove || user?.role === 'DirectorOfResearch';
  const [projects, setProjects] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const { data } = await api.get('/research/projects');
      setProjects(data || []);
    } catch (e) {
      setErr(errText(e, 'Could not load projects'));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (openId) {
    return (
      <Project
        id={openId}
        canWrite={canWrite}
        onBack={() => {
          setOpenId(null);
          load();
        }}
      />
    );
  }

  const list = projects || [];
  const open = list.filter((p) => p.status !== 'Closed');
  const closed = list.filter((p) => p.status === 'Closed');

  return (
    <>
      <PageHeader
        kicker="Fieldwork"
        title="Projects"
        subtitle="A project is one company. The work is the questions that still have nothing behind them."
      />
      {err ? <p className="mb-4 text-sm text-red-700">{err}</p> : null}
      {canWrite ? <NewProject onDone={load} /> : null}
      {projects == null ? (
        <p className="py-10 text-sm text-navy-400">Loading projects…</p>
      ) : open.length === 0 && closed.length === 0 ? (
        <p className="py-10 text-sm text-navy-400">No projects yet.</p>
      ) : (
        <>
          <ProjectRows projects={open} onOpen={setOpenId} />
          {closed.length > 0 ? (
            <div className="mt-10">
              <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">Closed</h2>
              <ProjectRows projects={closed} onOpen={setOpenId} />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function ProjectRows({ projects, onOpen }) {
  return (
    <ul className="mt-4">
      {projects.map((p) => (
        <li key={p.id} className="border-t border-navy/10 first:border-t-0">
          <button
            type="button"
            onClick={() => onOpen(p.id)}
            className="flex w-full items-baseline gap-4 py-3 text-left"
          >
            <span className="w-16 shrink-0 font-serif text-2xl font-medium text-navy">
              {p.ticker || '—'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-navy">{p.name}</span>
              <span className="mt-0.5 block text-[11px] text-navy-400">
                {p._count?.questions ?? 0} {p._count?.questions === 1 ? 'question' : 'questions'} ·{' '}
                {p._count?.interviews ?? 0} {p._count?.interviews === 1 ? 'conversation' : 'conversations'}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NewProject({ onDone }) {
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit(ev) {
    ev.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.post('/research/projects', {
        ticker: ticker.trim(),
        name: name.trim(),
      });
      setTicker('');
      setName('');
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not start the project'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-8 flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="text-[11px] text-navy-400">Ticker</span>
        <input
          className={`${input} mt-1 w-24`}
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
        />
      </label>
      <label className="block min-w-[16rem] flex-1">
        <span className="text-[11px] text-navy-400">What we're checking</span>
        <input
          className={`${input} mt-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Costco membership fee"
        />
      </label>
      <button className={textBtn} disabled={saving || !name.trim()}>
        {saving ? 'Starting…' : 'Start a project'}
      </button>
      {err ? <p className="w-full text-sm text-red-700">{err}</p> : null}
    </form>
  );
}

function Project({ id, canWrite, onBack }) {
  const [project, setProject] = useState(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const { data } = await api.get(`/research/projects/${id}`);
      setProject(data);
    } catch (e) {
      setErr(errText(e, 'Could not open the project'));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!project) {
    return (
      <>
        <button type="button" onClick={onBack} className={textBtn}>
          All projects
        </button>
        <p className="mt-6 text-sm text-navy-400">{err || 'Opening…'}</p>
      </>
    );
  }

  const rows = questionRows(project);
  const openGaps = rows.filter((r) => r.status === 'Open' && r.coverage === 'unaddressed').length;
  const loose = (project.claims || []).filter((c) => c.questionId == null);

  return (
    <>
      <button type="button" onClick={onBack} className={textBtn}>
        All projects
      </button>
      <PageHeader
        kicker={project.ticker || 'Fieldwork'}
        title={project.name}
        subtitle={
          openGaps === 0
            ? 'Every open question has something behind it. Closing one is still a person’s call.'
            : `${openGaps} open ${openGaps === 1 ? 'question has' : 'questions have'} nothing behind ${openGaps === 1 ? 'it' : 'them'}.`
        }
      />
      {err ? <p className="mb-4 text-sm text-red-700">{err}</p> : null}
      {flash ? <p className="mb-4 text-sm text-navy-400">{flash}</p> : null}

      <section>
        <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">Questions</h2>
        {canWrite ? <NewQuestion projectId={project.id} onDone={load} /> : null}
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-navy-400">
            Write the questions before anyone is called. A conversation with nothing to learn is just a chat.
          </p>
        ) : (
          <ul className="mt-2">
            {rows.map((row) => (
              <Question
                key={row.questionId}
                project={project}
                row={row}
                canWrite={canWrite}
                onDone={load}
                setFlash={setFlash}
                setErr={setErr}
              />
            ))}
          </ul>
        )}
      </section>

      {loose.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
            Said, not yet a question
          </h2>
          <p className="mt-1 text-[11px] text-navy-400">
            These came out of a transcript and answer something nobody wrote down.
          </p>
          <ul className="mt-3">
            {loose.map((c) => (
              <li key={c.id} className="border-t border-navy/10 py-3 first:border-t-0">
                <p className="text-sm text-navy">{c.text}</p>
                {c.quote ? <p className="mt-1 text-sm text-navy-400">“{c.quote}”</p> : null}
                {canWrite ? (
                  <LinkClaim claim={c} questions={project.questions || []} onDone={load} setErr={setErr} />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Conversations
        project={project}
        canWrite={canWrite}
        onDone={load}
        setFlash={setFlash}
        setErr={setErr}
      />
    </>
  );
}

function questionRows(project) {
  const covered = project.coverage?.questions;
  const claims = project.claims || [];
  if (covered?.length) {
    return covered.map((row) => ({
      ...row,
      claims: claims.filter((c) => c.questionId === row.questionId),
    }));
  }
  return (project.questions || []).map((q) => ({
    questionId: q.id,
    text: q.text,
    status: q.status || 'Open',
    coverage: 'unaddressed',
    claims: claims.filter((c) => c.questionId === q.id),
  }));
}

function NewQuestion({ projectId, onDone }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit(ev) {
    ev.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.post(`/research/projects/${projectId}/questions`, { text: text.trim() });
      setText('');
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not add the question'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-3">
      <input
        className={`${input} min-w-[16rem] flex-1`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What do we need to learn?"
      />
      <button className={textBtn} disabled={saving || !text.trim()}>
        {saving ? 'Adding…' : 'Add question'}
      </button>
      {err ? <p className="w-full text-sm text-red-700">{err}</p> : null}
    </form>
  );
}

function Question({ project, row, canWrite, onDone, setFlash, setErr }) {
  const [hearing, setHearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const word = row.status === 'Answered' ? 'Answered' : COVERAGE_WORD[row.coverage] || row.coverage;
  const tone =
    row.status === 'Answered' || row.coverage === 'supported'
      ? 'text-emerald-700'
      : row.coverage === 'contested'
        ? 'text-red-700'
        : 'text-navy-400';

  async function setStatus(status) {
    setBusy(true);
    setErr('');
    try {
      await api.patch(`/questions/${row.questionId}`, { status });
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not update the question'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr('');
    try {
      await api.delete(`/questions/${row.questionId}`);
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not remove the question'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-t border-navy/10 py-4 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-navy">{row.text}</p>
        <span className={`text-[11px] ${tone}`}>{word}</span>
      </div>
      {row.claims?.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {row.claims.map((c) => (
            <li key={c.id} className="text-sm text-navy-400">
              {c.text}
              {c.interview?.source?.alias ? ` — ${c.interview.source.alias}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite ? (
        <div className="mt-2 flex flex-wrap items-center gap-4">
          {row.status === 'Open' ? (
            <button type="button" className={textBtn} disabled={busy} onClick={() => setHearing((v) => !v)}>
              {hearing ? 'Cancel' : 'We heard from someone'}
            </button>
          ) : null}
          {row.status === 'Open' ? (
            <button type="button" className={textBtn} disabled={busy} onClick={() => setStatus('Answered')}>
              Mark answered
            </button>
          ) : (
            <button type="button" className={textBtn} disabled={busy} onClick={() => setStatus('Open')}>
              Reopen
            </button>
          )}
          {row.claims?.length ? null : (
            <button type="button" className="text-sm text-navy-400" disabled={busy} onClick={remove}>
              Remove
            </button>
          )}
        </div>
      ) : null}
      {hearing ? (
        <HeardFrom
          project={project}
          question={row.text}
          onDone={() => {
            setHearing(false);
            setFlash('Filed. A claim appears only after the conversation is transcribed.');
            onDone();
          }}
          setErr={setErr}
        />
      ) : null}
    </li>
  );
}

function HeardFrom({ project, question, onDone, setErr }) {
  const [alias, setAlias] = useState('');
  const [relationship, setRelationship] = useState('FormerEmployee');
  const [employer, setEmployer] = useState('');
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit(ev) {
    ev.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const { data: source } = await api.post('/research/sources', {
        alias: alias.trim(),
        relationship,
        employer: employer.trim(),
        tickers: project.ticker ? [project.ticker] : [],
      });
      await api.post('/research/interviews', {
        sourceId: source.id,
        title: question.slice(0, 300),
        ticker: project.ticker || '',
        projectId: project.id,
        consentObtained: consent,
        consentNote: consent ? 'Recorded when the conversation was filed.' : '',
      });
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not file the conversation'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-2">
      <input
        className={input}
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        placeholder="How they're cited"
      />
      <select className={input} value={relationship} onChange={(e) => setRelationship(e.target.value)}>
        {RELATIONSHIPS.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
      <input
        className={input}
        value={employer}
        onChange={(e) => setEmployer(e.target.value)}
        placeholder="Employer — what makes two voices independent"
      />
      <label className="flex items-center gap-2 text-sm text-navy">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        They agreed to be recorded
      </label>
      {relationship === 'CurrentEmployee' ? (
        <p className="sm:col-span-2 text-[11px] text-navy-400">
          A current employee starts at elevated MNPI risk. Stay off unreleased numbers, guidance, and anything under NDA.
        </p>
      ) : null}
      <div>
        <button className={textBtn} disabled={saving || !alias.trim()}>
          {saving ? 'Filing…' : 'File the conversation'}
        </button>
      </div>
    </form>
  );
}

function LinkClaim({ claim, questions, onDone, setErr }) {
  const [questionId, setQuestionId] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(ev) {
    ev.preventDefault();
    if (!questionId) return;
    setSaving(true);
    setErr('');
    try {
      await api.post(`/research/claims/${claim.id}/link`, { questionId: Number(questionId) });
      onDone();
    } catch (e) {
      setErr(errText(e, 'Could not attach the claim'));
    } finally {
      setSaving(false);
    }
  }

  if (!questions.length) return null;
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
      <select className={`${input} w-auto`} value={questionId} onChange={(e) => setQuestionId(e.target.value)}>
        <option value="">This answers…</option>
        {questions.map((q) => (
          <option key={q.id} value={q.id}>{q.text}</option>
        ))}
      </select>
      <button className={textBtn} disabled={saving || !questionId}>Attach</button>
    </form>
  );
}

function Conversations({ project, canWrite, onDone, setFlash, setErr }) {
  const interviews = project.interviews || [];
  if (!interviews.length) return null;
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">Conversations</h2>
      <ul className="mt-2">
        {interviews.map((i) => (
          <Conversation
            key={i.id}
            interview={i}
            canWrite={canWrite}
            onDone={onDone}
            setFlash={setFlash}
            setErr={setErr}
          />
        ))}
      </ul>
    </section>
  );
}

function Conversation({ interview: i, canWrite, onDone, setFlash, setErr }) {
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const canExtract = i.status === 'Transcribed' || i.status === 'Extracted' || !!i.transcript;

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    setErr('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/recording`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setFlash(
        data?.wordCount
          ? `Transcribed ${data.wordCount} words.`
          : 'Recording received.'
      );
      onDone();
    } catch (e) {
      setErr(errText(e, 'Upload failed'));
    } finally {
      setUploading(false);
    }
  }

  async function extract() {
    setExtracting(true);
    setErr('');
    try {
      const { data } = await api.post(`/research/interviews/${i.id}/extract`);
      const dropped = data?.droppedUnlocatable || 0;
      setFlash(
        `Extracted ${data?.extracted ?? 0} claim${data?.extracted === 1 ? '' : 's'}.` +
          (dropped ? ` ${dropped} discarded — the quoted words were not in the transcript.` : '')
      );
      onDone();
    } catch (e) {
      setErr(errText(e, 'Extraction failed'));
    } finally {
      setExtracting(false);
    }
  }

  return (
    <li className="border-t border-navy/10 py-3 first:border-t-0">
      <p className="text-sm font-medium text-navy">{i.title}</p>
      <p className="mt-0.5 text-[11px] text-navy-400">
        {i.source?.alias || 'Unknown source'}
        {i.source?.employer ? ` · ${i.source.employer}` : ''} · {i.status}
        {i.consentObtained ? '' : ' · no consent'}
        {i.mnpiRisk && i.mnpiRisk !== 'low' ? ` · MNPI ${i.mnpiRisk}` : ''}
      </p>
      {canWrite ? (
        <div className="mt-2 flex flex-wrap items-center gap-4">
          {i.consentObtained ? (
            <label className="text-sm text-navy-400">
              {uploading ? 'Uploading…' : 'Upload recording'}
              <input
                type="file"
                accept="audio/*,video/*"
                className="sr-only"
                disabled={uploading}
                onChange={(e) => upload(e.target.files?.[0])}
              />
            </label>
          ) : (
            <span className="text-[11px] text-navy-400">No recording until they have agreed.</span>
          )}
          {canExtract ? (
            <button type="button" className={textBtn} disabled={extracting} onClick={extract}>
              {extracting ? 'Reading…' : 'Pull claims'}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
