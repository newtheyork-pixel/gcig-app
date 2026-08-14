"""Stage 3, gate one: each signal measured alone, before the blend counts.

The brief requires every signal be built AND EVALUATED IN ISOLATION
before the combined system is reported, and the three modules have been
written under that rule — none of them imports another, none has ever
seen a portfolio, and every constant in all three was fixed while the
price cache was cold. What none of them had, until this file, is a
number. `evaluate()` existed in each and had never once been run against
real bars.

So this is the gate, and the order matters: read this before believing
anything `run_sleeves.py` prints. A blend of three signals that
individually say nothing is not a system, it is three ways of dividing
by the same noise, and the combined equity curve is the last place that
would show up.

**The three are not measured the same way, on purpose.**

Trend is a directional forecast and gets the directional test: rank
correlation against forward excess returns at one session and at
twenty-one, with a moving-block interval, a hit rate against the
market's own base rate, the top-minus-bottom spread, and a long/flat
curve per sleeve charged a spread — all of it broken out by sub-period,
because a signal that earned its whole information coefficient in
2008-09 is a different animal from one that worked throughout and a
single pooled number cannot tell them apart.

Volatility and correlation get something else, and the substitution is
stated in the report rather than left for a reader to notice. An
information coefficient asks how well a score ranks future RETURNS. An
inverse-volatility scalar makes no claim about returns — it is a
statement about the SIZE a position has to be — and a correlation
haircut makes none either; it is a risk control, and a risk control
justified by return has already been converted into a return signal by
whoever justified it. Regressing either against forward returns would
produce a number, and that number would be the low-volatility anomaly
or noise. So each is tested against its own claim: does inverse-vol
sizing actually equalise realised risk contributions against equal
dollars, and does the haircut actually raise the effective number of
bets — measured hardest in 2008 and 2020, when correlations went to one
and a diversification rule either earns its keep or does not.

**The signal correlation matrix is the third deliverable and it is the
one with a conclusion attached.** The whole case for running an ensemble
rests on the three not being the same signal wearing three hats. If they
are all correlated above 0.6 the honest response is to say so and reduce
to fewer signals, and this file says it in those words when it is true.

Needs the network. If the pull fails this exits 2 and writes nothing —
an evaluation assembled from whatever happened to be in cache is worse
than no evaluation, because it would be filed next to the ones that
mean something.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START
from griffinquant.data.cache import ParquetCache
from griffinquant.engine.metrics import REPORT_PERIODS, NamedPeriod
from griffinquant.portfolio import sizing
from griffinquant.portfolio.sleeves import SLEEVES
from griffinquant.signals import correlation, trend, volatility
from griffinquant.util import runs
from griffinquant.util.runs import Check, DataUnavailable, Sample, Source

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "signal_evaluation.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA

#: Above this, the brief's instruction is to stop defending the ensemble
#: and reduce it. Quoted from the brief rather than chosen here, which is
#: the only way a threshold like this survives contact with a result it
#: dislikes.
ENSEMBLE_RHO_LIMIT = 0.60

#: A daily rank information coefficient at asset-class level lives in the
#: low single digits of a percent. Anything an order of magnitude larger
#: is a date-alignment bug far more often than it is an edge, and this
#: file would rather fail loudly and be argued with than print it.
SUSPICIOUS_IC = 0.15

#: The same bar the brief sets for the combined system, applied here to
#: the standalone diagnostic curves. A long/flat curve on ONE sleeve
#: clearing it is not a discovery; it is a reason to go and look at the
#: fill lag.
SUSPICIOUS_SHARPE = 1.2

#: Reporting cadence for anything that has to be recomputed date by
#: date. Consecutive daily correlation estimates share 251 of their 252
#: observations, so a daily table prints five thousand nearly identical
#: rows and invites them to be counted as five thousand observations.
DEFAULT_STEP = 5

#: Sleeve lookup under BOTH spellings. A panel may be columned by sleeve
#: key or by vehicle ticker — the rest of the project uses both — and a
#: lookup that only understood one would silently print the ticker in the
#: column headed with the sleeve's name and nobody would notice.
_SLEEVE_BY_ALIAS = {alias: s for s in SLEEVES for alias in (s.key, s.ticker)}

#: Fixed decimal places, named once. A column of ratios rendered with a
#: per-cell format is a column nobody can scan down.
def _n2(v: Any) -> str:
    return runs.num(v, 2)


def _n3(v: Any) -> str:
    return runs.num(v, 3)


def _n4(v: Any) -> str:
    return runs.num(v, 4)


app = typer.Typer(add_completion=False)


# -- the panel ----------------------------------------------------------


def load_panel(
    start: date,
    end: date,
    *,
    source: Source,
    cache: ParquetCache | None,
) -> Sample:
    """Every sleeve vehicle's total-return closes, plus the bill hurdle.

    A seam as much as a function: the tests drive the whole script
    through this name against a synthetic panel, which is the only way
    to prove the plumbing without a price feed.
    """
    return runs.load_sample(start, end, source=source, cache=cache)


def _risk_panel(sample: Sample) -> pd.DataFrame:
    """The panel with the cash vehicle taken out.

    Not tidiness. Cash has almost no risk, so equal-dollar weighting
    hands it a ninth of the book and none of the risk, and any scheme
    that notices wins — the inverse-vol comparison run WITH cash in it
    looks spectacular for a reason that has nothing to do with the
    signal. Its weight is the residual in this design anyway, so the
    scalar never decides it.
    """
    drop = [c for c in sample.close_adj.columns if str(c) in trend.NOT_A_TREND_ASSET]
    return sample.close_adj.drop(columns=drop)


# -- the signal correlation matrix --------------------------------------


@dataclass(frozen=True)
class SignalMatrix:
    """How much of each signal is already in the other two.

    Spearman rather than Pearson, for the reason the trend module gives
    about its own IC: the trend score takes four values and the vol
    scalar is a ratio with a long right tail, so a product-moment
    correlation between them would be dominated by a handful of quiet
    sleeves in a handful of quiet months.

    The pooled matrix is the headline and the per-sleeve table is the
    check on it. Pooling stacks nine sleeves onto one axis, so a pooled
    correlation can be manufactured entirely by the sleeves differing
    from each other in a way that every signal notices — the per-sleeve
    rows measure each signal pair inside one sleeve's own history, where
    that cannot happen.
    """

    matrix: pd.DataFrame
    per_sleeve: pd.DataFrame
    n_cells: int
    n_dates: int
    step: int
    limit: float

    @property
    def pairs(self) -> tuple[tuple[str, str, float], ...]:
        names = list(self.matrix.columns)
        return tuple(
            (names[i], names[j], float(self.matrix.iloc[i, j]))
            for i in range(len(names))
            for j in range(i + 1, len(names))
        )

    @property
    def crowded(self) -> tuple[tuple[str, str, float], ...]:
        return tuple(p for p in self.pairs if abs(p[2]) > self.limit)

    @property
    def all_crowded(self) -> bool:
        pairs = self.pairs
        return bool(pairs) and len(self.crowded) == len(pairs)

    @property
    def verdict(self) -> str:
        if not self.pairs:
            return (
                "Not measurable: fewer than two signals produced a value on "
                "any shared date, so there is no ensemble question to answer."
            )
        worst = max(self.pairs, key=lambda p: abs(p[2]))
        if self.all_crowded:
            return (
                f"EVERY PAIR IS ABOVE {self.limit:.2f} — REDUCE TO FEWER "
                f"SIGNALS. The three are measuring one thing between them "
                f"(worst pair {worst[0]}/{worst[1]} at {worst[2]:+.3f}), and "
                f"an ensemble of three views of one view is a single signal "
                f"with two extra parameters and a wider confidence interval. "
                f"The brief's instruction in this case is explicit and this "
                f"line is it."
            )
        if self.crowded:
            named = ", ".join(f"{a}/{b} {r:+.3f}" for a, b, r in self.crowded)
            return (
                f"{len(self.crowded)} of {len(self.pairs)} pairs sit above "
                f"{self.limit:.2f} ({named}). Not the brief's reduce-to-fewer "
                f"case, which needs all of them, but the crowded pair is "
                f"contributing less than a reader would assume from its being "
                f"counted as a separate signal."
            )
        return (
            f"All {len(self.pairs)} pairs sit inside ±{self.limit:.2f} (worst "
            f"{worst[0]}/{worst[1]} at {worst[2]:+.3f}). The ensemble's "
            f"premise survives this test: the three are not restatements of "
            f"each other. That is a statement about their scores and not "
            f"about any of them being right."
        )


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Rank correlation, ties averaged, NaN where either side is constant.

    NaN and not zero on a constant input: "the signal never moved here"
    and "the signal was uncorrelated here" are different findings, and a
    printed zero reads as the second.
    """
    ok = np.isfinite(a) & np.isfinite(b)
    if int(ok.sum()) < 3:
        return float("nan")
    ra = pd.Series(a[ok]).rank().to_numpy(dtype="float64")
    rb = pd.Series(b[ok]).rank().to_numpy(dtype="float64")
    if ra.std() <= 0.0 or rb.std() <= 0.0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def signal_matrix(
    sample: Sample,
    *,
    step: int = DEFAULT_STEP,
    limit: float = ENSEMBLE_RHO_LIMIT,
) -> SignalMatrix:
    """Each signal's own output, sampled on shared dates, correlated.

    One decision worth defending. The correlation multiplier depends on
    the book it is asked about, and the book the live system asks about
    is the one trend and inverse-vol just proposed — so measuring the
    multiplier against THAT book would guarantee some correlation with
    the other two signals through the input rather than through the
    signal. The multiplier here is therefore measured against the
    equal-weight book, which is `correlation`'s own standalone
    convention and makes it a function of prices alone. The number that
    comes back is a property of the three rules, not of their wiring.
    """
    panel = _risk_panel(sample)
    scores = trend.trend_scores(panel, risk_free=sample.risk_free).score
    scalars = volatility.inverse_volatility_scalar(panel)

    first = min(sizing.REQUIRED_SESSIONS - 1, len(panel) - 1)
    sampled = panel.index[first :: max(int(step), 1)]

    book = pd.Series(1.0 / panel.shape[1], index=[str(c) for c in panel.columns])
    rows: list[dict[str, Any]] = []
    for asof in sampled:
        adjustment = correlation.adjust_weights(book, panel, asof=asof)
        multiplier = adjustment.multiplier
        for asset in panel.columns:
            name = str(asset)
            rows.append(
                {
                    "date": asof,
                    "asset": name,
                    "trend": float(scores.at[asof, asset]),
                    "inverse_vol": float(scalars.at[asof, asset]),
                    "correlation": float(multiplier.get(name, float("nan"))),
                }
            )

    long = pd.DataFrame(rows)
    names = ["trend", "inverse_vol", "correlation"]
    live = long.dropna(subset=names)

    matrix = pd.DataFrame(
        np.eye(len(names)), index=names, columns=names, dtype="float64"
    )
    for i, x in enumerate(names):
        for j, y in enumerate(names):
            if i < j:
                rho = _spearman(
                    live[x].to_numpy(dtype="float64"),
                    live[y].to_numpy(dtype="float64"),
                )
                matrix.iloc[i, j] = rho
                matrix.iloc[j, i] = rho

    per_rows: list[dict[str, Any]] = []
    for asset, block in live.groupby("asset", sort=True):
        sleeve = _SLEEVE_BY_ALIAS.get(str(asset))
        per_rows.append(
            {
                "asset": str(asset),
                "sleeve": sleeve.name if sleeve else str(asset),
                "n": int(len(block)),
                "trend_vs_inverse_vol": _spearman(
                    block["trend"].to_numpy(dtype="float64"),
                    block["inverse_vol"].to_numpy(dtype="float64"),
                ),
                "trend_vs_correlation": _spearman(
                    block["trend"].to_numpy(dtype="float64"),
                    block["correlation"].to_numpy(dtype="float64"),
                ),
                "inverse_vol_vs_correlation": _spearman(
                    block["inverse_vol"].to_numpy(dtype="float64"),
                    block["correlation"].to_numpy(dtype="float64"),
                ),
            }
        )

    return SignalMatrix(
        matrix=matrix,
        per_sleeve=pd.DataFrame(per_rows),
        n_cells=int(len(live)),
        n_dates=int(len(sampled)),
        step=int(step),
        limit=float(limit),
    )


