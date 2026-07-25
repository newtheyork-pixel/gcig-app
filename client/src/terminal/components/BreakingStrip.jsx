import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// Breaking-news strip — a thin live wire pinned under the command bar.
// Pulls the market-wide headline feed every 30 minutes and rotates through
// the stories one at a time (a real ticker cadence), pausing on hover so a
// headline you want to click stays put. The whole strip is a link to the
// current story's source outlet.
//
// This is the terminal's "relevant but not critical" news surface; the
// genuinely market-moving one-a-day headline lives on the app Dashboard.
//
// What arrives here is already filtered server-side: every headline is
// scored 0-10 for how genuinely breaking it is and only those clearing the
// bar are sent. That filtering is the whole point — the strip used to say
// "breaking" over an unranked wire, so an explainer about index funds sat
// under the same banner as a rate decision.
//
// The server distinguishes three states and so must we, because they look
// identical if you only count articles:
//   classified && breaking present → real breaking news, badge it
//   classified && none cleared     → a quiet day; server sends its best
//                                    few, labelled as not-breaking
//   !classified                    → the model was unreachable; this is
//                                    the raw wire and must not claim to
//                                    be anything more

const REFRESH_MS = 30 * 60 * 1000; // pull fresh headlines every 30 min
const ROTATE_MS = 9_000; // advance the visible headline every 9s
const MAX_HEADLINES = 12;
// No single outlet may fill more than this share of the strip. The wire
// arrives batched by provider, so without a cap one prolific outlet (AP,
// most days) crowds every other voice out of the rotation.
const PER_SOURCE_SHARE = 0.45;

// The wire spells the same outlet several ways ("AP", "Associated Press",
// "ap news"). Collapse to one canonical name so the per-source cap can't
// be dodged by a rename.
function normalizeSource(source) {
  const s = String(source || '').trim();
  const key = s.toLowerCase();
  if (key === 'ap' || key === 'ap news' || key === 'associated press' || key === 'the associated press') {
    return 'AP';
  }
  return s;
}

// Walk the wire newest-first, keeping a story only while its outlet is
// under the cap, until the strip is full. Capping every source (not just
// the loudest one) keeps the mix honest even when the dominant outlet
// changes week to week.
function curate(articles) {
  const perSourceCap = Math.max(1, Math.floor(MAX_HEADLINES * PER_SOURCE_SHARE));
  const bySource = new Map();
  const out = [];
  for (const a of articles || []) {
    if (!a || !a.title || !a.url) continue;
    const key = String(a.source).toLowerCase().trim();
    const n = bySource.get(key) || 0;
    if (n >= perSourceCap) continue;
    bySource.set(key, n + 1);
    out.push(a);
    if (out.length >= MAX_HEADLINES) break;
  }
  return out;
}

export default function BreakingStrip() {
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);
  // Did the model actually get to judge this batch? Drives whether the
  // strip is allowed to call itself "breaking".
  const [classified, setClassified] = useState(false);
  // Server-owned bar, mirrored so the label and the filter can never
  // disagree. The literal is only the pre-first-response default.
  const [threshold, setThreshold] = useState(6);

  // Fetch + refresh the headline pool.
  useEffect(() => {
    let cancelled = false;
    const loadWire = () => {
      api
        .get('/terminal/top-news')
        .then(({ data }) => {
          if (cancelled) return;
          const wire = (data?.articles || []).map((a) => ({
            ...a,
            source: normalizeSource(a?.source),
          }));
          setClassified(!!data?.classified);
          if (typeof data?.threshold === 'number') setThreshold(data.threshold);
          // The per-outlet cap still applies. Scoring decides WHAT is
          // worth showing; the cap keeps one prolific wire from owning
          // the rotation when several of its stories qualify.
          const list = curate(wire);
          setItems(list);
          // Keep the pointer valid if the list shrank.
          setIdx((i) => (list.length ? i % list.length : 0));
        })
        .catch(() => {
          /* leave the last good headlines up; a blip shouldn't blank the wire */
        });
    };
    loadWire();
    const id = setInterval(loadWire, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Auto-rotate through the pool unless the user is hovering (reading/aiming).
  useEffect(() => {
    if (paused || items.length <= 1) return;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, items.length]);

  if (hidden || items.length === 0) return null;

  const current = items[Math.min(idx, items.length - 1)];
  if (!current) return null;

  // Only claim "BREAKING" when the model actually said so about THIS
  // headline. On a quiet day, or with the model down, the strip still
  // carries the wire — it just stops overstating what it is.
  const isBreaking =
    classified && typeof current.breaking === 'number' && current.breaking >= threshold;

  // Surface the model's one-line justification on hover. Seeing why a
  // story was promoted is how anyone builds trust in the filter — or
  // catches it being wrong.
  const hoverTitle = current.breakingReason
    ? `${current.title}\n\n[${current.breaking}/10] ${current.breakingReason}`
    : current.title;

  return (
    <div
      className="term-breaking"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span
        className="term-breaking-tag"
        title={
          isBreaking
            ? 'Rated genuinely breaking by the research model'
            : classified
            ? 'Nothing cleared the breaking bar — showing the top of the wire'
            : 'Headline scoring unavailable — showing the unfiltered wire'
        }
        // Drop the pulsing dot when nothing is actually breaking: the
        // animation is the part that reads as urgency across the room.
        style={isBreaking ? undefined : { opacity: 0.75 }}
      >
        {isBreaking ? <span className="dot" /> : null}
        {isBreaking ? ' BREAKING' : ' WIRE'}
      </span>

      <a
        className="term-breaking-headline"
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        title={hoverTitle}
      >
        {current.source ? <span className="src">{current.source}</span> : null}
        <span className="hl">{current.title}</span>
      </a>

      <div className="term-breaking-nav">
        <button
          onClick={() => setIdx((i) => (i - 1 + items.length) % items.length)}
          title="Previous headline"
          aria-label="Previous headline"
        >
          ‹
        </button>
        <span className="count">
          {Math.min(idx, items.length - 1) + 1}/{items.length}
        </span>
        <button
          onClick={() => setIdx((i) => (i + 1) % items.length)}
          title="Next headline"
          aria-label="Next headline"
        >
          ›
        </button>
        <button
          className="close"
          onClick={() => setHidden(true)}
          title="Hide breaking bar"
          aria-label="Hide breaking bar"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
