# Data audit — Synthetic panel, clean [SMOKE TEST ONLY]

> **VERDICT: PASS**
>
> **Strategy code may be run against this dataset.**
>
> Every blocking check ran and passed. That is a statement about this dataset's internal consistency and about its retention of the names that died — read the closing section for what it is not a statement about.
>
> 19 checks: 1 WARN, 18 PASS. Generated 2026-08-02 15:47:09+00:00.

## Provenance

| Field            | Value                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| generated        | 2026-08-02 15:47:09+00:00                                                       |
| source           | Synthetic panel, clean [SMOKE TEST ONLY]                                        |
| range            | 2005-01-01 to 2025-12-31                                                        |
| entities         | 494                                                                             |
| price rows       | 1,477,005                                                                       |
| action rows      | 13,771                                                                          |
| fundamental rows | 23,218                                                                          |
| panel            | synthetic, generated in-process                                                 |
| seed             | 20050103                                                                        |
| injected bias    | none (clean panel)                                                              |
| warning          | SMOKE TEST ONLY. Nothing in this report is a statement about any real security. |
| command          | data_audit.py --source synthetic --start 2005-01-01 --end 2025-12-31 --quiet    |
| report           | /Users/thomasseirer/repos/gcig-app/quant/reports/data_audit_report.md           |

## Checks

