import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

// Inline styles for the alert-management affordance. The terminal's
// CSS variables are global, so referencing them inline keeps the new
// surface on-theme without adding a stylesheet (the W panel's existing
// .term-wl-btn / .term-wl-x / .term-wl-notice classes cover the
// buttons; only these few containers/selects need styling).
const ALERT_STYLE = {
  editor: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    border: '1px solid var(--term-border)',
    padding: '6px 8px',
  },
  lead: {
    color: 'var(--term-fg-dim)',
    fontSize: 11,
    letterSpacing: '0.06em',
  },
  field: {
    background: 'transparent',
    color: 'var(--term-fg)',
    border: '1px solid var(--term-border)',
    font: 'inherit',
    fontSize: 12,
    padding: '3px 6px',
  },
  thresh: { width: 90 },
  section: {
    marginTop: 10,
    borderTop: '1px solid var(--term-border)',
    paddingTop: 8,
  },
  sectionHead: {
    color: 'var(--term-fg-dim)',
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '3px 0',
  },
  desc: { flex: 1, minWidth: 0, color: 'var(--term-fg)' },
  stateOn: {
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--term-positive)',
  },
  stateOff: {
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--term-fg-muted)',
  },
};

export default function Watchlist({ onOpen }) {
  const [lists, setLists] = useState(null); // null = not loaded yet
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null); // hard load failure
  const [authMissing, setAuthMissing] = useState(false);
  const [notice, setNotice] = useState(''); // soft, transient op notice
  const [tickerInput, setTickerInput] = useState('');
  const [busy, setBusy] = useState(false); // a mutation is in flight

  // ── Price/%-move alerts ──────────────────────────────────────────
  // A lean affordance on top of the list: the user's alert rules
  // (independent of any list — see /api/alerts), an inline editor a
  // row's "+ alert" opens, and a compact rule list with delete /
  // re-arm. The substance of the feature is the global Layout poller;
  // this is just the create/list/manage surface, so it stays small
  // and degrades to a soft notice exactly like the list controls.
  const [alerts, setAlerts] = useState([]);
  const [alertFor, setAlertFor] = useState(null); // ticker the editor is open for
  const [alertMetric, setAlertMetric] = useState('price');
  const [alertDir, setAlertDir] = useState('above');
  const [alertThresh, setAlertThresh] = useState('');
  const [alertNotice, setAlertNotice] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);

  const loadAlerts = useCallback(async () => {
    try {
      const { data } = await api.get('/alerts');
      setAlerts(Array.isArray(data?.alerts) ? data.alerts : []);
    } catch {
      // Never-5xx route; a hard failure just leaves the section
      // empty — the global poller is unaffected, this is only the
      // management view.
      setAlerts([]);
    }
  }, []);

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
    loadAlerts();
  }, [load, loadAlerts]);

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

  // Open the inline alert editor for one ticker. Toggling the same
  // ticker closes it; defaults reset each open so the form is never
  // stale from a previous row. Closing-vs-opening is decided off the
  // current `alertFor` (not inside a setState updater) so the form
  // resets stay plain, idempotent setter calls.
  const openAlertEditor = useCallback(
    (ticker) => {
      setAlertNotice('');
      if (alertFor === ticker) {
        setAlertFor(null);
        return;
      }
      setAlertMetric('price');
      setAlertDir('above');
      setAlertThresh('');
      setAlertFor(ticker);
    },
    [alertFor]
  );

  // One wrapper for every alert mutation: guards concurrent ops, then
  // re-reads the rule list from /alerts (its own source of truth) on
  // success, and turns the never-5xx degraded shape or a thrown 4xx
  // into the same soft inline notice — nothing is ever lost.
  const alertMutate = useCallback(
    async (fn, fallbackMsg) => {
      if (alertBusy) return false;
      setAlertBusy(true);
      setAlertNotice('');
      try {
        const { data } = await fn();
        if (Array.isArray(data?.alerts)) {
          setAlerts(data.alerts);
          return true;
        }
        setAlertNotice(data?.error || fallbackMsg);
        return false;
      } catch (e) {
        setAlertNotice(
          e.response?.data?.error || e.message || fallbackMsg
        );
        return false;
      } finally {
        setAlertBusy(false);
      }
    },
    [alertBusy]
  );

  const createAlert = useCallback(async () => {
    if (!alertFor) return;
    const t = String(alertFor).toUpperCase();
    const threshold = Number(alertThresh);
    if (alertThresh.trim() === '' || !Number.isFinite(threshold)) {
      setAlertNotice('Enter a numeric threshold.');
      return;
    }
    const ok = await alertMutate(
      () =>
        api.post('/alerts', {
          ticker: t,
          metric: alertMetric,
          direction: alertDir,
          threshold,
        }),
      'Could not create that alert.'
    );
    if (ok) {
      setAlertFor(null);
      setAlertThresh('');
    }
  }, [alertFor, alertThresh, alertMetric, alertDir, alertMutate]);

  const deleteAlert = useCallback(
    (id) =>
      alertMutate(
        () => api.delete(`/alerts/${id}`),
        'Could not delete that alert.'
      ),
    [alertMutate]
  );

  // Re-arm a fired/disabled rule or disable an armed one. The server
  // caps *active* rules, so a re-arm can 409 if the user is already at
  // the cap — that surfaces as the soft notice, not a thrown error.
  const toggleAlert = useCallback(
    (id, next) =>
      alertMutate(
        () => api.patch(`/alerts/${id}`, { active: next }),
        'Could not update that alert.'
      ),
    [alertMutate]
  );

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
              <th style={{ width: 64 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.ticker}>
                <tr
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
                        // Don't let the alert toggle bubble into the
                        // row's open-DES click.
                        e.stopPropagation();
                        openAlertEditor(r.ticker);
                      }}
                      disabled={alertBusy}
                      title={`Set a price/%-move alert on ${r.ticker}`}
                      aria-label={`Set an alert on ${r.ticker}`}
                    >
                      🔔
                    </button>
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
                {alertFor === r.ticker && (
                  <tr>
                    <td colSpan={5} style={{ padding: '6px 8px' }}>
                      <div style={ALERT_STYLE.editor}>
                        <span style={ALERT_STYLE.lead}>
                          Alert {r.ticker}
                        </span>
                        <select
                          style={ALERT_STYLE.field}
                          value={alertMetric}
                          onChange={(e) => setAlertMetric(e.target.value)}
                          disabled={alertBusy}
                          aria-label="Alert metric"
                        >
                          <option value="price">price</option>
                          <option value="pct">day %</option>
                        </select>
                        <select
                          style={ALERT_STYLE.field}
                          value={alertDir}
                          onChange={(e) => setAlertDir(e.target.value)}
                          disabled={alertBusy}
                          aria-label="Alert direction"
                        >
                          <option value="above">above</option>
                          <option value="below">below</option>
                        </select>
                        <input
                          style={{
                            ...ALERT_STYLE.field,
                            ...ALERT_STYLE.thresh,
                          }}
                          value={alertThresh}
                          onChange={(e) => setAlertThresh(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              createAlert();
                            }
                          }}
                          placeholder={
                            alertMetric === 'price' ? 'e.g. 190' : 'e.g. -3'
                          }
                          inputMode="decimal"
                          disabled={alertBusy}
                          spellCheck={false}
                          aria-label="Alert threshold"
                        />
                        <button
                          className="term-wl-btn"
                          onClick={createAlert}
                          disabled={alertBusy || !alertThresh.trim()}
                        >
                          SET
                        </button>
                        <button
                          className="term-wl-btn"
                          onClick={() => setAlertFor(null)}
                          disabled={alertBusy}
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {/* The caller's alert rules — independent of which list a ticker
          is on. Compact: each rule, a re-arm/disable toggle, and a ×.
          The substance is the global Layout poller that evaluates
          these; this is just the management view, so it stays lean and
          honest about the only-while-open reality. */}
      {alerts.length > 0 && (
        <div style={ALERT_STYLE.section}>
          <div style={ALERT_STYLE.sectionHead}>
            Alerts · {alerts.filter((a) => a.active).length} armed ·
            checked only while this app is open
          </div>
          {alerts.map((a) => (
            <div key={a.id} style={ALERT_STYLE.row}>
              <span style={ALERT_STYLE.desc}>
                <span className="sym">{a.ticker}</span>{' '}
                {a.metric === 'pct' ? 'day %' : 'price'} {a.direction}{' '}
                {a.threshold}
                {a.metric === 'pct' ? '%' : ''}
              </span>
              <span
                style={a.active ? ALERT_STYLE.stateOn : ALERT_STYLE.stateOff}
              >
                {a.active ? 'armed' : 'fired'}
              </span>
              <button
                className="term-wl-btn"
                onClick={() => toggleAlert(a.id, !a.active)}
                disabled={alertBusy}
                title={a.active ? 'Disable this alert' : 'Re-arm this alert'}
              >
                {a.active ? 'Disable' : 'Re-arm'}
              </button>
              <button
                className="term-wl-x"
                onClick={() => deleteAlert(a.id)}
                disabled={alertBusy}
                title="Delete this alert"
                aria-label={`Delete ${a.ticker} alert`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {alertNotice ? (
        <div className="term-wl-notice">{alertNotice}</div>
      ) : null}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Saved to your profile · prices for the active list refresh live
        (~20s) while this panel is open. Click a row to open its DES ·
        ★ a company on its DES to add it to your default list · 🔔 sets
        a price/%-move alert. Alerts are one-shot (they disable after
        firing — re-arm them here) and are only checked while you have
        the app open in a tab — there is no logged-out push.
      </div>
    </div>
  );
}
