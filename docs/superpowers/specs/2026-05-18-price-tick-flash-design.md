# Terminal — Bloomberg-style Price Tick Flash

- **Date:** 2026-05-18
- **Status:** Approved (small polish on the just-shipped live-quotes
  feature; reference behavior unambiguous; lead-dev autonomy).
- **Scope:** When a live-refreshed price changes, the price cell
  briefly flashes (green = uptick, red = downtick) then fades back to
  normal — the classic Bloomberg tick flash. Pure client; builds on
  the merged live-quotes infra (`useLiveRefresh` + wired panels). No
  server change, no data-cadence change.

## Why

Live numbers that silently change don't read as live. Bloomberg flashes
the price cell on each tick so the eye catches movement. The data
already refreshes (~20s, demand-driven, merged in PR #28); this adds
the visual feedback that makes it *feel* live.

## Locked decisions

1. **Flash the LAST/price cell only.** That is the iconic Bloomberg
   behavior and what the user pointed at ("the change in prices").
   CHG%/DAY% cells already convey direction via persistent color;
   flashing them too is a trivial later extension if wanted, not v1.
2. **Background flash, fading out.** Cell background pulses
   green (up) / red (down) at full-ish opacity then transitions back
   to transparent over ~0.9s (Bloomberg-accurate). Not a text-color
   swap.
3. **No spurious flashes.** No flash on the first observed value (no
   prior to compare), and none when the value is unchanged between
   refreshes. A panel remount starts fresh (first value = no flash),
   so closing/reopening a pane never flashes on load.
4. **Per-ticker correctness.** Rows are keyed by ticker, so a per-row
   hook instance naturally tracks *that ticker's* previous value
   across renders even if rows reorder — compare same-ticker
   old→new, never positional.
5. **Accessibility.** Respect `prefers-reduced-motion`: when set, no
   animation (the number still updates; just no flash). Never throws /
   never blocks the render — a flash is decorative; the value must
   always show regardless.
6. **No cadence change / honest.** This visualizes the existing ~20s
   refresh; it does not imply sub-second streaming. No label claims
   "real-time"; the existing honest footers stand.

## Architecture

### `client/src/terminal/hooks/usePriceFlash.js` (new)
`usePriceFlash(value) -> 'up' | 'down' | null`. Holds the previous
numeric value in a ref; on change, sets a transient direction state
(`up` if new > old, `down` if new < old) and a timer that clears it
after the flash duration (~900ms) so the class is removed and the
cell can flash again on the next change. First non-null value: record
it, return `null` (no flash). Unchanged / null / NaN: return `null`.
Cleans the timer on unmount. Pure, no throw.

### `client/src/terminal/theme.css` (modified)
Add `@keyframes term-tick-up` / `term-tick-down` (background-color
from a green/red wash → transparent) and `.tick-up` / `.tick-down`
classes applying the animation (~0.9s ease-out, one iteration). Wrap
in `@media (prefers-reduced-motion: reduce) { .tick-up,.tick-down {
animation: none } }`. Use existing terminal color tokens where
sensible; the wash is a low-alpha green/red so text stays readable.

### Wiring (modified, minimal per panel)
The LAST/price cell in each now-live panel gets
`className={... usePriceFlash(liveLast) ...}` mapped to
`tick-up`/`tick-down`/none:
- `client/src/terminal/functions/Movers.jsx` — per-row LAST cell.
- `client/src/terminal/functions/Peers.jsx` — per-row LAST cell.
- `client/src/terminal/functions/Description.jsx` — DES LAST/price.
- `client/src/terminal/functions/WorldIndices.jsx` — per-row level.
The compared value is the live numeric `last` (DES/Peers/Movers) /
index level (WEI) already rendered. Snapshot→first-live swap does not
flash (first observed value rule).

## Testing & verification

No client test harness (same bar as prior client tasks): `npm run
build` green; reason through — first render no flash; uptick→green
fade; downtick→red; unchanged→none; null/NaN→none; reduced-motion→no
animation but value updates; ticker reorder uses per-row keying so no
mis-flash; remount→first value no flash. Server `npm test` unaffected
(no server change) — confirm still green.

## Build

One follow-up branch `feat/price-tick-flash` off the merged main, one
focused implementer (it's a single cohesive task: hook + CSS + four
small cell wirings), controller verifies + opens a PR.
