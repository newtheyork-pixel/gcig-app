"""The ETF cross-section the classifier is allowed to see, and the
date each vehicle actually started trading.

The trap this file exists to close is the fund that did not exist yet.
A universe is a list of symbols, and a list of symbols carries no
timestamps, so the natural thing for a panel builder to do is fetch
every name over the whole window and let the missing rows be missing.
That is fine right up until a cross-sectional rank is taken: a rank
among the names PRESENT on a date silently becomes a rank among the
names that had listed, and if the roster is assumed constant the model
is told on 2005-01-03 that HYG scored in the bottom decile of a
twenty-eight name cross-section. HYG listed in 2007. Nobody could have
ranked it, and no error is raised, because a NaN in a rank is not an
exception — it is a blank.

So every entry below carries an `inception` that was LOOKED UP rather
than recalled, with the URL it was read from sitting next to it.
`available_on` is the only sanctioned way to ask which names existed on
a date, and `verify_against_prices` closes the loop the other way, by
checking the asserted date against the first bar the data source
actually served.

**This list was selected in 2026, and that is a bias.** Every fund here
is one that survived and grew, chosen with full knowledge of which
sponsors and which product lines went on to gather assets. The
counterfactual roster — the one an investor could have written in 2005
— would have included currency-hedged and quant-tilted products that
closed, and would have weighted the survivors differently. What it
would NOT have included is the interesting part: the failure mode this
whole project exists to avoid is a universe of "random tickers that
exist today", where individual companies go bankrupt and simply vanish
from the sample, leaving a backtest that only ever traded the winners.

The two biases are not the same size, and the difference is worth
stating precisely rather than waving at. A delisted single name is
typically a total or near-total loss, so removing it from the sample
removes the left tail of the return distribution and the survivorship
premium runs to several percent a year. A closed ETF is almost always
wound up at NAV and its holders are paid out; the loss is a few basis
points of friction, not the position. And these twenty-eight are large
living funds tracking broad public indices, so the return SERIES here
is essentially the index's return series, which existed whether or not
a wrapper around it did.

That makes the bias small. It does not make it zero, and the writeup
must not say zero. Two channels survive:

  * **Category selection.** Broad commodity, silver and high yield all
    listed mid-sample because those exposures became popular, and they
    became popular after they had performed. A universe assembled in
    2005 would likely not have carried them at all.
  * **Sponsor selection.** iShares, State Street, Invesco and Vanguard
    are the four issuers here because they are the four that won. A
    2005 roster would have carried Merrill's HOLDRS and several
    products from sponsors that no longer exist.

Neither channel is measurable from inside this sample, so neither is
corrected for. They are declared.

**What the cross-section is actually made of.** Fourteen of the
twenty-eight names are US equity beta — four broad-market funds, the
nine sector SPDRs, and VNQ, which is a US REIT fund and correlates with
US equity far more than its "real asset" label suggests. So a
cross-sectional rank computed here is, half the time, a rank within US
equity sectors. That is not a defect to be fixed by deleting sectors
(sector dispersion is the most plausible thing in this universe for a
cross-sectional model to have any purchase on), but it is the correct
way to read any result: this is not twenty-eight independent bets.

**Three of the sector series change what they hold mid-sample.** GICS
carved real estate out of financials in September 2016, so XLF before
and after that date are different portfolios wearing one ticker; the
communication-services sector was created in September 2018 out of
names that had been in technology and consumer discretionary, which
moves XLK and XLY the same way. The price series is continuous and
correct — the fund really did hold those things — but a feature
computed across the break is comparing two different baskets, and a
model that finds something in XLF around 2016 has probably found the
reclassification.

**The usable sample start.** Sorted by inception, the panel reaches
twenty names on 2003-04-07, twenty-five on 2004-11-18 and all
twenty-eight on 2007-04-04 when HYG lists. Features need a full
252-session trailing window, so a name is not merely alive but usable
about a year after it lists. Taking the project's existing
`config.SAMPLE_START` of 2005-01-01: twenty-five of the twenty-eight
names are alive on the first session and twenty-two of those carry a
complete feature window, which is a cross-section wide enough for a
percentile to mean something. The panel then grows to twenty-eight
feature-complete names during 2008. That growth is real and must be
allowed rather than trimmed away — cutting the sample back to
2008-04 to get a rectangular panel would throw out 2005-2007 and, more
to the point, would throw out the run-up into the one crisis in this
sample that a model could plausibly have been early to.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

import pandas as pd

from ..config import SAMPLE_START

__all__ = [
    "CROSS_SECTION_FLOOR",
    "DRIVERS",
    "Fund",
    "FULL_PANEL_DATE",
    "SAMPLE_START_DATE",
    "UNIVERSE",
    "UNIVERSE_TICKERS",
    "UniverseError",
    "available_on",
    "by_driver",
    "first_date_with",
    "fund",
    "inception_table",
    "verify_against_prices",
]


class UniverseError(ValueError):
    """The universe was asked something it cannot answer honestly."""


def _sa(ticker: str) -> str:
    """The page each inception below was read from.

    One vendor for all twenty-eight, which is a real weakness and is
    recorded as one. The issuer pages (ishares.com, etfdb.com) refuse
    automated reads with HTTP 403, and the Tiingo metadata endpoint —
    which would have been the better check, since it reports the first
    date data actually EXISTS rather than the first date the fund
    claims to — answered 429 to every symbol on the afternoon this was
    written. `verify_against_prices` exists so that check gets made
    against the real pull rather than skipped.
    """
    return f"https://stockanalysis.com/etf/{ticker.lower()}/"


#: The return drivers this universe is meant to span. A driver is a
#: reason a fund moves, not an asset-class label: TIP sits apart from
#: the Treasury sleeve because it is a bet on realised inflation
#: against the breakeven rather than on the level of yields, and VNQ
#: sits under real estate rather than equity only so the concentration
#: note above stays legible.
DRIVERS: frozenset[str] = frozenset(
    {
        "us_equity_broad",
        "us_equity_sector",
        "intl_equity",
        "government_duration",
        "inflation_linked",
        "credit",
        "precious_metal",
        "commodity",
        "real_estate",
    }
)


@dataclass(frozen=True)
class Fund:
    """One ETF, and the date before which it may not appear anywhere.

    `inception` is the fund's own stated inception, which is normally
    the day it was seeded and priced. Where a vendor's first traded bar
    is known to fall later, THAT date is recorded here instead and the
    note says so. The asymmetry is deliberate: recording a date later
    than the truth costs a handful of sessions at the start of one
    name's history, and recording one earlier is lookahead.
    """

    ticker: str
    name: str
    issuer: str
    driver: str
    inception: date
    source: str
    corroboration: str = ""
    note: str = ""

    def available_on(self, day: date | datetime | str) -> bool:
        return _as_date(day) >= self.inception


# The roster. Ordered by driver so the concentration is visible on the
# page rather than only in the docstring, and within a driver by
# inception so the reader can see which exposures arrived late.
UNIVERSE: tuple[Fund, ...] = (
    # -- US equity, broad ------------------------------------------
    #
    # Four cuts of one market: cap-weighted large, the Nasdaq's
    # growth tilt, small cap, and the same S&P 500 held equally. RSP
    # earns its place precisely because it holds the same securities
    # as SPY — the spread between them is a pure size-and-crowding
    # signal with no sector or country story attached, which is about
    # the cleanest thing in this universe.
    Fund(
        ticker="SPY",
        name="SPDR S&P 500 ETF Trust",
        issuer="State Street",
        driver="us_equity_broad",
        inception=date(1993, 1, 22),
        source=_sa("SPY"),
        note="the oldest US ETF; predates the sample by twelve years",
    ),
    Fund(
        ticker="QQQ",
        name="Invesco QQQ Trust Series I",
        issuer="Invesco",
        driver="us_equity_broad",
        inception=date(1999, 3, 10),
        source=_sa("QQQ"),
    ),
    Fund(
        ticker="IWM",
        name="iShares Russell 2000 ETF",
        issuer="BlackRock",
        driver="us_equity_broad",
        inception=date(2000, 5, 22),
        source=_sa("IWM"),
    ),
    Fund(
        ticker="RSP",
        name="Invesco S&P 500 Equal Weight ETF",
        issuer="Invesco",
        driver="us_equity_broad",
        inception=date(2003, 4, 24),
        source=_sa("RSP"),
    ),
    # -- US equity, sector -----------------------------------------
    #
    # All nine original Select Sector SPDRs share one inception,
    # 1998-12-16, because they were launched as a single set carving
    # the S&P 500 into nine pieces. That shared date is worth knowing
    # before someone reads it as a transcription error.
    Fund(
        ticker="XLE",
        name="Energy Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLE"),
    ),
    Fund(
        ticker="XLF",
        name="Financial Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLF"),
        note=(
            "composition breaks 2016-09: GICS moved real estate out of "
            "financials into its own sector, so XLF before and after is "
            "not the same basket"
        ),
    ),
    Fund(
        ticker="XLK",
        name="Technology Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLK"),
        note=(
            "composition breaks 2018-09: the communication-services "
            "sector was created partly out of technology"
        ),
    ),
    Fund(
        ticker="XLV",
        name="Health Care Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLV"),
    ),
    Fund(
        ticker="XLI",
        name="Industrial Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLI"),
    ),
    Fund(
        ticker="XLP",
        name="Consumer Staples Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLP"),
    ),
    Fund(
        ticker="XLY",
        name="Consumer Discretionary Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLY"),
        note=(
            "composition breaks 2018-09: the communication-services "
            "sector was created partly out of consumer discretionary"
        ),
    ),
    Fund(
        ticker="XLU",
        name="Utilities Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLU"),
    ),
    Fund(
        ticker="XLB",
        name="Materials Select Sector SPDR Fund",
        issuer="State Street",
        driver="us_equity_sector",
        inception=date(1998, 12, 16),
        source=_sa("XLB"),
    ),
    # -- International equity --------------------------------------
    #
    # Every one of these carries an unhedged currency leg, which is a
    # second return driver riding inside the first. That is a feature
    # here rather than a defect: it is exposure the US-only half of
    # the panel cannot express at all.
    Fund(
        ticker="EWJ",
        name="iShares MSCI Japan ETF",
        issuer="BlackRock",
        driver="intl_equity",
        inception=date(1996, 3, 12),
        source=_sa("EWJ"),
    ),
    Fund(
        ticker="EWZ",
        name="iShares MSCI Brazil ETF",
        issuer="BlackRock",
        driver="intl_equity",
        inception=date(2000, 7, 10),
        source=_sa("EWZ"),
    ),
    Fund(
        ticker="EFA",
        name="iShares MSCI EAFE ETF",
        issuer="BlackRock",
        driver="intl_equity",
        inception=date(2001, 8, 14),
        source=_sa("EFA"),
    ),
    Fund(
        ticker="EEM",
        name="iShares MSCI Emerging Markets ETF",
        issuer="BlackRock",
        driver="intl_equity",
        inception=date(2003, 4, 7),
        source=_sa("EEM"),
    ),
    Fund(
        ticker="FXI",
        name="iShares China Large-Cap ETF",
        issuer="BlackRock",
        driver="intl_equity",
        inception=date(2004, 10, 5),
        source=_sa("FXI"),
        note="alive but inside its first feature year at the sample start",
    ),
    # -- Government duration ---------------------------------------
    #
    # Three points on one curve, launched together. Holding all three
    # is what lets a cross-sectional feature see the SHAPE of a rate
    # move rather than only its direction — 2022 hit SHY and TLT in
    # the same direction and by an order of magnitude differently.
    Fund(
        ticker="SHY",
        name="iShares 1-3 Year Treasury Bond ETF",
        issuer="BlackRock",
        driver="government_duration",
        inception=date(2002, 7, 22),
        source=_sa("SHY"),
    ),
    Fund(
        ticker="IEF",
        name="iShares 7-10 Year Treasury Bond ETF",
        issuer="BlackRock",
        driver="government_duration",
        inception=date(2002, 7, 22),
        source=_sa("IEF"),
    ),
    Fund(
        ticker="TLT",
        name="iShares 20+ Year Treasury Bond ETF",
        issuer="BlackRock",
        driver="government_duration",
        inception=date(2002, 7, 22),
        source=_sa("TLT"),
    ),
    # -- Inflation-linked ------------------------------------------
    Fund(
        ticker="TIP",
        name="iShares TIPS Bond ETF",
        issuer="BlackRock",
        driver="inflation_linked",
        inception=date(2003, 12, 4),
        source=_sa("TIP"),
    ),
    # -- Credit ----------------------------------------------------
    #
    # The pair matters more than either name. Investment grade and
    # high yield share a rate leg and differ in a default leg, so the
    # spread between them is the cleanest risk-appetite reading
    # available in this universe — and it is only available from 2007.
    Fund(
        ticker="LQD",
        name="iShares iBoxx $ Investment Grade Corporate Bond ETF",
        issuer="BlackRock",
        driver="credit",
        inception=date(2002, 7, 22),
        source=_sa("LQD"),
    ),
    Fund(
        ticker="HYG",
        name="iShares iBoxx $ High Yield Corporate Bond ETF",
        issuer="BlackRock",
        driver="credit",
        inception=date(2007, 4, 4),
        source=_sa("HYG"),
        note=(
            "the last name to list, and therefore the date the full "
            "twenty-eight-name panel begins"
        ),
    ),
    # -- Precious metals -------------------------------------------
    Fund(
        ticker="GLD",
        name="SPDR Gold Shares",
        issuer="State Street",
        driver="precious_metal",
        inception=date(2004, 11, 18),
        source=_sa("GLD"),
        corroboration=(
            "https://en.wikipedia.org/wiki/SPDR_Gold_Shares — listed "
            "November 2004 on the NYSE as streetTRACKS Gold Shares; "
            "moved to NYSE Arca 2007-12-13. Matches the inception "
            "already probed in portfolio/sleeves.py."
        ),
    ),
    Fund(
        ticker="SLV",
        name="iShares Silver Trust",
        issuer="BlackRock",
        driver="precious_metal",
        inception=date(2006, 4, 21),
        source=_sa("SLV"),
        note="single-sourced; iShares refuses automated reads (HTTP 403)",
    ),
    # -- Broad commodity -------------------------------------------
    Fund(
        ticker="DBC",
        name="Invesco DB Commodity Index Tracking Fund",
        issuer="Invesco",
        driver="commodity",
        inception=date(2006, 2, 6),
        source=_sa("DBC"),
        corroboration=(
            "the source states 2006-02-03, a Friday; portfolio/"
            "sleeves.py carries 2006-02-06 from a live price probe. "
            "The later date is recorded because a stated inception is "
            "the seed-and-price date and the first traded bar can "
            "follow it — being three sessions late costs nothing, "
            "being three sessions early is lookahead."
        ),
    ),
    # -- Real estate -----------------------------------------------
    Fund(
        ticker="VNQ",
        name="Vanguard Real Estate ETF",
        issuer="Vanguard",
        driver="real_estate",
        inception=date(2004, 9, 23),
        source=_sa("VNQ"),
        note=(
            "labelled real estate but correlates with US equity; see "
            "the concentration note in the module docstring"
        ),
    ),
)


UNIVERSE_TICKERS: frozenset[str] = frozenset(f.ticker for f in UNIVERSE)

_BY_TICKER: dict[str, Fund] = {f.ticker: f for f in UNIVERSE}

#: The date the last name lists, and therefore the first date on which
#: the panel is rectangular. Derived rather than typed, so it cannot
#: drift away from the table above.
FULL_PANEL_DATE: date = max(f.inception for f in UNIVERSE)

SAMPLE_START_DATE: date = date.fromisoformat(SAMPLE_START)

#: How many names a date needs before a cross-sectional percentile is
#: worth computing. A prior, not a fitted number: a rank among eight
#: names moves in steps of an eighth and is mostly a statement about
#: how many names there were, whereas twenty gives percentiles that
#: survive one name going missing. Nothing was tried at other values.
CROSS_SECTION_FLOOR: int = 20


def fund(ticker: str) -> Fund:
    """One entry, or a raise naming what the universe actually holds."""
    key = str(ticker).strip().upper()
    entry = _BY_TICKER.get(key)
    if entry is None:
        raise UniverseError(
            f"{key!r} is not in this universe. It holds "
            f"{sorted(UNIVERSE_TICKERS)}. Adding a name here means "
            f"looking its inception up and recording the source — a "
            f"symbol with a guessed start date is how a fund gets ranked "
            f"in a cross-section it could not have been in."
        )
    return entry


def available_on(day: date | datetime | str) -> tuple[str, ...]:
    """The tickers that existed on `day`, sorted.

    The only sanctioned way to ask. A caller that instead reads which
    columns of a price panel are non-null on a date gets the same
    answer most of the time and a silently different one whenever the
    vendor has a hole, which is exactly the case where the difference
    matters.
    """
    when = _as_date(day)
    return tuple(sorted(f.ticker for f in UNIVERSE if f.inception <= when))


def by_driver() -> dict[str, tuple[str, ...]]:
    """Tickers grouped by return driver, each group sorted."""
    out: dict[str, list[str]] = {d: [] for d in sorted(DRIVERS)}
    for f in UNIVERSE:
        out[f.driver].append(f.ticker)
    return {d: tuple(sorted(t)) for d, t in out.items() if t}


def first_date_with(n: int) -> date:
    """The earliest date on which at least `n` names existed.

    The nth smallest inception, which is exact and needs no calendar.
    Used to state the sample start rather than to enforce it — a run
    that wants a wider cross-section starts later, and this is how it
    finds out how much later.
    """
    if not 1 <= n <= len(UNIVERSE):
        raise UniverseError(
            f"n must be between 1 and {len(UNIVERSE)}, got {n}. There is "
            f"no date on which this universe held {n} names."
        )
    return sorted(f.inception for f in UNIVERSE)[n - 1]


def inception_table() -> pd.DataFrame:
    """The whole roster as a frame, for a report to print verbatim.

    Carries the source column on purpose. A universe table published
    without the provenance of its dates asks the reader to take the
    hardest-to-check numbers in the study on trust.
    """
    rows = [
        {
            "ticker": f.ticker,
            "name": f.name,
            "issuer": f.issuer,
            "driver": f.driver,
            "inception": pd.Timestamp(f.inception),
            "source": f.source,
            "corroboration": f.corroboration,
            "note": f.note,
        }
        for f in UNIVERSE
    ]
    out = pd.DataFrame(rows)
    return out.sort_values(["driver", "inception", "ticker"]).reset_index(drop=True)


def verify_against_prices(
    prices: pd.DataFrame,
    *,
    key: str = "ticker",
    tolerance_days: int = 5,
) -> pd.DataFrame:
    """Check every asserted inception against the first bar actually served.

    This is the check the Tiingo metadata endpoint was meant to give
    and could not — it answered 429 to all twenty-eight symbols while
    this file was being written — so it is made here instead, against
    the pull the study will really run on. Cheap, and it catches the
    two failures that a hand-typed date produces:

      * `data_precedes_inception`: the vendor served bars BEFORE the
        date recorded here. Our date is wrong and we have been throwing
        away real history. Conservative, but wrong.
      * `data_starts_late`: the first bar arrives more than
        `tolerance_days` after the recorded inception. This one is the
        dangerous direction — `available_on` would say the fund existed
        and every feature over that stretch would be NaN, so the name
        occupies a slot in the cross-section while contributing nothing
        to it.

    Returns one row per finding and an empty frame when everything
    lines up. Never a verdict, and never a silent pass: a ticker in the
    universe with no rows at all is itself reported, because "the
    vendor served nothing" and "the vendor agreed with us" must not
    reduce to the same empty result.
    """
    need = ["date", key]
    missing = [c for c in need if c not in prices.columns]
    if missing:
        raise UniverseError(
            f"price frame is missing {missing}; got {sorted(prices.columns)}"
        )

    stamps = pd.to_datetime(prices["date"], errors="coerce")
    symbols = prices[key].astype("str")
    first = stamps.groupby(symbols).min()

    rows: list[dict[str, object]] = []
    for entry in UNIVERSE:
        asserted = pd.Timestamp(entry.inception)
        if entry.ticker not in first.index:
            rows.append(
                {
                    "ticker": entry.ticker,
                    "finding": "no_rows",
                    "asserted_inception": asserted,
                    "first_bar": pd.NaT,
                    "gap_days": float("nan"),
                }
            )
            continue

        served = first.loc[entry.ticker]
        gap = float((served - asserted).days)
        if gap < 0:
            finding = "data_precedes_inception"
        elif gap > tolerance_days:
            finding = "data_starts_late"
        else:
            continue
        rows.append(
            {
                "ticker": entry.ticker,
                "finding": finding,
                "asserted_inception": asserted,
                "first_bar": served,
                "gap_days": gap,
            }
        )

    columns = {
        "ticker": "str",
        "finding": "str",
        "asserted_inception": "datetime64[ns]",
        "first_bar": "datetime64[ns]",
        "gap_days": "float64",
    }
    if not rows:
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in columns.items()})
    return pd.DataFrame(rows)[list(columns)].astype(columns)


def _as_date(value: date | datetime | str) -> date:
    """Accept the three things callers actually hold.

    pandas Timestamp subclasses datetime, so it lands in the first
    branch without this module importing pandas to say so — the import
    at the top is for the frame builders, not for this.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise TypeError(f"expected a date, datetime or ISO string, got {type(value)!r}")


