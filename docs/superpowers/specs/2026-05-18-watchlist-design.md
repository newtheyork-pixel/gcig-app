# Terminal — Per-User Multiple Watchlists

- **Date:** 2026-05-18
- **Status:** Approved (user approved the design + "allow multiple
  watchlists"; lead-dev autonomy on realization details).
- **Scope:** A logged-in user can keep **multiple named watchlists** of
  tickers, persisted per profile (survives logout/reload). Surfaced as
  a new terminal panel that reuses the shipped live-quotes + tick-flash
  infra; tickers can also be added from DES. Terminal-only (no main-app
  widget in v1). Pure additive feature.

## Why

There is no way to track an ad-hoc set of tickers today (portfolio is
the Google-Sheet book of record; pitches are role-gated). Users want a
personal, durable, multi-list watchlist. The terminal just gained
demand-driven live quotes + Bloomberg tick-flash + click-to-DES — a
watchlist panel reuses all of it for near-zero marginal cost.

## Locked decisions

1. **Multiple named lists per user** (not a single flat list).
   Two-table relational model mirroring the project's per-user
   persistence pattern (e.g. PresidentReview).
2. **Lazy default list.** If the user has zero lists, the API creates
   one named `Watchlist` and returns it. Deleting the last list is
   allowed; the next load respawns the default. The panel is never
   permanently empty of lists.
3. **Default list** = the user's earliest list (lowest `createdAt` /
   `id`). The DES ★ targets this list. No per-list picker on DES in
   v1 (clean later extension); multi-list organizing is the panel's
   job.
4. **Only the active list is live-polled.** The panel live-refreshes
   quotes for the currently-selected list's tickers only (the existing
   demand-driven, visibility-gated hook). Non-active lists are not
   fetched. Caps: **≤20 lists/user, ≤50 tickers/list** — bounds the
   live-quote fan-out within the rate discipline already built.
5. **Security invariant:** every list/item read or mutation is scoped
   by `req.user.id`; any operation on a list id whose
   `watchlist.userId !== req.user.id` → 404 (honest, never reveals or
   touches another user's data). All routes `verifyJwt`.
6. **Never-throws / never-5xx / honest** server contract; client keeps
   last-good on a failed live poll; honest empty/auth states. No
   fabricated data.
7. **Terminal-only, additive.** No change to portfolio/Sheet, no
   main-app widget, no change to existing panels except a small DES ★
   toggle.

## Architecture

### DB — `server/prisma/schema.prisma` (new models + back-relation)
```prisma
model Watchlist {
  id        Int             @id @default(autoincrement())
  userId    Int
  name      String
  createdAt DateTime        @default(now())
  user      User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  items     WatchlistItem[]
  @@unique([userId, name])
  @@index([userId])
}

model WatchlistItem {
  id          Int       @id @default(autoincrement())
  watchlistId Int
  ticker      String
  addedAt     DateTime  @default(now())
  watchlist   Watchlist @relation(fields: [watchlistId], references: [id], onDelete: Cascade)
  @@unique([watchlistId, ticker])
  @@index([watchlistId])
}
```
`User` gets `watchlists Watchlist[]`. One migration `add_watchlists`
(Render auto-runs `prisma migrate deploy` on deploy, per CLAUDE.md).

### Server — `server/src/routes/watchlist.js` (new), mounted `/api/watchlist`
All routes `verifyJwt`; a shared `ownedList(userId, id)` helper loads a
list and returns null unless `userId` matches (→ caller responds 404).
Ticker normalized/validated with the same convention as the terminal
routes (uppercase, `^[A-Z0-9.\-]{1,12}$`).

- `GET /api/watchlist` → `{ lists: [{ id, name, createdAt, items:
  [{ ticker, addedAt }] }] }`, ordered by `createdAt`. **Lazily
  creates** the default `Watchlist` list if the user has none, then
  returns it.
- `POST /api/watchlist/lists` `{ name }` → trimmed non-empty name,
  unique per user (collision → 409 honest), cap ≤20 lists → returns
  the created list. Returns the full `{ lists }` for client simplicity.
- `PATCH /api/watchlist/lists/:id` `{ name }` → rename (owned check,
  unique-per-user) → `{ lists }`.
- `DELETE /api/watchlist/lists/:id` → owned check, delete (items
  cascade) → `{ lists }` (possibly empty; next GET respawns default).
- `POST /api/watchlist/lists/:id/items` `{ ticker }` → owned check,
  validate/uppercase ticker, idempotent upsert on
  `@@unique([watchlistId,ticker])` (re-add is a no-op success), cap
  ≤50 items → `{ lists }`.
- `DELETE /api/watchlist/lists/:id/items/:ticker` → owned check,
  remove (absent = no-op success) → `{ lists }`.
Every handler try/catch → never 5xx; benign/idempotent inputs succeed;
ownership/auth failures are honest 4xx. Mounted in `server/src/index.js`
next to the other `/api/*` routers.

### Client — `client/src/terminal/functions/Watchlist.jsx` (new) + registry
`registry.js`: `{ id:'W', label:'Watchlist', help:'Your saved ticker
lists, live.', requires:null, component:Watchlist }` (no ticker needed
to open).

Panel behavior:
- On mount `GET /api/watchlist` → `lists`. Track an active list id
  (default = first list). A compact list selector (tabs; dropdown if
  it overflows) + `+ New`, rename, delete-list controls. An
  add-ticker input acting on the active list.
- The active list's tickers feed `useLiveRefresh(() =>
  api.get('/terminal/quotes',{params:{tickers}}), { enabled:
  tickers.length>0 })` — the exact Movers pattern. Rows render
  ticker + last + chg% via `<FlashPrice>`; row click →
  `onOpen({ ticker, fn:'DES' })`; each row has an `×` to remove.
- All list/item mutations call the API then refresh `lists` from the
  response (single source of truth); keep last-good live quotes on a
  failed poll (hook already does). Honest empty states ("No tickers in
  <list> — add one, or ★ it from a company's DES"; auth-missing
  message if unauthenticated).
- Only the active list is ever passed to the live-quote fetch.

### Client — DES ★ toggle (`client/src/terminal/functions/Description.jsx`)
A small star control showing whether the DES ticker is in the user's
**default list**. Click toggles via `POST`/`DELETE
/api/watchlist/lists/:defaultId/items[/:ticker]`. It first ensures the
default list id (from `GET /api/watchlist`, lazily-created). State
label: `★ In <listName>` / `☆ Watchlist`. Self-contained; no other
DES behavior changes; never blocks DES render on watchlist failure
(honest, silent-degrade the star only).

## Data flow

```
open W → GET /api/watchlist (lazy-default) → lists → pick active
       → active tickers → useLiveRefresh → /terminal/quotes (only while pane open+visible)
       → FlashPrice rows → click → DES
