# The Post-Publication Ledger

Every strategy in `griffinquant/strategies/` through the same engine that produced `reports/stage3_sleeves.md`, measured twice: over the whole sample, and over the stretch that begins on the day its author published it. The second is the point. A holdout is a stretch of tape we set aside and can look at whenever we lose our nerve; a publication date was fixed by a stranger, in a document, years before this repository existed.

## The two answers

Both answers are taken over the 15-year-plus horizon the question names, across the 28 of 34 books that ran that long. Ranking a seven-year record against a twenty-one-year one on annualised return is not a ranking — it is a question about which window contained a bull market — so the shorter rows are reported separately below and never mixed in.

**1. Annualised return.** The highest CAGR over the full 21.6-year sample is **10.69% a year** — `spy_buy_and_hold`, 100% SPY, bought once, at 1x cost, with a 53.18% worst drawdown and a Sharpe of 0.55. The best PUBLISHED strategy over the same horizon is `fundamental_prf` at 10.35% a year, which is behind it by 0.35%.

**2. Ours.** The Griffin nine-sleeve book returned **5.35% a year** over 21.6 years, at 5.99% volatility, a Sharpe of 0.61 and a 9.69% worst drawdown. Buying and holding SPY over the same window returned 10.69% a year at 18.29% volatility and lost 53.18% doing it. We gave up 5.34% a year of return to take 43.49% less drawdown; whether that was a good trade is a mandate question and not one this file can settle.

**3. Sharpe.** The best Sharpe over the same horizon is **0.73** — `permanent_portfolio`, The Permanent Portfolio, at 6.99% a year and 7.17% volatility over 21.6 years. That **beats** the 0.61 the nine-sleeve book and the daily 60/40 both landed on, by 0.12. Deflated against the 23 distinct configurations on file it is 0.922, which does not clear the 95% bar — that is the number to quote if anybody asks whether it is real.

**Shorter records, kept out of the two answers above.** `momentum_spmo` returned 19.67% a year, but over 7.8 years. These are the rows whose vehicles listed late, and their windows are mostly the 2018-2026 US equity run. They are in every table below with their lengths beside them; they are not an answer to a question about fifteen to twenty years.

**Across 30 dated strategies measured from their own publication dates forward, the mean excess return over buy-and-hold SPY is -4.03% a year (95% interval -5.39% to -2.67%) and the median is -3.21%. 3 of 30 beat SPY after publication.**

## The run

|                       |                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                | Tiingo daily EOD (ETF universe, 148 funds)                                                                                                          |
| Study window          | 2005-01-03 to 2026-07-31                                                                                                                            |
| Sessions              | 5,428                                                                                                                                               |
| Pull                  | 1990-01-01 onward — the extra history is never measured, it is what the deployability rule reads                                                    |
| Funds served          | 148                                                                                                                                                 |
| Strategies registered | 33                                                                                                                                                  |
| Dated / undated       | 30 dated, 3 undated controls                                                                                                                        |
| Measured              | 34 books                                                                                                                                            |
| Skipped               | 0                                                                                                                                                   |
| Starting cash         | $131,000.00                                                                                                                                         |
| Settlement            | T+1, 5% of NAV held back                                                                                                                            |
| Turnover budget       | 5% of NAV a day, hard                                                                                                                               |
| No-trade band         | 0.5% of NAV drift                                                                                                                                   |
| Participation cap     | 1% of the name's median dollar volume                                                                                                               |
| Fills                 | decided at the close of T, filled at the open of T+1                                                                                                |
| Marks                 | `close_adj`; screens and share counts read `close_unadj`                                                                                            |
| Sleeve caps           | off for the library, on for the house book                                                                                                          |
| Deployability floor   | $655,000 a day, derived                                                                                                                             |
| Risk-free hurdle      | FRED DGS3MO, the 3-month constant-maturity bill yield, annualised and converted geometrically to a per-session hurdle (0.00%-8.26% across the pull) |
| Cost multiples        | 1x, 2x, 3x                                                                                                                                          |
| Trials on file        | 23 distinct configurations                                                                                                                          |
| Cache                 | /Users/thomasseirer/repos/gcig-app/quant/data/cache                                                                                                 |
| Report                | /Users/thomasseirer/repos/gcig-app/quant/reports/post_publication_ledger.md                                                                         |

## What counts as one trial

Thirty-three strategies, one row in `trials.jsonl`. Every rule here is implemented as its source states it, with the parameters the source gives, and nothing in this file was swept, tuned, or chosen by looking at a result — so what was evaluated is a single decision, which was to run the library as published. A specification search over thirty-three variants would owe the deflated Sharpe thirty-three rows, and the difference is not cosmetic: it moves the best-of-N hurdle that every number in this report is judged against.

The corollary is the part that costs something. A bad row is kept. Faber's ten-month rule returns less than half of buy-and-hold SPY over this sample and stays in the table at that number, because a replication that drops its failures is a search wearing a replication's clothes.

## The windows, and why the second is not a holdout

**Full sample** runs from the study start, or from the first session this row's vehicles could absorb the account, whichever is later. **After publication** runs from the date on the paper. **Before publication** is the same run up to the day before it, so the two partition the record and the decay claim has something to decay from. For the factor rows there is a fourth window, from the date an ETF existed to hold the idea — Jegadeesh and Titman published momentum in 1993 and MTUM listed in 2013, and that twenty-year gap is the most interesting column in this report, because for two decades the finding was public and unbuyable.

Each window is read off ONE backtest per strategy rather than a fresh run per window. A fresh run opening on a publication date would spend its first twelve months banking a warmup the rule had already banked years earlier and would report that cash as the strategy's post-publication return. The pre-publication tape is used for the rule's own trailing windows and for nothing else: no parameter here was chosen by looking at it, because no parameter here was chosen at all.

A window shorter than 252 sessions is printed but kept out of the decay arithmetic. Annualising a stretch that short is extrapolation with a percent sign on it.

## When each row could actually be held

The engine caps a single day's order at 1% of the name's own median dollar volume, and the turnover budget wants 5% of NAV a day — so a fund whose tape cannot carry $655,000 a day cannot be deployed into at all. The figure is arithmetic on three engine constants, not a threshold anybody picked.

This is not a technicality, and finding it is most of what this run did before it produced a table. Measured from its listing day, USMV reports 2.31% a year with two fills in fifteen years: on its third session the fund traded $52,000, the participation cap refused the buy, and `BuyAndHold` — correctly — latched on not having moved and never bought again. That number is a fact about a newborn ETF meeting a cap, not a fact about low volatility, and printing it in a decay table would have been the largest single error in this study.

