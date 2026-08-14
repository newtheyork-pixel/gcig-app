"""One command that refreshes every free source, politely and resumably.

Six acquisition modules, ten sources, eight servers belonging to people
who owe us nothing. Running them by hand means remembering which needs a
key, which meters symbols rather than requests, which quarter the SEC's
bulk archive starts at, and which one will refuse the third call in a
minute. This is that memory, written down and executable.

**Interrupting it is safe and re-running it is cheap.** Every pull goes
through `ParquetCache`, which writes the frame and its sidecar to temp
names and renames them into place with the sidecar last — so a process
killed mid-write leaves a miss rather than a truncated frame that reads
as a short one. Nothing already on disk is fetched again. That is not a
convenience: the ETF universe takes about an hour and a half against a
free tier that meters SYMBOLS rather than requests, and the only thing
that makes a second attempt bearable is that it costs nothing for what
we already hold.

**A failure in one source never touches another.** Each task is wrapped,
timed, and reported with what actually came back, and the run continues.
The alternative — a traceback out of task three of ten — is how a
morning ends with two sources refreshed, five untouched, and nobody sure
which. Inside a task the same rule applies where it can be applied
honestly: a 404 on one French file costs that one dataset, and a 404 on
one FRED id costs that one series, because both are answers. A 5xx is
not an answer, and three consecutive outages inside a group stop the
group rather than hammering a server that is plainly having a bad day.

**The summary is the deliverable and it names the holes.** Statuses are
four, not two: `ok`, `partial` (some of it arrived and the rest is named),
`failed` (with the reason), and `skipped` (with why it was not attempted
— usually a credential we do not hold, or a sweep somebody has to ask
for). "Fetched" and "on disk" are separate columns because a task that
made no requests and a task that made forty look identical otherwise.

**No data, no file.** If nothing succeeds this exits 2 having written
nothing, with the sentence every runner in this repository prints. A
report on disk is a claim that a run happened; there is no partial
report and no placeholder.

What it will not do without being asked: create an account anywhere,
sweep the DERA archive back to 2009 (69 quarters, measured at 66-128MB
apiece), or rebuild ALFRED vintages (one request per series per vintage,
and a published vintage is immutable, so there is nothing there to
refresh). Each of those is a flag and each says what it costs.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Sequence

import typer

from griffinquant.data import catalogue
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import DEFAULT_ROOT, ParquetCache
from griffinquant.util import runs
from griffinquant.util.runs import DataUnavailable

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "data_inventory.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA

#: The delisting record's own floor is around 2003 for issuer-filed Form
#: 25 and 2006Q2 for the exchange-filed 25-NSE that is the bulk of it.
#: Starting here rather than in 2006 is deliberate: the ramp-up is part
#: of the honest answer, and a reader who sees zeros in 2003 and
#: hundreds in 2008 understands the coverage without being told.
DEFAULT_EDGAR_START = "2003-01-01"

#: Closed DERA quarters to pull. Measured on 2026-08-03 the four most
#: recent came to 358MB — 66MB for 2025Q4 and 128MB for 2025Q3, so "one
#: quarter" is not a constant — which puts the full archive from 2009Q2
#: somewhere above 5GB. Available with a bigger number and never the
#: default. Four buys a year of survivorship-free fundamentals, which is
#: enough to demonstrate the shape and to build against.
DEFAULT_DERA_QUARTERS = 4

#: Consecutive outages inside one group before we stop asking. Three
#: says "this is the server, not the request" without giving up on the
#: first hiccup. A 404 does not count — that is an answer.
OUTAGE_STREAK_LIMIT = 3

STATUS_OK = "ok"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"

app = typer.Typer(add_completion=False)


# -- what a task is -----------------------------------------------------


@dataclass
class Context:
    """Everything a task needs and nothing it should decide for itself."""

    root: Path
    today: date
    edgar_start: date
    dera_quarters: int
    refresh: bool
    echo: Callable[[str], None]

    def cache(self) -> ParquetCache:
        return ParquetCache(self.root)


@dataclass
class TaskResult:
    """What one source gave back.

    `missing` is the field that earns its keep. A pull that got
    seventeen of eighteen datasets is not a success and is not a
    failure, and the only way to keep it from being reported as either
    is to make the shortfall a first-class part of the return value.
    """

    detail: str
    missing: tuple[str, ...] = ()
    #: Measured facts worth printing under the source in the report —
    #: coverage counts, survivorship measurements, the things a reader
    #: would otherwise have to rerun the pull to see.
    facts: tuple[str, ...] = ()
    #: Set where a task decided not to run. Distinct from a failure.
    skipped: str = ""


@dataclass(frozen=True)
class Task:
    name: str
    title: str
    #: Which catalogue rows this task fills. Used to measure the disk
    #: delta, which is how "fetched" is computed without every module
    #: having to report its own request count.
    fills: tuple[str, ...]
    run: Callable[[Context], TaskResult]
    needs_key: str = ""
    cost: str = ""


@dataclass
class Outcome:
    task: Task
    status: str
    seconds: float = 0.0
    detail: str = ""
    error: str = ""
    missing: tuple[str, ...] = ()
    facts: tuple[str, ...] = ()

    #: Before and after rather than one "fetched" figure, because those
    #: are two different claims. A task that made forty requests and one
    #: that made none finish holding the same bytes, and only the delta
    #: tells a refresh from a re-read.
    entries_before: int = 0
    entries_after: int = 0
    bytes_before: int = 0
    bytes_after: int = 0

    @property
    def entries_added(self) -> int:
        return self.entries_after - self.entries_before

    @property
    def bytes_added(self) -> int:
        return self.bytes_after - self.bytes_before


# -- the tasks ----------------------------------------------------------


def french(ctx: Context) -> TaskResult:
    """The whole Kenneth French library, one zip at a time."""
    from griffinquant.data import frenchlib

    store = frenchlib.default_cache(ctx.root)
    report = frenchlib.fetch_all(cache=store, refresh=ctx.refresh)
    rows = sum(report.rows.values())
    tables = sum(len(labels) for labels in report.loaded.values())
    return TaskResult(
        detail=(
            f"{len(report.loaded)} datasets, {tables} tables, {rows:,} "
            f"observations"
        ),
        missing=tuple(f"{k}: {v}" for k, v in report.missing.items()),
        facts=(
            "Survivorship-free through CRSP, and the only free return "
            "series here of which that is true.",
            f"CRSP vintage parsed off line 1 of every file; {tables} "
            f"tables carry their own units and frequency.",
        ),
    )


def fred_series(ctx: Context) -> TaskResult:
    """All 27 curated macro series, one request apiece, a second apart."""
    from griffinquant.data import fredseries

    store = fredseries.default_cache(ctx.root)
    missing: list[str] = []
    rows = 0
    got = 0
    streak = 0

    for series_id in fredseries.CATALOGUE:
        try:
            values = fredseries.fetch_series(
                series_id, cache=store, today=ctx.today, refresh=ctx.refresh
            )
        except fredseries.FredNotPublished as exc:
            # An answer, not an outage: the id does not exist or has
            # been withdrawn. Costs one series and resets the streak.
            missing.append(f"{series_id}: not published ({_one_line(exc)})")
            streak = 0
            continue
        except SourceUnavailable as exc:
            missing.append(f"{series_id}: {_one_line(exc)}")
            streak += 1
            if streak >= OUTAGE_STREAK_LIMIT:
                missing.append(
                    f"stopped after {streak} consecutive outages — the "
                    f"remaining ids were not attempted"
                )
                break
            continue
        streak = 0
        got += 1
        rows += int(len(values))

    if got == 0:
        raise DataUnavailable(
            "not one FRED series came back. That is an outage at the St. "
            "Louis Fed or on this machine's network, and it is not a "
            "statement about the American economy."
        )

    frame = fredseries.catalogue_frame()
    restricted = frame.loc[~frame["redistributable"], "series_id"].tolist()
    return TaskResult(
        detail=f"{got} of {len(fredseries.CATALOGUE)} series, {rows:,} observations",
        missing=tuple(missing),
        facts=(
            "Release lags are MEASURED against ALFRED vintages, not "
            "recalled: a 9-day payrolls rule leaks, and so does a "
            "14-day CPI rule.",
            "The ICE BofA credit history is gone — BAMLH0A0HYM2 and "
            "BAMLC0A0CM start 2023-08-01 for indices documented to "
            "1996. BAA10Y is the long-history stand-in and is not an "
            "OAS.",
            f"Not redistributable without written approval: "
            f"{', '.join(restricted) if restricted else 'none'}.",
        ),
    )


def fred_vintages(ctx: Context) -> TaskResult:
    """Report the archive on disk. Deliberately does not refetch.

    A published vintage is immutable — that is the whole property that
    makes it worth having — so there is nothing here a refresh could
    improve. Rebuilding the set costs one request per (series, vintage),
    and the way to ask for that is `fredseries.lag_audit`, which is an
    audit somebody runs and reads rather than a nightly job.
    """
    used = catalogue.usage(ctx.root)["fred_vintages"]
    if used.entries == 0:
        return TaskResult(
            detail="no vintages on disk",
            skipped=(
                "ALFRED vintages are built by `fredseries.lag_audit`, one "
                "request per (series, vintage). Not a refresh job: run the "
                "audit when a lag needs defending."
            ),
        )
    return TaskResult(
        detail=f"{used.entries} vintage frames, {used.rows:,} observations",
        facts=(
            "Nothing was fetched and nothing needed to be: a published "
            "vintage never changes.",
            "The archive stops short of the data. A 2012 vintage of "
            "DTWEXBGS or BAA10Y is a 404, and STLFSI4 has none before "
            "2023 — the one series here whose past cannot be recovered.",
        ),
    )


def longhistory(ctx: Context) -> TaskResult:
    """Shiller, three Damodaran workbooks, and the century-scale FRED slice."""
    from griffinquant.data import longhistory as lh

    reader = lh.LongHistory(cache=ctx.cache())
    missing: list[str] = []
    facts: list[str] = []
    parsed: list[str] = []

    workbooks = {
        "shiller": reader.shiller,
        "damodaran_returns": reader.damodaran_returns,
        "damodaran_implied_erp": reader.damodaran_implied_erp,
        "damodaran_erp_monthly": reader.damodaran_implied_erp_monthly,
    }
    for key, parse in workbooks.items():
        try:
            reader.raw(key, refresh=ctx.refresh)
        except SourceUnavailable as exc:
            missing.append(f"{key}: {_one_line(exc)}")
            continue
        # Parsed as well as fetched. The bytes being on disk says the
        # download worked; only a parse says the workbook still has the
        # shape we read it with, and these are hand-maintained files
        # that change layout between years.
        try:
            frame = parse()
        except Exception as exc:  # noqa: BLE001 - a parse break is per-file
            missing.append(f"{key}: cached but would not parse — {_one_line(exc)}")
            continue
        parsed.append(f"{key} {len(frame):,}x{len(frame.columns)}")
        facts.append(f"{key}: sha256 {reader.digest(key)[:12]} (the vintage id)")

    try:
        macro = reader.fred_macro(end=ctx.today, refresh=ctx.refresh)
        parsed.append(f"fred_macro {len(macro):,} long-form rows")
    except SourceUnavailable as exc:
        missing.append(f"fred_macro: {_one_line(exc)}")
        macro = None

    if not parsed:
        raise DataUnavailable(
            "no long-history file could be read. Every one of these is a "
            "single academic's server and they are not down together by "
            "coincidence — check the network before concluding anything "
            "about the sources."
        )

    facts.append(
        "Index level throughout: no constituents, no delisting dates, "
        "nothing to select from. A per-name result computed from these "
        "is a bug."
    )
    facts.append(
        "USREC is assigned retrospectively — NBER dates a peak a year or "
        "more later — so it describes regimes and must never trade."
    )
    return TaskResult(
        detail="; ".join(parsed),
        missing=tuple(missing),
        facts=tuple(facts),
    )


def edgar_ticker_map(ctx: Context) -> TaskResult:
    """One request for SEC's ticker-to-CIK lookup. Not a universe."""
    from griffinquant.data import edgarbulk

    client = edgarbulk.EdgarBulk(cache=edgarbulk.default_cache(ctx.root))
    frame = client.company_tickers()
    return TaskResult(
        detail=f"{len(frame):,} living registrants",
        facts=(
            "NOT survivorship-free and the one row in this inventory of "
            "which that is true: a company delisted last year is absent "
            "with nothing recording that it was ever here.",
            "Its use is resolving a ticker you already hold to a "
            "permanent CIK. Used as a universe it reintroduces the exact "
            "bias this repository exists to measure.",
        ),
    )


