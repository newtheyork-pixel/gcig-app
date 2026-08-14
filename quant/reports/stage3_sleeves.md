# Stage 3 — the sleeve book through the engine

Layers 1 and 2 from the sample start to the present, with T+1 settlement, a five per cent daily turnover budget, whole shares and the cost model charged inside the loop — against a daily-rebalanced 60/40 and a buy-and-hold of SPY run through the same engine on the same assumptions. Read `reports/signal_evaluation.md` first: it is the gate that says whether any of the three signals means anything on its own.

**13 trial(s), 5,427 observations: the best-of-N annualised Sharpe under the null is 0.37, observed 0.61. Deflated Sharpe 0.864 is below the 95% bar: the edge is not distinguishable from the best draw a search this wide would find by luck. Report it as insignificant, not as promising. At 3x cost the strategy still compounds (+5.00% a year against +5.35% at 1x).**

## The run

|                  |                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source           | Tiingo daily EOD (sleeve ETFs only)                                                                                                                 |
| Sample           | 2005-01-03 to 2026-07-31                                                                                                                            |
| Sessions         | 5,428                                                                                                                                               |
| Sleeve vehicles  | BIL, DBC, EEM, EFA, GLD, IEF, LQD, SPY, TLT                                                                                                         |
| Starting cash    | $131,000.00                                                                                                                                         |
| Settlement       | T+1, 5% of NAV held back                                                                                                                            |
| Turnover budget  | 5% of NAV a day, hard                                                                                                                               |
| No-trade band    | 0.5% of NAV drift                                                                                                                                   |
| Fills            | decided at the close of T, filled at the open of T+1                                                                                                |
| Marks            | `close_adj`; screens and share counts read `close_unadj`                                                                                            |
| Risk-free hurdle | FRED DGS3MO, the 3-month constant-maturity bill yield, annualised and converted geometrically to a per-session hurdle (0.00%-5.63% across the pull) |
| Cost multiples   | 1x, 2x, 3x                                                                                                                                          |
| Trials on file   | 13 distinct configurations                                                                                                                          |
| Cache            | /Users/thomasseirer/repos/gcig-app/quant/data/cache                                                                                                 |
| Report           | /Users/thomasseirer/repos/gcig-app/quant/reports/stage3_sleeves.md                                                                                  |

## Spliced and absent history — read this before the tables

Two of the nine vehicles do not reach the sample start. Every number in this report covering these dates was produced by a book that was short a sleeve, and neither gap is filled with a proxy: the index alternatives to DBC roll differently, so a substitute would be a different sleeve wearing DBC's name, and every ETF stand-in for the early cash leg carries duration. **Nothing was held in place of either.** Before BIL listed the residual sat as uninvested balance earning nothing, which understates the strategy by roughly the bill rate times the time spent out — and bills paid 3-5% across 2005-2007, so that is not a rounding error.

| Sleeve                | Dates                    | What stood in                                                                                                | Why                                                                                                                                                                        |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cash (BIL)            | 2005-01-01 to 2007-05-29 | FRED DTB3 (3-month Treasury bill, secondary market discount rate) compounded daily into a total-return index | BIL did not exist before 2007-05-30 and every ETF substitute carries duration; a 1-3 year fund like SHY is not cash and lost money in 2022 while bills did not.            |
| Broad Commodity (DBC) | 2005-01-01 to 2006-02-05 | **nothing — the sleeve was not held**                                                                        | DBC listed 2006-02-06, thirteen months into the sample. No proxy: the index alternatives roll differently, so a substitute would be a different sleeve wearing DBC's name. |

## Headline

The Sharpe is not the number to read. `Deflated` is the probability the result survives the number of times this project has looked, and `Hurdle SR` is the annualised Sharpe the best of that many zero-skill trials would be expected to produce. A raw Sharpe printed without its trial count is the number this repository exists to stop reporting.

| Book                            | Costs | Sharpe | Deflated | Hurdle SR |    CAGR |    Vol |  Max DD | Turnover/yr | Cost drag |
| ------------------------------- | ----- | -----: | -------: | --------: | ------: | -----: | ------: | ----------: | --------: |
| Sleeve sizing (Layers 1+2)      | 1x    |   0.61 |    0.864 |      0.37 |  +5.35% |  5.99% |  -9.69% |        7.15 |  16.0 bps |
| Sleeve sizing (Layers 1+2)      | 2x    |   0.58 |    0.839 |      0.37 |  +5.21% |  5.99% |  -9.69% |        7.14 |  31.9 bps |
| Sleeve sizing (Layers 1+2)      | 3x    |   0.55 |    0.799 |      0.37 |  +5.00% |  5.99% |  -9.71% |        7.12 |  48.1 bps |
| 60/40 SPY/IEF, rebalanced daily | 1x    |   0.61 |    0.872 |      0.37 |  +7.82% | 10.29% | -30.32% |        0.38 |   0.8 bps |
| 60/40 SPY/IEF, rebalanced daily | 2x    |   0.61 |    0.870 |      0.37 |  +7.80% | 10.29% | -30.38% |        0.37 |   1.5 bps |
| 60/40 SPY/IEF, rebalanced daily | 3x    |   0.61 |    0.869 |      0.37 |  +7.79% | 10.29% | -30.41% |        0.38 |   2.4 bps |
| Buy and hold SPY                | 1x    |   0.55 |    0.802 |      0.37 | +10.69% | 18.29% | -53.18% |        0.02 |   0.1 bps |
| Buy and hold SPY                | 2x    |   0.55 |    0.802 |      0.37 | +10.69% | 18.28% | -53.18% |        0.02 |   0.3 bps |
| Buy and hold SPY                | 3x    |   0.55 |    0.802 |      0.37 | +10.68% | 18.28% | -53.17% |        0.02 |   0.4 bps |

