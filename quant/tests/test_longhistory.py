"""The century-scale readers, exercised without touching a web server.

Nothing here downloads anything. `LongHistory` takes its session, its
sleep and its clock as constructor arguments, and both parsers work on
a plain grid of cells rather than on a workbook object, precisely so a
test can write down the exact shape that goes wrong. A suite that
needed Shiller's site to be up would only run on the days it was.

Six failures are on trial, and what they have in common is that every
one of them produces a frame that looks perfect.

**October reads as January.** The Shiller date column is YYYY.MM, and
Excel stores October as the float YYYY.1 — so a decimal-year parse
folds every October onto January, keeps the row count, keeps the
dtypes, and shifts a quarter of the series by nine months. The tests
check the decoder directly, check it against the workbook's own second
encoding of the same month, and check the gate that fires when a parse
gets it wrong: months must form an unbroken sequence, and a collapse
shows up as a duplicated January beside a missing October.

**A column moves and the frame still validates.** Damodaran writes
`S&P 500 (includes dividends)3` twice — once over nominal wealth, once
over real — and only the merged banner above tells them apart. Worse,
the nominal banner is a strict PREFIX of the real one, so a needle
without the block separator matches both. There are tests for the
prefix, for an ambiguous match raising rather than taking the first
hit, and for a required column's absence being loud.

**A summary row read as data.** Both annual sheets end with average
blocks whose first cell is a period label. A parser that kept going
would report `1928-2025` as a year.

**A number typed as text.** About one cell in a hundred of the monthly
ERP sheet is a string — a percent sign, a European decimal comma, a
footnote asterisk, and one month where every field is formatted that
way. `pd.to_numeric` NaNs the lot in silence.

**A missing input printed as a zero.** Where S&P has not reported
earnings, Shiller's real-earnings formula evaluates to 0.0 rather than
to blank. A zero there is not a quarter in which the index earned
nothing, and left alone it makes a P/E infinite.

**An outage that looks like an empty century.** A 200 carrying an
error page, a 404 on a moved file, a FRED series that would not load:
each raises, and none of them leaves anything in the cache for the
next run to read as data.
"""

from __future__ import annotations

import math
import warnings
from datetime import date, datetime, timezone
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.data import longhistory as lh
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.longhistory import (
    DATASETS,
    LongHistory,
    LongHistoryUnavailable,
    annual_from_shiller,
    catalogue,
    coerce_number,
    parse_damodaran_annual,
    parse_damodaran_erp_monthly,
    parse_damodaran_implied_erp_annual,
    parse_shiller,
    parse_shiller_notes,
    reconcile_annual_equity_return,
    shiller_month,
)

CLOCK = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)


# -- grid builders --------------------------------------------------------
#
# These reproduce the real workbooks' header layouts cell for cell. That
# is the point: a simplified header would test the resolver against a
# shape the resolver will never meet.

SHILLER_WIDTH = 22


def _blank_row(width: int = SHILLER_WIDTH) -> list[Any]:
    return ["" for _ in range(width)]


def _row(width: int, **cells: Any) -> list[Any]:
    out = _blank_row(width)
    for key, value in cells.items():
        out[int(key[1:])] = value
    return out


def _shiller_header() -> list[list[Any]]:
    w = SHILLER_WIDTH
    return [
        _blank_row(),
        _row(w, c0="Stock Market Data Used in ...", c12="Cyclically", c14="Cyclically"),
        _row(w, c0="Robert J. Shiller", c12="Adjusted", c14="Adjusted"),
        _row(w, c12="Price", c14="Total Return Price"),
        _row(
            w, c4="Consumer", c9="Real", c11="Real", c12="Earnings",
            c14="Earnings", c17="Monthly", c18="Real",
        ),
        _row(
            w, c1="S&P", c4="Price", c6="Long", c9="Total", c11="TR",
            c12="Ratio", c14="Ratio", c16="Excess", c17="Total", c18="Total",
            c19="10 Year", c20="10 Year", c21="Real 10 Year",
        ),
        _row(
            w, c1="Comp.", c2="Dividend", c3="Earnings", c4="Index", c5="Date",
            c6="Interest", c7="Real", c8="Real", c9="Return", c10="Real",
            c11="Scaled", c12="P/E10 or", c14="TR P/E10 or", c16="CAPE",
            c17="Bond", c18="Bond", c19="Annualized Stock",
            c20="Annualized Bonds", c21="Excess Annualized",
        ),
        _row(
            w, c0="Date", c1="P", c2="D", c3="E", c4="CPI", c5="Fraction",
            c6="Rate GS10", c7="Price", c8="Dividend", c9="Price",
            c10="Earnings", c11="Earnings", c12="CAPE", c14="TR CAPE",
            c16="Yield", c17="Returns", c18="Returns", c19="Real Return",
            c20="Real Return", c21="Returns",
        ),
    ]


