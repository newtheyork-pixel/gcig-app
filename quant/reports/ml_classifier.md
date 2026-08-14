# The uncertainty-gated classifier

_2005-01-03 to 2026-07-31 (5,407 labelled sessions, 28 funds); out-of-sample trading 2010-01-04 to 2026-07-01._

**Neither model produced a book worth holding.** Every gated strategy here is beaten by both benchmarks on the same engine, the same settlement and the same costs: GBM scored 0.536 out of sample against a 0.500 base rate and returned +0.28% a year; LSTM scored 0.524 out of sample against a 0.500 base rate and returned -0.13% a year. Both AUCs sit at or under what a lookup table of per-fund training base rates scores on the same rows, so what little ordering there is looks like fund identity rather than timing.

## What this is, and what it was expected to say

A reproduction of a YouTube project that trains an LSTM to predict whether a forward return clears a threshold and trades only when the model is confident. The source reported a validation AUC drifting from 0.60 to 0.50 over twenty-five epochs while training AUC climbed, a backtest that "appears to be basically a random guess", and a universe of "random tickers that exist today" — which is a survivorship-biased sample and the reason this version trades ETFs. **The expected result here is an AUC near 0.50, and that is a measurement rather than a failure.** Nothing was tuned toward a better number; every window, hyperparameter and threshold is a prior written down in `griffinquant/ml/*.py` before a fold had been scored.

**GBM**: fold AUCs 0.544, 0.492, 0.541, 0.557, 0.526, 0.579 against a base rate of 0.500 held there by construction; pooled out-of-sample AUC 0.536. Mean per-date rank IC +0.0506 (95% interval +0.0078 to +0.0935 once the 21-session window overlap is charged for), t +2.32. A single sorted column — picked and signed after seeing the fold — matched or beat the whole ensemble in 5 of 6 folds. A lookup table of per-fund training base rates — no feature, no date, no market state — scores 0.552 on the same rows, so the model is -0.012 on top of knowing nothing but which fund this is.

**LSTM**: fold AUCs 0.511, 0.489, 0.525, 0.559, 0.509, 0.571 against a base rate of 0.500 held there by construction; pooled out-of-sample AUC 0.524. Mean per-date rank IC +0.0319 (95% interval -0.0117 to +0.0755 once the 21-session window overlap is charged for), t +1.44. A lookup table of per-fund training base rates — no feature, no date, no market state — scores 0.543 on the same rows, so the model is -0.016 on top of knowing nothing but which fund this is.

**The gate**: GBM stood aside on 12.9% of dates and held 62% of NAV on average; LSTM stood aside on 24.4% of dates and held 58% of NAV on average.

**Through the engine**, on identical costs: HistGradientBoosting x10 (date bootstrap), uncertainty-gated +0.28% a year at a Sharpe of -0.27, LSTM h16 lookback 60, 3 seeds, uncertainty-gated -0.13% a year at a Sharpe of -0.21, Buy and hold SPY +13.87% a year at a Sharpe of 0.77, Equal weight of the universe, rebalanced daily +8.73% a year at a Sharpe of 0.65.

## The sample

