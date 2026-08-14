"""SEC EDGAR in bulk: every company that ever filed, and no prices at all.

Read that second clause before building anything on this module. EDGAR
is the most genuinely survivorship-free source we have free access to —
a filer's submission history survives its bankruptcy, its acquisition
and its ticker being handed to somebody else, because the filings are a
public record rather than a product someone maintains for subscribers.
It carries NO PRICE OF ANY KIND. Not a close, not a volume, not a
market cap. So EDGAR can tell you that a company existed, what it
reported, and the day it stopped being listed; it cannot tell you what
you would have received when it stopped. Everything here is a
denominator waiting for a numerator, and the numerator is not free.
That is why this file does not subclass `base.DataSource`: the contract
next door is a price-panel contract, and an adapter that satisfied it
by raising from `prices()` would still be handed to the audit as a
panel. It is not one.

What it IS good for, in rough order of value:

**Form 25 and 25-NSE — the free delisting record.** A notification of
removal from listing is filed when a security leaves an exchange, by
the issuer (Form 25) or by the exchange itself (25-NSE). No vendor
subscription, no key, and it is the only free thing in this repository
that names companies that died and dates their deaths. `delistings()`
reads them out of the quarterly full index, one request per quarter
rather than one per company.

**Submissions.** Every filing a CIK ever made, plus the names it used
to trade under. A ticker map is a snapshot of who is alive; a
submissions feed is a history, and `formerNames` is how you notice that
the symbol you are holding used to belong to someone else.

**The DERA Financial Statement Data Sets.** Every numeric fact from
every XBRL filing in a quarter, in four tab-separated files inside one
zip. For a broad panel this is both the efficient path and the polite
one: 10,000 filers is one download instead of ten thousand requests.

**companyfacts.** The same numbers per filer, convenient and large
(General Dynamics is ~3.4MB), and carrying the trap documented at
`extract_facts` below.

**The traps this file exists to avoid.**

*The ticker map is not survivorship-free and looks like it should be.*
`company_tickers.json` is about ten thousand rows of living registrants
with a current ticker association. A company that delisted last year is
simply absent, with nothing in the payload to say it was ever there.
Build a universe from it and you have built the survivorship bug in its
original form using the one source that could have avoided it.

*companyfacts stamps every fact with the FILING's fiscal year.* A 10-K
carries three comparative years and labels all three with the filing's
own `fy`, so grouping on `fy` collapses them to one. Which one is worse
than arbitrary: the three share an accession and a filing date too, so
no tiebreak separates them, a stable sort therefore leaves them in the
order they arrived, and SEC returns the units array by `end` ASCENDING —
the survivor is the OLDEST. This project has already paid for that once:
FA and GF printed General Dynamics' calendar-2023 income statement under
the heading FY2025. `extract_facts` recovers the year from position
within an accession and never from `fy` alone.

*The delisting index double-counts, and the duplicates are the
exchanges.* EDGAR lists one row per FILER, and a 25-NSE has two — the
exchange that struck the listing and the issuer whose security was
struck. Counted naively, the New York Stock Exchange is the most
frequently delisted company in America. See `mark_exchange_filers`. And
a Form 25 strikes a CLASS OF SECURITIES rather than a company: Verizon
is in the 2025Q2 record for a note, and its common stock never stopped
trading.

*Two completely different failures both arrive as HTTP 403.* An object
that does not exist behind SEC's CDN answers with S3's XML
`<Code>AccessDenied</Code>`; a client that is being throttled or has no
User-Agent gets an HTML page titled "Request Rate Threshold Exceeded".
Measured, both, in this repository. Retrying the first is pointless and
retrying the second is the entire remedy, so `_classify` reads the body
rather than the status. The hardened client on the server side
(`server/src/services/secFetch.js`) retries every 403 and would spend
three attempts discovering that 2030Q1 has not happened yet.

*Filing text carries bytes that parquet and Postgres both refuse.*
Extraction produces NUL and lone surrogates; a single one failed an
INSERT and took a whole batch with it. Every string that reaches a
frame here goes through `storable`.

**Politeness is a hard requirement, not a courtesy.** SEC publishes a
cap of ten requests a second and REQUIRES a declared User-Agent
carrying a real email address; without one every request is 403 with
that same HTML page. This client paces itself well under the cap,
identifies itself, and caches so that a source pulled twice is not a
source we were rude to twice.
"""

from __future__ import annotations

import io
import re
import time
import zipfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from .base import SourceUnavailable
from .cache import DEFAULT_ROOT, ParquetCache

# -- who we say we are ----------------------------------------------------

#: SEC's automated-access policy asks for a declared identity with a way
#: to reach a human. This is not decoration: a request without it is
#: refused, and a request with a library's default UA is refused too —
#: both measured against the live service, both answering 403 with the
#: "Request Rate Threshold Exceeded" page rather than anything that
#: names the real problem.
CONTACT_EMAIL = "newtheyork@gmail.com"
USER_AGENT = f"Griffin Fund Research ({CONTACT_EMAIL})"

WWW_BASE = "https://www.sec.gov"
DATA_BASE = "https://data.sec.gov"

TICKER_MAP_URL = f"{WWW_BASE}/files/company_tickers.json"
TICKER_EXCHANGE_URL = f"{WWW_BASE}/files/company_tickers_exchange.json"
SUBMISSIONS_URL = DATA_BASE + "/submissions/CIK{cik:010d}.json"
SUBMISSIONS_CHUNK_URL = DATA_BASE + "/submissions/{name}"
COMPANYFACTS_URL = DATA_BASE + "/api/xbrl/companyfacts/CIK{cik:010d}.json"
FULL_INDEX_URL = WWW_BASE + "/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx"
DERA_URL = (
    WWW_BASE + "/files/dera/data/financial-statement-data-sets/{year}q{quarter}.zip"
)
DERA_LANDING = f"{WWW_BASE}/dera/data/financial-statement-data-sets.html"
ARCHIVES = f"{WWW_BASE}/Archives/"

#: SEC's published ceiling. We never approach it — see `_pace` — but the
#: number belongs in the file so nobody has to go looking for it before
#: deciding a loop is safe.
SEC_RATE_LIMIT_PER_SECOND = 10.0

#: 0.15s between requests is under seven a second with one thread, which
#: leaves headroom for the fact that the cap is per client and not per
#: process. We spent three hours IP-throttled by another vendor today
#: because a retry loop was impolite; the cost of being wrong here is
#: measured in hours and the cost of being slow is measured in seconds.
MIN_REQUEST_INTERVAL_SECONDS = 0.15

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (0.4, 1.2)
DEFAULT_TIMEOUT = 60.0

#: Big files, and the timeout that has to survive one. A DERA quarter is
#: 85MB and a quarterly form index is 5MB on the wire.
BULK_TIMEOUT = 300.0


# -- coverage, stated rather than implied ---------------------------------


@dataclass(frozen=True)
class Coverage:
    """What one EDGAR dataset does and does not support.

    A dataclass rather than prose in a docstring because these claims
    get read by people deciding what to build, and the one that matters
    most — `survivorship_free` — is a different answer for four datasets
    served by the same host under the same terms. Saying "EDGAR is
    survivorship-free" without saying which endpoint is how somebody
    ends up building a universe out of the ticker map.
    """

    dataset: str
    endpoint: str
    #: True, False, or None where the question does not apply.
    survivorship_free: bool | None
    #: HOW we know. A claim with no evidence behind it is a marketing
    #: line, and base.py already says what this project thinks of those.
    survivorship_basis: str
    start: str
    frequency: str
    licence: str
    #: The sentence that must appear wherever this dataset is presented.
    caveat: str


#: The licence is the same for all of it and worth stating once: EDGAR
#: filings are records of the United States Government, which under 17
#: U.S.C. Sec. 105 carry no copyright. Redistribution and academic use
#: are unrestricted. The only published condition on access is the fair-
#: access policy — a declared User-Agent and at most ten requests a
#: second — which is a condition on how you ask, not on what you may do
#: with the answer.
_LICENCE = (
    "Public domain (17 U.S.C. 105, works of the US Government). No "
    "restriction on redistribution or academic use. The only published "
    "condition is SEC's fair-access policy: a declared User-Agent with a "
    "contact address, and at most 10 requests per second."
)

