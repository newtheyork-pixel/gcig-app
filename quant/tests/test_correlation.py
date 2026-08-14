"""The correlation haircut, tested on panels we invented on purpose.

There is no price cache to test against — the free endpoint is dark —
so every frame here is generated from a fixed seed against a factor
model whose ground truth we know. That is the better fixture anyway for
this signal: a real panel can only show that the numbers came out, and
a generated one can put a known correlation structure in and check that
the same structure comes back.

The test that matters most is the pair of causality tests. An off-by-one
in the window is invisible in review, produces a beautiful backtest, and
is the single most common way a project like this fools itself, so it is
not tested by inspection: the frame is truncated after T, and separately
poisoned after T, and the score at T has to come back bit-for-bit
identical both times.

The model has TWO factors, and that is not decoration. One factor
cannot produce a panel where the two Treasury sleeves are 0.96
correlated with each other and only -0.14 with equities, which is the
structure the whole signal is about — and a single-factor fixture would
quietly test a book in which every diversifier is also a duplicate.

Everything in here is a MECHANISM test. Nothing asserts that the signal
earns anything, because no performance number exists for it to be
fitted to, and generating one against a synthetic panel and then tuning
to it would be the same overfitting with an extra step.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
import pytest

from griffinquant.data import schema
from griffinquant.data.synthetic import nyse_sessions
from griffinquant.engine.backtest import MarketData
from griffinquant.signals import correlation as C

SESSIONS_PER_YEAR = 252

#: Annualised standard deviation of each of the two common factors, and
#: the daily scale idiosyncratic risk is quoted in multiples of. Both
#: are round and neither is under test; they exist so the implied
#: correlations below come out at recognisable levels.
FACTOR_VOL = 0.16
DAILY_SCALE = 0.010

#: Distributions land every twenty-one sessions — monthly, which is what
#: the bond and credit sleeves actually pay — and each sleeve is on its
#: own phase. The phase is the point: a synchronised drip is a SHARED
#: shock and would raise measured correlation, which is the opposite of
#: the effect this fixture exists to demonstrate.
DIVIDEND_INTERVAL = 21


@dataclass(frozen=True)
class Spec:
    """One made-up sleeve, as loadings on two common factors.

    `beta` is the equity factor, `gamma` the rates factor, `idio` a
    multiple of `DAILY_SCALE`. The implied correlation of any pair is
    then a closed form (`implied_correlation`), which is what lets a
    test assert against the structure rather than discover it.
    """

    key: str
    beta: float
    gamma: float
    idio: float
    div_yield: float = 0.0
    #: Sessions of the panel this sleeve simply did not exist for. The
    #: DBC and BIL case: the vehicle had not listed yet.
    starts_at: int = 0


#: A book shaped like the real one. The equity sleeves load on one
#: factor and nothing else; the two Treasury sleeves load hard on a
#: rates factor and slightly negatively on equity; gold sits mostly on
#: its own. The implied levels — 0.90 US/international, 0.96 between the
#: two duration sleeves, -0.14 equity to Treasuries — are the levels
#: those pairs actually run at, which matters because a fixture that
#: puts every correlation at 0.5 tests arithmetic and nothing else.
SLEEVES: tuple[Spec, ...] = (
    Spec("us_equity", beta=1.00, gamma=0.00, idio=0.30, div_yield=0.020),
    Spec("intl_developed", beta=0.95, gamma=0.00, idio=0.35, div_yield=0.030),
    Spec("emerging_markets", beta=0.90, gamma=0.00, idio=0.55, div_yield=0.025),
    Spec("duration_intermediate", beta=-0.15, gamma=1.00, idio=0.20, div_yield=0.030),
    Spec("duration_long", beta=-0.20, gamma=1.60, idio=0.30, div_yield=0.035),
    Spec("gold", beta=0.05, gamma=0.20, idio=1.00, div_yield=0.000),
)

#: The book most of these tests hand the signal, and it is deliberately
#: NOT equal weight. A six-sleeve equal-weight book with two genuinely
#: hedging sleeves in it nets almost every book correlation below
#: `RHO_FREE` and the adjustment correctly does nothing — which is a
#: property worth its own test (there is one below) and useless as the
#: setting for every other one. This shape is what the sleeve caps
#: imply a real proposal looks like: equity-led, with a smaller
#: defensive leg beside it.
EQUITY_HEAVY: dict[str, float] = {
    "us_equity": 0.35,
    "intl_developed": 0.25,
    "emerging_markets": 0.15,
    "duration_intermediate": 0.10,
    "duration_long": 0.05,
    "gold": 0.10,
}


def implied_correlation(a: Spec, b: Spec) -> float:
    """The correlation the generator was asked to produce.

    Two independent unit-variance factors and independent noise, so the
    covariance is the dot product of the loadings and the variance adds.
    """
    u = DAILY_SCALE / (FACTOR_VOL / math.sqrt(SESSIONS_PER_YEAR))

    def var(s: Spec) -> float:
        return s.beta**2 + s.gamma**2 + (s.idio * u) ** 2

    return (a.beta * b.beta + a.gamma * b.gamma) / math.sqrt(var(a) * var(b))


def price_frame(
    sessions: pd.DatetimeIndex,
    specs: tuple[Spec, ...],
    *,
    seed: int,
    crises: tuple[tuple[int, int], ...] = (),
    crisis_beta: float | None = None,
    crisis_gamma: float | None = None,
    crisis_idio: float | None = None,
) -> pd.DataFrame:
    """A long `schema.PRICES` frame from a two-factor model.

    `close_adj` is the total-return series and is what every signal
    reads. `close_unadj` is derived from it by removing the future
    distributions, which is the vendor convention: the two agree on the
    last bar of the panel and nowhere else, and on an ex-date the
    as-traded series takes a step the total-return series does not.
    That step is the whole reason this file carries a dividend at all.

    A crisis window rewrites whichever of the three loadings is
    supplied and leaves the rest. That split matters, because the two
    crises this signal is about are different shapes. In 2008 and 2020
    the equity cluster converged while Treasuries rallied — the hedge
    HELD — which is `crisis_idio` alone. In 2022 stocks and bonds fell
    together, which is `crisis_beta` on every sleeve at once. Modelling
    both with one knob would have hidden the fact that they produce
    opposite adjustments.
    """
    rng = np.random.default_rng(seed)
    n = len(sessions)
    scale = FACTOR_VOL / math.sqrt(SESSIONS_PER_YEAR)
    equity_factor = rng.normal(0.0, scale, n)
    rates_factor = rng.normal(0.0, scale, n)

    rows: list[pd.DataFrame] = []
    for i, spec in enumerate(specs):
        beta = np.full(n, spec.beta)
        gamma = np.full(n, spec.gamma)
        idio = np.full(n, spec.idio)
        for lo, hi in crises:
            if crisis_beta is not None:
                beta[lo:hi] = crisis_beta
            if crisis_gamma is not None:
                gamma[lo:hi] = crisis_gamma
            if crisis_idio is not None:
                idio[lo:hi] = crisis_idio

        shock = rng.standard_normal(n)
        r = beta * equity_factor + gamma * rates_factor + idio * DAILY_SCALE * shock
        adj = 100.0 * np.cumprod(1.0 + r)

        # The as-traded series is the total-return one with every LATER
        # distribution taken back out, so the pair meets at the final
        # bar. Each sleeve is on its own ex-date phase, because a
        # synchronised drip would be a shared shock and would raise the
        # measured correlation rather than attenuate it.
        q = spec.div_yield / (SESSIONS_PER_YEAR / DIVIDEND_INTERVAL)
        ex = np.zeros(n, dtype=bool)
        if q > 0.0:
            phase = 1 + (7 * i) % DIVIDEND_INTERVAL
            ex[phase::DIVIDEND_INTERVAL] = True
        after = np.cumsum(ex[::-1])[::-1] - ex.astype(int)
        unadj = adj * (1.0 - q) ** after

        take = np.arange(spec.starts_at, n)
        close_u = unadj[take]
        opens = close_u * (1.0 + rng.normal(0.0, 0.002, len(take)))
        rows.append(
            pd.DataFrame(
                {
                    "permaticker": np.full(len(take), 9_000_001 + i, dtype="int64"),
                    "ticker": pd.Series([spec.key] * len(take), dtype="str"),
                    "date": sessions.to_numpy()[take],
                    "open_unadj": opens,
                    "high_unadj": np.maximum(opens, close_u) * 1.003,
                    "low_unadj": np.minimum(opens, close_u) * 0.997,
                    "close_unadj": close_u,
                    "volume_unadj": np.full(len(take), 5.0e6),
                    "close_adj": adj[take],
                    "dividends": np.where(ex[take], close_u * q / (1.0 - q), 0.0),
                    "split_factor": np.ones(len(take)),
                }
            )
        )

    frame = pd.concat(rows, ignore_index=True)
    frame = frame.sort_values(["permaticker", "date"], kind="stable").reset_index(
        drop=True
    )
    return schema.PRICES.validate(frame, source="tests.correlation")


def wide(frame: pd.DataFrame, field: str = "close_adj") -> pd.DataFrame:
    """The engine's own pivot, so the signal is fed what a strategy sees."""
    market = MarketData.from_prices(frame, key="ticker")
    return getattr(market, field)


