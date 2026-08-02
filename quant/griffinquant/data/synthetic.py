"""A panel we invented, so the audit can be seen catching things.

The build brief rules out free survivorship-biased price APIs for real
work and allows a smoke-test harness only if it is unmistakably
labelled. This is that harness, and it is better than a free API for
the job it does: because we generate every bar, we know the ground
truth, and we can put one specific defect into an otherwise clean
panel and watch precisely one check go red. An audit that has never
been shown to fail is not evidence about anything — it is a report
that has only ever printed PASS, which is what a broken audit also
does.

So the honest panel is the control. It is built to be boring in every
way the checks look at: names die at a few percent a year, the wave
breaks in 2008-09 and 2020, symbols get reused by later companies
under new ids, adjusted and as-traded closes diverge exactly where a
split or a dividend forces them to, and filings turn up a month or
two after the quarter they describe. The decedents from
`audit.decedents` are seeded in at their real dates so the trace check
has something real-shaped to find rather than a fixture it recognises.

`Bias` is the treatment. Exactly one is applied, everything else is
left honest, and the seed is consumed identically either way — the
biased panel is the same draw with a surgical edit on top. That is
what makes a failing check attributable: it names the injected defect
and nothing else.

The mapping below is the contract the test suite asserts, and it is
also in code as `EXPECTED_TRIPS` so a test can read it rather than a
person:

  NONE                    nothing. Every blocking check passes and the
                          report rolls up to PASS.
  SURVIVORSHIP            survivorship.delisted_present,
                          survivorship.annual_attrition,
                          survivorship.decedent_trace   (all FAIL);
                          survivorship.dead_names_priced and
                          pit_delisting_action_coverage UNPROVABLE,
                          having nothing left to look at; and
                          survivorship.universe_count_by_year FAIL on a
                          panel of a decade or more, WARN on a shorter
                          one — see the note on EXPECTED_TRIPS.
  LOOKAHEAD_FUNDAMENTALS  pit_filing_dates_present,
                          pit_filing_lag_distribution   (FAIL).
  RESTATED_FUNDAMENTALS   pit_as_reported_dimension     (FAIL).
  ADJUSTED_ONLY           pit_unadjusted_prices_available (FAIL).
  TICKER_COLLISION        survivorship.decedent_trace   (FAIL, the
                          decedents recorded as "never stops").
  FABRICATED_SESSIONS     quality.calendar_alignment    (FAIL).
  UNRECORDED_SPLITS       quality.unexplained_jumps     (FAIL).
  BROKEN_ADJUSTMENT       quality.adjustment_consistency (FAIL).

One check stands at WARN on the control and it is not a defect:
`pit_adjusted_price_screen_leak` measures how much of the future a
price floor read off back-adjusted closes would import, and it is
non-blocking precisely because a non-zero answer is the correct one.
This panel contains reverse splits, so the number it prints is real. A
harness that reported zero there would mean the reverse splits were
missing, which is a worse fixture. It does not warn on every run,
though: under ADJUSTED_ONLY the two closes are one series wearing two
names, the disagreement between the two screens becomes unmeasurable
rather than zero, and the check returns UNPROVABLE instead of printing
the most reassuring wrong number in the report.

Two of the biases deserve a note, because both are judgement calls
about dosage rather than switches.

UNRECORDED_SPLITS removes the split rows from the actions frame and
leaves `prices.split_factor` populated. Clearing both would also trip
the adjustment-consistency and divergence checks, and a fixture that
fails three checks at once cannot distinguish an audit that found the
defect from one that is simply noisy. The defect being modelled is
narrow on purpose: the tape moved 75% in a session and nothing in the
actions frame explains it.

BROKEN_ADJUSTMENT is its mirror image. The actions frame is complete
and the tape is honest; what carries a factor with nothing behind it
is the back-adjustment, so total return and price return part company
on a day when, by the source's own account, nothing happened. The
phantoms keep several sessions clear of every real action, because the
days the two series are supposed to disagree are the days an error
hidden among them would be excused. Between phantoms the ratio of the
two closes is left at its honest value rather than rewobbled bar by
bar: a per-row jitter would put a defect on every session pair in the
panel, and a check reporting 100% of everything cannot be told from a
check that is broken.

And no bias ever edits `capabilities`. A source that quietly withdrew
its claim to as-reported fundamentals while serving restated ones
would turn a FAIL into an UNPROVABLE, which is a different and much
weaker demonstration — the check would be declining to sit the test
rather than sitting it and failing. The capabilities here are the
vendor's marketing copy, and the marketing copy never changes.

One caveat that belongs to the caller. `AuditContext.sessions` builds
its NYSE calendar with `exchange_calendars`' default bounds, which are
a rolling twenty-year window ending near today. Generate a panel that
starts before those bounds and the calendar check will report the
early years as fabricated sessions — an artefact of the audited range,
not of this file. Keep the demonstration range inside the default
window.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import date
from typing import Iterable

import numpy as np
import pandas as pd

from ..audit import decedents as decedents_fixture
from . import schema
from .base import DataSource, SourceCapabilities


class Bias(enum.Enum):
    """One defect, injected on purpose, into an otherwise clean panel."""

    NONE = "none"
    SURVIVORSHIP = "survivorship"
    LOOKAHEAD_FUNDAMENTALS = "lookahead_fundamentals"
    RESTATED_FUNDAMENTALS = "restated_fundamentals"
    ADJUSTED_ONLY = "adjusted_only"
    TICKER_COLLISION = "ticker_collision"
    FABRICATED_SESSIONS = "fabricated_sessions"
    UNRECORDED_SPLITS = "unrecorded_splits"
    BROKEN_ADJUSTMENT = "broken_adjustment"


#: Check keys each bias is expected to turn red, over every range and
#: seed the harness supports. Stated here so a test asserts against a
#: value rather than against a paragraph of prose, and so a renamed
#: check breaks the harness loudly instead of quietly certifying a panel
#: it can no longer read.
#:
#: Read it as a floor, not an inventory: assert that these keys FAIL,
#: not that nothing else does. Deleting every dead company is supposed
#: to break several survivorship checks at once — that is four
#: instruments agreeing, not four bugs. The property worth testing
#: alongside it is the negative one: nothing OUTSIDE the family a bias
#: targets should move, and on the control nothing should move at all.
EXPECTED_TRIPS: dict[Bias, tuple[str, ...]] = {
    Bias.NONE: (),
    # `survivorship.universe_count_by_year` is deliberately NOT here. It
    # fails on a decade-long panel and only warns on an eight-year one,
    # because the count curve has to grow 40% before it will call a
    # panel backfilled, and eight years of attrition removed is not 40%.
    # That is a true and slightly uncomfortable fact about the audit —
    # its most diagnostic curve needs years before it will speak — and
    # promising it here would buy a flaky test in exchange for hiding it.
    Bias.SURVIVORSHIP: (
        "survivorship.delisted_present",
        "survivorship.annual_attrition",
        "survivorship.decedent_trace",
    ),
    Bias.LOOKAHEAD_FUNDAMENTALS: (
        "pit_filing_dates_present",
        "pit_filing_lag_distribution",
    ),
    Bias.RESTATED_FUNDAMENTALS: ("pit_as_reported_dimension",),
    Bias.ADJUSTED_ONLY: ("pit_unadjusted_prices_available",),
    Bias.TICKER_COLLISION: ("survivorship.decedent_trace",),
    Bias.FABRICATED_SESSIONS: ("quality.calendar_alignment",),
    Bias.UNRECORDED_SPLITS: ("quality.unexplained_jumps",),
    Bias.BROKEN_ADJUSTMENT: ("quality.adjustment_consistency",),
}

#: Ids start high and nowhere near Sharadar's, so a synthetic frame
#: that escapes into a notebook alongside a real one is obvious at a
#: glance rather than after a confusing hour.
FIRST_PERMATICKER = 9_000_000

#: US listings retire at roughly two to eight percent a year. The
#: multipliers put the wave where it actually broke, which is what the
#: attrition check looks for when it asks whether 2008 resembles an
#: ordinary year.
BASE_ANNUAL_ATTRITION = 0.045
CRISIS_MULTIPLIER = {2008: 2.6, 2009: 2.1, 2020: 1.8}

#: Sessions of terminal drift before a delisting. A bankruptcy should
#: not arrive as a flat line that stops; a takeover should not arrive
#: as a collapse. The panel is more useful if the two are visibly
#: opposite returns, since telling them apart is half of what the
#: delisting-reason column is for.
TERMINAL_SESSIONS = 150

#: The vocabulary is `audit.decedents`', and how often each reason turns
#: up sits beside the drift it puts on the final stretch of tape rather
#: than in a parallel array — two lists in matching order is how a
#: reordering ends up giving bankruptcies the takeover's return.
_REASON_MIX: dict[str, tuple[float, float]] = {
    "acquisition": (0.34, +0.0012),
    "merger": (0.19, +0.0009),
    "going_private": (0.14, +0.0011),
    "bankruptcy": (0.18, -0.0105),
    "seizure": (0.05, -0.0140),
    "liquidation": (0.05, -0.0030),
    "regulatory_delisting": (0.05, -0.0018),
}
_REASONS = tuple(_REASON_MIX)
_REASON_WEIGHTS = np.array([share for share, _ in _REASON_MIX.values()])
_TERMINAL_DRIFT = {k: drift for k, (_, drift) in _REASON_MIX.items()}

#: A single session may not move more than this in log terms. Not
#: realism — a safety rail. Every move past ±50% in this panel is
#: supposed to be a split, and a fat tail that wandered past the
#: threshold on its own would show up as an unexplained jump in the
#: control run and make the whole harness unreadable.
MAX_DAILY_LOG_MOVE = 0.30

#: Split ratios as shares-out per pre-split share, so 0.1 is a
#: one-for-ten reverse. A plain 2-for-1 lands within noise of the
#: jump check's ±50% threshold and is a genuine coin flip; the heavier
#: ratios are what make UNRECORDED_SPLITS a demonstration rather than
#: a hope. Reverse splits earn their place twice over: they are the
#: mechanism behind the adjusted-price screen leak, because a stock
#: that traded at $2 shows up at $20 back-adjusted and clears a floor
#: it could never have cleared on the day.
_FORWARD_SPLITS = np.array([2.0, 3.0, 4.0])
_FORWARD_SPLIT_WEIGHTS = np.array([0.45, 0.35, 0.20])
SPLIT_HAZARD_PER_YEAR = 0.035
REVERSE_SPLIT_PRICE = 2.50
REVERSE_SPLIT_RATIO = 0.10

#: BROKEN_ADJUSTMENT's dosage: how often a phantom factor lands, how
#: large it is, and how far it keeps away from a real action.
#:
#: The hazard is per session pair rather than per name, so the rate the
#: consistency check reports is roughly the hazard itself whatever the
#: panel's shape: measured between 0.65% and 0.79% across seeds, over
#: ranges from a decade down to the sixty-session minimum, against a
#: threshold of 0.1%. That flatness is what makes the promise in
#: EXPECTED_TRIPS a promise rather than a hope about one range.
#:
#: The size is bounded below by the check's own tolerance, which is half
#: a cent of rounding on each of four prices and is therefore widest on
#: the cheapest names — a tenth of a percent would be invisible on a
#: back-adjusted two-dollar stock and the fixture would then be testing
#: the tolerance rather than the defect. Bounded above by what a person
#: scrolling the tape would notice: this defect is supposed to be quiet.
BROKEN_ADJUSTMENT_HAZARD = 0.008
BROKEN_ADJUSTMENT_SIZE = (0.008, 0.025)
#: Sessions of clearance from a split, a dividend or a symbol change.
#: The check widens its own action window by a session on each side, so
#: a phantom landing any nearer would be excused as the real action it
#: is standing next to — an injected defect nobody is allowed to see is
#: indistinguishable from no injection at all.
BROKEN_ADJUSTMENT_GUARD = 2

SESSIONS_PER_YEAR = 252
DIVIDEND_INTERVAL_SESSIONS = 63

#: How long a freed symbol sits idle before a new company takes it.
#: Waste Management waited ten months for WM and Chemours seven years
#: for CC; anything non-overlapping demonstrates the same thing, and
#: the recycling check fails a source whose two tenants overlap by even
#: a day.
REUSE_GAP_SESSIONS = 250

_EXCHANGES = ("NYSE", "NASDAQ")
_CATEGORIES = (
    "Domestic Common Stock",
    "Domestic Common Stock Primary Class",
    "ADR Common Stock",
)
_CATEGORY_WEIGHTS = np.array([0.74, 0.16, 0.10])

_NAME_HEADS = (
    "Alder", "Bracken", "Cardinal", "Dunmore", "Ellsworth", "Fenwick",
    "Granite", "Harlow", "Ivory", "Junction", "Kestrel", "Larkspur",
    "Meridian", "Northgate", "Orchid", "Pemberton", "Quarry",
    "Redstone", "Sablefield", "Thornbury", "Umber", "Vantage",
    "Westmark", "Yarrow",
)
_NAME_TAILS = (
    "Industrial", "Materials", "Systems", "Bancorp", "Therapeutics",
    "Logistics", "Semiconductor", "Energy", "Foods", "Retail Group",
    "Instruments", "Software", "Insurance", "Resources", "Aerospace",
)
_NAME_SUFFIXES = ("Inc.", "Corp.", "Holdings, Inc.", "Group", "Co.")

_ALPHABET = np.array(list("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))

#: The only dimensions this source will answer to. It generates one
#: quarterly panel; RESTATED_FUNDAMENTALS is modelled by relabelling
#: that panel rather than by building a second one, which is exactly
#: what a vendor serving restatements under an as-reported heading is
#: doing.
_QUARTERLY_DIMENSIONS = frozenset({"ARQ", "MRQ"})


def nyse_sessions(start: date, end: date) -> pd.DatetimeIndex:
    """Real NYSE sessions, tz-naive, at nanosecond midnight.

    The calendar is built with explicit bounds rather than taken from
    the default instance, whose first session is twenty years before
    whenever you happen to run this. A fixture whose contents depend on
    the wall clock is not a fixture.
    """
    import exchange_calendars as xcals

    lo, hi = pd.Timestamp(start), pd.Timestamp(end)
    # Padded, because the calendar snaps its own bounds to sessions and
    # then refuses a range that starts before the first of them — ask
    # for a panel beginning on New Year's Day and you get an exception
    # about the second of January rather than a panel.
    pad = pd.Timedelta(days=10)
    cal = xcals.get_calendar("XNYS", start=lo - pad, end=hi + pad)
    sess = pd.DatetimeIndex(cal.sessions_in_range(lo, hi))
    if sess.tz is not None:
        sess = sess.tz_localize(None)
    return pd.DatetimeIndex(sess.normalize(), dtype="datetime64[ns]")


@dataclass
class _Entity:
    """One made-up company, planned before a single bar exists."""

    permaticker: int
    ticker: str
    name: str
    exchange: str
    category: str
    first_i: int
    last_i: int
    is_delisted: bool
    reason: str
    #: (session index from which it applies, symbol). Always at least
    #: one entry; more than one means the name changed symbol mid-life,
    #: which is the case the price frame carries and the master cannot.
    symbol_changes: list[tuple[int, str]]
    s0: float
    mu: float
    sigma: float
    div_yield: float
    size_scale: float
    #: Set when the row was seeded from `audit.decedents`.
    seeded_from: str | None = None


@dataclass
class _Segment:
    """As-traded bars for one entity, before any adjustment is derived."""

    idx: np.ndarray
    ticker: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    split: np.ndarray
    dividend: np.ndarray


class SyntheticSource(DataSource):
    """A generated panel with a known defect. Never a research input.

    `capabilities.is_smoke_test_only` is the machine-readable half of
    that; `label` is the half a person reads, and it names the injected
    bias so a report header cannot be mistaken for a real audit of a
    real dataset.
    """

    capabilities = SourceCapabilities(
        name="Synthetic (smoke test)",
        # Every claim below is true of the honest panel and stays put
        # under every bias. A source that withdrew a claim the moment
        # it started lying would send the audit to UNPROVABLE, and
        # "we could not test this" is not the demonstration we want.
        claims_survivorship_free=True,
        provides_filing_dates=True,
        provides_as_reported=True,
        provides_delisting_dates=True,
        provides_delisting_reasons=True,
        provides_permanent_ids=True,
        # Nothing here reconstructs an index as of a past date, so the
        # membership checks should come back UNPROVABLE rather than
        # pass on a fixture nobody wrote.
        provides_index_membership=False,
        provides_unadjusted_prices=True,
        is_smoke_test_only=True,
    )

    def __init__(
        self,
        start: date,
        end: date,
        *,
        seed: int = 20050103,
        n_entities: int = 250,
        bias: Bias = Bias.NONE,
    ) -> None:
        if end <= start:
            raise ValueError(f"end {end} is not after start {start}")
        if n_entities < 20:
            raise ValueError(
                f"n_entities={n_entities} is too small for the audit to read a "
                "trend off; several checks report UNPROVABLE below a few dozen "
                "names and the harness would then prove nothing"
            )
        self.start = start
        self.end = end
        self.seed = int(seed)
        self.n_entities = int(n_entities)
        self.bias = bias

        self._master: pd.DataFrame | None = None
        self._prices: pd.DataFrame | None = None
        self._actions: pd.DataFrame | None = None
        self._fundamentals: pd.DataFrame | None = None
        self._dimension_served = (
            "MRQ" if bias is Bias.RESTATED_FUNDAMENTALS else "ARQ"
        )

    # -- identity -------------------------------------------------------

    @property
    def label(self) -> str:
        tag = "" if self.bias is Bias.NONE else f" — bias: {self.bias.name}"
        return f"{self.capabilities.name} [SMOKE TEST ONLY]{tag}"

    def __repr__(self) -> str:
        return (
            f"SyntheticSource(SMOKE TEST ONLY, {self.start}..{self.end}, "
            f"seed={self.seed}, n_entities={self.n_entities}, "
            f"bias={self.bias.name})"
        )

    # -- the four frames ------------------------------------------------

    def security_master(self) -> pd.DataFrame:
        self._build()
        assert self._master is not None
        return self._check(self._master.copy(), schema.SECURITY_MASTER)

    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        self._build()
        assert self._prices is not None
        out = self._prices
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        if permatickers is not None:
            wanted = {int(p) for p in permatickers}
            out = out.loc[out["permaticker"].isin(wanted)]
        cols = list(schema.PRICES.required) + [
            c for c in schema.PRICES.optional if c in out.columns
        ]
        return self._check(
            out.loc[:, cols].reset_index(drop=True), schema.PRICES
        )

    def actions(self, start: date, end: date) -> pd.DataFrame:
        self._build()
        assert self._actions is not None
        out = self._actions
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        return self._check(out.reset_index(drop=True), schema.ACTIONS)

    def fundamentals(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
        dimension: str = "ARQ",
    ) -> pd.DataFrame:
        if dimension not in _QUARTERLY_DIMENSIONS:
            # An annual or trailing dimension is not something this
            # source has; returning an empty frame would read one layer
            # up as "these companies file nothing".
            raise ValueError(
                f"{self.label} generates quarterly fundamentals only; "
                f"asked for {dimension!r}, expected one of "
                f"{sorted(_QUARTERLY_DIMENSIONS)}"
            )
        self._build()
        assert self._fundamentals is not None
        out = self._fundamentals
        out = out.loc[
            out["date_public"].between(pd.Timestamp(start), pd.Timestamp(end))
        ]
        if permatickers is not None:
            wanted = {int(p) for p in permatickers}
            out = out.loc[out["permaticker"].isin(wanted)]
        return self._check(out.reset_index(drop=True), schema.FUNDAMENTALS)

    # -- generation -----------------------------------------------------

    def _build(self) -> None:
        if self._prices is not None:
            return

        rng = np.random.default_rng(self.seed)
        sessions = nyse_sessions(self.start, self.end)
        if len(sessions) < 60:
            raise ValueError(
                f"{self.start}..{self.end} contains only {len(sessions)} NYSE "
                "sessions; there is nothing here for an audit to read"
            )

        entities, reuse_pairs = self._plan(rng, sessions)
        segments = {e.permaticker: self._bars(rng, e) for e in entities}

        # Both of these edit the plan rather than the finished frames,
        # because they have to happen before the adjustment is derived.
        # A spliced entity must get ONE continuous back-adjustment; two
        # stitched together would leave a discontinuity at the seam and
        # light up the consistency check as well, and the whole point of
        # TICKER_COLLISION is that the seam is invisible to everything
        # except an id.
        if self.bias is Bias.SURVIVORSHIP:
            entities = [e for e in entities if not e.is_delisted]
            keep = {e.permaticker for e in entities}
            segments = {k: v for k, v in segments.items() if k in keep}
        elif self.bias is Bias.TICKER_COLLISION:
            entities, segments = _collide(entities, segments, reuse_pairs)

        prices = self._assemble(segments, sessions)
        master = _master_frame(entities, sessions)
        actions = _action_frame(entities, segments, sessions)
        fundamentals = self._fundamental_frame(rng, entities, sessions)

        if self.bias is Bias.ADJUSTED_ONLY:
            prices = _adjusted_only(prices)
        elif self.bias is Bias.FABRICATED_SESSIONS:
            prices = _fabricate_sessions(rng, prices, sessions)
        elif self.bias is Bias.BROKEN_ADJUSTMENT:
            prices = _break_adjustment(rng, prices)
        elif self.bias is Bias.UNRECORDED_SPLITS:
            actions = actions.loc[actions["action"] != "split"].reset_index(drop=True)
        elif self.bias is Bias.LOOKAHEAD_FUNDAMENTALS:
            fundamentals = fundamentals.assign(
                date_public=fundamentals["period_end"]
            )
        elif self.bias is Bias.RESTATED_FUNDAMENTALS:
            fundamentals = fundamentals.assign(
                dimension=pd.Series(
                    ["MRQ"] * len(fundamentals), index=fundamentals.index, dtype="str"
                )
            )

        self._master = master
        self._prices = prices.loc[
            :, [c for c in prices.columns if not c.startswith("_")]
        ]
        self._actions = actions
        self._fundamentals = fundamentals

    # -- planning -------------------------------------------------------

    def _plan(
        self, rng: np.random.Generator, sessions: pd.DatetimeIndex
    ) -> tuple[list[_Entity], list[tuple[int, int]]]:
        """Decide who exists, when they listed, and when they died."""
        years = sessions.year.to_numpy()
        distinct_years = np.unique(years)
        last_i = len(sessions) - 1

        reserved = {d.ticker for d in decedents_fixture.DECEDENTS}
        # Sized against listings AND years, since every year of the panel
        # adds a cohort and a few renames. Deliberately generous: symbols
        # are cheap and a pool that runs dry mid-plan would truncate the
        # panel somewhere nobody would think to look.
        pool = _symbol_pool(
            rng,
            self.n_entities * 3 + 24 * len(distinct_years) + 128,
            reserved,
        )
        pool_at = 0

        def take_symbol() -> str:
            nonlocal pool_at
            if pool_at >= len(pool):
                raise RuntimeError(
                    f"symbol pool of {len(pool)} exhausted planning "
                    f"{len(entities)} entities; widen it rather than letting "
                    "a name reuse a live symbol, which is the one defect this "
                    "panel must only ever contain on purpose"
                )
            sym = pool[pool_at]
            pool_at += 1
            return sym

        next_id = FIRST_PERMATICKER
        entities: list[_Entity] = []
        reuse_pairs: list[tuple[int, int]] = []

        def make(
            first_i: int,
            *,
            ticker: str | None = None,
            name: str | None = None,
            seeded_from: str | None = None,
        ) -> _Entity:
            nonlocal next_id
            sym = ticker or take_symbol()
            ent = _Entity(
                permaticker=next_id,
                ticker=sym,
                name=name or _company_name(rng),
                exchange=str(rng.choice(_EXCHANGES)),
                category=str(rng.choice(_CATEGORIES, p=_CATEGORY_WEIGHTS)),
                first_i=first_i,
                last_i=last_i,
                is_delisted=False,
                reason="",
                symbol_changes=[(first_i, sym)],
                s0=float(np.exp(rng.normal(np.log(34.0), 0.75))),
                mu=float(rng.normal(0.07, 0.06)),
                sigma=float(rng.uniform(0.22, 0.55)),
                div_yield=(
                    float(rng.uniform(0.010, 0.035))
                    if rng.random() < 0.45
                    else 0.0
                ),
                size_scale=float(np.exp(rng.normal(np.log(1.2e9), 1.4))),
                seeded_from=seeded_from,
            )
            next_id += 1
            entities.append(ent)
            return ent

        def kill(ent: _Entity, lo: int, hi: int) -> bool:
            """Retire `ent` somewhere in [lo, hi], or decline to.

            Sixty sessions of history before a death, or it is not a
            company that failed, it is a row that appeared and vanished.
            Those drag the attrition median around and give a strategy
            nothing it could ever have held.
            """
            floor = max(lo, ent.first_i + 60)
            if floor > hi:
                return False
            ent.last_i = int(rng.integers(floor, hi + 1))
            ent.is_delisted = True
            ent.reason = str(rng.choice(_REASONS, p=_REASON_WEIGHTS))
            return True

        # Ids the attrition loop must leave alone, and ids the rename
        # pass must not touch. A decedent that quietly changed symbol
        # drops out of the trace check's ticker match, and a reuse pair
        # whose two tenants no longer share a string is not a reuse pair
        # — both are the fixture silently ceasing to test anything.
        protected: set[int] = set()
        frozen_symbol: set[int] = set()

        # 1. The named dead, at the dates a Form 25 says they died. The
        #    trace check is the only one that can catch a recycled
        #    symbol, and it can only catch it on names whose funerals
        #    are on the public record.
        for fixture in decedents_fixture.DECEDENTS:
            expected = pd.Timestamp(fixture.last_trade_on_or_about)
            if not (sessions[0] <= expected <= sessions[-1]):
                continue
            death_i = int(sessions.searchsorted(expected, side="right")) - 1
            if death_i < 5:
                continue
            dead = make(0, ticker=fixture.ticker, name=fixture.name,
                        seeded_from=fixture.ticker)
            dead.last_i = death_i
            dead.is_delisted = True
            dead.reason = fixture.reason
            protected.add(dead.permaticker)
            frozen_symbol.add(dead.permaticker)
            if fixture.successor_ticker is None:
                continue
            reborn_i = death_i + REUSE_GAP_SESSIONS
            if reborn_i >= last_i - 40:
                continue
            heir = make(reborn_i, ticker=fixture.successor_ticker)
            reuse_pairs.append((dead.permaticker, heir.permaticker))
            protected.add(heir.permaticker)
            frozen_symbol.add(heir.permaticker)

        # 2. The cohort that was already trading when the panel opens,
        #    then a listing and a death each year on top of it. The
        #    taper matters more than it looks: an entity count that only
        #    ever grows toward the present is precisely the shape of a
        #    panel assembled from today's listings, and the audit reads
        #    that curve before it reads anything else.
        for _ in range(self.n_entities):
            make(0)

        taper = np.linspace(1.30, 0.72, len(distinct_years))
        for step, year in enumerate(distinct_years):
            in_year = np.flatnonzero(years == year)
            if in_year.size < 10:
                continue
            lo, hi = int(in_year[0]), int(in_year[-1])

            hazard = BASE_ANNUAL_ATTRITION * CRISIS_MULTIPLIER.get(int(year), 1.0)
            # Exposed means already trading when the year opened. The
            # opening cohort counts from the first year — leaving it out
            # produced a panel whose first calendar year contained no
            # delistings at all, and the audit reads a silent year as a
            # hole rather than as a quiet market.
            exposed = [
                e
                for e in entities
                if not e.is_delisted
                and e.permaticker not in protected
                and (e.first_i == 0 or sessions[e.first_i].year < year)
            ]

            died = 0
            for ent, dies in zip(exposed, rng.random(len(exposed)) < hazard):
                if dies and kill(ent, lo, hi):
                    died += 1
            # A calendar year in which nobody died reads to the audit as
            # a hole in the panel rather than as a quiet market, and on a
            # short window or a small cohort the draw produces one often
            # enough to matter. Forcing a single death is cheaper than a
            # fixture whose control run warns.
            if died == 0:
                for ent in exposed:
                    if kill(ent, lo, hi):
                        break

            n_new = int(round(len(exposed) * BASE_ANNUAL_ATTRITION * taper[step]))
            for _ in range(n_new):
                make(int(rng.integers(lo, hi + 1)))

        # 3. A few reuses that are nobody famous, so the recycling check
        #    is not reading a fixture list it could have memorised.
        dead_pool = [
            e
            for e in entities
            if e.is_delisted
            and e.seeded_from is None
            and e.last_i + REUSE_GAP_SESSIONS < last_i - 60
        ]
        if dead_pool:
            picks = rng.choice(
                len(dead_pool), size=min(5, len(dead_pool)), replace=False
            )
            for p in picks:
                dead = dead_pool[int(p)]
                heir = make(dead.last_i + REUSE_GAP_SESSIONS, ticker=dead.ticker)
                reuse_pairs.append((dead.permaticker, heir.permaticker))
                frozen_symbol.add(dead.permaticker)
                frozen_symbol.add(heir.permaticker)

        # 4. Mid-life symbol changes. The master can only carry the
        #    current symbol, so these live in the price frame — which is
        #    the case that breaks any adjustment check keyed on the
        #    first ticker it happens to see.
        for ent in entities:
            span = ent.last_i - ent.first_i
            if ent.permaticker in frozen_symbol:
                continue
            if span < 400 or rng.random() > 0.05:
                continue
            at = int(rng.integers(ent.first_i + 200, ent.last_i - 100))
            new_symbol = take_symbol()
            ent.symbol_changes.append((at, new_symbol))
            ent.ticker = new_symbol

        entities.sort(key=lambda e: e.permaticker)
        return entities, reuse_pairs

    # -- bars -----------------------------------------------------------

    def _bars(self, rng: np.random.Generator, ent: _Entity) -> _Segment:
        n = ent.last_i - ent.first_i + 1
        idx = np.arange(ent.first_i, ent.last_i + 1)

        drift = (ent.mu - 0.5 * ent.sigma**2) / SESSIONS_PER_YEAR
        shock = ent.sigma / np.sqrt(SESSIONS_PER_YEAR)
        r = drift + shock * rng.standard_normal(n)

        if ent.is_delisted and ent.reason in _TERMINAL_DRIFT:
            k = min(TERMINAL_SESSIONS, n)
            r[-k:] += _TERMINAL_DRIFT[ent.reason]
            if _TERMINAL_DRIFT[ent.reason] < 0:
                r[-k:] += shock * 0.9 * rng.standard_normal(k)
        np.clip(r, -MAX_DAILY_LOG_MOVE, MAX_DAILY_LOG_MOVE, out=r)

        base = ent.s0 * np.exp(np.cumsum(r))

        # Splits are chosen against the unsplit path. Companies split
        # when the price has run and reverse-split when it has not, and
        # putting the decision on the underlying rather than on the
        # printed price keeps a name from splitting its way to four
        # dollars and back.
        split = np.ones(n)
        if n > 40:
            hazard = SPLIT_HAZARD_PER_YEAR / SESSIONS_PER_YEAR
            candidates = np.flatnonzero(
                (rng.random(n) < hazard) & (base > 65.0) & (np.arange(n) > 20)
            )
            if candidates.size:
                ratios = rng.choice(
                    _FORWARD_SPLITS, size=candidates.size, p=_FORWARD_SPLIT_WEIGHTS
                )
                split[candidates] = ratios
            cheap = np.flatnonzero(
                (base < REVERSE_SPLIT_PRICE)
                & (np.arange(n) > 60)
                & (np.arange(n) < n - 60)
            )
            if cheap.size and rng.random() < 0.6:
                split[cheap[0]] = REVERSE_SPLIT_RATIO

        close = base / np.cumprod(split)

        dividend = np.zeros(n)
        if ent.div_yield > 0 and n > DIVIDEND_INTERVAL_SESSIONS:
            first = int(rng.integers(5, DIVIDEND_INTERVAL_SESSIONS))
            ex = np.arange(first, n, DIVIDEND_INTERVAL_SESSIONS)
            # Quoted per as-traded share, which is what a holder is paid
            # and what the back-adjustment has to divide by. The ex-day
            # price drop is not modelled: at a 2% yield it is a fifth of
            # a daily standard deviation and no check in the audit can
            # see it, so simulating it would only make the arithmetic
            # here harder to check by hand.
            dividend[ex] = close[ex] * ent.div_yield / 4.0

        # OHLC hung off the close rather than off the previous one, so a
        # split day cannot produce a bar whose open belongs to the old
        # share count and whose close belongs to the new.
        opens = close * (1.0 + rng.normal(0.0, 0.004, n))
        top = np.maximum(opens, close)
        bottom = np.minimum(opens, close)
        high = top * (1.0 + np.abs(rng.normal(0.0, 0.006, n)))
        low = bottom * (1.0 - np.clip(np.abs(rng.normal(0.0, 0.006, n)), 0.0, 0.5))

        volume = np.exp(
            rng.normal(np.log(6.0e5 * (ent.size_scale / 1.2e9) ** 0.4), 0.55, n)
        ) * np.cumprod(split)
        volume[rng.random(n) < 0.003] = 0.0

        ticker = np.empty(n, dtype=object)
        for at, sym in ent.symbol_changes:
            ticker[max(at - ent.first_i, 0) :] = sym

        return _Segment(
            idx=idx,
            ticker=ticker,
            open=opens,
            high=high,
            low=low,
            close=close,
            volume=volume,
            split=split,
            dividend=dividend,
        )

    def _assemble(
        self, segments: dict[int, _Segment], sessions: pd.DatetimeIndex
    ) -> pd.DataFrame:
        """Derive the adjusted series and flatten to one frame."""
        ids, idx, tick = [], [], []
        op, hi, lo, cl, vol, spl, div, adj, vadj = ([] for _ in range(9))

        for permaticker in sorted(segments):
            seg = segments[permaticker]
            order = np.argsort(seg.idx, kind="stable")
            close = seg.close[order]
            split = seg.split[order]
            dividend = seg.dividend[order]

            f_all, f_split = _backadjust(close, split, dividend)
            n = len(close)
            ids.append(np.full(n, permaticker, dtype="int64"))
            idx.append(seg.idx[order])
            tick.append(seg.ticker[order])
            op.append(seg.open[order])
            hi.append(seg.high[order])
            lo.append(seg.low[order])
            cl.append(close)
            vol.append(seg.volume[order])
            spl.append(split)
            div.append(dividend)
            adj.append(close * f_all)
            vadj.append(seg.volume[order] / f_split)

        flat_idx = np.concatenate(idx)
        out = pd.DataFrame(
            {
                "permaticker": np.concatenate(ids),
                "ticker": pd.Series(np.concatenate(tick)).astype("str"),
                "date": sessions.to_numpy()[flat_idx],
                "open_unadj": np.concatenate(op),
                "high_unadj": np.concatenate(hi),
                "low_unadj": np.concatenate(lo),
                "close_unadj": np.concatenate(cl),
                "volume_unadj": np.concatenate(vol),
                "close_adj": np.concatenate(adj),
                "dividends": np.concatenate(div),
                # Per-session, not cumulative. A cumulative factor would
                # mark every bar before a name's last split as sitting
                # next to a corporate action, and the consistency check
                # would then have nothing left to compare.
                "split_factor": np.concatenate(spl),
                "_volume_adj": np.concatenate(vadj),
            }
        )
        return out.sort_values(["permaticker", "date"], kind="stable").reset_index(
            drop=True
        )

    # -- fundamentals ---------------------------------------------------

    def _fundamental_frame(
        self,
        rng: np.random.Generator,
        entities: list[_Entity],
        sessions: pd.DatetimeIndex,
    ) -> pd.DataFrame:
        pt, tick, period, public = [], [], [], []
        revenue, netinc, equity, assets, liabilities = [], [], [], [], []
        ncfo, capex, shares = [], [], []

        for ent in entities:
            first = sessions[ent.first_i]
            last = sessions[ent.last_i]
            quarters = pd.date_range(
                first.normalize(), last.normalize(), freq="QE"
            )
            if len(quarters) == 0:
                continue
            # 25 to 75 days. A 10-Q takes about forty and a 10-K about
            # sixty, and the audit's lag check reads the median of this
            # distribution to decide whether these are filing dates at
            # all or a period end with a constant bolted on.
            lag = rng.integers(25, 76, len(quarters))
            rev = ent.size_scale * 0.28 / 4.0 * np.exp(
                rng.normal(0.0, 0.12, len(quarters))
            )
            margin = rng.normal(0.09, 0.05, len(quarters))
            eq = ent.size_scale * 0.45 * np.exp(rng.normal(0.0, 0.10, len(quarters)))
            lia = ent.size_scale * 0.55 * np.exp(rng.normal(0.0, 0.14, len(quarters)))

            pt.append(np.full(len(quarters), ent.permaticker, dtype="int64"))
            tick.append(np.full(len(quarters), ent.ticker, dtype=object))
            period.append(quarters.to_numpy())
            public.append(
                (quarters + pd.to_timedelta(lag, unit="D")).to_numpy()
            )
            revenue.append(rev)
            netinc.append(rev * margin)
            equity.append(eq)
            liabilities.append(lia)
            assets.append(eq + lia)
            ncfo.append(rev * np.clip(margin + 0.06, 0.0, None))
            capex.append(-rev * rng.uniform(0.02, 0.08, len(quarters)))
            shares.append(
                np.full(len(quarters), ent.size_scale / max(ent.s0, 1.0))
            )

        if not pt:
            return schema.FUNDAMENTALS.empty()

        frame = pd.DataFrame(
            {
                "permaticker": np.concatenate(pt),
                "ticker": pd.Series(np.concatenate(tick)).astype("str"),
                "dimension": pd.Series(
                    [self._dimension_served] * int(sum(len(a) for a in pt))
                ).astype("str"),
                "period_end": np.concatenate(period),
                "date_public": np.concatenate(public),
                "revenue": np.concatenate(revenue),
                "netinc": np.concatenate(netinc),
                "equity": np.concatenate(equity),
                "assets": np.concatenate(assets),
                "liabilities": np.concatenate(liabilities),
                "ncfo": np.concatenate(ncfo),
                "capex": np.concatenate(capex),
                "sharesbas": np.concatenate(shares),
            }
        )
        frame = frame.assign(
            period_end=frame["period_end"].astype("datetime64[ns]"),
            date_public=frame["date_public"].astype("datetime64[ns]"),
        )
        return frame.sort_values(
            ["permaticker", "date_public"], kind="stable"
        ).reset_index(drop=True)


# -- bias surgery -------------------------------------------------------


def _collide(
    entities: list[_Entity],
    segments: dict[int, _Segment],
    reuse_pairs: list[tuple[int, int]],
) -> tuple[list[_Entity], dict[int, _Segment]]:
    """Merge each reuse pair into one id and one uninterrupted series.

    This is the WM bug, which is the reason `permaticker` exists. The
    dead company's bars and the living one's are welded together under
    a single id, and because the merge happens before the adjustment is
    derived, the result is arithmetically flawless: no gap, no jump, no
    inconsistent factor. The only surviving evidence is that Washington
    Mutual is still trading.
    """
    by_id = {e.permaticker: e for e in entities}
    absorbed: set[int] = set()

    for dead_id, heir_id in reuse_pairs:
        dead, heir = by_id.get(dead_id), by_id.get(heir_id)
        if dead is None or heir is None:
            continue
        merged = _Segment(
            idx=np.concatenate([segments[dead_id].idx, segments[heir_id].idx]),
            ticker=np.concatenate(
                [segments[dead_id].ticker, segments[heir_id].ticker]
            ),
            open=np.concatenate([segments[dead_id].open, segments[heir_id].open]),
            high=np.concatenate([segments[dead_id].high, segments[heir_id].high]),
            low=np.concatenate([segments[dead_id].low, segments[heir_id].low]),
            close=np.concatenate([segments[dead_id].close, segments[heir_id].close]),
            volume=np.concatenate(
                [segments[dead_id].volume, segments[heir_id].volume]
            ),
            split=np.concatenate([segments[dead_id].split, segments[heir_id].split]),
            dividend=np.concatenate(
                [segments[dead_id].dividend, segments[heir_id].dividend]
            ),
        )
        segments[dead_id] = merged
        del segments[heir_id]
        # The vendor's row now says what the symbol says today: the
        # living company's name, over the dead one's history.
        dead.name = heir.name
        dead.exchange = heir.exchange
        dead.category = heir.category
        dead.last_i = heir.last_i
        dead.is_delisted = heir.is_delisted
        dead.reason = heir.reason
        dead.symbol_changes = dead.symbol_changes + [
            (at, sym) for at, sym in heir.symbol_changes[1:]
        ]
        dead.ticker = heir.ticker
        absorbed.add(heir_id)

    return [e for e in entities if e.permaticker not in absorbed], segments


def _adjusted_only(prices: pd.DataFrame) -> pd.DataFrame:
    """Serve the adjusted series under both headings.

    Nothing breaks visibly. The schema validates, both columns are
    populated, and every price and liquidity screen in the repository
    quietly starts reading back-adjusted numbers — which is why the
    only way to catch it is to insist the two disagree where a split
    makes agreement arithmetically impossible.
    """
    factor = prices["close_adj"] / prices["close_unadj"]
    return prices.assign(
        open_unadj=prices["open_unadj"] * factor,
        high_unadj=prices["high_unadj"] * factor,
        low_unadj=prices["low_unadj"] * factor,
        close_unadj=prices["close_adj"],
        volume_unadj=prices["_volume_adj"],
    )


def _fabricate_sessions(
    rng: np.random.Generator, prices: pd.DataFrame, sessions: pd.DatetimeIndex
) -> pd.DataFrame:
    """Print bars on days the exchange was shut.

    Weekday holidays rather than Saturdays, because a bar dated the
    fourth of July is the version somebody might defend. Each fake row
    is a copy of the previous session's bar for a name that is trading
    on both sides of the hole, so it sits inside its own listing
    window, keeps its adjusted-to-as-traded ratio, and gives the
    calendar check the only thing it is entitled to find.
    """
    lo, hi = sessions[0], sessions[-1]
    weekdays = pd.date_range(lo, hi, freq="B")
    holidays = weekdays.difference(sessions)
    if holidays.empty:
        return prices
    picks = np.unique(
        np.linspace(0, len(holidays) - 1, min(6, len(holidays))).round().astype(int)
    )

    extra: list[pd.DataFrame] = []
    for p in picks:
        when = holidays[int(p)]
        before = sessions[sessions < when]
        after = sessions[sessions > when]
        if before.empty or after.empty:
            continue
        prev, nxt = before[-1], after[0]
        donors = prices.loc[prices["date"] == prev]
        alive = set(prices.loc[prices["date"] == nxt, "permaticker"].tolist())
        donors = donors.loc[donors["permaticker"].isin(alive)]
        if donors.empty:
            continue
        take = min(40, len(donors))
        rows = donors.iloc[
            np.sort(rng.choice(len(donors), size=take, replace=False))
        ].copy()
        nudge = 1.0 + rng.normal(0.0, 0.004, take)
        for col in (
            "open_unadj",
            "high_unadj",
            "low_unadj",
            "close_unadj",
            "close_adj",
        ):
            rows[col] = rows[col].to_numpy() * nudge
        rows["date"] = when
        rows["dividends"] = 0.0
        rows["split_factor"] = 1.0
        extra.append(rows)

    if not extra:
        return prices
    out = pd.concat([prices, *extra], ignore_index=True)
    return out.sort_values(["permaticker", "date"], kind="stable").reset_index(
        drop=True
    )


def _dilate(mask: np.ndarray, k: int) -> np.ndarray:
    """Widen a boolean mask by k positions in both directions."""
    out = mask.copy()
    for shift in range(1, k + 1):
        out[shift:] |= mask[:-shift]
        out[:-shift] |= mask[shift:]
    return out


def _break_adjustment(
    rng: np.random.Generator, prices: pd.DataFrame
) -> pd.DataFrame:
    """Adjust for actions that never happened.

    The mirror image of UNRECORDED_SPLITS. There the tape moves and the
    actions frame is silent; here the actions frame is complete, the
    tape is honest, and the back-adjustment carries a factor with
    nothing behind it — so the total-return series steps away from the
    price series on a day when, by the source's own account, nothing
    occurred. That is the whole defect, and it is the one a backtest
    least wants: as-traded prices anyone can check against a broker
    statement, and a return stream that is quietly wrong by a few basis
    points at a time.

    Three properties keep it a single defect rather than a smear.

    The factor is built the way `_backadjust` builds the real one — a
    trailing product, anchored at one on the final bar — so the panel
    still obeys the convention that the two closes meet where the
    series ends. What moves is history, which is exactly what a
    back-adjustment owns.

    Between phantoms the ratio of adjusted to as-traded is left at its
    honest value rather than rewobbled bar by bar. A per-row jitter
    would put a defect on every session pair in the panel, and a check
    that reports 100% of everything cannot be told from a check that is
    broken.

    And nothing is injected within a few sessions of a real action.
    Those days are the ones the two series are supposed to disagree on;
    an error hidden there is one the audit is entitled to miss.
    """
    pt = prices["permaticker"].to_numpy()
    adj = prices["close_adj"].to_numpy(dtype="float64").copy()
    split = prices["split_factor"].to_numpy(dtype="float64")
    div = prices["dividends"].to_numpy(dtype="float64")
    tick = prices["ticker"].to_numpy()

    lo, hi = BROKEN_ADJUSTMENT_SIZE
    edges = np.r_[np.flatnonzero(np.r_[True, pt[1:] != pt[:-1]]), len(pt)]

    for s, e in zip(edges[:-1], edges[1:]):
        n = int(e - s)
        if n < 3 * BROKEN_ADJUSTMENT_GUARD + 4:
            continue
        # A ticker change is an action too, and it is the one that lives
        # only in the price frame — reading it off the plan instead
        # would miss it on any name the collision bias has rewritten.
        action = (split[s:e] != 1.0) | (div[s:e] != 0.0)
        action[1:] |= tick[s + 1 : e] != tick[s : e - 1]
        # The first bar has nothing before it to disagree with, and the
        # last is both the delisting and the anchor the factor is one at.
        action[0] = action[-1] = True

        allowed = ~_dilate(action, BROKEN_ADJUSTMENT_GUARD)
        hit = (rng.random(n) < BROKEN_ADJUSTMENT_HAZARD) & allowed
        k = int(hit.sum())
        if not k:
            continue

        ratio = np.ones(n)
        ratio[hit] = 1.0 + np.where(rng.random(k) < 0.5, -1.0, 1.0) * rng.uniform(
            lo, hi, k
        )
        rev = np.cumprod(ratio[::-1])[::-1]
        factor = np.empty(n)
        factor[:-1] = rev[1:]
        factor[-1] = 1.0
        adj[s:e] *= factor

    return prices.assign(close_adj=adj)


# -- module helpers -----------------------------------------------------


def _backadjust(
    close: np.ndarray, split: np.ndarray, dividend: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Back-adjustment factors: total return, and splits alone.

    Both run backwards from one at the final bar, which is the vendor
    convention and the reason the two closes agree on the last row of
    every series and nowhere else. On a session with no action the
    factor does not move, so the adjusted and as-traded returns are
    equal to the last bit — which is exactly the property the audit's
    consistency check tests, and it must hold exactly rather than
    approximately or the check is measuring our arithmetic instead of
    the data.
    """
    n = len(close)
    prev = np.empty(n)
    prev[0] = close[0]
    prev[1:] = close[:-1]

    ratio_split = 1.0 / split
    ratio_div = np.clip(1.0 - dividend / prev, 1e-6, None)
    ratio = ratio_split * ratio_div

    def trailing(seq: np.ndarray) -> np.ndarray:
        rev = np.cumprod(seq[::-1])[::-1]
        out = np.empty(n)
        out[:-1] = rev[1:]
        out[-1] = 1.0
        return out

    return trailing(ratio), trailing(ratio_split)


