"""The boosted-tree baseline, and a spread around every probability it
prints.

This is the model the video should have reached for first. On a wide,
noisy, low-signal tabular panel a gradient-boosted tree is the thing to
beat, and an LSTM is a much larger apparatus for a much smaller amount
of structure — sequence models earn their keep when the ORDER inside a
window matters, and every feature handed in here has already been
reduced to a trailing statistic. So the sequence model has nothing left
to sequence. Fitting the tree first is not a shortcut; it is the
control, and if the tree finds nothing there is nothing for a recurrent
net to find either.

**The expected answer is an AUC near 0.50 and that is a measurement.**
Nothing in this file is allowed to be tuned toward a better number. The
hyperparameters below were written down as priors before any fold had
been scored, there is no search, and if a sweep is ever run then every
configuration in it owes `metrics.TrialCounter` a row — because the
deflated Sharpe downstream is a function of how many times we looked.

Four traps, in the order they would bite.

**Seed ensembling on this estimator produces zero spread.**
`HistGradientBoostingClassifier` consumes `random_state` in exactly two
places: subsampling for the binning when the training set is above
200,000 rows, and the train/validation split when early stopping is on.
This panel is smaller than that and early stopping is off, so ten
members at ten seeds are ten bit-identical models. Measured, not
assumed: two fits at different seeds agree to 0.0. An uncertainty band
built that way would report a standard deviation of exactly zero on
every row and read as total confidence, which is the worst possible
failure for a number whose whole job is to say when to stand aside. The
members here are therefore fitted on BOOTSTRAP RESAMPLES, and the
resampling is over DATES rather than rows for the reason `splits.py`
gives: two assets on one date were measured against each other, so a
row-level resample would put a date's cross-section partly in and
partly out and quietly break the label's own arithmetic.

**Early stopping would leak.** sklearn's default is `'auto'`, which
turns early stopping ON above 10,000 samples and carves the validation
slice out of the training rows AT RANDOM. On a long panel that puts
2019-03-14's SPY in the fit and 2019-03-14's TLT in the stopping
criterion — the exact same-date split `splits.py` exists to prevent,
re-introduced inside the estimator where no leak check can see it.
`early_stopping=False` is not a performance choice, it is the fix.

**The uncertainty this file reports is model variance and nothing
else.** The spread across members answers "how much does the fitted
function move when the training sample is resampled". It does not
answer "do these features carry signal", which is a far larger
uncertainty and is not quantified anywhere in this repository — it is
the question the whole exercise is asking. A member spread of 0.01
around a probability of 0.55 means the ensemble agrees; it says nothing
about whether 0.55 is right. Two further understatements are worth
naming: resampling dates treats them as independent draws when regimes
run for months, and every member sees the same feature construction, so
a mistake in `features.py` is invisible to the entire ensemble at once.

**There is no `feature_importances_` on this estimator, and the
substitute has a sharp edge.** Importance here is a permutation test —
shuffle one column, watch the test AUC fall — and the shuffle is done
WITHIN DATE. A global shuffle would move a 2008 volatility reading onto
a 2017 row, and the AUC drop would then be partly the model noticing
that the value is out of era, which is a fact about the calendar
attributed to the feature. The cost of the within-date choice is that a
column constant across the cross-section (the bill rate) cannot be
permuted at all, so its importance is reported as NaN with a reason
rather than as a zero that reads like a measurement.

**0.500 is the wrong bar and beating it proves nothing.** A coin scores
0.500; a spreadsheet sorting one column scores whatever that column is
worth, which in a cross-section of ETFs is not small. So every fold is
also scored against `best_single_feature` — the best AUC any ONE column
reaches alone, with the column chosen and its sign flipped after seeing
that fold. The baseline is deliberately given advantages nobody could
have had in advance, because a model that cannot beat a peeking
one-liner has not earned two hundred trees, and the comparison against
0.500 would have let it look as though it had.

Read `importance_near_uniform` before reading any AUC. Attention spread
evenly over seventeen columns is what a model looks like when it is
fitting noise, and it is the diagnostic the source project reported
about its own features without following the thought through.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Iterator, Mapping, Sequence

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

from ..engine.metrics import TrialCounter
from .features import FEATURE_COLUMNS
from .labels import LabelSet, accuracy_report
from .splits import PanelFold, SplitPlan

__all__ = [
    "DEFAULT_CONFIG",
    "BaggedGBM",
    "EnsemblePrediction",
    "FoldResult",
    "GBMConfig",
    "GBMError",
    "GBMReport",
    "IMPORTANCE_NOISE_FLOOR",
    "NEAR_UNIFORM_FRACTION",
    "RankIC",
    "align_features",
    "best_single_feature",
    "evaluate",
    "importance_participation",
    "learning_curve",
    "permutation_importance",
    "rank_ic",
]


class GBMError(ValueError):
    """The model was asked to fit or score something it cannot."""


# -- the hyperparameters, each one a prior ------------------------------
#
# Five numbers, all round, all fixed before a fold had been scored. Each
# has an argument attached that does not mention a result, because the
# moment one of them is chosen by comparing AUCs it stops being a prior
# and becomes a fitted parameter — one that never appears in the model's
# own reported degrees of freedom and never shows up in a t-statistic.
# If you feel the urge to sweep these, the honest move is to log every
# configuration in the sweep to `trials.jsonl` and let the deflation pay
# for it.

#: Half sklearn's default. The prior is that whatever is here is small,
#: and a large step on a target that is 50% noise fits the first split's
#: noise hard and then spends the remaining iterations defending it.
DEFAULT_LEARNING_RATE = 0.05

#: Twice sklearn's default iteration count, which at half the step size
#: is the same total budget. Deliberately not "more trees, since they
#: cannot hurt" — they can, and `learning_curve` is here to show it.
DEFAULT_MAX_ITER = 200

#: Eight leaves is three levels of interaction. The default 31 is a
#: reasonable prior for a dataset with tens of thousands of independent
#: observations; this panel has a few hundred, because a 21-session
#: label overlaps its neighbour by twenty, and a tree that deep would
#: be describing individual months.
DEFAULT_MAX_LEAF_NODES = 8

#: About seven sessions of a twenty-eight name cross-section. Sklearn's
#: default of 20 is under one date, which on a panel is a leaf fitted to
#: a single afternoon; and since consecutive sessions share nearly all
#: of their label window, seven sessions is still well under one
#: independent observation. The prior is "a leaf must be a period, not a
#: day".
DEFAULT_MIN_SAMPLES_LEAF = 200

#: Non-zero on principle. The sklearn default of 0.0 is a statement that
#: the training data is to be trusted, which is not this project's view
#: of a twenty-year single path.
DEFAULT_L2_REGULARIZATION = 1.0

#: Ten bootstrap members. Enough that the spread is a spread rather than
#: a range of three numbers, few enough that a fold fits in seconds. The
#: standard error of a member standard deviation at n=10 is around 24%
#: of itself, so read the spread as an order of magnitude and never as
#: a third decimal place.
DEFAULT_N_MEMBERS = 10

#: Permutation repeats per feature. Five, because the quantity being
#: measured is usually indistinguishable from zero and a single shuffle
#: of a null feature routinely swings the AUC by half a point.
DEFAULT_IMPORTANCE_REPEATS = 5

#: The seed everything derives from. One integer, so a run is
#: reproducible from its config alone.
DEFAULT_SEED = 0

#: Importance is called near-uniform when the participation ratio of its
#: shares reaches this fraction of the number of features that could be
#: measured. Half is not a taste: if every feature is noise then the
#: shares are the magnitudes of n independent draws around zero, and the
#: participation ratio of those has expectation `n * (E|x|)^2 / E[x^2]`,
#: which for a normal is `2/pi` — about 0.64n, with a fifth percentile
#: near 0.52n. A single dominant feature puts the ratio near 1, which is
#: 0.06n at seventeen features. Half sits in the gap, on the noise side
#: of it, so the flag fires for a table that looks like nothing and stays
#: quiet for one with something in it.
NEAR_UNIFORM_FRACTION = 0.5

#: Below this total AUC drop across all features, the importance
#: RANKING is noise ordering itself and must be reported that way. Half
#: a point of AUC summed over seventeen columns is nothing.
IMPORTANCE_NOISE_FLOOR = 0.005

#: A Spearman correlation over fewer names than this is not a
#: cross-sectional measurement. Same floor `labels.MIN_CROSS_SECTION`
#: uses, and for the same reason.
MIN_IC_CROSS_SECTION = 3


@dataclass(frozen=True)
class GBMConfig:
    """Every knob, and the identity a trial is hashed from.

    Frozen so that a config cannot be edited between the row written to
    the ledger and the fit that follows it — which would put a
    description in `trials.jsonl` for an experiment that never ran.
    """

    learning_rate: float = DEFAULT_LEARNING_RATE
    max_iter: int = DEFAULT_MAX_ITER
    max_leaf_nodes: int = DEFAULT_MAX_LEAF_NODES
    min_samples_leaf: int = DEFAULT_MIN_SAMPLES_LEAF
    l2_regularization: float = DEFAULT_L2_REGULARIZATION
    n_members: int = DEFAULT_N_MEMBERS
    importance_repeats: int = DEFAULT_IMPORTANCE_REPEATS
    seed: int = DEFAULT_SEED

    def __post_init__(self) -> None:
        if not 0.0 < float(self.learning_rate) <= 1.0:
            raise GBMError(f"learning_rate {self.learning_rate!r} is not in (0, 1]")
        for name in ("max_iter", "max_leaf_nodes", "min_samples_leaf", "n_members"):
            value = getattr(self, name)
            if int(value) < 1:
                raise GBMError(f"{name} must be at least 1, got {value!r}")
        if int(self.max_leaf_nodes) < 2:
            raise GBMError(
                "max_leaf_nodes below 2 is a stump with no split, which "
                "predicts the base rate and nothing else"
            )
        if int(self.importance_repeats) < 1:
            raise GBMError("importance_repeats must be at least 1")
        if float(self.l2_regularization) < 0.0:
            raise GBMError("l2_regularization cannot be negative")

    def estimator(self, *, random_state: int) -> HistGradientBoostingClassifier:
        """One member, with the two settings that are not preferences.

        `early_stopping=False` is the leak fix in the module docstring:
        the default carves a validation slice out of the training rows
        at random, which on a panel splits a date across the seam.
        `class_weight=None` because the cross-sectional label's base
        rate is one half by construction — reweighting a balanced
        target would only distort the probabilities the whole
        uncertainty apparatus is built on.
        """
        return HistGradientBoostingClassifier(
            loss="log_loss",
            learning_rate=float(self.learning_rate),
            max_iter=int(self.max_iter),
            max_leaf_nodes=int(self.max_leaf_nodes),
            min_samples_leaf=int(self.min_samples_leaf),
            l2_regularization=float(self.l2_regularization),
            early_stopping=False,
            class_weight=None,
            random_state=int(random_state),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": "hist_gradient_boosting",
            "learning_rate": float(self.learning_rate),
            "max_iter": int(self.max_iter),
            "max_leaf_nodes": int(self.max_leaf_nodes),
            "min_samples_leaf": int(self.min_samples_leaf),
            "l2_regularization": float(self.l2_regularization),
            "ensemble": "date_block_bootstrap",
            "n_members": int(self.n_members),
            "importance_repeats": int(self.importance_repeats),
            "seed": int(self.seed),
        }


DEFAULT_CONFIG = GBMConfig()


# -- what a prediction actually is --------------------------------------


@dataclass(frozen=True, eq=False)
class EnsemblePrediction:
    """Every member's probability for every row, and the summary of them.

    The members are kept rather than reduced on the way out, because a
    mean and a standard deviation are a two-number summary of a
    distribution that is often not remotely symmetric — four members
    saying 0.51 and six saying 0.60 has the same mean as a tight
    cluster at 0.564 and means something entirely different.

    `eq=False` because the field is an array and a generated `__eq__`
    would return an array where a bool was wanted.
    """

    members: np.ndarray = field(repr=False)

    def __post_init__(self) -> None:
        arr = np.asarray(self.members, dtype="float64")
        if arr.ndim != 2:
            raise GBMError(
                f"members must be (n_members, n_rows), got shape {arr.shape}"
            )
        object.__setattr__(self, "members", arr)

    @property
    def n_members(self) -> int:
        return int(self.members.shape[0])

    @property
    def mean(self) -> np.ndarray:
        """The bagged probability. This IS the model's answer.

        Not an approximation to some truer single-fit answer — the
        ensemble is the estimator, and the mean is what it predicts.
        """
        return self.members.mean(axis=0)

    @property
    def spread(self) -> np.ndarray:
        """Standard deviation across members. The confidence, crudely.

        `ddof=1` because ten members are a sample of the resampling
        distribution and not the whole of it. A single member has no
        spread and gets NaN rather than 0.0, since zero here would read
        as certainty rather than as an unmeasured quantity.
        """
        if self.n_members < 2:
            return np.full(self.members.shape[1], np.nan)
        return self.members.std(axis=0, ddof=1)

    def quantile(self, q: float) -> np.ndarray:
        """A member quantile, for the asymmetric cases the mean hides."""
        return np.quantile(self.members, float(q), axis=0)

    def frame(self, index: pd.Index | None = None) -> pd.DataFrame:
        """Probability, spread and a member range, one row per observation."""
        out = pd.DataFrame(
            {
                "probability": self.mean,
                "spread": self.spread,
                "member_low": self.members.min(axis=0),
                "member_high": self.members.max(axis=0),
            }
        )
        if index is not None:
            if len(index) != len(out):
                raise GBMError(
                    f"{len(index):,} index entries for {len(out):,} predictions"
                )
            out.index = index
        return out

    def confident(self, *, above: float, spread_at_most: float) -> np.ndarray:
        """The video's actual contribution: act only when both hold.

        A high probability with a wide member spread is the state this
        whole class exists to make visible — the ensemble is saying
        "somewhere between a coin flip and a strong call, depending on
        which twenty years you fit me on". Requiring both conditions is
        what separates a confident 0.55 from a wild one.
        """
        spread = self.spread
        # NaN spread (one member) fails the test rather than passing it
        # by default: an unmeasured uncertainty is not a small one.
        return (self.mean >= float(above)) & (spread <= float(spread_at_most))


class BaggedGBM:
    """Boosted trees over bootstrapped dates, fitted and asked together.

    Not a sklearn estimator and deliberately not one. `fit` requires the
    date of every row, which no sklearn signature carries, and making it
    fit the interface would mean passing the dates through some side
    channel and letting a caller forget — at which point the bootstrap
    silently becomes row-level and the members stop being independent
    fits of the panel.
    """

    def __init__(self, config: GBMConfig = DEFAULT_CONFIG) -> None:
        if not isinstance(config, GBMConfig):
            raise GBMError(f"expected a GBMConfig, got {type(config).__name__}")
        self.config = config
        self.members_: tuple[HistGradientBoostingClassifier, ...] = ()
        self.features_: tuple[str, ...] = ()
        self.n_train_dates_: int = 0

    def fit(
        self,
        X: pd.DataFrame,
        y: pd.Series | np.ndarray,
        *,
        dates: Sequence[Any] | pd.Index,
    ) -> "BaggedGBM":
        """Fit `n_members` models, each on its own resample of the dates.

        The resample draws DATES with replacement and takes every row of
        each drawn date. A date appearing twice contributes its whole
        cross-section twice, which is what keeps the label's arithmetic
        intact — under the cross-sectional label a date's rows were
        compared against each other's median, so half a date is a
        sample of a comparison that was never made.
        """
        frame = _as_feature_frame(X)
        target = _as_binary(y, len(frame))
        codes = _date_codes(dates, len(frame))
        n_dates = int(codes.max()) + 1 if codes.size else 0
        if n_dates < 2:
            raise GBMError(
                f"{n_dates} distinct training date(s); a bootstrap over dates "
                "has nothing to resample and every member would be identical"
            )

        values = frame.to_numpy(dtype="float64")
        # A column with no observed value anywhere in the training rows
        # has no bin edges, and the estimator's own message for that is
        # "window shape cannot be larger than input array shape" from
        # three libraries down. It is a real state rather than a
        # hypothetical: `features.build_features` emits an all-NaN
        # `bill_rate` whenever no rate series is supplied, so a run
        # without FRED lands here. Named, and refused rather than
        # dropped — quietly removing a column would mean the model
        # fitted is not the model the trial ledger describes.
        empty = [
            str(name)
            for name, has in zip(frame.columns, np.isfinite(values).any(axis=0))
            if not has
        ]
        if empty:
            raise GBMError(
                f"{empty} carry no value at all in the training fold, so there "
                "is nothing to bin them on. Drop the column or supply the "
                "series it was meant to hold — a feature that is missing "
                "everywhere is not a feature the model can be said to have used"
            )
        rows_by_date = _rows_by_date(codes, n_dates)

        members: list[HistGradientBoostingClassifier] = []
        for m in range(int(self.config.n_members)):
            rng = np.random.default_rng(int(self.config.seed) + m)
            drawn = rng.integers(0, n_dates, size=n_dates)
            rows = np.concatenate([rows_by_date[d] for d in drawn])
            yb = target[rows]
            if np.unique(yb).size < 2:
                raise GBMError(
                    f"bootstrap member {m} drew a training set with one class "
                    f"({int(yb.sum())} positives of {yb.size:,}). The fold is "
                    "too small or too imbalanced for this ensemble; a redraw "
                    "here would quietly turn the bootstrap into a filtered "
                    "one and understate the spread"
                )
            # random_state is inert with early stopping off — see the
            # module docstring — and is set anyway so that a future
            # change to those conditions cannot silently make the
            # members diverge for a reason nobody chose.
            model = self.config.estimator(random_state=int(self.config.seed) + m)
            members.append(model.fit(values[rows], yb))

        self.members_ = tuple(members)
        self.features_ = tuple(str(c) for c in frame.columns)
        self.n_train_dates_ = n_dates
        return self

    def predict_proba(self, X: pd.DataFrame | np.ndarray) -> EnsemblePrediction:
        """Every member's P(label = 1), stacked."""
        if not self.members_:
            raise GBMError("predict_proba called before fit")
        values = _as_matrix(X, self.features_)
        stacked = np.vstack([m.predict_proba(values)[:, 1] for m in self.members_])
        return EnsemblePrediction(members=stacked)


