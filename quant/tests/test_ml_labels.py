"""Tests that try to make the label lie and the split leak.

A confirmatory test here would be nearly worthless. Build labels, build
folds, call the same package's own `verify()` and watch it pass — that
passes whether or not anything was purged, because the check and the
split would be wrong together. So every assertion below starts from a
specific row that must be there or must not be, and several of them
would still pass against a splitter that dropped everything, which is
why they are paired with the row that must survive.

Four properties carry most of the weight.

**Truncation.** A label at T claims to use data through the close of
T+H and not one bar more, and the only way to test that claim is to
delete the rest of the file. Building labels on the panel cut off the
day the window closes must produce the identical label; cutting one bar
earlier must make the label DISAPPEAR rather than quietly shorten into
a different question wearing the same column name.

**The base rate is the finding.** The video's 62% accuracy is
reproduced here as a test: predict the majority class on a
`threshold="zero"` label and score the base rate exactly. The same
panel under the cross-sectional label pins the base rate at 0.5 on
every date, which is what makes an accuracy figure readable at all.

**The seam is checked from both sides.** A test that only asserts
"these rows are gone" passes for a purge that removes the whole
training set. Each purge assertion below names the neighbouring
position that must be KEPT.

**The leak check must be capable of failing.** `verify()` passing
proves nothing unless the same call fails when the property is
violated, so the embargo is widened past what was applied and the check
is required to notice.

Everything is synthetic and seeded. No claim here is about a market —
they are all about arithmetic on positions and windows, and a real
price series would make none of them truer.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine import metrics
from griffinquant.ml.labels import (
    DEFAULT_HORIZON,
    LabelError,
    accuracy_report,
    build_labels,
    forward_total_return,
)
from griffinquant.ml.splits import (
    SplitError,
    purged_folds,
    walk_forward_folds,
)
from griffinquant.validation.purged_cv import LeakageError, assert_no_leakage


# -- fixtures -------------------------------------------------------------


def panel(
    n_sessions: int = 600,
    n_assets: int = 4,
    *,
    seed: int = 0,
    drift: float = 0.0004,
    start: str = "2010-01-04",
) -> pd.DataFrame:
    """A wide frame of adjusted closes with a common factor.

    The common factor is the point rather than realism: it is what
    makes the nine-assets-are-not-nine-observations arithmetic in
    `effective_sample` have something to measure, and what makes the
    `zero` label's base rate move from year to year.
    """
    rng = np.random.default_rng(seed)
    cal = pd.bdate_range(start, periods=n_sessions)
    common = rng.normal(drift, 0.009, size=(n_sessions, 1))
    idio = rng.normal(0.0, 0.006, size=(n_sessions, n_assets))
    prices = 100.0 * np.exp(np.cumsum(common + idio, axis=0))
    return pd.DataFrame(
        prices, index=cal, columns=[f"ETF{i}" for i in range(n_assets)]
    )


# -- the base rate, which is the whole point ------------------------------


def test_the_cross_sectional_label_has_a_base_rate_of_exactly_one_half():
    """Not approximately, and not on this seed. By construction.

    An even cross-section puts the median between two observations, so
    nothing sits exactly on the threshold and no row is dropped to get
    here — the halves fall out of the comparison itself.
    """
    labels = build_labels(panel(n_assets=4), horizon=5)

    assert labels.base_rate == 0.5
    assert labels.dropped["tie_at_threshold"] == 0
    assert int(labels.y.sum()) * 2 == labels.n

    by_year = labels.base_rate_by_year()
    assert (by_year["base_rate"] == 0.5).all()

    by_date = labels.y.groupby(level="date").mean()
    assert (by_date == 0.5).all()


def test_an_odd_cross_section_drops_the_median_asset_once_a_date():
    """The tie is real, it is counted, and it is why 0.5 is exact.

    With five assets the median IS one of the observed returns, so one
    row a date sits exactly on the threshold with no label rather than
    a zero. Dropping it is what holds the base rate at one half — and
    it is a small flattery, since the discarded row is the hardest one
    on the date, so the count has to be visible rather than inferred.
    """
    labels = build_labels(panel(n_assets=5), horizon=5)

    assert labels.dropped["tie_at_threshold"] == len(labels.dates)
    assert labels.base_rate == 0.5
    assert (labels.y.groupby(level="date").size() == 4).all()
    assert labels.describe().loc[0, "dropped_tie_at_threshold"] == len(labels.dates)


def test_the_video_result_reproduced_the_majority_class_scores_the_base_rate():
    """62% meant nothing, and this is the arithmetic that shows why.

    Under `threshold="zero"` a drifting panel says yes most of the
    time. A model that always answers yes therefore scores the base
    rate exactly — and `accuracy_report` refuses to print that number
    without the baseline beside it, which is the one line missing from
    the project this reproduces.
    """
    # Six months, which is the horizon the video went out to and the
    # horizon at which "did it go up" stops being close to a coin flip.
    labels = build_labels(panel(n_sessions=2600), horizon=126, threshold="zero")
    assert labels.base_rate > 0.55

    always_yes = np.ones(labels.n)
    report = accuracy_report(labels.y, always_yes, label="always yes")
    row = report.loc[0]

    assert row["accuracy"] == pytest.approx(labels.base_rate)
    assert row["accuracy"] == pytest.approx(row["majority_accuracy"])
    assert row["edge"] == pytest.approx(0.0)
    assert "at or below" in row["verdict"]
    # And the baseline is not optional: it is in the row whether or not
    # the caller thought to ask.
    assert set(["base_rate", "majority_accuracy", "edge"]) <= set(report.columns)


def test_the_zero_labels_base_rate_moves_and_the_cross_sectional_one_does_not():
    """The reason the default threshold is the cross-sectional one.

    A prior that drifts year to year is a target a model can fit from
    anything that hints at the calendar, without knowing a thing about
    an asset. The cross-sectional label has no such handle: its base
    rate is one half in every year of the sample.
    """
    prices = panel(n_sessions=2600)
    absolute = build_labels(prices, threshold="zero").base_rate_by_year()
    relative = build_labels(prices).base_rate_by_year()

    assert absolute["base_rate"].max() - absolute["base_rate"].min() > 0.15
    assert relative["base_rate"].max() == relative["base_rate"].min() == 0.5


def test_accuracy_cannot_be_reported_without_the_truth_to_derive_a_baseline():
    with pytest.raises(TypeError):
        accuracy_report(np.ones(10))  # type: ignore[call-arg]
    with pytest.raises(LabelError, match="not the same observations"):
        accuracy_report(np.ones(10), np.ones(9))
    with pytest.raises(LabelError, match="binary"):
        accuracy_report(np.array([0.0, 0.5, 1.0]), np.ones(3))


def test_a_small_edge_is_named_as_indistinguishable_from_none():
    """The sentence that should have appeared under the video's 62%."""
    truth = np.zeros(400)
    truth[:200] = 1.0
    pred = truth.copy()
    pred[:6] = 0.0  # 98.5%: enormous, and comfortably clear of the noise
    assert "clear of twice" in accuracy_report(truth, pred).loc[0, "verdict"]

    pred = truth.copy()
    pred[:190] = 0.0  # a hair over the coin flip on 400 observations
    verdict = accuracy_report(truth, pred, auc=0.503).loc[0, "verdict"]
    assert "inside twice" in verdict
    assert "coin flip" in verdict


