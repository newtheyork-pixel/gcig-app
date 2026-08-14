"""Realised volatility, and the inverse-vol scalar sizing multiplies by.

Equal dollar weights are not equal risk weights, and the gap is not
subtle. Equity volatility runs several times bond volatility over any
stretch of this sample, so a nine-sleeve book split evenly by dollars
is an equity book carrying a diversified label: the equity sleeves
move it, the bond sleeves decorate it, and the reported allocation
says nothing about where the risk actually sits. This file produces
the number that fixes the units — one scalar per sleeve per day,
proportional to the reciprocal of that sleeve's trailing volatility,
so that the sizing layer can turn dollars into something closer to
risk.

What it does NOT do is forecast anything. An inverse-vol scalar is not
a directional view and must never be read as one; it says how large a
position has to be to contribute a comparable amount of risk, and it
is silent on whether the position should exist. The two questions are
answered by different files on purpose.

Three traps, and the file is arranged around them.

**Every number here comes off `close_adj`.** Over 2004-2026 TLT
returned -2.6% on price and +105.8% on total return; LQD -3.2% and
+141.4%. For the bond and credit sleeves nearly all return, and a
material part of the variation, is coupon. A volatility computed on
`close_unadj` is measuring a different instrument — one whose entire
income stream has been deleted — and the sizing layer would then be
equalising the risk of a security nobody holds. There is no parameter
on any function below that selects a price series; the panel handed in
is the adjusted one or the answer is wrong, and the docstrings say so
rather than leaving it to a convention somebody forgets.

**The inverse of a near-zero number is an infinity waiting to
happen.** The cash sleeve's realised volatility in a ZIRP year is
close enough to zero that a 63-day window of it can be exactly zero,
and 2009 through 2021 is most of the sample. Volatility is therefore
floored before it is inverted. This is a NUMERICAL-STABILITY argument
and nothing else: the floor exists so the arithmetic stays finite, it
was fixed before any performance number existed, and it is not a dial.
Anyone who later finds themselves adjusting it to change what the book
holds is making a portfolio decision in the wrong file — the sleeve
caps in `portfolio/sleeves.py` are where that decision already lives
and is already argued.

**The score for day T uses data through the close of T and not one bar
more.** Every window below is a trailing `rolling(...)` on a frame
indexed forward in time, the cross-sectional reference is taken within
a single date, and nothing is centred, shifted backwards or filled
from the future. An off-by-one here is invisible in review and
manufactures a beautiful backtest, so it is pinned by a test that
truncates the frame after T, recomputes, and demands the score at T be
bit-for-bit identical.

`evaluate` is the one function that deliberately looks forward, and it
is a diagnostic rather than a signal. See its docstring.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from ..engine.metrics import TRADING_DAYS_PER_YEAR

__all__ = [
    "EVALUATION_HORIZON",
    "LONG_WINDOW",
    "MIN_ANNUAL_VOLATILITY",
    "MIN_SESSIONS",
    "NORMALISATION",
    "RiskContributionTest",
    "SHORT_WEIGHT",
    "SHORT_WINDOW",
    "SignalError",
    "WARMUP_SESSIONS",
    "evaluate",
    "inverse_volatility_scalar",
    "panel_from_prices",
    "realised_volatility",
    "total_returns",
]


class SignalError(ValueError):
    """The signal was handed a panel it cannot honestly read."""


# -- the parameters, and where each one came from -----------------------
#
# All of these were fixed in writing before a single performance number
# existed, which is the only moment at which a parameter can be chosen
# honestly. None was selected by comparing outcomes, and if one ever is,
# it stops being a prior and owes `metrics.TrialCounter` a row.

#: One quarter. The responsive half of the estimate.
#:
#: The tradeoff is arithmetic and it runs in both directions at once.
#: The relative standard error of a volatility estimate from n
#: observations is roughly 1/sqrt(2n), so 63 days carries about 9% and
#: a 21-day month about 15% — at a month the estimate is mostly noise
#: and the sizing layer would be rebalancing the book against sampling
#: error. Go the other way and the estimate stops being able to see a
#: regime change: a window of a year takes six months to half-react to
#: a volatility shock, which in 2008 and again in March 2020 is exactly
#: the wrong speed. A quarter is the round number that responds inside
#: a month while keeping the estimation error under ten per cent, and
#: it is a quarter rather than 60 or 70 days because a quarter is a
#: period a person can reason about.
SHORT_WINDOW: int = 63

#: One trading year. The stable half.
#:
#: Same number the universe rules use for minimum history — "anything
#: younger has no volatility estimate worth having" — and the same
#: window `metrics.rolling_sharpe` reports on. A year spans an earnings
#: cycle and a summer, so it is not dominated by whichever season the
#: window happens to sit in, and at ~4.5% relative standard error it is
#: the anchor the short window is allowed to move around.
LONG_WINDOW: int = TRADING_DAYS_PER_YEAR

#: Half the variance from each window.
#:
#: This is a prior about volatility clustering, not a fitted weight.
#: Volatility is persistent — a quiet week is followed by a quiet week
#: far more often than chance allows — which is the entire content of
#: every ARCH-family model and the reason a trailing estimate is worth
#: anything at all. Persistence is also finite, so the recent past is
#: more informative than the distant past without being the only thing
#: that matters. Blending the two windows' VARIANCES equally is the
#: crudest honest expression of that: it is algebraically the same as
#: one estimator weighting each of the last 63 days at (1/2)(1/63) +
#: (1/2)(1/252) and each of days 64 through 252 at (1/2)(1/252) — a
#: two-step decay kernel, recent observations counting about five times
#: an old one. A smoother kernel would need a decay constant, which is
#: a number nobody can justify without looking at results.
#:
#: Half and half rather than any other split because we have no prior
#: about which horizon deserves more, and pretending to one would be
#: choosing a parameter we could not defend. Variances rather than
#: volatilities because variance is what averages: mixing two
#: estimators of the same variance is a statement about a weighting
#: kernel, whereas averaging two standard deviations is a statement
#: about nothing in particular.
SHORT_WEIGHT: float = 0.5

#: One per cent a year, as an annualised volatility. The floor.
#:
#: Numerical stability, stated once and loudly so nobody later "tunes"
#: it. The cash sleeve in a zero-rate year has a realised volatility
#: indistinguishable from zero — BIL's total return over a quiet
#: quarter is a step function of monthly distributions on a flat price
#: — and a 63-day window of exactly-equal closes gives a variance of
#: exactly zero, whose reciprocal is not a large number, it is an
#: infinity that propagates through every weight in the book.
#:
#: One per cent is chosen to sit an order of magnitude below anything
#: the allocator is being asked to compare on risk: the quietest year
#: US equity has had in this sample ran around 7% annualised, long
#: Treasuries do not go below about 8%, and even a bill fund prints a
#: few tenths of a per cent in a year when the front end moves. So the
#: floor cannot bind on a risk sleeve, and if it ever does the right
#: response is to look at the data rather than at this constant.
#:
#: Flooring the volatility is identically capping the scalar: with the
#: reference below, no scalar can exceed the median sleeve's own
#: annualised volatility divided by 0.01, which for a book running 12%
#: is about 12. Finite is the whole claim. There is deliberately no
#: bound on the other side — a wildly volatile sleeve produces a small
#: positive scalar, which is finite and well behaved, and a lower bound
#: would be a portfolio decision about minimum position size wearing a
#: numerical costume.
MIN_ANNUAL_VOLATILITY: float = 0.01

#: Closes needed before the first scalar exists.
#:
#: The long window must be FULL. A quantity labelled "one-year realised
#: volatility" computed from sixty days is a different statistic
#: wearing the same name, and the sizing layer would be comparing
#: sleeves measured over different horizons without knowing it. A
#: sleeve that listed eleven months ago therefore has no scalar, which
#: is the honest answer and matches the universe rules' 252-day
#: minimum: before that, the right thing to report is nothing.
MIN_SESSIONS: int = LONG_WINDOW + 1

#: The same figure as an engine `warmup`, which counts sessions of
#: history banked BEFORE the first decision. At loop index i the view
#: holds i+1 closes, so i must reach LONG_WINDOW for the panel to hold
#: MIN_SESSIONS rows. Stated here rather than left as an off-by-one for
#: each caller to rediscover.
WARMUP_SESSIONS: int = LONG_WINDOW

#: What the scalar is divided by, in one line, because a sizing layer
#: that has to reverse-engineer the units will eventually guess.
NORMALISATION: str = (
    "cross-sectional median of the floored annualised volatilities on "
    "that date: the median sleeve scores exactly 1.0, a sleeve at half "
    "the median's risk scores 2.0, one at twice its risk scores 0.5"
)

#: One quarter of forward returns per evaluation window. Diagnostics
#: only — see `evaluate`.
EVALUATION_HORIZON: int = SHORT_WINDOW


# -- reading the panel --------------------------------------------------


def panel_from_prices(
    prices: pd.DataFrame, *, key: str = "ticker"
) -> pd.DataFrame:
    """Pivot a long `schema.PRICES` frame into a wide `close_adj` panel.

    Offered here rather than left to the caller because the pivot is
    the single most dangerous line anyone writes against this schema.
    Ticker strings are recycled — GM, CC, WB — and a pivot on a
    recycled symbol grafts a dead company's price history onto a living
    one's, producing a series that fell 99% and recovered, which
    backtests beautifully. The duplicate check is what makes `ticker`
    safe to offer as the default at all, and it is safe for a sleeve
    panel specifically: nine ETFs, none of whose symbols has ever
    belonged to anything else. Pass `key="permaticker"` for anything
    wider.
    """
    need = ["date", key, "close_adj"]
    missing = [c for c in need if c not in prices.columns]
    if missing:
        raise SignalError(
            f"price frame is missing {missing}; got {sorted(prices.columns)}"
        )

    dupes = int(prices.duplicated(subset=["date", key]).sum())
    if dupes:
        raise SignalError(
            f"{dupes:,} duplicate ({key}, date) row(s). If the key is a "
            "ticker this is the recycled-symbol trap — two entities "
            "sharing one symbol — and the pivot would splice one "
            "company's history onto another's. Pivot on permaticker."
        )

    wide = prices.pivot(index="date", columns=key, values="close_adj")
    wide = wide.sort_index()
    wide.columns = pd.Index([str(c) for c in wide.columns])
    return _validated(wide)


def total_returns(close_adj: pd.DataFrame) -> pd.DataFrame:
    """Simple daily TOTAL returns, one column per sleeve.

    Simple rather than log, matching `metrics.to_returns`: these get
    summed across positions and compounded across months downstream,
    and log returns only behave under one of those two. The difference
    is immaterial at daily frequency for a volatility estimate and the
    consistency is not — a sizing layer and a reporting layer disagreeing
    about what a return is produces two numbers nobody can reconcile.

    Missing bars stay missing. `pct_change` does no filling in pandas 3
    and none is added here: forward-filling a hole would print a
    zero-return day the market never had and quietly lower the sleeve's
    measured risk, which is precisely the direction that makes a
    position too big.
    """
    panel = _validated(close_adj)
    out = panel.pct_change()
    out.columns = panel.columns
    return out


def realised_volatility(
    close_adj: pd.DataFrame,
    *,
    short_window: int = SHORT_WINDOW,
    long_window: int = LONG_WINDOW,
    short_weight: float = SHORT_WEIGHT,
) -> pd.DataFrame:
    """Annualised realised volatility, blended across two windows.

    Both windows are trailing and both must be FULL: a window holding
    even one missing bar returns NaN rather than an estimate computed
    off whatever happened to be there. That is why a sleeve gets no
    number for its first year, and why a data gap in the middle of a
    series produces a hole instead of a quietly short sample.

    Annualised by sqrt(252) for legibility only. The scalar below is a
    ratio of two volatilities, so the annualisation cancels out of it
    entirely and the sizing layer never sees these units — but a
    diagnostic that prints 0.004 where a person expects 0.06 gets
    misread, and a number that gets misread is worse than a slow one.

    The estimator is the ordinary centred sample standard deviation,
    `ddof=1`, the same convention as `metrics.annualised_volatility`
    and `MarketData.from_prices`. Subtracting a window mean estimated
    from 63 daily observations is arguably worse than assuming a zero
    mean, and a risk model built from scratch might well do the latter;
    it is not done here because a sizing layer computing volatility one
    way while the reporting layer computes it another produces two
    numbers that cannot be reconciled, and that costs more than the
    estimator gains.
    """
    _check_windows(short_window, long_window, short_weight)

    returns = total_returns(close_adj)
    short = returns.rolling(short_window, min_periods=short_window).var(ddof=1)
    long = returns.rolling(long_window, min_periods=long_window).var(ddof=1)

    blended = short_weight * short + (1.0 - short_weight) * long
    return np.sqrt(blended) * np.sqrt(TRADING_DAYS_PER_YEAR)


def inverse_volatility_scalar(
    close_adj: pd.DataFrame,
    *,
    short_window: int = SHORT_WINDOW,
    long_window: int = LONG_WINDOW,
    short_weight: float = SHORT_WEIGHT,
    min_annual_volatility: float = MIN_ANNUAL_VOLATILITY,
) -> pd.DataFrame:
    """One dimensionless sizing scalar per sleeve per date.

    The scalar is `reference / volatility`, where the reference is the
    CROSS-SECTIONAL MEDIAN of the floored volatilities on that same
    date. Three consequences worth having in mind, since the sizing
    layer applies this without knowing anything about how it was made:

      * It is dimensionless. Multiply every sleeve's volatility by any
        constant and the scalar is unchanged, so the caller never has
        to know whether these were daily or annualised numbers.
      * The median sleeve scores 1.0. A sleeve at half the median's
        risk scores 2.0 and one at twice its risk scores 0.5, which
        means the vector can be read at a glance and a wrong one looks
        wrong. With an even number of sleeves the reference is the
        midpoint of the two middle volatilities, as a median always is,
        so no sleeve lands exactly on 1.0 and the median SCALAR sits a
        few per cent above it — reciprocals do not commute with
        averaging. Harmless, and worth knowing before someone asserts
        the wrong invariant.
      * The scale does not lurch when the panel's composition changes.
        DBC lists thirteen months into the sample and BIL two and a
        half years in; a normalisation by the MEAN of the reciprocals
        would be dominated by whichever sleeve happens to be quietest,
        which in this book is always cash and always sitting on the
        floor — so every other sleeve's scalar would silently become a
        function of `MIN_ANNUAL_VOLATILITY`. A median reference lets
        the floor affect only the sleeve it actually binds on, which is
        the difference between a numerical guard and a live parameter.

    Flooring happens BEFORE the reference is taken, which is also what
    makes the reference provably positive and the division therefore
    total. Where a sleeve has no volatility estimate — its first year,
    or a hole in its data — the scalar is NaN, and NaN is the answer
    rather than a stand-in. A sizing layer must be told it has nothing
    for that sleeve today; handing it a 1.0 would be an assertion that
    the sleeve carries median risk, which is a guess dressed as a
    measurement.

    Causality: every window is trailing and the reference is taken
    across sleeves WITHIN one date, never across dates. There is no
    full-sample statistic anywhere in this function — a full-sample
    average reference would put the whole panel's future into every row
    of the output, and it would be invisible.
    """
    if not min_annual_volatility > 0.0:
        raise SignalError(
            f"min_annual_volatility must be positive, got "
            f"{min_annual_volatility!r}. Zero is not a floor; it is the "
            "infinity this argument exists to prevent."
        )

    vol = realised_volatility(
        close_adj,
        short_window=short_window,
        long_window=long_window,
        short_weight=short_weight,
    )
    floored = vol.clip(lower=min_annual_volatility)
    reference = floored.median(axis=1, skipna=True)
    return floored.rdiv(reference, axis=0)


# -- the standalone diagnostic ------------------------------------------
#
# There is no information-coefficient test in this file, and its
# absence is deliberate rather than an omission. An IC measures how well
# a score ranks future RETURNS, and an inverse-vol scalar makes no claim
# about returns at all — it is a statement about the size a position has
# to be, not about which direction it should go. Regressing it against
# forward returns would produce a number, and that number would be
# either the low-volatility anomaly or noise, neither of which is the
# thing this file claims. So the test below is of the actual claim: that
# sizing by inverse volatility produces more equal realised RISK
# CONTRIBUTIONS than sizing by equal dollars.


@dataclass(frozen=True)
class RiskContributionTest:
    """What inverse-vol sizing did to the spread of risk contributions.

    Two bases, and the second is the one worth reading.

    `standalone` treats each sleeve's risk as its own volatility, so a
    contribution is `w_i * sigma_i` over the sum of the same. Inverse-vol
    weights equalise this almost by construction, and the result is
    close to a tautology — it is reported because a tautology that comes
    out wrong means the arithmetic is broken, which is worth knowing,
    and NOT because it is evidence of anything.

    `correlation_aware` uses the realised covariance of the window, so a
    contribution is `w_i * (Sigma w)_i` over `w' Sigma w`. This is the
    real question. Inverse-vol sizing ignores correlation entirely, so
    it does not equalise this and never claimed to: three equity sleeves
    each sized to a modest standalone risk still move together and
    together dominate the book. Whether inverse-vol nonetheless beats
    equal weighting here is a fact about the sleeves rather than a
    theorem, and it is what these numbers are for.

    `windows` carries one row per (window, scheme, basis) and
    `contributions` one row per (window, scheme, basis, sleeve), so any
    aggregate below can be re-cut — by sleeve, by regime, by year —
    without recomputing.
    """

    horizon: int
    n_windows: int
    n_skipped: int
    assets: tuple[str, ...]
    windows: pd.DataFrame
    contributions: pd.DataFrame
    paired: pd.DataFrame

    def summary(self) -> pd.DataFrame:
        """Mean dispersion per (basis, scheme), windows equally weighted.

        A mean across windows that hold different numbers of sleeves is
        a rough summary and is labelled as one: dispersion depends on
        how many things it is measured over, so the figure to argue
        from is the PAIRED comparison in `paired`, where both schemes
        are measured on the same sleeves in the same window.
        """
        if not len(self.windows):
            return self.windows.copy()
        grouped = self.windows.groupby(["basis", "scheme"], as_index=False)
        return grouped.agg(
            windows=("dispersion_std", "size"),
            mean_dispersion_std=("dispersion_std", "mean"),
            mean_dispersion_range=("dispersion_range", "mean"),
            mean_effective_share=("effective_share", "mean"),
        )

    @property
    def verdict(self) -> str:
        """The claim, and whether it survived, in words that cannot be
        quoted favourably out of context."""
        if not self.n_windows:
            return (
                "No evaluable windows: the panel is shorter than the "
                f"{MIN_SESSIONS}-session warmup plus one {self.horizon}-"
                "session measurement window, so this says nothing about "
                "the signal."
            )

        lines = [
            f"{self.n_windows} non-overlapping {self.horizon}-session "
            f"windows over {len(self.assets)} sleeves "
            f"({self.n_skipped} skipped for want of data)."
        ]
        for row in self.paired.to_dict("records"):
            basis = str(row["basis"])
            gloss = (
                "near-tautological, and reported as an arithmetic check "
                "rather than as evidence"
                if basis == "standalone"
                else "the real test: inverse-vol sizing cannot see "
                "correlation and makes no promise here"
            )
            lines.append(
                f"{basis}: mean dispersion of risk contributions "
                f"{row['mean_dispersion_equal']:.4f} equal-weight against "
                f"{row['mean_dispersion_inverse_vol']:.4f} inverse-vol; "
                f"inverse-vol was the more equal book in "
                f"{row['wins']:.0f} of {row['n_windows']:.0f} windows "
                f"({row['win_rate']:.0%}); effective number of risk "
                f"sources {row['mean_effective_n_equal']:.2f} against "
                f"{row['mean_effective_n_inverse_vol']:.2f} of a possible "
                f"{row['mean_n_assets']:.1f}. {gloss}."
            )
        return "\n".join(lines)


def evaluate(
    close_adj: pd.DataFrame,
    *,
    horizon: int = EVALUATION_HORIZON,
    short_window: int = SHORT_WINDOW,
    long_window: int = LONG_WINDOW,
    short_weight: float = SHORT_WEIGHT,
    min_annual_volatility: float = MIN_ANNUAL_VOLATILITY,
    min_assets: int = 2,
) -> RiskContributionTest:
    """Measure the signal's own claim, standalone, in one call.

    Usage when prices arrive is a single line —
    `evaluate(panel_from_prices(prices))` — and it takes the same
    adjusted-close panel everything else in this file takes.

    **This function reads the future on purpose and must never be
    called from a strategy.** Weights are formed from the scalar as of
    date T, which is causal; the risk those weights went on to
    contribute is then measured on the returns of the following
    `horizon` sessions, which is not. That asymmetry is the entire
    design: measuring the contributions against the same trailing
    covariance that produced the weights would make the standalone
    result exactly equal by construction and prove nothing at all. The
    output is a report, never an input.

    Windows are non-overlapping — every `horizon`-th session — because
    overlapping quarters share most of their returns, and a win rate
    computed over them counts one quarter's luck sixty-three times.

    A note on what to hand in. Including the cash sleeve makes
    inverse-vol look spectacular for a mechanical reason: cash has
    almost no risk, so equal dollar weighting hands it a ninth of the
    book and roughly none of the risk, and any scheme that notices this
    wins. The honest run passes the risk sleeves. The cash leg is the
    residual absorber in this design anyway, so its weight is not
    something the inverse-vol scalar decides.
    """
    scalar = inverse_volatility_scalar(
        close_adj,
        short_window=short_window,
        long_window=long_window,
        short_weight=short_weight,
        min_annual_volatility=min_annual_volatility,
    )
    returns = total_returns(close_adj)
    assets = tuple(str(c) for c in scalar.columns)

    if horizon < 2:
        raise SignalError(
            f"horizon {horizon} is too short to estimate a covariance "
            "from; a window of one session has no dispersion in it"
        )
    if min_assets < 2:
        raise SignalError(
            f"min_assets {min_assets} makes no sense: the dispersion of "
            "one risk contribution is zero under every scheme, so a "
            "one-sleeve window would report a tie and dilute the count"
        )

    window_rows: list[dict[str, Any]] = []
    contribution_rows: list[dict[str, Any]] = []
    n_rows = len(scalar)
    skipped = 0

    for t in range(0, max(n_rows - horizon, 0), horizon):
        s = scalar.iloc[t]
        forward = returns.iloc[t + 1 : t + 1 + horizon]
        usable = s.notna() & s.gt(0.0) & forward.notna().all(axis=0)
        names = [str(c) for c in scalar.columns[usable.to_numpy()]]
        if len(names) < min_assets:
            # Not an error and not a zero: before the warmup completes
            # there is simply nothing to compare, and a window counted
            # as a tie would flatter whichever scheme was behind.
            skipped += 1
            continue

        date = scalar.index[t]
        block = forward.loc[:, names].to_numpy(dtype="float64")
        vols = block.std(axis=0, ddof=1)
        cov = np.cov(block, rowvar=False, ddof=1)

        raw = s.loc[names].to_numpy(dtype="float64")
        schemes = {
            "equal": np.full(len(names), 1.0 / len(names)),
            "inverse_vol": raw / raw.sum(),
        }
        bases = {
            "standalone": lambda w: w * vols,
            "correlation_aware": lambda w: w * (cov @ w),
        }

        for scheme, weights in schemes.items():
            for basis, contribution in bases.items():
                shares = _shares(contribution(weights))
                if shares is None:
                    # A window in which the book had no risk at all.
                    # Vanishingly rare, and a division by it would put
                    # an inf into an average nobody would question.
                    continue
                window_rows.append(
                    {
                        "date": date,
                        "scheme": scheme,
                        "basis": basis,
                        "n_assets": len(names),
                        "dispersion_std": float(shares.std(ddof=0)),
                        "dispersion_range": float(shares.max() - shares.min()),
                        "effective_n": _effective_n(shares),
                        "effective_share": _effective_n(shares) / len(names),
                    }
                )
                for name, weight, share in zip(names, weights, shares):
                    contribution_rows.append(
                        {
                            "date": date,
                            "scheme": scheme,
                            "basis": basis,
                            "asset": name,
                            "weight": float(weight),
                            "risk_share": float(share),
                        }
                    )

    windows = _frame(window_rows, _WINDOW_COLUMNS)
    contributions = _frame(contribution_rows, _CONTRIBUTION_COLUMNS)
    return RiskContributionTest(
        horizon=horizon,
        n_windows=int(windows["date"].nunique()) if len(windows) else 0,
        n_skipped=skipped,
        assets=assets,
        windows=windows,
        contributions=contributions,
        paired=_paired(windows),
    )


# -- small arithmetic ---------------------------------------------------


_WINDOW_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "scheme": "str",
    "basis": "str",
    "n_assets": "int64",
    "dispersion_std": "float64",
    "dispersion_range": "float64",
    "effective_n": "float64",
    "effective_share": "float64",
}

_CONTRIBUTION_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "scheme": "str",
    "basis": "str",
    "asset": "str",
    "weight": "float64",
    "risk_share": "float64",
}

_PAIRED_COLUMNS: dict[str, str] = {
    "basis": "str",
    "n_windows": "float64",
    "wins": "float64",
    "win_rate": "float64",
    "mean_n_assets": "float64",
    "mean_dispersion_equal": "float64",
    "mean_dispersion_inverse_vol": "float64",
    "mean_dispersion_reduction": "float64",
    "mean_effective_n_equal": "float64",
    "mean_effective_n_inverse_vol": "float64",
}


def _frame(rows: list[dict[str, Any]], cols: dict[str, str]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
    return pd.DataFrame(rows)[list(cols)].astype(cols)


def _shares(contribution: np.ndarray) -> np.ndarray | None:
    """Risk contributions as shares of the total, or None if there is no
    total to take shares of."""
    total = float(contribution.sum())
    if not np.isfinite(total) or abs(total) <= 0.0:
        return None
    return contribution / total


def _effective_n(shares: np.ndarray) -> float:
    """Inverse Herfindahl of the risk shares.

    Reads as "the number of sleeves this book's risk is really spread
    across": n when every sleeve contributes equally, 1 when one sleeve
    is the whole of it. A correlation-aware share can be negative for a
    genuine hedge, which pushes this above n; that is a real property of
    a hedged book rather than a defect, and it is the reason the range
    column travels alongside.
    """
    denom = float((shares**2).sum())
    return float("nan") if denom <= 0.0 else 1.0 / denom


def _paired(windows: pd.DataFrame) -> pd.DataFrame:
    """One row per basis, both schemes measured on the same windows.

    The paired comparison is the statement worth arguing over. A mean
    of dispersions across windows holding different numbers of sleeves
    mixes two effects; a win rate over matched windows does not.
    """
    if not len(windows):
        return _frame([], _PAIRED_COLUMNS)

    rows: list[dict[str, Any]] = []
    for basis, block in windows.groupby("basis", sort=True):
        wide = block.pivot(index="date", columns="scheme")
        if ("dispersion_std", "equal") not in wide.columns:
            continue
        if ("dispersion_std", "inverse_vol") not in wide.columns:
            continue
        eq = wide[("dispersion_std", "equal")]
        iv = wide[("dispersion_std", "inverse_vol")]
        both = eq.notna() & iv.notna()
        eq, iv = eq[both], iv[both]
        if not len(eq):
            continue
        rows.append(
            {
                "basis": str(basis),
                "n_windows": float(len(eq)),
                "wins": float((iv < eq).sum()),
                "win_rate": float((iv < eq).mean()),
                "mean_n_assets": float(
                    wide[("n_assets", "equal")][both].mean()
                ),
                "mean_dispersion_equal": float(eq.mean()),
                "mean_dispersion_inverse_vol": float(iv.mean()),
                "mean_dispersion_reduction": float((eq - iv).mean()),
                "mean_effective_n_equal": float(
                    wide[("effective_n", "equal")][both].mean()
                ),
                "mean_effective_n_inverse_vol": float(
                    wide[("effective_n", "inverse_vol")][both].mean()
                ),
            }
        )
    return _frame(rows, _PAIRED_COLUMNS)


def _check_windows(short: int, long: int, weight: float) -> None:
    if short < 2 or long < 2:
        raise SignalError(
            f"windows must hold at least two returns, got short={short}, "
            f"long={long}"
        )
    if short > long:
        raise SignalError(
            f"short window {short} exceeds long window {long}. The blend "
            "is a statement about a decay kernel — recent observations "
            "counting for more — and that reading only survives while "
            "the short window is the shorter one."
        )
    if not 0.0 <= weight <= 1.0:
        raise SignalError(
            f"short_weight {weight} is outside [0, 1]; a negative weight "
            "on one window subtracts variance from the other and can "
            "produce a negative variance"
        )


def _validated(close_adj: pd.DataFrame) -> pd.DataFrame:
    """The panel, as float64, or a loud refusal.

    Each of these is a specific way a volatility estimate goes quietly
    wrong rather than a style preference. An unsorted index reverses
    half the returns and leaves the volatility almost unchanged, so
    nothing downstream ever notices. A duplicated date puts one session
    into a window twice. A non-positive close divides by zero in
    `pct_change` and produces an infinite return that a rolling
    variance turns into a NaN somewhere else entirely.
    """
    if not isinstance(close_adj, pd.DataFrame):
        raise SignalError(
            f"expected a wide close_adj panel, got {type(close_adj)!r}"
        )
    if not len(close_adj.columns):
        raise SignalError("close_adj panel has no sleeves in it")
    if not isinstance(close_adj.index, pd.DatetimeIndex):
        raise SignalError(
            "close_adj must be indexed by date; a positional index makes "
            "every diagnostic below print row numbers where a reader "
            "expects sessions"
        )
    if not close_adj.index.is_monotonic_increasing:
        raise SignalError(
            "close_adj index is not sorted ascending. A reversed stretch "
            "flips the sign of its returns and leaves the volatility "
            "almost unchanged, so nothing downstream would notice."
        )
    if close_adj.index.has_duplicates:
        n = int(close_adj.index.duplicated().sum())
        raise SignalError(f"close_adj index has {n:,} duplicate session(s)")

    out = close_adj.astype("float64")
    values = out.to_numpy(dtype="float64")
    if np.isinf(values).any():
        raise SignalError("close_adj contains an infinite price")
    finite = np.isfinite(values)
    if (values[finite] <= 0.0).any():
        raise SignalError(
            "close_adj contains a non-positive price. A zero close is a "
            "dead instrument or a data hole; either way the return into "
            "and out of it is not a number, and it must be a gap rather "
            "than a bar."
        )
    return out
