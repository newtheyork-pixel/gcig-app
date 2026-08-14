"""The modern tactical asset allocation family, as its authors wrote it.

Five rules that a person outside this project fixed, wrote down and
dated. That is the entire reason they are here. The project stopped
hunting for an edge when its own nine-sleeve strategy lost to SPY by
five points a year and was not significant after thirteen trials; what
replaces the hunt is a uniform replication of published strategies
measured only from each one's own publication date forward. A date set
by somebody else, years ago, in a document with a timestamp, is a
stronger out-of-sample guarantee than any holdout this project could
carve for itself, because it cannot be moved after the fact and it was
never ours to peek at.

**The trap this file exists to refuse is the improvement.** Every one
of these strategies has a constant in it that looks arbitrary, because
it is: a 13612W momentum weighting that puts forty per cent of the
score on the most recent month, a breadth threshold of four out of
twelve, a protection factor that resolves to exactly half the universe,
a top-six that could as easily have been a top-five. Those numbers are
DATA — they are the record of how hard each strategy was fitted before
it was published, and rounding one off to something tidier destroys the
measurement. If a lookback here looks wrong to you, that reaction is
the phenomenon McLean and Pontiff measured, not a bug report. Write it
in the summary; do not write it in the code.

Three consequences worth knowing before reading any class below.

**These are MONTHLY strategies driven by a daily engine.** Every one of
them signals at a month-end close and holds until the next month-end.
So `targets` recomputes only on the last session of a month and returns
the standing book on every other day, and the engine fills at the next
open exactly as the papers say to. Whether today is the last session of
its month is answered off the exchange calendar rather than off the
panel — the panel is truncated at T and cannot see forward, but the
NYSE holiday schedule is public years in advance and consulting it
leaks nothing about prices.

**A cap turns a published strategy into a different one, silently.**
VAA-G4 puts a hundred per cent of the book in one ETF when momentum is
clean; the project's sleeve caps would hold that to a quarter and the
strategy would spend twenty years chasing a weight it is never allowed
to reach. Run these with `BacktestConfig(apply_sleeve_caps=False,
default_max_weight=1.0)`. The classes clamp to whatever caps the view
publishes anyway, so a misconfigured run degrades to something stable
rather than to a permanent order queue — but it is no longer the
strategy on the paper, and the run should not be reported as one.

**Where the paper names an asset our free panel does not carry, the
substitution is declared and not hidden.** `DEFAULT_SUBSTITUTES` is the
whole list, each entry with the reason. A published ticker with no
column and no substitute lands in `missing` on the instance, because a
universe quietly one line short changes every breadth count that
follows and that is precisely the kind of departure a replication study
cannot afford to discover later.

On dates. `published_on` is the day the rules became readable by
somebody who was not their author. Where a source gives only a month or
a year, the attribute is the LAST day of that period — the latest date
consistent with the evidence, which is the conservative direction for
an out-of-sample claim, since it credits the strategy with nothing it
might still have been fitting. Each class says in `as_published` what
precision its date actually has and what would change it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ..engine.ledger import settlement_date

__all__ = [
    "DEFAULT_SUBSTITUTES",
    "AdaptiveAssetAllocation",
    "DefensiveAssetAllocation",
    "GlobalTacticalAssetAllocationAggressive",
    "MonthlyTactical",
    "ProtectiveAssetAllocation",
    "TacticalDecision",
    "TacticalError",
    "VigilantAssetAllocation",
    "VigilantAssetAllocationG4",
    "minimum_variance_weights",
]


class TacticalError(ValueError):
    """A published rule was handed something it cannot be run against."""


#: Weight arithmetic tolerance, in the engine's units.
_EPS = 1e-9

#: Sessions in a month, for sizing the tail we slice before resampling.
#: Deliberately generous — this decides how much of the panel gets
#: re-typed, never which month-end a lookback lands on.
_SESSIONS_PER_MONTH = 23


#: Tickers a paper names that this project's free ETF panel does not
#: carry, and what stands in. Each one is a real change to the strategy
#: and is stated as such rather than being absorbed into a comment.
#:
#: GSG tracks the S&P GSCI, which is roughly two thirds energy by
#: weight. DBC tracks a broader index with an optimised roll rule. Both
#: are commodity futures pools rather than spot, both were live well
#: before any of the papers that name GSG, and in a month when crude
#: moves and metals do not they will disagree by a lot. Substituting is
#: better than dropping a line from a breadth count, and it is not the
#: same instrument.
DEFAULT_SUBSTITUTES: Mapping[str, str] = {
    "GSG": "DBC",
}


# -- the calendar question ----------------------------------------------


@lru_cache(maxsize=8192)
def _is_month_end_session(day: pd.Timestamp) -> bool:
    """Is `day` the last exchange session of its calendar month.

    Asked of the NYSE calendar rather than of the price panel, and the
    distinction matters. The panel handed to a strategy stops at the
    close of T by construction, so it cannot answer "is there another
    session this month" without seeing a bar it is not allowed to see.
    The holiday schedule can, it is published years ahead, and knowing
    that the 30th is a Saturday tells you nothing whatsoever about what
    anything closed at.
    """
    return settlement_date(day, cycle=1).month != pd.Timestamp(day).month


# -- month-end arithmetic -----------------------------------------------


def _month_end_closes(
    panel: pd.DataFrame, assets: Sequence[str], months: int
) -> pd.DataFrame:
    """The last close of each calendar month, for `assets`, most recent
    `months` or so.

    Every momentum figure in this file is a MONTHLY return off month-end
    closes, because that is what the papers compute and because a
    "twelve month return" measured 252 sessions back lands on a
    different day for every asset in a panel with a listing gap in it.

    The tail is an optimisation and provably not a change of answer: the
    deepest lookback here is twelve month-ends and the slice keeps more
    than that, so the rows a decision reads are the same rows it would
    have read against the whole panel.
    """
    keep = max(int(months) + 2, 2) * _SESSIONS_PER_MONTH
    tail = panel.iloc[-keep:] if len(panel) > keep else panel
    have = set(str(c) for c in tail.columns)
    # Deduplicated, because two published names can resolve to one
    # column and a duplicated label turns every later lookup into a
    # frame where a Series was expected.
    cols = list(dict.fromkeys(a for a in assets if a in have))
    if not cols:
        return pd.DataFrame(index=pd.DatetimeIndex([], name="date"))

    sub = tail.loc[:, cols].astype("float64")
    idx = pd.DatetimeIndex(sub.index)
    stamp = idx.year.to_numpy() * 12 + idx.month.to_numpy()
    # The last row of each run of equal (year, month) keys. The index is
    # sorted ascending — the engine refuses to run otherwise — so a run
    # is contiguous and its end is where the key changes.
    ends = np.flatnonzero(np.r_[stamp[1:] != stamp[:-1], True])
    out = sub.iloc[ends]
    out.columns = pd.Index([str(c) for c in out.columns])
    return out


def _lookback_return(closes: pd.DataFrame, months: int) -> pd.Series:
    """`p0 / p_months - 1`, on month-end closes.

    NaN where the asset has not banked the window, and NaN is left as
    NaN. A momentum score filled with zero on an asset with no history
    is a neutral opinion nobody held, and in a breadth count it is worse
    than that: zero is not positive, so the fill quietly votes the asset
    into the crash-protection tally.
    """
    if len(closes) < months + 1:
        return pd.Series(np.nan, index=closes.columns, dtype="float64")
    now = closes.iloc[-1]
    then = closes.iloc[-1 - months]
    return (now / then.where(then > 0.0)) - 1.0


def _momentum_13612w(closes: pd.DataFrame) -> pd.Series:
    """Keller and Keuning's weighted multi-horizon momentum.

    `(12 * r1 + 4 * r3 + 2 * r6 + 1 * r12) / 4`, with `rk = p0/pk - 1`
    on month-end closes. The weights are the paper's and they are not
    tidy.

    What they amount to is easier to see decomposed by calendar month
    than by leg, because the three-, six- and twelve-month legs all
    CONTAIN the most recent month. Doing that arithmetic, the last month
    carries 4.75 of the 12 units of weight — about forty per cent of the
    score — months two and three about fifteen per cent each, and each
    of months seven through twelve about two. A momentum measure whose
    twelfth month is worth two per cent is a one-month signal wearing a
    twelve-month name, and that is the strategy rather than an artefact
    of it.

    The division by four is cosmetic — it changes no ranking and no sign
    — and is kept because dropping it would make a printed score
    incomparable to the paper's.
    """
    r1 = _lookback_return(closes, 1)
    r3 = _lookback_return(closes, 3)
    r6 = _lookback_return(closes, 6)
    r12 = _lookback_return(closes, 12)
    return (12.0 * r1 + 4.0 * r3 + 2.0 * r6 + 1.0 * r12) / 4.0


def _momentum_over_sma(closes: pd.DataFrame, window: int) -> pd.Series:
    """`p0 / SMA(window month-ends) - 1` — the PAA momentum.

    The window INCLUDES the current month-end, so a twelve-month PAA
    reads thirteen closes. See `ProtectiveAssetAllocation.as_published`:
    the paper's own notation admits both readings and this is the one
    the careful public replications use.
    """
    if len(closes) < window + 1:
        return pd.Series(np.nan, index=closes.columns, dtype="float64")
    sma = closes.iloc[-(window + 1) :].mean(axis=0)
    now = closes.iloc[-1]
    return (now / sma.where(sma > 0.0)) - 1.0


def _average_lookback_return(
    closes: pd.DataFrame, months: Sequence[int]
) -> pd.Series:
    """Faber's ranking measure: the mean of several horizons' returns.

    Equal weights across horizons, which is the opposite tilt from
    13612W and is worth noticing rather than harmonising — two papers
    five years apart, both claiming momentum, disagreeing about how much
    the last month is worth.
    """
    legs = [_lookback_return(closes, int(m)) for m in months]
    return sum(legs) / float(len(legs))


def _above_moving_average(closes: pd.DataFrame, window: int) -> pd.Series:
    """Faber's timing filter: this month's close over the N-month SMA.

    True, False or NA — and NA is not False. An asset with too little
    history has not failed the filter, it has not been asked, and the
    two produce the same allocation but different sentences in a report.
    """
    if len(closes) < window:
        return pd.Series(pd.NA, index=closes.columns, dtype="object")
    sma = closes.iloc[-window:].mean(axis=0)
    now = closes.iloc[-1]
    out: dict[str, Any] = {}
    for asset in closes.columns:
        p, m = float(now[asset]), float(sma[asset])
        out[asset] = (p > m) if (math.isfinite(p) and math.isfinite(m)) else pd.NA
    return pd.Series(out, dtype="object")


# -- minimum variance, long only, no leverage ---------------------------


def _project_simplex(v: np.ndarray) -> np.ndarray:
    """Nearest point with non-negative entries summing to one.

    Duchi's algorithm, exact and in closed form once the vector is
    sorted. Written out rather than approximated by clipping and
    renormalising, which is the obvious shortcut and is not the same
    projection — it moves weight between assets in a way that depends on
    the sign pattern rather than on the distance.
    """
    n = v.size
    u = np.sort(v)[::-1]
    css = np.cumsum(u) - 1.0
    ind = np.arange(1, n + 1, dtype="float64")
    cond = np.flatnonzero(u - css / ind > 0.0)
    rho = int(cond[-1]) if cond.size else 0
    theta = css[rho] / float(rho + 1)
    return np.maximum(v - theta, 0.0)


def minimum_variance_weights(
    returns: np.ndarray, *, max_iter: int = 5000
) -> np.ndarray:
    """Long-only minimum variance over a small set of assets.

    Projected gradient on the simplex. Two things about it are worth
    saying plainly.

    It is CONSTRAINED minimum variance, not the textbook closed form.
    The unlevered long-only account cannot hold the analytic solution —
    that vector routinely wants a short in whichever asset carries the
    strongest positive covariance with the rest, and clipping it to zero
    afterwards does not produce the constrained optimum, it produces a
    different portfolio that happens to be non-negative.

    The covariance is rescaled to unit average variance before the
    iteration. Daily return covariances live around 1e-4, which makes a
    gradient step of one over the largest eigenvalue about ten thousand,
    and a step size that large is where a well-posed convex problem
    starts producing arithmetic noise. Scaling a covariance by a
    positive constant cannot move its minimum-variance portfolio, so
    this buys conditioning at no cost to the answer. `max_iter` and the
    stopping tolerance are numerical, not economic: they decide how
    precisely the same portfolio is found, never which one.
    """
    arr = np.asarray(returns, dtype="float64")
    if arr.ndim != 2 or arr.shape[1] == 0:
        raise TacticalError("minimum variance needs a 2-D returns matrix")
    n = arr.shape[1]
    if n == 1:
        return np.ones(1, dtype="float64")

    equal = np.full(n, 1.0 / n, dtype="float64")
    if arr.shape[0] < 2:
        return equal

    cov = np.cov(arr, rowvar=False, ddof=1)
    cov = np.atleast_2d(np.asarray(cov, dtype="float64"))
    if not np.isfinite(cov).all():
        return equal

    scale = float(np.trace(cov)) / float(n)
    if not math.isfinite(scale) or scale <= 0.0:
        return equal
    s = cov / scale
    s = 0.5 * (s + s.T)

    lam = float(np.linalg.eigvalsh(s).max())
    if not math.isfinite(lam) or lam <= 0.0:
        return equal
    step = 1.0 / (2.0 * lam)

    w = equal.copy()
    for _ in range(int(max_iter)):
        nxt = _project_simplex(w - step * (2.0 * (s @ w)))
        if float(np.abs(nxt - w).max()) < 1e-12:
            w = nxt
            break
        w = nxt

    total = float(w.sum())
    return w / total if total > 0.0 else equal


# -- what one month-end decided -----------------------------------------


@dataclass(frozen=True)
class TacticalDecision:
    """One month-end's reasoning, kept beside the weights.

    The same rule the engine's result object obeys: a reporting layer
    must never recompute a quantity the process already had in its hand.
    Six months from now the question will be why DAA was entirely in
    IEF in a month the market rose, and the answer is a breadth count of
    two on a canary universe of two — a number that exists for one
    instant inside `_decide` and is gone unless it is written down here.
    """

    asof: pd.Timestamp
    key: str
    weights: Mapping[str, float]
    #: How many assets voted for protection, in whatever universe the
    #: strategy counts breadth over.
    breadth: int
    #: The share of NAV the rule sent to safety, before any cap.
    cash_fraction: float
    selected: tuple[str, ...]
    #: Where the protective share actually went. Empty when the rule
    #: names no vehicle, or when the vehicle had no column.
    protection: tuple[str, ...]
    momentum: Mapping[str, float] = field(default_factory=dict)
    note: str = ""

    def as_row(self) -> dict[str, Any]:
        return {
            "date": self.asof,
            "strategy": self.key,
            "breadth": self.breadth,
            "cash_fraction": self.cash_fraction,
            "n_selected": len(self.selected),
            "selected": " ".join(self.selected),
            "protection": " ".join(self.protection),
            "gross": float(sum(self.weights.values())),
            "note": self.note,
        }


# -- the shared machinery -----------------------------------------------


class MonthlyTactical:
    """Signal at a month-end close, hold until the next one.

    Everything common to the five rules below and nothing specific to
    any of them. Subclasses set the seven publication attributes and
    implement `_decide`, which is handed a frame of month-end closes
    ending at the decision session and returns weights of NAV.

    Two behaviours are worth stating because they look like defaults and
    are decisions.

    **Before the first month-end the book is empty.** A monthly strategy
    started on the eleventh of the month does not front-run its own
    calendar to get invested sooner; it waits, and the wait is at most
    one month at the very start of a run. Deploying early would be the
    only free lunch in the file and it would be ours rather than the
    author's.

    **A weight is clamped to the view's cap and the residual becomes
    cash, never redistributed.** Redistribution is the tempting repair
    and it is a different strategy: a rule that says a hundred per cent
    of one ETF, run under a twenty-five per cent cap, is not "the same
    idea spread wider", it is a book nobody published. The module
    docstring says how to configure a run so no cap binds at all, which
    is the configuration these belong in.
    """

    #: Set by every subclass. Declared here so the attribute error for a
    #: half-written strategy names the missing attribute rather than
    #: turning up three thousand sessions into a run.
    key: str = ""
    title: str = ""
    citation: str = ""
    published_on: date = date(1900, 1, 1)
    universe: tuple[str, ...] = ()
    rationale: str = ""
    as_published: str = ""

    #: The deepest month-end lookback the rule reads.
    months_needed: int = 12

    def __init__(
        self,
        *,
        name: str | None = None,
        substitutes: Mapping[str, str] | None = None,
        record: bool = True,
    ) -> None:
        if not self.key:
            raise TacticalError(
                f"{type(self).__name__} has no key; the publication "
                "attributes are the point of these classes, not decoration"
            )
        self.name = str(name or self.title or self.key)
        self.substitutes = dict(
            DEFAULT_SUBSTITUTES if substitutes is None else substitutes
        )
        self.record = bool(record)
        self._held: dict[str, float] = {}
        self._decisions: list[TacticalDecision] = []
        self._missing: tuple[str, ...] = ()
        self._substituted: dict[str, str] = {}

        # Sessions of history to bank before the engine asks anything.
        # Deliberately loose: the strategy checks its own history at
        # every month-end and holds nothing when it is short, so this is
        # an optimisation rather than a guarantee, and a warmup set too
        # long would silently delete real sample.
        self.warmup = _SESSIONS_PER_MONTH * (int(self.months_needed) + 1)

    # -- what a caller reads afterwards ---------------------------------

    @property
    def decisions(self) -> tuple[TacticalDecision, ...]:
        return tuple(self._decisions)

    @property
    def missing(self) -> tuple[str, ...]:
        """Published tickers with no column and no substitute.

        Non-empty means the run is not the published strategy: every
        breadth count in these rules has the universe size in its
        denominator, so a line short of the paper changes the crash
        threshold as well as the cross-section.
        """
        return self._missing

    @property
    def substituted(self) -> Mapping[str, str]:
        """Published ticker to the column that actually stood in for it.

        Reported separately from `missing` because a substitution is the
        quieter of the two failures and the easier one to forget: the
        run completes, every count is the right size, and one line of
        the universe is a different instrument from the one the paper
        names. A result that does not print this is claiming a
        replication it did not perform.
        """
        return dict(self._substituted)

    def decision_frame(self) -> pd.DataFrame:
        rows = [d.as_row() for d in self._decisions]
        if not rows:
            return pd.DataFrame(
                {
                    "date": pd.Series([], dtype="datetime64[ns]"),
                    "strategy": pd.Series([], dtype="str"),
                    "breadth": pd.Series([], dtype="int64"),
                    "cash_fraction": pd.Series([], dtype="float64"),
                    "n_selected": pd.Series([], dtype="int64"),
                    "selected": pd.Series([], dtype="str"),
                    "protection": pd.Series([], dtype="str"),
                    "gross": pd.Series([], dtype="float64"),
                    "note": pd.Series([], dtype="str"),
                }
            )
        return pd.DataFrame(rows)

    # -- the Strategy protocol ------------------------------------------

    def targets(self, view: Any) -> Mapping[str, float]:
        asof = pd.Timestamp(view.asof).normalize()
        if not _is_month_end_session(asof):
            return dict(self._held)

        panel = view.close_adj
        columns = {str(c) for c in panel.columns}
        resolved, missing = self._resolve(columns)
        self._missing = missing
        self._substituted = {k: v for k, v in resolved.items() if k != v}

        closes = _month_end_closes(
            panel, tuple(resolved.values()), self.months_needed
        )
        if len(closes) and pd.Timestamp(closes.index[-1]).normalize() != asof:
            # The panel's last row and the decision session must be the
            # same bar. If they are not, something upstream reindexed
            # the frame and every lookback below is off by a month.
            raise TacticalError(
                f"{self.key}: the last month-end close is "
                f"{pd.Timestamp(closes.index[-1]).date()} but the decision "
                f"session is {asof.date()}"
            )

        decision = self._decide(asof, closes, resolved, view)
        weights, clamped = self._fit(decision.weights, view)
        if clamped:
            decision = TacticalDecision(
                asof=decision.asof,
                key=decision.key,
                weights=weights,
                breadth=decision.breadth,
                cash_fraction=decision.cash_fraction,
                selected=decision.selected,
                protection=decision.protection,
                momentum=decision.momentum,
                note=(decision.note + "; clamped by the view's caps").lstrip("; "),
            )
        if self.record:
            self._decisions.append(decision)
        self._held = weights
        return dict(weights)

    # -- subclass hook --------------------------------------------------

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        raise NotImplementedError

    # -- shared plumbing ------------------------------------------------

    def _resolve(self, columns: set[str]) -> tuple[dict[str, str], tuple[str, ...]]:
        """Published ticker to the column that stands for it.

        A published name maps to itself when the panel has it, to its
        declared substitute when it does not, and to nothing at all
        otherwise — and the third case is reported rather than absorbed.
        """
        resolved: dict[str, str] = {}
        missing: list[str] = []
        for ticker in self.universe:
            if ticker in columns:
                resolved[ticker] = ticker
                continue
            alt = self.substitutes.get(ticker)
            if alt and alt in columns:
                resolved[ticker] = alt
                continue
            missing.append(ticker)
        return resolved, tuple(missing)

    def _fit(
        self, weights: Mapping[str, float], view: Any
    ) -> tuple[dict[str, float], bool]:
        """Clamp to the caps, refuse leverage, drop the dust.

        The flag is whether a CAP bound, and it is tracked here rather
        than inferred by the caller from a changed dictionary. Six
        weights of a sixth do not sum to one in binary, so the leverage
        guard below fires on ordinary float residue several times a
        year — and a caller comparing dictionaries would label those
        months as capped, which is the one thing the flag exists to
        report accurately.
        """
        caps = getattr(view, "caps", None) or {}
        out: dict[str, float] = {}
        clamped = False
        for asset, raw in weights.items():
            w = float(raw)
            if not math.isfinite(w) or w <= _EPS:
                continue
            cap = float(caps.get(str(asset), 1.0))
            if w > cap + _EPS:
                clamped = True
            out[str(asset)] = min(w, cap)

        gross = float(sum(out.values()))
        if gross > 1.0:
            # Only ever downward. These rules sum to one by construction,
            # so this is float residue rather than a leverage request —
            # but a scale that could go up would turn a rounding error
            # into borrowed money on some future edit.
            out = {a: w / gross for a, w in out.items()}
        return out, clamped

    @staticmethod
    def _columns_for(
        names: Sequence[str],
        resolved: Mapping[str, str],
        have: set[str],
    ) -> list[str]:
        """The panel columns standing for these published tickers.

        Order follows the published list, and duplicates are kept out:
        several of these universes name one ticker in two roles, and a
        column appearing twice would be counted twice in a breadth
        tally.
        """
        out = [resolved[t] for t in names if t in resolved and resolved[t] in have]
        return list(dict.fromkeys(out))

    @staticmethod
    def _finite(scores: pd.Series, columns: Sequence[str]) -> dict[str, float]:
        """Scores that are actually numbers, keyed by column.

        An asset that has not banked its window is left OUT rather than
        given a zero. Every breadth count below tests a score against
        zero, so a fill would enter the crash tally as a vote.
        """
        return {
            str(a): float(scores[a])
            for a in columns
            if math.isfinite(float(scores[a]))
        }

    @staticmethod
    def _rank(momentum: Mapping[str, float], n: int) -> tuple[str, ...]:
        """The top `n` by score, ties broken by ticker.

        Alphabetical is not a view about anything; it is the only
        tiebreak that gives the same book on two machines. A tie in a
        continuous momentum score is nearly impossible and would
        otherwise be resolved by dictionary order, which is insertion
        order, which is the order somebody happened to type a universe.
        """
        scored = [
            (a, float(s)) for a, s in momentum.items() if math.isfinite(float(s))
        ]
        scored.sort(key=lambda kv: (-kv[1], kv[0]))
        return tuple(a for a, _ in scored[: max(int(n), 0)])

    @staticmethod
    def _best(momentum: Mapping[str, float]) -> str:
        top = MonthlyTactical._rank(momentum, 1)
        return top[0] if top else ""

    @staticmethod
    def _breadth_cash_fraction(bad: int, *, breadth: int, top: int) -> float:
        """Keller and Keuning's cash fraction, exactly as written.

        `CF = (1/T) * floor(b * T / B)`, clipped to [0, 1]. The floor is
        the whole mechanism and it is why the formula cannot be replaced
        by the smooth `b/B` it approximates: the protective allocation
        moves in whole slots of the risky book, so it steps rather than
        slides, and with the paper's own parameters the two readings
        disagree. VAA-G12 has B=4 and T=5, so two bad assets out of
        twelve send exactly two fifths to safety, not one half.
        """
        if breadth <= 0 or top <= 0:
            raise TacticalError("breadth and top parameters must be positive")
        cf = math.floor(bad * top / breadth) / float(top)
        return min(max(cf, 0.0), 1.0)


# -- 1. Adaptive Asset Allocation ---------------------------------------


class AdaptiveAssetAllocation(MonthlyTactical):
    """Rank on trend, then weight what survives by minimum variance.

    The claim, as ReSolve made it: momentum answers WHICH assets to
    hold and it answers nothing at all about how much of each, because
    the ranking is ordinal and dollars are not risk. So the two
    questions get two different estimators — a six-month total return to
    choose the top five of ten asset classes, and a covariance matrix
    over a much shorter window to size them. The short covariance window
    is the substantive part of the argument: correlations are the
    fastest-moving input in a portfolio and an estimate averaged over a
    year is a description of a regime that has already ended.

    What the unlevered version costs. Minimum variance concentrates in
    the quietest assets available, which in this universe means
    Treasuries most of the time, and the published presentations of AAA
    scale the result to a volatility target — which is leverage when the
    selection is defensive. Here the weights sum to one and no further,
    so a month where the top five are IEF, TLT, GLD and two others of
    similar temperament produces a portfolio with about a third of the
    volatility the target version would have run, and roughly a third of
    its return. That is not a flaw in the replication; it is the honest
    long-only, unlevered form of the rule, and it is why the numbers
    here will not match any chart the authors published.
    """

    key = "aaa"
    title = "Adaptive Asset Allocation"
    citation = (
        "Butler, A., Philbrick, M., Gordillo, R., 'Adaptive Asset "
        "Allocation: A Primer', ReSolve Asset Management working paper "
        "(SSRN 2328254), 2012"
    )
    published_on = date(2012, 12, 31)
    universe = (
        "SPY",   # US equities
        "VGK",   # Europe
        "EWJ",   # Japan
        "EEM",   # emerging markets
        "VNQ",   # US REITs
        "RWX",   # international REITs
        "IEF",   # 7-10y Treasuries
        "TLT",   # 20y+ Treasuries
        "DBC",   # commodities
        "GLD",   # gold
    )
    rationale = (
        "Momentum selects and covariance sizes, because the two "
        "questions are different questions. A trailing six-month return "
        "says which asset classes are being bought; it says nothing "
        "about how much risk a dollar of each represents, and equal "
        "dollars across a Treasury fund and an emerging-market fund is "
        "a portfolio that is entirely one of them. Estimating the "
        "covariance over a short window rather than a long one is the "
        "adaptive part: correlation regimes turn over faster than any "
        "other input, and the year-long estimate that makes a "
        "covariance matrix stable also makes it a description of the "
        "past regime."
    )
    as_published = (
        "DATE. Year precision only. ReSolve dates the primer to 2012 and "
        "it was being discussed publicly by mid-2013; the SSRN abstract "
        "page (which refuses datacentre traffic) carries both a Date "
        "Written and a later Posted date, and the Posted date is the one "
        "an out-of-sample claim should use. This attribute is the end of "
        "2012, the latest day consistent with what could be verified. If "
        "somebody reads the posting date off SSRN and it is 2013, move "
        "this attribute — it is the whole experiment.\n"
        "PARAMETERS. Six-month momentum, top five of ten, minimum "
        "variance on sixty daily returns, monthly. The primer's own "
        "successor work sweeps one- to twelve-month lookbacks and top "
        "two through five, which is itself the finding: these were never "
        "presented as a single fixed claim, so the specific triple here "
        "is one point in a space its authors published as a space.\n"
        "LEVERAGE. The published presentations size the minimum-variance "
        "portfolio to a volatility target, which levers a defensive "
        "month. This is the unlevered form: weights sum to one, cash "
        "takes nothing because the optimiser is fully invested across "
        "the five, and both the return and the volatility will land far "
        "below the paper's.\n"
        "UNIVERSE. RWX (international REITs) is named by the paper and "
        "is not in this project's free ETF panel — there is no "
        "ex-US real-estate line in it at all. Absent a column the "
        "strategy runs on nine and the shortfall is recorded in "
        "`missing`, which is a real departure: the ranking is over a "
        "smaller cross-section, and it is the international real-estate "
        "line that is gone rather than an arbitrary one."
    )

    months_needed = 6

    def __init__(
        self,
        *,
        momentum_months: int = 6,
        n_hold: int = 5,
        covariance_days: int = 60,
        **kwargs: Any,
    ) -> None:
        self.momentum_months = int(momentum_months)
        self.n_hold = int(n_hold)
        self.covariance_days = int(covariance_days)
        self.months_needed = max(self.momentum_months, 1)
        super().__init__(**kwargs)
        # The covariance window is measured in sessions and can outrun
        # the momentum warmup on a short lookback, so the strategy banks
        # whichever is longer.
        self.warmup = max(self.warmup, self.covariance_days + 1)

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        momentum = _lookback_return(closes, self.momentum_months)
        scores = self._finite(momentum, [str(c) for c in closes.columns])
        selected = self._rank(scores, self.n_hold)
        if not selected:
            return TacticalDecision(
                asof=asof,
                key=self.key,
                weights={},
                breadth=0,
                cash_fraction=1.0,
                selected=(),
                protection=(),
                momentum=scores,
                note="no asset has banked the momentum window",
            )

        rets = self._daily_returns(view.close_adj, selected)
        if rets is None:
            weights = {a: 1.0 / len(selected) for a in selected}
            note = (
                "equal weight: the covariance window has too few clean "
                "returns to estimate"
            )
        else:
            usable, matrix = rets
            w = minimum_variance_weights(matrix)
            weights = {a: float(x) for a, x in zip(usable, w)}
            # The optimiser is fully invested across whatever it was
            # handed, so a selected asset dropped for a gap in its
            # covariance window does not leave a hole — it silently makes
            # the book more concentrated in the survivors. That is worth
            # a sentence on the row rather than a shrug.
            note = (
                ""
                if len(usable) == len(selected)
                else (
                    f"sized on {len(usable)} of {len(selected)} selected; "
                    "the rest had gaps in the covariance window"
                )
            )

        # AAA holds nothing back. The paper's protection is that a
        # falling asset drops out of the top five and a Treasury fund
        # takes its place, which is a rotation rather than a cash call —
        # so unlike the three Keller rules below, breadth is not part of
        # this strategy and the field is zero rather than absent.
        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights=weights,
            breadth=0,
            cash_fraction=0.0,
            selected=selected,
            protection=(),
            momentum=scores,
            note=note,
        )

    def _daily_returns(
        self, panel: pd.DataFrame, assets: Sequence[str]
    ) -> tuple[tuple[str, ...], np.ndarray] | None:
        """The covariance window's returns, or nothing usable.

        Returns rather than prices, and daily rather than monthly,
        because the whole argument for the short window is that it
        reacts — and sixty month-ends would be five years.
        """
        need = self.covariance_days + 1
        tail = panel.iloc[-need:] if len(panel) > need else panel
        cols = [a for a in assets if a in set(str(c) for c in tail.columns)]
        if not cols:
            return None
        sub = tail.loc[:, cols].astype("float64")
        rets = sub.pct_change().iloc[1:]
        rets = rets.dropna(axis=1, how="any")
        rets = rets.dropna(axis=0, how="any")
        if rets.shape[0] < 2 or rets.shape[1] == 0:
            return None
        return tuple(str(c) for c in rets.columns), rets.to_numpy(dtype="float64")


# -- 2. Protective Asset Allocation -------------------------------------


class ProtectiveAssetAllocation(MonthlyTactical):
    """Count how many of twelve are trending, and hold bonds for the rest.

    Keller and Keuning's argument is that the useful signal in a
    momentum universe is not the ranking, it is the COUNT. A month in
    which nine of twelve asset classes sit above their own twelve-month
    average and a month in which four do are different worlds, and the
    difference is legible before any single asset has broken down. So
    the count sets the size of the bond position directly, and the
    ranking only decides which six of the survivors to own.

    The protection factor is where the fitting shows, and it is left
    exactly as written. With `pf = 2` the denominator becomes half the
    universe, which means the strategy is entirely in Treasuries the
    moment six of the twelve are not trending — a threshold that fires
    far earlier than a naive reading of "half the market is down" would
    suggest, because a twelve-month average is a low bar and an asset
    below it is already in trouble. That the number resolves to exactly
    N/2 with the paper's own default is the kind of coincidence a
    replication records rather than rounds.
    """

    key = "paa"
    title = "Protective Asset Allocation"
    citation = (
        "Keller, W. J., Keuning, J. W., 'Protective Asset Allocation "
        "(PAA): A Simple Momentum-Based Alternative for Term Deposits', "
        "SSRN 2759734, April 2016"
    )
    published_on = date(2016, 4, 30)
    universe = (
        "SPY", "QQQ", "IWM",          # US equity
        "VGK", "EWJ",                  # developed ex-US
        "EEM",                         # emerging
        "IYR", "GSG", "GLD",           # real assets
        "HYG", "LQD", "TLT",           # credit and duration
        "IEF",                         # the crash-protection asset
    )
    rationale = (
        "Breadth, not rank, is the crash signal. A universe in which "
        "most asset classes are above their own long average is a "
        "universe where a momentum book is safe to hold; one in which "
        "half are not is a universe where the correlations are about to "
        "go to one and rank tells you nothing, because the best of "
        "twelve falling things is still falling. So the count of "
        "trending assets sets the bond weight mechanically, and the "
        "ranking is demoted to choosing among the survivors."
    )
    as_published = (
        "DATE. Month precision. The co-author's blog announced PAA in "
        "April 2016 and the SSRN paper (2759734) carries the same month; "
        "no source reachable from here gives the day, so this attribute "
        "is the last day of that month.\n"
        "MOMENTUM WINDOW. The paper writes the momentum as p0 over a "
        "twelve-month simple moving average, and its notation admits "
        "both twelve month-end closes and thirteen (twelve prior plus "
        "the current). This implements THIRTEEN, following the careful "
        "public replications. The difference is small and it is real, "
        "and a run at the other reading is a second trial rather than a "
        "bug fix.\n"
        "PROTECTION ASSET. IEF, the paper's headline configuration. The "
        "co-author's blog describes choosing between SHY and IEF by "
        "relative momentum, and the PAA-CPR variant rotates the "
        "protection asset outright; `protection` is a tuple here so "
        "either can be run without editing the rule, and more than one "
        "entry means best-by-momentum.\n"
        "UNIVERSE. GSG is substituted by DBC — see DEFAULT_SUBSTITUTES. "
        "Both are commodity futures pools, they track different indices "
        "with different energy weights, and in a month when crude and "
        "metals disagree so will they.\n"
        "DENOMINATOR. The bond fraction has the universe size in it. "
        "Where a line is missing from the panel entirely, this "
        "implementation computes the fraction off the number of assets "
        "actually scored, so a short universe changes the crash "
        "threshold as well as the cross-section. `missing` says when "
        "that happened."
    )

    months_needed = 12

    def __init__(
        self,
        *,
        sma_months: int = 12,
        top_n: int = 6,
        protection_factor: float = 2.0,
        protection: Sequence[str] = ("IEF",),
        **kwargs: Any,
    ) -> None:
        self.sma_months = int(sma_months)
        self.top_n = int(top_n)
        self.protection_factor = float(protection_factor)
        self.protection = tuple(str(t) for t in protection)
        guarded = set(self.protection)
        self.risky = tuple(t for t in self.universe if t not in guarded)
        self.months_needed = self.sma_months
        super().__init__(**kwargs)

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        have = set(str(c) for c in closes.columns)
        present = self._columns_for(self.risky, resolved, have)
        prot_cols = self._columns_for(self.protection, resolved, have)
        if not present:
            return self._all_cash(asof, "no risky asset has a column")

        mom = _momentum_over_sma(closes.loc[:, present], self.sma_months)
        scores = self._finite(mom, present)
        n = len(scores)
        if n == 0:
            return self._all_cash(asof, "no risky asset has banked the SMA window")

        # "Good" is strictly positive. A momentum of exactly zero is an
        # asset sitting on its own average, which the paper counts
        # against — and the tie matters more than it looks, because an
        # asset pinned to its average is the one about to decide.
        good = sum(1 for s in scores.values() if s > 0.0)
        bad = n - good

        # BF = (number bad) / (N - pf * N / 4), clipped to [0, 1]. With
        # the paper's pf = 2 the denominator is exactly half the
        # universe, so six bad names out of twelve is a full exit.
        denominator = n - self.protection_factor * n / 4.0
        if denominator <= 0.0:
            bond_fraction = 1.0
        else:
            bond_fraction = min(max(bad / denominator, 0.0), 1.0)

        eligible = {a: s for a, s in scores.items() if s > 0.0}
        selected = self._rank(eligible, self.top_n)

        weights: dict[str, float] = {}
        risky_budget = 1.0 - bond_fraction
        if selected and risky_budget > 0.0:
            # Divided by the number actually selected rather than by
            # TopN. With the paper's own parameters the two are the same
            # number — a positive risky budget implies more than TopN
            # good assets — and they part company only at protection
            # factors the paper does not use, where dividing by TopN
            # would leave a slice of the risky budget in neither the
            # risky book nor the bond.
            share = risky_budget / len(selected)
            for asset in selected:
                weights[asset] = weights.get(asset, 0.0) + share

        protection_used: tuple[str, ...] = ()
        if bond_fraction > 0.0 and prot_cols:
            asset = self._pick_protection(closes, prot_cols)
            if asset:
                weights[asset] = weights.get(asset, 0.0) + bond_fraction
                protection_used = (asset,)

        note = (
            ""
            if prot_cols
            else "protection asset absent; the bond share sits in cash"
        )
        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights=weights,
            breadth=bad,
            cash_fraction=bond_fraction,
            selected=selected,
            protection=protection_used,
            momentum=scores,
            note=note,
        )

    def _pick_protection(self, closes: pd.DataFrame, cols: Sequence[str]) -> str:
        """One protection asset means one; several means best trending.

        The paper's headline configuration names IEF outright, and a
        single-element tuple takes that path without ever scoring it —
        which matters, because scoring would let a Treasury fund with an
        unbanked window disqualify itself and drop the protective share
        into uninvested cash.
        """
        if not cols:
            return ""
        if len(cols) == 1:
            return cols[0]
        mom = _momentum_over_sma(closes.loc[:, list(cols)], self.sma_months)
        return self._best(self._finite(mom, list(cols)))

    def _all_cash(self, asof: pd.Timestamp, note: str) -> TacticalDecision:
        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights={},
            breadth=0,
            cash_fraction=1.0,
            selected=(),
            protection=(),
            momentum={},
            note=note,
        )


# -- 3. Vigilant Asset Allocation ---------------------------------------


class VigilantAssetAllocation(MonthlyTactical):
    """Breadth momentum with a floor: any bad asset moves real money.

    The step from PAA to VAA is the momentum measure and the shape of
    the protective response. The measure becomes 13612W, which once
    decomposed by calendar month puts about forty per cent of an asset's
    score on the last month and about two per cent on each of months
    seven through twelve — a recency tilt sharp enough that the strategy
    will exit an asset still comfortably positive over the year. The
    response becomes a floor function of the breadth count, so
    protection arrives in whole slots of the risky book rather than
    sliding, and the first bad asset out of twelve already moves a fifth
    of the portfolio.

    The parameters are the paper's and they are odd on purpose. B = 4
    and T = 5 do not divide each other; the cash fraction therefore
    goes 0, 0.2, 0.4, 0.6, 1.0 as the bad count climbs, skipping 0.8
    entirely, because `floor(4 * 5 / 4) / 5` is one. That discontinuity
    at the fourth bad asset is the vigilance in the name and it is the
    single most consequential number in the rule.
    """

    key = "vaa"
    title = "Vigilant Asset Allocation (G12)"
    citation = (
        "Keller, W. J., Keuning, J. W., 'Breadth Momentum and Vigilant "
        "Asset Allocation (VAA): Winning More by Losing Less', SSRN "
        "3002624, July 2017"
    )
    published_on = date(2017, 7, 31)
    offensive: tuple[str, ...] = (
        "SPY", "IWM", "QQQ",
        "VGK", "EWJ", "VWO",
        "VNQ", "GSG", "GLD",
        "TLT", "HYG", "LQD",
    )
    defensive: tuple[str, ...] = ("LQD", "IEF", "SHY")
    breadth_threshold: int = 4
    top_n: int = 5

    universe = (
        "SPY", "IWM", "QQQ", "VGK", "EWJ", "VWO",
        "VNQ", "GSG", "GLD", "TLT", "HYG", "LQD",
        "IEF", "SHY",
    )
    rationale = (
        "A crash is preceded by a broadening, not by a single break. "
        "Counting how many of a wide universe carry non-positive "
        "momentum gives a signal that moves before any one asset's own "
        "trend has failed, and weighting that momentum heavily toward "
        "the most recent month makes the count react in weeks rather "
        "than quarters. The protective allocation is then a step "
        "function of the count: enough bad breadth and the whole book "
        "goes to whichever of three defensive bond funds is itself "
        "trending best, which is a second momentum decision rather than "
        "a fixed safe harbour."
    )
    as_published = (
        "DATE. Month precision; a July 26, 2017 date is reported for the "
        "paper by at least one replication service and the co-author's "
        "blog post is July 2017. The attribute is the month end, which "
        "for a month-end-rebalanced rule makes no difference to the "
        "first trade.\n"
        "PARAMETERS. G12: twelve offensive assets, B = 4, T = 5, "
        "defensive universe LQD / IEF / SHY. The cash fraction is the "
        "paper's floor formula and is not smoothed.\n"
        "BAD MOMENTUM is non-positive rather than strictly negative, "
        "following the paper's own phrasing; an asset at exactly zero "
        "votes for protection.\n"
        "UNIVERSE. GSG substituted by DBC — see DEFAULT_SUBSTITUTES. "
        "LQD is deliberately in both the offensive and the defensive "
        "list, as published, so it can carry weight from both legs in "
        "the same month; the two shares are summed rather than one "
        "overwriting the other.\n"
        "SELECTION. The top T offensive assets are taken on rank alone. "
        "The paper does not additionally require them to be positive, "
        "because the cash fraction is what handles a bad tape, and "
        "adding that requirement would be a second protective rule "
        "nobody published."
    )

    months_needed = 12

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        have = set(str(c) for c in closes.columns)
        off = self._columns_for(self.offensive, resolved, have)
        deff = self._columns_for(self.defensive, resolved, have)
        if not off:
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(), momentum={},
                note="no offensive asset has a column",
            )

        scores = self._finite(_momentum_13612w(closes.loc[:, off]), off)
        if not scores:
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(), momentum={},
                note="no offensive asset has banked the 13612W window",
            )

        bad = sum(1 for s in scores.values() if s <= 0.0)
        cash_fraction = self._breadth_cash_fraction(
            bad, breadth=self.breadth_threshold, top=self.top_n
        )
        selected = self._rank(scores, self.top_n)

        weights: dict[str, float] = {}
        risky_budget = 1.0 - cash_fraction
        if selected and risky_budget > 0.0:
            share = risky_budget / float(self.top_n)
            for asset in selected:
                weights[asset] = weights.get(asset, 0.0) + share

        protection_used: tuple[str, ...] = ()
        if cash_fraction > 0.0 and deff:
            dmom = _momentum_13612w(closes.loc[:, deff])
            best = self._best(self._finite(dmom, deff))
            if best:
                weights[best] = weights.get(best, 0.0) + cash_fraction
                protection_used = (best,)

        note = ""
        if cash_fraction > 0.0 and not protection_used:
            note = "no defensive asset scored; the protective share sits in cash"
        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights=weights,
            breadth=bad,
            cash_fraction=cash_fraction,
            selected=selected,
            protection=protection_used,
            momentum=scores,
            note=note,
        )


class VigilantAssetAllocationG4(VigilantAssetAllocation):
    """The four-asset version, and the one the paper leads with.

    B = 1 and T = 1 turn the same machinery into something almost
    brutally simple: if any one of four broad asset classes carries
    non-positive 13612W momentum the entire book goes to a bond fund,
    and otherwise the entire book goes into the single best of the four.
    A hundred per cent of NAV in one ETF is not a rounding of the rule,
    it is the rule, and it is the reason the module docstring insists
    these be run with no caps applied.

    The lineage is worth noting: DAA's canary universe two years later
    is VWO and BND, which are two of these four. The later paper is
    partly an argument that this universe was doing the signalling and
    did not need to be the portfolio as well.
    """

    key = "vaa_g4"
    title = "Vigilant Asset Allocation (G4)"
    offensive = ("VOO", "VEA", "VWO", "BND")
    defensive = ("LQD", "IEF", "SHY")
    breadth_threshold = 1
    top_n = 1
    universe = ("VOO", "VEA", "VWO", "BND", "LQD", "IEF", "SHY")
    as_published = (
        VigilantAssetAllocation.as_published
        + "\nG4 TICKERS. The co-author's blog gives the G4 universe as "
        "VOO / VEA / VWO / BND; at least one replication service uses "
        "SPY / EFA / EEM / AGG for the same four exposures. The wrappers "
        "differ in fee and in index, not in the exposure, and this "
        "implements the author's own list."
    )


# -- 4. Defensive Asset Allocation --------------------------------------


class DefensiveAssetAllocation(MonthlyTactical):
    """Let two assets do the signalling and twelve do the investing.

    The finding that makes DAA a separate paper rather than a VAA
    parameter change: the breadth signal and the investable universe do
    not have to be the same set. VAA counts bad momentum across the
    twelve assets it also holds, which means the count is dominated by
    whatever happens to be in the portfolio and the protective response
    is slow to unwind — the same assets that triggered the exit have to
    recover before the exit ends. DAA moves the count onto a two-asset
    "canary" universe, emerging-market equity and the US aggregate bond
    index, chosen because between them they price global risk appetite
    and the discount rate.

    The consequence the authors emphasise is the cash drag, not the
    crash protection. A two-asset canary is in cash far less often than
    a twelve-asset breadth count, and the paper's argument is that it
    gives up almost nothing in drawdown to buy that back.
    """

    key = "daa"
    title = "Defensive Asset Allocation (G12)"
    citation = (
        "Keller, W. J., Keuning, J. W., 'Breadth Momentum and the Canary "
        "Universe: Defensive Asset Allocation (DAA)', SSRN 3212862, "
        "July 2018"
    )
    published_on = date(2018, 7, 31)
    risky: tuple[str, ...] = (
        "SPY", "IWM", "QQQ",
        "VGK", "EWJ", "VWO",
        "VNQ", "GSG", "GLD",
        "TLT", "HYG", "LQD",
    )
    defensive: tuple[str, ...] = ("SHY", "IEF", "LQD")
    canary: tuple[str, ...] = ("VWO", "BND")
    top_n: int = 6

    universe = (
        "SPY", "IWM", "QQQ", "VGK", "EWJ", "VWO",
        "VNQ", "GSG", "GLD", "TLT", "HYG", "LQD",
        "SHY", "IEF", "BND",
    )
    rationale = (
        "The universe that signals need not be the universe that "
        "invests. Counting bad momentum across the assets you hold ties "
        "the protective response to the portfolio's own composition and "
        "keeps it in cash long after the risk has passed. Two "
        "assets — emerging equity and aggregate bonds — carry most of "
        "the information about global risk appetite between them, so "
        "the count is taken there and the book is still chosen from a "
        "wide cross-section. The claim is not better crash protection "
        "than VAA; it is the same protection at a fraction of the time "
        "spent out of the market."
    )
    as_published = (
        "DATE. Month precision. The co-author's blog announced DAA in "
        "July 2018 and SSRN 3212862 carries the same month; the day is "
        "not reachable from here.\n"
        "PARAMETERS. G12: twelve risky assets, T = 6, canary universe "
        "VWO and BND with B = 2, defensive universe SHY / IEF / LQD. The "
        "canary count therefore produces exactly three states — nothing, "
        "half, everything — and the paper's floor formula and a plain "
        "b/B agree at B = 2, which is why this uses the general form: "
        "it is the one that stays right if the canary is ever widened.\n"
        "VARIANTS. The paper also gives G6, G4, U1 and U3. Their "
        "universes could not be verified from any source reachable here "
        "and are deliberately not manufactured — an invented universe "
        "measured from a real publication date is worse than a missing "
        "row, because it looks like evidence.\n"
        "UNIVERSE. GSG substituted by DBC. LQD sits in both the risky "
        "and the defensive lists as published, and VWO in both the risky "
        "and the canary lists; weight from two legs is summed.\n"
        "AN INCOMPLETE CANARY IS REFUSED. A risky universe short a line "
        "is a smaller cross-section and runs with the shortfall "
        "recorded; a canary short a line is a halved breadth "
        "denominator, which doubles the strategy's sensitivity while "
        "leaving its name intact. The second case holds nothing and says "
        "so rather than producing a number."
    )

    months_needed = 12

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        have = set(str(c) for c in closes.columns)
        risky = self._columns_for(self.risky, resolved, have)
        deff = self._columns_for(self.defensive, resolved, have)
        canary = self._columns_for(self.canary, resolved, have)

        if len(canary) != len(self.canary):
            # The canary must be COMPLETE, and this is stricter than the
            # rule applied to the risky universe on purpose. A risky
            # universe one line short is a smaller cross-section to rank
            # — a real departure, reported in `missing`, but the
            # thresholds are unchanged. The canary's size is the breadth
            # denominator: run it with one asset instead of two and
            # every protective threshold halves, so the strategy becomes
            # roughly twice as jumpy while still calling itself DAA.
            # Inventing a substitute from the risky universe would be
            # worse again — that is VAA with extra steps.
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(), momentum={},
                note=(
                    "the canary universe is incomplete "
                    f"({len(canary)} of {len(self.canary)}); DAA has no signal"
                ),
            )

        canary_scores = self._finite(
            _momentum_13612w(closes.loc[:, canary]), canary
        )
        if len(canary_scores) < len(canary):
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(),
                momentum=canary_scores,
                note="the canary has not banked the 13612W window",
            )

        bad = sum(1 for s in canary_scores.values() if s <= 0.0)
        cash_fraction = self._breadth_cash_fraction(
            bad, breadth=len(canary), top=self.top_n
        )

        weights: dict[str, float] = {}
        selected: tuple[str, ...] = ()
        risky_scores: dict[str, float] = {}
        risky_budget = 1.0 - cash_fraction
        if risky and risky_budget > 0.0:
            risky_scores = self._finite(
                _momentum_13612w(closes.loc[:, risky]), risky
            )
            selected = self._rank(risky_scores, self.top_n)
            if selected:
                share = risky_budget / float(self.top_n)
                for asset in selected:
                    weights[asset] = weights.get(asset, 0.0) + share

        protection_used: tuple[str, ...] = ()
        if cash_fraction > 0.0 and deff:
            dmom = _momentum_13612w(closes.loc[:, deff])
            best = self._best(self._finite(dmom, deff))
            if best:
                weights[best] = weights.get(best, 0.0) + cash_fraction
                protection_used = (best,)

        note = ""
        if cash_fraction > 0.0 and not protection_used:
            note = "no defensive asset scored; the protective share sits in cash"
        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights=weights,
            breadth=bad,
            cash_fraction=cash_fraction,
            selected=selected,
            protection=protection_used,
            momentum={**canary_scores, **risky_scores},
            note=note,
        )


# -- 5. Faber's 2013 aggressive GTAA ------------------------------------


class GlobalTacticalAssetAllocationAggressive(MonthlyTactical):
    """Rank thirteen, hold the best six, and still check the trend.

    This is meaningfully distinct from the 2007 rule and is here for
    that reason. The 2007 paper runs five asset classes, each held or
    not on its own ten-month moving average, at a fixed twenty per cent
    apiece — there is no cross-sectional comparison anywhere in it, and
    an asset's fate depends on nothing but its own history. The 2013
    update adds a ranking: thirteen asset classes are scored on the
    average of their one-, three-, six- and twelve-month total returns
    and only the top six are eligible. Absolute and relative momentum
    are then applied in series, not as alternatives — a top-six asset
    below its own ten-month average is still not held, and its sixth of
    the book goes to cash.

    Faber's own words for the aggressive variant: "It then selects the
    top six out of the thirteen assets as ranked by an average of 1, 3,
    6, and 12-month total returns. The assets are only included if they
    are above their long-term moving average, otherwise that portion of
    the portfolio is moved to cash." The top-three version is the same
    rule with a third of the book per slot.

    Note the equal-weight tilt across horizons, one quarter each. VAA
    four years later reads the same four horizons and weights them
    12/4/2/1. Decomposed by calendar month the two disagree by a factor
    of better than two about what the most recent month is worth —
    eighteen per cent of Faber's score against forty of Keller's — while
    both are described in public as twelve-month momentum. Putting that
    pair side by side, measured the same way from each one's own
    publication date, is the sort of thing this study is for; picking
    the winner and calling it the momentum measure is the sort of thing
    it exists to avoid.
    """

    key = "gtaa_agg6"
    title = "Global Tactical Asset Allocation — Aggressive (top 6 of 13)"
    citation = (
        "Faber, M. T., 'A Quantitative Approach to Tactical Asset "
        "Allocation', The Journal of Wealth Management, Spring 2007; "
        "February 2013 update, SSRN 962461, Extension 3"
    )
    published_on = date(2013, 2, 28)
    universe = (
        "SPY",   # US large cap
        "MDY",   # US mid cap
        "IWM",   # US small cap
        "IWC",   # US micro cap
        "EFA",   # foreign developed
        "EEM",   # foreign emerging
        "IYR",   # US real estate
        "DBC",   # commodities
        "GLD",   # gold
        "IEF",   # US 10-year government
        "TLT",   # US 30-year government
        "LQD",   # US corporate credit
        "BWX",   # foreign developed government bonds
    )
    rationale = (
        "Trend following on a single asset answers whether to own it. "
        "It does not answer what to own instead, and a portfolio that "
        "sits in cash whenever its own five holdings are weak spends a "
        "third of its life in Treasury bills while something is "
        "working. Ranking a wider universe and concentrating in the "
        "leaders recovers that, and keeping the moving-average filter on "
        "top means concentration never forces the book into the best of "
        "a bad set — the slot simply goes to cash."
    )
    as_published = (
        "DATE. Month precision: the 2013 revision of SSRN 962461 is "
        "dated February 2013 on its own cover page, which also records "
        "the 2006 working paper, the Spring 2007 journal publication and "
        "a February 2009 update. A STRICTER reading would push this "
        "earlier: the relative-strength overlay is Faber's 'Relative "
        "Strength Strategies for Investing' (2010) applied to the GTAA "
        "universe, and The Ivy Portfolio (2009) already pairs the "
        "moving-average filter with a momentum ranking. If this entry is "
        "ever reported as a clean post-publication measurement, that "
        "lineage has to be reported with it.\n"
        "UNIVERSE. This is the least certain thing in the file. The "
        "2013 paper states 'thirteen asset class subgroups' and gives "
        "the list in a table that is an image in the PDF; the paper's "
        "surrounding text says explicitly that TIPS, high yield, "
        "emerging-market bonds, foreign REITs, fundamental indices, "
        "managed futures and currencies are NOT among them, and the "
        "backtest runs on indices from 1973 rather than on ETFs at all. "
        "The thirteen tickers here are this project's reading of that "
        "sentence — four US equity slices, two foreign equity, four "
        "bond, real estate, commodities and gold — and a reader who can "
        "see the table should correct them. IWC (US micro cap) and BWX "
        "(foreign government bonds) are not in this project's free ETF "
        "panel, so a run will report them in `missing` and rank eleven.\n"
        "CASH. The paper's cash is Treasury bills; the same paper's "
        "Extension 2 studies replacing them with ten-year notes and "
        "calls that a departure. `cash_ticker` defaults to None, which "
        "leaves the unheld slots as uninvested balance earning nothing "
        "and understates the strategy by roughly the bill rate times "
        "time spent out. Pass a bill fund when the panel carries one.\n"
        "MOVING AVERAGE. Ten months, on month-end closes, including the "
        "current month — Faber's own convention and the one his figures "
        "are computed on.\n"
        "LEVERAGE. The same Extension offers a 2x version. Not "
        "implemented: this account has no margin and a levered "
        "replication would be measuring an account nobody here can open."
    )

    months_needed = 12

    def __init__(
        self,
        *,
        top_n: int = 6,
        sma_months: int = 10,
        lookbacks: Sequence[int] = (1, 3, 6, 12),
        cash_ticker: str | None = None,
        **kwargs: Any,
    ) -> None:
        self.top_n = int(top_n)
        self.sma_months = int(sma_months)
        self.lookbacks = tuple(int(m) for m in lookbacks)
        self.cash_ticker = str(cash_ticker) if cash_ticker else None
        self.months_needed = max(max(self.lookbacks), self.sma_months)
        super().__init__(**kwargs)

    def _decide(
        self,
        asof: pd.Timestamp,
        closes: pd.DataFrame,
        resolved: Mapping[str, str],
        view: Any,
    ) -> TacticalDecision:
        have = set(str(c) for c in closes.columns)
        assets = self._columns_for(self.universe, resolved, have)
        if not assets:
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(), momentum={},
                note="no universe asset has a column",
            )

        sub = closes.loc[:, assets]
        scores = self._finite(_average_lookback_return(sub, self.lookbacks), assets)
        if not scores:
            return TacticalDecision(
                asof=asof, key=self.key, weights={}, breadth=0,
                cash_fraction=1.0, selected=(), protection=(), momentum={},
                note="no asset has banked the ranking windows",
            )

        selected = self._rank(scores, self.top_n)
        trending = _above_moving_average(sub, self.sma_months)

        # The slot is fixed at one over TopN whether or not the asset
        # passes the filter, which is the point of the rule as written:
        # a failed slot becomes cash and is NOT redistributed to the
        # survivors. Redistributing would quietly convert a
        # risk-reduction rule into a concentration rule, and would make
        # the strategy most aggressive exactly when the fewest assets
        # are trending.
        share = 1.0 / float(self.top_n)
        weights: dict[str, float] = {}
        held: list[str] = []
        for asset in selected:
            flag = trending.get(asset, pd.NA)
            if flag is True:
                weights[asset] = weights.get(asset, 0.0) + share
                held.append(asset)

        to_cash = 1.0 - float(sum(weights.values()))
        protection_used: tuple[str, ...] = ()
        # Against the PANEL's columns, not the month-end frame's: the
        # bill fund is not a universe member and never appears in the
        # ranking, so it is not in `have`.
        panel_columns = set(str(c) for c in view.close_adj.columns)
        if self.cash_ticker and self.cash_ticker in panel_columns and to_cash > 0.0:
            weights[self.cash_ticker] = (
                weights.get(self.cash_ticker, 0.0) + to_cash
            )
            protection_used = (self.cash_ticker,)

        return TacticalDecision(
            asof=asof,
            key=self.key,
            weights=weights,
            breadth=len(selected) - len(held),
            cash_fraction=to_cash,
            selected=selected,
            protection=protection_used,
            momentum=scores,
            note=(
                ""
                if self.cash_ticker
                else "cash slots earn nothing; see as_published"
            ),
        )
