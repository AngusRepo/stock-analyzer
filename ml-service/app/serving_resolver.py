from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .sequence_training import SEQUENCE_RETURN_SEMANTIC_VERSION

LABEL_SCHEMA_VERSION = SEQUENCE_RETURN_SEMANTIC_VERSION

DIRECT_ALPHA_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
SEQUENCE_ALPHA_MODELS = ("DLinear", "PatchTST", "iTransformer")
FORMAL_FEATURE_MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN")
FORMAL_FEATURE_SEMANTIC_VERSION = "formal137-pit-rolling-rank-and-imputation-v2"
FORMAL_GNN_GRAPH_SEMANTIC_VERSION = "gnn-feature-sector-graph-v1"
FORMAL_RANK_IC_SEMANTIC_VERSION = "same-date-average-rank-tie-neutral-spearman-v2"
SEQUENCE_CONTRACT_FIELDS = ("seq_len", "pred_len", "sequence_contract")
SEQUENCE_CONTRACT_SCHEMA_VERSION = "model-serving-sequence-contract-v1"
L2_SIDECARS = ("TimesFM",)
PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA = "pipeline-modal-serving-manifest-v4"
ACTIVE8_ACTION_AUTHORITY_SCHEMA = "active8-action-authority-v1"
ACTIVE8_ACTION_MODE_PRODUCTION = "production_ensemble"
ACTIVE8_ACTION_MODE_EVIDENCE_ONLY = "evidence_only_no_action"
SERVING_OK_STATES = {"production"}
SERVING_OK_OFFLINE_DECISIONS = {"STRONG_PASS", "PASS"}
SERVING_BAD_LIVE_STATUSES = {"failed", "rolling_ic_failed", "live_gate_failed"}
SERVING_IC_PRIOR_SCHEMA_VERSION = "version-bound-purged-oof-ic-prior-v1"
SERVING_IC_PRIOR_METHODS = {
    "outer_purged_walk_forward_rank_ic",
    "purged_walk_forward_retrain_rank_ic",
}
IC_STATE_FIELDS = (
    "rolling_ic",
    "ic_4w_avg",
    "weekly_ic",
    "consecutive_negative_weeks",
    "last_ic_status",
    "last_ic_root_cause",
    "last_ic_sample_count",
    "last_ic_score_sources",
    "last_ic_by_segment",
    "last_ic_error",
    "last_ic_diagnostics",
    "last_ic_evaluation_contract",
    "last_ic_semantic_version",
    "last_ic_target_semantic_version",
    "last_ic_artifact_version",
)
FROZEN_SHADOW_FIELDS = (
    "status", "version", "gcs_path", "metadata_path", "serving_artifact_id",
    "checksum", "model_type", "balance_family", "shadow_since", "weekly_ic",
    "ic_4w_avg", "consecutive_negative_weeks", "vote_weight", "model",
)
FROZEN_ACTIVE8_SHADOW_FIELDS = (
    "model", "status", "effective_status", "version", "artifact_id",
    "artifact_path", "metadata_path", "checksum", "candidate_type",
    "registry_state", "offline_gate_decision", "live_gate_status",
    "source_run_date", "training_run_id", "selection_slot",
    "production_effect", "vote_weight", "schema",
)
FROZEN_FORMAL_SLOT_FIELDS = (
    "model", "status", "version", "gcs_path", "metadata_path",
    "artifact_schema", "canonical_source", "direct_prediction", "vote_weight",
    "note",
)
FROZEN_MANIFEST_SERVING_STATUSES = {"active", "degraded"}
FROZEN_MANIFEST_EFFECTIVE_STATUSES = {
    "active", "degraded", "challenger",
}
FROZEN_COMPACT_MAX_BYTES = 65_536
FROZEN_MANIFEST_MAX_BYTES = 1_048_576
ARTIFACT_EXTENSIONS = {
    "LightGBM": "joblib",
    "XGBoost": "joblib",
    "ExtraTrees": "joblib",
    "TabM": "pt",
    "GNN": "pt",
    "DLinear": "pt",
    "PatchTST": "zip",
    "iTransformer": "zip",
    "TimesFM": "json",
}


class ServingPoolResolutionError(RuntimeError):
    """D1 champion snapshot could not be resolved safely."""


_RESOLVED_POOL_CACHE: dict[str, Any] | None = None
_RESOLVED_POOL_CACHE_LOADED_AT = 0.0
_RESOLVED_POOL_CACHE_LOCK = threading.Lock()


def _d1_env_configured() -> bool:
    return all(str(os.environ.get(key) or "").strip() for key in ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_LEARNING_DB_ID"))


def clear_serving_pool_cache() -> None:
    """Clear the single-entry D1 champion snapshot cache used by Modal serving."""
    global _RESOLVED_POOL_CACHE, _RESOLVED_POOL_CACHE_LOADED_AT
    with _RESOLVED_POOL_CACHE_LOCK:
        _RESOLVED_POOL_CACHE = None
        _RESOLVED_POOL_CACHE_LOADED_AT = 0.0

def _bounded_env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _bounded_env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def serving_manifest_digest(manifest: dict[str, Any]) -> str:
    payload = json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    payload_bytes = payload.encode("utf-8")
    if len(payload_bytes) > FROZEN_MANIFEST_MAX_BYTES:
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_total_bytes:{len(payload_bytes)}"
        )
    return hashlib.sha256(payload_bytes).hexdigest()