| Strategy                | Published  | Investable | Earliest bar | Opened on  | Paper to fund (yrs) | Legs |
| ----------------------- | ---------- | ---------- | ------------ | ---------- | ------------------: | ---: |
| spy_buy_and_hold        | _undated_  | —          | 1993-01-29   | 2005-01-03 |                   — |    1 |
| sixty_forty_monthly     | _undated_  | —          | 1993-01-29   | 2005-01-03 |                   — |    2 |
| sixty_forty_daily       | _undated_  | —          | 1993-01-29   | 2005-01-03 |                   — |    2 |
| permanent_portfolio     | 1981-01-01 | —          | 1993-01-29   | 2005-01-03 |                   — |    4 |
| all_weather_retail      | 2014-11-18 | —          | 1993-01-29   | 2005-01-03 |                   — |    5 |
| equal_weight_universe   | 2009-05-01 | —          | 1993-01-29   | 2005-01-03 |                   — |  142 |
| faber_gtaa_10mo         | 2007-04-30 | —          | 1993-01-29   | 2005-01-03 |                   — |    6 |
| absolute_momentum_12m   | 2013-04-30 | —          | 1993-01-29   | 2005-01-03 |                   — |    2 |
| antonacci_gem           | 2014-12-01 | —          | 1993-01-29   | 2005-01-03 |                   — |    4 |
| aaa                     | 2012-12-31 | —          | 1993-01-29   | 2005-01-03 |                   — |   10 |
| paa                     | 2016-04-30 | —          | 1993-01-29   | 2005-01-03 |                   — |   13 |
| vaa                     | 2017-07-31 | —          | 1993-01-29   | 2005-01-03 |                   — |   14 |
| vaa_g4                  | 2017-07-31 | —          | 2002-07-26   | 2005-01-03 |                   — |    7 |
| daa                     | 2018-07-31 | —          | 1993-01-29   | 2005-01-03 |                   — |   15 |
| gtaa_agg6               | 2013-02-28 | —          | 1993-01-29   | 2005-01-03 |                   — |   13 |
| risk-parity-unlevered   | 2005-09-01 | —          | 1993-01-29   | 2005-01-03 |                   — |   10 |
| equal-risk-contribution | 2010-07-01 | —          | 1993-01-29   | 2005-01-03 |                   — |   10 |
| minimum-variance        | 1991-04-01 | —          | 1998-12-22   | 2005-01-03 |                   — |   11 |
| maximum-diversification | 2008-10-01 | —          | 1998-12-22   | 2005-01-03 |                   — |   11 |
| momentum_mtum           | 1993-03-01 | 2013-04-16 | 2013-04-18   | 2013-07-30 |               +20.1 |    1 |
| momentum_spmo           | 1993-03-01 | 2015-10-09 | 2015-10-12   | 2018-10-12 |               +22.6 |    1 |
| value_vlue              | 1992-06-01 | 2013-04-16 | 2013-04-18   | 2015-09-28 |               +20.9 |    1 |
| value_iwd               | 1992-06-01 | 2000-05-22 | 2000-05-26   | 2005-01-03 |                +8.0 |    1 |
| value_vtv               | 1992-06-01 | 2004-01-26 | 2004-01-30   | 2005-01-03 |               +11.7 |    1 |
| quality_qual            | 2013-04-01 | 2013-07-16 | 2013-07-18   | 2013-08-30 |                +0.3 |    1 |
| quality_sphq            | 2013-04-01 | 2012-01-03 | 2005-12-06   | 2005-12-19 |                -1.2 |    1 |
| lowvol_usmv             | 1991-04-01 | 2011-10-18 | 2011-10-20   | 2012-05-17 |               +20.5 |    1 |
| lowvol_splv             | 1991-04-01 | 2011-05-05 | 2011-05-05   | 2011-06-28 |               +20.1 |    1 |
| size_rsp                | 1981-03-01 | 2003-04-24 | 2003-04-30   | 2005-01-03 |               +22.1 |    1 |
| fundamental_prf         | 2005-03-01 | 2005-12-19 | 2005-12-19   | 2006-01-03 |                +0.8 |    1 |
| multifactor_ishares     | 2013-06-01 | 2013-07-16 | 2011-10-20   | 2012-05-17 |                +0.1 |    4 |
| multifactor_six         | 2013-06-01 | 2013-07-16 | 2003-04-30   | 2005-01-03 |                +0.1 |    6 |
| multifactor_longest     | 2013-06-01 | 2012-01-03 | 2000-05-26   | 2005-01-03 |                -1.4 |    5 |
| griffin_sleeves         | _undated_  | —          | 1993-01-29   | 2005-01-03 |                   — |    9 |

## Full sample, at 1x cost

`Excess CAGR` and `Excess SR` are against a buy-and-hold of SPY run fresh from the SAME opening session, through the same engine, on the same cost model — so both books start in cash on the same morning and both spend nineteen sessions deploying under the same turnover budget. A strategy published in 2018 compared against SPY from 2005 is not being compared against anything.