# -- the volatility diagnostic, cut by period ---------------------------


def paired_by_period(
    test: volatility.RiskContributionTest,
    periods: Sequence[NamedPeriod],
) -> pd.DataFrame:
    """The paired inverse-vol-against-equal comparison, window by window.

    `volatility._paired` is reached into deliberately rather than
    reimplemented. It is the definition of a paired win rate in this
    project, and a second copy here would be a second definition — which
    is exactly the kind of divergence that produces two tables in one
    report that disagree and cannot be reconciled by a reader.
    """
    frames: list[pd.DataFrame] = []
    windows = test.windows
    whole = NamedPeriod("full sample", "1900-01-01", None, "everything")
    for p in [whole, *periods]:
        start = pd.Timestamp(p.start)
        end = pd.Timestamp(p.end) if p.end else pd.Timestamp("2262-01-01")
        block = (
            windows.loc[windows["date"].between(start, end)]
            if len(windows)
            else windows
        )
        out = volatility._paired(block)
        if not len(out):
            # A window with no measurable sub-window still gets a row.
            # Dropping it would let a report covering 2010 onward publish
            # a stress table with no 2008 in it and no sign that any was
            # expected.
            out = pd.DataFrame(
                [{"basis": basis} for basis in ("correlation_aware", "standalone")]
            )
        out = out.copy()
        out.insert(0, "period", p.name)
        frames.append(out)
    return pd.concat(frames, ignore_index=True)