# -- strict causality -----------------------------------------------------


def test_a_label_uses_data_through_T_plus_H_and_not_one_bar_more():
    """Tested by deleting the rest of the file, which is the only way.

    Truncating the panel on the session the window closes must leave
    the label byte for byte identical; truncating one session earlier
    must remove it entirely. A label that survived the second cut would
    be a shorter-horizon label sitting in the same column as the real
    ones, which nothing downstream could see.
    """
    prices = panel(n_sessions=400, n_assets=4)
    h = 5
    t_pos = 200
    t = prices.index[t_pos]

    full = build_labels(prices, horizon=h)
    closed = build_labels(prices.iloc[: t_pos + h + 1], horizon=h)
    short = build_labels(prices.iloc[: t_pos + h], horizon=h)

    for asset in prices.columns:
        assert closed.y.loc[(t, asset)] == full.y.loc[(t, asset)]
        assert closed.forward_return.loc[(t, asset)] == pytest.approx(
            full.forward_return.loc[(t, asset)]
        )
    assert t not in short.dates
    assert short.dates[-1] == prices.index[t_pos - 1]


def test_incomplete_windows_are_dropped_rather_than_shortened():
    prices = panel(n_sessions=300, n_assets=3)
    h = 7
    labels = build_labels(prices, horizon=h)

    assert labels.dates[-1] == prices.index[-1 - h]
    assert labels.dropped["incomplete_window"] == h * prices.shape[1]
    # And the window each date's label closes on is a real session on
    # the price calendar, h bars along — not a calendar-day offset that
    # would land on a Saturday and floor back to the wrong Friday.
    ends = labels.label_end
    for k in (0, 17, len(labels.dates) - 1):
        when = labels.dates[k]
        assert ends.loc[when] == prices.index[prices.index.get_loc(when) + h]


