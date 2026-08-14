"""Two sleeves that move together are one bet held twice.

This file turns a correlation matrix of sleeve total returns into a
per-sleeve HAIRCUT: a multiplier in [0.5, 1.0] that a proposed weight
is multiplied by, so a sleeve heavily correlated with the rest of the
book ends up holding less of it. Nothing here proposes a weight, and
nothing here can raise one.

The economic case is not that US equity and developed international
look alike on a scatter plot. It is that the pair which matters is the
one that CONVERGES — correlations rise toward one exactly when the
diversification is being relied upon, so an allocator that treated a
correlated pair as two independent positions discovers it was more
concentrated than it believed during the drawdown, which is the single
worst moment to find out. A book of nine sleeves whose first principal
component carries 80% of its variance is a one-sleeve book with extra
tickets.

Three traps this file exists to avoid.

**The raw sample matrix.** Nine sleeves have thirty-six free
off-diagonal correlations. Estimated over the engine's 63-session
volatility window, each one carries a sampling error of roughly
1/sqrt(60) = 0.13, which is a fifth of the entire 0.30-to-0.90 ramp the
haircut is defined over — the adjustment would be mostly noise, and a
noisy adjustment is not merely useless, it is expensive: this book has
a five-per-cent-of-NAV daily turnover budget, and a matrix that jumps
spends that budget re-trading estimation error instead of moving the
exposures the sleeves exist to move. So the window is longer, and what
comes out of it is shrunk.

**The optimiser.** The obvious thing to do with a covariance matrix is
invert it, and the inverse is where an error-maximising machine lives:
mean-variance loads onto whichever pair the sample happened to show as
most negatively correlated, which is whichever pair the estimation
error most flattered. Nothing in this module inverts anything. The
adjustment is a weighted average of correlations and a linear ramp,
both of which a reader can recompute by hand off the printed matrix,
and that auditability is the feature rather than a consolation for not
optimising.

**The price series.** Every return here is computed from `close_adj`
and never from `close_unadj`, and the reason is sharper for a
correlation than for a return. On the unadjusted series a distribution
is a genuine negative price shock on the ex-date — monthly, for the
bond and credit sleeves, where nearly all the return is coupon in the
first place. Those shocks are idiosyncratic: they land on different
days for different sleeves and are shared with nothing. Adding
idiosyncratic variance to two series ATTENUATES their measured
correlation toward zero, so a correlation signal fed unadjusted prices
systematically reports the book as more diversified than it is, which
is precisely the error this file was written to prevent.

**The parameters, and when they were fixed.** There are four:
`LOOKBACK`, `RHO_FREE`, `RHO_FULL`, `MAX_HAIRCUT`. Each is round, each
is argued below from a prior rather than from a result, and all four
were written down before this module had ever seen a price — the free
price endpoint is dark and the cache is cold, so there is no
performance number here that any of them could have been chosen
against. That is the best moment to commit, and this paragraph is the
commitment. The shrinkage intensity is not on the list because it is
not a choice: it is computed from the data by Ledoit and Wolf's
formula. Changing any of the four is a new configuration and owes
`metrics.TrialCounter` a row the first time it is backtested; running
`evaluate` is not a trial, because it produces no performance number
to select on.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ..engine import metrics
from ..portfolio.sleeves import CASH_SLEEVE_KEY, SLEEVE_BY_KEY

__all__ = [
    "Concentration",
    "CorrelationAdjustment",
    "CorrelationError",
    "CorrelationEstimate",
    "EvaluationReport",
    "LOOKBACK",
    "MAX_HAIRCUT",
    "RHO_FREE",
    "RHO_FULL",
    "adjust_weights",
    "adjustment_history",
    "book_correlation",
    "concentration",
    "estimate_correlation",
    "evaluate",
    "haircut_for",
]


class CorrelationError(ValueError):
    """An input to the correlation signal is malformed."""


#: One trading year, and deliberately four times the engine's 63-session
#: volatility window (`MarketData.from_prices`). Three reasons, none of
#: them a result.
#:
#: A correlation matrix estimates O(k^2) numbers where a volatility
#: vector estimates O(k) — thirty-six against nine at k = 9 — out of the
#: same tape, so the same window buys far fewer observations per
#: parameter. The sampling error on a single correlation is about
#: 1/sqrt(N-3): 0.13 at 63 sessions against 0.063 at 252. The first of
#: those is a fifth of the whole ramp this signal is defined over and
#: would produce an adjustment that churns the book for no reason.
#:
#: And the two quantities move differently. Volatility genuinely does
#: change fast, so a short window is tracking something real.
#: Correlation is slow except in crises, so a short window mostly
#: tracks its own error.
#:
#: Why not 504. Correlations rise in a crisis and that is the one moment
#: this adjustment has to act; a two-year window in March 2020 is
#: seven-eighths pre-crisis tape and the estimate would arrive in 2021.
#: 252 is already slow — a month of crisis enters at one-twelfth weight,
#: and the shrinkage below slows it further. That is the accepted cost
#: of not de-risking on every three-day scare. The exponentially
#: weighted alternative is refused on principle: its half-life is a free
#: parameter, and a decay chosen by looking at a drawdown is fitted.
LOOKBACK: int = 252

#: Below this a sleeve pays nothing. Two series at 0.30 share nine per
#: cent of their variance, which is not a duplicated bet under any
#: reading.
#:
#: Worth knowing what this implies, because it is a property and not a
#: defect. The quantity compared against it is a BOOK-WEIGHTED MEAN
#: correlation, and in a book carrying a working hedge the mean nets:
#: a US equity sleeve sitting 0.90 with developed international and
#: -0.14 with intermediate Treasuries can average out below 0.30 and
#: pay nothing. That is the correct answer — a bet with an offset
#: beside it is not a duplicated bet — and it means this signal is
#: designed to be quiet in a calm, hedged regime and to act in the two
#: cases that matter: a book loaded into one cluster with no offset,
#: and a regime like 2022 where the offset stops offsetting.
RHO_FREE: float = 0.30

#: At this the sleeve is charged in full. Two series at 0.90 share
#: eighty-one per cent of their variance — SPY and EFA in a crisis live
#: here. The top of the ramp is 0.90 rather than 1.00 because a ramp
#: that tops out only at a correlation of exactly one has a maximum
#: nothing ever reaches, and the full haircut would then be decorative.
RHO_FULL: float = 0.90

#: The most weight this may ever remove. It is a diversification
#: overlay, not the allocator: a rule that can take a sleeve to zero on
#: a correlation estimate HAS become the allocation decision, and even a
#: correlation of 1.00 between two sleeves is not an argument for
#: holding neither, only for holding less of each. Halving is a real cut
#: with a bounded blast radius, and it leaves the residual recognisably
#: the allocator's number.
MAX_HAIRCUT: float = 0.50

#: The cash sleeve, under both spellings the panel may use. Excluded
#: from the matrix by name, for two reasons that agree. Its weight is
#: not a bet — it is the residual absorber, and haircutting cash means
#: haircutting the only place a haircut can send weight. And a
#: T-bill series has almost no variation, so its correlation with
#: anything is a ratio of two small numbers and numerically worthless.
_CASH_KEYS: frozenset[str] = frozenset(
    {CASH_SLEEVE_KEY, SLEEVE_BY_KEY[CASH_SLEEVE_KEY].ticker}
)

#: Floor-sweeping tolerance. Anything smaller is float residue from a
#: matrix product, not a correlation above one or a negative eigenvalue.
_EPS = 1e-12


# -- the estimate -------------------------------------------------------


@dataclass(frozen=True)
class CorrelationEstimate:
    """One shrunk correlation matrix, as of one close.

    `sample_correlation` travels with the shrunk one on purpose. The
    shrinkage is the whole methodological claim of this file, and a
    reader who cannot see what was shrunk away has been asked to take
    it on faith. Off the diagonal the two are related by exactly
    `shrunk = (1 - shrinkage) * sample + shrinkage * average`, which
    is checkable by hand on any pair.

    `excluded` maps every sleeve that did not make the matrix to the
    sentence saying why. A sleeve with too little history is left out
    rather than filled in, and it is left out LOUDLY: an empty
    exclusion dict and a nine-sleeve matrix are different facts from a
    seven-sleeve matrix and two named reasons, and only the second one
    tells a reader that two sleeves in the book went unmeasured.
    """

    asof: pd.Timestamp
    sleeves: tuple[str, ...]
    excluded: dict[str, str]
    correlation: pd.DataFrame
    sample_correlation: pd.DataFrame
    shrinkage: float
    average_correlation: float
    n_observations: int
    lookback: int

    @property
    def measurable(self) -> bool:
        """Is there a correlation here at all?

        Two sleeves is the floor. With one there is nothing to be
        correlated with, and the honest answer to "how concentrated is
        this book" is that we cannot say — not that it is perfectly
        diversified, which is what a silent zero haircut would imply.
        """
        return len(self.sleeves) >= 2


# -- the adjustment -----------------------------------------------------


@dataclass(frozen=True)
class CorrelationAdjustment:
    """What each sleeve was cut, and the arithmetic that cut it.

    `adjusted` is elementwise no greater than `proposed`, for every key
    including the ones that were never measured, and there is no input
    for which that is not true. The rule is stronger than it looks: an
    adjustment permitted to raise a weight would be making an
    allocation decision on the strength of a correlation estimate, and
    it would do so through a channel nobody audits, which is how a risk
    control quietly becomes a return signal.

    `freed_to_cash` is reported and NOT written anywhere. With no
    leverage the weight a haircut releases can only become cash, and
    the engine already defines the residual as cash without being told
    — so the alternative is a function that increases one weight and
    has to be trusted about which one. If a caller's proposed book
    carried an explicit cash line, the sum simply falls short and the
    engine reads the shortfall as more cash: the same answer, arrived
    at by the layer that owns it.
    """

    estimate: CorrelationEstimate
    proposed: pd.Series
    book_correlation: pd.Series
    haircut: pd.Series
    multiplier: pd.Series
    adjusted: pd.Series
    top_partner: pd.Series
    top_correlation: pd.Series

    @property
    def freed_to_cash(self) -> float:
        return float((self.proposed - self.adjusted).sum())

    def explain(self) -> pd.DataFrame:
        """One row per sleeve: what it was cut and against whom.

        The last two columns are why this is a table and not a vector.
        A reader is entitled to a sentence — "developed international
        lost a third of its weight because its book-weighted
        correlation is 0.71 and it is 0.88 correlated with US equity" —
        and a per-sleeve number alone cannot supply the second half of
        that.
        """
        keys = list(self.proposed.index)
        cols: dict[str, pd.Series] = {
            "sleeve": pd.Series(keys, dtype="str"),
            "proposed_weight": self.proposed.reindex(keys).astype("float64"),
            "book_correlation": self.book_correlation.reindex(keys).astype("float64"),
            "haircut": self.haircut.reindex(keys).astype("float64"),
            "multiplier": self.multiplier.reindex(keys).astype("float64"),
            "adjusted_weight": self.adjusted.reindex(keys).astype("float64"),
            "top_partner": self.top_partner.reindex(keys).astype("str"),
            "top_correlation": self.top_correlation.reindex(keys).astype("float64"),
        }
        frame = pd.DataFrame({k: v.to_numpy() for k, v in cols.items()})
        frame["excluded_because"] = pd.Series(
            [self.estimate.excluded.get(k, "") for k in keys], dtype="str"
        )
        return frame


@dataclass(frozen=True)
class Concentration:
    """How many independent bets a book is really carrying.

    Both figures come from one eigen-decomposition of the weighted
    correlation matrix, in the sense of Meucci (2009), "Managing
    Diversification", Risk 22(5), 74-79. Write R = E L E'; the
    portfolio's variance splits across the principal portfolios as
    p_i = (e_i'w)^2 l_i / (w'Rw), which sums to one by construction.

    `effective_bets` is exp of the entropy of that split: k when the
    sleeves are independent and equally weighted, 1 when the book is
    one bet however many tickets it holds.
    `largest_eigenvalue_share` is max(p) — the share of the book's
    variance riding on its single largest principal component, which is
    the blunter of the two and the harder to argue with.

    Both are SCALE-INVARIANT in the weights, which is the property that
    makes them the right test here: halving every sleeve leaves them
    untouched, so a uniform haircut correctly registers as no change in
    the mix. They improve only when the haircut is differential. That
    also means they cannot see the de-risking a uniform haircut
    performs, which is why `evaluate` reports invested weight beside
    them rather than instead of them.
    """

    effective_bets: float
    largest_eigenvalue_share: float
    n_sleeves: int


# -- returns ------------------------------------------------------------


def sleeve_returns(close_adj: pd.DataFrame) -> pd.DataFrame:
    """Simple daily total returns. The argument name is the contract.

    Written as `x / x.shift(1) - 1` rather than `pct_change()` because
    that method's fill behaviour has changed across pandas versions,
    and the version that forward-fills would invent a zero return
    across a missing bar — which then passes the completeness test
    below and puts a sleeve in the matrix on the strength of a hole.
    """
    frame = _as_panel(close_adj)
    positive = frame.where(frame > 0.0)
    return positive / positive.shift(1) - 1.0


def _as_panel(close_adj: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(close_adj, pd.DataFrame):
        raise CorrelationError(
            f"expected a DataFrame of closes, got {type(close_adj)!r}"
        )
    if not isinstance(close_adj.index, pd.DatetimeIndex):
        raise CorrelationError("close_adj must be indexed by date")
    idx = pd.DatetimeIndex(close_adj.index)
    if not idx.is_monotonic_increasing:
        raise CorrelationError("close_adj must be sorted ascending")
    if idx.has_duplicates:
        n = int(idx.duplicated().sum())
        raise CorrelationError(f"close_adj has {n:,} duplicate session(s)")
    out = close_adj.astype("float64")
    out.columns = [str(c) for c in close_adj.columns]
    return out


def _window(
    close_adj: pd.DataFrame,
    asof: pd.Timestamp | str | None,
    lookback: int,
) -> tuple[pd.DataFrame, pd.Timestamp]:
    """The `lookback` returns ending at the close of `asof`.

    This is the one seam in the module where a lookahead could live, so
    it is the only place allowed to cut a frame. Everything downstream
    receives a window and has no handle back to the panel — the same
    device `MarketView` uses, for the same reason: a leak has to be
    writable before it can be written.

    `lookback + 1` closes yield `lookback` returns. Asking for the
    returns first and slicing them afterwards would be a session
    cheaper and read the same; it is not done that way because it
    would touch the whole panel on every call, and the cost of that
    over a twenty-year walk is measured in minutes.
    """
    panel = _as_panel(close_adj)
    _check_lookback(lookback)

    if asof is None:
        cut = panel
    else:
        stamp = pd.Timestamp(asof)
        cut = panel.loc[:stamp]
        if len(cut) == 0:
            raise CorrelationError(
                f"no sessions on or before {stamp.date()}; the panel starts "
                f"{panel.index[0].date() if len(panel) else 'nowhere'}"
            )
    if len(cut) == 0:
        raise CorrelationError("close_adj has no rows")

    tail = cut.tail(lookback + 1)
    positive = tail.where(tail > 0.0)
    returns = (positive / positive.shift(1) - 1.0).iloc[1:]
    return returns, pd.Timestamp(cut.index[-1])


def _check_lookback(lookback: int) -> int:
    """One message for one mistake, wherever it is made.

    Stated in a function rather than twice inline because the two
    callers validate in different orders, and a user who passed
    `lookback=1` must be told about the lookback rather than about the
    observation floor it happened to drag under with it.
    """
    if int(lookback) < 2:
        raise CorrelationError(f"lookback must be at least 2 sessions, got {lookback}")
    return int(lookback)


def _eligible(
    returns: pd.DataFrame,
    lookback: int,
    min_observations: int,
) -> tuple[list[str], dict[str, str]]:
    """Split the panel into what can be measured and what cannot.

    Three ways out, all of them exclusions rather than fills. A short
    history is the DBC and BIL case and it is real: those sleeves did
    not exist yet, and a correlation computed off forty sessions and
    labelled a one-year correlation is a different statistic wearing
    the same name.

    A hole in the middle is the subtler one. Requiring a COMPLETE
    column, rather than letting each pair use whatever overlap it has,
    is what keeps the matrix a genuine Gram matrix: pairwise-complete
    correlation over ragged columns is the standard way to end up with
    a symmetric matrix that is not positive semi-definite, and the
    eigen-decomposition downstream would then report a negative
    variance.

    And a column with no variation at all has no correlation with
    anything; the ratio is 0/0 and every answer it could return is a
    fiction.
    """
    keep: list[str] = []
    excluded: dict[str, str] = {}
    n_rows = int(len(returns))

    for col in returns.columns:
        if col in _CASH_KEYS:
            excluded[col] = (
                "cash sleeve — the residual absorber, not a bet, and its "
                "correlation with anything is a ratio of two small numbers"
            )
            continue
        series = returns[col]
        good = int(series.notna().sum())
        if good < min_observations or n_rows < min_observations:
            excluded[col] = (
                f"{good} of {min_observations} required returns in the "
                f"{lookback}-session window"
            )
            continue
        if float(series.std(ddof=1)) <= 0.0:
            excluded[col] = "no variation in the window; correlation undefined"
            continue
        keep.append(col)

    return keep, excluded


# -- Ledoit-Wolf shrinkage ----------------------------------------------
#
# Ledoit, O. and Wolf, M. (2004), "Honey, I Shrunk the Sample
# Covariance Matrix", Journal of Portfolio Management 30(4), 110-119,
# with the constant-correlation target of their 2003 paper.
#
# The argument for shrinking is a prior about ESTIMATION ERROR and not
# a view about markets. The sample matrix is unbiased and extremely
# noisy; the constant-correlation target is badly biased and carries
# almost no error at all, being one number estimated off every pair at
# once. Somewhere between the two sits an estimator with lower expected
# squared error than either, and the whole content of the method is
# that the crossing point can be computed rather than guessed. That is
# also why nothing here is tunable: the intensity is a function of the
# data, so there is no dial to turn while watching an equity curve.
#
# One consequence worth stating because it makes the result readable.
# The target's diagonal is the sample variance exactly, so the shrunk
# covariance has the sample's variances and the shrunk correlation is
# a plain convex combination:
#
#     R_shrunk[i,j] = (1 - d) * R_sample[i,j] + d * rBar,  i != j
#
# which any reader can check on any pair with the three numbers this
# module already prints.


def _shrink(x: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Shrunk correlation matrix, the intensity, and the target.

    `x` is (T, k) of returns with no missing values. Returns the
    correlation matrix, the shrinkage intensity in [0, 1], and the
    average sample correlation the target was built from.
    """
    t, n = x.shape
    if n < 2:
        raise CorrelationError("shrinkage needs at least two series")
    if t < 3:
        raise CorrelationError(f"shrinkage needs at least three observations, got {t}")

    x = x - x.mean(axis=0)
    # 1/T rather than 1/(T-1), because the asymptotics the intensity is
    # derived under are written against the maximum-likelihood
    # estimator. At T = 252 the difference is four-tenths of a per cent
    # and it cancels out of the correlation entirely; using the wrong
    # one would still be wrong in the intensity.
    sample = x.T @ x / t
    var = np.diag(sample).copy()
    if not np.all(var > 0.0):
        raise CorrelationError("a series with zero variance reached the shrinkage")
    sqrtvar = np.sqrt(var)
    outer = np.outer(sqrtvar, sqrtvar)

    sample_corr = sample / outer
    r_bar = float((sample_corr.sum() - n) / (n * (n - 1)))

    prior = r_bar * outer
    np.fill_diagonal(prior, var)

    # pi-hat: the summed asymptotic variances of the sample entries.
    y = x**2
    phi_mat = y.T @ y / t - sample**2
    phi = float(phi_mat.sum())

    # rho-hat: the covariance between the sample entries and the
    # target's, which is what stops the method double-counting the
    # error the two estimators share.
    theta = (x**3).T @ x / t - var[:, None] * sample
    np.fill_diagonal(theta, 0.0)
    scale = sqrtvar[None, :] / sqrtvar[:, None]
    rho = float(np.trace(phi_mat) + r_bar * float((scale * theta).sum()))

    # gamma-hat: how far apart the two estimators are in the first
    # place. Zero means they already agree and the intensity cannot
    # matter — reported as full shrinkage rather than as a division by
    # zero, since both endpoints give the identical matrix.
    gamma = float(((prior - sample) ** 2).sum())
    if gamma <= _EPS:
        delta = 1.0
    else:
        delta = float(max(0.0, min(1.0, (phi - rho) / gamma / t)))

    shrunk = delta * prior + (1.0 - delta) * sample
    corr = shrunk / np.outer(np.sqrt(np.diag(shrunk)), np.sqrt(np.diag(shrunk)))
    return _tidy(corr), delta, r_bar


