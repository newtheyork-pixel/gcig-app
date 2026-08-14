"""The boosted-tree baseline, held to the things that would let it lie.

The result this model is expected to produce is an AUC of about 0.50,
and that creates a specific testing problem: **0.50 is also what a
completely broken model produces.** A suite that fits noise, sees a coin
flip and calls it a pass would pass just as happily against an ensemble
whose members were fitted on scrambled targets, against a splitter that
handed over the test fold, or against a predict that returned a
constant. So every claim below about noise is paired with a PLANTED
SIGNAL — the same machinery, given a feature that genuinely predicts the
label, has to find it and has to concentrate its importance on it. Only
the pair says anything.

The rest of the file is about the four ways this specific model would
report confidence it does not have.

**Seed ensembling would report zero spread.** The first test measures
that directly: two `HistGradientBoostingClassifier` fits at different
seeds, early stopping off, come back bit-identical. An uncertainty band
built from them would be exactly 0.0 wide on every row and would read as
certainty. The bootstrap is the fix and the test insists it actually
produces dispersion.

**The bootstrap has to resample whole dates.** A row-level resample puts
half a cross-section in and half out, and under a cross-sectional label
the rows on a date were compared against each other's median — so half a
date is a sample of a comparison that was never made. The test records
what each member was fitted on and demands every date arrive whole.

**Permutation importance must not be a measurement of the calendar.**
The shuffle is within-date; a test asserts no value ever crosses a date
boundary, and another asserts that a column with no within-date
variation comes back NaN with a reason rather than a 0.0 that would sit
in the table looking like a finding.

**The rank IC must be per-date.** The pooled version is constructed here
to be positive on data where every single date's correlation is
negative, which is what pooling across a panel buys you: credit for
knowing which year it was.

Everything is synthetic and seeded. Nothing here is a claim about a
market.
"""

from __future__ import annotations

from dataclasses import fields, replace
from datetime import datetime

import numpy as np
import pandas as pd
import pytest
from sklearn.ensemble import HistGradientBoostingClassifier

from griffinquant.engine.metrics import TrialCounter
from griffinquant.ml import gbm as G
from griffinquant.ml.labels import build_labels
from griffinquant.ml.splits import SplitPlan, purged_folds, walk_forward_folds


# -- fixtures -------------------------------------------------------------

#: Small enough that the whole file runs in seconds, large enough that a
#: purged split with three folds has something to purge.
SESSIONS = 900
ASSETS = 6

#: Nothing in this config was chosen by looking at a score. They are the
#: shipped priors shrunk until the suite is quick: fewer members, fewer
#: iterations, a leaf small enough to split a 5,000-row fold at all.
FAST = G.GBMConfig(
    max_iter=30,
    max_leaf_nodes=8,
    min_samples_leaf=50,
    n_members=4,
    importance_repeats=2,
)


def panel(
    n_sessions: int = SESSIONS,
    n_assets: int = ASSETS,
    *,
    seed: int = 0,
    start: str = "2010-01-04",
) -> pd.DataFrame:
    """Adjusted closes with a common factor, as in the labels suite."""
    rng = np.random.default_rng(seed)
    cal = pd.bdate_range(start, periods=n_sessions)
    common = rng.normal(0.0004, 0.009, size=(n_sessions, 1))
    idio = rng.normal(0.0, 0.006, size=(n_sessions, n_assets))
    prices = 100.0 * np.exp(np.cumsum(common + idio, axis=0))
    return pd.DataFrame(prices, index=cal, columns=[f"ETF{i}" for i in range(n_assets)])


def labelled(**kwargs):
    return build_labels(panel(**kwargs), horizon=21)


def noise_features(labels, *, n: int = 5, seed: int = 11) -> pd.DataFrame:
    """A feature frame carrying nothing whatever about the label."""
    rng = np.random.default_rng(seed)
    index = labels.y.index
    data = {f"x{i}": rng.normal(size=labels.n) for i in range(n)}
    frame = pd.DataFrame(
        {
            "date": index.get_level_values("date"),
            "ticker": index.get_level_values("asset"),
            **data,
        }
    )
    return G.align_features(frame, labels, columns=list(data))


