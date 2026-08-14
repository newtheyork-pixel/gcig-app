"""What a runnable deliverable needs and no library module owns.

Three scripts now stand at the top of this repository — `data_audit.py`,
`validate_engine.py`, and the two Stage 3 runners beside them — and each
one has to answer the same four questions before it computes anything:
where the prices come from, what happens when they do not arrive, what a
number looks like on the page, and how many times we have looked. Left
in the scripts those answers drift apart, and the one that must never
drift is the second.

**The no-data contract lives here and nowhere else.** A report file that
exists is a claim that the run happened. So there is no partial report,
no placeholder, no "generated from cache where available" — the pull
either produces a panel or the process exits 2 having written nothing,
with the same sentence `validate_engine.py` uses, because a reader who
has seen it once should recognise it instantly. Every script that grew
its own version of this rule eventually grew a version that writes
something.

Nothing here decides anything about a strategy. It fetches, it formats,
and it counts trials.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence

import pandas as pd
import typer

from ..data.base import DataSource, SourceUnavailable
from ..data.cache import ParquetCache
from ..data.tbill import FRED_SERIES, TbillUnavailable, fetch_rate
from ..engine.metrics import TrialCounter

__all__ = [
    "Check",
    "DataUnavailable",
    "EXIT_FAILED",
    "EXIT_NO_DATA",
    "EXIT_OK",
    "NO_DATA_SENTENCE",
    "NULL",
    "Sample",
    "Source",
    "Trials",
    "bps",
    "build_source",
    "checks_table",
    "count",
    "day",
    "esc",
    "frame_table",
    "load_sample",
    "money",
    "num",
    "pct",
    "refuse_no_data",
    "signed_pct",
    "spliced_table",
    "stamp",
    "table",
    "utcnow",
]


#: The same three-way split `data_audit.py` and `validate_engine.py`
#: use, for the same reason: "we could not check" is not a weaker form
#: of "we checked and it was fine", and the moment it exits 0 somebody
#: wires the script into a pipeline and sees green.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NO_DATA = 2

#: Printed verbatim on every no-data exit, in every script. Quoted
#: rather than paraphrased because it is the one sentence a reader needs
#: to recognise on sight — it is what distinguishes "the run was
#: refused" from "the run went badly", and those two produce identical
#: silence otherwise.
NO_DATA_SENTENCE = (
    "A reconciliation is a claim about arithmetic we actually did, and a "
    "file saying otherwise would outlive this session."
)


class DataUnavailable(RuntimeError):
    """The panel could not be assembled. Never a finding about a market."""


class Source(str, Enum):
    """Which price feed to reach for.

    Two, and the second exists because the first has no owner we can
    call. `free` is the keyless chart endpoint; `tiingo` is the keyed
    fallback, reachable without editing code precisely so that an
    afternoon of throttling is an inconvenience rather than a stop.
    """

    free = "free"
    tiingo = "tiingo"


# -- the panel ----------------------------------------------------------


@dataclass(frozen=True)
class Sample:
    """One pull, in every shape the scripts downstream ask for.

    The three frames are the same data and are kept together rather than
    re-derived, on the rule the engine's result object states: a layer
    that reports a quantity must never recompute one the process already
    had in its hand. `risk_free` in particular is a decimal here and a
    percent at FRED, and the conversion happening once is what keeps a
    5.25 out of a formula expecting 0.0525.
    """

    prices: pd.DataFrame
    close_adj: pd.DataFrame
    risk_free: pd.Series
    sessions: pd.DatetimeIndex
    source_label: str
    cache_note: str
    rf_note: str

    @property
    def start(self) -> pd.Timestamp:
        return pd.Timestamp(self.sessions[0])

    @property
    def end(self) -> pd.Timestamp:
        return pd.Timestamp(self.sessions[-1])

    @property
    def tickers(self) -> tuple[str, ...]:
        return tuple(str(c) for c in self.close_adj.columns)


def build_source(source: Source, *, cache: ParquetCache | None) -> DataSource:
    """The adapter behind `--source`, imported late.

    Late because `keyedsleeves` reads an environment variable at
    construction and raises when the key is missing, and a script run
    against the free endpoint should not have to own a token it is never
    going to use.
    """
    if source is Source.tiingo:
        from ..data.keyedsleeves import KeyedSleeveSource

        return KeyedSleeveSource("tiingo", cache=cache)

    from ..data.sleevedata import SleeveETFSource

    return SleeveETFSource(cache=cache)


def load_sample(
    start: date,
    end: date,
    *,
    source: Source = Source.free,
    cache: ParquetCache | None = None,
    risk_free: bool = True,
) -> Sample:
    """Every sleeve vehicle's bars, plus the hurdle they are judged against.

    Two hosts, and a failure at either one is a failure of the whole
    pull. That is deliberate and it is the part worth arguing about: the
    trend signal's hurdle is the bill rate, and zero is not a neutral
    substitute for it — with a zero hurdle anything that drifted upward
    reads as trending, which in a positive-drift world is most things
    most of the time. A report generated with a silently-zero hurdle
    would be a claim about a strategy nobody ran, so an unreachable FRED
    refuses the run exactly as an unreachable price endpoint does.
    """
    src = build_source(source, cache=cache)
    try:
        prices = src.prices(start, end)
    except SourceUnavailable as exc:
        raise DataUnavailable(str(exc)) from exc

    if prices.empty:
        raise DataUnavailable(
            f"the price pull returned no bars between {start.isoformat()} and "
            f"{end.isoformat()}. An empty frame is not a market fact here — "
            "it is the shape of a failed request."
        )

    wide = prices.pivot(index="date", columns="ticker", values="close_adj")
    wide = wide.sort_index()
    wide.columns = pd.Index([str(c) for c in wide.columns])
    wide.index = pd.DatetimeIndex(wide.index).normalize()
    sessions = pd.DatetimeIndex(wide.index)

    if len(sessions) < 2:
        raise DataUnavailable(
            f"the pull produced {len(sessions)} session(s). Nothing can be "
            "measured across one bar, and a one-row panel is what a "
            "half-served request looks like."
        )

    rf = pd.Series(0.0, index=sessions, dtype="float64")
    note = (
        "zero — the bill series was not requested, so every trend hurdle "
        "below is a drift test rather than an excess-return test"
    )
    if risk_free:
        try:
            # A fortnight of slack at the front: a sample opening the
            # Monday after a holiday has no quote on its own first day,
            # and `_rf_per_period` raises rather than inventing one.
            pct_rate = fetch_rate(start - timedelta(days=21), end)
        except TbillUnavailable as exc:
            raise DataUnavailable(
                f"{exc} The trend signal's hurdle is this series, and zero is "
                "not a neutral stand-in for it — a run without it would "
                "measure a different strategy under the same name."
            ) from exc
        rf = pct_rate.astype("float64") / 100.0
        rf.name = FRED_SERIES
        note = (
            f"FRED {FRED_SERIES}, the 3-month constant-maturity bill yield, "
            f"annualised and converted geometrically to a per-session hurdle "
            f"({float(rf.min()):.2%}-{float(rf.max()):.2%} across the pull)"
        )

    return Sample(
        prices=prices,
        close_adj=wide,
        risk_free=rf,
        sessions=sessions,
        source_label=src.label,
        cache_note="disabled (--no-cache)" if cache is None else str(cache.root),
        rf_note=note,
    )


def refuse_no_data(exc: Exception, *, what: str) -> typer.Exit:
    """Print the refusal and hand back the exit to raise.

    Returns rather than raises so the call site reads `raise
    refuse_no_data(...)` — the control flow is then visible at the place
    it happens, which is what a reader tracing "why is there no report"
    is looking for.
    """
    typer.secho(
        f"\n  DATA UNAVAILABLE — {what}.\n",
        fg=typer.colors.RED,
        bold=True,
        err=True,
    )
    typer.secho(f"  {exc}\n", fg=typer.colors.RED, err=True)
    typer.secho(f"  Nothing has been written. {NO_DATA_SENTENCE}\n", err=True)
    return typer.Exit(EXIT_NO_DATA)


# -- the trial ledger ---------------------------------------------------


class Trials:
    """Every configuration a script evaluates, written down as it runs.

    A thin thing on purpose. `metrics.TrialCounter` is the ledger and
    owns the append-only guarantee; this adds the one habit the scripts
    need, which is that the clock is read ONCE for a run and every row
    carries the same stamp. Two rows from one invocation timestamped a
    second apart is a small lie about how many sittings a search took.

    The count that matters is `distinct` and it is read AFTER the
    logging, never before. A deflated Sharpe computed against a count
    that excludes the run being reported is exactly the flattery the
    deflation exists to remove.
    """

    def __init__(self, *, path: Path | str | None = None, when: datetime) -> None:
        self.counter = TrialCounter(path) if path is not None else TrialCounter()
        self.when = when
        self.logged: list[str] = []

    def log(self, config: Mapping[str, Any], description: str) -> None:
        self.counter.record(
            config=dict(config), description=description, timestamp=self.when
        )
        self.logged.append(description)

    @property
    def distinct(self) -> int:
        return self.counter.distinct_count()

    @property
    def total(self) -> int:
        return self.counter.count()


# -- rendering ----------------------------------------------------------
#
# Deliberately not the renderer in `audit/report.py`. That one infers a
# format per column from the column's own range, which is the right
# choice for an audit frame whose columns arrive unlabelled. Everything
# below is a results table where the units are known at the call site —
# a drawdown is a percentage, a NAV is dollars, a Sharpe is neither —
# and inferring what a reader already knows is how a cost drag in basis
# points ends up printed to four decimal places beside a share count.

NULL = "—"


def utcnow() -> datetime:
    """One clock reading per run, to the second.

    A function rather than an inline call so a test can pin it. Output
    that changes between two runs of the same inputs is output nobody
    can diff, and a diff is how a reader finds what a code change did.
    """
    return datetime.now(timezone.utc).replace(microsecond=0)


def stamp(when: datetime) -> str:
    return when.strftime("%Y-%m-%d %H:%M UTC")


def _isna(value: Any) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def money(x: Any, places: int = 2) -> str:
    return NULL if _isna(x) else f"${float(x):,.{places}f}"


def pct(x: Any, places: int = 2) -> str:
    """A percentage, dropping to basis points rather than to zero.

    A real effect that rounds to "0.00%" reads as an effect that did not
    happen, and in a table whose whole job is to account for where the
    return went that is the one rendering mistake worth avoiding.
    """
    if _isna(x):
        return NULL
    v = float(x)
    if v != 0.0 and abs(v) < 5e-5:
        return f"{v * 1e4:.2f} bps"
    return f"{v * 100:.{places}f}%"


def signed_pct(x: Any, places: int = 2) -> str:
    if _isna(x):
        return NULL
    v = float(x)
    if v != 0.0 and abs(v) < 5e-5:
        return f"{v * 1e4:+.2f} bps"
    return f"{v * 100:+.{places}f}%"


def bps(x: Any, places: int = 1) -> str:
    return NULL if _isna(x) else f"{float(x):,.{places}f} bps"


def num(x: Any, places: int = 2) -> str:
    return NULL if _isna(x) else f"{float(x):,.{places}f}"


def count(x: Any) -> str:
    return NULL if _isna(x) else f"{int(x):,}"


def day(x: Any) -> str:
    return NULL if _isna(x) else pd.Timestamp(x).strftime("%Y-%m-%d")


def esc(text: Any) -> str:
    """Make a value safe to sit inside a table cell."""
    return str(text).replace("\r", " ").replace("\n", " ").replace("|", r"\|")


def table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    aligns: Sequence[str] | None = None,
) -> str:
    """A padded pipe table.

    Padded rather than minimal because these reports get read in a
    terminal and in a diff at least as often as in a markdown viewer,
    and an unpadded table is unreadable in two of those three.
    """
    if not headers:
        return ""
    aligns = list(aligns or ["l"] * len(headers))
    cells = [[esc(h) for h in headers]] + [[esc(c) for c in r] for r in rows]
    widths = [max(3, *(len(row[i]) for row in cells)) for i in range(len(headers))]

    def line(row: Sequence[str]) -> str:
        return "| " + " | ".join(
            cell.rjust(widths[i]) if aligns[i] == "r" else cell.ljust(widths[i])
            for i, cell in enumerate(row)
        ) + " |"

    rule = "| " + " | ".join(
        ("-" * (widths[i] - 1) + ":") if aligns[i] == "r" else "-" * widths[i]
        for i in range(len(headers))
    ) + " |"
    return "\n".join([line(cells[0]), rule] + [line(r) for r in cells[1:]])


def frame_table(
    df: pd.DataFrame,
    columns: Sequence[tuple[Any, ...]],
    *,
    max_rows: int = 400,
) -> str:
    """Render selected columns of a frame, each with a stated formatter.

    `columns` is (source column, heading, formatter) and optionally a
    fourth element, the alignment. Explicit on all four counts: a results
    table that renders whatever the frame happens to carry will silently
    start printing a new column the day somebody adds one upstream, in a
    document whose value is that a reader can compare it against last
    month's. Alignment defaults to right, because most of these columns
    are numbers and a ragged column of decimals cannot be scanned.
    """
    if df is None or len(df) == 0:
        return "_No rows._"

    shown = df.head(max_rows)
    headers = [c[1] for c in columns]
    aligns = [c[3] if len(c) > 3 else "r" for c in columns]
    rows: list[list[str]] = []
    for _, row in shown.iterrows():
        rows.append(
            [
                c[2](row[c[0]]) if c[0] in shown.columns else NULL
                for c in columns
            ]
        )
    out = table(headers, rows, aligns)
    elided = len(df) - len(shown)
    if elided > 0:
        out += f"\n\n_Showing {len(shown):,} of {len(df):,} rows; {elided:,} elided._"
    return out


# -- the sceptic's log --------------------------------------------------


@dataclass(frozen=True)
class Check:
    """One thing that was attacked before the number above it was believed.

    `detail` carries the measurement rather than a verdict word, because
    a check that passed and a check that could not run both print
    something reassuring otherwise, and only one of them is evidence.
    """

    name: str
    passed: bool
    detail: str

    @property
    def verdict(self) -> str:
        return "PASS" if self.passed else "FAIL"


def checks_table(checks: Sequence[Check]) -> str:
    return table(
        ["Check", "", "What was measured"],
        [[c.name, c.verdict, c.detail] for c in checks],
        ["l", "l", "l"],
    )


def spliced_table(start: date, end: date) -> tuple[str, int]:
    """Every splice the window depends on, and how many there are.

    Half-overlap counts, which is `spliced_periods`' rule and not this
    function's: a run over 2006-2010 still depends on the cash splice
    for its first seventeen months, and a caveat that fires only when a
    period is wholly spliced is a caveat that never fires.
    """
    from ..portfolio.sleeves import SLEEVE_BY_KEY, spliced_periods

    splices = spliced_periods(start, end)
    if not splices:
        return (
            "_No splice touches this window: every sleeve vehicle traded "
            "for all of it._",
            0,
        )
    rows = [
        [
            f"{SLEEVE_BY_KEY[sp.sleeve].name} ({SLEEVE_BY_KEY[sp.sleeve].ticker})",
            f"{sp.start.isoformat()} to {sp.end.isoformat()}",
            sp.substitute or "**nothing — the sleeve was not held**",
            sp.justification,
        ]
        for sp in splices
    ]
    return table(
        ["Sleeve", "Dates", "What stood in", "Why"], rows, ["l", "l", "l", "l"]
    ), len(splices)
