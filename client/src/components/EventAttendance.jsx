import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import RoleBadge from './RoleBadge.jsx';

const STATUSES = ['Present', 'Absent', 'Excused'];
const STATUS_COLORS = {
  Present: 'bg-emerald-100 text-emerald-800',
  Absent: 'bg-red-100 text-red-800',
  Excused: 'bg-gold-100 text-gold-800',
};

export default function EventAttendance({ eventId }) {
  const { isSuperAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(null);
  // Super-admin "add member" state. We lazy-load the addable list the
  // first time the picker is opened so we don't pay the user-list query
  // on every event-modal open.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addable, setAddable] = useState(null); // null = not yet loaded
  const [addableLoading, setAddableLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!eventId) return;
    setData(null);
    setAddable(null);
    setPickerOpen(false);
    setSearch('');
    api.get(`/attendance/event/${eventId}`).then((r) => setData(r.data));
  }, [eventId]);

  async function setStatus(userId, status) {
    setSaving(userId);
    const prev = data.records[userId];
    setData({ ...data, records: { ...data.records, [userId]: status } });
    try {
      await api.post('/attendance', { userId, eventId, status });
    } catch {
      // revert on failure
      setData({ ...data, records: { ...data.records, [userId]: prev } });
    } finally {
      setSaving(null);
    }
  }

  function markAll(status) {
    data.users.forEach((u) => setStatus(u.id, status));
  }

  // Super-admin only: clear the attendance row and drop the user from
  // the visible roster locally. Users who belong to the default audience
  // roster will reappear on next load (unmarked) — true permanent removal
  // would require role changes. Manually-added users disappear for good.
  async function removeFromRoster(userId) {
    setSaving(userId);
    const prev = { users: data.users, records: data.records };
    const nextRecords = { ...data.records };
    delete nextRecords[userId];
    setData({
      ...data,
      users: data.users.filter((u) => u.id !== userId),
      records: nextRecords,
    });
    try {
      await api.delete(`/attendance/${userId}/${eventId}`);
    } catch {
      setData({ ...data, ...prev });
    } finally {
      setSaving(null);
    }
  }

  async function loadAddable() {
    setAddableLoading(true);
    try {
      const r = await api.get(`/attendance/event/${eventId}/addable`);
      setAddable(r.data.users || []);
    } finally {
      setAddableLoading(false);
    }
  }

  function openPicker() {
    setPickerOpen(true);
    if (addable === null) loadAddable();
  }

  // Adding a member: persist an "included" roster override server-side
  // so the addition survives a reload even before any status is set.
  // Locally append immediately for snappy UI; revert if the API call fails.
  async function addToRoster(user) {
    const prev = { users: data.users, addable };
    setData({
      ...data,
      users: [...data.users, user].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    });
    setAddable((prevAddable) =>
      (prevAddable || []).filter((u) => u.id !== user.id)
    );
    setPickerOpen(false);
    setSearch('');
    try {
      await api.post(`/attendance/event/${eventId}/include/${user.id}`);
    } catch {
      setData({ ...data, users: prev.users });
      setAddable(prev.addable);
    }
  }

  const filteredAddable = useMemo(() => {
    if (!addable) return [];
    const q = search.trim().toLowerCase();
    if (!q) return addable;
    return addable.filter((u) => u.name.toLowerCase().includes(q));
  }, [addable, search]);

  if (!data) return <div className="text-sm text-navy-400">Loading members…</div>;

  const marked = Object.keys(data.records).length;
  const isAdvisory = data.event?.audience === 'advisory';

  return (
    <div>
      {isAdvisory && (
        <div className="mb-3 rounded-lg border border-gold-200 bg-gold-100/40 px-3 py-2 text-[11px] text-navy">
          <span className="font-semibold">Advisory Board event.</span> Roster
          below includes only Advisory Board members and Faculty Advisors.
          {isSuperAdmin && ' Super admin can add anyone via the button below.'}
        </div>
      )}

      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-navy-400">
          Attendance ({marked} / {data.users.length} marked)
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => markAll('Present')}
            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            All Present
          </button>
          <button
            type="button"
            onClick={() => markAll('Absent')}
            className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-800 hover:bg-red-100"
          >
            All Absent
          </button>
        </div>
      </div>

      <ul className="divide-y divide-navy-50 rounded-lg border border-navy-100">
        {data.users.map((u) => {
          const status = data.records[u.id] || '';
          return (
            <li
              key={u.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-navy">{u.name}</div>
                <div className="mt-0.5">
                  <RoleBadge role={u.role} />
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={status}
                  disabled={saving === u.id}
                  onChange={(e) => setStatus(u.id, e.target.value)}
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
                {isSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => removeFromRoster(u.id)}
                    disabled={saving === u.id}
                    title="Remove from this event's roster"
                    className="rounded-md border border-navy-100 p-1 text-navy-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {isSuperAdmin && (
        <div className="mt-3">
          {!pickerOpen ? (
            <button
              type="button"
              onClick={openPicker}
              className="inline-flex items-center gap-1.5 rounded-md border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:border-gold hover:text-gold-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Add member to roster
            </button>
          ) : (
            <div className="rounded-lg border border-navy-100 bg-white p-2">
              <div className="mb-2 flex items-center justify-between">
                <input
                  autoFocus
                  type="text"
                  placeholder="Search members…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 rounded-md border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    setSearch('');
                  }}
                  className="ml-2 rounded-md p-1 text-navy-400 hover:text-navy"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {addableLoading ? (
                <div className="px-2 py-3 text-xs text-navy-400">Loading…</div>
              ) : filteredAddable.length === 0 ? (
                <div className="px-2 py-3 text-xs text-navy-400">
                  {search
                    ? 'No matches.'
                    : 'Everyone is already in this roster.'}
                </div>
              ) : (
                <ul className="max-h-48 overflow-y-auto">
                  {filteredAddable.slice(0, 20).map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => addToRoster(u)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-navy-50"
                      >
                        <span className="truncate font-medium text-navy">
                          {u.name}
                        </span>
                        <RoleBadge role={u.role} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