def window_positions(
    sessions: pd.DatetimeIndex, start: str, end: str
) -> tuple[int, int]:
    return (
        int(sessions.searchsorted(pd.Timestamp(start))),
        int(sessions.searchsorted(pd.Timestamp(end))),
    )


@pytest.fixture(scope="module")
def sessions() -> pd.DatetimeIndex:
    # Long enough to contain 2008 AND 2020, which are the two windows
    # the brief names, plus a quiet stretch afterwards to read them
    # against. Inside the calendar bounds conftest widens to.
    return nyse_sessions(pd.Timestamp("2006-01-03"), pd.Timestamp("2024-12-31"))


@pytest.fixture(scope="module")
def panel(sessions: pd.DatetimeIndex) -> pd.DataFrame:
    return price_frame(sessions, SLEEVES, seed=20060103)


@pytest.fixture(scope="module")
def closes(panel: pd.DataFrame) -> pd.DataFrame:
    return wide(panel)


@pytest.fixture()
def book(closes: pd.DataFrame) -> dict[str, float]:
    return dict(EQUITY_HEAVY)


# -- the fixture is what it claims to be --------------------------------


def test_fixture_conforms_to_the_price_schema(panel: pd.DataFrame) -> None:
    schema.PRICES.validate(panel, source="tests.correlation")
    assert set(panel["ticker"]) == {s.key for s in SLEEVES}
    # The two price spaces must actually differ, or every claim this
    # file makes about reading close_adj is untested.
    payers = panel.loc[panel["ticker"] == "us_equity"]
    assert not np.allclose(payers["close_adj"], payers["close_unadj"])


def test_fixture_reproduces_the_correlation_it_was_built_with(
    closes: pd.DataFrame,
) -> None:
    """The two-factor model's implied structure, recovered from the tape."""
    est = C.estimate_correlation(closes, lookback=2000)
    by_key = {s.key: s for s in SLEEVES}
    for a, b in (
        ("us_equity", "intl_developed"),
        ("us_equity", "duration_intermediate"),
        ("duration_intermediate", "duration_long"),
        ("us_equity", "gold"),
    ):
        assert est.sample_correlation.loc[a, b] == pytest.approx(
            implied_correlation(by_key[a], by_key[b]), abs=0.05
        )

    # The structure the whole signal is about: a tight equity cluster, a
    # tight duration cluster, and the two only weakly related.
    assert est.sample_correlation.loc["us_equity", "intl_developed"] > 0.85
    assert (
        est.sample_correlation.loc["duration_intermediate", "duration_long"] > 0.90
    )
    assert abs(est.sample_correlation.loc["us_equity", "duration_long"]) < 0.30