def _tidy(corr: np.ndarray) -> np.ndarray:
    """Symmetrise, unit the diagonal, clip to [-1, 1].

    Floor-sweeping and not a fix. Every one of these three is true of
    the matrix by construction and false of the matrix by a few
    ulps after two matrix products; leaving the residue in would put a
    1.0000000000000002 into a table and an imaginary number into a
    square root somewhere downstream.
    """
    out = (corr + corr.T) / 2.0
    np.clip(out, -1.0, 1.0, out=out)
    np.fill_diagonal(out, 1.0)
    return out


def estimate_correlation(
    close_adj: pd.DataFrame,
    *,
    asof: pd.Timestamp | str | None = None,
    lookback: int = LOOKBACK,
    min_observations: int | None = None,
) -> CorrelationEstimate:
    """The shrunk correlation matrix as of the close of `asof`.

    `min_observations` defaults to the full lookback. A sleeve short of
    it is excluded and named, never filled — see `_eligible`.
    """
    _check_lookback(lookback)
    need = int(lookback if min_observations is None else min_observations)
    if need < 3:
        raise CorrelationError(
            f"min_observations must be at least 3, got {need}; a correlation "
            "off two points is a line through two points"
        )
    if need > lookback:
        raise CorrelationError(
            f"min_observations {need} exceeds the {lookback}-session window, "
            "which can never be satisfied"
        )

    returns, stamp = _window(close_adj, asof, lookback)
    keep, excluded = _eligible(returns, lookback, need)

    if len(keep) < 2:
        empty = pd.DataFrame(
            np.zeros((len(keep), len(keep))), index=keep, columns=keep, dtype="float64"
        )
        if len(keep) == 1:
            empty.iloc[0, 0] = 1.0
        return CorrelationEstimate(
            asof=stamp,
            sleeves=tuple(keep),
            excluded=excluded,
            correlation=empty,
            sample_correlation=empty.copy(),
            shrinkage=float("nan"),
            average_correlation=float("nan"),
            n_observations=int(len(returns)),
            lookback=int(lookback),
        )

    block = returns.loc[:, keep].dropna(axis=0, how="any")
    x = block.to_numpy(dtype="float64")
    corr, delta, r_bar = _shrink(x)

    raw = np.corrcoef(x, rowvar=False)
    return CorrelationEstimate(
        asof=stamp,
        sleeves=tuple(keep),
        excluded=excluded,
        correlation=pd.DataFrame(corr, index=keep, columns=keep, dtype="float64"),
        sample_correlation=pd.DataFrame(
            _tidy(np.asarray(raw, dtype="float64")),
            index=keep,
            columns=keep,
            dtype="float64",
        ),
        shrinkage=float(delta),
        average_correlation=float(r_bar),
        n_observations=int(len(block)),
        lookback=int(lookback),
    )


