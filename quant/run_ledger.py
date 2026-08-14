"""The Post-Publication Ledger: every strategy in the library, measured
from the date somebody else put on it.

Thirty-three published rules through the same engine that produced
`reports/stage3_sleeves.md` — T+1 settlement, signal at the close and
fill at the next open, long only, no leverage, the cost model charged
inside the loop. Two windows per rule, and the second is the reason
the file exists.

**A publication date is a better holdout than a holdout.** A holdout
is a stretch of tape we set aside and can look at whenever we lose our
nerve; the discipline is ours and so is the temptation. A publication
date was fixed by a stranger, in a document, years before this
repository existed, and cannot be moved once a result computed from it
is on the page. So the number that matters here is not what a strategy
earned over the sample. It is what it earned AFTER its author told
everybody about it.

The prior being tested is specific and quantified. McLean and Pontiff
(2016) put post-publication decay at 58% of the published return
across ninety-seven anomalies. Huang, Song and Xiang (2021) put
smart-beta indices at +2.77% a year in backtest and -0.44% a year
after listing. Both are claims about what happens to a documented edge
once it is documented, and both are testable here only because the
registry refuses to hold a strategy without a date.

Three things about the method, each of which costs the result
something.

**Running thirty-three strategies is ONE trial, not thirty-three.**
Every rule is implemented as published, with the parameters its source
states, and nothing here was tuned against anything. A specification
search would owe the deflated Sharpe thirty-three rows; a replication
owes it one, and one is what `trials.jsonl` gets. The distinction is
not a courtesy to ourselves — it is the difference between a study
that reports what the literature said and a study that reports the
best of thirty-three things we tried. A bad row is kept. Faber's rule
returns less than half of SPY over this sample and that IS the
finding.

**A strategy is not measured before its vehicles could absorb this
account.** The engine caps a single day's order at one per cent of the
name's own median dollar volume, and the account's turnover budget
wants five per cent of NAV a day — so a fund whose tape cannot carry
$655,000 a day cannot be deployed into at all, and `BuyAndHold`'s
stall latch, quite correctly, stops trying. Left alone this produces a
measurement of USMV that is 22% invested for fifteen years and reports
2.31% a year as though it were the strategy's return. That is not a
fact about low volatility; it is a fact about a newborn ETF meeting a
cap. So each run opens on the first session its legs could actually
absorb the account, the date is arithmetic on three engine constants
rather than a threshold anybody picked, and it is printed in every
table.

**Warmup is served inside each run's own window, not before it.** A
twelve-month rule spends its first twelve months in cash, exactly as
`run_sleeves.py` does and for the same reason: it is what the process
could have done on those days. It costs the trend and tactical
families about a year of the full-sample column and costs the
post-publication column nothing at all, because by then every rule is
long since deployed.

Needs the network on a cold cache. If the pull fails this exits 2 and
writes nothing.
"""

from __future__ import annotations

import dataclasses
import inspect
import math
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START, UNIVERSE
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.etfuniverse import HISTORY_START, UNIVERSE_TICKERS
from griffinquant.data.tbill import FRED_SERIES, TbillUnavailable, fetch_rate
from griffinquant.engine import metrics
from griffinquant.engine.backtest import (
    BacktestConfig,
    BacktestError,
    BacktestResult,
    MarketData,
    run_backtest,
)
from griffinquant.engine.costs import CostModel
from griffinquant.engine.ledger import DEFAULT_BUFFER_FRACTION
from griffinquant.portfolio.sizing import SleeveSizing
from griffinquant.portfolio.sleeves import SLEEVES
from griffinquant.strategies import registry
from griffinquant.strategies.registry import Entry
from griffinquant.util import runs
from griffinquant.util.runs import Check, DataUnavailable, Source

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "post_publication_ledger.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA

#: 1x for every table, 2x and 3x for the headline. The impact
#: coefficient is a prior lifted from the literature rather than a
#: measurement of our own fills, and a strategy that only works at 1x
#: is a bet that `costs.py` is exactly right.
COST_MULTIPLES: tuple[float, ...] = (1.0, 2.0, 3.0)

#: Above this the brief's instruction is to stop reporting and start
#: hunting. The CHECK is applied to the full-sample Sharpe at 1x, where
#: a figure this high on a long-only unlevered book is a bug. Shorter
#: windows are held to the same number and reported rather than
#: refused; `_suspicious_table` says why.
SUSPICIOUS_SHARPE = 1.2

#: A window has to be at least this long before it enters the decay
#: arithmetic. One trading year is the shortest stretch over which an
#: annualised figure is a description rather than an extrapolation.
MIN_WINDOW_SESSIONS = 252

#: The horizon the owner's question names — "the annualised return over
#: 15 to 20 years". A row shorter than this answers a different
#: question, and a 7.8-year momentum record printed beside a 21.6-year
#: one as though the two were the same measurement is the comparison
#: this whole repository exists to refuse. Taken from the question, not
#: from a sweep.
MIN_COMPARABLE_YEARS = 15.0

#: A book that never got invested has not been measured. The floor is
#: deliberately low: it is here to catch the 22%-invested failure mode
#: the module docstring describes, not to have an opinion about how
#: much cash a tactical rule ought to hold.
MIN_MEDIAN_INVESTED = 0.50

#: Seed and draw count for the bootstrap intervals. Fixed so the report
#: diffs, and stated because a resampling artefact that moves between
#: runs is one nobody can check.
BOOTSTRAP_SEED = 20260803
BOOTSTRAP_DRAWS = 10_000


@dataclass(frozen=True)
class Reference:
    """A number this run must reproduce or stop.

    Measured previously on this engine over 2005-01-03 to 2026-07-31
    and published in `reports/stage3_sleeves.md`. Reproduction is
    tested at the precision the figure was printed to. A run that
    disagrees in the second decimal is a run whose plumbing moved, and
    the correct response is to say so rather than to quietly ship a
    second set of numbers that disagrees with the first.
    """

    key: str
    label: str
    cagr: float
    sharpe: float


REFERENCES: tuple[Reference, ...] = (
    Reference("spy_buy_and_hold", "buy and hold SPY", 0.1069, 0.55),
    Reference("sixty_forty_daily", "60/40 SPY/IEF, rebalanced daily", 0.0782, 0.61),
)

#: This fund's own book, which is not a published strategy and has no
#: date, so it never enters the decay table. It is here because the
#: question the study was commissioned to answer is what OUR system
#: earned, and quoting that from another report rather than running it
#: would make this document depend on a number it did not compute.
OUR_KEY = "griffin_sleeves"
OUR_LABEL = "Griffin nine-sleeve book (Layers 1+2)"
OUR_REFERENCE = Reference(OUR_KEY, OUR_LABEL, 0.0535, 0.61)

#: The Sharpe the nine-sleeve book and the daily 60/40 both landed on.
#: The owner's second question is whether anything in the library beats
#: it.
HOUSE_SHARPE = 0.61

app = typer.Typer(add_completion=False)


# -- the panel ----------------------------------------------------------


@dataclass(frozen=True)
class Panel:
    """One pull, wide enough for every strategy in the library.

    `prices` reaches back to `HISTORY_START` rather than to the study
    start, and the extra fifteen years are never measured. They exist
    so `deployable` can tell a fund that listed in 2011 from a fund
    that has traded since 1993 and merely happens to have its first bar
    on the sample's opening session. Without the pre-sample tape those
    two look identical, and the liquidity rule below would defer the
    entire library by a month while the volume window filled.
    """

    prices: pd.DataFrame
    risk_free: pd.Series
    dollar_volume: pd.DataFrame
    deployable: Mapping[str, pd.Timestamp]
    listed: Mapping[str, pd.Timestamp]
    served: frozenset[str]
    study_start: pd.Timestamp
    study_end: pd.Timestamp
    source_label: str
    cache_note: str
    rf_note: str
    adv_floor: float
    sessions: pd.DatetimeIndex

    @property
    def universe_available(self) -> tuple[str, ...]:
        return tuple(sorted(set(UNIVERSE_TICKERS) & self.served))

    def slice(self, tickers: Sequence[str], start: pd.Timestamp) -> pd.DataFrame:
        rows = self.prices["ticker"].isin(set(tickers))
        window = (self.prices["date"] >= start) & (
            self.prices["date"] <= self.study_end
        )
        return self.prices.loc[rows & window].reset_index(drop=True)


def adv_floor(config: BacktestConfig) -> float:
    """The daily tape a fund needs before this account can deploy into it.

    Three engine constants and one division, so there is nothing here
    to tune. The turnover budget wants `starting_cash *
    max_daily_turnover` of fills a day and the participation cap allows
    `max_participation` of the name's own median dollar volume, so a
    fund below this figure cannot absorb the account's own budget even
    once: the ramp stalls on its first session, `BuyAndHold` latches on
    not having moved, and the book sits part-invested for the rest of
    the sample while the report calls the result a factor return.
    """
    if config.max_participation is None or config.max_participation <= 0.0:
        return 0.0
    return float(
        config.starting_cash * config.max_daily_turnover / config.max_participation
    )


def deployability(
    close_unadj: pd.DataFrame, dollar_volume: pd.DataFrame, floor: float
) -> dict[str, pd.Timestamp]:
    """First session each fund could carry this account, per ticker.

    The volume series is the engine's own — same window, same median,
    same expanding warm start — because the number being tested is
    literally the number the participation cap will read inside the
    loop. A second, tidier ADV computed here would let a fund pass this
    gate and then be refused by the cap, which is the failure this
    function exists to see coming.
    """
    liquid = (dollar_volume >= floor) & (close_unadj >= UNIVERSE.min_price)
    out: dict[str, pd.Timestamp] = {}
    for ticker in liquid.columns:
        column = liquid[ticker].to_numpy()
        if column.any():
            out[str(ticker)] = pd.Timestamp(liquid.index[int(column.argmax())])
    return out


