"""The trend signal, tested for the things that would not show in review.

There is no price data to test against — the free endpoint is blocked
and the cache is cold — so everything here runs on frames generated
with a fixed seed or built by hand to make one arithmetic fact
checkable. That is a narrower claim than "the signal works" and it is
the only claim available; what these tests establish is that the
mechanics are what the docstring says they are.

The test that matters most is `test_score_at_T_survives_truncation`.
It cuts the frame off after T, recomputes, and demands the score at T
come back bit for bit identical. An off-by-one in a rolling window or
a stray `shift(-1)` is invisible to a reader, produces a beautiful
equity curve, and is the single most common way a project like this
fools itself. It cannot be tested by inspection, so it is tested by
truncation.

Everything else is a trap this signal is specifically shaped to avoid,
turned into an assertion:

  * a sleeve with too little history must return NO score, and the
    caller must be able to tell that from a score of zero;
  * a hole in the middle of a lookback window blocks the score rather
    than being computed around;
  * the signal reads `close_adj`, so a bond that is flat on price and
    up on total return scores as an uptrend — which is the whole
    measured fact about TLT and LQD;
  * a score is never negative, because there is nothing this account
    could do with a negative one;
  * the forward windows behind the diagnostics start the session AFTER
    the score, and the curve's weight lags by two.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine import metrics
from griffinquant.signals import trend
from griffinquant.signals.trend import (
    FILL_LAG_SESSIONS,
    LOOKBACKS,
    NOT_A_TREND_ASSET,
    TrendError,
    _forward_excess,
    attainable_levels,
    close_adj_panel,
    default_periods,
    evaluate,
    score_asof,
    trend_scores,
)

MAX_LOOKBACK = max(LOOKBACKS)
WARMUP = MAX_LOOKBACK + 1


def sessions(n: int, start: str = "2005-01-03") -> pd.DatetimeIndex:
    return pd.bdate_range(start, periods=n)


def random_panel(
    n: int = 1500,
    assets: tuple[str, ...] = ("SPY", "TLT", "DBC"),
    seed: int = 20050103,
    drift: float = 0.0003,
    vol: float = 0.010,
) -> pd.DataFrame:
    """A boring multi-asset panel. Nothing here is meant to trend."""
    rng = np.random.default_rng(seed)
    idx = sessions(n)
    data = {
        a: 100.0 * np.exp(np.cumsum(drift + vol * rng.standard_normal(n)))
        for a in assets
    }
    return pd.DataFrame(data, index=idx)


def ramp(values: list[tuple[int, float]], n: int) -> np.ndarray:
    """A piecewise-linear price path through the given (index, level) knots."""
    xs = np.array([k for k, _ in values], dtype="float64")
    ys = np.array([v for _, v in values], dtype="float64")
    return np.interp(np.arange(n, dtype="float64"), xs, ys)


def single(path: np.ndarray, name: str = "SPY") -> pd.DataFrame:
    return pd.DataFrame({name: path}, index=sessions(len(path)))


# -- the test that matters most -----------------------------------------


def test_score_at_T_survives_truncation():
    """The score at T must not move when the future is deleted.

    Recomputed on a frame that ends at T, every score and every
    per-lookback vote has to come back byte-identical. Exact equality,
    not a tolerance: a lookahead of one bar changes a value by a
    plausible-looking amount, and a tolerance is exactly what would let
    it through.
    """
    wide = random_panel(n=1400)
    full = trend_scores(wide)

    for offset in (0, 1, 5, 37, 200, 501, 999):
        t = len(wide) - 1 - offset
        truncated = trend_scores(wide.iloc[: t + 1])

        np.testing.assert_array_equal(
            truncated.score.iloc[-1].to_numpy(),
            full.score.iloc[t].to_numpy(),
        )
        np.testing.assert_array_equal(
            truncated.known.iloc[-1].to_numpy(),
            full.known.iloc[t].to_numpy(),
        )
        for lb in LOOKBACKS:
            np.testing.assert_array_equal(
                truncated.votes[lb].iloc[-1].to_numpy(),
                full.votes[lb].iloc[t].to_numpy(),
            )


def test_truncation_holds_with_a_risk_free_series_too():
    """The hurdle is a rolling window as well, and rolls the same way."""
    wide = random_panel(n=900)
    rf = pd.Series(
        0.01 + 0.03 * np.abs(np.sin(np.arange(len(wide)) / 90.0)),
        index=wide.index,
    )
    full = trend_scores(wide, risk_free=rf)

    for t in (700, 850, len(wide) - 1):
        cut = trend_scores(wide.iloc[: t + 1], risk_free=rf.iloc[: t + 1])
        np.testing.assert_array_equal(
            cut.score.iloc[-1].to_numpy(), full.score.iloc[t].to_numpy()
        )


def test_changing_a_future_bar_moves_nothing_at_or_before_T():
    """The complement of the truncation test, and it catches a
    different bug.

    Truncation would not notice a signal that normalised across the
    whole sample — deleting the future changes the normaliser and the
    score with it, which reads as a failure and gets "fixed" the wrong
    way. Editing one future bar in place and demanding the entire past
    stay put catches that, and catches a `shift(-1)` too.
    """
    wide = random_panel(n=900)
    before = trend_scores(wide)

    t = 600
    poked = wide.copy()
    poked.iloc[t + 1 :, 0] *= 3.0
    after = trend_scores(poked)

    np.testing.assert_array_equal(
        after.score.iloc[: t + 1].to_numpy(),
        before.score.iloc[: t + 1].to_numpy(),
    )
    np.testing.assert_array_equal(
        after.known.iloc[: t + 1].to_numpy(),
        before.known.iloc[: t + 1].to_numpy(),
    )


def test_a_sleeve_is_scored_alone_and_not_against_its_neighbours():
    """This is a TIME-SERIES signal, not a cross-sectional one.

    A ranking or a z-score across sleeves would make a column's answer
    depend on what else happened to be in the frame — which is the
    fitted-in-company failure at the level of a single function.
    """
    wide = random_panel(n=900, assets=("SPY", "TLT", "DBC"))
    together = trend_scores(wide).score["SPY"]
    alone = trend_scores(wide[["SPY"]]).score["SPY"]
    np.testing.assert_array_equal(together.to_numpy(), alone.to_numpy())

    shifted = wide.assign(TLT=wide["TLT"] * 100.0, DBC=wide["DBC"] * 0.01)
    np.testing.assert_array_equal(
        trend_scores(shifted).score["SPY"].to_numpy(), alone.to_numpy()
    )


def test_score_asof_matches_the_panel_last_row():
    """The cheap tail-only path is the expensive path, exactly."""
    wide = random_panel(n=1100)
    for t in (WARMUP, WARMUP + 3, 800, len(wide) - 1):
        tail = wide.iloc[: t + 1]
        np.testing.assert_array_equal(
            score_asof(tail).to_numpy(),
            trend_scores(tail).score.iloc[-1].to_numpy(),
        )


# -- the shape of the score ---------------------------------------------


def test_scores_are_bounded_and_never_negative():
    """Zero is the floor. A negative score is an instruction this
    account cannot carry out, and a sizing layer given one would either
    clip it or place a short."""
    score = trend_scores(random_panel()).score
    values = score.to_numpy()
    live = values[np.isfinite(values)]
    assert live.size > 0
    assert live.min() >= 0.0
    assert live.max() <= 1.0


def test_scores_take_only_the_attainable_levels():
    """The range is [0, 1] and the interior is not dense — a sizing
    layer that wants to interpolate should know that."""
    score = trend_scores(random_panel()).score
    values = score.to_numpy()
    live = np.unique(values[np.isfinite(values)])
    expected = attainable_levels(LOOKBACKS)

    assert len(expected) == len(LOOKBACKS) + 1
    for v in live:
        assert min(abs(v - e) for e in expected) < 1e-12
    # The fixture is long and noisy enough to visit every level.
    assert len(live) == len(expected)


def test_a_rising_series_scores_one_and_a_falling_series_scores_zero():
    n = WARMUP + 40
    up = single(100.0 * np.exp(np.linspace(0.0, 1.0, n)))
    down = single(100.0 * np.exp(np.linspace(0.0, -1.0, n)))

    assert trend_scores(up).score.iloc[-1].iloc[0] == 1.0
    assert trend_scores(down).score.iloc[-1].iloc[0] == 0.0


def test_horizons_can_disagree_and_the_blend_says_so():
    """A V-shaped path is up over three months and down over twelve.

    Both knots are chosen so the arithmetic is checkable by hand, which
    is the point: the blend is a plain average of votes and a reader
    should be able to confirm the fraction without running anything.
    """
    n = 400
    three, six, _ = LOOKBACKS

    # Down for most of the sample, up over the last three months only.
    one_third = single(ramp([(0, 200.0), (n - 1 - three, 100.0), (n - 1, 110.0)], n))
    scored = trend_scores(one_third).score.iloc[-1].iloc[0]
    assert scored == pytest.approx(1.0 / 3.0)

    # Up over three and six months, still down over twelve.
    two_thirds = single(ramp([(0, 200.0), (n - 1 - six, 100.0), (n - 1, 140.0)], n))
    scored = trend_scores(two_thirds).score.iloc[-1].iloc[0]
    assert scored == pytest.approx(2.0 / 3.0)


# -- the abstention -----------------------------------------------------


def test_short_history_gets_no_score_rather_than_a_neutral_one():
    """NaN, and never 0.5 or 0.0.

    "The trend is neutral", "there is no trend" and "we have not earned
    an opinion" are three different claims. Collapsing the third into
    either of the first two is how a backtest acquires a view it could
    not have held.
    """
    wide = random_panel(n=WARMUP + 10)
    panel = trend_scores(wide)

    early = panel.score.iloc[: WARMUP - 1]
    assert early.isna().to_numpy().all()
    assert not panel.known.iloc[: WARMUP - 1].to_numpy().any()

    # And the first scored row is exactly where the longest window fills.
    assert panel.known.iloc[WARMUP - 1].all()
    assert panel.score.iloc[WARMUP - 1].notna().all()


def test_a_late_listing_is_blocked_until_its_own_window_fills():
    """DBC lists thirteen months into the sample; it does not get a
    score until it has a full twelve months of its own history."""
    n = 900
    wide = random_panel(n=n)
    listed_at = 300
    wide = wide.assign(
        DBC=wide["DBC"].where(
            wide.index >= wide.index[listed_at], other=float("nan")
        )
    )
    panel = trend_scores(wide)

    known = panel.known["DBC"].to_numpy()
    first = int(np.flatnonzero(known)[0])
    assert first == listed_at + MAX_LOOKBACK
    assert panel.score["DBC"].iloc[:first].isna().all()

    coverage = panel.coverage().set_index("asset")
    assert coverage.loc["DBC", "first_scored"] == wide.index[first]
    assert coverage.loc["DBC", "blocked"] == first


def test_a_hole_inside_the_window_blocks_the_score():
    """Endpoints are not enough. A gap means the vehicle was not
    trading, and a point-to-point return across it is computed over a
    period nobody observed."""
    n = WARMUP + 400
    wide = random_panel(n=n, assets=("SPY",))
    hole = WARMUP + 40

    clean = trend_scores(wide)
    assert clean.known["SPY"].iloc[hole]
    assert clean.known["SPY"].iloc[hole + MAX_LOOKBACK]

    holed = wide.copy()
    holed.iloc[hole, 0] = float("nan")
    panel = trend_scores(holed)

    # Blocked for as long as the hole sits inside the longest window,
    # and released the session after it falls out the far end.
    assert not panel.known["SPY"].iloc[hole]
    assert math.isnan(panel.score["SPY"].iloc[hole])
    assert not panel.known["SPY"].iloc[hole + MAX_LOOKBACK]
    assert panel.known["SPY"].iloc[hole + MAX_LOOKBACK + 1]


def test_a_non_positive_price_is_not_a_price():
    n = WARMUP + 5
    wide = random_panel(n=n, assets=("SPY",))
    wide.iloc[n - 3, 0] = 0.0
    panel = trend_scores(wide)
    assert not panel.known["SPY"].iloc[-1]


def test_known_frame_separates_no_score_from_a_score_of_zero():
    """The caller must be able to tell them apart without inspecting NaN."""
    n = WARMUP + 30
    falling = single(100.0 * np.exp(np.linspace(0.0, -1.0, n)))
    panel = trend_scores(falling)

    assert panel.score.iloc[-1].iloc[0] == 0.0
    assert bool(panel.known.iloc[-1].iloc[0]) is True

    assert math.isnan(panel.score.iloc[0].iloc[0])
    assert bool(panel.known.iloc[0].iloc[0]) is False


def test_as_of_refuses_a_date_that_is_not_a_session():
    panel = trend_scores(random_panel(n=400))
    with pytest.raises(TrendError, match="not a session"):
        panel.as_of("2005-01-01")


# -- the measured fact about bonds --------------------------------------


def test_the_signal_reads_total_return_not_price():
    """A coupon-only instrument is an uptrend, and the whole project
    turns on that.

    Over 2004-2026 TLT returned -2.6% on price and +105.8% on total
    return. Here `close_unadj` falls and `close_adj` rises; a signal
    reading the wrong column would score this zero and teach the
    allocator that the defensive sleeve is dead weight.
    """
    n = WARMUP + 30
    idx = sessions(n)
    price = 100.0 * np.exp(np.linspace(0.0, -0.05, n))
    total = 100.0 * np.exp(np.linspace(0.0, 0.60, n))
    long_frame = pd.DataFrame(
        {
            "date": idx,
            "ticker": "TLT",
            "close_unadj": price,
            "close_adj": total,
        }
    )

    wide = close_adj_panel(long_frame)
    assert np.allclose(wide["TLT"].to_numpy(), total)
    assert trend_scores(wide).score.iloc[-1].iloc[0] == 1.0

    report = evaluate(long_frame, n_bootstrap=32)
    assert report.curve_summary["asset"].unique().tolist() == ["TLT"]


def test_close_adj_panel_refuses_a_recycled_ticker():
    idx = sessions(4)
    doubled = pd.DataFrame(
        {
            "date": list(idx) + list(idx),
            "ticker": ["WM"] * 8,
            "close_adj": np.arange(8, dtype="float64") + 1.0,
        }
    )
    with pytest.raises(TrendError, match="recycled-symbol"):
        close_adj_panel(doubled)


# -- the hurdle ---------------------------------------------------------


def test_the_risk_free_hurdle_can_switch_a_weak_uptrend_off():
    """A drift of two percent a year is a trend against a zero hurdle
    and is not one against cash paying five."""
    n = WARMUP + 30
    weak = single(100.0 * np.exp(np.linspace(0.0, 0.02 * n / 252.0, n)))

    assert trend_scores(weak).score.iloc[-1].iloc[0] == 1.0
    assert trend_scores(weak, risk_free=0.05).score.iloc[-1].iloc[0] == 0.0


def test_a_rate_in_percent_raises_rather_than_setting_an_impossible_hurdle():
    with pytest.raises(TrendError, match="divide by 100"):
        trend_scores(random_panel(n=300), risk_free=5.25)


def test_a_rate_series_that_misses_the_start_raises():
    wide = random_panel(n=300)
    rf = pd.Series(0.02, index=wide.index[50:])
    with pytest.raises(TrendError, match="does not cover"):
        trend_scores(wide, risk_free=rf)


# -- input refusals -----------------------------------------------------


def test_unsorted_or_duplicated_sessions_raise():
    wide = random_panel(n=300)
    with pytest.raises(TrendError, match="sorted"):
        trend_scores(wide.iloc[::-1])
    with pytest.raises(TrendError, match="duplicate"):
        trend_scores(pd.concat([wide, wide.iloc[[-1]]]))


def test_a_repeated_lookback_is_a_hidden_reweighting():
    wide = random_panel(n=400)
    with pytest.raises(TrendError, match="hidden"):
        trend_scores(wide, lookbacks=(63, 63, 252))
    with pytest.raises(TrendError, match="at least one lookback"):
        trend_scores(wide, lookbacks=())


def test_an_empty_panel_raises():
    with pytest.raises(TrendError, match="no assets"):
        trend_scores(pd.DataFrame(index=sessions(10)))


# -- the forward windows behind the diagnostics -------------------------


def test_forward_window_starts_the_session_after_the_score():
    """`rolling(h).sum().shift(-h)`, and the other order is a whole
    bar of lookahead that no print would show."""
    n = 30
    idx = sessions(n)
    r = pd.DataFrame(
        {"A": np.linspace(0.001, 0.030, n)}, index=idx
    )
    rf = pd.Series(0.0, index=idx)

    for h in (1, 5):
        fwd = _forward_excess(r, rf, h)
        for t in (0, 3, n - h - 1):
            want = float(np.prod(1.0 + r["A"].to_numpy()[t + 1 : t + 1 + h]) - 1.0)
            assert fwd["A"].iloc[t] == pytest.approx(want, rel=1e-12)
        # No forward return exists for the last h rows, and none is
        # invented.
        assert fwd["A"].iloc[-h:].isna().all()


def test_forward_excess_subtracts_the_cash_leg():
    n = 20
    idx = sessions(n)
    r = pd.DataFrame({"A": np.full(n, 0.0)}, index=idx)
    rf = pd.Series(0.0002, index=idx)
    fwd = _forward_excess(r, rf, 5)
    assert fwd["A"].iloc[0] == pytest.approx(-((1.0002**5) - 1.0), rel=1e-12)


# -- the standalone evaluation ------------------------------------------


#: Long enough to reach every window in `metrics.REPORT_PERIODS`. A
#: shorter fixture would silently skip 2018Q4 and 2020Q1 and the
#: sub-period assertions below would pass by having nothing to check.
EVAL_SESSIONS = 5_400


def evaluated(**kwargs):
    wide = random_panel(n=EVAL_SESSIONS, assets=("SPY", "TLT", "DBC", "BIL"))
    return wide, evaluate(wide, n_bootstrap=kwargs.pop("n_bootstrap", 48), **kwargs)


def test_evaluate_produces_every_promised_table():
    wide, report = evaluated()

    for frame in (report.ic, report.hit_rate, report.spread, report.curve_summary):
        assert len(frame) > 0

    assert {"scope", "period", "horizon", "ic", "ci_low", "ci_high", "n"} <= set(
        report.ic.columns
    )
    assert {"hit_rate_on", "hit_rate_off", "base_rate_positive"} <= set(
        report.hit_rate.columns
    )
    assert {"mean_on", "mean_off", "spread"} <= set(report.spread.columns)
    assert {"strat_sharpe", "bh_sharpe", "annual_turnover", "cost_drag_bps"} <= set(
        report.curve_summary.columns
    )

    live = report.ic["ic"].dropna()
    assert live.between(-1.0, 1.0).all()

    assert set(report.ic["horizon"].unique()) == {1, 21}
    assert "pooled" in set(report.ic["scope"])
    assert len(report.headline()) == 2

    for name, curve in report.curves.items():
        assert curve.index.equals(wide.index)
        assert (curve > 0).all()
        assert name in report.benchmarks


def test_evaluate_breaks_out_by_subperiod_rather_than_reporting_one_number():
    """Calendar years are the exhaustive partition; the named windows
    overlap and are labelled so nobody sums them."""
    wide, report = evaluated()

    kinds = set(report.ic["kind"])
    assert {"full", "year", "stress"} <= kinds

    years = {str(y) for y in sorted({int(y) for y in wide.index.year})}
    assert years <= set(report.ic["period"])

    named = {p.name for p in metrics.REPORT_PERIODS}
    assert named <= set(report.ic["period"])

    # Every year appears for every scope and horizon, so a signal that
    # only worked in one of them has nowhere to hide.
    scopes = set(report.ic["scope"])
    per_year = report.ic.loc[report.ic["kind"] == "year"]
    assert len(per_year) == len(years) * len(scopes) * 2


def test_default_periods_cover_the_sample_exhaustively():
    idx = sessions(1500)
    windows = default_periods(idx)
    year_windows = [w for w in windows if w.name.isdigit()]
    covered = np.zeros(len(idx), dtype=bool)
    for w in year_windows:
        covered |= trend._period_mask(idx, w)
    assert covered.all()


def test_evaluate_excludes_the_cash_sleeve_by_default():
    """Trend on the residual is a statement about the hurdle."""
    wide, report = evaluated()
    assert "BIL" in wide.columns
    assert "BIL" not in report.curves
    assert "BIL" not in set(report.ic["scope"])
    assert report.conventions["excluded"] == "BIL"

    kept = evaluate(wide, exclude=frozenset(), n_bootstrap=16)
    assert "BIL" in kept.curves
    assert "BIL" in NOT_A_TREND_ASSET


def test_the_curve_weight_is_the_score_lagged_two_sessions():
    """One session would collect the overnight gap in the direction of
    our own signal, which is the leak the engine exists to refuse."""
    wide, report = evaluated()
    panel = trend_scores(wide.drop(columns=["BIL"]))
    want = panel.score.shift(FILL_LAG_SESSIONS).fillna(0.0)
    pd.testing.assert_frame_equal(report.weights, want)


def test_an_unscored_session_is_held_flat():
    """With no opinion the money sits in cash, which asserts nothing
    about the sleeve — and with a zero rate the curve is exactly flat."""
    n = WARMUP + 100
    rising = single(100.0 * np.exp(np.linspace(0.0, 0.8, n)))
    report = evaluate(rising, n_bootstrap=8)
    curve = report.curves["SPY"]

    # Scored from WARMUP-1, in force FILL_LAG sessions later.
    assert (curve.iloc[: WARMUP - 1 + FILL_LAG_SESSIONS] == 1.0).all()
    assert curve.iloc[-1] > 1.0


def test_costs_only_ever_subtract():
    wide = random_panel(n=1200, assets=("SPY",))
    free = evaluate(wide, cost_bps=0.0, n_bootstrap=8)
    charged = evaluate(wide, cost_bps=25.0, n_bootstrap=8)

    assert charged.curves["SPY"].iloc[-1] < free.curves["SPY"].iloc[-1]

    full_free = free.curve_summary.loc[
        free.curve_summary["period"] == "full sample"
    ].iloc[0]
    full_charged = charged.curve_summary.loc[
        charged.curve_summary["period"] == "full sample"
    ].iloc[0]
    assert full_free["cost_drag_bps"] == 0.0
    assert full_charged["cost_drag_bps"] > 0.0
    assert full_free["annual_turnover"] == pytest.approx(
        full_charged["annual_turnover"]
    )


def test_the_benchmark_is_the_sleeve_itself():
    """A long/flat curve that merely tracks the asset is not evidence,
    so buy-and-hold rides in the same table."""
    wide = random_panel(n=1000, assets=("SPY",))
    report = evaluate(wide, n_bootstrap=8)
    bh = report.benchmarks["SPY"]
    want = (wide["SPY"] / wide["SPY"].iloc[0]).to_numpy()
    # cumprod of simple returns, anchored at the first bar.
    assert bh.iloc[-1] == pytest.approx(want[-1], rel=1e-9)


def test_pooled_observation_count_is_the_sum_over_the_sleeves():
    _, report = evaluated()
    full = report.ic.loc[
        (report.ic["period"] == "full sample") & (report.ic["horizon"] == 21)
    ].set_index("scope")
    pooled = int(full.loc["pooled", "n"])
    parts = int(full.drop(index="pooled")["n"].sum())
    assert pooled == parts


def test_the_interval_is_deterministic_given_the_seed():
    """A diagnostic whose interval moves between runs invites rerunning
    it until the interval reads well."""
    wide = random_panel(n=1200, assets=("SPY", "TLT"))
    a = evaluate(wide, n_bootstrap=64)
    b = evaluate(wide, n_bootstrap=64)
    pd.testing.assert_frame_equal(a.ic, b.ic)

    c = evaluate(wide, n_bootstrap=64, seed=1)
    assert not np.allclose(
        a.ic["ci_low"].fillna(-9.0), c.ic["ci_low"].fillna(-9.0)
    )


def test_too_few_blocks_withholds_the_interval_rather_than_widening_it():
    _, report = evaluated()
    short = report.ic.loc[report.ic["period"] == "2018Q4"]
    assert len(short) > 0
    starved = short.loc[short["n_blocks"] < trend.MIN_BLOCKS_FOR_CI]
    assert len(starved) > 0
    assert starved["ci_low"].isna().all()
    assert starved["note"].str.contains("fewer than").all()


def test_a_constant_score_reports_no_correlation_rather_than_zero():
    """"The signal never varied here" and "the signal was uncorrelated
    here" are different findings, and a printed zero reads as the
    second."""
    n = 1400
    rising = single(100.0 * np.exp(np.linspace(0.0, 1.4, n)))
    report = evaluate(rising, n_bootstrap=16)
    full = report.ic.loc[
        (report.ic["period"] == "full sample") & (report.ic["horizon"] == 1)
    ].iloc[0]
    assert math.isnan(full["ic"])
    assert math.isnan(full["ci_low"])
    assert "never varied" in full["note"]


def test_the_hit_rate_carries_its_own_base_rate():
    """A hit rate quoted alone always reads as skill."""
    _, report = evaluated()
    row = report.hit_rate.loc[
        (report.hit_rate["scope"] == "pooled")
        & (report.hit_rate["period"] == "full sample")
        & (report.hit_rate["horizon"] == 21)
    ].iloc[0]
    assert 0.0 <= row["base_rate_positive"] <= 1.0
    assert row["lift_on"] == pytest.approx(
        row["hit_rate_on"] - row["base_rate_positive"]
    )


def test_the_measurement_finds_a_trend_that_is_really_there():
    """A sanity check on the instrument, not on the strategy.

    The series below is built to trend by construction — long regimes
    of one-sided drift swamped only slightly by noise — so a working
    IC has to come back positive on it. This says nothing about
    whether markets behave that way; it says the correlation is wired
    up the right way round, which is the failure a NEGATIVE sign would
    have hidden behind a plausible-looking number.
    """
    rng = np.random.default_rng(11)
    regime = 400
    n = regime * 8
    drift = np.repeat(
        np.where(np.arange(8) % 2 == 0, 0.0012, -0.0012), regime
    )
    path = 100.0 * np.exp(np.cumsum(drift + 0.003 * rng.standard_normal(n)))
    report = evaluate(single(path), n_bootstrap=64)

    row = report.ic.loc[
        (report.ic["scope"] == "pooled")
        & (report.ic["period"] == "full sample")
        & (report.ic["horizon"] == 21)
    ].iloc[0]
    assert row["ic"] > 0.0
    assert row["ci_low"] > 0.0

    spread = report.spread.loc[
        (report.spread["scope"] == "pooled")
        & (report.spread["period"] == "full sample")
        & (report.spread["horizon"] == 21)
    ].iloc[0]
    assert spread["spread"] > 0.0


def test_conventions_state_what_the_numbers_mean():
    _, report = evaluated()
    conventions = report.conventions
    assert "close_adj" in conventions["prices"]
    assert "upper bound" in conventions["forward_returns"]
    assert str(FILL_LAG_SESSIONS) in conventions["curve_fill"]
    assert "bootstrap" in conventions["interval"]
    assert "ZERO" in conventions["risk_free"]
