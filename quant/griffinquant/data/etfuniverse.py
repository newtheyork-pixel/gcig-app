"""A broad ETF universe from the Tiingo key we already hold, with the
start date of every vehicle written down where a backtest cannot miss
it.

`keyedsleeves.py` reaches the same vendor for nine funds. The nine are
not a limit the free tier imposes — Tiingo's daily endpoint answers for
every US-listed ETF on the same token — so the constraint on widening
was never licence or money. It is politeness, disk, and the one thing
that actually goes wrong when a universe grows: the quiet start date.

Half the funds below launched after 2013. MTUM, QUAL, VLUE and USMV are
2011-2013; COWZ is 2016; XLC is 2018; DBMF 2019; KMLM 2020; CTA 2022. A
panel assembled from today's tickers and handed to a backtest that
begins in 2005 does not fail — it silently begins each name wherever
its data appears, and the result is a study that reports a twenty-year
record while its factor sleeve is really nine years long and its
managed-futures sleeve four. That is the trap this file exists to
close: `resolve_universe` records `first_available` for every ticker
from the vendor's own directory, `universe_as_of` answers which of them
existed on a given day, and `late_arrivals` names the ones a stated
sample start would have to invent.

**What is survivorship-free here, and what is not.**

The universe list is NOT survivorship-free, and the reason is the list
rather than the vendor. Every ticker in `UNIVERSE` was picked in 2026
by someone looking at funds that still trade. Nothing downstream can
detect that; it arrives as a slightly better Sharpe.

The vendor is a different question, and it is measurable rather than a
matter of trust. Tiingo's public ticker directory carries 9,397 rows
typed ETF, of which 2,311 — just under a quarter — end at a date in the
past, and the price endpoint serves their full history: RSX returns
3,957 bars running 2007-04-30 to 2023-01-13, years after VanEck wound
the Russia fund down. So the bias in this panel is entirely ours and is
fixable by widening the list, which is a different and far better
sentence than "the source cannot support it". `DECEASED` is twelve
closed funds carried for exactly that reason, `deceased_evidence`
measures whether each is really served, and `directory_survivorship`
puts a number on the vendor's retention.

Two absences bound the claim, and both are recorded rather than
described. `ABSENT` names real ETFs the directory does not list at all
— GEX, BJK, SCIF, FEU — and `absence_report` re-checks them on every
run so the list cannot rot into a stale complaint. The second is
sharper: **a renamed fund keeps its whole history and loses its old
symbol.** The directory has no RYT, no JKD, no ITE, while RSPT's
coverage starts 2006-11-07, ILCB's 2004-07-02 and SPTI's 2007-05-30.
Those bars printed under tickers this directory will not admit exist,
so a symbol here is today's name for a series, never the name it
traded under on the date of the bar. Anything joining on the string as
of a past date is joining on a fact that was not true then.

**One vendor, one cache entry, on purpose.** This source writes under
the same slug as `keyedsleeves.py`'s Tiingo backend, so the nine sleeve
names are fetched once and read by both. That is safe here and would
not be next door: the separation `keyedsleeves` keeps is between
VENDORS, where a shared entry would make `reconcile_sources` diff a
frame against itself. Same vendor, same endpoint, same parse, same
synthesised id — the two sources cannot disagree about SPY, so pulling
it twice would only be rude.

**The allowlist is extended, never defeated.** `ETFUniverseSource` is a
`KeyedSleeveSource` handed a longer list, and the wall stands exactly
where it stood: a symbol outside the list raises before any HTTP
happens, and the list is ETFs only. The single-name layer stays
structurally unreachable from a free source, which is the whole reason
the mechanism exists — a free adjusted-close feed answers for symbols
that still resolve today, and a single-name universe pulled through one
is survivorship-biased in a way no downstream check can see.

**The free tier meters SYMBOLS, not requests, and that shapes the
pull.** Measured rather than read off a page: the first run returned
bars for fifty-two distinct tickers and answered 429 to the
fifty-third, sixty-one seconds in. An hour later the same loop took
sixty-eight more and stopped again; an hour after that it was refused
on its first request. So the window rolls rather than resetting on the
hour, and the throughput is not a constant — which is why
`FREE_TIER_SYMBOLS_PER_HOUR` is the pessimistic end of what was seen
and not the average.

The practical shape: a 154-name universe is a three-hour job, no pause
between requests can shorten it because the meter counts names, and the
only thing that makes it bearable is the cache. A driver that catches
the 429, waits, and calls the loop again pays nothing for what it
already holds. `pull_universe` raises rather than swallowing it, for
the reason given there — waiting is the caller's decision, and a
coverage table with holes in it is not.

**Terms.** Tiingo's free tier covers all US-listed equities and ETFs
with end-of-day history, and its licence permits internal research and
analysis. It does NOT permit redistribution — the parquet under
`quant/data/` is ours to compute on and not ours to republish, so a
paper built on it may print derived statistics and must not ship the
bars. The directory archive is served openly with no token. Coverage is
end-of-day, updated after each US session; there is no intraday here
and nothing in this file should be read as though there were.
"""

from __future__ import annotations

import io
import time
import zipfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any

import pandas as pd
import requests

from .base import SourceCapabilities, SourceUnavailable
from .keyedsleeves import HISTORY_START, KeyedSleeveSource
from .sleevedata import TickerNotAllowed

if TYPE_CHECKING:
    from .cache import ParquetCache


#: Who we are and where to complain, in every request this file makes.
#: An anonymous client is one a vendor can only defend itself from by
#: blocking an address, which is what a bad afternoon with Yahoo cost
#: us: three hours throttled with no way for anyone to tell us why.
USER_AGENT = "GriffinFund-Research/0.1 (+newtheyork@gmail.com)"

#: The whole supported-ticker list, published openly and needing no
#: token. 786KB zipped, ~108,000 rows, refreshed daily. One request
#: buys the venue, the asset type and the coverage window for every
#: symbol Tiingo serves — which is why nothing below asks the metadata
#: endpoint 142 times for facts that arrive here in a single call.
TIINGO_DIRECTORY_URL = (
    "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip"
)

#: Its own slug: this is a vendor-wide catalogue, not one security's
#: frame, and filing it beside the price entries would put a hundred
#: thousand rows in a directory a reviewer reads per-ticker.
DIRECTORY_SLUG = "tiingo-directory"

#: Deliberately not one of `cache.DEFAULT_TTL_DAYS`' registered names,
#: which means it inherits `UNKNOWN_FRAME_TTL_DAYS` — a one-day life.
#: That is the answer this frame wants rather than an accident: the
#: catalogue gains and loses rows every session, and an entry that
#: never aged out would freeze the survivorship measurement at
#: whichever afternoon it was written.
DIRECTORY_FRAME = "directory"

#: Venues whose fills are real. Anything else — OTC, pink, grey — is
#: out, and not on quality grounds: an ETF quoted on PINK is a foreign
#: line or a wind-down husk, and a backtest filling against it is
#: trading somewhere it could not have traded.
MAJOR_VENUES: frozenset[str] = frozenset(
    {"NYSE", "NASDAQ", "NYSEARCA", "BATS", "NYSEMKT"}
)

#: Vendor venue strings onto `config.ALLOWED_EXCHANGES`. Spelled out
#: again rather than imported from `keyedsleeves`, for the reason that
#: file gives about its own duplicated helpers: a private name is not a
#: contract, and a coupling the next editor cannot see is worse than
#: nine repeated lines. An unmapped venue passes through under its own
#: name — visibly unrecognised beats quietly wrong.
_VENUES = {
    "NYSE ARCA": "NYSEARCA",
    "NYSEARCA": "NYSEARCA",
    "ARCA": "NYSEARCA",
    "PCX": "NYSEARCA",
    "NASDAQ": "NASDAQ",
    "NMS": "NASDAQ",
    "NYSE": "NYSE",
    "AMEX": "NYSEMKT",
    "NYSE MKT": "NYSEMKT",
    "BATS": "BATS",
}

