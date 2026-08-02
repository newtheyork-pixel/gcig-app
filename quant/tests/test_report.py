"""The document, which is the only part of the audit most people read.

Three properties are worth pinning here and they are all about how the
report behaves when somebody skims it.

It is a pure function of the report and the timestamp. Nothing reads
the wall clock, so two runs over the same frames diff to nothing and a
change in the committed file means a change in the data. A report that
churned on every run would train people to ignore its diffs, which is
the same as not writing it.

The banner has to say the right thing for each verdict, and especially
for UNPROVABLE — the state that looks like a pass from a distance. The
sentence at the top is a permission, not a summary: whether strategy
code may be run.

And a truncated table has to say how much it truncated. A table capped
silently at thirty rows is a lie about the size of the problem, and it
is a lie in the reassuring direction.
"""

from __future__ import annotations

import pandas as pd
import pytest

from griffinquant.audit.report import MAX_TABLE_ROWS, render_markdown
from griffinquant.audit.result import AuditReport, CheckResult, Verdict


STAMP = "2026-03-01 12:00:00+00:00"


def check(
    verdict: Verdict,
    *,
    key: str = "k",
    title: str | None = None,
    blocking: bool = True,
    headline: str = "a headline",
    reason: str | None = None,
) -> CheckResult:
    if verdict is Verdict.UNPROVABLE and reason is None:
        reason = "the source supplies no delisting dates"
    return CheckResult(
        key=key,
        title=title or f"Check {key}",
        verdict=verdict,
        headline=headline,
        blocking=blocking,
        unprovable_reason=reason,
    )


def report(*checks: CheckResult, label: str = "Fixture panel") -> AuditReport:
    out = AuditReport(source_label=label)
    for c in checks:
        out.add(c)
    out.provenance = {"range": "2008-01-01 to 2019-12-31", "entities": "312"}
    return out


# -- determinism ---------------------------------------------------------


def test_the_same_report_and_stamp_render_byte_identically():
    def build() -> AuditReport:
        rep = report(
            check(Verdict.PASS, key="a"),
            check(Verdict.FAIL, key="b"),
            check(Verdict.UNPROVABLE, key="c"),
        )
        rep.checks[1].add(Verdict.FAIL, "something broke", "WM on 2008-09-25")
        rep.checks[0].tables["evidence"] = pd.DataFrame(
            {"year": [2008, 2009], "delistings": [41, 22]}
        )
        return rep

    first = render_markdown(build(), generated_at=STAMP)
    second = render_markdown(build(), generated_at=STAMP)
    assert first == second
    # Rendering the same object twice must not mutate it either — the
    # sort is on a copy or it is not a pure function.
    rep = build()
    assert render_markdown(rep, generated_at=STAMP) == render_markdown(
        rep, generated_at=STAMP
    )


def test_the_timestamp_is_an_argument_and_nothing_else_moves():
    rep = report(check(Verdict.PASS))
    a = render_markdown(rep, generated_at=STAMP)
    b = render_markdown(rep, generated_at="2030-01-01 00:00:00+00:00")
    assert a != b
    assert STAMP in a
    # Two lines carry the stamp — the verdict block and the provenance
    # table — and they must agree, or a slow audit produces a document
    # that disagrees with itself.
    assert a.count(STAMP) == 2
    changed = [
        (x, y) for x, y in zip(a.splitlines(), b.splitlines()) if x != y
    ]
    assert len(changed) == 2


def test_sections_are_ordered_worst_verdict_first():
    # Chronological order buries the one failure underneath nine passes,
    # which is the same defect as a green build with a skipped suite.
    out = render_markdown(
        report(
            check(Verdict.PASS, key="pass", title="Passing check"),
            check(Verdict.SKIPPED, key="skip", title="Skipped check"),
            check(Verdict.WARN, key="warn", title="Warning check"),
            check(Verdict.FAIL, key="fail", title="Failing check"),
            check(Verdict.UNPROVABLE, key="unp", title="Unprovable check"),
        ),
        generated_at=STAMP,
    )
    order = [
        out.index(f"## {v.marker} · ")
        for v in (
            Verdict.FAIL,
            Verdict.UNPROVABLE,
            Verdict.WARN,
            Verdict.PASS,
            Verdict.SKIPPED,
        )
    ]
    assert order == sorted(order)


# -- the banner ----------------------------------------------------------