| Strategy                | Family   | From       | Sessions | Years |    CAGR |    Vol | Sharpe |   DSR |  Max DD | Recovery       | SPY CAGR | Excess CAGR | Excess SR | Turnover/yr | Cost drag | Deferrals |
| ----------------------- | -------- | ---------- | -------: | ----: | ------: | -----: | -----: | ----: | ------: | -------------- | -------: | ----------: | --------: | ----------: | --------: | --------: |
| spy_buy_and_hold        | static   | 2005-01-03 |    5,427 |  21.6 | +10.69% | 18.29% |   0.55 | 0.723 | -53.18% | 869 sessions   |  +10.69% |      +0.00% |      0.00 |        0.02 |   0.1 bps |         1 |
| sixty_forty_monthly     | static   | 2005-01-03 |    5,427 |  21.6 |  +7.75% | 10.06% |   0.62 | 0.815 | -31.14% | 398 sessions   |  +10.69% |      -2.95% |      0.07 |        0.18 |   0.5 bps |       237 |
| sixty_forty_daily       | static   | 2005-01-03 |    5,427 |  21.6 |  +7.82% | 10.29% |   0.61 | 0.810 | -30.32% | 391 sessions   |  +10.69% |      -2.87% |      0.06 |        0.38 |   0.8 bps |     1,141 |
| permanent_portfolio     | static   | 2005-01-03 |    5,427 |  21.6 |  +6.99% |  7.17% |   0.73 | 0.922 | -17.69% | 343 sessions   |  +10.69% |      -3.71% |      0.18 |        0.09 |   0.7 bps |        20 |
| all_weather_retail      | static   | 2005-01-03 |    5,427 |  21.6 |  +6.31% |  7.48% |   0.62 | 0.817 | -21.87% | 673 sessions   |  +10.69% |      -4.39% |      0.07 |        0.11 |   0.4 bps |        45 |
| equal_weight_universe   | static   | 2005-01-03 |    5,427 |  21.6 |  +7.85% | 13.64% |   0.49 | 0.626 | -43.20% | 452 sessions   |  +10.69% |      -2.85% |     -0.06 |        0.08 |   1.5 bps |     1,592 |
| faber_gtaa_10mo         | trend    | 2005-01-03 |    5,427 |  21.6 |  +3.75% |  5.97% |   0.35 | 0.370 | -13.97% | 407 sessions   |  +10.69% |      -6.94% |     -0.20 |        2.09 |   8.9 bps |     1,494 |
| absolute_momentum_12m   | trend    | 2005-01-03 |    5,427 |  21.6 |  +9.19% | 13.97% |   0.57 | 0.755 | -32.34% | 166 sessions   |  +10.69% |      -1.50% |      0.02 |        0.50 |   0.8 bps |     1,146 |
| antonacci_gem           | trend    | 2005-01-03 |    5,427 |  21.6 |  +8.16% | 14.01% |   0.50 | 0.646 | -32.32% | 114 sessions   |  +10.69% |      -2.53% |     -0.05 |        1.41 |   1.9 bps |     1,128 |
| aaa                     | tactical | 2005-01-03 |    5,427 |  21.6 |  +5.83% |  7.84% |   0.54 | 0.700 | -15.88% | 395 sessions   |  +10.69% |      -4.86% |     -0.01 |        7.61 |  32.4 bps |     4,273 |
| paa                     | tactical | 2005-01-03 |    5,427 |  21.6 |  +6.31% |  8.23% |   0.57 | 0.751 | -19.03% | 700 sessions   |  +10.69% |      -4.38% |      0.02 |        4.39 |  10.2 bps |     7,447 |
| vaa                     | tactical | 2005-01-03 |    5,427 |  21.6 |  +2.91% |  6.28% |   0.21 | 0.158 | -15.82% | 1,259 sessions |  +10.69% |      -7.78% |     -0.35 |        9.04 |  24.2 bps |     2,621 |
| vaa_g4                  | tactical | 2005-01-03 |    5,427 |  21.6 |  +3.13% | 11.56% |   0.17 | 0.122 | -26.37% | 1,279 sessions |  +10.69% |      -7.56% |     -0.38 |        8.32 |  21.5 bps |     1,721 |
| daa                     | tactical | 2005-01-03 |    5,427 |  21.6 |  +4.49% |  7.43% |   0.39 | 0.440 | -21.03% | 271 sessions   |  +10.69% |      -6.20% |     -0.16 |        7.92 |  19.2 bps |     3,928 |
| gtaa_agg6               | tactical | 2005-01-03 |    5,427 |  21.6 |  +6.59% | 11.04% |   0.47 | 0.593 | -20.58% | 131 sessions   |  +10.69% |      -4.10% |     -0.08 |        4.00 |  20.2 bps |     7,858 |
| risk-parity-unlevered   | risk     | 2005-01-03 |    5,427 |  21.6 |  +4.68% |  6.27% |   0.48 | 0.601 | -19.12% | 476 sessions   |  +10.69% |      -6.02% |     -0.07 |        0.33 |   1.0 bps |    17,961 |
| equal-risk-contribution | risk     | 2005-01-03 |    5,427 |  21.6 |  +4.57% |  6.18% |   0.47 | 0.583 | -18.61% | 477 sessions   |  +10.69% |      -6.12% |     -0.08 |        0.40 |   1.2 bps |    19,190 |
| minimum-variance        | risk     | 2005-01-03 |    5,427 |  21.6 |  +8.35% | 12.07% |   0.58 | 0.766 | -34.62% | 411 sessions   |  +10.69% |      -2.34% |      0.03 |        4.22 |   7.1 bps |    12,381 |
| maximum-diversification | risk     | 2005-01-03 |    5,427 |  21.6 |  +8.76% | 15.52% |   0.51 | 0.648 | -48.26% | 743 sessions   |  +10.69% |      -1.93% |     -0.05 |        1.56 |   2.6 bps |    20,590 |
| momentum_mtum           | factor   | 2013-07-30 |    3,270 |  13.0 | +15.01% | 19.86% |   0.71 | 0.724 | -33.45% | 72 sessions    |  +13.71% |      +1.29% |     -0.04 |        0.03 |   1.8 bps |         1 |
| momentum_spmo           | factor   | 2018-10-12 |    1,958 |   7.8 | +19.67% | 21.77% |   0.81 | 0.616 | -29.68% | 74 sessions    |  +14.95% |      +4.72% |      0.12 |        0.06 |   4.3 bps |         1 |
| value_vlue              | factor   | 2015-09-28 |    2,725 |  10.8 | +13.26% | 19.11% |   0.63 | 0.546 | -38.18% | 200 sessions   |  +14.40% |      -1.13% |     -0.11 |        0.05 |   3.1 bps |         1 |
| value_iwd               | factor   | 2005-01-03 |    5,427 |  21.6 |  +8.69% | 18.64% |   0.45 | 0.543 | -57.97% | 980 sessions   |  +10.69% |      -2.00% |     -0.10 |        0.02 |   0.3 bps |         1 |
| value_vtv               | factor   | 2005-01-03 |    5,427 |  21.6 |  +9.31% | 18.22% |   0.48 | 0.610 | -57.04% | 985 sessions   |  +10.69% |      -1.38% |     -0.07 |        0.02 |   0.8 bps |         0 |
| quality_qual            | factor   | 2013-08-30 |    3,247 |  12.9 | +13.24% | 16.69% |   0.72 | 0.729 | -33.25% | 99 sessions    |  +13.75% |      -0.51% |     -0.03 |        0.03 |   1.8 bps |         0 |
| quality_sphq            | factor   | 2005-12-19 |    5,183 |  20.6 |  +9.98% | 13.45% |   0.65 | 0.835 | -31.03% | 93 sessions    |  +10.73% |      -0.75% |      0.10 |        0.02 |   1.0 bps |         1 |
| lowvol_usmv             | factor   | 2012-05-17 |    3,570 |  14.2 | +10.96% | 13.16% |   0.73 | 0.778 | -32.50% | 202 sessions   |  +14.63% |      -3.67% |     -0.09 |        0.03 |   1.5 bps |         1 |
| lowvol_splv             | factor   | 2011-06-28 |    3,794 |  15.1 |  +9.84% | 14.16% |   0.62 | 0.670 | -35.62% | 272 sessions   |  +13.78% |      -3.94% |     -0.14 |        0.03 |   0.9 bps |         0 |
| size_rsp                | factor   | 2005-01-03 |    5,427 |  21.6 |  +9.88% | 19.48% |   0.49 | 0.624 | -57.80% | 485 sessions   |  +10.69% |      -0.81% |     -0.06 |        0.02 |   0.4 bps |         1 |
| fundamental_prf         | factor   | 2006-01-03 |    5,175 |  20.6 | +10.35% | 21.28% |   0.49 | 0.602 | -57.92% | 492 sessions   |  +10.72% |      -0.38% |     -0.06 |        0.02 |   0.9 bps |         0 |
| multifactor_ishares     | factor   | 2012-05-17 |    3,570 |  14.2 | +11.00% | 14.50% |   0.68 | 0.718 | -33.42% | 114 sessions   |  +14.63% |      -3.63% |     -0.14 |        0.17 |   2.4 bps |     1,296 |
| multifactor_six         | factor   | 2005-01-03 |    5,427 |  21.6 |  +7.04% | 11.90% |   0.48 | 0.609 | -34.60% | 161 sessions   |  +10.69% |      -3.65% |     -0.07 |        0.10 |   1.3 bps |       885 |
| multifactor_longest     | factor   | 2005-01-03 |    5,427 |  21.6 |  +8.05% | 12.02% |   0.56 | 0.731 | -35.12% | 165 sessions   |  +10.69% |      -2.64% |      0.01 |        0.06 |   0.6 bps |     1,926 |
| griffin_sleeves         | house    | 2005-01-03 |    5,427 |  21.6 |  +5.35% |  5.99% |   0.61 | 0.800 |  -9.69% | 85 sessions    |  +10.69% |      -5.34% |      0.05 |        7.15 |  16.0 bps |    10,715 |

One asymmetry is left in rather than equalised. A twelve-month rule spends its first twelve months in cash while it banks the window it needs, and the benchmarks deploy immediately. That is what the process could actually have done on those days, and starting the benchmark late would report a comparison nobody could have run. It costs the trend and tactical families roughly a year of the column above and costs the post-publication column nothing, because by then every rule is long since deployed.

## After publication, at 1x cost

The table the study exists for. Every row below begins on a date somebody else chose and wrote down, and none of it was available to be fitted.

