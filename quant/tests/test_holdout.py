"""Tests for a lock whose whole value is that it cannot be talked round.

The holdout does not fail through deceit. It fails through a person
looking, finding a disappointing number, changing something entirely
reasonable, and looking again — so the tests that matter are the ones
that try exactly that, in the shapes it actually takes. A second release
under a tweaked parameter. A second release under the same parameters
but a shorter window, which is a second look wearing the first look's
configuration. A fresh process that would rather infer from the ledger
that the door is already open than write a row saying it opened it.

Two properties get more attention than the rest.

**A refused release must write nothing.** If a rejected second look left
a row behind, the ledger would record attempts rather than accesses and
the next reader could not tell the two apart. And if it left the guard
released, the refusal would be decorative.

**The ledger only ever grows.** Asserted three ways: no method exists
that could shorten it, an existing file written by something else
survives the next append, and rows come back in FILE order rather than
sorted by the caller-supplied timestamp — a caller who passes a
backdated timestamp must not be able to reorder history into a shape
where their access looks like the first.

Every path here is a tmp_path. Nothing in this file may touch the real
`holdout_access.jsonl`: a test that appends to the committed ledger
would be manufacturing the exact evidence the ledger exists to hold.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from griffinquant.config import HOLDOUT_YEARS, SAMPLE_START
from griffinquant.validation.holdout import (
    HOLDOUT_ACCESS_PATH,
    HoldoutAccess,
    HoldoutBreach,
    HoldoutError,
    HoldoutGuard,
    HoldoutLedger,
    HoldoutLogCorrupt,
    HoldoutOverrideWarning,
    HoldoutReuse,
    hash_config,
    holdout_window,
    training_window,
)

SAMPLE_END = "2026-12-31"
CONFIG = {"strategy": "tsmom", "lookback": 126, "vol_target": 0.10}
TWEAKED = {"strategy": "tsmom", "lookback": 252, "vol_target": 0.10}


@pytest.fixture
def path(tmp_path):
    return tmp_path / "holdout_access.jsonl"


def guard(path, **kwargs) -> HoldoutGuard:
    return HoldoutGuard.for_sample(SAMPLE_END, path=path, **kwargs)


def panel() -> pd.DataFrame:
    """Sessions either side of the boundary, as a panel nobody has cut."""
    index = pd.bdate_range("2023-01-02", SAMPLE_END)
    return pd.DataFrame({"close": np.arange(len(index), dtype="float64")}, index=index)


def opened(path, **kwargs) -> HoldoutGuard:
    g = guard(path)
    g.release(
        reason="final evaluation of the shipped configuration",
        config=CONFIG,
        timestamp="2027-01-15T09:00:00",
        **kwargs,
    )
    return g


# -- the window ------------------------------------------------------------


def test_the_window_is_the_last_n_years_inclusive():
    window = holdout_window(SAMPLE_END)
    assert window.years == HOLDOUT_YEARS == 3
    assert window.start == pd.Timestamp("2024-01-01")
    assert window.end == pd.Timestamp("2026-12-31")
    assert window.key == "2024-01-01..2026-12-31"

    assert window.contains("2024-01-01")
    assert window.contains("2026-12-31")
    assert not window.contains("2023-12-31")
    assert "2027-01-01" not in window

    # The other side of the same cut, derived once so nobody derives it
    # twice and lands a day apart.
    assert window.training_end == pd.Timestamp("2023-12-31")
    assert training_window(SAMPLE_END) == (
        pd.Timestamp(SAMPLE_START),
        pd.Timestamp("2023-12-31"),
    )
    assert holdout_window(SAMPLE_END, years=1).start == pd.Timestamp("2026-01-01")


def test_the_boundary_is_a_calendar_day_and_not_a_session():
    """It has to mean the same thing to the price frame, the
    fundamentals frame and a person reading the report, none of which
    share a trading calendar."""
    window = holdout_window("2026-01-04", years=1)  # a Sunday
    assert window.start == pd.Timestamp("2025-01-05")  # also a Sunday
    assert window.training_end == pd.Timestamp("2025-01-04")  # a Saturday


def test_the_leap_day_wrinkle_is_the_documented_one():
    """29 February subtracts to the 28th, so the window opens on 1 March
    of the earlier year. Stated rather than fought — nothing downstream
    is sensitive to a day.

    The span is pinned as well as the boundary, because the direction is
    the part a comment gets wrong: the leap day the offset clamped past
    ends up INSIDE the window, so it comes out a day long rather than a
    day short.
    """
    window = holdout_window("2024-02-29", years=1)
    assert window.start == pd.Timestamp("2023-03-01")
    assert (window.end - window.start).days + 1 == 366
    assert (
        holdout_window("2023-12-31", years=1).end
        - holdout_window("2023-12-31", years=1).start
    ).days + 1 == 365


def test_a_holdout_of_zero_years_is_a_decision_not_an_argument():
    with pytest.raises(HoldoutError, match="reserves nothing"):
        holdout_window(SAMPLE_END, years=0)


def test_a_sample_too_short_to_carry_the_holdout_says_which_end_is_wrong():
    with pytest.raises(HoldoutError, match="no training period left"):
        training_window("2007-01-01", years=3, sample_start="2005-01-01")


def test_the_window_has_no_default_of_today():
    """A reserved range whose boundary depends on when the script ran
    grows a day of new out-of-sample every morning."""
    with pytest.raises(TypeError):
        holdout_window()


# -- development is the default --------------------------------------------


def test_a_development_time_request_inside_the_window_raises(path):
    g = guard(path)
    assert g.mode == "development"
    assert not g.released

    with pytest.raises(HoldoutBreach) as exc:
        g.check(panel(), what="the price panel")
    message = str(exc.value)
    assert "the price panel reaches into the reserved holdout" in message
    assert "2024-01-01" in message and "2026-12-31" in message
    assert "DEVELOPMENT" in message
    assert "cut the data at 2023-12-31" in message

    with pytest.raises(HoldoutBreach, match="reading the holdout period"):
        g.holdout_slice(panel())
    with pytest.raises(HoldoutBreach, match="Nothing has been released"):
        g.require_released("writing the final report")


def test_the_training_slice_is_safe_in_either_mode_and_stops_at_the_boundary(path):
    g = guard(path)
    train = g.training_slice(panel())
    assert train.index.max() == pd.Timestamp("2023-12-29")
    assert train.index.max() <= g.window.training_end
    g.check(train)  # the whole point: what it returns passes the guard

    after = opened(path)
    assert len(after.training_slice(panel())) == len(train)


def test_a_frame_that_stops_before_the_boundary_is_not_a_breach(path):
    clean = panel().loc[: pd.Timestamp("2023-12-31")]
    guard(path).check(clean)
    guard(path).check(pd.DatetimeIndex([]))
    guard(path).check(None)


def test_dates_are_read_from_a_column_when_there_is_no_datetime_index(path):
    frame = panel().reset_index(names="date")
    with pytest.raises(HoldoutBreach, match="observation"):
        guard(path).check(frame)
    with pytest.raises(HoldoutError, match="no column 'asof'"):
        guard(path).check(frame, column="asof")
    with pytest.raises(HoldoutError, match="Name the column explicitly"):
        guard(path).check(panel().reset_index(drop=True))


def test_a_numeric_date_column_is_refused_rather_than_read_as_1970(path):
    """The most important refusal in the file. `pd.to_datetime` reads a
    float as nanoseconds since the epoch, so a mis-typed column would
    clear every holdout check ever written and return a clean bill of
    health for a panel nobody checked."""
    mistyped = pd.DataFrame({"date": np.arange(3, dtype="float64"), "close": 1.0})
    with pytest.raises(HoldoutError, match="1970"):
        guard(path).check(mistyped)


# -- the first release ------------------------------------------------------


def test_the_first_release_is_recorded_and_opens_the_door(path):
    g = guard(path)
    access = g.release(
        reason="final evaluation of the shipped configuration",
        config=CONFIG,
        timestamp="2027-01-15T09:00:00",
    )

    assert g.released
    assert g.mode == "final evaluation"
    assert g.access is access
    assert access.timestamp == "2027-01-15T09:00:00"
    assert access.config_hash == hash_config(CONFIG)
    assert access.window == "2024-01-01..2026-12-31"
    assert access.override is False
    assert access.override_reason == ""
    assert access.supersedes == ""

    ledger = HoldoutLedger(path)
    assert ledger.count() == 1
    assert ledger.first_access() == access
    assert ledger.frame().loc[0, "reason"].startswith("final evaluation")
    assert "released against config" in access.describe()

    # And now, and only now, the reserved rows come out.
    reserved = g.holdout_slice(panel())
    assert reserved.index.min() == pd.Timestamp("2024-01-01")
    assert reserved.index.max() == pd.Timestamp("2026-12-31")
    g.check(panel())
    g.require_released()


def test_the_hash_is_the_trial_ledger_s_so_the_two_files_join(path):
    """Reading the access log next to trials.jsonl has to answer "which
    of the N things we tried did we spend the holdout on"."""
    from griffinquant.engine.metrics import TrialCounter

    assert hash_config(CONFIG) == TrialCounter.hash_config(CONFIG)
    assert hash_config("already-a-hash") == "already-a-hash"


