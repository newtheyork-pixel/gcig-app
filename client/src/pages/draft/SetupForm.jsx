import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client.js';
import PageHeader from '../../components/PageHeader.jsx';
import Button from '../../components/Button.jsx';
import { ROLE_SHORT, recordLine, shuffle, snakePreview } from './format.js';

const field =
  'mt-1 w-full rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

export default function SetupForm({ draftId }) {
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState(null);
  const [name, setName] = useState(`Fall ${new Date().getFullYear()} Analyst Draft`);
  const [rounds, setRounds] = useState(3);
  const [pickSeconds, setPickSeconds] = useState(120);
  const [snake, setSnake] = useState(true);
  const [pmOrder, setPmOrder] = useState([]);
  const [analystIds, setAnalystIds] = useState([]);
  const [coverage, setCoverage] = useState('All');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!draftId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [people, existing] = await Promise.all([
          api.get('/drafts/candidates'),
          draftId ? api.get(`/drafts/${draftId}`) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setCandidates(people.data);
        if (existing) {
          const d = existing.data;
          if (d.draft.status !== 'setup') {
            navigate(`/draft/${draftId}`, { replace: true });
            return;
          }
          setName(d.draft.name);
          setRounds(d.draft.rounds);
          setPickSeconds(d.draft.pickSeconds);
          setSnake(d.draft.snake);
          setPmOrder(d.seats.map((s) => s.userId));
          setAnalystIds(d.board.map((a) => a.id));
        } else {
          setPmOrder((people.data.pms || []).map((p) => p.id));
          setAnalystIds((people.data.analysts || []).map((a) => a.id));
        }
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load the roster');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, navigate]);

  const pms = candidates?.pms || [];
  const analysts = candidates?.analysts || [];
  const pmById = useMemo(() => new Map(pms.map((p) => [p.id, p])), [pms]);
  const groups = useMemo(() => {
    const names = new Set();
    for (const a of analysts) for (const c of a.coverage || []) names.add(c);
    return ['All', ...[...names].sort()];
  }, [analysts]);

  const visible = analysts.filter((a) => {
    if (coverage !== 'All' && !(a.coverage || []).includes(coverage)) return false;
    if (query && !a.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return true;
  });

  const orderedPms = pmOrder.map((id) => pmById.get(id)).filter(Boolean);
  const preview = snakePreview(
    orderedPms.map((p) => p.name),
    Math.min(Number(rounds) || 0, 6),
    snake
  );

  function move(id, dir) {
    setPmOrder((order) => {
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return order;
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function togglePm(id) {
    setPmOrder((order) => (order.includes(id) ? order.filter((x) => x !== id) : [...order, id]));
  }

  function toggleAnalyst(id) {
    setAnalystIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function saveClassYear(userId, raw) {
    const classYear = raw === '' ? null : Number(raw);
    try {
      await api.patch('/drafts/class-year', { userId, classYear });
      setCandidates((c) => ({
        ...c,
        analysts: c.analysts.map((a) => (a.id === userId ? { ...a, classYear } : a)),
      }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the class year');
    }
  }

  async function save(start) {
    setBusy(true);
    setError('');
    const body = {
      name,
      rounds: Number(rounds),
      pickSeconds: Number(pickSeconds),
      snake,
      pmIds: pmOrder,
      analystIds,
    };
    try {
      const saved = draftId
        ? await api.patch(`/drafts/${draftId}`, body)
        : await api.post('/drafts', body);
      const id = draftId || saved.data.id;
      if (start) {
        await api.post(`/drafts/${id}/start`);
      }
      navigate(`/draft/${id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the draft');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <PageHeader kicker="Draft" title="Setting up" subtitle="Loading the roster…" />;
  }

  return (
    <>
      <PageHeader
        kicker="Draft"
        title={draftId ? 'Draft setup' : 'New draft'}
        subtitle="Choose the managers, the pool, and how the clock runs. Snake order goes down the list, then back up."
      />
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-navy/[0.07] bg-white p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-navy-400">
                  Name
                </span>
                <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-navy-400">
                  Rounds
                </span>
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={20}
                  value={rounds}
                  onChange={(e) => setRounds(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-navy-400">
                  Pick clock (seconds)
                </span>
                <input
                  className={field}
                  type="number"
                  min={15}
                  max={900}
                  value={pickSeconds}
                  onChange={(e) => setPickSeconds(e.target.value)}
                />
              </label>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-navy">
              <input
                type="checkbox"
                checked={snake}
                onChange={(e) => setSnake(e.target.checked)}
                className="accent-navy"
              />
              Snake order
              <span className="text-navy-400">1–2–3, then 3–2–1</span>
            </label>
          </section>

          <section className="rounded-2xl border border-navy/[0.07] bg-white p-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="font-serif text-2xl font-medium text-navy">Portfolio managers</h2>
                <p className="mt-1 text-sm text-navy-400">
                  Check who drafts. The order below is round one; randomize it or move names by hand.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setPmOrder((order) => shuffle(order))}
                disabled={pmOrder.length < 2}
              >
                Randomize
              </Button>
            </div>
            <ul className="mt-4 divide-y divide-navy-100">
              {pms.map((p) => {
                const on = pmOrder.includes(p.id);
                const place = pmOrder.indexOf(p.id);
                return (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => togglePm(p.id)}
                      className="accent-navy"
                      aria-label={`Include ${p.name}`}
                    />
                    <span className="w-6 text-sm tabular-nums text-navy-400">
                      {on ? place + 1 : ''}
                    </span>
                    <span className="flex-1 text-sm font-medium text-navy">{p.name}</span>
                    <span className="text-[11px] uppercase tracking-wider text-navy-400">
                      {ROLE_SHORT[p.role] || p.role}
                    </span>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-navy-400 hover:bg-navy-50 disabled:opacity-30"
                      disabled={!on || place === 0}
                      onClick={() => move(p.id, -1)}
                      aria-label={`Move ${p.name} up`}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-navy-400 hover:bg-navy-50 disabled:opacity-30"
                      disabled={!on || place === pmOrder.length - 1}
                      onClick={() => move(p.id, 1)}
                      aria-label={`Move ${p.name} down`}
                    >
                      Down
                    </button>
                  </li>
                );
              })}
              {pms.length === 0 && (
                <li className="py-6 text-sm text-navy-400">No portfolio managers on the roster.</li>
              )}
            </ul>
          </section>

          <section className="rounded-2xl border border-navy/[0.07] bg-white p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-serif text-2xl font-medium text-navy">Analyst pool</h2>
                <p className="mt-1 text-sm text-navy-400">
                  {analystIds.length} selected. Class year is the graduation year, saved on the member.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setAnalystIds(visible.map((a) => a.id))}>
                  Select shown
                </Button>
                <Button variant="ghost" onClick={() => setAnalystIds([])}>
                  Clear
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setCoverage(g)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    coverage === g ? 'bg-navy text-white' : 'bg-navy-50 text-navy-400 hover:text-navy'
                  }`}
                >
                  {g}
                </button>
              ))}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="ml-auto w-40 rounded-lg border border-navy-100 px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
                aria-label="Search analysts"
              />
            </div>
            <ul className="mt-3 divide-y divide-navy-100">
              {visible.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={analystIds.includes(a.id)}
                    onChange={() => toggleAnalyst(a.id)}
                    className="accent-navy"
                    aria-label={`Include ${a.name}`}
                  />
                  <div className="min-w-[10rem] flex-1">
                    <div className="text-sm font-medium text-navy">{a.name}</div>
                    <div className="text-[11px] text-navy-400">
                      {(a.coverage || []).join(' · ') || 'No coverage group'}
                      {' · '}
                      {recordLine(a)}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-navy-400">
                    Class
                    <input
                      defaultValue={a.classYear ?? ''}
                      key={`${a.id}-${a.classYear ?? ''}`}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        const prev = a.classYear == null ? '' : String(a.classYear);
                        if (next !== prev) saveClassYear(a.id, next);
                      }}
                      inputMode="numeric"
                      className="w-20 rounded-lg border border-navy-100 px-2 py-1 text-sm normal-case tracking-normal text-navy focus:border-gold focus:outline-none"
                      aria-label={`Class year for ${a.name}`}
                    />
                  </label>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="py-6 text-sm text-navy-400">No analysts match.</li>
              )}
            </ul>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-navy/[0.07] bg-white p-5">
            <h2 className="font-serif text-xl font-medium text-navy">Order</h2>
            <p className="mt-1 text-xs text-navy-400">
              {snake ? 'Snake' : 'Same order every round'} · {pickSeconds || '—'}s · {rounds || '—'}{' '}
              rounds
            </p>
            {preview.length === 0 || orderedPms.length === 0 ? (
              <p className="mt-4 text-sm text-navy-400">Add managers to see the order.</p>
            ) : (
              <ol className="mt-4 space-y-3">
                {preview.map((row) => (
                  <li key={row.round}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gold-700">
                      Round {row.round}
                    </div>
                    <div className="mt-1 text-sm text-navy">{row.names.join(' → ')}</div>
                  </li>
                ))}
                {Number(rounds) > 6 && (
                  <li className="text-xs text-navy-400">Later rounds follow the same snake.</li>
                )}
              </ol>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={() => save(false)} disabled={busy}>
              Save draft
            </Button>
            <Button variant="gold" onClick={() => save(true)} disabled={busy}>
              Save and start
            </Button>
          </div>
        </aside>
      </div>
    </>
  );
}
