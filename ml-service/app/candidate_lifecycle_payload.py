"""Candidate artifact payload helpers for retrain orchestration."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

CANDIDATE_REGISTRATIONS_KEY = "candidate_registrations"
REGISTER_CANDIDATES_KEY = "register_candidates"

LEGACY_CANDIDATE_REGISTRATIONS_KEY = "challenger_registrations"
LEGACY_REGISTER_CANDIDATES_KEY = "register_challengers"


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return {}


def candidate_registration_requested(value: Any, *, default: bool = False) -> bool:
    if not isinstance(value, Mapping) and (
        hasattr(value, REGISTER_CANDIDATES_KEY) or hasattr(value, "legacy_register_candidates")
    ):
        return bool(
            getattr(value, REGISTER_CANDIDATES_KEY, False)
            or getattr(value, "legacy_register_candidates", False)
        )
    data = _as_mapping(value)
    if REGISTER_CANDIDATES_KEY in data:
        return bool(data.get(REGISTER_CANDIDATES_KEY))
    if "legacy_register_candidates" in data:
        return bool(data.get("legacy_register_candidates"))
    return bool(data.get(LEGACY_REGISTER_CANDIDATES_KEY, default))


def candidate_registrations_from_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) and hasattr(value, CANDIDATE_REGISTRATIONS_KEY):
        registrations = getattr(value, CANDIDATE_REGISTRATIONS_KEY, None)
        if isinstance(registrations, dict) and registrations:
            return registrations
    data = _as_mapping(value)
    registrations = data.get(CANDIDATE_REGISTRATIONS_KEY)
    if isinstance(registrations, dict) and registrations:
        return registrations
    legacy = data.get(LEGACY_CANDIDATE_REGISTRATIONS_KEY)
    if isinstance(legacy, dict):
        return legacy
    return {}