COVERAGE: Mapping[str, Coverage] = {
    "ticker_map": Coverage(
        dataset="ticker_map",
        endpoint=TICKER_MAP_URL,
        survivorship_free=False,
        survivorship_basis=(
            "Measured: about 10,400 rows, every one of them a registrant "
            "with a CURRENT ticker association, and the count drifts daily "
            "as names come and go. A company delisted last year is absent "
            "and nothing in the payload records that it was ever present. "
            "This is a roster of the living."
        ),
        start="current snapshot only; no history of any kind",
        frequency="rebuilt by SEC on roughly a daily cadence",
        licence=_LICENCE,
        caveat=(
            "NEVER build a universe from this file. It is a lookup from a "
            "ticker you already have to the CIK that answers for it today. "
            "Used as a universe it reintroduces survivorship bias using the "
            "one source that could have avoided it."
        ),
    ),
    "submissions": Coverage(
        dataset="submissions",
        endpoint=SUBMISSIONS_URL,
        survivorship_free=True,
        survivorship_basis=(
            "A filer's submission history is a public record, not a "
            "maintained product: it survives the company's bankruptcy, its "
            "acquisition and the reassignment of its ticker. The feed is "
            "keyed on CIK, which is permanent, and `formerNames` preserves "
            "the names it filed under previously. The catch is reaching a "
            "dead filer at all — you need its CIK, and the ticker map will "
            "not give you one."
        ),
        start="1993-1994 for electronic filers; paper filings predate EDGAR",
        frequency="intraday; a new filing appears within minutes of acceptance",
        licence=_LICENCE,
        caveat=(
            "Carries what was FILED. It carries no price, no market cap and "
            "no return, so it can date a company's death and never value it."
        ),
    ),
    "companyfacts": Coverage(
        dataset="companyfacts",
        endpoint=COMPANYFACTS_URL,
        survivorship_free=True,
        survivorship_basis=(
            "Same basis as submissions — it is derived from the filings of "
            "one permanent CIK and is served for filers long gone. Same "
            "catch, too: you must already hold the CIK."
        ),
        start=(
            "XBRL only, so roughly 2009 for large accelerated filers and "
            "2011 for everyone else. There is no XBRL before that and "
            "therefore no companyfacts, however old the company is."
        ),
        frequency="updated as filings are accepted",
        licence=_LICENCE,
        caveat=(
            "Every fact is stamped with the FILING's fiscal year, not the "
            "fact's. Read `extract_facts` before touching `fy`. Also large: "
            "~3.4MB for one filer, so cache and bound what you keep."
        ),
    ),
    "financial_statement_data_sets": Coverage(
        dataset="financial_statement_data_sets",
        endpoint=DERA_URL,
        survivorship_free=True,
        survivorship_basis=(
            "Each quarterly zip is the complete set of numeric XBRL data "
            "for every filing accepted in that quarter, assembled at the "
            "time and never rewritten to reflect who survived. A filer that "
            "went under in 2012 is still in 2012Q1 with the numbers it "
            "reported. This is the only dataset here that is both "
            "survivorship-free AND broad enough to build a panel from "
            "without knowing the CIKs in advance."
        ),
        start="2009Q2 (2009Q1 exists as a 13KB stub and carries nothing)",
        frequency="one zip per quarter, published roughly two weeks after quarter end",
        licence=_LICENCE,
        caveat=(
            "Still no prices. And note what it does NOT suffer from: "
            "num.txt carries `ddate` (the period end) and `qtrs` (the "
            "duration) on every row, so the fiscal-year trap that ruins "
            "companyfacts does not exist here. For a panel this is the "
            "better source on correctness as well as on politeness."
        ),
    ),
    "form25": Coverage(
        dataset="form25",
        endpoint=FULL_INDEX_URL,
        survivorship_free=True,
        survivorship_basis=(
            "It is the record OF the deaths, which makes the question "
            "almost circular — but the property that matters is that the "
            "quarterly full index is written once for a quarter and not "
            "revised as companies come and go. A Form 25 filed in 2008 is "
            "still in the 2008Q1 index today."
        ),
        start=(
            "Measured, per quarter: 1996Q1, 1999Q1 and 2001Q1 carry zero "
            "Form 25s; 2004Q1 carries 114; 25-NSE (the exchange-filed "
            "variant) first appears in 2006Q2 with 256 and has been the "
            "bulk of the record since. So: nothing usable before ~2003, "
            "issuer-filed only until 2006Q2, complete after."
        ),
        frequency="the current quarter's index is rebuilt daily; past quarters are final",
        licence=_LICENCE,
        caveat=(
            "Three things it is not. It is a delisting DATE and not a "
            "delisting PRICE — an acquisition at a premium and a wind-up at "
            "zero are opposite returns that look identical here. It strikes a "
            "CLASS OF SECURITIES and not a company: Verizon appears in "
            "2025Q2 having delisted a note, and its common stock never "
            "stopped trading. And the index lists one row per FILER, so a "
            "25-NSE appears twice — once under the exchange and once under "
            "the issuer. See `mark_exchange_filers`."
        ),
    ),
}


def coverage_frame() -> pd.DataFrame:
    """`COVERAGE` as a frame, for a report that has to state its sources."""
    return pd.DataFrame(
        [
            {
                "dataset": c.dataset,
                "endpoint": c.endpoint,
                # Object dtype on purpose: None means "the question does
                # not apply here", and coercing it to False would turn an
                # inapplicable question into a failed one.
                "survivorship_free": c.survivorship_free,
                "survivorship_basis": c.survivorship_basis,
                "start": c.start,
                "frequency": c.frequency,
                "licence": c.licence,
                "caveat": c.caveat,
            }
            for c in COVERAGE.values()
        ]
    )


# -- failure modes --------------------------------------------------------


class EdgarUnavailable(SourceUnavailable):
    """EDGAR could not be reached, or would not talk to us.

    A condition, never a fact about the market. Distinct from
    `EdgarNotFound` for the same reason base.py keeps `SourceUnavailable`
    distinct from an empty frame: an outage reported as an absence is how
    a throttled minute becomes a company that never existed.
    """


class EdgarNotFound(LookupError):
    """The document is not there, and asking again will not change that.

    Deliberately NOT a `SourceUnavailable`. A 404 is an answer — this
    filer made no such filing, this quarter has not happened yet — and
    treating it as an outage would have callers retrying a fact.
    """


# -- text hygiene ---------------------------------------------------------

#: Tab, newline and carriage return survive; they are the shape of a
#: document. Everything else below 0x20, plus DEL and the surrogate
#: block, does not: parquet and Postgres both refuse a NUL, a lone
#: surrogate is refused the same way and looks identical in a traceback,
#: and one such byte has already cost this project an entire extraction
#: batch that failed naming no file.
_UNSTORABLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")


def storable(value: Any) -> str:
    """A string safe to put in a parquet column or a text column.

    Applied to every string that reaches a frame here rather than to the
    ones that look risky, because the byte that broke us last time came
    out of a filing nobody would have flagged.
    """
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    return _UNSTORABLE.sub("", text)


def _tidy(value: Any) -> str:
    """`storable`, with runs of whitespace collapsed. For names.

    A company name that does not match itself across two pulls is a join
    waiting to fail, and EDGAR's fixed-width indexes pad with whatever
    they like.
    """
    return " ".join(storable(value).split())


# -- the retry classifier -------------------------------------------------

_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

#: SEC's throttle page. Matched on the title rather than the status,
#: because the status it arrives with is shared with a completely
#: different condition — see `_classify`.
_THROTTLE_MARKERS = (
    "request rate threshold exceeded",
    "undeclared automated tool",
)

#: S3's refusal for an object that is not there. SEC serves the Archives
#: and the DERA files from behind a CDN that answers a missing key with
#: `AccessDenied` rather than `NoSuchKey` when listing is denied, so both
#: spellings mean the same thing to us: no such document.
_ABSENT_MARKERS = ("<code>accessdenied</code>", "<code>nosuchkey</code>")


def _classify(status: int, body: str) -> str:
    """One of 'ok', 'absent', 'retry', 'fatal'. Reads the body, not just
    the status.

    This is the one thing here the server-side client
    (`services/secFetch.js`) gets wrong, and it gets it wrong because on
    that side it never mattered: EDGAR answers BOTH "you are asking too
    fast" and "that object does not exist" with HTTP 403. Measured, on
    the same afternoon:

      GET .../full-index/2030/QTR1/form.idx  -> 403, application/xml,
          <Error><Code>AccessDenied</Code>...   (2030 has not happened)
      GET .../company_tickers.json with a library's default UA
          -> 403, text/html, "Request Rate Threshold Exceeded"

    A client that retries every 403 spends three attempts and two
    backoffs discovering that a quarter is in the future, and then
    reports it as throttling — a precise error that is wrong, which is
    worse than a vague one because it sends somebody to look.
    """
    if 200 <= status < 300:
        return "ok"
    if status == 404:
        # An answer. Never retried, on the same reasoning as next door.
        return "absent"
    if status == 403:
        low = body[:2000].lower()
        if any(m in low for m in _ABSENT_MARKERS):
            return "absent"
        if any(m in low for m in _THROTTLE_MARKERS):
            return "retry"
        # Unrecognised 403. Retried, because the failure we have actually
        # seen in the wild is the throttle and a wasted retry is cheaper
        # than a wrongly-reported absence.
        return "retry"
    if status in _RETRY_STATUSES:
        return "retry"
    return "fatal"


# -- fiscal periods -------------------------------------------------------

#: XBRL duration endpoints are inclusive, so a period's length is the day
#: difference plus one. The annual band is wide enough for a 52/53-week
#: filer (364 or 371 days) and narrow enough to exclude a nine-month
#: year-to-date figure (274).
_PERIOD_BANDS: tuple[tuple[str, int, int], ...] = (
    ("quarterly", 75, 105),
    ("semiannual", 150, 200),
    ("threequarters", 250, 300),
    ("annual", 330, 400),
)


def period_kind(start: Any, end: Any) -> tuple[str, int | None]:
    """The period's shape and its length in days.

    'other' is a real answer and is kept rather than dropped: a
    transition period after a fiscal-year change is a genuine 26-week
    reporting period, and silently discarding it would leave a hole that
    reads as a company that stopped reporting.
    """
    if start in (None, "") or pd.isna(pd.Timestamp(start)):
        return "instant", None
    length = (pd.Timestamp(end) - pd.Timestamp(start)).days + 1
    for name, lo, hi in _PERIOD_BANDS:
        if lo <= length <= hi:
            return name, length
    return "other", length


def _year_offset(anchor: pd.Timestamp, end: pd.Timestamp) -> int:
    """How many fiscal years `end` sits before `anchor`.

    Calendar arithmetic, and safe here for one reason only: both dates
    come from the SAME filer's fiscal calendar, so the convention that
    makes an absolute reading dangerous cancels out. JNJ's fiscal 2020
    ended 3 January 2021 and its fiscal 2019 ended 29 December 2019 —
    370 days apart, which rounds to one year. Walmart's fiscal 2026 ended
    31 January 2026 and its 2025 ended 31 January 2025 — 365 days, also
    one year. Neither can be read as a year on its own, and both are
    exactly one step from their own anchor.
    """
    return int(round((anchor - end).days / 365.25))


# -- parsers, kept free of the client -------------------------------------


def parse_company_tickers(payload: Any) -> pd.DataFrame:
    """`company_tickers.json` as a frame. Living registrants only.

    See `COVERAGE["ticker_map"]`. The frame carries no `is_delisted`
    column, deliberately: a column that would be False on every row is
    not a finding, it is a tautology, and this project has already
    written down what it thinks of those.
    """
    if isinstance(payload, dict):
        rows = list(payload.values())
    elif isinstance(payload, list):
        rows = list(payload)
    else:
        raise EdgarUnavailable(
            f"the ticker map came back as {type(payload).__name__}, not an "
            f"object keyed by row number. This is a shape change at SEC or a "
            f"proxy in the way — not an empty universe."
        )

    built = [
        {
            "cik": int(r["cik_str"]),
            "ticker": _tidy(r.get("ticker")).upper(),
            "name": _tidy(r.get("title")),
        }
        for r in rows
        if isinstance(r, dict) and r.get("cik_str") is not None
    ]
    if not built:
        raise EdgarUnavailable(
            "the ticker map parsed to zero rows. SEC publishes ten thousand "
            "of them, so this is our parse or their outage, and either way it "
            "is not a market with no listed companies in it."
        )
    out = pd.DataFrame(built)
    return out.sort_values(["ticker", "cik"]).reset_index(drop=True)


