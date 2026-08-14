"""Measurement, checked against arithmetic somebody can do by hand.

Most of this file is unglamorous: four statistics against fixtures
small enough to verify on paper. The reason it is worth the space is
that every one of them has a plausible wrong version. A drawdown dated
from the FIRST touch of the high water mark credits the strategy with
months of flat water it did not spend falling. A recovery time of zero
reads as "we got it back" when the hole is still open. A CAGR
annualised over sessions rather than calendar days hands a backtest
that stopped in August a full year of compounding.

The deflated Sharpe is the exception and gets a worked example rather
than a fixture. The fixture is chosen so the whole formula collapses to
something closed-form: an exactly symmetric two-point return
distribution has skew 0 and non-excess kurtosis 1, which makes the
Mertens variance term identically 1, which makes

    DSR = Phi( SR * sqrt(T - 1) - g(N) )

with g(N) the Gumbel expected-maximum term. Every step of the
implementation — per-period rather than annualised Sharpe, T-1 rather
than T, non-excess kurtosis, the default 1/sqrt(T-1) trial dispersion —
is visible in that expression, and each of them is a way to get a
plausible wrong answer. The example then walks N up and watches the
same series go from significant to not, which is the only behaviour of
the DSR anybody actually needs to trust.

The trial counter is tested for the one property it has: it appends.
A ledger somebody can wind back is not a denominator, it is a
decoration.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine.metrics import (
    DAYS_PER_YEAR,
    REPORT_PERIODS,
    SIGNIFICANCE_THRESHOLD,
    TRADING_DAYS_PER_YEAR,
    MetricsError,
    NamedPeriod,
    TrialCounter,
    TrialLogCorrupt,
    _standardised_moments,
    annualised_volatility,
    as_equity,
    cagr,
    deflated_sharpe_ratio,
    evaluate,
    expected_max_sharpe,
    max_drawdown,
    norm_cdf,
    norm_ppf,
    period_breakout,
    probabilistic_sharpe_ratio,
    rf_convention,
    rolling_sharpe,
    sharpe_ratio,
    to_returns,
    trading_costs,
    worst_days,
    worst_months,
)


def days(n: int, start: str = "2015-01-05") -> pd.DatetimeIndex:
    return pd.bdate_range(start, periods=n)


def equity_from(returns) -> pd.Series:
    r = np.asarray(returns, dtype="float64")
    return pd.Series(
        100.0 * np.cumprod(np.concatenate([[1.0], 1.0 + r])),
        index=days(len(r) + 1),
    )


# -- the ordinary numbers, by hand ---------------------------------------


def test_cagr_is_geometric_over_the_calendar_span():
    """Doubling in 730 calendar days, on act/365.25.

    Sessions would give a different — and flattering — answer for any
    sample that does not end on a year boundary, which is every sample.
    """
    e = pd.Series([100.0, 200.0], index=pd.to_datetime(["2021-01-01", "2023-01-01"]))
    assert cagr(e) == pytest.approx(2.0 ** (DAYS_PER_YEAR / 730.0) - 1.0)
    assert cagr(e) == pytest.approx(0.41454931, abs=1e-8)


def test_a_backtest_that_stops_in_august_is_not_given_the_whole_year():
    part = pd.Series(
        [100.0, 110.0], index=pd.to_datetime(["2021-01-01", "2021-09-01"])
    )
    # 243 days, not 365: the annualised figure is well above the 10%
    # actually earned, and it has to be.
    assert cagr(part) > 0.15


def test_volatility_is_the_sample_deviation_scaled_by_root_time():
    r = pd.Series([0.01, -0.01] * 5, index=days(10))
    expected = math.sqrt(10 * 1e-4 / 9) * math.sqrt(TRADING_DAYS_PER_YEAR)
    assert annualised_volatility(r) == pytest.approx(expected)
    assert annualised_volatility(r) == pytest.approx(0.16733, abs=1e-5)


def test_sharpe_is_mean_over_deviation_and_annualises_by_root_252():
    r = pd.Series([0.02, -0.01] * 5, index=days(10))
    sd = math.sqrt(10 * 0.015**2 / 9)
    assert sharpe_ratio(r, annualise=False) == pytest.approx(0.005 / sd)
    assert sharpe_ratio(r) == pytest.approx(
        0.005 / sd * math.sqrt(TRADING_DAYS_PER_YEAR)
    )
    assert sharpe_ratio(r) == pytest.approx(5.01996, abs=1e-5)


def test_a_flat_curve_has_no_sharpe_rather_than_an_infinite_one():
    r = pd.Series([0.0] * 10, index=days(10))
    assert math.isnan(sharpe_ratio(r))
    assert math.isnan(sharpe_ratio(pd.Series([0.01], index=days(1))))


def test_the_risk_free_rate_is_subtracted_geometrically():
    """Geometric, not divided by 252: the returns it is subtracted from
    compound, so the cash leg has to compound too."""
    r = pd.Series([0.02, -0.01] * 10, index=days(20))
    per_day = (1.0 + 0.05) ** (1.0 / TRADING_DAYS_PER_YEAR) - 1.0
    excess = r - per_day
    assert sharpe_ratio(r, rf=0.05, annualise=False) == pytest.approx(
        float(excess.mean()) / float(excess.std(ddof=1))
    )
    # A rate above zero always lowers the Sharpe of a profitable book,
    # which is the whole point of the note on `rf_convention`.
    assert sharpe_ratio(r, rf=0.05) < sharpe_ratio(r, rf=0.0)


def test_a_rate_handed_over_as_percent_is_refused():
    """`data.tbill.fetch_rate` returns percent, as FRED publishes it. A
    5.25 read as a decimal compounds the risk-free asset at 73 basis
    points a DAY, and the resulting Sharpe is deeply negative and
    entirely plausible."""
    r = pd.Series([0.001] * 20, index=days(20))
    with pytest.raises(MetricsError, match="over 100% a year"):
        sharpe_ratio(r, rf=5.25)


def test_a_rate_series_that_starts_late_is_refused_not_backfilled():
    """Forward-filling from the first quote we happen to have is how a
    2005 backtest ends up measured against 2008's cash rate."""
    r = pd.Series([0.001] * 20, index=days(20))
    late = pd.Series([0.02], index=days(1, start="2015-01-20"))
    with pytest.raises(MetricsError, match="does not cover the sample"):
        sharpe_ratio(r, rf=late)


