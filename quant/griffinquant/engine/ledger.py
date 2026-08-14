"""Cash that has settled, and cash that merely exists.

In a cash account the proceeds of a sale are not money yet. They are a
receivable that becomes money on the settlement date, and buying with
them before then is a good-faith violation: the broker restricts the
account for ninety days after the second one, and no amount of
after-the-fact explanation unwinds it. A backtest that nets sales
against purchases on the same day has quietly assumed a margin
facility this account does not have, and the borrowed day is worth
real return in exactly the conditions the strategy is supposed to
survive — a drawdown, where everything wants to be sold and rebought
at once.

So the design here is not a check, it is a shape. Settled cash and
unsettled proceeds are two different TYPES. `withdraw` exists on the
first and nowhere on the second, which means there is no expression
anywhere in this file that spends money that has not settled — the bug
is not caught, it is unwriteable. The assertion in `record_purchase`
is a second line of defence against the refactor that flattens the two
balances into one convenient float.

Two smaller things worth knowing before reading on.

The buffer is not the same rule as settlement. Settlement is the law;
the buffer is our own margin for error, because the decision is made
at a close and the fill happens at the next open and the price in
between is not ours to choose. `available_to_buy` respects the buffer,
`record_purchase` does not — an execution that came in worse than
planned is precisely what the buffer is for, and a ledger that refused
to let it dip in would be reserving cash for an event it then forbade.

And T+1 is the generous reading of our own sample. US equities
settled T+3 until September 2017 and T+2 until May 2024; a 2005-2026
backtest run entirely at T+1 therefore understates how often the real
account would have been stuck waiting. `historical_settlement_cycle`
is here so that can be measured rather than assumed away.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from functools import lru_cache

import pandas as pd

__all__ = [
    "DEFAULT_BUFFER_FRACTION",
    "BUFFER_BAND",
    "Deferral",
    "DeferralReason",
    "Funding",
    "InsufficientSettledCash",
    "LedgerInvariantError",
    "SettledCash",
    "SettlementError",
    "SettlementLedger",
    "UnsettledProceeds",
    "UnsettledQueue",
    "historical_settlement_cycle",
    "is_session",
    "settlement_date",
]


# -- the calendar -------------------------------------------------------

#: Explicit bounds, not the library default. `exchange_calendars` builds
#: XNYS over a rolling twenty-year window ending near today, so a
#: settlement date computed for 2005 on a 2026 machine would come from a
#: calendar that does not contain 2005. Widening it here makes the
#: answer a function of the trade date and nothing else.
CALENDAR_START = pd.Timestamp("1990-01-01")
CALENDAR_END = pd.Timestamp("2035-12-31")

#: The two dates the US settlement cycle actually shortened on.
_T2_EFFECTIVE = pd.Timestamp("2017-09-05")
_T1_EFFECTIVE = pd.Timestamp("2024-05-28")


@lru_cache(maxsize=1)
def _sessions() -> pd.DatetimeIndex:
    import exchange_calendars as xcals

    cal = xcals.get_calendar("XNYS", start=CALENDAR_START, end=CALENDAR_END)
    sess = pd.DatetimeIndex(cal.sessions)
    if sess.tz is not None:
        sess = sess.tz_localize(None)
    return pd.DatetimeIndex(sess.normalize(), dtype="datetime64[ns]")


def _as_day(value) -> pd.Timestamp:
    day = pd.Timestamp(value)
    if day.tz is not None:
        day = day.tz_localize(None)
    day = day.normalize()
    if not (CALENDAR_START <= day <= CALENDAR_END):
        raise SettlementError(
            f"{day.date()} is outside the built NYSE calendar "
            f"({CALENDAR_START.date()}..{CALENDAR_END.date()}). Widen "
            "CALENDAR_END rather than letting a settlement date clamp "
            "to the last session it happens to know about."
        )
    return day


def is_session(value) -> bool:
    """Whether the NYSE was open on this date."""
    return _as_day(value) in _sessions()


def settlement_date(trade_date, *, cycle: int = 1) -> pd.Timestamp:
    """The session `cycle` business days after `trade_date`.

    Business days off the real exchange calendar, never calendar
    arithmetic. A Friday sale settles Monday; a Friday before Memorial
    Day settles Tuesday; the Thursday before Independence Day settles
    the following Monday. Adding a timedelta gets all three wrong in
    the direction that flatters the backtest.
    """
    if cycle < 1:
        raise ValueError(
            f"settlement cycle must be at least one business day, got {cycle}; "
            "same-day settlement is not a thing this account may assume"
        )
    day = _as_day(trade_date)
    sessions = _sessions()
    # side="right" is the first session STRICTLY after the trade date,
    # which is T+1 whether or not the trade date is itself a session.
    idx = int(sessions.searchsorted(day, side="right")) + cycle - 1
    if idx >= len(sessions):
        raise SettlementError(
            f"T+{cycle} from {day.date()} runs past the end of the built "
            f"calendar ({CALENDAR_END.date()})"
        )
    return sessions[idx]


def historical_settlement_cycle(trade_date) -> int:
    """What the cycle actually was on that date: 3, then 2, then 1.

    Not used by default — the mandate models T+1 throughout — but the
    difference is not cosmetic. Before September 2017 a sale funded
    nothing for three sessions, and a rebalance that sells to buy would
    have deferred far more often than the T+1 run reports. Pass this
    into `settlement_date` for the sensitivity run that says by how
    much.
    """
    day = _as_day(trade_date)
    if day >= _T1_EFFECTIVE:
        return 1
    if day >= _T2_EFFECTIVE:
        return 2
    return 3


# -- errors -------------------------------------------------------------


class SettlementError(RuntimeError):
    """Something was asked of the ledger that a cash account cannot do."""


class InsufficientSettledCash(SettlementError):
    """A purchase was attempted against money that has not settled.

    Distinct from a deferral. A deferral is the system behaving
    correctly — it wanted to buy, it could not fund it, it wrote that
    down. This is the system trying to spend money it does not have,
    which is a bug in the caller.
    """


class LedgerInvariantError(SettlementError):
    """settled + unsettled + market value stopped equalling NAV."""


# -- money, in two kinds that do not mix --------------------------------

#: Sub-cent noise. Float arithmetic on six-figure balances leaves
#: residue at about this scale, and a deferral log full of $0.0000001
#: shortfalls hides the deferrals that meant something.
_EPS = 1e-9


@dataclass(frozen=True)
class SettledCash:
    """Money that has settled, and therefore the only money spendable.

    This type is the enforcement mechanism. `withdraw` lives here and
    on nothing else in this module, so a purchase can only ever be
    written as a function of a settled balance. Unsettled proceeds are
    not merely forbidden to a buyer, they are out of scope: there is no
    name in the expression that reaches them.
    """

    amount: float = 0.0

    def __post_init__(self) -> None:
        if self.amount < -_EPS:
            raise SettlementError(f"settled cash cannot be negative: {self.amount}")

    def deposit(self, amount: float) -> SettledCash:
        if amount < 0:
            raise ValueError(f"deposit must be non-negative, got {amount}")
        return SettledCash(self.amount + amount)

    def withdraw(self, amount: float) -> SettledCash:
        if amount < 0:
            raise ValueError(f"withdrawal must be non-negative, got {amount}")
        if amount > self.amount + _EPS:
            raise InsufficientSettledCash(
                f"tried to spend ${amount:,.2f} against ${self.amount:,.2f} of "
                "settled cash. In a cash account the shortfall is not a "
                "rounding problem, it is a free-riding violation."
            )
        return SettledCash(max(0.0, self.amount - amount))


@dataclass(frozen=True)
class UnsettledProceeds:
    """One sale's money, and the date it becomes money."""

    amount: float
    trade_date: pd.Timestamp
    settles_on: pd.Timestamp
    label: str | None = None

    def __post_init__(self) -> None:
        # Coerced rather than merely annotated: a caller who hands in
        # date strings would otherwise compare strings to Timestamps
        # inside `release_through` and get a TypeError three days of
        # simulation later, nowhere near the line that caused it.
        object.__setattr__(self, "trade_date", pd.Timestamp(self.trade_date))
        object.__setattr__(self, "settles_on", pd.Timestamp(self.settles_on))
        if self.amount < 0:
            raise ValueError(f"sale proceeds must be non-negative, got {self.amount}")
        if self.settles_on <= self.trade_date:
            raise SettlementError(
                f"proceeds of a {self.trade_date.date()} sale cannot settle on "
                f"{self.settles_on.date()} — settlement is at least T+1"
            )