| Strategy                | Family   | From       | Sessions | Years |    CAGR |    Vol | Sharpe |   DSR |  Max DD | Recovery           | SPY CAGR | Excess CAGR | Excess SR | Turnover/yr | Cost drag | Deferrals |
| ----------------------- | -------- | ---------- | -------: | ----: | ------: | -----: | -----: | ----: | ------: | ------------------ | -------: | ----------: | --------: | ----------: | --------: | --------: |
| permanent_portfolio     | static   | 2005-01-03 |    5,427 |  21.6 |  +6.99% |  7.17% |   0.73 | 0.922 | -17.69% | 343 sessions       |  +10.69% |      -3.71% |      0.18 |        0.09 |   0.7 bps |        20 |
| all_weather_retail      | static   | 2014-11-17 |    2,941 |  11.7 |  +5.39% |  7.94% |   0.44 | 0.327 | -21.87% | 673 sessions       |  +13.43% |      -8.04% |     -0.25 |        0.08 |   0.1 bps |        31 |
| equal_weight_universe   | static   | 2009-04-30 |    4,339 |  17.3 |  +9.48% | 12.34% |   0.68 | 0.803 | -27.74% | 114 sessions       |  +14.90% |      -5.42% |     -0.15 |        0.04 |   0.7 bps |       721 |
| faber_gtaa_10mo         | trend    | 2007-04-27 |    4,845 |  19.3 |  +3.30% |  6.03% |   0.32 | 0.291 | -13.97% | 407 sessions       |  +10.53% |      -7.24% |     -0.22 |        2.20 |   8.9 bps |     1,470 |
| absolute_momentum_12m   | trend    | 2013-04-29 |    3,334 |  13.3 | +11.32% | 14.96% |   0.67 | 0.681 | -32.34% | 166 sessions       |  +14.07% |      -2.76% |     -0.09 |        0.48 |   0.4 bps |       771 |
| antonacci_gem           | trend    | 2014-11-28 |    2,933 |  11.7 |  +7.45% | 15.20% |   0.41 | 0.292 | -32.32% | 114 sessions       |  +13.34% |      -5.89% |     -0.28 |        1.73 |   2.2 bps |       627 |
| aaa                     | tactical | 2012-12-28 |    3,416 |  13.6 |  +6.23% |  7.48% |   0.61 | 0.609 | -15.88% | 395 sessions       |  +14.79% |      -8.55% |     -0.20 |        7.98 |  32.3 bps |     2,577 |
| paa                     | tactical | 2016-04-29 |    2,577 |  10.3 |  +6.72% |  8.19% |   0.55 | 0.421 | -19.03% | 700 sessions       |  +15.02% |      -8.30% |     -0.20 |        4.67 |   8.7 bps |     3,808 |
| vaa                     | tactical | 2017-07-28 |    2,263 |   9.0 |  +4.76% |  6.19% |   0.37 | 0.195 |  -7.60% | 605 sessions       |  +14.68% |      -9.92% |     -0.33 |        9.37 |  16.5 bps |     1,268 |
| vaa_g4                  | tactical | 2017-07-28 |    2,263 |   9.0 |  +2.77% |  7.00% |   0.06 | 0.037 | -11.10% | open, 107 sessions |  +14.68% |     -11.91% |     -0.64 |        9.57 |  13.9 bps |       567 |
| daa                     | tactical | 2018-07-30 |    2,011 |   8.0 |  +7.63% |  7.44% |   0.66 | 0.463 |  -7.81% | 18 sessions        |  +14.63% |      -7.00% |     -0.01 |        8.77 |  16.8 bps |     1,738 |
| gtaa_agg6               | tactical | 2013-02-27 |    3,376 |  13.4 |  +7.60% | 10.35% |   0.59 | 0.572 | -20.58% | 131 sessions       |  +14.31% |      -6.71% |     -0.20 |        4.06 |  20.6 bps |     5,323 |
| risk-parity-unlevered   | risk     | 2005-08-31 |    5,260 |  20.9 |  +4.83% |  6.37% |   0.50 | 0.626 | -19.12% | 476 sessions       |  +10.83% |      -6.00% |     -0.06 |        0.33 |   1.0 bps |    17,961 |
| equal-risk-contribution | risk     | 2010-06-30 |    4,045 |  16.1 |  +4.51% |  6.19% |   0.50 | 0.515 | -18.61% | 477 sessions       |  +14.78% |     -10.27% |     -0.32 |        0.37 |   0.8 bps |    15,389 |
| minimum-variance        | risk     | 2005-01-03 |    5,427 |  21.6 |  +8.35% | 12.07% |   0.58 | 0.766 | -34.62% | 411 sessions       |  +10.69% |      -2.34% |      0.03 |        4.22 |   7.1 bps |    12,381 |
| maximum-diversification | risk     | 2008-09-30 |    4,485 |  17.8 | +10.33% | 16.16% |   0.60 | 0.720 | -37.88% | 215 sessions       |  +12.78% |      -2.44% |     -0.05 |        1.57 |   2.3 bps |    17,742 |
| momentum_mtum           | factor   | 2013-07-30 |    3,270 |  13.0 | +15.01% | 19.86% |   0.71 | 0.724 | -33.45% | 72 sessions        |  +13.71% |      +1.29% |     -0.04 |        0.03 |   1.8 bps |         1 |
| momentum_spmo           | factor   | 2018-10-12 |    1,958 |   7.8 | +19.67% | 21.77% |   0.81 | 0.616 | -29.68% | 74 sessions        |  +14.95% |      +4.72% |      0.12 |        0.06 |   4.3 bps |         1 |
| value_vlue              | factor   | 2015-09-28 |    2,725 |  10.8 | +13.26% | 19.11% |   0.63 | 0.546 | -38.18% | 200 sessions       |  +14.40% |      -1.13% |     -0.11 |        0.05 |   3.1 bps |         1 |
| value_iwd               | factor   | 2005-01-03 |    5,427 |  21.6 |  +8.69% | 18.64% |   0.45 | 0.543 | -57.97% | 980 sessions       |  +10.69% |      -2.00% |     -0.10 |        0.02 |   0.3 bps |         1 |
| value_vtv               | factor   | 2005-01-03 |    5,427 |  21.6 |  +9.31% | 18.22% |   0.48 | 0.610 | -57.04% | 985 sessions       |  +10.69% |      -1.38% |     -0.07 |        0.02 |   0.8 bps |         0 |
| quality_qual            | factor   | 2013-08-30 |    3,247 |  12.9 | +13.24% | 16.69% |   0.72 | 0.729 | -33.25% | 99 sessions        |  +13.75% |      -0.51% |     -0.03 |        0.03 |   1.8 bps |         0 |
| quality_sphq            | factor   | 2013-03-28 |    3,355 |  13.3 | +14.12% | 16.42% |   0.78 | 0.808 | -31.03% | 93 sessions        |  +14.08% |      +0.03% |      0.01 |        0.00 |   0.0 bps |         0 |
| lowvol_usmv             | factor   | 2012-05-17 |    3,570 |  14.2 | +10.96% | 13.16% |   0.73 | 0.778 | -32.50% | 202 sessions       |  +14.63% |      -3.67% |     -0.09 |        0.03 |   1.5 bps |         1 |
| lowvol_splv             | factor   | 2011-06-28 |    3,794 |  15.1 |  +9.84% | 14.16% |   0.62 | 0.670 | -35.62% | 272 sessions       |  +13.78% |      -3.94% |     -0.14 |        0.03 |   0.9 bps |         0 |
| size_rsp                | factor   | 2005-01-03 |    5,427 |  21.6 |  +9.88% | 19.48% |   0.49 | 0.624 | -57.80% | 485 sessions       |  +10.69% |      -0.81% |     -0.06 |        0.02 |   0.4 bps |         1 |
| fundamental_prf         | factor   | 2006-01-03 |    5,175 |  20.6 | +10.35% | 21.28% |   0.49 | 0.602 | -57.92% | 492 sessions       |  +10.72% |      -0.38% |     -0.06 |        0.02 |   0.9 bps |         0 |
| multifactor_ishares     | factor   | 2013-05-31 |    3,311 |  13.2 | +11.92% | 15.06% |   0.70 | 0.718 | -33.42% | 114 sessions       |  +13.89% |      -1.97% |     -0.05 |        0.17 |   2.5 bps |     1,296 |
| multifactor_six         | factor   | 2013-05-31 |    3,311 |  13.2 | +11.79% | 15.22% |   0.69 | 0.701 | -34.60% | 161 sessions       |  +13.96% |      -2.17% |     -0.07 |        0.13 |   1.7 bps |       885 |
| multifactor_longest     | factor   | 2013-05-31 |    3,311 |  13.2 | +11.38% | 14.99% |   0.67 | 0.681 | -35.12% | 165 sessions       |  +13.96% |      -2.58% |     -0.08 |        0.05 |   0.2 bps |     1,834 |

## Before publication, at 1x cost

The other half of the ratio. McLean and Pontiff's 58% compares after with before, so a study that measures only the after can report a small post-publication number without ever showing that it used to be a large one. Only strategies published inside this sample have a before; the rest were already in print when the tape starts, and their absence from this table is the reason the paired count below is smaller than the dated count.