# -- getting the features onto the labelled rows ------------------------


def align_features(
    features: pd.DataFrame,
    labels: LabelSet,
    *,
    columns: Sequence[str] | None = None,
    key: str = "ticker",
) -> pd.DataFrame:
    """The feature frame on exactly the labelled rows, in their order.

    A join and not an alignment-by-accident. `splits.PanelFold.take`
    slices positionally and refuses a frame of the wrong height, but it
    cannot see a frame of the RIGHT height in the wrong order — that
    fits the model on scrambled targets and returns an AUC of about
    0.50, which on this project is indistinguishable from the honest
    answer we expect to find. So the row order is established here,
    once, by reindexing onto the label's own index.

    A labelled row with no feature row at all is a refusal rather than a
    row of NaN. The two are different failures and only one of them is
    survivable: missing values inside a feature are the warmup and the
    trees route them natively, whereas a missing ROW means the feature
    frame and the label frame were built from different panels.

    **Warmup rows are kept.** A name's features are NaN for its first
    252 sessions and those rows stay, because dropping them here would
    desynchronise `X` from the positions every fold indexes with. The
    right place to remove the warmup is upstream, by building the labels
    from a price panel that starts after it; `n_train_all_nan` on each
    fold reports how much of a fold is warmup either way.
    """
    if not isinstance(labels, LabelSet):
        raise GBMError(f"expected a LabelSet, got {type(labels).__name__}")
    if not isinstance(features, pd.DataFrame):
        raise GBMError(f"features must be a DataFrame, got {type(features).__name__}")

    wanted = list(columns) if columns is not None else list(FEATURE_COLUMNS)
    missing_columns = [c for c in wanted if c not in features.columns]
    if missing_columns:
        raise GBMError(
            f"feature frame is missing {missing_columns}; it has "
            f"{sorted(features.columns)}"
        )
    if "date" not in features.columns or key not in features.columns:
        raise GBMError(
            f"feature frame needs 'date' and {key!r} columns to be located "
            "against the labels"
        )

    keyed = features.set_index(
        [pd.DatetimeIndex(features["date"]), features[key].astype("str")]
    )
    keyed.index = keyed.index.set_names(["date", "asset"])
    if keyed.index.has_duplicates:
        n = int(keyed.index.duplicated().sum())
        raise GBMError(
            f"{n:,} duplicate (date, {key}) row(s) in the feature frame. The "
            "reindex below would pick one arbitrarily and the model would be "
            "fitted on whichever it picked"
        )

    absent = labels.y.index.difference(keyed.index)
    if len(absent):
        first = absent[0]
        raise GBMError(
            f"{len(absent):,} labelled row(s) have no features, the first "
            f"{first[1]} on {pd.Timestamp(first[0]).date()}. Filling them "
            "with NaN would let the model be trained on rows that were never "
            "built; the two frames come from different panels"
        )

    out = keyed.loc[:, wanted].reindex(labels.y.index)
    for column in wanted:
        out[column] = out[column].astype("float64")
    values = out.to_numpy(dtype="float64")
    if np.isinf(values).any():
        raise GBMError(
            "a feature is infinite. The estimator refuses these outright, and "
            "an infinity here is a division by a volatility of zero somewhere "
            "upstream rather than a large number"
        )
    return out


