import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';
import { griffinLogo } from '../brand/logos.js';
import {
  sanderOlinick,
  thomasSeirer,
  carterBayerd,
  ericWinter,
  eliFriedman,
} from '../brand/headshots.js';
import fieldVisitJpmorgan from '../brand/plates/field-visit.webp';
import fieldVisitPerman from '../brand/plates/field-visit-2.webp';

// Public landing for The Griffin Fund. Modeled on Select Equity Group's
// website: text-forward, institutional, restrained palette (white page, navy
// type, gold rules), serif display type. No recruitment — the page exists so
// parents, alumni, and the school community can read about the fund, and so
// members have a front door to the login.
//
// Authed users are silently redirected to /dashboard so the app opens where
// they left off.

// ---------------------------------------------------------------------------
// Reveal — Linear-style scroll-into-view animation wrapper.
// Uses Intersection Observer. Fires once (no re-animation on scroll-up).
// Respects prefers-reduced-motion.
// ---------------------------------------------------------------------------
function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    const failsafe = window.setTimeout(() => setVisible(true), 1800);
    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : 'translateY(20px)',
        transition: `opacity 700ms cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 700ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

const EASE_OUT = 'cubic-bezier(0.16,1,0.3,1)';

// Hook: returns true once the element scrolls into view, then stays true.
function useInView(threshold = 0.15) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSeen(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    // Safari's IO on inline / transformed nodes is flaky: WordReveal
    // starts at opacity 0 and can stay there. Force the reveal through
    // if the observer never fires.
    const failsafe = window.setTimeout(() => setSeen(true), 1800);
    return () => {
      obs.disconnect();
      window.clearTimeout(failsafe);
    };
  }, [threshold]);
  return [ref, seen];
}

// Word-reveal — splits children-as-string into spans that rise individually.
function WordReveal({ text, base = 0, step = 80, duration = 900, className = '' }) {
  const [ref, seen] = useInView(0.2);
  const words = text.split(/(\s+)/);
  return (
    <span ref={ref} className={className} style={{ display: 'inline' }}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: seen ? 1 : 0,
              transform: seen ? 'translateY(0)' : 'translateY(40%)',
              transition: `opacity ${duration}ms ${EASE_OUT} ${base + i * step}ms, transform ${duration}ms ${EASE_OUT} ${base + i * step}ms`,
              willChange: 'transform, opacity',
            }}
          >
            {w}
          </span>
        );
      })}
    </span>
  );
}

// Gold rule that draws across left → right when in view. Drop-in
// replacement for `<div className="h-px w-12 bg-gold" />` patterns.
function RuleSweep({ width = 'w-12', color = 'bg-gold', delay = 0, className = '' }) {
  const [ref, seen] = useInView(0.3);
  return (
    <div ref={ref} className={`relative h-px ${width} ${className}`}>
      <div
        className={`absolute inset-0 ${color}`}
        style={{
          transformOrigin: 'left',
          transform: seen ? 'scaleX(1)' : 'scaleX(0)',
          transition: `transform 1100ms cubic-bezier(0.77,0,0.175,1) ${delay}ms`,
        }}
      />
    </div>
  );
}

// CountUp — animates an integer from 0 → target once it's visible. The
// final formatted string is shown to assistive tech immediately so the
// counter never reads as "0" to a screen reader.
function CountUp({ target, duration = 1400, className = '' }) {
  const [ref, seen] = useInView(0.4);
  const [n, setN] = useState(0);
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (!seen || reduced) {
      setN(target);
      return;
    }
    const start = performance.now();
    let raf;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setN(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, target, duration, reduced]);
  return (
    <span ref={ref} className={className} aria-label={String(target)}>
      <span aria-hidden="true">{n}</span>
    </span>
  );
}

// Top-of-viewport scroll progress hairline.
function ScrollProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let ticking = false;
    const update = () => {
      const h = document.documentElement;
      const scrolled = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
      setPct(scrolled * 100);
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 200,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: '#C9A84C',
          transition: 'width 80ms linear',
        }}
      />
    </div>
  );
}

// useScrollProgress — returns 0..1 representing how far an element has
// travelled through the viewport. 0 just as its top enters the bottom
// edge, 1 as its bottom leaves the top edge. Used to drive scroll-coupled
// parallax, depth, and decay effects without a heavy library.
function useScrollProgress() {
  const ref = useRef(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = null;
    const update = () => {
      const el = ref.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const total = r.height + vh;
        const elapsed = vh - r.top;
        setP(Math.max(0, Math.min(1, elapsed / total)));
      }
      raf = null;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, p];
}

// Mouse-spring parallax for the hero. Subtly translates a target ref
// based on cursor position inside the section, with a critically-damped
// lerp so it trails the cursor instead of snapping.
function useHeroParallax(scopeRef, targetRef, range = 12) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scope = scopeRef.current;
    const target = targetRef.current;
    if (!scope || !target) return;

    let tx = 0, ty = 0, cx = 0, cy = 0;
    let raf = null, inside = false;

    function onMove(e) {
      const r = scope.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      tx = nx * range;
      ty = ny * (range * 0.6);
      inside = true;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function onLeave() {
      tx = 0;
      ty = 0;
      inside = false;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick() {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      target.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0) scale(1.04)`;
      if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05 || inside) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
      }
    }
    scope.addEventListener('pointermove', onMove, { passive: true });
    scope.addEventListener('pointerleave', onLeave);
    return () => {
      scope.removeEventListener('pointermove', onMove);
      scope.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scopeRef, targetRef, range]);
}

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-white font-sans text-navy antialiased">
      <ScrollProgress />
      <Header />
      <Hero />
      <Premise />
      <Pillars />
      <FieldVisit />
      <Leadership />
      <Numbers />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-navy-50">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 md:px-10 md:py-7">
        <Link to="/" className="min-w-0">
          <img
            src={griffinLogo}
            alt="The Griffin Fund"
            width={900}
            height={396}
            decoding="async"
            fetchPriority="high"
            className="h-12 w-auto sm:h-14 md:h-16"
          />
        </Link>
        <Link
          to="/login"
          className="member-login shrink-0 inline-flex items-center gap-2 border border-navy px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-navy md:px-5 md:py-2 md:text-xs md:tracking-[0.2em]"
          style={{ transition: `background-color 220ms ${EASE_OUT}, color 220ms ${EASE_OUT}, transform 160ms ${EASE_OUT}` }}
        >
          <span className="hidden sm:inline">Member Login</span>
          <span className="sm:hidden">Sign In</span>
          <span className="member-login-arrow inline-block" aria-hidden="true">→</span>
        </Link>
        <style>{`
          .member-login:hover { background: #1B2A4A; color: #fff; }
          .member-login:active { transform: scale(0.97); }
          .member-login-arrow { transition: transform 220ms ${EASE_OUT}; transform: translateX(0); }
          .member-login:hover .member-login-arrow { transform: translateX(4px); }
        `}</style>
      </div>
    </header>
  );
}