# -- the whole evaluation -----------------------------------------------


@dataclass(frozen=True)
class Evaluation:
    sample: Sample
    trend: trend.TrendEvaluation
    volatility: volatility.RiskContributionTest
    vol_periods: pd.DataFrame
    correlation: correlation.EvaluationReport
    matrix: SignalMatrix
    checks: tuple[Check, ...]
    n_bootstrap: int
    step: int

    @property
    def clean(self) -> bool:
        return all(c.passed for c in self.checks)


def _pooled_full_sample(ic: pd.DataFrame) -> pd.DataFrame:
    return ic.loc[(ic["scope"] == "pooled") & (ic["period"] == "full sample")]


def sceptic_checks(
    ev_trend: trend.TrendEvaluation, sample: Sample
) -> tuple[Check, ...]:
    """Attack the numbers above before anybody reports them.

    Every check here is one of the four the brief names — causality by
    truncation, the fill actually landing after the decision, returns
    coming from the total-return series, costs actually charged — asked
    of a diagnostic rather than of a backtest, because that is what this
    file produces. A clean high number nobody attacked is not a result.
    """
    panel = _risk_panel(sample)
    checks: list[Check] = []

    # 1-3. Causality, by literal truncation, for each signal in turn. An
    # off-by-one in a rolling window reads correctly, produces plausible
    # numbers and manufactures a beautiful backtest, so it is checked by
    # cutting the frame rather than by reading the code.
    cut_at = panel.index[int(len(panel) * 0.6)]
    full_scores = trend.trend_scores(panel, risk_free=sample.risk_free).score
    cut_scores = trend.trend_scores(
        panel.loc[:cut_at], risk_free=sample.risk_free
    ).score
    same_trend = full_scores.loc[cut_at].equals(cut_scores.loc[cut_at])
    checks.append(
        Check(
            "Trend scores at T survive truncation after T",
            same_trend,
            f"recomputed on the frame cut at {cut_at.date()}; "
            f"{'identical' if same_trend else 'THE SCORES MOVED'} across "
            f"{int(full_scores.shape[1])} sleeves",
        )
    )

    full_vol = volatility.inverse_volatility_scalar(panel).loc[cut_at]
    cut_vol = volatility.inverse_volatility_scalar(panel.loc[:cut_at]).loc[cut_at]
    same_vol = full_vol.equals(cut_vol)
    checks.append(
        Check(
            "Inverse-vol scalars at T survive truncation after T",
            same_vol,
            f"same date, same frame minus everything after it; "
            f"{'identical' if same_vol else 'THE SCALARS MOVED'}",
        )
    )

    full_corr = correlation.estimate_correlation(panel, asof=cut_at).correlation
    cut_corr = correlation.estimate_correlation(
        panel.loc[:cut_at], asof=cut_at
    ).correlation
    same_corr = bool(
        full_corr.shape == cut_corr.shape
        and np.allclose(
            full_corr.to_numpy(), cut_corr.to_numpy(), atol=0.0, rtol=0.0
        )
    )
    checks.append(
        Check(
            "Correlation matrix at T survives truncation after T",
            same_corr,
            f"{full_corr.shape[0]}x{full_corr.shape[1]} shrunk matrix, "
            f"{'identical to the last bit' if same_corr else 'THE MATRIX MOVED'}",
        )
    )

    # 4. The diagnostic curve does not trade on its own signal's close.
    # The weight standing at T must be the score from FILL_LAG_SESSIONS
    # earlier; a one-session lag would credit the overnight gap in the
    # signal's own direction, most generously in exactly the fast markets
    # that matter.
    lag = trend.FILL_LAG_SESSIONS
    weights = ev_trend.weights
    shifted = full_scores.shift(lag).fillna(0.0)
    aligned = bool(
        weights.shape == shifted.shape
        and np.allclose(
            weights.to_numpy(dtype="float64"),
            shifted.to_numpy(dtype="float64"),
            equal_nan=True,
        )
    )
    checks.append(
        Check(
            f"Curve weight at T is the score from T-{lag}",
            aligned,
            f"{lag}-session fill lag; the curve forfeits the fill session's "
            f"intraday move rather than claiming an overnight gap "
            f"{'(confirmed)' if aligned else '(NOT CONFIRMED)'}",
        )
    )

    # 5. Total-return closes, not price. On close_unadj the bond and
    # credit sleeves return roughly nothing over the sample, so a signal
    # reading the wrong frame does not understate the defensive half of
    # the book, it deletes it.
    rows = sample.prices
    differs = int((rows["close_adj"] != rows["close_unadj"]).sum())
    uses_adj = differs > 0
    checks.append(
        Check(
            "The panel behind every signal is close_adj",
            uses_adj,
            f"{differs:,} of {len(rows):,} bars have an adjusted close "
            f"different from the as-traded one; a panel where the two never "
            f"differ is a price-return series wearing the total-return name",
        )
    )

    # 6. An abstention stayed an abstention. NaN is one `fillna` away
    # from a neutral 0.5 in somebody's downstream frame, and the whole
    # point of the abstention is that it is not a middling opinion.
    banked = trend.trend_scores(panel, risk_free=sample.risk_free)
    holes = int((~banked.known).to_numpy().sum())
    honest = bool(
        banked.score.isna().to_numpy().sum() == holes
        and (banked.score.notna().to_numpy() == banked.known.to_numpy()).all()
    )
    checks.append(
        Check(
            "No score was invented where the signal declined",
            honest,
            f"{holes:,} unscored cells, all of them NaN rather than a "
            f"neutral value",
        )
    )

    # 7. Costs are real and they are charged. A diagnostic curve with a
    # zero cost drag beside a non-zero turnover has a cost model wired to
    # nothing.
    summary = ev_trend.curve_summary
    full = (
        summary.loc[summary["period"] == "full sample"] if len(summary) else summary
    )
    traded = full.loc[full["annual_turnover"] > 0.0] if len(full) else full
    charged = bool(len(traded)) and bool((traded["cost_drag_bps"] > 0.0).all())
    drag = traded["cost_drag_bps"]
    span = (
        f"{runs.bps(float(drag.min()))} to {runs.bps(float(drag.max()))}"
        if len(traded)
        else "nothing, because nothing traded"
    )
    checks.append(
        Check(
            "Costs are applied and non-zero on every curve that traded",
            charged,
            f"{len(traded)} sleeve(s) turned over; drag {span} a year at "
            f"{trend.ONE_WAY_COST_BPS:.2f}bp one way",
        )
    )

    # 8-9. The two numbers that would be evidence of a bug rather than of
    # an edge, checked in the direction that costs us something.
    pooled = _pooled_full_sample(ev_trend.ic)
    worst_ic = float(pooled["ic"].abs().max()) if len(pooled) else float("nan")
    plausible = not (np.isfinite(worst_ic) and worst_ic > SUSPICIOUS_IC)
    checks.append(
        Check(
            f"Pooled information coefficient stays under {SUSPICIOUS_IC:.2f}",
            plausible,
            f"largest |IC| across horizons is {worst_ic:.4f}; above "
            f"{SUSPICIOUS_IC:.2f} at asset-class level this is a date "
            f"alignment bug more often than it is a forecast",
        )
    )

    best_sharpe = (
        float(full["strat_sharpe"].max()) if len(full) else float("nan")
    )
    sober = not (np.isfinite(best_sharpe) and best_sharpe > SUSPICIOUS_SHARPE)
    checks.append(
        Check(
            f"No standalone curve clears a Sharpe of {SUSPICIOUS_SHARPE:.1f}",
            sober,
            f"best single-sleeve long/flat Sharpe is {best_sharpe:.3f} over "
            f"the full sample; the brief's rule is to treat anything above "
            f"{SUSPICIOUS_SHARPE:.1f} as evidence of a bug and hunt",
        )
    )
    return tuple(checks)