|                          |                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universe                 | 28 US-listed ETFs, `ml/universe.py`                                                                                                                                                                                                                                                                                                                                                                                           |
| Source                   | Tiingo daily EOD (ETF universe, 28 funds)                                                                                                                                                                                                                                                                                                                                                                                     |
| Cache                    | /Users/thomasseirer/repos/gcig-app/quant/data/cache                                                                                                                                                                                                                                                                                                                                                                           |
| Report                   | /Users/thomasseirer/repos/gcig-app/quant/reports/ml_classifier.md                                                                                                                                                                                                                                                                                                                                                             |
| Tree                     | 10 bootstrap members over dates, 200 iterations, 8 leaves, learning rate 0.05, L2 1, early stopping OFF (its default splits a date across the seam)                                                                                                                                                                                                                                                                           |
| Net                      | one LSTM layer, 16 hidden units, 60-session lookback, 3 seeds, at most 40 epochs with patience 5, epoch chosen on the last 20% of the training window; ran on cpu                                                                                                                                                                                                                                                             |
| Bill series              | FRED DGS3MO, the 3-month constant-maturity bill yield, annualised and converted geometrically to a per-session hurdle (0.00%-5.63% across the pull)                                                                                                                                                                                                                                                                           |
| Feature warmup           | 2 years before the study start, so a 252-session feature is complete on day one and no label is built from it                                                                                                                                                                                                                                                                                                                 |
| Label                    | beat the cross-sectional median forward return over 21 sessions                                                                                                                                                                                                                                                                                                                                                               |
| Base rate                | 0.5000 — one half by construction, which is what makes every accuracy below readable                                                                                                                                                                                                                                                                                                                                          |
| Rows                     | 149,706 labelled (date, fund) pairs over 5,407 sessions                                                                                                                                                                                                                                                                                                                                                                       |
| Independent observations | 149,706 rows are not 149,706 observations. A 21-session window at daily frequency overlaps the next by 20, so 5,407 dates carry 257 non-overlapping windows; 28 assets amount to 6.5 distinct series once their shared movement is taken out. Call it 1,680 independent observations, and treat that as an upper bound — it assumes one month's window tells you nothing about the next, and regimes run longer than a month. |
| Folds                    | 6 walk-forward, expanding training, refit every 3 years after 5 years of history, 21-session purge at every seam                                                                                                                                                                                                                                                                                                              |
| Trials on file           | 22 distinct configurations                                                                                                                                                                                                                                                                                                                                                                                                    |

### What was dropped, and why

| Labelled | No complete window | Thin cross-section | Exactly at the median | Positives | Base rate |
| -------: | -----------------: | -----------------: | --------------------: | --------: | --------: |
|  149,706 |                588 |                  0 |                   513 |    74,853 |    0.5000 |

The vendor's coverage does not begin on every fund's stated inception. Reported rather than fatal — a fund whose bars start late contributes nothing to a cross-sectional rank until they do, which is the correct behaviour and not a silent one:

| Fund | Finding          | Stated inception | First bar served | Gap (days) |
| ---- | ---------------- | ---------------: | ---------------: | ---------: |
| SPY  | data_starts_late |       1993-01-22 |       1993-01-29 |          7 |
| RSP  | data_starts_late |       2003-04-24 |       2003-04-30 |          6 |
| XLE  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLF  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLK  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLV  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLI  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLP  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLY  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLU  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| XLB  | data_starts_late |       1998-12-16 |       1998-12-22 |          6 |
| EWJ  | data_starts_late |       1996-03-12 |       1996-04-01 |         20 |
| EEM  | data_starts_late |       2003-04-07 |       2003-04-14 |          7 |
| HYG  | data_starts_late |       2007-04-04 |       2007-04-11 |          7 |
| SLV  | data_starts_late |       2006-04-21 |       2006-04-28 |          7 |
| VNQ  | data_starts_late |       2004-09-23 |       2004-09-29 |          6 |

## Per-fold AUC, with the base rate beside it

One row per fold and no pooled mean, because a mean over a trajectory is the summary that erases the trajectory. The base rate is 0.500 on every fold by construction, so an accuracy is readable against the majority column directly. `z` is the distance from a coin flip in standard errors already widened by the square root of the horizon for the overlap between consecutive label windows — and still generous, because the cross-section is not independent either: 28 funds amount to about 6.5 distinct series.

### HistGradientBoosting x10 (date bootstrap)

| Fold | Test window             |   Rows |  Base |   AUC |    z |   Acc | Majority | Identity | Best single column |   Edge | Rank IC | t (adj) |
| ---: | ----------------------- | -----: | ----: | ----: | ---: | ----: | -------: | -------: | ------------------ | -----: | ------: | ------: |
|    1 | 2010-01-04 → 2013-01-02 | 21,140 | 0.500 | 0.544 | +2.4 | 0.534 |    0.500 |    0.514 | vol_3m 0.537       | +0.007 | +0.0599 |   +1.07 |
|    2 | 2013-01-03 → 2015-12-31 | 21,140 | 0.500 | 0.492 | -0.4 | 0.499 |    0.500 |    0.490 | mom_12_1_xs 0.629  | -0.136 | -0.0265 |   -0.61 |
|    3 | 2016-01-04 → 2019-01-02 | 21,140 | 0.500 | 0.541 | +2.3 | 0.520 |    0.500 |    0.579 | vol_3m_xs 0.559    | -0.018 | +0.0523 |   +0.91 |
|    4 | 2019-01-03 → 2021-12-31 | 21,168 | 0.500 | 0.557 | +3.1 | 0.540 |    0.500 |    0.626 | vol_3m 0.566       | -0.009 | +0.0875 |   +1.88 |
|    5 | 2022-01-03 → 2025-01-02 | 21,112 | 0.500 | 0.526 | +1.4 | 0.520 |    0.500 |    0.546 | ret_3m_xs 0.544    | -0.018 | +0.0484 |   +0.99 |
|    6 | 2025-01-03 → 2026-07-01 | 10,444 | 0.500 | 0.579 | +3.1 | 0.567 |    0.500 |    0.556 | vol_3m_xs 0.591    | -0.012 | +0.1145 |   +1.59 |