Every book above pays the same spread, the same impact, the same buffer and the same settlement. The benchmarks carry no sleeve caps: those are the strategy's design rather than the account's rules.

One asymmetry is left in rather than equalised. The strategy sits in cash for its first 252 sessions while the three signals bank the windows they need, and both benchmarks deploy immediately. That is not a handicap somebody imposed — it is what the process could actually have done on those days — and papering over it by starting the benchmarks late would report a comparison nobody could have run.

## Deflated Sharpe, and the count it was deflated by

Bailey and Lopez de Prado (2014). N is 13 — the distinct configuration count in `trials.jsonl`, which includes every standalone signal diagnostic as well as the nine runs in this report, because a search does not become smaller by being spread across two files. Correlated variants of one idea are not N independent trials, so this count overstates N and therefore RAISES the hurdle — conservative in the only direction it is defensible to be wrong about a denominator we chose ourselves.

| Book                            | Costs | Trials |   Obs | Observed SR | Best-of-N hurdle |  Skew | Kurtosis |    PSR |    DSR | Clears 95% |
| ------------------------------- | ----- | -----: | ----: | ----------: | ---------------: | ----: | -------: | -----: | -----: | ---------- |
| Sleeve sizing (Layers 1+2)      | 1x    |     13 | 5,427 |       0.605 |            0.367 | -0.34 |     6.60 | 0.9973 | 0.8637 | no         |
| Sleeve sizing (Layers 1+2)      | 2x    |     13 | 5,427 |       0.582 |            0.367 | -0.34 |     6.59 | 0.9964 | 0.8395 | no         |
| Sleeve sizing (Layers 1+2)      | 3x    |     13 | 5,427 |       0.549 |            0.367 | -0.34 |     6.60 | 0.9943 | 0.7986 | no         |
| 60/40 SPY/IEF, rebalanced daily | 1x    |     13 | 5,427 |       0.612 |            0.367 |  0.07 |    17.25 | 0.9977 | 0.8716 | no         |
| 60/40 SPY/IEF, rebalanced daily | 2x    |     13 | 5,427 |       0.610 |            0.367 |  0.07 |    17.25 | 0.9976 | 0.8696 | no         |
| 60/40 SPY/IEF, rebalanced daily | 3x    |     13 | 5,427 |       0.609 |            0.367 |  0.07 |    17.24 | 0.9976 | 0.8688 | no         |
| Buy and hold SPY                | 1x    |     13 | 5,427 |       0.551 |            0.367 | -0.03 |    17.76 | 0.9946 | 0.8024 | no         |
| Buy and hold SPY                | 2x    |     13 | 5,427 |       0.551 |            0.367 | -0.03 |    17.75 | 0.9946 | 0.8021 | no         |
| Buy and hold SPY                | 3x    |     13 | 5,427 |       0.550 |            0.367 | -0.03 |    17.75 | 0.9946 | 0.8019 | no         |

Trial dispersion: assumed: 1/sqrt(T-1), the sampling dispersion of a zero-skill trial on a sample this long. No per-trial Sharpes were supplied.

```
13 trial(s), 5,427 observations: the best-of-N annualised Sharpe under the null is 0.37, observed 0.61. Deflated Sharpe 0.864 is below the 95% bar: the edge is not distinguishable from the best draw a search this wide would find by luck. Report it as insignificant, not as promising.
```

## Drawdown and recovery

`Time to recover` is measured from the trough back to the old high water mark. A drawdown that has not recovered says so rather than printing a zero, because a zero there reads as an instant recovery.

| Book                            | Costs |  Max DD | Peak       | Trough     | Sessions down | Recovered on | Time to recover           |
| ------------------------------- | ----- | ------: | ---------- | ---------- | ------------: | ------------ | ------------------------- |
| Sleeve sizing (Layers 1+2)      | 1x    |  -9.69% | 2020-02-21 | 2020-03-19 |            19 | 2020-07-21   | 85 sessions (124 days)    |
| Sleeve sizing (Layers 1+2)      | 2x    |  -9.69% | 2020-02-21 | 2020-03-19 |            19 | 2020-07-21   | 85 sessions (124 days)    |
| Sleeve sizing (Layers 1+2)      | 3x    |  -9.71% | 2020-02-21 | 2020-03-19 |            19 | 2020-07-21   | 85 sessions (124 days)    |
| 60/40 SPY/IEF, rebalanced daily | 1x    | -30.32% | 2007-12-10 | 2009-03-09 |           312 | 2010-09-24   | 391 sessions (564 days)   |
| 60/40 SPY/IEF, rebalanced daily | 2x    | -30.38% | 2007-12-10 | 2009-03-09 |           312 | 2010-09-24   | 391 sessions (564 days)   |
| 60/40 SPY/IEF, rebalanced daily | 3x    | -30.41% | 2007-12-10 | 2009-03-09 |           312 | 2010-09-24   | 391 sessions (564 days)   |
| Buy and hold SPY                | 1x    | -53.18% | 2007-10-09 | 2009-03-09 |           355 | 2012-08-16   | 869 sessions (1,256 days) |
| Buy and hold SPY                | 2x    | -53.18% | 2007-10-09 | 2009-03-09 |           355 | 2012-08-16   | 869 sessions (1,256 days) |
| Buy and hold SPY                | 3x    | -53.17% | 2007-10-09 | 2009-03-09 |           355 | 2012-08-16   | 869 sessions (1,256 days) |

