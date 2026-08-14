"""The uncertainty gate: what a probability has to clear before any of
the book moves, and the right to hold nothing at all.

This is the one idea in the source project worth copying. A classifier
asked "will this beat the median?" answers every row, and a backtest
built straight off `argmax` therefore trades every day whatever the
model thinks — which is not a strategy, it is a model with a portfolio
bolted on. The gate is the fix: subtract a multiple of the model's own
disagreement from its probability, act only on what survives, and let
the surviving set be EMPTY. A real investor's most common position is
no position, and a forced-to-trade classifier cannot express it.

**The two numbers are priors, written here before any result existed.**
`K_SPREAD = 1.0` and `MIN_ADJUSTED = 0.55`. Neither was chosen by
watching an equity curve and neither may be. If either ever moves in
response to a number, it stops being a prior and becomes a fitted
parameter that owes `metrics.TrialCounter` a row — and the deflated
Sharpe downstream is a function of how many times we looked, so a knob
turned quietly makes every subsequent significance claim too generous.
The arguments for the two values are below and neither mentions a
score.

**What the spread actually measures, and what it does not.** For the
tree it is the standard deviation across bootstrap members; for the net
it is the standard deviation across seeds. Both answer "how much does
the fitted function move when the fit is perturbed", which is model
variance and nothing else. Neither answers "are these features related
to next month's returns at all", which is the far larger uncertainty
and is the question the whole study is asking. So the gate is honest
about ITS OWN instability and completely blind to the possibility that
the model class is wrong. A tight ensemble around a coin flip is a
well-fitted coin flip, and this rule will happily trade one.

**A missing spread fails the gate rather than passing it.** A single
member has no measurable disagreement, and the natural spelling —
treating NaN as zero — turns an unmeasured uncertainty into a maximal
confidence. That is exactly backwards, and it is the failure mode of
every confidence filter that has ever been switched on with one member
by accident.

**Standing aside means holding cash, not holding yesterday.** The
alternative reading — leave the book alone when there is no view — is
tempting and is wrong for three reasons. It makes today's position
depend on how long ago the last view was, so the backtest measures the
gate's history rather than the gate. It quietly turns "no opinion" into
"the opinion I had last month", which is the one thing a model that
declines to answer is not saying. And it hides the number this file
exists to report: how often the rule has nothing to say. Cash is a
position, it earns the bill rate, and the ledger already knows how to
hold it.

**Long only, and the budget is a ceiling rather than a target.**
Weights are non-negative, each capped at `MAX_WEIGHT`, and the book is
equal-weighted across survivors. With a 25% cap that means one survivor
is a 25% position and three quarters cash — the gate expresses
conviction through HOW MUCH is invested, not through a leveraged bet on
a short list. From four survivors on, the budget binds before the cap
does and the book is fully invested at `budget / n` each. There is no
second weighting scheme on purpose:
conviction-proportional sizing is a second dimension to overfit in, and
this file is the last place in the pipeline where a free parameter
could hide from the trial ledger.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping, Sequence

import numpy as np
import pandas as pd

from ..engine.ledger import DEFAULT_BUFFER_FRACTION

__all__ = [
    "DEFAULT_RULE",
    "Decision",
    "DecisionError",
    "DecisionRule",
    "DecisionSet",
    "FULLY_INVESTED",
    "GatedBook",
    "K_SPREAD",
    "MAX_WEIGHT",
    "MIN_ADJUSTED",
    "adjusted_probability",
    "assert_long_only",
    "decide",
    "weights_for",
]


class DecisionError(ValueError):
    """The rule was asked to size something it cannot size honestly."""


# -- the priors ---------------------------------------------------------

#: How many standard deviations of member disagreement are subtracted
#: from a probability before it is judged. One, because the quantity
#: being penalised is a standard deviation and the natural unit of a
#: standard deviation is one of them: at k=1 a probability of 0.60 with
#: members ranging over five points is treated as a 0.55, which is the
#: judgement a person reading both numbers would make. Zero would mean
#: the spread was computed and ignored; three would mean nothing ever
#: clears the minimum, and a gate that never fires cannot be wrong and
#: cannot be useful.
K_SPREAD: float = 1.0

#: The floor the adjusted probability must clear. The label is "beat the
#: cross-sectional median", whose base rate is one half BY CONSTRUCTION
#: on every date, so 0.50 is precisely the no-information point and any
#: minimum at all is a statement about how far past it we insist on
#: being. Five points is a round distance and a demanding one: on a
#: problem where the honest expectation is an AUC near 0.50, most days
#: should produce nothing, and a rule whose do-nothing fraction came
#: back near zero would be a rule that had not gated anything.
MIN_ADJUSTED: float = 0.55

#: The most of NAV one name may carry. A quarter, so the smallest
#: possible acting book — one surviving signal — is a real position
#: rather than a rounding error, and the largest possible concentration
#: is four names. Not a risk model: `portfolio/sizing.py` owns that
#: argument for the sleeve strategy, and importing it here would tangle
#: a classifier's decision rule with a volatility-targeting layer that
#: has nothing to do with it.
MAX_WEIGHT: float = 0.25

#: The most of NAV that can be invested at once. Exactly the ledger's
#: investable fraction, because the engine holds `DEFAULT_BUFFER_FRACTION`
#: of NAV back from every purchase — so a rule targeting a full 1.0 would
#: spend the whole sample deferring its last five per cent and fill the
#: log with events that say nothing except that the target was
#: impossible. This is the no-leverage constraint made arithmetic:
#: nothing in this file can produce weights summing past it.
FULLY_INVESTED: float = 1.0 - DEFAULT_BUFFER_FRACTION

#: Tolerance on the gross-exposure assertion. Floating point only —
#: weights are built as `min(cap, budget/n)` so the sum is at or under
#: the budget by construction, and anything above this is arithmetic
#: that went somewhere else.
_GROSS_TOLERANCE: float = 1e-9


@dataclass(frozen=True)
class DecisionRule:
    """The gate, as four numbers and the reason each one is what it is.

    Frozen, and `config()` is what goes to the trial ledger. Two runs
    that differ in `k` or in `minimum` are two configurations rather
    than one run and a correction, and the hash has to see that without
    anybody writing a sentence about it.
    """

    k: float = K_SPREAD
    minimum: float = MIN_ADJUSTED
    max_weight: float = MAX_WEIGHT
    budget: float = FULLY_INVESTED

    def __post_init__(self) -> None:
        if float(self.k) < 0.0:
            raise DecisionError(
                f"k {self.k!r} is negative, which would REWARD a model for "
                "disagreeing with itself"
            )
        if not 0.0 < float(self.minimum) < 1.0:
            raise DecisionError(
                f"minimum {self.minimum!r} is not a probability. A gate at 0 "
                "acts on everything and a gate at 1 acts on nothing"
            )
        if not 0.0 < float(self.max_weight) <= 1.0:
            raise DecisionError(f"max_weight {self.max_weight!r} is not in (0, 1]")
        if not 0.0 < float(self.budget) <= 1.0:
            raise DecisionError(
                f"budget {self.budget!r} is not in (0, 1]. Above one is "
                "leverage, which this project does not do"
            )

    def config(self) -> dict[str, Any]:
        return {
            "rule": "uncertainty_gate",
            "k_spread": float(self.k),
            "minimum_adjusted_probability": float(self.minimum),
            "max_weight": float(self.max_weight),
            "budget": float(self.budget),
            "sizing": "equal_weight_across_survivors",
            "when_nothing_survives": "cash",
        }


DEFAULT_RULE = DecisionRule()


# -- the arithmetic -----------------------------------------------------


def adjusted_probability(
    probability: np.ndarray | pd.Series,
    spread: np.ndarray | pd.Series,
    *,
    k: float = K_SPREAD,
) -> np.ndarray:
    """`p - k * sd`, with an unmeasured spread refusing to score.

    NaN in, NaN out — and NaN never clears the minimum, so a row whose
    uncertainty could not be measured stands aside. That is the whole
    of the asymmetry: treating a missing standard deviation as zero
    would read an ensemble of one as total confidence, which is the
    most confident thing this rule could possibly be told and the least
    evidence it could possibly have.
    """
    p = np.asarray(pd.Series(probability).to_numpy(), dtype="float64").ravel()
    s = np.asarray(pd.Series(spread).to_numpy(), dtype="float64").ravel()
    if p.shape != s.shape:
        raise DecisionError(
            f"{p.size:,} probabilities against {s.size:,} spreads; these are "
            "not the same rows"
        )
    # Masked rather than `nanmin`, which warns on an all-NaN column and
    # would make an ensemble of one — the exact case this function is
    # careful about — noisy instead of quiet.
    scored = p[np.isfinite(p)]
    if scored.size and (scored.min() < 0.0 or scored.max() > 1.0):
        raise DecisionError(
            "a probability outside [0, 1] reached the gate; the model handed "
            "back a score rather than a probability"
        )
    measured = s[np.isfinite(s)]
    if measured.size and measured.min() < 0.0:
        raise DecisionError("a negative standard deviation reached the gate")
    return p - float(k) * s


def weights_for(
    adjusted: np.ndarray,
    assets: Sequence[str],
    *,
    rule: DecisionRule = DEFAULT_RULE,
) -> dict[str, float]:
    """One date's book: equal weight across whatever cleared the gate.

    `min(max_weight, budget / n)` per survivor, which is the whole
    sizing rule. At one survivor the book is 25% invested and the other
    three quarters is cash; at four it is fully invested; past four the
    cap stops binding and the budget does. Nothing here can return a
    negative weight, a weight above the cap, or a set of weights summing
    past the budget — `assert_long_only` re-derives all three rather
    than trusting the arithmetic above it.
    """
    values = np.asarray(adjusted, dtype="float64").ravel()
    names = [str(a) for a in assets]
    if values.size != len(names):
        raise DecisionError(
            f"{values.size:,} adjusted probabilities against {len(names):,} "
            "assets"
        )
    # NaN fails the comparison, which is the intended behaviour and is
    # worth stating: an unmeasured row stands aside rather than being
    # imputed to the middle of the pack.
    surviving = [
        n
        for n, v in zip(names, values)
        if np.isfinite(v) and v >= rule.minimum
    ]
    if not surviving:
        return {}
    weight = min(float(rule.max_weight), float(rule.budget) / len(surviving))
    return {name: weight for name in surviving}


def assert_long_only(
    weights: Mapping[str, float], *, rule: DecisionRule = DEFAULT_RULE
) -> None:
    """No short, no leverage, no cap breach, no NaN. Cheap and re-derived.

    Called from the runner as well as from the tests, because a
    constraint that is obeyed by construction is not a constraint that
    has been checked — and the three failures here are the three the
    brief calls binding.
    """
    total = 0.0
    for asset, value in weights.items():
        w = float(value)
        if not np.isfinite(w):
            raise DecisionError(f"{asset}: weight is not a number")
        if w < 0.0:
            raise DecisionError(
                f"{asset}: weight {w:.6f} is negative. This book is long only; "
                "there is no short leg and no inverse product"
            )
        if w > float(rule.max_weight) + _GROSS_TOLERANCE:
            raise DecisionError(
                f"{asset}: weight {w:.4f} is over the {rule.max_weight:.2f} cap"
            )
        total += w
    if total > float(rule.budget) + _GROSS_TOLERANCE:
        raise DecisionError(
            f"gross exposure {total:.6f} is over the {rule.budget:.4f} budget. "
            "That is leverage, which this project does not do at any size"
        )


# -- a date's answer ----------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """What the rule did on one date, including doing nothing.

    `acted` and `n_candidates` are kept apart on purpose. Zero survivors
    out of twenty-eight is the rule working; zero survivors out of zero
    is a date the model was never asked about, and the two produce the
    same empty book and mean entirely different things.
    """

    date: pd.Timestamp
    weights: Mapping[str, float]
    n_candidates: int
    n_surviving: int
    best_adjusted: float
    invested: float

    @property
    def acted(self) -> bool:
        return self.n_surviving > 0


@dataclass(frozen=True, eq=False)
class DecisionSet:
    """Every date's book, and the fraction on which there was no book.

    `eq=False` because the fields are pandas objects and a generated
    `__eq__` would compare them element-wise and then ask for the truth
    value of the result, which raises rather than answering.
    """

    rule: DecisionRule
    weights: pd.DataFrame = field(repr=False)
    log: pd.DataFrame = field(repr=False)

    def __len__(self) -> int:
        return int(len(self.log))

    def __iter__(self) -> Iterator[pd.Timestamp]:
        return iter(pd.DatetimeIndex(self.weights.index))

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.weights.index)

    @property
    def n_acting(self) -> int:
        return int(self.log["acted"].sum())

    @property
    def did_nothing_fraction(self) -> float:
        """The number this whole design exists to produce.

        The share of decision dates on which nothing cleared the gate.
        Near zero means the gate is not gating; near one means it is a
        very expensive way to hold cash. Both are findings, and neither
        is a reason to move `MIN_ADJUSTED`.
        """
        n = len(self.log)
        return float(1.0 - self.n_acting / n) if n else float("nan")

    @property
    def mean_invested(self) -> float:
        return float(self.log["invested"].mean()) if len(self.log) else float("nan")

    @property
    def desired_turnover(self) -> pd.Series:
        """`sum |dw|` between consecutive decision dates, before any engine.

        The rule's own instability, measured where no constraint can
        flatter it. The backtest downstream is capped at 5% of NAV a day
        and will therefore report something much smaller, so the two
        numbers answer different questions: this one is what the rule
        ASKED for, and a rule asking to replace its whole book daily is
        not implementable at any cost model. Reported rather than
        smoothed away — a damping term here would be a free parameter,
        and the honest version of "this churns" is a number.
        """
        moves = self.weights.diff().abs().sum(axis=1)
        # The first date has no predecessor; the book starts empty, so
        # the move into it is the weight itself rather than NaN.
        if len(self.weights):
            moves.iloc[0] = float(self.weights.iloc[0].abs().sum())
        return moves

    def summary(self) -> str:
        if not len(self.log):
            return "no dates were decided"
        held = self.log.loc[self.log["acted"], "n_surviving"]
        return (
            f"{self.n_acting:,} of {len(self.log):,} dates carried a position "
            f"({self.did_nothing_fraction:.1%} stood aside). On an acting date "
            f"the book held {held.mean():.1f} names on average and "
            f"{self.mean_invested:.1%} of NAV was invested across all dates, "
            f"against a {self.rule.budget:.0%} ceiling."
        )


def decide(
    predictions: pd.DataFrame,
    *,
    rule: DecisionRule = DEFAULT_RULE,
    date_column: str = "date",
    asset_column: str = "asset",
    probability_column: str = "probability",
    spread_column: str = "spread",
) -> DecisionSet:
    """Turn out-of-sample predictions into a long-only book per date.

    `predictions` is long: one row per `(date, asset)` that the model
    scored, carrying its probability and the spread across members. The
    frame is the model's OUT-OF-SAMPLE output and nothing else — feeding
    in-sample predictions here would produce a beautiful equity curve
    and would be measuring the fit.

    Dates are taken from the frame rather than from a calendar, which
    matters: a date the model never scored does not appear, and the
    engine's strategy adapter reads that absence as "no view" rather
    than as "a view of zero". The two are the same book and different
    facts, and only one of them belongs in the do-nothing fraction.
    """
    frame = _validated(
        predictions,
        date_column=date_column,
        asset_column=asset_column,
        probability_column=probability_column,
        spread_column=spread_column,
    )
    adjusted = adjusted_probability(
        frame[probability_column], frame[spread_column], k=rule.k
    )
    frame = frame.assign(adjusted=adjusted)

    assets = sorted({str(a) for a in frame[asset_column]})
    rows: list[Decision] = []
    books: dict[pd.Timestamp, dict[str, float]] = {}

    for when, block in frame.groupby(date_column, sort=True):
        weights = weights_for(
            block["adjusted"].to_numpy(dtype="float64"),
            block[asset_column].astype("str").tolist(),
            rule=rule,
        )
        assert_long_only(weights, rule=rule)
        books[pd.Timestamp(when)] = weights
        best = block["adjusted"].max()
        rows.append(
            Decision(
                date=pd.Timestamp(when),
                weights=weights,
                n_candidates=int(len(block)),
                n_surviving=int(len(weights)),
                best_adjusted=float(best) if np.isfinite(best) else float("nan"),
                invested=float(sum(weights.values())),
            )
        )

    if not rows:
        raise DecisionError(
            "no date carried a prediction. An empty decision set and a set "
            "where the model declined to act every day are the same book and "
            "different facts, so this is a raise rather than an empty frame"
        )

    index = pd.DatetimeIndex([r.date for r in rows], name="date")
    wide = pd.DataFrame(0.0, index=index, columns=pd.Index(assets, name="asset"))
    for when, weights in books.items():
        for asset, value in weights.items():
            wide.loc[when, asset] = value

    log = pd.DataFrame(
        {
            "date": index,
            "n_candidates": [r.n_candidates for r in rows],
            "n_surviving": [r.n_surviving for r in rows],
            "acted": [r.acted for r in rows],
            "best_adjusted": [r.best_adjusted for r in rows],
            "invested": [r.invested for r in rows],
        }
    ).reset_index(drop=True)
    return DecisionSet(rule=rule, weights=wide, log=log)


# -- the engine adapter -------------------------------------------------


class GatedBook:
    """The decided weights, handed to the backtest one session at a time.

    A lookup and deliberately nothing more. Everything the model knows
    was computed before this object existed, out of sample, fold by
    fold; the strategy's whole job is to state the book for `view.asof`
    and let the engine fill it at the next open. Recomputing anything
    here would put a model fit inside the trading loop, where no leak
    check can see it.

    Two absences that must not be confused, and are not:

    A date the decision set never scored — everything before the first
    walk-forward test fold — is a target of ZERO in every name, because
    the model had no view and a book with no view is cash. A date the
    model scored and declined to act on is also zero. The engine cannot
    tell them apart and does not need to; `DecisionSet.log` can, and it
    is what the do-nothing fraction is computed from.

    The lookup is by exact session and never by `asof()`-style
    backfill. A backfill would carry a stale book forward across a gap
    and would silently make the strategy path-dependent on how long the
    gap was.
    """

    def __init__(
        self,
        weights: pd.DataFrame,
        *,
        name: str = "uncertainty-gated classifier",
        warmup: int = 0,
    ) -> None:
        if not isinstance(weights, pd.DataFrame):
            raise DecisionError(
                f"expected the decided weight frame, got {type(weights).__name__}"
            )
        index = pd.DatetimeIndex(weights.index).normalize()
        if not index.is_monotonic_increasing or index.has_duplicates:
            raise DecisionError(
                "the weight frame must be indexed by strictly increasing "
                "sessions; a duplicated date would make the book depend on "
                "which row pandas reached first"
            )
        frame = weights.astype("float64")
        frame.index = index
        values = frame.to_numpy(dtype="float64")
        if not np.isfinite(values).all():
            raise DecisionError("a decided weight is not a number")
        if (values < 0.0).any():
            raise DecisionError("a decided weight is negative; this book is long only")
        self._weights = frame
        # Position rather than label lookup: `.loc` on a DatetimeIndex
        # will happily answer a partial-string match, and a strategy
        # that resolves "2019" to a whole year of rows fails in a way
        # that looks like a data problem.
        self._rows = {stamp: i for i, stamp in enumerate(index)}
        self.name = name
        self.warmup = int(warmup)
        #: Sessions the engine asked about that the decision set never
        #: scored. Counted rather than shrugged at: a large number here
        #: means the backtest window and the out-of-sample window
        #: disagree, and the run is measuring a stretch the model was
        #: never asked about.
        self.unscored_sessions: int = 0

    def targets(self, view: Any) -> Mapping[str, float]:
        asof = pd.Timestamp(view.asof).normalize()
        assets = tuple(str(a) for a in view.assets)
        row = self._rows.get(asof)
        if row is None:
            self.unscored_sessions += 1
            return {a: 0.0 for a in assets}
        held = self._weights.iloc[row]
        # Every asset in the panel is stated, including the zeroes. An
        # asset left out of the mapping is a target of zero either way,
        # and a strategy that omits names is one edit away from omitting
        # one by accident and holding it forever.
        return {a: float(held.get(a, 0.0)) for a in assets}


# -- plumbing -----------------------------------------------------------


def _validated(
    predictions: pd.DataFrame,
    *,
    date_column: str,
    asset_column: str,
    probability_column: str,
    spread_column: str,
) -> pd.DataFrame:
    if not isinstance(predictions, pd.DataFrame):
        raise DecisionError(
            f"predictions must be a long DataFrame, got "
            f"{type(predictions).__name__}"
        )
    need = [date_column, asset_column, probability_column, spread_column]
    missing = [c for c in need if c not in predictions.columns]
    if missing:
        raise DecisionError(
            f"prediction frame is missing {missing}; got "
            f"{sorted(predictions.columns)}"
        )
    out = predictions.loc[:, need].copy()
    out[date_column] = pd.to_datetime(out[date_column]).dt.normalize()
    out[asset_column] = out[asset_column].astype("str")
    if out.duplicated(subset=[date_column, asset_column]).any():
        n = int(out.duplicated(subset=[date_column, asset_column]).sum())
        raise DecisionError(
            f"{n:,} duplicate (date, asset) prediction(s). Under walk-forward "
            "the test folds tile the sample and cannot overlap, so a duplicate "
            "here means two folds scored one row and the book would be sized "
            "off whichever arrived last"
        )
    for column in (probability_column, spread_column):
        out[column] = out[column].astype("float64")
    return out.sort_values([date_column, asset_column]).reset_index(drop=True)