| Strategy                | Family   | From       | Sessions | Years |   CAGR |    Vol |  Sharpe |   DSR |  Max DD | Recovery           | SPY CAGR | Excess CAGR | Excess SR | Turnover/yr | Cost drag | Deferrals |
| ----------------------- | -------- | ---------- | -------: | ----: | -----: | -----: | ------: | ----: | ------: | ------------------ | -------: | ----------: | --------: | ----------: | --------: | --------: |
| all_weather_retail      | static   | 2005-01-03 |    2,486 |   9.9 | +7.40% |  6.91% |    0.86 | 0.771 | -13.82% | 25 sessions        |   +7.53% |      -0.13% |      0.46 |        0.16 |   1.1 bps |        14 |
| equal_weight_universe   | static   | 2005-01-03 |    1,088 |   4.3 | +1.56% | 17.90% |   -0.00 | 0.025 | -43.20% | open, 376 sessions |   -4.64% |      +6.20% |      0.22 |        0.39 |   8.8 bps |       871 |
| faber_gtaa_10mo         | trend    | 2005-01-03 |      582 |   2.3 | +7.62% |  5.39% |    0.63 | 0.159 |  -5.25% | 45 sessions        |  +12.01% |      -4.39% |     -0.16 |        0.72 |   9.5 bps |        24 |
| absolute_momentum_12m   | trend    | 2005-01-03 |    2,093 |   8.3 | +5.89% | 12.23% |    0.39 | 0.204 | -19.51% | 127 sessions       |   +5.51% |      +0.38% |      0.11 |        0.57 |   3.0 bps |       375 |
| antonacci_gem           | trend    | 2005-01-03 |    2,494 |   9.9 | +9.01% | 12.47% |    0.64 | 0.520 | -20.95% | 492 sessions       |   +7.65% |      +1.35% |      0.24 |        0.47 |   1.0 bps |       501 |
| aaa                     | tactical | 2005-01-03 |    2,011 |   8.0 | +5.15% |  8.43% |    0.43 | 0.228 |  -8.90% | 119 sessions       |   +4.05% |      +1.09% |      0.22 |        6.50 |  32.7 bps |     1,696 |
| paa                     | tactical | 2005-01-03 |    2,850 |  11.3 | +5.94% |  8.27% |    0.59 | 0.505 | -10.94% | 384 sessions       |   +6.91% |      -0.97% |      0.21 |        3.95 |  12.5 bps |     3,639 |
| vaa                     | tactical | 2005-01-03 |    3,164 |  12.6 | +1.60% |  6.35% |    0.09 | 0.052 | -15.82% | 1,259 sessions     |   +7.91% |      -6.32% |     -0.35 |        8.72 |  31.9 bps |     1,353 |
| vaa_g4                  | tactical | 2005-01-03 |    3,164 |  12.6 | +3.39% | 13.93% |    0.22 | 0.122 | -26.37% | 1,279 sessions     |   +7.91% |      -4.53% |     -0.22 |        7.25 |  28.0 bps |     1,154 |
| daa                     | tactical | 2005-01-03 |    3,416 |  13.6 | +2.68% |  7.43% |    0.23 | 0.134 | -21.03% | 271 sessions       |   +8.43% |      -5.75% |     -0.25 |        7.06 |  21.6 bps |     2,190 |
| gtaa_agg6               | tactical | 2005-01-03 |    2,051 |   8.2 | +4.95% | 12.09% |    0.32 | 0.147 | -19.47% | open, 459 sessions |   +4.98% |      -0.02% |      0.06 |        3.80 |  19.1 bps |     2,535 |
| risk-parity-unlevered   | risk     | 2005-01-03 |      167 |   0.7 | +0.00% |  0.00% | -135.39 | 0.000 |   0.00% | 0 sessions         |   +6.51% |      -6.51% |   -135.79 |        0.00 |   0.0 bps |         0 |
| equal-risk-contribution | risk     | 2005-01-03 |    1,382 |   5.5 | +4.76% |  6.17% |    0.38 | 0.139 | -16.07% | 261 sessions       |   -0.46% |      +5.23% |      0.40 |        0.55 |   3.3 bps |     3,801 |
| maximum-diversification | risk     | 2005-01-03 |      942 |   3.7 | +1.56% | 12.05% |   -0.11 | 0.014 | -18.86% | open, 203 sessions |   +1.28% |      +0.28% |     -0.03 |        1.56 |   6.2 bps |     2,848 |
| quality_sphq            | factor   | 2005-12-19 |    1,828 |   7.3 | +2.78% |  4.28% |    0.31 | 0.127 |  -7.21% | 46 sessions        |   +4.82% |      -2.04% |      0.05 |        0.13 |   6.7 bps |         1 |
| multifactor_ishares     | factor   | 2012-05-17 |      259 |   1.0 | +0.00% |  0.00% |  -60.42 | 0.000 |   0.00% | 0 sessions         |  +24.50% |     -24.50% |    -62.40 |        0.00 |   0.0 bps |         0 |
| multifactor_six         | factor   | 2005-01-03 |    2,116 |   8.4 | +0.00% |  0.00% |  -13.80 | 0.000 |   0.00% | 0 sessions         |   +5.76% |      -5.76% |    -14.09 |        0.00 |   0.0 bps |         0 |
| multifactor_longest     | factor   | 2005-01-03 |    2,116 |   8.4 | +3.03% |  4.39% |    0.32 | 0.150 |  -7.91% | 45 sessions        |   +5.76% |      -2.73% |      0.03 |        0.12 |   2.3 bps |        92 |

## From the vehicle, at 1x cost

The factor rows only. This is the window an investor could have held rather than the one the literature could have read, and where the two differ by two decades the difference is the finding.

| Strategy            | Family | From       | Sessions | Years |    CAGR |    Vol | Sharpe |   DSR |  Max DD | Recovery     | SPY CAGR | Excess CAGR | Excess SR | Turnover/yr | Cost drag | Deferrals |
| ------------------- | ------ | ---------- | -------: | ----: | ------: | -----: | -----: | ----: | ------: | ------------ | -------: | ----------: | --------: | ----------: | --------: | --------: |
| momentum_mtum       | factor | 2013-07-30 |    3,270 |  13.0 | +15.01% | 19.86% |   0.71 | 0.724 | -33.45% | 72 sessions  |  +13.71% |      +1.29% |     -0.04 |        0.03 |   1.8 bps |         1 |
| momentum_spmo       | factor | 2018-10-12 |    1,958 |   7.8 | +19.67% | 21.77% |   0.81 | 0.616 | -29.68% | 74 sessions  |  +14.95% |      +4.72% |      0.12 |        0.06 |   4.3 bps |         1 |
| value_vlue          | factor | 2015-09-28 |    2,725 |  10.8 | +13.26% | 19.11% |   0.63 | 0.546 | -38.18% | 200 sessions |  +14.40% |      -1.13% |     -0.11 |        0.05 |   3.1 bps |         1 |
| value_iwd           | factor | 2005-01-03 |    5,427 |  21.6 |  +8.69% | 18.64% |   0.45 | 0.543 | -57.97% | 980 sessions |  +10.69% |      -2.00% |     -0.10 |        0.02 |   0.3 bps |         1 |
| value_vtv           | factor | 2005-01-03 |    5,427 |  21.6 |  +9.31% | 18.22% |   0.48 | 0.610 | -57.04% | 985 sessions |  +10.69% |      -1.38% |     -0.07 |        0.02 |   0.8 bps |         0 |
| quality_qual        | factor | 2013-08-30 |    3,247 |  12.9 | +13.24% | 16.69% |   0.72 | 0.729 | -33.25% | 99 sessions  |  +13.75% |      -0.51% |     -0.03 |        0.03 |   1.8 bps |         0 |
| quality_sphq        | factor | 2011-12-30 |    3,665 |  14.6 | +14.39% | 15.99% |   0.82 | 0.875 | -31.03% | 93 sessions  |  +14.67% |      -0.27% |     -0.00 |        0.02 |   1.1 bps |         1 |
| lowvol_usmv         | factor | 2012-05-17 |    3,570 |  14.2 | +10.96% | 13.16% |   0.73 | 0.778 | -32.50% | 202 sessions |  +14.63% |      -3.67% |     -0.09 |        0.03 |   1.5 bps |         1 |
| lowvol_splv         | factor | 2011-06-28 |    3,794 |  15.1 |  +9.84% | 14.16% |   0.62 | 0.670 | -35.62% | 272 sessions |  +13.78% |      -3.94% |     -0.14 |        0.03 |   0.9 bps |         0 |
| size_rsp            | factor | 2005-01-03 |    5,427 |  21.6 |  +9.88% | 19.48% |   0.49 | 0.624 | -57.80% | 485 sessions |  +10.69% |      -0.81% |     -0.06 |        0.02 |   0.4 bps |         1 |
| fundamental_prf     | factor | 2006-01-03 |    5,175 |  20.6 | +10.35% | 21.28% |   0.49 | 0.602 | -57.92% | 492 sessions |  +10.72% |      -0.38% |     -0.06 |        0.02 |   0.9 bps |         0 |
| multifactor_ishares | factor | 2013-07-15 |    3,281 |  13.0 | +12.04% | 15.13% |   0.71 | 0.718 | -33.42% | 114 sessions |  +13.75% |      -1.71% |     -0.04 |        0.17 |   2.5 bps |     1,296 |
| multifactor_six     | factor | 2013-07-15 |    3,281 |  13.0 | +11.91% | 15.29% |   0.69 | 0.701 | -34.60% | 161 sessions |  +13.81% |      -1.91% |     -0.06 |        0.13 |   1.7 bps |       885 |
| multifactor_longest | factor | 2011-12-30 |    3,665 |  14.6 | +12.13% | 14.63% |   0.74 | 0.806 | -35.12% | 165 sessions |  +14.70% |      -2.57% |     -0.08 |        0.07 |   0.8 bps |     1,926 |

