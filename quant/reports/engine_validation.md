# Engine validation — buy and hold SPY

Stage 2. One security, held through the whole simulator, reconciled against its own published total return. The question is not whether the engine makes money — it is whether the money it makes is arithmetic anybody can follow.

**RECONCILED. The engine came in -0.148% a year against SPY's own total return, and all of that difference is accounted for by cash, costs and fill timing: the ladder lands on the engine's reported NAV to $0.00.**

## The run

| | |
|---|---|
| Security | SPY, priced from `close_adj` |
| Sample | 2005-01-03 to 2026-07-31 |
| Sessions | 5,428 (21.57 years) |
| Starting cash | $131,000.00 |
| Target weight | 95% of NAV |
| Settlement | T+1, 5% of NAV held back from every buy |
| Turnover budget | 5% of NAV a day |
| Costs | costs 1x (liquidity-scaled spread, sqrt impact Y=1) |
| Whole shares | yes |

## The reconciliation

Each row removes one friction from the row above it. The steps are sequential, so the dollar attribution is order-dependent at second order; the line that has to be exact is the last one, which is a subtraction rather than an estimate.

| | Terminal wealth | CAGR | Step | What it is |
|---|---:|---:|---:|---|
| SPY total return, from close_adj | $1,206,317.69 | 10.840% | — / — | the published answer; nothing of ours is in it |
| less cash the account never invested | $1,175,048.84 | 10.705% | $-31,268.85 / -0.135% | the turnover budget's ramp plus the ledger's permanent 5% buffer, earning nothing |
| less spread and impact | $1,174,123.87 | 10.701% | $-924.97 / -0.004% | at 1x the base assumption |
| less open-versus-close fill timing | $1,171,950.59 | 10.692% | $-2,173.28 / -0.010% | decided at a close, filled at the next open; the sign of this one is not ours to choose |
| **engine NAV, as reported** | **$1,171,950.59** | **10.692%** | $-0.00 | residual — must be float noise |

Engine CAGR **10.692%** against benchmark **10.840%** — the engine less the benchmark is **-0.148** percentage points a year. Residual after the three explanations: $-0.00, 2.583e-15 of terminal NAV, against a tolerance of 1e-08.

## Where the gap comes from

Every figure in the middle column is an effect on the annualised return, so a negative number is a cost. A positive one is not a mistake — it is a window in which being under-invested, or filling at an open rather than a close, happened to help. That is luck and not design, and the two cash rows compound (they do not sum) to the cash-drag rung in the ladder above.

| Cause | Effect on CAGR | Detail |
|---|---:|---|
| Deployment ramp | +0.089% | the turnover budget moves 5% of NAV a day, so the book took 21 session(s) to finish buying |
| Permanent cash buffer | -0.211% | mean invested weight after the latch 97.3%; the rest is settled cash earning nothing |
| Spread and impact | -0.004% | $103.04 actually paid ($71.12 spread, $31.92 impact) across 20 fill(s); $924.97 of terminal wealth once the forgone compounding is counted |
| — of which priced blind | | 2 fill(s) had no median dollar volume yet (the window needs ten sessions) and were charged at the curve's least-liquid anchor, 100bp round trip. Pessimistic in the right direction, and an artefact of where the sample starts rather than a fact about SPY |
| Open-versus-close fill timing | -0.010% | $-2,173.28 of terminal wealth. Unsigned by nature: over 20 fills it is whatever the intraday tape did |
| T+1 settlement | +0.000% | buy-and-hold never sells, so no proceeds ever wait to settle and the constraint costs this run exactly nothing. Printed rather than omitted: an absent term reads as a forgotten one |

## Engine hygiene

| | |
|---|---|
| Fills | 20 |
| Postponed (budget, depth, min ticket) | 20 |
| Cash deferrals | 1 |
| Stale marks | 0 |
| Receivables unsettled at the end | 0 |

The ledger's NAV invariant — settled plus unsettled plus market value equals NAV — is checked inside the loop on every one of the 5,428 sessions. A run that finishes has already passed it.

## What this does and does not prove

It proves the plumbing: positions are marked in total-return space, fills land on the next open, costs are charged once, cash is conserved, and the reported NAV is the sum of terms this script can rebuild independently. It proves nothing whatsoever about a strategy, because there is no strategy here — the control was chosen precisely because its correct answer is published and we did not get to pick it.

_Generated 2026-08-02 23:33 UTC by `validate_engine.py`._
