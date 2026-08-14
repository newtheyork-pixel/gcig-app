"""Four published books built out of a covariance matrix, none levered.

This file holds the risk-based half of the replication library: risk
parity, equal risk contribution, minimum variance and maximum
diversification, each implemented from its own source and each measured
only from its own publication date forward. Nothing here is tuned.
Every parameter came out of a paper or out of a module in this
repository that argued for it before any result existed.

**The trap this file exists to name: an unlevered risk-parity book is
not the strategy Qian described.** The whole content of risk parity is
that risk is equalised FIRST and the resulting low-volatility portfolio
is then levered up to an equity-like risk target. Strip the leverage
and what remains is a bond fund with an equity garnish — the arithmetic
does not care that its risk is beautifully balanced, because the risk
it balanced to is about a third of the index's. So the honest
expectation for every class below is that it returns less than SPY,
possibly far less, and the study's job is to measure by how much rather
than to pretend the number is a verdict on the published idea. This
project has already run exactly that experiment once on its own
sleeves: a de-risked book returned 5.35% a year against the index's
10.69%, at the same Sharpe. That is the shape of the answer these
classes should be expected to reproduce.

The same argument, in a different costume, applies to minimum variance.
Frazzini and Pedersen's betting-against-beta explanation says the
low-beta leg earns its premium *per unit of risk*, and that the
investor who cannot borrow is the reason the premium exists in the
first place. We are that investor. Unlevered, the low-volatility
anomaly is a Sharpe-ratio claim that a long-only account cannot convert
into a return claim, and a replication which reported the shortfall as
a refutation would have measured the constraint rather than the idea.

**Nothing here inverts a matrix.** The two formulations that classically
call for one — minimum variance and maximum diversification — are
restated as convex programs over the unit simplex and solved by
projected gradient, and equal risk contribution is solved by the
cyclical coordinate descent of Griveau-Billion, Richard and Roncalli
(2013). A near-singular covariance estimate therefore costs iterations
and never accuracy: there is no expression below whose value explodes
as the smallest eigenvalue approaches zero. That is deliberate.
Inverting a sample covariance matrix is the error-maximising step that
`signals/correlation.py` refuses at length — the optimiser loads onto
whichever pair the estimation error most flattered — and a family of
strategies whose entire input is an estimated matrix is the last place
to relax about it.

**The covariance comes from this repository and is not re-derived.**
The correlation is `signals/correlation.py`'s Ledoit-Wolf shrunk
estimate over its 252-session window; the volatilities are
`signals/volatility.py`'s two-window blend, floored by that module's
numerical floor; and the covariance is `D R D` with `D` the diagonal of
volatilities. That product is positive semi-definite whenever `R` is,
since congruence by a positive diagonal preserves the sign of every
quadratic form, so the shrinkage guarantee survives the composition
intact. The seam worth stating plainly: the two estimators run on
different windows — 252 sessions for the correlation, a 63/252 variance
blend for the diagonal. That is not a choice made here. Each window is
the one its own module argues for, on the grounds that volatility moves
fast and correlation does not, and inventing a third window for this
file would be a free parameter with nothing behind it.

**Two universes, because the papers are about two different things.**
Risk parity is a multi-asset idea and is run over ten asset-class ETFs.
Minimum variance and maximum diversification were published as equity
strategies and are run over the US sector SPDRs, which is the closest
honest ETF-level stand-in for a US equity cross-section. Both
substitutions are recorded on the classes that make them; neither is
free, and the sector book in particular has far less idiosyncratic risk
to diversify away than the thousand-stock cross-section Haugen and
Baker optimised over.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ..signals import correlation, volatility

__all__ = [
    "EqualRiskContribution",
    "InverseVolatilityRiskParity",
    "MULTI_ASSET_UNIVERSE",
    "MaximumDiversification",
    "MinimumVariance",
    "RISK_BASED_STRATEGIES",
    "RiskAllocation",
    "RiskModel",
    "RiskParityError",
    "SolverResult",
    "US_SECTOR_UNIVERSE",
    "WARMUP_SESSIONS",
    "risk_model",
]


class RiskParityError(ValueError):
    """This family was handed something it must not paper over."""


#: Float residue tolerance. Anything smaller is the cost of summing ten
#: products, not a short or a leverage request.
_EPS = 1e-12


# -- the two universes --------------------------------------------------

#: The multi-asset book the risk-parity family is run over.
#:
#: Ten ETFs standing in for the asset classes Qian balances and the four
#: boxes the All Weather lineage is organised around — growth up,
#: growth down, inflation up, inflation down. Equity (SPY, EFA, EEM)
#: and credit (LQD) carry the growth side, nominal duration (IEF, TLT)
#: the deflation side, linkers (TIP), gold (GLD), commodities (DBC) and
#: property (VNQ) the inflation side.
#:
#: What this is NOT is the instrument set any of those managers use.
#: Published risk parity trades futures, which is how it obtains
#: leverage and why it can hold twenty-year duration at three times its
#: cash weight. An ETF book cannot, and the departure is recorded on
#: every class rather than buried here.
#:
#: The listing dates run from 1993 (SPY) to 2006 (DBC), so early in any
#: sample the book is formed over whichever subset has banked the
#: estimator's window. A fund that has not listed is ABSENT and is
#: excluded from the optimisation; it is never held at a weight of zero
#: alongside the assets that were actually considered, because those are
#: different facts and a weight vector cannot tell them apart.
MULTI_ASSET_UNIVERSE: tuple[str, ...] = (
    "SPY",   # US equity
    "EFA",   # developed international equity, unhedged
    "EEM",   # emerging market equity, unhedged
    "IEF",   # 7-10y Treasury
    "TLT",   # 20y+ Treasury
    "LQD",   # investment grade credit
    "TIP",   # inflation-linked Treasury
    "GLD",   # gold, physical
    "DBC",   # broad commodity futures
    "VNQ",   # US property
)

#: The US equity cross-section, as an ETF panel can express one.
#:
#: The nine original sector SPDRs date to December 1998 and are the only
#: sector series reaching back through two full cycles. XLRE and XLC are
#: carve-outs rather than launches — real estate left XLF in 2015,
#: communications was assembled out of XLK and XLY in 2018 — so the
#: cross-section genuinely changes shape twice inside the sample. Each
#: is admitted when it has banked the estimator's window, which is the
#: literal application of the rule to the data that exists rather than a
#: judgement about whether the carve-out counts as new.
US_SECTOR_UNIVERSE: tuple[str, ...] = (
    "XLB", "XLE", "XLF", "XLI", "XLK",
    "XLP", "XLU", "XLV", "XLY",
    "XLRE", "XLC",
)


#: Sessions of history banked before the first decision.
#:
#: Derived from the two estimators rather than written down, so that a
#: caller who lengthens either window cannot forget to lengthen this.
#: The correlation needs `LOOKBACK + 1` closes to yield `LOOKBACK`
#: returns; the volatility blend needs a full trading year of them. The
#: minus one is the engine's convention: at loop index i the view holds
#: i+1 closes, and `warmup` counts what is banked BEFORE the first
#: decision is asked for.
WARMUP_SESSIONS: int = max(correlation.LOOKBACK + 1, volatility.MIN_SESSIONS) - 1


# -- the risk model -----------------------------------------------------


@dataclass(frozen=True, eq=False)
class RiskModel:
    """One covariance estimate as of one close, and its provenance.

    The matrix travels with the two things it was built from and with
    the list of assets that did not make it. That is the same rule the
    engine's result object obeys — a layer that reports must never
    recompute what the process already had — and here it earns its keep
    twice over: a weight that looks wrong is nearly always a correlation
    that looks wrong, and an asset missing from a book is nearly always
    an asset missing from the matrix for a reason somebody wrote down.

    `excluded` maps each absent asset to the sentence saying why. An
    empty dict and a ten-asset matrix is a different fact from a
    seven-asset matrix and three named reasons, and only the second
    tells a reader that three lines of the intended book went
    unmeasured.
    """

    asof: pd.Timestamp
    assets: tuple[str, ...]
    volatility: pd.Series
    correlation: pd.DataFrame
    covariance: pd.DataFrame
    excluded: dict[str, str]
    shrinkage: float
    average_correlation: float
    n_observations: int
    lookback: int

    @property
    def n(self) -> int:
        return int(len(self.assets))

    def matrix(self) -> np.ndarray:
        return self.covariance.to_numpy(dtype="float64")

    def sigma(self) -> np.ndarray:
        return self.volatility.to_numpy(dtype="float64")


def risk_model(
    close_adj: pd.DataFrame,
    *,
    asof: pd.Timestamp | str | None = None,
    assets: Sequence[str] | None = None,
    lookback: int = correlation.LOOKBACK,
    short_window: int = volatility.SHORT_WINDOW,
    long_window: int = volatility.LONG_WINDOW,
    short_weight: float = volatility.SHORT_WEIGHT,
    min_annual_volatility: float = volatility.MIN_ANNUAL_VOLATILITY,
) -> RiskModel:
    """Shrunk correlation, blended volatility, and the covariance of both.

    `close_adj` is a wide panel of TOTAL-RETURN closes. There is no
    argument that selects a price series and there will not be one: over
    2004-2026 TLT returned -2.6% on price and +105.8% with coupons, so a
    risk model fed unadjusted prices is measuring instruments nobody
    holds — and for a correlation the error has a direction, because a
    monthly distribution is an idiosyncratic negative shock on the
    ex-date and idiosyncratic variance attenuates every correlation it
    touches toward zero. Unadjusted prices make a book look more
    diversified than it is, which is the one direction an allocator must
    not be wrong in.

    The panel is cut at `asof` and then TAILED to the longest window any
    estimator below needs. The tail is an optimisation and provably not
    a change of answer — every window is trailing and none reaches
    further back than `need` closes — and it matters over a twenty-year
    walk, where the alternative is re-reading five thousand rows to
    decide one day.

    An asset is in the model only if BOTH estimators spoke about it. The
    correlation module excludes a short or holed history by name; the
    volatility module returns NaN for the same cases. Neither is filled
    in. A sleeve with no estimate is not a sleeve with an average
    estimate, and handing an optimiser a fabricated row is how a fund
    that listed last month ends up as the largest position in a
    minimum-variance book.
    """
    panel = _validated_panel(close_adj)
    if assets is None:
        wanted = [str(c) for c in panel.columns]
    else:
        wanted = [str(a) for a in assets]

    missing = [a for a in wanted if a not in panel.columns]
    if missing:
        raise RiskParityError(
            f"the panel does not carry {sorted(missing)}. A risk model built "
            "over whichever names happened to be present would be a "
            "different strategy every time the panel changed."
        )
    if not wanted:
        raise RiskParityError("no assets were asked for")
    if len(set(wanted)) != len(wanted):
        # Two columns under one name make the covariance singular in a
        # way that means nothing, and the weight the optimiser puts on
        # the pair is a position at twice its own size.
        repeated = sorted({a for a in wanted if wanted.count(a) > 1})
        raise RiskParityError(f"the asset list repeats {repeated}")

    end = _resolve_asof(pd.DatetimeIndex(panel.index), asof)
    need = max(int(lookback) + 1, int(long_window) + 1)
    cut = panel.iloc[max(end - need, 0) : end].loc[:, wanted]
    stamp = pd.Timestamp(cut.index[-1])

    estimate = correlation.estimate_correlation(cut, asof=stamp, lookback=lookback)
    vol = volatility.realised_volatility(
        cut,
        short_window=short_window,
        long_window=long_window,
        short_weight=short_weight,
    ).iloc[-1]

    excluded = dict(estimate.excluded)
    keep: list[str] = []
    for asset in estimate.sleeves:
        v = float(vol.get(asset, float("nan")))
        if not math.isfinite(v):
            excluded[asset] = (
                "no volatility estimate: this asset has not banked a complete "
                "estimation window here"
            )
            continue
        keep.append(asset)

    # Floored for the reason `volatility.MIN_ANNUAL_VOLATILITY` gives:
    # this is numerical stability and not a portfolio decision. A series
    # whose realised volatility rounds to zero would divide into the
    # inverse-vol weights and out the other side as an infinity, and it
    # would do it silently, because an infinite weight normalises to one.
    sigma = pd.Series(
        {a: max(float(vol[a]), float(min_annual_volatility)) for a in keep},
        dtype="float64",
    )
    corr = estimate.correlation.loc[keep, keep] if keep else estimate.correlation
    if keep:
        d = sigma.to_numpy(dtype="float64")
        cov = pd.DataFrame(
            corr.to_numpy(dtype="float64") * np.outer(d, d),
            index=keep,
            columns=keep,
            dtype="float64",
        )
    else:
        cov = pd.DataFrame(dtype="float64")

    return RiskModel(
        asof=stamp,
        assets=tuple(keep),
        volatility=sigma,
        correlation=pd.DataFrame(corr, dtype="float64"),
        covariance=cov,
        excluded=excluded,
        shrinkage=float(estimate.shrinkage),
        average_correlation=float(estimate.average_correlation),
        n_observations=int(estimate.n_observations),
        lookback=int(lookback),
    )


def _validated_panel(close_adj: pd.DataFrame) -> pd.DataFrame:
    """The refusals both estimators make, restated one layer up.

    Stated here so the error names the risk model rather than surfacing
    from inside whichever estimator happened to run first. Each is a way
    a covariance comes out plausible and wrong: an unsorted index
    reverses the sign of half the returns and barely moves the
    volatility, a duplicated session puts one bar in a window twice, and
    two columns under one name make every lookup below return a frame
    where a Series was expected.
    """
    if not isinstance(close_adj, pd.DataFrame):
        raise RiskParityError(
            f"expected a wide close_adj panel, got {type(close_adj)!r}"
        )
    names = [str(c) for c in close_adj.columns]
    if not names:
        raise RiskParityError("the close_adj panel has no assets in it")
    if len(set(names)) != len(names):
        raise RiskParityError(
            "the close_adj panel has duplicate column(s): "
            f"{sorted({n for n in names if names.count(n) > 1})}"
        )
    if not isinstance(close_adj.index, pd.DatetimeIndex):
        raise RiskParityError("close_adj must be indexed by date")
    idx = pd.DatetimeIndex(close_adj.index)
    if len(idx) == 0:
        raise RiskParityError("the close_adj panel has no sessions in it")
    if not idx.is_monotonic_increasing:
        raise RiskParityError(
            "close_adj is not sorted ascending. Sorting it here would hide "
            "the upstream bug, and every return underneath would already "
            "have been computed backwards."
        )
    if idx.has_duplicates:
        n = int(idx.duplicated().sum())
        raise RiskParityError(f"close_adj has {n:,} duplicate session(s)")
    if all(isinstance(c, str) for c in close_adj.columns):
        # Handed back untouched, and deliberately not copied. This is
        # called once per session against a panel that grows all run, so
        # a defensive copy here is a quadratic cost paid for nothing —
        # everything downstream slices and reads, and the one line that
        # would rename a column is the branch below, which builds a new
        # frame rather than writing into the caller's.
        return close_adj
    return close_adj.set_axis(pd.Index(names), axis="columns")


def _resolve_asof(idx: pd.DatetimeIndex, asof: pd.Timestamp | str | None) -> int:
    """How many sessions are visible at `asof`. Backward, never forward.

    Snapping backward to the last session at or before the date is safe
    by construction; snapping to the NEAREST would land in the future
    about half the time.
    """
    if asof is None:
        return int(len(idx))
    stamp = pd.Timestamp(asof)
    end = int(idx.searchsorted(stamp, side="right"))
    if end == 0:
        raise RiskParityError(
            f"no session on or before {stamp.date()}; the panel starts "
            f"{idx[0].date()}"
        )
    return end


# -- solvers ------------------------------------------------------------
#
# Two of them, and neither forms an inverse. What each does when it
# cannot finish is stated on `SolverResult` and is the same in both
# cases: return the last iterate, which is always a feasible long-only
# book summing to one, and say that it did not converge. The tempting
# alternative — substituting some safe fallback book — is worse, because
# the run would then attribute a book to a published method that did not
# produce it, and nothing downstream could tell.


@dataclass(frozen=True)
class SolverResult:
    """A book, and whether the arithmetic that produced it finished.

    `converged` false does not mean the weights are unusable. Both
    solvers below are feasible at every iterate — projected gradient
    lands on the simplex by construction, coordinate descent starts
    positive and stays positive — so what a false reports is that the
    optimum was not proven to the requested tolerance, not that
    something invalid is being returned. It is nonetheless recorded on
    every decision, because a run in which it is often false is a run
    whose covariance estimates are near-singular, and that is a fact
    about the study rather than a detail about the arithmetic.

    `degenerate` is the harder state: the matrix carried no usable
    curvature at all, so every book is equally optimal and the equal
    weight one is returned. It has never been observed on a shrunk
    estimate of real returns and the branch exists so that if it ever
    happens it is visible rather than an exception three layers up.
    """

    weights: np.ndarray
    converged: bool
    iterations: int
    degenerate: bool = False


def _project_simplex(v: np.ndarray) -> np.ndarray:
    """Euclidean projection onto {w >= 0, sum w = 1}.

    Michelot (1986); the sorted form is Duchi, Shalev-Shwartz, Singer
    and Chandra (2008). Exact rather than iterative, which is what makes
    the projected-gradient loop below cheap enough to run every session
    of a twenty-year walk.
    """
    n = int(v.size)
    if n == 0:
        return v
    u = np.sort(v)[::-1]
    css = np.cumsum(u) - 1.0
    idx = np.arange(1, n + 1, dtype="float64")
    positive = np.nonzero(u - css / idx > 0.0)[0]
    # The first index always qualifies — u[0] - (u[0] - 1) = 1 — so this
    # is never empty and the guard is only here to make that argument
    # visible to the next reader.
    rho = int(positive[-1]) if positive.size else 0
    theta = css[rho] / (rho + 1)
    return np.maximum(v - theta, 0.0)


def _min_variance_on_simplex(
    matrix: np.ndarray, *, max_iterations: int, tolerance: float
) -> SolverResult:
    """Minimise w'Mw subject to w >= 0 and sum w = 1.

    Accelerated projected gradient (Beck and Teboulle, 2009) with the
    adaptive restart of O'Donoghue and Candes (2015). The step is
    1/(2 lambda_max), which is the exact reciprocal of the gradient's
    Lipschitz constant and is computed from a symmetric eigenvalue
    routine — no inverse, no linear solve, nothing that grows as the
    smallest eigenvalue approaches zero. A near-singular estimate makes
    this converge slowly and correctly, which is the only failure mode a
    long-only optimiser over an estimated matrix should be allowed to
    have.

    The restart matters more than it looks. Plain FISTA is not monotone
    and can overshoot along a nearly flat direction — which is precisely
    the shape of a min-variance problem on a highly correlated equity
    cross-section — so the momentum is dropped whenever the objective
    rises. The result is deterministic: no random starts, no warm start
    from yesterday's answer. A warm start would make the book a function
    of the path the run took to reach today, and the truncation test
    this project runs on every signal — cut the panel after T, recompute,
    demand the same answer — would stop being able to pass.
    """
    n = int(matrix.shape[0])
    if n == 0:
        return SolverResult(np.zeros(0), True, 0)
    if n == 1:
        return SolverResult(np.ones(1), True, 0)

    m = 0.5 * (matrix + matrix.T)
    if not np.isfinite(m).all():
        raise RiskParityError(
            "the covariance handed to the optimiser is not finite. That is a "
            "hole in the estimate rather than a market state, and filling it "
            "here would put a fabricated number into a weight."
        )

    lam = float(np.linalg.eigvalsh(m)[-1])
    if not math.isfinite(lam) or lam <= _EPS:
        # No curvature: every feasible book has the same variance, so
        # equal weight is an optimum rather than a fallback.
        return SolverResult(np.full(n, 1.0 / n), True, 0, degenerate=True)

    step = 1.0 / (2.0 * lam)
    w = np.full(n, 1.0 / n)
    y = w.copy()
    t = 1.0
    objective = float(w @ m @ w)
    converged = False
    used = 0

    for used in range(1, int(max_iterations) + 1):
        candidate = _project_simplex(y - step * (2.0 * (m @ y)))
        value = float(candidate @ m @ candidate)
        if value > objective + _EPS:
            # Momentum sent us uphill. Drop it and retake the step from
            # the last good point, which is an ordinary projected
            # gradient step and cannot increase the objective.
            candidate = _project_simplex(w - step * (2.0 * (m @ w)))
            value = float(candidate @ m @ candidate)
            t = 1.0

        shift = float(np.max(np.abs(candidate - w)))
        t_next = 0.5 * (1.0 + math.sqrt(1.0 + 4.0 * t * t))
        y = candidate + ((t - 1.0) / t_next) * (candidate - w)
        w, t, objective = candidate, t_next, value
        if shift <= tolerance:
            converged = True
            break

    return SolverResult(_clean(w), converged, used)


def _equal_risk_contribution(
    covariance: np.ndarray,
    *,
    budgets: np.ndarray | None = None,
    max_iterations: int,
    tolerance: float,
) -> SolverResult:
    """Weights whose risk contributions are all equal.

    Cyclical coordinate descent on the log-barrier form of Spinu (2013),
    as set out by Griveau-Billion, Richard and Roncalli (2013). Minimise
    `0.5 x'Sx - sum b_i ln x_i` over x > 0; at the optimum
    `x_i (Sx)_i = b_i` for every i, so the normalised x has risk
    contributions in the proportions b. Each coordinate is the positive
    root of `S_ii x_i^2 + beta x_i - b_i = 0` with
    `beta = (Sx)_i - S_ii x_i`, and that root is real and strictly
    positive for any beta whenever `S_ii > 0` — the discriminant is
    `beta^2 + 4 S_ii b_i`, which cannot be negative. The iteration
    therefore never leaves the feasible region and never needs a
    projection, a line search or an inverse.

    `S_ii > 0` is guaranteed upstream: the volatility floor in
    `risk_model` is exactly the guard that makes this true, and an asset
    with no variation is excluded from the correlation matrix by name
    before it ever reaches here.

    The starting point is the inverse-volatility book, which is the
    exact answer when the covariance is diagonal. That is not a
    convenience: starting near the answer is what keeps the sweep count
    in the tens rather than the thousands, and it is a fixed function of
    the matrix, so the result stays independent of the path the run
    took to reach today.
    """
    n = int(covariance.shape[0])
    if n == 0:
        return SolverResult(np.zeros(0), True, 0)
    if n == 1:
        return SolverResult(np.ones(1), True, 0)

    s = 0.5 * (covariance + covariance.T)
    if not np.isfinite(s).all():
        raise RiskParityError(
            "the covariance handed to the risk-contribution solver is not "
            "finite; see the note in the minimum-variance solver"
        )
    diag = np.diag(s).copy()
    if not np.all(diag > 0.0):
        raise RiskParityError(
            "an asset with zero variance reached the risk-contribution "
            "solver. The volatility floor in `risk_model` exists to make "
            "that impossible, so this is a bug rather than a quiet market."
        )

    if budgets is None:
        b = np.full(n, 1.0 / n)
    else:
        b = np.asarray(budgets, dtype="float64")
    if b.shape != (n,) or not np.all(b > 0.0):
        raise RiskParityError(
            "risk budgets must be one positive number per asset; a budget of "
            "zero asks for a position that carries no risk and has weight, "
            "which nothing in a long-only book can deliver"
        )

    x = np.sqrt(b) / np.sqrt(diag)
    converged = False
    used = 0

    for used in range(1, int(max_iterations) + 1):
        previous = x.copy()
        for i in range(n):
            beta = float(s[i] @ x) - diag[i] * x[i]
            x[i] = (-beta + math.sqrt(beta * beta + 4.0 * diag[i] * b[i])) / (
                2.0 * diag[i]
            )
        total = float(x.sum())
        if total <= _EPS:
            raise RiskParityError(
                "the risk-contribution iterate collapsed to zero, which the "
                "positive-root argument says cannot happen; the covariance "
                "is not what this solver was promised"
            )
        if float(np.max(np.abs(x - previous))) / total <= tolerance:
            converged = True
            break

    return SolverResult(_clean(x / float(x.sum())), converged, used)


def _clean(w: np.ndarray) -> np.ndarray:
    """Sweep the float residue off a weight vector.

    Both solvers return something that sums to one and is non-negative
    by construction and by a few ulps in practice. The ulps matter here
    and nowhere else: the engine REFUSES a negative target outright — a
    short is not a rounding problem to be clipped — so a -3e-17 escaping
    this function stops a twenty-year run at session four thousand.
    """
    out = np.where(np.abs(w) < _EPS, 0.0, w)
    out = np.maximum(out, 0.0)
    total = float(out.sum())
    return out / total if total > 0.0 else out


# -- what one decision looked like --------------------------------------


_ALLOCATION_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "strategy": "str",
    "asset": "str",
    "weight": "float64",
    "unconstrained_weight": "float64",
    "cap": "float64",
    "annual_volatility": "float64",
    "risk_contribution": "float64",
    "n_assets": "int64",
    "n_excluded": "int64",
    "gross": "float64",
    "cash_weight": "float64",
    "portfolio_volatility": "float64",
    "diversification_ratio": "float64",
    "risk_contribution_spread": "float64",
    "shrinkage": "float64",
    "average_correlation": "float64",
    "converged": "bool",
    "iterations": "int64",
}


@dataclass(frozen=True, eq=False)
class RiskAllocation:
    """One date's book, with the arithmetic and the diagnostics attached.

    Four numbers are worth having beside every weight, and all four are
    cheap once the covariance is in hand.

    `risk_contributions` is `w_i (Sw)_i / w'Sw`, the share of portfolio
    variance each position accounts for. It is what the risk-parity
    family claims to control, so printing it is how the claim gets
    checked rather than asserted — an equal-risk book whose spread is
    not near zero has not converged, whatever the solver said.

    `diversification_ratio` is `w'sigma / sqrt(w'Sw)`, the quantity
    Choueifaty and Coignard maximise. It is reported for all four
    strategies because the comparison is most of the point: the ratio
    the max-diversification book achieves is the ceiling the other three
    are being read against.

    `portfolio_volatility` is the annualised risk the model expected,
    and it is the number that makes the leverage argument concrete. A
    risk-parity book printing 6% where the index runs 16% is not
    underperforming by accident; it is holding a third of the risk, and
    the return follows the risk.
    """

    asof: pd.Timestamp
    strategy: str
    weights: pd.Series
    unconstrained: pd.Series
    caps: pd.Series
    model: RiskModel
    risk_contributions: pd.Series
    portfolio_volatility: float
    diversification_ratio: float
    converged: bool
    iterations: int
    degenerate: bool

    @property
    def gross(self) -> float:
        return float(self.weights.sum())

    @property
    def cash_weight(self) -> float:
        return max(0.0, 1.0 - self.gross)

    @property
    def risk_contribution_spread(self) -> float:
        """Max minus min contribution. Zero is a perfect ERC book."""
        rc = self.risk_contributions.dropna()
        if len(rc) < 2:
            return float("nan")
        return float(rc.max() - rc.min())

    def rows(self) -> list[dict[str, Any]]:
        spread = self.risk_contribution_spread
        # A date on which nothing could be measured still gets a row,
        # under no asset name. The alternative is a table whose missing
        # dates a reader has to notice, and "the book was empty" reads
        # identically to "the run had not started yet" once the row is
        # gone.
        assets = list(self.weights.index) or [""]
        return [
            {
                "date": self.asof,
                "strategy": self.strategy,
                "asset": asset,
                "weight": float(self.weights.get(asset, 0.0)),
                "unconstrained_weight": float(self.unconstrained.get(asset, 0.0)),
                "cap": float(self.caps.get(asset, 1.0)),
                "annual_volatility": float(
                    self.model.volatility.get(asset, float("nan"))
                ),
                "risk_contribution": float(
                    self.risk_contributions.get(asset, float("nan"))
                ),
                "n_assets": self.model.n,
                "n_excluded": len(self.model.excluded),
                "gross": self.gross,
                "cash_weight": self.cash_weight,
                "portfolio_volatility": self.portfolio_volatility,
                "diversification_ratio": self.diversification_ratio,
                "risk_contribution_spread": spread,
                "shrinkage": self.model.shrinkage,
                "average_correlation": self.model.average_correlation,
                "converged": bool(self.converged),
                "iterations": int(self.iterations),
            }
            for asset in assets
        ]


def _frame(rows: list[dict[str, Any]], cols: dict[str, str]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
    return pd.DataFrame(rows)[list(cols)].astype(cols)


# -- the family ---------------------------------------------------------


class _RiskBased:
    """Shared plumbing for a book that comes out of a covariance matrix.

    Every subclass supplies one method — turn a `RiskModel` into a
    weight vector — and inherits everything else: the eligibility rules,
    the cap handling, the diagnostics and the record. The point of the
    split is that the only thing which differs between four published
    strategies should be the four published formulas, and a reader
    comparing them should not have to check whether they also differ in
    how they treated a fund that had not listed yet.

    **Caps are obeyed and never redistributed.** The engine publishes
    per-asset ceilings on `MarketView.caps` and this class clips to
    them, because a strategy that chases a weight it will never be
    allowed to hold asks for the same trade every day forever. What it
    does NOT do is hand the clipped remainder to the other positions:
    that redistribution is a rule none of these papers contains, and the
    shortfall becomes cash instead. Which raises the thing to say
    loudly — **a run with sleeve caps applied is not a replication.**
    The caps in `portfolio/sleeves.py` are this fund's own risk policy;
    Qian, Maillard, Haugen and Choueifaty imposed nothing of the kind.
    A faithful measurement passes `BacktestConfig(apply_sleeve_caps=
    False)`, and a run that does not should report its weights as
    constrained rather than as the paper's.

    **The rule is applied at every decision date.** None of the four
    sources specifies a rebalancing calendar for the rule itself — they
    define a weight vector as a function of a covariance matrix — so
    inventing one here would be inventing a parameter. The estimator is
    slow by construction (a 252-session shrunk correlation moves very
    little day to day), and the engine's no-trade band and turnover
    budget are what actually govern trading. Those belong to the
    account, not to the strategy, which is the right place for them.

    **Fully invested means ninety-five per cent invested, and the
    deferral log will say so several thousand times.** Every book below
    sums to one, because that is what the papers specify and because the
    residual is not a decision any of them makes. The ledger holds back
    a five-per-cent settlement buffer, so the last slice is never
    fundable, and the engine therefore plans a small buy in every
    position on nearly every session and defers it. Two things to know
    before reading those counts as a fault. The shortfall is
    proportional to each weight, so it moves the LEVEL of the book and
    never the mix — the strategy that lands is the strategy that was
    asked for, at 0.95x. And the count is a structural floor rather than
    an event log: a run of this family should be compared against the
    same family's floor, not against a strategy that targets less than
    full investment and therefore never asks.
    """

    #: Filled in by each subclass. Declared here so that a strategy
    #: written without one fails at import rather than in a report.
    key: str = ""
    title: str = ""
    citation: str = ""
    published_on: date = date(1970, 1, 1)
    universe: tuple[str, ...] = ()
    rationale: str = ""
    as_published: str = ""

    warmup: int = WARMUP_SESSIONS

    def __init__(
        self,
        *,
        name: str | None = None,
        record: bool = True,
        lookback: int = correlation.LOOKBACK,
        min_annual_volatility: float = volatility.MIN_ANNUAL_VOLATILITY,
        max_iterations: int = 10_000,
        tolerance: float = 1e-10,
    ) -> None:
        if not self.key:
            raise RiskParityError(
                f"{type(self).__name__} carries no key, title or citation. "
                "A strategy in this library without a publication date is a "
                "backtest, which is the thing this study is not."
            )
        self.name = str(name or self.title or self.key)
        self.record = bool(record)
        self.lookback = int(lookback)
        self.min_annual_volatility = float(min_annual_volatility)
        # Numerical, not economic. The convergence tolerance is four
        # orders of magnitude finer than the engine's no-trade band, so
        # no reachable setting of it can change a trade; it is exposed so
        # a test can tighten it, not so a study can tune it.
        self.max_iterations = int(max_iterations)
        self.tolerance = float(tolerance)
        self._allocations: list[RiskAllocation] = []

        self.warmup = max(
            int(lookback) + 1,
            volatility.MIN_SESSIONS,
        ) - 1

    # -- the protocol the engine calls ---------------------------------

    def targets(self, view: Any) -> Mapping[str, float]:
        panel = view.close_adj
        columns = {str(c) for c in panel.columns}
        present = [t for t in self.universe if t in columns]
        if not present:
            raise RiskParityError(
                f"{self.name} needs {list(self.universe)} and the panel "
                f"carries none of them. Running it against whatever else is "
                "in the panel would be a different strategy wearing this "
                "one's citation."
            )

        model = risk_model(
            panel,
            asof=view.asof,
            assets=present,
            lookback=self.lookback,
            min_annual_volatility=self.min_annual_volatility,
        )

        # Every name the strategy could hold is stated, including the
        # zeroes. The engine reads an absent asset as a target of zero
        # either way, but a strategy that leaves names out is one edit
        # away from leaving one out by accident and holding it forever.
        targets = {t: 0.0 for t in present}

        if model.n == 0:
            self._remember(
                _empty_allocation(pd.Timestamp(view.asof), self.name, model, present)
            )
            return targets

        solution = self._solve(model)
        raw = pd.Series(solution.weights, index=list(model.assets), dtype="float64")

        caps = getattr(view, "caps", None) or {}
        ceiling = pd.Series(
            {a: float(caps.get(a, 1.0)) for a in model.assets}, dtype="float64"
        )
        weights = raw.clip(upper=ceiling)

        gross = float(weights.sum())
        if gross > 1.0:
            # Only float residue can get here — both solvers normalise —
            # but the engine treats a gross above one as a margin request
            # and raises, so the residue is swept rather than trusted.
            weights = weights / gross

        contributions, port_vol, ratio = _diagnostics(weights, model)
        self._remember(
            RiskAllocation(
                asof=model.asof,
                strategy=self.name,
                weights=weights,
                unconstrained=raw,
                caps=ceiling,
                model=model,
                risk_contributions=contributions,
                portfolio_volatility=port_vol,
                diversification_ratio=ratio,
                converged=solution.converged,
                iterations=solution.iterations,
                degenerate=solution.degenerate,
            )
        )

        targets.update({a: float(w) for a, w in weights.items()})
        return targets

    def _solve(self, model: RiskModel) -> SolverResult:
        raise NotImplementedError

    # -- the record ----------------------------------------------------

    def _remember(self, allocation: RiskAllocation) -> None:
        if self.record:
            self._allocations.append(allocation)

    @property
    def allocations(self) -> tuple[RiskAllocation, ...]:
        return tuple(self._allocations)

    def decisions(self) -> pd.DataFrame:
        """One row per asset per date. The audit trail, as a table.

        Long rather than wide for the reason `sizing.decomposition`
        gives: a wide frame has to choose one quantity to be the value,
        and the whole claim of this record is that the weight alone
        cannot answer the question anyone asks of it afterwards.
        """
        rows: list[dict[str, Any]] = []
        for allocation in self._allocations:
            rows.extend(allocation.rows())
        return _frame(rows, _ALLOCATION_COLUMNS)

    @classmethod
    def provenance(cls) -> dict[str, Any]:
        """The publication record, as one row for the library's index."""
        return {
            "key": cls.key,
            "title": cls.title,
            "citation": cls.citation,
            "published_on": pd.Timestamp(cls.published_on),
            "universe": ",".join(cls.universe),
            "rationale": cls.rationale,
            "as_published": cls.as_published,
        }


