"""The sizing layer, held to the four promises it makes about the account.

Long-only, no leverage, per-sleeve caps, cash as the residual. Those are
facts about a cash brokerage account rather than preferences, and the
tests below are the only reason to believe the composition obeys them
under inputs nobody has looked at.

The suite is in two halves and the split is deliberate.

`compose` is handed signal values directly, which is what makes the
adversarial half possible: a trend score of -5 and an inverse-vol scalar
of fifty are not states a price frame can be made to produce, and they
are exactly the states a long-only guarantee has to survive. A test that
can only reach the composition through a panel is testing the panel.

The panel half then checks that the real signals wire into it the way
the docstring says — that an unlisted sleeve is ABSENT rather than
bearish, that the cash column never enters the sizing, and above all
that the weights for date T do not move when the frame is truncated
after T. That last one is not checked by inspection. An off-by-one in a
rolling window reads correctly, produces plausible numbers and
manufactures a beautiful backtest, so it is checked by literal
truncation — and `test_the_truncation_check_has_teeth` requires the same
comparison to FAIL against a call that does peek, because a causality
test that has never been shown to fail is not evidence about anything.

Everything is generated from a fixed seed. There is no price cache and
the free endpoint is dark, which is the best moment there will ever be
to fix a composition: nothing here can have been chosen by watching what
it earned, because nothing here has ever earned anything.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine.backtest import BacktestConfig, MarketData, run_backtest
from griffinquant.data.synthetic import nyse_sessions
from griffinquant.portfolio import sizing as Z
from griffinquant.portfolio.sleeves import SLEEVE_BY_KEY
from griffinquant.signals import correlation, trend, volatility

SEED = 20050103
SESSIONS_PER_YEAR = 252

#: Long enough to clear the 253-session warmup with several years of
#: live decisions after it, and inside the calendar bounds `conftest`
#: widens the exchange calendar to.
PANEL_START = date(2005, 1, 3)
PANEL_END = date(2007, 6, 29)


# -- the fixture --------------------------------------------------------


@dataclass(frozen=True)
class Spec:
    """One made-up sleeve as loadings on two common factors.

    Two factors and not one, for the reason `test_correlation` gives:
    a single factor cannot produce a book in which the duration sleeves
    are 0.96 correlated with each other and slightly NEGATIVE against
    equities, and that shape is the whole thing the correlation haircut
    is about. A one-factor fixture would quietly test a book where every
    diversifier is also a duplicate.
    """

    key: str
    beta: float
    gamma: float
    idio: float
    #: Sessions of the panel this vehicle simply did not exist for. The
    #: DBC case, and the only way to test the ABSENT state honestly.
    starts_at: int = 0


BOOK: tuple[Spec, ...] = (
    Spec("us_equity", beta=1.00, gamma=0.00, idio=0.30),
    Spec("intl_developed", beta=0.95, gamma=0.00, idio=0.35),
    Spec("emerging_markets", beta=0.90, gamma=0.00, idio=0.55),
    Spec("duration_intermediate", beta=-0.15, gamma=1.00, idio=0.20),
    Spec("duration_long", beta=-0.20, gamma=1.60, idio=0.30),
    Spec("gold", beta=0.05, gamma=0.20, idio=1.00),
    Spec("credit_ig", beta=0.35, gamma=0.60, idio=0.25),
    # Thirteen months in, which is where DBC actually listed.
    Spec("commodity", beta=0.30, gamma=-0.10, idio=0.90, starts_at=274),
)

FACTOR_VOL = 0.16
DAILY_SCALE = 0.010

#: The cash leg: a nearly flat series, so its realised volatility sits
#: on the floor the volatility module documents. It is in the panel
#: precisely so the tests can prove it never reaches the sizing.
CASH_KEY = "cash"


@lru_cache(maxsize=8)
def panel(
    seed: int = SEED,
    n: int = 1_700,
    with_cash: bool = True,
    single_factor: bool = False,
) -> pd.DataFrame:
    """A wide `close_adj` panel keyed by sleeve key.

    `single_factor` puts every sleeve on one factor with a POSITIVE
    loading, which is the crowded regime the haircut exists to act in: a
    nine-sleeve book whose first principal component carries most of its
    variance is a one-sleeve book with extra tickets. The honest
    two-factor panel deliberately does not contain that, which is why
    both are needed — one to prove the haircut fires, one to prove it
    stays quiet where a real hedge is doing the work.
    """
    rng = np.random.default_rng(seed)
    idx = pd.DatetimeIndex(pd.bdate_range("2005-01-03", periods=n))
    daily_factor = FACTOR_VOL / math.sqrt(SESSIONS_PER_YEAR)
    equity = daily_factor * rng.standard_normal(n)
    rates = daily_factor * rng.standard_normal(n)

    data: dict[str, np.ndarray] = {}
    for spec in BOOK:
        if single_factor:
            r = (abs(spec.beta) + abs(spec.gamma)) * equity + (
                spec.idio * DAILY_SCALE * rng.standard_normal(n)
            )
        else:
            r = (
                spec.beta * equity
                + spec.gamma * rates
                + spec.idio * DAILY_SCALE * rng.standard_normal(n)
            )
        series = 100.0 * np.exp(np.cumsum(r))
        if spec.starts_at:
            series[: spec.starts_at] = np.nan
        data[spec.key] = series

    if with_cash:
        # A step function of monthly distributions on a flat price is
        # what a bill fund's total return looks like; the point here is
        # only that its volatility is an order of magnitude below every
        # risk sleeve's, which is what would wreck a cross-sectional
        # median if cash were ever allowed into it.
        data[CASH_KEY] = 100.0 * np.exp(
            np.cumsum(0.00008 + 0.00004 * rng.standard_normal(n))
        )

    return pd.DataFrame(data, index=idx)


def sig(asset: str = "us_equity", **kwargs: object) -> Z.SleeveSignals:
    """One `SleeveSignals` with everything neutral unless overridden."""
    fields: dict[str, object] = {
        "asset": asset,
        "cap": SLEEVE_BY_KEY[asset].max_weight if asset in SLEEVE_BY_KEY else 0.25,
        "trend_score": 1.0,
        "vol_scalar": 1.0,
        "correlation_multiplier": 1.0,
        "sleeve": asset,
    }
    fields.update(kwargs)
    return Z.SleeveSignals(**fields)  # type: ignore[arg-type]


#: The grid the adversarial tests sweep. Every value outside the
#: signals' documented ranges is there on purpose: the guarantee is that
#: no combination produces a short or a borrowing, and a guarantee only
#: tested on well-behaved inputs is a description.
TRENDS = (-5.0, -1.0, -0.25, 0.0, 1.0 / 3.0, 0.5, 1.0, 3.0)
SCALARS = (-2.0, 0.0, 1e-9, 0.5, 1.0, 4.0, 50.0, 1e6)
MULTIPLIERS = (-1.0, 0.0, 0.5, 1.0 - correlation.MAX_HAIRCUT, 1.0, 1.8, 100.0)


def grid_allocations() -> list[Z.Allocation]:
    """One allocation per point of the sweep, all sleeves moving together.

    All eight sleeves carry the same triple, which is the shape that
    stresses the gross budget hardest: the caps sum to 2.10, so any
    combination that clears the caps is a book asking for twice NAV.
    """
    out: list[Z.Allocation] = []
    for t, v, m in itertools.product(TRENDS, SCALARS, MULTIPLIERS):
        out.append(
            Z.compose(
                [
                    sig(
                        spec.key,
                        trend_score=t,
                        vol_scalar=v,
                        correlation_multiplier=m,
                    )
                    for spec in BOOK
                ],
                asof=pd.Timestamp("2010-06-30"),
            )
        )
    return out


# -- the account's four facts, adversarially ----------------------------


def test_no_signal_combination_can_produce_a_negative_weight():
    """Nothing goes short, at any step, not merely by the last one.

    The intermediate columns are asserted alongside the answer and that
    is not belt-and-braces. The final clip to [0, cap] would rescue a
    negative weight silently, so a decomposition claiming that trend
    took -40% of the book and the cap put it back is a sentence about
    the process that is not true — and the whole reason those columns
    exist is that somebody will read them and believe them.
    """
    for alloc in grid_allocations():
        for line in alloc.lines:
            assert math.isfinite(line.weight)
            assert line.weight >= 0.0, (line.asset, line.weight)
            if line.status is not Z.SleeveStatus.INCLUDED:
                continue
            for step in (
                "after_trend",
                "after_vol",
                "after_correlation",
                "after_cap",
            ):
                value = getattr(line, step)
                assert math.isfinite(value)
                assert value >= 0.0, (line.asset, step, value)
        assert alloc.cash_weight >= 0.0


def test_no_sleeve_ever_exceeds_its_own_cap():
    for alloc in grid_allocations():
        for line in alloc.lines:
            assert line.weight <= line.cap + 1e-12, (line.asset, line.weight)


def test_the_book_never_asks_for_leverage():
    for alloc in grid_allocations():
        assert alloc.gross <= 1.0 + 1e-12


def test_cash_is_exactly_the_residual():
    for alloc in grid_allocations():
        assert abs(alloc.gross + alloc.cash_weight - 1.0) < 1e-12


def test_maximum_bullishness_is_the_caps_and_no_more():
    """Every signal maximally bullish, and the answer is buy-and-hold.

    The inverse-vol scalar is unbounded above only in principle: the
    volatility floor caps it at the median sleeve's own volatility over
    `MIN_ANNUAL_VOLATILITY`, which for a book running 12% is about
    twelve. The sweep uses a million, which is that ceiling several
    orders of magnitude past anything reachable, and the answer is the
    same — fully invested at the caps, scaled to fit inside NAV. There
    is nothing above that for a signal to earn.
    """
    alloc = Z.compose(
        [
            sig(
                spec.key,
                trend_score=1.0,
                vol_scalar=1e6,
                correlation_multiplier=1.0,
            )
            for spec in BOOK
        ],
        asof=pd.Timestamp("2010-06-30"),
    )
    caps = {line.asset: line.cap for line in alloc.lines}
    assert sum(caps.values()) > 1.0, "the fixture must have caps that oversubscribe"
    assert alloc.gross == pytest.approx(1.0, abs=1e-12)
    assert alloc.cash_weight == pytest.approx(0.0, abs=1e-12)
    # Proportional to the caps, because every sleeve hit its own and the
    # only thing left to do was scale.
    share = [line.weight / line.cap for line in alloc.lines]
    assert max(share) - min(share) < 1e-12


def test_a_book_inside_NAV_is_left_alone():
    alloc = Z.compose(
        [sig(spec.key, trend_score=0.25, vol_scalar=1.0) for spec in BOOK],
        asof=pd.Timestamp("2010-06-30"),
    )
    assert alloc.budget_scale == 1.0
    for line in alloc.lines:
        assert line.weight == pytest.approx(line.cap * 0.25)
    assert alloc.cash_weight == pytest.approx(1.0 - alloc.gross)
    assert alloc.gross < 1.0


def test_the_budget_scales_every_sleeve_by_the_same_factor():
    """Down, and proportionally. Any other rule is a view.

    Taking the shortfall out of one sleeve rather than all of them is an
    allocation decision, and it would be one made by the plumbing on a
    day the signals had already spoken.
    """
    alloc = Z.compose(
        [
            sig("us_equity", trend_score=1.0, vol_scalar=1.0),
            sig("duration_intermediate", trend_score=1.0, vol_scalar=1.0),
            sig("credit_ig", trend_score=1.0, vol_scalar=1.0),
        ],
        asof=pd.Timestamp("2010-06-30"),
    )
    assert alloc.gross_before_budget == pytest.approx(0.40 + 0.40 + 0.30)
    assert alloc.budget_scale == pytest.approx(1.0 / 1.10)
    for line in alloc.lines:
        assert line.weight == pytest.approx(line.after_cap * alloc.budget_scale)
        assert line.binding == "gross_budget"


# -- the correlation step is one-way ------------------------------------


def test_the_correlation_step_can_only_reduce():
    """A multiplier that would lever a diversifier is refused.

    This is the case an optimiser walks straight into: hand a
    mean-variance engine a matrix with a strongly negative pair and it
    loads onto whichever leg the estimation error most flattered. The
    haircut has no such degree of freedom, and this asserts the seam
    honours it even when handed a number the correlation module could
    not have produced.
    """
    base = Z.compose(
        [sig(spec.key, trend_score=0.5, vol_scalar=1.0) for spec in BOOK],
        asof=pd.Timestamp("2010-06-30"),
    )
    for tempting in (1.0 + 1e-9, 1.5, 4.0, 1e6):
        levered = Z.compose(
            [
                sig(
                    spec.key,
                    trend_score=0.5,
                    vol_scalar=1.0,
                    correlation_multiplier=tempting,
                )
                for spec in BOOK
            ],
            asof=pd.Timestamp("2010-06-30"),
        )
        for a, b in zip(base.lines, levered.lines):
            assert b.weight <= a.weight + 1e-15
            assert b.correlation_multiplier <= 1.0
            assert b.after_correlation <= b.after_vol + 1e-15


def test_the_full_haircut_halves_and_no_more():
    alloc = Z.compose(
        [
            sig(
                spec.key,
                trend_score=1.0,
                vol_scalar=1.0,
                correlation_multiplier=1.0 - correlation.MAX_HAIRCUT,
            )
            for spec in BOOK
        ],
        asof=pd.Timestamp("2010-06-30"),
    )
    for line in alloc.lines:
        assert line.after_correlation == pytest.approx(0.5 * line.after_vol)


# -- absent is not bearish ----------------------------------------------


def test_an_absent_sleeve_is_distinguishable_from_one_scored_to_zero():
    """Two sleeves at zero weight, two entirely different facts.

    A weight vector cannot tell them apart, which is the whole reason
    this layer returns something else.
    """
    alloc = Z.compose(
        [
            sig("commodity", present=False, trend_score=float("nan"),
                vol_scalar=float("nan")),
            sig("gold", trend_score=0.0, vol_scalar=1.0),
        ],
        asof=pd.Timestamp("2005-06-30"),
    )
    absent, bearish = alloc.lines

    assert absent.weight == 0.0 and bearish.weight == 0.0
    assert absent.status is Z.SleeveStatus.ABSENT
    assert bearish.status is Z.SleeveStatus.INCLUDED
    assert absent.binding == "absent"
    assert bearish.binding == "trend"
    assert absent.excluded_because and not bearish.excluded_because
    # The step columns say it too: nothing ran for the absent sleeve, so
    # there is no post-step weight, where the bearish one has a real zero.
    assert math.isnan(absent.after_trend)
    assert bearish.after_trend == 0.0
    assert alloc.n_absent == 1 and alloc.n_included == 1 and alloc.n_unscored == 0


def test_an_abstention_is_never_filled_with_a_neutral_score():
    alloc = Z.compose(
        [
            sig("us_equity", trend_score=float("nan")),
            sig("gold", vol_scalar=float("nan")),
        ],
        asof=pd.Timestamp("2005-06-30"),
    )
    for line in alloc.lines:
        assert line.status is Z.SleeveStatus.UNSCORED
        assert line.weight == 0.0
        assert line.binding == "unscored"
    assert "trend" in alloc.lines[0].excluded_because
    assert "volatility" in alloc.lines[1].excluded_because


def test_nothing_is_redistributed_on_an_excluded_sleeve_s_behalf():
    """A missing sleeve makes the book smaller, never the rest bigger."""
    full = Z.compose(
        [sig(spec.key, trend_score=0.25) for spec in BOOK],
        asof=pd.Timestamp("2010-06-30"),
    )
    holed = Z.compose(
        [
            sig(spec.key, trend_score=0.25)
            if spec.key != "commodity"
            else sig("commodity", present=False, trend_score=float("nan"),
                     vol_scalar=float("nan"))
            for spec in BOOK
        ],
        asof=pd.Timestamp("2010-06-30"),
    )
    for a, b in zip(full.lines, holed.lines):
        if a.asset == "commodity":
            continue
        assert a.weight == pytest.approx(b.weight)
    assert holed.cash_weight > full.cash_weight


# -- the binding reason -------------------------------------------------


@pytest.mark.parametrize(
    "kwargs, expected",
    [
        ({"trend_score": 0.0}, "trend"),
        ({"trend_score": 1.0 / 3.0}, "trend"),
        ({"vol_scalar": 0.25}, "inverse_vol"),
        ({"correlation_multiplier": 0.6}, "correlation"),
        ({"vol_scalar": 3.0}, "cap"),
        ({}, "none"),
    ],
)
def test_binding_names_the_step_that_did_the_cutting(kwargs, expected):
    alloc = Z.compose([sig("gold", **kwargs)], asof=pd.Timestamp("2010-06-30"))
    assert alloc.lines[0].binding == expected


def test_the_decomposition_reproduces_the_weight_step_by_step():
    alloc = Z.compose(
        [
            sig("us_equity", trend_score=2.0 / 3.0, vol_scalar=1.4,
                correlation_multiplier=0.8),
            sig("gold", trend_score=1.0, vol_scalar=0.6),
        ],
        asof=pd.Timestamp("2010-06-30"),
    )
    frame = alloc.explain()
    assert list(frame["date"].unique()) == [pd.Timestamp("2010-06-30")]
    for row in frame.to_dict("records"):
        assert row["after_trend"] == pytest.approx(row["cap"] * row["trend_score"])
        assert row["after_vol"] == pytest.approx(
            row["after_trend"] * row["vol_scalar"]
        )
        assert row["after_correlation"] == pytest.approx(
            row["after_vol"] * row["correlation_multiplier"]
        )
        assert row["after_cap"] == pytest.approx(
            min(row["after_correlation"], row["cap"])
        )
        assert row["weight"] == pytest.approx(row["after_cap"] * alloc.budget_scale)
        assert row["haircut"] == pytest.approx(1.0 - row["correlation_multiplier"])


# -- compose's refusals -------------------------------------------------


def test_compose_refuses_to_size_the_cash_sleeve():
    with pytest.raises(Z.SizingError, match="residual"):
        Z.compose([sig("cash", cap=1.0)], asof=pd.Timestamp("2010-06-30"))


def test_compose_refuses_a_repeated_sleeve():
    with pytest.raises(Z.SizingError, match="twice"):
        Z.compose([sig("gold"), sig("gold")], asof=pd.Timestamp("2010-06-30"))


@pytest.mark.parametrize("cap", [0.0, -0.1, 1.5])
def test_compose_refuses_an_impossible_cap(cap):
    with pytest.raises(Z.SizingError, match="cap"):
        Z.compose([sig("gold", cap=cap)], asof=pd.Timestamp("2010-06-30"))


# -- causality ----------------------------------------------------------


TRUNCATION_POINTS = (-1, -40, -260, -600)


@pytest.mark.parametrize("at", TRUNCATION_POINTS)
def test_weights_at_T_survive_truncation(at):
    """Cut the frame after T and the answer at T must not move.

    Literal truncation rather than inspection, because the failure this
    catches is invisible in review: a `shift(-1)`, a centred window, a
    reindex that pulls tomorrow backwards. All three read correctly and
    all three produce a beautiful backtest.
    """
    full = panel()
    stamp = full.index[at]
    here = Z.size_weights(full, asof=stamp)
    there = Z.size_weights(full.loc[:stamp], asof=stamp)

    assert here.asof == there.asof == stamp
    assert here.weights == there.weights
    assert here.cash_weight == there.cash_weight
    pd.testing.assert_frame_equal(here.explain(), there.explain())


@pytest.mark.parametrize("at", TRUNCATION_POINTS[:-1])
def test_weights_at_T_survive_the_future_being_poisoned(at):
    """The other half of the same claim, and the harder one to fake.

    Truncation proves nothing was read past the end of the frame.
    Poisoning proves nothing was read past the end of the WINDOW, which
    a lookahead that reindexes rather than slices would still be doing.
    """
    full = panel()
    stamp = full.index[at]
    poisoned = full.copy()
    poisoned.iloc[full.index.get_loc(stamp) + 1 :] = 1.0e6

    assert Z.size_weights(full, asof=stamp).weights == pytest.approx(
        Z.size_weights(poisoned, asof=stamp).weights
    )


def test_the_truncation_check_has_teeth():
    """The same comparison, against a call that genuinely does peek.

    A causality test that has never been shown to fail is a test of
    nothing. `asof=None` reads the last close in the frame, so asking
    for it on the full panel is exactly the lookahead the test above
    forbids — and the comparison has to notice.
    """
    full = panel()
    stamp = full.index[-40]
    honest = Z.size_weights(full, asof=stamp).weights
    peeking = Z.size_weights(full).weights
    assert honest != peeking


# -- the panel path -----------------------------------------------------


def walk(frame: pd.DataFrame, step: int = 37) -> list[Z.Allocation]:
    """Allocations across the sample, sampled rather than daily.

    A reporting cadence and nothing trades on it: consecutive days share
    251 of their 252 observations, so a daily walk would take minutes to
    assert what a sampled one asserts in seconds, and would not be a
    stronger claim.
    """
    return [
        Z.size_weights(frame, asof=stamp)
        for stamp in frame.index[Z.REQUIRED_SESSIONS - 20 :: step]
    ]


def test_the_account_s_four_facts_hold_on_every_sampled_date():
    for alloc in walk(panel()):
        for line in alloc.lines:
            assert line.weight >= 0.0
            assert line.weight <= line.cap + 1e-12
        assert alloc.gross <= 1.0 + 1e-9
        assert alloc.cash_weight >= 0.0
        assert abs(alloc.gross + alloc.cash_weight - 1.0) < 1e-9


def test_a_sleeve_walks_absent_then_unscored_then_included():
    """DBC's actual lifecycle, and the three states it passes through."""
    frame = panel()
    spec = next(s for s in BOOK if s.starts_at)
    listed = spec.starts_at

    def status(i: int) -> Z.SleeveStatus:
        alloc = Z.size_weights(frame, asof=frame.index[i])
        return alloc.by_asset[spec.key].status

    assert status(listed - 5) is Z.SleeveStatus.ABSENT
    assert status(listed + 20) is Z.SleeveStatus.UNSCORED
    assert status(listed + Z.REQUIRED_SESSIONS + 5) is Z.SleeveStatus.INCLUDED


