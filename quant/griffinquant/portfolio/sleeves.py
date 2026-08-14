"""The nine sleeves, their weight caps, and the two places where the
history simply is not there.

A sleeve is one liquid ETF plus a hard ceiling on how much of the book
it may ever be. Every ceiling is a prior, argued in the comment above
it and never tuned. Cash absorbs whatever weight the process does not
allocate and there is no leverage, so a cap can only ever bind on the
way up — it can stop the book loading into something, it can never
force it to hold anything.

The trap this file exists to close is the quiet start date. Two of the
nine vehicles do not reach the 2005 sample start: DBC lists thirteen
months in, BIL two and a half years in. The natural thing for a
backtest to do is begin each sleeve wherever its data happens to
appear, which produces a 2005 book that is really eight sleeves and a
hand-built cash leg, reported as though it were nine live vehicles.

So every gap is a `Splice` row — the sleeve, the range, what stood in,
and one line saying why. `spliced_periods` hands a renderer the ones
touching its window, so a result can print "these dates depend on a
splice" without knowing anything about sleeves. A period with no
substitute at all is still a Splice, with `substitute` set to None,
because "we had no commodity exposure for the first thirteen months"
is a finding. Reaching for a proxy to avoid printing it is how a
backtest quietly acquires an instrument nobody could have held.

One inherited rule, restated because it lands hardest here. Every
number a sleeve produces is a TOTAL return. Over 2004-2026 TLT
returned -2.6% on price and +105.8% with coupons; LQD -3.2% and
+141.4%; BIL's price is flat by construction and effectively all of it
is distribution. A sleeve return computed off `close_unadj` does not
understate the defensive half of the strategy, it deletes it. Returns
read `close_adj`. Screens and sizing read `close_unadj`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from ..config import SAMPLE_START

#: Government paper and corporate credit are split rather than lumped
#: into one "bond" bucket because they stop behaving alike exactly when
#: it matters. In March 2020 Treasuries rallied while investment grade
#: sold off with equities; a risk model that had them in one class
#: would have called that a single sleeve disagreeing with itself.
ASSET_CLASSES: frozenset[str] = frozenset(
    {"equity", "government_bond", "credit", "real_asset", "cash"}
)

#: How precisely the live probe pinned an inception. See the note on
#: `Sleeve.inception`.
_INCEPTION_PRECISIONS: frozenset[str] = frozenset({"day", "month", "year"})

#: The residual absorber, named once so the optimiser and the reporting
#: layer are not each string-matching "cash" in their own file.
CASH_SLEEVE_KEY = "cash"

#: The early cash leg is built from this FRED series, not from a
#: ticker. Deliberately NOT in `SLEEVE_TICKERS`: it is not tradable,
#: it does not come from the price source, and an allowlist that
#: contains things the price source cannot serve stops being an
#: allowlist and becomes a wish list.
CASH_FRED_SERIES = "DTB3"


@dataclass(frozen=True)
class Sleeve:
    """One asset-class sleeve and the most of the book it may become."""

    key: str
    name: str
    ticker: str
    max_weight: float
    asset_class: str

    # First date the vehicle actually traded, measured from a live
    # probe rather than derived from a fund fact sheet. Where the probe
    # resolved only to a month or a year the date here is the START of
    # that period and `inception_precision` says so. That is safe for
    # this sample and only for this sample: every coarse inception
    # below predates the 2005 start by three years or more, so no check
    # can be decided by the missing digits. The three that land near or
    # inside the window — GLD, DBC, BIL — are all pinned to the day. If
    # the sample start ever moves before 2002, re-probe rather than
    # trusting these.
    inception: date
    inception_precision: str = "day"

    def available_on(self, day: date | datetime | str) -> bool:
        """Did this vehicle exist on `day`?

        Coarse inceptions answer from the start of their period, which
        over-claims by at most a few weeks in 2001-2003 and never
        inside the sample.
        """
        return _as_date(day) >= self.inception


@dataclass(frozen=True)
class Splice:
    """A stretch of a sleeve's history that its own vehicle cannot cover.

    `substitute` is None when the honest answer is that there was
    nothing to hold. That is not a missing value to be filled in later;
    it is the record of a period the strategy ran a sleeve short, and
    every result covering it has to say so.
    """

    sleeve: str
    start: date
    end: date
    substitute: str | None
    justification: str

    # Set only when the substitute is an exchange-traded symbol the
    # price source must therefore be allowed to fetch. A FRED series or
    # a hand-built index leaves this None and is named in `substitute`.
    substitute_ticker: str | None = None

    @property
    def has_data(self) -> bool:
        return self.substitute is not None

    def covers(self, day: date | datetime | str) -> bool:
        d = _as_date(day)
        return self.start <= d <= self.end


# The caps. Every one of these is round, and every one is a prior about
# how wrong a sleeve can be rather than a number that produced a nicer
# equity curve — the moment a cap is chosen by testing caps it stops
# being a constraint and becomes a fitted parameter that has to be
# counted as a trial.
#
# They sum to well over 100% on purpose. A cap is a per-sleeve ceiling,
# not an allocation; the budget constraint (gross exposure at or below
# NAV, minimum weight zero, buys funded from settled cash) lives in the
# optimiser and is the thing that actually adds to one.
SLEEVES: tuple[Sleeve, ...] = (
    # The sleeve most likely to be right, and the one whose being wrong
    # takes the whole book down with it. At 40% a halving of US equity
    # costs 20% of NAV, which is a number this fund could explain to
    # the school it is managing money for. Higher than that and the
    # other eight sleeves are decoration.
    Sleeve(
        key="us_equity",
        name="US Equity",
        ticker="SPY",
        max_weight=0.40,
        asset_class="equity",
        inception=date(1993, 1, 1),
        inception_precision="year",
    ),
    # Same asset class as the sleeve above with a currency leg attached
    # that we have no view on. Capped below US equity not because
    # developed international is worse but because half its return in
    # any given year is a dollar bet nobody in this process is making
    # deliberately.
    Sleeve(
        key="intl_developed",
        name="Developed International Equity",
        ticker="EFA",
        max_weight=0.25,
        asset_class="equity",
        inception=date(2001, 8, 1),
        inception_precision="month",
    ),
    # The currency leg is larger, the drawdowns are deeper, and
    # liquidity is the first thing to leave in a crisis — which is
    # precisely when a daily rebalance would want to trade it. 15%.
    Sleeve(
        key="emerging_markets",
        name="Emerging Market Equity",
        ticker="EEM",
        max_weight=0.15,
        asset_class="equity",
        inception=date(2003, 4, 1),
        inception_precision="month",
    ),
    # The defensive core, and the one sleeve allowed to be as large as
    # US equity. There are long stretches — 2008, 2020 — where being
    # long intermediate Treasuries and nothing else was the correct
    # book, and a cap that forbids that is a view on rates dressed up
    # as risk management.
    Sleeve(
        key="duration_intermediate",
        name="Intermediate Treasury Duration",
        ticker="IEF",
        max_weight=0.40,
        asset_class="government_bond",
        inception=date(2002, 7, 1),
        inception_precision="month",
    ),
    # The same credit risk as IEF at more than twice the duration, so
    # 25% of TLT carries more rate exposure than 40% of IEF. A weight
    # cap can only ration dollars, so the dollars are rationed to
    # approximate rationing the risk.
    Sleeve(
        key="duration_long",
        name="Long Treasury Duration",
        ticker="TLT",
        max_weight=0.25,
        asset_class="government_bond",
        inception=date(2002, 7, 1),
        inception_precision="month",
    ),
    # Gold has no cash flow, so there is no valuation anchor and no
    # mechanism by which the position can tell you it is wrong except
    # price. 20% is large enough to matter in a debasement regime and
    # small enough that the twenty years gold spent going nowhere after
    # 1980 would not have sunk the book.
    Sleeve(
        key="gold",
        name="Gold",
        ticker="GLD",
        max_weight=0.20,
        asset_class="real_asset",
        inception=date(2004, 11, 18),
    ),
    # Broad commodity is a roll-return instrument at least as much as a
    # spot one: in contango DBC bleeds while the underlying goes
    # nowhere. Held as a diversifier against an inflation shock, never
    # as a return engine, and capped like one.
    Sleeve(
        key="commodity",
        name="Broad Commodity",
        ticker="DBC",
        max_weight=0.15,
        asset_class="real_asset",
        inception=date(2006, 2, 6),
    ),
    # Investment grade credit files itself under bonds and behaves like
    # a geared equity sleeve at the exact moment the bond label is
    # being relied on. Capped below both Treasury sleeves because its
    # diversification is conditional on the world being calm.
    Sleeve(
        key="credit_ig",
        name="Investment Grade Credit",
        ticker="LQD",
        max_weight=0.30,
        asset_class="credit",
        inception=date(2002, 7, 1),
        inception_precision="month",
    ),
    # Not really a cap. It is the statement that the process is always
    # allowed to be entirely out of everything. Any ceiling below 100%
    # forces the book to own something it does not want on the days it
    # wants nothing, which is how a system becomes a buyer at a top.
    Sleeve(
        key=CASH_SLEEVE_KEY,
        name="Cash",
        ticker="BIL",
        max_weight=1.00,
        asset_class="cash",
        inception=date(2007, 5, 30),
    ),
)


_SAMPLE_START: date = date.fromisoformat(SAMPLE_START)


def _day_before(d: date) -> date:
    return d - timedelta(days=1)


# The two documented gaps. Both start at the sample start because that
# is where the backtest starts; if the sample is ever pushed earlier,
# the cash splice extends with it (DTB3 runs back to 1954) and the
# commodity gap simply gets longer.
SPLICES: tuple[Splice, ...] = (
    # Why BIL is the wrong instrument for the early period specifically
    # rather than wrong in general: it is the right instrument, it just
    # did not exist until May 2007, and the tempting substitutes are
    # all not-cash. SHY is the usual reach and it is a one-to-three
    # year duration fund — it carries real rate risk and lost money in
    # 2022, a year in which actual T-bills earned a positive return.
    # Splicing SHY in would put a small bond bet inside the sleeve the
    # rest of the system treats as riskless, and every drawdown number
    # for 2005-2007 would inherit it. The three-month bill rate
    # compounded daily is what the cash leg is trying to be in the
    # first place; BIL is a convenient wrapper around it, not the thing
    # itself. So we build the thing itself and hand over to BIL on the
    # day BIL becomes available.
    Splice(
        sleeve=CASH_SLEEVE_KEY,
        start=_SAMPLE_START,
        end=_day_before(date(2007, 5, 30)),
        substitute=f"FRED {CASH_FRED_SERIES} (3-month Treasury bill, "
        "secondary market discount rate) compounded daily into a "
        "total-return index",
        justification=(
            "BIL did not exist before 2007-05-30 and every ETF "
            "substitute carries duration; a 1-3 year fund like SHY is "
            "not cash and lost money in 2022 while bills did not."
        ),
    ),
    # No proxy, on purpose. The index-level alternatives (GSCI, BCOM)
    # are excess-return series on a different roll schedule from DBC's,
    # so splicing one in would not be filling a hole in the commodity
    # sleeve, it would be running a different strategy for thirteen
    # months and labelling it the same. The honest model is that the
    # book had eight sleeves until 2006-02-06, and the renderer says
    # so.
    Splice(
        sleeve="commodity",
        start=_SAMPLE_START,
        end=_day_before(date(2006, 2, 6)),
        substitute=None,
        justification=(
            "DBC listed 2006-02-06, thirteen months into the sample. "
            "No proxy: the index alternatives roll differently, so a "
            "substitute would be a different sleeve wearing DBC's name."
        ),
    ),
)


#: Every ticker any sleeve may ever reference, primaries plus any
#: spliced substitute that is itself exchange-traded. The free data
#: source treats this as a hard allowlist, which is the point: SHY is
#: absent so that nobody can build the early cash leg out of it by
#: accident. Its inception was probed (2002-07) and it was rejected on
#: the merits — see the cash splice above. A rejection enforced by the
#: fetcher is worth more than a rejection written in a comment.
SLEEVE_TICKERS: frozenset[str] = frozenset(
    [s.ticker for s in SLEEVES]
    + [sp.substitute_ticker for sp in SPLICES if sp.substitute_ticker]
)

#: Lookup by key. Ordering of `SLEEVES` stays the authority for
#: anything rendered; this is for the code that has a key in hand.
SLEEVE_BY_KEY: dict[str, Sleeve] = {s.key: s for s in SLEEVES}


def spliced_periods(
    start: date | datetime | str,
    end: date | datetime | str,
) -> tuple[Splice, ...]:
    """The splices overlapping [start, end], in declaration order.

    Written so a results renderer can caveat a window without importing
    any sleeve knowledge: it asks which splices touch the dates it is
    about to print and puts them in the footnotes. Half-overlap counts
    — a backtest running 2006-2010 still depends on the cash splice for
    its first seventeen months, and a caveat that only fires when a
    period is wholly spliced is a caveat that never fires.
    """
    lo, hi = _as_date(start), _as_date(end)
    if lo > hi:
        # A reversed window is a caller bug, and returning an empty
        # tuple would report it as "nothing here depends on a splice" —
        # the single most dangerous sentence this function can say.
        raise ValueError(f"start {lo.isoformat()} is after end {hi.isoformat()}")
    return tuple(sp for sp in SPLICES if sp.start <= hi and sp.end >= lo)


def splices_for(sleeve_key: str) -> tuple[Splice, ...]:
    """Every splice declared against one sleeve."""
    return tuple(sp for sp in SPLICES if sp.sleeve == sleeve_key)


def _as_date(value: date | datetime | str) -> date:
    """Accept the three things callers actually hold.

    pandas Timestamp subclasses datetime, so it lands in the second
    branch without this module importing pandas to say so.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise TypeError(f"expected a date, datetime or ISO string, got {type(value)!r}")


