"""Sentinel-1 SAR ship detection pipeline (scaffolding).

This module is the entry point for processing Copernicus Sentinel-1
radar imagery into ship detections that complement our terrestrial
AIS feed in waters AISStream can't see (Iran, Saudi, Kuwait, Iraq).

Pipeline stages (built in order):

  1. find_recent_scenes(bbox, days)     — STAC query Copernicus Data Space
  2. download_scene(scene, out_dir)     — pull GRD product
  3. detect_ships(scene_path, bbox)     — CFAR-based ship detection
  4. filter_tanker_class(detections)    — size filter (>180 m) for
                                          tanker-class hulls
  5. persist(con, detections)           — write to sar_detections table

The Copernicus Data Space catalog requires (free) registered
credentials. We read CDSE_USERNAME / CDSE_PASSWORD from env (or load
them out of the same .env file as the rest of the project).

Status: stage 1 scaffolding only. Stages 2-5 are stubbed; calling
them raises NotImplementedError so failures are loud, not silent.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)


# Copernicus Data Space catalog STAC root. Anonymous queries are
# allowed; download requires auth.
CDSE_STAC = "https://catalogue.dataspace.copernicus.eu/stac"
CDSE_S1_COLLECTION = "SENTINEL-1"


@dataclass(frozen=True)
class SarScene:
    """One Sentinel-1 GRD product covering our bbox."""
    id: str
    acquired_at: datetime
    href: str
    polarization: str  # e.g. "VV+VH"
    orbit_pass: str    # "ASCENDING" / "DESCENDING"


@dataclass(frozen=True)
class SarDetection:
    """One candidate ship detection from a SAR scene."""
    scene_id: str
    detected_at: datetime
    lat: float
    lon: float
    length_m: float | None
    width_m: float | None
    intensity: float        # CFAR statistic
    likely_tanker: bool     # passes the size filter


# ── Stage 1: Catalog query ───────────────────────────────────────────

def find_recent_scenes(
    bbox: tuple[float, float, float, float],
    *,
    days: int = 14,
    now: datetime | None = None,
) -> list[SarScene]:
    """Return Sentinel-1 GRD scenes covering `bbox` in the last `days`.

    Empty list if no scene's footprint intersects the bbox in the
    window. STAC queries the Copernicus Data Space catalog with no
    auth required — auth is only needed for the actual GRD download
    in stage 2.
    """
    raise NotImplementedError("Stage 2: STAC query — not built yet")


# ── Stage 2: Download ────────────────────────────────────────────────

def download_scene(scene: SarScene, out_dir: Path) -> Path:
    """Download the GRD product to `out_dir / scene.id.SAFE.zip` and
    return the path. Resumable; idempotent (skips if already on disk).

    Authentication: Copernicus Data Space OIDC token flow. Reads
    CDSE_USERNAME and CDSE_PASSWORD from the process environment —
    the operator should set these once in `C:\\sea_tracker\\.env`.
    """
    raise NotImplementedError("Stage 2: GRD download — not built yet")


# ── Stage 3: CFAR ship detection ─────────────────────────────────────

def detect_ships(
    scene_path: Path,
    bbox: tuple[float, float, float, float],
    *,
    pfa: float = 1e-6,
    guard_window: int = 7,
    train_window: int = 21,
) -> list[SarDetection]:
    """Run a 2D Constant-False-Alarm-Rate detector across the scene.

    Returns one `SarDetection` per detected hull, geocoded to lat/lon.
    Land pixels are masked using the SAR product's incidence-angle
    band (sea pixels have a characteristic distribution; land is
    skipped).
    """
    raise NotImplementedError("Stage 3: CFAR detection — not built yet")


# ── Stage 4: Tanker-class filter ─────────────────────────────────────

# Tanker size classes — see classify.py. We treat anything >= 180 m
# as "tanker-class candidate" for SAR purposes. Sub-180 m hits are
# more often tugs, supply vessels, fishing trawlers, or coastal
# shipping; including them would flood the map with non-tanker
# noise.
_TANKER_LENGTH_THRESHOLD_M = 180.0


def filter_tanker_class(detections: Iterable[SarDetection]) -> list[SarDetection]:
    """Mark detections likely to be tanker-class hulls (>= 180 m).

    Returns a new list with `likely_tanker` set per detection.
    Doesn't drop short ones — the React layer can choose to render
    them dimmer rather than hide them.
    """
    out: list[SarDetection] = []
    for d in detections:
        is_tanker = d.length_m is not None and d.length_m >= _TANKER_LENGTH_THRESHOLD_M
        out.append(SarDetection(**{**d.__dict__, "likely_tanker": is_tanker}))
    return out


# ── Stage 5: Persistence ─────────────────────────────────────────────

def persist(con, detections: Iterable[SarDetection]) -> int:
    """Insert detections into sar_detections (idempotent on
    (scene_id, lat, lon))."""
    rows = list(detections)
    if not rows:
        return 0
    con.executemany(
        """
        INSERT INTO sar_detections
            (scene_id, detected_at, lat, lon, length_m, width_m,
             intensity, likely_tanker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scene_id, lat, lon) DO NOTHING
        """,
        [
            (d.scene_id, d.detected_at, d.lat, d.lon, d.length_m,
             d.width_m, d.intensity, d.likely_tanker)
            for d in rows
        ],
    )
    return len(rows)


# ── End-to-end orchestrator ──────────────────────────────────────────

def run_once(
    con,
    *,
    bbox: tuple[float, float, float, float],
    out_dir: Path,
) -> dict:
    """Single-pass execution of the full pipeline. Idempotent: a
    scene that has already been processed is skipped. Designed to
    be called from a Task Scheduler entry every 24 h — most days
    will find no new scene and exit fast."""
    scenes = find_recent_scenes(bbox, days=14)
    if not scenes:
        logger.info("sar: no scenes in window")
        return {"scenes": 0, "detections": 0}

    n_scenes = 0
    n_dets = 0
    for s in scenes:
        already = con.execute(
            "SELECT COUNT(*) FROM sar_detections WHERE scene_id = ?",
            [s.id],
        ).fetchone()[0]
        if already > 0:
            logger.info("sar: skipping already-processed scene %s", s.id)
            continue
        path = download_scene(s, out_dir)
        raw = detect_ships(path, bbox)
        marked = filter_tanker_class(raw)
        n_dets += persist(con, marked)
        n_scenes += 1
    return {"scenes": n_scenes, "detections": n_dets}


def _missing_credentials() -> str | None:
    if not os.environ.get("CDSE_USERNAME"):
        return "CDSE_USERNAME"
    if not os.environ.get("CDSE_PASSWORD"):
        return "CDSE_PASSWORD"
    return None
