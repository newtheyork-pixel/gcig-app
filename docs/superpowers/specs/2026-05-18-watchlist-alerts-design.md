# Watchlist Alerts — Per-User Price/%-Move Alerts

- **Date:** 2026-05-18
- **Status:** Approved (batch "build everything" — lightweight design
  the user approved; lead-dev autonomy; sub-project 7 of 7; stacked
  on `feat/watchlist-build` so it has the Watchlist feature).
- **Scope:** A user can set price / %-move alert rules on tickers; an
  in-app popup fires when a rule is crossed. Persisted per profile.
  Reuses the live-quote infra + the app's existing in-app
  notification pattern. Additive.

## Why

Watchlist users want to be told when a name hits a level, not have to
stare at it. The app already has a global in-app notification pattern
(`PitchNotification`/`VoteNotification` — Layout-mounted pollers that
show a popup) and a rate-bounded `/terminal/quotes`. Compose them.

## Locked decisions (honest)

1. **Evaluation is client-side, while the user has the app open** —
   a global Layout-mounted poller fetches the user's active alerts +
   `/terminal/quotes` for their alert tickers on a gentle interval,
   evaluates crossings in the browser, and fires the popup. **No
   server cron / no push when logged out.** Rationale: a server-side
   evaluator polling Finnhub for every user's tickers would blow the
   free 60-rpm budget and add infra; the app's existing notifications
   work exactly this way (client poll while logged in). This
   limitation is stated in the spec, the UI, and to the user — not
   hidden.
2. Per-user alert **rules** table (independent of which watchlist a
   ticker is in — a rule is just user+ticker+condition). Cascade from
   User. Hand-authored migration (no local DB).
3. A fired alert records `lastFiredAt` server-side and the rule
   **deactivates** after firing (one-shot; user re-arms if wanted) so
   it can't re-spam every poll. Owned-by-`req.user.id` on every op
   (same invariant discipline as Watchlist's `ownedList`).
4. Reuse: `/terminal/quotes` for prices (no new fetch), the existing
   notification-component pattern for the popup, the Watchlist panel
   for create/list/delete UI. Never-throws/never-5xx; honest states.

## Architecture

### DB — `server/prisma/schema.prisma` (new model + back-relation)
```prisma
model WatchlistAlert {
  id          Int      @id @default(autoincrement())
  userId      Int
  ticker      String
  metric      String   // 'price' | 'pct'   (pct = day % change)
  direction   String   // 'above' | 'below'
  threshold   Float
  active      Boolean  @default(true)
  lastFiredAt DateTime?
  createdAt   DateTime @default(now())
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
}
```
`User` gets `watchlistAlerts WatchlistAlert[]`. Hand-authored
migration dir `<UTC ts after the watchlists migration>_add_watchlist_alerts/migration.sql`
mirroring the `president_review`/watchlists migration SQL conventions;
`npx prisma generate`; eyeball schema↔SQL parity. (Standing no-DB
limitation: only truly applies on Render `migrate deploy`.)

### Server — `server/src/routes/alerts.js` (new), mounted `/api/alerts`
`router.use(verifyJwt)`, deps-injectable prisma (DB-free tests),
ticker validated/uppercased (existing regex). Mirror
`watchlist.js`'s per-user scoping + never-5xx shape.
- `GET /api/alerts` → the caller's alerts (`where:{userId:req.user.id}`).
- `POST /api/alerts` `{ ticker, metric, direction, threshold }` →
  validate (`metric∈{price,pct}`, `direction∈{above,below}`,
  finite threshold), cap ≤50 active alerts/user → create → list.
- `DELETE /api/alerts/:id` → owned-check (`alert.userId===req.user.id`
  else 404, same indistinguishability as Watchlist) → delete → list.
- `PATCH /api/alerts/:id` `{ active }` → owned-check → toggle (re-arm).
- `POST /api/alerts/:id/fired` → owned-check → set `lastFiredAt=now`,
  `active=false` (one-shot). Idempotent.
Every query hard-scoped by `userId:req.user.id`. Per-handler
try/catch → never 5xx (degrade-to-200 honest, the established
`/quotes`/watchlist precedent). Mount in `index.js` next to siblings.

### Client
- `client/src/components/WatchlistAlertNotification.jsx` (new),
  mounted in `Layout.jsx` exactly like `PitchNotification`/
  `VoteNotification` (study those: a logged-in-only, interval poller
  rendering a dismissible popup). Loop (~30–60s, only when
  `useAuth().user`): `GET /api/alerts` (active only) → if any, `GET
  /terminal/quotes?tickers=<their tickers>` → evaluate each rule
  (`price`: last vs threshold by direction; `pct`: day % vs
  threshold) → for each crossed rule: show the popup (reuse the
  existing notification popup styling/dismiss) and `POST
  /api/alerts/:id/fired` (so it deactivates, no re-spam). Visibility/
  cancel hygiene like `useLiveRefresh` (don't poll a hidden tab;
  cancelled-guard). Degrade silently on any failure (never blocks the
  app). Honest popup copy ("AAPL crossed $190 (now $190.4)").
- Alert management UI in `client/src/terminal/functions/Watchlist.jsx`
  (on this branch): a small per-row "＋ alert" affordance (pick
  price/pct + above/below + threshold) and a compact list of the
  active alerts with an `×` to delete / a toggle to re-arm. Reuse the
  shared `api`. Keep it lean; the heavy lifting is the rules table +
  the global notifier.

## Data flow

```
user sets a rule (Watchlist panel) → POST /api/alerts (userId-scoped, capped)
Layout poller (logged-in, tab visible): GET /api/alerts(active) → GET /terminal/quotes(their tickers)
   → crossing? → in-app popup  +  POST /api/alerts/:id/fired (deactivate, dedupe)
persisted per userId; evaluated only while the app is open (honest limit)
```

## Error handling

Hard user-scoping (owned-check 404, indistinguishable); validation +
caps; per-handler try/catch never 5xx; the notifier degrades silently
on any error and never blocks the app; one-shot + `lastFiredAt`
prevents popup spam; reuses the rate-bounded `/terminal/quotes` (no
new external exposure). Honest, repeatedly-stated limitation: alerts
evaluate **only while the user has the app open** (no logged-out
push) — by free-tier design.

## Testing

- Server: `alerts.test.js` (injected prisma stub, no DB) mirroring
  `watchlist.test.js`: per-user scoping + owned-check 404 across
  DELETE/PATCH/fired by foreign id; validation (metric/direction/
  threshold) → 4xx; cap ≤50; `/fired` sets lastFiredAt+active=false
  idempotently; `verifyJwt` enforced; never-5xx on bad input/stub
  reject. Full `cd server && npm test` green (baseline on this branch
  is 125 → +N). `node --check`; `npx prisma generate` ok; schema↔SQL
  parity eyeballed.
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  harness): logged-out → notifier idle; logged-in poll → no alerts
  noop; a crossing fires popup once + marks fired (no re-spam next
  poll); hidden tab pauses; failures degrade silently; Watchlist
  alert-management create/list/delete/re-arm; honest copy.

## Build

Stacked on `feat/watchlist-build` (has Watchlist) — TDD, subagent-
driven. Delivered in the SAME combined Watchlist+Alerts PR (one merge,
dependency satisfied). Single focused implementer (schema + migration
+ alerts route + mount + tests, then Layout notifier + Watchlist
mgmt UI).
