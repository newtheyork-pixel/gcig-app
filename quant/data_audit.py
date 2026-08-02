"""Stage 1: certify the data, or refuse to.

This is the entry point that stands between a vendor's marketing copy
and every number the rest of the repository will ever print. It builds
a source, pulls the four frames once, runs every check in
`griffinquant.audit`, prints the verdict and writes the markdown record
that gets committed next to a set of results.

The one thing worth reading twice is the exit code. PASS and WARN exit
0, FAIL exits 1, and everything else — UNPROVABLE, SKIPPED, a source
that could not be reached at all — exits 2. That third bucket is
deliberate and it is the whole reason this file has opinions about
process control. "We could not check" is not a weaker form of "we
checked and it was fine"; it is the absence of evidence, and the moment
it exits 0 somebody wires this into a pipeline, sees green, and ships a
Sharpe ratio computed on a dataset nobody ever examined. A non-zero
exit is the only thing that survives being skimmed.

The panel behind `--source synthetic` is `griffinquant.data.synthetic`.
It briefly was not: this file carried a second generator of its own,
written in the same parallel phase and unable to import a library that
did not exist yet, and the two drifted into having different defects —
this one could break the back-adjustment and could not hide a split,
the library's could do the reverse. What survives here is the
vocabulary: the hyphenated name a person types and the one line saying
what it does to the data. That is not decoration. `--inject-bias
survivorship` builds a panel with the graveyard deleted and the report
has to catch it, and a check that has never been shown to fail is a
check nobody should trust to pass.
"""

from __future__ import annotations

import sys
import traceback
from datetime import date, datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Callable, NamedTuple

import pandas as pd
import typer

from griffinquant import config
from griffinquant.audit import pointintime, quality, survivorship
from griffinquant.audit.context import AuditContext, load_context
from griffinquant.audit.report import print_console, render_markdown
from griffinquant.audit.result import AuditReport, CheckResult, Verdict
from griffinquant.data.base import DataSource, SourceUnavailable
from griffinquant.data.cache import CacheKey, ParquetCache
from griffinquant.data.sharadar import SharadarSource
from griffinquant.data.synthetic import Bias, SyntheticSource

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "data_audit_report.md"

#: PASS and WARN are the only states a pipeline may treat as green. See
#: the module docstring for why UNPROVABLE is not one of them.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NOT_PROVEN = 2

_EXIT_FOR = {
    Verdict.PASS: EXIT_OK,
    Verdict.WARN: EXIT_OK,
    Verdict.FAIL: EXIT_FAILED,
}

#: Every check in the repository, in the order a reader would want to
#: meet them: is the graveyard here, does the panel know only what the
#: day knew, do the bars contradict themselves.
CHECK_MODULES = (survivorship, pointintime, quality)


class Source(str, Enum):
    sharadar = "sharadar"
    synthetic = "synthetic"


# -- the smoke-test vocabulary ------------------------------------------

#: Fixed, and never a clock. Two runs of the smoke test a week apart
#: must differ only where the requested date range differs, or the
#: harness cannot be used to tell a code change from a data change.
#: Passed to the source explicitly rather than left to its default, so
#: the number this file prints into the provenance table is the number
#: the panel was actually drawn with.
SYNTHETIC_SEED = 20050103


class _BiasOption(NamedTuple):
    """A name somebody types, and what it does to the panel."""

    bias: Bias
    description: str


