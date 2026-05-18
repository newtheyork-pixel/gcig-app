import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';
import PersonModal from '../components/PersonModal.jsx';

// MGMT — leadership / board / comp / network from the latest DEF 14A.
// Every section is best-effort; missing fields render as "—".

const TABS = ['Leadership', 'Board', 'Comp', 'Network'];
const dash = (v) => (v == null || v === '' ? '—' : v);

// SCT names ("Andrew R. Jassy") and 10-K exec-officer names
// ("Andrew Jassy") rarely agree on punctuation or spacing, so the
// bio lookup keys on a flattened form: trim, collapse interior
// whitespace, drop case. Imperfect across middle-name drift but it
// recovers the common "extra spaces / period" mismatches without a
// fuzzy match that could cross two different officers.
const normName = (s) =>
  String(s == null ? '' : s)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

// Bespoke-card big-caps (AMZN, KO) parse a full Comp table but an
// empty Leadership tab, so always opening on Leadership made the
// panel look broken. Land on the first tab that has something;
// fall back to Leadership so the empty-state copy is unchanged
// when nothing parsed at all.
const preferredTab = (d) => {
  if (!d) return 'Leadership';
  if (d.ceo || d.execs?.length) return 'Leadership';
  if (d.board?.length) return 'Board';
  if (d.comp?.rows?.length) return 'Comp';
  if (d.network?.edges?.length) return 'Network';
  return 'Leadership';
};

