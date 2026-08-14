# Signal evaluation — each one alone, before the blend

Stage 3, gate one. Trend, inverse volatility and correlation measured separately, on their own claims, over the whole sample and broken out by sub-period. Nothing here has seen a portfolio. Read it before `reports/stage3_sleeves.md`, because a blend of three signals that individually say nothing is not a system.

**All 3 pairs sit inside ±0.60 (worst inverse_vol/correlation at -0.053). The ensemble's premise survives this test: the three are not restatements of each other. That is a statement about their scores and not about any of them being right.**

## The pull

|                  |                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source           | Tiingo daily EOD (sleeve ETFs only)                                                                                                                 |
| Sample           | 2005-01-03 to 2026-07-31                                                                                                                            |
| Sessions         | 5,428                                                                                                                                               |
| Sleeve vehicles  | BIL, DBC, EEM, EFA, GLD, IEF, LQD, SPY, TLT                                                                                                         |
| Prices           | `close_adj`, total return, and nothing else                                                                                                         |
| Risk-free hurdle | FRED DGS3MO, the 3-month constant-maturity bill yield, annualised and converted geometrically to a per-session hurdle (0.00%-5.63% across the pull) |
| Cache            | /Users/thomasseirer/repos/gcig-app/quant/data/cache                                                                                                 |
| Bootstrap        | 1,000 resamples, seed 20050103, 95% interval                                                                                                        |
| Report           | /Users/thomasseirer/repos/gcig-app/quant/reports/signal_evaluation.md                                                                               |

### Spliced and absent history

Two of the nine vehicles do not reach the sample start, and a reader must not have to know that to read a table correctly. Every figure below covering these dates is computed over a book that was short a sleeve.

| Sleeve                | Dates                    | What stood in                                                                                                | Why                                                                                                                                                                        |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cash (BIL)            | 2005-01-01 to 2007-05-29 | FRED DTB3 (3-month Treasury bill, secondary market discount rate) compounded daily into a total-return index | BIL did not exist before 2007-05-30 and every ETF substitute carries duration; a 1-3 year fund like SHY is not cash and lost money in 2022 while bills did not.            |
| Broad Commodity (DBC) | 2005-01-01 to 2006-02-05 | **nothing — the sleeve was not held**                                                                        | DBC listed 2006-02-06, thirteen months into the sample. No proxy: the index alternatives roll differently, so a substitute would be a different sleeve wearing DBC's name. |

## Trend

The only signal in this system that can ask a long-only book to get out, and therefore the one whose failure costs the most. The score is the fraction of a sleeve's cap to take, taking one of 4 values.

| Convention      | What it means                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| risk_free       | excess of a supplied annualised risk-free series (0.00%-5.63%), converted geometrically to daily                                                                                |
| prices          | close_adj only. On close_unadj the bond and credit sleeves return roughly nothing over the sample and the signal would learn that coupons do not exist.                         |
| forward_returns | close of T to close of T+h, excess of cash — includes the overnight gap the engine cannot trade, so the IC, hit rate and spread tables are an upper bound                       |
| curve_fill      | weight decided at the close of T takes effect 2 sessions later, forfeiting the fill session's intraday move rather than claiming an overnight gap in the signal's own direction |
| costs           | 5.00 bps one-way on every weight change, against a costless buy-and-hold benchmark                                                                                              |
| interval        | 95% moving-block bootstrap, 1,000 resamples, seed 20050103; blocks are whole dates so the cross-sectional correlation between sleeves survives resampling                       |
| excluded        | BIL                                                                                                                                                                             |

The first three tables run from the close of T and therefore include the overnight gap the engine cannot trade: they are an UPPER bound on what is collectable. The curve at the bottom uses a 2-session lag and is the lower one. The gap between them is a known quantity rather than a puzzle.

### Information coefficient — pooled, by sub-period

Spearman, because the score takes four values and forward returns are fat-tailed. The interval is a moving-block bootstrap over whole DATES: nine sleeves on one day are not nine independent observations, and resampling cells rather than dates would shrink the interval by about a factor of three. `kind` is `year` only for the rows that partition the sample — the stress windows overlap each other and the years, so nothing in this table sums.

| Period       | Kind   |   h |    Obs |      IC |  CI low | CI high | Blocks | Note                                                                                                            |
| ------------ | ------ | --: | -----: | ------: | ------: | ------: | -----: | --------------------------------------------------------------------------------------------------------------- |
| 2005         | year   |  1d |      0 |       — |       — |       — |      0 | no scored session with a forward return in this window                                                          |
| 2006         | year   |  1d |  1,757 |  0.0408 | -0.0397 |  0.1033 |     11 |                                                                                                                 |
| 2007         | year   |  1d |  1,984 | -0.0010 | -0.0662 |  0.0507 |     11 |                                                                                                                 |
| 2008         | year   |  1d |  2,024 |  0.0550 |  0.0209 |  0.1035 |     12 |                                                                                                                 |
| 2009         | year   |  1d |  2,016 | -0.0086 | -0.0791 |  0.0395 |     12 |                                                                                                                 |
| 2010         | year   |  1d |  2,016 | -0.0183 | -0.0774 |  0.0268 |     12 |                                                                                                                 |
| 2011         | year   |  1d |  2,016 | -0.0126 | -0.0781 |  0.0522 |     12 |                                                                                                                 |
| 2012         | year   |  1d |  2,000 | -0.0440 | -0.1298 |  0.0289 |     11 |                                                                                                                 |
| 2013         | year   |  1d |  2,016 |  0.0225 | -0.0093 |  0.0561 |     12 |                                                                                                                 |
| 2014         | year   |  1d |  2,016 |  0.0318 | -0.0277 |  0.0810 |     12 |                                                                                                                 |
| 2015         | year   |  1d |  2,016 |  0.0023 | -0.0511 |  0.0414 |     12 |                                                                                                                 |
| 2016         | year   |  1d |  2,016 | -0.0327 | -0.0956 |  0.0047 |     12 |                                                                                                                 |
| 2017         | year   |  1d |  2,008 |  0.0164 | -0.0431 |  0.0671 |     11 |                                                                                                                 |
| 2018         | year   |  1d |  2,008 |  0.0284 | -0.0297 |  0.0491 |     11 |                                                                                                                 |
| 2018Q4       | stress |  1d |    504 |  0.0102 |       — |       — |      3 | 3 block(s) of 21 sessions — fewer than 5, so no interval is reported rather than a wide one that looks computed |
| 2019         | year   |  1d |  2,016 | -0.0312 | -0.0887 |  0.0373 |     12 |                                                                                                                 |
| 2020         | year   |  1d |  2,024 | -0.0346 | -0.0940 |  0.0264 |     12 |                                                                                                                 |
| 2020Q1       | stress |  1d |    496 |  0.0803 |       — |       — |      2 | 2 block(s) of 21 sessions — fewer than 5, so no interval is reported rather than a wide one that looks computed |
| 2021         | year   |  1d |  2,016 |  0.0487 | -0.0062 |  0.0996 |     12 |                                                                                                                 |
| 2022         | year   |  1d |  2,008 |  0.0152 | -0.0429 |  0.0758 |     11 |                                                                                                                 |
| 2023         | year   |  1d |  2,000 | -0.0189 | -0.0628 |  0.0095 |     11 |                                                                                                                 |
| 2023-present | stress |  1d |  7,168 |  0.0094 | -0.0186 |  0.0407 |     42 |                                                                                                                 |
| 2024         | year   |  1d |  2,016 | -0.0157 | -0.0671 |  0.0288 |     12 |                                                                                                                 |
| 2025         | year   |  1d |  2,000 |  0.0044 | -0.0442 |  0.0475 |     11 |                                                                                                                 |
| 2026         | year   |  1d |  1,152 |  0.0622 | -0.0159 |  0.1077 |      6 |                                                                                                                 |
| full sample  | full   |  1d | 41,125 |  0.0202 |  0.0061 |  0.0335 |    246 |                                                                                                                 |
| 2005         | year   | 21d |      0 |       — |       — |       — |      0 | no scored session with a forward return in this window                                                          |
| 2006         | year   | 21d |  1,757 |  0.1066 | -0.1884 |  0.4153 |      5 |                                                                                                                 |
| 2007         | year   | 21d |  1,984 | -0.0086 | -0.2676 |  0.1610 |      5 |                                                                                                                 |
| 2008         | year   | 21d |  2,024 |  0.1544 | -0.0761 |  0.3416 |      6 |                                                                                                                 |
| 2009         | year   | 21d |  2,016 | -0.1352 | -0.3903 | -0.0013 |      6 |                                                                                                                 |
| 2010         | year   | 21d |  2,016 | -0.1095 | -0.2536 | -0.0135 |      6 |                                                                                                                 |
| 2011         | year   | 21d |  2,016 |  0.0419 | -0.1651 |  0.2882 |      6 |                                                                                                                 |
| 2012         | year   | 21d |  2,000 | -0.1911 | -0.4604 |  0.0512 |      5 |                                                                                                                 |
| 2013         | year   | 21d |  2,016 |  0.1150 |  0.0323 |  0.2561 |      6 |                                                                                                                 |
| 2014         | year   | 21d |  2,016 |  0.0924 | -0.0973 |  0.3016 |      6 |                                                                                                                 |
| 2015         | year   | 21d |  2,016 |  0.0002 | -0.2012 |  0.1612 |      6 |                                                                                                                 |
| 2016         | year   | 21d |  2,016 | -0.2839 | -0.5258 | -0.0584 |      6 |                                                                                                                 |
| 2017         | year   | 21d |  2,008 |  0.1334 | -0.0543 |  0.2402 |      5 |                                                                                                                 |
| 2018         | year   | 21d |  2,008 | -0.1679 | -0.2594 |  0.0713 |      5 |                                                                                                                 |
| 2018Q4       | stress | 21d |    504 | -0.2409 |       — |       — |      1 | 1 block(s) of 42 sessions — fewer than 5, so no interval is reported rather than a wide one that looks computed |
| 2019         | year   | 21d |  2,016 | -0.1225 | -0.3338 |  0.1606 |      6 |                                                                                                                 |
| 2020         | year   | 21d |  2,024 | -0.2023 | -0.4920 |  0.0526 |      6 |                                                                                                                 |
| 2020Q1       | stress | 21d |    496 | -0.0577 |       — |       — |      1 | 1 block(s) of 42 sessions — fewer than 5, so no interval is reported rather than a wide one that looks computed |
| 2021         | year   | 21d |  2,016 |  0.0765 | -0.1380 |  0.2033 |      6 |                                                                                                                 |
| 2022         | year   | 21d |  2,008 |  0.0235 | -0.3184 |  0.2674 |      5 |                                                                                                                 |
| 2023         | year   | 21d |  2,000 | -0.0656 | -0.1802 |  0.0640 |      5 |                                                                                                                 |
| 2023-present | stress | 21d |  7,008 |  0.0345 | -0.0749 |  0.1433 |     20 |                                                                                                                 |
| 2024         | year   | 21d |  2,016 |  0.0074 | -0.1436 |  0.1334 |      6 |                                                                                                                 |
| 2025         | year   | 21d |  2,000 |  0.0246 | -0.1036 |  0.1802 |      5 |                                                                                                                 |
| 2026         | year   | 21d |    992 |  0.0470 |       — |       — |      2 | 2 block(s) of 42 sessions — fewer than 5, so no interval is reported rather than a wide one that looks computed |
| full sample  | full   | 21d | 40,965 |  0.0377 | -0.0182 |  0.0952 |    122 |                                                                                                                 |