def _shiller_data_row(
    year: int,
    month: int,
    *,
    price: float = 100.0,
    dividend: Any = 2.0,
    earnings: Any = 5.0,
    cpi: float = 250.0,
    real_earnings: Any = 5.0,
    fraction: Any = None,
    date_value: Any = None,
) -> list[Any]:
    # Written the way Excel stores it: 1871.01 is January and 1871.10 is
    # October, and float("1871.10") is the same 1871.1 the workbook holds.
    if date_value is None:
        date_value = float(f"{year}.{month:02d}")
    if fraction is None:
        fraction = year + (month - 0.5) / 12.0
    return _row(
        SHILLER_WIDTH,
        c0=date_value,
        c1=price,
        c2=dividend,
        c3=earnings,
        c4=cpi,
        c5=fraction,
        c6=4.0,
        c7=price * 2,
        c8=3.0,
        c9=price * 3,
        c10=real_earnings,
        c11=6.0,
        c12=30.0,
        c14=32.0,
        c16=0.01,
        c17=1.001,
        c18=1.002,
        c19=0.05,
        c20=0.02,
        c21=0.03,
    )


def _shiller_grid(rows: list[list[Any]], notes: list[Any] | None = None) -> lh.Grid:
    grid = _shiller_header() + rows
    if notes is not None:
        grid.append(notes)
    return grid


def _months(year: int, first: int, count: int) -> list[tuple[int, int]]:
    out = []
    y, m = year, first
    for _ in range(count):
        out.append((y, m))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


DAM_WIDTH = 12


def _damodaran_grid(years: list[int]) -> lh.Grid:
    w = DAM_WIDTH
    grid: lh.Grid = [
        _row(w, c0="Date updated:", c1=44561.0),
        _row(w, c0="Created by:", c1="Aswath Damodaran"),
        _blank_row(w),
        # The merged banner. Note the nominal block's name is a strict
        # prefix of the real one — that is the trap being reproduced.
        _row(
            w,
            c1="Annual Returns on Investments in",
            c4="Value of $100 invested at start of 1928 in",
            c7="Annual Risk Premium",
            c9="Annual Real Returns",
            c11="Value of $100 invested at start of 1928 in real terms",
        ),
        _row(
            w,
            c0="Year",
            c1="S&P 500 (includes dividends)",
            c2="3-month T.Bill",
            c3="US T. Bond (10-year)",
            c4="S&P 500 (includes dividends)3",
            c5="3-month T.Bill4",
            c6="US T. Bond5",
            c7="Stocks - Bills",
            c8="Stocks - Bonds",
            c9="Inflation Rate",
            c10="!0-year T.Bonds",
            c11="S&P 500 (includes dividends)3",
        ),
    ]
    for i, year in enumerate(years):
        grid.append(
            _row(
                w,
                c0=float(year),
                c1=0.10 + i,
                c2=0.03,
                c3=0.04,
                c4=110.0 + i,
                c5=103.0,
                c6=104.0,
                c7=0.07,
                c8=0.06,
                c9=0.02,
                c10=0.019,
                c11=108.0 + i,
            )
        )
    # The summary block: a period label where a year belongs.
    grid.append(_row(w, c0="Arithmetic Average Historical Return"))
    grid.append(_row(w, c0="1928-2025", c1=0.1185))
    return grid


ERP_WIDTH = 5


def _erp_annual_grid(years: list[int]) -> lh.Grid:
    w = ERP_WIDTH
    grid: lh.Grid = [
        _row(w, c0="Date updated:", c1=43834.0),
        _blank_row(w),
        _row(
            w,
            c0="Year",
            c1="Earnings Yield",
            c2="T.Bill Rate",
            c3="Implied Premium (DDM)",
            c4="Implied ERP (FCFE)",
        ),
    ]
    for i, year in enumerate(years):
        grid.append(
            _row(w, c0=float(year), c1=0.05, c2=0.02, c3=0.04 + i / 100, c4=0.04)
        )
    grid.append(_row(w, c1="Period", c2="ERP"))
    return grid


MONTHLY_WIDTH = 6


