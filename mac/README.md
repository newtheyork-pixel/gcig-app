# Griffin Terminal — macOS

A native Mac client for the terminal. SwiftUI, no web view, talks to the
same `gcig-api` as the browser.

It lives inside the `gcig-app` repo on purpose. The panels are defined by
what the API returns, so when a route changes, the Swift that reads it is
one directory away rather than in a repo somebody forgets to update.
Render only builds `client/` and `server/`, so nothing here affects the
deploy.

## Build

```
cd mac
swift build            # compile
swift test             # parser conformance against the web parser
./build.sh release     # produces build/Griffin Terminal.app
```

Requires Xcode (for the macOS SDK) and Swift 6; runs on macOS 15+
(WindowDragGesture on popped-out windows is the floor). No third-party
packages, so there is nothing to resolve and no lockfile to drift.

## Signing

`build.sh` applies an ad-hoc signature, which is enough to run on the
machine that built it. To produce something that opens on another Mac
without the quarantine warning, sign with a Developer ID on a machine
that holds the certificate:

```
codesign --force --deep --options runtime \
  --sign "Developer ID Application: <NAME> (<TEAMID>)" \
  "build/Griffin Terminal.app"

xcrun notarytool submit "build/Griffin Terminal.app" \
  --apple-id <APPLE_ID> --team-id <TEAMID> --keychain-profile <PROFILE> --wait

xcrun stapler staple "build/Griffin Terminal.app"
```

`security find-identity -v -p codesigning` lists the identities available
on that machine. Nothing in this repo needs the certificate, so the
signing step is the only part that has to happen where the credentials
live.

## Pointing it somewhere else

```
GRIFFIN_API=http://localhost:4000/api ./build.sh release
```

Read once at launch from the environment; defaults to production.

## Auth

"Sign in with browser" is the primary path: the app opens
thegriffinfund.org/native-auth, you sign in there however you normally
do — Google, password, 2FA — and the page hands back a single-use
90-second code the app trades for a token. The code crosses in the
URL; the JWT never does. Password sign-in stays folded away in the app
as the fallback for when the handoff itself is broken.

The JWT goes in the **Keychain**, not UserDefaults — it is a bearer
token for a system of record holding the club's portfolio and its
primary research, so it belongs somewhere the OS protects.
`X-New-Token` rotation is honoured, which is what stops an active
session dying every 24 hours.

## The shell

Mirrors the web terminal's anatomy exactly — topbar with the ET market
clock, the amber command line directly under it with the Bloomberg
autocomplete (arrow keys walk the ranked matches, Tab fills, Enter
runs; plain English falls through to the server's LLM parser), the
breaking-news strip, the favorites/recents rail, the floating
workspace, and the status bar.

Panes drag by their title bar and resize from the corner; edges snap to
siblings and to the workspace border on release. Double-click a header
to maximize. The in-flight gesture lives in pane-local state and the
model is written once on release — the first version wrote every mouse
move into the shared model, which re-rendered every pane per frame and
made the windows feel broken.

The `⧉` button pops a pane into a REAL macOS window: native drag,
Mission Control, and the OS's own window tiling. A popped-out window
carries its own command line, and a command typed there replaces that
window's content — `PANEL <GO>`, effectively.

## Every function is native

All 27 mnemonics run here — full parity with the web terminal:

| Code | Panel |
|---|---|
| `DES` | company snapshot: quote, valuation, business summary |
| `GP` | daily price chart with ranges and SMA/EMA studies |
| `GIP` | intraday line vs prior close, 30s refresh |
| `CN` | company news with the AI brief |
| `BI` | the research chat |
| `FA` | income / balance / cash flow, annual or quarterly (SEC XBRL) |
| `GF` | fundamentals over time, small-multiple charts |
| `PEER` | sector peer comparison |
| `CMP` | 2–4 tickers side by side, live |
| `EARN` | next report + EPS beat/miss history |
| `CON` | analyst consensus breakdown |
| `INSDR` | Form 4 buys/sells over the price chart |
| `ICLUSTER` | multi-insider buy clusters across the book |
| `MGMT` | CEO, board, comp from the DEF 14A |
| `SPLC` | supply chain from the 10-K |
| `FIL` | recent SEC filings |
| `WEI` | world index snapshot |
| `PM` | the whole book, positions and weights, cash separated |
| `MOVR` | the day's moves, with the unpriced count stated |
| `TOP` | market wire · `NOTE` per-ticker research notes |
| `MACRO` | portfolio betas to 10Y, oil, USD, VIX, SPY |
| `WX` / `RDR` | storm impact · live NEXRAD radar + NWS alerts |
| `ARCH` | the club's own reports, readable inline |
| `RSCH` / `FLD` | the research workspace: questions/coverage, ledger, valuation, interviews, visits, files, compliance, outreach with the two-signature gate |
| `HELP` | every mnemonic and every keystroke |

(`ECO` says honestly that it is not built anywhere yet.)

## Launchpad

The workspace autosaves on every committed change and restores on
launch. `⌘⇧S` pins the current arrangement under a name in the Layouts
menu — "earnings day", "CHRW work" — and restoring one says what it
skipped if a function has since changed. `⌘1…⌘9` focus panes by the
order you opened them. The topbar carries the focused ticker's live
price, because you should never have to open a panel to know where
your security is trading.

## Driving it

```
AIT DES     ticker + function
PM          function alone
AIT         bare ticker opens DES
```

The focused ticker carries forward, so `AIT DES` then `PM` then a bare
`GP` stays on AIT.

`⌘K` or `/` command line · `⌘W` close pane · `⌘⇧W` close all ·
`⌘⇧T` tile · double-click a header to maximize · `⧉` pop out.

## Adding a panel

1. A file in `Sources/GriffinTerminal/Panels/`.
2. Flip `native: true` on its entry in `Core/Registry.swift`.
3. A case in `PanelHost` in `Core/PaneWindow.swift`.

Fetch through `PanelState`, which is not a convenience — it makes
loading, failed and genuinely-empty render as three different things.
Hand-rolling those branches is how a panel ends up showing an error as
an empty table, and an empty table reads as "we checked and there is
nothing" to whoever is looking at it.

## The parser is a port, and stays one

`Core/Parser.swift` mirrors `client/src/terminal/parser.js`, which
mirrors `mnemonicParse` in `server/src/routes/terminal.js`. The whole
value of a command line is that the same keystrokes do the same thing
every time.

`Tests/GriffinTerminalTests/ParserTests.swift` checks it against output
generated by running the real JS, not against anybody's reading of it.
If the web parser changes, regenerate the expectations rather than
adjusting the Swift until the tests go green.