@pytest.mark.parametrize(
    ("checks", "verdict"),
    [
        ([Verdict.PASS], Verdict.PASS),
        ([Verdict.PASS, Verdict.WARN], Verdict.WARN),
        ([Verdict.PASS, Verdict.UNPROVABLE], Verdict.UNPROVABLE),
        ([Verdict.WARN, Verdict.FAIL], Verdict.FAIL),
        ([Verdict.SKIPPED], Verdict.SKIPPED),
    ],
)
def test_the_banner_names_the_rolled_up_verdict(checks, verdict):
    out = render_markdown(
        report(*(check(v, key=v.value) for v in checks)), generated_at=STAMP
    )
    assert f"> **VERDICT: {verdict.marker}**" in out.splitlines()[2]


def test_a_pass_grants_permission_plainly():
    out = render_markdown(report(check(Verdict.PASS)), generated_at=STAMP)
    assert "> **Strategy code may be run against this dataset.**" in out
    assert "Every blocking check ran and passed." in out


def test_a_warn_grants_permission_with_a_condition_attached():
    out = render_markdown(report(check(Verdict.WARN)), generated_at=STAMP)
    assert (
        "> **Strategy code may be run against this dataset, provided the "
        "warnings below are read first.**" in out
    )


def test_a_fail_refuses_and_names_the_blocking_checks():
    out = render_markdown(
        report(
            check(Verdict.FAIL, key="a", title="Delisted entities in the master"),
            check(Verdict.FAIL, key="b", title="Filing lag is possible"),
        ),
        generated_at=STAMP,
    )
    assert "> **Strategy code must not be run against this dataset.**" in out
    assert "2 blocking checks failed" in out
    assert "Delisted entities in the master" in out


def test_a_failing_advisory_check_does_not_appear_in_the_verdict_reasoning():
    # The rollup ignores it, so the paragraph explaining the rollup has
    # to as well, or the two halves of the page disagree.
    out = render_markdown(
        report(
            check(Verdict.PASS, key="a"),
            check(Verdict.FAIL, key="b", title="Unexplained jumps", blocking=False),
        ),
        generated_at=STAMP,
    )
    assert "> **Strategy code may be run against this dataset.**" in out
    assert "advisory" in out


def test_unprovable_says_out_loud_that_nothing_was_tested():
    out = render_markdown(
        report(check(Verdict.UNPROVABLE, key="a", reason="no filing dates on file")),
        generated_at=STAMP,
    )
    assert "> **Strategy code must not be run against this dataset.**" in out
    assert "**This is not the same as having failed — nothing was tested.**" in out
    assert "1 blocking check could not be run" in out
    # The reason travels with the section too, not only the banner.
    assert "> Not tested: no filing dates on file" in out


def test_a_skipped_audit_is_treated_as_an_unaudited_one():
    out = render_markdown(report(check(Verdict.SKIPPED)), generated_at=STAMP)
    assert "> **Strategy code must not be run against this dataset.**" in out
    assert "Treat this exactly as you would an unaudited dataset" in out


def test_an_empty_audit_says_the_verdict_is_about_nothing():
    # It rolls up to PASS, which is arithmetically true and practically
    # a trap, so the correction sits against the sentence it undoes.
    out = render_markdown(report(), generated_at=STAMP)
    assert "> **VERDICT: PASS**" in out
    assert "No checks were registered at all" in out
    assert "_No checks were run._" in out


def test_the_counts_line_totals_the_checks():
    out = render_markdown(
        report(
            check(Verdict.PASS, key="a"),
            check(Verdict.PASS, key="b"),
            check(Verdict.WARN, key="c"),
        ),
        generated_at=STAMP,
    )
    # Worst-first here too, and only the verdicts that occurred.
    assert "3 checks: 1 WARN, 2 PASS." in out
    assert "FAIL" not in out.split("## Provenance")[0]


def test_the_caveats_section_is_fixed_and_survives_a_clean_run():
    # A caveats block regenerated from the findings would quietly shrink
    # on a clean run — exactly when somebody is most inclined to believe
    # the dataset is finished.
    clean = render_markdown(report(check(Verdict.PASS)), generated_at=STAMP)
    dirty = render_markdown(report(check(Verdict.FAIL)), generated_at=STAMP)
    for out in (clean, dirty):
        assert "## What this audit cannot tell you" in out
        assert "A PASS removes one explanation for a good backtest." in out


# -- tables --------------------------------------------------------------


def test_a_capped_table_reports_how_many_rows_it_dropped():
    rows = MAX_TABLE_ROWS + 5
    res = check(Verdict.FAIL)
    res.tables["Impossible bars"] = pd.DataFrame(
        {"permaticker": range(rows), "reason": ["close <= 0"] * rows}
    )
    out = render_markdown(report(res), generated_at=STAMP)
    assert f"_Showing {MAX_TABLE_ROWS:,} of {rows:,} rows; 5 elided._" in out
    # And it really did stop at the cap rather than merely saying so.
    assert "| 34 " not in out


