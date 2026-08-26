from __future__ import annotations

import hashlib
import json
import math
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Callable, Literal

from services.active8_release_training_contract import (
    ACTIVE8_MODEL_NAMES,
    validate_model_training_config_attestation,
)
from services.d1_domain_client import D1DataDomain, DomainD1Client, client_for_domain
from services.evidence_contracts import LABEL_SCHEMA_VERSION
from services.model_validation_policy import resolve_model_validation_policy


class _LearningArtifactRegistryD1Client:
    @staticmethod
    def _client() -> DomainD1Client:
        return client_for_domain(D1DataDomain.LEARNING)

    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> list[dict]:
        return self._client().query(sql, params, timeout)

    def execute(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> dict:
        return self._client().execute(sql, params, timeout)

    def atomic_batch_execute(
        self,
        statements: list[tuple[str, list[Any]]],
        timeout: float = 30.0,
    ) -> dict:
        return self._client().atomic_batch_execute(statements, timeout)


d1_client = _LearningArtifactRegistryD1Client()

CandidateType = Literal[
    "oof_full_fit_release",
    "manual_hotfix",
    "model_family_shadow",
    "research_benchmark",
    "timesfm_l175_l2_feature_release",
    "unknown",
]
ArtifactState = Literal[
    "registered",
    "registration_failed",
    "offline_failed",
    "offline_passed_weak",
    "offline_passed",
    "offline_strong_pass",
    "candidate_selected",
    "shadowing",
    "live_gate_passed",
    "approval_required",
    "approved",
    "production",
    "rejected",
    "archived",
]

PRODUCTION_ARTIFACT_EXTENSIONS: dict[str, str] = {
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
PRODUCTION_ARTIFACT_MODEL_NAMES = frozenset(PRODUCTION_ARTIFACT_EXTENSIONS)
ACTIVE8_ARTIFACT_MODEL_NAMES = PRODUCTION_ARTIFACT_MODEL_NAMES - {"TimesFM"}
SEQUENCE_ARTIFACT_MODEL_NAMES = frozenset({"DLinear", "PatchTST", "iTransformer"})
ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION = "active8-family-feature-contract-v3"
ACTIVE8_TARGET_SEMANTIC_VERSION = LABEL_SCHEMA_VERSION
TIMESFM_L175_RELEASE_COHORT = frozenset({"LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"})
PROMOTION_GRADE_SEQUENCE_METHODS = frozenset({
    "purged_cpcv_sequence_rank_ic",
    "purged_walk_forward_retrain_rank_ic",
    "outer_purged_walk_forward_rank_ic",
})


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_safe(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    return value


def _json_dumps(value: Any) -> str:
    return json.dumps(
        _json_safe(value if value is not None else {}),
        ensure_ascii=False,
        sort_keys=True,
        allow_nan=False,
    )


def _json_loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return _json_safe(value)
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
        return _json_safe(parsed) if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def candidate_type_from_retrain(*, explicit: str | None = None) -> CandidateType:
    if explicit in {
        "oof_full_fit_release",
        "manual_hotfix",
        "model_family_shadow",
        "research_benchmark",
        "timesfm_l175_l2_feature_release",
    }:
        return explicit  # type: ignore[return-value]
    return "unknown"

def is_production_artifact_model(model_name: str) -> bool:
    return model_name in PRODUCTION_ARTIFACT_MODEL_NAMES


def model_artifact_path(model_name: str, version: str) -> str:
    folder = model_name.lower().replace("-", "_")
    ext = PRODUCTION_ARTIFACT_EXTENSIONS.get(model_name)
    if ext is None:
        raise ValueError(f"{model_name} is not a managed production artifact model")
    return f"universal/{folder}/{version}.{ext}"


def model_metadata_path(model_name: str, version: str) -> str:
    folder = model_name.lower().replace("-", "_")
    return f"universal/{folder}/metadata_{version}.json"


def artifact_extension_blocker(row: dict[str, Any]) -> dict[str, Any] | None:
    model_name = str(row.get("model_name") or "").strip()
    if not model_name or not is_production_artifact_model(model_name):
        return None
    expected_ext = PRODUCTION_ARTIFACT_EXTENSIONS.get(model_name)
    artifact_path = str(row.get("artifact_path") or "").strip()
    if not artifact_path:
        return {
            "code": "artifact_path_missing",
            "label": "Artifact path is missing",
            "next_action": "Register a concrete versioned artifact path before promotion.",
            "severity": "blocker",
        }
    actual_ext = artifact_path.rsplit(".", 1)[-1].lower() if "." in artifact_path else ""
    if expected_ext and actual_ext != expected_ext:
        return {
            "code": f"artifact_extension_{actual_ext or 'missing'}_expected_{expected_ext}",
            "label": "Artifact extension does not match the production runtime",
            "next_action": f"Use a {model_name} artifact ending in .{expected_ext}, or retrain/register a compatible artifact.",
            "severity": "blocker",
        }
    return None


def evaluate_offline_gate(
    *,
    model_name: str,
    registration: dict[str, Any],
    ic_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fast artifact-level offline gate from retrain callback evidence.

    This is deliberately a first-pass blessing gate. It does not replace the
    heavier backtest/CPCV/PBO/MC promotion controller; it classifies whether the
    freshly registered artifact is even eligible for candidate selection.
    """
    failed: list[str] = []
    warnings: list[str] = []

    if str(registration.get("status") or "").lower() != "registered":
        failed.append("artifact_registration_failed")

    metrics = _nested_dict(registration.get("metrics"))
    sample_count = _as_float(
        registration.get("last_ic_sample_count")
        or metrics.get("oos_samples")
        or metrics.get("samples")
        or metrics.get("sample_count")
    )
    policy_bundle = resolve_model_validation_policy(
        model_name=model_name,
        family=registration.get("family") or metrics.get("family"),
        regime=registration.get("regime") or metrics.get("regime"),
        stage="lifecycle",
        sample_count=int(sample_count) if sample_count is not None else None,
        search_trials=registration.get("search_trials") or metrics.get("search_trials"),
        baseline_oos_ic=registration.get("baseline_oos_ic") or metrics.get("baseline_oos_ic"),
        champion_oos_ic=registration.get("champion_oos_ic") or metrics.get("champion_oos_ic"),
    )
    oos_policy = policy_bundle["oos_ic"]
    min_oos_ic = _as_float(oos_policy.get("min_oos_ic_mean")) or 0.0
    weak_oos_ic = _as_float(oos_policy.get("weak_oos_ic_mean")) or min_oos_ic
    strong_oos_ic = _as_float(oos_policy.get("strong_oos_ic_mean")) or weak_oos_ic

    model_cpcv = registration.get("model_cpcv")
    if not isinstance(model_cpcv, dict):
        warnings.append("model_cpcv_missing_from_callback")
    else:
        decision = str(model_cpcv.get("decision") or "").upper()
        if decision and decision != "PASS":
            failed.append("model_cpcv_failed")
        if not decision:
            warnings.append("model_cpcv_decision_missing")

    ic_value = _as_float((ic_summary or {}).get(model_name))
    if ic_value is None:
        warnings.append("oos_ic_missing_from_callback")
    elif ic_value <= min_oos_ic:
        failed.append("oos_ic_below_policy_floor")
    elif ic_value < weak_oos_ic:
        warnings.append("oos_ic_weak")

    if failed:
        state: ArtifactState = "offline_failed"
        decision = "FAIL"
        status = "failed"
    elif warnings:
        state = "offline_passed_weak"
        decision = "WEAK_PASS"
        status = "weak_pass"
    elif ic_value is not None and ic_value >= strong_oos_ic:
        state = "offline_strong_pass"
        decision = "STRONG_PASS"
        status = "strong_pass"
    else:
        state = "offline_passed"
        decision = "PASS"
        status = "passed"

    return {
        "state": state,
        "status": status,
        "decision": decision,
        "failed_gates": failed,
        "warnings": warnings,
        "policy": policy_bundle,
        "metrics": {
            "oos_ic": ic_value,
            "validation_policy_version": policy_bundle["policy_version"],
            "validation_policy_source": policy_bundle["source"],
            "min_oos_ic_mean": min_oos_ic,
            "weak_oos_ic_mean": weak_oos_ic,
            "strong_oos_ic_mean": strong_oos_ic,
            "family": policy_bundle["family"],
            "regime": policy_bundle["regime"],
            "model_cpcv_decision": (
                model_cpcv.get("decision")
                if isinstance(model_cpcv, dict)
                else None
            ),
        },
    }


def _nested_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _model_training_evidence(payload_dict: dict[str, Any], model_name: str) -> dict[str, Any]:
    """Extract model-specific evidence from the richer retrain followup stages.

    Older followup payloads kept ``challenger_registrations`` intentionally thin
    while storing CPCV/OOS evidence under ``stages.train.ic_tracking`` and
    sequence metadata under ``stages.train.aux_train``. Registry backfills must
    read those fields or valid artifacts look weaker than they really are.
    """
    stages = _nested_dict(payload_dict.get("stages"))
    train = _nested_dict(stages.get("train"))
    ic_tracking = _nested_dict(train.get("ic_tracking"))
    model_ic = _nested_dict(ic_tracking.get(model_name))

    aux_train = _nested_dict(train.get("aux_train"))
    aux_key = {
        "DLinear": "dlinear",
        "PatchTST": "patchtst",
    }.get(model_name)
    aux = _nested_dict(aux_train.get(aux_key)) if aux_key else {}
    aux_metadata = _nested_dict(aux.get("metadata"))

    evidence: dict[str, Any] = {}
    inner_model_cpcv = (
        model_ic.get("model_cpcv")
        if model_ic.get("model_cpcv") is not None
        else aux_metadata.get("model_cpcv")
    )
    oof_evidence_by_model = _nested_dict(payload_dict.get("oof_promotion_evidence"))
    outer_oof_evidence = _nested_dict(oof_evidence_by_model.get(model_name))
    if outer_oof_evidence:
        evidence["model_cpcv"] = outer_oof_evidence
        evidence["oof_promotion_evidence"] = outer_oof_evidence
        if inner_model_cpcv is not None:
            evidence["full_fit_internal_model_cpcv"] = inner_model_cpcv
    elif inner_model_cpcv is not None:
        evidence["model_cpcv"] = inner_model_cpcv

    if aux_metadata.get("feature_policy") is not None:
        evidence["feature_policy"] = aux_metadata.get("feature_policy")
    if aux_metadata.get("feature_policy_schema_version") is not None:
        evidence["feature_policy_version"] = aux_metadata.get("feature_policy_schema_version")
    if aux_metadata.get("selection_evidence") is not None:
        evidence["selection_evidence"] = aux_metadata.get("selection_evidence")
    if aux_metadata.get("version") is not None:
        evidence["metadata_version"] = aux_metadata.get("version")
    if aux_metadata:
        evidence["metadata"] = aux_metadata
    if model_ic:
        evidence["ic_tracking"] = model_ic
    return evidence


def _normalise_lifecycle_registration(
    *,
    payload_dict: dict[str, Any],
    model_name: str,
    raw_result: Any,
) -> dict[str, Any] | None:
    if not is_production_artifact_model(model_name):
        return None
    if not isinstance(raw_result, dict):
        raw_result = {"status": "unknown", "raw": raw_result}

    metadata = _nested_dict(raw_result.get("metadata"))
    saved = _nested_dict(raw_result.get("saved"))
    metrics = _nested_dict(raw_result.get("metrics"))
    ic_tracking = _nested_dict(raw_result.get("ic_tracking"))
    model_ic = _nested_dict(ic_tracking.get(model_name))


    version = (
        raw_result.get("version")
        or metadata.get("version")


    )
    if not version:
        return None
    version = str(version)

    artifact_path = (
        raw_result.get("artifact_path")
        or raw_result.get("gcs_path")
        or saved.get("weights_path")
        or metadata.get("artifact_path")

    )
    metadata_path = (
        raw_result.get("metadata_path")
        or saved.get("metadata_path")
        or metadata.get("metadata_path")
    )
    checksum = raw_result.get("checksum") or saved.get("checksum") or metadata.get("checksum")
    oos_ic = (
        raw_result.get("oos_ic")
        if raw_result.get("oos_ic") is not None
        else metrics.get("oos_ic")
        if metrics.get("oos_ic") is not None
        else model_ic.get("oos_ic")
    )
    model_cpcv = (
        raw_result.get("model_cpcv")
        or metrics.get("model_cpcv")
        or model_ic.get("model_cpcv")
        or metadata.get("model_cpcv")
    )

    raw_status = str(raw_result.get("status") or "").lower()
    has_artifact = bool(artifact_path or saved or metadata)
    status = "registered" if raw_status in {"ok", "registered", ""} and has_artifact else raw_status or "unknown"


    registration: dict[str, Any] = {
        "status": status,
        "version": version,
        "gcs_path": artifact_path,
        "metadata_path": metadata_path,
        "checksum": checksum,
        "oos_ic": oos_ic,
        "metrics": metrics or model_ic,
        "model_cpcv": model_cpcv,
        "training_run_id": payload_dict.get("run_id") or payload_dict.get("trained_at"),
        "training_manifest_path": (
            raw_result.get("training_manifest_path")
            or metadata.get("training_manifest_path")
            or payload_dict.get("training_manifest_path")
        ),
        "evaluation_baseline_version": (
            raw_result.get("evaluation_baseline_version")

        ),
        "artifact_lifecycle_result": raw_result,
        "artifact_lifecycle_target": model_name,


    }
    if metadata.get("feature_policy_schema_version") is not None:
        registration["feature_policy_version"] = metadata.get("feature_policy_schema_version")
    if metadata.get("feature_policy") is not None:
        registration["feature_policy"] = metadata.get("feature_policy")
    if metadata:
        registration["metadata"] = metadata
    return registration


def _lifecycle_registrations(payload_dict: dict[str, Any]) -> dict[str, dict[str, Any]]:
    stages = _nested_dict(payload_dict.get("stages"))
    lifecycle = _nested_dict(stages.get("artifact_lifecycle"))
    results = _nested_dict(lifecycle.get("results"))
    registrations: dict[str, dict[str, Any]] = {}
    for model_name, raw_result in results.items():
        if str(model_name) == "TimesFM":
            continue
        registration = _normalise_lifecycle_registration(
            payload_dict=payload_dict,
            model_name=str(model_name),
            raw_result=raw_result,
        )
        if registration is not None:
            registrations[str(model_name)] = registration
    return registrations


def _timesfm_l2_feature_release_registrations(payload_dict: dict[str, Any]) -> dict[str, dict[str, Any]]:
    stages = _nested_dict(payload_dict.get("stages"))
    release_stage = _nested_dict(stages.get("timesfm_l2_feature_release"))
    results = _nested_dict(release_stage.get("results"))
    registrations: dict[str, dict[str, Any]] = {}
    raw_result = results.get("TimesFM")
    if not isinstance(raw_result, dict):
        return registrations
    registration = _normalise_lifecycle_registration(
        payload_dict=payload_dict,
        model_name="TimesFM",
        raw_result=raw_result,
    )
    if registration is not None:
        registration["release_stage"] = "timesfm_l2_feature_release"
        registration["candidate_type"] = "timesfm_l175_l2_feature_release"
        registration["direct_alpha_blocked"] = True
        registrations["TimesFM"] = registration
    return registrations


def _train_stage_registrations(payload_dict: dict[str, Any]) -> dict[str, dict[str, Any]]:
    version = payload_dict.get("candidate_version")
    if not version:
        return {}
    version = str(version)
    stages = _nested_dict(payload_dict.get("stages"))
    train = _nested_dict(stages.get("train"))
    ic_tracking = _nested_dict(train.get("ic_tracking"))
    explicit_registrations = _nested_dict(train.get("artifact_registrations"))
    registrations: dict[str, dict[str, Any]] = {
        str(model_name): {
            **dict(raw_registration),
            "status": str(raw_registration.get("status") or "registered"),
            "version": str(raw_registration.get("version") or version),
            "metrics": (
                raw_registration.get("metrics")
                if isinstance(raw_registration.get("metrics"), dict)
                else _nested_dict(ic_tracking.get(str(model_name)))
            ),
            "model_cpcv": (
                raw_registration.get("model_cpcv")
                or _nested_dict(ic_tracking.get(str(model_name))).get("model_cpcv")
            ),
            "training_run_id": (
                raw_registration.get("training_run_id")
                or payload_dict.get("run_id")
                or payload_dict.get("trained_at")
            ),
        }
        for model_name, raw_registration in explicit_registrations.items()
        if is_production_artifact_model(str(model_name)) and isinstance(raw_registration, dict)
    }
    for model_name, raw_metrics in ic_tracking.items():
        model_name = str(model_name)
        if not is_production_artifact_model(model_name) or model_name in registrations:
            continue
        metrics = _nested_dict(raw_metrics)
        model_cpcv = metrics.get("model_cpcv") if isinstance(metrics.get("model_cpcv"), dict) else None
        oos_ic = metrics.get("oos_ic") if metrics.get("oos_ic") is not None else metrics.get("ic")
        model_status = str(metrics.get("status") or metrics.get("training_status") or "").strip().lower()
        model_failed = model_status in {"error", "failed", "fail"}
        registered = not model_failed and bool(metrics or model_cpcv or oos_ic is not None)
        registrations[model_name] = {
            "status": "registered" if registered else "error",
            "version": version,
            "gcs_path": model_artifact_path(model_name, version),
            "metadata_path": model_metadata_path(model_name, version),
            "oos_ic": oos_ic,
            "metrics": metrics,
            "model_cpcv": model_cpcv,
            "training_run_id": payload_dict.get("run_id") or payload_dict.get("trained_at"),
            "training_manifest_path": payload_dict.get("training_manifest_path"),
            "evaluation_baseline_version": None,
            "registration_source": "train_stage_ic_tracking",
        }
    return registrations


def _artifact_record_from_registration(
    *,
    payload_dict: dict[str, Any],
    model_name: str,
    raw_registration: Any,
    candidate_type: CandidateType,
    now: str,
    source: str,
) -> dict[str, Any]:
    if not isinstance(raw_registration, dict):
        raw_registration = {"status": "unknown", "raw": raw_registration}
    evidence = _model_training_evidence(payload_dict, model_name)
    enriched_registration = {**evidence, **raw_registration}
    child_training_run_id = str(raw_registration.get("training_run_id") or "").strip()
    lifecycle_resume = _nested_dict(payload_dict.get("oof_lifecycle_resume"))
    lifecycle_run_id = str(payload_dict.get("run_id") or "").strip()
    owns_oof_lifecycle = (
        lifecycle_resume.get("schema_version") == "active8-oof-lifecycle-resume-v1"
        and bool(lifecycle_run_id)
    )
    stages = _nested_dict(payload_dict.get("stages"))
    release_contract_stage = _nested_dict(stages.get("release_training_contract"))
    release_completion_stage = _nested_dict(stages.get("release_model_completion"))
    release_contract_checksum = str(release_contract_stage.get("checksum") or "").lower()
    owns_release_lifecycle = (
        owns_oof_lifecycle
        and candidate_type == "oof_full_fit_release"
        and release_contract_stage.get("status") == "verified"
        and len(release_contract_checksum) == 64
        and all(char in "0123456789abcdef" for char in release_contract_checksum)
        and release_completion_stage.get("status") == "complete"
        and release_completion_stage.get("models_completed") == len(ACTIVE8_MODEL_NAMES)
        and release_completion_stage.get("models_required") == len(ACTIVE8_MODEL_NAMES)
        and str(release_completion_stage.get("contract_checksum") or "").lower() == release_contract_checksum
        and set(_nested_dict(release_completion_stage.get("receipts"))) == set(ACTIVE8_MODEL_NAMES)
    )
    owns_root_lifecycle = owns_release_lifecycle
    if owns_root_lifecycle:
        enriched_registration["oof_lifecycle_resume"] = lifecycle_resume
        enriched_registration["release_training_contract"] = release_contract_stage
        enriched_registration["release_model_completion"] = release_completion_stage
        if child_training_run_id and child_training_run_id != lifecycle_run_id:
            enriched_registration["artifact_training_run_id"] = child_training_run_id
        enriched_registration["training_run_id"] = lifecycle_run_id
    outer_oof_owner = evidence.get("oof_promotion_evidence")
    if isinstance(outer_oof_owner, dict) and outer_oof_owner:
        enriched_registration["model_cpcv"] = outer_oof_owner
        enriched_registration["oof_promotion_evidence"] = outer_oof_owner
    elif not isinstance(enriched_registration.get("model_cpcv"), dict) and isinstance(evidence.get("model_cpcv"), dict):
        enriched_registration["model_cpcv"] = evidence["model_cpcv"]
    record_version = str(raw_registration.get("version") or payload_dict.get("candidate_version"))
    if not record_version:
        raise ValueError(f"artifact_registration_version_missing:{model_name}")
    artifact_id = str(
        raw_registration.get("artifact_id")
        or f"{model_name}:{record_version}:{candidate_type}"
    )

    ic_summary = payload_dict.get("ic_summary") if isinstance(payload_dict.get("ic_summary"), dict) else {}
    local_ic_summary = dict(ic_summary)
    outer_oof_evidence = _nested_dict(enriched_registration.get("oof_promotion_evidence"))
    if outer_oof_evidence.get("oos_ic_mean") is not None:
        local_ic_summary[model_name] = outer_oof_evidence.get("oos_ic_mean")
    elif model_name not in local_ic_summary and raw_registration.get("oos_ic") is not None:
        local_ic_summary[model_name] = raw_registration.get("oos_ic")

    offline_gate = evaluate_offline_gate(
        model_name=model_name,
        registration=enriched_registration,
        ic_summary=local_ic_summary,
    )
    offline_feature_release_candidate_type = candidate_type == "timesfm_l175_l2_feature_release"
    eligible_pending_approval = (
        offline_feature_release_candidate_type
        and offline_gate["decision"] in {"PASS", "STRONG_PASS"}
    )
    state = offline_gate["state"]
    promotion_decision = "eligible_pending_approval" if eligible_pending_approval else "not_evaluated"
    snapshot = (
        (payload_dict.get("stages") or {}).get("dataset_snapshot")
        if isinstance(payload_dict.get("stages"), dict)
        else None
    ) or payload_dict.get("dataset_snapshot")
    return {
        "artifact_id": artifact_id,
        "model_name": model_name,
        "version": record_version,
        "candidate_type": candidate_type,
        "state": state,
        "artifact_path": raw_registration.get("gcs_path"),
        "metadata_path": raw_registration.get("metadata_path"),
        "training_run_id": (
            lifecycle_run_id
            if owns_root_lifecycle
            else raw_registration.get("training_run_id")
            or payload_dict.get("training_run_id")
            or payload_dict.get("run_id")
            or payload_dict.get("trained_at")
        ),
        "training_manifest_path": raw_registration.get("training_manifest_path") or payload_dict.get("training_manifest_path"),
        "trained_from_snapshot": _json_dumps(snapshot) if isinstance(snapshot, (dict, list)) else snapshot,
        "evaluation_baseline_version": raw_registration.get("evaluation_baseline_version"),
        "final_compared_to": raw_registration.get("final_compared_to"),
        "feature_policy_version": raw_registration.get("feature_policy_version") or evidence.get("feature_policy_version"),
        "checksum": raw_registration.get("checksum"),
        "source_run_date": payload_dict.get("run_date"),
        "is_monthly": 1 if str((payload_dict.get("oof_lifecycle_resume") or {}).get("cadence") or "") == "monthly" else 0,
        "offline_gate_status": offline_gate["status"],
        "offline_gate_decision": offline_gate["decision"],
        "offline_gate_failed_gates": _json_dumps(offline_gate["failed_gates"]),
        "offline_evidence_json": _json_dumps({
            "schema_version": "artifact-lifecycle-release-bridge-v1" if source == "artifact_lifecycle" else "retrain-followup-registry-v1",
            "source": source,
            "gate": offline_gate,
            "registration": enriched_registration,
            "ic_summary": {model_name: local_ic_summary.get(model_name)},
            "callback_status": payload_dict.get("status"),
            "callback_error": payload_dict.get("error"),





        }),
        "live_gate_status": "not_started",
        "live_evidence_json": "{}",
        "promotion_decision": promotion_decision,
        "approval_state": "required" if eligible_pending_approval else "not_required",
        "created_at": now,
    }


def _is_suppressed_legacy_challenger_registration(raw_registration: Any) -> bool:
    if not isinstance(raw_registration, dict):
        return False
    status = str(raw_registration.get("status") or "").lower()
    reason = str(raw_registration.get("reason") or "")
    return (
        status == "disabled"
        and reason.startswith("legacy_model_pool_challenger_disabled")
    )


def _load_artifact_metadata_from_gcs(metadata_path: str) -> dict[str, Any]:
    bucket_name = str(os.environ.get("GCS_BUCKET_NAME") or "").strip()
    path = str(metadata_path or "").strip()
    if not bucket_name or not path:
        return {}
    try:
        from google.cloud import storage

        blob = storage.Client().bucket(bucket_name).blob(path)
        if not blob.exists():
            return {}
        loaded = json.loads(blob.download_as_text())
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def hydrate_retrain_followup_artifact_metadata(payload: Any) -> dict[str, Any]:
    """Repair registry-only lineage from immutable GCS artifact metadata."""

    payload_dict = deepcopy(payload.model_dump() if hasattr(payload, "model_dump") else dict(payload))
    version = str(payload_dict.get("candidate_version") or "").strip()
    if not version:
        return payload_dict
    stages = payload_dict.setdefault("stages", {})
    train = stages.setdefault("train", {}) if isinstance(stages, dict) else {}
    if not isinstance(train, dict):
        return payload_dict
    ic_tracking = _nested_dict(train.get("ic_tracking"))
    registrations = _nested_dict(train.get("artifact_registrations"))
    for model_name in ic_tracking:
        model_name = str(model_name)
        if not is_production_artifact_model(model_name):
            continue
        metadata_path = model_metadata_path(model_name, version)
        metadata = _load_artifact_metadata_from_gcs(metadata_path)
        if not metadata:
            continue
        existing = _nested_dict(registrations.get(model_name))
        registrations[model_name] = {
            **existing,
            "status": existing.get("status") or "registered",
            "version": existing.get("version") or version,
            "gcs_path": existing.get("gcs_path") or metadata.get("artifact_path") or model_artifact_path(model_name, version),
            "metadata_path": existing.get("metadata_path") or metadata.get("metadata_path") or metadata_path,
            "checksum": existing.get("checksum") or metadata.get("checksum") or metadata.get("artifact_checksum"),
            "training_run_id": existing.get("training_run_id") or metadata.get("training_run_id"),
            "training_manifest_path": existing.get("training_manifest_path") or metadata.get("training_manifest_path"),
            "feature_policy_version": existing.get("feature_policy_version") or metadata.get("feature_policy_schema_version"),
            "feature_policy": existing.get("feature_policy") or metadata.get("feature_policy"),
            "model_cpcv": existing.get("model_cpcv") or metadata.get("model_cpcv"),
            "oos_ic": existing.get("oos_ic") if existing.get("oos_ic") is not None else metadata.get("oos_ic"),
            "metadata": metadata,
        }
    train["artifact_registrations"] = registrations

    lifecycle = _nested_dict(stages.get("artifact_lifecycle"))
    lifecycle_results = _nested_dict(lifecycle.get("results"))
    for model_name, raw_result in list(lifecycle_results.items()):
        if not is_production_artifact_model(str(model_name)) or not isinstance(raw_result, dict):
            continue
        version = str(raw_result.get("version") or payload_dict.get("candidate_version") or "").strip()
        if not version:
            continue
        metadata_path = str(raw_result.get("metadata_path") or model_metadata_path(str(model_name), version))
        metadata = _load_artifact_metadata_from_gcs(metadata_path)
        if not metadata:
            continue
        lifecycle_results[str(model_name)] = {
            **raw_result,
            "artifact_path": raw_result.get("artifact_path") or metadata.get("artifact_path"),
            "metadata_path": raw_result.get("metadata_path") or metadata.get("metadata_path") or metadata_path,
            "checksum": raw_result.get("checksum") or metadata.get("checksum") or metadata.get("artifact_checksum"),
            "training_manifest_path": raw_result.get("training_manifest_path") or metadata.get("training_manifest_path"),
            "metadata": metadata,
        }
    lifecycle["results"] = lifecycle_results
    return payload_dict


def build_artifact_records_from_retrain_followup(payload: Any) -> list[dict[str, Any]]:
    payload_dict = payload.model_dump() if hasattr(payload, "model_dump") else dict(payload)
    version = payload_dict.get("candidate_version")
    registrations = payload_dict.get("challenger_registrations") or {}
    train_stage_registrations = _train_stage_registrations(payload_dict)
    lifecycle_registrations = _lifecycle_registrations(payload_dict)
    timesfm_l2_feature_release_registrations = _timesfm_l2_feature_release_registrations(payload_dict)
    # Every Active-8 release artifact is registered. Promotion eligibility is
    # evidence-owned and must never erase failed or diagnostic release outputs.
    if not version or (
        (not isinstance(registrations, dict) or not registrations)
        and not train_stage_registrations
        and not lifecycle_registrations
        and not timesfm_l2_feature_release_registrations
    ):
        return []

    candidate_type = candidate_type_from_retrain(
        explicit=payload_dict.get("candidate_type"),
    )
    now = _now_iso()
    out_by_id: dict[str, dict[str, Any]] = {}

    for model_name, raw_registration in train_stage_registrations.items():
        record = _artifact_record_from_registration(
            payload_dict=payload_dict,
            model_name=model_name,
            raw_registration=raw_registration,
            candidate_type=candidate_type,
            now=now,
            source="train_stage",
        )
        out_by_id[record["artifact_id"]] = record

    for model_name, raw_registration in registrations.items():
        model_name = str(model_name)
        if not is_production_artifact_model(model_name):
            continue
        if _is_suppressed_legacy_challenger_registration(raw_registration):
            continue
        record = _artifact_record_from_registration(
            payload_dict=payload_dict,
            model_name=model_name,
            raw_registration=raw_registration,
            candidate_type=candidate_type,
            now=now,
            source="train",
        )
        out_by_id[record["artifact_id"]] = record

    for model_name, raw_registration in lifecycle_registrations.items():
        record = _artifact_record_from_registration(
            payload_dict=payload_dict,
            model_name=model_name,
            raw_registration=raw_registration,
            candidate_type=candidate_type,
            now=now,
            source="artifact_lifecycle",
        )
        out_by_id[record["artifact_id"]] = record
    for model_name, raw_registration in timesfm_l2_feature_release_registrations.items():
        record = _artifact_record_from_registration(
            payload_dict=payload_dict,
            model_name=model_name,
            raw_registration=raw_registration,
            candidate_type="timesfm_l175_l2_feature_release",
            now=now,
            source="timesfm_l2_feature_release",
        )
        out_by_id[record["artifact_id"]] = record
    return list(out_by_id.values())


def upsert_artifact_record(
    record: dict[str, Any],
    *,
    immutable_identity: bool = False,
) -> dict:
    conflict_clause = (
        """
        ON CONFLICT(artifact_id) DO NOTHING
        """
        if immutable_identity
        else """
        ON CONFLICT(artifact_id) DO UPDATE SET
          model_name = excluded.model_name,
          version = excluded.version,
          candidate_type = excluded.candidate_type,
          state = excluded.state,
          artifact_path = excluded.artifact_path,
          metadata_path = excluded.metadata_path,
          training_run_id = excluded.training_run_id,
          training_manifest_path = excluded.training_manifest_path,
          trained_from_snapshot = excluded.trained_from_snapshot,
          evaluation_baseline_version = excluded.evaluation_baseline_version,
          final_compared_to = excluded.final_compared_to,
          feature_policy_version = excluded.feature_policy_version,
          checksum = excluded.checksum,
          source_run_date = excluded.source_run_date,
          is_monthly = excluded.is_monthly,
          offline_gate_status = excluded.offline_gate_status,
          offline_gate_decision = excluded.offline_gate_decision,
          offline_gate_failed_gates = excluded.offline_gate_failed_gates,
          offline_evidence_json = excluded.offline_evidence_json,
          live_gate_status = excluded.live_gate_status,
          live_evidence_json = excluded.live_evidence_json,
          promotion_decision = excluded.promotion_decision,
          approval_state = excluded.approval_state,
          updated_at = CURRENT_TIMESTAMP
        """
    )
    result = d1_client.execute(
        f"""
        INSERT INTO model_artifact_registry (
          artifact_id, model_name, version, candidate_type, state,
          artifact_path, metadata_path, training_run_id, training_manifest_path,
          trained_from_snapshot, evaluation_baseline_version, final_compared_to,
          feature_policy_version, checksum, source_run_date, is_monthly,
          offline_gate_status, offline_gate_decision, offline_gate_failed_gates,
          offline_evidence_json, live_gate_status, live_evidence_json,
          promotion_decision, approval_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
        {conflict_clause}
        """,
        [
            record["artifact_id"],
            record["model_name"],
            record["version"],
            record["candidate_type"],
            record["state"],
            record.get("artifact_path"),
            record.get("metadata_path"),
            record.get("training_run_id"),
            record.get("training_manifest_path"),
            record.get("trained_from_snapshot"),
            record.get("evaluation_baseline_version"),
            record.get("final_compared_to"),
            record.get("feature_policy_version"),
            record.get("checksum"),
            record.get("source_run_date"),
            int(record.get("is_monthly") or 0),
            record.get("offline_gate_status", "not_evaluated"),
            record.get("offline_gate_decision", "PENDING"),
            record.get("offline_gate_failed_gates", "[]"),
            record.get("offline_evidence_json", "{}"),
            record.get("live_gate_status", "not_started"),
            record.get("live_evidence_json", "{}"),
            record.get("promotion_decision", "not_evaluated"),
            record.get("approval_state", "not_required"),
            record.get("created_at"),
        ],
    )
    if not immutable_identity:
        return result

    immutable_columns = (
        "artifact_id",
        "model_name",
        "version",
        "candidate_type",
        "state",
        "artifact_path",
        "metadata_path",
        "training_run_id",
        "training_manifest_path",
        "trained_from_snapshot",
        "evaluation_baseline_version",
        "final_compared_to",
        "feature_policy_version",
        "checksum",
        "source_run_date",
        "is_monthly",
        "offline_gate_status",
        "offline_gate_decision",
        "offline_gate_failed_gates",
        "offline_evidence_json",
        "live_gate_status",
        "live_evidence_json",
        "promotion_decision",
        "approval_state",
    )
    expected = {
        "artifact_id": record["artifact_id"],
        "model_name": record["model_name"],
        "version": record["version"],
        "candidate_type": record["candidate_type"],
        "state": record["state"],
        "artifact_path": record.get("artifact_path"),
        "metadata_path": record.get("metadata_path"),
        "training_run_id": record.get("training_run_id"),
        "training_manifest_path": record.get("training_manifest_path"),
        "trained_from_snapshot": record.get("trained_from_snapshot"),
        "evaluation_baseline_version": record.get("evaluation_baseline_version"),
        "final_compared_to": record.get("final_compared_to"),
        "feature_policy_version": record.get("feature_policy_version"),
        "checksum": record.get("checksum"),
        "source_run_date": record.get("source_run_date"),
        "is_monthly": int(record.get("is_monthly") or 0),
        "offline_gate_status": record.get("offline_gate_status", "not_evaluated"),
        "offline_gate_decision": record.get("offline_gate_decision", "PENDING"),
        "offline_gate_failed_gates": record.get("offline_gate_failed_gates", "[]"),
        "offline_evidence_json": record.get("offline_evidence_json", "{}"),
        "live_gate_status": record.get("live_gate_status", "not_started"),
        "live_evidence_json": record.get("live_evidence_json", "{}"),
        "promotion_decision": record.get("promotion_decision", "not_evaluated"),
        "approval_state": record.get("approval_state", "not_required"),
    }
    rows = d1_client.query(
        f"SELECT {', '.join(immutable_columns)} "
        "FROM model_artifact_registry WHERE artifact_id=? LIMIT 2",
        [record["artifact_id"]],
    )
    if len(rows) != 1:
        raise RuntimeError(f"immutable_artifact_persistence_missing:{record['artifact_id']}")
    mismatches = [
        column for column in immutable_columns
        if rows[0].get(column) != expected[column]
    ]
    if mismatches:
        raise ValueError(
            f"immutable_artifact_identity_conflict:{record['artifact_id']}:"
            f"{','.join(mismatches)}"
        )
    return {**result, "immutable_verified": True}


def upsert_artifact_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    written = 0
    errors: list[str] = []
    for record in records:
        try:
            upsert_artifact_record(record)
            written += 1
        except Exception as exc:  # noqa: BLE001 - caller decides whether registry is fatal.
            errors.append(f"{record.get('artifact_id')}: {exc}")
    return {"attempted": len(records), "written": written, "errors": errors}


def list_artifact_registry(
    *,
    model_name: str | None = None,
    state: str | None = None,
    candidate_type: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if model_name:
        where.append("model_name = ?")
        params.append(model_name)
    if state:
        where.append("state = ?")
        params.append(state)
    if candidate_type:
        where.append("candidate_type = ?")
        params.append(candidate_type)
    sql_where = f"WHERE {' AND '.join(where)}" if where else ""
    rows = d1_client.query(
        f"""
        SELECT *
        FROM model_artifact_registry
        {sql_where}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
        """,
        [*params, max(1, min(int(limit or 100), 500))],
    )
    for row in rows:
        for key in ("offline_gate_failed_gates", "offline_evidence_json", "live_evidence_json"):
            raw = row.get(key)
            if not isinstance(raw, str):
                continue
            try:
                row[key] = _json_safe(json.loads(raw))
            except json.JSONDecodeError:
                row[key] = raw
    return rows


def list_artifacts_by_ids(
    artifact_ids: list[str] | tuple[str, ...],
    *,
    max_ids: int = 9,
) -> list[dict[str, Any]]:
    """Read only the bounded champion artifacts needed for one serving snapshot."""
    normalized = list(dict.fromkeys(
        str(artifact_id or "").strip()
        for artifact_id in artifact_ids
        if str(artifact_id or "").strip()
    ))
    if not normalized:
        return []
    if len(normalized) > max_ids:
        raise ValueError(
            f"artifact_id_query_exceeds_bound:actual={len(normalized)}:max={max_ids}"
        )
    placeholders = ", ".join("?" for _ in normalized)
    rows = d1_client.query(
        f"""
        SELECT *
        FROM model_artifact_registry
        WHERE artifact_id IN ({placeholders})
        ORDER BY updated_at DESC, created_at DESC
        """,
        normalized,
    )
    for row in rows:
        for key in (
            "offline_gate_failed_gates",
            "offline_evidence_json",
            "live_evidence_json",
        ):
            raw = row.get(key)
            if not isinstance(raw, str):
                continue
            try:
                row[key] = _json_safe(json.loads(raw))
            except json.JSONDecodeError:
                row[key] = raw
    return rows


def list_champion_pointers(model_name: str | None = None) -> list[dict[str, Any]]:
    """Read the mandatory Learning-D1 champion pointer table."""
    where = ""
    params: list[Any] = []
    if model_name:
        where = "WHERE model_name = ?"
        params.append(model_name)
    rows = d1_client.query(
        f"""
        SELECT *
        FROM model_champion_pointers
        {where}
        ORDER BY updated_at DESC
        """,
        params,
    )
    for row in rows:
        raw = row.get("promotion_evidence_json")
        if isinstance(raw, str):
            try:
                row["promotion_evidence_json"] = _json_safe(json.loads(raw))
            except json.JSONDecodeError:
                row["promotion_evidence_json"] = raw
    return rows

def _legacy_shadow_selection_row(row: dict[str, Any]) -> bool:
    return str(row.get("state") or "") == "shadowing"


def _candidate_rank(row: dict[str, Any]) -> tuple[int, str]:
    return (
        _STATE_RANK.get(str(row.get("state") or ""), 0),
        str(row.get("updated_at") or row.get("created_at") or ""),
    )


_VERSION_TS_RE = re.compile(r"(\d{8,14})")


def _artifact_time_key(row: dict[str, Any] | None) -> tuple[str, str, str]:
    if not row:
        return ("", "", "")
    version_match = _VERSION_TS_RE.search(str(row.get("version") or ""))
    version_key = version_match.group(1) if version_match else ""
    return (
        str(row.get("source_run_date") or ""),
        version_key,
        str(row.get("updated_at") or row.get("created_at") or ""),
    )


def _promotion_ready(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    state = str(row.get("state") or "")
    live_status = str(row.get("live_gate_status") or "")
    if (
        _offline_oof_full_fit_release_candidate(row)
        or _offline_timesfm_l175_feature_release_candidate(row)
    ):
        return True
    return state in {"live_gate_passed", "approval_required", "approved", "production"} or live_status in {
        "passed",
        "multi_evidence_passed",
        "rolling_ic_passed",
    }


def _offline_oof_full_fit_base_artifact(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    registration = _artifact_registration(row)
    evidence = _nested_dict(registration.get("oof_promotion_evidence"))
    resume = _nested_dict(registration.get("oof_lifecycle_resume"))
    metadata = _artifact_registration_metadata(row)
    validation_design = _nested_dict(evidence.get("validation_design"))
    release_validation = _nested_dict(registration.get("oof_release_validation"))
    base_authority = _nested_dict(release_validation.get("base_artifact_authority"))
    release_contract = _nested_dict(registration.get("release_training_contract"))
    release_contract_validation = _nested_dict(release_contract.get("validation"))
    release_completion = _nested_dict(registration.get("release_model_completion"))
    failed_gates = evidence.get("failed_gates")
    return (
        str(row.get("candidate_type") or "") == "oof_full_fit_release"
        and str(row.get("offline_gate_decision") or "") in {"STRONG_PASS", "PASS"}
        and str(row.get("state") or "") in {
            "offline_passed",
            "offline_strong_pass",
            "live_gate_passed",
            "approval_required",
            "approved",
        }
        and evidence.get("schema_version") == "model-cpcv-evidence-v1"
        and evidence.get("method") == "outer_purged_walk_forward_rank_ic"
        and evidence.get("decision") == "PASS"
        and evidence.get("passed") is True
        and not failed_gates
        and int(_as_float(evidence.get("folds")) or 0) >= 5
        and int(_as_float(evidence.get("min_test_rows")) or 0) >= 90
        and float(_as_float(evidence.get("coverage_mean")) or 0.0) >= 0.8
        and validation_design.get("refit_each_fold") is True
        and validation_design.get("chronological") is True
        and int(_as_float(validation_design.get("purge_horizon_sessions")) or 0) >= 5
        and release_contract.get("status") == "verified"
        and set(release_contract.get("models") or []) == set(ACTIVE8_MODEL_NAMES)
        and int(_as_float(release_contract_validation.get("minimum_outer_folds")) or 0) >= 5
        and release_contract_validation.get("refit_each_fold") is True
        and release_contract_validation.get("promotion_requires_immutable_oof") is True
        and (
            str(row.get("model_name") or "") != "DLinear"
            or release_contract_validation.get("dlinear_single_holdout_is_diagnostic_only") is True
        )
        and release_completion.get("status") == "complete"
        and int(_as_float(release_completion.get("models_completed")) or 0) == len(ACTIVE8_MODEL_NAMES)
        and int(_as_float(release_completion.get("models_required")) or 0) == len(ACTIVE8_MODEL_NAMES)
        and resume.get("schema_version") == "active8-oof-lifecycle-resume-v1"
        and bool(str(resume.get("cohort_id") or "").strip())
        and len(str(resume.get("source_manifest_checksum") or "")) == 64
        and bool(str(resume.get("knowledge_cutoff_date") or "").strip())
        and str(metadata.get("target_semantic_version") or "") == ACTIVE8_TARGET_SEMANTIC_VERSION
        and release_validation.get("schema_version") == "active8-oof-base-ranker-release-validation-v3"
        and release_validation.get("validation_role") == "base_ranker"
        and release_validation.get("decision") == "PASS"
        and not release_validation.get("failed_gates")
        and base_authority.get("decision") == "PASS"
        and base_authority.get("owner") == "individual_outer_purged_oof"
        and base_authority.get("effect") == "base_artifact_release_only"
    )


def _offline_oof_full_fit_release_candidate(row: dict[str, Any] | None) -> bool:
    if not _offline_oof_full_fit_base_artifact(row):
        return False
    registration = _artifact_registration(row or {})
    release_validation = _nested_dict(registration.get("oof_release_validation"))
    selection = _nested_dict(release_validation.get("selection_authority"))
    return (
        selection.get("scope") == "cohort_model_selection_process"
        and selection.get("method") == "label_interval_purged_cscv_rank_logit"
        and selection.get("effect") == "automatic_champion_selection_and_ensemble_weighting_only"
        and selection.get("decision") == "PASS"
        and selection.get("go_live_verdict") == "PASS"
        and not selection.get("failed_gates")
        and _as_float(selection.get("pbo")) is not None
        and _as_float(selection.get("max_pbo")) is not None
        and float(_as_float(selection.get("pbo")))
        < float(_as_float(selection.get("max_pbo")))
        and float(_as_float(selection.get("oos_mean_spread")) or 0.0) > 0.0
        and float(_as_float(selection.get("selection_identifiability_ratio")) or 0.0)
        >= 0.75
    )


def _offline_oof_full_fit_release_blockers(
    row: dict[str, Any],
    *,
    champion_artifact: dict[str, Any] | None,
    blockers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    filtered = [
        blocker
        for blocker in blockers
        if str(blocker.get("code") or "") not in {
            "live_ic_not_ready",
            "rolling_ic_only",
            "candidate_sample_window_too_short",
            "champion_sample_window_too_short",
            "dsr_mc_missing",
        }
    ]
    if not _offline_oof_full_fit_base_artifact(row):
        filtered.append({
            "code": "oof_release_contract_invalid",
            "label": "OOF full-fit release lacks immutable chronological evidence",
            "next_action": "Rebuild the OOF cohort; do not patch model metadata or bypass the release contract.",
            "severity": "blocker",
        })
        return filtered
    if not _offline_oof_full_fit_release_candidate(row):
        filtered.append({
            "code": "cohort_model_selection_pbo_failed",
            "label": "Base artifact is valid, but cohort selection PBO blocks automatic champion selection and ensemble weighting",
            "next_action": "Keep the base artifact available; rebuild the cohort selection packet with new immutable OOF evidence.",
            "severity": "blocker",
        })
        return filtered
    if not champion_artifact:
        filtered.append({
            "code": "oof_release_champion_artifact_missing",
            "label": "Current champion artifact is unavailable for target-semantic comparison",
            "next_action": "Restore the champion registry pointer before attempting the target-semantic bootstrap.",
            "severity": "blocker",
        })
        return filtered
    champion_target = str(
        _artifact_registration_metadata(champion_artifact).get("target_semantic_version") or ""
    ).strip()
    if champion_target == ACTIVE8_TARGET_SEMANTIC_VERSION:
        filtered.append({
            "code": "oof_release_requires_semantic_bootstrap",
            "label": "OOF offline bootstrap is only valid when no comparable target-semantic champion exists",
            "next_action": "Use the normal live challenger comparison for subsequent artifacts in the same target era.",
            "severity": "blocker",
        })
    return filtered


def _offline_timesfm_l175_feature_release_candidate(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    return (
        str(row.get("candidate_type") or "") == "timesfm_l175_l2_feature_release"
        and str(row.get("offline_gate_decision") or "") in {"STRONG_PASS", "PASS"}
        and str(row.get("state") or "") in {
            "offline_passed",
            "offline_strong_pass",
            "live_gate_passed",
            "approval_required",
            "approved",
        }
    )


def _offline_feature_release_blockers(blockers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    hard_blocker_codes = {
        "model_not_active_production_artifact",
        "missing_current_champion",
        "offline_gate_not_passed",
    }
    return [
        blocker
        for blocker in blockers
        if str(blocker.get("code") or "") in hard_blocker_codes
        or str(blocker.get("code") or "").startswith("artifact_integrity_")
        or str(blocker.get("code") or "").startswith("feature_contract_")
        or str(blocker.get("code") or "").startswith("feature_release_")
        or str(blocker.get("code") or "").startswith("validation_design_")
        or str(blocker.get("code") or "").startswith("cpcv_")
        or str(blocker.get("code") or "").startswith("foundation_")
    ]

def _non_production_artifact_context(
    row: dict[str, Any] | None,
    *,
    selection_slot: str | None = None,
) -> dict[str, Any]:
    model_name = str((row or {}).get("model_name") or "unknown")
    return {
        "root_cause": "model_not_active_production_artifact",
        "impact": "Artifact is retained for audit evidence, but cannot enter active-8 direct-alpha selection, live shadow, or promotion.",
        "next_action": "Archive or leave as historical evidence; use the active-8 direct-alpha model artifact lane for production candidates.",
        "affected_downstream": ["artifact_registry", "model_pool_ui"],
        "scheduler_dependency": [],
        "evidence_status": "suppressed",
        "selection_slot": selection_slot,
        "metrics": {
            "model_name": model_name,
            "eligible_models": sorted(PRODUCTION_ARTIFACT_MODEL_NAMES),
        },
    }


def _non_production_artifact_suppression(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "artifact_id": row.get("artifact_id"),
        "model_name": str(row.get("model_name") or ""),
        "candidate_version": row.get("version"),
        "candidate_type": str(row.get("candidate_type") or "unknown"),
        "superseded_by": None,
        "reason": "model_not_active_production_artifact",
        "action_context": _non_production_artifact_context(row),
    }


def _artifact_live_decision(row: dict[str, Any]) -> dict[str, Any]:
    live = _json_loads(row.get("live_evidence_json"))
    decision = live.get("decision")
    return decision if isinstance(decision, dict) else {}


def _artifact_offline_evidence(row: dict[str, Any]) -> dict[str, Any]:
    offline = _json_loads(row.get("offline_evidence_json"))
    return offline if isinstance(offline, dict) else {}


def _artifact_registration_metadata(row: dict[str, Any]) -> dict[str, Any]:
    direct = _nested_dict(row.get("metadata"))
    if direct:
        return direct
    registration = _nested_dict(_artifact_offline_evidence(row).get("registration"))
    return _nested_dict(registration.get("metadata"))


def _artifact_registration(row: dict[str, Any]) -> dict[str, Any]:
    return _nested_dict(_artifact_offline_evidence(row).get("registration"))


def _canonical_artifact_checksum(row: dict[str, Any]) -> str:
    metadata = _artifact_registration_metadata(row)
    registration = _artifact_registration(row)
    raw = (
        row.get("checksum")
        or registration.get("checksum")
        or metadata.get("artifact_checksum")
        or metadata.get("checksum")
    )
    checksum = str(raw or "").strip().lower()
    if not checksum:
        raise RuntimeError("artifact_integrity_checksum_missing")
    if re.fullmatch(r"sha256:[0-9a-f]{64}", checksum) is None:
        raise RuntimeError("artifact_integrity_checksum_invalid")
    return checksum


def _deep_get(source: Any, keys: set[str]) -> Any:
    if not isinstance(source, dict):
        return None
    for key, value in source.items():
        if key in keys and value not in (None, ""):
            return value
    for value in source.values():
        found = _deep_get(value, keys)
        if found not in (None, ""):
            return found
    return None


def _truthy_gate_value(value: Any, *, max_fail_value: float | None = None) -> bool:
    if value in (None, ""):
        return False
    if isinstance(value, dict):
        for key in (
            "decision",
            "status",
            "verdict",
            "go_live_verdict",
            "result",
            "pass",
            "passed",
            "ok",
            "value",
            "score",
            "pbo",
            "deflated_sharpe",
            "tail_risk",
        ):
            if key in value and _truthy_gate_value(value.get(key), max_fail_value=max_fail_value):
                return True
        return False
    text = str(value).strip().upper()
    if text in {"PASS", "PASSED", "STRONG_PASS", "OK", "TRUE"}:
        return True
    if text in {"FAIL", "FAILED", "N/A", "NA", "NONE", "FALSE"}:
        return False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    if max_fail_value is not None:
        return number <= max_fail_value
    return number > 0


def _preferred_evidence(source: Any, keys: list[str]) -> Any:
    if not isinstance(source, dict):
        return None
    for key in keys:
        value = _deep_get(source, {key})
        if isinstance(value, dict):
            return value
    for key in keys:
        value = _deep_get(source, {key})
        if value not in (None, ""):
            return value
    return None


def _first_metric(source: Any, *keys: str) -> float | None:
    if not isinstance(source, dict):
        return None
    for key in keys:
        value = _as_float(source.get(key))
        if value is not None:
            return value
    return None


def _artifact_oos_ic(row: dict[str, Any] | None) -> float | None:
    if not row:
        return None
    model_name = str(row.get("model_name") or "")
    offline = _artifact_offline_evidence(row)
    gate = _nested_dict(offline.get("gate"))
    gate_metrics = _nested_dict(gate.get("metrics"))
    registration = _nested_dict(offline.get("registration"))
    registration_metrics = _nested_dict(registration.get("metrics"))
    registration_ic_tracking = _nested_dict(registration.get("ic_tracking"))
    registration_cpcv = _nested_dict(registration.get("model_cpcv"))
    ic_tracking_cpcv = _nested_dict(registration_ic_tracking.get("model_cpcv"))
    ic_summary = _nested_dict(offline.get("ic_summary"))
    foundation_forecast = _nested_dict(
        registration.get("foundation_forecast_validation")
        or offline.get("foundation_forecast_validation")
    )
    for value in (
        gate_metrics.get("oos_ic"),
        ic_summary.get(model_name),
        registration.get("oos_ic"),
        registration_metrics.get("oos_ic"),
        registration_ic_tracking.get("oos_ic"),
        registration_cpcv.get("oos_ic_mean"),
        ic_tracking_cpcv.get("oos_ic_mean"),
        foundation_forecast.get("oos_ic_mean"),
    ):
        numeric = _as_float(value)
        if numeric is not None:
            return numeric
    return None


def _artifact_compare(
    candidate: dict[str, Any],
    *,
    champion_version: str | None,
    champion_artifact: dict[str, Any] | None,
) -> dict[str, Any]:
    candidate_oos_ic = _artifact_oos_ic(candidate)
    champion_oos_ic = _artifact_oos_ic(champion_artifact)
    delta = (
        round(candidate_oos_ic - champion_oos_ic, 8)
        if candidate_oos_ic is not None and champion_oos_ic is not None
        else None
    )
    if not champion_version:
        metric_status = "missing_champion_pointer"
        next_action = "Resolve current champion pointer before judging promotion delta."
    elif champion_artifact is None:
        metric_status = "missing_champion_artifact"
        next_action = "Backfill or register the current champion artifact so candidate-vs-champion metrics are visible."
    elif candidate_oos_ic is None:
        metric_status = "missing_candidate_metric"
        next_action = "Attach candidate OOS IC / CPCV evidence before promotion review."
    elif champion_oos_ic is None:
        metric_status = "missing_champion_metric"
        next_action = "Attach champion baseline OOS IC before promotion review."
    else:
        metric_status = "candidate_beats_champion" if delta is not None and delta > 0 else "candidate_not_better"
        next_action = (
            "Candidate has positive offline delta; still require live/multi-evidence gate and approval policy."
            if delta is not None and delta > 0
            else "Do not promote on offline evidence; candidate does not beat champion OOS IC."
        )
    return {
        "schema_version": "artifact-compare-v1",
        "primary_metric": "oos_ic",
        "candidate_version": candidate.get("version"),
        "current_champion_version": champion_version,
        "champion_artifact_id": champion_artifact.get("artifact_id") if champion_artifact else None,
        "candidate_oos_ic": candidate_oos_ic,
        "champion_oos_ic": champion_oos_ic,
        "oos_ic_delta": delta,
        "metric_status": metric_status,
        "final_compared_to": candidate.get("final_compared_to"),
        "next_action": next_action,
    }


def _add_policy_metric_blocker(
    add: Callable[[str, str, str, str], None],
    *,
    code: str,
    label: str,
    value: float | None,
    threshold: float | None,
    relation: str,
    next_action: str,
) -> None:
    if threshold is None:
        return
    failed = value is None
    if not failed and relation == ">=":
        failed = value < threshold
    if not failed and relation == "<=":
        failed = value > threshold
    if failed:
        observed = "missing" if value is None else f"{value:.6g}"
        add(
            code,
            label,
            f"{next_action} observed={observed} required {relation} {threshold:.6g}.",
            "blocker",
        )


def _add_cpcv_policy_blockers(
    add: Callable[[str, str, str, str], None],
    *,
    evidence: Any,
    policy: dict[str, Any],
    prefix: str = "cpcv",
) -> None:
    if not isinstance(evidence, dict):
        return

    evidence_policy = evidence.get("policy") if isinstance(evidence.get("policy"), dict) else {}
    merged_policy = {**policy, **evidence_policy}
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_oos_ic_below_policy",
        label="CPCV rank IC is below policy",
        value=_first_metric(evidence, "oos_ic_mean", "rank_ic", "min_rank_ic"),
        threshold=_first_metric(merged_policy, "min_oos_ic_mean", "min_rank_ic"),
        relation=">=",
        next_action="Rerun or inspect family-specific CPCV/foundation validation with enough signal.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_fold_count_below_policy",
        label="CPCV fold count is below policy",
        value=_first_metric(evidence, "folds"),
        threshold=_first_metric(merged_policy, "min_folds"),
        relation=">=",
        next_action="Generate enough purged CPCV folds for this model family.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_test_rows_below_policy",
        label="CPCV test rows are below policy",
        value=_first_metric(evidence, "min_test_rows", "samples"),
        threshold=_first_metric(merged_policy, "min_test_rows", "min_samples"),
        relation=">=",
        next_action="Attach CPCV/foundation evidence with enough verified test rows.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_coverage_below_policy",
        label="CPCV coverage is below policy",
        value=_first_metric(
            evidence,
            "coverage_gate_value",
            "sequence_window_coverage",
            "union_oos_coverage",
            "valid_series_coverage",
            "coverage_mean",
            "coverage",
        ),
        threshold=_first_metric(merged_policy, "min_coverage"),
        relation=">=",
        next_action="Increase fold/outcome coverage before promotion.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_positive_fold_ratio_below_policy",
        label="Positive fold ratio is below policy",
        value=_first_metric(evidence, "positive_fold_ratio"),
        threshold=_first_metric(merged_policy, "min_positive_fold_ratio"),
        relation=">=",
        next_action="Reject or retrain until CPCV signal is stable across folds.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_ic_std_above_policy",
        label="CPCV IC instability is above policy",
        value=_first_metric(evidence, "oos_ic_std"),
        threshold=_first_metric(merged_policy, "max_oos_ic_std"),
        relation="<=",
        next_action="Reduce unstable fold dispersion before promotion.",
    )
    _add_policy_metric_blocker(
        add,
        code=f"{prefix}_direction_accuracy_below_policy",
        label="Foundation forecast direction accuracy is below policy",
        value=_first_metric(evidence, "direction_accuracy"),
        threshold=_first_metric(merged_policy, "min_direction_accuracy"),
        relation=">=",
        next_action="Keep TimesFM as evidence-only until forecast/outcome validation improves.",
    )


def artifact_promotion_blockers(row: dict[str, Any], *, champion_version: str | None = None) -> list[dict[str, Any]]:
    """Return promotion blockers with machine codes and human-action text.

    Rolling live IC is useful evidence, but it is not sufficient for production
    promotion. The final promotion lane needs a multi-evidence packet so the UI
    cannot make a one-window shadow win look like an approval-ready artifact.
    """
    blockers: list[dict[str, Any]] = []
    live_status = str(row.get("live_gate_status") or "")
    state = str(row.get("state") or "")
    offline_decision = str(row.get("offline_gate_decision") or "")
    live_decision = _artifact_live_decision(row)
    metrics = live_decision.get("metrics") if isinstance(live_decision.get("metrics"), dict) else {}
    offline = _artifact_offline_evidence(row)

    def add(code: str, label: str, next_action: str, severity: str = "blocker") -> None:
        blockers.append({
            "code": code,
            "label": label,
            "next_action": next_action,
            "severity": severity,
        })

    model_name = str(row.get("model_name") or "")
    policy_bundle = resolve_model_validation_policy(
        model_name=model_name,
        regime=_deep_get(offline, {"regime", "alpha_regime", "market_regime"}),
        stage="promotion",
        sample_count=int(_as_float(metrics.get("shadow_samples")) or 0) or None,
        search_trials=_deep_get(offline, {"search_trials", "trial_count", "optuna_trials", "context_sweep_trials"}),
    )
    if model_name and not is_production_artifact_model(model_name):
        add(
            "model_not_active_production_artifact",
            "Model is not in the active-8 direct-alpha production artifact set",
            "Keep this artifact as historical/research evidence; production promotion must use an active-8 direct-alpha model.",
        )
    extension_blocker = artifact_extension_blocker(row)
    if extension_blocker:
        blockers.append(extension_blocker)

    registration = _artifact_registration(row)
    metadata = _artifact_registration_metadata(row)
    release_config_attested = False
    if str(row.get("candidate_type") or "") == "oof_full_fit_release":
        attestation = _nested_dict(metadata.get("model_training_config_attestation"))
        try:
            verified_attestation = validate_model_training_config_attestation(
                attestation,
                expected_model_name=model_name,
            )
            trained_snapshot = _json_loads(row.get("trained_from_snapshot"))
            if not isinstance(trained_snapshot, dict):
                raise ValueError("model_training_config_attestation_snapshot_lineage_missing")
            if str(trained_snapshot.get("snapshot_id") or "") != str(verified_attestation["dataset_snapshot_id"]):
                raise ValueError("model_training_config_attestation_snapshot_lineage_mismatch")
            if str(row.get("source_run_date") or "") != str(verified_attestation["run_date"]):
                raise ValueError("model_training_config_attestation_run_date_lineage_mismatch")
            metadata_source_sha = str(metadata.get("producer_source_sha") or "").strip()
            if metadata_source_sha and metadata_source_sha != str(verified_attestation["producer_source_sha"]):
                raise ValueError("model_training_config_attestation_source_lineage_mismatch")
            release_config_attested = True
        except (KeyError, TypeError, ValueError) as exc:
            add(
                "release_training_config_attestation_missing_or_invalid",
                "OOF release artifact lacks immutable model-specific config evidence",
                f"Regenerate this model from the checksum-bound Active-8 release contract: {exc}",
            )
    target_semantic = str(metadata.get("target_semantic_version") or "").strip()
    if model_name in ACTIVE8_ARTIFACT_MODEL_NAMES and target_semantic != ACTIVE8_TARGET_SEMANTIC_VERSION:
        add(
            "artifact_target_semantic_mismatch",
            "Artifact target does not match the executable Active-8 return target",
            "Retrain with next-session open to fifth-session close labels; metadata cannot be patched after training.",
        )
    contract_required = (
        str(row.get("feature_policy_version") or registration.get("feature_policy_version") or metadata.get("feature_policy_schema_version") or "")
        == "model-feature-policy-v2"
        or str(row.get("source_run_date") or "") >= "2026-07-13"
        or str(row.get("candidate_type") or "") == "timesfm_l175_l2_feature_release"
    )
    checksum = row.get("checksum") or registration.get("checksum") or metadata.get("checksum") or metadata.get("artifact_checksum")
    if contract_required and not str(checksum or "").startswith("sha256:"):
        add(
            "artifact_integrity_checksum_missing",
            "Artifact bytes have no verifiable SHA-256 checksum",
            "Regenerate the artifact and metadata together; promotion must verify bytes before deserialization.",
        )

    feature_contract = _nested_dict(metadata.get("family_feature_contract"))
    if contract_required and str(feature_contract.get("schema_version") or "") != ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION:
        add(
            "feature_contract_family_schema_missing",
            "Artifact lacks the active-8 family-specific feature schema",
            "Retrain this model under active8-family-feature-contract-v3; do not infer parity from a column count.",
        )

    if contract_required and model_name in SEQUENCE_ARTIFACT_MODEL_NAMES:
        if _positive_int(metadata.get("seq_len")) is None or _positive_int(metadata.get("pred_len")) is None:
            add(
                "artifact_sequence_contract_missing_or_invalid",
                "Sequence artifact lacks positive seq_len/pred_len metadata",
                "Regenerate artifact registration from the exact trained metadata; do not inherit another version's sequence length.",
            )
        cpcv = _nested_dict(registration.get("model_cpcv")) or _nested_dict(metadata.get("model_cpcv"))
        method = str(cpcv.get("method") or "")
        validation_design = _nested_dict(cpcv.get("validation_design")) or _nested_dict(metadata.get("validation_design"))
        if method not in PROMOTION_GRADE_SEQUENCE_METHODS:
            add(
                "validation_design_sequence_method_not_promotion_grade",
                "Sequence validation is a holdout/proxy, not retrained temporal OOS",
                "Run purged CPCV or chronological walk-forward with a fresh fit in every fold.",
            )
        if validation_design.get("refit_each_fold") is not True:
            add(
                "validation_design_sequence_refit_missing",
                "Sequence validation did not prove per-fold refitting",
                "Record signal-date splits, purge horizon, and refit_each_fold=true in artifact evidence.",
            )

    if live_status not in {"passed", "multi_evidence_passed", "rolling_ic_passed"} and state != "live_gate_passed":
        add(
            "live_ic_not_ready",
            "Rolling live IC is not ready",
            "Keep daily predict -> verify-v2 -> model-ic-rolling running until verified rows are promotion-grade.",
        )
    elif live_status == "rolling_ic_passed":
        add(
            "rolling_ic_only",
            "Only rolling live IC passed",
            "Run the multi-evidence promotion gate; a single rolling IC window cannot update the champion pointer.",
            severity="review",
        )

    shadow_samples = _as_float(metrics.get("shadow_samples"))
    production_samples = _as_float(metrics.get("production_samples"))
    evidence_min_samples = _as_float(metrics.get("min_samples")) or 0
    policy_min_samples = _as_float(policy_bundle["live_ic"].get("min_verified_rows")) or evidence_min_samples
    required_samples = max(evidence_min_samples, policy_min_samples)
    if shadow_samples is None or shadow_samples < required_samples:
        add(
            "candidate_sample_window_too_short",
            "Candidate verified sample window is too short",
            f"Collect at least {int(required_samples)} verified candidate rows under the active family/regime policy.",
        )
    if production_samples is None or production_samples < required_samples:
        add(
            "champion_sample_window_too_short",
            "Champion baseline sample window is too short",
            f"Collect at least {int(required_samples)} matching champion verified rows before final comparison.",
        )

    if not champion_version:
        add(
            "missing_current_champion",
            "Missing current champion pointer",
            "Resolve the D1 champion pointer or model_pool serving version before final comparison.",
        )

    if offline_decision not in {"STRONG_PASS", "PASS"}:
        add(
            "offline_gate_not_passed",
            "Offline gate did not pass",
            "Rerun or inspect offline gate evidence: OOS IC, segment coverage, and artifact metadata.",
        )

    cpcv = _preferred_evidence(offline, ["model_cpcv", "cpcv", "cpcv_decision", "model_cpcv_decision"])
    forecast_validation = _preferred_evidence(
        offline,
        ["foundation_forecast_validation", "forecast_validation", "last_artifact_evidence"],
    )
    cpcv_owner = str(policy_bundle["cpcv"].get("owner") or "family_specific_cpcv")
    if cpcv_owner == "foundation_forecast_validation":
        if not _truthy_gate_value(forecast_validation) and not _truthy_gate_value(cpcv):
            add(
                "foundation_forecast_validation_missing",
                "Missing foundation forecast validation evidence",
                "Attach TimesFM forecast/outcome validation evidence for the selected context before final comparison.",
            )
        else:
            _add_cpcv_policy_blockers(
                add,
                evidence=forecast_validation if _truthy_gate_value(forecast_validation) else cpcv,
                policy=policy_bundle["cpcv"],
                prefix="foundation",
            )
    elif not _truthy_gate_value(cpcv):
        add(
            "cpcv_pbo_missing",
            "Missing CPCV evidence",
            "Attach family-specific CPCV evidence so rolling live IC is not treated as a one-window artifact.",
        )
    else:
        _add_cpcv_policy_blockers(
            add,
            evidence=cpcv,
            policy=policy_bundle["cpcv"],
            prefix="cpcv",
        )

    pbo = _deep_get(offline, {"pbo", "pbo_score", "probability_of_backtest_overfitting"})
    pbo_value = _as_float(pbo.get("pbo") if isinstance(pbo, dict) else pbo)
    pbo_method = str(pbo.get("method") if isinstance(pbo, dict) else "").lower()
    pbo_policy = policy_bundle["pbo"]
    pbo_required = bool(pbo_policy.get("required")) and not release_config_attested
    max_pbo = _as_float(pbo_policy.get("max_pbo"))
    if pbo_required and (
        not _truthy_gate_value(pbo, max_fail_value=max_pbo)
        or (pbo_value is not None and max_pbo is not None and pbo_value > max_pbo)
    ):
        add(
            "pbo_threshold_missing",
            "PBO threshold is missing or too high",
            f"Provide promotion-grade PBO at or below adaptive policy max_pbo={max_pbo}.",
        )
    if pbo_required and isinstance(pbo, dict) and pbo_method and pbo_method != str(pbo_policy.get("method") or "cscv_rank_logit"):
        add(
            "pbo_method_not_promotion_grade",
            "PBO method is proxy-grade",
            "Run promotion-grade CSCV rank-logit PBO; proxy PBO is visible but cannot approve production.",
        )
    search_trials = int(_as_float(_deep_get(offline, {"search_trials", "trial_count", "optuna_trials", "context_sweep_trials"})) or 1)
    if pbo_required and contract_required and search_trials > 1:
        pbo_scope = str(pbo.get("selection_scope") if isinstance(pbo, dict) else "")
        pbo_model = str(pbo.get("model_name") if isinstance(pbo, dict) else "")
        if pbo_scope != "model_configuration_selection" or pbo_model != model_name:
            add(
                "pbo_model_selection_lineage_invalid",
                "PBO does not belong to this model's configuration search",
                "Attach model-specific CSCV evidence with selection_scope=model_configuration_selection; cohort PBO cannot approve one model.",
            )

    dsr = _deep_get(offline, {"deflated_sharpe", "dsr"})
    mc = _deep_get(offline, {"monte_carlo", "mc", "mc_tail_risk", "tail_risk"})
    if not _truthy_gate_value(dsr) or not _truthy_gate_value(mc):
        add(
            "dsr_mc_missing",
            "Missing DSR or Monte Carlo tail-risk evidence",
            "Attach deflated Sharpe and Monte Carlo tail-risk evidence before promotion.",
        )

    if live_status == "multi_evidence_passed":
        return [
            b
            for b in blockers
            if b["code"] in {"missing_current_champion", "model_not_active_production_artifact"}
        ]
    return blockers


def build_artifact_action_context(
    row: dict[str, Any] | None,
    *,
    selection_slot: str | None = None,
    champion_version: str | None = None,
) -> dict[str, Any]:
    """Normalize artifact/gate status into a human-actionable contract.

    UI and OBS should not infer root causes from scattered registry columns.
    This context is the single artifact-level explanation: what is blocked,
    which downstream flow is affected, and what should run next.
    """
    if not row:
        return {
            "root_cause": "candidate_missing",
            "impact": "No selected artifact can enter live shadow, promotion, or artifact diff.",
            "next_action": "Run retrain followup, then offline gate and candidate selection.",
            "affected_downstream": ["live_gate", "promotion_controller", "artifact_diff"],
            "scheduler_dependency": ["retrain_followup"],
            "evidence_status": "missing",
        }

    model_name = str(row.get("model_name") or "")
    if model_name and not is_production_artifact_model(model_name):
        return _non_production_artifact_context(row, selection_slot=selection_slot)

    state = str(row.get("state") or "registered")
    offline_status = str(row.get("offline_gate_status") or "not_evaluated")
    offline_decision = str(row.get("offline_gate_decision") or "PENDING")
    live_status = str(row.get("live_gate_status") or "not_started")
    live_decision = _artifact_live_decision(row)
    failed_gates = row.get("offline_gate_failed_gates")
    if isinstance(failed_gates, str):
        try:
            failed_gates = json.loads(failed_gates)
        except json.JSONDecodeError:
            failed_gates = [failed_gates]
    if not isinstance(failed_gates, list):
        failed_gates = []

    if state in {"registration_failed", "offline_failed"} or offline_status == "failed":
        return {
            "root_cause": "offline_gate_failed",
            "impact": "Artifact cannot enter selected candidate, live shadow, or promotion.",
            "next_action": "Inspect offline evidence, fix failed gates, then rerun retrain followup/offline gate.",
            "affected_downstream": ["candidate_selection", "live_gate", "promotion_controller"],
            "scheduler_dependency": ["retrain_followup", "offline_gate"],
            "evidence_status": "failed",
            "failed_gates": failed_gates,
        }

    offline_ready_states = {
        "offline_passed",
        "offline_strong_pass",
        "candidate_selected",
        "shadowing",
        "live_gate_passed",
        "approval_required",
        "approved",
    }
    if live_status == "not_started":
        if state not in offline_ready_states:
            return {
                "root_cause": "offline_evidence_weak_or_pending",
                "impact": "Artifact can be retained as evidence, but should not replace production.",
                "next_action": "Complete OOS IC, CPCV/PBO, DSR/MC, and segment evidence before live shadow selection.",
                "affected_downstream": ["candidate_selection"],
                "scheduler_dependency": ["offline_gate", "validation_packet"],
                "evidence_status": "partial",
                "failed_gates": failed_gates,
            }
        return {
            "root_cause": "live_shadow_not_started",
            "impact": "Candidate has offline evidence, but no production-adjacent live comparison yet.",
            "next_action": "Run daily ML predict with shadow output, then verify-v2 and model-ic-rolling.",
            "affected_downstream": ["live_gate", "promotion_controller", "artifact_diff"],
            "scheduler_dependency": ["ml-predict", "verify-v2", "model-ic-rolling"],
            "evidence_status": "offline_only",
            "selection_slot": selection_slot,
        }

    if live_status in {"shadowing_not_enough_data", "production_baseline_not_enough_data"}:
        metrics = live_decision.get("metrics") if isinstance(live_decision.get("metrics"), dict) else {}
        return {
            "root_cause": live_decision.get("root_cause") or live_status,
            "impact": "Live IC is not promotion-grade yet; UI should show candidate as shadowing, not failed.",
            "next_action": "Keep daily predict/verify/model-ic-rolling running until verified rows meet min_samples.",
            "affected_downstream": ["promotion_controller"],
            "scheduler_dependency": ["verify-v2", "model-ic-rolling"],
            "evidence_status": "collecting",
            "metrics": metrics,
            "selection_slot": selection_slot,
        }

    if state in {"registered", "offline_passed_weak"} or (offline_decision in {"PENDING", "WEAK_PASS"} and state not in offline_ready_states):
        return {
            "root_cause": "offline_evidence_weak_or_pending",
            "impact": "Artifact can be retained as evidence, but should not replace production.",
            "next_action": "Complete OOS IC, CPCV/PBO, DSR/MC, and segment evidence before live shadow selection.",
            "affected_downstream": ["candidate_selection"],
            "scheduler_dependency": ["offline_gate", "validation_packet"],
            "evidence_status": "partial",
            "failed_gates": failed_gates,
        }

    if live_status == "failed":
        blockers = artifact_promotion_blockers(row, champion_version=champion_version)
        return {
            "root_cause": live_decision.get("root_cause") or "live_gate_failed",
            "impact": "Candidate should not promote unless a later final comparison overturns this evidence.",
            "next_action": "Archive candidate or keep as research evidence; do not update champion pointer.",
            "affected_downstream": ["promotion_controller"],
            "scheduler_dependency": ["promotion_controller"],
            "evidence_status": "failed",
            "selection_slot": selection_slot,
            "blockers": blockers,
        }

    if live_status in {"passed", "rolling_ic_passed"} or state == "live_gate_passed":
        blockers = artifact_promotion_blockers(row, champion_version=champion_version)
        if blockers:
            return {
                "root_cause": "multi_evidence_gate_blocked",
                "impact": "Rolling live IC is only one evidence source; candidate is not promotion-grade yet.",
                "next_action": "Resolve promotion blockers before final comparison or approval.",
                "affected_downstream": ["promotion_controller", "model_pool_ui"],
                "scheduler_dependency": ["validation_packet", "model-ic-rolling"],
                "evidence_status": "blocked",
                "selection_slot": selection_slot,
                "metrics": live_decision.get("metrics") if isinstance(live_decision.get("metrics"), dict) else {},
                "blockers": blockers,
            }
        return {
            "root_cause": "live_gate_passed",
            "impact": "Candidate is eligible for final comparison against the current champion.",
            "next_action": "Run promotion-controller final comparison; approval may be required by policy.",
            "affected_downstream": ["promotion_controller", "line_notification"],
            "scheduler_dependency": ["promotion_controller"],
            "evidence_status": "ready",
            "selection_slot": selection_slot,
        }

    return {
        "root_cause": live_decision.get("root_cause") or live_status or state,
        "impact": "Artifact lifecycle is in progress; production champion pointer is unchanged.",
        "next_action": "Inspect registry evidence and continue the lifecycle owner for this state.",
        "affected_downstream": ["model_registry"],
        "scheduler_dependency": [],
        "evidence_status": "unknown",
        "selection_slot": selection_slot,
    }


def build_candidate_selection(
    rows: list[dict[str, Any]],
    *,
    champion_pointers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Select the single canonical immutable-OOF release candidate per model."""

    grouped: dict[str, list[dict[str, Any]]] = {}
    pointer_by_model = {
        str(pointer.get("model_name") or ""): pointer
        for pointer in (champion_pointers or [])
        if pointer.get("model_name")
    }
    suppressed: list[dict[str, Any]] = []
    ignored_historical_count = 0
    for row in rows:
        model_name = str(row.get("model_name") or "unknown")
        if not is_production_artifact_model(model_name):
            suppressed.append(_non_production_artifact_suppression(row))
            continue
        grouped.setdefault(model_name, []).append(row)

    selections: dict[str, dict[str, Any]] = {}
    for model_name, items in grouped.items():
        canonical = [
            row
            for row in items
            if str(row.get("candidate_type") or "") == "oof_full_fit_release"
            and not _legacy_shadow_selection_row(row)
        ]
        ignored_historical_count += len(items) - len(canonical)
        latest_release = max(canonical, key=_artifact_time_key, default=None)
        selected_release = (
            latest_release
            if latest_release and _offline_oof_full_fit_release_candidate(latest_release)
            else None
        )
        pointer = pointer_by_model.get(model_name) or {}
        pointer_artifact_id = str(pointer.get("champion_artifact_id") or "").strip()
        pointer_version = str(pointer.get("champion_version") or "").strip()
        serving_release = next(
            (
                row
                for row in items
                if pointer_artifact_id
                and str(row.get("artifact_id") or "").strip() == pointer_artifact_id
                and (not pointer_version or str(row.get("version") or "").strip() == pointer_version)
            ),
            None,
        )

        selections[model_name] = {
            "oof_full_fit_release_candidate": selected_release,
            "latest_oof_full_fit_release_artifact": latest_release,
            "serving_release_artifact": serving_release,
            "archive_candidates": [],
            "superseded_candidates": [],
            "action_context": {
                "oof_full_fit_release_candidate": build_artifact_action_context(
                    selected_release,
                    selection_slot="oof_full_fit_release_candidate",
                ),
            },
            "policy": {
                "release": "single canonical immutable-OOF full-fit release; no monthly/weekly fallback",
                "serving_release_artifact": "exact D1 champion pointer identity only; no production-row or version fallback",
                "archive_candidates": "historical noncanonical artifacts remain immutable audit rows and never enter runtime selection",
                "live_shadow_slots": {"oof_full_fit_release": 1},
            },
        }

    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry",
        "selection_policy": "canonical_oof_full_fit_release_v1",
        "ignored_historical_count": ignored_historical_count,
        "suppressed_count": len(suppressed),
        "suppressed": suppressed,
        "models": selections,
    }

def build_live_shadow_candidate_selection(
    rows: list[dict[str, Any]],
    *,
    champion_pointers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Select at most one zero-weight canonical OOF challenger per Active-8 model."""

    selection = build_candidate_selection(rows, champion_pointers=champion_pointers)
    pointer_by_model = {
        str(pointer.get("model_name") or ""): pointer
        for pointer in (champion_pointers or [])
        if pointer.get("model_name")
    }
    selected: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = list(selection.get("suppressed") or [])
    for model_name in sorted(ACTIVE8_ARTIFACT_MODEL_NAMES):
        model_selection = (selection.get("models") or {}).get(model_name)
        if not isinstance(model_selection, dict):
            continue
        candidate = model_selection.get("oof_full_fit_release_candidate")
        if not isinstance(candidate, dict) or not candidate.get("artifact_id"):
            continue
        pointer = pointer_by_model.get(model_name) or {}
        champion_artifact_id = str(pointer.get("champion_artifact_id") or "").strip()
        if str(candidate.get("artifact_id") or "").strip() == champion_artifact_id:
            suppressed.append({
                "model_name": model_name,
                "artifact_id": candidate.get("artifact_id"),
                "reason": "candidate_is_current_champion",
            })
            continue
        selected.append({
            **candidate,
            "_selection_slot": "oof_full_fit_release_candidate",
            "_production_effect": False,
            "_vote_weight": 0.0,
        })
    return {
        "schema_version": "active8-live-shadow-selection-v2",
        "source_of_truth": "model_artifact_registry.canonical_oof_full_fit_release_v1",
        "production_effect": False,
        "vote_weight": 0.0,
        "selected": selected,
        "suppressed": suppressed,
    }

def _ic_number(info: dict[str, Any] | None) -> float | None:
    if not isinstance(info, dict):
        return None
    return _as_float(info.get("ic"))


def _sample_count(info: dict[str, Any] | None) -> int:
    if not isinstance(info, dict):
        return 0
    try:
        return int(info.get("n_samples") or 0)
    except (TypeError, ValueError):
        return 0


def _live_gate_decision(
    *,
    model_name: str,
    per_model_ic: dict[str, dict[str, Any]],
    min_samples: int,
) -> dict[str, Any]:
    shadow_name = f"{model_name}::challenger"
    production = per_model_ic.get(model_name) or {}
    shadow = per_model_ic.get(shadow_name) or {}
    shadow_ic = _ic_number(shadow)
    production_ic = _ic_number(production)
    shadow_samples = _sample_count(shadow)
    production_samples = _sample_count(production)

    if shadow_samples < min_samples or shadow_ic is None:
        return {
            "state": "shadowing",
            "live_gate_status": "shadowing_not_enough_data",
            "promotion_decision": "not_evaluated",
            "approval_state": "not_required",
            "reason": "Selected artifact challenger has not accumulated enough verified candidate rows.",
            "metrics": {
                "shadow_model_name": shadow_name,
                "shadow_ic": shadow_ic,
                "shadow_samples": shadow_samples,
                "production_ic": production_ic,
                "production_samples": production_samples,
                "min_samples": min_samples,
            },
            "root_cause": shadow.get("root_cause") or shadow.get("status") or "shadow_prediction_missing",
            "production_root_cause": production.get("root_cause"),
        }

    if production_samples < min_samples or production_ic is None:
        return {
            "state": "shadowing",
            "live_gate_status": "production_baseline_not_enough_data",
            "promotion_decision": "not_evaluated",
            "approval_state": "not_required",
            "reason": "Shadow has evidence, but production baseline IC is not stable enough for final comparison.",
            "metrics": {
                "shadow_model_name": shadow_name,
                "shadow_ic": shadow_ic,
                "shadow_samples": shadow_samples,
                "production_ic": production_ic,
                "production_samples": production_samples,
                "min_samples": min_samples,
            },
            "root_cause": production.get("root_cause") or production.get("status") or "production_baseline_missing",
            "production_root_cause": production.get("root_cause"),
        }

    delta = shadow_ic - production_ic
    beats_champion = delta > 0
    passed = shadow_ic > 0 and beats_champion
    if passed:
        failure_root_cause = "rolling_ic_passed_needs_multi_evidence"
        failure_reason = (
            "Shadow candidate beats current production baseline on rolling verified live IC, "
            "but final promotion still requires CPCV/PBO, DSR/MC, and stability evidence."
        )
    elif beats_champion:
        failure_root_cause = "shadow_beats_champion_but_absolute_ic_negative"
        failure_reason = (
            "Shadow candidate is less negative than the current champion, but its absolute verified IC is still negative; "
            "keep it out of the promotion queue."
        )
    else:
        failure_root_cause = "shadow_ic_not_better_than_champion"
        failure_reason = "Shadow candidate does not beat current production baseline on verified live IC."
    return {
        "state": "shadowing",
        "live_gate_status": "rolling_ic_passed" if passed else "failed",
        "promotion_decision": "needs_multi_evidence_gate" if passed else "reject_or_keep_shadowing",
        "approval_state": "not_required",
        "reason": failure_reason,
        "metrics": {
            "shadow_model_name": shadow_name,
            "shadow_ic": shadow_ic,
            "shadow_samples": shadow_samples,
            "production_ic": production_ic,
            "production_samples": production_samples,
            "ic_delta": round(delta, 6),
            "min_samples": min_samples,
            "lookback_semantic": "rolling_verified_ic_window",
        },
        "root_cause": failure_root_cause,
        "production_root_cause": production.get("root_cause"),
    }


def update_live_gate_from_ic(
    per_model_ic: dict[str, dict[str, Any]],
    *,
    min_samples: int,
    limit: int = 500,
) -> dict[str, Any]:
    """Persist live shadow evidence for selected registry candidates.

    Registry owns artifact state. IC tracker owns verified IC calculation. This
    bridge keeps the ownership clean: it only updates artifacts selected by the
    release-train policy, and it writes evidence; it does not promote champions.
    """
    rows = list_artifact_registry(limit=limit)
    selection = build_live_shadow_candidate_selection(
        rows,
        champion_pointers=list_champion_pointers(),
    )
    selected: dict[str, dict[str, Any]] = {
        str(candidate["artifact_id"]): candidate
        for candidate in (selection.get("selected") or [])
        if isinstance(candidate, dict)
        and candidate.get("artifact_id")
        and str(candidate.get("model_name") or "") in ACTIVE8_ARTIFACT_MODEL_NAMES
    }

    updates: list[dict[str, Any]] = []
    errors: list[str] = []
    now = _now_iso()
    for artifact_id, row in selected.items():
        model_name = str(row.get("model_name") or row.get("_model_name") or "")
        if not model_name:
            continue
        decision = _live_gate_decision(
            model_name=model_name,
            per_model_ic=per_model_ic,
            min_samples=min_samples,
        )
        evidence = {
            "schema_version": "artifact-live-gate-v1",
            "evaluated_at": now,
            "selection_slot": row.get("_selection_slot"),
            "model_name": model_name,
            "artifact_id": artifact_id,
            "decision": decision,
        }
        try:
            d1_client.execute(
                """
                UPDATE model_artifact_registry
                SET state = ?,
                    live_gate_status = ?,
                    live_evidence_json = ?,
                    promotion_decision = ?,
                    approval_state = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE artifact_id = ?
                """,
                [
                    decision["state"],
                    decision["live_gate_status"],
                    _json_dumps(evidence),
                    decision["promotion_decision"],
                    decision["approval_state"],
                    artifact_id,
                ],
            )
            updates.append({
                "artifact_id": artifact_id,
                "model_name": model_name,
                "state": decision["state"],
                "live_gate_status": decision["live_gate_status"],
                "promotion_decision": decision["promotion_decision"],
                "metrics": decision["metrics"],
                "root_cause": decision["root_cause"],
                "action_context": build_artifact_action_context(
                    {**row, "state": decision["state"], "live_gate_status": decision["live_gate_status"], "live_evidence_json": _json_dumps(evidence)},
                    selection_slot=str(row.get("_selection_slot") or ""),
                ),
            })
        except Exception as exc:  # noqa: BLE001 - IC tracker should report partial registry failures.
            errors.append(f"{artifact_id}: {exc}")

    return {
        "status": "ok" if not errors else "partial_error",
        "selected": len(selected),
        "updated": len(updates),
        "updates": updates,
        "errors": errors,
    }


def _blocker_codes(blockers: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("code") or "unknown_blocker") for item in blockers if isinstance(item, dict)]


def build_promotion_queue(
    rows: list[dict[str, Any]],
    *,
    champion_versions: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build the canonical OOF/manual/feature promotion queue."""

    champion_versions = champion_versions or {}
    queue: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    ignored_historical_count = 0
    artifact_by_model_version = {
        (str(row.get("model_name") or ""), str(row.get("version") or "")): row
        for row in rows
        if row.get("model_name") and row.get("version")
    }
    supported_candidate_types = {
        "oof_full_fit_release",
        "manual_hotfix",
        "timesfm_l175_l2_feature_release",
    }

    for row in rows:
        candidate_type = str(row.get("candidate_type") or "unknown")
        if candidate_type not in supported_candidate_types:
            ignored_historical_count += 1
            continue
        state = str(row.get("state") or "")
        live_status = str(row.get("live_gate_status") or "")
        live_evidence_ready = live_status in {"passed", "multi_evidence_passed", "rolling_ic_passed"}
        offline_oof_candidate = _offline_oof_full_fit_release_candidate(row) and not live_evidence_ready
        offline_oof_base_artifact = _offline_oof_full_fit_base_artifact(row) and not live_evidence_ready
        offline_timesfm_candidate = _offline_timesfm_l175_feature_release_candidate(row) and not live_evidence_ready
        if state in {"production", "archived", "rejected"}:
            continue
        if (
            not offline_oof_candidate
            and not offline_oof_base_artifact
            and not offline_timesfm_candidate
            and state not in {"live_gate_passed", "approval_required", "approved"}
            and not live_evidence_ready
        ):
            continue

        model_name = str(row.get("model_name") or "")
        champion_version = champion_versions.get(model_name)
        candidate_version = str(row.get("version") or "")
        if not is_production_artifact_model(model_name):
            suppressed.append(_non_production_artifact_suppression(row))
            continue
        if champion_version and candidate_version == champion_version:
            suppressed.append({
                "artifact_id": row.get("artifact_id"),
                "model_name": model_name,
                "candidate_version": candidate_version,
                "candidate_type": candidate_type,
                "superseded_by": "current_champion_pointer",
                "reason": "candidate_version_already_current_champion",
            })
            continue

        offline_decision = str(row.get("offline_gate_decision") or "")
        approval_required = candidate_type == "manual_hotfix"
        blockers = artifact_promotion_blockers(row, champion_version=champion_version)
        champion_artifact = artifact_by_model_version.get((model_name, champion_version or ""))
        if offline_timesfm_candidate:
            blockers = _offline_feature_release_blockers(blockers)
        if offline_oof_base_artifact:
            blockers = _offline_oof_full_fit_release_blockers(
                row,
                champion_artifact=champion_artifact,
                blockers=blockers,
            )
        blocker_codes = _blocker_codes(blockers)
        artifact_compare = _artifact_compare(
            row,
            champion_version=champion_version,
            champion_artifact=champion_artifact,
        )
        if not champion_version:
            decision = "blocked_missing_champion_pointer"
            next_action = "Resolve the exact D1 champion pointer before final comparison."
        elif blockers:
            decision = "blocked_multi_evidence_gate"
            next_action = "Resolve blockers before final comparison: " + ", ".join(blocker_codes)
        elif offline_oof_candidate:
            decision = "auto_promote_candidate"
            next_action = "Atomically promote the immutable OOF release."
        elif offline_timesfm_candidate:
            decision = "blocked_live_evidence_required"
            next_action = "Collect live feature-cohort evidence before atomic promotion."
        elif approval_required:
            decision = "approval_required"
            next_action = "Run final comparison, then request explicit hotfix approval."
        else:
            decision = "auto_promote_candidate"
            next_action = "Run final comparison; promote only when no production blocker remains."

        queue.append({
            "artifact_id": row.get("artifact_id"),
            "model_name": model_name,
            "candidate_version": candidate_version,
            "candidate_type": candidate_type,
            "state": state,
            "offline_gate_decision": offline_decision,
            "live_gate_status": live_status,
            "evaluation_baseline_version": row.get("evaluation_baseline_version"),
            "final_compared_to": row.get("final_compared_to"),
            "current_champion_version": champion_version,
            "promotion_decision": decision,
            "approval_required": approval_required,
            "next_action": next_action,
            "blockers": blockers,
            "blocker_codes": blocker_codes,
            "artifact_compare": artifact_compare,
            "action_context": build_artifact_action_context(row, champion_version=champion_version),
        })

    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry",
        "promotion_owner": "promotion-controller",
        "count": len(queue),
        "ignored_historical_count": ignored_historical_count,
        "suppressed_count": len(suppressed),
        "suppressed": suppressed,
        "queue": queue,
    }

def feature_release_cohort_blockers(
    artifact: dict[str, Any],
    registry_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if str(artifact.get("candidate_type") or "") != "timesfm_l175_l2_feature_release":
        return []
    training_run_id = str(artifact.get("training_run_id") or "")
    matching = {
        str(row.get("model_name") or ""): row
        for row in registry_rows
        if str(row.get("candidate_type") or "") == "timesfm_l175_l2_feature_release"
        and str(row.get("training_run_id") or "") == training_run_id
    }
    blockers: list[dict[str, Any]] = []
    missing = sorted(TIMESFM_L175_RELEASE_COHORT - set(matching))
    if missing:
        blockers.append({
            "code": "feature_release_cohort_incomplete",
            "label": "TimesFM feature release does not contain every affected L3 artifact",
            "next_action": "Retrain one release cohort for LightGBM, XGBoost, ExtraTrees, TabM, and GNN.",
            "severity": "blocker",
            "missing_models": missing,
        })
    invalid: dict[str, list[str]] = {}
    for model_name, row in matching.items():
        if model_name not in TIMESFM_L175_RELEASE_COHORT:
            continue
        metadata = _artifact_registration_metadata(row)
        contract = _nested_dict(metadata.get("family_feature_contract"))
        reasons: list[str] = []
        if contract.get("family_schema") != "formal137_plus_timesfm_l175_v1":
            reasons.append("feature_schema_mismatch")
        if contract.get("timesfm_l175_sidecar_required") is not True:
            reasons.append("timesfm_sidecar_not_required")
        if contract.get("atomic_cohort_required") is not True:
            reasons.append("atomic_cohort_not_declared")
        if str(row.get("offline_gate_decision") or "") not in {"PASS", "STRONG_PASS"}:
            reasons.append("offline_gate_not_passed")
        checksum = row.get("checksum") or _artifact_registration(row).get("checksum") or metadata.get("checksum") or metadata.get("artifact_checksum")
        if not str(checksum or "").startswith("sha256:"):
            reasons.append("checksum_missing")
        if reasons:
            invalid[model_name] = reasons
    if invalid:
        blockers.append({
            "code": "feature_release_cohort_contract_mismatch",
            "label": "TimesFM feature release cohort has mixed schema or incomplete evidence",
            "next_action": "Rebuild the entire cohort from one dataset snapshot and release id before promotion.",
            "severity": "blocker",
            "invalid_models": invalid,
        })
    return blockers


def _promotion_row_decision(
    *,
    artifact: dict[str, Any],
    pointer: dict[str, Any] | None,
    champion_version: str | None,
    approved: bool,
    manual_override: bool = False,
    champion_artifact: dict[str, Any] | None = None,
    cohort_blockers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Evaluate the final promotion step against the exact D1 champion pointer."""

    live_status = str(artifact.get("live_gate_status") or "")
    state = str(artifact.get("state") or "")
    candidate_type = str(artifact.get("candidate_type") or "unknown")
    offline_decision = str(artifact.get("offline_gate_decision") or "")
    offline_oof_base_artifact = bool(
        candidate_type == "oof_full_fit_release"
        and _offline_oof_full_fit_base_artifact(artifact)
    )
    offline_oof_release_candidate = bool(
        candidate_type == "oof_full_fit_release"
        and _offline_oof_full_fit_release_candidate(artifact)
    )
    offline_timesfm_candidate = bool(
        candidate_type == "timesfm_l175_l2_feature_release"
        and offline_decision in {"STRONG_PASS", "PASS"}
    )
    approval_required = candidate_type == "manual_hotfix"
    blockers: list[str] = []
    promotion_blockers = artifact_promotion_blockers(artifact, champion_version=champion_version)
    if offline_oof_base_artifact:
        promotion_blockers = _offline_oof_full_fit_release_blockers(
            artifact,
            champion_artifact=champion_artifact,
            blockers=promotion_blockers,
        )
    promotion_blockers.extend(cohort_blockers or [])
    manual_override_requested = bool(manual_override)
    manual_override_allowed = bool(
        manual_override_requested
        and approved
        and candidate_type == "manual_hotfix"
        and offline_decision in {"STRONG_PASS", "PASS"}
    )
    overridden_blockers: list[dict[str, Any]] = []
    effective_promotion_blockers = promotion_blockers
    if manual_override_allowed:
        non_overridable_prefixes = ("artifact_extension_", "cpcv_", "foundation_", "return_quality_")
        non_overridable_codes = {
            "model_not_active_production_artifact",
            "missing_current_champion",
            "offline_gate_not_passed",
        }

        def is_non_overridable(blocker: dict[str, Any]) -> bool:
            code = str(blocker.get("code") or "")
            return code in non_overridable_codes or any(code.startswith(prefix) for prefix in non_overridable_prefixes)

        effective_promotion_blockers = [blocker for blocker in promotion_blockers if is_non_overridable(blocker)]
        overridden_blockers = [blocker for blocker in promotion_blockers if not is_non_overridable(blocker)]
    if effective_promotion_blockers:
        blockers.extend(_blocker_codes(effective_promotion_blockers))
    if (
        not manual_override_allowed
        and not offline_oof_base_artifact
        and live_status not in {"passed", "multi_evidence_passed"}
    ):
        blockers.append("live_gate_not_passed")
    if not champion_version:
        blockers.append("missing_current_champion")
    if offline_decision in {"FAIL", "PBO_FAIL", "CPCV_FAIL"}:
        blockers.append("offline_gate_failed")
    blockers = list(dict.fromkeys(blockers))

    current_artifact_id = pointer.get("champion_artifact_id") if pointer else None
    evidence = {
        "schema_version": "promotion-controller-final-comparison-v2",
        "evaluated_at": _now_iso(),
        "model_name": artifact.get("model_name"),
        "candidate_artifact_id": artifact.get("artifact_id"),
        "candidate_version": artifact.get("version"),
        "candidate_type": candidate_type,
        "current_champion_version": champion_version,
        "current_champion_artifact_id": current_artifact_id,
        "offline_gate_decision": offline_decision,
        "live_gate_status": live_status,
        "live_evidence": _json_loads(artifact.get("live_evidence_json")),
        "offline_evidence": _json_loads(artifact.get("offline_evidence_json")),
        "approval_required": approval_required,
        "approved": approved,
        "manual_override_requested": manual_override_requested,
        "manual_override_allowed": manual_override_allowed,
        "manual_override_overridden_blockers": overridden_blockers,
        "offline_oof_full_fit_base_artifact": offline_oof_base_artifact,
        "offline_oof_full_fit_release_candidate": offline_oof_release_candidate,
        "offline_timesfm_l175_feature_release_candidate": offline_timesfm_candidate,
        "blockers": blockers,
        "blocker_details": effective_promotion_blockers,
    }

    if blockers:
        return {
            "decision": "blocked",
            "can_promote": False,
            "approval_required": approval_required,
            "target_state": state or "shadowing",
            "approval_state": "required" if approval_required else "not_required",
            "next_action": "Resolve blockers before promotion: " + ", ".join(blockers),
            "final_compared_to": champion_version,
            "evidence": evidence,
        }
    if approval_required and not approved:
        return {
            "decision": "approval_required",
            "can_promote": False,
            "approval_required": True,
            "target_state": "approval_required",
            "approval_state": "required",
            "next_action": "Manual hotfix approval required before updating champion pointer.",
            "final_compared_to": champion_version,
            "evidence": evidence,
        }
    return {
        "decision": "manual_override_promote" if manual_override_allowed else "promote",
        "can_promote": True,
        "approval_required": approval_required,
        "target_state": "production",
        "approval_state": "approved" if approval_required else "not_required",
        "next_action": "Atomically update the D1 champion pointer after artifact readback.",
        "final_compared_to": champion_version,
        "evidence": evidence,
    }

def run_promotion_controller(
    *,
    artifact_id: str,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    confirm: bool = False,
    approved: bool = False,
    approved_by: str | None = None,
    reason: str = "promotion_controller",
    manual_override: bool = False,
) -> dict[str, Any]:
    """Run final comparison and optionally update the champion pointer.

    ``confirm=False`` is a dry-run. ``confirm=True`` may mutate
    model_artifact_registry and model_champion_pointers, but it still does not
    change D1 champion pointers or live serving ownership.
    """
    artifact = next((row for row in registry_rows if str(row.get("artifact_id")) == artifact_id), None)
    if not artifact:
        return {
            "status": "not_found",
            "artifact_id": artifact_id,
            "error": "artifact_id not found in model_artifact_registry",
        }

    candidate_type = str(artifact.get("candidate_type") or "unknown")
    if candidate_type not in {"manual_hotfix", "timesfm_l175_l2_feature_release"}:
        return {
            "status": "unsupported_candidate_type",
            "artifact_id": artifact_id,
            "candidate_type": candidate_type,
            "error": "Canonical OOF artifacts require the Active8 atomic ensemble bundle controller; only explicit hotfix and TimesFM feature releases are executable here.",
        }

    model_name = str(artifact.get("model_name") or "")
    pointer_by_model = {str(row.get("model_name")): row for row in d1_pointers if row.get("model_name")}
    pointer = pointer_by_model.get(model_name)
    champion_version = (
        str(pointer.get("champion_version"))
        if pointer and pointer.get("champion_version")
        else None
    )
    if pointer and pointer.get("champion_artifact_id") == artifact_id and str(pointer.get("champion_version") or "") == str(artifact.get("version") or ""):
        return {
            "status": "already_promoted",
            "source_of_truth": "model_artifact_registry",
            "promotion_owner": "promotion-controller",
            "artifact_id": artifact_id,
            "model_name": model_name,
            "candidate_version": artifact.get("version"),
            "decision": "already_production_pointer",
            "can_promote": False,
            "approval_required": False,
            "target_state": artifact.get("state") or "production",
            "approval_state": artifact.get("approval_state") or "approved",
            "final_compared_to": champion_version,
            "next_action": "Candidate is already the exact D1 champion pointer; serving readers consume it directly.",
            "errors": [],
            "serving_reader": "model_champion_pointers/model_artifact_registry",
            "note": "Idempotent promotion-controller guard prevented rollback overwrite.",
        }
    champion_artifact = next(
        (
            row
            for row in registry_rows
            if str(row.get("model_name") or "") == model_name
            and str(row.get("version") or "") == str(champion_version or "")
        ),
        None,
    )
    cohort_blockers = feature_release_cohort_blockers(artifact, registry_rows)
    if str(artifact.get("candidate_type") or "") == "timesfm_l175_l2_feature_release":
        cohort_blockers.append({
            "code": "feature_release_requires_atomic_bundle_controller",
            "label": "A feature-era release cannot promote one model at a time",
            "next_action": "Use the feature release bundle controller for the complete training run.",
            "severity": "blocker",
        })
    decision = _promotion_row_decision(
        artifact=artifact,
        pointer=pointer,
        champion_version=champion_version,
        approved=approved,
        manual_override=manual_override,
        champion_artifact=champion_artifact,
        cohort_blockers=cohort_blockers,
    )
    evidence = {
        **decision["evidence"],
        "approved_by": approved_by,
        "reason": reason,
        "confirmed": bool(confirm),
    }

    if not confirm:
        return {
            "status": "dry_run",
            "source_of_truth": "model_artifact_registry",
            "promotion_owner": "promotion-controller",
            "artifact_id": artifact_id,
            "model_name": model_name,
            "candidate_version": artifact.get("version"),
            **decision,
        }

    now = _now_iso()
    errors: list[str] = []
    try:
        d1_client.execute(
            """
            UPDATE model_artifact_registry
            SET state = ?,
                final_compared_to = ?,
                promotion_decision = ?,
                approval_state = ?,
                live_evidence_json = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE artifact_id = ?
            """,
            [
                decision["target_state"],
                decision["final_compared_to"],
                decision["decision"],
                decision["approval_state"],
                _json_dumps({**_json_loads(artifact.get("live_evidence_json")), "promotion_controller": evidence}),
                artifact_id,
            ],
        )
    except Exception as exc:  # noqa: BLE001
        errors.append(f"artifact_update:{exc}")

    if decision["can_promote"]:
        old_artifact_id = pointer.get("champion_artifact_id") if pointer else None
        try:
            d1_client.execute(
                """
                UPDATE model_artifact_registry
                SET state = 'archived',
                    promotion_decision = 'replaced_by_new_champion',
                    updated_at = CURRENT_TIMESTAMP
                WHERE model_name = ?
                  AND state = 'production'
                  AND artifact_id != ?
                """,
                [model_name, artifact_id],
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"archive_old_production:{exc}")
        try:
            d1_client.execute(
                """
                INSERT INTO model_champion_pointers (
                  model_name, champion_version, champion_artifact_id,
                  rollback_version, rollback_artifact_id, promoted_at,
                  promotion_reason, promotion_evidence_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(model_name) DO UPDATE SET
                  champion_version = excluded.champion_version,
                  champion_artifact_id = excluded.champion_artifact_id,
                  rollback_version = excluded.rollback_version,
                  rollback_artifact_id = excluded.rollback_artifact_id,
                  promoted_at = CURRENT_TIMESTAMP,
                  promotion_reason = excluded.promotion_reason,
                  promotion_evidence_json = excluded.promotion_evidence_json,
                  updated_at = CURRENT_TIMESTAMP
                """,
                [
                    model_name,
                    artifact.get("version"),
                    artifact_id,
                    champion_version,
                    old_artifact_id,
                    reason,
                    _json_dumps(evidence),
                ],
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"champion_pointer_update:{exc}")
        if not any(error.startswith("champion_pointer_update:") for error in errors):
            try:
                d1_client.execute(
                    """
                    UPDATE model_champion_history
                    SET retired_at = ?
                    WHERE model_name = ? AND retired_at IS NULL
                    """,
                    [now, model_name],
                )
                d1_client.execute(
                    """
                    INSERT INTO model_champion_history (
                      event_id, model_name, version, artifact_id, effective_at,
                      retired_at, source, evidence_grade, evidence_json
                    ) VALUES (?, ?, ?, ?, ?, NULL, 'model_champion_history', 'exact', ?)
                    ON CONFLICT(model_name, version, effective_at) DO NOTHING
                    """,
                    [
                        f"champion:{model_name}:{artifact.get('version')}:{now}",
                        model_name,
                        artifact.get("version"),
                        artifact_id,
                        now,
                        _json_dumps(evidence),
                    ],
                )
            except Exception as exc:  # noqa: BLE001 - lineage history is part of promotion closure.
                errors.append(f"champion_history_update:{exc}")

    return {
        "status": "blocked" if not decision["can_promote"] else "ok" if not errors else "partial_error",
        "source_of_truth": "model_artifact_registry",
        "promotion_owner": "promotion-controller",
        "artifact_id": artifact_id,
        "model_name": model_name,
        "candidate_version": artifact.get("version"),
        "confirmed_at": now,
        **decision,
        "errors": errors,
        "serving_reader": "model_champion_pointers/model_artifact_registry",
        "note": "Champion pointer updated only when can_promote=true; serving readers consume the exact D1 identity.",
    }


def run_feature_release_promotion_controller(
    *,
    training_run_id: str,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    confirm: bool = False,
    approved: bool = False,
    approved_by: str | None = None,
    reason: str = "feature_release_bundle_controller",
) -> dict[str, Any]:
    """Promote one complete TimesFM L175 feature cohort as one D1 batch."""
    artifacts_by_model = {
        str(row.get("model_name") or ""): row
        for row in registry_rows
        if str(row.get("candidate_type") or "") == "timesfm_l175_l2_feature_release"
        and str(row.get("training_run_id") or "") == str(training_run_id or "")
        and str(row.get("model_name") or "") in TIMESFM_L175_RELEASE_COHORT
    }
    missing = sorted(TIMESFM_L175_RELEASE_COHORT - set(artifacts_by_model))
    if missing:
        return {
            "status": "blocked",
            "decision": "feature_release_cohort_incomplete",
            "can_promote": False,
            "training_run_id": training_run_id,
            "missing_models": missing,
        }

    pointer_by_model = {str(row.get("model_name") or ""): row for row in d1_pointers}
    cohort_rows = list(artifacts_by_model.values())
    shared_blockers = feature_release_cohort_blockers(cohort_rows[0], registry_rows)
    decisions: dict[str, dict[str, Any]] = {}
    evidences: dict[str, dict[str, Any]] = {}
    for model_name in sorted(TIMESFM_L175_RELEASE_COHORT):
        artifact = artifacts_by_model[model_name]
        pointer = pointer_by_model.get(model_name)
        champion_version = (
            str(pointer.get("champion_version"))
            if pointer and pointer.get("champion_version")
            else None
        )
        decision = _promotion_row_decision(
            artifact=artifact,
            pointer=pointer,
            champion_version=champion_version,
            approved=approved,
            cohort_blockers=shared_blockers,
        )
        decisions[model_name] = decision
        evidences[model_name] = {
            **decision["evidence"],
            "approved_by": approved_by,
            "reason": reason,
            "confirmed": bool(confirm),
            "atomic_release_training_run_id": training_run_id,
        }

    blocked = {
        model_name: decision.get("evidence", {}).get("blockers", [])
        for model_name, decision in decisions.items()
        if decision.get("can_promote") is not True
    }
    if blocked:
        return {
            "status": "dry_run" if not confirm else "blocked",
            "decision": "blocked",
            "can_promote": False,
            "training_run_id": training_run_id,
            "approved": approved,
            "blocked_models": blocked,
            "model_decisions": decisions,
        }
    if not confirm:
        return {
            "status": "dry_run",
            "decision": "promote_atomic_feature_release",
            "can_promote": True,
            "training_run_id": training_run_id,
            "release_models": sorted(artifacts_by_model),
            "model_decisions": decisions,
        }

    promotion_time = _now_iso()
    statements: list[tuple[str, list[Any]]] = []
    for model_name in sorted(TIMESFM_L175_RELEASE_COHORT):
        artifact = artifacts_by_model[model_name]
        pointer = pointer_by_model.get(model_name)
        decision = decisions[model_name]
        evidence = evidences[model_name]
        artifact_id = str(artifact.get("artifact_id") or "")
        champion_version = decision.get("final_compared_to")
        old_artifact_id = pointer.get("champion_artifact_id") if pointer else None
        statements.extend([
            (
                """
                UPDATE model_artifact_registry
                SET state = ?, final_compared_to = ?, promotion_decision = ?,
                    approval_state = ?, live_evidence_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE artifact_id = ?
                """,
                [
                    decision["target_state"],
                    champion_version,
                    "atomic_feature_release_promote",
                    decision["approval_state"],
                    _json_dumps({
                        **_json_loads(artifact.get("live_evidence_json")),
                        "promotion_controller": evidence,
                    }),
                    artifact_id,
                ],
            ),
            (
                """
                UPDATE model_artifact_registry
                SET state = 'archived', promotion_decision = 'replaced_by_atomic_feature_release',
                    updated_at = CURRENT_TIMESTAMP
                WHERE model_name = ? AND state = 'production' AND artifact_id != ?
                """,
                [model_name, artifact_id],
            ),
            (
                """
                INSERT INTO model_champion_pointers (
                  model_name, champion_version, champion_artifact_id,
                  rollback_version, rollback_artifact_id, promoted_at,
                  promotion_reason, promotion_evidence_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(model_name) DO UPDATE SET
                  champion_version = excluded.champion_version,
                  champion_artifact_id = excluded.champion_artifact_id,
                  rollback_version = excluded.rollback_version,
                  rollback_artifact_id = excluded.rollback_artifact_id,
                  promoted_at = CURRENT_TIMESTAMP,
                  promotion_reason = excluded.promotion_reason,
                  promotion_evidence_json = excluded.promotion_evidence_json,
                  updated_at = CURRENT_TIMESTAMP
                """,
                [
                    model_name,
                    artifact.get("version"),
                    artifact_id,
                    champion_version,
                    old_artifact_id,
                    reason,
                    _json_dumps(evidence),
                ],
            ),
            (
                """
                UPDATE model_champion_history
                SET retired_at = ?
                WHERE model_name = ? AND retired_at IS NULL
                """,
                [promotion_time, model_name],
            ),
            (
                """
                INSERT INTO model_champion_history (
                  event_id, model_name, version, artifact_id, effective_at,
                  retired_at, source, evidence_grade, evidence_json
                ) VALUES (?, ?, ?, ?, ?, NULL, 'model_champion_history', 'exact', ?)
                ON CONFLICT(model_name, version, effective_at) DO NOTHING
                """,
                [
                    f"champion:{model_name}:{artifact.get('version')}:{training_run_id}",
                    model_name,
                    artifact.get("version"),
                    artifact_id,
                    promotion_time,
                    _json_dumps(evidence),
                ],
            ),
        ])

    batch_result = d1_client.atomic_batch_execute(statements, timeout=60.0)
    now = promotion_time
    return {
        "status": "ok",
        "decision": "promoted_atomic_feature_release",
        "can_promote": True,
        "training_run_id": training_run_id,
        "release_models": sorted(artifacts_by_model),
        "artifacts": [artifacts_by_model[name] for name in sorted(artifacts_by_model)],
        "confirmed_at": now,
        "d1_batch": batch_result,
        "model_decisions": decisions,
        "serving_reader": "model_champion_pointers/model_artifact_registry",
    }

ACTIVE8_ENSEMBLE_ARTIFACT_SCHEMA = "active8-oof-ensemble-serving-artifact-v1"


def _canonical_payload_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def list_active8_ensemble_artifacts(*, training_run_id: str | None = None) -> list[dict[str, Any]]:
    if training_run_id:
        return d1_client.query(
            "SELECT * FROM active8_ensemble_artifacts_v1 WHERE training_run_id=? ORDER BY updated_at DESC",
            [training_run_id],
        )
    return d1_client.query("SELECT * FROM active8_ensemble_artifacts_v1 ORDER BY updated_at DESC LIMIT 100")


def _validated_active8_ensemble_payload(row: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(str(row.get("payload_json") or ""))
    except json.JSONDecodeError as exc:
        raise ValueError("active8_ensemble_candidate_payload_invalid") from exc
    if not isinstance(payload, dict):
        raise ValueError("active8_ensemble_candidate_payload_not_object")
    unsigned = {key: value for key, value in payload.items() if key != "payload_checksum"}
    checksum = hashlib.sha256(_canonical_payload_json(unsigned).encode("utf-8")).hexdigest()
    validation = payload.get("validation") if isinstance(payload.get("validation"), dict) else {}
    if (
        payload.get("schema_version") != ACTIVE8_ENSEMBLE_ARTIFACT_SCHEMA
        or checksum != str(payload.get("payload_checksum") or "")
        or checksum != str(row.get("payload_checksum") or "")
        or validation.get("decision") != "PASS"
        or validation.get("failed_gates")
        or str(row.get("validation_decision") or "") != "PASS"
        or str(row.get("state") or "") not in {"candidate", "production"}
    ):
        raise ValueError("active8_ensemble_candidate_not_promotion_grade")
    return payload


def _active8_base_artifact_blocker(
    model_name: str,
    row: dict[str, Any],
    expected: dict[str, Any],
) -> str | None:
    offline = _json_loads(row.get("offline_evidence_json"))
    registration = _json_loads(offline.get("registration"))
    oof = _json_loads(registration.get("oof_promotion_evidence"))
    actual_identity = {
        "artifact_id": str(row.get("artifact_id") or ""),
        "version": str(row.get("version") or ""),
        "checksum": str(row.get("checksum") or "").lower(),
        "candidate_type": str(row.get("candidate_type") or ""),
    }
    expected_identity = {
        "artifact_id": str(expected.get("artifact_id") or ""),
        "version": str(expected.get("version") or ""),
        "checksum": str(expected.get("checksum") or "").lower(),
        "candidate_type": str(expected.get("candidate_type") or ""),
    }
    valid = (
        actual_identity == expected_identity
        and bool(str(row.get("artifact_path") or ""))
        and bool(str(row.get("metadata_path") or ""))
        and oof.get("schema_version") == "model-cpcv-evidence-v1"
        and oof.get("method") == "outer_purged_walk_forward_rank_ic"
        and int(oof.get("folds") or 0) >= 5
        and str(row.get("state") or "") not in {"registration_failed", "rejected"}
    )
    return None if valid else f"base_artifact_contract:{model_name}"


def run_active8_ensemble_bundle_promotion_controller(
    *,
    training_run_id: str,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    ensemble_rows: list[dict[str, Any]] | None = None,
    confirm: bool = False,
    reason: str = "active8_ensemble_atomic_bundle",
) -> dict[str, Any]:
    """Atomically switch eight base artifacts and their learned ensemble owner."""
    expected_models = set(ACTIVE8_MODEL_NAMES)
    base_rows = [
        row for row in registry_rows
        if str(row.get("candidate_type") or "") == "oof_full_fit_release"
        and str(row.get("training_run_id") or "") == str(training_run_id or "")
        and str(row.get("model_name") or "") in expected_models
    ]
    by_model: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for row in base_rows:
        name = str(row.get("model_name") or "")
        if name in by_model:
            duplicates.append(name)
        by_model[name] = row
    missing = sorted(expected_models - set(by_model))
    if missing or duplicates:
        return {
            "status": "blocked", "decision": "active8_bundle_incomplete", "can_promote": False,
            "training_run_id": training_run_id, "missing_models": missing,
            "duplicate_models": sorted(set(duplicates)),
        }
    candidates = ensemble_rows if ensemble_rows is not None else list_active8_ensemble_artifacts(training_run_id=training_run_id)
    candidates = [row for row in candidates if str(row.get("training_run_id") or "") == training_run_id]
    if len(candidates) != 1:
        return {
            "status": "blocked", "decision": "active8_ensemble_candidate_cardinality", "can_promote": False,
            "training_run_id": training_run_id, "ensemble_candidate_count": len(candidates),
        }
    ensemble_row = candidates[0]
    try:
        ensemble_payload = _validated_active8_ensemble_payload(ensemble_row)
    except ValueError as exc:
        return {"status": "blocked", "decision": str(exc), "can_promote": False, "training_run_id": training_run_id}
    expected_base = ensemble_payload.get("base_artifacts") if isinstance(ensemble_payload.get("base_artifacts"), dict) else {}
    blockers = [
        blocker for model_name in sorted(expected_models)
        if (blocker := _active8_base_artifact_blocker(model_name, by_model[model_name], expected_base.get(model_name) or {}))
    ]
    if blockers:
        return {
            "status": "blocked", "decision": "active8_bundle_contract_invalid", "can_promote": False,
            "training_run_id": training_run_id, "blockers": blockers,
        }
    if not confirm:
        return {
            "status": "dry_run", "decision": "promote_active8_ensemble_atomic_bundle", "can_promote": True,
            "training_run_id": training_run_id, "release_models": sorted(expected_models),
            "ensemble_artifact_id": ensemble_row.get("artifact_id"), "validation": ensemble_payload.get("validation"),
        }

    pointer_by_model = {str(row.get("model_name") or ""): row for row in d1_pointers}
    promoted_at = _now_iso()
    evidence = {
        "schema_version": "active8-ensemble-atomic-promotion-evidence-v1",
        "training_run_id": training_run_id,
        "ensemble_artifact_id": ensemble_row.get("artifact_id"),
        "ensemble_payload_checksum": ensemble_row.get("payload_checksum"),
        "base_artifact_set_checksum": ensemble_row.get("base_artifact_set_checksum"),
        "validation": ensemble_payload.get("validation"),
        "reason": reason,
    }
    pointer_sql = """
        INSERT INTO model_champion_pointers (
          model_name, champion_version, champion_artifact_id, rollback_version,
          rollback_artifact_id, promoted_at, promotion_reason, promotion_evidence_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(model_name) DO UPDATE SET
          champion_version=excluded.champion_version,
          champion_artifact_id=excluded.champion_artifact_id,
          rollback_version=excluded.rollback_version,
          rollback_artifact_id=excluded.rollback_artifact_id,
          promoted_at=CURRENT_TIMESTAMP, promotion_reason=excluded.promotion_reason,
          promotion_evidence_json=excluded.promotion_evidence_json, updated_at=CURRENT_TIMESTAMP
    """
    history_sql = """
        INSERT INTO model_champion_history (
          event_id, model_name, version, artifact_id, effective_at,
          retired_at, source, evidence_grade, evidence_json
        ) VALUES (?, ?, ?, ?, ?, NULL, 'model_champion_history', 'exact', ?)
        ON CONFLICT(model_name, version, effective_at) DO NOTHING
    """
    statements: list[tuple[str, list[Any]]] = []
    for model_name in sorted(expected_models):
        artifact = by_model[model_name]
        pointer = pointer_by_model.get(model_name) or {}
        artifact_id = str(artifact.get("artifact_id") or "")
        statements.extend([
            ("UPDATE model_artifact_registry SET state='archived', promotion_decision='replaced_by_active8_bundle', updated_at=CURRENT_TIMESTAMP WHERE model_name=? AND state='production' AND artifact_id != ?", [model_name, artifact_id]),
            ("UPDATE model_artifact_registry SET state='production', promotion_decision='active8_bundle_promoted', approval_state='not_required', updated_at=CURRENT_TIMESTAMP WHERE artifact_id=? AND training_run_id=?", [artifact_id, training_run_id]),
            (pointer_sql, [model_name, artifact.get("version"), artifact_id, pointer.get("champion_version"), pointer.get("champion_artifact_id"), reason, _json_dumps(evidence)]),
            ("UPDATE model_champion_history SET retired_at=? WHERE model_name=? AND retired_at IS NULL", [promoted_at, model_name]),
            (history_sql, [f"champion:{model_name}:{artifact.get('version')}:{training_run_id}", model_name, artifact.get("version"), artifact_id, promoted_at, _json_dumps(evidence)]),
        ])
    ensemble_artifact_id = str(ensemble_row.get("artifact_id") or "")
    ensemble_pointer_sql = """
        INSERT INTO active8_ensemble_pointer_v1 (
          singleton_id, artifact_id, cohort_id, payload_checksum,
          base_artifact_set_checksum, promoted_at, promotion_reason, promotion_evidence_json
        ) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          artifact_id=excluded.artifact_id, cohort_id=excluded.cohort_id,
          payload_checksum=excluded.payload_checksum,
          base_artifact_set_checksum=excluded.base_artifact_set_checksum,
          promoted_at=CURRENT_TIMESTAMP, promotion_reason=excluded.promotion_reason,
          promotion_evidence_json=excluded.promotion_evidence_json
    """
    statements.extend([
        ("UPDATE active8_ensemble_artifacts_v1 SET state='archived', production_effect=0, updated_at=CURRENT_TIMESTAMP WHERE state='production' AND artifact_id != ?", [ensemble_artifact_id]),
        ("UPDATE active8_ensemble_artifacts_v1 SET state='production', production_effect=1, updated_at=CURRENT_TIMESTAMP WHERE artifact_id=? AND training_run_id=? AND state IN ('candidate','production')", [ensemble_artifact_id, training_run_id]),
        (ensemble_pointer_sql, [ensemble_artifact_id, ensemble_row.get("cohort_id"), ensemble_row.get("payload_checksum"), ensemble_row.get("base_artifact_set_checksum"), reason, _json_dumps(evidence)]),
    ])
    batch_result = d1_client.atomic_batch_execute(statements, timeout=60.0)
    placeholders = ",".join("?" for _ in expected_models)
    base_readback = d1_client.query(
        f"""
        SELECT p.model_name, p.champion_artifact_id, r.training_run_id, r.state
          FROM model_champion_pointers AS p
          JOIN model_artifact_registry AS r ON r.artifact_id = p.champion_artifact_id
         WHERE p.model_name IN ({placeholders})
        """,
        sorted(expected_models),
    )
    readback_by_model = {str(row.get("model_name") or ""): row for row in base_readback}
    base_mismatches = [
        model_name for model_name in sorted(expected_models)
        if str((readback_by_model.get(model_name) or {}).get("champion_artifact_id") or "")
        != str(by_model[model_name].get("artifact_id") or "")
        or str((readback_by_model.get(model_name) or {}).get("training_run_id") or "") != training_run_id
        or str((readback_by_model.get(model_name) or {}).get("state") or "") != "production"
    ]
    ensemble_readback = d1_client.query(
        """
        SELECT p.artifact_id, p.payload_checksum, p.base_artifact_set_checksum,
               a.training_run_id, a.state, a.production_effect
          FROM active8_ensemble_pointer_v1 AS p
          JOIN active8_ensemble_artifacts_v1 AS a ON a.artifact_id = p.artifact_id
         WHERE p.singleton_id = 1
        """
    )
    ensemble_ok = (
        len(ensemble_readback) == 1
        and str(ensemble_readback[0].get("artifact_id") or "") == ensemble_artifact_id
        and str(ensemble_readback[0].get("training_run_id") or "") == training_run_id
        and str(ensemble_readback[0].get("state") or "") == "production"
        and int(ensemble_readback[0].get("production_effect") or 0) == 1
        and str(ensemble_readback[0].get("payload_checksum") or "") == str(ensemble_row.get("payload_checksum") or "")
        and str(ensemble_readback[0].get("base_artifact_set_checksum") or "") == str(ensemble_row.get("base_artifact_set_checksum") or "")
    )
    if base_mismatches or not ensemble_ok:
        raise RuntimeError(
            "active8_bundle_atomic_readback_mismatch:" + ",".join(base_mismatches)
        )
    return {
        "status": "ok", "decision": "promoted_active8_ensemble_atomic_bundle", "can_promote": True,
        "training_run_id": training_run_id, "release_models": sorted(expected_models),
        "artifacts": [by_model[name] for name in sorted(expected_models)],
        "ensemble_artifact_id": ensemble_artifact_id, "d1_batch": batch_result,
        "readback_verified": True,
        "confirmed_at": promoted_at, "serving_reader": "model_champion_pointers+active8_ensemble_pointer_v1",
    }