walk_forward: fold AUCs 0.544, 0.492, 0.541, 0.557, 0.526, 0.579 (mean 0.540, 0.544 in the first fold to 0.579 in the last). Test base rate runs 0.500-0.500, so accuracy is readable only against the majority column beside it. 4 of 6 folds sit more than two standard errors from 0.500 (largest +3.1). Before reading that as signal, check the importance table: a cross-sectional rank that barely moves for a given name is a name dummy, and a model that has learned which funds beat the median over this particular sample has learned the sample. Mean per-date rank IC +0.0560 across 6 folds. In 5 of 6 folds a single sorted column — picked and signed after seeing the fold — matches or beats the ensemble, so the right comparison is not against 0.500. Importance is near-uniform in 2 of 6 folds: attention spread evenly over the columns is what fitting noise looks like.

Pooled out-of-sample: AUC 0.5357 on 116,144 rows. Mean per-date rank IC +0.0506 over 4,148 dates, standard deviation 0.3073; the 95% interval is +0.0078 to +0.0935 once the 21-session overlap is charged for, against +0.0413 to +0.0600 if the overlapping windows were treated as independent draws — which is the mistake that makes a weak IC look decisive.

### LSTM h16 lookback 60, 3 seeds

| Fold |   Rows |  Base |   AUC | Identity |   Over |   Acc | Majority | Inner val | Best epoch | Rank IC | t (adj) |
| ---: | -----: | ----: | ----: | -------: | -----: | ----: | -------: | --------: | ---------: | ------: | ------: |
|    1 | 21,140 | 0.500 | 0.511 |    0.499 | +0.012 | 0.500 |    0.500 |     0.514 |        1.0 | +0.0161 |   +0.26 |
|    2 | 21,140 | 0.500 | 0.489 |    0.463 | +0.026 | 0.500 |    0.500 |     0.526 |        7.7 | -0.0418 |   -0.93 |
|    3 | 21,140 | 0.500 | 0.525 |    0.569 | -0.044 | 0.521 |    0.500 |     0.562 |        3.7 | +0.0399 |   +0.76 |
|    4 | 21,168 | 0.500 | 0.559 |    0.625 | -0.066 | 0.537 |    0.500 |     0.536 |        2.0 | +0.0991 |   +1.95 |
|    5 | 21,112 | 0.500 | 0.509 |    0.541 | -0.031 | 0.509 |    0.500 |     0.555 |        2.0 | +0.0203 |   +0.43 |
|    6 | 10,444 | 0.500 | 0.571 |    0.563 | +0.008 | 0.566 |    0.500 |     0.536 |        1.7 | +0.0844 |   +1.24 |

6 walk_forward folds, test AUC 0.527 (per fold 0.511, 0.489, 0.525, 0.559, 0.509, 0.571); accuracy 52.2% against a base rate of 50.0%.  
A lookup table of per-fund training base rates scores 0.543 on the same rows, so the model is -0.016 on top of knowing nothing but which fund this is — which is to say it has learned identity, not timing.  
149,706 rows at a 21-session horizon are about 7,129 non-overlapping observations, and about 1,680 once the cross-section's shared movement is taken out. The model holds 2,257 parameters: the 2,257 parameters OUTNUMBER the 1,680 observations the label module counts. Memorisation is not a risk here, it is the arithmetic: a training curve that climbs while validation sags is the expected picture.  
Across the run training AUC moved +0.122 and validation -0.024: training AUC climbed while validation fell — the divergence the capacity arithmetic predicts.  
Trained on cpu; predictions are the mean of 3 seeds and the spread across them measures how stable the fit is, not how likely it is to be right.