## The worst 20 individual days, at 1x cost

Worth reading next to the drawdown table rather than instead of it. A book can have a mild worst day and a terrible drawdown (a long grind) or the reverse (one gap, then recovery), and the two failure modes need completely different answers.

One cost level, because a cost multiple moves a single day's return by basis points and these are the days it moved by per cent. The tables where the stress actually shows — headline, drawdown, period breakout, turnover — carry all three.

|   # | Sleeve sizing (Layers 1+2) — date | return | 60/40 SPY/IEF, rebalanced daily — date | return | Buy and hold SPY — date |  return |
| --: | --------------------------------- | -----: | -------------------------------------- | -----: | ----------------------- | ------: |
|   1 | 2013-06-20                        | -2.28% | 2020-03-12                             | -5.41% | 2020-03-16              | -10.76% |
|   2 | 2018-02-05                        | -2.22% | 2008-10-15                             | -5.32% | 2020-03-12              |  -9.41% |
|   3 | 2020-03-18                        | -2.09% | 2020-03-16                             | -5.23% | 2008-10-15              |  -9.30% |
|   4 | 2020-03-12                        | -2.01% | 2008-12-01                             | -4.60% | 2008-12-01              |  -8.32% |
|   5 | 2020-03-11                        | -1.93% | 2008-10-09                             | -4.33% | 2020-03-09              |  -7.69% |
|   6 | 2020-03-17                        | -1.93% | 2020-03-09                             | -3.99% | 2008-09-29              |  -7.48% |
|   7 | 2018-02-08                        | -1.87% | 2008-09-29                             | -3.94% | 2008-11-20              |  -6.93% |
|   8 | 2025-04-04                        | -1.71% | 2020-03-18                             | -3.45% | 2008-10-09              |  -6.59% |
|   9 | 2007-02-27                        | -1.71% | 2008-11-20                             | -3.31% | 2011-08-08              |  -6.23% |
|  10 | 2026-06-05                        | -1.63% | 2008-11-06                             | -3.25% | 2008-11-19              |  -6.01% |
|  11 | 2021-02-25                        | -1.60% | 2008-11-19                             | -3.24% | 2025-04-04              |  -5.81% |
|  12 | 2010-02-04                        | -1.58% | 2025-04-04                             | -3.19% | 2020-06-11              |  -5.68% |
|  13 | 2024-12-18                        | -1.56% | 2020-03-11                             | -3.19% | 2008-11-06              |  -5.23% |
|  14 | 2018-02-02                        | -1.54% | 2020-06-11                             | -3.13% | 2008-10-22              |  -5.13% |
|  15 | 2011-09-23                        | -1.50% | 2011-08-08                             | -3.07% | 2020-03-18              |  -4.97% |
|  16 | 2024-08-05                        | -1.49% | 2009-01-20                             | -3.05% | 2009-01-20              |  -4.94% |
|  17 | 2026-01-30                        | -1.46% | 2008-10-24                             | -2.98% | 2025-04-03              |  -4.89% |
|  18 | 2018-10-10                        | -1.42% | 2022-06-13                             | -2.81% | 2008-10-06              |  -4.84% |
|  19 | 2023-02-03                        | -1.40% | 2008-10-22                             | -2.80% | 2020-03-11              |  -4.80% |
|  20 | 2014-01-24                        | -1.39% | 2025-04-10                             | -2.78% | 2008-10-24              |  -4.77% |

## The worst 10 months, at 1x cost

`sessions` is carried because the first and last months of a sample are usually stubs, and a two-day stub topping the table is an artefact of where the backtest starts rather than a month anybody lived through.

|   # | Sleeve sizing (Layers 1+2) — month | return | sessions | 60/40 SPY/IEF, rebalanced daily — month | return | sessions | Buy and hold SPY — month |  return | sessions |
| --: | ---------------------------------- | -----: | -------: | --------------------------------------- | -----: | -------: | ------------------------ | ------: | -------: |
|   1 | 2009-01                            | -5.23% |       20 | 2008-10                                 | -9.24% |       23 | 2008-10                  | -15.73% |       23 |
|   2 | 2018-02                            | -3.80% |       19 | 2022-09                                 | -7.04% |       21 | 2020-03                  | -12.27% |       22 |
|   3 | 2023-02                            | -3.73% |       19 | 2022-04                                 | -6.61% |       20 | 2009-02                  | -10.05% |       19 |
|   4 | 2018-10                            | -3.64% |       23 | 2009-02                                 | -6.39% |       19 | 2022-09                  |  -9.14% |       21 |
|   5 | 2026-03                            | -3.32% |       22 | 2009-01                                 | -6.01% |       20 | 2008-09                  |  -9.03% |       21 |
|   6 | 2020-03                            | -2.82% |       22 | 2020-03                                 | -5.61% |       22 | 2022-04                  |  -8.69% |       20 |
|   7 | 2015-08                            | -2.73% |       21 | 2008-09                                 | -5.34% |       21 | 2018-12                  |  -8.65% |       19 |
|   8 | 2010-05                            | -2.61% |       20 | 2022-06                                 | -4.99% |       21 | 2022-06                  |  -8.16% |       21 |
|   9 | 2013-06                            | -2.41% |       20 | 2008-06                                 | -4.40% |       21 | 2008-06                  |  -8.01% |       21 |
|  10 | 2016-11                            | -2.36% |       21 | 2018-10                                 | -4.07% |       23 | 2020-02                  |  -7.80% |       19 |