class UnsettledQueue:
    """Receivables waiting for their settlement date.

    Read the methods and notice what is missing: there is no
    `withdraw`, no `spend`, no `total_available`. The only way a dollar
    leaves this queue is `release_through`, which takes a session and
    hands maturity-dated money to the caller. Money cannot get out of
    here early because there is no door.
    """

    def __init__(self) -> None:
        self._pending: list[UnsettledProceeds] = []

    def add(self, proceeds: UnsettledProceeds) -> None:
        self._pending.append(proceeds)

    def release_through(
        self, session: pd.Timestamp
    ) -> tuple[float, list[UnsettledProceeds]]:
        """Everything that has matured on or before `session`.

        On or before, not on. A simulation that skips a session — a
        data gap, a resumed run — must not strand a receivable in here
        forever, silently shrinking the account.
        """
        matured = [p for p in self._pending if p.settles_on <= session]
        if matured:
            self._pending = [p for p in self._pending if p.settles_on > session]
        return float(sum(p.amount for p in matured)), matured

    def matured_count(self, session: pd.Timestamp) -> int:
        return sum(1 for p in self._pending if p.settles_on <= session)

    @property
    def total(self) -> float:
        return float(sum(p.amount for p in self._pending))

    def __len__(self) -> int:
        return len(self._pending)

    def __iter__(self):
        return iter(self._pending)

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "trade_date": pd.Series(
                    [p.trade_date for p in self._pending], dtype="datetime64[ns]"
                ),
                "settles_on": pd.Series(
                    [p.settles_on for p in self._pending], dtype="datetime64[ns]"
                ),
                "amount": pd.Series(
                    [p.amount for p in self._pending], dtype="float64"
                ),
                "label": pd.Series([p.label for p in self._pending], dtype="str"),
            }
        )