# -- the two scores that are not accuracy -------------------------------


@dataclass(frozen=True)
class RankIC:
    """Cross-sectional rank correlation of the prediction with the truth.

    The number a long-only cross-sectional model is actually judged on:
    an AUC says the ordering is better than chance somewhere, and an IC
    says how much of the return ordering it recovered. Computed per DATE
    and then averaged, never pooled across the whole panel — a pooled
    Spearman over every row rewards a model for knowing that 2009 was a
    better year than 2008, which is a fact about the calendar and not a
    fact about which fund to hold on Tuesday. `pooled` is reported
    beside it precisely so the gap can be seen.

    `t_stat` is the naive one and is too large. Daily ICs computed off
    overlapping H-session windows are nearly the same measurement H
    times over, so the count of independent draws is closer to
    `n_dates / horizon`; `t_stat_overlap_adjusted` divides by sqrt(H),
    which is the crude version of that correction and still generous.
    """

    mean: float
    std: float
    n_dates: int
    t_stat: float
    t_stat_overlap_adjusted: float
    pooled: float
    horizon: int


def rank_ic(
    probability: np.ndarray | pd.Series,
    forward_return: np.ndarray | pd.Series,
    dates: Sequence[Any] | pd.Index,
    *,
    horizon: int = 1,
) -> RankIC:
    """Mean per-date Spearman of the prediction against what happened."""
    p = np.asarray(pd.Series(probability).to_numpy(), dtype="float64").ravel()
    r = np.asarray(pd.Series(forward_return).to_numpy(), dtype="float64").ravel()
    if p.shape != r.shape:
        raise GBMError(
            f"{p.size:,} predictions against {r.size:,} realised returns"
        )
    codes = _date_codes(dates, p.size)
    n_dates = int(codes.max()) + 1 if codes.size else 0

    per_date: list[float] = []
    for rows in _rows_by_date(codes, n_dates):
        value = _spearman(p[rows], r[rows])
        if np.isfinite(value):
            per_date.append(value)

    series = np.asarray(per_date, dtype="float64")
    n = int(series.size)
    mean = float(series.mean()) if n else float("nan")
    std = float(series.std(ddof=1)) if n > 1 else float("nan")
    t = float(mean / (std / np.sqrt(n))) if n > 1 and std > 0.0 else float("nan")
    h = max(int(horizon), 1)
    return RankIC(
        mean=mean,
        std=std,
        n_dates=n,
        t_stat=t,
        t_stat_overlap_adjusted=float(t / np.sqrt(h)) if np.isfinite(t) else t,
        pooled=_spearman(p, r),
        horizon=h,
    )