### Information coefficient — per sleeve, full sample

| Sleeve | Kind |   h |   Obs |      IC |  CI low | CI high | Blocks | Note |
| ------ | ---- | --: | ----: | ------: | ------: | ------: | -----: | ---- |
| DBC    | full |  1d | 4,900 |  0.0437 |  0.0129 |  0.0749 |    233 |      |
| EEM    | full |  1d | 5,175 |  0.0092 | -0.0173 |  0.0335 |    246 |      |
| EFA    | full |  1d | 5,175 | -0.0077 | -0.0331 |  0.0182 |    246 |      |
| GLD    | full |  1d | 5,175 |  0.0341 |  0.0088 |  0.0568 |    246 |      |
| IEF    | full |  1d | 5,175 |  0.0193 | -0.0104 |  0.0422 |    246 |      |
| LQD    | full |  1d | 5,175 |  0.0103 | -0.0176 |  0.0389 |    246 |      |
| SPY    | full |  1d | 5,175 | -0.0185 | -0.0433 |  0.0079 |    246 |      |
| TLT    | full |  1d | 5,175 |  0.0095 | -0.0182 |  0.0349 |    246 |      |
| DBC    | full | 21d | 4,880 |  0.0952 | -0.0218 |  0.2176 |    116 |      |
| EEM    | full | 21d | 5,155 |  0.0066 | -0.0976 |  0.1221 |    122 |      |
| EFA    | full | 21d | 5,155 | -0.0437 | -0.1473 |  0.0559 |    122 |      |
| GLD    | full | 21d | 5,155 |  0.0404 | -0.0694 |  0.1446 |    122 |      |
| IEF    | full | 21d | 5,155 |  0.0578 | -0.0585 |  0.1510 |    122 |      |
| LQD    | full | 21d | 5,155 |  0.0308 | -0.0956 |  0.1357 |    122 |      |
| SPY    | full | 21d | 5,155 | -0.1110 | -0.2277 |  0.0056 |    122 |      |
| TLT    | full | 21d | 5,155 |  0.0211 | -0.0884 |  0.1306 |    122 |      |

### Hit rate at the two ends of the range

Measured only where the signal is unambiguous — full conviction and none — because any interior threshold would be a parameter chosen by looking at the answer. The base rate travels in the same row: in a sample where two thirds of months are positive, a 66% hit rate is the market and not the signal, and `lift` is the column to read.

| Period       |   h | Full-on obs | Hit, full on |    Lift | Full-off obs | Hit, full off |    Lift | Base rate up |
| ------------ | --: | ----------: | -----------: | ------: | -----------: | ------------: | ------: | -----------: |
| 2005         |  1d |           0 |            — |       — |            0 |             — |       — |            — |
| 2006         |  1d |         726 |       53.99% |  +1.75% |          322 |        52.48% |  +4.73% |       52.25% |
| 2007         |  1d |       1,030 |       53.69% |  +0.21% |          112 |        39.29% |  -7.24% |       53.48% |
| 2008         |  1d |         631 |       53.41% |  +2.72% |          725 |        51.86% |  +2.55% |       50.69% |
| 2009         |  1d |         632 |       52.22% |  -0.02% |          270 |        45.93% |  -1.84% |       52.23% |
| 2010         |  1d |       1,186 |       54.72% |  +0.60% |          103 |        42.72% |  -3.16% |       54.12% |
| 2011         |  1d |       1,102 |       54.81% |  +0.10% |          149 |        45.64% |  +0.35% |       54.71% |
| 2012         |  1d |         910 |       54.07% |  -0.48% |          163 |        44.79% |  -0.66% |       54.55% |
| 2013         |  1d |         658 |       53.95% |  +2.51% |          616 |        47.40% |  -1.16% |       51.44% |
| 2014         |  1d |       1,036 |       54.92% |  +2.34% |          369 |        52.30% |  +4.88% |       52.58% |
| 2015         |  1d |         546 |       50.55% |  +1.74% |          583 |        52.49% |  +1.30% |       48.81% |
| 2016         |  1d |         888 |       51.46% |  -0.57% |          278 |        47.84% |  -0.12% |       52.03% |
| 2017         |  1d |       1,044 |       54.69% |  -0.14% |          142 |        49.30% |  +4.13% |       54.83% |
| 2018         |  1d |         510 |       52.16% |  +1.96% |          695 |        51.22% |  +1.42% |       50.20% |
| 2018Q4       |  1d |          24 |       37.50% | -10.52% |          342 |        53.22% |  +1.23% |       48.02% |
| 2019         |  1d |         977 |       56.50% |  -0.49% |          238 |        41.18% |  -1.83% |       56.99% |
| 2020         |  1d |       1,108 |       55.96% |  +0.42% |          267 |        45.69% |  +1.23% |       55.53% |
| 2020Q1       |  1d |         318 |       57.23% |  +4.41% |          103 |        53.40% |  +6.22% |       52.82% |
| 2021         |  1d |         889 |       55.46% |  +3.17% |          206 |        51.46% |  +3.74% |       52.28% |
| 2022         |  1d |         204 |       57.35% |  +9.74% |        1,273 |        53.02% |  +0.63% |       47.61% |
| 2023         |  1d |         299 |       49.50% |  -0.75% |          579 |        45.42% |  -4.33% |       50.25% |
| 2023-present |  1d |       2,865 |       53.19% |  +0.91% |        1,282 |        45.63% |  -2.08% |       52.29% |
| 2024         |  1d |       1,000 |       51.40% |  -1.13% |          274 |        45.62% |  -1.85% |       52.53% |
| 2025         |  1d |         977 |       55.58% |  +1.18% |          283 |        43.11% |  -2.49% |       54.40% |
| 2026         |  1d |         589 |       54.16% |  +2.42% |          146 |        51.37% |  +3.11% |       51.74% |
| full sample  |  1d |      16,942 |       54.05% |  +1.49% |        7,793 |        49.20% |  +1.75% |       52.55% |
| 2005         | 21d |           0 |            — |       — |            0 |             — |       — |            — |
| 2006         | 21d |         726 |       61.16% |  +4.18% |          322 |        56.83% | +13.80% |       56.97% |
| 2007         | 21d |       1,030 |       58.64% |  -2.10% |          112 |        13.39% | -25.87% |       60.74% |
| 2008         | 21d |         631 |       51.98% |  +6.08% |          725 |        59.03% |  +4.93% |       45.90% |
| 2009         | 21d |         632 |       61.55% |  -1.35% |          270 |        40.37% |  +3.27% |       62.90% |
| 2010         | 21d |       1,186 |       62.90% |  -0.69% |          103 |        34.95% |  -1.46% |       63.59% |
| 2011         | 21d |       1,102 |       63.16% |  +2.69% |          149 |        42.28% |  +2.75% |       60.47% |
| 2012         | 21d |         910 |       52.86% |  -4.69% |          163 |        17.79% | -24.66% |       57.55% |
| 2013         | 21d |         658 |       56.53% |  +7.18% |          616 |        53.57% |  +2.93% |       49.36% |
| 2014         | 21d |       1,036 |       65.83% |  +5.02% |          369 |        46.61% |  +7.43% |       60.81% |
| 2015         | 21d |         546 |       42.31% |  -1.14% |          583 |        53.34% |  -3.20% |       43.45% |
| 2016         | 21d |         888 |       54.39% |  -6.52% |          278 |        18.35% | -20.74% |       60.91% |
| 2017         | 21d |       1,044 |       73.85% |  +6.92% |          142 |        33.10% |  +0.03% |       66.93% |
| 2018         | 21d |         510 |       34.71% |  -9.57% |          695 |        48.20% |  -7.53% |       44.27% |
| 2018Q4       | 21d |          24 |        0.00% | -54.56% |          342 |        43.27% |  -2.16% |       54.56% |
| 2019         | 21d |         977 |       66.73% |  -0.73% |          238 |        12.61% | -19.93% |       67.46% |
| 2020         | 21d |       1,108 |       56.77% |  -5.48% |          267 |        24.34% | -13.40% |       62.25% |
| 2020Q1       | 21d |         318 |       53.46% |  +0.23% |          103 |        49.51% |  +2.74% |       53.23% |
| 2021         | 21d |         889 |       60.97% |  +3.63% |          206 |        32.04% | -10.62% |       57.34% |
| 2022         | 21d |         204 |       52.45% | +10.77% |        1,273 |        59.47% |  +1.15% |       41.68% |
| 2023         | 21d |         299 |       40.47% |  -5.43% |          579 |        48.53% |  -5.57% |       45.90% |
| 2023-present | 21d |       2,806 |       57.31% |  +2.07% |        1,229 |        41.58% |  -3.18% |       55.24% |
| 2024         | 21d |       1,000 |       54.90% |  -0.61% |          274 |        42.34% |  -2.16% |       55.51% |
| 2025         | 21d |         977 |       68.17% |  +0.92% |          283 |        19.79% | -12.96% |       67.25% |
| 2026         | 21d |         530 |       51.32% |  +2.03% |           93 |        62.37% | +11.66% |       49.29% |
| full sample  | 21d |      16,883 |       58.89% |  +2.51% |        7,740 |        45.71% |  +2.09% |       56.38% |

