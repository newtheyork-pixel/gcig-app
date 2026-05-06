// Sandbox — full-screen scratchpad page for super-admin work in
// progress. Lives outside the Layout wrapper so it gets the entire
// viewport, free of the sidebar and page chrome that would distract
// from whatever's being prototyped here. Currently the home of the
// Grade Predictor project.

import { Navigate, useNavigate } from 'react-router-dom';
import { X, Upload, FileText, Sparkles, BookOpen, GraduationCap } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function Sandbox() {
  const { isSuperAdmin, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) return null;
  if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-navy/10 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-gold/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-gold">
            Sandbox
          </span>
          <h1 className="text-lg font-semibold text-navy">Grade Predictor</h1>
          <span className="text-xs text-navy/40">work in progress</span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/admin')}
          className="rounded-full p-2 text-navy/60 hover:bg-navy/5 hover:text-navy"
          aria-label="Close sandbox"
          title="Close sandbox"
        >
          <X size={20} />
        </button>
      </header>
      <main className="flex-1 overflow-auto bg-navy/[0.02] px-6 py-8">
        <GradePredictor />
      </main>
    </div>
  );
}

// ─── Grade Predictor scaffold ──────────────────────────────────────────
// The shape of the project as Thomas described it:
//
//   1. Student submits an essay (paste text or upload .docx / .pdf)
//      and optionally an assignment rubric.
//   2. Once the teacher returns the essay graded, the student feeds
//      the teacher's feedback + final grade back in. That tuple
//      (essay, feedback, grade, teacher) is training data.
//   3. As the corpus grows, the model learns each teacher's grading
//      style and rubric weighting. A per-teacher profile builds up.
//   4. For new essays, the model produces line-by-line comments in
//      the style of the named teacher, plus a grade prediction. If
//      a rubric is supplied up front, the prediction is broken out
//      by criterion.
//
// This component lays out the entry surfaces. No backend wiring yet
// — buttons are inert. The upstream pipeline lives at
// `~/Desktop/gcig-app/sandbox/` (separate from gcig-app's React+API
// stack so the model code, training data, and any heavy ML deps can
// stay isolated).

function GradePredictor() {
  const [mode, setMode] = useState('predict'); // 'predict' | 'train'

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-1 rounded-xl border border-navy/10 bg-white p-1 text-sm">
        <ModeButton active={mode === 'predict'} onClick={() => setMode('predict')} icon={Sparkles}>
          Predict a grade
        </ModeButton>
        <ModeButton active={mode === 'train'} onClick={() => setMode('train')} icon={GraduationCap}>
          Train with teacher feedback
        </ModeButton>
      </div>
      {mode === 'predict' ? <PredictPanel /> : <TrainPanel />}
    </div>
  );
}

function ModeButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 font-medium transition ${
        active ? 'bg-navy text-white shadow-sm' : 'text-navy/60 hover:bg-navy/5'
      }`}
    >
      <Icon size={16} />
      {children}
    </button>
  );
}

function PredictPanel() {
  const [essay, setEssay] = useState('');
  const [rubric, setRubric] = useState('');
  const [teacher, setTeacher] = useState('');

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <FileText className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">Essay</h2>
            <p className="text-xs text-navy/60">Paste the full essay text. File upload coming.</p>
          </div>
        </header>
        <textarea
          value={essay}
          onChange={(e) => setEssay(e.target.value)}
          placeholder="Paste the essay here…"
          className="h-64 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
        />
        <div className="flex items-center justify-between text-xs text-navy/50">
          <span>{essay.length.toLocaleString()} chars · {countWords(essay).toLocaleString()} words</span>
          <button type="button" disabled className="inline-flex items-center gap-1 rounded-md border border-dashed border-navy/20 px-2 py-1 text-navy/40">
            <Upload size={12} /> Upload .docx / .pdf
          </button>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <BookOpen className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">Context (optional)</h2>
            <p className="text-xs text-navy/60">A rubric and the grading teacher both improve the prediction.</p>
          </div>
        </header>
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher</label>
          <input
            value={teacher}
            onChange={(e) => setTeacher(e.target.value)}
            placeholder="e.g. Dr. Hsu"
            className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Assignment rubric</label>
          <textarea
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            placeholder="Paste the rubric, or leave blank for an open-ended grade prediction…"
            className="mt-1 h-32 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={!essay}
          className="w-full rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Predict grade & generate line-by-line comments
        </button>
        <p className="text-[11px] text-navy/40">
          Pipeline not wired yet — when it is, output will land in a third panel below.
        </p>
      </section>
    </div>
  );
}

function TrainPanel() {
  const [essay, setEssay] = useState('');
  const [feedback, setFeedback] = useState('');
  const [grade, setGrade] = useState('');
  const [teacher, setTeacher] = useState('');

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <FileText className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">Original essay</h2>
            <p className="text-xs text-navy/60">The version you submitted to the teacher.</p>
          </div>
        </header>
        <textarea
          value={essay}
          onChange={(e) => setEssay(e.target.value)}
          placeholder="Paste the original essay…"
          className="h-64 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
        />
      </section>

      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <GraduationCap className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">What the teacher said</h2>
            <p className="text-xs text-navy/60">Both the line-by-line comments and the final grade.</p>
          </div>
        </header>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher</label>
            <input
              value={teacher}
              onChange={(e) => setTeacher(e.target.value)}
              placeholder="e.g. Dr. Hsu"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Final grade</label>
            <input
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="e.g. 92, A-, 4/5"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Comments / feedback</label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Paste every margin note, end-comment, rubric scoring..."
            className="mt-1 h-40 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={!essay || !feedback || !grade}
          className="w-full rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save training example
        </button>
        <p className="text-[11px] text-navy/40">
          Saved examples will accumulate per-teacher in the sandbox/ folder so the model can learn each teacher's grading style.
        </p>
      </section>
    </div>
  );
}

function countWords(s) {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