def permutation_importance(
    model: BaggedGBM,
    X: pd.DataFrame,
    y: pd.Series | np.ndarray,
    dates: Sequence[Any] | pd.Index,
    *,
    repeats: int = DEFAULT_IMPORTANCE_REPEATS,
    seed: int = DEFAULT_SEED,
) -> pd.DataFrame:
    """AUC lost when one column is shuffled within its own date.

    Within-date rather than globally, for the reason in the module
    docstring: a global shuffle also destroys the era a value belongs
    to, and credits the feature with the model's ability to date it.

    Returns one row per feature — `importance` (mean AUC drop),
    `importance_std` across repeats, `share` of the total, and a `note`.
    A column that does not vary within a date cannot be permuted by this
    test at all and comes back NaN with the reason attached, because a
    0.0 there would sit in the table looking like a finding.

    `importance` keeps its sign and `share` is the MAGNITUDE's share of
    the total magnitude. Clipping the negatives away instead — the
    obvious spelling — inverts the diagnostic this table exists for: on
    pure noise most drops come out slightly negative, so the shares
    would concentrate on whichever two columns happened to land positive
    and a model attending to nothing would be reported as a model with
    two favourite features. A shuffle that moves the score is a shuffle
    that moved the score, and which direction it moved says nothing when
    the movement is noise.
    """
    frame = _as_feature_frame(X)
    target = _as_binary(y, len(frame))
    codes = _date_codes(dates, len(frame))
    n_dates = int(codes.max()) + 1 if codes.size else 0

    baseline = _safe_auc(target, model.predict_proba(frame).mean)
    if not np.isfinite(baseline):
        raise GBMError(
            "the test fold has one class, so there is no AUC to lose and no "
            "importance to measure"
        )

    varies = _varies_within_date(frame, codes)
    values = frame.to_numpy(dtype="float64")
    rng = np.random.default_rng(int(seed))

    rows: list[dict[str, Any]] = []
    for j, name in enumerate(frame.columns):
        if not bool(varies.iloc[j]):
            rows.append(
                {
                    "feature": str(name),
                    "importance": float("nan"),
                    "importance_std": float("nan"),
                    "note": (
                        "constant across the cross-section on every date, so a "
                        "within-date shuffle cannot move it. Unmeasured, not "
                        "unimportant"
                    ),
                }
            )
            continue

        drops = np.empty(int(repeats), dtype="float64")
        column = values[:, j].copy()
        for k in range(int(repeats)):
            shuffled = values.copy()
            shuffled[:, j] = _permute_within_date(column, codes, n_dates, rng)
            scored = model.predict_proba(
                pd.DataFrame(shuffled, columns=frame.columns)
            ).mean
            drops[k] = baseline - _safe_auc(target, scored)
        rows.append(
            {
                "feature": str(name),
                "importance": float(drops.mean()),
                "importance_std": (
                    float(drops.std(ddof=1)) if drops.size > 1 else float("nan")
                ),
                "note": "",
            }
        )

    out = pd.DataFrame(rows)
    magnitude = out["importance"].abs()
    total = float(magnitude.sum())
    out["share"] = magnitude / total if total > 0.0 else np.nan
    return out.sort_values("importance", ascending=False).reset_index(drop=True)


