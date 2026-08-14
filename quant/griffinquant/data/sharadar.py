"""Sharadar Core US Equities, read through the Nasdaq Data Link
tables API.

This is the production source: TICKERS for the entity master, SEP for
daily bars, SF1 for fundamentals, ACTIONS for corporate events.
Nothing above this layer ever sees a vendor payload — every method
returns a frame that has been through `schema.validate`.

Two vendor facts shape the whole file, and both are traps.

SEP, SF1 and ACTIONS are keyed by the ticker STRING. Only TICKERS
carries `permaticker`, the identifier that survives a symbol change,
so every frame here is joined back through TICKERS before it is
handed out. Where a ticker string resolves to two permatickers it
cannot be attributed from the string alone, and those rows are
dropped and counted on `unresolved_rows` rather than guessed at — a
guess there splices two companies into one price series, and the
result backtests beautifully.

Prices come from two tables, not one. SEP is common stock and
EXCLUDES ETFs, CEFs and ETNs; those live in SHARADAR/SFP, which
Nasdaq sells apart from the Core US Equities bundle. TICKERS.table
names the one table each entity belongs to, which is the fact that
makes reading both and concatenating them safe — and `prices()`
asserts it rather than trusting it. Every sleeve this project trades
is an ETF and so is the SPY benchmark, so SFP is a requirement here
and not a garnish: a key that bought only the equities bundle gets a
403 on SFP while SEP answers perfectly, and the entire point of the
message that raises is that the failure reads nothing whatsoever
like "there is no ETF data".

And "adjusted" means three different things inside a single SEP row.
Per the SEP documentation: `closeadj` is adjusted for stock splits,
stock dividends, cash dividends and spinoffs — a total-return series,
and the only column safe for returns. `open`/`high`/`low`/`close`/
`volume` are adjusted for stock splits and stock dividends ONLY, not
for cash dividends or spinoffs. `closeunadj` is adjusted for nothing
at all. So the vendor publishes no as-traded open, high, low or
volume; what it publishes is enough to recover them exactly, which is
what `_split_factor` is for and why it carries the longest comment
here.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import replace
from datetime import date
from typing import TYPE_CHECKING, Any

import pandas as pd
import requests

from . import schema
from .base import DataSource, SourceCapabilities, SourceUnavailable

if TYPE_CHECKING:  # the cache module is owned elsewhere; see _via_cache
    from .cache import ParquetCache


API_BASE = "https://data.nasdaq.com/api/v3/datatables"
VENDOR = "SHARADAR"

#: The two end-of-day price tables, in the order they are read. SEP is
#: common stock; SFP is ETFs, CEFs, ETNs and exchange-traded debt. SEP
#: first is deliberate — when a key has bought neither, the refusal we
#: report should be about the table nearly every user has, and when it
#: has bought only the equities bundle we want SEP's success already in
#: hand before SFP's refusal is explained.
PRICE_TABLES = ("SEP", "SFP")

#: The half of that split the Core US Equities bundle does not include.
#: A set, because knowing which side of the line a refusal fell on is
#: the difference between "buy the add-on" and "check your key".
FUND_PRICE_TABLES = frozenset({"SFP"})

#: Which table a bar came from, carried through the concatenation and
#: dropped by `_typed` on the way out. Nothing above this file sees it;
#: it exists so the one-table-per-entity check has something to read.
_SOURCE_TABLE = "_price_table"

#: The API answers at most 10,000 rows per call whatever you ask for,
#: so pagination is not an optimisation — a single unpaged call to SEP
#: returns a truncated decade and says nothing about it.
PAGE_ROW_CAP = 10_000

#: 429 plus the 5xx range, matching the vendor's own client. Anything
#: else in the 4xx range is an answer, not a hiccup, and retrying it
#: just burns the rate limit that produced it.
RETRY_STATUSES = frozenset({429, *range(500, 512)})

MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 0.5
BACKOFF_CAP_SECONDS = 8.0

#: URLs have a length limit and the vendor has an undocumented cap on
#: how many values one filter accepts, so ticker filters go in chunks.
TICKER_CHUNK = 50

#: As-reported is the point-in-time answer; most-recent-reported
#: silently substitutes later restatements. Both are accepted here and
#: the audit is what objects to the second in a backtest.
VALID_DIMENSIONS = frozenset({"ARQ", "ARY", "ART", "MRQ", "MRY", "MRT"})

#: SF1 carries roughly 150 indicators. Asking for the twenty we map
#: keeps the pull to a fraction of the bytes; the names are the
#: vendor's own and a typo here is a 400, not a silent omission.
_SF1_COLUMNS = (
    "ticker",
    "dimension",
    "calendardate",
    "datekey",
    "reportperiod",
    "lastupdated",
    "revenue",
    "netinc",
    "equity",
    "assets",
    "liabilities",
    "ebitda",
    "ncfo",
    "capex",
    "sharesbas",
    "shareswa",
    "marketcap",
    "ev",
    "gp",
    "opinc",
    "debt",
    "cashneq",
)

#: Vendor column -> our column, for the fundamentals we carry. The
#: right-hand side is the schema's, the left-hand side is Sharadar's,
#: and they agree often enough that the pairs that DON'T agree are the
#: only ones worth reading.
_SF1_RENAME = {
    "calendardate": "period_end",
    "datekey": "date_public",
    "reportperiod": "report_period",
    "lastupdated": "last_updated",
}

#: Vendor columns without which the frame cannot be built honestly.
#: Named per table so the error says which vendor column vanished
#: rather than which of ours failed to appear.
_TICKERS_REQUIRED = (
    "permaticker",
    "ticker",
    "name",
    "exchange",
    "category",
    "isdelisted",
    "firstpricedate",
    "lastpricedate",
)
#: One tuple for both price tables, and that is a checked claim rather
#: than an assumption. SFP's own documentation page lists `ticker`,
#: `date` and `lastupdated` as its filter columns, uses
#: `open,high,low,close,volume,closeadj` in its column example, and
#: reprints the CloseAdj / CloseUnadj adjustment definitions word for
#: word from SEP's page — the two pages differ only in coverage prose
#: and worked examples. `_require` is still called per table, so if
#: that ever stops being true the error names SFP rather than blaming
#: a column of ours for failing to appear.
#: https://data.nasdaq.com/databases/SFP/documentation
_PRICE_REQUIRED = (
    "ticker",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "closeadj",
    "closeunadj",
)

#: Vendor column -> ours, for the price columns we take when offered.
#: Handled as a set rather than one at a time because they are kept
#: only where EVERY table that returned rows carried them. Neither
#: vendor page documents `dividends` at all, so whether SFP publishes
#: it is genuinely unverified — and a column that is real for stocks
#: and absent for funds concatenates into NaNs that read as "this ETF
#: paid nothing", which is a worse answer than no column.
_PRICE_OPTIONAL = {"dividends": "dividends", "lastupdated": "last_updated"}

#: TICKERS columns we pass through when present. Absent ones are left
#: out of the frame entirely rather than filled with nulls — the
#: schema marks them optional so that "the vendor stopped publishing
#: this" and "every row happens to be blank" stay distinguishable.
_TICKERS_OPTIONAL = {
    "sic_code": "siccode",
    "sector": "sector",
    "industry": "industry",
    "currency": "currency",
    "location": "location",
    "related_tickers": "relatedtickers",
    "cusips": "cusips",
    "scale_marketcap": "scalemarketcap",
}


class SharadarApiError(RuntimeError):
    """The API answered, and the answer was that our request was wrong.

    Kept apart from `SourceUnavailable` on purpose. A 404 on a table
    code or a rejected filter is a bug in this file that a retry will
    reproduce forever; an outage or a throttle is a fact about the
    afternoon.
    """


class SharadarNotEntitled(SourceUnavailable):
    """The key is fine. This table is not part of what it bought.

    A subtype rather than a message, because the caller a level up has
    to be able to ask *which* table was refused while the rest of the
    pull was succeeding. Sharadar sells prices as two products, and the
    interesting failure is the partial one.
    """

    def __init__(self, message: str, *, table: str, status: int) -> None:
        super().__init__(message)
        self.table = table
        self.status = status


class SharadarSource(DataSource):
    capabilities = SourceCapabilities(
        name="Sharadar (Nasdaq Data Link)",
        # The vendor documents delisted coverage explicitly: TICKERS
        # carries `isdelisted` and dead names keep their history.
        claims_survivorship_free=True,
        # SF1.datekey is the filing date for the as-reported
        # dimensions, which is the whole reason to buy this dataset.
        provides_filing_dates=True,
        provides_as_reported=True,
        # `lastpricedate` on a delisted row is the day it stopped
        # trading, and ACTIONS carries the dated event as well.
        provides_delisting_dates=True,
        # ACTIONS has an `action` column whose vocabulary may separate
        # a merger from a liquidation, but the vendor's published
        # documentation does not enumerate it where we could read it.
        # Claiming the capability would let the delisting-reason check
        # run and report a pass on evidence nobody has seen; declining
        # it makes that check say UNPROVABLE, which is the truth. SFP's
        # page is a shade worse than unenumerated: where SEP's lists
        # "delist reasons" among the actions it describes, SFP's does
        # not mention them at all.
        provides_delisting_reasons=False,
        provides_permanent_ids=True,
        # Sharadar does sell historical S&P 500 membership as its own
        # table. This adapter does not read it, and a capability is
        # read as "a check may proceed" — so it stays false until
        # something here actually returns constituents.
        provides_index_membership=False,
        # closeunadj is published directly; the rest of the as-traded
        # bar is recovered exactly from it. See `_split_factor`.
        provides_unadjusted_prices=True,
        is_smoke_test_only=False,
    )

    def __init__(
        self,
        *,
        api_key: str | None = None,
        cache: "ParquetCache | None" = None,
        # Both price tables by default, because a default of SEP alone
        # cannot return a single ETF bar and every sleeve in this
        # project is an ETF. Still an argument: a caller doing
        # single-name work can narrow it and skip a product they have
        # not bought, and saying so explicitly is much better than
        # discovering it through a 403.
        tables: Sequence[str] = PRICE_TABLES,
        session: requests.Session | None = None,
        timeout: float = 60.0,
        max_pages: int = 20_000,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._api_key = api_key or _api_key_from_env()
        self._cache = cache
        self._tables = tuple(tables)
        self._session = session or requests.Session()
        self._timeout = timeout
        self._max_pages = max_pages
        self._sleep = sleep

        # Running tallies, cumulative over the life of the instance.
        # A drop that nobody can count is a drop nobody will find.
        self.unresolved_rows: int = 0
        self.unresolved_by_frame: dict[str, int] = {}
        self.unadjustable_rows: int = 0
        self.collapsed_rows: dict[str, int] = {}
        #: Optional column -> the tables that actually published it,
        #: for the columns we then withheld because the others did not.
        self.partial_columns: dict[str, tuple[str, ...]] = {}

        self._master: pd.DataFrame | None = None
        self._ticker_to_permaticker: pd.Series | None = None
        self._ambiguous_tickers: frozenset[str] = frozenset()
        #: Which of `self._tables` the master actually has entities in,
        #: and which table each entity belongs to. None in both cases
        #: means TICKERS did not tell us, not that the answer is empty.
        self._tables_present: frozenset[str] | None = None
        self._entity_tables: dict[int, str] | None = None

        # A source that cannot price a fund is not a lesser Sharadar,
        # it is a source that cannot answer the question the sleeve
        # layer asks. There is no capability flag for it and inventing
        # one would mean amending the contract every source signs, so
        # it goes in the name — the one string every report prints.
        if not self.serves_fund_prices:
            declared = type(self).capabilities
            self.capabilities = replace(
                declared,
                name=(
                    f"{declared.name} [{'+'.join(self._tables) or 'no price tables'} "
                    "only — no fund prices, cannot price ETF sleeves]"
                ),
            )

    @property
    def serves_fund_prices(self) -> bool:
        """Whether this source can return a bar for an ETF at all."""
        return bool(FUND_PRICE_TABLES.intersection(self._tables))

    # -- the four frames ------------------------------------------------

    def security_master(self) -> pd.DataFrame:
        if self._master is not None:
            return self._master

        # No filter on the pull. `table` is very likely filterable, but
        # TICKERS is a handful of pages and a filter we assumed wrongly
        # would either 400 or, far worse, quietly return a subset we
        # would then report as the whole market.
        raw = self._pull_cached("TICKERS", {})
        if raw.empty:
            return self._check(schema.SECURITY_MASTER.empty(), schema.SECURITY_MASTER)
        _require(raw, _TICKERS_REQUIRED, "TICKERS")

        # TICKERS holds one row per (table, ticker) pair, so a company
        # that has both prices and fundamentals appears twice with the
        # same permaticker. Filtering to the price tables we actually
        # pull keeps the master lined up with `prices()` — a master
        # listing entities we never fetch bars for reads downstream as
        # a coverage hole rather than as a decision made here.
        if "table" in raw.columns:
            raw = raw.loc[raw["table"].isin(self._tables)]
            rank = raw["table"].map({t: i for i, t in enumerate(self._tables)})
            self._tables_present = frozenset(raw["table"].dropna().unique().tolist())
        else:
            rank = pd.Series(0, index=raw.index)

        # An entity with no id cannot be keyed, joined or audited, so
        # it is not an entity as far as this file is concerned.
        keep = raw.assign(
            permaticker=pd.to_numeric(raw["permaticker"], errors="coerce"),
            _rank=rank,
            _last=_to_dt(raw["lastpricedate"]),
        ).dropna(subset=["permaticker"])
        keep = keep.sort_values(
            ["permaticker", "_rank", "_last"], ascending=[True, True, False]
        ).drop_duplicates(subset=["permaticker"], keep="first")

        # Where an entity's bars live. Not a schema column — it is a
        # fact about the vendor's plumbing, not about the security —
        # but it is what lets a ticker filter go to the one table that
        # can answer it instead of to both.
        if "table" in keep.columns:
            self._entity_tables = dict(
                zip(
                    keep["permaticker"].astype("int64").tolist(),
                    keep["table"].astype("str").tolist(),
                )
            )

        cols: dict[str, pd.Series] = {
            "permaticker": keep["permaticker"],
            "ticker": keep["ticker"],
            "name": keep["name"],
            "exchange": keep["exchange"],
            "category": keep["category"],
            # 'Y' / 'N'. Anything else — including a null — is not an
            # assertion that the name is dead, so it reads False.
            "is_delisted": keep["isdelisted"].astype("str").str.upper().eq("Y"),
            "first_price_date": keep["firstpricedate"],
            "last_price_date": keep["lastpricedate"],
        }
        for ours, theirs in _TICKERS_OPTIONAL.items():
            if theirs in keep.columns:
                cols[ours] = keep[theirs]
        # `delisted_from` has no Sharadar column. TICKERS.exchange on a
        # dead row is the venue it last traded on, which is nearly the
        # same thing and not the same thing; the schema makes the
        # column optional so we leave it absent rather than infer it.

        out = _typed(pd.DataFrame(cols), schema.SECURITY_MASTER)
        out = out.sort_values("permaticker")
        self._master = self._check(out.reset_index(drop=True), schema.SECURITY_MASTER)
        return self._master

    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        # Materialise once. The selection is read twice — to build the
        # ticker filter and again to hold the answer to it — and a
        # generator read twice is empty the second time, which here
        # would drop every row and look like a market with no prices.
        wanted = None if permatickers is None else [int(p) for p in permatickers]

        params = {"date.gte": start.isoformat(), "date.lte": end.isoformat()}

        frames: list[pd.DataFrame] = []
        carried: dict[str, set[str]] = {}
        served: list[str] = []
        for table in self._populated_price_tables():
            raw, answered = self._pull_prices(table, params, wanted, served)
            if answered:
                served.append(table)
            if raw.empty:
                continue
            _require(raw, _PRICE_REQUIRED, table)
            carried[table] = {c for c in _PRICE_OPTIONAL if c in raw.columns}
            frames.append(self._bars(raw, table))

        if not frames:
            return self._check(schema.PRICES.empty(), schema.PRICES)

        out = pd.concat(frames, ignore_index=True)
        out = self._align_optional(out, carried)
        out = self._attach_permaticker(out, "prices")
        self._one_price_table_per_entity(out)
        out = _typed(out, schema.PRICES)
        # Re-apply everything we asked the API for. A filter that did
        # not mean what we thought it meant is the failure that leaves
        # no trace, and bounding twice costs nothing.
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        out = _restrict(out, wanted)
        out = self._collapse(out, ["permaticker", "date"], "last_updated", "prices")
        out = out.sort_values(["permaticker", "date"]).reset_index(drop=True)
        return self._check(out, schema.PRICES)

    def actions(self, start: date, end: date) -> pd.DataFrame:
        params = {"date.gte": start.isoformat(), "date.lte": end.isoformat()}
        raw = self._pull_cached("ACTIONS", params)
        if raw.empty:
            return self._check(schema.ACTIONS.empty(), schema.ACTIONS)

        _require(raw, ("date", "action", "ticker"), "ACTIONS")
        cols: dict[str, pd.Series] = {
            "date": raw["date"],
            "action": raw["action"],
            "ticker": raw["ticker"],
        }
        if "name" in raw.columns:
            cols["name"] = raw["name"]
        if "value" in raw.columns:
            # For a split this is the ratio, for a dividend the amount
            # per share. One column, two units, decided by `action` —
            # read them together or not at all.
            cols["value"] = _num(raw["value"])
        if "contraticker" in raw.columns:
            cols["contra_ticker"] = raw["contraticker"]
        out = pd.DataFrame(cols)
        # No `reason`: see the capabilities block. The `action` string
        # itself may carry it, but we have not read an enumeration of
        # that vocabulary from the vendor, and inventing one here would
        # turn a guess into a column the audit treats as evidence.

        # Dropping an unresolvable action costs us the record of a
        # delisting whose entity we cannot name, which is a real loss.
        # We take it because an action filed against the wrong
        # permaticker is worse than one we never saw: the first
        # rewrites a live company's history, the second only shortens
        # a list, and the count below says how often it happened.
        out = self._attach_permaticker(out, "actions")
        out = _typed(out, schema.ACTIONS)
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        out = out.sort_values(["date", "ticker", "action"]).reset_index(drop=True)
        return self._check(out, schema.ACTIONS)

    def fundamentals(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
        dimension: str = "ARQ",
    ) -> pd.DataFrame:
        if dimension not in VALID_DIMENSIONS:
            # A misspelled dimension is accepted by the API as a filter
            # that matches nothing, and an empty frame reads as "this
            # company files nothing" rather than as a typo.
            raise ValueError(
                f"unknown SF1 dimension {dimension!r}; "
                f"expected one of {sorted(VALID_DIMENSIONS)}"
            )

        wanted = None if permatickers is None else [int(p) for p in permatickers]

        # datekey, never calendardate. Bounding the period end pulls
        # filings that had not been published on the day being
        # simulated, which is the whole lookahead bug in one filter.
        params = {
            "dimension": dimension,
            "datekey.gte": start.isoformat(),
            "datekey.lte": end.isoformat(),
            "qopts.columns": ",".join(_SF1_COLUMNS),
        }
        raw = self._pull_by_ticker("SF1", params, wanted)
        if raw.empty:
            return self._check(schema.FUNDAMENTALS.empty(), schema.FUNDAMENTALS)

        _require(raw, ("ticker", "dimension", "datekey", "calendardate"), "SF1")
        cols = {"ticker": raw["ticker"], "dimension": raw["dimension"]}
        for vendor in _SF1_COLUMNS:
            if vendor in ("ticker", "dimension") or vendor not in raw.columns:
                continue
            cols[_SF1_RENAME.get(vendor, vendor)] = raw[vendor]
        out = pd.DataFrame(cols)

        # `period_end` takes calendardate — the quarter end normalised
        # to 31 Mar / 30 Jun / 30 Sep / 31 Dec — and `report_period`
        # keeps the filer's actual fiscal close. The two differ for
        # anyone off the calendar year (Walmart closes 31 January and
        # is filed under the preceding 31 December), and the normalised
        # date always sits EARLIER, so any lag computed against it
        # overstates how long the market waited. Overstating the wait
        # is the safe direction; understating it is a leak.

        out = self._attach_permaticker(out, "fundamentals")
        out = _typed(out, schema.FUNDAMENTALS)
        out = out.loc[
            out["date_public"].between(pd.Timestamp(start), pd.Timestamp(end))
        ]
        out = _restrict(out, wanted)

        # A delinquent filer catches up by publishing several quarters
        # on one day, so (permaticker, dimension, datekey) is not
        # unique in SF1 even though the schema keys on it. Keeping the
        # newest period is the point-in-time answer — it is what a
        # reader knew that evening — and the collapsed count is on the
        # instance so a spike is visible rather than inferred.
        out = self._collapse(
            out,
            ["permaticker", "dimension", "date_public"],
            "period_end",
            "fundamentals",
        )
        out = out.sort_values(
            ["permaticker", "date_public", "period_end"]
        ).reset_index(drop=True)
        return self._check(out, schema.FUNDAMENTALS)

    # -- prices, read across both tables --------------------------------

    def _populated_price_tables(self) -> tuple[str, ...]:
        """The configured price tables the master has entities in.

        A pull against a table holding none of our entities can only
        return rows the join would drop, and it costs the whole table
        to find that out. Where TICKERS carries no `table` column we
        cannot know which is which, and pulling all of them is then the
        only honest answer — a skip on a guess would look exactly like
        a vendor with no funds in it.
        """
        self.security_master()
        present = self._tables_present
        if present is None:
            return self._tables
        return tuple(t for t in self._tables if t in present)

    def _pull_prices(
        self,
        table: str,
        params: dict[str, str],
        wanted: Sequence[int] | None,
        served: Sequence[str],
    ) -> tuple[pd.DataFrame, bool]:
        """One table's rows, and whether the table actually answered.

        The second half of that is not bookkeeping. `served` is the
        evidence the fund-price receipt cites — SEP answered in the
        same call, so your key is fine, so what you are missing is a
        product — and a table nobody asked has corroborated nothing. A
        request for one ETF is the ordinary case here and it is exactly
        the case where SEP holds none of the wanted entities and is
        skipped without a round trip, so the unqualified version of
        that sentence is at its most confident precisely when it is
        least entitled to be. A dead key would then read as an unbought
        add-on.
        """
        if wanted is not None and not self._tickers_for(wanted, table):
            return pd.DataFrame(), False
        try:
            return self._pull_by_ticker(table, params, wanted, home_table=table), True
        except SharadarNotEntitled as refusal:
            if refusal.table not in FUND_PRICE_TABLES:
                raise
            raise _unbought_fund_prices(refusal, served) from refusal

    def _bars(self, raw: pd.DataFrame, table: str) -> pd.DataFrame:
        """One table's rows, in our columns, tagged with their origin."""
        close = _num(raw["close"])
        close_unadj = _num(raw["closeunadj"])
        factor = _split_factor(close, close_unadj)
        self.unadjustable_rows += int((factor.isna() & close.notna()).sum())

        cols: dict[str, pd.Series] = {
            "ticker": raw["ticker"],
            "date": raw["date"],
            "open_unadj": _num(raw["open"]) / factor,
            "high_unadj": _num(raw["high"]) / factor,
            "low_unadj": _num(raw["low"]) / factor,
            "close_unadj": close_unadj,
            # Volume moves the other way: a 2-for-1 split doubles the
            # historical share count in the adjusted series, so the
            # as-traded figure is the adjusted one scaled BY the factor
            # rather than divided by it.
            "volume_unadj": _num(raw["volume"]) * factor,
            "close_adj": _num(raw["closeadj"]),
            "split_factor": factor,
        }
        if "dividends" in raw.columns:
            # The vendor does not say which basis `dividends` is quoted
            # on. It sits in a row of split-adjusted columns, so it is
            # passed through on the conservative assumption that it
            # shares their basis — which means nothing should compute a
            # yield against `close_unadj` from it without first looking
            # at a name that has split since.
            cols["dividends"] = _num(raw["dividends"])
        if "lastupdated" in raw.columns:
            cols["last_updated"] = raw["lastupdated"]

        frame = pd.DataFrame(cols)
        frame[_SOURCE_TABLE] = table
        return frame

    def _align_optional(
        self, df: pd.DataFrame, carried: dict[str, set[str]]
    ) -> pd.DataFrame:
        """Withhold an optional column only one of the tables published.

        Concatenation fills the gap with nulls, and a null in
        `dividends` is indistinguishable from a fund that paid nothing.
        Dropping the column says "we do not have this" once, loudly,
        instead of saying "zero" a million times; `partial_columns`
        keeps the names of the tables that did publish it, so the loss
        is countable rather than folklore.
        """
        if len(carried) < 2:
            return df
        for vendor, ours in _PRICE_OPTIONAL.items():
            have = tuple(t for t, cols in carried.items() if vendor in cols)
            if have and len(have) < len(carried) and ours in df.columns:
                self.partial_columns[ours] = have
                df = df.drop(columns=[ours])
        return df

    def _one_price_table_per_entity(self, df: pd.DataFrame) -> None:
        """Hold the vendor to the rule the concatenation depends on.

        TICKERS puts every security in exactly one price table, which
        is the only reason SEP and SFP can be stacked without checking
        for collisions row by row. If that ever stopped being true the
        schema would catch it a few lines later as a duplicate
        (permaticker, date) — and say nothing about which two rows, or
        why, or that two products had both priced one security. One
        hash pass over a frame we have just spent minutes downloading
        is a cheap price for an error that names the entity.

        Note this is a check on ENTITIES, not on symbols. A dead
        company's ticker being reissued to an ETF puts the same string
        in both tables legitimately; the permaticker is what says
        whether it is the same security, and the ambiguous-ticker drop
        already handles the string.
        """
        if len(self._tables) < 2 or df.empty:
            return
        pairs = df[["permaticker", _SOURCE_TABLE]].drop_duplicates()
        doubled = pairs["permaticker"].duplicated()
        if not bool(doubled.any()):
            return
        offenders = sorted({int(p) for p in pairs.loc[doubled, "permaticker"]})
        shown = ", ".join(str(p) for p in offenders[:5])
        raise SharadarApiError(
            f"{len(offenders):,} entity(ies) were priced by more than one of "
            f"{list(self._tables)} over this range — permaticker {shown}"
            f"{' and others' if len(offenders) > 5 else ''}. A security "
            "belongs to exactly one price table, so this is a vendor "
            "contradiction and not a duplicate to be collapsed: nothing "
            "here can say which of the two bars is the real one."
        )

    # -- permaticker resolution -----------------------------------------

    def _attach_permaticker(self, df: pd.DataFrame, frame: str) -> pd.DataFrame:
        """Put the entity id on a frame the vendor keyed by symbol."""
        mapping = self._ticker_map()
        resolved = df["ticker"].map(mapping)
        missing = resolved.isna()
        dropped = int(missing.sum())
        if dropped:
            self.unresolved_rows += dropped
            self.unresolved_by_frame[frame] = (
                self.unresolved_by_frame.get(frame, 0) + dropped
            )
        kept = df.loc[~missing].copy()
        kept["permaticker"] = resolved.loc[~missing].astype("int64")
        return kept

    def _ticker_map(self) -> pd.Series:
        if self._ticker_to_permaticker is not None:
            return self._ticker_to_permaticker

        master = self.security_master()
        pairs = master[["ticker", "permaticker"]].dropna()
        counts = pairs.groupby("ticker")["permaticker"].nunique()
        ambiguous = counts.index[counts > 1]
        self._ambiguous_tickers = frozenset(ambiguous.tolist())

        # A symbol two entities have both worn cannot be attributed
        # from the symbol. Excluding it here is what turns the
        # recycling bug into a visible drop count downstream.
        usable = pairs.loc[~pairs["ticker"].isin(self._ambiguous_tickers)]
        usable = usable.drop_duplicates(subset=["ticker"])
        self._ticker_to_permaticker = pd.Series(
            usable["permaticker"].to_numpy(),
            index=pd.Index(usable["ticker"].to_numpy(), name="ticker"),
        )
        return self._ticker_to_permaticker

    @property
    def ambiguous_tickers(self) -> frozenset[str]:
        """Symbols worn by more than one entity in this master."""
        self._ticker_map()
        return self._ambiguous_tickers

    def _tickers_for(
        self, permatickers: Sequence[int], home_table: str | None = None
    ) -> list[str]:
        wanted = {int(p) for p in permatickers}
        master = self.security_master()
        hit = master.loc[master["permaticker"].isin(wanted)]
        if home_table is not None and self._entity_tables:
            # Asking SEP for three thousand ETF symbols is not wrong so
            # much as expensive: at fifty tickers a request it is sixty
            # paginated round trips against a rate limit, spent being
            # told what TICKERS had already said. SF1 passes no home
            # table and is therefore never narrowed this way.
            hit = hit.loc[hit["permaticker"].map(self._entity_tables).eq(home_table)]
        return sorted(hit["ticker"].dropna().tolist())

    # -- HTTP -----------------------------------------------------------

    def _pull_by_ticker(
        self,
        table: str,
        params: dict[str, str],
        permatickers: Sequence[int] | None,
        *,
        home_table: str | None = None,
    ) -> pd.DataFrame:
        if permatickers is None:
            return self._pull_cached(table, params)

        tickers = self._tickers_for(permatickers, home_table)
        if not tickers:
            # An explicit empty selection is a request for nothing, not
            # a request for everything. Getting this backwards pulls
            # the entire panel and looks like a slow network. The same
            # holds when none of the requested entities live in this
            # table — a fund table with no funds asked of it.
            return pd.DataFrame()

        pages = [
            self._pull_cached(
                table, {**params, "ticker": ",".join(tickers[i : i + TICKER_CHUNK])}
            )
            for i in range(0, len(tickers), TICKER_CHUNK)
        ]
        pages = [p for p in pages if not p.empty]
        if not pages:
            return pd.DataFrame()
        return pd.concat(pages, ignore_index=True)

    def _pull_cached(self, table: str, params: dict[str, str]) -> pd.DataFrame:
        if self._cache is None:
            return self._pull(table, params)
        key = _cache_key(table, params)
        return self._via_cache(key, lambda: self._pull(table, params))

    def _via_cache(
        self, key: str, build: Callable[[], pd.DataFrame]
    ) -> pd.DataFrame:
        """Read through whichever surface the injected cache exposes.

        The cache lives in a module this file does not own, so rather
        than hard-code one method name and turn a naming mismatch into
        an AttributeError halfway through an audit, we probe the few
        shapes it could plausibly have and fall through to a live pull.
        A cache that cannot be reached should cost time, never data.
        """
        cache = self._cache
        one_shot = getattr(cache, "get_or_fetch", None)
        if callable(one_shot):
            return one_shot(key, build)
        for read_name, write_name in (("read", "write"), ("get", "put"), ("load", "save")):
            read = getattr(cache, read_name, None)
            write = getattr(cache, write_name, None)
            if callable(read) and callable(write):
                hit = read(key)
                if hit is not None:
                    return hit
                built = build()
                write(key, built)
                return built
        return build()

    def _pull(self, table: str, params: dict[str, str]) -> pd.DataFrame:
        """Walk the cursor to the end and hand back one frame."""
        frames: list[pd.DataFrame] = []
        cursor: str | None = None
        pages = 0

        while True:
            query = dict(params)
            if cursor:
                query["qopts.cursor_id"] = cursor
            body = self._get(table, query)

            payload = body.get("datatable") or {}
            names = [c["name"] for c in payload.get("columns") or []]
            frames.append(pd.DataFrame(payload.get("data") or [], columns=names))

            pages += 1
            cursor = (body.get("meta") or {}).get("next_cursor_id")
            if not cursor:
                break
            if pages >= self._max_pages:
                # Not a cap on legitimate pulls — SEP over twenty years
                # is thousands of pages. It is a stop on a cursor that
                # has started handing back its own predecessor.
                raise SharadarApiError(
                    f"{table}: cursor still open after {pages:,} pages "
                    f"({pages * PAGE_ROW_CAP:,} rows); refusing to keep going"
                )

        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)

    def _get(self, table: str, params: dict[str, str]) -> dict[str, Any]:
        url = f"{API_BASE}/{VENDOR}/{table}.json"
        query = {**params, "api_key": self._api_key}
        last_reason = "no attempt was made"

        for attempt in range(MAX_ATTEMPTS):
            if attempt:
                # Deterministic backoff, no jitter. One process, one
                # key, sequential calls — jitter would buy nothing and
                # cost a reproducible transcript of what we did.
                self._sleep(
                    min(BACKOFF_BASE_SECONDS * 2 ** (attempt - 1), BACKOFF_CAP_SECONDS)
                )
            try:
                response = self._session.get(url, params=query, timeout=self._timeout)
            except requests.RequestException as exc:
                last_reason = f"{type(exc).__name__}: {exc}"
                continue

            if response.status_code == 200:
                return response.json()

            detail = _vendor_error(response)
            if response.status_code == 429:
                last_reason = f"throttled by Nasdaq Data Link (429) — {detail}"
                continue
            if response.status_code in RETRY_STATUSES:
                last_reason = f"HTTP {response.status_code} — {detail}"
                continue

            # Everything below is an answer. Asking again returns it
            # again, more slowly, against the same rate limit.
            if response.status_code in (401, 403):
                raise SharadarNotEntitled(
                    f"Nasdaq Data Link refused the key for SHARADAR/{table} "
                    f"(HTTP {response.status_code}) — {detail}. This is a "
                    "credentials or subscription problem, not an empty result.",
                    table=table,
                    status=response.status_code,
                )
            if response.status_code == 404:
                raise SharadarApiError(
                    f"SHARADAR/{table} does not exist (404) — {detail}"
                )
            if detail.startswith("QEA"):
                raise SourceUnavailable(
                    f"Nasdaq Data Link did not recognise the API key — {detail}. "
                    "Set NASDAQ_DATA_LINK_API_KEY; an unrecognised key returns "
                    "nothing, which is not the same as there being nothing."
                )
            raise SharadarApiError(
                f"SHARADAR/{table} rejected the request "
                f"(HTTP {response.status_code}) — {detail}. Params: "
                f"{sorted(params)}"
            )

        raise SourceUnavailable(
            f"SHARADAR/{table} unreachable after {MAX_ATTEMPTS} attempts. "
            f"Last: {last_reason}. No rows were returned and none were "
            "claimed — do not read this as an empty range."
        )

    # -- shared frame surgery -------------------------------------------

    def _collapse(
        self,
        df: pd.DataFrame,
        keys: list[str],
        newest_by: str,
        frame: str,
    ) -> pd.DataFrame:
        """Keep one row per key, the freshest, and say how many went.

        Duplicates here are not corruption — they are two ticker
        strings that resolved to one entity, or one filing day that
        carried several periods. Either way the schema keys on the
        survivor, and a collapse nobody counted is a collapse nobody
        will question.
        """
        dupes = int(df.duplicated(subset=keys).sum())
        if not dupes:
            return df
        self.collapsed_rows[frame] = self.collapsed_rows.get(frame, 0) + dupes
        order = keys + ([newest_by] if newest_by in df.columns else [])
        ordered = df.sort_values(order, na_position="first")
        return ordered.drop_duplicates(subset=keys, keep="last")


