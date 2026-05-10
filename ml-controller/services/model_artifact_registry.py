from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal

from services import d1_client

CandidateType = Literal["monthly_release", "weekly_drift", "manual_hotfix", "unknown"]
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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def candidate_type_from_retrain(*, is_monthly: bool | None, explicit: str | None = None) -> CandidateType:
    if explicit in {"monthly_release", "weekly_drift", "manual_hotfix"}:
        return explicit  # type: ignore[return-value]
    if is_monthly is True:
        return "monthly_release"
    if is_monthly is False:
        return "weekly_drift"
    return "unknown"


def model_artifact_path(model_name: str, version: str) -> str:
    folder = model_name.lower().replace("-", "_")
    ext = {
        "Chronos": "json",
        "DLinear": "pt",
        "PatchTST": "pt",
    }.get(model_name, "joblib")
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
    elif ic_value <= 0:
        failed.append("oos_ic_non_positive")
    elif ic_value < 0.02:
        warnings.append("oos_ic_weak")

    if failed:
        state: ArtifactState = "offline_failed"
        decision = "FAIL"
        status = "failed"
    elif warnings:
        state = "offline_passed_weak"
        decision = "WEAK_PASS"
        status = "weak_pass"
    elif ic_value is not None and ic_value >= 0.05:
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
            "model_cpcv_decision": (
                model_cpcv.get("decision")
                if isinstance(model_cpcv, dict)
                else None
            ),
        },
    }


def build_artifact_records_from_retrain_followup(payload: Any) -> list[dict[str, Any]]:
    payload_dict = payload.model_dump() if hasattr(payload, "model_dump") else dict(payload)
    version = payload_dict.get("candidate_version")
    registrations = payload_dict.get("challenger_registrations") or {}
    if not version or not isinstance(registrations, dict) or not registrations:
        return []

    candidate_type = candidate_type_from_retrain(is_monthly=payload_dict.get("is_monthly"))
    ic_summary = payload_dict.get("ic_summary") if isinstance(payload_dict.get("ic_summary"), dict) else {}
    now = _now_iso()
    out: list[dict[str, Any]] = []

    for model_name, raw_registration in registrations.items():
        if not isinstance(raw_registration, dict):
            raw_registration = {"status": "unknown", "raw": raw_registration}
        record_version = str(raw_registration.get("version") or version)
        offline_gate = evaluate_offline_gate(
            model_name=str(model_name),
            registration=raw_registration,
            ic_summary=ic_summary,
        )
        artifact_id = f"{model_name}:{record_version}:{candidate_type}"
        out.append({
            "artifact_id": artifact_id,
            "model_name": str(model_name),
            "version": record_version,
            "candidate_type": candidate_type,
            "state": offline_gate["state"],
            "artifact_path": raw_registration.get("gcs_path") or model_artifact_path(str(model_name), record_version),
            "metadata_path": raw_registration.get("metadata_path") or model_metadata_path(str(model_name), record_version),
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
            "final_compared_to": None,
            "feature_policy_version": raw_registration.get("feature_policy_version"),
            "checksum": raw_registration.get("checksum"),
            "source_run_date": payload_dict.get("run_date"),
            "is_monthly": 1 if payload_dict.get("is_monthly") else 0,
            "offline_gate_status": offline_gate["status"],
            "offline_gate_decision": offline_gate["decision"],
            "offline_gate_failed_gates": _json_dumps(offline_gate["failed_gates"]),
            "offline_evidence_json": _json_dumps({
                "gate": offline_gate,
                "registration": raw_registration,
                "ic_summary": {str(model_name): ic_summary.get(str(model_name))},
                "callback_status": payload_dict.get("status"),
                "callback_error": payload_dict.get("error"),
            }),
            "live_gate_status": "not_started",
            "live_evidence_json": "{}",
            "promotion_decision": "not_evaluated",
            "approval_state": "not_required",
            "created_at": now,
        })
    return out


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
                row[key] = json.loads(raw)
            except json.JSONDecodeError:
                row[key] = raw
    return rows


_STATE_RANK = {
    "offline_strong_pass": 4,
    "offline_passed": 3,
    "offline_passed_weak": 2,
    "registered": 1,
}


def _candidate_rank(row: dict[str, Any]) -> tuple[int, str]:
    return (
        _STATE_RANK.get(str(row.get("state") or ""), 0),
        str(row.get("updated_at") or row.get("created_at") or ""),
    )


def build_candidate_selection(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Read-only release-train selection policy.

    Monthly artifacts are the primary release train. Weekly artifacts are drift
    candidates and only become live-shadow candidates when they are strong
    offline passes. This prevents every weekly artifact from occupying a live
    gate slot.
    """
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("model_name") or "unknown"), []).append(row)

    selections: dict[str, dict[str, Any]] = {}
    for model_name, items in grouped.items():
        monthly = [r for r in items if r.get("candidate_type") == "monthly_release"]
        weekly = [r for r in items if r.get("candidate_type") == "weekly_drift"]
        best_monthly = max(monthly, key=_candidate_rank, default=None)
        best_weekly = max(weekly, key=_candidate_rank, default=None)

        selected_monthly = (
            best_monthly
            if best_monthly and _STATE_RANK.get(str(best_monthly.get("state") or ""), 0) >= 3
            else None
        )
        selected_weekly = (
            best_weekly
            if best_weekly and str(best_weekly.get("state") or "") == "offline_strong_pass"
            else None
        )

        archive_candidates = [
            r.get("artifact_id")
            for r in items
            if r is not selected_monthly and r is not selected_weekly
        ]

        selections[model_name] = {
            "monthly_release_candidate": selected_monthly,
            "weekly_drift_candidate": selected_weekly,
            "archive_candidates": archive_candidates,
            "policy": {
                "monthly": "select best offline_passed or stronger artifact",
                "weekly": "select only offline_strong_pass unless production decay policy later overrides",
                "live_shadow_slots": {
                    "monthly": 1,
                    "weekly": 1,
                },
            },
        }

    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry",
        "selection_policy": "release_train_v1",
        "models": selections,
    }