## Does the library decay after publication?

| Strategy                | Published  | Post sessions | Excess before | Excess after | Beat SPY after? |
| ----------------------- | ---------- | ------------: | ------------: | -----------: | --------------- |
| permanent_portfolio     | 1981-01-01 |         5,427 |             — |       -3.71% | no              |
| all_weather_retail      | 2014-11-18 |         2,941 |        -0.13% |       -8.04% | no              |
| equal_weight_universe   | 2009-05-01 |         4,339 |        +6.20% |       -5.42% | no              |
| faber_gtaa_10mo         | 2007-04-30 |         4,845 |             — |       -7.24% | no              |
| absolute_momentum_12m   | 2013-04-30 |         3,334 |        +0.38% |       -2.76% | no              |
| antonacci_gem           | 2014-12-01 |         2,933 |        +1.35% |       -5.89% | no              |
| aaa                     | 2012-12-31 |         3,416 |        +1.09% |       -8.55% | no              |
| paa                     | 2016-04-30 |         2,577 |        -0.97% |       -8.30% | no              |
| vaa                     | 2017-07-31 |         2,263 |        -6.32% |       -9.92% | no              |
| vaa_g4                  | 2017-07-31 |         2,263 |        -4.53% |      -11.91% | no              |
| daa                     | 2018-07-31 |         2,011 |        -5.75% |       -7.00% | no              |
| gtaa_agg6               | 2013-02-28 |         3,376 |        -0.02% |       -6.71% | no              |
| risk-parity-unlevered   | 2005-09-01 |         5,260 |             — |       -6.00% | no              |
| equal-risk-contribution | 2010-07-01 |         4,045 |        +5.23% |      -10.27% | no              |
| minimum-variance        | 1991-04-01 |         5,427 |             — |       -2.34% | no              |
| maximum-diversification | 2008-10-01 |         4,485 |        +0.28% |       -2.44% | no              |
| momentum_mtum           | 1993-03-01 |         3,270 |             — |       +1.29% | yes             |
| momentum_spmo           | 1993-03-01 |         1,958 |             — |       +4.72% | yes             |
| value_vlue              | 1992-06-01 |         2,725 |             — |       -1.13% | no              |
| value_iwd               | 1992-06-01 |         5,427 |             — |       -2.00% | no              |
| value_vtv               | 1992-06-01 |         5,427 |             — |       -1.38% | no              |
| quality_qual            | 2013-04-01 |         3,247 |             — |       -0.51% | no              |
| quality_sphq            | 2013-04-01 |         3,355 |             — |       +0.03% | yes             |
| lowvol_usmv             | 1991-04-01 |         3,570 |             — |       -3.67% | no              |
| lowvol_splv             | 1991-04-01 |         3,794 |             — |       -3.94% | no              |
| size_rsp                | 1981-03-01 |         5,427 |             — |       -0.81% | no              |
| fundamental_prf         | 2005-03-01 |         5,175 |             — |       -0.38% | no              |
| multifactor_ishares     | 2013-06-01 |         3,311 |             — |       -1.97% | no              |
| multifactor_six         | 2013-06-01 |         3,311 |             — |       -2.17% | no              |
| multifactor_longest     | 2013-06-01 |         3,311 |             — |       -2.58% | no              |

|                                            |                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Dated strategies measured                  | 30                                                                                                           |
| Mean excess CAGR vs SPY, after publication | -4.03%                                                                                                       |
| 95% interval                               | -5.39% to -2.67%                                                                                             |
| Method                                     | normal-theory across strategies; narrower than the truth because the records overlap in calendar time        |
| Median excess CAGR                         | -3.21%                                                                                                       |
| 95% interval, median                       | -5.94% to -2.07%                                                                                             |
| Method                                     | percentile bootstrap, 10,000 draws, seed 20260803; carries the same overlap caveat                           |
| Beat SPY after publication                 | 3 of 30                                                                                                      |
| Excluded from the mean                     | 0, listed below                                                                                              |
| Published before the sample opens          | 10 of 30                                                                                                     |
| Paired rows, a before AND an after         | 12                                                                                                           |
| Pairings dropped                           | 6, listed below                                                                                              |
| Mean excess BEFORE publication             | -0.26%                                                                                                       |
| Mean excess AFTER publication              | -7.27%                                                                                                       |
| Change                                     | -7.00%                                                                                                       |
| Decay as a fraction of the prior excess    | undefined — there was no positive excess to decay from, and the ratio inverts against a negative denominator |

**No dated strategy was left out of the post-publication mean.** All 30 carry a window long enough to annualise and a book that was actually invested across it.

**Have an after but no usable before, so they carry no pairing.** This is why the paired count is smaller than the headline count, and every one of them is a window in which the book was not yet running rather than a window in which it ran badly.

- `faber_gtaa_10mo` — pre window held a median 46% invested, so its return describes the cash rather than the rule
- `risk-parity-unlevered` — pre window is 167 sessions, under the 252 needed to annualise
- `quality_sphq` — pre window held a median 0% invested, so its return describes the cash rather than the rule
- `multifactor_ishares` — pre window held a median 0% invested, so its return describes the cash rather than the rule
- `multifactor_six` — pre window held a median 0% invested, so its return describes the cash rather than the rule
- `multifactor_longest` — pre window held a median 0% invested, so its return describes the cash rather than the rule

**The interval is narrower than the truth and is offered as a lower bound on the uncertainty.** It is computed across strategies as though the records were independent draws. They are not: most run over the same calendar decade, most are long equity beta with a rule on top, and one bad year for that beta moves most of the rows the same way. The effective sample is well below 30 and nothing here estimates how far below.

The sign count is the robust statement and the one to quote: 3 of 30 dated strategies beat buy-and-hold SPY over their own post-publication windows, net of costs, at this account's size.

**10 of 30 rows were already in print when this tape starts**, so for those the post-publication window IS the full sample and the out-of-sample guarantee is only as strong as the fact that nobody here chose 2005. That is a weaker claim than the one the other rows support, and it is weaker in the flattering direction for the priors being tested: the oldest ideas have had the longest to be arbitraged, and they are exactly the rows whose 'before' cannot be seen.

### Against the priors

**McLean and Pontiff (2016), 58% decay.** On the 12 strategies with a record on both sides of its own publication date, the mean excess over SPY went from -0.26% a year before to -7.27% a year after, a change of -7.00%. **No decay ratio is quoted, and the reason is arithmetic rather than editorial:** 1 - after/before against a denominator at or below zero inverts, so a rule that fell further behind SPY would be reported as having improved. What the two levels say instead is that this library roughly MATCHED the index before publication and trailed it by 7.27% a year after. A percentage decay needs an edge to take a percentage of, and there was not one; the 7.00% fall in the level is the finding, and it is a larger absolute deterioration than McLean and Pontiff's average anomaly suffered.

**Huang, Song and Xiang (2021), +2.77% in backtest to -0.44% live.** Post-publication this library averages -4.03% a year against SPY, median -3.21%, with 3 of 30 rows positive. We reproduce the pattern. The average published strategy in this library does not beat holding the index once the index is charged the same frictions.

## The headline at each cost multiple

The impact coefficient is a prior lifted from the literature rather than a measurement of our own fills. A strategy that only works at 1x is not a strategy, it is a bet that `costs.py` is exactly right, and nothing in `costs.py` is exactly right.

### 1x cost