def test_every_sharpe_carries_the_convention_it_was_computed_under():
    assert "ZERO" in rf_convention(0.0)
    assert "1.5%" in rf_convention(0.0)  # the size of the subsidy, named
    assert "2.00%" in rf_convention(0.02)
    series = pd.Series([0.01, 0.05], index=days(2))
    assert "supplied annualised risk-free series" in rf_convention(series)


def test_rolling_sharpe_will_not_call_forty_days_a_year():
    r = pd.Series(np.linspace(-0.01, 0.01, 300), index=days(300))
    out = rolling_sharpe(r, window=TRADING_DAYS_PER_YEAR)
    assert len(out) == 300 - TRADING_DAYS_PER_YEAR + 1
    assert out.index[0] == r.index[TRADING_DAYS_PER_YEAR - 1]
    with pytest.raises(MetricsError, match="at least 2"):
        rolling_sharpe(r, window=1)


# -- drawdown -------------------------------------------------------------


def test_the_deepest_hole_and_its_dates():
    e = pd.Series(
        [100.0, 120.0, 90.0, 130.0],
        index=pd.to_datetime(
            ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"]
        ),
    )
    d = max_drawdown(e)
    assert d.depth == pytest.approx(-0.25)
    assert d.peak == pd.Timestamp("2020-01-03")
    assert d.trough == pd.Timestamp("2020-01-06")
    assert d.recovered_on == pd.Timestamp("2020-01-07")
    assert d.sessions_peak_to_trough == 1
    assert d.sessions_to_recover == 1
    assert d.sessions_underwater == 2
    assert d.days_underwater == 4  # calendar, across the weekend
    assert d.recovered and not d.still_underwater


