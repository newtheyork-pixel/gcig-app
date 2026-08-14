"""Tests that try to make the splitter leak, rather than watching it not.

A confirmatory test of a purge is close to worthless. Build a fold, ask
the splitter for a train set, hand both to the same file's own leak
check and watch it come back clean — that passes whether or not the
purge ran, because the check and the split would be wrong together. So
every test here starts from a specific contaminated row and asks
whether the machinery removes THAT row: a label window that plainly
reaches into the fold, a bar on the right-hand seam whose date is
outside the test period but whose information is not, and a bar that no
purge can reach at all and only the embargo stands between.

Three properties are worth more than the rest.

**The seam is checked from both sides.** Purging on the fold's dates
removes the left-hand offenders and leaves the right-hand ones, which
is the failure wearing the costume of the fix; the fixtures below pin
the exact positions that must go on each side and the exact positions
that must stay, so an over-eager purge fails here as loudly as an
absent one. A test that only asserts "these rows are gone" passes for a
splitter that drops everything.

**The embargo is tested where the purge cannot help.** With a zero
horizon nothing on the right of a fold is purged at all, so the bar
immediately after it is in the training set unless the embargo takes
it. That is the one arrangement in which the embargo is load-bearing,
and it is the arrangement used.

**Zero horizon and zero embargo must degenerate to plain k-fold.** The
cost of purging is real data, and a splitter that quietly spends some
of it when nothing was asked for is a splitter whose train sets nobody
can reason about. The degenerate case is asserted against
`np.array_split`, which is the definition rather than a second opinion.

Everything is synthetic and seedless — the fixtures are integer
positions on a business-day index, because every claim in this file is
about arithmetic on positions and no price series would make it truer.
"""

from __future__ import annotations

import inspect
import math

import numpy as np
import pandas as pd
import pytest

from griffinquant.validation.purged_cv import (
    DEFAULT_EMBARGO_PCT,
    MAX_COMBINATORIAL_SPLITS,
    CombinatorialPurgedCV,
    LeakageError,
    PurgedCVError,
    PurgedKFold,
    _embargo_size,
    assert_no_leakage,
    check_leakage,
    label_end_times,
)


def sessions(n: int, start: str = "2010-01-04") -> pd.DatetimeIndex:
    return pd.bdate_range(start, periods=n)


def folds_of(cv, index, **kwargs) -> list[tuple[set[int], set[int]]]:
    """Splits as sets of positions, which is how the assertions read."""
    return [
        (set(train.tolist()), set(test.tolist()))
        for train, test in cv.split(index, **kwargs)
    ]


# -- the degenerate case --------------------------------------------------


def test_zero_horizon_and_zero_embargo_is_ordinary_kfold():
    """Nothing asked for, nothing spent.

    Asserted against `np.array_split` rather than against another
    implementation of the same idea: contiguous blocks in time order,
    train is the exact complement, and not one row is dropped on the
    way. A purge that costs data when the horizon is zero is a purge
    nobody can budget for.
    """
    idx = sessions(100)
    cv = PurgedKFold(n_splits=5, label_horizon=0, embargo_pct=0.0)
    expected = [set(b.tolist()) for b in np.array_split(np.arange(100), 5)]
    everything = set(range(100))

    got = folds_of(cv, idx)
    assert [test for _, test in got] == expected
    for train, test in got:
        assert train == everything - test
        assert not train & test

    plan = cv.describe(idx)
    assert (plan["n_purged"] == 0).all()
    assert (plan["n_embargoed"] == 0).all()
    assert (plan["embargo_bars"] == 0).all()
    assert (plan["n_train"] + plan["n_test"] == 100).all()
    assert plan["n_test"].sum() == 100

    # And the independent check agrees there was nothing to purge.
    cv.verify(idx)


def test_every_observation_is_tested_exactly_once():
    idx = sessions(97)
    cv = PurgedKFold(n_splits=7, label_horizon=10, embargo_pct=0.02)
    tested = [t for _, t in folds_of(cv, idx)]
    assert sum(len(t) for t in tested) == 97
    assert set().union(*tested) == set(range(97))


# -- the purge, from a contaminated row ------------------------------------