def evaluate(
    sample: Sample,
    *,
    n_bootstrap: int = trend.N_BOOTSTRAP,
    step: int = DEFAULT_STEP,
) -> Evaluation:
    """Run all three standalone diagnostics and the ensemble test."""
    ev_trend = trend.evaluate(
        sample.close_adj,
        risk_free=sample.risk_free,
        n_bootstrap=int(n_bootstrap),
    )
    ev_vol = volatility.evaluate(_risk_panel(sample))
    ev_corr = correlation.evaluate(sample.close_adj, step=int(step))
    return Evaluation(
        sample=sample,
        trend=ev_trend,
        volatility=ev_vol,
        vol_periods=paired_by_period(ev_vol, REPORT_PERIODS),
        correlation=ev_corr,
        matrix=signal_matrix(sample, step=step),
        checks=sceptic_checks(ev_trend, sample),
        n_bootstrap=int(n_bootstrap),
        step=int(step),
    )


# -- rendering ----------------------------------------------------------


def _ic_columns() -> list[tuple[Any, ...]]:
    return [
        ("period", "Period", str, "l"),
        ("kind", "Kind", str, "l"),
        ("horizon", "h", lambda v: f"{int(v)}d"),
        ("n", "Obs", runs.count),
        ("ic", "IC", _n4),
        ("ci_low", "CI low", _n4),
        ("ci_high", "CI high", _n4),
        ("n_blocks", "Blocks", runs.count),
        ("note", "Note", lambda v: str(v) if str(v) else "", "l"),
    ]


