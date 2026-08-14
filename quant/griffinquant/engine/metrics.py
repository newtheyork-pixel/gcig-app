"""What the process produced, measured so it can be argued with.

Everything here takes a daily equity curve and a trade log and returns
frames and floats. Nothing plots, nothing tunes, nothing is allowed to
look at a number and go back and change a parameter.

The headline is the DEFLATED Sharpe ratio, not the Sharpe ratio, and
the distance between those two is the whole reason this file is long.
A raw Sharpe answers "how good did this look?". The deflated one
answers "how good did this look given how many times I looked?", which
is the only version of the question a reader has any reason to care
about. Run enough variants over one 20-year sample and a 1.0 annualised
Sharpe arrives on schedule with no skill involved whatsoever.

Four traps are handled here explicitly, because each one produces a
number that looks fine:

  * **Frequency.** Bailey and Lopez de Prado's formula wants the
    PER-PERIOD Sharpe and the per-period skew and kurtosis alongside
    the observation count. Feeding it an annualised Sharpe with a daily
    T overstates the result by roughly sqrt(252), which turns every
    strategy ever written into a discovery. Everything inside the DSR
    machinery is per-period; annualised figures are computed for
    display at the very end and never fed back in.

  * **A resettable trial count.** `TrialCounter` appends and only
    appends. A deflated Sharpe computed from a counter somebody can
    quietly zero is not a statistic, it is a decoration.

  * **A recovery time of zero.** A drawdown the sample never climbed
    out of has no recovery time. Reporting it as 0, or as the distance
    to the last bar, is how "we got it back in four months" ends up
    describing a hole we are still standing in.

  * **A risk-free rate of zero.** Over 2005-2026 cash paid something
    close to 1.5% a year on average, and a good part of that in the
    stretches when this book would have been holding it. Zero is not a
    neutral default, it is a subsidy of about 0.15 of a Sharpe point on
    a 10%-vol strategy. It stays the default only because the caller
    has to be the one to supply a rate series, and every result carries
    the convention it was computed under in `rf_convention`.

Returns are computed from the equity curve, which is built upstream
from `close_adj`. Nothing in this file should ever see a price.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

TRADING_DAYS_PER_YEAR = 252

#: Calendar years, not sessions. A backtest that stops in August must
#: not be handed a full year of compounding for the four months it
#: never traded, and act/365.25 is the convention that refuses to.
DAYS_PER_YEAR = 365.25

#: Euler-Mascheroni. Appears in the expected-maximum-of-N-normals
#: approximation the DSR leans on, not because anything here is a
#: harmonic series but because that is where extreme value theory for
#: the Gumbel-domain maximum puts it.
EULER_MASCHERONI = 0.5772156649015329

#: A deflated Sharpe below this is reported as insignificant, in those
#: words. One-sided, because we only ever claim a strategy is better
#: than nothing, never worse.
SIGNIFICANCE_THRESHOLD = 0.95

#: Deliberately NOT in .gitignore. See `TrialCounter`.
TRIALS_PATH = Path(__file__).resolve().parents[2] / "trials.jsonl"


class MetricsError(ValueError):
    """An input to a measurement is malformed or self-contradictory."""


class TrialLogCorrupt(RuntimeError):
    """The trial ledger has a line that will not parse.

    Raised rather than skipped. A corrupt line that is silently
    dropped lowers the trial count, and a lower trial count makes
    every deflated Sharpe computed afterwards look better.
    """


# -- named periods ------------------------------------------------------
#
# Defined once so that every report slices the same days. A breakout
# where "2020Q1" means the quarter in one table and the crash window in
# another is a breakout nobody can compare across runs.


@dataclass(frozen=True)
class NamedPeriod:
    """A window every report must cut identically.

    `end=None` means open — run to the last observation in the sample.
    """

    name: str
    start: str
    end: str | None
    note: str


REPORT_PERIODS: tuple[NamedPeriod, ...] = (
    NamedPeriod(
        "2008",
        "2008-01-01",
        "2008-12-31",
        "credit crisis; the calendar year, not the peak-to-trough window",
    ),
    NamedPeriod(
        "2018Q4",
        "2018-10-01",
        "2018-12-31",
        "the vol-target unwind and the December selloff; ~64 sessions",
    ),
    NamedPeriod(
        "2020Q1",
        "2020-01-01",
        "2020-03-31",
        "covid; the fastest 30% index drawdown on record",
    ),
    NamedPeriod(
        "2022",
        "2022-01-01",
        "2022-12-31",
        "stocks and bonds fell together; the year the defensive sleeve "
        "either earned its place or did not",
    ),
    NamedPeriod(
        "2023-present",
        "2023-01-01",
        None,
        "the recent regime; not a stress test, and not out-of-sample "
        "unless the holdout says so",
    ),
)


# -- normal distribution, without scipy ---------------------------------
#
# The project has no scipy and does not want one for two functions. The
# CDF is exact to machine precision via erfc; the inverse is Acklam's
# rational approximation refined by a single Halley step, which lands
# at full double precision across the range the DSR ever asks for.


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-float(x) / math.sqrt(2.0))


_ACKLAM_A = (
    -3.969683028665376e01,
    2.209460984245205e02,
    -2.759285104469687e02,
    1.383577518672690e02,
    -3.066479806614716e01,
    2.506628277459239e00,
)
_ACKLAM_B = (
    -5.447609879822406e01,
    1.615858368580409e02,
    -1.556989798598866e02,
    6.680131188771972e01,
    -1.328068155288572e01,
)
_ACKLAM_C = (
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e00,
    -2.549732539343734e00,
    4.374664141464968e00,
    2.938163982698783e00,
)
_ACKLAM_D = (
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e00,
    3.754408661907416e00,
)


def norm_ppf(p: float) -> float:
    """Inverse standard normal CDF.

    Always solved in the LOWER tail and mirrored, never solved
    directly for p above a half. The refinement step below compares
    the CDF at a trial x against p, and up in the right tail both
    numbers are within a rounding error of 1.0 — the subtraction
    cancels, the correction is noise, and the whole exercise silently
    loses six digits precisely where the DSR does its reading (p is
    1 - 1/N, and N is in the hundreds).
    """
    p = float(p)
    if not 0.0 < p < 1.0:
        raise MetricsError(f"norm_ppf needs 0 < p < 1, got {p!r}")
    if p > 0.5:
        return -_ppf_lower(1.0 - p)
    return _ppf_lower(p)


def _ppf_lower(p: float) -> float:
    """Acklam's rational approximation, refined, for p <= 0.5."""
    if p < 0.02425:
        q = math.sqrt(-2.0 * math.log(p))
        x = (
            ((((_ACKLAM_C[0] * q + _ACKLAM_C[1]) * q + _ACKLAM_C[2]) * q
              + _ACKLAM_C[3]) * q + _ACKLAM_C[4]) * q + _ACKLAM_C[5]
        ) / (
            (((_ACKLAM_D[0] * q + _ACKLAM_D[1]) * q + _ACKLAM_D[2]) * q
             + _ACKLAM_D[3]) * q + 1.0
        )
    else:
        q = p - 0.5
        r = q * q
        x = (
            ((((_ACKLAM_A[0] * r + _ACKLAM_A[1]) * r + _ACKLAM_A[2]) * r
              + _ACKLAM_A[3]) * r + _ACKLAM_A[4]) * r + _ACKLAM_A[5]
        ) * q / (
            ((((_ACKLAM_B[0] * r + _ACKLAM_B[1]) * r + _ACKLAM_B[2]) * r
              + _ACKLAM_B[3]) * r + _ACKLAM_B[4]) * r + 1.0
        )

    # One Halley step against the exact CDF. Acklam alone is good to
    # about 1.15e-9 relative; this takes it to the last bit.
    err = norm_cdf(x) - p
    u = err * math.sqrt(2.0 * math.pi) * math.exp(x * x / 2.0)
    return x - u / (1.0 + x * u / 2.0)


