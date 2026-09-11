import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client.js';

// CHK — store channel checks, placed from the terminal.
//
// The web half of the native CHK panel. Everything the desk needs is
// here: the queue of doors, the disclosure to read, the outcome of every
// dial including the ones that went nowhere, and the transcript.
//
// The one thing this cannot do is record the call. A browser can reach
// the microphone but not the other end of a phone call, so a recording
// made here would hold half a conversation while looking like it held
// both. The Mac app captures both sides; here you attach the file your
// handset made. Said out loud in the UI rather than left to be
// discovered.
//
// Two rules carry over from the server and are worth restating because
// the UI is where they are obeyed or quietly skipped:
//
//   Every dial is a row. The outcome buttons are the only way out of a
//   call, and a refusal is as much a result as an answer — a banner
//   whose staff will not discuss pricing has told you something, and a
//   console that only logged the conversations would lose it.
//
//   The recording rule decides what happens to the audio. One-party
//   keeps the tape, all-party destroys it once the transcript exists,
//   and a rule nobody set is treated as all-party.

const OUTCOMES = [
  ['Answered', 'Answered'],
  ['Refused', "Wouldn't talk"],
  ['NoAnswer', 'No answer'],
  ['Busy', 'Busy'],
  ['Voicemail', 'Voicemail'],
  ['CallBackLater', 'Call back'],
  ['WrongNumber', 'Wrong number'],
  ['Failed', "Didn't connect"],
];