## Turnover and cost drag

Turnover counts every dollar that changed hands over average NAV, annualised: a book that replaces itself once a year scores 2.0 under this convention, not 1.0, because that is two trades and the cost was paid on both. The halved convention is more flattering and less true.

| Book                            | Costs | Fills | Traded notional | Turnover/yr |  Spread | Impact | Total cost | Drag on NAV | Per dollar traded |
| ------------------------------- | ----- | ----: | --------------: | ----------: | ------: | -----: | ---------: | ----------: | ----------------: |
| Sleeve sizing (Layers 1+2)      | 1x    | 6,183 |     $37,243,318 |       7.154 |  $7,352 |   $963 |     $8,315 |    16.0 bps |           2.2 bps |
| Sleeve sizing (Layers 1+2)      | 2x    | 6,203 |     $36,410,050 |       7.144 | $14,409 | $1,870 |    $16,280 |    31.9 bps |           4.5 bps |
| Sleeve sizing (Layers 1+2)      | 3x    | 6,180 |     $35,356,915 |       7.122 | $21,144 | $2,718 |    $23,862 |    48.1 bps |           6.7 bps |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 1,592 |      $2,451,632 |       0.377 |    $443 |    $68 |       $511 |     0.8 bps |           2.1 bps |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 1,544 |      $2,428,805 |       0.375 |    $869 |   $136 |     $1,005 |     1.5 bps |           4.1 bps |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 1,571 |      $2,436,736 |       0.376 |  $1,325 |   $204 |     $1,528 |     2.4 bps |           6.3 bps |
| Buy and hold SPY                | 1x    |    20 |        $124,338 |       0.015 |     $71 |    $32 |       $103 |     0.1 bps |           8.3 bps |
| Buy and hold SPY                | 2x    |    20 |        $124,219 |       0.015 |    $142 |    $64 |       $206 |     0.3 bps |          16.6 bps |
| Buy and hold SPY                | 3x    |    20 |        $124,101 |       0.015 |    $213 |    $96 |       $309 |     0.4 bps |          24.9 bps |

## The named windows, broken out

Each window is anchored on the last NAV BEFORE it opens rather than the first one inside it, so a period keeps its own first session. These windows overlap nothing and partition nothing — they are the four crises that happened plus the recent regime, cut identically for every book so the rows can be compared with each other. Each is ONE draw of a crisis; a statistic computed across 2008's sessions has an n far smaller than its T.

