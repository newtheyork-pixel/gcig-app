"""The fixed-allocation books, which are the controls, and which are
the easiest thing in this project to get quietly wrong.

Nothing in this file forecasts anything. Each strategy here is a weight
vector and a rule for returning to it, and that is the whole of it. They
matter anyway, and they matter more than they look: this project's own
nine-sleeve strategy tied a plain 60/40 on Sharpe and lost to it on
return, which means the 60/40 row was doing the actual work of the
conclusion. A control implemented carelessly does not produce a slightly
wrong control, it produces a wrong verdict about everything measured
against it.

Four traps, each of which has a specific wrong number attached to it.

**"60/40" is not one series.** Rebalancing frequency is a free parameter
that no source states, and it is not a rounding difference: a daily
rebalance sells strength and buys weakness every session and pays for
the privilege, while an annual one lets the equity leg run. So 60/40
appears here TWICE, as two classes, both reported, neither preferred.
Anybody who runs both and quotes the better one has run two trials and
owes the deflated Sharpe two rows.

**The missing leg.** There is no gold ETF before 18 November 2004, no
broad-commodity ETF before 6 February 2006, and no Treasury-bill ETF
before 30 May 2007. The tempting repair is to scale the surviving legs
up so the book still sums to one — and that silently invents an
allocation nobody published. A Permanent Portfolio run as thirds in 2005
is not Browne's portfolio and its result is not evidence about Browne's
portfolio. Here an absent leg is simply not held, the weight becomes
cash, and `absences()` counts the sessions so the report can say "the
cash quarter of this book earned nothing for two and a half years while
real bills paid five per cent" instead of printing a number that assumes
it did.

**The buffer.** The ledger holds back five per cent of NAV, so a target
summing to 1.0 is unreachable and a strategy that asks for it spends the
sample being deferred. Every book here is scaled by `MAX_INVESTABLE`, so
the RATIOS are exactly as published and the residual sits uninvested.
The cost of that convention, stated once and applied identically to
every strategy in the family: five per cent of the book earns nothing
rather than the bill rate, which understates each of these by roughly
five basis points a year in a two per cent world and twenty-five in a
five per cent one.

**Which day of the month.** A monthly rebalance decided on the last
session of the month is a different series from one decided on the
first, and in a momentum-carrying market the difference is not always
small. This file decides at the LAST session of the period and fills at
the first open of the next, because that is the convention the
literature reports and because it is the one that puts the fill on the
turn rather than a day past it. Knowing that a given session is the
month's last requires the exchange calendar, which the NYSE publishes
years ahead — it is not a price and it is not lookahead. Reading it off
the panel WOULD be, which is why it comes from `ledger.is_session` and
never from the frames on the view.

Nothing here is tuned. Every weight comes from its source, the one band
comes from its source, and the two dials that are genuinely ours — the
buffer scale and the deploy tolerance — are stated above rather than
chosen by watching an equity curve.
"""

from __future__ import annotations

import math
from datetime import date
from enum import Enum
from functools import lru_cache
from typing import Any, Mapping

import pandas as pd

from ..data.etfuniverse import UNIVERSE_TICKERS
from ..engine.backtest import BuyAndHold, MarketView
from ..engine.ledger import DEFAULT_BUFFER_FRACTION, is_session

__all__ = [
    "AllWeatherRetail",
    "BuyAndHoldSPY",
    "EqualWeightUniverse",
    "MAX_INVESTABLE",
    "PermanentPortfolio",
    "Rebalance",
    "RebalancedBook",
    "STATIC_MIXES",
    "SixtyForty",
    "SixtyFortyDaily",
    "SixtyFortyMonthly",
    "StaticMix",
    "StaticMixError",
    "catalogue",
]


class StaticMixError(ValueError):
    """A fixed mix was handed something it must not paper over."""


#: The largest gross the ledger will actually fund. A target of 1.0 is
#: not ambitious, it is unreachable: `available_to_buy` subtracts the
#: buffer from settled cash on every purchase, so a book asking for the
#: whole of NAV spends twenty years being deferred by five per cent and
#: logs the shortfall as though the strategy had been starved. Every
#: published vector in this file is multiplied by this figure, which
#: leaves the ratios exactly as published and the residual in cash.
MAX_INVESTABLE: float = 1.0 - DEFAULT_BUFFER_FRACTION

#: Float residue. Anything smaller is the cost of summing five weights.
_EPS = 1e-12


