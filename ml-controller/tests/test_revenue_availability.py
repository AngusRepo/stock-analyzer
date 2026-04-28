from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.training_calendar import monthly_revenue_available_date  # noqa: E402


def test_monthly_revenue_period_is_available_next_month_by_default():
    assert monthly_revenue_available_date("2026-02") == "2026-03-12"


def test_monthly_revenue_period_rolls_year_boundary():
    assert monthly_revenue_available_date("2025-12") == "2026-01-12"


def test_monthly_revenue_full_date_is_preserved_as_publication_date():
    assert monthly_revenue_available_date("2026-03-08") == "2026-03-08"