Pooled out-of-sample: AUC 0.5236 on 116,144 rows. Mean per-date rank IC +0.0319 over 4,148 dates, standard deviation 0.3125; the 95% interval is -0.0117 to +0.0755 once the 21-session overlap is charged for, against +0.0224 to +0.0414 if the overlapping windows were treated as independent draws — which is the mistake that makes a weak IC look decisive.

## The epoch curves

The chart the source project's finding actually lived in: training AUC against inner-validation AUC, epoch by epoch, averaged over seeds within a fold and never across folds. The validation slice is the tail of the TRAINING window, purged of every row whose label reaches into it — the test fold is scored exactly once, at the epoch this slice chose, because "train with early stopping on validation" and "report the validation AUC" together mean the reported number was a maximum over forty draws.

_149,706 rows at a 21-session horizon are about 7,129 non-overlapping observations, and about 1,680 once the cross-section's shared movement is taken out. The model holds 2,257 parameters: the 2,257 parameters OUTNUMBER the 1,680 observations the label module counts. Memorisation is not a risk here, it is the arithmetic: a training curve that climbs while validation sags is the expected picture._

| Fold | Epoch | Train loss | Val loss | Train AUC | Val AUC |    Gap |
| ---: | ----: | ---------: | -------: | --------: | ------: | -----: |
|    1 |     1 |     0.6897 |   0.6934 |     0.585 |   0.514 | +0.071 |
|    1 |     2 |     0.6783 |   0.7131 |     0.627 |   0.445 | +0.181 |
|    1 |     3 |     0.6655 |   0.7552 |     0.661 |   0.418 | +0.243 |
|    1 |     4 |     0.6502 |   0.7780 |     0.681 |   0.418 | +0.263 |
|    1 |     5 |     0.6371 |   0.8041 |     0.710 |   0.413 | +0.297 |
|    1 |     6 |     0.6284 |   0.8262 |     0.721 |   0.409 | +0.312 |
|    2 |     1 |     0.6867 |   0.7048 |     0.593 |   0.489 | +0.105 |
|    2 |     2 |     0.6777 |   0.7116 |     0.619 |   0.492 | +0.127 |
|    2 |     3 |     0.6685 |   0.7171 |     0.648 |   0.499 | +0.148 |
|    2 |     4 |     0.6567 |   0.7353 |     0.676 |   0.501 | +0.175 |
|    2 |     5 |     0.6430 |   0.7559 |     0.697 |   0.509 | +0.188 |
|    2 |     6 |     0.6319 |   0.7626 |     0.720 |   0.517 | +0.203 |
|    2 |     7 |     0.6220 |   0.7773 |     0.729 |   0.518 | +0.210 |
|    2 |     8 |     0.6126 |   0.7951 |     0.743 |   0.525 | +0.218 |
|    2 |     9 |     0.6062 |   0.8014 |     0.746 |   0.517 | +0.228 |
|    2 |    10 |     0.6006 |   0.8155 |     0.758 |   0.519 | +0.240 |
|    2 |    11 |     0.5940 |   0.8170 |     0.765 |   0.522 | +0.244 |
|    2 |    12 |     0.5882 |   0.8214 |     0.762 |   0.524 | +0.238 |
|    2 |    13 |     0.5874 |   0.8363 |     0.775 |   0.523 | +0.252 |
|    3 |     1 |     0.6869 |   0.6934 |     0.595 |   0.543 | +0.052 |
|    3 |     2 |     0.6767 |   0.6974 |     0.624 |   0.550 | +0.074 |
|    3 |     3 |     0.6666 |   0.6996 |     0.656 |   0.556 | +0.101 |
|    3 |     4 |     0.6532 |   0.7164 |     0.675 |   0.558 | +0.117 |
|    3 |     5 |     0.6458 |   0.7240 |     0.689 |   0.544 | +0.145 |
|    3 |     6 |     0.6376 |   0.7334 |     0.700 |   0.543 | +0.157 |
|    3 |     7 |     0.6318 |   0.7435 |     0.708 |   0.539 | +0.169 |
|    3 |     8 |     0.6272 |   0.7519 |     0.716 |   0.537 | +0.179 |
|    3 |     9 |     0.6204 |   0.7595 |     0.728 |   0.538 | +0.189 |
|    4 |     1 |     0.6864 |   0.6947 |     0.594 |   0.535 | +0.059 |
|    4 |     2 |     0.6765 |   0.7039 |     0.624 |   0.524 | +0.100 |
|    4 |     3 |     0.6667 |   0.7147 |     0.644 |   0.521 | +0.123 |
|    4 |     4 |     0.6578 |   0.7189 |     0.667 |   0.524 | +0.143 |
|    4 |     5 |     0.6501 |   0.7269 |     0.674 |   0.520 | +0.155 |
|    4 |     6 |     0.6446 |   0.7383 |     0.689 |   0.519 | +0.170 |
|    4 |     7 |     0.6372 |   0.7457 |     0.704 |   0.527 | +0.176 |
|    4 |     8 |     0.6316 |   0.7536 |     0.711 |   0.523 | +0.189 |
|    4 |     9 |     0.6244 |   0.7637 |     0.713 |   0.519 | +0.194 |
|    5 |     1 |     0.6863 |   0.6895 |     0.590 |   0.549 | +0.041 |
|    5 |     2 |     0.6778 |   0.6921 |     0.618 |   0.555 | +0.063 |
|    5 |     3 |     0.6692 |   0.6982 |     0.645 |   0.548 | +0.097 |
|    5 |     4 |     0.6610 |   0.7084 |     0.659 |   0.541 | +0.118 |
|    5 |     5 |     0.6544 |   0.7177 |     0.672 |   0.534 | +0.137 |
|    5 |     6 |     0.6487 |   0.7230 |     0.682 |   0.536 | +0.147 |
|    5 |     7 |     0.6433 |   0.7290 |     0.688 |   0.538 | +0.150 |
|    6 |     1 |     0.6864 |   0.6924 |     0.587 |   0.532 | +0.055 |
|    6 |     2 |     0.6789 |   0.6957 |     0.609 |   0.534 | +0.075 |
|    6 |     3 |     0.6721 |   0.7032 |     0.632 |   0.525 | +0.106 |
|    6 |     4 |     0.6666 |   0.7142 |     0.644 |   0.522 | +0.122 |
|    6 |     5 |     0.6600 |   0.7288 |     0.661 |   0.514 | +0.147 |
|    6 |     6 |     0.6552 |   0.7385 |     0.666 |   0.517 | +0.149 |
|    6 |     7 |     0.6509 |   0.7507 |     0.675 |   0.517 | +0.158 |