function Hero() {
  const sectionRef = useRef(null);
  const bgRef = useRef(null);
  useHeroParallax(sectionRef, bgRef, 18);

  return (
    <section ref={sectionRef} className="relative border-b border-navy-50 overflow-hidden">
      {/* Skyline is an <img>, not a CSS background. Safari blanks a
          background-image the moment a transform (the mouse-spring)
          is applied to the same element, which is how this layer went
          missing. Polish also rewrites the JPEG; .webp it leaves
          alone. */}
      <style>{`
        @keyframes heroEyebrowFade {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hero-eyebrow { animation: heroEyebrowFade 800ms ${EASE_OUT} both; animation-delay: 1400ms; }
      `}</style>
      <div
        ref={bgRef}
        className="pointer-events-none absolute inset-0"
        style={{ transform: 'scale(1.04)', willChange: 'transform' }}
        aria-hidden="true"
      >
        <img
          src="/hero-skyline.webp"
          alt=""
          width={1920}
          height={1280}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="absolute inset-0 bg-white/[0.75]" aria-hidden="true" />

      <div className="relative">
        <div className="mx-auto max-w-5xl px-4 py-16 md:px-10 md:py-36">
          <RuleSweep
            width="w-12 md:w-16"
            color="bg-gold"
            className="mb-6 md:mb-8"
          />
          <h1 className="font-serif text-3xl font-semibold leading-[1.15] tracking-tight text-navy md:text-6xl">
            <WordReveal
              text="The Griffin Fund was founded on the premise that disciplined investing is best learned by doing, with real capital, rigorous research, and accountability to the school community."
              base={300}
              step={45}
              duration={1000}
            />
          </h1>
          <div className="hero-eyebrow mt-8 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400 md:mt-10 md:text-[11px] md:tracking-[0.3em]">
            Grace Church School · Est. 2021
          </div>
        </div>
      </div>
    </section>
  );
}

