import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  TrendingUp,
  Users,
  LineChart,
  BookOpen,
  ShieldCheck,
  Building2,
  Vote,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

// Public landing page for non-members. Authed users are redirected into the
// app. Everything here is static — no API calls — so search engines can
// crawl it and non-members don't need to be issued a token.

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-white text-navy">
      <LandingHeader />
      <Hero />
      <Pillars />
      <WhatWeDo />
      <HowItWorks />
      <Oversight />
      <JoinCta />
      <LandingFooter />
    </div>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-navy-100/70 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-navy text-gold font-bold text-sm">
            G
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-navy">
              Grace Church Investment Group
            </div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-gold font-semibold">
              Est. Grace Church School
            </div>
          </div>
        </Link>
        <Link
          to="/login"
          className="inline-flex items-center gap-2 rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-700"
        >
          Member sign in
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-navy text-white">
      {/* Decorative grid + gradient */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #C9A84C 1px, transparent 1px), linear-gradient(to bottom, #C9A84C 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      <div
        aria-hidden
        className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-gold/20 blur-3xl"
      />
      <div
        aria-hidden
        className="absolute -left-32 bottom-0 h-80 w-80 rounded-full bg-gold/10 blur-3xl"
      />

      <div className="relative mx-auto max-w-6xl px-6 pb-28 pt-24 md:pt-36">
        <div className="inline-flex items-center gap-2 rounded-full border border-gold/40 bg-navy-700/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          A student-led investment club
        </div>
        <h1 className="mt-6 max-w-3xl text-5xl font-bold leading-[1.05] tracking-tight md:text-7xl">
          Real capital.
          <br />
          Real research.
          <br />
          <span className="text-gold">Real markets.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100 md:text-xl">
          The Grace Church Investment Group is a student-run equity fund. Members
          research companies, pitch ideas, vote on positions, and manage the
          club's portfolio — with faculty oversight and guidance from an
          advisory board of industry professionals.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            to="/login"
            className="inline-flex items-center gap-2 rounded-lg bg-gold px-6 py-3 text-sm font-semibold text-navy shadow-md transition hover:bg-gold-300"
          >
            Member portal
            <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href="#what-we-do"
            className="inline-flex items-center gap-2 rounded-lg border border-white/30 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            Learn more
            <ChevronDown className="h-4 w-4" />
          </a>
        </div>

        {/* Marquee-style metrics strip */}
        <div className="mt-16 grid grid-cols-2 gap-6 border-t border-white/10 pt-8 md:grid-cols-4">
          <Stat label="Student analysts" value="30+" />
          <Stat label="Industry pods" value="6" />
          <Stat label="Weekly pitches" value="Every Tues" />
          <Stat label="Faculty oversight" value="Always on" />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-2xl font-bold text-white md:text-3xl">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[0.2em] text-gold">
        {label}
      </div>
    </div>
  );
}

