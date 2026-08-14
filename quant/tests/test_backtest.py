"""The seam between deciding and filling, and the three constraints
that are account-level facts rather than preferences.

The seam first, because it is the only thing in the engine that can go
wrong silently. A backtest that signals and fills on the same close
earns the whole close-to-open gap for free, every day, in the direction
of its own signal, and it does so most generously in exactly the fast
markets a strategy is supposed to be tested against. The defence is not
a check — there is nothing to check — it is that a strategy is handed a
`MarketView` whose frames have already been truncated at session T. So
the tests below try to write the peeking expression and find that
tomorrow is not in the object: the row is absent, the label raises, and
the field list carries no handle back to the full panel. Then, having
established there is nothing to see, they check the fill lands on the
next OPEN and not on the close the decision was taken at.

After that, the three refusals. Long-only and no-leverage RAISE rather
than clamp, because a target quietly clipped lets a strategy run for
twenty years against a constraint it never obeyed. The turnover budget
binds, and when it binds the sleeves go first — the sleeves ARE the
risk control, so the trade that has to survive a tight day is the one
that moves the book's exposure to an asset class, not the one that
tidies a single name. And the no-trade band, which is the only dial in
the engine and therefore the one that has to be shown to work in both
directions: inside it nothing trades, outside it something does, and a
full exit ignores it entirely.
"""

from __future__ import annotations

import dataclasses
from typing import Mapping

import numpy as np
import pandas as pd
import pytest

from griffinquant.engine.backtest import (
    BacktestConfig,
    BacktestError,
    BuyAndHold,
    MarketData,
    MarketView,
    Postponement,
    _decide,
    run_backtest,
)
from griffinquant.config import UNIVERSE
from griffinquant.engine.costs import CostModel
from griffinquant.engine.ledger import DeferralReason, _sessions

SLEEVE = "SPY"  # in SLEEVE_TICKERS, capped at 40% by the sleeves module
SINGLE = "ZZZ"  # not a sleeve, uncapped by default

START = "2021-01-04"


def sessions(n: int, start: str = START) -> pd.DatetimeIndex:
    """Real NYSE sessions, from the engine's own calendar."""
    every = _sessions()
    first = int(every.searchsorted(pd.Timestamp(start), side="left"))
    return every[first : first + n]


def panel(
    n: int = 40,
    *,
    assets: tuple[str, ...] = (SLEEVE, SINGLE),
    close: float = 100.0,
    open_: float = 100.0,
    adv: float = 1e11,
    start: str = START,
) -> MarketData:
    """A flat panel. Deliberately boring: every test below wants to see
    one moving part, and a random walk hides all of them."""
    idx = sessions(n, start)
    cols = list(assets)
    flat = lambda v: pd.DataFrame(v, index=idx, columns=cols, dtype="float64")
    return MarketData(
        open_unadj=flat(open_),
        close_unadj=flat(close),
        close_adj=flat(close),
        dollar_volume=flat(adv),
        daily_volatility=flat(0.01),
    )


class Fixed:
    """Ask for the same book every day, and record what you were shown."""

    def __init__(self, weights: Mapping[str, float], name: str = "fixed") -> None:
        self.weights = dict(weights)
        self.name = name
        self.views: list[MarketView] = []

    def targets(self, view: MarketView) -> Mapping[str, float]:
        self.views.append(view)
        return self.weights