# -- matrix to haircut --------------------------------------------------


def book_correlation(
    correlation: pd.DataFrame, weights: Mapping[str, float] | pd.Series
) -> pd.Series:
    """Each sleeve's weight-weighted mean correlation with the others.

        rho_i = sum_{j != i} w_j rho_ij / sum_{j != i} w_j

    Weighted by what the book actually proposes to hold, because "is
    this sleeve a duplicate of the rest of the book" is a question
    about the book and not about a list of tickers. A sleeve 0.95
    correlated with something held at one per cent is not a
    concentration problem.

    The mean is SIGNED and not absolute, deliberately. A sleeve that
    moves against the book is the diversifier the book wants, and an
    absolute value would charge it for that. It does mean a sleeve
    tracking half the book and hedging the other half nets out to a
    modest number — which is accepted, because netting is exactly what
    the book experiences: a position's contribution to portfolio
    variance is the signed sum of its covariances, not the sum of
    their magnitudes.

    What this deliberately is NOT is the true correlation between the
    sleeve and the rest-of-book portfolio, which would divide by that
    portfolio's own volatility. Take four mutually independent sleeves
    and a fifth correlated 0.30 with each: the true figure is 0.60,
    because being a third of the way toward four unrelated things is
    most of the way toward their average. That is arithmetically
    correct and it is the wrong question — it penalises a sleeve for
    the diversification happening elsewhere in the book, and it cannot
    be read off the printed matrix. The pairwise mean can.
    """
    if correlation.empty:
        return pd.Series(dtype="float64")
    w = _as_weights(weights).reindex(correlation.columns).fillna(0.0)
    keys = list(correlation.columns)
    values = correlation.to_numpy(dtype="float64")
    wv = w.to_numpy(dtype="float64")

    out = np.full(len(keys), np.nan)
    for i in range(len(keys)):
        others = np.ones(len(keys), dtype=bool)
        others[i] = False
        denom = float(wv[others].sum())
        if denom <= 0.0:
            # No rest-of-book to be correlated with. Left as NaN and
            # charged nothing, because the honest answer is that the
            # question does not arise — not that the answer is zero.
            continue
        out[i] = float((wv[others] * values[i, others]).sum() / denom)
    return pd.Series(out, index=keys, dtype="float64")


