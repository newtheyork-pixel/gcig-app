"""The Stage 1 deliverable, tested as the thing a person actually runs.

Everything else in this suite reaches past the CLI and drives the audit
directly, which is the right way to test what the checks conclude and
the wrong way to test what a pipeline sees. A pipeline sees an integer
and a file. Both were untested until this file existed, and both were
where the harness could fail most quietly: a report is written whatever
the verdict, so a broken exit code produces a green build with a red
document sitting next to it that nobody has any reason to open.

Three things are worth knowing about how it is written.

The exit codes are literals here, never `data_audit.EXIT_FAILED`. The
contract is with a shell, not with a module, and a test that imported
the constant would happily certify a run that had quietly started
exiting 0 on failure. The constants are themselves asserted against the
literals once, which is the only place the two are allowed to meet.

The bias tests are parametrised over `BIASES` itself rather than over a
list transcribed from it, so a ninth name cannot be added to the CLI
without the suite immediately demanding it work. That is the direct
regression test for the defect that caused this cleanup: two generators
with overlapping vocabularies, one of them exercised by nobody, and a
name on either side that reached a defect the other did not have.

And every invocation passes `--out`. The default is
`reports/data_audit_report.md`, which is committed — a test that forgot
would rewrite the record under a twelve-year range and nobody would
notice until the diff. `_invoke` refuses to run without it.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple, Sequence

import pytest
from typer.testing import CliRunner

import data_audit
from data_audit import BIASES, app
from griffinquant.data.synthetic import EXPECTED_TRIPS, Bias

#: A decade, for the same reason `test_audit_detects_bias` uses twelve
#: years: the survivorship instruments read a trend across years and
#: have nothing to say about a short window. Short enough that nine
#: full audits through the CLI cost a few seconds, long enough that
#: every bias below reaches the verdict it is supposed to reach.
START = "2010-01-01"
END = "2019-12-31"

RUNNER = CliRunner()


class Run(NamedTuple):
    exit_code: int
    stdout: str
    stderr: str
    output: str
    report: Path


def _invoke(args: Sequence[str], **kwargs) -> Run:
    assert "--out" in args, (
        "every invocation in this file must name its own --out; the default "
        "is the committed report and a test that wrote there would rewrite "
        "the record silently"
    )
    result = RUNNER.invoke(app, list(args), **kwargs)
    if result.exception is not None and not isinstance(result.exception, SystemExit):
        raise result.exception
    out = Path(args[args.index("--out") + 1])
    return Run(result.exit_code, result.stdout, result.stderr, result.output, out)


@pytest.fixture(scope="module")
def audit(tmp_path_factory):
    """One CLI run per bias, built once and shared.

    The panels are deterministic and the biases are independent, so
    rebuilding one for every assertion would only make the suite slower
    at saying the same thing. Deliberately not `--quiet`: the console
    rendering is part of what a person gets and one of the tests below
    is about its absence.
    """
    outdir = tmp_path_factory.mktemp("audits")
    memo: dict[str | None, Run] = {}

    def run(bias: str | None = None) -> Run:
        if bias not in memo:
            out = outdir / f"{bias or 'clean'}.md"
            args = ["--source", "synthetic", "--start", START, "--end", END,
                    "--out", str(out)]
            if bias is not None:
                args += ["--inject-bias", bias]
            memo[bias] = _invoke(args)
        return memo[bias]

    return run


# -- reading the report back ---------------------------------------------


_CHECK_ROW = re.compile(
    r"\|\s*`(?P<key>[A-Za-z0-9_.]+)`\s*\|\s*(?P<verdict>[A-Z]+)\s*\|"
    r"\s*(?P<scope>blocking|advisory)\s*\|"
)


def summary(report: Path) -> dict[str, tuple[str, str]]:
    """The report's own check table, as key -> (verdict, scope).

    Read out of the document rather than out of the objects that made
    it, because the document is the deliverable. A check that failed in
    memory and rendered as a pass is a defect this suite would
    otherwise be structurally unable to see.
    """
    rest = report.read_text("utf-8").partition("## Checks")[2]
    assert rest, f"{report} has no check table"
    table = rest.split("\n## ")[0]
    rows = {m["key"]: (m["verdict"], m["scope"]) for m in _CHECK_ROW.finditer(table)}
    assert rows, f"{report} has a check section but no rows in it"
    return rows


def provenance(report: Path) -> dict[str, str]:
    """The report's provenance table, as field -> value."""
    block = report.read_text("utf-8").partition("## Provenance")[2]
    rows: dict[str, str] = {}
    for line in block.split("\n## ")[0].splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 2 and cells[0] and set(cells[0]) - set("-: "):
            rows[cells[0]] = cells[1]
    assert rows, f"{report} has no provenance table"
    return rows