#: What the directory calls a fund. Read as corroboration and never as
#: proof — see `resolve_universe`, which explains what else is filed
#: under this string.
ETF_ASSET_TYPE = "ETF"

#: Everything here is a US dollar line. A CNY or AUD row under a
#: familiar ticker is a foreign listing, and mixing one into a dollar
#: panel produces a return series carrying a currency bet nobody took.
PRICE_CURRENCY = "USD"

#: How long after a fund's last bar we stop calling it listed. Long
#: enough to survive a quiet holiday week and a vendor running a day
#: behind; short enough that a fund wound up last quarter is not still
#: reported as trading.
STALE_AFTER_DAYS = 30

#: Retried statuses and the pacing, matching `keyedsleeves`. A 404 is
#: an answer and is never retried.
RETRY_STATUSES = frozenset({429, *range(500, 512)})
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_CAP_SECONDS = 30.0

#: On top of the half-second the parent already paces at. A hundred and
#: forty names is a far bigger burst than nine, and the pull is cached,
#: so the cost of being slow is paid once and the cost of being rude is
#: paid by everyone who shares the address afterwards.
PULL_PAUSE_SECONDS = 1.0

#: A planning figure, and deliberately the pessimistic end of what was
#: measured rather than the average of it. Three runs an hour apart got
#: 52, 68 and 0 fresh symbols before a 429 — so the meter is a rolling
#: window rather than a clock-hour bucket, and a batch that succeeds
#: fully can leave the next one refused on its first request. Fifty is
#: the number to schedule against; anything above it is a bonus, and
#: treating the best observation as the limit is how a nightly job
#: starts failing on the one night somebody is not watching.
#:
#: What matters more than the exact figure: the meter counts SYMBOLS,
#: so no pause between requests buys another one. Slowing down does not
#: help. Only waiting does, and only the cache makes waiting cheap.
FREE_TIER_SYMBOLS_PER_HOUR = 50


# -- the universe ---------------------------------------------------------


GROUP_BROAD_US = "broad_us_equity"
GROUP_SECTOR = "us_sector"
GROUP_INTERNATIONAL = "international_equity"
GROUP_FIXED_INCOME = "fixed_income"
GROUP_REAL_ASSET = "real_asset"
GROUP_FACTOR = "factor_style"
GROUP_MANAGED_FUTURES = "managed_futures"
GROUP_CURRENCY = "currency"

GROUPS: tuple[str, ...] = (
    GROUP_BROAD_US,
    GROUP_SECTOR,
    GROUP_INTERNATIONAL,
    GROUP_FIXED_INCOME,
    GROUP_REAL_ASSET,
    GROUP_FACTOR,
    GROUP_MANAGED_FUTURES,
    GROUP_CURRENCY,
)


@dataclass(frozen=True)
class Etf:
    """One vehicle in the list, and which shelf it sits on.

    No fund name. A name typed in here would be ours, would drift from
    the vendor's spelling the first time a sponsor rebrands, and would
    invite a join on a string nobody validated — the same argument
    `keyedsleeves` makes for falling back to the ticker rather than to
    a plausible invention. Names come from the vendor, through
    `security_master`, or not at all.
    """

    ticker: str
    group: str
    note: str = ""


