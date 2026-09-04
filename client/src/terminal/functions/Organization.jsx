import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';

// ORG — the club's org chart, inside the terminal. Same source of
// truth as the full page (pages/Organization.jsx): /users for the
// people, /industries for the pods, tier order fixed from the
// Presidents down. This stays a map rather than a dossier — clicking
// anyone opens their member profile on the website, where the pitch
// record and history actually live. The terminal has no profile
// panel and should not grow one.
//
// PM-and-above, matching the page: the chart is the whole membership
// with roles and structure at a glance, which is leadership
// information. Below PM the panel degrades to a sentence, not an
// error — there is nothing broken about an analyst opening ORG.

const TIERS = [
  { key: 'President', label: 'Presidents', roles: ['President'] },
  { key: 'DirectorOfResearch', label: 'Director of Research', roles: ['DirectorOfResearch'] },
  { key: 'CIO', label: 'Chief Investment Officers', roles: ['CIO'] },
  { key: 'Comms', label: 'Chief of Communication', roles: ['ChiefOfCommunication'] },
  { key: 'SPM', label: 'Senior Portfolio Managers', roles: ['SeniorPortfolioManager'] },
  { key: 'PM', label: 'Portfolio Managers', roles: ['PortfolioManager'] },
  { key: 'Analyst', label: 'Analysts', roles: ['SeniorAnalyst', 'Analyst'] },
  { key: 'JA', label: 'Junior Analysts', roles: ['JuniorAnalyst'] },
];

const ADVISORY_ROLES = ['AdvisoryBoardMember', 'FacultyAdvisory', 'FacultyAdvisor'];

const ROLE_SHORT = {
  President: 'President',
  DirectorOfResearch: 'Director of Research',
  CIO: 'CIO',
  ChiefOfCommunication: 'Comms',
  SeniorPortfolioManager: 'Senior PM',
  PortfolioManager: 'PM',
  SeniorAnalyst: 'Senior Analyst',
  Analyst: 'Analyst',
  JuniorAnalyst: 'Junior Analyst',
  AdvisoryBoardMember: 'Advisory Board',
  FacultyAdvisory: 'Faculty Advisor',
  FacultyAdvisor: 'Faculty Advisor',
};

// Profiles open on the public site in a browser tab. Absolute on
// purpose: the terminal may one day be embedded somewhere that isn't
// thegriffinfund.org, and the profile page always lives there.
function openProfile(id) {
  window.open(
    `https://thegriffinfund.org/members/${id}`,
    '_blank',
    'noopener,noreferrer'
  );
}