# -- module helpers -----------------------------------------------------


def _api_key_from_env() -> str:
    """Find the key, or say precisely which absence we are reporting."""
    for var in ("NASDAQ_DATA_LINK_API_KEY", "QUANDL_API_KEY"):
        value = os.environ.get(var, "").strip()
        if value:
            return value
    raise SourceUnavailable(
        "Sharadar is not configured: neither NASDAQ_DATA_LINK_API_KEY nor "
        "QUANDL_API_KEY is set in the environment. This is a missing key, "
        "NOT an empty result — an unconfigured source and a range with no "
        "rows in it look identical one layer down and mean opposite things."
    )


def _unbought_fund_prices(
    refusal: SharadarNotEntitled, served: Sequence[str]
) -> SourceUnavailable:
    """Say which PRODUCT is missing, not just which call failed.

    This is the message the whole two-table split exists to get right.
    Sharadar sells stock prices and fund prices separately, so the
    ordinary way to arrive here is with a perfectly good key that
    bought the equities bundle — SEP answers, SFP does not, and the
    ETFs simply are not there. Left to the generic wording that is a
    403 on a table nobody has heard of, which reads as our bug or as
    an empty vendor, and costs somebody a day of reading this file
    before they think to check what was purchased. It is a receipt,
    and it should say so.
    """
    others = ", ".join(f"SHARADAR/{t}" for t in served)
    corroboration = (
        f"{others} answered normally in the same call, so the key itself "
        "is fine and this is a product you have not bought"
        if served
        else "No other price table was read first, so check the key as well "
        "— but a key that works everywhere else and fails here is a "
        "product you have not bought"
    )
    return SourceUnavailable(
        f"SHARADAR/{refusal.table} refused the key (HTTP {refusal.status}). "
        f"{corroboration}. SFP — ETFs, closed-end funds and ETNs — is sold "
        "as its own Nasdaq Data Link product; the Core US Equities bundle "
        "(SEP, SF1, ACTIONS, TICKERS) does NOT include fund prices, and SEP "
        "excludes funds by design rather than by omission. So this is NOT "
        "'there is no ETF data': every sleeve in this project and the SPY "
        "benchmark price out of SFP and nowhere else, and none of them can "
        "be backtested until the fund-price product is on the key. Buy it, "
        'or pass tables=("SEP",) to state out loud that this run is '
        "single-name equities only — that source can never return an ETF "
        f"bar. Vendor said: {refusal}"
    )