def test_the_slide_starts_at_the_last_touch_of_the_high_water_mark():
    """Taking the first touch credits the strategy with the flat months
    before the fall as time spent falling."""
    e = pd.Series([100.0, 100.0, 100.0, 70.0, 100.0], index=days(5))
    d = max_drawdown(e)
    assert d.peak == e.index[2]
    assert d.sessions_peak_to_trough == 1


def test_a_hole_the_sample_never_climbed_out_of_has_no_recovery_time():
    """None, never zero and never the distance to the last bar. A zero
    reads as "we made it back" and this is the opposite of that."""
    e = pd.Series([100.0, 100.0, 100.0, 80.0, 90.0], index=days(5))
    d = max_drawdown(e)
    assert d.still_underwater
    assert d.recovered_on is None
    assert d.sessions_to_recover is None
    assert d.days_to_recover is None
    assert not d.recovered
    # What IS reported is how long the hole has been open, which is a
    # different quantity wearing a different name.
    assert d.sessions_underwater == 2


def test_a_curve_that_only_rises_has_no_drawdown():
    d = max_drawdown(pd.Series([100.0, 101.0, 102.0], index=days(3)))
    assert d.depth == pytest.approx(0.0)
    assert not d.still_underwater


def test_the_worst_day_and_the_worst_drawdown_are_different_questions():
    """A grind and a gap need different answers, and a table of one
    without the other cannot tell them apart."""
    r = pd.Series([-0.002] * 30 + [-0.09], index=days(31))
    table = worst_days(r, n=3)
    assert list(table["rank"]) == [1, 2, 3]
    assert table["return"].iloc[0] == pytest.approx(-0.09)
    assert table["return"].is_monotonic_increasing  # worst first
    assert table["date"].iloc[0] == r.index[-1]
    assert worst_days(pd.Series(dtype="float64"), 5).empty


def test_worst_months_carries_the_session_count_because_stubs_lie():
    r = pd.Series([0.001] * 40, index=pd.bdate_range("2020-01-30", periods=40))
    out = worst_months(r, n=5)
    assert "sessions" in out.columns
    jan = out.loc[out["month"] == "2020-01"]
    assert int(jan["sessions"].iloc[0]) == 2  # a two-day stub, labelled


# -- normalising what comes in -------------------------------------------


def test_a_frame_with_a_date_column_is_accepted():
    frame = pd.DataFrame(
        {"date": pd.to_datetime(["2020-01-02", "2020-01-03"]), "nav": [100.0, 101.0]}
    )
    s = as_equity(frame)
    assert isinstance(s.index, pd.DatetimeIndex)
    assert s.name == "nav"
    assert list(s) == [100.0, 101.0]


def test_a_frame_with_no_nav_column_says_what_it_looked_for():
    with pytest.raises(MetricsError, match="looked for"):
        as_equity(pd.DataFrame({"date": [], "price": []}))


def test_a_non_positive_nav_is_a_bug_upstream_and_is_refused():
    """This is a long-only cash account with no leverage, so a zero NAV
    cannot happen; a -inf log return downstream would hide where it
    came from."""
    with pytest.raises(MetricsError, match="non-positive"):
        as_equity(pd.Series([100.0, 0.0], index=days(2)))


def test_duplicate_dates_are_refused_rather_than_collapsed():
    dupe = pd.Series([1.0, 2.0], index=pd.to_datetime(["2020-01-02"] * 2))
    with pytest.raises(MetricsError, match="duplicate date"):
        as_equity(dupe)


def test_returns_are_simple_because_everything_downstream_compounds():
    e = pd.Series([100.0, 110.0, 99.0], index=days(3))
    r = to_returns(e)
    assert list(r) == pytest.approx([0.10, -0.10])
    assert len(r) == 2