### Top-minus-bottom spread

Mean forward excess return on full-on days less the mean on full-off days. *The annualised column is a scaling of an overlapping-window mean and is for reading aloud; nobody collected it.

| Period       |   h |     On |   Off |  Mean, on | Mean, off | Spread | Annualised* |
| ------------ | --: | -----: | ----: | --------: | --------: | -----: | ----------: |
| 2005         |  1d |      0 |     0 |         — |         — |      — |           — |
| 2006         |  1d |    726 |   322 |    +0.03% | -0.03 bps | +0.03% |      +6.90% |
| 2007         |  1d |  1,030 |   112 |    +0.04% |    +0.19% | -0.15% |     -30.76% |
| 2008         |  1d |    631 |   725 |    +0.07% |    -0.12% | +0.19% |     +61.28% |
| 2009         |  1d |    632 |   270 |    +0.04% |    +0.14% | -0.10% |     -22.63% |
| 2010         |  1d |  1,186 |   103 |    +0.01% |    +0.08% | -0.07% |     -15.68% |
| 2011         |  1d |  1,102 |   149 |    +0.04% |    +0.30% | -0.26% |     -48.48% |
| 2012         |  1d |    910 |   163 |    +0.01% |    +0.15% | -0.14% |     -30.19% |
| 2013         |  1d |    658 |   616 |    +0.03% | -0.27 bps | +0.03% |      +8.20% |
| 2014         |  1d |  1,036 |   369 |    +0.02% |    -0.04% | +0.06% |     +17.37% |
| 2015         |  1d |    546 |   583 |    -0.03% |    -0.02% | -0.01% |      -2.29% |
| 2016         |  1d |    888 |   278 | +0.18 bps |    +0.09% | -0.09% |     -19.54% |
| 2017         |  1d |  1,044 |   142 |    +0.06% |    -0.01% | +0.07% |     +19.65% |
| 2018         |  1d |    510 |   695 |    -0.03% |    -0.05% | +0.01% |      +3.45% |
| 2018Q4       |  1d |     24 |   342 |    -0.48% |    -0.09% | -0.39% |     -62.30% |
| 2019         |  1d |    977 |   238 |    +0.06% |    +0.13% | -0.08% |     -17.66% |
| 2020         |  1d |  1,108 |   267 |    +0.03% |    +0.08% | -0.05% |     -11.07% |
| 2020Q1       |  1d |    318 |   103 |    -0.02% |    -0.53% | +0.51% |    +258.01% |
| 2021         |  1d |    889 |   206 |    +0.05% |    +0.04% | +0.01% |      +3.53% |
| 2022         |  1d |    204 | 1,273 |    +0.02% |    -0.04% | +0.05% |     +14.71% |
| 2023         |  1d |    299 |   579 |    -0.04% |    +0.05% | -0.09% |     -20.19% |
| 2023-present |  1d |  2,865 | 1,282 |    +0.03% |    +0.06% | -0.03% |      -7.50% |
| 2024         |  1d |  1,000 |   274 | -0.30 bps |    +0.03% | -0.03% |      -7.23% |
| 2025         |  1d |    977 |   283 |    +0.07% |    +0.15% | -0.08% |     -18.42% |
| 2026         |  1d |    589 |   146 |    +0.04% |    -0.02% | +0.06% |     +16.48% |
| full sample  |  1d | 16,942 | 7,793 |    +0.03% |    +0.01% | +0.02% |      +4.08% |
| 2005         | 21d |      0 |     0 |         — |         — |      — |           — |
| 2006         | 21d |    726 |   322 |    +0.59% |    -0.10% | +0.70% |      +8.68% |
| 2007         | 21d |  1,030 |   112 |    +1.00% |    +1.88% | -0.88% |     -10.07% |
| 2008         | 21d |    631 |   725 |    +0.82% |    -3.22% | +4.04% |     +60.88% |
| 2009         | 21d |    632 |   270 |    +0.81% |    +2.98% | -2.17% |     -23.18% |
| 2010         | 21d |  1,186 |   103 |    +0.62% |    +1.68% | -1.06% |     -12.03% |
| 2011         | 21d |  1,102 |   149 |    +1.01% |    +1.96% | -0.95% |     -10.80% |
| 2012         | 21d |    910 |   163 |    +0.32% |    +3.29% | -2.96% |     -30.30% |
| 2013         | 21d |    658 |   616 |    +0.47% |    -0.48% | +0.96% |     +12.08% |
| 2014         | 21d |  1,036 |   369 |    +0.65% |    -0.51% | +1.15% |     +14.76% |
| 2015         | 21d |    546 |   583 |    -0.57% |    -0.89% | +0.31% |      +3.82% |
| 2016         | 21d |    888 |   278 |    +0.14% |    +3.77% | -3.63% |     -35.87% |
| 2017         | 21d |  1,044 |   142 |    +1.45% |    +1.16% | +0.29% |      +3.56% |
| 2018         | 21d |    510 |   695 |    -1.46% |    +0.05% | -1.50% |     -16.60% |
| 2018Q4       | 21d |     24 |   342 |    -7.93% |    +0.62% | -8.55% |     -65.77% |
| 2019         | 21d |    977 |   238 |    +1.09% |    +3.04% | -1.95% |     -21.04% |
| 2020         | 21d |  1,108 |   267 |    +0.24% |    +3.77% | -3.53% |     -35.04% |
| 2020Q1       | 21d |    318 |   103 |    -2.37% |    +0.14% | -2.51% |     -26.32% |
| 2021         | 21d |    889 |   206 |    +0.97% |    +0.79% | +0.17% |      +2.10% |
| 2022         | 21d |    204 | 1,273 |    +0.81% |    -0.78% | +1.59% |     +20.81% |
| 2023         | 21d |    299 |   579 |    -0.60% |    +0.41% | -1.01% |     -11.47% |
| 2023-present | 21d |  2,806 | 1,229 |    +0.83% |    +0.74% | +0.09% |      +1.12% |
| 2024         | 21d |  1,000 |   274 |    +0.39% |    +0.55% | -0.16% |      -1.90% |
| 2025         | 21d |    977 |   283 |    +1.78% |    +1.91% | -0.12% |      -1.48% |
| 2026         | 21d |    530 |    93 |    +0.70% |    -0.24% | +0.94% |     +11.91% |
| full sample  | 21d | 16,883 | 7,740 |    +0.64% |    +0.22% | +0.42% |      +5.21% |

### Long/flat on each sleeve alone, against costless buy-and-hold

Weight equal to the score, charged 5.00 bps one way on every change, against a buy-and-hold that pays nothing. An unscored session is held flat — cash, a position this account can actually hold — and `time in mkt` is what says whether a curve is really a test of the signal or mostly a test of abstention. One variant only: shipping a scaled curve and a binary curve and letting a reader pick the better is a two-trial search nobody records.

**Full sample**

| Sleeve | Period      | Sessions | Time in mkt | Turnover/yr | Cost drag | Signal CAGR | Signal SR | Signal maxDD | Hold CAGR | Hold SR | Hold maxDD |
| ------ | ----------- | -------: | ----------: | ----------: | --------: | ----------: | --------: | -----------: | --------: | ------: | ---------: |
| DBC    | full sample |    5,428 |      45.91% |        8.93 |  44.7 bps |      +4.28% |      0.26 |      -40.88% |    +2.01% |    0.11 |    -76.35% |
| EEM    | full sample |    5,428 |      57.76% |        9.41 |  47.0 bps |      +4.17% |      0.23 |      -38.74% |    +7.13% |    0.32 |    -66.45% |
| EFA    | full sample |    5,428 |      61.93% |        8.58 |  42.9 bps |      +4.27% |      0.27 |      -19.33% |    +6.26% |    0.31 |    -61.04% |
| GLD    | full sample |    5,428 |      61.54% |        8.70 |  43.5 bps |      +7.81% |      0.49 |      -29.63% |   +10.51% |    0.54 |    -45.56% |
| IEF    | full sample |    5,428 |      54.12% |        9.05 |  45.3 bps |      +2.93% |      0.26 |       -8.96% |    +3.13% |    0.23 |    -23.92% |
| LQD    | full sample |    5,428 |      59.22% |        8.62 |  43.1 bps |      +2.73% |      0.23 |      -16.13% |    +3.85% |    0.28 |    -24.96% |
| SPY    | full sample |    5,428 |      72.67% |        7.46 |  37.3 bps |      +7.52% |      0.56 |      -19.88% |   +10.84% |    0.55 |    -55.20% |
| TLT    | full sample |    5,428 |      50.77% |        9.24 |  46.2 bps |      +2.74% |      0.14 |      -25.63% |    +2.95% |    0.15 |    -48.35% |

**Stress windows**

