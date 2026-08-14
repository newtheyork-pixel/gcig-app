# The strategy library

**A pre-registration.** Thirty-three published allocation strategies,
each implemented as published, each to be measured only from its own
publication date forward, under one engine and one cost model.

Written 3 August 2026, before any result in this study exists. Nothing
below is a finding. Everything below is a commitment: the parameters,
the vehicles, the dates, the departures, the ambiguities, and the
analysis plan are fixed here so that a reader who returns after the
numbers land can check that none of them moved. That check is the whole
point of the document. A replication study whose specification can be
edited once results exist is not a replication study; it is a search.

The library is machine-readable at
`griffinquant/strategies/registry.py`, which is the source this
document is generated against, and every claim it makes about a
strategy's admissibility is asserted in `tests/test_strategies.py`.

---

## 1. Why measure from the publication date

This project spent its first phase hunting for an edge and did not find
one. Its own nine-sleeve strategy returned 5.35% a year against
buy-and-hold SPY's 10.69% over 2005-2026, tied a plain 60/40 on Sharpe
at 0.61, and was not significant after thirteen trials. A wide review of
the live record then concluded that beating SPY on return, long-only and
unlevered on free ETF data, is not reliably achievable: about
twenty-five long-only style ETFs average roughly -1%/yr against SPY,
seventeen of the twenty-five negative.

So the question changed. Not "what works" but "what happened to the
things that were published as working".

Two results make that question worth a study rather than a blog post.

- **McLean and Pontiff (Journal of Finance, 2016)** find published
  anomaly returns fall 26% out of sample and 58% after publication.
- **Huang, Song and Xiang (JFQA, 2024)** find smart-beta indices
  returned +2.77%/yr in their pre-launch backtests and -0.44%/yr after
  listing.

Both are claims about a boundary in time, and the boundary is the
publication date. Measuring from it is a **stronger** out-of-sample
guarantee than any holdout this project could carve for itself, for one
reason: the date was set by somebody else, in a document, years ago, and
cannot be moved once a result exists. A holdout is a promise. A
publication date is a fact.

Nobody has assembled this uniformly. The evidence is scattered across
papers with different windows, different universes and different cost
assumptions, and the differences between those choices are large enough
to swamp the differences between the strategies. One method and one cost
model across thirty-three published rules is the contribution.

---

## 2. The one rule that governs every implementation

**Implement each strategy as published. Its parameters come from the
paper or the book, not from us, and not from what works.**

Where a publication is ambiguous, the most literal reading is
implemented and the ambiguity is recorded — in the class docstring, in
`as_published`, and in section 8 of this document, which is the trial
ledger. Where a reading is genuinely forked in the source, both are
implemented and **running both counts as two trials**, not one result.

Nothing is tuned. Several parameters in this library look arbitrary
because they are: a 13612W momentum weighting that puts forty per cent
of the score on one month, a breadth threshold of four out of twelve, a
protection factor that resolves to exactly half the universe, a top-six
that could as easily have been a top-five. Those numbers are **data**.
They record how hard each strategy was fitted before it was published,
and rounding one off to something tidier destroys the measurement. Every
impulse to improve one is written down in section 9 and in no case acted
on.

---

## 3. The method, fixed in advance

Every strategy in the library runs through the same engine
(`griffinquant/engine/backtest.py`) under the same account.

| | |
|---|---|
| Account | $131,000, cash, no margin |
| Signal and fill | Signal at the close of T, fill at the open of T+1. Enforced by the type: a strategy is handed frames already truncated at T and has no handle to anything later. |
| Long only | Weights in [0, 1]. A negative target raises rather than being clipped. |
| No leverage | Non-cash weights sum to at most 1.0; cash takes the residual. A gross above 1.0 raises. |
| Prices | Total-return closes for every return and every signal; the unadjusted open for every fill; the unadjusted close for every share count. Over 2004-2026 TLT returned -2.6% on price and +105.8% with coupons, so a signal run on unadjusted bond prices reports that Treasuries have never trended. |
| Costs | Spread plus impact, one model, applied identically to every run. |
| Settlement | T+1. Proceeds of today's sale cannot fund today's buy. |
| Turnover budget | 5% of NAV per session, hard. A month-end rotation moving 40% of the book takes about eight sessions. |
| No-trade band | 0.5% of NAV per position, never tuned. |
| Whole shares | Yes, with a $100 minimum ticket. |
| Cash buffer | The ledger holds back 5% of NAV as settled cash. A target of 1.0 is therefore unreachable; the shortfall is proportional to each weight, so it moves the level of a book and never its mix. |
| Sleeve caps | **Off.** See below. |
| Uninvested cash | Earns nothing. See below. |

**Sleeve caps are off, and that is a methodological commitment rather
than a convenience.** The ceilings in `portfolio/sleeves.py` — SPY at
40%, DBC at 15%, and so on — are this fund's own risk policy for its own
book. Faber, Antonacci, Keller, Qian, Maillard, Haugen and Choueifaty
imposed nothing of the kind. A capped run measures our constraint and
not their rule, and the engine clamps in **silence**, so a capped GEM run
would report our 40% ceiling as Antonacci's record with no signal
anywhere in the output. Every strategy in the library either raises when
a published weight is capped (the trend family) or clamps and records
that it clamped. Any run in the study passes
`BacktestConfig(apply_sleeve_caps=False, default_max_weight=1.0)`, and a
run that does not must be reported as constrained.