def test_before_the_warmup_the_book_is_entirely_cash():
    frame = panel()
    alloc = Z.size_weights(frame, asof=frame.index[Z.REQUIRED_SESSIONS - 2])
    assert alloc.gross == 0.0
    assert alloc.cash_weight == 1.0
    assert alloc.n_included == 0
    assert all(line.status is not Z.SleeveStatus.INCLUDED for line in alloc.lines)


def test_the_cash_sleeve_never_reaches_the_sizing():
    """Its presence in the panel must not move a single risk weight.

    Not a tidiness point. The inverse-vol reference is a cross-sectional
    MEDIAN, and a bill fund sitting on the volatility floor would drag
    that median down and inflate every other sleeve's scalar by the same
    factor — a portfolio decision taken by a column nobody meant to
    include.
    """
    with_cash = Z.size_weights(panel(with_cash=True))
    without = Z.size_weights(panel(with_cash=False))
    assert with_cash.weights == without.weights
    assert CASH_KEY not in with_cash.weights
    assert with_cash.cash_sleeve == CASH_KEY
    assert with_cash.cash_available is True


def test_the_haircut_only_ever_reduces_on_a_real_panel():
    """The live correlation module, on a book that is really one bet.

    The bound on the multiplier is asserted from outside the correlation
    module rather than taken on its word, because the haircut is the one
    step here whose input this file did not compute.
    """
    fired = 0
    total = 0
    for alloc in walk(panel(single_factor=True)):
        for line in alloc.lines:
            if line.status is not Z.SleeveStatus.INCLUDED:
                continue
            floor = 1.0 - correlation.MAX_HAIRCUT
            assert line.correlation_multiplier >= floor - 1e-12
            assert line.correlation_multiplier <= 1.0
            assert line.after_correlation <= line.after_vol + 1e-12
            fired += line.haircut > 1e-9
            total += 1
    assert fired > 0.8 * total, (
        f"a one-factor book attracted a haircut on only {fired} of {total} "
        "sleeve-dates; the fixture has stopped being crowded"
    )