def edgar_delistings(ctx: Context) -> TaskResult:
    """The free delisting record, one request per quarter.

    Quarter by quarter rather than through `delistings()` in one call,
    because a single unreachable quarter should cost that quarter and
    not the sweep — and because a closed quarter, once cached, never
    needs asking for again.
    """
    from griffinquant.data import edgarbulk

    client = edgarbulk.EdgarBulk(cache=edgarbulk.default_cache(ctx.root))
    quarters = edgarbulk.quarters_between(ctx.edgar_start, ctx.today)

    missing: list[str] = []
    total = 0
    issuer = 0
    exchange = 0
    got = 0
    streak = 0
    first_seen: str | None = None

    for year, quarter in quarters:
        try:
            frame = client.form25_quarter(year, quarter)
        except SourceUnavailable as exc:
            missing.append(f"{year}Q{quarter}: {_one_line(exc)}")
            streak += 1
            if streak >= OUTAGE_STREAK_LIMIT:
                missing.append(
                    f"stopped at {year}Q{quarter} after {streak} consecutive "
                    f"outages; later quarters were not attempted"
                )
                break
            continue
        except LookupError as exc:
            missing.append(f"{year}Q{quarter}: {_one_line(exc)}")
            streak = 0
            continue
        streak = 0
        got += 1
        total += len(frame)
        if len(frame):
            marked = frame["is_exchange_filer"]
            exchange += int(marked.sum())
            issuer += int((~marked).sum())
            if first_seen is None:
                first_seen = f"{year}Q{quarter}"

    if got == 0:
        raise DataUnavailable(
            "no quarter of the EDGAR full index could be read. An empty "
            "delisting record is not a period in which nothing was "
            "delisted."
        )

    return TaskResult(
        detail=(
            f"{got} quarters {ctx.edgar_start.year}-{ctx.today.year}, "
            f"{total:,} filings ({issuer:,} issuer rows, {exchange:,} "
            f"exchange rows dropped as duplicates)"
        ),
        missing=tuple(missing),
        facts=(
            f"First quarter carrying anything: {first_seen or 'none'}.",
            "A delisting DATE, never a delisting RETURN. An acquisition "
            "at a premium and a wind-up at zero are the same row here.",
            "A Form 25 strikes a class of securities, not a company — "
            "Verizon is in 2025Q2 for a note.",
        ),
    )