**Uninvested cash earns nothing, and this biases the study in a known
direction.** Several of these rules spend real time out of the market —
Faber's was fully in cash through most of 2008 — and crediting that with
zero while bills paid 2-5% does not make the comparison conservative, it
makes it wrong, and it biases every timing rule downward against a
buy-and-hold benchmark that was never out. Where a rule names a cash
vehicle and the panel carries one with a price, the residual is HELD in
it and the decision record says so. Where it does not, the residual sits
uninvested and the record says that instead. Two rules currently fall
into the second case by default and are flagged in section 10.

**Uniform frictions cut against the high-turnover families and this must
appear in the write-up.** The 5%/day turnover budget binds on 16.6% of
Faber's sessions in preliminary work, because monthly re-equal-weighting
generates 2.18x annual one-way turnover. It is applied uniformly so the
comparison stays fair, but the trend and tactical families are being
measured under a constraint the papers did not have. The measured cost
drag for Faber is only 9.4 bps/yr, so the shortfall observed there is
the rule and not our frictions — but the budget is a real difference and
belongs in the reporting.

---

## 4. How a date was chosen

`published_on` is the day the idea became readable by somebody who was
not its author. Four conventions, fixed here:

1. **Round late.** Where a source is dated only to a month, a quarter or
   a season, the attribute is the LAST day of that period. The asymmetry
   is deliberate: starting too early admits data the author could still
   have been fitting on, and starting too late merely costs sample. (The
   factor module dates a monthly or quarterly journal to the FIRST of
   its issue month instead; this is immaterial there by construction,
   because no measurement in that family begins within a month of any
   publication date, and the two conventions differ by at most four
   weeks.)
2. **Journal over working paper, where the journal is what can be
   verified.** An SSRN preprint is usually earlier and is usually not
   pinnable to a day from anything this repository holds. Where the
   earlier appearance is known it is named in the entry and in section 8,
   because a reader who prefers it gains sample and must say so.
3. **A private fund is not a publication.** Bridgewater ran All Weather
   from 1996; that is earlier than Qian 2005 and does not count. Nobody
   outside the firm could have implemented from it, and the entire
   out-of-sample guarantee comes from the date being fixed in public.
4. **A convention with no author gets no date.** Holding SPY and holding
   60/40 have no publication. They are registered `UNDATED` with a
   written reason, they are measured over whatever sample the comparison
   needs, and they **never appear in the post-publication table**. A
   fabricated date would put a control into that table wearing a decay
   claim nobody ever made about it.

The factor family carries a **second** date. `investable_from` is when a
person with a brokerage account could first own the thing, which is not
when the idea entered the record. Twenty years and one month separate
Jegadeesh and Titman from MTUM. Whatever momentum did in those twenty
years, no reader of this study earned it, and the gap column is the most
informative column in the catalogue.

`measurable_from` is the later of the two and is where a run starts.

---

## 5. The catalogue

Thirty-three strategies: 3 undated controls, 30 with a publication date.
Six fixed allocations, three trend rules, six tactical rules, four
risk-based books, fourteen factor tilts.

| key | family | published | investable | gap (yrs) | universe |
| --- | --- | --- | --- | --- | --- |
| sixty_forty_daily | static | _undated_ | - | - | SPY IEF |
| sixty_forty_monthly | static | _undated_ | - | - | SPY IEF |
| spy_buy_and_hold | static | _undated_ | - | - | SPY |
| permanent_portfolio | static | 1981-01-01 | - | - | SPY TLT GLD BIL |
| equal_weight_universe | static | 2009-05-01 | - | - | the whole ETF universe (142 tickers) |
| all_weather_retail | static | 2014-11-18 | - | - | SPY TLT IEF GLD DBC |
| faber_gtaa_10mo | trend | 2007-04-30 | - | - | SPY EFA IEF VNQ DBC BIL |
| absolute_momentum_12m | trend | 2013-04-30 | - | - | SPY BIL |
| antonacci_gem | trend | 2014-12-01 | - | - | SPY VXUS AGG BIL |
| aaa | tactical | 2012-12-31 | - | - | SPY VGK EWJ EEM VNQ RWX IEF TLT DBC GLD |
| gtaa_agg6 | tactical | 2013-02-28 | - | - | SPY MDY IWM IWC EFA EEM IYR DBC GLD IEF TLT LQD BWX |
| paa | tactical | 2016-04-30 | - | - | SPY QQQ IWM VGK EWJ EEM IYR GSG GLD HYG LQD TLT IEF |
| vaa | tactical | 2017-07-31 | - | - | SPY IWM QQQ VGK EWJ VWO VNQ GSG GLD TLT HYG LQD IEF SHY |
| vaa_g4 | tactical | 2017-07-31 | - | - | VOO VEA VWO BND LQD IEF SHY |
| daa | tactical | 2018-07-31 | - | - | SPY IWM QQQ VGK EWJ VWO VNQ GSG GLD TLT HYG LQD SHY IEF BND |
| minimum-variance | risk | 1991-04-01 | - | - | XLB XLE XLF XLI XLK XLP XLU XLV XLY XLRE XLC |
| risk-parity-unlevered | risk | 2005-09-01 | - | - | SPY EFA EEM IEF TLT LQD TIP GLD DBC VNQ |
| maximum-diversification | risk | 2008-10-01 | - | - | XLB XLE XLF XLI XLK XLP XLU XLV XLY XLRE XLC |
| equal-risk-contribution | risk | 2010-07-01 | - | - | SPY EFA EEM IEF TLT LQD TIP GLD DBC VNQ |
| size_rsp | factor | 1981-03-01 | 2003-04-24 | +22.15 | RSP |
| lowvol_splv | factor | 1991-04-01 | 2011-05-05 | +20.09 | SPLV |
| lowvol_usmv | factor | 1991-04-01 | 2011-10-18 | +20.55 | USMV |
| value_iwd | factor | 1992-06-01 | 2000-05-22 | +7.97 | IWD |
| value_vlue | factor | 1992-06-01 | 2013-04-16 | +20.87 | VLUE |
| value_vtv | factor | 1992-06-01 | 2004-01-26 | +11.65 | VTV |
| momentum_mtum | factor | 1993-03-01 | 2013-04-16 | +20.13 | MTUM |
| momentum_spmo | factor | 1993-03-01 | 2015-10-09 | +22.61 | SPMO |
| fundamental_prf | factor | 2005-03-01 | 2005-12-19 | +0.80 | PRF |
| quality_qual | factor | 2013-04-01 | 2013-07-16 | +0.29 | QUAL |
| quality_sphq | factor | 2013-04-01 | 2012-01-03 | **-1.24** | SPHQ |
| multifactor_ishares | factor | 2013-06-01 | 2013-07-16 | +0.12 | MTUM VLUE QUAL USMV |
| multifactor_longest | factor | 2013-06-01 | 2012-01-03 | -1.41 | IWD SPHQ SPLV RSP PRF |
| multifactor_six | factor | 2013-06-01 | 2013-07-16 | +0.12 | MTUM VLUE QUAL USMV RSP PRF |

