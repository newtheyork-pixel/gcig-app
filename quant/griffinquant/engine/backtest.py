"""One decision a day, taken at a close, filled at the next open.

The distance between those two clauses is the only thing in this file
that can go wrong silently, so it is put in the type rather than in a
comment. A strategy is handed a `MarketView`, and a `MarketView`
contains frames that have already been truncated at session T. There is
no attribute on it that reaches tomorrow, no handle back to the full
panel, and therefore no expression a strategy can write that fills at
the price it decided on. The engine holds the next open and the engine
alone decides what happens to it.

That is the named failure this module exists to refuse. A backtest that
signals and fills on the same close is not slightly optimistic — it
earns the entire close-to-open gap for free, every day, in the
direction of its own signal, and most generously in exactly the fast
markets the strategy is supposed to be tested against.

Four other things are worth knowing before reading the loop.

**Positions are held in total-return units.** A position is `units` of
the `close_adj` series, so its value compounds coupons and dividends
into the mark. This is the sleeves rule restated as arithmetic: over
2004-2026 TLT returned -2.6% on price and +105.8% on total return, so a
sleeve marked at an unadjusted price does not understate the defensive
half of the book, it deletes it. The trade log still reports the real
as-traded share count and the as-traded open price, because that is
what a human reconciles against a broker confirm, and dollars are the
same number in both spaces on the day of the fill. The modelling cost
of the convention is stated once, here: distributions are reinvested
into the same security at the close rather than landing as cash that
has to settle. The account really would receive cash. The error is
small, it flatters slightly — no cash drag on the dividend, no T+1 wait
on it — and pretending otherwise needs a distribution calendar we do
not carry.

**The turnover budget is hard, and it binds on day one.** Five per cent
of NAV a day means a book going from all cash to fully invested takes
about nineteen sessions to get there. That is not a bug to be exempted
away; it is what the constraint says. The ramp is visible in
`result.turnover`, and the strategy sees it through
`view.investable_weight` — which is how `BuyAndHold` knows it has
finished deploying and may stop trading forever.

**Two logs, two different causes.** `result.deferrals` comes from the
ledger and means the cash was not there. `result.postponed` comes from
this file and means the trade was there and the day's budget was not.
Merging them gives one count that reads as one phenomenon and is always
two, and only one of the two is an argument about the account type.

**Nothing here is tuned.** The no-trade band is the one parameter with
any freedom in it, and `BacktestConfig` refuses to run without a
sentence saying where its value came from. A band chosen by watching
what the full sample does with it is a fitted parameter and owes
`metrics.TrialCounter` a row, not a shrug.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from functools import cached_property
from typing import Any, Mapping, Protocol, Sequence

import numpy as np
import pandas as pd

from ..config import UNIVERSE
from ..portfolio.sleeves import SLEEVES, SLEEVE_TICKERS
from .costs import CostModel
from .ledger import DEFAULT_BUFFER_FRACTION, SettlementLedger, is_session

__all__ = [
    "BacktestConfig",
    "BacktestError",
    "BacktestResult",
    "BuyAndHold",
    "MarketData",
    "MarketView",
    "PlannedTrade",
    "Postponement",
    "Strategy",
    "run_backtest",
]


class BacktestError(ValueError):
    """The engine was asked to do something this account cannot do."""


#: Weight arithmetic tolerance. Anything smaller is float residue from
#: summing a hundred positions, not a leverage request.
_W_EPS = 1e-9

#: Dollar tolerance, at the scale where a six-figure balance stops
#: being exact.
_CASH_EPS = 1e-6

#: Sleeve caps come from the sleeves module rather than being restated,
#: and they are indexed BOTH ways — by sleeve key and by vehicle ticker
#: — because a panel may be columned by either, and a cap that quietly
#: fails to match its asset is a cap that does not exist.
_SLEEVE_CAPS: dict[str, float] = {}
for _s in SLEEVES:
    _SLEEVE_CAPS[_s.key] = _s.max_weight
    _SLEEVE_CAPS[_s.ticker] = _s.max_weight

_DEFAULT_SLEEVE_ASSETS: frozenset[str] = frozenset(_SLEEVE_CAPS) | SLEEVE_TICKERS

#: The fewest sessions of observed volume we will take a median of while
#: the rolling window is still filling.
#:
#: Declining to answer is not the cautious choice it looks like. A
#: missing ADV routes the fill to the cost curve's least-liquid anchor,
#: so a strict window bills the opening weeks of every run at a hundred
#: basis points round trip — on SPY, which trades tens of billions a
#: day. The direction is right and the number is off by three orders of
#: magnitude, and it is an artefact of where the sample begins rather
#: than anything about the market.
#:
#: Three is where a median starts being a median. One observation is
#: that print; two is their mean; only at three can a single aberrant
#: index-rebalance day be outvoted by the ordinary ones — which is the
#: entire reason the statistic is a median and not an average. That is a
#: property of the estimator, argued before any result existed, and it
#: is deliberately not a figure that came back well from a sweep. If it
#: ever becomes one it owes the deflated Sharpe a trial.
_MIN_ADV_OBSERVATIONS = 3


# -- the panel ----------------------------------------------------------


@dataclass(frozen=True, eq=False)
class MarketData:
    """Everything the engine may look at, as wide frames on one index.

    Three price frames, because the project's central rule needs three
    and collapsing any two of them is the bug. `close_adj` is the only
    series a return may be computed from. `open_unadj` is the fill.
    `close_unadj` is what a screen or a share count reads, and is also
    what turns an adjusted price back into a real one.

    `dollar_volume` and `daily_volatility` feed the cost model. Both are
    optional, and both are read AS OF THE DECISION SESSION rather than
    the execution session — pricing today's impact with today's volume
    is the same lookahead as filling on the signal's own close, just
    one layer down where nobody looks.
    """

    open_unadj: pd.DataFrame
    close_unadj: pd.DataFrame
    close_adj: pd.DataFrame
    dollar_volume: pd.DataFrame | None = None
    daily_volatility: pd.DataFrame | None = None

    def __post_init__(self) -> None:
        frames = self._named_frames()
        base_name, base = frames[0]

        if not isinstance(base.index, pd.DatetimeIndex):
            raise BacktestError(f"{base_name} must be indexed by date")
        idx = pd.DatetimeIndex(base.index).normalize()
        if not idx.is_monotonic_increasing:
            raise BacktestError("market index must be sorted ascending")
        if idx.has_duplicates:
            n = int(idx.duplicated().sum())
            raise BacktestError(f"market index has {n:,} duplicate session(s)")
        object.__setattr__(self, "open_unadj", _retype(self.open_unadj, idx))

        cols = list(self.open_unadj.columns)
        if not cols:
            raise BacktestError("market panel has no assets")

        for name, frame in frames[1:]:
            if frame is None:
                continue
            other = pd.DatetimeIndex(frame.index).normalize()
            if not other.equals(idx):
                raise BacktestError(
                    f"{name} is on a different calendar from open_unadj. The "
                    "engine aligns nothing for you on purpose: a reindex here "
                    "would fabricate a bar."
                )
            if list(frame.columns) != cols:
                # Reindexing quietly would hand a held name a column of
                # NaN and mark it at its last good price forever.
                raise BacktestError(
                    f"{name} carries different assets from open_unadj: "
                    f"{sorted(set(cols) ^ set(frame.columns))}"
                )
            object.__setattr__(self, name, _retype(frame, idx))

    def _named_frames(self) -> list[tuple[str, pd.DataFrame | None]]:
        return [
            ("open_unadj", self.open_unadj),
            ("close_unadj", self.close_unadj),
            ("close_adj", self.close_adj),
            ("dollar_volume", self.dollar_volume),
            ("daily_volatility", self.daily_volatility),
        ]

    @property
    def index(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.open_unadj.index)

    @property
    def assets(self) -> tuple[str, ...]:
        return tuple(str(c) for c in self.open_unadj.columns)

    @cached_property
    def adjustment_factor(self) -> pd.DataFrame:
        """`close_adj / close_unadj` — the bridge between the two spaces.

        Real shares held equals total-return units times this. It rises
        through time as distributions accrue, and that rise IS the
        reinvestment: the position quietly owns more shares than it
        bought, which is the whole of the coupon return the
        fixed-income sleeves exist to collect.
        """
        return self.close_adj / self.close_unadj.where(self.close_unadj > 0)

    @cached_property
    def open_tr(self) -> pd.DataFrame:
        """The open in total-return space, so a fill and a mark are
        denominated in the same units.

        The day's own factor is the right one for the day's open: an
        adjustment applies to every price strictly before its ex-date,
        so the open and the close of one session always carry the same
        factor. Using yesterday's would post a dividend into the
        intraday P&L of its ex-date.
        """
        return self.open_unadj * self.adjustment_factor

    @classmethod
    def from_prices(
        cls,
        prices: pd.DataFrame,
        *,
        key: str = "ticker",
        dollar_volume_window: int = UNIVERSE.dollar_volume_window,
        volatility_window: int = 63,
    ) -> MarketData:
        """Pivot the long `schema.PRICES` frame into the engine's shape.

        `key` defaults to `ticker` for readability, and the duplicate
        check below is the only reason that is safe to offer. Two
        entities can share a symbol across time — GM, CC, WB — and a
        pivot on a recycled ticker grafts a dead company's history onto
        a living one's, which backtests beautifully. Pivot a
        single-name universe on `permaticker`; `ticker` is fine for a
        sleeve panel, and the check says so loudly when it is not.

        The rolling statistics are computed over the whole panel here
        and READ at the decision session inside the loop. Computing
        them here is not the lookahead; reading them on the execution
        day would be.

        Dollar volume answers from the first `_MIN_ADV_OBSERVATIONS`
        sessions, expanding until the window fills and strict
        afterwards. Silence at the start of a sample is not neutral —
        it is a hundred basis points round trip — and the note on that
        constant says why three is the floor.
        """
        need = ["date", key, "open_unadj", "close_unadj", "close_adj"]
        missing = [c for c in need if c not in prices.columns]
        if missing:
            raise BacktestError(
                f"price frame is missing {missing}; got {sorted(prices.columns)}"
            )

        dupes = int(prices.duplicated(subset=["date", key]).sum())
        if dupes:
            raise BacktestError(
                f"{dupes:,} duplicate ({key}, date) row(s). If the key is a "
                "ticker this is the recycled-symbol trap — two entities "
                "sharing a symbol — and the pivot would splice one company's "
                "price history onto another's. Pivot on permaticker."
            )

        def wide(col: str) -> pd.DataFrame:
            return prices.pivot(index="date", columns=key, values=col).sort_index()

        open_unadj = wide("open_unadj")
        close_unadj = wide("close_unadj")
        close_adj = wide("close_adj")

        dv = None
        if "volume_unadj" in prices.columns:
            # Median, not mean: one index-rebalance print otherwise
            # certifies a name as liquid on the nineteen days it was not.
            dollars = close_unadj * wide("volume_unadj")
            dv = dollars.rolling(
                dollar_volume_window,
                min_periods=max(5, dollar_volume_window // 2),
            ).median()

            # Until the window has had the chance to fill there is
            # nothing yet to be strict about, so the leading rows take an
            # EXPANDING median of whatever has been seen. Refusing to
            # answer there is not the conservative choice it reads as: a
            # missing ADV is charged at the cost curve's least-liquid
            # anchor, so a strict window opens every run by billing a
            # hundred basis points round trip to whatever it is holding,
            # and the turnover budget deploys a book in about nineteen
            # sessions — which means under the old rule a buy-and-hold
            # run could finish deploying without once pricing a fill off
            # its own liquidity.
            #
            # Only the leading rows are relaxed, and the distinction is
            # the whole point. A window that is short because a name's
            # volume went missing in year three is not a warm-up; we know
            # no more about it than we did before, it keeps the strict
            # rule and it keeps the pessimistic default. Loosening both
            # cases together would make every trade in the sample a
            # little cheaper, which is the one thing a change to a cost
            # model must never do quietly.
            head = max(dollar_volume_window - 1, 0)
            if head:
                warm = dollars.iloc[:head].expanding(
                    min_periods=_MIN_ADV_OBSERVATIONS
                ).median()
                dv.iloc[:head] = dv.iloc[:head].fillna(warm)

        vol = close_adj.pct_change().rolling(
            volatility_window, min_periods=max(20, volatility_window // 3)
        ).std(ddof=1)

        return cls(
            open_unadj=open_unadj,
            close_unadj=close_unadj,
            close_adj=close_adj,
            dollar_volume=dv,
            daily_volatility=vol,
        )


def _retype(frame: pd.DataFrame, idx: pd.DatetimeIndex) -> pd.DataFrame:
    out = frame.astype("float64")
    out.index = idx
    return out


# -- what a strategy is allowed to see ----------------------------------


@dataclass(frozen=True, eq=False)
class MarketView:
    """History strictly up to and including the close of `asof`.

    Every frame on this object has already been cut. That is the
    enforcement, not a convention: a strategy cannot look at tomorrow
    because tomorrow is not in the object it was handed, and no amount
    of editing the strategy changes that. The engine keeps the next
    open to itself.

    The portfolio fields describe the book at this close, which the
    strategy is entitled to know — it is deciding a change to it.
    `investable_weight` is the fraction of NAV that settled cash could
    actually fund today after the buffer, and it is the honest answer
    to "can I buy anything right now"; a strategy that ignores it will
    simply watch its orders deferred.

    `no_trade_band` and `caps` are on here for the same reason. Both
    are engine configuration rather than market data, so telling the
    strategy leaks nothing — and withholding either one produces the
    same specific failure. A strategy that cannot see the band cannot
    tell a target the engine reached from a target the engine declined
    to chase. A strategy that cannot see its own ceiling will chase a
    weight it is never going to be allowed to hold, every day, forever.
    """

    asof: pd.Timestamp
    open_unadj: pd.DataFrame
    close_unadj: pd.DataFrame
    close_adj: pd.DataFrame
    dollar_volume: pd.DataFrame | None
    daily_volatility: pd.DataFrame | None
    weights: Mapping[str, float]
    nav: float
    cash_weight: float
    investable_weight: float
    no_trade_band: float
    caps: Mapping[str, float]

    @property
    def assets(self) -> tuple[str, ...]:
        return tuple(str(c) for c in self.close_adj.columns)

    @property
    def sessions(self) -> int:
        return int(len(self.close_adj))

    def latest(self, frame: str = "close_adj") -> pd.Series:
        """The last row of one frame — the close of `asof`."""
        f = getattr(self, frame, None)
        if not isinstance(f, pd.DataFrame):
            raise BacktestError(f"no frame named {frame!r} on this view")
        return f.iloc[-1]


class Strategy(Protocol):
    """Turn history into a book, and never see the fill.

    `targets` returns a COMPLETE statement of the desired book, as
    weights of NAV. An asset left out of the mapping is a target of
    zero, not "leave that one alone" — the other reading means a
    strategy that forgets a name holds it forever, and does so
    invisibly.

    Two optional attributes the engine reads if they exist: `name`, for
    the result label, and `warmup`, the number of sessions of history
    to bank before the first decision is asked for.
    """

    def targets(self, view: MarketView) -> Mapping[str, float]: ...


class BuyAndHold:
    """Buy the target book once, then leave it entirely alone.

    The latch is the whole content of this class, and it is the
    difference between buy-and-hold and constant-mix. A strategy that
    returns the same fixed weights every day gets rebalanced back to
    them every day, which harvests a rebalancing premium and pays a
    rebalancing cost that a genuine buy-and-hold investor saw neither
    side of. So once the book is deployed this returns the LIVE
    weights, which asks for no trade at all, and it never un-latches.

    Deployment does not finish on day one. The turnover budget moves
    five per cent of NAV a day, so a fully invested target takes about
    nineteen sessions to reach — and the ledger's buffer means a target
    summing to 1.0 is never reachable at all. Hence two exit
    conditions: every weight arrived, or there is no investable cash
    left to arrive with.

    Deployment is judged on whether the money went in, not on whether
    the mix is exact, and that distinction is what makes the latch
    fire at all. Weights drift every day; a latch waiting for all of
    them to sit within a tolerance of their targets at the same
    instant waits for a coincidence, and rebalances daily until the
    coincidence turns up — which is the constant-mix strategy again,
    arrived at by accident this time.

    Even latched, this is not guaranteed to place no further trades. A
    cap is a ceiling on the BOOK, not on the purchase, so a position
    that appreciates through its cap is trimmed back to it whatever the
    strategy wanted. That is the cap working. It does mean the trivial
    validation case should be given targets that sit comfortably inside
    their caps, or the control will quietly acquire a rebalancing rule
    nobody asked it to have.
    """

    def __init__(
        self,
        weights: Mapping[str, float],
        *,
        name: str = "buy and hold",
        deploy_tolerance: float = 0.0025,
    ) -> None:
        if not weights:
            raise BacktestError("buy-and-hold needs at least one target weight")
        self.target = {str(k): float(v) for k, v in weights.items()}
        self.name = name
        self.deploy_tolerance = float(deploy_tolerance)
        self._latched = False
        self._last_invested: float | None = None

    @property
    def deployed(self) -> bool:
        return self._latched

    def targets(self, view: MarketView) -> Mapping[str, float]:
        if self._latched:
            return dict(view.weights)

        tol = max(self.deploy_tolerance, view.no_trade_band)
        reachable = {
            a: min(w, float(view.caps.get(a, 1.0))) for a, w in self.target.items()
        }
        invested = float(sum(view.weights.values()))
        wanted = float(sum(reachable.values()))

        # Three ways deployment can be over. The first is the ordinary
        # one and the second is the buffer. The third is the one that
        # earns its keep: a target can be unreachable for a reason
        # neither of the others can see — a name with no price, a
        # budget that never frees up — and then the book sits short of
        # `wanted` with investable cash still on hand, and a latch
        # waiting on either of the first two never fires at all. Not
        # having moved is the general form of having finished.
        stalled = (
            self._last_invested is not None
            and invested > tol
            and invested <= self._last_invested + tol
        )
        self._last_invested = invested

        if invested >= wanted - tol or view.investable_weight <= tol or stalled:
            self._latched = True
            return dict(view.weights)

        return reachable


# -- configuration ------------------------------------------------------


@dataclass(frozen=True)
class BacktestConfig:
    """The account's facts, and the one parameter with freedom in it."""

    starting_cash: float = 131_000.0

    #: Five per cent of NAV a day, hard. Not a soft preference the
    #: process may borrow against on a busy morning: the whole reason to
    #: state a turnover limit is that the days it binds are the days a
    #: strategy most wants to trade, which are the days a real account
    #: is least able to. A run at another figure is a different
    #: strategy and has to be labelled as one.
    max_daily_turnover: float = 0.05

    #: Drift, in weight of NAV, below which a position is left alone.
    #: Half a per cent of a $131K book is about $655 — small enough that
    #: the position is still where it was meant to be, large enough that
    #: the book is not paying a spread to move forty dollars.
    no_trade_band: float = 0.005

    #: Where the band's value came from, in a sentence. Required, and
    #: not decoration: the band is the only dial in this engine, and a
    #: dial turned while watching an equity curve is a fitted parameter
    #: that owes the deflated Sharpe a trial. Say "tuned on the training
    #: window 2005-2018", or say it was never tuned — but say something.
    band_provenance: str = (
        "not tuned; a round prior fixed before any result existed, on the "
        "reasoning that a band should be a small multiple of the round-trip "
        "spread and nothing more"
    )

    #: Per-asset weight ceilings. Sleeve caps arrive automatically from
    #: the sleeves module; anything here overrides them.
    caps: Mapping[str, float] = field(default_factory=dict)

    #: The ceiling for an asset nobody has capped. One is deliberately
    #: NOT a cap: the single-name sizing layer owns that ceiling, and
    #: inventing one in the plumbing would bury a risk decision
    #: somewhere nobody would think to look for it.
    default_max_weight: float = 1.0
    apply_sleeve_caps: bool = True

    buffer_fraction: float = DEFAULT_BUFFER_FRACTION
    settlement_cycle: int = 1

    #: A cash account places whole shares. The holding drifts fractional
    #: afterwards because distributions are modelled as reinvested; that
    #: is an artefact of the total-return convention, not an odd lot
    #: anybody has to clean up.
    whole_shares: bool = True

    #: Below this, a trade is not worth its own ticket.
    min_trade_notional: float = 100.0

    #: One day's order may not exceed this share of the name's own
    #: median daily dollar volume — the same cap the universe rules size
    #: to, applied again at the one moment the dollar figure is finally
    #: known. Enforced ONLY where a real ADV is on hand: a cost model
    #: must be pessimistic about what it does not know, but a constraint
    #: that blocks trades on the strength of a missing column is
    #: reporting our data gap as a fact about the market.
    max_participation: float | None = UNIVERSE.max_participation_of_adv

    cost_model: CostModel = field(default_factory=CostModel)

    #: Sessions of history to bank before the first decision.
    warmup: int = 0

    #: Which assets are sleeves, and therefore first in the queue when
    #: the turnover budget will not cover everything. Defaults to the
    #: sleeve keys and their vehicle tickers.
    sleeve_assets: frozenset[str] | None = None

    def __post_init__(self) -> None:
        if not (0.0 < self.max_daily_turnover <= 1.0):
            raise BacktestError(
                f"max_daily_turnover {self.max_daily_turnover} must be in "
                "(0, 1]; a budget above 100% of NAV a day is not a budget"
            )
        if self.no_trade_band < 0.0:
            raise BacktestError("no_trade_band cannot be negative")
        if not self.band_provenance.strip():
            raise BacktestError(
                "band_provenance is empty. The no-trade band is the only "
                "tunable number in this engine, and an unexplained value is "
                "indistinguishable from one fitted on the test set."
            )
        if self.starting_cash <= 0.0:
            raise BacktestError("starting_cash must be positive")
        if not (0.0 < self.default_max_weight <= 1.0):
            raise BacktestError("default_max_weight must be in (0, 1]")
        for asset, cap in self.caps.items():
            if not (0.0 < float(cap) <= 1.0):
                raise BacktestError(f"cap on {asset!r} must be in (0, 1], got {cap}")
        if self.max_participation is not None and self.max_participation <= 0.0:
            raise BacktestError("max_participation must be positive or None")

    def cap_for(self, asset: str) -> float:
        if asset in self.caps:
            return float(self.caps[asset])
        if self.apply_sleeve_caps and asset in _SLEEVE_CAPS:
            return _SLEEVE_CAPS[asset]
        return float(self.default_max_weight)


