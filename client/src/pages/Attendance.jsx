import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  Download,
  ChevronDown,
  ChevronUp,
  UserMinus,
  RotateCcw,
  CalendarPlus,
  CalendarClock,
  Pencil,
  Plus,
} from 'lucide-react';
import api, { API_BASE } from '../api/client.js';
import { adoptFromResponseHeaders } from '../api/session.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import EditorialMasthead from '../components/EditorialMasthead.jsx';

const STATUSES = ['Present', 'Absent', 'Excused'];
const STATUS_COLORS = {
  Present: 'bg-emerald-100 text-emerald-800',
  Absent: 'bg-red-100 text-red-800',
  Excused: 'bg-gold-100 text-gold-800',
};

export default function Attendance() {
  const { isAdmin, isAdvisory } = useAuth();
  if (isAdvisory) return <AdvisoryAttendance />;
  return isAdmin ? <AdminAttendance /> : <MineAttendance />;
}

function AdvisoryAttendance() {
  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="Attendance"
        subtitle="Attendance tracking is for active members only."
      />
      <Card>
        <div className="py-10 text-center text-navy-400">
          Advisory Board Members and Faculty Advisors don't have attendance
          recorded. Nothing to show here.
        </div>
      </Card>
    </>
  );
}

// A member whose attendance isn't tracked: taken off the weekly roster by
// a president (the server sends the standing as `reason`), or in an
// exempt role the advisory check above doesn't catch, like Chief of
// Communication. Without this the page printed "null%".
function NotTrackedAttendance({ reason }) {
  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="My Attendance"
        subtitle="Attendance is tracked for members on the weekly roster."
      />
      <Card>
        <div className="py-10 text-center text-navy-400">
          {reason ? (
            <>
              You're listed as{' '}
              <span className="font-semibold text-navy">{reason}</span>, so you're
              not on the weekly attendance list. If that's out of date, ask a
              president.
            </>
          ) : (
            "Your role isn't counted in attendance. Nothing to show here."
          )}
        </div>
      </Card>
    </>
  );
}