# -- THE test -----------------------------------------------------------


def test_causality_truncating_the_future_changes_nothing(
    closes: pd.DataFrame, book: dict[str, float]
) -> None:
    """Truncate after T, recompute, and demand the same bits.

    Not `approx`. An off-by-one that pulled tomorrow's close into
    today's window would move the answer in the twelfth decimal on a
    quiet day and by a per cent on a loud one, and a tolerance wide
    enough to be convenient is wide enough to pass the loud day's bug
    on the quiet day's test.
    """
    asof = closes.index[1500]

    full = C.adjust_weights(book, closes, asof=asof)
    cut = C.adjust_weights(book, closes.loc[:asof])

    assert full.estimate.asof == cut.estimate.asof == asof
    assert full.estimate.sleeves == cut.estimate.sleeves
    assert (
        full.estimate.correlation.to_numpy().tobytes()
        == cut.estimate.correlation.to_numpy().tobytes()
    )
    assert full.estimate.shrinkage == cut.estimate.shrinkage
    assert full.estimate.average_correlation == cut.estimate.average_correlation
    assert full.multiplier.to_numpy().tobytes() == cut.multiplier.to_numpy().tobytes()
    assert full.adjusted.to_numpy().tobytes() == cut.adjusted.to_numpy().tobytes()
    # And the test proves nothing if the adjustment was a no-op.
    assert full.freed_to_cash > 0.0


def test_causality_poisoning_the_future_changes_nothing(
    closes: pd.DataFrame, book: dict[str, float]
) -> None:
    """The stronger form: leave the future present, make it nonsense.

    Truncation alone cannot catch an estimator that reads the whole
    panel and then slices — a mean over four thousand rows would move
    here and not there. So every bar after T is replaced with a
    different draw at a different level, and the answer at T still has
    to be the same bits.
    """
    asof = closes.index[1500]
    reference = C.adjust_weights(book, closes, asof=asof)

    rng = np.random.default_rng(11)
    poisoned = closes.copy()
    future = poisoned.index > asof
    poisoned.loc[future, :] = rng.uniform(
        1.0, 900.0, size=(int(future.sum()), poisoned.shape[1])
    )

    after = C.adjust_weights(book, poisoned, asof=asof)
    assert (
        after.estimate.correlation.to_numpy().tobytes()
        == reference.estimate.correlation.to_numpy().tobytes()
    )
    assert (
        after.multiplier.to_numpy().tobytes()
        == reference.multiplier.to_numpy().tobytes()
    )


def test_causality_holds_for_every_sampled_date_in_the_history(
    closes: pd.DataFrame,
) -> None:
    """The walk cannot be causal only at the date somebody spot-checked."""
    history = C.adjustment_history(closes, weights=EQUITY_HEAVY, step=400)
    assert len(history) >= 8

    for stamp in history["date"]:
        point = C.adjust_weights(EQUITY_HEAVY, closes.loc[:stamp])
        row = history.loc[history["date"] == stamp].iloc[0]
        assert float(row["shrinkage"]) == point.estimate.shrinkage
        assert float(row["freed_to_cash"]) == point.freed_to_cash


def test_estimate_is_deterministic(closes: pd.DataFrame) -> None:
    a = C.estimate_correlation(closes, asof=closes.index[900])
    b = C.estimate_correlation(closes, asof=closes.index[900])
    assert a.correlation.to_numpy().tobytes() == b.correlation.to_numpy().tobytes()
    assert a.shrinkage == b.shrinkage


# -- the adjustment may only ever reduce --------------------------------


def test_the_adjustment_never_raises_a_weight(closes: pd.DataFrame) -> None:
    """Swept across the sample and across books, with no exceptions.

    One counterexample anywhere would mean the haircut can add
    exposure, at which point it has become a return signal nobody
    designed, reviewed or counted as a trial.
    """
    rng = np.random.default_rng(3)
    keys = list(closes.columns)
    seen_a_cut = False
    for i in range(300, len(closes), 137):
        weights = dict(zip(keys, rng.dirichlet(np.ones(len(keys)))))
        adj = C.adjust_weights(weights, closes, asof=closes.index[i])
        assert bool((adj.adjusted <= adj.proposed + 1e-15).all())
        assert bool((adj.multiplier <= 1.0).all())
        assert bool((adj.multiplier >= 1.0 - C.MAX_HAIRCUT).all())
        assert adj.freed_to_cash >= -1e-15
        seen_a_cut = seen_a_cut or adj.freed_to_cash > 0.0
    assert seen_a_cut, "the sweep never exercised an actual haircut"


def test_freed_weight_is_reported_and_never_written_anywhere(
    closes: pd.DataFrame,
) -> None:
    """Cash is where the weight goes and this module still does not send it.

    A function permitted to raise one weight has to be trusted about
    which one. The engine already reads the shortfall as cash.
    """
    weights = {k: v * 0.9 for k, v in EQUITY_HEAVY.items()}
    weights["cash"] = 0.10
    adj = C.adjust_weights(weights, closes, asof=closes.index[1200])

    assert adj.adjusted["cash"] == pytest.approx(0.10)
    assert float(adj.adjusted.sum()) < float(adj.proposed.sum())
    assert adj.freed_to_cash == pytest.approx(
        float(adj.proposed.sum() - adj.adjusted.sum())
    )


def test_a_diversifying_sleeve_is_left_alone(closes: pd.DataFrame) -> None:
    """Gold loads on almost nothing shared, so it pays nothing."""
    adj = C.adjust_weights(EQUITY_HEAVY, closes, asof=closes.index[1500])
    assert adj.book_correlation["gold"] < C.RHO_FREE
    assert adj.multiplier["gold"] == 1.0
    assert adj.adjusted["gold"] == adj.proposed["gold"]
    # The equity cluster, meanwhile, is charged.
    assert adj.multiplier["us_equity"] < 1.0
    assert adj.multiplier["intl_developed"] < 1.0


