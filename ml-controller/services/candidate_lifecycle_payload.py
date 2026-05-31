"""Candidate artifact payload helpers shared by followup and registry code."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

CANDIDATE_REGISTRATIONS_KEY = "candidate_registrations"
LEGACY_CANDIDATE_REGISTRATIONS_KEY = "challenger_registrations"


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return {}


def candidate_registrations_from_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) and (
        hasattr(value, CANDIDATE_REGISTRATIONS_KEY) or hasattr(value, "legacy_candidate_registrations")
    ):
        registrations = getattr(value, CANDIDATE_REGISTRATIONS_KEY, None)
        if isinstance(registrations, dict) and registrations:
            return registrations
        legacy = getattr(value, "legacy_candidate_registrations", None)
        if isinstance(legacy, dict):
            return legacy
    data = _as_mapping(value)
    registrations = data.get(CANDIDATE_REGISTRATIONS_KEY)
    if isinstance(registrations, dict) and registrations:
        return registrations
    legacy_by_field = data.get("legacy_candidate_registrations")
    if isinstance(legacy_by_field, dict) and legacy_by_field:
        return legacy_by_field
    legacy = data.get(LEGACY_CANDIDATE_REGISTRATIONS_KEY)
    if isinstance(legacy, dict):
        return legacy
    return {}