def _diagnostics(
    weights: pd.Series, model: RiskModel
) -> tuple[pd.Series, float, float]:
    """Risk contributions, portfolio volatility, diversification ratio.

    All three off one matrix product, and all three reported whatever
    the strategy was — the contributions are how an equal-risk claim
    gets checked instead of asserted, and the ratio is the yardstick the
    maximum-diversification book defines for the other three.
    """
    assets = list(model.assets)
    w = weights.reindex(assets).fillna(0.0).to_numpy(dtype="float64")
    cov = model.matrix()
    sigma = model.sigma()

    variance = float(w @ cov @ w)
    if variance <= _EPS:
        empty = pd.Series(np.full(len(assets), np.nan), index=assets, dtype="float64")
        return empty, float("nan"), float("nan")

    marginal = cov @ w
    contributions = pd.Series(w * marginal / variance, index=assets, dtype="float64")
    port_vol = math.sqrt(variance)
    ratio = float(w @ sigma) / port_vol if port_vol > 0.0 else float("nan")
    return contributions, port_vol, ratio


def _empty_allocation(
    asof: pd.Timestamp, strategy: str, model: RiskModel, present: Sequence[str]
) -> RiskAllocation:
    """A date on which nothing could be measured, recorded as such.

    An all-cash book because no asset had banked the estimator's window
    is a different fact from an all-cash book because the optimiser
    wanted cash, and the second one cannot happen here at all — none of
    these four strategies has an opinion that could produce it. Writing
    the row keeps the two distinguishable in the record.
    """
    empty = pd.Series(dtype="float64")
    return RiskAllocation(
        asof=asof,
        strategy=strategy,
        weights=empty,
        unconstrained=empty,
        caps=empty,
        model=model,
        risk_contributions=empty,
        portfolio_volatility=float("nan"),
        diversification_ratio=float("nan"),
        converged=True,
        iterations=0,
        degenerate=False,
    )