def _hit_columns() -> list[tuple[Any, ...]]:
    return [
        ("period", "Period", str, "l"),
        ("horizon", "h", lambda v: f"{int(v)}d"),
        ("n_on", "Full-on obs", runs.count),
        ("hit_rate_on", "Hit, full on", runs.pct),
        ("lift_on", "Lift", runs.signed_pct),
        ("n_off", "Full-off obs", runs.count),
        ("hit_rate_off", "Hit, full off", runs.pct),
        ("lift_off", "Lift", runs.signed_pct),
        ("base_rate_positive", "Base rate up", runs.pct),
    ]


def _spread_columns() -> list[tuple[Any, ...]]:
    return [
        ("period", "Period", str, "l"),
        ("horizon", "h", lambda v: f"{int(v)}d"),
        ("n_on", "On", runs.count),
        ("n_off", "Off", runs.count),
        ("mean_on", "Mean, on", runs.signed_pct),
        ("mean_off", "Mean, off", runs.signed_pct),
        ("spread", "Spread", runs.signed_pct),
        ("spread_annualised", "Annualised*", runs.signed_pct),
    ]


def _curve_columns(label: str = "Sleeve") -> list[tuple[Any, ...]]:
    return [
        ("asset", label, str, "l"),
        ("period", "Period", str, "l"),
        ("sessions", "Sessions", runs.count),
        ("time_in_market", "Time in mkt", runs.pct),
        ("annual_turnover", "Turnover/yr", _n2),
        ("cost_drag_bps", "Cost drag", runs.bps),
        ("strat_cagr", "Signal CAGR", runs.signed_pct),
        ("strat_sharpe", "Signal SR", _n2),
        ("strat_max_drawdown", "Signal maxDD", runs.pct),
        ("bh_cagr", "Hold CAGR", runs.signed_pct),
        ("bh_sharpe", "Hold SR", _n2),
        ("bh_max_drawdown", "Hold maxDD", runs.pct),
    ]


def _verdict(ev: Evaluation) -> str:
    if not ev.clean:
        failed = [c.name for c in ev.checks if not c.passed]
        return (
            f"DO NOT USE THESE NUMBERS. {len(failed)} of {len(ev.checks)} "
            f"sceptic checks failed ({'; '.join(failed)}). Every table below "
            f"was produced by the same code that failed them, so the right "
            f"reading of this document is as a bug report."
        )
    return ev.matrix.verdict