def test_a_hedged_equal_weight_book_is_charged_almost_nothing(
    closes: pd.DataFrame,
) -> None:
    """The quiet case, asserted rather than left to be discovered.

    A book carrying a real offset nets: US equity sits 0.90 with
    developed international and -0.14 with intermediate Treasuries, and
    the weighted mean lands at the bottom of the ramp. That is the
    designed answer — a bet with a hedge beside it is not a duplicated
    bet — and it is the reason this signal is quiet in a calm regime
    and loud in 2022.
    """
    adj = C.adjust_weights(
        C._default_book(closes), closes, asof=closes.index[1500]
    )
    assert adj.freed_to_cash < 0.01
    assert float(adj.book_correlation.max()) < C.RHO_FREE + 0.05


# -- shrinkage ----------------------------------------------------------


def test_shrinkage_intensity_stays_in_the_unit_interval(
    closes: pd.DataFrame,
) -> None:
    for i in range(300, len(closes), 411):
        est = C.estimate_correlation(closes, asof=closes.index[i])
        assert 0.0 <= est.shrinkage <= 1.0
        assert -1.0 < est.average_correlation < 1.0


def test_the_shrunk_matrix_is_the_stated_convex_combination(
    closes: pd.DataFrame,
) -> None:
    """The claim the docstring makes, checked pair by pair.

    Off the diagonal, shrunk = (1-d) * sample + d * rBar. If that
    identity holds then a reader can verify any single entry of the
    matrix from three printed numbers, which is the entire reason the
    estimator was written in correlation space.
    """
    est = C.estimate_correlation(closes, asof=closes.index[1800])
    assert est.shrinkage > 0.0
    expected = (
        1.0 - est.shrinkage
    ) * est.sample_correlation.to_numpy() + est.shrinkage * est.average_correlation
    np.fill_diagonal(expected, 1.0)
    np.testing.assert_allclose(est.correlation.to_numpy(), expected, atol=1e-12)


def test_shrinkage_pulls_every_pair_toward_the_target(
    closes: pd.DataFrame,
) -> None:
    est = C.estimate_correlation(closes, asof=closes.index[1800])
    sample = est.sample_correlation
    for a in est.sleeves:
        for b in est.sleeves:
            if a == b:
                continue
            lo, hi = sorted((sample.loc[a, b], est.average_correlation))
            assert lo - 1e-12 <= est.correlation.loc[a, b] <= hi + 1e-12


def test_the_matrix_is_a_valid_correlation_matrix(closes: pd.DataFrame) -> None:
    est = C.estimate_correlation(closes, asof=closes.index[1200])
    r = est.correlation.to_numpy()
    np.testing.assert_allclose(np.diag(r), 1.0, atol=0.0)
    np.testing.assert_allclose(r, r.T, atol=0.0)
    assert np.all(np.abs(r) <= 1.0)
    assert float(np.linalg.eigvalsh(r).min()) >= -1e-12


# -- numerical safety ---------------------------------------------------


def test_two_identical_sleeves_do_not_break_anything(
    sessions: pd.DatetimeIndex,
) -> None:
    """A singular matrix is a case to survive, not an error to raise.

    Nothing here inverts the matrix, which is the whole reason a
    perfectly collinear pair is survivable at all — and the reason full
    mean-variance was refused. The shrinkage is what pulls the pair off
    1.00 and the matrix off the boundary of singularity, and the twin
    should be among the most heavily cut sleeves in the book, because
    it is exactly the redundancy this signal exists to find.
    """
    frame = price_frame(sessions, SLEEVES, seed=99)
    closes = wide(frame)
    # A literal duplicate: same series, two tickers. The sample
    # correlation is 1.0 to the last bit and the matrix is singular.
    closes = closes.assign(twin=closes["us_equity"].to_numpy())

    est = C.estimate_correlation(closes, asof=closes.index[1500])
    assert np.isfinite(est.correlation.to_numpy()).all()
    assert est.sample_correlation.loc["us_equity", "twin"] == pytest.approx(1.0)
    assert 0.90 < est.correlation.loc["us_equity", "twin"] < 1.0
    assert float(np.linalg.eigvalsh(est.correlation.to_numpy()).min()) >= -1e-12

    adj = C.adjust_weights(C._default_book(closes), closes, asof=closes.index[1500])
    assert np.isfinite(adj.multiplier.to_numpy()).all()
    assert adj.haircut["twin"] == pytest.approx(adj.haircut["us_equity"], abs=1e-9)
    assert adj.haircut["twin"] > adj.haircut["gold"]

    conc = C.concentration(adj.adjusted, est.correlation)
    assert math.isfinite(conc.effective_bets)
    assert math.isfinite(conc.largest_eigenvalue_share)


def test_a_perfectly_correlated_book_survives_the_concentration_measure() -> None:
    keys = ["a", "b", "c"]
    ones = pd.DataFrame(np.ones((3, 3)), index=keys, columns=keys)
    conc = C.concentration({k: 1 / 3 for k in keys}, ones)
    assert conc.effective_bets == pytest.approx(1.0, abs=1e-9)
    assert conc.largest_eigenvalue_share == pytest.approx(1.0, abs=1e-9)


# -- exclusion, never filling -------------------------------------------


def test_a_sleeve_with_too_little_history_is_excluded_not_filled(
    sessions: pd.DatetimeIndex,
) -> None:
    """The DBC case: the vehicle had not listed yet."""
    specs = SLEEVES + (
        Spec("commodity", beta=0.30, gamma=0.10, idio=0.90, starts_at=900),
    )
    closes = wide(price_frame(sessions, specs, seed=5))

    early = C.estimate_correlation(closes, asof=closes.index[800])
    assert "commodity" not in early.sleeves
    assert "required returns" in early.excluded["commodity"]

    late = C.estimate_correlation(closes, asof=closes.index[1400])
    assert "commodity" in late.sleeves

    adj = C.adjust_weights(C._default_book(closes), closes, asof=closes.index[800])
    assert adj.multiplier["commodity"] == 1.0
    assert adj.adjusted["commodity"] == adj.proposed["commodity"]


