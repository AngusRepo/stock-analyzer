from __future__ import annotations

import json
import math
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Callable, Literal

from services import d1_client
from services.evidence_contracts import LABEL_SCHEMA_VERSION
from services.model_validation_policy import resolve_model_validation_policy

CandidateType = Literal[
    "monthly_release",
    "weekly_drift",
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
ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION = "active8-family-feature-contract-v3"
ACTIVE8_TARGET_SEMANTIC_VERSION = LABEL_SCHEMA_VERSION
TIMESFM_L175_RELEASE_COHORT = frozenset({"LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"})
PROMOTION_GRADE_SEQUENCE_METHODS = frozenset({
    "purged_cpcv_sequence_rank_ic",
    "purged_walk_forward_retrain_rank_ic",
})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


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


def _latest_validation_bundle() -> dict[str, Any]:
    """Read the latest global validation rows and expose them to artifacts.

    Root cause for UI N/A: PBO/MC rows exist in D1, but model artifacts only
    carried callback CPCV evidence. This read-time bundle keeps candidate rows
    immutable while making promotion blockers and UI evidence fail-visible.
    """
    try:
        pbo_rows = d1_client.query(
            """
            SELECT *
            FROM pbo_results
            ORDER BY run_date DESC, created_at DESC
            LIMIT 1
            """,
            [],
        )
    except Exception:  # noqa: BLE001 - validation visibility must degrade, not break model-pool reads.
        pbo_rows = []
    try:
        mc_rows = d1_client.query(
            """
            SELECT *
            FROM monte_carlo_results
            ORDER BY run_date DESC, created_at DESC
            LIMIT 1
            """,
            [],
        )
    except Exception:  # noqa: BLE001
        mc_rows = []
    try:
        backtest_rows = d1_client.query(
            """
            SELECT *
            FROM backtest_results
            ORDER BY run_date DESC, created_at DESC
            LIMIT 1
            """,
            [],
        )
    except Exception:  # noqa: BLE001
        backtest_rows = []

    pbo = dict(pbo_rows[0]) if pbo_rows else None
    if pbo:
        raw_details = _json_loads(pbo.get("raw_details"))
        if raw_details:
            pbo["raw_details"] = raw_details
            pbo["method"] = pbo.get("method") or raw_details.get("method")

    monte_carlo = dict(mc_rows[0]) if mc_rows else None
    if monte_carlo:
        raw_details = _json_loads(monte_carlo.get("raw_details"))
        if raw_details:
            monte_carlo["raw_details"] = raw_details

    backtest = dict(backtest_rows[0]) if backtest_rows else None
    dsr = None
    if backtest:
        try:
            from services.validation_governance import deflated_sharpe_evidence

            dsr = deflated_sharpe_evidence(backtest)
        except Exception as exc:  # noqa: BLE001
            dsr = {
                "status": "FAIL",
                "passed": False,
                "method": "deflated_sharpe_unavailable",
                "reason": str(exc),
            }

    return {
        "scope": "latest_global_weekly_validation",
        "root_cause": "artifact_registry_missing_validation_pointer",
        "pbo": pbo,
        "monte_carlo": monte_carlo,
        "deflated_sharpe": dsr,
        "backtest": backtest,
    }


def _attach_validation_bundle(row: dict[str, Any], bundle: dict[str, Any]) -> None:
    offline = _json_loads(row.get("offline_evidence_json"))
    packet = offline.get("validation_packet") if isinstance(offline.get("validation_packet"), dict) else {}
    changed = False
    for key in ("pbo", "monte_carlo", "deflated_sharpe"):
        value = bundle.get(key)
        if value and key not in offline:
            offline[key] = value
            changed = True
        if value and key not in packet:
            packet[key] = value
            changed = True
    if changed:
        packet["scope"] = bundle.get("scope")
        packet["root_cause"] = bundle.get("root_cause")
        if bundle.get("backtest"):
            packet["backtest"] = {
                "run_date": bundle["backtest"].get("run_date"),
                "strategy": bundle["backtest"].get("strategy"),
                "sharpe": bundle["backtest"].get("sharpe"),
                "max_drawdown": bundle["backtest"].get("max_drawdown"),
                "total_trades": bundle["backtest"].get("total_trades"),
            }
        offline["validation_packet"] = packet
        row["offline_evidence_json"] = offline


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def candidate_type_from_retrain(*, is_monthly: bool | None, explicit: str | None = None) -> CandidateType:
    if explicit in {
        "monthly_release",
        "weekly_drift",
        "manual_hotfix",
        "model_family_shadow",
        "research_benchmark",
        "timesfm_l175_l2_feature_release",
    }:
        return explicit  # type: ignore[return-value]
    if is_monthly is True:
        return "monthly_release"
    if is_monthly is False:
        return "weekly_drift"
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
    pool_update = _nested_dict(raw_result.get("pool_update"))

    version = (
        raw_result.get("version")
        or metadata.get("version")
        or pool_update.get("new_version")
        or payload_dict.get("candidate_version")
    )
    if not version:
        return None
    version = str(version)

    artifact_path = (
        raw_result.get("artifact_path")
        or raw_result.get("gcs_path")
        or saved.get("weights_path")
        or metadata.get("artifact_path")
        or pool_update.get("artifact_path")
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
    promoted_to_active = bool(pool_update and str(pool_update.get("new_version") or "") == version)

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
            or pool_update.get("old_version")
        ),
        "artifact_lifecycle_result": raw_result,
        "artifact_lifecycle_target": model_name,
        "artifact_lifecycle_promoted_to_active": promoted_to_active,
        "production_cutover_source": "artifact_lifecycle" if promoted_to_active else None,
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
    if owns_oof_lifecycle:
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
    promotion_requested = bool(raw_registration.get("artifact_lifecycle_promoted_to_active"))
    pool_update = _nested_dict(raw_registration.get("artifact_lifecycle_result")).get("pool_update")
    artifact_id = f"{model_name}:{record_version}:{candidate_type}"
    offline_gate_passed = offline_gate["decision"] != "FAIL"
    promoted_to_active = promotion_requested and offline_gate_passed
    promotion_blocked_by_offline_gate = promotion_requested and not promoted_to_active
    offline_feature_release_candidate_type = candidate_type in {"monthly_release", "timesfm_l175_l2_feature_release"}
    eligible_pending_approval = (
        not promoted_to_active
        and offline_feature_release_candidate_type
        and offline_gate["decision"] in {"PASS", "STRONG_PASS"}
    )
    state = "production" if promoted_to_active else offline_gate["state"]
    promotion_decision = (
        "current_production"
        if promoted_to_active
        else "blocked_offline_gate_failed"
        if promotion_blocked_by_offline_gate or (offline_feature_release_candidate_type and not offline_gate_passed)
        else "eligible_pending_approval"
        if eligible_pending_approval
        else "not_evaluated"
    )
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
        "artifact_path": raw_registration.get("gcs_path") or model_artifact_path(model_name, record_version),
        "metadata_path": raw_registration.get("metadata_path") or model_metadata_path(model_name, record_version),
        "training_run_id": (
            lifecycle_run_id
            if owns_oof_lifecycle
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
        "is_monthly": 1 if payload_dict.get("is_monthly") else 0,
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
            "pool_update": pool_update if isinstance(pool_update, dict) else None,
            "production_cutover_source": raw_registration.get("production_cutover_source") if promoted_to_active else None,
            "artifact_lifecycle_promoted_to_active_requested": promotion_requested,
            "artifact_lifecycle_promoted_to_active_effective": promoted_to_active,
            "artifact_lifecycle_promotion_blocked_by_offline_gate": promotion_blocked_by_offline_gate,
        }),
        "live_gate_status": "not_applicable" if promoted_to_active else "not_started",
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
    allowed_models = {
        str(model_name)
        for model_name in (payload_dict.get("promotion_allowed_models") or [])
        if str(model_name)
    }
    if allowed_models:
        registrations = {
            name: row for name, row in registrations.items() if str(name) in allowed_models
        }
        train_stage_registrations = {
            name: row for name, row in train_stage_registrations.items() if str(name) in allowed_models
        }
        lifecycle_registrations = {
            name: row for name, row in lifecycle_registrations.items() if str(name) in allowed_models
        }
    if not version or (
        (not isinstance(registrations, dict) or not registrations)
        and not train_stage_registrations
        and not lifecycle_registrations
        and not timesfm_l2_feature_release_registrations
    ):
        return []

    candidate_type = candidate_type_from_retrain(
        is_monthly=payload_dict.get("is_monthly"),
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


def upsert_artifact_record(record: dict[str, Any]) -> dict:
    return d1_client.execute(
        """
        INSERT INTO model_artifact_registry (
          artifact_id, model_name, version, candidate_type, state,
          artifact_path, metadata_path, training_run_id, training_manifest_path,
          trained_from_snapshot, evaluation_baseline_version, final_compared_to,
          feature_policy_version, checksum, source_run_date, is_monthly,
          offline_gate_status, offline_gate_decision, offline_gate_failed_gates,
          offline_evidence_json, live_gate_status, live_evidence_json,
          promotion_decision, approval_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
        ON CONFLICT(artifact_id) DO UPDATE SET
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
    validation_bundle = _latest_validation_bundle()
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
    for row in rows:
        _attach_validation_bundle(row, validation_bundle)
    return rows


def list_champion_pointers(model_name: str | None = None) -> list[dict[str, Any]]:
    """Read registry-owned champion pointers when the D1 migration is present.

    During rollout, production may still read ``model_pool.json``. A missing
    table is therefore reported as an empty pointer set instead of breaking
    Model Pool reads; the projection endpoint will make that migration gap
    explicit.
    """
    where = ""
    params: list[Any] = []
    if model_name:
        where = "WHERE model_name = ?"
        params.append(model_name)
    try:
        rows = d1_client.query(
            f"""
            SELECT *
            FROM model_champion_pointers
            {where}
            ORDER BY updated_at DESC
            """,
            params,
        )
    except RuntimeError as exc:
        if "model_champion_pointers" in str(exc).lower() and "no such table" in str(exc).lower():
            return []
        raise

    for row in rows:
        raw = row.get("promotion_evidence_json")
        if isinstance(raw, str):
            try:
                row["promotion_evidence_json"] = _json_safe(json.loads(raw))
            except json.JSONDecodeError:
                row["promotion_evidence_json"] = raw
    return rows


def build_champion_pointer_projection(
    *,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    model_pool_versions: dict[str, str],
) -> dict[str, Any]:
    """Explain the champion pointer migration state without mutating serving.

    Production must not silently switch from ``model_pool.json`` to D1 pointers.
    This projection gives UI/OBS a single contract showing whether each model
    already has a registry pointer and whether it matches the current serving
    version.
    """
    if model_pool_versions:
        models = sorted(str(name) for name in model_pool_versions.keys())
    else:
        models = sorted({
            *(str(r.get("model_name")) for r in registry_rows if r.get("model_name")),
            *(str(r.get("model_name")) for r in d1_pointers if r.get("model_name")),
        })
    pointer_by_model = {str(r.get("model_name")): r for r in d1_pointers if r.get("model_name")}
    artifacts_by_model: dict[str, list[dict[str, Any]]] = {}
    for row in registry_rows:
        name = str(row.get("model_name") or "")
        if name:
            artifacts_by_model.setdefault(name, []).append(row)

    out: dict[str, dict[str, Any]] = {}
    for model_name in models:
        pointer = pointer_by_model.get(model_name)
        serving_version = model_pool_versions.get(model_name)
        pointer_version = str(pointer.get("champion_version")) if pointer and pointer.get("champion_version") else None
        pointer_artifact_id = str(pointer.get("champion_artifact_id")) if pointer and pointer.get("champion_artifact_id") else None
        latest_production_artifact = next(
            (
                r for r in sorted(
                    artifacts_by_model.get(model_name, []),
                    key=lambda r: str(r.get("updated_at") or r.get("created_at") or ""),
                    reverse=True,
                )
                if r.get("state") == "production"
            ),
            None,
        )
        artifact_link_status = "not_linked"
        if pointer_artifact_id:
            artifact_link_status = "linked"
        elif pointer_version:
            artifact_link_status = "version_only_pointer"

        if not pointer:
            readiness = "missing_d1_pointer"
            next_action = "Backfill model_champion_pointers from current model_pool.json before enabling pointer-owned serving."
        elif serving_version and pointer_version != serving_version:
            readiness = "pointer_mismatch"
            next_action = "Do not switch serving owner; reconcile pointer with current model_pool.json champion first."
        elif pointer_version and pointer_artifact_id:
            readiness = "pointer_ready"
            next_action = "Safe for promotion-controller final comparison; serving owner migration still requires explicit deploy."
        elif pointer_version:
            readiness = "pointer_version_only"
            next_action = "Version pointer is aligned, but champion_artifact_id is missing; run production artifact backfill before treating the pointer as migration-ready."
        else:
            readiness = "pointer_invalid"
            next_action = "Pointer row exists but champion_version is empty."

        out[model_name] = {
            "serving_version": serving_version,
            "d1_pointer_version": pointer_version,
            "d1_pointer_artifact_id": pointer_artifact_id,
            "d1_pointer": pointer,
            "latest_registry_production_artifact": latest_production_artifact,
            "artifact_link_status": artifact_link_status,
            "readiness": readiness,
            "next_action": next_action,
        }

    ready = sum(1 for row in out.values() if row["readiness"] == "pointer_ready")
    return {
        "status": "ok",
        "source_of_truth": "model_pool.json",
        "target_source_of_truth": "model_champion_pointers",
        "production_reader": "model_pool.json",
        "migration_ready": bool(out) and ready == len(out),
        "ready_count": ready,
        "model_count": len(out),
        "models": out,
    }


def backfill_champion_pointers_from_model_pool(
    *,
    model_pool_versions: dict[str, str],
    registry_rows: list[dict[str, Any]],
    reason: str = "model_pool_backfill",
    create_missing_artifacts: bool = False,
) -> dict[str, Any]:
    """Populate D1 champion pointers from the current serving model_pool.json.

    This is a migration bridge, not a promotion action. It copies the current
    production truth into D1 so the promotion controller can later compare
    candidates against an explicit champion pointer.
    """
    artifact_by_model_version: dict[tuple[str, str], dict[str, Any]] = {}
    for row in registry_rows:
        model_name = str(row.get("model_name") or "")
        version = str(row.get("version") or "")
        if model_name and version:
            artifact_by_model_version[(model_name, version)] = row

    written = 0
    created_artifacts = 0
    errors: list[str] = []
    now = _now_iso()
    for model_name, champion_version in sorted(model_pool_versions.items()):
        artifact = artifact_by_model_version.get((model_name, champion_version))
        created_this_artifact = False
        if not artifact and create_missing_artifacts:
            errors.append(
                f"{model_name}:{champion_version}:artifact_backfill:"
                "verified_sha256_registry_record_required"
            )
            continue
        artifact_available = bool(
            artifact
            and str(artifact.get("checksum") or "").startswith("sha256:")
            and str(artifact.get("artifact_path") or "").strip()
        )
        if not artifact_available:
            errors.append(
                f"{model_name}:{champion_version}:artifact_backfill:"
                "verified_sha256_registry_record_required"
            )
            continue
        evidence = {
            "schema_version": "champion-pointer-backfill-v1",
            "reason": reason,
            "source": "model_pool.json",
            "backfilled_at": now,
            "registry_artifact_found": artifact_available,
            "production_artifact_available": artifact_available,
            "production_artifact_created": artifact_available,
            "created_this_backfill": created_this_artifact,
            "artifact_id": artifact.get("artifact_id") if artifact else None,
            "artifact_path": artifact.get("artifact_path") if artifact else None,
            "metadata_path": artifact.get("metadata_path") if artifact else None,
        }
        try:
            d1_client.execute(
                """
                INSERT INTO model_champion_pointers (
                  model_name, champion_version, champion_artifact_id,
                  rollback_version, rollback_artifact_id, promoted_at,
                  promotion_reason, promotion_evidence_json, updated_at
                ) VALUES (?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(model_name) DO UPDATE SET
                  champion_version = excluded.champion_version,
                  champion_artifact_id = excluded.champion_artifact_id,
                  promotion_reason = excluded.promotion_reason,
                  promotion_evidence_json = excluded.promotion_evidence_json,
                  updated_at = CURRENT_TIMESTAMP
                """,
                [
                    model_name,
                    champion_version,
                    artifact.get("artifact_id") if artifact else None,
                    reason,
                    _json_dumps(evidence),
                ],
            )
            written += 1
        except Exception as exc:  # noqa: BLE001 - report partial migration failures.
            errors.append(f"{model_name}:{champion_version}: {exc}")

    return {
        "status": "ok" if not errors else "partial_error",
        "source": "model_pool.json",
        "target": "model_champion_pointers",
        "attempted": len(model_pool_versions),
        "written": written,
        "created_artifacts": created_artifacts,
        "errors": errors,
    }


_STATE_RANK = {
    "approved": 9,
    "approval_required": 8,
    "live_gate_passed": 7,
    "shadowing": 6,
    "candidate_selected": 5,
    "offline_strong_pass": 4,
    "offline_passed": 3,
    "offline_passed_weak": 2,
    "registered": 1,
}

_WEEKLY_SELECTED_STATES = {
    "offline_strong_pass",
    "candidate_selected",
    "live_gate_passed",
    "approval_required",
    "approved",
}


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
    if _offline_monthly_release_candidate(row) or _offline_timesfm_l175_feature_release_candidate(row):
        return True
    return state in {"live_gate_passed", "approval_required", "approved", "production"} or live_status in {
        "passed",
        "multi_evidence_passed",
        "rolling_ic_passed",
    }


def _offline_monthly_release_candidate(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    return (
        str(row.get("candidate_type") or "") == "monthly_release"
        and str(row.get("offline_gate_decision") or "") in {"STRONG_PASS", "PASS"}
        and str(row.get("state") or "") in {
            "offline_passed",
            "offline_strong_pass",
            "live_gate_passed",
            "approval_required",
            "approved",
        }
    )


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


def _offline_monthly_release_blockers(blockers: list[dict[str, Any]]) -> list[dict[str, Any]]:
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


def _monthly_supersedes_weekly(monthly: dict[str, Any] | None, weekly: dict[str, Any] | None) -> bool:
    if not monthly or not weekly:
        return False
    if str(monthly.get("candidate_type") or "") != "monthly_release":
        return False
    if str(weekly.get("candidate_type") or "") != "weekly_drift":
        return False
    if not _promotion_ready(monthly):
        return False
    return _artifact_time_key(monthly) >= _artifact_time_key(weekly)


def _build_superseded_action_context(
    *,
    superseded: dict[str, Any] | None,
    superseding: dict[str, Any] | None,
    selection_slot: str,
) -> dict[str, Any]:
    return {
        "root_cause": "superseded_by_newer_monthly_release",
        "impact": "Older weekly drift evidence is retained for audit, but should not occupy approval or live-shadow decision space.",
        "next_action": "Promote or reject the newer monthly release candidate; archive the weekly hotfix after pointer readback.",
        "affected_downstream": ["promotion_controller", "artifact_registry"],
        "scheduler_dependency": ["promotion_controller"],
        "evidence_status": "superseded",
        "selection_slot": selection_slot,
        "metrics": {
            "superseded_artifact_id": (superseded or {}).get("artifact_id"),
            "superseding_artifact_id": (superseding or {}).get("artifact_id"),
        },
    }


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

    if contract_required and model_name in {"DLinear", "PatchTST", "iTransformer"}:
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
            "Keep daily predict -> verify-v2 -> model-ic-tracker running until verified rows are promotion-grade.",
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
    pbo_required = bool(pbo_policy.get("required"))
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
            "next_action": "Run daily ML predict with shadow output, then verify-v2 and model-ic-tracker.",
            "affected_downstream": ["live_gate", "promotion_controller", "artifact_diff"],
            "scheduler_dependency": ["ml-predict", "verify-v2", "model-ic-tracker"],
            "evidence_status": "offline_only",
            "selection_slot": selection_slot,
        }

    if live_status in {"shadowing_not_enough_data", "production_baseline_not_enough_data"}:
        metrics = live_decision.get("metrics") if isinstance(live_decision.get("metrics"), dict) else {}
        return {
            "root_cause": live_decision.get("root_cause") or live_status,
            "impact": "Live IC is not promotion-grade yet; UI should show candidate as shadowing, not failed.",
            "next_action": "Keep daily predict/verify/model-ic-tracker running until verified rows meet min_samples.",
            "affected_downstream": ["promotion_controller"],
            "scheduler_dependency": ["verify-v2", "model-ic-tracker"],
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
                "scheduler_dependency": ["validation_packet", "model-ic-tracker"],
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


def build_candidate_selection(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Read-only release-train selection policy.

    Monthly artifacts are the primary release train. Weekly artifacts are drift
    candidates and only become live-shadow candidates when they are strong
    offline passes. This prevents every weekly artifact from occupying a live
    gate slot.
    """
    grouped: dict[str, list[dict[str, Any]]] = {}
    suppressed: list[dict[str, Any]] = []
    for row in rows:
        model_name = str(row.get("model_name") or "unknown")
        if not is_production_artifact_model(model_name):
            suppressed.append(_non_production_artifact_suppression(row))
            continue
        grouped.setdefault(model_name, []).append(row)

    selections: dict[str, dict[str, Any]] = {}
    for model_name, items in grouped.items():
        monthly = [r for r in items if r.get("candidate_type") == "monthly_release"]
        feature_release = [r for r in items if r.get("candidate_type") == "timesfm_l175_l2_feature_release"]
        release_train = [*monthly, *feature_release]
        weekly = [r for r in items if r.get("candidate_type") == "weekly_drift"]
        active_weekly = [r for r in weekly if not _legacy_shadow_selection_row(r)]
        latest_monthly = max(release_train, key=_artifact_time_key, default=None)
        latest_active_monthly = latest_monthly if latest_monthly and not _legacy_shadow_selection_row(latest_monthly) else None
        best_monthly = latest_active_monthly
        serving_release = max(
            [r for r in release_train if r.get("state") == "production"],
            key=_artifact_time_key,
            default=None,
        )
        best_weekly = max(active_weekly, key=_candidate_rank, default=None)

        selected_monthly = (
            best_monthly
            if best_monthly and _STATE_RANK.get(str(best_monthly.get("state") or ""), 0) >= 3
            else None
        )
        selected_weekly = (
            best_weekly
            if best_weekly and str(best_weekly.get("state") or "") in _WEEKLY_SELECTED_STATES
            else None
        )
        weekly_superseded_by = None
        monthly_superseder = selected_monthly or best_monthly
        if selected_weekly and _monthly_supersedes_weekly(monthly_superseder, selected_weekly):
            weekly_superseded_by = monthly_superseder
            selected_weekly = None

        archive_candidates = [
            r.get("artifact_id")
            for r in items
            if r is not selected_monthly and r is not selected_weekly and r is not serving_release
        ]
        superseded_candidates = [
            superseded_candidate_id
            for superseded_candidate_id in [
                best_weekly.get("artifact_id") if weekly_superseded_by and best_weekly else None
            ]
            if superseded_candidate_id
        ]

        weekly_context = (
            _build_superseded_action_context(
                superseded=best_weekly,
                superseding=weekly_superseded_by,
                selection_slot="weekly_drift_candidate",
            )
            if weekly_superseded_by
            else build_artifact_action_context(
                selected_weekly,
                selection_slot="weekly_drift_candidate",
            )
        )

        selections[model_name] = {
            "monthly_release_candidate": selected_monthly,
            "weekly_drift_candidate": selected_weekly,
            "latest_monthly_release_artifact": latest_monthly,
            "serving_release_artifact": serving_release,
            "archive_candidates": archive_candidates,
            "superseded_candidates": superseded_candidates,
            "action_context": {
                "monthly_release_candidate": build_artifact_action_context(
                    selected_monthly,
                    selection_slot="monthly_release_candidate",
                ),
                "weekly_drift_candidate": weekly_context,
            },
            "policy": {
                "monthly": "select latest non-legacy active-8 direct-alpha monthly or TimesFM L1.75 feature-release artifact only if offline_passed or stronger",
                "weekly": "select only non-legacy offline_strong_pass unless a newer promotion-ready monthly release supersedes it",
                "serving_release_artifact": "latest monthly_release artifact already marked production; audit evidence only, not a candidate queue slot",
                "live_shadow_slots": {
                    "monthly": 1,
                    "weekly": 1,
                },
                "weekly_superseded_by_monthly": bool(weekly_superseded_by),
            },
        }

    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry",
        "selection_policy": "release_train_v1",
        "suppressed_count": len(suppressed),
        "suppressed": suppressed,
        "models": selections,
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
    selection = build_candidate_selection(rows)
    selected: dict[str, dict[str, Any]] = {}
    for model_name, model_selection in (selection.get("models") or {}).items():
        for key in ("monthly_release_candidate", "weekly_drift_candidate"):
            candidate = model_selection.get(key)
            if isinstance(candidate, dict) and candidate.get("artifact_id"):
                candidate_type = str(candidate.get("candidate_type") or "")
                candidate_model_name = str(candidate.get("model_name") or model_name)
                if str(candidate.get("state") or "") in {"production", "archived", "rejected"}:
                    continue
                if candidate_type not in {
                    "monthly_release",
                    "weekly_drift",
                    "model_family_shadow",
                    "timesfm_l175_l2_feature_release",
                }:
                    continue
                if not is_production_artifact_model(candidate_model_name):
                    continue
                selected[str(candidate["artifact_id"])] = candidate | {
                    "_selection_slot": key,
                    "_model_name": model_name,
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
    """Build a read-only promotion-controller queue from registry rows.

    This is intentionally not a mutator. It centralizes promotion semantics so
    UI/OBS can stop inferring next steps from scattered artifact fields.
    """
    champion_versions = champion_versions or {}
    queue: list[dict[str, Any]] = []
    artifact_by_model_version = {
        (str(row.get("model_name") or ""), str(row.get("version") or "")): row
        for row in rows
        if row.get("model_name") and row.get("version")
    }
    promotable_monthly_by_model: dict[str, dict[str, Any]] = {}
    for row in rows:
        if str(row.get("candidate_type") or "") != "monthly_release":
            continue
        model_name = str(row.get("model_name") or "")
        if not is_production_artifact_model(model_name):
            continue
        if str(row.get("state") or "") in {"archived", "rejected"}:
            continue
        if not _promotion_ready(row):
            continue
        current = promotable_monthly_by_model.get(model_name)
        if not current or _artifact_time_key(row) >= _artifact_time_key(current):
            promotable_monthly_by_model[model_name] = row

    suppressed: list[dict[str, Any]] = []
    for row in rows:
        state = str(row.get("state") or "")
        live_status = str(row.get("live_gate_status") or "")
        live_evidence_ready = live_status in {"passed", "multi_evidence_passed", "rolling_ic_passed"}
        offline_monthly_candidate = _offline_monthly_release_candidate(row) and not live_evidence_ready
        offline_timesfm_l175_candidate = _offline_timesfm_l175_feature_release_candidate(row) and not live_evidence_ready
        if state in {"production", "archived", "rejected"}:
            continue
        if (
            not offline_monthly_candidate
            and not offline_timesfm_l175_candidate
            and state not in {"live_gate_passed", "approval_required", "approved"}
            and live_status not in {
            "passed",
            "multi_evidence_passed",
            "rolling_ic_passed",
        }
        ):
            continue

        model_name = str(row.get("model_name") or "")
        champion_version = champion_versions.get(model_name)
        candidate_type = str(row.get("candidate_type") or "unknown")
        candidate_version = str(row.get("version") or "")
        if not is_production_artifact_model(model_name):
            suppressed.append(_non_production_artifact_suppression(row))
            continue
        if champion_version and candidate_version and candidate_version == champion_version:
            suppressed.append({
                "artifact_id": row.get("artifact_id"),
                "model_name": model_name,
                "candidate_version": row.get("version"),
                "candidate_type": candidate_type,
                "superseded_by": "current_champion_pointer",
                "reason": "candidate_version_already_current_champion",
            })
            continue
        superseding_monthly = promotable_monthly_by_model.get(model_name)
        if candidate_type == "weekly_drift" and _monthly_supersedes_weekly(superseding_monthly, row):
            suppressed.append({
                "artifact_id": row.get("artifact_id"),
                "model_name": model_name,
                "candidate_version": row.get("version"),
                "candidate_type": candidate_type,
                "superseded_by": superseding_monthly.get("artifact_id") if superseding_monthly else None,
                "reason": "newer_monthly_release_ready_for_promotion",
            })
            continue
        offline_decision = str(row.get("offline_gate_decision") or "")
        # Scheduled artifacts are machine-promoted only after every evidence
        # gate and champion comparison passes. Human approval is reserved for
        # an explicitly manual hotfix, not used as a substitute for evidence.
        approval_required = candidate_type == "manual_hotfix"
        blockers = artifact_promotion_blockers(row, champion_version=champion_version)
        if offline_monthly_candidate or offline_timesfm_l175_candidate:
            blockers = _offline_monthly_release_blockers(blockers)
        blocker_codes = _blocker_codes(blockers)
        champion_artifact = artifact_by_model_version.get((model_name, champion_version or ""))
        artifact_compare = _artifact_compare(
            row,
            champion_version=champion_version,
            champion_artifact=champion_artifact,
        )
        if not champion_version:
            decision = "blocked_missing_champion_pointer"
            next_action = "Resolve current champion version before final comparison."
        elif blockers:
            decision = "blocked_multi_evidence_gate"
            next_action = "Resolve blockers before final comparison: " + ", ".join(blocker_codes)
        elif offline_monthly_candidate:
            decision = "blocked_live_evidence_required"
            next_action = "Keep the candidate in shadow until live multi-evidence and final champion comparison pass."
        elif offline_timesfm_l175_candidate:
            decision = "blocked_live_evidence_required"
            next_action = "Run the complete feature cohort in shadow and collect live evidence before atomic promotion."
        elif approval_required:
            decision = "approval_required"
            next_action = "Run final comparison against current champion, then request Wei approval before promotion."
        else:
            decision = "auto_promote_candidate"
            next_action = "Run final comparison against current champion; auto-promote only if no production blocker remains."

        queue.append({
            "artifact_id": row.get("artifact_id"),
            "model_name": model_name,
            "candidate_version": row.get("version"),
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
        "suppressed_count": len(suppressed),
        "suppressed": suppressed,
        "queue": queue,
    }


def apply_promoted_artifact_to_model_pool(
    pool: dict[str, Any],
    artifact: dict[str, Any],
    *,
    reason: str,
    promoted_at: str | None = None,
) -> dict[str, Any]:
    """Move an approved registry artifact into the current serving pool.

    During the registry migration production still reads ``model_pool.json``.
    A promotion that only updates D1 pointers creates split brain, so the final
    owner must also update the serving entry until the runtime reader migrates
    fully to D1 champion pointers.
    """
    model_name = str(artifact.get("model_name") or "")
    candidate_version = str(artifact.get("version") or "")
    if not model_name or not candidate_version:
        raise ValueError("artifact must include model_name and version")
    if not is_production_artifact_model(model_name):
        raise ValueError(f"{model_name} is not eligible for production artifact promotion")

    models = pool.setdefault("models", {})
    entry = models.get(model_name)
    if not isinstance(entry, dict):
        raise KeyError(f"{model_name} missing from model_pool.json")

    promoted_at = promoted_at or _now_iso()
    old_version = entry.get("version")
    candidate_path = artifact.get("artifact_path") or model_artifact_path(model_name, candidate_version)
    challenger = entry.get("challenger") if isinstance(entry.get("challenger"), dict) else {}
    challenger_matches = str(challenger.get("version") or "") == candidate_version

    if str(old_version or "") != candidate_version:
        retired_versions = entry.setdefault("retired_versions", [])
        retired_versions.append({
            "version": old_version,
            "retired_at": promoted_at,
            "reason": reason,
            "weekly_ic_at_retire": list(entry.get("weekly_ic") or []),
            "ic_4w_avg_at_retire": entry.get("ic_4w_avg"),
        })

    entry["status"] = "active"
    entry["version"] = candidate_version
    entry["gcs_path"] = candidate_path
    entry["metadata_path"] = artifact.get("metadata_path") or entry.get("metadata_path")
    entry["serving_owner"] = "model_champion_pointers"
    entry["serving_artifact_id"] = artifact.get("artifact_id")
    entry["offline_gate_decision"] = artifact.get("offline_gate_decision")
    entry["live_gate_status"] = artifact.get("live_gate_status")
    entry["promoted_at"] = promoted_at
    entry.pop("degraded_since", None)
    entry.pop("retired_at", None)

    if challenger_matches:
        for key in (
            "weekly_ic",
            "ic_4w_avg",
            "consecutive_negative_weeks",
            "rolling_ic",
            "last_ic_status",
            "last_ic_sample_count",
            "last_ic_score_sources",
            "last_ic_by_segment",
            "last_ic_error",
            "last_ic_root_cause",
            "last_ic_diagnostics",
            "model_cpcv",
        ):
            if key in challenger:
                entry[key] = challenger[key]
        entry.pop("challenger", None)

    metadata = _nested_dict(artifact.get("metadata"))
    if not metadata:
        metadata = _artifact_registration_metadata(artifact)
    entry["target_semantic_version"] = metadata.get("target_semantic_version")
    offline_evidence = _json_loads(artifact.get("offline_evidence_json"))
    registration = _nested_dict(offline_evidence.get("registration"))
    gate = _nested_dict(offline_evidence.get("gate"))
    artifact_evidence = {
        "schema_version": "model-pool-artifact-evidence-v1",
        "source": "model_artifact_registry",
        "artifact_id": artifact.get("artifact_id"),
        "candidate_type": artifact.get("candidate_type"),
        "version": candidate_version,
        "artifact_path": candidate_path,
        "metadata_path": artifact.get("metadata_path"),
        "feature_count": metadata.get("feature_count") or registration.get("feature_count"),
        "sample_count": metadata.get("sample_count") or registration.get("sample_count"),
        "trained_at": metadata.get("trained_at"),
        "training_manifest_path": metadata.get("training_manifest_path") or artifact.get("training_manifest_path"),
        "artifact_checksum": metadata.get("artifact_checksum") or artifact.get("checksum"),
        "offline_gate_decision": artifact.get("offline_gate_decision"),
        "offline_gate_status": artifact.get("offline_gate_status"),
        "oos_ic": _nested_dict(gate.get("metrics")).get("oos_ic") or registration.get("oos_ic"),
        "model_cpcv": metadata.get("model_cpcv") or registration.get("model_cpcv"),
        "prep_lineage": metadata.get("prep_lineage"),
        "feature_policy": metadata.get("feature_policy"),
        "feature_policy_schema_version": metadata.get("feature_policy_schema_version"),
        "family_feature_contract": metadata.get("family_feature_contract"),
        "target_semantic_version": metadata.get("target_semantic_version"),
    }
    entry["last_artifact_evidence"] = {
        key: value
        for key, value in artifact_evidence.items()
        if value is not None
    }

    entry["promotion_controller"] = {
        "artifact_id": artifact.get("artifact_id"),
        "candidate_type": artifact.get("candidate_type"),
        "reason": reason,
        "promoted_at": promoted_at,
        "source": "model_artifact_registry",
    }
    pool["last_updated"] = promoted_at
    return {
        "model_name": model_name,
        "old_version": old_version,
        "new_version": candidate_version,
        "challenger_moved": challenger_matches,
    }


def run_model_pool_release_writer(
    pool: dict[str, Any],
    artifact: dict[str, Any],
    *,
    reason: str,
    promoted_at: str | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    """Build or apply the serving model_pool release update.

    Promotion controller owns the approval decision. This writer owns the
    serving JSON mutation and stays dry-run by default so a D1 pointer promotion
    cannot silently create split-brain with model_pool.json.
    """
    working_pool = pool if confirm else deepcopy(pool)
    serving_update = apply_promoted_artifact_to_model_pool(
        working_pool,
        artifact,
        reason=reason,
        promoted_at=promoted_at,
    )
    model_name = serving_update["model_name"]
    entry = (working_pool.get("models") or {}).get(model_name) or {}
    return {
        "schema_version": "model-pool-release-writer-v1",
        "source_of_truth": "model_artifact_registry",
        "serving_reader": "model_pool.json",
        "decision_effect": "write_model_pool" if confirm else "dry_run_only",
        "confirmed": bool(confirm),
        "model_pool_updated": bool(confirm),
        "can_release": True,
        "serving_update": serving_update,
        "planned_entry": entry,
        "requires_wei_approval": str(artifact.get("candidate_type") or "") == "manual_hotfix",
        "production_mutation_allowed": bool(confirm),
    }


def run_model_pool_release_bundle_writer(
    pool: dict[str, Any],
    artifacts: list[dict[str, Any]],
    *,
    reason: str,
    promoted_at: str | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    """Apply one complete feature-era cohort to one model_pool generation."""
    working_pool = pool if confirm else deepcopy(pool)
    updates = [
        apply_promoted_artifact_to_model_pool(
            working_pool,
            artifact,
            reason=reason,
            promoted_at=promoted_at,
        )
        for artifact in sorted(artifacts, key=lambda row: str(row.get("model_name") or ""))
    ]
    return {
        "schema_version": "model-pool-release-bundle-writer-v1",
        "source_of_truth": "model_artifact_registry",
        "serving_reader": "model_pool.json",
        "decision_effect": "write_model_pool_generation" if confirm else "dry_run_only",
        "confirmed": bool(confirm),
        "model_pool_updated": bool(confirm),
        "can_release": True,
        "serving_updates": updates,
        "release_models": sorted(update["model_name"] for update in updates),
        "requires_wei_approval": any(
            str(artifact.get("candidate_type") or "") == "manual_hotfix"
            for artifact in artifacts
        ),
        "production_mutation_allowed": bool(confirm),
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
    allow_offline_monthly_release: bool = False,
    cohort_blockers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Evaluate the final promotion step against the current champion pointer.

    This is the last lifecycle owner. Retrain, offline gate, and IC tracker only
    produce evidence; this function decides whether the candidate may update the
    champion pointer.
    """
    live_status = str(artifact.get("live_gate_status") or "")
    state = str(artifact.get("state") or "")
    candidate_type = str(artifact.get("candidate_type") or "unknown")
    offline_decision = str(artifact.get("offline_gate_decision") or "")
    offline_monthly_release_candidate = bool(
        allow_offline_monthly_release
        and candidate_type == "monthly_release"
        and offline_decision in {"STRONG_PASS", "PASS"}
    )
    offline_timesfm_l175_feature_release_candidate = bool(
        candidate_type == "timesfm_l175_l2_feature_release"
        and offline_decision in {"STRONG_PASS", "PASS"}
    )
    approval_required = candidate_type == "manual_hotfix"
    blockers: list[str] = []
    offline_monthly_release_cutover = offline_monthly_release_candidate and approved
    promotion_blockers = artifact_promotion_blockers(artifact, champion_version=champion_version)
    promotion_blockers.extend(cohort_blockers or [])
    manual_override_requested = bool(manual_override)
    manual_override_allowed = bool(
        manual_override_requested
        and approved
        and candidate_type in {"weekly_drift", "manual_hotfix"}
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
        and live_status not in {"passed", "multi_evidence_passed"}
    ):
        blockers.append("live_gate_not_passed")
    if not champion_version:
        blockers.append("missing_current_champion")
    if offline_decision in {"FAIL", "PBO_FAIL", "CPCV_FAIL"}:
        blockers.append("offline_gate_failed")
    blockers = list(dict.fromkeys(blockers))

    current_artifact_id = pointer.get("champion_artifact_id") if pointer else None
    live_evidence = _json_loads(artifact.get("live_evidence_json"))
    offline_evidence = _json_loads(artifact.get("offline_evidence_json"))
    evidence = {
        "schema_version": "promotion-controller-final-comparison-v1",
        "evaluated_at": _now_iso(),
        "model_name": artifact.get("model_name"),
        "candidate_artifact_id": artifact.get("artifact_id"),
        "candidate_version": artifact.get("version"),
        "candidate_type": candidate_type,
        "current_champion_version": champion_version,
        "current_champion_artifact_id": current_artifact_id,
        "offline_gate_decision": offline_decision,
        "live_gate_status": live_status,
        "live_evidence": live_evidence,
        "offline_evidence": offline_evidence,
        "approval_required": approval_required,
        "approved": approved,
        "manual_override_requested": manual_override_requested,
        "manual_override_allowed": manual_override_allowed,
        "manual_override_overridden_blockers": overridden_blockers,
        "allow_offline_monthly_release": allow_offline_monthly_release,
        "offline_monthly_release_candidate": offline_monthly_release_candidate,
        "offline_timesfm_l175_feature_release_candidate": offline_timesfm_l175_feature_release_candidate,
        "offline_monthly_release_cutover": offline_monthly_release_cutover,
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
    decision = "manual_override_promote" if manual_override_allowed else "promote"
    next_action = (
        "Update D1 champion pointer by Wei-approved manual override; keep monthly release on manual approval gate."
        if manual_override_allowed
        else "Update D1 champion pointer; serving reader migration still requires explicit deployment."
    )
    return {
        "decision": decision,
        "can_promote": True,
        "approval_required": approval_required,
        "target_state": "production",
        "approval_state": "approved" if approval_required else "not_required",
        "next_action": next_action,
        "final_compared_to": champion_version,
        "evidence": evidence,
    }


def run_promotion_controller(
    *,
    artifact_id: str,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    model_pool_versions: dict[str, str],
    confirm: bool = False,
    approved: bool = False,
    approved_by: str | None = None,
    reason: str = "promotion_controller",
    allow_offline_monthly_release: bool = False,
    manual_override: bool = False,
) -> dict[str, Any]:
    """Run final comparison and optionally update the champion pointer.

    ``confirm=False`` is a dry-run. ``confirm=True`` may mutate
    model_artifact_registry and model_champion_pointers, but it still does not
    change model_pool.json or live serving ownership.
    """
    artifact = next((row for row in registry_rows if str(row.get("artifact_id")) == artifact_id), None)
    if not artifact:
        return {
            "status": "not_found",
            "artifact_id": artifact_id,
            "error": "artifact_id not found in model_artifact_registry",
        }

    model_name = str(artifact.get("model_name") or "")
    pointer_by_model = {str(row.get("model_name")): row for row in d1_pointers if row.get("model_name")}
    pointer = pointer_by_model.get(model_name)
    champion_version = (
        str(pointer.get("champion_version"))
        if pointer and pointer.get("champion_version")
        else model_pool_versions.get(model_name)
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
            "next_action": "Candidate is already the D1 champion pointer; reconcile serving model_pool.json if projection still shows mismatch.",
            "errors": [],
            "serving_reader": "model_pool.json",
            "note": "Idempotent promotion-controller guard prevented rollback overwrite.",
        }
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
        allow_offline_monthly_release=allow_offline_monthly_release,
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
        "serving_reader": "model_pool.json",
        "note": "Champion pointer updated only when can_promote=true; model_pool.json serving migration remains explicit.",
    }


def run_feature_release_promotion_controller(
    *,
    training_run_id: str,
    registry_rows: list[dict[str, Any]],
    d1_pointers: list[dict[str, Any]],
    model_pool_versions: dict[str, str],
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
            else model_pool_versions.get(model_name)
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
        "serving_reader": "model_pool.json",
    }


def build_model_champion_history_backfill_plan(model_pool: dict[str, Any]) -> dict[str, Any]:
    """Build exact-only champion intervals from model_pool promotion evidence.

    An entry's own promoted_at is exact. For an ordered atomic transition
    chain, the previous version's retired_at is also the next version's exact
    effective_at. The oldest entry remains bounded and is excluded.
    """
    planned: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    models = model_pool.get("models") if isinstance(model_pool.get("models"), dict) else {}
    for model_name, raw_entry in sorted(models.items()):
        if model_name not in PRODUCTION_ARTIFACT_MODEL_NAMES or not isinstance(raw_entry, dict):
            continue
        retired = sorted(
            [item for item in (raw_entry.get("retired_versions") or []) if isinstance(item, dict)],
            key=lambda item: str(item.get("retired_at") or ""),
        )
        candidates: list[dict[str, Any]] = []
        previous_retired_at: str | None = None
        for item in retired:
            explicit_promoted_at = str(item.get("promoted_at") or "").strip() or None
            transition_promoted_at = previous_retired_at if previous_retired_at else None
            candidates.append({
                "version": item.get("version"),
                "artifact_id": item.get("artifact_id"),
                "promoted_at": explicit_promoted_at or transition_promoted_at,
                "retired_at": item.get("retired_at"),
                "position": "retired",
                "promotion_evidence": (
                    "explicit_promoted_at"
                    if explicit_promoted_at
                    else "previous_atomic_transition_retired_at"
                    if transition_promoted_at
                    else "bounded_oldest_entry"
                ),
            })
            previous_retired_at = str(item.get("retired_at") or "").strip() or None
        promotion_controller = (
            raw_entry.get("promotion_controller")
            if isinstance(raw_entry.get("promotion_controller"), dict)
            else {}
        )
        serving_path = str(raw_entry.get("gcs_path") or "").strip()
        promoted_path = str(promotion_controller.get("artifact_path") or "").strip()
        serving_artifact_id = str(raw_entry.get("serving_artifact_id") or "").strip()
        promoted_artifact_id = str(promotion_controller.get("artifact_id") or "").strip()
        contradictory_current_evidence = bool(
            (serving_path and promoted_path and serving_path != promoted_path)
            or (
                serving_artifact_id
                and promoted_artifact_id
                and serving_artifact_id != promoted_artifact_id
            )
        )
        candidates.append({
            "version": raw_entry.get("version"),
            "artifact_id": raw_entry.get("serving_artifact_id"),
            "promoted_at": None if contradictory_current_evidence else raw_entry.get("promoted_at"),
            "retired_at": None,
            "position": "current",
            "promotion_evidence": (
                "contradictory_current_promotion_evidence"
                if contradictory_current_evidence
                else "explicit_promoted_at"
            ),
        })
        for candidate in candidates:
            version = str(candidate.get("version") or "").strip()
            promoted_at = str(candidate.get("promoted_at") or "").strip()
            retired_at = str(candidate.get("retired_at") or "").strip() or None
            if not version:
                continue
            if not promoted_at:
                excluded.append({
                    "model_name": model_name,
                    "version": version,
                    "reason": (
                        "current_promotion_evidence_mismatch"
                        if candidate.get("promotion_evidence") == "contradictory_current_promotion_evidence"
                        else "exact_promoted_at_missing"
                    ),
                    "known_upper_bound": retired_at,
                })
                continue
            if _iso_datetime(promoted_at) is None or (retired_at and _iso_datetime(retired_at) is None):
                excluded.append({
                    "model_name": model_name,
                    "version": version,
                    "reason": "promotion_interval_timestamp_invalid",
                })
                continue
            if retired_at and _iso_datetime(promoted_at) >= _iso_datetime(retired_at):
                excluded.append({
                    "model_name": model_name,
                    "version": version,
                    "reason": "promotion_interval_not_positive",
                })
                continue
            planned.append({
                "event_id": f"champion-backfill:{model_name}:{version}:{promoted_at}",
                "model_name": model_name,
                "version": version,
                "artifact_id": candidate.get("artifact_id"),
                "effective_at": promoted_at,
                "retired_at": retired_at,
                "source": "model_champion_history",
                "evidence_grade": "exact",
                "evidence": {
                    "source": "universal/model_pool.json",
                    "position": candidate.get("position"),
                    "promotion_evidence": candidate.get("promotion_evidence"),
                    "backfill_policy": "exact_explicit_or_atomic_transition_boundary_no_oldest_interval_inference",
                },
            })

    overlaps: list[dict[str, Any]] = []
    by_model: dict[str, list[dict[str, Any]]] = {}
    for row in planned:
        by_model.setdefault(str(row["model_name"]), []).append(row)
    for model_name, rows in by_model.items():
        ordered = sorted(rows, key=lambda row: str(row["effective_at"]))
        for previous, current in zip(ordered, ordered[1:]):
            previous_end = _iso_datetime(previous.get("retired_at"))
            current_start = _iso_datetime(current.get("effective_at"))
            if previous_end is None or (current_start is not None and previous_end > current_start):
                overlaps.append({
                    "model_name": model_name,
                    "previous_version": previous.get("version"),
                    "current_version": current.get("version"),
                    "reason": "champion_intervals_overlap_or_open_before_next",
                })
    return {
        "schema_version": "model-champion-history-backfill-plan-v1",
        "status": "blocked" if overlaps else "ready",
        "exact_rows": planned,
        "exact_row_count": len(planned),
        "excluded": excluded,
        "excluded_count": len(excluded),
        "overlaps": overlaps,
        "earliest_exact_effective_at": min((str(row["effective_at"]) for row in planned), default=None),
    }


def backfill_model_champion_history_from_model_pool(
    model_pool: dict[str, Any],
    *,
    confirm: bool = False,
) -> dict[str, Any]:
    plan = build_model_champion_history_backfill_plan(model_pool)
    if not confirm or plan["status"] != "ready":
        return {**plan, "mode": "dry_run", "written": 0}
    statements = [
        (
            """
            INSERT INTO model_champion_history (
              event_id, model_name, version, artifact_id, effective_at,
              retired_at, source, evidence_grade, evidence_json
            ) VALUES (?, ?, ?, ?, ?, ?, 'model_champion_history', 'exact', ?)
            ON CONFLICT(model_name, version, effective_at) DO UPDATE SET
              artifact_id = excluded.artifact_id,
              retired_at = excluded.retired_at,
              evidence_json = excluded.evidence_json
            """,
            [
                row["event_id"],
                row["model_name"],
                row["version"],
                row.get("artifact_id"),
                row["effective_at"],
                row.get("retired_at"),
                _json_dumps(row["evidence"]),
            ],
        )
        for row in plan["exact_rows"]
    ]
    result = d1_client.atomic_batch_execute(statements, timeout=60.0) if statements else {"total": 0}
    return {
        **plan,
        "status": "ok",
        "mode": "confirmed",
        "written": len(statements),
        "d1_batch": result,
    }