def render_markdown(ev: Evaluation, generated_at: datetime, out: Path) -> str:
    s = ev.sample
    ic = ev.trend.ic
    lines: list[str] = []
    add = lines.append

    add("# Signal evaluation — each one alone, before the blend")
    add("")
    add(
        "Stage 3, gate one. Trend, inverse volatility and correlation "
        "measured separately, on their own claims, over the whole sample and "
        "broken out by sub-period. Nothing here has seen a portfolio. Read "
        "it before `reports/stage3_sleeves.md`, because a blend of three "
        "signals that individually say nothing is not a system."
    )
    add("")
    add(f"**{_verdict(ev)}**")
    add("")

    add("## The pull")
    add("")
    add(
        runs.table(
            ["", ""],
            [
                ["Source", s.source_label],
                ["Sample", f"{s.start.date()} to {s.end.date()}"],
                ["Sessions", f"{len(s.sessions):,}"],
                ["Sleeve vehicles", ", ".join(s.tickers)],
                ["Prices", "`close_adj`, total return, and nothing else"],
                ["Risk-free hurdle", s.rf_note],
                ["Cache", s.cache_note],
                [
                    "Bootstrap",
                    f"{ev.n_bootstrap:,} resamples, seed {trend.BOOTSTRAP_SEED}, "
                    f"{trend.CI_LEVEL:.0%} interval",
                ],
                ["Report", str(out)],
            ],
        )
    )
    add("")
    splices, n_splices = runs.spliced_table(s.start.date(), s.end.date())
    add("### Spliced and absent history")
    add("")
    add(
        "Two of the nine vehicles do not reach the sample start, and a "
        "reader must not have to know that to read a table correctly. Every "
        "figure below covering these dates is computed over a book that was "
        "short a sleeve."
        if n_splices
        else "Nothing in this window depends on a splice."
    )
    add("")
    add(splices)
    add("")

    # -- trend ----------------------------------------------------------
    add("## Trend")
    add("")
    add(
        "The only signal in this system that can ask a long-only book to "
        "get out, and therefore the one whose failure costs the most. The "
        "score is the fraction of a sleeve's cap to take, taking one of "
        f"{len(trend.attainable_levels())} values."
    )
    add("")
    add(
        runs.table(
            ["Convention", "What it means"],
            [[k, v] for k, v in ev.trend.conventions.items()],
        )
    )
    add("")
    add(
        "The first three tables run from the close of T and therefore "
        "include the overnight gap the engine cannot trade: they are an "
        "UPPER bound on what is collectable. The curve at the bottom uses "
        f"a {trend.FILL_LAG_SESSIONS}-session lag and is the lower one. The "
        "gap between them is a known quantity rather than a puzzle."
    )
    add("")

    add("### Information coefficient — pooled, by sub-period")
    add("")
    add(
        "Spearman, because the score takes four values and forward returns "
        "are fat-tailed. The interval is a moving-block bootstrap over whole "
        "DATES: nine sleeves on one day are not nine independent "
        "observations, and resampling cells rather than dates would shrink "
        "the interval by about a factor of three. `kind` is `year` only for "
        "the rows that partition the sample — the stress windows overlap "
        "each other and the years, so nothing in this table sums."
    )
    add("")
    pooled = ic.loc[ic["scope"] == "pooled"].sort_values(["horizon", "period"])
    add(runs.frame_table(pooled, _ic_columns()))
    add("")

    add("### Information coefficient — per sleeve, full sample")
    add("")
    per_asset = ic.loc[(ic["scope"] != "pooled") & (ic["period"] == "full sample")]
    add(
        runs.frame_table(
            per_asset.sort_values(["horizon", "scope"]),
            [("scope", "Sleeve", str, "l"), *_ic_columns()[1:]],
        )
    )
    add("")

    add("### Hit rate at the two ends of the range")
    add("")
    add(
        "Measured only where the signal is unambiguous — full conviction "
        "and none — because any interior threshold would be a parameter "
        "chosen by looking at the answer. The base rate travels in the same "
        "row: in a sample where two thirds of months are positive, a 66% hit "
        "rate is the market and not the signal, and `lift` is the column to "
        "read."
    )
    add("")
    hits = ev.trend.hit_rate
    add(
        runs.frame_table(
            hits.loc[hits["scope"] == "pooled"].sort_values(["horizon", "period"]),
            _hit_columns(),
        )
    )
    add("")

    add("### Top-minus-bottom spread")
    add("")
    add(
        "Mean forward excess return on full-on days less the mean on "
        "full-off days. *The annualised column is a scaling of an "
        "overlapping-window mean and is for reading aloud; nobody collected "
        "it."
    )
    add("")
    spread = ev.trend.spread
    add(
        runs.frame_table(
            spread.loc[spread["scope"] == "pooled"].sort_values(
                ["horizon", "period"]
            ),
            _spread_columns(),
        )
    )
    add("")

    add("### Long/flat on each sleeve alone, against costless buy-and-hold")
    add("")
    add(
        f"Weight equal to the score, charged {trend.ONE_WAY_COST_BPS:.2f} bps "
        f"one way on every change, against a buy-and-hold that pays nothing. "
        f"An unscored session is held flat — cash, a position this account "
        f"can actually hold — and `time in mkt` is what says whether a curve "
        f"is really a test of the signal or mostly a test of abstention. One "
        f"variant only: shipping a scaled curve and a binary curve and "
        f"letting a reader pick the better is a two-trial search nobody "
        f"records."
    )
    add("")
    curve = ev.trend.curve_summary
    add("**Full sample**")
    add("")
    add(
        runs.frame_table(
            curve.loc[curve["period"] == "full sample"].sort_values("asset"),
            _curve_columns(),
        )
    )
    add("")
    add("**Stress windows**")
    add("")
    add(
        runs.frame_table(
            curve.loc[curve["kind"] == "stress"].sort_values(["period", "asset"]),
            _curve_columns(),
        )
    )
    add("")
    add("**Calendar years**")
    add("")
    add(
        runs.frame_table(
            curve.loc[curve["kind"] == "year"].sort_values(["period", "asset"]),
            _curve_columns(),
            max_rows=400,
        )
    )
    add("")

    add("### Coverage")
    add("")
    add(
        "`blocked` is not a failure count — a sleeve that lists in 2006 is "
        "going to be blocked for its first 253 sessions and that is the "
        "signal working. A count that climbs LATER in the sample is a hole "
        "in the price frame, which is."
    )
    add("")
    add(
        runs.frame_table(
            ev.trend.coverage,
            [
                ("asset", "Sleeve", str, "l"),
                ("sessions", "Sessions", runs.count),
                ("scored", "Scored", runs.count),
                ("blocked", "Blocked", runs.count),
                ("first_scored", "First score", runs.day, "l"),
                ("last_scored", "Last score", runs.day, "l"),
                ("mean_score", "Mean score", _n3),
            ],
        )
    )
    add("")

    # -- volatility -----------------------------------------------------
    add("## Volatility — and why there is no information coefficient here")
    add("")
    add(
        "**The IC test was substituted, not skipped.** An information "
        "coefficient measures how well a score ranks future RETURNS. An "
        "inverse-volatility scalar makes no claim about returns at all — it "
        "is a statement about the SIZE a position has to be, not about which "
        "direction it should go. Regressing it against forward returns would "
        "produce a number, and that number would be either the "
        "low-volatility anomaly or noise, neither of which is what this "
        "signal claims. So the test below is of the actual claim: that "
        "sizing by inverse volatility produces more equal realised RISK "
        "CONTRIBUTIONS than sizing by equal dollars."
    )
    add("")
    add(
        f"Measured over {ev.volatility.n_windows:,} non-overlapping "
        f"{ev.volatility.horizon}-session windows "
        f"({ev.volatility.n_skipped:,} skipped for want of data), on the "
        f"{len(ev.volatility.assets)} risk sleeves with cash excluded — "
        f"including cash would make inverse-vol look spectacular for a "
        f"mechanical reason, since equal weighting hands a T-bill fund a "
        f"ninth of the book and none of the risk."
    )
    add("")
    add("```")
    add(ev.volatility.verdict)
    add("```")
    add("")
    add("### Dispersion of risk contributions, by sub-period")
    add("")
    add(
        "`standalone` treats each sleeve's risk as its own volatility, which "
        "inverse-vol weights equalise almost by construction — it is here as "
        "an arithmetic check and NOT as evidence. `correlation_aware` uses "
        "the realised covariance of the window and is the real question: "
        "inverse-vol sizing cannot see correlation and never promised "
        "anything here, so three equity sleeves each sized to a modest "
        "standalone risk still move together. Lower dispersion is the more "
        "equal book."
    )
    add("")
    add(
        runs.frame_table(
            ev.vol_periods,
            [
                ("period", "Period", str, "l"),
                ("basis", "Basis", str, "l"),
                ("n_windows", "Windows", runs.count),
                ("mean_n_assets", "Sleeves", lambda v: runs.num(v, 1)),
                ("mean_dispersion_equal", "Dispersion, equal", _n4),
                (
                    "mean_dispersion_inverse_vol",
                    "Dispersion, inv-vol",
                    _n4,
                ),
                ("win_rate", "Inv-vol more equal", runs.pct),
                ("mean_effective_n_equal", "Eff. N, equal", _n2),
                (
                    "mean_effective_n_inverse_vol",
                    "Eff. N, inv-vol",
                    _n2,
                ),
            ],
        )
    )
    add("")

    # -- correlation ----------------------------------------------------
    add("## Correlation — and why there is no information coefficient here either")
    add("")
    add(
        "**Substituted for the same reason and one more.** The haircut is a "
        "risk control, and a risk control that has to be justified by return "
        "has already been converted into a return signal by whoever "
        "justified it. Its claim is that the book after the adjustment "
        "carries fewer duplicated bets than the book before, so that is what "
        "is measured: the effective number of bets and the largest principal "
        "component's share of variance, with and without."
    )
    add("")
    add(
        f"Equal weight across the non-cash sleeves — the one book that "
        f"embodies no view — sampled every {ev.correlation.step} sessions on "
        f"a {ev.correlation.lookback}-session window, "
        f"{ev.correlation.n_dates:,} dates. Both measures are reported "
        f"twice: once against the matrix the adjustment itself used, which "
        f"is what the process knew, and once against the correlations "
        f"REALISED over the following {ev.correlation.forward} sessions, "
        f"which is the version that can say the haircut cut the wrong "
        f"sleeves."
    )
    add("")
    add("```")
    add(ev.correlation.headline)
    add("```")
    add("")
    add("### Effective bets, with and without the haircut")
    add("")
    add(
        "2008 and 2020Q1 are the rows this table exists for: they are the "
        "windows where correlations went to one, which is exactly when a "
        "diversification rule either earns its place or does not. Both "
        "concentration measures are SCALE-INVARIANT in the weights, so they "
        "cannot see the de-risking a uniform haircut performs at all — which "
        "is why invested weight sits beside them rather than instead of "
        "them, and why a fall in effective bets alongside a fall in invested "
        "weight is two true things rather than a contradiction."
    )
    add("")
    add(
        runs.frame_table(
            ev.correlation.periods,
            [
                ("period", "Period", str, "l"),
                ("dates", "Dates", runs.count),
                ("n_sleeves", "Sleeves", lambda v: runs.num(v, 1)),
                ("average_correlation", "Avg pairwise rho", _n3),
                ("mean_book_correlation", "Mean book rho", _n3),
                ("invested_before", "Invested before", runs.pct),
                ("invested_after", "Invested after", runs.pct),
                ("effective_bets_before", "Eff. bets before", _n2),
                ("effective_bets_after", "Eff. bets after", _n2),
                (
                    "forward_effective_bets_before",
                    "Fwd bets before",
                    _n2,
                ),
                (
                    "forward_effective_bets_after",
                    "Fwd bets after",
                    _n2,
                ),
                ("largest_share_after", "Top PC share", runs.pct),
            ],
        )
    )
    add("")

    # -- the matrix -----------------------------------------------------
    add("## The signal correlation matrix")
    add("")
    add(
        "The whole case for running three signals rather than one rests on "
        "these numbers being low. If they are all above "
        f"{ev.matrix.limit:.2f} the brief's instruction is to say so and "
        "reduce to fewer signals, and the line under the table is that "
        "instruction carried out."
    )
    add("")
    add(
        f"Spearman over {ev.matrix.n_cells:,} (date, sleeve) cells from "
        f"{ev.matrix.n_dates:,} dates sampled every {ev.matrix.step} "
        f"sessions. All three are read in the same direction — each is a "
        f"multiplier on how much of a sleeve to hold — so a positive number "
        f"means the two agree about size. The correlation multiplier is "
        f"measured against the EQUAL-WEIGHT book rather than against the "
        f"book trend and inverse-vol just proposed: measuring it against "
        f"their output would guarantee some correlation through the input "
        f"rather than through the signal."
    )
    add("")
    names = list(ev.matrix.matrix.columns)
    add(
        runs.table(
            ["", *names],
            [
                [row, *(runs.num(ev.matrix.matrix.loc[row, col], 3) for col in names)]
                for row in names
            ],
            ["l", *["r"] * len(names)],
        )
    )
    add("")
    add(f"**{ev.matrix.verdict}**")
    add("")
    add("### The same three pairs inside each sleeve's own history")
    add("")
    add(
        "Pooling stacks nine sleeves onto one axis, so a pooled correlation "
        "can be manufactured entirely by the sleeves differing from each "
        "other in a way all three signals notice. These rows measure each "
        "pair within one sleeve, where that cannot happen — if the pooled "
        "matrix is much larger than these, the pooled number is a "
        "cross-sectional artefact."
    )
    add("")
    add(
        "A dash is not a zero. It means one of the two signals never moved "
        "for that sleeve inside the window — most often the correlation "
        "multiplier, which sits at exactly 1.0 for a sleeve that was never "
        "charged a haircut — and a correlation against a constant is "
        "undefined rather than absent."
    )
    add("")
    add(
        runs.frame_table(
            ev.matrix.per_sleeve,
            [
                ("sleeve", "Sleeve", str, "l"),
                ("asset", "Ticker", str, "l"),
                ("n", "Dates", runs.count),
                ("trend_vs_inverse_vol", "Trend / inv-vol", _n3),
                ("trend_vs_correlation", "Trend / corr", _n3),
                (
                    "inverse_vol_vs_correlation",
                    "Inv-vol / corr",
                    _n3,
                ),
            ],
        )
    )
    add("")

    # -- the sceptic ----------------------------------------------------
    add("## What was attacked before any of this was believed")
    add("")
    add(
        "A clean number nobody attacked is not a result. Each row is a way "
        "the tables above could be wrong while looking exactly like this."
    )
    add("")
    add(runs.checks_table(ev.checks))
    add("")

    add("## What this does and does not prove")
    add("")
    add(
        "It proves that three signals were measured apart, on their own "
        "claims, before any of them was combined with the others — which is "
        "the only condition under which a contribution can be attributed to "
        "a signal rather than to the fit. It proves nothing about the "
        "combined system: the sizing layer applies these in a fixed order "
        "with caps and a budget on top, and none of the arithmetic above "
        "knows that layer exists."
    )
    add("")
    add(
        "It also proves nothing out of sample. Every window here is a window "
        "the sample contains, each stress period is ONE draw of a crisis, "
        "and the sub-period breakouts exist to show where a result came from "
        "rather than to multiply the evidence for it."
    )
    add("")
    add(f"_Generated {runs.stamp(generated_at)} by `evaluate_signals.py`._")
    add("")
    return "\n".join(lines)


