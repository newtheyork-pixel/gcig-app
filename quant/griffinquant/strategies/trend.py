"""The trend-following family, each rule as its author wrote it.

These are not our strategies. Every parameter below came out of a paper
or a book, and the one job of this file is to state each rule literally
enough that the number it produces from its own publication date forward
is a fact about the rule rather than a fact about us. Nothing here was
chosen because it worked. If a window looks wrong, that is the finding.

**The trap this file exists to close is the monthly rule run daily.**
Faber's signal is a comparison of a MONTH-END close to an average of ten
MONTH-END closes, and Antonacci's is a twelve-month return measured
between two month-ends. Sampled every session instead, both become
different strategies with more trades, more whipsaw and a different
answer — and the difference is invisible in the equity curve, because a
daily 200-day moving-average crossover is a perfectly respectable thing
that simply is not what was published. So the machinery in
`MonthlyRule` does two things and both are load-bearing. It computes
signals only from COMPLETED month-end closes. And between month-ends it
returns the book it already holds, which asks the engine for no trade at
all, rather than restating a fixed target the engine would then
rebalance back to every day.

**Knowing that today is the last trading day of April is not
lookahead.** The engine hands a view truncated at the close of T and no
strategy here reads a bar after it. What decides that T is a month-end
is `exchange_calendars`, through `ledger.is_session` — the published
NYSE holiday calendar, which an investor standing on 30 April 2007 knew
as well as we do. A signal at the month-end close, filled at the first
open of the next month, is exactly the engine's own T to T+1 rule and
exactly Faber's own convention shifted by the one session this project
never lets any strategy have.

**What every strategy here departs from its source in, uniformly.** The
whole point of the study is one method and one cost model, so these are
stated once rather than repeated in every `as_published`:

  - Signals fill at the NEXT OPEN, never at the close that produced
    them. Faber's spreadsheet trades at the signal price. Ours cannot.
  - Trades pay the project's spread-plus-impact model, are rounded to
    whole shares, wait T+1 for their proceeds, and are capped at 5% of
    NAV a day. A published month-end rotation that moves 40% of the
    book therefore takes about eight sessions to complete, and the
    strategy keeps asking for the same target until it arrives.
  - Total-return closes, never prices. This is not a stylistic
    preference: over 2004-2026 TLT returned -2.6% on price and +105.8%
    with coupons, so a ten-month moving average run on an unadjusted
    bond series reports that Treasuries have never trended in their
    lives. It also happens to be what the sources used — Faber's five
    inputs are total-return indices and Antonacci's are too.

**Two configuration traps that silently destroy these rules.**

`BacktestConfig.apply_sleeve_caps` defaults to True, and the sleeve caps
are OUR risk priors for OUR nine-sleeve book: SPY at 40%, DBC at 15%.
GEM wants 100% of NAV in one equity fund and Faber wants 20% in a
commodity pool, so a run under those caps measures our ceiling and not
their rule. Every strategy here checks the ceilings it was handed on its
first decision and REFUSES rather than being quietly clipped for twenty
years. Pass `apply_sleeve_caps=False`, or `caps={...: 1.0}`, or set
`allow_binding_caps=True` and accept that you are measuring the cap.

The second is cash. This engine credits uninvested balance with nothing,
and all three rules spend real time out of the market — Faber's rule was
fully in cash through most of 2008. Crediting that with zero while the
bill paid 2-5% does not make the comparison conservative, it makes it
wrong, and it biases every one of these rules downward against a
buy-and-hold benchmark that was never out. So the residual is HELD, in a
short-bill ETF, whenever the panel carries one. Where it does not the
residual sits uninvested and `cash_held` on the decision record says so,
which is the difference between a modelling choice and a silent one.

**Why there is no Ivy Portfolio class here.** Faber and Richardson's
*The Ivy Portfolio* (Wiley, 2009) presents two things. One is a set of
static endowment-mimicking allocations — Ivy 5, Ivy 10, Ivy 20 — which
are buy-and-hold mixes with no trend rule in them at all and belong to
whatever file holds static allocations, not to this one. The other is
the timing overlay, and the timing overlay IS Faber (2007): the same
ten-month moving average on month-end closes, applied to a list of
vehicles (VTI, VEU, BND, VNQ, DBC) that differs from the 2007 paper's
five indices only in which fund stands in for which asset class. Giving
that its own class would put one idea in the library twice, and in a
study whose output is a count of published rules and how each fared, a
double-counted rule is a corrupted denominator. So the vehicle list is a
constructor argument on `Faber2007` instead — `Faber2007.ivy_five()`
builds the book's version — and it is explicitly a robustness check on
one strategy rather than a second one.

**Dates.** `published_on` is the whole experiment, so where a source is
dated only to a month or a season this file takes the END of that
period. The asymmetry is not fussiness: starting a session too early
admits data the author could still have been fitting on, and starting
too late merely costs sample. Every rounding is named in the class
docstring next to what is actually known.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ..engine.ledger import is_session

__all__ = [
    "AbsoluteMomentum",
    "DEFAULT_CASH_VEHICLES",
    "DualMomentumGEM",
    "Faber2007",
    "Leg",
    "MonthlyDecision",
    "MonthlyRule",
    "StrategyError",
    "TREND_STRATEGIES",
    "month_end_closes",
]


class StrategyError(ValueError):
    """A published rule was asked to run under conditions that change it."""


#: Weight arithmetic tolerance. Below this a difference is the cost of
#: summing five products, not a decision.
_EPS = 1e-9

#: The fewest sessions any US calendar month has ever had, used only to
#: turn "this rule needs ten month-end closes" into a session count the
#: engine can skip on. Deliberately an UNDER-estimate: `warmup` skips
#: decisions outright, so a number that is too large silently throws
#: away days on which the rule could have spoken, while one that is too
#: small merely costs a few cheap calls that abstain on their own.
MIN_SESSIONS_IN_MONTH = 18

#: The most sessions a US calendar month has, used to size the tail of
#: the panel a decision actually reads. An over-estimate here is free.
MAX_SESSIONS_IN_MONTH = 23

#: Short-bill vehicles, best first, for the residual. BIL is the
#: project's own cash sleeve and SHV is what the broad ETF universe
#: carries; SHY is a last resort and is NOT a bill fund — one to three
#: years of duration is a real interest-rate position, so a run that
#: falls through to it should say so rather than call it cash.
DEFAULT_CASH_VEHICLES: tuple[str, ...] = ("BIL", "SHV", "SHY")


# -- the calendar question ----------------------------------------------


@lru_cache(maxsize=8192)
def _is_month_end_session(stamp: pd.Timestamp) -> bool:
    """Is this the last NYSE session of its calendar month?

    Answered from the exchange calendar and from nothing else, which is
    why it is not a leak. The alternative — noticing at the close of 1
    May that 30 April was the last session of April — is causally safe
    too and one session late, and one session is the entire margin this
    project gives a strategy over its own signal.

    Cached because a twenty-year run asks the same question about the
    same five thousand dates once each, and the answer for a date is a
    property of the calendar rather than of the run.
    """
    day = pd.Timestamp(stamp).normalize()
    end = day + pd.offsets.MonthEnd(0)
    probe = day + pd.Timedelta(days=1)
    while probe <= end:
        if is_session(probe):
            return False
        probe += pd.Timedelta(days=1)
    return True


def month_end_closes(
    close_adj: pd.DataFrame, *, complete_only: bool = True
) -> pd.DataFrame:
    """The last bar of each calendar month, NaNs and all.

    `groupby(...).last()` is the obvious spelling and the wrong one: it
    skips nulls per column, so a fund that stopped printing in the
    middle of a month would be handed the price it last traded at as
    though that were its month-end close. Positional selection takes the
    actual last row, and a sleeve that was not there on the last session
    of the month arrives as NaN — which every rule below reads as "no
    signal" rather than as a number.

    With `complete_only`, the current month is dropped unless the final
    row is that month's last session. A partially-elapsed month has no
    month-end close, and treating the fifteenth as one is the daily
    reading of a monthly rule wearing a monthly costume.
    """
    if not isinstance(close_adj.index, pd.DatetimeIndex):
        raise StrategyError("close_adj must be indexed by date")
    if not len(close_adj):
        return close_adj
    periods = close_adj.index.to_period("M")
    tail = np.flatnonzero(np.r_[periods[1:] != periods[:-1], True])
    monthly = close_adj.iloc[tail]
    if complete_only and not _is_month_end_session(close_adj.index[-1]):
        monthly = monthly.iloc[:-1]
    return monthly


# -- what a decision looked like ----------------------------------------


#: The four things a leg can be, and they are four rather than two
#: because "we hold none of this" has four different causes and only one
#: of them is the rule saying no.
LEG_ON = "on"
LEG_OFF = "off"
LEG_ABSENT = "absent"
LEG_UNSCORED = "unscored"


@dataclass(frozen=True)
class Leg:
    """One asset's whole story at one month-end.

    `statistic` and `hurdle` are the two numbers the rule compared and
    they are kept because the weight cannot answer the only question
    anybody asks of it later. For Faber they are the month-end close and
    its ten-month average; for the momentum rules they are a twelve-month
    total return and the bill's return over the same window. Reading
    them side by side is how somebody in six months establishes that a
    sleeve was out by a hair rather than by a mile.
    """

    ticker: str
    weight: float
    status: str
    statistic: float
    hurdle: float
    note: str = ""

    @property
    def held(self) -> bool:
        return self.weight > _EPS


@dataclass(frozen=True)
class MonthlyDecision:
    """The book one month-end signal asked for, and what produced it.

    `signal_month` is the month whose CLOSE the rule read, which is not
    always the month of `asof`: a decision taken on the second of the
    month — because the panel had no bar on the last session of the one
    before — is still acting on the earlier month's close, and a record
    that showed only `asof` would have the rule reading a month it never
    saw.
    """

    asof: pd.Timestamp
    signal_month: pd.Period
    signal_date: pd.Timestamp
    legs: tuple[Leg, ...]
    cash_weight: float
    cash_ticker: str
    cash_held: bool

    @property
    def weights(self) -> dict[str, float]:
        book = {leg.ticker: leg.weight for leg in self.legs}
        if self.cash_held and self.cash_ticker:
            book[self.cash_ticker] = self.cash_weight
        return book

    @property
    def invested(self) -> float:
        return float(sum(leg.weight for leg in self.legs))

    def as_rows(self) -> list[dict[str, Any]]:
        rows = [
            {
                "date": self.asof,
                "signal_month": str(self.signal_month),
                "signal_date": self.signal_date,
                "ticker": leg.ticker,
                "status": leg.status,
                "weight": leg.weight,
                "statistic": leg.statistic,
                "hurdle": leg.hurdle,
                "note": leg.note,
            }
            for leg in self.legs
        ]
        rows.append(
            {
                "date": self.asof,
                "signal_month": str(self.signal_month),
                "signal_date": self.signal_date,
                "ticker": self.cash_ticker or "(uninvested)",
                "status": "cash" if self.cash_held else "uninvested",
                "weight": self.cash_weight,
                "statistic": float("nan"),
                "hurdle": float("nan"),
                "note": (
                    ""
                    if self.cash_held
                    else "the residual is uninvested — no bill vehicle with "
                    "a price at this close, or holding one was switched off "
                    "— so it earns nothing, which understates the rule by "
                    "roughly the bill rate times the time spent out"
                ),
            }
        )
        return rows


_DECISION_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "signal_month": "str",
    "signal_date": "datetime64[ns]",
    "ticker": "str",
    "status": "str",
    "weight": "float64",
    "statistic": "float64",
    "hurdle": "float64",
    "note": "str",
}


def _frame(rows: list[dict[str, Any]], cols: dict[str, str]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
    return pd.DataFrame(rows)[list(cols)].astype(cols)


# -- the shared machinery -----------------------------------------------


class MonthlyRule:
    """Decide on completed month-end closes; hold still in between.

    The base class every rule in this file subclasses, and the reason it
    exists is that the interesting failure is shared. A monthly rule
    driven by a daily engine has to answer the engine on days it has
    nothing to say, and the two obvious answers are both wrong. Restate
    the standing target and the engine rebalances back to it whenever
    drift clears the no-trade band, which is a constant-mix strategy
    nobody published. Return the live book and any month-end rotation
    the 5%-a-day turnover budget could not finish in one session is
    silently abandoned half-done.

    So: after a decision the target stands until the book REACHES it,
    and only then does the rule latch to the live weights for the rest
    of the month. Reaching it is judged on the largest single deviation,
    and a book that stops closing the gap for two sessions running is
    treated as having arrived, for the reason `BuyAndHold` gives about
    its own latch — not having moved is the general form of having
    finished, and waiting for an exact coincidence means rebalancing
    daily until one turns up.

    Three hooks a subclass fills in. `months_required` is how many
    completed month-end closes the rule needs before it will speak.
    `_legs` turns those closes into a weight per asset. `_intended_max`
    is the largest weight the rule could ever ask for on each asset,
    which is checked against the engine's caps on the first decision so
    that a run under a ceiling the rule cannot live with fails on day
    one instead of quietly producing a different strategy's equity
    curve for twenty years.
    """

    # The publication record. Subclasses set every one of these; they
    # are declared here so that a subclass which forgets one is a
    # missing string in a report rather than an AttributeError three
    # thousand sessions in.
    key: str = ""
    title: str = ""
    citation: str = ""
    published_on: date | None = None
    universe: tuple[str, ...] = ()
    rationale: str = ""
    as_published: str = ""

    #: Completed month-end closes needed before the rule has an opinion.
    months_required: int = 1

    def __init__(
        self,
        *,
        name: str | None = None,
        cash_ticker: str | None = None,
        hold_cash: bool = True,
        allow_binding_caps: bool = False,
        deploy_tolerance: float = 0.0025,
        record: bool = True,
    ) -> None:
        self.name = str(name or self.title or type(self).__name__)
        self.cash_ticker = str(cash_ticker) if cash_ticker else None
        self.hold_cash = bool(hold_cash)
        self.allow_binding_caps = bool(allow_binding_caps)
        self.deploy_tolerance = float(deploy_tolerance)
        self.record = bool(record)

        # Sessions the engine may skip before the first decision. See
        # MIN_SESSIONS_IN_MONTH: the first month-end could land on the
        # panel's very first row, so the earliest the Nth can arrive is
        # (N-1) short months later.
        self.warmup = max(int(self.months_required) - 1, 0) * MIN_SESSIONS_IN_MONTH

        self._decisions: list[MonthlyDecision] = []
        self._signal_month: pd.Period | None = None
        self._target: dict[str, float] = {}
        self._latched = False
        self._last_gap: float | None = None
        self._stalls = 0
        self._caps_checked = False

    # -- the record -----------------------------------------------------

    @property
    def decisions(self) -> tuple[MonthlyDecision, ...]:
        """Every month-end the rule spoke on, in order.

        Empty when `record` is off, which is why recording is the
        default: a rule whose weights cannot be explained afterwards is
        a number with no reason attached, and the reason is the part
        anybody will actually be asked for.
        """
        return tuple(self._decisions)

    def decision_frame(self) -> pd.DataFrame:
        """One row per leg per decision, long rather than wide.

        Long because no single column is the answer — the weight, the
        statistic it came from and the hurdle it was measured against
        are three facts about one leg, and a wide frame has to pick one
        of them to be the value.
        """
        rows: list[dict[str, Any]] = []
        for d in self._decisions:
            rows.extend(d.as_rows())
        return _frame(rows, _DECISION_COLUMNS)

    # -- the protocol the engine drives ---------------------------------

    def targets(self, view: Any) -> Mapping[str, float]:
        asof = pd.Timestamp(view.asof).normalize()
        signal_month = self._signal_month_at(asof)

        if signal_month != self._signal_month:
            self._decide(view, asof, signal_month)
        elif self._latched:
            return dict(view.weights)

        # Not latched yet: keep asking for the same book. The engine's
        # turnover budget will not move a 40% rotation in one session,
        # and a rule that went quiet the morning after its own signal
        # would be measured on a book it never actually held.
        gap = self._gap(view.weights)
        tol = max(self.deploy_tolerance, float(view.no_trade_band))
        stalled = self._last_gap is not None and gap >= self._last_gap - 1e-4
        self._stalls = self._stalls + 1 if stalled else 0
        self._last_gap = gap
        if gap <= tol or self._stalls >= 2:
            self._latched = True
        return dict(self._target)

    # -- deciding -------------------------------------------------------

    def _signal_month_at(self, asof: pd.Timestamp) -> pd.Period:
        """The last month whose close this rule is entitled to have read.

        This is the whole month-detection scheme in one expression, and
        it is stated as a month rather than as a boolean on purpose. A
        rule fires whenever the answer CHANGES, which covers the first
        decision of a run, every ordinary month-end, and the case a
        boolean misses entirely — a panel with no bar on the last
        session of a month, where the rule would otherwise skip the
        month in silence and nobody would ever see it.
        """
        month = pd.Period(asof, freq="M")
        return month if _is_month_end_session(asof) else month - 1

    def _decide(
        self, view: Any, asof: pd.Timestamp, signal_month: pd.Period
    ) -> None:
        panel = view.close_adj
        need = (int(self.months_required) + 2) * MAX_SESSIONS_IN_MONTH
        tail = panel.iloc[-need:] if len(panel) > need else panel
        monthly = month_end_closes(tail)

        cash = self._resolve_cash(panel)
        if not self._caps_checked:
            self._check_caps(view)
            self._caps_checked = True

        if len(monthly) < self.months_required:
            legs = tuple(
                Leg(
                    ticker=t,
                    weight=0.0,
                    status=LEG_UNSCORED,
                    statistic=float("nan"),
                    hurdle=float("nan"),
                    note=(
                        f"{len(monthly)} completed month-end close(s) banked; "
                        f"the rule needs {self.months_required}"
                    ),
                )
                for t in self.assets
            )
            signal_date = pd.Timestamp(monthly.index[-1]) if len(monthly) else asof
        else:
            window = monthly.iloc[-int(self.months_required) :]
            legs = tuple(self._legs(window, view))
            signal_date = pd.Timestamp(window.index[-1])

        invested = float(sum(leg.weight for leg in legs))
        # Long-only and unlevered, asserted rather than reviewed. The
        # engine raises on a gross above one, and by then the run is
        # dead three thousand sessions in with a message about the
        # plumbing rather than about the rule that overspent.
        assert all(leg.weight >= -_EPS for leg in legs), "a leg went short"
        assert invested <= 1.0 + _EPS, "a published rule asked for leverage"
        cash_weight = max(0.0, 1.0 - invested)

        decision = MonthlyDecision(
            asof=asof,
            signal_month=signal_month,
            signal_date=signal_date,
            legs=legs,
            cash_weight=cash_weight,
            cash_ticker=cash or "",
            cash_held=bool(cash and self.hold_cash),
        )
        if self.record:
            self._decisions.append(decision)

        # Every asset the rule owns is stated, including the zeroes. The
        # engine reads an absent asset as a target of zero either way,
        # but a rule that leaves names out is one edit from leaving one
        # out by accident and holding it forever.
        #
        # Except the ones the panel has never heard of. The engine
        # raises on any asset outside its own columns, at ANY weight
        # including zero, and it is right to — a strategy naming a
        # ticker the run cannot price is usually a typo. Here it is
        # not: VEU is a real fund this project's universe does not
        # carry, and a GEM or Ivy run against a narrower panel should
        # come back with that leg recorded ABSENT and the rest of the
        # rule intact, rather than dying on session one. The record
        # keeps the leg; only the order does not.
        cols = {str(c) for c in panel.columns}
        target = {
            leg.ticker: leg.weight for leg in legs if leg.ticker in cols
        }
        if decision.cash_held:
            target[decision.cash_ticker] = cash_weight

        self._signal_month = signal_month
        self._target = target
        self._latched = False
        self._last_gap = None
        self._stalls = 0

    def _gap(self, live: Mapping[str, float]) -> float:
        """The largest single deviation between the book and the target.

        Largest rather than summed, because the engine bands and trades
        one position at a time: the run is done chasing this month's
        book exactly when no single leg is far enough from its target
        for the engine to act on it.
        """
        keys = set(self._target) | {k for k, v in live.items() if abs(v) > _EPS}
        if not keys:
            return 0.0
        return max(
            abs(self._target.get(k, 0.0) - float(live.get(k, 0.0))) for k in keys
        )

    def _cash_column(self, panel: pd.DataFrame) -> str | None:
        """The bill vehicle this panel could hold, by name alone."""
        cols = {str(c) for c in panel.columns}
        if self.cash_ticker:
            return self.cash_ticker if self.cash_ticker in cols else None
        for t in DEFAULT_CASH_VEHICLES:
            if t in cols:
                return t
        return None

    def _resolve_cash(self, panel: pd.DataFrame) -> str | None:
        """The bill vehicle that actually has a price today.

        A column is not a vehicle. BIL lists in May 2007 and the project
        splices a cash leg before it, so a panel running from 2005
        carries a BIL column that is NaN for two and a half years —
        and targeting the residual at a fund with no bar means the
        engine plans the same unfillable trade every session, files a
        NO_FILL_PRICE postponement for it, and leaves a reader of the
        postponement log looking for a liquidity problem that was
        really a listing date. Uninvested is the honest answer there,
        and `cash_held` on the decision record says which it was.
        """
        name = self._cash_column(panel)
        if name is None:
            return None
        last = float(pd.to_numeric(panel[name].iloc[-1], errors="coerce"))
        return name if math.isfinite(last) and last > 0.0 else None

    def _check_caps(self, view: Any) -> None:
        """Refuse a ceiling the published rule cannot live under.

        Checked once, on the first decision, and loudly. `_decide` in
        the engine clamps a target to its cap in silence — correctly,
        because a cap is an account fact — so a GEM run on a panel
        carrying the project's sleeve caps would hold 40% SPY and 60%
        cash for twenty years and report it as Antonacci's record.
        There is no signal in the output that this happened. There has
        to be one here.
        """
        if self.allow_binding_caps:
            return
        caps = getattr(view, "caps", None) or {}
        wanted = dict(self._intended_max())
        # By column rather than by today's price: the check runs once,
        # on the first decision, and a bill fund that lists two years
        # later would otherwise never have its ceiling looked at.
        column = self._cash_column(view.close_adj)
        if column and self.hold_cash:
            wanted[column] = 1.0
        binding = {
            a: (float(caps[a]), w)
            for a, w in wanted.items()
            if a in caps and float(caps[a]) < w - _EPS
        }
        if not binding:
            return
        detail = ", ".join(
            f"{a} capped at {c:.0%} but the rule asks for {w:.0%}"
            for a, (c, w) in sorted(binding.items())
        )
        raise StrategyError(
            f"{self.name} cannot run under these weight caps: {detail}. Those "
            "ceilings are this project's risk priors for its own nine-sleeve "
            "book, and applying them to somebody else's published rule "
            "measures our constraint rather than their strategy — silently, "
            "because the engine clamps without complaining. Pass "
            "BacktestConfig(apply_sleeve_caps=False), or caps of 1.0 for "
            "these assets, or allow_binding_caps=True if measuring the "
            "capped version is genuinely what you meant."
        )

    # -- the hooks ------------------------------------------------------

    @property
    def assets(self) -> tuple[str, ...]:
        raise NotImplementedError

    def _intended_max(self) -> Mapping[str, float]:
        raise NotImplementedError

    def _legs(self, window: pd.DataFrame, view: Any) -> Sequence[Leg]:
        raise NotImplementedError


# -- shared arithmetic --------------------------------------------------


def _column(window: pd.DataFrame, ticker: str) -> pd.Series | None:
    if ticker not in window.columns:
        return None
    return window[ticker].astype("float64")


def _total_return(series: pd.Series) -> float:
    """Return from the first month-end close in the window to the last.

    A ratio of two total-return closes and nothing cleverer, which is
    what "twelve-month return" means in both of the sources below. Any
    non-positive or missing endpoint returns NaN rather than a number,
    because a ratio against a zero or an absent price is arithmetic
    happening where evidence is not.
    """
    first, last = float(series.iloc[0]), float(series.iloc[-1])
    if not (math.isfinite(first) and first > 0.0 and math.isfinite(last)):
        return float("nan")
    return last / first - 1.0


def _bill_return(
    view: Any,
    window: pd.DataFrame,
    cash: str | None,
    risk_free: float | pd.Series | None,
) -> tuple[float, str]:
    """The T-bill return over the signal window, and where it came from.

    Order matters and is an argument rather than a convenience. A bill
    fund actually in the panel is the closest thing to what Antonacci
    compares against AND is an instrument this account could hold, so
    its own total return over the same two month-ends is the answer
    whenever it can be computed. A supplied rate is the fallback, not
    the default, and is compounded over the sessions of the window on
    the project's convention — annualised decimal, geometric to daily,
    252 a year — so a Sharpe and a momentum hurdle in this codebase can
    never disagree about what a risk-free rate is.

    The two ways this can fail are different and are answered
    differently, which is the same distinction the sleeve layer draws
    between ABSENT and UNSCORED. A bill fund that is in the panel but
    has not listed across the whole window is a WARM-UP: the answer
    arrives on its own a few months later, so this returns NaN, every
    leg comes back unscored, and the book waits in cash. Having no
    source of a hurdle at all — no bill column and no supplied rate — is
    a CONFIGURATION error that will still be true in twenty years, and
    it raises. Defaulting to zero in either case would not be
    conservative: with no hurdle the gate almost never closes and the
    rule quietly becomes relative momentum under the wrong name.
    """
    have_column = cash is not None and _column(window, cash) is not None
    if have_column:
        r = _total_return(_column(window, cash))
        if math.isfinite(r):
            return r, f"{cash} total return over the same two month-ends"
        if risk_free is None:
            return (
                float("nan"),
                f"{cash} has not banked the whole window yet",
            )

    if risk_free is None:
        raise StrategyError(
            "no risk-free hurdle available: no bill vehicle is in the panel "
            f"(any of {', '.join(DEFAULT_CASH_VEHICLES)}) and no risk_free= "
            "rate was supplied. This rule's absolute-momentum gate IS a "
            "comparison against T-bills, so there is nothing to fall back "
            "on, and a hurdle of zero is a gate that never closes."
        )

    start, end = pd.Timestamp(window.index[0]), pd.Timestamp(window.index[-1])
    index = pd.DatetimeIndex(view.close_adj.index)
    sessions = index[(index > start) & (index <= end)]
    if not len(sessions):
        return float("nan"), "no sessions in the window"

    if isinstance(risk_free, pd.Series):
        annual = risk_free.astype("float64").sort_index()
        annual.index = pd.DatetimeIndex(annual.index).normalize()
        annual = annual.reindex(sessions.union(annual.index)).ffill()
        annual = annual.reindex(sessions)
        if annual.isna().any():
            first = annual.index[annual.isna()][0]
            raise StrategyError(
                "the risk-free series does not cover the signal window; no "
                f"rate on or before {first.date()}. Forward-filling from the "
                "first quote we happen to hold is how a 2015 hurdle ends up "
                "being 2020's cash rate."
            )
        rates = annual.to_numpy(dtype="float64")
        source = "supplied annualised risk-free series, compounded daily"
    else:
        rates = np.full(len(sessions), float(risk_free), dtype="float64")
        source = f"constant {float(risk_free):.2%} annualised, compounded daily"

    if float(np.nanmax(np.abs(rates))) > 1.0:
        raise StrategyError(
            "the risk-free rate is above 100% a year as a decimal. This is "
            "percent — divide by 100; data.tbill returns percent by design."
        )
    daily = (1.0 + rates) ** (1.0 / 252.0) - 1.0
    return float(np.prod(1.0 + daily) - 1.0), source


def _leg_from_gate(
    ticker: str,
    statistic: float,
    hurdle: float,
    weight_if_on: float,
    *,
    present: bool,
    note: str = "",
) -> Leg:
    """One asset through one comparison, with the four states kept apart.

    Absent, unscored, off and on are different claims and collapsing any
    two of them is how a backtest acquires a view it could not have
    held. A commodity pool that had not listed did not decline to be
    owned; a fund with nine months of history has not earned an opinion;
    a fund below its average was asked and said no. All three hold
    nothing.

    `note` is APPENDED to the status's own sentence rather than
    replacing it. The caller knows things this function does not — which
    of ten closes were missing, where the hurdle came from — and the
    status text is the part a reader scans for, so neither may quietly
    delete the other.
    """
    if not present:
        return Leg(
            ticker=ticker,
            weight=0.0,
            status=LEG_ABSENT,
            statistic=statistic,
            hurdle=hurdle,
            note=_join("no usable close at this month-end", note),
        )
    if not (math.isfinite(statistic) and math.isfinite(hurdle)):
        return Leg(
            ticker=ticker,
            weight=0.0,
            status=LEG_UNSCORED,
            statistic=statistic,
            hurdle=hurdle,
            note=_join("the window is not complete for this asset", note),
        )
    on = statistic > hurdle
    return Leg(
        ticker=ticker,
        weight=weight_if_on if on else 0.0,
        status=LEG_ON if on else LEG_OFF,
        statistic=statistic,
        hurdle=hurdle,
        note=note,
    )


def _join(base: str, extra: str) -> str:
    return f"{base}; {extra}" if extra else base


# -- Faber (2007) -------------------------------------------------------


class Faber2007(MonthlyRule):
    """The ten-month moving average, on month-end closes, five sleeves.

    Hold each asset when its month-end close is above the average of the
    last ten month-end closes, including that one; otherwise hold cash
    against it. Each asset is a fixed fifth of the book and the five
    signals are independent, so the portfolio steps through 0%, 20%,
    40%, 60%, 80% and 100% invested, and the fifth belonging to an asset
    that is out sits in bills rather than being redistributed to the
    ones that are in.

    **The window is TEN MONTHS and the bars are MONTH-END CLOSES.**
    Faber is explicit that the rule is evaluated once a month on
    month-end data, and the paper's own robustness section is what makes
    that a fact about the strategy rather than a detail: it is a rule
    designed to be checkable by hand, once a month, by somebody who is
    not watching the tape. A daily 200-day moving average is a
    reasonable thing and a different one, with several times the trade
    count. This class does not offer it.

    **What the sources actually were.** S&P 500, MSCI EAFE, 10-year US
    Treasuries, NAREIT and the Goldman Sachs Commodity Index — five
    total-return indices, none of them tradable. The vehicle defaults
    below are the closest liquid ETFs, and each substitution is named
    in `as_published` because none of them is exact.

    **What the literature claims about the record after 2007, to be
    TESTED here and not assumed.** The widely repeated account is that
    the rule earned its reputation in 2008 — it was out of equities for
    most of the fall — and then underperformed buy-and-hold badly across
    the 2009-2021 bull market, whipsawing in and out through 2011, 2015
    and 2018, and that its full post-publication record trails a simple
    60/40 on return while keeping most of its drawdown advantage. That
    is a claim about a number this study computes. It is written here so
    the number can contradict it.

    **Nothing in this class was tuned.** Ten months, five assets, equal
    fifths and month-end evaluation are all Faber's. `sma_months` and
    the vehicle list are constructor arguments so that a robustness
    check is possible, and a run at any value other than the default is
    a different strategy that owes the trial counter a row.
    """

    key = "faber_gtaa_10mo"
    title = "Faber GTAA, 10-month SMA on five asset classes"
    citation = (
        "Mebane T. Faber, 'A Quantitative Approach to Tactical Asset "
        "Allocation', The Journal of Wealth Management, Vol. 9 No. 4, "
        "Spring 2007"
    )

    #: The Spring 2007 issue of the Journal of Wealth Management. The
    #: issue is dated to a season rather than a day, so this is the end
    #: of the month the Spring issue appears in — late, on the rule
    #: stated in the module docstring, because early is contamination
    #: and late is only cost.
    #:
    #: The ambiguity worth knowing: the working paper circulated on SSRN
    #: before the journal issue, in 2006-2007, and by the earlier date
    #: this study would be measuring from a draft the author could still
    #: revise. The journal is the publication of record and that is what
    #: this date is. A reader who prefers the SSRN date can move it —
    #: which is why it is an attribute and not a literal in the code.
    published_on = date(2007, 4, 30)

    universe = ("SPY", "EFA", "IEF", "VNQ", "DBC", "BIL")

    rationale = (
        "Faber's claim is not that trend predicts returns but that it "
        "manages risk: applying a simple long-term moving average to "
        "each of five uncorrelated-ish asset classes produces, in his "
        "1973-2005 sample, roughly equity-like returns with roughly "
        "bond-like volatility and materially smaller drawdowns, because "
        "the rule is out of an asset class through the worst of every "
        "sustained decline. The model is deliberately simple, "
        "parameter-light and checkable once a month by hand; its point "
        "is that a mechanical exit rule beats a discretionary one, not "
        "that ten months is a magic number."
    )

    as_published = (
        "Five index substitutions, none exact. S&P 500 -> SPY, MSCI "
        "EAFE -> EFA, 10-year Treasuries -> IEF (7-10y, so a slightly "
        "shorter duration than a constant 10-year), NAREIT -> VNQ "
        "(Faber and Richardson's own choice in the 2009 book), GSCI -> "
        "DBC. DBC is the substitution that matters: it tracks the DBIQ "
        "Optimum Yield index, which rolls along the futures curve to "
        "reduce contango drag, and is therefore a materially different "
        "commodity return stream from the front-month GSCI Faber used. "
        "GSG tracks the actual index and is not in this project's ETF "
        "universe. The paper credits the out-of-market fifth with a "
        "short-term paper rate; we hold a bill ETF instead, which is "
        "the closest thing an account can actually own and differs from "
        "a bill index by the fund's fee and a few basis points of "
        "tracking. Where no bill vehicle is in the panel the residual "
        "earns nothing and the decision record says so."
    )

    months_required = 10

    #: One liquid fund per index the paper used, in the paper's order.
    DEFAULT_ASSETS: tuple[str, ...] = ("SPY", "EFA", "IEF", "VNQ", "DBC")

    #: The Ivy Portfolio's vehicle list for the same rule. VTI for the
    #: whole US market rather than the S&P 500, VEU for all-country
    #: ex-US rather than developed-only, BND for the aggregate rather
    #: than the 10-year. This is a robustness check on one strategy, not
    #: a second strategy: see the module docstring.
    #:
    #: VEU is not in this project's ETF universe, so a panel built from
    #: that list will simply not carry the column. The leg comes back
    #: ABSENT and holds nothing rather than failing, which is right —
    #: but a four-legged Ivy run is not the Ivy portfolio, and the
    #: decision record is where that has to be noticed.
    IVY_FIVE: tuple[str, ...] = ("VTI", "VEU", "BND", "VNQ", "DBC")

    def __init__(
        self,
        assets: Sequence[str] = DEFAULT_ASSETS,
        *,
        # Ten is Faber's, and any other value is a different strategy
        # that owes `metrics.TrialCounter` a row. It is an argument
        # rather than a constant only so that a sensitivity sweep is
        # possible to WRITE DOWN; it is not an invitation.
        sma_months: int = 10,
        **kwargs: Any,
    ) -> None:
        self._assets = tuple(str(a) for a in assets)
        if not self._assets:
            raise StrategyError("Faber's rule needs at least one asset class")
        if len(set(self._assets)) != len(self._assets):
            raise StrategyError(f"duplicate asset in {self._assets}")
        if int(sma_months) < 2:
            raise StrategyError("a moving average needs at least two months")
        self.sma_months = int(sma_months)
        self.months_required = self.sma_months
        super().__init__(**kwargs)
        self.universe = self._assets + (
            (self.cash_ticker,) if self.cash_ticker else DEFAULT_CASH_VEHICLES
        )

    @classmethod
    def ivy_five(cls, **kwargs: Any) -> Faber2007:
        """The same rule on The Ivy Portfolio's vehicles.

        A constructor rather than a class, so the library counts one
        published rule where there is one published rule. The timing
        overlay in the 2009 book is the 2007 paper's rule unchanged;
        only the funds differ.
        """
        return cls(cls.IVY_FIVE, **kwargs)

    @property
    def assets(self) -> tuple[str, ...]:
        return self._assets

    def _intended_max(self) -> Mapping[str, float]:
        w = 1.0 / len(self._assets)
        return {a: w for a in self._assets}

    def _legs(self, window: pd.DataFrame, view: Any) -> Sequence[Leg]:
        share = 1.0 / len(self._assets)
        legs: list[Leg] = []
        for ticker in self._assets:
            series = _column(window, ticker)
            if series is None:
                legs.append(
                    Leg(
                        ticker=ticker,
                        weight=0.0,
                        status=LEG_ABSENT,
                        statistic=float("nan"),
                        hurdle=float("nan"),
                        note="not a column in this panel",
                    )
                )
                continue

            close = float(series.iloc[-1])
            present = math.isfinite(close) and close > 0.0

            # Every one of the ten months, or none of them. `mean()`
            # would happily average the nine that are there and hand
            # back a nine-month average wearing a ten-month label, which
            # is a different rule at exactly the dates — a fund's first
            # year — where the difference is largest.
            values = series.to_numpy(dtype="float64")
            complete = bool(np.isfinite(values).all() and (values > 0.0).all())
            sma = float(values.mean()) if complete else float("nan")

            legs.append(
                _leg_from_gate(
                    ticker,
                    close,
                    sma,
                    share,
                    present=present,
                    note=(
                        ""
                        if complete or not present
                        else f"only {int(np.isfinite(values).sum())} of "
                        f"{self.sma_months} month-end closes are on file"
                    ),
                )
            )
        return legs


# -- Antonacci (2014) ---------------------------------------------------


class DualMomentumGEM(MonthlyRule):
    """Global Equities Momentum: relative momentum inside an absolute gate.

    Once a month, on month-end closes: if US equities beat T-bills over
    the trailing twelve months, hold whichever of US equities and
    non-US equities had the higher twelve-month return; otherwise hold
    the US aggregate bond index. One asset at a time, 100% of the book,
    no cash leg — the bond index IS the defensive position.

    **The ambiguity, stated plainly, because it changes the rule.** Two
    readings of the absolute-momentum gate circulate. The book's own
    flowchart applies it to the S&P 500: US equities are compared to
    T-bills first, and a failure sends the whole book to bonds no matter
    what non-US equities did. The other reading, common in summaries,
    applies the gate to the relative WINNER, so a year in which US
    equities lag bills but non-US equities beat them lands in non-US
    equities rather than in bonds. They agree everywhere except that one
    case. This class implements the flowchart reading as the default,
    because that is the most literal reading of the published diagram,
    and offers the other under `gate_on_winner=True`. Running both is
    two trials, not one, and the trial counter should hear about it.

    **What the literature claims about the record after 2014, to be
    TESTED here and not assumed.** The repeated account is that GEM's
    published 1974-2013 record — high single-digit excess returns over
    buy-and-hold with roughly half the drawdown — has not repeated: the
    US/non-US relative signal kept the book in US equities through most
    of the period, which was right, but the absolute gate produced
    several costly round trips (late 2015, early 2016, the turn of
    2019, and the whipsaw out of and back into equities in 2020 and
    2022), and the strategy trails buy-and-hold US equities over the
    post-publication window while retaining a smaller worst drawdown.
    That is a claim about numbers this study computes, not a finding.

    **Nothing here was tuned.** Twelve months, three assets, the T-bill
    hurdle and monthly evaluation are Antonacci's.
    """

    key = "antonacci_gem"
    title = "Antonacci Global Equities Momentum"
    citation = (
        "Gary Antonacci, 'Dual Momentum Investing: An Innovative Strategy "
        "for Higher Returns with Lower Risk', McGraw-Hill, 2014"
    )

    #: McGraw-Hill dates the book to November 2014. Rounded forward to
    #: the first of the following month on the rule in the module
    #: docstring, so the measurement window cannot begin before copies
    #: were in circulation.
    #:
    #: The earlier public appearance, recorded rather than used: the
    #: dual-momentum idea won the 2012 NAAIM Wagner Award as 'Risk
    #: Premia Harvesting Through Dual Momentum', so a reader who wants
    #: the idea's first public date rather than the book's has two more
    #: years of sample available and should say which one they used.
    published_on = date(2014, 12, 1)

    universe = ("SPY", "VXUS", "AGG", "BIL")

    rationale = (
        "Antonacci's claim is that the two momentum effects are "
        "complementary rather than alternatives. Relative momentum "
        "picks the stronger of two equity markets and captures the "
        "cross-sectional effect; absolute momentum asks whether the "
        "winner is beating cash at all, and is what actually avoids bear "
        "markets, because in a genuine decline the relative winner is "
        "merely the asset falling more slowly. Applied to a deliberately "
        "small opportunity set — US equities, non-US equities, aggregate "
        "bonds — this is meant to give equity-like long-run returns with "
        "drawdowns closer to a balanced fund, using one decision a month "
        "and one holding at a time."
    )

    as_published = (
        "Index substitutions. S&P 500 -> SPY. MSCI ACWI ex-US -> VXUS, "
        "which tracks FTSE Global All Cap ex US: a broader and "
        "small-cap-inclusive version of the same exposure, and the "
        "closest fund in this project's ETF universe. VEU is the "
        "conventional choice and is not in the universe; EFA is NOT an "
        "acceptable fallback and is deliberately not offered, because "
        "developed-only excludes the emerging markets that drive the "
        "relative signal in several of the years that matter. Barclays/ "
        "Bloomberg US Aggregate -> AGG. The T-bill hurdle is the total "
        "return of a bill ETF in the panel where one exists, otherwise a "
        "supplied risk-free series compounded over the same window; "
        "Antonacci uses a T-bill index. The absolute-gate ambiguity is "
        "described in the class docstring and is a genuine fork in the "
        "source, not a modelling choice."
    )

    months_required = 13  # thirteen closes bound twelve months of return

    def __init__(
        self,
        *,
        us_ticker: str = "SPY",
        intl_ticker: str = "VXUS",
        bond_ticker: str = "AGG",
        lookback_months: int = 12,
        gate_on_winner: bool = False,
        risk_free: float | pd.Series | None = None,
        **kwargs: Any,
    ) -> None:
        if int(lookback_months) < 1:
            raise StrategyError("the momentum lookback must be at least a month")
        self.us_ticker = str(us_ticker)
        self.intl_ticker = str(intl_ticker)
        self.bond_ticker = str(bond_ticker)
        self.lookback_months = int(lookback_months)
        self.gate_on_winner = bool(gate_on_winner)
        self.risk_free = risk_free
        self.months_required = self.lookback_months + 1
        super().__init__(**kwargs)
        self.universe = (
            self.us_ticker,
            self.intl_ticker,
            self.bond_ticker,
        ) + ((self.cash_ticker,) if self.cash_ticker else DEFAULT_CASH_VEHICLES)

    @property
    def assets(self) -> tuple[str, ...]:
        return (self.us_ticker, self.intl_ticker, self.bond_ticker)

    def _intended_max(self) -> Mapping[str, float]:
        # Every leg can be the whole book. That is the rule, and it is
        # the reason this class refuses to run under the sleeve caps.
        return {a: 1.0 for a in self.assets}

    def _legs(self, window: pd.DataFrame, view: Any) -> Sequence[Leg]:
        # The COLUMN, not today's tradable vehicle. The hurdle is a
        # historical return over two month-ends; whether the fund has a
        # price this morning is a separate question, and one that
        # belongs to holding the residual rather than to measuring the
        # bill.
        cash = self._cash_column(view.close_adj)
        hurdle, source = _bill_return(view, window, cash, self.risk_free)

        # No hurdle yet is not a shut gate. A shut gate is a decision to
        # own bonds; this is the rule having nothing to say, and the two
        # produce different books — bonds against cash — so reading one
        # as the other would put a duration position on the strength of
        # a missing bill quote.
        if not math.isfinite(hurdle):
            return [
                Leg(
                    ticker=t,
                    weight=0.0,
                    status=LEG_UNSCORED,
                    statistic=float("nan"),
                    hurdle=hurdle,
                    note=f"no T-bill hurdle: {source}",
                )
                for t in self.assets
            ]

        rets: dict[str, float] = {}
        for ticker in (self.us_ticker, self.intl_ticker):
            series = _column(window, ticker)
            rets[ticker] = (
                _total_return(series) if series is not None else float("nan")
            )

        # A missing non-US return is not a reason to abandon the rule.
        # VXUS lists in 2011 and a run that starts earlier simply has
        # one equity leg, which is the honest reading of "hold whichever
        # is higher" when only one exists; the record says UNSCORED on
        # the leg that could not be measured so nobody later reads the
        # US allocation as a relative-momentum win it never won.
        candidates = {t: r for t, r in rets.items() if math.isfinite(r)}
        winner = (
            max(candidates, key=lambda t: candidates[t]) if candidates else None
        )

        # Which leg the gate reads is the published ambiguity, and it is
        # carried into the record as a NAME rather than as a boolean —
        # a reader six months later wants to know that a bond month was
        # decided by the S&P 500 while non-US equities were up, which is
        # exactly the case the two readings disagree about.
        gate_asset = (
            (winner or self.us_ticker) if self.gate_on_winner else self.us_ticker
        )
        gate_value = rets.get(gate_asset, float("nan"))
        gate_open = math.isfinite(gate_value) and gate_value > hurdle
        gate_note = f"gate reads {gate_asset} against {source}"

        holding = self.bond_ticker
        if winner is not None and gate_open:
            holding = winner
        elif winner is None:
            # Nothing measurable on either equity leg. Bonds is what the
            # flowchart says when the gate is not open, and a closed
            # gate is what an unanswerable question amounts to here.
            holding = self.bond_ticker

        legs: list[Leg] = []
        for ticker in (self.us_ticker, self.intl_ticker):
            r = rets[ticker]
            present = _column(window, ticker) is not None
            if not present:
                status, note = LEG_ABSENT, "not a column in this panel"
            elif not math.isfinite(r):
                status, note = (
                    LEG_UNSCORED,
                    f"the {self.lookback_months}-month window is incomplete",
                )
            elif ticker == holding:
                status, note = LEG_ON, f"relative winner; {gate_note}, open"
            elif winner == ticker:
                status, note = (
                    LEG_OFF,
                    f"relative winner but shut out: {gate_note}, shut",
                )
            else:
                status, note = LEG_OFF, "lost the relative comparison"
            legs.append(
                Leg(
                    ticker=ticker,
                    weight=1.0 if ticker == holding else 0.0,
                    status=status,
                    statistic=r,
                    hurdle=hurdle,
                    note=note,
                )
            )

        bonds = _column(window, self.bond_ticker)
        bond_present = bonds is not None and math.isfinite(float(bonds.iloc[-1]))
        if not bond_present:
            # The defensive leg is the one that must never fail open. No
            # bond fund means the gate's answer has nowhere to go, and
            # the residual — bills, or uninvested balance — is the only
            # long-only expression of "not in equities" left. Said out
            # loud on the row, because a book sitting in cash while the
            # record shows a bond allocation of zero is otherwise
            # indistinguishable from a book that chose equities.
            legs.append(
                Leg(
                    ticker=self.bond_ticker,
                    weight=0.0,
                    status=LEG_ABSENT,
                    statistic=float("nan"),
                    hurdle=hurdle,
                    note=(
                        "no usable aggregate-bond close"
                        + (
                            "; the gate is shut and the book falls to the "
                            "cash residual instead"
                            if holding == self.bond_ticker
                            else ""
                        )
                    ),
                )
            )
        else:
            legs.append(
                Leg(
                    ticker=self.bond_ticker,
                    weight=1.0 if holding == self.bond_ticker else 0.0,
                    status=LEG_ON if holding == self.bond_ticker else LEG_OFF,
                    statistic=float("nan"),
                    hurdle=hurdle,
                    note=(
                        f"{gate_note}, shut"
                        if holding == self.bond_ticker
                        else f"{gate_note}, open — equities hold the book"
                    ),
                )
            )
        return legs


# -- the primitive underneath both --------------------------------------


class AbsoluteMomentum(MonthlyRule):
    """Hold the asset while its twelve-month return beats bills, else cash.

    The control, and the reason the library has one. Faber's rule is
    this comparison with a moving average standing in for the hurdle;
    GEM is this comparison with a relative-strength choice bolted on
    top. Whatever either of them earns after publication, the question
    that actually matters is how much of it the primitive earns on its
    own — a wrapper that adds nothing to its own core is a wrapper, and
    that is a finding rather than a disappointment.

    Defaults to a single asset, US equities, which is Antonacci's own
    headline demonstration. Given several assets it gates each one
    independently at an equal share of the book, exactly as Faber's does
    — which makes the two directly comparable, one hurdle against the
    other, on the same five sleeves.

    **What the literature claims, to be TESTED here.** Antonacci's
    published result is that absolute momentum applied to US equities
    over 1974-2012 roughly matched buy-and-hold's return with about
    half the maximum drawdown, chiefly by being out through 2000-2002
    and 2008. The standard criticism is that the post-2013 record is
    dominated by whipsaws — the gate closing near local bottoms in 2015,
    2018 and 2020 and reopening higher — and that the drawdown
    protection survives while the return advantage does not.

    **Nothing here was tuned.** Twelve months and the T-bill hurdle are
    Antonacci's.
    """

    key = "absolute_momentum_12m"
    title = "Absolute momentum, 12-month, versus T-bills"
    citation = (
        "Gary Antonacci, 'Absolute Momentum: A Simple Rule-Based Strategy "
        "and Universal Trend-Following Overlay', SSRN working paper, 2013"
    )

    #: An SSRN working paper, posted in the first half of 2013; the day
    #: is not pinned in anything this project holds, so this is the end
    #: of April on the module's round-late rule. A monthly rule is
    #: insensitive to a few weeks, and a reader who has the exact
    #: posting date should set it — which is why it is an attribute.
    #:
    #: The idea is older than the paper in every substantive sense
    #: (Moskowitz, Ooi and Pedersen's time-series momentum is 2012, and
    #: trend rules of this shape go back decades), but this paper is
    #: where the specific rule below — twelve months, against bills,
    #: long-only, as an overlay — was written down.
    published_on = date(2013, 4, 30)

    universe = ("SPY", "BIL")

    rationale = (
        "Antonacci's claim is that absolute momentum, not relative "
        "momentum, is what does the defensive work. An asset whose own "
        "trailing return has fallen below the risk-free rate has, "
        "empirically, a materially worse forward distribution than the "
        "same asset above it, and that difference is concentrated in "
        "exactly the sustained declines a long-only account has no other "
        "way to avoid. The rule is deliberately the smallest thing that "
        "expresses it: one lookback, one hurdle, one decision a month, "
        "and no view about which asset is best."
    )

    as_published = (
        "S&P 500 -> SPY. The hurdle is the total return of a bill ETF in "
        "the panel where one exists, otherwise a supplied risk-free "
        "series compounded over the same window; the paper uses a "
        "T-bill index. Out-of-market weight is held in the same bill "
        "fund rather than credited at a quoted rate, which is the "
        "closest an account gets to what the paper assumes."
    )

    months_required = 13

    def __init__(
        self,
        assets: Sequence[str] = ("SPY",),
        *,
        lookback_months: int = 12,
        risk_free: float | pd.Series | None = None,
        **kwargs: Any,
    ) -> None:
        self._assets = tuple(str(a) for a in assets)
        if not self._assets:
            raise StrategyError("absolute momentum needs at least one asset")
        if len(set(self._assets)) != len(self._assets):
            raise StrategyError(f"duplicate asset in {self._assets}")
        if int(lookback_months) < 1:
            raise StrategyError("the momentum lookback must be at least a month")
        self.lookback_months = int(lookback_months)
        self.risk_free = risk_free
        self.months_required = self.lookback_months + 1
        super().__init__(**kwargs)
        self.universe = self._assets + (
            (self.cash_ticker,) if self.cash_ticker else DEFAULT_CASH_VEHICLES
        )

    @property
    def assets(self) -> tuple[str, ...]:
        return self._assets

    def _intended_max(self) -> Mapping[str, float]:
        w = 1.0 / len(self._assets)
        return {a: w for a in self._assets}

    def _legs(self, window: pd.DataFrame, view: Any) -> Sequence[Leg]:
        # The COLUMN, not today's tradable vehicle. The hurdle is a
        # historical return over two month-ends; whether the fund has a
        # price this morning is a separate question, and one that
        # belongs to holding the residual rather than to measuring the
        # bill.
        cash = self._cash_column(view.close_adj)
        hurdle, source = _bill_return(view, window, cash, self.risk_free)
        share = 1.0 / len(self._assets)

        legs: list[Leg] = []
        for ticker in self._assets:
            series = _column(window, ticker)
            if series is None:
                legs.append(
                    Leg(
                        ticker=ticker,
                        weight=0.0,
                        status=LEG_ABSENT,
                        statistic=float("nan"),
                        hurdle=hurdle,
                        note="not a column in this panel",
                    )
                )
                continue
            last = float(series.iloc[-1])
            legs.append(
                _leg_from_gate(
                    ticker,
                    _total_return(series),
                    hurdle,
                    share,
                    present=math.isfinite(last) and last > 0.0,
                    note=f"hurdle from {source}",
                )
            )
        return legs


#: The family, in publication order. Order is not decoration: the study
#: reports each rule from its own date forward, and reading them in the
#: order the record was made is the only way the 2013 and 2014 rules can
#: be seen arriving into a world that had already read the 2007 one.
TREND_STRATEGIES: tuple[type[MonthlyRule], ...] = (
    Faber2007,
    AbsoluteMomentum,
    DualMomentumGEM,
)
