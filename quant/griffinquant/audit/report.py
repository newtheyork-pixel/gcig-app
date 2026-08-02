"""Turning an AuditReport into something a person will actually read.

Two surfaces, one judgement. `render_markdown` writes the record that
gets committed next to a set of results; `print_console` prints the
version you look at while the audit is still running. Both derive the
headline sentence from the same helper, because a report that says one
thing in the terminal and something softer in the file is worse than
either on its own — somebody will quote whichever one suits them.

Three traps this module exists to avoid.

The verdict goes first and goes in plain English. An audit whose
conclusion has to be assembled by the reader from a table of ticks is
an audit that gets skimmed, and the one state that must never be
skimmed is UNPROVABLE: it looks like a pass from a distance and means
the opposite of one. So the block at the top says whether strategy
code may be run, in a sentence, before anything else on the page.

Sections are ordered worst-verdict-first. Chronological order — the
order the checks happened to be registered in — buries the one failure
underneath nine passes, which is the same defect as a green build with
a skipped test suite.

And the timestamp is an argument. Nothing here reads the wall clock,
so two runs over the same frames produce byte-identical output and a
test can diff it. That constraint costs one parameter and buys the
ability to notice that a report changed.

Tables are rendered by hand rather than through `DataFrame.to_markdown`,
which quietly needs `tabulate` — a dependency that would only announce
itself at the moment somebody tries to print a failing audit.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

import pandas as pd

# Private, but result.py's own comment names report ordering as one of
# the two things this list is for. Copying the order into this file is
# how the report and the rollup end up disagreeing about which of WARN
# and UNPROVABLE is worse.
from .result import _SEVERITY_ORDER, AuditReport, CheckResult, Finding, Verdict

__all__ = ["render_markdown", "print_console", "MAX_TABLE_ROWS"]


#: Past thirty rows a table stops being evidence and becomes a dump.
#: The count of what was dropped is always printed, because a silently
#: truncated table is a lie about the size of the problem.
MAX_TABLE_ROWS = 30

#: Long free text in a cell wrecks the column widths for everything
#: below it. Findings are where prose belongs; tables carry values.
MAX_CELL_CHARS = 100

NULL = "—"

_SEVERITY_RANK = {v: i for i, v in enumerate(_SEVERITY_ORDER)}

_CONSOLE_STYLE = {
    Verdict.PASS: "green",
    Verdict.WARN: "yellow",
    Verdict.FAIL: "bold red",
    Verdict.UNPROVABLE: "bold magenta",
    Verdict.SKIPPED: "dim",
}


# -- the sentence everything else hangs off -----------------------------


def _one_liner(report: AuditReport) -> str:
    """Whether strategy code may be run, said once and said plainly."""
    if report.usable_for_research:
        if report.verdict is Verdict.WARN:
            return (
                "Strategy code may be run against this dataset, provided "
                "the warnings below are read first."
            )
        return "Strategy code may be run against this dataset."
    return "Strategy code must not be run against this dataset."


def _why(report: AuditReport) -> str:
    """The paragraph under the sentence: what the verdict rests on."""
    verdict = report.verdict

    if verdict is Verdict.FAIL:
        failed = [c.title for c in report.by_verdict(Verdict.FAIL) if c.blocking]
        lead = "A blocking check failed" if len(failed) == 1 else (
            f"{len(failed)} blocking checks failed"
        )
        # Name a few and count the rest. A verdict block that turns into
        # a list of twenty titles has stopped being a verdict block.
        shown = "; ".join(failed[:3])
        if len(failed) > 3:
            shown += f"; and {len(failed) - 3} more"
        return (
            f"{lead} ({shown or 'see below'}). Numbers produced from this "
            "data would be properties of the defect rather than of the "
            "market, and no amount of care further down the stack "
            "recovers from that."
        )

    if verdict is Verdict.UNPROVABLE:
        n = len([c for c in report.by_verdict(Verdict.UNPROVABLE) if c.blocking])
        plural = "check" if n == 1 else "checks"
        return (
            "The dataset was not shown to be sound. **This is not the "
            f"same as having failed — nothing was tested.** {n} blocking "
            f"{plural} could not be run at all, because the source does "
            "not supply the evidence they need, so the data is neither "
            "clean nor dirty: it is unexamined. Each section below gives "
            "the reason its evidence was missing. Either find a source "
            "that can answer them, or carry the open questions, in "
            "writing, everywhere the results appear."
        )

    if verdict is Verdict.WARN:
        return (
            "Every blocking check ran and none failed, but at least one "
            "came back with a caveat. The WARN sections mark the parts of "
            "the sample that deserve less confidence; they are not a "
            "reason to stop, they are a reason to know which numbers you "
            "are leaning on."
        )

    if verdict is Verdict.SKIPPED:
        return (
            "Every blocking check was skipped, so nothing at all was "
            "verified here. Treat this exactly as you would an unaudited "
            "dataset, because that is what it is."
        )

    return (
        "Every blocking check ran and passed. That is a statement about "
        "this dataset's internal consistency and about its retention of "
        "the names that died — read the closing section for what it is "
        "not a statement about."
    )


def _counts_line(report: AuditReport) -> str:
    counts = report.counts()
    parts = [f"{n} {name}" for name, n in counts.items() if n]
    total = len(report.checks)
    noun = "check" if total == 1 else "checks"
    if not parts:
        return f"{total} {noun}."
    return f"{total} {noun}: " + ", ".join(parts) + "."


# -- small markdown primitives ------------------------------------------


def _esc(text: str) -> str:
    """Make a value safe to sit inside a table cell."""
    out = str(text).replace("\r", " ").replace("\n", " ").replace("|", r"\|")
    if len(out) > MAX_CELL_CHARS:
        out = out[: MAX_CELL_CHARS - 1].rstrip() + "…"
    return out


def _clip(text: str, width: int) -> str:
    """One line, no wider than `width`, whitespace collapsed."""
    flat = " ".join(str(text).split())
    if width <= 0:
        return ""
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def _table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    aligns: Sequence[str] | None = None,
) -> str:
    """A padded pipe table.

    Padded rather than minimal because these reports are read as often
    in a terminal and in a diff as they are in a markdown viewer, and
    an unpadded table is unreadable in two of those three.
    """
    if not headers:
        return ""
    aligns = list(aligns or ["l"] * len(headers))
    cells = [list(headers)] + [list(r) for r in rows]
    widths = [
        max(3, *(len(row[i]) for row in cells)) for i in range(len(headers))
    ]

    def line(row: Sequence[str]) -> str:
        out = [
            cell.rjust(widths[i]) if aligns[i] == "r" else cell.ljust(widths[i])
            for i, cell in enumerate(row)
        ]
        return "| " + " | ".join(out) + " |"

    rule = "| " + " | ".join(
        ("-" * (widths[i] - 1) + ":") if aligns[i] == "r" else ("-" * widths[i])
        for i in range(len(headers))
    ) + " |"

    return "\n".join([line(headers), rule] + [line(r) for r in rows])


def _isna(value: Any) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _column_formatter(series: pd.Series) -> Callable[[Any], str]:
    """Pick one format for a whole column, not one per cell.

    A column rendering 0, 12.50 and 100 side by side reads as three
    different quantities and sends somebody looking for a data problem
    that does not exist. Deciding the format from the column's own
    range costs nothing and makes the eye's comparison the right one.
    """
    if pd.api.types.is_bool_dtype(series):
        return lambda v: NULL if _isna(v) else ("true" if v else "false")

    if pd.api.types.is_datetime64_any_dtype(series):
        live = series.dropna()
        midnight = bool(live.empty or (live.dt.normalize() == live).all())
        fmt = "%Y-%m-%d" if midnight else "%Y-%m-%d %H:%M"
        return lambda v: NULL if _isna(v) else pd.Timestamp(v).strftime(fmt)

    if pd.api.types.is_integer_dtype(series):
        # Deliberately no thousands separator. Most integers in an audit
        # frame are identifiers, and a permaticker printed as "199,059"
        # is not a number anyone can paste back into a query.
        return lambda v: NULL if _isna(v) else f"{int(v)}"

    if pd.api.types.is_float_dtype(series):
        live = series.dropna()
        if live.empty:
            return lambda v: NULL
        integral = bool(((live % 1) == 0).all())
        scale = float(live.abs().max())
        if integral:
            spec = ",.0f"
        elif scale < 0.001:
            spec = ".3e"
        else:
            # Show the precision the column actually carries and not one
            # digit more. A fixed four places prints an attrition rate of
            # 3.2% as "3.2000", which claims a measurement good to a
            # ten-thousandth of a percent — and the reader who takes that
            # at face value is exactly the reader this report is for.
            # Trailing zeros are free to print and not free to believe.
            places = 4
            for d in range(4):
                if float((live.round(d) - live).abs().max()) <= 5e-7:
                    places = d
                    break
            spec = f",.{places}f" if scale >= 1000 else f".{places}f"
        return lambda v: NULL if _isna(v) else format(float(v), spec)

    return lambda v: NULL if _isna(v) else _esc(v)


def _markdown_table(df: pd.DataFrame, *, max_rows: int = MAX_TABLE_ROWS) -> str:
    """Render a frame, capped, saying out loud what it left out."""
    if df is None or len(df) == 0:
        return "_No rows._"

    total = len(df)
    shown = df.head(max_rows)
    if shown.shape[1] == 0 and not isinstance(shown.index, pd.MultiIndex):
        return f"_{total:,} row(s), no columns._"

    # An index is worth a column when somebody named it — a groupby key,
    # a year, a ticker. The leftover positional index of a filtered
    # slice is just noise from an earlier operation.
    if isinstance(shown.index, pd.MultiIndex) or shown.index.name is not None:
        shown = shown.reset_index()

    headers = [_esc(c) for c in shown.columns]
    aligns = []
    columns: list[list[str]] = []
    for i in range(shown.shape[1]):
        # Positional, not by label: duplicate column names would hand
        # back a frame instead of a series and blow up on format.
        col = shown.iloc[:, i]
        numeric = pd.api.types.is_numeric_dtype(
            col
        ) and not pd.api.types.is_bool_dtype(col)
        aligns.append("r" if numeric else "l")
        fmt = _column_formatter(col)
        columns.append([fmt(v) for v in col.tolist()])

    rows = [list(r) for r in zip(*columns)] if columns else []
    out = _table(headers, rows, aligns)

    elided = total - len(shown)
    if elided > 0:
        out += (
            f"\n\n_Showing {len(shown):,} of {total:,} rows; "
            f"{elided:,} elided._"
        )
    return out


# -- the document -------------------------------------------------------


def _verdict_block(report: AuditReport, generated_at: str) -> list[str]:
    verdict = report.verdict
    lines = [
        f"# Data audit — {report.source_label}",
        "",
        f"> **VERDICT: {verdict.marker}**",
        ">",
        f"> **{_one_liner(report)}**",
    ]
    # An audit with no checks rolls up to PASS, which is arithmetically
    # true and practically a trap. The correction belongs against the
    # sentence it undoes, not at the bottom of the block where it reads
    # as a footnote to a clean bill of health.
    if not report.checks:
        lines += [
            ">",
            "> No checks were registered at all, so the verdict above is a "
            "statement about an empty audit and says nothing whatever "
            "about the data.",
        ]
    lines += [
        ">",
        f"> {_why(report)}",
        ">",
        f"> {_counts_line(report)} Generated {generated_at}.",
        "",
    ]
    return lines


def _provenance_block(report: AuditReport, generated_at: str) -> list[str]:
    prov: dict[str, str] = {"generated": generated_at, "source": report.source_label}
    prov.update(report.provenance)
    rows = [[_esc(k.replace("_", " ")), _esc(v)] for k, v in prov.items()]
    return ["## Provenance", "", _table(["Field", "Value"], rows), ""]


def _summary_block(checks: Sequence[CheckResult]) -> list[str]:
    if not checks:
        return ["## Checks", "", "_No checks were run._", ""]
    # The key rides along because titles are prose and two checks in
    # different families can reasonably share one. The key is what you
    # type to rerun a single check, which is the next thing anybody
    # reading this row wants to do.
    rows = [
        [
            _esc(c.title),
            f"`{_esc(c.key)}`",
            c.verdict.marker,
            "blocking" if c.blocking else "advisory",
            _esc(c.headline),
        ]
        for c in checks
    ]
    body = _table(["Check", "Key", "Verdict", "Scope", "Headline"], rows)
    return ["## Checks", "", body, ""]


def _findings_block(findings: Sequence[Finding]) -> list[str]:
    if not findings:
        return []
    # Worst-first inside the check too. A single FAIL sitting at position
    # thirty-seven of a list of passes has been reported and not read.
    ordered = sorted(findings, key=lambda f: _SEVERITY_RANK.get(f.verdict, 99))
    lines = ["**Findings**", ""]
    for f in ordered:
        lines.append(f"- **{f.verdict.marker}** — {f.message}")
        if f.detail:
            lines.append(f"  _{f.detail}_")
    lines.append("")
    return lines


def _check_section(check: CheckResult) -> list[str]:
    scope = "blocking" if check.blocking else "advisory"
    lines = [
        f"## {check.verdict.marker} · {check.title}",
        "",
        f"`{check.key}` · {scope}",
        "",
        check.headline,
        "",
    ]
    if check.verdict is Verdict.UNPROVABLE and check.unprovable_reason:
        lines += [f"> Not tested: {check.unprovable_reason}", ""]
    lines += _findings_block(check.findings)
    for name, frame in check.tables.items():
        lines += [f"**{name}**", "", _markdown_table(frame), ""]
    return lines


#: Written by hand and kept fixed on purpose. The limits of an audit do
#: not vary with its result, and a caveats section that is regenerated
#: from the findings would quietly shrink on a clean run — exactly when
#: somebody is most inclined to believe the dataset is finished.
_CANNOT_TELL_YOU = """## What this audit cannot tell you

