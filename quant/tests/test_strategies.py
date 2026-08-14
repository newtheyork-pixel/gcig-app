"""The admissibility tests, run against the registry rather than against
a list somebody remembered to update.

Every test that matters here is parametrised over
`strategies.registry.entries()`, and one test asserts that the registry
covers every class its own modules list. Those two facts together are
the point of the file: a strategy added to the library without a test is
not discouraged, it is impossible — the parametrisation picks it up the
moment it is registered, and `unregistered()` fails the build if it is
written and never registered at all.

What is being established is narrower than "these strategies work", and
narrower on purpose. There is no claim here about any strategy's return.
These are the properties that decide whether a row is ADMISSIBLE — that
is, whether the number it eventually produces is a measurement of a
published rule under this account's constraints rather than a
measurement of something else:

  * **Long only, and no leverage.** Weights in [0, 1] and a gross at or
    below 1.0, under panels no market ever produced. Both are account
    facts and neither is negotiable, so both are checked against
    adversarial input rather than against the well-behaved fixture where
    every strategy looks obedient.
  * **Strictly causal.** Tested by literal truncation — cut the panel
    after T, run the engine again from scratch, and demand every weight
    and every equity value up to T come back bit for bit identical. This
    is the one property that cannot be established by reading the code:
    an off-by-one in a rolling window or a stray `shift(-1)` is
    invisible to a reviewer, produces a beautiful equity curve, and is
    the most common way a project like this fools itself.
  * **Traceable.** A publication date, a citation, a universe, and a
    written statement of where the implementation departs from the
    source. A row in a replication study that cannot be traced back to a
    document is not evidence about anything.
  * **Runnable.** Every strategy completes an end-to-end run through
    `run_backtest` and produces a book the ledger's own invariant
    accepts.

**Refusing loudly counts as passing.** Several of these rules are
supposed to stop rather than continue: Faber's and Antonacci's refuse to
run under weight caps that would silently turn them into a different
strategy, the risk family refuses a covariance built from a non-positive
price, and DAA refuses an incomplete canary. So the adversarial contract
is "admissible weights OR a declared error", and the declared list is
short and explicit — an exception type nobody wrote down is a crash, and
a crash inside a twenty-year run is not a refusal, it is a run that
stopped somewhere nobody planned for.

**The panel is synthetic and the tests say nothing about real prices.**
Free ETF history is not in this repository's cache for most of these
tickers, and a test that needed it would be a test that stops running.
What a generated panel can establish is exactly what is listed above:
mechanics, bounds and causality. It cannot establish that any of these
strategies is worth holding, and no assertion here pretends to.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine.backtest import (
    BacktestConfig,
    BacktestError,
    MarketData,
    MarketView,
    run_backtest,
)
from griffinquant.engine.ledger import is_session
from griffinquant.signals.volatility import SignalError
from griffinquant.strategies import factor, riskparity, staticmix, tactical, trend
from griffinquant.strategies import registry
from griffinquant.strategies.registry import UNDATED, Entry, RegistryError

#: A strategy is allowed to stop, and these are the ways it may do it.
#: Every one is a class somebody wrote in order to say a specific "no" —
#: a cap that changes the rule, a price that cannot produce a return, a
#: universe missing the line the breadth count divides by. Anything else
#: reaching a caller is a crash, and the distinction is the whole reason
#: this tuple is enumerated rather than being `except ValueError`.
REFUSALS = (
    staticmix.StaticMixError,
    trend.StrategyError,
    tactical.TacticalError,
    riskparity.RiskParityError,
    factor.StrategyError,
    SignalError,
    BacktestError,
)

ENTRIES: tuple[Entry, ...] = registry.entries()

#: Every ticker any registered strategy needs, so one panel serves the
#: whole library and a strategy naming a fund nobody pulled shows up as
#: a missing column here rather than in a run.
TICKERS: tuple[str, ...] = registry.panel_tickers()

#: Long enough that the deepest warmup in the library — thirteen months
#: of month-end closes for the tactical family, a trading year for the
#: risk models — leaves a real stretch of decisions behind it.
SESSIONS = 620

#: Where the truncation test cuts. Comfortably past every warmup, so the
#: comparison is over decisions the rules actually took rather than over
#: the cash they held while banking history.
CUT = 500

#: Weight arithmetic tolerance, the engine's own.
EPS = 1e-9

#: Caps are turned OFF, and that is not a convenience. The ceilings in
#: `portfolio/sleeves.py` are this fund's risk policy for its own book;
#: Faber, Antonacci, Keller, Qian and Haugen imposed nothing of the kind,
#: and a run under them measures our constraint rather than their rule.
#: The one test that DOES impose caps imposes its own and checks they
#: were honoured.
CONFIG = BacktestConfig(
    apply_sleeve_caps=False,
    default_max_weight=1.0,
    band_provenance=(
        "not tuned; the engine default, fixed before any result existed "
        "and unchanged for this fixture"
    ),
)


# -- the panel ----------------------------------------------------------


def _sessions(start: str, n: int) -> pd.DatetimeIndex:
    """Real NYSE sessions. The engine refuses anything else, and it is
    right to — a weekend in the index means a calendar leaked in."""
    days = pd.date_range(start, periods=int(n * 2.2), freq="D")
    return pd.DatetimeIndex([d for d in days if is_session(d)][:n], name="date")


INDEX = _sessions("2015-01-02", SESSIONS)


def _closes(seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    """A geometric random walk per ticker with one common factor.

    The common factor is not decoration. A panel of independent walks
    has an average pairwise correlation near zero, which is the one
    market state in which minimum variance, maximum diversification and
    inverse volatility all agree — so a covariance-driven strategy could
    be badly wrong and every assertion here would still pass.
    """
    rng = np.random.default_rng(seed)
    k = len(TICKERS)
    drift = rng.normal(0.0003, 0.0002, size=k)
    vol = rng.uniform(0.005, 0.018, size=k)
    idiosyncratic = rng.standard_normal((len(INDEX), k))
    common = rng.standard_normal((len(INDEX), 1))
    rets = drift + vol * (0.6 * idiosyncratic + 0.4 * common)
    close = 100.0 * np.exp(np.cumsum(rets, axis=0))
    opens = close * (1.0 + rng.normal(0.0, 0.001, size=close.shape))
    cols = list(TICKERS)
    return (
        pd.DataFrame(opens, index=INDEX, columns=cols),
        pd.DataFrame(close, index=INDEX, columns=cols),
    )


OPEN, CLOSE = _closes()


def _market(opens: pd.DataFrame, close: pd.DataFrame) -> MarketData:
    """Both statistics are TRAILING rolling windows, which is what makes
    the truncation test mean anything: cutting the panel cannot change a
    value at a row before the cut, so any difference the test finds
    belongs to the strategy."""
    volume = pd.DataFrame(5e8, index=opens.index, columns=opens.columns)
    daily_vol = close.pct_change().rolling(63, min_periods=20).std(ddof=1)
    return MarketData(
        open_unadj=opens,
        close_unadj=close,
        close_adj=close * 1.0,
        dollar_volume=volume,
        daily_volatility=daily_vol,
    )


@pytest.fixture(scope="module")
def market() -> MarketData:
    return _market(OPEN, CLOSE)


@pytest.fixture(scope="module")
def truncated_market() -> MarketData:
    return _market(OPEN.iloc[: CUT + 1], CLOSE.iloc[: CUT + 1])


def _view(
    close: pd.DataFrame,
    *,
    weights: dict[str, float] | None = None,
    caps: dict[str, float] | None = None,
    investable: float = 0.95,
) -> MarketView:
    """A view built by hand, so a strategy can be asked one question
    without paying for a twenty-year run to get to it."""
    held = dict(weights or {})
    return MarketView(
        asof=pd.Timestamp(close.index[-1]),
        open_unadj=close,
        close_unadj=close,
        close_adj=close,
        dollar_volume=None,
        daily_volatility=None,
        weights=held,
        nav=131_000.0,
        cash_weight=max(0.0, 1.0 - sum(held.values())),
        investable_weight=investable,
        no_trade_band=0.005,
        caps=caps or {t: 1.0 for t in close.columns},
    )


# -- adversarial panels -------------------------------------------------
#
# Each of these is a shape real data takes when something upstream went
# wrong, plus a couple that only arithmetic produces. None of them is a
# market state a strategy should have an opinion about; all of them are
# states a strategy must not answer with a short or a borrowing.

def _mangled(name: str) -> pd.DataFrame:
    c = CLOSE.copy()
    if name == "all_nan":
        # A panel that printed nothing. Every rule must abstain.
        c.loc[:, :] = np.nan
    elif name == "zeros":
        # A dead instrument, or a data hole wearing a number.
        c.loc[:, :] = 0.0
    elif name == "negative":
        # Not a market state at all. It is a sign error, and the only
        # acceptable answers are "no position" and "no".
        c.loc[:, :] = -c
    elif name == "constant":
        # Zero volatility everywhere: the degenerate covariance every
        # risk-based optimiser has a branch for and none should crash on.
        c.loc[:, :] = 50.0
    elif name == "identical":
        # Perfect collinearity — a singular matrix, which is where an
        # optimiser that inverts one blows up and loads everything onto
        # whichever pair the estimation error flattered.
        c.loc[:, :] = np.tile(c.iloc[:, [0]].to_numpy(), (1, c.shape[1]))
    elif name == "huge":
        c.loc[:, :] = c * 1e12
    elif name == "tiny":
        c.loc[:, :] = c * 1e-12
    elif name == "infinite":
        c.iloc[100:, ::3] = np.inf
    elif name == "holes":
        rng = np.random.default_rng(3)
        c = c.mask(rng.random(c.shape) < 0.25)
    elif name == "late_listing":
        # Half the panel lists three weeks before the decision, which is
        # the case a momentum rank and a covariance window must decline
        # to score rather than score badly.
        c.iloc[:600, 1::2] = np.nan
    elif name == "short":
        c = c.iloc[:3]
    elif name == "one_row":
        c = c.iloc[:1]
    else:  # pragma: no cover - a typo in the case list
        raise KeyError(name)
    return c


ADVERSARIAL = (
    "all_nan", "zeros", "negative", "constant", "identical", "huge",
    "tiny", "infinite", "holes", "late_listing", "short", "one_row",
)

#: Four books to ask the question from. Holding everything and holding
#: nothing produce different targets in every latching strategy here,
#: and a rule that is long-only from cash but not from a full book is
#: long-only by accident.
BOOKS = (
    ("empty", {}),
    ("fully invested elsewhere", None),
    ("no investable cash", {}),
)


def _admissible(targets, columns: set[str], caps: dict[str, float]) -> None:
    """The account's own facts, asserted on one weight vector.

    Deliberately four separate assertions rather than one composite:
    when this fails, the useful information is WHICH of the four broke,
    and a single `assert ok` would report only that something did.
    """
    for asset, raw in targets.items():
        assert asset in columns, f"targeted {asset!r}, which is not in the panel"
        weight = float(raw)
        assert math.isfinite(weight), f"{asset} weight is {raw!r}"
        assert weight >= -EPS, (
            f"{asset} at {weight:.6f}: this is a long-only cash account and "
            "a short is not a rounding error to be clipped"
        )
        assert weight <= 1.0 + EPS, f"{asset} at {weight:.6f} exceeds NAV"
        ceiling = float(caps.get(asset, 1.0))
        assert weight <= ceiling + EPS, (
            f"{asset} at {weight:.6f} is above the {ceiling:.2f} ceiling the "
            "view published; a strategy that ignores its cap chases a weight "
            "it will never be allowed to hold, every session, forever"
        )
    gross = sum(float(w) for w in targets.values())
    assert gross <= 1.0 + EPS, (
        f"targets sum to {gross:.6f} of NAV. No margin and no leverage: the "
        "residual is cash rather than a borrowing"
    )


# -- what every strategy has to say about itself ------------------------


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_every_strategy_states_a_publication_date(entry: Entry) -> None:
    """A real date, or UNDATED with a reason. Never neither, never both.

    This is the experiment. A row with no date cannot appear in the
    post-publication table, and a row with a fabricated one is worse than
    absent — it carries a decay claim nobody ever made about it.
    """
    if entry.published_on is None:
        assert entry.undated_because.strip(), (
            f"{entry.key} has no publication date and no reason for having "
            "none, which is indistinguishable from having forgotten it"
        )
        assert entry.measurable_from is None
    else:
        assert isinstance(entry.published_on, date)
        assert not entry.undated_because
        assert entry.published_on <= date.today()
        assert entry.published_on >= date(1900, 1, 2)
        assert entry.measurable_from is not None


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_the_registry_and_the_class_agree_about_the_date(entry: Entry) -> None:
    """Double-entry, not duplication. The class is where a reader checks
    the date against the journal; the registry is where the study's table
    takes it from. A disagreement means one was corrected and the other
    shipped."""
    assert getattr(entry.strategy_class, "published_on", None) == entry.published_on


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_every_strategy_can_be_traced_to_a_source(entry: Entry) -> None:
    """Citation, universe, the claim, and where we departed from it.

    `as_published` is the one people forget and the one that matters
    most: an empty departures field claims a faithful replication by
    omission, and every strategy here departs from its source somewhere,
    if only by filling at the next open.
    """
    assert entry.citation.strip()
    assert entry.title.strip()
    assert entry.rationale.strip()
    assert entry.as_published.strip()
    assert entry.universe, "a strategy with no universe holds nothing"
    assert len(set(entry.universe)) == len(entry.universe)


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_a_second_date_is_only_carried_where_it_differs(entry: Entry) -> None:
    """`investable_from` exists because the paper's date and the fund's
    date are not the same fact. Where both are present the vehicle cannot
    predate its own tape, and `measurable_from` is the later of the two —
    the first day a return here is evidence about anything."""
    if entry.investable_from is None:
        assert entry.gap_days is None
        return
    assert entry.listed_on is not None
    assert entry.investable_from >= entry.listed_on
    if entry.published_on is not None:
        assert entry.gap_days == (entry.investable_from - entry.published_on).days
        assert entry.measurable_from == max(entry.published_on, entry.investable_from)


# -- the account's facts, under panels no market produced ---------------


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_weights_stay_long_and_unlevered_on_adversarial_panels(
    entry: Entry,
) -> None:
    """Twelve broken panels by three books, and one contract for all of
    them: admissible weights, or a refusal somebody wrote down.

    The adversarial half is the point. On the well-behaved fixture every
    strategy in the library is obedient, so a bounds test there
    establishes nothing about the day the data is wrong — which is the
    only day the bound is load-bearing.
    """
    for case in ADVERSARIAL:
        close = _mangled(case)
        columns = set(close.columns)
        for label, held in BOOKS:
            caps = {t: 1.0 for t in close.columns}
            weights = (
                {t: 1.0 / len(columns) for t in close.columns}
                if held is None
                else dict(held)
            )
            view = _view(
                close,
                weights=weights,
                caps=caps,
                investable=0.0 if label == "no investable cash" else 0.95,
            )
            try:
                targets = entry.build().targets(view)
            except REFUSALS:
                # Stopping is allowed and is often correct. What is not
                # allowed is continuing with a book this account cannot
                # hold, which is what the branch below checks.
                continue
            _admissible(targets, columns, caps)


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_a_binding_cap_is_honoured_or_refused_but_never_exceeded(
    entry: Entry,
) -> None:
    """A ceiling of three per cent on everything, which binds on every
    rule in the library.

    Two acceptable answers and they are both right. Clamp, and the
    shortfall becomes cash — which is not the published strategy, and the
    classes that do this say so. Or raise, which is what the trend family
    does, because the engine clamps in SILENCE and a capped GEM run would
    otherwise report our forty-per-cent ceiling as Antonacci's record
    with no signal anywhere in the output. What is not acceptable is
    asking for more than the view allows.
    """
    caps = {t: 0.03 for t in CLOSE.columns}
    view = _view(CLOSE, caps=caps)
    try:
        targets = entry.build().targets(view)
    except REFUSALS:
        return
    _admissible(targets, set(CLOSE.columns), caps)


# -- causality ----------------------------------------------------------


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_the_book_at_T_is_unchanged_when_the_panel_stops_at_T(
    entry: Entry, market: MarketData, truncated_market: MarketData
) -> None:
    """Cut the panel after T, run the whole engine again, demand every
    weight and every equity value up to T come back identical.

    Truncation rather than inspection, because inspection cannot see
    this. A rolling window off by one, a `shift(-1)` that should have
    been `shift(1)`, a statistic computed over the whole panel and read
    at the wrong row — each of them produces a plausible strategy and a
    flattering curve, and each of them shows up here as a difference in
    the third decimal place on one date.

    Compared with `equals` rather than a tolerance on purpose. There is
    no arithmetic reason for a single bit to move: the truncated run
    reads the same rows, in the same order, through the same code. A
    difference small enough to need a tolerance is still a difference,
    and the interesting bugs in this class are small.
    """
    full = run_backtest(market, entry.build(), CONFIG)
    part = run_backtest(truncated_market, entry.build(), CONFIG)

    prefix = full.weights.iloc[: CUT + 1]
    assert prefix.shape == part.weights.shape
    assert prefix.equals(part.weights), (
        f"{entry.key}: the book up to {INDEX[CUT].date()} changed when the "
        "panel after that date was deleted, which means something in the "
        f"rule read forward. Largest difference "
        f"{(prefix - part.weights).abs().to_numpy().max():.3e}"
    )
    assert full.equity.iloc[: CUT + 1].equals(part.equity)


# -- end to end ---------------------------------------------------------


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_every_strategy_completes_a_run_through_the_engine(
    entry: Entry, market: MarketData
) -> None:
    """The whole loop, once, and then the account's facts re-checked on
    what actually happened.

    Targets are the strategy's claim; realised weights are the ledger's
    answer, and the two can part company — a position that appreciates
    through its cap is trimmed whatever the strategy wanted, and the T+1
    settlement queue delays every buy. So the bounds are asserted twice,
    here on the outcome, because a strategy can be long-only and a run
    can still end up somewhere it should not.
    """
    result = run_backtest(market, entry.build(), CONFIG)

    assert len(result.equity) == SESSIONS
    assert result.equity.notna().all()
    assert (result.equity > 0.0).all(), "a long-only cash book cannot go to zero"

    weights = result.weights
    assert weights.notna().all().all()
    assert float(weights.to_numpy().min()) >= -EPS
    assert float(weights.sum(axis=1).max()) <= 1.0 + EPS

    # Nothing may be held that the run could not price. A weight on a
    # column the panel never carried is the failure mode that turns a
    # typo into a twenty-year position.
    assert set(weights.columns) == set(market.assets)

    # Every postponement is one of the five the engine enumerates. A
    # reason outside that set means something was logged by a path
    # nobody reads.
    if len(result.postponed):
        reasons = set(result.postponed["reason"])
        known = {
            "turnover_budget", "participation_cap", "settled_cash",
            "no_fill_price", "below_min_trade",
        }
        assert reasons <= known, f"unknown postponement reason(s): {reasons - known}"


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_build_returns_a_fresh_instance_every_time(entry: Entry) -> None:
    """Two builds, two objects, and no shared latch.

    Several of these classes remember things: `BuyAndHold` stops trading
    once deployed, `MonthlyRule` remembers the month it last decided in,
    `FactorStrategy` carries a high-water gross. A registry handing out
    one cached instance would start the second run of a session believing
    it had already bought the book, and that run's opening weeks would
    silently not happen.
    """
    first, second = entry.build(), entry.build()
    assert first is not second
    assert type(first) is entry.strategy_class


# -- the registry's own guarantees --------------------------------------


def test_the_registry_covers_every_strategy_its_modules_list() -> None:
    """The line that makes the parametrisation a guarantee.

    A strategy is added by writing a class and putting it in its module's
    family tuple. If it never reaches the registry it has no publication
    date, no citation check and no test, and every test above skips it
    silently — because they are parametrised over the registry, which has
    never heard of it.
    """
    assert registry.unregistered() == ()


def test_every_registered_class_is_listed_by_its_own_module() -> None:
    """The same check in the other direction.

    `TACTICAL_STRATEGIES` is the one family list this registry keeps
    itself, because `tactical.py` publishes no tuple — so it is the one
    that can go stale, and this is what notices. Checked against the
    module's `__all__`, which is the nearest thing that file has to a
    declaration of what it contains.
    """
    exported = {
        name
        for name in tactical.__all__
        if isinstance(getattr(tactical, name, None), type)
        and getattr(getattr(tactical, name), "key", "")
    }
    registered = {cls.__name__ for cls in registry.TACTICAL_STRATEGIES}
    assert exported == registered, (
        "tactical.py exports a strategy class this registry does not list: "
        f"{sorted(exported ^ registered)}"
    )


def test_keys_are_unique_and_stable() -> None:
    """The key is the join between this library, the run log and the
    study's table. A collision merges two records into one row and
    nothing downstream can tell."""
    keys = registry.keys()
    assert len(keys) == len(set(keys))
    assert len(keys) == len(ENTRIES)
    for entry in ENTRIES:
        assert registry.entry(entry.key) is entry


def test_the_undated_rows_are_the_three_controls() -> None:
    """Pinned by name, because this is the set that must never grow by
    accident. An undated row is excluded from the post-publication table
    by construction, so a strategy that quietly became undated would
    disappear from the study's central result without anything failing.
    """
    undated = {e.key for e in registry.entries(dated=False)}
    assert undated == {
        "spy_buy_and_hold",
        "sixty_forty_monthly",
        "sixty_forty_daily",
    }
    assert len(registry.entries(dated=True)) == len(ENTRIES) - 3
    for entry in registry.entries(dated=False):
        assert entry.undated_because.strip()


@pytest.fixture
def sandbox(monkeypatch: pytest.MonkeyPatch):
    """A copy of the register, so a test may write to it.

    `register` reads the module global by name at call time, so swapping
    the dict swaps the whole register for the duration of one test and
    the library the rest of the suite sees is untouched.
    """
    monkeypatch.setattr(registry, "_ENTRIES", dict(registry._ENTRIES))
    return registry


class _Candidate:
    key = "test_candidate"
    title = "a strategy invented by a test"
    citation = "nobody, nothing, nowhere, never"
    published_on = date(2011, 5, 5)
    universe = ("SPY",)
    rationale = "there is none; this class exists to be refused"
    as_published = "entirely; it is not a replication of anything"


def test_a_strategy_cannot_be_registered_without_a_publication_date(
    sandbox,
) -> None:
    """The single most important line in the registry, asserted as the
    language-level failure it is.

    Not a validation error — a `TypeError` at the call, before any data
    is touched, because `published_on` is keyword-only with no default.
    A default of any kind would let a strategy join the table with a date
    nobody chose, and the result computed from it would be
    indistinguishable from every other row.
    """
    with pytest.raises(TypeError):
        sandbox.register(_Candidate, family="static")  # type: ignore[call-arg]


def test_none_is_not_a_way_to_say_undated(sandbox) -> None:
    """`None` is what an unset attribute already looks like. Saying "this
    has no publication" has to be a thing somebody typed."""
    with pytest.raises(RegistryError, match="UNDATED"):
        sandbox.register(_Candidate, family="static", published_on=None)