#: Named so the failure mode is the first thing a reader sees, and
#: described in the terms of the check each one is meant to trip.
#:
#: The keys are the CLI's own hyphenated vocabulary and not the enum's,
#: because nobody types `--inject-bias adjusted_only`. The descriptions
#: are what makes a wrong guess self-correcting: the unknown-bias error
#: prints this table whole, so a typo is answered with the menu rather
#: than with a list of eight identifiers a reader would then have to go
#: and look up.
BIASES: dict[str, _BiasOption] = {
    "survivorship": _BiasOption(
        Bias.SURVIVORSHIP,
        "delete every delisted entity and all of its price history — the "
        "original bug, a panel assembled from the companies that exist "
        "today",
    ),
    "ticker-recycling": _BiasOption(
        Bias.TICKER_COLLISION,
        "weld each recycled symbol's successor onto the dead company's "
        "permaticker, so Wachovia's series runs through Weibo's",
    ),
    "lookahead-fundamentals": _BiasOption(
        Bias.LOOKAHEAD_FUNDAMENTALS,
        "stamp every filing as public on the day its quarter closed, which "
        "hands a backtest the numbers ~50 days before the market had them",
    ),
    "restated-fundamentals": _BiasOption(
        Bias.RESTATED_FUNDAMENTALS,
        "serve most-recent-reported figures under the as-reported label: "
        "what the company admitted in 2013, dated 2011",
    ),
    "adjusted-prices": _BiasOption(
        Bias.ADJUSTED_ONLY,
        "return the back-adjusted close under both headings, so every price "
        "and liquidity screen silently reads adjusted numbers",
    ),
    "phantom-sessions": _BiasOption(
        Bias.FABRICATED_SESSIONS,
        "print bars on days the exchange was shut — fills nobody could have "
        "got, on trades that never happened",
    ),
    # The pair below are mirror images and belong next to each other. In
    # one the tape moves and the record is silent; in the other the
    # record is complete and the adjustment moved anyway. Only one of
    # them was ever reachable from this CLI, which is what the merge
    # fixed.
    "unrecorded-splits": _BiasOption(
        Bias.UNRECORDED_SPLITS,
        "apply the splits to the prices and leave them out of the actions "
        "frame, so the tape moves 75% in a session and nothing on the "
        "record explains it",
    ),
    "broken-adjustment": _BiasOption(
        Bias.BROKEN_ADJUSTMENT,
        "back-adjust for corporate actions that never happened, on sessions "
        "clear of every real one, so total return and price return quietly "
        "disagree",
    ),
}


# -- wiring -------------------------------------------------------------


def _widen_calendar_bounds(start: date, end: date) -> None:
    """Give exchange_calendars a wider default span before anything reads it.

    The library builds a calendar covering twenty years back from today
    unless it is told otherwise, and `AuditContext.sessions` asks for
    `get_calendar("XNYS")` with no bounds at all. Audit a sample that
    opens in 2005 from a machine whose clock says 2026 and every
    calendar-aware check dies on DateOutOfBounds — which this harness
    would then faithfully report as a dozen UNPROVABLE verdicts about
    the data, when the only thing that went wrong was a default.

    The synthetic generator does not need this; it builds its own
    calendar with explicit bounds. The audit that grades it does, and
    the grader is the half that decides what the report says — so a
    panel generated correctly over 2005-2006 would still be reported as
    fabricated sessions without this call.

    Patching a library global is a smell and it lives here anyway: the
    span is a property of the process, and the alternative is threading
    a calendar object through four modules that have no business
    knowing one exists. Called once, from the entry point, before any
    calendar has been built.
    """
    from exchange_calendars import exchange_calendar as ec

    lo = pd.Timestamp(start) - pd.Timedelta(days=400)
    hi = pd.Timestamp(end) + pd.Timedelta(days=400)
    if lo < ec.GLOBAL_DEFAULT_START:
        ec.GLOBAL_DEFAULT_START = lo
    if hi > ec.GLOBAL_DEFAULT_END:
        ec.GLOBAL_DEFAULT_END = hi


