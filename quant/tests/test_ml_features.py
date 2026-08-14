"""The feature layer, held to the four things it promises.

The suite is built around one test and the rest are supporting cast.
`test_features_at_T_survive_truncation` computes the features on the
whole panel, computes them again on the panel literally cut off after
session T, and demands every value at T be bit-for-bit what it was when
the future was visible. An off-by-one in a trailing window is invisible
in review — the code reads correctly, the numbers look plausible, and
the classifier's AUC comes out encouraging — so it is not checked by
inspection.

Two tests then run the same machinery against deliberately leaky twins
and require it to FAIL, because a causality check that has never been
shown to fail is not evidence about anything. They leak in the two
shapes that matter and only one of them is obvious. A centred rolling
window turns to NaN at the truncation edge, which is loud. A
full-sample standardisation returns a perfectly finite, perfectly
plausible number that is merely different, and that is the one a
tolerance-based comparison would have let through — which is why the
comparison is exact.

The other three promises: that every return and risk figure comes off
the TOTAL-return series, which for the bond half of this universe is
nearly the whole of the return; that the liquidity feature reads
as-traded dollars rather than back-adjusted ones; and that a
cross-sectional rank is taken within a date over the names actually
alive on it.

Everything is generated. There is no network here — the panels are
seeded synthetic frames, the bill rate is a synthetic series, and the
universe assertions are about the table in `ml/universe.py` rather than
about anything fetched.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache

import numpy as np
import pandas as pd
import pytest

from griffinquant.data.synthetic import nyse_sessions
from griffinquant.ml import features as F
from griffinquant.ml import universe as U

SEED = 20050103

#: Long enough to clear the 252-session warmup and leave several years
#: of live features to sample truncation dates from, short enough that
#: rebuilding the panel once per checked date stays quick.
PANEL_START = date(2005, 1, 3)
PANEL_END = date(2011, 12, 30)


# -- the fixture --------------------------------------------------------


@dataclass(frozen=True)
class Spec:
    """One made-up fund: how it drifts, how volatile it is, and the two
    ways its printed price can differ from its total return."""

    ticker: str
    drift: float
    vol: float

    #: Sessions before this name prints anything. The panel is meant to
    #: grow — the real universe goes from twenty-two usable names to
    #: twenty-eight across 2005-2008 — and a cross-sectional rank over
    #: a fixed roster is a different calculation from one over a
    #: growing roster.
    first: int = 0

    #: The bond case. The as-traded close never moves and every cent of
    #: the return is distribution, so any feature reading `close_unadj`
    #: measures a security with no risk and no return whatsoever.
    coupon_only: bool = False


SPECS: tuple[Spec, ...] = (
    Spec("AAA", drift=0.0004, vol=0.011),
    Spec("BBB", drift=0.0002, vol=0.018),
    Spec("CCC", drift=0.0006, vol=0.008),
    Spec("DDD", drift=-0.0001, vol=0.014),
    # Lists two years in, like GLD and FXI do against a 2005 start.
    Spec("EEE", drift=0.0003, vol=0.021, first=500),
    # The bond sleeve, in the only form that matters for this test.
    Spec("FFF", drift=0.0002, vol=0.003, coupon_only=True),
)


@lru_cache(maxsize=4)
def sessions(start: date = PANEL_START, end: date = PANEL_END) -> pd.DatetimeIndex:
    return nyse_sessions(start, end)


@lru_cache(maxsize=2)
def panels() -> F.Panels:
    """A synthetic panel conforming to what `panels_from_prices` emits."""
    idx = sessions()
    n = len(idx)
    rng = np.random.default_rng(SEED)

    close_adj: dict[str, np.ndarray] = {}
    close_unadj: dict[str, np.ndarray] = {}
    volume: dict[str, np.ndarray] = {}

    for spec in SPECS:
        steps = rng.normal(spec.drift, spec.vol, n)
        adj = 100.0 * np.exp(np.cumsum(steps))

        if spec.coupon_only:
            # Flat price, all return in the adjustment. This is TLT and
            # LQD in miniature and it is the whole point of the fixture.
            unadj = np.full(n, 100.0)
        else:
            # An ordinary fund: the printed price tracks the total
            # return but lags it by the accumulated distributions, so
            # the two are neither equal nor proportional.
            unadj = adj * np.exp(-np.linspace(0.0, 0.12, n))

        # Volume with a genuine surge episode, so `turnover_surge` has
        # something to find rather than only noise.
        vol_path = rng.lognormal(15.0, 0.35, n)
        vol_path[n // 2 : n // 2 + 40] *= 4.0

        if spec.first:
            adj[: spec.first] = np.nan
            unadj[: spec.first] = np.nan
            vol_path[: spec.first] = np.nan

        close_adj[spec.ticker] = adj
        close_unadj[spec.ticker] = unadj
        volume[spec.ticker] = vol_path

    return F.Panels(
        close_adj=pd.DataFrame(close_adj, index=idx),
        close_unadj=pd.DataFrame(close_unadj, index=idx),
        volume_unadj=pd.DataFrame(volume, index=idx),
    )


@lru_cache(maxsize=2)
def bill_rate() -> pd.Series:
    """A synthetic bill rate with a distinct value on every session.

    Distinct on purpose: a lag test against a series that repeats
    itself cannot tell a correct shift from no shift at all.
    """
    idx = sessions()
    return pd.Series(np.linspace(5.25, 0.05, len(idx)), index=idx, name="DGS3MO")


def check_dates() -> list[pd.Timestamp]:
    """Truncation points, all well clear of the warmup.

    Four of them, spread across the sample and including one inside the
    volume surge, because a leak that only shows up when the recent
    past is unusual is exactly the leak worth catching.
    """
    idx = sessions()
    return [idx[400], idx[700], idx[len(idx) // 2 + 20], idx[-30]]


# -- the test that matters ----------------------------------------------


def test_features_at_T_survive_truncation() -> None:
    """Every feature at T is unchanged when everything after T is deleted."""
    report = F.causality_report(
        panels(), check_dates(), bill_rate=bill_rate()
    )
    assert report.empty, (
        f"{len(report)} value(s) moved when the future was removed:\n"
        f"{report.head(10).to_string()}"
    )


def test_features_at_T_survive_truncation_without_a_bill_rate() -> None:
    """The same, on the path where no regime series is supplied.

    Worth its own case: `build_features` fills the column with NaN
    there, and a checker that counted an all-NaN column as agreement
    would report a clean run over a panel it had barely inspected.
    """
    assert F.causality_report(panels(), check_dates()).empty


def test_the_truncation_check_catches_a_leak_that_becomes_a_hole() -> None:
    """A centred window reads forward, and the check must say so."""

    def leaky(panels_in: F.Panels, *, bill_rate=None, **kwargs):
        out = F.build_features(panels_in, bill_rate=bill_rate, **kwargs)
        close = panels_in.close_adj
        centred = close / close.rolling(21, min_periods=21, center=True).mean() - 1.0
        out["trend_200"] = out.set_index(["date", "ticker"]).index.map(centred.stack())
        return out

    report = F.causality_report(panels(), check_dates(), build=leaky)
    assert not report.empty
    assert set(report["feature"]) == {"trend_200"}

    with pytest.raises(F.CausalityError, match="reaches past its own date"):
        F.assert_causal(panels(), check_dates(), build=leaky)


def test_the_truncation_check_catches_a_leak_that_stays_a_number() -> None:
    """The dangerous shape: finite, plausible, and different.

    A full-sample standardisation is the single most common way a
    feature pipeline leaks — it looks like preprocessing rather than
    like a lookahead — and it never produces a NaN, an infinity or
    anything else a sanity check would notice. Only an exact comparison
    against the truncated recomputation catches it, which is why
    `causality_report` compares with `==` and not `isclose`.
    """

    def leaky(panels_in: F.Panels, *, bill_rate=None, **kwargs):
        out = F.build_features(panels_in, bill_rate=bill_rate, **kwargs)
        values = out["ret_3m"]
        out["ret_3m"] = (values - values.mean()) / values.std()
        return out

    report = F.causality_report(panels(), check_dates(), build=leaky)
    assert not report.empty
    assert set(report["feature"]) == {"ret_3m"}

    # Every finding is finite on both sides — no NaN did the work here.
    for row in report.to_dict("records"):
        assert np.isfinite(float(row["full"].strip("'")))
        assert np.isfinite(float(row["truncated"].strip("'")))


def test_a_warmup_date_is_refused_rather_than_reported_clean() -> None:
    """NaN equalling NaN is not evidence of causality.

    The easiest way to get a clean causality report is to ask for one
    over the warmup, where every feature is NaN on both sides. That has
    to raise, or the check can be passed by accident.
    """
    early = sessions()[10]
    with pytest.raises(F.FeatureError, match="would pass without testing"):
        F.causality_report(panels(), [early])


def test_an_empty_request_is_refused() -> None:
    with pytest.raises(F.FeatureError, match="no dates to check"):
        F.causality_report(panels(), [])


# -- total return, not price --------------------------------------------


def test_return_features_come_off_the_total_return_series() -> None:
    """The coupon-only fund has features, and on price it would have none.

    FFF's as-traded close never moves. Read there, its trailing returns
    are exactly zero, its volatility is exactly zero and its drawdown is
    exactly zero — a security with no risk and no return, which is what
    a price-based feature layer would tell the model about six of the
    twenty-eight names in the real universe.
    """
    frame = F.build_features(panels())
    coupon = frame.loc[frame["ticker"] == "FFF"].dropna(subset=["vol_3m"])
    assert len(coupon) > 500

    assert coupon["vol_3m"].abs().min() > 0.0
    assert coupon["ret_3m"].abs().max() > 0.0
    assert coupon["mom_12_1"].abs().max() > 0.0

    # And the counterfactual, stated rather than assumed: the printed
    # price really is flat, so the same arithmetic on it gives zero.
    printed = panels().close_unadj["FFF"]
    assert printed.std() == 0.0


def test_liquidity_reads_as_traded_dollars_not_adjusted_ones() -> None:
    """`turnover_surge` moves with the unadjusted panel and not the
    adjusted one.

    The schema's rule is that no column is safe for both purposes.
    Doubling every adjusted close must leave the traded-dollar feature
    alone; doubling the as-traded close over one stretch must move it.
    """
    base = F.build_features(panels())

    adjusted = panels()
    shifted = F.Panels(
        close_adj=adjusted.close_adj * 2.0,
        close_unadj=adjusted.close_unadj,
        volume_unadj=adjusted.volume_unadj,
    )
    unchanged = F.build_features(shifted)
    pd.testing.assert_series_equal(
        base["turnover_surge"], unchanged["turnover_surge"]
    )

    bumped_unadj = adjusted.close_unadj.copy()
    bumped_unadj.iloc[-100:] = bumped_unadj.iloc[-100:] * 3.0
    moved = F.build_features(
        F.Panels(
            close_adj=adjusted.close_adj,
            close_unadj=bumped_unadj,
            volume_unadj=adjusted.volume_unadj,
        )
    )
    assert not moved["turnover_surge"].equals(base["turnover_surge"])


# -- the cross-section --------------------------------------------------


def test_ranks_are_taken_within_a_date_over_the_names_alive_on_it() -> None:
    frame = F.build_features(panels())
    for column in (f"{f}{F.XS_SUFFIX}" for f in F.BASE_FEATURES):
        assert frame[column].max() < 0.5
        assert frame[column].min() > -0.5

    # Centred: on any date where every name has a value, the ranks sum
    # to zero. This is what makes "above the median" mean the same
    # thing in a twenty-two name cross-section and a twenty-eight.
    late = frame.loc[frame["date"] == sessions()[-1]]
    assert len(late) == len(SPECS)
    assert late["vol_3m_xs"].sum() == pytest.approx(0.0, abs=1e-12)

    # EEE lists 500 sessions in, so it holds no rank at all before then
    # — not a zero, which would read as "perfectly average today".
    early = frame.loc[
        (frame["date"] == sessions()[300]) & (frame["ticker"] == "EEE")
    ]
    assert early.empty


def test_ranks_survive_a_monotone_transform_of_the_level() -> None:
    """A rank is about order, so a transform that preserves order must
    leave it untouched. This is the property that makes the ranks
    robust to the raw scales moving by a factor of four across regimes.
    """
    wide = F.base_features(panels())["vol_3m"]
    straight = F.cross_sectional_rank(wide)
    squared = F.cross_sectional_rank(wide**3)
    pd.testing.assert_frame_equal(straight, squared)


def test_a_lone_name_gets_no_rank() -> None:
    """A cross-section of one is not a cross-section."""
    idx = sessions()[:5]
    wide = pd.DataFrame(
        {"AAA": [1.0, 2.0, 3.0, 4.0, 5.0], "BBB": [np.nan] * 5}, index=idx
    )
    ranked = F.cross_sectional_rank(wide)
    assert ranked["AAA"].isna().all()

    with pytest.raises(F.FeatureError, match="not a cross-section"):
        F.cross_sectional_rank(wide, min_names=1)


def test_availability_mask_changes_everyone_elses_rank() -> None:
    """A name that should not be in the cross-section does not merely
    add a wrong row — it moves every other name's percentile.

    This is the argument for `available` existing at all, and it is
    worth an assertion rather than a comment.
    """
    unmasked = F.build_features(panels())

    mask = panels().close_adj.notna()
    mask.loc[:, "DDD"] = False
    masked = F.build_features(panels(), available=mask)

    day = sessions()[-1]
    a = unmasked.loc[
        (unmasked["date"] == day) & (unmasked["ticker"] == "AAA"), "vol_3m_xs"
    ].iloc[0]
    b = masked.loc[
        (masked["date"] == day) & (masked["ticker"] == "AAA"), "vol_3m_xs"
    ].iloc[0]
    assert a != b
    assert "DDD" not in set(masked["ticker"])


# -- the regime column ---------------------------------------------------


def test_the_bill_rate_is_lagged_by_one_session() -> None:
    """A decision at T's close did not have the H.15 print stamped T."""
    idx = sessions()
    rate = bill_rate()
    feature = F.bill_rate_feature(idx, rate)

    assert np.isnan(feature.iloc[0])
    for i in (1, 250, 900, len(idx) - 1):
        assert feature.iloc[i] == rate.iloc[i - 1]

    with pytest.raises(F.FeatureError, match="negative"):
        F.bill_rate_feature(idx, rate, lag_sessions=-1)