def test_a_label_window_that_reaches_into_the_fold_is_purged():
    """The left-hand seam, pinned to the bar.

    Position 45 carries a five-bar label through position 50, which is
    the fold's first test observation — it has been partly answered
    before the model sees it. Position 44's label stops at 49 and is
    therefore clean. Both halves are asserted: the purge has to be
    exactly five bars deep, not four and not the whole month.
    """
    idx = sessions(100)
    ends = label_end_times(idx, label_horizon=5)
    cv = PurgedKFold(n_splits=2, label_horizon=5, embargo_pct=0.0)
    train, test = folds_of(cv, idx)[1]

    assert min(test) == 50
    for i in range(45, 50):
        assert ends.iloc[i] >= idx[50], "fixture wrong: this window is clean"
        assert i not in train, f"position {i} leaks into the fold and survived"
    assert ends.iloc[44] < idx[50]
    assert 44 in train, "the purge went a bar deeper than the label does"


def test_the_bar_after_the_fold_leaks_even_though_its_date_does_not():
    """The right-hand seam — the version of this bug that survives a fix.

    Test observation 49 carries a label through position 54. Training
    observation 50 is dated outside the test period entirely, and its
    own label window [50, 55] overlaps that one, so it has seen part of
    the fold's answer. A purge written against the fold's DATES leaves
    exactly these five rows standing and looks correct doing it.
    """
    idx = sessions(100)
    cv = PurgedKFold(n_splits=2, label_horizon=5, embargo_pct=0.0)
    train, test = folds_of(cv, idx)[0]

    assert max(test) == 49
    for i in range(50, 55):
        assert i not in train, f"position {i} is past the fold's dates, not its labels"
    assert 55 in train

    # What a date-only purge would have produced, put to the check that
    # derives its answer from the definition rather than from the split.
    date_only = np.arange(50, 100)
    report = check_leakage(idx, date_only, np.arange(0, 50), label_horizon=5)
    assert not report.clean
    assert report.overlapping.tolist() == [50, 51, 52, 53, 54]
    assert "reach into the test fold" in report.message
    with pytest.raises(LeakageError, match=str(idx[50].date())):
        assert_no_leakage(idx, date_only, np.arange(0, 50), label_horizon=5)


def test_the_reported_span_end_is_past_the_last_test_date():
    idx = sessions(100)
    plan = PurgedKFold(2, label_horizon=5, embargo_pct=0.0).describe(idx)
    assert plan.loc[0, "test_end"] == idx[49]
    assert plan.loc[0, "label_span_end"] == idx[54]
    # The first fold has no left seam — nothing precedes position 0 — so
    # the five rows are all on the side a date-based purge would miss.
    assert plan.loc[0, "n_purged"] == 5
    assert plan.loc[1, "n_purged"] == 5


def test_uneven_label_windows_are_purged_one_by_one():
    """A triple-barrier label does not end a fixed number of bars out.

    Alternating one- and nine-bar windows, so a single depth cannot be
    right for both: the retained set is derived from the windows
    themselves and compared exactly, which fails for any splitter that
    purges a constant distance.
    """
    idx = sessions(50)
    reach = np.where(np.arange(50) % 2 == 0, 1, 9)
    ends = pd.Series(idx[np.minimum(np.arange(50) + reach, 49)], index=idx)

    cv = PurgedKFold(2, label_horizon=0, embargo_pct=0.0)
    train, test = folds_of(cv, idx, label_end=ends)[1]

    assert min(test) == 25
    assert train == {i for i in range(25) if ends.iloc[i] < idx[25]}
    assert {17, 19, 21, 23, 24}.isdisjoint(train)
    assert {16, 18, 20, 22} <= train
    cv.verify(idx, label_end=ends)


# -- the embargo, where nothing else can save it ---------------------------


def test_the_embargo_is_the_only_thing_holding_the_next_bar_out():
    """Zero horizon: the purge cannot reach past the fold at all.

    With no label window there is nothing on the right of the fold to
    purge, so position 50 sits in the training set on merit. Its
    features are still built from trailing windows that reach into the
    test period, and the embargo is the entire mechanism that removes
    it. Both runs are asserted, because the second is only meaningful
    against the first.
    """
    idx = sessions(100)
    naked, _ = folds_of(PurgedKFold(2, label_horizon=0, embargo_pct=0.0), idx)[0]
    assert 50 in naked, "fixture wrong: something else already removed this bar"

    cv = PurgedKFold(2, label_horizon=0, embargo_pct=0.05)
    guarded, _ = folds_of(cv, idx)[0]
    assert set(range(50, 55)).isdisjoint(guarded)
    assert 55 in guarded

    plan = cv.describe(idx)
    assert plan.loc[0, "embargo_bars"] == 5
    assert plan.loc[0, "n_purged"] == 0
    assert plan.loc[0, "n_embargoed"] == 5

    # The same split put to the independent check, which knows nothing
    # about how the band was drawn.
    report = check_leakage(
        idx, np.asarray(sorted(naked)), np.arange(0, 50),
        label_horizon=0, embargo_pct=0.05,
    )
    assert not report.clean
    assert report.inside_embargo.tolist() == [50, 51, 52, 53, 54]
    assert "inside the 5-bar embargo" in report.message


