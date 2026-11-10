"""Challenger models ride the purged OOF folds without joining the release roster.

Their fold OOF stays in GCS only: no manifest model_set entry, no D1 fold rows,
no fold readiness vote and no full-fit. R33 schedules app.challenger_models.LIFECYCLE_SLOTS.
"""
from __future__ import annotations


def normalize_challengers(raw, active_models) -> list[str]:
    names: list[str] = []
    for value in raw or []:
        name = str(value or "").strip()
        if name in active_models:
            raise ValueError(f"oof_challenger_overlaps_release_roster:{name}")
        if name and name not in names:
            names.append(name)
    return names


def challenger_metric(partial) -> dict:
    """Summarize one challenger fold result; failures never block the release fold."""
    if isinstance(partial, BaseException):
        return {"status": "failed", "reason": str(partial)}
    partial = partial if isinstance(partial, dict) else {}
    artifact = partial.get("oof_artifact") if isinstance(partial.get("oof_artifact"), dict) else {}
    if partial.get("error") or not artifact.get("path"):
        return {"status": "failed", "reason": partial.get("error") or "oof_artifact_missing"}
    return {"status": "ready", "oos_ic": partial.get("oos_ic"),
            "oof_artifact": artifact.get("path"), "artifact_checksum": artifact.get("payload_checksum"),
            # A lifecycle slot resolves its model per fold; E2 accumulates OOF by this name.
            **({"model": partial["model"]} if partial.get("model") else {})}
