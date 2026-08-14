"""The French library parser, exercised without touching Dartmouth.

Every fixture below is a miniature of a real file, and each one is a
quirk that was found by parsing the actual archives rather than
imagined. That is the point of writing them out by hand instead of
checking in a downloaded sample: a fixture that is a copy of the file
goes stale the month French changes the layout, whereas a fixture that
isolates ONE quirk keeps saying what the quirk was.

The failures on trial all produce a clean, well-typed, entirely
plausible frame, which is why each is worth a test of its own.

**Percent.** French publishes 2.89 to mean 2.89%. A frame that forgot
to divide is off by a factor of a hundred everywhere and still plots.
The mirror error is worse and less obvious: dividing a table that is
NOT returns, so that "Number of Firms in Portfolios" comes back as
0.40 and reads like a weight.

**The order of the missing codes and the division.** -99.99 is
French's "no data". Divide before blanking it and it becomes -0.9999,
a 99.99% loss, which in a factor series does not look like a hole. It
looks like a finding.

**Captions.** Three ways to lose one, all seen in the wild. A stray
carriage return puts a blank line between a caption and its header in
`6_Portfolios_2x3.csv`. `F-F_Momentum_Factor_daily.csv` writes two
spare commas on every line, so the header reads `,Mom,`. And
`F-F_Momentum_Factor.csv` leaves "Missing data are indicated by
-99.99 or -999." standing alone between blank lines immediately above
the first header, where anything matching on adjacency reads it as
the table's title — and since that sentence contains neither "return"
nor "factor", the momentum series then comes back undivided while
every other factor is in decimal.

**The period switch.** A file can move from monthly rows to annual
rows under one header with nothing between them. Read as one series,
1927 becomes a timestamp and the frame validates perfectly.

**An outage is not an empty dataset.** A 404, a 500, a refused
connection and an HTML error page served with a 200 all raise. None
of them is ever cached, because a failure stored under a success's
TTL turns one bad minute into a week of missing history.
"""

from __future__ import annotations

import io
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import numpy as np
import pandas as pd
import pytest
import requests

from griffinquant.data import frenchlib as fl
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.frenchlib import (
    DECIMAL_RETURN,
    RAW,
    Downloader,
    FrenchFileMissing,
    FrenchParseError,
    FrenchUnavailable,
)

CLOCK = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)

#: Either side of the seven-day life `default_cache` gives these
#: entries, which is the point of the TTL test below.
DAYS_3 = timedelta(days=3)
DAYS_8 = timedelta(days=8)

CRLF = "\r\n"


def _file(*lines: str, sep: str = CRLF) -> str:
    return sep.join(lines) + sep


# -- fixtures, one quirk each --------------------------------------------


#: The three-factor shape: prose preamble, blank, an UNCAPTIONED
#: header, monthly rows, then a captioned annual table below.
FACTORS = _file(
    "This file was created using the 202605 CRSP database.",
    "The 1-month TBill rate data until 202405 are from Ibbotson Associates.",
    "",
    ",Mkt-RF,SMB,HML,RF",
    "192607,   2.89,  -2.55,  -2.39,   0.22",
    "192608,   2.64,  -1.14,   3.81,   0.25",
    "",
    " Annual Factors: January-December ",
    ",Mkt-RF,SMB,HML,RF",
    "  1927,  29.44,  -2.20,  -4.58,   3.12",
    "",
    "Copyright 2026 Eugene F. Fama and Kenneth R. French",
)

#: An industry file: a captioned return table and a captioned table
#: that is emphatically not returns, plus both missing codes and a
#: column name padded to a fixed width.
INDUSTRY = _file(
    "This file was created using the 202605 CRSP database.",
    "It contains value- and equal-weighted returns for 2 industry portfolios.",
    "",
    "Missing data are indicated by -99.99 or -999.",
    "",
    "",
    "  Average Value Weighted Returns -- Monthly",
    ",Agric,Soda ",
    "192607,   2.36, -99.99",
    "192608,   2.23,   -999",
    "",
    "  Number of Firms in Portfolios",
    ",Agric,Soda ",
    "192607,      3,      0",
    "192608,      4,      0",
    "",
    "Copyright 2026 Eugene F. Fama and Kenneth R. French",
)

