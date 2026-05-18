# Terminal — Demand-Driven Live Quotes (while-visible refresh)

- **Date:** 2026-05-18
- **Status:** Approved design (scope iterated with the user and locked;
  lead-dev autonomy — no per-doc review gate).
- **Scope:** Quote-bearing **terminal** panels show fresh Finnhub quotes
  that refresh on a gentle interval **only while the pane is open and the
  tab is visible**, only for the tickers currently on screen. No
  background polling. The non-terminal Portfolio page and Dashboard are
  explicitly OUT of scope (they keep the Google Sheet path).

## Why

The terminal's price panels are stale: MOVR/Movers and the portfolio
read price from the Google Sheet (`GOOGLEFINANCE`, ~20–40 min stale,
20-min server cache) and fetch on mount only; Peers' LAST/CHG% is a
15-min fundamentals snapshot; DES uses the real-time Finnhub `/quote`
but only once on mount; WEI fetches indices on mount only. The user
wants live quotes **where they're needed — i.e. the panel that's
pulled up — and nowhere else** ("do not be constantly pulling for
tickers that do not need it"). Finnhub `/quote` is real-time and
already proven from Render's IP (it backs DES today). The honest
constraint is the shared free-tier rate budget (~60 req/min, no batch
endpoint); demand-driven fetching (only on-screen tickers, only while
visible) keeps usage bounded by construction.

## Locked decisions

1. **Demand-driven, visibility-gated.** A panel fetches quotes only
   for the tickers it currently displays, only while it is mounted and
   `document` is visible. Closing/replacing the pane or hiding the tab
   stops the polling immediately. There is no global/background poller
   and no server-side scheduler.
2. **In scope (terminal panels):** DES, Peers, MOVR/Movers panel, WEI.
   **Out of scope:** the non-terminal Portfolio page and Dashboard —
   untouched, they remain on the sheet path (system-of-record surface).
3. **One shared server endpoint + one shared client hook.** No
   per-panel bespoke polling.
4. **MOVR holdings list still comes from the sheet;** only the *price*
   (LAST/DAY%) is overlaid live. Share counts / positions / AUM remain
   sheet-sourced (system of record).
5. **WEI is as live as the free index source allows.** WEI keeps its
   existing `/terminal/indices` source (Stooq + Finnhub ETF-proxy);
   "going live" for WEI = refreshing that endpoint on the
   while-visible interval instead of on-mount-only. It is labeled
   honestly (index data is delayed; no "LIVE" claim beyond the source).
6. **Honest labels.** Every touched panel's footer states the real
   refresh cadence. Remove the false "live from the positions sheet"
   (MOVR) and "15m cache" (Peers LAST/CHG%) wording.
7. **Never-throws / best-effort.** A missing quote → that row shows
   "—"; a failed fetch never breaks the panel (it keeps the last good
   values). Same contract as the rest of the terminal services.

## Architecture

### `server/src/services/liveQuotes.js` (new)
`getLiveQuotes(tickers[]) -> { [TICKER]: { last, changePct, prevClose }
| null }`. Reuses the proven Finnhub `/quote` fetch (the logic behind
`holdings.js` `fetchFinnhub`; factor/reuse, do not duplicate the key
handling). **Per-ticker shared in-memory cache** with a short TTL
(`QUOTE_TTL_MS`, default **20s**) keyed by ticker: a ticker is fetched
upstream at most once per TTL no matter how many panels/clients/poll
cycles request it (this is what bounds Finnhub usage). Never throws;
an upstream miss → that ticker maps to `null`. Concurrent requests for
the same cold ticker coalesce (in-flight promise reuse) so a burst of
panel mounts doesn't multiply calls.

### `server/src/routes/terminal.js` (modified)
`GET /terminal/quotes?tickers=A,B,C` → validates/uppercases, **caps the
list** (e.g. ≤ 40 — guards abuse; on-screen sets are far smaller),
returns `getLiveQuotes(list)`. Inherits the existing terminal-router
chain (`verifyJwt → requireExecutive → aiLimiter`) like every sibling
route — no per-route auth. Never 5xx (catch → `{}` honest empty).
`/terminal/indices` (WEI) is unchanged server-side; only its client
refresh cadence changes.

### `client/src/terminal/hooks/useLiveRefresh.js` (new)
`useLiveRefresh(fetchFn, { intervalMs, enabled })` — a shared
self-rescheduling poller (the `Tankers.jsx` setTimeout-reschedule
pattern, generalized): runs `fetchFn` immediately then every
`intervalMs` **only while** the component is mounted AND
`document.visibilityState === 'visible'` AND `enabled`. Pauses on
`visibilitychange` (hidden) and resumes on visible; cancels cleanly on
unmount; drops in-flight results after unmount/disable (cancelled
flag). Returns `{ data, loading, error, lastUpdated }`. Quote panels
use it with a `/terminal/quotes` fetch over their on-screen tickers;
WEI uses it with its existing `/terminal/indices` fetch.

### Client wiring (modified, minimal per panel)
- **DES** (`Description.jsx`): its single ticker's LAST via
  `useLiveRefresh`; replaces the on-mount-only quote read. Other DES
  fundamentals stay as-is.
- **Peers** (`Peers.jsx`): LAST + CHG% columns for the focus ticker +
  comparables via `useLiveRefresh`/`/terminal/quotes`; the fundamentals
  (P/E, fwd P/E, mkt cap, div, beta) remain the existing snapshot.
  Footer wording corrected.
- **Movers** (`Movers.jsx`): keep the sheet-derived holdings *list*;
  overlay live LAST + DAY% for those tickers via `useLiveRefresh`.
  Footer no longer claims "live from the positions sheet."
- **WEI** (`WorldIndices`/whatever renders `/terminal/indices`):
  wrap its existing fetch in `useLiveRefresh`; honest cadence label.

## Data flow

```
panel mounts (pane open) ─► useLiveRefresh(enabled & visible)
   ├─ quote panels ─► GET /terminal/quotes?tickers=<on-screen> ─► liveQuotes.js ─► Finnhub /quote (≤1 upstream / ticker / TTL)
   └─ WEI          ─► GET /terminal/indices (unchanged source) ─► Stooq/Finnhub-proxy
pane closed / tab hidden ─► poller paused/cancelled ─► zero further fetches
```

## Rate-budget reasoning (honest)

Finnhub free ≈ 60 req/min, shared with DES/Peers fundamentals, news,
earnings (all long-cached, low rate). The per-ticker shared cache makes
upstream calls = (unique on-screen tickers) ÷ TTL, independent of
client/panel count. Worst realistic case: DES(1) + Peers(~7) +
MOVR(~9) open simultaneously ≈ ~15 unique tickers (overlap reduces
this). At a 20s TTL → ~45 upstream calls/min worst case, leaving
headroom under 60 for the long-cached rest. TTL is a single tunable
constant; if real usage proves tight, raising TTL trades a few seconds
of latency for budget — documented, not hidden. WEI uses its own
non-Finnhub source so it does not consume this budget.

## Error handling

`getLiveQuotes` never throws (miss → `null` per ticker); the route
catches → `{}`; `useLiveRefresh` keeps the last good `data` on a failed
poll (panel shows last values, not an error wipe) and never throws out
of the effect. Cancelled flag prevents post-unmount state writes.
Visibility gating is the rate-safety net; the cap is the abuse net.

## Testing & verification

- `liveQuotes.js`: `node:test` with an **injected** Finnhub fetch (no
  network). Assert: returns quotes for requested tickers; per-ticker
  TTL cache (one upstream call across N requests within TTL; refetch
  after TTL); in-flight coalescing; never-throws on inject-throw /
  empty / junk; honest `null` on miss.
- `/terminal/quotes` route: returns shape, caps the list, never 5xx on
  service reject, inherits auth (structural, like the exec-bios test).
- Client: `npm run build` green; the hook's visibility/cancel/unmount
  behavior reasoned through explicitly (no client test harness exists —
  same bar as prior client tasks). Full server `npm test` green.
- Honest caveat (standing): live Finnhub from Render's IP is only
  fully confirmable in prod (same class as proxy/GSAM) — not
  overclaimed.

## Build

One feature branch, TDD, subagent-driven. Tasks:
1. `liveQuotes.js` + per-ticker TTL/coalesce cache + tests.
2. `GET /terminal/quotes` route + tests.
3. `useLiveRefresh` shared hook.
4. Wire DES + Peers (LAST/CHG% live; fundamentals untouched; footers).
5. Wire Movers (live LAST/DAY% over sheet list; footer) + WEI
   (while-visible refresh; honest label).
6. Whole-feature review + finishing-a-development-branch (one merge).

## Open items / risks

- react-mosaic panes are visible tiles; "mounted ≈ visible" holds.
  `document.hidden` covers the tab-backgrounded case. If a future
  layout can keep a pane mounted-but-hidden, the visibility gate would
  need a pane-level signal — noted, not needed today.
- WEI freshness is capped by Stooq/Finnhub-proxy (indices are not true
  real-time on free sources). Labeled honestly; not a defect.
- Non-terminal Portfolio/Dashboard intentionally excluded — their
  stale-sheet behavior is unchanged and out of scope by user decision.