def test_where_the_haircut_is_zero_the_weight_is_untouched():
    """Nothing means a multiplier of exactly one, not a small bonus.

    The two-factor panel carries a working hedge, so a sleeve's
    book-weighted mean correlation nets below `RHO_FREE` often enough
    that this branch is live — and when it is, the diversifier must pass
    through unchanged rather than being rewarded for diversifying.
    """
    quiet = 0
    for alloc in walk(panel()):
        for line in alloc.lines:
            if line.status is not Z.SleeveStatus.INCLUDED:
                continue
            if line.haircut == 0.0:
                assert line.correlation_multiplier == 1.0
                assert line.after_correlation == line.after_vol
                quiet += 1
    assert quiet > 0


def test_an_unmeasured_sleeve_passes_the_haircut_untouched():
    """A sleeve outside the matrix is not charged on absent evidence.

    Reached by asking for a correlation window twice the length of the
    other two, which is the general shape of the case rather than a
    contrivance: the three signals need different amounts of history,
    and a sleeve that has satisfied two of them has to be sized on what
    those two say rather than held back — or charged — for the third.
    """
    frame = panel()
    spec = next(s for s in BOOK if s.starts_at)
    alloc = Z.size_weights(
        frame,
        asof=frame.index[spec.starts_at + Z.REQUIRED_SESSIONS + 20],
        correlation_lookback=2 * correlation.LOOKBACK,
    )
    line = alloc.by_asset[spec.key]
    assert line.status is Z.SleeveStatus.INCLUDED
    assert math.isnan(line.book_correlation)
    assert line.correlation_multiplier == 1.0
    assert line.after_correlation == line.after_vol
    # And its neighbours, which do have the window, were measured.
    assert not math.isnan(alloc.by_asset["us_equity"].book_correlation)