def _action_frame(
    entities: list[_Entity],
    segments: dict[int, _Segment],
    sessions: pd.DatetimeIndex,
) -> pd.DataFrame:
    """Splits, symbol changes and deaths, in one frame.

    Splits are read back off the tape rather than out of the plan that
    produced it. That is not fussiness: TICKER_COLLISION merges two
    segments under one id, and a plan-driven actions frame would file
    the heir's splits against an entity that, in that telling, no
    longer exists. Reading the bars means the actions and the prices
    cannot drift apart however the panel is later cut about.
    """
    rows: list[dict[str, object]] = []
    for ent in entities:
        seg = segments.get(ent.permaticker)
        if seg is not None:
            for pos in np.flatnonzero(seg.split != 1.0):
                at = int(seg.idx[pos])
                rows.append(
                    {
                        "date": sessions[at],
                        "action": "split",
                        "ticker": str(seg.ticker[pos]),
                        "permaticker": ent.permaticker,
                        "name": ent.name,
                        "value": float(seg.split[pos]),
                        "contra_ticker": "",
                        "reason": "",
                    }
                )
        for at, sym in ent.symbol_changes[1:]:
            rows.append(
                {
                    "date": sessions[at],
                    "action": "tickerchange",
                    "ticker": sym,
                    "permaticker": ent.permaticker,
                    "name": ent.name,
                    "value": float("nan"),
                    "contra_ticker": _symbol_at(ent, at - 1),
                    "reason": "",
                }
            )
        if ent.is_delisted:
            rows.append(
                {
                    "date": sessions[ent.last_i],
                    "action": "delisted",
                    "ticker": ent.ticker,
                    "permaticker": ent.permaticker,
                    "name": ent.name,
                    "value": float("nan"),
                    "contra_ticker": "",
                    # The distinction the whole column exists for: an
                    # acquisition and a bankruptcy are opposite returns
                    # into the same terminating price series.
                    "reason": ent.reason,
                }
            )

    if not rows:
        return schema.ACTIONS.empty()
    frame = pd.DataFrame(rows)
    frame = frame.assign(
        date=frame["date"].astype("datetime64[ns]"),
        action=frame["action"].astype("str"),
        ticker=frame["ticker"].astype("str"),
        permaticker=frame["permaticker"].astype("Int64"),
        name=frame["name"].astype("str"),
        value=frame["value"].astype("float64"),
        contra_ticker=frame["contra_ticker"].astype("str"),
        reason=frame["reason"].astype("str"),
    )
    return frame.sort_values(
        ["date", "ticker", "action"], kind="stable"
    ).reset_index(drop=True)