def planted_features(labels, *, strength: float = 1.4, seed: int = 12) -> pd.DataFrame:
    """The positive control: one column that really does predict.

    A noisy view of the label itself, which is a leak by construction
    and is exactly the point — if the machinery cannot recover a signal
    that IS the answer plus noise, then its 0.50 on real features says
    nothing about the features.
    """
    rng = np.random.default_rng(seed)
    index = labels.y.index
    truth = labels.y.to_numpy().astype("float64")
    columns = {
        "oracle": strength * (truth - 0.5) + rng.normal(size=labels.n),
        **{f"noise{i}": rng.normal(size=labels.n) for i in range(1, 5)},
    }
    frame = pd.DataFrame(
        {
            "date": index.get_level_values("date"),
            "ticker": index.get_level_values("asset"),
            **columns,
        }
    )
    return G.align_features(frame, labels, columns=list(columns))


# -- the reason the ensemble is bootstrapped ------------------------------


def test_seeds_alone_produce_bit_identical_members():
    """The measurement the module docstring rests on.

    `random_state` on this estimator feeds the binning subsample (only
    above 200,000 rows) and the early-stopping split (off here), so ten
    seeds are one model ten times. A spread built from them would be
    exactly zero on every row and would read as total confidence.
    """
    rng = np.random.default_rng(0)
    X = rng.normal(size=(2000, 5))
    y = (rng.random(2000) < 0.5).astype(int)

    def fit(seed):
        return (
            G.GBMConfig(max_iter=20, min_samples_leaf=20)
            .estimator(random_state=seed)
            .fit(X, y)
            .predict_proba(X)[:, 1]
        )

    assert np.array_equal(fit(0), fit(7))


def test_the_bootstrap_ensemble_actually_disagrees_with_itself():
    """And the disagreement is the whole product."""
    labels = labelled()
    X = noise_features(labels)
    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))

    model = G.BaggedGBM(FAST).fit(X, labels.y, dates=dates)
    prediction = model.predict_proba(X)

    assert prediction.n_members == FAST.n_members
    spread = prediction.spread
    assert np.isfinite(spread).all()
    assert spread.max() > 0.01
    # Members are not merely different, they are differently ordered:
    # if they were one model plus a constant the spread would be flat.
    assert spread.std() > 0.0


def test_early_stopping_is_off_because_its_validation_split_would_leak():
    """sklearn's 'auto' carves the holdout out of the training rows at
    random, which on a panel puts one date on both sides of the seam —
    the exact split `splits.py` exists to prevent, re-introduced inside
    the estimator where no leak check can see it."""
    estimator = G.GBMConfig().estimator(random_state=0)
    assert estimator.early_stopping is False
    assert isinstance(estimator, HistGradientBoostingClassifier)
    # And the default really is the dangerous one, so this is a choice
    # rather than a restatement.
    assert HistGradientBoostingClassifier().early_stopping == "auto"


def test_every_member_is_fitted_on_whole_cross_sections(monkeypatch):
    """A row-level bootstrap would split a date across the seam.

    The label on a date was computed against the median of that date's
    own rows, so a member that saw four of six names on 2011-06-02 was
    fitted on a comparison that never happened.
    """
    labels = labelled(n_assets=ASSETS)
    X = noise_features(labels)
    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    # Encode each row's date in a column so what the estimator was
    # handed can be traced back to a session.
    stamped = X.copy()
    stamped["x0"] = dates.asi8.astype("float64")

    seen: list[np.ndarray] = []

    class Recorder:
        def fit(self, values, target):
            seen.append(np.asarray(values)[:, 0].copy())
            return self

    monkeypatch.setattr(
        G.GBMConfig, "estimator", lambda self, *, random_state: Recorder()
    )
    G.BaggedGBM(FAST).fit(stamped, labels.y, dates=dates)

    per_date = labels.y.groupby(level="date").size()
    assert per_date.nunique() == 1  # the fixture is a balanced panel
    width = int(per_date.iloc[0])

    assert len(seen) == FAST.n_members
    for member in seen:
        counts = pd.Series(member).value_counts()
        assert (counts % width == 0).all()
        # A resample that happened to draw every date exactly once is
        # not a resample; the point is that some dates repeat.
        assert counts.max() > width


# -- noise scores 0.50, and the planted signal is what makes that mean
#    something ------------------------------------------------------------


def test_features_that_carry_nothing_score_a_coin_flip_in_every_fold():
    """The expected result of the whole project, in miniature.

    Reported per fold rather than pooled, because a pooled mean of
    0.47 and 0.53 prints 0.50 and hides that neither fold was 0.50.
    """
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)
    report = G.evaluate(plan, X, config=FAST)

    assert len(report) == 3
    for fold in report:
        assert abs(fold.auc - 0.5) < 0.05
        assert fold.test_base_rate == pytest.approx(0.5)
        # And the accuracy is not readable without the baseline, which
        # is in the same row whether or not anybody asked for it.
        assert fold.majority_accuracy == pytest.approx(0.5)
        assert abs(fold.edge) < 0.05
    assert "coin flip" in report.summary()