#: `6_Portfolios_2x3.csv`: CRLF throughout except for bare carriage
#: returns, one of which lands between a caption and its header.
STRAY_CR = (
    "This file was created using the 202605 CRSP database.\r\n"
    "Missing data are indicated by -99.99 or -999.\r\n"
    "\r\n"
    "  Average Value Weighted Returns -- Monthly\r\n"
    ",SMALL LoBM,BIG HiBM\r\n"
    "192607,   1.00,   2.00\r\n"
    "\r\n\r\n\r\n"
    "  Average Equal Weighted Returns -- Annual\r\n"
    "\r"
    ",SMALL LoBM,BIG HiBM\r\n"
    "  1927,   3.00,   4.00\r\n"
    "\r\n"
    "Copyright 2026 Eugene F. Fama and Kenneth R. French\r\n"
)

#: `F-F_Momentum_Factor_daily.csv`: two spare commas on every line,
#: prose included, and the preamble's last sentence standing alone
#: between blanks directly above the header.
TRAILING_COMMAS = _file(
    "This file was created by using the 202605 CRSP database.  It,,",
    "contains a momentum factor.,,",
    ",,",
    "Missing data are indicated by -99.99 or -999.,,",
    ",,",
    ",Mom,",
    "19261103,0.35,",
    "19261104,-0.61,",
    ",,",
    "Copyright 2026 Eugene F. Fama and Kenneth R. French,,",
)

#: Monthly rows and annual rows under ONE header, nothing between.
PERIOD_SWITCH = _file(
    "This file was created using the 202605 CRSP database.",
    "",
    ",Mom",
    "192701,   1.00",
    "192702,   2.00",
    "  1927,  10.00",
    "",
    "Copyright 2026 Eugene F. Fama and Kenneth R. French",
)

#: A second table whose caption was lost — here because the only prose
#: above it is a sentence. It must NOT be assumed to be returns.
LOST_CAPTION = _file(
    "This file was created using the 202605 CRSP database.",
    "",
    ",Mkt-RF",
    "192607,   2.89",
    "",
    "Some sentence that ends in a full stop.",
    ",Mkt-RF",
    "192608,   2.64",
    "",
    "Copyright 2026 Eugene F. Fama and Kenneth R. French",
)


def _zip(text: str, member: str = "F-F_Research_Data_Factors.csv") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member, text)
    return buf.getvalue()


# -- the stand-in for requests -------------------------------------------


class _Response:
    def __init__(self, status: int = 200, content: bytes = b"") -> None:
        self.status_code = status
        self.content = content
        self.text = ""


class _Session:
    def __init__(self, handler: Callable[[str], _Response]) -> None:
        self._handler = handler
        self.calls: list[tuple[str, dict]] = []

    def get(
        self,
        url: str,
        headers: dict | None = None,
        timeout: float | None = None,
    ) -> _Response:
        self.calls.append((url, dict(headers or {})))
        return self._handler(url)


class _RefusingSession:
    """Fails the test if anything reaches it."""

    def get(self, *args: Any, **kwargs: Any) -> _Response:
        raise AssertionError("no HTTP call should have been made")


def _serving(text: str) -> _Session:
    payload = _zip(text)
    return _Session(lambda _url: _Response(200, payload))


def _downloader(session: Any, sleeps: list[float] | None = None) -> Downloader:
    record = sleeps if sleeps is not None else []
    return Downloader(session, sleep=record.append, min_interval=0.0)


# -- layout ---------------------------------------------------------------


def test_factor_file_yields_a_monthly_and_an_annual_table():
    tables = fl.parse(FACTORS, dataset_key="ff3_monthly")

    assert [t.label for t in tables] == [
        "Monthly",
        "Annual Factors: January-December",
    ]
    assert [t.frequency for t in tables] == ["monthly", "annual"]
    # The leading table has no caption of its own; the file's prose
    # preamble is not one, and must not be pressed into service as a
    # title just because it is the nearest text above the header.
    assert tables[0].caption == ""


def test_monthly_rows_are_stamped_at_month_end_and_annual_at_year_end():
    monthly, annual = fl.parse(FACTORS)

    assert list(monthly.frame.index) == [
        pd.Timestamp("1926-07-31"),
        pd.Timestamp("1926-08-31"),
    ]
    # The end of the period the return was earned over, never the
    # start. Stamped at 1 July, a July return joins against June's
    # prices — a month of lookahead dressed up as a convention.
    assert list(annual.frame.index) == [pd.Timestamp("1927-12-31")]


