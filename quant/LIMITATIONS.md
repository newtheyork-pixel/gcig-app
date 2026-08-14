# Limitations

What this document is for: it is the counterweight to whatever the
results turn out to say. It is written before there is a result, so
that it cannot be trimmed to fit one, and it should read exactly the
same whether the backtest came out well or badly. Everything listed
here is a property of the method. None of it is a property of the
outcome.

The trap it exists to close is that a careful backtest produces
careful-looking output, and care is easy to mistake for evidence.
Every piece of machinery in this repository — the settlement ledger,
the fill held back to the next open, the deflated Sharpe, the trial
ledger with no reset method — removes an explanation for a good
result. Not one of them supplies one. A reader who finishes this page
should know precisely how much a good number here is worth, and the
answer is less than it looks.

## Regime change

The sample opens in 2005 and runs to the present. That window was
chosen to buy the episodes that break things, and it does: one great
financial crisis, one pandemic crash, one inflation shock, and
underneath all of it a fourteen-year stretch in which falling yields
paid the bond sleeves to be a hedge — a stretch that ended in 2022 and
has not resumed.

The thing to hold onto is that each of those is one observation. 2008
contains something like two hundred and fifty sessions, but it is a
single draw of a credit crisis, and a statistic computed across its
sessions has an n far smaller than its T. The same is true of 2020Q1
and of 2022. The named stress windows in `metrics.REPORT_PERIODS` are
not a distribution of crises; they are the four crises that happened,
cut consistently so that runs can be compared with each other.

This bites hardest on the defensive half of the book. Two of the nine
sleeves are Treasury duration and one is investment-grade credit, and
for most of the sample those assets both diversified equity and paid
for the privilege. That relationship was a feature of a particular
monetary regime, not a law. A process fitted across the sample has
been shown the regimes that occurred, and any confidence it expresses
about the ones that can occur is borrowed from a resemblance nobody
has checked.

The three-year holdout in `config.HOLDOUT_YEARS` is the one defence
against this, and it is a weak one on purpose. Three years is a
handful of quarters and one look. If the holdout disappoints and
anything is changed in response, it stops being a holdout, and there
is not a second one waiting.

## Capacity

State it in both directions, because only one of them is flattering.

At the Fund's size the capacity constraints never bind. NAV is about
$131,000. The universe's participation cap — one per cent of a name's
median daily dollar volume — permits a $50,000 position at the $5M
liquidity floor, and the strategy places on the order of $1,300. That
is a fraction of a per cent of a day's volume in the thinnest name the
screen would admit, and essentially nothing in a sleeve ETF. Market
impact at this size is theoretical.

Which means, second direction: this backtest does not test the impact
model. The square-root term in `engine/costs.py` contributes so little
here that a result would look the same if the coefficient were half or
double what it is. Nothing in these numbers validates it. The term is
carried because the same code has to stay honest if the allocation
grows an order of magnitude or if a later version concentrates the
book into three names instead of nine sleeves — and at that size the
design behaves differently in a way this run cannot anticipate. The
turnover budget is five per cent of NAV a day, so the dollars it
permits scale with the account while a name's daily volume does not.
The constraint that never binds today is the first one to bind on a
larger book.

Small size has costs of its own that the model does not reward for
being small. Whole shares, a $100 minimum ticket, and a no-trade band
of half a per cent are all coarser relative to a $131K book than they
would be relative to a large one.

## Simulated fills versus real ones

Fills are modelled at the next session's open, at the printed open
price, charged a liquidity-scaled spread and a square-root impact
estimate. The signal-to-fill separation is enforced in the type system
rather than by convention — a strategy is handed a view already
truncated at its decision close — and that is the one thing about
execution this project can actually guarantee.

Everything else about a real fill is worse in ways the model cannot
see.

The open is an auction, not a price on a screen. The printed open is
the clearing price of a single-price cross that our order was not in.
Putting it in would change it, if only slightly, and there is no
version of this model that captures that.

A limit order may not fill at all. Nothing here ever fails to trade
for want of a counterparty. When the engine declines to fill, the
reason is always one of ours — the turnover budget, settled cash, the
participation cap, a missing bar — never the market's refusal. Partial
fills, likewise, are modelled as our own sizing decision and re-decided
the next morning; a real partial fill is a mid-session event whose
residual either rests or cancels, which is not the same thing at all.

A market order in a gapping name fills where the book is, not where
the print was. And the correlation runs the wrong way for us: the days
the strategy most wants to trade are the days spreads are widest and
depth is thinnest. The cost model reads each name's liquidity as of
the decision close, which is correct as an anti-lookahead measure and
is precisely why it prices a panic morning's trade using the calm
week's median volume.

The cost assumptions themselves are borrowed. The spread curve is
interpolated between three anchor bands, and the impact coefficient is
a prior from the published literature, not a measurement of our own
fills — we have no fills. That is why every result is reported at 1x,
2x and 3x. The ladder is a sensitivity analysis, not a hedge: if the
true cost is 3x, the account pays 3x regardless of which column is
quoted in the write-up.

## Selection with knowledge of history

This is the one to be least comfortable about, and no amount of
engineering elsewhere in the repository touches it.

The nine sleeves were chosen in 2026 by somebody who knows how the
sample ends. He knows gold rose. He knows which ETFs survived, grew,
and stayed liquid enough to be worth naming. He knows that Treasuries
diversified equities for most of the period, and he knows which of the
plausible commodity vehicles is still trading. The point-in-time
discipline in this codebase — as-traded prices for screens, filing
dates for fundamentals, inception dates probed rather than assumed,
splices declared where a vehicle did not yet exist — controls for
using tomorrow's data on today's decision. It does nothing whatsoever
about a universe assembled with the whole chart in view.

