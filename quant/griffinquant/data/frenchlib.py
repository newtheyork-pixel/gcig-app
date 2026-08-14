"""The Kenneth French data library: the only survivorship-free panel
this project can have for nothing.

It is built from CRSP — the paid database we have ruled out buying —
and French publishes the derived portfolios at no charge. That is the
whole reason this file exists. Everywhere else in this repository the
honest answer to "is this survivorship-free?" is no, or unprovable; a
free quote endpoint only answers for symbols that still resolve today,
so the dead names are not missing from the data, they were never
reachable through the transport. CRSP retains the delisted names and
carries the delisting return, and French's sorts are formed from every
stock that met the criterion ON THE FORMATION DATE rather than from
the ones that survived to today. So these series let us ask whether a
factor actually worked, and when it stopped working, against clean
data — rather than inferring it from ETF launch dates, which is
survivorship bias wearing a product's clothes.

**These returns cannot be traded, and that is not a quibble.** They
are academic portfolios: no transaction costs, no bid-ask spread, no
market impact, no capacity limit, no borrow cost on the short leg, and
rebalancing assumed frictionless at the sort dates. The small-cap and
microcap corners of a size sort hold names whose real round-trip cost
would eat a large part of the published premium. Use these to test
whether a premium EXISTED. Never present a French portfolio return as
a return anyone earned, and never wire one into a backtest as a
tradable sleeve.

**The trap this module exists to handle is the file layout.** Every
file is a zipped CSV with a prose header of unpredictable length, then
one or more tables, each introduced by a caption of one to five prose
lines and a header row whose first field is empty — and a table's rows
can switch period WITHIN the file, from monthly to annual, with no
warning beyond the width of the date token. `pd.read_csv(skiprows=3)`
appears to work on the three-factor file and quietly reads the annual
block as if it were monthly. So the file is scanned line by line: a
header row starts a table, a run of prose above it is its caption, and
a data block ends either at a non-data line or at a change in the date
token's width. Nothing is assumed about how many rows precede anything.

**Percent is divided out here, once.** French publishes 2.89 to mean
2.89%, and the single commonest error using this library is forgetting
to divide by 100. Every return table is divided by 100 on the way out
and the resulting frame says so in `units`. Tables that are NOT
returns — "Number of Firms in Portfolios", "Average Firm Size",
"Sum of BE / Sum of ME" — are left alone, because dividing a firm
count by a hundred is the same error running the other way.

The order matters more than either step: the missing-data codes
(-99.99 and -999) are turned into NaN BEFORE the division. Divide
first and -99.99 becomes -0.9999, which is not obviously wrong. It is
a 99.99% loss, and a 99.99% loss in a factor series looks like a
finding.
"""

from __future__ import annotations

import csv
import io
import re
import time
import zipfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from .base import SourceUnavailable
from .cache import DEFAULT_ROOT, ParquetCache

BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"

#: A real address, because a university web server hosting a public
#: good is entitled to know who is pulling ten megabytes off it and to
#: mail us if we become a nuisance. An anonymous scraper UA is how a
#: free source stops being free for everybody.
USER_AGENT = (
    "GriffinFund-Research/0.1 (academic factor research; newtheyork@gmail.com)"
)

#: French documents both, in the prose header of nearly every file.
#: Matched with a tolerance because they arrive as text and round-trip
#: through float; an exact == on a parsed decimal is a coin flip.
MISSING_CODES: tuple[float, ...] = (-99.99, -999.0)
_MISSING_TOLERANCE = 1e-9

PERCENT = 100.0

#: What a frame's `units` says about itself. The string travels with
#: the data into the cache and out again, so a reader who did not
#: write this file can still tell whether the number in front of them
#: has already been divided.
DECIMAL_RETURN = "decimal_return"
RAW = "raw"

#: Not a published rate limit — French publishes none. It is a
#: judgement about what a polite client looks like against a
#: university web server serving multi-megabyte archives: eighteen
#: files, two seconds apart, once a week, cached forever after.
MIN_REQUEST_INTERVAL_SECONDS = 2.0
DEFAULT_TIMEOUT = 120.0
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 4.0
BACKOFF_CAP_SECONDS = 30.0

#: 429 and the 5xx range. A 404 is never retried: it is an answer, and
#: on this server it means the file was renamed rather than that the
#: server is unwell.
RETRY_STATUSES = frozenset({429, *range(500, 512)})

#: One frame kind for the whole library, so `default_cache` can give it
#: a life measured against how often French rebuilds — monthly, from a
#: new CRSP cut. A week is the compromise: never more than a few days
#: behind a release, and never a second download in an afternoon.
CACHE_FRAME = "french_library"
CACHE_SOURCE = "kenneth-french"
CACHE_TTL_DAYS = 7.0


# -- what can go wrong ----------------------------------------------------


class FrenchUnavailable(SourceUnavailable):
    """The server could not be reached, or refused us.

    A subclass of `SourceUnavailable` on purpose: the rule that an
    outage must never be reported as an empty dataset is the same rule
    here as it is for a vendor with a key, and anything already
    catching the base class keeps working.
    """


class FrenchFileMissing(FrenchUnavailable):
    """A 404 on one file. Names on that server are renamed occasionally.

    Distinct from the parent because it is survivable in a way an
    outage is not: eighteen files pulled and one renamed is seventeen
    good datasets and a note, whereas a server refusing everything is
    an outage and must stop the pull.
    """


class FrenchParseError(ValueError):
    """The bytes arrived and we could not read them.

    Deliberately NOT a `SourceUnavailable`. The distinction is whose
    fault it is: an unavailable source is a fact about the network, a
    parse error is a fact about this module, and conflating them means
    a layout change on that server gets retried forever as if it were
    a timeout.
    """


# -- the registry ---------------------------------------------------------