# -- the panel path's refusals ------------------------------------------


def test_an_uncapped_column_is_refused():
    frame = panel().assign(AAPL=100.0)
    with pytest.raises(Z.SizingError, match="not a sleeve"):
        Z.size_weights(frame)


def test_an_uncapped_column_may_be_admitted_deliberately():
    frame = panel().assign(AAPL=100.0)
    alloc = Z.size_weights(frame, caps={"AAPL": 0.05})
    assert alloc.by_asset["AAPL"].cap == 0.05
    assert alloc.by_asset["AAPL"].weight <= 0.05 + 1e-12


def test_a_cap_override_is_honoured():
    base = Z.size_weights(panel())
    tight = Z.size_weights(panel(), caps={"us_equity": 0.05})
    assert tight.by_asset["us_equity"].weight <= 0.05 + 1e-12
    assert base.by_asset["us_equity"].weight > 0.05


def test_asof_resolves_backward_never_forward():
    frame = panel()
    stamp = frame.index[-40]
    # A Sunday between two sessions: the answer must be the session
    # BEFORE it, because the one after has not happened.
    weekend = stamp + pd.Timedelta(days=1)
    while weekend in frame.index:
        weekend += pd.Timedelta(days=1)
    resolved = Z.size_weights(frame, asof=weekend)
    assert resolved.asof <= weekend
    assert resolved.asof in frame.index