# The list. Every entry was checked against the vendor's directory
# before it was written down — present, typed ETF, priced in dollars,
# on a venue we would trade — and the check is re-run by
# `resolve_universe` on every use, because a hand-verified list is only
# as good as its last verification.
#
# It is a list of LIVING funds, and that is the bias. See the module
# docstring: the fix is not a caveat, it is `DECEASED` and a wider list.
UNIVERSE: tuple[Etf, ...] = (
    # Broad US equity and its slices. SPY, QQQ, IWM and DIA are the
    # four series with real history — 1993, 1999, 2000, 1998 — and
    # everything else in this block is a cheaper or differently-weighted
    # wrapper on the same exposure. RSP is here for one specific
    # reason: it is the equal-weight twin of SPY, so the pair is a clean
    # read on how much of a year belonged to the largest names, which
    # no single cap-weighted series can answer.
    Etf("SPY", GROUP_BROAD_US, "S&P 500, and the longest ETF tape there is"),
    Etf("IVV", GROUP_BROAD_US),
    Etf("VOO", GROUP_BROAD_US, "lists 2010; not a substitute for SPY pre-2010"),
    Etf("QQQ", GROUP_BROAD_US, "traded as QQQQ 2004-2011; see the rename note"),
    Etf("IWM", GROUP_BROAD_US, "Russell 2000"),
    Etf("RSP", GROUP_BROAD_US, "equal weight; the concentration read"),
    Etf("VTI", GROUP_BROAD_US, "total market"),
    Etf("DIA", GROUP_BROAD_US, "price-weighted, which makes it its own thing"),
    Etf("MDY", GROUP_BROAD_US, "mid cap, 1995"),
    Etf("IJH", GROUP_BROAD_US),
    Etf("IJR", GROUP_BROAD_US),
    Etf("VTV", GROUP_BROAD_US, "value"),
    Etf("VUG", GROUP_BROAD_US, "growth"),
    Etf("IWD", GROUP_BROAD_US, "Russell 1000 value"),
    Etf("IWF", GROUP_BROAD_US, "Russell 1000 growth"),
    Etf("IWN", GROUP_BROAD_US, "Russell 2000 value"),
    Etf("IWO", GROUP_BROAD_US, "Russell 2000 growth"),
    Etf("IWS", GROUP_BROAD_US),
    Etf("IWP", GROUP_BROAD_US),
    Etf("SPYV", GROUP_BROAD_US),
    Etf("SPYG", GROUP_BROAD_US),
    # US sectors. The nine original SPDRs date to December 1998 and are
    # the only sector series that reach back through two full cycles.
    # XLRE and XLC are carve-outs, not launches: real estate left XLF in
    # 2015 and communications was assembled out of XLK and XLY in 2018,
    # so a sector panel that treats all eleven as one history has three
    # series with a discontinuity inside them and eight without.
    Etf("XLB", GROUP_SECTOR),
    Etf("XLE", GROUP_SECTOR),
    Etf("XLF", GROUP_SECTOR, "real estate carved out into XLRE, Oct 2015"),
    Etf("XLI", GROUP_SECTOR),
    Etf("XLK", GROUP_SECTOR, "contributed names to XLC, Jun 2018"),
    Etf("XLP", GROUP_SECTOR),
    Etf("XLU", GROUP_SECTOR),
    Etf("XLV", GROUP_SECTOR),
    Etf("XLY", GROUP_SECTOR, "contributed names to XLC, Jun 2018"),
    Etf("XLRE", GROUP_SECTOR, "2015 carve-out from XLF, not a new exposure"),
    Etf("XLC", GROUP_SECTOR, "2018 carve-out from XLK and XLY"),
    # Equal-weight sector twins. Each one's history begins 2006-11-07
    # under a ticker beginning RY — see `ABSENT`. Held because the
    # cap-weighted and equal-weight versions of one sector diverge
    # exactly when a sector has become one stock, which is the thing a
    # sector series is least able to tell you about itself.
    Etf("RSPT", GROUP_SECTOR, "traded as RYT until the RSP* renaming"),
    Etf("RSPF", GROUP_SECTOR, "traded as RYF"),
    Etf("RSPH", GROUP_SECTOR, "traded as RYH"),
    Etf("RSPN", GROUP_SECTOR, "traded as RGI"),
    Etf("RSPD", GROUP_SECTOR, "traded as RCD"),
    Etf("RSPS", GROUP_SECTOR, "traded as RHS"),
    Etf("RSPG", GROUP_SECTOR, "traded as RYE"),
    Etf("RSPU", GROUP_SECTOR, "traded as RYU"),
    Etf("RSPM", GROUP_SECTOR, "traded as RTM"),
    Etf("RSPR", GROUP_SECTOR, "real estate; lists 2015, like XLRE"),
    # International. EFA and EEM are the two that matter for a long
    # sample; the single-country iShares from 1996 are older still and
    # are the only way to see 1997-98 Asia in an ETF at all. Every line
    # here carries a currency leg, and a dollar-based book holding one
    # is making a currency bet whether or not anybody decided to.
    Etf("EFA", GROUP_INTERNATIONAL, "developed ex-US; unhedged"),
    Etf("EEM", GROUP_INTERNATIONAL, "emerging; unhedged"),
    Etf("VEA", GROUP_INTERNATIONAL),
    Etf("VWO", GROUP_INTERNATIONAL),
    Etf("IEFA", GROUP_INTERNATIONAL, "the cheap successor to EFA, from 2012"),
    Etf("IEMG", GROUP_INTERNATIONAL, "the cheap successor to EEM, from 2012"),
    Etf("ACWI", GROUP_INTERNATIONAL),
    Etf("VXUS", GROUP_INTERNATIONAL),
    Etf("VGK", GROUP_INTERNATIONAL),
    Etf("VPL", GROUP_INTERNATIONAL),
    Etf("EZU", GROUP_INTERNATIONAL, "euro zone"),
    Etf("EWJ", GROUP_INTERNATIONAL, "Japan, 1996"),
    Etf("EWZ", GROUP_INTERNATIONAL, "Brazil"),
    Etf("EWG", GROUP_INTERNATIONAL, "Germany, 1996"),
    Etf("EWU", GROUP_INTERNATIONAL, "United Kingdom, 1996"),
    Etf("EWC", GROUP_INTERNATIONAL, "Canada, 1996"),
    Etf("EWA", GROUP_INTERNATIONAL, "Australia, 1996"),
    Etf("EWH", GROUP_INTERNATIONAL, "Hong Kong, 1996"),
    Etf("EWW", GROUP_INTERNATIONAL, "Mexico, 1996"),
    Etf("EWY", GROUP_INTERNATIONAL, "South Korea"),
    Etf("EWT", GROUP_INTERNATIONAL, "Taiwan"),
    Etf("FXI", GROUP_INTERNATIONAL, "China large cap"),
    Etf("INDA", GROUP_INTERNATIONAL, "India; lists 2012"),
    Etf("SCZ", GROUP_INTERNATIONAL, "developed ex-US small cap"),
    # Fixed income, across the curve and down the credit spectrum. The
    # duration ladder SHY / IEI / IEF / TLH / TLT all begins in the same
    # week of July 2002 or January 2007, which makes it the one place a
    # curve trade can be studied without splicing. Every return here is
    # a TOTAL return: TLT returned -2.6% on price and +105.8% with
    # coupons over 2004-2026, so a price series is not an approximation
    # of a bond sleeve, it is the deletion of one.
    Etf("SHY", GROUP_FIXED_INCOME, "1-3y Treasury"),
    Etf("SHV", GROUP_FIXED_INCOME, "under 1y; the closest thing to cash"),
    Etf("IEI", GROUP_FIXED_INCOME, "3-7y Treasury"),
    Etf("IEF", GROUP_FIXED_INCOME, "7-10y Treasury"),
    Etf("TLH", GROUP_FIXED_INCOME, "10-20y Treasury"),
    Etf("TLT", GROUP_FIXED_INCOME, "20y+ Treasury"),
    Etf("TIP", GROUP_FIXED_INCOME, "inflation-linked"),
    Etf("SCHP", GROUP_FIXED_INCOME),
    Etf("STIP", GROUP_FIXED_INCOME, "short-dated linkers"),
    Etf("VTIP", GROUP_FIXED_INCOME),
    Etf("LQD", GROUP_FIXED_INCOME, "investment grade credit"),
    Etf("VCIT", GROUP_FIXED_INCOME),
    Etf("VCSH", GROUP_FIXED_INCOME),
    Etf("IGSB", GROUP_FIXED_INCOME),
    Etf("HYG", GROUP_FIXED_INCOME, "high yield; equity-like in a crisis"),
    Etf("JNK", GROUP_FIXED_INCOME),
    Etf("SJNK", GROUP_FIXED_INCOME),
    Etf("AGG", GROUP_FIXED_INCOME, "aggregate"),
    Etf("BND", GROUP_FIXED_INCOME),
    Etf("BNDX", GROUP_FIXED_INCOME, "ex-US aggregate, dollar-hedged"),
    Etf("MUB", GROUP_FIXED_INCOME, "municipals; the after-tax series differs"),
    Etf("EMB", GROUP_FIXED_INCOME, "dollar EM sovereign"),
    Etf("BKLN", GROUP_FIXED_INCOME, "senior loans; floating, and illiquid in 2020"),
    Etf("FLOT", GROUP_FIXED_INCOME, "floating-rate IG"),
    # Real assets. Note what these actually are: GLD, SLV, IAU, PPLT and
    # PALL are grantor trusts holding metal, and DBC, USO, UNG, PDBC,
    # CPER, CORN and WEAT are commodity pools holding futures. Both are
    # filed as ETF by the vendor and neither is a 1940-Act fund. The
    # futures ones are roll-return instruments at least as much as spot
    # ones — in contango USO bleeds while oil goes nowhere — and reading
    # any of them as a spot price is the standard mistake.
    Etf("GLD", GROUP_REAL_ASSET, "grantor trust, physical gold"),
    Etf("IAU", GROUP_REAL_ASSET, "grantor trust, physical gold"),
    Etf("SLV", GROUP_REAL_ASSET, "grantor trust, physical silver"),
    Etf("PPLT", GROUP_REAL_ASSET, "grantor trust, physical platinum"),
    Etf("PALL", GROUP_REAL_ASSET, "grantor trust, physical palladium"),
    Etf("DBC", GROUP_REAL_ASSET, "commodity pool; roll return, not spot"),
    Etf("PDBC", GROUP_REAL_ASSET, "commodity pool, no K-1"),
    Etf("USO", GROUP_REAL_ASSET, "oil futures; broke its own mechanism in 2020"),
    Etf("UNG", GROUP_REAL_ASSET, "gas futures; a long contango study"),
    Etf("CPER", GROUP_REAL_ASSET, "copper futures"),
    Etf("CORN", GROUP_REAL_ASSET, "corn futures"),
    Etf("WEAT", GROUP_REAL_ASSET, "wheat futures"),
    Etf("GDX", GROUP_REAL_ASSET, "gold miners; equity beta, not metal"),
    Etf("GDXJ", GROUP_REAL_ASSET),
    Etf("XME", GROUP_REAL_ASSET, "metals and mining equities"),
    Etf("SLX", GROUP_REAL_ASSET, "steel equities"),
    Etf("VNQ", GROUP_REAL_ASSET, "US REITs"),
    Etf("IYR", GROUP_REAL_ASSET, "US REITs, 2000"),
    Etf("RWR", GROUP_REAL_ASSET),
    Etf("SCHH", GROUP_REAL_ASSET),
    # Factor and style. This block is where the late-start trap lives:
    # the named factor funds are 2011-2016, so a factor study on this
    # panel has roughly a decade, not two, and one of those decades is
    # the one in which value did badly. PRF (2005) and SPHQ (2005) are
    # the only pre-crisis lines here and they are worth their weight for
    # exactly that reason.
    Etf("MTUM", GROUP_FACTOR, "momentum; lists 2013"),
    Etf("QUAL", GROUP_FACTOR, "quality; lists 2013"),
    Etf("VLUE", GROUP_FACTOR, "value; lists 2013"),
    Etf("USMV", GROUP_FACTOR, "minimum volatility; lists 2011"),
    Etf("SIZE", GROUP_FACTOR, "size; lists 2013"),
    Etf("SPHQ", GROUP_FACTOR, "quality, 2005 — one of two pre-crisis lines"),
    Etf("SPLV", GROUP_FACTOR, "low volatility; lists 2011"),
    Etf("PRF", GROUP_FACTOR, "fundamental weight, 2005"),
    Etf("COWZ", GROUP_FACTOR, "free cash flow yield; lists 2016"),
    Etf("MOAT", GROUP_FACTOR, "wide moat; lists 2012"),
    Etf("QUS", GROUP_FACTOR, "multi-factor; lists 2015"),
    Etf("FNDX", GROUP_FACTOR),
    Etf("VYM", GROUP_FACTOR, "high dividend yield"),
    Etf("VBR", GROUP_FACTOR, "small value, 2004"),
    Etf("VIG", GROUP_FACTOR, "dividend growth, 2006"),
    Etf("SCHD", GROUP_FACTOR),
    Etf("SDY", GROUP_FACTOR, "dividend aristocrats, 2005"),
    Etf("NOBL", GROUP_FACTOR),
    Etf("DVY", GROUP_FACTOR, "dividend, 2003"),
    # Managed futures and multi-asset alternatives. The shortest block
    # in the file and the one most likely to be over-read: CTA has four
    # years, KMLM six, DBMF seven. There is no ETF-wrapped trend series
    # covering 2008, and a study that needs one has to say so rather
    # than start in 2019 and call it a record.
    Etf("DBMF", GROUP_MANAGED_FUTURES, "managed futures replication; 2019"),
    Etf("KMLM", GROUP_MANAGED_FUTURES, "2020"),
    Etf("CTA", GROUP_MANAGED_FUTURES, "2022 — four years is not a track record"),
    Etf("FMF", GROUP_MANAGED_FUTURES, "2013, the longest ETF trend line here"),
    Etf("WTMF", GROUP_MANAGED_FUTURES, "2011"),
    Etf("RLY", GROUP_MANAGED_FUTURES, "multi-asset real return; 2012"),
    # Currency. Grantor trusts holding deposits, so the return is the
    # spot move plus whatever the deposit earns net of fee — which in
    # the ZIRP years was negative and is not a tracking error.
    Etf("UUP", GROUP_CURRENCY, "long dollar index"),
    Etf("UDN", GROUP_CURRENCY, "short dollar index"),
    Etf("FXE", GROUP_CURRENCY, "euro, 2005"),
    Etf("FXY", GROUP_CURRENCY, "yen"),
    Etf("FXB", GROUP_CURRENCY, "sterling"),
    Etf("FXF", GROUP_CURRENCY, "Swiss franc"),
    Etf("FXA", GROUP_CURRENCY, "Australian dollar"),
)


