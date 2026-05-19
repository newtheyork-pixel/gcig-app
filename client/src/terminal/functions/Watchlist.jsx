import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// W — the user's saved ticker lists, live. GET /api/watchlist returns
// every list the caller owns (lazily creating a default "Watchlist" if
// they have none), each with its tickers. One list is "active" at a
// time; only the active list's tickers feed the shared demand-driven
// quote poller — the exact Movers/Peers pattern — so the live-quote
// fan-out stays bounded no matter how many lists or tickers exist.
//
// Every list/item mutation POSTs/PATCHes/DELETEs and then re-renders
// from the response's { lists } (single source of truth). The server
// is never-5xx: a mutation that hits an unexpected fault degrades to
// { ok:false, error } with NO lists key — so we only ever adopt
// data.lists when it's actually an array, and otherwise keep the
// state we already had and surface a soft inline notice. A failed
// quote poll keeps the last good prices (useLiveRefresh already does
// that); the panel never blanks numbers it was showing.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
};

const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;

export default function Watchlist({ onOpen }) {
  const [lists, setLists] = useState(null); // null = not loaded yet
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null); // hard load failure
  const [authMissing, setAuthMissing] = useState(false);
  const [notice, setNotice] = useState(''); // soft, transient op notice
  const [tickerInput, setTickerInput] = useState('');
  const [busy, setBusy] = useState(false); // a mutation is in flight

  // Adopt a fresh { lists } payload as the single source of truth.
  // Only ever called with a real array — the never-5xx degraded
  // mutation shape ({ ok:false }) is filtered out by the callers, so
  // a soft server fault never wipes the panel to empty.
  const adopt = useCallback((arr) => {
    setLists(arr);
    setActiveId((cur) => {
      if (cur != null && arr.some((l) => l.id === cur)) return cur;
      return arr.length ? arr[0].id : null;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    setAuthMissing(false);
    try {
      const { data } = await api.get('/watchlist');
      if (Array.isArray(data?.lists)) {
        adopt(data.lists);
      } else {
        // Never-5xx GET degrades to { lists: [] }; treat a missing
        // array defensively as "no lists" rather than an error.
        adopt([]);
      }
    } catch (e) {
      const status = e.response?.status;
      if (status === 401) {
        setAuthMissing(true);
      } else {
        setLoadErr(
          e.response?.data?.error || e.message || 'Failed to load watchlists'
        );
      }
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(
    () => (lists || []).find((l) => l.id === activeId) || null,
    [lists, activeId]
  );

  // The active list's tickers, upper-cased and de-duped into a stable
  // comma key so the poll only re-keys when the active list's contents
  // actually change — not on every parent re-render, and crucially not
  // when a *different* list changes. This is the ONLY thing handed to
  // the live-quote fetch; non-active lists are never polled.
  const liveTickers = useMemo(
    () => [
      ...new Set(
        (active?.items || []).map((i) => String(i.ticker).toUpperCase())
      ),
    ],
    [active]
  );
  const liveKey = liveTickers.join(',');

  const { data: liveQuotes, lastUpdated } = useLiveRefresh(
    async () => {
      if (!liveKey) return {};
      const { data } = await api.get('/terminal/quotes', {
        params: { tickers: liveKey },
      });
      return data;
    },
    { enabled: liveTickers.length > 0 }
  );

  // Apply a mutation's response. Success carries { lists } (re-render
  // from it); the degraded never-5xx shape carries { ok:false, error }
  // with no lists — keep current state, show a soft notice, no data
  // loss. Returns true on a clean apply so callers can clear inputs.
  //
  // One special case: deleting the last list returns { lists: [] }.
  // The spec promises the panel is never permanently empty of lists —
  // the *next GET* lazily respawns the default. Rather than strand the
  // user on an empty, control-disabled panel until they reload, we
  // re-GET immediately so the default reappears in-session. (load()
  // owns its own loading state; this stays a clean single-source
  // refresh.)
  const applyResult = useCallback(
    (data, fallbackMsg) => {
      if (Array.isArray(data?.lists)) {
        if (data.lists.length === 0) {
          setNotice('');
          load();
          return true;
        }
        adopt(data.lists);
        setNotice('');
        return true;
      }
      setNotice(data?.error || fallbackMsg);
      return false;
    },
    [adopt, load]
  );

  // One wrapper for every mutation: guards against concurrent ops,
  // routes the response through applyResult, and turns a thrown error
  // (4xx the server returns honestly, or a network failure) into the
  // same soft inline notice — the list state is never lost.
  const mutate = useCallback(
    async (fn, fallbackMsg) => {
      if (busy) return false;
      setBusy(true);
      setNotice('');
      try {
        const { data } = await fn();
        return applyResult(data, fallbackMsg);
      } catch (e) {
        setNotice(
          e.response?.data?.error || e.message || fallbackMsg
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, applyResult]
  );

  const addTicker = useCallback(async () => {
    const t = tickerInput.trim().toUpperCase();
    if (!t || !active) return;
    if (!TICKER_RE.test(t)) {
      setNotice(`"${tickerInput.trim()}" is not a valid ticker.`);
      return;
    }
    const ok = await mutate(
      () => api.post(`/watchlist/lists/${active.id}/items`, { ticker: t }),
      'Could not add that ticker.'
    );
    if (ok) setTickerInput('');
  }, [tickerInput, active, mutate]);

  const removeTicker = useCallback(
    (ticker) => {
      if (!active) return;
      mutate(
        () =>
          api.delete(
            `/watchlist/lists/${active.id}/items/${encodeURIComponent(
              ticker
            )}`
          ),
        'Could not remove that ticker.'
      );
    },
    [active, mutate]
  );

  const newList = useCallback(async () => {
    const name = (
      window.prompt('Name the new watchlist:') || ''
    ).trim();
    if (!name) return;
    await mutate(
      () => api.post('/watchlist/lists', { name }),
      'Could not create the list.'
    );
  }, [mutate]);

  const renameList = useCallback(async () => {
    if (!active) return;
    const name = (
      window.prompt('Rename this watchlist:', active.name) || ''
    ).trim();
    if (!name || name === active.name) return;
    await mutate(
      () => api.patch(`/watchlist/lists/${active.id}`, { name }),
      'Could not rename the list.'
    );
  }, [active, mutate]);

  const deleteList = useCallback(async () => {
    if (!active) return;
    if (
      !window.confirm(
        `Delete "${active.name}"? Its tickers will be removed. ` +
          `(If it's your last list, a fresh default is recreated next load.)`
      )
    ) {
      return;
    }
    await mutate(
      () => api.delete(`/watchlist/lists/${active.id}`),
      'Could not delete the list.'
    );
  }, [active, mutate]);

  // Enter/Space activate a clickable row — same a11y shape as Movers.
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  // ── Honest non-data states ───────────────────────────────────────
  if (authMissing) {
    return (
      <div className="term-panel">
        <div className="term-error">
          Sign in to use watchlists — they're saved to your profile.
        </div>
      </div>
    );
  }
  if (loading && lists == null) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading your watchlists…</div>
      </div>
    );
  }
  if (loadErr && lists == null) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {loadErr}</div>
      </div>
    );
  }
  if (lists == null) return null;

  // Overlay the live tap onto the active list's tickers. Units:
  // /terminal/quotes' changePct is Finnhub's `dp`, already a percent
  // (1.23 == +1.23%); fmt.pct here speaks the fraction convention and
  // does the ×100, so we divide the live value by 100 — exactly as
  // Movers/Peers do. A name with no quote yet (or a Finnhub miss →
  // null) simply renders "—" rather than blanking anything.
  const rows = (active?.items || []).map((it) => {
    const sym = String(it.ticker).toUpperCase();
    const q = liveQuotes ? liveQuotes[sym] : null;
    return {
      ticker: sym,
      last: q?.last != null ? q.last : null,
      changePct: q?.changePct != null ? q.changePct / 100 : null,
    };
  });

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">W</span>
        <span className="name">
          Watchlist{active ? ` · ${active.name}` : ''}
          {active ? ` · ${active.items.length}/${50}` : ''}
        </span>
        {liveTickers.length > 0 && lastUpdated ? (
          <span className="term-live-badge">● LIVE</span>
        ) : null}
      </div>

      {/* List selector — tabs, wrapping if they overflow. The active
          list is highlighted; clicking one switches which list is
          polled. */}
      <div className="term-wl-tabs term-tabs">
        {lists.map((l) => (
          <button
            key={l.id}
            className={`term-tab${l.id === activeId ? ' active' : ''}`}
            onClick={() => setActiveId(l.id)}
            title={`${l.name} · ${l.items.length} ticker${
              l.items.length === 1 ? '' : 's'
            }`}
          >
            {l.name}
          </button>
        ))}
        <button
          className="term-tab term-wl-newtab"
          onClick={newList}
          disabled={busy || lists.length >= 20}
          title={
            lists.length >= 20
              ? 'List cap reached (20)'
              : 'Create a new watchlist'
          }
        >
          + New
        </button>
      </div>

      {/* Active-list controls: add a ticker, rename / delete the list.
          All disabled while a mutation is in flight so a double-click
          can't race the single-source-of-truth refresh. */}
      <div className="term-wl-controls">
        <input
          className="term-commandbar-input term-wl-input"
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTicker();
            }
          }}
          placeholder="Add ticker (e.g. AAPL)"
          disabled={busy || !active}
          spellCheck={false}
        />
        <button
          className="term-commandbar-go"
          onClick={addTicker}
          disabled={busy || !active || !tickerInput.trim()}
        >
          ADD
        </button>
        <button
          className="term-wl-btn"
          onClick={renameList}
          disabled={busy || !active}
          title="Rename this list"
        >
          Rename
        </button>
        <button
          className="term-wl-btn term-wl-danger"
          onClick={deleteList}
          disabled={busy || !active}
          title="Delete this list"
        >
          Delete
        </button>
      </div>

      {notice ? <div className="term-wl-notice">{notice}</div> : null}

      {rows.length === 0 ? (
        <div className="term-loading">
          {active
            ? `No tickers in ${active.name} — add one above, or ★ it ` +
              `from a company's DES.`
            : 'No list selected.'}
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 22 }}>#</th>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Day %</th>
              <th style={{ width: 28 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.ticker}
                className="term-row-link"
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.({ ticker: r.ticker, fn: 'DES' })}
                onKeyDown={rowKey(() =>
                  onOpen?.({ ticker: r.ticker, fn: 'DES' })
                )}
                title={`Open ${r.ticker} DES`}
              >
                <td className="rank">{i + 1}</td>
                <td className="sym">{r.ticker}</td>
                <td className="num">
                  <FlashPrice value={r.last}>{fmt.px(r.last)}</FlashPrice>
                </td>
                <td
                  className={`num ${
                    r.changePct == null
                      ? ''
                      : r.changePct >= 0
                      ? 'pos'
                      : 'neg'
                  }`}
                >
                  {fmt.pct(r.changePct)}
                </td>
                <td className="num">
                  <button
                    className="term-wl-x"
                    onClick={(e) => {
                      // Don't let the × bubble into the row's open-DES
                      // click.
                      e.stopPropagation();
                      removeTicker(r.ticker);
                    }}
                    disabled={busy}
                    title={`Remove ${r.ticker}`}
                    aria-label={`Remove ${r.ticker}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Saved to your profile · prices for the active list refresh live
        (~20s) while this panel is open. Click a row to open its DES ·
        ★ a company on its DES to add it to your default list.
      </div>
    </div>
  );
}