def test_the_embargo_starts_where_the_labels_stop_not_where_the_dates_do():
    """Otherwise the first h bars of the band are spent twice.

    The fold's dates end at 49 and its labels reach 54. The purge takes
    50-54; the embargo then has to run 55-59, or a five-bar embargo
    buys nothing at all while the report still calls it five.
    """
    idx = sessions(100)
    cv = PurgedKFold(2, label_horizon=5, embargo_pct=0.05)
    train, _ = folds_of(cv, idx)[0]
    assert set(range(50, 60)).isdisjoint(train)
    assert 60 in train

    plan = cv.describe(idx)
    assert plan.loc[0, "n_purged"] == 5
    assert plan.loc[0, "n_embargoed"] == 5


def test_a_requested_embargo_never_rounds_down_to_nothing():
    """1% of sixty bars is 0.6, and 0.6 bars of embargo is one bar.

    Truncating would leave a split described as embargoed that is not,
    which is worse than declining to embargo — the report would be
    wrong rather than merely modest.
    """
    assert _embargo_size(60, 0.01) == 1
    assert _embargo_size(10, 0.001) == 1
    assert _embargo_size(1000, 0.0) == 0
    assert _embargo_size(1000, DEFAULT_EMBARGO_PCT) == 10

    plan = PurgedKFold(3, label_horizon=0).describe(sessions(60))
    assert (plan["embargo_bars"] == 1).all()


def test_the_embargo_is_a_fraction_of_the_sample_and_not_of_a_fold():
    """Lopez de Prado's convention, and the one that surprises people."""
    idx = sessions(1000)
    plan = PurgedKFold(10, label_horizon=0, embargo_pct=0.01).describe(idx)
    assert (plan["embargo_bars"] == 10).all()
    # A tenth of a fold, not a hundredth: the fold is a hundred bars.
    assert plan.loc[0, "n_embargoed"] == 10


def test_purged_and_embargoed_rows_are_counted_once_each():
    """Attribution, not logic — but a bill that double-counts is a bill
    nobody can read. If the embargo were credited with rows the purge
    already took it would look like it was doing work it was not."""
    idx = sessions(200)
    cv = PurgedKFold(4, label_horizon=8, embargo_pct=0.03)
    plan = cv.describe(idx)
    for row, (train, test) in zip(plan.itertuples(), folds_of(cv, idx)):
        assert row.n_train + row.n_test + row.n_purged + row.n_embargoed == 200
        assert len(train) == row.n_train


# -- the check derives its own answer --------------------------------------


def test_the_splitter_survives_the_check_it_did_not_write():
    """`verify` is the whole file's one honest self-assessment: the
    check reproduces the definition pairwise rather than reusing the
    interval arithmetic the split was built from."""
    idx = sessions(500)
    for horizon in (0, 1, 21, 60):
        for embargo in (0.0, 0.01, 0.05):
            PurgedKFold(5, label_horizon=horizon, embargo_pct=embargo).verify(idx)


def test_the_checker_defaults_to_the_embargo_the_splitters_default_to():
    """The foot-gun on the one function whose job is catching leakage.

    A caller with a default-constructed split hands train and test to the
    documented public checker without repeating the embargo, and a
    checker defaulting to zero tests half the property and reports clean.
    That is a false clearance, and it is byte-for-byte identical to a
    real one. The opposite mistake — checking with more embargo than was
    applied — raises a false alarm that costs a minute at a dated row,
    which is why the asymmetry decides the default rather than
    tidiness does.

    Zero horizon throughout, so the purge cannot reach past the fold and
    the embargo is the only thing separating the two sets.
    """
    idx = sessions(200)
    guarded, _ = folds_of(PurgedKFold(2, label_horizon=0), idx)[0]
    naked, test = folds_of(PurgedKFold(2, label_horizon=0, embargo_pct=0.0), idx)[0]
    assert naked - guarded == {100, 101}, "fixture wrong: the default took nothing"

    train = np.asarray(sorted(naked))
    fold = np.asarray(sorted(test))
    report = check_leakage(idx, train, fold, label_horizon=0)
    assert not report.clean
    assert report.inside_embargo.tolist() == [100, 101]
    assert report.embargo_size == _embargo_size(200, DEFAULT_EMBARGO_PCT) == 2
    with pytest.raises(LeakageError, match="inside the 2-bar embargo"):
        assert_no_leakage(idx, train, fold, label_horizon=0)

    # And a split genuinely made without one still clears, because the
    # caller had to type the zero to get it.
    assert check_leakage(idx, train, fold, label_horizon=0, embargo_pct=0.0).clean

    # The split the default splitter actually produces survives its own
    # default, which is the property the two defaults agreeing buys.
    assert check_leakage(
        idx, np.asarray(sorted(guarded)), fold, label_horizon=0
    ).clean