# -- input normalisation ------------------------------------------------


_EQUITY_ALIASES = ("nav", "equity", "total_value", "value", "portfolio_value")
_DATE_ALIASES = ("date", "dt", "timestamp", "asof")


def as_equity(obj: pd.Series | pd.DataFrame) -> pd.Series:
    """A float NAV series on a sorted DatetimeIndex.

    Accepts either a Series already shaped that way or a frame with a
    date column and one of the usual NAV column names. A non-positive
    NAV is refused rather than clipped: this is a long-only cash
    account with no leverage, so a zero or negative equity value is a
    bug in the engine above, and a log-return of -inf downstream would
    hide where it came from.
    """
    if isinstance(obj, pd.DataFrame):
        frame = obj
        date_col = next((c for c in _DATE_ALIASES if c in frame.columns), None)
        nav_col = next((c for c in _EQUITY_ALIASES if c in frame.columns), None)
        if nav_col is None:
            raise MetricsError(
                "equity frame has no NAV column; looked for "
                f"{list(_EQUITY_ALIASES)}, got {sorted(frame.columns)}"
            )
        if date_col is not None:
            s = pd.Series(
                frame[nav_col].to_numpy(dtype="float64"),
                index=pd.DatetimeIndex(pd.to_datetime(frame[date_col])),
            )
        else:
            s = frame[nav_col].astype("float64")
    elif isinstance(obj, pd.Series):
        s = obj.astype("float64")
    else:
        raise MetricsError(f"expected a Series or DataFrame, got {type(obj)!r}")

    if not isinstance(s.index, pd.DatetimeIndex):
        raise MetricsError("equity curve must be indexed by date")

    s = s.dropna().sort_index()
    s.index = pd.DatetimeIndex(s.index).normalize()
    if s.index.has_duplicates:
        dupes = int(s.index.duplicated().sum())
        raise MetricsError(f"equity curve has {dupes:,} duplicate date(s)")
    if len(s) and float(s.min()) <= 0.0:
        raise MetricsError("equity curve contains a non-positive NAV")
    s.name = "nav"
    return s


def to_returns(equity: pd.Series | pd.DataFrame) -> pd.Series:
    """Simple daily returns from a NAV curve.

    Simple and not log, because these get summed across positions and
    compounded across months everywhere downstream, and log returns
    only behave under one of those two.
    """
    s = as_equity(equity)
    r = s.pct_change().dropna()
    r.name = "return"
    return r


def _rf_per_period(
    rf: float | pd.Series,
    index: pd.DatetimeIndex,
    periods_per_year: int,
) -> pd.Series:
    """Turn an ANNUALISED risk-free rate into a per-period one.

    Both the float and the Series forms are annualised and expressed
    as DECIMALS — 0.0525 for 5.25%. Conversion is geometric, because
    the returns it will be subtracted from compound.

    Two things raise rather than compute. A rate series that does not
    reach back to the start of the sample: forward-filling from the
    first quote we happen to have is how a 2005 backtest ends up
    measured against 2008's cash rate. And a rate above 100%, which
    is never a rate — `data.tbill.fetch_rate` hands back percent, as
    FRED publishes it, and a 5.25 that should have been 0.0525 makes
    the risk-free asset compound 73 basis points a day.
    """
    if isinstance(rf, pd.Series):
        annual = rf.astype("float64").sort_index()
        annual.index = pd.DatetimeIndex(annual.index).normalize()
        annual = annual.reindex(index.union(annual.index)).ffill().reindex(index)
        if annual.isna().any():
            first_bad = annual.index[annual.isna()][0]
            raise MetricsError(
                "risk-free series does not cover the sample; no rate on or "
                f"before {first_bad.date()}"
            )
    else:
        annual = pd.Series(float(rf), index=index, dtype="float64")

    if len(annual) and float(annual.abs().max()) > 1.0:
        raise MetricsError(
            f"risk-free rate reaches {float(annual.abs().max()):.4g}, which "
            "as a decimal is over 100% a year. This is percent — divide by "
            "100 (data.tbill.fetch_rate returns percent by design)"
        )

    return (1.0 + annual) ** (1.0 / periods_per_year) - 1.0