The negative gaps are not errors and are deliberately not clipped. SPHQ
listed more than a year before Novy-Marx reached the JFE: the product
came first and the academic record followed, which is the opposite of
the decay story and is worth reporting as such.

---

## 6. The strategies

### 6.1 Fixed allocations and controls

**`spy_buy_and_hold` — 100% SPY, bought once.**
No author. The benchmark, and the hardest row in the study: no parameter
to fit, no turnover after deployment, 10.69%/yr over 2005-2026.
*Departures:* none. The target is 95% rather than 100% because the
ledger's buffer makes a full-NAV target unreachable, and the same scale
is applied to every fixed mix so the ratios are exactly as published.
Implemented as a wrapper around the engine's own `BuyAndHold`, because
the deployment latch is the entire difference between buy-and-hold and
constant mix and a second copy is a second place for it to rot.

**`sixty_forty_monthly` / `sixty_forty_daily` — SPY 60 / IEF 40.**
No author; the balanced-fund convention, in the public domain long
before any vehicle here listed.
*Departures:* two, and neither is free. (1) The bond leg is 7-10 year
Treasuries rather than the aggregate index, matching the 60/40 this fund
already reports against; an AGG leg carries corporate credit, which
behaves like equity in precisely the weeks the bond leg is being relied
on. (2) Rebalancing frequency is unstated everywhere, so **both** are
run and **both** are reported. A daily rebalance harvests the
rebalancing premium in full and pays the full cost of doing it; the gap
between the two rows is a clean read on what that trade is worth net of
friction at this size. Quoting whichever came back better is two trials
and one reported result, which is the thing this study exists to catch
other people doing.

**`permanent_portfolio` — SPY / TLT / GLD / BIL at 25% each, band 15-35%.**
Harry Browne and Terry Coxon, *Inflation-Proofing Your Investments*,
William Morrow, 1981. Pinned to the book rather than to the 1982 fund
launch. The claim is about survival rather than return and should be
read against drawdown first.
*Departures:* (1) Browne's deflation leg is a fresh ~30-year Treasury
bought directly; TLT's 20+ ladder is shorter duration and therefore less
convex. (2) No bill ETF exists before 30 May 2007, so a run starting in
2005 holds a quarter of the book as uninvested balance earning nothing
while real bills paid about 5%. That is a large understatement; it is
recorded in `absences()` rather than repaired with a substitute, and any
result covering those years must print it. (3) No gold ETF before 18
November 2004; same rule. (4) US equity is SPY, narrower than the total
market Browne describes. **Ambiguity:** the source does not say how often
the band is checked. Implemented at every close, the literal reading of
"whenever"; the annual-check reading is a different series and is a
second trial.

**`all_weather_retail` — SPY 30 / TLT 40 / IEF 15 / GLD 7.5 / DBC 7.5, annual.**
Tony Robbins, *MONEY: Master the Game*, Simon & Schuster, 2014.
*Departures:* this is a **popularised approximation and not
Bridgewater's All Weather**, which is levered, whose weights are not
public, and which no long-only unlevered account could hold. The
difference is not cosmetic: risk parity's return claim depends on
levering a low-volatility book to an equity-like risk target, and
without the leverage the same mix keeps the smoother ride and gives up
the return the leverage was there to restore. The comparison this row
supports is to the book's own numbers, never to the fund's. All five
vehicles exist well before publication, so the post-publication window
has no missing leg.

