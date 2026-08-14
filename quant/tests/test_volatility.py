"""The inverse-vol scalar, held to the three things it promises.

The suite is built around one test and the rest are supporting cast.
`test_score_at_T_survives_truncation` truncates the panel after session
T, recomputes, and demands the score at T be bit-for-bit what it was
when the rest of the sample was visible. An off-by-one in a rolling
window is invisible in review — the code reads correctly, the numbers
look plausible, and the backtest is beautiful — so it is not checked by
inspection. `test_the_truncation_check_has_teeth` runs the same check
against a deliberately leaky twin and requires it to FAIL, because a
causality test that has never been shown to fail is not evidence about
anything.

The other two promises: that every number comes off the total-return
series, which for the bond sleeves is nearly the whole of the return
and a good part of the variation; and that the floor keeps the
arithmetic finite without touching any sleeve the allocator is being
asked to compare on risk.

Everything is generated. There is no network here and the price cache
is cold, so the panels below are synthetic frames conforming to
`schema.PRICES`, built from a fixed seed and pivoted through the
module's own helper — which means the pivot, the schema and the signal
are all exercised by the same fixture.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd
import pytest

from griffinquant.data import schema
from griffinquant.data.synthetic import nyse_sessions
from griffinquant.signals import volatility as V

SEED = 20050103

#: Long enough to hold the 253-session warmup and still leave thirty
#: non-overlapping quarters for the diagnostic to measure over. Inside
#: the calendar bounds `conftest` widens to.
PANEL_START = date(2005, 1, 3)
PANEL_END = date(2013, 12, 31)


# -- the fixture --------------------------------------------------------


@dataclass(frozen=True)
class Spec:
    """One made-up sleeve: how volatile, when it listed, and how its
    total return relates to its printed price."""

    ticker: str
    annual_vol: float
    first: int = 0

    #: A volatility regime change, which is what makes the causality
    #: test a real one: a leak of a single bar across a break like this
    #: moves the estimate visibly rather than in the eighth decimal.
    regime_from: int | None = None
    regime_multiple: float = 1.0

    #: The bond case. The as-traded close never moves and every cent of
    #: the return is distribution, so a signal reading `close_unadj`
    #: measures a security with no risk and no return at all.
    coupon_only: bool = False

    #: Sessions this name simply does not print, as (start, stop).
    gap: tuple[int, int] | None = None


@lru_cache(maxsize=4)
def sessions(start: date = PANEL_START, end: date = PANEL_END) -> pd.DatetimeIndex:
    return nyse_sessions(start, end)


def make_prices(
    specs: tuple[Spec, ...],
    *,
    index: pd.DatetimeIndex | None = None,
    seed: int = SEED,
) -> pd.DataFrame:
    """A `schema.PRICES` frame with known volatilities in it.

    Log returns are drawn once per name and scaled, so the annualised
    volatility of the result is the number in the spec to within
    sampling error, and two panels drawn from the same seed differ only
    where the specs say they do.
    """
    idx = sessions() if index is None else index
    rng = np.random.default_rng(seed)
    blocks: list[pd.DataFrame] = []

    for k, spec in enumerate(specs):
        n = len(idx) - spec.first
        if n < 2:
            raise ValueError(f"{spec.ticker} has no room in this panel")

        scale = np.full(n, spec.annual_vol / math.sqrt(252.0))
        if spec.regime_from is not None:
            scale[max(spec.regime_from - spec.first, 0) :] *= spec.regime_multiple
        r = rng.standard_normal(n) * scale

        adj = 100.0 * np.exp(np.cumsum(r))
        unadj = np.full(n, 100.0) if spec.coupon_only else adj.copy()

        jitter = 1.0 + rng.normal(0.0, 0.002, n)
        block = pd.DataFrame(
            {
                "permaticker": np.full(n, 9_000_000 + k, dtype="int64"),
                "ticker": pd.Series([spec.ticker] * n, dtype="str"),
                "date": idx[spec.first :],
                "open_unadj": unadj * jitter,
                "high_unadj": unadj * (1.0 + np.abs(jitter - 1.0)),
                "low_unadj": unadj * (1.0 - np.abs(jitter - 1.0)),
                "close_unadj": unadj,
                "volume_unadj": np.full(n, 4.0e6),
                "close_adj": adj,
            }
        )
        if spec.gap is not None:
            lo, hi = spec.gap
            keep = ~np.isin(
                np.arange(spec.first, len(idx)), np.arange(lo, hi)
            )
            block = block.loc[keep]
        blocks.append(block)

    out = pd.concat(blocks, ignore_index=True)
    out = out.sort_values(["permaticker", "date"], kind="stable").reset_index(
        drop=True
    )
    return schema.PRICES.validate(out, source="test_volatility")


def panel(specs: tuple[Spec, ...], **kw) -> pd.DataFrame:
    return V.panel_from_prices(make_prices(specs, **kw))


def unadjusted_panel(specs: tuple[Spec, ...], **kw) -> pd.DataFrame:
    """The same pivot done on `close_unadj` — the wrong series, built
    here only so a test can show what reading it would cost."""
    prices = make_prices(specs, **kw)
    wide = prices.pivot(index="date", columns="ticker", values="close_unadj")
    return wide.sort_index()


#: Four independent sleeves spanning the risk range of the real book:
#: an equity sleeve, a credit sleeve, a Treasury sleeve and a cash leg
#: whose realised volatility is exactly zero, which is the ZIRP case the
#: floor exists for.
BOOK = (
    Spec("EQ", 0.20, regime_from=1_000, regime_multiple=2.5),
    Spec("CR", 0.09),
    Spec("GB", 0.06),
    Spec("CASH", 0.0),
)

RISK_SLEEVES = (
    Spec("EQ", 0.30),
    Spec("CR", 0.18),
    Spec("GB", 0.10),
    Spec("RA", 0.05),
)


# -- the test that matters most -----------------------------------------


def _leaky_scalar(close_adj: pd.DataFrame) -> pd.DataFrame:
    """The same estimator with one bar of the future in it.

    Exactly the arithmetic in the module, except the return series is
    shifted back one session, so the window ending at T contains T+1's
    return. This is the bug the truncation test exists to catch, written
    out once so the test can be shown catching it.
    """
    returns = V.total_returns(close_adj).shift(-1)
    short = returns.rolling(V.SHORT_WINDOW, min_periods=V.SHORT_WINDOW).var(ddof=1)
    long = returns.rolling(V.LONG_WINDOW, min_periods=V.LONG_WINDOW).var(ddof=1)
    vol = np.sqrt(
        V.SHORT_WEIGHT * short + (1.0 - V.SHORT_WEIGHT) * long
    ) * math.sqrt(252.0)
    floored = vol.clip(lower=V.MIN_ANNUAL_VOLATILITY)
    return floored.rdiv(floored.median(axis=1, skipna=True), axis=0)


#: Sessions to cut the panel at. One just past the warmup, one a month
#: after the volatility regime break at 1,000 (where a single leaked bar
#: moves the estimate most), and one near the end.
CUT_POINTS = (260, 400, 1_010, 1_400, 2_000)


@pytest.mark.parametrize("at", CUT_POINTS)
def test_score_at_T_survives_truncation(at: int) -> None:
    """The score for T uses data through the close of T and not one bar
    more, checked by deleting everything after T."""
    full = panel(BOOK)
    T = full.index[at]

    whole = V.inverse_volatility_scalar(full)
    cut = V.inverse_volatility_scalar(full.loc[:T])

    assert cut.index[-1] == T
    np.testing.assert_array_equal(
        cut.loc[T].to_numpy(dtype="float64"),
        whole.loc[T].to_numpy(dtype="float64"),
    )
    # Bit-for-bit, not merely close. A rolling accumulator that reset
    # differently would agree to twelve digits and disagree here.
    assert (
        cut.loc[T].to_numpy(dtype="float64").tobytes()
        == whole.loc[T].to_numpy(dtype="float64").tobytes()
    )


@pytest.mark.parametrize("at", CUT_POINTS)
def test_realised_volatility_survives_truncation(at: int) -> None:
    full = panel(BOOK)
    T = full.index[at]
    whole = V.realised_volatility(full)
    cut = V.realised_volatility(full.loc[:T])
    np.testing.assert_array_equal(
        cut.loc[T].to_numpy(dtype="float64"),
        whole.loc[T].to_numpy(dtype="float64"),
    )


def test_the_truncation_check_has_teeth() -> None:
    """A test that has never been shown to fail proves nothing.

    The leaky twin reads one bar past T. The same assertion that passes
    above must fail here, or the assertion is not testing causality — it
    is testing that pandas is deterministic.
    """
    full = panel(BOOK)
    T = full.index[1_010]
    whole = _leaky_scalar(full)
    cut = _leaky_scalar(full.loc[:T])

    with pytest.raises(AssertionError):
        np.testing.assert_array_equal(
            cut.loc[T].to_numpy(dtype="float64"),
            whole.loc[T].to_numpy(dtype="float64"),
        )


def test_the_regime_break_actually_moves_the_estimate() -> None:
    """The causality test would pass on a flat series by accident.

    So the fixture is checked for the thing that makes the test hard:
    the equity sleeve's volatility more than doubles across the break,
    which means a single leaked session there is a visible error rather
    than a rounding one.
    """
    vol = V.realised_volatility(panel(BOOK))["EQ"]
    before = float(vol.iloc[990])
    after = float(vol.iloc[1_400])
    assert after > 2.0 * before


# -- total return, not price --------------------------------------------


def test_volatility_is_measured_on_the_total_return_series() -> None:
    """The bond case, which is the whole reason the rule exists.

    `close_unadj` is flat by construction for a coupon-only name, so a
    signal reading it measures a security with zero risk. The panel this
    module takes is the adjusted one and the difference is not a nuance:
    it is the entire measured variation of the sleeve.
    """
    specs = (Spec("BOND", 0.06, coupon_only=True), Spec("EQ", 0.20))
    adjusted = V.realised_volatility(panel(specs)).iloc[-1]
    as_traded = V.realised_volatility(unadjusted_panel(specs)).iloc[-1]

    assert 0.04 < float(adjusted["BOND"]) < 0.09
    assert float(as_traded["BOND"]) == 0.0
    # The equity sleeve has no distributions in this fixture, so the two
    # series are the same and the two readings agree — which is what
    # makes the bond row above a statement about coupons rather than
    # about the fixture being odd.
    assert float(adjusted["EQ"]) == pytest.approx(float(as_traded["EQ"]))


def test_reading_the_wrong_series_would_maximise_the_bond_position() -> None:
    """Not just wrong — wrong in the dangerous direction.

    A sleeve whose measured volatility is zero is floored, and a floored
    sleeve receives the largest scalar the normalisation can produce. A
    signal computed on `close_unadj` would therefore tell the sizing
    layer to load up on exactly the sleeve it could not measure.
    """
    specs = (Spec("BOND", 0.06, coupon_only=True), Spec("EQ", 0.20))
    as_traded = V.inverse_volatility_scalar(unadjusted_panel(specs)).iloc[-1]
    adjusted = V.inverse_volatility_scalar(panel(specs)).iloc[-1]

    floored_vol = V.realised_volatility(unadjusted_panel(specs)).iloc[-1]
    ceiling = float(
        np.median(np.clip(floored_vol.to_numpy(), V.MIN_ANNUAL_VOLATILITY, None))
        / V.MIN_ANNUAL_VOLATILITY
    )
    assert float(as_traded["BOND"]) == pytest.approx(ceiling)
    assert float(as_traded["BOND"]) > 5.0 * float(adjusted["BOND"])


# -- the floor ----------------------------------------------------------


def test_a_zero_volatility_sleeve_produces_a_finite_scalar() -> None:
    """The infinity this floor exists to prevent, made to happen."""
    p = panel(BOOK)
    vol = V.realised_volatility(p)
    scalar = V.inverse_volatility_scalar(p)

    # The cash leg's realised volatility is exactly zero, not nearly.
    assert float(vol["CASH"].iloc[-1]) == 0.0
    tail = scalar.iloc[V.MIN_SESSIONS - 1 :]
    assert np.isfinite(tail.to_numpy()).all()


def test_the_floor_binds_on_the_cash_leg_and_nowhere_else() -> None:
    """A floor that moved a risk sleeve would be a live parameter.

    The scalar for every sleeve with a real volatility must be exactly
    what an unfloored division would have given, so that changing
    `MIN_ANNUAL_VOLATILITY` can only ever change the sleeve it binds on.
    That containment is what stops the floor being tuned by the back
    door.
    """
    p = panel(BOOK)
    vol = V.realised_volatility(p).iloc[-1]
    scalar = V.inverse_volatility_scalar(p).iloc[-1]

    floored = vol.clip(lower=V.MIN_ANNUAL_VOLATILITY)
    reference = float(np.median(floored.to_numpy()))

    assert float(floored["CASH"]) == V.MIN_ANNUAL_VOLATILITY
    assert float(scalar["CASH"]) == pytest.approx(
        reference / V.MIN_ANNUAL_VOLATILITY
    )
    for name in ("EQ", "CR", "GB"):
        assert float(vol[name]) > V.MIN_ANNUAL_VOLATILITY
        assert float(scalar[name]) == pytest.approx(reference / float(vol[name]))


def test_the_floor_must_be_positive() -> None:
    with pytest.raises(V.SignalError, match="infinity"):
        V.inverse_volatility_scalar(panel(BOOK), min_annual_volatility=0.0)


# -- the normalisation --------------------------------------------------


def test_the_scalar_is_the_median_risk_over_the_sleeve_s_own() -> None:
    """The defining identity, checked against an independent median."""
    p = panel(RISK_SLEEVES)
    vol = V.realised_volatility(p)
    scalar = V.inverse_volatility_scalar(p)

    floored = vol.clip(lower=V.MIN_ANNUAL_VOLATILITY).iloc[V.MIN_SESSIONS - 1 :]
    reference = np.median(floored.to_numpy(dtype="float64"), axis=1)
    np.testing.assert_allclose(
        scalar.iloc[V.MIN_SESSIONS - 1 :].to_numpy(dtype="float64"),
        reference[:, None] / floored.to_numpy(dtype="float64"),
        rtol=1e-12,
    )


def test_the_median_sleeve_scores_exactly_one() -> None:
    """True with an odd count, where the median IS one of the sleeves.

    With an even count the reference is the midpoint of the two middle
    volatilities and no sleeve lands on 1.0 — the module docstring says
    so, and this test exists so the difference is a documented property
    rather than a surprise somebody meets in a portfolio report.
    """
    odd = V.inverse_volatility_scalar(panel(RISK_SLEEVES[:3]))
    tail = odd.iloc[V.MIN_SESSIONS - 1 :]
    assert np.allclose(tail.median(axis=1).to_numpy(), 1.0, rtol=0, atol=1e-12)
    assert (tail.to_numpy() == 1.0).sum(axis=1).min() == 1

    even = V.inverse_volatility_scalar(panel(RISK_SLEEVES))
    assert not np.allclose(
        even.iloc[-1].median(), 1.0, rtol=0, atol=1e-12
    )


def test_the_scalar_is_dimensionless() -> None:
    """Scale every sleeve's risk by the same factor and nothing moves.

    This is what "the sizing layer applies it without knowing the units"
    means in arithmetic: the caller never has to know whether these
    volatilities were daily or annualised, or what currency the book is
    in.
    """
    base = panel(RISK_SLEEVES)
    returns = V.total_returns(base)
    growth = 1.0 + 3.0 * returns
    growth.iloc[0] = 1.0
    tripled = growth.cumprod().mul(base.iloc[0], axis=1)

    a = V.inverse_volatility_scalar(base).iloc[V.MIN_SESSIONS - 1 :]
    b = V.inverse_volatility_scalar(tripled).iloc[V.MIN_SESSIONS - 1 :]
    np.testing.assert_allclose(
        b.to_numpy(dtype="float64"), a.to_numpy(dtype="float64"), rtol=1e-9
    )

    # And the volatilities really did scale, so the invariance above is
    # a property of the normalisation rather than of an unchanged panel.
    va = V.realised_volatility(base).iloc[-1]
    vb = V.realised_volatility(tripled).iloc[-1]
    np.testing.assert_allclose(
        vb.to_numpy(dtype="float64"), 3.0 * va.to_numpy(dtype="float64"), rtol=1e-9
    )


def test_a_quieter_sleeve_gets_a_larger_scalar() -> None:
    scalar = V.inverse_volatility_scalar(panel(RISK_SLEEVES)).iloc[-1]
    ordered = [float(scalar[t]) for t in ("EQ", "CR", "GB", "RA")]
    assert ordered == sorted(ordered)


# -- the estimator's shape ----------------------------------------------


def test_the_blend_mixes_variances_equally() -> None:
    """The stated arithmetic, pinned.

    A blend of standard deviations instead of variances is a different
    estimator that reads identically in a diff, so the second assertion
    checks the two are actually distinguishable and this test can tell
    them apart.
    """
    p = panel(RISK_SLEEVES)
    returns = V.total_returns(p)
    short = returns.rolling(V.SHORT_WINDOW, min_periods=V.SHORT_WINDOW).var(ddof=1)
    long = returns.rolling(V.LONG_WINDOW, min_periods=V.LONG_WINDOW).var(ddof=1)

    expected = np.sqrt(
        V.SHORT_WEIGHT * short + (1.0 - V.SHORT_WEIGHT) * long
    ) * math.sqrt(252.0)
    got = V.realised_volatility(p)
    np.testing.assert_allclose(
        got.to_numpy(dtype="float64"),
        expected.to_numpy(dtype="float64"),
        rtol=1e-12,
        equal_nan=True,
    )

    vol_space = (
        V.SHORT_WEIGHT * np.sqrt(short) + (1.0 - V.SHORT_WEIGHT) * np.sqrt(long)
    ) * math.sqrt(252.0)
    assert not np.allclose(
        got.iloc[-1].to_numpy(dtype="float64"),
        vol_space.iloc[-1].to_numpy(dtype="float64"),
    )


def test_no_scalar_until_the_long_window_is_full() -> None:
    """A year means a year. An estimate labelled one-year realised
    volatility and computed from sixty days is a different statistic
    wearing the same name."""
    idx = sessions()[: V.MIN_SESSIONS]
    exact = V.inverse_volatility_scalar(panel(RISK_SLEEVES, index=idx))
    assert np.isfinite(exact.iloc[-1].to_numpy()).all()
    assert exact.iloc[:-1].isna().all().all()

    short = V.inverse_volatility_scalar(
        panel(RISK_SLEEVES, index=sessions()[: V.MIN_SESSIONS - 1])
    )
    assert short.isna().all().all()


def test_warmup_matches_the_engine_index_convention() -> None:
    """At loop index i the view holds i+1 closes, so `WARMUP_SESSIONS`
    is one less than the number of rows the estimator needs."""
    assert V.WARMUP_SESSIONS == V.MIN_SESSIONS - 1
    assert V.MIN_SESSIONS == V.LONG_WINDOW + 1


def test_a_late_listing_sleeve_has_no_scalar_for_its_first_year() -> None:
    """DBC lists thirteen months into the sample and BIL two and a half
    years in. Neither gets a number before it has a year of its own."""
    late = 500
    specs = RISK_SLEEVES[:3] + (Spec("NEW", 0.15, first=late),)
    scalar = V.inverse_volatility_scalar(panel(specs))["NEW"]

    # One session lost to the first return having no predecessor, then
    # the long window.
    first_valid = late + 1 + V.LONG_WINDOW - 1
    assert scalar.iloc[:first_valid].isna().all()
    assert np.isfinite(float(scalar.iloc[first_valid]))
    # The sleeves that were there all along are unaffected.
    assert (
        np.isfinite(
            V.inverse_volatility_scalar(panel(specs))["EQ"]
            .iloc[V.MIN_SESSIONS - 1 :]
            .to_numpy()
        )
    ).all()


def test_a_hole_in_a_series_is_a_hole_and_not_a_short_sample() -> None:
    """Deliberately harsh, and deliberately loud.

    A sleeve that stops printing for a fortnight loses its estimate
    until a full clean year has accumulated again, rather than quietly
    reporting a number computed off 241 observations under a label that
    says 252. On a panel of nine liquid ETFs a gap like this is a data
    problem somebody should see, not something to interpolate over.
    """
    specs = RISK_SLEEVES[:3] + (Spec("GAP", 0.15, gap=(800, 811)),)
    scalar = V.inverse_volatility_scalar(panel(specs))["GAP"]

    assert np.isfinite(float(scalar.iloc[799]))
    assert scalar.iloc[811:1_050].isna().all()
    assert np.isfinite(float(scalar.iloc[1_100]))


# -- reading the panel --------------------------------------------------


def test_panel_from_prices_refuses_a_recycled_ticker() -> None:
    """Two entities under one symbol is the trap the schema exists for.

    The pivot would splice a dead company's history onto a living one's
    and produce a series that fell 99% and recovered.
    """
    prices = make_prices((Spec("EQ", 0.20),))
    twin = prices.assign(permaticker=prices["permaticker"] + 1)
    collided = pd.concat([prices, twin], ignore_index=True)

    with pytest.raises(V.SignalError, match="recycled-symbol"):
        V.panel_from_prices(collided)

    # Keyed on the permanent id the same frame is perfectly readable.
    wide = V.panel_from_prices(collided, key="permaticker")
    assert list(wide.columns) == ["9000000", "9000001"]


def test_panel_from_prices_needs_the_adjusted_close() -> None:
    prices = make_prices((Spec("EQ", 0.20),)).drop(columns=["close_adj"])
    with pytest.raises(V.SignalError, match="close_adj"):
        V.panel_from_prices(prices)


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda p: p.iloc[::-1], "sorted ascending"),
        (lambda p: pd.concat([p, p.iloc[[-1]]]), "duplicate"),
        (lambda p: p.reset_index(drop=True), "indexed by date"),
        (lambda p: p.iloc[:, :0], "no sleeves"),
        (lambda p: p.assign(EQ=0.0), "non-positive"),
        (lambda p: p.assign(EQ=np.inf), "infinite"),
    ],
)
def test_a_panel_that_cannot_be_read_honestly_is_refused(mutate, message) -> None:
    p = panel(RISK_SLEEVES)
    with pytest.raises(V.SignalError, match=message):
        V.realised_volatility(mutate(p))


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"short_window": 300}, "exceeds long window"),
        ({"short_window": 1}, "at least two"),
        ({"short_weight": 1.4}, "outside"),
        ({"short_weight": -0.1}, "outside"),
    ],
)
def test_window_arguments_are_checked(kwargs, message) -> None:
    with pytest.raises(V.SignalError, match=message):
        V.realised_volatility(panel(RISK_SLEEVES), **kwargs)


# -- the standalone diagnostic ------------------------------------------
#
# Not an information coefficient. An inverse-vol scalar makes no claim
# about the direction of anything, so a correlation against forward
# returns would measure either the low-volatility anomaly or noise —
# neither of which is what this file asserts. What it asserts is that
# sizing by inverse volatility spreads realised risk more evenly than
# sizing by equal dollars, and that is what is measured here.


def test_inverse_vol_spreads_risk_more_evenly_than_equal_weight() -> None:
    result = V.evaluate(panel(RISK_SLEEVES))
    assert result.n_windows > 25

    paired = result.paired.set_index("basis")
    for basis in ("standalone", "correlation_aware"):
        row = paired.loc[basis]
        assert row["mean_dispersion_inverse_vol"] < row["mean_dispersion_equal"]
        assert (
            row["mean_effective_n_inverse_vol"] > row["mean_effective_n_equal"]
        )
        # A win rate is the falsifiable form of the claim: both schemes
        # measured on the same sleeves in the same window.
        assert row["win_rate"] > 0.8


def test_the_diagnostic_says_nothing_when_every_sleeve_is_alike() -> None:
    """The honest null.

    Four sleeves at the same volatility are already equal-risk, so
    inverse-vol sizing has nothing to add and must not appear to. Both
    schemes should land within a couple of points of each other — the
    residual is sampling error in a 63-day volatility estimate, which is
    around nine per cent of a share of 0.25, so a gap of more than 0.02
    would mean the scheme was doing something other than what it says.
    """
    alike = tuple(Spec(t, 0.15) for t in ("A", "B", "C", "D"))
    paired = V.evaluate(panel(alike)).paired.set_index("basis")
    for basis in ("standalone", "correlation_aware"):
        row = paired.loc[basis]
        gap = abs(
            row["mean_dispersion_inverse_vol"] - row["mean_dispersion_equal"]
        )
        assert gap < 0.02


def test_the_diagnostic_weights_come_from_the_shipped_scalar() -> None:
    """Otherwise the test is of a second implementation nobody uses."""
    p = panel(RISK_SLEEVES)
    result = V.evaluate(p)
    scalar = V.inverse_volatility_scalar(p)

    rows = result.contributions
    rows = rows.loc[
        (rows["scheme"] == "inverse_vol") & (rows["basis"] == "standalone")
    ]
    when = rows["date"].iloc[-1]
    got = rows.loc[rows["date"] == when].set_index("asset")["weight"]
    want = scalar.loc[when]
    want = want / want.sum()
    np.testing.assert_allclose(
        got.reindex(want.index).to_numpy(dtype="float64"),
        want.to_numpy(dtype="float64"),
        rtol=1e-12,
    )


def test_the_diagnostic_genuinely_needs_the_future() -> None:
    """It measures what the weights went on to do, so a window whose
    forward returns have been cut away must disappear rather than being
    scored off the trailing estimate that produced it."""
    p = panel(RISK_SLEEVES)
    full = V.evaluate(p)
    last = full.windows["date"].max()

    truncated = V.evaluate(p.loc[:last])
    assert last not in set(truncated.windows["date"])
    assert truncated.n_windows == full.n_windows - 1


def test_diagnostic_windows_do_not_overlap() -> None:
    """Overlapping quarters share sixty-two of sixty-three returns, and
    a win rate computed over them counts one quarter's luck sixty-three
    times."""
    p = panel(RISK_SLEEVES)
    result = V.evaluate(p)
    positions = p.index.get_indexer(
        pd.DatetimeIndex(sorted(set(result.windows["date"])))
    )
    assert (np.diff(positions) == result.horizon).all()


def test_the_diagnostic_reports_a_short_panel_as_nothing_measured() -> None:
    idx = sessions()[:100]
    result = V.evaluate(panel(RISK_SLEEVES, index=idx))
    assert result.n_windows == 0
    assert result.n_skipped > 0
    assert "No evaluable windows" in result.verdict
    assert list(result.windows.columns) == [
        "date",
        "scheme",
        "basis",
        "n_assets",
        "dispersion_std",
        "dispersion_range",
        "effective_n",
        "effective_share",
    ]


def test_the_verdict_names_both_bases_and_refuses_to_overclaim() -> None:
    verdict = V.evaluate(panel(RISK_SLEEVES)).verdict
    assert "standalone" in verdict
    assert "correlation_aware" in verdict
    assert "tautological" in verdict
    assert "makes no promise" in verdict


def test_the_summary_carries_both_schemes_on_both_bases() -> None:
    summary = V.evaluate(panel(RISK_SLEEVES)).summary()
    assert set(summary["scheme"]) == {"equal", "inverse_vol"}
    assert set(summary["basis"]) == {"standalone", "correlation_aware"}
    assert len(summary) == 4


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"horizon": 1}, "too short"),
        ({"min_assets": 1}, "makes no sense"),
    ],
)
def test_the_diagnostic_refuses_a_measurement_it_cannot_make(
    kwargs, message
) -> None:
    with pytest.raises(V.SignalError, match=message):
        V.evaluate(panel(RISK_SLEEVES), **kwargs)


# -- the parameters -----------------------------------------------------


def test_the_parameters_are_the_round_ones_that_were_argued_for() -> None:
    """A pin, not a check.

    Every one of these was written down with a justification before any
    performance number existed. If one of them changes, this test is the
    place a reader finds out, and the diff has to carry the new argument
    — not a note that it tested better.
    """
    assert V.SHORT_WINDOW == 63
    assert V.LONG_WINDOW == 252
    assert V.SHORT_WEIGHT == 0.5
    assert V.MIN_ANNUAL_VOLATILITY == 0.01
    assert V.EVALUATION_HORIZON == V.SHORT_WINDOW