def parse_company_tickers_exchange(payload: Any) -> pd.DataFrame:
    """The exchange-carrying variant: `[cik, name, ticker, exchange]`.

    The venue is TODAY's venue with no history behind it. Nothing that
    needs a listing venue as of a past date may read this column — for
    that, the delisting record is the only free evidence there is.
    """
    if not isinstance(payload, dict) or "data" not in payload:
        raise EdgarUnavailable(
            f"company_tickers_exchange came back as "
            f"{type(payload).__name__} with no 'data' block."
        )
    fields = [str(f) for f in payload.get("fields", [])]
    idx = {name: i for i, name in enumerate(fields)}
    needed = ("cik", "name", "ticker", "exchange")
    missing = [n for n in needed if n not in idx]
    if missing:
        raise EdgarUnavailable(
            f"company_tickers_exchange is missing field(s) {missing}; SEC "
            f"published {fields}. A positional parse against a changed "
            f"header would silently put exchanges in the name column."
        )

    rows = [
        {
            "cik": int(r[idx["cik"]]),
            "ticker": _tidy(r[idx["ticker"]]).upper(),
            "name": _tidy(r[idx["name"]]),
            "exchange": _tidy(r[idx["exchange"]]),
        }
        for r in payload["data"]
        if isinstance(r, (list, tuple)) and len(r) >= len(fields)
    ]
    out = pd.DataFrame(rows, columns=["cik", "ticker", "name", "exchange"])
    return out.sort_values(["ticker", "cik"]).reset_index(drop=True)


_PROFILE_STRINGS = (
    "name",
    "entityType",
    "sicDescription",
    "stateOfIncorporation",
    "fiscalYearEnd",
    "category",
    "ein",
    "phone",
    "website",
)


def parse_filer_profile(payload: Mapping[str, Any]) -> pd.DataFrame:
    """One row of who this filer is, from the submissions feed.

    Head office, SIC and fiscal year end are FIELDS here. That is worth
    a sentence because the wider project once mined them out of Item 1
    with a regex and gave General Dynamics a head office in St. Louis,
    matched from a sentence about a customer's building. Ask a structured
    source before mining prose.

    `fiscal_year_end` is the filer's own MMDD and is the only safe anchor
    for a fiscal calendar. `tickers` and `exchanges` are CURRENT and are
    joined into one string each rather than exploded, because a filer
    with three share classes has three of each and fanning the row out
    would make a one-row-per-filer frame quietly not that.
    """
    if not isinstance(payload, Mapping):
        raise EdgarUnavailable(
            f"submissions came back as {type(payload).__name__}, not an object"
        )
    addresses = payload.get("addresses") or {}
    business = addresses.get("business") if isinstance(addresses, Mapping) else None
    business = business if isinstance(business, Mapping) else {}

    row: dict[str, Any] = {
        "cik": int(payload.get("cik") or 0),
        "sic": _tidy(payload.get("sic")),
        "tickers": "|".join(_tidy(t).upper() for t in payload.get("tickers") or []),
        "exchanges": "|".join(_tidy(e) for e in payload.get("exchanges") or []),
        "business_city": _tidy(business.get("city")),
        "business_state": _tidy(business.get("stateOrCountry")),
        "business_country": _tidy(business.get("countryCode")),
        # A filer with no former names is the common case and an empty
        # string is the honest rendering of it. A zero would be a count
        # and this is not one.
        "former_name_count": len(payload.get("formerNames") or []),
    }
    for key in _PROFILE_STRINGS:
        row[_snake(key)] = _tidy(payload.get(key))
    return pd.DataFrame([row])


def parse_former_names(payload: Mapping[str, Any]) -> pd.DataFrame:
    """Every name this CIK has filed under, with the window it used it.

    The reason this matters is `schema.py`'s reason: ticker strings are
    recycled and so are company names. A CIK is not, so the mapping from
    permanent identity to the string it wore in 2009 is the join that
    stops a dead company's history being grafted onto a living one's.
    """
    cik = int(payload.get("cik") or 0)
    rows = []
    for item in payload.get("formerNames") or []:
        if not isinstance(item, Mapping):
            continue
        rows.append(
            {
                "cik": cik,
                "former_name": _tidy(item.get("name")),
                "from_date": _stamp(item.get("from")),
                "to_date": _stamp(item.get("to")),
            }
        )
    if not rows:
        return pd.DataFrame(
            {
                "cik": pd.Series([], dtype="int64"),
                "former_name": pd.Series([], dtype="str"),
                "from_date": pd.Series([], dtype="datetime64[ns]"),
                "to_date": pd.Series([], dtype="datetime64[ns]"),
            }
        )
    return pd.DataFrame(rows).sort_values("from_date").reset_index(drop=True)


_FILING_FIELDS = (
    "accessionNumber",
    "filingDate",
    "reportDate",
    "acceptanceDateTime",
    "form",
    "primaryDocument",
    "primaryDocDescription",
    "items",
    "size",
    "isXBRL",
)


def parse_filing_index(cik: int, *blocks: Mapping[str, Any]) -> pd.DataFrame:
    """Filings from one or more column-oriented blocks, oldest first.

    The submissions feed holds the most recent thousand filings inline
    under `filings.recent` and pushes the rest into separate JSON files
    named in `filings.files`. Both have the same column-oriented shape —
    parallel arrays, one per field — so both come through here and the
    caller decides how much history to pay for.

    Parallel arrays are joined by POSITION, so a block whose arrays are
    different lengths is a corrupt block rather than a short one. It
    raises. Truncating to the shortest would silently pair one filing's
    accession with another's date, which is a fabricated document.
    """
    frames: list[pd.DataFrame] = []
    for block in blocks:
        if not isinstance(block, Mapping) or "accessionNumber" not in block:
            continue
        lengths = {
            len(block[f]) for f in _FILING_FIELDS if isinstance(block.get(f), list)
        }
        if len(lengths) > 1:
            raise EdgarUnavailable(
                f"CIK {cik}: a submissions block has columns of differing "
                f"lengths {sorted(lengths)}. These arrays are joined by "
                f"position, so pairing them anyway would invent filings that "
                f"nobody made."
            )
        n = len(block["accessionNumber"])
        built = {
            "cik": [int(cik)] * n,
            "accession": [_tidy(a) for a in block["accessionNumber"]],
            "form": [_tidy(f) for f in block.get("form", [""] * n)],
            "filed": [_stamp(d) for d in block.get("filingDate", [None] * n)],
            "report_date": [_stamp(d) for d in block.get("reportDate", [None] * n)],
            "primary_document": [
                _tidy(d) for d in block.get("primaryDocument", [""] * n)
            ],
            "description": [
                _tidy(d) for d in block.get("primaryDocDescription", [""] * n)
            ],
            "items": [_tidy(i) for i in block.get("items", [""] * n)],
            "is_xbrl": [bool(x) for x in block.get("isXBRL", [0] * n)],
        }
        frames.append(pd.DataFrame(built))

    if not frames:
        return _empty_filings()
    out = pd.concat(frames, ignore_index=True)
    out = out.assign(
        filing_index_url=[
            _filing_index_url(cik, a) for a in out["accession"].to_numpy()
        ],
        document_url=[
            _document_url(cik, a, d)
            for a, d in zip(out["accession"], out["primary_document"])
        ],
    )
    return out.sort_values(["filed", "accession"]).reset_index(drop=True)


def _empty_filings() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "cik": pd.Series([], dtype="int64"),
            "accession": pd.Series([], dtype="str"),
            "form": pd.Series([], dtype="str"),
            "filed": pd.Series([], dtype="datetime64[ns]"),
            "report_date": pd.Series([], dtype="datetime64[ns]"),
            "primary_document": pd.Series([], dtype="str"),
            "description": pd.Series([], dtype="str"),
            "items": pd.Series([], dtype="str"),
            "is_xbrl": pd.Series([], dtype="bool"),
            "filing_index_url": pd.Series([], dtype="str"),
            "document_url": pd.Series([], dtype="str"),
        }
    )


# -- companyfacts, and the year that is not there -------------------------

#: What `extract_facts` pulls when nobody names a concept list. Small on
#: purpose: `us-gaap` alone carries 428 concepts for a mid-cap filer and
#: several thousand for a bank, and holding all of them for a panel of
#: filers is how a convenience call becomes a memory problem. Pass
#: `concepts="all"` when you actually want everything and mean it.
STANDARD_CONCEPTS: Mapping[str, tuple[str, ...]] = {
    "us-gaap": (
        "Assets",
        "AssetsCurrent",
        "Liabilities",
        "LiabilitiesCurrent",
        "StockholdersEquity",
        "Revenues",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "CostOfRevenue",
        "GrossProfit",
        "OperatingIncomeLoss",
        "NetIncomeLoss",
        "EarningsPerShareDiluted",
        "NetCashProvidedByUsedInOperatingActivities",
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "CashAndCashEquivalentsAtCarryingValue",
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ),
    "dei": (
        "EntityCommonStockSharesOutstanding",
        "EntityPublicFloat",
    ),
}

_FACT_COLUMNS: dict[str, str] = {
    "cik": "int64",
    "entity_name": "str",
    "taxonomy": "str",
    "concept": "str",
    "unit": "str",
    "accession": "str",
    "form": "str",
    "period": "str",
    "period_start": "datetime64[ns]",
    "period_end": "datetime64[ns]",
    "period_days": "Int64",
    "fiscal_year": "Int64",
    "filing_fiscal_year": "Int64",
    "fiscal_period": "str",
    "filed": "datetime64[ns]",
    "frame": "str",
    "value": "float64",
    "fy_conflict": "bool",
}


