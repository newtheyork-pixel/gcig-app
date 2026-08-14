"""EDGAR exercised without a network, on payloads shaped like the real ones.

Nothing here touches SEC. `EdgarBulk` takes its session, its sleep and
its clock as constructor arguments precisely so that a suite depending on
somebody else's uptime — and on their rate limiter's mood — is not the
thing standing between a change and knowing whether it worked.

The fixtures are not invented. Every payload below was cut down from a
live response that was fetched once, politely, while the module was
being written: Mesa Labs' 2018 10-K facts, General Dynamics' submissions
feed, the 2025Q2 quarterly form index, 23andMe's Form 25, and the
2009Q2 Financial Statement Data Set. Where a number is asserted it is a
number SEC actually published.

What is on trial, and why each one produces a clean-looking result when
it goes wrong:

**The fiscal year is not in the payload.** companyfacts stamps every
fact with the FILING's `fy`, so a 10-K's three comparative years arrive
labelled identically and a groupby collapses them to the OLDEST — SEC
sorts the units array by `end` ascending. This shipped once and printed
General Dynamics' calendar-2023 income statement under FY2025. The test
asserts the recovered years AND asserts that the naive reading gives the
wrong answer, because a test that only checks the fix does not stop
somebody reinstating the bug in a helper.

**Two different failures both arrive as HTTP 403.** A missing object
answers with S3's XML; a throttled client gets SEC's HTML page. Retrying
the first is waste and retrying the second is the whole remedy, so the
classifier reads the body. The test pins the request COUNT, since a
correct exception raised after three needless round trips is the failure
this is meant to prevent.

**The delisting index double-counts.** EDGAR lists one row per filer and
a 25-NSE has two, so the New York Stock Exchange looks like the most
frequently delisted company in America. The test also pins the false
positive that the first cut produced — Harrah's, which filed several
Form 25s through an agent — because the fix for the double-count is what
created it.

**An empty answer and an outage are different.** A quarter with no Form
25 in it is ordinary and returns no rows; an index that parses to no
rows OF ANY FORM means the format moved and raises. A ticker missing
from the map is usually a DEAD company rather than a typo, and the
message has to say so or somebody goes looking for the typo.

**A guessed delisting reason is a fabricated one.** An acquisition at a
premium and a liquidation at zero are opposite returns. Where the rule
box cannot be read, `confident` is False and `rule` is None.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date, datetime, timezone
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.data import edgarbulk as eb
from griffinquant.data.cache import ParquetCache
from griffinquant.data.edgarbulk import (
    EdgarBulk,
    EdgarNotFound,
    EdgarUnavailable,
    classify_delisting,
    coverage_frame,
    extract_facts,
    mark_exchange_filers,
    parse_company_tickers,
    parse_company_tickers_exchange,
    parse_dera_num,
    parse_delisting_reason,
    parse_filer_profile,
    parse_filing_index,
    parse_form_index,
    parse_former_names,
    period_kind,
    quarters_between,
    storable,
)

CLOCK = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)


# -- the stand-in for requests -------------------------------------------


class _Response:
    def __init__(
        self,
        status: int = 200,
        payload: Any = None,
        text: str = "",
        content: bytes = b"",
    ) -> None:
        self.status_code = status
        self._payload = payload
        self.text = text if text else (json.dumps(payload) if payload is not None else "")
        self.content = content
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _Session:
    def __init__(self, handler: Callable[[str], _Response]) -> None:
        self._handler = handler
        self.urls: list[str] = []
        self.headers_seen: list[dict[str, str]] = []

    def get(
        self,
        url: str,
        headers: dict | None = None,
        timeout: float | None = None,
    ) -> _Response:
        self.urls.append(url)
        self.headers_seen.append(dict(headers or {}))
        return self._handler(url)


class _RefusingSession:
    def get(self, *args: Any, **kwargs: Any) -> _Response:
        raise AssertionError("no HTTP call should have been made")


def _client(handler: Callable[[str], _Response], **kw: Any) -> EdgarBulk:
    """A client with no cache unless the test asks for one.

    `cache=None` has to mean NO cache and not "the standard one", or
    every assertion below about how many requests were made reads
    entries that a live run left under `quant/data` — and the suite
    reports a network client working perfectly while never calling it.
    That is why `EdgarBulk` takes a sentinel rather than treating None as
    "use the default"; it was a real failure here before it was a
    comment there.
    """
    kw.setdefault("cache", None)
    return EdgarBulk(
        session=_Session(handler),
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
        **kw,
    )


# -- fixtures, cut down from live responses ------------------------------

#: Mesa Labs, accession 0001437749-18-011240 — the 10-K for the fiscal
#: year ended 31 March 2018. Fifteen Revenues facts, every one stamped
#: `fy: 2018`, with period ends running from June 2015 to March 2018.
#: Trimmed here to the three ANNUAL rows plus one quarterly, in SEC's own
#: order: ascending by `end`, which is what makes the naive reading pick
#: the oldest.
MLAB_FACTS: dict[str, Any] = {
    "cik": 724004,
    "entityName": "MESA LABORATORIES INC /CO",
    "facts": {
        "us-gaap": {
            "Revenues": {
                "label": "Revenues",
                "units": {
                    "USD": [
                        {
                            "start": "2015-04-01",
                            "end": "2016-03-31",
                            "val": 84659000,
                            "accn": "0001437749-18-011240",
                            "fy": 2018,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2018-06-05",
                            "frame": "CY2015",
                        },
                        {
                            "start": "2016-04-01",
                            "end": "2017-03-31",
                            "val": 93665000,
                            "accn": "0001437749-18-011240",
                            "fy": 2018,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2018-06-05",
                            "frame": "CY2016",
                        },
                        {
                            "start": "2017-04-01",
                            "end": "2018-03-31",
                            "val": 96179000,
                            "accn": "0001437749-18-011240",
                            "fy": 2018,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2018-06-05",
                            "frame": "CY2017",
                        },
                        {
                            "start": "2018-01-01",
                            "end": "2018-03-31",
                            "val": 26881000,
                            "accn": "0001437749-18-011240",
                            "fy": 2018,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2018-06-05",
                        },
                    ]
                },
            }
        }
    },
}

#: General Dynamics' submissions feed, trimmed. Reston, Virginia — worth
#: keeping in a fixture because the wider project once mined this out of
#: Item 1 with a regex and got St. Louis, from a sentence about a
#: customer's building.
GD_SUBMISSIONS: dict[str, Any] = {
    "cik": 40533,
    "name": "GENERAL DYNAMICS CORP",
    "entityType": "operating",
    "sic": "3730",
    "sicDescription": "Ship & Boat Building & Repairing",
    "tickers": ["GD"],
    "exchanges": ["NYSE"],
    "fiscalYearEnd": "1231",
    "stateOfIncorporation": "DE",
    "category": "Large accelerated filer",
    "ein": "131673581",
    "phone": "703-876-3000",
    "website": "",
    "formerNames": [],
    "addresses": {
        "business": {
            "city": "RESTON",
            "stateOrCountry": "VA",
            "countryCode": None,
        }
    },
    "filings": {
        "recent": {
            "accessionNumber": ["0000040533-26-000006", "0000040533-25-000011"],
            "filingDate": ["2026-01-30", "2025-04-23"],
            "reportDate": ["2025-12-31", "2025-03-30"],
            "form": ["10-K", "10-Q"],
            "primaryDocument": ["gd-20251231.htm", "gd-20250330.htm"],
            "primaryDocDescription": ["10-K", "10-Q"],
            "items": ["", ""],
            "isXBRL": [1, 1],
        },
        "files": [
            {
                "name": "CIK0000040533-submissions-001.json",
                "filingCount": 2,
                "filingFrom": "1994-03-29",
                "filingTo": "1994-05-13",
            }
        ],
    },
}

GD_OLDER_CHUNK: dict[str, Any] = {
    "accessionNumber": ["0000040533-94-000003"],
    "filingDate": ["1994-03-29"],
    "reportDate": ["1993-12-31"],
    "form": ["10-K"],
    "primaryDocument": [""],
    "primaryDocDescription": [""],
    "items": [""],
    "isXBRL": [0],
}

#: Real rows from the 2025Q2 quarterly index, including a Form 25 filed
#: through an agent and two 25-NSE accessions that each appear twice —
#: once under New York Stock Exchange LLC and once under the issuer.
FORM_INDEX = """Description:           Master Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    June 30, 2025
Comments:              webmaster@sec.gov

Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------
10-K             SOME OTHER FILER INC                                          1234567     2025-04-01  edgar/data/1234567/0001234567-25-000001.txt
25               23andMe Holding Co.                                           1804591     2025-06-06  edgar/data/1804591/0001193125-25-137043.txt
25-NSE           NEW YORK STOCK EXCHANGE LLC                                   876661      2025-04-01  edgar/data/876661/0000876661-25-000244.txt
25-NSE           DEUTSCHE BANK AKTIENGESELLSCHAFT                              1159508     2025-04-01  edgar/data/1159508/0000876661-25-000244.txt
25-NSE           NEW YORK STOCK EXCHANGE LLC                                   876661      2025-04-01  edgar/data/876661/0000876661-25-000246.txt
25-NSE           FIRST BANCSHARES INC /MS/                                     947559      2025-04-01  edgar/data/947559/0000876661-25-000246.txt
25-NSE           NEW YORK STOCK EXCHANGE LLC                                   876661      2025-04-02  edgar/data/876661/0000876661-25-000253.txt
25-NSE           Desktop Metal, Inc.                                           1754820     2025-04-02  edgar/data/1754820/0000876661-25-000253.txt
25-NSE           NEW YORK STOCK EXCHANGE LLC                                   876661      2025-04-03  edgar/data/876661/0000876661-25-000257.txt
25-NSE           NEVRO CORP                                                    1444380     2025-04-03  edgar/data/1444380/0000876661-25-000257.txt
"""

#: 23andMe's Form 25, as filed: the (c) box is checked, the rest empty,
#: and every glyph arrives as a numeric entity inside live markup.
FORM25_DOC = (
    "<html><body><p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p>"
    "<p>FORM 25 NOTIFICATION OF REMOVAL FROM LISTING</p>"
    "<p>Commission File Number: 001-39587</p>"
    "<p>23andMe Holding Co. &#150; Nasdaq Capital Market</p>"
    "<p>&#9744; 17 CFR 240.12d2-2(a)(1)</p>"
    "<p>&#9744; 17 CFR 240.12d2-2(a)(2)</p>"
    "<p>&#9744; 17 CFR 240.12d2-2(a)(3)</p>"
    "<p>&#9744; 17 CFR 240.12d2-2(a)(4)</p>"
    "<p>&#9744; Pursuant to 17 CFR 240.12d2-2(b), the Exchange has complied"
    " with its rules to strike the class of securities from listing.</p>"
    "<p>&#9746; Pursuant to 17 CFR 240.12d2-2(c), the Issuer has complied"
    " with the rules of the Exchange governing the voluntary withdrawal.</p>"
    "</body></html>"
)

SEC_THROTTLE_HTML = (
    "<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title>"
    "</head><body>Your Request Originates from an Undeclared Automated Tool"
    "</body></html>"
)

S3_ABSENT_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"
)

DERA_SUB = (
    "adsh\tcik\tname\tsic\tcountryba\tstprba\tcityba\tformer\tchanged\tafs\t"
    "wksi\tfye\tform\tperiod\tfy\tfp\tfiled\taccepted\tprevrpt\tdetail\t"
    "instance\tnciks\n"
    "0001031296-09-000011\t1031296\tFIRSTENERGY CORP\t4911\tUS\tOH\tAKRON\t\t\t"
    "1-LAF\t1\t1231\t10-Q\t20090331\t2009\tQ1\t20090507\t"
    "2009-05-07 17:17:00.0\t0\t0\tfe-20090331.xml\t8\n"
    "0001104659-09-029605\t796343\tADOBE SYSTEMS INC\t7372\tUS\tCA\tSAN JOSE\t\t\t"
    "2-LAF\t1\t1130\t10-Q\t20090531\t2009\tQ2\t20090619\t"
    "2009-06-19 16:31:00.0\t0\t1\tadbe-20090531.xml\t1\n"
)

DERA_NUM = (
    "adsh\ttag\tversion\tddate\tqtrs\tuom\tsegments\tcoreg\tvalue\tfootnote\n"
    "0001031296-09-000011\tAssets\tus-gaap/2008\t20090331\t0\tUSD\t\t\t"
    "13227000000.0000\t\n"
    "0001031296-09-000011\tRevenues\tus-gaap/2008\t20090331\t1\tUSD\t\t\t"
    "3300000000.0000\tsee note\x1f1\n"
    "0001104659-09-029605\tAssets\tus-gaap/2008\t20090531\t0\tUSD\t\t\t"
    "6063745000.0000\t\n"
    "0001104659-09-029605\tTreasuryStockSharesAcquired\tus-gaap/2008\t20080331\t"
    "1\tshares\tEquityComponents=CommonStock;\t\t104000.0000\t\n"
)


def _dera_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("sub.txt", DERA_SUB)
        archive.writestr("num.txt", DERA_NUM)
        archive.writestr("pre.txt", "adsh\ttag\n")
        archive.writestr("tag.txt", "tag\tversion\n")
    return buffer.getvalue()


# -- text hygiene --------------------------------------------------------


def test_storable_strips_the_bytes_parquet_refuses():
    """NUL and the C0 block go; tab, newline and return stay.

    One embedded 0x00 in extracted filing text has already failed an
    INSERT in this project and taken the whole batch with it, surfacing
    as a 500 that named no file. Tab and newline are the shape of a
    document and are kept.
    """
    assert storable("a\x00b") == "ab"
    assert storable("a\x1fb\x08c\x7fd") == "abcd"
    assert storable("keep\tthese\nand\rthose") == "keep\tthese\nand\rthose"
    # A lone surrogate is refused by parquet the same way a NUL is, and
    # is indistinguishable from one in the traceback.
    assert storable("a\ud800b") == "ab"
    assert storable(None) == ""


# -- the two flavours of 403 ---------------------------------------------


def test_classify_separates_a_missing_object_from_a_throttle():
    """Both are HTTP 403 and they mean opposite things.

    Measured against the live service: a form index for a quarter that
    has not happened answers 403 with S3's XML, and a request carrying a
    library's default User-Agent answers 403 with SEC's HTML page.
    """
    assert eb._classify(403, S3_ABSENT_XML) == "absent"
    assert eb._classify(403, SEC_THROTTLE_HTML) == "retry"
    assert eb._classify(404, "") == "absent"
    assert eb._classify(429, "") == "retry"
    assert eb._classify(503, "") == "retry"
    assert eb._classify(200, "") == "ok"
    assert eb._classify(400, "bad request") == "fatal"


def test_a_missing_object_is_not_retried():
    """The count is the assertion, not the exception type.

    A correct `EdgarNotFound` raised after three round trips and two
    backoffs is the failure this classifier exists to prevent: it is rude
    to SEC and it reports a quarter that has not happened yet as
    throttling, which is a precise error that is wrong.
    """
    client = _client(lambda url: _Response(403, text=S3_ABSENT_XML))
    with pytest.raises(EdgarNotFound):
        client.form25_quarter(2030, 1)
    assert client.requests_made == 1


def test_a_throttle_is_retried_and_then_named():
    client = _client(lambda url: _Response(403, text=SEC_THROTTLE_HTML))
    with pytest.raises(EdgarUnavailable) as excinfo:
        client.company_tickers()
    assert client.requests_made == eb.MAX_ATTEMPTS
    assert "rate-limit" in str(excinfo.value).lower()


def test_a_transient_failure_recovers():
    calls: list[int] = []

    def handler(url: str) -> _Response:
        calls.append(1)
        if len(calls) < 3:
            return _Response(503, text="upstream unavailable")
        return _Response(200, payload={"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}})

    client = _client(handler)
    rows = client.company_tickers(with_exchange=False)
    assert list(rows["ticker"]) == ["AAPL"]
    assert client.requests_made == 3


def test_every_request_declares_who_we_are():
    """SEC requires it, and refuses the request without it.

    Not a courtesy header. A request with no User-Agent, or with
    `python-requests/2.32`, is answered 403 with the throttle page —
    which names the wrong problem and costs an afternoon.
    """
    client = _client(lambda url: _Response(200, payload={"fields": ["cik", "name", "ticker", "exchange"], "data": []}))
    client.company_tickers()
    ua = client._session.headers_seen[0]["User-Agent"]
    assert "@" in ua and "griffin" in ua.lower()


def test_a_contact_address_is_required_to_construct_one():
    with pytest.raises(ValueError, match="not an address"):
        EdgarBulk(contact_email="griffin-fund", cache=None)


# -- the ticker map is not a universe ------------------------------------


def test_ticker_map_parses_and_says_nothing_about_the_dead():
    rows = parse_company_tickers(
        {
            "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
            "1": {"cik_str": 1045810, "ticker": "NVDA", "title": "NVIDIA CORP"},
        }
    )
    assert list(rows["ticker"]) == ["AAPL", "NVDA"]
    assert list(rows["cik"]) == [320193, 1045810]
    # No `is_delisted`. A column that is False on every row is a
    # tautology dressed as a finding.
    assert "is_delisted" not in rows.columns


def test_a_shape_change_at_sec_raises_rather_than_emptying_the_market():
    with pytest.raises(EdgarUnavailable):
        parse_company_tickers([])
    with pytest.raises(EdgarUnavailable):
        parse_company_tickers("<html>maintenance</html>")


def test_exchange_variant_refuses_a_positional_parse_against_a_moved_header():
    """Fields are looked up by name, never by index.

    A positional read against a reordered header puts exchanges in the
    name column and keeps every dtype, so nothing downstream notices.
    """
    good = parse_company_tickers_exchange(
        {
            "fields": ["cik", "name", "ticker", "exchange"],
            "data": [[1045810, "NVIDIA CORP", "NVDA", "Nasdaq"]],
        }
    )
    assert good.loc[0, "exchange"] == "Nasdaq"
    with pytest.raises(EdgarUnavailable, match="missing field"):
        parse_company_tickers_exchange(
            {"fields": ["cik", "name", "ticker"], "data": [[1, "X", "X"]]}
        )


def test_a_missing_ticker_is_explained_as_a_dead_company():
    """The message is the test.

    A symbol absent from the map is USUALLY a company that delisted, and
    it looks exactly like a typo. A message that does not say so sends
    somebody to check their spelling for an hour.
    """
    client = _client(
        lambda url: _Response(
            200, payload={"fields": ["cik", "name", "ticker", "exchange"], "data": []}
        )
    )
    with pytest.raises(EdgarNotFound) as excinfo:
        client.resolve_ticker("ENRNQ")
    message = str(excinfo.value).lower()
    assert "delisted" in message and "typo" in message


def test_coverage_states_the_ticker_map_is_survivorship_biased():
    """The claim is per DATASET, because the answer differs per dataset.

    All of this is EDGAR, all of it is served by the same host under the
    same terms, and "EDGAR is survivorship-free" is true of three of
    these and false of the one people reach for first.
    """
    assert eb.COVERAGE["ticker_map"].survivorship_free is False
    assert eb.COVERAGE["form25"].survivorship_free is True
    assert eb.COVERAGE["financial_statement_data_sets"].survivorship_free is True
    assert eb.COVERAGE["submissions"].survivorship_free is True

    frame = coverage_frame().set_index("dataset")
    # The caveat has to carry the sentence, not just the flag.
    assert "universe" in frame.loc["ticker_map", "caveat"].lower()
    assert "price" in frame.loc["form25", "caveat"].lower()
    # Every dataset states how we know, not just what we claim. base.py
    # already says what this project thinks of an unevidenced claim.
    assert all(len(c.survivorship_basis) > 40 for c in eb.COVERAGE.values())


# -- submissions ---------------------------------------------------------


def test_profile_reads_the_structured_fields():
    profile = parse_filer_profile(GD_SUBMISSIONS)
    row = profile.iloc[0]
    assert row["business_city"] == "RESTON"
    assert row["business_state"] == "VA"
    assert row["fiscal_year_end"] == "1231"
    assert row["sic"] == "3730"
    assert row["tickers"] == "GD"


def test_former_names_is_empty_without_being_an_outage():
    empty = parse_former_names(GD_SUBMISSIONS)
    assert empty.empty
    assert list(empty.columns) == ["cik", "former_name", "from_date", "to_date"]

    renamed = parse_former_names(
        {
            "cik": 1045810,
            "formerNames": [
                {
                    "name": "NVIDIA CORP/CA",
                    "from": "2000-05-12T00:00:00.000Z",
                    "to": "2003-04-10T00:00:00.000Z",
                }
            ],
        }
    )
    assert renamed.loc[0, "former_name"] == "NVIDIA CORP/CA"
    assert renamed.loc[0, "from_date"] == pd.Timestamp("2000-05-12")


def test_filings_follow_the_chunk_files_for_the_old_history():
    """The inline block is the most recent thousand and nothing more.

    JPMorgan buries its 10-K roughly seven thousand rows deep behind note
    prospectuses, so a lookup that stops at the inline block reports a
    bank that files no accounts.
    """

    def handler(url: str) -> _Response:
        if url.endswith("CIK0000040533.json"):
            return _Response(200, payload=GD_SUBMISSIONS)
        if "submissions-001" in url:
            return _Response(200, payload=GD_OLDER_CHUNK)
        raise AssertionError(url)

    client = _client(handler)
    rows = client.filings(40533)
    assert len(rows) == 3
    assert rows["filed"].iloc[0] == pd.Timestamp("1994-03-29")
    latest = client.latest_filing(40533, "10-K")
    assert latest["filed"] == pd.Timestamp("2026-01-30")
    assert latest["accession"] == "0000040533-26-000006"


def test_filings_stop_at_the_inline_block_when_asked():
    client = _client(lambda url: _Response(200, payload=GD_SUBMISSIONS))
    rows = client.filings(40533, full_history=False)
    assert len(rows) == 2
    assert client.requests_made == 1


def test_a_ragged_submissions_block_raises_rather_than_inventing_filings():
    """Parallel arrays are joined by POSITION.

    Truncating to the shortest would pair one filing's accession with
    another's date, which is not a short answer — it is a document
    nobody filed.
    """
    with pytest.raises(EdgarUnavailable, match="differing"):
        parse_filing_index(
            40533,
            {
                "accessionNumber": ["a", "b"],
                "filingDate": ["2020-01-01"],
                "form": ["10-K", "10-Q"],
            },
        )


# -- the fiscal year that is not in the payload --------------------------


def test_the_naive_reading_is_wrong_in_the_direction_that_was_shipped():
    """Keying on `fy` collapses three years and keeps the OLDEST.

    Asserted explicitly so this file also documents the bug. All three
    comparative years share an accession AND a filing date, so a sort on
    `(fy, filed)` cannot separate them; Python's sort is stable, SEC
    returns the array by `end` ASCENDING, and the winner is therefore
    whichever the tie leaves first — the OLDEST. That is how General
    Dynamics' calendar-2023 income statement was printed under the
    heading FY2025.
    """
    raw = MLAB_FACTS["facts"]["us-gaap"]["Revenues"]["units"]["USD"]
    annual = [f for f in raw if f["start"].endswith("-04-01")]
    assert {f["fy"] for f in annual} == {2018}
    assert {f["filed"] for f in annual} == {"2018-06-05"}

    ranked = sorted(annual, key=lambda f: (f["fy"], f["filed"]), reverse=True)
    # 84,659,000 is fiscal 2016 revenue, presented as fiscal 2018's.
    assert ranked[0]["val"] == 84659000
    assert ranked[0]["end"] == "2016-03-31"


def test_fiscal_year_is_recovered_from_position_within_an_accession():
    facts = extract_facts(MLAB_FACTS)
    annual = facts.loc[facts["period"] == "annual"].set_index("fiscal_year")
    assert sorted(annual.index) == [2016, 2017, 2018]
    assert annual.loc[2016, "value"] == 84659000
    assert annual.loc[2017, "value"] == 93665000
    assert annual.loc[2018, "value"] == 96179000
    # The raw stamp is kept beside it, so the trap is inspectable without
    # refetching 3.4MB to prove it exists.
    assert set(annual["filing_fiscal_year"]) == {2018}


def test_a_quarter_inside_a_ten_k_is_not_ranked_against_the_years():
    """Grouping is by accession AND period shape.

    A 10-K carries twelve quarterly ends beside three annual ones.
    Ranking them together would put the oldest quarter eleven years
    before the filing.
    """
    facts = extract_facts(MLAB_FACTS)
    quarter = facts.loc[facts["period"] == "quarterly"]
    assert len(quarter) == 1
    # The only quarterly row in the accession, so it is the anchor.
    assert int(quarter["fiscal_year"].iloc[0]) == 2018
    assert int(quarter["period_days"].iloc[0]) == 90


def test_a_fifty_three_week_year_ending_in_january_is_not_next_year():
    """JNJ's fiscal 2020 ended 3 January 2021.

    Calendar arithmetic on the end date would call it 2021. Walmart's
    fiscal 2026 ended 31 January 2026 and calendar arithmetic would call
    that 2026 — correctly, by accident. The same month means opposite
    things, so only the filer's own anchor plus position is safe.
    """
    payload = {
        "cik": 200406,
        "entityName": "JOHNSON & JOHNSON",
        "facts": {
            "us-gaap": {
                "Revenues": {
                    "units": {
                        "USD": [
                            {
                                "start": "2018-12-31",
                                "end": "2019-12-29",
                                "val": 82059000000,
                                "accn": "A",
                                "fy": 2020,
                                "fp": "FY",
                                "form": "10-K",
                                "filed": "2021-02-22",
                            },
                            {
                                "start": "2019-12-30",
                                "end": "2021-01-03",
                                "val": 82584000000,
                                "accn": "A",
                                "fy": 2020,
                                "fp": "FY",
                                "form": "10-K",
                                "filed": "2021-02-22",
                            },
                        ]
                    }
                }
            }
        },
    }
    facts = extract_facts(payload).set_index("fiscal_year")
    assert facts.loc[2020, "period_end"] == pd.Timestamp("2021-01-03")
    assert int(facts.loc[2020, "period_days"]) == 371
    assert facts.loc[2019, "period_end"] == pd.Timestamp("2019-12-29")


def test_the_prior_year_balance_sheet_in_a_ten_q_keeps_its_own_year():
    """And the disagreement is flagged rather than hidden.

    A Q1 10-Q carries the current quarter-end balance sheet and the prior
    FISCAL YEAR-END one. Ninety days apart, so a distance reading rounds
    them into the same year; position keeps them apart and is right.
    `fy_conflict` says the two readings differ, which is the honest
    output for a row whose year cannot be settled from the payload alone.
    """
    payload = {
        "cik": 40533,
        "entityName": "GENERAL DYNAMICS CORP",
        "facts": {
            "us-gaap": {
                "Assets": {
                    "units": {
                        "USD": [
                            {
                                "end": "2009-12-31",
                                "val": 31077000000,
                                "accn": "Q",
                                "fy": 2010,
                                "fp": "Q1",
                                "form": "10-Q",
                                "filed": "2010-04-28",
                            },
                            {
                                "end": "2010-03-31",
                                "val": 31000000000,
                                "accn": "Q",
                                "fy": 2010,
                                "fp": "Q1",
                                "form": "10-Q",
                                "filed": "2010-04-28",
                            },
                        ]
                    }
                }
            }
        },
    }
    facts = extract_facts(payload).set_index("period_end")
    assert int(facts.loc[pd.Timestamp("2009-12-31"), "fiscal_year"]) == 2009
    assert int(facts.loc[pd.Timestamp("2010-03-31"), "fiscal_year"]) == 2010
    assert bool(facts.loc[pd.Timestamp("2009-12-31"), "fy_conflict"])


def test_the_default_concept_list_is_short_and_all_means_all():
    payload = {
        "cik": 1,
        "entityName": "X",
        "facts": {
            "us-gaap": {
                "Assets": {
                    "units": {
                        "USD": [
                            {
                                "end": "2020-12-31",
                                "val": 1.0,
                                "accn": "A",
                                "fy": 2020,
                                "fp": "FY",
                                "form": "10-K",
                                "filed": "2021-02-01",
                            }
                        ]
                    }
                },
                "SomeObscureDisclosure": {
                    "units": {
                        "USD": [
                            {
                                "end": "2020-12-31",
                                "val": 2.0,
                                "accn": "A",
                                "fy": 2020,
                                "fp": "FY",
                                "form": "10-K",
                                "filed": "2021-02-01",
                            }
                        ]
                    }
                },
            }
        },
    }
    assert set(extract_facts(payload)["concept"]) == {"Assets"}
    assert set(extract_facts(payload, concepts="all")["concept"]) == {
        "Assets",
        "SomeObscureDisclosure",
    }
    with pytest.raises(ValueError, match="literal 'all'"):
        extract_facts(payload, concepts="Assets")


def test_an_empty_concept_selection_is_an_answer_not_an_outage():
    payload = {
        "cik": 1,
        "entityName": "X",
        "facts": {"us-gaap": {"NothingWeAskedFor": {"units": {"USD": []}}}},
    }
    frame = extract_facts(payload)
    assert frame.empty
    assert "fiscal_year" in frame.columns
    with pytest.raises(EdgarUnavailable):
        extract_facts({"cik": 1})


def test_period_bands():
    assert period_kind(None, "2018-03-31") == ("instant", None)
    assert period_kind("2017-04-01", "2018-03-31") == ("annual", 365)
    assert period_kind("2018-01-01", "2018-03-31") == ("quarterly", 90)
    assert period_kind("2018-01-01", "2018-06-30")[0] == "semiannual"
    # A four-month stub after a fiscal-year change. Kept as 'other'
    # rather than dropped: a hole here reads as a company that stopped
    # reporting, which is a much more interesting claim than the truth.
    assert period_kind("2018-01-01", "2018-04-30")[0] == "other"


# -- the delisting record ------------------------------------------------


def test_form_index_parses_the_padding_it_actually_has():
    rows = parse_form_index(FORM_INDEX, year=2025, quarter=2)
    assert set(rows["form"]) == {"25", "25-NSE"}
    assert "10-K" not in set(rows["form"])
    twenty_three = rows.loc[rows["cik"] == 1804591].iloc[0]
    assert twenty_three["accession"] == "0001193125-25-137043"
    assert twenty_three["filed"] == pd.Timestamp("2025-06-06")
    assert twenty_three["filing_txt_url"].startswith("https://www.sec.gov/Archives/")


def test_an_index_with_no_rows_at_all_is_an_outage_not_a_quiet_quarter():
    """A quarter with no Form 25 is ordinary; a quarter with no FILINGS
    is not.

    Measured: 1996Q1, 1999Q1 and 2001Q1 each carry zero Form 25s and tens
    of thousands of other filings. So an empty Form 25 result is right
    and an empty parse is a format change wearing its clothes.
    """
    quiet = FORM_INDEX.replace("25-NSE", "8-K").replace("\n25  ", "\n8-K")
    quiet = "\n".join(
        line for line in quiet.splitlines() if not line.startswith("25 ")
    )
    assert parse_form_index(quiet).empty

    with pytest.raises(EdgarUnavailable, match="zero rows"):
        parse_form_index("<html><body>Service temporarily unavailable</body></html>")


def test_the_exchange_is_not_a_delisted_company():
    """EDGAR lists one row per FILER and a 25-NSE has two.

    Counted naively the New York Stock Exchange delisted sixty-eight
    times in 2025Q2 and Nasdaq a hundred and twelve, which puts the
    venues at the top of any decedent list built from row counts.
    """
    rows = mark_exchange_filers(parse_form_index(FORM_INDEX, year=2025, quarter=2))
    nyse = rows.loc[rows["cik"] == 876661]
    assert len(nyse) == 4
    assert bool(nyse["is_exchange_filer"].all())

    issuers = rows.loc[~rows["is_exchange_filer"]]
    assert set(issuers["cik"]) == {1804591, 1159508, 947559, 1754820, 1444380}


def test_a_serial_issuer_filing_through_an_agent_is_not_an_exchange():
    """The false positive the counterparty rule alone produced.

    Harrah's Entertainment filed Form 25s for several note classes in
    2008Q1, each with a different subsidiary co-filer, so it reached
    three distinct counterparties and beat every one of them. It files
    through an agent, so its accession prefix is not its own CIK — which
    is the second test, and the one that saves it. Over-flagging deletes
    a company's death from the record whose whole purpose is to hold it.
    """
    text = (
        "Form Type   Company Name          CIK         Date Filed  File Name\n"
        "-----------------------------------------------------------------\n"
    )
    # The agent's CIK leads every accession; Harrah's is 858339.
    for i, sub_cik in enumerate((111111, 222222, 333333), start=1):
        accession = f"0001193125-08-00000{i}"
        path = f"edgar/data/{{}}/{accession}.txt"
        text += (
            f"25               HARRAHS ENTERTAINMENT INC     858339      "
            f"2008-01-0{i}  {path.format(858339)}\n"
        )
        text += (
            f"25               SUBSIDIARY {i} INC              {sub_cik}      "
            f"2008-01-0{i}  {path.format(sub_cik)}\n"
        )
    rows = mark_exchange_filers(parse_form_index(text, year=2008, quarter=1))
    assert not rows["is_exchange_filer"].any()


def test_a_lone_co_filer_pair_is_left_alone():
    """An issuer and its financing vehicle, with no exchange between them."""
    text = (
        "Form Type   Company Name          CIK         Date Filed  File Name\n"
        "-----------------------------------------------------------------\n"
        "25               MORGAN STANLEY                895421      2006-04-03  "
        "edgar/data/895421/0000895421-06-000001.txt\n"
        "25               STRUCTURED PRODUCTS CORP      894356      2006-04-03  "
        "edgar/data/894356/0000895421-06-000001.txt\n"
    )
    rows = mark_exchange_filers(parse_form_index(text, year=2006, quarter=2))
    assert not rows["is_exchange_filer"].any()


def test_delistings_drops_the_exchange_rows_and_refuses_a_reversed_window():
    client = _client(lambda url: _Response(200, text=FORM_INDEX))
    rows = client.delistings(date(2025, 4, 1), date(2025, 6, 30))
    assert 876661 not in set(rows["cik"])
    assert set(rows["initiator"]) == {"exchange", "issuer"}
    # The plain Form 25 is the issuer's; the 25-NSE is the exchange's,
    # and the FORM says so without a document fetch.
    assert rows.loc[rows["cik"] == 1804591, "initiator"].iloc[0] == "issuer"
    assert rows.loc[rows["cik"] == 1444380, "initiator"].iloc[0] == "exchange"

    kept = client.delistings(
        date(2025, 4, 1), date(2025, 6, 30), include_exchange_filers=True
    )
    assert 876661 in set(kept["cik"])

    with pytest.raises(ValueError, match="after end"):
        client.delistings(date(2025, 6, 30), date(2025, 4, 1))


def test_a_range_before_electronic_form_25_is_empty_and_typed():
    """Empty because nobody filed one, not because nobody delisted.

    Measured: 1996Q1 carries zero. The record only becomes dense with
    25-NSE in 2006Q2, and a caller reading an empty frame as an era of
    no delistings would be reading our coverage as a market fact.
    """
    header = (
        "Form Type   Company Name          CIK         Date Filed  File Name\n"
        "-----------------------------------------------------------------\n"
        "10-K             SOME FILER INC                1234567     1996-01-15  "
        "edgar/data/1234567/0001234567-96-000001.txt\n"
    )
    client = _client(lambda url: _Response(200, text=header))
    rows = client.delistings(date(1996, 1, 1), date(1996, 3, 31))
    assert rows.empty
    assert "is_exchange_filer" in rows.columns and "initiator" in rows.columns


# -- the reason, which is never guessed ----------------------------------


def test_the_checked_rule_is_read_out_of_the_markup():
    detail = parse_delisting_reason(FORM25_DOC)
    assert detail["rule"] == "12d2-2(c)"
    assert detail["confident"] is True
    assert detail["meaning"] == "issuer voluntarily withdrew the listing"
    assert detail["commission_file_number"] == "001-39587"
    assert "12d2-2(b)" in detail["unchecked"]


def test_markup_is_stripped_before_entities_are_decoded():
    """The other order eats the thing we came for.

    Decoding first turns an escaped `&lt;p&gt;` into a live tag that the
    stripper then deletes along with its contents — the same trap the RSS
    parser on the server side documents. Here it would consume the
    checkbox glyphs, which arrive as `&#9746;` and are the only signal
    this parse reads.
    """
    document = "<p>&lt;important&gt; &#9746; 17 CFR 240.12d2-2(c)</p>"
    text = eb._plain_text(document)
    assert "important" in text
    assert "☒" in text


def test_an_unreadable_rule_box_is_not_a_guess():
    """Some filers use an image, or a typed capital X, or nothing.

    An acquisition at a premium and a liquidation at zero are opposite
    returns. Where the box cannot be read, the answer is None.
    """
    imaged = (
        "<p>[IMAGE] 17 CFR 240.12d2-2(b) the Exchange has complied</p>"
        "<p>[IMAGE] 17 CFR 240.12d2-2(c) the Issuer has complied</p>"
    )
    detail = parse_delisting_reason(imaged)
    assert detail["rule"] is None
    assert detail["confident"] is False
    assert detail["checked"] == ()


def test_two_checked_boxes_is_not_a_decision_to_pick_from():
    both = (
        "<p>&#9746; 17 CFR 240.12d2-2(b)</p><p>&#9746; 17 CFR 240.12d2-2(c)</p>"
    )
    detail = parse_delisting_reason(both)
    assert detail["rule"] is None
    assert detail["confident"] is False
    assert set(detail["checked"]) == {"12d2-2(b)", "12d2-2(c)"}


def test_who_ended_the_listing():
    assert classify_delisting("25-NSE", None) == "exchange"
    assert classify_delisting("25-NSE/A", None) == "exchange"
    assert classify_delisting("25", "12d2-2(b)") == "exchange"
    assert classify_delisting("25", "12d2-2(c)") == "issuer"
    assert classify_delisting("25", None) == "issuer"
    assert classify_delisting("8-K", None) == "unknown"


def test_a_batch_of_reasons_will_not_run_without_a_stated_limit():
    """One request per ROW, and a quarter holds four hundred and fifty.

    A keyword with no default is a speed bump exactly where the
    expensive mistake is.
    """

    def handler(url: str) -> _Response:
        if "full-index" in url:
            return _Response(200, text=FORM_INDEX)
        return _Response(200, text=FORM25_DOC)

    client = _client(handler)
    rows = client.delistings(date(2025, 4, 1), date(2025, 6, 30))
    with pytest.raises(TypeError):
        client.delisting_reasons(rows)  # type: ignore[call-arg]
    with pytest.raises(ValueError):
        client.delisting_reasons(rows, limit=0)

    out = client.delisting_reasons(rows, limit=2)
    assert len(out) == 2
    assert client.requests_made == 3  # one index, two documents
    assert set(out["rule"]) == {"12d2-2(c)"}


# -- DERA ----------------------------------------------------------------


def test_dera_starts_at_2009q2_and_says_why():
    client = _client(_RefusingSession().get)
    with pytest.raises(EdgarNotFound, match="2009Q2"):
        client.dera_submissions(2008, 4)


def test_dera_submissions_and_numbers_parse(tmp_path):
    client = _client(
        lambda url: _Response(200, content=_dera_zip()), raw_root=tmp_path
    )
    subs = client.dera_submissions(2009, 2)
    assert list(subs["cik"]) == [1031296, 796343]
    assert subs.loc[0, "filed"] == pd.Timestamp("2009-05-07")
    # A filer's street address is deliberately not carried.
    assert "bas1" not in subs.columns

    numbers = client.dera_numbers(2009, 2, tags=("Assets",))
    assert len(numbers) == 2
    assert set(numbers["tag"]) == {"Assets"}
    assert numbers.loc[0, "value"] == pytest.approx(13227000000.0)
    # The zip is fetched once and reused for the second read.
    assert client.requests_made == 1


def test_dera_carries_the_period_on_every_row_so_the_fy_trap_cannot_arise():
    """`ddate` plus `qtrs` is the whole argument for preferring DERA.

    companyfacts stamps the FILING's fiscal year onto facts from three
    different years. num.txt states each row's own period end and its
    duration in quarters — 0 instant, 1 quarter, 4 annual — so there is
    nothing to collapse.
    """
    numbers = parse_dera_num(DERA_NUM.encode("utf-8"))
    assets = numbers.loc[numbers["tag"] == "Assets"]
    assert list(assets["qtrs"]) == [0, 0]
    assert assets["ddate"].iloc[0] == pd.Timestamp("2009-03-31")
    revenue = numbers.loc[numbers["tag"] == "Revenues"]
    assert int(revenue["qtrs"].iloc[0]) == 1


def test_dera_strips_the_bytes_that_break_the_write():
    """One control byte in a footnote is enough to fail the whole write.

    The footnote is free prose, it is the largest column in the file, and
    nothing downstream computes on it — so it is not in the default
    column set at all. Asked for explicitly it comes through `storable`,
    which is where the C0 block goes.

    Note what the CSV reader does and does not handle: a literal NUL is
    eaten by pandas before we ever see the field, and the rest of the C0
    block arrives intact. So a parser that leaned on read_csv to keep
    this safe would be relying on a behaviour that covers one byte of the
    thirty-one that break a parquet write.
    """
    with_notes = parse_dera_num(DERA_NUM.encode("utf-8"), keep_footnote=True)
    note = with_notes.loc[with_notes["tag"] == "Revenues", "footnote"].iloc[0]
    assert "\x1f" not in note
    assert note == "see note1"
    assert "footnote" not in parse_dera_num(DERA_NUM.encode("utf-8")).columns


def test_num_is_read_in_chunks_so_the_whole_file_is_never_held():
    """A modern quarter's num.txt is hundreds of megabytes uncompressed."""
    rows = parse_dera_num(DERA_NUM.encode("utf-8"), tags=("Assets",), chunk_rows=1)
    assert len(rows) == 2