def test_every_priced_cell_is_either_labelled_or_counted_as_dropped():
    prices = panel(n_sessions=500, n_assets=5)
    labels = build_labels(prices, horizon=5)
    priced = int(prices.notna().to_numpy().sum())
    assert labels.n + sum(labels.dropped.values()) == priced


def test_the_forward_return_is_the_ratio_of_two_specific_closes():
    prices = panel(n_sessions=200, n_assets=3)
    fwd = forward_total_return(prices, 5)
    expected = prices.iloc[105, 1] / prices.iloc[100, 1] - 1.0
    assert fwd.iloc[100, 1] == pytest.approx(expected)
    assert fwd.iloc[-5:].isna().to_numpy().all()


# -- the panel a label may be built from ----------------------------------


def test_an_interior_price_gap_is_refused():
    """A window that steps over a hole reports a return nobody earned.

    Leading and trailing gaps are ordinary — a fund that listed in 2007
    has no 2005 — and are allowed. A missing session in the middle of a
    listed span is not a listing fact, and a forward window would
    simply stride across it.
    """
    prices = panel(n_sessions=300, n_assets=3)
    holed = prices.copy()
    holed.iloc[150, 1] = np.nan
    with pytest.raises(LabelError, match="middle of its listed span"):
        build_labels(holed, horizon=5)

    late = panel(n_sessions=300, n_assets=5)
    late.iloc[:100, 2] = np.nan
    labels = build_labels(late, horizon=5)
    early = labels.y.loc[late.index[50]]
    assert "ETF2" not in early.index
    assert len(early) == 4
    assert "ETF2" in labels.y.loc[late.index[150]].index


def test_a_thin_cross_section_is_dropped_rather_than_labelled():
    """Two names are not a cross-section, they are a coin flip."""
    prices = panel(n_sessions=400, n_assets=4)
    thinned = prices.copy()
    thinned.iloc[:120, 2] = np.nan
    thinned.iloc[:120, 3] = np.nan

    labels = build_labels(thinned, horizon=5)
    assert labels.dropped["thin_cross_section"] > 0
    assert prices.index[0] not in labels.dates
    assert (labels.y.groupby(level="date").size() >= 3).all()


def test_a_negative_price_and_an_unsorted_calendar_are_both_refused():
    prices = panel(n_sessions=200, n_assets=3)
    broken = prices.copy()
    broken.iloc[10, 0] = -1.0
    with pytest.raises(LabelError, match="meaningless"):
        build_labels(broken, horizon=5)

    with pytest.raises(LabelError, match="strictly increasing"):
        build_labels(prices.iloc[::-1], horizon=5)


def test_a_horizon_that_leaves_too_few_windows_is_refused():
    """The failure that produces thousands of rows and four observations."""
    prices = panel(n_sessions=300, n_assets=3)
    with pytest.raises(LabelError, match="non-overlapping windows"):
        build_labels(prices, horizon=100)
    with pytest.raises(LabelError, match="at least one session"):
        build_labels(prices, horizon=0)


def test_an_unknown_threshold_names_the_three_that_exist():
    with pytest.raises(LabelError, match="cross_sectional_median"):
        build_labels(panel(n_sessions=200, n_assets=3), horizon=5, threshold="sharpe")


# -- the bill benchmark ---------------------------------------------------


def bill_index(calendar: pd.DatetimeIndex, daily: float = 0.0001) -> pd.Series:
    return pd.Series(100.0 * (1.0 + daily) ** np.arange(len(calendar)), index=calendar)


def test_the_bill_benchmark_is_the_bill_over_the_labels_own_window():
    prices = panel(n_sessions=400, n_assets=4)
    bills = bill_index(prices.index)
    labels = build_labels(prices, horizon=5, threshold="bill", bill_index=bills)

    expected = (1.0 + 0.0001) ** 5 - 1.0
    assert labels.benchmark.to_numpy() == pytest.approx(expected)
    assert labels.base_rate < 0.999  # not a degenerate all-one column