class Rotate:
    """Hold a sleeve throughout and swap the rest of the book between two
    single names every `period` sessions. The one scenario that makes a
    nearly-fully-invested account depend on its own sale proceeds."""

    name = "rotate"

    def __init__(self, period: int = 30) -> None:
        self.period = period
        self.n = -1

    def targets(self, view: MarketView) -> Mapping[str, float]:
        self.n += 1
        held = SINGLE if (self.n // self.period) % 2 == 0 else "YYY"
        return {SLEEVE: 0.40, held: 0.55}


class Staged:
    """One book before `switch_on`, another from it. Lets a test put a
    single decision on a known session and read the fill off the next."""

    name = "staged"

    def __init__(self, switch_on: pd.Timestamp, before, after) -> None:
        self.switch_on = pd.Timestamp(switch_on)
        self.before = dict(before)
        self.after = dict(after)

    def targets(self, view: MarketView) -> Mapping[str, float]:
        return self.after if view.asof >= self.switch_on else self.before


# -- the T+1 seam ---------------------------------------------------------


def test_the_view_ends_at_the_close_it_was_handed():
    """Every frame is cut at `asof`. Not filtered on read — CUT, so
    there is no row for a strategy to reach."""
    idx = sessions(30)
    market = panel(30)
    spy = Fixed({SLEEVE: 0.20})
    run_backtest(market, spy, BacktestConfig())

    # One view per session except the last, which gets no decision
    # because it has no tomorrow inside the sample.
    assert len(spy.views) == len(idx) - 1
    for k, view in enumerate(spy.views):
        assert view.asof == idx[k]
        for name in ("open_unadj", "close_unadj", "close_adj"):
            frame = getattr(view, name)
            assert len(frame) == k + 1
            assert frame.index[-1] == view.asof
            assert frame.index.max() == view.asof


def test_a_strategy_that_reaches_for_tomorrow_finds_nothing_to_reach_with():
    """The three ways somebody would actually try it, all of them
    failing at the expression rather than in the numbers."""
    idx = sessions(20)
    market = panel(20)
    caught: list[str] = []

    class Peeker:
        name = "peeker"

        def targets(self, view: MarketView) -> Mapping[str, float]:
            here = int(view.close_adj.index.searchsorted(view.asof))
            try:
                view.close_adj.iloc[here + 1]
            except IndexError:
                caught.append("positional")
            try:
                view.close_adj.loc[idx[here + 1]]
            except KeyError:
                caught.append("by label")
            # And there is no handle back to the untruncated panel.
            assert not hasattr(view, "market")
            assert not hasattr(view, "future")
            return {}

    run_backtest(market, Peeker(), BacktestConfig())
    assert caught.count("positional") == len(idx) - 1
    assert caught.count("by label") == len(idx) - 1


def test_the_view_carries_nothing_but_the_past_and_the_book():
    """A field list, asserted whole.

    This is the test that fails when somebody adds a convenience to
    `MarketView` that happens to close the loop back to the engine's own
    frames. Adding a field is fine; adding one without reading this note
    is not.
    """
    got = {f.name for f in dataclasses.fields(MarketView)}
    assert got == {
        "asof",
        "open_unadj",
        "close_unadj",
        "close_adj",
        "dollar_volume",
        "daily_volatility",
        "weights",
        "nav",
        "cash_weight",
        "investable_weight",
        "no_trade_band",
        "caps",
    }


def test_the_fill_is_tomorrows_open_and_not_todays_close():
    """The measurable version of the same claim.

    Closes are flat at 100 throughout, so a strategy filling at its own
    signal's close would print a price of 100. The open on the session
    after the decision is 120. The trade log has to say 120, and the
    decision date has to be the session before it.
    """
    idx = sessions(20)
    market = panel(20, close=100.0, open_=100.0)
    decide_on = idx[4]
    fill_on = idx[5]
    opens = market.open_unadj.copy()
    opens.loc[fill_on, SLEEVE] = 120.0
    market = MarketData(
        open_unadj=opens,
        close_unadj=market.close_unadj,
        close_adj=market.close_adj,
        dollar_volume=market.dollar_volume,
        daily_volatility=market.daily_volatility,
    )

    result = run_backtest(
        market,
        Staged(decide_on, {}, {SLEEVE: 0.30}),
        BacktestConfig(max_daily_turnover=0.40),
    )
    first = result.trades.iloc[0]
    assert first["ticker"] == SLEEVE
    assert first["decision_date"] == decide_on
    assert first["date"] == fill_on
    assert first["price"] == pytest.approx(120.0)
    # And the gap is paid for, to the cent: bought at 120, marked back
    # to 100 the same evening. A same-close fill would have shown no
    # loss at all, which is the free money this seam exists to refuse.
    gap = first["notional"] - first["shares"] * 100.0
    assert gap == pytest.approx(first["shares"] * 20.0)
    assert result.equity.loc[fill_on] == pytest.approx(
        result.equity.loc[decide_on] - gap - first["cost"]
    )


def test_liquidity_is_read_at_the_decision_close_not_at_the_fill():
    """The same lookahead one layer down, where nobody looks.

    Today's volume contains our own print and everything that happened
    after we decided. Pricing an order with it is free information about
    the day the order trades.
    """
    idx = sessions(20)
    market = panel(20)
    decide_on, fill_on = idx[4], idx[5]

    adv = market.dollar_volume.copy()
    adv.loc[decide_on, SLEEVE] = 2e7  # thin when the decision was taken
    adv.loc[fill_on, SLEEVE] = 1e13  # a flood the next morning
    market = MarketData(
        open_unadj=market.open_unadj,
        close_unadj=market.close_unadj,
        close_adj=market.close_adj,
        dollar_volume=adv,
        daily_volatility=market.daily_volatility,
    )

    result = run_backtest(
        market,
        Staged(decide_on, {}, {SLEEVE: 0.30}),
        BacktestConfig(max_daily_turnover=0.40),
    )
    first = result.trades.iloc[0]
    assert first["date"] == fill_on
    # 1% of $20m is $200,000, so the participation cap does not bind;
    # what does show is that the trade was priced against $20m and not
    # against the ten trillion sitting under it on the fill date.
    assert first["participation"] == pytest.approx(first["notional"] / 2e7)
    assert first["participation"] > 1e-4


def test_the_last_session_never_gets_a_decision():
    """Manufacturing one would put a trade in the log that never had a
    fill."""
    idx = sessions(15)
    spy = Fixed({SLEEVE: 0.20})
    run_backtest(panel(15), spy, BacktestConfig())
    assert spy.views[-1].asof == idx[-2]


def test_warmup_banks_history_before_the_first_decision():
    spy = Fixed({SLEEVE: 0.20})
    idx = sessions(20)
    run_backtest(panel(20), spy, BacktestConfig(warmup=6))
    assert spy.views[0].asof == idx[6]
    assert spy.views[0].sessions == 7


# -- long only ------------------------------------------------------------


def test_a_negative_target_is_refused_rather_than_clipped():
    """A short is not a small mistake to be clipped. Quietly fixing it
    lets a strategy run for twenty years against a constraint it never
    obeyed."""
    with pytest.raises(BacktestError, match="long-only cash account"):
        run_backtest(panel(10), Fixed({SLEEVE: -0.10}), BacktestConfig())


def test_no_weight_in_the_result_is_ever_negative():
    result = run_backtest(
        panel(60), BuyAndHold({SLEEVE: 0.30, SINGLE: 0.40}), BacktestConfig()
    )
    assert (result.weights.to_numpy() >= 0.0).all()
    assert (result.daily["market_value"] >= 0.0).all()
    assert (result.daily["settled"] >= -1e-9).all()


def test_a_target_above_its_cap_is_clamped_and_the_cap_binds():
    """A cap is not a refusal — it is the ceiling the book is allowed to
    reach — so this one clamps where the two above raise."""
    plan, _ = _decide(
        {SLEEVE: 0.90}, _view({SLEEVE: 0.0, SINGLE: 0.0}), BacktestConfig(), {}
    )
    assert [p.target_weight for p in plan] == [0.40]

    result = run_backtest(
        panel(80), Fixed({SLEEVE: 0.90}), BacktestConfig(max_daily_turnover=0.05)
    )
    assert result.weights[SLEEVE].max() <= 0.40 + 1e-6


# -- no leverage ----------------------------------------------------------


def test_targets_summing_past_nav_are_refused():
    with pytest.raises(BacktestError, match="No margin, no leverage"):
        run_backtest(panel(10), Fixed({SLEEVE: 0.40, SINGLE: 0.70}), BacktestConfig())


def test_gross_exposure_never_exceeds_nav_over_a_whole_run():
    """The residual is cash, not a borrowing — so invested weight tops
    out at one and settled cash never goes negative."""
    result = run_backtest(
        panel(120), Fixed({SLEEVE: 0.40, SINGLE: 0.60}), BacktestConfig()
    )
    assert result.daily["invested_weight"].max() <= 1.0 + 1e-9
    assert result.daily["cash_weight"].min() >= -1e-9
    assert (result.weights.sum(axis=1) <= 1.0 + 1e-9).all()


def test_a_fully_invested_target_is_unreachable_and_says_why():
    """The buffer means a target summing to 1.0 can never be met, and
    the ledger has to log that rather than quietly falling short."""
    result = run_backtest(
        panel(150), Fixed({SLEEVE: 0.40, SINGLE: 0.60}), BacktestConfig()
    )
    assert len(result.deferrals) > 0
    assert "settled_cash_buffer" in set(result.deferrals["reason"])
    assert result.daily["invested_weight"].max() < 0.99


# -- the turnover budget --------------------------------------------------


def test_the_budget_is_hard_on_every_single_session():
    result = run_backtest(
        panel(120),
        Fixed({SLEEVE: 0.40, SINGLE: 0.55}),
        BacktestConfig(max_daily_turnover=0.05),
    )
    assert result.daily["turnover"].max() <= 0.05 + 1e-9
    assert result.daily["budget_binding"].any()


def test_a_full_deployment_takes_about_nineteen_sessions():
    """Five per cent of NAV a day is not a bug to be exempted away; it
    is what the constraint says, and the ramp has to be visible."""
    result = run_backtest(
        panel(60),
        Fixed({SLEEVE: 0.40, SINGLE: 0.50}),
        BacktestConfig(max_daily_turnover=0.05),
    )
    invested = result.daily["invested_weight"]
    assert invested.iloc[0] == pytest.approx(0.0)
    assert invested.iloc[10] < 0.60
    assert invested.iloc[25] > 0.85


def test_when_the_budget_will_not_cover_everything_the_sleeve_goes_first():
    """The sleeves ARE the risk control. On a tight day the trade that
    has to survive is the one moving the book's exposure to an asset
    class, not the one tidying a single name."""
    result = run_backtest(
        panel(40),
        Fixed({SLEEVE: 0.30, SINGLE: 0.30}),
        BacktestConfig(max_daily_turnover=0.02),
    )
    early = result.trades.loc[result.trades["date"] <= sessions(40)[8]]
    assert set(early["ticker"]) == {SLEEVE}
    assert early["is_sleeve"].all()

    starved = result.postponed.loc[result.postponed["date"] <= sessions(40)[8]]
    assert set(starved["ticker"]) == {SINGLE, SLEEVE}
    single = starved.loc[starved["ticker"] == SINGLE]
    assert (single["reason"] == Postponement.TURNOVER_BUDGET.value).all()
    assert (single["executed_notional"] == 0.0).all()


def test_within_a_tier_the_largest_deviation_goes_first():
    """It is the trade that most reduces the distance between the book
    we have and the book we decided on."""
    plan, _ = _decide(
        {SLEEVE: 0.10, SINGLE: 0.60, "AAA": 0.20},
        _view({SLEEVE: 0.0, SINGLE: 0.0, "AAA": 0.0}, assets=(SLEEVE, SINGLE, "AAA")),
        BacktestConfig(),
        {SLEEVE: True, SINGLE: False, "AAA": False},
    )
    assert [p.asset for p in plan] == [SLEEVE, SINGLE, "AAA"]


# -- sells before buys ----------------------------------------------------


def test_the_plan_sells_before_it_buys():
    """Three keys, in the order they bind, and one plan that separates
    all three.

    The sells lead: BBB is not a sleeve and IEF is, and BBB still goes
    first, so side outranks sleeve. Inside the sell side the sleeve
    leads on a SMALLER deviation than the single name behind it, so
    sleeve outranks size. Inside each tier the larger deviation leads.
    """
    assets = (SLEEVE, "BBB", "IEF", SINGLE, "AAA")
    plan, _ = _decide(
        {SLEEVE: 0.05, "BBB": 0.0, "IEF": 0.20, SINGLE: 0.55, "AAA": 0.05},
        _view(
            {SLEEVE: 0.30, "BBB": 0.40, "IEF": 0.0, SINGLE: 0.0, "AAA": 0.0},
            assets=assets,
        ),
        BacktestConfig(),
        {SLEEVE: True, "BBB": False, "IEF": True, SINGLE: False, "AAA": False},
    )
    assert [p.side for p in plan] == ["sell", "sell", "buy", "buy", "buy"]
    assert [p.asset for p in plan] == [SLEEVE, "BBB", "IEF", SINGLE, "AAA"]


def _rotation_day():
    """A book wholly in one single name, told at the close of session 1
    to be wholly in another.

    Session 2 is then the rotation: one sale and one buy planned against
    the same morning, with the buy the larger deviation of the two and
    therefore what an ordering that knew nothing about sides reached
    first. Both names are single names, so the sleeve key cannot be what
    decides the order, and the turnover budget is opened right up so the
    constraint on show is unambiguously cash.
    """
    idx = sessions(5)
    result = run_backtest(
        panel(5, assets=(SINGLE, "YYY")),
        Staged(idx[1], before={SINGLE: 0.60}, after={"YYY": 0.85}),
        BacktestConfig(max_daily_turnover=1.0),
    )
    return idx, result


def test_a_rotation_days_deferral_is_settlement_and_is_labelled_so():
    """The buy waits a day whichever order the pair is planned in. What
    the order decides is which sentence the year-end table tells.

    Plan the buy first and it meets an empty receivables queue, so
    NO_CASH is the only honest thing the ledger can say — and a reader
    asking that table what T+1 cost the fund is told instead that the
    strategy ran out of money. The proceeds below are visibly in flight
    and larger than the shortfall, which is exactly the case the
    UNSETTLED label exists to name.
    """
    idx, result = _rotation_day()
    day = idx[2]

    deferrals = result.deferrals.loc[result.deferrals["date"] == day]
    assert len(deferrals) == 1
    row = deferrals.iloc[0]
    assert row["label"] == "YYY"
    assert row["reason"] == DeferralReason.UNSETTLED.value

    # The two facts that make UNSETTLED the true label rather than a
    # kinder one: settled cash alone could not have covered the
    # shortfall, so this is not the buffer arguing; and the receivable
    # could have, so the money exists and only the cycle is in the way.
    assert row["shortfall"] > row["settled"]
    assert row["unsettled"] > row["shortfall"]

    # The mechanism, stated after the symptom: the sale is planned
    # first, so by the time the buy asks, the queue it is waiting on is
    # visible rather than empty.
    day_trades = result.trades.loc[result.trades["date"] == day]
    assert list(day_trades["side"]) == ["sell", "buy"]
    assert list(day_trades["ticker"]) == [SINGLE, "YYY"]


def test_a_sale_planned_before_a_buy_still_does_not_fund_it():
    """The ordering change is about a word, and it has to stay about a
    word. Same-day proceeds reaching a buyer would be a free-riding
    violation — a far worse bug than the mislabelling that motivated the
    reordering — so the dollars are checked rather than assumed.

    The clinching pair is at the bottom. Settled cash plus the morning's
    proceeds would have covered the whole order; the buy came out at
    settled cash alone. The gap between those two numbers is the day of
    settlement, unspent.
    """
    idx, result = _rotation_day()
    day = idx[2]

    day_trades = result.trades.loc[result.trades["date"] == day]
    sell = day_trades.loc[day_trades["side"] == "sell"].iloc[0]
    buy = day_trades.loc[day_trades["side"] == "buy"].iloc[0]

    # Nothing matured on the rotation morning — the only sale in the run
    # so far is the one made during it — so the settled balance at the
    # previous close is the balance the buy was sized against.
    opening_settled = float(result.daily["settled"].iloc[1])
    nav_open = float(result.daily["nav_open"].iloc[2])
    spendable = opening_settled - BacktestConfig().buffer_fraction * nav_open

    proceeds = float(sell["notional"] - sell["cost"])
    assert proceeds > 0.0
    # The sale really did land in the same session, ahead of the buy.
    assert float(result.daily["unsettled"].iloc[2]) == pytest.approx(proceeds)

    want = float(
        result.postponed.loc[
            (result.postponed["date"] == day) & (result.postponed["ticker"] == "YYY"),
            "desired_notional",
        ].iloc[0]
    )
    assert spendable + proceeds > want
    assert float(buy["notional"] + buy["cost"]) <= spendable + 1e-6


def test_the_engine_notices_if_the_two_cash_balances_are_ever_merged(monkeypatch):
    """The guard in `_execute`, shown to be load-bearing rather than
    decorative.

    `ledger.py` names the refactor it fears: somebody decides settled
    and unsettled money are a needless complication and merges them
    into one convenient float. Below is that refactor, in one line —
    proceeds landing in settled cash on the day of the sale — and the
    engine has to refuse it rather than quietly buy more.

    Worth noting what the leak would have bought. The honest fill on
    this rotation is $45,800; with same-day proceeds reachable the
    engine sizes past $52,000. So this is not a fussy invariant, it is
    the difference between a backtest that obeys the account and one
    that spends money it has not got.
    """
    from griffinquant.engine.ledger import SettlementLedger

    honest = SettlementLedger.record_sale

    def leaky(self, amount, trade_date, settles_on=None, *, label=None):
        out = honest(self, amount, trade_date, settles_on, label=label)
        self._settled = self._settled.deposit(float(amount))
        return out

    monkeypatch.setattr(SettlementLedger, "record_sale", leaky)
    with pytest.raises(AssertionError, match="free-riding"):
        _rotation_day()


def test_the_two_logs_are_kept_apart():
    """`deferrals` means the cash was not there; `postponed` means the
    trade was there and the day's budget was not. One count reads as one
    phenomenon and is always two, and only one of them is an argument
    about the account type.

    The rotation below fills both at once: a book at 95% invested being
    asked to swap one 55% position for another, so the day's budget
    bites AND the replacement cannot be paid for out of settled cash.

    The budget is deliberately wide, and the reason is the test below
    this one. At the mandate's own 5% a day the settlement cycle never
    binds at all, so the cash log comes back empty and there is nothing
    here to keep apart. It takes a budget loose enough to clear the
    whole sale in one session before the buy ever meets the wall.

    The mix of deferral reasons is left loose on purpose. Which of the
    three a given rotation lands on is a fact about that day's cash
    position, not a contract this test is entitled to pin — the tests
    above own the one case where the answer is knowable in advance.
    What is pinned here is that the two VOCABULARIES stay disjoint,
    because that is what makes the two counts unmergeable.
    """
    result = run_backtest(
        panel(200, assets=(SLEEVE, SINGLE, "YYY")),
        Rotate(period=30),
        BacktestConfig(max_daily_turnover=0.60),
    )
    postponed = set(result.postponed["reason"])
    deferred = set(result.deferrals["reason"])

    assert postponed <= {p.value for p in Postponement}
    assert {"turnover_budget", "settled_cash"} <= postponed
    assert deferred and deferred <= {
        "unsettled_proceeds",
        "settled_cash_buffer",
        "no_cash",
    }
    # The two vocabularies do not overlap, which is the mechanical form
    # of the claim: nothing can be counted once under each heading.
    assert not (postponed & deferred)
    assert result.daily["n_postponed"].sum() == len(result.postponed)
    assert result.daily["n_deferrals"].sum() == len(result.deferrals)


def test_at_the_mandates_own_budget_the_settlement_cycle_never_binds():
    """An empty deferral table is a finding here, not a broken log.

    Five per cent of NAV a day and T+1 are both constraints on the same
    rotation, and one of them is roughly ten times tighter than the
    other. A sale rationed to 5% a day has settled by the following
    morning, so the money is always spendable before the budget will
    let it be spent, and the cycle never gets to refuse anything. The
    same rotation with the budget opened up defers repeatedly — the
    test above runs exactly that.

    This is pinned because the reverse mistake is so easy: somebody
    reads a year of zero settlement deferrals, assumes the log is
    broken, and "fixes" it. It is not broken. At this turnover the
    account type costs nothing, and that is the answer.
    """
    result = run_backtest(
        panel(200, assets=(SLEEVE, SINGLE, "YYY")),
        Rotate(period=30),
        BacktestConfig(max_daily_turnover=0.05),
    )
    assert len(result.trades) > 0
    assert set(result.postponed["reason"]) == {Postponement.TURNOVER_BUDGET.value}
    assert result.deferrals.empty
    assert result.ledger.deferrals_by_year().empty


def test_the_participation_cap_binds_where_a_real_adv_is_known():
    """One per cent of the name's own median dollar volume, applied at
    the one moment the dollar figure is finally known."""
    thin = panel(40, adv=1e6)  # $1m a day: 1% is $10,000
    result = run_backtest(
        thin, Fixed({SLEEVE: 0.30}), BacktestConfig(max_daily_turnover=0.50)
    )
    assert result.trades["notional"].max() <= 10_000.0 + 1e-6
    assert (
        Postponement.PARTICIPATION_CAP.value in set(result.postponed["reason"])
    )


def test_a_missing_adv_does_not_become_a_fact_about_the_market():
    """A cost model must be pessimistic about what it does not know. A
    CONSTRAINT that blocks trades on the strength of a missing column is
    reporting our data gap as market depth."""
    idx = sessions(30)
    cols = [SLEEVE]
    flat = lambda v: pd.DataFrame(v, index=idx, columns=cols, dtype="float64")
    market = MarketData(
        open_unadj=flat(100.0), close_unadj=flat(100.0), close_adj=flat(100.0)
    )
    result = run_backtest(
        market, Fixed({SLEEVE: 0.30}), BacktestConfig(max_daily_turnover=0.40)
    )
    assert len(result.trades) >= 1
    assert Postponement.PARTICIPATION_CAP.value not in set(
        result.postponed["reason"]
    )


# -- the no-trade band ----------------------------------------------------


def test_a_drift_inside_the_band_is_counted_and_not_traded():
    plan, banded = _decide(
        {SLEEVE: 0.303, SINGLE: 0.20},
        _view({SLEEVE: 0.30, SINGLE: 0.20}),
        BacktestConfig(no_trade_band=0.005),
        {},
    )
    assert plan == ()
    assert banded == 1


def test_a_drift_outside_the_band_is_traded():
    plan, banded = _decide(
        {SLEEVE: 0.31, SINGLE: 0.20},
        _view({SLEEVE: 0.30, SINGLE: 0.20}),
        BacktestConfig(no_trade_band=0.005),
        {},
    )
    assert [p.asset for p in plan] == [SLEEVE]
    assert plan[0].drift == pytest.approx(0.01)
    assert banded == 0


def test_a_target_already_held_exactly_is_not_a_banded_near_miss():
    """Zero drift is not a trade the band prevented; counting it would
    make the band's own diagnostic useless."""
    _, banded = _decide(
        {SLEEVE: 0.30}, _view({SLEEVE: 0.30, SINGLE: 0.0}), BacktestConfig(), {}
    )
    assert banded == 0


def test_a_full_exit_ignores_the_band():
    """A position the process has decided against should leave, not
    linger under a threshold for years because it happens to be
    small."""
    plan, _ = _decide(
        {SLEEVE: 0.0, SINGLE: 0.20},
        _view({SLEEVE: 0.001, SINGLE: 0.20}),
        BacktestConfig(no_trade_band=0.005),
        {},
    )
    assert [p.asset for p in plan] == [SLEEVE]
    assert plan[0].full_exit


def test_a_zero_band_still_does_not_rebalance_the_whole_book_daily():
    """With the band at zero a drift of exactly zero is not less than
    zero, so every asset enters the plan and is then priced against
    tomorrow's NAV, which has moved. The floor under the band is what
    stops a validation run trading its entire book every session for
    twenty years."""
    _, banded = _decide(
        {SLEEVE: 0.30},
        _view({SLEEVE: 0.30, SINGLE: 0.0}),
        BacktestConfig(no_trade_band=0.0),
        {},
    )
    assert banded == 0

    result = run_backtest(
        panel(90), BuyAndHold({SLEEVE: 0.30, SINGLE: 0.30}),
        BacktestConfig(no_trade_band=0.0),
    )
    quiet = result.daily.iloc[40:]
    assert quiet["n_trades"].sum() == 0


def test_the_band_is_shown_to_the_strategy():
    """A strategy that cannot see the band cannot tell a target the
    engine reached from a target the engine declined to chase."""
    spy = Fixed({SLEEVE: 0.20})
    run_backtest(panel(12), spy, BacktestConfig(no_trade_band=0.0075))
    assert all(v.no_trade_band == 0.0075 for v in spy.views)
    assert all(v.caps[SLEEVE] == 0.40 for v in spy.views)


# -- configuration is a contract ------------------------------------------


def test_the_band_has_to_come_with_a_provenance():
    """The only dial in this engine, and an unexplained value is
    indistinguishable from one fitted on the test set."""
    with pytest.raises(BacktestError, match="band_provenance is empty"):
        BacktestConfig(band_provenance="   ")


@pytest.mark.parametrize("bad", [0.0, -0.01, 1.5])
def test_an_impossible_turnover_budget_is_refused(bad):
    with pytest.raises(BacktestError, match="max_daily_turnover"):
        BacktestConfig(max_daily_turnover=bad)


def test_the_other_refusals():
    with pytest.raises(BacktestError, match="no_trade_band cannot be negative"):
        BacktestConfig(no_trade_band=-0.001)
    with pytest.raises(BacktestError, match="starting_cash"):
        BacktestConfig(starting_cash=0.0)
    with pytest.raises(BacktestError, match="cap on"):
        BacktestConfig(caps={SINGLE: 1.5})
    with pytest.raises(BacktestError, match="max_participation"):
        BacktestConfig(max_participation=0.0)


def test_sleeve_caps_arrive_without_being_restated():
    cfg = BacktestConfig()
    assert cfg.cap_for("SPY") == 0.40
    assert cfg.cap_for("TLT") == 0.25
    assert cfg.cap_for("us_equity") == 0.40  # indexed by key as well
    assert cfg.cap_for(SINGLE) == 1.0
    assert BacktestConfig(caps={"SPY": 0.10}).cap_for("SPY") == 0.10
    assert BacktestConfig(apply_sleeve_caps=False).cap_for("SPY") == 1.0


# -- the panel is a contract too ------------------------------------------


def test_a_calendar_day_in_the_index_is_caught_before_the_loop_starts():
    """A weekend in here means somebody reindexed with a date_range, and
    the useful thing to print is the first offender rather than the
    run's remains three thousand days later."""
    idx = pd.date_range("2021-01-04", periods=20, freq="D")
    flat = pd.DataFrame(100.0, index=idx, columns=[SLEEVE], dtype="float64")
    market = MarketData(open_unadj=flat, close_unadj=flat, close_adj=flat)
    with pytest.raises(BacktestError, match="not an NYSE session"):
        run_backtest(market, Fixed({SLEEVE: 0.10}), BacktestConfig())


def test_frames_on_different_calendars_are_refused():
    """The engine aligns nothing for you on purpose: a reindex here
    would fabricate a bar."""
    a = pd.DataFrame(100.0, index=sessions(20), columns=[SLEEVE], dtype="float64")
    b = pd.DataFrame(
        100.0, index=sessions(20, "2021-02-01"), columns=[SLEEVE], dtype="float64"
    )
    with pytest.raises(BacktestError, match="different calendar"):
        MarketData(open_unadj=a, close_unadj=b, close_adj=a)


def test_frames_carrying_different_assets_are_refused():
    idx = sessions(20)
    a = pd.DataFrame(100.0, index=idx, columns=[SLEEVE, SINGLE], dtype="float64")
    b = pd.DataFrame(100.0, index=idx, columns=[SLEEVE], dtype="float64")
    with pytest.raises(BacktestError, match="different assets"):
        MarketData(open_unadj=a, close_unadj=a, close_adj=b)


def test_a_recycled_ticker_is_caught_at_the_pivot():
    """Two entities sharing a symbol splice a dead company's price
    history onto a living one's, and the result backtests beautifully."""
    long = pd.DataFrame(
        {
            "date": pd.to_datetime(["2021-01-04", "2021-01-04"]),
            "ticker": ["WB", "WB"],
            "open_unadj": [10.0, 40.0],
            "close_unadj": [10.0, 40.0],
            "close_adj": [10.0, 40.0],
        }
    )
    with pytest.raises(BacktestError, match="recycled-symbol trap"):
        MarketData.from_prices(long)


def test_a_strategy_asking_for_an_asset_off_the_panel_is_refused():
    with pytest.raises(BacktestError, match="not in the panel"):
        run_backtest(panel(10), Fixed({"NOPE": 0.1}), BacktestConfig())


def test_a_two_session_sample_is_the_floor():
    with pytest.raises(BacktestError, match="at least two sessions"):
        run_backtest(panel(1), Fixed({SLEEVE: 0.1}), BacktestConfig())


# -- the account's arithmetic ---------------------------------------------


def test_positions_are_whole_shares():
    result = run_backtest(
        panel(60, close=137.0, open_=137.0),
        Fixed({SLEEVE: 0.30}),
        BacktestConfig(max_daily_turnover=0.40),
    )
    assert (result.trades["shares"] % 1.0 == 0.0).all()


def test_a_trade_too_small_for_its_own_ticket_is_not_placed():
    result = run_backtest(
        panel(90),
        BuyAndHold({SLEEVE: 0.30, SINGLE: 0.30}),
        BacktestConfig(min_trade_notional=100.0),
    )
    assert result.trades["notional"].min() > 100.0


def test_the_books_reconcile_on_every_session_of_a_long_run():
    """`check_invariant` runs inside the loop, so a passing run has
    already proved this. Restated here against the OUTPUT frames,
    because the reporting layer is a second place the arithmetic can
    part company with itself."""
    result = run_backtest(
        panel(200), BuyAndHold({SLEEVE: 0.35, SINGLE: 0.40}), BacktestConfig()
    )
    daily = result.daily
    books = daily["settled"] + daily["unsettled"] + daily["market_value"]
    assert np.allclose(books.to_numpy(), daily["nav"].to_numpy(), atol=1e-6)
    assert np.allclose(
        daily["nav"].to_numpy(), result.equity.to_numpy(), atol=1e-12
    )


def test_costs_are_charged_from_the_first_run_and_shown_split():
    result = run_backtest(
        panel(60, adv=2e7),
        Fixed({SLEEVE: 0.30}),
        BacktestConfig(max_daily_turnover=0.40),
    )
    breakdown = result.cost_breakdown
    assert breakdown["spread"] > 0.0
    assert breakdown["impact"] > 0.0
    assert breakdown["total"] == pytest.approx(
        breakdown["spread"] + breakdown["impact"]
    )
    # The total travels WITH the components, because metrics' cost
    # sniffing does not know the name "impact_cost" and would otherwise
    # report the spread as the entire cost of trading.
    assert "cost" in result.trades.columns
    assert result.trades["cost"].sum() == pytest.approx(breakdown["total"])


def test_running_the_ladder_makes_the_book_strictly_more_expensive():
    totals = []
    for multiple in (1.0, 2.0, 3.0):
        result = run_backtest(
            panel(60, adv=2e7),
            Fixed({SLEEVE: 0.30}),
            BacktestConfig(
                max_daily_turnover=0.40, cost_model=CostModel(multiple=multiple)
            ),
        )
        totals.append(result.total_cost)
    assert totals[0] < totals[1] < totals[2]
    assert totals[1] == pytest.approx(2.0 * totals[0], rel=0.05)


def test_a_cost_larger_than_the_trade_is_a_bad_input_not_an_expensive_trade():
    market = panel(30, adv=1.0)
    with pytest.raises(BacktestError, match="liquidity input is nonsense"):
        run_backtest(
            market,
            Fixed({SLEEVE: 0.30}),
            BacktestConfig(
                max_daily_turnover=0.40,
                max_participation=None,
                min_trade_notional=1.0,
                cost_model=CostModel(multiple=3.0),
            ),
        )


# -- total-return units ---------------------------------------------------


def test_a_position_is_marked_in_total_return_space():
    """The sleeves rule as arithmetic: TLT returned -2.6% on price and
    +105.8% with coupons over the same window. A book marked at an
    unadjusted price does not understate the defensive half of the
    strategy, it deletes it.

    Here the printed price never moves and the adjusted series climbs
    20%, which is a security whose whole return is distribution. The NAV
    has to climb with it, and the custodian's share count has to climb
    by the same factor — that growing share count IS the reinvestment,
    and a book marked at `close_unadj` would show a flat line for
    twenty per cent of return.
    """
    idx = sessions(60)
    flat = pd.DataFrame(100.0, index=idx, columns=[SLEEVE], dtype="float64")
    adj = pd.DataFrame(
        np.linspace(100.0, 120.0, len(idx))[:, None],
        index=idx,
        columns=[SLEEVE],
        dtype="float64",
    )
    market = MarketData(
        open_unadj=flat,
        close_unadj=flat,
        close_adj=adj,
        dollar_volume=pd.DataFrame(1e11, index=idx, columns=[SLEEVE]),
        daily_volatility=pd.DataFrame(0.01, index=idx, columns=[SLEEVE]),
    )
    result = run_backtest(
        market, BuyAndHold({SLEEVE: 0.30}), BacktestConfig(max_daily_turnover=0.40)
    )
    assert result.equity.iloc[-1] > result.equity.iloc[0]
    assert result.weights[SLEEVE].iloc[-1] > 0.33  # the sleeve grew into the book

    positions = result.final_positions
    assert len(positions) == 1
    # Two spaces, and the gap between them IS the distribution return.
    # `units` is what the engine held; `shares` is what a custodian
    # statement would say, larger by everything reinvested since the
    # position was opened. It is deliberately not a round number — a
    # whole-share purchase drifts fractional under reinvestment, which
    # is an artefact of the convention rather than an odd lot anybody
    # has to clean up.
    factor = float(market.adjustment_factor.iloc[-1][SLEEVE])
    assert factor == pytest.approx(1.20)
    assert positions["shares"].iloc[0] == pytest.approx(
        positions["units"].iloc[0] * factor
    )
    assert positions["shares"].iloc[0] > positions["units"].iloc[0]


def test_a_held_name_that_stops_printing_is_reported_not_forward_filled_silently():
    """A delisting must not become a flat line instead of a loss."""
    idx = sessions(60)
    close = pd.DataFrame(100.0, index=idx, columns=[SLEEVE], dtype="float64")
    close.iloc[40:] = np.nan
    market = MarketData(
        open_unadj=close,
        close_unadj=close,
        close_adj=close,
        dollar_volume=pd.DataFrame(1e11, index=idx, columns=[SLEEVE]),
        daily_volatility=pd.DataFrame(0.01, index=idx, columns=[SLEEVE]),
    )
    result = run_backtest(
        market, BuyAndHold({SLEEVE: 0.30}), BacktestConfig(max_daily_turnover=0.40)
    )
    assert len(result.stale_marks) == 20
    assert set(result.stale_marks["ticker"]) == {SLEEVE}
    assert (result.stale_marks["mark"] == 100.0).all()


# -- buy and hold is a control, not a strategy ----------------------------


def test_buy_and_hold_stops_trading_once_it_is_deployed():
    """The latch is the whole content of the class. A strategy returning
    the same fixed weights every day gets rebalanced back to them every
    day, which harvests a rebalancing premium a genuine buy-and-hold
    investor never saw."""
    hold = BuyAndHold({SLEEVE: 0.30, SINGLE: 0.30})
    result = run_backtest(panel(150), hold, BacktestConfig())
    assert hold.deployed
    last_trade = result.trades["date"].max()
    assert last_trade < result.equity.index[40]
    assert result.daily.loc[result.daily["date"] > last_trade, "n_trades"].sum() == 0


def test_buy_and_hold_needs_at_least_one_weight():
    with pytest.raises(BacktestError, match="at least one target weight"):
        BuyAndHold({})


def test_the_result_summary_carries_the_provenance_it_was_run_under():
    result = run_backtest(panel(30), BuyAndHold({SLEEVE: 0.20}), BacktestConfig())
    row = result.summary().iloc[0]
    assert row["strategy"] == "buy and hold"
    assert row["cost_multiple"] == 1.0
    assert "not tuned" in row["band_provenance"]
    assert row["starting_nav"] == 131_000.0


def test_the_result_hands_itself_to_the_measurement_layer():
    result = run_backtest(panel(300), BuyAndHold({SLEEVE: 0.30}), BacktestConfig())
    report = result.performance(trials=1)
    assert report.n_sessions == len(result.equity) - 1
    assert report.costs.costs_supplied is True
    assert report.deflated is not None


# -- liquidity while the window is still filling ---------------------------


def long_prices(
    n: int,
    *,
    ticker: str = SLEEVE,
    close: float = 100.0,
    volume: float | np.ndarray = 4.0e8,
    start: str = START,
) -> pd.DataFrame:
    """The long `schema.PRICES` shape `from_prices` pivots.

    Flat prices and a volume the caller controls, because every test
    below is about the volume column and a random walk in the price
    would only put noise between the input and the answer.
    """
    idx = sessions(n, start)
    return pd.DataFrame(
        {
            "date": idx,
            "ticker": ticker,
            "open_unadj": close,
            "close_unadj": close,
            "close_adj": close,
            "volume_unadj": np.broadcast_to(
                np.asarray(volume, dtype="float64"), (n,)
            ).astype("float64"),
        }
    )


def test_the_adv_estimate_is_unchanged_once_the_window_has_filled():
    """Only the warm-up is relaxed.

    A cost model that comes back from a bug fix charging less on every
    trade in the sample has not been fixed, it has been softened, and
    the softening would be invisible in any headline number. So the
    steady state is pinned against the rule as it was written: from the
    session the twenty-day window can first be full, the answer has to
    be the same median it always was.
    """
    window = UNIVERSE.dollar_volume_window
    rng = np.random.default_rng(7)
    prices = long_prices(200).assign(
        volume_unadj=rng.lognormal(mean=18.0, sigma=0.6, size=200)
    )

    was = (
        pd.Series(
            prices["close_unadj"].to_numpy() * prices["volume_unadj"].to_numpy(),
            index=pd.DatetimeIndex(prices["date"]),
        )
        .rolling(window, min_periods=max(5, window // 2))
        .median()
    )
    now = MarketData.from_prices(prices).dollar_volume[SLEEVE]

    pd.testing.assert_series_equal(
        now.iloc[window - 1 :], was.iloc[window - 1 :], check_names=False
    )


def test_a_hole_in_the_middle_of_the_sample_is_not_a_warm_up():
    """A window that is short because the volume went missing in year
    three is a different situation, and we know no more about it than we
    did before. It keeps the strict rule and keeps the pessimistic
    default — which is the difference between fixing where the sample
    starts and quietly making the whole book cheaper to trade."""
    window = UNIVERSE.dollar_volume_window
    prices = long_prices(200)
    prices.loc[100 : 100 + window - 5, "volume_unadj"] = np.nan

    adv = MarketData.from_prices(prices).dollar_volume[SLEEVE]
    # The window at this row reaches back over sixteen blank sessions
    # and finds four prints. Four is more than the three a warm-up gets
    # away with, and it still does not answer.
    assert not np.isfinite(adv.iloc[100 + window - 5])


def test_the_warm_up_fills_are_priced_from_the_volume_we_actually_saw():
    """The window needs twenty sessions and the turnover budget deploys
    the book in nineteen, so under a strict window a buy-and-hold run
    never once prices a fill off its own liquidity: the earliest fills
    read a missing ADV and are charged the curve's least-liquid anchor,
    a hundred basis points round trip on the most liquid instrument in
    existence.

    Three sessions of observed volume is a poor estimate of ADV. It is
    also, by a factor of a thousand, a better one than that.
    """
    dollars = np.array([1e10, 3e10, 2e10])
    volume = np.full(120, 4.0e8)
    volume[:3] = dollars / 100.0
    market = MarketData.from_prices(long_prices(120, volume=volume))

    result = run_backtest(
        market,
        BuyAndHold({SLEEVE: 0.90}),
        # The sleeve cap is lifted for the same reason Stage 2 lifts it:
        # a 40% ceiling is a statement about SPY's place in a nine-sleeve
        # book, and this run is one position and a cost model.
        BacktestConfig(apply_sleeve_caps=False),
    )
    trades = result.trades
    bps = 1e4 * trades["spread_cost"] / trades["notional"]

    # The first two fills read one and two sessions of volume. A median
    # of two numbers is their mean, and an outlier cannot be outvoted at
    # that count, so those two keep the pessimistic default — stated
    # here rather than left as an unexplained pair of expensive rows.
    assert (bps.iloc[:2] > 40.0).all()

    # Everything from the third fill on is priced off the curve's floor,
    # which is where a $10bn-a-day tape belongs.
    assert len(trades) >= 15
    assert (bps.iloc[2:] < 1.0).all()

    # And exactly off the volume observed by the decision close: the
    # third fill is decided at session two, which has seen $10bn, $30bn
    # and $20bn, whose median is $20bn.
    third = trades.iloc[2]
    assert third["notional"] / third["participation"] == pytest.approx(2e10)


# -- helpers ---------------------------------------------------------------


def _view(
    weights: Mapping[str, float],
    *,
    assets: tuple[str, ...] = (SLEEVE, SINGLE),
    nav: float = 131_000.0,
) -> MarketView:
    """A hand-built view, for the parts of `_decide` that never need a
    price. Nothing here reads the frames; they exist so the object is
    the same shape the engine builds."""
    idx = sessions(3)
    frame = pd.DataFrame(100.0, index=idx, columns=list(assets), dtype="float64")
    cfg = BacktestConfig()
    return MarketView(
        asof=idx[-1],
        open_unadj=frame,
        close_unadj=frame,
        close_adj=frame,
        dollar_volume=None,
        daily_volatility=None,
        weights=dict(weights),
        nav=nav,
        cash_weight=0.30,
        investable_weight=0.25,
        no_trade_band=cfg.no_trade_band,
        caps={a: cfg.cap_for(a) for a in assets},
    )