def _erp_monthly_grid(rows: list[list[Any]]) -> lh.Grid:
    return [
        _row(
            MONTHLY_WIDTH,
            c0="Start of month",
            c1="S&P 500",
            c2="ERP (T12m)",
            c3="ERP (T12m) with adj riskfree rate",
            c4="ERP (Smoothed)",
            c5="Notes",
        )
    ] + rows


def _erp_monthly_row(
    year: int,
    month: int,
    *,
    sp500: Any = 4000.0,
    trailing: Any = 0.042,
    adjusted: Any = 0.045,
    smoothed: Any = 0.062,
    note: Any = "",
) -> list[Any]:
    return _row(
        MONTHLY_WIDTH,
        c0=datetime(year, month, 1),
        c1=sp500,
        c2=trailing,
        c3=adjusted,
        c4=smoothed,
        c5=note,
    )


# -- the date encoding ----------------------------------------------------


@pytest.mark.parametrize(
    "cell, expected",
    [
        (1871.01, (1871, 1)),
        (1871.02, (1871, 2)),
        (1871.09, (1871, 9)),
        # The whole file in one row: Excel stores October as 1871.1, and
        # a parse that reads the digits after the point sees a 1.
        (1871.1, (1871, 10)),
        (1871.11, (1871, 11)),
        (1871.12, (1871, 12)),
        (2026.07, (2026, 7)),
        ("1929.10", (1929, 10)),
    ],
)
def test_shiller_month_decodes_october_as_october(cell, expected):
    assert shiller_month(cell) == expected


def test_shiller_month_rejects_a_decimal_year():
    # 1871.5 is mid-1871 if the column were a decimal year. It is not,
    # and month 50 is the honest reading of what arrived.
    with pytest.raises(ValueError, match="not a month"):
        shiller_month(1871.5)


def test_shiller_month_rejects_garbage():
    with pytest.raises(ValueError, match="not a Shiller date cell"):
        shiller_month("Sept price is Sept 1st close")


def test_shiller_month_checks_the_fraction_column():
    # The two encodings agree in the real file; where they do not, the
    # layout changed and this parser is reading the wrong column.
    assert shiller_month(1871.1, 1871 + 9.5 / 12) == (1871, 10)
    with pytest.raises(ValueError, match="Date Fraction"):
        shiller_month(1871.1, 1871 + 0.5 / 12)


def test_shiller_month_tolerates_a_missing_fraction():
    assert shiller_month(1871.1, None) == (1871, 10)
    assert shiller_month(1871.1, "") == (1871, 10)


# -- parse_shiller --------------------------------------------------------


def test_parse_shiller_reads_a_year_of_months_in_order():
    rows = [
        _shiller_data_row(y, m, price=100.0 + i)
        for i, (y, m) in enumerate(_months(1871, 9, 8))
    ]
    frame = parse_shiller(_shiller_grid(rows))

    assert len(frame) == 8
    assert list(frame["date"].dt.month) == [9, 10, 11, 12, 1, 2, 3, 4]
    assert list(frame["date"].dt.year) == [1871] * 4 + [1872] * 4
    # October is October and carries October's price, not January's.
    october = frame.loc[frame["date"] == pd.Timestamp("1871-10-01")]
    assert len(october) == 1
    assert october["sp500_price"].iloc[0] == pytest.approx(101.0)


def test_parse_shiller_resolves_every_column_by_its_stacked_header():
    frame = parse_shiller(_shiller_grid([_shiller_data_row(1900, 1)]))
    for name in (
        "sp500_price", "dividend", "earnings", "cpi", "long_rate",
        "real_price", "real_dividend", "real_total_return_price",
        "real_earnings", "real_tr_scaled_earnings", "cape", "tr_cape",
        "excess_cape_yield", "bond_total_return", "real_bond_total_return",
        "stock_real_return_10y", "bond_real_return_10y",
        "excess_real_return_10y",
    ):
        assert name in frame.columns, name
    # CAPE and TR CAPE differ only in a stacked banner; crossing them
    # would swap two plausible numbers and never look wrong.
    assert frame["cape"].iloc[0] == pytest.approx(30.0)
    assert frame["tr_cape"].iloc[0] == pytest.approx(32.0)
    assert frame["real_price"].iloc[0] == pytest.approx(200.0)
    assert frame["real_total_return_price"].iloc[0] == pytest.approx(300.0)