## The gate: how often the rule chose to do nothing

The decision rule subtracts 1 standard deviation(s) of member disagreement from each probability and acts only where the result clears 0.55. Both numbers are priors fixed in `ml/decide.py` before any of the above existed. Survivors are equal-weighted at `min(0.25, 0.95/n)`, so one surviving fund is a 25% position and three-quarters cash, and nothing the rule can produce sums past 95% of NAV. **Being permitted to hold nothing is the whole design.** A do-nothing fraction near zero would mean the gate is not gating; near one, that this is an expensive way to hold cash. Both are findings and neither is a reason to move the threshold.

| Model | Dates | Acted on | Did nothing | Names when acting | Most names | Mean invested | Wanted to trade / day | Mean best adj. p |
| ----- | ----: | -------: | ----------: | ----------------: | ---------: | ------------: | --------------------: | ---------------: |
| GBM   | 4,148 |    3,613 |      12.90% |              3.66 |         13 |        62.24% |                31.26% |           0.5901 |
| LSTM  | 4,148 |    3,134 |      24.45% |              4.09 |         14 |        57.64% |                10.53% |           0.6005 |

- **GBM** — 3,613 of 4,148 dates carried a position (12.9% stood aside). On an acting date the book held 3.7 names on average and 62.2% of NAV was invested across all dates, against a 95% ceiling.
- **LSTM** — 3,134 of 4,148 dates carried a position (24.4% stood aside). On an acting date the book held 4.1 names on average and 57.6% of NAV was invested across all dates, against a 95% ceiling.

## The backtest, through the real engine