def test_a_hole_in_the_middle_excludes_the_sleeve(closes: pd.DataFrame) -> None:
    """One missing bar inside the window, and the sleeve steps out.

    Letting each pair use whatever overlap it has is how a symmetric
    matrix acquires a negative eigenvalue; requiring complete columns
    is what keeps it a real Gram matrix.
    """
    holed = closes.copy()
    holed.iloc[1400, holed.columns.get_loc("gold")] = np.nan

    est = C.estimate_correlation(holed, asof=closes.index[1500])
    assert "gold" not in est.sleeves
    assert "required returns" in est.excluded["gold"]

    # Far enough past the hole and it is back, unchanged.
    later = C.estimate_correlation(holed, asof=closes.index[1900])
    assert "gold" in later.sleeves


def test_a_flat_sleeve_is_excluded_rather_than_correlated_with_nothing(
    closes: pd.DataFrame,
) -> None:
    flat = closes.copy()
    flat.loc[:, "gold"] = 100.0
    est = C.estimate_correlation(flat, asof=closes.index[1500])
    assert "gold" not in est.sleeves
    assert "no variation" in est.excluded["gold"]


def test_cash_is_excluded_by_name_and_never_cut(
    sessions: pd.DatetimeIndex,
) -> None:
    specs = SLEEVES + (Spec("cash", beta=0.0, gamma=0.02, idio=0.02),)
    closes = wide(price_frame(sessions, specs, seed=17))
    est = C.estimate_correlation(closes, asof=closes.index[1500])
    assert "cash" not in est.sleeves
    assert "residual absorber" in est.excluded["cash"]

    weights = {c: 1.0 / len(closes.columns) for c in closes.columns}
    adj = C.adjust_weights(weights, closes, asof=closes.index[1500])
    assert adj.multiplier["cash"] == 1.0


def test_one_sleeve_is_unmeasured_rather_than_perfectly_diversified(
    closes: pd.DataFrame,
) -> None:
    est = C.estimate_correlation(closes.loc[:, ["gold"]], asof=closes.index[1500])
    assert est.sleeves == ("gold",)
    assert not est.measurable
    assert math.isnan(est.shrinkage)

    adj = C.adjust_weights(
        {"gold": 0.2}, closes.loc[:, ["gold"]], asof=closes.index[1500]
    )
    assert adj.multiplier["gold"] == 1.0


# -- interpretability ---------------------------------------------------


def test_the_haircut_can_be_recomputed_by_hand(closes: pd.DataFrame) -> None:
    """Every number in `explain()` derives from the printed matrix.

    A reader who cannot rebuild the cut from the table has been handed
    a black box with a footnote, which is what this signal was written
    instead of.
    """
    adj = C.adjust_weights(EQUITY_HEAVY, closes, asof=closes.index[1700])
    r = adj.estimate.correlation

    for key in adj.estimate.sleeves:
        others = [k for k in r.columns if k != key]
        denom = sum(EQUITY_HEAVY[k] for k in others)
        by_hand = sum(EQUITY_HEAVY[k] * float(r.loc[key, k]) for k in others) / denom
        assert adj.book_correlation[key] == pytest.approx(by_hand, abs=1e-12)

        reach = (by_hand - C.RHO_FREE) / (C.RHO_FULL - C.RHO_FREE)
        expected = C.MAX_HAIRCUT * min(max(reach, 0.0), 1.0)
        assert adj.haircut[key] == pytest.approx(expected, abs=1e-12)
        assert adj.adjusted[key] == pytest.approx(
            EQUITY_HEAVY[key] * (1.0 - expected), abs=1e-12
        )


def test_explain_names_the_sleeve_that_did_the_crowding(
    closes: pd.DataFrame,
) -> None:
    adj = C.adjust_weights(EQUITY_HEAVY, closes, asof=closes.index[1700])
    table = adj.explain().set_index("sleeve")

    assert table.loc["us_equity", "top_partner"] == "intl_developed"
    assert table.loc["intl_developed", "top_partner"] == "us_equity"
    assert table.loc["us_equity", "top_correlation"] > 0.8
    assert table.loc["duration_intermediate", "top_partner"] == "duration_long"
    assert table.loc["gold", "excluded_because"] == ""
    assert set(table.columns) >= {
        "proposed_weight",
        "book_correlation",
        "haircut",
        "multiplier",
        "adjusted_weight",
        "top_partner",
        "top_correlation",
    }


def test_book_correlation_weights_by_what_is_actually_held() -> None:
    """A duplicate held at one per cent is not a concentration problem."""
    keys = ["a", "b", "c"]
    r = pd.DataFrame(
        [[1.0, 0.95, 0.05], [0.95, 1.0, 0.05], [0.05, 0.05, 1.0]],
        index=keys,
        columns=keys,
    )
    heavy = C.book_correlation(r, {"a": 0.45, "b": 0.45, "c": 0.10})
    light = C.book_correlation(r, {"a": 0.45, "b": 0.01, "c": 0.54})
    assert heavy["a"] > 0.7
    assert light["a"] < C.RHO_FREE
    assert C.haircut_for(float(light["a"])) == 0.0


def test_a_sleeve_with_no_book_beside_it_is_charged_nothing() -> None:
    """Nothing else is held, so there is nothing to be a duplicate of."""
    keys = ["a", "b"]
    r = pd.DataFrame([[1.0, 0.99], [0.99, 1.0]], index=keys, columns=keys)
    rho = C.book_correlation(r, {"a": 0.5, "b": 0.0})
    assert math.isnan(rho["a"])
    assert C.haircut_for(float(rho["a"])) == 0.0


