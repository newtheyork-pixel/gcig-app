# Data audit — Synthetic (smoke test) [SMOKE TEST ONLY] — bias: UNRECORDED_SPLITS

> **VERDICT: PASS**
>
> **Strategy code may be run against this dataset.**
>
> Every blocking check ran and passed. That is a statement about this dataset's internal consistency and about its retention of the names that died — read the closing section for what it is not a statement about.
>
> 19 checks: 1 FAIL, 1 WARN, 17 PASS. Generated 2026-08-02 16:03:01+00:00.

## Provenance

| Field            | Value                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| generated        | 2026-08-02 16:03:01+00:00                                                       |
| source           | Synthetic (smoke test) [SMOKE TEST ONLY] — bias: UNRECORDED_SPLITS              |
| range            | 2005-01-01 to 2026-08-02                                                        |
| entities         | 505                                                                             |
| price rows       | 1,298,746                                                                       |
| action rows      | 320                                                                             |
| fundamental rows | 20,388                                                                          |
| panel            | synthetic, generated in-process                                                 |
| seed             | 20050103                                                                        |
| injected bias    | unrecorded-splits                                                               |
| warning          | SMOKE TEST ONLY. Nothing in this report is a statement about any real security. |
| command          | data_audit.py --source synthetic --inject-bias unrecorded-splits                |
| report           | /Users/thomasseirer/repos/gcig-app/quant/reports/data_audit_report.md           |

## Checks