def test_a_release_without_a_reason_is_the_same_event_as_an_unrecorded_one(path):
    with pytest.raises(HoldoutError, match="needs a reason"):
        guard(path).release(reason="  ", config=CONFIG, timestamp="2027-01-15")
    assert not path.exists()


def test_the_timestamp_is_an_argument_and_never_the_wall_clock(path):
    with pytest.raises(HoldoutError, match="timestamp must be"):
        guard(path).release(reason="final", config=CONFIG, timestamp=20270115)
    with pytest.raises(HoldoutError, match="timestamp is empty"):
        guard(path).release(reason="final", config=CONFIG, timestamp="   ")


# -- the second look --------------------------------------------------------


def test_a_second_release_under_a_different_config_raises_and_names_the_first(path):
    """The event this module exists for. The person about to invalidate
    a result is told what they are invalidating before they do it."""
    first = opened(path).access

    second = guard(path)  # a fresh process, a fresh guard
    with pytest.raises(HoldoutReuse) as exc:
        second.release(
            reason="the vol target looked wrong on the holdout",
            config=TWEAKED,
            timestamp="2027-02-01T10:00:00",
        )

    message = str(exc.value)
    assert first.timestamp in message
    assert first.config_hash in message
    assert first.window in message
    assert first.reason in message
    assert "makes every result since the first one in-sample" in message

    # A refused release writes nothing and opens nothing.
    assert not second.released
    assert HoldoutLedger(path).count() == 1


