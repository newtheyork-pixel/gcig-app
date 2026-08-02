"""The rollup, and the one verdict that has to survive being skimmed.

Four of the five verdicts behave the way anybody would guess. UNPROVABLE
is the one worth a test file, because it is the state that looks like a
pass from a distance and means the opposite of one: nothing was tested.
Every assertion here is aimed at one of the two ways that distinction
gets quietly lost — an UNPROVABLE rolling up into a green headline, and
an UNPROVABLE recorded without the reason its evidence was missing,
which leaves a reader unable to tell "we could not check" from "we
checked and it was fine".

The other property under test is that non-blocking checks colour the
report and never decide it. Without that, one stale trading session in
2007 vetoes a sound dataset, people learn the headline is noise, and
the whole document stops being read.
"""

from __future__ import annotations

import pandas as pd
import pytest

from griffinquant.audit.result import (
    AuditReport,
    CheckResult,
    Finding,
    Verdict,
    _SEVERITY_ORDER,
)


def check(
    verdict: Verdict,
    *,
    key: str = "k",
    blocking: bool = True,
    reason: str | None = None,
) -> CheckResult:
    if verdict is Verdict.UNPROVABLE and reason is None:
        reason = "the source supplies nothing this check could read"
    return CheckResult(
        key=key,
        title=key,
        verdict=verdict,
        headline=f"{verdict.value} headline",
        blocking=blocking,
        unprovable_reason=reason,
    )


def report(*checks: CheckResult) -> AuditReport:
    out = AuditReport(source_label="fixture")
    for c in checks:
        out.add(c)
    return out


# -- the pessimistic rollup ----------------------------------------------


@pytest.mark.parametrize(
    ("present", "expected"),
    [
        ([Verdict.FAIL, Verdict.UNPROVABLE, Verdict.WARN, Verdict.PASS], Verdict.FAIL),
        ([Verdict.UNPROVABLE, Verdict.WARN, Verdict.PASS], Verdict.UNPROVABLE),
        ([Verdict.WARN, Verdict.PASS], Verdict.WARN),
        ([Verdict.PASS, Verdict.PASS], Verdict.PASS),
    ],
)
def test_the_worst_blocking_verdict_wins(present, expected):
    rep = report(*(check(v, key=v.value) for v in present))
    assert rep.verdict is expected


def test_one_failure_among_many_passes_still_fails_the_audit():
    rep = report(*(check(Verdict.PASS, key=f"p{i}") for i in range(9)))
    assert rep.verdict is Verdict.PASS
    rep.add(check(Verdict.FAIL, key="the one"))
    assert rep.verdict is Verdict.FAIL


def test_unprovable_never_rolls_up_to_a_pass():
    # Said twice on purpose: once as the verdict and once as the
    # permission. A dataset that has not been shown to be sound must not
    # acquire a clean bill of health by having nothing else go wrong.
    rep = report(check(Verdict.PASS, key="a"), check(Verdict.UNPROVABLE, key="b"))
    assert rep.verdict is Verdict.UNPROVABLE
    assert rep.verdict is not Verdict.PASS


def test_unprovable_outranks_warn():
    rep = report(check(Verdict.WARN, key="a"), check(Verdict.UNPROVABLE, key="b"))
    assert rep.verdict is Verdict.UNPROVABLE


def test_fail_outranks_unprovable():
    rep = report(check(Verdict.UNPROVABLE, key="a"), check(Verdict.FAIL, key="b"))
    assert rep.verdict is Verdict.FAIL


def test_usable_for_research_is_false_on_unprovable():
    assert not report(check(Verdict.UNPROVABLE)).usable_for_research
    assert not report(check(Verdict.FAIL)).usable_for_research
    # WARN is usable with the warnings read; that is the whole point of
    # having a fourth verdict rather than folding it into FAIL.
    assert report(check(Verdict.WARN)).usable_for_research
    assert report(check(Verdict.PASS)).usable_for_research


def test_a_non_blocking_failure_colours_the_report_without_vetoing_it():
    rep = report(
        check(Verdict.PASS, key="blocking"),
        check(Verdict.FAIL, key="advisory", blocking=False),
    )
    assert rep.verdict is Verdict.PASS
    assert rep.usable_for_research
    # It still has to be findable — an advisory failure that vanishes
    # from the report is not advisory, it is deleted.
    assert [c.key for c in rep.by_verdict(Verdict.FAIL)] == ["advisory"]


def test_an_all_skipped_audit_reports_skipped_rather_than_pass():
    rep = report(check(Verdict.SKIPPED, key="a"), check(Verdict.SKIPPED, key="b"))
    assert rep.verdict is Verdict.SKIPPED
    assert not rep.usable_for_research


