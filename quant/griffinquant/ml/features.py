"""The eight things the classifier is allowed to know about an ETF on
a given day, their cross-sectional ranks, and one regime variable.

The file is arranged around four traps, and the ordering is by how
quietly each one produces a good-looking result.

**Everything comes off `close_adj`.** Over 2004-2026 TLT returned -2.6%
on price and +105.8% on total return; LQD -3.2% and +141.4%. Six of the
twenty-eight names in this universe are bond or credit funds whose
entire return is coupon, so a momentum feature computed on the printed
price would rank them by an artefact of their distribution schedule and
a volatility computed there would call them riskless. There is no
argument for a price-based feature here and no parameter selecting a
series: the panel handed in is the adjusted one. The single exception
is the liquidity feature, which multiplies the AS-TRADED close by the
as-traded volume because dollars traded is a quantity that printed —
back-adjusted shares times a back-adjusted price is not a number
anybody exchanged.

**A feature at date T uses data through the close of T and not one bar
more.** Every window below is a trailing `rolling`, every lag is a
positive `shift`, and every cross-sectional statistic is taken within a
single date. None of that is checked by reading it. `causality_report`
computes the features on the full panel, computes them again on the
panel literally truncated after T, and demands that every value at T be
bit-for-bit identical; `tests/test_ml_features.py` runs it against a
deliberately leaky twin as well, because a causality check that has
never been shown to fail is not evidence about anything.

**A level feature whose cross-sectional rank barely moves is a name
dummy wearing a feature's name.** This is why there is no
dollar-volume LEVEL here. SPY trades two orders of magnitude more than
XLB and always has, so its rank on that feature is a constant, and a
tree model handed a constant per name will happily learn "when this is
very high, go long" — which in a universe selected in 2026 means
learning the identity of a fund we already know survived and grew. The
liquidity feature is therefore a SURGE: this month's median dollar
volume against this year's, which is zero for a name in its normal
state whatever its size. The same reasoning is why the bill rate is
flagged below rather than trusted.

**Every feature is a dimension to overfit in.** The count is eight base
features, their eight cross-sectional ranks, and the bill rate:
seventeen columns, and they are nowhere near seventeen independent
dimensions, since each rank is a monotone transform of its own level
within a date. Nothing was added because it might help. If the fitted
model reports roughly uniform importance across all seventeen, that is
not a well-balanced model — it is what uniform importance over noise
looks like, and it is the diagnostic the source project reported about
its own features without following the thought through.

**What the ranks are for, and what they destroy.** A cross-sectional
model can only act on relative position: it cannot buy "high momentum",
it can only buy the high-momentum third of what is available today. The
ranks say that directly and are scale-free, which matters because the
raw scales move enormously across this sample — every name's volatility
rank in October 2008 is roughly its rank in June 2017 while the levels
differ by a factor of four. That factor of four is real information
about the regime, and ranking it away would lose it, which is exactly
why both forms are shipped rather than the ranks alone.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd

from ..engine.metrics import TRADING_DAYS_PER_YEAR
from ..signals.volatility import MIN_ANNUAL_VOLATILITY, total_returns

__all__ = [
    "BASE_FEATURES",
    "BILL_RATE_COLUMN",
    "BILL_RATE_LAG_SESSIONS",
    "CausalityError",
    "DRAWDOWN_WINDOW",
    "FEATURE_COLUMNS",
    "FeatureError",
    "LIQUIDITY_LONG",
    "LIQUIDITY_SHORT",
    "MIN_SESSIONS",
    "MOMENTUM_SKIP",
    "MOMENTUM_WINDOW",
    "Panels",
    "REVERSAL_WINDOW",
    "TREND_WINDOW",
    "VOL_LONG",
    "VOL_SHORT",
    "WARMUP_SESSIONS",
    "XS_SUFFIX",
    "assert_causal",
    "base_features",
    "build_features",
    "causality_report",
    "cross_sectional_rank",
    "panels_from_prices",
    "truncate",
]


class FeatureError(ValueError):
    """The feature layer was handed a panel it cannot honestly read."""


class CausalityError(AssertionError):
    """A feature at T changed when the future was taken away."""


# -- the windows, and the prior behind each one -------------------------
#
# Every number here is round and every one was written down before any
# AUC existed. None was chosen by comparing results, and the moment one
# is, it stops being a prior and owes `metrics.TrialCounter` a row —
# window lengths are the easiest parameters in the world to tune
# quietly, because each one looks like a modelling detail rather than a
# decision.

#: One month. The short-horizon REVERSAL leg, and the only feature here
#: whose prior carries a negative sign: what went up over the last few
#: weeks has tended to give a little of it back. The evidence for this
#: is much stronger in single names than in index funds, where there is
#: no bid-ask bounce to speak of and no earnings surprise to overshoot,
#: so the honest prior is "weakly negative, possibly nothing".
REVERSAL_WINDOW: int = 21

#: One quarter. Intermediate horizon, and deliberately the same 63 the
#: sizing layer already calls a quarter. No separate prior beyond
#: sitting between the reversal and momentum horizons, which is its
#: whole job: if the sign flips somewhere between one month and twelve,
#: this is where it would show.
INTERMEDIATE_WINDOW: int = 63

#: Twelve months, skipping the most recent one. Classic cross-sectional
#: momentum, and the skip is not a detail: 12-month momentum measured
#: to yesterday contains the reversal month inside it, so the two
#: features would overlap and each would be measuring a blend of the
#: other. Formed t-252 to t-21 they are disjoint by construction and
#: their priors can disagree without the arithmetic confusing the
#: issue.
MOMENTUM_WINDOW: int = 252
MOMENTUM_SKIP: int = REVERSAL_WINDOW

#: Realised volatility at one month and one quarter. Prior: the
#: low-volatility anomaly — lower-risk assets have historically
#: delivered better risk-adjusted returns than their betas justify —
#: plus the plain fact that volatility is the most persistent thing in
#: this dataset, so it is the feature most likely to be predictable and
#: least likely to be profitable. Two horizons rather than one because
#: the SHORT relative to the LONG is how a regime change announces
#: itself, and rather than three because a third window would be almost
#: perfectly collinear with the two it sat between.
VOL_SHORT: int = 21
VOL_LONG: int = INTERMEDIATE_WINDOW

#: The 200-session moving average, the oldest trend filter in the
#: business and the one most likely to have been arbitraged. Kept
#: because the interesting result would be its ABSENCE: if a feature
#: this well known still carries signal in a liquid ETF cross-section,
#: something is wrong with the test rather than right with the feature.
TREND_WINDOW: int = 200

#: Drawdown measured against a trailing one-year high rather than an
#: all-time one. An expanding maximum is equally causal, but it makes a
#: name's drawdown depend on how long it has been listed — GLD in 2006
#: would be measured against a fourteen-month peak and SPY against a
#: thirteen-year one — and this panel's whole point is comparing names
#: with staggered inceptions. Prior: distance from a recent high is a
#: different state from trend. An asset can sit above its moving
#: average and well below its high, which is the shape of a failed
#: recovery, and no return or volatility feature says that.
DRAWDOWN_WINDOW: int = 252

#: Dollar volume over one month against one year, both as MEDIANS. A
#: median rather than a mean for the reason `config.UniverseRules`
#: already gives: one index-rebalance print otherwise redefines a
#: fund's normal. Prior: a genuine surge in turnover marks attention or
#: stress, and it is the one liquidity statistic that is not mostly a
#: statement about which fund this is.
LIQUIDITY_SHORT: int = 21
LIQUIDITY_LONG: int = 252

#: Sessions of history banked before the first feature exists, matching
#: the engine's `warmup` convention: at loop index i the view holds i+1
#: closes, so i must reach this for the panel to hold `MIN_SESSIONS`.
WARMUP_SESSIONS: int = MOMENTUM_WINDOW
MIN_SESSIONS: int = MOMENTUM_WINDOW + 1

#: The bill rate is published in the H.15 release after the 4pm close,
#: so the rate stamped with session T was NOT available to somebody
#: deciding at T's close. One session of lag. This is a small point
#: that costs nothing and closes a leak that would be invisible: the
#: level barely moves day to day, so a one-day lookahead here would
#: change no number enough to notice and would still be lookahead.
BILL_RATE_LAG_SESSIONS: int = 1

BILL_RATE_COLUMN: str = "bill_rate"

#: Suffix marking the within-date cross-sectional rank of a feature.
XS_SUFFIX: str = "_xs"

BASE_FEATURES: tuple[str, ...] = (
    "ret_1m",
    "ret_3m",
    "mom_12_1",
    "vol_1m",
    "vol_3m",
    "trend_200",
    "drawdown_252",
    "turnover_surge",
)

FEATURE_COLUMNS: tuple[str, ...] = (
    *BASE_FEATURES,
    *(f"{f}{XS_SUFFIX}" for f in BASE_FEATURES),
    BILL_RATE_COLUMN,
)


# -- the panel ----------------------------------------------------------


@dataclass(frozen=True)
class Panels:
    """The three wide frames every feature below is computed from.

    Three rather than one because the schema's central rule is that no
    column is safe for both purposes: `close_adj` is the only series a
    return may be taken from, and the `*_unadj` pair is the only one a
    quantity of traded dollars may be taken from. Carrying them
    together in a named object is what stops a caller reaching for
    whichever frame is in scope.
    """

    close_adj: pd.DataFrame
    close_unadj: pd.DataFrame
    volume_unadj: pd.DataFrame

    @property
    def sessions(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.close_adj.index)

    @property
    def tickers(self) -> tuple[str, ...]:
        return tuple(str(c) for c in self.close_adj.columns)


def panels_from_prices(prices: pd.DataFrame, *, key: str = "ticker") -> Panels:
    """Pivot a long `schema.PRICES` frame into the three wide panels.

    The duplicate check is the load-bearing line, for the reason
    `signals.volatility.panel_from_prices` sets out at length: ticker
    strings get recycled, and a pivot on a recycled symbol splices a
    dead entity's history onto a living one's, producing a series that
    fell 99% and recovered. That is safe to ignore for THIS universe —
    twenty-eight large living ETFs, none of whose symbols has belonged
    to anything else — and it is not safe in general, so the check
    runs rather than the assumption being documented.
    """
    need = ["date", key, "close_adj", "close_unadj", "volume_unadj"]
    missing = [c for c in need if c not in prices.columns]
    if missing:
        raise FeatureError(
            f"price frame is missing {missing}; got {sorted(prices.columns)}"
        )

    dupes = int(prices.duplicated(subset=["date", key]).sum())
    if dupes:
        raise FeatureError(
            f"{dupes:,} duplicate ({key}, date) row(s). If the key is a "
            f"ticker this is the recycled-symbol trap and the pivot would "
            f"graft one fund's history onto another's. Pivot on permaticker."
        )

    wide = {
        column: prices.pivot(index="date", columns=key, values=column).sort_index()
        for column in ("close_adj", "close_unadj", "volume_unadj")
    }
    return _validated(
        Panels(
            close_adj=wide["close_adj"],
            close_unadj=wide["close_unadj"],
            volume_unadj=wide["volume_unadj"],
        )
    )


def truncate(panels: Panels, at: date | datetime | str) -> Panels:
    """The same panels with every session after `at` deleted.

    Literal truncation, which is the only truncation worth testing
    with. Masking the future to NaN instead would leave the rows in
    place, and a rolling window that had quietly reached forward would
    still find them.
    """
    stamp = pd.Timestamp(at)
    keep = panels.close_adj.index <= stamp
    if not keep.any():
        raise FeatureError(
            f"truncating at {stamp.date()} leaves no sessions at all; the "
            f"panel starts {panels.close_adj.index.min().date()}"
        )
    return Panels(
        close_adj=panels.close_adj.loc[keep],
        close_unadj=panels.close_unadj.loc[keep],
        volume_unadj=panels.volume_unadj.loc[keep],
    )


# -- the eight features -------------------------------------------------


def base_features(panels: Panels) -> dict[str, pd.DataFrame]:
    """The eight raw features, each as a wide date-by-ticker frame.

    Returned as a dict rather than a single frame so a caller can look
    at one of them without unstacking seventeen columns, and so the
    rank step below has something to iterate that cannot silently miss
    a feature someone added.

    Every window is trailing and every one demands to be FULL: a
    rolling statistic over a window holding a missing bar returns NaN
    rather than a number computed off whatever happened to be there. So
    a fund gets no momentum for its first year and a hole in a vendor's
    data produces a hole here, which is the answer rather than a
    stand-in. Filling either would hand the model a feature whose value
    encodes how much data was missing.
    """
    panels = _validated(panels)
    close = panels.close_adj
    returns = total_returns(close)

    # Returns. Three horizons whose priors disagree, formed so that
    # they do not overlap — see MOMENTUM_SKIP.
    ret_1m = close / close.shift(REVERSAL_WINDOW) - 1.0
    ret_3m = close / close.shift(INTERMEDIATE_WINDOW) - 1.0
    mom = close.shift(MOMENTUM_SKIP) / close.shift(MOMENTUM_WINDOW) - 1.0

    # Volatility. `ddof=1` and sqrt(252), matching
    # `metrics.annualised_volatility` and the sizing layer exactly. The
    # annualisation cancels out of the trend feature below and is
    # invisible to a rank, so it buys nothing but legibility — and a
    # number that gets misread is worse than a slow one.
    vol_1m = returns.rolling(VOL_SHORT, min_periods=VOL_SHORT).std(ddof=1) * np.sqrt(
        TRADING_DAYS_PER_YEAR
    )
    vol_3m = returns.rolling(VOL_LONG, min_periods=VOL_LONG).std(ddof=1) * np.sqrt(
        TRADING_DAYS_PER_YEAR
    )

    # Distance from the moving average, in volatility units. Raw
    # distance is not comparable across this cross-section: five per
    # cent above the 200-day is an enormous move for SHY and a quiet
    # week for EWZ, so a rank of the raw distance would mostly rank the
    # names by how volatile they are. Dividing by the quarterly
    # volatility says how many typical moves the displacement is worth.
    #
    # The horizon factor that would make this dimensionally a proper
    # z-score — sigma scaled from annual to the ~200-session window —
    # is omitted deliberately. It is the same constant for every name
    # on every date, so it changes no rank and no standardised value,
    # and carrying it would imply a distributional claim about the
    # displacement that nothing here supports.
    ma = close.rolling(TREND_WINDOW, min_periods=TREND_WINDOW).mean()
    trend = (close / ma - 1.0) / vol_3m.clip(lower=MIN_ANNUAL_VOLATILITY)

    # Drawdown against a trailing one-year high. Bounded in [-1, 0],
    # zero on the day a name makes a new high.
    peak = close.rolling(DRAWDOWN_WINDOW, min_periods=DRAWDOWN_WINDOW).max()
    drawdown = close / peak - 1.0

    # Liquidity. As-traded price times as-traded volume, because this
    # is the one feature measuring a quantity of dollars that actually
    # changed hands. A log ratio so that a doubling and a halving are
    # the same distance from normal in opposite directions.
    dollar_volume = panels.close_unadj * panels.volume_unadj
    dv_short = dollar_volume.rolling(
        LIQUIDITY_SHORT, min_periods=LIQUIDITY_SHORT
    ).median()
    dv_long = dollar_volume.rolling(LIQUIDITY_LONG, min_periods=LIQUIDITY_LONG).median()
    # A non-positive median is a fund that did not trade for most of a
    # month, which has no surge to report. NaN rather than a large
    # negative number invented by the logarithm.
    ratio = (dv_short / dv_long).where((dv_short > 0.0) & (dv_long > 0.0))
    surge = np.log(ratio)

    return {
        "ret_1m": ret_1m,
        "ret_3m": ret_3m,
        "mom_12_1": mom,
        "vol_1m": vol_1m,
        "vol_3m": vol_3m,
        "trend_200": trend,
        "drawdown_252": drawdown,
        "turnover_surge": surge,
    }


def cross_sectional_rank(wide: pd.DataFrame, *, min_names: int = 2) -> pd.DataFrame:
    """Within-date percentile rank, centred on zero.

    `(rank - 0.5) / n - 0.5`, so a value runs from just above -0.5 for
    the lowest name to just below +0.5 for the highest and the median
    name sits at zero. Symmetric on purpose: the obvious spelling,
    pandas' `pct=True`, runs from `1/n` to `1`, which after centring
    leaves the bottom name further from zero than the top one and hands
    a linear model a small per-date intercept that is really a headcount.

    `n` is the number of names with a value on that date, so the scale
    does not lurch as the panel grows from twenty-two to twenty-eight —
    which it does across 2005-2008, and which is the entire reason a
    percentile is used rather than an ordinal.

    Below `min_names` the answer is NaN rather than a number. A rank
    over one name evaluates to exactly zero, which reads as "this fund
    was perfectly average today" — a fabricated measurement, and the
    worst possible thing to feed a model that has no way to tell it
    apart from a real one.
    """
    if min_names < 2:
        raise FeatureError(
            f"min_names {min_names} is not a cross-section. A rank over a "
            f"single name is zero by construction and means nothing."
        )
    ranks = wide.rank(axis=1, method="average")
    counts = wide.notna().sum(axis=1)
    out = ranks.sub(0.5).div(counts, axis=0).sub(0.5)
    return out.where(counts.ge(min_names), other=np.nan)


def bill_rate_feature(
    sessions: pd.DatetimeIndex,
    rate_pct: pd.Series,
    *,
    lag_sessions: int = BILL_RATE_LAG_SESSIONS,
) -> pd.Series:
    """The bill rate as of the previous session, aligned to `sessions`.

    Forward-filled, never interpolated: a yield published on Friday is
    the yield that stands over the weekend, whereas interpolating
    toward Monday's print uses Monday's number to describe Saturday and
    is a small, tidy piece of lookahead. Then shifted by
    `lag_sessions`, because the H.15 release lands after the 4pm close
    and a decision made at that close did not have it.

    **Read the docstring warning before using this as a feature.** The
    three-month bill rate over 2005-2026 goes 5% to 0% to 5%, which
    partitions the sample into three long blocks that a tree can split
    on exactly as if they were dates. It is a genuine regime variable
    and it is also very nearly a clock, and on a single historical path
    those two are not separable. If the fitted model puts its weight
    here, the finding is about the calendar rather than about rates,
    and the right response is to swap the level for its trailing change
    — which is deliberately NOT shipped, because shipping both would
    invite using both.
    """
    if lag_sessions < 0:
        raise FeatureError(
            f"lag_sessions {lag_sessions} is negative, which would read the "
            f"rate forward from the future"
        )
    if not isinstance(rate_pct, pd.Series):
        raise FeatureError(f"expected a Series of rates, got {type(rate_pct)!r}")

    index = pd.DatetimeIndex(sessions).normalize()
    rate = rate_pct.copy()
    rate.index = pd.DatetimeIndex(rate.index).normalize()
    rate = rate.sort_index()
    rate = rate[~rate.index.duplicated(keep="last")]

    aligned = rate.reindex(index.union(rate.index)).ffill().reindex(index)
    out = aligned.shift(lag_sessions)
    out.index = index
    out.name = BILL_RATE_COLUMN
    return out.astype("float64")


# -- the frame a model consumes -----------------------------------------


def build_features(
    panels: Panels,
    *,
    bill_rate: pd.Series | None = None,
    available: pd.DataFrame | None = None,
    min_names: int = 2,
) -> pd.DataFrame:
    """One tidy row per (date, ticker) that traded, seventeen columns wide.

    Long rather than wide because that is the shape `PurgedKFold` and
    the walk-forward splitter index into, and because a wide panel of
    seventeen features across twenty-eight names is a 476-column frame
    nobody can read.

    **Warmup rows are emitted, not dropped.** A name's features are NaN
    until it has banked `MIN_SESSIONS` sessions, and those rows come
    back anyway. Dropping them here would hide how much of the panel is
    warmup, which for a universe whose members list between 1993 and
    2007 is a fact the writeup needs. The consumer drops them, and
    knows how many it dropped.

    `available` is the optional boolean panel saying which names had
    listed on each date — pass `universe.available_on` rendered as a
    mask when the price source is not trusted to be silent before an
    inception. Given one, values are blanked BEFORE the ranks are
    taken, which is the point: a pre-inception bar that reaches the
    rank step does not merely add a wrong row, it shifts every other
    name's percentile on that date.
    """
    panels = _validated(panels)
    base = base_features(panels)

    if available is not None:
        mask = available.reindex(
            index=panels.close_adj.index, columns=panels.close_adj.columns
        ).fillna(False).astype(bool)
        base = {name: wide.where(mask) for name, wide in base.items()}
    else:
        mask = None

    ranked = {
        f"{name}{XS_SUFFIX}": cross_sectional_rank(wide, min_names=min_names)
        for name, wide in base.items()
    }

    traded = panels.close_adj.notna()
    if mask is not None:
        traded &= mask

    stacked = traded.stack()
    index = stacked[stacked].index
    if not len(index):
        raise FeatureError(
            "no (date, ticker) pair in this panel has a price. An empty "
            "feature frame is indistinguishable from a panel of names that "
            "never traded, so it is a raise rather than a return."
        )

    columns: dict[str, pd.Series] = {}
    for name in BASE_FEATURES:
        columns[name] = base[name].stack().reindex(index)
    for name in BASE_FEATURES:
        key = f"{name}{XS_SUFFIX}"
        columns[key] = ranked[key].stack().reindex(index)

    out = pd.DataFrame(columns, index=index).reset_index()
    out.columns = ["date", "ticker", *out.columns[2:]]
    out["ticker"] = out["ticker"].astype("str")

    if bill_rate is None:
        out[BILL_RATE_COLUMN] = np.nan
    else:
        rate = bill_rate_feature(panels.sessions, bill_rate)
        out[BILL_RATE_COLUMN] = out["date"].map(rate)

    out = out.loc[:, ["date", "ticker", *FEATURE_COLUMNS]]
    for column in FEATURE_COLUMNS:
        out[column] = out[column].astype("float64")
    return out.sort_values(["date", "ticker"]).reset_index(drop=True)


# -- the check that makes any of this believable ------------------------


def causality_report(
    panels: Panels,
    ats: Iterable[date | datetime | str],
    *,
    build: Callable[..., pd.DataFrame] = build_features,
    bill_rate: pd.Series | None = None,
    **kwargs: Any,
) -> pd.DataFrame:
    """Where a feature at T changed once the future was taken away.

    For each date in `ats`: build the features on the whole panel, then
    build them again on the panel truncated after that date, and
    compare every value at that date bit-for-bit. Returns one row per
    disagreement — `date`, `ticker`, `feature`, `full`, `truncated` —
    and an empty frame when nothing moved.

    Exact float equality, not `isclose`. A trailing window over an
    identical prefix should produce an identical accumulation, so any
    difference at all is a difference in what was read, and a tolerance
    would be a place for a one-bar leak to hide. NaN matches NaN, which
    is the only concession.

    **A comparison of nothing to nothing is refused.** If the requested
    date has no rows, or every feature on it is NaN because the warmup
    has not finished, this raises instead of reporting a clean result.
    That is the whole failure mode of a check like this: it is trivial
    to run it over the first month of the sample, watch NaN equal NaN
    seventeen times, and conclude the features are causal.

    `build` is injectable so a test can point the same machinery at a
    deliberately leaky twin and confirm the check fails. A causality
    check that has never been shown to fail is not evidence.
    """
    panels = _validated(panels)
    wanted = [pd.Timestamp(a).normalize() for a in ats]
    if not wanted:
        raise FeatureError(
            "no dates to check. An empty report from an empty request "
            "looks exactly like an empty report from a clean run."
        )

    full = build(panels, bill_rate=bill_rate, **kwargs)
    rows: list[dict[str, Any]] = []

    for at in wanted:
        reference = full.loc[full["date"] == at]
        if reference.empty:
            raise FeatureError(
                f"{at.date()} is not a session in this panel, so there is "
                f"nothing at it to compare. Pick a date the panel holds."
            )
        # The bill-rate column is all-NaN whenever no rate was passed,
        # so it is excluded from the "did we test anything" question
        # rather than allowed to make an untested date look tested.
        tested = FEATURE_COLUMNS if bill_rate is not None else BASE_FEATURES
        probe = reference[list(tested)].to_numpy(dtype="float64")
        if not np.isfinite(probe).any():
            raise FeatureError(
                f"every feature at {at.date()} is NaN, so a comparison "
                f"there would pass without testing anything. This is the "
                f"warmup: pick a date at least {MIN_SESSIONS} sessions "
                f"into the panel."
            )

        cut = build(
            truncate(panels, at),
            bill_rate=None if bill_rate is None else bill_rate.loc[
                pd.DatetimeIndex(bill_rate.index).normalize() <= at
            ],
            **kwargs,
        )
        candidate = cut.loc[cut["date"] == at]

        left = reference.set_index("ticker")[list(FEATURE_COLUMNS)]
        right = candidate.set_index("ticker")[list(FEATURE_COLUMNS)]

        # A name present in one and not the other is a roster change,
        # which is a leak of a different shape: the cross-section the
        # ranks were taken over was not the same one.
        for ticker in left.index.difference(right.index):
            rows.append(_finding(at, str(ticker), "*", "present", "absent"))
        for ticker in right.index.difference(left.index):
            rows.append(_finding(at, str(ticker), "*", "absent", "present"))

        shared = left.index.intersection(right.index)
        if not len(shared):
            continue
        va = left.loc[shared].to_numpy(dtype="float64")
        vb = right.loc[shared].to_numpy(dtype="float64")
        differs = ~((va == vb) | (np.isnan(va) & np.isnan(vb)))
        for i, j in zip(*np.nonzero(differs)):
            rows.append(
                _finding(
                    at,
                    str(shared[i]),
                    FEATURE_COLUMNS[j],
                    float(va[i, j]),
                    float(vb[i, j]),
                )
            )

    return _report(rows)


def assert_causal(
    panels: Panels,
    ats: Iterable[date | datetime | str],
    *,
    build: Callable[..., pd.DataFrame] = build_features,
    bill_rate: pd.Series | None = None,
    **kwargs: Any,
) -> None:
    """`causality_report`, raising on any finding.

    The message names the first few offenders rather than the count.
    "Fourteen features leaked" sends somebody to read every window in
    the file; "mom_12_1 on XLE moved from 0.0731 to 0.0744" sends them
    to one line.
    """
    report = causality_report(
        panels, ats, build=build, bill_rate=bill_rate, **kwargs
    )
    if report.empty:
        return
    shown = report.head(5).to_dict("records")
    detail = "; ".join(
        f"{r['feature']} on {r['ticker']} at "
        f"{pd.Timestamp(r['date']).date()}: {r['full']!r} with the whole "
        f"panel, {r['truncated']!r} truncated"
        for r in shown
    )
    raise CausalityError(
        f"{len(report)} feature value(s) changed when the future was "
        f"removed, so at least one window reaches past its own date. "
        f"{detail}"
        + ("" if len(report) <= 5 else f" (and {len(report) - 5} more)")
    )


# -- small helpers ------------------------------------------------------


_REPORT_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "ticker": "str",
    "feature": "str",
    "full": "str",
    "truncated": "str",
}


def _finding(
    at: pd.Timestamp, ticker: str, feature: str, full: object, truncated: object
) -> dict[str, Any]:
    return {
        "date": at,
        "ticker": ticker,
        "feature": feature,
        # Stringified because the roster findings carry words where the
        # value findings carry floats, and a column that is sometimes a
        # number and sometimes a label is a column nobody can filter.
        "full": repr(full),
        "truncated": repr(truncated),
    }


def _report(rows: Sequence[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(
            {c: pd.Series([], dtype=t) for c, t in _REPORT_COLUMNS.items()}
        )
    out = pd.DataFrame(list(rows))[list(_REPORT_COLUMNS)]
    return out.astype(_REPORT_COLUMNS).sort_values(
        ["date", "ticker", "feature"]
    ).reset_index(drop=True)


def _validated(panels: Panels) -> Panels:
    """The three panels as float64, aligned, or a loud refusal.

    Each check below is a specific way a feature goes quietly wrong.
    An unsorted index reverses half the returns and leaves the
    volatility almost unchanged, so nothing downstream notices. A
    duplicated session puts one day into a trailing window twice.
    Frames whose columns disagree make the liquidity feature multiply
    one fund's price by another's volume, which produces a perfectly
    plausible number.
    """
    if not isinstance(panels, Panels):
        raise FeatureError(f"expected Panels, got {type(panels)!r}")

    frames = {
        "close_adj": panels.close_adj,
        "close_unadj": panels.close_unadj,
        "volume_unadj": panels.volume_unadj,
    }
    for name, frame in frames.items():
        if not isinstance(frame, pd.DataFrame):
            raise FeatureError(f"{name}: expected a DataFrame, got {type(frame)!r}")
        if not len(frame.columns):
            raise FeatureError(f"{name}: no tickers in the panel")
        if not isinstance(frame.index, pd.DatetimeIndex):
            raise FeatureError(
                f"{name}: must be indexed by date; a positional index makes "
                f"every window below count rows rather than sessions"
            )
        if not frame.index.is_monotonic_increasing:
            raise FeatureError(
                f"{name}: index is not sorted ascending. A reversed stretch "
                f"flips the sign of its returns and barely moves its "
                f"volatility, so nothing downstream would notice."
            )
        if frame.index.has_duplicates:
            n = int(frame.index.duplicated().sum())
            raise FeatureError(f"{name}: {n:,} duplicate session(s)")

    reference = panels.close_adj
    for name, frame in frames.items():
        if not frame.index.equals(reference.index):
            raise FeatureError(
                f"{name} and close_adj are on different sessions. Aligning "
                f"them here would silently reindex one of them, and the "
                f"liquidity feature would then pair a price with a volume "
                f"from another day."
            )
        if list(frame.columns) != list(reference.columns):
            raise FeatureError(
                f"{name} and close_adj hold different tickers, or hold them "
                f"in a different order. The liquidity feature multiplies "
                f"these two frames elementwise and would cross the names."
            )

    out = Panels(
        close_adj=reference.astype("float64"),
        close_unadj=panels.close_unadj.astype("float64"),
        volume_unadj=panels.volume_unadj.astype("float64"),
    )
    out.close_adj.index.name = "date"
    out.close_adj.columns.name = "ticker"
    out.close_unadj.index.name = "date"
    out.close_unadj.columns.name = "ticker"
    out.volume_unadj.index.name = "date"
    out.volume_unadj.columns.name = "ticker"

    values = out.close_adj.to_numpy(dtype="float64")
    if np.isinf(values).any():
        raise FeatureError("close_adj contains an infinite price")
    finite = np.isfinite(values)
    if (values[finite] <= 0.0).any():
        raise FeatureError(
            "close_adj contains a non-positive price. A zero close is a "
            "dead instrument or a data hole; either way the return into "
            "and out of it is not a number, and it must be a gap rather "
            "than a bar."
        )
    return out