def test_a_date_before_the_panel_is_refused():
    with pytest.raises(Z.SizingError, match="no session on or before"):
        Z.size_weights(panel(), asof="2001-01-02")


def test_an_unsorted_or_duplicated_index_is_refused():
    frame = panel()
    with pytest.raises(Z.SizingError, match="sorted"):
        Z.size_weights(frame.iloc[::-1])
    doubled = pd.concat([frame, frame.iloc[[-1]]])
    with pytest.raises(Z.SizingError, match="duplicate session"):
        Z.size_weights(doubled)


def test_a_panel_of_nothing_but_cash_is_refused():
    with pytest.raises(Z.SizingError, match="no risk sleeve"):
        Z.size_weights(panel().loc[:, [CASH_KEY]])


# -- the constants ------------------------------------------------------


def test_required_sessions_covers_all_three_signals():
    """Derived, not written down, so a widened window cannot be forgotten."""
    assert Z.REQUIRED_SESSIONS >= max(trend.LOOKBACKS) + 1
    assert Z.REQUIRED_SESSIONS >= volatility.MIN_SESSIONS
    assert Z.REQUIRED_SESSIONS >= correlation.LOOKBACK + 1
    assert Z.WARMUP_SESSIONS == Z.REQUIRED_SESSIONS - 1