def test_a_planted_signal_is_found_which_is_what_makes_the_0_50_readable():
    """Without this test the suite would pass against a broken model."""
    labels = labelled()
    X = planted_features(labels)
    plan = purged_folds(labels, n_splits=3)
    report = G.evaluate(plan, X, config=FAST)

    for fold in report:
        assert fold.auc > 0.65
        assert fold.accuracy > fold.majority_accuracy
        assert fold.ic.mean > 0.0
    assert "coin flip" not in report.summary()


def test_importance_is_near_uniform_on_noise_and_concentrated_on_signal():
    """The diagnostic the source project reported and did not follow up.

    Attention spread evenly over every column is what a model looks
    like when there is nothing to attend to, and the flag has to fire
    in that case and stay quiet in the other or it is decoration.
    """
    labels = labelled()
    plan = purged_folds(labels, n_splits=3)

    noise = G.evaluate(plan, noise_features(labels), config=FAST)
    planted = G.evaluate(plan, planted_features(labels), config=FAST)

    assert sum(f.importance_near_uniform for f in noise) >= 2
    assert not any(f.importance_near_uniform for f in planted)

    for fold in planted:
        top = fold.importance.iloc[0]
        assert top["feature"] == "oracle"
        assert float(top["share"]) > 0.5
        assert fold.importance_participation < 2.0
    # The concentration is a fact about the fold, not about one repeat.
    wide = planted.importances().pivot(
        index="feature", columns="fold", values="importance"
    )
    assert (wide.loc["oracle"] > wide.loc["noise1"]).all()


def test_the_model_is_scored_against_one_sorted_column_not_against_0_500():
    """The bar that makes an AUC of 0.55 worth arguing about.

    The baseline is deliberately unfair — the column is chosen after
    seeing the fold and its sign is flipped if that helps, neither of
    which anybody could do in advance. A model that cannot beat a
    baseline which got to peek has not earned its trees.
    """
    labels = labelled()
    plan = purged_folds(labels, n_splits=3)

    planted = G.evaluate(plan, planted_features(labels), config=FAST)
    for fold in planted:
        assert fold.best_feature == "oracle"
        assert fold.best_feature_auc > 0.6

    noise = G.evaluate(plan, noise_features(labels), config=FAST)
    for fold in noise:
        # Picked in hindsight out of five pure-noise columns, so it
        # clears 0.5 by construction — which is the whole point of
        # making the model beat it rather than beat a coin.
        assert fold.best_feature_auc >= 0.5
        assert fold.best_feature_auc >= fold.auc - 0.05
    assert "single sorted column" in noise.summary()

    # And the column is a real one, not a positional index.
    assert set(noise.frame()["best_feature"]) <= set(noise_features(labels).columns)


def test_the_learning_curve_reproduces_the_videos_shape():
    """Training AUC climbs, test AUC does not. Not an LSTM problem.

    The source project watched validation drift 0.60 to 0.50 across 25
    epochs while training climbed, and read it as something about the
    architecture. It is what any flexible model does against a target
    that is mostly noise, and a boosted tree does it in a few hundred
    iterations.
    """
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)
    curve = G.learning_curve(plan.folds[1], X, labels, config=FAST, every=10)

    assert list(curve.columns) == ["fold", "iteration", "train_auc", "test_auc"]
    assert curve["iteration"].is_monotonic_increasing
    assert curve["train_auc"].iloc[-1] > curve["train_auc"].iloc[0]
    assert curve["train_auc"].iloc[-1] > curve["test_auc"].iloc[-1] + 0.05
    assert abs(curve["test_auc"].iloc[-1] - 0.5) < 0.06


# -- uncertainty ----------------------------------------------------------


def test_a_confident_probability_and_a_wild_one_are_distinguishable():
    """The video's actual contribution, and the reason for the spread."""
    members = np.array(
        [
            [0.55, 0.20, 0.56],
            [0.55, 0.90, 0.54],
            [0.56, 0.30, 0.55],
            [0.54, 0.80, 0.55],
        ]
    )
    prediction = G.EnsemblePrediction(members=members)

    assert prediction.mean[0] == pytest.approx(0.55)
    assert prediction.mean[1] == pytest.approx(0.55)
    assert prediction.spread[1] > 10 * prediction.spread[0]

    picked = prediction.confident(above=0.52, spread_at_most=0.02)
    assert picked.tolist() == [True, False, True]

    frame = prediction.frame()
    assert frame.loc[1, "member_low"] == 0.20
    assert frame.loc[1, "member_high"] == 0.90