function Pillars() {
  const pillars = [
    {
      icon: TrendingUp,
      title: 'Research',
      body:
        'Every position starts with a written thesis. Members produce full pitch decks and research reports with valuation, risks, and catalysts.',
    },
    {
      icon: Vote,
      title: 'Conviction',
      body:
        'Ideas go to a club vote — buy, hold, sell — with weighted input from leadership and consensus from the general body. No position is added without debate.',
    },
    {
      icon: ShieldCheck,
      title: 'Stewardship',
      body:
        'Every trade is logged, every pitch is tracked, and outcomes are measured. We treat the portfolio like the real capital it is.',
    },
  ];
  return (
    <section className="border-b border-navy-100 bg-navy-50/40 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-8 md:grid-cols-3">
          {pillars.map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.title}
                className="rounded-xl border border-navy-100 bg-white p-6 shadow-sm transition hover:shadow-md"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-gold">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-lg font-bold text-navy">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-navy-400">{p.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WhatWeDo() {
  const features = [
    {
      icon: LineChart,
      title: 'Live portfolio',
      body:
        'Members track positions, sector allocation, and performance in real time. Portfolio managers have access to risk metrics — beta, volatility, drawdown, concentration.',
    },
    {
      icon: BookOpen,
      title: 'Research library',
      body:
        'Decks and reports from every pitch and position are archived and searchable. New members have instant access to the reasoning behind the book.',
    },
    {
      icon: Building2,
      title: 'Industry pods',
      body:
        'Members join one of six sector pods — tech, financials, healthcare, energy, consumer, industrials — and go deep in their area of focus.',
    },
    {
      icon: Users,
      title: 'Weekly meetings',
      body:
        'The whole group meets weekly for pitches and market discussion. Pods meet independently to workshop ideas before they go to the floor.',
    },
    {
      icon: Vote,
      title: 'Structured voting',
      body:
        'Every buy, hold, and sell decision goes through a formal vote. Leadership reviews rationale before any trade is executed.',
    },
    {
      icon: TrendingUp,
      title: 'Outcome tracking',
      body:
        'We score every idea — hit rate, returns, Sharpe — per analyst and per pod, so members see how their calls are performing.',
    },
  ];
  return (
    <section id="what-we-do" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-12 max-w-2xl">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-gold">
            Inside the club
          </div>
          <h2 className="mt-3 text-3xl font-bold leading-tight text-navy md:text-4xl">
            A full investment process, run by students.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-navy-400">
            We operate like a scaled-down buy-side shop. Every member has a role
            in the workflow — from idea generation to post-trade review.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group rounded-xl border border-navy-100 p-6 transition hover:border-gold hover:bg-gold-100/20"
              >
                <Icon className="h-6 w-6 text-navy transition group-hover:text-gold-700" />
                <h3 className="mt-4 font-bold text-navy">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-navy-400">{f.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Pitch',
      body: 'An analyst presents a company — thesis, model, risks — to the full club.',
    },
    {
      n: '02',
      title: 'Debate',
      body: 'Members challenge the thesis. Portfolio managers weigh fit against the existing book.',
    },
    {
      n: '03',
      title: 'Vote',
      body: 'The club formally votes buy, hold, or sell — with leadership weighted and general-body consensus.',
    },
    {
      n: '04',
      title: 'Review',
      body: "We track the position's return over time, scored against the pitch's original thesis.",
    },
  ];
  return (
    <section className="bg-navy py-24 text-white">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-12 max-w-2xl">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-gold">
            How it works
          </div>
          <h2 className="mt-3 text-3xl font-bold leading-tight md:text-4xl">
            From idea to position in four steps.
          </h2>
        </div>
        <div className="grid gap-6 md:grid-cols-4">
          {steps.map((s, i) => (
            <div
              key={s.n}
              className="relative rounded-xl border border-white/10 bg-navy-700/30 p-6"
            >
              <div className="text-xs font-bold tracking-widest text-gold">
                {s.n}
              </div>
              <h3 className="mt-3 text-xl font-bold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-navy-100">{s.body}</p>
              {i < steps.length - 1 && (
                <ArrowRight
                  aria-hidden
                  className="absolute -right-3 top-1/2 hidden h-5 w-5 -translate-y-1/2 text-gold md:block"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Oversight() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-12 md:grid-cols-2 md:items-center">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-gold">
              Oversight
            </div>
            <h2 className="mt-3 text-3xl font-bold leading-tight text-navy md:text-4xl">
              Independent enough to learn. Supervised enough to stay safe.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-navy-400">
              Trading decisions belong to the students — but the club operates
              inside a framework. Faculty advisors review the book. An advisory
              board of alumni and industry professionals attends meetings,
              challenges theses, and mentors members one-on-one. Executive
              leadership — elected from the senior class — runs the day-to-day.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-navy">
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                Faculty oversight on every trade
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                Advisory board of industry professionals
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                Full audit trail for every decision
              </li>
            </ul>
          </div>
          <div className="relative">
            <div className="rounded-2xl border border-navy-100 bg-gradient-to-br from-navy-50 to-white p-8 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-gold">
                Leadership structure
              </div>
              <div className="mt-4 space-y-3">
                {[
                  { role: 'President', desc: 'Runs the club, chairs meetings' },
                  { role: 'Chief Investment Officer', desc: 'Oversees portfolio strategy' },
                  { role: 'Senior Portfolio Managers', desc: 'Lead sector pods' },
                  { role: 'Portfolio Managers', desc: 'Execute and monitor positions' },
                  { role: 'Senior Analysts', desc: 'Mentor new members, lead research' },
                  { role: 'Analysts & Junior Analysts', desc: 'Pitch, vote, research' },
                ].map((r) => (
                  <div
                    key={r.role}
                    className="flex items-start justify-between gap-4 border-b border-navy-100 pb-3 last:border-0"
                  >
                    <div className="font-semibold text-navy">{r.role}</div>
                    <div className="text-right text-xs text-navy-400">{r.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function JoinCta() {
  return (
    <section className="bg-gold-100/30 py-20">
      <div className="mx-auto max-w-4xl px-6 text-center">
        <h2 className="text-3xl font-bold leading-tight text-navy md:text-4xl">
          Interested in joining?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-navy-400">
          GCIG is open to Grace Church School students. Membership is by
          application and rotates with each academic year — no prior finance
          background required, only curiosity and a willingness to show up.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <a
            href="mailto:investmentgroup@gcschool.org"
            className="inline-flex items-center gap-2 rounded-lg bg-navy px-6 py-3 text-sm font-semibold text-white transition hover:bg-navy-700"
          >
            Contact the club
            <ArrowRight className="h-4 w-4" />
          </a>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 rounded-lg border border-navy px-6 py-3 text-sm font-semibold text-navy transition hover:bg-navy hover:text-white"
          >
            Member sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-navy-100 bg-white py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-xs text-navy-400 md:flex-row">
        <div>
          &copy; {new Date().getFullYear()} Grace Church Investment Group · Grace Church School
        </div>
        <div className="flex items-center gap-4">
          <Link to="/login" className="hover:text-navy">
            Member sign in
          </Link>
          <a href="mailto:investmentgroup@gcschool.org" className="hover:text-navy">
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}
