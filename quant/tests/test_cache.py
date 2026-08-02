"""The cache exists so an audit outlives the credentials that fed it,
and every test here defends one of the two ways that goes wrong.

The first is caching a failure. A None, an empty frame standing in for
an outage, a half-written page — any of them stored under a success's
TTL turns one throttled minute into a week of missing rows, and missing
rows do not announce themselves. They arrive as a slightly smaller
universe and a slightly better Sharpe. So the tests assert the negative
space: after a loader raises there is no entry at all, and there is no
API through which one could have been made.

The second is a key that means something different next release. Params
are hashed from canonical JSON rather than a dict's repr, so the same
pull requested with its arguments in a different order is the same
entry. A key that misses its own cache does not fail loudly; it
re-downloads, silently, forever.

Nothing here reads the wall clock. `put` takes the caller's stamp and
`get` takes the caller's `now`, which is exactly what makes expiry
testable without sleeping.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from griffinquant.data.cache import (
    CacheKey,
    ParquetCache,
    OPEN_RANGE_TTL_DAYS,
    UNKNOWN_FRAME_TTL_DAYS,
)


T0 = datetime(2026, 3, 1, 12, 0, 0)


@pytest.fixture
def cache(tmp_path: Path) -> ParquetCache:
    return ParquetCache(tmp_path / "cache")


def frame(rows: int = 3) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "permaticker": pd.Series(range(rows), dtype="int64"),
            "ticker": pd.Series([f"T{i}" for i in range(rows)], dtype="str"),
            "close": pd.Series([1.5] * rows, dtype="float64"),
        }
    )


# -- round trip ----------------------------------------------------------


def test_round_trip_returns_the_frame_that_went_in(cache: ParquetCache):
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1), end=date(2020, 1, 1))
    assert cache.get(key) is None

    cache.put(key, frame(), stamped=T0)
    got = cache.get(key)

    assert got is not None
    pd.testing.assert_frame_equal(got, frame())


def test_the_stray_index_never_makes_it_to_disk(cache: ParquetCache):
    # A written index comes back as __index_level_0__ and fails the
    # schema validation the loader runs on the way out — a long way from
    # here, wearing a message about the vendor.
    key = cache.key("sharadar", "prices")
    cache.put(key, frame().iloc[1:], stamped=T0)
    assert list(cache.get(key).columns) == ["permaticker", "ticker", "close"]


def test_a_zero_row_frame_is_a_real_answer_and_is_stored(cache: ParquetCache):
    # "Nothing in that range" is a finding. `SourceUnavailable` is not,
    # and base.py draws that line precisely so this one can be stored.
    key = cache.key("sharadar", "actions", start=date(2007, 1, 1))
    cache.put(key, frame(0), stamped=T0)
    got = cache.get(key)
    assert got is not None and len(got) == 0


def test_a_miss_and_a_stored_nothing_are_not_the_same_state(cache: ParquetCache):
    stored = cache.key("sharadar", "actions", start=date(2007, 1, 1))
    never = cache.key("sharadar", "actions", start=date(2008, 1, 1))
    cache.put(stored, frame(0), stamped=T0)
    assert cache.get(stored) is not None
    assert cache.get(never) is None


def test_metadata_records_what_was_asked_and_what_came_back(cache: ParquetCache):
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1))
    cache.put(key, frame(3), stamped=T0)
    meta = cache.metadata(key)
    assert meta["rows"] == 3
    assert meta["frame"] == "prices"
    assert meta["params"] == {"start": "2005-01-01"}
    assert meta["stamped"] == T0.isoformat()


# -- key stability -------------------------------------------------------


def test_param_order_does_not_change_the_key():
    a = CacheKey("sharadar", "prices", {"start": "2005-01-01", "end": "2020-01-01"})
    b = CacheKey("sharadar", "prices", {"end": "2020-01-01", "start": "2005-01-01"})
    assert a.digest == b.digest
    assert a.stem == b.stem
    assert a == b
    assert hash(a) == hash(b)
    assert len({a, b}) == 1


def test_a_frame_written_under_one_param_order_is_read_under_another(
    cache: ParquetCache,
):
    write = cache.key("sharadar", "prices", start=date(2005, 1, 1), end=date(2020, 1, 1))
    read = cache.key("sharadar", "prices", end=date(2020, 1, 1), start=date(2005, 1, 1))
    cache.put(write, frame(), stamped=T0)
    assert cache.get(read) is not None


def test_a_date_and_its_own_iso_string_name_the_same_pull():
    typed = CacheKey("sharadar", "prices", {"end": date(2020, 1, 1)})
    spelled = CacheKey("sharadar", "prices", {"end": "2020-01-01"})
    assert typed.digest == spelled.digest


def test_the_source_and_frame_are_in_the_digest_not_only_the_path():
    # Two source names that sanitise to the same directory must still
    # not be able to read each other's entries.
    assert CacheKey("a/b", "prices").digest != CacheKey("a_b", "prices").digest
    assert CacheKey("s", "prices").digest != CacheKey("s", "actions").digest


def test_a_param_with_no_stable_json_form_is_refused_rather_than_stringified():
    # A silent str() of an object whose repr carries a memory address
    # produces a key that is never hit twice, and the symptom is a cache
    # that appears to work and never returns anything.
    class Opaque:
        pass

    with pytest.raises(TypeError) as exc:
        CacheKey("sharadar", "prices", {"thing": Opaque()}).digest
    assert "no stable JSON form" in str(exc.value)


# -- expiry --------------------------------------------------------------


def test_without_a_clock_nothing_ever_expires(cache: ParquetCache):
    # The reviewer's path: they have the saved pull and no key to
    # refresh it with, and an entry expiring underneath them would leave
    # them unable to reproduce the report from the bytes it was written
    # from.
    key = cache.key("sharadar", "security_master")
    cache.put(key, frame(), stamped=datetime(2001, 1, 1))
    assert cache.get(key) is not None


def test_a_daily_frame_goes_stale_against_an_injected_now(cache: ParquetCache):
    key = cache.key("sharadar", "security_master")
    cache.put(key, frame(), stamped=T0)

    fresh = T0 + pd.Timedelta(hours=23).to_pytimedelta()
    stale = T0 + pd.Timedelta(days=1, seconds=1).to_pytimedelta()

    assert cache.get(key, now=fresh) is not None
    assert cache.get(key, now=stale) is None
    # Stale is a miss, not a deletion: the bytes may be the only copy of
    # a pull that cost credentials.
    assert cache.metadata(key) is not None


def test_a_closed_historical_range_does_not_age_out(cache: ParquetCache):
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1), end=date(2019, 12, 31))
    cache.put(key, frame(), stamped=T0)
    assert cache.get(key, now=T0 + pd.Timedelta(days=900).to_pytimedelta()) is not None


def test_a_range_still_accruing_todays_bar_expires_daily(cache: ParquetCache):
    # Whether a range is closed is judged against `now`, not against the
    # stamp: a pull whose end date has not arrived yet is still having
    # bars printed into it however long ago it was fetched.
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1), end=date(2026, 3, 5))
    cache.put(key, frame(), stamped=T0)
    just_over = T0 + pd.Timedelta(days=OPEN_RANGE_TTL_DAYS + 0.01).to_pytimedelta()
    assert cache.get(key, now=just_over) is None
    assert cache.get(key, now=T0 + pd.Timedelta(hours=2).to_pytimedelta()) is not None


def test_a_range_with_no_stated_end_is_treated_as_ending_today(cache: ParquetCache):
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1))
    cache.put(key, frame(), stamped=T0)
    just_over = T0 + pd.Timedelta(days=OPEN_RANGE_TTL_DAYS + 0.01).to_pytimedelta()
    assert cache.get(key, now=just_over) is None


def test_an_unregistered_frame_kind_is_assumed_to_move(cache: ParquetCache):
    # Defaulting a typo in `frame` to immortal would mint a permanent
    # entry nobody ever refreshes.
    key = cache.key("sharadar", "prices_typo", end=date(2010, 1, 1))
    cache.put(key, frame(), stamped=T0)
    over = T0 + pd.Timedelta(days=UNKNOWN_FRAME_TTL_DAYS + 0.01).to_pytimedelta()
    assert cache.get(key, now=over) is None


def test_an_entry_whose_stamp_cannot_be_read_is_not_fresh(cache: ParquetCache):
    key = cache.key("sharadar", "security_master")
    cache.put(key, frame(), stamped=T0)
    _, side = cache._paths(key)
    meta = json.loads(side.read_text("utf-8"))
    meta["stamped"] = "the other day"
    side.write_text(json.dumps(meta), "utf-8")
    assert cache.get(key, now=T0) is None


def test_a_timezone_aware_stamp_is_compared_in_utc(cache: ParquetCache):
    key = cache.key("sharadar", "security_master")
    cache.put(key, frame(), stamped=datetime(2026, 3, 1, 12, tzinfo=timezone.utc))
    assert cache.metadata(key)["stamped"] == "2026-03-01T12:00:00"
    assert cache.get(key, now=datetime(2026, 3, 1, 18)) is not None


# -- corruption ----------------------------------------------------------


def test_a_corrupt_parquet_reads_as_a_miss_and_the_bytes_survive(cache: ParquetCache):
    key = cache.key("sharadar", "prices", end=date(2019, 12, 31))
    path = cache.put(key, frame(), stamped=T0)
    path.write_bytes(b"this is not a parquet file")

    assert cache.get(key) is None
    # Deliberately not deleted. A later reader may parse what this one
    # could not, and the file may be the only copy of the pull.
    assert path.is_file()


def test_a_frame_with_no_sidecar_is_incomplete_rather_than_present(
    cache: ParquetCache,
):
    # Both halves are written to a temp name and renamed, sidecar last,
    # so a process killed mid-write leaves a miss and not a short frame.
    key = cache.key("sharadar", "prices")
    cache.put(key, frame(), stamped=T0)
    _, side = cache._paths(key)
    side.unlink()
    assert cache.metadata(key) is None
    assert cache.get(key) is None


def test_an_unparseable_sidecar_reads_as_a_miss(cache: ParquetCache):
    key = cache.key("sharadar", "prices")
    cache.put(key, frame(), stamped=T0)
    _, side = cache._paths(key)
    side.write_text("{ not json", "utf-8")
    assert cache.get(key) is None


# -- failures are never cached -------------------------------------------


def test_a_raising_loader_leaves_no_entry_behind(cache: ParquetCache):
    key = cache.key("sharadar", "prices", start=date(2005, 1, 1))

    def loader() -> pd.DataFrame:
        raise RuntimeError("throttled by the vendor")

    with pytest.raises(RuntimeError):
        cache.get_or_load(key, loader, stamped=T0)

    assert cache.get(key) is None
    assert cache.metadata(key) is None
    assert cache.stats().entries == 0


def test_the_next_attempt_after_a_failure_still_reads_as_a_miss(cache: ParquetCache):
    key = cache.key("sharadar", "prices")
    calls: list[int] = []

    def flaky() -> pd.DataFrame:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("outage")
        return frame()

    with pytest.raises(RuntimeError):
        cache.get_or_load(key, flaky, stamped=T0)
    got = cache.get_or_load(key, flaky, stamped=T0)

    assert len(got) == 3
    assert len(calls) == 2


@pytest.mark.parametrize("bad", [None, "", 0, [], {"a": 1}])
def test_there_is_no_way_to_store_anything_but_a_frame(cache: ParquetCache, bad):
    key = cache.key("sharadar", "prices")
    with pytest.raises(TypeError) as exc:
        cache.put(key, bad, stamped=T0)
    assert "only a successful pull is cacheable" in str(exc.value)
    assert cache.metadata(key) is None


def test_get_or_load_only_calls_the_loader_on_a_miss(cache: ParquetCache):
    key = cache.key("sharadar", "prices")
    calls: list[int] = []

    def loader() -> pd.DataFrame:
        calls.append(1)
        return frame()

    cache.get_or_load(key, loader, stamped=T0)
    cache.get_or_load(key, loader, stamped=T0)
    assert len(calls) == 1

    cache.get_or_load(key, loader, stamped=T0, refresh=True)
    assert len(calls) == 2


# -- housekeeping --------------------------------------------------------


def test_constructing_a_cache_does_not_create_a_directory(tmp_path: Path):
    root = tmp_path / "never"
    store = ParquetCache(root)
    assert not root.exists()
    assert store.stats() == store.stats()
    assert store.stats().entries == 0


def test_stats_counts_completed_entries_not_orphaned_frames(cache: ParquetCache):
    cache.put(cache.key("sharadar", "prices"), frame(), stamped=T0)
    cache.put(cache.key("sharadar", "actions"), frame(), stamped=T0)
    cache.put(cache.key("synthetic", "prices"), frame(), stamped=T0)

    stats = cache.stats()
    assert stats.entries == 3
    assert stats.by_source == {"sharadar": 2, "synthetic": 1}
    assert stats.bytes > 0

    _, side = cache._paths(cache.key("sharadar", "prices"))
    side.unlink()
    assert cache.stats().entries == 2


def test_clear_removes_one_source_and_leaves_the_others(cache: ParquetCache):
    cache.put(cache.key("sharadar", "prices"), frame(), stamped=T0)
    cache.put(cache.key("synthetic", "prices"), frame(), stamped=T0)

    assert cache.clear("sharadar") == 1
    assert cache.stats().by_source == {"synthetic": 1}
    assert cache.clear() == 1
    assert cache.stats().entries == 0


def test_clear_leaves_files_that_were_never_ours(cache: ParquetCache):
    # `root` is caller-supplied and one mistyped path is all it takes to
    # remove a directory that was never ours, which is why this is not
    # an rmtree.
    cache.put(cache.key("sharadar", "prices"), frame(), stamped=T0)
    stranger = cache.root / "sharadar" / "notes.txt"
    stranger.write_text("someone else's", "utf-8")

    cache.clear("sharadar")
    assert stranger.is_file()