def extract_facts(
    payload: Mapping[str, Any],
    *,
    concepts: Mapping[str, Sequence[str]] | str | None = None,
) -> pd.DataFrame:
    """companyfacts as a long frame, with the fiscal year RECOVERED.

    The trap, which this project has already paid for once: SEC stamps
    every fact in a filing with the FILING's `fy`. A 10-K carries three
    comparative years and all three arrive labelled with the filing's own
    fiscal year, so grouping on `fy` collapses them into one — and since
    SEC returns each unit's array sorted by `end` ASCENDING, and the
    tiebreak cannot separate rows that share an accession and a filing
    date, the survivor is the OLDEST. That printed General Dynamics'
    calendar-2023 income statement under the heading FY2025: a two-year
    shift on every annual row of every holding, with the two most recent
    years simply missing.

    Measured again while writing this file, on Mesa Labs' 10-K accession
    0001437749-18-011240: fifteen Revenues facts with period ends from
    2015-06-30 to 2018-03-31, every one of them stamped `fy: 2018`.

    So the year comes from POSITION within an accession. Within one
    accession and one period shape, the distinct period ends are ranked
    newest-first; the newest IS the filing's fiscal year (this is the
    only thing `fy` is trusted for, and it is trusted because it is the
    filer's own anchor) and each earlier one is a year further back.

    A second reading is computed alongside it — the rounded distance from
    the anchor in years — and where the two disagree `fy_conflict` goes
    True. Position wins; distance is a second opinion and not the answer.
    It has to be, because the two part company on every 10-Q: the
    anchor there is a mid-year balance date, the prior year-end balance
    sheet sits ninety days behind it, and rounding that gap gives no
    years at all. That row belongs to the year it closed. Where they
    disagree for any other reason — a filer changing its fiscal year end
    and filing a stub period, an accession mixing quarter-end and
    year-end instants — the flag is the invitation to look, and there is
    no honest way to resolve it from the payload alone.

    Neither reading is calendar arithmetic on an end date in isolation,
    which is the thing that must never happen: JNJ's fiscal 2020 ended 3
    January 2021 and Walmart's fiscal 2026 ended 31 January 2026, so the
    same month means opposite things. Both readings are relative to the
    filer's OWN anchor, where that convention cancels out.

    `filing_fiscal_year` keeps SEC's raw `fy` beside the recovered one.
    Not for use — for proof, so nobody has to refetch 3.4MB to see for
    themselves that the two differ. Measured on General Dynamics'
    annual Revenues: a third of the rows are stamped correctly, a third
    are one year out, and a third are two.
    """
    if not isinstance(payload, Mapping) or "facts" not in payload:
        raise EdgarUnavailable(
            f"companyfacts came back as {type(payload).__name__} with no "
            f"'facts' block. A filer with no XBRL answers 404, which is a "
            f"different thing and is raised as one."
        )

    cik = int(payload.get("cik") or 0)
    entity = _tidy(payload.get("entityName"))
    wanted = _resolve_concepts(concepts)

    rows: list[dict[str, Any]] = []
    for taxonomy, block in (payload.get("facts") or {}).items():
        if not isinstance(block, Mapping):
            continue
        allowed = None if wanted is None else wanted.get(str(taxonomy))
        if wanted is not None and not allowed:
            continue
        for concept, detail in block.items():
            if allowed is not None and concept not in allowed:
                continue
            units = (detail or {}).get("units")
            if not isinstance(units, Mapping):
                continue
            for unit, facts in units.items():
                if not isinstance(facts, list):
                    continue
                rows.extend(
                    _facts_for_unit(cik, entity, taxonomy, concept, unit, facts)
                )

    if not rows:
        # A genuinely empty answer: the filer has XBRL but none of the
        # requested concepts. Empty is the truth here and the frame says
        # so with the right dtypes; an outage would have raised upstream.
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in _FACT_COLUMNS.items()})

    out = pd.DataFrame(rows)
    out = _typed(out, _FACT_COLUMNS)
    return out.sort_values(
        ["taxonomy", "concept", "unit", "period_end", "filed"]
    ).reset_index(drop=True)


def _resolve_concepts(
    concepts: Mapping[str, Sequence[str]] | str | None,
) -> dict[str, frozenset[str]] | None:
    if concepts is None:
        return {k: frozenset(v) for k, v in STANDARD_CONCEPTS.items()}
    if isinstance(concepts, str):
        if concepts.lower() != "all":
            raise ValueError(
                f"concepts must be a mapping, None, or the literal 'all'; "
                f"got {concepts!r}. A bare string would silently be read as "
                f"an iterable of single characters."
            )
        return None
    return {str(k): frozenset(str(c) for c in v) for k, v in concepts.items()}


def _facts_for_unit(
    cik: int,
    entity: str,
    taxonomy: str,
    concept: str,
    unit: str,
    facts: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """One unit's facts, with the year recovered per accession.

    Grouped by (accession, period shape) rather than by accession alone,
    because a 10-K carries twelve quarterly ends and three annual ones in
    the same document. Ranking those together would put the oldest
    quarter eleven years before the filing.
    """
    staged: list[dict[str, Any]] = []
    for f in facts:
        if not isinstance(f, Mapping) or f.get("val") is None:
            continue
        end = _stamp(f.get("end"))
        if end is None:
            continue
        start = _stamp(f.get("start"))
        shape, days = period_kind(f.get("start"), f.get("end"))
        staged.append(
            {
                "cik": cik,
                "entity_name": entity,
                "taxonomy": _tidy(taxonomy),
                "concept": _tidy(concept),
                "unit": _tidy(unit),
                "accession": _tidy(f.get("accn")),
                "form": _tidy(f.get("form")),
                "period": shape,
                "period_start": start,
                "period_end": end,
                "period_days": days,
                "filing_fiscal_year": _int_or_none(f.get("fy")),
                "fiscal_period": _tidy(f.get("fp")),
                "filed": _stamp(f.get("filed")),
                "frame": _tidy(f.get("frame")),
                "value": float(f["val"]),
            }
        )

    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in staged:
        groups.setdefault((row["accession"], row["period"]), []).append(row)

    for rows in groups.values():
        _assign_fiscal_year(rows)
    return staged


def _assign_fiscal_year(rows: list[dict[str, Any]]) -> None:
    """Fill `fiscal_year` and `fy_conflict` for one accession-and-shape.

    Mutates in place, which is worth the ugliness: the alternative is
    rebuilding every row to change two fields, on a frame that can run
    to a hundred thousand rows for a large filer.
    """
    ends = sorted({r["period_end"] for r in rows}, reverse=True)
    anchor = ends[0]
    # The ONE use of SEC's `fy`, and only as the anchor's label. Where
    # even that is absent — it happens on old filings — the anchor's
    # calendar year is the fallback, which is a guess and is marked as a
    # conflict on every row so it can never pass for a reading.
    stamped = next(
        (r["filing_fiscal_year"] for r in rows if r["filing_fiscal_year"] is not None),
        None,
    )
    anchor_fy = stamped if stamped is not None else int(anchor.year)

    rank = {end: i for i, end in enumerate(ends)}
    for r in rows:
        end = r["period_end"]
        positional = anchor_fy - rank[end]
        by_distance = anchor_fy - _year_offset(anchor, end)
        # Position wins, and it is the reading that has been checked
        # against filings: General Dynamics, Mesa Labs and Walmart all
        # come out right, across a December, a March and a January
        # fiscal year end. Distance is kept as a second opinion rather
        # than as the answer — it disagrees whenever the anchor is a
        # mid-year date, which is every 10-Q, where the prior year-end
        # balance sheet sits ninety days back and rounds to no years at
        # all. That row belongs to the year it closed, and position says
        # so.
        r["fiscal_year"] = positional
        r["fy_conflict"] = bool(positional != by_distance) or stamped is None


# -- the delisting record -------------------------------------------------

#: Both variants and the amendment. `25` is filed by the issuer, `25-NSE`
#: by the national securities exchange — the distinction is the closest
#: thing to a free delisting REASON that does not cost a request per
#: company, because an exchange striking a security and an issuer
#: withdrawing one are different events.
FORM25_FORMS: tuple[str, ...] = ("25", "25-NSE", "25-NSE/A")

#: The quarterly index is fixed-width in principle and padded in
#: practice, and the padding does not match its own header. Anchoring on
#: the tail instead: a CIK is digits, a date is a date, and the path
#: always begins `edgar/`. Both date spellings appear — the quarterly
#: index writes 2025-06-06 and the daily index writes 20250606.
_IDX_ROW = re.compile(
    r"^(?P<form>\S+)\s{2,}(?P<name>.+?)\s{2,}(?P<cik>\d+)\s+"
    r"(?P<filed>\d{4}-\d{2}-\d{2}|\d{8})\s+(?P<path>edgar/\S+)\s*$"
)

_FORM25_COLUMNS: dict[str, str] = {
    "form": "str",
    "cik": "int64",
    "name": "str",
    "filed": "datetime64[ns]",
    "accession": "str",
    "year": "Int64",
    "quarter": "Int64",
    "filing_txt_url": "str",
    "filing_index_url": "str",
}


def parse_form_index(
    text: str,
    *,
    forms: Iterable[str] = FORM25_FORMS,
    year: int | None = None,
    quarter: int | None = None,
) -> pd.DataFrame:
    """Rows of the chosen form types out of an EDGAR form index.

    Kept general (`forms` is an argument) because the same file is the
    cheapest way to sweep any form type across every filer in a quarter,
    and kept defaulted to Form 25 because that is the one worth the
    download.

    A parse that finds no data rows AT ALL raises. An index with no Form
    25 in it is ordinary — 1996Q1 has none, measured — but an index with
    no rows of any kind means the format moved or something served us a
    holding page, and reporting that as a quarter in which nobody
    delisted would be exactly the wrong sentence.
    """
    wanted = frozenset(str(f).strip().upper() for f in forms)
    rows: list[dict[str, Any]] = []
    seen_any = False

    for line in text.splitlines():
        m = _IDX_ROW.match(line)
        if m is None:
            continue
        seen_any = True
        form = m.group("form").strip().upper()
        if form not in wanted:
            continue
        cik = int(m.group("cik"))
        accession = _accession_from_path(m.group("path"))
        rows.append(
            {
                "form": form,
                "cik": cik,
                "name": _tidy(m.group("name")),
                "filed": _stamp(m.group("filed")),
                "accession": accession,
                "year": year,
                "quarter": quarter,
                "filing_txt_url": ARCHIVES + m.group("path").strip(),
                "filing_index_url": _filing_index_url(cik, accession),
            }
        )

    if not seen_any:
        raise EdgarUnavailable(
            "this form index parsed to zero rows of any form type. Every "
            "EDGAR quarter contains tens of thousands, so the format has "
            "moved or something answered in its place — and an empty result "
            "here would read as a quarter in which nobody filed anything."
        )
    if not rows:
        return _empty_form25()
    out = _typed(pd.DataFrame(rows), _FORM25_COLUMNS)
    return out.sort_values(["filed", "cik", "form"]).reset_index(drop=True)


def _empty_form25() -> pd.DataFrame:
    """The parse's shape with no rows. `is_exchange_filer` is NOT here.

    That column is added by `mark_exchange_filers`, and its absence from
    the parse output is the point: whether a row is the exchange or the
    issuer is a fact about the whole quarter, not about the line, and a
    frame that carried the column before anyone computed it would be
    carrying a default that reads as an answer.
    """
    return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in _FORM25_COLUMNS.items()})