def best_single_feature(
    X: pd.DataFrame, y: pd.Series | np.ndarray
) -> tuple[str, float]:
    """The best AUC any ONE column reaches alone, sign chosen in hindsight.

    The bar the model has to clear, and it is deliberately set unfairly
    high: the column is picked after seeing the test fold and its sign
    is flipped if that helps, neither of which anybody could have done
    in advance. A model that cannot beat a baseline which got to peek
    has not earned its seventeen features, its two hundred trees or its
    ten bootstrap members — and "it beat 0.500" is the wrong comparison
    to have been making, because 0.500 is what a coin scores and a
    single sorted column is what a spreadsheet scores.

    Ties go to the first column in frame order, which is arbitrary and
    does not matter: this is a bar, not a ranking.
    """
    frame = _as_feature_frame(X)
    truth = _as_binary(y, len(frame))
    best_name, best_auc = "", float("nan")
    for name in frame.columns:
        values = frame[name].to_numpy(dtype="float64")
        finite = np.isfinite(values)
        if int(finite.sum()) < 2:
            continue
        auc = _safe_auc(truth[finite], values[finite])
        if not np.isfinite(auc):
            continue
        auc = max(auc, 1.0 - auc)
        if not np.isfinite(best_auc) or auc > best_auc:
            best_name, best_auc = str(name), float(auc)
    return best_name, best_auc


def importance_participation(shares: pd.Series | np.ndarray) -> float:
    """How many features the model's attention amounts to.

    The same participation ratio `labels._participation_ratio` uses on
    correlations, `(sum s)^2 / sum s^2`, which is `n` when every feature
    matters equally and 1 when one of them carries everything. Read it
    against the count of measurable features: at seventeen, an eleven is
    where pure noise lands and a two is a model that found something (or
    found the calendar — check which feature).
    """
    s = np.asarray(pd.Series(shares).to_numpy(), dtype="float64").ravel()
    s = s[np.isfinite(s)]
    s = np.clip(s, 0.0, None)
    total = float(s.sum())
    squared = float((s**2).sum())
    if total <= 0.0 or squared <= 0.0:
        return float("nan")
    return total * total / squared


# -- a fold, scored -----------------------------------------------------


@dataclass(frozen=True, eq=False)
class FoldResult:
    """One fold's numbers, with the base rate beside every one of them.

    The accuracy row comes from `labels.accuracy_report`, which cannot
    be made to return an accuracy without the majority-class baseline in
    the same frame. That is not defensive plumbing: the reason the
    video's 62% read as a result is that nothing on the screen said 60.
    """

    fold: int
    kind: str
    train_start: pd.Timestamp
    train_end: pd.Timestamp
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    n_train: int
    n_test: int
    n_train_all_nan: int
    n_test_all_nan: int
    train_base_rate: float
    test_base_rate: float
    auc: float
    #: The null standard error of that AUC, widened for the overlap
    #: between consecutive label windows. Two of these either side of
    #: 0.500 is the band inside which a fold has said nothing.
    auc_standard_error: float
    accuracy: float
    majority_accuracy: float
    edge: float
    edge_standard_error: float
    ic: RankIC
    #: The best any single column does alone on these same test rows,
    #: with its sign chosen after the fact. See `best_single_feature`:
    #: the model is expected to beat this, not 0.500.
    best_feature: str
    best_feature_auc: float
    mean_spread: float
    median_spread: float
    importance: pd.DataFrame = field(repr=False)
    importance_participation: float = float("nan")
    importance_measured: int = 0
    importance_total: float = float("nan")
    importance_near_uniform: bool = False
    verdict: str = ""
    prediction: EnsemblePrediction | None = field(default=None, repr=False)

    @property
    def edge_over_best_feature(self) -> float:
        """What the model added over one sorted column. Often negative."""
        if not np.isfinite(self.auc) or not np.isfinite(self.best_feature_auc):
            return float("nan")
        return float(self.auc - self.best_feature_auc)

    @property
    def auc_z(self) -> float:
        """Distance from a coin flip, in its own standard errors."""
        if not np.isfinite(self.auc) or not np.isfinite(self.auc_standard_error):
            return float("nan")
        if self.auc_standard_error <= 0.0:
            return float("nan")
        return float((self.auc - 0.5) / self.auc_standard_error)

    def row(self) -> dict[str, Any]:
        return {
            "fold": self.fold,
            "kind": self.kind,
            "train_start": self.train_start,
            "train_end": self.train_end,
            "test_start": self.test_start,
            "test_end": self.test_end,
            "n_train": self.n_train,
            "n_test": self.n_test,
            "n_train_all_nan": self.n_train_all_nan,
            "n_test_all_nan": self.n_test_all_nan,
            "train_base_rate": self.train_base_rate,
            "test_base_rate": self.test_base_rate,
            "auc": self.auc,
            "auc_standard_error": self.auc_standard_error,
            "auc_z": self.auc_z,
            "accuracy": self.accuracy,
            "majority_accuracy": self.majority_accuracy,
            "edge": self.edge,
            "edge_standard_error": self.edge_standard_error,
            "best_feature": self.best_feature,
            "best_feature_auc": self.best_feature_auc,
            "edge_over_best_feature": self.edge_over_best_feature,
            "rank_ic": self.ic.mean,
            "rank_ic_t": self.ic.t_stat,
            "rank_ic_t_overlap_adjusted": self.ic.t_stat_overlap_adjusted,
            "rank_ic_pooled": self.ic.pooled,
            "rank_ic_dates": self.ic.n_dates,
            "mean_spread": self.mean_spread,
            "median_spread": self.median_spread,
            "importance_participation": self.importance_participation,
            "importance_measured": self.importance_measured,
            "importance_total": self.importance_total,
            "importance_near_uniform": self.importance_near_uniform,
            "verdict": self.verdict,
        }