def test_daily_rows_keep_their_exact_session_date():
    (table,) = fl.parse(TRAILING_COMMAS, dataset_key="mom_daily")

    assert table.frequency == "daily"
    assert list(table.frame.index) == [
        pd.Timestamp("1926-11-03"),
        pd.Timestamp("1926-11-04"),
    ]


def test_captions_name_their_tables_and_column_padding_is_stripped():
    returns, firms = fl.parse(INDUSTRY, dataset_key="industry")

    assert returns.label == "Average Value Weighted Returns -- Monthly"
    assert firms.label == "Number of Firms in Portfolios"
    # French pads industry names to a fixed width: `Soda `.
    assert list(returns.frame.columns) == ["Agric", "Soda"]


def test_a_stray_carriage_return_does_not_eat_the_caption():
    tables = fl.parse(STRAY_CR, dataset_key="size_bm_6_monthly")

    labels = [t.label for t in tables]
    assert labels == [
        "Average Value Weighted Returns -- Monthly",
        "Average Equal Weighted Returns -- Annual",
    ]
    # And the bare CR is a line break, not a character inside a field:
    # `csv.reader` over a StringIO would have refused the whole file.
    assert tables[1].frame.iloc[0, 0] == pytest.approx(0.03)


def test_trailing_commas_do_not_produce_a_nameless_column():
    (table,) = fl.parse(TRAILING_COMMAS, dataset_key="mom_daily")

    assert list(table.frame.columns) == ["Mom"]
    assert table.frame["Mom"].iloc[0] == pytest.approx(0.0035)


def test_a_period_switch_under_one_header_becomes_two_tables():
    tables = fl.parse(PERIOD_SWITCH, dataset_key="mom_monthly")

    assert [t.frequency for t in tables] == ["monthly", "annual"]
    assert list(tables[0].frame.index) == [
        pd.Timestamp("1927-01-31"),
        pd.Timestamp("1927-02-28"),
    ]
    assert list(tables[1].frame.index) == [pd.Timestamp("1927-12-31")]


def test_blocks_sharing_a_header_share_their_units():
    # One header is one table in two periods. Classifying the second
    # block on its own would hand back the annual factor in percent
    # beside the monthly one in decimal, which is a discrepancy
    # nothing downstream could attribute.
    monthly, annual = fl.parse(PERIOD_SWITCH)

    assert monthly.units == annual.units == DECIMAL_RETURN
    assert annual.frame.iloc[0, 0] == pytest.approx(0.10)


def test_the_crsp_vintage_is_carried_off_the_first_line():
    tables = fl.parse(FACTORS)

    assert all(t.crsp_vintage == "202605" for t in tables)
    assert tables[0].frame.attrs["crsp_vintage"] == "202605"


# -- percent, and the order it is divided out in --------------------------


def test_return_tables_are_divided_by_one_hundred():
    (monthly, _annual) = fl.parse(FACTORS)

    assert monthly.units == DECIMAL_RETURN
    # 2.89 in the file means 2.89%.
    july = pd.Timestamp("1926-07-31")
    assert monthly.frame.loc[july, "Mkt-RF"] == pytest.approx(0.0289)
    assert monthly.frame.loc[july, "RF"] == pytest.approx(0.0022)


def test_a_firm_count_is_not_divided_by_one_hundred():
    _returns, firms = fl.parse(INDUSTRY)

    assert firms.units == RAW
    # Forty companies, not 0.40 of anything.
    assert firms.frame["Agric"].tolist() == [3.0, 4.0]


def test_missing_codes_become_nan_and_never_a_catastrophic_return():
    returns, _firms = fl.parse(INDUSTRY)

    soda = returns.frame["Soda"]
    assert soda.isna().all()
    # The order matters: divided first, -99.99 would be -0.9999 and
    # -999 would be -9.99. Both are numbers, and the first is a
    # perfectly believable wipeout.
    assert not (soda.fillna(0.0) < -0.5).any()


def test_missing_codes_are_blanked_in_a_raw_table_too():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        "  Number of Firms in Portfolios",
        ",Agric",
        "192607, -99.99",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    (firms,) = fl.parse(text)

    assert firms.units == RAW
    assert bool(firms.frame["Agric"].isna().all())