It is also unmeasurable from inside the backtest. There is no
diagnostic that reports it, no check in the audit that catches it, and
no statistic that corrects for it. It leaves no trace in the output at
all.

The deflated Sharpe partially addresses a related problem and should
not be mistaken for addressing this one. It counts the trials in
`trials.jsonl`, which are the configurations evaluated after the
counter existed. The choices that constitute the strategy's shape —
the nine tickers, the nine caps, the 2005 start, the asset-class
split, the decision to run sleeves at all — were made before any of
that and are not in the denominator. They were trials. They are simply
untallied ones, and they are almost certainly the ones that matter
most.

## Data

Sleeve prices come from a free quote endpoint, not a point-in-time
vendor. `pyproject.toml` rules out exactly this class of source and
gives four correct reasons: no permanent entity id, no delisted names,
no as-reported fundamentals, and an adjusted series without an
as-traded partner.

Every one of those objections is about a cross-section of single
names, and none of them is decided by a panel of nine large, living,
exchange-traded funds requested by name. That is the whole argument
for the exception, and it holds only while the list stays nine names
long — which is why `SLEEVE_TICKERS` is enforced by a raise rather
than a comment.

Two consequences to keep in view. First, the survivorship checks
cannot pass on this source, and the audit reports them unprovable
rather than clean: the panel loses no dead names because the list
contains no dead names, which is a property of the list and not a
demonstration about the source. Second, nothing anywhere confirms that
these prices are the prices that traded. Every check in the audit
compares the data against itself, against the exchange calendar, and
against the vendor's own record of corporate actions. A consistently
wrong close survives all of it.

Two stretches of the sample are not vehicle history at all. Until BIL
listed on 30 May 2007 the cash sleeve is a bill-rate index compounded
daily, because every ETF substitute carries duration. Until DBC listed
on 6 February 2006 there is no commodity sleeve at all, because the
index alternatives roll differently enough that a proxy would be a
different strategy wearing DBC's name. The first is a substitution and
the second is a hole; both are declared as splices, and any statistic
covering those dates inherits them.

## What is not modelled

- **Taxes.** None, of any kind. If the account is taxable, a
  daily-rebalance process with a five-per-cent turnover budget
  realises gains continuously and the after-tax curve is not the curve
  reported. If it is tax-exempt, as endowment money often is, that
  concern lifts on the domestic side.
- **Dividend withholding on the international sleeves.** Part of it is
  already inside the total-return series, since the fund suffers it at
  the underlying level before NAV is struck. The part a taxable US
  holder could reclaim as a foreign tax credit and a tax-exempt one
  cannot is not modelled, and which of those the Fund is is a fact
  about the account rather than about the code.
- **Fund expense ratios and tracking error.** The sleeves are held as
  their vehicles, so the expense ratio is inside the price series — but
  the tracking difference between a fund and its index, and the days a
  fund trades away from NAV, are not represented anywhere.
- **Commissions.** The cost model charges spread and impact and
  nothing else. Defensible while the broker charges nothing to trade
  US-listed ETFs, and false the day that changes. At an average ticket
  near $1,300, a flat per-trade fee would be a material rate.
- **Trading halts and limit states.** A day on which a name could not
  be traded at any price looks identical to an ordinary day in a
  daily bar.
- **The effect of our own orders.** Prices are exogenous. The book
  trades into the tape without disturbing it, which is nearly true at
  $131K and not true in general.
- **Distribution timing.** Coupons and dividends are reinvested into
  the same security at the close rather than arriving as cash that has
  to settle. The error is small and it flatters: no cash drag, no T+1
  wait on the distribution.
- **Broker fractional-share behaviour.** The engine places whole
  shares. A real broker may support fractions, may support them on
  some tickers, or may round differently — and at this account size
  the indivisible unit of a several-hundred-dollar ETF is a
  non-trivial share of NAV, on the same order as the half-per-cent
  no-trade band. Whichever convention the broker uses, the tracking
  error against this curve is real and is not modelled.

## The deferred layer

The single-name equity layer is unbuilt, and the reason is data rather
than time: it needs a survivorship-free, point-in-time panel with
as-traded prices and filing dates, and the free endpoint that serves
nine ETFs cannot serve a cross-section. The tradability rules in
`config.py` exist and are exercised, but only against synthetic panels
— which demonstrates that the code is correct about a universe we
generated, not that it is correct about the market.

Every result this project produces therefore describes the comparison
branch the brief asks for: the system with Layer 3 switched off. It
says nothing at all about whether single-name selection would add
return or subtract it. Read a good sleeve-only result as a good
sleeve-only result, and do not let it stand in as evidence for the
part that was never built.

## What would raise confidence

Four things, roughly in order of how cheaply they can be had.

**An independent second price source, and a reconciliation.** Every
check that exists today compares the data against itself. Pulling the
same nine series from a second provider and diffing them, bar for bar,
is the only way to turn "internally consistent" into "probably right",
and it is a weekend's work.

**A point-in-time vendor.** Not for the sleeves, which do not need
one, but because it is the precondition for the single-name layer and
for any result that would say something the sleeve-only branch cannot.

**Paper trading before any capital.** This is the only item on the
list that converts a borrowed assumption into a measurement: logging
real decisions against real arrival prices and real fills is what
would replace the impact coefficient with a number of our own, and
what would show how far the next-open model sits from the account's
actual executions.

**Out-of-sample time that has not happened yet.** The three-year
holdout is a proxy for this and a poor one, because it already exists
and can therefore be peeked at, argued with, and — with enough
iterations — fitted. Time that has not occurred is the only sample
nobody can overfit. It is also the only one that arrives at a fixed
rate no amount of work speeds up, which is the honest reason to start
the clock rather than run another variant.
