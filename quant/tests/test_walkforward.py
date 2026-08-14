"""Tests for the schedule, the seams, and the curve nobody may reach for.

A walk-forward has two failure modes and they are not equally loud. The
loud one is a training window that runs past a test window, which shows
up as an impossible Sharpe. The quiet one is the stitching: a session
counted in two folds, a session counted in none, a fold's book joined to
the last by level rather than by return so the seam invents a jump. All
three produce a curve that looks entirely ordinary, and the only way to
catch them is to know exactly which sessions should be in the result and
assert that set rather than its length.

So the fixture here is a single known NAV curve over the whole sample,
and each fold's run returns a slice of it REBASED TO A DIFFERENT BOOK
SIZE. That is the arrangement the stitcher has to survive: chaining
returns reproduces the underlying shape exactly, concatenating levels
puts a step of several hundred percent at every refit. A stub that
returned the same starting cash every fold would pass either way.

The other half of the file is about what the result object refuses. A
walk-forward produces two curves per fold and the better-looking one is
always the fitted one, so `result.equity` has to raise rather than
resolve — an alias that quietly picks a curve is worse than no accessor
at all, because the number it produces is reportable-looking.

No prices are fetched or needed: every series below is arithmetic on a
business-day index.
"""

from __future__ import annotations

import itertools

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine import metrics
from griffinquant.engine.metrics import TrialCounter
from griffinquant.validation.walkforward import (
    MAX_LEAD_IN_SESSIONS,
    MAX_UNREPORTED_DAYS,
    MIN_TAIL_DAYS,
    UNSTABLE_SPREAD,
    FitOutcome,
    Fold,
    WalkForward,
    WalkForwardError,
    Window,
)

START = "2005-01-03"
END = "2015-12-31"

#: Every session the fixtures may use, and the one NAV path they all cut
#: from. Deterministic and closed-form rather than seeded-random, so a
#: failing assertion can be checked by hand.
MASTER = pd.bdate_range("2004-01-01", "2016-12-31")
STEPS = np.arange(len(MASTER))
GLOBAL = pd.Series(
    100.0 * np.exp(0.0003 * STEPS + 0.02 * np.sin(STEPS / 9.0)), index=MASTER
)


def counter(tmp_path) -> TrialCounter:
    return TrialCounter(tmp_path / "trials.jsonl")


def schedule(**kwargs) -> WalkForward:
    return WalkForward(START, END, **kwargs)


def constant_fit(**params):
    def fit(window: Window):
        return dict(params)

    return fit


def slice_run(*, lead_in: int = 0, flat: float | None = None):
    """A run that trades the known curve over the window it was handed.

    Each fold starts its own book at its own cash, which is the point:
    the absolute NAVs are not comparable across folds and only chaining
    the returns joins them without inventing a jump.
    """

    def run_fold(params, window: Window) -> pd.Series:
        inside = MASTER[(MASTER >= window.start) & (MASTER <= window.end)]
        earlier = MASTER[MASTER < window.start]
        idx = earlier[-lead_in:].append(inside) if lead_in else inside
        cash = 1_000.0 * (1 + window.start.year - 2005)
        if flat is not None:
            return pd.Series(np.full(len(idx), flat), index=idx)
        piece = GLOBAL.loc[idx]
        return piece / float(piece.iloc[0]) * cash

    return run_fold


def compounding_run(daily: float):
    def run_fold(params, window: Window) -> pd.Series:
        idx = MASTER[(MASTER >= window.start) & (MASTER <= window.end)]
        return pd.Series(50.0 * (1.0 + daily) ** np.arange(len(idx)), index=idx)

    return run_fold


def walk(tmp_path, *, fit=None, run=None, wf=None, **kwargs):
    return (wf or schedule()).run(
        fit=fit or constant_fit(lookback=126),
        run_fold=run or slice_run(),
        trials=counter(tmp_path),
        label="stub",
        **kwargs,
    )


# -- the schedule, before anything has been run ---------------------------


