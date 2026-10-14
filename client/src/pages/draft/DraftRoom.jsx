import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client.js';
import PageHeader from '../../components/PageHeader.jsx';
import Button from '../../components/Button.jsx';
import SetupForm from './SetupForm.jsx';
import { ROLE_SHORT, SOURCE, formatClock, recordLine } from './format.js';

export default function DraftRoom({ id }) {
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [coverage, setCoverage] = useState('All');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/drafts/${id}`);
      setRoom(data);
      setReceivedAt(Date.now());
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the draft');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const status = room?.draft?.status;
  useEffect(() => {
    if (status !== 'live' && status !== 'paused') return undefined;
    const tick = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(tick);
  }, [status, room?.draft?.clockEndsAt]);

  const remaining = useMemo(() => {
    if (!room) return null;
    if (room.draft.status === 'paused') return room.draft.pausedRemainingMs ?? 0;
    if (room.draft.status !== 'live' || !room.draft.clockEndsAt) return null;
    const offset = receivedAt - new Date(room.serverNow).getTime();
    return new Date(room.draft.clockEndsAt).getTime() - (now - offset);
  }, [room, now, receivedAt]);

  useEffect(() => {
    if (status !== 'live' && status !== 'paused') return undefined;
    const delay = remaining != null && remaining < 3000 ? 500 : 1500;
    const poll = setInterval(load, delay);
    return () => clearInterval(poll);
  }, [status, remaining, load]);

  async function act(path, body) {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/drafts/${id}/${path}`, body);
      setRoom(data);
      setReceivedAt(Date.now());
      setSelected(null);
    } catch (err) {
      setError(err.response?.data?.error || 'That did not go through');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveQueue(analystIds) {
    setError('');
    try {
      const { data } = await api.put(`/drafts/${id}/queue`, { analystIds });
      setRoom(data);
      setReceivedAt(Date.now());
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the queue');
    }
  }

  if (!room && !error) {
    return <PageHeader kicker="Draft" title="Draft room" subtitle="Loading…" />;
  }
  if (!room) {
    return (
      <>
        <PageHeader kicker="Draft" title="Draft room" />
        <p className="text-sm text-red-700">{error}</p>
      </>
    );
  }

  if (room.draft.status === 'setup') {
    if (room.viewer.isAdmin) return <SetupForm draftId={id} />;
    return (
      <>
        <PageHeader
          kicker="Draft"
          title={room.draft.name}
          subtitle="This draft has not started. The room opens when a commissioner starts the clock."
        />
        <OrderStrip order={room.order} />
      </>
    );
  }

  const groups = ['All', ...new Set(room.board.flatMap((a) => a.coverage || []))].sort((a, b) => {
    if (a === 'All') return -1;
    if (b === 'All') return 1;
    return a.localeCompare(b);
  });
  const board = room.board.filter((a) => {
    if (coverage !== 'All' && !(a.coverage || []).includes(coverage)) return false;
    if (query && !a.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return true;
  });
  const queueIds = room.myQueue || [];
  const byId = new Map(room.board.map((a) => [a.id, a]));
  const onClockName = room.onClock?.pmName;
  const mine = room.viewer.seatUserId && room.onClock?.pmId === room.viewer.seatUserId;

  return (
    <>
      <PageHeader
        kicker="Draft"
        title={room.draft.name}
        subtitle={
          room.draft.status === 'complete'
            ? 'The board is closed. Rosters are the pods.'
            : room.draft.snake
              ? 'Snake order. The clock picks from a manager’s queue, or the best record if the queue is empty.'
              : 'Same order every round.'
        }
        actions={
          room.viewer.isAdmin && room.draft.status !== 'complete' ? (
            <AdminBar
              status={room.draft.status}
              busy={busy}
              onPause={() => act('pause')}
              onResume={() => act('resume')}
              onUndo={() => {
                if (window.confirm('Take the last pick off the board?')) act('undo');
              }}
              onEnd={() => {
                if (window.confirm('End the draft and save the rosters picked so far?')) act('end');
              }}
            />
          ) : null
        }
      />

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {room.draft.status !== 'complete' && room.onClock && (
        <div
          className={`mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4 ${
            mine ? 'border-gold bg-gold-100/40' : 'border-navy/[0.07] bg-white'
          }`}
        >
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gold-700">
              {room.draft.status === 'paused' ? 'Paused' : 'On the clock'}
              {' · '}Round {room.onClock.round}
              {' · '}Pick {room.onClock.pickNumber}
            </div>
            <div className="mt-1 font-serif text-3xl font-medium text-navy">{onClockName}</div>
            <div className="mt-1 text-sm text-navy-400">
              {room.viewer.canPick
                ? mine
                  ? 'Your pick.'
                  : `Assign this pick to ${onClockName}.`
                : 'Analysts can watch. Only the manager on the clock can pick.'}
            </div>
          </div>
          <div
            className="font-serif text-5xl font-medium tabular-nums tracking-tight text-navy"
            aria-live="polite"
            aria-label="Time remaining"
          >
            {remaining == null ? '—' : formatClock(remaining)}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {groups.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setCoverage(g)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  coverage === g ? 'bg-navy text-white' : 'bg-white text-navy-400 hover:text-navy'
                }`}
              >
                {g}
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search analysts"
              className="ml-auto w-40 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
            />
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {board.map((a) => {
              const isSel = selected === a.id;
              return (
                <li
                  key={a.id}
                  className={`rounded-2xl border bg-white p-4 ${
                    !a.available
                      ? 'border-navy-100 opacity-60'
                      : isSel
                        ? 'border-gold ring-1 ring-gold'
                        : 'border-navy/[0.07]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link to={`/members/${a.id}`} className="font-semibold text-navy hover:text-gold-700">
                        {a.name}
                      </Link>
                      <div className="text-[11px] uppercase tracking-wider text-navy-400">
                        {ROLE_SHORT[a.role] || a.role}
                        {a.classYear ? ` · Class of ${a.classYear}` : ''}
                      </div>
                    </div>
                    {!a.available && (
                      <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-navy-400">
                        Drafted
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(a.coverage || []).length === 0 && (
                      <span className="text-[11px] text-navy-300">No coverage group</span>
                    )}
                    {(a.coverage || []).map((c) => (
                      <span
                        key={c}
                        className="rounded-md bg-navy-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-navy"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-navy-400">{recordLine(a)}</div>
                  {a.available && (room.viewer.canPick || room.viewer.canQueue) && (
                    <div className="mt-3 flex gap-2">
                      {room.viewer.canPick && (
                        <Button
                          variant={isSel ? 'gold' : 'outline'}
                          className="px-2.5 py-1 text-xs"
                          disabled={busy}
                          onClick={() => {
                            if (!isSel) setSelected(a.id);
                            else act('pick', { analystId: a.id });
                          }}
                        >
                          {isSel ? 'Confirm pick' : 'Draft'}
                        </Button>
                      )}
                      {room.viewer.canQueue && !queueIds.includes(a.id) && (
                        <Button
                          variant="ghost"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => saveQueue([...queueIds, a.id])}
                        >
                          Queue
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {board.length === 0 && (
            <p className="py-8 text-center text-sm text-navy-400">No analysts match.</p>
          )}
        </section>

        <aside className="space-y-4">
          {room.viewer.canQueue && (
            <div className="rounded-2xl border border-navy/[0.07] bg-white p-4">
              <h2 className="font-serif text-xl font-medium text-navy">Your queue</h2>
              <p className="mt-1 text-xs text-navy-400">
                If your clock runs out, the highest name still available is taken. An empty queue
                takes the best record on the board.
              </p>
              {queueIds.length === 0 ? (
                <p className="mt-3 text-sm text-navy-400">Nothing ranked yet.</p>
              ) : (
                <ol className="mt-3 space-y-1">
                  {queueIds.map((qid, i) => {
                    const person = byId.get(qid);
                    return (
                      <li key={qid} className="flex items-center gap-2 text-sm">
                        <span className="w-4 tabular-nums text-navy-400">{i + 1}</span>
                        <span className={`flex-1 ${person && !person.available ? 'text-navy-300 line-through' : 'text-navy'}`}>
                          {person?.name || 'Unknown'}
                        </span>
                        <button type="button" className="text-xs text-navy-400" disabled={i === 0} onClick={() => {
                          const next = [...queueIds];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          saveQueue(next);
                        }}>Up</button>
                        <button type="button" className="text-xs text-navy-400" disabled={i === queueIds.length - 1} onClick={() => {
                          const next = [...queueIds];
                          [next[i + 1], next[i]] = [next[i], next[i + 1]];
                          saveQueue(next);
                        }}>Down</button>
                        <button type="button" className="text-xs text-navy-400" onClick={() => saveQueue(queueIds.filter((x) => x !== qid))}>
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          )}

          <div className="rounded-2xl border border-navy/[0.07] bg-white p-4">
            <h2 className="font-serif text-xl font-medium text-navy">Rosters</h2>
            <ul className="mt-3 space-y-4">
              {room.seats.map((s) => {
                const active = room.onClock?.pmId === s.userId && room.draft.status !== 'complete';
                return (
                  <li key={s.userId}>
                    <div className={`text-sm font-semibold ${active ? 'text-gold-700' : 'text-navy'}`}>
                      {s.name}
                      {active ? ' · on the clock' : ''}
                    </div>
                    {s.roster.length === 0 ? (
                      <p className="text-xs text-navy-300">No picks yet</p>
                    ) : (
                      <ol className="mt-1 space-y-0.5">
                        {s.roster.map((r) => (
                          <li key={r.analystId} className="text-sm text-navy">
                            <span className="mr-2 text-[11px] tabular-nums text-navy-300">{r.pickNumber}</span>
                            <Link to={`/members/${r.analystId}`} className="hover:text-gold-700">
                              {r.name}
                            </Link>
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-2xl border border-navy/[0.07] bg-white p-4">
            <h2 className="font-serif text-xl font-medium text-navy">Pick log</h2>
            {room.picks.length === 0 ? (
              <p className="mt-2 text-sm text-navy-400">No picks yet.</p>
            ) : (
              <ol className="mt-2 space-y-1.5">
                {[...room.picks].reverse().map((p) => (
                  <li key={p.pickNumber} className="text-sm text-navy">
                    <span className="mr-2 text-[11px] tabular-nums text-navy-300">{p.pickNumber}</span>
                    {p.pmName} took {p.analystName}
                    <span className="ml-1 text-[10px] uppercase tracking-wider text-navy-300">
                      {SOURCE[p.source] || p.source}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function AdminBar({ status, busy, onPause, onResume, onUndo, onEnd }) {
  return (
    <>
      {status === 'live' ? (
        <Button variant="outline" disabled={busy} onClick={onPause}>
          Pause
        </Button>
      ) : (
        <Button variant="gold" disabled={busy} onClick={onResume}>
          Resume
        </Button>
      )}
      <Button variant="outline" disabled={busy} onClick={onUndo}>
        Undo last pick
      </Button>
      <Button variant="danger" disabled={busy} onClick={onEnd}>
        End draft
      </Button>
    </>
  );
}

function OrderStrip({ order }) {
  if (!order?.length) return null;
  const rounds = new Map();
  for (const slot of order) {
    if (!rounds.has(slot.round)) rounds.set(slot.round, []);
    rounds.get(slot.round).push(slot.pmName);
  }
  return (
    <ol className="space-y-2">
      {[...rounds.entries()].slice(0, 4).map(([round, names]) => (
        <li key={round} className="text-sm text-navy">
          <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-gold-700">
            Round {round}
          </span>
          {names.join(' → ')}
        </li>
      ))}
    </ol>
  );
}