#: How many distinct counterparties a filer needs before it can be called
#: an exchange at all. A brand-new venue that struck two listings in its
#: first quarter falls under this floor and its rows survive as
#: duplicates — which is the error worth making, because the alternative
#: is dropping a real issuer's delisting on thin evidence.
_EXCHANGE_MIN_COUNTERPARTIES = 3


def mark_exchange_filers(frame: pd.DataFrame) -> pd.DataFrame:
    """Flag the rows that are the EXCHANGE rather than the delisted company.

    EDGAR's form index lists one row per FILER, and a 25-NSE has two: the
    national securities exchange that struck the listing, and the issuer
    whose security was struck. Counted naively, the New York Stock
    Exchange delisted sixty-eight times in 2025Q2 and Nasdaq a hundred
    and twelve. Anything building a decedent list off row counts gets the
    exchanges at the top of it.

    Identified from the data, never from a hardcoded CIK list, which
    would go stale the first time a venue is renamed — inside this record
    the American Stock Exchange became NYSE Amex became NYSE MKT became
    NYSE American, and NYSE Texas first files in 2025.

    Two tests, and both must pass.

    **Distinct counterparties within the quarter.** The two roles have
    completely different shapes: measured across 2006Q2, 2008Q1, 2012Q3,
    2015Q1, 2020Q2 and 2025Q2, exchanges carry 4 to 131 distinct
    counterparties. A mere COUNT of filings would not separate them —
    Citigroup can strike ten note classes in a quarter — but all ten are
    struck by the same one exchange, so the issuer's counterparty set
    stays at one.

    **The accession is filed under this CIK.** An accession number's
    first ten digits are the CIK of the filer of record, and for a 25-NSE
    that is the exchange. This is the test that earns its place: on the
    counterparty rule alone, Harrah's Entertainment — which filed Form
    25s for several note classes with different subsidiary co-filers in
    2008Q1 — reached three counterparties, beat each of them, and was
    struck off as an exchange. It files through an agent, so its
    accession prefix is not its own CIK, and the second test drops it.
    Across those six quarters the pair flags no company that is not an
    exchange.

    It does UNDER-flag: a handful of small-venue rows survive each
    quarter, and Nasdaq Inc — the listed company, which delists
    securities of its own — is correctly kept in 2020Q2. Under-flagging
    leaves a duplicate row. Over-flagging deletes a company's death from
    a record whose entire purpose is to hold it, so the asymmetry is
    deliberate.

    Ties are left unflagged. Two co-filers who each appear only with each
    other are an issuer and its financing vehicle, and there is no
    exchange in that accession to find.
    """
    if frame.empty:
        return frame.assign(is_exchange_filer=pd.Series([], dtype="bool"))

    partners: dict[int, set[int]] = {}
    for _, group in frame.groupby("accession"):
        ciks = sorted({int(c) for c in group["cik"]})
        if len(ciks) != 2:
            continue
        a, b = ciks
        partners.setdefault(a, set()).add(b)
        partners.setdefault(b, set()).add(a)

    flagged: set[tuple[str, int]] = set()
    for accession, group in frame.groupby("accession"):
        ciks = sorted({int(c) for c in group["cik"]})
        if len(ciks) != 2:
            continue
        a, b = ciks
        na, nb = len(partners.get(a, ())), len(partners.get(b, ()))
        if na == nb:
            continue
        winner, count = (a, na) if na > nb else (b, nb)
        if count < _EXCHANGE_MIN_COUNTERPARTIES:
            continue
        if _accession_filer_cik(accession) != winner:
            continue
        flagged.add((str(accession), winner))

    return frame.assign(
        is_exchange_filer=[
            (str(acc), int(cik)) in flagged
            for acc, cik in zip(frame["accession"], frame["cik"])
        ]
    )


def _accession_filer_cik(accession: Any) -> int | None:
    """The filer-of-record CIK encoded in an accession number's prefix."""
    head = str(accession).strip()[:10]
    return int(head) if head.isdigit() else None


#: The rule the filer struck the security under. The two that carry
#: information about the company's fate are (b) and (c): (b) is the
#: exchange striking a listing, which is the involuntary case, and (c) is
#: the issuer walking away, which is usually a merger closing or a
#: go-private. The (a) provisions cover securities that stopped existing
#: for a mechanical reason — redeemed, matured, converted.
DELISTING_RULES: Mapping[str, str] = {
    "12d2-2(a)(1)": "issuer: security no longer outstanding",
    "12d2-2(a)(2)": "issuer: security redeemed or retired in full",
    "12d2-2(a)(3)": "issuer: security matured or was called",
    "12d2-2(a)(4)": "issuer: security withdrawn or replaced by operation of law",
    "12d2-2(b)": "exchange struck the listing (involuntary)",
    "12d2-2(c)": "issuer voluntarily withdrew the listing",
}

#: Ballot boxes, as the forms actually spell them. Checked is 2612 or
#: 2611; empty is 2610. Filings that use an image or a typed capital X
#: instead simply do not resolve, and `confident` says so — a guessed
#: reason on a delisting is a fabricated one.
_CHECKED = "☒☑✓✔"
_UNCHECKED = "☐"


def parse_delisting_reason(document: str) -> dict[str, Any]:
    """Which Rule 12d2-2 provision the Form 25 relied on.

    Best effort by construction and honest about it. The rule boxes are
    checkbox glyphs in a table, and where a filer used an image, a typed
    X or a checkbox we do not recognise, this returns `rule=None` and
    `confident=False` rather than picking the likeliest. A delisting
    reason is the difference between an acquisition at a premium and a
    liquidation at zero; a guess there is not a small error.

    More than one box checked is also `confident=False`, with every
    checked rule listed. It happens, and picking one would be inventing
    a decision the filer did not make.
    """
    text = _plain_text(document)
    checked: list[str] = []
    unchecked: list[str] = []
    for rule in DELISTING_RULES:
        state = _box_state(text, rule)
        if state is True:
            checked.append(rule)
        elif state is False:
            unchecked.append(rule)

    rule = checked[0] if len(checked) == 1 else None
    return {
        "rule": rule,
        "meaning": DELISTING_RULES.get(rule or "", ""),
        "checked": tuple(checked),
        "unchecked": tuple(unchecked),
        "confident": rule is not None,
        "commission_file_number": _commission_file_number(text),
    }


def classify_delisting(form: str, rule: str | None) -> str:
    """Who ended the listing: 'exchange', 'issuer', or 'unknown'.

    The FORM TYPE is the stronger signal and is read first — a 25-NSE is
    filed by the national securities exchange, full stop, and needs no
    document fetch. The rule box refines a plain Form 25, which the
    issuer files for reasons ranging from a merger closing to a bond
    maturing.
    """
    token = str(form).strip().upper()
    if token.startswith("25-NSE"):
        return "exchange"
    if rule == "12d2-2(b)":
        return "exchange"
    if rule in DELISTING_RULES:
        return "issuer"
    if token == "25":
        # The issuer filed it, which is all we know without the document.
        return "issuer"
    return "unknown"


# -- DERA financial statement data sets -----------------------------------

#: 2009Q1 exists as a 13KB stub and carries nothing; 2009Q2 is 145KB and
#: is the first quarter with real content. Measured, both.
DERA_FIRST_QUARTER: tuple[int, int] = (2009, 2)

#: sub.txt has 36 columns and most of them are a filer's street address.
#: Kept: identity, fiscal calendar, and the flags that decide whether a
#: row is usable. Dropping the rest is the memory bound the brief asks
#: for, and it is a bound that matters — a modern quarter's zip is 85MB.
DERA_SUB_COLUMNS: tuple[str, ...] = (
    "adsh",
    "cik",
    "name",
    "sic",
    "countryba",
    "stprba",
    "cityba",
    "former",
    "changed",
    "afs",
    "wksi",
    "fye",
    "form",
    "period",
    "fy",
    "fp",
    "filed",
    "accepted",
    "prevrpt",
    "detail",
    "nciks",
)

#: num.txt, minus `footnote`. The footnote is free prose, it is the
#: single biggest column in the file, and it is where the control bytes
#: live. Nothing downstream computes on it. Ask for it explicitly if you
#: want it and it will come through `storable`.
DERA_NUM_COLUMNS: tuple[str, ...] = (
    "adsh",
    "tag",
    "version",
    "ddate",
    "qtrs",
    "uom",
    "segments",
    "coreg",
    "value",
)

#: Rows per read_csv chunk when filtering num.txt. A modern quarter's
#: num.txt runs to millions of rows uncompressed, and the whole point of
#: the tag filter is that we never hold all of them.
DERA_CHUNK_ROWS = 250_000


def parse_dera_sub(data: bytes) -> pd.DataFrame:
    """sub.txt: one row per filing in the quarter.

    `fy` and `fp` here are the FILING's fiscal year and period, same as
    companyfacts — but unlike companyfacts they sit on the submission
    rather than on every fact, so they cannot collapse three years into
    one. The per-fact period lives in num.txt as `ddate` + `qtrs`.
    """
    frame = pd.read_csv(
        io.BytesIO(data),
        sep="\t",
        dtype=str,
        encoding="utf-8",
        encoding_errors="replace",
        na_filter=False,
        low_memory=False,
    )
    keep = [c for c in DERA_SUB_COLUMNS if c in frame.columns]
    out = frame.loc[:, keep].copy()
    for column in out.columns:
        out[column] = [storable(v) for v in out[column]]
    # Typed only where the column arrived. A hard `out["filed"]` would
    # turn a dropped column at SEC into a KeyError from inside a parser,
    # which reads as our bug rather than as their schema moving.
    return _retype(
        out, {"cik": "Int64", "filed": "date", "period": "date"}
    ).reset_index(drop=True)


def _retype(frame: pd.DataFrame, casts: Mapping[str, str]) -> pd.DataFrame:
    """Cast the named columns that are actually present, and no others."""
    updates: dict[str, pd.Series] = {}
    for column, kind in casts.items():
        if column not in frame.columns:
            continue
        if kind == "date":
            updates[column] = _stamps(frame[column])
        else:
            updates[column] = pd.to_numeric(frame[column], errors="coerce").astype(kind)
    return frame.assign(**updates) if updates else frame


