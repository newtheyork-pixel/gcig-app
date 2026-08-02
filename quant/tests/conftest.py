"""Session-wide setup, and one library default that has to be fixed
before anything else runs.

`exchange_calendars` builds XNYS over a rolling twenty-year window
ending near today unless it is told otherwise, and both
`AuditContext.sessions` and `quality`'s calendar check ask for the
calendar with no bounds at all. A suite pinned to a fixed historical
range would therefore start passing or failing according to the date on
the machine — and it would fail in the most misleading way available,
by reporting the early years of a perfectly good fixture as fabricated
sessions. Widening the default here, before any test has caused a
calendar to be built, is what makes the range in
`test_audit_detects_bias` mean the same thing in 2026 and in 2036.

The patch is a module global and it is deliberately at import time:
`get_calendar` caches the instance it fabricates, so anything that
builds XNYS first wins for the rest of the process.
"""

from __future__ import annotations

import pandas as pd
from exchange_calendars import exchange_calendar as _ec

_WANT_START = pd.Timestamp("2003-01-01")
_WANT_END = pd.Timestamp("2027-01-01")

if _WANT_START < _ec.GLOBAL_DEFAULT_START:
    _ec.GLOBAL_DEFAULT_START = _WANT_START
if _WANT_END > _ec.GLOBAL_DEFAULT_END:
    _ec.GLOBAL_DEFAULT_END = _WANT_END