def test_a_clean_report_still_says_something():
    """A verification that prints nothing when it passes cannot be told
    from one that never ran."""
    idx = sessions(100)
    train, test = next(PurgedKFold(2, 5, 0.01).split(idx))
    report = check_leakage(
        idx, train, test, label_horizon=5, embargo_pct=0.01, context="fold 1 of 2"
    )
    assert report.clean
    assert report.message.startswith("fold 1 of 2: clean")
    assert report.n_train == len(train)
    assert report.n_test == len(test)


def test_the_check_needs_exactly_one_definition_of_the_label():
    idx = sessions(50)
    with pytest.raises(PurgedCVError, match="exactly one"):
        check_leakage(idx, np.arange(0, 25), np.arange(25, 50))
    with pytest.raises(PurgedCVError, match="exactly one"):
        check_leakage(
            idx,
            np.arange(0, 25),
            np.arange(25, 50),
            label_horizon=5,
            label_end=label_end_times(idx, label_horizon=5),
        )


def test_a_leak_is_reported_with_a_row_somebody_can_go_and_look_at():
    idx = sessions(100)
    with pytest.raises(LeakageError) as exc:
        assert_no_leakage(
            idx, np.arange(0, 50), np.arange(48, 100), label_horizon=5, context="fold 2"
        )
    message = str(exc.value)
    assert message.startswith("fold 2: ")
    assert str(idx[43].date()) in message  # the first offender, by date


# -- the combinatorial variant -----------------------------------------------


def test_combinatorial_split_and_path_counts_are_the_binomials():
    cv = CombinatorialPurgedCV(n_groups=6, n_test_groups=2, label_horizon=3)
    assert cv.n_splits == math.comb(6, 2) == 15
    assert cv.n_paths == math.comb(5, 1) == 5
    assert cv.get_n_splits() == 15
    assert len(list(cv.split(sessions(300)))) == 15


def test_adjacent_test_groups_merge_into_one_block():
    """Two groups that happen to be neighbours are one test period.

    Treating them as two would leave the boundary between them looking
    like trainable ground, and there is no such ground — it is the
    middle of the fold.
    """
    idx = sessions(120)
    cv = CombinatorialPurgedCV(n_groups=6, n_test_groups=2, label_horizon=3)
    plan = cv.describe(idx)
    assert plan.loc[0, "n_blocks"] == 1  # groups (0, 1), adjacent
    assert plan.loc[1, "n_blocks"] == 2  # groups (0, 2), apart
    cv.verify(idx)


def test_a_multi_block_test_set_is_purged_at_every_seam():
    idx = sessions(120)
    cv = CombinatorialPurgedCV(6, 2, label_horizon=3, embargo_pct=0.0)
    train, test = folds_of(cv, idx)[1]  # groups 0 and 2: 0-19 and 40-59
    assert min(test) == 0 and max(test) == 59
    # Both seams of the second block, and the right seam of the first.
    assert set(range(20, 23)).isdisjoint(train)
    assert set(range(37, 40)).isdisjoint(train)
    assert set(range(60, 63)).isdisjoint(train)
    assert {23, 36, 63} <= train


def test_a_search_that_would_run_until_tuesday_is_refused():
    with pytest.raises(PurgedCVError, match="splits, and each one is a model fit"):
        CombinatorialPurgedCV(n_groups=30, n_test_groups=15, label_horizon=5)
    assert math.comb(30, 15) > MAX_COMBINATORIAL_SPLITS


# -- refusals ---------------------------------------------------------------