def rf_convention(rf: float | pd.Series) -> str:
    """The sentence that has to travel with every Sharpe here."""
    if isinstance(rf, pd.Series):
        lo, hi = float(rf.min()), float(rf.max())
        return (
            f"excess of a supplied annualised risk-free series "
            f"({lo:.2%}-{hi:.2%}), converted geometrically to daily"
        )
    if rf == 0.0:
        return (
            "excess of ZERO — no risk-free rate supplied. Cash paid "
            "roughly 1.5% a year on average across 2005-2026, so this "
            "Sharpe is overstated by about that much divided by the "
            "strategy's volatility"
        )
    return f"excess of a constant {rf:.2%} annualised, converted geometrically to daily"


# -- the ordinary numbers -----------------------------------------------


def cagr(equity: pd.Series | pd.DataFrame) -> float:
    """Geometric annual growth over the CALENDAR span of the sample."""
    s = as_equity(equity)
    if len(s) < 2:
        return float("nan")
    years = (s.index[-1] - s.index[0]).days / DAYS_PER_YEAR
    if years <= 0:
        return float("nan")
    return float((s.iloc[-1] / s.iloc[0]) ** (1.0 / years) - 1.0)


def annualised_volatility(
    returns: pd.Series,
    *,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> float:
    """Sample standard deviation, scaled by sqrt(time).

    The sqrt scaling assumes the daily returns are independent. They
    are not — this book will have autocorrelated drawdowns — so the
    annualised figure understates the real dispersion of an annual
    outcome. It stays because every comparison anyone will make is to
    another number computed this way.
    """
    if len(returns) < 2:
        return float("nan")
    return float(returns.std(ddof=1) * math.sqrt(periods_per_year))


def sharpe_ratio(
    returns: pd.Series,
    *,
    rf: float | pd.Series = 0.0,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
    annualise: bool = True,
) -> float:
    """Mean excess return over its standard deviation.

    Arithmetic mean in the numerator, not geometric: this is the
    Sharpe everyone else reports and the one the deflation formula
    below is derived against. See `rf_convention` for what the excess
    is being taken over — it is never nothing, even when it is zero.
    """
    if len(returns) < 2:
        return float("nan")
    excess = returns - _rf_per_period(rf, returns.index, periods_per_year)
    sd = float(excess.std(ddof=1))
    if not sd > 0:
        return float("nan")
    sr = float(excess.mean()) / sd
    return sr * math.sqrt(periods_per_year) if annualise else sr


def rolling_sharpe(
    returns: pd.Series,
    *,
    window: int = TRADING_DAYS_PER_YEAR,
    rf: float | pd.Series = 0.0,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> pd.Series:
    """Trailing 12-month annualised Sharpe, one point per session.

    This is the stability picture, and it is the honest companion to
    the single headline number: one Sharpe over twenty years can hide
    a strategy that worked until 2015 and has been flat since.

    `min_periods` equals the window on purpose. A Sharpe computed from
    the first forty days of the sample and labelled "12-month" is a
    different statistic wearing the same name.
    """
    if window < 2:
        raise MetricsError("rolling window must be at least 2 observations")
    excess = returns - _rf_per_period(rf, returns.index, periods_per_year)
    mean = excess.rolling(window, min_periods=window).mean()
    sd = excess.rolling(window, min_periods=window).std(ddof=1)
    out = (mean / sd.where(sd > 0)) * math.sqrt(periods_per_year)
    out.name = f"rolling_sharpe_{window}"
    return out.dropna()


@dataclass(frozen=True)
class Drawdown:
    """The worst peak-to-trough loss, and how long it took to undo.

    `recovered_on` is None when the sample ends before the old high
    water mark is reclaimed, and `sessions_to_recover` is None with
    it. Neither is ever zero for an unrecovered drawdown — the whole
    point of the field is to distinguish "we made it back" from "we
    have not made it back yet", and a zero reads as the first.
    """

    depth: float
    peak: pd.Timestamp | None
    trough: pd.Timestamp | None
    recovered_on: pd.Timestamp | None
    sessions_peak_to_trough: int | None
    sessions_to_recover: int | None
    days_to_recover: int | None
    sessions_underwater: int | None
    days_underwater: int | None
    still_underwater: bool

    @property
    def recovered(self) -> bool:
        return self.recovered_on is not None


def max_drawdown(equity: pd.Series | pd.DataFrame) -> Drawdown:
    """Deepest peak-to-trough decline in the NAV, with its timing."""
    s = as_equity(equity)
    if len(s) < 2:
        return Drawdown(
            float("nan"), None, None, None, None, None, None, None, None, False
        )

    values = s.to_numpy()
    running = np.maximum.accumulate(values)
    dd = values / running - 1.0
    t_idx = int(np.argmin(dd))
    depth = float(dd[t_idx])
    trough = s.index[t_idx]

    # The high water mark can be touched more than once before the
    # slide starts. The drawdown begins at the LAST touch; taking the
    # first one credits the strategy with months of flat water it did
    # not spend falling.
    peak_value = float(running[t_idx])
    pre = values[: t_idx + 1]
    p_idx = int(np.flatnonzero(pre >= peak_value)[-1])
    peak = s.index[p_idx]

    after = values[t_idx:]
    hits = np.flatnonzero(after >= peak_value)
    if hits.size:
        r_idx = t_idx + int(hits[0])
        recovered_on = s.index[r_idx]
        sessions_to_recover = r_idx - t_idx
        days_to_recover = int((recovered_on - trough).days)
        sessions_underwater = r_idx - p_idx
        days_underwater = int((recovered_on - peak).days)
        still = False
    else:
        recovered_on = None
        sessions_to_recover = None
        days_to_recover = None
        # Not a recovery time. This is how long the hole has been
        # open as of the last bar, and it is still open.
        sessions_underwater = len(s) - 1 - p_idx
        days_underwater = int((s.index[-1] - peak).days)
        still = True

    return Drawdown(
        depth=depth,
        peak=peak,
        trough=trough,
        recovered_on=recovered_on,
        sessions_peak_to_trough=t_idx - p_idx,
        sessions_to_recover=sessions_to_recover,
        days_to_recover=days_to_recover,
        sessions_underwater=sessions_underwater,
        days_underwater=days_underwater,
        still_underwater=still,
    )


def worst_days(returns: pd.Series, n: int = 20) -> pd.DataFrame:
    """The n single worst sessions, worst first.

    Worth reading next to the drawdown table rather than instead of
    it: a strategy can have a mild worst day and a terrible drawdown
    (a long grind) or the reverse (one gap, then recovery), and the
    two failure modes need completely different answers.
    """
    if returns.empty:
        return pd.DataFrame(
            {
                "rank": pd.Series([], dtype="int64"),
                "date": pd.Series([], dtype="datetime64[ns]"),
                "return": pd.Series([], dtype="float64"),
            }
        )
    worst = returns.nsmallest(min(n, len(returns)))
    return pd.DataFrame(
        {
            "rank": np.arange(1, len(worst) + 1, dtype="int64"),
            "date": pd.DatetimeIndex(worst.index),
            "return": worst.to_numpy(dtype="float64"),
        }
    )


def worst_months(returns: pd.Series, n: int = 10) -> pd.DataFrame:
    """The n worst calendar months, compounded from daily returns.

    `sessions` is carried because the first and last months of a
    sample are usually stubs, and a two-day stub topping the table is
    an artefact of where the backtest starts rather than a month the
    strategy had.
    """
    empty = pd.DataFrame(
        {
            "rank": pd.Series([], dtype="int64"),
            "month": pd.Series([], dtype="str"),
            "month_end": pd.Series([], dtype="datetime64[ns]"),
            "return": pd.Series([], dtype="float64"),
            "sessions": pd.Series([], dtype="int64"),
        }
    )
    if returns.empty:
        return empty

    grouped = (1.0 + returns).resample("ME")
    monthly = grouped.prod() - 1.0
    sessions = grouped.count()
    worst = monthly.nsmallest(min(n, len(monthly)))
    ends = pd.DatetimeIndex(worst.index)
    return pd.DataFrame(
        {
            "rank": np.arange(1, len(worst) + 1, dtype="int64"),
            "month": pd.Series(ends.strftime("%Y-%m"), dtype="str"),
            "month_end": ends,
            "return": worst.to_numpy(dtype="float64"),
            "sessions": sessions.reindex(worst.index).to_numpy(dtype="int64"),
        }
    )


# -- turnover and cost drag ---------------------------------------------

_NOTIONAL_ALIASES = ("notional", "trade_value", "dollar_value", "value")
_COST_ALIASES = ("cost", "total_cost", "transaction_cost")
_COST_COMPONENTS = ("commission", "slippage", "spread_cost", "fees", "impact")


@dataclass(frozen=True)
class TradingCosts:
    """What the trading cost, expressed two ways because they differ.

    `annual_turnover` counts every dollar that changed hands over
    average NAV, annualised. A book that replaces itself once a year
    scores 2.0 under this convention, not 1.0, because that is two
    trades and the costs were paid on both. The halved convention is
    more flattering and less true.

    `costs_supplied` is the field to read first. When the trade log
    carries no cost column the drag is None, never zero — a zero cost
    drag printed under a backtest reads as a cheap strategy rather
    than as an unanswered question.
    """

    traded_notional: float
    average_nav: float
    years: float
    annual_turnover: float
    total_cost: float | None
    cost_drag_bps: float | None
    cost_per_dollar_traded_bps: float | None
    costs_supplied: bool
    n_trades: int


def _trade_notional(trades: pd.DataFrame) -> pd.Series:
    for col in _NOTIONAL_ALIASES:
        if col in trades.columns:
            return trades[col].astype("float64").abs()
    if "shares" in trades.columns and "price" in trades.columns:
        return (
            trades["shares"].astype("float64").abs()
            * trades["price"].astype("float64").abs()
        )
    raise MetricsError(
        "trade log has no notional; supply one of "
        f"{list(_NOTIONAL_ALIASES)} or both 'shares' and 'price'. "
        f"Got: {sorted(trades.columns)}"
    )


def _trade_cost(trades: pd.DataFrame) -> pd.Series | None:
    for col in _COST_ALIASES:
        if col in trades.columns:
            return trades[col].astype("float64").abs()
    parts = [c for c in _COST_COMPONENTS if c in trades.columns]
    if parts:
        return sum(trades[c].astype("float64").abs() for c in parts)
    return None


def trading_costs(
    trades: pd.DataFrame | None,
    equity: pd.Series | pd.DataFrame,
) -> TradingCosts:
    """Annual turnover and cost drag, both against average NAV."""
    s = as_equity(equity)
    average_nav = float(s.mean()) if len(s) else float("nan")
    years = (
        (s.index[-1] - s.index[0]).days / DAYS_PER_YEAR if len(s) > 1 else float("nan")
    )

    if trades is None or len(trades) == 0:
        return TradingCosts(
            traded_notional=0.0,
            average_nav=average_nav,
            years=years,
            annual_turnover=0.0,
            total_cost=0.0 if trades is not None else None,
            cost_drag_bps=0.0 if trades is not None else None,
            cost_per_dollar_traded_bps=None,
            costs_supplied=trades is not None,
            n_trades=0,
        )

    notional = _trade_notional(trades)
    traded = float(notional.sum())
    cost_series = _trade_cost(trades)

    turnover = (
        traded / average_nav / years
        if average_nav > 0 and years and years > 0
        else float("nan")
    )

    if cost_series is None:
        total_cost = None
        drag_bps = None
        per_dollar = None
    else:
        total_cost = float(cost_series.sum())
        drag_bps = (
            total_cost / average_nav / years * 10_000.0
            if average_nav > 0 and years and years > 0
            else float("nan")
        )
        per_dollar = total_cost / traded * 10_000.0 if traded > 0 else float("nan")

    return TradingCosts(
        traded_notional=traded,
        average_nav=average_nav,
        years=years,
        annual_turnover=turnover,
        total_cost=total_cost,
        cost_drag_bps=drag_bps,
        cost_per_dollar_traded_bps=per_dollar,
        costs_supplied=cost_series is not None,
        n_trades=int(len(trades)),
    )


# -- period breakouts ---------------------------------------------------


def period_breakout(
    equity: pd.Series | pd.DataFrame,
    *,
    rf: float | pd.Series = 0.0,
    periods: Sequence[NamedPeriod] = REPORT_PERIODS,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> pd.DataFrame:
    """One row per named window, in the order they are declared.

    A window the sample does not cover still gets a row, with zero
    sessions and NaN statistics. Dropping it would let a backtest that
    starts in 2010 publish a stress table with no 2008 in it and no
    indication that 2008 was ever supposed to be there.

    Each window is anchored on the last NAV BEFORE the period opens
    rather than the first one inside it. Slicing on the dates alone
    and differencing what falls out quietly forfeits the period's own
    first session — 2 January 2008 is a day that 2008 gets to keep,
    and across five windows the leak all runs one way.

    `total_return` is listed before the annualised columns because for
    a 64-session window like 2018Q4 it is the only one of the two that
    means anything; annualising a quarter is arithmetic, not
    information.
    """
    s = as_equity(equity)
    rows: list[dict[str, Any]] = []

    for p in periods:
        start = pd.Timestamp(p.start)
        end = pd.Timestamp(p.end) if p.end else (s.index[-1] if len(s) else start)
        first = int(s.index.searchsorted(start, side="left"))
        stop = int(s.index.searchsorted(end, side="right"))
        window = s.iloc[max(first - 1, 0) : stop]

        row: dict[str, Any] = {
            "period": p.name,
            "start": start,
            "end": end,
            "sessions": int(max(len(window) - 1, 0)),
            "note": p.note,
        }
        if len(window) < 2:
            row |= {
                "total_return": float("nan"),
                "annualised_return": float("nan"),
                "annualised_vol": float("nan"),
                "sharpe": float("nan"),
                "max_drawdown": float("nan"),
                "worst_day": float("nan"),
            }
        else:
            r = window.pct_change().dropna()
            row |= {
                "total_return": float(window.iloc[-1] / window.iloc[0] - 1.0),
                "annualised_return": cagr(window),
                "annualised_vol": annualised_volatility(
                    r, periods_per_year=periods_per_year
                ),
                "sharpe": sharpe_ratio(
                    r, rf=rf, periods_per_year=periods_per_year
                ),
                "max_drawdown": max_drawdown(window).depth,
                "worst_day": float(r.min()),
            }
        rows.append(row)

    order = [
        "period",
        "start",
        "end",
        "sessions",
        "total_return",
        "annualised_return",
        "annualised_vol",
        "sharpe",
        "max_drawdown",
        "worst_day",
        "note",
    ]
    return pd.DataFrame(rows)[order]


# -- the deflated Sharpe ratio ------------------------------------------
#
# Bailey, D. H. and Lopez de Prado, M. (2014), "The Deflated Sharpe
# Ratio: Correcting for Selection Bias, Backtest Overfitting and
# Non-Normality", Journal of Portfolio Management 40(5), pp. 94-107.
#
# Two pieces. The first is the Probabilistic Sharpe Ratio (Bailey and
# Lopez de Prado 2012), the probability that the true Sharpe exceeds a
# benchmark given the estimator's own standard error:
#
#     PSR(SR*) = Z[ (SR - SR*) sqrt(T - 1)
#                   / sqrt(1 - g3 SR + ((g4 - 1)/4) SR^2) ]
#
# where SR is the observed per-period Sharpe, g3 the skewness and g4
# the NON-EXCESS kurtosis (3 for a normal), and T the number of
# observations. The denominator is the Mertens standard error: negative
# skew and fat tails both widen it, which is exactly right, because a
# Sharpe earned by selling tails is a less certain Sharpe.
#
# The second is the deflation. Under the null that N independent trials
# all have zero true Sharpe, the expected MAXIMUM of the N estimates is
#
#     SR* = sqrt(V) [ (1 - g) Z^-1(1 - 1/N)
#                     + g Z^-1(1 - 1/(N e)) ]
#
# with g the Euler-Mascheroni constant and V the cross-trial variance
# of the estimated Sharpes. DSR is then PSR evaluated at that SR*: the
# probability the strategy beats the best thing pure luck would have
# handed the same search.
#
# Everything here is per-period. Annualising anywhere inside this block
# multiplies the result by sqrt(252) and makes every backtest a
# discovery.


def _standardised_moments(returns: pd.Series) -> tuple[float, float]:
    """Skewness and NON-EXCESS kurtosis, plain sample moments.

    Deliberately not `Series.skew()` / `Series.kurt()`. pandas applies
    small-sample bias corrections to both and returns kurtosis in
    EXCESS form, so handing them straight to the formula above puts g4
    three units low, shrinks the standard error and inflates the
    result. The bias correction is immaterial at T in the thousands;
    the missing 3 is not.
    """
    x = returns.to_numpy(dtype="float64")
    n = x.size
    if n < 4:
        return float("nan"), float("nan")
    d = x - x.mean()
    m2 = float((d**2).mean())
    if not m2 > 0:
        return float("nan"), float("nan")
    m3 = float((d**3).mean())
    m4 = float((d**4).mean())
    return m3 / m2**1.5, m4 / m2**2


def probabilistic_sharpe_ratio(
    observed_sharpe: float,
    *,
    benchmark_sharpe: float,
    n_observations: int,
    skew: float,
    kurtosis: float,
) -> float:
    """P(true Sharpe > benchmark), all figures per-period.

    `kurtosis` is non-excess: 3 for a normal. Passing excess kurtosis
    here is the single easiest way to get a wrong answer that looks
    plausible.
    """
    t = int(n_observations)
    if t < 3:
        return float("nan")
    sr = float(observed_sharpe)

    # This cannot go negative for any real distribution — kurtosis is
    # bounded below by skew^2 + 1, which makes the quadratic in SR
    # have non-positive discriminant. The guard is for NaNs and for
    # moments supplied by hand.
    variance_term = 1.0 - float(skew) * sr + ((float(kurtosis) - 1.0) / 4.0) * sr * sr
    if not variance_term > 0:
        raise MetricsError(
            f"degenerate Sharpe standard error (skew={skew:.3f}, "
            f"kurtosis={kurtosis:.3f}, SR={sr:.4f}); check the moments "
            "are per-period and the kurtosis is non-excess"
        )

    z = (sr - float(benchmark_sharpe)) * math.sqrt(t - 1) / math.sqrt(variance_term)
    return norm_cdf(z)


def expected_max_sharpe(trials: int, trial_sharpe_std: float) -> float:
    """Best per-period Sharpe N zero-skill trials would produce.

    The Gumbel approximation to the expected maximum of N standard
    normals, scaled by the dispersion of the trial Sharpes. Exact for
    N = 1, where the answer is simply zero and the asymptotic form
    would evaluate Z^-1(0) and return minus infinity.

    Measured against 200k Monte Carlo draws it runs about 0.03 high
    from N = 5 upward, which sets the hurdle slightly too tall and so
    errs against the strategy. The one place it errs the other way is
    N = 2 (0.520 against a true 0.564), and nobody publishes a
    deflated Sharpe off two trials.
    """
    n = int(trials)
    if n < 1:
        raise MetricsError(f"trials must be at least 1, got {n}")
    if n == 1:
        return 0.0
    gumbel = (1.0 - EULER_MASCHERONI) * norm_ppf(1.0 - 1.0 / n) + (
        EULER_MASCHERONI * norm_ppf(1.0 - 1.0 / (n * math.e))
    )
    return float(trial_sharpe_std) * gumbel


@dataclass(frozen=True)
class DeflatedSharpe:
    """The headline. Read `significant` and `verdict` before anything.

    Every `*_per_period` field is in the units the formula was
    derived in (daily, for a daily curve). The annualised twins exist
    only so the numbers can be spoken aloud.
    """

    observed_sharpe_per_period: float
    observed_sharpe_annualised: float
    benchmark_sharpe_per_period: float
    benchmark_sharpe_annualised: float
    trials: int
    n_observations: int
    skew: float
    kurtosis: float
    trial_sharpe_std: float
    trial_dispersion_source: str
    probabilistic_sharpe: float
    deflated_sharpe: float
    threshold: float
    significant: bool
    rf_convention: str
    verdict: str


def deflated_sharpe_ratio(
    returns: pd.Series,
    *,
    trials: int | TrialCounter,
    rf: float | pd.Series = 0.0,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
    trial_sharpe_std: float | None = None,
    threshold: float = SIGNIFICANCE_THRESHOLD,
) -> DeflatedSharpe:
    """How much of this Sharpe is explained by having looked N times.

    `trials` is the count of distinct configurations tried, and the
    right thing to pass is the `TrialCounter` itself so nobody has to
    remember. Correlated variants of one idea are not N independent
    trials, so the raw distinct count overstates N — which raises the
    hurdle rather than lowering it, and being conservative in that
    direction is the only defensible way to be wrong here.

    `trial_sharpe_std` is the cross-trial dispersion of the estimated
    per-period Sharpes. Supply it when the search actually recorded
    every trial's Sharpe. When it is absent we fall back to the null's
    own sampling dispersion, 1/sqrt(T - 1): under zero true skill each
    trial's Sharpe estimate has that standard error, so it is the
    dispersion the null itself predicts. The fallback is recorded in
    `trial_dispersion_source` because it is an assumption and it
    belongs in the write-up, not in a footnote nobody reads.
    """
    n_trials = (
        trials.distinct_count()
        if isinstance(trials, TrialCounter)
        else int(trials)
    )
    if n_trials < 1:
        raise MetricsError(
            "a deflated Sharpe needs at least one trial; a count of zero "
            "means the trial ledger was never written to, which is not "
            "the same as having tried nothing once"
        )

    excess = returns - _rf_per_period(rf, returns.index, periods_per_year)
    t = int(len(excess))
    sr = sharpe_ratio(
        returns, rf=rf, periods_per_year=periods_per_year, annualise=False
    )
    skew, kurt = _standardised_moments(excess)

    if trial_sharpe_std is None:
        std = 1.0 / math.sqrt(t - 1) if t > 1 else float("nan")
        source = (
            "assumed: 1/sqrt(T-1), the sampling dispersion of a zero-skill "
            "trial on a sample this long. No per-trial Sharpes were supplied."
        )
    else:
        std = float(trial_sharpe_std)
        source = "measured across the recorded trials"

    sr_star = expected_max_sharpe(n_trials, std)

    psr = probabilistic_sharpe_ratio(
        sr,
        benchmark_sharpe=0.0,
        n_observations=t,
        skew=skew,
        kurtosis=kurt,
    )
    dsr = probabilistic_sharpe_ratio(
        sr,
        benchmark_sharpe=sr_star,
        n_observations=t,
        skew=skew,
        kurtosis=kurt,
    )

    ann = math.sqrt(periods_per_year)
    significant = bool(dsr >= threshold)
    verdict = _dsr_verdict(
        dsr=dsr,
        threshold=threshold,
        significant=significant,
        trials=n_trials,
        n_observations=t,
        observed_ann=sr * ann,
        hurdle_ann=sr_star * ann,
    )

    return DeflatedSharpe(
        observed_sharpe_per_period=sr,
        observed_sharpe_annualised=sr * ann,
        benchmark_sharpe_per_period=sr_star,
        benchmark_sharpe_annualised=sr_star * ann,
        trials=n_trials,
        n_observations=t,
        skew=skew,
        kurtosis=kurt,
        trial_sharpe_std=std,
        trial_dispersion_source=source,
        probabilistic_sharpe=psr,
        deflated_sharpe=dsr,
        threshold=threshold,
        significant=significant,
        rf_convention=rf_convention(rf),
        verdict=verdict,
    )


def _dsr_verdict(
    *,
    dsr: float,
    threshold: float,
    significant: bool,
    trials: int,
    n_observations: int,
    observed_ann: float,
    hurdle_ann: float,
) -> str:
    """One sentence that cannot be quoted out of context favourably.

    Quotes the observation count rather than a span in years. T is
    what the formula actually consumed, and a "years" here would sit
    next to the report's calendar span and disagree with it by the
    ratio of sessions to days.
    """
    stem = (
        f"{trials} trial(s), {n_observations:,} observations: the best-of-N "
        f"annualised Sharpe under the null is {hurdle_ann:.2f}, observed "
        f"{observed_ann:.2f}"
    )
    if math.isnan(dsr):
        return f"{stem}. Deflated Sharpe undefined — too few observations."
    if significant:
        return (
            f"{stem}. Deflated Sharpe {dsr:.3f} clears the {threshold:.0%} "
            "bar: the result is not explained by the number of looks."
        )
    if observed_ann <= hurdle_ann:
        return (
            f"{stem}. The observed Sharpe does not even reach the selection "
            f"hurdle. Deflated Sharpe {dsr:.3f} — this is what searching "
            "produces, and nothing here needs a skill explanation."
        )
    return (
        f"{stem}. Deflated Sharpe {dsr:.3f} is below the {threshold:.0%} bar: "
        "the edge is not distinguishable from the best draw a search this "
        "wide would find by luck. Report it as insignificant, not as "
        "promising."
    )


# -- the trial ledger ---------------------------------------------------


@dataclass(frozen=True)
class TrialRecord:
    config_hash: str
    description: str
    timestamp: str


class TrialCounter:
    """An append-only ledger of every configuration ever evaluated.

    The file at `trials.jsonl` is deliberately NOT gitignored, and
    that is a statistical decision rather than a housekeeping one. The
    deflated Sharpe above is a function of N. A reader who cannot see
    N, or who has to take our word that the counter was never wound
    back, has been handed an unfalsifiable number: any strategy can
    clear any bar by forgetting how many it tried. Committing the
    ledger makes the denominator part of the record, and makes a
    silent reset show up in a diff.

    The class enforces the same thing mechanically. The file is opened
    in append mode and nowhere in this module is it opened any other
    way. There is no `reset`, no `clear`, no `truncate`, and adding
    one would defeat the only property this class has.
    """

    def __init__(self, path: Path | str = TRIALS_PATH) -> None:
        self.path = Path(path)

    # -- writing --------------------------------------------------------

    @staticmethod
    def hash_config(config: Mapping[str, Any] | str) -> str:
        """A stable identity for a configuration.

        Canonical JSON — sorted keys, no incidental whitespace — so
        that two dicts differing only in insertion order are one
        trial and not two. A string is taken as an already-computed
        hash and passed through, which is how a caller with its own
        config fingerprinting keeps using it.
        """
        if isinstance(config, str):
            return config
        blob = json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def record(
        self,
        *,
        config: Mapping[str, Any] | str,
        description: str,
        timestamp: datetime | date | str,
    ) -> TrialRecord:
        """Append one trial. Never overwrites, never rewrites.

        `timestamp` is an argument and not a `datetime.now()` call
        inside this method on purpose: a function that reads the wall
        clock cannot be tested for determinism, and the one piece of
        code in this project that must be beyond argument is the one
        that decides how many times we looked.
        """
        if not description or not description.strip():
            raise MetricsError(
                "a trial needs a description; an unlabelled row in the "
                "ledger raises the hurdle for everything after it and "
                "tells nobody why"
            )
        rec = TrialRecord(
            config_hash=self.hash_config(config),
            description=description.strip(),
            timestamp=_iso(timestamp),
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Mode "a" and only ever "a".
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec.__dict__, sort_keys=True) + "\n")
        return rec

    # -- reading --------------------------------------------------------

    def records(self) -> list[TrialRecord]:
        if not self.path.exists():
            return []
        out: list[TrialRecord] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, start=1):
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    out.append(
                        TrialRecord(
                            config_hash=str(obj["config_hash"]),
                            description=str(obj["description"]),
                            timestamp=str(obj["timestamp"]),
                        )
                    )
                except (ValueError, KeyError, TypeError) as exc:
                    raise TrialLogCorrupt(
                        f"{self.path}:{lineno} will not parse ({exc}). "
                        "Refusing to skip it — a dropped line lowers the "
                        "trial count and flatters every deflated Sharpe "
                        "computed afterwards."
                    ) from exc
        return out

    def count(self) -> int:
        """Every row ever appended, re-runs included."""
        return len(self.records())

    def distinct_count(self) -> int:
        """Distinct configurations, which is what N means.

        Running the same configuration twice is one trial. Running
        forty variants of one idea is forty by this count and rather
        fewer in truth — see the note in `deflated_sharpe_ratio` on
        why erring that way is the safe direction.
        """
        return len({r.config_hash for r in self.records()})

    def frame(self) -> pd.DataFrame:
        recs = self.records()
        return pd.DataFrame(
            {
                "config_hash": pd.Series(
                    [r.config_hash for r in recs], dtype="str"
                ),
                "description": pd.Series(
                    [r.description for r in recs], dtype="str"
                ),
                "timestamp": pd.Series([r.timestamp for r in recs], dtype="str"),
            }
        )


def _iso(ts: datetime | date | str) -> str:
    if isinstance(ts, str):
        return ts
    if isinstance(ts, (datetime, date)):
        return ts.isoformat()
    raise MetricsError(f"timestamp must be a datetime, date or ISO string, got {ts!r}")


# -- the whole picture --------------------------------------------------


@dataclass(frozen=True)
class PerformanceReport:
    """Everything the brief asks for, computed once, in one object."""

    start: pd.Timestamp
    end: pd.Timestamp
    years: float
    n_sessions: int
    total_return: float
    cagr: float
    annualised_volatility: float
    sharpe: float
    rf_convention: str
    drawdown: Drawdown
    costs: TradingCosts
    deflated: DeflatedSharpe | None
    worst_days: pd.DataFrame = field(repr=False, default_factory=pd.DataFrame)
    worst_months: pd.DataFrame = field(repr=False, default_factory=pd.DataFrame)
    periods: pd.DataFrame = field(repr=False, default_factory=pd.DataFrame)
    rolling_sharpe: pd.Series = field(
        repr=False, default_factory=lambda: pd.Series(dtype="float64")
    )

    @property
    def headline(self) -> str:
        """The one line to lead with, and it is not the Sharpe.

        A raw Sharpe printed without its trial count is the number
        this project exists to stop reporting.
        """
        if self.deflated is None:
            return (
                f"Sharpe {self.sharpe:.2f} annualised — UNDEFLATED, no trial "
                "count supplied. Not reportable as an edge."
            )
        return self.deflated.verdict

    def summary(self) -> pd.DataFrame:
        """One typed row, so runs can be stacked and compared."""
        d = self.drawdown
        c = self.costs
        row: dict[str, Any] = {
            "start": self.start,
            "end": self.end,
            "years": self.years,
            "sessions": self.n_sessions,
            "total_return": self.total_return,
            "cagr": self.cagr,
            "annualised_vol": self.annualised_volatility,
            "sharpe": self.sharpe,
            "max_drawdown": d.depth,
            "drawdown_peak": d.peak,
            "drawdown_trough": d.trough,
            "recovered_on": d.recovered_on,
            "sessions_to_recover": d.sessions_to_recover,
            "days_to_recover": d.days_to_recover,
            "still_underwater": d.still_underwater,
            "annual_turnover": c.annual_turnover,
            "cost_drag_bps": c.cost_drag_bps,
            "costs_supplied": c.costs_supplied,
            "trials": self.deflated.trials if self.deflated else None,
            "probabilistic_sharpe": (
                self.deflated.probabilistic_sharpe if self.deflated else None
            ),
            "deflated_sharpe": (
                self.deflated.deflated_sharpe if self.deflated else None
            ),
            "significant": self.deflated.significant if self.deflated else None,
            "rf_convention": self.rf_convention,
        }
        return pd.DataFrame([row])


def evaluate(
    equity: pd.Series | pd.DataFrame,
    *,
    trades: pd.DataFrame | None = None,
    rf: float | pd.Series = 0.0,
    trials: int | TrialCounter | None = None,
    trial_sharpe_std: float | None = None,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
    rolling_window: int = TRADING_DAYS_PER_YEAR,
    n_worst_days: int = 20,
    n_worst_months: int = 10,
    report_periods: Sequence[NamedPeriod] = REPORT_PERIODS,
) -> PerformanceReport:
    """Measure one run end to end.

    `trials` may be omitted, and then `deflated` is None and the
    headline says so in plain language. That is the right behaviour
    for an intermediate diagnostic and the wrong thing to put in front
    of anyone; the absence is loud rather than defaulted to 1, because
    a silent N=1 would deflate nothing and read as if it had.
    """
    s = as_equity(equity)
    if len(s) < 2:
        raise MetricsError("need at least two NAV observations to measure anything")
    r = to_returns(s)

    deflated = (
        deflated_sharpe_ratio(
            r,
            trials=trials,
            rf=rf,
            periods_per_year=periods_per_year,
            trial_sharpe_std=trial_sharpe_std,
        )
        if trials is not None
        else None
    )

    return PerformanceReport(
        start=s.index[0],
        end=s.index[-1],
        years=(s.index[-1] - s.index[0]).days / DAYS_PER_YEAR,
        n_sessions=len(r),
        total_return=float(s.iloc[-1] / s.iloc[0] - 1.0),
        cagr=cagr(s),
        annualised_volatility=annualised_volatility(
            r, periods_per_year=periods_per_year
        ),
        sharpe=sharpe_ratio(r, rf=rf, periods_per_year=periods_per_year),
        rf_convention=rf_convention(rf),
        drawdown=max_drawdown(s),
        costs=trading_costs(trades, s),
        deflated=deflated,
        worst_days=worst_days(r, n_worst_days),
        worst_months=worst_months(r, n_worst_months),
        periods=period_breakout(
            s, rf=rf, periods=report_periods, periods_per_year=periods_per_year
        ),
        rolling_sharpe=rolling_sharpe(
            r, window=rolling_window, rf=rf, periods_per_year=periods_per_year
        ),
    )
