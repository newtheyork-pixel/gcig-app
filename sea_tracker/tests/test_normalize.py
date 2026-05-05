from datetime import datetime

from sea_tracker.normalize import _parse_ts


def test_microsecond_precision():
    out = _parse_ts("2026-05-04 12:34:56.789012 +0000")
    assert out == datetime(2026, 5, 4, 12, 34, 56, 789012)


def test_nanosecond_precision_truncates():
    # AISStream commonly emits 9 fractional digits; %f only takes 6.
    out = _parse_ts("2026-05-05 03:02:51.978011581 +0000")
    assert out == datetime(2026, 5, 5, 3, 2, 51, 978011)


def test_no_fractional():
    out = _parse_ts("2026-05-05 03:02:51 +0000")
    assert out == datetime(2026, 5, 5, 3, 2, 51)


def test_legacy_utc_suffix():
    out = _parse_ts("2026-05-05 03:02:51.123 +0000 UTC")
    assert out == datetime(2026, 5, 5, 3, 2, 51, 123000)


def test_unparseable_raises():
    import pytest
    with pytest.raises(ValueError, match="unparseable ts"):
        _parse_ts("garbage")


def test_empty_returns_now_naive_utc():
    out = _parse_ts(None)
    assert out.tzinfo is None
