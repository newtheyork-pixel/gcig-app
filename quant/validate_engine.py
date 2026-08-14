"""Stage 2: prove the engine did not invent anything.

Buy and hold one security through the whole simulator — settlement,
buffer, turnover budget, whole shares, spread and impact — and then ask
whether the answer is SPY's own total return, less a list of frictions
we can name. It is the only test of a backtester that cannot be gamed
by writing a better strategy, because the correct answer is published
and we did not choose it.

The trap this script exists to avoid is the reconciliation that reports
a gap and shrugs. A gap of "about right" is not a result: every serious
engine bug in the literature — a mark taken from an unadjusted price, a
fill on the signal's own close, a dividend counted twice — lands
somewhere between a tenth of a percent and two percent a year, which is
exactly the range a hand-wave covers. So the arithmetic here is an
identity rather than an estimate. The engine's own NAV walk is

    dNAV_t = MV_{t-1} * r_t + sum_fills du * (A_t - P_t) - cost_t

with A the adjusted close, P the fill price in the same space and r the
security's total return for the day. Every term on the right is
recoverable from the run's own logs and the price panel, so the three
frictions can be peeled off one at a time and the last rung of the
ladder must land ON the engine's reported NAV, not near it. What is
left over is a residual, it is compared against float noise, and if it
is bigger than float noise this script says the engine is broken and
exits non-zero. A number nobody can account for is a bug, and the one
thing a validation script must never do is print it as a finding.

Three frictions, in the order they are removed:

  **Cash that was never invested.** The ledger holds five per cent of
  NAV back from every buy and the turnover budget moves five per cent
  of NAV a day, so the book takes about a month to deploy and then
  permanently runs a cash sleeve earning nothing. Reported split at the
  latch, because the ramp is a one-off and the buffer is forever, and a
  single number reads as one phenomenon.

  **Trading costs.** Spread and impact, at whatever multiple the run
  was configured with.

  **Open-versus-close fill timing.** The decision is taken at a close
  and filled at the next open. The benchmark compounds close to close,
  so every fill carries the intraday move from its open to that
  evening's mark, and over a hundred-odd fills that is a real number
  with no sign to it.

T+1 settlement costs a buy-and-hold run nothing at all, because it
never sells. That is stated in the output rather than omitted: a zero
that is not printed reads as a term somebody forgot.

Needs the network. If the price pull fails this exits 2 and writes no
report — a reconciliation assembled from whatever happened to be in
cache, or from nothing, is worse than no reconciliation, because it
would be filed next to the ones that mean something.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.base import DataSource
from griffinquant.data.keyedsleeves import KeyedSleeveSource
from griffinquant.data.sleevedata import SleeveETFSource
from griffinquant.engine.backtest import (
    BacktestConfig,
    BacktestError,
    BacktestResult,
    BuyAndHold,
    MarketData,
    run_backtest,
)
from griffinquant.engine.costs import CostModel
from griffinquant.engine.ledger import DEFAULT_BUFFER_FRACTION
from griffinquant.engine.metrics import DAYS_PER_YEAR

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "engine_validation.md"

TICKER = "SPY"

#: PASS exits 0, an unexplained gap exits 1, and an unreachable data
#: source exits 2 — the same three-way split `data_audit.py` uses, for
#: the same reason: "we could not check" is not a weaker form of "we
#: checked and it was fine", and the moment it exits 0 somebody wires
#: this into a pipeline and sees green.
EXIT_OK = 0
EXIT_UNEXPLAINED = 1
EXIT_NO_DATA = 2

#: How close the last rung has to land on the engine's own NAV before
#: we are willing to say the gap is fully explained.
#:
#: This is a float-noise budget, not a modelling tolerance. Rebuilding
#: twenty-one years of NAV as a product of five thousand daily factors
#: accumulates about 1e-12 of relative error; anything at 1e-8 of a
#: half-million-dollar terminal value is half a cent, which is far below
#: the smallest real bug and far above the arithmetic.
RESIDUAL_TOLERANCE = 1e-8

#: The most of NAV the account can actually hold. Not a strategy
#: choice: the ledger's buffer is five per cent of NAV and sits outside
#: every buy, so a target of 1.0 would spend the whole run deferring the
#: last five per cent and the log would fill with events that say
#: nothing except that the target was impossible.
MAX_INVESTABLE = 1.0 - DEFAULT_BUFFER_FRACTION

app = typer.Typer(add_completion=False)


class DataUnavailable(RuntimeError):
    """The price pull failed. Distinct from a failed reconciliation."""


# -- the reconciliation ---------------------------------------------------


@dataclass(frozen=True)
class Rung:
    """One step down the ladder from the benchmark to the engine."""

    label: str
    terminal: float
    cagr: float
    #: What was removed to get here from the rung above, in dollars of
    #: terminal wealth and in annualised return.
    step_dollars: float
    step_cagr: float
    note: str


@dataclass(frozen=True)
class Reconciliation:
    start: pd.Timestamp
    end: pd.Timestamp
    years: float
    sessions: int
    starting_cash: float

    benchmark_terminal: float
    benchmark_cagr: float
    engine_terminal: float
    engine_cagr: float

    rungs: tuple[Rung, ...]
    residual_dollars: float
    residual_relative: float

    #: The cash drag, split at the day the book finished deploying.
    ramp_drag_cagr: float
    buffer_drag_cagr: float
    deployed_on: pd.Timestamp | None
    sessions_to_deploy: int | None
    mean_invested_weight_after_deploy: float

    total_cost: float
    spread_cost: float
    impact_cost: float
    n_trades: int
    n_sales: int
    #: Fills whose liquidity input was missing at the decision close and
    #: were therefore priced at the curve's least-liquid anchor.
    n_blind_liquidity: int
    n_deferrals: int
    n_postponed: int
    stale_marks: int
    pending_settlement: int

    @property
    def gap_cagr(self) -> float:
        return self.benchmark_cagr - self.engine_cagr

    @property
    def explained(self) -> bool:
        return self.residual_relative <= RESIDUAL_TOLERANCE


def _cagr(terminal: float, start: float, years: float) -> float:
    if years <= 0 or start <= 0 or terminal <= 0:
        return float("nan")
    return float((terminal / start) ** (1.0 / years) - 1.0)


def reconcile(
    result: BacktestResult, market: MarketData, ticker: str = TICKER
) -> Reconciliation:
    """Peel three frictions off the benchmark and land on the engine.

    Every input here comes either from the price panel or from the run's
    own logs. Nothing is fitted, nothing is a plug, and the last line is
    a subtraction that has to come out at zero.
    """
    daily = result.daily
    idx = pd.DatetimeIndex(daily["date"])
    v0 = float(result.config.starting_cash)

    adj = market.close_adj[ticker].reindex(idx)
    unadj = market.close_unadj[ticker].reindex(idx)
    if adj.isna().any():
        raise BacktestError(
            f"{ticker} has {int(adj.isna().sum())} session(s) with no adjusted "
            "close inside the sample. The identity below assumes a mark on "
            "every day; carrying one forward would make the residual a "
            "statement about the data rather than about the engine."
        )

    # r_t: the security's own total return. The first session has no
    # prior close inside the sample, and both sides of the comparison
    # start there, so its return is zero for the benchmark as well.
    r = adj.pct_change().fillna(0.0).to_numpy(dtype="float64")

    nav = daily["nav"].to_numpy(dtype="float64")
    mv = daily["market_value"].to_numpy(dtype="float64")
    cost = daily["cost"].to_numpy(dtype="float64")

    # Yesterday's closing NAV and market value. Before the first
    # session the book is all cash, which is what the engine starts
    # from too.
    nav_prev = np.concatenate([[v0], nav[:-1]])
    mv_prev = np.concatenate([[0.0], mv[:-1]])

    # a_t — participation. The fraction of NAV that was actually in the
    # security overnight, times what the security did.
    a = (mv_prev / nav_prev) * r

    # c_t — costs, as a fraction of the capital that paid them.
    c = -cost / nav_prev

    # b_t — fill timing. Each fill enters at the open and is marked at
    # that evening's close, so it carries the intraday move that the
    # benchmark's close-to-close compounding never sees. In adjusted
    # space A_t / P_t reduces to the unadjusted close over the traded
    # price, because both carry the same day's adjustment factor.
    b = np.zeros_like(a)
    trades = result.trades
    if len(trades):
        sign = np.where(trades["side"].to_numpy() == "buy", 1.0, -1.0)
        traded_price = trades["price"].to_numpy(dtype="float64")
        notional = trades["notional"].to_numpy(dtype="float64")
        close_at_fill = unadj.reindex(pd.DatetimeIndex(trades["date"])).to_numpy()
        intraday = sign * notional * (close_at_fill / traded_price - 1.0)
        by_day = (
            pd.Series(intraday, index=pd.DatetimeIndex(trades["date"]))
            .groupby(level=0)
            .sum()
            .reindex(idx)
            .fillna(0.0)
            .to_numpy(dtype="float64")
        )
        b = by_day / nav_prev

    years = float((idx[-1] - idx[0]).days) / DAYS_PER_YEAR

    def wealth(*terms: np.ndarray) -> float:
        return float(v0 * np.prod(1.0 + sum(terms)))

    bench = wealth(r)
    after_cash = wealth(a)
    after_costs = wealth(a, c)
    after_timing = wealth(a, b, c)
    engine = float(result.equity.iloc[-1])

    rungs = (
        Rung(
            label=f"{ticker} total return, from close_adj",
            terminal=bench,
            cagr=_cagr(bench, v0, years),
            step_dollars=0.0,
            step_cagr=0.0,
            note="the published answer; nothing of ours is in it",
        ),
        Rung(
            label="less cash the account never invested",
            terminal=after_cash,
            cagr=_cagr(after_cash, v0, years),
            step_dollars=after_cash - bench,
            step_cagr=_cagr(after_cash, v0, years) - _cagr(bench, v0, years),
            note=(
                "the turnover budget's ramp plus the ledger's permanent "
                f"{DEFAULT_BUFFER_FRACTION:.0%} buffer, earning nothing"
            ),
        ),
        Rung(
            label="less spread and impact",
            terminal=after_costs,
            cagr=_cagr(after_costs, v0, years),
            step_dollars=after_costs - after_cash,
            step_cagr=_cagr(after_costs, v0, years) - _cagr(after_cash, v0, years),
            note=f"at {result.config.cost_model.multiple:g}x the base assumption",
        ),
        Rung(
            label="less open-versus-close fill timing",
            terminal=after_timing,
            cagr=_cagr(after_timing, v0, years),
            step_dollars=after_timing - after_costs,
            step_cagr=_cagr(after_timing, v0, years) - _cagr(after_costs, v0, years),
            note=(
                "decided at a close, filled at the next open; the sign of "
                "this one is not ours to choose"
            ),
        ),
    )

    # The cash drag split at the latch, because the ramp is a one-off
    # and the buffer is forever, and one number reads as one
    # phenomenon. Done in log space, where the two windows add exactly
    # — and therefore where the two effects COMPOUND exactly to the
    # cash-drag rung above rather than nearly summing to it.
    #
    # The sign is worth stating: each figure is the effect on the
    # annualised return, so a negative number is a cost. A POSITIVE one
    # is not an error, it is the honest reading of a window in which
    # being under-invested happened to help. That is luck rather than
    # design and the report says so.
    drag = np.log1p(r) - np.log1p(a)
    deployed_on: pd.Timestamp | None = None
    sessions_to_deploy: int | None = None
    if len(trades):
        deployed_on = pd.Timestamp(trades["date"].max())
        sessions_to_deploy = int(idx.searchsorted(deployed_on, side="right"))
    ramp = np.zeros_like(drag, dtype=bool)
    if sessions_to_deploy is not None:
        ramp[:sessions_to_deploy] = True

    def drag_cagr(mask: np.ndarray) -> float:
        if years <= 0:
            return float("nan")
        return float(math.expm1(-float(drag[mask].sum()) / years))

    ramp_effect = drag_cagr(ramp)
    buffer_effect = drag_cagr(~ramp)

    # The two halves have to compound back to the rung they were split
    # out of. If they do not, the split is describing some other
    # quantity than the one the ladder measured, and a reader would
    # have no way to tell.
    combined = (1.0 + ramp_effect) * (1.0 + buffer_effect)
    implied = (1.0 + rungs[1].cagr) / (1.0 + rungs[0].cagr)
    if years > 0 and not math.isclose(combined, implied, rel_tol=1e-9):
        raise BacktestError(
            f"the ramp/buffer split ({combined:.12f}) does not compound "
            f"back to the cash-drag rung ({implied:.12f})"
        )

    after = daily.loc[~ramp, "invested_weight"]
    sales = trades.loc[trades["side"] == "sell"] if len(trades) else trades

    # Fills the cost model priced blind. The rolling median dollar
    # volume needs ten sessions before it returns anything, so the
    # earliest fills of any run are charged at the curve's least-liquid
    # anchor — a hundred basis points round trip on what is in fact the
    # most liquid instrument in the world. That is the cost model being
    # pessimistic where it is ignorant, which is the correct direction,
    # but it is a one-off artefact of where the sample begins rather
    # than a statement about SPY and it belongs in the report.
    blind = 0
    if len(trades) and market.dollar_volume is not None:
        adv_at_decision = market.dollar_volume[ticker].reindex(
            pd.DatetimeIndex(trades["decision_date"])
        )
        blind = int(adv_at_decision.isna().sum())

    residual = after_timing - engine
    return Reconciliation(
        start=idx[0],
        end=idx[-1],
        years=years,
        sessions=len(idx),
        starting_cash=v0,
        benchmark_terminal=bench,
        benchmark_cagr=_cagr(bench, v0, years),
        engine_terminal=engine,
        engine_cagr=_cagr(engine, v0, years),
        rungs=rungs,
        residual_dollars=residual,
        residual_relative=abs(residual) / max(abs(engine), 1.0),
        ramp_drag_cagr=ramp_effect,
        buffer_drag_cagr=buffer_effect,
        deployed_on=deployed_on,
        sessions_to_deploy=sessions_to_deploy,
        mean_invested_weight_after_deploy=(
            float(after.mean()) if len(after) else float("nan")
        ),
        total_cost=float(result.cost_breakdown["total"]),
        spread_cost=float(result.cost_breakdown["spread"]),
        impact_cost=float(result.cost_breakdown["impact"]),
        n_trades=int(len(trades)),
        n_sales=int(len(sales)),
        n_blind_liquidity=blind,
        n_deferrals=int(len(result.deferrals)),
        n_postponed=int(len(result.postponed)),
        stale_marks=int(len(result.stale_marks)),
        pending_settlement=int(len(result.pending_settlement)),
    )


# -- the run ---------------------------------------------------------------


def load_panel(
    start: date,
    end: date,
    *,
    cache: ParquetCache | None,
    source_name: str = "free",
) -> MarketData:
    """One security, from the sleeve source, pivoted into engine shape.

    This file predates the keyed fallback, and reaching for the free
    endpoint unconditionally is exactly how it went unrunnable for five
    hours during a throttle while a perfectly good cached pull sat on
    disk under another source's slug. The switch is the same one the
    other runners take.
    """
    if source_name == "free":
        source: DataSource = SleeveETFSource(allowed=[TICKER], cache=cache)
    else:
        source = KeyedSleeveSource(source_name, allowed=[TICKER], cache=cache)
    try:
        prices = source.prices(start, end)
    except SourceUnavailable as exc:
        raise DataUnavailable(str(exc)) from exc

    if prices.empty:
        raise DataUnavailable(
            f"the price pull returned no {TICKER} bars between "
            f"{start.isoformat()} and {end.isoformat()}. An empty frame is "
            "not a market fact here — it is the shape of a failed request."
        )
    return MarketData.from_prices(prices, key="ticker")


def validation_config(cost_multiple: float = 1.0) -> BacktestConfig:
    """The real engine, with one cap deliberately lifted.

    `apply_sleeve_caps=False` is the only concession, and it is not a
    loosening of the account's rules: SPY is capped at 40% because it is
    ONE SLEEVE of a nine-sleeve book, and a validation run holding 40%
    SPY and 60% idle cash would reconcile against a benchmark that is
    mostly a statement about the buffer. Everything that is an
    account-level fact — settlement, the buffer, whole shares, the
    turnover budget, the cost model — stays exactly as a real run has
    it.
    """
    return BacktestConfig(
        apply_sleeve_caps=False,
        default_max_weight=1.0,
        caps={},
        cost_model=CostModel(multiple=cost_multiple),
        band_provenance=(
            "not tuned and not consulted; this is a validation run of a "
            "single latched position, where the band can only ever prevent "
            "a trade the strategy was not asking for"
        ),
    )


# -- rendering -------------------------------------------------------------


def _money(x: float) -> str:
    return f"${x:,.2f}"


def _pct(x: float) -> str:
    """Percentage points, dropping to basis points rather than to zero.

    A real effect that rounds to "-0.000%" reads as an effect that did
    not happen, and in a table whose whole job is to account for a gap
    that is the one rendering mistake worth avoiding.
    """
    if x != x:
        return "n/a"
    if x != 0.0 and abs(x) < 5e-6:
        return f"{x * 1e4:+.3f} bps"
    return f"{x * 100:+.3f}%"


def verdict_line(rec: Reconciliation) -> str:
    if rec.explained:
        return (
            f"RECONCILED. The engine came in {_pct(-rec.gap_cagr)} a year "
            f"against {TICKER}'s own total return, and all of that "
            f"difference is accounted for by cash, costs and fill timing: "
            f"the ladder lands on the engine's reported NAV to "
            f"{_money(abs(rec.residual_dollars))}."
        )
    return (
        f"UNEXPLAINED GAP — THIS IS A BUG IN THE ENGINE. After removing "
        f"cash drag, trading costs and fill timing, "
        f"{_money(abs(rec.residual_dollars))} of terminal wealth "
        f"({rec.residual_relative:.3e} of NAV) is left over. The engine's "
        f"NAV is not the sum of its own parts, so something is being "
        f"created or destroyed inside the loop. Do not report the CAGR "
        f"above as a result."
    )


def render_markdown(rec: Reconciliation, result: BacktestResult, weight: float) -> str:
    cfg = result.config
    lines: list[str] = []
    add = lines.append

    add("# Engine validation — buy and hold SPY")
    add("")
    add(
        "Stage 2. One security, held through the whole simulator, "
        "reconciled against its own published total return. The question "
        "is not whether the engine makes money — it is whether the money "
        "it makes is arithmetic anybody can follow."
    )
    add("")
    add(f"**{verdict_line(rec)}**")
    add("")

    add("## The run")
    add("")
    add("| | |")
    add("|---|---|")
    add(f"| Security | {TICKER}, priced from `close_adj` |")
    add(f"| Sample | {rec.start.date()} to {rec.end.date()} |")
    add(f"| Sessions | {rec.sessions:,} ({rec.years:.2f} years) |")
    add(f"| Starting cash | {_money(rec.starting_cash)} |")
    add(f"| Target weight | {weight:.0%} of NAV |")
    add(
        f"| Settlement | T+{cfg.settlement_cycle}, "
        f"{cfg.buffer_fraction:.0%} of NAV held back from every buy |"
    )
    add(f"| Turnover budget | {cfg.max_daily_turnover:.0%} of NAV a day |")
    add(f"| Costs | {cfg.cost_model.label} |")
    add(f"| Whole shares | {'yes' if cfg.whole_shares else 'no'} |")
    add("")

    add("## The reconciliation")
    add("")
    add(
        "Each row removes one friction from the row above it. The steps "
        "are sequential, so the dollar attribution is order-dependent at "
        "second order; the line that has to be exact is the last one, "
        "which is a subtraction rather than an estimate."
    )
    add("")
    add("| | Terminal wealth | CAGR | Step | What it is |")
    add("|---|---:|---:|---:|---|")
    for rung in rec.rungs:
        step = "—" if rung.step_dollars == 0.0 else _money(rung.step_dollars)
        cagr_step = "—" if rung.step_cagr == 0.0 else _pct(rung.step_cagr)
        add(
            f"| {rung.label} | {_money(rung.terminal)} | "
            f"{rung.cagr * 100:.3f}% | {step} / {cagr_step} | {rung.note} |"
        )
    add(
        f"| **engine NAV, as reported** | **{_money(rec.engine_terminal)}** | "
        f"**{rec.engine_cagr * 100:.3f}%** | "
        f"{_money(rec.residual_dollars)} | residual — must be float noise |"
    )
    add("")
    add(
        f"Engine CAGR **{rec.engine_cagr * 100:.3f}%** against benchmark "
        f"**{rec.benchmark_cagr * 100:.3f}%** — the engine less the "
        f"benchmark is **{-rec.gap_cagr * 100:+.3f}** percentage points a "
        f"year. Residual after the three explanations: "
        f"{_money(rec.residual_dollars)}, {rec.residual_relative:.3e} of "
        f"terminal NAV, against a tolerance of {RESIDUAL_TOLERANCE:.0e}."
    )
    add("")

    add("## Where the gap comes from")
    add("")
    add(
        "Every figure in the middle column is an effect on the annualised "
        "return, so a negative number is a cost. A positive one is not a "
        "mistake — it is a window in which being under-invested, or "
        "filling at an open rather than a close, happened to help. That is "
        "luck and not design, and the two cash rows compound (they do not "
        "sum) to the cash-drag rung in the ladder above."
    )
    add("")
    add("| Cause | Effect on CAGR | Detail |")
    add("|---|---:|---|")
    add(
        f"| Deployment ramp | {_pct(rec.ramp_drag_cagr)} | "
        f"the turnover budget moves {cfg.max_daily_turnover:.0%} of NAV a "
        f"day, so the book took "
        f"{rec.sessions_to_deploy or 0} session(s) to finish buying |"
    )
    add(
        f"| Permanent cash buffer | {_pct(rec.buffer_drag_cagr)} | "
        f"mean invested weight after the latch "
        f"{rec.mean_invested_weight_after_deploy:.1%}; the rest is settled "
        f"cash earning nothing |"
    )
    add(
        f"| Spread and impact | {_pct(rec.rungs[2].step_cagr)} | "
        f"{_money(rec.total_cost)} actually paid "
        f"({_money(rec.spread_cost)} spread, {_money(rec.impact_cost)} "
        f"impact) across {rec.n_trades} fill(s); "
        f"{_money(-rec.rungs[2].step_dollars)} of terminal wealth once the "
        f"forgone compounding is counted |"
    )
    if rec.n_blind_liquidity:
        add(
            f"| — of which priced blind | | {rec.n_blind_liquidity} fill(s) "
            f"had no median dollar volume yet (the window needs ten "
            f"sessions) and were charged at the curve's least-liquid "
            f"anchor, 100bp round trip. Pessimistic in the right "
            f"direction, and an artefact of where the sample starts "
            f"rather than a fact about {TICKER} |"
        )
    add(
        f"| Open-versus-close fill timing | {_pct(rec.rungs[3].step_cagr)} | "
        f"{_money(rec.rungs[3].step_dollars)} of terminal wealth. Unsigned "
        f"by nature: over {rec.n_trades} fills it is whatever the intraday "
        f"tape did |"
    )
    if rec.n_sales == 0:
        add(
            "| T+1 settlement | +0.000% | "
            "buy-and-hold never sells, so no proceeds ever wait to settle "
            "and the constraint costs this run exactly nothing. Printed "
            "rather than omitted: an absent term reads as a forgotten one |"
        )
    else:
        # Not reachable for a latched buy-and-hold, and left in rather
        # than asserted away because the honest failure of a hardcoded
        # zero is that it stays zero after somebody changes the control.
        add(
            f"| T+1 settlement | folded into the cash row | "
            f"{rec.n_sales} sale(s) in the log, so settlement DID bind. "
            f"Its cost is inside the cash-drag rung and is not separated "
            f"out here — this script was written for a control that never "
            f"sells, and the number above cannot be read as a T+1 cost |"
        )
    add("")

    add("## Engine hygiene")
    add("")
    add("| | |")
    add("|---|---|")
    add(f"| Fills | {rec.n_trades} |")
    add(f"| Postponed (budget, depth, min ticket) | {rec.n_postponed} |")
    add(f"| Cash deferrals | {rec.n_deferrals} |")
    stale_note = (
        " — a mark carried forward would invalidate the identity above"
        if rec.stale_marks
        else ""
    )
    add(f"| Stale marks | {rec.stale_marks}{stale_note} |")
    add(f"| Receivables unsettled at the end | {rec.pending_settlement} |")
    add("")
    add(
        "The ledger's NAV invariant — settled plus unsettled plus market "
        "value equals NAV — is checked inside the loop on every one of "
        f"the {rec.sessions:,} sessions. A run that finishes has already "
        "passed it."
    )
    add("")

    add("## What this does and does not prove")
    add("")
    add(
        "It proves the plumbing: positions are marked in total-return "
        "space, fills land on the next open, costs are charged once, cash "
        "is conserved, and the reported NAV is the sum of terms this "
        "script can rebuild independently. It proves nothing whatsoever "
        "about a strategy, because there is no strategy here — the "
        "control was chosen precisely because its correct answer is "
        "published and we did not get to pick it."
    )
    add("")
    add(
        f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} "
        f"by `validate_engine.py`._"
    )
    add("")
    return "\n".join(lines)


def print_console(rec: Reconciliation) -> None:
    out = typer.echo
    out("")
    out(f"  Buy and hold {TICKER}: {rec.start.date()} to {rec.end.date()} "
        f"({rec.sessions:,} sessions, {rec.years:.2f} years)")
    out("")
    width = max(len(r.label) for r in rec.rungs) + 2
    for rung in rec.rungs:
        step = "" if rung.step_dollars == 0.0 else f"   {rung.step_dollars:>14,.2f}"
        out(f"  {rung.label:<{width}} {rung.terminal:>14,.2f}  "
            f"{rung.cagr * 100:>7.3f}%{step}")
    out(f"  {'engine NAV, as reported':<{width}} {rec.engine_terminal:>14,.2f}  "
        f"{rec.engine_cagr * 100:>7.3f}%")
    out("")
    out(f"  engine less benchmark  {-rec.gap_cagr * 100:+.3f} pp/yr")
    out(f"  residual {rec.residual_dollars:+,.6f}  "
        f"({rec.residual_relative:.3e} of NAV, tolerance "
        f"{RESIDUAL_TOLERANCE:.0e})")
    out("")
    out(f"  {verdict_line(rec)}")
    out("")


# -- the entry point -------------------------------------------------------


@app.command()
def main(
    start: str = typer.Option(SAMPLE_START, help="First session to include."),
    end: str = typer.Option("", help="Last session; blank means today."),
    weight: float = typer.Option(
        MAX_INVESTABLE,
        help="Target weight in SPY. Above 95% the buffer makes it unreachable.",
    ),
    cost_multiple: float = typer.Option(1.0, help="Cost stress multiple."),
    out: Path = typer.Option(DEFAULT_REPORT, help="Where to write the report."),
    source: str = typer.Option(
        "free", help="Price source: free (Yahoo) or tiingo."
    ),
    no_cache: bool = typer.Option(False, help="Ignore the parquet cache."),
) -> None:
    first = date.fromisoformat(start)
    last = date.fromisoformat(end) if end else datetime.now(timezone.utc).date()
    cache = None if no_cache else ParquetCache()

    try:
        market = load_panel(first, last, cache=cache, source_name=source)
    except DataUnavailable as exc:
        typer.secho(
            "\n  DATA UNAVAILABLE — no reconciliation was performed.\n",
            fg=typer.colors.RED,
            bold=True,
            err=True,
        )
        typer.secho(f"  {exc}\n", fg=typer.colors.RED, err=True)
        typer.secho(
            "  Nothing has been written. A reconciliation is a claim about "
            "arithmetic\n  we actually did, and a file saying otherwise "
            "would outlive this session.\n",
            err=True,
        )
        raise typer.Exit(EXIT_NO_DATA)

    if weight > MAX_INVESTABLE + 1e-12:
        typer.secho(
            f"  note: a {weight:.0%} target cannot be reached — the ledger "
            f"holds {DEFAULT_BUFFER_FRACTION:.0%} of NAV back from every "
            f"buy, so the book tops out at {MAX_INVESTABLE:.0%}.",
            fg=typer.colors.YELLOW,
        )

    config = validation_config(cost_multiple)
    try:
        result = run_backtest(market, BuyAndHold({TICKER: weight}), config)
        rec = reconcile(result, market)
    except BacktestError as exc:
        # The engine refused the panel or the identity could not be
        # assembled. Reported as an engine failure rather than as a
        # traceback, and emphatically not as a reconciliation with a
        # caveat attached.
        typer.secho(
            "\n  THE ENGINE REFUSED THE RUN — no reconciliation exists.\n",
            fg=typer.colors.RED,
            bold=True,
            err=True,
        )
        typer.secho(f"  {exc}\n", fg=typer.colors.RED, err=True)
        raise typer.Exit(EXIT_UNEXPLAINED)

    print_console(rec)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(rec, result, weight), "utf-8")
    typer.echo(f"  report → {out}\n")

    raise typer.Exit(EXIT_OK if rec.explained else EXIT_UNEXPLAINED)


if __name__ == "__main__":
    app()