def test_training_expands_and_never_shrinks():
    """A fixed window sliding forward drops 2008 out of the training set
    somewhere around 2018, and a model refitted in 2022 on a rolling ten
    years has never been shown a credit crisis."""
    folds = schedule().folds()
    assert len(folds) == 6
    assert all(f.train.start == pd.Timestamp(START) for f in folds)
    for a, b in zip(folds, folds[1:]):
        assert b.train.end > a.train.end
        assert b.train.days > a.train.days
    assert folds[-1].train.years > folds[0].train.years + 4


def test_no_test_window_precedes_its_own_training_window():
    for f in schedule().folds():
        assert f.train.end < f.test.start
        assert f.test.start == f.refit_on
        assert (f.test.start - f.train.end).days == 1


def test_a_training_set_containing_its_own_first_test_day_is_refused():
    with pytest.raises(WalkForwardError, match="about to trade"):
        Fold(
            index=0,
            refit_on=pd.Timestamp("2010-01-03"),
            train=Window("2005-01-03", "2010-01-03"),
            test=Window("2010-01-03", "2011-01-02"),
        )


def test_refits_happen_at_most_annually():
    """A prior fixed before any result existed, and one with teeth: the
    cadence is itself a parameter, so a cadence chosen by seeing which
    one backtested best owes the deflated Sharpe a trial."""
    for frequency in (1, 2, 5):
        folds = schedule(refit_frequency=frequency).folds()
        for a, b in zip(folds, folds[1:]):
            assert (b.refit_on - a.refit_on).days >= 365 * frequency

    with pytest.raises(WalkForwardError, match="fitted to noise"):
        schedule(refit_frequency=0)
    with pytest.raises(WalkForwardError, match="in YEARS, not months"):
        schedule(refit_frequency=12)


def test_test_windows_tile_the_post_training_sample_exactly():
    folds = schedule().folds()
    assert folds[0].test.start == pd.Timestamp("2010-01-03")
    assert folds[-1].test.end == pd.Timestamp(END)
    for a, b in zip(folds, folds[1:]):
        assert b.test.start - a.test.end == pd.Timedelta(days=1)


def test_a_runt_tail_is_absorbed_rather_than_earning_its_own_refit():
    """A model refitted to govern three weeks has not been tested by
    those three weeks, and it would sit in the drift table carrying the
    same weight as one that governed a year."""
    wf = WalkForward(START, "2013-02-01")
    assert [str(f.refit_on.date()) for f in wf.folds()] == [
        "2010-01-03",
        "2011-01-03",
        "2012-01-03",
    ]
    assert wf.folds()[-1].test.end == pd.Timestamp("2013-02-01")
    orphan = pd.Timestamp("2013-02-01") - pd.Timestamp("2013-01-03")
    assert orphan.days < MIN_TAIL_DAYS

    # Never applied to the only refit there is: deleting it would leave
    # a schedule with no out-of-sample period and report no error.
    lone = WalkForward(START, "2010-02-01")
    assert len(lone.folds()) == 1


def test_a_sample_with_no_out_of_sample_period_is_refused():
    with pytest.raises(WalkForwardError, match="no out-of-sample period"):
        WalkForward(START, "2009-01-01", min_train_years=5)
    with pytest.raises(WalkForwardError, match="on or before it starts"):
        WalkForward("2010-01-01", "2010-01-01")
    with pytest.raises(WalkForwardError, match="min_train_years must be at least 1"):
        WalkForward(START, END, min_train_years=0)


# -- the stitched curve ----------------------------------------------------


def test_each_test_period_appears_exactly_once_with_no_gaps(tmp_path):
    """The property the whole object exists to have.

    Every session in the stitched curve belongs to exactly one fold's
    test window; no fold contributes a session another fold claimed; and
    the only sessions missing from the span are the seam anchors, which
    are counted and reported rather than left for somebody to notice as
    a short T.
    """
    result = walk(tmp_path)
    folds = result.schedule.folds()
    equity = result.oos_equity

    assert equity.index.is_monotonic_increasing
    assert not equity.index.has_duplicates
    assert [sum(f.test.contains(d) for f in folds) for d in equity.index] == [1] * len(
        equity
    )

    for a, b in itertools.combinations(result.folds, 2):
        assert a.oos_returns.index.intersection(b.oos_returns.index).empty

    contributed = pd.DatetimeIndex(
        np.concatenate([f.oos_returns.index.to_numpy() for f in result.folds])
    )
    assert not contributed.has_duplicates
    assert set(equity.index) == set(contributed) | {equity.index[0]}
    assert len(equity) == 1 + sum(f.sessions for f in result.folds)

    spanned = MASTER[
        (MASTER >= folds[0].test.start) & (MASTER <= folds[-1].test.end)
    ]
    missing = spanned.difference(equity.index)
    assert set(missing) == {
        MASTER[MASTER >= f.test.start][0] for f in folds[1:]
    }
    assert len(missing) == result.seam_sessions_dropped == len(folds) - 1