def test_a_table_that_fits_says_nothing_about_elision():
    res = check(Verdict.PASS)
    res.tables["Attrition by year"] = pd.DataFrame(
        {"year": [2008, 2009], "attrition_pct": [9.5, 8.1]}
    )
    out = render_markdown(report(res), generated_at=STAMP)
    assert "elided" not in out
    # That the cell rendered at all is this test's business. How many
    # decimal places it chose belongs to the formatter's own tests, and
    # pinning that here made an unrelated improvement to precision read
    # as a regression in elision.
    assert "2008" in out and "9.5" in out


def test_a_column_is_printed_to_the_precision_it_actually_carries():
    # Trailing zeros are free to print and not free to believe. A fixed
    # four places rendered an attrition rate of 3.2% as "3.2000", which
    # states a measurement good to a ten-thousandth of a percent that
    # nothing in the panel supports. The rule is that the column's own
    # values decide: never fewer places than they need, never more.
    res = check(Verdict.PASS)
    res.tables["Rates"] = pd.DataFrame(
        {"one_place": [9.5, 8.1], "three_places": [2.518, 0.4], "whole": [7.0, 3.0]}
    )
    out = render_markdown(report(res), generated_at=STAMP)
    assert "9.5 |" in out and "9.5000" not in out
    assert "2.518 |" in out and "2.5180" not in out
    # One format for the whole column, so the column's widest need sets
    # it: 0.4 prints alongside 2.518 as 0.400 rather than drifting to a
    # different number of places in the same stack of digits.
    assert "0.400 |" in out
    # An all-integral float column is not a measurement to four places
    # either, and it is the one people paste back into a query.
    assert "7 |" in out and "7.0" not in out


def test_an_empty_table_says_so_rather_than_rendering_a_bare_header():
    res = check(Verdict.PASS)
    res.tables["Dead but never priced"] = pd.DataFrame({"ticker": []})
    out = render_markdown(report(res), generated_at=STAMP)
    assert "_No rows._" in out


def test_a_pipe_in_a_cell_cannot_break_the_table():
    res = check(Verdict.FAIL)
    res.tables["Names"] = pd.DataFrame({"name": ["Alder | Bracken Inc."]})
    out = render_markdown(report(res), generated_at=STAMP)
    assert r"Alder \| Bracken Inc." in out


def test_a_named_index_becomes_a_column_and_a_positional_one_does_not():
    keyed = check(Verdict.PASS, key="keyed")
    keyed.tables["By year"] = pd.DataFrame(
        {"n": [3, 4]}, index=pd.Index([2008, 2009], name="year")
    )
    loose = check(Verdict.PASS, key="loose")
    loose.tables["Filtered"] = pd.DataFrame({"n": [3, 4]}, index=[17, 42])

    out = render_markdown(report(keyed, loose), generated_at=STAMP)
    assert "year" in out
    assert "| 17 " not in out


def test_findings_are_ordered_worst_first_inside_a_check():
    res = check(Verdict.FAIL)
    res.add(Verdict.PASS, "a passing note")
    res.add(Verdict.FAIL, "the actual failure", "permaticker 9000001")
    out = render_markdown(report(res), generated_at=STAMP)
    assert out.index("the actual failure") < out.index("a passing note")
    assert "_permaticker 9000001_" in out


def test_the_summary_row_carries_the_key_somebody_would_rerun():
    out = render_markdown(
        report(check(Verdict.FAIL, key="survivorship.decedent_trace")),
        generated_at=STAMP,
    )
    assert "`survivorship.decedent_trace`" in out


def test_the_source_label_leads_the_document():
    out = render_markdown(
        report(check(Verdict.PASS), label="Synthetic [SMOKE TEST ONLY]"),
        generated_at=STAMP,
    )
    assert out.splitlines()[0] == "# Data audit — Synthetic [SMOKE TEST ONLY]"
    assert "Synthetic [SMOKE TEST ONLY]" in out.split("## Provenance")[1]


def test_the_document_ends_with_exactly_one_newline():
    # A file that gains or loses trailing whitespace between runs diffs
    # on every commit and nobody reads the diff after that.
    out = render_markdown(report(check(Verdict.PASS)), generated_at=STAMP)
    assert out.endswith("\n")
    assert not out.endswith("\n\n")