def edgar_dera(ctx: Context) -> TaskResult:
    """The last few closed quarters of the Financial Statement Data Sets."""
    from griffinquant.data import edgarbulk

    if ctx.dera_quarters <= 0:
        return TaskResult(
            detail="not requested",
            skipped=(
                "each quarterly zip runs 66-128MB and the full archive from "
                "2009Q2 is above 5GB; pass --dera-quarters N to pull N of "
                "the most recent closed quarters"
            ),
        )

    client = edgarbulk.EdgarBulk(cache=edgarbulk.default_cache(ctx.root))
    wanted = _recent_closed_quarters(ctx.today, ctx.dera_quarters)
    tags = edgarbulk.STANDARD_CONCEPTS["us-gaap"]

    missing: list[str] = []
    filings = 0
    facts_rows = 0
    got = 0
    streak = 0

    for year, quarter in wanted:
        try:
            sub = client.dera_submissions(year, quarter)
            num = client.dera_numbers(year, quarter, tags=tags)
        except SourceUnavailable as exc:
            missing.append(f"{year}Q{quarter}: {_one_line(exc)}")
            streak += 1
            if streak >= OUTAGE_STREAK_LIMIT:
                missing.append(
                    f"stopped after {streak} consecutive outages; earlier "
                    f"quarters were not attempted"
                )
                break
            continue
        except LookupError as exc:
            # The quarter has not been published, or predates 2009Q2.
            missing.append(f"{year}Q{quarter}: {_one_line(exc)}")
            streak = 0
            continue
        streak = 0
        got += 1
        filings += len(sub)
        facts_rows += len(num)

    if got == 0:
        raise DataUnavailable(
            "no DERA quarter could be read. A quarter with no filings in "
            "it does not exist; this is a transport failure."
        )

    return TaskResult(
        detail=(
            f"{got} quarters, {filings:,} filings, {facts_rows:,} facts "
            f"across {len(tags)} tags"
        ),
        missing=tuple(missing),
        facts=(
            "Survivorship-free and broad: each quarter is assembled at "
            "the time and never rewritten, so a filer that went under in "
            "2012 is still in 2012Q1 with the numbers it reported.",
            "Every row carries its own period end and duration, so the "
            "fiscal-year trap that ruins companyfacts does not exist "
            "here.",
            "Still no prices. This is a numerator waiting for a "
            "denominator, and the denominator is not free.",
        ),
    )