def test_the_seam_sessions_are_declared_rather_than_quietly_absent(tmp_path):
    result = walk(tmp_path)
    coverage = result.coverage()
    assert coverage["anchor_dropped"].tolist() == [False] + [True] * 5
    assert int(coverage["sessions"].sum()) == len(result.oos_equity) - 1
    assert result.summary().loc[0, "seam_sessions_dropped"] == 5


def test_a_lead_in_bar_buys_the_seam_session_back(tmp_path):
    """With an anchor from before the window, the whole test period
    reaches the stitched curve and nothing is spent."""
    result = walk(tmp_path, run=slice_run(lead_in=3))
    folds = result.schedule.folds()
    assert result.seam_sessions_dropped == 0
    assert not any(f.anchor_session_dropped for f in result.folds)

    spanned = MASTER[
        (MASTER >= folds[0].test.start) & (MASTER <= folds[-1].test.end)
    ]
    # One extra point at the front: fold zero's anchor is its lead-in bar.
    assert set(spanned) < set(result.oos_equity.index)
    assert len(result.oos_equity) == len(spanned) + 1


def test_the_summary_dates_the_period_and_not_the_base_level(tmp_path):
    """A lead-in bar is dated before fold zero's window opens, so the
    curve's first point is outside the out-of-sample period. Harmless
    arithmetically — it contributes no return — and wrong in a column
    somebody differences against `oos_end` to say how long the period
    was. The base level is still there, under its own name."""
    lead = walk(tmp_path, run=slice_run(lead_in=3)).summary().loc[0]
    opens = schedule().folds()[0].test.start
    assert lead["curve_base"] < opens
    assert lead["oos_start"] >= opens
    assert lead["oos_start"] == MASTER[MASTER >= opens][0]

    # Without a lead-in the anchor IS the window's first session, and
    # the two columns agree — which is why this went unnoticed.
    plain = walk(tmp_path).summary().loc[0]
    assert plain["curve_base"] == plain["oos_start"] == MASTER[MASTER >= opens][0]


def test_folds_are_joined_by_return_and_not_by_level(tmp_path):
    """Each fold ran a book several times the size of the last one. If
    the stitcher concatenated levels the curve would step by hundreds of
    percent at every refit; chaining returns reproduces the known path
    exactly, rebased to whatever the first fold started with."""
    result = walk(tmp_path, run=slice_run(lead_in=3))
    equity = result.oos_equity
    anchor = equity.index[0]
    expected = GLOBAL.loc[equity.index] / float(GLOBAL.loc[anchor]) * float(
        equity.iloc[0]
    )
    assert equity.to_numpy() == pytest.approx(expected.to_numpy(), rel=1e-12)

    # No seam produces a return the underlying path does not have.
    got = equity.pct_change().dropna()
    want = GLOBAL.loc[equity.index].pct_change().dropna()
    assert got.to_numpy() == pytest.approx(want.to_numpy(), rel=1e-12)


def test_a_stub_returning_a_constant_produces_the_constant(tmp_path):
    flat = walk(tmp_path, run=slice_run(flat=250.0))
    assert flat.oos_equity.to_numpy() == pytest.approx(250.0)
    assert flat.oos_equity.name == "nav"
    assert flat.oos_equity.index.name == "date"

    growth = walk(tmp_path, run=compounding_run(0.0004))
    steps = growth.oos_equity.pct_change().dropna()
    assert steps.to_numpy() == pytest.approx(0.0004, rel=1e-12)
    assert float(growth.oos_equity.iloc[-1]) == pytest.approx(
        float(growth.oos_equity.iloc[0]) * 1.0004 ** (len(growth.oos_equity) - 1)
    )