def test_an_asset_that_exactly_matches_the_bill_is_a_tie_not_a_win():
    """`>` and not `>=`: at the threshold the label is undefined.

    Built by making one asset compound at precisely the bill rate, so
    its excess return is exactly zero on every date rather than
    approximately zero on most of them.
    """
    cal = pd.bdate_range("2012-01-02", periods=300)
    daily = 0.0001
    bills = bill_index(cal, daily)
    prices = pd.DataFrame(
        {
            "CASHLIKE": bills.to_numpy(),
            "UP": 100.0 * (1.0 + 0.0005) ** np.arange(len(cal)),
            "DOWN": 100.0 * (1.0 - 0.0002) ** np.arange(len(cal)),
        },
        index=cal,
    )
    labels = build_labels(prices, horizon=5, threshold="bill", bill_index=bills)

    assert labels.dropped["tie_at_threshold"] == len(labels.dates)
    assert "CASHLIKE" not in labels.assets
    assert labels.base_rate == 0.5  # UP wins and DOWN loses, every date


def test_a_rate_in_percent_passed_as_a_bill_index_is_refused():
    """The substitution that produces a clean frame of a single class.

    A 4.5%-a-year rate read as a level makes the threshold about a
    thousand times too high: nothing clears it, the base rate is zero,
    and every column of the resulting frame validates.
    """
    prices = panel(n_sessions=300, n_assets=3)
    rate = pd.Series(
        4.0 + np.sin(np.arange(len(prices.index)) / 40.0), index=prices.index
    )
    with pytest.raises(LabelError, match="annualised RATE"):
        build_labels(prices, horizon=5, threshold="bill", bill_index=rate)

    with pytest.raises(LabelError, match="no level for"):
        build_labels(
            prices,
            horizon=5,
            threshold="bill",
            bill_index=bill_index(prices.index)[:-40],
        )
    with pytest.raises(LabelError, match="Not a rate"):
        build_labels(prices, horizon=5, threshold="bill")


# -- how much evidence there really is ------------------------------------


def test_the_effective_sample_is_a_fraction_of_the_row_count():
    """Rows are not observations, and the gap is the horizon.

    The number matters most at the horizon the video used: a six-month
    label on twenty-one years is forty-odd non-overlapping windows per
    asset, which is the arithmetic behind a validation curve that
    drifts to 0.50 while training climbs.
    """
    prices = panel(n_sessions=2600, n_assets=6)
    monthly = build_labels(prices, horizon=21)
    half_yearly = build_labels(prices, horizon=126)

    assert monthly.n > 14_000
    eff = monthly.effective_sample()
    assert eff.independent_windows == len(monthly.dates) // 21
    assert eff.effective_n < monthly.n / 10
    # The cross-section is capped by the structure of the label itself:
    # one asset's answer is determined by the other five.
    assert eff.effective_assets <= 5.0
    assert "upper bound" in eff.note

    assert half_yearly.effective_sample().independent_windows < 25
    assert half_yearly.effective_sample().effective_n < eff.effective_n / 5


def test_a_correlated_cross_section_counts_for_fewer_than_its_assets():
    """Six ETFs that fall together are not six independent draws."""
    absolute = build_labels(panel(n_sessions=2600, n_assets=6), threshold="zero")
    assert absolute.correlation_dof < 4.0
    assert absolute.effective_sample().effective_assets < 4.0


def test_the_describe_row_carries_the_base_rate_beside_the_count():
    labels = build_labels(panel(n_sessions=800, n_assets=4))
    row = labels.describe().loc[0]
    assert row["base_rate"] == 0.5
    assert row["n"] > 0
    assert row["majority_accuracy"] == 0.5
    # The prior, pinned: one month, for the reasons in the module
    # docstring rather than because it scored better.
    assert row["horizon_sessions"] == DEFAULT_HORIZON == 21
    assert row["threshold"] == "cross_sectional_median"


# -- the splits: the assertion that matters -------------------------------


def labelled(n_sessions: int = 2600, n_assets: int = 4, horizon: int = 21):
    return build_labels(panel(n_sessions=n_sessions, n_assets=n_assets),
                        horizon=horizon)