#: Funds that closed, kept on purpose. Each was verified present in the
#: directory with a terminal end date, and each is a real ETF rather
#: than a leveraged or inverse note — `config.HARD_EXCLUDED_CATEGORIES`
#: rules those out at every layer, and a survivorship demonstration
#: built from products the strategy could never hold would prove
#: nothing about the strategy.
#:
#: These are NOT in `UNIVERSE`. A dead fund in a live panel would be
#: held to zero weight by every screen and would quietly widen the
#: cross-section; its job here is evidential, and `deceased_evidence`
#: is where it does that job.
DECEASED: tuple[Etf, ...] = (
    Etf("RSX", GROUP_INTERNATIONAL, "VanEck Russia; halted 2022, wound up"),
    Etf("ERUS", GROUP_INTERNATIONAL, "iShares MSCI Russia; same event"),
    Etf("ADRE", GROUP_INTERNATIONAL, "BLDRS Emerging Markets 50 ADR"),
    Etf("FRN", GROUP_INTERNATIONAL, "Invesco Frontier Markets"),
    Etf("PXR", GROUP_INTERNATIONAL, "Invesco Emerging Markets Infrastructure"),
    Etf("EGPT", GROUP_INTERNATIONAL, "VanEck Egypt"),
    Etf("GAF", GROUP_INTERNATIONAL, "SPDR S&P Emerging Middle East & Africa"),
    Etf("KOL", GROUP_REAL_ASSET, "VanEck Coal"),
    Etf("PSAU", GROUP_REAL_ASSET, "Invesco Global Gold & Precious Metals"),
    Etf("FXCH", GROUP_CURRENCY, "CurrencyShares Chinese Renminbi"),
    Etf("FXS", GROUP_CURRENCY, "CurrencyShares Swedish Krona"),
    Etf("FXSG", GROUP_CURRENCY, "CurrencyShares Singapore Dollar"),
)


@dataclass(frozen=True)
class Absent:
    """A real ETF ticker the directory does not carry, and why.

    `fate` is our identification and `successor` is our reading of where
    the assets went. The MEASUREMENT is the absence, which
    `absence_report` re-checks against a live directory every time it
    runs — so this table cannot rot into a complaint about something the
    vendor fixed years ago.
    """

    ticker: str
    fate: str
    successor: str | None
    note: str


#: What the directory drops, in the two shapes it drops things.
#:
#: The renames are the sharper finding, and they are not a data quality
#: problem — the history is all there, filed under the symbol the fund
#: wears today. The problem is that a backtest standing in 2015 and
#: asking for RYT gets nothing, while asking for RSPT gets bars from
#: 2006 under a ticker that would not exist for another eight years.
#: Every string in `UNIVERSE` is today's name for a series.
#:
#: The closures are the honest limit on the survivorship claim: these
#: four traded, they are gone, and Tiingo serves no bars for them at
#: all. Whatever `directory_survivorship` reports about retention, it
#: is retention of most dead funds and not of all of them.
ABSENT: tuple[Absent, ...] = (
    Absent("RYT", "renamed", "RSPT", "Invesco S&P 500 Equal Weight Technology"),
    Absent("RYF", "renamed", "RSPF", "Invesco S&P 500 Equal Weight Financials"),
    Absent("RYE", "renamed", "RSPG", "Invesco S&P 500 Equal Weight Energy"),
    Absent("RYU", "renamed", "RSPU", "Invesco S&P 500 Equal Weight Utilities"),
    Absent("JKD", "renamed", "ILCB", "iShares Morningstar Large-Cap"),
    Absent("JKE", "renamed", "ILCG", "iShares Morningstar Large-Cap Growth"),
    Absent("JKF", "renamed", "ILCV", "iShares Morningstar Large-Cap Value"),
    Absent("JKJ", "renamed", "ISCB", "iShares Morningstar Small-Cap"),
    Absent("ITE", "renamed", "SPTI", "SPDR intermediate Treasury"),
    Absent("QQQQ", "renamed", "QQQ", "the Nasdaq-100 trust's 2004-2011 symbol"),
    Absent("GEX", "closed", None, "VanEck Global Alternative Energy"),
    Absent("BJK", "closed", None, "VanEck Gaming"),
    Absent("SCIF", "closed", None, "VanEck India Small-Cap"),
    Absent("FEU", "closed", None, "SPDR STOXX Europe 50"),
)


UNIVERSE_TICKERS: frozenset[str] = frozenset(e.ticker for e in UNIVERSE)
DECEASED_TICKERS: frozenset[str] = frozenset(e.ticker for e in DECEASED)

#: The universe plus its dead. Offered for the study that wants the
#: honest cross-section rather than the tradable one, and named
#: separately so nothing gets it by accident: a panel carrying twelve
#: funds that stopped trading is right for measuring bias and wrong for
#: sizing a position.
UNIVERSE_WITH_DECEASED: frozenset[str] = UNIVERSE_TICKERS | DECEASED_TICKERS

_BY_TICKER: dict[str, Etf] = {e.ticker: e for e in (*UNIVERSE, *DECEASED)}


class UniverseNotResolved(ValueError):
    """The hand-written list and the vendor's directory disagree.

    Loud rather than a filtered-down universe. A ticker that silently
    dropped out because the vendor retyped it would shrink the panel
    without shrinking anything that reads the panel, and a missing name
    arrives downstream as a slightly cleaner cross-section.
    """


