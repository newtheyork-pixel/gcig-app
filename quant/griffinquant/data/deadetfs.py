"""The ETF universe as a function of a date, dead funds included.

`etfuniverse.py` holds a list of 148 funds somebody wrote down in 2026
by looking at what still trades. Every result in this repository rests
on it, and the bias that introduces is ours rather than the vendor's —
which is the good news, because ours is the kind that can be fixed. The
vendor's directory carries 7,747 tradable ETF rows and 2,069 of them
ended at a date in the past. This module is the fix: build the universe
from the whole catalogue and evaluate it ON A DAY, so that a rebalance
in June 2011 sees the funds that existed in June 2011 and not the ones
that survived to be typed into a list fifteen years later.

**The answer to "there aren't that many".** Of the 558 ETFs listed on
the first day of 2005, 202 are dead — 36%. The share is above 30% for
every cohort from 2005 to 2018 and only falls below it in the years too
recent for the deaths to have happened yet. `attrition` prints that
table and it is meant to be read without commentary.

**A ticker is not a key, and this is the failure that would ruin the
fix.** 161 shelf symbols carry more than one coverage window. Ninety of
them are one series that moved venue — AIEQ from NYSEARCA to NYSE in
January 2024, contiguous to the day — and merging those is right. The
other 71 are a symbol that was released and reissued: ACTV traded to
November 2013, then a different fund wore the ticker from October 2020.
Tiingo's price endpoint serves ONE series per symbol, so asking it for
ACTV cannot produce a fund; it produces whichever of the two the vendor
decided the string means. Those symbols are marked unresolvable, are
excluded from every universe this module returns, and are COUNTED — the
same refusal `resolve_universe` makes, for the same reason, applied to
seventy-one cases instead of nought.

**The vendor's retention has a start date, and it is 2014.** This is
the finding that bounds everything else and it was not expected. The
catalogue records one ETF closure in 2010, three in 2011, two in 2013 —
and then forty-four in 2014, a hundred in 2015, and between a hundred
and two hundred and fifty every year since. Across all asset types it is
55 delistings in 2009 against 1,969 in 2016. No market has that shape.
So the 2005 cohort really is 36% dead as counted, and every one of those
deaths is dated 2014 or later, which means the funds that listed in 2005
and closed in 2009 are not in the file at all. `retention_cliff` finds
the boundary from the data and estimates the hole behind it from the
catalogue's OWN post-cliff closure rates: 222 to 479 ETF closures it
does not carry. **A panel built here is survivorship-free from 2014
forward and cannot be made so for 2005-2013**, which is the first nine
years of every result in this repository. That is not a caveat about
this module; it is the ceiling on what any free source can do for the
first half of the sample.

**The bias runs both ways, and the other direction is easier to miss.**
Widening from 148 hand-picked funds to a whole catalogue removes a
survivorship bias and admits a contamination: Tiingo's `assetType` files
closed-end funds under ETF, and a CEF trades at a persistent discount to
NAV, so a backtest marking one at NAV manufactures alpha nobody could
collect — which `config.HARD_EXCLUDED_CATEGORIES` bars by name and this
catalogue cannot express. One test is available and it is a hard one:
**no US ETF existed before SPY listed on 1993-01-29**, so 136 shelf
symbols that open earlier are not ETFs, 63 of them dead, and they are
excluded. That is a floor and not a screen — NKG is a Nuveen municipal
CEF whose coverage starts in 2002 and it walks straight through. The
number is reported by `composition` as a lower bound rather than as a
clean-up.

**Directory rows are not evidence of bars.** A row saying a fund traded
from 2009 to 2014 is the vendor's index, not its tape, and the gap
between the two is itself a measurement. `pull_dead` fetches and
`recovery_report` states how many came back empty. A universe that is
90% survivorship-free is not survivorship-free, so the residual is a
number here and never a caveat.

**The plan is shuffled on a fixed seed, and that is a statistical
decision rather than a stylistic one.** Two thousand dead funds at the
free tier's fifty symbols an hour is a day and a half of pulling, so any
run inside one sitting recovers a SUBSET. Ordered longest-lived first,
that subset would over-represent funds that lived long enough to be
acquired and under-represent the ones that failed in three years, which
is the exact bias being measured — the partial result would then be
worse than no result, because it would look like an answer. Shuffled, a
partial pull is an unbiased random sample of the dead population and
supports an interval; `deployable_estimate` computes it.

**Most dead funds could never have been held, and that is the finding
that shrinks the problem.** This account's participation cap and
turnover budget put a floor of $655,000 of median daily dollar volume
under any position — see `deployable_floor`, which derives it from three
engine constants rather than restating the number. A fund whose tape
never carried that could not have entered the book on any day of its
life, so its absence from the panel biases nothing. The 36% attrition
figure is about the ETF industry; the figure that matters to a backtest
is how much of it cleared the floor, and that is measured on the bars
rather than assumed either way.

**Politeness is not decoration here.** The free tier meters SYMBOLS, so
no pause buys another one and only waiting does. Everything lands in the
cache, and the cache entry is pinned to `asof` rather than to today —
a fund whose last bar printed in 2013 cannot gain one tomorrow, and
keying its history on the day we happened to ask would make the cache
forget a permanent fact every midnight, turning a day of polite pulling
into a day of impolite re-pulling.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd

from ..config import SAMPLE_START, UNIVERSE
from .base import SourceUnavailable
from .etfuniverse import (
    ETF_ASSET_TYPE,
    MAJOR_VENUES,
    PRICE_CURRENCY,
    PULL_PAUSE_SECONDS,
    STALE_AFTER_DAYS,
    UNIVERSE_TICKERS,
    ETFUniverseSource,
)
from .keyedsleeves import HISTORY_START

if TYPE_CHECKING:
    from .cache import ParquetCache


# -- what a fund's directory row can be -----------------------------------


#: Coverage runs to within `STALE_AFTER_DAYS` of the as-of date. Not a
#: claim the fund is healthy — only that the vendor is still printing
#: bars for it.
STATUS_ALIVE = "alive"

#: Coverage stopped. The date is the last bar the vendor holds and is
#: emphatically NOT a delisting date: RSX's final print is a zero-volume
#: mark carried through a halt months after anyone traded it, and the
#: catalogue publishes the end of COVERAGE either way.
STATUS_DEAD = "dead"

#: The window cannot produce a return — one print or none. Six shelf
#: symbols are this, and they are directory artefacts rather than funds:
#: nothing can enter or leave a portfolio on a series with no second
#: observation, so calling them dead would inflate the attrition figure
#: with entities that never had a life to lose.
STATUS_NEVER_TRADED = "never_traded"

STATUSES: tuple[str, ...] = (STATUS_ALIVE, STATUS_DEAD, STATUS_NEVER_TRADED)

#: SPY's own first bar, and the first day a US exchange-traded fund
#: existed. A shelf row whose coverage begins earlier is therefore not
#: an ETF whatever the vendor's `assetType` says, and 136 of them do —
#: TAI from 1990, NXN from 1992, MNP from three days before SPY itself.
#: They are closed-end funds, which `config.HARD_EXCLUDED_CATEGORIES`
#: bars by name: a CEF trades at a persistent discount to NAV and a
#: backtest marking one at NAV manufactures alpha nobody could collect.
#:
#: This is the one contamination test the directory can support on its
#: own, and it is a floor rather than a screen. NKG is a Nuveen
#: municipal closed-end fund whose coverage starts in 2002 and it passes
#: cleanly — see `composition`, which reports what the rule catches
#: without pretending it catches the rest.
FIRST_US_ETF = date(1993, 1, 29)

#: Two coverage windows closer together than this are one series that
#: moved venue; further apart, they are two funds that wore the same
#: string. Five days rather than zero because a migration can straddle a
#: long weekend, and rather than thirty because a month of silence is
#: already long enough to be a wind-down. The split it produces — ninety
#: symbols merged against seventy refused — is stable anywhere between
#: two days and several weeks, which is the reassurance worth having
#: about a constant nobody can derive.
RECYCLE_GAP_DAYS = 5

#: A fund needs `UNIVERSE.min_history_days` sessions before any rule in
#: the library can act on it, and the directory speaks in calendar days
#: rather than sessions. Written as the conversion rather than as the
#: 365 it currently evaluates to, so that moving the session count moves
#: this with it instead of leaving a stale number nobody rechecks.
SESSIONS_PER_YEAR = 252
MIN_PLAN_DAYS = int(round(UNIVERSE.min_history_days * 365.0 / SESSIONS_PER_YEAR))

#: Fixed so the plan is the same list on every machine and in every
#: rerun. A shuffled acquisition order whose shuffle moved between runs
#: would make a resumed pull sample the population twice and some of it
#: never, which is the one thing a random order was chosen to avoid.
PLAN_SEED = 20260803

#: Below this, no packet left the building. Used to tell a cache read
#: from a request so a resumed run does not spend twenty-eight minutes
#: pausing politely between reads of its own disk. Generous by two
#: orders of magnitude against the fastest measured round trip to the
#: vendor, which was 0.1s, because the error that matters is calling a
#: real request a cache hit and skipping the pacing.
CACHE_HIT_SECONDS = 0.02


# -- the shelf ------------------------------------------------------------


def etf_shelf(directory: pd.DataFrame) -> pd.DataFrame:
    """The rows this project could actually have shopped from.

    ETF-typed, priced in dollars, on a venue whose fills are real. The
    full catalogue carries 9,397 ETF rows and most of the difference is
    not close: 742 are CNY lines on Shanghai and Shenzhen, and 589 sit
    on PINK, where an ETF quote is a foreign line or a wind-down husk.
    Counting those would make the attrition figure describe a shelf
    nobody here was ever standing in front of.
    """
    if not isinstance(directory, pd.DataFrame) or directory.empty:
        raise SourceUnavailable(
            "the directory is empty, so there is no shelf to describe. "
            "Reported as zero dead funds this would read as an ETF industry "
            "in which nothing has ever closed — which is the conclusion this "
            "module exists to disprove."
        )
    missing = [
        c
        for c in ("ticker", "exchange", "asset_type", "currency", "start_date",
                  "end_date")
        if c not in directory.columns
    ]
    if missing:
        raise SourceUnavailable(
            f"the directory is missing column(s) {missing}; got "
            f"{sorted(directory.columns)}. Every count below is unverified "
            f"until the shape is what `fetch_directory` promises."
        )
    shelf = directory.loc[
        (directory["asset_type"] == ETF_ASSET_TYPE)
        & (directory["currency"] == PRICE_CURRENCY)
        & directory["exchange"].isin(MAJOR_VENUES)
    ]
    # The vendor repeats a row now and then; an exact duplicate is not a
    # second listing window and would make a symbol look recycled.
    return shelf.drop_duplicates(
        subset=["ticker", "exchange", "start_date", "end_date"]
    ).reset_index(drop=True)


def _windows(
    starts: Sequence[Any], ends: Sequence[Any]
) -> list[list[pd.Timestamp]]:
    """Coverage windows for one symbol, venue migrations merged.

    Merging is deliberately generous and splitting deliberately strict:
    a wrongly merged pair costs a slightly early start date, while a
    wrongly split pair costs a symbol that gets refused. The second
    error is visible in the unresolvable count and the first is not,
    which is the ordering to want.
    """
    pairs = sorted(
        (pd.Timestamp(s), pd.Timestamp(e))
        for s, e in zip(starts, ends)
        if pd.notna(s) and pd.notna(e)
    )
    out: list[list[pd.Timestamp]] = []
    for start, end in pairs:
        if out and (start - out[-1][1]).days <= RECYCLE_GAP_DAYS:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out


_CLASSIFIED_DTYPES: dict[str, str] = {
    "ticker": "str",
    "exchange": "str",
    "status": "str",
    "first_available": "datetime64[ns]",
    "last_available": "datetime64[ns]",
    "days_listed": "Int64",
    "windows": "int64",
    "predates_etfs": "bool",
    "resolvable": "bool",
    "ambiguity": "str",
}


def classify(directory: pd.DataFrame, *, asof: date | None = None) -> pd.DataFrame:
    """One row per shelf SYMBOL: alive, dead with its last date, or never traded.

    Per symbol rather than per directory row, because the thing a
    backtest holds is a symbol and the vendor's price endpoint answers
    for a symbol. Where the catalogue holds several rows for one they are
    merged if contiguous and the symbol is marked unresolvable if not —
    `resolvable` False is a refusal to guess which of two funds a string
    meant, and `unresolvable` lists them so the refusal is a number
    rather than a silence.

    `days_listed` is the span of the FINAL window, which is the only one
    a resolvable symbol has. It is calendar days and not sessions: the
    directory publishes dates, and inventing a session count from them
    would be arithmetic dressed as a measurement.
    """
    shelf = etf_shelf(directory)
    day = asof or date.today()
    cutoff = pd.Timestamp(day) - pd.Timedelta(days=STALE_AFTER_DAYS)

    rows: list[dict[str, Any]] = []
    for ticker, group in shelf.groupby("ticker", sort=True):
        windows = _windows(group["start_date"], group["end_date"])
        # The venue of the most recent row, so a fund that migrated is
        # filed where it ended up rather than where it began.
        latest = group.sort_values("start_date").iloc[-1]

        if not windows:
            rows.append(
                {
                    "ticker": str(ticker),
                    "exchange": str(latest["exchange"]),
                    "status": STATUS_NEVER_TRADED,
                    "first_available": pd.NaT,
                    "last_available": pd.NaT,
                    "days_listed": pd.NA,
                    "windows": 0,
                    "predates_etfs": False,
                    "resolvable": False,
                    "ambiguity": "no coverage window",
                }
            )
            continue

        start, end = windows[-1]
        span = int((end - start).days)
        if span < 1:
            status = STATUS_NEVER_TRADED
        elif end >= cutoff:
            status = STATUS_ALIVE
        else:
            status = STATUS_DEAD

        recycled = len(windows) > 1
        opened = windows[0][0]
        ancient = opened < pd.Timestamp(FIRST_US_ETF)
        if ancient:
            why = (
                f"coverage opens {opened.date()}, before the first US ETF "
                f"listed on {FIRST_US_ETF.isoformat()}; whatever the vendor "
                f"types this, it is not one"
            )
        elif recycled:
            why = (
                f"{len(windows)} separate listing windows; the symbol was "
                f"reissued and the vendor serves one series for it"
            )
        else:
            why = ""
        rows.append(
            {
                "ticker": str(ticker),
                "exchange": str(latest["exchange"]),
                "status": status,
                # The hull for a recycled symbol, so the row still says
                # what the catalogue holds — but `resolvable` False keeps
                # it out of every universe, because that hull spans two
                # funds and belongs to neither.
                "first_available": opened if recycled else start,
                "last_available": end,
                "days_listed": span,
                "windows": len(windows),
                "predates_etfs": bool(ancient),
                "resolvable": (
                    not recycled
                    and not ancient
                    and status != STATUS_NEVER_TRADED
                ),
                "ambiguity": why,
            }
        )

    out = _typed(pd.DataFrame(rows), _CLASSIFIED_DTYPES)
    return out.sort_values("ticker").reset_index(drop=True)


def unresolvable(classified: pd.DataFrame) -> pd.DataFrame:
    """The symbols this module refuses to resolve, and why.

    Written to be printed beside any universe built here. Seventy-one
    recycled tickers is a small number against 7,586 and a large one
    against the twelve dead funds the hand-written list carries, and a
    reader deciding whether to trust the panel needs the second
    comparison rather than the first.
    """
    return classified.loc[~classified["resolvable"]].reset_index(drop=True)


def composition(classified: pd.DataFrame) -> dict[str, Any]:
    """Headline counts for the shelf, in the shape a report footer wants.

    Two of these counts are residuals rather than curiosities.

    `dead_behind_live_symbols`: a symbol released by one fund and
    reissued to another is filed under its CURRENT occupant, so a ticker
    trading happily today can be standing on a dead fund's grave.
    Fifty-nine are, and none is reachable — asking the vendor for the
    string returns the live series.

    `predate_etfs`: 136 shelf symbols open before SPY did, which makes
    them closed-end funds the vendor types ETF. They are excluded, and
    the number is worth printing because it is a LOWER BOUND on the
    contamination — the rule catches every CEF older than the ETF itself
    and no younger one, and the younger ones are in there.
    """
    status = classified["status"]
    dead = int((status == STATUS_DEAD).sum())
    total = int(len(classified))
    recycled = classified.loc[classified["windows"] > 1]
    return {
        "symbols": total,
        "alive": int((status == STATUS_ALIVE).sum()),
        "dead": dead,
        "never_traded": int((status == STATUS_NEVER_TRADED).sum()),
        "unresolvable": int((~classified["resolvable"]).sum()),
        "dead_behind_live_symbols": int((recycled["windows"] - 1).sum()),
        "predate_etfs": int(classified["predates_etfs"].sum()),
        "share_dead": (dead / total) if total else float("nan"),
    }


# -- the table that answers the question ----------------------------------


_ATTRITION_DTYPES: dict[str, str] = {
    "year": "int64",
    "listed": "int64",
    "dead_now": "int64",
    "share_dead": "float64",
    "born": "int64",
    "died": "int64",
}


def attrition(
    classified: pd.DataFrame,
    *,
    first_year: int = 2005,
    last_year: int | None = None,
    asof: date | None = None,
) -> pd.DataFrame:
    """How many ETFs stood on the shelf each January, and how many are gone.

    `listed` is the cohort alive on 1 January of that year; `dead_now` is
    how many of THAT cohort have since stopped. The two columns beside
    them are flow rather than stock — funds born and funds killed during
    the year — and they are here because the stock columns alone let a
    reader mistake a falling death rate for an improving industry when it
    is mostly a cohort too young to have died yet.

    Read the last few rows as unfinished rather than as good news. A fund
    listed in January 2025 has had eighteen months to close and the ones
    from 2005 have had twenty-one years, so the share falls at the bottom
    of this table for a reason that has nothing to do with survival.
    """
    day = asof or date.today()
    end_year = last_year or day.year
    dead = classified["status"] == STATUS_DEAD
    first = classified["first_available"]
    last = classified["last_available"]

    rows: list[dict[str, Any]] = []
    for year in range(int(first_year), int(end_year) + 1):
        opening = pd.Timestamp(year=year, month=1, day=1)
        live = first.notna() & (first <= opening) & last.notna() & (last >= opening)
        rows.append(
            {
                "year": year,
                "listed": int(live.sum()),
                "dead_now": int((live & dead).sum()),
                "share_dead": (
                    float((live & dead).sum() / live.sum()) if live.sum() else 0.0
                ),
                "born": int((first.dt.year == year).sum()),
                "died": int((dead & (last.dt.year == year)).sum()),
            }
        )
    return _typed(pd.DataFrame(rows), _ATTRITION_DTYPES)


#: A record that carries under one per cent of its own deaths in the
#: years before a date is not a thin record of those years — it is a
#: record that starts at the date. Expressed as a share of the window's
#: OWN closures rather than as a rate per fund, because a rate needs a
#: threshold somebody picked and a share only needs the observation that
#: 6 closures before 2014 against 2,700 after is not a market history.
CLIFF_TAIL_SHARE = 0.01


def retention_cliff(
    classified: pd.DataFrame,
    *,
    first_year: int = 2005,
    last_year: int | None = None,
    asof: date | None = None,
) -> dict[str, Any]:
    """When the vendor's record of the dead actually begins.

    The finding that decides how far back any of this reaches, and it
    falls straight out of the attrition table's `died` column: Tiingo's
    catalogue records ONE ETF closure in 2010, three in 2011, two in
    2013 — and then forty-four in 2014, a hundred in 2015 and between a
    hundred and two hundred and fifty every year since. No market has
    that shape. Two hundred and thirty-nine funds closing in 2020 against
    one in 2010 is not an industry that suddenly began failing; it is a
    catalogue whose retention starts somewhere around 2014.

    So the panel this module builds is survivorship-free from the cliff
    forward and is NOT survivorship-free before it, and the second half
    of that sentence is the one to carry. The 2005 cohort is 557 funds
    of which 197 are recorded dead — but every one of those deaths is
    dated 2014 or later, which means the funds that were listed in 2005
    and closed in 2009 are absent from the catalogue altogether. They
    cannot be counted, cannot be pulled, and cannot be bought back at
    any price from this vendor.

    The estimate of how many is deliberately internal. Rather than reach
    for an outside figure for industry closures, it applies the vendor's
    OWN post-cliff closure rates to its own pre-cliff cohorts: at the
    lowest annual rate the catalogue records after the cliff, the
    pre-cliff years should have produced `missing_low` closures; at the
    median, `missing_mid`. Both are extrapolations and are named as
    such. The point is not the exact number — it is that the number is
    in the hundreds rather than in the handful the catalogue shows.

    The as-of year is excluded throughout. It is a partial year, its
    closure count is low by construction, and counting it would drag a
    median down and could announce that the vendor stopped retaining its
    dead this morning.

    The boundary is found as the LAST year before which under
    `CLIFF_TAIL_SHARE` of the window's own recorded closures fall. A
    healthy record crosses that share almost immediately and the
    function then answers with the first year of the window and a
    missing estimate of nought — which is the right answer and the
    reason this is not written as a run-length scan. A scan backwards
    from the most recent year needs an unbroken run to survive and
    reports no cliff at all on any window whose final years happen to be
    quiet.
    """
    day = asof or date.today()
    table = attrition(
        classified, first_year=first_year, last_year=last_year, asof=day
    )
    listed = table["listed"].to_numpy(dtype="float64")
    died = table["died"].to_numpy(dtype="float64")
    years = table["year"].to_numpy(dtype="int64")
    complete = years < day.year
    with np.errstate(divide="ignore", invalid="ignore"):
        rates = np.where(listed > 0, died / listed, np.nan)

    counted = died * complete
    total = float(counted.sum())
    if total <= 0.0:
        return {
            "cliff_year": None,
            "note": (
                "the window records no closure at all, so the catalogue "
                "carries no death record here to find the beginning of"
            ),
        }

    before = np.concatenate(([0.0], np.cumsum(counted)[:-1]))
    early = before / total < CLIFF_TAIL_SHARE
    cliff = int(years[np.flatnonzero(early)[-1]])

    post = complete & (years >= cliff)
    pre = complete & (years < cliff)
    post_rates = rates[post]
    post_rates = post_rates[np.isfinite(post_rates)]

    observed_pre = float(died[pre].sum())
    low_rate = float(post_rates.min()) if post_rates.size else float("nan")
    mid_rate = float(np.median(post_rates)) if post_rates.size else float("nan")
    expected_low = float((listed[pre] * low_rate).sum())
    expected_mid = float((listed[pre] * mid_rate).sum())
    return {
        "cliff_year": cliff,
        "years_before_cliff": int(pre.sum()),
        "recorded_closures_before_cliff": int(observed_pre),
        "post_cliff_rate_min": low_rate,
        "post_cliff_rate_median": mid_rate,
        "post_cliff_rate_max": (
            float(post_rates.max()) if post_rates.size else float("nan")
        ),
        # Extrapolations, and labelled so in the key. The catalogue's own
        # rates applied to the catalogue's own cohorts — no outside
        # figure for industry closures is used, because the argument has
        # to survive somebody who does not trust one.
        "missing_low_estimate": max(0, int(round(expected_low - observed_pre))),
        "missing_mid_estimate": max(0, int(round(expected_mid - observed_pre))),
    }


def render_attrition(table_frame: pd.DataFrame) -> str:
    """The attrition table as a padded pipe table.

    `util.runs` is imported late for the reason `catalogue.py` gives: it
    reaches back into `data` for the source contract, and a data module
    importing the reporting layer at module scope is a cycle waiting for
    the next person to trip over.
    """
    from ..util.runs import table

    # "New" and "Closed" are flow and "On shelf" is stock; the header
    # has to keep them apart or a reader adds a column to a column.
    headers = ["Year", "On shelf 1 Jan", "Dead now", "Share", "New", "Closed"]
    rows = [
        [
            str(int(r.year)),
            f"{int(r.listed):,}",
            f"{int(r.dead_now):,}",
            f"{float(r.share_dead) * 100:.1f}%",
            f"{int(r.born):,}",
            f"{int(r.died):,}",
        ]
        for r in table_frame.itertuples()
    ]
    return table(headers, rows, ["r", "r", "r", "r", "r", "r"])


# -- the universe, evaluated on a day -------------------------------------


def universe_on(
    classified: pd.DataFrame,
    day: date | datetime | str,
    *,
    deployable: dict[str, pd.Timestamp] | None = None,
) -> tuple[str, ...]:
    """Which funds existed and were tradable on `day`, in ticker order.

    The whole point of the module in one function. A list of what exists
    now, sliced by a date column, still answers with the survivors; this
    asks the catalogue what stood on the shelf that morning, and a fund
    that closed in 2012 is in the answer for every date before it closed.

    `deployable` is the optional second gate and takes the shape
    `run_ledger.deployability` already produces — ticker to the first
    session the fund's own tape could carry this account. Passing it
    turns "existed" into "could have been bought", which are different
    questions and get confused precisely because the first is so much
    easier to answer.

    Unresolvable symbols are never returned. A recycled ticker on a given
    date belongs to one of two funds and the vendor will serve whichever
    it decided the string means, so including it would put a fund's bars
    under another fund's dates — the recycled-symbol graft, arriving
    through the very function written to remove survivorship bias.
    """
    when = pd.Timestamp(_as_date(day))
    live = classified.loc[
        classified["resolvable"]
        & classified["first_available"].notna()
        & (classified["first_available"] <= when)
        & classified["last_available"].notna()
        & (classified["last_available"] >= when)
    ]
    tickers = (str(t) for t in live["ticker"])
    if deployable is None:
        return tuple(sorted(tickers))
    return tuple(
        sorted(
            t
            for t in tickers
            if t in deployable and pd.Timestamp(deployable[t]) <= when
        )
    )


def deployable_floor(config: Any = None) -> float:
    """The daily tape a fund needs before this account can deploy into it.

    Three engine constants and one division, restated from
    `run_ledger.adv_floor` rather than imported because `run_ledger` is a
    script at the repository root and a data module importing it would
    make the package depend on the runner. The arithmetic is the thing
    being reused, not the function: the turnover budget wants
    `starting_cash * max_daily_turnover` of fills a day and the
    participation cap allows `max_participation` of the name's own median
    dollar volume, so a fund below the quotient cannot absorb the
    account's budget even once.

    Measured today it is $655,000 a day. That figure is not written down
    anywhere in this file, because a constant somebody typed is a
    constant that stops moving when the account does.

    The import is late for the ordinary reason: `engine.backtest` reaches
    for the portfolio layer, and a data module that pulled the engine in
    at import time would put half the package behind `import
    griffinquant.data`.
    """
    if config is None:
        from ..engine.backtest import BacktestConfig

        config = BacktestConfig()
    if config.max_participation is None or config.max_participation <= 0.0:
        return 0.0
    return float(
        config.starting_cash * config.max_daily_turnover / config.max_participation
    )


# -- planning the acquisition ---------------------------------------------


def acquisition_plan(
    classified: pd.DataFrame,
    *,
    sample_start: date | datetime | str = SAMPLE_START,
    asof: date | None = None,
    min_days: int = MIN_PLAN_DAYS,
    seed: int = PLAN_SEED,
    limit: int | None = None,
) -> tuple[str, ...]:
    """Which dead funds to pull, and in what order.

    Three filters, each of which removes funds that could not have
    changed a result rather than funds that are inconvenient. A symbol
    the module refuses to resolve cannot be pulled at all. A window that
    never overlaps the study period describes a fund that was already
    gone before the first session. And a fund that never accumulated
    `UNIVERSE.min_history_days` sessions has no volatility estimate and
    no momentum history, so every rule in the library would decline to
    hold it on every day it existed.

    **The order is a seeded shuffle and that is the load-bearing
    decision.** At fifty symbols an hour a full pull is a day and a half,
    so a run inside one sitting gets a subset, and the subset's
    composition is the whole result. Longest-lived first would
    over-sample the funds that survived long enough to be bought by
    somebody and under-sample the ones that failed in three years — it
    would answer the survivorship question with a survivorship-biased
    sample. Shuffled, a partial pull is a random sample of the dead
    population, the share of it that was ever deployable estimates the
    share of the whole, and `deployable_estimate` puts an interval on it.

    `limit` truncates the plan and does NOT re-shuffle. Two runs with
    limits of 200 and 400 therefore share their first 200 names, so the
    second pays nothing for the first's work — which is the only reason
    a resumable pull against a metered free tier is a reasonable thing to
    write.
    """
    day = asof or date.today()
    start = pd.Timestamp(_as_date(sample_start))
    end = pd.Timestamp(day)

    eligible = classified.loc[
        (classified["status"] == STATUS_DEAD)
        & classified["resolvable"]
        & (classified["first_available"] <= end)
        & (classified["last_available"] >= start)
        & (classified["days_listed"] >= int(min_days))
    ]
    names = sorted(str(t) for t in eligible["ticker"])
    if not names:
        return ()

    order = np.random.default_rng(int(seed)).permutation(len(names))
    plan = tuple(names[i] for i in order)
    return plan if limit is None else plan[: int(limit)]


def plan_reach(classified: pd.DataFrame, plan: Sequence[str]) -> dict[str, Any]:
    """What the plan covers of the dead population, and what it drops.

    Every exclusion counted separately, because they are not equally
    forgivable. A fund that predates the ETF was never in scope and a
    short-lived one no rule could hold is a defensible omission; a
    reissued symbol is an admission that a real fund's history exists
    and cannot be addressed. Collapsing them into "excluded" would let
    the last hide inside the first two.

    The categories are made mutually exclusive in a fixed order so the
    columns add up to the population. A total that does not reconcile is
    how a residual goes missing.
    """
    dead = classified.loc[classified["status"] == STATUS_DEAD]
    total = int(len(dead))
    ancient = dead["predates_etfs"]
    reissued = ~ancient & (dead["windows"] > 1)
    short = (
        ~ancient & ~reissued & dead["resolvable"]
        & (dead["days_listed"] < MIN_PLAN_DAYS)
    )
    planned = len(set(plan))
    counted = int(ancient.sum()) + int(reissued.sum()) + int(short.sum())
    return {
        "dead_symbols": total,
        "predate_etfs": int(ancient.sum()),
        "reissued_symbol": int(reissued.sum()),
        "too_short_to_hold": int(short.sum()),
        "planned": planned,
        "outside_sample_or_capped": total - counted - planned,
        "share_planned": (planned / total) if total else float("nan"),
    }


# -- pulling --------------------------------------------------------------


#: How many symbols one source may hold, and the reason is not
#: politeness. `sleevedata.synthetic_permaticker` truncates sha256 into a
#: ten-million-wide space, so by the birthday problem an allowlist of n
#: names collides with probability about n^2 / 2e7 — which at the 1,677
#: names this plan actually contains is one run in seven, and it fired on
#: the first attempt: DEWJ and EMLB hash to 901368786 and the constructor
#: refused, correctly, rather than merging two funds' price histories.
#: The proper fix is to widen `PERMATICKER_SPAN`, which is somebody
#: else's file and a change every cached id would have to survive. Two
#: hundred names puts the odds at one in five hundred, `acquire` splits a
#: batch that collides anyway, and a metered pull wanted batches for its
#: own reasons.
#:
#: Worth recording as a finding rather than a workaround: the id space
#: was sized for nine sleeve vehicles and quietly bounds any universe
#: built on this source at a few hundred names per process.
BATCH_SYMBOLS = 200


def open_pull_source(
    plan: Iterable[str],
    *,
    cache: "ParquetCache | None" = None,
    horizon: date | None = None,
    **kwargs: Any,
) -> ETFUniverseSource:
    """An `ETFUniverseSource` whose allowlist is exactly the plan.

    The wall is extended, never defeated — same as `ETFUniverseSource`
    itself, which is the point of building on it rather than beside it.
    Everything about what a price IS comes down unchanged, so a bar
    pulled for a dead fund and a bar pulled for SPY are the same kind of
    object and can sit in one panel.

    `horizon` pins the cache key. The parent keys a ticker's entry on the
    day the pull ran through, which is correct for a fund that will print
    another bar tomorrow and wasteful for one whose tape stopped in 2013:
    left alone, a day of careful, metered, polite fetching expires at
    midnight and has to be repeated. Pinning it to the as-of date makes
    the entry say what it is — this fund's whole history — and makes a
    resumed pull free rather than merely cheap.
    """
    names = tuple(dict.fromkeys(str(t).strip().upper() for t in plan))
    if not names:
        raise ValueError(
            "an empty plan is not a small pull, it is a pull that can "
            "recover nothing; an empty coverage table would then report "
            "that no dead fund has any history"
        )
    if horizon is not None:
        pinned = _as_date(horizon)
        kwargs.setdefault(
            "clock", lambda: datetime.combine(pinned, datetime.min.time(),
                                              tzinfo=timezone.utc)
        )
    return ETFUniverseSource(
        allowed=names, cache=cache, fetch_names=False, **kwargs
    )


_COVERAGE_DTYPES: dict[str, str] = {
    "ticker": "str",
    "served": "bool",
    "rows": "int64",
    "first_bar": "datetime64[ns]",
    "last_bar": "datetime64[ns]",
    "final_close": "float64",
    "final_volume": "float64",
    "median_dollar_volume": "float64",
    "peak_dollar_volume": "float64",
    "deployable_sessions": "int64",
    "ever_deployable": "bool",
    "first_deployable": "datetime64[ns]",
}


@dataclass(frozen=True)
class Pull:
    """What one acquisition run recovered, and where it stopped.

    `stopped` is not a footnote. A coverage table of 180 rows out of a
    900-name plan means one thing if the other 720 were never attempted
    and something else entirely if they were attempted and came back
    empty, and both of those look like a short table. So the run reports
    the boundary explicitly and `recovery_report` refuses to compute a
    share without it.
    """

    coverage: pd.DataFrame
    plan: tuple[str, ...] = ()
    attempted: int = 0
    stopped: bool = False
    stop_reason: str = ""
    seconds: float = 0.0

    @property
    def served(self) -> int:
        if self.coverage.empty:
            return 0
        return int(self.coverage["served"].sum())


def _fund_stats(bars: pd.DataFrame, floor: float) -> dict[str, Any]:
    """Everything about one fund that decides whether it mattered.

    The liquidity series is the engine's own — same window, same median,
    same expanding warm start — because the number being tested is the
    one the participation cap will read inside the loop. A tidier ADV
    computed here would let a fund pass this gate and be refused by the
    cap, which is exactly the failure the gate exists to see coming.
    """
    if bars.empty:
        return {
            "served": False,
            "rows": 0,
            "first_bar": pd.NaT,
            "last_bar": pd.NaT,
            "final_close": float("nan"),
            "final_volume": float("nan"),
            "median_dollar_volume": float("nan"),
            "peak_dollar_volume": float("nan"),
            "deployable_sessions": 0,
            "ever_deployable": False,
            "first_deployable": pd.NaT,
        }

    frame = bars.sort_values("date")
    close = frame["close_unadj"].astype("float64")
    volume = frame["volume_unadj"].astype("float64")
    dollars = close * volume

    window = UNIVERSE.dollar_volume_window
    adv = dollars.rolling(window, min_periods=max(5, window // 2)).median()
    head = max(window - 1, 0)
    if head:
        warm = dollars.iloc[:head].expanding(min_periods=3).median()
        adv.iloc[:head] = adv.iloc[:head].fillna(warm)

    liquid = (adv >= floor) & (close >= UNIVERSE.min_price)
    first = frame.loc[liquid.to_numpy(), "date"]
    return {
        "served": True,
        "rows": int(len(frame)),
        "first_bar": frame["date"].min(),
        "last_bar": frame["date"].max(),
        "final_close": float(close.iloc[-1]),
        "final_volume": float(volume.iloc[-1]),
        "median_dollar_volume": float(dollars.median()),
        "peak_dollar_volume": float(adv.max()) if adv.notna().any() else float("nan"),
        "deployable_sessions": int(liquid.sum()),
        "ever_deployable": bool(liquid.any()),
        "first_deployable": first.iloc[0] if len(first) else pd.NaT,
    }


def pull_dead(
    source: ETFUniverseSource,
    plan: Sequence[str],
    *,
    start: date = HISTORY_START,
    end: date | None = None,
    floor: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    pause: float = PULL_PAUSE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    budget_seconds: float | None = None,
    on_progress: Callable[[int, int, str, int], None] | None = None,
) -> Pull:
    """Fetch each dead fund's bars, one name at a time, and measure it.

    Returns a `Pull`: the coverage table, how many names were attempted,
    and whether the run stopped early. `served` False on an attempted
    name is a real finding and the reason the module exists in this shape
    — a directory row is the vendor's index and not its tape, so the gap
    between "the catalogue says this fund traded" and "the endpoint
    returns bars" is a measurement rather than an error.

    **This stops rather than raises, and that is a deliberate departure
    from `pull_universe` next door.** There, an outage mid-pull must
    raise: the coverage table is the whole universe, and eighty names
    with bars beside sixty with none reads exactly like a universe where
    sixty funds never traded. Here the plan is a random sample and
    partial completion is a defined state — the table carries `attempted`
    and the run carries `stopped`, so a short table cannot be mistaken
    for a complete one, and throwing away four hundred recovered
    histories because the four hundred and first hit a metered limit
    would be the more destructive of the two behaviours.

    `budget_seconds` stops the loop on the clock. A caller with two hours
    wants two hours of the plan and wants to know that is what it got,
    rather than an estimate of how many names fit.

    **The pause follows a request rather than a name.** A resumed run
    walks the whole plan again and most of it is already on disk;
    pausing a second before each of 1,600 cache reads would spend
    twenty-eight minutes being polite to nobody, and a caller who
    noticed would reach for `pause=0` and lose the pacing on the
    requests that do go out. So the sleep is skipped when the answer
    came back faster than any network could have produced it. The
    vendor's own spacing is unchanged — the parent paces every real
    request at half a second whatever this does.
    """
    names = tuple(dict.fromkeys(str(t).strip().upper() for t in plan))
    if not names:
        raise ValueError(
            "no tickers to pull. An empty coverage table is not a finding "
            "about dead funds; it is the shape of a request nobody made."
        )
    through = end or date.today()
    limit = deployable_floor() if floor is None else float(floor)

    began = clock()
    rows: list[dict[str, Any]] = []
    stopped = False
    reason = ""
    attempted = 0

    for i, symbol in enumerate(names, start=1):
        if budget_seconds is not None and clock() - began >= float(budget_seconds):
            stopped = True
            reason = (
                f"time budget of {float(budget_seconds):.0f}s reached after "
                f"{attempted} of {len(names)} names"
            )
            break
        started = clock()
        try:
            bars = source.prices(
                start, through, permatickers=[source.permaticker_for(symbol)]
            )
        except SourceUnavailable as exc:
            # The 429 this will actually hit. Recorded and not retried in
            # place: the meter counts symbols, so waiting is the caller's
            # decision and sleeping inside the loop would only make an
            # unattended job look like a hung one. The name does NOT
            # count as attempted — an attempt with no answer and an
            # attempt answered with nothing are opposite findings, and
            # `attempted - served` is how the second one is counted.
            stopped = True
            reason = (
                f"{type(exc).__name__} on {symbol} after {attempted} of "
                f"{len(names)} names: {exc}"
            )
            break

        attempted += 1
        rows.append({"ticker": symbol, **_fund_stats(bars, limit)})
        if on_progress is not None:
            on_progress(i, len(names), symbol, int(len(bars)))
        if pause > 0 and i < len(names) and clock() - started >= CACHE_HIT_SECONDS:
            sleep(pause)

    coverage = _typed(pd.DataFrame(rows), _COVERAGE_DTYPES)
    if not coverage.empty:
        coverage = coverage.sort_values("ticker").reset_index(drop=True)
    return Pull(
        coverage=coverage,
        plan=names,
        attempted=attempted,
        stopped=stopped,
        stop_reason=reason,
        seconds=float(clock() - began),
    )


def acquire(
    plan: Sequence[str],
    *,
    cache: "ParquetCache | None" = None,
    asof: date | None = None,
    start: date = HISTORY_START,
    floor: float | None = None,
    batch: int = BATCH_SYMBOLS,
    budget_seconds: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    pause: float = PULL_PAUSE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    on_batch: Callable[[int, int, "Pull"], None] | None = None,
) -> Pull:
    """The whole acquisition: batch, pull, and stop when told to.

    One source per batch, for the id-space reason `BATCH_SYMBOLS`
    records. A batch that collides anyway is split and retried rather
    than abandoned — the collision is between two names in one process
    and has nothing to do with either fund, so refusing the batch would
    lose 199 innocent histories to an accident of a hash.

    The stop conditions are the two a metered free tier produces: the
    vendor refuses, or the caller runs out of afternoon. Both leave a
    `Pull` that says so, and both leave every recovered bar on disk, so
    the next run pays only for what it has not already got.
    """
    names = tuple(dict.fromkeys(str(t).strip().upper() for t in plan))
    if not names:
        raise ValueError("an empty plan cannot be acquired")
    day = asof or date.today()
    limit = deployable_floor() if floor is None else float(floor)
    size = max(1, int(batch))

    began = clock()
    frames: list[pd.DataFrame] = []
    attempted = 0
    stopped = False
    reason = ""

    for offset in range(0, len(names), size):
        if budget_seconds is not None and clock() - began >= float(budget_seconds):
            stopped = True
            reason = (
                f"time budget of {float(budget_seconds):.0f}s reached after "
                f"{attempted} of {len(names)} names"
            )
            break
        chunk = names[offset : offset + size]
        remaining = (
            None
            if budget_seconds is None
            else max(0.0, float(budget_seconds) - (clock() - began))
        )
        pull = _pull_chunk(
            chunk,
            cache=cache,
            horizon=day,
            start=start,
            end=day,
            floor=limit,
            sleep=sleep,
            pause=pause,
            clock=clock,
            budget_seconds=remaining,
        )
        if not pull.coverage.empty:
            frames.append(pull.coverage)
        attempted += pull.attempted
        if on_batch is not None:
            on_batch(offset // size + 1, (len(names) + size - 1) // size, pull)
        if pull.stopped:
            stopped = True
            reason = pull.stop_reason
            break

    coverage = (
        pd.concat(frames, ignore_index=True)
        if frames
        else _typed(pd.DataFrame(), _COVERAGE_DTYPES)
    )
    if not coverage.empty:
        coverage = coverage.sort_values("ticker").reset_index(drop=True)
    return Pull(
        coverage=coverage,
        plan=names,
        attempted=attempted,
        stopped=stopped,
        stop_reason=reason,
        seconds=float(clock() - began),
    )


def _pull_chunk(chunk: Sequence[str], *, cache, horizon, **kwargs: Any) -> Pull:
    """One batch, split on an id collision rather than lost to one."""
    try:
        source = open_pull_source(chunk, cache=cache, horizon=horizon)
    except ValueError as exc:
        if "permaticker" not in str(exc) or len(chunk) < 2:
            raise
        half = len(chunk) // 2
        first = _pull_chunk(chunk[:half], cache=cache, horizon=horizon, **kwargs)
        if first.stopped:
            return first
        second = _pull_chunk(chunk[half:], cache=cache, horizon=horizon, **kwargs)
        frames = [f for f in (first.coverage, second.coverage) if not f.empty]
        return Pull(
            coverage=(
                pd.concat(frames, ignore_index=True)
                if frames
                else _typed(pd.DataFrame(), _COVERAGE_DTYPES)
            ),
            plan=tuple(chunk),
            attempted=first.attempted + second.attempted,
            stopped=second.stopped,
            stop_reason=second.stop_reason,
            seconds=first.seconds + second.seconds,
        )
    return pull_dead(source, chunk, **kwargs)


# -- the bias, stated against the list it replaces ------------------------


def hand_list_comparison(classified: pd.DataFrame) -> dict[str, Any]:
    """The 148-fund list beside the shelf it was drawn from.

    This is the measurement the whole module is arguing with, and it
    needs no pull to make: a list written by looking at what trades today
    contains no funds that stopped trading, while the shelf it was drawn
    from is a third dead. The two shares printed next to each other are
    the bias, in the only units anybody should accept for it.

    A hand-list name the directory does not carry counts as `unmatched`
    rather than as alive. Four real ETFs are missing from the catalogue
    outright — `etfuniverse.ABSENT` names them — and quietly filing an
    unmatched symbol under either state would move a number by hiding a
    hole.
    """
    known = classified.set_index("ticker")["status"]
    hand = sorted(UNIVERSE_TICKERS)
    matched = [t for t in hand if t in known.index]
    dead = sum(1 for t in matched if known[t] == STATUS_DEAD)
    shelf = composition(classified)
    return {
        "hand_list": len(hand),
        "matched_on_shelf": len(matched),
        "unmatched": len(hand) - len(matched),
        "hand_list_dead": dead,
        "hand_list_share_dead": (dead / len(matched)) if matched else float("nan"),
        "shelf_share_dead": shelf["share_dead"],
    }


# -- what we actually got -------------------------------------------------


def recovery_report(pull: Pull, reach: dict[str, Any] | None = None) -> dict[str, Any]:
    """Planned, attempted, served, empty, and the residual as a number.

    The residual is the point. A panel that recovered nine dead funds in
    ten is not survivorship-free — it is a panel with a tenth of the
    original hole in it — and the difference between saying that and
    saying "mostly complete" is the difference between a limitation a
    reader can price and one they have to take on trust.
    """
    served = pull.served
    empty = pull.attempted - served
    out: dict[str, Any] = {
        "planned": len(pull.plan),
        "attempted": pull.attempted,
        "served": served,
        "attempted_but_empty": empty,
        "never_attempted": len(pull.plan) - pull.attempted,
        "stopped": pull.stopped,
        "stop_reason": pull.stop_reason,
        "share_of_plan_served": (
            served / len(pull.plan) if pull.plan else float("nan")
        ),
        "seconds": round(pull.seconds, 1),
    }
    if reach is not None:
        dead = int(reach.get("dead_symbols", 0))
        out["dead_symbols"] = dead
        out["share_of_dead_served"] = (served / dead) if dead else float("nan")
        # The honest headline: every dead fund the panel still cannot
        # see, whether because the plan excluded it, the run never
        # reached it, or the vendor had nothing.
        out["residual_dead"] = dead - served
    return out


def deployable_estimate(pull: Pull, *, z: float = 1.96) -> dict[str, Any]:
    """Of the dead funds recovered, how many could this account have held.

    The number that decides how much of the attrition figure is a fact
    about a backtest rather than a fact about the ETF industry. A fund
    whose tape never carried `deployable_floor` could not have entered
    the book on any day it existed, so its absence from a panel biases
    nothing at all — and if that describes most dead funds, a 36%
    attrition rate is compatible with a small bias.

    A Wilson interval rather than the normal approximation, because the
    share may well sit near zero or one on a few hundred draws and the
    normal interval crosses the boundary there — a "-2% to 6%" share of
    deployable funds is an arithmetic artefact printed as a measurement.
    The interval is only meaningful because `acquisition_plan` shuffles:
    on a longest-lived-first order these draws would not be a sample of
    anything.
    """
    if pull.coverage.empty:
        served = pull.coverage
    else:
        served = pull.coverage.loc[pull.coverage["served"]]
    n = int(len(served))
    if n == 0:
        return {
            "recovered": 0,
            "ever_deployable": 0,
            "share": float("nan"),
            "low": float("nan"),
            "high": float("nan"),
            "random_sample": True,
        }
    k = int(served["ever_deployable"].sum())
    p = k / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)) / denom
    return {
        "recovered": n,
        "ever_deployable": k,
        "share": p,
        "low": max(0.0, centre - half),
        "high": min(1.0, centre + half),
        "median_deployable_sessions": float(
            served.loc[served["ever_deployable"], "deployable_sessions"].median()
        )
        if k
        else float("nan"),
        "random_sample": True,
    }


def survivorship_verdict(
    classified: pd.DataFrame,
    pull: Pull,
    plan: Sequence[str],
    *,
    asof: date | None = None,
) -> dict[str, Any]:
    """One dict a report can print without deciding anything itself.

    Deliberately not a boolean. "Survivorship-free" is not a state this
    panel can reach — four real ETFs are absent from the catalogue
    outright, seventy-one symbols cannot be resolved, and any run short
    of the full plan leaves names unfetched — so the honest output is the
    size of what remains missing, expressed the same way each time so two
    runs can be compared.
    """
    reach = plan_reach(classified, plan)
    recovery = recovery_report(pull, reach)
    parts = composition(classified)
    cliff = retention_cliff(classified, asof=asof)
    return {
        **parts,
        "plan": reach,
        "recovery": recovery,
        "deployable": deployable_estimate(pull),
        "hand_list": hand_list_comparison(classified),
        "cliff": cliff,
        "verdict": (
            f"{recovery['served']} of {parts['dead']} dead shelf symbols "
            f"recovered; {recovery['residual_dead']} still invisible in the "
            f"catalogue, and the catalogue itself records almost no closure "
            f"before {cliff['cliff_year']}"
            if "residual_dead" in recovery
            else "no recovery attempted"
        ),
    }


def render_recovery(verdict: dict[str, Any]) -> str:
    """The residual, as a table, with the excluded funds named separately."""
    from ..util.runs import table

    reach = verdict["plan"]
    rec = verdict["recovery"]
    dep = verdict["deployable"]
    rows = [
        ["Shelf symbols (ETF, USD, major venue)", f"{verdict['symbols']:,}"],
        ["  still listed", f"{verdict['alive']:,}"],
        ["  dead", f"{verdict['dead']:,}"],
        ["  never traded (one print or none)", f"{verdict['never_traded']:,}"],
        ["Dead and older than the ETF (a CEF)", f"{reach['predate_etfs']:,}"],
        ["Dead behind a reissued symbol", f"{reach['reissued_symbol']:,}"],
        ["Dead and too short to hold", f"{reach['too_short_to_hold']:,}"],
        ["Planned for acquisition", f"{reach['planned']:,}"],
        ["  attempted", f"{rec['attempted']:,}"],
        ["  bars returned", f"{rec['served']:,}"],
        ["  attempted, vendor served nothing", f"{rec['attempted_but_empty']:,}"],
        ["  never attempted", f"{rec['never_attempted']:,}"],
        [
            "RESIDUAL: dead funds still unseen",
            f"{rec.get('residual_dead', 0):,}",
        ],
        [
            "Of recovered dead, ever deployable",
            "n/a"
            if dep["recovered"] == 0
            else f"{dep['ever_deployable']:,} of {dep['recovered']:,} "
            f"({dep['share'] * 100:.1f}%, {dep['low'] * 100:.1f}-"
            f"{dep['high'] * 100:.1f}%)",
        ],
    ]
    hand = verdict.get("hand_list")
    if hand:
        rows.append(
            [
                "Hand-written list, share dead",
                f"{hand['hand_list_dead']} of {hand['matched_on_shelf']} "
                f"({hand['hand_list_share_dead'] * 100:.1f}% against the "
                f"shelf's {hand['shelf_share_dead'] * 100:.1f}%)",
            ]
        )
    cliff = verdict.get("cliff") or {}
    if cliff.get("cliff_year"):
        rows.append(
            ["Vendor's death record begins", str(cliff["cliff_year"])]
        )
        rows.append(
            [
                "Closures before it the catalogue never recorded",
                f"~{cliff['missing_low_estimate']:,}-"
                f"{cliff['missing_mid_estimate']:,} (extrapolated)",
            ]
        )
    rows.append(
        [
            "Dead funds behind live symbols (reissued ticker)",
            f"{verdict['dead_behind_live_symbols']:,}",
        ]
    )
    rows.append(
        [
            "Not ETFs at all (open before SPY did) — a LOWER bound",
            f"{verdict['predate_etfs']:,}",
        ]
    )
    return table(["Measure", "Count"], rows, ["l", "r"])


# -- module helpers -------------------------------------------------------


def _as_date(value: date | datetime | str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise TypeError(f"expected a date, datetime or ISO string, got {type(value)!r}")


def _typed(df: pd.DataFrame, dtypes: dict[str, str]) -> pd.DataFrame:
    """Coerce to a declared dtype map, dropping anything unnamed.

    The third copy of this in the data package, and written out again
    rather than imported for the reason `keyedsleeves` and `etfuniverse`
    both give about their own: the shared authority is the dtype map
    beside each frame, not a private helper, and reaching across a module
    boundary for an underscore name is a coupling neither editor can see
    from where they are standing.
    """
    built: dict[str, pd.Series] = {}
    for column, dtype in dtypes.items():
        if column not in df.columns:
            continue
        series = df[column]
        if dtype.startswith("datetime64"):
            built[column] = pd.to_datetime(series, errors="coerce").astype(
                "datetime64[ns]"
            )
        elif dtype == "float64":
            built[column] = pd.to_numeric(series, errors="coerce").astype("float64")
        elif dtype == "Int64":
            built[column] = pd.to_numeric(series, errors="coerce").astype("Int64")
        elif dtype == "int64":
            built[column] = pd.to_numeric(series, errors="coerce").astype("int64")
        elif dtype == "bool":
            built[column] = series.astype("bool")
        else:
            built[column] = series.astype("str")
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out