def test_an_uncaptioned_table_that_is_not_the_first_is_left_undivided():
    # The no-caption shortcut only holds for a file's leading table,
    # which in this library is always the factor returns. Anywhere
    # else, an empty caption means a caption was lost, and dividing
    # something we can no longer name is how a firm count turns into a
    # weight.
    first, second = fl.parse(LOST_CAPTION)

    assert first.units == DECIMAL_RETURN
    assert second.units == RAW
    assert second.frame.iloc[0, 0] == pytest.approx(2.64)


def test_a_prior_returns_table_is_still_a_return():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        "  Value-Weighted Average of Prior Returns",
        ",Lo PRIOR",
        "  1927, -39.55",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    (table,) = fl.parse(text)

    # "average of" would mark this raw; "return" wins first, and it
    # should — the number is a percentage.
    assert table.units == DECIMAL_RETURN
    assert table.frame.iloc[0, 0] == pytest.approx(-0.3955)


def test_a_ratio_table_is_not_a_return():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        "  Sum of BE / Sum of ME",
        ",Agric",
        "  1926,   0.77",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    (table,) = fl.parse(text)

    assert table.units == RAW
    assert table.frame.iloc[0, 0] == pytest.approx(0.77)


def test_units_travel_on_the_frame_itself():
    monthly, _ = fl.parse(FACTORS, dataset_key="ff3_monthly")

    # A reader who never saw this module still has to be able to tell
    # whether the number in front of them has been divided.
    assert monthly.frame.attrs["units"] == DECIMAL_RETURN
    assert "transaction costs" in monthly.frame.attrs["warning"]


# -- refusals -------------------------------------------------------------


def test_data_under_no_header_is_refused_rather_than_named_by_us():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "192607,   2.89",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="no honest name"):
        fl.parse(text, dataset_key="ff3_monthly")


def test_a_file_with_no_table_raises_rather_than_returning_nothing():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="no table found"):
        fl.parse(text, dataset_key="ff3_monthly")


def test_duplicate_column_names_are_refused():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        ",Agric,Agric ",
        "192607,   2.36,   2.23",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="duplicate column name"):
        fl.parse(text)


def test_a_row_wider_than_its_header_is_refused():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        ",Agric",
        "192607,   2.36,   2.23",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="against a 1-column header"):
        fl.parse(text)


def test_a_cell_that_is_not_a_number_is_refused_rather_than_coerced():
    # These files are machine-written. A non-numeric cell means the
    # table boundary was read wrong, and `errors="coerce"` would turn
    # that mistake into a sparse frame instead of an error.
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        ",Agric",
        "192607,   n/a",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="not a number"):
        fl.parse(text)


def test_a_repeated_period_is_refused():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        ",Agric",
        "192607,   2.36",
        "192607,   2.23",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    with pytest.raises(FrenchParseError, match="duplicate period"):
        fl.parse(text)


def test_a_short_row_is_padded_and_counted_rather_than_hidden():
    text = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        ",Agric,Soda",
        "192607,   2.36",
        "192608,   2.23,   1.00",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    (table,) = fl.parse(text)

    assert table.short_rows == 1
    assert bool(pd.isna(table.frame["Soda"].iloc[0]))


def test_an_html_error_page_served_with_a_200_is_an_outage():
    with pytest.raises(FrenchUnavailable, match="not a zip archive"):
        fl.read_zip(b"<html><body>Service unavailable</body></html>")


def test_an_archive_with_no_csv_is_our_problem_not_theirs():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("readme.txt", "nothing here")
    with pytest.raises(FrenchParseError, match="no .csv member"):
        fl.read_zip(buf.getvalue())


def test_the_member_name_is_not_assumed():
    # The monthly 12-industry archive holds `12_Industry_Portfolios.csv`
    # and the daily one holds `..._Daily.csv`, capital D.
    name, text = fl.read_zip(_zip(FACTORS, member="Anything_At_All.csv"))

    assert name == "Anything_At_All.csv"
    assert text.startswith("This file was created")


# -- transport ------------------------------------------------------------