# -- turnover and cost drag ----------------------------------------------


def test_a_trade_log_with_no_cost_column_reports_none_not_zero():
    """A zero cost drag printed under a backtest reads as a cheap
    strategy rather than as an unanswered question."""
    e = pd.Series([100.0, 110.0], index=pd.to_datetime(["2020-01-02", "2021-01-02"]))
    out = trading_costs(pd.DataFrame({"notional": [50.0]}), e)
    assert out.costs_supplied is False
    assert out.total_cost is None
    assert out.cost_drag_bps is None


def test_no_trade_log_at_all_is_a_third_state():
    e = pd.Series([100.0, 110.0], index=pd.to_datetime(["2020-01-02", "2021-01-02"]))
    assert trading_costs(None, e).costs_supplied is False
    assert trading_costs(None, e).total_cost is None
    empty = trading_costs(pd.DataFrame({"notional": []}), e)
    assert empty.costs_supplied is True
    assert empty.total_cost == 0.0


def test_turnover_counts_every_dollar_that_changed_hands():
    """A book that replaces itself once a year scores 2.0, because that
    is two trades and the costs were paid on both."""
    e = pd.Series(
        [100.0, 100.0], index=pd.to_datetime(["2020-01-02", "2021-01-01"])
    )
    trades = pd.DataFrame({"notional": [100.0, -100.0]})
    out = trading_costs(trades, e)
    assert out.traded_notional == 200.0
    assert out.annual_turnover == pytest.approx(200.0 / 100.0 / out.years)


def test_shares_times_price_stands_in_for_a_missing_notional():
    e = pd.Series([100.0, 110.0], index=pd.to_datetime(["2020-01-02", "2021-01-02"]))
    trades = pd.DataFrame({"shares": [-3.0], "price": [10.0]})
    assert trading_costs(trades, e).traded_notional == 30.0
    with pytest.raises(MetricsError, match="no notional"):
        trading_costs(pd.DataFrame({"ticker": ["SPY"]}), e)


def test_cost_components_are_summed_when_no_total_is_supplied():
    e = pd.Series([100.0, 110.0], index=pd.to_datetime(["2020-01-02", "2021-01-02"]))
    trades = pd.DataFrame(
        {"notional": [1_000.0], "commission": [1.0], "impact": [2.0]}
    )
    assert trading_costs(trades, e).total_cost == pytest.approx(3.0)


# -- period breakouts -----------------------------------------------------


def test_a_window_the_sample_does_not_cover_still_gets_a_row():
    """Dropping it would let a backtest starting in 2010 publish a
    stress table with no 2008 in it and nothing saying so."""
    e = pd.Series(
        np.linspace(100.0, 120.0, 300), index=pd.bdate_range("2023-01-03", periods=300)
    )
    table = period_breakout(e)
    assert list(table["period"]) == [p.name for p in REPORT_PERIODS]
    row = table.loc[table["period"] == "2008"].iloc[0]
    assert row["sessions"] == 0
    assert math.isnan(row["total_return"])


def test_a_window_is_anchored_on_the_last_nav_before_it_opens():
    """Slicing on the dates alone forfeits the period's own first
    session, and across five windows the leak all runs one way."""
    idx = pd.bdate_range("2021-12-27", periods=10)
    e = pd.Series(np.arange(100.0, 110.0), index=idx)
    window = NamedPeriod("2022", "2022-01-01", "2022-12-31", "the year")
    row = period_breakout(e, periods=[window]).iloc[0]
    # 2021-12-31 closes at 104 and the last bar in the frame is 109. A
    # slice that began inside 2022 would have measured from 105 and
    # handed 3 January's move to the year before.
    assert row["total_return"] == pytest.approx(109.0 / 104.0 - 1.0)
    assert row["sessions"] == 5