def parse_dera_num(
    data: bytes,
    *,
    tags: Iterable[str] | None = None,
    keep_footnote: bool = False,
    chunk_rows: int = DERA_CHUNK_ROWS,
) -> pd.DataFrame:
    """num.txt: every numeric fact, filtered to `tags` as it streams.

    Read in chunks and filtered per chunk, so the peak memory is the
    chunk plus what survives the filter rather than the whole file. That
    is not a micro-optimisation: a recent quarter's num.txt is hundreds
    of megabytes uncompressed and this repository runs on a laptop.

    The column worth understanding is `qtrs`: 0 is an instant (a balance
    sheet date), 1 is a quarter, 4 is a year. With `ddate` beside it,
    every row states its own period — which means the fiscal-year trap
    that ruins companyfacts DOES NOT EXIST in this dataset. For a panel
    that makes DERA the better source on correctness as well as on the
    number of requests it costs.
    """
    wanted = None if tags is None else frozenset(str(t) for t in tags)
    columns = list(DERA_NUM_COLUMNS) + (["footnote"] if keep_footnote else [])

    kept: list[pd.DataFrame] = []
    reader = pd.read_csv(
        io.BytesIO(data),
        sep="\t",
        dtype=str,
        encoding="utf-8",
        encoding_errors="replace",
        na_filter=False,
        chunksize=chunk_rows,
        low_memory=False,
    )
    for chunk in reader:
        if wanted is not None:
            chunk = chunk.loc[chunk["tag"].isin(wanted)]
        if chunk.empty:
            continue
        keep = [c for c in columns if c in chunk.columns]
        kept.append(chunk.loc[:, keep].copy())

    if not kept:
        built = {c: pd.Series([], dtype="str") for c in columns}
        built["value"] = pd.Series([], dtype="float64")
        built["ddate"] = pd.Series([], dtype="datetime64[ns]")
        built["qtrs"] = pd.Series([], dtype="Int64")
        return pd.DataFrame(built)

    out = pd.concat(kept, ignore_index=True)
    for column in out.columns:
        if column in ("value", "ddate", "qtrs"):
            continue
        out[column] = [storable(v) for v in out[column]]
    return _retype(
        out, {"value": "float64", "ddate": "date", "qtrs": "Int64"}
    ).reset_index(drop=True)


# -- the client -----------------------------------------------------------

#: Frame kinds and how long an entry stays fresh. `cache.py` gives an
#: unregistered frame one day, which is right for anything that grows and
#: wrong for a quarter that closed in 2015 — so a closed quarter is
#: written under a different frame name from the open one, and the name
#: carries the TTL. That is deliberately visible rather than clever: the
#: alternative is teaching cache.py about EDGAR's calendar.
EDGAR_TTL_DAYS: Mapping[str, float | None] = {
    "ticker_map": 1.0,
    "filer_profile": 1.0,
    "filing_index": 1.0,
    "former_names": 1.0,
    # Seven days is a judgement, not a shrug. The payload is ~3.4MB per
    # filer and a fresh 10-K appears at most quarterly, so refetching
    # daily is rude for almost no information. The cost is that a filing
    # made in the last week can be missing; when that matters, pass
    # refresh=True and make the refetch a decision somebody took.
    "company_facts": 7.0,
    # A closed quarter's index is final. The one containing today is
    # rebuilt daily and lives under `form25_open`.
    "form25": None,
    "form25_open": 1.0,
    "dera_submissions": None,
    "dera_numbers": None,
}

#: Zips are not frames, so they do not belong in a ParquetCache. They go
#: beside it under the same data root, and the reason to keep them at all
#: is that a DERA quarter is 85MB and a caller who wants a second tag out
#: of it should not pay for that twice.
DEFAULT_RAW_ROOT = DEFAULT_ROOT.parent / "edgar-raw"


def default_cache(root: Path | str = DEFAULT_ROOT) -> ParquetCache:
    """A ParquetCache that knows EDGAR's TTLs.

    Callers may pass their own instead; if they do, they get their own
    TTLs, and a closed quarter will then age out on whatever timer they
    configured. That is their call to make and this docstring is where
    they find out they made it.
    """
    return ParquetCache(root, ttl_days=EDGAR_TTL_DAYS)


class _UseDefaultCache:
    """Sentinel for `cache`, and it has to be distinct from None.

    The obvious spelling — `cache=None` means "build the standard one" —
    leaves no way to ask for NO cache, and the first thing that goes
    wrong is a test: it passes `None` meaning "stay off my disk", gets
    the real cache under `quant/data`, and reads entries a live run left
    there. Every assertion about how many requests were made then reads
    zero, and the suite reports a network client working perfectly while
    never having made a call.
    """

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "USE_DEFAULT_CACHE"


USE_DEFAULT_CACHE = _UseDefaultCache()


