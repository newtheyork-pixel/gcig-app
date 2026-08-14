"""The cost model, held to the numbers it was calibrated against.

A cost model is the easiest thing in a backtest to argue with after the
fact, which is why this one is fixed before there is a result to
protect and why the tests below check the two properties that make it
falsifiable rather than merely conservative.

The first is that the spread is a FUNCTION OF LIQUIDITY and monotone in
it. A flat assumption does not fail loudly, it fails in the direction
of the trades the excess return is coming from: charge everything ten
basis points and the sleeve ETFs are billed seven times what they cost
while the small caps are billed under a third. So the curve is tested
at the brief's three anchors and swept for monotonicity across five
orders of magnitude of dollar volume.

The second is that the stress ladder means what it says. `multiple`
has to scale the whole cost linearly or the 2x and 3x runs are not a
stress of this model, they are three unrelated models sharing a name —
and the sentence the ladder exists to support ("the result survives at
three times the assumed friction") stops being checkable.

One convention worth restating, because half these assertions depend on
it: the anchors are FULL QUOTED spreads, which is how spreads are
quoted, and a single execution is charged half of one.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine.costs import (
    DEFAULT_DAILY_VOLATILITY,
    DEFAULT_IMPACT_COEFFICIENT,
    STRESS_MULTIPLES,
    CostModel,
    estimated_quoted_spread_bps,
    stress_ladder,
)

MODEL = CostModel()

#: The brief's calibration points, as (dollar volume, low, high) in
#: basis points of FULL quoted spread. The dollar figures are the middle
#: of the range each band plausibly describes rather than the edge, so
#: an anchor that drifts a little still fails these rather than sitting
#: exactly on a boundary and passing by luck.
ETF_ADV = 2_000_000_000.0
LARGE_CAP_ADV = 150_000_000.0
LIQUIDITY_FLOOR_ADV = 5_000_000.0  # the universe screen's own floor


def cost(notional: float, adv: float, vol: float | None = None, **kw):
    return MODEL.cost_bps(
        trade_notional=notional,
        median_dollar_volume=adv,
        daily_volatility=vol,
        **kw,
    )


# -- the spread curve, at the anchors ------------------------------------


def test_a_major_sleeve_etf_costs_one_to_two_basis_points():
    assert 1.0 <= estimated_quoted_spread_bps(ETF_ADV) <= 2.0
    # And every ETF-scale name, not just the one sampled.
    for adv in (7e8, 1e9, 5e9, 1e10, 1e12):
        assert 1.0 <= estimated_quoted_spread_bps(adv) <= 2.0


def test_a_large_cap_costs_three_to_eight_basis_points():
    assert estimated_quoted_spread_bps(LARGE_CAP_ADV) == pytest.approx(5.0)
    for adv in (7e7, 1e8, 2e8, 3e8):
        assert 3.0 <= estimated_quoted_spread_bps(adv) <= 8.0


def test_a_name_at_the_liquidity_floor_costs_twenty_to_fifty():
    assert estimated_quoted_spread_bps(LIQUIDITY_FLOOR_ADV) == pytest.approx(35.0)
    for adv in (2.5e6, 5e6, 1.2e7):
        assert 20.0 <= estimated_quoted_spread_bps(adv) <= 50.0


def test_the_curve_never_gets_cheaper_as_a_name_gets_thinner():
    """Monotonicity is the one property the table has to have, and
    np.interp would happily fit a curve that lost it: it demands only
    that the x-axis ascends."""
    adv = np.logspace(4.0, 12.0, 2_001)
    spread = estimated_quoted_spread_bps(adv)
    assert np.all(np.diff(spread) <= 1e-12)
    # Strictly decreasing where the anchors actually live, so a curve
    # that had gone flat everywhere would not pass on the weak version.
    interior = estimated_quoted_spread_bps(np.logspace(6.0, 9.0, 200))
    assert np.all(np.diff(interior) < 0.0)


def test_the_curve_stops_extrapolating_at_both_ends():
    """Flat outside the anchors is a refusal to guess, not an estimate.

    Below the floor the names have already been thrown out by the
    universe screen; above it, no amount of volume buys a market tighter
    than the minimum tick.
    """
    assert estimated_quoted_spread_bps(1.0) == estimated_quoted_spread_bps(500_000.0)
    assert estimated_quoted_spread_bps(1e10) == estimated_quoted_spread_bps(1e15)
    assert estimated_quoted_spread_bps(1e15) == pytest.approx(1.0)


def test_one_execution_is_charged_half_the_quoted_spread():
    full = estimated_quoted_spread_bps(LARGE_CAP_ADV)
    assert cost(10_000.0, LARGE_CAP_ADV).spread_bps == pytest.approx(full / 2.0)


def test_an_unknown_liquidity_is_priced_as_the_worst_name_on_the_curve():
    """Treating a missing ADV as infinite depth prices a free trade in
    the one name we know least about."""
    worst = estimated_quoted_spread_bps(1.0)
    for missing in (float("nan"), 0.0, -1.0, float("inf")):
        assert cost(1_000.0, missing).spread_bps == pytest.approx(worst / 2.0)


def test_a_real_quote_beats_the_proxy_and_a_missing_one_does_not_go_free():
    """Partial quote coverage must not be all-or-nothing: a row with no
    book falls back to the curve on its own."""
    adv = pd.Series([LARGE_CAP_ADV, LARGE_CAP_ADV], index=["a", "b"])
    quoted = pd.Series([2.0, float("nan")], index=["a", "b"])
    out = MODEL.cost_bps(
        trade_notional=pd.Series([1_000.0, 1_000.0], index=["a", "b"]),
        median_dollar_volume=adv,
        quoted_spread_bps=quoted,
    )
    assert out.spread_bps["a"] == pytest.approx(1.0)
    assert out.spread_bps["b"] == pytest.approx(2.5)


# -- impact ---------------------------------------------------------------


def test_impact_is_the_square_root_of_participation():
    """Quadruple the order, double the impact rate. Not approximately —
    the whole content of the term is that exponent."""
    adv = LARGE_CAP_ADV
    small = cost(10_000.0, adv, 0.02).impact_bps
    big = cost(40_000.0, adv, 0.02).impact_bps
    assert big == pytest.approx(2.0 * small)

    # And the same law read the other way: sixteen times the order is
    # four times the rate, which is sixty-four times the dollars.
    huge = cost(160_000.0, adv, 0.02).impact_bps
    assert huge == pytest.approx(4.0 * small)
    assert cost(160_000.0, adv, 0.02).impact_dollars == pytest.approx(
        64.0 * cost(10_000.0, adv, 0.02).impact_dollars
    )


def test_impact_matches_the_stated_formula_to_the_last_digit():
    """`Y * sigma * sqrt(participation)`, in basis points. Written out
    here so the coefficient cannot quietly acquire a second decimal
    place without somebody being asked about it."""
    notional, adv, vol = 25_000.0, 4e8, 0.013
    expected = (
        DEFAULT_IMPACT_COEFFICIENT * vol * np.sqrt(notional / adv) * 1e4
    )
    out = cost(notional, adv, vol)
    assert out.impact_bps == pytest.approx(expected)
    assert out.participation == pytest.approx(notional / adv)


def test_a_missing_volatility_is_priced_at_two_percent_a_day():
    """Conservative exactly where the data is thin: two percent is an
    ordinary single name and a wild sleeve ETF."""
    supplied = cost(10_000.0, LARGE_CAP_ADV, DEFAULT_DAILY_VOLATILITY).impact_bps
    for missing in (None, float("nan"), -0.01):
        assert cost(10_000.0, LARGE_CAP_ADV, missing).impact_bps == pytest.approx(
            supplied
        )


def test_impact_keeps_answering_past_the_point_of_absurdity():
    """No ceiling, unlike the spread. An order at three times a day's
    volume should come back priced like the impossibility it is rather
    than clipped to something a sizing routine would accept."""
    silly = cost(3e8, 1e8, 0.02)
    assert silly.participation == pytest.approx(3.0)
    assert silly.impact_bps > 300.0


def test_at_the_funds_actual_size_impact_is_a_rounding_error():
    """The arithmetic from the module comment, pinned.

    $1,300 into the thinnest name the universe admits is 0.026% of a
    day's volume, and against 2%-a-day vol that is about three basis
    points. The term is carried for the day the endowment is ten times
    bigger, not because it binds now — and a test is the only thing
    stopping somebody deleting it as dead weight.
    """
    out = cost(1_300.0, LIQUIDITY_FLOOR_ADV, 0.02)
    assert out.participation == pytest.approx(0.00026)
    assert 3.0 < out.impact_bps < 3.5
    assert cost(1_300.0, ETF_ADV, 0.01).impact_bps < 0.1


# -- the stress ladder ----------------------------------------------------


@pytest.mark.parametrize("multiple", [1.0, 1.5, 2.0, 3.0, 7.0])
def test_the_multiplier_is_linear_in_every_component(multiple):
    base = cost(50_000.0, LARGE_CAP_ADV, 0.015)
    scaled = CostModel().scaled(multiple).cost_bps(
        trade_notional=50_000.0,
        median_dollar_volume=LARGE_CAP_ADV,
        daily_volatility=0.015,
    )
    assert scaled.spread_bps == pytest.approx(multiple * base.spread_bps)
    assert scaled.impact_bps == pytest.approx(multiple * base.impact_bps)
    assert scaled.total_bps == pytest.approx(multiple * base.total_bps)
    assert scaled.total_dollars == pytest.approx(multiple * base.total_dollars)
    # Participation is a fact about the order, not about our assumptions.
    assert scaled.participation == pytest.approx(base.participation)


def test_scaling_returns_a_new_model_and_leaves_the_old_one_alone():
    base = CostModel()
    doubled = base.scaled(2.0)
    assert base.multiple == 1.0
    assert doubled.multiple == 2.0
    assert doubled is not base
    assert doubled.impact_coefficient == base.impact_coefficient


def test_the_ladder_is_the_three_runs_the_brief_requires():
    ladder = stress_ladder()
    assert tuple(m.multiple for m in ladder) == STRESS_MULTIPLES == (1.0, 2.0, 3.0)
    assert all(isinstance(m, CostModel) for m in ladder)
    # Built from a supplied base rather than the default, so a run with
    # a different impact prior still stresses ITS OWN assumption.
    custom = stress_ladder(CostModel(impact_coefficient=0.6))
    assert all(m.impact_coefficient == 0.6 for m in custom)


def test_every_breakdown_says_which_run_produced_it():
    """Three sets of numbers on one page must not be confusable."""
    for model in stress_ladder():
        out = model.cost_bps(trade_notional=1_000.0, median_dollar_volume=1e8)
        assert out.multiple == model.multiple
        assert out.as_dict()["multiple"] == model.multiple
        assert f"{model.multiple:g}x" in model.label


@pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf")])
def test_a_nonsense_multiple_is_refused(bad):
    with pytest.raises(ValueError, match="multiple must be positive"):
        CostModel(multiple=bad)


def test_a_negative_impact_coefficient_is_refused():
    with pytest.raises(ValueError, match="impact_coefficient"):
        CostModel(impact_coefficient=-0.1)
    # Zero is allowed: "spread only" is a legitimate sensitivity.
    assert CostModel(impact_coefficient=0.0).cost_bps(
        trade_notional=1e6, median_dollar_volume=1e6
    ).impact_bps == 0.0


# -- degenerate orders ----------------------------------------------------


def test_a_zero_size_trade_costs_nothing():
    """The rate is still a rate — a spread does not vanish because
    nobody crossed it — but not a cent changes hands, and the impact of
    an order nobody placed is zero rather than a limit."""
    out = cost(0.0, LARGE_CAP_ADV, 0.02)
    assert out.notional == 0.0
    assert out.participation == 0.0
    assert out.impact_bps == 0.0
    assert out.spread_dollars == 0.0
    assert out.impact_dollars == 0.0
    assert out.total_dollars == 0.0
    assert out.spread_bps > 0.0


def test_direction_is_irrelevant():
    """A model that charged only buys would make the rebalance look half
    price."""
    buy = cost(1_300.0, LARGE_CAP_ADV, 0.02)
    sell = cost(-1_300.0, LARGE_CAP_ADV, 0.02)
    assert sell.notional == buy.notional == 1_300.0
    assert sell.total_bps == pytest.approx(buy.total_bps)
    assert sell.total_dollars == pytest.approx(buy.total_dollars)


def test_dollars_are_basis_points_of_the_notional():
    out = cost(80_000.0, 2.5e8, 0.011)
    assert out.spread_dollars == pytest.approx(80_000.0 * out.spread_bps / 1e4)
    assert out.impact_dollars == pytest.approx(80_000.0 * out.impact_bps / 1e4)
    assert out.total_dollars == pytest.approx(
        out.spread_dollars + out.impact_dollars
    )


# -- shapes ---------------------------------------------------------------


def test_a_series_in_is_a_series_out_on_the_same_index():
    """Not cosmetic. A bare ndarray handed back to a caller who passed a
    FILTERED Series aligns positionally the moment it is assigned into a
    frame, and the result is a cost column that is merely shuffled —
    every value plausible, none attached to its own trade."""
    idx = pd.Index(["TLT", "SPY", "MLAB"], name="ticker")
    notional = pd.Series([1_000.0, 2_000.0, 3_000.0], index=idx)
    adv = pd.Series([2e9, 3e10, 6e6], index=idx)
    out = MODEL.cost_bps(trade_notional=notional, median_dollar_volume=adv)

    for field in (out.spread_bps, out.impact_bps, out.participation, out.notional):
        assert isinstance(field, pd.Series)
        assert field.index.equals(idx)
    # The thin name is the expensive one, which is the whole point of
    # the curve and is checkable in one line here.
    assert out.spread_bps["MLAB"] > out.spread_bps["TLT"] > out.spread_bps["SPY"]


def test_an_array_in_is_an_array_out_and_a_scalar_stays_a_scalar():
    arr = MODEL.cost_bps(
        trade_notional=np.array([1e3, 1e4]), median_dollar_volume=np.array([1e8, 1e8])
    )
    assert isinstance(arr.total_bps, np.ndarray)
    assert arr.total_bps.shape == (2,)

    one = MODEL.cost_bps(trade_notional=1e3, median_dollar_volume=1e8)
    assert isinstance(one.spread_bps, float)
    assert isinstance(one.total_dollars, float)


def test_a_whole_days_trade_list_prices_row_by_row():
    """Vectorised and scalar have to agree, or a day's total depends on
    how the loop was written."""
    notionals = [1_300.0, 20_000.0, 500.0]
    advs = [5e6, 3e9, 4e7]
    vols = [0.02, 0.008, 0.03]
    batch = MODEL.cost_bps(
        trade_notional=np.array(notionals),
        median_dollar_volume=np.array(advs),
        daily_volatility=np.array(vols),
    )
    for k, (n, a, v) in enumerate(zip(notionals, advs, vols)):
        one = cost(n, a, v)
        assert batch.total_bps[k] == pytest.approx(one.total_bps)
        assert batch.total_dollars[k] == pytest.approx(one.total_dollars)