**`equal_weight_universe` — 1/N over the whole ETF panel, monthly.**
DeMiguel, Garlappi and Uppal, *Review of Financial Studies* 22(5), 2009.
The naive control every allocation study should carry and most do not,
and the only strategy in the library that estimates nothing.
*Departures:* the paper's cross-sections are equity and factor
portfolios, not an ETF universe, so this is an **extension rather than a
replication**. N is time-varying by design — freezing it to today's list
would hold funds that did not exist. Two things a reader must be told
about the result: one over roughly 142 names is a target position of
about 0.7% of NAV, barely above the engine's 0.5% no-trade band, so
after deployment this drifts far more than "rebalanced monthly"
suggests; and at $131,000 that position is about nine hundred dollars,
so the $100 minimum ticket bites on any trim. This control is closer to
buy-and-hold at our size than it would be at a fund's. That is the
account's constraint being visible, not a fault in the rule, and it is
recorded rather than screened away.

### 6.2 Trend following

All three signal on **completed month-end closes** and hold between
month-ends. A monthly rule sampled daily is a different strategy with
several times the trade count, and the difference is invisible in the
equity curve. Whether a session is a month end is read off the published
NYSE calendar, never off the panel.

**`faber_gtaa_10mo` — ten-month SMA on five asset classes, equal fifths.**
Mebane Faber, *Journal of Wealth Management* 9(4), Spring 2007.
Published 2007-04-30. Hold each asset when its month-end close is above
the average of the last ten month-end closes; otherwise hold cash
against it. The five signals are independent, so the book steps through
0 / 20 / 40 / 60 / 80 / 100% invested and an out asset's fifth sits in
bills rather than being redistributed.
*Departures:* five index substitutions, none exact. S&P 500 → SPY, MSCI
EAFE → EFA, 10-year Treasuries → IEF (slightly shorter duration), NAREIT
→ VNQ, GSCI → DBC. **DBC is the substitution that matters**: it tracks an
optimised-roll index and is a materially different commodity return
stream from the front-month GSCI Faber used; GSG tracks the actual index
and is not in this project's universe. The out-of-market fifth is held
in a bill ETF rather than credited at a paper rate.
*Date ambiguity:* the issue is dated only "Spring 2007". The SSRN working
paper circulated 2006-07 and a reader preferring that date gains about a
year.
*Not a separate strategy:* the Ivy Portfolio's timing overlay **is** this
rule with different funds. It is `Faber2007.ivy_five()`, a robustness
check on one strategy, because in a study whose output is a count of
published rules a double-counted rule is a corrupted denominator.

**`absolute_momentum_12m` — hold while the twelve-month return beats bills.**
Gary Antonacci, SSRN working paper, 2013. Published 2013-04-30.
The primitive underneath the other two: Faber's rule is this comparison
with a moving average standing in for the hurdle, and GEM is this
comparison with a relative-strength choice bolted on top. How much of
either rule's record the primitive earns on its own is the point of
carrying it.
*Departures:* S&P 500 → SPY. The hurdle is a bill ETF's total return
over the same two month-ends where the panel carries one, otherwise a
supplied risk-free series compounded over the window; the paper uses a
T-bill index.
*Date ambiguity:* the SSRN posting day is not pinned in anything this
repository holds. 2013-04-30 is a round-late guess and is documented as
one.

**`antonacci_gem` — Global Equities Momentum.**
Gary Antonacci, *Dual Momentum Investing*, McGraw-Hill, 2014. Published
2014-12-01. If US equities beat T-bills over the trailing twelve months,
hold whichever of US and non-US equities had the higher twelve-month
return; otherwise hold the aggregate bond index. One asset at a time.
*Departures:* MSCI ACWI ex-US → VXUS, the closest fund in this project's
universe. VEU is the conventional choice and is not in it; **EFA is
deliberately not offered as a fallback**, because developed-only excludes
the emerging markets that drive the relative signal in several of the
years that matter.
*The ambiguity is a genuine fork in the source and changes the rule.*
The book's flowchart applies the absolute gate to the S&P 500, so a year
in which US equities lag bills goes to bonds no matter what non-US did.
A common alternative reading applies the gate to the relative winner.
They agree everywhere except that one case — 4 of 86 monthly decisions
on synthetic data. **The flowchart reading is the default**, chosen on
source fidelity before anything was run; `gate_on_winner=True` is the
other. Running both is two trials.
*Date ambiguity:* McGraw-Hill dates the book to November 2014. The 2012
NAAIM Wagner Award paper is the idea's earlier public appearance and
would add two years.

### 6.3 Tactical asset allocation

Six rules, all monthly, all with constants that look arbitrary because
they were fitted before publication.