def test_undated_demands_a_reason(sandbox) -> None:
    class Anonymous(_Candidate):
        key = "test_anonymous"
        published_on = None

    with pytest.raises(RegistryError, match="no reason"):
        sandbox.register(Anonymous, family="static", published_on=UNDATED)

    entry = sandbox.register(
        Anonymous,
        family="static",
        published_on=UNDATED,
        undated_because="a convention with no author",
    )
    assert entry.published_on is None
    assert entry.measurable_from is None
    assert entry.gap_days is None


@pytest.mark.parametrize("placeholder", [date(1900, 1, 1), date(1970, 1, 1)])
def test_the_module_placeholder_dates_are_refused(
    sandbox, placeholder: date
) -> None:
    """Both strategy-module "not set yet" sentinels.

    A placeholder that reaches a report is worse than a missing field: it
    is a missing field wearing a number, and it sorts to the top of every
    table as the oldest and most established row in the library.
    """

    class Unset(_Candidate):
        key = "test_unset"

    Unset.published_on = placeholder
    with pytest.raises(RegistryError, match="placeholder"):
        sandbox.register(Unset, family="static", published_on=placeholder)


def test_a_date_that_disagrees_with_its_class_is_refused(sandbox) -> None:
    with pytest.raises(RegistryError, match="double-entry"):
        sandbox.register(
            _Candidate, family="static", published_on=date(2011, 5, 6)
        )