function Premise() {
  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-5xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-20">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
                The Fund
              </div>
              <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            </div>
            <div className="font-serif text-[17px] leading-relaxed text-navy md:text-xl">
              <p>
                The Griffin Fund is the Grace Church School Investment Group, a
                student-run investment fund established in 2021 to manage a
                real, multi-year capital pool on behalf of the school community.
              </p>
              <p className="mt-6">
                Day-to-day decisions are made by students appointed and
                promoted through the fund's own ranks. Oversight comes from the
                school
                and from an advisory board of parent volunteers who work in
                finance. The fund invests only in publicly traded US equities,
                ETFs, and cash equivalents: no derivatives, no commodities, no
                short-term speculation. Every position is researched, pitched,
                and voted on before capital is committed.
              </p>
              <p className="mt-6">
                The goal is not performance for its own sake. It is to give
                students a genuine, high-stakes classroom for learning how
                markets work, how capital is allocated, and how professional
                investors think about risk.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Pillars() {
  const pillars = [
    {
      heading: 'Research',
      body: 'Every pitch begins with written analysis: thesis, valuation, risks, and catalysts. Ideas are workshopped inside sector pods before they reach the full body, and only positions that survive that scrutiny come to a vote.',
    },
    {
      heading: 'Discipline',
      body: 'The fund operates inside a written Investment Policy Statement. Positions are held for the long term, capped in size, and reviewed on a standing schedule. When the market moves against us, we revisit the thesis. We don\'t panic out of it.',
    },
    {
      heading: 'Stewardship',
      body: 'This is real capital, entrusted to students by Grace Church School. Every trade is logged, every decision is recorded, and the fund is accountable to faculty and to the advisory board on a standing quarterly basis.',
    },
  ];
  return (
    <section className="border-b border-navy-50 bg-[#FAFAF7]">
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-10 max-w-2xl md:mb-20">
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
              How we invest
            </div>
            <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            <h2 className="mt-5 font-serif text-2xl font-semibold leading-tight text-navy md:mt-6 md:text-4xl">
              Three principles guide everything the fund does.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-10 md:grid-cols-3 md:gap-10">
          {pillars.map((p, i) => (
            <Pillar key={p.heading} index={i} pillar={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

// Single pillar card. Numeral rises with a slight scale, then heading and
// body fade in after, all gated on the card itself entering view.
function Pillar({ pillar, index }) {
  const [ref, seen] = useInView(0.25);
  const stagger = index * 120;
  const numStyle = {
    display: 'inline-block',
    opacity: seen ? 1 : 0,
    transform: seen ? 'translateY(0) scale(1)' : 'translateY(28px) scale(0.94)',
    transition: `opacity 1100ms ${EASE_OUT} ${stagger}ms, transform 1100ms ${EASE_OUT} ${stagger}ms`,
    willChange: 'transform, opacity',
  };
  const textStyle = (extraDelay) => ({
    opacity: seen ? 1 : 0,
    transform: seen ? 'translateY(0)' : 'translateY(14px)',
    transition: `opacity 800ms ${EASE_OUT} ${stagger + extraDelay}ms, transform 800ms ${EASE_OUT} ${stagger + extraDelay}ms`,
  });
  return (
    <div ref={ref}>
      <div className="font-serif text-4xl font-light text-gold md:text-5xl" style={numStyle}>
        {String(index + 1).padStart(2, '0')}
      </div>
      <h3
        className="mt-3 font-serif text-xl font-semibold text-navy md:mt-4 md:text-2xl"
        style={textStyle(280)}
      >
        {pillar.heading}
      </h3>
      <p
        className="mt-3 text-[14px] leading-relaxed text-navy-500 md:text-[15px]"
        style={textStyle(420)}
      >
        {pillar.body}
      </p>
    </div>
  );
}

// FieldVisit — editorial "field studies" section. A page header (eyebrow,
// gold rule, heading, supporting line) sets the frame, then a sequence of
// FieldPlate figures each take their own turn: the arrival timeline is
// gated on each plate's own scroll-into-view. The photograph itself is a
// plain <img> — Safari will not paint a large photo that also carries a
// CSS filter, clip-path, or Ken Burns transform, and it surfaces as the
// broken-image glyph. Parallax lives on the wrapper, like the skyline.
// All remaining motion is opt-out via prefers-reduced-motion.
function FieldVisit() {
  return (
    <section className="relative overflow-hidden border-b border-navy-50 bg-white">
      {/* The off-white paper field behind the plates — picks up the gold
          tint very faintly so each photo reads warmer when the eye lands. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 50% 25%, rgba(201,168,76,0.05), transparent 70%), linear-gradient(to bottom, #FBFAF6 0%, #FFFFFF 50%, #FAFAF7 100%)',
        }}
      />

      {/* Shared keyframes + atom classes consumed by every plate inside
          the section. Scoped via the .fv-seen toggle each plate applies
          to its own wrapper so reveals stay independent. */}
      <style>{`
        @keyframes fv-eyebrow-blink {
          0%, 90%, 100% { opacity: 1; }
          92%, 98%      { opacity: 0.35; }
        }
        .fv-corner {
          position: absolute;
          width: 22px; height: 22px;
          border-color: #C9A84C;
          opacity: 0;
          transform: scale(0.7);
          transition: opacity 700ms cubic-bezier(0.16,1,0.3,1) 900ms, transform 900ms cubic-bezier(0.16,1,0.3,1) 900ms;
        }
        .fv-seen .fv-corner { opacity: 1; transform: scale(1); }
        .fv-corner.tl { top: -1px; left: -1px; border-top: 1.5px solid; border-left: 1.5px solid; }
        .fv-corner.tr { top: -1px; right: -1px; border-top: 1.5px solid; border-right: 1.5px solid; }
        .fv-corner.bl { bottom: -1px; left: -1px; border-bottom: 1.5px solid; border-left: 1.5px solid; }
        .fv-corner.br { bottom: -1px; right: -1px; border-bottom: 1.5px solid; border-right: 1.5px solid; }
        .fv-eyebrow-dot {
          display: inline-block; width: 6px; height: 6px; margin-right: 10px;
          background: #C9A84C; border-radius: 999px; vertical-align: middle;
          animation: fv-eyebrow-blink 4s ease-in-out infinite;
        }
        .fv-figcap-line { position: relative; display: inline-block; }
        .fv-figcap-line::after {
          content: ''; position: absolute; left: 0; right: 0; bottom: -4px;
          height: 1px; background: rgba(255,255,255,0.55);
          transform-origin: left; transform: scaleX(0);
          transition: transform 1100ms cubic-bezier(0.77,0,0.175,1) 1800ms;
        }
        .fv-seen .fv-figcap-line::after { transform: scaleX(1); }
        .fv-rotate-watermark {
          letter-spacing: 0.55em;
          writing-mode: vertical-rl;
          transform: rotate(180deg);
          font-feature-settings: 'liga' 0;
        }
      `}</style>

      <div className="relative mx-auto max-w-6xl px-4 py-16 md:px-10 md:py-32">
        {/* Editorial header — eyebrow, gold rule, heading, supporting line. */}
        <div className="mb-12 max-w-3xl md:mb-20">
          <Reveal>
            <div className="flex items-center text-[10px] font-semibold uppercase tracking-[0.28em] text-gold-700 md:text-[11px] md:tracking-[0.32em]">
              <span className="fv-eyebrow-dot" aria-hidden="true" />
              Field notes
            </div>
          </Reveal>
          <RuleSweep width="w-10" color="bg-navy" className="mt-3" delay={120} />
          <h2 className="mt-5 font-serif text-3xl font-semibold leading-[1.1] tracking-tight text-navy md:mt-7 md:text-5xl">
            <WordReveal
              text="Beyond the classroom."
              base={120}
              step={70}
              duration={950}
            />
          </h2>
          <p className="mt-4 max-w-xl font-serif text-base leading-relaxed text-navy-500 md:mt-6 md:text-lg">
            <WordReveal
              text="The fund spends time inside the institutions whose discipline informs our own, and brings the people who do this for a living back into the room. Real visits, real conversations, real questions."
              base={600}
              step={28}
              duration={750}
            />
          </p>
        </div>

        {/* Plates run in document order. Each one carries its own scroll-
            in-view gate, so the cinematic reveal fires the moment that
            specific figure enters the viewport — not when the section
            does. The first plate carries the side watermark; the second
            is left clean. */}
        <FieldPlate
          src={fieldVisitJpmorgan}
          alt="Members of The Griffin Fund inside the atrium of JPMorgan's headquarters during a Spring 2025 tour and meeting."
          eyebrow="JPMorgan · Spring 2025"
          caption="We spent a morning at JPMorgan, got a tour of the building, then sat down with some of their team."
          plateNumeral="01"
          plateLabel="Plate I"
          pictured="Pictured: Members of the fund, with faculty advisor."
          showWatermark
        />
        <FieldPlate
          src={fieldVisitPerman}
          alt="Jacob Perman '16 speaking to members of The Griffin Fund in a Grace Church School classroom during a November 2025 alumni visit."
          eyebrow="Jacob Perman '16 · November 2025"
          caption="Jacob Perman '16 came back to walk us through what he actually does: leveraged finance at Wells Fargo."
          plateNumeral="02"
          plateLabel="Plate II"
          pictured="Pictured: Jacob Perman '16, addressing the club."
          className="mt-20 md:mt-32"
        />
      </div>
    </section>
  );
}

// FieldPlate — one framed photograph. The photo itself is an in-flow
// <img> with intrinsic width/height, no <picture>, and no transform /
// filter / clip-path on it or any ancestor. Safari still paints the
// broken-image glyph (alt text + "?") when any of that stack is
// present, which is why JPMorgan and Perman stayed blank after Ken
// Burns came off. Reveal motion lives on the caption overlays only.
function FieldPlate({
  src,
  alt,
  eyebrow,
  caption,
  plateNumeral,
  plateLabel,
  pictured,
  showWatermark = false,
  className = '',
}) {
  const [sectionRef, seen] = useInView(0.18);

  const E = EASE_OUT;
  const figureShadow = seen
    ? '0 1px 2px rgba(27,42,74,0.05), 0 6px 14px rgba(27,42,74,0.08), 0 28px 60px -20px rgba(27,42,74,0.30), 0 60px 120px -36px rgba(27,42,74,0.30)'
    : '0 1px 2px rgba(27,42,74,0.04), 0 4px 10px rgba(27,42,74,0.04)';

  // Per-side rule transforms. Each draws in along its long axis from a
  // specific origin so the four sides chase each other clockwise.
  const rule = (active, origin) => ({
    transformOrigin: origin,
    transform: active
      ? 'scale(1)'
      : (origin.includes('left') || origin.includes('right') ? 'scaleX(0)' : 'scaleY(0)'),
    transition: `transform 700ms cubic-bezier(0.77,0,0.175,1)`,
  });

  return (
    <div
      ref={sectionRef}
      className={`relative ${seen ? 'fv-seen' : ''} ${className}`}
    >
      {/* Side watermark — vertical institutional tag, desktop only. Only
          the first plate carries it; subsequent plates stay clean. */}
      {showWatermark && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-4 top-6 hidden text-[9px] font-semibold uppercase text-navy-200 md:block fv-rotate-watermark"
          style={{
            opacity: seen ? 1 : 0,
            transform: `rotate(180deg) translateY(${seen ? 0 : -12}px)`,
            transition: `opacity 1000ms ${E} 1200ms, transform 1000ms ${E} 1200ms`,
          }}
        >
          The Griffin Fund · Field Study
        </div>
      )}

      <figure className="relative mx-auto" style={{ maxWidth: '1080px' }}>
        {/* Four enclosing rules — each animates in along its long axis,
            chasing the previous one clockwise from the top edge. */}
        <div className="pointer-events-none absolute inset-0 z-20">
          <div
            className="absolute left-0 right-0 top-0 h-px bg-navy/85"
            style={{ ...rule(seen, 'left center'), transitionDelay: '350ms' }}
          />
          <div
            className="absolute right-0 top-0 bottom-0 w-px bg-navy/85"
            style={{ ...rule(seen, 'center top'), transitionDelay: '620ms' }}
          />
          <div
            className="absolute left-0 right-0 bottom-0 h-px bg-navy/85"
            style={{ ...rule(seen, 'right center'), transitionDelay: '890ms' }}
          />
          <div
            className="absolute left-0 top-0 bottom-0 w-px bg-navy/85"
            style={{ ...rule(seen, 'center bottom'), transitionDelay: '1160ms' }}
          />

          {/* Gold L-shaped corner accents — fade + scale in once the
              four enclosing rules have finished drawing. */}
          <span className="fv-corner tl" aria-hidden="true" />
          <span className="fv-corner tr" aria-hidden="true" />
          <span className="fv-corner bl" aria-hidden="true" />
          <span className="fv-corner br" aria-hidden="true" />
        </div>

        {/* Photograph. In-flow, intrinsic size, hashed URL so Safari
            cannot reuse a poisoned cache of /field-visit.webp. */}
        <div
          className="relative w-full overflow-hidden bg-navy-50"
          style={{
            boxShadow: figureShadow,
            transition: `box-shadow 1500ms ${E} 400ms`,
          }}
        >
          <img
            src={src}
            alt={alt}
            width={2200}
            height={1650}
            decoding="async"
            className="block h-auto w-full"
          />

          {/* Lower scrim — a soft navy-to-transparent gradient that
              sits behind the caption so type lifts off the image
              instead of fighting it. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-2/5"
            style={{
              background:
                'linear-gradient(to top, rgba(13,22,38,0.62) 0%, rgba(13,22,38,0.20) 55%, transparent 100%)',
            }}
          />

          {/* Index label — top-right, tiny tracked caps. */}
          <div
            className="pointer-events-none absolute right-4 top-4 z-10 text-right md:right-6 md:top-6"
            style={{
              opacity: seen ? 1 : 0,
              transform: `translateY(${seen ? 0 : -8}px)`,
              transition: `opacity 900ms ${E} 1500ms, transform 900ms ${E} 1500ms`,
            }}
          >
            <div className="text-[9px] font-semibold uppercase tracking-[0.32em] text-white/80 md:text-[10px]">
              Field Study
            </div>
            <div className="mt-1 font-serif text-base font-light text-gold-300 md:text-lg">
              N<span className="italic">o</span> {plateNumeral}
            </div>
          </div>

          {/* Caption — bottom-left, magazine-style. Date underline draws
              in after the words land. */}
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 md:bottom-7 md:left-7 md:right-auto md:max-w-md">
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.28em] text-gold-300 md:text-[11px] md:tracking-[0.32em]"
              style={{
                opacity: seen ? 1 : 0,
                transform: `translateY(${seen ? 0 : 10}px)`,
                transition: `opacity 800ms ${E} 1700ms, transform 800ms ${E} 1700ms`,
              }}
            >
              <span className="fv-figcap-line">{eyebrow}</span>
            </div>
            <p className="mt-2 font-serif text-lg leading-snug text-white md:mt-3 md:text-2xl">
              {seen ? (
                <WordReveal text={caption} base={1900} step={38} duration={800} />
              ) : (
                <span style={{ opacity: 0 }}>{caption}</span>
              )}
            </p>
          </div>
        </div>
      </figure>

      {/* Footer line beneath the figure — pictured tag + plate number,
          like a print plate. Animates in last. */}
      <div
        className="mx-auto mt-6 flex max-w-[1080px] items-end justify-between gap-6 md:mt-8"
        style={{
          opacity: seen ? 1 : 0,
          transform: `translateY(${seen ? 0 : 10}px)`,
          transition: `opacity 900ms ${E} 2400ms, transform 900ms ${E} 2400ms`,
        }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-navy-400 md:text-[11px] md:tracking-[0.28em]">
          {pictured}
        </div>
        <div className="hidden text-[10px] font-semibold uppercase tracking-[0.32em] text-navy-200 md:block">
          {plateLabel}
        </div>
      </div>
    </div>
  );
}

function Leadership() {
  const groups = [
    {
      title: 'Presidents',
      members: [
        { name: 'Sander Olinick', role: 'President', photo: sanderOlinick, size: 'xl' },
        { name: 'Thomas Seirer', role: 'President', photo: thomasSeirer, size: 'xl' },
      ],
    },
    {
      title: 'Director of Research',
      members: [
        { name: 'Carter Bayerd', role: 'Director of Research', photo: carterBayerd, size: 'lg' },
      ],
    },
    {
      title: 'Chief Investment Officers',
      members: [
        { name: 'Cole H. Fader', role: 'Chief Investment Officer', size: 'md' },
        { name: 'Eric Winter', role: 'Chief Investment Officer', photo: ericWinter, size: 'md' },
      ],
    },
    {
      title: 'Portfolio Managers',
      members: [
        { name: 'Harry de Mendonca', role: 'Portfolio Manager · ETF', size: 'sm' },
        { name: 'Eli Friedman', role: 'Portfolio Manager · Consumers', photo: eliFriedman, size: 'sm' },
        { name: 'Elliot Meyers-Kane', role: 'Portfolio Manager · Energy', size: 'sm' },
      ],
    },
  ];

  // Batch-look up inferred gender for every member name. Used to tint
  // the monogram fallback. Public endpoint, single request.
  const allNames = useMemo(
    () => groups.flatMap((g) => g.members.map((m) => m.name)),
    // `groups` is defined inline every render but its content is static
    // for this page, so the dependency list is intentionally empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [genderMap, setGenderMap] = useState(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .post('/public/name-gender', { names: allNames })
      .then((res) => {
        if (cancelled) return;
        const m = new Map();
        for (const r of res.data?.results || []) {
          m.set(r.name, r.gender);
        }
        setGenderMap(m);
      })
      .catch(() => {
        /* fall back to the default (neutral) tint if this fails. */
      });
    return () => {
      cancelled = true;
    };
  }, [allNames]);

  const presidents = groups[0];
  const rest = groups.slice(1);

  return (
    <section className="border-b border-navy-50">
      <style>{`
        .member-row:hover { transform: translateX(4px); }
        .member-row:hover .member-avatar { box-shadow: 0 6px 20px -8px rgba(27, 42, 74, 0.35); }
      `}</style>
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-10 max-w-2xl md:mb-16">
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
              Leadership
            </div>
            <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            <h2 className="mt-5 font-serif text-2xl font-semibold leading-tight text-navy md:mt-6 md:text-4xl">
              Led from within the club.
            </h2>
            <p className="mt-3 font-serif text-base leading-relaxed text-navy-500 md:mt-4 md:text-lg">
              Led by founding members, with new leadership appointed as the
              fund grows.
            </p>
          </div>
        </Reveal>

        <Reveal>
          <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-navy-400 md:mb-6 md:text-[11px] md:tracking-[0.25em]">
            {presidents.title}
          </div>
          <ul className="mb-12 space-y-8 md:mb-16 md:max-w-xl">
            {presidents.members.map((m) => (
              <li key={m.name} className="flex items-center gap-5">
                <MemberAvatar member={m} gender={genderMap.get(m.name)} />
                <div className="min-w-0">
                  <div className="font-serif text-xl font-semibold text-navy md:text-2xl">
                    {m.name}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.15em] text-navy-400 md:text-[11px] md:tracking-[0.2em]">
                    {m.role}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>

        <div className="grid gap-10 md:grid-cols-2 md:gap-16">
          <div className="space-y-10">
            {rest.slice(0, 2).map((group, gi) => (
              <Reveal key={group.title} delay={gi * 100}>
                <MemberGroup group={group} genderMap={genderMap} delay={gi * 100} />
              </Reveal>
            ))}
          </div>
          <Reveal delay={200}>
            <MemberGroup group={rest[2]} genderMap={genderMap} delay={200} />
          </Reveal>
        </div>

        <Reveal delay={700}>
          <p className="mt-10 text-sm italic text-navy-400 md:mt-12">
            Faculty advisor: Nicholas Kurian.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function MemberGroup({ group, genderMap, delay }) {
  return (
    <div>
      <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-navy-400 md:mb-6 md:text-[11px] md:tracking-[0.25em]">
        {group.title}
      </div>
      <ul className="space-y-4">
        {group.members.map((m, mi) => (
          <li
            key={m.name}
            className="member-row flex items-center gap-4"
            style={{
              transition: `transform 280ms ${EASE_OUT}`,
              transitionDelay: `${delay + (mi + 1) * 80}ms`,
            }}
          >
            <MemberAvatar member={m} gender={genderMap.get(m.name)} />
            <div className="min-w-0">
              <div className="font-serif text-lg font-semibold text-navy">
                {m.name}
              </div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-navy-400 md:text-[11px] md:tracking-[0.2em]">
                {m.role}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Numbers() {
  const stats = [
    { value: '2021', label: 'Founded', countUp: 2021 },
    { value: 'Six figures', label: 'Capital under management' },
    { value: 'US equities, ETFs', label: 'Investment universe' },
    { value: 'Quarterly', label: 'Advisory board review' },
  ];
  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-20">
        <div className="grid grid-cols-2 gap-x-2 gap-y-10 md:grid-cols-4 md:gap-x-0">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 100}>
              {/*
                Left-side divider behavior:
                  Mobile (2 cols): show a left border only on the RIGHT
                  column items (1 and 3) — odd:border-l-0 hides it on the
                  left-column items (0 and 2).
                  Desktop (4 cols): show on every item except the first.
              */}
              <div className="border-l border-navy-100 px-4 odd:border-l-0 md:px-6 md:odd:border-l md:first:border-l-0">
                <div className="font-serif text-xl font-semibold leading-tight text-navy md:text-3xl">
                  {s.countUp ? <CountUp target={s.countUp} duration={1500} /> : s.value}
                </div>
                <div className="mt-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-navy-400 md:text-[10px] md:tracking-[0.25em]">
                  {s.label}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8 md:flex-row md:items-center md:justify-between md:gap-6 md:px-10 md:py-10">
        <div className="flex items-center gap-3">
          <img
            src={griffinLogo}
            alt="The Griffin Fund"
            width={900}
            height={396}
            className="h-10 w-auto md:h-12"
          />
          <div className="text-[10px] uppercase tracking-[0.25em] text-navy-400">
            Grace Church School
          </div>
        </div>
        <div className="flex items-center gap-6 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400">
          <Link to="/login" className="transition hover:text-navy">
            Member Login
          </Link>
          <span>&copy; {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}

// Circular avatar for the Leadership list. Uses a real photo when the
// member object has `photo`, otherwise falls back to a gold-on-navy
// monogram built from the member's initials. Keeps the list visually
// consistent even when only some members have headshots.
// Tint the monogram backdrop + glyph color by inferred gender. Only
// visible on members without a headshot (the photo layer covers the
// backdrop when it loads). Keeps both variants inside the brand
// palette — no pink/blue stereotype, just a cool / warm split.
const AVATAR_TINT = {
  M: { bg: 'bg-navy', fg: 'text-gold' },
  F: { bg: 'bg-gold-200', fg: 'text-navy' },
  U: { bg: 'bg-navy-100', fg: 'text-navy' },
};

const AVATAR_SIZE = {
  xl: 'h-28 w-28 md:h-32 md:w-32',
  lg: 'h-20 w-20 md:h-24 md:w-24',
  md: 'h-16 w-16 md:h-20 md:w-20',
  sm: 'h-12 w-12',
};

const AVATAR_TYPE = {
  xl: 'text-xl md:text-2xl',
  lg: 'text-lg',
  md: 'text-base',
  sm: 'text-sm',
};

function MemberAvatar({ member, gender }) {
  const initials = member.name
    .split(/\s+/)
    .filter((p) => p && !/^[A-Za-z]\.$/.test(p))
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const tint = AVATAR_TINT[gender] || AVATAR_TINT.U;
  const size = member.size || 'sm';

  return (
    <div
      className={`member-avatar relative shrink-0 overflow-hidden rounded-full border border-navy-100 ${AVATAR_SIZE[size]} ${tint.bg}`}
      style={{ transition: `box-shadow 320ms ${EASE_OUT}` }}
    >
      {member.photo && (
        <img
          src={member.photo}
          alt={member.name}
          decoding="async"
          className="absolute inset-0 z-10 h-full w-full object-cover object-top"
        />
      )}
      {/* Monogram sits behind the image; if the image fails or is absent,
          it's visible. Color tint signals inferred gender; if we couldn't
          infer (or haven't fetched yet), the neutral navy-100 variant is
          used so the tile still reads. */}
      <div
        aria-hidden={!!member.photo}
        className={`flex h-full w-full items-center justify-center font-serif font-semibold ${AVATAR_TYPE[size]} ${tint.fg}`}
      >
        {initials}
      </div>
    </div>
  );
}
