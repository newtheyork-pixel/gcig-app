# Survivorship, Measured

The owner asked why we could not just remove the tickers that do not exist, since there are not many of them. The honest answer at the time was that there are a great many, and that the SIGN of what their absence does is unknowable without the data. The first half of that is now a table. The second half is now a number.

## The answer

**On this panel the hand-written survivor list flatters an equal-weight book by +0.24% a year** (95% interval +0.07% to +0.44%, circular block bootstrap, 21-session blocks, 10,000 draws). The portfolio run agrees: the same book rebalanced monthly with spread and impact charged inside the loop differs by +0.23% a year [+0.08%, +0.39%].

**Over the window where the vendor actually keeps its dead — 2014 onward, 3,163 sessions — it is +0.32% a year [+0.06%, +0.64%].** That is the row to quote. Before 2014 the catalogue records 6 ETF closures across 9 years, which is not a market history, and the whole-sample figure above is diluted by it.

**Scaled to the catalogue's own attrition the estimate is +1.91% a year** [+0.69%, +3.20%], over the 5,201 sessions on which the panel carried a doomed fund to compare. The panel's doomed share is 4.0% where the shelf's was 27.3%, and the identity below is linear in that share, so this is the first figure re-weighted rather than a second experiment.

**The two figures are not equally well established, and it is worth being explicit about which is which.** The panel figure is measured and its interval excludes zero. The scaled figure re-weights it by a factor of 7 and multiplies the sampling noise by the same factor; its interval still excludes zero. So the sign survives the scaling, and the magnitude is the part to hold loosely — the shape of the answer is a point or two a year, not a figure anybody should quote to two decimals.

**The sign is the finding.** An ETF closure is not a bankruptcy: the fund's assets are the shareholders' assets held in trust, the sponsor announces a date, creations stop, the portfolio is sold and the cash is distributed. The tape says the same thing — across the dead cohort the median fund's last quarter of trading returned +1.52%, which is a fund being wound up rather than a fund collapsing. So ETF survivorship bias is SMALLER than equity survivorship bias, and that makes the single-name argument stronger rather than weaker: the layer we refused to test is the layer where a delisting goes to zero.

## The control, before anything else

Buy-and-hold SPY holds one fund that is in both pools, so it must return the same curve on both panels. It does: the largest difference between the two equity curves across 5,428 sessions is 0.000e+00 of NAV, which is floating-point and not a result. Both report +10.94% a year at a Sharpe of 0.55 and a worst drawdown of -55.20%.

That is what makes every other row below a comparison rather than a coincidence. Two panels that disagree about SPY disagree about the calendar, the adjustment, or the cost model, and a survivorship number computed across that disagreement would be measuring our own wiring.

It is also the check that this simulator is not inventing returns, and the check was worth running. From the session it is first invested to the end of the sample the book's equity tracks SPY's own total return to twelve significant figures, which is what a correct overnight-then-intraday decomposition looks like and is not what an approximate one looks like. `reports/post_publication_ledger.md` puts the same position at 10.69% a year through the full engine, against +10.94% here; the difference is the ledger's five per cent settlement reserve, which is switched off below for the reason `simulate` gives — a 95%-invested book neither earns nor falls as far as a fully invested one, and the drawdown column shows the second half of that.

The same check found the one defect that mattered. The history gate was counting a fund's bars inside the study window rather than over the whole pull, so a fund trading since 1993 arrived on the opening session looking a day old, every name failed the 252-session rule at once, and the study spent its first trading year in cash — worth 0.13% a year on SPY, invisible in any gap because it fell on both panels equally, and wrong. It is fixed; the note on `Tape.history` says why the fix has to live where the rolling statistics live.

## What the two panels are

One difference and one only. The biased panel's pool is the funds that are alive today, which is what a list written by looking at what trades produces. The free panel's pool is those same funds plus the dead ones recovered from the vendor's directory. Same bars, same calendar, same eligibility rule, same cost model, same rebalance dates, same code path — `simulate` is called twice with a different boolean mask.