def test_shrinking_the_window_is_a_second_look_in_the_first_look_s_clothes(path):
    opened(path)
    smaller = HoldoutGuard.for_sample(SAMPLE_END, years=1, path=path)
    with pytest.raises(HoldoutReuse, match="different window"):
        smaller.release(
            reason="just the most recent year", config=CONFIG, timestamp="2027-02-01"
        )
    assert HoldoutLedger(path).count() == 1


def test_re_running_the_recorded_evaluation_is_reproduction_and_is_allowed(path):
    opened(path)
    again = guard(path)
    again.release(
        reason="reproducing the reported result for the write-up",
        config=CONFIG,
        timestamp="2027-03-01",
    )
    assert again.released
    assert HoldoutLedger(path).count() == 2


def test_a_released_flag_is_never_inferred_from_the_ledger_having_rows(path):
    """Otherwise the second process reads the reserved data without
    writing anything down, which is the whole failure mode wearing a
    convenience feature."""
    opened(path)
    fresh = guard(path)
    assert HoldoutLedger(path).count() == 1
    assert not fresh.released
    with pytest.raises(HoldoutBreach):
        fresh.holdout_slice(panel())


# -- the override -----------------------------------------------------------


def test_the_override_works_warns_and_records_its_reason(path):
    first = opened(path).access

    breaker = guard(path)
    with pytest.warns(HoldoutOverrideWarning, match="Every result computed"):
        access = breaker.release(
            reason="re-evaluation after the fill model was fixed",
            config=TWEAKED,
            timestamp="2027-04-01T11:30:00",
            override=True,
            override_reason="the fill model double-counted the spread on every sell",
        )

    assert breaker.released
    assert access.override is True
    assert access.override_reason.startswith("the fill model double-counted")
    assert access.supersedes == first.config_hash
    assert "[OVERRIDE, superseding" in access.describe()

    rows = HoldoutLedger(path).accesses()
    assert len(rows) == 2
    assert rows[0] == first  # the first look is still on file, unedited
    assert rows[1] == access