def tiingo_directory(ctx: Context) -> TaskResult:
    """The keyless supported-ticker catalogue, and what it says about the dead."""
    from griffinquant.data import etfuniverse

    directory = etfuniverse.fetch_directory(cache=ctx.cache())
    survival = etfuniverse.directory_survivorship(directory, asof=ctx.today)
    absent = etfuniverse.absence_report(directory)
    still_absent = int(absent["still_absent"].sum()) if len(absent) else 0
    # Split by fate, because the two absences mean different things: a
    # closed fund the vendor dropped bounds how complete retention is,
    # and a symbol lost to a rename bounds what a ticker means.
    closed = int((absent["fate"] == "closed").sum()) if len(absent) else 0
    renamed = len(absent) - closed

    return TaskResult(
        detail=f"{len(directory):,} symbols; {survival['etf_rows']:,} tradable ETF rows",
        facts=(
            f"{survival['ended']:,} of {survival['etf_rows']:,} ETF rows "
            f"({survival['share_ended']:.1%}) ended at a date in the "
            f"past, and the price endpoint still serves their bars. The "
            f"vendor's retention is measured, not trusted.",
            f"{still_absent} of {len(absent)} documented absences are "
            f"still absent, re-checked on every run so the claim cannot "
            f"rot: {closed} real ETFs the directory does not carry at all "
            f"(retention is the rule, not a guarantee) and {renamed} "
            f"symbols lost to a rename.",
            "A renamed fund keeps its history and loses its old symbol. "
            "Every string here is today's name for a series, never what "
            "it traded under on the date of the bar.",
        ),
    )


def tiingo_etf_bars(ctx: Context) -> TaskResult:
    """Daily bars for the 154-fund universe, resuming from whatever is cached.

    The 429 is the outage this actually hits, and it is reported as a
    partial rather than swallowed: a coverage table listing eighty funds
    with bars and sixty without reads exactly like a universe in which
    sixty funds never traded, and that reading survives into every count
    downstream. Everything already fetched stays on disk, so re-running
    an hour later resumes for free.
    """
    from griffinquant.data import etfuniverse

    cache = ctx.cache()
    directory = etfuniverse.fetch_directory(cache=cache)
    resolved = etfuniverse.resolve_universe(directory, asof=ctx.today)

    source = etfuniverse.ETFUniverseSource(
        allowed=etfuniverse.UNIVERSE_WITH_DECEASED,
        directory=directory,
        fetch_names=False,
        cache=cache,
    )

    symbols = sorted(etfuniverse.UNIVERSE_WITH_DECEASED)
    done: list[str] = []
    missing: list[str] = []
    rows = 0
    fetched = 0
    throttled = ""

    for symbol in symbols:
        started = time.monotonic()
        try:
            coverage = etfuniverse.pull_universe(
                source, end=ctx.today, tickers=[symbol]
            )
        except SourceUnavailable as exc:
            # Almost certainly the symbol meter. Stop asking: the cap
            # counts names, so no pause buys another one and only
            # waiting does.
            throttled = _one_line(exc)
            missing.append(
                f"stopped at {symbol} — {len(symbols) - len(done)} names not "
                f"fetched: {throttled}"
            )
            break
        elapsed = time.monotonic() - started
        done.append(symbol)
        rows += int(coverage["rows"].sum())

        # One name per call, so `pull_universe`'s own inter-symbol pause
        # never fires; pace here instead. Whether the call touched the
        # network is not a guess — the parent source paces every HTTP
        # request to a 0.5s floor, so anything that returned faster than
        # that was a parquet read. Sleeping after a cache hit would add
        # two and a half minutes of politeness toward a server nobody
        # spoke to.
        if elapsed >= etfuniverse.PULL_PAUSE_SECONDS / 2:
            fetched += 1
            time.sleep(etfuniverse.PULL_PAUSE_SECONDS)

    if not done:
        raise DataUnavailable(
            "not one ETF returned bars. "
            + (throttled or "The vendor refused the first request.")
            + " Nothing has been recorded as a fund with no history, "
            "because that is indistinguishable from a fund that never "
            "traded."
        )

    late = etfuniverse.late_arrivals(resolved, date(2005, 1, 1))
    return TaskResult(
        detail=(
            f"{len(done)} of {len(symbols)} funds, {rows:,} daily bars "
            f"({fetched} fetched, {len(done) - fetched} already cached)"
        ),
        missing=tuple(missing),
        facts=(
            f"{len(late)} of {len(resolved)} funds list after 2005-01-01; "
            f"a study stating a 2005 start would have to invent them.",
            "The universe LIST is survivorship-biased and the vendor is "
            "not. That bias is ours and is fixable by adding names — a "
            "different sentence from 'the source cannot support it'.",
            "Free tier meters SYMBOLS, not requests: roughly 50 an hour, "
            "rolling. No pause buys another one; only waiting does.",
        ),
    )