def test_the_bill_rate_is_forward_filled_never_interpolated() -> None:
    """A yield published Friday stands over the weekend; Monday's print
    must not be used to describe Friday."""
    idx = sessions()[:10]
    sparse = pd.Series([4.0, 9.0], index=[idx[0], idx[5]])
    feature = F.bill_rate_feature(idx, sparse, lag_sessions=0)
    assert list(feature.iloc[0:5]) == [4.0] * 5
    assert list(feature.iloc[5:10]) == [9.0] * 5


# -- shape and discipline ------------------------------------------------


def test_the_feature_set_stays_small() -> None:
    """Eight levels, eight ranks, one regime column.

    Pinned so that adding a feature is a deliberate act with a test to
    edit, rather than something that happens on an afternoon when the
    AUC is disappointing. Every feature is a dimension to overfit in,
    and the number of them is the parameter nobody counts.
    """
    assert len(F.BASE_FEATURES) == 8
    assert len(F.FEATURE_COLUMNS) == 17
    assert F.FEATURE_COLUMNS[-1] == F.BILL_RATE_COLUMN
    assert len(set(F.FEATURE_COLUMNS)) == 17

    frame = F.build_features(panels(), bill_rate=bill_rate())
    assert list(frame.columns) == ["date", "ticker", *F.FEATURE_COLUMNS]