def test_no_training_labels_window_intersects_any_test_period_or_its_embargo():
    """The test this whole file exists for, over the folds as generated.

    `assert_no_leakage` re-derives the property pairwise from the label
    windows rather than asking the splitter what it purged, and it is
    handed the embargo that was actually applied — checking with less
    than was applied returns a clean report having tested half the
    property, from the one function whose entire job is catching this.
    """
    for plan in (
        purged_folds(labelled(), n_splits=5),
        purged_folds(labelled(horizon=63), n_splits=4),
        walk_forward_folds(labelled(), min_train_years=5),
    ):
        assert len(plan) >= 3
        for fold in plan.folds:
            assert_no_leakage(
                plan.dates,
                fold.train_positions,
                fold.test_positions,
                label_end=plan.label_end,
                embargo_pct=plan.embargo_pct,
                context=f"{plan.kind} fold {fold.fold}",
            )
        plan.verify()
        assert plan.leakage_reports()["clean"].all()


def test_the_leak_check_would_fail_if_the_property_did_not_hold():
    """`verify()` passing means nothing unless it is capable of failing.

    Widening the embargo past what was applied must be noticed, and the
    complaint must name a dated row rather than a count — the false
    alarm is the safe direction precisely because somebody can go and
    look at the row and see the band was drawn wider than the split's.
    """
    plan = purged_folds(labelled(), n_splits=5, embargo_pct=0.01)
    fold = plan.folds[1]

    with pytest.raises(LeakageError, match="embargo"):
        assert_no_leakage(
            plan.dates,
            fold.train_positions,
            fold.test_positions,
            label_end=plan.label_end,
            embargo_pct=0.05,
        )
    # And a training set that simply keeps everything is caught outright.
    with pytest.raises(LeakageError, match="reach into the test fold"):
        assert_no_leakage(
            plan.dates,
            np.arange(len(plan.dates)),
            fold.test_positions,
            label_end=plan.label_end,
            embargo_pct=plan.embargo_pct,
        )


def test_the_contaminated_neighbours_go_and_the_clean_ones_stay():
    """Pinned positions on both seams, so an over-eager purge fails too.

    A test that only asserts "these rows are gone" passes for a
    splitter that drops the entire training set. Each removal below is
    paired with the neighbouring position that must survive it.
    """
    labels = labelled()
    h = labels.horizon
    plan = purged_folds(labels, n_splits=5, embargo_pct=0.01)
    # The position arithmetic below is only legitimate because an even
    # cross-section drops no dates, so a date's position in the split
    # index is its position on the price calendar.
    assert len(plan.dates) == len(labels.calendar) - h

    fold = plan.folds[1]
    train = set(fold.train_positions.tolist())
    first_test = int(fold.test_positions[0])
    span_end = int(fold.test_positions[-1]) + h
    embargo = fold.embargo_bars
    assert embargo >= 1

    # Left seam: a window reaching into the fold goes, one clear of it
    # stays.
    assert first_test - 1 not in train
    assert first_test - h not in train
    assert first_test - h - 1 in train

    # Right seam, which purging on the fold's DATES would have missed
    # entirely: the fold's information span runs h bars past its last
    # test date, and the embargo runs behind that again. Every position
    # from the fold's opening bar to the end of the embargo must be
    # gone, and the very next one must not.
    for p in range(first_test, span_end + embargo + 1):
        assert p not in train
    assert span_end + embargo + 1 in train


def test_a_date_is_never_in_both_sides_of_a_panel_fold():
    """The failure `assert_no_leakage` cannot see, because it is ours.

    A date correctly held out of a test fold and then mapped back into
    it by the row expansion is invisible one layer up, where the fold
    is just an array of positions. Under the cross-sectional label two
    rows on one date were measured against each other, so this is not a
    near miss — it is the answer.
    """
    labels = labelled()
    plan = purged_folds(labels, n_splits=5)
    row_dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))

    for fold in plan.folds:
        assert not set(fold.train_dates) & set(fold.test_dates)
        train_days = set(row_dates[fold.train_rows])
        test_days = set(row_dates[fold.test_rows])
        assert not train_days & test_days
        assert train_days == set(fold.train_dates)
        assert test_days == set(fold.test_dates)
        assert fold.n_train > 0 and fold.n_test > 0


def test_test_folds_tile_the_labelled_dates_exactly_once():
    plan = purged_folds(labelled(), n_splits=5)
    tested = np.concatenate([f.test_positions for f in plan.folds])
    assert sorted(tested.tolist()) == list(range(len(plan.dates)))

    rows = np.concatenate([f.test_rows for f in plan.folds])
    assert sorted(rows.tolist()) == list(range(plan.labels.n))