class Rebalance(Enum):
    """How often the book is put back to its published weights.

    A published mix almost never states this, and the omission is not
    small — see the module docstring. Naming the choice as a value on
    the strategy rather than burying it in a comparison operator is what
    lets a result table print the frequency beside the return.
    """

    DAILY = "daily"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    ANNUALLY = "annually"
    #: No calendar rule at all. Either the book is bought once, or a
    #: drift band is doing the deciding.
    NEVER = "never"


# -- the calendar question ----------------------------------------------


@lru_cache(maxsize=8192)
def _last_session_of_month(year: int, month: int) -> pd.Timestamp:
    """The NYSE's last open day in that calendar month.

    Walked backward from the last calendar day rather than derived from
    a business-day offset, because the offsets know weekends and not
    Good Friday — and the two disagree in exactly the months a reader
    would never think to check. Ten days of slack is four more than the
    longest run of consecutive closures the exchange has ever had.
    """
    day = pd.Period(year=year, month=month, freq="M").end_time.normalize()
    for _ in range(10):
        if is_session(day):
            return pd.Timestamp(day)
        day -= pd.Timedelta(days=1)
    raise StaticMixError(
        f"no NYSE session in the last ten days of {year}-{month:02d}; the "
        "exchange calendar this was read from does not cover that month"
    )


def _is_rebalance_session(rule: Rebalance, asof: pd.Timestamp) -> bool:
    """Whether a decision taken at this close is a scheduled one.

    Reads the exchange calendar and never the panel. The distinction is
    the whole causality argument for this file: that 30 April 2010 is
    April's last session was knowable in 2009, whereas anything read off
    the frames would be a claim about what traded.
    """
    if rule is Rebalance.DAILY:
        return True
    if rule is Rebalance.NEVER:
        return False
    day = pd.Timestamp(asof).normalize()
    if rule is Rebalance.QUARTERLY and day.month % 3 != 0:
        return False
    if rule is Rebalance.ANNUALLY and day.month != 12:
        return False
    return day == _last_session_of_month(int(day.year), int(day.month))


# -- the machinery every fixed book shares ------------------------------