@dataclass(frozen=True, eq=False)
class GBMReport:
    """Every fold, in order, plus whether the run is in the ledger.

    `recorded` is on the report rather than left implicit because a
    configuration evaluated and not logged makes every deflated Sharpe
    computed afterwards too generous, and the person reading a table of
    AUCs is exactly the person who needs telling.
    """

    config: GBMConfig
    kind: str
    horizon: int
    folds: tuple[FoldResult, ...]
    recorded: bool
    trial_config: Mapping[str, Any] = field(repr=False, default_factory=dict)

    def __len__(self) -> int:
        return len(self.folds)

    def __iter__(self) -> Iterator[FoldResult]:
        return iter(self.folds)

    def __getitem__(self, i: int) -> FoldResult:
        return self.folds[i]

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame([f.row() for f in self.folds])

    def trajectory(self) -> pd.DataFrame:
        """The columns to actually read, in the order to read them.

        A pooled mean AUC over five folds hides the only shape that
        matters here — the source project's validation AUC went from
        0.60 to 0.50 across its epochs while training AUC climbed, and
        a single averaged number would have printed 0.55 and looked
        like a modest edge.
        """
        columns = [
            "fold",
            "test_start",
            "test_end",
            "n_test",
            "test_base_rate",
            "auc",
            "auc_z",
            "best_feature",
            "best_feature_auc",
            "edge_over_best_feature",
            "accuracy",
            "majority_accuracy",
            "rank_ic",
            "rank_ic_t_overlap_adjusted",
            "mean_spread",
            "importance_near_uniform",
        ]
        return self.frame().loc[:, columns]

    def importances(self) -> pd.DataFrame:
        """Fold by feature, long. Read down a feature, not across a fold.

        A feature that tops one fold and sits mid-table in the other
        four has not been found; five folds ranking the same column
        first is the only shape that would be evidence.
        """
        frames = []
        for f in self.folds:
            frame = f.importance.copy()
            frame.insert(0, "fold", f.fold)
            frames.append(frame)
        if not frames:
            return pd.DataFrame(
                columns=["fold", "feature", "importance", "importance_std", "share"]
            )
        return pd.concat(frames, ignore_index=True)

    @property
    def aucs(self) -> tuple[float, ...]:
        return tuple(float(f.auc) for f in self.folds)

    @property
    def mean_auc(self) -> float:
        values = np.asarray(self.aucs, dtype="float64")
        values = values[np.isfinite(values)]
        return float(values.mean()) if values.size else float("nan")

    def summary(self) -> str:
        """The paragraph a reader gets before any table.

        It leads with the trajectory and it says "coin flip" in as many
        words when the folds sit at one half, because a table of numbers
        near 0.5 is read as a weak positive by anybody who is hoping.
        """
        aucs = np.asarray(self.aucs, dtype="float64")
        finite = aucs[np.isfinite(aucs)]
        listed = ", ".join(
            f"{v:.3f}" if np.isfinite(v) else "n/a" for v in aucs
        )
        base = np.asarray(
            [f.test_base_rate for f in self.folds], dtype="float64"
        )
        ics = np.asarray([f.ic.mean for f in self.folds], dtype="float64")
        uniform = sum(1 for f in self.folds if f.importance_near_uniform)

        if not finite.size:
            return "no fold produced a scoreable AUC"

        drift = (
            f"{aucs[0]:.3f} in the first fold to {aucs[-1]:.3f} in the last"
            if np.isfinite(aucs[0]) and np.isfinite(aucs[-1])
            else "no readable first-to-last trajectory"
        )
        headline = (
            f"{self.kind}: fold AUCs {listed} (mean {finite.mean():.3f}, "
            f"{drift}). Test base rate runs "
            f"{np.nanmin(base):.3f}-{np.nanmax(base):.3f}, so accuracy is "
            "readable only against the majority column beside it."
        )
        # Judged against each fold's own null standard error rather than
        # a fixed band, because 0.53 on 1,700 rows and 0.53 on 37,000
        # are not the same claim and a constant threshold would call
        # them the same thing.
        z = np.asarray([f.auc_z for f in self.folds], dtype="float64")
        readable = z[np.isfinite(z)]
        if readable.size and np.abs(readable).max() < 2.0:
            headline += (
                " No fold is more than two standard errors from 0.500, which "
                "is a coin flip — this is the measurement, not a bug to be "
                "tuned away."
            )
        elif readable.size:
            loud = int((np.abs(readable) >= 2.0).sum())
            largest = float(readable[np.argmax(np.abs(readable))])
            headline += (
                f" {loud} of {readable.size} folds sit more than two standard "
                f"errors from 0.500 (largest {largest:+.1f}). "
                "Before reading that as signal, check the importance table: a "
                "cross-sectional rank that barely moves for a given name is a "
                "name dummy, and a model that has learned which funds beat the "
                "median over this particular sample has learned the sample."
            )
        if np.isfinite(ics).any():
            headline += (
                f" Mean per-date rank IC {np.nanmean(ics):+.4f}"
                f" across {len(self.folds)} folds."
            )
        beaten = [
            f
            for f in self.folds
            if np.isfinite(f.edge_over_best_feature) and f.edge_over_best_feature <= 0.0
        ]
        if beaten:
            headline += (
                f" In {len(beaten)} of {len(self.folds)} folds a single sorted "
                "column — picked and signed after seeing the fold — matches or "
                "beats the ensemble, so the right comparison is not against "
                "0.500."
            )
        if uniform:
            headline += (
                f" Importance is near-uniform in {uniform} of "
                f"{len(self.folds)} folds: attention spread evenly over the "
                "columns is what fitting noise looks like."
            )
        if not self.recorded:
            headline += (
                " NOT RECORDED IN THE TRIAL LEDGER — every deflated Sharpe "
                "computed after this run is missing a configuration."
            )
        return headline


# -- the run ------------------------------------------------------------


def evaluate(
    plan: SplitPlan,
    X: pd.DataFrame,
    *,
    config: GBMConfig = DEFAULT_CONFIG,
    counter: TrialCounter | None = None,
    timestamp: datetime | date | str | None = None,
    description: str = "",
    keep_predictions: bool = False,
    verify: bool = True,
) -> GBMReport:
    """Fit and score the ensemble over every fold of `plan`.

    The trial is recorded BEFORE the first fit, which is the same
    discipline `run_sleeves.py` follows: a configuration that was
    evaluated and then crashed still counts against the deflation,
    because we still looked. Recording afterwards would let a run that
    disappointed quietly leave no trace.

    `verify` re-runs the split's own leak check here rather than
    trusting that whoever built the plan called it. It is cheap, and a
    purge that is intended is not a purge that has been asked about.
    """
    if not isinstance(plan, SplitPlan):
        raise GBMError(f"expected a SplitPlan, got {type(plan).__name__}")
    labels = plan.labels
    frame = _as_feature_frame(X)
    if len(frame) != labels.n:
        raise GBMError(
            f"{len(frame):,} feature rows against {labels.n:,} labelled rows. "
            "Pass the frame `align_features` returned — slicing positionally "
            "across a mismatch fits the model on scrambled targets"
        )
    if verify:
        plan.verify()

    trial = {**plan.config(), "model": config.as_dict()}
    recorded = False
    if counter is not None:
        if timestamp is None:
            # `util.runs.Trials` reads the clock ONCE for a run and
            # stamps every row with it, because two rows from one
            # invocation a second apart is a small lie about how many
            # sittings a search took. Calling `now()` here would quietly
            # break that for any runner evaluating more than one config.
            raise GBMError(
                "pass the run's timestamp alongside the counter. The clock is "
                "read once per invocation and every trial in the run carries "
                "the same stamp — see util.runs.Trials"
            )
        counter.record(
            config=trial,
            description=(
                description
                or (
                    f"HistGradientBoosting x{config.n_members} bootstrap over "
                    f"{plan.kind}, {len(plan)} folds, horizon "
                    f"{labels.horizon}, threshold {labels.threshold}"
                )
            ),
            timestamp=timestamp,
        )
        recorded = True

    y = labels.y
    forward = labels.forward_return
    row_dates = pd.DatetimeIndex(y.index.get_level_values("date"))

    results: list[FoldResult] = []
    for fold in plan.folds:
        results.append(
            _score_fold(
                fold=fold,
                X=frame,
                y=y,
                forward=forward,
                row_dates=row_dates,
                horizon=labels.horizon,
                config=config,
                keep_predictions=keep_predictions,
            )
        )

    return GBMReport(
        config=config,
        kind=plan.kind,
        horizon=labels.horizon,
        folds=tuple(results),
        recorded=recorded,
        trial_config=trial,
    )