def test_one_member_has_an_unmeasured_spread_not_a_zero_one():
    """An uncertainty nobody measured is not an uncertainty of zero."""
    prediction = G.EnsemblePrediction(members=np.array([[0.9, 0.1]]))
    assert np.isnan(prediction.spread).all()
    assert prediction.confident(above=0.5, spread_at_most=1.0).tolist() == [
        False,
        False,
    ]


# -- permutation importance -----------------------------------------------


def test_the_shuffle_never_moves_a_value_to_another_date():
    """A global shuffle would credit the feature with dating the row."""
    codes = np.array([0, 0, 0, 1, 1, 2, 2, 2, 2])
    values = np.arange(codes.size, dtype="float64")
    rng = np.random.default_rng(3)

    moved = np.zeros(codes.size, dtype=bool)
    for _ in range(30):
        out = G._permute_within_date(values, codes, 3, rng)
        for group in np.unique(codes):
            rows = codes == group
            assert sorted(out[rows]) == sorted(values[rows])
        moved |= out != values
    # And it does shuffle: a permutation that never moved anything
    # would pass the assertion above trivially.
    assert moved.any()


def test_a_column_constant_within_a_date_is_unmeasured_not_unimportant():
    """The bill rate is one number a day for every name.

    A within-date shuffle cannot touch it, so its AUC drop is zero by
    construction — and a 0.0 sitting in the importance table beside
    measured values reads as a finding about the feature rather than
    about the test.
    """
    labels = labelled()
    X = planted_features(labels)
    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    X = X.assign(regime=dates.year.astype("float64"))

    model = G.BaggedGBM(FAST).fit(X, labels.y, dates=dates)
    table = G.permutation_importance(
        model, X, labels.y, dates, repeats=1, seed=5
    ).set_index("feature")

    assert np.isnan(table.loc["regime", "importance"])
    assert "cannot move it" in table.loc["regime", "note"]
    assert np.isfinite(table.loc["oracle", "importance"])
    assert table.loc["oracle", "note"] == ""


def test_participation_says_how_many_features_the_attention_amounts_to():
    assert G.importance_participation(pd.Series([0.25] * 4)) == pytest.approx(4.0)
    assert G.importance_participation(pd.Series([1.0, 0.0, 0.0, 0.0])) == pytest.approx(
        1.0
    )
    assert np.isnan(G.importance_participation(pd.Series([0.0, 0.0])))
    assert np.isnan(G.importance_participation(pd.Series([np.nan, np.nan])))


# -- the rank IC ----------------------------------------------------------


def test_the_ic_is_taken_within_a_date_because_pooling_pays_for_the_calendar():
    """Constructed so pooled and per-date disagree in SIGN.

    Every date here is ranked backwards — the model's highest
    probability goes to the worst performer — but the good year has
    both higher probabilities and higher returns than the bad year, so
    a pooled Spearman comes back positive. A model scored that way is
    being paid for knowing which year it is.
    """
    dates = pd.to_datetime(["2010-01-04"] * 4 + ["2020-01-06"] * 4)
    probability = np.array([0.10, 0.11, 0.12, 0.13, 0.90, 0.91, 0.92, 0.93])
    forward = np.array([0.04, 0.03, 0.02, 0.01, 0.14, 0.13, 0.12, 0.11])

    ic = G.rank_ic(probability, forward, dates, horizon=21)

    assert ic.n_dates == 2
    assert ic.mean == pytest.approx(-1.0)
    assert ic.pooled > 0.5
    assert ic.horizon == 21


def test_the_overlap_adjustment_shrinks_the_t_statistic_by_root_h():
    """Daily ICs off 21-session windows are one measurement, 21 times."""
    rng = np.random.default_rng(4)
    n_dates, width = 300, 8
    dates = np.repeat(pd.bdate_range("2015-01-05", periods=n_dates), width)
    probability = rng.normal(size=n_dates * width)
    forward = 0.5 * probability + rng.normal(size=n_dates * width)

    ic = G.rank_ic(probability, forward, dates, horizon=21)
    assert ic.mean > 0.2
    assert ic.t_stat > 0.0
    assert ic.t_stat_overlap_adjusted == pytest.approx(ic.t_stat / np.sqrt(21))