def test_the_user_agent_identifies_us_with_a_real_address():
    session = _serving(FACTORS)
    _downloader(session).fetch("ff3_monthly")

    (_url, headers) = session.calls[0]
    assert "@" in headers["User-Agent"]
    assert "GriffinFund" in headers["User-Agent"]


def test_a_404_is_one_missing_file_and_is_never_retried():
    session = _Session(lambda _url: _Response(404, b""))
    with pytest.raises(FrenchFileMissing, match="not on that server"):
        _downloader(session).fetch("ff3_monthly")

    # A 404 is an answer. Asking three times does not change it, and
    # this server is a university web host doing us a favour.
    assert len(session.calls) == 1


def test_a_500_is_retried_and_then_reported_as_an_outage():
    session = _Session(lambda _url: _Response(503, b""))
    sleeps: list[float] = []
    with pytest.raises(FrenchUnavailable, match="unreachable after"):
        _downloader(session, sleeps).fetch("ff3_monthly")

    assert len(session.calls) == fl.MAX_ATTEMPTS
    assert len(sleeps) == fl.MAX_ATTEMPTS - 1


def test_a_refused_connection_is_an_outage_not_an_empty_dataset():
    def boom(_url: str) -> _Response:
        raise requests.ConnectionError("no route to host")

    with pytest.raises(FrenchUnavailable, match="not a statement about"):
        _downloader(_Session(boom)).fetch("ff3_monthly")


def test_french_unavailable_is_a_source_unavailable():
    # Anything already catching the repository's outage type keeps
    # working; the rule about outages is one rule, not two.
    assert issubclass(FrenchUnavailable, SourceUnavailable)
    assert issubclass(FrenchFileMissing, FrenchUnavailable)
    # And a parse error is emphatically not one: whose fault it is
    # decides whether retrying is sane.
    assert not issubclass(FrenchParseError, SourceUnavailable)


def test_the_client_paces_itself_between_calls():
    session = _serving(FACTORS)
    sleeps: list[float] = []
    agent = Downloader(session, sleep=sleeps.append, min_interval=5.0)

    agent.fetch("ff3_monthly")
    agent.fetch("ff5_monthly")

    assert len(session.calls) == 2
    # The first call waits for nothing; the second waits for the first.
    assert len(sleeps) == 1 and 0.0 < sleeps[0] <= 5.0


def test_an_unknown_key_names_the_ones_we_know():
    with pytest.raises(KeyError, match="ff3_monthly"):
        fl.dataset("ff3_montly")


# -- cache ----------------------------------------------------------------


def test_a_second_load_reads_the_cache_rather_than_the_network(tmp_path):
    session = _serving(FACTORS)
    agent = _downloader(session)
    cache = fl.default_cache(tmp_path)

    first = fl.load("ff3_monthly", cache=cache, downloader=agent, now=CLOCK)
    second = fl.load("ff3_monthly", cache=cache, downloader=agent, now=CLOCK)

    assert len(session.calls) == 1
    pd.testing.assert_frame_equal(first["Monthly"], second["Monthly"])


def test_a_warm_cache_is_readable_with_no_network_at_all(tmp_path):
    cache = fl.default_cache(tmp_path)
    fl.load(
        "ff3_monthly",
        cache=cache,
        downloader=_downloader(_serving(FACTORS)),
        now=CLOCK,
    )

    # The reviewer's path: they have the saved pull and nothing else.
    frames = fl.load(
        "ff3_monthly",
        cache=cache,
        downloader=_downloader(_RefusingSession()),
        now=CLOCK,
    )
    july = pd.Timestamp("1926-07-31")
    assert frames["Monthly"].loc[july, "Mkt-RF"] == pytest.approx(0.0289)


def test_an_outage_is_never_written_to_the_cache(tmp_path):
    cache = fl.default_cache(tmp_path)
    dead = _Session(lambda _url: _Response(503, b""))

    with pytest.raises(FrenchUnavailable):
        fl.load(
            "ff3_monthly", cache=cache, downloader=_downloader(dead), now=CLOCK
        )

    # Nothing stored, so the next attempt is a fresh one rather than a
    # week of a cached failure.
    key = cache.key(fl.CACHE_SOURCE, fl.CACHE_FRAME, dataset="ff3_monthly")
    assert cache.get(key) is None

    frames = fl.load(
        "ff3_monthly",
        cache=cache,
        downloader=_downloader(_serving(FACTORS)),
        now=CLOCK,
    )
    assert "Monthly" in frames