def test_one_session_past_the_warmup_produces_a_sized_book():
    frame = panel()
    alloc = Z.size_weights(frame, asof=frame.index[Z.REQUIRED_SESSIONS - 1])
    assert alloc.n_included > 0


# -- the strategy adapter -----------------------------------------------


@dataclass
class FakeView:
    """Only what the Strategy protocol lets a strategy see.

    A stand-in rather than a real `MarketView` for the unit tests below,
    on the same principle the engine uses: the object a strategy is
    handed contains no handle to tomorrow, so the tests that check the
    adapter's arithmetic do not need a whole backtest to run.
    """

    asof: pd.Timestamp
    close_adj: pd.DataFrame
    caps: dict[str, float]


def view_at(frame: pd.DataFrame, i: int, caps: dict | None = None) -> FakeView:
    cut = frame.iloc[: i + 1]
    return FakeView(
        asof=pd.Timestamp(cut.index[-1]),
        close_adj=cut,
        caps=caps if caps is not None else {c: 1.0 for c in frame.columns},
    )


def test_the_adapter_returns_a_complete_legal_book():
    frame = panel()
    strategy = Z.SleeveSizing()
    targets = strategy.targets(view_at(frame, len(frame) - 1))

    assert set(targets) == set(str(c) for c in frame.columns)
    assert all(w >= 0.0 for w in targets.values())
    assert sum(targets.values()) <= 1.0 + 1e-9
    assert strategy.warmup == Z.WARMUP_SESSIONS