def test_a_date_with_no_cross_section_contributes_nothing_rather_than_zero():
    dates = pd.to_datetime(
        ["2010-01-04", "2010-01-04", "2010-01-05"] + ["2010-01-06"] * 3
    )
    ic = G.rank_ic(
        np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
        np.array([0.01, 0.02, 0.03, 0.03, 0.02, 0.01]),
        dates,
    )
    # Only the three-name date is measurable; the two-name and one-name
    # dates are dropped rather than scored as zero correlation.
    assert ic.n_dates == 1
    assert ic.mean == pytest.approx(-1.0)


# -- alignment, which is where a silent disaster lives --------------------


def test_alignment_puts_the_features_in_the_labels_own_order():
    """A right-height frame in the wrong order fits scrambled targets.

    And the score it produces is an AUC near 0.50, which on this
    project is indistinguishable from the honest answer — so the order
    is established once, here, rather than checked downstream.
    """
    labels = labelled()
    index = labels.y.index
    frame = pd.DataFrame(
        {
            "date": index.get_level_values("date"),
            "ticker": index.get_level_values("asset"),
            "x": np.arange(labels.n, dtype="float64"),
        }
    )
    scrambled = frame.sample(frac=1.0, random_state=7).reset_index(drop=True)

    aligned = G.align_features(scrambled, labels, columns=["x"])
    assert aligned.index.equals(labels.y.index)
    assert aligned["x"].to_numpy().tolist() == frame["x"].to_numpy().tolist()


def test_a_labelled_row_with_no_features_is_a_refusal_not_a_row_of_nan():
    labels = labelled()
    index = labels.y.index
    frame = pd.DataFrame(
        {
            "date": index.get_level_values("date"),
            "ticker": index.get_level_values("asset"),
            "x": np.zeros(labels.n),
        }
    )
    with pytest.raises(G.GBMError, match="have no features"):
        G.align_features(frame.iloc[1:], labels, columns=["x"])

    doubled = pd.concat([frame, frame.iloc[:1]], ignore_index=True)
    with pytest.raises(G.GBMError, match="duplicate"):
        G.align_features(doubled, labels, columns=["x"])

    infinite = frame.copy()
    infinite.loc[0, "x"] = np.inf
    with pytest.raises(G.GBMError, match="infinite"):
        G.align_features(infinite, labels, columns=["x"])


def test_a_column_that_is_missing_everywhere_is_named_rather_than_crashing():
    """`build_features` emits an all-NaN bill rate when no rate is passed.

    The estimator's own message for that is "window shape cannot be
    larger than input array shape", raised three libraries down, and it
    names neither the column nor the cause.
    """
    labels = labelled()
    X = noise_features(labels).assign(bill_rate=np.nan)
    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))

    with pytest.raises(G.GBMError, match="carry no value at all"):
        G.BaggedGBM(FAST).fit(X, labels.y, dates=dates)


def test_evaluate_refuses_a_frame_of_the_wrong_height():
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)
    with pytest.raises(G.GBMError, match="feature rows against"):
        G.evaluate(plan, X.iloc[:-1], config=FAST)


def test_predicting_with_reordered_columns_is_refused():
    labels = labelled()
    X = noise_features(labels, n=3)
    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    model = G.BaggedGBM(FAST).fit(X, labels.y, dates=dates)

    with pytest.raises(G.GBMError, match="fitted on"):
        model.predict_proba(X.loc[:, list(X.columns)[::-1]])


# -- the ledger, and the run's own paperwork ------------------------------


def test_every_configuration_lands_in_the_trial_ledger(tmp_path):
    """An unlogged trial makes every later deflated Sharpe too generous."""
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)
    counter = TrialCounter(tmp_path / "trials.jsonl")

    report = G.evaluate(
        plan,
        X,
        config=FAST,
        counter=counter,
        timestamp=datetime(2026, 8, 2, 12, 0, 0),
    )
    assert report.recorded is True
    assert counter.count() == 1
    assert "HistGradientBoosting" in counter.records()[0].description

    # A different model configuration is a different trial, and so is a
    # different split scheme over the same model.
    G.evaluate(
        plan,
        X,
        config=replace(FAST, max_leaf_nodes=16),
        counter=counter,
        timestamp=datetime(2026, 8, 2, 12, 1, 0),
    )
    G.evaluate(
        walk_forward_folds(labels, min_train_years=2),
        X,
        config=FAST,
        counter=counter,
        timestamp=datetime(2026, 8, 2, 12, 2, 0),
    )
    assert counter.distinct_count() == 3

    # And the clock is the caller's, read once for the run — see
    # `util.runs.Trials`. Two rows from one invocation stamped a second
    # apart is a small lie about how many sittings a search took.
    with pytest.raises(G.GBMError, match="read once per invocation"):
        G.evaluate(plan, X, config=FAST, counter=counter)