def test_every_fold_reports_the_base_rate_it_is_measured_against():
    plan = purged_folds(labelled(), n_splits=5)
    frame = plan.describe()
    assert (frame["test_base_rate"] == 0.5).all()
    assert (frame["train_base_rate"] == 0.5).all()
    assert (frame["n_dropped_dates"] > 0).all()
    assert set(["train_base_rate", "test_base_rate", "n_test"]) <= set(frame.columns)

    absolute = purged_folds(
        build_labels(panel(n_sessions=2600), threshold="zero"), n_splits=5
    )
    # The label whose prior moves has folds whose priors move with it,
    # which is exactly the number a fold's accuracy has to be read
    # against.
    spread = absolute.describe()["test_base_rate"]
    assert spread.max() - spread.min() > 0.05


# -- the splits: walking forward ------------------------------------------


def test_walk_forward_trains_only_on_the_past_with_the_window_purged():
    """Expanding, forward, and the seam wider than the label.

    The gap between the last training date and the first test date must
    exceed the horizon, because a training observation exactly h bars
    before the fold has a window closing on the fold's first session.
    """
    labels = labelled()
    h = labels.horizon
    plan = walk_forward_folds(labels, refit_frequency=1, min_train_years=5)
    assert len(plan) >= 4

    for fold in plan.folds:
        assert fold.train_dates[-1] < fold.test_dates[0]
        first_test = int(fold.test_positions[0])
        last_train = int(fold.train_positions[-1])
        assert first_test - last_train > h
        # Exactly the label window is purged: the h dates before the
        # fold, no more and no fewer.
        assert len(fold.dropped_dates) == h
        assert fold.train_dates[0] == plan.dates[0]  # expanding, never rolling

    starts = [f.train_positions.size for f in plan.folds]
    assert starts == sorted(starts)  # the training set only ever grows


def test_the_walk_forward_embargo_is_zero_and_the_check_uses_that_zero():
    """No knob, because there is nothing behind a fold to embargo.

    Under expanding training there is never any training data after a
    test window, so a forward embargo would change the number in the
    report and nothing in the split. `verify()` therefore checks with
    the zero that was applied rather than with the module default,
    which is what "the value passed must match the split" means here.
    """
    plan = walk_forward_folds(labelled(), min_train_years=5)
    assert plan.embargo_pct == 0.0
    assert all(f.embargo_bars == 0 for f in plan.folds)
    plan.verify()
    for fold in plan.folds:
        assert (fold.train_positions < fold.test_positions[0]).all()


def test_an_impossible_schedule_is_refused_in_this_files_own_terms():
    short = build_labels(panel(n_sessions=400, n_assets=4), horizon=5)
    with pytest.raises(SplitError, match="schedule is impossible"):
        walk_forward_folds(short, min_train_years=5)
    with pytest.raises(SplitError, match="cannot make"):
        purged_folds(short, n_splits=400)
    with pytest.raises(SplitError, match="LabelSet"):
        purged_folds(short.y)  # type: ignore[arg-type]


# -- the ledger and the ergonomics ----------------------------------------


def test_the_plan_hashes_as_a_trial_and_the_label_is_part_of_its_identity():
    """Two horizons are two configurations, not one run corrected."""
    monthly = purged_folds(labelled(horizon=21), n_splits=5)
    quarterly = purged_folds(labelled(horizon=63), n_splits=5)
    walked = walk_forward_folds(labelled(horizon=21), min_train_years=5)

    keys = {
        metrics.TrialCounter.hash_config(p.config())
        for p in (monthly, quarterly, walked)
    }
    assert len(keys) == 3
    assert monthly.config()["label"]["threshold"] == "cross_sectional_median"
    assert monthly.config()["split"]["n_splits"] == 5
    assert monthly.config()["label"]["base_rate"] == 0.5


def test_taking_a_fold_out_of_a_frame_refuses_a_mismatched_height():
    """Alignment here would fit the model on scrambled targets.

    And the score it produced would be an AUC near 0.5 — which on this
    project is indistinguishable from the answer we expect to find
    honestly, so it has to raise rather than align.
    """
    labels = labelled()
    plan = purged_folds(labels, n_splits=5)
    fold = plan.folds[0]

    features = pd.DataFrame({"x": np.arange(labels.n, dtype="float64")})
    train, test = fold.take(features)
    assert len(train) == fold.n_train
    assert len(test) == fold.n_test
    assert not set(train.index) & set(test.index)

    with pytest.raises(SplitError, match="same rows in the same order"):
        fold.take(features.iloc[:-1])