TASKS: tuple[Task, ...] = (
    Task(
        name="french",
        title="Kenneth French Data Library",
        fills=("french_library",),
        run=french,
        cost="18 zips, ~2s apart, ~26MB cached",
    ),
    Task(
        name="fred",
        title="FRED curated macro series",
        fills=("fred_series",),
        run=fred_series,
        cost="27 requests, 1s apart",
    ),
    Task(
        name="fred-vintages",
        title="ALFRED point-in-time vintages",
        fills=("fred_vintages",),
        run=fred_vintages,
        cost="none — reports what is on disk; a vintage is immutable",
    ),
    Task(
        name="longhistory",
        title="Shiller, Damodaran, century-scale FRED",
        fills=(
            "shiller",
            "damodaran_returns",
            "damodaran_implied_erp",
            "damodaran_erp_monthly",
            "fred_century",
        ),
        run=longhistory,
        cost="4 workbooks + 9 FRED series, 2s apart",
    ),
    Task(
        name="edgar-tickers",
        title="SEC ticker-to-CIK map",
        fills=("edgar_ticker_map",),
        run=edgar_ticker_map,
        cost="1 request",
    ),
    Task(
        name="edgar-delistings",
        title="SEC Form 25 / 25-NSE delisting record",
        fills=("edgar_delistings",),
        run=edgar_delistings,
        cost="1 request per quarter, ~5MB each, closed quarters cached forever",
    ),
    Task(
        name="edgar-dera",
        title="SEC Financial Statement Data Sets",
        fills=("edgar_dera_submissions", "edgar_dera_numbers"),
        run=edgar_dera,
        cost="66-128MB per quarter, measured; 358MB for the default four",
    ),
    Task(
        name="tiingo-directory",
        title="Tiingo supported-ticker directory",
        fills=("tiingo_directory",),
        run=tiingo_directory,
        cost="1 keyless request",
    ),
    Task(
        name="tiingo-etf",
        title="Tiingo ETF universe daily bars",
        fills=("tiingo_etf_bars",),
        run=tiingo_etf_bars,
        needs_key="TIINGO_API_KEY",
        cost="1 request per uncached fund; ~50 symbols/hour on the free tier",
    ),
)

TASKS_BY_NAME = {t.name: t for t in TASKS}


# -- the driver ---------------------------------------------------------


def _one_line(exc: Exception) -> str:
    """An exception's message, flattened to fit in a table cell.

    These messages are paragraphs on purpose — the modules explain the
    failure rather than naming it — and a paragraph in a summary row
    hides every other row.
    """
    text = " ".join(str(exc).split())
    return text if len(text) <= 240 else text[:239] + "…"


def _recent_closed_quarters(today: date, count: int) -> list[tuple[int, int]]:
    """The `count` most recent quarters that have actually been published.

    Two back from today, not one. DERA publishes roughly two weeks after
    quarter end, so the quarter that just closed may not exist yet — and
    asking for it produces a 403 that reads like throttling rather than
    like a calendar.
    """
    year, quarter = today.year, (today.month - 1) // 3 + 1
    for _ in range(2):
        quarter -= 1
        if quarter < 1:
            year, quarter = year - 1, 4
    out: list[tuple[int, int]] = []
    while len(out) < count and (year, quarter) >= (2009, 2):
        out.append((year, quarter))
        quarter -= 1
        if quarter < 1:
            year, quarter = year - 1, 4
    return list(reversed(out))


def _usage_of(root: Path, keys: Sequence[str]) -> tuple[int, int]:
    """Entries and bytes for the catalogue rows one task fills.

    Read off the sidecars rather than reported by the task, which means
    a module does not have to count its own requests to be measured
    here — and cannot misreport them either.
    """
    used = catalogue.usage(root)
    return (
        sum(used[k].entries for k in keys),
        sum(used[k].total_bytes for k in keys),
    )


def execute(task: Task, ctx: Context) -> Outcome:
    """Run one task, and never let it take the others down with it."""
    before_entries, before_bytes = _usage_of(ctx.root, task.fills)
    started = time.monotonic()
    outcome = Outcome(
        task=task,
        status=STATUS_OK,
        entries_before=before_entries,
        bytes_before=before_bytes,
    )
    try:
        result = task.run(ctx)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 - the whole point is not to abort
        outcome.status = STATUS_FAILED
        outcome.error = f"{type(exc).__name__}: {_one_line(exc)}"
    else:
        outcome.detail = result.detail
        outcome.missing = result.missing
        outcome.facts = result.facts
        if result.skipped:
            outcome.status = STATUS_SKIPPED
            outcome.error = result.skipped
        elif result.missing:
            outcome.status = STATUS_PARTIAL

    outcome.seconds = time.monotonic() - started
    after_entries, after_bytes = _usage_of(ctx.root, task.fills)
    outcome.entries_after = after_entries
    outcome.bytes_after = after_bytes
    return outcome