def test_a_future_publication_date_is_refused(sandbox) -> None:
    class Tomorrow(_Candidate):
        key = "test_tomorrow"
        published_on = date.today() + timedelta(days=1)

    with pytest.raises(RegistryError, match="future"):
        sandbox.register(
            Tomorrow, family="static", published_on=Tomorrow.published_on
        )


def test_a_duplicate_key_is_refused(sandbox) -> None:
    class Clash(_Candidate):
        key = "spy_buy_and_hold"

    with pytest.raises(RegistryError, match="claim the key"):
        sandbox.register(Clash, family="static", published_on=date(2011, 5, 5))


def test_an_untraceable_strategy_is_refused(sandbox) -> None:
    """No citation means a row nobody can check against a paper, which is
    the one thing a replication study cannot contain."""

    class Untraceable(_Candidate):
        key = "test_untraceable"
        citation = ""

    with pytest.raises(RegistryError, match="citation"):
        sandbox.register(
            Untraceable, family="static", published_on=date(2011, 5, 5)
        )


def test_a_strategy_with_no_stated_departures_is_refused(sandbox) -> None:
    """An empty `as_published` claims a faithful replication by omission.
    Every strategy in this library departs from its source somewhere, if
    only by filling at the next open."""

    class Silent(_Candidate):
        key = "test_silent"
        as_published = ""

    with pytest.raises(RegistryError, match="as_published"):
        sandbox.register(Silent, family="static", published_on=date(2011, 5, 5))