| Strategy                | CAGR (full) | SR (full) | vs SPY (full) | CAGR (post) | SR (post) | vs SPY (post) |
| ----------------------- | ----------: | --------: | ------------: | ----------: | --------: | ------------: |
| spy_buy_and_hold        |     +10.69% |      0.55 |        +0.00% |           — |         — |             — |
| sixty_forty_monthly     |      +7.75% |      0.62 |        -2.95% |           — |         — |             — |
| sixty_forty_daily       |      +7.82% |      0.61 |        -2.87% |           — |         — |             — |
| permanent_portfolio     |      +6.99% |      0.73 |        -3.71% |      +6.99% |      0.73 |        -3.71% |
| all_weather_retail      |      +6.31% |      0.62 |        -4.39% |      +5.39% |      0.44 |        -8.04% |
| equal_weight_universe   |      +7.85% |      0.49 |        -2.85% |      +9.48% |      0.68 |        -5.42% |
| faber_gtaa_10mo         |      +3.75% |      0.35 |        -6.94% |      +3.30% |      0.32 |        -7.24% |
| absolute_momentum_12m   |      +9.19% |      0.57 |        -1.50% |     +11.32% |      0.67 |        -2.76% |
| antonacci_gem           |      +8.16% |      0.50 |        -2.53% |      +7.45% |      0.41 |        -5.89% |
| aaa                     |      +5.83% |      0.54 |        -4.86% |      +6.23% |      0.61 |        -8.55% |
| paa                     |      +6.31% |      0.57 |        -4.38% |      +6.72% |      0.55 |        -8.30% |
| vaa                     |      +2.91% |      0.21 |        -7.78% |      +4.76% |      0.37 |        -9.92% |
| vaa_g4                  |      +3.13% |      0.17 |        -7.56% |      +2.77% |      0.06 |       -11.91% |
| daa                     |      +4.49% |      0.39 |        -6.20% |      +7.63% |      0.66 |        -7.00% |
| gtaa_agg6               |      +6.59% |      0.47 |        -4.10% |      +7.60% |      0.59 |        -6.71% |
| risk-parity-unlevered   |      +4.68% |      0.48 |        -6.02% |      +4.83% |      0.50 |        -6.00% |
| equal-risk-contribution |      +4.57% |      0.47 |        -6.12% |      +4.51% |      0.50 |       -10.27% |
| minimum-variance        |      +8.35% |      0.58 |        -2.34% |      +8.35% |      0.58 |        -2.34% |
| maximum-diversification |      +8.76% |      0.51 |        -1.93% |     +10.33% |      0.60 |        -2.44% |
| momentum_mtum           |     +15.01% |      0.71 |        +1.29% |     +15.01% |      0.71 |        +1.29% |
| momentum_spmo           |     +19.67% |      0.81 |        +4.72% |     +19.67% |      0.81 |        +4.72% |
| value_vlue              |     +13.26% |      0.63 |        -1.13% |     +13.26% |      0.63 |        -1.13% |
| value_iwd               |      +8.69% |      0.45 |        -2.00% |      +8.69% |      0.45 |        -2.00% |
| value_vtv               |      +9.31% |      0.48 |        -1.38% |      +9.31% |      0.48 |        -1.38% |
| quality_qual            |     +13.24% |      0.72 |        -0.51% |     +13.24% |      0.72 |        -0.51% |
| quality_sphq            |      +9.98% |      0.65 |        -0.75% |     +14.12% |      0.78 |        +0.03% |
| lowvol_usmv             |     +10.96% |      0.73 |        -3.67% |     +10.96% |      0.73 |        -3.67% |
| lowvol_splv             |      +9.84% |      0.62 |        -3.94% |      +9.84% |      0.62 |        -3.94% |
| size_rsp                |      +9.88% |      0.49 |        -0.81% |      +9.88% |      0.49 |        -0.81% |
| fundamental_prf         |     +10.35% |      0.49 |        -0.38% |     +10.35% |      0.49 |        -0.38% |
| multifactor_ishares     |     +11.00% |      0.68 |        -3.63% |     +11.92% |      0.70 |        -1.97% |
| multifactor_six         |      +7.04% |      0.48 |        -3.65% |     +11.79% |      0.69 |        -2.17% |
| multifactor_longest     |      +8.05% |      0.56 |        -2.64% |     +11.38% |      0.67 |        -2.58% |
| griffin_sleeves         |      +5.35% |      0.61 |        -5.34% |           — |         — |             — |

### 2x cost

| Strategy                | CAGR (full) | SR (full) | vs SPY (full) | CAGR (post) | SR (post) | vs SPY (post) |
| ----------------------- | ----------: | --------: | ------------: | ----------: | --------: | ------------: |
| spy_buy_and_hold        |     +10.69% |      0.55 |        +0.00% |           — |         — |             — |
| sixty_forty_monthly     |      +7.74% |      0.62 |        -2.95% |           — |         — |             — |
| sixty_forty_daily       |      +7.80% |      0.61 |        -2.89% |           — |         — |             — |
| permanent_portfolio     |      +6.98% |      0.73 |        -3.70% |      +6.98% |      0.73 |        -3.70% |
| all_weather_retail      |      +6.30% |      0.62 |        -4.38% |      +5.39% |      0.44 |        -8.04% |
| equal_weight_universe   |      +7.84% |      0.49 |        -2.85% |      +9.49% |      0.68 |        -5.41% |
| faber_gtaa_10mo         |      +3.65% |      0.33 |        -7.03% |      +3.20% |      0.30 |        -7.34% |
| absolute_momentum_12m   |      +9.20% |      0.57 |        -1.49% |     +11.35% |      0.67 |        -2.72% |
| antonacci_gem           |      +7.51% |      0.47 |        -3.18% |      +6.26% |      0.35 |        -7.08% |
| aaa                     |      +5.47% |      0.49 |        -5.21% |      +5.90% |      0.57 |        -8.89% |
| paa                     |      +6.15% |      0.55 |        -4.53% |      +6.59% |      0.54 |        -8.43% |
| vaa                     |      +2.70% |      0.17 |        -7.99% |      +4.60% |      0.34 |       -10.09% |
| vaa_g4                  |      +2.90% |      0.15 |        -7.79% |      +2.61% |      0.03 |       -12.07% |
| daa                     |      +4.23% |      0.36 |        -6.45% |      +7.37% |      0.63 |        -7.26% |
| gtaa_agg6               |      +6.46% |      0.46 |        -4.23% |      +7.45% |      0.57 |        -6.86% |
| risk-parity-unlevered   |      +4.67% |      0.48 |        -6.02% |      +4.82% |      0.50 |        -6.00% |
| equal-risk-contribution |      +4.54% |      0.46 |        -6.15% |      +4.51% |      0.50 |       -10.27% |
| minimum-variance        |      +8.29% |      0.57 |        -2.40% |      +8.29% |      0.57 |        -2.40% |
| maximum-diversification |      +8.67% |      0.50 |        -2.01% |     +10.22% |      0.60 |        -2.55% |
| momentum_mtum           |     +14.95% |      0.71 |        +1.24% |     +14.95% |      0.71 |        +1.24% |
| momentum_spmo           |     +19.57% |      0.81 |        +4.65% |     +19.57% |      0.81 |        +4.65% |
| value_vlue              |     +13.20% |      0.63 |        -1.19% |     +13.20% |      0.63 |        -1.19% |
| value_iwd               |      +8.69% |      0.45 |        -2.00% |      +8.69% |      0.45 |        -2.00% |
| value_vtv               |      +9.31% |      0.48 |        -1.38% |      +9.31% |      0.48 |        -1.38% |
| quality_qual            |     +13.20% |      0.72 |        -0.54% |     +13.20% |      0.72 |        -0.54% |
| quality_sphq            |      +9.96% |      0.65 |        -0.77% |     +14.12% |      0.78 |        +0.03% |
| lowvol_usmv             |     +10.92% |      0.73 |        -3.70% |     +10.92% |      0.73 |        -3.70% |
| lowvol_splv             |      +9.82% |      0.62 |        -3.95% |      +9.82% |      0.62 |        -3.95% |
| size_rsp                |      +9.87% |      0.49 |        -0.82% |      +9.87% |      0.49 |        -0.82% |
| fundamental_prf         |     +10.32% |      0.49 |        -0.39% |     +10.32% |      0.49 |        -0.39% |
| multifactor_ishares     |     +11.01% |      0.67 |        -3.61% |     +11.93% |      0.70 |        -1.96% |
| multifactor_six         |      +7.04% |      0.48 |        -3.64% |     +11.79% |      0.69 |        -2.16% |
| multifactor_longest     |      +8.05% |      0.56 |        -2.63% |     +11.41% |      0.67 |        -2.55% |
| griffin_sleeves         |      +5.21% |      0.58 |        -5.48% |           — |         — |             — |

### 3x cost