| Measure                                                |                                Count |
| ------------------------------------------------------ | -----------------------------------: |
| Shelf symbols in the catalogue (ETF, USD, major venue) |                                7,583 |
|   still listed                                         |                                5,675 |
|   dead                                                 |                                1,902 |
| Hand-written list this repository has used             |                                  142 |
|   of which dead                                        | 0 (0.00% against the shelf's 25.08%) |
| Symbols with bars on disk                              |                                  267 |
|   refused: unresolvable or never traded                |                                    3 |
|   refused: catalogue and tape disagree                 |                                    4 |
| Funds admitted to the study                            |                                  260 |
|   survivors (the BIASED panel)                         |                                  150 |
|   dead, randomly sampled (added for the FREE panel)    |                                   97 |
|   dead, hand-picked (excluded from the estimate)       |                                   13 |
| Drawn by the shuffle, vendor served nothing            |                                    3 |
| Cached entry that read back empty                      |                                    0 |
| Hand-list names with no bars on disk                   |                                    0 |

The hand list is 0 of 142 dead against a shelf that is 25.1% dead. That is the bias, in units, and it needed no pull to state.

**13 dead funds on disk are excluded from the estimate.** They are the ones `etfuniverse.DECEASED` already named, plus any pulled by hand along the way — real funds that really closed, chosen because somebody found them interesting: Russia, Egypt, coal, the currency trusts. That is a sampling rule with an unknown relationship to return, and mixing it into a random sample would put a thumb on the scale in a direction nobody could state. Named here, kept out of every number above: `ADRE`, `EGPT`, `ERUS`, `FRN`, `FXCH`, `FXS`, `FXSG`, `GAF`, `JJC`, `KOL`, `PGD`, `PSAU`, `RSX`.

**3 name(s) the shuffle drew came back with no bars at all** (`LNGZ`, `TZD`, `TZG`). A directory row is the vendor's index and not its tape, and the gap between the two is a measurement rather than an error — they are counted here and are in no panel.

### The catalogue and the tape disagree about 4 funds

**Refused because the vendor's own two records contradict each other**: `EMCG`, `FTW`, `RISE`, `SLVO`. Each is filed dead in the directory, with a coverage window that ended years ago, and the price endpoint answers for each with a live series running to the last session of this sample.

This is worth more than its size, because it defeats the reissued-ticker test that was thought to be sufficient. `deadetfs.classify` refuses a symbol carrying more than one coverage window and catches seventy that way; every one of these carries exactly ONE window and is reissued anyway. A directory row indexes a string and the price endpoint serves whatever that string means today, so where the two disagree the string has meant two funds and the window count never saw it. **The tape has to be cross-checked against the catalogue, symbol by symbol, and a universe built from directory metadata alone will carry a successor's returns under a dead fund's name.**

None is reassigned to the other cohort, because reassigning is a guess about which of two vendor records is wrong and nothing here can make it. They are refused, counted, and named.

### How many doomed funds the panel actually carries

| Year | Survivors in panel | Doomed in panel | Panel doomed share | Shelf doomed share |
| ---: | -----------------: | --------------: | -----------------: | -----------------: |
| 2005 |                 50 |             0.4 |               0.8% |              35.4% |
| 2006 |                 57 |             1.5 |               2.6% |              33.4% |
| 2007 |                 69 |             3.3 |               4.6% |              30.6% |
| 2008 |                 87 |             3.3 |               3.6% |              30.2% |
| 2009 |                 94 |             2.5 |               2.6% |              32.1% |
| 2010 |                 94 |             3.8 |               3.9% |              31.7% |
| 2011 |                101 |             5.4 |               5.1% |              32.8% |
| 2012 |                109 |             2.9 |               2.6% |              34.5% |
| 2013 |                117 |             4.6 |               3.8% |              35.2% |
| 2014 |                128 |             6.4 |               4.8% |              35.6% |
| 2015 |                131 |             8.9 |               6.4% |              35.2% |
| 2016 |                133 |            10.1 |               7.1% |              34.4% |
| 2017 |                135 |             9.3 |               6.4% |              34.3% |
| 2018 |                135 |             8.8 |               6.1% |              31.2% |
| 2019 |                135 |             9.5 |               6.6% |              27.4% |
| 2020 |                137 |             6.9 |               4.8% |              24.5% |
| 2021 |                141 |             4.6 |               3.1% |              18.6% |
| 2022 |                145 |             5.1 |               3.4% |              17.4% |
| 2023 |                144 |             3.3 |               2.3% |              14.6% |
| 2024 |                143 |             2.0 |               1.4% |               8.7% |
| 2025 |                143 |             2.0 |               1.3% |               5.0% |
| 2026 |                146 |             0.4 |               0.3% |               2.2% |

The last column is the answer to the scaling question and the reason the headline is quoted twice. The panel's doomed share is a fraction of the shelf's, because a metered free tier bought a few dozen dead funds and the shelf holds nearly two thousand.

## The identity, which is why this is not confounded

For an equal-weight book the difference between the two panels' returns on a given day is exactly

    share doomed  x  ( mean return of survivors - mean return of the doomed )

with no residual term, because the mean of a union is the size-weighted mean of its parts. Breadth does not appear in it. Selectivity does not appear in it. This is the measurement the two earlier attempts were reaching for: the first held a fixed count out of universes of 491 and 193 names and therefore measured how hard a screen was, the second held a fixed fraction and therefore measured how many names a book had. Neither is avoidable inside a portfolio and neither exists here.

| Window       | Sessions | Doomed share | Per-fund gap, /yr | Equal-weight bias, /yr |   95% interval |
| ------------ | -------: | -----------: | ----------------: | ---------------------: | -------------: |
| Whole sample |    5,427 |         3.9% |            +7.33% |                 +0.24% | [+0.07, +0.44] |
| Before 2014  |    2,264 |         3.3% |            +7.78% |                 +0.13% | [-0.09, +0.32] |
| 2014 onward  |    3,163 |         4.3% |            +7.02% |                 +0.32% | [+0.06, +0.64] |

The split at 2014 is not a robustness cut, it is the vendor's retention boundary. `deadetfs.retention_cliff` finds it from the data — the catalogue records 6 ETF closures in the 9 years before it against 1,896 after — so the earlier window's doomed funds are the few the vendor happened to keep and the later window's are the population. **The row to quote is the later one.** The earlier one is reported because hiding it would be choosing the window after seeing the answer, and because it says something worth knowing on its own: over 2005-2013 the funds that would later die under-performed the survivors. Delistings are a mix of takeovers and failures and the mix is not constant.

Leaving each dead fund out in turn moves the equal-weight bias between +0.20% and +0.26% a year — no single fund flips the sign. The fund contributing most to the estimate is `MLPQ`, whose removal takes it to +0.20%; the one pulling hardest the other way is `FRLG`, whose removal raises it to +0.26%.

### What the account's own liquidity floor does to the answer

| Window                              | Sessions | Doomed share | Per-fund gap, /yr | Equal-weight bias, /yr |   95% interval |
| ----------------------------------- | -------: | -----------: | ----------------: | ---------------------: | -------------: |
| ADV floor on (>= $655,000/day)      |    5,427 |         3.9% |            +7.33% |                 +0.24% | [+0.07, +0.44] |
| No liquidity gate — the whole shelf |    5,427 |        15.0% |            +0.29% |                 +0.26% | [-0.11, +0.63] |

Read this as a change of COMPOSITION rather than of size. Dropping the floor more than doubles the doomed share — 3.9% to 15.0% — because most dead funds never traded enough for this account to touch them. The per-fund gap moves the other way, from +0.29% without the floor to +7.33% with it, and the product of the two barely moves.

Which says something the aggregate hides. The floor is not screening out doomed funds, it is screening out the ones that died of never gathering assets — funds whose returns while they lived were unremarkable, because nothing much was happening in them. What it keeps is the funds that traded properly and closed anyway, and those are the ones whose returns actually differ. **A liquidity floor is not a survivorship fix.** A reader who assumed it was one would have this backwards, and would conclude that a bigger account has a bigger problem when the measurement says the two are about equal.

## The paired portfolio runs

Three books through the identical simulator, on both panels, plus a third arm. Arm A is the biased pool. Arm B is the free pool. Arm C is a random subset of B the size of A, drawn with no regard to survival, 25 times on fixed seeds — so A against C is survivorship at a matched pool size and C against B is breadth with survival held constant. Reporting both is how a reader sees the confound instead of being asked to trust that it was handled.

| Book                        | Panel  |    CAGR |    Vol | Sharpe |  Max DD | Names held | Cost bps/yr | Liquidations |
| --------------------------- | ------ | ------: | -----: | -----: | ------: | ---------: | ----------: | -----------: |
| Buy and hold SPY            | biased | +10.94% | 18.92% |   0.55 | -55.20% |          1 |         0.0 |            0 |
|                             | free   | +10.94% | 18.92% |   0.55 | -55.20% |          1 |         0.0 |            0 |
| Equal weight, monthly       | biased |  +7.43% | 14.25% |   0.45 | -46.22% |        116 |        12.7 |            0 |
|                             | free   |  +7.21% | 14.09% |   0.44 | -45.89% |        121 |        16.4 |           11 |
| Momentum 12-1, top 20 names | biased |  +7.48% | 17.21% |   0.40 | -37.88% |         19 |        41.2 |            0 |
|                             | free   |  +7.21% | 17.34% |   0.39 | -37.88% |         19 |        50.4 |            1 |
| Momentum 12-1, top 15%      | biased |  +6.66% | 18.08% |   0.35 | -48.89% |         17 |        41.9 |            0 |
|                             | free   |  +6.50% | 18.03% |   0.34 | -47.85% |         18 |        51.6 |            1 |

| Book                        | CAGR gap A-B | Paired daily mean, /yr |   95% interval | Excludes zero | A-C (breadth matched) | C-B (breadth only) |
| --------------------------- | -----------: | ---------------------: | -------------: | ------------- | --------------------: | -----------------: |
| Buy and hold SPY            |       +0.00% |                 +0.00% | [+0.00, +0.00] | no            |                     — |                  — |
| Equal weight, monthly       |       +0.22% |                 +0.23% | [+0.08, +0.39] | yes           | +0.19% [-0.31, +0.74] |             +0.04% |
| Momentum 12-1, top 20 names |       +0.27% |                 +0.23% | [-0.24, +0.72] | no            | +0.19% [-0.33, +0.74] |             +0.04% |
| Momentum 12-1, top 15%      |       +0.16% |                 +0.16% | [-0.36, +0.70] | no            | +0.10% [-0.74, +0.89] |             +0.07% |

A positive number in either gap column means the BIASED panel earned more — that survivorship flattered the result. The CAGR column carries compounding and therefore carries the breadth effect; the paired daily column differences the two books day by day, which removes the market and leaves the treatment.

**The last two columns are the answer to what remains confounded, and they add up.** A minus B is the practitioner's mistake and it is confounded by breadth, because the free pool is wider. A minus C is the same comparison at a matched pool size. C minus B is what is left, which is breadth alone with survival held constant — and by construction (A-C) + (C-B) = (A-B) exactly, so the two columns partition the naive gap rather than merely commenting on it.

The direction of the residual confound is therefore measured rather than argued. Across the cross-sectional books the breadth term averages +0.05% a year, so a wider pool hurts — which means the naive A-B comparison OVERSTATES the survivorship effect by about that much. Removing dead funds from a universe does two things at once, and only one of them is survivorship.

**The two momentum rows are the point of running momentum at all.** A fixed count of 20 names is a harder screen out of a wider universe, so arm B is more selective than arm A and the comparison carries selectivity. A fixed 15% holds selectivity constant and lets the book's width move instead. The two answers are printed side by side rather than averaged, because averaging them would produce one number that is neither.

**And here the selectivity confound is small, for a reason worth stating rather than taking credit for.** The two pools differ by 97 funds out of 150, so the eligible universe widens from about 116 names to 121 — about 4 per cent. 20 of 116 and 20 of 121 are nearly the same screen. The earlier attempts hit this hard because they DELETED sixty per cent of a universe to make the biased side; this one ADDS to it, which is the same experiment run in the direction that does not manufacture the confound. What is left of it, arm C prices.

**What the momentum rows do not establish is a number.** Both of their intervals cross zero, on every arm. 97 dead funds are enough to measure a cross-sectional mean, which is what the identity is, and not enough to measure what a twenty-name book made of the top of that cross-section did — the same funds are being asked a much harder question. The equal-weight row is the one carrying the result; these two are here to show it is not an artefact of one weighting scheme, and every cross-sectional book agrees with it in sign on both the naive and the breadth-matched comparison.

## What a closing fund pays, and how much the answer depends on it

This is where the sign of an equity survivorship study is decided and it is why an ETF study lands somewhere else. A stock that delists for cause hands its holder a fraction of nothing; CRSP's performance-related delisting returns are around minus thirty per cent and the tail below that is where the single-name bias lives. An ETF that closes runs a liquidation: creations stop, the portfolio is sold, the proceeds are distributed. The assets were never the sponsor's to lose.

The base case here is therefore that a position converts to cash at its last printed mark, on the session AFTER the final print, with no foreknowledge — a real holder, warned weeks ahead by the closure notice, would have done better. The tape is asked directly rather than trusted:

| Across the dead cohort | Last 21 sessions | Last 63 | Last 252 | From lifetime peak |
| ---------------------- | ---------------: | ------: | -------: | -----------------: |
| Median                 |           +0.69% |  +1.52% |   +4.07% |            -11.69% |
| Mean                   |           -0.40% |  +1.20% |   +3.39% |            -19.04% |
| Worst                  |          -81.07% | -83.33% |  -85.54% |            -96.42% |
| Share negative         |              38% |     33% |      36% |                96% |

A third of the cohort's final quarters are negative and two thirds are not, which is what a mixture of takeovers and failures looks like and is the answer to the question that could not be settled before the data existed. The `worst` row is the reason the mean and the median are both printed: one fund lost four fifths of its value in three months and the median fund gained.

### The dead cohort, best and worst

| Fund      | First bar in window | Last bar   | Sessions | Life total | Annualised | Final quarter | From peak |
| --------- | ------------------- | ---------- | -------: | ---------: | ---------: | ------------: | --------: |
| BXUB      | 2009-11-18          | 2014-11-19 |    1,255 |   +306.32% |    +32.51% |        +5.54% |    +0.00% |
| NZUS      | 2022-04-18          | 2026-05-21 |    1,028 |   +232.12% |    +34.21% |      +120.92% |    +0.00% |
| FRLG      | 2018-04-03          | 2022-02-14 |      976 |   +213.42% |    +34.31% |       -18.10% |   -21.05% |
| CUBA      | before the window   | 2025-07-03 |    5,158 |   +142.52% |     +4.42% |        +4.51% |   -36.28% |
| JRO       | before the window   | 2023-07-28 |    4,674 |   +136.67% |     +4.75% |        +2.77% |   -13.08% |
| BTA       | 2006-02-27          | 2026-02-20 |    5,028 |   +113.29% |     +3.87% |        +4.36% |   -18.84% |
| IVOP      | 2011-09-19          | 2018-04-11 |    1,642 |   +102.77% |    +11.46% |        -0.89% |    -5.69% |
| AXJL      | 2006-06-16          | 2020-05-27 |    3,510 |    +96.51% |     +4.97% |       -10.99% |   -19.88% |
| PXR       | 2008-10-17          | 2019-02-20 |    2,602 |    +91.90% |     +6.52% |        +5.41% |   -29.23% |
| NCB       | 2009-04-28          | 2021-03-05 |    2,984 |    +90.85% |     +5.61% |        +2.82% |    -4.78% |
| DIAX      | 2014-12-03          | 2026-03-27 |    2,844 |    +90.38% |     +5.87% |        -5.31% |    -8.79% |
| IPD       | 2008-07-25          | 2017-08-01 |    2,271 |    +80.87% |     +6.80% |        +2.08% |    -3.67% |
| NKG       | before the window   | 2023-04-14 |    4,602 |    +75.11% |     +3.12% |        -2.23% |   -23.44% |
| EIP       | before the window   | 2019-01-18 |    3,536 |    +67.54% |     +3.75% |        +5.84% |   -14.69% |
| DFVL      | 2011-07-12          | 2021-07-09 |    2,514 |    +66.80% |     +5.26% |        +3.52% |   -21.19% |
| VNMC      | 2020-09-17          | 2024-07-25 |      969 |    +66.52% |    +14.18% |        +3.71% |    -1.99% |
| GMAN      | 2019-03-07          | 2020-11-06 |      424 |    +65.70% |    +35.00% |       +20.19% |    +0.00% |
| TNDQ      | 2011-12-13          | 2015-07-06 |      894 |    +57.22% |    +13.60% |        +1.02% |    -3.38% |
| IFNA      | 2007-12-27          | 2015-08-21 |    1,927 |    +55.14% |     +5.91% |        +0.10% |   -10.59% |
| FBSS      | before the window   | 2021-03-31 |    4,089 |    +54.67% |     +2.72% |       +22.63% |   -11.32% |
| … 57 more |                     |            |          |            |            |               |           |
| FTT       | 2010-01-27          | 2015-10-20 |    1,444 |     -9.45% |     -1.72% |        +3.54% |   -11.44% |
| GDXX      | 2015-02-13          | 2019-08-05 |    1,126 |    -12.11% |     -2.85% |       +91.45% |   -40.65% |
| CTF       | 2012-10-26          | 2017-01-04 |    1,053 |    -17.92% |     -4.62% |        +6.22% |   -19.25% |
| HYND      | 2013-12-18          | 2020-05-28 |    1,621 |    -18.98% |     -3.22% |       -13.75% |   -25.10% |
| AGOL      | 2011-01-14          | 2015-08-12 |    1,150 |    -19.96% |     -4.76% |        -7.29% |   -42.49% |
| DBBR      | 2011-06-09          | 2018-05-31 |    1,756 |    -20.17% |     -3.18% |        -9.78% |   -20.63% |
| LEDD      | 2011-04-21          | 2018-04-11 |    1,748 |    -21.36% |     -3.41% |        -8.15% |   -25.36% |
| BKES      | 2021-12-15          | 2024-02-14 |      544 |    -24.54% |    -12.23% |        +0.05% |   -25.48% |
| NIB       | 2008-06-25          | 2023-06-14 |    3,769 |    -26.60% |     -2.05% |       +28.97% |   -32.21% |
| AND       | 2011-02-03          | 2017-10-06 |    1,681 |    -27.30% |     -4.67% |        +8.89% |   -31.64% |
| LIV       | 2020-10-15          | 2022-10-19 |      507 |    -34.46% |    -18.94% |       -14.32% |   -43.57% |
| AMU       | 2012-07-18          | 2020-11-23 |    2,103 |    -40.71% |     -6.07% |        +5.69% |   -61.37% |
| UHN       | 2008-04-10          | 2018-09-06 |    2,622 |    -59.84% |     -8.40% |        -0.43% |   -68.83% |
| CEN       | 2013-09-26          | 2023-10-06 |    2,525 |    -69.70% |    -11.23% |        +6.89% |   -72.18% |
| LBDC      | 2015-10-09          | 2020-04-01 |    1,125 |    -72.02% |    -24.82% |       -83.33% |   -84.20% |
| MLPQ      | 2016-02-09          | 2020-03-18 |    1,033 |    -72.49% |    -27.01% |       -80.67% |   -90.53% |
| PSY       | 2021-05-28          | 2022-08-31 |      318 |    -77.13% |    -68.94% |       +12.06% |   -78.08% |
| JUNR      | 2011-03-17          | 2015-10-16 |    1,155 |    -78.67% |    -28.62% |        -2.71% |   -81.06% |
| SILX      | 2021-06-16          | 2023-07-17 |      524 |    -82.12% |    -56.30% |       -41.08% |   -82.12% |
| KSET      | 2022-04-27          | 2024-03-14 |      473 |    -96.42% |    -83.04% |       -29.30% |   -96.42% |

Sorted by lifetime return, head and tail, because sorted and truncated at one end this table would print nothing but winners and read as evidence that closing funds do fine. Read down the last two columns: a fund that compounded for eight years and stopped is a closure, a fund that lost most of its value and stopped is not, and the aggregate figure cannot tell a reader which of the two it is made of. Both are in here.

| A closing fund pays   | Identity bias, /yr | Equal-weight gap, /yr |   95% interval | Free-panel CAGR |
| --------------------- | -----------------: | --------------------: | -------------: | --------------: |
| 100% of the last mark |             +0.24% |                +0.23% | [+0.08, +0.39] |          +7.21% |
| 95% of the last mark  |             +0.25% |                +0.25% | [+0.10, +0.41] |          +7.19% |
| 90% of the last mark  |             +0.27% |                +0.27% | [+0.11, +0.43] |          +7.17% |
| 50% of the last mark  |             +0.38% |                +0.40% | [+0.21, +0.60] |          +7.03% |
| 0% of the last mark   |             +0.52% |                +0.56% | [+0.31, +0.84] |          +6.85% |

Read the bottom row as the bound rather than as a scenario. Paying nothing at all is what a bankrupt equity does and it is not what an ETF does, so that line measures how much of this result is an assumption: everything between it and the top row.

**And the ladder is short, which is the finding underneath it.** Assuming a closing fund pays its holder NOTHING moves the equal-weight bias from +0.24% to +0.52% a year — a swing of 0.28 points against a 95% interval 0.37 points wide. The reason is visible in the book: over 5,428 sessions the free panel liquidated a position 11 times, because a fund's volume usually fails the floor months before its tape stops and the rebalance has already let it go.

So the survivorship effect measured here is almost entirely about how doomed funds behaved WHILE THEY WERE ALIVE, and hardly at all about what they paid at the end. That is the opposite of the single-name case, where the terminal event is most of the bias, and it is why the two cannot be reasoned about with the same intuition.

## What this does to the ledger

**An estimate, not a re-run.** Re-running thirty-three strategies would take hours and the marginal value is low, for a reason that is worth more than the run would be: **32 of the 33 published strategies in the registry name their own legs.** The Permanent Portfolio holds four funds by name; Antonacci's dual momentum holds four; every factor row holds one. Adding dead funds to the panel cannot move a weight in any of them, because none of them ever looks at a fund it was not told about. Their survivorship exposure is not small, it is structurally zero.

One strategy ranks or spans a cross-section — `equal_weight_universe`, 142 legs — and it is the one this file has measured directly. Its reported figure would move by about +0.23% a year on this panel, or about +1.91% at the shelf's own attrition rate. Nothing else in the ledger moves at all.

So the ledger's three headline claims survive, and it is worth doing the arithmetic rather than asserting it. The post-publication mean excess over SPY across 30 dated strategies is -4.03% a year; exactly one of those 30 rows moves, by +0.23%, so the mean moves by +0.008% — the third decimal place. The MEDIAN of -3.21% does not move at all, because a single row shifting by two tenths of a point cannot cross the middle of thirty. And the count of 3 in 30 beating SPY is unchanged: equal weight returns +7.43% against SPY's +10.94% on this panel and loses on either.

**The channel that does affect everything is a different one, and it is not what this file measured.** The named legs were themselves chosen in 2026 from funds that still trade. A club building an international sleeve in 2005 might well have bought ADRE, GAF or FRN rather than EEM, and all three are gone. That is vehicle-selection bias rather than cross-sectional survivorship, it applies to every sleeve book in the repository, and its size is the same arithmetic — the doomed share of the menu times the per-fund gap. What it is not is measurable from this tape, because nothing records which fund a 2005 committee would have picked.

## What is still missing

- **1,792 dead shelf symbols have no bars here.** The acquisition is metered at roughly fifty symbols an hour and runs on; every one that lands widens the cohort and narrows the interval, and none of them changes the design.
- **The catalogue records almost no closure before 2014.** `retention_cliff` estimates 222-479 ETF closures the vendor never carried, and they are exactly the 2008-09 casualties whose returns would be worst. Every number above is therefore a LOWER bound on the whole-sample bias and a fair measurement of the post-cliff one.
- **Closed-end funds sit in the dead cohort.** The vendor types some of them ETF, the pre-SPY rule catches only those older than the ETF itself, and `NKG` — a Nuveen municipal fund starting in 2002 — walks straight through. The jackknife above is the bound on what that can be worth: no single removal moves the sign.
- **Whole shares, minimum trade sizes and the turnover budget are off.** Every one of them is a function of breadth rather than of survival, so leaving them on would have charged one panel for being wider and reported it as survivorship. The consequence is that these curves are not the ledger's curves and are not meant to be compared to them; the quantity that transfers is the GAP.
- **The dead cohort is 97 funds.** Enough to measure a cross-sectional mean and not enough to measure what a concentrated book made of the top of it did — every interval above says which is which, and only the pull changes it.

## The run

|                       |                                                                           |
| --------------------- | ------------------------------------------------------------------------- |
| Study window          | 2005-01-03 to 2026-07-31                                                  |
| Sessions              | 5,428                                                                     |
| Funds on the tape     | 264                                                                       |
| Eligibility           | existence, 252 sessions of history, ADV >= $655,000 and price >= $5.00    |
| Rebalance             | last session of each month, filled at the next open                       |
| Costs                 | engine `CostModel` at 1x, spread plus square-root impact                  |
| Cash                  | FRED DGS3MO, compounded over calendar days (0.00%-17.01% across the pull) |
| Delisting             | cash at 100% of the last mark, one session later                          |
| Breadth-matched draws | 25                                                                        |
| Bootstrap             | circular blocks of 21, 10,000 draws, seed 20260803                        |
| Sample provenance     | the acquisition's own coverage table (dead_coverage.parquet)              |
| Cache                 | /Users/thomasseirer/repos/gcig-app/quant/data/cache                       |
| Network               | none — every bar read from disk, the vendor's meter untouched             |
| Report                | /Users/thomasseirer/repos/gcig-app/quant/reports/survivorship_measured.md |

_Generated 2026-08-03 10:06 UTC._