| Sleeve | Period       | Sessions | Time in mkt | Turnover/yr | Cost drag | Signal CAGR | Signal SR | Signal maxDD | Hold CAGR | Hold SR | Hold maxDD |
| ------ | ------------ | -------: | ----------: | ----------: | --------: | ----------: | --------: | -----------: | --------: | ------: | ---------: |
| DBC    | 2018Q4       |       63 |      34.92% |        9.26 |  46.3 bps |     -19.00% |     -2.48 |       -8.38% |   -55.19% |   -4.55 |    -21.36% |
| EEM    | 2018Q4       |       63 |       0.53% |        1.32 |   6.6 bps |      +2.29% |     -1.36 |       -0.01% |   -27.05% |   -1.24 |    -11.48% |
| EFA    | 2018Q4       |       63 |       4.76% |        3.97 |  19.9 bps |      -3.35% |     -3.25 |       -1.44% |   -41.46% |   -3.21 |    -15.53% |
| GLD    | 2018Q4       |       63 |      22.22% |       10.59 |  52.9 bps |      +7.36% |      2.06 |       -0.82% |   +33.40% |    2.77 |     -2.66% |
| IEF    | 2018Q4       |       63 |      21.69% |        5.29 |  26.5 bps |      +8.69% |      3.97 |       -0.34% |   +16.21% |    3.12 |     -1.24% |
| LQD    | 2018Q4       |       63 |       2.65% |        3.97 |  19.9 bps |      +0.54% |     -3.56 |       -0.33% |    -2.32% |   -1.20 |     -2.50% |
| SPY    | 2018Q4       |       63 |      50.26% |       19.85 |  99.3 bps |     -30.06% |     -2.95 |       -9.10% |   -43.83% |   -2.43 |    -19.19% |
| TLT    | 2018Q4       |       63 |       7.41% |        6.62 |  33.1 bps |      +3.69% |      0.68 |       -0.71% |   +19.48% |    1.68 |     -4.05% |
| DBC    | 2020Q1       |       62 |      25.27% |        9.47 |  47.3 bps |     -20.30% |     -4.14 |       -6.88% |   -75.75% |   -4.87 |    -33.11% |
| EEM    | 2020Q1       |       62 |      63.98% |       12.18 |  60.9 bps |     -43.25% |     -3.19 |      -15.72% |   -67.05% |   -1.75 |    -33.89% |
| EFA    | 2020Q1       |       62 |      65.59% |        9.47 |  47.3 bps |     -32.59% |     -2.97 |      -10.53% |   -65.40% |   -1.90 |    -33.93% |
| GLD    | 2020Q1       |       62 |      97.85% |        5.41 |  27.1 bps |      -5.66% |     -0.21 |      -12.53% |   +15.45% |    0.66 |    -12.53% |
| IEF    | 2020Q1       |       62 |      90.32% |        4.06 |  20.3 bps |     +45.73% |      3.03 |       -4.68% |   +49.94% |    3.24 |     -4.68% |
| LQD    | 2020Q1       |       62 |      83.33% |        5.41 |  27.1 bps |     -36.60% |     -2.95 |      -15.51% |   -11.52% |   -0.29 |    -21.76% |
| SPY    | 2020Q1       |       62 |      73.12% |        9.47 |  47.3 bps |     -42.92% |     -2.32 |      -17.22% |   -58.38% |   -1.34 |    -33.70% |
| TLT    | 2020Q1       |       62 |      91.40% |        6.76 |  33.8 bps |    +108.56% |      2.17 |      -15.73% |  +125.25% |    2.37 |    -15.73% |
| DBC    | 2023-present |      897 |      44.56% |       12.77 |  63.9 bps |      +2.55% |     -0.13 |      -18.59% |    +9.06% |    0.33 |    -16.54% |
| EEM    | 2023-present |      897 |      74.25% |       11.56 |  57.8 bps |      +9.75% |      0.38 |      -18.18% |   +18.43% |    0.74 |    -17.29% |
| EFA    | 2023-present |      897 |      82.87% |        9.60 |  48.0 bps |     +10.47% |      0.50 |      -11.70% |   +17.87% |    0.87 |    -14.05% |
| GLD    | 2023-present |      897 |      85.69% |        8.20 |  41.0 bps |     +22.40% |      0.95 |      -22.35% |   +24.51% |    0.98 |    -26.40% |
| IEF    | 2023-present |      897 |      38.20% |       12.68 |  63.4 bps |      +0.35% |     -1.41 |       -5.93% |    +2.61% |   -0.25 |    -10.15% |
| LQD    | 2023-present |      897 |      46.60% |       14.82 |  74.1 bps |      +1.68% |     -0.76 |       -5.79% |    +4.59% |    0.03 |     -9.65% |
| SPY    | 2023-present |      897 |      84.99% |        5.97 |  29.8 bps |     +16.44% |      1.03 |      -10.24% |   +22.12% |    1.10 |    -18.76% |
| TLT    | 2023-present |      897 |      27.68% |       13.61 |  68.1 bps |      -2.77% |     -1.48 |      -13.06% |    -1.41% |   -0.35 |    -22.43% |

**Calendar years**

