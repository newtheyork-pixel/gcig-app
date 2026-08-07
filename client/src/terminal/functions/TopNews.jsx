import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// TOP — market-wide top headlines. Auto-polls every 60s.
// Uses the terminal/top-news endpoint (Finnhub general feed, 10-min server cache).

const POLL_INTERVAL_MS = 60_000;

export default function TopNews() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [newIds, setNewIds] = useState(new Set());
  const prevUrlsRef = useRef(new Set());

  const fetchTop = (isInitial) => {
    if (isInitial) {
      setLoading(true);
      setErr(null);
      setItems([]);
      setBrief('');
      prevUrlsRef.current = new Set();
    }
    api
      // `all=1` keeps the whole market-wide feed. The endpoint filters to
      // genuinely-breaking stories by default for the ticker strip; TOP is
      // a reading panel and wants everything.
      .get('/terminal/top-news?all=1')
      .then(({ data }) => {
        const list = data?.articles || [];

        if (!isInitial && prevUrlsRef.current.size > 0) {
          const fresh = new Set();
          for (const it of list) {
            if (!prevUrlsRef.current.has(it.url)) fresh.add(it.url);
          }
          if (fresh.size > 0) {
            setNewIds(fresh);
            setTimeout(() => setNewIds(new Set()), 4000);
          }
        }

        prevUrlsRef.current = new Set(list.map((it) => it.url));
        setItems(list);
        setLastRefresh(new Date());
      })
      .catch((e) => {
        if (isInitial) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (isInitial) setLoading(false);
      });
  };

  useEffect(() => {
    fetchTop(true);
  }, []);

  // Poll only while visible — a background tab shouldn't spend the caps.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) fetchTop(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Header clock ticks every second so the panel reads as live rather
  // than frozen at the last 60s poll.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // AI brief on genuinely new headlines. The 60s poll returns a fresh
  // array identity even when nothing changed (server caches 10 min), so
  // keying on `items` alone re-ran the LLM every minute per open pane.
  // Fingerprint the content and only re-annotate when it moves.
  const briefKeyRef = useRef('');
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  useEffect(() => {
    if (!items.length) return;
    const top = [...items].sort((a, b) => tsOf(b) - tsOf(a)).slice(0, 10);
    const key = top.map((it) => it.url || it.title).join('|');
    if (briefKeyRef.current === key) return;
    briefKeyRef.current = key;
    setBriefLoading(true);
    const context = top
      .map((it, i) => `${i + 1}. ${formatTime(it.publishedAt)} — ${it.title || ''} (${it.source || ''})`)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker: '', function: 'TOP', context })
      .then(({ data }) => {
        if (aliveRef.current) setBrief(data.brief || '');
      })
      .catch(() => {
        if (aliveRef.current) setBrief('');
      })
      .finally(() => {
        if (aliveRef.current) setBriefLoading(false);
      });
  }, [items]);

  if (loading) return <div className="term-panel"><div className="term-loading">Loading top news…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;

  // Headlines arrive batched per source (all Reuters, then all CNBC),
  // never globally ordered. Sort newest-first so the feed reads as one
  // timeline instead of interleaved blocks.
  const ordered = [...items].sort((a, b) => tsOf(b) - tsOf(a));

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">TOP</span>
        <span className="name">Market Headlines</span>
        <span className="term-live-badge">● LIVE</span>
        {lastRefresh && (
          <span className="term-refresh-ts">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
          </span>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        {ordered.length === 0 ? (
          <div className="term-loading">No headlines available.</div>
        ) : (
          ordered.map((it, i) => {
            const isNew = newIds.has(it.url);
            const rowClass = `term-news-row${isNew ? ' term-news-flash' : ''}`;
            // The whole row is the link, not just the headline text — a
            // truncated 12px title is a mean click target.
            const cells = (
              <>
                <span className="time">{formatTime(it.publishedAt)}</span>
                <span className="source">{it.source || ''}</span>
                <span className="title">
                  {it.title}
                  {it.url ? (
                    <span className="term-news-ext" aria-hidden="true"> ↗</span>
                  ) : null}
                </span>
              </>
            );
            return it.url ? (
              <a
                className={rowClass}
                key={it.url}
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {cells}
              </a>
            ) : (
              <div className={rowClass} key={i}>
                {cells}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Comparable epoch ms for sorting. Undated stories sink to the bottom
// rather than jumping the feed.
function tsOf(it) {
  const t = new Date(it?.publishedAt).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