export default function ChannelCheck({ ticker }) {
  const [project, setProject] = useState(null);
  const [queue, setQueue] = useState(null);
  const [rollup, setRollup] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const [picked, setPicked] = useState(null);
  const [call, setCall] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [regime, setRegime] = useState('all-party');
  const [consent, setConsent] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(null);
  const [flash, setFlash] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', phone: '', locationState: '', tier: '', owned: true });
  const fileRef = useRef(null);

  const me = useMemo(() => (project ? `/research/projects/${project.id}` : null), [project]);

  useEffect(() => {
    let alive = true;
    api
      .get('/research/projects', { params: ticker ? { ticker } : {} })
      .then(({ data }) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : data.projects || [];
        if (!list.length) {
          setErr(ticker ? `No research project for ${ticker}. Open one in FLD first.` : 'No research project open.');
          setLoading(false);
          return;
        }
        setProject(list[0]);
      })
      .catch((e) => { if (alive) { setErr(e.response?.data?.error || e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [ticker]);

  useEffect(() => { if (me) load(); }, [me]);

  useEffect(() => {
    if (!startedAt) return undefined;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  async function load() {
    setLoading(true);
    try {
      const [q, log] = await Promise.all([
        api.get(`${me}/call-queue`),
        api.get(`${me}/calls`),
      ]);
      setQueue(q.data);
      setRollup(log.data.rollup);
      // Re-resolve the open door against the rows we just fetched.
      // Without this the selection keeps the attempt list it was
      // rendered with, and "attach to the last call" after hanging up
      // would post the recording against the PREVIOUS dial — which the
      // server accepts, because that one has no interview yet either.
      setPicked((cur) => (cur ? (q.data.targets || []).find((t) => t.id === cur.id) || null : null));
      setErr(null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  async function addDoor() {
    setBusy('add');
    try {
      await api.post(`${me}/targets`, {
        name: draft.name,
        // Whose counter it is. Carried through to the source the call
        // becomes, which sets the MNPI floor on everything said on it.
        relationship: draft.owned ? 'CurrentEmployee' : 'Distributor',
        phone: draft.phone,
        locationState: draft.locationState || undefined,
        tier: draft.tier || undefined,
      });
      setDraft({ name: '', phone: '', locationState: '', tier: '', owned: true });
      await load();
    } catch (e) {
      setFlash(e.response?.data?.error || e.message);
    } finally {
      setBusy(null);
    }
  }

  async function dial(door) {
    setBusy('dial');
    setFlash(null);
    try {
      const { data } = await api.post(`${me}/calls`, { targetId: door.id });
      setCall(data);
      setStartedAt(Date.now());
      setElapsed(0);
      setConsent(false);
      setNotes('');
      // Hands off to whatever the machine uses for tel:. On a Mac with a
      // paired iPhone that rings the phone; elsewhere it may do nothing,
      // which is why the number is also printed to dial by hand.
      if (data.telUrl) window.location.href = data.telUrl;
    } catch (e) {
      setFlash(e.response?.data?.error || e.message);
    } finally {
      setBusy(null);
    }
  }

  async function close(outcome) {
    if (!call) return;
    setBusy('close');
    const body = {
      outcome,
      endedAt: new Date().toISOString(),
      durationMs: elapsed * 1000,
      // This clock started when somebody pressed DIAL, so it counts the
      // ringing. The native app reconciles against the phone's own
      // record; a browser cannot see it, and the log says which it got.
      metadataSource: 'apptimer',
      consentSpoken: consent,
      consentRegime: regime,
    };
    if (consent) body.consentNote = `Read aloud and agreed: ${disclosure}`;
    if (notes) body.notes = notes;
    try {
      await api.patch(`/research/calls/${call.id}`, body);
      const done = call;
      setCall(null);
      setStartedAt(null);
      setElapsed(0);
      // Kept on screen only if there is still a recording to attach.
      if (!(consent || regime === 'one-party')) setPicked(null);
      else setFlash(`Call ${done.id} logged. Attach the recording if you have one.`);
      await load();
    } catch (e) {
      setFlash(e.response?.data?.error || e.message);
    } finally {
      setBusy(null);
    }
  }

  async function upload(file, callId) {
    if (!file) return;
    setBusy('upload');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post(`/research/calls/${callId}/recording`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const sc = data.screen || {};
      const parts = [`Transcribed ${data.wordCount} words, ${data.speakerCount} speakers.`];
      if (data.quarantined) {
        parts.unshift(`QUARANTINED — ${sc.reason}. Its claims cannot be cited until a person releases it.`);
      } else if (sc.risk === 'elevated') {
        parts.unshift(`Flagged elevated — ${sc.reason}. Read it before extracting.`);
      }
      if (data.diarizationWarning) parts.push(data.diarizationWarning);
      parts.push(data.audioRetained ? 'Audio kept.' : 'Audio deleted.');
      setFlash(parts.join(' '));
      await load();
    } catch (e) {
      setFlash(e.response?.data?.error || e.message);
    } finally {
      setBusy(null);
    }
  }

  const disclosure =
    "Hi, this is a student analyst with the Griffin Fund at Grace Church School. "
    + "We're doing research on the jewelry business and I had a couple of quick questions "
    + 'about what\'s in your store. I\'m recording this so I get the details right. Is that OK?';

  if (loading && !queue) return <div className="term-panel"><div className="term-loading">Loading the call queue…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">{err}</div></div>;

  const doors = queue?.targets || [];

  return (
    <div className="term-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginBottom: 8 }}>
        <strong>CHK</strong>
        <span style={{ opacity: 0.7 }}>{project?.title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.8 }}>
          {rollup
            ? `${rollup.dials} dials · ${rollup.byOutcome?.Answered || 0} answered · ${rollup.byOutcome?.Refused || 0} refused · ${rollup.transcribed} transcribed`
            : ''}
        </span>
      </div>

      {flash && <div style={{ fontSize: 11, color: 'var(--term-amber)', marginBottom: 6 }}>{flash}</div>}

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ width: 300, overflowY: 'auto', borderRight: '1px solid var(--term-border, #333)', paddingRight: 8 }}>
          <button type="button" className="term-btn" onClick={() => setAdding((v) => !v)} style={{ fontSize: 10 }}>
            {adding ? '▾' : '▸'} ADD A DOOR
          </button>
          {adding && (
            <div style={{ display: 'grid', gap: 4, margin: '8px 0' }}>
              <input placeholder="Kay #1247 Easton, Columbus OH" value={draft.name}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input placeholder="(614) 555-0134" value={draft.phone}
                     onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              <div style={{ display: 'flex', gap: 4 }}>
                <input placeholder="OH" style={{ width: 60 }} value={draft.locationState}
                       onChange={(e) => setDraft({ ...draft, locationState: e.target.value.toUpperCase() })} />
                <input placeholder="Kay" value={draft.tier}
                       onChange={(e) => setDraft({ ...draft, tier: e.target.value })} />
              </div>
              <label style={{ fontSize: 10 }}>
                <input type="checkbox" checked={draft.owned}
                       onChange={(e) => setDraft({ ...draft, owned: e.target.checked })} />
                {' '}The company&apos;s own store
              </label>
              <button type="button" className="term-btn" disabled={!draft.name || !draft.phone || busy === 'add'}
                      onClick={addDoor}>ADD</button>
            </div>
          )}

          {queue?.undialable > 0 && (
            <div style={{ fontSize: 10, color: 'var(--term-amber)', margin: '6px 0' }}>
              {queue.undialable} number{queue.undialable === 1 ? '' : 's'} will not dial
            </div>
          )}

          {!doors.length && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>No door has a number yet. Add one above.</div>}

          {doors.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => !call && setPicked(d)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', background: picked?.id === d.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                border: 0, borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'inherit', padding: '6px 4px', cursor: call ? 'default' : 'pointer',
              }}
            >
              <div style={{ fontSize: 11, opacity: d.dialable ? 1 : 0.5 }}>
                {d.name} {d.everAnswered ? <span style={{ color: 'var(--term-positive, #6c6)' }}>DONE</span>
                  : d.attemptCount > 0 ? <span style={{ opacity: 0.6 }}>×{d.attemptCount}</span> : null}
              </div>
              <div style={{ fontSize: 10, opacity: 0.7 }}>
                {d.phoneDisplay} {d.locationState} {d.tier}
                {d.lastAttempt?.outcome ? ` · last: ${d.lastAttempt.outcome}` : ''}
              </div>
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!picked && <div style={{ fontSize: 11, opacity: 0.7 }}>Pick a door on the left.</div>}

          {picked && (
            <>
              <div style={{ fontSize: 14, marginBottom: 2 }}>{picked.name}</div>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
                {picked.phoneDisplay} {picked.employer} {picked.locationState}
              </div>

              {!call && (
                <>
                  {picked.everAnswered && (
                    <div style={{ fontSize: 10, color: 'var(--term-amber)', marginBottom: 6 }}>
                      Already reached. A second conversation arrives as a duplicate data point unless there is a reason for it.
                    </div>
                  )}
                  <button type="button" className="term-btn" disabled={!picked.dialable || busy === 'dial'}
                          onClick={() => dial(picked)}>DIAL</button>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                    The row is written before it rings, so a call that fails is still logged.
                  </div>
                </>
              )}

              {call && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div style={{ fontSize: 20, color: 'var(--term-positive, #6c6)' }}>
                    {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                    <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>on call</span>
                  </div>

                  <div>
                    <div style={{ fontSize: 10, opacity: 0.6 }}>RECORDING RULE</div>
                    <label style={{ fontSize: 11, display: 'block' }}>
                      <input type="radio" checked={regime === 'all-party'} onChange={() => setRegime('all-party')} />
                      {' '}All-party — ask first, tape deleted after
                    </label>
                    <label style={{ fontSize: 11, display: 'block' }}>
                      <input type="radio" checked={regime === 'one-party'} onChange={() => setRegime('one-party')} />
                      {' '}One-party — no need to ask, tape kept
                    </label>
                    {/* No state-to-rule table ships with this app. One
                        invented here would be worse than none, because it
                        would look authoritative. */}
                    <div style={{ fontSize: 10, color: 'var(--term-amber)' }}>
                      {picked.locationState
                        ? `This store is in ${picked.locationState}. You are picking the rule.`
                        : 'No state recorded for this store. You are picking the rule.'}
                    </div>
                  </div>

                  {regime === 'all-party' && (
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--term-amber)', marginBottom: 4 }}>READ THIS OUT, THEN TICK IT</div>
                      <div style={{ fontSize: 11, padding: 8, border: '1px solid var(--term-amber)' }}>{disclosure}</div>
                      <label style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                        {' '}They heard it and agreed to be recorded
                      </label>
                      <div style={{ fontSize: 10, opacity: 0.6 }}>
                        If they say no, carry on and take notes. The call is still worth having; it just is not recorded.
                      </div>
                    </div>
                  )}

                  <div style={{ fontSize: 10, opacity: 0.6 }}>
                    This tab cannot record the call: a browser reaches your microphone but not the other end of a
                    phone line. Record on your handset and attach the file, or place the call from the Mac app,
                    which captures both sides.
                  </div>

                  <textarea rows={6} value={notes} placeholder="Notes" onChange={(e) => setNotes(e.target.value)} />

                  <div>
                    <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 4 }}>HOW DID IT END</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {OUTCOMES.map(([code, label]) => (
                        <button key={code} type="button" className="term-btn" disabled={busy === 'close'}
                                onClick={() => close(code)}>{label}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {!call && picked.lastAttempt && !picked.lastAttempt.interviewId && (
                <div style={{ marginTop: 14 }}>
                  <input ref={fileRef} type="file" accept="audio/*" style={{ display: 'none' }}
                         onChange={(e) => upload(e.target.files?.[0], picked.lastAttempt.id)} />
                  <button type="button" className="term-btn" disabled={busy === 'upload'}
                          onClick={() => fileRef.current?.click()}>
                    {busy === 'upload' ? 'TRANSCRIBING…' : 'ATTACH RECORDING TO THE LAST CALL'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