def _master_frame(
    entities: list[_Entity], sessions: pd.DatetimeIndex
) -> pd.DataFrame:
    if not entities:
        return schema.SECURITY_MASTER.empty()
    dates = sessions.to_numpy()
    frame = pd.DataFrame(
        {
            "permaticker": np.array(
                [e.permaticker for e in entities], dtype="int64"
            ),
            "ticker": pd.Series([e.ticker for e in entities]).astype("str"),
            "name": pd.Series([e.name for e in entities]).astype("str"),
            "exchange": pd.Series([e.exchange for e in entities]).astype("str"),
            "category": pd.Series([e.category for e in entities]).astype("str"),
            "is_delisted": np.array([e.is_delisted for e in entities], dtype=bool),
            "first_price_date": dates[[e.first_i for e in entities]],
            "last_price_date": dates[[e.last_i for e in entities]],
            "currency": pd.Series(["USD"] * len(entities)).astype("str"),
            # Only meaningful on a dead row, which is why it is the
            # venue rather than a reason: an acquisition and a wipeout
            # both leave the same exchange.
            "delisted_from": pd.Series(
                [e.exchange if e.is_delisted else "" for e in entities]
            ).astype("str"),
        }
    )
    return frame.sort_values("permaticker", kind="stable").reset_index(drop=True)


def _symbol_at(ent: _Entity, at: int) -> str:
    symbol = ent.symbol_changes[0][1]
    for start_i, sym in ent.symbol_changes:
        if start_i <= at:
            symbol = sym
    return symbol


def _symbol_pool(
    rng: np.random.Generator, n: int, reserved: set[str]
) -> list[str]:
    """Unique symbols, none of them a decedent's.

    Collisions here would be indistinguishable from the deliberate
    reuse the recycling check is supposed to find, and a fixture whose
    accidental defects look like its intentional ones is worthless.
    """
    seen = set(reserved)
    out: list[str] = []
    while len(out) < n:
        k = 3 if rng.random() < 0.55 else 4
        candidate = "".join(rng.choice(_ALPHABET, size=k))
        if candidate in seen:
            continue
        seen.add(candidate)
        out.append(candidate)
    return out


def _company_name(rng: np.random.Generator) -> str:
    return (
        f"{rng.choice(_NAME_HEADS)} {rng.choice(_NAME_TAILS)} "
        f"{rng.choice(_NAME_SUFFIXES)}"
    )