# -- 1. risk parity, unlevered ------------------------------------------


class InverseVolatilityRiskParity(_RiskBased):
    """Weight inversely to volatility, so each asset carries equal risk.

    `w_i` proportional to `1 / sigma_i`, normalised to one. Under this
    book every asset's standalone risk contribution is identical by
    construction, which is the property Qian named risk parity and the
    one the whole All Weather lineage is organised around: a 60/40
    portfolio is not 60% equity risk, it is about 90% equity risk, and
    the bonds in it are decoration. Balance the risk instead and the
    resulting book has a materially higher Sharpe ratio than the
    cap-weighted or dollar-balanced alternative.

    **And then it is levered, which we cannot do.** See the module
    docstring; this is the single most important sentence about this
    class. Equalised risk is low risk, and low risk unlevered is low
    return. Expect this to lose to the index on return by something like
    the ratio of their volatilities, and read the Sharpe rather than the
    total, while remembering that a Sharpe an account cannot lever is a
    Sharpe it cannot spend.
    """

    key = "risk-parity-unlevered"
    title = "Risk Parity (inverse volatility, unlevered)"
    citation = (
        "Edward Qian, 'Risk Parity Portfolios: Efficient Portfolios Through "
        "True Diversification', PanAgora Asset Management white paper, "
        "September 2005"
    )
    #: The white paper that named the idea and put it in the public
    #: record. Bridgewater ran All Weather from 1996 and that is
    #: EARLIER and does not count: a private fund is not a publication,
    #: nobody outside it could have implemented from it, and the
    #: out-of-sample guarantee this study rests on comes from the date
    #: being fixed by somebody else in public. The paper is dated to the
    #: month, so the first of the month is used and the ambiguity is
    #: worth at most three trading weeks.
    published_on = date(2005, 9, 1)
    universe = MULTI_ASSET_UNIVERSE
    rationale = (
        "Diversification measured in dollars is not diversification "
        "measured in risk. A conventional balanced fund holds most of its "
        "risk in its smallest-volatility-adjusted allocation, so its "
        "returns are an equity bet with a bond-shaped label. Weighting "
        "each asset by the reciprocal of its volatility equalises the "
        "risk each contributes, which raises the portfolio's Sharpe ratio "
        "because it stops one asset class from setting the outcome. The "
        "resulting portfolio is then levered to whatever risk target the "
        "investor actually wants."
    )
    as_published = (
        "Two departures, and the first is the strategy. (1) NOT LEVERED. "
        "Qian's construction reaches an equity-like return by scaling the "
        "risk-balanced book up, typically to 10-12% volatility using "
        "futures or financing; this account has neither, so what is "
        "measured here is the unlevered core, whose expected return is "
        "materially lower than the published strategy's and roughly in "
        "proportion to the volatility not taken. (2) This is the NAIVE "
        "inverse-volatility book, which ignores correlation. It coincides "
        "with true risk parity only when every pair of assets is equally "
        "correlated; `EqualRiskContribution` in this module implements "
        "the correlation-aware version, and the pair is deliberately kept "
        "separate so the difference can be measured rather than assumed. "
        "(3) Asset classes are ETF proxies rather than the futures a risk "
        "parity manager trades, which changes the financing, the roll and "
        "the achievable duration."
    )

    def _solve(self, model: RiskModel) -> SolverResult:
        inverse = 1.0 / model.sigma()
        return SolverResult(_clean(inverse / float(inverse.sum())), True, 0)