| Sleeve | Period | Sessions | Time in mkt | Turnover/yr | Cost drag | Signal CAGR | Signal SR | Signal maxDD | Hold CAGR | Hold SR | Hold maxDD |
| ------ | ------ | -------: | ----------: | ----------: | --------: | ----------: | --------: | -----------: | --------: | ------: | ---------: |
| DBC    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |    +0.00% | -100.21 |      0.00% |
| EEM    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |   +34.36% |    1.46 |    -12.02% |
| EFA    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |   +14.28% |    0.92 |     -7.19% |
| GLD    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |   +20.09% |    1.26 |     -6.70% |
| IEF    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |    +2.46% |   -0.13 |     -3.97% |
| LQD    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |    +0.52% |   -0.56 |     -4.34% |
| SPY    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |    +5.37% |    0.25 |     -6.96% |
| TLT    | 2005   |      252 |       0.00% |        0.00 |   0.0 bps |      +3.25% |         — |        0.00% |    +8.45% |    0.57 |     -7.11% |
| DBC    | 2006   |      251 |       0.00% |        0.00 |   0.0 bps |      +4.89% |         — |        0.00% |    +4.15% |    0.06 |    -14.37% |
| EEM    | 2006   |      251 |      76.89% |        7.76 |  38.8 bps |     +16.65% |      0.63 |      -19.68% |   +31.61% |    0.95 |    -26.24% |
| EFA    | 2006   |      251 |      90.84% |        4.38 |  21.9 bps |     +16.15% |      0.88 |      -14.51% |   +26.15% |    1.30 |    -15.76% |
| GLD    | 2006   |      251 |      81.81% |        8.43 |  42.2 bps |     +13.37% |      0.46 |      -21.79% |   +22.84% |    0.77 |    -21.79% |
| IEF    | 2006   |      251 |      29.22% |       13.15 |  65.8 bps |      +3.10% |     -0.87 |       -1.21% |    +2.55% |   -0.50 |     -3.93% |
| LQD    | 2006   |      251 |      33.07% |        6.75 |  33.7 bps |      +5.64% |      0.37 |       -1.23% |    +4.27% |   -0.13 |     -3.87% |
| SPY    | 2006   |      251 |      78.62% |       11.13 |  55.6 bps |      +6.43% |      0.23 |       -6.46% |   +16.05% |    1.05 |     -7.59% |
| TLT    | 2006   |      251 |      38.25% |        9.78 |  48.9 bps |      +1.19% |     -0.94 |       -3.04% |    +0.72% |   -0.51 |     -9.38% |
| DBC    | 2007   |      251 |      70.39% |       17.78 |  88.9 bps |     +28.52% |      1.60 |       -4.82% |   +31.82% |    1.39 |     -8.01% |
| EEM    | 2007   |      251 |      97.48% |        6.71 |  33.5 bps |     +29.74% |      0.83 |      -17.26% |   +33.54% |    0.91 |    -17.73% |
| EFA    | 2007   |      251 |      88.31% |        8.05 |  40.2 bps |      +7.22% |      0.24 |       -9.93% |   +10.00% |    0.37 |    -11.58% |
| GLD    | 2007   |      251 |      76.36% |       14.09 |  70.4 bps |     +23.24% |      1.13 |       -7.59% |   +30.67% |    1.35 |     -7.59% |
| IEF    | 2007   |      251 |      66.00% |       15.43 |  77.1 bps |      +8.78% |      0.83 |       -2.44% |   +10.44% |    0.96 |     -3.86% |
| LQD    | 2007   |      251 |      49.80% |       16.43 |  82.2 bps |      +0.79% |     -1.09 |       -2.80% |    +3.75% |   -0.08 |     -3.64% |
| SPY    | 2007   |      251 |      79.68% |       12.75 |  63.7 bps |      -0.41% |     -0.35 |       -8.78% |    +5.17% |    0.12 |     -9.92% |
| TLT    | 2007   |      251 |      56.57% |       12.75 |  63.7 bps |      +5.37% |      0.15 |       -5.00% |   +10.36% |    0.61 |     -7.90% |
| DBC    | 2008   |      253 |      68.51% |        1.67 |   8.3 bps |      +6.75% |      0.34 |      -27.49% |   -31.79% |   -0.94 |    -57.58% |
| EEM    | 2008   |      253 |      30.57% |        8.34 |  41.7 bps |     -16.00% |     -1.32 |      -16.17% |   -48.91% |   -0.62 |    -64.29% |
| EFA    | 2008   |      253 |       7.38% |        1.67 |   8.3 bps |      -3.43% |     -1.71 |       -3.90% |   -41.06% |   -0.91 |    -53.64% |
| GLD    | 2008   |      253 |      62.58% |        8.01 |  40.0 bps |      +2.39% |      0.14 |      -18.45% |    +4.93% |    0.27 |    -29.41% |
| IEF    | 2008   |      253 |      85.64% |       12.01 |  60.0 bps |     +14.25% |      1.36 |       -5.91% |   +17.92% |    1.58 |     -6.18% |
| LQD    | 2008   |      253 |      38.21% |       24.02 | 120.1 bps |      -2.42% |     -0.82 |       -8.37% |    +2.40% |    0.15 |    -21.54% |
| SPY    | 2008   |      253 |       6.19% |        1.00 |   5.0 bps |      -0.61% |     -0.88 |       -2.47% |   -36.83% |   -0.93 |    -47.59% |
| TLT    | 2008   |      253 |      82.35% |        9.34 |  46.7 bps |     +29.78% |      1.62 |       -6.39% |   +33.95% |    1.71 |     -7.49% |
| DBC    | 2009   |      252 |      42.99% |        8.36 |  41.8 bps |      +4.03% |      0.36 |       -9.29% |   +16.25% |    0.68 |    -20.18% |
| EEM    | 2009   |      252 |      63.10% |        8.36 |  41.8 bps |     +37.91% |      1.58 |       -9.58% |   +69.24% |    1.52 |    -26.42% |
| EFA    | 2009   |      252 |      54.37% |       10.37 |  51.8 bps |     +19.25% |      1.22 |       -6.61% |   +27.05% |    0.91 |    -30.24% |
| GLD    | 2009   |      252 |      80.03% |       13.38 |  66.9 bps |     +11.20% |      0.71 |      -12.35% |   +24.12% |    1.13 |    -12.86% |
| IEF    | 2009   |      252 |      65.87% |        9.37 |  46.8 bps |      -6.37% |     -0.99 |       -7.56% |    -6.61% |   -0.69 |     -9.69% |
| LQD    | 2009   |      252 |      76.98% |        8.36 |  41.8 bps |      +7.13% |      1.00 |       -5.51% |    +8.49% |    0.90 |    -10.86% |
| SPY    | 2009   |      252 |      52.25% |        5.02 |  25.1 bps |     +17.67% |      1.48 |       -5.67% |   +26.47% |    1.01 |    -27.13% |
| TLT    | 2009   |      252 |      61.11% |        5.02 |  25.1 bps |     -18.58% |     -1.53 |      -19.80% |   -21.87% |   -1.24 |    -25.02% |
| DBC    | 2010   |      252 |      62.70% |       14.80 |  74.0 bps |      +1.98% |      0.20 |      -19.69% |   +12.01% |    0.67 |    -17.57% |
| EEM    | 2010   |      252 |      82.54% |        7.40 |  37.0 bps |      +6.97% |      0.42 |      -15.32% |   +16.67% |    0.72 |    -17.77% |
| EFA    | 2010   |      252 |      71.30% |       16.14 |  80.7 bps |      -4.81% |     -0.22 |      -18.40% |    +8.22% |    0.44 |    -20.24% |
| GLD    | 2010   |      252 |      93.92% |        8.74 |  43.7 bps |     +24.94% |      1.45 |       -7.63% |   +29.57% |    1.62 |     -7.81% |
| IEF    | 2010   |      252 |      76.06% |        8.74 |  43.7 bps |      +5.60% |      0.85 |       -5.85% |    +9.46% |    1.19 |     -7.20% |
| LQD    | 2010   |      252 |      94.44% |        1.35 |   6.7 bps |      +8.75% |      1.48 |       -4.63% |    +9.41% |    1.49 |     -5.23% |
| SPY    | 2010   |      252 |      79.37% |       10.09 |  50.4 bps |      +4.58% |      0.37 |      -15.48% |   +15.20% |    0.86 |    -15.70% |
| TLT    | 2010   |      252 |      62.04% |       11.10 |  55.5 bps |      +1.81% |      0.19 |      -12.09% |    +9.13% |    0.61 |    -15.09% |
| DBC    | 2011   |      252 |      69.71% |       10.09 |  50.4 bps |      -3.45% |     -0.15 |      -16.68% |    -2.60% |   -0.03 |    -19.89% |
| EEM    | 2011   |      252 |      54.10% |       14.13 |  70.6 bps |     -11.32% |     -0.75 |      -14.30% |   -18.97% |   -0.48 |    -30.86% |
| EFA    | 2011   |      252 |      57.41% |       11.44 |  57.2 bps |      -6.25% |     -0.38 |      -14.63% |   -12.35% |   -0.29 |    -25.85% |
| GLD    | 2011   |      252 |      93.52% |        4.37 |  21.9 bps |     +15.18% |      0.82 |      -15.37% |    +9.66% |    0.55 |    -18.55% |
| IEF    | 2011   |      252 |      79.76% |        8.07 |  40.4 bps |     +13.76% |      1.77 |       -4.40% |   +15.80% |    1.81 |     -4.40% |
| LQD    | 2011   |      252 |      87.17% |        7.06 |  35.3 bps |      +7.37% |      1.21 |       -4.56% |    +9.82% |    1.48 |     -4.66% |
| SPY    | 2011   |      252 |      73.15% |        9.08 |  45.4 bps |      -2.93% |     -0.17 |      -12.83% |    +1.90% |    0.19 |    -18.61% |
| TLT    | 2011   |      252 |      77.51% |        7.40 |  37.0 bps |     +31.66% |      1.54 |      -10.91% |   +34.31% |    1.55 |    -10.91% |
| DBC    | 2012   |      250 |      41.60% |       17.06 |  85.3 bps |      -7.06% |     -1.03 |      -10.94% |    +3.51% |    0.30 |    -18.91% |
| EEM    | 2012   |      250 |      52.27% |       13.38 |  66.9 bps |      +3.17% |      0.36 |      -12.17% |   +19.17% |    1.00 |    -18.01% |
| EFA    | 2012   |      250 |      58.13% |       12.71 |  63.6 bps |      +5.16% |      0.54 |       -8.32% |   +18.89% |    1.06 |    -16.58% |
| GLD    | 2012   |      250 |      55.47% |       13.38 |  66.9 bps |      -0.17% |      0.02 |       -9.71% |    +6.62% |    0.49 |    -13.85% |
| IEF    | 2012   |      250 |      90.53% |        9.37 |  46.8 bps |      +0.47% |      0.10 |       -3.58% |    +3.68% |    0.67 |     -3.87% |
| LQD    | 2012   |      250 |      99.33% |        1.34 |   6.7 bps |      +9.97% |      2.17 |       -2.52% |   +10.62% |    2.28 |     -2.52% |
| SPY    | 2012   |      250 |      87.07% |        8.03 |  40.1 bps |     +10.15% |      0.97 |       -8.33% |   +16.05% |    1.23 |     -9.69% |
| TLT    | 2012   |      250 |      81.73% |       10.70 |  53.5 bps |      -0.87% |     -0.02 |       -9.61% |    +2.64% |    0.25 |    -10.11% |
| DBC    | 2013   |      252 |      22.88% |       14.38 |  71.9 bps |      -2.88% |     -0.98 |       -5.33% |    -7.66% |   -0.70 |    -12.24% |
| EEM    | 2013   |      252 |      61.24% |       15.72 |  78.6 bps |     -13.30% |     -1.26 |      -16.09% |    -3.72% |   -0.12 |    -18.96% |
| EFA    | 2013   |      252 |      97.49% |        6.02 |  30.1 bps |     +19.39% |      1.39 |      -10.01% |   +21.47% |    1.49 |    -10.23% |
| GLD    | 2013   |      252 |      12.04% |        8.03 |  40.1 bps |      -5.57% |     -1.73 |       -6.19% |   -28.41% |   -1.44 |    -29.85% |
| IEF    | 2013   |      252 |      32.67% |       10.37 |  51.8 bps |      -2.42% |     -1.02 |       -3.66% |    -6.11% |   -1.00 |     -9.07% |
| LQD    | 2013   |      252 |      46.56% |        7.02 |  35.1 bps |      -3.31% |     -1.20 |       -5.46% |    -2.01% |   -0.31 |     -8.57% |
| SPY    | 2013   |      252 |      98.81% |        2.34 |  11.7 bps |     +30.58% |      2.50 |       -5.55% |   +32.43% |    2.58 |     -5.55% |
| TLT    | 2013   |      252 |      23.15% |        9.70 |  48.5 bps |      -5.06% |     -1.10 |       -7.15% |   -13.41% |   -1.03 |    -17.05% |
| DBC    | 2014   |      252 |      32.14% |        9.03 |  45.2 bps |      -2.72% |     -0.74 |       -4.75% |   -28.18% |   -2.82 |    -31.46% |
| EEM    | 2014   |      252 |      54.37% |       16.72 |  83.6 bps |     -10.59% |     -1.16 |      -13.77% |    -3.93% |   -0.17 |    -17.71% |
| EFA    | 2014   |      252 |      70.11% |        7.69 |  38.5 bps |      -4.67% |     -0.42 |       -8.88% |    -6.22% |   -0.42 |    -13.82% |
| GLD    | 2014   |      252 |      27.38% |        8.70 |  43.5 bps |      -5.65% |     -1.15 |       -7.54% |    -2.19% |   -0.08 |    -17.51% |
| IEF    | 2014   |      252 |      79.63% |        3.68 |  18.4 bps |      +4.79% |      1.14 |       -2.08% |    +9.10% |    1.78 |     -2.08% |
| LQD    | 2014   |      252 |      95.77% |        5.02 |  25.1 bps |      +6.72% |      1.51 |       -2.43% |    +8.24% |    1.75 |     -2.43% |
| SPY    | 2014   |      252 |      97.22% |        4.68 |  23.4 bps |     +10.43% |      1.00 |       -5.83% |   +13.51% |    1.18 |     -7.27% |
| TLT    | 2014   |      252 |      82.41% |        3.68 |  18.4 bps |     +17.94% |      1.79 |       -5.03% |   +27.40% |    2.32 |     -5.03% |
| DBC    | 2015   |      252 |       6.08% |        3.34 |  16.7 bps |      -2.86% |     -1.30 |       -4.00% |   -27.67% |   -1.72 |    -28.76% |
| EEM    | 2015   |      252 |      32.94% |       14.38 |  71.9 bps |      -5.19% |     -0.65 |      -12.64% |   -16.23% |   -0.73 |    -28.43% |
| EFA    | 2015   |      252 |      42.20% |       16.39 |  81.9 bps |      -2.15% |     -0.25 |       -8.61% |    -1.00% |    0.02 |    -16.40% |
| GLD    | 2015   |      252 |      14.68% |       12.71 |  63.6 bps |      -8.19% |     -2.03 |       -9.50% |   -10.71% |   -0.73 |    -19.75% |
| IEF    | 2015   |      252 |      81.35% |       16.39 |  81.9 bps |      -0.13% |     -0.00 |       -4.60% |    +1.51% |    0.25 |     -5.35% |
| LQD    | 2015   |      252 |      65.61% |       11.37 |  56.9 bps |      -2.49% |     -0.53 |       -6.15% |    -1.26% |   -0.19 |     -6.03% |
| SPY    | 2015   |      252 |      76.98% |       18.06 |  90.3 bps |      -7.88% |     -0.72 |      -10.94% |    +1.26% |    0.15 |    -11.94% |
| TLT    | 2015   |      252 |      71.43% |        9.37 |  46.8 bps |      -3.98% |     -0.28 |      -12.66% |    -1.79% |   -0.04 |    -15.80% |
| DBC    | 2016   |      252 |      46.96% |       10.43 |  52.1 bps |      +0.64% |      0.08 |      -11.06% |   +18.74% |    1.02 |    -11.08% |
| EEM    | 2016   |      252 |      56.75% |        9.08 |  45.4 bps |      -4.27% |     -0.29 |      -10.72% |   +10.97% |    0.56 |    -12.24% |
| EFA    | 2016   |      252 |      35.98% |       13.45 |  67.3 bps |      -8.05% |     -0.96 |       -8.39% |    +1.39% |    0.15 |    -12.50% |
| GLD    | 2016   |      252 |      75.79% |        6.39 |  32.0 bps |      +2.95% |      0.26 |      -11.10% |    +8.11% |    0.54 |    -17.76% |
| IEF    | 2016   |      252 |      81.61% |        6.39 |  32.0 bps |      +3.18% |      0.61 |       -4.78% |    +1.01% |    0.15 |     -8.41% |
| LQD    | 2016   |      252 |      73.68% |        9.42 |  47.1 bps |      +4.27% |      0.98 |       -4.24% |    +6.27% |    1.16 |     -5.86% |
| SPY    | 2016   |      252 |      74.60% |       14.13 |  70.6 bps |      +2.71% |      0.31 |       -5.64% |   +12.12% |    0.91 |    -10.31% |
| TLT    | 2016   |      252 |      78.70% |        6.73 |  33.6 bps |      +1.82% |      0.19 |      -11.93% |    +1.19% |    0.13 |    -17.88% |
| DBC    | 2017   |      251 |      64.54% |       10.79 |  54.0 bps |      +1.17% |      0.07 |       -8.57% |    +4.92% |    0.37 |    -14.39% |
| EEM    | 2017   |      251 |      97.74% |        2.36 |  11.8 bps |     +33.05% |      2.35 |       -5.29% |   +37.79% |    2.59 |     -5.29% |
| EFA    | 2017   |      251 |      99.47% |        0.67 |   3.4 bps |     +24.04% |      2.72 |       -2.28% |   +25.43% |    2.84 |     -2.28% |
| GLD    | 2017   |      251 |      54.98% |       17.87 |  89.4 bps |      +5.92% |      0.84 |       -4.01% |   +12.97% |    1.18 |     -7.90% |
| IEF    | 2017   |      251 |      38.91% |       10.12 |  50.6 bps |      +0.55% |     -0.22 |       -1.44% |    +2.58% |    0.40 |     -2.90% |
| LQD    | 2017   |      251 |      81.27% |        7.42 |  37.1 bps |      +5.29% |      1.28 |       -1.54% |    +7.14% |    1.47 |     -2.39% |
| SPY    | 2017   |      251 |     100.00% |        0.00 |   0.0 bps |     +21.98% |      2.82 |       -2.61% |   +21.98% |    2.82 |     -2.61% |
| TLT    | 2017   |      251 |      48.87% |       12.14 |  60.7 bps |      +2.77% |      0.36 |       -3.28% |    +9.29% |    0.86 |     -5.11% |
| DBC    | 2018   |      251 |      74.24% |        8.36 |  41.8 bps |      +0.14% |     -0.11 |       -9.05% |   -11.66% |   -0.92 |    -21.36% |
| EEM    | 2018   |      251 |      44.09% |        5.69 |  28.4 bps |      -4.16% |     -0.40 |      -14.40% |   -15.36% |   -0.77 |    -26.55% |
| EFA    | 2018   |      251 |      50.73% |       13.04 |  65.2 bps |      -5.29% |     -0.78 |      -11.96% |   -13.85% |   -1.12 |    -22.05% |
| GLD    | 2018   |      251 |      45.15% |        8.03 |  40.1 bps |      -0.08% |     -0.30 |       -6.18% |    -1.95% |   -0.35 |    -13.76% |
| IEF    | 2018   |      251 |      15.41% |       10.37 |  51.8 bps |      +1.68% |     -0.26 |       -0.82% |    +0.99% |   -0.22 |     -4.29% |
| LQD    | 2018   |      251 |      21.51% |        6.36 |  31.8 bps |      -1.49% |     -2.47 |       -2.56% |    -3.80% |   -1.43 |     -5.63% |
| SPY    | 2018   |      251 |      81.14% |       10.37 |  51.8 bps |      -1.73% |     -0.23 |      -10.18% |    -4.57% |   -0.30 |    -19.34% |
| TLT    | 2018   |      251 |      27.89% |       14.05 |  70.2 bps |      -3.46% |     -1.49 |       -4.64% |    -1.61% |   -0.34 |     -9.73% |
| DBC    | 2019   |      252 |      22.75% |        9.03 |  45.2 bps |      +2.06% |      0.01 |       -3.63% |   +11.88% |    0.74 |     -9.79% |
| EEM    | 2019   |      252 |      43.65% |       13.04 |  65.2 bps |      +6.02% |      0.58 |       -5.38% |   +18.27% |    1.04 |    -12.46% |
| EFA    | 2019   |      252 |      51.19% |       11.04 |  55.2 bps |      +4.82% |      0.50 |       -4.60% |   +22.11% |    1.64 |     -8.07% |
| GLD    | 2019   |      252 |      75.40% |        3.01 |  15.1 bps |     +14.53% |      1.16 |       -5.79% |   +17.92% |    1.29 |     -6.58% |
| IEF    | 2019   |      252 |      93.39% |        2.01 |  10.0 bps |      +8.12% |      1.16 |       -3.28% |    +8.06% |    1.08 |     -3.28% |
| LQD    | 2019   |      252 |      91.27% |        1.67 |   8.4 bps |     +14.69% |      2.51 |       -3.16% |   +17.43% |    2.90 |     -3.16% |
| SPY    | 2019   |      252 |      78.97% |       13.04 |  65.2 bps |     +10.46% |      0.84 |       -8.00% |   +31.34% |    2.07 |     -6.62% |
| TLT    | 2019   |      252 |      89.68% |        5.02 |  25.1 bps |     +14.34% |      1.07 |       -7.74% |   +14.17% |    0.99 |     -8.24% |
| DBC    | 2020   |      253 |      33.60% |        4.34 |  21.7 bps |      +2.88% |      0.41 |       -7.25% |    -7.84% |   -0.28 |    -35.15% |
| EEM    | 2020   |      253 |      65.35% |        5.34 |  26.7 bps |      +7.67% |      0.55 |      -17.17% |   +17.05% |    0.62 |    -33.89% |
| EFA    | 2020   |      253 |      57.18% |        7.34 |  36.7 bps |      -1.72% |     -0.12 |      -14.00% |    +7.59% |    0.38 |    -33.93% |
| GLD    | 2020   |      253 |      93.68% |        2.33 |  11.7 bps |     +18.83% |      1.03 |      -12.53% |   +24.83% |    1.21 |    -14.04% |
| IEF    | 2020   |      253 |      82.08% |        5.67 |  28.4 bps |      +9.09% |      1.25 |       -4.68% |   +10.01% |    1.32 |     -4.68% |
| LQD    | 2020   |      253 |      87.35% |        6.00 |  30.0 bps |      -3.07% |     -0.32 |      -16.13% |   +10.98% |    0.68 |    -21.76% |
| SPY    | 2020   |      253 |      74.04% |        8.01 |  40.0 bps |      +4.49% |      0.31 |      -18.91% |   +18.39% |    0.66 |    -33.70% |
| TLT    | 2020   |      253 |      77.73% |        9.67 |  48.4 bps |     +13.34% |      0.69 |      -15.73% |   +18.17% |    0.86 |    -15.73% |
| DBC    | 2021   |      252 |      97.49% |        2.35 |  11.8 bps |     +38.85% |      1.78 |      -11.58% |   +41.80% |    1.86 |    -11.58% |
| EEM    | 2021   |      252 |      64.29% |        9.75 |  48.8 bps |      -3.04% |     -0.15 |      -13.54% |    -3.65% |   -0.12 |    -16.60% |
| EFA    | 2021   |      252 |      92.20% |        4.71 |  23.5 bps |      +7.69% |      0.68 |       -6.36% |   +11.57% |    0.91 |     -6.98% |
| GLD    | 2021   |      252 |      40.34% |       12.78 |  63.9 bps |     -10.12% |     -1.34 |      -13.50% |    -4.19% |   -0.24 |    -13.88% |
| IEF    | 2021   |      252 |      28.57% |        6.05 |  30.3 bps |      -2.88% |     -1.56 |       -3.02% |    -3.36% |   -0.62 |     -5.76% |
| LQD    | 2021   |      252 |      62.57% |        9.75 |  48.8 bps |      -3.50% |     -0.84 |       -4.09% |    -1.86% |   -0.26 |     -6.64% |
| SPY    | 2021   |      252 |      99.60% |        1.35 |   6.7 bps |     +27.69% |      1.94 |       -5.11% |   +29.04% |    2.01 |     -5.11% |
| TLT    | 2021   |      252 |      32.14% |        6.39 |  32.0 bps |      -4.51% |     -0.79 |       -5.29% |    -4.64% |   -0.27 |    -14.89% |
| DBC    | 2022   |      251 |      74.77% |        6.05 |  30.3 bps |     +17.68% |      0.74 |      -20.60% |   +19.53% |    0.73 |    -23.19% |
| EEM    | 2022   |      251 |       3.72% |        4.37 |  21.9 bps |      -1.06% |     -1.72 |       -1.89% |   -20.72% |   -0.95 |    -32.69% |
| EFA    | 2022   |      251 |      16.33% |        6.39 |  32.0 bps |      -6.50% |     -1.77 |       -8.65% |   -14.47% |   -0.67 |    -28.70% |
| GLD    | 2022   |      251 |      38.38% |        9.08 |  45.4 bps |      -3.88% |     -0.63 |      -13.76% |    -0.78% |   -0.11 |    -21.03% |
| IEF    | 2022   |      251 |       3.72% |        3.70 |  18.5 bps |      +0.07% |     -1.60 |       -1.03% |   -15.28% |   -1.77 |    -18.18% |
| LQD    | 2022   |      251 |       6.11% |        4.37 |  21.9 bps |      -1.86% |     -1.99 |       -1.89% |   -18.08% |   -1.73 |    -23.49% |
| SPY    | 2022   |      251 |      26.96% |       11.44 |  57.2 bps |     -19.14% |     -2.89 |      -19.88% |   -18.32% |   -0.79 |    -24.50% |
| TLT    | 2022   |      251 |       4.25% |        8.74 |  43.7 bps |      -4.23% |     -2.07 |       -4.31% |   -31.48% |   -1.85 |    -36.64% |
| DBC    | 2023   |      250 |      24.53% |       10.12 |  50.6 bps |      -5.58% |     -2.03 |       -7.34% |    -6.30% |   -0.66 |    -12.33% |
| EEM    | 2023   |      250 |      40.53% |       18.21 |  91.1 bps |      +0.92% |     -0.55 |       -8.50% |    +9.10% |    0.31 |    -13.37% |
| EFA    | 2023   |      250 |      71.33% |        9.78 |  48.9 bps |      +8.66% |      0.37 |       -7.72% |   +18.63% |    0.95 |    -11.58% |
| GLD    | 2023   |      250 |      70.13% |       14.16 |  70.8 bps |      +7.95% |      0.29 |       -6.68% |   +12.85% |    0.58 |    -11.35% |
| IEF    | 2023   |      250 |      17.73% |        7.76 |  38.8 bps |      +2.03% |     -1.23 |       -2.48% |    +3.69% |   -0.12 |    -10.15% |
| LQD    | 2023   |      250 |      22.80% |       16.86 |  84.3 bps |      +5.27% |      0.01 |       -2.07% |    +9.52% |    0.45 |     -9.65% |
| SPY    | 2023   |      250 |      72.13% |       10.79 |  54.0 bps |     +15.60% |      1.10 |       -8.03% |   +26.54% |    1.47 |     -9.97% |
| TLT    | 2023   |      250 |      14.93% |        9.78 |  48.9 bps |      -0.42% |     -1.38 |       -4.51% |    +2.80% |   -0.04 |    -22.43% |
| DBC    | 2024   |      252 |      24.60% |       15.68 |  78.4 bps |      -1.38% |     -1.23 |       -5.03% |    +2.18% |   -0.14 |    -12.20% |
| EEM    | 2024   |      252 |      82.01% |       11.34 |  56.7 bps |      +2.53% |     -0.12 |      -10.24% |    +6.50% |    0.16 |    -10.20% |
| EFA    | 2024   |      252 |      83.60% |       11.67 |  58.4 bps |      +1.41% |     -0.26 |       -7.73% |    +3.51% |   -0.06 |     -9.84% |
| GLD    | 2024   |      252 |      96.43% |        6.34 |  31.7 bps |     +22.40% |      1.10 |       -8.12% |   +26.68% |    1.31 |     -8.12% |
| IEF    | 2024   |      252 |      44.05% |       10.34 |  51.7 bps |      -0.96% |     -1.69 |       -4.89% |    -0.64% |   -0.81 |     -5.96% |
| LQD    | 2024   |      252 |      61.90% |       11.67 |  58.4 bps |      +0.08% |     -1.02 |       -4.10% |    +0.86% |   -0.56 |     -4.95% |
| SPY    | 2024   |      252 |      99.87% |        0.67 |   3.3 bps |     +24.69% |      1.42 |       -8.41% |   +24.90% |    1.43 |     -8.41% |
| TLT    | 2024   |      252 |      43.52% |       14.34 |  71.7 bps |      -7.08% |     -1.74 |      -10.42% |    -8.06% |   -0.88 |    -12.83% |
| DBC    | 2025   |      250 |      56.40% |       19.07 |  95.3 bps |      -9.52% |     -1.41 |      -12.72% |    +8.09% |    0.32 |    -12.27% |
| EEM    | 2025   |      250 |      86.13% |        9.37 |  46.8 bps |     +15.98% |      0.88 |      -12.68% |   +34.11% |    1.53 |    -15.04% |
| EFA    | 2025   |      250 |      87.47% |        7.69 |  38.5 bps |     +17.87% |      1.10 |       -9.57% |   +31.67% |    1.51 |    -14.05% |
| GLD    | 2025   |      250 |      96.40% |        7.69 |  38.5 bps |     +59.59% |      2.29 |      -10.13% |   +63.95% |    2.40 |    -10.13% |
| IEF    | 2025   |      250 |      54.93% |       15.05 |  75.3 bps |      +0.32% |     -1.16 |       -3.25% |    +8.06% |    0.68 |     -3.21% |
| LQD    | 2025   |      250 |      54.00% |       18.06 |  90.3 bps |      +0.87% |     -0.85 |       -3.17% |    +7.92% |    0.57 |     -3.57% |
| SPY    | 2025   |      250 |      80.80% |        5.35 |  26.8 bps |     +13.07% |      0.83 |      -10.24% |   +17.78% |    0.73 |    -18.76% |
| TLT    | 2025   |      250 |      25.73% |       12.04 |  60.2 bps |      -3.20% |     -1.83 |       -5.05% |    +4.26% |    0.07 |     -9.23% |
| DBC    | 2026   |      145 |      93.33% |        1.73 |   8.7 bps |     +56.90% |      1.97 |      -14.36% |   +61.09% |    2.00 |    -16.54% |
| EEM    | 2026   |      145 |      98.39% |        4.62 |  23.1 bps |     +29.85% |      0.91 |      -13.52% |   +32.66% |    0.97 |    -14.24% |
| EFA    | 2026   |      145 |      93.56% |        9.23 |  46.2 bps |     +18.12% |      0.84 |      -11.42% |   +21.06% |    0.92 |    -11.42% |
| GLD    | 2026   |      145 |      75.40% |        2.31 |  11.5 bps |      -3.51% |     -0.10 |      -22.35% |   -10.57% |   -0.30 |    -26.40% |
| IEF    | 2026   |      145 |      34.48% |       21.35 | 106.7 bps |      -0.18% |     -1.84 |       -2.10% |    -2.48% |   -1.23 |     -4.07% |
| LQD    | 2026   |      145 |      48.28% |       11.54 |  57.7 bps |      -0.11% |     -1.34 |       -2.23% |    -2.39% |   -1.06 |     -3.34% |
| SPY    | 2026   |      145 |      88.51% |        8.08 |  40.4 bps |     +10.56% |      0.60 |       -6.67% |   +18.18% |    1.01 |     -8.88% |
| TLT    | 2026   |      145 |      25.52% |       21.93 | 109.6 bps |      +1.66% |     -0.56 |       -2.02% |    -5.96% |   -0.98 |     -7.73% |

