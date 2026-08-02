"""Result types for the data audit.

There are five verdicts and the interesting one is UNPROVABLE.

A check that the source cannot feed has not passed. It has not failed
either — nothing was tested. Collapsing that state into PASS is how a
dataset acquires a clean bill of health it never earned, and it is the
same mistake as reporting a screen as clear when only half of it ran.
So UNPROVABLE is its own verdict, it never rolls up into a pass, and
the report prints the reason the evidence was missing rather than a
tick.

The rollup is deliberately pessimistic in the same way: one FAIL makes
the whole audit a FAIL, and an audit with nothing worse than an
UNPROVABLE is still not a PASS. A dataset is certified only when every
check that matters actually ran and actually passed.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

import pandas as pd


class Verdict(enum.Enum):
    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    UNPROVABLE = "UNPROVABLE"
    SKIPPED = "SKIPPED"

    @property
    def marker(self) -> str:
        return {
            "PASS": "PASS",
            "WARN": "WARN",
            "FAIL": "FAIL",
            "UNPROVABLE": "UNPROVABLE",
            "SKIPPED": "SKIPPED",
        }[self.value]


#: Worst-first, for the rollup and for report ordering.
_SEVERITY_ORDER = [
    Verdict.FAIL,
    Verdict.UNPROVABLE,
    Verdict.WARN,
    Verdict.PASS,
    Verdict.SKIPPED,
]


@dataclass
class Finding:
    """One observation inside a check.

    `detail` carries the specific instance — the ticker, the date, the
    number that was wrong. A finding without a reproducible detail
    sends somebody looking and gives them nowhere to look.
    """

    verdict: Verdict
    message: str
    detail: str | None = None


@dataclass
class CheckResult:
    """The outcome of one audit check.

    `blocking` marks a check whose failure invalidates any strategy
    result computed on this dataset. Survivorship is blocking. A
    handful of missing sessions in 2007 is not.
    """

    key: str
    title: str
    verdict: Verdict
    headline: str
    blocking: bool = True
    findings: list[Finding] = field(default_factory=list)
    #: Rendered into the report as markdown tables, in insertion order.
    tables: dict[str, pd.DataFrame] = field(default_factory=dict)
    #: Why the evidence was unavailable. Required when UNPROVABLE.
    unprovable_reason: str | None = None

    def __post_init__(self) -> None:
        if self.verdict is Verdict.UNPROVABLE and not self.unprovable_reason:
            raise ValueError(
                f"check {self.key!r} is UNPROVABLE but gives no reason; "
                "an unexplained absence of evidence is indistinguishable "
                "from a pass, which is the thing this verdict exists to "
                "prevent"
            )

    def add(self, verdict: Verdict, message: str, detail: str | None = None) -> None:
        self.findings.append(Finding(verdict, message, detail))

    @property
    def worst_finding(self) -> Verdict:
        for v in _SEVERITY_ORDER:
            if any(f.verdict is v for f in self.findings):
                return v
        return Verdict.PASS


@dataclass
class AuditReport:
    """Every check, plus the one verdict that matters."""

    source_label: str
    checks: list[CheckResult] = field(default_factory=list)
    #: Free-text notes about how the audit itself was run.
    provenance: dict[str, str] = field(default_factory=dict)

    def add(self, check: CheckResult) -> CheckResult:
        self.checks.append(check)
        return check

    def by_verdict(self, verdict: Verdict) -> list[CheckResult]:
        return [c for c in self.checks if c.verdict is verdict]

    @property
    def verdict(self) -> Verdict:
        """Pessimistic rollup over the blocking checks.

        Non-blocking checks can colour the report but never decide it —
        otherwise a stale trading-session gap would veto a dataset that
        is fundamentally sound, and people would learn to ignore the
        headline.
        """
        blocking = [c for c in self.checks if c.blocking]
        for v in (Verdict.FAIL, Verdict.UNPROVABLE, Verdict.WARN):
            if any(c.verdict is v for c in blocking):
                return v
        if blocking and all(c.verdict is Verdict.SKIPPED for c in blocking):
            return Verdict.SKIPPED
        return Verdict.PASS

    @property
    def usable_for_research(self) -> bool:
        """Whether strategy code may be run against this dataset.

        WARN is usable with the warnings read. UNPROVABLE and FAIL are
        not — in the first case because the dataset has not been shown
        to be sound, and there is no version of "we did not check" that
        belongs underneath a reported Sharpe ratio.
        """
        return self.verdict in (Verdict.PASS, Verdict.WARN)

    def counts(self) -> dict[str, int]:
        return {
            v.value: sum(1 for c in self.checks if c.verdict is v)
            for v in _SEVERITY_ORDER
        }