// Inline styles for the org-specific layout. The reusable chrome
// (term-panel, term-gp-btn, term-action, term-help-grid) comes from
// theme.css; only what has no existing class lives here.
const S = {
  tierLabel: {
    color: 'var(--term-blue)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    borderBottom: '1px solid var(--term-border)',
    paddingBottom: 3,
    marginBottom: 6,
  },
  tierCount: { color: 'var(--term-fg-muted)', fontWeight: 400 },
  people: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  name: {
    color: 'var(--term-white)',
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: '0.02em',
  },
  role: {
    color: 'var(--term-fg-dim)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 1 },
  leadChip: {
    color: 'var(--term-amber)',
    border: '1px solid var(--term-fg-muted)',
    fontSize: 9,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '0 4px',
  },
  extraChip: {
    color: 'var(--term-fg-muted)',
    border: '1px solid var(--term-border)',
    fontSize: 9,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '0 4px',
  },
  memberRole: { color: 'var(--term-fg-muted)', fontSize: 10, marginLeft: 6 },
  star: { color: 'var(--term-orange)', marginRight: 4 },
  footer: { color: 'var(--term-fg-muted)', fontSize: 11 },
};

// A full card: name, role, extra-role gates, and — the org-chart fact
// that matters for PMs — the industries this person LEADS. Membership
// stays down on the pods.
function PersonCard({ person, leads, muted }) {
  const extras = person.extraRoles || [];
  return (
    <button
      type="button"
      className="term-gp-btn"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        padding: '4px 10px',
        opacity: muted ? 0.8 : 1,
      }}
      onClick={() => openProfile(person.id)}
      title={`Open ${person.name}'s profile at thegriffinfund.org`}
    >
      <span style={S.name}>{person.name}</span>
      <span style={S.role}>{ROLE_SHORT[person.role] || person.role}</span>
      {(leads || []).length > 0 || extras.length > 0 ? (
        <span style={S.chipRow}>
          {(leads || []).map((n) => (
            <span key={`lead-${n}`} style={S.leadChip} title={`Leads ${n}`}>
              {n}
            </span>
          ))}
          {extras.map((r) => (
            <span key={`extra-${r}`} style={S.extraChip}>
              {ROLE_SHORT[r] || r}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

// Junior analysts are the wide base of the pyramid — a full card each
// would push the actual structure off screen. A one-line chip keeps
// them present and clickable without drowning the chart.
function PersonChip({ person }) {
  return (
    <button
      type="button"
      className="term-gp-btn"
      onClick={() => openProfile(person.id)}
      title={`Open ${person.name}'s profile at thegriffinfund.org`}
    >
      {person.name}
    </button>
  );
}

export default function Organization() {
  // Receives { ticker, fn, onOpen } like every panel; none apply —
  // ORG takes no ticker and drills out to the browser, not to
  // another pane — so nothing is destructured.
  const { loading: authLoading, isPmOrAbove, isSuperAdmin } = useAuth();
  // isPmOrAbove covers President / CIO / Senior PM / PM. The super
  // admin is an email-match tier, not a role, so it needs its own OR
  // here or Thomas's account would depend on whatever role his row
  // happens to carry.
  const allowed = !!(isPmOrAbove || isSuperAdmin);

  const [users, setUsers] = useState(null);
  const [industries, setIndustries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!allowed) return undefined;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // /industries is best-effort, mirroring the page: the chart is
    // still a chart without pods, and a pods hiccup should not blank
    // the whole membership.
    Promise.all([
      api.get('/users'),
      api.get('/industries').catch(() => ({ data: [] })),
    ])
      .then(([u, i]) => {
        if (cancelled) return;
        setUsers(Array.isArray(u.data) ? u.data : []);
        setIndustries(Array.isArray(i.data) ? i.data : []);
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
  }, [allowed]);

  // Industries each person LEADS — leadership is the org-chart fact;
  // membership stays on the pods below.
  const ledBy = useMemo(() => {
    const m = {};
    for (const ind of industries) {
      if (ind.leader?.id) (m[ind.leader.id] ||= []).push(ind.name);
    }
    return m;
  }, [industries]);

  const tiers = useMemo(() => {
    if (!users) return [];
    return TIERS.map((t) => ({
      ...t,
      people: users.filter((u) => t.roles.includes(u.role)),
    })).filter((t) => t.people.length > 0);
  }, [users]);

  const advisory = useMemo(
    () => (users || []).filter((u) => ADVISORY_ROLES.includes(u.role)),
    [users]
  );

  if (authLoading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Checking access…</div>
      </div>
    );
  }
  // The gate, degraded not broken: same posture as PEER's
  // "Enter a ticker" resting state.
  if (!allowed) {
    return (
      <div className="term-panel">
        <div className="term-loading">ORG is PM and above.</div>
      </div>
    );
  }
  if (loading || (!users && !err)) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading the roster…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (users.length === 0) {
    return (
      <div className="term-panel">
        <div className="term-panel-header">
          <span className="ticker">ORG</span>
          <span className="name">The Griffin Fund · organization</span>
        </div>
        <div className="term-loading">
          The member directory came back empty — nothing to chart.
        </div>
      </div>
    );
  }

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">ORG</span>
        <span className="name">
          The Griffin Fund · organization · {users.length} members
        </span>
      </div>

      {/* The chart: tiers descend in fixed order, each a labelled
          band of clickable people. Empty tiers are already filtered
          out so the structure never shows a hole. */}
      {tiers.map((tier) => (
        <div key={tier.key}>
          <div style={S.tierLabel}>
            {tier.label}
            <span style={S.tierCount}> · {tier.people.length}</span>
          </div>
          <div style={S.people}>
            {tier.people.map((p) =>
              tier.key === 'JA' ? (
                <PersonChip key={p.id} person={p} />
              ) : (
                <PersonCard key={p.id} person={p} leads={ledBy[p.id]} />
              )
            )}
          </div>
        </div>
      ))}

      {/* Advisory sits after the chart rather than inside it — they
          advise the structure, they are not a rung of it. */}
      {advisory.length > 0 && (
        <div>
          <div style={S.tierLabel}>
            Advisory Board &amp; Faculty
            <span style={S.tierCount}> · {advisory.length}</span>
          </div>
          <div style={S.people}>
            {advisory.map((p) => (
              <PersonCard key={p.id} person={p} muted />
            ))}
          </div>
        </div>
      )}

      {/* Industry pods: who runs what, who sits where. Leader pinned
          first and starred, the rest alphabetical, same sort as the
          full page. */}
      {industries.length > 0 && (
        <div>
          <div style={S.tierLabel}>
            Industry Groups
            <span style={S.tierCount}> · {industries.length}</span>
          </div>
          <div className="term-help-grid">
            {industries.map((ind) => (
              <div key={ind.id} className="term-help-cell">
                <div className="mnemonic">{ind.name}</div>
                <div
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    alignItems: 'flex-start',
                  }}
                >
                  {[...(ind.members || [])]
                    .sort((a, b) =>
                      a.id === ind.leader?.id
                        ? -1
                        : b.id === ind.leader?.id
                          ? 1
                          : a.name.localeCompare(b.name)
                    )
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="term-action"
                        onClick={() => openProfile(m.id)}
                        title={`Open ${m.name}'s profile at thegriffinfund.org`}
                      >
                        {m.id === ind.leader?.id && (
                          <span style={S.star} title="Industry leader">
                            ★
                          </span>
                        )}
                        {m.name}
                        <span style={S.memberRole}>
                          {ROLE_SHORT[m.role] || m.role}
                        </span>
                      </button>
                    ))}
                  {(ind.members || []).length === 0 && (
                    <span style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
                      No members assigned.
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={S.footer}>
        Member directory · PM and above · ★ marks the industry leader ·
        click any name to open their profile at thegriffinfund.org in
        the browser.
      </div>
    </div>
  );
}