def test_the_adapter_ignores_the_engine_s_default_cap_for_a_stranger():
    """The engine caps every asset, including at its 1.00 default.

    Taking that at face value would let an unrecognised column into the
    book at full size through the back door, which is precisely what
    `_cap_for` refuses to do out front.
    """
    frame = panel().assign(AAPL=100.0)
    strategy = Z.SleeveSizing()
    with pytest.raises(Z.SizingError, match="not a sleeve"):
        strategy.targets(view_at(frame, len(frame) - 1))


def test_the_adapter_reads_a_configured_cap_from_the_view():
    frame = panel()
    caps = {str(c): 1.0 for c in frame.columns}
    caps["us_equity"] = 0.05
    strategy = Z.SleeveSizing()
    targets = strategy.targets(view_at(frame, len(frame) - 1, caps=caps))
    assert targets["us_equity"] <= 0.05 + 1e-12


def test_the_adapter_holds_the_cash_sleeve_only_when_asked():
    frame = panel()
    held = Z.SleeveSizing(hold_cash_sleeve=True)
    left = Z.SleeveSizing(hold_cash_sleeve=False)

    a = held.targets(view_at(frame, len(frame) - 1))
    b = left.targets(view_at(frame, len(frame) - 1))

    assert a[CASH_KEY] == pytest.approx(held.allocations[-1].cash_weight)
    assert b[CASH_KEY] == 0.0
    assert {k: v for k, v in a.items() if k != CASH_KEY} == {
        k: v for k, v in b.items() if k != CASH_KEY
    }