Decided at a close, filled at the next open out of settled cash under T+1, charged a liquidity-scaled spread and a square-root impact term, whole shares, a 5%-of-NAV daily turnover budget and a 5% cash buffer. Both benchmarks run on the same engine with the same settlement and the same cost model — a strategy compared against a costless index is being compared against something nobody could hold.

| Book                                                         |    CAGR |    Vol | Sharpe | Deflated | Hurdle SR |  Max DD | Turnover | Cost drag |
| ------------------------------------------------------------ | ------: | -----: | -----: | -------: | --------: | ------: | -------: | --------: |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated |  +0.28% |  4.05% |  -0.27 |    0.001 |      0.48 | -13.80% |    11.35 |  20.7 bps |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             |  -0.13% |  6.48% |  -0.21 |    0.002 |      0.48 | -29.48% |     9.17 |  14.3 bps |
| Buy and hold SPY                                             | +13.87% | 16.73% |   0.77 |    0.881 |      0.48 | -33.23% |     0.02 |   0.1 bps |
| Equal weight of the universe, rebalanced daily               |  +8.73% | 11.73% |   0.65 |    0.751 |      0.48 | -25.82% |     0.15 |   0.4 bps |

The deflated Sharpe is deflated by **22 distinct configurations** on file across this whole project, not by the four books above: a search does not become smaller by being spread over several files. Correlated variants of one idea are not that many independent trials, so the count overstates N — which RAISES the hurdle, and being conservative in that direction is the only defensible way to be wrong about a denominator we chose ourselves.

### Where the money went

| Book                                                         | Fills |    Spread |  Impact | Total cost | Deferrals |  Deferred $ | Postponed: cash | Postponed: budget |
| ------------------------------------------------------------ | ----: | --------: | ------: | ---------: | --------: | ----------: | --------------: | ----------------: |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated | 5,393 | $3,574.48 | $958.98 |  $4,533.46 |         0 |       $0.00 |           $0.00 |   $259,669,409.56 |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             | 4,571 | $2,312.61 | $625.25 |  $2,937.87 |        31 |  $64,420.25 |      $64,406.06 |   $153,262,304.85 |
| Buy and hold SPY                                             |    20 |    $70.21 |  $30.85 |    $101.05 |         1 |      $67.81 |          $67.80 |     $1,133,803.98 |
| Equal weight of the universe, rebalanced daily               |   432 |   $153.84 |  $42.48 |    $196.32 |       513 | $557,895.12 |     $557,745.19 |     $1,109,265.81 |

The postponed columns are FLOWS, not stocks: every session the engine restates what the strategy asked for and books whatever the budget would not cover, so a book that wants a different set of funds every morning accumulates a postponed figure many times its own NAV without a dollar of it ever being a position. Read it beside the gate's "wanted to trade" column, which is the same instability measured before any constraint. HistGradientBoosting x10 (date bootstrap), uncertainty-gated: the 5%-of-NAV daily turnover budget bound on 3,697 of 4,148 sessions; LSTM h16 lookback 60, 3 seeds, uncertainty-gated: the 5%-of-NAV daily turnover budget bound on 3,029 of 4,148 sessions; Buy and hold SPY: the 5%-of-NAV daily turnover budget bound on 19 of 4,148 sessions; Equal weight of the universe, rebalanced daily: the 5%-of-NAV daily turnover budget bound on 18 of 4,148 sessions.

That constraint is a fact about the account rather than a modelling choice, and it cuts the strategy's way: what is measured above is the rule as a $131,000 cash account could actually implement it. The unconstrained version would have traded more and therefore paid more.

### Drawdowns

| Book                                                         | Max drawdown |       Peak |     Trough | Recovery                                                 |
| ------------------------------------------------------------ | -----------: | ---------: | ---------: | -------------------------------------------------------- |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated |      -13.80% | 2011-07-22 | 2020-05-13 | 1,442 sessions (2,098 days)                              |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             |      -29.48% | 2014-07-23 | 2016-01-20 | not recovered — 3,002 sessions (4,361 days) and counting |
| Buy and hold SPY                                             |      -33.23% | 2020-02-19 | 2020-03-23 | 97 sessions (140 days)                                   |
| Equal weight of the universe, rebalanced daily               |      -25.82% | 2020-02-19 | 2020-03-23 | 93 sessions (134 days)                                   |

### Named windows