def _validate() -> None:
    """Fail at import if the table above contradicts itself.

    Loud here, because every downstream consumer reads these as facts.
    A duplicate key or a sleeve with no cash sleeve to fall back into
    would otherwise surface as a weight vector that does not sum to one
    somewhere much further down, long after the cause is visible.
    """
    keys = [s.key for s in SLEEVES]
    if len(set(keys)) != len(keys):
        raise ValueError(f"duplicate sleeve key in SLEEVES: {sorted(keys)}")

    tickers = [s.ticker for s in SLEEVES]
    if len(set(tickers)) != len(tickers):
        raise ValueError(f"two sleeves share a ticker: {sorted(tickers)}")

    for s in SLEEVES:
        if not 0.0 < s.max_weight <= 1.0:
            raise ValueError(f"{s.key}: max_weight {s.max_weight} outside (0, 1]")
        if s.asset_class not in ASSET_CLASSES:
            raise ValueError(f"{s.key}: unknown asset_class {s.asset_class!r}")
        if s.inception_precision not in _INCEPTION_PRECISIONS:
            raise ValueError(
                f"{s.key}: inception_precision {s.inception_precision!r} "
                f"not one of {sorted(_INCEPTION_PRECISIONS)}"
            )

    cash = SLEEVE_BY_KEY.get(CASH_SLEEVE_KEY)
    if cash is None:
        raise ValueError(
            f"no {CASH_SLEEVE_KEY!r} sleeve; residual weight has nowhere to go"
        )
    if cash.max_weight != 1.0:
        raise ValueError(
            "the cash sleeve must be allowed to hold the whole book — a cap "
            f"of {cash.max_weight} forces a position on a day the process "
            "wants none"
        )

    for sp in SPLICES:
        if sp.sleeve not in SLEEVE_BY_KEY:
            raise ValueError(f"splice names unknown sleeve {sp.sleeve!r}")
        if sp.start > sp.end:
            raise ValueError(
                f"splice on {sp.sleeve!r} runs backwards: "
                f"{sp.start.isoformat()} to {sp.end.isoformat()}"
            )
        # A splice is a claim that the vehicle could not cover these
        # dates. If it ends after the vehicle listed, one of the two
        # numbers is stale.
        vehicle = SLEEVE_BY_KEY[sp.sleeve]
        if sp.end >= vehicle.inception:
            raise ValueError(
                f"splice on {sp.sleeve!r} ends {sp.end.isoformat()} but "
                f"{vehicle.ticker} listed {vehicle.inception.isoformat()} — "
                "the splice would overlap live data"
            )
        if not sp.justification:
            raise ValueError(f"splice on {sp.sleeve!r} carries no justification")


_validate()