| Book                            | Costs | Period       | Sessions | Total return | Annualised |    Vol | Sharpe |  Max DD | Worst day |
| ------------------------------- | ----- | ------------ | -------: | -----------: | ---------: | -----: | -----: | ------: | --------: |
| Sleeve sizing (Layers 1+2)      | 1x    | 2008         |      253 |      +10.96% |    +10.93% |  8.08% |   1.15 |  -7.15% |    -1.26% |
| Sleeve sizing (Layers 1+2)      | 1x    | 2018Q4       |       63 |       -3.24% |    -12.02% |  4.87% |  -3.16 |  -4.36% |    -1.42% |
| Sleeve sizing (Layers 1+2)      | 1x    | 2020Q1       |       62 |       -3.30% |    -12.59% | 11.85% |  -1.18 |  -9.69% |    -2.09% |
| Sleeve sizing (Layers 1+2)      | 1x    | 2022         |      251 |       -5.72% |     -5.74% |  4.04% |  -1.96 |  -6.10% |    -1.39% |
| Sleeve sizing (Layers 1+2)      | 1x    | 2023-present |      897 |      +28.41% |     +7.23% |  6.48% |   0.41 |  -5.93% |    -1.71% |
| Sleeve sizing (Layers 1+2)      | 2x    | 2008         |      253 |      +10.25% |    +10.22% |  8.06% |   1.07 |  -7.63% |    -1.25% |
| Sleeve sizing (Layers 1+2)      | 2x    | 2018Q4       |       63 |       -2.98% |    -11.09% |  4.67% |  -3.07 |  -4.10% |    -1.33% |
| Sleeve sizing (Layers 1+2)      | 2x    | 2020Q1       |       62 |       -3.20% |    -12.22% | 11.97% |  -1.14 |  -9.69% |    -2.12% |
| Sleeve sizing (Layers 1+2)      | 2x    | 2022         |      251 |       -6.15% |     -6.17% |  4.03% |  -2.08 |  -6.50% |    -1.34% |
| Sleeve sizing (Layers 1+2)      | 2x    | 2023-present |      897 |      +28.13% |     +7.16% |  6.47% |   0.40 |  -5.87% |    -1.73% |
| Sleeve sizing (Layers 1+2)      | 3x    | 2008         |      253 |       +9.57% |     +9.55% |  8.08% |   1.00 |  -8.02% |    -1.27% |
| Sleeve sizing (Layers 1+2)      | 3x    | 2018Q4       |       63 |       -3.35% |    -12.41% |  4.87% |  -3.25 |  -4.45% |    -1.42% |
| Sleeve sizing (Layers 1+2)      | 3x    | 2020Q1       |       62 |       -3.33% |    -12.70% | 11.86% |  -1.19 |  -9.71% |    -2.09% |
| Sleeve sizing (Layers 1+2)      | 3x    | 2022         |      251 |       -5.94% |     -5.96% |  4.03% |  -2.02 |  -6.28% |    -1.39% |
| Sleeve sizing (Layers 1+2)      | 3x    | 2023-present |      897 |      +26.60% |     +6.80% |  6.48% |   0.35 |  -6.16% |    -1.70% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 2008         |      253 |      -16.25% |    -16.22% | 21.78% |  -0.77 | -26.81% |    -5.32% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 2018Q4       |       63 |       -6.43% |    -22.77% | 12.78% |  -2.20 | -10.19% |    -1.79% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 2020Q1       |       62 |       -7.61% |    -27.22% | 28.51% |  -1.03 | -18.51% |    -5.41% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 2022         |      251 |      -15.64% |    -15.69% | 15.02% |  -1.20 | -19.76% |    -2.81% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 2023-present |      897 |      +57.13% |    +13.44% |  9.10% |   0.94 | -10.04% |    -3.19% |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 2008         |      253 |      -16.31% |    -16.28% | 21.78% |  -0.77 | -26.83% |    -5.32% |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 2018Q4       |       63 |       -6.42% |    -22.72% | 12.77% |  -2.20 | -10.18% |    -1.78% |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 2020Q1       |       62 |       -7.63% |    -27.29% | 28.52% |  -1.03 | -18.52% |    -5.42% |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 2022         |      251 |      -15.73% |    -15.78% | 15.02% |  -1.21 | -19.81% |    -2.82% |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 2023-present |      897 |      +57.07% |    +13.43% |  9.11% |   0.93 | -10.06% |    -3.19% |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 2008         |      253 |      -16.35% |    -16.32% | 21.80% |  -0.77 | -26.89% |    -5.32% |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 2018Q4       |       63 |       -6.41% |    -22.70% | 12.77% |  -2.19 | -10.17% |    -1.78% |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 2020Q1       |       62 |       -7.64% |    -27.31% | 28.52% |  -1.03 | -18.52% |    -5.41% |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 2022         |      251 |      -15.72% |    -15.77% | 15.02% |  -1.21 | -19.81% |    -2.82% |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 2023-present |      897 |      +57.14% |    +13.44% |  9.11% |   0.94 | -10.04% |    -3.19% |
| Buy and hold SPY                | 1x    | 2008         |      253 |      -35.38% |    -35.32% | 38.96% |  -0.96 | -45.74% |    -9.30% |
| Buy and hold SPY                | 1x    | 2018Q4       |       63 |      -13.30% |    -42.58% | 23.26% |  -2.44 | -18.89% |    -3.19% |
| Buy and hold SPY                | 1x    | 2020Q1       |       62 |      -19.15% |    -57.40% | 53.92% |  -1.35 | -33.25% |   -10.76% |
| Buy and hold SPY                | 1x    | 2022         |      251 |      -18.00% |    -18.06% | 23.98% |  -0.80 | -24.27% |    -4.30% |
| Buy and hold SPY                | 1x    | 2023-present |      897 |     +103.12% |    +21.86% | 14.99% |   1.10 | -18.63% |    -5.81% |
| Buy and hold SPY                | 2x    | 2008         |      253 |      -35.37% |    -35.32% | 38.96% |  -0.96 | -45.74% |    -9.30% |
| Buy and hold SPY                | 2x    | 2018Q4       |       63 |      -13.30% |    -42.58% | 23.26% |  -2.44 | -18.89% |    -3.19% |
| Buy and hold SPY                | 2x    | 2020Q1       |       62 |      -19.15% |    -57.40% | 53.92% |  -1.35 | -33.24% |   -10.76% |
| Buy and hold SPY                | 2x    | 2022         |      251 |      -18.00% |    -18.06% | 23.98% |  -0.80 | -24.27% |    -4.30% |
| Buy and hold SPY                | 2x    | 2023-present |      897 |     +103.11% |    +21.86% | 14.99% |   1.10 | -18.63% |    -5.81% |
| Buy and hold SPY                | 3x    | 2008         |      253 |      -35.37% |    -35.31% | 38.95% |  -0.96 | -45.73% |    -9.30% |
| Buy and hold SPY                | 3x    | 2018Q4       |       63 |      -13.30% |    -42.58% | 23.26% |  -2.44 | -18.89% |    -3.19% |
| Buy and hold SPY                | 3x    | 2020Q1       |       62 |      -19.15% |    -57.40% | 53.92% |  -1.35 | -33.24% |   -10.76% |
| Buy and hold SPY                | 3x    | 2022         |      251 |      -18.00% |    -18.06% | 23.98% |  -0.80 | -24.27% |    -4.30% |
| Buy and hold SPY                | 3x    | 2023-present |      897 |     +103.11% |    +21.86% | 14.99% |   1.10 | -18.62% |    -5.81% |

## Settlement deferrals per year, at 1x cost

Split by cause, because a year of buffer deferrals and a year of settlement deferrals are different findings: the first says the reserve is too fat for the strategy's turnover, the second is the account type charging rent, and the third — no cash — is neither, it is a book that was simply fully invested. A single count per year reads as one phenomenon and is usually two.