class _SharadarCacheAdapter:
    """Two cache interfaces that were written apart, joined here.

    `SharadarSource` asks its cache for a string key and offers to build
    the frame; `ParquetCache` keys on a `CacheKey` and wants a stamp. The
    adapter is one method wide and belongs at the seam rather than
    inside either module — and it maps the vendor's table names onto the
    cache's frame names so the TTL rules apply. Without that mapping
    every entry falls to the unknown-frame default and a twenty-year
    price pull is re-downloaded daily.
    """

    _FRAMES = {
        "tickers": "security_master",
        "sep": "prices",
        "actions": "actions",
        "sf1": "fundamentals",
    }

    def __init__(
        self, cache: ParquetCache, *, end: date, stamped: datetime
    ) -> None:
        self._cache = cache
        self._end = end
        self._stamped = stamped

    def get_or_fetch(
        self, key: str, build: Callable[[], pd.DataFrame]
    ) -> pd.DataFrame:
        parts = key.split("/")
        table = parts[1] if len(parts) > 1 else "unknown"
        ck = CacheKey(
            source="sharadar",
            frame=self._FRAMES.get(table, table),
            # `end` rides along so the cache can tell a closed historical
            # range from one that is still accruing today's bar.
            params={"key": key, "end": self._end},
        )
        return self._cache.get_or_load(
            ck, build, stamped=self._stamped, now=self._stamped
        )


def _run_checks(ctx: AuditContext) -> list[CheckResult]:
    """Every check, and a survivable answer when one of them explodes.

    A check that raises is a bug in the audit, not a finding about the
    data, and it must not read as either a pass or a failure. UNPROVABLE
    is the honest verdict — nothing was tested — and it exits non-zero,
    so a broken check cannot quietly certify a dataset.
    """
    results: list[CheckResult] = []
    for module in CHECK_MODULES:
        for check in module.CHECKS:
            name = getattr(check, "__name__", repr(check))
            try:
                results.append(check(ctx))
            except Exception as exc:  # noqa: BLE001 - see the docstring
                results.append(
                    CheckResult(
                        key=f"harness.{name}",
                        title=f"{name} (did not complete)",
                        verdict=Verdict.UNPROVABLE,
                        blocking=True,
                        headline=(
                            f"{name} raised {type(exc).__name__} and returned "
                            "no verdict."
                        ),
                        unprovable_reason=(
                            f"The check itself failed: {type(exc).__name__}: "
                            f"{exc}. This says nothing about the data — it "
                            "says the audit did not run. Fix the check and "
                            "rerun; do not read the rest of this report as a "
                            "complete examination.\n\n"
                            + traceback.format_exc(limit=6)
                        ),
                    )
                )
    return results


def _build_source(
    source: Source,
    start: date,
    end: date,
    *,
    bias: str | None,
    use_cache: bool,
    stamped: datetime,
) -> tuple[DataSource, dict[str, str]]:
    if source is Source.synthetic:
        # The provenance table records the name that was typed, not the
        # enum member it resolved to. A reader reproducing the run
        # retypes the command, and the command is spelled in hyphens.
        return (
            SyntheticSource(
                start,
                end,
                seed=SYNTHETIC_SEED,
                bias=BIASES[bias].bias if bias else Bias.NONE,
            ),
            {
                "panel": "synthetic, generated in-process",
                "seed": str(SYNTHETIC_SEED),
                "injected bias": bias or "none (clean panel)",
                "warning": (
                    "SMOKE TEST ONLY. Nothing in this report is a statement "
                    "about any real security."
                ),
            },
        )

    cache = None
    cache_note = "disabled (--no-cache)"
    if use_cache:
        store = ParquetCache()
        cache = _SharadarCacheAdapter(store, end=end, stamped=stamped)
        cache_note = str(store.root)
    return SharadarSource(cache=cache), {"cache": cache_note}


def _explain_unavailable(exc: SourceUnavailable, source: Source) -> None:
    """The path that actually runs today, so make it worth reading."""
    from rich.console import Console
    from rich.padding import Padding

    err = Console(stderr=True)
    err.print()
    err.print("[bold red]The audit did not run: the data source is not there.[/]")
    err.print()
    err.print(Padding(str(exc), (0, 4)))
    err.print()
    if source is Source.sharadar:
        err.print(
            "Sharadar is read through Nasdaq Data Link and needs a key in the\n"
            "environment. Set [bold]NASDAQ_DATA_LINK_API_KEY[/] (the older\n"
            "[bold]QUANDL_API_KEY[/] is accepted too) and run this again."
        )
        err.print()
    err.print(
        "No report was written, and that is the point. This tool exists to\n"
        "certify a dataset, and a dataset that could not be reached has not\n"
        "been certified — it has not been examined at all. Emitting a report\n"
        "here would produce a document that looks exactly like a clean one."
    )
    err.print()
    err.print(
        "To exercise the harness itself without a key:\n"
        "  [bold]python data_audit.py --source synthetic[/]\n"
        "  [bold]python data_audit.py --source synthetic "
        "--inject-bias survivorship[/]\n"
        "The second builds a panel with the graveyard deleted; if the report\n"
        "comes back anything other than FAIL, the audit is broken."
    )
    err.print()