# -- 2. equal risk contribution -----------------------------------------


class EqualRiskContribution(_RiskBased):
    """Solve for weights where every asset contributes equal variance.

    The proper version of the class above. An asset's contribution to
    portfolio variance is `w_i (Sw)_i`, which depends on its covariance
    with everything else and not only on its own volatility; equalising
    those quantities is a fixed-point problem with no closed form, and
    the inverse-volatility book is its solution only in the special case
    where all pairwise correlations are equal.

    **Where the two differ, concretely.** Naive inverse-vol treats two
    highly correlated assets as two independent bets and ends up holding
    the pair at twice the risk either deserves; ERC sees the covariance
    and cuts both. On the multi-asset book here that means the two
    Treasury lines and the credit line — IEF, TLT and LQD move together,
    and inverse-vol, seeing only three quiet series, loads all three.
    Run the pair side by side and the difference is a duration
    concentration, which is exactly the exposure that made 2022 the
    worst year risk parity has had.

    The solver is described on `_equal_risk_contribution`. It is a
    numerical method for the same optimum, not a change to the
    definition.
    """

    key = "equal-risk-contribution"
    title = "Equal Risk Contribution (unlevered)"
    citation = (
        "Sebastien Maillard, Thierry Roncalli and Jerome Teiletche, 'The "
        "Properties of Equally Weighted Risk Contribution Portfolios', "
        "Journal of Portfolio Management 36(4), Summer 2010, 60-70"
    )
    #: The Summer 2010 issue. An SSRN working paper circulated under a
    #: near-identical title from 2008 and would be the earlier date; the
    #: journal issue is used because it is the date that can be verified
    #: to a specific document, and because a window that starts at the
    #: journal date is unambiguously post-publication, which is the only
    #: property this study needs from it. The choice costs about twenty
    #: months of measurement and cannot flatter the strategy, since
    #: those months sit at the START of the decay the study is looking
    #: for.
    published_on = date(2010, 7, 1)
    universe = MULTI_ASSET_UNIVERSE
    rationale = (
        "Between the two extremes of minimum variance — which needs an "
        "expected-return forecast it does not have, and concentrates — and "
        "equal weight, which ignores risk entirely, sits the portfolio in "
        "which every constituent contributes the same share of total "
        "variance. It exists and is unique for any positive definite "
        "covariance matrix, needs no return forecast, and its volatility "
        "is bounded between the minimum-variance and equal-weight books. "
        "The claim is not that it is optimal in any mean-variance sense; "
        "it is that it is the most diversified portfolio you can specify "
        "without pretending to know anything about returns."
    )
    as_published = (
        "(1) NOT LEVERED, for the reason the risk-parity class states at "
        "length: the published construction is a low-risk core intended "
        "to be scaled to a risk target. (2) The covariance is this "
        "repository's Ledoit-Wolf shrunk correlation combined with its "
        "two-window volatility blend, where the paper uses the sample "
        "covariance matrix. This is a departure and it is deliberate: the "
        "library applies one estimator to every strategy so that "
        "differences between results are differences between strategies, "
        "and the sample matrix over an estimated inverse is the "
        "error-maximising choice this repository refuses elsewhere. It "
        "biases toward the naive inverse-volatility answer, since "
        "shrinkage pulls every pair toward the average correlation. "
        "(3) The paper rebalances on a fixed calendar in its empirical "
        "section; the rule itself specifies no cadence, so it is applied "
        "at every decision date and the engine's no-trade band governs "
        "the trading."
    )

    def _solve(self, model: RiskModel) -> SolverResult:
        return _equal_risk_contribution(
            model.matrix(),
            max_iterations=self.max_iterations,
            tolerance=self.tolerance,
        )