def test_warmup_rows_are_emitted_rather_than_dropped() -> None:
    """How much of the panel is warmup is a fact the writeup needs."""
    frame = F.build_features(panels())
    first_day = frame.loc[frame["date"] == sessions()[0]]
    assert len(first_day) == sum(1 for s in SPECS if not s.first)
    assert first_day[list(F.BASE_FEATURES)].isna().all().all()

    complete = frame.dropna(subset=list(F.BASE_FEATURES))
    assert len(complete) < len(frame)
    assert len(complete) > 0


def test_a_misaligned_panel_is_refused() -> None:
    """Crossing the names would multiply one fund's price by another's
    volume and produce a perfectly plausible number."""
    good = panels()
    with pytest.raises(F.FeatureError, match="different tickers"):
        F.build_features(
            F.Panels(
                close_adj=good.close_adj,
                close_unadj=good.close_unadj[list(good.close_unadj.columns[::-1])],
                volume_unadj=good.volume_unadj,
            )
        )

    with pytest.raises(F.FeatureError, match="not sorted ascending"):
        F.build_features(
            F.Panels(
                close_adj=good.close_adj.iloc[::-1],
                close_unadj=good.close_unadj.iloc[::-1],
                volume_unadj=good.volume_unadj.iloc[::-1],
            )
        )


