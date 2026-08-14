# Data audit — Synthetic (smoke test) [SMOKE TEST ONLY]

> **VERDICT: PASS**
>
> **Strategy code may be run against this dataset.**
>
> Every blocking check ran and passed. That is a statement about this dataset's internal consistency and about its retention of the names that died — read the closing section for what it is not a statement about.
>
> 19 checks: 1 WARN, 18 PASS. Generated 2026-08-02 16:23:10+00:00.

## Provenance

| Field            | Value                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| generated        | 2026-08-02 16:23:10+00:00                                                                            |
| source           | Synthetic (smoke test) [SMOKE TEST ONLY]                                                             |
| range            | 2005-01-01 to 2025-12-31                                                                             |
| entities         | 491                                                                                                  |
| price rows       | 1,224,946                                                                                            |
| action rows      | 389                                                                                                  |
| fundamental rows | 19,251                                                                                               |
| panel            | synthetic, generated in-process                                                                      |
| seed             | 20050103                                                                                             |
| injected bias    | none (clean panel)                                                                                   |
| warning          | SMOKE TEST ONLY. Nothing in this report is a statement about any real security.                      |
| command          | data_audit.py --source synthetic --start 2005-01-01 --end 2025-12-31 --out reports/data_audit_repor… |
| report           | reports/data_audit_report.md                                                                         |

## Checks