| Book                                                         | Window       |   Return | Sharpe |  Max DD |
| ------------------------------------------------------------ | ------------ | -------: | -----: | ------: |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated | 2018Q4       |   -3.88% |  -3.68 |  -5.18% |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated | 2020Q1       |   -5.10% |  -3.45 |  -5.55% |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated | 2022         |   -0.40% |  -0.55 |  -3.68% |
| HistGradientBoosting x10 (date bootstrap), uncertainty-gated | 2023-present |   +5.11% |  -0.61 |  -6.35% |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             | 2018Q4       |   -2.25% |  -1.83 |  -4.19% |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             | 2020Q1       |   -8.33% |  -1.81 | -12.64% |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             | 2022         |   -2.43% |  -0.87 |  -5.33% |
| LSTM h16 lookback 60, 3 seeds, uncertainty-gated             | 2023-present |   +3.26% |  -0.59 | -12.50% |
| Buy and hold SPY                                             | 2018Q4       |  -13.30% |  -2.44 | -18.88% |
| Buy and hold SPY                                             | 2020Q1       |  -19.14% |  -1.35 | -33.23% |
| Buy and hold SPY                                             | 2022         |  -18.00% |  -0.80 | -24.26% |
| Buy and hold SPY                                             | 2023-present | +102.74% |   1.12 | -18.62% |
| Equal weight of the universe, rebalanced daily               | 2018Q4       |   -7.25% |  -2.36 | -10.71% |
| Equal weight of the universe, rebalanced daily               | 2020Q1       |  -16.33% |  -1.78 | -25.82% |
| Equal weight of the universe, rebalanced daily               | 2022         |   -9.30% |  -0.70 | -16.56% |
| Equal weight of the universe, rebalanced daily               | 2023-present |  +58.61% |   0.91 | -10.62% |

## What the tree paid attention to

Permutation importance, shuffled WITHIN each date: a global shuffle would also move a 2008 volatility reading onto a 2017 row, and the AUC drop would then be partly the model noticing the value is out of era — a fact about the calendar credited to the feature. The bill rate cannot be permuted this way at all because it does not vary across the cross-section, and it comes back unmeasured rather than as a zero that would sit in the table looking like a finding.

| Feature           | Mean AUC lost when shuffled | Share | Folds |
| ----------------- | --------------------------: | ----: | ----: |
| vol_1m_xs         |                     0.01257 | 21.9% |     6 |
| mom_12_1          |                     0.00804 |  9.6% |     6 |
| vol_1m            |                     0.00625 | 10.7% |     6 |
| vol_3m            |                     0.00547 |  9.6% |     6 |
| trend_200_xs      |                     0.00258 |  5.6% |     6 |
| ret_3m_xs         |                     0.00242 |  4.0% |     6 |
| ret_3m            |                     0.00167 |  3.4% |     6 |
| vol_3m_xs         |                     0.00142 |  4.6% |     6 |
| turnover_surge_xs |                     0.00066 |  2.3% |     6 |
| ret_1m_xs         |                     0.00005 |  1.0% |     6 |
| ret_1m            |                     0.00002 |  0.7% |     6 |
| turnover_surge    |                    -0.00017 |  1.8% |     6 |
| drawdown_252      |                    -0.00215 |  3.1% |     6 |
| drawdown_252_xs   |                    -0.00234 |  4.3% |     6 |
| mom_12_1_xs       |                    -0.00305 |  6.8% |     6 |
| trend_200         |                    -0.00320 | 10.6% |     6 |
| bill_rate         |                           — |     — |     6 |

Importance is flagged near-uniform in **2 of 6 folds**. Attention spread evenly over seventeen columns is not a well-balanced model; it is what fitting noise looks like, and it is the diagnostic the source project reported about its own features without following the thought through.

## The sceptic's log

Every check ran, whatever the numbers above came back as. A check that only fires on a good result is a check calibrated to find nothing — and on this problem the dangerous outcome is not a suspicious number, it is a plausible one.