def test_parse_shiller_stops_at_the_prose_and_keeps_it():
    rows = [_shiller_data_row(1871, m) for m in (1, 2, 3)]
    note = _row(SHILLER_WIDTH, c1="March price is March 3rd close", c4="CPI estimated")
    grid = _shiller_grid(rows, notes=note)

    frame = parse_shiller(grid)
    assert len(frame) == 3

    notes = parse_shiller_notes(grid)
    assert list(notes["text"]) == ["March price is March 3rd close", "CPI estimated"]


def test_parse_shiller_raises_on_a_missing_month():
    rows = [
        _shiller_data_row(1871, 9),
        _shiller_data_row(1871, 11),
        _shiller_data_row(1871, 12),
    ]
    with pytest.raises(LongHistoryUnavailable, match="1871-10-01"):
        parse_shiller(_shiller_grid(rows))


def test_parse_shiller_raises_on_a_duplicated_month():
    rows = [
        _shiller_data_row(1871, 1),
        # A second January carrying October's fraction: exactly the row
        # a decimal-year parse would produce, and it must not pass.
        _shiller_data_row(1871, 1, fraction=1871 + 0.5 / 12),
        _shiller_data_row(1871, 2),
    ]
    with pytest.raises(LongHistoryUnavailable, match="not a complete monthly sequence"):
        parse_shiller(_shiller_grid(rows))


def test_the_month_gate_names_the_yyyy_mm_trap():
    # The exact shape a naive parse leaves behind over one year: two
    # Januaries, every other month once, and no October at all.
    stamps = [f"1871-{m:02d}-01" for m in (1, *range(1, 10), 11, 12)]
    with pytest.raises(LongHistoryUnavailable) as excinfo:
        lh._assert_unbroken_months(pd.Series(pd.to_datetime(stamps)), where="test")
    message = str(excinfo.value)
    assert "1871-10-01" in message
    assert "1 missing" in message
    assert "YYYY.MM" in message


def test_parse_shiller_blanks_a_deflated_zero_only_when_its_input_is_blank():
    rows = [
        # Reported month: a real zero stays a zero, because nothing
        # here entitles us to an opinion about the author's numbers.
        _shiller_data_row(1871, 1, earnings=5.0, real_earnings=0.0),
        # Unreported month: blank nominal, formula-default zero real.
        _shiller_data_row(1871, 2, earnings="", real_earnings=0.0),
    ]
    frame = parse_shiller(_shiller_grid(rows))
    assert frame["real_earnings"].iloc[0] == 0.0
    assert math.isnan(frame["real_earnings"].iloc[1])
    assert math.isnan(frame["earnings"].iloc[1])


def test_parse_shiller_raises_when_a_required_column_vanishes():
    grid = _shiller_grid([_shiller_data_row(1871, 1)])
    grid[7][4] = ""  # the "CPI" label
    grid[4][4] = ""
    grid[5][4] = ""
    grid[6][4] = ""
    with pytest.raises(LongHistoryUnavailable, match="'cpi'"):
        parse_shiller(grid)


def test_parse_shiller_omits_an_optional_column_rather_than_faking_it():
    # An archived vintage predating the excess CAPE yield should lose
    # the column, NOT gain a column of NaN — a NaN column reads as the
    # author having published blanks.
    grid = _shiller_grid([_shiller_data_row(1871, 1)])
    for r in (5, 6, 7):
        grid[r][16] = ""
    frame = parse_shiller(grid)
    assert "excess_cape_yield" not in frame.columns
    assert "cape" in frame.columns


def test_parse_shiller_refuses_an_ambiguous_column():
    grid = _shiller_grid([_shiller_data_row(1871, 1)])
    grid[7][13] = "CAPE"  # a second column answering to "cape"
    grid[5][13] = "Ratio"
    with pytest.raises(LongHistoryUnavailable, match="matches 2 columns"):
        parse_shiller(grid)


def test_parse_shiller_raises_rather_than_returning_an_empty_century():
    with pytest.raises(LongHistoryUnavailable, match="no numeric dates"):
        parse_shiller(_shiller_grid([]))


# -- coerce_number --------------------------------------------------------


@pytest.mark.parametrize(
    "cell, expected",
    [
        (0.0372, 0.0372),
        (5648, 5648.0),
        ("5648", 5648.0),
        ("3.90%", 0.039),
        ("242.42", 242.42),
        # European decimal comma. The neighbouring published values are
        # 0.0628 and 85, so neither reading is a guess.
        ("6,36%", 0.0636),
        ("84,88", 84.88),
        # A comma with three digits after it is a thousands separator,
        # which is the right way round for an American spreadsheet.
        ("1,234", 1234.0),
        ("175.51*", 175.51),
        ("-0.05", -0.05),
        # No cell uses the accounting convention today. Handled anyway,
        # because the failure is a sign flip that keeps the magnitude
        # and turns a loss into a gain.
        ("(0.05)", -0.05),
        ("(3.90%)", -0.039),
    ],
)
def test_coerce_number_repairs_what_the_author_meant(cell, expected):
    assert coerce_number(cell) == pytest.approx(expected)


