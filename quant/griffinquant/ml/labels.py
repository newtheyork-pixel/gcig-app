"""The question the classifier is asked, and the base rate that decides
whether its answer means anything.

The video this reproduces predicts whether a forward return clears a
threshold and reports accuracy. It scored around 62% and treated that
as a result. Over a six-month horizon "did it go up" is true about 60%
of the time, so a model that answered YES to everything would have
scored about 60 — the whole reported edge is two points, which is
inside the noise on the sample it was measured over. Nothing in that
project was wrong about arithmetic. What was missing was one number
printed beside the accuracy.

So the base rate is not a diagnostic here, it is an output. Every
`LabelSet` carries it, `describe()` prints it in the same row as the
observation count, `base_rate_by_year` shows it moving, and
`accuracy_report` cannot be made to hand back an accuracy without one.
A reporting surface that can print 62% and cannot print the 60% next
to it is the failure this module exists to make impossible.

**THE HORIZON: 21 sessions, one month.** The prior, fixed before
anything was run. The video went out to six months, and the cost of
that is not the row count — 21 years of daily bars gives about 5,300
rows per asset at any horizon — it is the number of INDEPENDENT
observations, which is roughly the row count divided by the horizon
because consecutive windows overlap by H-1 sessions. At 126 sessions
21 years yields about 42 non-overlapping windows per asset. Forty-two.
That is not a sample a model with hundreds of parameters can be fitted
against, and it is the arithmetic behind a validation curve that
drifts to 0.50 while the training curve climbs. At 21 sessions the
same history yields about 250 per asset, which is still small and is
at least countable. `effective_sample()` computes and prints this for
whatever horizon is chosen, so the number is never left implicit.

**THE THRESHOLD: the cross-sectional median.** Three are implemented
and the default is `cross_sectional_median` — the label is whether an
asset's forward return beat the median of the assets trading beside it
on the same date. It has one property the other two cannot have: a
base rate of exactly one half, held there BY CONSTRUCTION on every
date in the sample, so an accuracy figure is readable on sight and a
model cannot score by learning which era it is looking at.

`zero` is the video's and is kept, not for use but for demonstration —
run it once and read `base_rate_by_year()`, where the label is true 20%
of the time in 2008 and 90% in 2013. A model given a feature that
identifies the year would score well above the pooled base rate while
knowing nothing whatever about an asset.

`bill` — the return above what a Treasury bill paid over the same
window — is the honest ABSOLUTE label and is the right one for the
question "should we be invested at all". Its base rate is better
behaved than `zero` and still drifts with the equity risk premium.

The cost of the cross-sectional label has to be stated because it is
easy to forget and expensive to forget: **beating the median is not
making money.** In March 2020 four of nine sleeves beat the median and
all nine lost. A long-only book that may hold cash needs the level as
well as the ranking, so a model trained on this label answers "which
of these, if any of them" and never "how much of the book should be
invested". Reporting one as the other is the same category error
`walkforward.py` refuses in its own domain.

Labels look FORWARD, which is what makes them labels; the discipline
is that they look forward exactly H sessions and that a window running
past the end of the data is DROPPED rather than shortened. A clamped
window is a label computed over a shorter horizon than the one in its
column heading, sitting in the same training set as the real ones. The
last H sessions therefore carry no labels at all, which is also why
`splits.py` can take the horizon as its purge distance and know the
distance is honest.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

import numpy as np
import pandas as pd

__all__ = [
    "DEFAULT_HORIZON",
    "DEFAULT_THRESHOLD",
    "EffectiveSample",
    "LabelError",
    "LabelSet",
    "MIN_CROSS_SECTION",
    "SANCTIONED_HORIZONS",
    "Threshold",
    "accuracy_report",
    "build_labels",
    "forward_total_return",
]


#: What the label is measured against. `cross_sectional_median` is the
#: default and the argument for it is in the module docstring; the other
#: two are here so the comparison can be made rather than asserted.
Threshold = Literal["cross_sectional_median", "bill", "zero"]

DEFAULT_THRESHOLD: Threshold = "cross_sectional_median"

#: One month of sessions. See the module docstring for the prior; the
#: short version is that the horizon divides the sample into
#: non-overlapping windows and 126 divides 21 years into forty-two.
DEFAULT_HORIZON = 21

#: Horizons that have been argued for, in sessions: a week, a month, a
#: quarter, and the video's half-year. Nothing enforces this tuple —
#: it is a record of which numbers were chosen deliberately, so that a
#: 37 appearing in a config is visibly somebody's search rather than
#: somebody's prior.
SANCTIONED_HORIZONS: tuple[int, ...] = (5, 21, 63, 126)

#: Below three assets a median is not a cross-section, it is a coin
#: flip between two names. Dates thinner than this are dropped and
#: counted rather than labelled against a degenerate benchmark.
MIN_CROSS_SECTION = 3

#: A horizon that leaves fewer non-overlapping windows than this is
#: refused outright. Twenty is already indefensibly small for fitting
#: anything; the refusal exists because the failure at that end is
#: silent — a five-year horizon on a twenty-year sample produces a
#: perfectly well-formed frame of five thousand rows carrying four
#: independent observations.
MIN_INDEPENDENT_WINDOWS = 20

#: Dates needed before the cross-sectional correlation behind
#: `effective_sample` is worth quoting. Below it the participation
#: ratio is reported as unmeasured rather than as a number.
MIN_CORRELATION_DATES = 60


class LabelError(ValueError):
    """The panel, the horizon or the benchmark cannot make a label."""


# -- the forward return --------------------------------------------------


def forward_total_return(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """The H-session forward total return of every asset, wide.

    `prices` must be the DIVIDEND-ADJUSTED close and nothing else. For
    the duration and credit sleeves nearly all of the return is coupon
    — TLT returned -2.6% on price and +105.8% on total return over
    2004-2026 — so a price series here does not approximate the label,
    it inverts it for a third of the universe.

    NaN wherever the window does not close inside the data: the last H
    sessions of the panel, and the trailing H sessions of any asset
    whose price series ends early. That second case is where
    survivorship bias would enter a single-name panel, and the reason
    it cannot enter this one is that no ETF in the universe stopped
    trading — not that the drop is harmless.
    """
    panel = _as_panel(prices)
    h = _as_horizon(horizon, len(panel.index))
    return panel.shift(-h) / panel - 1.0


# -- what a run gets back ------------------------------------------------


@dataclass(frozen=True)
class EffectiveSample:
    """How many observations there really are, as opposed to rows.

    Two reductions, applied in that order. Overlapping windows collapse
    the time dimension to `dates / horizon`; shared factor exposure
    collapses the cross-section from `assets` to `effective_assets`,
    measured as the participation ratio of the correlation matrix of
    the very series the label was built from. Nine ETFs that all fall
    together in 2008 are not nine independent draws and the number says
    how many they amount to.

    `effective_n` is an UPPER bound and should be read as one. It
    assumes non-overlapping windows are independent of each other,
    which they are not — regimes run longer than a month — and it takes
    no account of the model having seen every intermediate window too.
    """

    rows: int
    dates: int
    assets: int
    horizon: int
    independent_windows: int
    effective_assets: float
    effective_n: float
    note: str


@dataclass(frozen=True, eq=False)
class LabelSet:
    """The labels, what they were measured against, and the base rate.

    `eq=False` because the fields are pandas objects and a generated
    `__eq__` would compare them element-wise and then ask for the truth
    value of the result, which raises rather than answering.

    `y` is indexed by `(date, asset)` and is deliberately LONG rather
    than a wide frame of 0/1/NaN. A wide frame invites `.values` into a
    model, and the rows that are NaN there are not missing data — they
    are dates on which the asset had no complete window, which is a
    different thing that must not be imputed.
    """

    y: pd.Series
    forward_return: pd.Series
    benchmark: pd.Series
    calendar: pd.DatetimeIndex
    horizon: int
    threshold: Threshold
    #: Every cell that had a price and did not become a label, by
    #: reason. The counts are exact and reconcile against the panel —
    #: a drop nobody counts is a drop nobody finds.
    dropped: Mapping[str, int]
    #: How many independent series the cross-section amounts to, from
    #: the correlation of the very quantity the label thresholds. Fixed
    #: at construction rather than derived on demand, because by the
    #: time the ties are dropped no date carries the whole cross-section
    #: any more and the measurement would silently come back
    #: unavailable. NaN means it could not be measured, which is a
    #: different statement from a low number.
    correlation_dof: float = float("nan")

    dates: pd.DatetimeIndex = field(init=False, repr=False)
    assets: tuple[str, ...] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.y.index, pd.MultiIndex):
            raise LabelError("y must be indexed by (date, asset)")
        if not isinstance(self.calendar, pd.DatetimeIndex):
            raise LabelError(
                "calendar must be the price panel's own DatetimeIndex; it is "
                "what every label window is measured in"
            )
        dates = pd.DatetimeIndex(
            self.y.index.get_level_values("date").unique()
        ).sort_values()
        object.__setattr__(self, "dates", dates)
        object.__setattr__(
            self,
            "assets",
            tuple(sorted({str(a) for a in self.y.index.get_level_values("asset")})),
        )

        pos = self.calendar.get_indexer(dates)
        if (pos < 0).any():
            raise LabelError(
                "some labelled date is not on the price calendar the labels "
                "were built from; the label window cannot be located"
            )
        if (pos + self.horizon >= len(self.calendar)).any():
            # The clamp purged_cv would otherwise apply on our behalf.
            # It errs safe there and would be a lie here: a label whose
            # window ran past the data was never built.
            raise LabelError(
                f"a label is dated within {self.horizon} sessions of the end "
                "of the calendar, so its window never closed. Incomplete "
                "windows are dropped, never shortened."
            )

    # -- the number that goes beside every accuracy ---------------------

    @property
    def n(self) -> int:
        return int(len(self.y))

    @property
    def base_rate(self) -> float:
        """The share of labels that are 1. Read this first, always."""
        return float(self.y.mean()) if len(self.y) else float("nan")

    @property
    def majority_accuracy(self) -> float:
        """What answering the same way every time would have scored.

        The honest floor under any reported accuracy, and it is not the
        base rate — it is `max(p, 1-p)`, because the constant model
        picks whichever class is bigger.
        """
        p = self.base_rate
        return float(max(p, 1.0 - p)) if np.isfinite(p) else float("nan")

    @property
    def excess(self) -> pd.Series:
        """Forward return less whatever it was judged against."""
        out = self.forward_return - self.benchmark
        out.name = "excess"
        return out

    # -- the window, for the splitter -----------------------------------

    @property
    def label_end(self) -> pd.Series:
        """The session each date's label stops being unknown on.

        Handed to `purged_cv` as `label_end` rather than letting it
        derive a bar count of its own. The two agree on a gapless index
        and disagree the moment a date is dropped for a thin
        cross-section: the splitter would count H POSITIONS IN THE
        SPLIT INDEX, which by then is missing sessions, and would purge
        a window shorter than the label's. Real timestamps off the
        price calendar cannot drift that way.
        """
        pos = self.calendar.get_indexer(self.dates)
        ends = self.calendar[pos + self.horizon]
        return pd.Series(ends.to_numpy(), index=self.dates, name="label_end")

    # -- reporting ------------------------------------------------------

    def effective_sample(self) -> EffectiveSample:
        """Rows, and then how many observations those rows amount to."""
        assets = len(self.assets)
        windows = int(len(self.dates) // self.horizon)

        # The label is a comparison against the cross-section, so one
        # asset's label is determined by the other eight: the ninth
        # degree of freedom does not exist.
        cap = (
            float(assets - 1)
            if self.threshold == "cross_sectional_median"
            else float(assets)
        )
        ratio = float(self.correlation_dof)
        measured = np.isfinite(ratio)
        effective_assets = float(min(ratio, cap)) if measured else cap
        effective_n = float(windows * effective_assets)

        if measured:
            breadth = (
                f"{assets} assets amount to {effective_assets:.1f} distinct "
                "series once their shared movement is taken out"
            )
        else:
            breadth = (
                f"{assets} assets, taken at the structural cap of {cap:.0f} "
                "because too few dates carried the whole cross-section for "
                "their correlation to be measured"
            )
        return EffectiveSample(
            rows=self.n,
            dates=int(len(self.dates)),
            assets=assets,
            horizon=self.horizon,
            independent_windows=windows,
            effective_assets=effective_assets,
            effective_n=effective_n,
            note=(
                f"{self.n:,} rows are not {self.n:,} observations. A "
                f"{self.horizon}-session window at daily frequency overlaps "
                f"the next by {self.horizon - 1}, so {len(self.dates):,} dates "
                f"carry {windows:,} non-overlapping windows; {breadth}. "
                f"Call it {effective_n:,.0f} independent observations, and "
                "treat that as an upper bound — it assumes one month's "
                "window tells you nothing about the next, and regimes run "
                "longer than a month."
            ),
        )

    def describe(self) -> pd.DataFrame:
        """One typed row, so labellings stack and compare.

        `base_rate` sits beside `n` on purpose and neither is optional.
        """
        eff = self.effective_sample()
        row = {
            "threshold": self.threshold,
            "horizon_sessions": self.horizon,
            "first_date": self.dates[0] if len(self.dates) else pd.NaT,
            "last_date": self.dates[-1] if len(self.dates) else pd.NaT,
            "n_dates": int(len(self.dates)),
            "n_assets": len(self.assets),
            "n": self.n,
            "positives": int(self.y.sum()),
            "base_rate": self.base_rate,
            "majority_accuracy": self.majority_accuracy,
            "independent_windows": eff.independent_windows,
            "effective_assets": eff.effective_assets,
            "effective_n": eff.effective_n,
            "dropped_incomplete_window": int(self.dropped.get("incomplete_window", 0)),
            "dropped_thin_cross_section": int(
                self.dropped.get("thin_cross_section", 0)
            ),
            "dropped_no_benchmark": int(self.dropped.get("no_benchmark", 0)),
            "dropped_tie_at_threshold": int(self.dropped.get("tie_at_threshold", 0)),
            "sample_note": eff.note,
        }
        return pd.DataFrame([row])

    def base_rate_by_year(self) -> pd.DataFrame:
        """The base rate, year by year. The `zero` label's indictment.

        A pooled base rate hides the thing that actually breaks a
        classifier: a label whose prior moves. Run this on
        `threshold="zero"` and the column swings from about 0.2 in 2008
        to about 0.9 in 2013, which is a target any feature carrying a
        hint of the calendar can fit without knowing anything about an
        asset. Run it on the cross-sectional label and every row reads
        0.5.
        """
        years = pd.Index(self.y.index.get_level_values("date").year, name="year")
        grouped = self.y.groupby(years)
        out = pd.DataFrame(
            {
                "n": grouped.size().astype("int64"),
                "positives": grouped.sum().astype("int64"),
                "base_rate": grouped.mean().astype("float64"),
            }
        )
        return out.reset_index()

    def base_rate_by_asset(self) -> pd.DataFrame:
        """The base rate per asset, which is a different warning.

        An asset that beats the median 70% of the time hands the model
        an intercept: predicting it always and everything else never
        scores above one half without any skill at all. Worth reading
        before a per-asset feature is added.
        """
        assets = pd.Index(
            self.y.index.get_level_values("asset").astype("str"), name="asset"
        )
        grouped = self.y.groupby(assets)
        out = pd.DataFrame(
            {
                "n": grouped.size().astype("int64"),
                "positives": grouped.sum().astype("int64"),
                "base_rate": grouped.mean().astype("float64"),
            }
        )
        return out.reset_index().sort_values("asset").reset_index(drop=True)

    def config(self) -> dict[str, Any]:
        """The part of a trial's identity that belongs to the label.

        Changing the horizon or the threshold and rerunning is a second
        configuration, not a correction of the first, and the trial
        ledger has to be able to see that from the hash alone.
        """
        return {
            "threshold": self.threshold,
            "horizon_sessions": self.horizon,
            "first_date": self.dates[0].date().isoformat() if len(self.dates) else None,
            "last_date": self.dates[-1].date().isoformat() if len(self.dates) else None,
            "assets": list(self.assets),
            "n": self.n,
            "base_rate": round(self.base_rate, 6),
        }

    def __repr__(self) -> str:
        return (
            f"LabelSet({self.threshold}, {self.horizon}d, n={self.n:,}, "
            f"base_rate={self.base_rate:.3f}, "
            f"{len(self.assets)} assets, {len(self.dates):,} dates)"
        )


# -- construction --------------------------------------------------------


def build_labels(
    prices: pd.DataFrame,
    *,
    horizon: int = DEFAULT_HORIZON,
    threshold: Threshold = DEFAULT_THRESHOLD,
    bill_index: pd.Series | None = None,
) -> LabelSet:
    """Turn a panel of adjusted closes into a binary target.

    `prices` is wide: a DatetimeIndex of sessions, one column per
    asset, dividend-adjusted closes. Assets may start late — the panel
    is allowed leading and trailing gaps per column and no interior
    ones, since a hole in the middle of a price series would let a
    window straddle it and produce a return over a period nobody held.

    The order of operations is the whole of the correctness here:
    forward returns first, incomplete windows dropped, the benchmark
    computed FROM WHAT SURVIVED, and only then the comparison. Taking a
    cross-sectional median before the incomplete windows are dropped
    would benchmark the surviving assets against a median that included
    assets not in the sample, which is a small number and a wrong one.
    """
    panel = _as_panel(prices)
    h = _as_horizon(horizon, len(panel.index))
    mode = _as_threshold(threshold)

    priced = int(panel.notna().to_numpy().sum())
    fwd = (panel.shift(-h) / panel - 1.0).stack()
    fwd.index = fwd.index.set_names(["date", "asset"])
    fwd = fwd.dropna().sort_index()
    fwd.name = "forward_return"

    dropped = {
        "incomplete_window": priced - int(len(fwd)),
        "thin_cross_section": 0,
        "no_benchmark": 0,
        "tie_at_threshold": 0,
    }
    if fwd.empty:
        raise LabelError(
            f"no window of {h} sessions closes inside this panel "
            f"({len(panel.index):,} sessions, {len(panel.columns)} assets). "
            "Every label would have had to be shortened, and a shortened "
            "label is a different question wearing the same column name."
        )

    if mode == "zero":
        bench = pd.Series(0.0, index=fwd.index, name="benchmark")
    elif mode == "bill":
        bench = _bill_benchmark(fwd, _as_bill_index(bill_index, panel.index), h)
        missing = bench.isna()
        dropped["no_benchmark"] = int(missing.sum())
        fwd, bench = fwd[~missing], bench[~missing]
    else:
        grouped = fwd.groupby(level="date")
        bench = grouped.transform("median")
        bench.name = "benchmark"
        thin = grouped.transform("size") < MIN_CROSS_SECTION
        dropped["thin_cross_section"] = int(thin.sum())
        fwd, bench = fwd[~thin], bench[~thin]

    excess = fwd - bench
    # Measured here, on the dense frame, and carried on the LabelSet.
    # After the tie drop below no date holds the whole cross-section any
    # more, so a correlation taken later would come back unmeasurable
    # and the sample-size note would quietly fall back to its cap.
    correlation_dof = _participation_ratio(excess.unstack("asset"))

    # A return exactly at the threshold has no label — not a 0, which
    # is what a `>` alone would quietly make it. Under an odd
    # cross-section the median IS one of the observed returns, so this
    # fires once a date by construction and dropping it is what pins
    # the base rate at one half. It is also, honestly, a small
    # flattery: the discarded row is the hardest one on the date, and
    # every score is therefore computed on a slightly easier set. The
    # count is reported so the size of the flattery is visible.
    tie = excess == 0.0
    dropped["tie_at_threshold"] = int(tie.sum())
    keep = ~tie

    y = (excess[keep] > 0.0).astype("int8")
    y.name = "label"

    labelled = int(len(y))
    assert labelled + sum(dropped.values()) == priced, "label accounting lost a cell"
    if labelled == 0:
        raise LabelError(
            "every candidate observation was dropped; see the reasons in "
            f"{dict(dropped)}"
        )

    return LabelSet(
        y=y,
        forward_return=fwd[keep],
        benchmark=bench[keep],
        calendar=panel.index,
        horizon=h,
        threshold=mode,
        dropped=dropped,
        correlation_dof=correlation_dof,
    )


# -- reporting accuracy without hiding the baseline ----------------------


def accuracy_report(
    y_true: pd.Series | np.ndarray,
    y_pred: pd.Series | np.ndarray,
    *,
    auc: float | None = None,
    label: str = "",
) -> pd.DataFrame:
    """Accuracy, with the base rate and the constant model beside it.

    There is deliberately no way to get the accuracy out of this
    function on its own. It takes the truth as well as the prediction,
    so the majority-class baseline is always computable, and it returns
    both in one row — because the reason the video's 62% read as a
    result is that nothing on the screen said 60.

    `edge` is accuracy less the constant model's, and `verdict` says
    whether that edge clears twice its own standard error. Two standard
    errors is a convention rather than a law and it is not a test of
    anything; it is there because "1.6 points on 1,200 observations" is
    a sentence people read as small and "inside the noise" is a
    sentence they read as zero.
    """
    truth = np.asarray(pd.Series(y_true).to_numpy(), dtype="float64").ravel()
    pred = np.asarray(pd.Series(y_pred).to_numpy(), dtype="float64").ravel()
    if truth.shape != pred.shape:
        raise LabelError(
            f"{truth.size:,} labels against {pred.size:,} predictions; these "
            "are not the same observations"
        )
    if truth.size == 0:
        raise LabelError("nothing to score")
    if not np.isin(truth, (0.0, 1.0)).all():
        raise LabelError("y_true must be binary 0/1")

    n = int(truth.size)
    base = float(truth.mean())
    majority = float(max(base, 1.0 - base))
    accuracy = float((pred == truth).mean())
    edge = accuracy - majority
    # The standard error of a proportion at the baseline, which is the
    # right scale to judge a difference of proportions on this sample.
    se = float(np.sqrt(majority * (1.0 - majority) / n))

    if edge <= 0.0:
        verdict = (
            f"{accuracy:.1%} is at or below the {majority:.1%} a model "
            "answering the majority class every time would have scored"
        )
    elif edge < 2.0 * se:
        verdict = (
            f"{accuracy:.1%} against a {majority:.1%} constant baseline: "
            f"{edge * 100:.1f} points on {n:,} observations, inside twice the "
            f"{se * 100:.1f}-point standard error and not distinguishable "
            "from no edge at all"
        )
    else:
        verdict = (
            f"{accuracy:.1%} against a {majority:.1%} constant baseline: "
            f"{edge * 100:.1f} points on {n:,} observations, clear of twice "
            f"the {se * 100:.1f}-point standard error"
        )
    if auc is not None:
        verdict += f". AUC {float(auc):.3f}"
        if abs(float(auc) - 0.5) < 0.02:
            verdict += ", which is a coin flip"

    return pd.DataFrame(
        [
            {
                "label": label,
                "n": n,
                "positives": int(truth.sum()),
                "base_rate": base,
                "majority_accuracy": majority,
                "accuracy": accuracy,
                "edge": edge,
                "edge_standard_error": se,
                "auc": float(auc) if auc is not None else float("nan"),
                "verdict": verdict,
            }
        ]
    )


# -- validation ----------------------------------------------------------


def _as_panel(prices: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(prices, pd.DataFrame):
        raise LabelError(
            f"prices must be a wide DataFrame of adjusted closes, got "
            f"{type(prices).__name__}"
        )
    if not isinstance(prices.index, pd.DatetimeIndex):
        raise LabelError("prices must be indexed by session date")
    if prices.shape[1] == 0:
        raise LabelError("prices has no assets")
    if len(prices.index) == 0:
        raise LabelError("prices has no sessions")

    idx = pd.DatetimeIndex(prices.index).normalize()
    if not idx.is_monotonic_increasing or idx.has_duplicates:
        # Position is time everywhere below: `shift(-h)` counts rows.
        # An unsorted index makes every forward window a different
        # length and none of them the one in the column heading.
        raise LabelError(
            "the session index must be strictly increasing; forward windows "
            "are counted in rows and an unsorted index makes each of them a "
            "different length"
        )
    columns = [str(c) for c in prices.columns]
    if len(set(columns)) != len(columns):
        raise LabelError("two assets share a column name")

    out = prices.copy()
    out.index = idx
    out.columns = pd.Index(columns, name="asset")
    out = out.astype("float64")

    values = out.to_numpy()
    present = ~np.isnan(values)
    if not present.any():
        raise LabelError("prices carries no prices at all")
    if (values[present] <= 0.0).any():
        raise LabelError(
            "a price is zero or negative. A forward return through one is "
            "not a large number, it is a meaningless one"
        )

    for j, name in enumerate(columns):
        col = present[:, j]
        if not col.any():
            raise LabelError(f"{name!r} has no prices in this window")
        first = int(np.argmax(col))
        last = len(col) - 1 - int(np.argmax(col[::-1]))
        if not col[first : last + 1].all():
            gap = first + int(np.argmin(col[first : last + 1]))
            raise LabelError(
                f"{name!r} is missing a price at {idx[gap].date()} in the "
                "middle of its listed span. A forward window would step "
                "straight over the hole and report a return earned across a "
                "period nobody could have held — leading and trailing gaps "
                "are fine, interior ones are not"
            )
    return out


def _as_horizon(horizon: int, n_sessions: int) -> int:
    h = int(horizon)
    if h < 1:
        raise LabelError(
            f"horizon must be at least one session, got {horizon!r}. A zero "
            "horizon labels the present, which is not a prediction"
        )
    if h >= n_sessions:
        raise LabelError(
            f"a {h}-session horizon does not close inside {n_sessions:,} "
            "sessions of data"
        )
    windows = n_sessions // h
    if windows < MIN_INDEPENDENT_WINDOWS:
        raise LabelError(
            f"a {h}-session horizon divides {n_sessions:,} sessions into "
            f"{windows} non-overlapping windows, under the floor of "
            f"{MIN_INDEPENDENT_WINDOWS}. The row count would still be in the "
            f"thousands and the sample would still be {windows} observations "
            "wide; that gap is exactly what makes a long horizon dangerous "
            "rather than merely expensive."
        )
    return h


def _as_threshold(threshold: str) -> Threshold:
    mode = str(threshold).strip().lower()
    if mode not in ("cross_sectional_median", "bill", "zero"):
        raise LabelError(
            f"unknown threshold {threshold!r}; this module knows "
            "'cross_sectional_median' (base rate one half by construction), "
            "'bill' (return above the Treasury bill over the same window) "
            "and 'zero' (the video's, kept for the comparison)"
        )
    return mode  # type: ignore[return-value]


def _as_bill_index(
    bill_index: pd.Series | None, calendar: pd.DatetimeIndex
) -> pd.Series:
    """A compounded cash index on the price calendar, or a raise.

    Deliberately an INDEX rather than a rate. A rate is a percentage
    per annum and turning it into a return over H sessions needs a day
    count, a compounding convention and a decision about weekends —
    three chances to be quietly wrong at the point where the label's
    threshold is set. `data.tbill.total_return_index` already does that
    arithmetic and the answer is a level, so the label reads a ratio of
    two levels and cannot get the convention wrong.

    The monotonicity check is not defensive padding: a percent rate
    series passed here would validate on dtype, index and sign, and
    would produce a benchmark of roughly 4 rather than 0.004 — a
    threshold no asset clears, a base rate of zero, and a label column
    that is entirely one class while looking perfectly well formed.
    """
    if bill_index is None:
        raise LabelError(
            "threshold='bill' needs bill_index: a compounded cash "
            "total-return level on the price calendar, as produced by "
            "data.tbill.total_return_index. Not a rate in percent"
        )
    s = pd.Series(bill_index).astype("float64")
    if not isinstance(s.index, pd.DatetimeIndex):
        raise LabelError("bill_index must be indexed by date")
    s.index = pd.DatetimeIndex(s.index).normalize()
    s = s[~s.index.duplicated(keep="first")].sort_index()

    on_calendar = s.reindex(calendar)
    if on_calendar.isna().any():
        first = calendar[on_calendar.isna()][0]
        raise LabelError(
            f"bill_index has no level for {first.date()}, a session in the "
            "price panel. Reindexing it here would forward-fill a rate over "
            "a gap nobody measured; build the index on this calendar instead"
        )
    if (on_calendar <= 0.0).any():
        raise LabelError("bill_index carries a non-positive level")
    if (on_calendar.diff().dropna() < -1e-9).any():
        raise LabelError(
            "bill_index falls. A compounded cash index cannot, since US bill "
            "yields have never been negative — this is almost certainly an "
            "annualised RATE passed where a level was wanted, which would "
            "set the threshold about a thousand times too high and hand back "
            "a label column that is entirely one class"
        )
    return on_calendar


def _bill_benchmark(fwd: pd.Series, bill: pd.Series, horizon: int) -> pd.Series:
    """What cash earned over each label's own window."""
    over_window = bill.shift(-horizon) / bill - 1.0
    dates = pd.DatetimeIndex(fwd.index.get_level_values("date"))
    out = pd.Series(
        over_window.reindex(dates).to_numpy(), index=fwd.index, name="benchmark"
    )
    return out