def haircut_for(rho: float) -> float:
    """The ramp: nothing below RHO_FREE, everything above RHO_FULL.

    Linear in between, so the whole rule is one sentence a reader can
    apply by hand — "half a weight, scaled by how far this sleeve's
    book correlation sits between 0.30 and 0.90" — and one line anyone
    can check against the printed `book_correlation`.
    """
    if not math.isfinite(rho):
        return 0.0
    reach = (float(rho) - RHO_FREE) / (RHO_FULL - RHO_FREE)
    return MAX_HAIRCUT * min(max(reach, 0.0), 1.0)


def _as_weights(weights: Mapping[str, float] | pd.Series) -> pd.Series:
    if isinstance(weights, pd.Series):
        items = {str(k): float(v) for k, v in weights.items()}
    elif isinstance(weights, Mapping):
        items = {str(k): float(v) for k, v in weights.items()}
    else:
        raise CorrelationError(f"expected a mapping of weights, got {type(weights)!r}")
    for key, value in items.items():
        if not math.isfinite(value):
            raise CorrelationError(f"weight on {key!r} is {value!r}")
        if value < 0.0:
            raise CorrelationError(
                f"weight {value:.6f} on {key!r} is negative. This is a "
                "long-only book, and a haircut on a short is not a "
                "question this module has an answer to."
            )
    return pd.Series(items, dtype="float64")