@dataclass(frozen=True)
class Dataset:
    """One downloadable file and what it honestly contains.

    `expected_start` is a HINT, not a finding. The true start is
    whatever the first row of the parsed frame says, which is why
    `observed_range` exists and why `describe` reports both — a
    hard-coded start date that drifts out of agreement with the file
    is exactly the kind of documentation that gets believed.
    """

    key: str
    filename: str
    title: str
    #: The file's primary period. Monthly files also carry an annual
    #: table below the monthly one; daily files generally do not.
    frequency: str
    expected_start: str
    notes: str = ""

    @property
    def url(self) -> str:
        return BASE_URL + self.filename


def _registry(*items: Dataset) -> dict[str, Dataset]:
    return {d.key: d for d in items}


DATASETS: dict[str, Dataset] = _registry(
    Dataset(
        "ff3_monthly",
        "F-F_Research_Data_Factors_CSV.zip",
        "Fama/French 3 factors, monthly (plus an annual table)",
        "monthly",
        "1926-07",
        "Mkt-RF, SMB, HML and the risk-free rate. RF is the 1-month "
        "T-bill: Ibbotson through 202405, ICE BofA thereafter.",
    ),
    Dataset(
        "ff3_daily",
        "F-F_Research_Data_Factors_daily_CSV.zip",
        "Fama/French 3 factors, daily",
        "daily",
        "1926-07-01",
        "RF here is the simple daily rate that compounds to the "
        "1-month bill rate over the month's trading days.",
    ),
    Dataset(
        "ff5_monthly",
        "F-F_Research_Data_5_Factors_2x3_CSV.zip",
        "Fama/French 5 factors (2x3), monthly (plus an annual table)",
        "monthly",
        "1963-07",
        "Starts in 1963, not 1926: RMW and CMA need Compustat "
        "accounting data that does not exist before then.",
    ),
    Dataset(
        "ff5_daily",
        "F-F_Research_Data_5_Factors_2x3_daily_CSV.zip",
        "Fama/French 5 factors (2x3), daily",
        "daily",
        "1963-07-01",
    ),
    Dataset(
        "mom_monthly",
        "F-F_Momentum_Factor_CSV.zip",
        "Momentum factor (Mom), monthly (plus an annual table)",
        "monthly",
        "1927-01",
        "Prior return measured from month -12 to -2, so the series "
        "starts later than the market factor it sits beside.",
    ),
    Dataset(
        "mom_daily",
        "F-F_Momentum_Factor_daily_CSV.zip",
        "Momentum factor (Mom), daily",
        "daily",
        "1926-11-03",
    ),
    Dataset(
        "st_rev_monthly",
        "F-F_ST_Reversal_Factor_CSV.zip",
        "Short-term reversal factor, monthly (plus an annual table)",
        "monthly",
        "1926-02",
        "Starts five months BEFORE the market factor, and the daily "
        "file starts earlier still — a one-month sort needs less "
        "history to get going than a size-and-value double sort.",
    ),
    Dataset(
        "st_rev_daily",
        "F-F_ST_Reversal_Factor_daily_CSV.zip",
        "Short-term reversal factor, daily",
        "daily",
        "1926-01-26",
    ),
    Dataset(
        "lt_rev_monthly",
        "F-F_LT_Reversal_Factor_CSV.zip",
        "Long-term reversal factor, monthly (plus an annual table)",
        "monthly",
        "1931-01",
    ),
    Dataset(
        "lt_rev_daily",
        "F-F_LT_Reversal_Factor_daily_CSV.zip",
        "Long-term reversal factor, daily",
        "daily",
        "1930-03-20",
        "The daily file opens ten months before the monthly one. "
        "Both hints were wrong when first written and were corrected "
        "against the rows; that is what `observed_range` is for.",
    ),
    Dataset(
        "industry49_monthly",
        "49_Industry_Portfolios_CSV.zip",
        "49 industry portfolios, value- and equal-weighted, monthly",
        "monthly",
        "1926-07",
        "Early rows carry -99.99 for industries with no firms yet; "
        "those become NaN, never zero returns.",
    ),
    Dataset(
        "industry49_daily",
        "49_Industry_Portfolios_daily_CSV.zip",
        "49 industry portfolios, value- and equal-weighted, daily",
        "daily",
        "1926-07-01",
    ),
    Dataset(
        "industry12_monthly",
        "12_Industry_Portfolios_CSV.zip",
        "12 industry portfolios, value- and equal-weighted, monthly",
        "monthly",
        "1926-07",
    ),
    Dataset(
        "industry12_daily",
        "12_Industry_Portfolios_daily_CSV.zip",
        "12 industry portfolios, value- and equal-weighted, daily",
        "daily",
        "1926-07-01",
    ),
    Dataset(
        "size_bm_6_monthly",
        "6_Portfolios_2x3_CSV.zip",
        "6 portfolios on size and book-to-market, monthly",
        "monthly",
        "1926-07",
        "The 2x3 sort SMB and HML are built from, so it is the "
        "right place to check a factor's construction by hand.",
    ),
    Dataset(
        "size_bm_6_daily",
        "6_Portfolios_2x3_daily_CSV.zip",
        "6 portfolios on size and book-to-market, daily",
        "daily",
        "1926-07-01",
    ),
    Dataset(
        "size_bm_25_monthly",
        "25_Portfolios_5x5_CSV.zip",
        "25 portfolios on size and book-to-market (5x5), monthly",
        "monthly",
        "1926-07",
        "The classic test assets. The corner portfolios are thin "
        "early and carry missing codes rather than returns.",
    ),
    Dataset(
        "size_bm_25_daily",
        "25_Portfolios_5x5_daily_CSV.zip",
        "25 portfolios on size and book-to-market (5x5), daily",
        "daily",
        "1926-07-01",
    ),
)


def available() -> list[Dataset]:
    """Every dataset this module knows how to fetch, in registry order."""
    return list(DATASETS.values())


