"""A parquet cache on disk, so an audit outlives its credentials.

The pull is the expensive, privileged half of this repository: it wants
a vendor key, it takes minutes, and it is the one step a reviewer
cannot repeat. Everything downstream is a pure function of the four
frames. Writing those frames to disk under a stable key is what turns
"trust the number in the report" into "rerun it yourself" — the
reviewer needs this directory and nothing else.

Two traps shape the file.

**A failure is never cached.** Not a None, not an empty frame standing
in for an outage, not a half-written page. A null stored under a
success's TTL turns one throttled minute into a week of missing data,
and missing data does not announce itself: it arrives as a slightly
smaller universe and a slightly better Sharpe. So `put` only accepts a
DataFrame the caller is already holding, `get_or_load` lets the
exception through untouched, and there is deliberately no API for
recording that a pull went wrong. A zero-row frame *is* storable —
"nothing in that range" is an answer, `SourceUnavailable` is not, and
base.py draws that line for exactly this reason. `get` returning None
therefore always means "not cached", never "cached nothing".

**Keys are hashed from canonical JSON, never from a dict's repr.** A
repr follows insertion order and carries whatever float and enum
spelling the interpreter happens to use this release, so the same pull
requested with its arguments in a different order would miss its own
entry and silently re-download. Sorted keys, compact separators,
sha256, sixteen hex characters.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

import pandas as pd

#: Derived from this file rather than spelled out, so a clone living
#: somewhere else writes into its own tree instead of the author's.
DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "data" / "cache"

#: Max age in days per frame kind. None means the entry does not age
#: out on a timer — see `_max_age_days` for the one condition attached
#: to that.
#:
#: The master and the actions feed both move every session: a delisting
#: lands, a ticker gets recycled, a split is announced. Holding either
#: for a week is how a survivorship audit ends up blind to the very
#: names it exists to find.
DEFAULT_TTL_DAYS: Mapping[str, float | None] = {
    "security_master": 1.0,
    "actions": 1.0,
    "prices": None,
    "fundamentals": None,
}

#: A frame kind nobody registered is assumed to move. Defaulting an
#: unrecognised name to immortal would let a typo in `frame` mint a
#: permanent entry.
UNKNOWN_FRAME_TTL_DAYS: float = 1.0

#: What a "never expires" frame falls back to when its range is still
#: open — an `end` at or after `now` means today's bar is still being
#: printed into it.
OPEN_RANGE_TTL_DAYS: float = 1.0

_CLOSED_RANGE_FRAMES = frozenset({"prices", "fundamentals"})

_OUR_SUFFIXES = frozenset({".parquet", ".json", ".tmp"})
_UNSAFE_IN_NAME = re.compile(r"[^A-Za-z0-9._-]+")


# -- keys -----------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class CacheKey:
    """What was asked of whom, reduced to a filename.

    `source` and `frame` go into the digest as well as into the path,
    so two source names that sanitise to the same directory still
    cannot read each other's entries.
    """

    source: str
    frame: str
    params: Mapping[str, Any] = field(default_factory=dict)

    @property
    def canonical(self) -> str:
        return _canonical(
            {"source": self.source, "frame": self.frame, "params": dict(self.params)}
        )

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.canonical.encode("utf-8")).hexdigest()[:16]

    @property
    def stem(self) -> str:
        return f"{_slugify(self.frame)}-{self.digest}"

    # Identity is the canonical form, not the field tuple: a dict field
    # makes the generated __hash__ throw, and two params dicts written
    # in a different order are the same request.
    def __eq__(self, other: object) -> bool:
        return isinstance(other, CacheKey) and self.canonical == other.canonical

    def __hash__(self) -> int:
        return hash(self.canonical)

    def __repr__(self) -> str:
        return f"CacheKey({self.source}/{self.frame}#{self.digest})"


def _canonical(payload: Any) -> str:
    # allow_nan=False on purpose. Python's json will happily emit a bare
    # NaN, which is not JSON, and the sidecar has to stay readable by
    # anything that opens the directory five years from now.
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_jsonable,
        allow_nan=False,
    )


def _jsonable(obj: Any) -> Any:
    """Widen "JSON-able" to the handful of types params actually carry.

    Dates are the whole reason this exists — every range pull is keyed
    on two of them. A `date` and its own ISO string collapse to the same
    digest, which is correct: they name the same pull. Anything not
    handled here raises rather than falling back to `str`, because a
    silent `str()` of an object whose repr includes its memory address
    produces a key that is never hit twice.
    """
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, (set, frozenset)):
        return sorted(obj, key=repr)
    if isinstance(obj, Path):
        return str(obj)
    item = getattr(obj, "item", None)  # numpy scalars
    if callable(item):
        return item()
    raise TypeError(
        f"cache key holds {type(obj).__name__}, which has no stable JSON "
        f"form; convert it at the call site so the key means the same "
        f"thing next release"
    )


def _slugify(name: str) -> str:
    cleaned = _UNSAFE_IN_NAME.sub("_", name.strip()).strip("._")
    return (cleaned or "unnamed")[:64]


# -- time -----------------------------------------------------------------


def _to_naive_utc(value: datetime | date | str) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    raise TypeError(f"expected a date, datetime or ISO string, got {value!r}")


def _as_date(value: Any) -> date | None:
    try:
        return _to_naive_utc(value).date()
    except (TypeError, ValueError):
        return None


# -- statistics -----------------------------------------------------------


@dataclass(frozen=True)
class CacheStats:
    entries: int
    bytes: int
    #: Entry count per on-disk directory, which is the sanitised source
    #: name rather than the source's own spelling of itself.
    by_source: dict[str, int]


# -- the cache ------------------------------------------------------------


class ParquetCache:
    """Frames on disk, keyed by who was asked and what they were asked.

    Layout is one directory per source, two files per entry:

        <root>/<source>/<frame>-<digest>.parquet
        <root>/<source>/<frame>-<digest>.json

    The sidecar is the commit record. Both halves are written to a
    temp name and renamed into place, sidecar last, so a process killed
    mid-write leaves a miss rather than a truncated frame that reads as
    a short one.
    """

    def __init__(
        self,
        root: Path | str = DEFAULT_ROOT,
        *,
        ttl_days: Mapping[str, float | None] | None = None,
        compression: str = "zstd",
    ) -> None:
        # No mkdir here. Constructing a cache to ask it for stats should
        # not create a directory tree as a side effect.
        self.root = Path(root)
        self._ttl: dict[str, float | None] = dict(DEFAULT_TTL_DAYS)
        if ttl_days:
            self._ttl.update(ttl_days)
        self._compression = compression

    @staticmethod
    def key(source: str, frame: str, /, **params: Any) -> CacheKey:
        return CacheKey(source=source, frame=frame, params=params)

    # -- reads ------------------------------------------------------------

    def get(
        self, key: CacheKey, *, now: datetime | date | str | None = None
    ) -> pd.DataFrame | None:
        """The cached frame, or None for a miss, a stale entry or a bad file.

        Passing no `now` is not an oversight, it is the reviewer's path:
        they have the saved pull and no key to refresh it with, and an
        entry expiring underneath them would leave them unable to
        reproduce the report from exactly the bytes it was written from.
        Freshness is only an opinion when a clock is supplied.
        """
        meta = self.metadata(key)
        if meta is None:
            return None
        if now is not None and self._is_stale(key, meta, now):
            return None

        frame_path, _ = self._paths(key)
        try:
            return pd.read_parquet(frame_path)
        except Exception:
            # Truncated file, half-flushed footer, a parquet written by
            # a pyarrow that no longer exists here. The exception type
            # varies with how the file broke and the answer never does:
            # treat it as a miss and let the caller refetch. We do not
            # delete it — the bytes may be the only copy of a pull that
            # cost credentials, and a later reader may parse what this
            # one could not.
            return None

    def metadata(self, key: CacheKey) -> dict[str, Any] | None:
        """The sidecar, or None if this entry is absent or incomplete."""
        frame_path, side_path = self._paths(key)
        if not (frame_path.is_file() and side_path.is_file()):
            return None
        try:
            meta = json.loads(side_path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return meta if isinstance(meta, dict) else None

    # -- writes -----------------------------------------------------------

    def put(
        self,
        key: CacheKey,
        df: pd.DataFrame,
        *,
        stamped: datetime | date | str,
    ) -> Path:
        """Store a successful pull. There is no way to store anything else.

        `stamped` is the caller's clock, not ours. A cache that reads
        wall-clock time internally cannot be tested for expiry without
        either sleeping or monkeypatching, and both of those are how
        determinism leaks out of a repository like this one.
        """
        if not isinstance(df, pd.DataFrame):
            raise TypeError(
                f"only a successful pull is cacheable; got {type(df).__name__}. "
                f"An outage must propagate — caching it under a success's TTL "
                f"is how one throttled minute becomes a week of missing rows."
            )
        stamp = _to_naive_utc(stamped).isoformat()

        frame_path, side_path = self._paths(key)
        frame_path.parent.mkdir(parents=True, exist_ok=True)

        # index=False because these frames are column-shaped; a stray
        # index comes back as __index_level_0__ and fails the schema
        # validation the loader runs on the way out.
        self._atomic(frame_path, lambda p: df.to_parquet(
            p, index=False, compression=self._compression
        ))

        meta = {
            "source": key.source,
            "frame": key.frame,
            "digest": key.digest,
            "params": json.loads(_canonical(dict(key.params))),
            "rows": int(len(df)),
            "columns": [str(c) for c in df.columns],
            "stamped": stamp,
        }
        self._atomic(
            side_path,
            lambda p: p.write_text(
                json.dumps(meta, indent=2, sort_keys=True) + "\n", "utf-8"
            ),
        )
        return frame_path

    def get_or_load(
        self,
        key: CacheKey,
        loader: Callable[[], pd.DataFrame],
        *,
        stamped: datetime | date | str,
        now: datetime | date | str | None = None,
        refresh: bool = False,
    ) -> pd.DataFrame:
        """Read through to `loader` on a miss, storing only what succeeds.

        The rule is enforced by doing nothing: if `loader` raises —
        `SourceUnavailable`, a timeout, a 429 — the exception leaves
        this frame untouched and the entry stays absent, which is the
        state the next attempt needs to see.
        """
        if not refresh:
            hit = self.get(key, now=now)
            if hit is not None:
                return hit
        df = loader()
        self.put(key, df, stamped=stamped)
        return df

    # -- housekeeping -----------------------------------------------------

    def clear(self, source_name: str | None = None) -> int:
        """Delete one source's entries, or everything. Returns entries removed.

        Deliberately not `rmtree`: `root` is caller-supplied, and one
        mistyped path is all it takes to remove a directory that was
        never ours. Only files carrying our own suffixes go, and only
        one level down.
        """
        if not self.root.is_dir():
            return 0
        if source_name is not None:
            dirs = [self.root / _slugify(source_name)]
        else:
            dirs = sorted(p for p in self.root.iterdir() if p.is_dir())

        removed = 0
        for d in dirs:
            if not d.is_dir():
                continue
            for p in sorted(d.iterdir()):
                if p.is_file() and p.suffix in _OUR_SUFFIXES:
                    if p.suffix == ".parquet":
                        removed += 1
                    p.unlink(missing_ok=True)
            try:
                d.rmdir()
            except OSError:
                pass  # someone else's file is in there; leave the directory
        return removed

    def stats(self) -> CacheStats:
        entries = 0
        total = 0
        by_source: dict[str, int] = {}
        if not self.root.is_dir():
            return CacheStats(entries=0, bytes=0, by_source={})

        for d in sorted(p for p in self.root.iterdir() if p.is_dir()):
            here = 0
            for p in d.iterdir():
                if not (p.is_file() and p.suffix in _OUR_SUFFIXES):
                    continue
                total += p.stat().st_size
                # Count the sidecar, not the frame: the sidecar is what
                # makes an entry complete, so an interrupted write is
                # reported as bytes on disk and not as an entry.
                if p.suffix == ".json":
                    here += 1
            if here:
                by_source[d.name] = here
            entries += here
        return CacheStats(entries=entries, bytes=total, by_source=by_source)

    # -- internals --------------------------------------------------------

    def _paths(self, key: CacheKey) -> tuple[Path, Path]:
        d = self.root / _slugify(key.source)
        return d / f"{key.stem}.parquet", d / f"{key.stem}.json"

    def _max_age_days(
        self, key: CacheKey, now: datetime | date | str
    ) -> float | None:
        ttl = self._ttl.get(key.frame, UNKNOWN_FRAME_TTL_DAYS)
        if ttl is None and key.frame in _CLOSED_RANGE_FRAMES:
            end = _as_date(key.params.get("end"))
            if end is None or end >= _to_naive_utc(now).date():
                # Still accruing. An unbounded pull is treated the same
                # way, because a range with no stated end is a range
                # that ends today.
                return OPEN_RANGE_TTL_DAYS
            # A closed historical range does not age out. That is not
            # quite the claim that history cannot change — next month's
            # split rewrites every close_adj behind it, and a
            # restatement rewrites the fundamentals — it is the
            # judgement that reproducing the pull an audit actually ran
            # on is worth more than silently tracking the
            # re-adjustment. When you do want the re-adjustment,
            # clear() is the honest way to ask for it: it makes the
            # refetch a decision instead of a timer nobody saw fire.
            return None
        return ttl

    def _is_stale(
        self, key: CacheKey, meta: Mapping[str, Any], now: datetime | date | str
    ) -> bool:
        max_age = self._max_age_days(key, now)
        if max_age is None:
            return False
        try:
            stamped = _to_naive_utc(str(meta.get("stamped")))
        except (TypeError, ValueError):
            return True  # an entry we cannot date has not been shown to be fresh
        age_days = (_to_naive_utc(now) - stamped).total_seconds() / 86_400.0
        return age_days > max_age

    @staticmethod
    def _atomic(path: Path, write: Callable[[Path], Any]) -> None:
        tmp = path.with_name(path.name + ".tmp")
        try:
            write(tmp)
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