# -- the plan, and the reasons it does not all happen -------------------


@dataclass(frozen=True)
class PlannedTrade:
    """A change to one position, decided at a close and unexecuted.

    Carries the weights it was decided against rather than only the
    delta, because the delta is re-derived at tomorrow's open against
    tomorrow's NAV and the two will not agree. Which of them was right
    is a question somebody eventually asks.
    """

    asset: str
    target_weight: float
    weight_at_decision: float
    drift: float
    is_sleeve: bool
    full_exit: bool

    @property
    def side(self) -> str:
        return "sell" if self.drift < 0 else "buy"


class Postponement(Enum):
    """Why a planned trade did not fully happen.

    Distinct from the ledger's `DeferralReason`, and the split is the
    point. SETTLED_CASH is the account type charging rent, and is
    written to the ledger's deferral log as well as here.
    TURNOVER_BUDGET is our own constraint refusing churn.
    PARTICIPATION_CAP is the market's depth. NO_FILL_PRICE is a hole in
    the data wearing none of those three costumes, and a run where it
    is common has a data problem rather than a trading one.
    BELOW_MIN_TRADE covers both floors on order size: the dollar
    minimum, and the harder one — a whole share of the thing costs more
    than the whole trade was worth.
    """

    TURNOVER_BUDGET = "turnover_budget"
    PARTICIPATION_CAP = "participation_cap"
    SETTLED_CASH = "settled_cash"
    NO_FILL_PRICE = "no_fill_price"
    BELOW_MIN_TRADE = "below_min_trade"