def _score_fold(
    *,
    fold: PanelFold,
    X: pd.DataFrame,
    y: pd.Series,
    forward: pd.Series,
    row_dates: pd.DatetimeIndex,
    horizon: int,
    config: GBMConfig,
    keep_predictions: bool,
) -> FoldResult:
    X_train, X_test = fold.take(X)
    y_train, y_test = fold.take(y)
    # The training fold's realised returns are deliberately not taken:
    # the IC is an out-of-sample statistic and a training-set IC is a
    # description of the fit rather than a measurement of anything.
    _, r_test = fold.take(forward)
    d_train = row_dates[fold.train_rows]
    d_test = row_dates[fold.test_rows]

    model = BaggedGBM(config).fit(X_train, y_train, dates=d_train)
    prediction = model.predict_proba(X_test)
    probability = prediction.mean

    truth = np.asarray(y_test.to_numpy(), dtype="float64")
    auc = _safe_auc(truth, probability)
    auc_se = _auc_standard_error(truth, horizon)
    # A 0.5 cut, because the cross-sectional label's base rate is one
    # half by construction and a threshold chosen to maximise accuracy
    # would be one more parameter fitted on the test fold.
    report = accuracy_report(
        y_test,
        (probability >= 0.5).astype("float64"),
        auc=auc,
        label=f"fold {fold.fold}",
    ).loc[0]

    ic = rank_ic(probability, r_test, d_test, horizon=horizon)
    best_name, best_auc = best_single_feature(X_test, y_test)

    if np.isfinite(auc):
        importance = permutation_importance(
            model,
            X_test,
            y_test,
            d_test,
            repeats=config.importance_repeats,
            seed=int(config.seed) + 1000 + fold.fold,
        )
    else:
        importance = pd.DataFrame(
            columns=["feature", "importance", "importance_std", "note", "share"]
        )

    measured = int(importance["importance"].notna().sum()) if len(importance) else 0
    participation = (
        importance_participation(importance["share"]) if measured else float("nan")
    )
    total = (
        float(importance["importance"].clip(lower=0.0).sum())
        if measured
        else float("nan")
    )
    near_uniform = bool(
        measured >= 2
        and np.isfinite(participation)
        and participation >= NEAR_UNIFORM_FRACTION * measured
    )

    spread = prediction.spread
    verdict = str(report["verdict"])
    if np.isfinite(auc) and np.isfinite(auc_se) and auc_se > 0.0:
        verdict += (
            f", {abs(auc - 0.5) / auc_se:.1f} standard errors from a coin flip"
        )
    if np.isfinite(best_auc) and np.isfinite(auc) and auc <= best_auc:
        verdict += (
            f". Sorting on {best_name} alone scores {best_auc:.3f} on these "
            "same rows, so the ensemble added nothing to one column"
        )
    if near_uniform:
        verdict += (
            f". Importance amounts to {participation:.1f} of {measured} "
            "features, which is a model spreading attention over noise"
        )
    if measured and np.isfinite(total) and total < IMPORTANCE_NOISE_FLOOR:
        verdict += (
            f". No shuffle costs more than {total:.4f} of AUC in total, so "
            "the importance ordering is noise ordering itself"
        )

    return FoldResult(
        fold=fold.fold,
        kind=fold.kind,
        train_start=fold.train_dates[0] if len(fold.train_dates) else pd.NaT,
        train_end=fold.train_dates[-1] if len(fold.train_dates) else pd.NaT,
        test_start=fold.test_dates[0] if len(fold.test_dates) else pd.NaT,
        test_end=fold.test_dates[-1] if len(fold.test_dates) else pd.NaT,
        n_train=fold.n_train,
        n_test=fold.n_test,
        n_train_all_nan=int(X_train.isna().all(axis=1).sum()),
        n_test_all_nan=int(X_test.isna().all(axis=1).sum()),
        train_base_rate=fold.train_base_rate,
        test_base_rate=fold.test_base_rate,
        auc=auc,
        auc_standard_error=auc_se,
        accuracy=float(report["accuracy"]),
        majority_accuracy=float(report["majority_accuracy"]),
        edge=float(report["edge"]),
        edge_standard_error=float(report["edge_standard_error"]),
        ic=ic,
        best_feature=best_name,
        best_feature_auc=best_auc,
        mean_spread=float(np.nanmean(spread)) if spread.size else float("nan"),
        median_spread=float(np.nanmedian(spread)) if spread.size else float("nan"),
        importance=importance,
        importance_participation=participation,
        importance_measured=measured,
        importance_total=total,
        importance_near_uniform=near_uniform,
        verdict=verdict,
        prediction=prediction if keep_predictions else None,
    )


def learning_curve(
    fold: PanelFold,
    X: pd.DataFrame,
    labels: LabelSet,
    *,
    config: GBMConfig = DEFAULT_CONFIG,
    every: int = 10,
) -> pd.DataFrame:
    """Train and test AUC against boosting iteration, for one fold.

    The direct analogue of the video's epoch curve, and the reason it is
    worth computing on a tree model at all: the shape it reported —
    training AUC climbing while validation drifts to 0.50 — is not a
    property of LSTMs, it is what any sufficiently flexible model does
    against a target that is mostly noise. Seeing the same curve here
    settles whether the architecture was ever the issue.

    Fitted on the WHOLE training fold rather than a bootstrap member,
    because this plot is about one model's iterations and mixing the
    resampling variance into it would blur the only line that matters.
    """
    frame = _as_feature_frame(X)
    if len(frame) != labels.n:
        raise GBMError(
            f"{len(frame):,} feature rows against {labels.n:,} labelled rows"
        )
    X_train, X_test = fold.take(frame)
    y_train, y_test = fold.take(labels.y)
    truth_train = np.asarray(y_train.to_numpy(), dtype="float64")
    truth_test = np.asarray(y_test.to_numpy(), dtype="float64")

    model = config.estimator(random_state=int(config.seed)).fit(
        X_train.to_numpy(dtype="float64"), truth_train
    )
    step = max(int(every), 1)

    rows: list[dict[str, Any]] = []
    train_values = X_train.to_numpy(dtype="float64")
    test_values = X_test.to_numpy(dtype="float64")
    staged_train = model.staged_predict_proba(train_values)
    staged_test = model.staged_predict_proba(test_values)
    for i, (ptrain, ptest) in enumerate(zip(staged_train, staged_test), start=1):
        if i % step and i != int(config.max_iter):
            continue
        rows.append(
            {
                "fold": fold.fold,
                "iteration": i,
                "train_auc": _safe_auc(truth_train, ptrain[:, 1]),
                "test_auc": _safe_auc(truth_test, ptest[:, 1]),
            }
        )
    return pd.DataFrame(rows)