def test_an_open_ended_window_runs_to_the_last_observation():
    idx = pd.bdate_range("2023-01-03", periods=50)
    e = pd.Series(np.linspace(100.0, 150.0, 50), index=idx)
    row = period_breakout(e, periods=[REPORT_PERIODS[-1]]).iloc[0]
    assert row["end"] == idx[-1]
    assert row["sessions"] == 49


# -- the normal distribution, without scipy ------------------------------


@pytest.mark.parametrize(
    ("p", "z"),
    [
        (0.5, 0.0),
        (0.975, 1.959963985),
        (0.99, 2.326347874),
        (0.999, 3.090232306),
        (0.025, -1.959963985),
        (1e-8, -5.612001244),
    ],
)
def test_the_inverse_normal_matches_the_textbook(p, z):
    assert norm_ppf(p) == pytest.approx(z, abs=1e-8)


def test_the_inverse_is_solved_in_the_lower_tail_and_mirrored():
    """Up in the right tail the CDF and p are both within a rounding
    error of 1.0, the refinement's subtraction cancels, and six digits
    quietly disappear — precisely where the DSR reads, since p is
    1 - 1/N with N in the hundreds."""
    for n in (100, 500, 1_000, 10_000):
        p = 1.0 - 1.0 / n
        assert norm_cdf(norm_ppf(p)) == pytest.approx(p, rel=1e-12)


@pytest.mark.parametrize("bad", [0.0, 1.0, -0.1, 1.5])
def test_a_probability_outside_the_open_unit_interval_is_refused(bad):
    with pytest.raises(MetricsError, match="norm_ppf"):
        norm_ppf(bad)


# -- the deflated Sharpe, worked ------------------------------------------
#
# The fixture: T alternating returns of m+s and m-s. Exactly symmetric,
# so skew is 0 and NON-EXCESS kurtosis is 1, and the Mertens variance
# term 1 - g3*SR + ((g4-1)/4)*SR^2 collapses to exactly 1. Everything
# after that is closed form.

WORKED_T = 1_000
WORKED_MEAN = 0.0006
WORKED_SPREAD = 0.008


def worked_returns() -> pd.Series:
    return pd.Series(
        [
            WORKED_MEAN + WORKED_SPREAD if i % 2 == 0 else WORKED_MEAN - WORKED_SPREAD
            for i in range(WORKED_T)
        ],
        index=days(WORKED_T, start="2010-01-04"),
    )


def worked_sharpe() -> float:
    """Per-period, from the closed form rather than from the module."""
    sd = WORKED_SPREAD * math.sqrt(WORKED_T / (WORKED_T - 1))
    return WORKED_MEAN / sd


def gumbel(n: int) -> float:
    """The expected maximum of n standard normals, Bailey and Lopez de
    Prado's approximation, written out."""
    g = 0.5772156649015329
    return (1.0 - g) * norm_ppf(1.0 - 1.0 / n) + g * norm_ppf(
        1.0 - 1.0 / (n * math.e)
    )


def test_the_fixture_has_the_moments_the_worked_example_assumes():
    skew, kurt = _standardised_moments(worked_returns())
    assert skew == pytest.approx(0.0, abs=1e-12)
    assert kurt == pytest.approx(1.0)
    assert sharpe_ratio(worked_returns(), annualise=False) == pytest.approx(
        worked_sharpe()
    )


def test_kurtosis_is_non_excess_which_is_the_easy_way_to_be_wrong():
    """pandas returns EXCESS kurtosis and bias-corrects both moments.
    Handing those to the formula puts g4 three units low, shrinks the
    standard error and inflates the result."""
    rng = np.random.default_rng(11)
    r = pd.Series(rng.normal(0.0, 0.01, 5_000), index=days(5_000, "2005-01-03"))
    _, kurt = _standardised_moments(r)
    assert kurt == pytest.approx(3.0, abs=0.25)
    assert abs(kurt - float(r.kurt())) > 2.5  # pandas' is the excess form