class EdgarBulk:
    """A polite, cached reader for the free parts of SEC EDGAR.

    Takes its session, its sleep and its clock so the whole thing is
    testable without a network — the same shape as `keyedsleeves.py`, for
    the same reason: a suite that needed the real service would only ever
    run when SEC felt like answering, which is the same as not running.

    `cache=None` means NO cache and every call goes to the wire, which is
    fine for one lookup and rude for a sweep — so the default is
    `USE_DEFAULT_CACHE`, a sentinel rather than None precisely so that
    "stay off my disk" remains sayable. See `_UseDefaultCache`.
    """

    def __init__(
        self,
        *,
        contact_email: str = CONTACT_EMAIL,
        cache: ParquetCache | None | _UseDefaultCache = USE_DEFAULT_CACHE,
        raw_root: Path | str = DEFAULT_RAW_ROOT,
        session: requests.Session | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], datetime] | None = None,
        user_agent: str | None = None,
    ) -> None:
        email = str(contact_email).strip()
        if "@" not in email:
            raise ValueError(
                f"contact_email {contact_email!r} is not an address. SEC's "
                f"automated-access policy requires a declared identity with a "
                f"way to reach a human, and a request without one is refused "
                f"with a 403 that names throttling rather than the real "
                f"problem — which is how an afternoon disappears."
            )
        self._user_agent = user_agent or f"Griffin Fund Research ({email})"
        self._cache: ParquetCache | None = (
            default_cache() if isinstance(cache, _UseDefaultCache) else cache
        )
        self._raw_root = Path(raw_root)
        self._session = session or requests.Session()
        self._timeout = timeout
        self._sleep = sleep
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._last_request = float("-inf")

        #: Requests made, so a sweep can be audited for politeness after
        #: the fact rather than trusted to have been polite.
        self.requests_made = 0

    # -- transport ------------------------------------------------------

    @property
    def user_agent(self) -> str:
        return self._user_agent

    def _headers(self, accept: str) -> dict[str, str]:
        return {
            "User-Agent": self._user_agent,
            "Accept": accept,
            # Asked for explicitly: a quarterly form index is 51MB of text
            # and 5MB on the wire, and refusing the compression would be
            # ten times the bandwidth out of SEC's budget for no gain.
            "Accept-Encoding": "gzip, deflate",
        }

    def _pace(self) -> None:
        """Stay well under SEC's ten a second.

        `monotonic`, not the injected clock: that one exists so a test can
        freeze cache stamps, and a frozen clock must never become a
        decision about how fast we are allowed to talk to somebody else's
        server.
        """
        waited = time.monotonic() - self._last_request
        if 0.0 <= waited < MIN_REQUEST_INTERVAL_SECONDS:
            self._sleep(MIN_REQUEST_INTERVAL_SECONDS - waited)
        self._last_request = time.monotonic()

    def _request(
        self, url: str, *, accept: str = "application/json", timeout: float | None = None
    ) -> requests.Response:
        last = "no attempt was made"
        for attempt in range(MAX_ATTEMPTS):
            if attempt:
                self._sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
            else:
                self._pace()
            self.requests_made += 1
            try:
                response = self._session.get(
                    url,
                    headers=self._headers(accept),
                    timeout=timeout or self._timeout,
                )
            except requests.RequestException as exc:
                last = f"{type(exc).__name__}: {exc}"
                continue

            status = response.status_code
            # The body is only read when the status says something went
            # wrong. `response.text` decodes the WHOLE payload, and the
            # payloads here run to an 85MB zip — decoding one as UTF-8 to
            # slice two thousand characters off the front would be a
            # minute of CPU spent proving a success was a success.
            verdict = (
                "ok" if 200 <= status < 300 else _classify(status, _body_head(response))
            )
            if verdict == "ok":
                return response
            if verdict == "absent":
                raise EdgarNotFound(
                    f"EDGAR has no document at {url} (HTTP "
                    f"{response.status_code}). This is an answer, not an "
                    f"outage: the filing was never made, or the quarter has "
                    f"not been published. Retrying it cannot change it."
                )
            if verdict == "fatal":
                raise EdgarUnavailable(
                    f"EDGAR returned HTTP {response.status_code} for {url} — "
                    f"{_body_head(response)[:200]}"
                )
            last = f"HTTP {response.status_code}"

        raise EdgarUnavailable(
            f"EDGAR unreachable after {MAX_ATTEMPTS} attempts for {url}. "
            f"Last: {last}. SEC rate-limits at "
            f"{SEC_RATE_LIMIT_PER_SECOND:.0f} requests a second and answers a "
            f"burst with 403 or 429; back off and try later rather than "
            f"treating this as a filer with nothing on file."
        )

    def _json(self, url: str, *, timeout: float | None = None) -> Any:
        response = self._request(url, accept="application/json", timeout=timeout)
        try:
            return response.json()
        except ValueError as exc:
            raise EdgarUnavailable(
                f"EDGAR answered 200 at {url} with a body that is not JSON — "
                f"{_body_head(response)[:200]}"
            ) from exc

    def _text(self, url: str, *, timeout: float | None = None) -> str:
        return self._request(url, accept="text/plain", timeout=timeout).text

    def _bytes(self, url: str, *, timeout: float | None = None) -> bytes:
        return self._request(
            url, accept="application/octet-stream", timeout=timeout
        ).content

    def _cached(
        self, frame: str, params: Mapping[str, Any], loader: Callable[[], pd.DataFrame]
    ) -> pd.DataFrame:
        if self._cache is None:
            return loader()
        key = self._cache.key("sec-edgar", frame, **dict(params))
        now = self._clock()
        # A loader that raises leaves no entry, by doing nothing. That is
        # cache.py's rule and it is the reason a throttled minute here
        # cannot become a week of a company not existing.
        return self._cache.get_or_load(key, loader, stamped=now, now=now)

    # -- the ticker map -------------------------------------------------

    def company_tickers(self, *, with_exchange: bool = True) -> pd.DataFrame:
        """CIK for every ticker SEC currently associates with a filer.

        NOT a universe. See `COVERAGE["ticker_map"]`: every row is a
        living registrant, and a company that delisted last year is
        absent with nothing to record that it was ever here. This is a
        lookup from a symbol you already hold to the permanent id that
        answers for it, and used as anything else it reintroduces the
        exact bias this repository exists to measure.
        """
        if with_exchange:
            return self._cached(
                "ticker_map",
                {"variant": "exchange"},
                lambda: parse_company_tickers_exchange(self._json(TICKER_EXCHANGE_URL)),
            )
        return self._cached(
            "ticker_map",
            {"variant": "plain"},
            lambda: parse_company_tickers(self._json(TICKER_MAP_URL)),
        )

    def resolve_ticker(self, ticker: str) -> int:
        """The CIK for a live ticker, or a raise that says why there isn't one.

        The failure message matters more than the success: a ticker with
        no CIK here is usually a DEAD ticker, and the whole trap in this
        module is that a dead company looks exactly like a typo.
        """
        symbol = str(ticker).strip().upper()
        rows = self.company_tickers()
        hit = rows.loc[rows["ticker"] == symbol, "cik"]
        if hit.empty:
            raise EdgarNotFound(
                f"{symbol!r} is not in SEC's current ticker map. That is "
                f"USUALLY not a typo: the map holds only registrants with a "
                f"live ticker association, so a company that delisted, was "
                f"acquired or went private is absent from it and looks "
                f"identical to a symbol that never existed. If you are "
                f"chasing a dead name, come at it from the delisting record "
                f"(`delistings`) or from a CIK you already hold — a "
                f"submissions feed still answers for a filer that is gone."
            )
        return int(hit.iloc[0])

    # -- submissions ----------------------------------------------------

    def _submissions(self, cik: int) -> Mapping[str, Any]:
        payload = self._json(SUBMISSIONS_URL.format(cik=int(cik)))
        if not isinstance(payload, Mapping):
            raise EdgarUnavailable(
                f"CIK {cik}: submissions came back as "
                f"{type(payload).__name__}, not an object"
            )
        return payload

    def filer_profile(self, cik: int) -> pd.DataFrame:
        return self._cached(
            "filer_profile",
            {"cik": int(cik)},
            lambda: parse_filer_profile(self._submissions(cik)),
        )

    def former_names(self, cik: int) -> pd.DataFrame:
        """Names this CIK filed under before, and when it stopped.

        Empty is a real answer and the common one — General Dynamics has
        never changed its name, measured. It is not an outage and does not
        raise.
        """
        return self._cached(
            "former_names",
            {"cik": int(cik)},
            lambda: parse_former_names(self._submissions(cik)),
        )

    def filings(self, cik: int, *, full_history: bool = True) -> pd.DataFrame:
        """Every filing this CIK has made, oldest first.

        `full_history=False` stops at the thousand most recent, which is
        what the submissions feed carries inline. True follows the chunk
        files named in `filings.files` — one extra request per chunk, two
        for a filer as old as General Dynamics. Worth it: the inline
        thousand covers about six years for a prolific filer, and JPMorgan
        buries its 10-K roughly seven thousand rows deep behind note
        prospectuses. Any windowed lookup for an annual filing is a guess.
        """
        return self._cached(
            "filing_index",
            {"cik": int(cik), "full_history": bool(full_history)},
            lambda: self._build_filings(int(cik), full_history),
        )

    def _build_filings(self, cik: int, full_history: bool) -> pd.DataFrame:
        payload = self._submissions(cik)
        filings = payload.get("filings") or {}
        blocks: list[Mapping[str, Any]] = []
        recent = filings.get("recent")
        if isinstance(recent, Mapping):
            blocks.append(recent)
        if full_history:
            for meta in filings.get("files") or []:
                name = (meta or {}).get("name")
                if not name:
                    continue
                chunk = self._json(SUBMISSIONS_CHUNK_URL.format(name=name))
                if isinstance(chunk, Mapping):
                    blocks.append(chunk)
        return parse_filing_index(cik, *blocks)

    def latest_filing(self, cik: int, form: str) -> pd.Series | None:
        """The newest filing of one form type, scanning the WHOLE history.

        Never a recency window. JPMorgan files tens of thousands of
        interim documents between 10-Ks and its annual report sits about
        seven thousand rows down; a windowed lookup finds nothing and
        reports it as a company that files no accounts.
        """
        rows = self.filings(cik)
        hit = rows.loc[rows["form"].str.upper() == str(form).strip().upper()]
        if hit.empty:
            return None
        # Accession breaks the tie, so two filings accepted on one day
        # resolve the same way on every run. A non-deterministic pick
        # here would make an audit unreproducible in the one place that
        # is hardest to notice: the answer stays plausible.
        return hit.sort_values(["filed", "accession"]).iloc[-1]

    # -- companyfacts ---------------------------------------------------

    def company_facts(
        self,
        cik: int,
        *,
        concepts: Mapping[str, Sequence[str]] | str | None = None,
        refresh: bool = False,
    ) -> pd.DataFrame:
        """XBRL facts for one filer, with the fiscal year recovered.

        Read `extract_facts` before using `filing_fiscal_year` for
        anything. The payload is large — General Dynamics is ~3.4MB — so
        the concept filter is applied on the way into the frame and the
        default list is short. `concepts="all"` is available and means
        what it says.
        """
        params = {"cik": int(cik), "concepts": _concept_signature(concepts)}

        def load() -> pd.DataFrame:
            return extract_facts(
                self._json(COMPANYFACTS_URL.format(cik=int(cik))), concepts=concepts
            )

        if self._cache is None:
            return load()
        # `refresh` goes through get_or_load rather than around it, so a
        # forced refetch that fails leaves the OLD entry alone instead of
        # replacing a good frame with nothing. cache.py already declines
        # to store a failure; this is the other half of that promise.
        return self._cache.get_or_load(
            self._cache.key("sec-edgar", "company_facts", **params),
            load,
            stamped=self._clock(),
            now=self._clock(),
            refresh=refresh,
        )

    # -- the delisting record -------------------------------------------

    def form25_quarter(self, year: int, quarter: int) -> pd.DataFrame:
        """Every Form 25 and 25-NSE filed in one quarter.

        One request for a whole quarter of delistings — about 450 of
        them, measured on 2025Q2 — against one request per company any
        other way. The index is 5MB on the wire and 51MB decompressed, so
        this is cached hard: a closed quarter never changes and its entry
        never expires.
        """
        year, quarter = _check_quarter(year, quarter)
        frame = "form25_open" if self._quarter_is_open(year, quarter) else "form25"
        return self._cached(
            frame,
            {"year": year, "quarter": quarter},
            lambda: self._build_form25(year, quarter),
        )

    def _build_form25(self, year: int, quarter: int) -> pd.DataFrame:
        rows = parse_form_index(
            self._text(
                FULL_INDEX_URL.format(year=year, quarter=quarter),
                timeout=BULK_TIMEOUT,
            ),
            forms=FORM25_FORMS,
            year=year,
            quarter=quarter,
        )
        # Flagged here rather than in `delistings`, because the
        # counterparty statistic that identifies an exchange needs a whole
        # quarter to be visible and a caller's arbitrary date range is not
        # one. Doing it in the loader also means the cached frame carries
        # the answer instead of recomputing it on every read.
        return mark_exchange_filers(rows)

    def delistings(
        self, start: date, end: date, *, include_exchange_filers: bool = False
    ) -> pd.DataFrame:
        """The free survivorship-free delisting record, over a date range.

        This is the most valuable thing in the module and three sentences
        have to travel with it.

        These are delisting DATES, not delisting PRICES. It tells you
        which companies died and when; it cannot tell you what a holder
        received, and an acquisition at a premium and a wind-up at zero
        are indistinguishable here until somebody reads the filing.

        A Form 25 strikes a CLASS OF SECURITIES, not a company. Verizon
        is in 2025Q2 for a note; its common stock never stopped trading.
        Treat a row as "this company is gone" and the exits will be wrong
        in the direction that flatters a backtest.

        The exchange that struck the listing files too, so the raw index
        double-counts. Those rows are dropped here by default —
        `include_exchange_filers=True` keeps them, and `is_exchange_filer`
        marks them either way. See `mark_exchange_filers`.

        Coverage, measured rather than assumed: nothing before roughly
        2003, issuer-filed Form 25 only until 2006Q2, and the
        exchange-filed 25-NSE — the bulk of the record — from 2006Q2
        onward. A range that starts before that is not empty because
        nothing was delisted; it is empty because nobody was filing this
        electronically yet.
        """
        if start > end:
            raise ValueError(
                f"start {start.isoformat()} is after end {end.isoformat()}. An "
                f"empty frame here would report a reversed window as a period "
                f"in which nothing was delisted."
            )
        frames = [
            self.form25_quarter(year, quarter)
            for year, quarter in quarters_between(start, end)
        ]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return mark_exchange_filers(_empty_form25()).assign(
                initiator=pd.Series([], dtype="str")
            )
        out = pd.concat(frames, ignore_index=True)
        out = out.loc[out["filed"].between(pd.Timestamp(start), pd.Timestamp(end))]
        if not include_exchange_filers:
            out = out.loc[~out["is_exchange_filer"]]
        out = out.assign(initiator=[classify_delisting(f, None) for f in out["form"]])
        return out.sort_values(["filed", "cik", "form"]).reset_index(drop=True)

    def delisting_reason(self, cik: int, accession: str) -> dict[str, Any]:
        """Read one Form 25's rule box. One request per delisting.

        Priced deliberately in the docstring because the cost is the
        whole design constraint: a quarter holds ~450 of these, so
        enriching a year of delistings is 1,800 requests and the better
        part of an hour at a polite pace. Do it for the names you are
        actually trading, not for the index.
        """
        url = _submission_text_url(int(cik), str(accession))
        return {
            "cik": int(cik),
            "accession": str(accession),
            **parse_delisting_reason(self._text(url, timeout=BULK_TIMEOUT)),
        }

    def delisting_reasons(self, frame: pd.DataFrame, *, limit: int) -> pd.DataFrame:
        """Rule boxes for a bounded slice of a delisting frame.

        `limit` is required and has no default on purpose. Every other
        call in this file costs one request; this one costs one PER ROW,
        and a frame handed in here can easily hold two thousand. A
        keyword with no default is a speed bump exactly where the
        expensive mistake is.
        """
        if int(limit) <= 0:
            raise ValueError("limit must be positive")
        rows = []
        for _, row in frame.head(int(limit)).iterrows():
            detail = self.delisting_reason(int(row["cik"]), str(row["accession"]))
            rows.append(
                {
                    "cik": int(row["cik"]),
                    "accession": str(row["accession"]),
                    "name": str(row.get("name", "")),
                    "form": str(row.get("form", "")),
                    "filed": row.get("filed"),
                    "rule": detail["rule"] or "",
                    "meaning": detail["meaning"],
                    "confident": bool(detail["confident"]),
                    "initiator": classify_delisting(
                        str(row.get("form", "")), detail["rule"]
                    ),
                }
            )
        return pd.DataFrame(rows)

    # -- DERA -----------------------------------------------------------

    def dera_zip_path(self, year: int, quarter: int) -> Path:
        """The quarter's zip on disk, downloading it once if absent.

        Kept as a file rather than a frame because it is not one: four
        tab-separated members in an 85MB archive, and a caller who wants a
        second tag out of num.txt should not pay 85MB to get it. The
        parquet cache holds what comes OUT of this.
        """
        year, quarter = _check_quarter(year, quarter)
        _check_dera_quarter(year, quarter)
        self._raw_root.mkdir(parents=True, exist_ok=True)
        path = self._raw_root / f"dera-{year}q{quarter}.zip"
        if path.is_file() and path.stat().st_size > 0:
            return path
        data = self._bytes(
            DERA_URL.format(year=year, quarter=quarter), timeout=BULK_TIMEOUT
        )
        # Written to a temp name and renamed, so an interrupted download
        # leaves a miss rather than a truncated archive that unzips to
        # three of its four members.
        tmp = path.with_name(path.name + ".tmp")
        try:
            tmp.write_bytes(data)
            tmp.replace(path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        return path

    def _dera_member(self, year: int, quarter: int, member: str) -> bytes:
        path = self.dera_zip_path(year, quarter)
        with zipfile.ZipFile(path) as archive:
            names = {n.lower(): n for n in archive.namelist()}
            actual = names.get(member.lower())
            if actual is None:
                raise EdgarUnavailable(
                    f"{year}Q{quarter}: the DERA archive holds "
                    f"{sorted(names.values())} and not {member!r}. The dataset "
                    f"changed shape; do not read this as a quarter with no "
                    f"filings in it."
                )
            with archive.open(actual) as fh:
                return fh.read()

    def dera_submissions(self, year: int, quarter: int) -> pd.DataFrame:
        """sub.txt for a quarter: one row per filing, ~10k rows."""
        year, quarter = _check_quarter(year, quarter)
        return self._cached(
            "dera_submissions",
            {"year": year, "quarter": quarter},
            lambda: parse_dera_sub(self._dera_member(year, quarter, "sub.txt")),
        )

    def dera_numbers(
        self,
        year: int,
        quarter: int,
        *,
        tags: Iterable[str] | None = None,
    ) -> pd.DataFrame:
        """num.txt for a quarter, filtered to `tags`.

        `tags=None` keeps everything, which for a modern quarter is
        millions of rows and several gigabytes in memory. It is allowed
        because refusing it would be paternalistic, and it is not the
        default because the person who wants it knows they want it.
        """
        year, quarter = _check_quarter(year, quarter)
        wanted = None if tags is None else tuple(sorted({str(t) for t in tags}))
        return self._cached(
            "dera_numbers",
            {"year": year, "quarter": quarter, "tags": wanted},
            lambda: parse_dera_num(
                self._dera_member(year, quarter, "num.txt"), tags=wanted
            ),
        )

    # -- calendar -------------------------------------------------------

    def _quarter_is_open(self, year: int, quarter: int) -> bool:
        today = self._clock().date()
        return (year, quarter) >= (today.year, (today.month - 1) // 3 + 1)


# -- calendar helpers -----------------------------------------------------


def quarters_between(start: date, end: date) -> list[tuple[int, int]]:
    """Every (year, quarter) touching the range, inclusive at both ends."""
    out: list[tuple[int, int]] = []
    year, quarter = start.year, (start.month - 1) // 3 + 1
    last = (end.year, (end.month - 1) // 3 + 1)
    while (year, quarter) <= last:
        out.append((year, quarter))
        quarter += 1
        if quarter > 4:
            year, quarter = year + 1, 1
    return out


def _check_quarter(year: int, quarter: int) -> tuple[int, int]:
    year, quarter = int(year), int(quarter)
    if not 1 <= quarter <= 4:
        raise ValueError(f"quarter must be 1-4, got {quarter}")
    if year < 1993:
        raise ValueError(
            f"EDGAR's electronic archive starts in 1993, so {year} has no "
            f"index. Filings before it are on paper and are not free, or "
            f"online, or ours."
        )
    return year, quarter


def _check_dera_quarter(year: int, quarter: int) -> None:
    if (year, quarter) < DERA_FIRST_QUARTER:
        raise EdgarNotFound(
            f"the Financial Statement Data Sets begin at "
            f"{DERA_FIRST_QUARTER[0]}Q{DERA_FIRST_QUARTER[1]} — "
            f"{year}Q{quarter} was never published. (2009Q1 exists as a 13KB "
            f"stub and carries nothing.) This is a fact about XBRL's rollout, "
            f"not about how many companies filed: the dataset is built from "
            f"XBRL exhibits and there was almost no XBRL before 2009. "
            f"Available quarters are listed at {DERA_LANDING}."
        )


# -- small helpers --------------------------------------------------------


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(name)).lower()


def _stamp(raw: Any) -> pd.Timestamp | None:
    if raw in (None, ""):
        return None
    stamp = pd.to_datetime(raw, errors="coerce", utc=True)
    if pd.isna(stamp):
        return None
    return stamp.tz_localize(None).normalize()


def _stamps(series: Any) -> pd.Series:
    """A column of YYYYMMDD-or-ISO strings as datetimes, unparseables NaT."""
    if series is None:
        return pd.Series([], dtype="datetime64[ns]")
    return pd.to_datetime(series, errors="coerce", format="mixed").astype(
        "datetime64[ns]"
    )


def _int_or_none(raw: Any) -> int | None:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _body_head(response: Any) -> str:
    """The first slice of a response body, for classification and messages.

    Guarded because a body that will not decode is not a reason to lose
    the status code that came with it.
    """
    try:
        return (response.text or "")[:2000]
    except Exception:
        return ""


def _accession_from_path(path: str) -> str:
    """`edgar/data/1804591/0001193125-25-137043.txt` -> the accession."""
    stem = str(path).strip().rsplit("/", 1)[-1]
    return storable(stem[:-4] if stem.lower().endswith(".txt") else stem)


def _filing_index_url(cik: int, accession: str) -> str:
    return (
        f"{ARCHIVES}edgar/data/{int(cik)}/"
        f"{str(accession).replace('-', '')}/"
    )


def _submission_text_url(cik: int, accession: str) -> str:
    """The complete submission text file: SGML header plus every document.

    One request instead of an index lookup and then a document fetch. For
    a Form 25 the whole thing is about 12KB, so there is nothing to save
    by being cleverer.
    """
    return f"{ARCHIVES}edgar/data/{int(cik)}/{str(accession).strip()}.txt"


def _document_url(cik: int, accession: str, document: str) -> str:
    if not document:
        return _submission_text_url(cik, accession)
    return _filing_index_url(cik, accession) + storable(document)


_TAG = re.compile(r"<[^>]+>")
_NUMERIC_ENTITY = re.compile(r"&#(\d+);")
_HEX_ENTITY = re.compile(r"&#x([0-9a-fA-F]+);", re.I)


def _plain_text(document: str) -> str:
    """Markup out, then entities in. That order, and it is load-bearing.

    Decoding first turns an escaped `&lt;word&gt;` into live tags which
    the stripper then deletes along with the word inside them — the same
    trap `services/newsFeeds.js` documents on the RSS wires. Here it
    would silently eat the checkbox glyphs, which arrive as `&#9746;`
    and are the only thing this parse is looking for.
    """
    text = _TAG.sub(" ", str(document))
    text = _NUMERIC_ENTITY.sub(lambda m: _chr_safe(int(m.group(1))), text)
    text = _HEX_ENTITY.sub(lambda m: _chr_safe(int(m.group(1), 16)), text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#146;", "'")
    )
    return " ".join(storable(text).split())


def _chr_safe(code: int) -> str:
    try:
        return chr(code)
    except ValueError:
        return " "


#: How far back from a rule mention to look for its checkbox. The forms
#: put the glyph immediately before the rule text; forty characters is
#: room for a footnote marker and whitespace and not enough to reach the
#: PREVIOUS rule's box, which is what a wider window would find.
_BOX_WINDOW = 40


def _box_state(text: str, rule: str) -> bool | None:
    """True checked, False unchecked, None undeterminable. Never a guess."""
    needle = rule.replace("(", r"\(").replace(")", r"\)")
    for match in re.finditer(needle, text):
        window = text[max(0, match.start() - _BOX_WINDOW) : match.start()]
        for ch in reversed(window):
            if ch in _CHECKED:
                return True
            if ch in _UNCHECKED:
                return False
    return None


_FILE_NUMBER = re.compile(r"Commission\s+File\s+Number:?\s*([0-9A-Za-z\-]+)", re.I)


def _commission_file_number(text: str) -> str:
    m = _FILE_NUMBER.search(text)
    return storable(m.group(1)) if m else ""


def _concept_signature(
    concepts: Mapping[str, Sequence[str]] | str | None,
) -> str:
    """A stable cache-key spelling of a concept selection.

    A dict does not have a stable JSON form once it holds tuples, and
    cache.py hashes canonical JSON — so the selection is flattened to one
    sorted string here rather than left to serialise however it happens
    to. Two callers asking for the same concepts in a different order
    must hit the same entry or the cache silently refetches 3.4MB.
    """
    resolved = _resolve_concepts(concepts)
    if resolved is None:
        return "all"
    return ";".join(
        f"{tax}:{','.join(sorted(names))}" for tax, names in sorted(resolved.items())
    )


def _typed(df: pd.DataFrame, dtypes: Mapping[str, str]) -> pd.DataFrame:
    built = {
        column: _cast(df[column], dtype)
        for column, dtype in dtypes.items()
        if column in df.columns
    }
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out


def _cast(series: pd.Series, dtype: str) -> pd.Series:
    if dtype.startswith("datetime64"):
        return pd.to_datetime(series, errors="coerce").astype("datetime64[ns]")
    if dtype == "float64":
        return pd.to_numeric(series, errors="coerce").astype("float64")
    if dtype == "Int64":
        return pd.to_numeric(series, errors="coerce").astype("Int64")
    if dtype == "int64":
        return pd.to_numeric(series, errors="coerce").astype("int64")
    if dtype == "bool":
        return series.astype("bool")
    return series.astype("str")