def run_all(tasks: Sequence[Task], ctx: Context) -> list[Outcome]:
    outcomes: list[Outcome] = []
    for i, task in enumerate(tasks, start=1):
        ctx.echo(f"  [{i}/{len(tasks)}] {task.name} — {task.title}")
        outcome = execute(task, ctx)
        outcomes.append(outcome)
        ctx.echo(f"        {_summarise(outcome)}")
    return outcomes


def _summarise(outcome: Outcome) -> str:
    bits = [outcome.status.upper(), f"{outcome.seconds:.1f}s"]
    if outcome.detail:
        bits.append(outcome.detail)
    if outcome.status in (STATUS_FAILED, STATUS_SKIPPED) and outcome.error:
        bits.append(outcome.error)
    if outcome.entries_added:
        bits.append(
            f"+{outcome.entries_added} entries, "
            f"+{catalogue.human_bytes(outcome.bytes_added)}"
        )
    elif outcome.status == STATUS_OK:
        bits.append("served from cache")
    return " · ".join(bits)


# -- the report ---------------------------------------------------------


def render_markdown(
    outcomes: Sequence[Outcome], ctx: Context, generated_at: datetime
) -> str:
    from griffinquant.util.runs import esc, stamp, table

    totals = catalogue.totals(ctx.root)
    out: list[str] = []
    add = out.append

    add("# Data inventory")
    add("")
    add(
        f"_Generated {stamp(generated_at)} by `fetch_all.py`. "
        f"Every figure below is measured off the cache under "
        f"`{ctx.root}`, not estimated._"
    )
    add("")
    add(
        "Everything here is free. No subscription was bought, no account "
        "was created, and no source was asked twice for the same bytes. "
        "What that costs is written down in **What we still cannot do** at "
        "the end, which is the section to read before planning anything."
    )
    add("")

    add("## Headline")
    add("")
    add(
        table(
            ["", ""],
            [
                ["Datasets registered", f"{totals['datasets']}"],
                ["Datasets populated", f"{totals['populated']}"],
                ["Cache entries", f"{totals['entries']:,}"],
                ["Rows on disk", f"{totals['rows']:,}"],
                ["Rows once duplicates are set aside", f"{totals['distinct_rows']:,}"],
                [
                    "Superseded by a later pull",
                    f"{totals['superseded_entries']} entries, "
                    f"{catalogue.human_bytes(totals['superseded_bytes'])}",
                ],
                [
                    "Parquet on disk",
                    catalogue.human_bytes(totals["parquet_bytes"]),
                ],
                [
                    "Raw archives on disk",
                    f"{totals['raw_files']} file(s), "
                    f"{catalogue.human_bytes(totals['raw_bytes'])}",
                ],
                ["Total on disk", catalogue.human_bytes(totals["total_bytes"])],
                [
                    "Unclaimed by this catalogue",
                    f"{totals['unattributed_entries']} entries, "
                    f"{catalogue.human_bytes(totals['unattributed_bytes'])}",
                ],
            ],
            ["l", "r"],
        )
    )
    add("")
    add(
        "Two of those rows need a sentence each. **Superseded** counts "
        "entries that a later pull of the same request has replaced: "
        "several sources key their cache on the date they pulled "
        "through, so a second day's run leaves yesterday's copy beside "
        "today's. That is the behaviour that makes a same-day rerun "
        "free, and nothing deletes the old copy automatically — a saved "
        "pull is the one thing a reviewer with no key can reproduce a "
        "report from. It does mean *rows on disk* counts a good many "
        "observations twice, which is why the distinct figure sits "
        "beside it."
    )
    add("")
    add(
        "**Unclaimed** is the honesty check. Bytes on disk that no "
        "catalogue row claims mean this document is describing less than "
        "the repository holds; anything above zero is a missing entry in "
        "`griffinquant/data/catalogue.py`, not a rounding artefact."
    )
    add("")

    add("## How to read the survivorship column")
    add("")
    add(
        "Four values, because a boolean would force three different "
        "honest answers into one dishonest one."
    )
    add("")
    add(
        table(
            ["Value", "Means"],
            [
                [
                    "FREE",
                    "The source retains securities that stopped trading "
                    "and we can name the mechanism.",
                ],
                [
                    "BIASED",
                    "A roster of the living. The dead are absent and "
                    "nothing records that they were here.",
                ],
                [
                    "OURS",
                    "The vendor retains its dead; our selection from it "
                    "does not. Fixable by adding names.",
                ],
                [
                    "n/a",
                    "No cross-section exists, so the bias cannot arise — "
                    "and cannot be checked either.",
                ],
            ],
            ["l", "l"],
        )
    )
    add("")

    add("## The inventory")
    add("")
    add(catalogue.render_table(ctx.root))
    add("")
    add(
        "`Cached` is rows for a dataset stored as observations and files "
        "for one stored as its source workbook — Shiller is 1,867 monthly "
        "observations inside a single cached blob, and printing `1` beside "
        "seven million French rows would read as a broken parse. It is "
        "rows ON DISK, so where a superseded copy is still present the "
        "figure exceeds the number of distinct observations; the "
        "per-dataset blocks below say by how much."
    )
    add("")

    add("## Each dataset in full")
    add("")
    used = catalogue.usage(ctx.root)
    for dataset in catalogue.entries():
        u = used[dataset.key]
        add(f"### {dataset.key} — {dataset.title}")
        add("")
        rows = [
            ["Publisher", dataset.publisher],
            ["Module", f"`{dataset.module}`"],
            ["Endpoint", f"`{dataset.endpoint}`"],
            ["Contains", dataset.contains],
            ["True start", dataset.true_start],
            ["Updates", dataset.cadence],
            ["Survivorship", f"**{dataset.survivorship_label}** — {dataset.survivorship_basis}"],
            ["Licence", dataset.licence],
            ["Redistribution", _redistribution(dataset.redistributable)],
            ["Key required", dataset.needs_key or "none — keyless"],
            ["Answers", dataset.question],
            ["**Cannot**", dataset.cannot],
            [
                "On disk",
                f"{u.entries} entries, {u.rows:,} rows, "
                f"{catalogue.human_bytes(u.total_bytes)}"
                + (
                    f" — of which {u.superseded_entries} entries and "
                    f"{u.superseded_rows:,} rows are a previous day's copy "
                    f"of the same request, leaving {u.distinct_rows:,} "
                    f"distinct"
                    if u.superseded_entries
                    else ""
                ),
            ],
        ]
        if dataset.notes:
            rows.insert(-1, ["Notes", dataset.notes])
        add(table(["", ""], rows, ["l", "l"]))
        add("")

    add("## This run")
    add("")
    add(
        table(
            ["Source", "Status", "Time", "What came back", "Fetched", "On disk"],
            [
                [
                    o.task.name,
                    o.status.upper(),
                    f"{o.seconds:.1f}s",
                    o.detail or o.error or runs.NULL,
                    (
                        f"+{o.entries_added} entries, "
                        f"+{catalogue.human_bytes(o.bytes_added)}"
                        if o.entries_added
                        else "nothing — already cached"
                    ),
                    catalogue.human_bytes(o.bytes_after),
                ]
                for o in outcomes
            ],
            ["l", "l", "r", "l", "l", "r"],
        )
    )
    add("")
    elapsed = sum(o.seconds for o in outcomes)
    fresh = sum(o.entries_added for o in outcomes)
    add(
        f"{elapsed:.1f} seconds across {len(outcomes)} sources, "
        f"{fresh} new cache entries. A run whose Fetched column reads "
        f"\"already cached\" throughout is the contract working rather "
        f"than a run that did nothing: the pull is idempotent, so a "
        f"second invocation costs the time to stat the sidecars and "
        f"nobody's server is asked a question it already answered."
    )
    add("")

    troubled = [o for o in outcomes if o.status != STATUS_OK]
    if troubled:
        add("### What did not go cleanly")
        add("")
        for o in troubled:
            add(f"**{o.task.name}** — {o.status}")
            add("")
            if o.error:
                add(f"- {esc(o.error)}")
            for item in o.missing:
                add(f"- {esc(item)}")
            add("")
    else:
        add("Every source came back clean.")
        add("")

    add("### What each pull established")
    add("")
    for o in outcomes:
        if not o.facts:
            continue
        add(f"**{o.task.name}**")
        add("")
        for fact in o.facts:
            add(f"- {fact}")
        add("")

    # Derived rather than written down, so a dataset that loses its
    # refresher stops being maintained and starts saying so on the same
    # day. An unmaintained row is not a defect — two of these cannot be
    # swept at all — but silence about it would be.
    unfilled = [
        d for d in catalogue.entries()
        if not any(d.key in t.fills for t in TASKS)
    ]
    if unfilled:
        add("### Datasets no source in this run refreshes")
        add("")
        add(
            table(
                ["Dataset", "On disk", "Why it is not swept"],
                [
                    [
                        d.key,
                        catalogue.human_bytes(used[d.key].total_bytes),
                        "Per-filer: reached by CIK, and the ticker map "
                        "will not give you a CIK for a dead one. There is "
                        "no bulk form of this endpoint, so what is cached "
                        "is whatever somebody looked up.",
                    ]
                    for d in unfilled
                ],
                ["l", "r", "l"],
            )
        )
        add("")

    stray = catalogue.unattributed(ctx.root)
    if not stray.empty:
        add("### Cache entries this catalogue does not claim")
        add("")
        add(
            table(
                ["Source", "Frame", "Entries", "Rows", "Bytes"],
                [
                    [
                        str(r["source"]),
                        str(r["frame"]),
                        f"{int(r['entries']):,}",
                        f"{int(r['rows']):,}",
                        catalogue.human_bytes(int(r["bytes"])),
                    ]
                    for _, r in stray.iterrows()
                ],
                ["l", "l", "r", "r", "r"],
            )
        )
        add("")
        add(
            "Each of these needs a row in `catalogue.py`. Until it has "
            "one, the inventory above understates what is on disk."
        )
        add("")

    add("## What a credential we do not hold would buy")
    add("")
    add(
        "We do not create accounts on anyone's behalf. What was behind "
        "each door is written down so the same source is not "
        "rediscovered, re-probed and re-abandoned next quarter."
    )
    add("")
    add(
        table(
            ["Source", "Would give", "The wall"],
            [
                [b.name, b.would_give, b.wall]
                for b in catalogue.BLOCKED
            ],
            ["l", "l", "l"],
        )
    )
    add("")

    add("## Free, verified reachable, not acquired")
    add("")
    add(
        "Probed and left on the shelf. Each line says what it gives and "
        "what is wrong with it, because the second half is what stops "
        "somebody reaching for it in a hurry."
    )
    add("")
    add(
        table(
            ["Source", "Gives", "Caveat"],
            [[p.name, p.gives, p.caveat] for p in catalogue.PROSPECTS],
            ["l", "l", "l"],
        )
    )
    add("")

    add("## What we still cannot do")
    add("")
    add(
        "Read this before designing anything. These are not gaps waiting "
        "for a better parser — they are questions the free universe "
        "cannot answer, and the first one shapes what this repository is "
        "allowed to claim."
    )
    add("")
    for i, limit in enumerate(catalogue.LIMITS, start=1):
        add(f"### {i}. {limit.title}")
        add("")
        add(limit.body)
        add("")

    return "\n".join(out).rstrip() + "\n"