@pytest.mark.parametrize("cell", ["Ended", "", "   ", None, True, False, object()])
def test_coerce_number_returns_nan_for_anything_that_is_not_a_number(cell):
    assert math.isnan(coerce_number(cell))


# -- Damodaran annual -----------------------------------------------------


def test_parse_damodaran_annual_reads_years_and_stops_at_the_summary():
    frame = parse_damodaran_annual(_damodaran_grid([1928, 1929, 1930]))
    assert list(frame["year"]) == [1928, 1929, 1930]
    assert frame["year"].dtype == "int64"


def test_parse_damodaran_annual_keeps_the_nominal_and_real_blocks_apart():
    # The nominal banner is a strict prefix of the real one. Without
    # the block separator both specs match both columns, and nominal
    # wealth lands in the real column looking entirely reasonable.
    frame = parse_damodaran_annual(_damodaran_grid([1928]))
    assert frame["sp500_value"].iloc[0] == pytest.approx(110.0)
    assert frame["sp500_real_value"].iloc[0] == pytest.approx(108.0)


def test_parse_damodaran_annual_year_anchor_ignores_ten_year_headers():
    # Four other headers contain the word "year" — "US T. Bond
    # (10-year)" among them — so the year column is anchored on the
    # whole header cell rather than on a substring.
    frame = parse_damodaran_annual(_damodaran_grid([1928, 1929]))
    assert frame["tbond_return"].iloc[0] == pytest.approx(0.04)
    assert frame["tbond_real_return"].iloc[0] == pytest.approx(0.019)


def test_parse_damodaran_annual_raises_on_a_missing_required_column():
    grid = _damodaran_grid([1928])
    grid[4][9] = "Something Else"  # the inflation header
    with pytest.raises(LongHistoryUnavailable, match="'inflation'"):
        parse_damodaran_annual(grid)


def test_parse_damodaran_annual_raises_when_years_are_not_increasing():
    grid = _damodaran_grid([1928, 1929])
    grid[6][0] = 1928.0
    with pytest.raises(LongHistoryUnavailable, match="strictly increasing"):
        parse_damodaran_annual(grid)


def test_parse_damodaran_implied_erp_annual():
    frame = parse_damodaran_implied_erp_annual(_erp_annual_grid([1960, 1961, 1962]))
    assert list(frame["year"]) == [1960, 1961, 1962]
    assert frame["implied_premium_ddm"].iloc[2] == pytest.approx(0.06)
    assert "implied_erp_fcfe" in frame.columns


# -- Damodaran monthly ERP ------------------------------------------------


def test_parse_erp_monthly_repairs_text_numbers_and_says_how_many():
    rows = [
        _erp_monthly_row(2008, 9),
        _erp_monthly_row(2008, 10, smoothed="6,36%", note="Updated growth rates"),
        _erp_monthly_row(2008, 11, sp500="5648", trailing="4.06%"),
    ]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        frame = parse_damodaran_erp_monthly(_erp_monthly_grid(rows))

    assert frame["erp_smoothed"].iloc[1] == pytest.approx(0.0636)
    assert frame["sp500"].iloc[2] == pytest.approx(5648.0)
    assert frame["erp_trailing"].iloc[2] == pytest.approx(0.0406)
    assert frame["notes"].iloc[1] == "Updated growth rates"

    messages = [str(w.message) for w in caught]
    assert any("repaired 3 number(s) typed as text" in m for m in messages)


def test_parse_erp_monthly_keeps_prose_out_of_the_numbers():
    rows = [
        _erp_monthly_row(2008, 9),
        # The author wrote "Ended" in a column he stopped maintaining.
        _erp_monthly_row(2008, 10, smoothed="Ended"),
    ]
    frame = parse_damodaran_erp_monthly(_erp_monthly_grid(rows))
    assert math.isnan(frame["erp_smoothed"].iloc[1])


def test_parse_erp_monthly_keeps_the_two_trailing_erps_apart():
    # "ERP (T12m)" is a substring of "ERP (T12m) with adj riskfree
    # rate", so one of the two specs has to forbid the other.
    frame = parse_damodaran_erp_monthly(
        _erp_monthly_grid([_erp_monthly_row(2008, 9)])
    )
    assert frame["erp_trailing"].iloc[0] == pytest.approx(0.042)
    assert frame["erp_trailing_adjusted_riskfree"].iloc[0] == pytest.approx(0.045)