| Check                                                             | Key                                   | Verdict | Scope    | Headline                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Lookahead injected by screening on adjusted prices                | `pit_adjusted_price_screen_leak`      | WARN    | advisory | A $5.00 floor read off back-adjusted closes admits 0.835% of its own universe on names that were ac… |
| Delisted entities in the master                                   | `survivorship.delisted_present`       | PASS    | blocking | 248 of 494 entities (50.2%) are flagged delisted. Roughly half of everything that has ever listed i… |
| Entity count by year                                              | `survivorship.universe_count_by_year` | PASS    | blocking | Distinct entities with a price row went 290 in 2005 to 246 in 2025 (-15%), rising in 30% of year-on… |
| Annual attrition rate                                             | `survivorship.annual_attrition`       | PASS    | blocking | Median annual attrition is 3.60% across 2006-2024. US equities retire at roughly 2-8% a year with t… |
| Delisted names carry price history                                | `survivorship.dead_names_priced`      | PASS    | blocking | 248 of 248 entities that died inside the window (100.0%) carry at least one price bar. A master tha… |
| Named decedents stop when they died                               | `survivorship.decedent_trace`         | PASS    | blocking | 18/18 named decedents stop trading when they actually stopped; 0 absent (0%), 0 still trading, 0 on… |
| Fundamentals carry a publication date, not just a period end      | `pit_filing_dates_present`            | PASS    | blocking | All 23,218 fundamental rows carry a publication date distinct from the period they describe.         |
| Filing lag is possible and plausibly sized                        | `pit_filing_lag_distribution`         | PASS    | blocking | Median lag 48 days (p5 34, p95 94, max 100); no row predates the period it describes.                |
| Fundamentals are as-reported, not restated                        | `pit_as_reported_dimension`           | PASS    | blocking | All 23,218 rows carry an AR* dimension: what the filer said at the time, not what they said later.   |
| Recycled symbols are resolvable to distinct entities              | `pit_ticker_recycling`                | PASS    | blocking | 6 recycled symbols out of 488, each resolving to distinct permatickers with non-overlapping windows. |
| Prices stay inside the entity's listing window                    | `pit_prices_within_listing_window`    | PASS    | blocking | All 1,477,005 price rows sit inside their entity's listing window (± 3 calendar days for boundary c… |
| Adjusted and as-traded closes are genuinely different series      | `pit_unadjusted_prices_available`     | PASS    | blocking | The two closes differ on 904,160 of 1,477,005 rows (61.216%) and across 332 of 494 entities; median… |
| Names that stopped trading have a corporate action to explain it  | `pit_delisting_action_coverage`       | PASS    | advisory | A terminal action is on file for all 248 names that stopped trading inside the window.               |
| Prices are positive and each bar is internally consistent         | `quality.nonpositive_prices`          | PASS    | blocking | All 1,477,005 bars are positive and self-consistent.                                                 |
| Price dates are real NYSE sessions, and sessions are populated    | `quality.calendar_alignment`          | PASS    | blocking | All 5,283 price dates are NYSE sessions; 100.00% of the 5,283 sessions in range are populated.       |
| One bar per entity-day (and symbol collisions are not that)       | `quality.duplicate_bars`              | PASS    | blocking | No duplicate entity-days; 0 row(s) share a (ticker, date) with a different company, which is expect… |
| Large single-session moves have a corporate action behind them    | `quality.unexplained_jumps`           | PASS    | advisory | 0 of 79 moves beyond ±50% have no action within ±3 sessions: 0.00 per million comparable bars (1,47… |
| Bars represent trades, not carried-forward quotes                 | `quality.zero_volume`                 | PASS    | advisory | 0 of 1,477,005 bars (0.000%) print zero volume; 0 carry no volume at all.                            |
| Adjusted and unadjusted returns agree away from corporate actions | `quality.adjustment_consistency`      | PASS    | blocking | 0 of 1,421,965 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing…  |

## WARN · Lookahead injected by screening on adjusted prices

`pit_adjusted_price_screen_leak` · advisory

A $5.00 floor read off back-adjusted closes admits 0.835% of its own universe on names that were actually trading below it (worst sampled date 2.518% on 2005-01-03); it also discards 35 name-days that were genuinely tradable.

**Findings**

- **WARN** — This is the measurement, not a defect: it is how much of the future a naive adjusted-price filter would import. Reverse splits are the mechanism, and they cluster in exactly the names a price floor is meant to exclude.
  _54 leaked name-days across 12 distinct names on 24 sampled dates (0.835% of the adjusted universe)_
- **PASS** — Sampling scope.
  _restricted to the 494 entities whose category is in config.SINGLE_NAME_CATEGORIES_

**screen disagreement by date**

| date       | priced_names | adj_universe | adj_pass_unadj_fail | unadj_pass_adj_fail | leak_pct_of_adj_universe | disagree_pct_of_priced |
| ---------- | -----------: | -----------: | ------------------: | ------------------: | -----------------------: | ---------------------: |
| 2005-01-03 |          278 |          278 |                   7 |                   0 |                    2.518 |                  2.518 |
| 2005-11-30 |          282 |          279 |                   6 |                   1 |                    2.151 |                  2.482 |
| 2006-10-27 |          283 |          278 |                   5 |                   2 |                    1.799 |                  2.473 |
| 2007-09-28 |          285 |          277 |                   1 |                   1 |                    0.361 |                  0.702 |
| 2008-08-27 |          280 |          274 |                   2 |                   0 |                    0.730 |                  0.714 |
| 2009-07-27 |          290 |          283 |                   1 |                   2 |                    0.353 |                  1.034 |
| 2010-06-24 |          288 |          283 |                   3 |                   3 |                    1.060 |                  2.083 |
| 2011-05-23 |          291 |          286 |                   3 |                   3 |                    1.049 |                  2.062 |
| 2012-04-19 |          299 |          291 |                   2 |                   3 |                    0.687 |                  1.672 |
| 2013-03-21 |          303 |          294 |                   3 |                   2 |                    1.020 |                  1.650 |
| 2014-02-19 |          299 |          290 |                   3 |                   2 |                    1.034 |                  1.672 |
| 2015-01-15 |          295 |          289 |                   3 |                   1 |                    1.038 |                  1.356 |
| 2015-12-14 |          290 |          283 |                   3 |                   0 |                    1.060 |                  1.034 |
| 2016-11-09 |          286 |          273 |                   3 |                   4 |                    1.099 |                  2.448 |
| 2017-10-10 |          283 |          269 |                   2 |                   4 |                    0.743 |                  2.120 |
| 2018-09-10 |          281 |          268 |                   2 |                   1 |                    0.746 |                  1.068 |
| 2019-08-08 |          277 |          263 |                   1 |                   1 |                    0.380 |                  0.722 |
| 2020-07-08 |          272 |          261 |                   0 |                   0 |                    0.000 |                  0.000 |
| 2021-06-07 |          262 |          251 |                   1 |                   0 |                    0.398 |                  0.382 |
| 2022-05-03 |          262 |          251 |                   1 |                   1 |                    0.398 |                  0.763 |
| 2023-04-03 |          257 |          247 |                   1 |                   2 |                    0.405 |                  1.167 |
| 2024-03-04 |          249 |          239 |                   1 |                   1 |                    0.418 |                  0.803 |
| 2025-01-31 |          246 |          231 |                   0 |                   1 |                    0.000 |                  0.407 |
| 2025-12-31 |          246 |          232 |                   0 |                   0 |                    0.000 |                  0.000 |

**screen disagreement summary**

| metric                                             | value               |
| -------------------------------------------------- | ------------------- |
| price floor applied                                | $5.00               |
| dates sampled                                      | 24                  |
| name-days in the adjusted universe                 | 6470                |
| name-days admitted on adj, untradable on as-traded | 54                  |
| name-days excluded on adj, tradable on as-traded   | 35                  |
| leak as % of the adjusted universe                 | 0.835               |
| worst single date (%)                              | 2.518 on 2005-01-03 |
| distinct names ever leaked                         | 12                  |

## PASS · Delisted entities in the master

`survivorship.delisted_present` · blocking

248 of 494 entities (50.2%) are flagged delisted. Roughly half of everything that has ever listed in the US since 2005 is gone — merged, taken private, bankrupt or delisted for non-compliance — so a real panel runs well north of a third, and anything under 5% is a master built from today's listings.

**Findings**

- **PASS** — Share of the security master flagged is_delisted.
  _248/494 = 50.20% (fail <5%, warn <15%)_
- **PASS** — Where the dead fall relative to the audited window.
  _0 last traded before 2005, 248 inside the window, 0 after 2025_

**Delistings by year (last_price_date of delisted names)**

| year | delistings | pct_of_delisted |
| ---: | ---------: | --------------: |
| 2005 |          9 |            3.63 |
| 2006 |          9 |            3.63 |
| 2007 |          9 |            3.63 |
| 2008 |         32 |           12.90 |
| 2009 |         24 |            9.68 |
| 2010 |         10 |            4.03 |
| 2011 |         10 |            4.03 |
| 2012 |         10 |            4.03 |
| 2013 |         11 |            4.44 |
| 2014 |         10 |            4.03 |
| 2015 |         10 |            4.03 |
| 2016 |         10 |            4.03 |
| 2017 |         11 |            4.44 |
| 2018 |         10 |            4.03 |
| 2019 |         10 |            4.03 |
| 2020 |         20 |            8.06 |
| 2021 |         10 |            4.03 |
| 2022 |         10 |            4.03 |
| 2023 |         14 |            5.65 |
| 2024 |          9 |            3.63 |

## PASS · Entity count by year

`survivorship.universe_count_by_year` · blocking

Distinct entities with a price row went 290 in 2005 to 246 in 2025 (-15%), rising in 30% of year-on-year steps, peaking in 2008. This is the single most diagnostic curve in the audit: a panel assembled from the companies that exist today can only grow toward the present, because the further back you look the more of its members had not yet listed and none of the ones that died were ever included. An honest US panel is broadly flat to gently declining off a 2007-2014 peak, as the delisting wave and the shrinking count of public companies work against new listings.

**Findings**

- **PASS** — Shape of the entity count across years.
  _rising in 6/20 steps = 30% (fail >85% combined with first-to-last growth >40%); 2005=290, 2025=246, growth -15.2%_

**Entities with at least one price row, by year**

| year | entities | change | pct_change |
| ---: | -------: | -----: | ---------: |
| 2005 |      290 |      — |          — |
| 2006 |      293 |      3 |        1.0 |
| 2007 |      296 |      3 |        1.0 |
| 2008 |      317 |     21 |        7.1 |
| 2009 |      314 |     -3 |       -0.9 |
| 2010 |      305 |     -9 |       -2.9 |
| 2011 |      309 |      4 |        1.3 |
| 2012 |      313 |      4 |        1.3 |
| 2013 |      309 |     -4 |       -1.3 |
| 2014 |      305 |     -4 |       -1.3 |
| 2015 |      301 |     -4 |       -1.3 |
| 2016 |      297 |     -4 |       -1.3 |
| 2017 |      293 |     -4 |       -1.3 |
| 2018 |      288 |     -5 |       -1.7 |
| 2019 |      283 |     -5 |       -1.7 |
| 2020 |      289 |      6 |        2.1 |
| 2021 |      274 |    -15 |       -5.2 |
| 2022 |      269 |     -5 |       -1.8 |
| 2023 |      264 |     -5 |       -1.9 |
| 2024 |      255 |     -9 |       -3.4 |
| 2025 |      246 |     -9 |       -3.5 |

## PASS · Annual attrition rate

`survivorship.annual_attrition` · blocking

Median annual attrition is 3.60% across 2006-2024. US equities retire at roughly 2-8% a year with the wave breaking in 2008-09 and again in 2020; a median under 0.5% means nothing in this panel ever dies, and one over 15% means something other than corporate mortality is ending these series.

**Findings**

- **PASS** — Median share of each year's incumbents that never trade again.
  _median 3.60% over 19 years (fail <0.5%, warn >15%); min 3.17%, max 11.15%_

**Attrition by year**

| year | alive_at_start | ceased_by_year_end | attrition_pct |
| ---: | -------------: | -----------------: | ------------: |
| 2006 |            281 |                  9 |          3.20 |
| 2007 |            284 |                  9 |          3.17 |
| 2008 |            287 |                 32 |         11.15 |
| 2009 |            285 |                 24 |          8.42 |
| 2010 |            290 |                 10 |          3.45 |
| 2011 |            295 |                 10 |          3.39 |
| 2012 |            299 |                 10 |          3.34 |
| 2013 |            303 |                 11 |          3.63 |
| 2014 |            298 |                 10 |          3.36 |
| 2015 |            295 |                 10 |          3.39 |
| 2016 |            291 |                 10 |          3.44 |
| 2017 |            287 |                 11 |          3.83 |
| 2018 |            282 |                 10 |          3.55 |
| 2019 |            278 |                 10 |          3.60 |
| 2020 |            273 |                 20 |          7.33 |
| 2021 |            269 |                 10 |          3.72 |
| 2022 |            264 |                 10 |          3.79 |
| 2023 |            259 |                 14 |          5.41 |
| 2024 |            250 |                  9 |          3.60 |

## PASS · Delisted names carry price history

`survivorship.dead_names_priced` · blocking

248 of 248 entities that died inside the window (100.0%) carry at least one price bar. A master that lists the dead and stores no prices for them is survivorship bias with extra steps: the names are there to be counted and absent the moment you try to trade them.

**Findings**

- **PASS** — Share of in-window delistings that appear in the price panel.
  _248/248 = 100.00% (fail <80%, warn <95%)_

## PASS · Named decedents stop when they died

`survivorship.decedent_trace` · blocking

18/18 named decedents stop trading when they actually stopped; 0 absent (0%), 0 still trading, 0 on the wrong date. 0 fixture(s) fell outside the audited window and were skipped rather than counted as passes. These are companies whose last day is a matter of public record, so each failure names its own cause.

**Findings**

- **PASS** — Tickers the master holds more than once — resolved on the entity whose last price date sits nearest the known death.
  _WM (2 entities); CC (2 entities); WB (2 entities); GM (2 entities); DELL (2 entities); DOW (2 entities)_

**Decedent trace**

| ticker | name                                | expected_last_trade | master_matches | permaticker | observed_last_price | delta_days | tolerance_days | verdict |
| ------ | ----------------------------------- | ------------------- | -------------: | ----------: | ------------------- | ---------: | -------------: | ------- |
| BSC    | The Bear Stearns Companies Inc.     | 2008-05-30          |              1 |      100001 | 2008-05-30          |          0 |              3 | ok      |
| CFC    | Countrywide Financial Corporation   | 2008-06-30          |              1 |      100002 | 2008-06-30          |          0 |              3 | ok      |
| LEH    | Lehman Brothers Holdings Inc.       | 2008-09-17          |              1 |      100003 | 2008-09-17          |          0 |              4 | ok      |
| WM     | Washington Mutual, Inc.             | 2008-09-25          |              2 |      100004 | 2008-09-25          |          0 |              4 | ok      |
| CC     | Circuit City Stores, Inc.           | 2008-11-10          |              2 |      100006 | 2008-11-10          |          0 |              5 | ok      |
| WB     | Wachovia Corporation                | 2008-12-31          |              2 |      100008 | 2008-12-31          |          0 |              3 | ok      |
| GM     | General Motors Corporation (old GM) | 2009-06-01          |              2 |      100010 | 2009-06-01          |          0 |              3 | ok      |
| DELL   | Dell Inc.                           | 2013-10-29          |              2 |      100012 | 2013-10-29          |          0 |              3 | ok      |
| DOW    | The Dow Chemical Company (old Dow)  | 2017-08-31          |              2 |      100014 | 2017-08-31          |          0 |              3 | ok      |
| SHLD   | Sears Holdings Corporation          | 2018-10-23          |              1 |      100016 | 2018-10-23          |          0 |              3 | ok      |
| AABA   | Altaba Inc. (formerly Yahoo! Inc.)  | 2019-10-02          |              1 |      100017 | 2019-10-02          |          0 |              4 | ok      |
| CHL    | China Mobile Limited (ADR)          | 2021-01-08          |              1 |      100018 | 2021-01-08          |          0 |              3 | ok      |
| TWTR   | Twitter, Inc.                       | 2022-10-27          |              1 |      100019 | 2022-10-27          |          0 |              3 | ok      |
| SIVB   | SVB Financial Group                 | 2023-03-09          |              1 |      100020 | 2023-03-09          |          0 |              3 | ok      |
| SBNY   | Signature Bank                      | 2023-03-10          |              1 |      100021 | 2023-03-10          |          0 |              3 | ok      |
| FRC    | First Republic Bank                 | 2023-04-28          |              1 |      100022 | 2023-04-28          |          0 |              4 | ok      |
| BBBY   | Bed Bath & Beyond Inc.              | 2023-05-02          |              1 |      100023 | 2023-05-02          |          0 |              3 | ok      |
| RAD    | Rite Aid Corporation                | 2023-10-16          |              1 |      100024 | 2023-10-16          |          0 |              3 | ok      |

## PASS · Fundamentals carry a publication date, not just a period end

`pit_filing_dates_present` · blocking

All 23,218 fundamental rows carry a publication date distinct from the period they describe.

**date_public coverage**

| metric                               |  rows | share_pct |
| ------------------------------------ | ----: | --------: |
| fundamental rows                     | 23218 |       100 |
| date_public missing                  |     0 |         0 |
| date_public == period_end            |     0 |         0 |
| date_public distinct from period_end | 23218 |       100 |

## PASS · Filing lag is possible and plausibly sized

`pit_filing_lag_distribution` · blocking

Median lag 48 days (p5 34, p95 94, max 100); no row predates the period it describes.

**filing lag percentiles (days)**

| statistic | lag_days |
| --------- | -------: |
| min       |       33 |
| p1        |       33 |
| p5        |       34 |
| p25       |       40 |
| p50       |       48 |
| p75       |       55 |
| p95       |       94 |
| p99       |       99 |
| max       |      100 |

**worst offenders**

| permaticker | ticker | dimension | period_end | date_public | lag_days |
| ----------: | ------ | --------- | ---------- | ----------- | -------: |
|      100009 | WB     | ARQ       | 2023-12-31 | 2024-04-09  |      100 |
|      100011 | GM     | ARQ       | 2020-12-31 | 2021-04-10  |      100 |
|      100018 | CHL    | ARQ       | 2008-12-31 | 2009-04-10  |      100 |
|      100022 | FRC    | ARQ       | 2017-12-31 | 2018-04-10  |      100 |
|      100023 | BBBY   | ARQ       | 2012-12-31 | 2013-04-10  |      100 |
|      100023 | BBBY   | ARQ       | 2015-12-31 | 2016-04-09  |      100 |
|      100024 | RAD    | ARQ       | 2022-12-31 | 2023-04-10  |      100 |
|      100029 | QAE    | ARQ       | 2006-12-31 | 2007-04-10  |      100 |
|      100029 | QAE    | ARQ       | 2007-12-31 | 2008-04-09  |      100 |
|      100030 | QAF    | ARQ       | 2005-12-31 | 2006-04-10  |      100 |
|      100040 | QAP    | ARQ       | 2012-12-31 | 2013-04-10  |      100 |
|      100046 | QAV    | ARQ       | 2007-12-31 | 2008-04-09  |      100 |
|      100048 | QAX    | ARQ       | 2024-12-31 | 2025-04-10  |      100 |
|      100049 | QAY    | ARQ       | 2019-12-31 | 2020-04-09  |      100 |
|      100055 | QBE    | ARQ       | 2010-12-31 | 2011-04-10  |      100 |
|      100056 | QBF    | ARQ       | 2024-12-31 | 2025-04-10  |      100 |
|      100059 | QBI    | ARQ       | 2008-12-31 | 2009-04-10  |      100 |
|      100063 | QBM    | ARQ       | 2017-12-31 | 2018-04-10  |      100 |
|      100064 | QBN    | ARQ       | 2006-12-31 | 2007-04-10  |      100 |
|      100067 | QBQ    | ARQ       | 2008-12-31 | 2009-04-10  |      100 |
|      100068 | QBR    | ARQ       | 2005-12-31 | 2006-04-10  |      100 |
|      100070 | QBT    | ARQ       | 2014-12-31 | 2015-04-10  |      100 |
|      100075 | QBY    | ARQ       | 2012-12-31 | 2013-04-10  |      100 |
|      100081 | QCE    | ARQ       | 2007-12-31 | 2008-04-09  |      100 |
|      100081 | QCE    | ARQ       | 2015-12-31 | 2016-04-09  |      100 |

## PASS · Fundamentals are as-reported, not restated

`pit_as_reported_dimension` · blocking

All 23,218 rows carry an AR* dimension: what the filer said at the time, not what they said later.

**dimensions present**

| dimension |  rows | kind        | share_pct |
| --------- | ----: | ----------- | --------: |
| ARQ       | 23218 | as-reported |       100 |

## PASS · Recycled symbols are resolvable to distinct entities

`pit_ticker_recycling` · blocking

6 recycled symbols out of 488, each resolving to distinct permatickers with non-overlapping windows.

**symbol reuse**

| metric                                       | value |
| -------------------------------------------- | ----- |
| distinct symbols in the master               | 488   |
| symbols carried by more than one entity      | 6     |
| entities sitting on a recycled symbol        | 12    |
| entities whose window overlaps a predecessor | 0     |
| permanent entity ids claimed                 | True  |

**most-recycled symbols**

| ticker | permaticker | name                                | first_price_date | last_price_date | is_delisted |
| ------ | ----------: | ----------------------------------- | ---------------- | --------------- | ----------- |
| CC     |      100006 | Circuit City Stores, Inc.           | 2005-01-03       | 2008-11-10      | true        |
| CC     |      100007 | CC Holdings (successor)             | 2009-09-04       | 2025-12-31      | false       |
| DELL   |      100012 | Dell Inc.                           | 2005-01-03       | 2013-10-29      | true        |
| DELL   |      100013 | DELL Holdings (successor)           | 2014-08-25       | 2025-12-31      | false       |
| DOW    |      100014 | The Dow Chemical Company (old Dow)  | 2005-01-03       | 2017-08-31      | true        |
| DOW    |      100015 | DOW Holdings (successor)            | 2018-06-27       | 2025-12-31      | false       |
| GM     |      100010 | General Motors Corporation (old GM) | 2005-01-03       | 2009-06-01      | true        |
| GM     |      100011 | GM Holdings (successor)             | 2010-03-29       | 2025-12-31      | false       |
| WB     |      100008 | Wachovia Corporation                | 2005-01-03       | 2008-12-31      | true        |
| WB     |      100009 | WB Holdings (successor)             | 2009-10-27       | 2025-12-31      | false       |
| WM     |      100004 | Washington Mutual, Inc.             | 2005-01-03       | 2008-09-25      | true        |
| WM     |      100005 | WM Holdings (successor)             | 2009-07-22       | 2025-12-31      | false       |

## PASS · Prices stay inside the entity's listing window

`pit_prices_within_listing_window` · blocking

All 1,477,005 price rows sit inside their entity's listing window (± 3 calendar days for boundary conventions).

**listing-window coverage**

| metric                       |   value |
| ---------------------------- | ------: |
| price rows checked           | 1477005 |
| rows before first_price_date |       0 |
| rows after last_price_date   |       0 |
| entities affected            |       0 |
| tolerance (calendar days)    |       3 |

## PASS · Adjusted and as-traded closes are genuinely different series

`pit_unadjusted_prices_available` · blocking

The two closes differ on 904,160 of 1,477,005 rows (61.216%) and across 332 of 494 entities; median gap 14.66%.

**Findings**

- **PASS** — Corporate events located.
  _dividends from prices.dividends; splits from actions; dividends from actions_

**adjusted vs as-traded divergence**

| metric                                    | value   |
| ----------------------------------------- | ------- |
| rows with both closes                     | 1477005 |
| rows where they differ                    | 904160  |
| entities priced                           | 494     |
| entities where they ever differ           | 332     |
| median gap on differing rows (%)          | 14.657  |
| p95 gap on differing rows (%)             | 77.3794 |
| max gap (%)                               | 300.0   |
| entities with a split                     | 100     |
| split entities that never diverge         | 0       |
| dividend-only entities                    | 232     |
| dividend-only entities that never diverge | 0       |

## PASS · Names that stopped trading have a corporate action to explain it

`pit_delisting_action_coverage` · advisory

A terminal action is on file for all 248 names that stopped trading inside the window.

**delisting coverage**

| metric                                         | value       |
| ---------------------------------------------- | ----------- |
| entities whose last price is inside the window | 248         |
| with a terminal action on file                 | 248         |
| coverage (%)                                   | 100.0       |
| matched by                                     | permaticker |
| terminal action rows seen                      | 248         |
| terminal actions carrying a reason             | 248         |
| tail buffer (calendar days)                    | 30          |

## PASS · Prices are positive and each bar is internally consistent

`quality.nonpositive_prices` · blocking

All 1,477,005 bars are positive and self-consistent.

**Findings**

- **PASS** — No nonpositive, inverted or out-of-band bars.

## PASS · Price dates are real NYSE sessions, and sessions are populated

`quality.calendar_alignment` · blocking

All 5,283 price dates are NYSE sessions; 100.00% of the 5,283 sessions in range are populated.

**Findings**

- **PASS** — No price rows on non-session dates.

**Session coverage**

| sessions_in_range | sessions_with_rows | sessions_with_no_rows | coverage_pct | distinct_price_dates |
| ----------------: | -----------------: | --------------------: | -----------: | -------------------: |
|              5283 |               5283 |                     0 |          100 |                 5283 |

## PASS · One bar per entity-day (and symbol collisions are not that)

`quality.duplicate_bars` · blocking

No duplicate entity-days; 0 row(s) share a (ticker, date) with a different company, which is expected.

**Findings**

- **PASS** — No symbol collisions in the audited range.

## PASS · Large single-session moves have a corporate action behind them

`quality.unexplained_jumps` · advisory

0 of 79 moves beyond ±50% have no action within ±3 sessions: 0.00 per million comparable bars (1,476,511 examined).

**Findings**

- **PASS** — Every one of the 79 move(s) beyond ±50% has a corporate action nearby.

**Jump scan**

| price_rows | comparable_consecutive_pairs | moves_over_threshold | explained_by_an_action | unexplained | per_million_bars | action_rows_searched |
| ---------: | ---------------------------: | -------------------: | ---------------------: | ----------: | ---------------: | -------------------: |
|    1477005 |                      1476511 |                   79 |                     79 |           0 |                0 |                13771 |

## PASS · Bars represent trades, not carried-forward quotes

`quality.zero_volume` · advisory

0 of 1,477,005 bars (0.000%) print zero volume; 0 carry no volume at all.

**Findings**

- **PASS** — Zero-volume bars are 0.000% of the panel, inside the 2% tolerance.

**Zero-volume bars by year**

| year |  bars | zero_volume | no_volume | zero_pct |
| ---: | ----: | ----------: | --------: | -------: |
| 2005 | 70507 |           0 |         0 |        0 |
| 2006 | 70508 |           0 |         0 |        0 |
| 2007 | 71059 |           0 |         0 |        0 |
| 2008 | 72352 |           0 |         0 |        0 |
| 2009 | 72268 |           0 |         0 |        0 |
| 2010 | 73474 |           0 |         0 |        0 |
| 2011 | 74061 |           0 |         0 |        0 |
| 2012 | 74915 |           0 |         0 |        0 |
| 2013 | 75952 |           0 |         0 |        0 |
| 2014 | 74834 |           0 |         0 |        0 |
| 2015 | 73985 |           0 |         0 |        0 |
| 2016 | 73215 |           0 |         0 |        0 |
| 2017 | 72001 |           0 |         0 |        0 |
| 2018 | 70462 |           0 |         0 |        0 |
| 2019 | 69351 |           0 |         0 |        0 |
| 2020 | 68613 |           0 |         0 |        0 |
| 2021 | 66478 |           0 |         0 |        0 |
| 2022 | 65674 |           0 |         0 |        0 |
| 2023 | 63569 |           0 |         0 |        0 |
| 2024 | 62227 |           0 |         0 |        0 |
| 2025 | 61500 |           0 |         0 |        0 |

## PASS · Adjusted and unadjusted returns agree away from corporate actions

`quality.adjustment_consistency` · blocking

0 of 1,421,965 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing beyond rounding, across 0 name(s). Sampled every one of the 494 names in the panel.

**Findings**

- **PASS** — The two series agree on all 1,421,965 action-free session pairs compared (every one of the 494 names in the panel).

**How this was sampled**

| names_in_panel | names_compared | method | session_pairs_compared | pairs_skipped_next_to_an_action | tolerance                                   |
| -------------: | -------------: | ------ | ---------------------: | ------------------------------: | ------------------------------------------- |
|            494 |            494 | all    |                1421965 |                           54546 | 2bp + half-cent rounding on all four prices |

## What this audit cannot tell you

Everything above is a statement about the dataset's internal
consistency and about whether it still holds the companies that died.
Those two failures are the ones that quietly invalidate a backtest,
which is why they are worth this much machinery. They are not the only
ones.

Nothing here can establish that the vendor's prices are the prices
that actually traded. Every check compares the data against itself,
against a trading calendar, and against the vendor's own record of
corporate actions. A consistently wrong close, a stale bar carried
forward across a halt, an adjustment factor mis-scaled the same way
everywhere — all of these pass, because internal consistency is
exactly what they preserve. Confirming prices means an independent
second source and a reconciliation, which is a different piece of work
with a different bill.

Several things are simply out of scope, and their absence from the
report is not evidence of their absence from the market. Index
membership as of a past date is not checked, so any universe defined
by membership cannot be reproduced from this. Borrow availability and
cost are not modelled: irrelevant to a long-only book, and fatal the
first day it stops being one. Halts, limit states and the days a name
could not be traded at any price do not appear in a daily bar at all.
Corporate-action edge cases — partial spin-offs, stub equities,
reverse splits used to dodge a delisting notice, rights offerings
priced below market — are examined only as far as the vendor tagged
them, and the ones that break a backtest are precisely the ones
vendors tag inconsistently.

Finally, a clean audit is not a forecast. It says the ground is level.
It says nothing about whether a strategy built on this data has an
edge, whether that edge survives costs and participation limits, or
whether it existed in the sample for a reason that will still be there
next year. A PASS removes one explanation for a good backtest. It does
not supply a better one.
