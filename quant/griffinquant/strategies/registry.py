"""Every strategy in the library, in one table, with the date that turns
each of them into an experiment rather than a backtest.

The whole design of this study rests on one field. A published strategy
measured from its own publication date forward carries an out-of-sample
guarantee nobody here can weaken, because the date was fixed by somebody
else, in a document, years ago, and cannot be moved once a result
exists. McLean and Pontiff put the size of what that measures at 58% of
the published return; Huang, Song and Xiang put smart-beta indices at
+2.77%/yr before listing and -0.44%/yr after. Neither number means
anything without the date.

**So the trap this file exists to close is the silent omission.** A
`published_on` that defaults to anything at all lets a strategy join the
table with a date nobody chose, and the result computed from it looks
exactly like every other row. `register` therefore takes `published_on`
as a keyword argument with NO DEFAULT — omitting it is a TypeError at
import, before any data is touched — and it refuses the two placeholder
sentinels the strategy modules use for "not set yet" (1900-01-01 and
1970-01-01), because a placeholder that survives to a report is worse
than a missing field: it is a missing field wearing a number.

**Undated is a value, not an absence.** Three rows here genuinely have
no publication date: holding SPY, and 60/40 at either of its two
rebalancing frequencies. They are conventions with no author and no
paper, and inventing a date for them would put a control into the
post-publication decay table wearing a decay claim nobody ever made
about it. So the sentinel `UNDATED` has to be passed EXPLICITLY, and
passing it requires a sentence saying why. `dated()` and `undated()`
keep the two groups apart at the query layer, so the decay table cannot
accidentally include a control and the benchmark table cannot
accidentally exclude one.

**The date is written twice on purpose.** Each strategy class carries
its own `published_on`, and the `register` call states it again;
disagreement raises at import. That is double-entry rather than
duplication — the class is where a reader checks the date against the
journal, the registry is where the study's table takes it from, and the
one failure this arrangement is built to prevent is somebody correcting
one of the two and shipping a table that disagrees with its own source.
Everything else on an entry (title, citation, universe, rationale,
departures) is READ off the class and never restated, because those can
drift harmlessly and the date cannot.

**Registration is complete or it is nothing.** `unregistered()` walks
each strategy module's own family tuple and reports any class this file
has not registered. `tests/test_strategies.py` parametrises over the
registry and asserts that set is empty, which is what makes adding a
strategy without a test impossible rather than merely discouraged.

One thing this file deliberately does NOT do: choose a backtest
configuration. `sleeve_capped` reports which of an entry's tickers carry
one of this fund's own sleeve ceilings, because a 60/40 run under a 40%
cap on SPY is not 60/40 and a VAA-G4 run under one is not VAA-G4 — but
the ceilings belong to `BacktestConfig`, the fix belongs in the harness,
and a registry that quietly rewrote a run's configuration would be
deciding the study's method inside a lookup table.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping, Sequence

import pandas as pd

from ..portfolio.sleeves import SLEEVES
from . import factor, riskparity, staticmix, tactical, trend

__all__ = [
    "Entry",
    "FAMILIES",
    "RegistryError",
    "UNDATED",
    "build",
    "catalogue",
    "entries",
    "entry",
    "families",
    "format_table",
    "keys",
    "panel_tickers",
    "register",
    "to_markdown",
    "unregistered",
]


class RegistryError(ValueError):
    """A strategy was offered to the library in a state it cannot be
    measured in."""


class _Undated:
    """The absence of a publication date, stated rather than defaulted.

    A singleton with a repr, so a table prints "UNDATED" and a reader
    sees a decision instead of an empty cell. It is deliberately not
    `None`: `None` is what an unset attribute already looks like, and
    the point of this object is to be something a person had to type.
    """

    _instance: _Undated | None = None

    def __new__(cls) -> _Undated:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNDATED"


UNDATED = _Undated()

#: The two "I have not been set" values the strategy modules use as
#: class-level defaults. Neither is a publication date and both would
#: sort first in any table, which is exactly how a placeholder gets
#: believed: it looks like the oldest and most established row.
_PLACEHOLDER_DATES: frozenset[date] = frozenset(
    {date(1900, 1, 1), date(1970, 1, 1)}
)

#: Nothing in this library predates it, and a date before it is a typo
#: rather than a very old paper. Banz (1981) is the earliest real one.
_EARLIEST_PLAUSIBLE = date(1900, 1, 2)

#: Sleeve ceilings, indexed by vehicle, straight from the sleeves
#: module rather than restated. See the module docstring on what this
#: is for and on what it is deliberately not for.
_SLEEVE_CAPS: Mapping[str, float] = {s.ticker: s.max_weight for s in SLEEVES}

#: The five families, in the order a report should read them: the
#: controls first, because everything else is read against them, then
#: the three rule families, then the factor tilts.
FAMILIES: tuple[str, ...] = ("static", "trend", "tactical", "risk", "factor")

_FAMILY_TITLES: Mapping[str, str] = {
    "static": "Fixed allocations and controls",
    "trend": "Trend following",
    "tactical": "Tactical asset allocation",
    "risk": "Risk-based allocation",
    "factor": "Factor tilts, held through ETFs",
}


# -- one row ------------------------------------------------------------


@dataclass(frozen=True)
class Entry:
    """One published strategy, everything the study needs to cite it.

    Frozen, because an entry is a claim about a document. A field
    mutated after import would leave the table and the paper it was
    read from saying different things, with nothing to notice.
    """

    key: str
    family: str
    title: str
    citation: str

    #: The experiment. `None` only where `undated_because` explains it,
    #: which `register` enforces and which nothing else may produce.
    published_on: date | None
    undated_because: str

    strategy_class: type
    #: The universe as the strategy declares it, which is not always
    #: what a run needs in its panel — see `panel`.
    universe: tuple[str, ...]
    #: Tickers a panel must carry for this run to be the published
    #: strategy. Empty means the rule adapts to whatever it is handed,
    #: which is true of 1/N and of nothing else here.
    panel: tuple[str, ...]
    rationale: str
    as_published: str

    #: Factor lines only: when the ticker's tape starts, and when
    #: holding the ticker first meant holding the idea. They differ for
    #: exactly one fund in the library and that fund is the reason the
    #: distinction exists.
    listed_on: date | None = None
    investable_from: date | None = None

    #: Prose where the vehicle has run more than one strategy under one
    #: symbol. Non-empty means a measurement crossing the change is
    #: measuring two things.
    mandate_changed: str = ""
    #: Anything about this row a runner has to act on rather than read.
    notes: str = ""

    # -- derived --------------------------------------------------------

    @property
    def dated(self) -> bool:
        return self.published_on is not None

    @property
    def measurable_from(self) -> date | None:
        """The first date a return here is evidence about the claim.

        Later of the paper and the vehicle. `None` for an undated
        control, which is not a gap — a control has no publication to
        be out of sample of, and should be measured over whatever
        sample the strategies it is a control FOR are measured over.
        """
        if self.published_on is None:
            return None
        if self.investable_from is None:
            return self.published_on
        return max(self.published_on, self.investable_from)

    @property
    def gap_days(self) -> int | None:
        """Publication to investability, signed.

        Negative means the product came first, which happened once
        (SPHQ) and is the opposite of the decay story. Not clipped.
        """
        if self.published_on is None or self.investable_from is None:
            return None
        return int((self.investable_from - self.published_on).days)

    @property
    def sleeve_capped(self) -> tuple[str, ...]:
        """This entry's tickers that carry one of THIS fund's ceilings.

        Derived rather than typed, so it cannot fall out of step with
        `portfolio/sleeves.py`. Non-empty means a run under a default
        `BacktestConfig` is measuring our risk policy and not the
        author's rule, and the harness owes it `apply_sleeve_caps=
        False`.
        """
        wanted = self.panel or self.universe
        return tuple(t for t in wanted if t in _SLEEVE_CAPS)

    @property
    def universe_label(self) -> str:
        """The universe as a cell in a table.

        1/N declares a hundred and fifty tickers and printing them
        would make the table unreadable and the row unfindable, so a
        long list is summarised. The full tuple is still on the entry
        for anything that needs to enumerate it.
        """
        if len(self.universe) > 16:
            return f"the whole ETF universe ({len(self.universe)} tickers)"
        return " ".join(self.universe)

    def build(self, **kwargs: Any) -> Any:
        """A FRESH instance, every time, and never a cached one.

        Several of these classes latch: `BuyAndHold` stops trading once
        deployed, `MonthlyRule` remembers the month it last decided in,
        `FactorStrategy` carries a high-water gross. Handing one object
        to two runs would start the second believing it had already
        bought the book, and the second run's opening weeks would
        silently not happen.
        """
        return self.strategy_class(**kwargs)

    def as_row(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "family": self.family,
            "title": self.title,
            "citation": self.citation,
            "published_on": (
                pd.NaT if self.published_on is None else pd.Timestamp(self.published_on)
            ),
            "undated_because": self.undated_because,
            "listed_on": (
                pd.NaT if self.listed_on is None else pd.Timestamp(self.listed_on)
            ),
            "investable_from": (
                pd.NaT
                if self.investable_from is None
                else pd.Timestamp(self.investable_from)
            ),
            "measurable_from": (
                pd.NaT
                if self.measurable_from is None
                else pd.Timestamp(self.measurable_from)
            ),
            "gap_days": pd.NA if self.gap_days is None else self.gap_days,
            "n_assets": len(self.universe),
            "universe": self.universe_label,
            "sleeve_capped": " ".join(self.sleeve_capped),
            "mandate_changed": self.mandate_changed,
            "notes": self.notes,
            "rationale": self.rationale,
            "as_published": self.as_published,
        }


_CATALOGUE_COLUMNS: dict[str, str] = {
    "key": "str",
    "family": "str",
    "title": "str",
    "citation": "str",
    "published_on": "datetime64[ns]",
    "undated_because": "str",
    "listed_on": "datetime64[ns]",
    "investable_from": "datetime64[ns]",
    "measurable_from": "datetime64[ns]",
    "gap_days": "Int64",
    "n_assets": "int64",
    "universe": "str",
    "sleeve_capped": "str",
    "mandate_changed": "str",
    "notes": "str",
    "rationale": "str",
    "as_published": "str",
}


# -- the register itself ------------------------------------------------


_ENTRIES: dict[str, Entry] = {}


def register(
    strategy_class: type,
    *,
    family: str,
    published_on: date | _Undated,
    undated_because: str = "",
    panel: Sequence[str] | None = None,
    notes: str = "",
) -> Entry:
    """Add one strategy, and refuse anything that cannot be measured.

    `published_on` is keyword-only and has no default, which is the
    single most important line in this file: a caller who forgets it
    gets a TypeError at import rather than a row in the study's table
    with a date nobody chose. `UNDATED` is the only way past it, and it
    demands a reason.

    Everything except the date is read off the class. That asymmetry is
    the point — a citation that drifts is embarrassing, a date that
    drifts silently invalidates the result computed from it — so the
    date is stated twice and cross-checked, and nothing else is.
    """
    key = str(getattr(strategy_class, "key", "") or "").strip()
    if not key:
        raise RegistryError(
            f"{strategy_class.__name__} carries no key. The key is the join "
            "between this library, the run log and the study's result table; "
            "a row that cannot be joined is a number with no strategy on it."
        )
    if key in _ENTRIES:
        raise RegistryError(
            f"two strategies claim the key {key!r} "
            f"({_ENTRIES[key].strategy_class.__name__} and "
            f"{strategy_class.__name__}). A collision there merges two "
            "records into one row and nothing downstream can tell."
        )
    if family not in FAMILIES:
        raise RegistryError(
            f"{key}: unknown family {family!r}; known families are "
            f"{list(FAMILIES)}"
        )

    declared = getattr(strategy_class, "published_on", None)

    if published_on is UNDATED:
        if not undated_because.strip():
            raise RegistryError(
                f"{key}: registered UNDATED with no reason. A strategy with "
                "no publication date is a legitimate control — 60/40 has no "
                "author — but it has to say so, because the alternative is "
                "indistinguishable from having forgotten the date, and the "
                "date is the experiment."
            )
        if declared is not None:
            raise RegistryError(
                f"{key}: registered UNDATED but the class declares "
                f"published_on={declared!r}. One of the two is wrong and a "
                "table cannot say which."
            )
        return _store(
            strategy_class,
            key=key,
            family=family,
            published_on=None,
            undated_because=undated_because.strip(),
            panel=panel,
            notes=notes,
        )

    if published_on is None:
        raise RegistryError(
            f"{key}: published_on is None. If this strategy genuinely has no "
            "publication — a convention with no author — pass UNDATED and a "
            "sentence saying so. None is what an unset attribute already "
            "looks like, and the two must not be the same gesture."
        )
    if not isinstance(published_on, date):
        raise RegistryError(
            f"{key}: published_on must be a datetime.date or UNDATED, got "
            f"{published_on!r}"
        )
    if published_on in _PLACEHOLDER_DATES:
        raise RegistryError(
            f"{key}: {published_on.isoformat()} is one of the strategy "
            "modules' 'not set yet' placeholders. A placeholder that reaches "
            "a report is worse than a missing field — it is a missing field "
            "wearing a number, and it sorts to the top of every table as the "
            "oldest and most established row in the library."
        )
    if published_on < _EARLIEST_PLAUSIBLE:
        raise RegistryError(
            f"{key}: published_on {published_on.isoformat()} predates "
            "anything this library could cite; that is a typo rather than a "
            "very old paper."
        )
    if published_on > date.today():
        raise RegistryError(
            f"{key}: published_on {published_on.isoformat()} is in the "
            "future. Measuring from a date that has not happened yet "
            "produces an empty window, which reads downstream as a strategy "
            "with no record rather than as a mistake here."
        )
    if declared is not None and declared != published_on:
        raise RegistryError(
            f"{key}: the class says published_on={declared.isoformat()} and "
            f"the registry says {published_on.isoformat()}. This is "
            "double-entry rather than duplication — the class is where a "
            "reader checks the date against the journal, and the registry is "
            "where the study's table takes it from — so a disagreement means "
            "one of the two was corrected and the other shipped."
        )
    if declared is None:
        raise RegistryError(
            f"{key}: registered with {published_on.isoformat()} but the "
            "class declares no publication date at all. The class is the "
            "source of record; put the date there first."
        )
    if undated_because:
        raise RegistryError(
            f"{key}: has both a publication date and a reason for having "
            "none. Only one of those can be true."
        )

    return _store(
        strategy_class,
        key=key,
        family=family,
        published_on=published_on,
        undated_because="",
        panel=panel,
        notes=notes,
    )


def _store(
    strategy_class: type,
    *,
    key: str,
    family: str,
    published_on: date | None,
    undated_because: str,
    panel: Sequence[str] | None,
    notes: str,
) -> Entry:
    """Read the rest off the class, check it is checkable, and file it.

    The four fields demanded below are the ones a reader has to be able
    to verify against a source. An entry with an empty citation is a row
    in a replication study that nobody can trace back to a paper, which
    is the one thing a replication study cannot contain.
    """
    for field in ("title", "citation", "rationale", "as_published"):
        if not str(getattr(strategy_class, field, "") or "").strip():
            raise RegistryError(
                f"{key}: the class has no {field}. Every field here is one a "
                "reader checks against a journal or a prospectus, and "
                "`as_published` is the one that says where we departed — an "
                "empty one claims a faithful replication by omission."
            )

    universe = tuple(str(t) for t in getattr(strategy_class, "universe", ()) or ())
    if not universe:
        raise RegistryError(f"{key}: the class declares no universe")

    listed = getattr(strategy_class, "listed_on", None)
    investable = getattr(strategy_class, "investable_from", None)
    # The factor module's own "never set" sentinel, refused for the same
    # reason as a placeholder publication date.
    if listed in _PLACEHOLDER_DATES or investable in _PLACEHOLDER_DATES:
        raise RegistryError(
            f"{key}: listed_on/investable_from is still the class "
            "placeholder, so the vehicle's date was never written down"
        )

    entry = Entry(
        key=key,
        family=family,
        title=str(strategy_class.title),
        citation=str(strategy_class.citation),
        published_on=published_on,
        undated_because=undated_because,
        strategy_class=strategy_class,
        universe=universe,
        panel=tuple(str(t) for t in (universe if panel is None else panel)),
        rationale=str(strategy_class.rationale),
        as_published=str(strategy_class.as_published),
        listed_on=listed if isinstance(listed, date) else None,
        investable_from=investable if isinstance(investable, date) else None,
        mandate_changed=str(getattr(strategy_class, "mandate_changed", "") or ""),
        notes=notes,
    )
    _ENTRIES[key] = entry
    return entry


# -- querying -----------------------------------------------------------


def keys() -> tuple[str, ...]:
    return tuple(_ENTRIES)


def entry(key: str) -> Entry:
    try:
        return _ENTRIES[key]
    except KeyError:
        raise RegistryError(
            f"no strategy named {key!r}. Registered: {sorted(_ENTRIES)}"
        ) from None


def entries(
    *, family: str | None = None, dated: bool | None = None
) -> tuple[Entry, ...]:
    """The library, optionally narrowed.

    `dated=True` is the post-publication table's population and
    `dated=False` is the controls. Keeping the filter here rather than
    at each call site is what stops a decay table quietly acquiring a
    row about which no decay claim was ever made.
    """
    if family is not None and family not in FAMILIES:
        raise RegistryError(f"unknown family {family!r}; known: {list(FAMILIES)}")
    out = [
        e
        for e in _ENTRIES.values()
        if (family is None or e.family == family)
        and (dated is None or e.dated is dated)
    ]
    return tuple(out)


def families() -> tuple[str, ...]:
    return FAMILIES


def build(key: str, **kwargs: Any) -> Any:
    """A fresh instance of one strategy. See `Entry.build`."""
    return entry(key).build(**kwargs)


def panel_tickers(strategies: Sequence[Entry] | None = None) -> tuple[str, ...]:
    """Every ticker a panel needs to run these entries as published.

    Sorted, de-duplicated, and derived from the entries rather than
    typed, so a strategy added with a ticker nobody has pulled yet
    surfaces here instead of as a missing column three thousand
    sessions into a run.
    """
    wanted: set[str] = set()
    for e in _ENTRIES.values() if strategies is None else strategies:
        wanted.update(e.panel)
    return tuple(sorted(wanted))


# -- printing -----------------------------------------------------------


def catalogue(strategies: Sequence[Entry] | None = None) -> pd.DataFrame:
    """The library as a typed frame, in family then publication order.

    Sorted by family and then by date because that is the order the
    argument runs in: the controls have no date and come first, and
    within a family the rules arrive into a world that had already read
    the earlier ones.
    """
    chosen = _ENTRIES.values() if strategies is None else strategies
    rows = [e.as_row() for e in chosen]
    if not rows:
        return pd.DataFrame(
            {c: pd.Series([], dtype=t) for c, t in _CATALOGUE_COLUMNS.items()}
        )
    frame = pd.DataFrame(rows)[list(_CATALOGUE_COLUMNS)].astype(_CATALOGUE_COLUMNS)
    order = {f: i for i, f in enumerate(FAMILIES)}
    frame = frame.assign(_family_order=frame["family"].map(order))
    frame = frame.sort_values(
        ["_family_order", "published_on", "key"], na_position="first"
    )
    return frame.drop(columns="_family_order").reset_index(drop=True)


_TABLE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("key", "key"),
    ("family", "family"),
    ("published_on", "published"),
    ("investable_from", "investable"),
    ("universe", "universe"),
)


def format_table(strategies: Sequence[Entry] | None = None) -> str:
    """The catalogue as fixed-width text, for a terminal or a log.

    Deliberately narrow: five columns, no prose. The citation and the
    departures are paragraphs and a table that tries to hold them is a
    table nobody reads. `to_markdown` is the version with the prose in
    it, and `catalogue()` is the version a program should consume.
    """
    frame = catalogue(strategies)
    rows: list[list[str]] = [[label for _, label in _TABLE_COLUMNS]]
    for record in frame.to_dict("records"):
        rows.append(
            [
                str(record["key"]),
                str(record["family"]),
                _stamp(record["published_on"], "UNDATED"),
                _stamp(record["investable_from"], "-"),
                str(record["universe"]),
            ]
        )
    widths = [max(len(r[i]) for r in rows) for i in range(len(_TABLE_COLUMNS))]
    lines = [
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(rows[0])).rstrip(),
        "  ".join("-" * w for w in widths),
    ]
    lines.extend(
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        for row in rows[1:]
    )
    return "\n".join(lines)


def to_markdown(strategies: Sequence[Entry] | None = None) -> str:
    """The catalogue as a markdown table, for the report.

    Written by hand rather than through `DataFrame.to_markdown`, which
    needs `tabulate` and is not installed; a report that cannot be
    regenerated because of an optional dependency is a report that stops
    being regenerated.
    """
    header = (
        "| key | family | published | investable | gap (yrs) | universe |",
        "| --- | --- | --- | --- | --- | --- |",
    )
    lines = list(header)
    for record in catalogue(strategies).to_dict("records"):
        gap = record["gap_days"]
        lines.append(
            "| {key} | {family} | {pub} | {inv} | {gap} | {universe} |".format(
                key=record["key"],
                family=record["family"],
                pub=_stamp(record["published_on"], "_undated_"),
                inv=_stamp(record["investable_from"], "-"),
                gap="-" if pd.isna(gap) else f"{int(gap) / 365.25:+.2f}",
                universe=record["universe"],
            )
        )
    return "\n".join(lines)


def _stamp(value: Any, absent: str) -> str:
    return absent if pd.isna(value) else pd.Timestamp(value).date().isoformat()


# -- completeness -------------------------------------------------------


#: Tactical has no module-level family tuple to enumerate, so this file
#: keeps one. It is the only list here that is not read off its own
#: module, which makes it the one that can silently go stale — which is
#: exactly why `unregistered()` checks the OTHER four against their
#: modules and this one is checked against the module's `__all__` by the
#: test suite.
TACTICAL_STRATEGIES: tuple[type, ...] = (
    tactical.AdaptiveAssetAllocation,
    tactical.ProtectiveAssetAllocation,
    tactical.VigilantAssetAllocation,
    tactical.VigilantAssetAllocationG4,
    tactical.DefensiveAssetAllocation,
    tactical.GlobalTacticalAssetAllocationAggressive,
)

#: Every family, beside the module tuple that is its source of truth.
_FAMILY_SOURCES: Mapping[str, tuple[type, ...]] = {
    "static": staticmix.STATIC_MIXES,
    "trend": trend.TREND_STRATEGIES,
    "tactical": TACTICAL_STRATEGIES,
    "risk": riskparity.RISK_BASED_STRATEGIES,
    "factor": factor.FACTOR_STRATEGIES,
}


def unregistered() -> tuple[str, ...]:
    """Strategy classes their own module lists and this file does not.

    The guard that makes the parametrised test suite a guarantee rather
    than a habit. A strategy is added to the library by writing a class
    and putting it in its module's family tuple; if it never reaches
    this file it gets no publication date, no citation check and no
    test, and the run that eventually includes it produces a number with
    nothing attached. Non-empty here is a build failure, not a warning.
    """
    missing: list[str] = []
    for family, classes in _FAMILY_SOURCES.items():
        for cls in classes:
            key = str(getattr(cls, "key", "") or "")
            if key not in _ENTRIES:
                missing.append(f"{family}:{cls.__name__}")
    return tuple(missing)


# -- the library --------------------------------------------------------
#
# One call per published strategy, grouped by family and in the order
# each module argues them. The date on every line is stated here and
# again on the class, and they are checked against each other above.


# Fixed allocations. The first three are the controls and are the reason
# `UNDATED` exists: measuring 60/40 "from its publication date" would
# require inventing one, and a fabricated date is a decay claim about a
# convention nobody ever claimed anything about.

register(
    staticmix.BuyAndHoldSPY,
    family="static",
    published_on=UNDATED,
    undated_because=(
        "the benchmark, not a published strategy. Holding the index has no "
        "author and no date, and it is what every other row in this library "
        "is measured against — so it is measured over whatever sample the "
        "comparison needs and never appears in the post-publication table."
    ),
    notes=(
        "the hardest row in the study: 10.69%/yr over 2005-2026, no "
        "parameter to fit, no turnover after deployment"
    ),
)

register(
    staticmix.SixtyFortyMonthly,
    family="static",
    published_on=UNDATED,
    undated_because=(
        "folklore. The balanced-fund convention has no author and no paper; "
        "Vanguard Wellington has run something close since 1929. A date "
        "here would be manufactured."
    ),
    notes=(
        "one of two readings of 60/40 — quoting whichever came back better "
        "is two trials and one reported result"
    ),
)

register(
    staticmix.SixtyFortyDaily,
    family="static",
    published_on=UNDATED,
    undated_because=(
        "same convention as the monthly row, at the other rebalancing "
        "frequency. No source states either, so neither is preferred."
    ),
    notes=(
        "the pair reads out what the rebalancing premium is worth net of "
        "friction at this account's size"
    ),
)

register(
    staticmix.PermanentPortfolio,
    family="static",
    published_on=staticmix.PermanentPortfolio.published_on,
    notes=(
        "pinned to the 1981 book rather than the 1982 fund launch; no bill "
        "ETF before May 2007 and no gold ETF before November 2004, so a run "
        "starting earlier has to print absences()"
    ),
)

register(
    staticmix.AllWeatherRetail,
    family="static",
    published_on=staticmix.AllWeatherRetail.published_on,
    notes=(
        "a POPULARISED APPROXIMATION, not Bridgewater's fund, which is "
        "levered and whose weights are not public"
    ),
)

register(
    staticmix.EqualWeightUniverse,
    family="static",
    published_on=staticmix.EqualWeightUniverse.published_on,
    # The one entry whose panel is empty: 1/N holds whatever it is
    # handed, so there is no named leg that can go missing and no
    # ticker a run must carry. `absences()` is empty here by
    # construction and must never be read as "every fund existed".
    panel=(),
    notes=(
        "an extension rather than a replication — the paper's "
        "cross-sections are equity and factor portfolios, not an ETF "
        "universe. N is time-varying by design."
    ),
)


# Trend following.

register(
    trend.Faber2007,
    family="trend",
    published_on=trend.Faber2007.published_on,
    panel=trend.Faber2007.DEFAULT_ASSETS + ("BIL",),
    notes=(
        "the journal issue is dated only 'Spring 2007'; this is the end of "
        "April on the round-late rule. The SSRN working paper circulated in "
        "2006-07 and a reader preferring that date gains about a year."
    ),
)

register(
    trend.AbsoluteMomentum,
    family="trend",
    published_on=trend.AbsoluteMomentum.published_on,
    panel=("SPY", "BIL"),
    notes=(
        "the SSRN posting day is not pinned in anything this repo holds; "
        "2013-04-30 is a round-late guess and is documented as one"
    ),
)

register(
    trend.DualMomentumGEM,
    family="trend",
    published_on=trend.DualMomentumGEM.published_on,
    panel=("SPY", "VXUS", "AGG", "BIL"),
    notes=(
        "the absolute gate has two readings in the source and they differ "
        "in one enumerated case; the default reads the S&P 500 per the "
        "book's flowchart, gate_on_winner=True is the other. Running both "
        "is two trials. The 2012 NAAIM Wagner Award paper is the idea's "
        "earlier public appearance and would add two years."
    ),
)


# Tactical asset allocation.

register(
    tactical.AdaptiveAssetAllocation,
    family="tactical",
    published_on=tactical.AdaptiveAssetAllocation.published_on,
    notes=(
        "the weakest date in the library: year precision, SSRN refuses "
        "datacentre traffic, and the attribute is the latest day "
        "consistent with what could be verified. RWX has no column in this "
        "project's panel, so the run ranks nine of ten."
    ),
)

register(
    tactical.ProtectiveAssetAllocation,
    family="tactical",
    published_on=tactical.ProtectiveAssetAllocation.published_on,
    notes=(
        "the SMA window is 13 month-end closes; the paper's notation admits "
        "12 and that reading is a second trial rather than a bug fix. GSG "
        "is substituted by DBC."
    ),
)

register(
    tactical.VigilantAssetAllocation,
    family="tactical",
    published_on=tactical.VigilantAssetAllocation.published_on,
    notes="GSG substituted by DBC; LQD sits in both legs, as published",
)

register(
    tactical.VigilantAssetAllocationG4,
    family="tactical",
    published_on=tactical.VigilantAssetAllocationG4.published_on,
    notes=(
        "100% of NAV in one ETF when momentum is clean, which is the rule "
        "and not a rounding of it — this row is the reason the tactical "
        "family must be run with apply_sleeve_caps=False"
    ),
)

register(
    tactical.DefensiveAssetAllocation,
    family="tactical",
    published_on=tactical.DefensiveAssetAllocation.published_on,
    notes=(
        "an incomplete canary holds nothing and says so: halving B from 2 "
        "to 1 would double every protective threshold while the strategy "
        "still called itself DAA. The G6/G4/U1/U3 variants are "
        "deliberately not written — an invented universe measured from a "
        "real publication date looks like evidence."
    ),
)

register(
    tactical.GlobalTacticalAssetAllocationAggressive,
    family="tactical",
    published_on=tactical.GlobalTacticalAssetAllocationAggressive.published_on,
    notes=(
        "the thirteen tickers are a reading of a universe table that is an "
        "IMAGE in the PDF, and are the least certain thing in the tactical "
        "file. IWC and BWX are not in this project's panel. The 2013 date "
        "has a stricter reading through Faber (2010) and The Ivy Portfolio "
        "(2009), which must be reported with any post-publication claim."
    ),
)


# Risk-based allocation.

register(
    riskparity.InverseVolatilityRiskParity,
    family="risk",
    published_on=riskparity.InverseVolatilityRiskParity.published_on,
    notes=(
        "UNLEVERED, which is not the strategy Qian described: the published "
        "construction levers the risk-balanced core to an equity-like risk "
        "target. Bridgewater's 1996 All Weather is earlier and does not "
        "count — a private fund is not a public record."
    ),
)

register(
    riskparity.EqualRiskContribution,
    family="risk",
    published_on=riskparity.EqualRiskContribution.published_on,
    notes=(
        "unlevered, as above. The journal issue is used over the 2008 SSRN "
        "working paper because it can be verified to a document; the choice "
        "costs about twenty months and cannot flatter the strategy."
    ),
)

register(
    riskparity.MinimumVariance,
    family="risk",
    published_on=riskparity.MinimumVariance.published_on,
    notes=(
        "run over eleven sector SPDRs rather than a thousand-stock "
        "cross-section, which is a weak stand-in: most of what a "
        "minimum-variance optimiser removes is idiosyncratic and a sector "
        "ETF has already diversified that away. A shortfall against SPY "
        "measures the leverage constraint, not the anomaly."
    ),
)

register(
    riskparity.MaximumDiversification,
    family="risk",
    published_on=riskparity.MaximumDiversification.published_on,
    notes=(
        "the one strategy in the risk family whose leverage profile we can "
        "match. Shrinkage dulls exactly the edge of the estimate this rule "
        "exploits, so read it as the shrunk version of the published rule."
    ),
)


# Factor tilts. These are the only entries carrying a second date, and
# the gap between the two is the most interesting column in the table.

register(
    factor.MomentumMTUM,
    family="factor",
    published_on=factor.MomentumMTUM.published_on,
    notes="20.1 years from paper to fund; long leg only, so no short side",
)

register(
    factor.MomentumSPMO,
    family="factor",
    published_on=factor.MomentumSPMO.published_on,
    notes=(
        "SPMO is NOT in etfuniverse.UNIVERSE as that file stands and has to "
        "be added before this row can be run against real bars"
    ),
)

register(
    factor.ValueVLUE,
    family="factor",
    published_on=factor.ValueVLUE.published_on,
    notes="sector-neutral, where the academic sort was not",
)

register(
    factor.ValueIWD,
    family="factor",
    published_on=factor.ValueIWD.published_on,
    notes=(
        "here for its start date: eight years is the shortest "
        "publication-to-vehicle gap available for value, and IWD covers "
        "four regimes VLUE never sees"
    ),
)

register(
    factor.ValueVTV,
    family="factor",
    published_on=factor.ValueVTV.published_on,
    notes=(
        "the benchmark changed from MSCI to CRSP in 2013 — an index "
        "transition inside the series, not a mandate change"
    ),
)

register(
    factor.QualityQUAL,
    family="factor",
    published_on=factor.QualityQUAL.published_on,
    notes=(
        "does not implement the paper: QUAL sorts on ROE, debt/equity and "
        "earnings variability, and gross profits over assets is not among "
        "them. No US ETF implements it."
    ),
)

register(
    factor.QualitySPHQ,
    family="factor",
    published_on=factor.QualitySPHQ.published_on,
    notes=(
        "the only NEGATIVE gap in the library — product before paper — and "
        "the only ticker whose investable_from is not its listing date. "
        "That 2012-01-03 is a deliberately conservative placeholder: check "
        "Invesco's prospectus history before this line enters the study's "
        "table. The direction of the correction is known (earlier)."
    ),
)

register(
    factor.LowVolatilityUSMV,
    family="factor",
    published_on=factor.LowVolatilityUSMV.published_on,
    notes=(
        "the unlevered long leg of a levered long-short claim; the "
        "published BAB Sharpe is not available to this account at any "
        "price. No Kenneth French series exists for this factor and the "
        "absence is recorded rather than filled with a near neighbour."
    ),
)

register(
    factor.LowVolatilitySPLV,
    family="factor",
    published_on=factor.LowVolatilitySPLV.published_on,
    notes=(
        "the plain sort beside USMV's optimiser: where the two diverge, "
        "the difference is the optimiser"
    ),
)

register(
    factor.EqualWeightRSP,
    family="factor",
    published_on=factor.EqualWeightRSP.published_on,
    notes=(
        "a poor proxy for Banz and named as one. IWM and IJR fit the "
        "published claim better and were deliberately NOT substituted — "
        "swapping a vehicle for one that fits the story is the first move "
        "this study exists to observe."
    ),
)

register(
    factor.FundamentalIndexPRF,
    family="factor",
    published_on=factor.FundamentalIndexPRF.published_on,
    notes=(
        "nine months from journal to fund, the shortest gap in the file, "
        "and very nearly a pure post-publication live record"
    ),
)

register(
    factor.MultiFactorIShares,
    family="factor",
    published_on=factor.MultiFactorIShares.published_on,
    notes=(
        "a SYNTHESIS, not a replication: the components are published and "
        "the equal-weight recipe is ours. rebalance=False is the drifting "
        "reading and both are meant to be measured."
    ),
)

register(
    factor.MultiFactorSix,
    family="factor",
    published_on=factor.MultiFactorSix.published_on,
    notes=(
        "equal weighted in VEHICLES, which is not equal weighted in "
        "exposures — PRF, RSP and VLUE triple-count the value-and-size "
        "corner. No correction applied; correcting it needs an exposure "
        "model nobody published."
    ),
)

register(
    factor.MultiFactorLongestHistory,
    family="factor",
    published_on=factor.MultiFactorLongestHistory.published_on,
    notes=(
        "has no momentum leg because no momentum ETF existed when it "
        "became investable, which is the finding rather than an omission. "
        "Inherits SPHQ's date problem whole."
    ),
)


_STALE = unregistered()
if _STALE:  # pragma: no cover - import-time guard
    raise RegistryError(
        "these strategy classes are listed by their own module and not by "
        f"this registry: {list(_STALE)}. An unregistered strategy has no "
        "publication date, no citation check and no test, and a run that "
        "includes it produces a number with nothing attached to it."
    )
