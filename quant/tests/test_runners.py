"""The two Stage 3 runners, tested as the things a person actually runs.

Everything else in this suite reaches past the entry points and drives
the library directly, which is the right way to test what a calculation
concludes and the wrong way to test what a pipeline sees. A pipeline
sees an integer and a file, and the most dangerous failure available to
either script is the one where those two disagree — a run that could not
get prices, exits 0, and leaves a report on disk that reads exactly like
a real one.

So the tests here are about the contract rather than the arithmetic:

**The exit codes are literals**, never `run_sleeves.EXIT_NO_DATA`. The
contract is with a shell, and a test that imported the constant would
happily certify a script that had quietly started exiting 0 on a failed
pull. The constants are asserted against the literals exactly once,
which is the only place the two are allowed to meet.

**No network, ever.** Both scripts load through a module-level
`load_panel`, and every test replaces it with a synthetic panel built
from a fixed seed. The panel deliberately carries the two real gaps —
DBC listing thirteen months in, BIL two and a half years in — because
the splice flagging is one of the things being tested and a panel
without holes cannot exercise it.

**Every invocation names its own `--out` and `--trials`.** The defaults
are `reports/` and the committed trial ledger; a test that forgot would
overwrite a deliverable and inflate the denominator of every deflated
Sharpe computed afterwards, and neither would fail anything here.

The numbers the runs produce are meaningless — the panel is noise with
no drift in it, on purpose, so that nothing in this file can be read as
a result. What is being proven is that the wiring carries a decision
from a close to the next open, through the ledger, into a report, and
out as an exit code.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple, Sequence

import numpy as np
import pandas as pd
import pytest
from typer.testing import CliRunner

import evaluate_signals
import run_sleeves
from griffinquant.data.synthetic import nyse_sessions
from griffinquant.util import runs as runlib

RUNNER = CliRunner()

SEED = 20050103

#: Long enough to clear the 252-session warmup with a year of live
#: decisions after it, and long enough to reach past BIL's real listing
#: date so the cash sleeve is absent for part of the sample and present
#: for the rest. Both of those are states the report has to describe.
PANEL_START = date(2005, 1, 3)
PANEL_END = date(2007, 12, 31)

#: A shorter window for the tests that have to run the whole pipeline
#: twice. Still past the warmup, so decisions actually happen.
SHORT_END = date(2006, 8, 31)

FIXED_STAMP = datetime(2026, 8, 2, 12, 0, 0, tzinfo=timezone.utc)


class Spec(NamedTuple):
    """One made-up sleeve as loadings on two common factors.

    Two factors and not one, for the reason `test_correlation` gives: a
    single factor cannot produce a book where the duration sleeves are
    highly correlated with each other and slightly negative against
    equities, and that shape is the whole thing the correlation haircut
    is about.
    """

    ticker: str
    beta: float
    gamma: float
    idio: float
    #: The real listing date, where the vehicle has one inside the
    #: window. This is what makes the splice flagging testable.
    lists: date | None = None


BOOK: tuple[Spec, ...] = (
    Spec("SPY", 1.00, 0.00, 0.30),
    Spec("EFA", 0.95, 0.00, 0.35),
    Spec("EEM", 0.90, 0.00, 0.55),
    Spec("IEF", -0.15, 1.00, 0.20),
    Spec("TLT", -0.20, 1.60, 0.30),
    Spec("GLD", 0.05, 0.20, 1.00),
    Spec("LQD", 0.35, 0.60, 0.25),
    Spec("DBC", 0.30, -0.10, 0.90, date(2006, 2, 6)),
    Spec("BIL", 0.00, 0.00, 0.02, date(2007, 5, 30)),
)

FACTOR_VOL = 0.16
DAILY_SCALE = 0.010

#: Zero drift, deliberately. A fixture with a trend in it would give the
#: strategy a Sharpe drawn from luck, and one of the checks under test
#: refuses to report a Sharpe above 1.2 — so a lucky seed would flip an
#: exit code and the suite would be testing the random number generator.
DRIFT = 0.0

#: Distributions accrue at this annual rate, so `close_adj` and
#: `close_unadj` are genuinely different series. Two of the checks under
#: test assert exactly that, and on a panel where the two coincide they
#: would pass by accident on a book marked at price.
DIVIDEND_YIELD = 0.02


@lru_cache(maxsize=1)
def synthetic_prices() -> pd.DataFrame:
    """A long `schema.PRICES` frame for the nine sleeve vehicles."""
    idx = nyse_sessions(PANEL_START, PANEL_END)
    n = len(idx)
    rng = np.random.default_rng(SEED)
    scale = FACTOR_VOL / math.sqrt(252)
    equity = scale * rng.standard_normal(n)
    rates = scale * rng.standard_normal(n)

    accrual = np.exp(np.arange(n) * DIVIDEND_YIELD / 252.0)
    frames: list[pd.DataFrame] = []
    for pid, spec in enumerate(BOOK, start=900_000_001):
        r = (
            DRIFT
            + spec.beta * equity
            + spec.gamma * rates
            + spec.idio * DAILY_SCALE * rng.standard_normal(n)
        )
        close = 100.0 * np.exp(np.cumsum(r))
        opens = close * (1.0 + 0.001 * rng.standard_normal(n))
        frame = pd.DataFrame(
            {
                "permaticker": pid,
                "ticker": spec.ticker,
                "date": idx,
                "open_unadj": opens,
                "high_unadj": np.maximum(close, opens) * 1.002,
                "low_unadj": np.minimum(close, opens) * 0.998,
                "close_unadj": close,
                "volume_unadj": 5.0e6,
                # The reinvestment, so the two closes are different
                # series and a book marked at price is detectable.
                "close_adj": close * accrual,
            }
        )
        if spec.lists is not None:
            frame = frame.loc[frame["date"] >= pd.Timestamp(spec.lists)]
        frames.append(frame)

    out = pd.concat(frames, ignore_index=True)
    return out.sort_values(["permaticker", "date"]).reset_index(drop=True)


def synthetic_sample(start: date, end: date) -> runlib.Sample:
    """The same shape `runs.load_sample` returns, without a network."""
    prices = synthetic_prices()
    prices = prices.loc[
        prices["date"].between(pd.Timestamp(start), pd.Timestamp(end))
    ].reset_index(drop=True)
    wide = prices.pivot(index="date", columns="ticker", values="close_adj")
    wide = wide.sort_index()
    wide.columns = pd.Index([str(c) for c in wide.columns])
    wide.index = pd.DatetimeIndex(wide.index).normalize()
    sessions = pd.DatetimeIndex(wide.index)
    return runlib.Sample(
        prices=prices,
        close_adj=wide,
        risk_free=pd.Series(0.03, index=sessions, dtype="float64"),
        sessions=sessions,
        source_label="Synthetic sleeve panel [TEST FIXTURE]",
        cache_note="none (test fixture)",
        rf_note="a flat 3.00% annualised, fixed by the fixture",
    )


class Run(NamedTuple):
    exit_code: int
    stdout: str
    stderr: str
    report: Path


def _invoke(app, args: Sequence[str], **kwargs) -> Run:
    assert "--out" in args, (
        "every invocation in this file must name its own --out; the default "
        "is a committed deliverable and a test that wrote there would "
        "overwrite the record silently"
    )
    assert "--trials" in args, (
        "every invocation must name its own --trials; the default ledger is "
        "the denominator of every deflated Sharpe in the project, and a test "
        "that appended to it would raise the hurdle for real results"
    )
    result = RUNNER.invoke(app, list(args), **kwargs)
    if result.exception is not None and not isinstance(result.exception, SystemExit):
        raise result.exception
    out = Path(args[args.index("--out") + 1])
    return Run(result.exit_code, result.stdout, result.stderr, out)


@pytest.fixture(scope="module")
def patched():
    """Both scripts wired to the synthetic panel and to a fixed clock.

    Module scoped because the backtests behind these runs are the
    expensive part of the suite and nothing in them is stateful; the
    monkeypatching is undone at the end so nothing leaks into another
    file.
    """
    mp = pytest.MonkeyPatch()
    for module in (evaluate_signals, run_sleeves):
        mp.setattr(
            module,
            "load_panel",
            lambda start, end, *, source, cache: synthetic_sample(start, end),
        )
        mp.setattr(module, "_generated_at", lambda: FIXED_STAMP)
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def sleeves_run(patched, tmp_path_factory) -> Run:
    """One full Stage 3 run over the whole fixture window."""
    out = tmp_path_factory.mktemp("stage3") / "stage3_sleeves.md"
    return _invoke(
        run_sleeves.app,
        [
            "--start", PANEL_START.isoformat(),
            "--end", PANEL_END.isoformat(),
            "--out", str(out),
            "--trials", str(out.parent / "trials.jsonl"),
            "--quiet",
        ],
    )


@pytest.fixture(scope="module")
def signals_run(patched, tmp_path_factory) -> Run:
    out = tmp_path_factory.mktemp("signals") / "signal_evaluation.md"
    return _invoke(
        evaluate_signals.app,
        [
            "--start", PANEL_START.isoformat(),
            "--end", PANEL_END.isoformat(),
            "--out", str(out),
            "--trials", str(out.parent / "trials.jsonl"),
            "--bootstrap", "25",
            "--step", "25",
            "--quiet",
        ],
    )


# -- the contract with the shell -----------------------------------------


def test_the_exit_codes_are_the_literals_a_pipeline_reads():
    """The one place the constants and the literals are allowed to meet.

    Everywhere else in this file the numbers are written out, so a script
    that quietly started exiting 0 on a failed pull would fail a test
    rather than pass one it imported its own answer from.
    """
    for module in (evaluate_signals, run_sleeves):
        assert module.EXIT_OK == 0
        assert module.EXIT_FAILED == 1
        assert module.EXIT_NO_DATA == 2


@pytest.mark.parametrize("module", [evaluate_signals, run_sleeves])
def test_no_data_exits_two_and_writes_nothing(module, tmp_path, monkeypatch):
    """The whole reason both scripts exist in this shape.

    A report file that exists is a claim that the run happened. There is
    no partial report and no placeholder, so the assertion is not that
    the file is empty — it is that there is no file.
    """
    monkeypatch.setattr(module, "_generated_at", lambda: FIXED_STAMP)

    def dark(start, end, *, source, cache):
        raise runlib.DataUnavailable(
            "the price pull returned no bars; the endpoint answered 429"
        )

    monkeypatch.setattr(module, "load_panel", dark)
    out = tmp_path / "must_not_exist.md"
    run = _invoke(
        module.app,
        [
            "--out", str(out),
            "--trials", str(tmp_path / "trials.jsonl"),
        ],
    )

    assert run.exit_code == 2
    assert not out.exists()
    assert not list(tmp_path.glob("*.md"))


@pytest.mark.parametrize("module", [evaluate_signals, run_sleeves])
def test_the_refusal_says_the_sentence_that_travels_with_it(
    module, tmp_path, monkeypatch
):
    """`validate_engine.py`'s wording, verbatim, in both scripts.

    Not decoration. It is the sentence that distinguishes "the run was
    refused" from "the run went badly", and those two produce identical
    silence otherwise.
    """
    monkeypatch.setattr(module, "_generated_at", lambda: FIXED_STAMP)
    monkeypatch.setattr(
        module,
        "load_panel",
        lambda start, end, *, source, cache: (_ for _ in ()).throw(
            runlib.DataUnavailable("the endpoint is dark")
        ),
    )
    run = _invoke(
        module.app,
        ["--out", str(tmp_path / "x.md"), "--trials", str(tmp_path / "t.jsonl")],
    )
    said = " ".join((run.stdout + run.stderr).split())
    assert "DATA UNAVAILABLE" in said
    assert (
        "A reconciliation is a claim about arithmetic we actually did, and a "
        "file saying otherwise would outlive this session." in said
    )
    assert "Nothing has been written" in said


@pytest.mark.parametrize("module", [evaluate_signals, run_sleeves])
def test_a_refused_run_never_touches_the_trial_ledger(module, tmp_path, monkeypatch):
    """N is a denominator. A run that computed nothing must not raise it."""
    monkeypatch.setattr(module, "_generated_at", lambda: FIXED_STAMP)
    monkeypatch.setattr(
        module,
        "load_panel",
        lambda start, end, *, source, cache: (_ for _ in ()).throw(
            runlib.DataUnavailable("dark")
        ),
    )
    ledger = tmp_path / "trials.jsonl"
    run = _invoke(
        module.app, ["--out", str(tmp_path / "x.md"), "--trials", str(ledger)]
    )
    assert run.exit_code == 2
    assert not ledger.exists()


def test_the_engine_ran_end_to_end(sleeves_run):
    """A report on disk and a zero from the shell, from a real backtest.

    The numbers inside are noise. What this asserts is that a decision
    taken at a close reached an open, a ledger, nine performance reports
    and a markdown file without anything raising.
    """
    assert sleeves_run.exit_code == 0, sleeves_run.stdout + sleeves_run.stderr
    assert sleeves_run.report.exists()
    text = sleeves_run.report.read_text("utf-8")
    assert len(text) > 5_000
    assert text.startswith("# Stage 3")


def test_signal_evaluation_ran_end_to_end(signals_run):
    assert signals_run.exit_code == 0, signals_run.stdout + signals_run.stderr
    assert signals_run.report.exists()
    assert signals_run.report.read_text("utf-8").startswith("# Signal evaluation")


# -- determinism ---------------------------------------------------------


@pytest.mark.parametrize(
    "module, extra",
    [
        (evaluate_signals, ["--bootstrap", "25", "--step", "25"]),
        (run_sleeves, []),
    ],
)
def test_the_report_is_byte_identical_across_two_runs(
    patched, module, extra, tmp_path
):
    """One clock reading, one seed, one answer.

    Output that changes between two runs of the same inputs cannot be
    diffed, and a diff is how a reader finds what a code change did.

    The same `--out` both times, because the destination is one of the
    inputs — it is printed in the provenance table, and a test that
    compared two different filenames would be asserting that a report
    does not know where it lives. The trial ledger is shared on purpose:
    the second run appends the same configuration hashes, so the distinct
    count the report prints must not move.
    """
    ledger = tmp_path / "trials.jsonl"
    out = tmp_path / "report.md"
    args = [
        "--start", PANEL_START.isoformat(),
        "--end", SHORT_END.isoformat(),
        "--out", str(out),
        "--trials", str(ledger),
        "--quiet",
        *extra,
    ]

    a = _invoke(module.app, args)
    once = out.read_text("utf-8")
    b = _invoke(module.app, args)
    assert a.exit_code == b.exit_code
    assert once == out.read_text("utf-8")


# -- the splices ---------------------------------------------------------


@pytest.mark.parametrize("fixture", ["sleeves_run", "signals_run"])
def test_spliced_periods_are_flagged(fixture, request):
    """A reader must not need to know DBC listed in 2006 to read a table.

    Both gaps are named, both date ranges are printed, and the commodity
    row says out loud that nothing stood in — a period with no substitute
    is a finding, and reaching for a proxy to avoid printing it is how a
    backtest quietly acquires an instrument nobody could have held.
    """
    text = request.getfixturevalue(fixture).report.read_text("utf-8")
    assert "Spliced and absent history" in text
    assert "2006-02-06" in text
    assert "Broad Commodity (DBC)" in text
    assert "Cash (BIL)" in text
    assert "2005-01-01 to 2007-05-29" in text
    assert "nothing — the sleeve was not held" in text


def test_the_stage3_report_says_what_the_missing_cash_leg_cost(sleeves_run):
    """The splice note is not a footnote about data, it is about money.

    Before BIL listed the residual sat as uninvested balance earning
    nothing, and bills paid 3-5% across those years. A reader who takes
    the early figures at face value is reading a strategy that was
    penalised for a vehicle's listing date.
    """
    text = sleeves_run.report.read_text("utf-8")
    assert "uninvested balance earning nothing" in text
    assert "3-5%" in text


# -- everything the brief asks for --------------------------------------


@pytest.mark.parametrize(
    "needle",
    [
        "Deflated Sharpe, and the count it was deflated by",
        "Drawdown and recovery",
        "The worst 20 individual days",
        "The worst 10 months",
        "Turnover and cost drag",
        "The named windows, broken out",
        "Settlement deferrals per year",
        "Liquidity of what was held",
        "The three equity sleeves, combined",
        "What was attacked before any of this was believed",
    ],
)
def test_every_section_the_brief_lists_is_present(sleeves_run, needle):
    assert needle in sleeves_run.report.read_text("utf-8")


@pytest.mark.parametrize(
    "needle",
    ["2008", "2018Q4", "2020Q1", "2022", "2023-present"],
)
def test_every_named_window_gets_a_row(sleeves_run, needle):
    """Including the ones the sample does not reach.

    A report that silently drops 2008 because the data starts in 2010 has
    published a stress table with no stress in it and no sign that any
    was expected.
    """
    assert needle in sleeves_run.report.read_text("utf-8")


def test_all_three_cost_multiples_appear_for_every_book(sleeves_run):
    """Nine runs, side by side. A strategy that only works at 1x does not.

    Counted off the headline table rather than off the object, because
    the table is the deliverable and a run that happened but did not
    render is a run nobody can read.
    """
    text = sleeves_run.report.read_text("utf-8")
    headline = text.split("## Headline")[1].split("## Deflated")[0]
    for book in run_sleeves.BOOKS:
        rows = [
            line
            for line in headline.splitlines()
            if line.startswith("| " + book.label)
        ]
        assert len(rows) == 3, f"{book.label} has {len(rows)} cost rows"
        for multiple in ("1x", "2x", "3x"):
            assert any(f"| {multiple} " in r for r in rows)


def test_the_worst_day_and_month_tables_are_the_lengths_asked_for(patched):
    """Twenty days and ten months, and the counts come from `metrics`."""
    sample = synthetic_sample(PANEL_START, PANEL_END)
    ledger = runlib.Trials(path=None, when=FIXED_STAMP)
    # Never write to the real ledger from a unit test.
    ledger.counter = _NullCounter()
    s3 = run_sleeves.stage3(sample, ledger=ledger, multiples=(1.0,))
    for run in s3.ordered:
        assert len(run.report.worst_days) == 20
        assert len(run.report.worst_months) == 10


class _NullCounter:
    """A trial ledger that remembers nothing and writes nowhere.

    Used only where a unit test needs `stage3` to run without appending
    to a file. It reports one distinct trial, which deflates nothing —
    which is exactly why no test asserts anything about a deflated Sharpe
    computed through it.
    """

    def record(self, **_: object) -> None:
        return None

    def distinct_count(self) -> int:
        return 1

    def count(self) -> int:
        return 0


# -- the trial ledger ----------------------------------------------------


def test_every_configuration_lands_in_the_trial_ledger(sleeves_run):
    """Nine books-by-costs, written before a single backtest ran.

    An unlogged trial makes the deflated Sharpe a lie, and the deflated
    Sharpe is the headline.
    """
    ledger = sleeves_run.report.parent / "trials.jsonl"
    lines = [line for line in ledger.read_text("utf-8").splitlines() if line.strip()]
    assert len(lines) == len(run_sleeves.BOOKS) * len(run_sleeves.COST_MULTIPLES)

    from griffinquant.engine.metrics import TrialCounter

    counter = TrialCounter(ledger)
    assert counter.distinct_count() == len(lines)
    text = sleeves_run.report.read_text("utf-8")
    assert f"{len(lines):,} distinct configurations" in text


def test_the_signal_script_logs_its_own_configurations(signals_run):
    ledger = signals_run.report.parent / "trials.jsonl"
    lines = [line for line in ledger.read_text("utf-8").splitlines() if line.strip()]
    assert len(lines) == 4
    assert "trend, standalone" in ledger.read_text("utf-8")


def test_the_deflation_uses_the_whole_ledger_not_this_run(sleeves_run):
    """N is the project's search, not one script's.

    A count that excluded the signal diagnostics would be a smaller
    denominator arrived at by splitting the work across two files.
    """
    text = sleeves_run.report.read_text("utf-8")
    assert "distinct configuration count in `trials.jsonl`" in text


# -- the equity sleeves --------------------------------------------------


def test_the_combined_equity_weight_is_reported_and_stays_inside_the_caps(patched):
    """Their caps sum to 80% with no group cap. Whether that binds is a number."""
    sample = synthetic_sample(PANEL_START, PANEL_END)
    ledger = runlib.Trials(path=None, when=FIXED_STAMP)
    ledger.counter = _NullCounter()
    s3 = run_sleeves.stage3(sample, ledger=ledger, multiples=(1.0,))
    weight = s3.at("sleeves", 1.0).equity_weight

    assert len(weight) == len(sample.sessions)
    assert float(weight.min()) >= -1e-9
    assert float(weight.max()) <= run_sleeves.EQUITY_CAP_SUM + 1e-9
    assert run_sleeves.EQUITY_CAP_SUM == pytest.approx(0.80)


def test_the_report_names_the_step_that_did_the_cutting(sleeves_run):
    """The haircut is either the binding constraint or it is decoration.

    Printing the equity weight without saying which step held it down
    would let a reader assume the correlation rule did it when trend may
    have done all the work.
    """
    text = sleeves_run.report.read_text("utf-8")
    assert "Which step did the cutting" in text
    assert "Correlation bound" in text
    assert "Mean haircut" in text


# -- the sceptic ---------------------------------------------------------


def test_the_sceptic_checks_all_ran_and_are_printed(sleeves_run):
    text = sleeves_run.report.read_text("utf-8")
    for needle in (
        "Weights at T survive truncation after T",
        "Fills land at the NEXT open",
        "Positions are marked in total-return space",
        "Trading costs are charged inside the loop",
        "Cash is conserved",
        "Strategy Sharpe at 1x stays under 1.2",
    ):
        assert needle in text
    assert "FAIL" not in text.split("## What was attacked")[1]


def test_a_failed_check_exits_one_and_says_so_at_the_top(patched, tmp_path):
    """The exit code and the document must not disagree.

    The Sharpe bar is dropped below anything achievable so the check
    fails on data that is otherwise fine. What is being tested is that a
    failed check reaches BOTH the shell and the first paragraph — a
    report whose headline reads clean while the process exits 1 is worse
    than either failure alone.
    """
    mp = pytest.MonkeyPatch()
    mp.setattr(run_sleeves, "SUSPICIOUS_SHARPE", -100.0)
    try:
        out = tmp_path / "failed.md"
        run = _invoke(
            run_sleeves.app,
            [
                "--start", PANEL_START.isoformat(),
                "--end", SHORT_END.isoformat(),
                "--out", str(out),
                "--trials", str(tmp_path / "trials.jsonl"),
                "--quiet",
            ],
        )
    finally:
        mp.undo()

    assert run.exit_code == 1
    text = out.read_text("utf-8")
    assert "DO NOT REPORT THESE NUMBERS" in text
    assert "sceptic checks failed" in text


def test_the_signal_script_fails_the_same_way(patched, tmp_path):
    mp = pytest.MonkeyPatch()
    mp.setattr(evaluate_signals, "SUSPICIOUS_IC", -1.0)
    try:
        out = tmp_path / "failed.md"
        run = _invoke(
            evaluate_signals.app,
            [
                "--start", PANEL_START.isoformat(),
                "--end", SHORT_END.isoformat(),
                "--out", str(out),
                "--trials", str(tmp_path / "trials.jsonl"),
                "--bootstrap", "25",
                "--step", "25",
                "--quiet",
            ],
        )
    finally:
        mp.undo()

    assert run.exit_code == 1
    assert "DO NOT USE THESE NUMBERS" in out.read_text("utf-8")


# -- the signal evaluation's own deliverables ----------------------------


@pytest.mark.parametrize(
    "needle",
    [
        "Information coefficient — pooled, by sub-period",
        "Information coefficient — per sleeve, full sample",
        "Hit rate at the two ends of the range",
        "Top-minus-bottom spread",
        "Long/flat on each sleeve alone",
        "The signal correlation matrix",
    ],
)
def test_the_trend_deliverables_are_all_there(signals_run, needle):
    assert needle in signals_run.report.read_text("utf-8")


def test_the_substitution_is_explained_rather_than_left_to_be_noticed(signals_run):
    """A reader must not conclude the IC test was skipped for two signals."""
    text = signals_run.report.read_text("utf-8")
    assert "why there is no information coefficient here" in text
    assert "why there is no information coefficient here either" in text
    assert "substituted, not skipped" in text
    assert "risk control that has to be justified by return" in text


def test_the_crisis_windows_are_where_the_haircut_is_measured(signals_run):
    text = signals_run.report.read_text("utf-8")
    section = text.split("## Correlation")[1]
    assert "Eff. bets before" in section
    assert "Eff. bets after" in section
    assert "2020Q1" in section


def test_both_horizons_are_measured(signals_run):
    """One session and twenty-one, as the brief asks."""
    text = signals_run.report.read_text("utf-8")
    ic = text.split("### Information coefficient — pooled")[1].split("###")[0]
    # The horizon column is right-aligned, so the cell reads " 1d" beside
    # "21d". Matched on the closing pipe rather than the opening one.
    assert " 1d |" in ic
    assert "21d |" in ic


def test_the_ic_table_carries_an_interval(signals_run):
    text = signals_run.report.read_text("utf-8")
    ic = text.split("### Information coefficient — pooled")[1].split("###")[0]
    assert "CI low" in ic and "CI high" in ic


# -- the ensemble conclusion ---------------------------------------------


def _matrix(values: dict[tuple[str, str], float]) -> evaluate_signals.SignalMatrix:
    names = ["trend", "inverse_vol", "correlation"]
    m = pd.DataFrame(np.eye(3), index=names, columns=names, dtype="float64")
    for (a, b), rho in values.items():
        m.loc[a, b] = rho
        m.loc[b, a] = rho
    return evaluate_signals.SignalMatrix(
        matrix=m,
        per_sleeve=pd.DataFrame(),
        n_cells=1_000,
        n_dates=100,
        step=5,
        limit=evaluate_signals.ENSEMBLE_RHO_LIMIT,
    )


def test_the_matrix_says_reduce_when_every_pair_is_crowded():
    """The brief's instruction, carried out in the brief's own words.

    A diagnostic that can only print a success has not tested anything,
    so the sentence it prints when the ensemble fails is pinned here.
    """
    crowded = _matrix(
        {
            ("trend", "inverse_vol"): 0.81,
            ("trend", "correlation"): 0.72,
            ("inverse_vol", "correlation"): 0.65,
        }
    )
    assert crowded.all_crowded
    assert "REDUCE TO FEWER SIGNALS" in crowded.verdict


def test_one_crowded_pair_is_not_the_reduce_case():
    partial = _matrix(
        {
            ("trend", "inverse_vol"): 0.81,
            ("trend", "correlation"): 0.10,
            ("inverse_vol", "correlation"): -0.05,
        }
    )
    assert not partial.all_crowded
    assert len(partial.crowded) == 1
    assert "REDUCE TO FEWER SIGNALS" not in partial.verdict
    assert "1 of 3 pairs" in partial.verdict


def test_low_correlations_survive_the_test_without_claiming_anything_more():
    low = _matrix(
        {
            ("trend", "inverse_vol"): 0.05,
            ("trend", "correlation"): -0.11,
            ("inverse_vol", "correlation"): 0.22,
        }
    )
    assert not low.crowded
    assert "premise survives" in low.verdict
    assert "not about any of them being right" in low.verdict


def test_the_matrix_is_symmetric_and_unit_diagonal(patched):
    sample = synthetic_sample(PANEL_START, PANEL_END)
    matrix = evaluate_signals.signal_matrix(sample, step=25).matrix
    values = matrix.to_numpy(dtype="float64")
    assert np.allclose(np.diag(values), 1.0)
    assert np.allclose(values, values.T, equal_nan=True)
    assert list(matrix.columns) == ["trend", "inverse_vol", "correlation"]


# -- the shared plumbing -------------------------------------------------


class _FakeSource:
    label = "fake"

    def __init__(self, frame: pd.DataFrame) -> None:
        self._frame = frame

    def prices(self, start, end):
        return self._frame


def test_an_empty_price_frame_is_refused_rather_than_reported(monkeypatch):
    """An empty frame is not a market fact — it is a failed request."""
    monkeypatch.setattr(
        runlib, "build_source", lambda source, *, cache: _FakeSource(pd.DataFrame())
    )
    with pytest.raises(runlib.DataUnavailable, match="failed request"):
        runlib.load_sample(PANEL_START, PANEL_END, cache=None)


def test_an_unreachable_bill_series_refuses_the_whole_pull(monkeypatch):
    """Zero is not a neutral stand-in for the hurdle.

    With a zero hurdle anything that drifted upward reads as trending,
    which in a positive-drift world is most things most of the time. A
    report generated on a silently-zero hurdle would be a claim about a
    strategy nobody ran, so FRED being dark refuses the run exactly as a
    dark price endpoint does.
    """
    from griffinquant.data.tbill import TbillUnavailable

    monkeypatch.setattr(
        runlib,
        "build_source",
        lambda source, *, cache: _FakeSource(synthetic_prices()),
    )

    def dark(start, end, **kwargs):
        raise TbillUnavailable("could not read DGS3MO from FRED: timed out.")

    monkeypatch.setattr(runlib, "fetch_rate", dark)
    with pytest.raises(runlib.DataUnavailable, match="not a neutral stand-in"):
        runlib.load_sample(PANEL_START, PANEL_END, cache=None)


def test_a_percent_rate_is_converted_once_and_only_once(monkeypatch):
    """FRED publishes percent; every formula downstream wants decimals.

    A 5.25 reaching `_rf_per_period` makes the risk-free asset compound
    73 basis points a day, and the conversion living in one place is what
    keeps that from being a possibility rather than a habit.
    """
    monkeypatch.setattr(
        runlib,
        "build_source",
        lambda source, *, cache: _FakeSource(synthetic_prices()),
    )
    sessions = nyse_sessions(PANEL_START, PANEL_END)
    monkeypatch.setattr(
        runlib,
        "fetch_rate",
        lambda start, end, **kw: pd.Series(4.25, index=sessions, dtype="float64"),
    )
    sample = runlib.load_sample(PANEL_START, PANEL_END, cache=None)
    assert float(sample.risk_free.max()) == pytest.approx(0.0425)
    assert "4.25%" in sample.rf_note


def test_the_splice_renderer_reports_a_window_with_no_splice():
    """A quiet answer, said out loud rather than by an empty table."""
    text, n = runlib.spliced_table(date(2015, 1, 1), date(2016, 1, 1))
    assert n == 0
    assert "No splice touches this window" in text


def test_a_reversed_window_is_a_caller_bug_not_a_clean_bill():
    """`spliced_periods` raises rather than reporting nothing overlaps.

    An empty tuple there would say "nothing here depends on a splice",
    which is the single most dangerous sentence the function can produce.
    """
    with pytest.raises(ValueError, match="is after end"):
        runlib.spliced_table(date(2016, 1, 1), date(2015, 1, 1))
