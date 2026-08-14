"""Where the three signals meet, and the only place they are allowed to.

Trend, inverse volatility and correlation were written apart and
measured apart, each against its own claim, none of them ever having
seen a blend. This file is the seam. It takes one score from each and
turns them into a book: a weight per sleeve, cash for the rest, every
intermediate value kept so that the answer can be read rather than
reconstructed.

**This layer can only ever DE-RISK.** That sentence is the design and
not a caveat. The account is long-only with no leverage, so the largest
book it can hold is every sleeve at its cap with the sum clipped to
100% of NAV — and when all three signals are maximally bullish, that is
exactly what comes out. Fully invested at the caps is buy-and-hold. The
signals cannot add anything on top of it; all they can do is take
weight away and hand it to cash. Anybody who later notices that the
process never beats its own ceiling and reaches for a fix has found the
constraint rather than a bug: a design that manufactures extra exposure
when it likes everything has smuggled leverage in through the back
door, and refusing that is the whole reason this project exists.

The order is fixed and each step answers a different question.

  1. **Trend decides participation.** The score IS the fraction of the
     sleeve's cap to take, so step one is `cap * score`, floored at
     zero. A negative signal is not an instruction this account can
     carry out; there is nothing to do with it but hold less, and
     holding less is what a score of zero already says.
  2. **Inverse volatility scales what survives.** Equal dollars are not
     equal risk, and the scalar is what fixes the units. It is the one
     step that can RAISE a sleeve's weight above what trend asked for
     — a quiet sleeve at half the book's median risk carries a scalar
     of two — and it is bounded above by the cap two steps later, so
     the ceiling in the paragraph above still holds. Being able to move
     in both directions is the point of it: a step that could only cut
     would equalise nothing.
  3. **Correlation applies its haircut.** One-way by construction; the
     module it comes from cannot return a multiplier above one, and
     this file clips again anyway rather than trusting a number it did
     not compute.
  4. **The cap.** A per-sleeve ceiling, applied after everything that
     could have pushed past it.
  5. **The budget.** If the non-cash weights sum above one they are
     scaled down proportionally. With no leverage that is the only
     legal direction, and proportional is the only rule that does not
     smuggle a view about which sleeve deserves the shortfall.
  6. **Cash takes the rest.**

**An absent sleeve is excluded, not zeroed.** DBC lists thirteen months
into the sample and the cash leg is spliced until BIL exists, so on a
2005 date there are eight sleeves and not nine. "We hold none of this
because the trend is down" and "we hold none of this because it does
not exist yet" are different facts, they produce the same number, and a
weight vector cannot tell them apart. `SleeveStatus` can: `ABSENT` is
no bar at all, `UNSCORED` is a vehicle that trades but has not yet
banked the history a signal needs, `INCLUDED` is a sleeve that was
actually asked. Nothing is redistributed on an excluded sleeve's
behalf beyond what the ordinary cap and sum rules already do — the
weight simply is not proposed, and the residual is cash.

**The decomposition is the deliverable, not the weights.** In six
months somebody will ask why gold was 4% on a particular day, and the
answer has to be readable off one object rather than reassembled from
three modules and a guess about the order they ran in. So every line
carries the raw score from each signal, the weight after every step,
and the name of the step that did the cutting.

**Causality.** Nothing here reads a bar after the close of `asof`. The
frame is cut at `asof` before any signal sees it, and each of the three
is independently pinned by its own truncation test. This module's test
does the same thing at this level: truncate the panel after T,
recompute, and require the weights at T to be identical.

**Nothing here is tuned.** There is no parameter in this file with a
value that could have been chosen by looking at a result — the order of
the steps is an argument, the floor at zero is the account type, and
the proportional scale-down is arithmetic. The three signals' own
constants were fixed before any of them had a performance number, and
the composition was written under the same blackout.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ..signals import correlation, trend, volatility
from .sleeves import CASH_SLEEVE_KEY, SLEEVES, Sleeve

__all__ = [
    "Allocation",
    "REQUIRED_SESSIONS",
    "SleeveLine",
    "SleeveSignals",
    "SleeveSizing",
    "SleeveStatus",
    "SizingError",
    "WARMUP_SESSIONS",
    "compose",
    "decomposition",
    "size_weights",
]


class SizingError(ValueError):
    """The sizing layer was handed something it must not paper over."""


#: Float residue tolerance. Anything smaller is the cost of summing nine
#: products, not a leverage request or a short.
_EPS = 1e-12


#: Closes a sleeve needs banked before every signal will speak about it.
#:
#: Derived rather than written down, because the three answers happen to
#: agree today and a future edit to any one of them must move this
#: number with it. Trend needs its longest lookback plus the bar it
#: starts from; the volatility blend needs a full trading year of
#: returns; the correlation window is a trading year of returns as well.
#: A caller who shortens any of them gets a shorter warmup for free and
#: a caller who lengthens one cannot forget to lengthen this.
REQUIRED_SESSIONS: int = max(
    max(trend.LOOKBACKS) + 1,
    volatility.MIN_SESSIONS,
    correlation.LOOKBACK + 1,
)

#: The same figure in the engine's units. `BacktestConfig.warmup` counts
#: sessions banked BEFORE the first decision, and at loop index i the
#: view holds i+1 closes — so the off-by-one is resolved here once
#: rather than by each caller, the way `volatility.WARMUP_SESSIONS`
#: resolves it for its own module.
WARMUP_SESSIONS: int = REQUIRED_SESSIONS - 1

#: Both spellings of the cash sleeve, because a panel may be columned by
#: sleeve key or by vehicle ticker and the residual absorber has to be
#: recognisable under either.
_CASH_KEYS: frozenset[str] = frozenset(
    {CASH_SLEEVE_KEY, next(s.ticker for s in SLEEVES if s.key == CASH_SLEEVE_KEY)}
)

_SLEEVE_BY_ALIAS: dict[str, Sleeve] = {}
for _s in SLEEVES:
    _SLEEVE_BY_ALIAS[_s.key] = _s
    _SLEEVE_BY_ALIAS[_s.ticker] = _s


class SleeveStatus(Enum):
    """Why a sleeve carries the weight it carries, at the coarsest level.

    The distinction between the last two is the one that costs money to
    lose. A sleeve scored to zero was asked and said no; an absent
    sleeve was never asked, because there was nothing to ask. Both hold
    nothing, and a backtest that reports them the same way has quietly
    claimed it declined to own a commodity sleeve for thirteen months
    when in truth DBC had not listed.
    """

    #: Every signal spoke; this sleeve took part in the sizing.
    INCLUDED = "included"
    #: No usable bar at this close — the vehicle had not listed, or did
    #: not trade.
    ABSENT = "absent"
    #: The vehicle trades but has not banked the history a signal needs,
    #: so at least one of the three declined to have an opinion.
    UNSCORED = "unscored"


# -- one sleeve, in and out ---------------------------------------------


@dataclass(frozen=True)
class SleeveSignals:
    """What the three signals said about one sleeve at one close.

    The input side of `compose`, and deliberately a plain record of
    numbers rather than a handle back to any panel. Everything the
    composition is allowed to know arrives here, which is what makes the
    arithmetic testable against combinations no market would produce —
    the adversarial cases are the ones a long-only guarantee has to
    survive, and they cannot be reached through a price frame.

    NaN in `trend_score` or `vol_scalar` is an abstention and is treated
    as one. It is never filled with a neutral value: a 0.5 would be an
    opinion nobody held and a 0.0 would be a bearish call nobody made.
    """

    asset: str
    cap: float
    trend_score: float
    vol_scalar: float
    correlation_multiplier: float = 1.0
    book_correlation: float = float("nan")
    top_partner: str = ""
    top_correlation: float = float("nan")
    #: Was there a usable bar at this close at all. False is the DBC
    #: case and outranks everything else — a sleeve that does not exist
    #: cannot be unscored, it is simply not there.
    present: bool = True
    sleeve: str = ""
    ticker: str = ""


@dataclass(frozen=True)
class SleeveLine:
    """One sleeve's whole story on one date, step by step.

    Six numbers where a weight vector would carry one, because the
    weight alone cannot answer the only question anybody asks of it
    afterwards. `after_trend` through `weight` are the same quantity
    after each successive step, so the reader can see which one moved
    it, and `binding` names that step outright for the reader who does
    not want to subtract.
    """

    asset: str
    sleeve: str
    ticker: str
    status: SleeveStatus
    cap: float
    excluded_because: str

    trend_score: float
    vol_scalar: float
    book_correlation: float
    haircut: float
    correlation_multiplier: float
    top_partner: str
    top_correlation: float

    after_trend: float
    after_vol: float
    after_correlation: float
    after_cap: float
    weight: float

    binding: str

    def as_row(self) -> dict[str, Any]:
        return {
            "asset": self.asset,
            "sleeve": self.sleeve,
            "ticker": self.ticker,
            "status": self.status.value,
            "cap": self.cap,
            "trend_score": self.trend_score,
            "vol_scalar": self.vol_scalar,
            "book_correlation": self.book_correlation,
            "haircut": self.haircut,
            "correlation_multiplier": self.correlation_multiplier,
            "top_partner": self.top_partner,
            "top_correlation": self.top_correlation,
            "after_trend": self.after_trend,
            "after_vol": self.after_vol,
            "after_correlation": self.after_correlation,
            "after_cap": self.after_cap,
            "weight": self.weight,
            "binding": self.binding,
            "excluded_because": self.excluded_because,
        }


_LINE_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "asset": "str",
    "sleeve": "str",
    "ticker": "str",
    "status": "str",
    "cap": "float64",
    "trend_score": "float64",
    "vol_scalar": "float64",
    "book_correlation": "float64",
    "haircut": "float64",
    "correlation_multiplier": "float64",
    "top_partner": "str",
    "top_correlation": "float64",
    "after_trend": "float64",
    "after_vol": "float64",
    "after_correlation": "float64",
    "after_cap": "float64",
    "weight": "float64",
    "binding": "str",
    "excluded_because": "str",
}


@dataclass(frozen=True, eq=False)
class Allocation:
    """The book at one close, and the arithmetic that produced it.

    `weights` is what a strategy hands the engine. Everything else is
    what a person needs six months later, and it is on the same object
    rather than behind a debug flag for the reason the engine's result
    object gives: a quantity the process already had in its hand must
    never be recomputed by the layer that reports it.

    `cash_weight` is the residual and is derived, never proposed. With
    no leverage the weight the signals decline to take can only become
    cash, so there is nothing here that decides it — one minus what was
    allocated is the whole rule, and `cash_available` says whether the
    cash VEHICLE existed to hold it or whether it sat as uninvested
    balance.
    """

    asof: pd.Timestamp
    lines: tuple[SleeveLine, ...]
    cash_weight: float
    cash_sleeve: str
    cash_available: bool
    gross_before_budget: float
    gross: float
    budget_scale: float
    n_included: int
    n_absent: int
    n_unscored: int
    #: The correlation estimate the haircuts came from, when there was
    #: one. None where fewer than two sleeves could be measured, which
    #: is a real state early in the sample and not an error.
    estimate: correlation.CorrelationEstimate | None = None

    @property
    def weights(self) -> dict[str, float]:
        """Non-cash target weights, keyed as the panel was columned."""
        return {line.asset: line.weight for line in self.lines}

    @property
    def by_asset(self) -> dict[str, SleeveLine]:
        return {line.asset: line for line in self.lines}

    def explain(self) -> pd.DataFrame:
        """One row per sleeve, in the sleeve table's own order.

        A frame rather than a print, because the question this answers
        is usually asked about one date and occasionally about five
        thousand, and only one of those two is readable as prose.
        """
        rows = [{"date": self.asof, **line.as_row()} for line in self.lines]
        return _frame(rows, _LINE_COLUMNS)

    def summary(self) -> str:
        """One sentence that has to be able to say the book is in cash."""
        return (
            f"{self.asof.date()}: {self.n_included} sleeve(s) sized, "
            f"{self.n_absent} absent, {self.n_unscored} unscored; "
            f"{self.gross:.1%} invested, {self.cash_weight:.1%} cash"
            + (
                ""
                if self.budget_scale >= 1.0 - _EPS
                else (
                    f"; the caps wanted {self.gross_before_budget:.1%} and were "
                    f"scaled by {self.budget_scale:.3f} to fit inside NAV"
                )
            )
        )


def decomposition(allocations: Sequence[Allocation]) -> pd.DataFrame:
    """Every line of every date, stacked, in one frame.

    The shape a walk-forward run should keep beside its equity curve.
    Deliberately long rather than wide: a wide frame has to choose one
    quantity to be the value and this object's whole claim is that no
    single one of them is the answer.
    """
    rows: list[dict[str, Any]] = []
    for alloc in allocations:
        rows.extend({"date": alloc.asof, **line.as_row()} for line in alloc.lines)
    return _frame(rows, _LINE_COLUMNS)


# -- the composition ----------------------------------------------------


def compose(
    signals: Sequence[SleeveSignals],
    *,
    asof: pd.Timestamp,
    cash_sleeve: str = CASH_SLEEVE_KEY,
    cash_available: bool = True,
    estimate: correlation.CorrelationEstimate | None = None,
) -> Allocation:
    """The six steps, on scores somebody else computed.

    Separated from `size_weights` so the arithmetic can be handed
    combinations a price frame cannot produce. Every guarantee this
    module makes — no negative weight, no sleeve above its cap, no gross
    above one, cash exactly the residual — is a property of this
    function and of nothing upstream of it, so it is the function the
    adversarial tests point at.

    Three refusals worth naming, because each is a place where trusting
    the input would be the easier code.

    A trend score below zero is floored rather than acted on. There is
    no expression of a negative view available to a cash account, and a
    weight computed from one would be a short.

    A correlation multiplier above one is clipped back to one. The
    module that produces it cannot return such a thing — it asserts as
    much on its way out — so this is a second line of defence against a
    future edit rather than a doubt about the current one, and it is a
    clip rather than a raise because a rule that can only reduce should
    keep only reducing on the day somebody breaks it, not stop the run
    three thousand sessions in.

    An abstention stays an abstention. A NaN score excludes the sleeve
    and is never filled with a neutral value on the sleeve's behalf.
    """
    stamp = pd.Timestamp(asof)
    seen: set[str] = set()
    for s in signals:
        if s.asset in seen:
            raise SizingError(
                f"{s.asset!r} appears twice in the signal set; two lines for "
                "one sleeve would be summed into the gross twice and capped "
                "separately, which is a position twice its own ceiling"
            )
        seen.add(s.asset)
        if s.asset in _CASH_KEYS or s.asset == cash_sleeve:
            raise SizingError(
                f"{s.asset!r} is the cash sleeve and must not be sized. Cash "
                "is the residual — one minus what the risk sleeves took — and "
                "proposing a weight for it would let the process allocate to "
                "cash and to the residual at the same time"
            )
        if not (0.0 < float(s.cap) <= 1.0):
            raise SizingError(
                f"cap {s.cap!r} on {s.asset!r} is outside (0, 1]. A cap of "
                "zero is a sleeve that should not be in the table, and a cap "
                "above one is leverage written as a ceiling"
            )

    lines: list[SleeveLine] = []
    for s in signals:
        lines.append(_line(s))

    gross_before = float(sum(line.after_cap for line in lines))
    # The only legal direction. Scaling UP to reach full investment
    # would be the process manufacturing exposure on a day its own
    # signals asked for less, which is the one thing this layer is not
    # allowed to do; scaling down is what "no leverage" means when the
    # caps happen to sum past NAV, and proportional is the only rule
    # that expresses no view about which sleeve should give way.
    scale = 1.0 / gross_before if gross_before > 1.0 else 1.0

    final: list[SleeveLine] = []
    for line in lines:
        weight = line.after_cap * scale
        final.append(
            _replace_weight(line, weight=weight, scaled=scale < 1.0 - _EPS)
        )

    gross = float(sum(line.weight for line in final))
    cash = max(0.0, 1.0 - gross)

    # The invariants, asserted rather than reviewed. Every claim in this
    # module's docstring reduces to these four lines, and a future edit
    # that breaks one must not be able to do it quietly.
    assert all(line.weight >= -_EPS for line in final), "a weight went negative"
    assert all(
        line.weight <= line.cap + _EPS for line in final
    ), "a sleeve escaped its own cap"
    assert gross <= 1.0 + _EPS, "the non-cash book exceeded NAV"
    assert abs(gross + cash - 1.0) <= 1e-9, "cash is not the residual"

    return Allocation(
        asof=stamp,
        lines=tuple(final),
        cash_weight=cash,
        cash_sleeve=cash_sleeve,
        cash_available=bool(cash_available),
        gross_before_budget=gross_before,
        gross=gross,
        budget_scale=scale,
        n_included=sum(1 for line in final if line.status is SleeveStatus.INCLUDED),
        n_absent=sum(1 for line in final if line.status is SleeveStatus.ABSENT),
        n_unscored=sum(1 for line in final if line.status is SleeveStatus.UNSCORED),
        estimate=estimate,
    )


def _line(s: SleeveSignals) -> SleeveLine:
    """One sleeve through steps one to four, before the budget."""
    cap = float(s.cap)
    status, reason = _status(s)

    if status is not SleeveStatus.INCLUDED:
        return SleeveLine(
            asset=s.asset,
            sleeve=s.sleeve or s.asset,
            ticker=s.ticker,
            status=status,
            cap=cap,
            excluded_because=reason,
            trend_score=float(s.trend_score),
            vol_scalar=float(s.vol_scalar),
            book_correlation=float(s.book_correlation),
            haircut=float("nan"),
            correlation_multiplier=float("nan"),
            top_partner=s.top_partner,
            top_correlation=float(s.top_correlation),
            # NaN and not zero, all the way down. A zero here would read
            # as a step that ran and produced nothing, and no step ran.
            after_trend=float("nan"),
            after_vol=float("nan"),
            after_correlation=float("nan"),
            after_cap=0.0,
            weight=0.0,
            binding=status.value,
        )

    # 1. Trend. The score is the fraction of the cap to take, floored at
    #    zero because the alternative instruction is a short.
    participation = max(float(s.trend_score), 0.0)
    after_trend = cap * participation

    # 2. Inverse volatility. Floored at zero for the same reason and
    #    never bounded above here — the cap two steps down is the
    #    ceiling, and clipping the scalar itself would silently change
    #    what "comparable risk" means.
    scalar = max(float(s.vol_scalar), 0.0)
    after_vol = after_trend * scalar

    # 3. Correlation. A haircut, and only a haircut.
    multiplier = min(max(float(s.correlation_multiplier), 0.0), 1.0)
    after_correlation = after_vol * multiplier

    # 4. The cap.
    after_cap = min(max(after_correlation, 0.0), cap)

    return SleeveLine(
        asset=s.asset,
        sleeve=s.sleeve or s.asset,
        ticker=s.ticker,
        status=status,
        cap=cap,
        excluded_because="",
        trend_score=float(s.trend_score),
        vol_scalar=float(s.vol_scalar),
        book_correlation=float(s.book_correlation),
        haircut=1.0 - multiplier,
        correlation_multiplier=multiplier,
        top_partner=s.top_partner,
        top_correlation=float(s.top_correlation),
        after_trend=after_trend,
        after_vol=after_vol,
        after_correlation=after_correlation,
        after_cap=after_cap,
        weight=after_cap,
        binding="",
    )


def _status(s: SleeveSignals) -> tuple[SleeveStatus, str]:
    """Which of the three states this sleeve is in, and the sentence.

    Ordered, and the order is the claim. Absence outranks abstention: a
    vehicle that did not trade cannot be said to lack history, it lacks
    everything. Below that, whichever signal declined first is named,
    because "no trend score" and "no volatility estimate" send a reader
    to different files.

    Neither sentence quotes a window length, and that is deliberate:
    this function is handed scores rather than the parameters that
    produced them, so a session count printed here would be the module
    default and would be quietly wrong for any caller who passed their
    own. A precise error that is wrong is worse than a vague one — it
    sends somebody to check a window that was never used.
    """
    if not s.present:
        return (
            SleeveStatus.ABSENT,
            "no usable bar at this close — the vehicle had not listed, or "
            "did not trade",
        )
    if not math.isfinite(float(s.trend_score)):
        return (
            SleeveStatus.UNSCORED,
            "trend declined: this sleeve has not banked a complete lookback "
            "window here",
        )
    if not math.isfinite(float(s.vol_scalar)):
        return (
            SleeveStatus.UNSCORED,
            "no volatility estimate: this sleeve has not banked a complete "
            "estimation window here",
        )
    return SleeveStatus.INCLUDED, ""


def _replace_weight(line: SleeveLine, *, weight: float, scaled: bool) -> SleeveLine:
    """Attach the post-budget weight and name the step that did the cutting.

    `binding` is the largest single reduction measured from the sleeve's
    own cap, which is the ceiling every other step is subtracting from.
    Ties go to the earlier step, so a sleeve that trend zeroed reads as
    a trend decision rather than as a cap that had nothing to bind on.
    """
    if line.status is not SleeveStatus.INCLUDED:
        return line

    cuts = (
        ("trend", line.cap - line.after_trend),
        ("inverse_vol", line.after_trend - line.after_vol),
        ("correlation", line.after_vol - line.after_correlation),
        ("cap", line.after_correlation - line.after_cap),
        ("gross_budget", line.after_cap - weight if scaled else 0.0),
    )
    binding = "none"
    best = _EPS
    for name, amount in cuts:
        if amount > best:
            binding, best = name, amount

    return SleeveLine(
        asset=line.asset,
        sleeve=line.sleeve,
        ticker=line.ticker,
        status=line.status,
        cap=line.cap,
        excluded_because=line.excluded_because,
        trend_score=line.trend_score,
        vol_scalar=line.vol_scalar,
        book_correlation=line.book_correlation,
        haircut=line.haircut,
        correlation_multiplier=line.correlation_multiplier,
        top_partner=line.top_partner,
        top_correlation=line.top_correlation,
        after_trend=line.after_trend,
        after_vol=line.after_vol,
        after_correlation=line.after_correlation,
        after_cap=line.after_cap,
        weight=weight,
        binding=binding,
    )


# -- from a price panel -------------------------------------------------


def size_weights(
    close_adj: pd.DataFrame,
    *,
    asof: pd.Timestamp | str | None = None,
    caps: Mapping[str, float] | None = None,
    risk_free: float | pd.Series = 0.0,
    lookbacks: Sequence[int] = trend.LOOKBACKS,
    short_window: int = volatility.SHORT_WINDOW,
    long_window: int = volatility.LONG_WINDOW,
    short_weight: float = volatility.SHORT_WEIGHT,
    min_annual_volatility: float = volatility.MIN_ANNUAL_VOLATILITY,
    correlation_lookback: int = correlation.LOOKBACK,
    min_observations: int | None = None,
) -> Allocation:
    """Run the three signals at one close and compose the book.

    `close_adj` is a wide panel of TOTAL-RETURN closes columned by
    sleeve key or by vehicle ticker; both spellings resolve, because the
    rest of the project uses both and a sizing layer that only
    understood one would be a silent no-op on the other. Nothing here
    reads an unadjusted price: over 2004-2026 TLT returned -2.6% on
    price and +105.8% on total return, so a book sized off `close_unadj`
    would conclude the defensive sleeves are dead weight and hold none
    of them.

    `asof` resolves BACKWARD to the last session at or before the date
    given, the same as `correlation._window`, and the resolved stamp is
    on the result. Backward is safe by construction; snapping to the
    nearest session would be in the future half the time, which is why
    the trend panel refuses to do it at all.

    `risk_free` travels through to the trend signal, where it is the
    hurdle each lookback's return has to clear. It defaults to zero and
    zero is NOT neutral — with a zero hurdle anything that drifted
    upward reads as trending, which in a positive-drift world is most
    things most of the time. A caller with the bill series in hand
    should pass it.

    The cash sleeve is recognised by name and taken out before any
    signal runs. Three reasons that agree: its weight is the residual
    rather than a bet, its trend is a statement about the hurdle rather
    than an opportunity, and leaving it in the panel would drag the
    inverse-vol reference — a cross-sectional median — down to a T-bill
    fund's volatility and inflate every other sleeve's scalar by the
    same factor.
    """
    index = _validated_index(close_adj)
    end = _resolve_asof(index, asof)

    # The tail is an optimisation and provably not a change of answer:
    # every window below is trailing and none reaches further back than
    # `need` closes, so the last row of the tail is the last row of the
    # whole panel. It matters over a twenty-year walk, where the
    # alternative is re-typing five thousand rows every session — and it
    # is derived from the arguments rather than from the module
    # constants, so a caller who lengthens a window still gets the bars
    # that window needs.
    need = max(
        max(int(lb) for lb in lookbacks) + 1,
        int(long_window) + 1,
        int(correlation_lookback) + 1,
    )
    lo = max(end - need, 0)
    cut = _as_float_panel(close_adj.iloc[lo:end], index[lo:end])
    stamp = pd.Timestamp(cut.index[-1])

    overrides = {str(k): float(v) for k, v in (caps or {}).items()}
    risk_assets, cash_asset = _split_cash(cut.columns)
    if not risk_assets:
        raise SizingError(
            "the panel contains no risk sleeve to size. A book of cash is a "
            "legitimate outcome of this process and is not a legitimate "
            "input to it"
        )

    risk_panel = cut.loc[:, risk_assets]

    scores = trend.score_asof(
        risk_panel, lookbacks=lookbacks, risk_free=risk_free
    )
    scalars = volatility.inverse_volatility_scalar(
        risk_panel,
        short_window=short_window,
        long_window=long_window,
        short_weight=short_weight,
        min_annual_volatility=min_annual_volatility,
    ).iloc[-1]

    last = risk_panel.iloc[-1]
    present = {a: bool(np.isfinite(last[a]) and last[a] > 0.0) for a in risk_assets}

    # Step two's weights are what the haircut is measured against, so
    # they have to exist before the correlation runs. Only the sleeves
    # that got through both earlier signals are proposed: a sleeve with
    # no weight contributes nothing to anybody's book correlation, and
    # handing the estimator a NaN would be refused outright.
    proposed: dict[str, float] = {}
    for asset in risk_assets:
        if not present[asset]:
            continue
        score = float(scores.get(asset, float("nan")))
        scalar = float(scalars.get(asset, float("nan")))
        if not (math.isfinite(score) and math.isfinite(scalar)):
            continue
        cap = _cap_for(asset, overrides)
        proposed[asset] = cap * max(score, 0.0) * max(scalar, 0.0)

    adjustment: correlation.CorrelationAdjustment | None = None
    if proposed:
        adjustment = correlation.adjust_weights(
            proposed,
            risk_panel,
            asof=stamp,
            lookback=correlation_lookback,
            min_observations=min_observations,
        )

    signals: list[SleeveSignals] = []
    for asset in risk_assets:
        sleeve = _SLEEVE_BY_ALIAS.get(asset)
        multiplier, rho, partner, partner_rho = _haircut_of(adjustment, asset)
        signals.append(
            SleeveSignals(
                asset=asset,
                cap=_cap_for(asset, overrides),
                trend_score=float(scores.get(asset, float("nan"))),
                vol_scalar=float(scalars.get(asset, float("nan"))),
                correlation_multiplier=multiplier,
                book_correlation=rho,
                top_partner=partner,
                top_correlation=partner_rho,
                present=present[asset],
                sleeve=sleeve.key if sleeve else asset,
                ticker=sleeve.ticker if sleeve else "",
            )
        )

    cash_present = bool(
        cash_asset is not None
        and np.isfinite(cut.iloc[-1][cash_asset])
        and cut.iloc[-1][cash_asset] > 0.0
    )
    return compose(
        signals,
        asof=stamp,
        cash_sleeve=cash_asset or CASH_SLEEVE_KEY,
        cash_available=cash_present,
        estimate=adjustment.estimate if adjustment is not None else None,
    )


def _haircut_of(
    adjustment: correlation.CorrelationAdjustment | None, asset: str
) -> tuple[float, float, str, float]:
    """The haircut this sleeve was charged, or none at all.

    A sleeve outside the matrix passes through at a multiplier of
    exactly one, which is the less conservative of the two available
    errors and is the same choice `correlation.adjust_weights` makes
    inside itself: charging a haircut to a sleeve we have no correlation
    evidence about would be an adjustment firing on absent data. It is
    bounded, because the cap and the gross budget still bind.
    """
    if adjustment is None or asset not in adjustment.multiplier.index:
        return 1.0, float("nan"), "", float("nan")
    return (
        float(adjustment.multiplier[asset]),
        float(adjustment.book_correlation.get(asset, float("nan"))),
        str(adjustment.top_partner.get(asset, "")),
        float(adjustment.top_correlation.get(asset, float("nan"))),
    )


def _validated_index(close_adj: pd.DataFrame) -> pd.DatetimeIndex:
    """The panel's sessions, or a loud refusal.

    The same three refusals the signals make one layer down, restated
    here so the error names the sizing call rather than surfacing from
    inside whichever signal happened to run first. Each is a way a
    weight comes out plausible and wrong: an unsorted index reverses the
    sign of every lookback return, a duplicated session puts one bar
    into a rolling window twice.

    Only the index is touched. Casting and column-naming wait until the
    frame has been cut to the window a decision actually needs — the
    strategy calls this once per session against a growing panel, and
    re-typing twenty years of closes to decide one day is the difference
    between a run that finishes and one nobody waits for.
    """
    if not isinstance(close_adj, pd.DataFrame):
        raise SizingError(
            f"expected a wide close_adj panel, got {type(close_adj)!r}"
        )
    if not len(close_adj.columns):
        raise SizingError("the close_adj panel has no sleeves in it")
    names = [str(c) for c in close_adj.columns]
    if len(set(names)) != len(names):
        # Two columns under one name make every lookup below return a
        # frame where a Series was expected, and the arithmetic that
        # survives that is the arithmetic that silently picked one.
        raise SizingError(
            f"the close_adj panel has duplicate column(s): "
            f"{sorted({n for n in names if names.count(n) > 1})}"
        )
    if not isinstance(close_adj.index, pd.DatetimeIndex):
        raise SizingError("close_adj must be indexed by date")
    idx = pd.DatetimeIndex(close_adj.index).normalize()
    if len(idx) == 0:
        raise SizingError("the close_adj panel has no sessions in it")
    if not idx.is_monotonic_increasing:
        raise SizingError(
            "close_adj is not sorted ascending. Sorting it here would hide "
            "the upstream bug, and every lookback return underneath would "
            "already have been computed backwards."
        )
    if idx.has_duplicates:
        n = int(idx.duplicated().sum())
        raise SizingError(f"close_adj has {n:,} duplicate session(s)")
    return idx


def _as_float_panel(frame: pd.DataFrame, idx: pd.DatetimeIndex) -> pd.DataFrame:
    out = frame.astype("float64")
    out.columns = pd.Index([str(c) for c in frame.columns])
    out.index = idx
    return out


def _resolve_asof(idx: pd.DatetimeIndex, asof: pd.Timestamp | str | None) -> int:
    """How many sessions are visible at `asof`. Backward, never forward.

    Returns a count rather than a date because the caller wants a slice,
    and because the two are the same fact stated once. Snapping backward
    to the last session at or before the date is safe by construction;
    snapping to the NEAREST would land in the future about half the time,
    which is why the trend panel refuses to snap at all.
    """
    if asof is None:
        return int(len(idx))
    stamp = pd.Timestamp(asof).normalize()
    end = int(idx.searchsorted(stamp, side="right"))
    if end == 0:
        raise SizingError(
            f"no session on or before {stamp.date()}; the panel starts "
            f"{idx[0].date()}"
        )
    return end


def _split_cash(columns: Sequence[Any]) -> tuple[list[str], str | None]:
    """Risk sleeves, and the one column that is the residual absorber."""
    risk: list[str] = []
    cash: str | None = None
    for raw in columns:
        col = str(raw)
        if col in _CASH_KEYS:
            if cash is not None:
                raise SizingError(
                    f"the panel carries two cash columns ({cash!r} and "
                    f"{col!r}); the residual has one home or it has none"
                )
            cash = col
            continue
        risk.append(col)
    return risk, cash


def _cap_for(asset: str, overrides: Mapping[str, float]) -> float:
    """The sleeve's ceiling, or a loud refusal to invent one.

    An unrecognised column is an error rather than a default. A cap is a
    prior about how wrong a position may be, argued one at a time in
    `sleeves.py`; falling back to 1.00 for a name nobody capped would
    put a risk decision in the plumbing, where nobody would think to
    look for it.
    """
    if asset in overrides:
        return float(overrides[asset])
    sleeve = _SLEEVE_BY_ALIAS.get(asset)
    if sleeve is None:
        raise SizingError(
            f"{asset!r} is not a sleeve and carries no cap. Add it to "
            f"portfolio/sleeves.py with the argument for its ceiling, or "
            f"pass caps={{{asset!r}: ...}} deliberately — this layer will "
            f"not size a position whose worst case nobody has stated."
        )
    return float(sleeve.max_weight)


def _frame(rows: list[dict[str, Any]], cols: dict[str, str]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
    return pd.DataFrame(rows)[list(cols)].astype(cols)


# -- the strategy the engine drives -------------------------------------


class SleeveSizing:
    """The `Strategy` the backtest engine expects, and nothing more.

    `targets` is the whole protocol: history in, a complete statement of
    the desired book out, as weights of NAV. Everything about fills,
    settlement, costs and the turnover budget belongs to the engine and
    is not consulted here — the strategy is handed a `MarketView` whose
    frames have already been cut at the close of T, so there is no
    expression it could write that reaches tomorrow's open even if it
    wanted to.

    Two decisions this class makes that `compose` deliberately does not.

    **The caps come from the view where the view has them.** The engine
    publishes its own ceilings on `MarketView.caps` precisely so a
    strategy does not chase a weight it will never be allowed to hold,
    and those ceilings are the sleeve caps unless somebody overrode one
    in `BacktestConfig`. Reading them here is what keeps a configured
    override from being silently ignored for the length of a run.

    **The residual can be HELD or merely left.** With `hold_cash_sleeve`
    the cash weight is targeted at the cash vehicle, which is what the
    real account does — the money sits in a T-bill fund and earns the
    front end, which over 2005-2007 was five per cent. Without it the
    residual is uninvested balance earning nothing, which understates
    the strategy by roughly the bill rate times the time spent out. The
    flag exists because the cash sleeve is spliced before BIL listed, so
    a panel may simply not carry the column; when it does not, or when
    the vehicle has no bar at T, the residual is left uninvested and the
    allocation says so in `cash_available`.

    `warmup` is read by the engine and is the honest number: before
    `WARMUP_SESSIONS` closes are banked, at least one of the three
    signals abstains on every sleeve and the book would be entirely
    cash. Letting the engine skip those days is not a shortcut, it is
    declining to log five thousand trades of nothing.
    """

    def __init__(
        self,
        *,
        name: str = "sleeve sizing",
        risk_free: float | pd.Series = 0.0,
        caps: Mapping[str, float] | None = None,
        hold_cash_sleeve: bool = True,
        record: bool = True,
        lookbacks: Sequence[int] = trend.LOOKBACKS,
        short_window: int = volatility.SHORT_WINDOW,
        long_window: int = volatility.LONG_WINDOW,
        short_weight: float = volatility.SHORT_WEIGHT,
        min_annual_volatility: float = volatility.MIN_ANNUAL_VOLATILITY,
        correlation_lookback: int = correlation.LOOKBACK,
        min_observations: int | None = None,
    ) -> None:
        self.name = str(name)
        self.risk_free = risk_free
        self.caps = {str(k): float(v) for k, v in (caps or {}).items()}
        self.hold_cash_sleeve = bool(hold_cash_sleeve)
        self.record = bool(record)
        self.lookbacks = tuple(int(lb) for lb in lookbacks)
        self.short_window = int(short_window)
        self.long_window = int(long_window)
        self.short_weight = float(short_weight)
        self.min_annual_volatility = float(min_annual_volatility)
        self.correlation_lookback = int(correlation_lookback)
        self.min_observations = min_observations
        self._allocations: list[Allocation] = []

        # Same arithmetic `WARMUP_SESSIONS` states for the defaults, done
        # against whatever this instance was actually given.
        self.warmup = (
            max(
                max(self.lookbacks) + 1,
                self.long_window + 1,
                self.correlation_lookback + 1,
            )
            - 1
        )

    @property
    def allocations(self) -> tuple[Allocation, ...]:
        """Every decision the run made, in order.

        Empty when `record` is off, which is why recording is the
        default: a run whose weights cannot be explained afterwards is
        a number with no reason attached, and the reason is the part
        anybody will actually be asked for.
        """
        return tuple(self._allocations)

    def decomposition(self) -> pd.DataFrame:
        return decomposition(self._allocations)

    def targets(self, view: Any) -> Mapping[str, float]:
        panel = view.close_adj
        view_caps = getattr(view, "caps", None) or {}
        caps: dict[str, float] = {}
        for raw in panel.columns:
            asset = str(raw)
            if asset in self.caps:
                caps[asset] = self.caps[asset]
            elif asset in _SLEEVE_BY_ALIAS and asset in view_caps:
                # Only for names the sleeve table already knows. The
                # engine hands a cap for every asset in the panel,
                # including its 1.00 default for anything uncapped, and
                # accepting that would let an unrecognised column into
                # the book at full size through the back door — which is
                # exactly what `_cap_for` refuses to do out front.
                caps[asset] = float(view_caps[asset])

        allocation = size_weights(
            panel,
            asof=view.asof,
            caps=caps,
            risk_free=self.risk_free,
            lookbacks=self.lookbacks,
            short_window=self.short_window,
            long_window=self.long_window,
            short_weight=self.short_weight,
            min_annual_volatility=self.min_annual_volatility,
            correlation_lookback=self.correlation_lookback,
            min_observations=self.min_observations,
        )
        if self.record:
            self._allocations.append(allocation)

        # Every column stated, including the zeroes. The protocol reads
        # an absent asset as a target of zero either way, but a
        # strategy that leaves names out is one edit away from leaving
        # one out by accident and holding it forever.
        targets = {line.asset: line.weight for line in allocation.lines}
        cash = allocation.cash_sleeve
        if cash in {str(c) for c in panel.columns}:
            targets[cash] = (
                allocation.cash_weight
                if self.hold_cash_sleeve and allocation.cash_available
                else 0.0
            )
        return targets
