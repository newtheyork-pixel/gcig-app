from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Protocol

from sea_tracker.db import (
    batch_insert_messages,
    connect,
    init_schema,
    last_message_ts,
    mark_gap,
    upsert_vessel,
)
from sea_tracker.normalize import normalize_message

logger = logging.getLogger(__name__)

# Long enough not to spam a healthy run, short enough that a dead stream
# is visible within one working session rather than at the next daily
# batch.
HEARTBEAT_INTERVAL_S = 300.0


class Streamer(Protocol):
    def stream(self) -> AsyncIterator[dict[str, Any]]: ...


async def run_collector(
    client: Streamer,
    db_path: Path | str,
    *,
    flush_interval_s: float = 1.0,
    max_messages: int | None = None,
    publish_callback: Callable[[Any], None] | None = None,
    publish_interval_s: float = 120.0,
) -> None:
    """Pump messages from `client.stream()` into DuckDB. Runs forever unless
    `max_messages` is set (used by tests).

    If `publish_callback` is set, it's invoked with the live DuckDB
    connection every `publish_interval_s` seconds. This is how the
    Windows-side collector pushes 2-min snapshots to gcig-api without
    a second process — DuckDB on Windows holds an exclusive file lock,
    so multi-process concurrent access doesn't work; reusing the
    writer's own connection sidesteps it entirely. Failures in the
    callback are logged and never crash the collector.
    """
    con = connect(db_path)
    init_schema(con)

    last_seen = last_message_ts(con)
    if last_seen is not None:
        mark_gap(con, last_seen + timedelta(seconds=1), datetime.utcnow(), "restart")

    buffer_msgs: list[dict[str, Any]] = []
    buffer_vessels: list[dict[str, Any]] = []
    last_flush = asyncio.get_event_loop().time()
    last_publish = asyncio.get_event_loop().time()
    seen = 0

    # A collector receiving nothing was indistinguishable from a healthy
    # one: the only log lines on this path were two warnings inside
    # ais_client, so a stream that connects and delivers zero messages
    # wrote nothing at all. It ran that way for eighteen days while the
    # tanker page reported zero departures from every Gulf terminal as
    # though it were a reading. The heartbeat below is the line that
    # would have caught it on day one, and it must fire on zero —
    # logging only when data arrives reproduces the original silence.
    logger.info("collector starting: db=%s publish_interval=%ss", db_path, publish_interval_s)
    seen_at_last_beat = 0
    last_beat = asyncio.get_event_loop().time()
    first_message_logged = False

    try:
        async for payload in client.stream():
            norm = normalize_message(payload)
            if norm is not None:
                buffer_msgs.append(norm.message_row)
                if norm.vessel_update is not None:
                    buffer_vessels.append(norm.vessel_update)
                seen += 1

            if norm is not None and not first_message_logged:
                first_message_logged = True
                logger.info("first AIS message decoded — stream is live")

            now = asyncio.get_event_loop().time()

            # Fires whether or not anything arrived. "0 in the last 300s"
            # is the whole point.
            if (now - last_beat) >= HEARTBEAT_INTERVAL_S:
                delta = seen - seen_at_last_beat
                logger.log(
                    logging.INFO if delta else logging.WARNING,
                    "heartbeat: %d messages in last %.0fs (total %d)%s",
                    delta, now - last_beat, seen,
                    "" if delta else " — connected but receiving nothing",
                )
                seen_at_last_beat = seen
                last_beat = now

            if (now - last_flush) >= flush_interval_s or seen >= 5000:
                if buffer_msgs:
                    batch_insert_messages(con, buffer_msgs)
                    buffer_msgs.clear()
                for v in buffer_vessels:
                    upsert_vessel(con, **v)
                buffer_vessels.clear()
                last_flush = now

            if publish_callback is not None and (now - last_publish) >= publish_interval_s:
                try:
                    publish_callback(con)
                except Exception as exc:
                    logger.warning("snapshot publish failed: %s", exc)
                # Mark the attempt regardless — don't retry-storm if
                # Render is down for an extended window.
                last_publish = now

            if max_messages is not None and seen >= max_messages:
                break

        # final flush
        if buffer_msgs:
            batch_insert_messages(con, buffer_msgs)
        for v in buffer_vessels:
            upsert_vessel(con, **v)
    finally:
        con.close()