@pytest.mark.parametrize("trials", [1, 2, 5, 20, 100, 500])
def test_the_deflated_sharpe_matches_the_closed_form(trials):
    r = worked_returns()
    sr = worked_sharpe()
    root = math.sqrt(WORKED_T - 1)
    # The default trial dispersion is 1/sqrt(T-1), so SR* * sqrt(T-1)
    # is exactly the Gumbel term and the whole thing is one Phi.
    expected = norm_cdf(sr * root - gumbel(trials)) if trials > 1 else norm_cdf(
        sr * root
    )

    out = deflated_sharpe_ratio(r, trials=trials)
    assert out.deflated_sharpe == pytest.approx(expected, abs=1e-12)
    assert out.probabilistic_sharpe == pytest.approx(norm_cdf(sr * root), abs=1e-12)
    assert out.n_observations == WORKED_T
    assert out.trials == trials
    assert out.observed_sharpe_per_period == pytest.approx(sr)


def test_the_formula_is_fed_per_period_figures_and_not_annualised_ones():
    """Feeding it an annualised Sharpe with a daily T overstates the
    result by roughly sqrt(252), which turns every strategy ever written
    into a discovery. This is the assertion that would catch that."""
    out = deflated_sharpe_ratio(worked_returns(), trials=1)
    root = math.sqrt(WORKED_T - 1)
    wrong = norm_cdf(out.observed_sharpe_annualised * root)
    assert out.probabilistic_sharpe < wrong
    assert wrong == pytest.approx(1.0)  # the wrong version is uninformative
    assert out.observed_sharpe_annualised == pytest.approx(
        out.observed_sharpe_per_period * math.sqrt(TRADING_DAYS_PER_YEAR)
    )


def test_the_deflated_sharpe_falls_as_the_trial_count_rises():
    r = worked_returns()
    values = [deflated_sharpe_ratio(r, trials=n).deflated_sharpe for n in
              (1, 2, 5, 10, 50, 100, 500, 2_000)]
    assert all(a > b for a, b in zip(values, values[1:]))
    # And it never rises above the undeflated probability, because the
    # hurdle is never negative.
    psr = deflated_sharpe_ratio(r, trials=1).probabilistic_sharpe
    assert all(v <= psr + 1e-12 for v in values)


def test_the_same_series_stops_being_significant_and_says_so():
    """The behaviour the whole file exists for: one 1.19 annualised
    Sharpe, three honest readings of it depending on how many times we
    looked."""
    r = worked_returns()

    once = deflated_sharpe_ratio(r, trials=1)
    assert once.significant
    assert once.deflated_sharpe >= SIGNIFICANCE_THRESHOLD
    assert "clears" in once.verdict

    a_few = deflated_sharpe_ratio(r, trials=6)
    assert not a_few.significant
    assert "insignificant, not as promising" in a_few.verdict

    a_search = deflated_sharpe_ratio(r, trials=200)
    assert not a_search.significant
    assert "does not even reach the selection hurdle" in a_search.verdict
    assert (
        a_search.benchmark_sharpe_annualised
        > a_search.observed_sharpe_annualised
    )
    # Every verdict carries N and T, so it cannot be quoted favourably
    # out of context.
    for out in (once, a_few, a_search):
        assert f"{out.trials} trial(s)" in out.verdict
        assert "1,000 observations" in out.verdict


def test_the_hurdle_is_zero_for_one_trial_and_rises_with_n():
    """Exact at N=1, where the asymptotic form would evaluate Z^-1(0)
    and hand back minus infinity."""
    assert expected_max_sharpe(1, 0.03) == 0.0
    hurdles = [expected_max_sharpe(n, 1.0) for n in (2, 5, 10, 100, 1_000)]
    assert all(a < b for a, b in zip(hurdles, hurdles[1:]))
    assert hurdles[-1] == pytest.approx(gumbel(1_000))
    with pytest.raises(MetricsError, match="at least 1"):
        expected_max_sharpe(0, 1.0)


