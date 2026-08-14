"""The factor tilts, held the way an investor could actually hold them,
with the paper's date and the fund's date kept strictly apart.

Every strategy in this file is one line in a study that measures what
happened to published anomalies AFTER they were published. So each
class carries two dates and they are not the same fact. `published_on`
is when the idea entered the record — it is the date McLean & Pontiff's
58% post-publication decay is measured from, and it is set by somebody
else, which is what makes it a stronger out-of-sample guarantee than
any holdout we could design. `investable_from` is when a person with a
brokerage account could first own the thing. Between Jegadeesh and
Titman in March 1993 and MTUM in April 2013 lies twenty years and one
month in which the anomaly was public, tradeable by institutions, and
unreachable through any fund. Whatever momentum did in those twenty
years, no reader of this study earned it.

**The trap this file exists to close is the one-date study.** Point a
factor backtest at ETF data and it begins wherever the fund's tape
begins, reports the window it found, and calls the answer "the momentum
premium". It is not. It is the momentum premium net of two decades of
arbitrage, measured through a product built to be sold, over the
particular decade the product happened to exist. All three of those are
facts about the vehicle rather than the anomaly, and only writing both
dates down keeps them separable. `catalogue()` prints the gap for every
line, and the gap is the most interesting column in it.

**The second trap is the marketing copy.** An ETF is not the paper it
is sold against, and three of the funds here are plainly not. QUAL
sorts on return on equity, debt to equity and earnings variability;
Novy-Marx's signal is gross profits over assets, and no fund implements
it. RSP equal-weights the five hundred largest US companies, whose
smallest member is a large-cap; Banz's premium lived in the smallest
NYSE decile, which is microcap. USMV minimises portfolio variance under
constraints; Frazzini and Pedersen's BAB is a long-short book levered
to beta one. Each class says so in `as_published` rather than letting
the fund's brochure stand as the implementation.

**Everything here is the long leg only, unlevered, at full weight.**
The account is a long-only cash account, so a long-short factor becomes
its long half and loses the short half's contribution entirely — which
for HML and for BAB is most of the published premium and nearly all of
the market-neutrality. What the papers claimed is stated per strategy.
The one number to keep in mind while reading any of them: these are
market-beta-one equity portfolios that differ from the index by a tilt,
so the honest comparison is against SPY and not against zero.

**Full weight means one fund at 100% of NAV, not a tilt on top of a
core.** An investor really would hold MTUM as part of something larger,
and the blended book would be mostly index. Measuring the blend would
measure the index. So the tilt is held alone, which is the only reading
that isolates what is being studied, and it makes every line here a
complete equity allocation rather than an overlay.

**The residual is the ledger's cash buffer and is not an allocation.**
Targets sum to 1.0; the engine's account holds back 5% of NAV as
settled cash and cannot be talked out of it, so a fully deployed book
here sits near 95% invested. That cannot be parked in a bill fund —
the buffer is DEFINED as settled cash — and it applies identically to
every strategy in the study including the buy-and-hold benchmark, so it
is common-mode and cancels in the comparison. It is not a view.

**Where a French series exists, it is named, and the comparison is the
point.** `frenchlib.py` serves the academic long-short factors from
CRSP back to 1926, survivorship-free and frictionless. Set the ETF's
realised return beside the academic factor over the same window and the
difference is implementation shortfall — fees, spread, capacity, the
missing short leg, and the index provider's choices — measured rather
than assumed. This is the cleanest such measurement the project can
make for nothing, and it belongs here because this is where both halves
of it are named in one place. Two cautions travel with it: the French
series is long-short and these funds are long-only, so the two are not
the same portfolio and the difference is not all shortfall; and low
volatility has no series in `frenchlib.DATASETS` at all, which is
recorded as an absence rather than papered over with a near neighbour.

**Journal dating convention.** A monthly or quarterly journal is dated
to the first of its issue month — Spring 1991 becomes 1991-04-01,
March/April 2005 becomes 2005-03-01. The convention is stated once so
that no reader mistakes the day of the month for a finding, and it is
immaterial by construction: no measurement in this study begins within
a month of any publication date here.

**Nothing in this file is tuned.** There is no parameter whose value
could have been chosen by looking at a result. The weights are equal
because equal is the only combination rule that expresses no view; the
vehicles are the ones the specification named; the dates come from
journals and fund prospectuses. The one genuine ambiguity — whether a
multi-fund blend is rebalanced or left to drift — is exposed as
`rebalance` and both readings are meant to be MEASURED, not chosen
between. Choosing by looking at which one won is the exact impulse this
study exists to observe in other people.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd

from ..engine.backtest import BuyAndHold, MarketView

__all__ = [
    "EqualWeightRSP",
    "FACTOR_STRATEGIES",
    "FactorStrategy",
    "FundamentalIndexPRF",
    "LowVolatilitySPLV",
    "LowVolatilityUSMV",
    "MomentumMTUM",
    "MomentumSPMO",
    "MultiFactorIShares",
    "MultiFactorLongestHistory",
    "MultiFactorSix",
    "QualityQUAL",
    "QualitySPHQ",
    "StrategyError",
    "ValueIWD",
    "ValueVLUE",
    "ValueVTV",
    "catalogue",
    "french_reference_gaps",
    "strategy",
    "strategy_class",
    "strategy_keys",
    "universe_gaps",
    "verify_listings",
]


class StrategyError(ValueError):
    """The library was asked for something it must not quietly do."""


#: Weight residue from summing a handful of equal shares. Nothing at
#: this scale is a leverage request.
_EPS = 1e-12

#: The published argument for holding several factors at once rather
#: than picking one, and therefore the date a BLEND entered the record
#: even where every component was older. Asness, Moskowitz and Pedersen
#: is the canonical cite for combining rather than choosing; a blend's
#: own `published_on` is the latest of this and its components, because
#: the combined idea is only as public as its last piece.
_COMBINATION_PUBLISHED = date(2013, 6, 1)

_COMBINATION_CITATION = (
    "Clifford Asness, Tobias Moskowitz and Lasse Pedersen, 'Value and "
    "Momentum Everywhere', Journal of Finance 68(3), June 2013, 929-985"
)


# -- the shape every strategy in this file has ---------------------------


class FactorStrategy:
    """One published factor, held at full weight through one or more funds.

    The mechanics are in this class and the facts are on the subclasses,
    which is the split that keeps a strategy definition down to what a
    reader has to check against a journal and a prospectus. Subclasses
    declare attributes and nothing else.

    Three behaviours are worth understanding before reading any of them.

    **The gate is the vehicle's date, never the paper's.** Nothing is
    held before `investable_from`, because before that date the fund
    either did not exist or did not yet run the mandate — holding it
    would be a fill at a price nobody could get. Nothing is gated on
    `published_on` at all: a run that starts before publication is a
    legitimate and interesting measurement (it is the pre-launch
    backtest Huang, Song and Xiang found returned +2.77%/yr against
    -0.44%/yr after listing), and refusing to produce it would delete
    the comparison rather than protect it.

    **Deployment latches, then the mix is maintained.** The turnover
    budget moves 5% of NAV a day and the ledger holds back a 5% cash
    buffer, so a target of 1.0 is approached over about nineteen
    sessions and never quite reached. A strategy that keeps asking for
    the unreachable last five per cent asks every day forever, and the
    log fills with deferrals that are really just the buffer. So
    deployment is delegated to the engine's own `BuyAndHold`, whose
    latch already knows the three ways deployment can be over; once it
    fires, the equal shares are computed inside the book's achieved
    size rather than inside NAV. A rebalance is then a pure mix
    operation that needs no new money, which is what a rebalance
    actually is.

    **A single fund is buy-and-hold, a blend is a constant mix, and the
    difference is deliberate.** One holding is already equally weighted
    with itself, so there is no mix to maintain and every trade after
    deployment would be invented; a blend of four is a standing
    instruction to keep four things equal, which is a decision its
    holder made and has to keep paying for. The two therefore share this
    class but not this branch, and `rebalance` has no effect on a
    one-fund line because there is nothing there to rebalance.
    """

    #: Short slug. Stable — it is the join key between this library, the
    #: run log and whatever table the study eventually prints.
    key: str = ""
    title: str = ""

    #: Author, title, publication, year. Enough that a reader can find
    #: the paper without searching for it.
    citation: str = ""

    #: When the idea entered the public record. The experiment.
    published_on: date = date(1900, 1, 1)

    #: When the ticker's tape starts. A HINT and not a finding: the true
    #: answer is the vendor's first bar, and `verify_listings` is what
    #: reconciles the two. A hard-coded date that has drifted out of
    #: agreement with the data is exactly the sort of documentation that
    #: gets believed.
    listed_on: date = date(1900, 1, 1)

    #: When holding this ticker first meant holding this idea. Equal to
    #: `listed_on` for a fund that has always run one mandate, and later
    #: for one that did not — see `mandate_changed`.
    investable_from: date = date(1900, 1, 1)

    universe: tuple[str, ...] = ()

    #: The economic claim, as its author made it. Not our gloss on it.
    rationale: str = ""

    #: Every place this implementation departs from the source. Empty
    #: string if none, and empty is rare: a long-only unlevered account
    #: departs from most published factor portfolios by construction.
    as_published: str = ""

    #: Kenneth French series that measure the same underlying factor,
    #: and the `frenchlib.DATASETS` keys that carry them. Empty where
    #: French publishes nothing comparable, which is itself a finding
    #: and not a gap to be filled with a near neighbour.
    french_series: tuple[str, ...] = ()
    french_datasets: tuple[str, ...] = ()

    #: Prose where the ticker has run more than one strategy. Non-empty
    #: means the tape under this symbol is not one series, and any
    #: measurement crossing the change is measuring two things.
    mandate_changed: str = ""

    #: A factor fund does its own sorting, so there is no lookback to
    #: bank. The only warmup that matters here is the vehicle's own
    #: existence, and that is `investable_from`.
    warmup: int = 0

    def __init__(self, *, name: str | None = None, rebalance: bool = True) -> None:
        self._validate()
        self.name = str(name or self.title or self.key)

        # Rebalanced back to equal weight, or bought once and left to
        # drift. No source specifies which, and the two are genuinely
        # different strategies with different published records: the
        # rebalanced version harvests a rebalancing premium and pays a
        # rebalancing cost, the drifting one does neither and ends up
        # owning whichever factor won. Both are meant to be measured.
        # Running both and reporting the better one is not.
        self.rebalance = bool(rebalance)

        # Deployment is the engine's problem and it already solved it.
        # Instantiated per strategy instance, which is why the registry
        # hands out classes and `strategy()` builds a fresh one: a
        # latched instance reused across two runs would start the second
        # run believing it had already bought the book.
        share = 1.0 / len(self.universe)
        self._deploy = BuyAndHold(
            {t: share for t in self.universe}, name=self.name
        )

        # The high-water mark of the book's invested weight. See the
        # long note in `targets`: it exists so that money in transit
        # between a rebalance's sale and its buy is still counted as
        # part of the portfolio.
        self._gross_floor = 0.0

    # -- the facts, derived ---------------------------------------------

    @property
    def measurable_from(self) -> date:
        """The first date a return here can be attributed to anything.

        Later of the paper and the vehicle, and the harness should start
        the run here. Before it, one of the two halves of the claim is
        missing: either the idea was not public and the record is an
        in-sample backtest, or the fund did not exist and the strategy
        holds cash. This class will produce a run from any start date
        given — it sits in cash rather than pretending — but a return
        measured across the cash years is a return divided by dead time.
        """
        return max(self.published_on, self.investable_from)

    @property
    def gap_days(self) -> int:
        """Days between publication and investability. Can be NEGATIVE.

        Negative means the fund predates the paper, which happened: SPHQ
        was running a quality mandate before Novy-Marx's gross
        profitability paper reached the JFE. A negative gap is not an
        error to be clipped to zero — it is the case where the product
        came first and the academic record followed, and it belongs in
        the table with its sign intact.
        """
        return int((self.investable_from - self.published_on).days)

    @property
    def gap_years(self) -> float:
        return self.gap_days / 365.25

    @property
    def n_vehicles(self) -> int:
        return len(self.universe)

    # -- the strategy protocol ------------------------------------------

    def targets(self, view: MarketView) -> Mapping[str, float]:
        """A complete statement of the desired book, as weights of NAV.

        Complete meaning every column of the panel appears, including
        the zeroes. The protocol reads an absent asset as a target of
        zero either way, so the explicit zeros buy nothing today; they
        buy the day somebody adds a leg to a blend and forgets to remove
        it from the other branch, and the book quietly holds it forever.
        """
        panel = view.close_adj
        columns = [str(c) for c in panel.columns]
        known = set(columns)

        missing = [t for t in self.universe if t not in known]
        if missing:
            raise StrategyError(
                f"{self.key}: the panel does not carry {missing}. This "
                f"strategy needs {list(self.universe)}, and a leg silently "
                "dropped from a blend is a different strategy wearing the "
                "same name."
            )

        book = dict.fromkeys(columns, 0.0)
        asof = pd.Timestamp(view.asof).date()

        # Two separate reasons to hold nothing, and they are checked in
        # this order because only one of them is a fact about the world.
        # Before `investable_from` the vehicle did not run this mandate,
        # whatever its tape says. After it, the tape still has to have
        # started — a panel may simply begin later than the prospectus.
        if asof < self.investable_from:
            return book
        if not all(_has_listed(panel, t) for t in self.universe):
            return book

        if not self._deploy.deployed:
            proposed = self._deploy.targets(view)
            if not self._deploy.deployed:
                for ticker in self.universe:
                    book[ticker] = float(proposed.get(ticker, 0.0))
                return book

        live = {
            t: max(float(view.weights.get(t, 0.0)), 0.0) for t in self.universe
        }
        gross = min(sum(live.values()), 1.0)

        # A latched book holding nothing has finished deploying without
        # deploying, which the engine's `stalled` clause allows for
        # reasons of its own. Maintaining the mix of an empty book would
        # target zero forever and quietly retire the strategy, so the
        # deployment weights are proposed again instead. This cannot
        # churn — a book that could not be bought still cannot be — and
        # it fails toward asking rather than toward silence.
        if gross <= max(view.no_trade_band, _EPS):
            share = 1.0 / len(self.universe)
            for ticker in self.universe:
                book[ticker] = share
            return book

        # One fund is buy-and-hold and there is no second reading of it.
        # A mix of one holding is already equal, so there is nothing to
        # rebalance, and any trade after deployment would be the model
        # inventing one out of an accounting artefact — the cash buffer
        # is the account's requirement, not an allocation the strategy
        # chose, and topping a position up out of it is a decision
        # nobody published. An explicitly drifting blend takes the same
        # branch for the same reason.
        if len(self.universe) == 1 or not self.rebalance:
            book.update(live)
            return book

        # The size of the book a rebalance is measured against, and the
        # reason it is not simply today's gross.
        #
        # A rebalance sells the heavy leg today and buys the light ones
        # with the proceeds the day after, because that is what T+1
        # means. In between, the sold money is in transit: it is not in
        # a position, so it is not in `view.weights`, and a target
        # recomputed from live weights alone reads its own sale as a
        # permanent shrinking of the portfolio. The light legs are then
        # sized against the smaller book, the proceeds are never fully
        # re-invested, and every rebalance ratchets a little more of the
        # account into cash — measured at 95% invested falling to 73%
        # over three years, which is a slow leak that looks exactly like
        # a strategy quietly underperforming.
        #
        # So the reference is the largest gross this book has held,
        # which the in-transit cash cannot reduce. It rises freely with
        # appreciation, so the rule never forces a sale to rebuild a
        # cash weight the account did not ask for, and it is clipped at
        # one, so it cannot manufacture leverage on a day the book has
        # fallen — it can only ask to be as invested as it has already
        # been, which is what a constant mix says.
        floor = min(max(self._gross_floor, gross), 1.0)
        self._gross_floor = floor

        share = floor / len(self.universe)
        for ticker in self.universe:
            book[ticker] = share
        return book

    # -- housekeeping ---------------------------------------------------

    def as_row(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "title": self.title,
            "citation": self.citation,
            "published_on": pd.Timestamp(self.published_on),
            "listed_on": pd.Timestamp(self.listed_on),
            "investable_from": pd.Timestamp(self.investable_from),
            "measurable_from": pd.Timestamp(self.measurable_from),
            "gap_days": self.gap_days,
            "gap_years": self.gap_years,
            "n_vehicles": self.n_vehicles,
            "universe": " ".join(self.universe),
            "french_series": " ".join(self.french_series),
            "french_datasets": " ".join(self.french_datasets),
            "mandate_changed": self.mandate_changed,
            "rationale": self.rationale,
            "as_published": self.as_published,
        }

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(key={self.key!r}, "
            f"universe={self.universe!r}, "
            f"published={self.published_on.isoformat()}, "
            f"investable={self.investable_from.isoformat()})"
        )

    def _validate(self) -> None:
        """Refuse to build a strategy that cannot be checked.

        Every field here is one a reader has to be able to verify
        against a source. A registered strategy with an empty citation
        is not a small omission — it is a row in the study's table that
        nobody can trace, which is the one thing this study cannot
        contain.
        """
        for field in ("key", "title", "citation", "rationale"):
            if not str(getattr(self, field, "")).strip():
                raise StrategyError(
                    f"{type(self).__name__} has no {field}. A strategy whose "
                    "source cannot be read off the class is not measurable "
                    "evidence about anything."
                )
        if not self.universe:
            raise StrategyError(f"{self.key}: no vehicle to hold")
        if len(set(self.universe)) != len(self.universe):
            raise StrategyError(
                f"{self.key}: {list(self.universe)} names a ticker twice, "
                "which would give one fund two equal shares of the book"
            )
        sentinel = date(1900, 1, 1)
        for field in ("published_on", "listed_on", "investable_from"):
            if getattr(self, field) == sentinel:
                raise StrategyError(
                    f"{self.key}: {field} was never set. The two dates ARE "
                    "the experiment; a placeholder here would produce a "
                    "number with no window attached to it."
                )
        if self.investable_from < self.listed_on:
            raise StrategyError(
                f"{self.key}: investable_from {self.investable_from} precedes "
                f"listed_on {self.listed_on}. A fund cannot run a mandate "
                "before it has a tape."
            )
        if self.mandate_changed and self.investable_from == self.listed_on:
            raise StrategyError(
                f"{self.key}: a mandate change is recorded but "
                "investable_from still equals the listing date, so the gate "
                "would hold the fund through a strategy it was not running."
            )


def _has_listed(panel: pd.DataFrame, ticker: str) -> bool:
    """Has this fund ever printed a usable close at or before now?

    Monotone by construction — the panel only grows and a bar that
    printed does not unprint — so this needs no state and gives the same
    answer under truncation, which is what keeps the causality test
    honest.

    The last row is checked first and answers on nearly every call. The
    full scan is for the two days that matter: the session before the
    fund lists, and a hole in the tape of a fund that has. Those are
    different facts and must not collapse into each other, because
    exiting a real position on a missing bar would be a full liquidation
    caused by a data gap.
    """
    column = panel[ticker]
    last = column.iloc[-1]
    if pd.notna(last) and float(last) > 0.0:
        return True
    return bool((column > 0.0).any())


# -- momentum -----------------------------------------------------------


class MomentumMTUM(FactorStrategy):
    """Buy what has been going up, through the fund that sorts on it."""

    key = "momentum_mtum"
    title = "momentum tilt (MTUM)"
    citation = (
        "Narasimhan Jegadeesh and Sheridan Titman, 'Returns to Buying "
        "Winners and Selling Losers: Implications for Stock Market "
        "Efficiency', Journal of Finance 48(1), March 1993, 65-91"
    )
    published_on = date(1993, 3, 1)
    listed_on = date(2013, 4, 16)
    investable_from = date(2013, 4, 16)
    universe = ("MTUM",)
    french_series = ("Mom",)
    french_datasets = ("mom_monthly", "mom_daily")
    rationale = (
        "Stocks that have outperformed over the last three to twelve "
        "months keep outperforming over the next three to twelve. "
        "Jegadeesh and Titman sorted NYSE and AMEX stocks on prior "
        "six-month return, held for six months, and earned about 1% a "
        "month on the winners-minus-losers spread over 1965-1989 — a "
        "return they could not attribute to systematic risk or to lead-lag "
        "effects among firm sizes, and read instead as the market "
        "underreacting to firm-specific news and correcting slowly."
    )
    as_published = (
        "Long only, so this is the winner leg alone: the paper's headline "
        "1% a month is a spread against the losers, and roughly half of it "
        "historically came from the short side, which this account cannot "
        "hold. Long-only momentum is also a market-beta-one equity "
        "portfolio, so the comparison is SPY and not zero.\n"
        "MTUM is not the paper's portfolio. It tracks the MSCI USA "
        "Momentum Index, which scores on six- and twelve-month "
        "risk-adjusted price momentum, rebalances semi-annually with an "
        "ad-hoc rebalance rule after volatility spikes, and applies "
        "turnover and concentration constraints the paper did not have. "
        "Those constraints are what make it holdable at scale and they "
        "damp the signal.\n"
        "The gap is the finding. Twenty years and one month passed "
        "between the paper and the fund, during which momentum was public "
        "and reachable only through a separate account or a hedge fund. "
        "Nothing measured here covers that period, and no reader of this "
        "study earned it."
    )


class MomentumSPMO(FactorStrategy):
    """The same anomaly, two and a half years later, through a different
    index provider — which is the only reason it is here.

    Two funds tracking one anomaly is a read on how much of a factor
    ETF's record belongs to the factor and how much to the index
    committee. If MTUM and SPMO diverge materially over their common
    window, the divergence is construction, not momentum.
    """

    key = "momentum_spmo"
    title = "momentum tilt (SPMO)"
    citation = MomentumMTUM.citation
    published_on = MomentumMTUM.published_on
    listed_on = date(2015, 10, 9)
    investable_from = date(2015, 10, 9)
    universe = ("SPMO",)
    french_series = MomentumMTUM.french_series
    french_datasets = MomentumMTUM.french_datasets
    rationale = MomentumMTUM.rationale
    as_published = (
        "Everything said of MTUM applies, with one construction "
        "difference that matters: SPMO tracks the S&P 500 Momentum Index, "
        "which selects roughly a hundred names from the S&P 500 on "
        "twelve-month risk-adjusted momentum excluding the most recent "
        "month, and weights them by momentum score times float "
        "capitalisation. It is a concentrated large-cap sleeve where MTUM "
        "is a constrained broad-market tilt, so it is the higher-variance "
        "expression of the same claim.\n"
        "SPMO is NOT in `etfuniverse.UNIVERSE` as that file stands. It "
        "has to be added there before this strategy can be run against "
        "real bars; `universe_gaps()` reports the absence rather than "
        "leaving it to be discovered as a KeyError halfway through a run."
    )


# -- value ---------------------------------------------------------------


_VALUE_CITATION = (
    "Eugene Fama and Kenneth French, 'The Cross-Section of Expected Stock "
    "Returns', Journal of Finance 47(2), June 1992, 427-465"
)

_VALUE_RATIONALE = (
    "Cheap stocks beat expensive ones, and the cheapness that matters is "
    "book equity over market equity. Fama and French found that beta had "
    "no explanatory power for the cross-section of returns once size and "
    "book-to-market were included, and that the two together absorbed the "
    "leverage and earnings-price effects as well. Their reading was that "
    "book-to-market proxies for a risk the market prices — distress — "
    "rather than for a mistake; the behavioural reading, which they "
    "rejected, is that investors extrapolate poor recent performance too "
    "far. The study is agnostic between the two and measures the return."
)


class ValueVLUE(FactorStrategy):
    """Value through the fund built as a factor product."""

    key = "value_vlue"
    title = "value tilt (VLUE)"
    citation = _VALUE_CITATION
    published_on = date(1992, 6, 1)
    listed_on = date(2013, 4, 16)
    investable_from = date(2013, 4, 16)
    universe = ("VLUE",)
    french_series = ("HML",)
    french_datasets = ("ff3_monthly", "ff3_daily")
    rationale = _VALUE_RATIONALE
    as_published = (
        "Long only, so the expensive leg is not shorted and HML's "
        "published spread is not what is being measured — this is the "
        "cheap half of the market against the whole of it.\n"
        "VLUE tracks the MSCI USA Enhanced Value Index, which scores on "
        "forward price-to-earnings, price-to-book and enterprise value to "
        "cash flow from operations, and — the departure that matters — "
        "does so SECTOR-RELATIVE, holding sector weights near the parent "
        "index. Fama and French sorted across the whole cross-section, so "
        "their value portfolio was free to be a bet on banks and heavy "
        "industry, and often was. Sector neutrality removes a large part "
        "of what the academic factor actually did.\n"
        "Book-to-market is also not among VLUE's three metrics in the "
        "form the paper used it: two of the three are forward-looking or "
        "cash-flow based. The fund is the closest investable expression "
        "of the claim, not an implementation of it."
    )


class ValueIWD(FactorStrategy):
    """Value through the style index that has the history.

    The reason to carry this alongside VLUE is thirteen years of tape.
    IWD covers the 2000-2002 unwind, the 2003-2007 value run, the
    financial crisis and the decade of value's failure that followed;
    VLUE begins in 2013 and sees only the last of those. A study that
    measures value on VLUE alone measures one regime and reports it as
    the post-publication record.
    """

    key = "value_iwd"
    title = "value tilt (IWD)"
    citation = _VALUE_CITATION
    published_on = date(1992, 6, 1)
    listed_on = date(2000, 5, 22)
    investable_from = date(2000, 5, 22)
    universe = ("IWD",)
    french_series = ("HML",)
    french_datasets = ("ff3_monthly", "ff3_daily")
    rationale = _VALUE_RATIONALE
    as_published = (
        "Long only, as with VLUE.\n"
        "IWD is a STYLE index and not a factor product, and the "
        "difference is not cosmetic. Russell splits the Russell 1000 into "
        "value and growth halves by book-to-price and forecast growth, "
        "assigns many stocks partially to both, and weights the result by "
        "capitalisation. So IWD holds about half the large-cap market, "
        "cap-weighted, with a mild cheapness lean — a far weaker dose of "
        "the signal than a top-decile sort. If HML paid and IWD did not, "
        "dilution is the first explanation to rule out, not decay.\n"
        "It is here for its start date. Eight years and two months after "
        "the paper is the shortest publication-to-vehicle gap available "
        "for value, and the run from 2000 is most of the post-publication "
        "record that exists in fund form."
    )


class ValueVTV(FactorStrategy):
    """Value through the cheapest large wrapper anyone actually owns.

    VTV is the vehicle a real investor is most likely to hold, which
    makes it the right third line: whatever the academic factor did,
    this is the version that got bought.
    """

    key = "value_vtv"
    title = "value tilt (VTV)"
    citation = _VALUE_CITATION
    published_on = date(1992, 6, 1)
    listed_on = date(2004, 1, 26)
    investable_from = date(2004, 1, 26)
    universe = ("VTV",)
    french_series = ("HML",)
    french_datasets = ("ff3_monthly", "ff3_daily")
    rationale = _VALUE_RATIONALE
    as_published = (
        "Long only, as above, and diluted in the same way IWD is: VTV "
        "tracks the CRSP US Large Cap Value Index, a cap-weighted half of "
        "the large-cap market selected on a multi-metric value score "
        "including book-to-price, forward earnings-to-price, dividend "
        "yield and sales-to-price. Broad, cheap and mild.\n"
        "It carries one hazard the others do not: VTV's benchmark "
        "changed. The fund tracked an MSCI value index before moving to "
        "CRSP in 2013, so the series crosses a construction change in the "
        "middle. That is not a mandate change — it was a value fund "
        "throughout, which is why the gate is not moved — but a "
        "level-shift in tracking around 2013 is an index transition, not "
        "a factor event."
    )


# -- quality -------------------------------------------------------------


_QUALITY_CITATION = (
    "Robert Novy-Marx, 'The Other Side of Value: The Gross Profitability "
    "Premium', Journal of Financial Economics 108(1), April 2013, 1-28"
)

_QUALITY_RATIONALE = (
    "Profitable firms outperform unprofitable ones, and the measure that "
    "works is gross profits over total assets — revenue less cost of "
    "goods sold, taken before the accounting choices further down the "
    "income statement have had their say. Novy-Marx argued that gross "
    "profitability has roughly the same power as book-to-market, that it "
    "is negatively correlated with it because profitable firms are "
    "expensive, and that the two therefore combine into a portfolio "
    "better than either. His framing was that the value investor holding "
    "only cheap stocks is holding half the strategy."
)


class QualityQUAL(FactorStrategy):
    """Quality through the fund sold as quality, which sorts on something
    else."""

    key = "quality_qual"
    title = "quality tilt (QUAL)"
    citation = _QUALITY_CITATION
    published_on = date(2013, 4, 1)
    listed_on = date(2013, 7, 16)
    investable_from = date(2013, 7, 16)
    universe = ("QUAL",)
    french_series = ("RMW",)
    french_datasets = ("ff5_monthly", "ff5_daily")
    rationale = _QUALITY_RATIONALE
    as_published = (
        "QUAL does not implement the paper. It tracks the MSCI USA Sector "
        "Neutral Quality Index, which scores on return on equity, debt to "
        "equity and earnings variability. Gross profits over assets — the "
        "paper's entire signal, chosen precisely because it sits above "
        "the accounting discretion in the rest of the statement — is not "
        "one of the three. No US ETF implements it. QUAL is the closest "
        "investable proxy for the word 'quality' and is measured as such; "
        "a divergence between QUAL and RMW is at least as likely to be "
        "signal definition as decay.\n"
        "Sector neutral, so the sector bet the academic sort would take "
        "is removed, the same departure VLUE makes.\n"
        "The French comparison is RMW, which is operating profitability "
        "and not gross profitability. Fama and French built RMW after "
        "and partly because of this paper; it is a cousin, not the "
        "series.\n"
        "The dates are the interesting part of this line. The paper "
        "reached the JFE in April 2013 and the fund listed in July 2013, "
        "a gap of about three months — the narrowest in this file after "
        "PRF. Read the working paper (NBER 15940, April 2010) as the date "
        "the idea entered the record and the gap is three years. Both "
        "readings are short, and this is the one factor here whose fund "
        "record is very nearly its whole post-publication record."
    )


class QualitySPHQ(FactorStrategy):
    """Quality through a ticker older than the paper — and older than its
    own mandate.

    This line exists for its history and is the most dangerous one in the
    file, which is why the gate is moved rather than the caveat merely
    written down. See `mandate_changed`.
    """

    key = "quality_sphq"
    title = "quality tilt (SPHQ)"
    citation = _QUALITY_CITATION
    published_on = date(2013, 4, 1)
    listed_on = date(2005, 12, 6)
    investable_from = date(2012, 1, 3)
    universe = ("SPHQ",)
    french_series = ("RMW",)
    french_datasets = ("ff5_monthly", "ff5_daily")
    mandate_changed = (
        "SPHQ has run at least three strategies under one symbol. It "
        "listed in December 2005 as a Value Line timeliness fund, moved "
        "to an S&P high-quality-rankings mandate around 2011, and moved "
        "again to the S&P 500 Quality Index (return on equity, accruals "
        "ratio, financial leverage) in 2019. The pre-2011 tape is not a "
        "quality series and a measurement that begins at the listing date "
        "is measuring the wrong fund."
    )
    rationale = _QUALITY_RATIONALE
    as_published = (
        "Everything said of QUAL applies to the signal: this is not gross "
        "profitability either, and after 2019 it is return on equity, "
        "accruals and leverage.\n"
        "`investable_from` is set to the first session of 2012 rather "
        "than to the listing date, and the choice is deliberately "
        "CONSERVATIVE rather than precise: the exact date of the index "
        "change could not be verified from a primary source here, so the "
        "gate is set safely after every account of it and roughly six "
        "years of tape are discarded. Before pushing this line into the "
        "study's table, check Invesco's prospectus history and move the "
        "date to the real one — the direction of the correction is known "
        "(earlier), and a wrong date here does not degrade the "
        "measurement gracefully, it silently measures a different fund.\n"
        "Note also that this line has a NEGATIVE gap: the vehicle "
        "predates the paper by more than a year. It is the one case here "
        "where the product came first and the academic record followed, "
        "which is the opposite of the decay story and worth reporting as "
        "such."
    )


# -- low volatility ------------------------------------------------------


_LOWVOL_CITATION = (
    "Robert Haugen and Nardin Baker, 'The Efficient Market Inefficiency "
    "of Capitalization-Weighted Stock Portfolios', Journal of Portfolio "
    "Management 17(3), Spring 1991, 35-40; restated and extended by "
    "Andrea Frazzini and Lasse Pedersen, 'Betting Against Beta', Journal "
    "of Financial Economics 111(1), January 2014, 1-25"
)

_LOWVOL_RATIONALE = (
    "Low-risk stocks earn as much as or more than high-risk ones, which "
    "the CAPM says is impossible. Haugen and Baker showed that a "
    "minimum-variance portfolio built from the same universe beat the "
    "capitalisation-weighted index on both return and risk over 1972-1989, "
    "and argued the cap-weighted index is therefore not on the efficient "
    "frontier at all. Frazzini and Pedersen supplied the mechanism: "
    "investors who want more return but cannot or will not borrow bid up "
    "high-beta stocks instead, so beta is overpriced, and a book long "
    "low-beta and short high-beta — each leg levered to beta one — earns "
    "the difference."
)


class LowVolatilityUSMV(FactorStrategy):
    """The low-risk anomaly as an optimiser output."""

    key = "lowvol_usmv"
    title = "low volatility tilt (USMV)"
    citation = _LOWVOL_CITATION
    published_on = date(1991, 4, 1)
    listed_on = date(2011, 10, 18)
    investable_from = date(2011, 10, 18)
    universe = ("USMV",)
    french_series = ()
    french_datasets = ()
    rationale = _LOWVOL_RATIONALE
    as_published = (
        "The BAB half of the claim is not implemented and cannot be. BAB "
        "is long-short and LEVERED — the low-beta leg is levered up to "
        "beta one and the high-beta leg shorted down to it, which is the "
        "entire mechanism, since an unlevered low-beta book simply has "
        "less market exposure. Frazzini and Pedersen reported a US equity "
        "BAB Sharpe near 0.78 over 1926-2012 for that construction. This "
        "account holds the long leg, unlevered, at full weight; it is a "
        "beta-0.7-ish equity portfolio and the published Sharpe is not "
        "available to it at any price. Haugen and Baker's claim, by "
        "contrast, IS long-only and unlevered, which is why it leads the "
        "citation.\n"
        "USMV tracks the MSCI USA Minimum Volatility Index, which is an "
        "optimiser: it minimises predicted portfolio variance subject to "
        "sector, country, turnover and single-name constraints. It is "
        "therefore a low-CORRELATION book as much as a low-volatility "
        "one, and it holds names a naive volatility sort would not.\n"
        "There is no Kenneth French series for this factor. The library "
        "publishes portfolios formed on variance and on residual variance "
        "(`Portfolios_Formed_on_VAR`, `Portfolios_Formed_on_RESVAR`), "
        "neither of which is in `frenchlib.DATASETS` today; BAB itself is "
        "published by AQR rather than by French. The absence is recorded "
        "rather than filled with a near neighbour, because the whole "
        "value of the French comparison is that it is the same factor."
    )


class LowVolatilitySPLV(FactorStrategy):
    """The low-risk anomaly as a plain sort, which is what the papers did.

    SPLV holds the hundred least volatile names in the S&P 500, weighted
    by the inverse of their volatility. No optimiser, no constraints.
    Set beside USMV it separates the anomaly from the machinery: if the
    two diverge, the difference is the optimiser.
    """

    key = "lowvol_splv"
    title = "low volatility tilt (SPLV)"
    citation = _LOWVOL_CITATION
    published_on = date(1991, 4, 1)
    listed_on = date(2011, 5, 5)
    investable_from = date(2011, 5, 5)
    universe = ("SPLV",)
    french_series = ()
    french_datasets = ()
    rationale = _LOWVOL_RATIONALE
    as_published = (
        "Unlevered and long only, with the same consequence set out under "
        "USMV: this is a low-beta equity portfolio, not BAB.\n"
        "SPLV is the more literal reading of Haugen and Baker's sort — a "
        "rank on trailing twelve-month realised volatility, the hundred "
        "lowest, inverse-volatility weighted, rebalanced quarterly — but "
        "it is confined to the S&P 500 and is famously sector "
        "concentrated, running heavy in utilities and staples for years "
        "at a time. A sector bet is what an unconstrained volatility sort "
        "produces, so this is faithful rather than defective; it does "
        "mean SPLV's record over any short window is partly a sector "
        "record.\n"
        "No French series. See USMV."
    )


# -- size, via equal weight ----------------------------------------------


class EqualWeightRSP(FactorStrategy):
    """Equal weight as the only size tilt with real tape — and a warning
    about calling it one."""

    key = "size_rsp"
    title = "equal weight / size proxy (RSP)"
    citation = (
        "Rolf Banz, 'The Relationship Between Return and Market Value of "
        "Common Stocks', Journal of Financial Economics 9(1), March 1981, "
        "3-18"
    )
    published_on = date(1981, 3, 1)
    listed_on = date(2003, 4, 24)
    investable_from = date(2003, 4, 24)
    universe = ("RSP",)
    french_series = ("SMB",)
    french_datasets = ("ff3_monthly", "ff3_daily")
    rationale = (
        "Small firms earn more than large ones, by more than beta can "
        "account for. Banz found that over 1936-1975 the smallest NYSE "
        "firms outperformed the largest by roughly 0.4% a month after "
        "adjusting for risk, that the effect was concentrated in the very "
        "smallest names rather than being linear in size, and that he "
        "could not say whether size was the cause or a proxy for "
        "something unobserved — a caveat generally dropped when the "
        "finding is repeated."
    )
    as_published = (
        "RSP is NOT Banz's portfolio and is not close to it. It equal-"
        "weights the S&P 500, whose smallest constituent is a multi-"
        "billion-dollar company; Banz's premium lived in the smallest "
        "decile of the NYSE, which is microcap and largely untradeable at "
        "size even now. What RSP measures is the size tilt WITHIN large "
        "caps, which is a real and different thing.\n"
        "It is also, as `etfuniverse` says of it, a concentration read as "
        "much as a size read: RSP against SPY is the cleanest available "
        "answer to how much of a given year belonged to the largest few "
        "names, and in 2023-2024 that is essentially all it is measuring. "
        "Attributing an RSP-minus-SPY number to Banz would be a mistake.\n"
        "IWM (Russell 2000, listed 2000-05-22) and IJR (S&P 600, "
        "2000-05-22) are closer proxies for the published claim and are "
        "deliberately NOT substituted here: the specification named RSP, "
        "and swapping a vehicle for one that fits the story better is "
        "the first step of the process this study exists to observe. They "
        "are named so a later run can add them as their own lines.\n"
        "SMB is the French comparison and it is a loose one for the same "
        "reason — SMB is built across the whole CRSP universe including "
        "the microcaps RSP has none of."
    )


# -- fundamental indexation ----------------------------------------------


class FundamentalIndexPRF(FactorStrategy):
    """Weight the index by what companies do, not by what they cost.

    The shortest gap in the file by a wide margin, and that is not an
    accident: the authors ran the firm that launched the fund. Nine
    months from Financial Analysts Journal to a listed product makes PRF
    very nearly a pure post-publication live record, which is exactly
    the specimen McLean and Pontiff's 58% is a claim about.
    """

    key = "fundamental_prf"
    title = "fundamental indexation (PRF)"
    citation = (
        "Robert Arnott, Jason Hsu and Philip Moore, 'Fundamental "
        "Indexation', Financial Analysts Journal 61(2), March/April 2005, "
        "83-99"
    )
    published_on = date(2005, 3, 1)
    listed_on = date(2005, 12, 19)
    investable_from = date(2005, 12, 19)
    universe = ("PRF",)
    french_series = ("HML", "SMB")
    french_datasets = ("ff3_monthly", "ff3_daily")
    rationale = (
        "A capitalisation-weighted index overweights every stock the "
        "market has priced too high and underweights every one it has "
        "priced too low, because the weight IS the price. Arnott, Hsu and "
        "Moore proposed weighting by accounting size instead — book "
        "value, cash flow, sales and dividends — and reported that such "
        "indices beat the S&P 500 by roughly 2% a year over 1962-2004 "
        "with comparable volatility and beta, a gap they attributed to "
        "the price-independence of the weights rather than to any "
        "forecast."
    )
    as_published = (
        "Long only and unlevered, which is what the paper describes, so "
        "this line has no missing short leg. It is the most faithful "
        "implementation in the file.\n"
        "PRF tracks the FTSE RAFI US 1000, which is the paper's own "
        "construction commercialised: the four accounting metrics, "
        "five-year averages, annual rebalance. The departure is that the "
        "paper's backtest used a composite over the whole US market and "
        "the fund takes the thousand largest by that composite.\n"
        "The finding the paper reported is largely a value and size tilt "
        "in disguise, which its critics established quickly and which the "
        "authors dispute: weighting by accounting size relative to price "
        "mechanically buys more of what is cheap and more of what is "
        "small. HML and SMB together are the right French reference for "
        "that reason, and if PRF's excess return over SPY is fully "
        "explained by them, that is the published debate resolving itself "
        "in the data rather than a new finding."
    )


# -- multi-factor blends -------------------------------------------------


def _tickers(parts: Sequence[type[FactorStrategy]]) -> tuple[str, ...]:
    """Every leg of a blend, in the order its parts were listed.

    Order-preserving and de-duplicating rather than a set, because a
    blend's composition is a written-down decision and a set would print
    it back in a different order every interpreter run.
    """
    seen: dict[str, None] = {}
    for part in parts:
        for ticker in part.universe:
            seen.setdefault(ticker, None)
    return tuple(seen)


def _latest_published(parts: Sequence[type[FactorStrategy]]) -> date:
    """When the blend entered the record: the last of its pieces.

    A combination is only as public as its most recent component, and it
    is no more public than the argument for combining at all — so the
    date of `_COMBINATION_PUBLISHED` counts too. Derived rather than
    written down so a blend's date cannot drift out of agreement with
    the parts it is made of.
    """
    return max([_COMBINATION_PUBLISHED, *(p.published_on for p in parts)])


def _latest_listed(parts: Sequence[type[FactorStrategy]]) -> date:
    return max(p.listed_on for p in parts)


def _latest_investable(parts: Sequence[type[FactorStrategy]]) -> date:
    """The blend is investable when its LAST leg is, and not a day before.

    The alternative — start early and equal-weight whatever exists —
    quietly measures a two-fund blend under a four-fund name for the
    first two years. Weights cannot record that and a reader cannot see
    it, so the blend simply holds nothing until it is whole.
    """
    return max(p.investable_from for p in parts)


def _union(values: Iterable[tuple[str, ...]]) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for group in values:
        for item in group:
            seen.setdefault(item, None)
    return tuple(seen)


def _blend_mandates(parts: Sequence[type[FactorStrategy]]) -> str:
    notes = [f"{p.key}: {p.mandate_changed}" for p in parts if p.mandate_changed]
    return "\n".join(notes)


_BLEND_RATIONALE = (
    "Factors do not pay at the same time, and the case for holding "
    "several is the correlation between them rather than the return of "
    "any one. Asness, Moskowitz and Pedersen showed value and momentum "
    "are consistently negatively correlated across eight markets and "
    "asset classes, so a 50/50 combination of the two has a materially "
    "higher Sharpe than either alone even though neither leg improves. "
    "The generalisation — hold the lot, equal weighted, and let the "
    "diversification do the work — is the standard institutional "
    "reading, and it is what a multi-factor product sells."
)

_BLEND_CAVEAT = (
    "No paper publishes this exact blend. Equal weighting is chosen "
    "because it is the only combination rule that expresses no view "
    "about which factor will pay, and because any other rule would need "
    "a parameter this study has no license to choose. That makes the "
    "blend a synthesis rather than a replication, and it is labelled as "
    "one: the components are published, the recipe is ours.\n"
    "The blend holds NOTHING until every leg is investable, rather than "
    "equal-weighting whatever exists so far. A partial blend is a "
    "different strategy and nothing in a weight vector can say so.\n"
    "Rebalanced back to equal weight by default, which harvests a "
    "rebalancing premium and pays a rebalancing cost that a buy-and-hold "
    "investor saw neither side of. Construct with `rebalance=False` for "
    "the drifting reading. Both are meant to be measured and reported; "
    "reporting whichever won is the failure this study exists to detect "
    "in other people's work."
)


class MultiFactorIShares(FactorStrategy):
    """The four iShares MSCI USA factor funds, equal weighted.

    The cleanest blend available: one sponsor, one index family, one
    methodology, four factors. Whatever this line does relative to SPY
    is as close to a controlled test of factor investing as free ETF
    data allows, because the construction choices are held constant
    across the legs.
    """

    _parts = (MomentumMTUM, ValueVLUE, QualityQUAL, LowVolatilityUSMV)

    key = "multifactor_ishares"
    title = "multi-factor blend, iShares MSCI USA (MTUM VLUE QUAL USMV)"
    citation = _COMBINATION_CITATION
    published_on = _latest_published(_parts)
    listed_on = _latest_listed(_parts)
    investable_from = _latest_investable(_parts)
    universe = _tickers(_parts)
    french_series = _union(p.french_series for p in _parts)
    french_datasets = _union(p.french_datasets for p in _parts)
    rationale = _BLEND_RATIONALE
    as_published = (
        _BLEND_CAVEAT
        + "\nEvery departure recorded on the four component classes "
        "applies here unchanged: no short legs, no leverage, sector-"
        "neutral value and quality, an optimised rather than sorted "
        "low-volatility leg, and a quality signal that is not gross "
        "profitability.\n"
        "The blend is investable only from July 2013, when the last of "
        "the four listed. Momentum's paper is from 1993 and low "
        "volatility's from 1991, so this line's record begins twenty "
        "years after half of what it holds became public."
    )


class MultiFactorSix(FactorStrategy):
    """One vehicle per factor, six factors, equal weighted.

    Broader than the iShares blend and less controlled: three index
    families across two sponsors, so construction differences are inside
    the result and cannot be separated from it. It is here because it is
    what an investor building a factor portfolio out of the available
    shelf would actually own.
    """

    _parts = (
        MomentumMTUM,
        ValueVLUE,
        QualityQUAL,
        LowVolatilityUSMV,
        EqualWeightRSP,
        FundamentalIndexPRF,
    )

    key = "multifactor_six"
    title = "multi-factor blend, six factors (MTUM VLUE QUAL USMV RSP PRF)"
    citation = _COMBINATION_CITATION
    published_on = _latest_published(_parts)
    listed_on = _latest_listed(_parts)
    investable_from = _latest_investable(_parts)
    universe = _tickers(_parts)
    french_series = _union(p.french_series for p in _parts)
    french_datasets = _union(p.french_datasets for p in _parts)
    rationale = _BLEND_RATIONALE
    as_published = (
        _BLEND_CAVEAT
        + "\nThe six legs are not six independent factors. PRF is a value "
        "and size tilt by construction, RSP is a size tilt within large "
        "caps, and VLUE is value — so an equal-weighted six carries "
        "something close to a triple weight on the value-and-size corner "
        "and a single weight on momentum. The blend is equal weighted in "
        "VEHICLES, which is not equal weighted in exposures, and no "
        "correction is applied because correcting it would require an "
        "exposure model and a set of choices nobody published.\n"
        "Investable from July 2013, gated by QUAL."
    )


class MultiFactorLongestHistory(FactorStrategy):
    """The longest-history vehicle for each factor that has one — which
    excludes momentum entirely, and that is the finding.

    No momentum ETF existed before 2013. So a multi-factor portfolio
    assembled from what was actually purchasable in 2011 could not
    include the factor with the longest and best-documented academic
    record. This line is that portfolio, and its whole point is the leg
    it does not have.
    """

    _parts = (
        ValueIWD,
        QualitySPHQ,
        LowVolatilitySPLV,
        EqualWeightRSP,
        FundamentalIndexPRF,
    )

    key = "multifactor_longest"
    title = "multi-factor blend, longest histories (IWD SPHQ SPLV RSP PRF)"
    citation = _COMBINATION_CITATION
    published_on = _latest_published(_parts)
    listed_on = _latest_listed(_parts)
    investable_from = _latest_investable(_parts)
    universe = _tickers(_parts)
    french_series = _union(p.french_series for p in _parts)
    french_datasets = _union(p.french_datasets for p in _parts)
    mandate_changed = _blend_mandates(_parts)
    rationale = _BLEND_RATIONALE
    as_published = (
        _BLEND_CAVEAT
        + "\nNo momentum leg, because no momentum fund existed when this "
        "blend became investable. Four of the five legs are value-, "
        "size- or quality-shaped, so this is a defensive value portfolio "
        "with a low-volatility sleeve and should be read as one.\n"
        "SPHQ's mandate history is inherited whole — see "
        "`mandate_changed` — and it is what sets this blend's "
        "`investable_from` at the start of 2012 rather than at SPLV's "
        "May 2011 listing. Correcting SPHQ's date will move this line "
        "too."
    )


# -- the registry --------------------------------------------------------


#: Classes, not instances, and the distinction is load-bearing. A
#: strategy instance carries a deployment latch; handing the same object
#: to two runs would start the second believing the book was already
#: bought, and the second run's first nineteen sessions would silently
#: not happen. `strategy()` builds a fresh one every time.
FACTOR_STRATEGIES: tuple[type[FactorStrategy], ...] = (
    MomentumMTUM,
    MomentumSPMO,
    ValueVLUE,
    ValueIWD,
    ValueVTV,
    QualityQUAL,
    QualitySPHQ,
    LowVolatilityUSMV,
    LowVolatilitySPLV,
    EqualWeightRSP,
    FundamentalIndexPRF,
    MultiFactorIShares,
    MultiFactorSix,
    MultiFactorLongestHistory,
)

_BY_KEY: dict[str, type[FactorStrategy]] = {}
for _cls in FACTOR_STRATEGIES:
    if _cls.key in _BY_KEY:
        raise StrategyError(
            f"two strategies claim the key {_cls.key!r}. The key is the join "
            "between this library and the study's result table, and a "
            "collision there merges two records into one row."
        )
    _BY_KEY[_cls.key] = _cls


def strategy_keys() -> tuple[str, ...]:
    return tuple(_BY_KEY)


def strategy_class(key: str) -> type[FactorStrategy]:
    try:
        return _BY_KEY[key]
    except KeyError:
        raise StrategyError(
            f"no factor strategy named {key!r}. Known: {sorted(_BY_KEY)}"
        ) from None


def strategy(key: str, **kwargs: Any) -> FactorStrategy:
    """A fresh instance. Never cached — see the note on the registry."""
    return strategy_class(key)(**kwargs)


_CATALOGUE_COLUMNS: dict[str, str] = {
    "key": "str",
    "title": "str",
    "citation": "str",
    "published_on": "datetime64[ns]",
    "listed_on": "datetime64[ns]",
    "investable_from": "datetime64[ns]",
    "measurable_from": "datetime64[ns]",
    "gap_days": "int64",
    "gap_years": "float64",
    "n_vehicles": "int64",
    "universe": "str",
    "french_series": "str",
    "french_datasets": "str",
    "mandate_changed": "str",
    "rationale": "str",
    "as_published": "str",
}


def catalogue(
    strategies: Sequence[type[FactorStrategy]] = FACTOR_STRATEGIES,
) -> pd.DataFrame:
    """Every strategy's two dates and the distance between them.

    Written to be printed and then argued with. The column that carries
    the study is `gap_years`: an anomaly published in 1993 and made
    investable in 2013 had twenty years to be arbitraged before anyone
    could buy it, and any post-publication decay measured on the fund's
    tape is decay measured after the arbitrage had already happened.
    Sorted by that gap, widest first, because the widest gaps are the
    lines whose fund record says least about the paper.
    """
    rows = [cls().as_row() for cls in strategies]
    if not rows:
        return pd.DataFrame(
            {c: pd.Series([], dtype=t) for c, t in _CATALOGUE_COLUMNS.items()}
        )
    frame = pd.DataFrame(rows)[list(_CATALOGUE_COLUMNS)].astype(_CATALOGUE_COLUMNS)
    return frame.sort_values(
        ["gap_days", "key"], ascending=[False, True]
    ).reset_index(drop=True)


# -- reconciliation against the data layer -------------------------------


def _all_tickers(
    strategies: Sequence[type[FactorStrategy]] = FACTOR_STRATEGIES,
) -> tuple[str, ...]:
    return _union(cls.universe for cls in strategies)


def universe_gaps(
    strategies: Sequence[type[FactorStrategy]] = FACTOR_STRATEGIES,
) -> tuple[str, ...]:
    """Tickers this library needs that `etfuniverse.UNIVERSE` does not list.

    Imported lazily, for the reason the engine gives about importing its
    own metrics module: this file must remain readable and testable by
    something that does not want a data layer, and two modules that
    import each other eventually will.

    A non-empty answer is a request, not a failure. Add the names to
    `etfuniverse.UNIVERSE` — they will not resolve against the vendor
    directory until somebody does, and the failure otherwise arrives as
    a missing column in the middle of a run rather than as a sentence
    here.
    """
    from ..data import etfuniverse

    known = set(etfuniverse.UNIVERSE_TICKERS)
    return tuple(t for t in _all_tickers(strategies) if t not in known)


def verify_listings(
    resolved: pd.DataFrame,
    strategies: Sequence[type[FactorStrategy]] = FACTOR_STRATEGIES,
    *,
    tolerance_days: int = 5,
) -> pd.DataFrame:
    """Check every hand-written `listed_on` against the vendor's first bar.

    `resolved` is what `etfuniverse.resolve_universe` returns. The dates
    on these classes were typed from memory of prospectuses and are
    HINTS in exactly the sense `frenchlib.Dataset.expected_start` is one:
    the true answer is the first row of the data, and a hard-coded date
    that has drifted out of agreement with it is documentation that gets
    believed. This is the function that stops that.

    The tolerance is a few days rather than zero because a fund's
    inception date and its first CLEAN bar in a vendor's file are
    legitimately different by a session or two — an inception on a
    Thursday with the first daily print on the following Monday is not a
    discrepancy. Anything beyond that is either a wrong date here or a
    coverage gap there, and both need a person.

    Returns one row per distinct TICKER, not per strategy. A blend's
    `listed_on` is the latest of its legs and is derived rather than
    typed, so checking it against any one leg's first bar would report
    twelve disagreements that are arithmetic rather than error — which
    is the fastest way to teach somebody to stop reading a report.
    Checking each leg once checks every blend built from it.

    Nothing is corrected automatically. A date silently rewritten from
    vendor coverage would make the vehicle's own record unfalsifiable,
    and the point of writing it down was that it could be wrong.
    """
    if "ticker" not in resolved.columns or "first_available" not in resolved.columns:
        raise StrategyError(
            "expected the frame from `etfuniverse.resolve_universe`, with "
            f"'ticker' and 'first_available'; got {sorted(resolved.columns)}"
        )
    vendor = {str(r.ticker): r.first_available for r in resolved.itertuples()}

    # The hint for a ticker comes only from a strategy that holds it
    # ALONE, because that is the only place the date was typed rather
    # than derived. Two single-vehicle strategies disagreeing about one
    # fund's listing date is a contradiction inside this file and is
    # raised here rather than reported as a row — a table cannot say
    # which of the two is the hint.
    hints: dict[str, tuple[date, str]] = {}
    used: dict[str, list[str]] = {}
    for cls in strategies:
        for ticker in cls.universe:
            used.setdefault(ticker, []).append(cls.key)
        if len(cls.universe) != 1:
            continue
        ticker = cls.universe[0]
        prior = hints.get(ticker)
        if prior is not None and prior[0] != cls.listed_on:
            raise StrategyError(
                f"{prior[1]} and {cls.key} both hold {ticker} alone and give "
                f"it different listing dates ({prior[0]} and {cls.listed_on}). "
                "One fund has one tape."
            )
        hints[ticker] = (cls.listed_on, cls.key)

    rows: list[dict[str, Any]] = []
    for ticker in sorted(used):
        hint = hints.get(ticker)
        typed = pd.Timestamp(hint[0]) if hint else pd.NaT
        first = vendor.get(ticker)
        seen = first is not None and pd.notna(first)
        observed = pd.Timestamp(first) if seen else pd.NaT
        delta = (
            int((observed - typed).days)
            if not (pd.isna(observed) or pd.isna(typed))
            else None
        )
        rows.append(
            {
                "ticker": ticker,
                "held_by": " ".join(used[ticker]),
                "listed_on_hint": typed,
                "first_available": observed,
                "difference_days": pd.NA if delta is None else delta,
                # A ticker with no hint or no vendor row has not been
                # checked, and "not checked" must never render as "fine".
                "agrees": False if delta is None else abs(delta) <= tolerance_days,
            }
        )

    frame = pd.DataFrame(rows).astype(
        {
            "ticker": "str",
            "held_by": "str",
            "listed_on_hint": "datetime64[ns]",
            "first_available": "datetime64[ns]",
            "difference_days": "Int64",
            "agrees": "bool",
        }
    )
    return frame.sort_values(["agrees", "ticker"]).reset_index(drop=True)


def french_reference_gaps(
    strategies: Sequence[type[FactorStrategy]] = FACTOR_STRATEGIES,
) -> tuple[str, ...]:
    """Dataset keys these classes name that `frenchlib.DATASETS` lacks.

    The academic-versus-realised comparison is the sharpest measurement
    this study can make, and it dies quietly if a registry key is
    renamed next door — the join returns nothing and the comparison
    simply is not printed. Lazy import, same reasoning as
    `universe_gaps`.
    """
    from ..data import frenchlib

    known = set(frenchlib.DATASETS)
    wanted = _union(cls.french_datasets for cls in strategies)
    return tuple(k for k in wanted if k not in known)
