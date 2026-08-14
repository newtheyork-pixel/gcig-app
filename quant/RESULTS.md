# Results

What this project measured, in plain language, for somebody who was not
here.

The question it was built to answer is whether a rules-based process can
beat holding the index, in this account, after costs — and whether any
number it produces can be trusted. Everything below is a figure some
script wrote to a report file; every table says which report, so the
number can be checked rather than believed. Nothing here was recomputed
for this document.

One convention worth knowing before the first table. A Sharpe ratio
printed on its own is not evidence, because the more configurations a
project tries, the higher the best one's Sharpe will be by luck alone.
The **Deflated Sharpe** (Bailey and López de Prado, 2014) is the
probability the result survives the number of looks taken, and it needs
a trial count to be computed at all. This repository keeps that count in
`trials.jsonl` and it has no reset method. Every Sharpe below carries
both.

---

## 1. The answer

### The best annualised return over the full sample is buy-and-hold SPY, at 10.69% a year

Over 2005-01-03 to 2026-07-31 — 5,427 sessions, 21.6 years — putting the
whole account in SPY on the first morning and never trading again
returned **10.69% a year**, at a Sharpe of **0.55**, and it lost
**53.18%** on the way. It took **869 sessions (1,256 days)** to get back
to its old high.

The best *published* strategy over the same horizon is `fundamental_prf`
(Arnott's fundamental indexation, held as PRF) at **10.35% a year** —
behind by 0.35 percentage points. Nothing in a library of thirty-three
published rules beat the index over a horizon long enough to ask the
question.

Three shorter records look better and are not an answer to a
fifteen-to-twenty-year question. `momentum_spmo` returned 19.67% a year
over **7.8 years**, and that window is mostly the 2018-2026 US equity
run. Ranking a 7.8-year record against a 21.6-year one on annualised
return is a question about which window contained a bull market.

_Source: `reports/post_publication_ledger.md`, "The two answers" and
"Full sample, at 1x cost"._

### Our own nine-sleeve book returned 5.35% a year and lost 9.69% at its worst

| | Griffin nine-sleeve book | Buy-and-hold SPY | 60/40 SPY/IEF, daily |
|---|---:|---:|---:|
| CAGR | **+5.35%** | +10.69% | +7.82% |
| Volatility | 5.99% | 18.29% | 10.29% |
| Sharpe | 0.61 | 0.55 | 0.61 |
| Deflated Sharpe (23 trials) | 0.800 | 0.723 | 0.810 |
| Max drawdown | **-9.69%** | -53.18% | -30.32% |
| Time to recover | 85 sessions (124 days) | 869 sessions (1,256 days) | 391 sessions (564 days) |
| Turnover /yr | 7.15 | 0.02 | 0.38 |
| Cost drag | 16.0 bps | 0.1 bps | 0.8 bps |

We gave up **5.34% a year** of return to take **43.49 points less
drawdown**. Whether that is a good trade is a mandate question — how
much of a 53% loss a student-run endowment sleeve can actually sit
through — and no statistic in this repository settles it.

What the table does *not* say is that we found an edge. The book's
Sharpe of 0.61 is the same 0.61 a daily-rebalanced 60/40 produced, on
the same engine and the same costs, with a twentieth of the turnover.
Deflated against 23 configurations it is 0.800, and 0.95 is the bar.
**Report it as insignificant, not as promising.**

_Source: `reports/stage3_sleeves.md` (headline, drawdown, turnover) and
`reports/post_publication_ledger.md` (deflated at the current trial
count)._

### The best risk-adjusted result in the whole library also fails the bar

`permanent_portfolio` (Harry Browne, 1981 — a quarter each in stocks,
long Treasuries, gold and cash) posted the highest Sharpe over the full
21.6 years: **0.73**, at 6.99% a year, 7.17% volatility and a 17.69%
worst drawdown. That beats our book and the 60/40 by 0.12.

Deflated against the 23 configurations on file it is **0.922** — below
the 95% bar. That is the number to quote if anybody asks whether it is
real.

_Source: `reports/post_publication_ledger.md`._

---

## 2. The study's finding

Every strategy in the library was measured twice: over the whole sample,
and over the stretch that begins **on the day its author published it**.
The second is the point of the exercise. A holdout is tape we set aside
and can peek at whenever we lose our nerve; a publication date was fixed
by a stranger, in a document, years before this repository existed.

**Across 30 dated strategies measured from their own publication dates
forward, the mean excess return over buy-and-hold SPY is -4.03% a year
(95% interval -5.39% to -2.67%). The median is -3.21%. Three of thirty
beat SPY.**

The three that did: `momentum_mtum` (+1.29%), `momentum_spmo` (+4.72%),
`quality_sphq` (+0.03%). One of those margins is three basis points.

The sign count — 3 of 30 — is the robust statement, and it is the one to
quote. The interval around the mean is computed across strategies as
though the records were independent draws, and they are not: most run
over the same calendar decade and most are long equity beta with a rule
on top, so one bad year for that beta moves most of the rows together.
**The interval is narrower than the truth and is offered as a lower
bound on the uncertainty**, not as a confidence statement.

### Against the published priors

**McLean and Pontiff (2016)** found published anomalies decay 58% after
publication. On the 12 strategies here with a record on both sides of
their own publication date, the mean excess over SPY went from **-0.26%
a year before to -7.27% a year after — a change of -7.00%.**

No decay *ratio* is quoted, and the reason is arithmetic rather than
editorial: 1 − after/before against a denominator at or below zero
inverts, so a rule that fell further behind would be reported as having
improved. What the two levels say instead is that this library roughly
**matched** the index before publication and trailed it by 7.27% a year
after. A percentage decay needs an edge to take a percentage of, and
there was not one.

**Huang, Song and Xiang (2021)** found +2.77% in backtest becoming
-0.44% live. We reproduce the pattern: -4.03% a year post-publication,
median -3.21%, 3 of 30 positive. The average published strategy in this
library does not beat holding the index once the index is charged the
same frictions.

_Source: `reports/post_publication_ledger.md`, "Does the library decay
after publication?" and "Against the priors"._

---

## 3. Survivorship, which we assumed away and then measured

Every result above rests on a panel of ETFs that a person wrote down in
2026 by looking at funds that still trade. That is survivorship bias,
and for most of this project the honest answer to "how big is it?" was
"unknowable without the data" — because delistings are a mix of
takeovers (which help) and failures (which hurt), and the sign cannot be
argued from first principles.

The data now exists. Tiingo's directory carries dead ETFs — **2,069 of
7,747 tradable ETF rows (26.7%) ended at a date in the past, and the
price endpoint still serves their full history.** Our hand-written list
was **0 of 142 dead, against a shelf that is 25.1% dead.** The bias was
ours, not the vendor's.

**The answer is positive, and it is small.**

| Window | Equal-weight bias, /yr | 95% interval |
|---|---:|---:|
| Whole sample (5,427 sessions) | **+0.24%** | [+0.07, +0.44] |
| 2014 onward — the vendor's retention boundary | **+0.32%** | [+0.06, +0.64] |
| Scaled to the shelf's own 27.3% attrition | **+1.91%** | [+0.69, +3.20] |

Positive means the survivor-only panel earned *more* — the bias
flatters. The intervals exclude zero in all three rows.

Four things about this measurement are worth carrying:

**It is an identity, not a backtest.** For an equal-weight book the
daily gap between the two panels is exactly `share doomed × (mean
survivor return − mean doomed return)`, with no residual. Breadth cannot
enter it and selectivity cannot enter it. Two earlier attempts to
measure this on synthetic panels were confounded by exactly those two
things and were reported as failures; this design removes them by
construction, and it was verified numerically to 2e-17.

**The control passes.** Buy-and-hold SPY is bit-identical on both panels
— largest gap 0.00e+00 of NAV across 5,428 sessions. Two panels that
disagree about SPY disagree about the calendar or the cost model, and a
survivorship number computed across that disagreement measures our own
wiring.

**The confound that remains is measured, not argued.** A third arm — 25
survival-blind pools sized to the biased panel — partitions the naive
gap exactly. Breadth contributes **+0.05% a year**, meaning the naive
comparison slightly *overstates* survivorship. Removing dead funds from
a universe does two things at once and only one of them is survivorship.

**It barely touches the ledger, for a structural reason.** 32 of the 33
published strategies name their own legs — the Permanent Portfolio holds
four funds by name, every factor row holds one — so adding dead funds to
the panel cannot move a weight in any of them. Their exposure is not
small, it is **zero**. Only `equal_weight_universe` moves. The
post-publication mean of -4.03% shifts by **+0.008%**; the median of
-3.21% does not move at all; the count of 3 in 30 is unchanged.

**And ETF survivorship is a different animal from equity survivorship.**
A closing ETF is wound up: creations stop, the portfolio is sold, the
cash is distributed. The tape agrees — across the dead cohort the median
fund's final quarter returned **+1.52%**, and only 33% of final quarters
were negative. Assuming a closing fund paid its holder **nothing at all**
moves the estimate only from +0.24% to +0.52% a year, a 0.28-point swing
against an interval 0.37 points wide. The bias here is almost entirely
about how doomed funds behaved *while alive*, not what they paid at the
end — which is the opposite of the single-name case, where the terminal
event is most of the bias. That makes the argument for **not** testing
single-name strategies on free data stronger, not weaker.

One thing a reader might reasonably assume and should not: **the
account's $655,000-a-day liquidity floor is not a survivorship fix.**
Dropping it takes the doomed share from 3.9% to 15.0% while the per-fund
gap falls from 7.33% to 0.29%, and the product barely moves. The floor
screens out funds that died of never gathering assets, not funds that
died.

_Sources: `reports/survivorship_measured.md` for every estimate,
interval and cohort figure; `reports/data_inventory.md` for the shelf's
26.7% / 2,069-of-7,747 attrition and the `tiingo_etf_bars` survivorship
mark of **OURS** — the vendor retains its dead, our selection from it
did not._

---

## 4. The machinery

Everything in sections 1-3 came out of one simulator. This section is
what the brief asked to see so the numbers can be audited.

### The engine reconciles to $0.00

One security — SPY — held through the whole simulator and reconciled
against its own published total return. Each row removes one friction
from the row above it.

| | Terminal wealth | CAGR | What it is |
|---|---:|---:|---|
| SPY total return, from `close_adj` | $1,206,317.69 | 10.840% | the published answer; nothing of ours in it |
| less cash never invested | $1,175,048.84 | 10.705% | deployment ramp plus the permanent 5% buffer |
| less spread and impact | $1,174,123.87 | 10.701% | at 1x the base assumption |
| less open-vs-close fill timing | $1,171,950.59 | 10.692% | decided at a close, filled at the next open |
| **engine NAV, as reported** | **$1,171,950.59** | **10.692%** | residual $-0.00 |

The engine came in **-0.148 percentage points a year** against SPY's own
total return, and every basis point of that difference is accounted for
by three named frictions. The residual is 2.583e-15 of terminal NAV
against a tolerance of 1e-08. The NAV invariant — settled plus unsettled
plus market value equals NAV — is checked inside the loop on all 5,428
sessions.

_Source: `reports/engine_validation.md`._

### How a trade is modelled

| | |
|---|---|
| Starting cash | $131,000 (the Fund's actual size) |
| Decision | at the close of session T |
| Fill | at the **open** of session T+1, at that session's own unadjusted open |
| Settlement | T+1, with 5% of NAV held back from every buy |
| Turnover budget | 5% of NAV a day, hard |
| No-trade band | 0.5% of NAV drift |
| Participation cap | 1% of the name's median dollar volume |
| Shares | whole only, $100 minimum ticket |
| Costs | liquidity-scaled spread + square-root impact, charged inside the loop, reported at **1x, 2x and 3x** |
| Marks | `close_adj` (total return); screens and share counts read `close_unadj` |
| Risk-free hurdle | FRED DGS3MO, converted geometrically to a per-session hurdle |

The deployability floor of **$655,000 a day** is arithmetic on three of
those constants, not a threshold anybody picked: a fund whose tape
cannot carry that cannot be deployed into at all. Finding it mattered —
measured from its listing day, USMV reports 2.31% a year with two fills
in fifteen years, because on its third session the fund traded $52,000
and the participation cap refused the buy. That is a fact about a
newborn ETF meeting a cap, not a fact about low volatility, and printing
it in a decay table would have been the largest single error in the
study.

_Source: `reports/post_publication_ledger.md`, "The run" and "When each
row could actually be held"._

### Sharpe, Deflated Sharpe and the trial count

The trial ledger holds **23 distinct configurations** across 48 recorded
runs, and it has no reset method. Correlated variants of one idea are
not 23 independent trials, so the count overstates N — which **raises**
the hurdle. That is conservative in the only direction it is defensible
to be wrong about a denominator we chose ourselves.

| Book | Cost | Observed SR | Best-of-N hurdle | PSR | **DSR** | Clears 95%? |
|---|---|---:|---:|---:|---:|---|
| Nine-sleeve book | 1x | 0.605 | 0.367 | 0.9973 | 0.8637 | no |
| Nine-sleeve book | 2x | 0.582 | 0.367 | 0.9964 | 0.8395 | no |
| Nine-sleeve book | 3x | 0.549 | 0.367 | 0.9943 | 0.7986 | no |
| 60/40 daily | 1x | 0.612 | 0.367 | 0.9977 | 0.8716 | no |
| Buy-and-hold SPY | 1x | 0.551 | 0.367 | 0.9946 | 0.8024 | no |

Those DSRs were computed when 13 configurations were on file. At the
current 23 the same book's DSR is **0.800** and SPY's is **0.723** — the
number falls as the count rises, which is the whole point of it.
Nothing in this project clears 0.95 at any trial count.

The library's own DSRs, at N=23: best is `permanent_portfolio` at 0.922,
then `quality_sphq` 0.835, `all_weather_retail` 0.817,
`sixty_forty_monthly` 0.815. Worst: `vaa_g4` 0.122, `vaa` 0.158.

_Source: `reports/stage3_sleeves.md` (the N=13 table) and
`reports/post_publication_ledger.md` (the N=23 column)._

### Drawdown and time to recover

A drawdown that has not recovered says so rather than printing a zero,
because a zero there reads as an instant recovery.

| Book | Max DD | Peak | Trough | Sessions down | Recovered | Time to recover |
|---|---:|---|---|---:|---|---|
| Nine-sleeve book (1x) | -9.69% | 2020-02-21 | 2020-03-19 | 19 | 2020-07-21 | 85 sessions (124 days) |
| Nine-sleeve book (3x) | -9.71% | 2020-02-21 | 2020-03-19 | 19 | 2020-07-21 | 85 sessions (124 days) |
| 60/40 daily (1x) | -30.32% | 2007-12-10 | 2009-03-09 | 312 | 2010-09-24 | 391 sessions (564 days) |
| Buy-and-hold SPY (1x) | -53.18% | 2007-10-09 | 2009-03-09 | 355 | 2012-08-16 | 869 sessions (1,256 days) |

Worth noting which crisis is which. Our book's worst moment was **2020**,
not 2008 — in 2008 it returned +10.96%. Both benchmarks' worst moments
were 2008.

Across the library the ugliest recoveries are `vaa` and `vaa_g4` at
1,259 and 1,279 sessions, and `vaa_g4`'s post-publication drawdown is
**still open after 107 sessions**.

_Source: `reports/stage3_sleeves.md` and
`reports/post_publication_ledger.md`._

### The worst 20 individual days, at 1x cost

Read this next to the drawdown table, not instead of it. A book can have
a mild worst day and a terrible drawdown (a long grind) or the reverse
(one gap, then recovery), and the two failure modes need completely
different answers.

| # | Nine-sleeve book | | 60/40 daily | | Buy-and-hold SPY | |
|--:|---|---:|---|---:|---|---:|
| 1 | 2013-06-20 | -2.28% | 2020-03-12 | -5.41% | 2020-03-16 | -10.76% |
| 2 | 2018-02-05 | -2.22% | 2008-10-15 | -5.32% | 2020-03-12 | -9.41% |
| 3 | 2020-03-18 | -2.09% | 2020-03-16 | -5.23% | 2008-10-15 | -9.30% |
| 4 | 2020-03-12 | -2.01% | 2008-12-01 | -4.60% | 2008-12-01 | -8.32% |
| 5 | 2020-03-11 | -1.93% | 2008-10-09 | -4.33% | 2020-03-09 | -7.69% |
| 6 | 2020-03-17 | -1.93% | 2020-03-09 | -3.99% | 2008-09-29 | -7.48% |
| 7 | 2018-02-08 | -1.87% | 2008-09-29 | -3.94% | 2008-11-20 | -6.93% |
| 8 | 2025-04-04 | -1.71% | 2020-03-18 | -3.45% | 2008-10-09 | -6.59% |
| 9 | 2007-02-27 | -1.71% | 2008-11-20 | -3.31% | 2011-08-08 | -6.23% |
| 10 | 2026-06-05 | -1.63% | 2008-11-06 | -3.25% | 2008-11-19 | -6.01% |
| 11 | 2021-02-25 | -1.60% | 2008-11-19 | -3.24% | 2025-04-04 | -5.81% |
| 12 | 2010-02-04 | -1.58% | 2025-04-04 | -3.19% | 2020-06-11 | -5.68% |
| 13 | 2024-12-18 | -1.56% | 2020-03-11 | -3.19% | 2008-11-06 | -5.23% |
| 14 | 2018-02-02 | -1.54% | 2020-06-11 | -3.13% | 2008-10-22 | -5.13% |
| 15 | 2011-09-23 | -1.50% | 2011-08-08 | -3.07% | 2020-03-18 | -4.97% |
| 16 | 2024-08-05 | -1.49% | 2009-01-20 | -3.05% | 2009-01-20 | -4.94% |
| 17 | 2026-01-30 | -1.46% | 2008-10-24 | -2.98% | 2025-04-03 | -4.89% |
| 18 | 2018-10-10 | -1.42% | 2022-06-13 | -2.81% | 2008-10-06 | -4.84% |
| 19 | 2023-02-03 | -1.40% | 2008-10-22 | -2.80% | 2020-03-11 | -4.80% |
| 20 | 2014-01-24 | -1.39% | 2025-04-10 | -2.78% | 2008-10-24 | -4.77% |

One cost level, because a cost multiple moves a single day's return by
basis points and these are days it moved by per cent.

_Source: `reports/stage3_sleeves.md`._

### The worst 10 months, at 1x cost

`sessions` is carried because the first and last months of a sample are
usually stubs, and a two-day stub topping the table is an artefact of
where the backtest starts rather than a month anybody lived through.

| # | Nine-sleeve book | | ses | 60/40 daily | | ses | Buy-and-hold SPY | | ses |
|--:|---|---:|--:|---|---:|--:|---|---:|--:|
| 1 | 2009-01 | -5.23% | 20 | 2008-10 | -9.24% | 23 | 2008-10 | -15.73% | 23 |
| 2 | 2018-02 | -3.80% | 19 | 2022-09 | -7.04% | 21 | 2020-03 | -12.27% | 22 |
| 3 | 2023-02 | -3.73% | 19 | 2022-04 | -6.61% | 20 | 2009-02 | -10.05% | 19 |
| 4 | 2018-10 | -3.64% | 23 | 2009-02 | -6.39% | 19 | 2022-09 | -9.14% | 21 |
| 5 | 2026-03 | -3.32% | 22 | 2009-01 | -6.01% | 20 | 2008-09 | -9.03% | 21 |
| 6 | 2020-03 | -2.82% | 22 | 2020-03 | -5.61% | 22 | 2022-04 | -8.69% | 20 |
| 7 | 2015-08 | -2.73% | 21 | 2008-09 | -5.34% | 21 | 2018-12 | -8.65% | 19 |
| 8 | 2010-05 | -2.61% | 20 | 2022-06 | -4.99% | 21 | 2022-06 | -8.16% | 21 |
| 9 | 2013-06 | -2.41% | 20 | 2008-06 | -4.40% | 21 | 2008-06 | -8.01% | 21 |
| 10 | 2016-11 | -2.36% | 21 | 2018-10 | -4.07% | 23 | 2020-02 | -7.80% | 19 |

_Source: `reports/stage3_sleeves.md`._

### Annual turnover and cost drag

Turnover counts every dollar that changed hands over average NAV,
annualised: a book that replaces itself once a year scores **2.0** under
this convention, not 1.0, because that is two trades and the cost was
paid on both. The halved convention is more flattering and less true.

| Book | Cost | Fills | Traded notional | Turnover/yr | Spread | Impact | Total | Drag on NAV | Per $ traded |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Nine-sleeve book | 1x | 6,183 | $37,243,318 | 7.154 | $7,352 | $963 | $8,315 | **16.0 bps** | 2.2 bps |
| Nine-sleeve book | 2x | 6,203 | $36,410,050 | 7.144 | $14,409 | $1,870 | $16,280 | 31.9 bps | 4.5 bps |
| Nine-sleeve book | 3x | 6,180 | $35,356,915 | 7.122 | $21,144 | $2,718 | $23,862 | 48.1 bps | 6.7 bps |
| 60/40 daily | 1x | 1,592 | $2,451,632 | 0.377 | $443 | $68 | $511 | 0.8 bps | 2.1 bps |
| Buy-and-hold SPY | 1x | 20 | $124,338 | 0.015 | $71 | $32 | $103 | 0.1 bps | 8.3 bps |

Tripling the cost assumption costs the nine-sleeve book **0.35% a year**
(+5.35% → +5.00%) and costs SPY nothing measurable. Across the whole
library, **34 of 34 books still compound at 3x cost.**

The library's turnover hogs are the tactical family: `vaa` at 9.04
turns a year and 24.2 bps of drag, `daa` at 7.92 and 19.2 bps, `aaa` at
7.61 and 32.4 bps. All three trail SPY badly, so the turnover bought
nothing.

_Source: `reports/stage3_sleeves.md` and
`reports/post_publication_ledger.md`._

### The named stress windows

These windows overlap nothing and partition nothing. They are the four
crises that happened plus the recent regime, cut identically for every
book so the rows can be compared with each other. Each is **one draw**
of a crisis; a statistic computed across 2008's 253 sessions has an n
far smaller than its T.

| Book | Window | Sessions | Total return | Annualised | Vol | Sharpe | Max DD | Worst day |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Nine-sleeve | 2008 | 253 | **+10.96%** | +10.93% | 8.08% | 1.15 | -7.15% | -1.26% |
| Nine-sleeve | 2018Q4 | 63 | -3.24% | -12.02% | 4.87% | -3.16 | -4.36% | -1.42% |
| Nine-sleeve | 2020Q1 | 62 | -3.30% | -12.59% | 11.85% | -1.18 | -9.69% | -2.09% |
| Nine-sleeve | 2022 | 251 | -5.72% | -5.74% | 4.04% | -1.96 | -6.10% | -1.39% |
| Nine-sleeve | 2023-present | 897 | +28.41% | +7.23% | 6.48% | 0.41 | -5.93% | -1.71% |
| 60/40 daily | 2008 | 253 | -16.25% | -16.22% | 21.78% | -0.77 | -26.81% | -5.32% |
| 60/40 daily | 2018Q4 | 63 | -6.43% | -22.77% | 12.78% | -2.20 | -10.19% | -1.79% |
| 60/40 daily | 2020Q1 | 62 | -7.61% | -27.22% | 28.51% | -1.03 | -18.51% | -5.41% |
| 60/40 daily | 2022 | 251 | -15.64% | -15.69% | 15.02% | -1.20 | -19.76% | -2.81% |
| 60/40 daily | 2023-present | 897 | +57.13% | +13.44% | 9.10% | 0.94 | -10.04% | -3.19% |
| SPY | 2008 | 253 | -35.38% | -35.32% | 38.96% | -0.96 | -45.74% | -9.30% |
| SPY | 2018Q4 | 63 | -13.30% | -42.58% | 23.26% | -2.44 | -18.89% | -3.19% |
| SPY | 2020Q1 | 62 | -19.15% | -57.40% | 53.92% | -1.35 | -33.25% | -10.76% |
| SPY | 2022 | 251 | -18.00% | -18.06% | 23.98% | -0.80 | -24.27% | -4.30% |
| SPY | 2023-present | 897 | **+103.12%** | +21.86% | 14.99% | 1.10 | -18.63% | -5.81% |

The shape of the whole project is in these fifteen rows. Our book was
the only one of the three that made money in 2008, and it captured just
over a quarter of SPY's 2023-present run. It is a defensive book, and it
behaves like one in both directions.

_Source: `reports/stage3_sleeves.md`. Annualised figures for the 62- and
63-session windows are arithmetic, not information — read the total
return column for those._

### Settlement deferrals per year

A deferral is the engine declining to place a trade because the cash was
not there. Split by cause, because a year of buffer deferrals and a year
of settlement deferrals are different findings: the first says the 5%
reserve is too fat for the strategy's turnover, the second is the
account type charging rent, the third — no cash — is a book that was
simply fully invested.

Nine-sleeve book, at 1x cost:

| Year | Deferrals | T+1 unsettled | Buffer | No cash | Total shortfall | Worst |
|---|---:|---:|---:|---:|---:|---:|
| 2006 | 303 | 4 | 299 | 0 | $628,213 | $11,579 |
| 2007 | 522 | 6 | 512 | 4 | $1,092,113 | $11,651 |
| 2008 | 469 | 15 | 454 | 0 | $1,228,553 | $15,969 |
| 2009 | 678 | 14 | 664 | 0 | $1,779,077 | $13,858 |
| 2010 | 677 | 11 | 666 | 0 | $1,781,408 | $12,667 |
| 2011 | 807 | 7 | 797 | 3 | $2,330,731 | $18,601 |
| 2012 | 716 | 7 | 709 | 0 | $2,300,288 | $18,810 |
| 2013 | 466 | 12 | 445 | 9 | $1,691,989 | $20,327 |
| 2014 | 728 | 5 | 723 | 0 | $2,711,135 | $20,028 |
| 2015 | 374 | 11 | 358 | 5 | $1,656,590 | $23,912 |
| 2016 | 578 | 4 | 573 | 1 | $2,075,844 | $23,964 |
| 2017 | 683 | 8 | 673 | 2 | $2,618,119 | $19,691 |
| 2018 | 222 | 3 | 216 | 3 | $1,065,610 | $76,747 |
| 2019 | 622 | 8 | 614 | 0 | $2,856,408 | $24,017 |
| 2020 | 761 | 8 | 752 | 1 | $3,455,639 | $54,875 |
| 2021 | 696 | 9 | 681 | 6 | $3,589,012 | $75,489 |
| 2022 | 157 | 5 | 143 | 9 | $1,576,783 | $49,351 |
| 2023 | 160 | 4 | 155 | 1 | $795,538 | $33,709 |
| 2024 | 488 | 5 | 483 | 0 | $2,532,234 | $30,410 |
| 2025 | 486 | 4 | 482 | 0 | $2,558,872 | $19,782 |
| 2026 | 122 | 3 | 119 | 0 | $835,989 | $20,369 |

**Total: 10,715 deferrals over 21 years, of which 10,518 (98.2%) are the
5% buffer, 153 are T+1 settlement and 44 are simply having no cash.**
That is a design finding rather than a friction: the reserve, not the
settlement cycle, is what declines our trades, and it declines them
roughly twice a session. By contrast the 60/40 book defers 1,141 times
over the same span and buy-and-hold SPY defers once, in 2005, for $11.

The benchmarks' full year-by-year tables are in the source report;
they are reproduced here only in total because 45 further rows of "31,
30, 50, 109…" would bury the one number that matters.

_Source: `reports/stage3_sleeves.md`, "Settlement deferrals per year"._

### Universe size by year

Three different studies used three different universes, and none of them
is a single number.

**The nine-sleeve book** holds nine vehicles by name — BIL, DBC, EEM,
EFA, GLD, IEF, LQD, SPY, TLT — but not all nine existed at the start:

| Period | Sleeves held | Note |
|---|---:|---|
| 2005-01-03 to 2006-02-05 | 8 | DBC did not exist; **nothing stood in for it** |
| 2006-02-06 to 2007-05-29 | 9 | cash sleeve is FRED DTB3 compounded daily, not BIL |
| 2007-05-30 onward | 9 | all nine as real vehicles |

Neither gap was filled with a proxy. The commodity alternatives roll
differently, so a substitute would be a different sleeve wearing DBC's
name; every ETF stand-in for early cash carries duration, and a 1-3 year
fund like SHY lost money in 2022 while bills did not. Before BIL listed,
the cash residual earned the bill rate through an index; before DBC
listed there was simply no commodity sleeve. Bills paid 3-5% across
2005-2007, so that is not a rounding error.

**The strategy library** ran on 148 funds served, of which one strategy
— `equal_weight_universe` — spans a 142-leg cross-section. Every other
strategy names between 1 and 15 legs explicitly, so its "universe size"
is its leg count and does not vary by year.

**The survivorship panel** is the only universe measured year by year,
because it is the only one where the count is the point:

| Year | Survivors in panel | Doomed in panel | Panel doomed share | Shelf doomed share |
|---:|---:|---:|---:|---:|
| 2005 | 50 | 0.4 | 0.8% | 35.4% |
| 2006 | 57 | 1.5 | 2.6% | 33.4% |
| 2007 | 69 | 3.3 | 4.6% | 30.6% |
| 2008 | 87 | 3.3 | 3.6% | 30.2% |
| 2009 | 94 | 2.5 | 2.6% | 32.1% |
| 2010 | 94 | 3.8 | 3.9% | 31.7% |
| 2011 | 101 | 5.4 | 5.1% | 32.8% |
| 2012 | 109 | 2.9 | 2.6% | 34.5% |
| 2013 | 117 | 4.6 | 3.8% | 35.2% |
| 2014 | 128 | 6.4 | 4.8% | 35.6% |
| 2015 | 131 | 8.9 | 6.4% | 35.2% |
| 2016 | 133 | 10.1 | 7.1% | 34.4% |
| 2017 | 135 | 9.3 | 6.4% | 34.3% |
| 2018 | 135 | 8.8 | 6.1% | 31.2% |
| 2019 | 135 | 9.5 | 6.6% | 27.4% |
| 2020 | 137 | 6.9 | 4.8% | 24.5% |
| 2021 | 141 | 4.6 | 3.1% | 18.6% |
| 2022 | 145 | 5.1 | 3.4% | 17.4% |
| 2023 | 144 | 3.3 | 2.3% | 14.6% |
| 2024 | 143 | 2.0 | 1.4% | 8.7% |
| 2025 | 143 | 2.0 | 1.3% | 5.0% |
| 2026 | 146 | 0.4 | 0.3% | 2.2% |

The last column is the reason section 3's headline is quoted twice: the
panel carries a small fraction of the dead funds the real shelf carried,
because a metered free tier bought a few dozen and the shelf holds
nearly two thousand.

_Sources: `reports/stage3_sleeves.md` (splices),
`reports/post_publication_ledger.md` (leg counts),
`reports/survivorship_measured.md` (the by-year table)._

---

## 5. What was tried and did not work

Two whole studies produced nulls. They are here at the same weight as
everything else, because a project that reports only its positive
findings has told you nothing about its filter.

**A machine-learning classifier, twice.** A gradient-boosted tree and an
LSTM, both trained to predict whether a fund's 21-session forward return
beats the cross-sectional median, both trading only when confident. GBM
scored **AUC 0.536** out of sample against a 0.500 base rate and returned
**+0.28% a year** at a Sharpe of -0.27. LSTM scored **0.524** and
returned **-0.13% a year** at a Sharpe of -0.21. On the same engine and
window, buy-and-hold SPY returned +13.87% and a daily-rebalanced equal
weight returned +8.73%.

The damning detail is not the AUC. It is that **a lookup table of
per-fund training base rates — no features, no dates, no market state —
scores 0.552 and 0.543 on the same rows.** Both models are *worse* than
knowing nothing except which fund this is. Their deflated Sharpes are
0.001 and 0.002.

_Source: `reports/ml_classifier.md`._

**The three signals, measured alone.** Trend, inverse volatility and
correlation were each measured on their own claims before any of them
was combined. The largest information coefficient across every horizon
is **0.0377**. The best single-sleeve long/flat Sharpe over the full
sample is **0.563**, which sits above buy-and-hold SPY's 0.551 by a
margin that means nothing at all. What the study did establish is that
the three signals are not
restatements of each other (worst pairwise correlation -0.053, all
inside ±0.60), which is the ensemble's premise — a statement about their
scores, not about any of them being right.

_Source: `reports/signal_evaluation.md`._

---

## 6. Reasons this might be wrong

Everything above is a measurement. This section is the list of ways the
measurements could be correct and the conclusions still wrong. It is
written to be read, not skimmed past.

### 6.1 The ETF universe was chosen in 2026 — and we now know roughly what that cost

For most of this project this was the item with no number attached. It
has one now, and the number is small: **the survivor-only panel flatters
an equal-weight book by +0.24% a year on this panel, +0.32% over the
window where the vendor actually retains its dead, and +1.91% a year if
scaled to the real shelf's 27.3% attrition rate.** All three intervals
exclude zero. The sign is positive, meaning the bias flatters, and the
magnitude is a point or two a year rather than a rounding error or a
catastrophe.

Three qualifications on that measurement, in decreasing order of size.

**The scaled figure is the weakest of the three.** It re-weights the
measured panel figure by a factor of seven and multiplies the sampling
noise by the same factor. The sign survives; the magnitude should be
held loosely. Do not quote +1.91% to two decimals.

**The catalogue records almost no closure before 2014.** Tiingo carries
6 ETF closures across the 9 years before it, against 1,896 after — and
the missing ones are exactly the 2008-09 casualties whose returns would
be worst. `retention_cliff` estimates 222-479 closures the vendor never
carried. So the whole-sample figure is a **lower bound**, and only the
post-2014 figure is a fair measurement of its own window.

**The channel that touches every result is a different one and is not
measured.** 32 of 33 strategies name their own legs, so cross-sectional
survivorship cannot reach them. But those legs were *themselves* chosen
in 2026 from funds that still trade. A club building an international
sleeve in 2005 might well have bought ADRE, GAF or FRN rather than EEM —
all three are gone. That is **vehicle-selection bias**, it applies to
every sleeve book here including ours, its size is the same arithmetic
(doomed share of the menu × per-fund gap), and it is not measurable from
this tape because nothing records which fund a 2005 committee would have
picked.

Two defects found while running this that a future reader should not
have to rediscover. The history gate was counting bars *inside* the
study window rather than over the whole pull, so every fund failed the
252-session rule at once and the study opened by sitting in cash through
2005 — worth 0.13% a year on SPY, invisible in any gap because it hit
both panels. And a multi-coverage-window test is **not** a sufficient
reissued-ticker screen: four symbols (`RISE`, `SLVO`, `EMCG`, `FTW`)
carry exactly one window, are filed dead, and the price endpoint serves
a live series. A universe built from directory metadata alone will carry
a successor's returns under a dead fund's name.

### 6.2 The holdout was spent by a contradiction inside the brief

`config.HOLDOUT_YEARS` is 3, documented as "reserved and untouched until
the very end. Three years, one look." From a 2026-07-31 sample end that
reserves roughly August 2023 onward.

The same brief requires every report to break out a **2023-present**
window, and `metrics.REPORT_PERIODS` duly declares one. Every table in
every report prints it: 897 sessions, our book +28.41%, SPY +103.12%.

Those two instructions cannot both be satisfied. A window you are
required to print in every report is not reserved, and it has been
looked at many times — once per report generation, across six reports,
across two days of runs. **This project therefore has no untouched
holdout, and the reason is a specification conflict rather than
carelessness or a lost nerve.** The named period's own docstring is
honest about the consequence: "not out-of-sample unless the holdout says
so."

What this costs concretely: there is no stretch of tape left against
which to check anything that was decided after seeing a result, and
there is not a second three years waiting. The only remedy is forward
time, which arrives at a fixed rate.

### 6.3 The sample contains exactly one great financial crisis, so every conclusion has an n of 1

2005-2026 buys 2008, 2018Q4, 2020Q1 and 2022 — which is why the sample
starts where it does. 2008 contains roughly 250 sessions, but it is a
**single draw of a credit crisis**, and a statistic computed across its
sessions has an n far smaller than its T. The same is true of 2020Q1 and
of 2022. The named windows are not a distribution of crises; they are
the four crises that happened.

This bites hardest on the defensive half of our book. Two of the nine
sleeves are Treasury duration and one is investment-grade credit, and for
fourteen of these twenty-one years falling yields paid those assets both
to diversify equity *and* to earn. That was a feature of a particular
monetary regime, not a law. It ended in 2022 and has not resumed. The
+10.96% our book made in 2008 is one observation of one crisis in which
that relationship held; it is not a property of the design.

Say it as bluntly as it deserves: **the single most impressive number in
this document — 2008 — is a sample of one.**

### 6.4 The engine is validated, and validation is not correctness

`engine_validation.md` reconciles a buy-and-hold of SPY against its own
published total return to **$0.00** residual, and the ladder that gets
there names each friction. That is a real result and it is worth exactly
what it says: the plumbing is arithmetic anybody can follow. Positions
are marked in total-return space, fills land at the next open, costs are
charged once, cash is conserved.

It proves nothing about a strategy, because there is no strategy in it.
The control was chosen precisely because its correct answer is published
and we did not get to pick it.

And a reconciliation cannot catch a shared assumption. Every check in
this repository compares our data against itself, against the exchange
calendar, and against the vendor's own record of corporate actions.
**A consistently wrong close survives all of it.** Nothing anywhere
confirms that these prices are the prices that traded. The single
cheapest way to change that is in 6.6.

Separately: the cost model is a borrowed prior, not a measurement. The
spread curve is interpolated between three anchor bands and the impact
coefficient comes from published literature — we have no fills of our
own. At $131,000 the square-root impact term contributes so little that
the result would look the same if the coefficient were half or double,
so **this backtest does not test the impact model at all.** Everything is
reported at 1x, 2x and 3x, and that ladder is a sensitivity analysis
rather than a hedge: if the true cost is 3x, the account pays 3x
regardless of which column gets quoted.

### 6.5 The strategies were implemented by reading their papers, and nobody audited the translation

Thirty-three published rules were turned into Python by one person
reading each source and writing what it said. Every parameter is the
source's; nothing was swept, tuned, or chosen by looking at a result —
which is why the whole library counts as **one trial** rather than
thirty-three, and why a bad row like Faber's ten-month rule (3.75% a
year, less than half of SPY) is kept in the table at that number.

That discipline controls for overfitting. It does not control for
**misreading**. There is a translation step between "the paper says" and
"the code does", it happened once, and no second person checked it. A
rule implemented slightly wrong produces a perfectly clean-looking
backtest of a strategy nobody published. That failure mode leaves no
trace in any output in this repository: no check fires, no diagnostic
reports it, and the deflated Sharpe cannot see it.

The exposure is concentrated where the rules are most intricate. The
tactical family (`vaa`, `vaa_g4`, `daa`, `paa`, `aaa`, `gtaa_agg6`)
carries 10-15 legs each and multi-step selection logic, and it is also
the family that performed worst — post-publication excess of -6.71% to
-11.91% a year. Some of that gap is real decay. Whether any of it is a
misread breakout rule is not something this study can distinguish, and
it would be honest to assume some of it is.

### 6.6 Six smaller things, each of which could change a number

- **The confidence intervals are narrower than the truth.** The -4.03%
  mean's interval treats 30 overlapping, mostly-long-equity records as
  independent draws. They are not. The effective sample is well below 30
  and nothing here estimates how far below. The **3 of 30 sign count** is
  the statement that does not depend on this.
- **Nothing is out of sample in time.** Every window in every report is a
  window this sample contains. Publication dates are a genuine defence —
  they were fixed by strangers before we existed — but 10 of the 30
  dated strategies were already in print when the tape starts, so for
  those the "post-publication window" is just the full sample, and the
  guarantee reduces to the fact that nobody here chose 2005.
- **Real fills are worse than modelled ones, in ways the model cannot
  see.** The open is a single-price auction our order was not in. Nothing
  here ever fails to trade for want of a counterparty — every refusal is
  one of ours. And the correlation runs against us: the days a strategy
  most wants to trade are the days spreads are widest, while the cost
  model reads liquidity as of the *decision* close, which is correct
  anti-lookahead practice and is precisely why it prices a panic
  morning's trade at the calm week's median volume.
- **Taxes, commissions, fund tracking error, distribution timing,
  trading halts and broker fractional-share behaviour are not modelled
  at all.** At an average ticket near $1,300, a flat per-trade
  commission would be a material rate — defensible only while the broker
  charges nothing to trade US-listed ETFs, and false the day that
  changes.
- **The trial count in the denominator is the wrong one, in the
  flattering direction.** `trials.jsonl` counts configurations evaluated
  *after the counter existed*. The choices that constitute the
  strategy's shape — the nine tickers, the nine caps, the 2005 start,
  the decision to run sleeves at all — were made before that and are not
  in it. They were trials. They are untallied ones, and they are almost
  certainly the ones that matter most.
- **Layer 3 was never built.** The single-name equity layer needs a
  survivorship-free point-in-time panel with as-traded prices and filing
  dates, and no free source carries prices for companies that stopped
  trading before roughly 2014 — of 8,028 dead US common-stock series in
  the vendor's directory, **eight end before 2009**. So every result here
  describes the system with stock selection switched off. Read a good
  sleeve-only result as a good sleeve-only result. It is not evidence
  about the part that does not exist.

### 6.7 What would actually settle each of these

Named research, and what each one would resolve. Not "further research
is needed."

| Do this | It settles |
|---|---|
| Pull the same nine sleeve series from a second vendor and diff them bar for bar | Whether "internally consistent" is "probably right" (6.4). A weekend's work; it is the cheapest item on this list and closes the largest unexamined assumption. |
| Finish the dead-ETF acquisition — 1,792 shelf symbols still have no bars, metered at ~50/hour | Narrows the survivorship interval and, more usefully, makes the *momentum* books measurable. Both momentum arms currently cross zero (+0.23% [-0.24, +0.72] and +0.16% [-0.36, +0.70]) because 97 dead funds can measure a cross-sectional mean and cannot measure what a 20-name book made of the top of it did. |
| Paper trade with logged decisions, arrival prices and real fills | Replaces the borrowed impact coefficient with a measured one and shows how far the next-open model sits from this account's actual executions (6.4). It is the only item that converts an assumption into a measurement. |
| Have a second person re-implement three of the tactical strategies from the same sources, blind, and diff the weight vectors | Bounds the translation error in 6.5, on the family where it is most likely and most consequential. |
| Acquire a post-2014 single-name panel against the Tiingo key | Makes a stock-selection test possible for the first time — and it will still have no 2008 in it, so it would answer a narrower question than the one Layer 3 was meant to answer. |
| Wait | 6.2 and 6.3, and nothing else does. Forward time is the only sample nobody can overfit, and it arrives at a rate no amount of work speeds up. That is the honest argument for starting the clock rather than running another variant. |

---

## 7. Where every number came from

| Report | What it establishes |
|---|---|
| `reports/engine_validation.md` | The simulator reconciles to SPY's published total return, residual $0.00. |
| `reports/signal_evaluation.md` | Each of the three signals measured alone, before any blend. Largest \|IC\| 0.0377. |
| `reports/stage3_sleeves.md` | Our nine-sleeve book through the engine: 5.35%/yr, Sharpe 0.61, DSR below the bar. Drawdowns, worst days, worst months, turnover, stress windows, deferrals. |
| `reports/ml_classifier.md` | Two machine-learning models, both nulls, both beaten by a per-fund base-rate lookup table. |
| `reports/post_publication_ledger.md` | 33 published strategies from their own publication dates. Mean excess -4.03%/yr, 3 of 30 beat SPY. |
| `reports/survivorship_measured.md` | What our 2026-written ETF list cost: +0.24%/yr on this panel, +1.91%/yr at the shelf's real attrition. |
| `reports/data_inventory.md` | Every dataset held, with survivorship marked FREE / BIASED / OURS / n/a, and ten things the free universe cannot do. |
| `LIMITATIONS.md` | Written before any result existed, so it could not be trimmed to fit one. |
| `trials.jsonl` | 23 distinct configurations across 48 recorded runs. No reset method. |

Regenerate any of it with `validate_engine.py`, `evaluate_signals.py`,
`run_sleeves.py`, `run_ml.py`, `run_ledger.py`,
`measure_survivorship.py` and `fetch_all.py`, in that order.

---

## 8. The one-paragraph version

Over twenty-one and a half years, holding SPY and never trading again
beat every published strategy we could implement, and beat our own book
by 5.34% a year. Our book's compensation was a 9.69% worst drawdown
against SPY's 53.18%, and it was the only one of the three that made
money in 2008 — one observation of one crisis. Measured from their own
publication dates, 27 of 30 published strategies trailed the index, by
an average of 4.03% a year. Two machine-learning models did worse than a
lookup table. The survivorship bias we had been assuming away turns out
to be worth about a quarter of a point a year on this panel and perhaps
two points at the real shelf's attrition rate — positive, small, and
now measured rather than argued. Nothing in this repository clears a
deflated Sharpe of 0.95. The most valuable thing here is not a strategy;
it is a simulator that reconciles to the penny, a trial counter with no
reset method, and a written record of how much a good number in it would
actually be worth.