| Check                                                             | Key                                   | Verdict | Scope    | Headline                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Large single-session moves have a corporate action behind them    | `quality.unexplained_jumps`           | FAIL    | advisory | 85 of 85 moves beyond ±50% have no action within ±3 sessions: 65.47 per million comparable bars (1,… |
| Lookahead injected by screening on adjusted prices                | `pit_adjusted_price_screen_leak`      | WARN    | advisory | A $5.00 floor read off back-adjusted closes admits 1.227% of its own universe on names that were ac… |
| Delisted entities in the master                                   | `survivorship.delisted_present`       | PASS    | blocking | 298 of 505 entities (59.0%) are flagged delisted. Roughly half of everything that has ever listed i… |
| Entity count by year                                              | `survivorship.universe_count_by_year` | PASS    | blocking | Distinct entities with a price row went 283 in 2005 to 217 in 2026 (-23%), rising in 24% of year-on… |
| Annual attrition rate                                             | `survivorship.annual_attrition`       | PASS    | blocking | Median annual attrition is 5.06% across 2006-2025. US equities retire at roughly 2-8% a year with t… |
| Delisted names carry price history                                | `survivorship.dead_names_priced`      | PASS    | blocking | 298 of 298 entities that died inside the window (100.0%) carry at least one price bar. A master tha… |
| Named decedents stop when they died                               | `survivorship.decedent_trace`         | PASS    | blocking | 18/18 named decedents stop trading when they actually stopped; 0 absent (0%), 0 still trading, 0 on… |
| Fundamentals carry a publication date, not just a period end      | `pit_filing_dates_present`            | PASS    | blocking | All 20,388 fundamental rows carry a publication date distinct from the period they describe.         |
| Filing lag is possible and plausibly sized                        | `pit_filing_lag_distribution`         | PASS    | blocking | Median lag 50 days (p5 27, p95 73, max 75); no row predates the period it describes.                 |
| Fundamentals are as-reported, not restated                        | `pit_as_reported_dimension`           | PASS    | blocking | All 20,388 rows carry an AR* dimension: what the filer said at the time, not what they said later.   |
| Recycled symbols are resolvable to distinct entities              | `pit_ticker_recycling`                | PASS    | blocking | 11 recycled symbols out of 494, each resolving to distinct permatickers with non-overlapping window… |
| Prices stay inside the entity's listing window                    | `pit_prices_within_listing_window`    | PASS    | blocking | All 1,298,746 price rows sit inside their entity's listing window (± 3 calendar days for boundary c… |
| Adjusted and as-traded closes are genuinely different series      | `pit_unadjusted_prices_available`     | PASS    | blocking | The two closes differ on 705,618 of 1,298,746 rows (54.331%) and across 284 of 505 entities; median… |
| Names that stopped trading have a corporate action to explain it  | `pit_delisting_action_coverage`       | PASS    | advisory | A terminal action is on file for all 297 names that stopped trading inside the window.               |
| Prices are positive and each bar is internally consistent         | `quality.nonpositive_prices`          | PASS    | blocking | All 1,298,746 bars are positive and self-consistent.                                                 |
| Price dates are real NYSE sessions, and sessions are populated    | `quality.calendar_alignment`          | PASS    | blocking | All 5,428 price dates are NYSE sessions; 100.00% of the 5,428 sessions in range are populated.       |
| One bar per entity-day (and symbol collisions are not that)       | `quality.duplicate_bars`              | PASS    | blocking | No duplicate entity-days; 0 row(s) share a (ticker, date) with a different company, which is expect… |
| Bars represent trades, not carried-forward quotes                 | `quality.zero_volume`                 | PASS    | advisory | 3,888 of 1,298,746 bars (0.299%) print zero volume; 0 carry no volume at all.                        |
| Adjusted and unadjusted returns agree away from corporate actions | `quality.adjustment_consistency`      | PASS    | blocking | 0 of 1,260,598 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing…  |

## FAIL · Large single-session moves have a corporate action behind them

`quality.unexplained_jumps` · advisory

85 of 85 moves beyond ±50% have no action within ±3 sessions: 65.47 per million comparable bars (1,298,241 examined).

**Findings**

- **FAIL** — 85 single-session move(s) beyond ±50% with no split, merger or other action within ±3 sessions. These are almost always unrecorded splits — a 4-for-1 that nobody logged reads as a 75% loss, and a backtest will size into it.
  _RKK (permaticker 9000321) 2022-05-27 → 2022-05-31: 2.5029 → 24.9784 (+898.0%)_

**Jump scan**

| price_rows | comparable_consecutive_pairs | moves_over_threshold | explained_by_an_action | unexplained | per_million_bars | action_rows_searched |
| ---------: | ---------------------------: | -------------------: | ---------------------: | ----------: | ---------------: | -------------------: |
|    1298746 |                      1298241 |                   85 |                      0 |          85 |           65.473 |                  320 |

**Twenty worst unexplained moves**

| permaticker | ticker | prev_date  | date       | prev_close |   close | move_pct | nearest_action                      | calendar_days_away |
| ----------: | ------ | ---------- | ---------- | ---------: | ------: | -------: | ----------------------------------- | -----------------: |
|     9000321 | RKK    | 2022-05-27 | 2022-05-31 |     2.5029 | 24.9784 |    898.0 | no action on record for this ticker |                  — |
|     9000303 | MXUQ   | 2026-02-04 | 2026-02-05 |     2.5121 | 24.9475 |    893.1 | no action on record for this ticker |                  — |
|     9000057 | VXG    | 2021-05-07 | 2021-05-10 |     2.5228 | 24.8336 |    884.4 | delisted on 2023-12-08              |                942 |
|     9000103 | BJF    | 2010-05-13 | 2010-05-14 |     2.5245 | 24.8495 |    884.3 | no action on record for this ticker |                  — |
|     9000358 | GSY    | 2017-04-26 | 2017-04-27 |     2.5374 | 24.8532 |    879.5 | delisted on 2020-10-06              |              1,258 |
|     9000125 | RLG    | 2020-04-24 | 2020-04-27 |     2.5213 | 24.6795 |    878.9 | tickerchange on 2013-05-13          |             -2,541 |
|     9000315 | DONZ   | 2013-05-06 | 2013-05-07 |     2.5465 | 24.9213 |    878.6 | delisted on 2016-06-22              |              1,142 |
|     9000258 | JII    | 2011-02-07 | 2011-02-08 |     2.5318 | 24.7643 |    878.1 | no action on record for this ticker |                  — |
|     9000064 | AHCX   | 2017-04-25 | 2017-04-26 |     2.5531 | 24.9599 |    877.6 | tickerchange on 2011-03-22          |             -2,227 |
|     9000024 | WVF    | 2019-09-12 | 2019-09-13 |     2.5338 | 24.7124 |    875.3 | delisted on 2022-11-17              |              1,161 |
|     9000105 | SOT    | 2012-07-02 | 2012-07-03 |     2.5380 | 24.7275 |    874.3 | delisted on 2016-10-31              |              1,581 |
|     9000039 | UWN    | 2015-05-06 | 2015-05-07 |     2.5610 | 24.9508 |    874.3 | delisted on 2021-09-01              |              2,309 |
|     9000082 | AWT    | 2016-11-07 | 2016-11-08 |     2.5460 | 24.7963 |    873.9 | no action on record for this ticker |                  — |
|     9000356 | UJUC   | 2018-10-11 | 2018-10-12 |     2.5633 | 24.9463 |    873.2 | no action on record for this ticker |                  — |
|     9000286 | WMV    | 2010-10-06 | 2010-10-07 |     2.5559 | 24.8036 |    870.4 | delisted on 2020-06-04              |              3,528 |
|     9000201 | FKLQ   | 2007-04-05 | 2007-04-09 |     2.5103 | 24.3295 |    869.2 | delisted on 2009-05-06              |                758 |
|     9000053 | BYJA   | 2014-08-25 | 2014-08-26 |     2.5253 | 24.4598 |    868.6 | no action on record for this ticker |                  — |
|     9000153 | MDKG   | 2009-07-13 | 2009-07-14 |     2.5689 | 24.8813 |    868.6 | delisted on 2009-10-07              |                 85 |
|     9000381 | FZCO   | 2017-11-07 | 2017-11-08 |     2.5248 | 24.3837 |    865.8 | delisted on 2018-02-12              |                 96 |
|     9000213 | UBJE   | 2008-05-21 | 2008-05-22 |     2.5577 | 24.5574 |    860.1 | no action on record for this ticker |                  — |

## WARN · Lookahead injected by screening on adjusted prices

`pit_adjusted_price_screen_leak` · advisory

A $5.00 floor read off back-adjusted closes admits 1.227% of its own universe on names that were actually trading below it (worst sampled date 3.111% on 2020-01-02); it also discards 49 name-days that were genuinely tradable.

**Findings**

- **WARN** — This is the measurement, not a defect: it is how much of the future a naive adjusted-price filter would import. Reverse splits are the mechanism, and they cluster in exactly the names a price floor is meant to exclude.
  _66 leaked name-days across 33 distinct names on 24 sampled dates (1.227% of the adjusted universe)_
- **PASS** — Sampling scope.
  _restricted to the 505 entities whose category is in config.SINGLE_NAME_CATEGORIES_

**screen disagreement by date**

| date       | priced_names | adj_universe | adj_pass_unadj_fail | unadj_pass_adj_fail | leak_pct_of_adj_universe | disagree_pct_of_priced |
| ---------- | -----------: | -----------: | ------------------: | ------------------: | -----------------------: | ---------------------: |
| 2005-01-03 |          268 |          261 |                   0 |                   6 |                    0.000 |                  2.239 |
| 2005-12-08 |          269 |          262 |                   0 |                   5 |                    0.000 |                  1.859 |
| 2006-11-15 |          266 |          257 |                   2 |                   3 |                    0.778 |                  1.880 |
| 2007-10-25 |          266 |          257 |                   3 |                   4 |                    1.167 |                  2.632 |
| 2008-10-02 |          249 |          236 |                   1 |                   3 |                    0.424 |                  1.606 |
| 2009-09-10 |          246 |          234 |                   4 |                   4 |                    1.709 |                  3.252 |
| 2010-08-18 |          240 |          228 |                   3 |                   3 |                    1.316 |                  2.500 |
| 2011-07-26 |          241 |          225 |                   3 |                   5 |                    1.333 |                  3.320 |
| 2012-07-02 |          236 |          221 |                   4 |                   2 |                    1.810 |                  2.542 |
| 2013-06-12 |          237 |          223 |                   4 |                   2 |                    1.794 |                  2.532 |
| 2014-05-20 |          240 |          228 |                   2 |                   0 |                    0.877 |                  0.833 |
| 2015-04-28 |          240 |          223 |                   4 |                   2 |                    1.794 |                  2.500 |
| 2016-04-04 |          238 |          220 |                   5 |                   3 |                    2.273 |                  3.361 |
| 2017-03-10 |          244 |          230 |                   2 |                   2 |                    0.870 |                  1.639 |
| 2018-02-15 |          235 |          216 |                   5 |                   2 |                    2.315 |                  2.979 |
| 2019-01-25 |          240 |          222 |                   6 |                   2 |                    2.703 |                  3.333 |
| 2020-01-02 |          240 |          225 |                   7 |                   0 |                    3.111 |                  2.917 |
| 2020-12-08 |          234 |          221 |                   4 |                   0 |                    1.810 |                  1.709 |
| 2021-11-15 |          233 |          219 |                   3 |                   0 |                    1.370 |                  1.288 |
| 2022-10-24 |          227 |          210 |                   1 |                   0 |                    0.476 |                  0.441 |
| 2023-10-03 |          218 |          199 |                   2 |                   1 |                    1.005 |                  1.376 |
| 2024-09-11 |          214 |          193 |                   0 |                   0 |                    0.000 |                  0.000 |
| 2025-08-21 |          211 |          187 |                   1 |                   0 |                    0.535 |                  0.474 |
| 2026-07-31 |          207 |          182 |                   0 |                   0 |                    0.000 |                  0.000 |

**screen disagreement summary**

| metric                                             | value               |
| -------------------------------------------------- | ------------------- |
| price floor applied                                | $5.00               |
| dates sampled                                      | 24                  |
| name-days in the adjusted universe                 | 5379                |
| name-days admitted on adj, untradable on as-traded | 66                  |
| name-days excluded on adj, tradable on as-traded   | 49                  |
| leak as % of the adjusted universe                 | 1.227               |
| worst single date (%)                              | 3.111 on 2020-01-02 |
| distinct names ever leaked                         | 33                  |

## PASS · Delisted entities in the master

`survivorship.delisted_present` · blocking

298 of 505 entities (59.0%) are flagged delisted. Roughly half of everything that has ever listed in the US since 2005 is gone — merged, taken private, bankrupt or delisted for non-compliance — so a real panel runs well north of a third, and anything under 5% is a master built from today's listings.

**Findings**

- **PASS** — Share of the security master flagged is_delisted.
  _298/505 = 59.01% (fail <5%, warn <15%)_
- **PASS** — Where the dead fall relative to the audited window.
  _0 last traded before 2005, 298 inside the window, 0 after 2026_

**Delistings by year (last_price_date of delisted names)**

| year | delistings | pct_of_delisted |
| ---: | ---------: | --------------: |
| 2005 |         14 |            4.70 |
| 2006 |         19 |            6.38 |
| 2007 |         11 |            3.69 |
| 2008 |         36 |           12.08 |
| 2009 |         24 |            8.05 |
| 2010 |          9 |            3.02 |
| 2011 |         12 |            4.03 |
| 2012 |         12 |            4.03 |
| 2013 |         13 |            4.36 |
| 2014 |          8 |            2.68 |
| 2015 |         13 |            4.36 |
| 2016 |          9 |            3.02 |
| 2017 |         14 |            4.70 |
| 2018 |          7 |            2.35 |
| 2019 |          9 |            3.02 |
| 2020 |         15 |            5.03 |
| 2021 |          9 |            3.02 |
| 2022 |         16 |            5.37 |
| 2023 |         19 |            6.38 |
| 2024 |          8 |            2.68 |
| 2025 |         11 |            3.69 |
| 2026 |         10 |            3.36 |

## PASS · Entity count by year

`survivorship.universe_count_by_year` · blocking

Distinct entities with a price row went 283 in 2005 to 217 in 2026 (-23%), rising in 24% of year-on-year steps, peaking in 2005. This is the single most diagnostic curve in the audit: a panel assembled from the companies that exist today can only grow toward the present, because the further back you look the more of its members had not yet listed and none of the ones that died were ever included. An honest US panel is broadly flat to gently declining off a 2007-2014 peak, as the delisting wave and the shrinking count of public companies work against new listings.

**Findings**

- **PASS** — Shape of the entity count across years.
  _rising in 5/21 steps = 24% (fail >85% combined with first-to-last growth >40%); 2005=283, 2026=217, growth -23.3%_

**Entities with at least one price row, by year**

| year | entities | change | pct_change |
| ---: | -------: | -----: | ---------: |
| 2005 |      283 |      — |          — |
| 2006 |      283 |      0 |        0.0 |
| 2007 |      278 |     -5 |       -1.8 |
| 2008 |      281 |      3 |        1.1 |
| 2009 |      261 |    -20 |       -7.1 |
| 2010 |      250 |    -11 |       -4.2 |
| 2011 |      252 |      2 |        0.8 |
| 2012 |      251 |     -1 |       -0.4 |
| 2013 |      251 |      0 |        0.0 |
| 2014 |      251 |      0 |        0.0 |
| 2015 |      253 |      2 |        0.8 |
| 2016 |      250 |     -3 |       -1.2 |
| 2017 |      251 |      1 |        0.4 |
| 2018 |      247 |     -4 |       -1.6 |
| 2019 |      249 |      2 |        0.8 |
| 2020 |      249 |      0 |        0.0 |
| 2021 |      243 |     -6 |       -2.4 |
| 2022 |      242 |     -1 |       -0.4 |
| 2023 |      235 |     -7 |       -2.9 |
| 2024 |      223 |    -12 |       -5.1 |
| 2025 |      222 |     -1 |       -0.4 |
| 2026 |      217 |     -5 |       -2.3 |

## PASS · Annual attrition rate

`survivorship.annual_attrition` · blocking

Median annual attrition is 5.06% across 2006-2025. US equities retire at roughly 2-8% a year with the wave breaking in 2008-09 and again in 2020; a median under 0.5% means nothing in this panel ever dies, and one over 15% means something other than corporate mortality is ending these series.

**Findings**

- **PASS** — Median share of each year's incumbents that never trade again.
  _median 5.06% over 20 years (fail <0.5%, warn >15%); min 2.95%, max 13.48%_

**Attrition by year**

| year | alive_at_start | ceased_by_year_end | attrition_pct |
| ---: | -------------: | -----------------: | ------------: |
| 2006 |            269 |                 19 |          7.06 |
| 2007 |            264 |                 11 |          4.17 |
| 2008 |            267 |                 36 |         13.48 |
| 2009 |            245 |                 24 |          9.80 |
| 2010 |            237 |                  9 |          3.80 |
| 2011 |            241 |                 12 |          4.98 |
| 2012 |            240 |                 12 |          5.00 |
| 2013 |            239 |                 13 |          5.44 |
| 2014 |            238 |                  8 |          3.36 |
| 2015 |            243 |                 13 |          5.35 |
| 2016 |            240 |                  9 |          3.75 |
| 2017 |            241 |                 14 |          5.81 |
| 2018 |            237 |                  7 |          2.95 |
| 2019 |            240 |                  9 |          3.75 |
| 2020 |            240 |                 15 |          6.25 |
| 2021 |            234 |                  9 |          3.85 |
| 2022 |            234 |                 16 |          6.84 |
| 2023 |            226 |                 19 |          8.41 |
| 2024 |            216 |                  8 |          3.70 |
| 2025 |            215 |                 11 |          5.12 |

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

All 20,388 fundamental rows carry a publication date distinct from the period they describe.

**date_public coverage**

| metric                               |  rows | share_pct |
| ------------------------------------ | ----: | --------: |
| fundamental rows                     | 20388 |       100 |
| date_public missing                  |     0 |         0 |
| date_public == period_end            |     0 |         0 |
| date_public distinct from period_end | 20388 |       100 |

## PASS · Filing lag is possible and plausibly sized

`pit_filing_lag_distribution` · blocking

Median lag 50 days (p5 27, p95 73, max 75); no row predates the period it describes.

**filing lag percentiles (days)**

| statistic | lag_days |
| --------- | -------: |
| min       |       25 |
| p1        |       25 |
| p5        |       27 |
| p25       |       38 |
| p50       |       50 |
| p75       |       63 |
| p95       |       73 |
| p99       |       75 |
| max       |       75 |

**worst offenders**

| permaticker | ticker | dimension | period_end | date_public | lag_days |
| ----------: | ------ | --------- | ---------- | ----------- | -------: |
|     9000004 | WM     | ARQ       | 2010-03-31 | 2010-06-14  |       75 |
|     9000004 | WM     | ARQ       | 2010-12-31 | 2011-03-16  |       75 |
|     9000008 | WB     | ARQ       | 2015-06-30 | 2015-09-13  |       75 |
|     9000008 | WB     | ARQ       | 2016-03-31 | 2016-06-14  |       75 |
|     9000008 | WB     | ARQ       | 2019-03-31 | 2019-06-14  |       75 |
|     9000010 | GM     | ARQ       | 2021-06-30 | 2021-09-13  |       75 |
|     9000011 | DELL   | ARQ       | 2011-09-30 | 2011-12-14  |       75 |
|     9000013 | DOW    | ARQ       | 2016-09-30 | 2016-12-14  |       75 |
|     9000016 | AABA   | ARQ       | 2012-03-31 | 2012-06-14  |       75 |
|     9000017 | CHL    | ARQ       | 2006-09-30 | 2006-12-14  |       75 |
|     9000017 | CHL    | ARQ       | 2020-12-31 | 2021-03-16  |       75 |
|     9000018 | TWTR   | ARQ       | 2015-12-31 | 2016-03-15  |       75 |
|     9000018 | TWTR   | ARQ       | 2019-03-31 | 2019-06-14  |       75 |
|     9000019 | SIVB   | ARQ       | 2014-03-31 | 2014-06-14  |       75 |
|     9000019 | SIVB   | ARQ       | 2021-03-31 | 2021-06-14  |       75 |
|     9000020 | SBNY   | ARQ       | 2020-03-31 | 2020-06-14  |       75 |
|     9000021 | FRC    | ARQ       | 2010-12-31 | 2011-03-16  |       75 |
|     9000022 | BBBY   | ARQ       | 2019-03-31 | 2019-06-14  |       75 |
|     9000024 | WVF    | ARQ       | 2017-09-30 | 2017-12-14  |       75 |
|     9000025 | YEX    | ARQ       | 2009-09-30 | 2009-12-14  |       75 |
|     9000025 | YEX    | ARQ       | 2014-03-31 | 2014-06-14  |       75 |
|     9000025 | YEX    | ARQ       | 2014-12-31 | 2015-03-16  |       75 |
|     9000027 | YCB    | ARQ       | 2012-03-31 | 2012-06-14  |       75 |
|     9000028 | FKXB   | ARQ       | 2005-03-31 | 2005-06-14  |       75 |
|     9000028 | FKXB   | ARQ       | 2020-12-31 | 2021-03-16  |       75 |

## PASS · Fundamentals are as-reported, not restated

`pit_as_reported_dimension` · blocking

All 20,388 rows carry an AR* dimension: what the filer said at the time, not what they said later.

**dimensions present**

| dimension |  rows | kind        | share_pct |
| --------- | ----: | ----------- | --------: |
| ARQ       | 20388 | as-reported |       100 |

## PASS · Recycled symbols are resolvable to distinct entities

`pit_ticker_recycling` · blocking

11 recycled symbols out of 494, each resolving to distinct permatickers with non-overlapping windows.

**symbol reuse**

| metric                                       | value |
| -------------------------------------------- | ----- |
| distinct symbols in the master               | 494   |
| symbols carried by more than one entity      | 11    |
| entities sitting on a recycled symbol        | 22    |
| entities whose window overlaps a predecessor | 0     |
| permanent entity ids claimed                 | True  |

**most-recycled symbols**

| ticker | permaticker | name                                  | first_price_date | last_price_date | is_delisted |
| ------ | ----------: | ------------------------------------- | ---------------- | --------------- | ----------- |
| CC     |     9000005 | Circuit City Stores, Inc.             | 2005-01-03       | 2008-11-10      | true        |
| CC     |     9000006 | Pemberton Retail Group Holdings, Inc. | 2009-11-06       | 2026-07-31      | false       |
| CDYK   |     9000384 | Ivory Systems Group                   | 2013-07-02       | 2022-06-24      | true        |
| CDYK   |     9000504 | Quarry Materials Co.                  | 2023-06-23       | 2026-07-31      | false       |
| DELL   |     9000011 | Dell Inc.                             | 2005-01-03       | 2013-10-29      | true        |
| DELL   |     9000012 | Junction Energy Group                 | 2014-10-27       | 2026-07-31      | false       |
| DOW    |     9000013 | The Dow Chemical Company (old Dow)    | 2005-01-03       | 2017-08-31      | true        |
| DOW    |     9000014 | Thornbury Energy Holdings, Inc.       | 2018-08-29       | 2026-07-31      | false       |
| ETT    |     9000360 | Redstone Bancorp Group                | 2011-06-06       | 2020-10-16      | true        |
| ETT    |     9000500 | Granite Retail Group Group            | 2021-10-14       | 2026-07-31      | false       |
| GM     |     9000009 | General Motors Corporation (old GM)   | 2005-01-03       | 2009-06-01      | true        |
| GM     |     9000010 | Alder Aerospace Corp.                 | 2010-05-27       | 2026-07-31      | false       |
| ISS    |     9000091 | Dunmore Aerospace Inc.                | 2005-01-03       | 2013-10-23      | true        |
| ISS    |     9000503 | Cardinal Semiconductor Corp.          | 2014-10-21       | 2026-07-31      | false       |
| QPHC   |     9000320 | Yarrow Bancorp Group                  | 2008-11-18       | 2012-05-24      | true        |
| QPHC   |     9000501 | Ellsworth Energy Corp.                | 2013-05-24       | 2026-07-31      | false       |
| TTOR   |     9000165 | Junction Aerospace Co.                | 2005-01-03       | 2008-03-20      | true        |
| TTOR   |     9000502 | Kestrel Software Co.                  | 2009-03-18       | 2026-07-31      | false       |
| WB     |     9000007 | Wachovia Corporation                  | 2005-01-03       | 2008-12-31      | true        |
| WB     |     9000008 | Harlow Software Corp.                 | 2009-12-29       | 2026-07-31      | false       |
| WM     |     9000003 | Washington Mutual, Inc.               | 2005-01-03       | 2008-09-25      | true        |
| WM     |     9000004 | Alder Resources Corp.                 | 2009-09-23       | 2026-07-31      | false       |

## PASS · Prices stay inside the entity's listing window

`pit_prices_within_listing_window` · blocking

All 1,298,746 price rows sit inside their entity's listing window (± 3 calendar days for boundary conventions).

**listing-window coverage**

| metric                       |   value |
| ---------------------------- | ------: |
| price rows checked           | 1298746 |
| rows before first_price_date |       0 |
| rows after last_price_date   |       0 |
| entities affected            |       0 |
| tolerance (calendar days)    |       3 |

## PASS · Adjusted and as-traded closes are genuinely different series

`pit_unadjusted_prices_available` · blocking

The two closes differ on 705,618 of 1,298,746 rows (54.331%) and across 284 of 505 entities; median gap 17.01%.

**Findings**

- **PASS** — Corporate events located.
  _splits from prices.split_factor; dividends from prices.dividends_

**adjusted vs as-traded divergence**

| metric                                    | value   |
| ----------------------------------------- | ------- |
| rows with both closes                     | 1298746 |
| rows where they differ                    | 705618  |
| entities priced                           | 505     |
| entities where they ever differ           | 284     |
| median gap on differing rows (%)          | 17.0112 |
| p95 gap on differing rows (%)             | 900.0   |
| max gap (%)                               | 900.0   |
| entities with a split                     | 82      |
| split entities that never diverge         | 0       |
| dividend-only entities                    | 202     |
| dividend-only entities that never diverge | 0       |

## PASS · Names that stopped trading have a corporate action to explain it

`pit_delisting_action_coverage` · advisory

A terminal action is on file for all 297 names that stopped trading inside the window.

**delisting coverage**

| metric                                         | value       |
| ---------------------------------------------- | ----------- |
| entities whose last price is inside the window | 297         |
| with a terminal action on file                 | 297         |
| coverage (%)                                   | 100.0       |
| matched by                                     | permaticker |
| terminal action rows seen                      | 298         |
| terminal actions carrying a reason             | 298         |
| tail buffer (calendar days)                    | 30          |

## PASS · Prices are positive and each bar is internally consistent

`quality.nonpositive_prices` · blocking

All 1,298,746 bars are positive and self-consistent.

**Findings**

- **PASS** — No nonpositive, inverted or out-of-band bars.

## PASS · Price dates are real NYSE sessions, and sessions are populated

`quality.calendar_alignment` · blocking

All 5,428 price dates are NYSE sessions; 100.00% of the 5,428 sessions in range are populated.

**Findings**

- **PASS** — No price rows on non-session dates.

**Session coverage**

| sessions_in_range | sessions_with_rows | sessions_with_no_rows | coverage_pct | distinct_price_dates |
| ----------------: | -----------------: | --------------------: | -----------: | -------------------: |
|              5428 |               5428 |                     0 |          100 |                 5428 |

## PASS · One bar per entity-day (and symbol collisions are not that)

`quality.duplicate_bars` · blocking

No duplicate entity-days; 0 row(s) share a (ticker, date) with a different company, which is expected.

**Findings**

- **PASS** — No symbol collisions in the audited range.

## PASS · Bars represent trades, not carried-forward quotes

`quality.zero_volume` · advisory

3,888 of 1,298,746 bars (0.299%) print zero volume; 0 carry no volume at all.

**Findings**

- **PASS** — Zero-volume bars are 0.299% of the panel, inside the 2% tolerance.

**Zero-volume bars by year**

| year |  bars | zero_volume | no_volume | zero_pct |
| ---: | ----: | ----------: | --------: | -------: |
| 2005 | 67823 |         235 |         0 |     0.35 |
| 2006 | 66637 |         170 |         0 |     0.26 |
| 2007 | 66079 |         227 |         0 |     0.34 |
| 2008 | 65106 |         195 |         0 |     0.30 |
| 2009 | 61220 |         198 |         0 |     0.32 |
| 2010 | 60304 |         188 |         0 |     0.31 |
| 2011 | 60704 |         181 |         0 |     0.30 |
| 2012 | 59595 |         158 |         0 |     0.27 |
| 2013 | 59890 |         174 |         0 |     0.29 |
| 2014 | 60637 |         155 |         0 |     0.26 |
| 2015 | 60191 |         184 |         0 |     0.31 |
| 2016 | 60716 |         170 |         0 |     0.28 |
| 2017 | 60646 |         198 |         0 |     0.33 |
| 2018 | 59815 |         173 |         0 |     0.29 |
| 2019 | 60189 |         197 |         0 |     0.33 |
| 2020 | 60125 |         209 |         0 |     0.35 |
| 2021 | 59148 |         165 |         0 |     0.28 |
| 2022 | 57782 |         175 |         0 |     0.30 |
| 2023 | 55127 |         149 |         0 |     0.27 |
| 2024 | 53885 |         167 |         0 |     0.31 |
| 2025 | 52797 |         149 |         0 |     0.28 |
| 2026 | 30330 |          71 |         0 |     0.23 |

**Names with the most zero-volume bars**

| permaticker | ticker | bars | zero_volume | zero_pct |
| ----------: | ------ | ---: | ----------: | -------: |
|     9000225 | NVO    |   83 |           1 |      1.2 |
|     9000143 | CEO    |  945 |          10 |      1.1 |
|     9000118 | BYL    |   87 |           1 |      1.1 |
|     9000479 | AYN    |  805 |           8 |      1.0 |
|     9000046 | BDX    |  302 |           3 |      1.0 |
|     9000139 | KKC    |  470 |           4 |      0.9 |
|     9000171 | UXMG   |  458 |           4 |      0.9 |
|     9000150 | GZHF   |  113 |           1 |      0.9 |
|     9000011 | DELL   | 2222 |          18 |      0.8 |
|     9000063 | RQY    |  239 |           2 |      0.8 |
|     9000330 | KPE    |  264 |           2 |      0.8 |
|     9000483 | ZHDU   |  119 |           1 |      0.8 |
|     9000151 | GGFM   |  898 |           6 |      0.7 |
|     9000167 | AND    |  837 |           6 |      0.7 |
|     9000464 | LMFV   |  914 |           6 |      0.7 |

## PASS · Adjusted and unadjusted returns agree away from corporate actions

`quality.adjustment_consistency` · blocking

0 of 1,260,598 action-free session pairs (0.000%) show adjusted and unadjusted returns disagreeing beyond rounding, across 0 name(s). Sampled 500 of 505 names, taken as an evenly-spaced stride over the sorted permatickers.

**Findings**

- **PASS** — The two series agree on all 1,260,598 action-free session pairs compared (500 of 505 names, taken as an evenly-spaced stride over the sorted permatickers).

**How this was sampled**

| names_in_panel | names_compared | method                        | session_pairs_compared | pairs_skipped_next_to_an_action | tolerance                                   |
| -------------: | -------------: | ----------------------------- | ---------------------: | ------------------------------: | ------------------------------------------- |
|            505 |            500 | even stride over permatickers |                1260598 |                           20263 | 2bp + half-cent rounding on all four prices |

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