def _validate_universe() -> None:
    """Fail at import if the tables above contradict themselves."""
    seen: set[str] = set()
    for entry in (*UNIVERSE, *DECEASED):
        symbol = entry.ticker
        if symbol != symbol.strip().upper() or not symbol:
            raise ValueError(f"ticker {entry.ticker!r} is not a bare symbol")
        if symbol in seen:
            raise ValueError(
                f"{symbol} appears twice; a duplicate would be pulled twice "
                f"and counted twice in every coverage total below"
            )
        seen.add(symbol)
        if entry.group not in GROUPS:
            raise ValueError(f"{symbol}: unknown group {entry.group!r}")

    overlap = UNIVERSE_TICKERS & DECEASED_TICKERS
    if overlap:
        raise ValueError(
            f"{sorted(overlap)} is both live and deceased. A dead fund in "
            f"the live list would be held at zero weight by every screen "
            f"and would still widen the cross-section it was measured on."
        )

    absent = {a.ticker for a in ABSENT}
    clash = absent & (UNIVERSE_TICKERS | DECEASED_TICKERS)
    if clash:
        raise ValueError(
            f"{sorted(clash)} is recorded as absent from the directory and "
            f"also asked for; one of the two statements is stale"
        )
    for a in ABSENT:
        if a.fate not in ("renamed", "closed"):
            raise ValueError(f"{a.ticker}: unknown fate {a.fate!r}")
        if a.fate == "renamed" and not a.successor:
            raise ValueError(f"{a.ticker}: renamed to nothing")


_validate_universe()


# -- the directory --------------------------------------------------------


_DIRECTORY_DTYPES: dict[str, str] = {
    "ticker": "str",
    "exchange": "str",
    "asset_type": "str",
    "currency": "str",
    "start_date": "datetime64[ns]",
    "end_date": "datetime64[ns]",
}


def fetch_directory(
    *,
    cache: "ParquetCache | None" = None,
    session: requests.Session | None = None,
    clock: Callable[[], datetime] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = 120.0,
    url: str = TIINGO_DIRECTORY_URL,
) -> pd.DataFrame:
    """Tiingo's whole supported-ticker list, keyless, in one request.

    Columns: `ticker`, `exchange`, `asset_type`, `currency`,
    `start_date`, `end_date`. About 108,000 rows, of which some 9,400
    are typed ETF.

    This is the cheapest honest thing in the file. It answers "does this
    symbol resolve", "is it a fund", "is it priced in dollars" and "what
    is the first date there is data" for every ticker at once, which is
    why nothing below asks the per-symbol metadata endpoint a hundred
    and forty times for facts that arrive here in a single call. It also
    carries the funds that STOPPED — an `end_date` in the past is the
    vendor telling us a name died — and that is what makes the
    survivorship question measurable rather than a matter of trust.

    Every failure raises. An unreachable vendor, an archive with no CSV
    in it, a CSV with no rows: none of those is an empty catalogue, and
    a catalogue reported as empty would make `resolve_universe` declare
    all 142 tickers unknown and `directory_survivorship` report that no
    ETF has ever closed.
    """
    def loader() -> pd.DataFrame:
        return _load_directory(
            url=url, session=session, sleep=sleep, timeout=timeout
        )

    if cache is None:
        return loader()

    now = (clock or (lambda: datetime.now(timezone.utc)))()
    key = cache.key(DIRECTORY_SLUG, DIRECTORY_FRAME, url=url)
    return cache.get_or_load(key, loader, stamped=now, now=now)


def _load_directory(
    *,
    url: str,
    session: requests.Session | None,
    sleep: Callable[[float], None],
    timeout: float,
) -> pd.DataFrame:
    body = _get_bytes(url, session=session, sleep=sleep, timeout=timeout)

    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
        names = [n for n in archive.namelist() if n.lower().endswith(".csv")]
        if not names:
            raise SourceUnavailable(
                f"the Tiingo ticker archive at {url} holds no CSV — "
                f"{archive.namelist()}. Not an empty catalogue: a catalogue "
                f"we could not open."
            )
        raw = archive.read(names[0]).decode("utf-8", errors="replace")
    except zipfile.BadZipFile as exc:
        raise SourceUnavailable(
            f"the Tiingo ticker archive at {url} is not a readable zip "
            f"({exc}). An error page served with a 200 looks exactly like "
            f"this, and reading it as an empty catalogue would report every "
            f"ticker we hold as unknown to the vendor."
        ) from exc

    frame = pd.read_csv(io.StringIO(raw), dtype=str, keep_default_na=False)
    wanted = {
        "ticker": "ticker",
        "exchange": "exchange",
        "assetType": "asset_type",
        "priceCurrency": "currency",
        "startDate": "start_date",
        "endDate": "end_date",
    }
    missing = [c for c in wanted if c not in frame.columns]
    if missing:
        raise SourceUnavailable(
            f"the Tiingo ticker CSV is missing column(s) {missing}; got "
            f"{sorted(frame.columns)}. The vendor changed the shape of this "
            f"file and every claim below about coverage is now unverified."
        )
    if frame.empty:
        raise SourceUnavailable(
            f"the Tiingo ticker CSV at {url} has a header and no rows. "
            f"That is an outage wearing a catalogue's clothes."
        )

    out = pd.DataFrame(
        {
            "ticker": frame["ticker"].astype("str").str.strip().str.upper(),
            "exchange": frame["exchange"].astype("str").map(_venue),
            "asset_type": frame["assetType"].astype("str").str.strip(),
            "currency": frame["priceCurrency"].astype("str").str.strip().str.upper(),
            # Blank where the vendor has no coverage window, which is a
            # real state in this file and must stay distinguishable from
            # a date. NaT reads as "unknown"; a fabricated 1970 would
            # read as "listed before anything else here".
            "start_date": pd.to_datetime(frame["startDate"], errors="coerce"),
            "end_date": pd.to_datetime(frame["endDate"], errors="coerce"),
        }
    )
    out = out.loc[out["ticker"] != ""].reset_index(drop=True)
    if out.empty:
        raise SourceUnavailable(
            f"the Tiingo ticker CSV at {url} carried rows but no symbols."
        )
    return _typed(out, _DIRECTORY_DTYPES)