# -- plumbing -----------------------------------------------------------


def _as_feature_frame(X: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(X, pd.DataFrame):
        raise GBMError(
            f"features must be a DataFrame, got {type(X).__name__}. A bare "
            "array carries no column names, and the importance table would "
            "then report positions"
        )
    if not len(X.columns):
        raise GBMError("no feature columns")
    if X.columns.has_duplicates:
        raise GBMError("two feature columns share a name")
    return X


def _as_matrix(X: pd.DataFrame | np.ndarray, features: Sequence[str]) -> np.ndarray:
    if isinstance(X, pd.DataFrame):
        names = tuple(str(c) for c in X.columns)
        if names != tuple(features):
            raise GBMError(
                f"this ensemble was fitted on {list(features)} and was handed "
                f"{list(names)}. Reordering here would score every row "
                "against the wrong tree"
            )
        return X.to_numpy(dtype="float64")
    arr = np.asarray(X, dtype="float64")
    if arr.ndim != 2 or arr.shape[1] != len(features):
        raise GBMError(
            f"expected {len(features)} columns, got array of shape {arr.shape}"
        )
    return arr


def _as_binary(y: pd.Series | np.ndarray, n: int) -> np.ndarray:
    arr = np.asarray(pd.Series(y).to_numpy(), dtype="float64").ravel()
    if arr.size != n:
        raise GBMError(f"{arr.size:,} labels against {n:,} feature rows")
    if not np.isin(arr, (0.0, 1.0)).all():
        raise GBMError("labels must be binary 0/1")
    return arr


def _date_codes(dates: Sequence[Any] | pd.Index, n: int) -> np.ndarray:
    """Each row's date as a dense integer code, in chronological order."""
    index = pd.Index(dates)
    if len(index) != n:
        raise GBMError(
            f"{len(index):,} dates for {n:,} rows. Every row must carry the "
            "session it was decided on, or the bootstrap resamples something "
            "other than a cross-section"
        )
    codes, _ = pd.factorize(index, sort=True)
    if (codes < 0).any():
        raise GBMError("a row has no date")
    return np.asarray(codes, dtype=np.int64)


def _rows_by_date(codes: np.ndarray, n_dates: int) -> list[np.ndarray]:
    order = np.argsort(codes, kind="stable")
    boundaries = np.searchsorted(codes[order], np.arange(n_dates + 1))
    return [order[boundaries[d] : boundaries[d + 1]] for d in range(n_dates)]


def _permute_within_date(
    values: np.ndarray, codes: np.ndarray, n_dates: int, rng: np.random.Generator
) -> np.ndarray:
    """Shuffle a column among the rows that share its date.

    Done with two sorts rather than a Python loop over dates: `base` is
    the row positions grouped by date, `order` is the same grouping with
    the members of each group in random order, so assigning one through
    the other permutes strictly inside each date.
    """
    base = np.argsort(codes, kind="stable")
    order = np.lexsort((rng.random(codes.size), codes))
    out = np.empty_like(values)
    out[base] = values[order]
    return out


def _varies_within_date(frame: pd.DataFrame, codes: np.ndarray) -> pd.Series:
    """Which columns have any within-date variation at all.

    The bill rate does not — it is one number a day for every name — so
    a within-date permutation leaves it exactly where it was. Reporting
    that as an importance of zero would be a measurement of the test
    rather than of the feature.
    """
    grouped = frame.groupby(codes, sort=False)
    span = grouped.transform("max") - grouped.transform("min")
    return (span.fillna(0.0).abs() > 0.0).any()


def _auc_standard_error(truth: np.ndarray, horizon: int) -> float:
    """How far from 0.500 an AUC has to be before it is worth reading.

    Under the null the AUC is the Mann-Whitney statistic scaled, whose
    variance is `(n1 + n0 + 1) / (12 n1 n0)`. That is the standard
    error for INDEPENDENT observations, which these are not: a
    21-session label window overlaps its neighbour by twenty, so each
    observation is very nearly the same measurement repeated H times.
    Multiplying the standard deviation by sqrt(H) is the crude
    correction for that and is the same adjustment `RankIC` applies to
    its t-statistic.

    It is still generous, and the size of what it leaves out should be
    stated rather than hoped over: the cross-section is not independent
    either — `labels.effective_sample()` puts twenty-nine of these ETFs
    at about five distinct series — so an honest band is wider than
    this one by roughly another factor of two. A fold inside two of
    THESE standard errors is comfortably inside a coin flip.
    """
    t = np.asarray(truth, dtype="float64").ravel()
    n1 = float((t == 1.0).sum())
    n0 = float((t == 0.0).sum())
    if n1 < 1.0 or n0 < 1.0:
        return float("nan")
    variance = (n1 + n0 + 1.0) / (12.0 * n1 * n0)
    return float(np.sqrt(variance) * np.sqrt(max(int(horizon), 1)))


def _safe_auc(truth: np.ndarray, score: np.ndarray) -> float:
    """ROC AUC, or NaN when the fold has one class.

    NaN rather than 0.5. A single-class fold has no ordering to get
    right and 0.5 would blend into a table of honest coin flips.
    """
    t = np.asarray(truth, dtype="float64").ravel()
    s = np.asarray(score, dtype="float64").ravel()
    if t.size == 0 or np.unique(t).size < 2:
        return float("nan")
    return float(roc_auc_score(t, s))


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Rank correlation, NaN when either side has nothing to rank.

    Ranks then Pearson, rather than a scipy import: the tie handling is
    average-rank in both, and the failure this must not have is
    returning a number for a date where every prediction was identical.
    """
    if a.size < MIN_IC_CROSS_SECTION:
        return float("nan")
    finite = np.isfinite(a) & np.isfinite(b)
    if int(finite.sum()) < MIN_IC_CROSS_SECTION:
        return float("nan")
    ra = pd.Series(a[finite]).rank().to_numpy()
    rb = pd.Series(b[finite]).rank().to_numpy()
    if ra.std() == 0.0 or rb.std() == 0.0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])