_TRADE_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "decision_date": "datetime64[ns]",
    "ticker": "str",
    "side": "str",
    "shares": "float64",
    "price": "float64",
    "notional": "float64",
    "spread_cost": "float64",
    "impact_cost": "float64",
    # The total travels WITH the two components on purpose.
    # `metrics.trading_costs` looks for a total column first and only
    # then falls back to summing components it recognises by name — and
    # "impact_cost" is not one of the names it knows. Shipping the
    # breakdown without the total would have quietly reported the
    # spread as the entire cost of trading.
    "cost": "float64",
    "participation": "float64",
    "is_sleeve": "bool",
    "target_weight": "float64",
    "filled_fraction": "float64",
}

_POSTPONED_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "decision_date": "datetime64[ns]",
    "ticker": "str",
    "side": "str",
    "reason": "str",
    "desired_notional": "float64",
    "executed_notional": "float64",
    "postponed_notional": "float64",
    "is_sleeve": "bool",
    "budget": "float64",
    "budget_used": "float64",
}

_DAILY_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "nav_open": "float64",
    "nav": "float64",
    "settled": "float64",
    "unsettled": "float64",
    "market_value": "float64",
    "invested_weight": "float64",
    "cash_weight": "float64",
    "traded": "float64",
    "sleeve_traded": "float64",
    "turnover": "float64",
    "budget": "float64",
    "budget_binding": "bool",
    "cost": "float64",
    "n_trades": "int64",
    "n_postponed": "int64",
    "n_deferrals": "int64",
    "n_banded": "int64",
}

