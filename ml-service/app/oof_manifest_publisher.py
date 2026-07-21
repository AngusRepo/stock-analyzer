"""Immutable publication for Active-8 OOF cohort manifests."""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any


def _checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _finalize(manifest: dict[str, Any]) -> dict[str, Any]:
    finalized = copy.deepcopy(manifest)
    finalized["manifest_checksum"] = _checksum(finalized)
    return finalized


def _verified_existing(existing: dict[str, Any]) -> dict[str, Any]:
    checksum = str(existing.get("manifest_checksum") or "")
    if len(checksum) != 64 or checksum != _checksum(existing):
        raise ValueError("active8_oof_existing_manifest_checksum_invalid")
    if existing.get("status") != "ready":
        raise ValueError("active8_oof_existing_manifest_not_ready")
    return existing


def prepare_oof_manifest_publication(
    manifest: dict[str, Any],
    *,
    existing_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return an immutable base or evidence-revision publication plan.

    A ready cohort ID is immutable. A pure evidence rebuild may reuse the
    verified fold artifacts under a content-addressed revision ID. Any run
    containing newly trained folds must use a new cohort ID at orchestration
    time instead of being renamed after training.
    """

    candidate = _finalize(manifest)
    base_cohort_id = str(candidate.get("cohort_id") or "").strip()
    if not base_cohort_id:
        raise ValueError("active8_oof_manifest_cohort_id_missing")
    base_path = f"walk_forward/oof_cohorts/{base_cohort_id}/manifest.json"
    if existing_manifest is None:
        return {
            "manifest": candidate,
            "path": base_path,
            "write_required": True,
            "publication_mode": "new_cohort",
        }

    existing = _verified_existing(copy.deepcopy(existing_manifest))
    if str(existing.get("cohort_id") or "") != base_cohort_id:
        raise ValueError("active8_oof_existing_manifest_cohort_mismatch")
    if existing["manifest_checksum"] == candidate["manifest_checksum"]:
        return {
            "manifest": existing,
            "path": base_path,
            "write_required": False,
            "publication_mode": "idempotent_existing",
        }

    aggregate = candidate.get("aggregate") if isinstance(candidate.get("aggregate"), dict) else {}
    windows = candidate.get("windows") if isinstance(candidate.get("windows"), list) else []
    if (
        int(aggregate.get("new_folds") or 0) != 0
        or not windows
        or any(not bool(window.get("reused_from_parent")) for window in windows)
    ):
        raise ValueError("active8_oof_ready_cohort_collision_requires_new_training_cohort_id")

    candidate_checksum = str(candidate["manifest_checksum"])
    revision_id = f"{base_cohort_id}-e{candidate_checksum[:12]}"
    revised = copy.deepcopy(candidate)
    revised["cohort_id"] = revision_id
    revised_aggregate = dict(aggregate)
    revised_aggregate["cohort_id"] = revision_id
    revised["aggregate"] = revised_aggregate
    revised["parent_manifest"] = {
        "path": base_path,
        "cohort_id": base_cohort_id,
        "checksum": existing["manifest_checksum"],
        "verified_fold_ids": sorted(int(window["window_id"]) for window in windows),
        "verification": "immutable_ready_manifest_sha256_v1",
    }
    revised["evidence_revision"] = {
        "schema_version": "active8-oof-evidence-revision-v1",
        "base_cohort_id": base_cohort_id,
        "base_manifest_path": base_path,
        "base_manifest_checksum": existing["manifest_checksum"],
        "candidate_checksum_before_revision_identity": candidate_checksum,
        "reason": "aggregate_or_release_evidence_changed_with_all_fold_artifacts_reused",
    }
    for window in revised["windows"]:
        window.setdefault("source_cohort_id", base_cohort_id)
        window.setdefault("source_fold_id", f"w{int(window['window_id'])}")
        window["reused_from_parent"] = True
    revised = _finalize(revised)
    return {
        "manifest": revised,
        "path": f"walk_forward/oof_cohorts/{revision_id}/manifest.json",
        "write_required": True,
        "publication_mode": "immutable_evidence_revision",
    }


def publish_oof_manifest(bucket: Any, manifest: dict[str, Any]) -> dict[str, Any]:
    """Publish without overwriting an existing ready cohort manifest."""

    cohort_id = str(manifest.get("cohort_id") or "").strip()
    if not cohort_id:
        raise ValueError("active8_oof_manifest_cohort_id_missing")
    base_path = f"walk_forward/oof_cohorts/{cohort_id}/manifest.json"
    base_blob = bucket.blob(base_path)
    existing = json.loads(base_blob.download_as_text()) if base_blob.exists() else None
    plan = prepare_oof_manifest_publication(manifest, existing_manifest=existing)
    if plan["write_required"]:
        payload = json.dumps(plan["manifest"], indent=2, default=str)
        target_blob = bucket.blob(plan["path"])
        if target_blob.exists():
            current = _verified_existing(json.loads(target_blob.download_as_text()))
            if current.get("manifest_checksum") != plan["manifest"].get("manifest_checksum"):
                raise ValueError("active8_oof_evidence_revision_id_collision")
            plan["write_required"] = False
            plan["publication_mode"] = "idempotent_existing_revision"
        else:
            target_blob.upload_from_string(
                payload,
                content_type="application/json",
                if_generation_match=0,
            )
    return plan