**`aaa` — Adaptive Asset Allocation.** Butler, Philbrick, Gordillo
(ReSolve, SSRN 2328254), published 2012-12-31. Six-month momentum picks
the top five of ten; long-only minimum variance on sixty daily returns
sizes them.
*Departures:* **unlevered**, where the published presentations size the
minimum-variance portfolio to a volatility target — which is leverage in
a defensive month, so both the return and the volatility here will land
far below the paper's. RWX (international REITs) has no column in this
project's panel and no substitute exists; the run ranks nine of ten and
records the shortfall. The primer's own successor work sweeps one- to
twelve-month lookbacks and top two through five, which is itself
informative: these were never presented as a single fixed claim.
*Date:* **the weakest in the library.** Year precision only; SSRN refuses
datacentre traffic. The attribute is the latest day consistent with what
could be verified. If somebody reads the posting date off SSRN and it is
2013, the attribute moves.

**`paa` — Protective Asset Allocation.** Keller and Keuning, SSRN
2759734, published 2016-04-30. `MOM = p0/SMA13 - 1`; bond fraction
`BF = bad / (N - pf·N/4)` with `pf = 2`; top six of the positive-MOM
names; protection asset IEF.
*Departures:* the SMA window is thirteen month-end closes, following the
careful public replications; the paper's notation admits twelve and that
is a second trial rather than a bug fix. GSG → DBC. Where a line is
missing from the panel the fraction is computed off the number actually
scored, so a short universe changes the crash threshold as well as the
cross-section.

**`vaa` — Vigilant Asset Allocation (G12).** Keller and Keuning, SSRN
3002624, published 2017-07-31. 13612W momentum; B = 4, T = 5; defensive
universe LQD / IEF / SHY.
*Departures:* GSG → DBC. LQD is deliberately in both the offensive and
defensive lists as published, and weight from the two legs is summed.
Bad momentum is non-positive rather than strictly negative, following
the paper's phrasing. The top T are taken on rank alone; the paper does
not additionally require them to be positive, and adding that would be a
second protective rule nobody published.

**`vaa_g4` — Vigilant Asset Allocation (G4).** Same paper. B = 1, T = 1:
if any of four broad asset classes carries non-positive momentum the
whole book goes to a bond fund, otherwise the whole book goes into the
single best of the four. **100% of NAV in one ETF is the rule, not a
rounding of it**, and this row is the reason the tactical family must be
run uncapped.
*Departures:* the co-author's blog gives VOO / VEA / VWO / BND; at least
one replication service uses SPY / EFA / EEM / AGG. The author's own list
is used.

**`daa` — Defensive Asset Allocation (G12).** Keller and Keuning, SSRN
3212862, published 2018-07-31. Canary universe VWO + BND with B = 2;
twelve risky assets, T = 6; defensive SHY / IEF / LQD.
*Departures:* GSG → DBC. **An incomplete canary holds nothing and says
so** — halving B from 2 to 1 would double every protective threshold
while the strategy still called itself DAA. Deliberately stricter than
the treatment of the risky universe, where a missing line is a smaller
cross-section but leaves thresholds intact. The paper's G6, G4, U1 and
U3 variants are **not implemented**: their universes could not be verified
from any reachable source, and an invented universe measured from a real
publication date looks like evidence.

**`gtaa_agg6` — Faber's 2013 aggressive GTAA.** SSRN 962461, Extension 3,
published 2013-02-28. Top six of thirteen by the mean of 1/3/6/12-month
returns, each held only if above its ten-month SMA; a failed slot goes
to cash.
*Departures:* **the thirteen tickers are the least certain thing in the
library.** The paper's universe table is an image in the PDF; the
surrounding text excludes TIPS, high yield, EM bonds, foreign REITs,
fundamental indices, managed futures and currencies, and the backtest
runs on indices from 1973 rather than on ETFs. The list here is a reading
of that sentence and a reader who can see the table should correct it.
IWC and BWX are not in this project's panel, so a run ranks eleven. Cash
slots earn nothing unless a bill fund is passed. The 2x version is not
implemented — this account has no margin.
*Date, stricter reading:* the relative-strength overlay predates the 2013
revision (Faber 2010; *The Ivy Portfolio* 2009). If this row is ever
reported as a clean post-publication measurement, that lineage must be
reported with it.

*Worth putting on the record:* `gtaa_agg6` scores four horizons equally,
giving the most recent month about eighteen per cent of the score;
`vaa` reads the same four horizons and weights them 12/4/2/1, giving the
most recent month about forty per cent. Two published momentum measures,
four years apart, both described in public as twelve-month momentum,
differing by better than a factor of two about what last month is worth.
Measuring both from their own dates is exactly what this study is for.
Reconciling them would be the thing it exists to avoid.

### 6.4 Risk-based allocation

Four books built from a covariance matrix. **Nothing in this family
inverts a matrix**: minimum variance and maximum diversification are
convex programs over the unit simplex solved by accelerated projected
gradient, and equal risk contribution is solved by cyclical coordinate
descent on Spinu's log-barrier form. A near-singular estimate therefore
costs iterations and never accuracy.

The covariance is this repository's own: a Ledoit-Wolf shrunk
correlation over 252 sessions combined with a 63/252 volatility blend,
floored. That is a departure from all four papers, applied uniformly so
that differences between results are differences between strategies. It
biases toward the naive inverse-volatility answer, and it bites hardest
on maximum diversification, which loads on the least-correlated pairs —
exactly the edge shrinkage dulls.

