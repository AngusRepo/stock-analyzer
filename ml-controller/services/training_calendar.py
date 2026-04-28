"""Point-in-time calendar helpers for training data availability."""

from __future__ import annotations

import os
from datetime import date


def _availability_day(default: int = 12) -> int:
    raw = os.environ.get("MONTHLY_REVENUE_AVAILABILITY_DAY", "").strip()
    if not raw:
        return default
    try:
        return min(max(int(raw), 1), 28)
    except ValueError:
        return default


def monthly_revenue_available_date(period_or_date: str, availability_day: int | None = None) -> str:
    """Map monthly revenue period to the first conservative usable date.

    D1 monthly_revenue.date is historically stored as the revenue period
    ("YYYY-MM"). That data is not point-in-time safe on the period itself, so
    training uses next month day N. If a full "YYYY-MM-DD" publication date is
    available in the future, it is preserved as-is.
    """

    value = str(period_or_date or "").strip()
    if len(value) == 10:
        date.fromisoformat(value)
        return value
    if len(value) != 7:
        raise ValueError(f"monthly revenue date must be YYYY-MM or YYYY-MM-DD, got {period_or_date!r}")

    year = int(value[:4])
    month = int(value[5:7])
    if month < 1 or month > 12:
        raise ValueError(f"monthly revenue month out of range: {period_or_date!r}")

    next_year = year + 1 if month == 12 else year
    next_month = 1 if month == 12 else month + 1
    day = availability_day if availability_day is not None else _availability_day()
    day = min(max(int(day), 1), 28)
    return date(next_year, next_month, day).isoformat()
