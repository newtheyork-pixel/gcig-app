import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// Breaking-news strip — a thin live wire pinned under the command bar.
// Pulls the market-wide headline feed every 30 minutes and rotates through
// the most relevant stories one at a time (a real ticker cadence), pausing
// on hover so a headline you want to click stays put. The whole strip is a
// link to the current story's source outlet.
//
// This is the terminal's "relevant but not critical" news surface; the
// genuinely market-moving one-a-day headline lives on the app Dashboard.

const REFRESH_MS = 30 * 60 * 1000; // pull fresh headlines every 30 min
const ROTATE_MS = 9_000; // advance the visible headline every 9s
const MAX_HEADLINES = 12;

export default function BreakingStrip() {
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Fetch + refresh the headline pool.
  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      api
        .get('/terminal/top-news')
        .then(({ data }) => {
          if (cancelled) return;
          const list = (data?.articles || [])
            .filter((a) => a && a.title && a.url)
            .slice(0, MAX_HEADLINES);
          setItems(list);
          // Keep the pointer valid if the list shrank.
          setIdx((i) => (list.length ? i % list.length : 0));
        })
        .catch(() => {
          /* leave the last good headlines up; a blip shouldn't blank the wire */
        });
    };
    pull();
    const id = setInterval(pull, REFRESH_MS);
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

  return (
    <div
      className="term-breaking"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="term-breaking-tag">
        <span className="dot" /> BREAKING
      </span>

      <a
        className="term-breaking-headline"
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        title={current.title}
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