def dataset(key: str) -> Dataset:
    try:
        return DATASETS[key]
    except KeyError:
        raise KeyError(
            f"{key!r} is not a dataset this module knows. Known keys: "
            f"{sorted(DATASETS)}. Filenames on that server change "
            f"occasionally — add a Dataset rather than passing a raw "
            f"filename, so the honesty block travels with it."
        ) from None


# -- the honesty block ----------------------------------------------------


#: Said once, in full, so that nothing downstream has to reconstruct it
#: from memory. Every sentence here is either checkable in the bytes
#: French serves or is an explicit statement that we do not know.
PROVENANCE = """\
Source:        Kenneth R. French Data Library, Tuck School of Business
               at Dartmouth. Free, no account, no API key.
Built from:    CRSP (Center for Research in Security Prices) US stock
               data, plus Compustat accounting data for the sorts that
               need book equity, operating profitability or investment.
               From the January 2025 release the library reads CRSP's
               Flat File Format 2.0 (CIZ) rather than the retired
               legacy (FIZ) files, and in CIZ a monthly return is
               compounded daily returns with dividends reinvested on
               their ex-dates. Series built before and after that
               change are not bit-identical.
Survivorship:  FREE, and this is the only free dataset in this
               repository of which that can be said. CRSP retains
               securities that stopped trading and carries the
               delisting return, and French's portfolios are formed
               from the stocks that met the sort criterion ON THE
               FORMATION DATE. A company that went to zero in 1974 is
               inside the 1974 portfolio at the weight it had, and its
               collapse is in the 1974 return. Nothing here is
               reconstructed from a list of names that still trade.
               Note what this does NOT prove: we cannot inspect CRSP
               ourselves, so this is French's construction taken on
               its documented terms rather than a property we verified
               row by row. It is the strongest survivorship claim
               available to us and it is still a claim about someone
               else's database.
Coverage:      Market/size/value factors from July 1926; the five
               factors from July 1963 (RMW and CMA need Compustat).
               Read the true start off the frame, not off this note.
Updates:       Monthly, following a new CRSP cut. The first line of
               every file states the CRSP vintage it was built from
               (e.g. "created using the 202605 CRSP database").
Licence:       Every file ends "Copyright <year> Eugene F. Fama and
               Kenneth R. French". The library's own page carries the
               same notice and, as of this writing, NO explicit
               licence, no stated redistribution permission and no
               formal citation requirement that we have been able to
               find. So: free to download and free to use in our own
               research, cached locally, cited by name. Do NOT
               republish the files or serve them onward as if they
               were ours. Treat the absence of a licence as a
               reservation of rights, not as permission.
Granularity:   PORTFOLIO-LEVEL RETURNS ONLY. There are no individual
               securities here, no constituent lists, no prices and no
               identifiers. This data cannot be used to trade or
               screen individual names, and it cannot answer what any
               single company did.
"""

#: Repeated at every exit, because the mistake it prevents is the one
#: that happens years later when somebody finds a tidy frame of
#: monthly returns and treats it as a track record.
TRADABILITY_WARNING = (
    "Academic portfolio returns: no transaction costs, no spread, no "
    "market impact, no capacity limit, no short borrow cost, and "
    "rebalancing assumed frictionless. Use to test whether a premium "
    "existed, never as a return anyone could have earned."
)


def describe(
    key: str, frames: dict[str, pd.DataFrame] | None = None
) -> dict[str, Any]:
    """What a dataset is, what it claims, and — if given frames — what
    it actually turned out to contain.

    The two halves are kept apart on purpose. `expected_start` is
    documentation and can rot; `observed` is read off the rows in
    front of the caller and cannot.
    """
    d = dataset(key)
    out: dict[str, Any] = {
        "key": d.key,
        "title": d.title,
        "url": d.url,
        "frequency": d.frequency,
        "expected_start": d.expected_start,
        "notes": d.notes,
        "survivorship_free": True,
        "tradable": False,
        "tradability_warning": TRADABILITY_WARNING,
        "granularity": "portfolio-level returns; no individual securities",
        "licence": "copyright Fama and French; no explicit licence published",
    }
    if frames is not None:
        out["observed"] = {
            label: observed_range(frame) for label, frame in frames.items()
        }
    return out


def observed_range(frame: pd.DataFrame) -> dict[str, Any]:
    """First row, last row, shape and units, read off the frame itself."""
    idx = frame.index
    return {
        "start": None if len(idx) == 0 else str(pd.Timestamp(idx[0]).date()),
        "end": None if len(idx) == 0 else str(pd.Timestamp(idx[-1]).date()),
        "rows": int(len(frame)),
        "columns": [str(c) for c in frame.columns],
        "units": frame.attrs.get("units", "unknown"),
        "frequency": frame.attrs.get("frequency", "unknown"),
    }


# -- parsing --------------------------------------------------------------


#: Width of the date token decides the period, and nothing else does.
#: Deliberately not inferred from the caption: "Annual Factors" is a
#: caption French writes and a caption French could stop writing, but
#: 1927 will never be eight digits long.
_PERIOD_BY_WIDTH: dict[int, str] = {4: "annual", 6: "monthly", 8: "daily"}

#: Captions that mean the numbers below are NOT returns. Each one is
#: taken from a real file: firm counts, average firm size, average
#: market cap, the BE/ME and OP ratios French ships beside the returns
#: in the same archive. Dividing any of them by 100 produces a
#: plausible small number and no error.
_NOT_RETURNS = (
    "number of firms",
    "number of stocks",
    "firm size",
    "market cap",
    "sum of",
    "average of",
    "average be",
    "book equity",
    "log(",
)