def test_an_unknown_family_is_refused(sandbox) -> None:
    with pytest.raises(RegistryError, match="unknown family"):
        sandbox.register(
            _Candidate, family="momentum", published_on=date(2011, 5, 5)
        )


# -- the table ----------------------------------------------------------


def test_the_catalogue_carries_a_row_per_strategy_and_the_dates() -> None:
    frame = registry.catalogue()
    assert len(frame) == len(ENTRIES)
    assert set(frame["key"]) == set(registry.keys())
    assert frame["published_on"].isna().sum() == 3
    assert frame["citation"].str.strip().ne("").all()
    assert frame["as_published"].str.strip().ne("").all()
    # Controls first, then each family in publication order, which is the
    # order the study's argument runs in.
    assert list(frame["family"].unique()) == [
        f for f in registry.FAMILIES if (frame["family"] == f).any()
    ]


def test_the_catalogue_prints_the_signed_gap_between_the_two_dates() -> None:
    """SPHQ is the negative one: the product existed before the paper.

    Not clipped to zero, because that row is the opposite of the decay
    story this study is looking for and losing its sign would make it
    read like every other line.
    """
    frame = registry.catalogue().set_index("key")
    assert int(frame.loc["quality_sphq", "gap_days"]) < 0
    assert int(frame.loc["momentum_mtum", "gap_days"]) > 7000
    assert pd.isna(frame.loc["sixty_forty_daily", "gap_days"])


