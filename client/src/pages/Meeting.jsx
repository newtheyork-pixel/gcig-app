import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Video, Copy, Check, Mail, Calendar, X } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';

// Meetings on the club's own server.
//
// This page has two quite different jobs and it is worth being clear which
// is which, because the second one is invisible until it matters.
//
// The obvious job is creating and listing meetings.
//
// The other is being the meeting server's front door. That server is
// configured so a room can only be OPENED by someone holding a token, and
// it is told to send anyone without one here. So when Jitsi bounces a
// member back with ?room=<code>, this page signs the token out of our API
// and returns them, already authorised. Without this branch a member
// clicking their own link lands on an error page that says nothing useful.

function useRoomHandoff() {
  const [params] = useSearchParams();
  // Jitsi passes the room exactly as it appeared in the URL, capitals and
  // all. Our codes are always lower case, so normalise before looking up or
  // a member's own link 404s on the way back in.
  const room = (params.get('room') || '').trim().toLowerCase();
  const [state, setState] = useState(room ? 'working' : 'idle');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!room) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post(`/meet/meetings/${encodeURIComponent(room)}/token`);
        if (cancelled) return;
        // replace(), not assign(): going Back should return to wherever the
        // member came from, not bounce them into the meeting again.
        window.location.replace(data.joinUrl);
      } catch (err) {
        if (cancelled) return;
        const status = err?.response?.status;
        setError(
          status === 404
            ? 'That meeting code does not exist. Meetings can only be opened from a link the club issued.'
            : err?.response?.data?.error || 'Could not open that meeting.',
        );
        setState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [room]);

  return { room, state, error };
}

export default function Meeting() {
  const { user } = useAuth();
  const handoff = useRoomHandoff();

  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [scheduled, setScheduled] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState(60);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/meet/meetings');
      setMeetings(data.meetings || []);
    } catch {
      setMeetings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (handoff.state === 'idle') load(); }, [load, handoff.state]);

  async function create(openNow) {
    if (!title.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const { data } = await api.post('/meet/meetings', {
        title: title.trim(),
        startsAt: scheduled && startsAt ? new Date(startsAt).toISOString() : null,
        durationMinutes: Number(duration) || 60,
      });
      setTitle('');
      setStartsAt('');
      setScheduled(false);
      await load();
      if (openNow) return join(data.code);
      setNotice(`Created. The link is ready to copy.`);
    } catch (err) {
      setNotice(err?.response?.data?.error || 'Could not create the meeting.');
    } finally {
      setBusy(false);
    }
  }

  async function join(code) {
    try {
      const { data } = await api.post(`/meet/meetings/${encodeURIComponent(code)}/token`);
      window.open(data.joinUrl, '_blank', 'noopener');
    } catch (err) {
      setNotice(err?.response?.data?.error || 'Could not open that meeting.');
    }
  }

  async function copy(m) {
    try {
      await navigator.clipboard.writeText(m.url);
      setCopied(m.code);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setNotice('Your browser would not let the page copy. The link is shown above.');
    }
  }

  async function emailToSelf(m) {
    setNotice(null);
    try {
      const { data } = await api.post(`/meet/meetings/${encodeURIComponent(m.code)}/email`);
      setNotice(`Link sent to ${data.to}.`);
    } catch (err) {
      setNotice(err?.response?.data?.error || 'Could not send the email.');
    }
  }

  async function cancel(m) {
    try {
      await api.delete(`/meet/meetings/${encodeURIComponent(m.code)}`);
      await load();
    } catch (err) {
      setNotice(err?.response?.data?.error || 'Could not cancel that meeting.');
    }
  }

  // --- the handoff branch, shown only when Jitsi sent them here ----------
  if (handoff.state === 'working') {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <Video className="mx-auto mb-4 h-8 w-8 animate-pulse text-navy-700" />
        <p className="text-navy-900">Opening the meeting…</p>
        <p className="mt-1 text-sm text-navy-400">Signing you in as {user?.name}.</p>
      </div>
    );
  }
  if (handoff.state === 'failed') {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="text-navy-900">{handoff.error}</p>
        <Button className="mt-6" onClick={() => { window.location.href = '/meeting'; }}>
          Back to meetings
        </Button>
      </div>
    );
  }

  const upcoming = useMemo(
    () => meetings.filter((m) => m.startsAt),
    [meetings],
  );
  const openNow = useMemo(
    () => meetings.filter((m) => !m.startsAt),
    [meetings],
  );

  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="Griffin Meet"
        subtitle="Video meetings on the club's own server. Members open a room; anyone with the link can join once it is open."
      />

      <Card className="mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1 block text-xs uppercase tracking-wide text-navy-400">
              What is the meeting
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q3 pitch review"
              maxLength={120}
              className="w-full rounded-lg border border-navy-200 px-3 py-2 text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs uppercase tracking-wide text-navy-400">Minutes</span>
            <input
              type="number" min={5} max={480} step={5}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="w-24 rounded-lg border border-navy-200 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-navy-700">
          <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
          Schedule it for later
        </label>
        {scheduled && (
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="mt-2 rounded-lg border border-navy-200 px-3 py-2 text-sm"
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy || !title.trim()} onClick={() => create(!scheduled)}>
            {scheduled ? 'Schedule it' : 'Start now'}
          </Button>
          {!scheduled && (
            <Button variant="secondary" disabled={busy || !title.trim()} onClick={() => create(false)}>
              Create the link without joining
            </Button>
          )}
        </div>
        {notice && <p className="mt-3 text-sm text-navy-500">{notice}</p>}
      </Card>

      {loading ? (
        <p className="text-sm text-navy-400">Loading…</p>
      ) : (
        <>
          <MeetingList
            heading="Scheduled"
            icon={Calendar}
            rows={upcoming}
            empty="Nothing scheduled."
            {...{ join, copy, copied, emailToSelf, cancel, user }}
          />
          <MeetingList
            heading="Open now"
            icon={Video}
            rows={openNow}
            empty="No rooms are open."
            {...{ join, copy, copied, emailToSelf, cancel, user }}
          />
        </>
      )}
    </>
  );
}

function MeetingList({ heading, icon: Icon, rows, empty, join, copy, copied, emailToSelf, cancel, user }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-navy-400">
        <Icon className="h-4 w-4" /> {heading}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-navy-300">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((m) => (
            <Card key={m.code} className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-navy-900">{m.title}</p>
                <p className="text-xs text-navy-400">
                  {m.startsAt
                    ? `${format(new Date(m.startsAt), 'EEE d MMM, h:mm a')} · ${m.durationMinutes} min`
                    : `Opened ${format(new Date(m.createdAt), 'h:mm a')}`}
                  {m.createdBy?.name ? ` · ${m.createdBy.name}` : ''}
                </p>
              </div>
              <Button onClick={() => join(m.code)}>Join</Button>
              <Button variant="secondary" onClick={() => copy(m)} title={m.url}>
                {copied === m.code ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">{copied === m.code ? 'Copied' : 'Copy link'}</span>
              </Button>
              <Button variant="secondary" onClick={() => emailToSelf(m)} title="Send the link to your own inbox">
                <Mail className="h-4 w-4" />
              </Button>
              {(m.createdBy?.id === user?.id) && (
                <Button variant="secondary" onClick={() => cancel(m)} title="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