def test_a_negatively_correlated_sleeve_is_not_charged_for_the_sign() -> None:
    keys = ["a", "b"]
    r = pd.DataFrame([[1.0, -0.90], [-0.90, 1.0]], index=keys, columns=keys)
    rho = C.book_correlation(r, {"a": 0.5, "b": 0.5})
    assert rho["a"] == pytest.approx(-0.90)
    assert C.haircut_for(float(rho["a"])) == 0.0


# -- the ramp -----------------------------------------------------------


def test_the_ramp_is_the_stated_shape() -> None:
    assert C.haircut_for(-1.0) == 0.0
    assert C.haircut_for(C.RHO_FREE) == 0.0
    assert C.haircut_for(C.RHO_FULL) == pytest.approx(C.MAX_HAIRCUT)
    assert C.haircut_for(1.0) == pytest.approx(C.MAX_HAIRCUT)
    midpoint = (C.RHO_FREE + C.RHO_FULL) / 2.0
    assert C.haircut_for(midpoint) == pytest.approx(C.MAX_HAIRCUT / 2.0)
    assert C.haircut_for(float("nan")) == 0.0


def test_the_parameters_are_the_round_ones_that_were_written_down() -> None:
    """A guard on the constants, not a test of them.

    None of these was chosen by watching a result — there is no result
    in this repository for them to have been chosen against. This test
    exists so that a later edit that quietly retunes one has to say so
    in a diff.
    """
    assert C.LOOKBACK == 252
    assert C.RHO_FREE == 0.30
    assert C.RHO_FULL == 0.90
    assert C.MAX_HAIRCUT == 0.50
    assert C.LOOKBACK > 63, "the lookback must exceed the engine's vol window"


# -- correlations rising in a crisis ------------------------------------


def test_the_2022_shape_when_the_hedge_fails(
    sessions: pd.DatetimeIndex,
) -> None:
    """Everything converging at once: the full haircut, on every sleeve.

    This is the regime the signal exists for and the one no per-sleeve
    volatility measure can see. Nothing about any single sleeve has
    changed; what changed is that they stopped being different bets.

    A short window here on purpose — a test fixture for the mechanism,
    not a recommendation. With the production 252-session lookback a
    four-hundred-session regime enters at part weight and the assertion
    would be about the smoothing rather than about the response.
    """
    calm_specs = tuple(
        Spec(s.key, beta=0.15, gamma=0.0, idio=1.00, div_yield=s.div_yield)
        for s in SLEEVES
    )
    n = len(sessions)
    closes = wide(
        price_frame(
            sessions,
            calm_specs,
            seed=2022,
            crises=((n - 400, n),),
            crisis_beta=1.00,
            crisis_gamma=0.0,
            crisis_idio=0.30,
        )
    )
    book = C._default_book(closes)

    calm = C.adjust_weights(
        book, closes, asof=closes.index[n - 500], lookback=120, min_observations=120
    )
    crisis = C.adjust_weights(
        book, closes, asof=closes.index[n - 5], lookback=120, min_observations=120
    )

    assert calm.estimate.average_correlation < C.RHO_FREE
    assert crisis.estimate.average_correlation > C.RHO_FULL
    for key in crisis.estimate.sleeves:
        assert calm.haircut[key] == 0.0
        assert crisis.haircut[key] == pytest.approx(C.MAX_HAIRCUT)
    assert crisis.freed_to_cash > calm.freed_to_cash


# -- concentration ------------------------------------------------------


def test_independent_equally_weighted_sleeves_are_k_bets() -> None:
    for k in (2, 5, 9):
        keys = [f"s{i}" for i in range(k)]
        identity = pd.DataFrame(np.eye(k), index=keys, columns=keys)
        conc = C.concentration({key: 1.0 / k for key in keys}, identity)
        assert conc.effective_bets == pytest.approx(float(k), abs=1e-9)
        assert conc.largest_eigenvalue_share == pytest.approx(1.0 / k, abs=1e-9)
        assert conc.n_sleeves == k


def test_a_one_position_book_is_one_bet() -> None:
    keys = ["a", "b", "c"]
    identity = pd.DataFrame(np.eye(3), index=keys, columns=keys)
    conc = C.concentration({"a": 0.4, "b": 0.0, "c": 0.0}, identity)
    assert conc.effective_bets == pytest.approx(1.0, abs=1e-9)
    assert conc.n_sleeves == 1


def test_concentration_is_scale_invariant() -> None:
    keys = ["a", "b", "c"]
    r = pd.DataFrame(
        [[1.0, 0.6, 0.1], [0.6, 1.0, 0.2], [0.1, 0.2, 1.0]], index=keys, columns=keys
    )
    base = {"a": 0.4, "b": 0.3, "c": 0.2}
    halved = {k: v / 2.0 for k, v in base.items()}
    assert C.concentration(base, r).effective_bets == pytest.approx(
        C.concentration(halved, r).effective_bets, abs=1e-12
    )


def test_an_unmeasured_sleeve_cannot_improve_the_concentration() -> None:
    """A weight with no correlation estimate contributes nothing.

    Counting it as independent would let the sleeves we know least
    about flatter the number they were never measured for.
    """
    keys = ["a", "b"]
    r = pd.DataFrame([[1.0, 0.9], [0.9, 1.0]], index=keys, columns=keys)
    without = C.concentration({"a": 0.5, "b": 0.5}, r)
    with_ghost = C.concentration({"a": 0.5, "b": 0.5, "ghost": 0.5}, r)
    assert with_ghost.effective_bets == pytest.approx(without.effective_bets)
    assert with_ghost.n_sleeves == without.n_sleeves


