"""The video's experiment, done properly: two classifiers, one gate, and
the number they were always going to produce.

Somebody on YouTube trains an LSTM to predict whether a stock's forward
return clears a threshold, acts only when the model is confident, and
reports a backtest. By his own account the validation AUC drifted from
0.60 to 0.50 across twenty-five epochs while training AUC climbed, and
the result "appears to be basically a random guess" — on a universe he
described out loud as "random tickers that exist today", which is to say
one assembled from the survivors. This file is the same idea with the
methodology fixed, run against twenty-eight large US-listed ETFs, and
**the expected answer is an AUC near 0.50.** That is the measurement.
Nothing here is tuned toward a better one; every parameter is a prior
fixed in writing in `ml/*.py` before a fold had been scored, and every
configuration evaluated lands in `trials.jsonl` whatever it produced.

What "properly" costs, in five decisions that each make the number
smaller.

**The universe is ETFs, not single names.** The free adjusted-close
feeds answer only for symbols that still resolve today, so a single-name
panel pulled through one is survivorship-biased by construction and no
downstream check can see it — that is precisely the flaw being avoided,
and reproducing it faster would not be a reproduction. The twenty-eight
here were still chosen in 2026 and `ml/universe.py` says at length what
that costs and why it is a far smaller bias than a delisted equity's.

**The label is the cross-sectional median, so the base rate is one half
by construction and every accuracy in this document is readable on
sight.** The source project's 62% against a 60% base rate was two points
of nothing, and the reason it read as a result is that nothing on the
screen said 60.

**The folds are walk-forward and purged.** Training expands, testing is
always forward, and the trailing 21 sessions of every training window
are dropped because their label windows reach across the seam. The
LSTM's epoch is chosen on an inner slice carved off the END of the
training window and purged the same way — never on the test fold, which
is how a reported AUC becomes a maximum over forty draws.

**Every AUC is printed beside the thing that would score it without a
model**: the majority-class accuracy, the best single sorted column with
its sign chosen in hindsight, and — for the net — a lookup table of
per-fund training base rates. A model that cannot beat a peeking
one-liner has not earned two hundred trees, and the comparison against
0.500 would have let it look as though it had.

**The gate is the part worth copying.** `ml/decide.py` subtracts a
multiple of the model's own disagreement from its probability and acts
only on what survives, and the surviving set is allowed to be empty. The
fraction of dates on which the rule does nothing is reported as a
headline, because a classifier that must trade is not an investor.

The backtest is the real engine: decided at a close, filled at the next
open out of settled cash under T+1, charged a liquidity-scaled spread
and a square-root impact term, long only, no leverage, against
buy-and-hold SPY and an equal-weighted book of the same universe on the
same cost model.

Needs the network for the Treasury bill series and, on a cold cache, for
the price pull. If either fails this exits 2 and writes nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.etfuniverse import HISTORY_START
from griffinquant.data.tbill import FRED_SERIES, TbillUnavailable, fetch_rate
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
from griffinquant.ml import decide, features, gbm, labels as labelling, lstm, splits
from griffinquant.ml import universe as etfs
from griffinquant.util import runs
from griffinquant.util.runs import Check, DataUnavailable, Source

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "ml_classifier.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA


# -- the priors ---------------------------------------------------------
#
# Every number below was written down before a fold had been scored and
# none of them may move in response to a result. They are here rather
# than inline because a constant with an argument attached is harder to
# edit quietly than a literal in a call.

#: Sessions of history pulled BEFORE the study window so the features
#: are complete on its first day. The longest trailing window in
#: `ml/features.py` is 252 sessions and the LSTM stacks 60 more on top,
#: so two calendar years clears both with room for a listing gap. The
#: alternative — starting the labels where the data starts — hands the
#: model a first year of rows whose features are mostly NaN and then
#: reports their accuracy as though they were measurements.
FEATURE_WARMUP_YEARS = 2

#: One month forward, `labels.DEFAULT_HORIZON`. Named again here because
#: the horizon is also the purge distance and the overlap correction on
#: every t-statistic in the report, and a reader should not have to open
#: another file to find the number three tables depend on.
HORIZON = labelling.DEFAULT_HORIZON

#: Refit every three years rather than the splitter's annual default,
#: and the reason is run cost rather than a result: at annual cadence
#: this is seventeen folds and the net alone is an afternoon. Three
#: years is the more conservative direction — the model re-estimates
#: less often, not more — and it lands on six folds, which is the
#: cadence `ml/lstm.py`'s own capacity note is written against. It is
#: in the trial hash, so changing it starts a new search rather than
#: continuing this one under the same N.
REFIT_FREQUENCY_YEARS = 3

#: Five years of tape before the first blind trade. `splits.py`'s
#: default and its argument: fewer and the first model has never seen a
#: bad year, more and the out-of-sample period this whole exercise is
#: measured on gets shorter.
MIN_TRAIN_YEARS = splits.DEFAULT_MIN_TRAIN_YEARS

#: Above this, an out-of-sample AUC on this problem is evidence of
#: leakage rather than of skill, and the brief's instruction is to stop
#: reporting and start hunting. Not a soft warning: the run refuses.
SUSPICIOUS_AUC = 0.60

#: Where the causality check truncates, as fractions through the price
#: panel. Three points rather than one, because a leak that only bites
#: while a particular fund is warming up would hide from a single probe.
#: All three fall well past the feature warmup, which matters: a probe
#: taken where every feature is still NaN compares nothing to nothing
#: and passes.
CAUSALITY_PROBE_FRACTIONS: tuple[float, ...] = (0.35, 0.65, 0.95)

#: The ceiling the benchmarks are bought to. Identical to the gate's
#: budget in `ml/decide.py`, which is the ledger's investable fraction:
#: the engine holds five per cent of NAV back from every purchase, so a
#: book targeting a full 1.0 spends the sample deferring its last five
#: per cent. Comparing a strategy that respects the buffer against a
#: benchmark that does not would credit the benchmark with money the
#: account could never have deployed.
MAX_INVESTABLE = decide.FULLY_INVESTED

app = typer.Typer(add_completion=False)


class Model(str, Enum):
    """Which classifier to fit. `both` is the comparison worth having.

    The tree is the control. On a wide, noisy, low-signal tabular panel
    a gradient-boosted tree is the thing to beat, and every feature here
    has already been reduced to a trailing statistic — so the sequence
    model has nothing left to sequence. If the tree finds nothing there
    is very little for a recurrent net to find, and running one without
    the other leaves that unanswered.
    """

    gbm = "gbm"
    lstm = "lstm"
    both = "both"

    @property
    def wants_gbm(self) -> bool:
        return self in (Model.gbm, Model.both)

    @property
    def wants_lstm(self) -> bool:
        return self in (Model.lstm, Model.both)


# -- the panel ----------------------------------------------------------


@dataclass(frozen=True, eq=False)
class Panel:
    """One pull, in every shape the run asks for, computed once.

    `eq=False` because the fields are pandas objects and a generated
    `__eq__` would compare them element-wise and then ask for the truth
    value of the result, which raises rather than answering.
    """

    prices: pd.DataFrame
    panels: features.Panels
    available: pd.DataFrame
    feature_frame: pd.DataFrame
    labels: labelling.LabelSet
    X: pd.DataFrame
    bill_rate_pct: pd.Series
    risk_free: pd.Series
    inception_findings: pd.DataFrame
    source_label: str
    cache_note: str
    rf_note: str
    study_start: pd.Timestamp
    study_end: pd.Timestamp

    @property
    def sessions(self) -> pd.DatetimeIndex:
        return self.panels.sessions

    @property
    def tickers(self) -> tuple[str, ...]:
        return self.panels.tickers


def build_universe_source(source: Source, *, cache: ParquetCache | None) -> Any:
    """The adapter behind `--source`, imported late.

    Late for the reason `util.runs.build_source` gives: the keyed source
    reads an environment variable at construction and raises when the
    key is missing, and a run against the keyless endpoint should not
    have to own a token it is never going to use.

    Both are the sleeve source with a longer allowlist — the wall stays
    exactly where it stands, widened to twenty-eight hand-checked funds
    and no further. `tiingo` is the default because it is the one whose
    parquet is warm; `free` reads the keyless chart endpoint, which
    answers for these names too and throttles far sooner.
    """
    if source is Source.tiingo:
        from griffinquant.data.etfuniverse import ETFUniverseSource

        return ETFUniverseSource(
            allowed=etfs.UNIVERSE_TICKERS,
            cache=cache,
            # The catalogue is a second network call that buys a fund's
            # marketing name and nothing this study reads.
            fetch_names=False,
        )

    from griffinquant.data.sleevedata import SleeveETFSource

    return SleeveETFSource(allowed=etfs.UNIVERSE_TICKERS, cache=cache)


def load_panel(
    start: date,
    end: date,
    *,
    source: Source,
    cache: ParquetCache | None,
) -> Panel:
    """Prices, features, labels and the bill hurdle, or a refusal.

    A seam as much as a function: the whole script can be driven through
    this name against a synthetic panel, which is the only way to prove
    the wiring without a price feed.

    The pull reaches back to `HISTORY_START` rather than to `start`, and
    the two windows do different jobs. Everything before the study start
    is FEATURE WARMUP — it exists so that a momentum reading on the
    study's first session is a full year old rather than a fortnight —
    and no label is built from it. Confusing the two is how a study
    reports a twenty-year record whose first year is mostly NaN.
    """
    src = build_universe_source(source, cache=cache)
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

    served = {str(t) for t in pulled["ticker"].unique()}
    missing = sorted(etfs.UNIVERSE_TICKERS - served)
    if missing:
        raise DataUnavailable(
            f"{len(missing)} of {len(etfs.UNIVERSE_TICKERS)} funds came back "
            f"with no bars at all: {missing}. A cross-sectional rank over a "
            "partial universe is a rank among whoever answered, and nothing "
            "downstream can tell it apart from a rank among everyone."
        )

    # Checked against the pull the study will actually run on, which is
    # the check `ml/universe.py` could not make at the time it wrote its
    # inception table down. Reported rather than fatal: a vendor whose
    # coverage begins after a fund's inception costs us the first weeks
    # of that name's history and cannot manufacture a bar.
    findings = etfs.verify_against_prices(pulled)

    feature_start = pd.Timestamp(start) - pd.DateOffset(years=FEATURE_WARMUP_YEARS)
    frame = pulled.loc[pulled["date"] >= feature_start].reset_index(drop=True)
    if frame.empty:
        raise DataUnavailable(
            f"no bar falls on or after {feature_start.date()}, so there is no "
            "warmup to compute a feature from."
        )

    panels = features.panels_from_prices(frame)
    available = _availability(panels)

    try:
        # A fortnight of slack at the front: a sample opening the Monday
        # after a holiday has no quote on its own first day, and the
        # per-period conversion raises rather than inventing one.
        bill_pct = fetch_rate(feature_start.date() - timedelta(days=21), end)
    except TbillUnavailable as exc:
        raise DataUnavailable(
            f"{exc} The bill rate is both a feature and the hurdle every "
            "Sharpe in this report is measured against, and zero is not a "
            "neutral stand-in for a series that ran 5% to 0% to 5% across "
            "this sample."
        ) from exc

    feature_frame = features.build_features(
        panels, bill_rate=bill_pct, available=available
    )

    close = panels.close_adj.loc[pd.Timestamp(start) : pd.Timestamp(end)]
    labels = labelling.build_labels(
        close, horizon=HORIZON, threshold=labelling.DEFAULT_THRESHOLD
    )
    X = gbm.align_features(feature_frame, labels)

    rf = bill_pct.astype("float64") / 100.0
    rf.name = FRED_SERIES
    return Panel(
        prices=frame,
        panels=panels,
        available=available,
        feature_frame=feature_frame,
        labels=labels,
        X=X,
        bill_rate_pct=bill_pct,
        risk_free=rf,
        inception_findings=findings,
        source_label=getattr(src, "capabilities").name,
        cache_note="disabled (--no-cache)" if cache is None else str(cache.root),
        rf_note=(
            f"FRED {FRED_SERIES}, the 3-month constant-maturity bill yield, "
            f"annualised and converted geometrically to a per-session hurdle "
            f"({float(rf.min()):.2%}-{float(rf.max()):.2%} across the pull)"
        ),
        study_start=pd.Timestamp(close.index[0]),
        study_end=pd.Timestamp(close.index[-1]),
    )


def _availability(panels: features.Panels) -> pd.DataFrame:
    """The boolean mask of which funds had listed, per session.

    Built from `universe.available_on`'s own inception table rather than
    from which columns happen to be non-null, because the two agree most
    of the time and differ exactly where it matters: a vendor hole looks
    like a fund that had not listed, and a rank taken over the names
    that answered is not a rank over the names that existed.
    """
    inceptions = {t: pd.Timestamp(etfs.fund(t).inception) for t in panels.tickers}
    index = panels.sessions
    return pd.DataFrame(
        {t: index >= stamp for t, stamp in inceptions.items()},
        index=index,
    )


# -- what one model produced --------------------------------------------


@dataclass(frozen=True, eq=False)
class Fitted:
    """One model's out-of-sample output and everything needed to doubt it.

    `predictions` is long and carries the fold each row came from, so a
    reader can check that the folds tile the window rather than taking
    it on trust. `folds` is the per-fold table the report prints
    verbatim — one row per fold and never a pooled mean, because a mean
    over a trajectory is the summary that erases the trajectory.
    """

    key: str
    label: str
    predictions: pd.DataFrame
    folds: pd.DataFrame
    ic: gbm.RankIC
    auc_overall: float
    note: str
    #: Which column of `folds` carries the out-of-sample AUC. The two
    #: model modules name it differently and neither is renamed on the
    #: way in: a runner that quietly relabels another module's output
    #: is a runner whose tables stop matching that module's tests.
    auc_column: str = "auc"
    trajectory: pd.DataFrame = field(default_factory=pd.DataFrame, repr=False)
    importance: pd.DataFrame = field(default_factory=pd.DataFrame, repr=False)
    capacity: Any = None
    device: str = ""

    @property
    def fold_aucs(self) -> tuple[float, ...]:
        return tuple(float(v) for v in self.folds[self.auc_column])

    @property
    def worst_case_auc(self) -> float:
        """The furthest any fold got from a coin flip, upward.

        The number the leakage check reads. A mean over folds would let
        one contaminated fold hide behind five clean ones.
        """
        values = np.asarray(self.fold_aucs, dtype="float64")
        values = values[np.isfinite(values)]
        return float(values.max()) if values.size else float("nan")


def fit_gbm(
    panel: Panel,
    plan: splits.SplitPlan,
    *,
    ledger: runs.Trials,
    generated_at: datetime,
    config: gbm.GBMConfig = gbm.DEFAULT_CONFIG,
) -> Fitted:
    """Bootstrap-bagged boosted trees over every walk-forward fold.

    The counter goes in rather than being logged here, because
    `gbm.evaluate` records the trial BEFORE the first fit — a
    configuration that was evaluated and then crashed still counts
    against the deflation, since we still looked.
    """
    report = gbm.evaluate(
        plan,
        panel.X,
        config=config,
        counter=ledger.counter,
        timestamp=generated_at,
        keep_predictions=True,
        verify=True,
    )
    if not report.recorded:
        raise RuntimeError("the GBM run was not written to the trial ledger")

    index = panel.labels.y.index
    blocks: list[pd.DataFrame] = []
    for result in report.folds:
        fold = plan[result.fold - 1]
        rows = index[fold.test_rows]
        prediction = result.prediction
        if prediction is None:
            raise RuntimeError(f"fold {result.fold} kept no predictions")
        blocks.append(
            pd.DataFrame(
                {
                    "date": rows.get_level_values("date"),
                    "asset": rows.get_level_values("asset").astype("str"),
                    "probability": prediction.mean,
                    "spread": prediction.spread,
                    "fold": result.fold,
                }
            )
        )
    predictions = pd.concat(blocks, ignore_index=True)
    ic, auc = _overall(predictions, panel)

    # The same baseline `ml/lstm.py` insists on for the net, computed
    # here for the tree because the question is about the PANEL rather
    # than about either architecture: over this sample QQQ beat the
    # cross-sectional median far more often than TIP did, so a model
    # that learns which fund it is looking at scores above 0.5 without
    # any view about when to own it. The tree's own summary warns that a
    # cross-sectional rank which barely moves for a given name is a name
    # dummy; this is that warning as a number.
    folds = report.trajectory().copy()
    identity = [
        lstm.identity_baseline_auc(
            panel.labels, plan[r.fold - 1].train_rows, plan[r.fold - 1].test_rows
        )
        for r in report.folds
    ]
    folds["identity_auc"] = identity
    folds["auc_over_identity"] = folds["auc"] - folds["identity_auc"]

    return Fitted(
        key="gbm",
        label=f"HistGradientBoosting x{config.n_members} (date bootstrap)",
        predictions=predictions,
        folds=folds,
        ic=ic,
        auc_overall=auc,
        note=report.summary(),
        importance=report.importances(),
    )


def fit_lstm(
    panel: Panel,
    plan: splits.SplitPlan,
    *,
    ledger: runs.Trials,
    config: lstm.LSTMConfig,
) -> Fitted:
    """The video's architecture, with the epoch chosen off the test fold.

    `run_lstm` logs the configuration before a single fold is fitted and
    re-runs the split's own leak check rather than trusting that whoever
    built the plan called it.
    """
    report = lstm.run_lstm(
        panel.feature_frame,
        panel.labels,
        plan,
        config=config,
        trials=ledger,
    )

    blocks = []
    for result in report.folds:
        idx = result.predictions.index
        blocks.append(
            pd.DataFrame(
                {
                    "date": idx.get_level_values("date"),
                    "asset": idx.get_level_values("asset").astype("str"),
                    "probability": result.predictions.to_numpy(dtype="float64"),
                    "spread": result.ensemble_spread.to_numpy(dtype="float64"),
                    "fold": result.fold,
                }
            )
        )
    predictions = pd.concat(blocks, ignore_index=True)
    ic, auc = _overall(predictions, panel)

    return Fitted(
        key="lstm",
        label=(
            f"LSTM h{config.hidden_size} lookback {config.lookback}, "
            f"{config.n_seeds} seeds"
        ),
        predictions=predictions,
        folds=report.describe(),
        ic=ic,
        auc_overall=auc,
        note=report.summary(),
        auc_column="test_auc",
        trajectory=report.trajectory(),
        capacity=report.capacity,
        device=report.device,
    )


def _overall(predictions: pd.DataFrame, panel: Panel) -> tuple[gbm.RankIC, float]:
    """The whole out-of-sample window scored once, folds pooled.

    Pooled here and PER FOLD everywhere else, deliberately: this pair is
    the summary a reader wants after the trajectory, not instead of it.
    The IC is still computed within each date and then averaged — a
    correlation pooled across dates would reward the model for knowing
    which year it was looking at.
    """
    keyed = predictions.set_index(
        pd.MultiIndex.from_arrays(
            [pd.DatetimeIndex(predictions["date"]), predictions["asset"]],
            names=["date", "asset"],
        )
    )
    truth = panel.labels.y.reindex(keyed.index).to_numpy(dtype="float64")
    forward = panel.labels.forward_return.reindex(keyed.index).to_numpy(
        dtype="float64"
    )
    probability = keyed["probability"].to_numpy(dtype="float64")
    # `gbm._safe_auc` rather than a fresh call to sklearn, private though
    # it is: it answers NaN on a single-class fold where `roc_auc_score`
    # raises and a hand-rolled wrapper would be tempted to return 0.5 —
    # which is the exact number this study expects to find honestly, and
    # therefore the worst available thing to fabricate.
    ic = gbm.rank_ic(
        probability,
        forward,
        pd.DatetimeIndex(keyed.index.get_level_values("date")),
        horizon=panel.labels.horizon,
    )
    return ic, gbm._safe_auc(truth, probability)


def ic_interval(ic: gbm.RankIC) -> tuple[float, float]:
    """A 95% interval on the mean rank IC, widened for the overlap.

    Daily ICs computed off 21-session forward windows overlap by twenty,
    so consecutive values are very nearly the same measurement. Treating
    them as independent draws divides the standard error by sqrt(n) when
    the honest denominator is closer to sqrt(n / H); multiplying the
    interval by sqrt(H) is the crude correction, and it is still
    generous — it assumes windows a month apart are independent, and
    regimes run longer than a month.
    """
    if not (np.isfinite(ic.mean) and np.isfinite(ic.std)) or ic.n_dates < 2:
        return (float("nan"), float("nan"))
    se = ic.std / np.sqrt(ic.n_dates / max(ic.horizon, 1))
    return (float(ic.mean - 1.96 * se), float(ic.mean + 1.96 * se))


# -- the books ----------------------------------------------------------


class EqualWeight:
    """1/n across every fund that had listed and printed a price.

    The benchmark the gate has to beat to have been worth building,
    because it is what the same universe returns with no model at all.
    Rebalanced daily rather than latched, so the comparison is against a
    disciplined book rather than a drifting one — the engine's no-trade
    band is what stops it churning.

    Membership comes from `universe.available_on` AND from the price
    being there, and both are required. The inception table alone would
    put a fund in the book on a day the vendor served no bar; the price
    alone would treat a vendor hole as a delisting.
    """

    def __init__(self, *, budget: float = MAX_INVESTABLE, name: str = "equal weight"):
        self.budget = float(budget)
        self.name = name
        self.warmup = 0

    def targets(self, view: MarketView) -> Mapping[str, float]:
        listed = set(etfs.available_on(pd.Timestamp(view.asof).date()))
        last = view.latest("close_adj")
        live = [
            a
            for a in view.assets
            if a in listed and np.isfinite(float(last.get(a, np.nan)))
        ]
        if not live:
            return {a: 0.0 for a in view.assets}
        weight = self.budget / len(live)
        held = set(live)
        return {a: (weight if a in held else 0.0) for a in view.assets}


@dataclass(frozen=True)
class Book:
    """One thing being measured, and why it is in the table."""

    key: str
    label: str
    note: str


@dataclass(frozen=True, eq=False)
class Run:
    """A backtest and everything measured from it, computed once."""

    book: Book
    strategy: Any
    result: BacktestResult
    report: metrics.PerformanceReport
    deflated: metrics.DeflatedSharpe | None = None

    @property
    def key(self) -> str:
        return self.book.key

    @property
    def deferral_shortfall(self) -> float:
        frame = self.result.deferrals
        return float(frame["shortfall"].sum()) if len(frame) else 0.0


def backtest_config() -> BacktestConfig:
    """One account, four books, no difference between them.

    Everything that is a fact about the account — T+1, the 5% buffer,
    the 5%-of-NAV daily turnover budget, whole shares, the $100 minimum
    ticket, the participation cap, the cost model — is identical across
    every run in this report, and the sleeve caps are switched OFF for
    all four. Those caps belong to the sleeve strategy; four of this
    universe's tickers happen to be sleeve vehicles, and leaving them on
    would silently cap SPY at the sleeve layer's ceiling in a study that
    has nothing to do with it. The gate's own 25% cap lives in
    `ml/decide.py`, where the reader can see it.
    """
    return BacktestConfig(
        apply_sleeve_caps=False,
        default_max_weight=1.0,
        caps={},
        cost_model=CostModel(),
        band_provenance=(
            "not tuned; the engine default, a round prior fixed before any "
            "result in this report existed"
        ),
    )


def execute(book: Book, strategy: Any, market: MarketData, panel: Panel) -> Run:
    """One backtest, measured once.

    `trials=None` here is not an omission. `metrics.evaluate` would
    deflate against whatever count it was handed, and the count is not
    known until every configuration in this report has been logged — so
    the deflation happens afterwards, against the whole ledger.
    """
    result = run_backtest(market, strategy, backtest_config())
    report = metrics.evaluate(
        result.equity, trades=result.trades, rf=panel.risk_free, trials=None
    )
    return Run(book=book, strategy=strategy, result=result, report=report)


def market_for(panel: Panel, first: pd.Timestamp, last: pd.Timestamp) -> MarketData:
    frame = panel.prices.loc[
        (panel.prices["date"] >= first) & (panel.prices["date"] <= last)
    ]
    return MarketData.from_prices(frame, key="ticker")


# -- the whole run ------------------------------------------------------


@dataclass(frozen=True, eq=False)
class Study:
    panel: Panel
    plan: splits.SplitPlan
    fitted: tuple[Fitted, ...]
    decisions: dict[str, decide.DecisionSet]
    market: MarketData
    runs: dict[str, Run]
    books: tuple[Book, ...]
    checks: tuple[Check, ...]
    trials: int
    rule: decide.DecisionRule
    model: Model
    lstm_config: lstm.LSTMConfig
    gbm_config: gbm.GBMConfig
    window: tuple[pd.Timestamp, pd.Timestamp]

    @property
    def clean(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def ordered(self) -> list[Run]:
        return [self.runs[b.key] for b in self.books]

    def fit(self, key: str) -> Fitted | None:
        for f in self.fitted:
            if f.key == key:
                return f
        return None


def study(
    panel: Panel,
    *,
    ledger: runs.Trials,
    generated_at: datetime,
    model: Model,
    rule: decide.DecisionRule,
    gbm_config: gbm.GBMConfig,
    lstm_config: lstm.LSTMConfig,
) -> Study:
    plan = splits.walk_forward_folds(
        panel.labels,
        refit_frequency=REFIT_FREQUENCY_YEARS,
        min_train_years=MIN_TRAIN_YEARS,
    )
    plan.verify()

    fitted: list[Fitted] = []
    if model.wants_gbm:
        fitted.append(
            fit_gbm(
                panel,
                plan,
                ledger=ledger,
                generated_at=generated_at,
                config=gbm_config,
            )
        )
    if model.wants_lstm:
        fitted.append(fit_lstm(panel, plan, ledger=ledger, config=lstm_config))

    decisions = {f.key: decide.decide(f.predictions, rule=rule) for f in fitted}

    # The window every book is measured over: the stretch on which
    # EVERY model had a view, so the four books are scored on identical
    # sessions. Not the panel's own end — the last 21 sessions carry no
    # label, so nothing was asked about them, and running the benchmarks
    # a month past the strategy would score them on a stretch it never
    # saw. And the intersection rather than the union, because a model
    # whose sequences need a longer warmup reaches out-of-sample later,
    # and measuring it over sessions it never scored would report the
    # cash it was holding by default as a decision.
    first = max(d.dates[0] for d in decisions.values())
    last = min(d.dates[-1] for d in decisions.values())
    market = market_for(panel, first, last)

    books: list[Book] = []
    strategies: dict[str, Any] = {}
    for f in fitted:
        book = Book(
            key=f.key,
            label=f"{f.label}, uncertainty-gated",
            note=(
                f"acts only where the bagged probability less "
                f"{rule.k:g} standard deviation(s) of member disagreement "
                f"clears {rule.minimum:.2f}; equal weight across survivors, "
                f"capped at {rule.max_weight:.0%}, cash otherwise"
            ),
        )
        books.append(book)
        strategies[book.key] = decide.GatedBook(
            decisions[f.key].weights, name=f"{f.key} gated"
        )

    books.append(
        Book(
            key="spy",
            label="Buy and hold SPY",
            note=(
                "bought once and never rebalanced, so it pays no turnover "
                "after deployment; the hardest benchmark in the table and the "
                "one most people actually hold"
            ),
        )
    )
    strategies["spy"] = BuyAndHold({"SPY": MAX_INVESTABLE}, name="buy and hold SPY")
    books.append(
        Book(
            key="equal",
            label="Equal weight of the universe, rebalanced daily",
            note=(
                "what these twenty-eight funds return with no model at all, "
                "on the same engine, the same settlement and the same costs"
            ),
        )
    )
    strategies["equal"] = EqualWeight()

    for book in books:
        ledger.log(
            trial_config(book, panel, rule, first, last),
            f"{book.label}, {first.date()} to {last.date()}",
        )
    trials = ledger.distinct

    table: dict[str, Run] = {}
    for book in books:
        table[book.key] = execute(book, strategies[book.key], market, panel)
    for key, run in table.items():
        table[key] = Run(
            book=run.book,
            strategy=run.strategy,
            result=run.result,
            report=run.report,
            deflated=metrics.deflated_sharpe_ratio(
                metrics.to_returns(run.result.equity),
                trials=trials,
                rf=panel.risk_free,
            ),
        )

    checks = sceptic_checks(
        panel=panel,
        plan=plan,
        fitted=tuple(fitted),
        decisions=decisions,
        runs_by_key=table,
        market=market,
        rule=rule,
        lstm_config=lstm_config,
        model=model,
    )

    return Study(
        panel=panel,
        plan=plan,
        fitted=tuple(fitted),
        decisions=decisions,
        market=market,
        runs=table,
        books=tuple(books),
        checks=checks,
        trials=trials,
        rule=rule,
        model=model,
        lstm_config=lstm_config,
        gbm_config=gbm_config,
        window=(first, last),
    )


def trial_config(
    book: Book,
    panel: Panel,
    rule: decide.DecisionRule,
    first: pd.Timestamp,
    last: pd.Timestamp,
) -> dict[str, Any]:
    """The fingerprint that makes two runs one trial or two.

    The window is in it deliberately. A configuration re-run on a longer
    sample is a different look at the data, and counting it as the same
    trial would let the search grow for free every time somebody moved
    an end date.
    """
    return {
        "book": book.key,
        "study": "ml_classifier",
        "start": first.date().isoformat(),
        "end": last.date().isoformat(),
        "universe": sorted(etfs.UNIVERSE_TICKERS),
        "decision": rule.config() if book.key in ("gbm", "lstm") else None,
        "horizon_sessions": panel.labels.horizon,
        "buffer": 1.0 - MAX_INVESTABLE,
        "settlement": 1,
        "turnover_budget": 0.05,
        "cost_multiple": 1.0,
    }


# -- the sceptic --------------------------------------------------------


def sceptic_checks(
    *,
    panel: Panel,
    plan: splits.SplitPlan,
    fitted: Sequence[Fitted],
    decisions: Mapping[str, decide.DecisionSet],
    runs_by_key: Mapping[str, Run],
    market: MarketData,
    rule: decide.DecisionRule,
    lstm_config: lstm.LSTMConfig,
    model: Model,
) -> tuple[Check, ...]:
    """Attack the result before reporting it, and refuse if any of this
    fails.

    The list runs whatever the AUC came back as. A check that only fires
    on a good result is a check calibrated to find nothing — and on this
    problem the dangerous outcome is not a suspicious number, it is a
    plausible one.
    """
    checks: list[Check] = []
    sessions = panel.sessions

    # 1. Causality, by literal truncation. Every feature at T recomputed
    #    on the panel with everything after T deleted, and demanded to
    #    be bit-for-bit identical. An off-by-one in a rolling window
    #    reads correctly and manufactures a beautiful backtest.
    probes = [
        pd.Timestamp(sessions[min(int(len(sessions) * f), len(sessions) - 1)])
        for f in CAUSALITY_PROBE_FRACTIONS
    ]
    report = features.causality_report(
        panel.panels,
        probes,
        bill_rate=panel.bill_rate_pct,
        available=panel.available,
    )
    checks.append(
        Check(
            "Features at T survive truncation after T",
            report.empty,
            f"all {len(features.FEATURE_COLUMNS)} columns on every fund, "
            f"recomputed on the panel cut at "
            f"{', '.join(str(p.date()) for p in probes)}: "
            + (
                "identical to the last bit"
                if report.empty
                else f"{len(report)} VALUE(S) MOVED, first "
                f"{report.iloc[0]['feature']} on {report.iloc[0]['ticker']}"
            ),
        )
    )

    # 2. The label window reaches 21 sessions forward, so a training row
    #    dated inside that distance of a test fold carries the answer.
    #    `assert_no_leakage` re-derives the property from the label
    #    windows rather than from anything the splitter recorded.
    leaks = plan.leakage_reports()
    row_dates = pd.DatetimeIndex(panel.labels.y.index.get_level_values("date"))
    shared_rows = 0
    for fold in plan.folds:
        shared_rows += len(
            row_dates[fold.train_rows].intersection(row_dates[fold.test_rows])
        )
    ends = plan.label_end
    reaching = 0
    for fold in plan.folds:
        first_test = fold.test_dates[0]
        reaching += int((ends.reindex(fold.train_dates) >= first_test).sum())
    checks.append(
        Check(
            "No label window crosses a fold seam",
            bool(leaks["clean"].all()) and shared_rows == 0 and reaching == 0,
            f"{len(plan)} walk-forward folds, purge {panel.labels.horizon} "
            f"sessions: {int(leaks['overlapping'].sum())} overlapping date(s), "
            f"{int(leaks['inside_embargo'].sum())} inside the embargo, "
            f"{shared_rows} row(s) on both sides of a seam, {reaching} "
            f"training label window(s) reaching into a test fold",
        )
    )

    # 3. Every prediction is out of sample and every row was scored
    #    exactly once. Walk-forward test folds tile the window, so a
    #    duplicated row means two models scored it and the book would
    #    have been sized off whichever arrived last.
    for f in fitted:
        pred = f.predictions
        dupes = int(pred.duplicated(subset=["date", "asset"]).sum())
        misplaced = 0
        for result_fold in plan.folds:
            block = pred.loc[pred["fold"] == result_fold.fold]
            if block.empty:
                continue
            inside = pd.DatetimeIndex(block["date"]).isin(result_fold.test_dates)
            misplaced += int((~inside).sum())
        checks.append(
            Check(
                f"{f.key.upper()} predictions are out of sample, scored once",
                dupes == 0 and misplaced == 0,
                f"{len(pred):,} rows across {len(plan)} folds; {dupes} "
                f"duplicate (date, fund) pair(s) and {misplaced} row(s) dated "
                f"outside the test window of the fold that produced them",
            )
        )

    # 4. A sequence window ends on its own target and reaches only
    #    backward. Structural, and the only thing that can see the
    #    windowing put a row to the right — `features.causality_report`
    #    cannot, because it is handed a frame that is already computed.
    if model.wants_lstm:
        sequences = lstm.build_sequences(
            panel.feature_frame,
            panel.labels.y.index,
            lookback=lstm_config.lookback,
        )
        backward = True
        detail = ""
        try:
            lstm.assert_backward_only(sequences)
        except lstm.LSTMError as exc:
            backward = False
            detail = str(exc)
        moved = lstm.sequence_causality_report(
            panel.feature_frame,
            panel.labels.y.index,
            [probes[-1]],
            lookback=lstm_config.lookback,
        )
        checks.append(
            Check(
                "LSTM windows reach only backward",
                backward and moved.empty,
                detail
                or (
                    f"{sequences.n_valid:,} of {sequences.n_targets:,} targets "
                    f"carry a complete {sequences.lookback}-session window "
                    f"({sequences.dropped}); every window ends on its own "
                    f"decision date and none of them changed when the frame "
                    f"was truncated at {probes[-1].date()}"
                ),
            )
        )

    # 5. Every fill happened after the decision that caused it, at that
    #    session's own open. A fill on the signal's own close is the
    #    single most common way a backtest of this shape lies.
    for key, run in runs_by_key.items():
        trades = run.result.trades
        if not len(trades):
            checks.append(
                Check(
                    f"{key}: fills land at the NEXT open",
                    False,
                    "the run placed no trades at all, which is not a pass — it "
                    "means nothing about execution was exercised",
                )
            )
            continue
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
        checks.append(
            Check(
                f"{key}: fills land at the NEXT open",
                after and at_open,
                f"{len(trades):,} fills, every one strictly after its decision "
                f"(median lag {int(lags.median())} calendar day(s)) and priced "
                f"at that session's own unadjusted open to the last bit",
            )
        )

    # 6. Returns come from the total-return series. Six of these
    #    twenty-eight funds are bond or credit vehicles whose entire
    #    return is coupon, so a book marked on price does not understate
    #    them, it deletes them.
    #
    #    Asked across the PANEL rather than on the closing bar.
    #    Back-adjustment anchors at the last observation, so close_adj
    #    equals close_unadj there for every instrument BY CONSTRUCTION,
    #    and a check made on that one date fails a sound run.
    adj, unadj = market.close_adj, market.close_unadj
    gap = (adj - unadj).abs()
    cells = int((gap > 1e-9).to_numpy().sum())
    movers = [str(c) for c in adj.columns if bool((gap[c] > 1e-9).any())]
    marked = True
    for key, run in runs_by_key.items():
        final = run.result.final_positions
        if not len(final):
            continue
        marks = final.set_index("ticker")["mark"]
        last_adj = adj.iloc[-1].reindex(marks.index).to_numpy(dtype="float64")
        if not np.allclose(marks.to_numpy(dtype="float64"), last_adj):
            marked = False
    if cells == 0:
        marked = False
    checks.append(
        Check(
            "Positions are marked in total-return space",
            marked,
            f"every closing position marked at `close_adj`; across the panel "
            f"{cells:,} fund-days carry an adjusted close that differs from "
            f"the as-traded one, on {len(movers)} of {len(adj.columns)} funds. "
            f"Measured panel-wide because back-adjustment anchors at the final "
            f"bar, where the two agree everywhere by construction",
        )
    )

    # 7. Costs were charged inside the loop. A cost model wired to
    #    nothing produces a beautiful curve and a zero in this row.
    traded = [k for k, r in runs_by_key.items() if len(r.result.trades)]
    breakdowns = {k: runs_by_key[k].result.cost_breakdown for k in traded}
    non_zero = all(
        b["total"] > 0.0 and b["spread"] > 0.0 and b["impact"] > 0.0
        for b in breakdowns.values()
    )
    sums = all(
        abs(b["spread"] + b["impact"] - b["total"]) < 1e-6 for b in breakdowns.values()
    )
    checks.append(
        Check(
            "Trading costs are charged inside the loop",
            bool(breakdowns) and non_zero and sums,
            "; ".join(
                f"{k} {runs.money(b['total'])} "
                f"({runs.money(b['spread'])} spread, "
                f"{runs.money(b['impact'])} impact)"
                for k, b in breakdowns.items()
            )
            or "no book placed a trade",
        )
    )

    # 8. The constraint the whole brief is built on. Re-derived from the
    #    decided weights AND from what the engine actually held, because
    #    the rule obeying itself says nothing about the book the ledger
    #    ended up carrying.
    worst_gross = 0.0
    worst_name = 0.0
    long_only = True
    for key, decision in decisions.items():
        try:
            for _, row in decision.weights.iterrows():
                decide.assert_long_only(row.to_dict(), rule=rule)
        except decide.DecisionError:
            long_only = False
        worst_gross = max(worst_gross, float(decision.weights.sum(axis=1).max()))
        worst_name = max(worst_name, float(decision.weights.to_numpy().max()))
    held_gross = 0.0
    held_short = 0
    for key in decisions:
        weights = runs_by_key[key].result.weights
        held_gross = max(held_gross, float(weights.sum(axis=1).max()))
        held_short += int((weights.to_numpy() < -1e-12).sum())
    checks.append(
        Check(
            "Long only, and never above 100% of NAV",
            long_only
            and held_short == 0
            and worst_gross <= rule.budget + 1e-9
            and held_gross <= 1.0 + 1e-9,
            f"decided weights peak at {worst_name:.1%} in one fund and "
            f"{worst_gross:.1%} gross against a {rule.budget:.0%} budget; the "
            f"engine's realised book peaks at {held_gross:.1%} of NAV with "
            f"{held_short} negative weight(s)",
        )
    )

    # 9. The number the brief says to disbelieve. Above 0.60 out of
    #    sample on this problem is evidence of leakage rather than of
    #    skill, and the instruction is to hunt rather than to report.
    worst = max(
        (f.worst_case_auc for f in fitted if np.isfinite(f.worst_case_auc)),
        default=float("nan"),
    )
    checks.append(
        Check(
            f"No fold's out-of-sample AUC clears {SUSPICIOUS_AUC:.2f}",
            bool(np.isfinite(worst) and worst <= SUSPICIOUS_AUC),
            f"the highest single fold is {worst:.3f}"
            + (
                ""
                if np.isfinite(worst) and worst <= SUSPICIOUS_AUC
                else " — ABOVE THE BAR. On a 21-session cross-sectional label "
                "over liquid ETFs this is evidence of leakage, not of skill, "
                "and the run refuses to report until somebody has been "
                "through the causality and seam checks above"
            ),
        )
    )

    # 10. Every session the engine asked about carried a decision. A
    #     gated book that quietly ran past its own out-of-sample window
    #     would be measured on a stretch the model was never asked
    #     about, and it would look like a strategy sitting in cash.
    unscored = {
        k: int(getattr(runs_by_key[k].strategy, "unscored_sessions", 0))
        for k in decisions
    }
    checks.append(
        Check(
            "Every backtested session carried a decision",
            all(v == 0 for v in unscored.values()),
            f"{len(market.index):,} sessions from {market.index[0].date()} to "
            f"{market.index[-1].date()}; unscored sessions per book: "
            + (", ".join(f"{k} {v}" for k, v in unscored.items()) or "none"),
        )
    )
    return tuple(checks)


# -- rendering ----------------------------------------------------------


def _recovery(dd: metrics.Drawdown) -> str:
    if dd.peak is None:
        return runs.NULL
    if dd.still_underwater:
        return (
            f"not recovered — {dd.sessions_underwater:,} sessions "
            f"({dd.days_underwater:,} days) and counting"
        )
    return f"{dd.sessions_to_recover:,} sessions ({dd.days_to_recover:,} days)"


def _auc_table(fit: Fitted) -> str:
    rows: list[list[str]] = []
    frame = fit.folds
    for _, row in frame.iterrows():
        if fit.key == "gbm":
            rows.append(
                [
                    runs.count(row["fold"]),
                    f"{runs.day(row['test_start'])} → {runs.day(row['test_end'])}",
                    runs.count(row["n_test"]),
                    runs.num(row["test_base_rate"], 3),
                    runs.num(row["auc"], 3),
                    f"{row['auc_z']:+.1f}",
                    runs.num(row["accuracy"], 3),
                    runs.num(row["majority_accuracy"], 3),
                    runs.num(row["identity_auc"], 3),
                    f"{row['best_feature']} {row['best_feature_auc']:.3f}",
                    f"{row['edge_over_best_feature']:+.3f}",
                    f"{row['rank_ic']:+.4f}",
                    f"{row['rank_ic_t_overlap_adjusted']:+.2f}",
                ]
            )
        else:
            rows.append(
                [
                    runs.count(row["fold"]),
                    runs.count(row["n_test"]),
                    runs.num(row["test_base_rate"], 3),
                    runs.num(row["test_auc"], 3),
                    runs.num(row["identity_auc"], 3),
                    f"{row['auc_over_identity']:+.3f}",
                    runs.num(row["test_accuracy"], 3),
                    runs.num(row["majority_accuracy"], 3),
                    runs.num(row["val_auc_at_stop"], 3),
                    runs.num(row["best_epoch_mean"], 1),
                    f"{row['rank_ic']:+.4f}",
                    f"{row['rank_ic_t_adjusted']:+.2f}",
                ]
            )
    if fit.key == "gbm":
        headers = [
            "Fold",
            "Test window",
            "Rows",
            "Base",
            "AUC",
            "z",
            "Acc",
            "Majority",
            "Identity",
            "Best single column",
            "Edge",
            "Rank IC",
            "t (adj)",
        ]
    else:
        headers = [
            "Fold",
            "Rows",
            "Base",
            "AUC",
            "Identity",
            "Over",
            "Acc",
            "Majority",
            "Inner val",
            "Best epoch",
            "Rank IC",
            "t (adj)",
        ]
    aligns = ["r"] * len(headers)
    if fit.key == "gbm":
        aligns[1] = "l"
        aligns[9] = "l"
    return runs.table(headers, rows, aligns)


def _epoch_table(fit: Fitted) -> str:
    """The curve the source project reported, per fold, seeds averaged.

    Averaged over seeds and never over folds: the shape of one fold's
    two lines is the finding, and a mean across folds would blend a
    model that learned nothing with one that memorised its training set
    into a curve describing neither.
    """
    traj = fit.trajectory
    if traj.empty:
        return "_No epochs recorded._"
    columns = ["train_auc", "val_auc", "train_loss", "val_loss"]
    grouped = (
        traj.groupby(["fold", "epoch"], as_index=False)[columns]
        .mean()
        .sort_values(["fold", "epoch"])
    )
    rows = [
        [
            runs.count(r["fold"]),
            runs.count(r["epoch"]),
            runs.num(r["train_loss"], 4),
            runs.num(r["val_loss"], 4),
            runs.num(r["train_auc"], 3),
            runs.num(r["val_auc"], 3),
            f"{r['train_auc'] - r['val_auc']:+.3f}",
        ]
        for _, r in grouped.iterrows()
    ]
    return runs.table(
        ["Fold", "Epoch", "Train loss", "Val loss", "Train AUC", "Val AUC", "Gap"],
        rows,
        ["r"] * 7,
    )


def _headline_table(s: Study) -> str:
    rows: list[list[str]] = []
    for run in s.ordered:
        r = run.report
        d = run.deflated
        rows.append(
            [
                run.book.label,
                runs.signed_pct(r.cagr),
                runs.pct(r.annualised_volatility),
                runs.num(r.sharpe, 2),
                runs.num(d.deflated_sharpe, 3) if d else runs.NULL,
                runs.num(d.benchmark_sharpe_annualised, 2) if d else runs.NULL,
                runs.pct(r.drawdown.depth),
                runs.num(r.costs.annual_turnover, 2),
                runs.bps(r.costs.cost_drag_bps),
            ]
        )
    return runs.table(
        [
            "Book",
            "CAGR",
            "Vol",
            "Sharpe",
            "Deflated",
            "Hurdle SR",
            "Max DD",
            "Turnover",
            "Cost drag",
        ],
        rows,
        ["l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _cost_table(s: Study) -> str:
    rows = []
    for run in s.ordered:
        breakdown = run.result.cost_breakdown
        deferrals = run.result.deferrals
        postponed = run.result.postponed
        by_reason = (
            postponed.groupby("reason")["postponed_notional"].sum()
            if len(postponed)
            else pd.Series(dtype="float64")
        )
        rows.append(
            [
                run.book.label,
                runs.count(len(run.result.trades)),
                runs.money(breakdown["spread"]),
                runs.money(breakdown["impact"]),
                runs.money(breakdown["total"]),
                runs.count(len(deferrals)),
                runs.money(run.deferral_shortfall),
                runs.money(float(by_reason.get("settled_cash", 0.0))),
                runs.money(float(by_reason.get("turnover_budget", 0.0))),
            ]
        )
    return runs.table(
        [
            "Book",
            "Fills",
            "Spread",
            "Impact",
            "Total cost",
            "Deferrals",
            "Deferred $",
            "Postponed: cash",
            "Postponed: budget",
        ],
        rows,
        ["l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _gate_table(s: Study) -> str:
    rows = []
    for key, decision in s.decisions.items():
        log = decision.log
        acting = log.loc[log["acted"]]
        wanted = decision.desired_turnover
        rows.append(
            [
                key.upper(),
                runs.count(len(log)),
                runs.count(int(log["acted"].sum())),
                runs.pct(decision.did_nothing_fraction),
                runs.num(acting["n_surviving"].mean(), 2) if len(acting) else runs.NULL,
                runs.count(int(log["n_surviving"].max())),
                runs.pct(decision.mean_invested),
                runs.pct(float(wanted.mean())),
                runs.num(log["best_adjusted"].mean(), 4),
            ]
        )
    return runs.table(
        [
            "Model",
            "Dates",
            "Acted on",
            "Did nothing",
            "Names when acting",
            "Most names",
            "Mean invested",
            "Wanted to trade / day",
            "Mean best adj. p",
        ],
        rows,
        ["l", "r", "r", "r", "r", "r", "r", "r", "r"],
    )


def _importance_table(fit: Fitted) -> str:
    frame = fit.importance
    if frame.empty:
        return "_No importance was measured._"
    grouped = frame.groupby("feature", as_index=False).agg(
        importance=("importance", "mean"),
        share=("share", "mean"),
        folds=("fold", "count"),
    )
    grouped = grouped.sort_values("importance", ascending=False)
    rows = [
        [
            str(r["feature"]),
            runs.num(r["importance"], 5),
            runs.pct(r["share"], 1) if np.isfinite(r["share"]) else runs.NULL,
            runs.count(r["folds"]),
        ]
        for _, r in grouped.iterrows()
    ]
    return runs.table(
        ["Feature", "Mean AUC lost when shuffled", "Share", "Folds"],
        rows,
        ["l", "r", "r", "r"],
    )


def _period_table(s: Study) -> str:
    rows = []
    for run in s.ordered:
        frame = run.report.periods
        if frame is None or frame.empty:
            continue
        for _, r in frame.iterrows():
            # A named window the sample does not reach comes back as a
            # row of NaN. Printed, it reads as a period in which the
            # book returned nothing, which is a different claim.
            if not np.isfinite(float(r.get("total_return", np.nan))):
                continue
            rows.append(
                [
                    run.book.label,
                    str(r.get("period", "")),
                    runs.signed_pct(r.get("total_return")),
                    runs.num(r.get("sharpe"), 2),
                    runs.pct(r.get("max_drawdown")),
                ]
            )
    if not rows:
        return "_No named window falls inside this sample._"
    return runs.table(
        ["Book", "Window", "Return", "Sharpe", "Max DD"],
        rows,
        ["l", "l", "r", "r", "r"],
    )


def _verdict(s: Study) -> str:
    if not s.clean:
        failed = [c.name for c in s.checks if not c.passed]
        return (
            f"**NOT REPORTABLE — {len(failed)} sceptic check(s) failed: "
            f"{'; '.join(failed)}.** No performance number from this run is "
            "printed below, because a backtest whose causality or leakage "
            "checks failed is not a weak result, it is an unmeasured one."
        )
    lines = []
    for fit in s.fitted:
        aucs = np.asarray(fit.fold_aucs, dtype="float64")
        low, high = ic_interval(fit.ic)
        against = _what_it_did_not_beat(fit)
        lines.append(
            f"**{fit.key.upper()}**: fold AUCs "
            f"{', '.join(f'{a:.3f}' for a in aucs)} against a base rate of "
            f"0.500 held there by construction; pooled out-of-sample AUC "
            f"{fit.auc_overall:.3f}. Mean per-date rank IC "
            f"{fit.ic.mean:+.4f} (95% interval {low:+.4f} to {high:+.4f} once "
            f"the {fit.ic.horizon}-session window overlap is charged for), "
            f"t {fit.ic.t_stat_overlap_adjusted:+.2f}. {against}"
        )
    gate = "; ".join(
        f"{k.upper()} stood aside on {d.did_nothing_fraction:.1%} of dates and "
        f"held {d.mean_invested:.0%} of NAV on average"
        for k, d in s.decisions.items()
    )
    lines.append(f"**The gate**: {gate}.")

    ranked = ", ".join(
        f"{run.book.label} {run.report.cagr * 100:+.2f}% a year at a Sharpe of "
        f"{run.report.sharpe:.2f}"
        for run in s.ordered
    )
    lines.append(f"**Through the engine**, on identical costs: {ranked}.")
    return "\n\n".join(lines)


def _finding(s: Study) -> str:
    """The first sentence, composed from the numbers rather than chosen.

    A report whose conclusion is typed in by hand is a report that keeps
    its conclusion when the numbers move. Every branch below is a
    comparison, so if a future run does find something the leading
    sentence changes on its own.
    """
    gated = [s.runs[f.key] for f in s.fitted]
    marks = [s.runs[k] for k in ("spy", "equal") if k in s.runs]
    best = max(r.report.sharpe for r in gated)
    weakest_benchmark = min(r.report.sharpe for r in marks)
    aucs = np.asarray([f.auc_overall for f in s.fitted], dtype="float64")

    many = len(s.fitted) > 1
    if best < weakest_benchmark:
        lead = (
            f"**{'Neither model' if many else 'The model'} produced a book "
            "worth holding.** Every gated strategy here is beaten by both "
            "benchmarks on the same engine, the same settlement and the same "
            "costs"
        )
    elif best < max(r.report.sharpe for r in marks):
        lead = (
            "**One gated book beats one benchmark and not the other**, which "
            "is not a result either"
        )
    else:
        lead = (
            "**A gated book beat both benchmarks**, which is the outcome this "
            "study did not expect and the one to hunt through before "
            "believing"
        )

    tail = []
    for fit in s.fitted:
        run = s.runs[fit.key]
        tail.append(
            f"{fit.key.upper()} scored {fit.auc_overall:.3f} out of sample "
            f"against a 0.500 base rate and returned "
            f"{run.report.cagr * 100:+.2f}% a year"
        )
    identity = [
        f.folds["identity_auc"].mean()
        for f in s.fitted
        if "identity_auc" in f.folds.columns
    ]
    note = ""
    if identity and float(np.mean(aucs)) <= float(np.mean(identity)) + 0.01:
        note = (
            f" {'Both AUCs sit' if many else 'That AUC sits'} at or under what "
            "a lookup table of per-fund training base rates scores on the same "
            "rows, so what little ordering there is looks like fund identity "
            "rather than timing."
        )
    return f"{lead}: {'; '.join(tail)}.{note}"


def _what_it_did_not_beat(fit: Fitted) -> str:
    """The sentence that makes an AUC readable, per model.

    An AUC printed alone is read against 0.500, which is what a coin
    scores and not what a competent alternative scores. For the tree the
    alternative is one sorted column with its sign chosen after the
    fact; for the net it is a lookup table of per-fund training base
    rates, which uses no feature, no date and no market state.
    """
    frame = fit.folds
    identity = ""
    if "identity_auc" in frame.columns:
        identity = (
            f"A lookup table of per-fund training base rates — no feature, no "
            f"date, no market state — scores "
            f"{float(frame['identity_auc'].mean()):.3f} on the same rows, so "
            f"the model is {float(frame['auc_over_identity'].mean()):+.3f} on "
            f"top of knowing nothing but which fund this is."
        )
    if fit.key == "gbm" and "edge_over_best_feature" in frame.columns:
        beaten = int((frame["edge_over_best_feature"] <= 0.0).sum())
        return (
            f"A single sorted column — picked and signed after seeing the fold "
            f"— matched or beat the whole ensemble in {beaten} of "
            f"{len(frame)} folds. {identity}"
        ).strip()
    return identity


def render_markdown(s: Study, generated_at: datetime, out: Path) -> str:
    lines: list[str] = []

    def add(text: str = "") -> None:
        lines.append(text)

    panel = s.panel
    first, last = s.window
    add("# The uncertainty-gated classifier")
    add()
    add(
        f"_{panel.study_start.date()} to {panel.study_end.date()} "
        f"({len(panel.labels.dates):,} labelled sessions, "
        f"{len(panel.labels.assets)} funds); out-of-sample trading "
        f"{first.date()} to {last.date()}._"
    )
    add()

    if not s.clean:
        add("## This run is refused")
        add()
        add(_verdict(s))
        add()
        add(runs.checks_table(s.checks))
        add()
        add(
            "Nothing else is printed. A report that leads with a failed "
            "causality check and then prints a Sharpe teaches the reader to "
            "scroll past the check."
        )
        add()
        add(f"_Generated {runs.stamp(generated_at)} by `run_ml.py`._")
        add()
        return "\n".join(lines)

    add(_finding(s))
    add()
    add("## What this is, and what it was expected to say")
    add()
    add(
        "A reproduction of a YouTube project that trains an LSTM to predict "
        "whether a forward return clears a threshold and trades only when the "
        "model is confident. The source reported a validation AUC drifting "
        "from 0.60 to 0.50 over twenty-five epochs while training AUC climbed, "
        "a backtest that \"appears to be basically a random guess\", and a "
        "universe of \"random tickers that exist today\" — which is a "
        "survivorship-biased sample and the reason this version trades ETFs. "
        "**The expected result here is an AUC near 0.50, and that is a "
        "measurement rather than a failure.** Nothing was tuned toward a "
        "better number; every window, hyperparameter and threshold is a prior "
        "written down in `griffinquant/ml/*.py` before a fold had been scored."
    )
    add()
    add(_verdict(s))
    add()

    add("## The sample")
    add()
    models: list[list[str]] = []
    if s.model.wants_gbm:
        c = s.gbm_config
        models.append(
            [
                "Tree",
                f"{c.n_members} bootstrap members over dates, {c.max_iter} "
                f"iterations, {c.max_leaf_nodes} leaves, learning rate "
                f"{c.learning_rate:g}, L2 {c.l2_regularization:g}, early "
                f"stopping OFF (its default splits a date across the seam)",
            ]
        )
    lstm_fit = s.fit("lstm")
    if s.model.wants_lstm:
        c = s.lstm_config
        models.append(
            [
                "Net",
                f"one LSTM layer, {c.hidden_size} hidden units, "
                f"{c.lookback}-session lookback, {c.n_seeds} seeds, at most "
                f"{c.max_epochs} epochs with patience {c.patience}, epoch "
                f"chosen on the last {c.validation_fraction:.0%} of the "
                f"training window; ran on "
                f"{lstm_fit.device if lstm_fit else c.device}",
            ]
        )
    add(
        runs.table(
            ["", ""],
            [
                ["Universe", f"{len(panel.tickers)} US-listed ETFs, `ml/universe.py`"],
                ["Source", panel.source_label],
                ["Cache", panel.cache_note],
                ["Report", str(out)],
                *models,
                ["Bill series", panel.rf_note],
                [
                    "Feature warmup",
                    f"{FEATURE_WARMUP_YEARS} years before the study start, so a "
                    f"252-session feature is complete on day one and no label "
                    f"is built from it",
                ],
                [
                    "Label",
                    f"beat the cross-sectional median forward return over "
                    f"{panel.labels.horizon} sessions",
                ],
                [
                    "Base rate",
                    f"{panel.labels.base_rate:.4f} — one half by construction, "
                    f"which is what makes every accuracy below readable",
                ],
                [
                    "Rows",
                    f"{panel.labels.n:,} labelled (date, fund) pairs over "
                    f"{len(panel.labels.dates):,} sessions",
                ],
                [
                    "Independent observations",
                    panel.labels.effective_sample().note,
                ],
                [
                    "Folds",
                    f"{len(s.plan)} walk-forward, expanding training, refit "
                    f"every {REFIT_FREQUENCY_YEARS} years after "
                    f"{MIN_TRAIN_YEARS} years of history, "
                    f"{panel.labels.horizon}-session purge at every seam",
                ],
                ["Trials on file", f"{s.trials:,} distinct configurations"],
            ],
            ["l", "l"],
        )
    )
    add()
    add("### What was dropped, and why")
    add()
    add(
        runs.frame_table(
            panel.labels.describe(),
            [
                ("n", "Labelled", runs.count),
                ("dropped_incomplete_window", "No complete window", runs.count),
                ("dropped_thin_cross_section", "Thin cross-section", runs.count),
                ("dropped_tie_at_threshold", "Exactly at the median", runs.count),
                ("positives", "Positives", runs.count),
                ("base_rate", "Base rate", lambda v: runs.num(v, 4)),
            ],
        )
    )
    add()
    if not panel.inception_findings.empty:
        add(
            "The vendor's coverage does not begin on every fund's stated "
            "inception. Reported rather than fatal — a fund whose bars start "
            "late contributes nothing to a cross-sectional rank until they "
            "do, which is the correct behaviour and not a silent one:"
        )
        add()
        add(
            runs.frame_table(
                panel.inception_findings,
                [
                    ("ticker", "Fund", str, "l"),
                    ("finding", "Finding", str, "l"),
                    ("asserted_inception", "Stated inception", runs.day),
                    ("first_bar", "First bar served", runs.day),
                    ("gap_days", "Gap (days)", lambda v: runs.num(v, 0)),
                ],
            )
        )
        add()

    add("## Per-fold AUC, with the base rate beside it")
    add()
    add(
        "One row per fold and no pooled mean, because a mean over a "
        "trajectory is the summary that erases the trajectory. The base rate "
        "is 0.500 on every fold by construction, so an accuracy is readable "
        "against the majority column directly. `z` is the distance from a "
        "coin flip in standard errors already widened by the square root of "
        "the horizon for the overlap between consecutive label windows — and "
        "still generous, because the cross-section is not independent either: "
        f"{len(panel.labels.assets)} funds amount to about "
        f"{panel.labels.effective_sample().effective_assets:.1f} distinct "
        "series."
    )
    add()
    for fit in s.fitted:
        add(f"### {fit.label}")
        add()
        add(_auc_table(fit))
        add()
        add(fit.note.replace("\n", "  \n"))
        add()
        low, high = ic_interval(fit.ic)
        naive = 1.96 * fit.ic.std / np.sqrt(max(fit.ic.n_dates, 1))
        add(
            f"Pooled out-of-sample: AUC {fit.auc_overall:.4f} on "
            f"{len(fit.predictions):,} rows. Mean per-date rank IC "
            f"{fit.ic.mean:+.4f} over {fit.ic.n_dates:,} dates, standard "
            f"deviation {fit.ic.std:.4f}; the 95% interval is "
            f"{low:+.4f} to {high:+.4f} once the {fit.ic.horizon}-session "
            f"overlap is charged for, against {fit.ic.mean - naive:+.4f} to "
            f"{fit.ic.mean + naive:+.4f} if the overlapping windows were "
            f"treated as independent draws — which is the mistake that makes "
            f"a weak IC look decisive."
        )
        add()

    if lstm_fit is not None:
        add("## The epoch curves")
        add()
        add(
            "The chart the source project's finding actually lived in: "
            "training AUC against inner-validation AUC, epoch by epoch, "
            "averaged over seeds within a fold and never across folds. The "
            "validation slice is the tail of the TRAINING window, purged of "
            "every row whose label reaches into it — the test fold is scored "
            "exactly once, at the epoch this slice chose, because \"train with "
            "early stopping on validation\" and \"report the validation AUC\" "
            "together mean the reported number was a maximum over forty draws."
        )
        add()
        if lstm_fit.capacity is not None:
            add(f"_{lstm_fit.capacity.note}_")
            add()
        add(_epoch_table(lstm_fit))
        add()

    add("## The gate: how often the rule chose to do nothing")
    add()
    add(
        f"The decision rule subtracts {s.rule.k:g} standard deviation(s) of "
        f"member disagreement from each probability and acts only where the "
        f"result clears {s.rule.minimum:.2f}. Both numbers are priors fixed "
        f"in `ml/decide.py` before any of the above existed. Survivors are "
        f"equal-weighted at `min({s.rule.max_weight:.2f}, "
        f"{s.rule.budget:.2f}/n)`, so one surviving fund is a "
        f"{s.rule.max_weight:.0%} position and three-quarters cash, and "
        f"nothing the rule can produce sums past {s.rule.budget:.0%} of NAV. "
        "**Being permitted to hold nothing is the whole design.** A "
        "do-nothing fraction near zero would mean the gate is not gating; "
        "near one, that this is an expensive way to hold cash. Both are "
        "findings and neither is a reason to move the threshold."
    )
    add()
    add(_gate_table(s))
    add()
    for key, decision in s.decisions.items():
        add(f"- **{key.upper()}** — {decision.summary()}")
    add()

    add("## The backtest, through the real engine")
    add()
    add(
        "Decided at a close, filled at the next open out of settled cash "
        "under T+1, charged a liquidity-scaled spread and a square-root "
        "impact term, whole shares, a 5%-of-NAV daily turnover budget and a "
        "5% cash buffer. Both benchmarks run on the same engine with the same "
        "settlement and the same cost model — a strategy compared against a "
        "costless index is being compared against something nobody could hold."
    )
    add()
    add(_headline_table(s))
    add()
    add(
        f"The deflated Sharpe is deflated by **{s.trials:,} distinct "
        f"configurations** on file across this whole project, not by the four "
        f"books above: a search does not become smaller by being spread over "
        f"several files. Correlated variants of one idea are not that many "
        f"independent trials, so the count overstates N — which RAISES the "
        f"hurdle, and being conservative in that direction is the only "
        f"defensible way to be wrong about a denominator we chose ourselves."
    )
    add()
    add("### Where the money went")
    add()
    add(_cost_table(s))
    add()
    binding = []
    for run in s.ordered:
        daily = run.result.daily
        binding.append(
            f"{run.book.label}: the 5%-of-NAV daily turnover budget bound on "
            f"{int(daily['budget_binding'].sum()):,} of {len(daily):,} sessions"
        )
    add(
        "The postponed columns are FLOWS, not stocks: every session the "
        "engine restates what the strategy asked for and books whatever the "
        "budget would not cover, so a book that wants a different set of "
        "funds every morning accumulates a postponed figure many times its "
        "own NAV without a dollar of it ever being a position. Read it beside "
        "the gate's \"wanted to trade\" column, which is the same instability "
        "measured before any constraint. "
        + "; ".join(binding)
        + "."
    )
    add()
    add(
        "That constraint is a fact about the account rather than a modelling "
        "choice, and it cuts the strategy's way: what is measured above is "
        "the rule as a $131,000 cash account could actually implement it. The "
        "unconstrained version would have traded more and therefore paid more."
    )
    add()
    add("### Drawdowns")
    add()
    add(
        runs.table(
            ["Book", "Max drawdown", "Peak", "Trough", "Recovery"],
            [
                [
                    run.book.label,
                    runs.pct(run.report.drawdown.depth),
                    runs.day(run.report.drawdown.peak),
                    runs.day(run.report.drawdown.trough),
                    _recovery(run.report.drawdown),
                ]
                for run in s.ordered
            ],
            ["l", "r", "r", "r", "l"],
        )
    )
    add()
    add("### Named windows")
    add()
    add(_period_table(s))
    add()

    gbm_fit = s.fit("gbm")
    if gbm_fit is not None:
        add("## What the tree paid attention to")
        add()
        add(
            "Permutation importance, shuffled WITHIN each date: a global "
            "shuffle would also move a 2008 volatility reading onto a 2017 "
            "row, and the AUC drop would then be partly the model noticing "
            "the value is out of era — a fact about the calendar credited to "
            "the feature. The bill rate cannot be permuted this way at all "
            "because it does not vary across the cross-section, and it comes "
            "back unmeasured rather than as a zero that would sit in the "
            "table looking like a finding."
        )
        add()
        add(_importance_table(gbm_fit))
        add()
        uniform = int(gbm_fit.folds["importance_near_uniform"].sum())
        add(
            f"Importance is flagged near-uniform in **{uniform} of "
            f"{len(gbm_fit.folds)} folds**. Attention spread evenly over "
            "seventeen columns is not a well-balanced model; it is what "
            "fitting noise looks like, and it is the diagnostic the source "
            "project reported about its own features without following the "
            "thought through."
        )
        add()

    add("## The sceptic's log")
    add()
    add(
        "Every check ran, whatever the numbers above came back as. A check "
        "that only fires on a good result is a check calibrated to find "
        "nothing — and on this problem the dangerous outcome is not a "
        "suspicious number, it is a plausible one."
    )
    add()
    add(runs.checks_table(s.checks))
    add()

    add("## What this does not measure")
    add()
    add(
        "- **The universe was chosen in 2026.** Twenty-eight funds that "
        "survived and grew, picked with full knowledge of which product lines "
        "gathered assets. That bias is far smaller than a single-name panel's "
        "— a closed ETF is wound up at NAV and its holders are paid out, "
        "where a delisted equity is usually a total loss — but it is not "
        "zero, and `ml/universe.py` names the two channels that survive."
    )
    add(
        "- **Fourteen of the twenty-eight are US equity beta.** A "
        "cross-sectional rank here is, half the time, a rank within US equity "
        "sectors. These are not twenty-eight independent bets, and the "
        f"correlation of the cross-section puts them at about "
        f"{panel.labels.effective_sample().effective_assets:.1f} distinct "
        "series."
    )
    add(
        "- **The uncertainty the gate reads is model variance and nothing "
        "else.** It answers how much the fitted function moves when the "
        "training sample is resampled, not whether these features carry any "
        "signal at all — which is the far larger uncertainty and is the "
        "question this study is asking. A tight ensemble around a coin flip "
        "is a well-fitted coin flip, and the gate will happily trade one."
    )
    add(
        "- **One historical path.** Every fold is a slice of the same "
        "twenty-one years, the folds' test windows tile that path, and a test "
        "observation in the last month of one fold has a label window "
        "reaching into the next. No model sees its own answer, so this is not "
        "leakage — but consecutive folds' scores are not independent draws, "
        "and a run of good ones is worth less than it looks."
    )
    add(
        "- **This is the second document to touch these folds.** If the "
        "priors above are ever moved in response to a number in this report, "
        "the out-of-sample stops being out of sample, and there is not a "
        "second twenty-one years waiting."
    )
    add()
    add(f"_Generated {runs.stamp(generated_at)} by `run_ml.py`._")
    add()
    return "\n".join(lines)


def print_console(s: Study) -> None:
    out = typer.echo
    first, last = s.window
    out("")
    out(
        f"  ML classifier: labels {s.panel.study_start.date()} to "
        f"{s.panel.study_end.date()}, out-of-sample {first.date()} to "
        f"{last.date()} ({len(s.plan)} walk-forward folds)"
    )
    out("")
    for fit in s.fitted:
        aucs = ", ".join(f"{a:.3f}" for a in fit.fold_aucs)
        low, high = ic_interval(fit.ic)
        out(f"  {fit.key.upper():<5} fold AUC {aucs}  (base rate 0.500)")
        out(
            f"        pooled {fit.auc_overall:.4f}  rank IC {fit.ic.mean:+.4f} "
            f"[{low:+.4f}, {high:+.4f}]  t {fit.ic.t_stat_overlap_adjusted:+.2f}"
        )
    out("")
    for key, decision in s.decisions.items():
        out(
            f"  {key.upper():<5} did nothing on "
            f"{decision.did_nothing_fraction:.1%} of dates; mean invested "
            f"{decision.mean_invested:.1%}"
        )
    out("")
    width = max(len(b.label) for b in s.books) + 2
    out(
        f"  {'book':<{width}} {'CAGR':>9} {'vol':>8} {'SR':>7} {'DSR':>7} "
        f"{'maxDD':>9}"
    )
    for run in s.ordered:
        r = run.report
        d = run.deflated
        out(
            f"  {run.book.label:<{width}} {r.cagr * 100:>8.2f}% "
            f"{r.annualised_volatility * 100:>7.2f}% {r.sharpe:>7.2f} "
            f"{(d.deflated_sharpe if d else float('nan')):>7.3f} "
            f"{r.drawdown.depth * 100:>8.2f}%"
        )
    out("")
    out(f"  trials on file: {s.trials:,} distinct")
    out("")
    for check in s.checks:
        out(f"  [{check.verdict}] {check.name}")
    out("")


# -- the entry point ----------------------------------------------------


def _generated_at() -> datetime:
    """One clock reading, threaded through everything the run emits."""
    return runs.utcnow()


@app.command()
def main(
    start: str = typer.Option(SAMPLE_START, "--start", help="First labelled session."),
    end: str = typer.Option("", "--end", help="Last session; blank means today."),
    out: Path = typer.Option(DEFAULT_REPORT, "--out", help="Where to write."),
    source: Source = typer.Option(
        Source.tiingo, "--source", help="Which price feed to pull from."
    ),
    model: Model = typer.Option(
        Model.both, "--model", help="Which classifier to fit."
    ),
    device: str = typer.Option(
        "auto", "--device", help="Torch device for the LSTM: auto, cpu or mps."
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
        raise runs.refuse_no_data(exc, what="no model was fitted")

    ledger = runs.Trials(path=trials, when=generated_at)
    try:
        result = study(
            panel,
            ledger=ledger,
            generated_at=generated_at,
            model=model,
            rule=decide.DecisionRule(),
            gbm_config=gbm.DEFAULT_CONFIG,
            lstm_config=lstm.LSTMConfig(device=device),
        )
    except (BacktestError, splits.SplitError, decide.DecisionError) as exc:
        # The engine, the splitter or the gate refused. Reported as a
        # refusal rather than as a traceback, and emphatically not as a
        # result with a caveat attached.
        typer.secho(
            "\n  THE RUN WAS REFUSED — no result exists.\n",
            fg=typer.colors.RED,
            bold=True,
            err=True,
        )
        typer.secho(f"  {exc}\n", fg=typer.colors.RED, err=True)
        raise typer.Exit(EXIT_FAILED)

    if not quiet:
        print_console(result)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(result, generated_at, out), "utf-8")
    if not quiet:
        typer.echo(f"  report → {out}\n")

    raise typer.Exit(EXIT_OK if result.clean else EXIT_FAILED)


if __name__ == "__main__":
    app()