def serving_manifest_identities(
    manifest: dict[str, Any],
    *,
    serving_only: bool = False,
) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("model") or ""): {
            key: row.get(key)
            for key in (
                "version",
                "artifact_id",
                "artifact_path",
                "metadata_path",
                "checksum",
            )
        }
        for row in (manifest.get("models") or [])
        if isinstance(row, dict) and str(row.get("model") or "").strip()
        and (
            not serving_only
            or str(row.get("effective_status") or "")
            in FROZEN_MANIFEST_SERVING_STATUSES
        )
    }


def active8_shadow_candidate_identities(
    manifest: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("model") or ""): {
            key: row.get(key)
            for key in (
                "version",
                "artifact_id",
                "artifact_path",
                "metadata_path",
                "checksum",
            )
        }
        for row in (manifest.get("active8_shadow_candidates") or [])
        if isinstance(row, dict) and str(row.get("model") or "").strip()
    }


def serving_manifest_coverage(manifest: dict[str, Any]) -> dict[str, Any]:
    rows = [row for row in (manifest.get("models") or []) if isinstance(row, dict)]
    excluded = [
        {
            "model": str(row.get("model") or ""),
            "effective_status": str(row.get("effective_status") or ""),
            "reason": str((row.get("health") or {}).get("serving_block_reason") or "")
            or "not_serving_eligible",
        }
        for row in rows
        if str(row.get("effective_status") or "")
        not in FROZEN_MANIFEST_SERVING_STATUSES
    ]
    return {
        "slot_count": len(rows),
        "serving_model_count": len(rows) - len(excluded),
        "excluded_models": excluded,
    }


def _require_compact_mapping(
    value: Any,
    *,
    label: str,
    allowed_fields: tuple[str, ...],
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(allowed_fields):
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_{label}_fields_invalid"
        )
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_{label}_value_invalid"
        ) from exc
    if len(encoded) > FROZEN_COMPACT_MAX_BYTES:
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_{label}_too_large"
        )
    return copy.deepcopy(value)


def _require_manifest_checksum(value: Any, *, model_name: str) -> str:
    checksum = str(value or "").strip().lower()
    digest = checksum.removeprefix("sha256:")
    if (
        not checksum.startswith("sha256:")
        or len(digest) != 64
        or any(char not in "0123456789abcdef" for char in digest)
    ):
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_checksum_invalid:{model_name}"
        )
    return checksum