def test_an_unlogged_run_says_so_in_its_own_summary():
    labels = labelled()
    report = G.evaluate(
        purged_folds(labels, n_splits=3), noise_features(labels), config=FAST
    )
    assert report.recorded is False
    assert "NOT RECORDED IN THE TRIAL LEDGER" in report.summary()


def test_the_trial_is_recorded_before_the_first_fit(tmp_path, monkeypatch):
    """A configuration that crashed was still a configuration we tried."""
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)
    counter = TrialCounter(tmp_path / "trials.jsonl")

    def explode(self, *args, **kwargs):
        raise RuntimeError("the fit fell over")

    monkeypatch.setattr(G.BaggedGBM, "fit", explode)
    with pytest.raises(RuntimeError):
        G.evaluate(
            plan,
            X,
            config=FAST,
            counter=counter,
            timestamp=datetime(2026, 8, 2, 12, 0, 0),
        )
    assert counter.count() == 1


def test_evaluate_re_runs_the_splits_own_leak_check():
    """A purge that is intended is not a purge that has been asked about."""
    labels = labelled()
    X = noise_features(labels)
    plan = purged_folds(labels, n_splits=3)

    class LoudPlan(SplitPlan):
        def verify(self) -> None:
            raise AssertionError("verify ran")

    loud = LoudPlan(**{f.name: getattr(plan, f.name) for f in fields(plan)})
    with pytest.raises(AssertionError, match="verify ran"):
        G.evaluate(loud, X, config=FAST)
    # And it can be turned off deliberately, which is not the default.
    G.evaluate(loud, X, config=FAST, verify=False)


# -- reporting surfaces ---------------------------------------------------


def test_no_reporting_surface_shows_an_accuracy_without_its_baseline():
    labels = labelled()
    report = G.evaluate(
        purged_folds(labels, n_splits=3), noise_features(labels), config=FAST
    )
    trajectory = report.trajectory()
    assert "accuracy" in trajectory.columns
    assert "majority_accuracy" in trajectory.columns
    assert "test_base_rate" in trajectory.columns
    # The per-fold verdict is the sentence the video was missing.
    for fold in report:
        assert "constant baseline" in fold.verdict or "at or below" in fold.verdict


def test_the_trajectory_is_per_fold_and_the_summary_names_the_drift():
    labels = labelled()
    report = G.evaluate(
        purged_folds(labels, n_splits=3), noise_features(labels), config=FAST
    )
    assert len(report.trajectory()) == 3
    assert report.trajectory()["fold"].tolist() == [1, 2, 3]
    summary = report.summary()
    assert "first fold" in summary and "last" in summary
    assert f"{report.aucs[0]:.3f}" in summary
    assert f"{report.aucs[-1]:.3f}" in summary


def test_a_single_class_fold_gets_no_auc_rather_than_a_half():
    """0.5 there would blend into a table of honest coin flips."""
    truth = np.zeros(50)
    assert np.isnan(G._safe_auc(truth, np.linspace(0, 1, 50)))
    truth[:25] = 1.0
    assert G._safe_auc(truth, truth) == 1.0


# -- the config is a prior, and says so -----------------------------------


def test_the_shipped_hyperparameters_are_the_round_numbers_written_down():
    """If one of these ever moves, it was tuned, and it owes the ledger."""
    config = G.GBMConfig()
    assert config.learning_rate == 0.05
    assert config.max_iter == 200
    assert config.max_leaf_nodes == 8
    assert config.min_samples_leaf == 200
    assert config.l2_regularization == 1.0
    assert config.n_members == 10
    assert config.as_dict()["ensemble"] == "date_block_bootstrap"


def test_a_config_that_cannot_learn_anything_is_refused():
    with pytest.raises(G.GBMError, match="stump"):
        G.GBMConfig(max_leaf_nodes=1)
    with pytest.raises(G.GBMError, match="learning_rate"):
        G.GBMConfig(learning_rate=0.0)
    with pytest.raises(G.GBMError, match="at least 1"):
        G.GBMConfig(n_members=0)