def test_the_table_renderers_produce_something_a_person_can_read() -> None:
    text = registry.format_table()
    assert text.count("\n") == len(ENTRIES) + 1  # header plus a rule
    assert "UNDATED" in text
    assert "spy_buy_and_hold" in text

    markdown = registry.to_markdown()
    assert markdown.startswith("| key |")
    assert markdown.count("\n") == len(ENTRIES) + 1
    assert "_undated_" in markdown


def test_the_sleeve_capped_column_is_derived_and_not_typed() -> None:
    """Which of a strategy's tickers carry one of THIS fund's ceilings,
    read off `portfolio/sleeves.py` rather than restated here.

    A non-empty answer means a run under a default `BacktestConfig` is
    measuring our risk policy and not the author's rule — which is why
    every run in this file turns the caps off.
    """
    assert set(registry.entry("sixty_forty_monthly").sleeve_capped) == {"SPY", "IEF"}
    assert registry.entry("momentum_mtum").sleeve_capped == ()
    assert "SPY" in registry.entry("antonacci_gem").sleeve_capped


def test_the_panel_a_run_needs_is_derived_from_the_entries() -> None:
    """So a strategy naming a fund nobody has pulled surfaces as a
    sentence rather than as a missing column three thousand sessions into
    a run."""
    wanted = registry.panel_tickers()
    assert wanted == tuple(sorted(set(wanted)))
    for entry in ENTRIES:
        assert set(entry.panel) <= set(wanted)
    # 1/N is the one rule with no named leg: it holds whatever it is
    # handed, so it requires nothing and `absences()` is empty by
    # construction rather than because every fund existed.
    assert registry.entry("equal_weight_universe").panel == ()