| Check                                           |      | What was measured                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features at T survive truncation after T        | PASS | all 17 columns on every fund, recomputed on the panel cut at 2011-03-31, 2018-04-26, 2025-05-27: identical to the last bit                                                                                                                                                            |
| No label window crosses a fold seam             | PASS | 6 walk-forward folds, purge 21 sessions: 0 overlapping date(s), 0 inside the embargo, 0 row(s) on both sides of a seam, 0 training label window(s) reaching into a test fold                                                                                                          |
| GBM predictions are out of sample, scored once  | PASS | 116,144 rows across 6 folds; 0 duplicate (date, fund) pair(s) and 0 row(s) dated outside the test window of the fold that produced them                                                                                                                                               |
| LSTM predictions are out of sample, scored once | PASS | 116,144 rows across 6 folds; 0 duplicate (date, fund) pair(s) and 0 row(s) dated outside the test window of the fold that produced them                                                                                                                                               |
| LSTM windows reach only backward                | PASS | 147,984 of 149,706 targets carry a complete 60-session window ({'short_history': 204, 'gapped_history': 0, 'warming_up': 1518}); every window ends on its own decision date and none of them changed when the frame was truncated at 2025-05-27                                       |
| gbm: fills land at the NEXT open                | PASS | 5,393 fills, every one strictly after its decision (median lag 1 calendar day(s)) and priced at that session's own unadjusted open to the last bit                                                                                                                                    |
| lstm: fills land at the NEXT open               | PASS | 4,571 fills, every one strictly after its decision (median lag 1 calendar day(s)) and priced at that session's own unadjusted open to the last bit                                                                                                                                    |
| spy: fills land at the NEXT open                | PASS | 20 fills, every one strictly after its decision (median lag 1 calendar day(s)) and priced at that session's own unadjusted open to the last bit                                                                                                                                       |
| equal: fills land at the NEXT open              | PASS | 432 fills, every one strictly after its decision (median lag 1 calendar day(s)) and priced at that session's own unadjusted open to the last bit                                                                                                                                      |
| Positions are marked in total-return space      | PASS | every closing position marked at `close_adj`; across the panel 107,536 fund-days carry an adjusted close that differs from the as-traded one, on 26 of 28 funds. Measured panel-wide because back-adjustment anchors at the final bar, where the two agree everywhere by construction |
| Trading costs are charged inside the loop       | PASS | gbm $4,533.46 ($3,574.48 spread, $958.98 impact); lstm $2,937.87 ($2,312.61 spread, $625.25 impact); spy $101.05 ($70.21 spread, $30.85 impact); equal $196.32 ($153.84 spread, $42.48 impact)                                                                                        |
| Long only, and never above 100% of NAV          | PASS | decided weights peak at 25.0% in one fund and 95.0% gross against a 95% budget; the engine's realised book peaks at 95.0% of NAV with 0 negative weight(s)                                                                                                                            |
| No fold's out-of-sample AUC clears 0.60         | PASS | the highest single fold is 0.579                                                                                                                                                                                                                                                      |
| Every backtested session carried a decision     | PASS | 4,148 sessions from 2010-01-04 to 2026-07-01; unscored sessions per book: gbm 0, lstm 0                                                                                                                                                                                               |

## What this does not measure

- **The universe was chosen in 2026.** Twenty-eight funds that survived and grew, picked with full knowledge of which product lines gathered assets. That bias is far smaller than a single-name panel's — a closed ETF is wound up at NAV and its holders are paid out, where a delisted equity is usually a total loss — but it is not zero, and `ml/universe.py` names the two channels that survive.
- **Fourteen of the twenty-eight are US equity beta.** A cross-sectional rank here is, half the time, a rank within US equity sectors. These are not twenty-eight independent bets, and the correlation of the cross-section puts them at about 6.5 distinct series.
- **The uncertainty the gate reads is model variance and nothing else.** It answers how much the fitted function moves when the training sample is resampled, not whether these features carry any signal at all — which is the far larger uncertainty and is the question this study is asking. A tight ensemble around a coin flip is a well-fitted coin flip, and the gate will happily trade one.
- **One historical path.** Every fold is a slice of the same twenty-one years, the folds' test windows tile that path, and a test observation in the last month of one fold has a label window reaching into the next. No model sees its own answer, so this is not leakage — but consecutive folds' scores are not independent draws, and a run of good ones is worth less than it looks.
- **This is the second document to touch these folds.** If the priors above are ever moved in response to a number in this report, the out-of-sample stops being out of sample, and there is not a second twenty-one years waiting.

_Generated 2026-08-03 05:04 UTC by `run_ml.py`._