**`risk-parity-unlevered`.** Qian, PanAgora white paper, September 2005.
`w_i ∝ 1/σ_i`.
*Departures:* **not levered, and that is the strategy.** Qian's
construction reaches an equity-like return by scaling the risk-balanced
book up, typically to 10-12% volatility using futures or financing. This
account has neither, so what is measured is the unlevered core, whose
expected return is lower roughly in proportion to the volatility not
taken. Also the naive inverse-volatility book, which ignores correlation
and coincides with true risk parity only when every pair is equally
correlated. Asset classes are ETF proxies rather than futures.

**`equal-risk-contribution`.** Maillard, Roncalli and Teïletché, *JPM*
36(4), Summer 2010. The correlation-aware version of the above, kept
separate so the difference can be measured rather than assumed: naive
inverse-vol sees three quiet series in IEF, TLT and LQD and loads all
three; ERC sees the covariance and cuts the duration concentration.
*Departures:* unlevered, as above. Shrunk covariance rather than the
sample matrix. No rebalancing calendar is imposed, because the rule
specifies none.
*Date:* the journal issue. A 2008 SSRN working paper would be earlier;
the journal date costs about twenty months and cannot flatter the
strategy, since those months sit at the start of the decay being looked
for.

**`minimum-variance`.** Haugen and Baker, *JPM* 17(3), Spring 1991, over
the eleven US sector SPDRs.
*Departures:* **the universe is a weak stand-in.** Haugen and Baker
optimise over a thousand-stock cross-section; most of the variance a
minimum-variance optimiser removes is idiosyncratic, and a sector ETF has
already diversified that away before the optimiser sees it. Expect a
smaller risk reduction and a weaker tilt than the paper reports. The
cross-section changes shape twice inside the sample (XLRE carved out of
XLF in 2015, XLC out of XLK and XLY in 2018); each is admitted when it
has banked the estimator's window.
*Why a shortfall would not be a refutation:* Frazzini and Pedersen's
betting-against-beta explanation says the low-beta leg earns its premium
per unit of risk, and that the investor who cannot borrow is the reason
the premium exists. We are that investor. Unlevered, this is a Sharpe
claim a long-only account cannot convert into a return claim, and a
shortfall against SPY measures the constraint. The study's contribution
is the size of the shortfall and the size of the risk reduction bought
with it.

**`maximum-diversification`.** Choueifaty and Coignard, *JPM* 35(1), Fall
2008, same sector universe.
*Departures:* the one strategy in this family whose leverage profile we
can match — the published MDP is also long-only and unlevered. Shrunk
covariance, which bites hardest here. Expect concentration: the ratio is
maximised at a corner whenever one asset's correlations dominate
another's, and on a sector book whose pairwise correlations all run high
the subset can be small. That is published behaviour, not a bug.
*Date:* the Fall 2008 issue, dated to 1 October. The exact street date is
not verifiable here and the month either way lands inside the worst
quarter of the financial crisis, which is worth stating rather than
rounding away.

### 6.5 Factor tilts

Fourteen rows, each a single anomaly held at **full weight through one
or more ETFs**. Full weight rather than as a tilt on a core, because a
blended book would be mostly index and measuring it would measure the
index.

Every one is the **long leg only, unlevered**. For HML and for BAB that
is most of the published premium and nearly all of the
market-neutrality. These are market-beta-one equity portfolios that
differ from the index by a tilt, so the honest comparison is against SPY
and not against zero.

**The second trap here is the marketing copy.** Three of these funds are
plainly not the paper they are sold against, and each says so:

- **QUAL** sorts on return on equity, debt to equity and earnings
  variability. Novy-Marx's signal is gross profits over assets. **No US
  ETF implements it.** A divergence between QUAL and RMW is at least as
  likely to be signal definition as decay.
- **RSP** equal-weights the S&P 500, whose smallest member is a
  large-cap. Banz's premium lived in the smallest NYSE decile, which is
  microcap. RSP against SPY is mostly a concentration read — in 2023-24
  essentially all it measures.
- **USMV / SPLV** are the unlevered long leg of a levered long-short
  claim. Frazzini and Pedersen reported a US BAB Sharpe near 0.78 for a
  construction unavailable to this account at any price.

Other departures worth stating: **VLUE and QUAL are sector-neutral**
where the academic sorts were not, which removes a large part of what
the academic factor actually did. **IWD and VTV are style indices**, cap-
weighted halves of the large-cap market with a mild lean, a far weaker
dose than a top-decile sort — if HML paid and IWD did not, dilution is
the first explanation to rule out, not decay. **VTV's benchmark changed**
from MSCI to CRSP in 2013; that is an index transition inside the series,
not a mandate change, so the gate is not moved. **PRF** is the most
faithful line in the family: long-only, unlevered, and the paper's own
construction commercialised, nine months after publication.

**SPHQ is the most dangerous line in the library** and is the reason
`investable_from` exists as a separate field. It has run at least three
strategies under one symbol: a Value Line timeliness fund from December
2005, an S&P high-quality-rankings mandate around 2011, and the S&P 500
Quality Index from 2019. The pre-2011 tape is not a quality series, and a
measurement beginning at the listing date measures the wrong fund. The
gate is set to 2012-01-03, **deliberately conservative rather than
precise**, discarding about six years of tape. See section 10.