### Coverage

`blocked` is not a failure count — a sleeve that lists in 2006 is going to be blocked for its first 253 sessions and that is the signal working. A count that climbs LATER in the sample is a hole in the price frame, which is.

| Sleeve | Sessions | Scored | Blocked | First score | Last score | Mean score |
| ------ | -------: | -----: | ------: | ----------- | ---------- | ---------: |
| DBC    |    5,428 |  4,901 |     527 | 2007-02-07  | 2026-07-31 |      0.509 |
| EEM    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.606 |
| EFA    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.650 |
| GLD    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.645 |
| IEF    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.568 |
| LQD    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.621 |
| SPY    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.762 |
| TLT    |    5,428 |  5,176 |     252 | 2006-01-03  | 2026-07-31 |      0.532 |

## Volatility — and why there is no information coefficient here

**The IC test was substituted, not skipped.** An information coefficient measures how well a score ranks future RETURNS. An inverse-volatility scalar makes no claim about returns at all — it is a statement about the SIZE a position has to be, not about which direction it should go. Regressing it against forward returns would produce a number, and that number would be either the low-volatility anomaly or noise, neither of which is what this signal claims. So the test below is of the actual claim: that sizing by inverse volatility produces more equal realised RISK CONTRIBUTIONS than sizing by equal dollars.