def engine_dollar_volume(
    close_unadj: pd.DataFrame, volume: pd.DataFrame
) -> pd.DataFrame:
    """`MarketData.from_prices`'s liquidity series, restated here.

    Restated rather than imported because the engine builds it inside a
    constructor that also wants three price frames on one calendar, and
    what is needed at this point is the series alone, over the whole
    pull, before any panel has been cut.
    """
    window = UNIVERSE.dollar_volume_window
    dollars = close_unadj * volume
    adv = dollars.rolling(window, min_periods=max(5, window // 2)).median()
    head = max(window - 1, 0)
    if head:
        warm = dollars.iloc[:head].expanding(min_periods=3).median()
        adv.iloc[:head] = adv.iloc[:head].fillna(warm)
    return adv


def load_panel(
    start: date,
    end: date,
    *,
    source: Source,
    cache: ParquetCache | None,
) -> Panel:
    """Every fund the library names, plus the hurdle it is judged against.

    A seam as much as a function: the tests can drive the whole script
    through this name against a synthetic panel, which is the only way
    to prove the wiring without a price feed.

    Two hosts, and a failure at either is a failure of the whole pull.
    The bill series is not decoration — three of these rules gate on it
    and every Sharpe below is excess of it — so a run with a silently
    zero hurdle would measure strategies nobody wrote under the names
    of strategies somebody did.
    """
    wanted = set(registry.panel_tickers()) | set(UNIVERSE_TICKERS)
    src = _build_source(source, cache=cache, allowed=wanted)
    try:
        pulled = src.prices(HISTORY_START, end)
    except SourceUnavailable as exc:
        raise DataUnavailable(str(exc)) from exc

    if pulled.empty:
        raise DataUnavailable(
            f"the price pull returned no bars through {end.isoformat()}. An "
            "empty frame is not a market fact here — it is the shape of a "
            "failed request."
        )

    def wide(column: str) -> pd.DataFrame:
        return pulled.pivot(index="date", columns="ticker", values=column).sort_index()

    close_unadj = wide("close_unadj")
    adv = engine_dollar_volume(close_unadj, wide("volume_unadj"))

    try:
        pct_rate = fetch_rate(HISTORY_START, end)
    except TbillUnavailable as exc:
        raise DataUnavailable(
            f"{exc} Three of these rules gate on the bill rate and every "
            "Sharpe below is excess of it. Zero is not a neutral stand-in "
            "for a series that ran 5% to 0% to 5% across this sample."
        ) from exc
    rf = pct_rate.astype("float64") / 100.0
    rf.name = FRED_SERIES

    index = pd.DatetimeIndex(close_unadj.index)
    sessions = index[(index >= pd.Timestamp(start)) & (index <= pd.Timestamp(end))]
    if len(sessions) < 2:
        raise DataUnavailable(
            f"the pull produced {len(sessions)} session(s) inside "
            f"{start.isoformat()} to {end.isoformat()}. Nothing can be "
            "measured across one bar, and a one-row window is what a "
            "half-served request looks like."
        )

    floor = adv_floor(build_config(COST_MULTIPLES[0]))
    return Panel(
        prices=pulled,
        risk_free=rf,
        dollar_volume=adv,
        deployable=deployability(close_unadj, adv, floor),
        listed={
            str(t): pd.Timestamp(d)
            for t, d in pulled.groupby("ticker")["date"].min().items()
        },
        served=frozenset(str(t) for t in pulled["ticker"].unique()),
        study_start=pd.Timestamp(start),
        study_end=pd.Timestamp(end),
        source_label=src.label,
        cache_note="disabled (--no-cache)" if cache is None else str(cache.root),
        rf_note=(
            f"FRED {FRED_SERIES}, the 3-month constant-maturity bill yield, "
            f"annualised and converted geometrically to a per-session hurdle "
            f"({float(rf.min()):.2%}-{float(rf.max()):.2%} across the pull)"
        ),
        adv_floor=floor,
        sessions=pd.DatetimeIndex(sessions),
    )


def _build_source(source: Source, *, cache: ParquetCache | None, allowed: set[str]):
    """The adapter behind `--source`, imported late.

    Late because the keyed source reads an environment variable at
    construction and raises when the key is absent, and a run against
    the keyless endpoint should not have to own a token it will never
    use. The allowlist is the sleeve wall widened to exactly the funds
    this library names and no further — three of them (IWC, RWX, SPMO)
    are not in `etfuniverse.UNIVERSE` and are pulled because a registry
    entry declares them, which is the registry's own note on SPMO being
    acted on rather than read.
    """
    if source is Source.tiingo:
        from griffinquant.data.etfuniverse import ETFUniverseSource

        return ETFUniverseSource(allowed=allowed, cache=cache, fetch_names=False)

    from griffinquant.data.sleevedata import SleeveETFSource

    return SleeveETFSource(allowed=allowed, cache=cache)


# -- windows ------------------------------------------------------------


@dataclass(frozen=True)
class Window:
    """One stretch of a run's equity curve, and why it is being read.

    `start` is the first session INSIDE the window and `stop`, where it
    exists, is the first session outside it. The measurement anchors on
    the last NAV before `start`, which is `period_breakout`'s
    convention and matters more than it looks: slicing on dates alone
    forfeits the window's own first session, and across four windows
    and thirty-four books the leak all runs one way.
    """

    name: str
    label: str
    start: pd.Timestamp
    stop: pd.Timestamp | None
    note: str


@dataclass(frozen=True)
class Measured:
    """One window of one run, measured once."""

    window: Window
    report: metrics.PerformanceReport
    n_deferrals: int
    n_unsettled: int
    median_invested: float

    @property
    def sessions(self) -> int:
        return int(self.report.n_sessions)

    @property
    def long_enough(self) -> bool:
        return self.sessions >= MIN_WINDOW_SESSIONS


def _cut(index: pd.Index, window: Window) -> tuple[int, int]:
    """(anchor position, stop position) for a window on a session index."""
    first = int(index.searchsorted(pd.Timestamp(window.start), side="left"))
    stop = (
        len(index)
        if window.stop is None
        else int(index.searchsorted(pd.Timestamp(window.stop), side="left"))
    )
    return max(first - 1, 0), stop


def measure(
    result: BacktestResult,
    window: Window,
    *,
    rf: pd.Series,
    trials: int,
) -> Measured | None:
    """Read one window off a finished run.

    Returns None rather than a row of zeroes when the window holds
    fewer than two observations. A strategy whose vehicle listed after
    a window opens has no record over it, and an empty row printed as
    zeroes is the one shape that reads as a measurement.
    """
    equity = result.equity
    anchor, stop = _cut(equity.index, window)
    equity = equity.iloc[anchor:stop]
    if len(equity) < 2:
        return None

    # The anchor session belongs to the window BEFORE this one, so its
    # fills and its deferrals do too. Only its closing NAV is borrowed,
    # and only so the window keeps its own first session's return.
    lo, hi = equity.index[1], equity.index[-1]

    trades = result.trades
    if len(trades):
        trades = trades.loc[trades["date"].between(lo, hi)]
    deferrals = result.deferrals
    if len(deferrals):
        deferrals = deferrals.loc[deferrals["date"].between(lo, hi)]
    invested = result.daily.loc[
        result.daily["date"].between(lo, hi), "invested_weight"
    ]

    return Measured(
        window=window,
        report=metrics.evaluate(equity, trades=trades, rf=rf, trials=trials),
        n_deferrals=int(len(deferrals)),
        n_unsettled=(
            int((deferrals["reason"] == "unsettled_proceeds").sum())
            if len(deferrals)
            else 0
        ),
        median_invested=float(invested.median()) if len(invested) else float("nan"),
    )


def strategy_windows(
    entry: Entry | None, run_start: pd.Timestamp
) -> tuple[Window, ...]:
    """The stretches this row is entitled to be read over.

    Four at most, and the interesting one is `post`. `pre` exists so
    the decay claim has something to decay FROM — McLean and Pontiff's
    58% is a ratio, and a study that measures only the numerator can
    report a small post-publication return without ever showing that it
    used to be a large one. The two are cut so they partition: `pre`
    ends on the last session strictly before the paper and `post`
    begins on the first session on or after it, so no day is counted
    twice and none goes missing.
    """
    out = [
        Window(
            "full",
            "full sample",
            run_start,
            None,
            "from the study start, or from the first session this row's "
            "vehicles could absorb the account, whichever is later",
        )
    ]
    if entry is None or entry.published_on is None:
        return tuple(out)

    published = pd.Timestamp(entry.published_on)
    if published > run_start:
        out.append(
            Window(
                "pre",
                "before publication",
                run_start,
                published,
                "the stretch the author could see; out of sample for nobody",
            )
        )
    out.append(
        Window(
            "post",
            "after publication",
            max(published, run_start),
            None,
            "genuinely out of sample: the date was set by somebody else, in "
            "a document, and cannot be moved now",
        )
    )
    if entry.investable_from is not None:
        out.append(
            Window(
                "investable",
                "from the vehicle",
                max(pd.Timestamp(entry.investable_from), run_start),
                None,
                "the date an ETF existed to hold the idea, which for "
                "momentum is twenty years after the paper",
            )
        )
    return tuple(out)


# -- one run ------------------------------------------------------------


def build_config(multiple: float, *, caps: bool = False) -> BacktestConfig:
    """One account, thirty-four books, no per-strategy exemptions.

    Sleeve caps are OFF for everything the registry holds, and that is
    the registry's own instruction rather than a convenience: a 60/40
    run under a 40% ceiling on SPY is not 60/40, and VAA-G4 puts the
    whole book into one ETF by design, so a run under our risk policy
    would be measuring our risk policy. The caps come back for the
    nine-sleeve book at the end of the report, where they ARE the
    strategy.
    """
    common: dict[str, Any] = dict(
        cost_model=CostModel(multiple=float(multiple)),
        band_provenance=(
            "not tuned; the engine default, a round prior fixed before any "
            "result in this study existed"
        ),
    )
    if caps:
        return BacktestConfig(**common)
    return BacktestConfig(
        apply_sleeve_caps=False, default_max_weight=1.0, caps={}, **common
    )


@dataclass(frozen=True)
class Forensics:
    """What the sceptic needs, measured while the panel is still open.

    Kept as scalars rather than by holding on to every run's
    `MarketData`. A hundred and two runs each carrying five wide frames
    is most of a gigabyte, and the checks need eight numbers from each.
    """

    n_fills: int
    fills_after_decision: bool
    fills_at_next_open: bool
    marks_are_total_return: bool
    adjusted_cells: int
    adjusted_tickers: tuple[str, ...]
    n_columns: int
    min_weight: float
    max_gross: float


def forensics(result: BacktestResult, market: MarketData) -> Forensics:
    trades = result.trades
    after = at_open = bool(len(trades))
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

    adj, unadj = market.close_adj, market.close_unadj
    gap = (adj - unadj).abs()
    movers = tuple(str(c) for c in adj.columns if bool((gap[c] > 1e-9).any()))

    final = result.final_positions
    total_return = True
    if len(final):
        marks = final.set_index("ticker")["mark"]
        total_return = bool(
            np.allclose(
                marks.to_numpy(dtype="float64"),
                adj.iloc[-1].reindex(marks.index).to_numpy(dtype="float64"),
            )
        )

    held = result.weights
    gross = held.sum(axis=1)
    return Forensics(
        n_fills=int(len(trades)),
        fills_after_decision=after,
        fills_at_next_open=at_open,
        marks_are_total_return=total_return,
        adjusted_cells=int((gap > 1e-9).to_numpy().sum()),
        adjusted_tickers=movers,
        n_columns=int(len(adj.columns)),
        min_weight=float(held.to_numpy().min()) if held.size else 0.0,
        max_gross=float(gross.max()) if len(gross) else 0.0,
    )


@dataclass(frozen=True)
class Run:
    """One strategy at one cost multiple, and every window read off it."""

    key: str
    label: str
    family: str
    entry: Entry | None
    multiple: float
    tickers: tuple[str, ...]
    run_start: pd.Timestamp
    result: BacktestResult
    forensics: Forensics
    windows: dict[str, Measured]

    @property
    def id(self) -> str:
        return f"{self.key}@{self.multiple:g}x"

    @property
    def full(self) -> Measured:
        return self.windows["full"]

    def at(self, name: str) -> Measured | None:
        return self.windows.get(name)


def execute(
    key: str,
    label: str,
    family: str,
    entry: Entry | None,
    *,
    strategy: Any,
    tickers: Sequence[str],
    run_start: pd.Timestamp,
    panel: Panel,
    multiple: float,
    trials: int,
    caps: bool = False,
) -> Run:
    """One backtest, then every window read off the one equity curve.

    Deliberately one run per (strategy, cost) rather than one per
    window. A fresh backtest opening on a publication date would spend
    its first twelve months banking a warmup the rule had already
    banked years earlier and would report that cash as the strategy's
    post-publication return. The pre-publication tape is used for the
    rule's own trailing windows and for nothing else: no parameter here
    was chosen by looking at it, because no parameter here was chosen
    at all.
    """
    market = MarketData.from_prices(panel.slice(tickers, run_start), key="ticker")
    result = run_backtest(market, strategy, build_config(multiple, caps=caps))

    measured: dict[str, Measured] = {}
    for window in strategy_windows(entry, run_start):
        got = measure(result, window, rf=panel.risk_free, trials=trials)
        if got is not None:
            measured[window.name] = got

    return Run(
        key=key,
        label=label,
        family=family,
        entry=entry,
        multiple=float(multiple),
        tickers=tuple(tickers),
        run_start=pd.Timestamp(run_start),
        result=result,
        forensics=forensics(result, market),
        windows=measured,
    )


def build_strategy(entry: Entry, panel: Panel) -> Any:
    """A fresh instance, with the bill series where a rule asks for one.

    Fresh every time because several of these classes latch — see
    `Entry.build`. The hurdle travels only into the rules whose
    published form is stated against T-bills; handing it to the rest
    would be inventing a parameter nobody wrote down.
    """
    kwargs: dict[str, Any] = {}
    if "risk_free" in inspect.signature(entry.strategy_class.__init__).parameters:
        kwargs["risk_free"] = panel.risk_free
    return entry.build(**kwargs)


def run_start_for(entry: Entry, panel: Panel) -> tuple[pd.Timestamp, tuple[str, ...]]:
    """When this row opens, and on which legs.

    The first session ANY leg can carry the account, not the last.
    These strategies are written to hold an incomplete book and to say
    so through `absences()`, and waiting for the last leg would defer
    Faber's rule to BIL's listing in 2007 and report two years of a
    five-asset rule as though it had never run.
    """
    tickers = tuple(entry.panel) if entry.panel else panel.universe_available
    dates = [panel.deployable[t] for t in tickers if t in panel.deployable]
    if not dates:
        return pd.NaT, tickers
    return max(panel.study_start, min(dates)), tickers


# -- the benchmark ------------------------------------------------------


class SpyBench:
    """Buy and hold SPY, run fresh from every date a strategy opens on.

    One SPY run per distinct opening session rather than one for the
    whole study, and the extra runs buy the only thing that makes the
    excess columns mean anything: both books start in cash on the same
    morning, both spend nineteen sessions deploying under the same
    turnover budget, and both pay the ramp. A single 2005 SPY curve
    sub-sliced at 2013 would be a fully invested benchmark measured
    against a strategy that had to buy its way in, and every factor row
    would carry that handicap without saying so.
    """

    def __init__(self, panel: Panel, trials: int) -> None:
        self.panel = panel
        self.trials = trials
        self._runs: dict[tuple[pd.Timestamp, float], Run] = {}

    def run(self, start: pd.Timestamp, multiple: float) -> Run:
        cache_key = (pd.Timestamp(start), float(multiple))
        if cache_key not in self._runs:
            self._runs[cache_key] = execute(
                "spy_benchmark",
                "buy and hold SPY (benchmark)",
                "static",
                None,
                strategy=registry.build("spy_buy_and_hold"),
                tickers=("SPY",),
                run_start=pd.Timestamp(start),
                panel=self.panel,
                multiple=multiple,
                trials=self.trials,
            )
        return self._runs[cache_key]

    def against(self, run: Run, window: Window) -> Measured | None:
        """SPY over exactly this window, opened on exactly this date."""
        bench = self.run(run.run_start, run.multiple)
        return measure(
            bench.result, window, rf=self.panel.risk_free, trials=self.trials
        )

    @property
    def runs(self) -> tuple[Run, ...]:
        return tuple(self._runs.values())


# -- the whole study ----------------------------------------------------


@dataclass(frozen=True)
class Skip:
    """A strategy that was not measured, and exactly what was missing.

    Never silently substituted and never quietly dropped from the
    denominator. A replication study that swaps a vehicle for one that
    happens to have the history it needs is performing the first move
    the study exists to observe.
    """

    key: str
    family: str
    reason: str
    missing: tuple[str, ...]


@dataclass(frozen=True)
class Study:
    panel: Panel
    runs: dict[str, Run]
    skips: tuple[Skip, ...]
    bench: SpyBench
    checks: tuple[Check, ...]
    trials: int
    multiples: tuple[float, ...]
    measured_keys: tuple[str, ...]

    @property
    def clean(self) -> bool:
        return bool(self.checks) and all(c.passed for c in self.checks)

    def at(self, key: str, multiple: float) -> Run | None:
        return self.runs.get(f"{key}@{multiple:g}x")

    def ordered(self, multiple: float) -> list[Run]:
        wanted = (f"{k}@{multiple:g}x" for k in self.measured_keys)
        return [self.runs[k] for k in wanted if k in self.runs]

    def dated(self, multiple: float) -> list[Run]:
        return [
            r
            for r in self.ordered(multiple)
            if r.entry is not None and r.entry.dated
        ]


def trial_config(panel: Panel, multiples: Sequence[float]) -> dict[str, Any]:
    """The fingerprint of the whole study, which is one configuration.

    Thirty-three strategies in one row on purpose. Each is implemented
    as its source states it, nothing was swept and nothing was chosen
    by looking at a result, so what was evaluated here is a single
    decision — run the library as published. Inflating it to
    thirty-three would overstate the search and, through the deflated
    Sharpe, raise the hurdle every number in this report is judged
    against. That direction is the safe one to be wrong in and it would
    still be wrong: a denominator padded for the look of the thing is
    as unreadable as one that was quietly trimmed.
    """
    return {
        "study": "post_publication_ledger",
        "strategies": sorted(registry.keys()),
        "cost_multiples": [float(m) for m in multiples],
        "start": panel.study_start.date().isoformat(),
        "end": panel.study_end.date().isoformat(),
        "caps": False,
        "buffer": DEFAULT_BUFFER_FRACTION,
        "settlement": 1,
        "turnover_budget": 0.05,
        "adv_floor": panel.adv_floor,
        "tuned": False,
    }


def study(
    panel: Panel,
    *,
    ledger: runs.Trials,
    multiples: Sequence[float] = COST_MULTIPLES,
    on_progress: Callable[[Run], None] | None = None,
) -> Study:
    """Run the library, then attack it."""
    # Logged before a single backtest runs. A ledger written after a
    # result can be edited by the result, and the whole value of the
    # count is that it is a denominator nobody chose.
    ledger.log(
        trial_config(panel, multiples),
        f"post-publication ledger: {len(registry.keys())} published "
        f"strategies as published, {panel.study_start.date()} to "
        f"{panel.study_end.date()}, no parameter tuned — one study",
    )
    trials = ledger.distinct

    table: dict[str, Run] = {}
    skips: list[Skip] = []
    measured: list[str] = []

    for entry in registry.entries():
        start, tickers = run_start_for(entry, panel)
        missing = tuple(t for t in tickers if t not in panel.served)
        if missing:
            skips.append(
                Skip(
                    entry.key,
                    entry.family,
                    "the pull returned no bars for part of this strategy's "
                    "declared universe",
                    missing,
                )
            )
            continue
        if pd.isna(start) or start >= panel.study_end:
            skips.append(
                Skip(
                    entry.key,
                    entry.family,
                    f"no leg ever carried a median ${panel.adv_floor:,.0f} a "
                    f"day inside the sample, so the account could never "
                    f"deploy into this book",
                    tickers,
                )
            )
            continue

        measured.append(entry.key)
        for multiple in multiples:
            run = execute(
                entry.key,
                entry.title,
                entry.family,
                entry,
                strategy=build_strategy(entry, panel),
                tickers=tickers,
                run_start=start,
                panel=panel,
                multiple=multiple,
                trials=trials,
            )
            table[run.id] = run
            if on_progress is not None:
                on_progress(run)

    # This fund's own book, last and separate. It wears the sleeve caps
    # because for this row the caps ARE the strategy, and it carries no
    # publication date because there is no paper.
    sleeve_tickers = tuple(s.ticker for s in SLEEVES)
    if set(sleeve_tickers) <= panel.served:
        measured.append(OUR_KEY)
        for multiple in multiples:
            run = execute(
                OUR_KEY,
                OUR_LABEL,
                "house",
                None,
                strategy=SleeveSizing(
                    name="sleeve sizing",
                    risk_free=panel.risk_free,
                    hold_cash_sleeve=True,
                ),
                tickers=sleeve_tickers,
                run_start=panel.study_start,
                panel=panel,
                multiple=multiple,
                trials=trials,
                caps=True,
            )
            table[run.id] = run
            if on_progress is not None:
                on_progress(run)
    else:
        skips.append(
            Skip(
                OUR_KEY,
                "house",
                "the pull is short a sleeve vehicle",
                tuple(t for t in sleeve_tickers if t not in panel.served),
            )
        )

    bench = SpyBench(panel, trials)
    for run in table.values():
        bench.run(run.run_start, run.multiple)

    partial = Study(
        panel=panel,
        runs=table,
        skips=tuple(skips),
        bench=bench,
        checks=(),
        trials=trials,
        multiples=tuple(float(m) for m in multiples),
        measured_keys=tuple(measured),
    )
    return dataclasses.replace(partial, checks=sceptic_checks(partial))


# -- the decay arithmetic -----------------------------------------------


@dataclass(frozen=True)
class Interval:
    point: float
    lo: float
    hi: float
    n: int
    method: str


def _bootstrap(
    values: np.ndarray, statistic: Callable[..., Any], draws: int
) -> tuple[float, float]:
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    if len(values) < 2:
        return float("nan"), float("nan")
    picks = rng.integers(0, len(values), size=(draws, len(values)))
    stats = statistic(values[picks], axis=1)
    return float(np.percentile(stats, 2.5)), float(np.percentile(stats, 97.5))


def mean_interval(values: Sequence[float]) -> Interval:
    """The mean with a normal-theory interval, and its own caveat.

    Computed as though the records were independent draws. They are
    not — most run over the same calendar decade and most are long
    equity beta with a rule on top — so the effective sample is well
    below n and this interval is NARROWER than the truth. It is
    reported as a lower bound on the uncertainty rather than as the
    uncertainty, which is the only honest thing to do with an interval
    known in advance to be optimistic.
    """
    arr = np.asarray([v for v in values if np.isfinite(v)], dtype="float64")
    n = int(len(arr))
    if n < 2:
        return Interval(float("nan"), float("nan"), float("nan"), n, "too few rows")
    mean = float(arr.mean())
    se = float(arr.std(ddof=1) / math.sqrt(n))
    z = metrics.norm_ppf(0.975)
    return Interval(
        mean,
        mean - z * se,
        mean + z * se,
        n,
        "normal-theory across strategies; narrower than the truth because "
        "the records overlap in calendar time",
    )


def median_interval(values: Sequence[float]) -> Interval:
    arr = np.asarray([v for v in values if np.isfinite(v)], dtype="float64")
    n = int(len(arr))
    if n < 2:
        return Interval(float("nan"), float("nan"), float("nan"), n, "too few rows")
    lo, hi = _bootstrap(arr, np.median, BOOTSTRAP_DRAWS)
    return Interval(
        float(np.median(arr)),
        lo,
        hi,
        n,
        f"percentile bootstrap, {BOOTSTRAP_DRAWS:,} draws, seed "
        f"{BOOTSTRAP_SEED}; carries the same overlap caveat",
    )


@dataclass(frozen=True)
class Decay:
    """What the study was commissioned to find out."""

    keys: tuple[str, ...]
    excess: tuple[float, ...]
    mean: Interval
    median: Interval
    n_positive: int
    #: (key, reason) for every dated strategy the arithmetic could not
    #: use. Carried rather than dropped: a denominator that shrinks
    #: without saying so is the failure this table would otherwise be
    #: most exposed to.
    excluded: tuple[tuple[str, str], ...]
    #: Rows whose publication predates the sample. For these,
    #: "post-publication" is the whole tape and buys no out-of-sample
    #: discipline the data did not already impose.
    n_published_before_sample: int
    paired_keys: tuple[str, ...]
    #: (key, reason) for a row that has an after but no usable before,
    #: so the pairing could not be made. Printed for the same reason
    #: `excluded` is: the paired mean has a different and smaller
    #: denominator than the headline mean, and a reader comparing the
    #: two is owed the difference rather than left to find it.
    pair_excluded: tuple[tuple[str, str], ...]
    pre_excess: tuple[float, ...]
    post_excess_paired: tuple[float, ...]
    pre_mean: float
    post_mean: float
    #: post minus pre, in return points. Defined in every sign case,
    #: which is why it is the field the verdict leans on.
    change_pp: float
    #: `1 - post/pre`, and NaN unless the pre-publication excess was
    #: positive. A ratio against a negative denominator inverts: a rule
    #: that trailed SPY by 5.75% before and 7.00% after got worse, and
    #: the formula reports -22%, which reads as an improvement. Decay is
    #: a claim about an edge shrinking and there has to be an edge for
    #: it to be a claim about anything.
    decay_fraction: float


def _unusable(window: Measured | None) -> str:
    """Why this window cannot carry an annualised excess, or "".

    Two disqualifications and they are different failures. Too short is
    an arithmetic objection: annualising a stretch under a trading year
    is extrapolation with a percent sign on it. Under-deployed is a
    measurement objection: a book that was mostly in cash across the
    window has an excess return that describes the cash.
    """
    if window is None:
        return "does not exist"
    if not window.long_enough:
        return (
            f"is {window.sessions} sessions, under the "
            f"{MIN_WINDOW_SESSIONS} needed to annualise"
        )
    if (
        np.isfinite(window.median_invested)
        and window.median_invested < MIN_MEDIAN_INVESTED
    ):
        return (
            f"held a median {window.median_invested:.0%} invested, so its "
            f"return describes the cash rather than the rule"
        )
    return ""


def decay(s: Study, multiple: float) -> Decay:
    """Mean and median post-publication excess, and the decay ratio.

    The paired half is what speaks to McLean and Pontiff: their 58% is
    a ratio of after to before, so it needs both, and only strategies
    published INSIDE this sample have a before. The unpaired mean is
    taken over every dated row, because dropping the ones published
    before 2005 would select the sample on a property correlated with
    the outcome — old ideas have had longer to be arbitraged away.
    """
    keys: list[str] = []
    excess: list[float] = []
    paired: list[str] = []
    pre: list[float] = []
    post_paired: list[float] = []
    excluded: list[tuple[str, str]] = []
    pair_excluded: list[tuple[str, str]] = []
    early = 0

    for run in s.dated(multiple):
        if run.entry is not None and run.entry.published_on is not None:
            if pd.Timestamp(run.entry.published_on) <= s.panel.study_start:
                early += 1

        window = run.at("post")
        why = _unusable(window)
        if why:
            excluded.append((run.key, f"post window {why}"))
            continue
        bench = s.bench.against(run, window.window)
        if bench is None:
            excluded.append((run.key, "no benchmark curve over the window"))
            continue
        gap = float(window.report.cagr - bench.report.cagr)
        keys.append(run.key)
        excess.append(gap)

        # A pairing needs a usable BEFORE as well, and the same two
        # tests apply. multifactor_ishares is why the deployment test is
        # here: its pre-publication year is a blend two of whose four
        # legs had not listed, so the book is a quarter invested and the
        # -24.5% "excess" is the three absent legs rather than the
        # strategy. The published construction is right to leave them
        # out — an absent leg is excluded, not redistributed — and a
        # decay ratio computed off it would be measuring absence.
        before = run.at("pre")
        why_pre = _unusable(before)
        if why_pre:
            if before is not None:
                pair_excluded.append((run.key, f"pre window {why_pre}"))
            continue
        bench_pre = s.bench.against(run, before.window)
        if bench_pre is None:
            pair_excluded.append((run.key, "no benchmark curve before the paper"))
            continue
        paired.append(run.key)
        pre.append(float(before.report.cagr - bench_pre.report.cagr))
        post_paired.append(gap)

    pre_mean = float(np.mean(pre)) if pre else float("nan")
    post_mean = float(np.mean(post_paired)) if post_paired else float("nan")
    fraction = (
        float(1.0 - post_mean / pre_mean)
        if pre and pre_mean > 1e-12
        else float("nan")
    )

    return Decay(
        keys=tuple(keys),
        excess=tuple(excess),
        mean=mean_interval(excess),
        median=median_interval(excess),
        n_positive=int(sum(1 for v in excess if v > 0.0)),
        excluded=tuple(excluded),
        n_published_before_sample=early,
        paired_keys=tuple(paired),
        pair_excluded=tuple(pair_excluded),
        pre_excess=tuple(pre),
        post_excess_paired=tuple(post_paired),
        pre_mean=pre_mean,
        post_mean=post_mean,
        change_pp=float(post_mean - pre_mean),
        decay_fraction=fraction,
    )


# -- the sceptic --------------------------------------------------------


def sceptic_checks(s: Study) -> tuple[Check, ...]:
    """Attack every number above before any of them is believed.

    The list runs whatever the results came back as. A check that only
    fires on a good result is a check calibrated to find nothing.
    """
    cheap, dear = float(s.multiples[0]), float(s.multiples[-1])
    everything = [*s.runs.values(), *s.bench.runs]
    checks: list[Check] = []

    # 1. The rows this engine has already published. If they have moved,
    #    the plumbing has moved, and nothing else here is a new finding
    #    — it is a second set of numbers quietly disagreeing with the
    #    first.
    lines: list[str] = []
    reproduced = True
    for ref in (*REFERENCES, OUR_REFERENCE):
        run = s.at(ref.key, cheap)
        if run is None:
            reproduced = False
            lines.append(f"{ref.label}: NOT RUN")
            continue
        got = run.full.report
        ok = round(float(got.cagr) * 100.0, 2) == round(
            ref.cagr * 100.0, 2
        ) and round(float(got.sharpe), 2) == round(ref.sharpe, 2)
        reproduced = reproduced and ok
        lines.append(
            f"{ref.label} {got.cagr:.2%} / {got.sharpe:.2f} against a "
            f"published {ref.cagr:.2%} / {ref.sharpe:.2f}"
            f"{'' if ok else ' — MOVED'}"
        )
    checks.append(
        Check(
            "The known rows reproduce to the printed digit",
            reproduced,
            "; ".join(lines)
            + ". Same window as `reports/stage3_sleeves.md`",
        )
    )

    # 2. Long only and unlevered, on every session of every run. The
    #    engine raises on a negative target and on a gross above one, so
    #    a finished run has already passed this — stated in REALISED
    #    weights rather than assumed, because "it did not raise" is not
    #    a sentence a reader can check.
    worst_short = min((r.forensics.min_weight for r in everything), default=0.0)
    heaviest = max(
        ((r.forensics.max_gross, r.id) for r in everything), default=(0.0, "")
    )
    checks.append(
        Check(
            "Long only and unlevered throughout",
            worst_short >= -1e-9 and heaviest[0] <= 1.0 + 1e-9,
            f"across {len(everything)} runs and every session of each: most "
            f"negative realised weight {worst_short:+.2e}, largest gross "
            f"exposure {heaviest[0]:.6f} of NAV ({heaviest[1] or 'none held'})",
        )
    )

    # 3. Every fill after the decision that caused it, at that session's
    #    own unadjusted open. A fill on the signal's own close is the
    #    single most common way a backtest of this shape lies.
    traded = [r for r in everything if r.forensics.n_fills]
    fills = sum(r.forensics.n_fills for r in traded)
    checks.append(
        Check(
            "Fills land at the NEXT open",
            bool(traded)
            and all(r.forensics.fills_after_decision for r in traded)
            and all(r.forensics.fills_at_next_open for r in traded),
            f"{fills:,} fills across {len(traded)} runs, every one strictly "
            f"after its decision session and priced at that session's own "
            f"unadjusted open to the last bit",
        )
    )

    # 4. Returns come from the total-return series, asked PANEL-WIDE.
    #    Back-adjustment anchors at the final bar, so close_adj equals
    #    close_unadj there for every instrument BY CONSTRUCTION; a check
    #    posed on the closing bar is a check that cannot pass, and a
    #    check that cannot pass teaches the reader to wave the row
    #    through.
    cells = sum(r.forensics.adjusted_cells for r in everything)
    movers = sorted({t for r in everything for t in r.forensics.adjusted_tickers})
    columns = sum(r.forensics.n_columns for r in everything)
    checks.append(
        Check(
            "Positions are marked in total-return space",
            all(r.forensics.marks_are_total_return for r in everything) and cells > 0,
            f"every closing position marked at `close_adj`; across the panels "
            f"{cells:,} ticker-days carry an adjusted close that differs from "
            f"the as-traded one, on {len(movers)} distinct tickers of "
            f"{columns:,} panel-columns. Measured panel-wide because "
            f"back-adjustment anchors at the final bar, where the two agree "
            f"everywhere by construction",
        )
    )

    # 5. Costs were charged inside the loop, are non-zero, and move with
    #    the multiple. A cost model wired to nothing produces a
    #    beautiful curve and a zero in this row. Not exactly the ratio
    #    of the multiples: the multiple changes the fills, which changes
    #    the book, which changes what there is to trade.
    one = sum(r.result.cost_breakdown["total"] for r in s.ordered(cheap))
    spread = sum(r.result.cost_breakdown["spread"] for r in s.ordered(cheap))
    impact = sum(r.result.cost_breakdown["impact"] for r in s.ordered(cheap))
    stressed = sum(r.result.cost_breakdown["total"] for r in s.ordered(dear))
    want = dear / cheap if cheap else float("nan")
    ratio = stressed / one if one > 0 else float("nan")
    checks.append(
        Check(
            "Trading costs are charged inside the loop",
            bool(
                one > 0.0
                and spread > 0.0
                and impact > 0.0
                and np.isfinite(ratio)
                and 0.6 * want <= ratio <= 1.4 * want
            ),
            f"{runs.money(one)} at {cheap:g}x across every book "
            f"({runs.money(spread)} spread, {runs.money(impact)} impact), "
            f"{runs.money(stressed)} at {dear:g}x — a ratio of {ratio:.2f} "
            f"against a nominal {want:.2g}, which will not be exact because "
            f"the multiple changes the fills and therefore the book",
        )
    )

    # 6. Every measured book actually got invested. Earned rather than
    #    invented: the first cut of this study reported USMV at 2.31% a
    #    year, which was not a fact about low volatility but a book that
    #    had been 22% invested since 2011 because a newborn ETF's tape
    #    could not absorb the account and the buy-and-hold latch quite
    #    correctly stopped trying.
    thin = [
        (r.key, r.full.median_invested)
        for r in s.ordered(cheap)
        if np.isfinite(r.full.median_invested)
        and r.full.median_invested < MIN_MEDIAN_INVESTED
    ]
    lowest = min(
        (
            r.full.median_invested
            for r in s.ordered(cheap)
            if np.isfinite(r.full.median_invested)
        ),
        default=float("nan"),
    )
    checks.append(
        Check(
            "Every measured book deployed",
            not thin,
            f"median invested weight over the full window; the lowest of any "
            f"row is {lowest:.1%} against a {MIN_MEDIAN_INVESTED:.0%} floor"
            + (
                ""
                if not thin
                else "; UNDER-DEPLOYED: "
                + ", ".join(f"{k} at {v:.1%}" for k, v in thin)
            ),
        )
    )

    # 7. The number the brief says to disbelieve, applied to the
    #    full-sample column at 1x, where a figure this high on a
    #    long-only unlevered book is a bug rather than a bull market.
    hot = [
        (r.key, float(r.full.report.sharpe))
        for r in s.ordered(cheap)
        if np.isfinite(r.full.report.sharpe)
        and float(r.full.report.sharpe) > SUSPICIOUS_SHARPE
    ]
    best = max(
        (
            (float(r.full.report.sharpe), r.key)
            for r in s.ordered(cheap)
            if np.isfinite(r.full.report.sharpe)
        ),
        default=(float("nan"), ""),
    )
    checks.append(
        Check(
            f"No full-sample Sharpe at 1x exceeds {SUSPICIOUS_SHARPE:.1f}",
            not hot,
            f"the highest is {best[0]:.3f} ({best[1]}), over "
            f"{len(s.ordered(cheap))} books"
            + (
                ""
                if not hot
                else "; OVER THE LINE: "
                + ", ".join(f"{k} at {v:.2f}" for k, v in hot)
            ),
        )
    )

    # 8. Nothing fell out of the library between the registry and the
    #    table. A skipped strategy is a row in the skip table, never an
    #    absence.
    accounted = set(s.measured_keys) | {k.key for k in s.skips}
    expected = set(registry.keys()) | {OUR_KEY}
    checks.append(
        Check(
            "Every registered strategy is measured or named as skipped",
            accounted == expected,
            f"{len(registry.keys())} registered plus this fund's own book; "
            f"{len(s.measured_keys)} measured, {len(s.skips)} skipped and "
            f"named"
            + (
                ""
                if accounted == expected
                else f"; UNACCOUNTED: {sorted(expected - accounted)}"
            ),
        )
    )

    # 9. The decay denominator is the population, not the survivors.
    #    The test is that every dated strategy is either counted or
    #    excluded with a stated reason — NOT that the count comes to
    #    thirty. A rule demanding the full thirty would be satisfied by
    #    a run that quietly widened a threshold until nothing dropped,
    #    and would fail a run that honestly declared one row
    #    unmeasurable.
    d = decay(s, cheap)
    dated_total = len(registry.entries(dated=True))
    counted = len(d.excess)
    accounted_for = counted + len(d.excluded) == dated_total
    checks.append(
        Check(
            "Every dated strategy is counted or excluded by name",
            accounted_for,
            f"{counted} of {dated_total} dated strategies carry a usable "
            f"post-publication window; {len(d.excluded)} excluded and named"
            + (
                ""
                if not d.excluded
                else " (" + "; ".join(f"{k}: {why}" for k, why in d.excluded) + ")"
            )
            + (
                ""
                if accounted_for
                else f" — and {dated_total - counted - len(d.excluded)} row(s) "
                f"went missing from both lists, which is the one outcome "
                f"this check exists to catch"
            ),
        )
    )
    return tuple(checks)


# -- rendering ----------------------------------------------------------


def _cost(multiple: float) -> str:
    return f"{multiple:g}x"


def _recovery(dd: metrics.Drawdown) -> str:
    if dd.peak is None:
        return runs.NULL
    if dd.still_underwater:
        return f"open, {dd.sessions_underwater:,} sessions"
    return f"{dd.sessions_to_recover:,} sessions"


def _window_table(s: Study, multiple: float, name: str) -> str:
    rows: list[list[str]] = []
    for run in s.ordered(multiple):
        window = run.at(name)
        if window is None:
            continue
        bench = s.bench.against(run, window.window)
        r = window.report
        rows.append(
            [
                run.key,
                run.family,
                runs.day(r.start),
                runs.count(window.sessions),
                runs.num(r.years, 1),
                runs.signed_pct(r.cagr),
                runs.pct(r.annualised_volatility),
                runs.num(r.sharpe, 2),
                runs.num(r.deflated.deflated_sharpe if r.deflated else np.nan, 3),
                runs.pct(r.drawdown.depth),
                _recovery(r.drawdown),
                runs.signed_pct(bench.report.cagr) if bench else runs.NULL,
                runs.signed_pct(r.cagr - bench.report.cagr) if bench else runs.NULL,
                runs.num(r.sharpe - bench.report.sharpe, 2) if bench else runs.NULL,
                runs.num(r.costs.annual_turnover, 2),
                runs.bps(r.costs.cost_drag_bps),
                runs.count(window.n_deferrals),
            ]
        )
    if not rows:
        return "_No row carries this window._"
    return runs.table(
        [
            "Strategy",
            "Family",
            "From",
            "Sessions",
            "Years",
            "CAGR",
            "Vol",
            "Sharpe",
            "DSR",
            "Max DD",
            "Recovery",
            "SPY CAGR",
            "Excess CAGR",
            "Excess SR",
            "Turnover/yr",
            "Cost drag",
            "Deferrals",
        ],
        rows,
        ["l", "l", "l"] + ["r"] * 7 + ["l"] + ["r"] * 6,
    )


def _headline_table(s: Study, multiple: float) -> str:
    rows: list[list[str]] = []
    for run in s.ordered(multiple):
        full = run.full
        post = run.at("post")
        bench_full = s.bench.against(run, full.window)
        bench_post = s.bench.against(run, post.window) if post else None
        rows.append(
            [
                run.key,
                runs.signed_pct(full.report.cagr),
                runs.num(full.report.sharpe, 2),
                (
                    runs.signed_pct(full.report.cagr - bench_full.report.cagr)
                    if bench_full
                    else runs.NULL
                ),
                runs.signed_pct(post.report.cagr) if post else runs.NULL,
                runs.num(post.report.sharpe, 2) if post else runs.NULL,
                (
                    runs.signed_pct(post.report.cagr - bench_post.report.cagr)
                    if post and bench_post
                    else runs.NULL
                ),
            ]
        )
    return runs.table(
        [
            "Strategy",
            "CAGR (full)",
            "SR (full)",
            "vs SPY (full)",
            "CAGR (post)",
            "SR (post)",
            "vs SPY (post)",
        ],
        rows,
        ["l", "r", "r", "r", "r", "r", "r"],
    )


def _dates_table(s: Study) -> str:
    rows: list[list[str]] = []
    for run in s.ordered(s.multiples[0]):
        e = run.entry
        listed = min(
            (s.panel.listed[t] for t in run.tickers if t in s.panel.listed),
            default=pd.NaT,
        )
        rows.append(
            [
                run.key,
                runs.day(e.published_on) if e and e.published_on else "_undated_",
                runs.day(e.investable_from) if e and e.investable_from else runs.NULL,
                runs.day(listed),
                runs.day(run.result.equity.index[0]),
                (
                    f"{e.gap_days / 365.25:+.1f}"
                    if e and e.gap_days is not None
                    else runs.NULL
                ),
                runs.count(len(run.tickers)),
            ]
        )
    return runs.table(
        [
            "Strategy",
            "Published",
            "Investable",
            "Earliest bar",
            "Opened on",
            "Paper to fund (yrs)",
            "Legs",
        ],
        rows,
        ["l", "l", "l", "l", "l", "r", "r"],
    )


def _decay_table(d: Decay, s: Study, multiple: float) -> str:
    by_key = {r.key: r for r in s.dated(multiple)}
    pre_lookup = dict(zip(d.paired_keys, d.pre_excess))
    rows: list[list[str]] = []
    for key, gap in zip(d.keys, d.excess):
        run = by_key[key]
        post = run.at("post")
        rows.append(
            [
                key,
                runs.day(run.entry.published_on) if run.entry else runs.NULL,
                runs.count(post.sessions) if post else runs.NULL,
                runs.signed_pct(pre_lookup.get(key, np.nan)),
                runs.signed_pct(gap),
                "yes" if gap > 0 else "no",
            ]
        )
    return runs.table(
        [
            "Strategy",
            "Published",
            "Post sessions",
            "Excess before",
            "Excess after",
            "Beat SPY after?",
        ],
        rows,
        ["l", "l", "r", "r", "r", "l"],
    )


def _exclusion_notes(d: Decay) -> str:
    """Every row the arithmetic could not use, spelled out.

    A list rather than a cell in the table above, because one of these
    reasons runs to twenty words and a two-column table pads to its
    widest cell — which turned the summary into something nobody could
    read across. The content is the point either way: a denominator
    that shrinks without saying so is what this section would otherwise
    be most exposed to.
    """
    blocks: list[str] = []
    if d.excluded:
        blocks.append(
            "**Left out of the post-publication mean.**\n\n"
            + "\n".join(f"- `{k}` — {why}" for k, why in d.excluded)
        )
    else:
        blocks.append(
            "**No dated strategy was left out of the post-publication "
            "mean.** All "
            f"{d.mean.n} carry a window long enough to annualise and a book "
            "that was actually invested across it."
        )
    if d.pair_excluded:
        blocks.append(
            "**Have an after but no usable before, so they carry no "
            "pairing.** This is why the paired count is smaller than the "
            f"headline count, and every one of them is a window in which "
            f"the book was not yet running rather than a window in which it "
            f"ran badly.\n\n"
            + "\n".join(f"- `{k}` — {why}" for k, why in d.pair_excluded)
        )
    return "\n\n".join(blocks)


def _suspicious_table(s: Study, multiple: float) -> str:
    """Every window over the line, with the length that explains most.

    Held apart from the check on purpose. A twenty-year Sharpe of 1.3
    is a bug; a two-year Sharpe of 1.3 is a bull market, and a rule
    that refused both would refuse this report every time a factor ETF
    listed into a rally.
    """
    rows: list[list[str]] = []
    for run in s.ordered(multiple):
        for name, window in run.windows.items():
            sr = float(window.report.sharpe)
            if not (np.isfinite(sr) and sr > SUSPICIOUS_SHARPE):
                continue
            rows.append(
                [
                    run.key,
                    name,
                    runs.day(window.report.start),
                    runs.count(window.sessions),
                    runs.num(window.report.years, 1),
                    runs.num(sr, 2),
                    runs.signed_pct(window.report.cagr),
                    runs.pct(window.report.drawdown.depth),
                ]
            )
    if not rows:
        return (
            f"_No window in the study clears {SUSPICIOUS_SHARPE:.1f}. The "
            f"highest full-sample figure is in the sceptic table below._"
        )
    return runs.table(
        [
            "Strategy",
            "Window",
            "From",
            "Sessions",
            "Years",
            "Sharpe",
            "CAGR",
            "Max DD",
        ],
        rows,
        ["l", "l", "l", "r", "r", "r", "r", "r"],
    )


def _skip_table(s: Study) -> str:
    if not s.skips:
        return (
            "_Nothing was skipped: every ticker the library declares came "
            "back with bars, and every strategy carries a measurable "
            "window._"
        )
    return runs.table(
        ["Strategy", "Family", "Missing", "Why"],
        [
            [k.key, k.family, " ".join(k.missing) or runs.NULL, k.reason]
            for k in s.skips
        ],
        ["l", "l", "l", "l"],
    )


def _best(
    s: Study,
    multiple: float,
    field: str,
    *,
    min_years: float = 0.0,
    dated_only: bool = False,
) -> tuple[Run, float] | None:
    """The top row on one measure, over rows long enough to compare.

    `min_years` is the whole point of the signature. Ranking a 7.8-year
    record against a 21.6-year one on CAGR is not a ranking, it is a
    question about which window happened to contain a bull market, and
    the answer to "what did the best strategy return over fifteen to
    twenty years" has to come from rows that ran for fifteen to twenty
    years.
    """
    scored = [
        (float(getattr(r.full.report, field)), r)
        for r in s.ordered(multiple)
        if np.isfinite(float(getattr(r.full.report, field)))
        and float(r.full.report.years) >= min_years
        and (not dated_only or (r.entry is not None and r.entry.dated))
    ]
    if not scored:
        return None
    value, run = max(scored, key=lambda kv: kv[0])
    return run, value


def _answers(s: Study) -> str:
    """The two numbers the study was commissioned to produce.

    Put at the top and stated as plainly as they can be stated: a
    question asked in one sentence deserves an answer findable without
    reading twenty tables.
    """
    cheap = s.multiples[0]
    horizon = MIN_COMPARABLE_YEARS
    top_cagr = _best(s, cheap, "cagr", min_years=horizon)
    top_sharpe = _best(s, cheap, "sharpe", min_years=horizon)
    if top_cagr is None or top_sharpe is None:
        return (
            f"_No book ran for {horizon:.0f} years, so the question as "
            f"asked has no answer on this sample._"
        )

    by_cagr, cagr_value = top_cagr
    by_sharpe, sharpe_value = top_sharpe
    ours = s.at(OUR_KEY, cheap)
    spy = s.at("spy_buy_and_hold", cheap)
    n_long = len(
        [r for r in s.ordered(cheap) if r.full.report.years >= horizon]
    )
    lines: list[str] = []

    lines.append(
        f"Both answers are taken over the {horizon:.0f}-year-plus horizon "
        f"the question names, across the {n_long} of "
        f"{len(s.measured_keys)} books that ran that long. Ranking a "
        f"seven-year record against a twenty-one-year one on annualised "
        f"return is not a ranking — it is a question about which window "
        f"contained a bull market — so the shorter rows are reported "
        f"separately below and never mixed in."
    )

    published = _best(s, cheap, "cagr", min_years=horizon, dated_only=True)
    lines.append(
        f"**1. Annualised return.** The highest CAGR over the full "
        f"{by_cagr.full.report.years:.1f}-year sample is **{cagr_value:.2%} a "
        f"year** — `{by_cagr.key}`, {by_cagr.label}, at 1x cost, with a "
        f"{abs(by_cagr.full.report.drawdown.depth):.2%} worst drawdown and a "
        f"Sharpe of {by_cagr.full.report.sharpe:.2f}."
        + (
            f" The best PUBLISHED strategy over the same horizon is "
            f"`{published[0].key}` at {published[1]:.2%} a year, which is "
            f"{'ahead of' if published[1] > cagr_value else 'behind'} it "
            f"by {abs(published[1] - cagr_value):.2%}."
            if published is not None and published[0].key != by_cagr.key
            else ""
        )
    )

    if ours is not None:
        dd_saved = (
            abs(spy.full.report.drawdown.depth)
            - abs(ours.full.report.drawdown.depth)
            if spy is not None
            else float("nan")
        )
        lines.append(
            f"**2. Ours.** The Griffin nine-sleeve book returned "
            f"**{ours.full.report.cagr:.2%} a year** over "
            f"{ours.full.report.years:.1f} years, at "
            f"{ours.full.report.annualised_volatility:.2%} volatility, a "
            f"Sharpe of {ours.full.report.sharpe:.2f} and a "
            f"{abs(ours.full.report.drawdown.depth):.2%} worst drawdown."
            + (
                f" Buying and holding SPY over the same window returned "
                f"{spy.full.report.cagr:.2%} a year at "
                f"{spy.full.report.annualised_volatility:.2%} volatility and "
                f"lost {abs(spy.full.report.drawdown.depth):.2%} doing it. We "
                f"gave up {spy.full.report.cagr - ours.full.report.cagr:.2%} a "
                f"year of return to take {dd_saved:.2%} "
                f"less drawdown; whether that was a good trade is a mandate "
                f"question and not one this file can settle."
                if spy is not None
                else ""
            )
        )

    beats = sharpe_value > HOUSE_SHARPE
    deflated = by_sharpe.full.report.deflated
    lines.append(
        f"**3. Sharpe.** The best Sharpe over the same horizon is "
        f"**{sharpe_value:.2f}** — `{by_sharpe.key}`, {by_sharpe.label}, at "
        f"{by_sharpe.full.report.cagr:.2%} a year and "
        f"{by_sharpe.full.report.annualised_volatility:.2%} volatility over "
        f"{by_sharpe.full.report.years:.1f} years. That "
        f"{'**beats**' if beats else 'does not beat'} the "
        f"{HOUSE_SHARPE:.2f} the nine-sleeve book and the daily 60/40 both "
        f"landed on"
        + (f", by {sharpe_value - HOUSE_SHARPE:.2f}." if beats else ".")
        + (
            f" Deflated against the {s.trials:,} distinct configurations on "
            f"file it is {deflated.deflated_sharpe:.3f}, which "
            f"{'clears' if deflated.significant else 'does not clear'} the "
            f"{metrics.SIGNIFICANCE_THRESHOLD:.0%} bar — that is the number "
            f"to quote if anybody asks whether it is real."
            if deflated
            else ""
        )
    )

    short_cagr = _best(s, cheap, "cagr")
    short_sharpe = _best(s, cheap, "sharpe")
    extras: list[str] = []
    if short_cagr is not None and short_cagr[0].key != by_cagr.key:
        extras.append(
            f"`{short_cagr[0].key}` returned {short_cagr[1]:.2%} a year, but "
            f"over {short_cagr[0].full.report.years:.1f} years"
        )
    if (
        short_sharpe is not None
        and short_sharpe[0].key != by_sharpe.key
        and short_sharpe[0].key != (short_cagr[0].key if short_cagr else "")
    ):
        extras.append(
            f"`{short_sharpe[0].key}` scored a Sharpe of {short_sharpe[1]:.2f} "
            f"over {short_sharpe[0].full.report.years:.1f} years"
        )
    if extras:
        lines.append(
            "**Shorter records, kept out of the two answers above.** "
            + "; ".join(extras)
            + ". These are the rows whose vehicles listed late, and their "
            "windows are mostly the 2018-2026 US equity run. They are in "
            "every table below with their lengths beside them; they are not "
            "an answer to a question about fifteen to twenty years."
        )
    return "\n\n".join(lines)


def _prior_verdict(d: Decay) -> str:
    """Say plainly whether the pattern reproduces.

    Plainly is the whole requirement. "Broadly consistent with" is what
    a result says when nobody wants to write down which way it went.
    """
    if not np.isfinite(d.mean.point):
        return (
            "Not answerable from this run: no dated strategy carried a "
            "post-publication window long enough to measure."
        )

    n_paired = len(d.paired_keys)
    both_sides = (
        f"On the {n_paired} "
        f"{'strategy' if n_paired == 1 else 'strategies'} with a record on "
        f"both sides of its own publication date, the mean excess over SPY "
        f"went from {d.pre_mean:+.2%} a year before to {d.post_mean:+.2%} a "
        f"year after, a change of {d.change_pp:+.2%}."
    )
    if not n_paired:
        mclean = (
            "Not measurable here: no strategy was published inside the "
            "sample, so none has a before as well as an after."
        )
    elif not np.isfinite(d.decay_fraction):
        # The ratio is undefined rather than merely awkward. See the note
        # on `Decay.decay_fraction`: against a negative denominator it
        # inverts, and a rule that fell further behind SPY would be
        # reported as having improved. Two readings of that, and the
        # difference between them matters — a mean excess of -0.26% is
        # a library that MATCHED the index before publication, which is
        # a different sentence from one that trailed it badly.
        flat = abs(d.pre_mean) < 0.01
        mclean = (
            f"{both_sides} **No decay ratio is quoted, and the reason is "
            f"arithmetic rather than editorial:** 1 - after/before against a "
            f"denominator at or below zero inverts, so a rule that fell "
            f"further behind SPY would be reported as having improved. "
            + (
                f"What the two levels say instead is that this library "
                f"roughly MATCHED the index before publication and trailed "
                f"it by {abs(d.post_mean):.2%} a year after. A percentage "
                f"decay needs an edge to take a percentage of, and there was "
                f"not one; the {abs(d.change_pp):.2%} fall in the level is "
                f"the finding, and it is a larger absolute deterioration "
                f"than McLean and Pontiff's average anomaly suffered."
                if flat
                else f"These rules did not beat SPY before publication "
                f"either. That is a harsher finding than the 58% decay they "
                f"document, not a softer one: their anomalies were real and "
                f"shrank, and this library's average row never cleared the "
                f"index at this account's size in the first place."
            )
        )
    else:
        if d.decay_fraction > 1.0:
            reading = (
                "That is more than complete decay: the excess did not "
                "shrink, it changed sign."
            )
        elif 0.35 <= d.decay_fraction <= 0.80:
            reading = (
                "That is the direction and roughly the magnitude they report."
            )
        elif d.decay_fraction > 0.80:
            reading = "That is a larger fall than the 58% they report."
        elif d.decay_fraction >= 0.0:
            reading = "That is a smaller fall than the 58% they report."
        else:
            reading = (
                "That is the opposite direction: these rules beat SPY by "
                "MORE after publication than before."
            )
        mclean = (
            f"{both_sides} As a fraction of the pre-publication excess that "
            f"is a fall of {d.decay_fraction:.0%}. {reading}"
        )

    if d.mean.point <= 0.0:
        huang = (
            "We reproduce the pattern. The average published strategy in "
            "this library does not beat holding the index once the index is "
            "charged the same frictions."
        )
    elif d.n_positive * 2 < d.mean.n:
        huang = (
            "Split. The mean is positive and the median is not: more than "
            "half these rules trailed SPY after publication and a few large "
            "winners carry the average. The sign count is the reading to "
            "trust."
        )
    else:
        huang = (
            "We do not reproduce it. The average published rule in this "
            "library is still ahead of buy-and-hold SPY after its own "
            "publication date, on this sample and at this account's size."
        )

    return "\n\n".join(
        [
            f"**McLean and Pontiff (2016), 58% decay.** {mclean}",
            f"**Huang, Song and Xiang (2021), +2.77% in backtest to -0.44% "
            f"live.** Post-publication this library averages "
            f"{d.mean.point:+.2%} a year against SPY, median "
            f"{d.median.point:+.2%}, with {d.n_positive} of {d.mean.n} rows "
            f"positive. {huang}",
        ]
    )


def _cost_verdict(s: Study) -> str:
    dear = s.multiples[-1]
    books = s.ordered(dear)
    died = [r.key for r in books if not float(r.full.report.cagr) > 0.0]
    return (
        f"At {_cost(dear)} cost {len(books) - len(died)} of {len(books)} "
        f"books still compound over the full sample"
        + (f"; {', '.join(died)} do not." if died else ".")
    )


def _verdict(s: Study, d: Decay) -> str:
    if not s.clean:
        failed = [c.name for c in s.checks if not c.passed]
        return (
            f"DO NOT REPORT THESE NUMBERS. {len(failed)} of {len(s.checks)} "
            f"sceptic checks failed ({'; '.join(failed)}). Every figure "
            f"below came out of the same run that failed them."
        )
    return (
        f"Across {d.mean.n} dated strategies measured from their own "
        f"publication dates forward, the mean excess return over "
        f"buy-and-hold SPY is {d.mean.point:+.2%} a year (95% interval "
        f"{d.mean.lo:+.2%} to {d.mean.hi:+.2%}) and the median is "
        f"{d.median.point:+.2%}. {d.n_positive} of {d.mean.n} beat SPY after "
        f"publication."
    )


def render_markdown(s: Study, generated_at: datetime, out: Path) -> str:
    panel = s.panel
    cheap = s.multiples[0]
    config = build_config(cheap)
    d = decay(s, cheap)
    lines: list[str] = []
    add = lines.append

    add("# The Post-Publication Ledger")
    add("")
    add(
        "Every strategy in `griffinquant/strategies/` through the same "
        "engine that produced `reports/stage3_sleeves.md`, measured twice: "
        "over the whole sample, and over the stretch that begins on the day "
        "its author published it. The second is the point. A holdout is a "
        "stretch of tape we set aside and can look at whenever we lose our "
        "nerve; a publication date was fixed by a stranger, in a document, "
        "years before this repository existed."
    )
    add("")

    add("## The two answers")
    add("")
    add(_answers(s))
    add("")
    add(f"**{_verdict(s, d)}**")
    add("")

    add("## The run")
    add("")
    add(
        runs.table(
            ["", ""],
            [
                ["Source", panel.source_label],
                [
                    "Study window",
                    f"{panel.sessions[0].date()} to {panel.sessions[-1].date()}",
                ],
                ["Sessions", f"{len(panel.sessions):,}"],
                [
                    "Pull",
                    f"{HISTORY_START.isoformat()} onward — the extra history "
                    f"is never measured, it is what the deployability rule "
                    f"reads",
                ],
                ["Funds served", f"{len(panel.served):,}"],
                ["Strategies registered", f"{len(registry.keys()):,}"],
                [
                    "Dated / undated",
                    f"{len(registry.entries(dated=True))} dated, "
                    f"{len(registry.entries(dated=False))} undated controls",
                ],
                ["Measured", f"{len(s.measured_keys):,} books"],
                ["Skipped", f"{len(s.skips):,}"],
                ["Starting cash", runs.money(config.starting_cash)],
                [
                    "Settlement",
                    f"T+1, {DEFAULT_BUFFER_FRACTION:.0%} of NAV held back",
                ],
                [
                    "Turnover budget",
                    f"{config.max_daily_turnover:.0%} of NAV a day, hard",
                ],
                ["No-trade band", f"{config.no_trade_band:.1%} of NAV drift"],
                [
                    "Participation cap",
                    f"{config.max_participation:.0%} of the name's median "
                    f"dollar volume",
                ],
                ["Fills", "decided at the close of T, filled at the open of T+1"],
                [
                    "Marks",
                    "`close_adj`; screens and share counts read `close_unadj`",
                ],
                ["Sleeve caps", "off for the library, on for the house book"],
                [
                    "Deployability floor",
                    runs.money(panel.adv_floor, 0) + " a day, derived",
                ],
                ["Risk-free hurdle", panel.rf_note],
                ["Cost multiples", ", ".join(_cost(m) for m in s.multiples)],
                ["Trials on file", f"{s.trials:,} distinct configurations"],
                ["Cache", panel.cache_note],
                ["Report", str(out)],
            ],
        )
    )
    add("")

    add("## What counts as one trial")
    add("")
    add(
        "Thirty-three strategies, one row in `trials.jsonl`. Every rule here "
        "is implemented as its source states it, with the parameters the "
        "source gives, and nothing in this file was swept, tuned, or chosen "
        "by looking at a result — so what was evaluated is a single "
        "decision, which was to run the library as published. A "
        "specification search over thirty-three variants would owe the "
        "deflated Sharpe thirty-three rows, and the difference is not "
        "cosmetic: it moves the best-of-N hurdle that every number in this "
        "report is judged against."
    )
    add("")
    add(
        "The corollary is the part that costs something. A bad row is kept. "
        "Faber's ten-month rule returns less than half of buy-and-hold SPY "
        "over this sample and stays in the table at that number, because a "
        "replication that drops its failures is a search wearing a "
        "replication's clothes."
    )
    add("")

    add("## The windows, and why the second is not a holdout")
    add("")
    add(
        "**Full sample** runs from the study start, or from the first "
        "session this row's vehicles could absorb the account, whichever is "
        "later. **After publication** runs from the date on the paper. "
        "**Before publication** is the same run up to the day before it, so "
        "the two partition the record and the decay claim has something to "
        "decay from. For the factor rows there is a fourth window, from the "
        "date an ETF existed to hold the idea — Jegadeesh and Titman "
        "published momentum in 1993 and MTUM listed in 2013, and that "
        "twenty-year gap is the most interesting column in this report, "
        "because for two decades the finding was public and unbuyable."
    )
    add("")
    add(
        "Each window is read off ONE backtest per strategy rather than a "
        "fresh run per window. A fresh run opening on a publication date "
        "would spend its first twelve months banking a warmup the rule had "
        "already banked years earlier and would report that cash as the "
        "strategy's post-publication return. The pre-publication tape is "
        "used for the rule's own trailing windows and for nothing else: no "
        "parameter here was chosen by looking at it, because no parameter "
        "here was chosen at all."
    )
    add("")
    add(
        f"A window shorter than {MIN_WINDOW_SESSIONS} sessions is printed "
        f"but kept out of the decay arithmetic. Annualising a stretch that "
        f"short is extrapolation with a percent sign on it."
    )
    add("")

    add("## When each row could actually be held")
    add("")
    add(
        f"The engine caps a single day's order at "
        f"{config.max_participation:.0%} of the name's own median dollar "
        f"volume, and the turnover budget wants "
        f"{config.max_daily_turnover:.0%} of NAV a day — so a fund whose "
        f"tape cannot carry {runs.money(panel.adv_floor, 0)} a day cannot be "
        f"deployed into at all. The figure is arithmetic on three engine "
        f"constants, not a threshold anybody picked."
    )
    add("")
    add(
        "This is not a technicality, and finding it is most of what this "
        "run did before it produced a table. Measured from its listing day, "
        "USMV reports 2.31% a year with two fills in fifteen years: on its "
        "third session the fund traded $52,000, the participation cap "
        "refused the buy, and `BuyAndHold` — correctly — latched on not "
        "having moved and never bought again. That number is a fact about a "
        "newborn ETF meeting a cap, not a fact about low volatility, and "
        "printing it in a decay table would have been the largest single "
        "error in this study."
    )
    add("")
    add(_dates_table(s))
    add("")

    add(f"## Full sample, at {_cost(cheap)} cost")
    add("")
    add(
        "`Excess CAGR` and `Excess SR` are against a buy-and-hold of SPY run "
        "fresh from the SAME opening session, through the same engine, on "
        "the same cost model — so both books start in cash on the same "
        "morning and both spend nineteen sessions deploying under the same "
        "turnover budget. A strategy published in 2018 compared against SPY "
        "from 2005 is not being compared against anything."
    )
    add("")
    add(_window_table(s, cheap, "full"))
    add("")
    add(
        "One asymmetry is left in rather than equalised. A twelve-month rule "
        "spends its first twelve months in cash while it banks the window it "
        "needs, and the benchmarks deploy immediately. That is what the "
        "process could actually have done on those days, and starting the "
        "benchmark late would report a comparison nobody could have run. It "
        "costs the trend and tactical families roughly a year of the column "
        "above and costs the post-publication column nothing, because by "
        "then every rule is long since deployed."
    )
    add("")

    add(f"## After publication, at {_cost(cheap)} cost")
    add("")
    add(
        "The table the study exists for. Every row below begins on a date "
        "somebody else chose and wrote down, and none of it was available "
        "to be fitted."
    )
    add("")
    add(_window_table(s, cheap, "post"))
    add("")

    add(f"## Before publication, at {_cost(cheap)} cost")
    add("")
    add(
        "The other half of the ratio. McLean and Pontiff's 58% compares "
        "after with before, so a study that measures only the after can "
        "report a small post-publication number without ever showing that "
        "it used to be a large one. Only strategies published inside this "
        "sample have a before; the rest were already in print when the tape "
        "starts, and their absence from this table is the reason the paired "
        "count below is smaller than the dated count."
    )
    add("")
    add(_window_table(s, cheap, "pre"))
    add("")

    add(f"## From the vehicle, at {_cost(cheap)} cost")
    add("")
    add(
        "The factor rows only. This is the window an investor could have "
        "held rather than the one the literature could have read, and where "
        "the two differ by two decades the difference is the finding."
    )
    add("")
    add(_window_table(s, cheap, "investable"))
    add("")

    add("## Does the library decay after publication?")
    add("")
    add(_decay_table(d, s, cheap))
    add("")
    add(
        runs.table(
            ["", ""],
            [
                ["Dated strategies measured", f"{d.mean.n}"],
                [
                    "Mean excess CAGR vs SPY, after publication",
                    runs.signed_pct(d.mean.point),
                ],
                [
                    "95% interval",
                    f"{runs.signed_pct(d.mean.lo)} to "
                    f"{runs.signed_pct(d.mean.hi)}",
                ],
                ["Method", d.mean.method],
                ["Median excess CAGR", runs.signed_pct(d.median.point)],
                [
                    "95% interval, median",
                    f"{runs.signed_pct(d.median.lo)} to "
                    f"{runs.signed_pct(d.median.hi)}",
                ],
                ["Method", d.median.method],
                ["Beat SPY after publication", f"{d.n_positive} of {d.mean.n}"],
                ["Excluded from the mean", f"{len(d.excluded)}, listed below"],
                [
                    "Published before the sample opens",
                    f"{d.n_published_before_sample} of "
                    f"{len(registry.entries(dated=True))}",
                ],
                ["Paired rows, a before AND an after", f"{len(d.paired_keys)}"],
                [
                    "Pairings dropped",
                    f"{len(d.pair_excluded)}, listed below",
                ],
                ["Mean excess BEFORE publication", runs.signed_pct(d.pre_mean)],
                ["Mean excess AFTER publication", runs.signed_pct(d.post_mean)],
                ["Change", runs.signed_pct(d.change_pp)],
                [
                    "Decay as a fraction of the prior excess",
                    f"{d.decay_fraction:.0%}"
                    if np.isfinite(d.decay_fraction)
                    else "undefined — there was no positive excess to decay "
                    "from, and the ratio inverts against a negative "
                    "denominator",
                ],
            ],
        )
    )
    add("")
    add(_exclusion_notes(d))
    add("")
    add(
        "**The interval is narrower than the truth and is offered as a lower "
        "bound on the uncertainty.** It is computed across strategies as "
        "though the records were independent draws. They are not: most run "
        "over the same calendar decade, most are long equity beta with a "
        "rule on top, and one bad year for that beta moves most of the rows "
        f"the same way. The effective sample is well below {d.mean.n} and "
        f"nothing here estimates how far below."
    )
    add("")
    add(
        f"The sign count is the robust statement and the one to quote: "
        f"{d.n_positive} of {d.mean.n} dated strategies beat buy-and-hold "
        f"SPY over their own post-publication windows, net of costs, at this "
        f"account's size."
    )
    add("")
    add(
        f"**{d.n_published_before_sample} of "
        f"{len(registry.entries(dated=True))} rows were already in print "
        f"when this tape starts**, so for those the post-publication window "
        f"IS the full sample and the out-of-sample guarantee is only as "
        f"strong as the fact that nobody here chose 2005. That is a weaker "
        f"claim than the one the other rows support, and it is weaker in the "
        f"flattering direction for the priors being tested: the oldest ideas "
        f"have had the longest to be arbitraged, and they are exactly the "
        f"rows whose 'before' cannot be seen."
    )
    add("")
    add("### Against the priors")
    add("")
    add(_prior_verdict(d))
    add("")

    add("## The headline at each cost multiple")
    add("")
    add(
        "The impact coefficient is a prior lifted from the literature rather "
        "than a measurement of our own fills. A strategy that only works at "
        "1x is not a strategy, it is a bet that `costs.py` is exactly right, "
        "and nothing in `costs.py` is exactly right."
    )
    add("")
    for multiple in s.multiples:
        add(f"### {_cost(multiple)} cost")
        add("")
        add(_headline_table(s, multiple))
        add("")
    add(_cost_verdict(s))
    add("")

    add(f"## Every window over Sharpe {SUSPICIOUS_SHARPE:.1f}")
    add("")
    add(
        "The brief's instruction is to treat a Sharpe above this as evidence "
        "of a bug and hunt before reporting. The hunt is the sceptic table "
        "below, and it fails the whole report on a FULL-SAMPLE Sharpe over "
        "the line, because a twenty-year figure that high on a long-only "
        "unlevered book is not a result. Shorter windows are held to the "
        "same number and reported rather than refused: a two-year Sharpe of "
        "1.3 is a bull market, and a rule that refused it would refuse this "
        "report every time a factor ETF listed into a rally. Read the "
        "`Years` column before the `Sharpe` column."
    )
    add("")
    add(_suspicious_table(s, cheap))
    add("")

    add("## Skipped, and what was missing")
    add("")
    add(
        "A strategy whose declared universe is not fully covered is skipped "
        "and named. Never substituted: swapping a vehicle for one that "
        "happens to have the history the story needs is the first move this "
        "study exists to observe."
    )
    add("")
    add(_skip_table(s))
    add("")

    add("## What was attacked before any of this was believed")
    add("")
    add(
        "A clean number nobody attacked is not a result. Each row is a way "
        "the tables above could be wrong while looking exactly like this."
    )
    add("")
    add(runs.checks_table(s.checks))
    add("")

    add("## What this does and does not establish")
    add("")
    add(
        "It reports what thirty-three published rules would have produced in "
        "this account, on this sample, with frictions charged rather than "
        "assumed away, with each rule measured from a date its author fixed "
        "before we existed, and with the number of looks written down. That "
        "is a stronger claim than a backtest and a much weaker one than an "
        "edge."
    )
    add("")
    add(
        "Four things it does not establish. The post-publication windows "
        "differ in length — a rule published in 2018 has eight years of "
        "record where one published in 2007 has nineteen — and the mean "
        "above weights them equally with nothing correcting for it. The "
        "sample holds one credit crisis, one pandemic crash and one "
        "inflation shock, each a single draw, and for most of it falling "
        "yields paid the bond legs to be a hedge, a relationship that ended "
        "in 2022 and has not resumed. Every vehicle here still trades, so "
        "the ETF universe is survivorship-biased by construction and the "
        "direction of that bias is flattering. And the account is $131,000: "
        "the participation cap and the $100 minimum ticket bind here in ways "
        "they would not at a fund, which is why several rows could not be "
        "measured from their listing dates at all."
    )
    add("")
    add(f"_Generated {runs.stamp(generated_at)} by `run_ledger.py`._")
    add("")
    return "\n".join(lines)


def print_console(s: Study, d: Decay) -> None:
    out = typer.echo
    cheap = s.multiples[0]
    panel = s.panel
    out("")
    out(
        f"  Post-publication ledger: {panel.sessions[0].date()} to "
        f"{panel.sessions[-1].date()} ({len(panel.sessions):,} sessions, "
        f"{len(s.measured_keys)} books, {len(s.skips)} skipped)"
    )
    out("")
    width = max((len(r.key) for r in s.ordered(cheap)), default=10) + 2
    out(
        f"  {'strategy':<{width}} {'CAGR':>8} {'SR':>6} {'DSR':>7} {'maxDD':>8}"
        f"   {'post CAGR':>10} {'vs SPY':>9}"
    )
    for run in s.ordered(cheap):
        full = run.full.report
        post = run.at("post")
        bench = s.bench.against(run, post.window) if post else None
        dsr = full.deflated.deflated_sharpe if full.deflated else float("nan")
        tail = f"{'—':>10} {'—':>9}"
        if post is not None and bench is not None:
            gap = post.report.cagr - bench.report.cagr
            tail = f"{post.report.cagr * 100:>9.2f}% {gap * 100:>+8.2f}%"
        out(
            f"  {run.key:<{width}} {full.cagr * 100:>7.2f}% "
            f"{full.sharpe:>6.2f} {dsr:>7.3f} "
            f"{full.drawdown.depth * 100:>7.2f}%   {tail}"
        )
    out("")
    out(f"  trials on file: {s.trials:,} distinct")
    out("")
    for check in s.checks:
        out(f"  [{check.verdict}] {check.name}")
    out("")
    out(f"  {_verdict(s, d)}")
    out("")


# -- the entry point ----------------------------------------------------


def _generated_at() -> datetime:
    """One clock reading, threaded through everything the run emits."""
    return runs.utcnow()


def _progress(run: Run) -> None:
    typer.echo(
        f"  ran {run.id:<40s} {run.full.report.cagr * 100:>7.2f}% "
        f"SR {run.full.report.sharpe:>5.2f}",
        err=True,
    )


@app.command()
def main(
    start: str = typer.Option(SAMPLE_START, "--start", help="First session, ISO."),
    end: str = typer.Option("", "--end", help="Last session; blank means today."),
    out: Path = typer.Option(DEFAULT_REPORT, "--out", help="Where to write."),
    source: Source = typer.Option(
        Source.tiingo, "--source", help="Which price feed to pull from."
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
        panel = load_panel(first, last, source=source, cache=cache)
    except DataUnavailable as exc:
        raise runs.refuse_no_data(exc, what="no backtest was run")

    ledger = runs.Trials(path=trials, when=generated_at)
    try:
        s = study(
            panel,
            ledger=ledger,
            multiples=COST_MULTIPLES,
            on_progress=None if quiet else _progress,
        )
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

    d = decay(s, s.multiples[0])
    if not quiet:
        print_console(s, d)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(s, generated_at, out), "utf-8")
    if not quiet:
        typer.echo(f"  report → {out}\n")

    raise typer.Exit(EXIT_OK if s.clean else EXIT_FAILED)


if __name__ == "__main__":
    app()