add/remove/list-CRUD → POST/PATCH/DELETE /api/watchlist… (owned+capped) → {lists} → re-render
DES ★ → ensure default list → POST/DELETE item → reflect state
persisted in Postgres by userId → per-profile, durable
```

## Error handling

Server: `ownedList` gate (404 on not-owned/not-found), ticker
validation, idempotent add/remove, unique-name 409, caps 400/409,
per-handler try/catch → never 5xx. Client: failed live poll keeps
last-good (hook); failed list/item op → honest inline message, no data
loss, panel stays usable; DES ★ degrades silently if watchlist
unreachable. Live Finnhub-from-Render only fully prod-confirmable
(standing limitation; the watchlist quote path is the existing
`/terminal/quotes`).

## Testing & verification

- `watchlist.js` route tests (`node:test`, mirroring the project's
  injected-deps route-test style — e.g. `terminal.quotes.test.js` /
  exec-bios pattern; inject a prisma-like stub): per-user + per-list
  ownership scoping (cannot touch another user's list by id →
  404), lazy-default creation on empty GET, idempotent item add,
  dedupe via unique key, list cap (≤20) and item cap (≤50),
  unique-name enforcement + rename, delete cascade, auth required,
  never-5xx on benign/edge input.
- Client: `npm run build` green; reason through (no client harness,
  consistent with prior client tasks): list switch, add/remove,
  new/rename/delete list, active-only polling, FlashPrice + click-to-
  DES intact, honest empty/auth states, DES ★ toggle reflects
  membership and degrades gracefully.
- `prisma migrate` applies cleanly; full server `npm test` green.

## Build

One feature branch off the merged main, TDD, subagent-driven. Tasks:
1. Prisma `Watchlist`/`WatchlistItem` + `User` back-relation +
   migration; `node --check`/generate + suite green.
2. `watchlist.js` routes + mount + tests (ownership, lazy-default,
   caps, idempotency, never-5xx).
3. `Watchlist.jsx` panel + `registry.js` entry (list selector,
   add/remove, list CRUD, live-quote+flash rows, click-to-DES).
4. DES ★ toggle.
5. Whole-feature adversarial review + finishing-a-development-branch
   (one PR for the user to merge, per the established flow).

## Open items / risks

- Auto-creating the default list is a write on a GET — acceptable
  (idempotent, user-scoped, bounded); documented so it isn't a
  surprise.
- Sheet/portfolio and pitches are intentionally untouched — watchlist
  is a separate personal concept, no dedupe/merge with them.
- Per-list picker on the DES ★ is deliberately out of v1 (default-list
  only); multi-list organizing is the panel's role.