def print_console(ev: Evaluation) -> None:
    out = typer.echo
    s = ev.sample
    out("")
    out(
        f"  Signals, standalone: {s.start.date()} to {s.end.date()} "
        f"({len(s.sessions):,} sessions, {len(s.tickers)} vehicles)"
    )
    out("")
    pooled = _pooled_full_sample(ev.trend.ic)
    for _, row in pooled.iterrows():
        interval = (
            f"[{row['ci_low']:+.4f}, {row['ci_high']:+.4f}]"
            if np.isfinite(row["ci_low"])
            else "no interval"
        )
        out(
            f"  trend IC, {int(row['horizon'])}-session forward: "
            f"{row['ic']:+.4f}  {interval}  n={int(row['n']):,}"
        )
    out("")
    for line in ev.volatility.verdict.splitlines():
        out(f"  {line}")
    out("")
    out(f"  {ev.correlation.headline}")
    out("")
    names = list(ev.matrix.matrix.columns)
    out(f"  signal correlations ({ev.matrix.n_cells:,} cells):")
    for a, b, rho in ev.matrix.pairs:
        flag = "  <- above the limit" if abs(rho) > ev.matrix.limit else ""
        out(f"    {a} / {b}: {rho:+.3f}{flag}")
    out("")
    for check in ev.checks:
        out(f"  [{check.verdict}] {check.name}")
    out("")
    out(f"  {_verdict(ev)}")
    out("")


