"""The one guarantee the brief asks for in writing: a simulated buy is
never funded from money that has not settled.

The interesting thing about that guarantee is that it cannot be tested
the way a rule normally is. A rule is a branch, and a test for a rule
drives the branch both ways. This is not a rule — it is the claim that
the spending expression does not exist, and the honest way to test a
claim of that shape is to try, adversarially, to write the expression
and find there is nothing to write it with. So the first block below
reaches for the door rather than for the lock: it looks for any name on
the unsettled side that returns spendable money, and it asks the ledger
to spend proceeds on the day of the sale, on the weekend that follows
one, and across a holiday. Each attempt fails for a different reason,
and only one of the three is a check that could be deleted.

The remaining blocks are the things the guarantee is worth nothing
without. Settlement measured in business days off the real exchange
calendar, tested on the two long weekends that break calendar
arithmetic in opposite directions — Thanksgiving, where the holiday
falls mid-week, and Good Friday, where it welds itself onto a weekend.
The buffer, which is our rule and not the law, and which therefore has
to be enforced in one place (sizing) and deliberately not in the other
(paying for a fill that came in worse than planned). The deferral log,
because a constraint that binds silently is a constraint nobody can
argue with. And the NAV invariant, which is the only thing standing
between a plausible equity curve and money that stopped being anywhere.
"""

from __future__ import annotations

import inspect

import pandas as pd
import pytest

from griffinquant.engine import ledger as ledger_mod
from griffinquant.engine.ledger import (
    BUFFER_BAND,
    DEFAULT_BUFFER_FRACTION,
    Deferral,
    DeferralReason,
    InsufficientSettledCash,
    LedgerInvariantError,
    SettledCash,
    SettlementError,
    SettlementLedger,
    UnsettledProceeds,
    UnsettledQueue,
    historical_settlement_cycle,
    is_session,
    settlement_date,
)

# Dates chosen because each one breaks a different piece of calendar
# arithmetic. The Wednesday before Thanksgiving settles Friday, skipping
# a mid-week holiday. The Thursday before Good Friday settles Monday,
# skipping a holiday welded onto a weekend. The ordinary Friday settles
# Monday, which is the case a timedelta gets right and is here so the
# other two are visibly different from it.
PRE_THANKSGIVING = "2025-11-26"  # Wednesday; Thursday 27th is the holiday
THANKSGIVING_FRIDAY = "2025-11-28"
PRE_GOOD_FRIDAY = "2025-04-17"  # Thursday; Friday 18th is Good Friday
EASTER_MONDAY = "2025-04-21"
ORDINARY_FRIDAY = "2025-11-21"
FOLLOWING_MONDAY = "2025-11-24"
SATURDAY = "2025-11-22"


def ledger(cash: float = 100_000.0, **kw) -> SettlementLedger:
    return SettlementLedger(cash, **kw)


# -- the guarantee: there is no door ------------------------------------


def test_nothing_on_the_unsettled_side_hands_out_spendable_money():
    """The type is the enforcement, so the test is an inventory.

    Any of these names appearing on the unsettled side would be a way
    to spend a receivable, and the point of the design is that a
    reviewer can establish there is no such way by reading the class
    rather than by auditing every caller.
    """
    spendable = {
        "withdraw",
        "spend",
        "debit",
        "pay",
        "take",
        "draw",
        "available",
        "total_available",
        "as_settled",
        "settle_now",
    }
    for cls in (UnsettledProceeds, UnsettledQueue):
        leak = spendable & set(dir(cls))
        assert not leak, f"{cls.__name__} exposes {sorted(leak)}"

    # And the settled side does have the one method, so the asymmetry
    # is real rather than an artefact of both types being featureless.
    assert hasattr(SettledCash, "withdraw")


def test_the_only_debit_in_the_module_is_against_settled_cash():
    """Grep, as a test, because this is a claim about the whole file.

    `SettledCash.withdraw` is the only subtraction of money in the
    module. If a second one appears — a convenience that nets a sale
    against a purchase, a "just this once" on a hot path — it will not
    be routed through the type, and this fails.
    """
    source = inspect.getsource(ledger_mod)
    assert source.count("def withdraw") == 1
    body = inspect.getsource(SettlementLedger.record_purchase)
    # It may READ the unsettled total (the assertion below the debit
    # proves it did not change), but it must never subtract from it.
    assert "_unsettled.total" in body
    assert "_unsettled.release" not in body
    assert "self._settled.withdraw" in body