def test_panels_from_prices_refuses_a_recycled_symbol() -> None:
    idx = sessions()[:3]
    rows = []
    for ticker in ("AAA", "AAA"):
        for when in idx:
            rows.append(
                {
                    "date": when,
                    "ticker": ticker,
                    "close_adj": 10.0,
                    "close_unadj": 10.0,
                    "volume_unadj": 1e6,
                }
            )
    with pytest.raises(F.FeatureError, match="recycled-symbol"):
        F.panels_from_prices(pd.DataFrame(rows))


# -- the universe --------------------------------------------------------


def test_every_fund_records_where_its_inception_came_from() -> None:
    """An unsourced date is a recalled date."""
    for entry in U.UNIVERSE:
        assert entry.source.startswith("http"), entry.ticker
        assert entry.driver in U.DRIVERS, entry.ticker
        assert entry.inception <= date.today(), entry.ticker


def test_the_universe_is_the_size_it_claims_to_be() -> None:
    assert 25 <= len(U.UNIVERSE) <= 40
    assert len(U.UNIVERSE_TICKERS) == len(U.UNIVERSE)


def test_the_stated_sample_arithmetic_holds() -> None:
    """The counts quoted in the module docstring, pinned to the table.

    Prose drifts away from data silently. These four numbers are the
    ones the writeup will quote, so they are asserted rather than
    trusted.
    """
    assert U.FULL_PANEL_DATE == date(2007, 4, 4)
    assert U.first_date_with(20) == date(2003, 4, 7)
    assert U.first_date_with(25) == date(2004, 11, 18)
    assert U.first_date_with(28) == U.FULL_PANEL_DATE
    assert len(U.available_on(date(2005, 1, 3))) == 25

    drivers = U.by_driver()
    us_equity_beta = (
        len(drivers["us_equity_broad"])
        + len(drivers["us_equity_sector"])
        + len(drivers["real_estate"])
    )
    assert us_equity_beta == 14, "the concentration note quotes fourteen"