def test_after_an_override_the_terms_are_the_overriding_row_s(path):
    """A decided judgement, pinned so it stays decided.

    Comparing forever against the first row would make reproducing the
    CURRENT reported result require another override — filling the ledger
    with supersessions that never happened until the flag stops meaning
    what it says — and would point `supersedes` two steps back, so the
    chain a reader follows is wrong at every link. The first look is not
    lost: it is still row zero, still what `first_access` returns, and
    still named in the refusal along with how many looks have been spent.
    """
    first = opened(path).access
    with pytest.warns(HoldoutOverrideWarning):
        overriding = guard(path).release(
            reason="re-evaluation after the fill model was fixed",
            config=TWEAKED,
            timestamp="2027-04-01",
            override=True,
            override_reason="the fill model double-counted the spread",
        )
    assert overriding.supersedes == first.config_hash

    # Reproducing what is NOW the reported result is reproduction, and
    # under the old rule it would have needed an override of its own.
    repeat = guard(path)
    repeat.release(
        reason="reproducing the reported result for the write-up",
        config=TWEAKED,
        timestamp="2027-05-01",
    )
    assert repeat.released
    assert HoldoutLedger(path).count() == 3

    # Going back to the original configuration is now the departure, and
    # the refusal describes the row in force rather than the one it
    # replaced — while still saying where the sequence started.
    with pytest.raises(HoldoutReuse) as exc:
        guard(path).release(
            reason="going back to the old lookback",
            config=CONFIG,
            timestamp="2027-06-01",
        )
    message = str(exc.value)
    assert f"released on {repeat.access.timestamp}" in message
    assert f"against config {hash_config(TWEAKED)}" in message
    assert "3 release(s) are already on file" in message
    assert first.timestamp in message

    with pytest.warns(HoldoutOverrideWarning):
        third = guard(path).release(
            reason="going back to the old lookback",
            config=CONFIG,
            timestamp="2027-06-01",
            override=True,
            override_reason="the restatement reversed the reason for the change",
        )
    assert third.supersedes == hash_config(TWEAKED)
    assert HoldoutLedger(path).first_access() == first
    assert HoldoutLedger(path).last_access() == third


def test_an_override_has_to_say_why(path):
    opened(path)
    with pytest.raises(HoldoutError, match="needs an override_reason"):
        guard(path).release(
            reason="rerun", config=TWEAKED, timestamp="2027-04-01", override=True
        )
    assert HoldoutLedger(path).count() == 1


def test_an_override_with_nothing_to_supersede_is_refused(path):
    with pytest.raises(HoldoutError, match="empty ledger"):
        guard(path).release(
            reason="final",
            config=CONFIG,
            timestamp="2027-01-15",
            override=True,
            override_reason="there is nothing to override",
        )
    opened(path)  # the first look, recorded
    with pytest.raises(HoldoutError, match="Drop the flag"):
        guard(path).release(
            reason="reproducing the reported result",
            config=CONFIG,
            timestamp="2027-05-01",
            override=True,
            override_reason="not actually a second look",
        )
    assert HoldoutLedger(path).count() == 1


# -- the ledger only grows ---------------------------------------------------