def _cache_key(table: str, params: dict[str, str]) -> str:
    """A stable name for one query, with no clock in it."""
    canonical = json.dumps(
        {k: v for k, v in sorted(params.items()) if k != "api_key"},
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]
    return f"sharadar/{table.lower()}/{digest}"


def _vendor_error(response: requests.Response) -> str:
    """Pull the QExxNN code out of the body, or fall back to the text."""
    try:
        payload = response.json()
    except ValueError:
        return (response.text or "").strip()[:200] or "no body"
    err = payload.get("quandl_error") or payload.get("datalink_error") or {}
    code = err.get("code", "")
    message = err.get("message", "")
    return f"{code} {message}".strip() or str(payload)[:200]


def _require(df: pd.DataFrame, columns: Sequence[str], table: str) -> None:
    """A vendor column that quietly disappeared must not become NaN.

    Filling an absent column with nulls produces a frame that passes
    every dtype check and says nothing true, which is the exact shape
    of the failures this repository is built to catch.
    """
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise SharadarApiError(
            f"SHARADAR/{table} returned no {missing} column(s). "
            f"Got: {sorted(df.columns)}"
        )


def _restrict(df: pd.DataFrame, permatickers: Sequence[int] | None) -> pd.DataFrame:
    """Hold the API to the selection we sent it.

    We narrow by ticker string because that is the only key SEP and
    SF1 accept, and one ticker string can carry rows the caller never
    asked for. The last word on which entities were requested belongs
    here, after the join, where entities exist.
    """
    if permatickers is None:
        return df
    wanted = {int(p) for p in permatickers}
    return df.loc[df["permaticker"].isin(wanted)]