def test_the_adapter_records_one_row_per_date_per_sleeve():
    frame = panel()
    strategy = Z.SleeveSizing()
    dates = [len(frame) - 1 - k for k in (0, 5, 10)]
    for i in sorted(dates):
        strategy.targets(view_at(frame, i))

    table = strategy.decomposition()
    n_risk = len([c for c in frame.columns if c != CASH_KEY])
    assert len(table) == len(dates) * n_risk
    assert set(table["status"]) <= {s.value for s in Z.SleeveStatus}
    assert table["date"].nunique() == len(dates)


def test_recording_can_be_switched_off():
    frame = panel()
    strategy = Z.SleeveSizing(record=False)
    strategy.targets(view_at(frame, len(frame) - 1))
    assert strategy.allocations == ()
    assert Z.decomposition([]).empty


# -- the engine drives it -----------------------------------------------


@lru_cache(maxsize=1)
def market() -> MarketData:
    """A tradable panel keyed by VEHICLE TICKER.

    Deliberately the other spelling from the panel above. The rest of
    the project columns frames both ways and a sizing layer that only
    understood sleeve keys would be a silent no-op against the engine,
    where the assets are whatever the price frame called them.
    """
    idx = nyse_sessions(PANEL_START, PANEL_END)
    n = len(idx)
    rng = np.random.default_rng(SEED + 1)
    daily_factor = FACTOR_VOL / math.sqrt(SESSIONS_PER_YEAR)
    equity = daily_factor * rng.standard_normal(n)
    rates = daily_factor * rng.standard_normal(n)

    rows: list[pd.DataFrame] = []
    for spec in (*BOOK, Spec(CASH_KEY, 0.0, 0.0, 0.0)):
        ticker = SLEEVE_BY_KEY[spec.key].ticker
        if spec.key == CASH_KEY:
            r = 0.00008 + 0.00004 * rng.standard_normal(n)
        else:
            r = (
                spec.beta * equity
                + spec.gamma * rates
                + spec.idio * DAILY_SCALE * rng.standard_normal(n)
            )
        close = 100.0 * np.exp(np.cumsum(r))
        rows.append(
            pd.DataFrame(
                {
                    "date": idx,
                    "ticker": ticker,
                    # No splits and no distributions in the fixture, so
                    # the two closes coincide. The engine's total-return
                    # arithmetic is `test_backtest`'s business.
                    "open_unadj": close * (1.0 + 0.001 * rng.standard_normal(n)),
                    "close_unadj": close,
                    "close_adj": close,
                    "volume_unadj": 5.0e6,
                }
            )
        )
    return MarketData.from_prices(pd.concat(rows, ignore_index=True))


def test_the_engine_runs_the_adapter_end_to_end():
    """The protocol satisfied against the real loop, not a stand-in.

    The engine raises on a negative target and on a gross above NAV, so
    a run that completes is itself the assertion — but the weights it
    actually held are checked too, since a strategy can obey the
    contract and still be talked into a book by the fill logic.
    """
    strategy = Z.SleeveSizing()
    result = run_backtest(
        market(),
        strategy,
        BacktestConfig(
            starting_cash=131_000.0,
            band_provenance="not tuned; the engine default, unexamined here",
        ),
    )

    assert result.strategy == "sleeve sizing"
    assert len(result.equity) == len(market().index)
    assert result.equity.notna().all()
    assert (result.equity > 0).all()

    held = result.weights
    assert (held.to_numpy() >= -1e-9).all()
    assert (held.sum(axis=1).to_numpy() <= 1.0 + 1e-6).all()

    # It decided on every session past the warmup, and the decisions are
    # all on the record.
    assert len(strategy.allocations) == len(market().index) - Z.WARMUP_SESSIONS - 1
    table = strategy.decomposition()
    assert len(table) == len(strategy.allocations) * (len(BOOK))
    assert table["weight"].min() >= 0.0


def test_the_engine_run_puts_money_to_work():
    """A composition that never invests would pass every test above.

    So one test asserts the opposite of a failure: past the warmup, on a
    panel with trends in it, the book is not permanently in cash.
    """
    strategy = Z.SleeveSizing()
    result = run_backtest(
        market(),
        strategy,
        BacktestConfig(
            starting_cash=131_000.0,
            band_provenance="not tuned; the engine default, unexamined here",
        ),
    )
    invested = result.daily.set_index("date")["invested_weight"]
    assert invested.iloc[-1] > 0.10
    assert int(len(result.trades)) > 0
