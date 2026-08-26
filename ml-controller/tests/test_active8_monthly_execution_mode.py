from __future__ import annotations

import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_monthly_training_contract import resolve_monthly_execution_mode  # noqa: E402


def test_calendar_monthly_defaults_to_canonical_monthly_release():
    assert resolve_monthly_execution_mode(
        calendar_monthly=True,
        force_monthly=False,
        explicit_candidate_type=None,
    ) == (True, "monthly_release")


def test_explicit_weekly_candidate_is_not_silently_relabelled_monthly_early_in_month():
    assert resolve_monthly_execution_mode(
        calendar_monthly=True,
        force_monthly=False,
        explicit_candidate_type="weekly_drift",
    ) == (False, "weekly_drift")


def test_forced_monthly_rejects_conflicting_candidate_type():
    with pytest.raises(ValueError, match="forced_monthly_candidate_type_conflict"):
        resolve_monthly_execution_mode(
            calendar_monthly=True,
            force_monthly=True,
            explicit_candidate_type="manual_hotfix",
        )

    assert resolve_monthly_execution_mode(
        calendar_monthly=True,
        force_monthly=True,
        explicit_candidate_type="monthly_release",
    ) == (True, "monthly_release")


def test_explicit_or_forced_monthly_is_canonical_outside_calendar_window():
    assert resolve_monthly_execution_mode(
        calendar_monthly=False,
        force_monthly=False,
        explicit_candidate_type="monthly_release",
    ) == (True, "monthly_release")
    assert resolve_monthly_execution_mode(
        calendar_monthly=False,
        force_monthly=True,
        explicit_candidate_type=None,
    ) == (True, "monthly_release")