def test_a_run_that_overruns_its_window_has_traded_a_later_fold(tmp_path):
    def overrun(params, window: Window) -> pd.Series:
        idx = MASTER[(MASTER >= window.start) & (MASTER <= window.end)]
        extra = MASTER[MASTER > window.end][:2]
        return pd.Series(100.0, index=idx.append(extra))

    with pytest.raises(WalkForwardError, match="after its test window closed"):
        walk(tmp_path, run=overrun)


def test_too_much_lead_in_means_the_window_was_ignored(tmp_path):
    with pytest.raises(WalkForwardError, match="the run ignored the window"):
        walk(tmp_path, run=slice_run(lead_in=MAX_LEAD_IN_SESSIONS + 1))


def partial_run(*, keep):
    """A run that trades the known curve but only reports part of it.

    `keep` cuts the sessions the run hands back out of the sessions it
    was asked for, which is the shape of every failure below: nothing
    overruns, nothing leads in too far, and what comes back is a
    perfectly ordinary NAV curve over a shorter stretch of tape than the
    window it answers.
    """

    def run_fold(params, window: Window) -> pd.Series:
        inside = MASTER[(MASTER >= window.start) & (MASTER <= window.end)]
        piece = GLOBAL.loc[keep(inside, window)]
        return piece / float(piece.iloc[0]) * 1_000.0

    return run_fold


def test_a_fold_that_stops_reporting_partway_is_a_hole_not_a_result(tmp_path):
    """The quietest way to shorten T.

    A run handing back the first fortnight of a year clears every other
    guard in the file, and the stitched curve it produces is the one
    every headline number is computed on — so the reported Sharpe would
    be measured over a fraction of the period printed beside it, with
    nothing anywhere saying the period was short. Going flat is a
    position and a flat book still prints a NAV; going quiet is a run
    that stopped reporting, and that is an error.
    """
    stops = partial_run(
        keep=lambda inside, window: (
            inside[:10] if window.start.year == 2013 else inside
        )
    )
    with pytest.raises(WalkForwardError) as exc:
        walk(tmp_path, run=stops)

    message = str(exc.value)
    assert "fold 3" in message
    assert "2013-01-16" in message  # the last session it actually returned
    assert "2014-01-02" in message  # the window end it never reached
    assert "351 calendar days" in message
    assert "242 session(s)" in message
    assert "stopped reporting" in message


def test_the_hole_is_caught_wherever_in_the_window_it_falls(tmp_path):
    """Opening late and skipping the middle lose exactly as much tape as
    stopping early, and only one of the three looks like truncation."""
    late = partial_run(
        keep=lambda inside, window: (
            inside[40:] if window.start.year == 2011 else inside
        )
    )
    with pytest.raises(WalkForwardError, match="fold 1 reported no session"):
        walk(tmp_path, run=late)

    skips = partial_run(
        keep=lambda inside, window: (
            inside.delete(range(60, 120)) if window.start.year == 2012 else inside
        )
    )
    with pytest.raises(WalkForwardError, match="fold 2 reported no session"):
        walk(tmp_path, run=skips)


def test_a_closure_shorter_than_the_tolerance_is_a_holiday_not_a_hole(tmp_path):
    """September 2001 shut the exchange for four sessions and six
    calendar days. A market being closed is not a run going quiet, and
    the tolerance is what keeps the two from being the same error."""
    shut = partial_run(
        keep=lambda inside, window: inside[
            ~(
                (inside >= f"{window.start.year}-09-11")
                & (inside <= f"{window.start.year}-09-16")
            )
        ]
    )
    coverage = walk(tmp_path, run=shut).coverage()
    # Fold zero is the 2001 shape exactly: shut on a Monday, open the
    # following Friday, six calendar days with no session in them.
    assert coverage.loc[0, "unreported_days"] == 6
    assert coverage["unreported_days"].max() <= MAX_UNREPORTED_DAYS