def test_parse_erp_monthly_requires_an_unbroken_month_sequence():
    rows = [_erp_monthly_row(2008, 9), _erp_monthly_row(2008, 11)]
    with pytest.raises(LongHistoryUnavailable, match="not a complete monthly sequence"):
        parse_damodaran_erp_monthly(_erp_monthly_grid(rows))


# -- derived views --------------------------------------------------------


def _two_year_shiller(months: int = 25) -> pd.DataFrame:
    rows = []
    for i, (y, m) in enumerate(_months(1928, 12, months)):
        # Real total return price triples over each year; CPI flat, so
        # nominal and real returns coincide and the arithmetic is
        # checkable by eye.
        level = 100.0 * (3.0 ** (i / 12.0))
        rows.append(_shiller_data_row(y, m, price=level, cpi=100.0))
        rows[-1][9] = level
    return parse_shiller(_shiller_grid(rows))


def test_annual_from_shiller_is_december_to_december():
    frame = annual_from_shiller(_two_year_shiller())
    assert list(frame["year"]) == [1929, 1930]
    assert frame["real_total_return"].iloc[0] == pytest.approx(2.0, rel=1e-6)
    assert frame["nominal_total_return"].iloc[0] == pytest.approx(2.0, rel=1e-6)
    assert frame["inflation"].iloc[0] == pytest.approx(0.0)


def test_annual_from_shiller_drops_a_year_with_no_december():
    monthly = _two_year_shiller(months=37)  # Dec 1928 through Dec 1931
    monthly = monthly.loc[monthly["date"] != pd.Timestamp("1929-12-01")]
    frame = annual_from_shiller(monthly)
    # Only 1931 has both ends. The 1928 -> 1930 pair spans two years
    # and would print a 200% year if the gap went unnoticed.
    assert list(frame["year"]) == [1931]


def test_reconcile_flags_only_what_exceeds_the_tolerance():
    monthly = _two_year_shiller()
    damodaran = pd.DataFrame(
        {"year": [1929, 1930], "sp500_return": [2.01, 0.10]}
    )
    flagged = reconcile_annual_equity_return(monthly, damodaran, tolerance=0.05)
    assert list(flagged["year"]) == [1930]
    assert flagged["diff"].iloc[0] == pytest.approx(1.9, rel=1e-3)


def test_reconcile_raises_when_the_two_share_no_years():
    monthly = _two_year_shiller()
    damodaran = pd.DataFrame({"year": [2010, 2011], "sp500_return": [0.1, 0.1]})
    with pytest.raises(ValueError, match="share no years"):
        reconcile_annual_equity_return(monthly, damodaran)


# -- transport ------------------------------------------------------------

OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"workbook bytes"
ZIPPED = b"PK\x03\x04" + b"xlsx bytes"


class _Response:
    def __init__(self, status: int = 200, content: bytes = b"") -> None:
        self.status_code = status
        self.content = content


class _Session:
    def __init__(self, handler: Callable[[str], _Response]) -> None:
        self._handler = handler
        self.calls: list[str] = []

    def get(self, url: str, headers: dict | None = None, timeout: float | None = None):
        self.calls.append(url)
        assert headers and "newtheyork@gmail.com" in headers["User-Agent"], (
            "a personal academic host must be able to work out who to tell"
        )
        return self._handler(url)


class _RefusingSession:
    def get(self, *args: Any, **kwargs: Any):
        raise AssertionError("no HTTP call should have been made")


def _library(session: Any, cache: ParquetCache | None = None) -> LongHistory:
    return LongHistory(
        cache=cache, session=session, sleep=lambda _s: None, clock=lambda: CLOCK
    )


def test_a_workbook_is_fetched_once_and_read_from_cache_afterwards(tmp_path):
    cache = ParquetCache(tmp_path)
    session = _Session(lambda _u: _Response(200, OLE2))
    first = _library(session, cache)
    assert first.raw("shiller") == OLE2
    assert len(session.calls) == 1

    # A brand new library over the same cache, with a session that
    # fails the test if it is reached. This is the reviewer's position:
    # the saved pull and no network.
    second = _library(_RefusingSession(), cache)
    assert second.raw("shiller") == OLE2