def test_the_ledger_is_append_only_across_repeated_opens(path):
    stamps = ["2027-01-15", "2027-03-01", "2027-06-01", "2027-09-01"]
    for i, stamp in enumerate(stamps):
        g = guard(path)
        g.release(
            reason=f"reproduction {i}" if i else "the first look",
            config=CONFIG,
            timestamp=stamp,
        )
        assert HoldoutLedger(path).count() == i + 1

    ledger = HoldoutLedger(path)
    assert [r.timestamp for r in ledger.accesses()] == stamps
    assert ledger.first_access().reason == "the first look"
    assert len(ledger.frame()) == 4

    for name in ("reset", "clear", "truncate", "delete", "remove", "rewrite"):
        assert not hasattr(ledger, name)


def test_an_existing_file_survives_the_next_append(path):
    path.write_text(
        json.dumps(
            {
                "timestamp": "2027-01-01",
                "reason": "written by hand",
                "config_hash": "aa",
                "window": "2024-01-01..2026-12-31",
                "override": False,
                "override_reason": "",
                "supersedes": "",
            }
        )
        + "\n",
        "utf-8",
    )
    before = path.read_text("utf-8")
    HoldoutLedger(path).append(
        HoldoutAccess(
            timestamp="2027-01-02",
            reason="by the harness",
            config_hash="bb",
            window="2024-01-01..2026-12-31",
            override=False,
            override_reason="",
            supersedes="",
        )
    )
    after = path.read_text("utf-8")
    assert after.startswith(before)
    assert [r.config_hash for r in HoldoutLedger(path).accesses()] == ["aa", "bb"]


def test_rows_come_back_in_file_order_and_not_by_their_timestamps(path):
    """A caller who passes a backdated timestamp must not be able to
    reorder history into a shape where their access looks like the
    first."""
    ledger = HoldoutLedger(path)
    written = (("2027-06-01", "the real first look"), ("2020-01-01", "backdated"))
    for stamp, tag in written:
        ledger.append(
            HoldoutAccess(
                timestamp=stamp,
                reason=tag,
                config_hash=hash_config({"tag": tag}),
                window="2024-01-01..2026-12-31",
                override=False,
                override_reason="",
                supersedes="",
            )
        )
    assert ledger.first_access().reason == "the real first look"
    assert [r.timestamp for r in ledger.accesses()] == ["2027-06-01", "2020-01-01"]


def test_a_corrupt_line_raises_rather_than_being_skipped(path):
    """A dropped line can erase the record of a first access, and a
    second look with no first look on file reads exactly like an honest
    one."""
    path.write_text('{"timestamp": "2027-01-01"\n', "utf-8")
    with pytest.raises(HoldoutLogCorrupt, match="Refusing to skip"):
        HoldoutLedger(path).accesses()

    path.write_text('{"timestamp": "2027-01-01", "reason": "x"}\n', "utf-8")
    with pytest.raises(HoldoutLogCorrupt, match="will not parse"):
        HoldoutLedger(path).accesses()


def test_an_absent_ledger_reads_as_shut_rather_than_raising(tmp_path):
    ledger = HoldoutLedger(tmp_path / "never-written.jsonl")
    assert ledger.accesses() == []
    assert ledger.first_access() is None
    assert ledger.count() == 0
    assert ledger.frame().empty


def test_the_committed_ledger_lives_in_the_tree_where_a_diff_can_see_it():
    """Not gitignored, for the same reason trials.jsonl is not: a record
    that can be quietly deleted is not a record."""
    from griffinquant.engine.metrics import TRIALS_PATH

    assert HOLDOUT_ACCESS_PATH.name == "holdout_access.jsonl"
    assert HOLDOUT_ACCESS_PATH.parent == TRIALS_PATH.parent

    hidden = {"*.jsonl", "holdout_access.jsonl", "quant/holdout_access.jsonl"}
    for folder in (HOLDOUT_ACCESS_PATH.parent, *HOLDOUT_ACCESS_PATH.parents[1:3]):
        rules = folder / ".gitignore"
        if not rules.exists():
            continue
        lines = {line.strip() for line in rules.read_text("utf-8").splitlines()}
        assert not (lines & hidden), f"{rules} would hide the access ledger"