def test_the_cache_entry_lives_a_week_not_a_day(tmp_path):
    # French rebuilds monthly. The unregistered-frame default in
    # cache.py is one day, which for these files would mean fifty
    # megabytes downloaded to learn nothing.
    session = _serving(FACTORS)
    agent = _downloader(session)
    cache = fl.default_cache(tmp_path)

    fl.load("ff3_monthly", cache=cache, downloader=agent, now=CLOCK)
    fl.load("ff3_monthly", cache=cache, downloader=agent, now=CLOCK + DAYS_3)
    assert len(session.calls) == 1

    fl.load("ff3_monthly", cache=cache, downloader=agent, now=CLOCK + DAYS_8)
    assert len(session.calls) == 2


def test_the_round_trip_through_disk_changes_nothing(tmp_path):
    tables = fl.parse(INDUSTRY, dataset_key="industry49_monthly")
    long = fl.to_long(tables)
    back = fl.from_long(long)

    assert list(back) == [t.label for t in tables]
    for table in tables:
        pd.testing.assert_frame_equal(back[table.label], table.frame)
        assert back[table.label].attrs["units"] == table.units


def test_column_order_survives_the_cache(tmp_path):
    # Industry order is information. A pivot sorts columns
    # alphabetically unless it is stopped, and `Soda` before `Agric`
    # is a small loss that cannot be undone once the parquet is
    # written.
    session = _serving(INDUSTRY)
    cache = fl.default_cache(tmp_path)
    kwargs = dict(cache=cache, downloader=_downloader(session), now=CLOCK)

    fl.load("industry49_monthly", **kwargs)
    frames = fl.load(
        "industry49_monthly",
        cache=cache,
        downloader=_downloader(_RefusingSession()),
        now=CLOCK,
    )
    wide = frames["Average Value Weighted Returns -- Monthly"]

    assert list(wide.columns) == ["Agric", "Soda"]
    assert wide.index.name == "date"
    assert str(wide.index.dtype) == "datetime64[ns]"
    assert all(str(d) == "float64" for d in wide.dtypes)


def test_a_cached_frame_from_an_older_layout_is_refused(tmp_path):
    thin = pd.DataFrame({"table": ["x"], "date": [pd.Timestamp("2020-01-31")]})
    with pytest.raises(FrenchParseError, match="older layout"):
        fl.from_long(thin)


# -- picking a table ------------------------------------------------------


def test_load_table_matches_on_a_substring(tmp_path):
    frames_kwargs = dict(
        cache=fl.default_cache(tmp_path),
        downloader=_downloader(_serving(INDUSTRY)),
        now=CLOCK,
    )
    table = fl.load_table(
        "industry49_monthly", "Number of Firms", **frames_kwargs
    )

    assert table.attrs["units"] == RAW


def test_an_ambiguous_table_name_raises_and_lists_the_candidates(tmp_path):
    both = _file(
        "This file was created using the 202605 CRSP database.",
        "",
        "  Average Value Weighted Returns -- Monthly",
        ",Agric",
        "192607,   2.36",
        "",
        "  Average Equal Weighted Returns -- Monthly",
        ",Agric",
        "192607,   2.64",
        "",
        "Copyright 2026 Eugene F. Fama and Kenneth R. French",
    )
    frames_kwargs = dict(
        cache=fl.default_cache(tmp_path),
        downloader=_downloader(_serving(both)),
        now=CLOCK,
    )
    # "Monthly" is in both captions, and picking the first would
    # decide between value- and equal-weighted returns on the
    # caller's behalf — a default nobody remembers making.
    with pytest.raises(KeyError, match="matches"):
        fl.load_table("industry49_monthly", "Monthly", **frames_kwargs)


def test_a_table_name_that_matches_nothing_lists_what_is_there(tmp_path):
    frames_kwargs = dict(
        cache=fl.default_cache(tmp_path),
        downloader=_downloader(_serving(INDUSTRY)),
        now=CLOCK,
    )
    with pytest.raises(KeyError, match="Number of Firms in Portfolios"):
        fl.load_table("industry49_monthly", "Daily", **frames_kwargs)


# -- the batch pull -------------------------------------------------------