app = typer.Typer(
    add_completion=False,
    help=(
        "Audit a securities panel for survivorship bias, point-in-time "
        "integrity and internal consistency, and refuse to certify what it "
        "could not check."
    ),
)


@app.command()
def main(
    source: Source = typer.Option(
        Source.sharadar, "--source", help="Which panel to audit."
    ),
    start: str = typer.Option(
        config.SAMPLE_START, "--start", help="First date, ISO. Bounds the pull."
    ),
    end: str = typer.Option(
        None, "--end", help="Last date, ISO. Defaults to today."
    ),
    inject_bias: str = typer.Option(
        None,
        "--inject-bias",
        help=(
            "Synthetic only: corrupt the panel in one named way and check "
            "the audit catches it. One of: " + ", ".join(BIASES)
        ),
    ),
    out: Path = typer.Option(
        DEFAULT_REPORT, "--out", help="Where to write the markdown report."
    ),
    no_cache: bool = typer.Option(
        False, "--no-cache", help="Ignore the on-disk parquet cache and refetch."
    ),
    quiet: bool = typer.Option(
        False, "--quiet", help="Write the report, print nothing but errors."
    ),
) -> None:
    # One clock reading for the whole run, threaded into the cache stamp
    # and both renderings of the report. Read it twice and a slow audit
    # produces a report whose header disagrees with its own provenance
    # table, which is a small lie in a document whose entire value is
    # that it does not tell them.
    generated_at = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat(sep=" ")
    )
    stamped = datetime.now(timezone.utc).replace(microsecond=0)

    try:
        start_date = date.fromisoformat(start)
    except ValueError as exc:
        raise typer.BadParameter(f"--start {start!r} is not an ISO date") from exc
    try:
        end_date = date.today() if end is None else date.fromisoformat(end)
    except ValueError as exc:
        raise typer.BadParameter(f"--end {end!r} is not an ISO date") from exc
    if end_date <= start_date:
        raise typer.BadParameter("--end must fall after --start")

    _widen_calendar_bounds(start_date, end_date)

    if inject_bias is not None:
        if source is not Source.synthetic:
            raise typer.BadParameter(
                "--inject-bias only applies to --source synthetic. Corrupting "
                "a real vendor pull would produce a report about damage this "
                "tool did rather than about the dataset."
            )
        if inject_bias not in BIASES:
            raise typer.BadParameter(
                f"unknown bias {inject_bias!r}. Known: "
                + "; ".join(f"{k} — {v.description}" for k, v in BIASES.items())
            )

    try:
        src, extra_provenance = _build_source(
            source,
            start_date,
            end_date,
            bias=inject_bias,
            use_cache=not no_cache,
            stamped=stamped,
        )
        ctx = load_context(src, start_date, end_date)
    except SourceUnavailable as exc:
        _explain_unavailable(exc, source)
        raise typer.Exit(EXIT_NOT_PROVEN)

    report = AuditReport(source_label=src.label)
    for result in _run_checks(ctx):
        report.add(result)

    report.provenance = {
        **ctx.provenance,
        **extra_provenance,
        "command": " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]),
        "report": str(out),
    }

    if not quiet:
        print_console(report)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(report, generated_at=generated_at), "utf-8")

    if not quiet:
        from rich.console import Console

        Console().print(f"  written to {out}", style="dim")

    raise typer.Exit(_EXIT_FOR.get(report.verdict, EXIT_NOT_PROVEN))


if __name__ == "__main__":
    app()