One cost level again. A deferral is caused by the cash not being there, and a wider spread changes that by the cost of the trade — which is two orders of magnitude below the shortfalls in the last two columns.

| Book                            | Year | Deferrals | T+1 unsettled | Buffer | No cash | Total shortfall |   Worst |
| ------------------------------- | ---- | --------: | ------------: | -----: | ------: | --------------: | ------: |
| Sleeve sizing (Layers 1+2)      | 2006 |       303 |             4 |    299 |       0 |        $628,213 | $11,579 |
| Sleeve sizing (Layers 1+2)      | 2007 |       522 |             6 |    512 |       4 |      $1,092,113 | $11,651 |
| Sleeve sizing (Layers 1+2)      | 2008 |       469 |            15 |    454 |       0 |      $1,228,553 | $15,969 |
| Sleeve sizing (Layers 1+2)      | 2009 |       678 |            14 |    664 |       0 |      $1,779,077 | $13,858 |
| Sleeve sizing (Layers 1+2)      | 2010 |       677 |            11 |    666 |       0 |      $1,781,408 | $12,667 |
| Sleeve sizing (Layers 1+2)      | 2011 |       807 |             7 |    797 |       3 |      $2,330,731 | $18,601 |
| Sleeve sizing (Layers 1+2)      | 2012 |       716 |             7 |    709 |       0 |      $2,300,288 | $18,810 |
| Sleeve sizing (Layers 1+2)      | 2013 |       466 |            12 |    445 |       9 |      $1,691,989 | $20,327 |
| Sleeve sizing (Layers 1+2)      | 2014 |       728 |             5 |    723 |       0 |      $2,711,135 | $20,028 |
| Sleeve sizing (Layers 1+2)      | 2015 |       374 |            11 |    358 |       5 |      $1,656,590 | $23,912 |
| Sleeve sizing (Layers 1+2)      | 2016 |       578 |             4 |    573 |       1 |      $2,075,844 | $23,964 |
| Sleeve sizing (Layers 1+2)      | 2017 |       683 |             8 |    673 |       2 |      $2,618,119 | $19,691 |
| Sleeve sizing (Layers 1+2)      | 2018 |       222 |             3 |    216 |       3 |      $1,065,610 | $76,747 |
| Sleeve sizing (Layers 1+2)      | 2019 |       622 |             8 |    614 |       0 |      $2,856,408 | $24,017 |
| Sleeve sizing (Layers 1+2)      | 2020 |       761 |             8 |    752 |       1 |      $3,455,639 | $54,875 |
| Sleeve sizing (Layers 1+2)      | 2021 |       696 |             9 |    681 |       6 |      $3,589,012 | $75,489 |
| Sleeve sizing (Layers 1+2)      | 2022 |       157 |             5 |    143 |       9 |      $1,576,783 | $49,351 |
| Sleeve sizing (Layers 1+2)      | 2023 |       160 |             4 |    155 |       1 |        $795,538 | $33,709 |
| Sleeve sizing (Layers 1+2)      | 2024 |       488 |             5 |    483 |       0 |      $2,532,234 | $30,410 |
| Sleeve sizing (Layers 1+2)      | 2025 |       486 |             4 |    482 |       0 |      $2,558,872 | $19,782 |
| Sleeve sizing (Layers 1+2)      | 2026 |       122 |             3 |    119 |       0 |        $835,989 | $20,369 |
| 60/40 SPY/IEF, rebalanced daily | 2005 |        31 |             0 |     31 |       0 |         $15,927 |  $1,081 |
| 60/40 SPY/IEF, rebalanced daily | 2006 |        30 |             0 |     30 |       0 |         $17,145 |  $1,192 |
| 60/40 SPY/IEF, rebalanced daily | 2007 |        50 |             0 |     50 |       0 |         $38,981 |  $2,072 |
| 60/40 SPY/IEF, rebalanced daily | 2008 |       109 |             0 |    109 |       0 |        $115,673 |  $3,868 |
| 60/40 SPY/IEF, rebalanced daily | 2009 |        96 |             0 |     96 |       0 |         $77,485 |  $1,810 |
| 60/40 SPY/IEF, rebalanced daily | 2010 |        62 |             0 |     62 |       0 |         $53,012 |  $2,601 |
| 60/40 SPY/IEF, rebalanced daily | 2011 |        80 |             0 |     80 |       0 |         $86,360 |  $2,842 |
| 60/40 SPY/IEF, rebalanced daily | 2012 |        55 |             0 |     55 |       0 |         $49,214 |  $2,125 |
| 60/40 SPY/IEF, rebalanced daily | 2013 |        43 |             0 |     43 |       0 |         $39,358 |  $2,473 |
| 60/40 SPY/IEF, rebalanced daily | 2014 |        41 |             0 |     41 |       0 |         $46,462 |  $3,243 |
| 60/40 SPY/IEF, rebalanced daily | 2015 |        44 |             0 |     44 |       0 |         $59,625 |  $4,751 |
| 60/40 SPY/IEF, rebalanced daily | 2016 |        42 |             0 |     42 |       0 |         $56,952 |  $2,881 |
| 60/40 SPY/IEF, rebalanced daily | 2017 |        16 |             0 |     16 |       0 |         $20,737 |  $2,425 |
| 60/40 SPY/IEF, rebalanced daily | 2018 |        55 |             0 |     55 |       0 |         $76,234 |  $4,980 |
| 60/40 SPY/IEF, rebalanced daily | 2019 |        50 |             0 |     50 |       0 |         $79,114 |  $4,140 |
| 60/40 SPY/IEF, rebalanced daily | 2020 |        71 |             0 |     71 |       0 |        $179,563 | $11,205 |
| 60/40 SPY/IEF, rebalanced daily | 2021 |        40 |             0 |     40 |       0 |         $74,772 |  $4,223 |
| 60/40 SPY/IEF, rebalanced daily | 2022 |        78 |             0 |     78 |       0 |        $180,394 |  $6,522 |
| 60/40 SPY/IEF, rebalanced daily | 2023 |        45 |             0 |     45 |       0 |         $91,211 |  $4,611 |
| 60/40 SPY/IEF, rebalanced daily | 2024 |        37 |             0 |     37 |       0 |         $89,871 | $12,250 |
| 60/40 SPY/IEF, rebalanced daily | 2025 |        44 |             0 |     44 |       0 |        $138,965 | $12,501 |
| 60/40 SPY/IEF, rebalanced daily | 2026 |        22 |             0 |     22 |       0 |         $55,496 |  $5,318 |
| Buy and hold SPY                | 2005 |         1 |             0 |      1 |       0 |             $11 |     $11 |