| Check                                                             | Key                                   | Verdict | Scope    | Headline                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Lookahead injected by screening on adjusted prices                | `pit_adjusted_price_screen_leak`      | WARN    | advisory | A $5.00 floor read off back-adjusted closes admits 0.741% of its own universe on names that were ac… |
| Delisted entities in the master                                   | `survivorship.delisted_present`       | PASS    | blocking | 298 of 491 entities (60.7%) are flagged delisted. Roughly half of everything that has ever listed i… |
| Entity count by year                                              | `survivorship.universe_count_by_year` | PASS    | blocking | Distinct entities with a price row went 283 in 2005 to 200 in 2025 (-29%), rising in 15% of year-on… |
| Annual attrition rate                                             | `survivorship.annual_attrition`       | PASS    | blocking | Median annual attrition is 5.44% across 2006-2024. US equities retire at roughly 2-8% a year with t… |
| Delisted names carry price history                                | `survivorship.dead_names_priced`      | PASS    | blocking | 298 of 298 entities that died inside the window (100.0%) carry at least one price bar. A master tha… |
| Named decedents stop when they died                               | `survivorship.decedent_trace`         | PASS    | blocking | 18/18 named decedents stop trading when they actually stopped; 0 absent (0%), 0 still trading, 0 on… |
| Fundamentals carry a publication date, not just a period end      | `pit_filing_dates_present`            | PASS    | blocking | All 19,251 fundamental rows carry a publication date distinct from the period they describe.         |
| Filing lag is possible and plausibly sized                        | `pit_filing_lag_distribution`         | PASS    | blocking | Median lag 50 days (p5 27, p95 73, max 75); no row predates the period it describes.                 |
| Fundamentals are as-reported, not restated                        | `pit_as_reported_dimension`           | PASS    | blocking | All 19,251 rows carry an AR* dimension: what the filer said at the time, not what they said later.   |
| Recycled symbols are resolvable to distinct entities              | `pit_ticker_recycling`                | PASS    | blocking | 11 recycled symbols out of 480, each resolving to distinct permatickers with non-overlapping window… |
| Prices stay inside the entity's listing window                    | `pit_prices_within_listing_window`    | PASS    | blocking | All 1,224,946 price rows sit inside their entity's listing window (± 3 calendar days for boundary c… |
| Adjusted and as-traded closes are genuinely different series      | `pit_unadjusted_prices_available`     | PASS    | blocking | The two closes differ on 650,681 of 1,224,946 rows (53.119%) and across 264 of 491 entities; median… |
| Names that stopped trading have a corporate action to explain it  | `pit_delisting_action_coverage`       | PASS    | advisory | A terminal action is on file for all 296 names that stopped trading inside the window.               |
| Prices are positive and each bar is internally consistent         | `quality.nonpositive_prices`          | PASS    | blocking | All 1,224,946 bars are positive and self-consistent.                                                 |
| Price dates are real NYSE sessions, and sessions are populated    | `quality.calendar_alignment`          | PASS    | blocking | All 5,283 price dates are NYSE sessions; 100.00% of the 5,283 sessions in range are populated.       |
| One bar per entity-day (and symbol collisions are not that)       | `quality.duplicate_bars`              | PASS    | blocking | No duplicate entity-days; 0 row(s) share a (ticker, date) with a different company, which is expect… |
| Large single-session moves have a corporate action behind them    | `quality.unexplained_jumps`           | PASS    | blocking | 0 of 54 moves beyond ±50% have no action within ±3 sessions: 0.00 per million comparable bars (1,22… |
| Bars represent trades, not carried-forward quotes                 | `quality.zero_volume`                 | PASS    | advisory | 3,627 of 1,224,946 bars (0.296%) print zero volume; 0 carry no volume at all.                        |
| Adjusted and unadjusted returns agree away from corporate actions | `quality.adjustment_consistency`      | PASS    | blocking | 0 of 1,204,959 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing…  |

## WARN · Lookahead injected by screening on adjusted prices

`pit_adjusted_price_screen_leak` · advisory

A $5.00 floor read off back-adjusted closes admits 0.741% of its own universe on names that were actually trading below it (worst sampled date 2.041% on 2022-05-03); it also discards 34 name-days that were genuinely tradable.

**Findings**

- **WARN** — This is the measurement, not a defect: it is how much of the future a naive adjusted-price filter would import. Reverse splits are the mechanism, and they cluster in exactly the names a price floor is meant to exclude.
  _39 leaked name-days across 17 distinct names on 24 sampled dates (0.741% of the adjusted universe)_
- **PASS** — Sampling scope.
  _restricted to the 491 entities whose category is in config.SINGLE_NAME_CATEGORIES_

**screen disagreement by date**

| date       | priced_names | adj_universe | adj_pass_unadj_fail | unadj_pass_adj_fail | leak_pct_of_adj_universe | disagree_pct_of_priced |
| ---------- | -----------: | -----------: | ------------------: | ------------------: | -----------------------: | ---------------------: |
| 2005-01-03 |          268 |          267 |                   1 |                   1 |                    0.375 |                  0.746 |
| 2005-11-30 |          273 |          268 |                   1 |                   2 |                    0.373 |                  1.099 |
| 2006-10-27 |          269 |          265 |                   1 |                   0 |                    0.377 |                  0.372 |
| 2007-09-28 |          271 |          263 |                   2 |                   2 |                    0.760 |                  1.476 |
| 2008-08-27 |          256 |          245 |                   2 |                   2 |                    0.816 |                  1.562 |
| 2009-07-27 |          242 |          228 |                   3 |                   3 |                    1.316 |                  2.479 |
| 2010-06-24 |          244 |          231 |                   3 |                   4 |                    1.299 |                  2.869 |
| 2011-05-23 |          238 |          226 |                   2 |                   2 |                    0.885 |                  1.681 |
| 2012-04-19 |          241 |          231 |                   1 |                   1 |                    0.433 |                  0.830 |
| 2013-03-21 |          236 |          224 |                   1 |                   2 |                    0.446 |                  1.271 |
| 2014-02-19 |          233 |          221 |                   0 |                   2 |                    0.000 |                  0.858 |
| 2015-01-15 |          235 |          223 |                   2 |                   3 |                    0.897 |                  2.128 |
| 2015-12-14 |          231 |          222 |                   3 |                   1 |                    1.351 |                  1.732 |
| 2016-11-09 |          231 |          219 |                   0 |                   2 |                    0.000 |                  0.866 |
| 2017-10-10 |          225 |          211 |                   0 |                   2 |                    0.000 |                  0.889 |
| 2018-09-10 |          229 |          216 |                   0 |                   0 |                    0.000 |                  0.000 |
| 2019-08-08 |          222 |          203 |                   4 |                   2 |                    1.970 |                  2.703 |
| 2020-07-08 |          213 |          196 |                   3 |                   1 |                    1.531 |                  1.878 |
| 2021-06-07 |          207 |          192 |                   3 |                   0 |                    1.562 |                  1.449 |
| 2022-05-03 |          207 |          196 |                   4 |                   0 |                    2.041 |                  1.932 |
| 2023-04-03 |          203 |          188 |                   3 |                   1 |                    1.596 |                  1.970 |
| 2024-03-04 |          194 |          180 |                   0 |                   0 |                    0.000 |                  0.000 |
| 2025-01-31 |          193 |          178 |                   0 |                   1 |                    0.000 |                  0.518 |
| 2025-12-31 |          193 |          173 |                   0 |                   0 |                    0.000 |                  0.000 |

**screen disagreement summary**

| metric                                             | value               |
| -------------------------------------------------- | ------------------- |
| price floor applied                                | $5.00               |
| dates sampled                                      | 24                  |
| name-days in the adjusted universe                 | 5266                |
| name-days admitted on adj, untradable on as-traded | 39                  |
| name-days excluded on adj, tradable on as-traded   | 34                  |
| leak as % of the adjusted universe                 | 0.741               |
| worst single date (%)                              | 2.041 on 2022-05-03 |
| distinct names ever leaked                         | 17                  |

## PASS · Delisted entities in the master

`survivorship.delisted_present` · blocking

298 of 491 entities (60.7%) are flagged delisted. Roughly half of everything that has ever listed in the US since 2005 is gone — merged, taken private, bankrupt or delisted for non-compliance — so a real panel runs well north of a third, and anything under 5% is a master built from today's listings.

**Findings**

- **PASS** — Share of the security master flagged is_delisted.
  _298/491 = 60.69% (fail <5%, warn <15%)_
- **PASS** — Where the dead fall relative to the audited window.
  _0 last traded before 2005, 298 inside the window, 0 after 2025_

**Delistings by year (last_price_date of delisted names)**

| year | delistings | pct_of_delisted |
| ---: | ---------: | --------------: |
| 2005 |         10 |            3.36 |
| 2006 |         19 |            6.38 |
| 2007 |         12 |            4.03 |
| 2008 |         37 |           12.42 |
| 2009 |         26 |            8.72 |
| 2010 |         11 |            3.69 |
| 2011 |         15 |            5.03 |
| 2012 |         13 |            4.36 |
| 2013 |         14 |            4.70 |
| 2014 |         10 |            3.36 |
| 2015 |         14 |            4.70 |
| 2016 |         10 |            3.36 |
| 2017 |         10 |            3.36 |
| 2018 |         11 |            3.69 |
| 2019 |         16 |            5.37 |
| 2020 |         19 |            6.38 |
| 2021 |          8 |            2.68 |
| 2022 |          9 |            3.02 |
| 2023 |         19 |            6.38 |
| 2024 |          8 |            2.68 |
| 2025 |          7 |            2.35 |

## PASS · Entity count by year

`survivorship.universe_count_by_year` · blocking

Distinct entities with a price row went 283 in 2005 to 200 in 2025 (-29%), rising in 15% of year-on-year steps, peaking in 2006. This is the single most diagnostic curve in the audit: a panel assembled from the companies that exist today can only grow toward the present, because the further back you look the more of its members had not yet listed and none of the ones that died were ever included. An honest US panel is broadly flat to gently declining off a 2007-2014 peak, as the delisting wave and the shrinking count of public companies work against new listings.

**Findings**

- **PASS** — Shape of the entity count across years.
  _rising in 3/20 steps = 15% (fail >85% combined with first-to-last growth >40%); 2005=283, 2025=200, growth -29.3%_

**Entities with at least one price row, by year**

| year | entities | change | pct_change |
| ---: | -------: | -----: | ---------: |
| 2005 |      283 |      — |          — |
| 2006 |      288 |      5 |        1.8 |
| 2007 |      284 |     -4 |       -1.4 |
| 2008 |      286 |      2 |        0.7 |
| 2009 |      266 |    -20 |       -7.0 |
| 2010 |      253 |    -13 |       -4.9 |
| 2011 |      254 |      1 |        0.4 |
| 2012 |      250 |     -4 |       -1.6 |
| 2013 |      248 |     -2 |       -0.8 |
| 2014 |      245 |     -3 |       -1.2 |
| 2015 |      245 |      0 |        0.0 |
| 2016 |      240 |     -5 |       -2.0 |
| 2017 |      239 |     -1 |       -0.4 |
| 2018 |      239 |      0 |        0.0 |
| 2019 |      237 |     -2 |       -0.8 |
| 2020 |      229 |     -8 |       -3.4 |
| 2021 |      217 |    -12 |       -5.2 |
| 2022 |      216 |     -1 |       -0.5 |
| 2023 |      214 |     -2 |       -0.9 |
| 2024 |      201 |    -13 |       -6.1 |
| 2025 |      200 |     -1 |       -0.5 |

## PASS · Annual attrition rate

`survivorship.annual_attrition` · blocking

Median annual attrition is 5.44% across 2006-2024. US equities retire at roughly 2-8% a year with the wave breaking in 2008-09 and again in 2020; a median under 0.5% means nothing in this panel ever dies, and one over 15% means something other than corporate mortality is ending these series.

**Findings**

- **PASS** — Median share of each year's incumbents that never trade again.
  _median 5.44% over 19 years (fail <0.5%, warn >15%); min 3.81%, max 13.60%_

**Attrition by year**

| year | alive_at_start | ceased_by_year_end | attrition_pct |
| ---: | -------------: | -----------------: | ------------: |
| 2006 |            273 |                 19 |          6.96 |
| 2007 |            269 |                 12 |          4.46 |
| 2008 |            272 |                 37 |         13.60 |
| 2009 |            249 |                 26 |         10.44 |
| 2010 |            240 |                 11 |          4.58 |
| 2011 |            242 |                 15 |          6.20 |
| 2012 |            239 |                 13 |          5.44 |
| 2013 |            237 |                 14 |          5.91 |
| 2014 |            234 |                 10 |          4.27 |
| 2015 |            235 |                 14 |          5.96 |
| 2016 |            231 |                 10 |          4.33 |
| 2017 |            230 |                 10 |          4.35 |
| 2018 |            229 |                 11 |          4.80 |
| 2019 |            228 |                 16 |          7.02 |
| 2020 |            221 |                 19 |          8.60 |
| 2021 |            210 |                  8 |          3.81 |
| 2022 |            209 |                  9 |          4.31 |
| 2023 |            207 |                 19 |          9.18 |
| 2024 |            195 |                  8 |          4.10 |

## PASS · Delisted names carry price history

`survivorship.dead_names_priced` · blocking

298 of 298 entities that died inside the window (100.0%) carry at least one price bar. A master that lists the dead and stores no prices for them is survivorship bias with extra steps: the names are there to be counted and absent the moment you try to trade them.

**Findings**

- **PASS** — Share of in-window delistings that appear in the price panel.
  _298/298 = 100.00% (fail <80%, warn <95%)_

## PASS · Named decedents stop when they died

`survivorship.decedent_trace` · blocking

18/18 named decedents stop trading when they actually stopped; 0 absent (0%), 0 still trading, 0 on the wrong date. 0 fixture(s) fell outside the audited window and were skipped rather than counted as passes. These are companies whose last day is a matter of public record, so each failure names its own cause.

**Findings**

- **PASS** — Tickers the master holds more than once — resolved on the entity whose last price date sits nearest the known death.
  _WM (2 entities); CC (2 entities); WB (2 entities); GM (2 entities); DELL (2 entities); DOW (2 entities)_

**Decedent trace**

| ticker | name                                | expected_last_trade | master_matches | permaticker | observed_last_price | delta_days | tolerance_days | verdict |
| ------ | ----------------------------------- | ------------------- | -------------: | ----------: | ------------------- | ---------: | -------------: | ------- |
| BSC    | The Bear Stearns Companies Inc.     | 2008-05-30          |              1 |     9000000 | 2008-05-30          |          0 |              3 | ok      |
| CFC    | Countrywide Financial Corporation   | 2008-06-30          |              1 |     9000001 | 2008-06-30          |          0 |              3 | ok      |
| LEH    | Lehman Brothers Holdings Inc.       | 2008-09-17          |              1 |     9000002 | 2008-09-17          |          0 |              4 | ok      |
| WM     | Washington Mutual, Inc.             | 2008-09-25          |              2 |     9000003 | 2008-09-25          |          0 |              4 | ok      |
| CC     | Circuit City Stores, Inc.           | 2008-11-10          |              2 |     9000005 | 2008-11-10          |          0 |              5 | ok      |
| WB     | Wachovia Corporation                | 2008-12-31          |              2 |     9000007 | 2008-12-31          |          0 |              3 | ok      |
| GM     | General Motors Corporation (old GM) | 2009-06-01          |              2 |     9000009 | 2009-06-01          |          0 |              3 | ok      |
| DELL   | Dell Inc.                           | 2013-10-29          |              2 |     9000011 | 2013-10-29          |          0 |              3 | ok      |
| DOW    | The Dow Chemical Company (old Dow)  | 2017-08-31          |              2 |     9000013 | 2017-08-31          |          0 |              3 | ok      |
| SHLD   | Sears Holdings Corporation          | 2018-10-23          |              1 |     9000015 | 2018-10-23          |          0 |              3 | ok      |
| AABA   | Altaba Inc. (formerly Yahoo! Inc.)  | 2019-10-02          |              1 |     9000016 | 2019-10-02          |          0 |              4 | ok      |
| CHL    | China Mobile Limited (ADR)          | 2021-01-08          |              1 |     9000017 | 2021-01-08          |          0 |              3 | ok      |
| TWTR   | Twitter, Inc.                       | 2022-10-27          |              1 |     9000018 | 2022-10-27          |          0 |              3 | ok      |
| SIVB   | SVB Financial Group                 | 2023-03-09          |              1 |     9000019 | 2023-03-09          |          0 |              3 | ok      |
| SBNY   | Signature Bank                      | 2023-03-10          |              1 |     9000020 | 2023-03-10          |          0 |              3 | ok      |
| FRC    | First Republic Bank                 | 2023-04-28          |              1 |     9000021 | 2023-04-28          |          0 |              4 | ok      |
| BBBY   | Bed Bath & Beyond Inc.              | 2023-05-02          |              1 |     9000022 | 2023-05-02          |          0 |              3 | ok      |
| RAD    | Rite Aid Corporation                | 2023-10-16          |              1 |     9000023 | 2023-10-16          |          0 |              3 | ok      |

## PASS · Fundamentals carry a publication date, not just a period end

`pit_filing_dates_present` · blocking

All 19,251 fundamental rows carry a publication date distinct from the period they describe.

**date_public coverage**

| metric                               |  rows | share_pct |
| ------------------------------------ | ----: | --------: |
| fundamental rows                     | 19251 |       100 |
| date_public missing                  |     0 |         0 |
| date_public == period_end            |     0 |         0 |
| date_public distinct from period_end | 19251 |       100 |

## PASS · Filing lag is possible and plausibly sized

`pit_filing_lag_distribution` · blocking

Median lag 50 days (p5 27, p95 73, max 75); no row predates the period it describes.

**filing lag percentiles (days)**

| statistic | lag_days |
| --------- | -------: |
| min       |       25 |
| p1        |       25 |
| p5        |       27 |
| p25       |       37 |
| p50       |       50 |
| p75       |       63 |
| p95       |       73 |
| p99       |       75 |
| max       |       75 |

**worst offenders**

| permaticker | ticker | dimension | period_end | date_public | lag_days |
| ----------: | ------ | --------- | ---------- | ----------- | -------: |
|     9000004 | WM     | ARQ       | 2021-09-30 | 2021-12-14  |       75 |
|     9000008 | WB     | ARQ       | 2017-06-30 | 2017-09-13  |       75 |
|     9000010 | GM     | ARQ       | 2011-03-31 | 2011-06-14  |       75 |
|     9000010 | GM     | ARQ       | 2011-09-30 | 2011-12-14  |       75 |
|     9000011 | DELL   | ARQ       | 2007-03-31 | 2007-06-14  |       75 |
|     9000012 | DELL   | ARQ       | 2017-06-30 | 2017-09-13  |       75 |
|     9000012 | DELL   | ARQ       | 2021-12-31 | 2022-03-16  |       75 |
|     9000016 | AABA   | ARQ       | 2013-06-30 | 2013-09-13  |       75 |
|     9000016 | AABA   | ARQ       | 2019-06-30 | 2019-09-13  |       75 |
|     9000017 | CHL    | ARQ       | 2010-09-30 | 2010-12-14  |       75 |
|     9000017 | CHL    | ARQ       | 2012-06-30 | 2012-09-13  |       75 |
|     9000018 | TWTR   | ARQ       | 2006-03-31 | 2006-06-14  |       75 |
|     9000019 | SIVB   | ARQ       | 2011-03-31 | 2011-06-14  |       75 |
|     9000019 | SIVB   | ARQ       | 2014-03-31 | 2014-06-14  |       75 |
|     9000020 | SBNY   | ARQ       | 2007-03-31 | 2007-06-14  |       75 |
|     9000021 | FRC    | ARQ       | 2007-06-30 | 2007-09-13  |       75 |
|     9000021 | FRC    | ARQ       | 2010-09-30 | 2010-12-14  |       75 |
|     9000022 | BBBY   | ARQ       | 2019-12-31 | 2020-03-15  |       75 |
|     9000023 | RAD    | ARQ       | 2006-06-30 | 2006-09-13  |       75 |
|     9000024 | WVF    | ARQ       | 2019-06-30 | 2019-09-13  |       75 |
|     9000024 | WVF    | ARQ       | 2020-09-30 | 2020-12-14  |       75 |
|     9000027 | YCB    | ARQ       | 2013-03-31 | 2013-06-14  |       75 |
|     9000029 | YSB    | ARQ       | 2012-06-30 | 2012-09-13  |       75 |
|     9000029 | YSB    | ARQ       | 2016-06-30 | 2016-09-13  |       75 |
|     9000034 | KZR    | ARQ       | 2011-12-31 | 2012-03-15  |       75 |

## PASS · Fundamentals are as-reported, not restated

`pit_as_reported_dimension` · blocking

All 19,251 rows carry an AR* dimension: what the filer said at the time, not what they said later.

**dimensions present**

| dimension |  rows | kind        | share_pct |
| --------- | ----: | ----------- | --------: |
| ARQ       | 19251 | as-reported |       100 |

## PASS · Recycled symbols are resolvable to distinct entities

`pit_ticker_recycling` · blocking

11 recycled symbols out of 480, each resolving to distinct permatickers with non-overlapping windows.

**symbol reuse**

| metric                                       | value |
| -------------------------------------------- | ----- |
| distinct symbols in the master               | 480   |
| symbols carried by more than one entity      | 11    |
| entities sitting on a recycled symbol        | 22    |
| entities whose window overlaps a predecessor | 0     |
| permanent entity ids claimed                 | True  |

**most-recycled symbols**

| ticker | permaticker | name                                 | first_price_date | last_price_date | is_delisted |
| ------ | ----------: | ------------------------------------ | ---------------- | --------------- | ----------- |
| CC     |     9000005 | Circuit City Stores, Inc.            | 2005-01-03       | 2008-11-10      | true        |
| CC     |     9000006 | Kestrel Retail Group Corp.           | 2009-11-06       | 2025-12-31      | false       |
| DELL   |     9000011 | Dell Inc.                            | 2005-01-03       | 2013-10-29      | true        |
| DELL   |     9000012 | Thornbury Systems Holdings, Inc.     | 2014-10-27       | 2025-12-31      | false       |
| DOW    |     9000013 | The Dow Chemical Company (old Dow)   | 2005-01-03       | 2017-08-31      | true        |
| DOW    |     9000014 | Westmark Foods Inc.                  | 2018-08-29       | 2025-12-31      | false       |
| FVHE   |     9000304 | Dunmore Software Holdings, Inc.      | 2007-07-16       | 2010-08-09      | true        |
| FVHE   |     9000487 | Alder Therapeutics Group             | 2011-08-04       | 2025-12-31      | false       |
| GM     |     9000009 | General Motors Corporation (old GM)  | 2005-01-03       | 2009-06-01      | true        |
| GM     |     9000010 | Westmark Retail Group Holdings, Inc. | 2010-05-27       | 2025-12-31      | false       |
| MAA    |     9000094 | Orchid Insurance Corp.               | 2005-01-03       | 2024-08-20      | true        |
| MAA    |     9000488 | Kestrel Materials Holdings, Inc.     | 2025-08-20       | 2025-12-31      | false       |
| MCIO   |     9000287 | Westmark Foods Corp.                 | 2005-07-12       | 2006-10-24      | true        |
| MCIO   |     9000490 | Umber Insurance Inc.                 | 2007-10-23       | 2025-12-31      | false       |
| PVLJ   |     9000092 | Quarry Software Corp.                | 2005-01-03       | 2018-02-27      | true        |
| PVLJ   |     9000489 | Fenwick Instruments Holdings, Inc.   | 2019-02-26       | 2025-12-31      | false       |
| QDMD   |     9000211 | Thornbury Retail Group Group         | 2005-01-03       | 2008-03-11      | true        |
| QDMD   |     9000486 | Pemberton Resources Holdings, Inc.   | 2009-03-09       | 2025-12-31      | false       |
| WB     |     9000007 | Wachovia Corporation                 | 2005-01-03       | 2008-12-31      | true        |
| WB     |     9000008 | Junction Semiconductor Co.           | 2009-12-29       | 2025-12-31      | false       |
| WM     |     9000003 | Washington Mutual, Inc.              | 2005-01-03       | 2008-09-25      | true        |
| WM     |     9000004 | Cardinal Instruments Corp.           | 2009-09-23       | 2025-12-31      | false       |

## PASS · Prices stay inside the entity's listing window

`pit_prices_within_listing_window` · blocking

All 1,224,946 price rows sit inside their entity's listing window (± 3 calendar days for boundary conventions).

**listing-window coverage**

| metric                       |   value |
| ---------------------------- | ------: |
| price rows checked           | 1224946 |
| rows before first_price_date |       0 |
| rows after last_price_date   |       0 |
| entities affected            |       0 |
| tolerance (calendar days)    |       3 |

## PASS · Adjusted and as-traded closes are genuinely different series

`pit_unadjusted_prices_available` · blocking

The two closes differ on 650,681 of 1,224,946 rows (53.119%) and across 264 of 491 entities; median gap 16.01%.

**Findings**

- **PASS** — Corporate events located.
  _splits from prices.split_factor; dividends from prices.dividends; splits from actions_

**adjusted vs as-traded divergence**

| metric                                    | value   |
| ----------------------------------------- | ------- |
| rows with both closes                     | 1224946 |
| rows where they differ                    | 650681  |
| entities priced                           | 491     |
| entities where they ever differ           | 264     |
| median gap on differing rows (%)          | 16.0067 |
| p95 gap on differing rows (%)             | 900.0   |
| max gap (%)                               | 900.0   |
| entities with a split                     | 66      |
| split entities that never diverge         | 0       |
| dividend-only entities                    | 198     |
| dividend-only entities that never diverge | 0       |

## PASS · Names that stopped trading have a corporate action to explain it

`pit_delisting_action_coverage` · advisory

A terminal action is on file for all 296 names that stopped trading inside the window.

**delisting coverage**

| metric                                         | value       |
| ---------------------------------------------- | ----------- |
| entities whose last price is inside the window | 296         |
| with a terminal action on file                 | 296         |
| coverage (%)                                   | 100.0       |
| matched by                                     | permaticker |
| terminal action rows seen                      | 298         |
| terminal actions carrying a reason             | 298         |
| tail buffer (calendar days)                    | 30          |

## PASS · Prices are positive and each bar is internally consistent

`quality.nonpositive_prices` · blocking

All 1,224,946 bars are positive and self-consistent.

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

`quality.unexplained_jumps` · blocking

0 of 54 moves beyond ±50% have no action within ±3 sessions: 0.00 per million comparable bars (1,224,455 examined).

**Findings**

- **PASS** — Every one of the 54 move(s) beyond ±50% has a corporate action nearby.

**Jump scan**

| price_rows | comparable_consecutive_pairs | moves_over_threshold | explained_by_an_action | unexplained | per_million_bars | action_rows_searched |
| ---------: | ---------------------------: | -------------------: | ---------------------: | ----------: | ---------------: | -------------------: |
|    1224946 |                      1224455 |                   54 |                     54 |           0 |                0 |                  389 |

## PASS · Bars represent trades, not carried-forward quotes

`quality.zero_volume` · advisory

3,627 of 1,224,946 bars (0.296%) print zero volume; 0 carry no volume at all.

**Findings**

- **PASS** — Zero-volume bars are 0.296% of the panel, inside the 2% tolerance.

**Zero-volume bars by year**

| year |  bars | zero_volume | no_volume | zero_pct |
| ---: | ----: | ----------: | --------: | -------: |
| 2005 | 68458 |         211 |         0 |     0.31 |
| 2006 | 68280 |         227 |         0 |     0.33 |
| 2007 | 68380 |         189 |         0 |     0.28 |
| 2008 | 65892 |         181 |         0 |     0.27 |
| 2009 | 61482 |         190 |         0 |     0.31 |
| 2010 | 61011 |         177 |         0 |     0.29 |
| 2011 | 59740 |         194 |         0 |     0.32 |
| 2012 | 59454 |         194 |         0 |     0.33 |
| 2013 | 59572 |         155 |         0 |     0.26 |
| 2014 | 59228 |         176 |         0 |     0.30 |
| 2015 | 58386 |         156 |         0 |     0.27 |
| 2016 | 58416 |         158 |         0 |     0.27 |
| 2017 | 57158 |         163 |         0 |     0.29 |
| 2018 | 56961 |         182 |         0 |     0.32 |
| 2019 | 56493 |         145 |         0 |     0.26 |
| 2020 | 54365 |         158 |         0 |     0.29 |
| 2021 | 52539 |         186 |         0 |     0.35 |
| 2022 | 52381 |         154 |         0 |     0.29 |
| 2023 | 49866 |         142 |         0 |     0.28 |
| 2024 | 48590 |         144 |         0 |     0.30 |
| 2025 | 48294 |         145 |         0 |     0.30 |

**Names with the most zero-volume bars**

| permaticker | ticker | bars | zero_volume | zero_pct |
| ----------: | ------ | ---: | ----------: | -------: |
|     9000173 | BCIF   |  134 |           2 |      1.5 |
|     9000483 | OOZN   |  162 |           2 |      1.2 |
|     9000142 | YPXI   |  370 |           4 |      1.1 |
|     9000453 | RLG    |  104 |           1 |      1.0 |
|     9000428 | AJJV   |  221 |           2 |      0.9 |
|     9000441 | SWGJ   |  217 |           2 |      0.9 |
|     9000484 | ZYHU   |  228 |           2 |      0.9 |
|     9000030 | VGYC   |  113 |           1 |      0.9 |
|     9000480 | KGNE   |  110 |           1 |      0.9 |
|     9000144 | BTQ    |  992 |           8 |      0.8 |
|     9000190 | NEB    |  757 |           6 |      0.8 |
|     9000162 | GZJ    |  613 |           5 |      0.8 |
|     9000296 | WSB    |  386 |           3 |      0.8 |
|     9000309 | VARS   |  255 |           2 |      0.8 |
|     9000340 | ZWZC   |  257 |           2 |      0.8 |

## PASS · Adjusted and unadjusted returns agree away from corporate actions

`quality.adjustment_consistency` · blocking

0 of 1,204,959 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing beyond rounding, across 0 name(s). Sampled every one of the 491 names in the panel.

**Findings**

- **PASS** — The two series agree on all 1,204,959 action-free session pairs compared (every one of the 491 names in the panel).

**How this was sampled**

| names_in_panel | names_compared | method | session_pairs_compared | pairs_skipped_next_to_an_action | tolerance                                   |
| -------------: | -------------: | ------ | ---------------------: | ------------------------------: | ------------------------------------------- |
|            491 |            491 | all    |                1204959 |                           19496 | 2bp + half-cent rounding on all four prices |

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
