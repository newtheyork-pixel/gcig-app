from datetime import date, datetime, timedelta

import duckdb
import pytest

from sea_tracker.db import init_schema
from sea_tracker.derived import (
    chokepoint_pressure,
    compute_all,
    flow_health,
    hormuz_throughput_mbbl,
    iran_export_share,
    opec_coordination_z,
)

DAY = date(2026, 5, 5)
DAY_DT = datetime.combine(DAY, datetime.min.time())


@pytest.fixture
def con():
    c = duckdb.connect(":memory:")
    init_schema(c)
    yield c
    c.close()


def _seed_signal(con, day, name, value):
    con.execute(
        "INSERT INTO signals_daily (date, signal_name, value) VALUES (?, ?, ?) "
        "ON CONFLICT (date, signal_name) DO UPDATE SET value = excluded.value",
        [day, name, value],
    )


def _seed_vessel(con, mmsi, length=320, beam=60, size_class="vlcc"):
    con.execute(
        "INSERT INTO vessels (mmsi, length_m, beam_m, size_class, ship_type, last_seen) "
        "VALUES (?, ?, ?, ?, 80, ?)",
        [mmsi, length, beam, size_class, DAY_DT],
    )


def _seed_transit(con, mmsi, direction="outbound", laden=True, when=None):
    when = when or (DAY_DT + timedelta(hours=12))
    con.execute(
        "INSERT INTO transits (vessel_mmsi, crossing_ts, direction, laden, size_class, ship_type) "
        "VALUES (?, ?, ?, ?, 'vlcc', 80)",
        [mmsi, when, direction, laden],
    )


# --- hormuz_throughput_mbbl ---

def test_throughput_zero_when_no_transits(con):
    out = hormuz_throughput_mbbl(con, day=DAY)
    assert out["value"] == 0.0
    assert out["tanker_count"] == 0


def test_throughput_one_vlcc(con):
    _seed_vessel(con, 1, length=333, beam=60, size_class="vlcc")
    _seed_transit(con, 1)
    out = hormuz_throughput_mbbl(con, day=DAY)
    # Formula: 5.08 × 333 × 60 × 17 / 1,000,000 ≈ 1.72
    assert 1.6 < out["value"] < 1.85
    assert out["tanker_count"] == 1


def test_throughput_only_outbound_laden_counts(con):
    _seed_vessel(con, 1)
    _seed_vessel(con, 2)
    _seed_vessel(con, 3)
    _seed_transit(con, 1, direction="outbound", laden=True)
    _seed_transit(con, 2, direction="outbound", laden=False)   # ballast — skipped
    _seed_transit(con, 3, direction="inbound", laden=True)     # inbound — skipped
    out = hormuz_throughput_mbbl(con, day=DAY)
    assert out["tanker_count"] == 1


# --- flow_health ---

def test_flow_health_warming_up_with_no_history(con):
    _seed_signal(con, DAY, "hormuz_outbound_laden_count", 14)
    out = flow_health(con, day=DAY)
    assert out["value"] is None
    assert out["status"] == "warming_up"


def test_flow_health_healthy_at_median(con):
    for i in range(1, 11):
        _seed_signal(con, DAY - timedelta(days=i), "hormuz_outbound_laden_count", 10)
    _seed_signal(con, DAY, "hormuz_outbound_laden_count", 10)
    out = flow_health(con, day=DAY)
    assert out["value"] == 100
    assert out["status"] == "healthy"


def test_flow_health_stalled_when_today_far_below(con):
    for i in range(1, 11):
        _seed_signal(con, DAY - timedelta(days=i), "hormuz_outbound_laden_count", 20)
    _seed_signal(con, DAY, "hormuz_outbound_laden_count", 2)
    out = flow_health(con, day=DAY)
    assert out["value"] == 10
    assert out["status"] == "stalled"


# --- iran_export_share ---

def test_iran_share_warming_up_when_total_zero(con):
    out = iran_export_share(con, day=DAY)
    assert out["value"] is None


def test_iran_share_normal(con):
    _seed_signal(con, DAY, "terminal_departures_iran",   3)
    _seed_signal(con, DAY, "terminal_departures_saudi",  10)
    _seed_signal(con, DAY, "terminal_departures_kuwait", 4)
    _seed_signal(con, DAY, "terminal_departures_iraq",   3)
    _seed_signal(con, DAY, "terminal_departures_uae",    5)
    _seed_signal(con, DAY, "terminal_departures_qatar",  2)
    out = iran_export_share(con, day=DAY)
    # 3 / (3+10+4+3+5+2) = 3/27 = 11.1%
    assert out["value"] == 11.1
    assert out["status"] == "ok"


def test_iran_share_stress_when_below_three_percent(con):
    _seed_signal(con, DAY, "terminal_departures_iran",   0)
    _seed_signal(con, DAY, "terminal_departures_saudi",  20)
    _seed_signal(con, DAY, "terminal_departures_kuwait", 5)
    _seed_signal(con, DAY, "terminal_departures_iraq",   0)
    _seed_signal(con, DAY, "terminal_departures_uae",    0)
    _seed_signal(con, DAY, "terminal_departures_qatar",  0)
    out = iran_export_share(con, day=DAY)
    assert out["status"] == "stress"


# --- opec_coordination_z ---

def test_coordination_warming_up_with_no_history(con):
    out = opec_coordination_z(con, day=DAY)
    assert out["value"] is None


def test_coordination_anomaly_when_today_well_above_history(con):
    for i in range(1, 31):
        d = DAY - timedelta(days=i)
        _seed_signal(con, d, "terminal_departures_saudi", 10)
    _seed_signal(con, DAY, "terminal_departures_saudi", 50)
    out = opec_coordination_z(con, day=DAY)
    assert out["value"] is not None
    assert out["status"] == "anomaly"
    assert out["value"] > 2


# --- chokepoint_pressure ---

def test_pressure_no_outbound_returns_none(con):
    out = chokepoint_pressure(con, day=DAY)
    assert out["value"] is None
    assert out["anchored_at_strait"] == 0


def test_pressure_ok_when_low_ratio(con):
    _seed_vessel(con, 1)
    for i in range(5):
        _seed_transit(con, 1 + i, direction="outbound", when=DAY_DT + timedelta(hours=i))
        # Need vessels for FK satisfaction even if not actually a real FK
        if i > 0:
            _seed_vessel(con, 1 + i)
    out = chokepoint_pressure(con, day=DAY)
    assert out["status"] == "ok"
    assert out["value"] == 0.0
    assert out["outbound_today"] == 5


# --- compute_all ---

def test_compute_all_returns_all_keys(con):
    out = compute_all(con, day=DAY)
    assert "asOf" in out
    assert "hormuzThroughputMbbl" in out
    assert "flowHealth" in out
    assert "iranExportShare" in out
    assert "opecCoordinationZ" in out
    assert "chokepointPressure" in out
