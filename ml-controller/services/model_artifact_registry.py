from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Literal

from services import d1_client
from services.model_validation_policy import resolve_model_validation_policy

CandidateType = Literal[
    "monthly_release",
    "weekly_drift",
    "manual_hotfix",
    "model_family_shadow",
    "research_benchmark",
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
    if explicit in {"monthly_release", "weekly_drift", "manual_hotfix", "model_family_shadow", "research_benchmark"}:
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
    if model_ic.get("model_cpcv") is not None:
        evidence["model_cpcv"] = model_ic.get("model_cpcv")
    elif aux_metadata.get("model_cpcv") is not None:
        evidence["model_cpcv"] = aux_metadata.get("model_cpcv")

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
    if (
        not promoted_to_active
        and model_name == "TimesFM"
        and raw_status in {"ok", "registered", ""}
        and str(raw_result.get("artifact_type") or "") == "foundation_forecast_config"
        and has_artifact
    ):
        promoted_to_active = True

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
        "training_manifest_path": payload_dict.get("training_manifest_path"),
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
        registration = _normalise_lifecycle_registration(
            payload_dict=payload_dict,
            model_name=str(model_name),
            raw_result=raw_result,
        )
        if registration is not None:
            registrations[str(model_name)] = registration
    return registrations


def _train_stage_registrations(payload_dict: dict[str, Any]) -> dict[str, dict[str, Any]]:
    version = payload_dict.get("candidate_version")
    if not version:
        return {}
    version = str(version)
    stages = _nested_dict(payload_dict.get("stages"))
    train = _nested_dict(stages.get("train"))
    ic_tracking = _nested_dict(train.get("ic_tracking"))
    registrations: dict[str, dict[str, Any]] = {}
    for model_name, raw_metrics in ic_tracking.items():
        model_name = str(model_name)
        if not is_production_artifact_model(model_name):
            continue
        metrics = _nested_dict(raw_metrics)
        model_cpcv = metrics.get("model_cpcv") if isinstance(metrics.get("model_cpcv"), dict) else None
        oos_ic = metrics.get("oos_ic") if metrics.get("oos_ic") is not None else metrics.get("ic")
        registrations[model_name] = {
            "status": "registered" if payload_dict.get("status") == "completed" else "error",
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
    if "model_cpcv" not in enriched_registration and evidence.get("model_cpcv") is not None:
        enriched_registration["model_cpcv"] = evidence["model_cpcv"]
    record_version = str(raw_registration.get("version") or payload_dict.get("candidate_version"))

    ic_summary = payload_dict.get("ic_summary") if isinstance(payload_dict.get("ic_summary"), dict) else {}
    local_ic_summary = dict(ic_summary)
    if model_name not in local_ic_summary and raw_registration.get("oos_ic") is not None:
        local_ic_summary[model_name] = raw_registration.get("oos_ic")

    offline_gate = evaluate_offline_gate(
        model_name=model_name,
        registration=enriched_registration,
        ic_summary=local_ic_summary,
    )
    promoted_to_active = bool(raw_registration.get("artifact_lifecycle_promoted_to_active"))
    pool_update = _nested_dict(raw_registration.get("artifact_lifecycle_result")).get("pool_update")
    artifact_id = f"{model_name}:{record_version}:{candidate_type}"
    state = "production" if promoted_to_active else offline_gate["state"]
    return {
        "artifact_id": artifact_id,
        "model_name": model_name,
        "version": record_version,
        "candidate_type": candidate_type,
        "state": state,
        "artifact_path": raw_registration.get("gcs_path") or model_artifact_path(model_name, record_version),
        "metadata_path": raw_registration.get("metadata_path") or model_metadata_path(model_name, record_version),
        "training_run_id": (
            raw_registration.get("training_run_id")
            or payload_dict.get("training_run_id")
            or payload_dict.get("run_id")
            or payload_dict.get("trained_at")
        ),
        "training_manifest_path": raw_registration.get("training_manifest_path") or payload_dict.get("training_manifest_path"),
        "trained_from_snapshot": (
            (payload_dict.get("stages") or {}).get("dataset_snapshot")
            if isinstance(payload_dict.get("stages"), dict)
            else None
        ),
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
            "production_cutover_source": raw_registration.get("production_cutover_source"),
        }),
        "live_gate_status": "not_applicable" if promoted_to_active else "not_started",
        "live_evidence_json": "{}",
        "promotion_decision": "current_production" if promoted_to_active else "not_evaluated",
        "approval_state": "not_required",
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


def build_artifact_records_from_retrain_followup(payload: Any) -> list[dict[str, Any]]:
    payload_dict = payload.model_dump() if hasattr(payload, "model_dump") else dict(payload)
    version = payload_dict.get("candidate_version")
    registrations = payload_dict.get("challenger_registrations") or {}
    train_stage_registrations = _train_stage_registrations(payload_dict)
    lifecycle_registrations = _lifecycle_registrations(payload_dict)
    if not version or (
        (not isinstance(registrations, dict) or not registrations)
        and not train_stage_registrations
        and not lifecycle_registrations
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
          feature_policy_version = excluded.feature_policy_version,
          checksum = excluded.checksum,
          source_run_date = excluded.source_run_date,
          is_monthly = excluded.is_monthly,
          offline_gate_status = excluded.offline_gate_status,
          offline_gate_decision = excluded.offline_gate_decision,
          offline_gate_failed_gates = excluded.offline_gate_failed_gates,
          offline_evidence_json = excluded.offline_evidence_json,
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
            artifact = {
                "artifact_id": f"{model_name}:{champion_version}:production_backfill",
                "model_name": model_name,
                "version": champion_version,
                "candidate_type": "unknown",
                "state": "production",
                "artifact_path": model_artifact_path(model_name, champion_version),
                "metadata_path": model_metadata_path(model_name, champion_version),
                "training_run_id": reason,
                "training_manifest_path": None,
                "trained_from_snapshot": None,
                "evaluation_baseline_version": None,
                "final_compared_to": champion_version,
                "feature_policy_version": None,
                "checksum": None,
                "source_run_date": None,
                "is_monthly": 0,
                "offline_gate_status": "backfilled_production",
                "offline_gate_decision": "PRODUCTION_BACKFILL",
                "offline_gate_failed_gates": "[]",
                "offline_evidence_json": _json_dumps({
                    "schema_version": "production-artifact-backfill-v1",
                    "reason": reason,
                    "source": "model_pool.json",
                    "backfilled_at": now,
                    "note": "Current serving artifact was registered to make champion_artifact_id explicit; this is not a promotion.",
                }),
                "live_gate_status": "not_applicable",
                "live_evidence_json": "{}",
                "promotion_decision": "current_production",
                "approval_state": "not_required",
                "created_at": now,
            }
            try:
                upsert_artifact_record(artifact)
                artifact_by_model_version[(model_name, champion_version)] = artifact
                created_artifacts += 1
                created_this_artifact = True
            except Exception as exc:  # noqa: BLE001 - keep pointer migration partial and visible.
                errors.append(f"{model_name}:{champion_version}:artifact_backfill:{exc}")
                artifact = None
        artifact_available = bool(artifact)
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
    return state in {"live_gate_passed", "approval_required", "approved", "production"} or live_status in {
        "passed",
        "multi_evidence_passed",
        "rolling_ic_passed",
    }


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
        "impact": "Artifact is retained for audit evidence, but cannot enter active-9 selection, live shadow, or promotion.",
        "next_action": "Archive or leave as historical evidence; use the active-9 model artifact lane for production candidates.",
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
            "Model is not in the active-9 production artifact set",
            "Keep this artifact as historical/research evidence; production promotion must use an active-9 model.",
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
            "shadow_sample_window_too_short",
            "Shadow sample window is too short",
            f"Collect at least {int(required_samples)} verified shadow rows under the active family/regime policy.",
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

    cpcv = _deep_get(offline, {"model_cpcv_decision", "cpcv_decision", "cpcv", "model_cpcv"})
    forecast_validation = _deep_get(
        offline,
        {"forecast_validation", "foundation_forecast_validation", "last_artifact_evidence"},
    )
    cpcv_owner = str(policy_bundle["cpcv"].get("owner") or "family_specific_cpcv")
    if cpcv_owner == "foundation_forecast_validation":
        if not _truthy_gate_value(forecast_validation) and not _truthy_gate_value(cpcv):
            add(
                "foundation_forecast_validation_missing",
                "Missing foundation forecast validation evidence",
                "Attach TimesFM forecast/outcome validation evidence for the selected context before final comparison.",
            )
    elif not _truthy_gate_value(cpcv):
        add(
            "cpcv_pbo_missing",
            "Missing CPCV evidence",
            "Attach family-specific CPCV evidence so rolling live IC is not treated as a one-window artifact.",
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
        weekly = [r for r in items if r.get("candidate_type") == "weekly_drift"]
        active_monthly = [r for r in monthly if not _legacy_shadow_selection_row(r)]
        active_weekly = [r for r in weekly if not _legacy_shadow_selection_row(r)]
        best_monthly = max(active_monthly, key=_candidate_rank, default=None)
        latest_monthly = max(monthly, key=_artifact_time_key, default=None)
        serving_release = max(
            [r for r in monthly if r.get("state") == "production"],
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
                "monthly": "select best non-legacy active-9 offline_passed or stronger artifact",
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
            "reason": "Selected candidate has not accumulated enough verified shadow rows.",
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
    allowed_live_shadow_models = {"ResidualMLP"}
    rows = list_artifact_registry(limit=limit)
    selection = build_candidate_selection(rows)
    selected: dict[str, dict[str, Any]] = {}
    for model_name, model_selection in (selection.get("models") or {}).items():
        for key in ("monthly_release_candidate", "weekly_drift_candidate"):
            candidate = model_selection.get(key)
            if isinstance(candidate, dict) and candidate.get("artifact_id"):
                candidate_type = str(candidate.get("candidate_type") or "")
                candidate_model_name = str(candidate.get("model_name") or model_name)
                if candidate_type != "model_family_shadow" or candidate_model_name not in allowed_live_shadow_models:
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
        if state in {"production", "archived", "rejected"}:
            continue
        if state not in {"live_gate_passed", "approval_required", "approved"} and live_status not in {
            "passed",
            "multi_evidence_passed",
            "rolling_ic_passed",
        }:
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
        approval_required = (
            candidate_type in {"weekly_drift", "manual_hotfix"}
            or str(row.get("approval_state") or "") == "required"
        )
        blockers = artifact_promotion_blockers(row, champion_version=champion_version)
        blocker_codes = _blocker_codes(blockers)
        if not champion_version:
            decision = "blocked_missing_champion_pointer"
            next_action = "Resolve current champion version before final comparison."
        elif blockers:
            decision = "blocked_multi_evidence_gate"
            next_action = "Resolve blockers before final comparison: " + ", ".join(blocker_codes)
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
            "final_compared_to": row.get("final_compared_to") or champion_version,
            "current_champion_version": champion_version,
            "promotion_decision": decision,
            "approval_required": approval_required,
            "next_action": next_action,
            "blockers": blockers,
            "blocker_codes": blocker_codes,
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


def _promotion_row_decision(
    *,
    artifact: dict[str, Any],
    pointer: dict[str, Any] | None,
    champion_version: str | None,
    approved: bool,
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
    approval_required = (
        candidate_type in {"weekly_drift", "manual_hotfix"}
        or str(artifact.get("approval_state") or "") == "required"
    )
    blockers: list[str] = []
    promotion_blockers = artifact_promotion_blockers(artifact, champion_version=champion_version)
    if promotion_blockers:
        blockers.extend(_blocker_codes(promotion_blockers))
    if live_status not in {"passed", "multi_evidence_passed"} and state not in {"approval_required", "approved"}:
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
        "blockers": blockers,
        "blocker_details": promotion_blockers,
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
            "next_action": "Wei approval required before updating champion pointer.",
            "final_compared_to": champion_version,
            "evidence": evidence,
        }
    return {
        "decision": "promote",
        "can_promote": True,
        "approval_required": approval_required,
        "target_state": "production",
        "approval_state": "approved" if approval_required else "not_required",
        "next_action": "Update D1 champion pointer; serving reader migration still requires explicit deployment.",
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
    decision = _promotion_row_decision(
        artifact=artifact,
        pointer=pointer,
        champion_version=champion_version,
        approved=approved,
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

    return {
        "status": "ok" if not errors else "partial_error",
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