export default function Governance({ ticker }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('Leadership');
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  // The person whose profile is open, or null. Directors carry their
  // bio inline (parsed straight from the DEF 14A); execs get one
  // stitched in from the lazily-fetched 10-K map below.
  const [selected, setSelected] = useState(null);

  // 10-K exec bios, fetched at most once per ticker and only when
  // someone actually opens a Leadership profile — the filing is tens
  // of MB and most panel views never touch this tab. `byName` is
  // keyed by normName(officer.name).
  const [execBios, setExecBios] = useState({ status: 'idle', byName: {} });

  // The ticker a still-in-flight exec-bios fetch was started for. A
  // ticker switch can resolve an old request after we've already
  // cleared state for the new symbol; comparing against this ref on
  // resolve lets us drop the stale payload (the event-triggered
  // analogue of the load effect's `cancelled` flag).
  const execBiosTicker = useRef(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setTab('Leadership');
    setLoading(true);
    setErr(null);
    setData(null);
    setBrief('');
    // A new symbol must not show the prior company's profile, nor
    // reuse its 10-K bio map — wipe both and let the next click
    // re-fetch for this ticker.
    setSelected(null);
    setExecBios({ status: 'idle', byName: {} });
    execBiosTicker.current = null;
    api
      .get(`/terminal/governance/${encodeURIComponent(ticker)}`)
      .then(({ data: d }) => {
        if (cancelled) return;
        setData(d);
        setTab(preferredTab(d));
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!ticker || !data) return;
    let cancelled = false;
    const hasData =
      !!data.ceo ||
      (data.execs || []).length > 0 ||
      (data.board || []).length > 0 ||
      (data.comp?.rows || []).length > 0 ||
      (data.network?.edges || []).length > 0;
    // Never ask the model to summarize empty governance data — with no
    // facts it confabulates ("the board stands without any directors").
    // State the truth plainly instead; no LLM call.
    if (!hasData) {
      setBriefLoading(false);
      setBrief(
        data.source == null
          ? 'No DEF 14A retrieved for this ticker.'
          : 'DEF 14A retrieved, but its structure could not be parsed (common for large multi-section proxies). Nothing to summarize.'
      );
      return;
    }
    setBriefLoading(true);
    // Lead with whatever we actually parsed, not what we wish we had.
    // The big-cap proxies (AMZN, KO) give us a clean Summary Comp
    // table — six officers with real dollar totals — but no
    // salary/stock/option split, so every pay percentage is null.
    // The old builder sent only those percentages plus a literal
    // "Board: 0 directors"; the model read an all-dashes context as
    // missing data and the grounding rule fired "Data unavailable."
    // Send the names and totals we have; fold in the pay mix only
    // when it exists, and never emit a zero-count line that reads
    // as absence.
    const ceoLine = data.ceo
      ? `CEO: ${data.ceo.name} (${dash(data.ceo.title)})` +
        (data.ceo.since ? `, since ${data.ceo.since}` : '') +
        (data.ceo.age ? `, age ${data.ceo.age}` : '')
      : null;
    const execLine = data.execs?.length
      ? `Executives: ${data.execs.map((e) => `${e.name} (${dash(e.title)})`).join('; ')}`
      : null;
    const boardLine = data.board?.length
      ? `Board: ${data.board
          .map(
            (d) =>
              d.name +
              (d.since ? ` since ${d.since}` : '') +
              (d.otherBoards?.length ? ` [also: ${d.otherBoards.join(', ')}]` : '')
          )
          .join('; ')}`
      : null;
    const compLine = data.comp?.rows?.length
      ? `Named-officer compensation (latest DEF 14A): ${data.comp.rows
          .map((r) => {
            const mix = [
              r.salaryPct == null ? null : `${r.salaryPct}% salary`,
              r.stockPct == null ? null : `${r.stockPct}% stock`,
              r.optionPct == null ? null : `${r.optionPct}% options`,
              r.otherPct == null ? null : `${r.otherPct}% other`,
            ].filter(Boolean);
            return (
              `${r.name} — ${dash(r.title)}` +
              (r.total == null ? '' : `, total $${Number(r.total).toLocaleString()}`) +
              (mix.length ? ` (${mix.join(', ')})` : '')
            );
          })
          .join('; ')}`
      : null;
    const networkLine = data.network?.edges?.length
      ? `Shared boards with holdings: ${data.network.edges.map((e) => `${e.person} ${e.a}-${e.b}`).join(', ')}`
      : null;
    const ctx = [ceoLine, execLine, boardLine, compLine, networkLine]
      .filter(Boolean)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'MGMT', context: ctx })
      .then(({ data: r }) => { if (!cancelled) setBrief(r.brief || ''); })
      .catch(() => { if (!cancelled) setBrief(''); })
      .finally(() => { if (!cancelled) setBriefLoading(false); });
    return () => { cancelled = true; };
  }, [data, ticker]);

  // Fetch the 10-K exec bios for this ticker exactly once, the first
  // time a Leadership profile is opened. Resolves into a name→bio
  // map; an empty list or any error is a legitimate outcome (lots of
  // filers incorporate Part III by reference and carry no exec-
  // officer section) and just means the modal shows its honest
  // "no bio disclosed" state. Never throws into the panel.
  function ensureExecBios() {
    if (!ticker) return;
    if (execBios.status === 'loading' || execBios.status === 'done') return;
    const startedFor = ticker;
    execBiosTicker.current = startedFor;
    setExecBios({ status: 'loading', byName: {} });
    api
      .get(`/terminal/governance/${encodeURIComponent(ticker)}/exec-bios`)
      .then(({ data: r }) => {
        // Dropped if the user has since switched tickers — the new
        // symbol already reset state and may have its own fetch.
        if (execBiosTicker.current !== startedFor) return;
        const byName = {};
        for (const o of r?.officers || []) {
          if (o && o.name) byName[normName(o.name)] = o.bio || '';
        }
        setExecBios({ status: 'done', byName });
      })
      .catch(() => {
        if (execBiosTicker.current !== startedFor) return;
        // A miss is not an error the reader should see — treat it as
        // "no bios" so the comp facts still render honestly.
        setExecBios({ status: 'done', byName: {} });
      });
  }

  // Open a director profile: bio is already in the payload, so no
  // fetch and never a loading state.
  function openDirector(d) {
    setSelected({
      name: d.name,
      title: d.title || undefined,
      age: d.age,
      since: d.since,
      bio: d.bio || null,
      kind: 'director',
    });
  }

  // Open an executive / CEO profile: pass through whatever comp/
  // tenure fields the row carries so the modal fact line is rich,
  // and kick the lazy 10-K fetch if it hasn't run for this ticker.
  function openExec(e) {
    setSelected({
      name: e.name,
      title: e.title || undefined,
      age: e.age,
      since: e.since,
      total: e.total,
      salaryPct: e.salaryPct,
      stockPct: e.stockPct,
      optionPct: e.optionPct,
      otherPct: e.otherPct,
      kind: 'exec',
    });
    ensureExecBios();
  }

  // Enter/Space activate a clickable row, matching the app's existing
  // role="button" rows (see AiChat). Space is preventDefault'd so the
  // panel doesn't scroll out from under the opening modal.
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  // Bio + loading the modal should show for the current selection.
  // Directors carry their own bio and never load. Execs read the
  // lazily-fetched map: still fetching → loading; resolved → the
  // matched bio or null (modal then shows the honest empty state
  // plus the structured comp facts).
  let modalBio = null;
  let modalLoading = false;
  if (selected) {
    if (selected.kind === 'director') {
      modalBio = selected.bio || null;
    } else {
      if (execBios.status === 'loading' || execBios.status === 'idle') {
        modalLoading = true;
      } else {
        modalBio = execBios.byName[normName(selected.name)] || null;
      }
    }
  }

  if (!ticker) return <div className="term-panel"><div className="term-loading">Enter a ticker to load governance.</div></div>;
  if (loading) return <div className="term-panel"><div className="term-loading">Loading DEF 14A…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!data) return null;

  const noProxy = data.source == null;

  return (
    // position:relative so PersonModal's absolutely-positioned
    // backdrop covers exactly this panel and nothing else — it can't
    // portal out without leaving the [data-theme='terminal'] scope
    // its var(--term-*) reads depend on.
    <div className="term-panel" style={{ height: '100%', position: 'relative' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Management &amp; Board</span>
        {data.asOf && <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>DEF 14A {data.asOf}</span>}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {noProxy ? (
        <div className="term-loading">No recent DEF 14A on file for {ticker.toUpperCase()}.</div>
      ) : (
        <>
          <div className="term-tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={`term-tab${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Leadership' && (
            <div>
              {data.ceo && (
                <div
                  className="term-row-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => openExec(data.ceo)}
                  onKeyDown={rowKey(() => openExec(data.ceo))}
                  title={`Open ${data.ceo.name}`}
                  style={{ marginBottom: 8 }}
                >
                  <div className="sym" style={{ fontSize: 13 }}>{data.ceo.name} · {dash(data.ceo.title)}</div>
                  <div style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
                    age {dash(data.ceo.age)} · since {dash(data.ceo.since)}
                    {data.ceo.priorRoles?.length ? ` · prior: ${data.ceo.priorRoles.join('; ')}` : ''}
                  </div>
                </div>
              )}
              <table className="term-table">
                <thead><tr><th>Executive</th><th>Title</th><th className="num">Age</th><th className="num">Since</th></tr></thead>
                <tbody>
                  {(data.execs || []).map((e, i) => (
                    <tr
                      key={i}
                      className="term-row-link"
                      role="button"
                      tabIndex={0}
                      onClick={() => openExec(e)}
                      onKeyDown={rowKey(() => openExec(e))}
                      title={`Open ${e.name}`}
                    >
                      <td className="sym">{e.name}</td><td>{dash(e.title)}</td><td className="num">{dash(e.age)}</td><td className="num">{dash(e.since)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data.execs || []).length === 0 && <div className="term-loading">No executive bios parsed.</div>}
            </div>
          )}

          {tab === 'Board' && (
            <div>
              <table className="term-table">
                <thead><tr><th>Director</th><th className="num">Age</th><th className="num">Since</th><th>Committees</th><th>Other public boards</th></tr></thead>
                <tbody>
                  {(data.board || []).map((d, i) => (
                    <tr
                      key={i}
                      className="term-row-link"
                      role="button"
                      tabIndex={0}
                      onClick={() => openDirector(d)}
                      onKeyDown={rowKey(() => openDirector(d))}
                      title={`Open ${d.name}`}
                    >
                      <td className="sym">{d.name}</td>
                      <td className="num">{dash(d.age)}</td>
                      <td className="num">{dash(d.since)}</td>
                      <td>{d.committees?.length ? d.committees.join(', ') : '—'}</td>
                      <td>{d.otherBoards?.length ? d.otherBoards.join(', ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data.board || []).length === 0 && <div className="term-loading">No board data parsed.</div>}
            </div>
          )}

          {tab === 'Comp' && (
            <div>
              <table className="term-table">
                <thead><tr><th>Name</th><th className="num">Salary%</th><th className="num">Stock%</th><th className="num">Option%</th><th className="num">Other%</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {(data.comp?.rows || []).map((r, i) => (
                    <tr key={i}>
                      <td className="sym">{r.name}</td>
                      <td className="num">{dash(r.salaryPct)}</td>
                      <td className="num">{dash(r.stockPct)}</td>
                      <td className="num">{dash(r.optionPct)}</td>
                      <td className="num">{dash(r.otherPct)}</td>
                      <td className="num">{r.total == null ? '—' : `$${Number(r.total).toLocaleString()}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data.comp?.rows || []).length === 0 && <div className="term-loading">No compensation data parsed.</div>}
            </div>
          )}

          {tab === 'Network' && (
            (data.network?.edges || []).length === 0 ? (
              <div className="term-loading">No shared boards among current fund holdings.</div>
            ) : (
              <table className="term-table">
                <thead><tr><th>Director</th><th>Focus</th><th>Also on (held)</th></tr></thead>
                <tbody>
                  {data.network.edges.map((e, i) => (
                    <tr key={i}><td className="sym">{e.person}</td><td>{e.a}</td><td className="num">{e.b}</td></tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Directors and compensation are parsed from the latest DEF 14A,
        including the bespoke bio-card proxies many large-caps file.
        Executive bios load from the latest 10-K when the filer
        discloses them. Click any name for the full profile. Coverage
        varies with each company&apos;s filing format.
      </div>

      <PersonModal
        person={selected}
        bio={modalBio}
        loading={modalLoading}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
