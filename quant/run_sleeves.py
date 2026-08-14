"""Stage 3: Layers 1 and 2 through the real engine, against two benchmarks.

Nine sleeves, sized every session by trend, inverse volatility and a
correlation haircut, filled at the next open out of settled cash, charged
a liquidity-scaled spread and a square-root impact term — from the sample
start to whatever today happens to be. This is the first document in the
project that reports what the system EARNED, and everything about how it
is written is shaped by that being the least trustworthy kind of claim
this repository makes.

Three things follow from that, and each of them costs the result
something.

**Two benchmarks, on the same cost model.** A 60/40 rebalanced daily and
a buy-and-hold of SPY, run through the same engine with the same
settlement, the same buffer, the same turnover budget and the same
spread. A strategy compared against a costless index is being compared
against something nobody could hold; a strategy compared against nothing
at all is not being compared. The benchmarks carry no sleeve caps —
those are the strategy's design and not the account's rules, so making a
benchmark wear them would be scoring it against a constraint invented
for somebody else.

**Every configuration is a trial, and the deflated Sharpe is the
headline.** Nine runs land in `trials.jsonl` before a single number is
computed, and the DSR is deflated by the whole ledger's distinct count
rather than by nine — including every configuration `evaluate_signals.py`
recorded, because a search does not become smaller by being spread across
two files. An unlogged trial makes the deflation a lie.

**Three cost multiples, side by side.** The impact coefficient is a prior
lifted from the literature and not a measurement of our own fills, and
the honest response to a prior is to run at two and three times it. A
strategy that only works at 1x is not a strategy, it is a bet that
`costs.py` is exactly right, and nothing in `costs.py` is exactly right.

Two things this file goes out of its way to print. The splices, because
DBC does not exist before 2006-02-06 and the cash leg has no tradable
vehicle before BIL listed, and a reader must not need to know either to
read the tables correctly. And the combined weight of the three equity
sleeves, because their caps sum to 80% with no group cap over them — the
correlation haircut is the only thing standing between the design and an
80% equity book, and whether it actually binds is a number rather than
an assumption.

Needs the network. If the pull fails this exits 2 and writes nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START
from griffinquant.data.cache import ParquetCache
from griffinquant.engine import metrics
from griffinquant.engine.backtest import (
    BacktestConfig,
    BacktestError,
    BacktestResult,
    BuyAndHold,
    MarketData,
    MarketView,
    run_backtest,
)
from griffinquant.engine.costs import CostModel
from griffinquant.engine.ledger import DEFAULT_BUFFER_FRACTION
from griffinquant.portfolio import sizing
from griffinquant.portfolio.sizing import SleeveSizing
from griffinquant.portfolio.sleeves import SLEEVES
from griffinquant.util import runs
from griffinquant.util.runs import Check, DataUnavailable, Sample, Source

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "stage3_sleeves.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA

#: 1x, 2x, 3x, and all three reported. See the module docstring.
COST_MULTIPLES: tuple[float, ...] = (1.0, 2.0, 3.0)

#: The most of NAV any book in this file can actually hold. Not a
#: strategy choice: the ledger holds five per cent of NAV back from every
#: buy, so a 60/40 targeting a full 100% would spend twenty years
#: deferring its last five per cent and fill the log with events that say
#: nothing except that the target was impossible. Both benchmarks are
#: therefore scaled to the investable book — the MIX is exactly 60/40,
#: and the cash buffer is the same one the strategy pays.
MAX_INVESTABLE = 1.0 - DEFAULT_BUFFER_FRACTION

#: Above this the brief's instruction is to stop reporting and start
#: hunting. Applied to the strategy's own annualised Sharpe at 1x.
SUSPICIOUS_SHARPE = 1.2

#: The three equity sleeves, whose caps sum to 0.80 with no group cap
#: over them.
EQUITY_TICKERS: tuple[str, ...] = tuple(
    s.ticker for s in SLEEVES if s.asset_class == "equity"
)
EQUITY_CAP_SUM: float = float(
    sum(s.max_weight for s in SLEEVES if s.asset_class == "equity")
)

app = typer.Typer(add_completion=False)


# -- the books ----------------------------------------------------------


class ConstantMix:
    """Fixed weights, restated every session — a daily-rebalanced book.

    Deliberately not `BuyAndHold`. A 60/40 that is bought once and left
    alone is a different portfolio by 2026 than the one it was in 2005,
    and calling it 60/40 in a table beside a daily-rebalanced strategy
    would be comparing a drifting book against a disciplined one and
    attributing the difference to the signals. This restates the target
    daily; the engine's no-trade band is what stops it churning.
    """

    def __init__(self, weights: Mapping[str, float], *, name: str) -> None:
        self.target = {str(k): float(v) for k, v in weights.items()}
        self.name = name
        self.warmup = 0

    def targets(self, view: MarketView) -> Mapping[str, float]:
        # Every asset in the panel is stated, including the zeroes: an
        # asset left out of the mapping is a target of zero either way,
        # but a strategy that omits names is one edit away from omitting
        # one by accident and holding it forever.
        return {a: self.target.get(a, 0.0) for a in view.assets}


@dataclass(frozen=True)
class Book:
    """One thing being measured, and why it is in the table."""

    key: str
    label: str
    note: str
    caps: bool


BOOKS: tuple[Book, ...] = (
    Book(
        key="sleeves",
        label="Sleeve sizing (Layers 1+2)",
        note=(
            "trend decides participation, inverse volatility scales what "
            "survives, the correlation haircut cuts what is duplicated, then "
            "the per-sleeve caps and the gross budget"
        ),
        caps=True,
    ),
    Book(
        key="sixty_forty",
        label="60/40 SPY/IEF, rebalanced daily",
        note=(
            "the allocation this fund would otherwise hold, run through the "
            "same engine at the same cost — the mix is exactly 60/40 of the "
            "investable book, which carries the same 5% buffer the strategy "
            "does"
        ),
        caps=False,
    ),
    Book(
        key="spy",
        label="Buy and hold SPY",
        note=(
            "bought once and never rebalanced, so it pays no turnover after "
            "deployment; the hardest benchmark in the table and the one most "
            "people actually hold"
        ),
        caps=False,
    ),
)


def build_strategy(book: Book, sample: Sample) -> Any:
    """The three books, and the one input the strategy gets that the
    benchmarks do not.

    `risk_free` travels into the sleeve strategy because trend's hurdle
    is the bill rate and zero is not neutral — with a zero hurdle
    anything that drifted upward reads as trending. The benchmarks have
    no hurdle to be given: neither of them has an opinion to have.
    """
    if book.key == "sleeves":
        return SleeveSizing(
            name="sleeve sizing",
            risk_free=sample.risk_free,
            hold_cash_sleeve=True,
        )
    if book.key == "sixty_forty":
        return ConstantMix(
            {"SPY": 0.60 * MAX_INVESTABLE, "IEF": 0.40 * MAX_INVESTABLE},
            name="60/40 rebalanced",
        )
    return BuyAndHold({"SPY": MAX_INVESTABLE}, name="buy and hold SPY")


def build_config(book: Book, multiple: float) -> BacktestConfig:
    """One account, three books, one difference between them.

    Everything that is a fact about the account — T+1, the 5% buffer, the
    5%-of-NAV daily turnover budget, whole shares, the $100 minimum
    ticket, the participation cap, the cost model — is identical across
    every run in this report. The only thing that moves is whether the
    sleeve caps apply, and they apply to the strategy alone because they
    ARE the strategy: a benchmark made to wear a 40% ceiling on SPY is
    being scored against a constraint invented for somebody else.
    """
    common = dict(
        cost_model=CostModel(multiple=float(multiple)),
        band_provenance=(
            "not tuned; the engine default, a round prior fixed before any "
            "result in this report existed"
        ),
    )
    if book.caps:
        return BacktestConfig(**common)
    return BacktestConfig(
        apply_sleeve_caps=False, default_max_weight=1.0, caps={}, **common
    )


# -- one run ------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    """A backtest and everything measured from it, computed once."""

    book: Book
    multiple: float
    strategy: Any
    result: BacktestResult
    report: metrics.PerformanceReport

    @property
    def key(self) -> str:
        return f"{self.book.key}@{self.multiple:g}x"

    @property
    def equity_weight(self) -> pd.Series:
        """Combined realised weight of the three equity sleeves."""
        held = self.result.weights
        cols = [c for c in EQUITY_TICKERS if c in held.columns]
        if not cols:
            return pd.Series(0.0, index=held.index, dtype="float64")
        return held[cols].sum(axis=1)


def trial_config(book: Book, multiple: float, sample: Sample) -> dict[str, Any]:
    """The fingerprint that makes two runs one trial or two.

    The window is in it deliberately. A configuration re-run on a longer
    sample is a different look at the data, and counting it as the same
    trial would let the search grow for free every time somebody moves an
    end date.
    """
    return {
        "book": book.key,
        "cost_multiple": float(multiple),
        "start": sample.start.date().isoformat(),
        "end": sample.end.date().isoformat(),
        "caps": book.caps,
        "buffer": DEFAULT_BUFFER_FRACTION,
        "settlement": 1,
        "turnover_budget": 0.05,
        "lookbacks": list(sizing.trend.LOOKBACKS),
        "correlation_lookback": sizing.correlation.LOOKBACK,
    }


def execute(book: Book, multiple: float, market: MarketData, sample: Sample) -> Run:
    """One backtest, measured once.

    `trials=None` here is not an omission. `metrics.evaluate` would
    deflate against whatever count it was handed, and the count is not
    known until every run in this report has been logged — so the
    deflation happens afterwards, in `deflate`, against the whole ledger.
    Passing a partial count here would produce a deflated Sharpe that is
    deflated by less than the search that produced it.
    """
    strategy = build_strategy(book, sample)
    config = build_config(book, multiple)
    result = run_backtest(market, strategy, config)
    report = metrics.evaluate(
        result.equity,
        trades=result.trades,
        rf=sample.risk_free,
        trials=None,
    )
    return Run(
        book=book,
        multiple=float(multiple),
        strategy=strategy,
        result=result,
        report=report,
    )


def deflate(run: Run, sample: Sample, trials: int) -> metrics.DeflatedSharpe:
    """The headline, deflated by the whole ledger rather than by this run.

    `trials` is the distinct count across `trials.jsonl` — every
    configuration this project has ever evaluated, signal diagnostics
    included. Correlated variants of one idea are not N independent
    trials, so that count overstates N, which RAISES the hurdle. Being
    conservative in that direction is the only defensible way to be wrong
    about a denominator we chose ourselves.
    """
    return metrics.deflated_sharpe_ratio(
        metrics.to_returns(run.result.equity), trials=trials, rf=sample.risk_free
    )


# -- liquidity ----------------------------------------------------------


@dataclass(frozen=True)
class Liquidity:
    """What the book held, measured against what the tape could absorb.

    At this fund's size none of this binds, and saying so is the point of
    measuring it: a capacity claim nobody quantified is a claim, and the
    honest form of "capacity is not a problem here" is a number with the
    worst case named.
    """

    mean_adv: float
    median_adv: float
    worst_share: float
    worst_ticker: str
    worst_date: pd.Timestamp | None
    worst_position: float
    n_cells: int
    measured: bool


def liquidity(run: Run, market: MarketData) -> Liquidity:
    adv = market.dollar_volume
    if adv is None:
        return Liquidity(
            float("nan"), float("nan"), float("nan"), "", None, float("nan"), 0, False
        )

    held = run.result.weights
    nav = run.result.equity
    value = held.mul(nav, axis=0)
    depth = adv.reindex(index=held.index, columns=held.columns)

    live = (held > 1e-9) & depth.notna() & (depth > 0.0)
    if not bool(live.to_numpy().any()):
        return Liquidity(
            float("nan"), float("nan"), float("nan"), "", None, float("nan"), 0, False
        )

    advs = depth.where(live).stack().dropna()
    shares = (value.where(live) / depth.where(live)).stack().dropna()
    if not len(shares):
        return Liquidity(
            float("nan"), float("nan"), float("nan"), "", None, float("nan"), 0, False
        )
    worst_at = shares.idxmax()
    return Liquidity(
        mean_adv=float(advs.mean()),
        median_adv=float(advs.median()),
        worst_share=float(shares.max()),
        worst_ticker=str(worst_at[1]),
        worst_date=pd.Timestamp(worst_at[0]),
        worst_position=float(value.loc[worst_at[0], worst_at[1]]),
        n_cells=int(len(advs)),
        measured=True,
    )


# -- the sceptic --------------------------------------------------------


def sceptic_checks(
    runs_by_key: Mapping[str, Run],
    market: MarketData,
    sample: Sample,
    multiples: Sequence[float],
) -> tuple[Check, ...]:
    """Attack the headline before reporting it.

    The brief's rule is that a Sharpe above 1.2 is evidence of a bug
    until somebody has been through this list, and the list runs whatever
    the Sharpe came back as — a check that only fires on a good result is
    a check calibrated to find nothing.
    """
    cheap, dear = float(multiples[0]), float(multiples[-1])
    strategy_run = runs_by_key[f"sleeves@{cheap:g}x"]
    checks: list[Check] = []

    # 1. Causality, by literal truncation. The sizing layer's weights for
    #    date T must not move when everything after T is deleted. An
    #    off-by-one in a rolling window reads correctly and manufactures a
    #    beautiful backtest.
    panel = market.close_adj
    cut_at = panel.index[int(len(panel) * 0.7)]
    caps = {a: strategy_run.result.config.cap_for(a) for a in market.assets}
    full = sizing.size_weights(
        panel, asof=cut_at, caps=caps, risk_free=sample.risk_free
    )
    cut = sizing.size_weights(
        panel.loc[:cut_at], asof=cut_at, caps=caps, risk_free=sample.risk_free
    )
    same = full.weights == cut.weights
    checks.append(
        Check(
            "Weights at T survive truncation after T",
            bool(same),
            f"the whole book recomputed on the frame cut at "
            f"{cut_at.date()}: {'identical' if same else 'THE WEIGHTS MOVED'} "
            f"across {len(full.lines)} sleeves",
        )
    )

    # 2. Every fill happened after the decision that caused it, at that
    #    session's own open. A fill on the signal's own close is the
    #    single most common way a backtest of this shape lies.
    trades = strategy_run.result.trades
    if len(trades):
        after = bool((trades["date"] > trades["decision_date"]).all())
        opens = market.open_unadj.stack()
        keyed = pd.MultiIndex.from_arrays([trades["date"], trades["ticker"]])
        at_open = bool(
            np.allclose(
                trades["price"].to_numpy(dtype="float64"),
                opens.reindex(keyed).to_numpy(dtype="float64"),
                rtol=0.0,
                atol=0.0,
                equal_nan=False,
            )
        )
        lags = (trades["date"] - trades["decision_date"]).dt.days
        detail = (
            f"{len(trades):,} fills, every one strictly after its decision "
            f"(median lag {int(lags.median())} calendar day(s)) and priced at "
            f"that session's own unadjusted open to the last bit"
        )
        checks.append(
            Check("Fills land at the NEXT open", after and at_open, detail)
        )
    else:
        checks.append(
            Check(
                "Fills land at the NEXT open",
                False,
                "the run placed no trades at all, which is not a pass — it "
                "means nothing about execution was exercised",
            )
        )

    # 3. Returns come from the total-return series. On close_unadj the
    #    two Treasury sleeves and the credit sleeve return roughly nothing
    #    over the sample, so a book marked on price does not understate
    #    the defensive half of this strategy, it deletes it.
    final = strategy_run.result.final_positions
    marked_adj = True
    detail = "no position was open at the end of the sample"
    if len(final):
        last_adj = market.close_adj.iloc[-1]
        last_unadj = market.close_unadj.iloc[-1]
        marks = final.set_index("ticker")["mark"]
        matches_adj = bool(
            np.allclose(
                marks.to_numpy(dtype="float64"),
                last_adj.reindex(marks.index).to_numpy(dtype="float64"),
            )
        )
        # Asked across the PANEL, not on the closing bar. Back-adjustment
        # anchors at the last observation, so close_adj equals
        # close_unadj there for every instrument BY CONSTRUCTION. The
        # first cut of this check compared the two on precisely the one
        # date where the property it wanted cannot hold, and duly failed
        # a sound run. A check that cannot pass is worse than no check —
        # it teaches the reader to wave the row through.
        #
        # The bar is "some held sleeve differs somewhere", not "every
        # sleeve differs". GLD is a bullion trust: no dividend, no split,
        # so its two series agree on all 5,680 rows. That is a fact about
        # gold, and requiring otherwise would fail the panel for holding
        # a correct column.
        adj, unadj = market.close_adj, market.close_unadj
        common = marks.index.intersection(adj.columns)
        gap = (adj[common] - unadj[common]).abs()
        cells = int((gap > 1e-9).to_numpy().sum())
        movers = [str(c) for c in common if bool((gap[c] > 1e-9).any())]
        marked_adj = matches_adj and cells > 0
        detail = (
            f"{len(marks)} closing position(s) marked at `close_adj`; across "
            f"the panel {cells:,} ticker-days carry an adjusted close that "
            f"differs from the as-traded one, on {len(movers)} of "
            f"{len(common)} held sleeve(s) "
            f"({', '.join(movers) if movers else 'none'}), so the two frames "
            f"are genuinely different series. Measured panel-wide because "
            f"back-adjustment anchors at the final bar, where the two agree "
            f"everywhere by construction"
        )
    checks.append(
        Check("Positions are marked in total-return space", marked_adj, detail)
    )

    # 4. Costs were charged, are non-zero, and scale with the multiple.
    #    A cost model wired to nothing produces a beautiful curve and a
    #    zero in this row.
    one = strategy_run.result.cost_breakdown
    stressed = runs_by_key[f"sleeves@{dear:g}x"].result.cost_breakdown
    non_zero = one["total"] > 0.0 and one["spread"] > 0.0 and one["impact"] > 0.0
    sums = abs(one["spread"] + one["impact"] - one["total"]) < 1e-6
    # Not exactly the ratio of the multiples: the multiple changes the
    # fills, which changes the book, which changes what there is to
    # trade. A ratio inside a wide band is the honest test; an exact 3.0
    # would mean the costs were scaled after the fact rather than charged
    # inside the loop.
    want = dear / cheap
    ratio = stressed["total"] / one["total"] if one["total"] > 0 else float("nan")
    scales = bool(
        dear > cheap
        and np.isfinite(ratio)
        and 0.6 * want <= ratio <= 1.4 * want
    )
    checks.append(
        Check(
            "Trading costs are charged inside the loop",
            bool(non_zero and sums and scales),
            f"{runs.money(one['total'])} at {cheap:g}x "
            f"({runs.money(one['spread'])} spread, "
            f"{runs.money(one['impact'])} impact), "
            f"{runs.money(stressed['total'])} at {dear:g}x — a ratio of "
            f"{ratio:.2f} against a nominal {want:.2g}, which will not be "
            f"exact because the multiple changes the fills and therefore "
            f"the book",
        )
    )

    # 5. No decision was taken before the strategy had banked its warmup,
    #    and none on the last session, which has no tomorrow inside the
    #    sample to fill in.
    warmup = int(getattr(strategy_run.strategy, "warmup", 0) or 0)
    sessions = market.index
    first_legal = sessions[min(warmup + 1, len(sessions) - 1)]
    early = int((trades["date"] < first_legal).sum()) if len(trades) else 0
    checks.append(
        Check(
            "Nothing traded before the warmup completed",
            early == 0,
            f"{warmup:,}-session warmup ({sizing.REQUIRED_SESSIONS:,} closes "
            f"banked before the first decision); {early} fill(s) before "
            f"{first_legal.date()}",
        )
    )

    # 6. The ledger's own invariant. It is checked on every session
    #    inside the loop, so a run that finished has already passed it —
    #    stated here rather than assumed, because "the run completed" is
    #    not a sentence most readers will translate into "cash was
    #    conserved on all 5,000 days".
    result = strategy_run.result
    residual = float(
        result.ledger.residual(
            float(result.daily["market_value"].iloc[-1]),
            float(result.equity.iloc[-1]),
        )
    )
    checks.append(
        Check(
            "Cash is conserved: settled + unsettled + market value = NAV",
            abs(residual) < 1e-6,
            f"checked inside the loop on every one of {len(result.equity):,} "
            f"sessions; closing residual {runs.money(residual, 6)}",
        )
    )

    # 7. The number the brief says to disbelieve.
    sharpe = float(strategy_run.report.sharpe)
    sober = not (np.isfinite(sharpe) and sharpe > SUSPICIOUS_SHARPE)
    checks.append(
        Check(
            f"Strategy Sharpe at 1x stays under {SUSPICIOUS_SHARPE:.1f}",
            sober,
            f"{sharpe:.3f} annualised, excess of the bill series. Above "
            f"{SUSPICIOUS_SHARPE:.1f} the brief's instruction is to treat it "
            f"as evidence of a bug and hunt through the six rows above "
            f"before reporting it",
        )
    )

    # 8. A benchmark that did not deploy is not a benchmark. If SPY
    #    buy-and-hold ended the sample in cash, the comparison below is
    #    against nothing.
    spy = runs_by_key[f"spy@{cheap:g}x"]
    invested = float(spy.result.daily["invested_weight"].iloc[-1])
    checks.append(
        Check(
            "Both benchmarks actually deployed",
            invested > 0.80,
            f"buy-and-hold SPY finished {invested:.1%} invested against the "
            f"{MAX_INVESTABLE:.0%} it was bought to — a latched book is never "
            f"rebalanced, so the weight drifts with the position. A benchmark "
            f"sitting in cash would flatter everything measured against it",
        )
    )
    return tuple(checks)


# -- the whole run ------------------------------------------------------


@dataclass(frozen=True)
class Stage3:
    sample: Sample
    market: MarketData
    runs: dict[str, Run]
    deflated: dict[str, metrics.DeflatedSharpe]
    liquidity: dict[str, Liquidity]
    checks: tuple[Check, ...]
    trials: int
    multiples: tuple[float, ...]

    @property
    def clean(self) -> bool:
        return all(c.passed for c in self.checks)

    def at(self, key: str, multiple: float) -> Run:
        return self.runs[f"{key}@{multiple:g}x"]

    @property
    def ordered(self) -> list[Run]:
        return [
            self.runs[f"{b.key}@{m:g}x"] for b in BOOKS for m in self.multiples
        ]


def stage3(
    sample: Sample,
    *,
    ledger: runs.Trials,
    multiples: Sequence[float] = COST_MULTIPLES,
) -> Stage3:
    market = MarketData.from_prices(sample.prices, key="ticker")

    # Logged before a single backtest runs. A trial ledger written after
    # a result can be edited by the result, and the entire value of the
    # count is that it is a denominator nobody chose.
    for book in BOOKS:
        for multiple in multiples:
            ledger.log(
                trial_config(book, multiple, sample),
                f"{book.label} at {multiple:g}x cost, "
                f"{sample.start.date()} to {sample.end.date()}",
            )
    trials = ledger.distinct

    table: dict[str, Run] = {}
    for book in BOOKS:
        for multiple in multiples:
            run = execute(book, multiple, market, sample)
            table[run.key] = run

    return Stage3(
        sample=sample,
        market=market,
        runs=table,
        deflated={k: deflate(r, sample, trials) for k, r in table.items()},
        liquidity={k: liquidity(r, market) for k, r in table.items()},
        checks=sceptic_checks(table, market, sample, tuple(multiples)),
        trials=trials,
        multiples=tuple(float(m) for m in multiples),
    )


# -- rendering ----------------------------------------------------------


def _cost_label(multiple: float) -> str:
    return f"{multiple:g}x"


def _recovery(dd: metrics.Drawdown) -> str:
    if dd.peak is None:
        return runs.NULL
    if dd.still_underwater:
        return (
            f"not recovered — {dd.sessions_underwater:,} sessions "
            f"({dd.days_underwater:,} days) and counting"
        )
    return f"{dd.sessions_to_recover:,} sessions ({dd.days_to_recover:,} days)"


def _headline_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        d = s3.deflated[run.key]
        r = run.report
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.num(r.sharpe, 2),
                runs.num(d.deflated_sharpe, 3),
                runs.num(d.benchmark_sharpe_annualised, 2),
                runs.signed_pct(r.cagr),
                runs.pct(r.annualised_volatility),
                runs.pct(r.drawdown.depth),
                runs.num(r.costs.annual_turnover, 2),
                runs.bps(r.costs.cost_drag_bps),
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Sharpe",
            "Deflated",
            "Hurdle SR",
            "CAGR",
            "Vol",
            "Max DD",
            "Turnover/yr",
            "Cost drag",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _dsr_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        d = s3.deflated[run.key]
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.count(d.trials),
                runs.count(d.n_observations),
                runs.num(d.observed_sharpe_annualised, 3),
                runs.num(d.benchmark_sharpe_annualised, 3),
                runs.num(d.skew, 2),
                runs.num(d.kurtosis, 2),
                runs.num(d.probabilistic_sharpe, 4),
                runs.num(d.deflated_sharpe, 4),
                "yes" if d.significant else "no",
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Trials",
            "Obs",
            "Observed SR",
            "Best-of-N hurdle",
            "Skew",
            "Kurtosis",
            "PSR",
            "DSR",
            f"Clears {metrics.SIGNIFICANCE_THRESHOLD:.0%}",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "l"],
    )


def _risk_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        dd = run.report.drawdown
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.pct(dd.depth),
                runs.day(dd.peak),
                runs.day(dd.trough),
                runs.count(dd.sessions_peak_to_trough),
                runs.day(dd.recovered_on),
                _recovery(dd),
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Max DD",
            "Peak",
            "Trough",
            "Sessions down",
            "Recovered on",
            "Time to recover",
        ],
        rows,
        ["l", "l", "r", "l", "l", "r", "l", "l"],
    )


def _worst_days_table(s3: Stage3, multiple: float) -> str:
    frames = {b.key: s3.at(b.key, multiple).report.worst_days for b in BOOKS}
    n = max((len(f) for f in frames.values()), default=0)
    rows: list[list[str]] = []
    for i in range(n):
        row = [str(i + 1)]
        for b in BOOKS:
            f = frames[b.key]
            if i < len(f):
                row += [
                    runs.day(f["date"].iloc[i]),
                    runs.signed_pct(f["return"].iloc[i]),
                ]
            else:
                row += [runs.NULL, runs.NULL]
        rows.append(row)
    headers = ["#"]
    for b in BOOKS:
        headers += [f"{b.label} — date", "return"]
    return runs.table(headers, rows, ["r"] + ["l", "r"] * len(BOOKS))


def _worst_months_table(s3: Stage3, multiple: float) -> str:
    frames = {b.key: s3.at(b.key, multiple).report.worst_months for b in BOOKS}
    n = max((len(f) for f in frames.values()), default=0)
    rows: list[list[str]] = []
    for i in range(n):
        row = [str(i + 1)]
        for b in BOOKS:
            f = frames[b.key]
            if i < len(f):
                row += [
                    str(f["month"].iloc[i]),
                    runs.signed_pct(f["return"].iloc[i]),
                    runs.count(f["sessions"].iloc[i]),
                ]
            else:
                row += [runs.NULL, runs.NULL, runs.NULL]
        rows.append(row)
    headers = ["#"]
    for b in BOOKS:
        headers += [f"{b.label} — month", "return", "sessions"]
    return runs.table(headers, rows, ["r"] + ["l", "r", "r"] * len(BOOKS))


def _cost_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        c = run.report.costs
        breakdown = run.result.cost_breakdown
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.count(c.n_trades),
                runs.money(c.traded_notional, 0),
                runs.num(c.annual_turnover, 3),
                runs.money(breakdown["spread"], 0),
                runs.money(breakdown["impact"], 0),
                runs.money(c.total_cost, 0),
                runs.bps(c.cost_drag_bps),
                runs.bps(c.cost_per_dollar_traded_bps),
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Fills",
            "Traded notional",
            "Turnover/yr",
            "Spread",
            "Impact",
            "Total cost",
            "Drag on NAV",
            "Per dollar traded",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _period_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        for _, p in run.report.periods.iterrows():
            rows.append(
                [
                    run.book.label,
                    _cost_label(run.multiple),
                    str(p["period"]),
                    runs.count(p["sessions"]),
                    runs.signed_pct(p["total_return"]),
                    runs.signed_pct(p["annualised_return"]),
                    runs.pct(p["annualised_vol"]),
                    runs.num(p["sharpe"], 2),
                    runs.pct(p["max_drawdown"]),
                    runs.signed_pct(p["worst_day"]),
                ]
            )
    return runs.table(
        [
            "Book",
            "Costs",
            "Period",
            "Sessions",
            "Total return",
            "Annualised",
            "Vol",
            "Sharpe",
            "Max DD",
            "Worst day",
        ],
        rows,
        ["l", "l", "l", "r", "r", "r", "r", "r", "r", "r"],
    )


def _deferral_table(s3: Stage3, multiple: float) -> str:
    rows: list[list[str]] = []
    for b in BOOKS:
        run = s3.at(b.key, multiple)
        table = run.result.ledger.deferrals_by_year()
        if not len(table):
            rows.append(
                [b.label, runs.NULL, "0", "0", "0", "0", runs.NULL, runs.NULL]
            )
            continue
        for year, r in table.iterrows():
            rows.append(
                [
                    b.label,
                    str(int(year)),
                    runs.count(r["deferrals"]),
                    runs.count(r["unsettled_deferrals"]),
                    runs.count(r["buffer_deferrals"]),
                    runs.count(r["no_cash_deferrals"]),
                    runs.money(r["shortfall"], 0),
                    runs.money(r["worst_shortfall"], 0),
                ]
            )
    return runs.table(
        [
            "Book",
            "Year",
            "Deferrals",
            "T+1 unsettled",
            "Buffer",
            "No cash",
            "Total shortfall",
            "Worst",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "r"],
    )


def _liquidity_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        liq = s3.liquidity[run.key]
        if not liq.measured:
            rows.append(
                [run.book.label, _cost_label(run.multiple)]
                + [runs.NULL] * 6
            )
            continue
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.count(liq.n_cells),
                runs.money(liq.mean_adv, 0),
                runs.money(liq.median_adv, 0),
                runs.money(liq.worst_position, 0),
                runs.pct(liq.worst_share, 4),
                f"{liq.worst_ticker} on {runs.day(liq.worst_date)}",
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Held cells",
            "Mean ADV",
            "Median ADV",
            "Largest position",
            "% of that name's ADV",
            "Where",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "l"],
    )


def _equity_weight_table(s3: Stage3) -> str:
    rows: list[list[str]] = []
    for run in s3.ordered:
        w = run.equity_weight
        rows.append(
            [
                run.book.label,
                _cost_label(run.multiple),
                runs.pct(float(w.mean())),
                runs.pct(float(w.median())),
                runs.pct(float(w.quantile(0.95))),
                runs.pct(float(w.max())),
                runs.day(w.idxmax()),
                # Only for the book the cap sum applies to. A benchmark
                # carries no sleeve caps, so printing its weight as a
                # fraction of a ceiling it was never under produced a
                # 120% that means nothing.
                runs.pct(float(w.max()) / EQUITY_CAP_SUM)
                if run.book.caps
                else runs.NULL,
            ]
        )
    return runs.table(
        [
            "Book",
            "Costs",
            "Mean",
            "Median",
            "95th pct",
            "Maximum",
            "Reached on",
            f"Max as a share of the {EQUITY_CAP_SUM:.0%} cap sum",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "l", "r"],
    )


def _equity_by_year(run: Run) -> str:
    w = run.equity_weight
    grouped = w.groupby(w.index.year)
    rows = [
        [
            str(int(year)),
            runs.pct(float(block.mean())),
            runs.pct(float(block.max())),
            runs.day(block.idxmax()),
        ]
        for year, block in grouped
    ]
    return runs.table(
        ["Year", "Mean equity weight", "Maximum", "Reached on"],
        rows,
        ["l", "r", "r", "l"],
    )


def _binding_table(run: Run) -> str:
    """Which step in the sizing chain actually did the cutting.

    The question the equity-weight table raises and cannot answer. If
    `correlation` almost never appears here, the haircut is decoration
    and the 80% ceiling is being held down by something else — most
    likely trend, which would mean the book's equity exposure is a
    function of momentum alone and should be described that way.
    """
    strategy = run.strategy
    if not hasattr(strategy, "decomposition"):
        return "_The benchmark books have no sizing chain to decompose._"
    table = strategy.decomposition()
    if not len(table):
        return "_No allocation was recorded._"
    equity = table.loc[table["ticker"].isin(EQUITY_TICKERS)]
    rows: list[list[str]] = []
    for ticker, block in equity.groupby("ticker", sort=True):
        included = block.loc[block["status"] == "included"]
        counts = included["binding"].value_counts()
        total = int(len(included))
        rows.append(
            [
                str(ticker),
                runs.count(total),
                runs.pct(float(counts.get("trend", 0)) / total if total else np.nan),
                runs.pct(
                    float(counts.get("inverse_vol", 0)) / total if total else np.nan
                ),
                runs.pct(
                    float(counts.get("correlation", 0)) / total if total else np.nan
                ),
                runs.pct(float(counts.get("cap", 0)) / total if total else np.nan),
                runs.pct(
                    float(counts.get("gross_budget", 0)) / total if total else np.nan
                ),
                runs.num(float(included["haircut"].mean()), 4),
                runs.num(float(included["haircut"].max()), 4),
            ]
        )
    return runs.table(
        [
            "Sleeve",
            "Sessions sized",
            "Trend bound",
            "Inv-vol bound",
            "Correlation bound",
            "Cap bound",
            "Budget bound",
            "Mean haircut",
            "Worst haircut",
        ],
        rows,
        ["l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _verdict(s3: Stage3) -> str:
    if not s3.clean:
        failed = [c.name for c in s3.checks if not c.passed]
        return (
            f"DO NOT REPORT THESE NUMBERS. {len(failed)} of {len(s3.checks)} "
            f"sceptic checks failed ({'; '.join(failed)}). Every figure below "
            f"came out of the same run that failed them."
        )
    run = s3.at("sleeves", s3.multiples[0])
    d = s3.deflated[run.key]
    stress = s3.at("sleeves", s3.multiples[-1])
    survives = float(stress.report.cagr) > 0.0
    return (
        f"{d.verdict} At {_cost_label(s3.multiples[-1])} cost the strategy "
        f"{'still compounds' if survives else 'stops compounding'} "
        f"({runs.signed_pct(stress.report.cagr)} a year against "
        f"{runs.signed_pct(run.report.cagr)} at 1x)."
    )


def render_markdown(s3: Stage3, generated_at: datetime, out: Path) -> str:
    sample = s3.sample
    lines: list[str] = []
    add = lines.append
    first_multiple = s3.multiples[0]
    headline_run = s3.at("sleeves", first_multiple)

    add("# Stage 3 — the sleeve book through the engine")
    add("")
    add(
        "Layers 1 and 2 from the sample start to the present, with T+1 "
        "settlement, a five per cent daily turnover budget, whole shares and "
        "the cost model charged inside the loop — against a daily-rebalanced "
        "60/40 and a buy-and-hold of SPY run through the same engine on the "
        "same assumptions. Read `reports/signal_evaluation.md` first: it is "
        "the gate that says whether any of the three signals means anything "
        "on its own."
    )
    add("")
    add(f"**{_verdict(s3)}**")
    add("")

    add("## The run")
    add("")
    add(
        runs.table(
            ["", ""],
            [
                ["Source", sample.source_label],
                ["Sample", f"{sample.start.date()} to {sample.end.date()}"],
                ["Sessions", f"{len(sample.sessions):,}"],
                ["Sleeve vehicles", ", ".join(sample.tickers)],
                ["Starting cash", runs.money(headline_run.result.config.starting_cash)],
                ["Settlement", f"T+1, {DEFAULT_BUFFER_FRACTION:.0%} of NAV held back"],
                ["Turnover budget", "5% of NAV a day, hard"],
                ["No-trade band", "0.5% of NAV drift"],
                ["Fills", "decided at the close of T, filled at the open of T+1"],
                ["Marks", "`close_adj`; screens and share counts read `close_unadj`"],
                ["Risk-free hurdle", sample.rf_note],
                [
                    "Cost multiples",
                    ", ".join(_cost_label(m) for m in s3.multiples),
                ],
                ["Trials on file", f"{s3.trials:,} distinct configurations"],
                ["Cache", sample.cache_note],
                ["Report", str(out)],
            ],
        )
    )
    add("")

    splices, n_splices = runs.spliced_table(sample.start.date(), sample.end.date())
    add("## Spliced and absent history — read this before the tables")
    add("")
    if n_splices:
        add(
            "Two of the nine vehicles do not reach the sample start. Every "
            "number in this report covering these dates was produced by a "
            "book that was short a sleeve, and neither gap is filled with a "
            "proxy: the index alternatives to DBC roll differently, so a "
            "substitute would be a different sleeve wearing DBC's name, and "
            "every ETF stand-in for the early cash leg carries duration. "
            "**Nothing was held in place of either.** Before BIL listed the "
            "residual sat as uninvested balance earning nothing, which "
            "understates the strategy by roughly the bill rate times the time "
            "spent out — and bills paid 3-5% across 2005-2007, so that is not "
            "a rounding error."
        )
    else:
        add("Nothing in this window depends on a splice.")
    add("")
    add(splices)
    add("")

    add("## Headline")
    add("")
    add(
        "The Sharpe is not the number to read. `Deflated` is the probability "
        "the result survives the number of times this project has looked, "
        "and `Hurdle SR` is the annualised Sharpe the best of that many "
        "zero-skill trials would be expected to produce. A raw Sharpe "
        "printed without its trial count is the number this repository "
        "exists to stop reporting."
    )
    add("")
    add(_headline_table(s3))
    add("")
    add(
        "Every book above pays the same spread, the same impact, the same "
        "buffer and the same settlement. The benchmarks carry no sleeve "
        "caps: those are the strategy's design rather than the account's "
        "rules."
    )
    add("")
    add(
        f"One asymmetry is left in rather than equalised. The strategy sits "
        f"in cash for its first {sizing.WARMUP_SESSIONS:,} sessions while the "
        f"three signals bank the windows they need, and both benchmarks "
        f"deploy immediately. That is not a handicap somebody imposed — it "
        f"is what the process could actually have done on those days — and "
        f"papering over it by starting the benchmarks late would report a "
        f"comparison nobody could have run."
    )
    add("")

    add("## Deflated Sharpe, and the count it was deflated by")
    add("")
    add(
        f"Bailey and Lopez de Prado (2014). N is {s3.trials:,} — the distinct "
        f"configuration count in `trials.jsonl`, which includes every "
        f"standalone signal diagnostic as well as the nine runs in this "
        f"report, because a search does not become smaller by being spread "
        f"across two files. Correlated variants of one idea are not N "
        f"independent trials, so this count overstates N and therefore "
        f"RAISES the hurdle — conservative in the only direction it is "
        f"defensible to be wrong about a denominator we chose ourselves."
    )
    add("")
    add(_dsr_table(s3))
    add("")
    add(
        f"Trial dispersion: "
        f"{s3.deflated[headline_run.key].trial_dispersion_source}"
    )
    add("")
    add("```")
    add(s3.deflated[headline_run.key].verdict)
    add("```")
    add("")

    add("## Drawdown and recovery")
    add("")
    add(
        "`Time to recover` is measured from the trough back to the old high "
        "water mark. A drawdown that has not recovered says so rather than "
        "printing a zero, because a zero there reads as an instant recovery."
    )
    add("")
    add(_risk_table(s3))
    add("")

    add(f"## The worst 20 individual days, at {_cost_label(first_multiple)} cost")
    add("")
    add(
        "Worth reading next to the drawdown table rather than instead of it. "
        "A book can have a mild worst day and a terrible drawdown (a long "
        "grind) or the reverse (one gap, then recovery), and the two failure "
        "modes need completely different answers."
    )
    add("")
    add(
        "One cost level, because a cost multiple moves a single day's return "
        "by basis points and these are the days it moved by per cent. The "
        "tables where the stress actually shows — headline, drawdown, period "
        "breakout, turnover — carry all three."
    )
    add("")
    add(_worst_days_table(s3, first_multiple))
    add("")

    add(f"## The worst 10 months, at {_cost_label(first_multiple)} cost")
    add("")
    add(
        "`sessions` is carried because the first and last months of a sample "
        "are usually stubs, and a two-day stub topping the table is an "
        "artefact of where the backtest starts rather than a month anybody "
        "lived through."
    )
    add("")
    add(_worst_months_table(s3, first_multiple))
    add("")

    add("## Turnover and cost drag")
    add("")
    add(
        "Turnover counts every dollar that changed hands over average NAV, "
        "annualised: a book that replaces itself once a year scores 2.0 "
        "under this convention, not 1.0, because that is two trades and the "
        "cost was paid on both. The halved convention is more flattering and "
        "less true."
    )
    add("")
    add(_cost_table(s3))
    add("")

    add("## The named windows, broken out")
    add("")
    add(
        "Each window is anchored on the last NAV BEFORE it opens rather than "
        "the first one inside it, so a period keeps its own first session. "
        "These windows overlap nothing and partition nothing — they are the "
        "four crises that happened plus the recent regime, cut identically "
        "for every book so the rows can be compared with each other. Each is "
        "ONE draw of a crisis; a statistic computed across 2008's sessions "
        "has an n far smaller than its T."
    )
    add("")
    add(_period_table(s3))
    add("")

    add(f"## Settlement deferrals per year, at {_cost_label(first_multiple)} cost")
    add("")
    add(
        "Split by cause, because a year of buffer deferrals and a year of "
        "settlement deferrals are different findings: the first says the "
        "reserve is too fat for the strategy's turnover, the second is the "
        "account type charging rent, and the third — no cash — is neither, "
        "it is a book that was simply fully invested. A single count per "
        "year reads as one phenomenon and is usually two."
    )
    add("")
    add(
        "One cost level again. A deferral is caused by the cash not being "
        "there, and a wider spread changes that by the cost of the trade — "
        "which is two orders of magnitude below the shortfalls in the last "
        "two columns."
    )
    add("")
    add(_deferral_table(s3, first_multiple))
    add("")

    add("## Liquidity of what was held")
    add("")
    add(
        "Measured across every (session, sleeve) cell the book actually "
        "held. This is the capacity claim in its falsifiable form: at this "
        "fund's size none of it binds, and the honest way to say so is a "
        "number with the worst case named rather than a sentence."
    )
    add("")
    add(_liquidity_table(s3))
    add("")

    add("## The three equity sleeves, combined")
    add("")
    add(
        f"US equity, developed international and emerging markets are capped "
        f"at 40%, 25% and 15%. They sum to {EQUITY_CAP_SUM:.0%} and there is "
        f"no group cap over them, so the correlation haircut is the only "
        f"thing standing between the design and an {EQUITY_CAP_SUM:.0%} "
        f"equity book. Whether it binds is this table."
    )
    add("")
    add(_equity_weight_table(s3))
    add("")
    add(
        f"Year by year, for the strategy at {_cost_label(first_multiple)} "
        f"cost:"
    )
    add("")
    add(_equity_by_year(s3.at("sleeves", first_multiple)))
    add("")
    add("### Which step did the cutting")
    add("")
    add(
        "The column that matters is `Correlation bound`. If the haircut is "
        "almost never the binding step, the equity exposure above is being "
        "held down by trend instead — which is a different system from the "
        "one the design describes, and it should be described that way."
    )
    add("")
    add(_binding_table(s3.at("sleeves", first_multiple)))
    add("")

    add("## What was attacked before any of this was believed")
    add("")
    add(
        "A clean number nobody attacked is not a result. Each row is a way "
        "the tables above could be wrong while looking exactly like this."
    )
    add("")
    add(runs.checks_table(s3.checks))
    add("")

    add("## What this does and does not prove")
    add("")
    add(
        "It reports what a specific set of rules would have produced on a "
        "specific twenty-year window, with frictions charged rather than "
        "assumed away and with the number of looks written down. It does not "
        "establish an edge: the sample contains one credit crisis, one "
        "pandemic crash and one inflation shock, each of them a single draw, "
        "and for most of it falling yields paid the bond sleeves to be a "
        "hedge — a relationship that ended in 2022 and has not resumed."
    )
    add("")
    add(
        "Nothing here is out of sample. The holdout in `config.HOLDOUT_YEARS` "
        "is the one defence against that and it is a weak one on purpose: "
        "three years is a handful of quarters and one look, and if anything "
        "is changed in response to it, it stops being a holdout and there is "
        "not a second one waiting."
    )
    add("")
    add(f"_Generated {runs.stamp(generated_at)} by `run_sleeves.py`._")
    add("")
    return "\n".join(lines)


def print_console(s3: Stage3) -> None:
    out = typer.echo
    sample = s3.sample
    out("")
    out(
        f"  Stage 3: {sample.start.date()} to {sample.end.date()} "
        f"({len(sample.sessions):,} sessions, {len(sample.tickers)} vehicles)"
    )
    out("")
    width = max(len(b.label) for b in BOOKS) + 2
    out(
        f"  {'book':<{width}} {'cost':>5} {'CAGR':>9} {'vol':>8} {'SR':>7} "
        f"{'DSR':>7} {'maxDD':>9}"
    )
    for run in s3.ordered:
        r = run.report
        d = s3.deflated[run.key]
        out(
            f"  {run.book.label:<{width}} {_cost_label(run.multiple):>5} "
            f"{r.cagr * 100:>8.2f}% {r.annualised_volatility * 100:>7.2f}% "
            f"{r.sharpe:>7.2f} {d.deflated_sharpe:>7.3f} "
            f"{r.drawdown.depth * 100:>8.2f}%"
        )
    out("")
    strat = s3.at("sleeves", s3.multiples[0])
    w = strat.equity_weight
    out(
        f"  equity sleeves combined: mean {w.mean():.1%}, max {w.max():.1%} "
        f"on {pd.Timestamp(w.idxmax()).date()} against a "
        f"{EQUITY_CAP_SUM:.0%} cap sum"
    )
    out(f"  trials on file: {s3.trials:,} distinct")
    out("")
    for check in s3.checks:
        out(f"  [{check.verdict}] {check.name}")
    out("")
    out(f"  {_verdict(s3)}")
    out("")


# -- the entry point ----------------------------------------------------


def load_panel(
    start: date,
    end: date,
    *,
    source: Source,
    cache: ParquetCache | None,
) -> Sample:
    """Every sleeve vehicle's bars, plus the bill hurdle they are judged on.

    A seam as much as a function: the tests drive the whole script through
    this name against a synthetic panel, which is the only way to prove
    the wiring without a price feed.
    """
    return runs.load_sample(start, end, source=source, cache=cache)


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
        raise runs.refuse_no_data(exc, what="no backtest was run")

    ledger = runs.Trials(path=trials, when=generated_at)
    try:
        s3 = stage3(sample, ledger=ledger, multiples=COST_MULTIPLES)
    except BacktestError as exc:
        # The engine refused the panel. Reported as an engine failure
        # rather than as a traceback, and emphatically not as a result
        # with a caveat attached.
        typer.secho(
            "\n  THE ENGINE REFUSED THE RUN — no result exists.\n",
            fg=typer.colors.RED,
            bold=True,
            err=True,
        )
        typer.secho(f"  {exc}\n", fg=typer.colors.RED, err=True)
        raise typer.Exit(EXIT_FAILED)

    if not quiet:
        print_console(s3)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(s3, generated_at, out), "utf-8")
    if not quiet:
        typer.echo(f"  report → {out}\n")

    raise typer.Exit(EXIT_OK if s3.clean else EXIT_FAILED)


if __name__ == "__main__":
    app()
