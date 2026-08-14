"""The vendor adapter, exercised without a vendor.

Nothing in this file touches the network. `SharadarSource` takes its
`requests.Session` and its `sleep` as constructor arguments precisely so
a test can stand in for both, and a suite that needed a key would only
ever run on the one machine that has one — which is the same as not
running.

Five vendor facts are on trial here, and each of them has already cost
somebody a dataset.

Prices come from two products, not one. SEP is common stock and
excludes ETFs, CEFs and ETNs; SFP is where those live, and Nasdaq sells
it separately. Every sleeve this project trades is an ETF and so is the
SPY benchmark, so the tests below care about three things in that
order: that both tables are read, that a security priced by both is an
error rather than a duplicate, and — most of all — that a key which
bought only the equities bundle is told it bought only the equities
bundle. The last one is a message test, deliberately, because the
failure it guards against is not a wrong number. It is a right number
that never arrives, dressed up as a market with no ETFs in it.

Pagination is not an optimisation. The API answers at most ten thousand
rows whatever you ask for and says nothing about the truncation, so an
adapter that reads one page returns a shortened decade that validates
cleanly.

A 429 is a fact about the afternoon and a 404 is a fact about the
request. Retrying the second burns the rate limit that produced the
first, and — worse — a retried 404 eventually reads as an outage rather
than as a table code we got wrong.

A missing key is not an empty result. They look identical one layer
down and mean opposite things, so the adapter raises rather than
returning a frame with no rows in it.

And a ticker that resolves to two permatickers cannot be attributed
from the string. Those rows are dropped, which is a real loss, and the
count is kept on the instance — because a drop nobody can count is a
drop nobody will find.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.data import schema
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.sharadar import (
    MAX_ATTEMPTS,
    SharadarApiError,
    SharadarNotEntitled,
    SharadarSource,
)


# -- the stand-in for requests -------------------------------------------


class _Response:
    def __init__(self, status: int, payload: Any = None, text: str = "") -> None:
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _Session:
    """A requests.Session with the network taken out.

    `handler` sees the table name and the query and decides what came
    back, which is enough to model pagination, throttling and every
    error branch without any of them being mocked at the method level —
    the adapter still builds its own URL and reads its own body.
    """

    def __init__(self, handler: Callable[[str, dict[str, str], int], _Response]):
        self._handler = handler
        self.calls: list[tuple[str, dict[str, str]]] = []

    def get(self, url: str, params: dict[str, str] | None = None, timeout=None):
        table = url.rsplit("/", 1)[-1].removesuffix(".json")
        query = dict(params or {})
        self.calls.append((table, query))
        return self._handler(table, query, len(self.calls) - 1)

    def tables_called(self) -> list[str]:
        return [t for t, _ in self.calls]

    def query(self, table: str) -> dict[str, str]:
        """The first query sent to one table.

        Positional indexing would do it, except the ticker map is built
        lazily inside the join, so a SEP pull ends with a TICKERS call
        and `calls[-1]` is never the one under test.
        """
        for name, query in self.calls:
            if name.upper() == table.upper():
                return query
        raise AssertionError(f"SHARADAR/{table} was never called")


def datatable(columns: list[str], rows: list[list[Any]], cursor: str | None = None):
    return _Response(
        200,
        {
            "datatable": {
                "columns": [{"name": c} for c in columns],
                "data": rows,
            },
            "meta": {"next_cursor_id": cursor},
        },
    )


def vendor_error(status: int, code: str, message: str = "no") -> _Response:
    return _Response(status, {"quandl_error": {"code": code, "message": message}})


# -- the fixture panel ---------------------------------------------------

TICKERS_COLUMNS = [
    "table",
    "permaticker",
    "ticker",
    "name",
    "exchange",
    "category",
    "isdelisted",
    "firstpricedate",
    "lastpricedate",
    "sector",
    "currency",
]

#: Four entities and three symbols. DUP is worn by two companies, which
#: is the case the whole permaticker scheme exists for.
TICKERS_ROWS = [
    ["SEP", 100_001, "AAA", "Alpha Inc.", "NYSE", "Domestic Common Stock",
     "N", "2005-01-03", "2020-12-31", "Industrials", "USD"],
    ["SEP", 100_002, "ZZZ", "Zeta Corp.", "NASDAQ", "Domestic Common Stock",
     "Y", "2005-01-03", "2009-06-01", "Financials", "USD"],
    ["SEP", 100_003, "DUP", "Dupe Holdings (old)", "NYSE", "Domestic Common Stock",
     "Y", "2005-01-03", "2008-11-10", "Retail", "USD"],
    ["SEP", 100_004, "DUP", "Dupe Chemicals (new)", "NYSE", "Domestic Common Stock",
     "N", "2015-07-01", "2020-12-31", "Materials", "USD"],
]

#: The other half of the panel, and the half that is a separate
#: purchase. Nothing in the four rows above is an ETF, because SEP
#: contains none — which is why every SEP-only test in this file still
#: passes on a source configured for both tables.
SFP_TICKERS_ROWS = [
    ["SFP", 200_001, "SPY", "SPDR S&P 500 ETF Trust", "NYSEARCA", "ETF",
     "N", "2005-01-03", "2020-12-31", "", "USD"],
    ["SFP", 200_002, "IEF", "iShares 7-10 Year Treasury Bond ETF", "NASDAQ", "ETF",
     "N", "2005-01-03", "2020-12-31", "", "USD"],
]

BOTH_TABLES_ROWS = TICKERS_ROWS + SFP_TICKERS_ROWS

SEP_COLUMNS = [
    "ticker", "date", "open", "high", "low", "close", "volume",
    "closeadj", "closeunadj", "dividends", "lastupdated",
]

#: SFP publishes the same bar. Its documentation page lists the same
#: filter columns, uses the same column example and reprints SEP's
#: adjustment definitions word for word, so one row builder serves
#: both — and `_require` is still called per table, so the day that
#: stops being true the error will name SFP.
SFP_COLUMNS = SEP_COLUMNS


def sep_row(ticker: str, day: str, *, close: float, unadj: float) -> list[Any]:
    """One bar, split-adjusted the way SEP publishes it.

    `close` carries the split adjustment and `closeunadj` carries none,
    so their ratio is the factor the adapter divides back out to recover
    an as-traded open, high and low.
    """
    return [
        ticker, day,
        close * 0.99, close * 1.01, close * 0.98, close, 1_000.0,
        close * 1.05, unadj, 0.0, "2024-01-01",
    ]


def serve(**tables: Callable[[dict[str, str], int], _Response] | _Response):
    """Route by table name, and refuse anything the test did not plan for."""

    def handler(table: str, query: dict[str, str], attempt: int) -> _Response:
        entry = tables.get(table.lower())
        if entry is None:
            raise AssertionError(f"unexpected call to SHARADAR/{table}")
        return entry(query, attempt) if callable(entry) else entry

    return handler


def source(handler, **kwargs) -> tuple[SharadarSource, _Session, list[float]]:
    session = _Session(handler)
    slept: list[float] = []
    src = SharadarSource(
        api_key="test-key",
        session=session,
        sleep=slept.append,
        **kwargs,
    )
    return src, session, slept


# -- configuration -------------------------------------------------------


@pytest.mark.parametrize("var", ["NASDAQ_DATA_LINK_API_KEY", "QUANDL_API_KEY"])
def test_either_environment_variable_configures_the_source(monkeypatch, var):
    monkeypatch.delenv("NASDAQ_DATA_LINK_API_KEY", raising=False)
    monkeypatch.delenv("QUANDL_API_KEY", raising=False)
    monkeypatch.setenv(var, "from-the-environment")
    assert SharadarSource(session=_Session(serve()))._api_key == "from-the-environment"


def test_a_missing_key_raises_rather_than_returning_an_empty_frame(monkeypatch):
    monkeypatch.delenv("NASDAQ_DATA_LINK_API_KEY", raising=False)
    monkeypatch.delenv("QUANDL_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable) as exc:
        SharadarSource(session=_Session(serve()))
    assert "NASDAQ_DATA_LINK_API_KEY" in str(exc.value)
    assert "NOT an empty result" in str(exc.value)


def test_a_blank_key_counts_as_absent(monkeypatch):
    monkeypatch.setenv("NASDAQ_DATA_LINK_API_KEY", "   ")
    monkeypatch.delenv("QUANDL_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        SharadarSource(session=_Session(serve()))


def test_the_key_never_appears_in_a_cache_key():
    # The cache directory is the artefact a reviewer is handed. A key in
    # a filename is a credential in a git repository.
    from griffinquant.data.sharadar import _cache_key

    with_key = _cache_key("SEP", {"date.gte": "2005-01-01", "api_key": "secret"})
    without = _cache_key("SEP", {"date.gte": "2005-01-01"})
    assert with_key == without
    assert "secret" not in with_key


# -- pagination ----------------------------------------------------------


def test_the_cursor_is_walked_to_the_end_and_the_pages_are_concatenated():
    pages = [
        datatable(TICKERS_COLUMNS, TICKERS_ROWS[:2], cursor="page-2"),
        datatable(TICKERS_COLUMNS, TICKERS_ROWS[2:], cursor=None),
    ]
    src, session, _ = source(serve(tickers=lambda q, i: pages[i]))

    master = src.security_master()

    assert len(master) == 4
    assert sorted(master["permaticker"]) == [100_001, 100_002, 100_003, 100_004]
    assert "qopts.cursor_id" not in session.calls[0][1]
    assert session.calls[1][1]["qopts.cursor_id"] == "page-2"


def test_a_cursor_that_never_closes_is_stopped_rather_than_followed_forever():
    forever = datatable(TICKERS_COLUMNS, TICKERS_ROWS[:1], cursor="same-again")
    src, session, _ = source(serve(tickers=forever), max_pages=4)

    with pytest.raises(SharadarApiError) as exc:
        src.security_master()

    assert "refusing to keep going" in str(exc.value)
    assert len(session.calls) == 4


def test_an_empty_datatable_is_an_answer_and_validates(monkeypatch):
    src, _, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, [])))
    master = src.security_master()
    assert len(master) == 0
    schema.SECURITY_MASTER.validate(master)


# -- retry policy --------------------------------------------------------


def test_a_429_is_retried_and_then_succeeds():
    def tickers(query, attempt):
        if attempt == 0:
            return vendor_error(429, "QELx01", "too many requests")
        return datatable(TICKERS_COLUMNS, TICKERS_ROWS)

    src, session, slept = source(serve(tickers=tickers))
    assert len(src.security_master()) == 4
    assert len(session.calls) == 2
    assert slept == [0.5]


def test_a_5xx_is_retried_and_a_persistent_one_reports_an_outage():
    src, session, slept = source(serve(tickers=vendor_error(503, "QESx01")))
    with pytest.raises(SourceUnavailable) as exc:
        src.security_master()
    assert len(session.calls) == MAX_ATTEMPTS
    # Backoff is deterministic — one process, one key, sequential calls,
    # so jitter would buy nothing and cost a reproducible transcript.
    assert slept == [0.5, 1.0, 2.0, 4.0]
    assert "do not read this as an empty range" in str(exc.value)


def test_a_404_is_an_answer_and_is_not_retried():
    src, session, slept = source(serve(tickers=vendor_error(404, "QECx02", "no table")))
    with pytest.raises(SharadarApiError) as exc:
        src.security_master()
    assert len(session.calls) == 1
    assert slept == []
    assert "does not exist" in str(exc.value)


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_is_an_outage_not_a_bug_and_is_not_retried(status: int):
    src, session, _ = source(serve(tickers=vendor_error(status, "QEPx01")))
    with pytest.raises(SourceUnavailable) as exc:
        src.security_master()
    assert len(session.calls) == 1
    assert "not an empty result" in str(exc.value)


def test_an_unrecognised_key_code_is_reported_as_a_missing_key():
    # A QEA* code arrives with a 400, which would otherwise read as a
    # malformed request rather than as nobody being logged in.
    src, _, _ = source(serve(tickers=vendor_error(400, "QEAx01", "not recognised")))
    with pytest.raises(SourceUnavailable) as exc:
        src.security_master()
    assert "an unrecognised key returns nothing" in str(exc.value)


def test_a_rejected_filter_is_a_bug_here_rather_than_an_outage():
    src, session, _ = source(serve(tickers=vendor_error(400, "QESx03", "bad filter")))
    with pytest.raises(SharadarApiError):
        src.security_master()
    assert len(session.calls) == 1


def test_a_transport_error_is_retried_and_named():
    import requests

    def tickers(query, attempt):
        if attempt < 2:
            raise requests.ConnectionError("connection reset")
        return datatable(TICKERS_COLUMNS, TICKERS_ROWS)

    src, session, _ = source(serve(tickers=tickers))
    assert len(src.security_master()) == 4
    assert len(session.calls) == 3


# -- column mapping ------------------------------------------------------


def test_tickers_columns_map_onto_the_security_master_schema():
    src, _, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS)))
    master = src.security_master()

    schema.SECURITY_MASTER.validate(master)
    row = master.loc[master["permaticker"] == 100_002].iloc[0]
    assert row["ticker"] == "ZZZ"
    assert row["name"] == "Zeta Corp."
    assert row["is_delisted"] is True or bool(row["is_delisted"]) is True
    assert row["first_price_date"] == pd.Timestamp("2005-01-03")
    assert row["last_price_date"] == pd.Timestamp("2009-06-01")
    # Optional vendor columns ride along; absent ones stay absent rather
    # than arriving as a column of nulls.
    assert row["sector"] == "Financials"
    assert "delisted_from" not in master.columns


def test_only_y_means_delisted():
    rows = [list(r) for r in TICKERS_ROWS]
    rows[0][6] = ""
    rows[1][6] = "y"
    src, _, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, rows)))
    flags = src.security_master().set_index("permaticker")["is_delisted"]
    assert not bool(flags[100_001])
    assert bool(flags[100_002])


def test_a_vanished_vendor_column_is_refused_rather_than_filled_with_nulls():
    # Filling it produces a frame that passes every dtype check and says
    # nothing true, which is the exact shape of the failures this
    # repository exists to catch.
    columns = [c for c in TICKERS_COLUMNS if c != "lastpricedate"]
    rows = [[v for c, v in zip(TICKERS_COLUMNS, r) if c != "lastpricedate"]
            for r in TICKERS_ROWS]
    src, _, _ = source(serve(tickers=datatable(columns, rows)))
    with pytest.raises(SharadarApiError) as exc:
        src.security_master()
    assert "lastpricedate" in str(exc.value)


def test_sep_columns_map_onto_the_prices_schema_and_recover_the_as_traded_bar():
    # A name that split two-for-one: the vendor's `close` carries the
    # adjustment and `closeunadj` carries none, so the factor is a half
    # and the as-traded open is twice the published one.
    sep = datatable(
        SEP_COLUMNS,
        [
            sep_row("AAA", "2008-06-02", close=50.0, unadj=100.0),
            sep_row("AAA", "2008-06-03", close=52.0, unadj=104.0),
        ],
    )
    src, session, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sep=sep)
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    schema.PRICES.validate(prices)
    assert list(prices["permaticker"]) == [100_001, 100_001]
    first = prices.iloc[0]
    assert first["close_unadj"] == pytest.approx(100.0)
    assert first["close_adj"] == pytest.approx(52.5)
    assert first["split_factor"] == pytest.approx(0.5)
    assert first["open_unadj"] == pytest.approx(50.0 * 0.99 / 0.5)
    assert first["high_unadj"] == pytest.approx(50.0 * 1.01 / 0.5)
    # Volume moves the other way: as-traded share counts are smaller
    # before a forward split, not larger.
    assert first["volume_unadj"] == pytest.approx(500.0)
    # The range we asked the API for is re-applied after the join.
    assert session.query("SEP")["date.gte"] == "2008-01-01"


def test_a_bar_with_no_usable_unadjusted_close_is_left_undefined_and_counted():
    # Assuming no split ever happened is the assumption that passes a $5
    # floor with a $2 stock.
    sep = datatable(
        SEP_COLUMNS,
        [
            sep_row("AAA", "2008-06-02", close=50.0, unadj=100.0),
            sep_row("AAA", "2008-06-03", close=52.0, unadj=0.0),
        ],
    )
    src, _, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sep=sep)
    )
    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))
    assert pd.isna(prices.iloc[1]["open_unadj"])
    assert src.unadjustable_rows == 1


def test_sf1_maps_the_filing_date_onto_date_public():
    columns = ["ticker", "dimension", "calendardate", "datekey", "reportperiod",
               "revenue", "netinc"]
    sf1 = datatable(
        columns,
        [["AAA", "ARQ", "2008-06-30", "2008-08-08", "2008-06-28", 1000.0, 90.0]],
    )
    src, session, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sf1=sf1)
    )

    fundamentals = src.fundamentals(date(2008, 1, 1), date(2008, 12, 31))

    schema.FUNDAMENTALS.validate(fundamentals)
    row = fundamentals.iloc[0]
    assert row["date_public"] == pd.Timestamp("2008-08-08")
    assert row["period_end"] == pd.Timestamp("2008-06-30")
    assert row["report_period"] == pd.Timestamp("2008-06-28")
    # Bounding the period end rather than the filing date is the whole
    # lookahead bug in one filter, so the range goes on datekey.
    assert session.query("SF1")["datekey.gte"] == "2008-01-01"
    assert "calendardate.gte" not in session.query("SF1")


def test_an_unknown_dimension_is_refused_before_a_request_is_made():
    src, session, _ = source(serve())
    with pytest.raises(ValueError) as exc:
        src.fundamentals(date(2008, 1, 1), date(2008, 12, 31), dimension="ARQQ")
    assert "unknown SF1 dimension" in str(exc.value)
    assert session.calls == []


def test_actions_carry_no_reason_column_because_the_vocabulary_is_unread():
    actions = datatable(
        ["date", "action", "ticker", "name", "value", "contraticker"],
        [["2008-11-10", "delisted", "DUP", "Dupe Holdings (old)", None, ""]],
    )
    src, _, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), actions=actions)
    )
    frame = src.actions(date(2008, 1, 1), date(2008, 12, 31))
    schema.ACTIONS.validate(frame)
    assert "reason" not in frame.columns
    assert src.capabilities.provides_delisting_reasons is False


# -- unresolvable rows ---------------------------------------------------


def test_rows_whose_ticker_cannot_be_attributed_are_dropped_and_counted():
    sep = datatable(
        SEP_COLUMNS,
        [
            sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0),
            # DUP is worn by two entities: the string cannot say which.
            sep_row("DUP", "2008-06-02", close=10.0, unadj=10.0),
            # QQQ is in no master row at all.
            sep_row("QQQ", "2008-06-02", close=20.0, unadj=20.0),
        ],
    )
    src, _, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sep=sep)
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    assert list(prices["ticker"]) == ["AAA"]
    assert src.unresolved_rows == 2
    assert src.unresolved_by_frame == {"prices": 2}
    assert src.ambiguous_tickers == frozenset({"DUP"})


def test_the_drop_count_accumulates_across_frames():
    sep = datatable(SEP_COLUMNS, [sep_row("DUP", "2008-06-02", close=1.0, unadj=1.0)])
    actions = datatable(
        ["date", "action", "ticker"], [["2008-06-02", "split", "DUP"]]
    )
    src, _, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS),
            sep=sep,
            actions=actions,
        )
    )

    src.prices(date(2008, 1, 1), date(2008, 12, 31))
    src.actions(date(2008, 1, 1), date(2008, 12, 31))

    assert src.unresolved_rows == 2
    assert src.unresolved_by_frame == {"prices": 1, "actions": 1}


def test_two_filings_on_one_day_collapse_to_the_newest_and_are_counted():
    # A delinquent filer catches up by publishing several quarters at
    # once, which is not corruption — but the schema keys on the day, so
    # the survivor has to be the one a reader knew that evening.
    columns = ["ticker", "dimension", "calendardate", "datekey"]
    sf1 = datatable(
        columns,
        [
            ["AAA", "ARQ", "2008-03-31", "2008-11-14"],
            ["AAA", "ARQ", "2008-06-30", "2008-11-14"],
        ],
    )
    src, _, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sf1=sf1)
    )

    fundamentals = src.fundamentals(date(2008, 1, 1), date(2008, 12, 31))

    assert len(fundamentals) == 1
    assert fundamentals.iloc[0]["period_end"] == pd.Timestamp("2008-06-30")
    assert src.collapsed_rows == {"fundamentals": 1}


def test_an_explicit_empty_selection_asks_for_nothing_not_everything():
    # Getting this backwards pulls the entire panel and looks like a
    # slow network rather than a bug.
    src, session, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS)))
    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31), permatickers=[])
    assert len(prices) == 0
    assert session.tables_called() == ["TICKERS"]


def test_a_selection_is_re_applied_after_the_join():
    # The API is narrowed by ticker string because that is the only key
    # SEP accepts, and one string can carry rows the caller never asked
    # for.
    sep = datatable(
        SEP_COLUMNS,
        [
            sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0),
            sep_row("ZZZ", "2008-06-02", close=10.0, unadj=10.0),
        ],
    )
    src, session, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS), sep=sep)
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31), permatickers=[100_001])

    assert list(prices["permaticker"]) == [100_001]
    assert session.query("SEP")["ticker"] == "AAA"


# -- two price tables ----------------------------------------------------


def test_the_master_spans_both_price_tables_by_default():
    # A default of SEP alone cannot return a single ETF bar, and every
    # sleeve in this project is an ETF.
    src, _, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS)))

    master = src.security_master()

    assert sorted(master["permaticker"]) == [
        100_001, 100_002, 100_003, 100_004, 200_001, 200_002,
    ]
    assert src.serves_fund_prices is True
    assert "cannot price ETF sleeves" not in src.capabilities.name


@pytest.mark.parametrize(
    "tables, expected",
    [
        (("SEP",), [100_001, 100_002, 100_003, 100_004]),
        (("SFP",), [200_001, 200_002]),
    ],
)
def test_narrowing_the_tables_narrows_the_master(tables, expected):
    # The master is filtered to the tables bars will actually be pulled
    # from, so an entity appearing in it is a promise we can price it.
    # A master listing ETFs `prices()` will never ask for reads
    # downstream as a coverage hole rather than as a decision made here.
    src, _, _ = source(
        serve(tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS)), tables=tables
    )
    assert sorted(src.security_master()["permaticker"]) == expected


def test_a_source_that_cannot_price_a_fund_says_so_in_its_own_name():
    # There is no capability flag for this and inventing one would mean
    # amending the contract every source signs, so it goes in the one
    # string every report prints.
    src, _, _ = source(serve(), tables=("SEP",))

    assert src.serves_fund_prices is False
    assert "SEP only" in src.capabilities.name
    assert "cannot price ETF sleeves" in src.capabilities.name
    assert "cannot price ETF sleeves" in src.label


def test_prices_reads_both_tables_and_the_fund_bars_come_back():
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=datatable(
                SFP_COLUMNS, [sep_row("SPY", "2008-06-02", close=130.0, unadj=130.0)]
            ),
        )
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    schema.PRICES.validate(prices)
    assert session.tables_called() == ["TICKERS", "SEP", "SFP"]
    assert list(prices["ticker"]) == ["AAA", "SPY"]
    fund = prices.loc[prices["ticker"] == "SPY"].iloc[0]
    assert fund["permaticker"] == 200_001
    assert fund["close_unadj"] == pytest.approx(130.0)
    assert fund["close_adj"] == pytest.approx(136.5)
    # The column tagging each bar with the table it came from is
    # plumbing, not a fact about the security. Nothing above the
    # adapter should ever be able to read it.
    named = set(schema.PRICES.required) | set(schema.PRICES.optional)
    assert set(prices.columns) <= named


def test_each_table_is_asked_only_for_the_tickers_that_live_in_it():
    # Asking SEP for three thousand ETF symbols is not wrong so much as
    # expensive: sixty paginated round trips against a rate limit, spent
    # being told what TICKERS had already said.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=datatable(
                SFP_COLUMNS, [sep_row("SPY", "2008-06-02", close=130.0, unadj=130.0)]
            ),
        )
    )

    prices = src.prices(
        date(2008, 1, 1), date(2008, 12, 31), permatickers=[100_001, 200_001]
    )

    assert session.query("SEP")["ticker"] == "AAA"
    assert session.query("SFP")["ticker"] == "SPY"
    assert list(prices["ticker"]) == ["AAA", "SPY"]


def test_an_optional_column_only_one_table_publishes_is_withheld_and_recorded():
    # Concatenation fills the gap with nulls, and a null in `dividends`
    # is indistinguishable from a fund that paid nothing. Saying "we do
    # not have this" once is better than saying "zero" a million times.
    without = [c for c in SFP_COLUMNS if c != "dividends"]
    fund = [
        v
        for c, v in zip(SFP_COLUMNS, sep_row("SPY", "2008-06-02", close=130.0, unadj=130.0))
        if c != "dividends"
    ]
    src, _, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=datatable(without, [fund]),
        )
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    assert "dividends" not in prices.columns
    assert src.partial_columns == {"dividends": ("SEP",)}
    # A column BOTH tables published survives; the withholding is per
    # column, not a blanket retreat to the intersection of the schemas.
    assert "last_updated" in prices.columns


def test_one_entity_priced_by_both_tables_is_named_rather_than_collapsed():
    # A security belongs to exactly one price table, and that is the
    # only reason SEP and SFP can be stacked without checking for
    # collisions row by row. Left to the schema this surfaces four
    # lines later as a duplicate (permaticker, date) that says nothing
    # about which two rows, or why, or that two products had both
    # priced one security.
    fund = sep_row("SPY", "2008-06-02", close=130.0, unadj=130.0)
    src, _, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS,
                [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0), fund],
            ),
            sfp=datatable(SFP_COLUMNS, [fund]),
        )
    )

    with pytest.raises(SharadarApiError) as exc:
        src.prices(date(2008, 1, 1), date(2008, 12, 31))

    message = str(exc.value)
    assert "1 entity(ies)" in message
    assert "permaticker 200001" in message
    assert "['SEP', 'SFP']" in message
    assert "vendor contradiction and not a duplicate to be collapsed" in message


def test_the_same_symbol_in_both_tables_is_not_the_same_security():
    # A dead company's ticker reissued to an ETF puts one string in both
    # tables legitimately. The permaticker is what says whether it is
    # one security, and the ambiguous-symbol drop already handles the
    # string — so this must not trip the contradiction check.
    reissued = list(SFP_TICKERS_ROWS[0])
    reissued[2] = "ZZZ"
    src, _, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS + [reissued]),
            sep=datatable(
                SEP_COLUMNS, [sep_row("ZZZ", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=datatable(
                SFP_COLUMNS, [sep_row("ZZZ", "2008-06-03", close=130.0, unadj=130.0)]
            ),
        )
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    # Two entities wore ZZZ, so neither bar can be attributed from the
    # string. Both are dropped and both are counted — which is a very
    # different outcome from being merged into one series.
    assert len(prices) == 0
    assert src.unresolved_rows == 2
    assert src.ambiguous_tickers == frozenset({"DUP", "ZZZ"})


def test_a_refusal_on_the_fund_table_names_the_product_it_is_missing():
    # This is the test that protects the person who bought the wrong
    # bundle. The generic wording is a 403 on a table nobody has heard
    # of, which reads as our bug or as a vendor with no ETFs in it, and
    # costs somebody a day of reading the adapter before they think to
    # check what was purchased.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=vendor_error(403, "QEPx05", "You do not have permission"),
        )
    )

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2008, 1, 1), date(2008, 12, 31))

    message = str(exc.value)
    # Which table was refused, and the corroboration that the key is not
    # the problem.
    assert "SHARADAR/SFP refused the key (HTTP 403)" in message
    assert "SHARADAR/SEP answered normally in the same call" in message
    assert "this is a product you have not bought" in message
    # The product, by name, and what its absence costs.
    assert "sold as its own Nasdaq Data Link product" in message
    assert "Core US Equities bundle" in message
    assert "SPY benchmark price out of SFP and nowhere else" in message
    assert 'pass tables=("SEP",)' in message
    # And the sentence the whole two-table split exists to get right.
    assert "this is NOT 'there is no ETF data'" in message
    # A refusal is an answer. Retrying it burns the rate limit and turns
    # a subscription gap into a reported outage.
    assert session.tables_called() == ["TICKERS", "SEP", "SFP"]
    # The receipt is a rewording, never a replacement: the vendor's own
    # refusal is still underneath it, table and status intact.
    assert isinstance(exc.value.__cause__, SharadarNotEntitled)
    assert exc.value.__cause__.table == "SFP"
    assert exc.value.__cause__.status == 403


def test_a_table_we_never_asked_cannot_corroborate_a_refusal():
    # Requesting a single ETF is the ordinary case here — it is what
    # every Layer 1 sleeve does — and it is exactly the case where none
    # of the wanted entities live in SEP, so SEP is never called at all.
    # Citing its success there cites a call that did not happen, and it
    # would talk somebody out of checking a key that is genuinely dead.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sfp=vendor_error(403, "QEPx05", "You do not have permission"),
        )
    )

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2008, 1, 1), date(2008, 12, 31), permatickers=[200_001])

    message = str(exc.value)
    assert session.tables_called() == ["TICKERS", "SFP"]
    assert "answered normally in the same call" not in message
    assert "No other price table was read first, so check the key as well" in message


def test_a_refusal_on_the_stock_table_is_not_dressed_up_as_a_fund_product():
    # SEP is in the bundle everybody has. A 403 there is a credentials
    # problem, and telling that person to go and buy SFP sends them to
    # spend money on the wrong thing.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=vendor_error(401, "QEPx01", "invalid key"),
        )
    )

    with pytest.raises(SharadarNotEntitled) as exc:
        src.prices(date(2008, 1, 1), date(2008, 12, 31))

    message = str(exc.value)
    assert "SHARADAR/SEP" in message
    assert "not an empty result" in message
    assert "bought" not in message
    # The loop stops on the first table it cannot read: there is nothing
    # to learn from asking the second, and a second 403 would be a
    # second misleading sentence.
    assert session.tables_called() == ["TICKERS", "SEP"]


def test_a_404_on_the_fund_table_is_a_bug_here_and_not_an_unbought_product():
    # A table code we got wrong and a product we did not buy are both
    # 4xx and mean opposite things: one is fixed in this file, the other
    # on an invoice.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
            sfp=vendor_error(404, "QECx02", "no table"),
        )
    )

    with pytest.raises(SharadarApiError) as exc:
        src.prices(date(2008, 1, 1), date(2008, 12, 31))

    assert "SHARADAR/SFP does not exist (404)" in str(exc.value)
    assert "bought" not in str(exc.value)
    assert session.tables_called().count("SFP") == 1


def test_the_fund_table_is_paginated_and_throttled_exactly_as_the_stock_one_is():
    # SFP is a second product, not a second code path — the cursor and
    # the retry policy are the adapter's, not the table's.
    pages = [
        datatable(
            SFP_COLUMNS,
            [sep_row("SPY", "2008-06-02", close=130.0, unadj=130.0)],
            cursor="page-2",
        ),
        vendor_error(429, "QELx01", "too many requests"),
        datatable(
            SFP_COLUMNS, [sep_row("IEF", "2008-06-03", close=82.0, unadj=82.0)]
        ),
    ]
    seen: list[dict[str, str]] = []

    def sfp(query, attempt):
        seen.append(query)
        return pages[len(seen) - 1]

    src, _, slept = source(
        serve(tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS), sfp=sfp),
        tables=("SFP",),
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    assert list(prices["ticker"]) == ["SPY", "IEF"]
    assert "qopts.cursor_id" not in seen[0]
    assert seen[1]["qopts.cursor_id"] == "page-2"
    assert slept == [0.5]


def test_a_sep_only_source_never_reaches_for_the_fund_table():
    # `serve` refuses any call a test did not plan for, so leaving SFP
    # out of the routing table is the assertion.
    src, session, _ = source(
        serve(
            tickers=datatable(TICKERS_COLUMNS, BOTH_TABLES_ROWS),
            sep=datatable(
                SEP_COLUMNS, [sep_row("AAA", "2008-06-02", close=50.0, unadj=50.0)]
            ),
        ),
        tables=("SEP",),
    )

    prices = src.prices(date(2008, 1, 1), date(2008, 12, 31))

    schema.PRICES.validate(prices)
    assert list(prices["ticker"]) == ["AAA"]
    assert session.tables_called() == ["TICKERS", "SEP"]


def test_the_two_price_tables_do_not_share_a_cache_key():
    # Same range, same filter, different product. A shared key would
    # serve SEP's stocks to a query for funds and the frame would
    # validate perfectly on the way out.
    from griffinquant.data.sharadar import _cache_key

    params = {"date.gte": "2008-01-01", "date.lte": "2008-12-31"}
    assert _cache_key("SEP", params) != _cache_key("SFP", params)


# -- the network stays out -----------------------------------------------


def test_nothing_here_reaches_the_real_requests_session(monkeypatch):
    import requests

    def refuse(*args, **kwargs):
        raise AssertionError("a test opened a socket")

    monkeypatch.setattr(requests.Session, "get", refuse)
    monkeypatch.setattr(requests.Session, "request", refuse)

    src, _, _ = source(serve(tickers=datatable(TICKERS_COLUMNS, TICKERS_ROWS)))
    assert len(src.security_master()) == 4