def adjust_weights(
    proposed: Mapping[str, float] | pd.Series,
    close_adj: pd.DataFrame,
    *,
    asof: pd.Timestamp | str | None = None,
    lookback: int = LOOKBACK,
    min_observations: int | None = None,
    estimate: CorrelationEstimate | None = None,
) -> CorrelationAdjustment:
    """Cut every sleeve by how much of the book it already is.

    One pass, never iterated to a fixed point. Haircutting changes the
    weights, which changes each sleeve's book correlation, which would
    change the haircut — and chasing that is a small optimisation that
    stops being explainable after the second round. One pass answers
    the question that was actually asked, which is how concentrated the
    book the allocator proposed happens to be.

    A sleeve outside the matrix — cash, too short a history, no
    variation — passes through untouched with a multiplier of exactly
    1.0. That is the less conservative of the two available errors and
    it is chosen knowingly: the alternative is charging a haircut to a
    sleeve we have no evidence about, and an adjustment that fires on
    absent data is worse than one that abstains. The abstention is
    bounded, because the sleeve caps still bind and this function can
    never raise a weight.

    **What this rule cannot see, stated because `evaluate` finds it.**
    Each sleeve is cut on its own book correlation and nothing looks at
    what is left standing. Where the book carries two clusters that
    HEDGE each other — equity against duration — the proposed weights
    may already sit near the most balanced point available, and cutting
    the larger cluster moves the residual away from that balance and
    into the smaller one. The effective number of bets then falls even
    though the book got smaller and safer, and the diagnostic prints
    exactly that on a crisis window of the test panel. Two things are
    true at once and both belong in any write-up: the concentration
    measures are scale-invariant and so cannot see the de-risking at
    all, and the one-pass rule really does tilt what remains. The
    remedy for the second is an iteration to a fixed point or an
    optimiser over the residual, and the reasons both were refused
    have not changed — an unauditable cut is worse than a cut that is
    sometimes in the wrong direction by a measure that is admittedly
    blind to half of what it did.
    """
    w = _as_weights(proposed)
    est = estimate or estimate_correlation(
        close_adj, asof=asof, lookback=lookback, min_observations=min_observations
    )

    rho = book_correlation(est.correlation, w).reindex(w.index)
    haircut = pd.Series(
        [haircut_for(float(v)) for v in rho.to_numpy()], index=w.index, dtype="float64"
    )
    multiplier = 1.0 - haircut
    adjusted = w * multiplier

    partner, partner_rho = _top_partner(est.correlation, w)

    # The invariant, asserted rather than trusted. Every claim this
    # module makes about safety reduces to this line, and a future
    # edit that breaks it must not be able to do so quietly.
    assert bool((adjusted <= w + _EPS).all()), "an adjustment raised a weight"
    assert bool(
        ((multiplier >= 1.0 - MAX_HAIRCUT - _EPS) & (multiplier <= 1.0 + _EPS)).all()
    ), "a multiplier escaped [1 - MAX_HAIRCUT, 1]"

    return CorrelationAdjustment(
        estimate=est,
        proposed=w,
        book_correlation=rho,
        haircut=haircut,
        multiplier=multiplier,
        adjusted=adjusted,
        top_partner=partner.reindex(w.index).fillna(""),
        top_correlation=partner_rho.reindex(w.index),
    )