## Liquidity of what was held

Measured across every (session, sleeve) cell the book actually held. This is the capacity claim in its falsifiable form: at this fund's size none of it binds, and the honest way to say so is a number with the worst case named rather than a sentence.

| Book                            | Costs | Held cells |        Mean ADV |      Median ADV | Largest position | % of that name's ADV | Where             |
| ------------------------------- | ----- | ---------: | --------------: | --------------: | ---------------: | -------------------: | ----------------- |
| Sleeve sizing (Layers 1+2)      | 1x    |     33,851 |  $4,156,106,251 |    $970,632,879 |         $130,347 |              0.9166% | BIL on 2013-08-14 |
| Sleeve sizing (Layers 1+2)      | 2x    |     34,365 |  $4,095,858,738 |    $955,394,958 |         $128,698 |              0.9050% | BIL on 2013-08-14 |
| Sleeve sizing (Layers 1+2)      | 3x    |     33,856 |  $4,159,121,570 |    $972,595,802 |         $125,080 |              0.8795% | BIL on 2013-08-14 |
| 60/40 SPY/IEF, rebalanced daily | 1x    |     10,849 | $12,417,249,934 |  $5,625,721,868 |          $52,802 |              0.6609% | IEF on 2006-02-17 |
| 60/40 SPY/IEF, rebalanced daily | 2x    |     10,849 | $12,417,249,934 |  $5,625,721,868 |          $52,551 |              0.6578% | IEF on 2006-02-17 |
| 60/40 SPY/IEF, rebalanced daily | 3x    |     10,849 | $12,417,249,934 |  $5,625,721,868 |          $52,633 |              0.6588% | IEF on 2006-02-17 |
| Buy and hold SPY                | 1x    |      5,426 | $24,529,428,578 | $22,305,343,655 |         $922,340 |             0.43 bps | SPY on 2024-12-26 |
| Buy and hold SPY                | 2x    |      5,426 | $24,529,428,578 | $22,305,343,655 |         $921,463 |             0.43 bps | SPY on 2024-12-26 |
| Buy and hold SPY                | 3x    |      5,426 | $24,529,428,578 | $22,305,343,655 |         $920,587 |             0.43 bps | SPY on 2024-12-26 |

## The three equity sleeves, combined

US equity, developed international and emerging markets are capped at 40%, 25% and 15%. They sum to 80% and there is no group cap over them, so the correlation haircut is the only thing standing between the design and an 80% equity book. Whether it binds is this table.

| Book                            | Costs |   Mean | Median | 95th pct | Maximum | Reached on | Max as a share of the 80% cap sum |
| ------------------------------- | ----- | -----: | -----: | -------: | ------: | ---------- | --------------------------------: |
| Sleeve sizing (Layers 1+2)      | 1x    | 28.37% | 32.58% |   49.13% |  63.32% | 2024-07-05 |                            79.15% |
| Sleeve sizing (Layers 1+2)      | 2x    | 28.39% | 32.42% |   49.01% |  63.55% | 2025-02-21 |                            79.43% |
| Sleeve sizing (Layers 1+2)      | 3x    | 28.36% | 32.31% |   49.00% |  62.66% | 2017-02-14 |                            78.32% |
| 60/40 SPY/IEF, rebalanced daily | 1x    | 56.91% | 57.07% |   57.55% |  58.92% | 2008-10-13 |                                 — |
| 60/40 SPY/IEF, rebalanced daily | 2x    | 56.92% | 57.07% |   57.55% |  58.92% | 2008-10-13 |                                 — |
| 60/40 SPY/IEF, rebalanced daily | 3x    | 56.91% | 57.07% |   57.54% |  58.93% | 2008-10-13 |                                 — |
| Buy and hold SPY                | 1x    | 97.12% | 97.63% |   99.32% |  99.45% | 2026-06-02 |                                 — |
| Buy and hold SPY                | 2x    | 97.11% | 97.62% |   99.32% |  99.45% | 2026-06-02 |                                 — |
| Buy and hold SPY                | 3x    | 97.10% | 97.62% |   99.31% |  99.44% | 2026-06-02 |                                 — |

Year by year, for the strategy at 1x cost:

| Year | Mean equity weight | Maximum | Reached on |
| ---- | -----------------: | ------: | ---------- |
| 2005 |              0.00% |   0.00% | 2005-01-03 |
| 2006 |             34.14% |  56.39% | 2006-03-22 |
| 2007 |             33.03% |  47.56% | 2007-02-02 |
| 2008 |              4.05% |  19.24% | 2008-06-20 |
| 2009 |             17.97% |  39.10% | 2009-12-28 |
| 2010 |             28.69% |  44.35% | 2010-01-11 |
| 2011 |             24.77% |  42.84% | 2011-02-08 |
| 2012 |             29.32% |  38.49% | 2012-12-07 |
| 2013 |             44.14% |  60.72% | 2013-06-19 |
| 2014 |             36.19% |  58.54% | 2014-01-22 |
| 2015 |             29.47% |  47.16% | 2015-05-04 |
| 2016 |             24.05% |  46.97% | 2016-12-27 |
| 2017 |             44.89% |  62.55% | 2017-02-14 |
| 2018 |             32.04% |  54.68% | 2018-02-02 |
| 2019 |             23.74% |  39.75% | 2019-11-08 |
| 2020 |             22.82% |  39.80% | 2020-01-13 |
| 2021 |             41.84% |  55.97% | 2021-05-03 |
| 2022 |              7.77% |  29.73% | 2022-01-03 |
| 2023 |             31.69% |  49.25% | 2023-07-31 |
| 2024 |             43.78% |  63.32% | 2024-07-05 |
| 2025 |             35.93% |  62.50% | 2025-02-21 |
| 2026 |             38.35% |  47.90% | 2026-05-22 |

### Which step did the cutting

The column that matters is `Correlation bound`. If the haircut is almost never the binding step, the equity exposure above is being held down by trend instead — which is a different system from the one the design describes, and it should be described that way.

| Sleeve | Sessions sized | Trend bound | Inv-vol bound | Correlation bound | Cap bound | Budget bound | Mean haircut | Worst haircut |
| ------ | -------------: | ----------: | ------------: | ----------------: | --------: | -----------: | -----------: | ------------: |
| EEM    |          5,175 |      55.46% |        29.76% |             1.16% |     0.00% |       13.62% |       0.0535 |        0.4175 |
| EFA    |          5,175 |      52.95% |         6.24% |             8.00% |     0.00% |       32.81% |       0.0534 |        0.4561 |
| SPY    |          5,175 |      38.84% |         3.79% |             8.08% |     3.30% |       45.99% |       0.0268 |        0.4561 |

## What was attacked before any of this was believed

A clean number nobody attacked is not a result. Each row is a way the tables above could be wrong while looking exactly like this.

| Check                                                       |      | What was measured                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weights at T survive truncation after T                     | PASS | the whole book recomputed on the frame cut at 2020-02-06: identical across 8 sleeves                                                                                                                                                                                                                                                                                     |
| Fills land at the NEXT open                                 | PASS | 6,183 fills, every one strictly after its decision (median lag 1 calendar day(s)) and priced at that session's own unadjusted open to the last bit                                                                                                                                                                                                                       |
| Positions are marked in total-return space                  | PASS | 6 closing position(s) marked at `close_adj`; across the panel 25,991 ticker-days carry an adjusted close that differs from the as-traded one, on 5 of 6 held sleeve(s) (BIL, DBC, EEM, EFA, SPY), so the two frames are genuinely different series. Measured panel-wide because back-adjustment anchors at the final bar, where the two agree everywhere by construction |
| Trading costs are charged inside the loop                   | PASS | $8,314.58 at 1x ($7,351.59 spread, $963.00 impact), $23,862.43 at 3x — a ratio of 2.87 against a nominal 3, which will not be exact because the multiple changes the fills and therefore the book                                                                                                                                                                        |
| Nothing traded before the warmup completed                  | PASS | 252-session warmup (253 closes banked before the first decision); 0 fill(s) before 2006-01-04                                                                                                                                                                                                                                                                            |
| Cash is conserved: settled + unsettled + market value = NAV | PASS | checked inside the loop on every one of 5,428 sessions; closing residual $0.000000                                                                                                                                                                                                                                                                                       |
| Strategy Sharpe at 1x stays under 1.2                       | PASS | 0.605 annualised, excess of the bill series. Above 1.2 the brief's instruction is to treat it as evidence of a bug and hunt through the six rows above before reporting it                                                                                                                                                                                               |
| Both benchmarks actually deployed                           | PASS | buy-and-hold SPY finished 99.4% invested against the 95% it was bought to — a latched book is never rebalanced, so the weight drifts with the position. A benchmark sitting in cash would flatter everything measured against it                                                                                                                                         |

## What this does and does not prove

It reports what a specific set of rules would have produced on a specific twenty-year window, with frictions charged rather than assumed away and with the number of looks written down. It does not establish an edge: the sample contains one credit crisis, one pandemic crash and one inflation shock, each of them a single draw, and for most of it falling yields paid the bond sleeves to be a hedge — a relationship that ended in 2022 and has not resumed.

Nothing here is out of sample. The holdout in `config.HOLDOUT_YEARS` is the one defence against that and it is a weak one on purpose: three years is a handful of quarters and one look, and if anything is changed in response to it, it stops being a holdout and there is not a second one waiting.

_Generated 2026-08-02 23:37 UTC by `run_sleeves.py`._