def _redistribution(flag: bool | None) -> str:
    if flag is True:
        return "yes"
    if flag is False:
        return "**no** — internal research and citation only"
    return "per series; check the row before publishing"


# -- CLI ----------------------------------------------------------------


def _select(only: str, skip: str) -> list[Task]:
    chosen = list(TASKS)
    if only.strip():
        wanted = [n.strip() for n in only.split(",") if n.strip()]
        unknown = [n for n in wanted if n not in TASKS_BY_NAME]
        if unknown:
            raise typer.BadParameter(
                f"unknown source(s) {unknown}; known: {sorted(TASKS_BY_NAME)}"
            )
        chosen = [TASKS_BY_NAME[n] for n in wanted]
    if skip.strip():
        dropped = {n.strip() for n in skip.split(",") if n.strip()}
        unknown = sorted(dropped - set(TASKS_BY_NAME))
        if unknown:
            raise typer.BadParameter(
                f"unknown source(s) {unknown}; known: {sorted(TASKS_BY_NAME)}"
            )
        chosen = [t for t in chosen if t.name not in dropped]
    if not chosen:
        raise typer.BadParameter("every source was skipped; nothing to do")
    return chosen


@app.command()
def main(
    out: Path = typer.Option(DEFAULT_REPORT, "--out", help="Where to write."),
    root: Path = typer.Option(
        DEFAULT_ROOT, "--cache-root", help="Parquet cache root."
    ),
    only: str = typer.Option("", "--only", help="Comma-separated sources to run."),
    skip: str = typer.Option("", "--skip", help="Comma-separated sources to skip."),
    edgar_start: str = typer.Option(
        DEFAULT_EDGAR_START,
        "--edgar-start",
        help="First quarter of the delisting sweep, ISO date.",
    ),
    dera_quarters: int = typer.Option(
        DEFAULT_DERA_QUARTERS,
        "--dera-quarters",
        help="Closed DERA quarters to pull. ~85MB each. 0 for none.",
    ),
    refresh: bool = typer.Option(
        False,
        "--refresh",
        help="Refetch even what is cached. Rude; make it a decision.",
    ),
    list_sources: bool = typer.Option(
        False, "--list", help="Print the sources and what each costs, then stop."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print the plan without fetching or writing."
    ),
    quiet: bool = typer.Option(
        False, "--quiet", help="Write the report, print nothing but errors."
    ),
) -> None:
    generated_at = runs.utcnow()
    tasks = _select(only, skip)

    if list_sources:
        from griffinquant.util.runs import table

        typer.echo(
            table(
                ["Source", "Title", "Key", "Cost"],
                [
                    [t.name, t.title, t.needs_key or "none", t.cost]
                    for t in TASKS
                ],
                ["l", "l", "l", "l"],
            )
        )
        raise typer.Exit(EXIT_OK)

    ctx = Context(
        root=Path(root),
        today=generated_at.date(),
        edgar_start=date.fromisoformat(edgar_start),
        dera_quarters=int(dera_quarters),
        refresh=bool(refresh),
        echo=(lambda _msg: None) if quiet else typer.echo,
    )

    if dry_run:
        typer.echo(f"\n  Would run {len(tasks)} source(s) into {ctx.root}:\n")
        for task in tasks:
            typer.echo(f"    {task.name:18} {task.cost}")
        typer.echo(f"\n  Would write {out}. Nothing fetched.\n")
        raise typer.Exit(EXIT_OK)

    ctx.echo(f"\n  Refreshing {len(tasks)} source(s) into {ctx.root}\n")
    try:
        outcomes = run_all(tasks, ctx)
    except KeyboardInterrupt:
        typer.secho(
            "\n  INTERRUPTED — nothing has been written.\n",
            fg=typer.colors.YELLOW,
            bold=True,
            err=True,
        )
        typer.secho(
            "  Every entry already fetched is on disk and committed; "
            "re-running resumes from there and costs nothing for what it "
            "already holds.\n",
            err=True,
        )
        raise typer.Exit(EXIT_FAILED)

    delivered = [o for o in outcomes if o.status in (STATUS_OK, STATUS_PARTIAL)]
    if not delivered:
        raise runs.refuse_no_data(
            DataUnavailable(
                "every source failed or was skipped, so there is nothing "
                "to inventory: "
                + "; ".join(f"{o.task.name} {o.error}" for o in outcomes)
            ),
            what="no inventory was written",
        )

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(outcomes, ctx, generated_at), "utf-8")

    failed = [o for o in outcomes if o.status == STATUS_FAILED]
    partial = [o for o in outcomes if o.status == STATUS_PARTIAL]
    if not quiet:
        typer.echo("")
        typer.echo(catalogue.render_table(ctx.root))
        typer.echo("")
        typer.echo(
            f"  {len(delivered)} of {len(outcomes)} source(s) delivered; "
            f"{len(partial)} partial, {len(failed)} failed."
        )
        typer.echo(f"  inventory → {out}\n")

    raise typer.Exit(EXIT_OK if not (failed or partial) else EXIT_FAILED)


if __name__ == "__main__":
    app()