def _top_partner(
    correlation: pd.DataFrame, weights: pd.Series
) -> tuple[pd.Series, pd.Series]:
    """The held sleeve each sleeve is most correlated with.

    The audit trail's other half. A book correlation of 0.71 says a
    sleeve is crowded; it does not say by whom, and "by whom" is the
    part a person can act on.
    """
    if correlation.empty:
        return pd.Series(dtype="str"), pd.Series(dtype="float64")
    keys = list(correlation.columns)
    w = weights.reindex(keys).fillna(0.0).to_numpy(dtype="float64")
    values = correlation.to_numpy(dtype="float64")

    names: list[Any] = []
    rhos: list[float] = []
    for i in range(len(keys)):
        candidates = [j for j in range(len(keys)) if j != i and w[j] > 0.0]
        if not candidates:
            names.append("")
            rhos.append(float("nan"))
            continue
        best = max(candidates, key=lambda j: values[i, j])
        names.append(keys[best])
        rhos.append(float(values[i, best]))
    return (
        pd.Series(names, index=keys, dtype="str"),
        pd.Series(rhos, index=keys, dtype="float64"),
    )


# -- concentration ------------------------------------------------------


def concentration(
    weights: Mapping[str, float] | pd.Series, correlation: pd.DataFrame
) -> Concentration:
    """Effective bets and largest-component share for one book.

    Weights are aligned to the matrix and anything absent counts as
    zero: a sleeve with no correlation estimate cannot enter a
    concentration measure, and pretending it is independent would let
    an unmeasured sleeve improve the number it was never measured for.
    """
    if correlation.empty or len(correlation.columns) == 0:
        return Concentration(float("nan"), float("nan"), 0)

    w = _as_weights(weights).reindex(correlation.columns).fillna(0.0)
    wv = w.to_numpy(dtype="float64")
    if not np.any(wv > 0.0):
        return Concentration(float("nan"), float("nan"), 0)

    r = _tidy(correlation.to_numpy(dtype="float64"))
    lam, vec = np.linalg.eigh(r)
    # A sample correlation matrix on complete rows is PSD, so a
    # negative eigenvalue here is float residue and nothing else.
    # Clipping it to zero is honest; leaving it in would put a negative
    # variance share into an entropy.
    lam = np.clip(lam, 0.0, None)

    loadings = vec.T @ wv
    share = (loadings**2) * lam
    total = float(share.sum())
    if total <= _EPS:
        return Concentration(float("nan"), float("nan"), int((wv > 0.0).sum()))

    p = share / total
    live = p[p > _EPS]
    entropy = float(-(live * np.log(live)).sum())
    return Concentration(
        effective_bets=float(math.exp(entropy)),
        largest_eigenvalue_share=float(p.max()),
        n_sleeves=int((wv > 0.0).sum()),
    )


