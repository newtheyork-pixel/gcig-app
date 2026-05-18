# Terminal Live Quotes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` tracking.

**Goal:** Quote-bearing terminal panels (DES, Peers, MOVR/Movers, WEI) refresh on a gentle interval while the pane is open and the tab is visible, only for on-screen tickers — no background polling. Non-terminal Portfolio/Dashboard untouched.

**Architecture:** One shared `liveQuotes.js` (per-ticker TTL+coalesce cache over the proven Finnhub `/quote`), one `GET /terminal/quotes` route, one shared `useLiveRefresh` client hook; wire the four panels. Never-throws; honest labels; demand-driven so the free rate budget is bounded by construction.

**Tech Stack:** Node ESM, Express, `node:test`; React 18 + Vite client.

---

### Task 1: `liveQuotes.js` — per-ticker TTL/coalesce cache over Finnhub `/quote`

**Files:** Create `server/src/services/liveQuotes.js`, `server/src/services/liveQuotes.test.js`.

- [ ] Read `server/src/services/holdings.js` `fetchFinnhub` (the proven real-time `/quote` path + `FINNHUB_API_KEY` handling) and the cache patterns in `marketData.js`. Reuse the Finnhub quote logic; do not duplicate key handling.
- [ ] RED: `liveQuotes.test.js` with an **injected** quote fetcher (no network): assert `getLiveQuotes(['AAPL','MSFT'])` returns `{AAPL:{last,changePct,prevClose}, MSFT:{...}}`; per-ticker TTL — N calls within `QUOTE_TTL_MS` cause 1 upstream call/ticker, a call after TTL refetches; concurrent cold requests for the same ticker coalesce to 1 upstream call; never-throws on injected throw / `[]` / junk / non-array; a miss → that ticker is `null`.
- [ ] GREEN: implement `getLiveQuotes(tickers, deps={})` with `deps.quoteFetch` injectable, `QUOTE_TTL_MS=20000` constant, per-ticker `{at,value}` cache + in-flight promise map for coalescing, `_resetLiveQuotes()` export. Never throws.
- [ ] Full `npm test` green; `node --check`. Commit.

### Task 2: `GET /terminal/quotes` route

**Files:** Modify `server/src/routes/terminal.js`; test in a new `server/src/routes/terminal.quotes.test.js` (mirror the `terminal.execbios.test.js` direct-handler + injected-dep pattern).

- [ ] RED: handler returns `{ [T]: quote|null }` for `?tickers=A,B,C`; uppercases/validates; caps list at 40 (extra ignored); never 5xx if the service rejects (catch → `{}`); inherits the module-scope `verifyJwt→requireExecutive→aiLimiter` chain (structural assertion, like exec-bios).
- [ ] GREEN: thin handler over `getLiveQuotes`; `deps.getLiveQuotes` injectable for the test; try/catch → 200 `{}`.
- [ ] Full `npm test` green; `node --check`. Commit.

### Task 3: `useLiveRefresh` shared client hook

**Files:** Create `client/src/terminal/hooks/useLiveRefresh.js`.

- [ ] Read `client/src/pages/Tankers.jsx` (the self-rescheduling `setTimeout` poll + cancelled-flag pattern) and `client/src/api/client.js`.
- [ ] Implement `useLiveRefresh(fetchFn, { intervalMs=20000, enabled=true })`: immediate run then every `intervalMs`, ONLY while mounted AND `document.visibilityState==='visible'` AND `enabled`; `visibilitychange` listener pauses (hidden) / resumes (visible); cancels on unmount; a cancelled flag drops post-unmount/disable results; on fetch error keep last good `data` (no error wipe). Returns `{ data, loading, error, lastUpdated }`.
- [ ] `cd client && npm run build` → `✓ built`. Reason through + report: mount→immediate fetch; interval tick; tab hidden→pause, visible→resume; unmount mid-flight→no state write; enabled=false→idle; fetch reject→keeps last data. Commit.

### Task 4: Wire DES + Peers (LAST/CHG% live; fundamentals untouched; honest footers)

**Files:** Modify `client/src/terminal/functions/Description.jsx`, `client/src/terminal/functions/Peers.jsx`.

- [ ] DES: the ticker's LAST (and change) via `useLiveRefresh` over `GET /terminal/quotes?tickers=<ticker>`; remove the on-mount-only quote read; other DES content unchanged.
- [ ] Peers: focus ticker + comparables' LAST + CHG% via `useLiveRefresh`/`/terminal/quotes`, merged onto the existing rows; P/E, fwd P/E, mkt cap, div, beta stay the existing snapshot. Footer: drop "15m cache" for the live columns; state the real cadence.
- [ ] `npm run build` → `✓ built`; server `npm test` still green (no server change). Reason through both panels (live while open, stops when closed/hidden, fundamentals intact). Commit.

### Task 5: Wire Movers (live LAST/DAY% over sheet list) + WEI (while-visible refresh, honest label)

**Files:** Modify `client/src/terminal/functions/Movers.jsx` and the WEI panel component (the one rendering `/terminal/indices`).

- [ ] Movers: keep the sheet-derived holdings list; overlay live LAST + DAY% for those tickers via `useLiveRefresh`/`/terminal/quotes` (held tickers only, while open). Footer: remove "live from the positions sheet"; state real cadence + that holdings/positions are sheet-sourced.
- [ ] WEI: wrap its existing `/terminal/indices` fetch in `useLiveRefresh`; honest label (index data delayed by the free source — refreshes while open, not true real-time).
- [ ] `npm run build` → `✓ built`; server `npm test` green. Reason through. Commit.

### Task 6: Whole-feature review + finish

- [ ] Final adversarial review: never-throws end-to-end; the per-ticker TTL/coalesce genuinely bounds Finnhub usage; visibility-gating actually stops fetches on hide/close (no background poll); no regression to DES/Peers fundamentals or MOVR holdings list or non-terminal Portfolio/Dashboard; honest labels accurate (no false "live"); auth parity; suite + build green (controller verifies directly).
- [ ] finishing-a-development-branch → single merge to `main`.

---

## Self-review

- **Spec coverage:** service (T1), route (T2), hook (T3), DES+Peers (T4), Movers+WEI (T5), review/finish (T6) — every spec section maps to a task.
- **Placeholders:** none — TDD ground truth (cache/coalesce/visibility behaviors) is asserted by injected-dep tests / reasoned hook walkthrough, the correct discipline here, not a placeholder.
- **Type consistency:** `getLiveQuotes` → `{ [TICKER]: { last, changePct, prevClose } | null }` consumed identically by the route and (via the hook) by every panel; `useLiveRefresh` returns `{data,loading,error,lastUpdated}` everywhere; WEI keeps its existing `/terminal/indices` shape (hook only changes cadence).
