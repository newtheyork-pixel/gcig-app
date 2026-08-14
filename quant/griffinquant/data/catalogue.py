"""The whole inventory: every dataset we hold, and what each cannot answer.

Six acquisition modules now sit beside this one, each with its own
honesty block, and between them they run to nine thousand lines. Nobody
reads nine thousand lines to find out whether we can test a stock-
picking rule. So this file is the index — one row per dataset, stating
where it came from, when it truly starts, how often it moves, what its
licence permits, how much disk it occupies right now, and the single
question it can answer.

**The column that matters is `survivorship`, and it has four values
rather than two.** A yes/no field would force three different honest
answers into one dishonest one. CRSP through Ken French genuinely
retains the securities that died. FRED and Shiller have no
cross-section at all, so the bias cannot arise and cannot be checked
either. SEC's ticker map is a roster of the living and is the exact
shape of the bug. And the Tiingo ETF panel is the interesting case: the
vendor keeps its dead and our hand-written list does not, which makes
the bias ours and fixable rather than the source's and permanent.
Collapsing those four onto a boolean is how somebody ends up building a
universe out of `company_tickers.json`.

**Disk is measured, never estimated.** Every cache entry carries a JSON
sidecar naming its source, its frame and its parameters, so the bytes
are attributed by reading those rather than by summing directory sizes
and hoping the mapping is one-to-one. It is not one-to-one: four
Damodaran and Shiller workbooks share the frame name `workbook`, and
the ETF panel writes under the same slug as the nine-sleeve pull on
purpose. Attribution is therefore per (slug, frame, parameters), most
specific first, and every entry is claimed at most once.

That leaves a hole worth naming: bytes on disk that no catalogue row
claims. `unattributed()` reports them. A catalogue that silently
under-counts is worse than no catalogue, because it reads as a complete
picture — so the check is a function anybody can call rather than a
comment promising we were careful.

**Nothing here fetches.** Importing this module opens no socket and
reads no parquet; the only I/O is `os.stat` on sidecars when somebody
asks for usage. The runner that does the fetching is `fetch_all.py`,
and keeping the two apart is what lets a reviewer print the inventory
with no key, no network and no vendor still in business.

The closing section — `LIMITS` — is the part to read before planning
anything. It says what remains impossible, and the first entry is the
one that costs the most.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from .cache import DEFAULT_ROOT

#: Raw archives that are not frames and so cannot live in a
#: ParquetCache. Today that is the DERA quarterly zips, kept because one
#: is 85MB and a caller who wants a second XBRL tag out of a quarter
#: should not pay for it twice. Sits beside the cache under the same
#: data root, and is counted here so the inventory's disk figure is the
#: whole footprint rather than the tidy part of it.
RAW_ROOTS: Mapping[str, str] = {"edgar-raw": "SEC DERA quarterly zips"}


# -- the four honest answers ----------------------------------------------


#: The source retains securities that stopped trading, and we can name
#: the mechanism. Two things qualify and both are somebody else's
#: guarantee taken on documented terms rather than a property we
#: verified row by row.
SURVIVORSHIP_FREE = "free"

#: A roster of the living. The dead are absent and nothing in the
#: payload records that they were ever present, which is survivorship
#: bias in its original form.
SURVIVORSHIP_BIASED = "biased"

#: The vendor retains its dead; our selection from it does not. Worth
#: its own value because the remedy is different: this is fixable by
#: adding names, and "biased" is not fixable at all.
SURVIVORSHIP_OURS = "ours"

#: There is no cross-section, so the bias cannot arise — an index level
#: or a national aggregate is one series through time and there is no
#: set of names from which losers could have been dropped. It also
#: cannot be checked, which is why this is not spelled "free".
SURVIVORSHIP_NA = "n/a"

SURVIVORSHIP_STATES = (
    SURVIVORSHIP_FREE,
    SURVIVORSHIP_BIASED,
    SURVIVORSHIP_OURS,
    SURVIVORSHIP_NA,
)

#: What each state prints as in a table. Short enough to sit in a
#: column, long enough that a reader who has not met the vocabulary
#: still gets the direction right.
SURVIVORSHIP_LABELS: Mapping[str, str] = {
    SURVIVORSHIP_FREE: "FREE",
    SURVIVORSHIP_BIASED: "BIASED",
    SURVIVORSHIP_OURS: "OURS",
    SURVIVORSHIP_NA: "n/a",
}


# -- the registry ---------------------------------------------------------


@dataclass(frozen=True)
class FrameRef:
    """Where one dataset's bytes live in the cache.

    `params` is a SUBSET match against the sidecar's own parameters, and
    it is the reason four separate academic workbooks that all cache
    under the frame name `workbook` can still be counted apart. A ref
    with no params claims every entry of that frame.
    """

    slug: str
    frame: str
    params: Mapping[str, Any] | None = None

    @property
    def specificity(self) -> int:
        return len(self.params or {})

    def matches(self, meta: Mapping[str, Any]) -> bool:
        if meta.get("source") != self.slug or meta.get("frame") != self.frame:
            return False
        if not self.params:
            return True
        got = meta.get("params") or {}
        return all(got.get(k) == v for k, v in self.params.items())


@dataclass(frozen=True)
class Dataset:
    """One dataset, described well enough that nobody has to open the module.

    Two fields carry the weight and neither is optional. `question` is
    the one thing this data can answer, written as a question so that a
    reader can tell instantly whether it is theirs. `cannot` is the
    sentence that must travel with it — the reason this dataclass exists
    rather than a dict, because a dict lets somebody render a summary
    table and drop the inconvenient column.
    """

    key: str
    title: str
    publisher: str
    module: str
    endpoint: str

    contains: str
    #: Read off the rows where we have them, not off the publisher's
    #: prose. Several of these were wrong in the first draft of their
    #: own module and the pull disproved them.
    true_start: str
    cadence: str

    survivorship: str
    survivorship_basis: str

    licence: str
    #: May the raw numbers leave the building? None where the source
    #: publishes nothing either way, which is itself an answer: absence
    #: of a licence is a reservation of rights, not a grant.
    redistributable: bool | None

    question: str
    cannot: str

    frames: tuple[FrameRef, ...] = ()
    raw_dirs: tuple[str, ...] = ()
    #: Environment variable the pull needs, or "" for keyless. We hold
    #: exactly one key and it is worth being able to filter on that.
    needs_key: str = ""
    notes: str = ""

    #: "frame" where a cached row is an observation, "blob" where the
    #: entry holds the source file itself. The distinction has to be in
    #: the data because it changes what the row count MEANS: Shiller is
    #: 1,867 monthly observations and exactly one cached row, and a
    #: table printing "1" beside "7,342,659" invites the reader to
    #: conclude the parse failed.
    cached_as: str = "frame"

    def __post_init__(self) -> None:
        if self.cached_as not in ("frame", "blob"):
            raise ValueError(
                f"{self.key}: cached_as must be 'frame' or 'blob', got "
                f"{self.cached_as!r}"
            )
        if self.survivorship not in SURVIVORSHIP_STATES:
            raise ValueError(
                f"{self.key}: survivorship {self.survivorship!r} is not one "
                f"of {list(SURVIVORSHIP_STATES)}. The vocabulary is closed on "
                f"purpose — a free-text field here is a field that ends up "
                f"saying 'mostly'."
            )

    @property
    def survivorship_label(self) -> str:
        return SURVIVORSHIP_LABELS[self.survivorship]


def _registry(*items: Dataset) -> dict[str, Dataset]:
    seen: dict[str, Dataset] = {}
    for item in items:
        if item.key in seen:
            raise ValueError(f"duplicate catalogue key {item.key!r}")
        seen[item.key] = item
    return seen


_EDGAR_LICENCE = (
    "Public domain (17 U.S.C. 105). No restriction on redistribution or "
    "academic use; the only published condition is SEC's fair-access "
    "policy — a declared User-Agent with a contact address, and at most "
    "10 requests per second."
)

_TIINGO_LICENCE = (
    "Tiingo free tier: internal research and analysis permitted, "
    "REDISTRIBUTION IS NOT. A paper may print statistics derived from "
    "these bars and may not ship the bars."
)

_FRENCH_LICENCE = (
    "Every file ends 'Copyright Eugene F. Fama and Kenneth R. French'. "
    "No licence, no redistribution grant and no citation requirement is "
    "published anywhere on the library page. Treated as a reservation "
    "of rights: cache locally, cite by name, do not republish."
)


DATASETS: dict[str, Dataset] = _registry(
    # -- the one survivorship-free return series we have ------------------
    Dataset(
        key="french_library",
        title="Fama/French factors and sorted portfolios",
        publisher="Kenneth R. French Data Library, Tuck School of Business",
        module="griffinquant.data.frenchlib",
        endpoint="mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/",
        contains=(
            "18 datasets, 63 tables, 468,950 observations. FF3 and FF5 "
            "daily and monthly; momentum; short- and long-term reversal; "
            "12- and 49-industry portfolios value- and equal-weighted; 6 "
            "and 25 portfolios double-sorted on size and book-to-market."
        ),
        true_start=(
            "1926-01-26 (short-term reversal, daily) — the headline "
            "factors from 1926-07, the five-factor set from 1963-07 "
            "because RMW and CMA need Compustat"
        ),
        cadence="monthly, following a new CRSP cut (current vintage 202605)",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis=(
            "Built from CRSP, which retains delisted securities and "
            "carries the delisting return, and French forms each "
            "portfolio from the stocks meeting the criterion ON THE "
            "FORMATION DATE. A company that went to zero in 1974 is "
            "inside the 1974 portfolio at the weight it had. We cannot "
            "inspect CRSP ourselves, so this is French's documented "
            "construction rather than a property verified row by row — "
            "the strongest survivorship claim available to us and still "
            "a claim about someone else's database."
        ),
        licence=_FRENCH_LICENCE,
        redistributable=False,
        question=(
            "Did a factor premium actually exist, over what period, and "
            "when did it stop working?"
        ),
        cannot=(
            "Name a single security, or be traded. There are no "
            "constituents, prices or identifiers here, and the returns "
            "carry no transaction cost, spread, impact, capacity limit "
            "or short borrow — a small-cap corner's real round trip "
            "would eat much of the published premium."
        ),
        frames=(FrameRef("kenneth-french", "french_library"),),
        notes=(
            "The honesty benchmark for everything else: a signal that "
            "does not beat the matching French sort has not been shown "
            "to be a signal."
        ),
    ),
    # -- macro ------------------------------------------------------------
    Dataset(
        key="fred_series",
        title="Curated FRED macro series with measured publication lags",
        publisher="Federal Reserve Bank of St. Louis (FRED)",
        module="griffinquant.data.fredseries",
        endpoint="fred.stlouisfed.org/graph/fredgraph.csv",
        contains=(
            "27 series across rates, inflation, credit, growth, "
            "financial conditions and FX/commodities. Each row carries "
            "the question it answers, its verified first observation, "
            "its measured release lag, how it is revised, and FRED's own "
            "licence tag."
        ),
        true_start="1919-01 (INDPRO) through 2023-08 (the ICE credit series)",
        cadence="daily to monthly, per series; each on its own release calendar",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis=(
            "A macro aggregate is one series through time, not a "
            "cross-section, so there is no set of names from which "
            "losers could have been dropped. Two related biases do "
            "apply. The CATALOGUE is survivorship-selected — TEDRATE is "
            "kept deliberately as a dead id so a reader does not learn "
            "that ids never die. And an id can survive while its history "
            "is withdrawn: both ICE BofA spread series were pulled back "
            "to 2023-08 on 2026-08-02, for indices documented to 1996, "
            "and nothing about that pull looks wrong."
        ),
        licence=(
            "Per series, read from FRED's own JSON-LD: public_domain, "
            "citation_required, or pre_approval_required. The two ICE "
            "BofA series are the last of those — research is fine, "
            "republication needs ICE's written approval."
        ),
        redistributable=None,
        question=(
            "What was the macro regime, and what could a person "
            "actually have known about it on the day?"
        ),
        cannot=(
            "Identify a security. Nothing here selects a name; it can "
            "only tilt, time or hedge an allocation chosen elsewhere. "
            "And the file served today is the REVISED history — payrolls "
            "moved 1.1 million jobs at one vintage — so any point-in-time "
            "use must go through `as_of` with a stated lag."
        ),
        frames=(FrameRef("fred", "fred_observations"),),
        notes=(
            "`tbill.py` reads DGS3MO from this same endpoint for the "
            "cash sleeve; it is the same id, not a second source."
        ),
    ),
    Dataset(
        key="fred_vintages",
        title="ALFRED archived vintages — the series as it stood that morning",
        publisher="Federal Reserve Bank of St. Louis (ALFRED)",
        module="griffinquant.data.fredseries",
        endpoint="alfred.stlouisfed.org/graph/alfredgraph.csv",
        contains=(
            "Point-in-time snapshots for 13 series across 5-17 vintages "
            "each, pulled to measure release lags rather than to guess "
            "them. This is the evidence behind every lag in the "
            "catalogue above."
        ),
        true_start=(
            "varies by series and stops well short of the data: a 2012 "
            "vintage of DTWEXBGS or BAA10Y is a 404, and STLFSI4 has no "
            "vintage before 2023 at all"
        ),
        cadence="a new vintage on each release; a published vintage never changes",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis=(
            "Same as the live series, with one addition that cuts the "
            "other way: this is the only place in the repository where "
            "the past can be read as it was, rather than as it has since "
            "been revised."
        ),
        licence="as the underlying series; ALFRED adds no separate terms",
        redistributable=None,
        question=(
            "Was a macro number knowable on the date a backtest used "
            "it, or is the strategy reading the revision?"
        ),
        cannot=(
            "Reach as far back as the data. Where the archive stops, a "
            "stated lag is the only answer there is and it cannot be "
            "checked — a reason to keep it conservative, not a reason "
            "to trust it."
        ),
        frames=(FrameRef("fred", "fred_vintage"),),
    ),
    Dataset(
        key="fred_century",
        title="Century-scale US macro (NBER recessions, CPI, IP, Aaa/Baa)",
        publisher="Federal Reserve Bank of St. Louis (FRED)",
        module="griffinquant.data.longhistory",
        endpoint="fred.stlouisfed.org/graph/fredgraph.csv",
        contains=(
            "9 series in long form: USREC, CPIAUCNS, INDPRO, AAA, BAA, "
            "UNRATE, GS10, FEDFUNDS, M2SL. The slice `fredseries.py` "
            "does not cover, chosen for depth rather than for timeliness."
        ),
        true_start="1854-12 (USREC); CPIAUCNS 1913-01; INDPRO/AAA/BAA 1919-01",
        cadence="each series on its own publication schedule",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis="No cross-section. Same reasoning as the curated set.",
        licence=(
            "Keyless, mostly federal statistics and so public domain; "
            "individual series may carry their source's own copyright."
        ),
        redistributable=None,
        question=(
            "What did inflation, credit spreads and recessions do in "
            "the century our 2005-2026 sample has never seen?"
        ),
        cannot=(
            "Be traded on. USREC in particular is assigned "
            "RETROSPECTIVELY — NBER dates a peak a year or more later — "
            "so it describes regimes and must never be an input to a "
            "rule that trades."
        ),
        frames=(FrameRef("longhistory", "fred_macro"),),
    ),
    # -- the long histories -----------------------------------------------
    Dataset(
        key="shiller",
        title="Shiller monthly US equity, dividends, earnings, CPI, CAPE",
        publisher="Robert J. Shiller (shillerdata.com)",
        module="griffinquant.data.longhistory",
        endpoint="shillerdata.com — ie_data.xls",
        contains=(
            "1,867 monthly rows x 19 columns: price, dividend, earnings, "
            "CPI, the long rate, real series and CAPE."
        ),
        true_start="1871-01",
        cadence="irregular, roughly monthly; no schedule and no changelog",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis=(
            "Index level, so survivorship-free in the only sense a level "
            "can be — a failed constituent took the index down with it — "
            "and unverifiable in every other sense, because there is no "
            "constituent list to check. Two caveats we cannot test from "
            "here: prices before 1926 are the Cowles Commission's 1939 "
            "retrospective reconstruction, and pre-1926 dividends and "
            "earnings are interpolated from annual figures, so their "
            "monthly variation is arithmetic rather than history."
        ),
        licence=(
            "No licence published, disclaimer only. Free to read and "
            "cite; not ours to republish."
        ),
        redistributable=False,
        question=(
            "How did a valuation or market-timing rule behave through "
            "1929, 1937, 1973-74 and the whole of the seventies?"
        ),
        cannot=(
            "Say anything about individual securities, or support a "
            "daily rule. The price is a MONTHLY AVERAGE OF DAILY CLOSES: "
            "measured on his own real total-return series since 1950 the "
            "monthly AR(1) is +0.23, which is averaging, not momentum. "
            "Do not test a trend rule on it."
        ),
        frames=(FrameRef("longhistory", "workbook", {"dataset": "shiller"}),),
        cached_as="blob",
        notes=(
            "The Yale URL everybody cites still answers 200 with a "
            "well-formed workbook frozen at 2023-09. Exported as "
            "`SHILLER_YALE_MIRROR` and deliberately NOT a fallback."
        ),
    ),
    Dataset(
        key="damodaran_returns",
        title="Damodaran annual returns on stocks, bonds, bills, gold, real estate",
        publisher="Aswath Damodaran, NYU Stern",
        module="griffinquant.data.longhistory",
        endpoint="pages.stern.nyu.edu — histretSP.xls",
        contains="98 annual rows x 36 columns: nominal, real, wealth and premium blocks.",
        true_start="1928",
        cadence="once a year, in the first two weeks of January",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis=(
            "Index and portfolio level, unverifiable in the same way. "
            "Two components deserve their own sentence: the small-cap "
            "decile descends from CRSP and so is survivorship-free by "
            "construction, while the 10-year Treasury return is NOT an "
            "observed index — it is Damodaran's own coupon and price "
            "arithmetic on the constant-maturity yield, so a bond "
            "backtest on it tests his construction as much as the market."
        ),
        licence="'No strings attached'; attribution welcomed.",
        redistributable=True,
        question=(
            "What has each major asset class returned since 1928, and "
            "what did the equity risk premium look like at the time?"
        ),
        cannot=(
            "Be treated as point-in-time. The author revises method "
            "between vintages, so 1928 in this file need not match 1928 "
            "in last year's; the cached sha256 is the vintage id. Annual "
            "frequency also means no rule finer than a year."
        ),
        frames=(
            FrameRef("longhistory", "workbook", {"dataset": "damodaran_returns"}),
        ),
        cached_as="blob",
    ),
    Dataset(
        key="damodaran_implied_erp",
        title="Damodaran implied equity risk premium, annual",
        publisher="Aswath Damodaran, NYU Stern",
        module="griffinquant.data.longhistory",
        endpoint="pages.stern.nyu.edu — histimpl.xls",
        contains="66 annual rows x 19 columns of implied premium and its inputs.",
        true_start="1960",
        cadence="once a year, alongside the returns file",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis="Index level; same position as the returns file.",
        licence="'No strings attached'; attribution welcomed.",
        redistributable=True,
        question="What forward-looking premium was the index priced at each year?",
        cannot=(
            "Be point-in-time, and the method changes are larger here "
            "than in the returns file because the model itself has been "
            "revised more than once."
        ),
        frames=(
            FrameRef(
                "longhistory", "workbook", {"dataset": "damodaran_implied_erp"}
            ),
        ),
        cached_as="blob",
    ),
    Dataset(
        key="damodaran_erp_monthly",
        title="Damodaran implied equity risk premium, monthly",
        publisher="Aswath Damodaran, NYU Stern",
        module="griffinquant.data.longhistory",
        endpoint="pages.stern.nyu.edu — ERPbymonth.xlsx",
        contains="216 monthly rows x 17 columns.",
        true_start="2008-09",
        cadence="monthly, at the start of each month",
        survivorship=SURVIVORSHIP_NA,
        survivorship_basis="Index level; same position as the annual files.",
        licence="'No strings attached'; attribution welcomed.",
        redistributable=True,
        question="Where does the implied premium sit against its own recent range?",
        cannot=(
            "Be trusted cell by cell without the repair pass. About one "
            "cell in a hundred is a number typed as text — '3.90%', "
            "'84,88' with a European decimal comma, '175.51*' — and one "
            "whole month is formatted that way. `pd.to_numeric` NaNs it "
            "silently."
        ),
        frames=(
            FrameRef(
                "longhistory", "workbook", {"dataset": "damodaran_erp_monthly"}
            ),
        ),
        cached_as="blob",
    ),
    # -- SEC EDGAR, one row per endpoint because the answers differ -------
    Dataset(
        key="edgar_delistings",
        title="Form 25 / 25-NSE — the free delisting record",
        publisher="US Securities and Exchange Commission",
        module="griffinquant.data.edgarbulk",
        endpoint="sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx",
        contains=(
            "One row per notification of removal from listing: form, "
            "CIK, filer name, filing date, accession. About 450 a "
            "quarter in the modern record."
        ),
        true_start=(
            "measured per quarter — zero in 1996Q1, 1999Q1 and 2001Q1; "
            "114 in 2004Q1; the exchange-filed 25-NSE, which is the bulk "
            "of the record, begins 2006Q2"
        ),
        cadence="the current quarter's index is rebuilt daily; past quarters are final",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis=(
            "It is the record OF the deaths, and the quarterly index is "
            "written once and not revised as companies come and go. A "
            "Form 25 filed in 2008 is still in the 2008Q1 index today."
        ),
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question="Which listed companies died, and on what date?",
        cannot=(
            "Price the death. This is a delisting DATE and never a "
            "delisting RETURN — an acquisition at a premium and a "
            "wind-up at zero are the same row. It also strikes a CLASS "
            "OF SECURITIES rather than a company: Verizon is in 2025Q2 "
            "for a note while its common stock never stopped trading."
        ),
        frames=(
            FrameRef("sec-edgar", "form25"),
            FrameRef("sec-edgar", "form25_open"),
        ),
        notes=(
            "The index lists one row per FILER, so a 25-NSE appears "
            "twice — exchange and issuer. `mark_exchange_filers` "
            "identifies the exchange rows from the data rather than from "
            "a hardcoded CIK list, and deliberately under-flags."
        ),
    ),
    Dataset(
        key="edgar_dera_numbers",
        title="DERA Financial Statement Data Sets — num.txt",
        publisher="US Securities and Exchange Commission, DERA",
        module="griffinquant.data.edgarbulk",
        endpoint="sec.gov/files/dera/data/financial-statement-data-sets/{y}q{q}.zip",
        contains=(
            "Every numeric XBRL fact from every filing accepted in a "
            "quarter, filtered to the tags we asked for. Each row states "
            "its own period through `ddate` and `qtrs`."
        ),
        true_start="2009Q2 (2009Q1 exists as a 13KB stub and carries nothing)",
        cadence="one zip per quarter, published roughly two weeks after quarter end",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis=(
            "Each quarterly zip is assembled at the time and never "
            "rewritten to reflect who survived. A filer that went under "
            "in 2012 is still in 2012Q1 with the numbers it reported. "
            "This is the only dataset here that is both survivorship-free "
            "AND broad enough to build a panel from without already "
            "holding the CIKs."
        ),
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question=(
            "What did every filer — including the ones that later died — "
            "actually report, as filed?"
        ),
        cannot=(
            "Supply a price, a share count you can trust without care, "
            "or a clean restatement history. As-filed is near "
            "point-in-time and amendments must be handled explicitly; "
            "and with no prices there is no return, so a value factor "
            "built here has a numerator and no denominator."
        ),
        frames=(FrameRef("sec-edgar", "dera_numbers"),),
        raw_dirs=("edgar-raw",),
        notes=(
            "The fiscal-year trap that ruins companyfacts does not exist "
            "here: every row carries its own period end and duration. The "
            "quarterly zips under `data/edgar-raw/` are counted against "
            "this row and serve `edgar_dera_submissions` too — one "
            "archive, and splitting its bytes across two rows would be an "
            "invention. Measured 66-128MB per quarter."
        ),
    ),
    Dataset(
        key="edgar_dera_submissions",
        title="DERA Financial Statement Data Sets — sub.txt",
        publisher="US Securities and Exchange Commission, DERA",
        module="griffinquant.data.edgarbulk",
        endpoint="sec.gov/files/dera/data/financial-statement-data-sets/{y}q{q}.zip",
        contains=(
            "One row per filing in the quarter: CIK, name, SIC, former "
            "name and when it changed, filer status, fiscal year end, "
            "form, period, filed and accepted timestamps."
        ),
        true_start="2009Q2",
        cadence="quarterly, roughly two weeks after quarter end",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis="Same archive, same argument as num.txt.",
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question="Who filed what in a given quarter, and under what name?",
        cannot="Carry any market data at all.",
        frames=(FrameRef("sec-edgar", "dera_submissions"),),
    ),
    Dataset(
        key="edgar_filings",
        title="Submissions — every filing a CIK ever made, plus former names",
        publisher="US Securities and Exchange Commission",
        module="griffinquant.data.edgarbulk",
        endpoint="data.sec.gov/submissions/CIK##########.json",
        contains=(
            "The full filing index for a filer, its profile (head "
            "office, SIC, fiscal year end) and `formerNames` with the "
            "dates each was in use."
        ),
        true_start="1993-1994 for electronic filers; paper filings predate EDGAR",
        cadence="intraday — a new filing appears within minutes of acceptance",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis=(
            "A public record rather than a maintained product: it "
            "survives bankruptcy, acquisition and the reassignment of a "
            "ticker, and is keyed on the permanent CIK. The catch is "
            "reaching a dead filer at all — you need its CIK, and the "
            "ticker map will not give you one."
        ),
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question=(
            "What has this entity filed, when, and what did it used to "
            "be called?"
        ),
        cannot=(
            "Value anything. It can date a company's death and never "
            "price it."
        ),
        frames=(
            FrameRef("sec-edgar", "filing_index"),
            FrameRef("sec-edgar", "filer_profile"),
            FrameRef("sec-edgar", "former_names"),
        ),
    ),
    Dataset(
        key="edgar_companyfacts",
        title="companyfacts — one filer's whole XBRL history",
        publisher="US Securities and Exchange Commission",
        module="griffinquant.data.edgarbulk",
        endpoint="data.sec.gov/api/xbrl/companyfacts/CIK##########.json",
        contains="Every tagged fact a filer ever reported, per concept and unit.",
        true_start=(
            "XBRL only — roughly 2009 for large accelerated filers and "
            "2011 for the rest, however old the company is"
        ),
        cadence="updated as filings are accepted",
        survivorship=SURVIVORSHIP_FREE,
        survivorship_basis="Derived from one permanent CIK's filings; served for filers long gone.",
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question="What did one company report, quarter by quarter, in its own tags?",
        cannot=(
            "Be grouped on `fy`. Every fact is stamped with the FILING's "
            "fiscal year, not the fact's, so a 10-K's three comparative "
            "years collapse to one — and because SEC sorts the units "
            "array by period end ascending, the survivor is the OLDEST. "
            "This project printed General Dynamics' calendar-2023 income "
            "statement under the heading FY2025 before "
            "`extract_facts` recovered the year from position."
        ),
        frames=(FrameRef("sec-edgar", "company_facts"),),
        notes="~3.4MB per filer, so bound what you keep.",
    ),
    Dataset(
        key="edgar_ticker_map",
        title="company_tickers.json — the CIK lookup, and a roster of the living",
        publisher="US Securities and Exchange Commission",
        module="griffinquant.data.edgarbulk",
        endpoint="sec.gov/files/company_tickers_exchange.json",
        contains="~10,400 rows: ticker, CIK, name, exchange, for registrants that exist today.",
        true_start="current snapshot only; no history of any kind",
        cadence="rebuilt by SEC on roughly a daily cadence",
        survivorship=SURVIVORSHIP_BIASED,
        survivorship_basis=(
            "Measured: every row is a registrant with a CURRENT ticker "
            "association and the count drifts daily. A company delisted "
            "last year is absent and nothing in the payload records that "
            "it was ever present."
        ),
        licence=_EDGAR_LICENCE,
        redistributable=True,
        question="Which CIK answers for this ticker today?",
        cannot=(
            "Be a universe. Used as one it reintroduces survivorship "
            "bias using the single source that could have avoided it."
        ),
        frames=(FrameRef("sec-edgar", "ticker_map"),),
    ),
    # -- the priced panel -------------------------------------------------
    Dataset(
        key="tiingo_etf_bars",
        title="Daily bars for the ETF panel, living and closed",
        publisher="Tiingo",
        module="griffinquant.data.etfuniverse",
        endpoint="api.tiingo.com/tiingo/daily/{ticker}/prices",
        contains=(
            "142 living ETFs across eight groups, 12 closed ones carried "
            "as evidence, and the dead funds `deadetfs.py` is recovering "
            "one metered batch at a time. Both series are honest: "
            "as-traded OHLCV and a split- and dividend-adjusted partner, "
            "with divCash and splitFactor beside them."
        ),
        true_start="1993-01-29 (SPY); median first bar 2006-06-26",
        cadence="end of day, after each US session",
        survivorship=SURVIVORSHIP_OURS,
        survivorship_basis=(
            "STILL OURS, and the measurement that was meant to upgrade "
            "it is the reason it cannot be. The vendor does retain dead "
            "funds — 2,069 of 7,747 shelf rows end in the past and the "
            "price endpoint serves their history, 45 of the first 46 "
            "asked for — but `deadetfs.retention_cliff` finds that the "
            "retention has a START DATE. The catalogue records one ETF "
            "closure in 2010, three in 2011, two in 2013, then 44 in "
            "2014 and 100-250 a year since. No market has that shape, so "
            "the funds that listed before 2014 and closed before 2014 "
            "are absent altogether: on the catalogue's OWN post-2014 "
            "closure rates its own pre-2014 cohorts should have produced "
            "222 to 479 closures it does not carry. This panel can "
            "therefore be made survivorship-free from 2014 forward and "
            "never for 2005-2013, which is the first nine years of every "
            "result in this repository."
        ),
        licence=_TIINGO_LICENCE,
        redistributable=False,
        question=(
            "What would a multi-asset allocation of exchange-traded "
            "funds actually have returned, after costs?"
        ),
        cannot=(
            "Date a delisting, be joined on a ticker as of a past date, "
            "or see a fund that died before 2014. Four of the twelve "
            "dead funds' final prints carry ZERO VOLUME — the tape ends "
            "on a frozen halt mark, not a trade — so a last bar is not a "
            "delisting date. A renamed fund keeps its history and loses "
            "its old symbol: there is no RYT, JKD, ITE or QQQQ in the "
            "directory, while RSPT's bars start 2006-11-07. And 70 "
            "symbols were RELEASED AND REISSUED, so a dead fund can be "
            "standing behind a ticker that trades today, unreachable at "
            "any price, because the endpoint serves one series per "
            "string. Every string here is today's name for a series, "
            "never what it traded under on the date of the bar."
        ),
        frames=(
            FrameRef("tiingo-sleeve-etf", "prices"),
            FrameRef("tiingo-sleeve-etf", "security_master"),
            FrameRef("tiingo-sleeve-etf", "actions"),
        ),
        needs_key="TIINGO_API_KEY",
        notes=(
            "Shares its cache slug with `keyedsleeves.py` and "
            "`deadetfs.py` on purpose — same vendor, same endpoint, same "
            "parse, so a name is fetched once and read by all three and "
            "the recovered dead bars land here rather than under a row "
            "of their own. The free tier meters SYMBOLS rather than "
            "requests: measured again at 46 fresh names before a 429, "
            "which makes the 1,677-fund acquisition plan a 34-hour job "
            "and is why it is resumable by construction."
        ),
    ),
    Dataset(
        key="tiingo_directory",
        title="Tiingo supported-ticker directory",
        publisher="Tiingo",
        module="griffinquant.data.etfuniverse",
        endpoint="apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip",
        contains=(
            "~108,000 rows: ticker, exchange, asset type, currency, and "
            "the first and last dates of coverage for every symbol the "
            "vendor serves."
        ),
        true_start="coverage windows reach back to 1962 for the oldest series",
        cadence="rebuilt daily; served openly with no token",
        survivorship=SURVIVORSHIP_OURS,
        survivorship_basis=(
            "OURS from 2014, BIASED before it, and the field holds one "
            "value so read the date. An `end_date` in the past is the "
            "vendor saying a name stopped, which is what makes retention "
            "measurable at all — but the record of stopping begins "
            "around 2014 and is thin to the point of absence before it. "
            "Across every asset type the file records 55 delistings in "
            "2009 and 1,969 in 2016; for ETFs alone, one in 2010 and 253 "
            "in 2020. Two named absences bound the rest: GEX, BJK, SCIF "
            "and FEU are real ETFs it does not list, re-checked by "
            "`absence_report` on every run, and 70 shelf symbols were "
            "reissued to a second fund, so the file's own key is not "
            "unique through time."
        ),
        licence="Served openly with no token; the bars it describes are not redistributable.",
        redistributable=False,
        question=(
            "Does this symbol resolve, is it a fund, is it priced in "
            "dollars, and from what date is there data?"
        ),
        cannot=(
            "Report a fund's real name, preserve a symbol through a "
            "rename, or tell you which of two funds a reissued ticker "
            "means on a given date. It also cannot reach the funds that "
            "died before its retention began: an ETF listed in 2006 and "
            "wound up in 2009 has no row here at all, and no amount of "
            "pulling recovers a name the catalogue never carried. It is "
            "a snapshot — today's directory, not the directory as it "
            "stood on a past date."
        ),
        frames=(FrameRef("tiingo-directory", "directory"),),
    ),
)


def keys() -> list[str]:
    return list(DATASETS)


def entries() -> list[Dataset]:
    """Every dataset, in registry order."""
    return list(DATASETS.values())


def entry(key: str) -> Dataset:
    try:
        return DATASETS[key]
    except KeyError:
        raise KeyError(
            f"{key!r} is not in the catalogue. Known keys: {sorted(DATASETS)}"
        ) from None


def by_survivorship(state: str) -> list[Dataset]:
    if state not in SURVIVORSHIP_STATES:
        raise ValueError(
            f"{state!r} is not a survivorship state; the four are "
            f"{list(SURVIVORSHIP_STATES)}"
        )
    return [d for d in DATASETS.values() if d.survivorship == state]


def by_module(module: str) -> list[Dataset]:
    """Everything one acquisition module is responsible for.

    Accepts a bare module name as well as the dotted path, because the
    caller usually has "edgarbulk" in hand and not the whole prefix.
    """
    needle = module.strip()
    return [
        d
        for d in DATASETS.values()
        if d.module == needle or d.module.rsplit(".", 1)[-1] == needle
    ]


def requiring_key() -> list[Dataset]:
    """Datasets that cannot be pulled without a credential we hold.

    One key, one dataset family. Worth being able to ask, because it is
    the answer to "what stops working if the token is revoked".
    """
    return [d for d in DATASETS.values() if d.needs_key]


# -- what is actually on disk ---------------------------------------------


@dataclass(frozen=True)
class CacheEntry:
    """One sidecar and the parquet it commits, read without opening either."""

    source: str
    frame: str
    params: Mapping[str, Any]
    rows: int
    bytes: int
    path: Path


@dataclass(frozen=True)
class Usage:
    """What one dataset occupies. Zero is a real answer, not a missing one."""

    key: str
    entries: int = 0
    rows: int = 0
    bytes: int = 0
    raw_files: int = 0
    raw_bytes: int = 0
    #: Of the above, how much is yesterday's copy of the same request.
    #: See `superseded` — several sources key their entry on the date
    #: the pull ran through, so a second day leaves both on disk and
    #: `rows` counts a great many observations twice.
    superseded_entries: int = 0
    superseded_rows: int = 0
    superseded_bytes: int = 0

    @property
    def total_bytes(self) -> int:
        return self.bytes + self.raw_bytes

    @property
    def distinct_rows(self) -> int:
        """Rows once each superseded copy is set aside."""
        return self.rows - self.superseded_rows

    @property
    def megabytes(self) -> float:
        return self.total_bytes / 1_048_576.0


def scan(root: Path | str = DEFAULT_ROOT) -> list[CacheEntry]:
    """Every complete cache entry under `root`, from its sidecar alone.

    The sidecar is written last and renamed into place, so its presence
    is what makes an entry complete — reading the parquet to count rows
    would be slower, would open several hundred files, and would report
    an interrupted write as a dataset rather than as bytes.
    """
    base = Path(root)
    if not base.is_dir():
        return []

    out: list[CacheEntry] = []
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        for side in sorted(directory.glob("*.json")):
            try:
                meta = json.loads(side.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(meta, dict):
                continue
            frame_path = side.with_suffix(".parquet")
            size = _size(side) + _size(frame_path)
            out.append(
                CacheEntry(
                    source=str(meta.get("source", directory.name)),
                    frame=str(meta.get("frame", "")),
                    params=dict(meta.get("params") or {}),
                    rows=int(meta.get("rows") or 0),
                    bytes=size,
                    path=frame_path,
                )
            )
    return out


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _raw_usage(root: Path | str, dirs: Iterable[str]) -> tuple[int, int]:
    base = Path(root).parent
    files = 0
    size = 0
    for name in dirs:
        d = base / name
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix != ".tmp":
                files += 1
                size += _size(p)
    return files, size


def _refs_by_specificity() -> list[tuple[str, FrameRef]]:
    """Every (dataset key, frame ref), most specific first.

    Specific before general so a ref naming one workbook cannot be
    beaten to its own bytes by a ref claiming the whole frame. Registry
    order breaks ties, which makes attribution deterministic — a usage
    table that reshuffles between runs is one nobody can diff.
    """
    pairs = [
        (dataset.key, ref)
        for dataset in DATASETS.values()
        for ref in dataset.frames
    ]
    ordered = sorted(
        enumerate(pairs), key=lambda item: (-item[1][1].specificity, item[0])
    )
    return [pair for _, pair in ordered]


#: The one parameter name that means "the pull ran through here" rather
#: than "this is what was asked for". Named explicitly rather than
#: sniffed out of the values: `fred_vintage` is keyed on a `vintage`
#: date that IS part of the request, and a rule that dropped every
#: date-shaped parameter would report sixteen of seventeen archived
#: vintages as stale copies of one.
ASOF_PARAM = "end"


def _request_of(item: CacheEntry) -> str:
    """What was asked for, with the as-of date taken out.

    Two entries with the same request and different `end` are the same
    pull on two different days. Both are on disk because the date is in
    the cache key — which is correct behaviour and the reason a
    same-day rerun is free — and only one of them is current.
    """
    stable = {k: v for k, v in item.params.items() if k != ASOF_PARAM}
    return json.dumps(
        {"source": item.source, "frame": item.frame, "params": stable},
        sort_keys=True,
        default=str,
    )


def _superseded_flags(found: Sequence[CacheEntry]) -> list[bool]:
    """True for every entry a later pull of the same request replaced."""
    newest: dict[str, str] = {}
    for item in found:
        request = _request_of(item)
        asof = str(item.params.get(ASOF_PARAM, ""))
        # Insert unconditionally, then take the later. Comparing before
        # inserting drops every request whose as-of is the empty string
        # — which is most of them, since only the date-keyed families
        # carry one — and the second pass then raises on its own data.
        newest[request] = max(newest.setdefault(request, asof), asof)
    return [
        str(item.params.get(ASOF_PARAM, "")) < newest[_request_of(item)]
        for item in found
    ]


def usage(root: Path | str = DEFAULT_ROOT) -> dict[str, Usage]:
    """Disk and rows per dataset, attributed exactly once.

    Every dataset appears in the result whether or not it has been
    pulled: an absent key would be indistinguishable from a key nobody
    thought of, and the whole point of an inventory is that the empty
    rows are visible.

    `rows` is rows ON DISK and not distinct observations. Where a source
    keys its cache on the date it pulled through, a second day's run
    leaves both copies and this counts both — deliberately, because the
    figure is meant to explain the bytes. `distinct_rows` is the other
    number and `superseded` names the entries that separate them.
    """
    found = scan(root)
    stale = _superseded_flags(found)
    refs = _refs_by_specificity()

    tally: dict[str, list[int]] = {key: [0, 0, 0, 0, 0, 0] for key in DATASETS}
    for item, is_stale in zip(found, stale):
        for key, ref in refs:
            if ref.matches({"source": item.source, "frame": item.frame,
                            "params": item.params}):
                counts = tally[key]
                counts[0] += 1
                counts[1] += item.rows
                counts[2] += item.bytes
                if is_stale:
                    counts[3] += 1
                    counts[4] += item.rows
                    counts[5] += item.bytes
                break

    out: dict[str, Usage] = {}
    for key, dataset in DATASETS.items():
        entries_n, rows, size, old_n, old_rows, old_bytes = tally[key]
        raw_files, raw_bytes = _raw_usage(root, dataset.raw_dirs)
        out[key] = Usage(
            key=key,
            entries=entries_n,
            rows=rows,
            bytes=size,
            raw_files=raw_files,
            raw_bytes=raw_bytes,
            superseded_entries=old_n,
            superseded_rows=old_rows,
            superseded_bytes=old_bytes,
        )
    return out


def superseded(root: Path | str = DEFAULT_ROOT) -> pd.DataFrame:
    """Entries a later pull of the same request has replaced.

    Not deleted, and not deleted automatically. A saved pull is the one
    thing a reviewer with no key can rerun a report from, so an old
    vintage of a series is evidence rather than litter — the point of
    naming them is that "rows on disk" can then be read honestly, and
    that anyone short of space knows exactly what is safe to clear.
    """
    found = scan(root)
    stale = _superseded_flags(found)
    rows = [
        {
            "source": item.source,
            "frame": item.frame,
            "asof": str(item.params.get(ASOF_PARAM, "")),
            "rows": item.rows,
            "bytes": item.bytes,
        }
        for item, is_stale in zip(found, stale)
        if is_stale
    ]
    frame = pd.DataFrame(rows, columns=["source", "frame", "asof", "rows", "bytes"])
    if frame.empty:
        return frame
    return (
        frame.groupby(["source", "frame", "asof"], as_index=False)
        .agg(entries=("rows", "size"), rows=("rows", "sum"), bytes=("bytes", "sum"))
        .sort_values("bytes", ascending=False)
        .reset_index(drop=True)
    )


def unattributed(root: Path | str = DEFAULT_ROOT) -> pd.DataFrame:
    """Cache entries no catalogue row claims.

    The check that stops this file becoming decorative. A dataset
    acquired next month and never registered here would sit on disk
    unmentioned, and the inventory would read as complete — so the
    unclaimed bytes are a query anyone can run rather than a promise
    that somebody remembered.
    """
    refs = _refs_by_specificity()
    rows: list[dict[str, Any]] = []
    for item in scan(root):
        meta = {"source": item.source, "frame": item.frame, "params": item.params}
        if any(ref.matches(meta) for _, ref in refs):
            continue
        rows.append(
            {
                "source": item.source,
                "frame": item.frame,
                "params": json.dumps(item.params, sort_keys=True),
                "rows": item.rows,
                "bytes": item.bytes,
            }
        )
    frame = pd.DataFrame(
        rows, columns=["source", "frame", "params", "rows", "bytes"]
    )
    if frame.empty:
        return frame
    return (
        frame.groupby(["source", "frame"], as_index=False)
        .agg(entries=("rows", "size"), rows=("rows", "sum"), bytes=("bytes", "sum"))
        .sort_values("bytes", ascending=False)
        .reset_index(drop=True)
    )


def totals(root: Path | str = DEFAULT_ROOT) -> dict[str, Any]:
    """Headline figures for the whole cache, attributed and not."""
    used = usage(root)
    stray = unattributed(root)
    raw_dirs = {d for dataset in DATASETS.values() for d in dataset.raw_dirs}
    raw_files, raw_bytes = _raw_usage(root, sorted(raw_dirs))
    parquet_bytes = sum(u.bytes for u in used.values())
    return {
        "datasets": len(used),
        "populated": sum(1 for u in used.values() if u.entries),
        "entries": sum(u.entries for u in used.values()),
        "rows": sum(u.rows for u in used.values()),
        "distinct_rows": sum(u.distinct_rows for u in used.values()),
        "superseded_entries": sum(u.superseded_entries for u in used.values()),
        "superseded_bytes": sum(u.superseded_bytes for u in used.values()),
        "parquet_bytes": parquet_bytes,
        "raw_files": raw_files,
        "raw_bytes": raw_bytes,
        "total_bytes": parquet_bytes + raw_bytes,
        "unattributed_entries": (
            0 if stray.empty else int(stray["entries"].sum())
        ),
        "unattributed_bytes": 0 if stray.empty else int(stray["bytes"].sum()),
    }


# -- frames and tables ----------------------------------------------------


def frame(root: Path | str | None = DEFAULT_ROOT) -> pd.DataFrame:
    """The catalogue as a DataFrame, with usage merged in when given a root.

    `root=None` returns the registry alone. That is the form to use in a
    test or on a machine with no cache: the honest fields are all
    intrinsic to the source, and only the three disk columns depend on
    what happens to have been pulled.
    """
    used = usage(root) if root is not None else {}
    rows = []
    for dataset in DATASETS.values():
        row: dict[str, Any] = {
            "key": dataset.key,
            "title": dataset.title,
            "publisher": dataset.publisher,
            "module": dataset.module,
            "endpoint": dataset.endpoint,
            "contains": dataset.contains,
            "true_start": dataset.true_start,
            "cadence": dataset.cadence,
            "survivorship": dataset.survivorship,
            "survivorship_label": dataset.survivorship_label,
            "survivorship_basis": dataset.survivorship_basis,
            "licence": dataset.licence,
            "redistributable": dataset.redistributable,
            "question": dataset.question,
            "cannot": dataset.cannot,
            "needs_key": dataset.needs_key,
            "notes": dataset.notes,
        }
        if root is not None:
            u = used[dataset.key]
            row.update(
                cache_entries=u.entries,
                cache_rows=u.rows,
                cache_bytes=u.bytes,
                raw_files=u.raw_files,
                raw_bytes=u.raw_bytes,
                megabytes=round(u.megabytes, 2),
            )
        rows.append(row)
    return pd.DataFrame(rows)


def human_bytes(n: int | float) -> str:
    """Sizes a person can compare at a glance.

    Deliberately not `f"{n:,}"`. An inventory whose disk column runs
    from 3,072 to 31,457,280 is a column nobody scans; the interesting
    comparison is between two datasets, and it has to survive being read
    quickly.
    """
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if abs(value) < 1024.0 or unit == "GB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} GB"  # pragma: no cover - loop always returns


def render_table(root: Path | str | None = DEFAULT_ROOT) -> str:
    """The inventory as a padded pipe table.

    Imported late because `util.runs` reaches back into `data` for the
    source contract, and a data module importing the reporting layer at
    module scope is a cycle waiting for the next person to trip over.
    """
    from ..util.runs import table

    used = usage(root) if root is not None else {}
    headers = ["Dataset", "Source", "Starts", "Cadence", "Surv."]
    aligns = ["l", "l", "l", "l", "l"]
    if root is not None:
        headers += ["Cached", "On disk"]
        aligns += ["r", "r"]

    rows: list[list[str]] = []
    for dataset in DATASETS.values():
        row = [
            dataset.key,
            _short_publisher(dataset.publisher),
            _short_start(dataset.true_start),
            _short_cadence(dataset.cadence),
            dataset.survivorship_label,
        ]
        if root is not None:
            u = used[dataset.key]
            row += [_cached_count(dataset, u), human_bytes(u.total_bytes)]
        rows.append(row)
    return table(headers, rows, aligns)


def _cached_count(dataset: Dataset, u: Usage) -> str:
    """Rows for a frame, files for a blob, and never the two confused.

    A workbook caches as ONE row holding its own bytes. Printing that 1
    in a column beside seven million French observations reads as a
    parse that silently dropped everything, and somebody would go and
    look. "1 file" says what happened.
    """
    if dataset.cached_as == "blob":
        return f"{u.entries} file" + ("" if u.entries == 1 else "s")
    return f"{u.rows:,}"


def _short_publisher(text: str) -> str:
    return text.split(",", 1)[0].split("(", 1)[0].strip()


#: A summary cell wider than this stops being a summary and starts
#: pushing every other column off the terminal.
_CELL_WIDTH = 30


def _short_start(text: str) -> str:
    """The date out of a sentence about a date.

    These fields say things like "1926-01-26 (short-term reversal,
    daily) — the headline factors from 1926-07", because the true start
    is genuinely a paragraph for half of them. A summary table needs the
    leading token and a reader needs the paragraph, so both exist — and
    where there is no leading token, the cell is truncated visibly
    rather than allowed to widen the table to the length of an
    explanation.
    """
    head = text.split("(", 1)[0].split("—", 1)[0].split(";", 1)[0]
    return _clip(head.strip().rstrip(",") or text)


def _short_cadence(text: str) -> str:
    return _clip(text.split(",", 1)[0].split(";", 1)[0].split("—", 1)[0].strip())


def _clip(text: str, width: int = _CELL_WIDTH) -> str:
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def describe(key: str, root: Path | str | None = DEFAULT_ROOT) -> str:
    """One dataset in full, for somebody deciding whether to build on it."""
    d = entry(key)
    lines = [
        f"{d.key} — {d.title}",
        f"  Publisher:     {d.publisher}",
        f"  Module:        {d.module}",
        f"  Endpoint:      {d.endpoint}",
        f"  Contains:      {d.contains}",
        f"  True start:    {d.true_start}",
        f"  Updates:       {d.cadence}",
        f"  Survivorship:  {d.survivorship_label} — {d.survivorship_basis}",
        f"  Licence:       {d.licence}",
        f"  Redistribute:  {_redistribution(d.redistributable)}",
        f"  Key required:  {d.needs_key or 'none — keyless'}",
        f"  Answers:       {d.question}",
        f"  CANNOT:        {d.cannot}",
    ]
    if d.notes:
        lines.append(f"  Notes:         {d.notes}")
    if root is not None:
        u = usage(root)[d.key]
        lines.append(
            f"  On disk:       {u.entries} entries, {u.rows:,} rows, "
            f"{human_bytes(u.total_bytes)}"
        )
    return "\n".join(lines)


def _redistribution(flag: bool | None) -> str:
    if flag is True:
        return "yes"
    if flag is False:
        return "NO — internal research and citation only"
    return "per series; check the row before publishing"


# -- what a credential we do not hold would buy ---------------------------


@dataclass(frozen=True)
class Blocked:
    """A source ruled out by the no-account rule, documented and stopped.

    The rule is that we do not sign up for anything on anyone's behalf,
    and the discipline that makes the rule survivable is writing down
    what was behind the door before walking away. Otherwise the same
    source gets rediscovered, re-probed and re-abandoned every quarter.
    """

    name: str
    endpoint: str
    would_give: str
    wall: str
    verified: str = "2026-08-02"


BLOCKED: tuple[Blocked, ...] = (
    Blocked(
        name="Nasdaq Data Link",
        endpoint="data.nasdaq.com/api/v3/datatables",
        would_give=(
            "Sharadar Core US Equities — the survivorship-free "
            "single-name panel this whole repository is shaped around, "
            "plus free tables such as LBMA gold."
        ),
        wall=(
            "403 keyless on every table including the free ones. Every "
            "table needs a registered key, and Sharadar itself is a paid "
            "subscription on top of that."
        ),
    ),
    Blocked(
        name="US Energy Information Administration",
        endpoint="api.eia.gov/v2",
        would_give="Weekly petroleum inventories, natural gas storage, electricity.",
        wall="403 API_KEY_MISSING. Free key, but it needs an account.",
    ),
    Blocked(
        name="Bureau of Economic Analysis",
        endpoint="apps.bea.gov/api/data",
        would_give="GDP components, personal income, trade, at source.",
        wall=(
            "Key requires registration — and the headline series land in "
            "FRED anyway, so the cost of this one is close to zero."
        ),
    ),
    Blocked(
        name="US Census timeseries",
        endpoint="api.census.gov/data/timeseries/eits",
        would_give="Retail sales, manufacturing shipments, construction.",
        wall=(
            "Now answers 'Missing Key' keyless. FRED's RSAFS covers the "
            "headline retail number."
        ),
    ),
    Blocked(
        name="BLS API v2",
        endpoint="api.bls.gov/publicAPI/v2",
        would_give="500 queries a day and 20-year windows instead of 25 and 10.",
        wall="v2 needs a registered key. v1 is keyless and was verified working.",
    ),
    Blocked(
        name="Alpha Vantage adjusted daily",
        endpoint="alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED",
        would_give="A second adjusted-close vendor, for reconciliation.",
        wall=(
            "The adjusted function is premium; the free key answers 200 "
            "with a body explaining that. A free key is also 25 requests "
            "a day, so a 142-name pull is not slower there, it is "
            "impossible."
        ),
    ),
)


@dataclass(frozen=True)
class Prospect:
    """Free, verified reachable, and not acquired. The honest backlog.

    Kept in the catalogue rather than in a to-do list because the
    question these answer is usually asked as "is there anything free
    for X", and the answer is worth more when it says what was tried and
    what it costs.
    """

    name: str
    endpoint: str
    gives: str
    caveat: str
    verified: str = "2026-08-02"


PROSPECTS: tuple[Prospect, ...] = (
    Prospect(
        name="Cboe volatility complex",
        endpoint="cdn.cboe.com/api/global/us_indices/daily_prices/",
        gives=(
            "VIX from 1990-01-02, SKEW from 1990, VVIX from 2006-03, "
            "VIX3M from 2009-09, VIX9D from 2011-01. Keyless CSV."
        ),
        caveat=(
            "Index level. Tradable only through an ETP, whose roll cost "
            "is the whole story and is not in these files."
        ),
    ),
    Prospect(
        name="Cboe VX futures settlements",
        endpoint="cdn.cboe.com/data/us/futures/market_statistics/historical_data/VX/",
        gives="Per-expiry daily settlement, so a real term structure and roll yield.",
        caveat=(
            "2013 expiries onward. 2012 and 2005 answer 403 — the "
            "pre-2013 history is simply not served publicly."
        ),
    ),
    Prospect(
        name="FINRA Reg SHO daily short volume",
        endpoint="cdn.finra.org/equity/regsho/daily/",
        gives="Per-symbol off-exchange short volume, FNSQ verified from 2009-08.",
        caveat=(
            "This is off-exchange short VOLUME — a biased ~40% slice of "
            "consolidated volume — and NOT short interest. It is one of "
            "the most widely misread datasets in retail finance. Usable "
            "as a relative cross-sectional signal and nothing else. "
            "Consolidated CNMS 403s before ~2020, so deep history needs "
            "the per-market files stitched."
        ),
    ),
    Prospect(
        name="FINRA short interest",
        endpoint="api.finra.org/data/group/otcMarket/name/consolidatedShortInterest",
        gives="Twice-monthly short interest with settlement-date snapshots.",
        caveat=(
            "Point-in-time by construction, which is rare and valuable. "
            "History depth unverified; sorting needs partition keys, so "
            "filter by date via POST."
        ),
    ),
    Prospect(
        name="CFTC Commitments of Traders",
        endpoint="publicreporting.cftc.gov (Socrata) + history zips from 1986",
        gives="Weekly futures positioning by trader category.",
        caveat="The club trades equities; this is regime-overlay value at best.",
    ),
    Prospect(
        name="OFR Financial Stress Index",
        endpoint="financialresearch.gov/financial-stress-index/data/fsi.csv",
        gives="Daily stress index from 2000, keyless, clean.",
        caveat="Re-estimated history, so the same vintage problem as NFCI.",
    ),
    Prospect(
        name="US Treasury daily yield curve",
        endpoint="home.treasury.gov — daily-treasury-rates.csv per year",
        gives="All 13 tenors on one row, from the primary source.",
        caveat=(
            "Largely duplicates FRED's DGS series. The all-years URL "
            "403s from a script; loop one year at a time."
        ),
    ),
    Prospect(
        name="Nasdaq Trader symbol directory",
        endpoint="nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
        gives=(
            "Today's listed universe, and via Wayback snapshots a "
            "reconstruction of past listings at irregular cadence."
        ),
        caveat=(
            "Irregular cadence means the reconstruction has holes, and a "
            "universe with holes is a universe that quietly drops names."
        ),
    ),
    Prospect(
        name="World Bank / IMF / OECD / BLS v1",
        endpoint="api.worldbank.org, api.imf.org/external/sdmx/2.1, sdmx.oecd.org",
        gives="International macro; the OECD composite leading indicator is the useful one.",
        caveat=(
            "FRED already carries most headline series. Note the old "
            "dataservices.imf.org is DEAD — DNS is gone — so anything "
            "citing it is broken."
        ),
    ),
    Prospect(
        name="Crypto spot history",
        endpoint="Bitstamp (2011-09), Coinbase Exchange (2015)",
        gives="Daily BTC-USD back to 2011 without a key.",
        caveat=(
            "Exchanges list surviving pairs only. Spot bitcoin ETFs date "
            "from January 2024, so this history cannot validate an ETF "
            "strategy. Binance is 451 from US addresses — do not retry."
        ),
    ),
)


# -- what remains impossible ----------------------------------------------


@dataclass(frozen=True)
class Limit:
    """One question this inventory cannot answer, and why not.

    Written as a closed list rather than as prose so that the report and
    the module cannot drift, and so that anyone proposing a project can
    check it against something concrete before writing code against a
    dataset that will not carry it.
    """

    title: str
    body: str


#: Ordered by what the gap costs, not by how interesting it is. The
#: first entry is the one that shapes everything this repository is
#: allowed to claim.
LIMITS: tuple[Limit, ...] = (
    Limit(
        title="Single-name strategies, over any full market cycle",
        body=(
            "No source in this inventory carries prices for companies "
            "that stopped trading before roughly 2014, so a "
            "survivorship-free backtest of a stock-picking rule across a "
            "full cycle cannot be run. Not approximately, not with "
            "caveats. The names that would have hurt are not in the "
            "data, and no downstream check can see that they are "
            "missing — it arrives as a slightly smaller universe and a "
            "slightly better Sharpe.\n\n"
            "The parts, so the shape of the hole is legible. EDGAR knows "
            "which companies died and when, and carries no price of any "
            "kind. French's portfolios are survivorship-free and are "
            "portfolio aggregates with no constituents. Tiingo does "
            "serve delisted single names, and the floor is measurable "
            "off the directory we already hold rather than a matter of "
            "opinion: of 24,178 US-exchange USD series, 10,135 have "
            "ended, and 8,028 of those are common stock. **Eight of the "
            "8,028 end before 2009.** The annual count of dead stocks "
            "stays under 150 through 2013 — 41 in 2009, 56 in 2012, 142 "
            "in 2013 — and then runs 300 to 1,200 a year from 2014 "
            "onward. So a cross-section with a realistic failure rate in "
            "it begins in 2014 and there is nothing before it.\n\n"
            "Even after 2014, three things stand between that and a "
            "study. The free tier meters roughly 50 symbols an hour, so "
            "a 2,000-name universe is a months-long polite acquisition. "
            "Corporate-action quality on dead names is unaudited. And "
            "the directory loses renamed symbols outright, so a "
            "point-in-time join on ticker joins on a fact that was not "
            "true then.\n\n"
            "CRSP or Sharadar closes this and both are paid. That has "
            "been decided against, twice. The consequence is written "
            "here rather than left to be rediscovered: this repository "
            "can test allocation, timing and factor questions honestly "
            "over twenty years and stock selection over none of them. "
            "The one thing that would change the answer without spending "
            "anything is a post-2014 single-name acquisition against the "
            "Tiingo key, which nobody has built and which would still "
            "have no 2008 in it."
        ),
    ),
    Limit(
        title="Delisting returns — what a holder actually received",
        body=(
            "EDGAR dates a death and never prices it. An acquisition at "
            "a 40% premium and a wind-up at zero produce the same Form "
            "25 row. Reading a delisting as a total loss makes every "
            "strategy that held the name look worse than it was; "
            "dropping the name at its last print makes it look better. "
            "Both are wrong and there is no free source of the answer. "
            "Even for the twelve dead ETFs we do hold, four final prints "
            "carry zero volume, so the tape ends on a frozen halt mark "
            "rather than a trade."
        ),
    ),
    Limit(
        title="Historical index membership",
        body=(
            "Nothing free carries S&P 500, Russell or any other index's "
            "constituents as of a past date. So a benchmark-relative "
            "study, an index-addition event study, or any universe "
            "defined by membership is out of reach. The project's own "
            "answer is to define the universe by tradability rather than "
            "membership, which is a better design in any case — but it "
            "means we cannot cross-check against an index-based universe "
            "even once."
        ),
    ),
    Limit(
        title="Anything intraday, and anything about the order book",
        body=(
            "Every price series here is end of day. No spreads, no "
            "depth, no quotes, no trade prints, no borrow rates and no "
            "shortability. That is why the cost model in `costs.py` is a "
            "prior lifted from the literature rather than a measurement, "
            "and why results are reported at one, two and three times "
            "it. It is also why every long-short result — including "
            "every Fama/French factor — silently assumes a costless "
            "short that nobody could have put on in the small-cap corner "
            "where much of the premium lives."
        ),
    ),
    Limit(
        title="Historical option quotes and implied volatility surfaces",
        body=(
            "Not free, anywhere, full stop. Cboe publishes the VIX "
            "complex as indices back to 1990 and VX futures settlements "
            "from 2013 expiries, which supports term-structure and "
            "regime work at the index level. It does not support pricing "
            "or backtesting an options position, and the current "
            "put/call ratio files are frozen at 2019-10-04."
        ),
    ),
    Limit(
        title="Point-in-time fundamentals with a full restatement history",
        body=(
            "DERA is as-filed, which is close to point-in-time and is "
            "the best free answer there is. What it does not give is a "
            "clean as-reported-versus-restated distinction: amendments "
            "arrive as later filings and must be reconciled explicitly, "
            "and companyfacts serves only the latest vintage. So a "
            "quality or accruals factor can be built honestly with care, "
            "and cannot be built naively at all."
        ),
    ),
    Limit(
        title="Macro as-of dates before the archive starts",
        body=(
            "ALFRED does not reach as far back as FRED's data. A 2012 "
            "vintage of DTWEXBGS or BAA10Y is a 404 and STLFSI4 has no "
            "vintage before 2023, so for early history the stated "
            "publication lag is the only answer and it cannot be "
            "checked. STLFSI4 is the sharpest case: continuously "
            "re-estimated history AND no record of what it used to say."
        ),
    ),
    Limit(
        title="Corporate credit spreads through a credit cycle",
        body=(
            "The ICE BofA series on FRED — BAMLH0A0HYM2 and BAMLC0A0CM "
            "— returned 787 and 786 observations starting 2023-08-01 "
            "when pulled on 2026-08-02, for indices documented back to "
            "1996. Asking explicitly for 2008 returns the same rows. "
            "There is no 2008 and no 2020 on this source. BAA10Y "
            "(Moody's Baa minus the 10-year, 1986 onward) is carried as "
            "the long-history stand-in and is NOT an option-adjusted "
            "spread; the two must never be spliced."
        ),
    ),
    Limit(
        title="Anything company-level before 1993, or outside the US",
        body=(
            "EDGAR's electronic archive begins in 1993 and paper filings "
            "before it are neither free nor online. Non-US coverage in "
            "this inventory is limited to index-level macro from the "
            "World Bank, IMF and OECD, none of which is acquired. "
            "Shiller and Damodaran reach 1871 and 1928 respectively and "
            "are US index levels with no cross-section at all."
        ),
    ),
    Limit(
        title="A survivorship-free ETF universe, as opposed to a measured one",
        body=(
            "The 154-fund list was written by a person looking at funds "
            "that mostly still trade. The vendor retains its dead — "
            "26.7% of its ETF rows end in the past and their bars are "
            "served — so this is fixable by adding names, and until "
            "somebody does, the panel's survivorship bias is real, is "
            "ours, and is bounded only by the twelve closed funds "
            "carried as evidence."
        ),
    ),
)


def limits_text() -> str:
    """`LIMITS` as plain prose, for a console or a plain-text report."""
    blocks = []
    for limit in LIMITS:
        blocks.append(f"{limit.title}\n{'-' * len(limit.title)}\n{limit.body}")
    return "\n\n".join(blocks)


def blocked_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "name": b.name,
                "endpoint": b.endpoint,
                "would_give": b.would_give,
                "wall": b.wall,
                "verified": b.verified,
            }
            for b in BLOCKED
        ]
    )


def prospects_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "name": p.name,
                "endpoint": p.endpoint,
                "gives": p.gives,
                "caveat": p.caveat,
                "verified": p.verified,
            }
            for p in PROSPECTS
        ]
    )