# -- deferrals ----------------------------------------------------------


class DeferralReason(Enum):
    """Why the buy did not happen, at the level of blame that matters.

    Separating these is the point. UNSETTLED is a cost of the account
    type and would not exist on margin — it is the honest price of the
    constraint. BUFFER is our own policy and can be argued with.
    NO_CASH is neither: the money was not there on any accounting, and
    reporting it as a settlement cost would blame T+1 for a portfolio
    that was simply fully invested.
    """

    UNSETTLED = "unsettled_proceeds"
    BUFFER = "settled_cash_buffer"
    NO_CASH = "no_cash"


@dataclass(frozen=True)
class Deferral:
    """A buy the ledger could not fund, with enough context to argue.

    Carries the whole cash picture at the moment of refusal, not just
    the shortfall. A year-end table saying "41 deferrals" invites the
    question of whether they were near misses or the strategy trying to
    trade money it never had, and only the components answer it.
    """

    date: pd.Timestamp
    intended: float
    funded: float
    shortfall: float
    reason: DeferralReason
    settled: float
    unsettled: float
    buffer: float
    label: str | None = None

    @property
    def available(self) -> float:
        return max(0.0, self.settled - self.buffer)


@dataclass(frozen=True)
class Funding:
    """The outcome of asking the ledger to pay for something."""

    intended: float
    funded: float
    shortfall: float
    deferral: Deferral | None = None

    @property
    def complete(self) -> bool:
        return self.deferral is None


# -- the ledger ---------------------------------------------------------

#: Five per cent of NAV, held back from every buy.
#:
#: The band is 5-10% and this is the bottom of it, on purpose. The
#: buffer's job is to absorb the gap between the price the decision was
#: sized at (the close) and the price it fills at (the next open), plus
#: commissions and the rounding to whole shares. One overnight move on a
#: diversified book almost never eats five per cent of NAV. Every dollar
#: above what the job needs is a dollar sitting in cash for twenty
#: years, which is not neutral — it is a permanent drag chosen by
#: default. Raise it deliberately and say why, or leave it here.
DEFAULT_BUFFER_FRACTION = 0.05

#: The account-level band. Outside it the number is not a buffer: below,
#: it cannot absorb an ordinary gap; above, the cash drag is a strategy
#: decision masquerading as a safety setting.
BUFFER_BAND = (0.05, 0.10)