def _num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce").astype("float64")


def _to_dt(series: pd.Series) -> pd.Series:
    # utc=True then strip the zone: Sharadar sends bare dates, but a
    # single zoned value in a page would otherwise raise on the mix.
    parsed = pd.to_datetime(series, errors="coerce", utc=True)
    return parsed.dt.tz_localize(None).astype("datetime64[ns]")


def _split_factor(close: pd.Series, close_unadj: pd.Series) -> pd.Series:
    """The split-and-stock-dividend factor sitting inside one SEP row.

    `close` is adjusted for splits and stock dividends and nothing
    else; `closeunadj` is adjusted for nothing. Their ratio on a given
    day is therefore exactly the cumulative split adjustment applied
    to that day's bar — cash dividends and spinoffs cancel because
    neither column carries them. That is what makes the as-traded
    open, high, low and volume recoverable at all.

    It is a derivation and not a vendor column, so it inherits the
    rounding of two published prices: a part in ten thousand on a
    five-dollar name at four decimals, which no screen in this
    repository can feel. Where `closeunadj` is missing or non-positive
    the factor is undefined, and the columns built on it come back
    NaN rather than silently assuming no split ever happened — that
    assumption is the one that would pass a $5 floor with a $2 stock.
    """
    factor = close / close_unadj
    return factor.where((close_unadj > 0) & (factor > 0)).astype("float64")


def _typed(df: pd.DataFrame, spec: schema.FrameSpec) -> pd.DataFrame:
    """Coerce to the spec's dtypes, keeping only columns it names.

    Anything the spec does not name is dropped here rather than
    carried along: a vendor column riding into the rest of the system
    under its own name is how a second, unvalidated schema starts.
    """
    wanted = {**spec.required, **spec.optional}
    built: dict[str, pd.Series] = {}
    for column, dtype in wanted.items():
        if column not in df.columns:
            continue
        built[column] = _cast(df[column], dtype)
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out


def _cast(series: pd.Series, dtype: str) -> pd.Series:
    if dtype.startswith("datetime64"):
        return _to_dt(series)
    if dtype == "float64":
        return pd.to_numeric(series, errors="coerce").astype("float64")
    if dtype == "Int64":
        return pd.to_numeric(series, errors="coerce").astype("Int64")
    if dtype == "int64":
        return pd.to_numeric(series, errors="coerce").astype("int64")
    if dtype == "bool":
        return series.astype("bool")
    return series.astype("str")