def test_the_adjustment_reduces_concentration_on_a_redundant_book() -> None:
    """Two twins and an independent: cutting the twins buys a bet."""
    keys = ["twin_a", "twin_b", "alone"]
    r = pd.DataFrame(
        [[1.0, 0.95, 0.02], [0.95, 1.0, 0.02], [0.02, 0.02, 1.0]],
        index=keys,
        columns=keys,
    )
    proposed = pd.Series({k: 1 / 3 for k in keys})
    rho = C.book_correlation(r, proposed)
    multiplier = pd.Series(
        {k: 1.0 - C.haircut_for(float(rho[k])) for k in keys}, dtype="float64"
    )
    adjusted = proposed * multiplier

    before = C.concentration(proposed, r)
    after = C.concentration(adjusted, r)
    assert after.effective_bets > before.effective_bets
    assert after.largest_eigenvalue_share < before.largest_eigenvalue_share


def test_cutting_the_big_cluster_can_tilt_the_book_into_the_small_one() -> None:
    """The limitation, pinned so nobody rediscovers it as a surprise.

    Three sleeves at 0.95 with each other, two more at 0.95 with each
    other, and the two groups HEDGING at -0.30 — equity against
    duration. The proposed book already sits near the most balanced
    point available, so cutting the larger group moves the residual
    away from the balance rather than toward it, and the effective
    number of bets falls even though the book is smaller and holds more
    cash.

    Searched across the cross-correlation, the reversal appears only
    where the two clusters hedge; at zero and above the haircut always
    improves the measure. That is the honest boundary of a one-pass
    per-sleeve rule and half of it is a limit of the measure, which is
    scale-invariant and therefore blind to the de-risking that
    accompanied the tilt.
    """
    keys = ["a1", "a2", "a3", "b1", "b2"]
    values = np.full((5, 5), -0.30)
    values[:3, :3] = 0.95
    values[3:, 3:] = 0.95
    np.fill_diagonal(values, 1.0)
    r = pd.DataFrame(values, index=keys, columns=keys)

    proposed = pd.Series(
        {"a1": 0.15, "a2": 0.15, "a3": 0.15, "b1": 0.10, "b2": 0.10}, dtype="float64"
    )
    rho = C.book_correlation(r, proposed)
    adjusted = proposed * pd.Series(
        {k: 1.0 - C.haircut_for(float(rho[k])) for k in keys}, dtype="float64"
    )

    # The cut lands where it should: on the crowded three, not the two.
    assert float(adjusted[["a1", "a2", "a3"]].sum()) < 0.45
    assert float(adjusted[["b1", "b2"]].sum()) == pytest.approx(0.20)

    before = C.concentration(proposed, r)
    after = C.concentration(adjusted, r)
    assert after.effective_bets < before.effective_bets
    assert after.largest_eigenvalue_share > before.largest_eigenvalue_share
    # And the thing the measure cannot see, which is why it is printed
    # beside the measure and not instead of it.
    assert float(adjusted.sum()) < float(proposed.sum())


def test_a_uniform_haircut_leaves_the_mix_alone_and_says_so() -> None:
    """Scale invariance, stated as the honest limit of these measures.

    When every sleeve converges together the haircut is uniform and the
    effective number of bets does not move — correctly, because the mix
    did not. The de-risking is real and shows up in invested weight
    instead, which is why `evaluate` prints both.
    """
    keys = ["a", "b", "c"]
    values = np.full((3, 3), 0.95)
    np.fill_diagonal(values, 1.0)
    r = pd.DataFrame(values, index=keys, columns=keys)
    proposed = pd.Series({k: 1 / 3 for k in keys})
    adjusted = proposed * 0.5
    assert C.concentration(adjusted, r).effective_bets == pytest.approx(
        C.concentration(proposed, r).effective_bets
    )
    assert float(adjusted.sum()) < float(proposed.sum())


# -- close_adj is not interchangeable with close_unadj ------------------


def test_price_returns_understate_correlation(
    sessions: pd.DatetimeIndex,
) -> None:
    """The reason this signal reads close_adj, demonstrated.

    A distribution is a real negative print on the as-traded series and
    no return at all on the total-return one. Those prints are
    idiosyncratic — different sleeves, different days — so they add
    unshared variance to both series of every pair and ATTENUATE the
    measured correlation toward zero. A correlation signal fed
    unadjusted prices therefore reports the book as more diversified
    than it is, which is the exact error it was written to prevent.

    The dose here is deliberately heavy so the mechanism is
    unmistakable; on a real bond ETF at a three per cent yield the
    effect is a couple of per cent, in the same direction.
    """
    specs = tuple(
        Spec(s.key, beta=s.beta, gamma=s.gamma, idio=s.idio, div_yield=0.12)
        for s in SLEEVES
    )
    frame = price_frame(sessions, specs, seed=808)
    total_return = C.estimate_correlation(wide(frame, "close_adj"), lookback=2000)
    price_return = C.estimate_correlation(wide(frame, "close_unadj"), lookback=2000)

    assert not np.array_equal(
        total_return.correlation.to_numpy(), price_return.correlation.to_numpy()
    )
    pairs = [
        ("us_equity", "intl_developed"),
        ("us_equity", "emerging_markets"),
        ("duration_intermediate", "duration_long"),
    ]
    for a, b in pairs:
        assert (
            price_return.sample_correlation.loc[a, b]
            < total_return.sample_correlation.loc[a, b]
        )


# -- input discipline ---------------------------------------------------


def test_a_negative_weight_is_refused(closes: pd.DataFrame) -> None:
    with pytest.raises(C.CorrelationError, match="long-only"):
        C.adjust_weights({"gold": -0.1}, closes, asof=closes.index[1500])


def test_a_non_finite_weight_is_refused(closes: pd.DataFrame) -> None:
    with pytest.raises(C.CorrelationError):
        C.adjust_weights({"gold": float("nan")}, closes, asof=closes.index[1500])