def test_a_renamed_file_is_recorded_and_the_rest_still_load(tmp_path):
    payload = _zip(FACTORS)

    def handler(url: str) -> _Response:
        if "5_Factors" in url:
            return _Response(404, b"")
        return _Response(200, payload)

    report = fl.fetch_all(
        ["ff3_monthly", "ff5_monthly", "mom_monthly"],
        cache=fl.default_cache(tmp_path),
        downloader=_downloader(_Session(handler)),
        now=CLOCK,
    )

    assert sorted(report.loaded) == ["ff3_monthly", "mom_monthly"]
    assert list(report.missing) == ["ff5_monthly"]
    assert "5_Factors" in report.missing["ff5_monthly"]
    assert "MISSING ff5_monthly" in report.summary()


def test_an_outage_mid_pull_stops_the_pull(tmp_path):
    payload = _zip(FACTORS)

    def handler(url: str) -> _Response:
        if "5_Factors" in url:
            return _Response(503, b"")
        return _Response(200, payload)

    # Carrying on past a 503 would produce a partial pull that reads
    # exactly like a complete one.
    with pytest.raises(FrenchUnavailable):
        fl.fetch_all(
            ["ff3_monthly", "ff5_monthly", "mom_monthly"],
            cache=fl.default_cache(tmp_path),
            downloader=_downloader(_Session(handler)),
            now=CLOCK,
        )


# -- honesty --------------------------------------------------------------


def test_the_registry_is_internally_consistent():
    keys = [d.key for d in fl.available()]
    files = [d.filename for d in fl.available()]

    assert len(set(keys)) == len(keys)
    assert len(set(files)) == len(files)
    assert all(d.url.startswith(fl.BASE_URL) for d in fl.available())
    assert all(d.frequency in ("daily", "monthly") for d in fl.available())


def test_the_registry_covers_what_this_module_promised():
    keys = set(fl.DATASETS)
    for wanted in (
        "ff3_monthly",
        "ff3_daily",
        "ff5_monthly",
        "ff5_daily",
        "mom_monthly",
        "st_rev_monthly",
        "lt_rev_monthly",
        "industry49_monthly",
        "industry12_monthly",
        "size_bm_6_monthly",
        "size_bm_25_monthly",
    ):
        assert wanted in keys


def test_the_provenance_block_says_the_things_that_matter():
    text = fl.PROVENANCE.lower()

    assert "crsp" in text
    assert "survivorship" in text
    # The licence is the part everyone skips. There isn't one, and
    # saying so is the whole point.
    assert "no explicit" in text and "licence" in text
    assert "portfolio-level returns only" in text


def test_describe_refuses_to_call_this_tradable():
    described = fl.describe("ff3_monthly")

    assert described["survivorship_free"] is True
    assert described["tradable"] is False
    assert "transaction costs" in described["tradability_warning"]
    assert "no individual securities" in described["granularity"]


def test_describe_reports_the_observed_range_beside_the_claimed_one():
    tables = fl.parse(FACTORS, dataset_key="ff3_monthly")
    frames = {t.label: t.frame for t in tables}
    described = fl.describe("ff3_monthly", frames)

    # The hint is documentation and can rot; the observed range is
    # read off the rows in front of the caller and cannot.
    assert described["expected_start"] == "1926-07"
    assert described["observed"]["Monthly"]["start"] == "1926-07-31"
    assert described["observed"]["Monthly"]["units"] == DECIMAL_RETURN


def test_an_empty_frame_reports_no_range_rather_than_a_fake_one():
    empty = pd.DataFrame({"Mkt-RF": pd.Series([], dtype="float64")})
    empty.index = pd.DatetimeIndex([], name="date")

    assert fl.observed_range(empty) == {
        "start": None,
        "end": None,
        "rows": 0,
        "columns": ["Mkt-RF"],
        "units": "unknown",
        "frequency": "unknown",
    }


def test_the_parsed_values_are_plausible_returns_not_percentages():
    monthly, annual = fl.parse(FACTORS)

    # A frame that forgot the division has a market factor of 2.89 in
    # a month, which is a 289% move and would still plot.
    for frame in (monthly.frame, annual.frame):
        values = frame.to_numpy(dtype="float64")
        assert np.nanmax(np.abs(values)) < 1.0