# -- 3. minimum variance ------------------------------------------------


class MinimumVariance(_RiskBased):
    """The lowest-variance long-only book the covariance matrix allows.

    Minimise `w'Sw` subject to `w >= 0` and `sum w = 1`. No expected
    returns enter anywhere, which is the entire appeal: the input the
    mean-variance frontier is most sensitive to and worst at estimating
    is simply not used.

    Haugen and Baker's finding was that this portfolio, built from a
    broad US equity cross-section, delivered returns at least as high as
    the cap-weighted index at materially lower risk — an anomaly in the
    strict sense, since a lower-beta portfolio should earn less. Twenty
    years of subsequent work turned it into the low-volatility factor.

    **Why this is expected to underperform here, and why that is not a
    refutation.** Frazzini and Pedersen's betting-against-beta model
    explains the anomaly by leverage constraints: investors who want
    more return and cannot borrow bid up high-beta assets instead, which
    leaves low-beta assets cheap on a risk-adjusted basis. The trade
    that harvests that is long low-beta LEVERED and short high-beta. We
    can do neither. What is left is the long leg at 1x, which is a claim
    about Sharpe ratio that a long-only unlevered account cannot turn
    into a claim about return. A shortfall against SPY here measures the
    constraint; the study's contribution is the size of the shortfall
    and the size of the risk reduction bought with it.
    """

    key = "minimum-variance"
    title = "Minimum Variance (long-only)"
    citation = (
        "Robert A. Haugen and Nardin L. Baker, 'The Efficient Market "
        "Inefficiency of Capitalization-Weighted Stock Portfolios', "
        "Journal of Portfolio Management 17(3), Spring 1991, 35-40; see "
        "also Andrea Frazzini and Lasse Heje Pedersen, 'Betting Against "
        "Beta', Journal of Financial Economics 111(1), 2014, 1-25, for "
        "the leverage-constraint explanation"
    )
    #: The Spring 1991 issue. Note what this date does and does not buy:
    #: free ETF data does not reach 1991, so the measurement window is
    #: post-publication by fourteen years whatever we do, and the
    #: publication-forward guarantee costs nothing here. The flip side is
    #: that the whole sample sits deep in the regime McLean and Pontiff
    #: describe, long after the anomaly was public and after USMV and
    #: SPLV made it purchasable in a wrapper.
    published_on = date(1991, 4, 1)
    universe = US_SECTOR_UNIVERSE
    rationale = (
        "Capitalisation weighting is not mean-variance efficient. A "
        "portfolio built to minimise variance alone — using no return "
        "forecast at all, since that is the input estimation error most "
        "punishes — has historically matched or beaten the cap-weighted "
        "index's return while carrying substantially less risk. The "
        "existence of such a portfolio is a direct contradiction of the "
        "market portfolio's efficiency."
    )
    as_published = (
        "(1) UNIVERSE. Haugen and Baker optimise over a broad US equity "
        "cross-section of over a thousand stocks; this runs over the "
        "eleven US sector SPDRs. That is the closest honest ETF-level "
        "stand-in and it is a weak one: most of the variance a "
        "minimum-variance optimiser removes is idiosyncratic, and a "
        "sector ETF has already diversified its idiosyncratic risk away "
        "before the optimiser sees it. Expect a smaller risk reduction "
        "and a weaker low-volatility tilt than the paper reports. "
        "(2) The cross-section changes shape twice: XLRE was carved out "
        "of XLF in 2015 and XLC out of XLK and XLY in 2018. Each is "
        "admitted when it has banked the estimator's window. "
        "(3) LONG ONLY and unlevered, which the paper's constrained "
        "version also is — but see the class docstring on why the "
        "unlevered long leg cannot express the betting-against-beta "
        "trade the effect is now attributed to. "
        "(4) Covariance is this repository's shrunk estimate rather than "
        "the sample matrix, uniformly across the library."
    )

    def _solve(self, model: RiskModel) -> SolverResult:
        return _min_variance_on_simplex(
            model.matrix(),
            max_iterations=self.max_iterations,
            tolerance=self.tolerance,
        )