def build_pool_from_frozen_manifest(
    manifest: dict[str, Any],
    *,
    expected_digest: str,
    l2_sidecar_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build Modal's pool only from the Controller-dispatched immutable manifest."""
    if not isinstance(manifest, dict):
        raise ServingPoolResolutionError("frozen_serving_manifest_not_object")
    if manifest.get("schema_version") != PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA:
        raise ServingPoolResolutionError("frozen_serving_manifest_schema_invalid")
    actual_digest = serving_manifest_digest(manifest)
    if not expected_digest or actual_digest != str(expected_digest).strip().lower():
        raise ServingPoolResolutionError("frozen_serving_manifest_digest_mismatch")
    if manifest.get("source_of_truth") != "model_champion_pointers+active8_action_authority_v1":
        raise ServingPoolResolutionError("frozen_serving_manifest_source_invalid")

    rows = manifest.get("models")
    if not isinstance(rows, list):
        raise ServingPoolResolutionError("frozen_serving_manifest_models_not_list")
    by_model: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ServingPoolResolutionError("frozen_serving_manifest_model_not_object")
        model_name = str(row.get("model") or "").strip()
        if model_name in by_model:
            duplicates.append(model_name)
        by_model[model_name] = row
    missing = sorted(set(DIRECT_ALPHA_MODELS) - set(by_model))
    unexpected = sorted(set(by_model) - set(DIRECT_ALPHA_MODELS))
    if missing or unexpected or duplicates:
        raise ServingPoolResolutionError(
            "frozen_serving_manifest_model_set_invalid:"
            f"missing={missing}:unexpected={unexpected}:duplicates={sorted(set(duplicates))}"
        )

    pool: dict[str, Any] = {
        "schema_version": "model_pool_v2",
        "source_of_truth": "frozen_pipeline_modal_serving_manifest",
        "serving_manifest_digest": actual_digest,
        "models": {},
        "l2_feature_sidecars": {},
        "shadow_models": {},
        "active8_shadow_candidates": {},
        "formal_layer3_slots": {},
        "active8_ensemble": None,
        "active8_action_authority": {},
        "serving_coverage": serving_manifest_coverage(manifest),
    }
    for model_name in DIRECT_ALPHA_MODELS:
        row = by_model[model_name]
        status = str(row.get("status") or "").strip()
        if status not in {"active", "degraded"}:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_status_invalid:{model_name}:{status or '<missing>'}"
            )
        effective_status = str(row.get("effective_status") or "").strip()
        if effective_status not in FROZEN_MANIFEST_EFFECTIVE_STATUSES:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_effective_status_invalid:{model_name}:"
                f"{effective_status or '<missing>'}"
            )
        identity = {
            "version": str(row.get("version") or "").strip(),
            "artifact_id": str(row.get("artifact_id") or "").strip(),
            "artifact_path": str(row.get("artifact_path") or "").strip(),
            "metadata_path": str(row.get("metadata_path") or "").strip(),
        }
        missing_identity = [key for key, value in identity.items() if not value]
        if missing_identity:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_identity_missing:{model_name}:"
                + ",".join(missing_identity)
            )
        health = row.get("health")
        schema = row.get("schema")
        if not isinstance(health, dict) or not isinstance(schema, dict):
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_contract_missing:{model_name}"
            )
        serving_block_reason = str(health.get("serving_block_reason") or "").strip()
        serving_eligible = health.get("serving_eligible") is not False and not serving_block_reason
        expected_effective_status = status if serving_eligible else "challenger"
        if effective_status != expected_effective_status:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_effective_status_mismatch:{model_name}:"
                f"expected={expected_effective_status}:actual={effective_status}"
            )
        if not serving_eligible and not serving_block_reason:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_exclusion_reason_missing:{model_name}"
            )
        if len(serving_block_reason) > 4096:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_exclusion_reason_too_large:{model_name}"
            )
        target_semantic_version = str(schema.get("target_semantic_version") or "").strip()
        if serving_eligible and target_semantic_version != LABEL_SCHEMA_VERSION:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_target_semantic_mismatch:"
                f"{model_name}:{target_semantic_version or '<missing>'}:"
                f"expected={LABEL_SCHEMA_VERSION}"
            )
        feature_semantic_version = str(schema.get("feature_semantic_version") or "").strip()
        if (
            serving_eligible
            and model_name in FORMAL_FEATURE_MODELS
            and feature_semantic_version != FORMAL_FEATURE_SEMANTIC_VERSION
        ):
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_feature_semantic_mismatch:"
                f"{model_name}:{feature_semantic_version or '<missing>'}:"
                f"expected={FORMAL_FEATURE_SEMANTIC_VERSION}"
            )
        graph_semantic_version = str(schema.get("gnn_graph_semantic_version") or "").strip()
        if (
            serving_eligible
            and model_name == "GNN"
            and graph_semantic_version != FORMAL_GNN_GRAPH_SEMANTIC_VERSION
        ):
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_gnn_graph_semantic_mismatch:"
                f"{graph_semantic_version or '<missing>'}:"
                f"expected={FORMAL_GNN_GRAPH_SEMANTIC_VERSION}"
            )

        checksum = _require_manifest_checksum(row.get("checksum"), model_name=model_name)
        entry = {
            "status": effective_status,
            "lifecycle_status": status,
            "effective_status": effective_status,
            "version": identity["version"],
            "gcs_path": identity["artifact_path"],
            "metadata_path": identity["metadata_path"],
            "checksum": checksum,
            "serving_artifact_id": identity["artifact_id"],
            "serving_owner": "frozen_pipeline_modal_serving_manifest",
            "serving_eligible": serving_eligible,
            "serving_block_reason": serving_block_reason or None,
            "offline_gate_decision": health.get("offline_gate_decision"),
            "live_gate_status": health.get("live_gate_status"),
            "target_semantic_version": schema.get("target_semantic_version"),
            "feature_semantic_version": schema.get("feature_semantic_version"),
            "gnn_graph_semantic_version": schema.get("gnn_graph_semantic_version"),
        }
        if isinstance(schema.get("sequence_contract"), dict):
            entry["sequence_contract"] = copy.deepcopy(schema["sequence_contract"])
            entry["seq_len"] = schema["sequence_contract"].get("seq_len")
            entry["pred_len"] = schema["sequence_contract"].get("pred_len")
        pool["models"][model_name] = entry

    shadow_rows = manifest.get("shadow_models")
    if not isinstance(shadow_rows, list):
        raise ServingPoolResolutionError(
            "frozen_serving_manifest_shadow_models_not_list"
        )
    shadow_names: set[str] = set()
    for row in shadow_rows:
        shadow = _require_compact_mapping(
            row,
            label="shadow_model",
            allowed_fields=FROZEN_SHADOW_FIELDS,
        )
        model_name = str(shadow.get("model") or "").strip()
        if model_name != "ResidualMLP" or model_name in shadow_names:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_shadow_model_set_invalid"
            )
        shadow_names.add(model_name)
        if str(shadow.get("status") or "").strip() != "challenger":
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_shadow_status_invalid"
            )
        try:
            vote_weight = float(shadow.get("vote_weight") or 0.0)
        except (TypeError, ValueError) as exc:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_shadow_vote_invalid"
            ) from exc
        if vote_weight != 0.0:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_shadow_vote_nonzero"
            )
        for field in (
            "version", "gcs_path", "metadata_path", "serving_artifact_id",
        ):
            if not str(shadow.get(field) or "").strip():
                raise ServingPoolResolutionError(
                    f"frozen_serving_manifest_shadow_identity_missing:{field}"
                )
        shadow["checksum"] = _require_manifest_checksum(
            shadow.get("checksum"),
            model_name=model_name,
        )
        shadow["serving_owner"] = "frozen_pipeline_modal_serving_manifest"
        shadow["serving_eligible"] = False
        shadow["vote_weight"] = 0.0
        pool["shadow_models"][model_name] = shadow

    active8_shadow_rows = manifest.get("active8_shadow_candidates")
    if not isinstance(active8_shadow_rows, list):
        raise ServingPoolResolutionError(
            "frozen_serving_manifest_active8_shadow_candidates_not_list"
        )
    active8_shadow_names: set[str] = set()
    for row in active8_shadow_rows:
        candidate = _require_compact_mapping(
            row,
            label="active8_shadow_candidate",
            allowed_fields=FROZEN_ACTIVE8_SHADOW_FIELDS,
        )
        model_name = str(candidate.get("model") or "").strip()
        if model_name not in DIRECT_ALPHA_MODELS or model_name in active8_shadow_names:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_active8_shadow_model_set_invalid"
            )
        active8_shadow_names.add(model_name)
        if (
            str(candidate.get("status") or "") != "challenger"
            or str(candidate.get("effective_status") or "") != "challenger"
            or candidate.get("production_effect") is not False
        ):
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_status_invalid:{model_name}"
            )
        try:
            vote_weight = float(candidate.get("vote_weight"))
        except (TypeError, ValueError) as exc:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_vote_invalid:{model_name}"
            ) from exc
        if not math.isfinite(vote_weight) or vote_weight != 0.0:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_vote_nonzero:{model_name}"
            )
        for field in (
            "version", "artifact_id", "artifact_path", "metadata_path",
            "candidate_type", "registry_state", "offline_gate_decision",
            "selection_slot",
        ):
            if not str(candidate.get(field) or "").strip():
                raise ServingPoolResolutionError(
                    f"frozen_serving_manifest_active8_shadow_identity_missing:"
                    f"{model_name}:{field}"
                )
        if str(candidate.get("candidate_type") or "") != "oof_full_fit_release":
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_candidate_type_invalid:{model_name}"
            )
        if str(candidate.get("offline_gate_decision") or "") not in {
            "PASS", "STRONG_PASS",
        }:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_offline_gate_invalid:{model_name}"
            )
        schema = candidate.get("schema")
        if not isinstance(schema, dict) or set(schema) != {
            "target_semantic_version",
            "feature_semantic_version",
            "gnn_graph_semantic_version",
            "sequence_contract",
        }:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_schema_invalid:{model_name}"
            )
        if str(schema.get("target_semantic_version") or "") != LABEL_SCHEMA_VERSION:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_target_semantic_invalid:{model_name}"
            )
        if (
            model_name in FORMAL_FEATURE_MODELS
            and str(schema.get("feature_semantic_version") or "")
            != FORMAL_FEATURE_SEMANTIC_VERSION
        ):
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_shadow_feature_semantic_invalid:{model_name}"
            )
        if (
            model_name == "GNN"
            and str(schema.get("gnn_graph_semantic_version") or "")
            != FORMAL_GNN_GRAPH_SEMANTIC_VERSION
        ):
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_active8_shadow_gnn_graph_semantic_invalid"
            )
        if model_name in SEQUENCE_ALPHA_MODELS:
            contract = schema.get("sequence_contract")
            if not isinstance(contract, dict):
                raise ServingPoolResolutionError(
                    f"frozen_serving_manifest_active8_shadow_sequence_contract_missing:{model_name}"
                )
            try:
                seq_len = int(contract.get("seq_len"))
                pred_len = int(contract.get("pred_len"))
            except (TypeError, ValueError) as exc:
                raise ServingPoolResolutionError(
                    f"frozen_serving_manifest_active8_shadow_sequence_contract_invalid:{model_name}"
                ) from exc
            if (
                contract.get("schema_version") != SEQUENCE_CONTRACT_SCHEMA_VERSION
                or str(contract.get("source") or "") != "model_artifact_registry"
                or str(contract.get("model") or "") != model_name
                or str(contract.get("version") or "") != str(candidate.get("version") or "")
                or str(contract.get("artifact_id") or "") != str(candidate.get("artifact_id") or "")
                or seq_len <= 0
                or pred_len <= 0
            ):
                raise ServingPoolResolutionError(
                    f"frozen_serving_manifest_active8_shadow_sequence_contract_invalid:{model_name}"
                )
        candidate["checksum"] = _require_manifest_checksum(
            candidate.get("checksum"),
            model_name=model_name,
        )
        pool["active8_shadow_candidates"][model_name] = {
            **copy.deepcopy(candidate),
            "gcs_path": candidate["artifact_path"],
            "serving_artifact_id": candidate["artifact_id"],
            "serving_owner": "frozen_pipeline_modal_serving_manifest",
            "serving_eligible": False,
            "vote_weight": 0.0,
            "production_effect": False,
        }

    suppressions = manifest.get("active8_shadow_suppressions")
    if not isinstance(suppressions, list):
        raise ServingPoolResolutionError(
            "frozen_serving_manifest_active8_shadow_suppressions_not_list"
        )

    formal_rows = manifest.get("formal_layer3_slots")
    if not isinstance(formal_rows, list):
        raise ServingPoolResolutionError(
            "frozen_serving_manifest_formal_slots_not_list"
        )
    formal_names: set[str] = set()
    for row in formal_rows:
        slot = _require_compact_mapping(
            row,
            label="formal_slot",
            allowed_fields=FROZEN_FORMAL_SLOT_FIELDS,
        )
        model_name = str(slot.get("model") or "").strip()
        if not model_name or model_name in formal_names:
            raise ServingPoolResolutionError(
                "frozen_serving_manifest_formal_slot_set_invalid"
            )
        formal_names.add(model_name)
        try:
            vote_weight = float(slot.get("vote_weight") or 0.0)
        except (TypeError, ValueError) as exc:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_formal_slot_vote_invalid:{model_name}"
            ) from exc
        if bool(slot.get("direct_prediction")) or vote_weight != 0.0:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_formal_slot_not_audit_only:{model_name}"
            )
        slot["vote_weight"] = vote_weight
        slot["direct_prediction"] = bool(slot.get("direct_prediction"))
        pool["formal_layer3_slots"][model_name] = slot

    from .active8_ensemble_runtime import validate_active8_ensemble_artifact

    authority = manifest.get("active8_action_authority")
    if not isinstance(authority, dict):
        raise ServingPoolResolutionError("frozen_serving_manifest_active8_action_authority_missing")
    if authority.get("schema_version") != ACTIVE8_ACTION_AUTHORITY_SCHEMA:
        raise ServingPoolResolutionError("frozen_serving_manifest_active8_action_authority_schema_invalid")
    mode = str(authority.get("mode") or "")
    active8_ensemble = manifest.get("active8_ensemble")
    if mode == ACTIVE8_ACTION_MODE_PRODUCTION:
        if authority.get("buy_authorized") is not True or authority.get("production_effect") is not True:
            raise ServingPoolResolutionError("frozen_serving_manifest_active8_action_authority_production_invalid")
        if not isinstance(active8_ensemble, dict):
            raise ServingPoolResolutionError("frozen_serving_manifest_active8_ensemble_missing")
        try:
            validate_active8_ensemble_artifact(
                active8_ensemble,
                pool_models=pool["models"],
            )
        except Exception as exc:
            raise ServingPoolResolutionError(
                f"frozen_serving_manifest_active8_ensemble_invalid:{exc}"
            ) from exc
        pool["active8_ensemble"] = dict(active8_ensemble)
    elif mode == ACTIVE8_ACTION_MODE_EVIDENCE_ONLY:
        if authority.get("buy_authorized") is not False or authority.get("production_effect") is not False:
            raise ServingPoolResolutionError("frozen_serving_manifest_active8_action_authority_evidence_only_invalid")
        if active8_ensemble is not None:
            raise ServingPoolResolutionError("frozen_serving_manifest_evidence_only_ensemble_must_be_absent")
        pool["active8_ensemble"] = None
    else:
        raise ServingPoolResolutionError(
            f"frozen_serving_manifest_active8_action_authority_mode_invalid:{mode or 'missing'}"
        )
    pool["active8_action_authority"] = dict(authority)

    sidecar = dict(l2_sidecar_context or {})
    pool["l2_feature_sidecars"]["TimesFM"] = {
        "status": "retired",
        "version": str(sidecar.get("version") or "controller-l2-precomputed"),
        "serving_eligible": False,
        "serving_block_reason": "controller_l2_precomputed_not_modal_runtime",
        "role": "l2_feature_sidecar",
        "direct_prediction": False,
    }
    return pool


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _artifact_metadata(artifact: dict[str, Any] | None) -> dict[str, Any]:
    source = artifact or {}
    direct = _json_obj(source.get("metadata"))
    if direct:
        return direct
    offline = _json_obj(source.get("offline_evidence_json"))
    registration = _json_obj(offline.get("registration"))
    return _json_obj(registration.get("metadata"))


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _sequence_artifact_contract(
    model_name: str,
    artifact: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if model_name not in SEQUENCE_ALPHA_MODELS or not artifact:
        return None
    metadata = _artifact_metadata(artifact)
    seq_len = _positive_int(metadata.get("seq_len"))
    pred_len = _positive_int(metadata.get("pred_len"))
    rank_ic_semantic = str(metadata.get("rank_ic_semantic_version") or "").strip()
    version = str(artifact.get("version") or metadata.get("version") or "").strip()
    artifact_id = str(artifact.get("artifact_id") or "").strip()
    if (
        seq_len is None
        or pred_len is None
        or rank_ic_semantic != FORMAL_RANK_IC_SEMANTIC_VERSION
        or not version
        or not artifact_id
    ):
        return None
    return {
        "schema_version": SEQUENCE_CONTRACT_SCHEMA_VERSION,
        "source": "model_artifact_registry",
        "model": model_name,
        "artifact_id": artifact_id,
        "version": version,
        "seq_len": seq_len,
        "pred_len": pred_len,
        "rank_ic_semantic_version": rank_ic_semantic,
    }


def _folder(model_name: str) -> str:
    return model_name.lower().replace("-", "_")


def _default_artifact_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/{version}.{ARTIFACT_EXTENSIONS.get(model_name, 'joblib')}"


def _default_metadata_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/metadata_{version}.json"


def _artifact_block_reason(artifact: dict[str, Any] | None, *, model_name: str, artifact_role: str) -> str | None:
    if not artifact:
        return "missing_registry_artifact"
    state = str(artifact.get("state") or "").strip()
    if state not in SERVING_OK_STATES:
        return f"artifact_state_{state or 'missing'}"
    offline_decision = str(artifact.get("offline_gate_decision") or "").strip().upper()
    if offline_decision and offline_decision not in SERVING_OK_OFFLINE_DECISIONS:
        return f"offline_gate_{offline_decision.lower()}"
    live_status = str(artifact.get("live_gate_status") or "").strip().lower()
    if live_status in SERVING_BAD_LIVE_STATUSES:
        return f"live_gate_{live_status}"
    artifact_path = str(artifact.get("artifact_path") or "").strip()
    if not artifact_path:
        return "missing_artifact_path"
    if not str(artifact.get("metadata_path") or "").strip():
        return "missing_metadata_path"
    try:
        _require_manifest_checksum(artifact.get("checksum"), model_name=model_name)
    except ServingPoolResolutionError:
        return "invalid_artifact_checksum"
    expected_ext = str(ARTIFACT_EXTENSIONS.get(model_name) or "").strip().lower()
    actual_ext = artifact_path.rsplit(".", 1)[-1].lower() if "." in artifact_path else ""
    if expected_ext and actual_ext != expected_ext:
        return f"artifact_extension_{actual_ext or 'missing'}_expected_{expected_ext}"
    if model_name in DIRECT_ALPHA_MODELS:
        if str(artifact.get("candidate_type") or "") != "oof_full_fit_release":
            return "artifact_candidate_type_not_canonical_oof_release"
        metadata = _artifact_metadata(artifact)
        target_semantic = str(metadata.get("target_semantic_version") or "").strip()
        if target_semantic != LABEL_SCHEMA_VERSION:
            return f"artifact_target_semantic_{target_semantic or 'missing'}_expected_{LABEL_SCHEMA_VERSION}"
        if model_name in FORMAL_FEATURE_MODELS:
            feature_semantic = str(metadata.get("feature_semantic_version") or "").strip()
            if feature_semantic != FORMAL_FEATURE_SEMANTIC_VERSION:
                return (
                    f"artifact_feature_semantic_{feature_semantic or 'missing'}_"
                    f"expected_{FORMAL_FEATURE_SEMANTIC_VERSION}"
                )
        if model_name == "GNN":
            graph = metadata.get("graph") if isinstance(metadata.get("graph"), dict) else {}
            graph_semantic = str(graph.get("semantic_version") or "").strip()
            if graph_semantic != FORMAL_GNN_GRAPH_SEMANTIC_VERSION:
                return (
                    f"artifact_gnn_graph_semantic_{graph_semantic or 'missing'}_"
                    f"expected_{FORMAL_GNN_GRAPH_SEMANTIC_VERSION}"
                )
    if artifact_role == "l2_feature_sidecar" and str(artifact.get("candidate_type") or "") != "timesfm_l175_l2_feature_release":
        return "artifact_candidate_type_not_timesfm_feature_release"
    if model_name in SEQUENCE_ALPHA_MODELS and _sequence_artifact_contract(model_name, artifact) is None:
        return "artifact_sequence_contract_missing_or_invalid"
    return None


def _artifact_identity_block_reason(
    artifact: dict[str, Any] | None,
    *,
    model_name: str,
    version: str,
    artifact_id: str | None,
) -> str | None:
    if not artifact:
        return None
    if str(artifact.get("model_name") or "").strip() != model_name:
        return "artifact_model_pointer_mismatch"
    if str(artifact.get("version") or "").strip() != version:
        return "artifact_version_pointer_mismatch"
    if (
        artifact_id
        and str(artifact.get("artifact_id") or "").strip() != artifact_id
    ):
        return "artifact_id_pointer_mismatch"
    return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        try:
            if value is not None:
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def build_serving_ic_prior(artifact: dict[str, Any] | None) -> dict[str, Any] | None:
    source = artifact or {}
    if str(source.get("candidate_type") or "").strip() != "oof_full_fit_release":
        return None
    if str(source.get("offline_gate_decision") or "").strip().upper() not in SERVING_OK_OFFLINE_DECISIONS:
        return None

    metadata = _artifact_metadata(source)
    target_semantic = str(metadata.get("target_semantic_version") or "").strip()
    if target_semantic != LABEL_SCHEMA_VERSION:
        return None

    offline = _json_obj(source.get("offline_evidence_json"))
    registration = _json_obj(offline.get("registration"))
    cpcv = _json_obj(metadata.get("model_cpcv") or registration.get("model_cpcv"))
    method = str(cpcv.get("method") or "").strip()
    decision = str(cpcv.get("decision") or "").strip().upper()
    if method not in SERVING_IC_PRIOR_METHODS or decision != "PASS" or cpcv.get("passed") is not True:
        return None

    value = _first_number(cpcv.get("oos_ic_mean"))
    if value is None or value <= 0:
        return None

    version = str(source.get("version") or "").strip()
    artifact_id = str(source.get("artifact_id") or "").strip()
    if not version or not artifact_id:
        return None

    return {
        "schema_version": SERVING_IC_PRIOR_SCHEMA_VERSION,
        "value": value,
        "source": "candidate_scoped_purged_oof_model_cpcv",
        "artifact_id": artifact_id,
        "artifact_version": version,
        "target_semantic_version": target_semantic,
        "method": method,
        "fold_count": int(cpcv.get("folds") or 0),
        "positive_fold_ratio": _first_number(cpcv.get("positive_fold_ratio")),
        "sample_count": int(metadata.get("sample_count") or registration.get("sample_count") or 0),
    }


def _live_ic_source_matches(
    source: dict[str, Any],
    *,
    artifact_version: str,
    target_semantic_version: str,
) -> bool:
    contract = _json_obj(source.get("last_ic_evaluation_contract"))
    source_version = str(
        source.get("last_ic_artifact_version")
        or contract.get("artifact_version")
        or ""
    ).strip()
    source_target = str(
        source.get("last_ic_target_semantic_version")
        or contract.get("target_semantic_version")
        or ""
    ).strip()
    return source_version == artifact_version and source_target == target_semantic_version


def _copy_ic_fields(entry: dict[str, Any], *, artifact: dict[str, Any] | None, pointer: dict[str, Any] | None) -> None:
    live = _json_obj((artifact or {}).get("live_evidence_json"))
    promotion = _json_obj((pointer or {}).get("promotion_evidence_json"))
    artifact_version = str(entry.get("version") or "").strip()
    target_semantic = str(entry.get("target_semantic_version") or "").strip()
    sources = [
        source
        for source in (promotion, live)
        if _live_ic_source_matches(
            source,
            artifact_version=artifact_version,
            target_semantic_version=target_semantic,
        )
    ]

    for key in IC_STATE_FIELDS:
        entry[key] = [] if key == "weekly_ic" else None

    rolling_ic = _first_number(*(source.get("rolling_ic") for source in sources), *(source.get("live_ic") for source in sources))
    ic_4w = _first_number(*(source.get("ic_4w_avg") for source in sources))
    if rolling_ic is not None:
        entry["rolling_ic"] = rolling_ic
    if ic_4w is not None:
        entry["ic_4w_avg"] = ic_4w
    for key in IC_STATE_FIELDS:
        if key in {"rolling_ic", "ic_4w_avg"}:
            continue
        for source in sources:
            value = source.get(key)
            if value is not None:
                entry[key] = value
                break
    entry["serving_ic_prior"] = build_serving_ic_prior(artifact)
    entry["serving_ic_source"] = "model_champion_pointers/model_artifact_registry"


def build_pool_from_champion_pointers(
    *,
    pointers: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    pool: dict[str, Any] = {
        "schema_version": "model_pool_v3_d1_pointer_owned",
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "source_of_truth": "model_champion_pointers",
        "models": {},
        "l2_feature_sidecars": {},
    }
    pointer_by_model = {str(row.get("model_name")): row for row in pointers if row.get("model_name")}
    artifacts_by_id = {str(row.get("artifact_id")): row for row in artifacts if row.get("artifact_id")}

    def exact_artifact(model_name: str, version: str, artifact_id: str | None) -> dict[str, Any] | None:
        if not artifact_id:
            return None
        artifact = artifacts_by_id.get(artifact_id)
        if (
            not artifact
            or str(artifact.get("model_name") or "") != model_name
            or str(artifact.get("version") or "") != version
        ):
            return None
        return artifact

    def build_entry(model_name: str, *, artifact_role: str) -> dict[str, Any]:
        pointer = pointer_by_model.get(model_name)
        version = str((pointer or {}).get("champion_version") or "").strip()
        artifact_id = str((pointer or {}).get("champion_artifact_id") or "").strip() or None
        artifact = exact_artifact(model_name, version, artifact_id) if pointer and version else None
        block_reason = None if pointer and version else "missing_d1_champion_pointer"
        block_reason = block_reason or _artifact_identity_block_reason(
            artifact,
            model_name=model_name,
            version=version,
            artifact_id=artifact_id,
        )
        block_reason = block_reason or _artifact_block_reason(
            artifact,
            model_name=model_name,
            artifact_role=artifact_role,
        )
        entry: dict[str, Any] = {
            "version": version,
            "model_slot_status": "active",
            "status": "degraded" if block_reason else "active",
            "serving_eligible": not bool(block_reason),
            "serving_owner": "model_champion_pointers",
            "serving_artifact_id": artifact_id,
            "serving_block_reason": block_reason,
        }
        if artifact:
            artifact_metadata = _artifact_metadata(artifact)
            entry["gcs_path"] = str(artifact.get("artifact_path") or "")
            entry["metadata_path"] = str(artifact.get("metadata_path") or "")
            entry["checksum"] = str(artifact.get("checksum") or "")
            entry["candidate_type"] = artifact.get("candidate_type")
            entry["offline_gate_decision"] = artifact.get("offline_gate_decision")
            entry["live_gate_status"] = artifact.get("live_gate_status")
            entry["target_semantic_version"] = artifact_metadata.get("target_semantic_version")
            entry["feature_semantic_version"] = artifact_metadata.get("feature_semantic_version")
            graph = artifact_metadata.get("graph") if isinstance(artifact_metadata.get("graph"), dict) else {}
            entry["gnn_graph_semantic_version"] = graph.get("semantic_version") if model_name == "GNN" else None
            sequence_contract = _sequence_artifact_contract(model_name, artifact)
            if sequence_contract:
                entry["seq_len"] = sequence_contract["seq_len"]
                entry["pred_len"] = sequence_contract["pred_len"]
                entry["sequence_contract"] = sequence_contract
        _copy_ic_fields(entry, artifact=artifact, pointer=pointer)
        return entry

    for model_name in required_models:
        pool["models"][model_name] = build_entry(model_name, artifact_role="direct_alpha")
    for model_name in sidecar_models:
        entry = build_entry(model_name, artifact_role="l2_feature_sidecar")
        entry["role"] = "l2_feature_sidecar"
        entry["direct_prediction"] = False
        pool["l2_feature_sidecars"][model_name] = entry
    return pool

def _query_rows_once(
    sql: str,
    params: list[Any] | None = None,
    *,
    timeout: float,
) -> list[dict[str, Any]]:
    from . import d1_client

    learning_db_id = str(os.environ.get("CF_D1_LEARNING_DB_ID") or "").strip()
    if not learning_db_id:
        raise ServingPoolResolutionError("learning_d1_database_id_missing")
    return d1_client.query_database(
        learning_db_id, sql, params=params or [], timeout=timeout
    )


def _classify_d1_error(exc: Exception) -> str:
    message = str(exc).lower()
    if "timed out" in message or "timeout" in message:
        return "d1_timeout"
    if "http 429" in message or "rate limit" in message:
        return "d1_rate_limited"
    if any(f"http {status}" in message for status in (500, 502, 503, 504, 524)):
        return "d1_upstream"
    if "network error" in message or "connection" in message or "reset by peer" in message:
        return "d1_network"
    return "d1_query_failed"


def _query_rows(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    attempts = _bounded_env_int("MODEL_SERVING_D1_QUERY_ATTEMPTS", 3, minimum=1, maximum=3)
    timeout = _bounded_env_float(
        "MODEL_SERVING_D1_QUERY_TIMEOUT_SECONDS",
        10.0,
        minimum=1.0,
        maximum=30.0,
    )
    backoff = _bounded_env_float(
        "MODEL_SERVING_D1_RETRY_BACKOFF_SECONDS",
        0.25,
        minimum=0.0,
        maximum=2.0,
    )
    transient = {"d1_timeout", "d1_rate_limited", "d1_upstream", "d1_network"}
    for attempt in range(1, attempts + 1):
        try:
            return _query_rows_once(sql, params, timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - normalize the D1 boundary.
            category = _classify_d1_error(exc)
            if category not in transient or attempt >= attempts:
                raise ServingPoolResolutionError(
                    f"{category}: attempts={attempt}: {type(exc).__name__}: {exc}"
                ) from exc
            if backoff > 0:
                time.sleep(backoff * attempt)
    raise AssertionError("unreachable")


def load_d1_champion_pool(
    *,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    model_names = tuple(dict.fromkeys((*required_models, *sidecar_models)))
    if not model_names:
        return build_pool_from_champion_pointers(
            pointers=[],
            artifacts=[],
            required_models=required_models,
            sidecar_models=sidecar_models,
        )
    placeholders = ", ".join("?" for _ in model_names)
    rows = _query_rows(
        f"""
        SELECT p.model_name AS pointer_model_name,
               p.champion_version, p.champion_artifact_id,
               p.promotion_reason, p.promotion_evidence_json,
               p.updated_at AS pointer_updated_at,
               a.artifact_id,
               a.model_name AS artifact_model_name,
               a.version AS artifact_version,
               a.candidate_type, a.state, a.artifact_path, a.metadata_path, a.checksum,
               a.offline_gate_decision, a.live_gate_status,
               a.live_evidence_json, a.offline_evidence_json,
               a.updated_at AS artifact_updated_at,
               a.created_at AS artifact_created_at
        FROM model_champion_pointers AS p
        LEFT JOIN model_artifact_registry AS a
          ON a.artifact_id = p.champion_artifact_id
        WHERE p.model_name IN ({placeholders})
        """,
        list(model_names),
    )
    pointers: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    for row in rows:
        pointers.append({
            "model_name": row.get("pointer_model_name"),
            "champion_version": row.get("champion_version"),
            "champion_artifact_id": row.get("champion_artifact_id"),
            "promotion_reason": row.get("promotion_reason"),
            "promotion_evidence_json": row.get("promotion_evidence_json"),
            "updated_at": row.get("pointer_updated_at"),
        })
        if row.get("artifact_id"):
            artifacts.append({
                "artifact_id": row.get("artifact_id"),
                "model_name": row.get("artifact_model_name"),
                "version": row.get("artifact_version"),
                "candidate_type": row.get("candidate_type"),
                "state": row.get("state"),
                "artifact_path": row.get("artifact_path"),
                "metadata_path": row.get("metadata_path"),
                "checksum": row.get("checksum"),
                "offline_gate_decision": row.get("offline_gate_decision"),
                "live_gate_status": row.get("live_gate_status"),
                "live_evidence_json": row.get("live_evidence_json"),
                "offline_evidence_json": row.get("offline_evidence_json"),
                "updated_at": row.get("artifact_updated_at"),
                "created_at": row.get("artifact_created_at"),
            })
    return build_pool_from_champion_pointers(
        pointers=pointers,
        artifacts=artifacts,
        required_models=required_models,
        sidecar_models=sidecar_models,
    )

def resolve_serving_pool() -> dict[str, Any]:
    global _RESOLVED_POOL_CACHE, _RESOLVED_POOL_CACHE_LOADED_AT
    if not _d1_env_configured():
        raise ServingPoolResolutionError("d1_champion_serving_environment_missing")
    ttl = _bounded_env_float(
        "MODEL_SERVING_RESOLVED_POOL_CACHE_TTL_SECONDS",
        60.0,
        minimum=0.0,
        maximum=300.0,
    )
    with _RESOLVED_POOL_CACHE_LOCK:
        now = time.monotonic()
        if (
            ttl > 0
            and _RESOLVED_POOL_CACHE is not None
            and now - _RESOLVED_POOL_CACHE_LOADED_AT < ttl
        ):
            return copy.deepcopy(_RESOLVED_POOL_CACHE)
        resolved = load_d1_champion_pool()
        _RESOLVED_POOL_CACHE = copy.deepcopy(resolved)
        _RESOLVED_POOL_CACHE_LOADED_AT = time.monotonic()
        return resolved