Everything above is a statement about the dataset's internal
consistency and about whether it still holds the companies that died.
Those two failures are the ones that quietly invalidate a backtest,
which is why they are worth this much machinery. They are not the only
ones.

Nothing here can establish that the vendor's prices are the prices
that actually traded. Every check compares the data against itself,
against a trading calendar, and against the vendor's own record of
corporate actions. A consistently wrong close, a stale bar carried
forward across a halt, an adjustment factor mis-scaled the same way
everywhere — all of these pass, because internal consistency is
exactly what they preserve. Confirming prices means an independent
second source and a reconciliation, which is a different piece of work
with a different bill.

Several things are simply out of scope, and their absence from the
report is not evidence of their absence from the market. Index
membership as of a past date is not checked, so any universe defined
by membership cannot be reproduced from this. Borrow availability and
cost are not modelled: irrelevant to a long-only book, and fatal the
first day it stops being one. Halts, limit states and the days a name
could not be traded at any price do not appear in a daily bar at all.
Corporate-action edge cases — partial spin-offs, stub equities,
reverse splits used to dodge a delisting notice, rights offerings
priced below market — are examined only as far as the vendor tagged
them, and the ones that break a backtest are precisely the ones
vendors tag inconsistently.

Finally, a clean audit is not a forecast. It says the ground is level.
It says nothing about whether a strategy built on this data has an
edge, whether that edge survives costs and participation limits, or
whether it existed in the sample for a reason that will still be there
next year. A PASS removes one explanation for a good backtest. It does
not supply a better one.
"""


def render_markdown(report: AuditReport, *, generated_at: str) -> str:
    """The committed record of one audit run.

    `generated_at` is passed in rather than read here so the output is
    a pure function of the report — two runs over the same frames diff
    to nothing, and a change in the file means a change in the data.
    """
    ordered = sorted(
        report.checks, key=lambda c: _SEVERITY_RANK.get(c.verdict, 99)
    )

    lines: list[str] = []
    lines += _verdict_block(report, generated_at)
    lines += _provenance_block(report, generated_at)
    lines += _summary_block(ordered)
    for check in ordered:
        lines += _check_section(check)
    lines.append(_CANNOT_TELL_YOU)

    return "\n".join(lines).rstrip("\n") + "\n"


def print_console(report: AuditReport, *, console: Any = None) -> None:
    """The same judgement, at a glance, while you are still working.

    rich is imported here rather than at module scope so the markdown
    path — the one that runs in CI and in tests — carries no dependency
    on a terminal library it never uses.
    """
    from rich.console import Console
    from rich.text import Text

    console = console or Console()

    console.print(Text(f"Data audit — {report.source_label}", style="bold"))

    if not report.checks:
        console.print(Text("  no checks were run", style="dim"))
    else:
        rows = [
            (c, c.title if c.blocking else f"{c.title} (advisory)")
            for c in sorted(
                report.checks, key=lambda c: _SEVERITY_RANK.get(c.verdict, 99)
            )
        ]
        # Laid out by hand rather than through rich's Table. Given a
        # flexible column the layout engine will shrink the fixed ones to
        # make room, and at a couple of common terminal widths that means
        # the verdict — the coloured word the whole line exists for —
        # disappears entirely. Cheaper to do the arithmetic than to
        # discover that on somebody's laptop.
        width = max(40, console.width)
        title_w = max(14, min(44, max(len(t) for _, t in rows), (width - 14) // 2))
        head_w = width - 14 - title_w - 2

        for check, title in rows:
            line = Text()
            line.append(
                f"{check.verdict.marker:<10}  ",
                style=_CONSOLE_STYLE[check.verdict],
            )
            if head_w >= 12:
                line.append(_clip(title, title_w).ljust(title_w))
                line.append("  ")
                line.append(_clip(check.headline, head_w), style="dim")
            else:
                # Too narrow for a headline; don't pad out to a column
                # that isn't there and leave trailing whitespace behind.
                line.append(_clip(title, title_w))
            console.print(line, no_wrap=True, crop=True)

    console.print()
    style = _CONSOLE_STYLE[report.verdict]
    console.print(
        Text("VERDICT: ", style="bold")
        + Text(report.verdict.marker, style=style)
        + Text(" — " + _one_liner(report), style=style)
    )
    if report.verdict is Verdict.UNPROVABLE:
        # Left out, this line reads as a near-miss instead of an absence.
        console.print(
            Text("  not shown to be sound; nothing was tested", style="dim")
        )
    console.print(Text("  " + _counts_line(report), style="dim"))