# -- 4. maximum diversification -----------------------------------------


class MaximumDiversification(_RiskBased):
    """Maximise the ratio of weighted average risk to portfolio risk.

    The diversification ratio is `w'sigma / sqrt(w'Sw)`: the risk the
    book would carry if nothing diversified anything, over the risk it
    actually carries. It is one for a single asset and rises as the
    holdings become less alike. Choueifaty and Coignard's Most
    Diversified Portfolio is the long-only book that maximises it.

    The implementation uses their own reduction rather than a general
    optimiser, which is both faster and more transparent. Substitute
    `y_i = sigma_i w_i`; then `w'sigma = sum y` and `w'Sw = y'Ry`, where
    `R` is the correlation matrix. Maximising the ratio is therefore
    minimising `y'Ry` on the simplex — the minimum-variance problem
    again, run on correlations rather than covariances — after which
    `w_i = y_i / sigma_i`, renormalised. So the MDP is the
    minimum-variance portfolio of the correlation matrix, rescaled by
    inverse volatility, and the same solver serves both classes. No
    inverse appears anywhere, which matters more here than anywhere else
    in the file: the ratio is maximised by loading onto whichever pair
    the estimate shows as least correlated, and that is precisely the
    pair the estimation error most flattered.

    Expect concentration. The MDP is willing to hold a subset rather
    than the whole list — the ratio is maximised at a corner whenever
    one asset's correlations dominate another's — and on a sector book
    whose pairwise correlations all run high, the subset can be small.
    That is the published behaviour rather than a bug, and it is why the
    paper spends as long as it does on turnover.
    """

    key = "maximum-diversification"
    title = "Maximum Diversification (long-only)"
    citation = (
        "Yves Choueifaty and Yves Coignard, 'Toward Maximum "
        "Diversification', Journal of Portfolio Management 35(1), Fall "
        "2008, 40-51"
    )
    #: The Fall 2008 issue, dated to the first of October. The issue is
    #: quarterly and the exact street date is not something this file can
    #: verify, so the ambiguity is about a month either way — which
    #: lands inside the worst quarter of the financial crisis and is
    #: therefore worth stating rather than rounding away.
    published_on = date(2008, 10, 1)
    universe = US_SECTOR_UNIVERSE
    rationale = (
        "Diversification can be measured rather than gestured at: the "
        "ratio of a portfolio's weighted average constituent volatility "
        "to its own volatility is one when the book is a single bet and "
        "rises as its holdings stop moving together. Under the assumption "
        "that risk premia are proportional to risk, the portfolio "
        "maximising that ratio is the one maximising the Sharpe ratio "
        "without any return forecast — and it is neither the "
        "cap-weighted index, which concentrates in whatever has risen, "
        "nor the minimum-variance book, which concentrates in whatever is "
        "quiet."
    )
    as_published = (
        "(1) UNIVERSE. The paper's results are on equity universes built "
        "from stocks; this runs over the eleven US sector SPDRs, the same "
        "substitution the minimum-variance class makes and for the same "
        "reason, kept identical so the two are directly comparable. "
        "(2) LONG ONLY, which the published MDP also is, and UNLEVERED, "
        "which it also is — this is the one strategy in this module whose "
        "leverage profile we can match. (3) Covariance is this "
        "repository's shrunk estimate rather than the sample matrix. "
        "That departure bites harder here than elsewhere: the MDP loads "
        "on the least-correlated pairs, so shrinking every correlation "
        "toward the average deliberately dulls the exact edge of the "
        "estimate the strategy exploits, and the replication should be "
        "read as the shrunk version of the published rule rather than as "
        "the rule itself. (4) No rebalancing calendar is imposed; see "
        "the base class."
    )

    def _solve(self, model: RiskModel) -> SolverResult:
        # The reduction in the class docstring: min-variance on the
        # CORRELATION matrix, then undo the substitution y = D w.
        solution = _min_variance_on_simplex(
            model.correlation.to_numpy(dtype="float64"),
            max_iterations=self.max_iterations,
            tolerance=self.tolerance,
        )
        scaled = solution.weights / model.sigma()
        total = float(scaled.sum())
        if not math.isfinite(total) or total <= _EPS:
            raise RiskParityError(
                "the maximum-diversification rescaling collapsed. Every "
                "volatility is floored positive in `risk_model`, so a "
                "vanishing total here means the solver returned nothing "
                "rather than that the market did something."
            )
        return SolverResult(
            _clean(scaled / total),
            solution.converged,
            solution.iterations,
            solution.degenerate,
        )


#: The family, in the order this file argues them. Offered so a runner
#: can enumerate without importing four names and getting three.
RISK_BASED_STRATEGIES: tuple[type[_RiskBased], ...] = (
    InverseVolatilityRiskParity,
    EqualRiskContribution,
    MinimumVariance,
    MaximumDiversification,
)