def _participation_ratio(wide: pd.DataFrame) -> float:
    """How many independent series a correlated cross-section amounts to.

    The participation ratio of the correlation matrix's eigenvalues,
    `(sum l)^2 / sum l^2`, which is `n` when the assets are unrelated
    and 1 when they are one asset in nine costumes. It is computed on
    the dates where every asset is present, because the alternative —
    pairwise-complete correlations — builds a matrix from different
    samples per cell, which is not guaranteed positive semi-definite
    and can hand back negative eigenvalues and a ratio above `n`.

    NaN rather than a guess when there are too few complete dates. A
    number here feeds a claim about how much evidence exists, and an
    unmeasured one dressed up as measured would inflate exactly the
    figure this module exists to deflate.
    """
    complete = wide.dropna(axis=0, how="any")
    if complete.shape[1] < 2 or len(complete) < MIN_CORRELATION_DATES:
        return float("nan")
    corr = complete.corr().to_numpy(dtype="float64")
    if not np.isfinite(corr).all():
        return float("nan")
    eigenvalues = np.clip(np.linalg.eigvalsh(corr), 0.0, None)
    total = float(eigenvalues.sum())
    squared = float((eigenvalues**2).sum())
    if total <= 0.0 or squared <= 0.0:
        return float("nan")
    return total * total / squared