def _classify_units(caption: str, *, first: bool) -> str:
    """Decide whether a table is a percent return, in that order.

    "Return" and "factor" win first and win outright, which is what
    makes "Value-Weighted Average of Prior Returns" come out as a
    return (it is one, quoted in percent) while "Value Weight Average
    of BE/ME" comes out raw.

    An unrecognised caption falls through to RAW — undivided — and the
    caption is preserved verbatim on the table so it is visible. That
    is the safer default of the two: a return left in percent reads as
    2.89 and looks wrong immediately, whereas a firm count divided by
    a hundred reads as 0.42 and looks like a weight.

    `first` is what keeps the no-caption case honest. Every factor
    file's leading table is uncaptioned — the prose preamble is its
    only introduction — and it is always the factor returns. No file
    in this library puts an uncaptioned table anywhere else, so an
    uncaptioned LATER table means a caption was lost rather than never
    written, and guessing "returns" there would divide something we
    have stopped being able to name.
    """
    c = caption.strip().lower()
    if "return" in c or "factor" in c:
        return DECIMAL_RETURN
    if any(marker in c for marker in _NOT_RETURNS):
        return RAW
    if not c and first:
        return DECIMAL_RETURN
    return RAW


@dataclass(frozen=True)
class FrenchTable:
    """One table lifted out of one file, already in decimal where it
    should be.

    `frame` is wide: a DatetimeIndex named `date` and one float column
    per portfolio, in the file's own column order rather than sorted —
    industry order is information, and alphabetising it throws away
    which column was which in the original.
    """

    dataset: str
    label: str
    caption: str
    units: str
    frequency: str
    frame: pd.DataFrame
    #: The CRSP cut the file was built from, e.g. "202605", or "" if
    #: the file stopped saying. Two pulls with different vintages are
    #: not the same numbers even over the same months.
    crsp_vintage: str = ""
    #: Rows the file wrote short of the header width, padded with NaN.
    #: Zero in every file seen so far; non-zero is worth a look before
    #: the frame is believed.
    short_rows: int = 0

    @property
    def is_return(self) -> bool:
        return self.units == DECIMAL_RETURN