def test_an_ordinary_weekend_is_a_printed_number_and_not_a_silence(tmp_path):
    """A gap under the tolerance still went unreported. Printing it is
    what makes the difference between a two and a nine something a reader
    notices rather than something they would have to go and derive."""
    coverage = walk(tmp_path).coverage()
    assert coverage["unreported_days"].tolist() == [2] * 6


def test_a_fold_that_returns_nothing_inside_its_window_is_refused(tmp_path):
    def empty_inside(params, window: Window) -> pd.Series:
        before = MASTER[MASTER < window.start][-3:]
        return pd.Series(100.0, index=before)

    with pytest.raises(WalkForwardError, match="the stitched curve would skip"):
        walk(tmp_path, run=empty_inside)


def test_a_run_that_hands_back_something_that_is_not_a_curve_says_so(tmp_path):
    with pytest.raises(WalkForwardError, match="not a NAV curve"):
        walk(tmp_path, run=lambda params, window: {"pnl": 3})


# -- what the result refuses to hand over -----------------------------------


def test_in_sample_results_are_not_reachable_through_the_primary_accessor(tmp_path):
    """The fitted curve is always the better-looking one and it sits one
    attribute away. An alias that resolves to whichever curve is handy
    produces a number that looks reportable."""
    result = walk(tmp_path)

    with pytest.raises(AttributeError, match="oos_equity"):
        result.equity
    for name in ("nav", "curve", "returns"):
        with pytest.raises(AttributeError, match="oos_equity"):
            getattr(result, name)
    with pytest.raises(AttributeError, match="in_sample_curves"):
        result.in_sample_equity
    assert not hasattr(result, "equity")

    with pytest.raises(WalkForwardError, match="include_in_sample=True"):
        result.in_sample_curves()


def test_asking_for_the_fitted_curves_gets_them_per_fold_and_unstitched(tmp_path):
    """Expanding training windows overlap, so a continuous in-sample
    curve would compound the early years once per refit. There is no
    such series, and the shape of the accessor is what stops one being
    built by accident."""
    result = walk(tmp_path, include_in_sample=True)
    curves = result.in_sample_curves()
    assert set(curves) == {f.index for f in result.folds}
    assert not isinstance(curves, pd.Series)

    first, second = curves[0], curves[1]
    assert first.index[0] == second.index[0]
    assert len(second) > len(first)
    # The overlap is total, which is the reason they are kept apart.
    assert first.index.isin(second.index).all()

    # And the headline still comes off the out-of-sample curve alone.
    report = result.performance()
    assert report.start == result.oos_equity.index[0]
    assert report.n_sessions == len(result.oos_equity) - 1


def test_an_empty_in_sample_dict_is_never_returned_in_place_of_a_refusal(tmp_path):
    """An empty result here reads as "the strategy made nothing
    in-sample", which is the opposite of "nobody looked"."""
    result = walk(tmp_path)
    assert result._in_sample is None
    assert not bool(result.summary().loc[0, "in_sample_available"])
    assert bool(walk(tmp_path, include_in_sample=True).summary().loc[
        0, "in_sample_available"
    ])


# -- the trial ledger --------------------------------------------------------


def test_every_refit_is_written_to_the_ledger_and_dated_by_the_refit(tmp_path):
    """The refit date, not the wall clock: re-running the same walk must
    append the same rows, or the ledger records how often we pressed go
    rather than how many configurations were tried."""
    ledger = counter(tmp_path)
    result = schedule().run(
        fit=constant_fit(lookback=126),
        run_fold=slice_run(),
        trials=ledger,
        label="stub",
    )
    folds = result.schedule.folds()

    assert result.trials_recorded == len(folds) == ledger.count()
    assert [r.timestamp for r in ledger.records()] == [
        f.refit_on.date().isoformat() for f in folds
    ]
    # One configuration, held at every refit — six fits, one trial.
    assert result.configs_evaluated == 1
    assert ledger.distinct_count() == 1


def test_a_fit_that_swept_a_grid_owes_the_ledger_every_candidate(tmp_path):
    candidates = ({"lookback": 20}, {"lookback": 60}, {"lookback": 200})

    def searching(window: Window) -> FitOutcome:
        return FitOutcome(chosen=candidates[1], evaluated=candidates, note="grid of 3")

    ledger = counter(tmp_path)
    result = schedule().run(
        fit=searching, run_fold=slice_run(), trials=ledger, label="swept"
    )
    assert result.trials_recorded == 3 * len(result.folds)
    assert result.configs_evaluated == 3
    assert ledger.distinct_count() == 3
    assert "3 configuration(s) evaluated" in result.search_disclosure
    assert sum("chosen" in r.description for r in ledger.records()) == len(result.folds)


