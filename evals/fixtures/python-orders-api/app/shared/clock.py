"""Time source, kept in one place so tests can replace it."""

from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc)