The three **blends are syntheses, not replications**, and are labelled as
such: the components are published, the equal-weight recipe is ours.
Equal weighting is chosen because it is the only combination rule that
expresses no view. A blend holds nothing until every leg is investable —
a partial blend is a different strategy and no weight vector can say so.
`multifactor_six` is equal weighted in **vehicles**, which is not equal
weighted in **exposures**: PRF, RSP and VLUE triple-count the
value-and-size corner. No correction is applied, because correcting it
needs an exposure model nobody published.
`multifactor_longest` has **no momentum leg**, because no momentum ETF
existed when it became investable. That absence is the finding, not an
omission.

Where Kenneth French publishes a comparable series it is named
(`Mom`, `HML`, `RMW`, `SMB`), so realised ETF returns can be set beside
the frictionless academic long-short over the same window and the
difference read as implementation shortfall. **Low volatility has no
French series**, and the absence is recorded rather than filled with a
near neighbour — the whole value of that comparison is that it is the
same factor.

---

## 7. What the library deliberately does not contain

- **No Ivy Portfolio class.** The timing overlay is Faber (2007) with
  different funds. One idea, one row.
- **No DAA G6 / G4 / U1 / U3.** Universes unverifiable.
- **No levered variants** of anything, including GTAA's 2x extension and
  every risk-parity construction as published. This account has no
  margin and a levered replication would measure an account nobody here
  can open.
- **No shorts, no inverse products.**
- **No IWM or IJR substituted for RSP**, though both fit Banz's claim
  better. They are named in `as_published` so a later run can add them as
  their own lines. Swapping a vehicle for one that fits the story better
  is the first move this study exists to observe.
- **No screened 1/N.** A minimum-history or minimum-liquidity screen
  would make the naive control a strategy with an unstated selection
  rule.

---

## 8. The trial ledger

Every place a source admits two readings. Running both is **two trials**
and each owes the deflated Sharpe a row. Enumerated here, before any
result, so the count cannot be revised downward afterwards.

