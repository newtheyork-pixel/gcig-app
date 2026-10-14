import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Button from '../components/Button.jsx';
import SetupForm from './draft/SetupForm.jsx';
import DraftRoom from './draft/DraftRoom.jsx';

const STATUS = {
  setup: 'Setup',
  live: 'Live',
  paused: 'Paused',
  complete: 'Complete',
};

export default function Draft() {
  const { id } = useParams();
  if (id === 'new') return <SetupForm />;
  if (id) return <DraftRoom id={id} />;
  return <DraftHome />;
}

function DraftHome() {
  const { isExecutive, isSuperAdmin } = useAuth();
  const canRun = isExecutive || isSuperAdmin;
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState(null);
  const [pods, setPods] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, p] = await Promise.all([
          api.get('/drafts'),
          api.get('/drafts/pods'),
        ]);
        if (cancelled) return;
        setDrafts(d.data.drafts || []);
        setPods(p.data.pods || []);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load drafts');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const live = (drafts || []).find((d) => d.status === 'live' || d.status === 'paused');

  return (
    <>
      <PageHeader
        kicker="The club"
        title="Analyst Draft"
        subtitle="Portfolio managers draft analysts onto their pods. Coverage groups stay put — a Technology analyst can land on any team."
        actions={
          canRun ? (
            <Button onClick={() => navigate('/draft/new')}>New draft</Button>
          ) : null
        }
      />
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {live && (
        <Link
          to={`/draft/${live.id}`}
          className="mb-6 block rounded-2xl border border-gold bg-white px-5 py-4 transition hover:bg-gold-100/30"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gold-700">
            {live.status === 'paused' ? 'Paused' : 'Live now'}
          </div>
          <div className="mt-1 font-serif text-2xl font-medium text-navy">{live.name}</div>
          <div className="mt-1 text-sm text-navy-400">
            {live.pickCount} picks · open the room
          </div>
        </Link>
      )}

      <section className="mb-8">
        <h2 className="mb-3 font-serif text-2xl font-medium text-navy">Pods</h2>
        {pods.length === 0 ? (
          <p className="text-sm text-navy-400">
            No drafted pods yet. A completed draft writes each manager’s roster here.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pods.map((pod) => (
              <div key={pod.pm.id} className="rounded-2xl border border-navy/[0.07] bg-white p-4">
                <Link to={`/members/${pod.pm.id}`} className="font-serif text-lg font-medium text-navy hover:text-gold-700">
                  {pod.pm.name}
                </Link>
                {pod.draft && (
                  <Link to={`/draft/${pod.draft.id}`} className="mt-0.5 block text-[11px] text-navy-400 hover:text-gold-700">
                    {pod.draft.name}
                  </Link>
                )}
                <ul className="mt-2 space-y-1">
                  {pod.analysts.map((a) => (
                    <li key={a.id}>
                      <Link to={`/members/${a.id}`} className="text-sm text-navy hover:text-gold-700">
                        {a.name}
                      </Link>
                      {a.classYear ? (
                        <span className="ml-2 text-[11px] text-navy-300">’{String(a.classYear).slice(-2)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-serif text-2xl font-medium text-navy">History</h2>
        {!drafts ? (
          <p className="text-sm text-navy-400">Loading…</p>
        ) : drafts.length === 0 ? (
          <p className="text-sm text-navy-400">No drafts yet.</p>
        ) : (
          <ul className="divide-y divide-navy-100 rounded-2xl border border-navy/[0.07] bg-white">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link to={`/draft/${d.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-navy-50/60">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-navy">{d.name}</div>
                    <div className="text-[11px] text-navy-400">
                      {d.seats.map((s) => s.name).join(' · ') || 'No managers'}
                      {' · '}
                      {d.pickCount} picks
                    </div>
                  </div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-navy-400">
                    {STATUS[d.status] || d.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
