"""Training-time promotion intent policy.

Artifact training may run without changing production. Moving a freshly trained
artifact into model_pool active status requires an explicit boolean intent and
an explicit reason from the caller.
"""

from __future__ import annotations

from typing import Any


def resolve_training_promotion_intent(payload: dict[str, Any], *, model_name: str) -> tuple[bool, str | None]:
    if "promote_to_active" not in payload:
        return False, None
    value = payload.get("promote_to_active")
    if not isinstance(value, bool):
        raise ValueError(f"{model_name} promote_to_active must be an explicit boolean")
    if not value:
        return False, None
    reason = str(payload.get("promotion_reason") or "").strip()
    if not reason:
        raise ValueError(f"{model_name} promotion requires explicit promotion_reason")
    return True, reason