def test_available_on_never_returns_a_fund_before_it_listed() -> None:
    for entry in U.UNIVERSE:
        day_before = entry.inception - timedelta(days=1)
        assert entry.ticker not in U.available_on(day_before)
        assert entry.ticker in U.available_on(entry.inception)


def test_first_date_with_refuses_an_impossible_count() -> None:
    with pytest.raises(U.UniverseError, match="no date on which"):
        U.first_date_with(len(U.UNIVERSE) + 1)
    with pytest.raises(U.UniverseError):
        U.first_date_with(0)


def test_verify_against_prices_reports_both_directions_and_silence() -> None:
    """Our asserted dates checked against the bars a vendor really served."""
    rows = []
    for entry in U.UNIVERSE:
        if entry.ticker == "HYG":
            # Missing entirely. Must be reported rather than skipped:
            # "served nothing" and "agreed with us" cannot both be an
            # empty result.
            continue
        if entry.ticker == "SPY":
            first = entry.inception - pd.Timedelta(days=400)
        elif entry.ticker == "SLV":
            first = entry.inception + pd.Timedelta(days=200)
        else:
            first = entry.inception
        rows.append(
            {"date": pd.Timestamp(first), "ticker": entry.ticker, "close_adj": 10.0}
        )

    report = U.verify_against_prices(pd.DataFrame(rows))
    findings = dict(zip(report["ticker"], report["finding"]))
    assert findings["SPY"] == "data_precedes_inception"
    assert findings["SLV"] == "data_starts_late"
    assert findings["HYG"] == "no_rows"
    assert len(report) == 3


def test_verify_against_prices_is_silent_when_everything_agrees() -> None:
    rows = [
        {
            "date": pd.Timestamp(entry.inception),
            "ticker": entry.ticker,
            "close_adj": 10.0,
        }
        for entry in U.UNIVERSE
    ]
    assert U.verify_against_prices(pd.DataFrame(rows)).empty


def test_an_unknown_ticker_is_refused_by_name() -> None:
    with pytest.raises(U.UniverseError, match="not in this universe"):
        U.fund("NVDA")
    assert U.fund("spy").ticker == "SPY"