def test_a_fit_that_declares_one_configuration_is_said_to_have_declared_one(tmp_path):
    """Either nothing was searched or the search was not declared, and
    the disclosure refuses to guess which."""
    result = walk(tmp_path)
    assert "Either nothing was searched" in result.search_disclosure


def test_a_chosen_configuration_was_evaluated_by_definition():
    added = FitOutcome(chosen={"lookback": 20}, evaluated=({"lookback": 200},))
    assert len(added.evaluated) == 2
    assert dict(added.chosen) in [dict(c) for c in added.evaluated]

    already = FitOutcome(chosen={"lookback": 20}, evaluated=({"lookback": 20},))
    assert len(already.evaluated) == 1


def test_the_walk_refuses_to_run_without_somewhere_to_count(tmp_path):
    with pytest.raises(WalkForwardError, match="must be a metrics.TrialCounter"):
        schedule().run(
            fit=constant_fit(a=1), run_fold=slice_run(), trials=6, label="stub"
        )
    with pytest.raises(WalkForwardError, match="label is required"):
        schedule().run(
            fit=constant_fit(a=1),
            run_fold=slice_run(),
            trials=counter(tmp_path),
            label="  ",
        )


def test_a_fit_returning_the_wrong_shape_names_the_fold(tmp_path):
    with pytest.raises(WalkForwardError, match="at fold 0"):
        walk(tmp_path, fit=lambda window: 42)


# -- the drift record ---------------------------------------------------------


def test_the_parameter_table_names_a_parameter_that_is_chasing(tmp_path):
    """The stitched curve says what the process earned; this says
    whether it was one process or six wearing the same name."""

    def alternating(window: Window):
        return {"lookback": 20 if window.end.year % 2 == 0 else 200}

    result = walk(tmp_path, fit=alternating)
    frame = result.parameters()
    assert list(frame["param.lookback"]) == [20, 200, 20, 200, 20, 200]

    drift = result.parameter_drift()
    row = drift.set_index("parameter").loc["lookback"]
    assert row["changes"] == 5
    assert row["churn"] == 1.0
    assert row["spread"] == pytest.approx(10.0)
    assert bool(row["unstable"]) is True
    assert "materially different strategies" in row["note"]
    assert UNSTABLE_SPREAD < 10.0


def test_a_parameter_that_never_moved_is_reported_as_held(tmp_path):
    drift = walk(tmp_path).parameter_drift()
    row = drift.set_index("parameter").loc["lookback"]
    assert row["distinct"] == 1
    assert row["changes"] == 0
    assert bool(row["unstable"]) is False
    assert "held at 126 at every one of 6 refit(s)" == row["note"]


def test_a_strategy_parameter_called_fold_does_not_land_on_the_fold_column(tmp_path):
    frame = walk(tmp_path, fit=constant_fit(fold=7)).parameters()
    assert list(frame["fold"]) == [0, 1, 2, 3, 4, 5]
    assert list(frame["param.fold"]) == [7] * 6


# -- windows ------------------------------------------------------------------


def test_a_window_is_closed_at_both_ends():
    w = Window("2010-01-04", "2010-01-08")
    assert w.days == 5
    assert w.contains("2010-01-04") and w.contains("2010-01-08")
    assert not w.contains("2010-01-09")
    assert str(w) == "2010-01-04..2010-01-08"
    assert w.years == pytest.approx(5 / metrics.DAYS_PER_YEAR)

    cut = w.slice(pd.Series(1.0, index=MASTER))
    assert len(cut) == 5
    with pytest.raises(WalkForwardError, match="ends .* before it starts"):
        Window("2010-01-08", "2010-01-04")
    with pytest.raises(WalkForwardError, match="indexed by date"):
        Window("2010-01-04", "2010-01-08").slice(pd.Series([1.0, 2.0]))