def read_zip(payload: bytes) -> tuple[str, str]:
    """The first CSV member of the archive, decoded.

    Member names are not a convention worth relying on: the monthly
    12-industry archive holds `12_Industry_Portfolios.csv` and the
    daily one holds `12_Industry_Portfolios_Daily.csv`, capital D. So
    the first `.csv` is taken rather than a name being constructed.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except (zipfile.BadZipFile, OSError) as exc:
        head = payload[:200].decode("utf-8", "replace")
        raise FrenchUnavailable(
            f"the response was not a zip archive — {exc}. First bytes: "
            f"{head!r}. A web server answering 200 with an HTML error "
            f"page looks exactly like this, which is why the body is "
            f"checked rather than the status code."
        ) from exc

    names = [n for n in archive.namelist() if n.lower().endswith(".csv")]
    if not names:
        raise FrenchParseError(
            f"the archive holds no .csv member; it holds "
            f"{archive.namelist()}"
        )
    raw = archive.read(names[0])
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # These files are effectively ASCII, but a stray byte in a
        # prose header should not take down a factor series. latin-1
        # decodes anything; it never silently drops a character the
        # way errors="replace" does.
        text = raw.decode("latin-1")
    return names[0], text


def parse(text: str, *, dataset_key: str = "") -> list[FrenchTable]:
    """Every table in one French CSV, in the order the file lists them.

    The scan, and why each rule is there:

    A HEADER row is a row whose first field is empty and which carries
    at least one non-empty label after it. That is the only reliable
    marker of a table start in these files — the caption above it is
    free prose and sometimes absent entirely.

    A DATA row is a row whose first field is a 4-, 6- or 8-digit
    integer. Nothing else in the file looks like that.

    A CAPTION is the most recent run of prose above a header, where a
    run is prose uninterrupted by a blank line — with one exception:
    the run at the very top of the file is the file's PREAMBLE and is
    never a caption. Both halves of that rule are load-bearing. Drop
    the exception and the three-factor file's first table gets titled
    with two paragraphs about Ibbotson. Take only the ADJACENT run and
    `6_Portfolios_2x3.csv` loses "Average Equal Weighted Returns --
    Annual" entirely, because a stray carriage return puts an empty
    line between that caption and its header while every other caption
    in the same file sits flush against one.

    A data block ENDS at the first non-data row OR at the first change
    in the date token's width. The second condition is the one that
    matters: a file that appends annual rows to a monthly block with
    no header between them would otherwise be read as one series in
    which 1927 is a timestamp, and the resulting frame validates
    perfectly.
    """
    rows = [_trim(r) for r in csv.reader(_lines(text), quoting=csv.QUOTE_NONE)]
    vintage = _crsp_vintage(text)
    tables: list[FrenchTable] = []
    used: set[str] = set()

    # The prose run being accumulated, the last one completed by a
    # blank line, and each one's ordinal in the file. Run zero is the
    # preamble and is spent rather than used.
    current: list[str] = []
    current_no = -1
    previous: list[str] = []
    previous_no = -1
    runs = 0

    i = 0
    while i < len(rows):
        row = rows[i]
        if _is_header(row):
            header = [f.strip() for f in row[1:]]
            chosen, chosen_no = (
                (current, current_no) if current else (previous, previous_no)
            )
            named = _is_caption(chosen, chosen_no)
            caption = " ".join(chosen).strip() if named else ""
            # Decided once per header, not per block. A header that
            # fronts a monthly block and an annual block fronts ONE
            # table in two periods, and classifying the second block
            # separately would serve the annual factor returns in
            # percent beside the monthly ones in decimal.
            units = _classify_units(caption, first=not tables)
            current, previous = [], []
            current_no = previous_no = -1
            i += 1
            # One header can front several period blocks. Loop rather
            # than break, so a monthly table followed by annual rows
            # under the same header produces two honest tables instead
            # of one dishonest one.
            while i < len(rows) and _is_data(rows[i]):
                block, i = _take_block(rows, i)
                tables.append(
                    _build_table(
                        dataset_key=dataset_key,
                        caption=caption,
                        header=header,
                        block=block,
                        vintage=vintage,
                        units=units,
                        used=used,
                    )
                )
            continue

        if _is_data(row):
            raise FrenchParseError(
                f"{dataset_key or 'file'}: data row {i + 1} sits under no "
                f"header, so there is no honest name for its columns "
                f"({row[:4]}...). Refusing to invent column names — the "
                f"layout has changed and the parser must change with it."
            )

        # Rejoined rather than read as `row[0]`: French's prose runs to
        # sentences with commas in them, and csv has already split one
        # of those into four fields. Keeping only the first would
        # truncate a caption mid-clause.
        text_line = ",".join(row).strip()
        if text_line:
            if not current:
                current_no = runs
                runs += 1
            current.append(text_line)
        elif current:
            previous, previous_no = current, current_no
            current, current_no = [], -1
        i += 1

    if not tables:
        raise FrenchParseError(
            f"{dataset_key or 'file'}: no table found. The file arrived "
            f"({len(rows)} lines) and this parser could not see a header "
            f"row in it — that is our failure, not an empty dataset, and "
            f"returning an empty frame here would be a lie about the "
            f"market."
        )
    return tables


#: CRLF, bare CR and bare LF, in that order so a CRLF is one break
#: rather than two. All three appear in the same file: `6_Portfolios_
#: _2x3.csv` is CRLF throughout except for fifteen bare carriage
#: returns, one of which sits immediately before a table's header row.
#: `csv.reader` over a StringIO does NOT treat a bare CR as a line end,
#: so it reads the header into the previous field and then refuses the
#: whole file with "new-line character seen in unquoted field" —
#: 2,524 rows in, which reads like a corrupt download rather than a
#: line-ending convention from 1984.
_LINE_BREAK = re.compile(r"\r\n|\r|\n")


def _lines(text: str) -> list[str]:
    """Split on any of the three conventions, and only those three.

    Deliberately not `str.splitlines`, which also breaks on form feed,
    vertical tab and the Unicode line separators. Those would never
    appear in a number, but a parser that splits on characters the
    source does not use as separators is a parser whose behaviour
    nobody can predict from the file.
    """
    return _LINE_BREAK.split(text)


#: "This file was created using the 202605 CRSP database." — the first
#: line of nearly every file, and the only provenance stamp the data
#: carries. Worth keeping: French rebuilds monthly, and two frames
#: pulled six weeks apart are not the same numbers to the last decimal
#: even where they cover the same months.
_VINTAGE = re.compile(r"(\d{6})\s+CRSP\s+database", re.IGNORECASE)


def _crsp_vintage(text: str) -> str:
    match = _VINTAGE.search(text[:2000])
    return match.group(1) if match else ""


def _trim(row: Sequence[str]) -> list[str]:
    """Drop trailing empty fields — a formatting artefact, everywhere.

    `F-F_Momentum_Factor_daily.csv` writes every line with two spare
    commas on the end, prose lines included, so its header reads
    `,Mom,` and its rows read `19261103,0.35,`. Untrimmed that is a
    column with no name, a data row wider than its header, and a
    preamble line whose last visible character is a comma rather than
    the full stop `_is_caption` looks for — three separate failures
    from one stray comma. Only TRAILING blanks go: an empty field
    between two populated ones is a missing value and stays.
    """
    end = len(row)
    while end and not row[end - 1].strip():
        end -= 1
    return list(row[:end])


def _is_caption(run: Sequence[str], ordinal: int) -> bool:
    """Whether a run of prose names the table below it or is just prose.

    Two tests, and the first one is the one that earns its keep. A
    caption in this library is a title — "Number of Firms in
    Portfolios", "Annual Factors: January-December" — and a preamble
    line is a SENTENCE, ending in a full stop. Every file's preamble
    closes with "Missing data are indicated by -99.99 or -999." or
    "The portfolios include utilities and include financials.", and in
    the momentum file that sentence stands alone between two blank
    lines, which makes it the nearest prose run to the first header
    and therefore a caption by adjacency alone. It is not one, and the
    cost of believing it was: no caption matches "return" or "factor",
    the momentum series is classified raw, and Mom is served in
    percent while every other factor comes back in decimal.

    The second test — never the file's first prose run — is
    redundant against the first on every file here, and kept because
    the two fail differently. A preamble that stopped using full
    stops would still not be run one.
    """
    if not run or ordinal <= 0:
        return False
    return not run[-1].rstrip().endswith(".")


def _is_header(row: Sequence[str]) -> bool:
    if len(row) < 2 or row[0].strip() != "":
        return False
    return any(f.strip() for f in row[1:])


def _is_data(row: Sequence[str]) -> bool:
    if not row:
        return False
    token = row[0].strip()
    return len(token) in _PERIOD_BY_WIDTH and token.isdigit()


def _take_block(
    rows: Sequence[Sequence[str]], start: int
) -> tuple[list[Sequence[str]], int]:
    """One period block: consecutive data rows of a single token width."""
    width = len(rows[start][0].strip())
    i = start
    while i < len(rows) and _is_data(rows[i]):
        if len(rows[i][0].strip()) != width:
            break
        i += 1
    return list(rows[start:i]), i


def _build_table(
    *,
    dataset_key: str,
    caption: str,
    header: Sequence[str],
    block: Sequence[Sequence[str]],
    vintage: str,
    units: str,
    used: set[str],
) -> FrenchTable:
    tokens = [row[0].strip() for row in block]
    frequency = _PERIOD_BY_WIDTH[len(tokens[0])]
    index = _stamps(tokens, frequency, dataset_key, caption)

    columns = _clean_header(header, dataset_key, caption)
    width = len(columns)

    short = 0
    cells: list[list[str]] = []
    for row in block:
        values = [f.strip() for f in row[1:]]
        if len(values) > width:
            raise FrenchParseError(
                f"{dataset_key or 'file'} / {caption or 'unnamed table'}: "
                f"row {row[0]!r} carries {len(values)} values against a "
                f"{width}-column header. The header was mis-detected; a "
                f"frame built from this would put one portfolio's number "
                f"under another's name."
            )
        if len(values) < width:
            short += 1
            values = values + [""] * (width - len(values))
        cells.append(values)

    frame = pd.DataFrame(cells, columns=list(columns), index=index)
    frame = _numeric(frame, dataset_key, caption)

    # Missing codes BEFORE the division, always. -99.99 divided by a
    # hundred is -0.9999, which is a 99.99% loss and reads as a finding
    # rather than as a hole.
    frame = _blank_missing(frame)

    if units == DECIMAL_RETURN:
        # The division. French publishes 2.89 to mean 2.89%.
        frame = frame / PERCENT

    frame.index.name = "date"
    label = _unique_label(caption, frequency, used)
    frame.attrs = {
        "dataset": dataset_key,
        "table": label,
        "caption": caption,
        "units": units,
        "frequency": frequency,
        "crsp_vintage": vintage,
        "warning": TRADABILITY_WARNING,
    }
    return FrenchTable(
        dataset=dataset_key,
        label=label,
        caption=caption,
        units=units,
        frequency=frequency,
        frame=frame,
        crsp_vintage=vintage,
        short_rows=short,
    )


def _clean_header(
    header: Sequence[str], dataset_key: str, caption: str
) -> list[str]:
    """Column names with the padding taken off, and no two the same.

    French pads industry names to a fixed width — `Food ` and `Fun  `
    — so stripping is required before anything joins on them. A
    collision after stripping is refused rather than silently
    de-duplicated: two industries under one name would be merged by
    the pivot on the way back out of the cache, and the frame would
    look complete with a column missing.
    """
    cleaned = [c.strip() for c in header]
    if any(not c for c in cleaned):
        raise FrenchParseError(
            f"{dataset_key or 'file'} / {caption or 'unnamed table'}: an "
            f"empty column name in {header!r}. An unnamed column cannot "
            f"be reported honestly, so it is refused here."
        )
    seen: set[str] = set()
    for c in cleaned:
        if c in seen:
            raise FrenchParseError(
                f"{dataset_key or 'file'} / {caption or 'unnamed table'}: "
                f"duplicate column name {c!r} in {cleaned}. Two "
                f"portfolios sharing a name would be silently merged."
            )
        seen.add(c)
    return cleaned


def _stamps(
    tokens: Sequence[str], frequency: str, dataset_key: str, caption: str
) -> pd.DatetimeIndex:
    """Period tokens to timestamps, stamped at the END of the period.

    Monthly 192607 becomes 1926-07-31 and annual 1927 becomes
    1927-12-31, because the number beside it is the return EARNED OVER
    that period. Stamping a July return at 1 July is a one-month
    lookahead dressed as a convention: joined against anything daily
    it would put July's factor return alongside June's prices.
    """
    s = pd.Series(list(tokens), dtype="object")
    try:
        if frequency == "daily":
            idx = pd.to_datetime(s, format="%Y%m%d")
        elif frequency == "monthly":
            idx = pd.to_datetime(s, format="%Y%m") + pd.offsets.MonthEnd(0)
        else:
            idx = pd.to_datetime(s + "1231", format="%Y%m%d")
    except (ValueError, TypeError) as exc:
        raise FrenchParseError(
            f"{dataset_key or 'file'} / {caption or 'unnamed table'}: "
            f"unreadable {frequency} period token — {exc}"
        ) from exc

    # Pinned to nanoseconds. pandas 3 infers microseconds from a
    # `to_datetime` with an explicit format, and the frame that comes
    # back out of parquet is nanosecond — so leaving it alone would
    # give a cache hit and a cache miss different index dtypes, which
    # is the kind of difference that only ever shows up in production.
    out = pd.DatetimeIndex(idx).astype("datetime64[ns]")
    if out.has_duplicates:
        dupes = out[out.duplicated()].unique()[:5]
        raise FrenchParseError(
            f"{dataset_key or 'file'} / {caption or 'unnamed table'}: "
            f"duplicate period(s) {[str(d.date()) for d in dupes]}. Two "
            f"rows for one period double every mean computed from this."
        )
    return out


def _numeric(
    frame: pd.DataFrame, dataset_key: str, caption: str
) -> pd.DataFrame:
    """Every cell to float, refusing to coerce anything unexpected.

    `errors="coerce"` on its own turns a cell this parser
    misunderstood into NaN, which is how a mis-read table becomes a
    sparse one instead of an error. So the coercion is checked: a cell
    that had text in it and came out NaN means the block boundary was
    wrong, and that is worth stopping for.
    """
    out = {}
    for col in frame.columns:
        raw = frame[col]
        values = pd.to_numeric(raw, errors="coerce")
        lost = values.isna() & raw.astype("str").str.strip().ne("")
        if bool(lost.any()):
            first = raw[lost].iloc[0]
            raise FrenchParseError(
                f"{dataset_key or 'file'} / {caption or 'unnamed table'}: "
                f"column {col!r} holds {first!r}, which is not a number "
                f"and not blank. French's files are machine-written, so "
                f"this is a table boundary we got wrong rather than a "
                f"typo in the data."
            )
        out[col] = values.astype("float64")
    return pd.DataFrame(out, index=frame.index)


def _blank_missing(frame: pd.DataFrame) -> pd.DataFrame:
    """-99.99 and -999 to NaN. Never to zero.

    Zero would be a claim: an industry with no firms in 1926 did not
    return nothing, it did not exist, and a zero in a mean is a
    fabricated observation pulling the average toward it.
    """
    out = frame
    for code in MISSING_CODES:
        out = out.mask((out - code).abs() < _MISSING_TOLERANCE)
    return out


def _unique_label(caption: str, frequency: str, used: set[str]) -> str:
    base = caption.strip() or frequency.capitalize()
    label = base
    if label in used:
        label = f"{base} ({frequency})"
    n = 2
    while label in used:
        label = f"{base} ({frequency}) #{n}"
        n += 1
    used.add(label)
    return label


# -- transport ------------------------------------------------------------


class Downloader:
    """One session, paced. Constructed by the caller so a test can
    stand in for the network and a batch pull can reuse the socket.

    The pacing is on the object rather than in a module global because
    a module global is shared state that nothing owns: two callers in
    one process would throttle each other for reasons neither could
    see, and a test would inherit whatever the last test did.
    """

    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
        min_interval: float = MIN_REQUEST_INTERVAL_SECONDS,
    ) -> None:
        self._session = session or requests.Session()
        self._timeout = timeout
        self._sleep = sleep
        self._min_interval = min_interval
        self._last: float = float("-inf")

    def fetch(self, key: str) -> bytes:
        """The raw archive for one dataset, or a raise that says which.

        Four outcomes, kept apart because they need different
        responses: 200 is the bytes; 404 is a rename and the caller
        may skip it; 429/5xx is retried politely and then reported as
        an outage; anything else stops immediately.
        """
        d = dataset(key)
        last_reason = "no attempt was made"

        for attempt in range(MAX_ATTEMPTS):
            if attempt:
                self._sleep(
                    min(
                        BACKOFF_BASE_SECONDS * 2 ** (attempt - 1),
                        BACKOFF_CAP_SECONDS,
                    )
                )
            else:
                self._pace()

            try:
                response = self._session.get(
                    d.url,
                    headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                last_reason = f"{type(exc).__name__}: {exc}"
                continue

            status = int(response.status_code)
            if status == 200:
                return bytes(response.content)
            if status == 404:
                raise FrenchFileMissing(
                    f"{d.key}: {d.filename} is not on that server (404). "
                    f"Names in the French library change occasionally — "
                    f"check the data library page for the current "
                    f"filename and update DATASETS. This is one file "
                    f"missing, not an outage, so a batch pull should "
                    f"record it and carry on."
                )
            if status in RETRY_STATUSES:
                last_reason = f"HTTP {status}"
                continue
            raise FrenchUnavailable(
                f"{d.key}: {d.url} returned HTTP {status}. Not an empty "
                f"dataset — nothing was read at all."
            )

        raise FrenchUnavailable(
            f"{d.key}: {d.url} unreachable after {MAX_ATTEMPTS} attempts. "
            f"Last: {last_reason}. This is our outage and it is not a "
            f"statement about the data; do not let a factor series fall "
            f"back to empty on the strength of it."
        )

    def _pace(self) -> None:
        waited = time.monotonic() - self._last
        if 0.0 <= waited < self._min_interval:
            self._sleep(self._min_interval - waited)
        self._last = time.monotonic()


def download(key: str, *, session: requests.Session | None = None) -> bytes:
    """One archive, for a caller that wants the bytes and nothing else."""
    return Downloader(session).fetch(key)


# -- the long form that goes to disk --------------------------------------


#: What one dataset looks like in the cache: every table stacked into
#: one long frame. Long rather than wide because `ParquetCache.put`
#: writes `index=False` — a DatetimeIndex would simply not survive the
#: round trip — and because one file holds tables of different widths
#: and different periods, which no single wide frame can hold at once.
#: The units ride along per row, so a frame read back out of the cache
#: by somebody who never saw this module still says whether it has
#: been divided.
LONG_DTYPES: dict[str, str] = {
    "table": "str",
    "caption": "str",
    "units": "str",
    "frequency": "str",
    "crsp_vintage": "str",
    "date": "datetime64[ns]",
    "portfolio": "str",
    "value": "float64",
}


def to_long(tables: Iterable[FrenchTable]) -> pd.DataFrame:
    """Stack parsed tables into the one frame that gets cached.

    Column order is preserved by construction: the rows are written
    portfolio by portfolio in header order, so first appearance in the
    long frame recovers the file's own order when it is pivoted back.
    An alphabetised industry list is a small loss that cannot be
    undone once the parquet is written.
    """
    pieces: list[pd.DataFrame] = []
    for table in tables:
        frame = table.frame
        for column in frame.columns:
            pieces.append(
                pd.DataFrame(
                    {
                        "table": table.label,
                        "caption": table.caption,
                        "units": table.units,
                        "frequency": table.frequency,
                        "crsp_vintage": table.crsp_vintage,
                        "date": frame.index,
                        "portfolio": str(column),
                        "value": frame[column].to_numpy(dtype="float64"),
                    }
                )
            )
    if not pieces:
        raise FrenchParseError("no tables to stack; refusing to write nothing")
    out = pd.concat(pieces, ignore_index=True)
    return _typed(out, LONG_DTYPES)


def from_long(long: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """The long frame back into one wide frame per table.

    The inverse of `to_long`, and the reason `load` returns the same
    shape whether the pull came off the network or off the disk. A
    cache that hands back a different shape than the loader is a cache
    that only breaks in production.
    """
    missing = [c for c in LONG_DTYPES if c not in long.columns]
    if missing:
        raise FrenchParseError(
            f"cached frame is missing {missing}; it was written by an "
            f"older layout. Clear the entry rather than reading around it."
        )

    labels = long["table"].astype("str")
    out: dict[str, pd.DataFrame] = {}
    for label in dict.fromkeys(labels):
        sub = long.loc[labels == label]
        order = list(dict.fromkeys(sub["portfolio"].astype("str")))
        wide = sub.pivot(index="date", columns="portfolio", values="value")
        wide = wide.reindex(columns=order)
        wide.columns.name = None
        wide.index = pd.DatetimeIndex(wide.index, name="date")
        wide = wide.astype("float64").sort_index()
        wide.attrs = {
            "dataset": "",
            "table": label,
            "caption": str(sub["caption"].iloc[0]),
            "units": str(sub["units"].iloc[0]),
            "frequency": str(sub["frequency"].iloc[0]),
            "crsp_vintage": str(sub["crsp_vintage"].iloc[0]),
            "warning": TRADABILITY_WARNING,
        }
        out[label] = wide
    return out


def _typed(df: pd.DataFrame, dtypes: dict[str, str]) -> pd.DataFrame:
    built = {}
    for column, dtype in dtypes.items():
        series = df[column]
        if dtype.startswith("datetime64"):
            built[column] = pd.to_datetime(series).astype("datetime64[ns]")
        elif dtype == "float64":
            numeric = pd.to_numeric(series, errors="coerce")
            built[column] = numeric.astype("float64")
        else:
            built[column] = series.astype("str")
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out


# -- the front door -------------------------------------------------------


def default_cache(root: Path | str | None = None) -> ParquetCache:
    """The cache these pulls belong in, with a life that fits the source.

    Seven days, because French rebuilds the library monthly from a new
    CRSP cut. The unregistered-frame default in `cache.py` is one day,
    which for a file that changes twelve times a year would mean
    downloading fifty megabytes to learn nothing.
    """
    return ParquetCache(
        root or DEFAULT_ROOT, ttl_days={CACHE_FRAME: CACHE_TTL_DAYS}
    )


def load(
    key: str,
    *,
    cache: ParquetCache | None = None,
    session: requests.Session | None = None,
    downloader: Downloader | None = None,
    refresh: bool = False,
    now: datetime | None = None,
) -> dict[str, pd.DataFrame]:
    """Every table in one dataset, keyed by label, ready to use.

    Each frame has a DatetimeIndex stamped at the END of its period,
    float columns in the file's own order, and `frame.attrs["units"]`
    saying whether the numbers are decimal returns or something else.
    Return tables have already been divided by 100.

    Caching is on by default and there is no way to turn it off,
    because a source pulled twice is a source we were rude to twice.
    Pass a cache rooted somewhere else if you want isolation.
    """
    store = cache if cache is not None else default_cache()
    stamp = now or datetime.now(timezone.utc)
    cache_key = store.key(CACHE_SOURCE, CACHE_FRAME, dataset=key)

    def pull() -> pd.DataFrame:
        agent = downloader or Downloader(session)
        _, text = read_zip(agent.fetch(key))
        return to_long(parse(text, dataset_key=key))

    long = store.get_or_load(
        cache_key, pull, stamped=stamp, now=stamp, refresh=refresh
    )
    frames = from_long(long)
    for frame in frames.values():
        frame.attrs["dataset"] = key
    return frames


def load_table(
    key: str,
    want: str,
    **kwargs: Any,
) -> pd.DataFrame:
    """One table by a case-insensitive substring of its label.

    Ambiguity raises and lists the candidates rather than taking the
    first match. "Monthly" matches both the value- and equal-weighted
    tables in an industry file, and silently returning the
    value-weighted one because it happens to be printed first is the
    kind of default nobody remembers making.
    """
    frames = load(key, **kwargs)
    needle = want.strip().lower()
    hits = [label for label in frames if needle in label.lower()]
    if not hits:
        raise KeyError(
            f"{key}: no table matching {want!r}. This file holds "
            f"{list(frames)}."
        )
    if len(hits) > 1:
        raise KeyError(
            f"{key}: {want!r} matches {hits}. Name one of them — picking "
            f"the first would quietly decide between value- and "
            f"equal-weighted returns on your behalf."
        )
    return frames[hits[0]]


@dataclass(frozen=True)
class PullReport:
    """What a batch pull got, and what it did not.

    `missing` is the half worth reading. A renamed file is survivable
    and the pull carries on, but a caller who never looks at this will
    believe they have eighteen datasets when they have seventeen.
    """

    loaded: dict[str, list[str]] = field(default_factory=dict)
    rows: dict[str, int] = field(default_factory=dict)
    missing: dict[str, str] = field(default_factory=dict)

    def summary(self) -> str:
        lines = [
            f"{len(self.loaded)} dataset(s) loaded, "
            f"{sum(self.rows.values()):,} observations."
        ]
        for key, labels in self.loaded.items():
            lines.append(
                f"  {key}: {len(labels)} table(s), {self.rows[key]:,} rows"
            )
        for key, why in self.missing.items():
            lines.append(f"  MISSING {key}: {why}")
        return "\n".join(lines)


def fetch_all(
    keys: Sequence[str] | None = None,
    *,
    cache: ParquetCache | None = None,
    session: requests.Session | None = None,
    downloader: Downloader | None = None,
    refresh: bool = False,
    now: datetime | None = None,
) -> PullReport:
    """Pull the whole library into the cache, one file at a time.

    A 404 on one file is recorded and the pull continues: filenames on
    that server change occasionally, and losing seventeen good
    datasets because one was renamed is a worse outcome than a report
    that names the one we could not get.

    Everything else propagates. A 503 or a timeout means the server is
    having a bad day, and carrying on would produce a partial pull
    that looks exactly like a complete one.
    """
    store = cache if cache is not None else default_cache()
    agent = downloader or Downloader(session)
    report = PullReport()

    for key in keys or list(DATASETS):
        try:
            frames = load(
                key,
                cache=store,
                downloader=agent,
                refresh=refresh,
                now=now,
            )
        except FrenchFileMissing as exc:
            report.missing[key] = str(exc)
            continue
        report.loaded[key] = list(frames)
        report.rows[key] = int(sum(len(f) for f in frames.values()))
    return report