_STALE_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "ticker": "str",
    "carried_from": "datetime64[ns]",
    "mark": "float64",
}

_POSITION_COLUMNS: dict[str, str] = {
    "ticker": "str",
    "units": "float64",
    "shares": "float64",
    "mark": "float64",
    "market_value": "float64",
}


def _frame(rows: list[dict[str, Any]], cols: dict[str, str]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
    return pd.DataFrame(rows)[list(cols)].astype(cols)


# -- the result ---------------------------------------------------------


@dataclass(frozen=True, eq=False)
class BacktestResult:
    """Everything the run knew, so nothing downstream has to guess.

    The rule this obeys: a reporting layer must never recompute a
    quantity the engine already had in its hand. Turnover cannot be
    rebuilt from the trade log without the NAV the budget was measured
    against; the difference between a cash deferral and a budget
    postponement cannot be rebuilt at all once the run is over. Both
    are here, and so is the reason a mark was ever carried forward.
    """

    strategy: str
    config: BacktestConfig
    equity: pd.Series
    weights: pd.DataFrame
    trades: pd.DataFrame
    postponed: pd.DataFrame
    deferrals: pd.DataFrame
    daily: pd.DataFrame
    stale_marks: pd.DataFrame
    final_positions: pd.DataFrame
    pending_settlement: pd.DataFrame
    ledger: SettlementLedger

    @property
    def turnover(self) -> pd.Series:
        """Traded notional over NAV, per session."""
        s = self.daily.set_index("date")["turnover"].astype("float64")
        s.name = "turnover"
        return s

    @property
    def total_cost(self) -> float:
        return float(self.trades["cost"].sum()) if len(self.trades) else 0.0

    @property
    def cost_breakdown(self) -> dict[str, float]:
        """Spread and impact kept apart, for the reason `costs.py` gives:
        they are different arguments and one total makes the model
        unfalsifiable exactly when it most needs testing."""
        if not len(self.trades):
            return {"spread": 0.0, "impact": 0.0, "total": 0.0}
        return {
            "spread": float(self.trades["spread_cost"].sum()),
            "impact": float(self.trades["impact_cost"].sum()),
            "total": float(self.trades["cost"].sum()),
        }

    def summary(self) -> pd.DataFrame:
        """One typed row, so runs stack and compare."""
        eq = self.equity
        avg_nav = float(eq.mean()) if len(eq) else float("nan")
        costs = self.cost_breakdown
        row = {
            "strategy": self.strategy,
            "start": eq.index[0] if len(eq) else pd.NaT,
            "end": eq.index[-1] if len(eq) else pd.NaT,
            "sessions": int(len(eq)),
            "starting_nav": float(self.config.starting_cash),
            "ending_nav": float(eq.iloc[-1]) if len(eq) else float("nan"),
            "total_return": (
                float(eq.iloc[-1] / eq.iloc[0] - 1.0) if len(eq) > 1 else float("nan")
            ),
            "traded_notional": float(self.daily["traded"].sum()),
            "mean_daily_turnover": float(self.daily["turnover"].mean()),
            "max_daily_turnover": float(self.daily["turnover"].max()),
            "budget_binding_days": int(self.daily["budget_binding"].sum()),
            "n_trades": int(len(self.trades)),
            "n_postponed": int(len(self.postponed)),
            "n_deferrals": int(len(self.deferrals)),
            "spread_cost": costs["spread"],
            "impact_cost": costs["impact"],
            "total_cost": costs["total"],
            "cost_drag_bps_of_avg_nav": (
                costs["total"] / avg_nav * 1e4
                if avg_nav and avg_nav > 0
                else float("nan")
            ),
            "cost_multiple": float(self.config.cost_model.multiple),
            "stale_marks": int(len(self.stale_marks)),
            "band_provenance": self.config.band_provenance,
        }
        return pd.DataFrame([row])

    def performance(self, **kwargs: Any):
        """Hand the run to `metrics.evaluate`.

        Imported inside the method so the engine can be run by
        something that does not want the measurement layer, and so the
        two files can never close a cycle.
        """
        from . import metrics

        return metrics.evaluate(self.equity, trades=self.trades, **kwargs)


# -- the loop -----------------------------------------------------------


def run_backtest(
    market: MarketData,
    strategy: Strategy,
    config: BacktestConfig | None = None,
) -> BacktestResult:
    """Walk the sessions once, deciding at closes and filling at opens.

    The body below is deliberately a plain loop with the four steps of a
    day written out in order. Somebody will read this at two in the
    morning because a number looks wrong, and the first thing they have
    to be able to see is that the decision taken at the bottom of one
    iteration is filled at the top of the NEXT one. Vectorising that
    away would buy a few seconds and cost the only property of this
    file that matters.
    """
    config = config or BacktestConfig()
    sessions = market.index
    if len(sessions) < 2:
        raise BacktestError("a backtest needs at least two sessions")
    _require_nyse_sessions(sessions)

    assets = list(market.assets)
    pos = {a: j for j, a in enumerate(assets)}
    sleeves = (
        _DEFAULT_SLEEVE_ASSETS if config.sleeve_assets is None else config.sleeve_assets
    )
    is_sleeve = {a: a in sleeves for a in assets}
    caps = {a: config.cap_for(a) for a in assets}

    # The engine's own fast path over the same numbers the view serves.
    # The frames stay authoritative; these are float indexing and
    # nothing else.
    px_open_unadj = market.open_unadj.to_numpy(dtype="float64")
    px_close_unadj = market.close_unadj.to_numpy(dtype="float64")
    px_close_adj = market.close_adj.to_numpy(dtype="float64")
    px_open_tr = market.open_tr.to_numpy(dtype="float64")
    adv = (
        market.dollar_volume.to_numpy(dtype="float64")
        if market.dollar_volume is not None
        else None
    )
    vol = (
        market.daily_volatility.to_numpy(dtype="float64")
        if market.daily_volatility is not None
        else None
    )

    ledger = SettlementLedger(
        config.starting_cash,
        buffer_fraction=config.buffer_fraction,
        settlement_cycle=config.settlement_cycle,
    )
    units: dict[str, float] = {a: 0.0 for a in assets}
    marks: dict[str, float] = {}
    mark_dates: dict[str, pd.Timestamp] = {}

    trades: list[dict[str, Any]] = []
    postponed: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    daily: list[dict[str, Any]] = []
    equity: list[float] = []
    weight_rows: list[np.ndarray] = []

    plan: tuple[PlannedTrade, ...] = ()
    decision_date: pd.Timestamp | None = None
    warmup = max(int(config.warmup), int(getattr(strategy, "warmup", 0) or 0))
    deferrals_seen = 0
    nav_prev = float(config.starting_cash)

    for i, session in enumerate(sessions):
        # 1. Yesterday's sales become money, if they have matured. This
        #    must precede any funding call — the ledger refuses to
        #    deliberate on a day whose receivables are still stranded,
        #    because every deferral it logged would be fictional.
        ledger.settle(session)

        # 2. Fill yesterday's decision at TODAY'S open. Nothing below
        #    this point knew today's open; nothing above it may consult
        #    today's close.
        units_before = dict(units)
        open_prices = {
            a: (
                float(px_open_tr[i, pos[a]])
                if np.isfinite(px_open_tr[i, pos[a]])
                else marks.get(a, float("nan"))
            )
            for a, u in units.items()
            if u != 0.0
        }
        nav_open = ledger.total_cash + _value(units, open_prices)

        day = _execute(
            plan=plan,
            decision_date=decision_date,
            session=session,
            i=i,
            nav_open=nav_open,
            units=units,
            pos=pos,
            px_open_unadj=px_open_unadj,
            px_close_unadj=px_close_unadj,
            px_open_tr=px_open_tr,
            adv=adv,
            vol=vol,
            ledger=ledger,
            config=config,
            trades=trades,
            postponed=postponed,
        )

        # 3. Mark to today's close, in total-return space.
        mv_at_prior_marks = _value(units_before, marks)
        for a in assets:
            p = float(px_close_adj[i, pos[a]])
            if np.isfinite(p) and p > 0.0:
                marks[a] = p
                mark_dates[a] = session
            elif units[a] != 0.0 and a in marks:
                # Carrying the last good mark, and saying so. Silently
                # forward-filling a held position's price is how a
                # delisting becomes a flat line instead of a loss.
                stale.append(
                    {
                        "date": session,
                        "ticker": a,
                        "carried_from": mark_dates.get(a, pd.NaT),
                        "mark": marks[a],
                    }
                )

        # The P&L walk, kept independent of the cash books so that
        # `check_invariant` is a reconciliation rather than a
        # tautology. Defining NAV as cash plus market value and then
        # checking that cash plus market value equals NAV catches
        # precisely nothing. This instead says: the day's change in NAV
        # is the positions' move plus the fills' move from their fill
        # price to the close, less what the trading cost — and if the
        # ledger debited a notional without its cost, or lost a sale's
        # proceeds, the two answers part company here.
        pnl = _value(units_before, marks) - mv_at_prior_marks
        for asset, delta_units, fill_price in day.fills:
            pnl += delta_units * (marks.get(asset, fill_price) - fill_price)
        expected_nav = nav_prev + pnl - day.cost

        market_value = _value(units, marks)
        ledger.check_invariant(
            market_value, expected_nav, where=f"close of {session.date()}"
        )
        nav = ledger.total_cash + market_value
        nav_prev = nav

        equity.append(nav)
        weight_rows.append(
            np.array(
                [
                    units[a] * marks.get(a, 0.0) / nav if nav > 0 else 0.0
                    for a in assets
                ],
                dtype="float64",
            )
        )

        new_deferrals = len(ledger.deferrals) - deferrals_seen
        deferrals_seen = len(ledger.deferrals)
        row = {
            "date": session,
            "nav_open": nav_open,
            "nav": nav,
            "settled": ledger.settled,
            "unsettled": ledger.unsettled,
            "market_value": market_value,
            "invested_weight": market_value / nav if nav > 0 else float("nan"),
            "cash_weight": ledger.total_cash / nav if nav > 0 else float("nan"),
            "traded": day.traded,
            "sleeve_traded": day.sleeve_traded,
            "turnover": day.traded / nav_open if nav_open > 0 else float("nan"),
            "budget": day.budget,
            "budget_binding": day.budget_binding,
            "cost": day.cost,
            "n_trades": day.n_trades,
            "n_postponed": day.n_postponed,
            "n_deferrals": new_deferrals,
            "n_banded": 0,
        }

        # 4. Decide, from what is known at THIS close, for tomorrow's
        #    open. The last session gets no decision, because it has no
        #    tomorrow inside the sample and manufacturing one would put
        #    a trade in the log that never had a fill.
        if i >= warmup and i < len(sessions) - 1:
            view = MarketView(
                asof=session,
                open_unadj=market.open_unadj.iloc[: i + 1],
                close_unadj=market.close_unadj.iloc[: i + 1],
                close_adj=market.close_adj.iloc[: i + 1],
                dollar_volume=(
                    None
                    if market.dollar_volume is None
                    else market.dollar_volume.iloc[: i + 1]
                ),
                daily_volatility=(
                    None
                    if market.daily_volatility is None
                    else market.daily_volatility.iloc[: i + 1]
                ),
                weights={a: float(w) for a, w in zip(assets, weight_rows[-1])},
                nav=nav,
                cash_weight=ledger.total_cash / nav if nav > 0 else 0.0,
                investable_weight=(
                    ledger.available_to_buy(nav) / nav if nav > 0 else 0.0
                ),
                no_trade_band=config.no_trade_band,
                caps=caps,
            )
            plan, row["n_banded"] = _decide(
                strategy.targets(view), view, config, is_sleeve
            )
            decision_date = session
        else:
            plan, decision_date = (), None

        daily.append(row)

    idx = pd.DatetimeIndex(sessions, name="date")
    return BacktestResult(
        strategy=str(getattr(strategy, "name", type(strategy).__name__)),
        config=config,
        equity=pd.Series(equity, index=idx, dtype="float64", name="nav"),
        weights=pd.DataFrame(
            np.vstack(weight_rows), index=idx, columns=assets, dtype="float64"
        ),
        trades=_frame(trades, _TRADE_COLUMNS),
        postponed=_frame(postponed, _POSTPONED_COLUMNS),
        deferrals=ledger.deferrals_frame(),
        daily=_frame(daily, _DAILY_COLUMNS),
        stale_marks=_frame(stale, _STALE_COLUMNS),
        final_positions=_positions_frame(assets, units, marks, market),
        pending_settlement=ledger.pending(),
        ledger=ledger,
    )


# -- deciding -----------------------------------------------------------


def _decide(
    targets: Mapping[str, float],
    view: MarketView,
    config: BacktestConfig,
    is_sleeve: Mapping[str, bool],
) -> tuple[tuple[PlannedTrade, ...], int]:
    """Clamp, check, band, and queue. No price is touched here.

    Two of the three account-level facts RAISE rather than clamp. A
    negative target is a short request and a gross above one is a
    margin request; neither is a rounding problem, and quietly fixing
    either would let a strategy run for twenty years against a
    constraint it never actually obeyed.
    """
    assets = view.assets
    known = set(assets)
    cleaned: dict[str, float] = {}

    for raw_asset, raw_weight in targets.items():
        asset = str(raw_asset)
        if asset not in known:
            raise BacktestError(
                f"strategy asked for {asset!r}, which is not in the panel. "
                f"Known assets: {sorted(known)}"
            )
        w = float(raw_weight)
        if not math.isfinite(w):
            raise BacktestError(f"target weight for {asset!r} is {raw_weight!r}")
        if w < -_W_EPS:
            raise BacktestError(
                f"target weight {w:.6f} on {asset!r} is negative. This is a "
                "long-only cash account: the minimum weight on any position "
                "is zero, and a short is not a small mistake to be clipped."
            )
        cleaned[asset] = min(max(w, 0.0), config.cap_for(asset))

    # Second line of defence, in the ledger's spirit: the clamp above is
    # the real one, and this is what fails if somebody rewrites it.
    assert all(
        -_W_EPS <= w <= config.cap_for(a) + _W_EPS for a, w in cleaned.items()
    ), "a target weight escaped the [0, cap] clamp"

    gross = float(sum(cleaned.values()))
    if gross > 1.0 + _W_EPS:
        raise BacktestError(
            f"targets sum to {gross:.6f} of NAV. No margin, no leverage: "
            "gross exposure never exceeds 100% of NAV, and the residual is "
            "cash rather than a borrowing."
        )
    assert gross <= 1.0 + _W_EPS, "gross exposure exceeded NAV"

    plan: list[PlannedTrade] = []
    banded = 0
    for asset in assets:
        # Absent from the mapping means zero — see the note on the
        # Strategy protocol. The other reading makes a forgotten name
        # permanent and invisible.
        target = cleaned.get(asset, 0.0)
        current = float(view.weights.get(asset, 0.0))
        drift = target - current
        full_exit = target <= 0.0 and current > 0.0

        # A full exit ignores the band on purpose. A position the
        # process has decided against should leave, not linger under a
        # threshold for years because it happens to be small.
        #
        # The floor under the band is not a nicety. With the band set
        # to zero — a validation run, a sensitivity sweep — a drift of
        # exactly zero is not less than zero, so every asset enters the
        # plan, and the plan is then priced against TOMORROW's NAV,
        # which has moved. A strategy asking for the book it already
        # holds would trade the whole book, every day, forever.
        if not full_exit and abs(drift) < max(config.no_trade_band, _W_EPS):
            if abs(drift) > _W_EPS:
                banded += 1
            continue

        plan.append(
            PlannedTrade(
                asset=asset,
                target_weight=target,
                weight_at_decision=current,
                drift=drift,
                is_sleeve=bool(is_sleeve.get(asset, False)),
                full_exit=full_exit,
            )
        )

    # Sells before buys, then sleeves, then the largest deviation.
    #
    # The first key buys no money and is not meant to. A rotation is one
    # decision — sell this, buy that — and T+1 makes the buy wait a day
    # whichever order the two are planned in. What the order changes is
    # the WORD the ledger reaches for. Plan the buy first and it meets an
    # empty receivables queue, so the only honest thing the ledger can
    # say is NO_CASH: on the evidence in front of it the account was
    # simply short. Plan the sale first and the same refusal is filed as
    # UNSETTLED, because the proceeds are now visibly in flight. A
    # reader turning to the per-year deferral table to ask what T+1 cost
    # us is asking a question only the second label answers, and the
    # first one quietly tells them the strategy ran out of money. The
    # count was right either way, which is why this survived so long.
    #
    # Sleeves next, and only within a side, because the sleeves ARE the
    # risk control: on a day the budget will not cover everything, the
    # trade that has to survive is the one that moves the book's
    # exposure to an asset class, not the one that tidies a single name.
    # Within a tier the largest deviation first — it is the trade that
    # most reduces the distance between the book we have and the book we
    # decided on.
    #
    # Putting side above sleeve does hand the day's turnover budget to
    # the sells first, and that is the intended reading rather than a
    # side effect: a sale is what pays for tomorrow, so a sale squeezed
    # out of today's budget postpones its buy twice over.
    plan.sort(key=lambda p: (p.side == "buy", not p.is_sleeve, -abs(p.drift)))
    return tuple(plan), banded


# -- executing ----------------------------------------------------------


@dataclass
class _DayOutcome:
    traded: float = 0.0
    sleeve_traded: float = 0.0
    cost: float = 0.0
    budget: float = 0.0
    budget_binding: bool = False
    n_trades: int = 0
    n_postponed: int = 0
    #: (asset, change in units, fill price in total-return space). The
    #: caller needs all three to walk NAV from yesterday's close without
    #: consulting the cash books it is about to check.
    fills: list[tuple[str, float, float]] = field(default_factory=list)


def _execute(
    *,
    plan: Sequence[PlannedTrade],
    decision_date: pd.Timestamp | None,
    session: pd.Timestamp,
    i: int,
    nav_open: float,
    units: dict[str, float],
    pos: Mapping[str, int],
    px_open_unadj: np.ndarray,
    px_close_unadj: np.ndarray,
    px_open_tr: np.ndarray,
    adv: np.ndarray | None,
    vol: np.ndarray | None,
    ledger: SettlementLedger,
    config: BacktestConfig,
    trades: list[dict[str, Any]],
    postponed: list[dict[str, Any]],
) -> _DayOutcome:
    """Fill as much of yesterday's plan as today's constraints allow."""
    out = _DayOutcome(budget=config.max_daily_turnover * max(nav_open, 0.0))
    if not plan or decision_date is None:
        return out

    # Liquidity as of the DECISION close, never today's. Today's volume
    # contains our own print and everything that happened after we
    # decided; pricing an order with it is the same lookahead as filling
    # on the signal's own close.
    stat_row = max(i - 1, 0)
    budget_left = out.budget

    # `_decide` now plans the day's sales first, so on a rotation day the
    # sale is booked minutes before the buy it is going to pay for — and
    # it must still not pay for it. That is the entire content of T+1,
    # and an ordering change that leaked same-day proceeds through would
    # be a far worse bug than the mislabelling it was made to fix, so the
    # separating balance is pinned rather than assumed.
    #
    # Settled cash may only FALL across a session. Sales land in the
    # unsettled queue, which has no door out before its settlement date,
    # so a balance that grew mid-session could only have grown by
    # spending a receivable early. The real defence is the type in
    # `ledger.py` — `withdraw` exists on SettledCash and on nothing else,
    # so there is no expression here that reaches the queue. This is what
    # fails first if somebody ever flattens the two balances into one
    # convenient float, and it is stated in dollars because that is the
    # form the reader of a trade blotter would check it in.
    settled_at_open = ledger.settled
    bought = 0.0

    for p in plan:
        j = pos[p.asset]
        px = float(px_open_unadj[i, j])
        px_tr = float(px_open_tr[i, j])
        px_close_u = float(px_close_unadj[i, j])

        # px_tr finite implies close_adj finite, since it is built from
        # it — so this one test covers all three price frames.
        tradable = (
            np.isfinite(px)
            and px > 0.0
            and np.isfinite(px_tr)
            and px_tr > 0.0
            and np.isfinite(px_close_u)
            and px_close_u > 0.0
        )
        if not tradable:
            _postpone(
                postponed, p, session, decision_date,
                desired=abs(p.drift) * nav_open,
                executed=0.0,
                reason=Postponement.NO_FILL_PRICE,
                budget=out.budget,
                used=out.budget - budget_left,
            )
            out.n_postponed += 1
            continue

        held_units = units[p.asset]
        current_dollars = held_units * px_tr
        desired = (
            -current_dollars
            if p.full_exit
            else p.target_weight * nav_open - current_dollars
        )
        want = abs(desired)
        if want < max(config.min_trade_notional, _CASH_EPS):
            if want > _CASH_EPS:
                _postpone(
                    postponed, p, session, decision_date,
                    desired=want, executed=0.0,
                    reason=Postponement.BELOW_MIN_TRADE,
                    budget=out.budget, used=out.budget - budget_left,
                )
                out.n_postponed += 1
            continue

        buying = desired > 0.0
        name_adv = float(adv[stat_row, j]) if adv is not None else float("nan")
        name_vol = float(vol[stat_row, j]) if vol is not None else float("nan")

        # The cost rate at the size we WANTED. Sizing a cash-constrained
        # buy against the rate for a larger trade overstates the cost of
        # the smaller trade it becomes, which leaves a few cents unspent
        # rather than overdrawing the account — the only direction this
        # is allowed to be wrong in.
        rate = _cost_rate(config.cost_model, want, name_adv, name_vol)

        limits: dict[Postponement, float] = {
            Postponement.TURNOVER_BUDGET: max(budget_left, 0.0)
        }
        if (
            config.max_participation is not None
            and np.isfinite(name_adv)
            and name_adv > 0.0
        ):
            limits[Postponement.PARTICIPATION_CAP] = config.max_participation * name_adv
        if buying:
            # Every buy asks the ledger its own question, freshly,
            # because an earlier buy this morning has already spent part
            # of the answer.
            limits[Postponement.SETTLED_CASH] = (
                ledger.available_to_buy(nav_open) * (1.0 - 1e-9) / (1.0 + rate)
            )

        binding, allowed = min(limits.items(), key=lambda kv: kv[1])
        allowed = min(allowed, want)
        constrained = allowed < want - _CASH_EPS

        # Whole shares, and a full exit that leaves nothing behind: the
        # fractional residue of a total-return position is an accounting
        # artefact of reinvestment, not an odd lot somebody has to sell
        # separately.
        factor = px_tr / px
        clean_exit = p.full_exit and allowed >= current_dollars - _CASH_EPS
        if clean_exit:
            shares = held_units * factor
            notional = current_dollars
            delta_units = -held_units
        else:
            shares = _shares(allowed, px, whole=config.whole_shares)
            if not buying:
                shares = min(shares, held_units * factor)
            notional = shares * px
            delta_units = (notional if buying else -notional) / px_tr

        if notional <= max(config.min_trade_notional, _CASH_EPS):
            reason = binding if constrained else Postponement.BELOW_MIN_TRADE
            _postpone(
                postponed, p, session, decision_date,
                desired=want, executed=0.0, reason=reason,
                budget=out.budget, used=out.budget - budget_left,
            )
            out.n_postponed += 1
            if reason is Postponement.TURNOVER_BUDGET:
                out.budget_binding = True
            if reason is Postponement.SETTLED_CASH:
                _log_cash_deferral(
                    ledger, session, nav_open, p.asset, want * (1.0 + rate)
                )
            continue

        breakdown = config.cost_model.cost_bps(
            trade_notional=notional,
            median_dollar_volume=name_adv,
            daily_volatility=name_vol,
        )
        spread_cost = float(breakdown.spread_dollars)
        impact_cost = float(breakdown.impact_dollars)
        cost = spread_cost + impact_cost
        if cost >= notional:
            raise BacktestError(
                f"the cost model charged ${cost:,.2f} on a ${notional:,.2f} "
                f"trade in {p.asset} on {session.date()}. A friction larger "
                "than the trade means the liquidity input is nonsense, not "
                "that the trade is expensive."
            )

        if buying:
            # See `settled_at_open`. Two claims, and the second is the
            # one a person would make out loud: the balance has not
            # grown, and everything bought today still fits inside the
            # money that had settled before any of today's sales.
            assert (
                ledger.settled <= settled_at_open + _CASH_EPS
                and bought + notional + cost <= settled_at_open + _CASH_EPS
            ), (
                f"the ${notional + cost:,.2f} buy in {p.asset} on "
                f"{session.date()} is being funded by a sale made earlier in "
                "the same session; same-day proceeds reaching a buyer is the "
                "free-riding violation T+1 exists to prevent"
            )
            funding = ledger.fund_purchase(
                notional + cost, session=session, nav=nav_open, label=p.asset
            )
            if not funding.complete:
                # By construction the sizing above fits inside
                # `available_to_buy`, so this is the engine and the
                # ledger disagreeing about one number. Loud, not patched.
                raise BacktestError(
                    f"sized a ${notional + cost:,.2f} buy in {p.asset} that the "
                    f"ledger could only fund to ${funding.funded:,.2f}; the "
                    "engine's cash arithmetic and the ledger's have diverged"
                )
            bought += notional + cost
        else:
            ledger.record_sale(notional - cost, session, label=p.asset)

        units[p.asset] = 0.0 if clean_exit else held_units + delta_units
        out.fills.append((p.asset, delta_units, px_tr))
        out.traded += notional
        out.cost += cost
        out.n_trades += 1
        if p.is_sleeve:
            out.sleeve_traded += notional
        budget_left -= notional

        trades.append(
            {
                "date": session,
                "decision_date": decision_date,
                "ticker": p.asset,
                "side": "buy" if buying else "sell",
                "shares": shares,
                "price": px,
                "notional": notional,
                "spread_cost": spread_cost,
                "impact_cost": impact_cost,
                "cost": cost,
                "participation": float(breakdown.participation),
                "is_sleeve": bool(p.is_sleeve),
                "target_weight": p.target_weight,
                "filled_fraction": notional / want,
            }
        )

        # Only a bound CONSTRAINT is a postponement. The few dollars
        # left over by rounding to whole shares are not: logging those
        # would bury the days the budget actually bit under a daily
        # drizzle of forty-cent remainders.
        if constrained:
            _postpone(
                postponed, p, session, decision_date,
                desired=want, executed=notional, reason=binding,
                budget=out.budget, used=out.budget - budget_left,
            )
            out.n_postponed += 1
            if binding is Postponement.TURNOVER_BUDGET:
                out.budget_binding = True
            if binding is Postponement.SETTLED_CASH:
                _log_cash_deferral(
                    ledger, session, nav_open, p.asset, (want - notional) * (1.0 + rate)
                )

    return out


def _log_cash_deferral(
    ledger: SettlementLedger,
    session: pd.Timestamp,
    nav: float,
    asset: str,
    shortfall: float,
) -> None:
    """Write the unfunded remainder to the ledger's own deferral log.

    Deliberately a second call rather than one partial first call.
    Asking the ledger to part-fund would debit a figure that no
    whole-share trade can spend exactly, and the residue would be money
    debited and never delivered — which the invariant would report,
    correctly, as lost. So the executable piece is funded exactly, and
    the remainder is offered on its own with `allow_partial=False`,
    which cannot move a cent and records the refusal. The row's
    `intended` is therefore the part that did not happen rather than the
    whole order, which is the more useful of the two figures anyway.
    """
    if shortfall <= _CASH_EPS:
        return
    ledger.fund_purchase(
        shortfall, session=session, nav=nav, label=asset, allow_partial=False
    )


def _postpone(
    log: list[dict[str, Any]],
    p: PlannedTrade,
    session: pd.Timestamp,
    decision_date: pd.Timestamp,
    *,
    desired: float,
    executed: float,
    reason: Postponement,
    budget: float,
    used: float,
) -> None:
    log.append(
        {
            "date": session,
            "decision_date": decision_date,
            "ticker": p.asset,
            "side": p.side,
            "reason": reason.value,
            "desired_notional": desired,
            "executed_notional": executed,
            "postponed_notional": max(desired - executed, 0.0),
            "is_sleeve": bool(p.is_sleeve),
            "budget": budget,
            "budget_used": used,
        }
    )


# -- small arithmetic ---------------------------------------------------


def _shares(dollars: float, price: float, *, whole: bool) -> float:
    if not (price > 0.0) or dollars <= 0.0:
        return 0.0
    n = dollars / price
    return float(math.floor(n)) if whole else float(n)


def _value(units: Mapping[str, float], prices: Mapping[str, float]) -> float:
    """Mark a book. A position with no price contributes nothing, which
    the invariant will notice — that is the intended loudness."""
    total = 0.0
    for asset, u in units.items():
        if u == 0.0:
            continue
        p = prices.get(asset)
        if p is None or not math.isfinite(p):
            continue
        total += u * p
    return total


def _cost_rate(model: CostModel, notional: float, adv: float, vol: float) -> float:
    """Cost as a fraction of notional. For sizing only — the charge on
    the fill is recomputed at the size actually traded."""
    if notional <= 0.0:
        return 0.0
    b = model.cost_bps(
        trade_notional=notional, median_dollar_volume=adv, daily_volatility=vol
    )
    return float(b.total_bps) / 1e4


def _require_nyse_sessions(sessions: pd.DatetimeIndex) -> None:
    """Every row must be a real session before the loop starts.

    Checked up front rather than discovered three thousand days in by a
    `SettlementError` out of the ledger. A weekend in the index means a
    calendar leaked in somewhere upstream, and the useful thing to print
    is the first offender, not the run's remains.
    """
    for day in sessions:
        if not is_session(day):
            raise BacktestError(
                f"{pd.Timestamp(day).date()} is not an NYSE session. The panel "
                "index must be exchange sessions — a calendar day in here "
                "means somebody reindexed with a date_range."
            )


def _positions_frame(
    assets: Sequence[str],
    units: Mapping[str, float],
    marks: Mapping[str, float],
    market: MarketData,
) -> pd.DataFrame:
    """The book at the end, in both spaces.

    `units` is what the engine held; `shares` is what a custodian
    statement would say, which is larger by every distribution the
    position has reinvested since it was opened.
    """
    factor = market.adjustment_factor.iloc[-1]
    rows = [
        {
            "ticker": a,
            "units": float(units.get(a, 0.0)),
            "shares": float(units.get(a, 0.0) * float(factor.get(a, float("nan")))),
            "mark": float(marks.get(a, float("nan"))),
            "market_value": float(units.get(a, 0.0) * marks.get(a, float("nan"))),
        }
        for a in assets
        if units.get(a, 0.0) != 0.0
    ]
    return _frame(rows, _POSITION_COLUMNS)