Measured over 82 non-overlapping 63-session windows (4 skipped for want of data), on the 8 risk sleeves with cash excluded — including cash would make inverse-vol look spectacular for a mechanical reason, since equal weighting hands a T-bill fund a ninth of the book and none of the risk.

```
82 non-overlapping 63-session windows over 8 sleeves (4 skipped for want of data).
correlation_aware: mean dispersion of risk contributions 0.0906 equal-weight against 0.0577 inverse-vol; inverse-vol was the more equal book in 74 of 82 windows (90%); effective number of risk sources 5.32 against 6.52 of a possible 7.9. the real test: inverse-vol sizing cannot see correlation and makes no promise here.
standalone: mean dispersion of risk contributions 0.0522 equal-weight against 0.0246 inverse-vol; inverse-vol was the more equal book in 79 of 82 windows (96%); effective number of risk sources 6.77 against 7.60 of a possible 7.9. near-tautological, and reported as an arithmetic check rather than as evidence.
```

### Dispersion of risk contributions, by sub-period

`standalone` treats each sleeve's risk as its own volatility, which inverse-vol weights equalise almost by construction — it is here as an arithmetic check and NOT as evidence. `correlation_aware` uses the realised covariance of the window and is the real question: inverse-vol sizing cannot see correlation and never promised anything here, so three equity sleeves each sized to a modest standalone risk still move together. Lower dispersion is the more equal book.