def test_nothing_here_offers_to_shuffle():
    """Shuffling scatters every fold across the sample and multiplies
    the seams a purge has to close by roughly the fold size. The
    argument is absent rather than defaulted to False, so a caller who
    wants it has to come here and read why."""
    for cls in (PurgedKFold, CombinatorialPurgedCV):
        assert "shuffle" not in inspect.signature(cls.__init__).parameters


def test_an_integer_index_cannot_say_when_a_label_ended():
    with pytest.raises(PurgedCVError, match="DatetimeIndex"):
        list(PurgedKFold(2, 5).split(pd.RangeIndex(100)))


def test_an_unsorted_index_makes_folds_that_only_look_contiguous():
    idx = sessions(50)
    scrambled = pd.DatetimeIndex(idx.to_numpy()[::-1])
    with pytest.raises(PurgedCVError, match="strictly increasing"):
        list(PurgedKFold(2, 5).split(scrambled))
    with pytest.raises(PurgedCVError, match="strictly increasing"):
        list(PurgedKFold(2, 5).split(idx.append(pd.DatetimeIndex([idx[-1]]))))


def test_a_label_that_resolves_before_its_own_observation_is_a_bug_upstream():
    idx = sessions(50)
    with pytest.raises(PurgedCVError, match="not a leak to be purged"):
        label_end_times(idx, label_horizon=-1)
    backwards = pd.Series(idx.to_numpy()[::-1], index=idx)
    with pytest.raises(PurgedCVError, match="before the observation itself"):
        list(PurgedKFold(2, 0).split(idx, label_end=backwards))


def test_label_ends_on_the_wrong_index_are_refused_rather_than_reindexed():
    """Reindexing would align some rows and invent NaT for the rest, and
    a missing label window purges nothing."""
    idx = sessions(50)
    with pytest.raises(PurgedCVError, match="one label end per observation"):
        list(
            PurgedKFold(2, 0).split(
                idx, label_end=label_end_times(sessions(40), label_horizon=5)
            )
        )


def test_the_constructor_refuses_arguments_it_cannot_honour():
    with pytest.raises(PurgedCVError, match="n_splits must be at least 2"):
        PurgedKFold(1, 5)
    with pytest.raises(PurgedCVError, match="fraction of the WHOLE sample"):
        PurgedKFold(5, 5, embargo_pct=1.0)
    with pytest.raises(PurgedCVError, match="must be zero or more"):
        PurgedKFold(5, -1)
    with pytest.raises(PurgedCVError, match="'bars' or 'calendar_days'"):
        PurgedKFold(5, 5, horizon_unit="sessions")
    with pytest.raises(PurgedCVError, match="cannot make"):
        list(PurgedKFold(20, 1).split(sessions(10)))
    with pytest.raises(PurgedCVError, match="nothing to split"):
        list(PurgedKFold(2, 1).split(pd.DatetimeIndex([])))


def test_a_fold_that_purges_everything_says_so_instead_of_returning_nothing():
    """The sample is too short for this many folds at this horizon, and
    that is a sentence, not an empty array somebody debugs for an hour."""
    idx = sessions(40)
    with pytest.raises(PurgedCVError, match="the sample is too short"):
        list(PurgedKFold(2, label_horizon=39, embargo_pct=0.5).split(idx))


def test_calendar_days_and_bars_are_different_horizons_on_a_session_index():
    """Twenty-one bars is a month; twenty-one calendar days is fifteen
    sessions. Reading one as the other under-purges, which is a leak."""
    idx = sessions(100)
    in_bars = label_end_times(idx, label_horizon=21, horizon_unit="bars")
    in_days = label_end_times(idx, label_horizon=21, horizon_unit="calendar_days")
    assert in_bars.iloc[0] == idx[21]
    assert in_days.iloc[0] == idx[0] + pd.Timedelta(days=21)
    assert in_days.iloc[0] < in_bars.iloc[0]

    bars_train, _ = folds_of(PurgedKFold(2, 21, 0.0), idx)[1]
    days_train, _ = folds_of(
        PurgedKFold(2, 21, 0.0, horizon_unit="calendar_days"), idx
    )[1]
    assert len(bars_train) < len(days_train)


def test_the_last_windows_are_clamped_rather_than_invented():
    """The final h observations have incomplete labels. Clamping is the
    only honest thing a splitter can do — it cannot purge against data
    that does not exist — and it errs safe, since a short window is the
    last thing to be purged."""
    idx = sessions(50)
    ends = label_end_times(idx, label_horizon=10)
    assert ends.iloc[-1] == idx[-1]
    assert ends.iloc[45] == idx[-1]
    assert ends.iloc[39] == idx[49]