def _validate() -> None:
    """Fail at import if the table contradicts itself.

    Loud here because every consumer downstream reads these as facts. A
    duplicate ticker would put one fund in the cross-section twice; an
    inception in the future would silently empty the universe; an
    entry with no source is the exact thing this file promises not to
    contain.
    """
    tickers = [f.ticker for f in UNIVERSE]
    if len(set(tickers)) != len(tickers):
        raise UniverseError(f"duplicate ticker in UNIVERSE: {sorted(tickers)}")

    if not 25 <= len(UNIVERSE) <= 40:
        raise UniverseError(
            f"{len(UNIVERSE)} funds. Below about twenty-five the "
            f"cross-section is too thin for a percentile to mean much; "
            f"above forty this stops being a hand-checked list and the "
            f"selection argument in the docstring stops holding."
        )

    today = date.today()
    for f in UNIVERSE:
        if f.driver not in DRIVERS:
            raise UniverseError(f"{f.ticker}: unknown driver {f.driver!r}")
        if not f.source:
            raise UniverseError(
                f"{f.ticker}: no source for its inception. An unsourced "
                f"date is a recalled date, and a recalled inception is "
                f"how a fund gets into a cross-section it predates."
            )
        if f.inception > today:
            raise UniverseError(
                f"{f.ticker}: inception {f.inception.isoformat()} is in "
                f"the future"
            )
        if f.ticker != f.ticker.strip().upper():
            raise UniverseError(f"{f.ticker!r}: ticker is not canonical")

    if first_date_with(CROSS_SECTION_FLOOR) > SAMPLE_START_DATE:
        raise UniverseError(
            f"the panel does not reach {CROSS_SECTION_FLOOR} names until "
            f"{first_date_with(CROSS_SECTION_FLOOR).isoformat()}, which is "
            f"after the sample start {SAMPLE_START_DATE.isoformat()}. "
            f"Either the sample starts later or the floor comes down, but "
            f"the two cannot be left disagreeing — a cross-sectional rank "
            f"over a handful of names is mostly a count of the names."
        )


_validate()
