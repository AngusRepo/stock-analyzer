from __future__ import annotations

import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_release_training_contract import (  # noqa: E402
    ACTIVE8_MODEL_NAMES,
    normalize_release_execution_scope,
)


def test_release_execution_scope_is_exact_eight():
    groups, targets = normalize_release_execution_scope(["tree"], ["GNN"])
    assert groups and targets
    assert len(ACTIVE8_MODEL_NAMES) == 8


def _retired_calendar_monthly_defaults_to_canonical_monthly_release():
    assert resolve_monthly_execution_mode(
        calendar_monthly=True,
        force_monthly=False,
        explicit_candidate_type=None,
    ) == (True, "monthly_release")


def _retired_explicit_weekly_candidate_is_not_silently_relabelled_monthly_early_in_month():
    assert resolve_monthly_execution_mode(
        calendar_monthly=True,
        force_monthly=False,
        explicit_candidate_type="weekly_drift",
    ) == (False, "weekly_drift")


def _retired_forced_monthly_rejects_conflicting_candidate_type():
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


def _retired_explicit_or_forced_monthly_is_canonical_outside_calendar_window():
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