| Period       | Basis             | Windows | Sleeves | Dispersion, equal | Dispersion, inv-vol | Inv-vol more equal | Eff. N, equal | Eff. N, inv-vol |
| ------------ | ----------------- | ------: | ------: | ----------------: | ------------------: | -----------------: | ------------: | --------------: |
| full sample  | correlation_aware |      82 |     7.9 |            0.0906 |              0.0577 |             90.24% |          5.32 |            6.52 |
| full sample  | standalone        |      82 |     7.9 |            0.0522 |              0.0246 |             96.34% |          6.77 |            7.60 |
| 2008         | correlation_aware |       4 |     8.0 |            0.1255 |              0.0966 |             75.00% |          4.04 |            5.24 |
| 2008         | standalone        |       4 |     8.0 |            0.0606 |              0.0343 |             75.00% |          6.47 |            7.34 |
| 2018Q4       | correlation_aware |       1 |     8.0 |            0.1413 |              0.1184 |            100.00% |          3.51 |            4.22 |
| 2018Q4       | standalone        |       1 |     8.0 |            0.0725 |              0.0441 |            100.00% |          5.98 |            7.11 |
| 2020Q1       | correlation_aware |       1 |     8.0 |            0.1069 |              0.0986 |            100.00% |          4.62 |            4.93 |
| 2020Q1       | standalone        |       1 |     8.0 |            0.0503 |              0.0507 |              0.00% |          6.88 |            6.87 |
| 2022         | correlation_aware |       4 |     8.0 |            0.0494 |              0.0372 |            100.00% |          6.90 |            7.33 |
| 2022         | standalone        |       4 |     8.0 |            0.0377 |              0.0162 |            100.00% |          7.32 |            7.87 |
| 2023-present | correlation_aware |      14 |     8.0 |            0.0597 |              0.0488 |             85.71% |          6.46 |            6.89 |
| 2023-present | standalone        |      14 |     8.0 |            0.0442 |              0.0248 |             92.86% |          7.06 |            7.66 |

## Correlation — and why there is no information coefficient here either

**Substituted for the same reason and one more.** The haircut is a risk control, and a risk control that has to be justified by return has already been converted into a return signal by whoever justified it. Its claim is that the book after the adjustment carries fewer duplicated bets than the book before, so that is what is measured: the effective number of bets and the largest principal component's share of variance, with and without.

Equal weight across the non-cash sleeves — the one book that embodies no view — sampled every 5 sessions on a 252-session window, 1,036 dates. Both measures are reported twice: once against the matrix the adjustment itself used, which is what the process knew, and once against the correlations REALISED over the following 252 sessions, which is the version that can say the haircut cut the wrong sleeves.

```
1,036 dates, 252-session window: the adjustment raised the effective number of bets, 1.51 to 1.51 as estimated and 1.52 to 1.52 against the following 252 sessions' realised correlations. Mean invested weight 100.0% before, 98.6% after.
```

### Effective bets, with and without the haircut

2008 and 2020Q1 are the rows this table exists for: they are the windows where correlations went to one, which is exactly when a diversification rule either earns its place or does not. Both concentration measures are SCALE-INVARIANT in the weights, so they cannot see the de-risking a uniform haircut performs at all — which is why invested weight sits beside them rather than instead of them, and why a fall in effective bets alongside a fall in invested weight is two true things rather than a contradiction.

| Period       | Dates | Sleeves | Avg pairwise rho | Mean book rho | Invested before | Invested after | Eff. bets before | Eff. bets after | Fwd bets before | Fwd bets after | Top PC share |
| ------------ | ----: | ------: | ---------------: | ------------: | --------------: | -------------: | ---------------: | --------------: | --------------: | -------------: | -----------: |
| full sample  | 1,036 |     7.9 |            0.219 |         0.219 |         100.00% |         98.57% |             1.51 |            1.51 |            1.52 |           1.52 |       84.95% |
| 2008         |    50 |     8.0 |            0.084 |         0.084 |         100.00% |        100.00% |             2.14 |            2.14 |            2.07 |           2.07 |       68.63% |
| 2018Q4       |    13 |     8.0 |            0.214 |         0.214 |         100.00% |         99.99% |             1.45 |            1.45 |            1.08 |           1.08 |       89.16% |
| 2020Q1       |    12 |     8.0 |            0.151 |         0.151 |         100.00% |         99.92% |             1.27 |            1.27 |            2.04 |           2.04 |       93.16% |
| 2022         |    50 |     8.0 |            0.252 |         0.252 |         100.00% |         98.54% |             1.65 |            1.66 |            1.07 |           1.08 |       82.07% |
| 2023-present |   180 |     8.0 |            0.348 |         0.348 |         100.00% |         94.05% |             1.15 |            1.18 |            1.22 |           1.26 |       96.81% |

## The signal correlation matrix

The whole case for running three signals rather than one rests on these numbers being low. If they are all above 0.60 the brief's instruction is to say so and reduce to fewer signals, and the line under the table is that instruction carried out.

Spearman over 8,233 (date, sleeve) cells from 1,036 dates sampled every 5 sessions. All three are read in the same direction — each is a multiplier on how much of a sleeve to hold — so a positive number means the two agree about size. The correlation multiplier is measured against the EQUAL-WEIGHT book rather than against the book trend and inverse-vol just proposed: measuring it against their output would guarantee some correlation through the input rather than through the signal.

|             |  trend | inverse_vol | correlation |
| ----------- | -----: | ----------: | ----------: |
| trend       |  1.000 |       0.031 |      -0.007 |
| inverse_vol |  0.031 |       1.000 |      -0.053 |
| correlation | -0.007 |      -0.053 |       1.000 |

**All 3 pairs sit inside ±0.60 (worst inverse_vol/correlation at -0.053). The ensemble's premise survives this test: the three are not restatements of each other. That is a statement about their scores and not about any of them being right.**

### The same three pairs inside each sleeve's own history

Pooling stacks nine sleeves onto one axis, so a pooled correlation can be manufactured entirely by the sleeves differing from each other in a way all three signals notice. These rows measure each pair within one sleeve, where that cannot happen — if the pooled matrix is much larger than these, the pooled number is a cross-sectional artefact.

A dash is not a zero. It means one of the two signals never moved for that sleeve inside the window — most often the correlation multiplier, which sits at exactly 1.0 for a sleeve that was never charged a haircut — and a correlation against a constant is undefined rather than absent.

| Sleeve                         | Ticker | Dates | Trend / inv-vol | Trend / corr | Inv-vol / corr |
| ------------------------------ | ------ | ----: | --------------: | -----------: | -------------: |
| Broad Commodity                | DBC    |   981 |          -0.298 |       -0.037 |          0.065 |
| Emerging Market Equity         | EEM    | 1,036 |          -0.025 |       -0.205 |         -0.282 |
| Developed International Equity | EFA    | 1,036 |           0.169 |       -0.302 |         -0.206 |
| Gold                           | GLD    | 1,036 |           0.031 |       -0.082 |         -0.159 |
| Intermediate Treasury Duration | IEF    | 1,036 |           0.256 |        0.335 |          0.482 |
| Investment Grade Credit        | LQD    | 1,036 |           0.307 |        0.266 |          0.594 |
| US Equity                      | SPY    | 1,036 |           0.448 |       -0.099 |         -0.049 |
| Long Treasury Duration         | TLT    | 1,036 |           0.110 |        0.303 |          0.262 |

## What was attacked before any of this was believed

A clean number nobody attacked is not a result. Each row is a way the tables above could be wrong while looking exactly like this.

| Check                                                     |      | What was measured                                                                                                                                                        |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trend scores at T survive truncation after T              | PASS | recomputed on the frame cut at 2017-12-07; identical across 8 sleeves                                                                                                    |
| Inverse-vol scalars at T survive truncation after T       | PASS | same date, same frame minus everything after it; identical                                                                                                               |
| Correlation matrix at T survives truncation after T       | PASS | 8x8 shrunk matrix, identical to the last bit                                                                                                                             |
| Curve weight at T is the score from T-2                   | PASS | 2-session fill lag; the curve forfeits the fill session's intraday move rather than claiming an overnight gap (confirmed)                                                |
| The panel behind every signal is close_adj                | PASS | 42,209 of 47,973 bars have an adjusted close different from the as-traded one; a panel where the two never differ is a price-return series wearing the total-return name |
| No score was invented where the signal declined           | PASS | 2,291 unscored cells, all of them NaN rather than a neutral value                                                                                                        |
| Costs are applied and non-zero on every curve that traded | PASS | 8 sleeve(s) turned over; drag 37.3 bps to 47.0 bps a year at 5.00bp one way                                                                                              |
| Pooled information coefficient stays under 0.15           | PASS | largest \|IC\| across horizons is 0.0377; above 0.15 at asset-class level this is a date alignment bug more often than it is a forecast                                  |
| No standalone curve clears a Sharpe of 1.2                | PASS | best single-sleeve long/flat Sharpe is 0.563 over the full sample; the brief's rule is to treat anything above 1.2 as evidence of a bug and hunt                         |

## What this does and does not prove

It proves that three signals were measured apart, on their own claims, before any of them was combined with the others — which is the only condition under which a contribution can be attributed to a signal rather than to the fit. It proves nothing about the combined system: the sizing layer applies these in a fixed order with caps and a budget on top, and none of the arithmetic above knows that layer exists.

It also proves nothing out of sample. Every window here is a window the sample contains, each stress period is ONE draw of a crisis, and the sub-period breakouts exist to show where a result came from rather than to multiply the evidence for it.

_Generated 2026-08-02 23:31 UTC by `evaluate_signals.py`._