function MineAttendance() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/attendance/mine').then((r) => setData(r.data));
  }, []);

  if (!data) return <div>Loading…</div>;
  if (data.exempt) return <NotTrackedAttendance reason={data.reason} />;

  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="My Attendance"
        subtitle="Your attendance record across meetings and events."
      />

      <EditorialMasthead
        stats={[
          {
            kicker: 'Attendance Rate',
            value: `${data.percentage}%`,
            sub: `${data.present} present of ${data.total}`,
          },
          {
            kicker: 'Present',
            value: data.present,
            sub: 'Meetings attended',
          },
          {
            kicker: 'Excused',
            value: data.excused,
            sub: 'Approved absences',
          },
        ]}
      />

      <div className="mt-6">
        <Card title="History">
          {data.records.length === 0 ? (
            <div className="py-8 text-center text-navy-400">No attendance records yet.</div>
          ) : (
            <ul className="divide-y divide-navy-50">
              {data.records.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-semibold text-navy">{r.event.title}</div>
                    <div className="text-xs text-navy-400">
                      {format(new Date(r.event.date), 'MMM d, yyyy')}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS_COLORS[r.status]}`}
                  >
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function AdminAttendance() {
  const [data, setData] = useState({
    users: [],
    events: [],
    records: [],
    offRoster: [],
    memberStatuses: [],
    noteMax: 200,
    canManageRoster: false,
  });
  const [loading, setLoading] = useState(true);
  const [showPast, setShowPast] = useState(false);
  // The member the "take off the roster" dialog is open for, if any.
  const [removing, setRemoving] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  // Meetings and the weekly schedule. Each dialog holds what it is open
  // for: the meeting being cancelled, the series being edited ({} for a
  // new one), the series being ended.
  const [series, setSeries] = useState([]);
  const [cancelling, setCancelling] = useState(null);
  const [addingMeeting, setAddingMeeting] = useState(false);
  const [editingSeries, setEditingSeries] = useState(null);
  const [endingSeries, setEndingSeries] = useState(null);
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    const [attendance, schedule] = await Promise.all([
      api.get('/attendance'),
      api.get('/event-series').catch(() => ({ data: [] })),
    ]);
    setData(attendance.data);
    setSeries(schedule.data);
    setLoading(false);
  }

  async function restoreMeeting(event) {
    try {
      await api.post(`/events/${event.id}/restore`);
      setNotice(`${event.title} on ${format(new Date(event.date), 'MMM d')} is back on.`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not restore this meeting');
    }
  }

  async function resumeSeries(s) {
    try {
      const { data: res } = await api.put(`/event-series/${s.id}`, { endsOn: null });
      setNotice(`${s.title} runs again: ${res.changes.created} upcoming meetings added.`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not resume this meeting');
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Wipe every attendance row for a given event. Confirm twice — once
  // on the in-page button, again with a typed-in date so the executive
  // can't nuke the wrong column with a stray click.
  async function clearEventAttendance(event) {
    const dateLabel = format(new Date(event.date), 'MMM d, yyyy');
    const ok = window.confirm(
      `Clear EVERY attendance record for "${event.title}" on ${dateLabel}?\n\nThis cannot be undone.`
    );
    if (!ok) return;
    try {
      await api.delete(`/attendance/event/${event.id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to clear attendance');
    }
  }

  // Pin the "Current" meeting: the next upcoming one (or today).
  // Fallback to the most recent past meeting if nothing upcoming exists.
  // Then sort everything else newest-first after the current one.
  //
  // Cutover happens at *midnight*, not at the meeting time — so a 7pm
  // meeting on Wednesday stays "current" until end of day Wednesday,
  // not the moment 7pm passes. Without this, attendance would jump to
  // next week's meeting mid-meeting.
  const { sortedEvents, currentEventId, defaultEvents } = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const all = [...data.events].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    // A cancelled meeting is never "current": attendance moves on to the
    // next one that is actually happening.
    const held = all.filter((e) => !e.cancelledAt);
    const upcoming = held.find((e) => {
      const d = new Date(e.date);
      d.setHours(0, 0, 0, 0);
      return d >= todayStart;
    });
    const currentId = upcoming?.id ?? held[held.length - 1]?.id ?? all[all.length - 1]?.id ?? null;
    const rest = all
      .filter((e) => e.id !== currentId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const current = all.find((e) => e.id === currentId);
    const ordered = current ? [current, ...rest] : rest;
    // By default: the current meeting and the one just before it. The
    // second column used to be rest[0], newest first, which with two
    // weeks of lookahead is the furthest FUTURE meeting, not a past one.
    // It also hid a meeting the moment it was cancelled, because the
    // current column moved on and took the Restore button with it.
    const idx = all.findIndex((e) => e.id === currentId);
    const before = idx > 0 ? all[idx - 1] : null;
    const pair = [current, before ?? rest[0]].filter(Boolean);
    return { sortedEvents: ordered, currentEventId: currentId, defaultEvents: pair };
  }, [data.events]);

  // The current meeting and the one before it; expand to all with "Show".
  const visibleEvents = showPast ? sortedEvents : defaultEvents;

  const recordMap = useMemo(() => {
    const m = new Map();
    for (const r of data.records) m.set(`${r.userId}:${r.eventId}`, r.status);
    return m;
  }, [data.records]);

  async function setStatus(userId, eventId, status) {
    const key = `${userId}:${eventId}`;
    const prev = recordMap.get(key);
    recordMap.set(key, status);
    setData({ ...data });
    try {
      await api.post('/attendance', { userId, eventId, status });
    } catch {
      if (prev) recordMap.set(key, prev);
      else recordMap.delete(key);
      setData({ ...data });
    }
  }

  async function restore(member) {
    setRestoringId(member.id);
    try {
      await api.put(`/attendance/roster/${member.id}`, { status: 'Active' });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not restore this member');
    } finally {
      setRestoringId(null);
    }
  }

  async function downloadCsv() {
    const token = localStorage.getItem('gcig_token');
    const res = await fetch(`${API_BASE}/attendance/export.csv`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    adoptFromResponseHeaders(res.headers);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'griffin-fund-attendance.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="Attendance"
        subtitle="Mark attendance at each meeting. Cancel a week, add a meeting, or change the weekly schedule below."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAddingMeeting(true)} variant="outline">
              <CalendarPlus className="h-4 w-4" />
              Add meeting
            </Button>
            <Button onClick={downloadCsv} variant="gold">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </div>
        }
      />

      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="text-xs font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      {data.events.length > 0 && data.users.length > 0 && (
        <div className="mb-6">
          <EditorialMasthead
            stats={(() => {
              // Club-wide participation for the events we have records on.
              const presentCount = data.records.filter(
                (r) => r.status === 'Present'
              ).length;
              const possible = data.records.length;
              const rate =
                possible > 0 ? Math.round((presentCount / possible) * 100) : 0;
              return [
                {
                  kicker: 'Fund attendance',
                  value: `${rate}%`,
                  sub: `${presentCount} present of ${possible} records`,
                },
                (() => {
                  const cancelled = data.events.filter((e) => e.cancelledAt).length;
                  return {
                    kicker: 'Events Tracked',
                    value: data.events.length - cancelled,
                    sub: cancelled
                      ? `Meetings + pitches · ${cancelled} cancelled, not counted`
                      : 'Meetings + pitches with attendance',
                  };
                })(),
                {
                  kicker: 'Active Members',
                  value: data.users.length,
                  sub:
                    data.offRoster.length > 0
                      ? `Counted in attendance · ${data.offRoster.length} off the roster`
                      : 'Counted in attendance',
                },
              ];
            })()}
          />
        </div>
      )}

      <Card>
        {loading ? (
          <div className="py-8 text-center text-navy-400">Loading…</div>
        ) : data.events.length === 0 ? (
          <div className="py-8 text-center text-navy-400">
            No meetings in the last three months or the next two weeks. Add one
            with <span className="font-semibold">Add meeting</span>, or set up the
            weekly schedule below.
          </div>
        ) : (
          <>
            {/* Mobile: one event at a time. Defaults to the current meeting;
                a pill bar at the top lets you switch. Each member is its own
                row with a big dropdown. */}
            <MobileAttendance
              events={visibleEvents}
              users={data.users}
              recordMap={recordMap}
              currentEventId={currentEventId}
              setStatus={setStatus}
              onRemove={data.canManageRoster ? setRemoving : null}
              onCancel={setCancelling}
              onRestore={restoreMeeting}
            />

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="sticky left-0 z-10 bg-white py-2 pr-4">Member</th>
                    {visibleEvents.map((e) => {
                      const isCurrent = e.id === currentEventId;
                      return (
                        <th
                          key={e.id}
                          className={`py-2 px-3 text-center ${
                            isCurrent ? 'bg-gold-100 rounded-t-lg' : ''
                          }`}
                        >
                          {isCurrent && (
                            <div className="mb-1 rounded-full bg-gold px-2 py-0.5 text-[10px] font-bold uppercase text-navy inline-block">
                              Current
                            </div>
                          )}
                          <div
                            className={`font-semibold normal-case ${
                              e.cancelledAt ? 'text-navy-400 line-through' : 'text-navy'
                            }`}
                          >
                            {e.title}
                          </div>
                          <div className="text-[10px] text-navy-400">
                            {format(new Date(e.date), 'MMM d, yyyy')}
                          </div>
                          {e.cancelledAt ? (
                            <CancelledTag event={e} onRestore={restoreMeeting} />
                          ) : (
                            <div className="mt-1 flex justify-center gap-3">
                              <button
                                type="button"
                                onClick={() => setCancelling(e)}
                                className="text-[10px] font-semibold text-navy-500 underline hover:text-navy"
                                title="Cancel this meeting: it stops counting toward attendance"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => clearEventAttendance(e)}
                                className="text-[10px] font-semibold text-red-600 underline hover:text-red-700"
                                title="Clear all attendance for this meeting"
                              >
                                Clear
                              </button>
                            </div>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td className="sticky left-0 z-10 bg-white py-3 pr-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-navy">{u.name}</div>
                            <div className="mt-1">
                              <RoleBadge role={u.role} />
                            </div>
                          </div>
                          {data.canManageRoster && (
                            <RemoveFromRosterButton member={u} onClick={setRemoving} />
                          )}
                        </div>
                      </td>
                      {visibleEvents.map((e) => {
                        const isCurrent = e.id === currentEventId;
                        const status = recordMap.get(`${u.id}:${e.id}`) || '';
                        if (e.cancelledAt) {
                          return (
                            <td key={e.id} className="bg-navy-50/50 py-3 px-3 text-center text-xs text-navy-200">
                              —
                            </td>
                          );
                        }
                        return (
                          <td
                            key={e.id}
                            className={`py-3 px-3 text-center ${
                              isCurrent ? 'bg-gold-100/40' : ''
                            }`}
                          >
                            <select
                              value={status}
                              onChange={(ev) => setStatus(u.id, e.id, ev.target.value)}
                              className={`rounded-md border border-navy-100 px-2 py-1 text-xs font-semibold ${
                                status ? STATUS_COLORS[status] : ''
                              }`}
                            >
                              <option value="">—</option>
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {sortedEvents.length > defaultEvents.length && (
              <div className="mt-4 text-center">
                <button
                  onClick={() => setShowPast(!showPast)}
                  className="inline-flex items-center gap-1 rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-navy-50"
                >
                  {showPast ? (
                    <>
                      <ChevronUp className="h-4 w-4" />
                      Show fewer meetings
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-4 w-4" />
                      Show all meetings ({sortedEvents.length - defaultEvents.length} more)
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <WeeklySchedule
        series={series}
        onAdd={() => setEditingSeries({})}
        onEdit={setEditingSeries}
        onEnd={setEndingSeries}
        onResume={resumeSeries}
      />

      {data.offRoster.length > 0 && (
        <OffRosterList
          members={data.offRoster}
          canManage={data.canManageRoster}
          restoringId={restoringId}
          onRestore={restore}
        />
      )}

      <RemoveFromRosterModal
        member={removing}
        options={data.memberStatuses}
        noteMax={data.noteMax}
        onClose={() => setRemoving(null)}
        onDone={load}
      />
      <CancelMeetingModal
        event={cancelling}
        onClose={() => setCancelling(null)}
        onDone={async (message) => {
          setNotice(message);
          await load();
        }}
      />
      <AddMeetingModal
        open={addingMeeting}
        onClose={() => setAddingMeeting(false)}
        onDone={async (message) => {
          setNotice(message);
          await load();
        }}
      />
      <SeriesModal
        series={editingSeries}
        onClose={() => setEditingSeries(null)}
        onDone={async (message) => {
          setNotice(message);
          await load();
        }}
      />
      <EndSeriesModal
        series={endingSeries}
        onClose={() => setEndingSeries(null)}
        onDone={async (message) => {
          setNotice(message);
          await load();
        }}
      />
    </>
  );
}

// Labelled, not a bare icon. It used to be a pale glyph beside each name,
// and the presidents it was built for asked for a way to do the thing it
// already did.
function RemoveFromRosterButton({ member, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(member)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-navy-100 bg-white px-2 py-1 text-[11px] font-semibold text-navy transition hover:border-navy hover:bg-navy-50"
      title="Take off the attendance list. They keep their account."
      aria-label={`Take ${member.name} off the attendance list`}
    >
      <UserMinus className="h-3.5 w-3.5" />
      Remove
    </button>
  );
}

// Taking someone off the weekly roster is a statement about their place
// in the club, not a mark on one meeting, so it asks why. The reasons come
// from the server, the same list it validates against.
function RemoveFromRosterModal({ member, options, noteMax, onClose, onDone }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Start fresh each time the dialog opens for someone.
  useEffect(() => {
    setStatus('');
    setNote('');
    setError('');
  }, [member?.id]);

  const needsNote = status === 'Other';
  const canSubmit = !!status && (!needsNote || note.trim()) && !saving;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await api.put(`/attendance/roster/${member.id}`, { status, note });
      onClose();
      await onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update the roster');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={member ? `Take ${member.name} off the weekly roster` : ''}
      size="sm"
    >
      {member && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-navy-400">
            They stay a member, with the same role and access. They just won't
            be on weekly attendance, and won't count toward the club's rate.
            You can restore them any time, and their past record comes back
            with them.
          </p>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy-400">
              Why
            </legend>
            {options.map((o) => (
              <label
                key={o.value}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm text-navy transition ${
                  status === o.value
                    ? 'border-navy bg-navy-50'
                    : 'border-navy-100 hover:bg-navy-50/60'
                }`}
              >
                <input
                  type="radio"
                  name="roster-status"
                  value={o.value}
                  checked={status === o.value}
                  onChange={() => setStatus(o.value)}
                  className="accent-navy"
                />
                {o.label}
              </label>
            ))}
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy-400">
              Note {needsNote ? '(required)' : '(optional)'}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={noteMax}
              rows={2}
              placeholder={
                needsNote
                  ? 'What should the next president know?'
                  : 'e.g. Class of 2026, still advises on energy'
              }
              className="w-full rounded-lg border border-navy-100 px-3 py-2 text-sm text-navy focus:border-navy focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-navy-400">
              Visible to executives on this page, not to the member.
            </span>
          </label>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? 'Saving…' : 'Take off roster'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Everyone a president has taken off the weekly roster, and why. Kept on
// the same page as the grid so a missing name is never a mystery: the
// answer is right underneath, with a way back.
function OffRosterList({ members, canManage, restoringId, onRestore }) {
  return (
    <div className="mt-6">
      <Card title={`Not on the weekly roster (${members.length})`}>
        <p className="mb-2 text-xs text-navy-400">
          Still members of the club. They aren't expected at weekly meetings
          and don't count toward the attendance rate.
        </p>
        <ul className="divide-y divide-navy-50">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-navy">{m.name}</span>
                  <RoleBadge role={m.role} />
                  <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[11px] font-semibold text-navy">
                    {m.statusLabel}
                  </span>
                </div>
                {m.note && <div className="mt-1 text-sm text-navy-400">{m.note}</div>}
                {m.changedAt && (
                  <div className="mt-1 text-[11px] text-navy-400">
                    {m.changedBy ? `${m.changedBy} · ` : ''}
                    {format(new Date(m.changedAt), 'MMM d, yyyy')}
                  </div>
                )}
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => onRestore(m)}
                  disabled={restoringId === m.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy transition hover:bg-navy-50 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {restoringId === m.id ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function MobileAttendance({
  events,
  users,
  recordMap,
  currentEventId,
  setStatus,
  onRemove,
  onCancel,
  onRestore,
}) {
  const [selectedEventId, setSelectedEventId] = useState(
    currentEventId || events[0]?.id || null
  );
  // Re-sync when the parent's current event changes (e.g. after fetch).
  useEffect(() => {
    if (!selectedEventId && (currentEventId || events[0]?.id)) {
      setSelectedEventId(currentEventId || events[0]?.id || null);
    }
  }, [currentEventId, events, selectedEventId]);

  const selected = events.find((e) => e.id === selectedEventId) || events[0];
  if (!selected) return null;

  return (
    <div className="md:hidden">
      {/* Event pill selector */}
      <div className="-mx-2 flex gap-2 overflow-x-auto px-2 pb-3">
        {events.map((e) => {
          const isCurrent = e.id === currentEventId;
          const isActive = e.id === selected.id;
          return (
            <button
              key={e.id}
              onClick={() => setSelectedEventId(e.id)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                isActive
                  ? 'border-navy bg-navy text-white'
                  : isCurrent
                  ? 'border-gold bg-gold-100/60 text-navy'
                  : 'border-navy-100 bg-white text-navy-400'
              }`}
            >
              {isCurrent && !isActive && <span className="mr-1 text-gold">●</span>}
              <span className={e.cancelledAt ? 'line-through' : ''}>{e.title}</span>
              <span className="ml-2 opacity-60">
                {format(new Date(e.date), 'M/d')}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-navy-400">
        <span>{format(new Date(selected.date), 'EEE, MMM d, yyyy')}</span>
        {!selected.cancelledAt && onCancel && (
          <button
            type="button"
            onClick={() => onCancel(selected)}
            className="font-semibold text-navy-500 underline"
          >
            Cancel this meeting
          </button>
        )}
      </div>
      {selected.cancelledAt && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center">
          <CancelledTag event={selected} onRestore={onRestore} />
        </div>
      )}

      <ul className="divide-y divide-navy-50">
        {users.map((u) => {
          const status = recordMap.get(`${u.id}:${selected.id}`) || '';
          return (
            <li key={u.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-navy">{u.name}</div>
                <div className="mt-0.5"><RoleBadge role={u.role} /></div>
              </div>
              {onRemove && <RemoveFromRosterButton member={u} onClick={onRemove} />}
              {selected.cancelledAt ? (
                <span className="w-16 shrink-0 text-center text-xs text-navy-200">—</span>
              ) : (
              <select
                value={status}
                onChange={(ev) => setStatus(u.id, selected.id, ev.target.value)}
                className={`shrink-0 rounded-md border border-navy-100 px-2 py-2 text-xs font-semibold ${
                  status ? STATUS_COLORS[status] : ''
                }`}
              >
                <option value="">—</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Meetings and the weekly schedule ──────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FIELD =
  'w-full rounded-lg border border-navy-100 px-3 py-2 text-sm text-navy focus:border-navy focus:outline-none';
const pad2 = (n) => String(n).padStart(2, '0');

// Today in New York, as the YYYY-MM-DD the schedule speaks. The club
// meets in New York whatever timezone a browser is set to.
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// A YYYY-MM-DD read at noon, so no timezone can move it to another day.
function formatKey(key, pattern = 'MMM d') {
  return format(new Date(`${key}T12:00:00`), pattern);
}

function Label({ children }) {
  return (
    <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy-400">
      {children}
    </span>
  );
}

function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </div>
  );
}

function CancelledTag({ event, onRestore }) {
  const detail = [event.cancelReason, event.cancelledBy].filter(Boolean).join(' · ');
  return (
    <div className="mt-1 space-y-1 text-center normal-case">
      <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
        Cancelled
      </span>
      {detail && (
        <div className="mx-auto max-w-[11rem] text-[10px] font-normal text-navy-400">{detail}</div>
      )}
      {onRestore && (
        <button
          type="button"
          onClick={() => onRestore(event)}
          className="block w-full text-[10px] font-semibold text-navy underline hover:text-navy-500"
        >
          Restore
        </button>
      )}
    </div>
  );
}

// Cancelling one week is not deleting it. The meeting stays on the
// calendar saying it is off, so nobody turns up to an empty room, and
// whatever was marked is kept in case it is restored.
function CancelMeetingModal({ event, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setReason('');
    setError('');
  }, [event?.id]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/events/${event.id}/cancel`, { reason });
      onClose();
      await onDone(
        `${event.title} on ${format(new Date(event.date), 'MMM d')} is cancelled. It no longer counts toward anyone's attendance.`
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not cancel this meeting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={!!event} onClose={onClose} title={event ? `Cancel ${event.title}` : ''} size="sm">
      {event && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-navy-400">
            {format(new Date(event.date), 'EEEE, MMM d · h:mm a')}. It stays on the calendar
            marked as cancelled, nobody can be marked at it, and it won't count toward anyone's
            attendance. Anything already marked is kept, in case you restore it.
          </p>
          <label className="block">
            <Label>Reason (optional)</Label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="e.g. Midterms week"
              className={FIELD}
            />
            <span className="mt-1 block text-[11px] text-navy-400">
              Shown with the meeting on the calendar.
            </span>
          </label>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Keep it
            </Button>
            <Button type="submit" variant="danger" disabled={saving}>
              {saving ? 'Cancelling…' : 'Cancel meeting'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// A one-off meeting: a make-up week, an extra session before a vote. It
// counts for attendance like any other meeting.
function AddMeetingModal({ open, onClose, onDone }) {
  const blank = () => ({
    title: 'Griffin Fund Meeting',
    date: todayKey(),
    time: '13:50',
    duration: 30,
    location: '',
  });
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(blank());
      setError('');
    }
  }, [open]);

  async function submit(e) {
    e.preventDefault();
    const when = new Date(`${form.date}T${form.time}`);
    if (!form.title.trim() || Number.isNaN(when.getTime())) {
      setError('Give the meeting a title, a date and a time.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/events', {
        title: form.title.trim(),
        date: when.toISOString(),
        location: form.location.trim() || null,
        durationMinutes: Number(form.duration),
        audience: 'all',
      });
      onClose();
      const later = when.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000;
      await onDone(
        `${form.title.trim()} added for ${format(when, 'EEE, MMM d · h:mm a')}.` +
          (later ? ' It appears in this grid two weeks before it happens.' : '')
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add the meeting');
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Add a meeting" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-navy-400">
          A one-off meeting, counted for attendance like any other. For one that repeats every
          week, use <span className="font-semibold">Add weekly meeting</span> instead.
        </p>
        <label className="block">
          <Label>Title</Label>
          <input value={form.title} onChange={set('title')} maxLength={120} required className={FIELD} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <Label>Date</Label>
            <input type="date" value={form.date} onChange={set('date')} required className={FIELD} />
          </label>
          <label className="block">
            <Label>Starts</Label>
            <input type="time" value={form.time} onChange={set('time')} required className={FIELD} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <Label>Minutes</Label>
            <input type="number" min={5} max={480} value={form.duration} onChange={set('duration')} required className={FIELD} />
          </label>
          <label className="block">
            <Label>Location (optional)</Label>
            <input value={form.location} onChange={set('location')} maxLength={200} className={FIELD} />
          </label>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Never mind
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Adding…' : 'Add meeting'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// The meetings that repeat every week. This was a constant in the
// server's code, so moving the meeting took a developer and a deploy.
function WeeklySchedule({ series, onAdd, onEdit, onEnd, onResume }) {
  const today = todayKey();
  return (
    <div className="mt-6">
      <Card title="Weekly schedule">
        <p className="mb-2 text-xs text-navy-400">
          Meetings that repeat every week. Changes apply to upcoming meetings only: past meetings,
          and the attendance taken at them, stay as they were. To skip a single week, cancel that
          meeting in the grid above.
        </p>
        {series.length === 0 ? (
          <div className="py-4 text-sm text-navy-400">No weekly meetings yet.</div>
        ) : (
          <ul className="divide-y divide-navy-50">
            {series.map((s) => {
              const ended = s.endsOn && s.endsOn < today;
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${ended ? 'text-navy-400' : 'text-navy'}`}>
                        {s.title}
                      </span>
                      {ended ? (
                        <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[11px] font-semibold text-navy-400">
                          Ended {formatKey(s.endsOn)}
                        </span>
                      ) : s.endsOn ? (
                        <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-navy">
                          Last meeting {formatKey(s.endsOn)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-sm text-navy-400">
                      <CalendarClock className="h-3.5 w-3.5" />
                      {s.summary}
                      {s.location ? ` · ${s.location}` : ''}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {ended ? (
                      <Button variant="outline" onClick={() => onResume(s)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Resume
                      </Button>
                    ) : (
                      <>
                        <Button variant="outline" onClick={() => onEdit(s)}>
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button variant="outline" onClick={() => onEnd(s)}>
                          End
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3">
          <Button variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add weekly meeting
          </Button>
        </div>
      </Card>
    </div>
  );
}

function describeChanges(c) {
  const parts = [];
  if (c.updated) parts.push(`${c.updated} upcoming meeting${c.updated === 1 ? '' : 's'} updated`);
  if (c.created) parts.push(`${c.created} added`);
  if (c.removed) parts.push(`${c.removed} removed`);
  return parts.length ? `${parts.join(', ')}.` : 'No upcoming meetings needed changing.';
}

// Add a weekly meeting, or change one. `series` is {} for a new one.
function SeriesModal({ series, onClose, onDone }) {
  const isNew = !!series && !series.id;
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!series) return;
    setError('');
    setForm(
      series.id
        ? {
            title: series.title,
            dayOfWeek: series.dayOfWeek,
            time: `${pad2(series.startHour)}:${pad2(series.startMinute)}`,
            durationMinutes: series.durationMinutes,
            location: series.location || '',
            startsOn: series.startsOn,
            endsOn: series.endsOn || '',
          }
        : {
            title: '',
            dayOfWeek: 3,
            time: '13:50',
            durationMinutes: 30,
            location: '',
            startsOn: todayKey(),
            endsOn: '',
          }
    );
  }, [series]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      title: form.title,
      dayOfWeek: Number(form.dayOfWeek),
      time: form.time,
      durationMinutes: Number(form.durationMinutes),
      location: form.location,
      endsOn: form.endsOn || null,
    };
    try {
      if (isNew) {
        const { data } = await api.post('/event-series', { ...body, startsOn: form.startsOn });
        onClose();
        await onDone(
          `${data.series.title} added: ${data.series.summary}. ${data.changes.created} upcoming meetings are on the calendar.`
        );
      } else {
        const { data } = await api.put(`/event-series/${series.id}`, body);
        onClose();
        await onDone(
          `${data.series.title}: ${data.series.summary}. ${describeChanges(data.changes)} Past meetings are unchanged.`
        );
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the schedule');
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return (
    <Modal
      open={!!series}
      onClose={onClose}
      title={isNew ? 'Add a weekly meeting' : `Change ${series?.title || ''}`}
      size="sm"
    >
      {series && form && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-navy-400">
            {isNew
              ? 'It goes on the calendar every week from the first date, and counts for attendance.'
              : 'Upcoming meetings move to match. Past meetings, and the attendance taken at them, stay as they were.'}
          </p>
          <label className="block">
            <Label>Title</Label>
            <input
              value={form.title}
              onChange={set('title')}
              maxLength={120}
              required
              placeholder="e.g. Griffin Fund Weekly Meeting"
              className={FIELD}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <Label>Every</Label>
              <select value={form.dayOfWeek} onChange={set('dayOfWeek')} className={FIELD}>
                {DAY_NAMES.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <Label>Starts</Label>
              <input type="time" value={form.time} onChange={set('time')} required className={FIELD} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <Label>Minutes</Label>
              <input
                type="number"
                min={5}
                max={480}
                value={form.durationMinutes}
                onChange={set('durationMinutes')}
                required
                className={FIELD}
              />
            </label>
            <label className="block">
              <Label>Location (optional)</Label>
              <input value={form.location} onChange={set('location')} maxLength={200} className={FIELD} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {isNew && (
              <label className="block">
                <Label>First meeting on or after</Label>
                <input type="date" value={form.startsOn} onChange={set('startsOn')} required className={FIELD} />
              </label>
            )}
            <label className="block">
              <Label>Last meeting (optional)</Label>
              <input
                type="date"
                value={form.endsOn}
                onChange={set('endsOn')}
                min={form.startsOn}
                className={FIELD}
              />
            </label>
          </div>
          <span className="block text-[11px] text-navy-400">
            Times are New York time. Leave the last meeting empty to keep it going.
          </span>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Never mind
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : isNew ? 'Add weekly meeting' : 'Save changes'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Stop a weekly meeting after a given day. Its later meetings come off
// the calendar; its past ones stay, and so does the series, so it can be
// resumed.
function EndSeriesModal({ series, onClose, onDone }) {
  const [endsOn, setEndsOn] = useState(todayKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (series) {
      setEndsOn(todayKey());
      setError('');
    }
  }, [series]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put(`/event-series/${series.id}`, { endsOn });
      onClose();
      await onDone(
        `${series.title} ends after ${formatKey(endsOn)}. ${describeChanges(data.changes)} Past meetings are unchanged.`
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not end this meeting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={!!series} onClose={onClose} title={series ? `End ${series.title}` : ''} size="sm">
      {series && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-navy-400">
            No more meetings after this day. Later ones come off the calendar and the attendance
            grid. Past meetings and their attendance stay, and you can resume it any time.
          </p>
          <label className="block">
            <Label>Last meeting on or before</Label>
            <input
              type="date"
              value={endsOn}
              min={series.startsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              required
              className={FIELD}
            />
          </label>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Keep it going
            </Button>
            <Button type="submit" variant="danger" disabled={saving}>
              {saving ? 'Ending…' : 'End weekly meeting'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