class RebalancedBook:
    """Target weights, a schedule, and the patience to reach them.

    Not a strategy by itself: `_wanted` is what a subclass supplies, and
    everything here is the part that would otherwise be written five
    times and be subtly different in three of them.

    Two behaviours are worth understanding before reading a result.

    **A scheduled rebalance does not finish in a day.** The engine moves
    at most five per cent of NAV a session, so deploying a fresh book
    takes about nineteen of them. A strategy that stated its target only
    on the month's last session would therefore stop deploying on the
    first of the month and sit five per cent invested until the next one
    — which is not a monthly rebalance, it is a bug that looks like an
    allocation. So a rebalance ARMS, and the target is restated every
    session until the book actually gets there.

    **Getting there is judged the way the engine judges it.** Arrival is
    per position, because the no-trade band is per position: once every
    asset is within the band the engine would place no trade, and
    restating the target further is noise. Progress is judged in
    aggregate, because the turnover budget is aggregate. Using one
    measure for both questions is how a control quietly turns into a
    daily-rebalanced book — the sum of a hundred and fifty tiny
    deviations never reaches zero, and the strategy would re-ask forever.

    **A stall ends the attempt.** If a full session moves the book less
    than a band's width closer to target, the remaining distance is
    something the account cannot cross — an unpriceable leg, a cap, no
    cash — and asking again tomorrow will not change it. Not having
    moved is the general form of having finished, which is the same
    reasoning `BuyAndHold` uses to latch.
    """

    # -- what this book is, for the study's own table -------------------
    key: str = ""
    title: str = ""
    citation: str = ""
    #: The date the idea entered the public record, and the entire
    #: experiment: post-publication measurement is a stronger
    #: out-of-sample guarantee than any holdout because the date was set
    #: by somebody else and cannot be peeked at.
    #:
    #: None means there is nothing to measure from — a convention with no
    #: author and no date, which is true of 60/40 and of holding SPY. A
    #: fabricated date would be worse than an absent one: it would put a
    #: control into the post-publication table wearing a decay claim
    #: nobody ever made about it. A runner should measure a None over
    #: whatever sample it is given and never report it as evidence of
    #: post-publication decay.
    published_on: date | None = None
    universe: tuple[str, ...] = ()
    rationale: str = ""
    as_published: str = ""

    #: The weights as the source states them, before the buffer scale.
    published_weights: Mapping[str, float] = {}
    rebalance: Rebalance = Rebalance.MONTHLY
    #: (low, high) share of the invested book outside which the source
    #: says to rebalance. None where the source states no band, which is
    #: all of them except Browne.
    band: tuple[float, float] | None = None

    #: Per-position slack below which a target is treated as reached.
    #: Floored by the engine's own no-trade band at use, so on a default
    #: config this constant never binds; it exists so a run with the band
    #: set to zero — a validation sweep — does not chase float residue
    #: forever.
    deploy_tolerance: float = 0.0025

    def __init__(
        self,
        *,
        investable: float = MAX_INVESTABLE,
        rebalance: Rebalance | None = None,
        name: str | None = None,
    ) -> None:
        if not (0.0 < float(investable) <= 1.0):
            raise StaticMixError(
                f"investable {investable!r} is outside (0, 1]. Above one is "
                "leverage written as a fraction; at or below zero there is no "
                "book to hold."
            )
        self.investable = float(investable)
        # Shadows the class attribute deliberately: the class holds
        # what the source says, the instance holds what this run
        # actually did, and one name for the two of them is what
        # keeps a result table from reporting the wrong frequency.
        self.rebalance = rebalance or type(self).rebalance
        self.name = name or self.title or self.key or type(self).__name__
        self.warmup = 0

        # Armed on the first session, because a book that waits for the
        # first month end to start deploying spends up to a month in
        # cash for no reason anybody published.
        self._pending = True
        self._last_remaining: float | None = None
        self._absent: dict[str, int] = {}
        self._events: list[tuple[pd.Timestamp, str]] = []

    # -- what a report asks afterwards ----------------------------------

    def absences(self) -> dict[str, int]:
        """Sessions on which a leg of the published mix had no vehicle.

        The honest half of every result in this file. A Permanent
        Portfolio measured from 2005 has no cash leg for six hundred
        sessions and a report that does not say so is quoting the return
        of a three-legged portfolio under a four-legged name.
        """
        return dict(self._absent)

    def rebalance_log(self) -> pd.DataFrame:
        """Every date the book was put back, and what put it back there.

        For the band strategies this IS the finding — how often Browne's
        rule actually fired over twenty years is a number nobody has to
        take on faith. Two omissions on purpose. Daily rules are not
        logged, because five thousand identical rows are not a record of
        anything and the frequency is already on the strategy. And the
        opening deployment is not an event: there was no book yet to put
        back.
        """
        if not self._events:
            return pd.DataFrame(
                {
                    "date": pd.Series([], dtype="datetime64[ns]"),
                    "reason": pd.Series([], dtype="str"),
                }
            )
        return pd.DataFrame(
            [{"date": d, "reason": r} for d, r in self._events]
        ).astype({"date": "datetime64[ns]", "reason": "str"})

    # -- the protocol ---------------------------------------------------

    def targets(self, view: MarketView) -> Mapping[str, float]:
        assets = view.assets
        current = {a: float(view.weights.get(a, 0.0)) for a in assets}
        live = self._live(view)
        wanted = _fit_to_nav(self._wanted(view, current, live), live)

        reason = self._arm(view, current, live)
        if reason:
            # Logged only on the idle-to-armed edge. A band that is still
            # tripped on the third morning of a rebalance is the same
            # rebalance, and counting it again would report Browne's rule
            # firing hundreds of times when it fired dozens.
            if not self._pending:
                self._record(view.asof, reason)
            self._pending = True
            self._last_remaining = None

        if not self._pending:
            return dict(current)

        tol = max(self.deploy_tolerance, float(view.no_trade_band))
        worst = max((abs(wanted[a] - current[a]) for a in assets), default=0.0)
        # A position the book has decided against leaves whatever the
        # band says, so a target of zero on something still held is not
        # arrival however small the position has become.
        exiting = any(wanted[a] <= 0.0 < current[a] for a in assets)
        if worst <= tol and not exiting:
            self._pending = False
            self._last_remaining = None
            return dict(current)

        remaining = sum(abs(wanted[a] - current[a]) for a in assets)
        stalled = (
            self._last_remaining is not None
            and remaining >= self._last_remaining - tol
        )
        self._last_remaining = remaining
        if stalled:
            self._pending = False
            return dict(current)

        return dict(wanted)

    # -- pieces a subclass supplies or overrides ------------------------

    def _wanted(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> dict[str, float]:
        raise NotImplementedError

    def _band_tripped(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> bool:
        return False

    # -- shared internals -----------------------------------------------

    def _arm(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> str:
        if _is_rebalance_session(self.rebalance, view.asof):
            return self.rebalance.value
        if self._band_tripped(view, current, live):
            return "band"
        return ""

    def _record(self, asof: pd.Timestamp, reason: str) -> None:
        if self.rebalance is Rebalance.DAILY and reason != "band":
            return
        self._events.append((pd.Timestamp(asof), reason))

    def _live(self, view: MarketView) -> dict[str, bool]:
        """Which assets have a usable price at this close.

        Read off the unadjusted close, which is the screening series
        throughout this project: the adjusted one is for returns, and a
        vehicle's tradability on a date is a fact about what a screen
        would have seen. Either way this is only a proxy — the engine
        fills at TOMORROW's open, which is not ours to look at — and the
        cases it is here to catch are the categorical ones, a fund that
        has not listed and a column that is not there.
        """
        px = view.latest("close_unadj")
        out: dict[str, bool] = {}
        for a in view.assets:
            try:
                v = float(px.get(a, float("nan")))
            except (TypeError, ValueError):
                v = float("nan")
            out[a] = math.isfinite(v) and v > 0.0
        return out

    def _note_absence(self, ticker: str) -> None:
        self._absent[ticker] = self._absent.get(ticker, 0) + 1

    def _cap(self, view: MarketView, asset: str) -> float:
        """The engine's ceiling on this name, honoured rather than argued
        with.

        A strategy that cannot see its own cap chases a weight it will
        never be allowed to hold, every session, forever. Note what this
        does to a control though: a 60/40 run under caps written for
        somebody else's strategy is not 60/40, and the fix is to turn
        the caps off in the config rather than to pretend here that they
        are not there.
        """
        caps = getattr(view, "caps", None) or {}
        return float(caps.get(asset, 1.0))


def _fit_to_nav(
    weights: dict[str, float], live: Mapping[str, bool], ceiling: float = 1.0
) -> dict[str, float]:
    """Keep the gross inside NAV by trimming only what can be traded.

    Reachable in one situation and it is not hypothetical: a leg loses
    its price while the rest of the book falls, so the stranded holding
    is a larger share of a smaller NAV than anybody targeted. The engine
    refuses a gross above one outright, and correctly — but the position
    that pushed it there is exactly the one no target can move. So the
    tradable legs give way and the stuck one is left alone, which is the
    only version of this that a fill could actually carry out.
    """
    total = sum(weights.values())
    if total <= ceiling + _EPS:
        return weights
    tradable = sum(w for a, w in weights.items() if live.get(a, False))
    stuck = total - tradable
    room = max(ceiling - stuck, 0.0)
    scale = room / tradable if tradable > _EPS else 0.0
    return {
        a: (w * scale if live.get(a, False) else w) for a, w in weights.items()
    }


class StaticMix(RebalancedBook):
    """A published weight vector, held as published.

    The one rule that governs every subclass: **an absent leg is
    excluded, not redistributed.** If gold has no ETF on this date, the
    gold weight is not held and it becomes cash — it does not become
    more stocks. The other reading is the more attractive code and it
    quietly answers a question the author never asked, which is what a
    replication study exists not to do.

    A leg the book already holds but cannot price today keeps its
    current weight rather than being targeted at zero. Zero would be an
    instruction to sell, there is no price to sell at, and the engine
    would log a postponement every session for a decision nobody made.
    """

    def __init__(
        self,
        *,
        weights: Mapping[str, float] | None = None,
        investable: float = MAX_INVESTABLE,
        rebalance: Rebalance | None = None,
        name: str | None = None,
    ) -> None:
        super().__init__(investable=investable, rebalance=rebalance, name=name)
        raw = dict(weights or self.published_weights)
        if not raw:
            raise StaticMixError(
                f"{type(self).__name__} has no weights. A fixed mix with no "
                "vector is not a degenerate strategy, it is an unfinished one."
            )
        clean: dict[str, float] = {}
        for k, v in raw.items():
            w = float(v)
            if not math.isfinite(w) or w < 0.0:
                raise StaticMixError(
                    f"weight {v!r} on {k!r} is not a long position this "
                    "account can hold"
                )
            clean[str(k)] = w
        gross = sum(clean.values())
        if gross > 1.0 + 1e-9:
            raise StaticMixError(
                f"the published weights sum to {gross:.4f}. Above one is "
                "leverage, and the unlevered version of a levered strategy "
                "has to be written down as such rather than clipped here."
            )
        self.published = clean
        # The ratios survive; the residual becomes cash. See the note on
        # MAX_INVESTABLE for what that costs and why it is uniform.
        self.target = {a: w * self.investable for a, w in clean.items()}

    def _wanted(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> dict[str, float]:
        assets = set(view.assets)
        for a in self.target:
            if a not in assets or not live.get(a, False):
                self._note_absence(a)

        out: dict[str, float] = {}
        for a in view.assets:
            if not live[a]:
                # No price: neither a buy nor a sale is expressible, so
                # the only honest target is what is already there.
                out[a] = float(current.get(a, 0.0))
                continue
            want = self.target.get(a)
            out[a] = 0.0 if want is None else min(want, self._cap(view, a))
        return out

    def _band_tripped(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> bool:
        """Has any leg left the range its author allowed it?

        Measured as a share of the legs that are actually holdable, not
        of NAV and not of the four names on the page. Both exclusions
        are load-bearing: against NAV the uninvested buffer would push
        every share down by five per cent for no reason the author would
        recognise, and counting a leg with no vehicle would report it at
        zero per cent of the book — permanently outside any band, and
        therefore a rebalance signal every single session for as long as
        the fund does not exist.
        """
        if self.band is None:
            return False
        low, high = self.band
        legs = [
            a
            for a, w in self.target.items()
            if w > 0.0 and live.get(a, False)
        ]
        if not legs:
            return False
        invested = sum(float(current.get(a, 0.0)) for a in legs)
        if invested <= _EPS:
            return True
        return any(
            not (low <= float(current.get(a, 0.0)) / invested <= high)
            for a in legs
        )


# -- 60/40 --------------------------------------------------------------


class SixtyForty(StaticMix):
    """Sixty per cent equities, forty per cent Treasuries.

    Abstract only in the sense that it declines to pick a rebalancing
    frequency; the two subclasses do that, and they are the point of the
    pair.
    """

    citation = (
        "No single author. The balanced-fund convention, in the public "
        "domain long before any vehicle in this study listed; Vanguard "
        "Wellington has run something close to it since 1929."
    )
    published_on = None
    universe = ("SPY", "IEF")
    published_weights = {"SPY": 0.60, "IEF": 0.40}
    rationale = (
        "Equities carry the return and intermediate Treasuries carry the "
        "ballast, and the two have historically fallen at different times "
        "and for different reasons. The claim was never that the mix is "
        "optimal — nobody derived it — but that it is the default a "
        "fiduciary would have to justify departing from, which is exactly "
        "what makes it the right thing to measure a departure against."
    )
    as_published = (
        "There is no publication to depart from, so both of the choices "
        "below are ours and neither is free. (1) The bond leg is 7-10 year "
        "Treasuries rather than the aggregate index, matching the 60/40 "
        "this fund already reports against so the new number is comparable "
        "with the old one; an AGG leg carries corporate credit, which "
        "behaves like equity in precisely the weeks the bond leg is being "
        "relied on. (2) Rebalancing frequency is unstated everywhere, so "
        "both a daily and a month-end version are run and reported. "
        "Quoting whichever came back better is two trials and one "
        "reported result, which is the thing this study exists to catch "
        "other people doing."
    )


class SixtyFortyMonthly(SixtyForty):
    key = "sixty_forty_monthly"
    title = "60/40 SPY/IEF, month-end rebalance"
    rebalance = Rebalance.MONTHLY


class SixtyFortyDaily(SixtyForty):
    """The same mix, restated every session.

    Worth keeping beside the monthly one for a reason that is not
    symmetry: a daily rebalance is the version that harvests the
    rebalancing premium in full and pays the full cost of doing it, and
    since this project's cost model is the same for every run in the
    study, the gap between these two rows is a clean read on what that
    trade is worth net of friction at our size.
    """

    key = "sixty_forty_daily"
    title = "60/40 SPY/IEF, daily rebalance"
    rebalance = Rebalance.DAILY


# -- Browne -------------------------------------------------------------


class PermanentPortfolio(StaticMix):
    """Four assets, one for each thing an economy can do to you."""

    key = "permanent_portfolio"
    title = "The Permanent Portfolio"
    citation = (
        "Harry Browne and Terry Coxon, Inflation-Proofing Your Investments, "
        "William Morrow, 1981; restated for a general audience in Harry "
        "Browne, Fail-Safe Investing, St. Martin's Press, 1999."
    )
    #: Pinned to the 1981 book rather than to the Permanent Portfolio
    #: Fund's 1982 launch: the idea is what the study measures, and a
    #: product date would credit the manager with the year the idea had
    #: already been public. The precise month of the 1981 book is not
    #: something this file can verify, and it does not bind — the oldest
    #: vehicle here lists in 1993 and the gold leg in 2004, so the whole
    #: measurable record is post-publication under any reading of 1981.
    published_on = date(1981, 1, 1)
    universe = ("SPY", "TLT", "GLD", "BIL")
    published_weights = {"SPY": 0.25, "TLT": 0.25, "GLD": 0.25, "BIL": 0.25}
    #: Browne's rule as it is usually rendered: put the book back to
    #: quarters whenever any holding leaves 15%-35% of the portfolio.
    band = (0.15, 0.35)
    rebalance = Rebalance.NEVER
    rationale = (
        "Browne's argument is not that the mix earns the most. It is that "
        "an economy is only ever doing one of four things — prosperity, "
        "deflation, inflation, or a recession in money itself — that each "
        "quarter of the book is the asset built for one of them, and that "
        "an investor holding all four never has to forecast which is "
        "coming. The claim being tested is therefore about survival "
        "rather than return, and it should be read against drawdown "
        "first."
    )
    as_published = (
        "Weights are exactly as published. Four substitutions and two "
        "ambiguities. (1) Browne's deflation leg is the long Treasury "
        "bought directly, near 30 years; TLT holds a 20-plus year ladder "
        "whose duration is shorter than a fresh 30-year, so this leg is "
        "less convex than his and will do less in a deflation than he "
        "claimed. (2) The cash leg is Treasury bills, and there is no "
        "bill ETF before 30 May 2007 — so a run starting in 2005 holds a "
        "quarter of the book as uninvested balance earning nothing while "
        "real bills paid about five per cent. That is a large "
        "understatement, it is recorded in absences() rather than "
        "repaired with a substitute, and any result covering those years "
        "has to print it. (3) There is no gold ETF at all before 18 "
        "November 2004; the same rule applies. (4) US equity is SPY, "
        "which is narrower than the total market Browne describes. "
        "Ambiguity one: the source does not say how often the band is "
        "checked, and it is checked here at every close, which is the "
        "literal reading of 'whenever'. Browne is also read as checking "
        "once a year, and that is a different series — recorded here, "
        "not chosen by looking at which one came back better. Ambiguity "
        "two: the band is measured against the legs that can actually be "
        "held, so in the years before the bill ETF exists it is a "
        "three-way band and thirds sit inside 15-35 without tripping."
    )


# -- the retail All Weather ---------------------------------------------


class AllWeatherRetail(StaticMix):
    """The unlevered retail approximation, and not Bridgewater's fund.

    Say it in the class name and say it again in the metadata, because
    this is the strategy in the library most likely to be quoted as
    something it is not. Bridgewater's All Weather balances RISK, which
    for assets less volatile than equities requires borrowing to bring
    them up to the same risk contribution — it is levered, its actual
    weights are not public, and no unlevered book can reproduce it. What
    is implemented here is the fixed five-asset mix a mass-market book
    printed, which is a reasonable approximation of the SHAPE of a risk
    parity book and is not the fund.
    """

    key = "all_weather_retail"
    title = "All Weather (retail approximation)"
    citation = (
        "Tony Robbins, MONEY: Master the Game, Simon & Schuster, 2014 — "
        "the 'All Seasons' portfolio, presented there as derived from a "
        "conversation with Ray Dalio and NOT as Bridgewater's own book."
    )
    published_on = date(2014, 11, 18)
    universe = ("SPY", "TLT", "IEF", "GLD", "DBC")
    published_weights = {
        "SPY": 0.30,
        "TLT": 0.40,
        "IEF": 0.15,
        "GLD": 0.075,
        "DBC": 0.075,
    }
    rebalance = Rebalance.ANNUALLY
    rationale = (
        "The claim is that a portfolio should be balanced by risk rather "
        "than by dollars, and that since a dollar of long Treasuries "
        "carries far less risk than a dollar of equities, a risk-balanced "
        "book holds more dollars of bonds than of stocks — which is why "
        "the weights look upside down to anyone reading them as a return "
        "forecast. Gold and commodities are there for the one environment "
        "in which stocks and bonds fall together, an inflation surprise."
    )
    as_published = (
        "This is a POPULARISED APPROXIMATION and not Bridgewater's All "
        "Weather, which is levered, whose weights are not public, and "
        "which no long-only unlevered account could hold. The difference "
        "is not cosmetic: risk parity's return claim depends on levering "
        "a low-volatility book up to an equity-like risk target, and "
        "without the leverage the same mix keeps the smoother ride and "
        "gives up the return that the leverage was there to restore. So "
        "the comparison this row supports is to the book's own numbers, "
        "never to the fund's. Two implementation notes. Vehicles are the "
        "obvious ones and all five exist well before the 2014 "
        "publication, so the post-publication window has no missing leg. "
        "The book says to rebalance at least once a year and names no "
        "date; this decides on the last session of the calendar year and "
        "fills at the first open of the next."
    )


# -- 1/N ----------------------------------------------------------------


class EqualWeightUniverse(RebalancedBook):
    """One over N, across whatever panel it is handed.

    The naive control every allocation study should carry and most do
    not, and the reason it belongs in a replication library is that it
    is the only strategy here that estimates nothing. Every optimising
    alternative needs a mean and a covariance, both of which have to be
    estimated from the same short history that the optimiser then treats
    as certain, and the estimation error is large enough to swamp the
    optimiser's theoretical advantage.

    N is time-varying and deliberately so. ETFs list through the sample,
    so 1/N in 2005 is one over a much smaller number than 1/N in 2026.
    That is a fact about the ETF market rather than a design choice, and
    a version that froze N to today's list would be holding funds that
    did not exist — survivorship bias arriving through the back door of
    a control.

    `absences()` is empty here by construction and must not be read as
    "every fund existed". This book has no named leg that can go
    missing; a fund that has not listed simply is not one of the N, and
    the coverage question for this row is answered by how N moved
    through the sample rather than by a count of absences.
    """

    key = "equal_weight_universe"
    title = "Equal weight, whole ETF universe (1/N)"
    citation = (
        "Victor DeMiguel, Lorenzo Garlappi and Raman Uppal, 'Optimal "
        "Versus Naive Diversification: How Inefficient is the 1/N "
        "Portfolio Strategy?', Review of Financial Studies 22(5), 2009, "
        "1915-1953."
    )
    #: The journal issue. The working paper circulated for several years
    #: before it, so an earlier date is defensible and would hand the
    #: strategy the 2008 crisis; the journal date is used because it is
    #: unambiguous and is what everyone cites. Which way that cuts is not
    #: knowable in advance, which is the only reason it is safe to pick.
    published_on = date(2009, 5, 1)
    universe = tuple(sorted(UNIVERSE_TICKERS))
    published_weights = {}
    rebalance = Rebalance.MONTHLY
    band = None
    rationale = (
        "The paper's finding is that across seven datasets none of "
        "fourteen optimising models reliably beat an equally weighted "
        "portfolio out of sample, because the estimation error in the "
        "inputs costs more than the optimisation earns. 1/N is not the "
        "paper's proposal — it is the benchmark that survived — and what "
        "entered the public record in 2009 was the claim that it is hard "
        "to beat, which is precisely the kind of claim this study exists "
        "to re-measure."
    )
    as_published = (
        "The paper's cross-sections are equity and factor portfolios, not "
        "an ETF universe, so applying 1/N to this panel is an extension "
        "rather than a replication and should be labelled as one. "
        "Monthly rebalancing follows the paper's design. Two things a "
        "reader has to be told about the result. First, one over roughly "
        "a hundred and fifty names is a target position of about 0.6% of "
        "NAV, which is barely larger than the engine's 0.5% no-trade "
        "band — so after deployment this drifts far more than the phrase "
        "'rebalanced monthly' suggests, and that is the account's "
        "constraint being visible rather than a fault in the rule. "
        "Second, at $131,000 a 0.6% position is about eight hundred "
        "dollars, so the $100 minimum ticket bites on any trim; this "
        "control is closer to buy-and-hold at our size than it would be "
        "at a fund's."
    )

    def __init__(
        self,
        *,
        investable: float = MAX_INVESTABLE,
        rebalance: Rebalance | None = None,
        name: str | None = None,
        exclude: tuple[str, ...] = (),
    ) -> None:
        super().__init__(investable=investable, rebalance=rebalance, name=name)
        # Empty on purpose. Dropping the cash fund, or the leveraged
        # sleeve, or the one that looks wrong, is a screen — and a
        # screened 1/N is not the naive control, it is a strategy with an
        # unstated selection rule.
        self.exclude = frozenset(str(t) for t in exclude)

    def _wanted(
        self,
        view: MarketView,
        current: Mapping[str, float],
        live: Mapping[str, bool],
    ) -> dict[str, float]:
        holdable = [
            a for a in view.assets if live[a] and a not in self.exclude
        ]
        # A held position with no price cannot be sold, so the dollars
        # behind it are not available to spread over the others. Taking
        # them out of the budget rather than out of the arithmetic is
        # what stops the book targeting more than it has.
        stranded = sum(
            float(current.get(a, 0.0)) for a in view.assets if not live[a]
        )
        budget = max(self.investable - stranded, 0.0)
        each = budget / len(holdable) if holdable else 0.0

        out: dict[str, float] = {}
        for a in view.assets:
            if not live[a]:
                out[a] = float(current.get(a, 0.0))
            elif a in self.exclude:
                out[a] = 0.0
            else:
                # Capped rather than redistributed. Handing a capped
                # name's shortfall to the others would make the control
                # a weighting scheme with a rule in it.
                out[a] = min(each, self._cap(view, a))
        return out


# -- the benchmark ------------------------------------------------------


class BuyAndHoldSPY:
    """100% SPY, bought once and left alone.

    A wrapper rather than an implementation. The deployment latch lives
    in `engine.backtest.BuyAndHold` and is not copied here, because the
    latch is the entire difference between buy-and-hold and constant
    mix: a strategy that restates fixed weights every session gets
    rebalanced back to them every session, harvesting a rebalancing
    premium and paying a rebalancing cost that a genuine buy-and-hold
    investor saw neither side of. A second copy of that logic is a
    second place for the hardest benchmark in the table to quietly stop
    being buy-and-hold.
    """

    key = "spy_buy_and_hold"
    title = "100% SPY, bought once"
    citation = "No author. The benchmark."
    published_on = None
    universe = ("SPY",)
    published_weights = {"SPY": 1.0}
    rebalance = Rebalance.NEVER
    band = None
    rationale = (
        "The hardest benchmark in the study and the one most people "
        "actually hold. It pays no turnover after deployment, has no "
        "parameter to fit, and over 2005-2026 returned 10.69% a year — "
        "which is the number every strategy in this library is being "
        "measured against and the number a wide review concluded is not "
        "reliably beatable long-only and unlevered on free data."
    )
    as_published = (
        "Nothing departs. The one convention worth stating is the buffer: "
        "the target is MAX_INVESTABLE rather than 1.0, because the "
        "ledger's five per cent reserve makes a full-NAV target "
        "unreachable and a benchmark that spends the sample being "
        "deferred is not the benchmark. The same scale is applied to "
        "every strategy in this file."
    )

    def __init__(
        self,
        *,
        ticker: str = "SPY",
        investable: float = MAX_INVESTABLE,
        name: str | None = None,
    ) -> None:
        self.ticker = str(ticker)
        self.investable = float(investable)
        self.name = name or self.title
        self.warmup = 0
        self._inner = BuyAndHold(
            {self.ticker: self.investable}, name=self.name
        )

    @property
    def deployed(self) -> bool:
        return self._inner.deployed

    def absences(self) -> dict[str, int]:
        return {}

    def rebalance_log(self) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "date": pd.Series([], dtype="datetime64[ns]"),
                "reason": pd.Series([], dtype="str"),
            }
        )

    def targets(self, view: MarketView) -> Mapping[str, float]:
        return self._inner.targets(view)


# -- the family, as a table ---------------------------------------------


#: Every book in this file, in the order a report should print them:
#: the three rows with no publication date first, because a control is
#: what the rest is read against, then the three that have one and are
#: therefore measurable from it. A runner enumerating this list gets the
#: whole family and cannot quietly omit the one it did not think of.
STATIC_MIXES: tuple[type, ...] = (
    BuyAndHoldSPY,
    SixtyFortyMonthly,
    SixtyFortyDaily,
    PermanentPortfolio,
    AllWeatherRetail,
    EqualWeightUniverse,
)


def catalogue() -> pd.DataFrame:
    """One row per strategy: what it is, who published it, and when.

    The half of the deliverable that is not a return. Nobody has
    assembled published allocations with their dates and their departures
    in one place, and a table that carries the return without the date
    cannot answer the only question this study is asking.
    """
    rows: list[dict[str, Any]] = []
    for cls in STATIC_MIXES:
        weights = dict(getattr(cls, "published_weights", {}) or {})
        band = getattr(cls, "band", None)
        rows.append(
            {
                "key": cls.key,
                "title": cls.title,
                "citation": cls.citation,
                "published_on": (
                    pd.Timestamp(cls.published_on)
                    if cls.published_on is not None
                    else pd.NaT
                ),
                "universe": " ".join(cls.universe) if cls.universe else "",
                "n_assets": len(weights) if weights else len(cls.universe),
                "weights": ", ".join(
                    f"{a} {w:.1%}" for a, w in weights.items()
                ),
                "rebalance": cls.rebalance.value,
                "band": "" if band is None else f"{band[0]:.0%}-{band[1]:.0%}",
                "as_published": cls.as_published,
            }
        )
    return pd.DataFrame(rows).astype(
        {
            "key": "str",
            "title": "str",
            "citation": "str",
            "published_on": "datetime64[ns]",
            "universe": "str",
            "n_assets": "int64",
            "weights": "str",
            "rebalance": "str",
            "band": "str",
            "as_published": "str",
        }
    )