def _get_bytes(
    url: str,
    *,
    session: requests.Session | None,
    sleep: Callable[[float], None],
    timeout: float,
) -> bytes:
    """One GET with a polite retry, or a raise that names the outage."""
    http = session or requests.Session()
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    last = "no attempt was made"

    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            sleep(min(BACKOFF_BASE_SECONDS * 2 ** (attempt - 1), BACKOFF_CAP_SECONDS))
        try:
            response = http.get(url, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
            continue

        if response.status_code == 200:
            return response.content
        if response.status_code in RETRY_STATUSES:
            last = f"HTTP {response.status_code}"
            continue
        raise SourceUnavailable(
            f"{url} returned HTTP {response.status_code}. This is our "
            f"outage or a moved file, never an empty catalogue."
        )

    raise SourceUnavailable(
        f"{url} unreachable after {MAX_ATTEMPTS} attempts. Last: {last}."
    )


def directory_survivorship(
    directory: pd.DataFrame, *, asof: date | None = None
) -> dict[str, Any]:
    """How much of the vendor's dead is still on the shelf.

    The one number that decides whether widening `UNIVERSE` could ever
    produce a survivorship-free panel. If the catalogue held only living
    funds, no list drawn from it could be unbiased and the honest answer
    would be to stop. It does not: a quarter of the ETF rows end at a
    date in the past, and `deceased_evidence` confirms the price
    endpoint still serves their bars.

    Counts ETF rows priced in dollars on a venue we would trade, so the
    figure describes the shelf this project could actually shop from
    rather than the whole file — which carries foreign lines, OTC husks
    and, as `resolve_universe` explains, a good deal that is not a fund
    at all.
    """
    day = asof or date.today()
    cutoff = pd.Timestamp(day) - pd.Timedelta(days=STALE_AFTER_DAYS)

    shelf = directory.loc[
        (directory["asset_type"] == ETF_ASSET_TYPE)
        & (directory["currency"] == PRICE_CURRENCY)
        & directory["exchange"].isin(MAJOR_VENUES)
    ]
    ended = shelf["end_date"]
    dead = int((ended.notna() & (ended < cutoff)).sum())
    undated = int(ended.isna().sum())
    total = int(len(shelf))
    return {
        "asof": day,
        "etf_rows": total,
        "still_listed": total - dead - undated,
        "ended": dead,
        "no_end_date": undated,
        # The headline. Not a claim that the vendor is survivorship-free
        # — `ABSENT` names four funds it dropped outright — but a
        # measurement that retention is the rule and loss the exception.
        "share_ended": (dead / total) if total else float("nan"),
    }


# -- resolving the list ---------------------------------------------------


_RESOLVED_DTYPES: dict[str, str] = {
    "ticker": "str",
    "group": "str",
    "exchange": "str",
    "asset_type": "str",
    "currency": "str",
    "first_available": "datetime64[ns]",
    "last_available": "datetime64[ns]",
    "still_listed": "bool",
    "note": "str",
}


def resolve_universe(
    directory: pd.DataFrame,
    entries: Sequence[Etf] = UNIVERSE,
    *,
    asof: date | None = None,
    require_major_venue: bool = True,
) -> pd.DataFrame:
    """Check every ticker against the catalogue and record when it starts.

    Returns one row per entry: `ticker`, `group`, `exchange`,
    `asset_type`, `currency`, `first_available`, `last_available`,
    `still_listed`, `note`. Raises `UniverseNotResolved` naming
    everything that did not check out, all of it at once — a resolver
    that raised on the first bad symbol would take four runs to surface
    four typos.

    **`first_available` is the point of the function.** It is the vendor's
    coverage start, which for these funds is the listing date, and it is
    recorded for every name including the ones nobody expected to be
    young. Half this universe launched after 2013; a panel that does not
    carry the dates is a panel in which a study can begin in 2005, run
    to 2026, and quietly be a nine-year study of anything factor-shaped.
    See `late_arrivals`, which turns the column into the sentence.

    **The asset-type check is corroboration and not proof.** Tiingo's
    `assetType` is a loose bucket: filed under ETF are closed-end funds
    (NXC, JEQ, MEN), and at least one outright operating company — EMC,
    which was acquired by Dell in 2016. So a symbol passing this check
    has not been shown to be a fund. What has been shown is that the
    vendor and the hand-written list agree, and the hand-written list is
    where the actual identification lives.

    **A ticker meaning two things is a raise, never a pick.** Where the
    catalogue holds several rows for a symbol they are deduplicated
    first; if what survives still disagrees about venue or coverage, the
    function refuses. Choosing quietly between them is precisely the
    recycled-symbol failure `schema.py` names in its opening paragraph —
    one series grafted onto another, backtesting beautifully.
    """
    if not isinstance(directory, pd.DataFrame) or directory.empty:
        raise UniverseNotResolved(
            "the directory is empty, so nothing can be resolved against it. "
            "Treating that as 142 unknown tickers would report our outage as "
            "a statement about what the vendor covers."
        )

    day = asof or date.today()
    cutoff = pd.Timestamp(day) - pd.Timedelta(days=STALE_AFTER_DAYS)

    wanted = list(dict.fromkeys(e.ticker for e in entries))
    pool = directory.loc[directory["ticker"].isin(wanted)]

    rows: list[dict[str, Any]] = []
    problems: list[str] = []

    for entry in entries:
        candidates = pool.loc[pool["ticker"] == entry.ticker]
        if candidates.empty:
            problems.append(
                f"{entry.ticker}: not in the directory at all. Either the "
                f"symbol is wrong or the vendor drops it — see ABSENT for "
                f"the funds already known to be missing and why."
            )
            continue

        typed = candidates.loc[candidates["asset_type"] == ETF_ASSET_TYPE]
        if typed.empty:
            kinds = sorted(set(candidates["asset_type"]))
            problems.append(
                f"{entry.ticker}: the directory types this {kinds}, not "
                f"{ETF_ASSET_TYPE!r}. The universe is ETFs only, so this "
                f"one is dropped rather than reclassified."
            )
            continue

        priced = typed.loc[typed["currency"] == PRICE_CURRENCY]
        if priced.empty:
            found = sorted(set(typed["currency"]))
            problems.append(
                f"{entry.ticker}: priced in {found}, not {PRICE_CURRENCY}. A "
                f"foreign line under a familiar symbol carries a currency "
                f"bet nobody in this process took."
            )
            continue

        if require_major_venue:
            venued = priced.loc[priced["exchange"].isin(MAJOR_VENUES)]
            if venued.empty:
                found = sorted(set(priced["exchange"]))
                problems.append(
                    f"{entry.ticker}: quoted on {found}, none of which we "
                    f"would trade. The fills are not real."
                )
                continue
        else:
            venued = priced

        unique = venued.drop_duplicates(
            subset=["exchange", "start_date", "end_date"]
        )
        if len(unique) > 1:
            seen = [
                f"{r.exchange} {_iso(r.start_date)}..{_iso(r.end_date)}"
                for r in unique.itertuples()
            ]
            problems.append(
                f"{entry.ticker}: the directory holds {len(unique)} different "
                f"securities under this symbol — {seen}. Picking one quietly "
                f"is how a dead company's history gets grafted onto a living "
                f"one's; decide by hand and pin the choice in the list."
            )
            continue

        row = unique.iloc[0]
        last = row["end_date"]
        rows.append(
            {
                "ticker": entry.ticker,
                "group": entry.group,
                "exchange": row["exchange"],
                "asset_type": row["asset_type"],
                "currency": row["currency"],
                "first_available": row["start_date"],
                "last_available": last,
                # A bar last week is a listing; a bar in 2020 is a fund
                # that closed. Stated as a derived boolean and not as a
                # delisting date, because the catalogue publishes the end
                # of COVERAGE and those are not the same fact.
                "still_listed": bool(pd.notna(last) and last >= cutoff),
                "note": entry.note,
            }
        )

    if problems:
        raise UniverseNotResolved(
            f"{len(problems)} of {len(entries)} universe entries did not "
            f"resolve against the Tiingo directory:\n  - "
            + "\n  - ".join(problems)
        )

    out = _typed(pd.DataFrame(rows), _RESOLVED_DTYPES)
    return out.sort_values(["group", "ticker"]).reset_index(drop=True)


def universe_as_of(
    resolved: pd.DataFrame, day: date | datetime | str
) -> tuple[str, ...]:
    """The tickers that actually existed on `day`, in ticker order.

    The counterpart to `first_available` being recorded at all. A
    rebalance on 2008-06-30 that reaches for MTUM is not a data gap to
    be forward-filled, it is a trade in a fund that would not exist for
    another five years, and the only defence is asking this question
    before the weights are computed rather than noticing the NaN after.
    """
    when = pd.Timestamp(_as_date(day))
    live = resolved.loc[
        resolved["first_available"].notna()
        & (resolved["first_available"] <= when)
        & (resolved["last_available"].isna() | (resolved["last_available"] >= when))
    ]
    return tuple(sorted(str(t) for t in live["ticker"]))


def late_arrivals(
    resolved: pd.DataFrame, sample_start: date | datetime | str
) -> pd.DataFrame:
    """Every fund whose history begins after a stated sample start.

    Written to be printed. "A universe list that hides that fact is how
    a backtest quietly starts in 2014" is the failure, and the defence
    is a table somebody has to read: ticker, group, first date, and how
    many days of the stated window it cannot cover.

    Sorted worst-first, because the interesting question is never "are
    any young" — some always are — but "which sleeve is a decade shorter
    than the study claims to be".

    A fund whose start date is unknown sorts FIRST, above the largest
    measured hole. Its `missing_days` is NA and pandas would otherwise
    file it at the bottom, next to the funds that barely miss — which
    reads as the mildest case when it is the only one nobody has
    measured. An unmeasured gap is not a small gap.
    """
    start = pd.Timestamp(_as_date(sample_start))
    late = resolved.loc[
        resolved["first_available"].isna() | (resolved["first_available"] > start)
    ]
    late = late.assign(
        missing_days=(late["first_available"] - start).dt.days.astype("Int64")
    )
    return late.sort_values(
        ["missing_days", "ticker"],
        ascending=[False, True],
        na_position="first",
    ).reset_index(drop=True)


def absence_report(directory: pd.DataFrame) -> pd.DataFrame:
    """Re-check the documented absences against a live catalogue.

    `ABSENT` is a claim about somebody else's data and claims about
    somebody else's data go stale. A row here with `still_absent` False
    means the vendor started carrying a ticker we told the reader it
    drops — which is good news and a stale comment, and the only way to
    find out is to look every time rather than to trust the table.
    """
    have = set(directory["ticker"])
    rows = [
        {
            "ticker": a.ticker,
            "fate": a.fate,
            "successor": a.successor or "",
            "still_absent": a.ticker not in have,
            "note": a.note,
        }
        for a in ABSENT
    ]
    return _typed(
        pd.DataFrame(rows),
        {
            "ticker": "str",
            "fate": "str",
            "successor": "str",
            "still_absent": "bool",
            "note": "str",
        },
    )


# -- the source -----------------------------------------------------------


class ETFUniverseSource(KeyedSleeveSource):
    """Tiingo daily bars for a broad ETF universe, and nothing else.

    A `KeyedSleeveSource` with a longer allowlist. That is the whole
    difference, and it is deliberate: every decision about what a price
    IS — the refusal to serve a half-adjusted series, the split
    arithmetic, the schema, the synthesised id — is inherited unchanged,
    so a bar pulled here and a bar pulled by the sleeve source cannot
    disagree, and the reconciliation both feed remains meaningful.

    The wall stays a wall. A symbol outside the list raises before any
    HTTP happens, and the list is ETFs. Widening it to single names
    would not be a bigger version of this — a free adjusted-close feed
    answers only for symbols that still resolve today, and where nine or
    a hundred and forty hand-checked funds make that bias visible and
    bounded, eight thousand equities make it invisible and total.
    """

    def __init__(
        self,
        *,
        allowed: Iterable[str] = UNIVERSE_TICKERS,
        directory: pd.DataFrame | None = None,
        fetch_names: bool = True,
        backend: str = "tiingo",
        **kwargs: Any,
    ) -> None:
        if str(backend).strip().lower() != "tiingo":
            raise ValueError(
                f"the ETF universe is a Tiingo pull, not a {backend!r} one. "
                f"Alpha Vantage's adjusted close is a premium endpoint and "
                f"its free key allows 25 requests a day, so a 142-name "
                f"universe is not a slower pull there, it is an impossible "
                f"one. Naming a second backend would imply otherwise."
            )
        super().__init__("tiingo", allowed=allowed, **kwargs)

        # One pass over the catalogue, not one per ticker: the file is
        # a hundred thousand rows and the allowlist is a hundred and
        # forty, so the obvious loop is sixteen million comparisons to
        # answer a question a single filter answers once.
        #
        # Symbols the catalogue holds more than once are LEFT OUT rather
        # than resolved here. This constructor is not the place to
        # decide which of two securities a ticker means —
        # `resolve_universe` refuses that choice out loud, and quietly
        # making it here would route around the refusal.
        self._directory_rows: dict[str, pd.Series] = {}
        if directory is not None and not directory.empty:
            relevant = directory.loc[
                directory["ticker"].isin(self._allowed)
                & (directory["asset_type"] == ETF_ASSET_TYPE)
                & (directory["currency"] == PRICE_CURRENCY)
            ].drop_duplicates(
                subset=["ticker", "exchange", "start_date", "end_date"]
            )
            counts = relevant["ticker"].value_counts()
            for row in relevant.itertuples(index=False):
                if counts[row.ticker] == 1:
                    self._directory_rows[row.ticker] = pd.Series(row._asdict())
        self._fetch_names = bool(fetch_names)

        self.capabilities = SourceCapabilities(
            name=f"Tiingo daily EOD (ETF universe, {len(self._allowed)} funds)",
            # False, and read the reason carefully because it is not the
            # usual one. The VENDOR retains its dead: a quarter of the
            # ETF rows in its catalogue ended in the past and the price
            # endpoint still serves them. The LIST does not, because it
            # was written in 2026 by someone looking at funds that still
            # trade. The bias here is ours and is fixable by adding
            # names, which is a different sentence from "the source
            # cannot support this" — and claiming the capability would
            # let the survivorship checks pass on a tautology either way.
            claims_survivorship_free=False,
            provides_filing_dates=False,
            provides_as_reported=False,
            # A dead fund's last bar is not a delisting date. RSX's final
            # print is a zero-volume mark at 5.6187 carried through a
            # halt, months of sanctions after anyone traded it, and the
            # catalogue publishes the end of COVERAGE rather than the day
            # the fund wound up. Reporting one as the other would put a
            # fabricated event date in the actions frame.
            provides_delisting_dates=False,
            provides_delisting_reasons=False,
            # False despite every row carrying one: these ids are a hash
            # of the ticker string and carry exactly what the string
            # carries. That is a real limitation here rather than a
            # formality — RSPT's bars begin in 2006 under a symbol that
            # did not exist until 2023, so the id is stable across a
            # rename only because the vendor already collapsed the two.
            provides_permanent_ids=False,
            provides_index_membership=False,
            provides_unadjusted_prices=True,
            is_smoke_test_only=False,
        )

    def require_allowed(self, ticker: str) -> str:
        symbol = str(ticker).strip().upper()
        if symbol not in self._allowed:
            raise TickerNotAllowed(
                f"{symbol!r} is not in this ETF universe. The list is "
                f"{len(self._allowed)} hand-checked exchange-traded funds and "
                f"the wall is the same one the sleeve source keeps, widened "
                f"rather than removed: a free adjusted-close feed answers "
                f"only for symbols that still resolve today, so anything "
                f"pulled through it is survivorship-biased by construction. "
                f"With a hundred and forty funds that bias is visible, "
                f"bounded and measured — see DECEASED and ABSENT. With the "
                f"single-name layer it would be invisible and total, which is "
                f"why that layer stays unreachable from here whatever the key "
                f"would allow. To add a fund, put it in UNIVERSE and let "
                f"resolve_universe check it."
            )
        return symbol

    def _profile_fields(self, symbol: str, through: date) -> dict[str, Any]:
        """Venue and coverage from the catalogue; the name from the vendor.

        One request bought the venue and the coverage window for every
        ticker at once, so asking the per-symbol metadata endpoint for
        them again would be a hundred and forty round trips for facts
        already on disk. The fund's NAME is the one field the catalogue
        does not carry, and `fetch_names=False` trades it away for
        halving the request count — the parent then falls back to the
        ticker, which is an obviously derived name rather than a
        plausible invented one.
        """
        memo = (symbol, through)
        if memo in self._profiles:
            return self._profiles[memo]

        fields: dict[str, Any] = {}
        row = self._directory_rows.get(symbol)
        if row is not None:
            fields["exchange"] = str(row["exchange"])
            if pd.notna(row["start_date"]):
                fields["first_price_date"] = pd.Timestamp(row["start_date"])
            if pd.notna(row["end_date"]):
                fields["last_price_date"] = pd.Timestamp(row["end_date"])

        if self._fetch_names or not fields:
            # Falling through when the catalogue had nothing is not a
            # convenience: a row missing here means the symbol is in the
            # allowlist and not in the directory, and answering with a
            # blank venue would file that under "no exchange" instead of
            # under "we never looked".
            vendor = super()._profile_fields(symbol, through)
            merged = {**vendor, **{k: v for k, v in fields.items() if v is not None}}
            fields = merged

        self._profiles[memo] = fields
        return fields


# -- pulling --------------------------------------------------------------


_COVERAGE_DTYPES: dict[str, str] = {
    "ticker": "str",
    "group": "str",
    "first_bar": "datetime64[ns]",
    "last_bar": "datetime64[ns]",
    "rows": "int64",
    "final_close": "float64",
    "final_volume": "float64",
}


def pull_universe(
    source: ETFUniverseSource,
    start: date = HISTORY_START,
    end: date | None = None,
    *,
    tickers: Iterable[str] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    pause: float = PULL_PAUSE_SECONDS,
    on_progress: Callable[[int, int, str, int], None] | None = None,
) -> pd.DataFrame:
    """Fetch every ticker one at a time and report what came back.

    Returns the coverage table — `ticker`, `group`, `first_bar`,
    `last_bar`, `rows`, `final_close`, `final_volume` — which is the
    thing worth reading after a pull. A row count alone says the request
    succeeded; the first date says whether the fund can answer the
    question you were going to ask it.

    One name per call, with a pause on top of the half-second the parent
    already paces at. A hundred and forty tickers is a much larger burst
    than nine and the vendor has no way to tell a research pull from a
    scrape except by how it behaves. The whole thing lands in the cache,
    so the slowness is paid once.

    **An outage stops the pull.** It does not get recorded as a fund with
    no history: a coverage table listing eighty names with bars and
    sixty with none reads exactly like a universe where sixty funds are
    untraded, and that reading survives into every count downstream.
    Restarting is cheap because everything already fetched is on disk —
    which is the argument for raising rather than against it.

    The 429 is the outage this will actually hit. The free tier meters
    `FREE_TIER_SYMBOLS_PER_HOUR` distinct symbols, so a full universe
    takes three passes separated by an hour, and no amount of `pause`
    changes that — the cap counts names, not calls. Catch
    `SourceUnavailable`, wait, and call this again: every ticker already
    on disk costs nothing the second time through, which is the only
    reason a resumable loop is a reasonable thing to write.
    """
    symbols = tuple(
        dict.fromkeys(
            str(t).strip().upper()
            for t in (tickers if tickers is not None else source.allowed_tickers)
        )
    )
    if not symbols:
        raise ValueError(
            "no tickers to pull. An empty coverage table is indistinguishable "
            "from a universe in which nothing has any history."
        )
    through = end or date.today()

    rows: list[dict[str, Any]] = []
    for i, symbol in enumerate(symbols, start=1):
        if i > 1 and pause > 0:
            sleep(pause)
        pid = source.permaticker_for(symbol)
        bars = source.prices(start, through, permatickers=[pid])
        entry = _BY_TICKER.get(symbol)
        rows.append(
            {
                "ticker": symbol,
                "group": entry.group if entry else "",
                "first_bar": bars["date"].min() if len(bars) else pd.NaT,
                "last_bar": bars["date"].max() if len(bars) else pd.NaT,
                "rows": int(len(bars)),
                "final_close": (
                    float(bars["close_unadj"].iloc[-1]) if len(bars) else float("nan")
                ),
                "final_volume": (
                    float(bars["volume_unadj"].iloc[-1]) if len(bars) else float("nan")
                ),
            }
        )
        if on_progress is not None:
            on_progress(i, len(symbols), symbol, int(len(bars)))

    out = _typed(pd.DataFrame(rows), _COVERAGE_DTYPES)
    return out.sort_values(["group", "ticker"]).reset_index(drop=True)


_EVIDENCE_DTYPES: dict[str, str] = {
    "ticker": "str",
    "served": "bool",
    "first_bar": "datetime64[ns]",
    "last_bar": "datetime64[ns]",
    "rows": "int64",
    "final_close": "float64",
    "final_volume": "float64",
    "days_dark": "Int64",
    "note": "str",
}


def deceased_evidence(
    source: ETFUniverseSource,
    directory: pd.DataFrame,
    *,
    tickers: Iterable[str] | None = None,
    start: date = HISTORY_START,
    asof: date | None = None,
    sleep: Callable[[float], None] = time.sleep,
    pause: float = PULL_PAUSE_SECONDS,
) -> pd.DataFrame:
    """Whether the closed funds really do come back, fund by fund.

    This is the only evidence in the repository that anything here is
    survivorship-free in any respect, and it is deliberately a
    measurement rather than a capability flag. `served` True with a
    `last_bar` years in the past and a plausible row count is a fund
    that stopped trading and whose history is still retrievable.
    `served` False is the opposite finding and just as valuable: the
    share of dead funds the vendor drops is the size of the bias in
    anything built here.

    The catalogue decides `served`, before any request goes out. That is
    not an optimisation — it is what keeps "the vendor does not carry
    this symbol" separate from "the vendor is down right now". Both
    arrive as a failed fetch and they mean opposite things, so a symbol
    the catalogue does not list is recorded absent with no call made,
    and a symbol it does list is fetched with any failure left to raise.

    Read `final_volume` before believing a `last_bar`. RSX's final print
    is a zero-volume mark carried through a halt: the tape ends on a day
    nobody traded, which is why none of these dates is offered as a
    delisting date.
    """
    day = asof or date.today()
    symbols = tuple(
        dict.fromkeys(
            str(t).strip().upper()
            for t in (tickers if tickers is not None else sorted(DECEASED_TICKERS))
        )
    )
    if not symbols:
        raise ValueError("no tickers to probe")
    if not isinstance(directory, pd.DataFrame) or directory.empty:
        raise SourceUnavailable(
            "the survivorship probe needs the directory to tell an unknown "
            "symbol from an unreachable vendor. Without it every failure "
            "would be recorded as a fund the vendor drops, which is exactly "
            "the conclusion this function exists to test."
        )

    known = set(directory.loc[directory["ticker"].isin(symbols), "ticker"])

    rows: list[dict[str, Any]] = []
    fetched = 0
    for symbol in symbols:
        entry = _BY_TICKER.get(symbol)
        note = entry.note if entry else ""
        if symbol not in known:
            rows.append(
                {
                    "ticker": symbol,
                    "served": False,
                    "first_bar": pd.NaT,
                    "last_bar": pd.NaT,
                    "rows": 0,
                    "final_close": float("nan"),
                    "final_volume": float("nan"),
                    "days_dark": pd.NA,
                    "note": note,
                }
            )
            continue

        if fetched and pause > 0:
            sleep(pause)
        fetched += 1
        bars = source.prices(start, day, permatickers=[source.permaticker_for(symbol)])
        last = bars["date"].max() if len(bars) else pd.NaT
        rows.append(
            {
                "ticker": symbol,
                # True means bars came back, not that the fund is alive.
                "served": bool(len(bars)),
                "first_bar": bars["date"].min() if len(bars) else pd.NaT,
                "last_bar": last,
                "rows": int(len(bars)),
                "final_close": (
                    float(bars["close_unadj"].iloc[-1]) if len(bars) else float("nan")
                ),
                "final_volume": (
                    float(bars["volume_unadj"].iloc[-1]) if len(bars) else float("nan")
                ),
                "days_dark": (
                    int((pd.Timestamp(day) - last).days) if pd.notna(last) else pd.NA
                ),
                "note": note,
            }
        )

    return _typed(pd.DataFrame(rows), _EVIDENCE_DTYPES).sort_values(
        "ticker"
    ).reset_index(drop=True)


def coverage_summary(coverage: pd.DataFrame) -> dict[str, Any]:
    """Totals for the pull, in the shape a report footer wants."""
    if coverage.empty:
        raise ValueError(
            "an empty coverage table cannot be summarised; a pull that "
            "fetched nothing must not report totals of zero as a result"
        )
    served = coverage.loc[coverage["rows"] > 0]
    return {
        "tickers": int(len(coverage)),
        "with_bars": int(len(served)),
        "total_rows": int(coverage["rows"].sum()),
        "earliest_bar": served["first_bar"].min() if len(served) else pd.NaT,
        "latest_bar": served["last_bar"].max() if len(served) else pd.NaT,
        # The number that decides whether a stated sample start is real.
        "median_first_bar": served["first_bar"].median() if len(served) else pd.NaT,
    }


# -- module helpers -------------------------------------------------------


def _venue(raw: Any) -> str:
    if raw is None:
        return ""
    text = " ".join(str(raw).split()).upper()
    return _VENUES.get(text, text)


def _iso(value: Any) -> str:
    if value is None or pd.isna(value):
        return "?"
    return pd.Timestamp(value).date().isoformat()


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

    A near-twin of the helper in `keyedsleeves`, written out again for
    the reason that file gives about its own: the shared authority is
    the dtype map beside each frame, not a private function, and an
    import would create a coupling the next editor of either file cannot
    see from where they are standing.
    """
    built = {}
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