class SettlementLedger:
    """Settled cash, unsettled proceeds, and the wall between them.

    The engine's day looks like this: `settle(session)` first thing, so
    yesterday's sales become spendable; then `fund_purchase` per target
    buy, which either pays or writes a deferral; `record_sale` as
    positions are exited, dating the proceeds forward. Nothing else can
    move money.
    """

    def __init__(
        self,
        opening_cash: float = 0.0,
        *,
        buffer_fraction: float = DEFAULT_BUFFER_FRACTION,
        settlement_cycle: int = 1,
    ) -> None:
        lo, hi = BUFFER_BAND
        if not (lo - 1e-12 <= buffer_fraction <= hi + 1e-12):
            raise ValueError(
                f"buffer_fraction {buffer_fraction:.4f} is outside the "
                f"{lo:.0%}-{hi:.0%} band this account runs on"
            )
        if settlement_cycle < 1:
            raise ValueError(
                f"settlement_cycle must be at least 1, got {settlement_cycle}; "
                "a ledger that settles same-day is not modelling a cash account"
            )
        self._settled = SettledCash(float(opening_cash))
        self._unsettled = UnsettledQueue()
        self.buffer_fraction = float(buffer_fraction)
        self.settlement_cycle = int(settlement_cycle)
        self._deferrals: list[Deferral] = []
        #: How far the simulation has advanced. Time runs one way.
        self._clock: pd.Timestamp | None = None

    # -- balances -------------------------------------------------------

    @property
    def settled(self) -> float:
        return self._settled.amount

    @property
    def unsettled(self) -> float:
        return self._unsettled.total

    @property
    def total_cash(self) -> float:
        """Both kinds, for NAV only.

        Deliberately never consulted by any funding decision — it exists
        so the invariant below can be stated, and if it ever appears in
        a purchase path that is the bug this module is about.
        """
        return self._settled.amount + self._unsettled.total

    def buffer_amount(self, nav: float) -> float:
        return max(0.0, float(nav)) * self.buffer_fraction

    def available_to_buy(self, nav: float) -> float:
        """Settled cash, less the buffer. Never a cent more.

        NAV is a parameter rather than state because the buffer is a
        fraction of it and NAV moves with every mark. A ledger holding
        its own stale NAV would size today's buffer off yesterday's
        prices and be quietly wrong on exactly the days — big moves —
        when the buffer is what stops an overdraft.
        """
        return max(0.0, self._settled.amount - self.buffer_amount(nav))

    # -- the two ways money moves ---------------------------------------

    def record_sale(
        self,
        amount: float,
        trade_date,
        settles_on=None,
        *,
        label: str | None = None,
    ) -> UnsettledProceeds:
        """Book sale proceeds as a receivable, not as cash.

        `settles_on` defaults to the calendar T+1 and may be pushed
        later (a broker holding funds, a historical cycle) but never
        earlier: encoding a faster-than-legal settlement here would
        reintroduce, as configuration, the exact bug the type system
        above is preventing.
        """
        day = self._require_session(trade_date, what="trade date")
        earliest = settlement_date(day, cycle=self.settlement_cycle)
        due = (
            earliest
            if settles_on is None
            else self._require_session(settles_on, what="settlement date")
        )
        if due < earliest:
            raise SettlementError(
                f"a {day.date()} sale cannot settle on {due.date()}; the "
                f"cycle in force here is T+{self.settlement_cycle}, which is "
                f"{earliest.date()}"
            )
        proceeds = UnsettledProceeds(
            amount=float(amount), trade_date=day, settles_on=due, label=label
        )
        self._unsettled.add(proceeds)
        return proceeds

    def record_purchase(self, amount: float) -> None:
        """Debit settled cash. The only debit in the module.

        Note what is NOT enforced here: the buffer. The buffer is a
        sizing rule, applied by `available_to_buy` when the trade is
        planned; a fill that came in above the plan has to be payable
        or the reserve was decorative. What is enforced is the legal
        constraint — you cannot spend what has not settled.

        The debit is immediate even though the cash physically leaves
        at T+1, and that asymmetry with `record_sale` is deliberate:
        what is being modelled is buying power, and money already
        committed to a purchase is not available for a second one on
        the same day. Deferring the debit would hand the strategy the
        same dollar twice, which is the mirror image of the bug this
        whole module exists to prevent.
        """
        unsettled_before = self._unsettled.total

        self._settled = self._settled.withdraw(float(amount))

        # Both defences exist and they defend against different things.
        # The TYPE is the real one: `withdraw` is a method on
        # SettledCash, which has no field for unsettled money, so this
        # line cannot reach the queue however it is edited. The
        # ASSERTIONS are for the future refactor that decides two
        # balances are a needless complication and merges them into one
        # float — at which point the type is gone, and these are what
        # fail the first time a sale funds a same-day buy. They are
        # cheap, and Python strips them under -O, which is the other
        # reason the type has to be the primary defence rather than the
        # check.
        assert self._settled.amount >= -_EPS, "settled cash went negative"
        assert self._unsettled.total == unsettled_before, (
            "a purchase changed the unsettled balance — settled and "
            "unsettled money have been merged somewhere upstream"
        )

    def settle(self, session) -> float:
        """Roll everything matured on or before `session` into cash."""
        day = self._require_session(session, what="settlement session")
        if self._clock is not None and day < self._clock:
            raise SettlementError(
                f"asked to settle {day.date()} after the ledger had already "
                f"reached {self._clock.date()}; a settlement queue walked "
                "backwards releases the same proceeds twice"
            )
        self._clock = day
        released, _matured = self._unsettled.release_through(day)
        if released:
            self._settled = self._settled.deposit(released)
        return released

    # -- funding a target buy -------------------------------------------

    def fund_purchase(
        self,
        intended: float,
        *,
        session,
        nav: float,
        label: str | None = None,
        allow_partial: bool = True,
    ) -> Funding:
        """Pay for as much of `intended` as settled cash allows.

        Every shortfall becomes a `Deferral` row. Partial funding is the
        default because it is what the account would actually do — buy
        what it can now, want the rest — and the deferral records the
        part that did not happen so the year-end table counts the
        constraint rather than the intention.
        """
        day = self._require_session(session, what="session")
        want = float(intended)
        if want < 0:
            raise ValueError(f"purchase amount must be non-negative, got {want}")

        # A caller who skipped `settle` would see money that is in fact
        # available reported as unavailable, and the deferral log — the
        # deliverable — would fill with events that never happened.
        # Refuse rather than fabricate.
        stranded = self._unsettled.matured_count(day)
        if stranded:
            raise SettlementError(
                f"{stranded} receivable(s) matured on or before {day.date()} "
                "and have not been settled; call settle(session) at the top "
                "of the day or every deferral logged today is fictional"
            )

        buffer = self.buffer_amount(nav)
        # Snapshot before the debit. The reason a buy was deferred is a
        # statement about the cash position that refused it, and reading
        # it back off the balance afterwards describes the position the
        # refusal itself created — which is always short, so every
        # deferral would file under NO_CASH.
        settled_before = self._settled.amount
        unsettled = self._unsettled.total
        available = max(0.0, settled_before - buffer)

        if want <= available + _EPS:
            self.record_purchase(want)
            return Funding(intended=want, funded=want, shortfall=0.0)

        funded = available if allow_partial else 0.0
        if funded > _EPS:
            self.record_purchase(funded)
        else:
            funded = 0.0
        shortfall = want - funded

        deferral = Deferral(
            date=day,
            intended=want,
            funded=funded,
            shortfall=shortfall,
            reason=self._classify(want, settled=settled_before, unsettled=unsettled),
            settled=settled_before,
            unsettled=unsettled,
            buffer=buffer,
            label=label,
        )
        self._deferrals.append(deferral)
        return Funding(
            intended=want, funded=funded, shortfall=shortfall, deferral=deferral
        )

    @staticmethod
    def _classify(
        intended: float, *, settled: float, unsettled: float
    ) -> DeferralReason:
        """Attribute the shortfall to the constraint that actually bound.

        Ordered from the most specific claim to the least, and each
        branch is exactly true where it fires. If settled cash alone
        covered the trade, nothing but our own buffer stopped it. If
        settled plus unsettled covered it, the money exists and the
        settlement cycle is the whole story. Otherwise the account was
        short regardless of how anything settles, and calling that a
        T+1 cost would flatter the constraint at the strategy's
        expense.

        Balances are arguments, not state, so the classification cannot
        drift onto a post-debit view of the account.
        """
        if intended <= settled + _EPS:
            return DeferralReason.BUFFER
        if intended <= settled + unsettled + _EPS:
            return DeferralReason.UNSETTLED
        return DeferralReason.NO_CASH

    # -- the invariant ---------------------------------------------------

    def residual(self, market_value: float, nav: float) -> float:
        """How far the books are from NAV. Zero, or something is lost."""
        return (self.total_cash + float(market_value)) - float(nav)

    def check_invariant(
        self,
        market_value: float,
        nav: float,
        *,
        atol: float = 1e-6,
        rtol: float = 1e-9,
        where: str = "",
    ) -> None:
        """settled + unsettled + market value == NAV, to float tolerance.

        Callable after any operation, and worth calling after all of
        them in tests. The failure this catches is money that stopped
        being anywhere: proceeds released twice, a purchase debited
        without a position booked, a settlement date that fell outside
        the loop. Each of those shows up as a plausible equity curve
        and as nothing else at all.
        """
        gap = self.residual(market_value, nav)
        tol = max(atol, rtol * abs(float(nav)))
        if abs(gap) > tol:
            site = f" at {where}" if where else ""
            raise LedgerInvariantError(
                f"ledger does not reconcile{site}: settled "
                f"${self.settled:,.2f} + unsettled ${self.unsettled:,.2f} + "
                f"market ${float(market_value):,.2f} = "
                f"${self.total_cash + float(market_value):,.2f}, but NAV is "
                f"${float(nav):,.2f} (off by ${gap:,.6f}, tolerance "
                f"${tol:,.6f})"
            )

    # -- reporting -------------------------------------------------------

    @property
    def deferrals(self) -> tuple[Deferral, ...]:
        return tuple(self._deferrals)

    def pending(self) -> pd.DataFrame:
        """Receivables still in flight. Non-empty at the end of a run
        means the last sales never settled inside the sample, which is
        a real (small) drag and not an error."""
        return self._unsettled.frame()

    def deferrals_frame(self) -> pd.DataFrame:
        cols = {
            "date": "datetime64[ns]",
            "label": "str",
            "reason": "str",
            "intended": "float64",
            "funded": "float64",
            "shortfall": "float64",
            "settled": "float64",
            "unsettled": "float64",
            "buffer": "float64",
        }
        if not self._deferrals:
            return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
        rows = [
            {
                "date": d.date,
                "label": d.label,
                "reason": d.reason.value,
                "intended": d.intended,
                "funded": d.funded,
                "shortfall": d.shortfall,
                "settled": d.settled,
                "unsettled": d.unsettled,
                "buffer": d.buffer,
            }
            for d in self._deferrals
        ]
        df = pd.DataFrame(rows)
        return df.astype({c: t for c, t in cols.items() if c in df.columns})

    def deferrals_by_year(self) -> pd.DataFrame:
        """The table the brief asks for, split by cause.

        Split, because a year of buffer deferrals and a year of
        settlement deferrals are different findings: the first says our
        reserve is too fat for the strategy's turnover, the second is
        the account type charging rent. A single count per year reads
        as one phenomenon and is usually two.
        """
        cols = {
            "deferrals": "int64",
            "intended": "float64",
            "shortfall": "float64",
            "worst_shortfall": "float64",
            "unsettled_deferrals": "int64",
            "buffer_deferrals": "int64",
            "no_cash_deferrals": "int64",
        }
        df = self.deferrals_frame()
        if df.empty:
            out = pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})
            out.index = pd.Index([], dtype="int64", name="year")
            return out

        df = df.assign(
            year=df["date"].dt.year,
            is_unsettled=(df["reason"] == DeferralReason.UNSETTLED.value),
            is_buffer=(df["reason"] == DeferralReason.BUFFER.value),
            is_no_cash=(df["reason"] == DeferralReason.NO_CASH.value),
        )
        grouped = df.groupby("year", sort=True)
        out = grouped.agg(
            deferrals=("shortfall", "size"),
            intended=("intended", "sum"),
            shortfall=("shortfall", "sum"),
            worst_shortfall=("shortfall", "max"),
            unsettled_deferrals=("is_unsettled", "sum"),
            buffer_deferrals=("is_buffer", "sum"),
            no_cash_deferrals=("is_no_cash", "sum"),
        )
        return out.astype(cols)

    # -- internals -------------------------------------------------------

    def _require_session(self, value, *, what: str) -> pd.Timestamp:
        day = _as_day(value)
        if day not in _sessions():
            raise SettlementError(
                f"{what} {day.date()} is not an NYSE session; settlement "
                "advances in business days, and a weekend or holiday date "
                "here means calendar arithmetic leaked in somewhere"
            )
        return day

    def __repr__(self) -> str:
        clock = self._clock.date() if self._clock is not None else "unstarted"
        return (
            f"SettlementLedger(settled=${self.settled:,.2f}, "
            f"unsettled=${self.unsettled:,.2f} in {len(self._unsettled)} lot(s), "
            f"buffer={self.buffer_fraction:.0%}, deferrals={len(self._deferrals)}, "
            f"clock={clock})"
        )