def test_the_probabilistic_sharpe_is_a_half_at_its_own_benchmark():
    sr = 0.05
    assert probabilistic_sharpe_ratio(
        sr, benchmark_sharpe=sr, n_observations=500, skew=0.0, kurtosis=3.0
    ) == pytest.approx(0.5)


def test_negative_skew_and_fat_tails_widen_the_standard_error():
    """A Sharpe earned by selling tails is a less certain Sharpe, and
    the Mertens term is where that shows up."""
    base = probabilistic_sharpe_ratio(
        0.08, benchmark_sharpe=0.0, n_observations=1_000, skew=0.0, kurtosis=3.0
    )
    skewed = probabilistic_sharpe_ratio(
        0.08, benchmark_sharpe=0.0, n_observations=1_000, skew=-1.5, kurtosis=3.0
    )
    fat = probabilistic_sharpe_ratio(
        0.08, benchmark_sharpe=0.0, n_observations=1_000, skew=0.0, kurtosis=12.0
    )
    assert skewed < base
    assert fat < base


def test_hand_supplied_moments_that_cannot_exist_are_refused():
    with pytest.raises(MetricsError, match="degenerate"):
        probabilistic_sharpe_ratio(
            2.0, benchmark_sharpe=0.0, n_observations=100, skew=5.0, kurtosis=1.0
        )


def test_a_measured_trial_dispersion_is_recorded_as_measured():
    r = worked_returns()
    assumed = deflated_sharpe_ratio(r, trials=50)
    measured = deflated_sharpe_ratio(r, trials=50, trial_sharpe_std=0.05)
    assert "assumed" in assumed.trial_dispersion_source
    assert "measured" in measured.trial_dispersion_source
    assert assumed.trial_sharpe_std == pytest.approx(1.0 / math.sqrt(WORKED_T - 1))
    assert measured.trial_sharpe_std == 0.05
    # A wider dispersion is a taller hurdle.
    assert measured.deflated_sharpe < assumed.deflated_sharpe


def test_zero_trials_is_not_the_same_as_having_tried_nothing_once():
    with pytest.raises(MetricsError, match="never written to"):
        deflated_sharpe_ratio(worked_returns(), trials=0)


# -- the trial ledger -----------------------------------------------------


def counter(tmp_path) -> TrialCounter:
    return TrialCounter(tmp_path / "trials.jsonl")


def test_recording_appends_and_the_earlier_rows_survive(tmp_path):
    c = counter(tmp_path)
    c.record(config={"band": 0.005}, description="baseline", timestamp="2026-01-02")
    first = c.path.read_text("utf-8")
    c.record(config={"band": 0.010}, description="wider band", timestamp="2026-01-03")
    after = c.path.read_text("utf-8")

    assert after.startswith(first)
    assert len(after) > len(first)
    assert c.count() == 2
    assert c.distinct_count() == 2


def test_there_is_no_way_to_wind_the_counter_back(tmp_path):
    """A deflated Sharpe computed from a resettable N is not a
    statistic, it is a decoration — any strategy clears any bar by
    forgetting how many it tried."""
    c = counter(tmp_path)
    for name in ("reset", "clear", "truncate", "delete", "remove", "rewrite"):
        assert not hasattr(c, name)
    source = TrialCounter.record.__doc__ or ""
    assert "Never overwrites" in source


def test_the_file_is_only_ever_opened_to_append(tmp_path):
    """Belt and braces: an existing file written by something else keeps
    its contents when the counter is next used."""
    path = tmp_path / "trials.jsonl"
    path.write_text(
        json.dumps(
            {"config_hash": "aa", "description": "by hand", "timestamp": "2026-01-01"}
        )
        + "\n",
        "utf-8",
    )
    c = TrialCounter(path)
    c.record(config="bb", description="by the harness", timestamp="2026-01-02")
    assert [r.config_hash for r in c.records()] == ["aa", "bb"]