def test_the_workbook_cache_key_carries_no_date(tmp_path):
    # An annual workbook keyed on today would be re-downloaded nightly
    # for no new information, which is rudeness with a schedule.
    cache = ParquetCache(tmp_path)
    _library(_Session(lambda _u: _Response(200, OLE2)), cache).raw("damodaran_returns")
    key = cache.key(
        "longhistory",
        "workbook",
        dataset="damodaran_returns",
        url=DATASETS["damodaran_returns"].url,
    )
    meta = cache.metadata(key)
    assert meta is not None
    assert set(meta["params"]) == {"dataset", "url"}


def test_refresh_goes_back_to_the_author(tmp_path):
    cache = ParquetCache(tmp_path)
    bodies = [OLE2, OLE2 + b" newer vintage"]
    session = _Session(
        lambda _u: _Response(200, bodies[min(len(session.calls) - 1, 1)])
    )
    library = _library(session, cache)
    assert library.raw("shiller") == OLE2
    assert library.raw("shiller", refresh=True).endswith(b"newer vintage")
    assert len(session.calls) == 2


def test_the_digest_identifies_the_vintage(tmp_path):
    import hashlib

    session = _Session(lambda _u: _Response(200, OLE2))
    library = _library(session, ParquetCache(tmp_path))
    assert library.digest("shiller") == hashlib.sha256(OLE2).hexdigest()


def test_an_error_page_served_as_200_is_an_outage_not_a_bad_file(tmp_path):
    cache = ParquetCache(tmp_path)
    html = b"<!DOCTYPE html><html><body>Service unavailable</body></html>"
    library = _library(_Session(lambda _u: _Response(200, html)), cache)
    with pytest.raises(LongHistoryUnavailable, match="not an Excel workbook"):
        library.raw("shiller")
    # And nothing was written. A cached error page would be read as a
    # workbook by every later run until somebody cleared the directory.
    assert cache.stats().entries == 0


def test_a_moved_file_is_a_404_and_never_a_silent_mirror(tmp_path):
    library = _library(_Session(lambda _u: _Response(404, b"")), ParquetCache(tmp_path))
    with pytest.raises(LongHistoryUnavailable, match="404"):
        library.raw("shiller")


def test_a_server_error_is_retried_and_then_raises(tmp_path):
    session = _Session(lambda _u: _Response(503, b""))
    library = _library(session, ParquetCache(tmp_path))
    with pytest.raises(LongHistoryUnavailable, match="unreachable after"):
        library.raw("shiller")
    assert len(session.calls) == lh.MAX_ATTEMPTS


def test_the_stale_yale_mirror_is_documented_and_never_wired_up():
    urls = {d.url for d in DATASETS.values()}
    assert lh.SHILLER_YALE_MIRROR not in urls
    assert lh.SHILLER_YALE_MIRROR_LAST_ROW == "2023-09"


# -- FRED -----------------------------------------------------------------


def _fake_observations(monkeypatch, table: dict[str, list[tuple[str, float]]]):
    def fake(series: str, start: date, end: date, *, timeout: int = 30):
        rows = table[series]
        return pd.DataFrame(
            {
                "date": pd.to_datetime([d for d, _ in rows]),
                "value": [v for _, v in rows],
            }
        )

    monkeypatch.setattr(lh, "fetch_observations", fake)


def test_fred_macro_is_long_form_so_a_late_start_is_not_a_nan(tmp_path, monkeypatch):
    _fake_observations(
        monkeypatch,
        {
            "USREC": [("1854-12-01", 1.0), ("1855-01-01", 1.0)],
            "UNRATE": [("1948-01-01", 3.4)],
        },
    )
    library = _library(_RefusingSession(), ParquetCache(tmp_path))
    frame = library.fred_macro(["USREC", "UNRATE"], end=date(2026, 6, 1))

    assert list(frame.columns) == ["series", "date", "value"]
    assert len(frame) == 3
    # 1854 has no unemployment row at all, rather than a NaN that could
    # equally mean "published as missing".
    assert not ((frame["series"] == "UNRATE") & (frame["date"].dt.year < 1948)).any()


def test_fred_macro_caches_on_the_day_it_asked_for(tmp_path, monkeypatch):
    calls: list[str] = []

    def fake(series: str, start: date, end: date, *, timeout: int = 30):
        calls.append(series)
        return pd.DataFrame({"date": pd.to_datetime(["1913-01-01"]), "value": [9.8]})

    monkeypatch.setattr(lh, "fetch_observations", fake)
    cache = ParquetCache(tmp_path)
    library = _library(_RefusingSession(), cache)
    library.fred_macro(["CPIAUCNS"], end=date(2026, 6, 1))
    library.fred_macro(["CPIAUCNS"], end=date(2026, 6, 1))
    assert calls == ["CPIAUCNS"]