def test_a_skipped_check_beside_a_real_pass_does_not_drag_the_audit_down():
    rep = report(check(Verdict.SKIPPED, key="a"), check(Verdict.PASS, key="b"))
    assert rep.verdict is Verdict.PASS


def test_an_audit_with_no_checks_rolls_up_to_pass():
    # Arithmetically true and practically a trap, which is why the
    # report module prints a caveat against it. Pinned here so nobody
    # "fixes" it in one place and leaves the other saying otherwise.
    assert report().verdict is Verdict.PASS


# -- the reason requirement ----------------------------------------------


def test_unprovable_without_a_reason_is_refused_at_construction():
    with pytest.raises(ValueError) as exc:
        CheckResult(
            key="silent",
            title="Silent",
            verdict=Verdict.UNPROVABLE,
            headline="nothing to see",
        )
    assert "silent" in str(exc.value)
    assert "indistinguishable from a pass" in str(exc.value)


def test_an_empty_string_is_not_a_reason():
    with pytest.raises(ValueError):
        CheckResult(
            key="silent",
            title="Silent",
            verdict=Verdict.UNPROVABLE,
            headline="nothing to see",
            unprovable_reason="",
        )


@pytest.mark.parametrize(
    "verdict", [Verdict.PASS, Verdict.WARN, Verdict.FAIL, Verdict.SKIPPED]
)
def test_every_other_verdict_may_stay_silent(verdict: Verdict):
    CheckResult(key="k", title="K", verdict=verdict, headline="h")


# -- findings ------------------------------------------------------------


def test_worst_finding_reads_the_same_severity_order_as_the_rollup():
    res = check(Verdict.PASS)
    assert res.worst_finding is Verdict.PASS  # no findings is not a failure
    res.add(Verdict.PASS, "fine")
    res.add(Verdict.WARN, "hmm")
    assert res.worst_finding is Verdict.WARN
    res.add(Verdict.UNPROVABLE, "could not look")
    assert res.worst_finding is Verdict.UNPROVABLE
    res.add(Verdict.FAIL, "broken")
    assert res.worst_finding is Verdict.FAIL


def test_a_findings_verdict_does_not_silently_move_the_checks():
    # The check's verdict is the author's judgement, not a maximum over
    # its findings: `dead_names_priced` deliberately files a note at the
    # check's own level rather than louder than it.
    res = check(Verdict.PASS)
    res.add(Verdict.FAIL, "a detail somebody chose to file quietly")
    assert res.verdict is Verdict.PASS
    assert res.worst_finding is Verdict.FAIL


def test_add_records_the_detail_that_makes_a_finding_reproducible():
    res = check(Verdict.FAIL)
    res.add(Verdict.FAIL, "message", "WM on 2008-09-25")
    assert res.findings == [Finding(Verdict.FAIL, "message", "WM on 2008-09-25")]


# -- bookkeeping ---------------------------------------------------------


def test_counts_covers_every_verdict_and_sums_to_the_check_count():
    rep = report(
        check(Verdict.PASS, key="a"),
        check(Verdict.PASS, key="b"),
        check(Verdict.WARN, key="c"),
        check(Verdict.FAIL, key="d"),
        check(Verdict.UNPROVABLE, key="e"),
        check(Verdict.SKIPPED, key="f"),
    )
    counts = rep.counts()
    assert set(counts) == {v.value for v in Verdict}
    assert sum(counts.values()) == len(rep.checks)
    assert counts["PASS"] == 2


def test_severity_order_is_worst_first_and_complete():
    # report.py sorts its sections by this list, so a verdict missing
    # from it would sort to the bottom of a report rather than the top.
    assert set(_SEVERITY_ORDER) == set(Verdict)
    assert _SEVERITY_ORDER[0] is Verdict.FAIL
    assert _SEVERITY_ORDER.index(Verdict.UNPROVABLE) < _SEVERITY_ORDER.index(
        Verdict.WARN
    )


def test_add_returns_the_check_so_a_caller_can_keep_building_it():
    rep = AuditReport(source_label="fixture")
    res = rep.add(check(Verdict.PASS))
    res.tables["evidence"] = pd.DataFrame({"x": [1]})
    assert rep.checks[0].tables["evidence"].shape == (1, 1)


def test_every_verdict_prints_its_own_name():
    # The marker is what a reader greps for. A blank or shared marker
    # would make two states indistinguishable in the one place that
    # matters most.
    markers = {v.marker for v in Verdict}
    assert markers == {v.value for v in Verdict}
    assert len(markers) == len(Verdict)
