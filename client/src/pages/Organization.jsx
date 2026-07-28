import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// The org chart: how the fund is actually built, from the Presidents
// down, with every person one click from their profile — the pitch
// record, the hit rate, the history all live there, so this page stays
// a map rather than trying to be a dossier.
//
// PM-and-above on purpose. The chart shows the whole membership with
// roles and reporting structure at a glance, which is leadership
// information; the people running books get it, the default-role
// signups do not.

const TIERS = [
  { key: 'President', label: 'Presidents', roles: ['President'] },
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

export default function Organization() {
  const { isPmOrAbove, loading: authLoading } = useAuth();
  const [users, setUsers] = useState(null);
  const [industries, setIndustries] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [u, i] = await Promise.all([
          api.get('/users'),
          api.get('/industries').catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setUsers(u.data);
        setIndustries(i.data || []);
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || 'Could not load the member list.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Industries each person LEADS — leadership is the org-chart fact;
  // membership stays on the industry pods below.
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

  if (!authLoading && !isPmOrAbove) return <Navigate to="/dashboard" replace />;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="border-b border-navy-100 pb-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gold-700">
          The Griffin Fund
        </p>
        <h1 className="mt-2 font-serif text-3xl font-semibold leading-tight text-navy md:text-4xl">
          Organization
        </h1>
        <p className="mt-1 text-sm text-navy-400">
          How the fund is built, top to bottom. Click anyone to open their
          profile — pitches, outcomes, and coverage live there.
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : !users ? (
        <p className="text-sm text-navy-400">Loading the roster…</p>
      ) : (
        <>
          {/* The chart. Tiers descend with a center spine so the page
              reads as one structure, not seven lists. */}
          <div className="flex flex-col items-center">
            {tiers.map((tier, i) => (
              <div key={tier.key} className="flex w-full flex-col items-center">
                {i > 0 && <div className="h-7 w-px bg-navy-200" aria-hidden />}
                <div className="mb-3 mt-1 flex items-center gap-3">
                  <span className="h-px w-8 bg-navy-100" aria-hidden />
                  <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-navy-300">
                    {tier.label}
                  </span>
                  <span className="h-px w-8 bg-navy-100" aria-hidden />
                </div>
                <div className="flex flex-wrap justify-center gap-3">
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
          </div>

          {/* Advisory sits beside the chart rather than inside it —
              they advise the structure, they are not a rung of it. */}
          {advisory.length > 0 && (
            <section>
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-navy-300">
                Advisory Board &amp; Faculty
              </h2>
              <div className="flex flex-wrap gap-3">
                {advisory.map((p) => (
                  <PersonCard key={p.id} person={p} muted />
                ))}
              </div>
            </section>
          )}

          {/* Industry pods: who runs what, who sits where. */}
          {industries.length > 0 && (
            <section>
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-navy-300">
                Industry Groups
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {industries.map((ind) => (
                  <div
                    key={ind.id}
                    className="rounded-2xl border border-navy-100 bg-white p-4 shadow-card"
                  >
                    <p className="font-serif text-base font-semibold text-navy">
                      {ind.name}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {[...(ind.members || [])]
                        .sort((a, b) =>
                          a.id === ind.leader?.id ? -1 : b.id === ind.leader?.id ? 1 : a.name.localeCompare(b.name)
                        )
                        .map((m) => (
                          <li key={m.id}>
                            <Link
                              to={`/members/${m.id}`}
                              className="group inline-flex items-center gap-1.5 text-sm text-navy-600 hover:text-gold-700"
                            >
                              {m.id === ind.leader?.id && (
                                <span className="text-gold-700" title="Industry leader">★</span>
                              )}
                              <span className="group-hover:underline">{m.name}</span>
                              <span className="text-[10px] text-navy-300">
                                {ROLE_SHORT[m.role] || m.role}
                              </span>
                            </Link>
                          </li>
                        ))}
                      {(ind.members || []).length === 0 && (
                        <li className="text-xs text-navy-300">No members assigned.</li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function PersonCard({ person, leads, muted }) {
  return (
    <Link
      to={`/members/${person.id}`}
      className={`block w-44 rounded-2xl border bg-white p-3 text-center shadow-card transition hover:-translate-y-0.5 hover:border-gold hover:shadow-lg ${
        muted ? 'border-navy-100 opacity-80' : 'border-navy-100'
      }`}
    >
      <p className="truncate font-serif text-sm font-semibold text-navy">
        {person.name}
      </p>
      <p className="mt-0.5 text-[11px] text-navy-400">
        {ROLE_SHORT[person.role] || person.role}
      </p>
      {(person.extraRoles || []).length > 0 && (
        <p className="mt-1 flex flex-wrap justify-center gap-1">
          {person.extraRoles.map((r) => (
            <span
              key={r}
              className="rounded bg-navy-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-navy-400"
            >
              {ROLE_SHORT[r] || r}
            </span>
          ))}
        </p>
      )}
      {(leads || []).length > 0 && (
        <p className="mt-1.5 flex flex-wrap justify-center gap-1">
          {leads.map((n) => (
            <span
              key={n}
              className="rounded-md bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-gold-700"
              title={`Leads ${n}`}
            >
              {n}
            </span>
          ))}
        </p>
      )}
    </Link>
  );
}

// Junior analysts are the wide base of the pyramid — a full card each
// would push the actual structure off-screen. A chip keeps them present
// and clickable without drowning the chart.
function PersonChip({ person }) {
  return (
    <Link
      to={`/members/${person.id}`}
      className="rounded-full border border-navy-100 bg-white px-3 py-1 text-xs text-navy-600 shadow-sm transition hover:border-gold hover:text-gold-700"
    >
      {person.name}
    </Link>
  );
}