# -- standalone diagnostics ---------------------------------------------
#
# Everything below this line is REPORTING. It is allowed to look
# forward, because a diagnostic asking "was the adjustment right" has
# to; nothing below is importable into a signal path, and the two
# forward columns are named so that a reader who copied one into a
# strategy would have to type the word `forward` to do it.


@dataclass(frozen=True)
class EvaluationReport:
    """Whether the haircut actually bought diversification.

    `periods` carries a row per named window whether or not the sample
    covers it, on the rule `metrics.period_breakout` states: a report
    that silently drops 2008 because the data starts in 2010 has
    published a stress table with no stress in it and no sign that any
    was expected.
    """

    lookback: int
    step: int
    forward: int
    weights_note: str
    n_dates: int
    history: pd.DataFrame
    periods: pd.DataFrame

    @property
    def headline(self) -> str:
        """One sentence, and it must be able to say the answer is no.

        Written to report the direction it finds rather than the
        direction it hoped for. A diagnostic that can only print a
        success has not tested anything.
        """
        if self.n_dates == 0:
            return (
                f"No date in the sample carries a full {self.lookback}-session "
                "window; nothing was measured."
            )
        full = self.periods.iloc[0]
        before = float(full["effective_bets_before"])
        after = float(full["effective_bets_after"])
        fwd_before = float(full["forward_effective_bets_before"])
        fwd_after = float(full["forward_effective_bets_after"])
        direction = "raised" if after > before else "did not raise"
        return (
            f"{self.n_dates:,} dates, {self.lookback}-session window: the "
            f"adjustment {direction} the effective number of bets, "
            f"{before:.2f} to {after:.2f} as estimated and {fwd_before:.2f} "
            f"to {fwd_after:.2f} against the following "
            f"{self.forward} sessions' realised correlations. Mean invested "
            f"weight {float(full['invested_before']):.1%} before, "
            f"{float(full['invested_after']):.1%} after."
        )


_HISTORY_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "n_sleeves": "int64",
    "n_excluded": "int64",
    "shrinkage": "float64",
    "average_correlation": "float64",
    "mean_book_correlation": "float64",
    "max_book_correlation": "float64",
    "invested_before": "float64",
    "invested_after": "float64",
    "freed_to_cash": "float64",
    "effective_bets_before": "float64",
    "effective_bets_after": "float64",
    "largest_share_before": "float64",
    "largest_share_after": "float64",
    "forward_effective_bets_before": "float64",
    "forward_effective_bets_after": "float64",
    "forward_largest_share_before": "float64",
    "forward_largest_share_after": "float64",
}


def adjustment_history(
    close_adj: pd.DataFrame,
    *,
    weights: Mapping[str, float] | pd.Series | None = None,
    lookback: int = LOOKBACK,
    min_observations: int | None = None,
    step: int = 5,
    forward: int | None = None,
) -> pd.DataFrame:
    """Walk the sample, one row per sampled date.

    `step` is a REPORTING cadence and nothing trades on it. Consecutive
    daily estimates share 251 of their 252 observations, so a daily
    table would print five thousand nearly identical rows and invite
    them to be counted as five thousand observations. Weekly is the
    round choice that still puts about a dozen rows inside 2020Q1,
    which is the window this whole exercise is about.

    `forward` is the realised-correlation window, defaulting to the
    lookback so the two are comparable. It is the honest half of the
    test: a concentration measured on the same matrix the adjustment
    was computed from is partly a measure of the estimator, and only
    the following year's tape can say whether the sleeves the haircut
    cut were the ones that then moved together.
    """
    panel = _as_panel(close_adj)
    if step < 1:
        raise CorrelationError(f"step must be at least one session, got {step}")
    fwd = int(lookback if forward is None else forward)
    if fwd < 2:
        raise CorrelationError(f"forward window must be at least 2, got {fwd}")

    book = (
        _default_book(panel) if weights is None else _as_weights(weights)
    )

    rows: list[dict[str, Any]] = []
    n = len(panel)
    for i in range(lookback, n, step):
        asof = panel.index[i]
        adj = adjust_weights(
            book,
            panel,
            asof=asof,
            lookback=lookback,
            min_observations=min_observations,
        )
        est = adj.estimate
        before = concentration(adj.proposed, est.correlation)
        after = concentration(adj.adjusted, est.correlation)

        realised = _forward_correlation(panel, i, fwd, est.sleeves)
        if realised is None:
            f_before = Concentration(float("nan"), float("nan"), 0)
            f_after = f_before
        else:
            f_before = concentration(adj.proposed, realised)
            f_after = concentration(adj.adjusted, realised)

        rho = adj.book_correlation.reindex(list(est.sleeves))
        rows.append(
            {
                "date": asof,
                "n_sleeves": len(est.sleeves),
                "n_excluded": len(est.excluded),
                "shrinkage": est.shrinkage,
                "average_correlation": est.average_correlation,
                "mean_book_correlation": (
                    float(rho.mean()) if len(rho) else float("nan")
                ),
                "max_book_correlation": (
                    float(rho.max()) if len(rho) else float("nan")
                ),
                "invested_before": float(adj.proposed.sum()),
                "invested_after": float(adj.adjusted.sum()),
                "freed_to_cash": adj.freed_to_cash,
                "effective_bets_before": before.effective_bets,
                "effective_bets_after": after.effective_bets,
                "largest_share_before": before.largest_eigenvalue_share,
                "largest_share_after": after.largest_eigenvalue_share,
                "forward_effective_bets_before": f_before.effective_bets,
                "forward_effective_bets_after": f_after.effective_bets,
                "forward_largest_share_before": f_before.largest_eigenvalue_share,
                "forward_largest_share_after": f_after.largest_eigenvalue_share,
            }
        )

    if not rows:
        return pd.DataFrame(
            {c: pd.Series([], dtype=t) for c, t in _HISTORY_COLUMNS.items()}
        )
    return pd.DataFrame(rows)[list(_HISTORY_COLUMNS)].astype(_HISTORY_COLUMNS)