| # | Strategy | Fork | Implemented default | The other reading |
|---|---|---|---|---|
| 1 | 60/40 | rebalancing frequency | both run, both reported | — |
| 2 | 60/40 | bond leg | IEF | AGG |
| 3 | permanent_portfolio | band check frequency | every close | annually |
| 4 | antonacci_gem | which leg the absolute gate reads | S&P 500 (the book's flowchart) | the relative winner |
| 5 | paa | SMA window | 13 month-end closes | 12 |
| 6 | paa | protection asset | IEF | SHY/IEF by relative momentum; PAA-CPR |
| 7 | vaa_g4 | ticker set | VOO/VEA/VWO/BND (the author's) | SPY/EFA/EEM/AGG |
| 8 | gtaa_agg6 | the thirteen tickers | this project's reading of the text | whatever the PDF's image table says |
| 9 | gtaa_agg6 | top_n | 6 (aggressive) | 3 |
| 10 | factor blends | rebalanced or drifting | rebalanced | `rebalance=False` |
| 11 | faber_gtaa_10mo | date | 2007-04-30 (journal) | 2006-07 (SSRN) |
| 12 | absolute_momentum_12m | date | 2013-04-30 (round-late) | the actual SSRN posting day |
| 13 | antonacci_gem | date | 2014-12-01 (book) | 2012 (NAAIM Wagner Award) |
| 14 | aaa | date | 2012-12-31 | the SSRN posting date, possibly 2013 |
| 15 | gtaa_agg6 | date | 2013-02-28 | 2010 or 2009 via the lineage |
| 16 | equal-risk-contribution | date | 2010-07-01 (journal) | 2008 (SSRN) |
| 17 | equal_weight_universe | date | 2009-05-01 (journal) | the working paper, years earlier |
| 18 | quality_* | date | 2013-04-01 (JFE) | 2010-04 (NBER 15940) |
| 19 | quality_sphq | investable_from | 2012-01-03 (conservative) | the real index-change date, earlier |

---

## 9. Tuning impulses recorded and refused

The honest record of where this study could have become a fishing trip.
Each of these is a change that would plausibly have improved a result,
was noticed by an implementer, and was **not made**.

**Trend**
1. Redistribute an out-asset's fifth among the assets that are in. Would
   raise returns. Faber does not.
2. Shorten DBC's moving-average window because it lists in 2006.
3. Relax the no-trade band so a monthly rebalance lands exactly.
4. Choose GEM's gate default by which reading tested better. Explicitly
   refused; chosen on source fidelity before anything was run, and the
   code reports the divergence rate instead.

**Tactical**
5. Smooth VAA-G12's cash ladder, which goes 0, .2, .4, .6, **1.0** and
   skips 0.8 entirely because `floor(4·5/4)/5 = 1`. That discontinuity is
   the vigilance in the name.
6. Soften PAA's `pf = 2`, which makes the denominator exactly N/2 so six
   bad names out of twelve is a full exit. `pf = 1` is gentler and is
   also in the paper. The headline stays.
7. Add a per-asset cap or a volatility target to AAA, whose
   minimum-variance step concentrates in Treasuries. The target is
   leverage and the cap is not published.
8. Redistribute GTAA's failed slot to the survivors instead of to cash.
   Raises return, and makes the strategy most aggressive exactly when
   fewest assets are trending. Refused in code, with a comment.
9. Reconcile the two "twelve-month momentum" measures that differ by
   better than 2x on what the last month is worth. That contrast is a
   finding.
10. Treat momentum of exactly zero as good rather than bad. The papers
    say non-positive.

**Risk-based**
11. Scale the fully-invested target down to `investable_weight` to
    silence ~5,000 deferral rows per run. That would be the strategy
    peeking at account plumbing and quietly targeting less than full
    investment. Left, and documented: the shortfall is proportional to
    each weight, so it moves the level and never the mix.
12. Invent a rebalancing calendar. None of the four sources specifies
    one for the rule itself; "monthly" would have been a free parameter.
13. Substitute a fallback book when a solver does not converge. The last
    iterate is always feasible; a substituted book attributed to a
    published method is the worse lie.

**Static**
14. Redistribute an absent leg's weight across the survivors so the book
    still sums to one. Invents an allocation nobody published.
15. Screen 1/N for minimum history or liquidity, because ~0.7%-of-NAV
    positions sit just above the no-trade band and the $100 ticket. A
    screened 1/N is not the naive control.
16. Add a first-trading-day rebalance variant. Defensible, and offering
    both as a parameter is offering a dial.

**Factor**
17. Substitute IWM or IJR for RSP, which fit Banz's published claim far
    better. Named, not swapped.
18. Correct `multifactor_six`'s triple weight on the value-and-size
    corner. Needs an exposure model nobody published.
19. Pick the rebalanced or the drifting reading of a blend by which one
    won.

**Method**
20. Exempt the trend family from the 5%/day turnover budget, which binds
    on 16.6% of Faber's sessions. Applied uniformly instead, and the
    constraint is reported.

---

## 10. Open items a runner must settle before the study runs

These are known defects in the specification, not in the code. Each is
recorded because discovering it after results exist would make the
correction indistinguishable from a choice.

1. **`SPMO` is not in `etfuniverse.UNIVERSE`.** `momentum_spmo` cannot be
   run against real bars until it is added.
2. **`RWX`, `IWC`, `BWX` have no column and no substitute.** AAA ranks
   nine of ten, GTAA eleven of thirteen. Both shortfalls are recorded on
   the instance at run time; both must be printed with the result.
3. **`GSG` is substituted by `DBC`** across PAA, VAA and DAA. Different
   index, different energy weight. Reported on `strategy.substituted`.
4. **`quality_sphq.investable_from = 2012-01-03` is a placeholder.**
   Check Invesco's prospectus history and move it to the real date. The
   direction of correction is known (earlier). A wrong date here does not
   degrade gracefully — it silently measures a different fund, and it
   propagates into `multifactor_longest`.
5. **`aaa.published_on` needs the SSRN posting date.** If somebody can
   read it and it is 2013, the attribute moves. It is the whole
   experiment for that row.
6. **`gtaa_agg6`'s thirteen tickers need somebody who can see the PDF's
   table.**
7. **`gtaa_agg6.cash_ticker` defaults to `None`**, so unheld slots earn
   nothing and the strategy is understated by roughly the bill rate times
   time spent out. Pass `SHV` (or add `BIL` to the universe) before
   reporting.
8. **`verify_listings(resolve_universe(...))` has not been run against
   the vendor directory.** Every `listed_on` in the factor family is a
   hand-typed hint. `QUAL`'s 2013-07-16 and `MTUM`/`VLUE`'s 2013-04-16
   are the least certain.

---

## 11. The analysis plan, committed in advance

**What will be reported for every strategy**, from `measurable_from` to
the end of the sample: CAGR, annualised volatility, Sharpe, maximum
drawdown, time invested, one-way annual turnover, realised cost drag in
basis points, and the difference against both `spy_buy_and_hold` and
`sixty_forty_monthly` over the identical window. The undated controls are
measured over each comparison's own window and never appear in the
post-publication table.

**Every row is reported.** There is no shortlist. A study that reports
its best rows has measured the same thing this study exists to detect.

**The trial count is section 8's table**, plus one for every strategy
run, and the deflated Sharpe is computed against it. Thirty trials on
thirty strategies is not thirty independent tests, and the write-up must
say so.

**What will not be done, stated now so it can be checked later:** no
parameter in any strategy will be changed after a result is seen; no
vehicle will be swapped for one that fits a story better; no measurement
window will be moved except to correct a date against a primary source,
and any such correction will be recorded here with its source and its
date; no strategy will be dropped from the table for underperforming; and
no reading from section 8 will be selected on the strength of its result
without both being reported.

**What would make the study's central claim false.** If published
strategies as a group show no post-publication shortfall against their
own claims — if the median row roughly reproduces what its author
reported — then the McLean-Pontiff prior does not transfer to allocation
rules, and that is a publishable answer. The study is designed to be able
to return it.

---

## 12. Verifying this document was not edited after the results

This file is committed to git before any strategy is run against real
bars. Its history is the audit trail: `git log --follow
reports/strategy_library.md` shows every change and when it was made
relative to the commits that produced results. A specification amended
after a result exists is a specification that was fitted, and the
timestamps are what makes that checkable by somebody who does not trust
us.

The machine-readable form is `griffinquant/strategies/registry.py`, which
refuses to register a strategy without an explicit publication date, and
`tests/test_strategies.py`, which parametrises every admissibility test
over the registry so that a strategy added without a test is impossible
rather than merely discouraged.