def test_the_same_configuration_twice_is_one_trial(tmp_path):
    c = counter(tmp_path)
    cfg = {"band": 0.005, "costs": 1.0}
    c.record(config=cfg, description="first run", timestamp="2026-01-02")
    c.record(config=cfg, description="rerun after a fix", timestamp="2026-01-04")
    assert c.count() == 2
    assert c.distinct_count() == 1


def test_key_order_does_not_mint_a_second_trial():
    a = TrialCounter.hash_config({"a": 1, "b": 2})
    b = TrialCounter.hash_config({"b": 2, "a": 1})
    assert a == b
    assert TrialCounter.hash_config("already-a-hash") == "already-a-hash"


def test_a_corrupt_line_raises_rather_than_being_skipped(tmp_path):
    """A dropped line lowers the trial count, and a lower count makes
    every deflated Sharpe computed afterwards look better."""
    path = tmp_path / "trials.jsonl"
    path.write_text('{"config_hash": "aa"\n', "utf-8")
    with pytest.raises(TrialLogCorrupt, match="Refusing to skip"):
        TrialCounter(path).records()


def test_an_unlabelled_trial_is_refused(tmp_path):
    with pytest.raises(MetricsError, match="needs a description"):
        counter(tmp_path).record(config={}, description="   ", timestamp="2026-01-02")


def test_the_timestamp_is_an_argument_so_the_ledger_is_deterministic(tmp_path):
    c = counter(tmp_path)
    rec = c.record(config={}, description="x", timestamp="2026-01-02T09:30:00")
    assert rec.timestamp == "2026-01-02T09:30:00"
    with pytest.raises(MetricsError, match="timestamp must be"):
        c.record(config={}, description="x", timestamp=12345)


def test_an_absent_ledger_reads_as_empty_rather_than_raising(tmp_path):
    c = TrialCounter(tmp_path / "never-written.jsonl")
    assert c.records() == []
    assert c.count() == 0
    assert c.frame().empty


def test_the_counter_can_be_handed_straight_to_the_deflation(tmp_path):
    c = counter(tmp_path)
    for k in range(7):
        c.record(
            config={"variant": k},
            description=f"variant {k}",
            timestamp="2026-01-02",
        )
    out = deflated_sharpe_ratio(worked_returns(), trials=c)
    assert out.trials == 7


# -- the whole picture ----------------------------------------------------


def test_evaluate_without_a_trial_count_says_so_in_the_headline():
    """The absence is loud rather than defaulted to 1, because a silent
    N=1 would deflate nothing and read as if it had."""
    e = equity_from(worked_returns())
    report = evaluate(e)
    assert report.deflated is None
    assert "UNDEFLATED" in report.headline
    assert "Not reportable as an edge" in report.headline


def test_evaluate_with_a_trial_count_leads_with_the_verdict():
    e = equity_from(worked_returns())
    report = evaluate(e, trials=200)
    assert report.deflated is not None
    assert report.headline == report.deflated.verdict
    row = report.summary().iloc[0]
    assert row["trials"] == 200
    assert not row["significant"]
    assert not row["costs_supplied"]


def test_evaluate_agrees_with_the_pieces_it_is_made_of():
    e = equity_from(worked_returns())
    r = to_returns(e)
    report = evaluate(e, trials=1)
    assert report.cagr == pytest.approx(cagr(e))
    assert report.sharpe == pytest.approx(sharpe_ratio(r))
    assert report.annualised_volatility == pytest.approx(annualised_volatility(r))
    assert report.drawdown.depth == pytest.approx(max_drawdown(e).depth)
    assert report.n_sessions == len(r)
    assert report.total_return == pytest.approx(float(e.iloc[-1] / e.iloc[0] - 1.0))


def test_two_observations_is_the_floor():
    with pytest.raises(MetricsError, match="at least two"):
        evaluate(pd.Series([100.0], index=days(1)))