def _default_book(panel: pd.DataFrame) -> pd.Series:
    """Equal weight across the non-cash sleeves.

    Not a book anybody would hold. It is the one book that embodies no
    view, which is what a standalone test of this signal needs: a
    concentration reduction measured against an equal-weight book is a
    property of the adjustment, where the same number measured against
    a book somebody chose would be partly a property of the choice.
    """
    keys = [c for c in panel.columns if c not in _CASH_KEYS]
    if not keys:
        raise CorrelationError("the panel contains nothing but cash")
    return pd.Series(1.0 / len(keys), index=keys, dtype="float64")


def _forward_correlation(
    panel: pd.DataFrame, i: int, forward: int, sleeves: Sequence[str]
) -> pd.DataFrame | None:
    """Realised correlation over the `forward` sessions AFTER position i.

    Unshrunk, on purpose. Shrinkage is a correction for estimation
    error in something we are trying to predict; this is a measurement
    of what happened, and pulling it toward a prior would mean
    reporting the prior. None when the sample runs out, which is the
    right answer at the end of the panel and not a zero.
    """
    if len(sleeves) < 2 or i + forward >= len(panel):
        return None
    block = panel.iloc[i : i + forward + 1].loc[:, list(sleeves)]
    positive = block.where(block > 0.0)
    returns = (positive / positive.shift(1) - 1.0).iloc[1:].dropna(axis=0, how="any")
    if len(returns) < 3:
        return None
    if not bool((returns.std(ddof=1) > 0.0).all()):
        return None
    raw = np.corrcoef(returns.to_numpy(dtype="float64"), rowvar=False)
    return pd.DataFrame(
        _tidy(np.asarray(raw, dtype="float64")),
        index=list(sleeves),
        columns=list(sleeves),
        dtype="float64",
    )


_PERIOD_STATS: tuple[str, ...] = (
    "shrinkage",
    "average_correlation",
    "mean_book_correlation",
    "invested_before",
    "invested_after",
    "freed_to_cash",
    "effective_bets_before",
    "effective_bets_after",
    "largest_share_before",
    "largest_share_after",
    "forward_effective_bets_before",
    "forward_effective_bets_after",
    "forward_largest_share_before",
    "forward_largest_share_after",
)


def evaluate(
    close_adj: pd.DataFrame,
    *,
    weights: Mapping[str, float] | pd.Series | None = None,
    lookback: int = LOOKBACK,
    min_observations: int | None = None,
    step: int = 5,
    forward: int | None = None,
    periods: Sequence[metrics.NamedPeriod] = metrics.REPORT_PERIODS,
) -> EvaluationReport:
    """The standalone diagnostic. One call, no performance number.

    There is deliberately no Sharpe here and no equity curve. This
    signal's claim is not that it earns anything — it is a risk
    control, and a risk control that has to be justified by return has
    already been converted into a return signal by whoever justified
    it. The claim is that the book after the adjustment carries fewer
    duplicated bets than the book before, and the test is that claim
    measured directly: effective number of bets and the largest
    principal component's share of variance, with and without, over the
    whole sample and over the named windows where correlations spiked.

    Both measures are reported twice. Once against the matrix the
    adjustment itself used, which is what the process knew. Once
    against the correlations REALISED over the following window, which
    is the version that can say the adjustment cut the wrong sleeves.
    The second is a diagnostic and is unavailable to any signal path,
    for the reason the whole engine is shaped around: a rule may not
    see the tape it trades.
    """
    history = adjustment_history(
        close_adj,
        weights=weights,
        lookback=lookback,
        min_observations=min_observations,
        step=step,
        forward=forward,
    )
    fwd = int(lookback if forward is None else forward)

    rows: list[dict[str, Any]] = [
        _period_row(
            "full sample",
            history,
            history["date"].min() if len(history) else pd.NaT,
            history["date"].max() if len(history) else pd.NaT,
            "every sampled date; the base case the windows below are read "
            "against",
        )
    ]
    for p in periods:
        start = pd.Timestamp(p.start)
        end = (
            pd.Timestamp(p.end)
            if p.end
            else (history["date"].max() if len(history) else start)
        )
        window = (
            history.loc[history["date"].between(start, end)]
            if len(history)
            else history
        )
        rows.append(_period_row(p.name, window, start, end, p.note))

    frame = pd.DataFrame(rows)
    return EvaluationReport(
        lookback=int(lookback),
        step=int(step),
        forward=fwd,
        weights_note=(
            "equal weight across the non-cash sleeves"
            if weights is None
            else "supplied by the caller"
        ),
        n_dates=int(len(history)),
        history=history,
        periods=frame,
    )


def _period_row(
    name: str,
    window: pd.DataFrame,
    start: pd.Timestamp,
    end: pd.Timestamp,
    note: str,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "period": name,
        "start": start,
        "end": end,
        "dates": int(len(window)),
        "n_sleeves": (
            float(window["n_sleeves"].mean()) if len(window) else float("nan")
        ),
    }
    for col in _PERIOD_STATS:
        row[col] = float(window[col].mean()) if len(window) else float("nan")
    row["note"] = note
    return row
