"""FRED's macro series, each one carrying the date it could first be known.

The St. Louis Fed publishes a hundred thousand series to anyone who
asks, with no key, no quota and no account. That makes it the most
generous free source this project has, and also the most dangerous,
because of one property the CSV does not mention anywhere: **the file
you download is the LATEST vintage, not the one that existed on the day
you are simulating.**

CPI for March is not knowable in March. Non-farm payrolls for March is
first published in early April and then revised in May and again in
June, and revised once more at the annual benchmark. The Chicago Fed's
NFCI is re-estimated from a dynamic factor model every single week, so
its value for March 2009 today is a number nobody has ever traded on.
None of this shows up as a gap, a NaN, or a warning. It shows up as a
perfectly well-behaved daily series that quietly contains the future,
and as a backtest whose macro overlay works beautifully.

So this module does three things and refuses to do a fourth.

It **curates**. Twenty-seven series, each with a one-line note saying
what question it helps answer, rather than an inventory of a thousand
ids nobody can reason about. A short list somebody has actually read
beats a catalogue that is really a search box.

It **states the lag**. Every entry records how long after the end of its
reference period the number is first published, how it is revised
afterwards, when the series truly starts, and under what licence FRED
serves it. `as_of` applies that lag, and takes it as a REQUIRED
argument — there is no default, because a publication lag that can be
forgotten is a publication lag that will be.

Those lags are measured, not remembered. The monthly ones were set by
running `lag_audit` against archived vintages on 2026-08-02 and taking
the smallest lag that never claimed a figure the archive did not yet
carry, plus one day of margin. That found real errors in the numbers
this file was first written with: a 9-day rule for payrolls leaks,
because the December 2013 report came out on 10 January, and 14 days
for CPI leaks too. The rule is asymmetric on purpose. A lag that is too
short puts tomorrow's number in today's backtest; a lag that is too
long merely discards information you did have, and shows up as a
slightly weaker result rather than a fictional one.

It **points at the real fix**. ALFRED, the archive next door, serves the
actual vintage — the file as it stood on a chosen morning — and it is
reachable through the same keyless CSV endpoint. `vintage()` reads it
and `lag_audit()` uses it to measure how wrong the lag rule is for a
given series, which is the only honest way to defend a lag rule.

What it will not do is guess. There is no default lag, no "close
enough" fill, and no empty frame standing in for an outage.

**Survivorship.** These are aggregate time series, not a cross-section
of securities, so survivorship bias in its usual form cannot arise:
there is no set of names from which the failures could have been
dropped. Two related things do apply and are worth saying plainly.
First, the CATALOGUE itself is survivorship-selected — it lists series
that FRED still publishes today. TEDRATE is in here precisely because
it died (LIBOR ended, the series stopped on 2022-01-21) and a list that
quietly omitted it would teach the reader that the ids they know are the
ids that have always existed. DTWEXB was frozen and replaced by
DTWEXBGS; STLFSI, STLFSI2 and STLFSI3 were retired and rebuilt as
STLFSI4. And an id can survive while its HISTORY is withdrawn: both ICE
BofA spread series were pulled on 2026-08-02 and returned 787
observations starting in August 2023, for indices documented back to
1996. Nothing about that pull looks wrong — the column is clean, the
dates are real, the code path is the same — and a credit study written
against it would silently be a study of the last three years. A macro
feature keyed on an id is keyed on something that can be withdrawn
underneath it. Second, the vintage problem above is the point-in-time
failure this repository's audit exists to catch, and it is invisible.

**What this data cannot do.** Nothing here identifies a security. These
are national aggregates and market-wide rates, so no signal built from
this file can select a name — it can only tilt, time or hedge an
allocation that was chosen somewhere else. Anyone reaching for FRED to
rank single stocks is holding the wrong file.

**Licence.** FRED tags every series with one of three terms, and this
module records which: `public_domain` (US government work — BLS, BEA,
the Board of Governors), `citation_required` (free to use, attribution
demanded — Cboe's VIX, Michigan's sentiment index, the Chicago and St.
Louis Fed indices), and `pre_approval_required` (ICE Data Indices'
credit spreads, which FRED serves but which may not be redistributed
without ICE's written approval). Academic and internal use is fine
throughout; republishing the ICE series is not, and the tag is on the
row so nobody has to remember which. Tags were read from FRED's own
JSON-LD on 2026-08-02 and should be re-read before anything is
published.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, TYPE_CHECKING

import numpy as np
import pandas as pd

from .base import SourceUnavailable
from .tbill import (
    ALFRED_CSV,
    FRED_CSV,
    FredNotPublished,
    TbillUnavailable,
    fetch_observations,
)

if TYPE_CHECKING:
    from .cache import ParquetCache


# -- constants ------------------------------------------------------------


#: Its own slug under the shared cache root. Not `tbill`'s and not
#: `sleevedata`'s: an entry written by one source and served to another
#: is how two independent readings of the world turn out to be one.
SOURCE_SLUG = "fred"

#: A live series grows; a vintage never changes again, by definition.
#: `ParquetCache` reads an unregistered frame name as daily-expiring, so
#: the vintage half needs this map passed in to get the immortality it
#: has actually earned — see `default_cache`.
FRAME_OBSERVATIONS = "fred_observations"
FRAME_VINTAGE = "fred_vintage"
CACHE_TTL_DAYS: Mapping[str, float | None] = {
    FRAME_OBSERVATIONS: 1.0,
    FRAME_VINTAGE: None,
}

#: Earlier than anything FRED publishes here (INDPRO opens in 1919).
#: Every pull asks for the whole history and slices locally, so one
#: entry per series per day serves every window — the same argument
#: `keyedsleeves._horizon` makes, for the same reason.
HISTORY_START = date(1900, 1, 1)

#: FRED publishes no rate limit. That is not permission to hammer it:
#: twenty-seven small CSVs a second apart is half a minute once, and the
#: cache means it happens once. We were IP-throttled by another vendor
#: for three hours on the day this was written, by a retry loop that was
#: technically within its rights.
MIN_REQUEST_INTERVAL_SECONDS = 1.0

DEFAULT_TIMEOUT = 30

LICENCE_URLS: Mapping[str, str] = {
    "public_domain": "https://fred.stlouisfed.org/legal/#copyright-public-domain",
    "citation_required": (
        "https://fred.stlouisfed.org/legal/#copyright-citation-required"
    ),
    "pre_approval_required": (
        "https://fred.stlouisfed.org/legal/#copyright-pre-approval"
    ),
}

#: Printed by anything that reports on this source, so the claim travels
#: with the numbers instead of living only in a docstring nobody opens.
SURVIVORSHIP_NOTE = (
    "Survivorship-free in the only sense available to it: a macro series "
    "is one aggregate through time, not a cross-section, so there is no "
    "set of names from which losers could have been dropped. The bias "
    "that does apply is the CATALOGUE's — these are ids FRED still "
    "publishes, and ids get withdrawn (TEDRATE died with LIBOR in 2022, "
    "DTWEXB was replaced by DTWEXBGS, STLFSI was rebuilt three times). "
    "The failure that matters here is not survivorship, it is vintage: "
    "the file served today is the revised history, not what anyone held "
    "on the day."
)

ALFRED_NOTE = (
    "ALFRED serves the real fix and needs no key. "
    f"{ALFRED_CSV}?id=<SERIES>&vintage_date=<YYYY-MM-DD> returns the "
    "series exactly as it stood that morning, column-named "
    "'<SERIES>_<YYYYMMDD>'. Verified reachable on 2026-08-02. It costs "
    "one request per (series, vintage), so it is the audit rather than "
    "the daily feed: use `lag_audit` to measure how wrong a stated lag "
    "is, then use the lag for the backtest and quote the audit. "
    "THE ARCHIVE DOES NOT REACH AS FAR BACK AS THE DATA. A 2012 vintage "
    "of DTWEXBGS or BAA10Y is a 404 though both series run to the "
    "1980s and 2000s, and STLFSI4 has no vintage before 2023 at all. "
    "Where the archive stops, the stated lag is the only answer there "
    "is and it cannot be checked — which is a reason to keep it "
    "conservative, not a reason to trust it more."
)


# -- failures -------------------------------------------------------------


class FredUnavailable(SourceUnavailable):
    """FRED could not be read. Never a quiet empty series.

    Re-typed at the boundary from `tbill.TbillUnavailable`, exactly as
    `sleevedata` does it: callers of a data source catch
    `SourceUnavailable`, and an exception class from a sibling module
    sails straight past that handler.
    """


class UnknownSeries(ValueError):
    """An id this module has not curated. Deliberately not a passthrough.

    FRED would happily serve an id we know nothing about, and that is
    the problem: a series with no recorded release lag and no recorded
    revision behaviour is a point-in-time bug with a plausible-looking
    column of numbers on top. Add it to CATALOGUE, with its lag, or do
    not use it here.
    """


# -- the shape of a series ------------------------------------------------


#: How the number changes after it is first published. Four states,
#: because "revised" alone hides the distinction that matters: a figure
#: revised on a schedule can be modelled, one re-estimated from scratch
#: every week cannot be recovered at all without the archive.
REVISION_KINDS = ("none", "annual", "scheduled", "continuous")

FREQUENCIES = ("daily", "weekly", "monthly", "quarterly")


@dataclass(frozen=True)
class FredSeries:
    """One curated series, and everything needed to use it honestly."""

    series_id: str
    title: str
    group: str
    frequency: str
    units: str

    #: First observation actually served, verified against the endpoint
    #: rather than copied off the series page — several of FRED's own
    #: descriptions disagree with their data by months.
    start: date

    #: Calendar days from the END of the reference period to first
    #: publication. Not from FRED's observation stamp: a monthly series
    #: is stamped with the FIRST day of its month, so adding a fortnight
    #: to the stamp makes December's CPI knowable on 15 December — two
    #: weeks before the month it measures has finished. `period_end`
    #: does that conversion and every path here goes through it.
    #:
    #: Deliberately rounded UP where the release calendar wobbles. The
    #: two errors are not symmetric: a lag that is too short leaks the
    #: future into a backtest, a lag that is too long merely throws
    #: away information you did have.
    release_lag_days: int

    revision: str
    question: str
    lag_note: str
    revision_note: str
    licence: str

    #: Set where the series has stopped. Kept in the catalogue rather
    #: than deleted — a list of only living ids teaches the reader that
    #: ids do not die.
    discontinued_on: date | None = None

    notes: str = ""

    def __post_init__(self) -> None:
        if self.frequency not in FREQUENCIES:
            raise ValueError(f"{self.series_id}: unknown frequency {self.frequency!r}")
        if self.revision not in REVISION_KINDS:
            raise ValueError(f"{self.series_id}: unknown revision {self.revision!r}")
        if self.licence not in LICENCE_URLS:
            raise ValueError(f"{self.series_id}: unknown licence {self.licence!r}")
        if self.release_lag_days < 0:
            # A negative lag says a number was knowable before the period
            # it measures had ended. That is true of UMich's preliminary
            # reading, and it is also what a lookahead bug looks like
            # from the outside. Zero is the conservative encoding of
            # "knowable by period end" and cannot be misread.
            raise ValueError(
                f"{self.series_id}: a negative release lag is indistinguishable "
                f"from lookahead at a glance; use 0 and say so in lag_note"
            )

    @property
    def licence_url(self) -> str:
        return LICENCE_URLS[self.licence]

    @property
    def redistributable(self) -> bool:
        """Whether the raw numbers may leave this building unasked.

        False does not mean unusable. It means research and internal
        reporting are fine and republication needs ICE's written
        approval — the distinction the tag exists to carry.
        """
        return self.licence != "pre_approval_required"

    def period_end(self, stamp: Any) -> pd.Timestamp:
        """The last day of the period an observation describes.

        The single most useful line in this file. FRED stamps a monthly
        observation with the first day of its month and a quarterly one
        with the first day of its quarter, so the stamp is the period's
        START; daily and weekly series are stamped with the last day of
        the period, so the stamp is already the END. Confusing the two
        moves a monthly release a month early and nothing complains.
        """
        ts = pd.Timestamp(stamp).normalize()
        if self.frequency == "monthly":
            return ts.to_period("M").end_time.normalize()
        if self.frequency == "quarterly":
            return ts.to_period("Q").end_time.normalize()
        # Daily and weekly. Verified against the data on 2026-08-02:
        # ICSA is stamped on the week-ending Saturday, NFCI and STLFSI4
        # on the week-ending Friday.
        return ts

    def knowable_on(self, stamp: Any, lag_days: int) -> pd.Timestamp:
        """The first date an observation could have been read."""
        return self.period_end(stamp) + pd.Timedelta(days=int(lag_days))


@dataclass(frozen=True)
class Observation:
    """One value, with the two dates that keep it honest.

    A bare float would be the wrong return type. The whole point of this
    module is that a macro number has a period it describes and a date
    it became readable, and those are usually a month apart; handing
    back the number alone invites the caller to treat it as current.
    """

    series_id: str
    #: FRED's own stamp — the START of the period for monthly data.
    period: pd.Timestamp
    period_end: pd.Timestamp
    published_on: pd.Timestamp
    asked_on: pd.Timestamp
    value: float
    lag_days: int

    @property
    def staleness_days(self) -> int:
        """How old the FACT is, not how old the publication is.

        The gap a macro overlay actually runs on: on 2 August the
        freshest core PCE describes June, which is a month-old view of
        the economy however recently it was printed.
        """
        return int((self.asked_on - self.period_end).days)


# -- the catalogue --------------------------------------------------------


#: `lag_days=CATALOGUE_LAG` at the call site. The lag stays a required
#: argument — somebody had to type something — while nobody has to
#: re-key a number that is already written down and sourced. What is
#: forbidden is a DEFAULT, because a default is the one form of this
#: that can be forgotten.
CATALOGUE_LAG = "catalogue"

GROUPS = (
    "rates",
    "inflation",
    "credit",
    "growth",
    "conditions",
    "fx_commodities",
)


_SERIES: tuple[FredSeries, ...] = (
    # -- rates and the curve ---------------------------------------------
    FredSeries(
        series_id="DGS3MO",
        title="3-Month Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(1981, 9, 1),
        release_lag_days=1,
        revision="none",
        question="What does cash actually pay? The short end of the curve.",
        lag_note="H.15 goes out around 4:15pm ET the same business day; "
        "one day makes it readable the next morning.",
        revision_note="Corrected only for error, and not announced.",
        licence="public_domain",
        notes="An investment yield, not the discount-basis DTB3 — already "
        "compoundable. `tbill.py` reads this same id for the cash sleeve.",
    ),
    FredSeries(
        series_id="DGS2",
        title="2-Year Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(1976, 6, 1),
        release_lag_days=1,
        revision="none",
        question="Where does the market think policy will be in two years?",
        lag_note="H.15, same business day, readable the next morning.",
        revision_note="Corrected only for error.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="DGS10",
        title="10-Year Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(1962, 1, 2),
        release_lag_days=1,
        revision="none",
        question="The discount rate everything else is priced against.",
        lag_note="One day is a CONVENTION on every daily row here, not a "
        "measurement of scarcity. The archive shows H.15 landing the same "
        "afternoon — a 2019-08-14 vintage of T10Y2Y already carries "
        "2019-08-14 — but it lands at 4:15pm ET, after the close a backtest "
        "trades at. So 1 means 'tradable next morning'. It is also the "
        "measured floor: at lag 0 the audit caught DGS10 and VIXCLS both "
        "claiming a level a day before the archive had it.",
        revision_note="Corrected only for error.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="DGS30",
        title="30-Year Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(1977, 2, 15),
        release_lag_days=1,
        revision="none",
        question="The long end — duration risk at its most exposed.",
        lag_note="H.15, same business day, readable the next morning.",
        revision_note="Corrected only for error.",
        licence="public_domain",
        notes="Treasury suspended 30-year issuance from February 2002 to "
        "February 2006, and this series is nonetheless CONTINUOUS across "
        "that window in the current vintage — checked on 2026-08-02, largest "
        "gap four days, a holiday weekend. So the levels quoted between 2002 "
        "and 2006 cannot have come off an on-the-run 30-year bond, because "
        "there was not one. Treat that stretch as an estimate rather than a "
        "traded yield, and do not build a 30-year term-premium series across "
        "it without saying so.",
    ),
    FredSeries(
        series_id="T10Y2Y",
        title="10-Year minus 2-Year Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percentage points",
        start=date(1976, 6, 1),
        release_lag_days=1,
        revision="none",
        question="Is the curve inverted? The recession signal with the "
        "longest record of being early and right.",
        lag_note="Derived from two H.15 series, so it inherits their timing.",
        revision_note="Corrected only when a leg is.",
        licence="citation_required",
        notes="FRED computes it; it starts when the shorter leg does.",
    ),
    FredSeries(
        series_id="T10Y3M",
        title="10-Year minus 3-Month Treasury Constant Maturity",
        group="rates",
        frequency="daily",
        units="percentage points",
        start=date(1982, 1, 4),
        release_lag_days=1,
        revision="none",
        question="The other inversion measure, and the one the New York "
        "Fed's recession model actually uses.",
        lag_note="Derived from two H.15 series.",
        revision_note="Corrected only when a leg is.",
        licence="citation_required",
    ),
    FredSeries(
        series_id="DFF",
        title="Federal Funds Effective Rate",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(1954, 7, 1),
        release_lag_days=1,
        revision="none",
        question="Where policy actually is, as opposed to where the target "
        "band says it is.",
        lag_note="The New York Fed publishes the prior day's effective rate "
        "around 9am ET.",
        revision_note="The New York Fed may republish the same day if an "
        "error is found; nothing later.",
        licence="public_domain",
        notes="Carries a value on weekends and holidays — Friday's rate "
        "repeated, not a session. Counting rows here counts calendar days.",
    ),
    FredSeries(
        series_id="SOFR",
        title="Secured Overnight Financing Rate",
        group="rates",
        frequency="daily",
        units="percent per annum",
        start=date(2018, 4, 3),
        release_lag_days=1,
        revision="none",
        question="What secured overnight funding costs — the rate that "
        "replaced LIBOR and now anchors floating debt.",
        lag_note="New York Fed publishes around 8am ET for the prior "
        "business day.",
        revision_note="Republished by 2:30pm the same day if an error is "
        "found; never afterwards.",
        licence="citation_required",
        notes="Starts in April 2018. Any study needing a secured funding "
        "rate before that is asking a question this series cannot answer, "
        "and splicing it to LIBOR joins two different credit risks.",
    ),
    # -- inflation and expectations --------------------------------------
    FredSeries(
        series_id="CPIAUCSL",
        title="CPI for All Urban Consumers, All Items (seasonally adjusted)",
        group="inflation",
        frequency="monthly",
        units="index 1982-84=100",
        start=date(1947, 1, 1),
        release_lag_days=16,
        revision="annual",
        question="Headline inflation — the deflator most contracts and most "
        "arguments are indexed to.",
        lag_note="BLS publishes month M between the 10th and the 15th of "
        "M+1. Measured, not recalled: across 16 archived vintages from 2005 "
        "to 2025, a 14-day rule claimed a figure ALFRED did not yet carry "
        "and 15 was the smallest that never did. 16 is that floor plus a "
        "day. Nothing survives a shutdown — the September 2013 CPI came out "
        "on 30 October — which is an argument for `vintage`, not for a "
        "bigger number.",
        revision_note="The SEASONALLY ADJUSTED series is revised every "
        "February, five years back, when seasonal factors are re-estimated. "
        "The unadjusted CPIAUCNS is never revised — if a study needs a "
        "figure nobody has touched since it printed, use that one.",
        licence="public_domain",
        notes="Stamped on the first of the month it measures.",
    ),
    FredSeries(
        series_id="PCEPILFE",
        title="Core PCE Price Index (excluding food and energy)",
        group="inflation",
        frequency="monthly",
        units="index 2017=100",
        start=date(1959, 1, 1),
        release_lag_days=32,
        revision="continuous",
        question="The inflation measure the FOMC actually targets.",
        lag_note="BEA's Personal Income and Outlays release lands in the "
        "last days of M+1, so a month's figure is a month old before anyone "
        "sees it. 32 is reasoned rather than measured: the sampled vintages "
        "never straddled the boundary, so `lag_audit` found no leak anywhere "
        "from 26 days up and therefore found no floor either. A February "
        "figure released on 31 March is 31 days, so 32 is the smallest "
        "number the release window itself justifies.",
        revision_note="Revised with the next two monthly releases, again at "
        "the annual update each September, and rewritten wholesale at the "
        "five-yearly comprehensive revision. Today's 2008 history is not "
        "the history the FOMC met on.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="T5YIE",
        title="5-Year Breakeven Inflation Rate",
        group="inflation",
        frequency="daily",
        units="percentage points",
        start=date(2003, 1, 2),
        release_lag_days=1,
        revision="none",
        question="What inflation is the market pricing over five years — "
        "daily, and without waiting for BLS.",
        lag_note="Derived from H.15 nominal and TIPS yields, same timing.",
        revision_note="Corrected only when a leg is.",
        licence="citation_required",
        notes="A breakeven is expectations PLUS an inflation risk premium "
        "PLUS a TIPS liquidity premium. It is not a forecast, and in "
        "October 2008 it collapsed on liquidity rather than on deflation.",
    ),
    FredSeries(
        series_id="T10YIE",
        title="10-Year Breakeven Inflation Rate",
        group="inflation",
        frequency="daily",
        units="percentage points",
        start=date(2003, 1, 2),
        release_lag_days=1,
        revision="none",
        question="The market's ten-year inflation pricing, daily.",
        lag_note="Derived from H.15 nominal and TIPS yields.",
        revision_note="Corrected only when a leg is.",
        licence="citation_required",
        notes="Same premium caveat as T5YIE.",
    ),
    FredSeries(
        series_id="DFII10",
        title="10-Year Treasury Inflation-Indexed Constant Maturity",
        group="inflation",
        frequency="daily",
        units="percent per annum",
        start=date(2003, 1, 2),
        release_lag_days=1,
        revision="none",
        question="The real risk-free rate — the discount rate with "
        "inflation taken out.",
        lag_note="H.15, same business day.",
        revision_note="Corrected only for error.",
        licence="public_domain",
    ),
    # -- credit ----------------------------------------------------------
    FredSeries(
        series_id="BAMLH0A0HYM2",
        title="ICE BofA US High Yield Index Option-Adjusted Spread",
        group="credit",
        frequency="daily",
        units="percentage points",
        start=date(2023, 8, 1),
        release_lag_days=1,
        revision="none",
        question="What is credit charging for risk TODAY? Three years of "
        "it, and no more — see the note before planning anything on this.",
        lag_note="Index values for day T appear the next business day.",
        revision_note="Restated only when the index constituents are, which "
        "is rare and unannounced.",
        licence="pre_approval_required",
        notes="THE HISTORY IS GONE. This index is documented back to 1996 "
        "and FRED served that history for years; measured on 2026-08-02 it "
        "returns 787 observations beginning 2023-08-01, and asking "
        "explicitly for 2008 returns the same 787 rows. Almost certainly the "
        "licence — ICE Data Indices owns this and its investment-grade twin, "
        "the only two pre-approval rows here. So: no 2008, no 2020, no credit "
        "cycle. It can describe the present and it cannot be backtested "
        "through a drawdown, and anything claiming otherwise on this source "
        "is quoting a series it did not open. Use BAA10Y for history. "
        "Redistribution needs ICE's written approval either way.",
    ),
    FredSeries(
        series_id="BAMLC0A0CM",
        title="ICE BofA US Corporate Index Option-Adjusted Spread",
        group="credit",
        frequency="daily",
        units="percentage points",
        start=date(2023, 8, 1),
        release_lag_days=1,
        revision="none",
        question="Investment-grade spread — the same question as high "
        "yield, asked of borrowers who are not supposed to default.",
        lag_note="Index values for day T appear the next business day.",
        revision_note="Restated only when constituents are.",
        licence="pre_approval_required",
        notes="Truncated exactly like the high-yield series: 786 "
        "observations from 2023-08-01, measured 2026-08-02. HY minus IG is "
        "still the sharpest way to separate a default scare from a duration "
        "repricing, and on this source you can only ask it about the last "
        "three years.",
    ),
    FredSeries(
        series_id="BAA10Y",
        title="Moody's Baa Corporate Yield minus 10-Year Treasury",
        group="credit",
        frequency="daily",
        units="percentage points",
        start=date(1986, 1, 2),
        release_lag_days=1,
        revision="none",
        question="What did credit charge for risk in 2008, in 2000, in "
        "1990? The long credit history FRED still gives away.",
        lag_note="Moody's daily yield, published one business day behind.",
        revision_note="Not revised.",
        licence="citation_required",
        notes="Here because the ICE spreads lost their history. It is NOT an "
        "option-adjusted spread: no adjustment for embedded calls, one "
        "rating bucket, and long-maturity seasoned industrials, so its LEVEL "
        "is not comparable with BAMLC0A0CM's and the two must never be "
        "spliced. Its MOVES are a serviceable stand-in, and forty years of "
        "them beats three.",
    ),
    FredSeries(
        series_id="TEDRATE",
        title="TED Spread (DISCONTINUED)",
        group="credit",
        frequency="daily",
        units="percentage points",
        start=date(1986, 1, 2),
        release_lag_days=1,
        revision="none",
        question="What interbank funding stress looked like before 2022 — "
        "the 2008 panic's clearest single line.",
        lag_note="Was published one business day behind.",
        revision_note="Frozen; it cannot be revised because it is not "
        "being computed.",
        licence="citation_required",
        discontinued_on=date(2022, 1, 21),
        notes="DEAD. It was 3-month LIBOR minus the 3-month bill, and LIBOR "
        "stopped. Kept in the catalogue on purpose: any live feature built "
        "on it would silently freeze at its last value, and a catalogue "
        "that omitted dead ids would teach the reader that ids do not die. "
        "There is no drop-in replacement — the nearest question is asked "
        "with SOFR minus the bill, and it is a different question, because "
        "SOFR is secured and LIBOR was not.",
    ),
    # -- growth and labour -----------------------------------------------
    FredSeries(
        series_id="INDPRO",
        title="Industrial Production: Total Index",
        group="growth",
        frequency="monthly",
        units="index 2017=100",
        start=date(1919, 1, 1),
        release_lag_days=18,
        revision="scheduled",
        question="Real output, monthly, with a century of history behind "
        "it — the longest cycle record in this file.",
        lag_note="The Fed's G.17 lands around the 15th to 17th of M+1. "
        "Across 16 archived vintages a 16-day rule leaked and 17 was the "
        "floor; 18 is that plus a day.",
        revision_note="Revised in each of the following three or four "
        "releases, then again at the annual revision each spring.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="PAYEMS",
        title="All Employees, Total Nonfarm",
        group="growth",
        frequency="monthly",
        units="thousands of persons",
        start=date(1939, 1, 1),
        release_lag_days=11,
        revision="scheduled",
        question="Is the economy adding jobs? The single most market-moving "
        "number on the calendar.",
        lag_note="The Employment Situation is released the first Friday of "
        "M+1, occasionally the second. Across 17 archived vintages a 9-day "
        "rule leaked — the December 2013 report came out on 10 January — "
        "and 10 was the floor; 11 is that plus a day.",
        revision_note="REVISED TWICE, in each of the next two monthly "
        "releases, and then at the annual benchmark against unemployment "
        "insurance records. Measured against the archive, one sampled "
        "vintage has since moved by 1.1 MILLION jobs, and the sign of the "
        "revision is not stable: 2008 was revised down 558k, 2012 up 923k. A "
        "backtest reading today's PAYEMS is reading a number that took three "
        "months to settle and a year to be believed.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="UNRATE",
        title="Unemployment Rate",
        group="growth",
        frequency="monthly",
        units="percent",
        start=date(1948, 1, 1),
        release_lag_days=11,
        revision="annual",
        question="Labour market slack, and half of the Fed's mandate.",
        lag_note="Same release as PAYEMS, and the audit agrees: floor of 10 "
        "over the same 17 vintages, so the same 11.",
        revision_note="Unlike PAYEMS, the household survey is NOT revised "
        "month to month; only the seasonal factors are re-estimated each "
        "January. Two headline numbers, one release, opposite revision "
        "behaviour — which is exactly why 'revised' is not a single flag "
        "in this catalogue.",
        licence="public_domain",
    ),
    FredSeries(
        series_id="ICSA",
        title="Initial Claims (seasonally adjusted)",
        group="growth",
        frequency="weekly",
        units="number of claims",
        start=date(1967, 1, 7),
        release_lag_days=6,
        revision="scheduled",
        question="Is the labour market cracking THIS week? The highest-"
        "frequency real-economy series worth watching.",
        lag_note="Released Thursday morning for the week ending the previous "
        "Saturday. The archive puts the floor at 5 across two independent "
        "sets of sampled vintages — 4 leaked in both — so 6.",
        revision_note="Revised once, the following week, plus an annual "
        "seasonal re-estimation.",
        licence="public_domain",
        notes="Stamped on the week-ending Saturday, so the stamp is already "
        "the period end.",
    ),
    FredSeries(
        series_id="UMCSENT",
        title="University of Michigan: Consumer Sentiment",
        group="growth",
        frequency="monthly",
        units="index 1966:Q1=100",
        start=date(1952, 11, 1),
        release_lag_days=0,
        revision="scheduled",
        question="How households feel about spending, weeks before any "
        "hard data on whether they did.",
        lag_note="THE ONLY MONTHLY SERIES HERE KNOWABLE INSIDE ITS OWN "
        "MONTH. A preliminary reading lands mid-month and the final one "
        "before the month ends, so a lag of 0 — knowable at month end — is "
        "conservative rather than tight.",
        revision_note="The preliminary figure is revised into the final "
        "within the same month, and FRED carries whichever is current.",
        licence="citation_required",
        notes="Quarterly before 1978, monthly since. A frequency change "
        "inside one id: anything computing a monthly change across "
        "1977-1978 is differencing two different sampling schemes.",
    ),
    # -- financial conditions and stress ---------------------------------
    FredSeries(
        series_id="NFCI",
        title="Chicago Fed National Financial Conditions Index",
        group="conditions",
        frequency="weekly",
        units="index, zero = average conditions",
        start=date(1971, 1, 8),
        release_lag_days=6,
        revision="continuous",
        question="Are financial conditions tight or loose, across 105 "
        "measures, in one number?",
        lag_note="Released Wednesday for the week ending the previous "
        "Friday. Measured floor of 5 against the archive, so 6.",
        revision_note="THE WORST REVISION PROBLEM IN THIS FILE. The index "
        "is re-estimated from a dynamic factor model every week, so the "
        "ENTIRE HISTORY can move — the value shown today for March 2009 is "
        "not a number anyone ever saw, and never was. Any backtest reading "
        "this without ALFRED is reading a hindsight-fitted signal.",
        licence="citation_required",
        notes="Stamped on the week-ending Friday.",
    ),
    FredSeries(
        series_id="STLFSI4",
        title="St. Louis Fed Financial Stress Index (4th edition)",
        group="conditions",
        frequency="weekly",
        units="index, zero = average conditions",
        start=date(1993, 12, 31),
        release_lag_days=7,
        revision="continuous",
        question="A second, independently built read on financial stress — "
        "useful precisely because it disagrees with NFCI sometimes.",
        lag_note="Released Thursday for the week ending the previous Friday. "
        "Measured floor of 6 against the archive — 5 leaked — so 7.",
        revision_note="Re-estimated, so history moves. The '4' in the id is "
        "itself the warning: STLFSI, STLFSI2 and STLFSI3 were retired and "
        "rebuilt, and a study citing 'the St. Louis stress index' from "
        "before 2022 is citing a different series. Worse, ALFRED cannot "
        "check it: a vintage dated 2022-06-15 is a 404 and 2023-06-14 works, "
        "so this series has a re-estimated history AND no archive of what it "
        "used to say. Of everything in this file it is the one whose past "
        "cannot be recovered at all.",
        licence="citation_required",
        notes="Stamped on the week-ending Friday.",
    ),
    FredSeries(
        series_id="VIXCLS",
        title="CBOE Volatility Index: VIX, close",
        group="conditions",
        frequency="daily",
        units="index, annualised percent",
        start=date(1990, 1, 2),
        release_lag_days=1,
        revision="none",
        question="What is 30-day implied volatility? Priced continuously, "
        "so it moves before any survey or index does.",
        lag_note="Closing value, readable the next morning. Reading it "
        "same-day is a lookahead of exactly one session, which is the size "
        "of the effect most volatility overlays are trying to capture.",
        revision_note="Not revised.",
        licence="citation_required",
        notes="Cboe's mark, citation required. History back to 1990 is the "
        "reconstructed VIX methodology applied to older options data — the "
        "index as traded today dates from 2003.",
    ),
    # -- dollar and commodities ------------------------------------------
    FredSeries(
        series_id="DTWEXBGS",
        title="Nominal Broad U.S. Dollar Index (goods and services)",
        group="fx_commodities",
        frequency="daily",
        units="index Jan 2006=100",
        start=date(2006, 1, 2),
        release_lag_days=5,
        revision="none",
        question="Is the dollar tightening or loosening global financial "
        "conditions? The variable that moves foreign earnings.",
        lag_note="DAILY VALUES, WEEKLY PUBLICATION — the trap in this row. "
        "H.10 goes out once a week covering the days behind it, so the "
        "one-day rule that is right for every other daily series here is "
        "wrong for this one, and the archive says by how much: at lag 1 the "
        "rule ran up to five days ahead of what had been published. Measured "
        "floor 4, so 5.",
        revision_note="Not revised.",
        licence="public_domain",
        notes="Replaced DTWEXB, which is frozen at January 2020. Starts in "
        "2006 — a longer dollar history means splicing indices with "
        "different baskets, which is a decision, not a convenience.",
    ),
    FredSeries(
        series_id="DCOILWTICO",
        title="Crude Oil Prices: West Texas Intermediate, Cushing",
        group="fx_commodities",
        frequency="daily",
        units="US dollars per barrel",
        start=date(1986, 1, 2),
        release_lag_days=5,
        revision="none",
        question="The commodity that shows up in headline inflation, in "
        "transport costs, and in half the energy sector's earnings.",
        lag_note="EIA's spot price reaches FRED days behind the tape — at "
        "lag 1 the archive caught the rule running three days ahead of "
        "publication, and 4 was the floor, so 5. This is NOT a market feed "
        "and must not be used as one; for anything trading oil, read a price "
        "source.",
        revision_note="Not revised.",
        licence="public_domain",
        notes="Spot, not the futures curve. It went NEGATIVE on "
        "2020-04-20, which breaks any transform taking a log.",
    ),
)

CATALOGUE: Mapping[str, FredSeries] = {s.series_id: s for s in _SERIES}


def series(series_id: str) -> FredSeries:
    """The catalogue entry, or a raise naming what is on the shelf."""
    key = str(series_id).strip().upper()
    spec = CATALOGUE.get(key)
    if spec is None:
        raise UnknownSeries(
            f"{series_id!r} is not in this catalogue. FRED would serve it "
            f"happily, which is the problem: an id with no recorded release "
            f"lag and no recorded revision behaviour is a point-in-time bug "
            f"wearing a tidy column of numbers. Add it to CATALOGUE with its "
            f"lag and its revision note. Curated ids: {sorted(CATALOGUE)}"
        )
    return spec


def in_group(group: str) -> tuple[FredSeries, ...]:
    if group not in GROUPS:
        raise ValueError(f"no such group {group!r}; groups are {list(GROUPS)}")
    return tuple(s for s in _SERIES if s.group == group)


def catalogue_frame() -> pd.DataFrame:
    """The catalogue as a table, for a report that has to show its terms."""
    return pd.DataFrame(
        [
            {
                "series_id": s.series_id,
                "group": s.group,
                "title": s.title,
                "frequency": s.frequency,
                "units": s.units,
                "start": pd.Timestamp(s.start),
                "discontinued_on": (
                    pd.Timestamp(s.discontinued_on) if s.discontinued_on else pd.NaT
                ),
                "release_lag_days": s.release_lag_days,
                "revision": s.revision,
                "licence": s.licence,
                "redistributable": s.redistributable,
                "question": s.question,
                "lag_note": s.lag_note,
                "revision_note": s.revision_note,
                "notes": s.notes,
            }
            for s in _SERIES
        ]
    )


def resolve_lag(spec: FredSeries, lag_days: int | str) -> int:
    """Turn the caller's stated lag into days, refusing anything vague.

    `CATALOGUE_LAG` is allowed and an int is allowed. None is not, a
    float is not, and there is no default anywhere up the call chain —
    the argument exists so that the person writing the feature has to
    look at the lag once.
    """
    if isinstance(lag_days, str):
        if lag_days != CATALOGUE_LAG:
            raise ValueError(
                f"lag_days must be a whole number of days or "
                f"{CATALOGUE_LAG!r}, got {lag_days!r}"
            )
        return int(spec.release_lag_days)
    if isinstance(lag_days, bool) or not isinstance(lag_days, (int, np.integer)):
        raise TypeError(
            f"lag_days must be a whole number of days or {CATALOGUE_LAG!r}, "
            f"got {type(lag_days).__name__}. There is deliberately no "
            f"default: {spec.series_id} is first published "
            f"{spec.release_lag_days} days after its period ends, and a lag "
            f"that can be forgotten is one that will be."
        )
    if lag_days < 0:
        raise ValueError(
            f"a negative lag_days ({lag_days}) reads the future by "
            f"construction; 0 is the shortest honest answer"
        )
    return int(lag_days)


# -- transport ------------------------------------------------------------


#: Monotonic, process-wide, and deliberately not derived from any
#: injected clock: a frozen clock in a test must never become a decision
#: about how fast we are allowed to talk to somebody else's server.
_last_request: float = float("-inf")


def _pace(sleep: Callable[[float], None]) -> None:
    global _last_request
    waited = time.monotonic() - _last_request
    if 0.0 <= waited < MIN_REQUEST_INTERVAL_SECONDS:
        sleep(MIN_REQUEST_INTERVAL_SECONDS - waited)
    _last_request = time.monotonic()


def _read(
    series_id: str,
    start: date,
    end: date,
    *,
    timeout: int,
    fetcher: Callable[..., pd.DataFrame] | None,
    sleep: Callable[[float], None],
    base: str = FRED_CSV,
    extra_params: Mapping[str, Any] | None = None,
) -> pd.DataFrame:
    """One trip to the shared reader, paced, with the failure re-typed."""
    _pace(sleep)
    call = fetcher or fetch_observations
    try:
        return call(
            series_id,
            start,
            end,
            timeout=timeout,
            base=base,
            extra_params=extra_params,
        )
    except FredNotPublished:
        # A 404 is an answer and keeps its own type all the way up: it
        # means the id or the vintage does not exist, not that FRED is
        # down, and sending somebody to check the network for a typo
        # wastes the afternoon.
        raise
    except TbillUnavailable as exc:
        raise FredUnavailable(
            f"{series_id}: {exc} This is an outage and NOT an empty series — "
            f"returning a frame with no rows here would put a flat macro "
            f"overlay into a backtest and look like a quiet regime."
        ) from exc


def _to_series(frame: pd.DataFrame, series_id: str) -> pd.Series:
    out = pd.Series(
        frame["value"].to_numpy(dtype="float64"),
        index=pd.DatetimeIndex(frame["date"]).normalize(),
        name=series_id,
    )
    return out.sort_index()


def fetch_series(
    series_id: str,
    *,
    cache: "ParquetCache | None" = None,
    today: date | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    fetcher: Callable[..., pd.DataFrame] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], datetime] | None = None,
    refresh: bool = False,
) -> pd.Series:
    """The whole published history of one curated series, cached.

    Always the whole history, never the caller's window. The endpoint
    hands back whatever range is asked for at the same cost, so keying
    the cache on a window would store the same seventy years again
    under a new name every time somebody moved a date. One entry per
    series per day; slice it afterwards.
    """
    spec = series(series_id)
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    through = today or now.date()

    def load() -> pd.DataFrame:
        return _read(
            spec.series_id,
            HISTORY_START,
            through,
            timeout=timeout,
            fetcher=fetcher,
            sleep=sleep,
        )

    if cache is None:
        return _to_series(load(), spec.series_id)

    key = cache.key(SOURCE_SLUG, FRAME_OBSERVATIONS, series=spec.series_id, end=through)
    frame = cache.get_or_load(key, load, stamped=now, now=now, refresh=refresh)
    return _to_series(frame, spec.series_id)


def fetch_many(
    series_ids: Iterable[str], **kwargs: Any
) -> dict[str, pd.Series]:
    """Several series, one request apiece, paced between them.

    One id per request on purpose. FRED's graph endpoint accepts a
    comma-separated list and then SILENTLY IGNORES cosd and coed,
    returning every observation it has for the longest series — which
    arrives as a much larger, entirely well-formed frame.

    A failure is not swallowed. If one id is unreachable the pull
    raises, because a dict quietly missing a key is how a macro overlay
    ends up running on five of the six inputs it was written for.
    """
    return {sid: fetch_series(sid, **kwargs) for sid in series_ids}


# -- point in time --------------------------------------------------------


def _published_index(
    spec: FredSeries, stamps: pd.DatetimeIndex, lag: int
) -> pd.DatetimeIndex:
    ends = _period_ends(spec, stamps)
    return pd.DatetimeIndex(ends + pd.Timedelta(days=lag))


def _period_ends(spec: FredSeries, stamps: pd.DatetimeIndex) -> pd.DatetimeIndex:
    idx = pd.DatetimeIndex(stamps).normalize()
    if spec.frequency == "monthly":
        return pd.DatetimeIndex(idx.to_period("M").to_timestamp(how="end")).normalize()
    if spec.frequency == "quarterly":
        return pd.DatetimeIndex(idx.to_period("Q").to_timestamp(how="end")).normalize()
    return idx


def _history_for(
    series_id: str, history: pd.Series | None, kwargs: Mapping[str, Any]
) -> pd.Series:
    if history is None:
        return fetch_series(series_id, **kwargs)
    s = pd.Series(history).astype("float64")
    s.index = pd.DatetimeIndex(s.index).normalize()
    return s.sort_index()


def as_of(
    series_id: str,
    on: Any,
    *,
    lag_days: int | str,
    history: pd.Series | None = None,
    **fetch_kwargs: Any,
) -> Observation | None:
    """The freshest observation that could have been READ on `on`.

    Not the freshest observation dated before `on` — the two differ by
    the publication lag, which is the whole subject of this module. Ask
    for CPI on 2020-01-05 and the answer describes November 2019,
    because December's figure was not published until the 14th.

    `lag_days` is required and has no default. Pass an integer, or
    `CATALOGUE_LAG` to use the documented figure on the catalogue row.

    Returns None when nothing was knowable yet — before the series
    existed, or inside its first publication lag. None rather than the
    first observation, and the caller must branch: silently reaching
    back to the earliest value is how a 1990 backtest ends up holding a
    2003 breakeven.
    """
    spec = series(series_id)
    lag = resolve_lag(spec, lag_days)
    when = pd.Timestamp(on).normalize()
    obs = _history_for(spec.series_id, history, fetch_kwargs)
    if obs.empty:
        return None

    published = _published_index(spec, pd.DatetimeIndex(obs.index), lag)
    usable = np.flatnonzero(published.to_numpy() <= when.to_numpy())
    if usable.size == 0:
        return None

    i = int(usable[-1])
    stamp = pd.Timestamp(obs.index[i])
    return Observation(
        series_id=spec.series_id,
        period=stamp,
        period_end=spec.period_end(stamp),
        published_on=pd.Timestamp(published[i]),
        asked_on=when,
        value=float(obs.iloc[i]),
        lag_days=lag,
    )


def available_history(
    series_id: str,
    on: Any,
    *,
    lag_days: int | str,
    history: pd.Series | None = None,
    **fetch_kwargs: Any,
) -> pd.Series:
    """Everything that had been published by `on`, and nothing after.

    The frame a model may be fitted on as of a date. Note what it still
    cannot promise: the VALUES are today's, so a series that gets
    revised hands back numbers with the right dates and the wrong
    contents. For anything where that matters — PAYEMS, PCEPILFE, NFCI —
    `vintage()` is the honest read and `lag_audit()` measures the gap.
    """
    spec = series(series_id)
    lag = resolve_lag(spec, lag_days)
    when = pd.Timestamp(on).normalize()
    obs = _history_for(spec.series_id, history, fetch_kwargs)
    if obs.empty:
        return obs

    published = _published_index(spec, pd.DatetimeIndex(obs.index), lag)
    return obs.loc[published.to_numpy() <= when.to_numpy()]


def on_calendar(
    series_id: str,
    calendar: Any,
    *,
    lag_days: int | str,
    history: pd.Series | None = None,
    **fetch_kwargs: Any,
) -> pd.Series:
    """A macro series aligned to a trading calendar without leaking.

    Each observation appears on the first calendar date at or after its
    publication, and is carried forward until the next one lands —
    which is exactly what a person following the release calendar would
    have known. Two rules make it safe:

    Nothing is back-filled. Dates before the first publication are NaN
    rather than the earliest value, so a window that starts before the
    series does is visibly empty instead of quietly flat.

    Forward-filling is not interpolation. A monthly figure holds its
    level until the next release because that IS the state of knowledge;
    sliding it toward the next print would use a number nobody had.
    """
    spec = series(series_id)
    lag = resolve_lag(spec, lag_days)
    cal = pd.DatetimeIndex(calendar).normalize()
    obs = _history_for(spec.series_id, history, fetch_kwargs)
    if len(cal) == 0:
        return pd.Series([], dtype="float64", name=spec.series_id)
    if obs.empty:
        return pd.Series(np.nan, index=cal, dtype="float64", name=spec.series_id)

    published = _published_index(spec, pd.DatetimeIndex(obs.index), lag)
    frame = pd.DataFrame({"published": published, "value": obs.to_numpy()})
    # A single release carries revisions to earlier periods, so several
    # observations can share a publication date. The later PERIOD is the
    # one a reader would quote, and `obs` is period-sorted, so last wins.
    latest = frame.groupby("published")["value"].last().sort_index()

    aligned = latest.reindex(latest.index.union(cal)).ffill().reindex(cal)
    aligned.name = spec.series_id
    return aligned.astype("float64")


# -- ALFRED, which is the actual fix --------------------------------------


def vintage(
    series_id: str,
    vintage_date: Any,
    *,
    start: date | None = None,
    cache: "ParquetCache | None" = None,
    timeout: int = DEFAULT_TIMEOUT,
    fetcher: Callable[..., pd.DataFrame] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], datetime] | None = None,
) -> pd.Series:
    """The series exactly as it stood on `vintage_date`. No key needed.

    This is the correct fix for everything `as_of` approximates: not
    today's history truncated by a rule of thumb, but the file the
    archive says existed that morning, revisions and all. Verified
    reachable on the keyless endpoint on 2026-08-02.

    The cost is one request per (series, vintage), so this is an audit
    instrument rather than a feed — five thousand backtest days would be
    five thousand requests. Use `lag_audit` to check a lag rule at a
    handful of dates, then run the backtest on the rule.

    Two sharp edges, both worth knowing before they surprise you. A
    vintage dated before the series' first release is a 404 and raises
    `FredNotPublished`, which is an answer rather than an outage. And
    the window must end at or before the vintage — asking for a range
    the vintage cannot cover returns nothing, which the shared reader
    reports as an outage because for FRED that is nearly always what it
    is.
    """
    spec = series(series_id)
    asked = pd.Timestamp(vintage_date).normalize()
    end = asked.date()
    first = start or spec.start
    now = (clock or (lambda: datetime.now(timezone.utc)))()

    def load() -> pd.DataFrame:
        return _read(
            spec.series_id,
            first,
            end,
            timeout=timeout,
            fetcher=fetcher,
            sleep=sleep,
            base=ALFRED_CSV,
            # ALFRED names the column `<SERIES>_<YYYYMMDD>`; the shared
            # reader falls back to the single non-date column, which is
            # why this needed no second parser.
            extra_params={"vintage_date": end.isoformat()},
        )

    if cache is None:
        return _to_series(load(), spec.series_id)

    key = cache.key(
        SOURCE_SLUG,
        FRAME_VINTAGE,
        series=spec.series_id,
        vintage=end,
        start=first,
    )
    # A vintage is immutable — that morning's file will never change
    # again — so this entry should never expire. It only gets that life
    # if the cache was built with CACHE_TTL_DAYS; see `default_cache`.
    frame = cache.get_or_load(key, load, stamped=now, now=now)
    return _to_series(frame, spec.series_id)


def lag_audit(
    series_id: str,
    vintage_dates: Sequence[Any],
    *,
    lag_days: int | str,
    history: pd.Series | None = None,
    cache: "ParquetCache | None" = None,
    **fetch_kwargs: Any,
) -> pd.DataFrame:
    """Grade the stated lag against what the archive says was really there.

    For each vintage date: what the lag rule claims was the freshest
    readable period, what the archive says the freshest period actually
    was, and — separately — whether the VALUE for that period has been
    revised since. Two independent ways of being wrong, reported apart,
    because a lag that is right about the date can still be reading a
    number that has moved twice.

    `periods_off` is signed. Positive means the lag rule claimed a
    period the archive did not yet carry, which is lookahead and the
    reason this function exists. Negative means the rule was
    conservative and threw away information it could have had, which
    costs power and never credibility.

    **`revised_by` is a difference of index LEVELS, and a base year is
    not a revision.** Core PCE moved 29.7 index points and industrial
    production 21.8 between the sampled vintages and today, which is
    rebasing (2012=100 became 2017=100) rather than anybody restating
    the economy. Payrolls, which are counted in people and not rebased,
    moved by 1.1 million at one vintage — that one is real. Compare
    ratios or growth rates before concluding a number was restated.
    """
    spec = series(series_id)
    lag = resolve_lag(spec, lag_days)
    current = _history_for(spec.series_id, history, fetch_kwargs)

    rows: list[dict[str, Any]] = []
    for raw in vintage_dates:
        when = pd.Timestamp(raw).normalize()
        claimed = as_of(
            spec.series_id, when, lag_days=lag, history=current
        )
        archived = vintage(
            spec.series_id, when, cache=cache, **_vintage_kwargs(fetch_kwargs)
        )
        truth_period = pd.Timestamp(archived.index[-1]) if len(archived) else pd.NaT
        truth_value = float(archived.iloc[-1]) if len(archived) else float("nan")

        claimed_period = claimed.period if claimed else pd.NaT
        # Counted in periods rather than days so a monthly series that is
        # one release early reads as 1 and not as 28-to-31.
        off = _periods_between(spec, truth_period, claimed_period)

        # The same period as the archive saw it, against the same period
        # as it stands today. This is the revision, isolated from any
        # question about the lag.
        revised_from = float("nan")
        if not pd.isna(truth_period) and truth_period in current.index:
            revised_from = float(current.loc[truth_period])

        rows.append(
            {
                "series_id": spec.series_id,
                "vintage_date": when,
                "lag_days": lag,
                "claimed_period": claimed_period,
                "vintage_period": truth_period,
                "periods_off": off,
                "vintage_value": truth_value,
                "current_value": revised_from,
                "revised_by": revised_from - truth_value,
            }
        )
    return pd.DataFrame(rows)


def _vintage_kwargs(fetch_kwargs: Mapping[str, Any]) -> dict[str, Any]:
    """The subset of fetch options `vintage` understands.

    `today` and `refresh` belong to the live pull and mean nothing to an
    archive request; passing them through would be a TypeError raised
    from the wrong place.
    """
    allowed = ("timeout", "fetcher", "sleep", "clock")
    return {k: v for k, v in fetch_kwargs.items() if k in allowed}


def _periods_between(
    spec: FredSeries, base: pd.Timestamp, other: pd.Timestamp
) -> float:
    if pd.isna(base) or pd.isna(other):
        return float("nan")
    if spec.frequency == "monthly":
        return float(
            (other.year - base.year) * 12 + (other.month - base.month)
        )
    if spec.frequency == "quarterly":
        return float(
            (other.year - base.year) * 4
            + (other.quarter - base.quarter)
        )
    if spec.frequency == "weekly":
        return float((other - base).days / 7.0)
    return float((other - base).days)


# -- convenience ----------------------------------------------------------


def default_cache(root: Path | str | None = None) -> "ParquetCache":
    """A cache that knows a vintage is immutable and a live series is not.

    Imported lazily so this module can be read, and its catalogue
    printed, without pulling pyarrow in behind it.
    """
    from .cache import DEFAULT_ROOT, ParquetCache

    return ParquetCache(root or DEFAULT_ROOT, ttl_days=CACHE_TTL_DAYS)


def describe(series_id: str) -> str:
    """The row as a paragraph, for a report or a terminal."""
    s = series(series_id)
    dead = (
        f" DISCONTINUED {s.discontinued_on.isoformat()}."
        if s.discontinued_on
        else ""
    )
    return (
        f"{s.series_id} — {s.title} ({s.units}, {s.frequency}, from "
        f"{s.start.isoformat()}).{dead}\n"
        f"  Answers: {s.question}\n"
        f"  Lag: {s.release_lag_days}d after period end. {s.lag_note}\n"
        f"  Revisions ({s.revision}): {s.revision_note}\n"
        f"  Licence: {s.licence} — {s.licence_url}"
        + (f"\n  Note: {s.notes}" if s.notes else "")
    )