def squash(text: str) -> str:
    """Whitespace removed, so a wrapped line still matches.

    Rich lays the error boxes out at eighty columns and will break a
    hyphenated name across two lines when it has to. A test that
    accepted `unrecorded-splits` and rejected `unrecorded-\\nsplits`
    would be asserting about the terminal width, not about the message.
    """
    return re.sub(r"\s+", "", text)


# -- the clean run --------------------------------------------------------


def test_a_clean_panel_exits_zero_and_leaves_a_report(audit):
    run = audit()
    assert run.exit_code == 0
    assert run.report.exists()
    assert "**VERDICT: PASS**" in run.report.read_text("utf-8")


def test_the_clean_report_says_out_loud_that_none_of_it_is_real(audit):
    # The header is the only part of a report anybody reads in a hurry,
    # and a smoke run that did not name itself would be indistinguishable
    # from an audit of a real vendor pull at exactly the moment somebody
    # is skimming.
    report = audit().report
    assert "SMOKE TEST ONLY" in report.read_text("utf-8").splitlines()[0]
    assert provenance(report)["warning"] == (
        "SMOKE TEST ONLY. Nothing in this report is a statement about any "
        "real security."
    )


def test_nothing_failed_on_the_clean_panel(audit):
    failed = [k for k, (v, _) in summary(audit().report).items() if v == "FAIL"]
    assert failed == []


# -- every bias, through the CLI -----------------------------------------


#: Every bias costs the dataset its certificate, so every one of them
#: exits non-zero. There is deliberately no advisory-only set here: if a
#: ninth bias is ever added that the CLI answers green, the
#: parametrised test below fails and somebody has to argue for it in
#: writing rather than add a name to a frozenset.


@pytest.mark.parametrize("name", list(BIASES), ids=list(BIASES))
def test_every_bias_reaches_the_check_that_owns_it(audit, name: str):
    # Parametrised over the mapping itself: a ninth entry with no
    # generator behind it, or one wired to the wrong enum member, fails
    # here rather than in a report somebody reads next year.
    rows = summary(audit(name).report)
    for key in EXPECTED_TRIPS[BIASES[name].bias]:
        assert rows[key][0] == "FAIL", f"{name} did not redden {key}"


@pytest.mark.parametrize("name", list(BIASES), ids=list(BIASES))
def test_the_exit_code_follows_the_blocking_verdict(audit, name: str):
    assert audit(name).exit_code == 1


@pytest.mark.parametrize("name", list(BIASES), ids=list(BIASES))
def test_a_corrupted_panel_still_produces_a_document(audit, name: str):
    # A failing audit that wrote nothing would be indistinguishable at
    # the shell from a crashed one, and the report is the only artefact
    # that says which check went red and on which rows.
    run = audit(name)
    assert run.report.exists()
    # And it names the defect in its own header, or a smoke run reads
    # exactly like an audit of a real dataset.
    assert BIASES[name].bias.name in run.report.read_text("utf-8").splitlines()[0]


def test_an_unrecorded_split_is_red_at_the_shell_and_on_the_page(audit):
    # This was the one green exit until the reasoning was looked at
    # again. A split nobody recorded prints a 75% single-day loss on a
    # day nothing happened, which is not a cosmetic bad bar — it is the
    # largest fake return in the panel, and a cross-sectional strategy
    # will find it before it finds anything real. Pinned from both sides
    # because a shell that disagrees with the document is the bug.
    run = audit("unrecorded-splits")
    assert run.exit_code == 1
    verdict, scope = summary(run.report)["quality.unexplained_jumps"]
    assert (verdict, scope) == ("FAIL", "blocking")
    assert "**VERDICT: FAIL**" in run.report.read_text("utf-8")


def test_the_provenance_records_the_name_that_was_typed(audit):
    # Two different audiences, deliberately given two different
    # spellings. The provenance row is for a reader reproducing the run,
    # and a run is reproduced by retyping the command, which is spelled
    # in hyphens; `TICKER_COLLISION` there would send them to the enum
    # to translate it back. The header is for a reader deciding whether
    # this document is about real money, and it names the member.
    report = audit("ticker-recycling").report
    assert provenance(report)["injected bias"] == "ticker-recycling"
    assert "TICKER_COLLISION" in report.read_text("utf-8").splitlines()[0]