def test_a_sale_cannot_fund_a_buy_on_the_day_of_the_sale():
    """The adversarial case, stated as plainly as it can be.

    Sell fifty thousand dollars of something at ten in the morning and
    try to spend it at ten past. In a margin account this works. Here
    the money is a receivable, `available_to_buy` cannot see it, and
    the refusal is filed under UNSETTLED rather than NO_CASH — because
    the money does exist, it is just not ours to spend yet, and those
    are different findings about the strategy.
    """
    book = ledger(1_000.0)
    book.settle(PRE_THANKSGIVING)
    book.record_sale(50_000.0, PRE_THANKSGIVING, label="TLT")
    nav = 51_000.0

    assert book.unsettled == 50_000.0
    assert book.available_to_buy(nav) == 0.0

    funding = book.fund_purchase(20_000.0, session=PRE_THANKSGIVING, nav=nav)

    assert funding.funded == 0.0
    assert funding.shortfall == 20_000.0
    assert not funding.complete
    assert funding.deferral is not None
    assert funding.deferral.reason is DeferralReason.UNSETTLED
    assert funding.deferral.unsettled == 50_000.0
    # The money is still there and still not spendable.
    assert book.unsettled == 50_000.0
    assert book.settled == 1_000.0


def test_the_day_after_a_friday_sale_is_not_a_day():
    """Reaching for Saturday does not fail late, it fails at the name.

    A cash account's next chance to spend Friday's proceeds is Monday,
    and the way this ledger refuses Saturday is worth more than the
    refusal itself: the date is not a session, so there is no ledger
    operation that accepts it at all. Somebody adding calendar
    arithmetic upstream hits this on the first weekend rather than on
    the first wrong number.
    """
    book = ledger(0.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(10_000.0, ORDINARY_FRIDAY)

    assert not is_session(SATURDAY)
    with pytest.raises(SettlementError, match="not an NYSE session"):
        book.settle(SATURDAY)
    with pytest.raises(SettlementError, match="not an NYSE session"):
        book.fund_purchase(100.0, session=SATURDAY, nav=10_000.0)

    # Monday, and only Monday, turns it into money.
    assert book.settle(FOLLOWING_MONDAY) == 10_000.0
    assert book.settled == 10_000.0


def test_a_holiday_pushes_the_proceeds_a_further_day_out():
    """Wednesday's sale is unspendable on Thursday because there is no
    Thursday, and unspendable on Friday until Friday's settle runs."""
    book = ledger(0.0)
    book.settle(PRE_THANKSGIVING)
    book.record_sale(30_000.0, PRE_THANKSGIVING, label="IEF")

    # Thanksgiving itself.
    with pytest.raises(SettlementError, match="not an NYSE session"):
        book.settle("2025-11-27")

    assert book.settle(THANKSGIVING_FRIDAY) == 30_000.0
    funding = book.fund_purchase(
        25_000.0, session=THANKSGIVING_FRIDAY, nav=30_000.0
    )
    assert funding.complete
    assert funding.funded == 25_000.0


def test_a_day_that_forgot_to_settle_refuses_to_deliberate():
    """The subtle version of the same bug, and the expensive one.

    A loop that skips `settle` does not overdraw anything. It reports
    money that HAS settled as unavailable, and every deferral it writes
    that day is an event that never happened — which is worse than a
    missing row, because the deliverable is the deferral log and this
    quietly inflates it. So the ledger refuses to answer at all while a
    matured receivable is stranded.
    """
    book = ledger(0.0)
    book.settle(PRE_GOOD_FRIDAY)
    book.record_sale(5_000.0, PRE_GOOD_FRIDAY)

    with pytest.raises(SettlementError, match="have not been settled"):
        book.fund_purchase(1_000.0, session=EASTER_MONDAY, nav=5_000.0)

    book.settle(EASTER_MONDAY)
    assert book.fund_purchase(1_000.0, session=EASTER_MONDAY, nav=5_000.0).complete


def test_record_purchase_cannot_reach_the_queue_however_it_is_called():
    """The last line of defence, exercised directly.

    Nothing in the engine calls `record_purchase` with more than
    `available_to_buy` allows. This is the case where somebody's future
    refactor does, and the debit still has to hit a wall rather than
    silently borrow from the receivables sitting next to it.
    """
    book = ledger(0.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(80_000.0, ORDINARY_FRIDAY)

    with pytest.raises(InsufficientSettledCash, match="free-riding"):
        book.record_purchase(10_000.0)
    assert book.unsettled == 80_000.0


def test_a_year_of_interleaved_trading_never_spends_what_has_not_settled():
    """The property, not the anecdote.

    Sells and buys interleaved on a real calendar, at sizes chosen to
    make the ledger say no often. The invariant under test is arithmetic
    rather than structural: the total ever debited cannot exceed the
    opening balance plus everything the queue has released, because
    there is no third source of money.
    """
    sessions = _sessions("2025-01-02", 250)
    book = ledger(50_000.0)
    released = 0.0
    spent = 0.0
    held = 0.0

    for n, day in enumerate(sessions):
        released += book.settle(day)
        nav = book.total_cash + held
        # Alternate: sell a slice, then immediately try to redeploy the
        # whole of it, which is precisely the free-ride the account
        # cannot take.
        if n % 3 == 0 and held > 1_000.0:
            proceeds = held * 0.25
            held -= proceeds
            book.record_sale(proceeds, day, label="rotate")
            funding = book.fund_purchase(proceeds, session=day, nav=nav, label="into")
        else:
            funding = book.fund_purchase(nav * 0.10, session=day, nav=nav, label="add")
        spent += funding.funded
        held += funding.funded
        assert book.settled >= -1e-9

    assert spent <= 50_000.0 + released + 1e-6
    # And the exercise has to have actually been refused something, or
    # the assertion above is vacuous.
    assert any(d.reason is DeferralReason.UNSETTLED for d in book.deferrals)


# -- business-day settlement --------------------------------------------


@pytest.mark.parametrize(
    ("trade", "expected", "why"),
    [
        (ORDINARY_FRIDAY, FOLLOWING_MONDAY, "an ordinary weekend"),
        (PRE_THANKSGIVING, THANKSGIVING_FRIDAY, "Thanksgiving, mid-week"),
        (PRE_GOOD_FRIDAY, EASTER_MONDAY, "Good Friday, welded to a weekend"),
        ("2025-12-24", "2025-12-26", "Christmas"),
        ("2025-07-03", "2025-07-07", "Independence Day into a weekend"),
    ],
)
def test_t_plus_one_walks_the_exchange_calendar(trade, expected, why):
    got = settlement_date(trade)
    assert got == pd.Timestamp(expected), why
    # And where a timedelta would have answered differently, its answer
    # is not a day the exchange was open — which is the whole content of
    # "business days, off the real calendar". The error always runs one
    # way: calendar arithmetic lets the backtest spend sooner.
    naive = pd.Timestamp(trade) + pd.Timedelta(days=1)
    if naive != got:
        assert not is_session(naive)
        assert got > naive


@pytest.mark.parametrize(
    ("cycle", "expected"),
    [(1, "2025-11-28"), (2, "2025-12-01"), (3, "2025-12-02")],
)
def test_longer_cycles_keep_skipping_the_holiday(cycle, expected):
    assert settlement_date(PRE_THANKSGIVING, cycle=cycle) == pd.Timestamp(expected)


def test_same_day_settlement_is_not_expressible():
    with pytest.raises(ValueError, match="at least one business day"):
        settlement_date(ORDINARY_FRIDAY, cycle=0)


def test_the_historical_cycle_is_available_but_not_the_default():
    """T+1 throughout is the generous reading of our own sample, and
    `historical_settlement_cycle` is what lets somebody measure by how
    much rather than argue about it."""
    assert historical_settlement_cycle("2005-11-23") == 3
    assert historical_settlement_cycle("2017-09-05") == 2
    assert historical_settlement_cycle("2024-05-28") == 1
    # The boundaries themselves, which is where an off-by-one lives.
    assert historical_settlement_cycle("2017-09-01") == 3
    assert historical_settlement_cycle("2024-05-24") == 2


def test_a_ledger_running_the_1990s_cycle_waits_three_sessions():
    book = ledger(0.0, settlement_cycle=3)
    book.settle(PRE_THANKSGIVING)
    book.record_sale(1_000.0, PRE_THANKSGIVING)
    assert book.settle(THANKSGIVING_FRIDAY) == 0.0
    assert book.settle("2025-12-01") == 0.0
    assert book.settle("2025-12-02") == 1_000.0


def test_settlement_may_be_pushed_later_but_never_earlier():
    """A broker holding funds is real; a faster-than-legal settlement is
    the module's own bug reintroduced as configuration."""
    book = ledger(0.0)
    book.settle(PRE_THANKSGIVING)
    book.record_sale(500.0, PRE_THANKSGIVING, settles_on="2025-12-05")
    assert book.settle(THANKSGIVING_FRIDAY) == 0.0

    with pytest.raises(SettlementError, match="cannot settle on"):
        book.record_sale(500.0, THANKSGIVING_FRIDAY, settles_on=THANKSGIVING_FRIDAY)


def test_the_clock_only_runs_forward():
    book = ledger(0.0)
    book.settle(FOLLOWING_MONDAY)
    with pytest.raises(SettlementError, match="walked backwards"):
        book.settle(ORDINARY_FRIDAY)


def test_a_skipped_session_does_not_strand_a_receivable():
    """`release_through` is on-or-before rather than on, so a resumed run
    or a data gap cannot silently shrink the account."""
    book = ledger(0.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(2_500.0, ORDINARY_FRIDAY)
    # Monday never happens; Tuesday still gets the money.
    assert book.settle("2025-11-25") == 2_500.0
    assert book.unsettled == 0.0


# -- the buffer ----------------------------------------------------------


def test_the_buffer_is_held_back_from_every_buy():
    book = ledger(100_000.0)
    book.settle(ORDINARY_FRIDAY)
    nav = 100_000.0

    assert book.buffer_amount(nav) == pytest.approx(5_000.0)
    assert book.available_to_buy(nav) == pytest.approx(95_000.0)

    funding = book.fund_purchase(95_000.0, session=ORDINARY_FRIDAY, nav=nav)
    assert funding.complete
    assert book.settled == pytest.approx(5_000.0)


def test_a_buy_stopped_only_by_the_buffer_is_filed_as_our_own_rule():
    """BUFFER and UNSETTLED must not be summarised as one number.

    A year of buffer deferrals says our reserve is too fat for the
    strategy's turnover, which is an argument we can have. A year of
    settlement deferrals is the account type charging rent, which is
    not. Reporting them together makes the first look like the second.
    """
    book = ledger(10_000.0)
    book.settle(ORDINARY_FRIDAY)
    funding = book.fund_purchase(9_800.0, session=ORDINARY_FRIDAY, nav=10_000.0)

    assert funding.deferral is not None
    assert funding.deferral.reason is DeferralReason.BUFFER
    assert funding.funded == pytest.approx(9_500.0)
    assert funding.deferral.available == pytest.approx(9_500.0)


def test_a_shortfall_with_no_money_anywhere_is_not_a_settlement_cost():
    book = ledger(1_000.0)
    book.settle(ORDINARY_FRIDAY)
    funding = book.fund_purchase(50_000.0, session=ORDINARY_FRIDAY, nav=1_000.0)
    assert funding.deferral is not None
    assert funding.deferral.reason is DeferralReason.NO_CASH


def test_paying_for_a_fill_may_dip_into_the_buffer():
    """`available_to_buy` respects the reserve, `record_purchase` does not.

    The decision is sized at a close and fills at the next open, and an
    execution that came in worse than planned is exactly the event the
    buffer exists for. A ledger that refused the overrun would be
    reserving cash for a contingency it then forbade.
    """
    book = ledger(10_000.0)
    book.settle(ORDINARY_FRIDAY)
    assert book.available_to_buy(10_000.0) == pytest.approx(9_500.0)
    book.record_purchase(9_900.0)  # the fill slipped
    assert book.settled == pytest.approx(100.0)


@pytest.mark.parametrize("fraction", [0.0, 0.01, 0.049, 0.101, 0.25, 1.0])
def test_a_buffer_outside_the_band_is_refused(fraction):
    with pytest.raises(ValueError, match="band this account runs on"):
        SettlementLedger(1_000.0, buffer_fraction=fraction)


@pytest.mark.parametrize("fraction", [BUFFER_BAND[0], 0.075, BUFFER_BAND[1]])
def test_the_band_itself_is_accepted_at_both_ends(fraction):
    assert SettlementLedger(1_000.0, buffer_fraction=fraction).buffer_fraction == (
        fraction
    )


def test_the_default_sits_at_the_bottom_of_the_band():
    """Every dollar of buffer above what the job needs is a twenty-year
    cash drag chosen by default rather than argued for."""
    assert DEFAULT_BUFFER_FRACTION == BUFFER_BAND[0]


def test_the_buffer_tracks_nav_rather_than_a_stale_snapshot():
    """NAV is a parameter, not state, so a big move resizes the reserve
    on the day the reserve is what stops an overdraft."""
    book = ledger(20_000.0)
    assert book.available_to_buy(100_000.0) == pytest.approx(15_000.0)
    assert book.available_to_buy(200_000.0) == pytest.approx(10_000.0)
    assert book.available_to_buy(500_000.0) == 0.0


# -- the deferral log ----------------------------------------------------


def test_a_deferral_carries_the_whole_cash_picture():
    """"41 deferrals" invites the question of whether they were near
    misses or the strategy trying to trade money it never had, and only
    the components answer it."""
    book = ledger(4_000.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(1_000.0, ORDINARY_FRIDAY)
    book.fund_purchase(4_800.0, session=ORDINARY_FRIDAY, nav=5_000.0, label="GLD")

    (row,) = book.deferrals
    assert isinstance(row, Deferral)
    assert row.date == pd.Timestamp(ORDINARY_FRIDAY)
    assert row.label == "GLD"
    assert row.settled == 4_000.0
    assert row.unsettled == 1_000.0
    assert row.buffer == pytest.approx(250.0)
    assert row.funded == pytest.approx(3_750.0)
    assert row.shortfall == pytest.approx(1_050.0)
    assert row.reason is DeferralReason.UNSETTLED


def test_the_classification_reads_the_balances_before_the_debit():
    """Reading them afterwards describes the position the refusal itself
    created — which is always short, so every deferral would file under
    NO_CASH and the log would say nothing.

    The figures are chosen so the two readings disagree about the
    ANSWER, not merely about a recorded field: $4,800 is covered by
    settled plus unsettled as they stood before the partial fill, and
    is covered by nothing at all afterwards.
    """
    book = ledger(4_000.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(1_000.0, ORDINARY_FRIDAY)
    book.fund_purchase(4_800.0, session=ORDINARY_FRIDAY, nav=5_000.0)
    assert book.settled == pytest.approx(250.0)  # the partial fill drained it
    assert book.deferrals[0].settled == 4_000.0
    assert book.deferrals[0].reason is DeferralReason.UNSETTLED


def test_refusing_a_partial_fill_moves_nothing_and_still_records():
    book = ledger(4_000.0)
    book.settle(ORDINARY_FRIDAY)
    funding = book.fund_purchase(
        6_000.0, session=ORDINARY_FRIDAY, nav=5_000.0, allow_partial=False
    )
    assert funding.funded == 0.0
    assert book.settled == 4_000.0
    assert len(book.deferrals) == 1


def test_the_empty_deferral_table_is_typed_rather_than_absent():
    """A run with no deferrals still has to produce the columns, or the
    reporting layer branches on emptiness and the two paths drift."""
    empty = ledger().deferrals_frame()
    assert list(empty.columns) == [
        "date",
        "label",
        "reason",
        "intended",
        "funded",
        "shortfall",
        "settled",
        "unsettled",
        "buffer",
    ]
    assert str(empty["date"].dtype).startswith("datetime64")
    assert empty["shortfall"].dtype == "float64"

    by_year = ledger().deferrals_by_year()
    assert by_year.index.name == "year"
    assert by_year.empty


def test_the_yearly_table_splits_the_causes():
    book = ledger(10_000.0)
    book.settle("2025-01-02")
    book.fund_purchase(9_900.0, session="2025-01-02", nav=10_000.0)  # buffer

    book.record_sale(9_000.0, "2025-01-03", label="exit")
    book.fund_purchase(5_000.0, session="2025-01-03", nav=9_500.0)  # unsettled

    book.settle("2025-01-06")
    book.fund_purchase(1e9, session="2025-01-06", nav=9_500.0)  # no cash

    table = book.deferrals_by_year()
    assert list(table.index) == [2025]
    row = table.loc[2025]
    assert row["deferrals"] == 3
    assert row["buffer_deferrals"] == 1
    assert row["unsettled_deferrals"] == 1
    assert row["no_cash_deferrals"] == 1
    assert row["shortfall"] == pytest.approx(
        float(book.deferrals_frame()["shortfall"].sum())
    )


def test_pending_receivables_at_the_end_of_a_run_are_reported_not_lost():
    book = ledger(0.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(700.0, ORDINARY_FRIDAY, label="SPY")
    pending = book.pending()
    assert len(pending) == 1
    assert pending["amount"].iloc[0] == 700.0
    assert pending["settles_on"].iloc[0] == pd.Timestamp(FOLLOWING_MONDAY)


# -- the NAV invariant ---------------------------------------------------


def test_the_books_reconcile_through_a_full_sell_wait_buy_cycle():
    """settled + unsettled + market value == NAV at every step.

    Checked at each stage rather than only at the end, because the
    failure this catches — proceeds released twice, a debit with no
    position behind it — produces a plausible curve and nothing else.
    """
    book = ledger(100_000.0)
    market_value = 0.0
    nav = 100_000.0

    book.settle(ORDINARY_FRIDAY)
    book.check_invariant(market_value, nav, where="open")

    funding = book.fund_purchase(60_000.0, session=ORDINARY_FRIDAY, nav=nav)
    market_value += funding.funded
    book.check_invariant(market_value, nav, where="after the buy")

    # A 10% mark-up on the position: NAV moves, the cash books do not.
    market_value *= 1.10
    nav = book.total_cash + market_value
    book.check_invariant(market_value, nav, where="after the mark")

    proceeds = market_value * 0.5
    market_value -= proceeds
    book.record_sale(proceeds, ORDINARY_FRIDAY)
    book.check_invariant(market_value, nav, where="after the sale")

    book.settle(FOLLOWING_MONDAY)
    book.check_invariant(market_value, nav, where="after settlement")
    assert book.unsettled == 0.0
    assert book.settled == pytest.approx(nav - market_value)


def test_a_lost_dollar_is_reported_rather_than_absorbed():
    book = ledger(1_000.0)
    with pytest.raises(LedgerInvariantError, match="does not reconcile"):
        book.check_invariant(0.0, 1_001.0, where="the missing dollar")


def test_the_invariant_tolerates_float_residue_and_nothing_more():
    book = ledger(131_000.0)
    book.check_invariant(0.0, 131_000.0 + 1e-9)
    with pytest.raises(LedgerInvariantError):
        book.check_invariant(0.0, 131_000.0 + 0.01)


def test_residual_names_the_direction_of_the_gap():
    book = ledger(1_000.0)
    assert book.residual(500.0, 1_400.0) == pytest.approx(100.0)
    assert book.residual(500.0, 1_600.0) == pytest.approx(-100.0)


# -- the small refusals --------------------------------------------------


def test_settled_cash_refuses_to_go_negative_or_to_be_built_negative():
    with pytest.raises(SettlementError, match="cannot be negative"):
        SettledCash(-0.01)
    with pytest.raises(ValueError, match="non-negative"):
        SettledCash(10.0).deposit(-1.0)
    with pytest.raises(ValueError, match="non-negative"):
        SettledCash(10.0).withdraw(-1.0)


def test_proceeds_coerce_their_dates_at_construction():
    """Strings compared against Timestamps inside `release_through` would
    raise three simulated days away from the line that caused it."""
    p = UnsettledProceeds(
        amount=1.0, trade_date="2025-11-21", settles_on="2025-11-24"
    )
    assert isinstance(p.trade_date, pd.Timestamp)
    assert isinstance(p.settles_on, pd.Timestamp)


def test_a_negative_purchase_is_a_caller_bug_not_a_deposit():
    book = ledger(1_000.0)
    book.settle(ORDINARY_FRIDAY)
    with pytest.raises(ValueError, match="non-negative"):
        book.fund_purchase(-100.0, session=ORDINARY_FRIDAY, nav=1_000.0)


def test_a_zero_settlement_cycle_ledger_cannot_be_built():
    with pytest.raises(ValueError, match="at least 1"):
        SettlementLedger(1_000.0, settlement_cycle=0)


def test_a_date_outside_the_built_calendar_says_so_rather_than_clamping():
    with pytest.raises(SettlementError, match="outside the built NYSE calendar"):
        settlement_date("1975-06-02")


def test_the_repr_says_enough_to_debug_from():
    book = ledger(1_000.0)
    book.settle(ORDINARY_FRIDAY)
    book.record_sale(50.0, ORDINARY_FRIDAY)
    text = repr(book)
    assert "settled=$1,000.00" in text
    assert "unsettled=$50.00" in text
    assert "2025-11-21" in text


# -- helpers -------------------------------------------------------------


def _sessions(start: str, count: int) -> pd.DatetimeIndex:
    """`count` real NYSE sessions from `start`, using the ledger's own
    calendar so the fixture cannot disagree with the code under test."""
    all_sessions = ledger_mod._sessions()
    first = int(all_sessions.searchsorted(pd.Timestamp(start), side="left"))
    return all_sessions[first : first + count]