| Strategy                | CAGR (full) | SR (full) | vs SPY (full) | CAGR (post) | SR (post) | vs SPY (post) |
| ----------------------- | ----------: | --------: | ------------: | ----------: | --------: | ------------: |
| spy_buy_and_hold        |     +10.68% |      0.55 |        +0.00% |           — |         — |             — |
| sixty_forty_monthly     |      +7.72% |      0.61 |        -2.96% |           — |         — |             — |
| sixty_forty_daily       |      +7.79% |      0.61 |        -2.89% |           — |         — |             — |
| permanent_portfolio     |      +6.93% |      0.73 |        -3.75% |      +6.93% |      0.73 |        -3.75% |
| all_weather_retail      |      +6.29% |      0.62 |        -4.39% |      +5.39% |      0.44 |        -8.04% |
| equal_weight_universe   |      +7.76% |      0.48 |        -2.92% |      +9.55% |      0.68 |        -5.35% |
| faber_gtaa_10mo         |      +3.66% |      0.33 |        -7.02% |      +3.22% |      0.31 |        -7.31% |
| absolute_momentum_12m   |      +9.16% |      0.57 |        -1.52% |     +11.31% |      0.67 |        -2.77% |
| antonacci_gem           |      +7.74% |      0.48 |        -2.94% |      +6.70% |      0.37 |        -6.63% |
| aaa                     |      +5.17% |      0.46 |        -5.52% |      +5.58% |      0.53 |        -9.21% |
| paa                     |      +5.99% |      0.53 |        -4.69% |      +6.47% |      0.52 |        -8.54% |
| vaa                     |      +2.44% |      0.13 |        -8.24% |      +4.47% |      0.32 |       -10.21% |
| vaa_g4                  |      +2.67% |      0.13 |        -8.01% |      +2.47% |      0.01 |       -12.21% |
| daa                     |      +4.11% |      0.34 |        -6.58% |      +7.26% |      0.62 |        -7.37% |
| gtaa_agg6               |      +6.22% |      0.44 |        -4.46% |      +7.18% |      0.55 |        -7.13% |
| risk-parity-unlevered   |      +4.64% |      0.47 |        -6.04% |      +4.79% |      0.49 |        -6.04% |
| equal-risk-contribution |      +4.54% |      0.46 |        -6.14% |      +4.49% |      0.50 |       -10.28% |
| minimum-variance        |      +8.20% |      0.57 |        -2.49% |      +8.20% |      0.57 |        -2.49% |
| maximum-diversification |      +8.73% |      0.50 |        -1.95% |     +10.33% |      0.60 |        -2.45% |
| momentum_mtum           |     +14.90% |      0.71 |        +1.20% |     +14.90% |      0.71 |        +1.20% |
| momentum_spmo           |     +19.47% |      0.80 |        +4.56% |     +19.47% |      0.80 |        +4.56% |
| value_vlue              |     +13.15% |      0.63 |        -1.23% |     +13.15% |      0.63 |        -1.23% |
| value_iwd               |      +8.68% |      0.45 |        -2.00% |      +8.68% |      0.45 |        -2.00% |
| value_vtv               |      +9.29% |      0.48 |        -1.39% |      +9.29% |      0.48 |        -1.39% |
| quality_qual            |     +13.15% |      0.71 |        -0.58% |     +13.15% |      0.71 |        -0.58% |
| quality_sphq            |      +9.93% |      0.65 |        -0.77% |     +14.12% |      0.78 |        +0.05% |
| lowvol_usmv             |     +10.88% |      0.72 |        -3.74% |     +10.88% |      0.72 |        -3.74% |
| lowvol_splv             |      +9.79% |      0.62 |        -3.97% |      +9.79% |      0.62 |        -3.97% |
| size_rsp                |      +9.86% |      0.49 |        -0.82% |      +9.86% |      0.49 |        -0.82% |
| fundamental_prf         |     +10.30% |      0.49 |        -0.42% |     +10.30% |      0.49 |        -0.42% |
| multifactor_ishares     |     +10.98% |      0.67 |        -3.64% |     +11.89% |      0.70 |        -2.00% |
| multifactor_six         |      +7.01% |      0.48 |        -3.68% |     +11.73% |      0.69 |        -2.22% |
| multifactor_longest     |      +8.03% |      0.56 |        -2.65% |     +11.39% |      0.67 |        -2.57% |
| griffin_sleeves         |      +5.00% |      0.55 |        -5.68% |           — |         — |             — |

At 3x cost 34 of 34 books still compound over the full sample.

## Every window over Sharpe 1.2

The brief's instruction is to treat a Sharpe above this as evidence of a bug and hunt before reporting. The hunt is the sceptic table below, and it fails the whole report on a FULL-SAMPLE Sharpe over the line, because a twenty-year figure that high on a long-only unlevered book is not a result. Shorter windows are held to the same number and reported rather than refused: a two-year Sharpe of 1.3 is a bull market, and a rule that refused it would refuse this report every time a factor ETF listed into a rally. Read the `Years` column before the `Sharpe` column.

_No window in the study clears 1.2. The highest full-sample figure is in the sceptic table below._

## Skipped, and what was missing

A strategy whose declared universe is not fully covered is skipped and named. Never substituted: swapping a vehicle for one that happens to have the history the story needs is the first move this study exists to observe.

_Nothing was skipped: every ticker the library declares came back with bars, and every strategy carries a measurable window._

## What was attacked before any of this was believed

A clean number nobody attacked is not a result. Each row is a way the tables above could be wrong while looking exactly like this.

| Check                                                     |      | What was measured                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The known rows reproduce to the printed digit             | PASS | buy and hold SPY 10.69% / 0.55 against a published 10.69% / 0.55; 60/40 SPY/IEF, rebalanced daily 7.82% / 0.61 against a published 7.82% / 0.61; Griffin nine-sleeve book (Layers 1+2) 5.35% / 0.61 against a published 5.35% / 0.61. Same window as `reports/stage3_sleeves.md`                                      |
| Long only and unlevered throughout                        | PASS | across 129 runs and every session of each: most negative realised weight +0.00e+00, largest gross exposure 0.994481 of NAV (spy_buy_and_hold@1x)                                                                                                                                                                      |
| Fills land at the NEXT open                               | PASS | 144,957 fills across 129 runs, every one strictly after its decision session and priced at that session's own unadjusted open to the last bit                                                                                                                                                                         |
| Positions are marked in total-return space                | PASS | every closing position marked at `close_adj`; across the panels 4,445,487 ticker-days carry an adjusted close that differs from the as-traded one, on 143 distinct tickers of 978 panel-columns. Measured panel-wide because back-adjustment anchors at the final bar, where the two agree everywhere by construction |
| Trading costs are charged inside the loop                 | PASS | $92,045.07 at 1x across every book ($74,869.81 spread, $17,175.26 impact), $263,885.14 at 3x — a ratio of 2.87 against a nominal 3, which will not be exact because the multiple changes the fills and therefore the book                                                                                             |
| Every measured book deployed                              | PASS | median invested weight over the full window; the lowest of any row is 61.0% against a 50% floor                                                                                                                                                                                                                       |
| No full-sample Sharpe at 1x exceeds 1.2                   | PASS | the highest is 0.811 (momentum_spmo), over 34 books                                                                                                                                                                                                                                                                   |
| Every registered strategy is measured or named as skipped | PASS | 33 registered plus this fund's own book; 34 measured, 0 skipped and named                                                                                                                                                                                                                                             |
| Every dated strategy is counted or excluded by name       | PASS | 30 of 30 dated strategies carry a usable post-publication window; 0 excluded and named                                                                                                                                                                                                                                |

## What this does and does not establish

It reports what thirty-three published rules would have produced in this account, on this sample, with frictions charged rather than assumed away, with each rule measured from a date its author fixed before we existed, and with the number of looks written down. That is a stronger claim than a backtest and a much weaker one than an edge.

Four things it does not establish. The post-publication windows differ in length — a rule published in 2018 has eight years of record where one published in 2007 has nineteen — and the mean above weights them equally with nothing correcting for it. The sample holds one credit crisis, one pandemic crash and one inflation shock, each a single draw, and for most of it falling yields paid the bond legs to be a hedge, a relationship that ended in 2022 and has not resumed. Every vehicle here still trades, so the ETF universe is survivorship-biased by construction and the direction of that bias is flattering. And the account is $131,000: the participation cap and the $100 minimum ticket bind here in ways they would not at a fund, which is why several rows could not be measured from their listing dates at all.

_Generated 2026-08-03 06:15 UTC by `run_ledger.py`._