def test_the_clean_run_says_plainly_that_nothing_was_injected(audit):
    # An empty cell would read as a field the tool forgot to fill in,
    # which is the one reading that makes a clean panel and a corrupted
    # one look the same on the page.
    assert provenance(audit().report)["injected bias"] == "none (clean panel)"


# -- the vocabulary is the enum's, and nobody's own ----------------------


#: What each name the CLI accepts is claimed to mean, written out here
#: rather than derived from `BIASES`, because a mapping compared against
#: itself asserts nothing. Two of these are the whole reason this test
#: exists: `ticker-recycling` and `adjusted-prices` are the pairs where
#: the typed vocabulary and the enum member do not share a word, and a
#: careless merge of two generators is exactly how one of them ends up
#: pointing at the other's defect.
CLAIMED: dict[str, Bias] = {
    "survivorship": Bias.SURVIVORSHIP,
    "ticker-recycling": Bias.TICKER_COLLISION,
    "lookahead-fundamentals": Bias.LOOKAHEAD_FUNDAMENTALS,
    "restated-fundamentals": Bias.RESTATED_FUNDAMENTALS,
    "adjusted-prices": Bias.ADJUSTED_ONLY,
    "phantom-sessions": Bias.FABRICATED_SESSIONS,
    "unrecorded-splits": Bias.UNRECORDED_SPLITS,
    "broken-adjustment": Bias.BROKEN_ADJUSTMENT,
}


def test_each_name_resolves_to_the_bias_it_claims():
    assert {name: opt.bias for name, opt in BIASES.items()} == CLAIMED


def test_the_cli_vocabulary_covers_the_enum_exactly():
    # No orphan on either side. A Bias member the CLI cannot reach is a
    # defect nobody can demonstrate; a CLI name with no member behind it
    # is a KeyError at the moment somebody most wants an answer. The two
    # generators this repository briefly carried failed this in both
    # directions at once.
    named = {opt.bias for opt in BIASES.values()}
    assert named == set(Bias) - {Bias.NONE}
    assert Bias.NONE not in named


def test_no_two_names_reach_the_same_bias():
    # An alias would make the menu longer without making the harness
    # able to demonstrate anything more, and it would quietly halve what
    # the parametrised tests above cover.
    assert len({opt.bias for opt in BIASES.values()}) == len(BIASES)


def test_every_name_carries_a_description_a_person_could_act_on():
    # The unknown-bias error prints this table whole. A blank or
    # one-word entry turns the menu back into a list of identifiers the
    # reader then has to go and look up, which is the state it exists to
    # replace.
    for name, opt in BIASES.items():
        assert len(opt.description.split()) >= 8, name


# -- the source that is not there ----------------------------------------


def test_no_key_exits_two_and_writes_nothing(tmp_path):
    # The bucket the module docstring is about. "We could not check" is
    # not a weaker form of "we checked and it was fine", and the report
    # is the specific danger: a document written here would look exactly
    # like a clean one.
    out = tmp_path / "never.md"
    run = _invoke(
        ["--source", "sharadar", "--out", str(out)],
        env={"NASDAQ_DATA_LINK_API_KEY": None, "QUANDL_API_KEY": None},
    )
    assert run.exit_code == 2
    assert not out.exists()

    said = squash(run.stderr)
    # Both variables, because a message naming only the current one
    # sends somebody who already has the older key set off to find a
    # second credential they do not need.
    assert squash("NASDAQ_DATA_LINK_API_KEY") in said
    assert squash("QUANDL_API_KEY") in said
    assert squash("No report was written") in said


def test_the_missing_key_message_offers_the_run_that_needs_no_key(tmp_path):
    # The one path a reader can take immediately. Without it the tool is
    # unexercisable by anyone who has not yet been given a credential,
    # which is everybody on their first day.
    run = _invoke(
        ["--source", "sharadar", "--out", str(tmp_path / "never.md")],
        env={"NASDAQ_DATA_LINK_API_KEY": None, "QUANDL_API_KEY": None},
    )
    assert squash("--source synthetic") in squash(run.stderr)
    assert squash("--inject-bias survivorship") in squash(run.stderr)


# -- refusing what it cannot honour --------------------------------------