def test_a_column_sec_stops_publishing_does_not_crash_the_parser():
    """Typed only where the column arrived.

    Reaching for `ddate` unconditionally would turn a schema change at
    SEC into a KeyError raised from inside a parser, which reads as our
    bug and sends somebody into the wrong file.
    """
    trimmed = b"adsh\ttag\tversion\tuom\tvalue\n0001-25-1\tAssets\tus-gaap/2008\tUSD\t5.0\n"
    rows = parse_dera_num(trimmed)
    assert rows.loc[0, "value"] == 5.0
    assert "ddate" not in rows.columns


def test_a_dera_archive_that_changed_shape_is_an_outage(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("readme.htm", "moved")
    client = _client(
        lambda url: _Response(200, content=buffer.getvalue()), raw_root=tmp_path
    )
    with pytest.raises(EdgarUnavailable, match="changed shape"):
        client.dera_submissions(2009, 2)


# -- the cache -----------------------------------------------------------


def test_a_warm_cache_needs_no_network(tmp_path):
    cache = ParquetCache(tmp_path, ttl_days=eb.EDGAR_TTL_DAYS)
    warm = _client(lambda url: _Response(200, text=FORM_INDEX), cache=cache)
    first = warm.form25_quarter(2025, 2)
    assert warm.requests_made == 1

    cold = EdgarBulk(
        cache=cache,
        session=_RefusingSession(),
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
    )
    again = cold.form25_quarter(2025, 2)
    pd.testing.assert_frame_equal(first, again)


def test_a_closed_quarter_never_expires_and_the_open_one_does(tmp_path):
    """The frame name carries the TTL, deliberately visibly.

    A quarter that closed in 2015 is final and refetching 5MB of it on a
    timer is rude for nothing. The quarter containing today grows every
    session, and an immortal entry there would freeze the delisting
    record on the day it was first read.
    """
    cache = ParquetCache(tmp_path, ttl_days=eb.EDGAR_TTL_DAYS)
    client = _client(lambda url: _Response(200, text=FORM_INDEX), cache=cache)
    client.form25_quarter(2015, 1)
    client.form25_quarter(2026, 3)  # CLOCK is August 2026

    frames = {
        json.loads(path.read_text())["frame"] for path in tmp_path.rglob("*.json")
    }
    assert frames == {"form25", "form25_open"}
    assert eb.EDGAR_TTL_DAYS["form25"] is None
    assert eb.EDGAR_TTL_DAYS["form25_open"] == 1.0


def test_an_outage_leaves_no_entry_behind(tmp_path):
    """cache.py's rule, checked from this side of it.

    A failure stored under a success's TTL turns one throttled minute
    into a week in which a company did not exist.
    """
    cache = ParquetCache(tmp_path, ttl_days=eb.EDGAR_TTL_DAYS)
    client = _client(lambda url: _Response(503, text="down"), cache=cache)
    with pytest.raises(EdgarUnavailable):
        client.form25_quarter(2015, 1)
    assert list(tmp_path.rglob("*.parquet")) == []


def test_the_concept_selection_hashes_the_same_whatever_order_it_is_written(tmp_path):
    """Otherwise the same pull refetches 3.4MB under a second key."""
    a = eb._concept_signature({"us-gaap": ["Assets", "Revenues"], "dei": ["X"]})
    b = eb._concept_signature({"dei": ["X"], "us-gaap": ["Revenues", "Assets"]})
    assert a == b
    assert eb._concept_signature("all") == "all"


def test_company_facts_refresh_replaces_the_entry_without_a_second_read(tmp_path):
    cache = ParquetCache(tmp_path, ttl_days=eb.EDGAR_TTL_DAYS)
    client = _client(lambda url: _Response(200, payload=MLAB_FACTS), cache=cache)
    first = client.company_facts(724004)
    assert client.requests_made == 1
    client.company_facts(724004)
    assert client.requests_made == 1  # served warm
    forced = client.company_facts(724004, refresh=True)
    assert client.requests_made == 2
    pd.testing.assert_frame_equal(first, forced)


# -- calendar ------------------------------------------------------------


def test_quarters_between_is_inclusive_at_both_ends():
    assert quarters_between(date(2024, 11, 1), date(2025, 5, 2)) == [
        (2024, 4),
        (2025, 1),
        (2025, 2),
    ]
    assert quarters_between(date(2025, 1, 1), date(2025, 1, 1)) == [(2025, 1)]


def test_a_quarter_before_edgar_is_refused_with_the_reason():
    client = _client(_RefusingSession().get)
    with pytest.raises(ValueError, match="1993"):
        client.form25_quarter(1988, 1)
    with pytest.raises(ValueError, match="quarter must be"):
        client.form25_quarter(2020, 5)