def test_an_unsorted_or_duplicated_calendar_is_refused(
    closes: pd.DataFrame,
) -> None:
    with pytest.raises(C.CorrelationError, match="sorted"):
        C.estimate_correlation(closes.iloc[::-1])
    doubled = pd.concat([closes.iloc[:10], closes.iloc[:10]]).sort_index()
    with pytest.raises(C.CorrelationError, match="duplicate"):
        C.estimate_correlation(doubled)
    with pytest.raises(C.CorrelationError, match="indexed by date"):
        C.estimate_correlation(closes.reset_index(drop=True))


def test_an_impossible_window_is_refused(closes: pd.DataFrame) -> None:
    with pytest.raises(C.CorrelationError, match="lookback must be at least 2"):
        C.estimate_correlation(closes, lookback=1)
    with pytest.raises(C.CorrelationError, match="exceeds"):
        C.estimate_correlation(closes, lookback=60, min_observations=90)
    with pytest.raises(C.CorrelationError, match="no sessions on or before"):
        C.estimate_correlation(closes, asof="1990-01-02")


# -- the standalone diagnostic ------------------------------------------


def test_evaluate_runs_in_one_call_and_reports_both_measures(
    closes: pd.DataFrame,
) -> None:
    report = C.evaluate(closes, weights=EQUITY_HEAVY, step=63)

    assert report.n_dates > 10
    assert report.lookback == C.LOOKBACK
    assert "caller" in report.weights_note
    assert set(report.history.columns) == set(C._HISTORY_COLUMNS)
    assert report.history["date"].is_monotonic_increasing

    full = report.periods.iloc[0]
    assert full["period"] == "full sample"
    assert full["effective_bets_after"] > full["effective_bets_before"]
    assert full["largest_share_after"] < full["largest_share_before"]
    assert full["invested_after"] < full["invested_before"]

    # The forward measure is the honest half: the adjustment is graded
    # against correlations it never saw.
    assert math.isfinite(float(full["forward_effective_bets_before"]))
    assert (
        full["forward_effective_bets_after"] > full["forward_effective_bets_before"]
    )

    assert "effective number of bets" in report.headline


def test_evaluate_defaults_to_a_book_that_embodies_no_view(
    closes: pd.DataFrame,
) -> None:
    report = C.evaluate(closes, step=252)
    assert "equal weight" in report.weights_note
    assert report.n_dates > 5


def test_evaluate_keeps_a_row_for_a_window_the_sample_never_covered(
    closes: pd.DataFrame,
) -> None:
    """2008 gets a row whether or not the data reaches it.

    Dropping it would let a report publish a stress table with no
    stress in it and nothing saying any was expected — the rule
    `metrics.period_breakout` already states, restated here because
    this table is read next to that one.
    """
    late = closes.loc[closes.index >= "2011-01-01"]
    report = C.evaluate(late, weights=EQUITY_HEAVY, step=252)
    names = list(report.periods["period"])
    assert names[0] == "full sample"
    assert "2008" in names
    row = report.periods.loc[report.periods["period"] == "2008"].iloc[0]
    assert int(row["dates"]) == 0
    assert math.isnan(float(row["effective_bets_before"]))


def test_evaluate_reports_2008_and_2020_separately(
    sessions: pd.DatetimeIndex,
) -> None:
    """The two windows the brief names, and the shape they really had.

    In 2008 and 2020 the equity cluster converged while Treasuries
    rallied — the hedge held — so the fixture collapses idiosyncratic
    risk inside those windows and leaves the factor loadings alone.
    What the diagnostic should then find is a higher average
    correlation and more weight released to cash than in the quiet
    stretch after 2023, and it should find it in both windows
    independently.

    The 42-session window is a fixture choice and it is here because of
    a real property rather than in spite of one: 2020Q1 is about
    sixty-two sessions long, so a trailing 252-session estimator has
    seen at most a quarter of it by the last day of the quarter and
    cannot resolve the window at all. That lag is stated in the
    module's own docstring as the accepted cost of not de-risking on
    every three-day scare. Shortening the window here tests the
    mechanism; it is not a recommendation, and the production constant
    is asserted unchanged elsewhere in this file.
    """
    closes = wide(
        price_frame(
            sessions,
            SLEEVES,
            seed=2008,
            crises=(
                window_positions(sessions, "2008-01-02", "2009-06-30"),
                window_positions(sessions, "2020-01-02", "2020-06-30"),
            ),
            crisis_idio=0.10,
        )
    )
    report = C.evaluate(
        closes, weights=EQUITY_HEAVY, lookback=42, min_observations=42, step=5
    )
    periods = report.periods.set_index("period")

    quiet = periods.loc["2023-present"]
    assert int(quiet["dates"]) > 20
    for name in ("2008", "2020Q1"):
        stressed = periods.loc[name]
        assert int(stressed["dates"]) > 10, name
        assert stressed["average_correlation"] > quiet["average_correlation"], name
        assert stressed["mean_book_correlation"] > quiet["mean_book_correlation"], name
        assert stressed["freed_to_cash"] > quiet["freed_to_cash"], name


def test_the_headline_can_say_the_answer_is_no() -> None:
    """A diagnostic that can only print a success has tested nothing."""
    report = C.EvaluationReport(
        lookback=252,
        step=5,
        forward=252,
        weights_note="stub",
        n_dates=3,
        history=pd.DataFrame(),
        periods=pd.DataFrame(
            [
                {
                    "period": "full sample",
                    "effective_bets_before": 4.0,
                    "effective_bets_after": 3.2,
                    "forward_effective_bets_before": 4.1,
                    "forward_effective_bets_after": 3.3,
                    "invested_before": 1.0,
                    "invested_after": 0.8,
                }
            ]
        ),
    )
    assert "did not raise" in report.headline


def test_the_headline_says_so_when_nothing_could_be_measured() -> None:
    short = pd.DataFrame(
        {"a": [1.0, 2.0, 3.0]},
        index=pd.to_datetime(["2020-01-02", "2020-01-03", "2020-01-06"]),
    )
    report = C.evaluate(short, weights={"a": 1.0}, lookback=252)
    assert report.n_dates == 0
    assert "nothing was measured" in report.headline