def test_an_unknown_bias_exits_two_and_prints_the_menu(tmp_path):
    out = tmp_path / "never.md"
    run = _invoke(
        ["--source", "synthetic", "--start", START, "--end", END,
         "--inject-bias", "survivorshp", "--out", str(out)]
    )
    assert run.exit_code == 2
    assert not out.exists()

    said = squash(run.output)
    for name in BIASES:
        assert squash(name) in said, name
    # Not merely the eight identifiers: the descriptions are what make a
    # typo self-correcting, and "Wachovia" only appears in one of them.
    assert "Wachovia" in run.output


def test_a_bias_is_refused_on_a_real_vendor_pull(tmp_path):
    # Corrupting a vendor pull would produce a report about damage this
    # tool did rather than about the dataset — and it would be filed
    # under the vendor's name.
    out = tmp_path / "never.md"
    run = _invoke(
        ["--source", "sharadar", "--inject-bias", "survivorship", "--out", str(out)]
    )
    assert run.exit_code == 2
    assert not out.exists()
    assert squash("only applies to --source synthetic") in squash(run.output)


@pytest.mark.parametrize(
    "args",
    [
        ["--start", "the third of January"],
        ["--end", "2019-13-01"],
        # Backwards, which the generator would refuse anyway — but it
        # should be refused before a panel is built, not by an exception
        # from four modules down.
        ["--start", "2019-12-31", "--end", "2010-01-01"],
    ],
    ids=["unparseable-start", "impossible-end", "backwards"],
)
def test_a_range_that_is_not_a_range_never_reaches_the_generator(tmp_path, args):
    out = tmp_path / "never.md"
    run = _invoke(["--source", "synthetic", *args, "--out", str(out)])
    assert run.exit_code == 2
    assert not out.exists()


# -- where it writes and what it says ------------------------------------


def test_out_writes_where_told_and_builds_the_path(tmp_path, audit):
    # The nested directory is the point: a report is usually written
    # next to a set of results that does not exist yet, and a tool that
    # made the operator mkdir first would get run without --out.
    out = tmp_path / "runs" / "2010" / "audit.md"
    run = _invoke(
        ["--source", "synthetic", "--start", START, "--end", END, "--out", str(out)]
    )
    assert run.exit_code == 0
    assert out.exists()
    assert "**VERDICT: PASS**" in out.read_text("utf-8")
    # There, and nowhere else. The default is the committed report, and
    # a tool that wrote both would keep passing this test while quietly
    # rewriting the record on every run.
    assert [p.name for p in tmp_path.rglob("*.md")] == ["audit.md"]


def test_quiet_prints_nothing_and_still_writes(tmp_path, audit):
    out = tmp_path / "quiet.md"
    run = _invoke(
        ["--source", "synthetic", "--start", START, "--end", END,
         "--out", str(out), "--quiet"]
    )
    assert run.exit_code == 0
    assert run.stdout == ""
    assert out.exists()
    assert "**VERDICT: PASS**" in out.read_text("utf-8")

    # The other half of the assertion: a run that printed nothing
    # either way would pass the line above and mean nothing.
    loud = audit()
    assert "VERDICT" in loud.stdout
    assert squash(str(loud.report)) in squash(loud.stdout)


# -- the promise made to a shell -----------------------------------------


def test_the_exit_codes_are_the_three_the_docstring_names():
    # The only place the module's constants and the literals used
    # throughout this file are allowed to meet. Everywhere else the
    # literal is used on purpose, so a constant quietly redefined to
    # zero cannot make the suite agree with it.
    assert (data_audit.EXIT_OK, data_audit.EXIT_FAILED, data_audit.EXIT_NOT_PROVEN) == (
        0,
        1,
        2,
    )


@pytest.mark.parametrize(
    ("extra", "expected"),
    [([], 0), (["--inject-bias", "survivorship"], 1)],
    ids=["clean", "survivorship"],
)
def test_a_real_process_really_returns_it(tmp_path, extra, expected):
    # CliRunner reports the code the command asked for; this reports the
    # code the operating system saw. They are the same number here and
    # the distinction is the entire argument of the module docstring —
    # a pipeline reads $?, and nothing else about this tool survives
    # being skimmed.
    out = tmp_path / f"{expected}.md"
    proc = subprocess.run(
        [
            sys.executable,
            str(data_audit.HERE / "data_audit.py"),
            "--source", "synthetic",
            "--start", START,
            "--end", END,
            "--out", str(out),
            "--quiet",
            *extra,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == expected, proc.stderr[-2000:]
    assert out.exists()