# -- the entry point ----------------------------------------------------


def _generated_at() -> datetime:
    """One clock reading, threaded through everything the run emits."""
    return runs.utcnow()


@app.command()
def main(
    start: str = typer.Option(SAMPLE_START, "--start", help="First session, ISO."),
    end: str = typer.Option("", "--end", help="Last session; blank means today."),
    out: Path = typer.Option(DEFAULT_REPORT, "--out", help="Where to write."),
    source: Source = typer.Option(
        Source.free, "--source", help="Which price feed to pull from."
    ),
    no_cache: bool = typer.Option(
        False, "--no-cache", help="Ignore the parquet cache and refetch."
    ),
    quiet: bool = typer.Option(
        False, "--quiet", help="Write the report, print nothing but errors."
    ),
    bootstrap: int = typer.Option(
        trend.N_BOOTSTRAP,
        "--bootstrap",
        help="Resamples behind every confidence interval.",
    ),
    step: int = typer.Option(
        DEFAULT_STEP,
        "--step",
        help="Reporting cadence in sessions for the correlation walks.",
    ),
    trials: Path = typer.Option(
        None,
        "--trials",
        help="Trial ledger to append to. Defaults to the committed one.",
    ),
) -> None:
    generated_at = _generated_at()
    first = date.fromisoformat(start)
    last = date.fromisoformat(end) if end else generated_at.date()
    if last <= first:
        raise typer.BadParameter("--end must fall after --start")
    cache = None if no_cache else ParquetCache()

    try:
        sample = load_panel(first, last, source=source, cache=cache)
    except DataUnavailable as exc:
        raise runs.refuse_no_data(exc, what="no signal was evaluated")

    # Logged BEFORE anything is measured. A trial ledger written after a
    # result is a ledger that can be edited by the result, and the whole
    # value of the count is that it is a denominator nobody chose.
    ledger = runs.Trials(path=trials, when=generated_at)
    window = {"start": first.isoformat(), "end": last.isoformat()}
    ledger.log(
        {
            "signal": "trend",
            "lookbacks": list(trend.LOOKBACKS),
            "horizons": list(trend.DEFAULT_HORIZONS),
            "cost_bps": trend.ONE_WAY_COST_BPS,
            "fill_lag": trend.FILL_LAG_SESSIONS,
            **window,
        },
        "trend, standalone: 3/6/12-month vote blend against the bill hurdle",
    )
    ledger.log(
        {
            "signal": "volatility",
            "short_window": volatility.SHORT_WINDOW,
            "long_window": volatility.LONG_WINDOW,
            "short_weight": volatility.SHORT_WEIGHT,
            "horizon": volatility.EVALUATION_HORIZON,
            **window,
        },
        "inverse volatility, standalone: risk-contribution dispersion "
        "against equal weight",
    )
    ledger.log(
        {
            "signal": "correlation",
            "lookback": correlation.LOOKBACK,
            "rho_free": correlation.RHO_FREE,
            "rho_full": correlation.RHO_FULL,
            "max_haircut": correlation.MAX_HAIRCUT,
            "step": int(step),
            **window,
        },
        "correlation haircut, standalone: effective bets with and without",
    )
    ledger.log(
        {"signal": "ensemble_matrix", "step": int(step), **window},
        "the three signals' pairwise rank correlations, pooled and per sleeve",
    )

    ev = evaluate(sample, n_bootstrap=bootstrap, step=step)

    if not quiet:
        print_console(ev)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(ev, generated_at, out), "utf-8")
    if not quiet:
        typer.echo(f"  report → {out}")
        typer.echo(
            f"  trial ledger: {ledger.distinct:,} distinct configuration(s) "
            f"on file\n"
        )

    raise typer.Exit(EXIT_OK if ev.clean else EXIT_FAILED)


if __name__ == "__main__":
    app()