def test_a_fred_outage_raises_and_caches_nothing(tmp_path, monkeypatch):
    def fake(series: str, start: date, end: date, *, timeout: int = 30):
        raise lh.TbillUnavailable("connection reset")

    monkeypatch.setattr(lh, "fetch_observations", fake)
    cache = ParquetCache(tmp_path)
    library = _library(_RefusingSession(), cache)
    with pytest.raises(LongHistoryUnavailable, match="not a statement about"):
        library.fred_macro(["USREC"], end=date(2026, 6, 1))
    assert cache.stats().entries == 0


# -- the honesty the module is for ---------------------------------------


def test_every_dataset_says_what_it_cannot_do():
    frame = catalogue()
    assert len(frame) == len(DATASETS)
    for dataset in DATASETS.values():
        assert dataset.survivorship.strip()
        assert dataset.redistribution.strip()
        assert dataset.can and dataset.cannot


def test_the_index_level_limit_is_stated_on_every_market_dataset():
    # The one sentence that has to survive every future edit: these
    # cannot be used to pick stocks. If somebody widens this module,
    # the claim has to be re-stated, not quietly dropped.
    for key in ("shiller", "damodaran_returns", "fred_macro"):
        cannot = " ".join(DATASETS[key].cannot).lower()
        assert "individual securities" in cannot


def test_usrec_is_labelled_as_retrospective():
    survivorship = DATASETS["fred_macro"].survivorship.lower()
    assert "retrospectiv" in survivorship
    assert "never be an input" in survivorship


def test_describe_prints_the_caveats_not_just_the_columns():
    text = LongHistory.describe("shiller")
    assert "monthly" in text
    assert "1871-01" in text
    assert "cannot:" in text


def test_long_history_unavailable_is_a_source_unavailable():
    # `audit.context` and every caller that already distinguishes an
    # outage from an empty result catches SourceUnavailable.
    assert issubclass(LongHistoryUnavailable, SourceUnavailable)


# -- the real files, when this machine has them --------------------------


def _warm(dataset: str) -> LongHistory | None:
    """A library over the real cache, or None when it is cold.

    `quant/data/` is gitignored, so these run on the machine that did
    the pull and skip everywhere else. That is the honest arrangement:
    a grid built by hand proves the parser handles the shape it was
    written for, and only the author's actual 2026 workbook proves the
    shape has not moved.
    """
    from griffinquant.data.cache import DEFAULT_ROOT

    cache = ParquetCache(DEFAULT_ROOT)
    key = cache.key(
        "longhistory", "workbook", dataset=dataset, url=DATASETS[dataset].url
    )
    if cache.metadata(key) is None:
        return None
    return LongHistory(cache=cache, session=_RefusingSession(), clock=lambda: CLOCK)


def test_the_real_shiller_workbook_still_parses():
    library = _warm("shiller")
    if library is None:
        pytest.skip("no cached Shiller workbook on this machine")
    frame = library.shiller()
    assert frame["date"].iloc[0] == pd.Timestamp("1871-01-01")
    assert len(frame) > 1_800
    # CAPE needs ten years of earnings behind it, so it starts exactly
    # a decade after the price series does.
    first_cape = frame.loc[frame["cape"].first_valid_index(), "date"]
    assert first_cape == pd.Timestamp("1881-01-01")


def test_the_real_damodaran_workbook_still_parses():
    library = _warm("damodaran_returns")
    if library is None:
        pytest.skip("no cached Damodaran workbook on this machine")
    frame = library.damodaran_returns()
    assert frame["year"].iloc[0] == 1928
    assert frame["sp500_return"].iloc[0] == pytest.approx(0.4381, abs=1e-3)
    assert frame["sp500_return"].min() < -0.35  # 2008 is in there


def test_the_two_compilations_still_agree_about_the_last_century():
    shiller = _warm("shiller")
    damodaran = _warm("damodaran_returns")
    if shiller is None or damodaran is None:
        pytest.skip("no cached workbooks on this machine")
    # A parser reading the wrong column would move a year by tens of
    # points. Twenty is far outside the 8.2-point worst case that the
    # two compilations' different December conventions produce.
    flagged = reconcile_annual_equity_return(
        shiller.shiller(), damodaran.damodaran_returns(), tolerance=0.20
    )
    assert flagged.empty, flagged.to_string()
