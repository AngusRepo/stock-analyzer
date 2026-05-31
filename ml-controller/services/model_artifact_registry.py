from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Literal

from services import d1_client
from services.candidate_lifecycle_payload import candidate_registrations_from_payload
from services.legacy_prediction_namespace import legacy_model_candidate_name

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)


def _json_loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
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
        raw_details = _json_loads(monte_carlo.get("raw_details")) or _json_loads(monte_carlo.get("raw_distribution"))
        if raw_details:
            monte_carlo["raw_details"] = raw_details
            if isinstance(raw_details.get("tail_risk_diagnostics"), dict):
                monte_carlo["tail_risk_diagnostics"] = raw_details["tail_risk_diagnostics"]

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
    release_gate = _release_gate_packet(bundle)
    if release_gate != packet.get("release_gate"):
        packet["schema_version"] = packet.get("schema_version") or "model-artifact-validation-packet-v1"
        packet["scope"] = packet.get("scope") or "model_artifact_promotion_readiness"
        packet["candidate_specific"] = bool(packet.get("candidate_specific") is True and not _is_global_release_packet(packet))
        packet["release_gate"] = release_gate
        packet.setdefault("candidate_gate", _candidate_gate_packet(offline))
        offline["validation_packet"] = packet
        row["offline_evidence_json"] = offline


_PRESERVED_OFFLINE_EVIDENCE_KEYS = (
    "validation_packet",
    "candidate_gate",
    "candidate_validation_packet",
    "candidate_specific_validation",
    "parameter_candidate_validation",
)


def _merge_preserved_offline_evidence(existing_raw: Any, next_raw: Any) -> str:
    """Keep promotion/validation packets when retrain callbacks refresh IC evidence."""
    existing = _json_loads(existing_raw)
    next_evidence = _json_loads(next_raw)
    if not isinstance(next_evidence, dict):
        return _json_dumps(next_evidence)
    if not isinstance(existing, dict):
        return _json_dumps(next_evidence)

    for key in _PRESERVED_OFFLINE_EVIDENCE_KEYS:
        if key not in next_evidence and isinstance(existing.get(key), dict):
            next_evidence[key] = existing[key]
    return _json_dumps(next_evidence)


def _existing_offline_evidence_json(artifact_id: str) -> str | None:
    try:
        rows = d1_client.query(
            "SELECT offline_evidence_json FROM model_artifact_registry WHERE artifact_id = ? LIMIT 1",
            [artifact_id],
            timeout=30.0,
        )
    except Exception:
        return None
    if not rows:
        return None
    raw = rows[0].get("offline_evidence_json")
    return raw if isinstance(raw, str) else None


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


def _nested_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _model_training_evidence(payload_dict: dict[str, Any], model_name: str) -> dict[str, Any]:
    """Extract model-specific evidence from the richer retrain followup stages.

    Older followup payloads kept model candidate registration rows intentionally
    thin while storing CPCV/OOS evidence under ``stages.train.ic_tracking`` and
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


def build_artifact_records_from_retrain_followup(payload: Any) -> list[dict[str, Any]]:
    payload_dict = payload.model_dump() if hasattr(payload, "model_dump") else dict(payload)
    version = payload_dict.get("candidate_version")
    registrations = candidate_registrations_from_payload(payload)
    if not version or not isinstance(registrations, dict) or not registrations:
        return []

    candidate_type = candidate_type_from_retrain(
        is_monthly=payload_dict.get("is_monthly"),
        explicit=payload_dict.get("candidate_type"),
    )
    ic_summary = payload_dict.get("ic_summary") if isinstance(payload_dict.get("ic_summary"), dict) else {}
    now = _now_iso()
    out: list[dict[str, Any]] = []

    for model_name, raw_registration in registrations.items():
        if not isinstance(raw_registration, dict):
            raw_registration = {"status": "unknown", "raw": raw_registration}
        evidence = _model_training_evidence(payload_dict, str(model_name))
        enriched_registration = {**evidence, **raw_registration}
        if "model_cpcv" not in enriched_registration and evidence.get("model_cpcv") is not None:
            enriched_registration["model_cpcv"] = evidence["model_cpcv"]
        record_version = str(raw_registration.get("version") or version)
        offline_gate = evaluate_offline_gate(
            model_name=str(model_name),
            registration=enriched_registration,
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
            "feature_policy_version": raw_registration.get("feature_policy_version") or evidence.get("feature_policy_version"),
            "checksum": raw_registration.get("checksum"),
            "source_run_date": payload_dict.get("run_date"),
            "is_monthly": 1 if payload_dict.get("is_monthly") else 0,
            "offline_gate_status": offline_gate["status"],
            "offline_gate_decision": offline_gate["decision"],
            "offline_gate_failed_gates": _json_dumps(offline_gate["failed_gates"]),
            "offline_evidence_json": _json_dumps({
                "gate": offline_gate,
                "registration": enriched_registration,
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
    record = dict(record)
    existing_offline = _existing_offline_evidence_json(str(record.get("artifact_id") or ""))
    if existing_offline:
        record["offline_evidence_json"] = _merge_preserved_offline_evidence(
            existing_offline,
            record.get("offline_evidence_json", "{}"),
        )

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
                row[key] = json.loads(raw)
            except json.JSONDecodeError:
                row[key] = raw
    for row in rows:
        _attach_validation_bundle(row, validation_bundle)
    return rows


def _decode_registry_row(row: dict[str, Any]) -> dict[str, Any]:
    decoded = dict(row)
    for key in ("offline_gate_failed_gates", "offline_evidence_json", "live_evidence_json"):
        raw = decoded.get(key)
        if not isinstance(raw, str):
            continue
        try:
            decoded[key] = json.loads(raw)
        except json.JSONDecodeError:
            decoded[key] = raw
    return decoded


def _artifact_validation_candidate_rows(
    *,
    model_name: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    where = [
        "(state IS NULL OR state NOT IN ('production', 'archived', 'rejected'))",
        "live_gate_status IN ('passed', 'rolling_ic_passed', 'multi_evidence_passed')",
    ]
    params: list[Any] = []
    if model_name:
        where.append("model_name = ?")
        params.append(model_name)
    rows = d1_client.query(
        f"""
        SELECT *
        FROM model_artifact_registry
        WHERE {' AND '.join(where)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
        """,
        [*params, max(1, min(int(limit or 200), 500))],
    )
    return [_decode_registry_row(row) for row in rows]


def _compact_backtest_evidence(backtest: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(backtest, dict):
        return None
    return {
        "run_date": backtest.get("run_date"),
        "strategy": backtest.get("strategy"),
        "sharpe": backtest.get("sharpe"),
        "max_drawdown": backtest.get("max_drawdown"),
        "total_trades": backtest.get("total_trades"),
    }


def _validation_packet_from_offline(offline: dict[str, Any]) -> dict[str, Any]:
    packet = offline.get("validation_packet")
    return packet if isinstance(packet, dict) else {}


def _validation_gate(source: dict[str, Any] | None, names: set[str]) -> dict[str, Any] | None:
    if not isinstance(source, dict):
        return None
    gates = source.get("gates")
    if not isinstance(gates, list):
        return None
    for gate in gates:
        if isinstance(gate, dict) and str(gate.get("name") or "") in names:
            return gate
    return None


def _scoped_gate_evidence(
    source: dict[str, Any] | None,
    keys: set[str],
    gate_names: set[str],
) -> Any:
    gate = _validation_gate(source, gate_names)
    if gate:
        return gate
    return _deep_get(source, keys)


def _is_global_release_packet(packet: dict[str, Any]) -> bool:
    scope = str(packet.get("scope") or "")
    overlay_scope = str(packet.get("strategy_risk_overlay_scope") or "")
    return scope in {"latest_global_weekly_validation", "release_train_gate"} or overlay_scope == "latest_global_weekly_validation"


def _candidate_validation_evidence(offline: dict[str, Any]) -> dict[str, Any] | None:
    for key in (
        "candidate_gate",
        "candidate_validation_packet",
        "candidate_specific_validation",
        "parameter_candidate_validation",
    ):
        value = offline.get(key)
        if isinstance(value, dict):
            return value

    packet = _validation_packet_from_offline(offline)
    nested = packet.get("candidate_gate")
    if isinstance(nested, dict) and nested.get("status") != "MISSING":
        evidence = nested.get("evidence")
        return evidence if isinstance(evidence, dict) else nested
    if packet.get("candidate_specific") is True and not _is_global_release_packet(packet):
        return packet
    return None


def _release_gate_packet(validation_bundle: dict[str, Any]) -> dict[str, Any]:
    return {
        "scope": validation_bundle.get("scope") or "latest_global_weekly_validation",
        "source": "global_weekly_validation",
        "shared_across_models": True,
        "candidate_specific": False,
        "root_cause": validation_bundle.get("root_cause"),
        "backtest": _compact_backtest_evidence(validation_bundle.get("backtest")),
        "pbo": validation_bundle.get("pbo"),
        "monte_carlo": validation_bundle.get("monte_carlo"),
        "deflated_sharpe": validation_bundle.get("deflated_sharpe"),
    }


def _candidate_gate_packet(offline: dict[str, Any]) -> dict[str, Any]:
    evidence = _candidate_validation_evidence(offline)
    if not evidence:
        return {
            "status": "MISSING",
            "candidate_specific": True,
            "reason": "candidate_specific_validation_not_generated",
            "required": [
                "candidate_paired_replay",
                "candidate_cscv_rank_logit_pbo",
                "candidate_deflated_sharpe",
                "candidate_monte_carlo_tail_risk",
                "candidate_white_reality_check_or_hansen_spa",
            ],
        }

    status = str(
        evidence.get("decision")
        or evidence.get("status")
        or evidence.get("verdict")
        or evidence.get("go_live_verdict")
        or ""
    ).upper()
    if not status:
        if evidence.get("passed") is True:
            status = "PASS"
        elif evidence.get("passed") is False:
            status = "FAIL"
        else:
            failed_gates = evidence.get("failed_gates")
            status = "PASS" if isinstance(failed_gates, list) and not failed_gates else "WARN"

    return {
        "status": status or "WARN",
        "candidate_specific": True,
        "source": evidence.get("source"),
        "scope": evidence.get("scope") or evidence.get("validation_scope"),
        "evidence": evidence,
        "pbo": _scoped_gate_evidence(
            evidence,
            {"pbo", "pbo_score", "probability_of_backtest_overfitting"},
            {"pbo_overfit_risk"},
        ),
        "monte_carlo": _scoped_gate_evidence(
            evidence,
            {"monte_carlo", "mc", "mc_tail_risk", "tail_risk"},
            {"monte_carlo_tail_risk"},
        ),
        "deflated_sharpe": _scoped_gate_evidence(
            evidence,
            {"deflated_sharpe", "dsr"},
            {"deflated_sharpe"},
        ),
        "data_snooping": _scoped_gate_evidence(
            evidence,
            {"data_snooping", "hansen_spa", "white_reality_check", "spa", "reality_check"},
            {"data_snooping_overfit_guard"},
        ),
    }


def _model_artifact_validation_packet(
    row: dict[str, Any],
    validation_bundle: dict[str, Any],
    *,
    evaluated_at: str,
) -> dict[str, Any]:
    offline = _artifact_offline_evidence(row)
    candidate_gate = _candidate_gate_packet(offline)
    release_gate = _release_gate_packet(validation_bundle)
    return {
        "schema_version": "model-artifact-validation-packet-v1",
        "source": "model_artifact_validation_chain",
        "scope": "model_artifact_promotion_readiness",
        "candidate_specific": candidate_gate.get("status") != "MISSING",
        "candidate_gate": candidate_gate,
        "release_gate": release_gate,
        "artifact_id": row.get("artifact_id"),
        "model_name": row.get("model_name"),
        "candidate_version": row.get("version"),
        "candidate_type": row.get("candidate_type"),
        "evaluated_at": evaluated_at,
        "model_cpcv": _deep_get(offline, {"model_cpcv"}) or _deep_get(offline, {"model_cpcv_decision", "cpcv"}),
        "offline_gate_decision": row.get("offline_gate_decision"),
        "live_gate_status": row.get("live_gate_status"),
        "decision": "PENDING",
        "failed_gates": [],
        "blockers": [],
    }


def _with_validation_packet(
    row: dict[str, Any],
    validation_bundle: dict[str, Any],
    *,
    evaluated_at: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    offline = _artifact_offline_evidence(row)
    packet = _model_artifact_validation_packet(row, validation_bundle, evaluated_at=evaluated_at)
    offline["validation_packet"] = packet
    return offline, packet


def _model_artifact_candidate_rows(
    *,
    model_name: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    where = [
        "(state IS NULL OR state NOT IN ('production', 'archived', 'rejected'))",
        "(live_gate_status IN ('passed', 'rolling_ic_passed', 'multi_evidence_passed') OR state IN ('shadowing', 'live_gate_passed', 'approval_required'))",
    ]
    params: list[Any] = []
    if model_name:
        where.append("model_name = ?")
        params.append(model_name)
    rows = d1_client.query(
        f"""
        SELECT *
        FROM model_artifact_registry
        WHERE {' AND '.join(where)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
        """,
        [*params, max(1, min(int(limit or 200), 500))],
    )
    return [_decode_registry_row(row) for row in rows]


def _load_model_artifact_shadow_pairs(
    model_name: str,
    *,
    lookback_days: int = 90,
) -> list[dict[str, Any]]:
    challenger_name = legacy_model_candidate_name(model_name)
    return d1_client.query(
        """
        SELECT
            active.stock_id AS stock_id,
            active.prediction_date AS sample_date,
            active.forecast_data AS active_forecast_data,
            challenger.forecast_data AS candidate_forecast_data,
            active.actual_return_pct AS actual_return_pct,
            COALESCE(mr.risk_level, 'unknown') AS regime
        FROM predictions active
        JOIN predictions challenger
          ON challenger.stock_id = active.stock_id
         AND challenger.prediction_date = active.prediction_date
         AND challenger.model_name = ?
        LEFT JOIN market_risk mr
          ON mr.date = active.prediction_date
        WHERE active.model_name = ?
          AND active.verified_at IS NOT NULL
          AND challenger.verified_at IS NOT NULL
          AND active.actual_return_pct IS NOT NULL
          AND active.prediction_date >= date('now', ?)
        ORDER BY active.prediction_date ASC, active.stock_id ASC
        """,
        [challenger_name, model_name, f"-{max(1, int(lookback_days or 90))} days"],
    )


def _pct_return(value: Any) -> float | None:
    parsed = _as_float(value)
    if parsed is None:
        return None
    if abs(parsed) > 1:
        return parsed / 100.0
    return parsed


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _forecast_rank_score(raw: Any) -> float | None:
    forecast = _json_loads(raw)
    return _as_float(forecast.get("rank_score"))


def _shadow_rank_score(row: dict[str, Any], score_key: str) -> float | None:
    if score_key == "active_score":
        return _forecast_rank_score(row.get("active_forecast_data"))
    if score_key == "candidate_score":
        return _forecast_rank_score(row.get("candidate_forecast_data"))
    return _as_float(row.get(score_key))


def _shadow_strategy_returns(
    rows: list[dict[str, Any]],
    *,
    score_key: str,
    top_fraction: float = 0.33,
) -> tuple[list[float], list[str], int, dict[str, dict[str, Any]]]:
    by_date: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        date = str(row.get("sample_date") or "")
        if not date:
            continue
        score = _shadow_rank_score(row, score_key)
        ret = _pct_return(row.get("actual_return_pct"))
        if score is None or ret is None:
            continue
        by_date.setdefault(date, []).append({**row, "_score": score, "_return": ret})

    returns: list[float] = []
    regimes: list[str] = []
    selected_count = 0
    per_regime_raw: dict[str, list[float]] = {}
    for date in sorted(by_date):
        candidates = sorted(by_date[date], key=lambda item: float(item["_score"]), reverse=True)
        top_n = max(1, math.ceil(len(candidates) * max(0.05, min(top_fraction, 1.0))))
        selected = candidates[:top_n]
        day_returns = [float(item["_return"]) for item in selected]
        if not day_returns:
            continue
        day_return = _mean(day_returns)
        returns.append(day_return)
        selected_count += len(selected)
        regime = str(selected[0].get("regime") or "unknown")
        regimes.append(regime)
        per_regime_raw.setdefault(regime, []).extend(day_returns)

    per_regime = {
        regime: {
            "trades": len(values),
            "total_return": round(sum(values), 8),
            "oos_return": round(_mean(values), 8),
        }
        for regime, values in per_regime_raw.items()
    }
    return returns, regimes, selected_count, per_regime


def _compound_partition_returns(values: list[float], n_partitions: int = 6) -> list[float]:
    partitions = max(1, int(n_partitions or 6))
    if not values:
        return [0.0 for _ in range(partitions)]
    buckets: list[list[float]] = [[] for _ in range(partitions)]
    total = len(values)
    for idx, value in enumerate(values):
        bucket = min((idx * partitions) // total, partitions - 1)
        buckets[bucket].append(float(value))
    out: list[float] = []
    for bucket in buckets:
        equity = 1.0
        for value in bucket:
            equity *= 1.0 + value
        out.append(round(equity - 1.0, 10))
    return out


def _return_sharpe(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    variance = sum((value - mean) ** 2 for value in values) / max(len(values) - 1, 1)
    std = math.sqrt(variance)
    if std <= 0:
        return 0.0
    return (mean / std) * math.sqrt(min(len(values), 250))


def _return_max_drawdown(values: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for value in values:
        equity *= 1.0 + value
        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)
    return max_dd


def _return_profit_factor(values: list[float]) -> float:
    gains = sum(value for value in values if value > 0)
    losses = abs(sum(value for value in values if value <= 0))
    return gains / losses if losses > 0 else (999.0 if gains > 0 else 0.0)


def _artifact_backtest_row(
    *,
    row: dict[str, Any],
    returns: list[float],
    selected_count: int,
    pair_count: int,
    per_regime: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    sharpe = _return_sharpe(returns)
    profit_factor = _return_profit_factor(returns)
    max_dd = _return_max_drawdown(returns)
    raw = {
        "mode": "B",
        "summary": {
            "total_trades": selected_count,
            "sharpe": sharpe,
            "profit_factor": profit_factor,
            "max_drawdown": max_dd,
        },
        "absolute_confidence": "moderate" if pair_count > 0 else "low",
        "sanity_flags": [] if pair_count > 0 else ["no_verified_shadow_pairs"],
        "entry_attempts": pair_count,
        "entries_filled": selected_count,
        "fill_rate": 1.0 if pair_count > 0 else 0.0,
        "return_series": returns,
        "per_regime": per_regime,
        "parity_audit": {
            "worker_parity": {
                "decision": "PASS" if pair_count > 0 else "FAIL",
                "source": "verified_active_challenger_prediction_pairs",
            }
        },
    }
    return {
        "run_date": row.get("source_run_date"),
        "strategy": "model_artifact_shadow_replay",
        "mode": "B",
        "total_trades": selected_count,
        "sharpe": round(sharpe, 6),
        "profit_factor": round(profit_factor, 6),
        "max_drawdown": round(max_dd, 6),
        "entry_attempts": pair_count,
        "entries_filled": selected_count,
        "fill_rate": raw["fill_rate"],
        "absolute_confidence": raw["absolute_confidence"],
        "sanity_flags": raw["sanity_flags"],
        "return_series": returns,
        "per_regime": per_regime,
        "parity_audit": raw["parity_audit"],
        "raw_results": json.dumps(raw, ensure_ascii=False),
    }


def _artifact_monte_carlo_row(
    returns: list[float],
    regimes: list[str],
    *,
    n_simulations: int,
) -> dict[str, Any]:
    from services.monte_carlo_service import _run_monte_carlo

    method = "regime_block_bootstrap" if regimes and len(regimes) == len(returns) and len(set(regimes)) >= 2 else "block_bootstrap"
    try:
        mc = _run_monte_carlo(
            returns,
            n_simulations=max(100, int(n_simulations or 1000)),
            method=method,
            trade_regimes=regimes if method == "regime_block_bootstrap" else None,
        )
    except Exception:
        mc = _run_monte_carlo(
            returns,
            n_simulations=max(100, int(n_simulations or 1000)),
            method="block_bootstrap",
        )
    return {
        "source": "model_artifact_shadow_replay",
        "n_trades": mc.n_trades,
        "mdd_95th": mc.mdd_95th,
        "go_live_verdict": mc.go_live_verdict,
        "simulation_method": mc.simulation_method,
        "block_size": mc.block_size,
        "regime_counts": mc.regime_counts,
        "reason": mc.verdict_reason,
    }


def _artifact_pbo_row(active_partitions: list[float], candidate_partitions: list[float], *, n_trades: int) -> dict[str, Any]:
    from services.pbo_service import _run_cscv_rank_logit_pbo

    pbo = _run_cscv_rank_logit_pbo({
        "champion": active_partitions,
        "model_artifact_candidate": candidate_partitions,
    })
    return {
        "source": "model_artifact_shadow_replay",
        "n_trades": n_trades,
        "method": pbo.method,
        "pbo": pbo.pbo,
        "oos_mean_return": pbo.oos_mean_return,
        "go_live_verdict": pbo.go_live_verdict,
        "reason": pbo.verdict_reason,
        "raw_details": {
            "method": pbo.method,
            "n_partitions": pbo.n_partitions,
            "n_combinations": pbo.n_combinations,
            "selected_strategy_counts": pbo.selected_strategy_counts,
        },
    }


def _artifact_walk_forward(active_partitions: list[float], candidate_partitions: list[float]) -> dict[str, Any]:
    windows = min(len(active_partitions), len(candidate_partitions))
    if windows <= 0:
        return {
            "method": "paired_shadow_partition_walk_forward",
            "passed": False,
            "reason": "missing_partition_returns",
            "windows": 0,
        }
    paired = list(zip(active_partitions[:windows], candidate_partitions[:windows]))
    candidate_mean = _mean([candidate for _, candidate in paired])
    champion_mean = _mean([champion for champion, _ in paired])
    positive_ratio = sum(1 for _, candidate in paired if candidate > 0) / windows
    beats_ratio = sum(1 for champion, candidate in paired if candidate >= champion) / windows
    passed = windows >= 4 and candidate_mean > 0 and positive_ratio >= 0.5 and beats_ratio >= 0.5
    return {
        "method": "paired_shadow_partition_walk_forward",
        "passed": passed,
        "gate_pass": passed,
        "reason": "ok" if passed else "shadow_partition_walk_forward_not_stable",
        "windows": windows,
        "candidate_mean_return": round(candidate_mean, 8),
        "champion_mean_return": round(champion_mean, 8),
        "positive_ratio": round(positive_ratio, 6),
        "beats_champion_ratio": round(beats_ratio, 6),
    }


def _artifact_data_snooping(active_partitions: list[float], candidate_partitions: list[float]) -> dict[str, Any]:
    from services.validation_governance import hansen_spa_reality_check

    return hansen_spa_reality_check(
        {
            "champion": active_partitions,
            "model_artifact_candidate": candidate_partitions,
        },
        benchmark="champion",
        n_bootstrap=500,
        seed=29,
    )


def _build_model_artifact_candidate_evidence(
    row: dict[str, Any],
    shadow_rows: list[dict[str, Any]],
    *,
    mc_simulations: int,
) -> dict[str, Any]:
    from services.validation_governance import build_validation_packet, deflated_sharpe_evidence

    active_returns, _, _, _ = _shadow_strategy_returns(shadow_rows, score_key="active_score")
    candidate_returns, regimes, selected_count, per_regime = _shadow_strategy_returns(
        shadow_rows,
        score_key="candidate_score",
    )
    active_partitions = _compound_partition_returns(active_returns)
    candidate_partitions = _compound_partition_returns(candidate_returns)
    backtest = _artifact_backtest_row(
        row=row,
        returns=candidate_returns,
        selected_count=selected_count,
        pair_count=len(shadow_rows),
        per_regime=per_regime,
    )
    monte_carlo = _artifact_monte_carlo_row(candidate_returns, regimes, n_simulations=mc_simulations)
    pbo = _artifact_pbo_row(active_partitions, candidate_partitions, n_trades=selected_count)
    data_snooping = _artifact_data_snooping(active_partitions, candidate_partitions)
    walk_forward = _artifact_walk_forward(active_partitions, candidate_partitions)
    dsr = deflated_sharpe_evidence(backtest)
    validation_packet = build_validation_packet(
        source="model_artifact_candidate_evidence_gate",
        backtest=backtest,
        monte_carlo=monte_carlo,
        pbo=pbo,
        data_snooping=data_snooping,
        walk_forward=walk_forward,
    )
    decision = str(validation_packet.get("decision") or "FAIL").upper()
    return {
        "schema_version": "model-artifact-candidate-validation-v1",
        "source": "model_artifact_candidate_validation_chain",
        "scope": "model_artifact_candidate_promotion_evidence",
        "candidate_specific": True,
        "artifact_id": row.get("artifact_id"),
        "model_name": row.get("model_name"),
        "candidate_version": row.get("version"),
        "candidate_type": row.get("candidate_type"),
        "decision": decision,
        "passed": decision == "PASS",
        "backtest": backtest,
        "pbo": pbo,
        "deflated_sharpe": dsr,
        "monte_carlo": monte_carlo,
        "data_snooping": data_snooping,
        "walk_forward": walk_forward,
        "validation_packet": validation_packet,
        "failed_gates": validation_packet.get("failed_gates") or [],
        "provenance": {
            "pair_source": "predictions active/challenger verified rows",
            "pair_count": len(shadow_rows),
            "active_model_name": row.get("model_name"),
            "legacy_candidate_model_name": legacy_model_candidate_name(str(row.get("model_name") or "")),
            "replay_method": "paired_shadow_verified_replay",
        },
    }


def run_model_artifact_candidate_validation_chain(
    *,
    model_name: str | None = None,
    limit: int = 200,
    lookback_days: int = 90,
    mc_simulations: int = 1000,
    persist: bool = True,
    refresh_validation: bool = True,
) -> dict[str, Any]:
    rows = _model_artifact_candidate_rows(model_name=model_name, limit=limit)
    generated = 0
    updated = 0
    errors: list[str] = []
    artifacts: list[dict[str, Any]] = []

    for row in rows:
        artifact_id = str(row.get("artifact_id") or "")
        model = str(row.get("model_name") or "")
        try:
            pairs = _load_model_artifact_shadow_pairs(model, lookback_days=lookback_days)
            evidence = _build_model_artifact_candidate_evidence(
                row,
                pairs,
                mc_simulations=mc_simulations,
            )
            generated += 1
            offline = _artifact_offline_evidence(row)
            offline["candidate_validation_packet"] = evidence
            offline["candidate_specific_validation"] = evidence
            if persist:
                d1_client.execute(
                    """
                    UPDATE model_artifact_registry
                    SET offline_evidence_json = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE artifact_id = ?
                    """,
                    [_json_dumps(offline), artifact_id],
                )
                updated += 1
            artifacts.append({
                "artifact_id": artifact_id,
                "model_name": model,
                "candidate_version": row.get("version"),
                "candidate_type": row.get("candidate_type"),
                "decision": evidence.get("decision"),
                "failed_gates": evidence.get("failed_gates") or [],
                "pair_count": len(pairs),
                "persisted": bool(persist),
            })
        except Exception as exc:  # noqa: BLE001 - keep other artifacts visible.
            errors.append(f"{artifact_id}: {exc}")
            artifacts.append({
                "artifact_id": artifact_id,
                "model_name": model,
                "candidate_version": row.get("version"),
                "candidate_type": row.get("candidate_type"),
                "decision": "ERROR",
                "error": str(exc),
                "persisted": False,
            })

    validation_result = None
    if refresh_validation and persist:
        validation_result = run_model_artifact_validation_chain(
            model_name=model_name,
            limit=limit,
            persist=True,
        )

    return {
        "status": "ok" if not errors else "partial",
        "source_of_truth": "model_artifact_registry",
        "validation_scope": "model_artifact_candidate_promotion_evidence",
        "count": len(rows),
        "generated": generated,
        "updated": updated,
        "errors": errors,
        "artifacts": artifacts,
        "model_artifact_validation": validation_result,
    }


def run_model_artifact_validation_chain(
    *,
    model_name: str | None = None,
    limit: int = 200,
    champion_versions: dict[str, str] | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    """Persist artifact-scoped validation evidence after weekly backtest/MC/PBO.

    This is not a promotion mutator: it only writes validation evidence and moves
    a candidate to ``multi_evidence_passed`` when the existing promotion blockers
    are clear. Champion pointer updates remain owned by promotion_controller.
    """
    validation_bundle = _latest_validation_bundle()
    rows = _artifact_validation_candidate_rows(model_name=model_name, limit=limit)
    pointer_versions = {
        str(row.get("model_name")): str(row.get("champion_version"))
        for row in list_champion_pointers(model_name=model_name)
        if row.get("model_name") and row.get("champion_version")
    }
    champion_versions = {**pointer_versions, **(champion_versions or {})}
    evaluated_at = _now_iso()

    artifacts: list[dict[str, Any]] = []
    updated = 0
    ready = 0
    blocked = 0
    errors: list[str] = []

    for row in rows:
        artifact_id = str(row.get("artifact_id") or "")
        model = str(row.get("model_name") or "")
        offline, packet = _with_validation_packet(row, validation_bundle, evaluated_at=evaluated_at)
        candidate_for_gate = {
            **row,
            "offline_evidence_json": _json_dumps(offline),
            # Treat rolling IC as already reviewed for this check; blockers below
            # decide whether evidence can be upgraded to multi_evidence_passed.
            "live_gate_status": "passed",
        }
        champion_version = champion_versions.get(model) or row.get("final_compared_to")
        blockers = artifact_promotion_blockers(candidate_for_gate, champion_version=champion_version)
        blocker_codes = _blocker_codes(blockers)
        is_ready = len(blockers) == 0

        packet["decision"] = "PASS" if is_ready else "FAIL"
        packet["failed_gates"] = blocker_codes
        packet["blockers"] = blockers
        offline["validation_packet"] = packet

        next_live_status = "multi_evidence_passed" if is_ready else str(row.get("live_gate_status") or "rolling_ic_passed")
        next_state = "live_gate_passed" if is_ready else str(row.get("state") or "shadowing")
        next_decision = "pending_promotion_controller" if is_ready else "blocked_multi_evidence_gate"

        if persist:
            try:
                d1_client.execute(
                    """
                    UPDATE model_artifact_registry
                    SET offline_evidence_json = ?,
                        live_gate_status = ?,
                        state = ?,
                        promotion_decision = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE artifact_id = ?
                    """,
                    [
                        _json_dumps(offline),
                        next_live_status,
                        next_state,
                        next_decision,
                        artifact_id,
                    ],
                )
                updated += 1
            except Exception as exc:  # noqa: BLE001 - report partial validation closure.
                errors.append(f"{artifact_id}: {exc}")

        if is_ready:
            ready += 1
        else:
            blocked += 1
        artifacts.append({
            "artifact_id": artifact_id,
            "model_name": model,
            "candidate_version": row.get("version"),
            "candidate_type": row.get("candidate_type"),
            "validation_decision": packet["decision"],
            "live_gate_status": next_live_status,
            "state": next_state,
            "promotion_decision": next_decision,
            "blocker_codes": blocker_codes,
            "blockers": blockers,
            "persisted": bool(persist),
        })

    return {
        "status": "ok" if not errors else "partial",
        "source_of_truth": "model_artifact_registry",
        "validation_scope": "model_artifact_promotion_readiness",
        "release_gate_scope": validation_bundle.get("scope"),
        "count": len(rows),
        "updated": updated,
        "ready": ready,
        "blocked": blocked,
        "errors": errors,
        "artifacts": artifacts,
    }


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
                row["promotion_evidence_json"] = json.loads(raw)
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
    models = sorted({
        *(str(r.get("model_name")) for r in registry_rows if r.get("model_name")),
        *model_pool_versions.keys(),
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
        evidence = {
            "schema_version": "champion-pointer-backfill-v1",
            "reason": reason,
            "source": "model_pool.json",
            "backfilled_at": now,
            "registry_artifact_found": bool(artifact),
            "production_artifact_created": created_this_artifact,
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
    "shadowing",
    "live_gate_passed",
    "approval_required",
    "approved",
}


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


def _metric_float(value: Any, keys: set[str]) -> float | None:
    raw = _deep_get(value, keys) if isinstance(value, dict) else value
    return _as_float(raw)


def _metric_text(value: Any, keys: set[str]) -> str:
    raw = _deep_get(value, keys) if isinstance(value, dict) else value
    return str(raw or "")


def _release_gate_from_offline(offline: dict[str, Any]) -> dict[str, Any] | None:
    packet = _validation_packet_from_offline(offline)
    release_gate = packet.get("release_gate")
    if isinstance(release_gate, dict):
        return release_gate
    if packet and _is_global_release_packet(packet):
        return packet
    return None


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
    candidate_gate = _candidate_gate_packet(offline)
    candidate_evidence = candidate_gate.get("evidence") if isinstance(candidate_gate.get("evidence"), dict) else candidate_gate
    release_gate = _release_gate_from_offline(offline)
    try:
        from services.promotion_policy import PromotionPolicy

        policy = PromotionPolicy.from_env()
    except Exception:  # noqa: BLE001 - promotion UI must stay fail-visible even if policy import drifts.
        policy = None
    max_pbo = float(getattr(policy, "max_pbo", 0.50))
    max_mc_mdd = float(getattr(policy, "max_mc_mdd_95th", 0.20))

    def add(code: str, label: str, next_action: str, severity: str = "blocker") -> None:
        blockers.append({
            "code": code,
            "label": label,
            "next_action": next_action,
            "severity": severity,
        })

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
    min_samples = _as_float(metrics.get("min_samples")) or 50
    if shadow_samples is None or shadow_samples < max(150, min_samples):
        add(
            "shadow_sample_window_too_short",
            "Shadow sample window is too short",
            "Collect at least 150 verified shadow rows and report the comparison window_start/window_end.",
        )
    if production_samples is None or production_samples < max(150, min_samples):
        add(
            "champion_sample_window_too_short",
            "Champion baseline sample window is too short",
            "Collect matching champion verified rows before calling the comparison promotion-grade.",
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

    cpcv = _deep_get(offline, {"model_cpcv_decision", "cpcv_decision", "cpcv"})
    if not _truthy_gate_value(cpcv):
        add(
            "cpcv_pbo_missing",
            "Missing CPCV evidence",
            "Attach CPCV/PBO validation evidence so rolling live IC is not treated as a one-window artifact.",
        )

    if candidate_gate.get("status") == "MISSING":
        add(
            "candidate_specific_validation_missing",
            "Missing candidate-specific promotion evidence",
            "Run candidate-specific paired replay, CSCV rank-logit PBO, DSR, MC tail-risk, and SPA/White Reality Check; weekly/global release gates cannot substitute for model-level evidence.",
        )
    else:
        candidate_status = str(candidate_gate.get("status") or "").upper()
        candidate_packet = candidate_evidence.get("validation_packet") if isinstance(candidate_evidence, dict) else None
        candidate_packet_decision = str((candidate_packet or {}).get("decision") or "").upper() if isinstance(candidate_packet, dict) else ""
        if candidate_status in {"FAIL", "FAILED", "BLOCKED", "REJECTED"} or candidate_packet_decision == "FAIL":
            add(
                "candidate_validation_packet_failed",
                "Candidate validation packet failed",
                "Inspect candidate-specific replay failed_gates before final promotion; generated evidence is present but not promotion-grade.",
            )

        pbo = candidate_gate.get("pbo") or _scoped_gate_evidence(
            candidate_evidence,
            {"pbo", "pbo_score", "probability_of_backtest_overfitting"},
            {"pbo_overfit_risk"},
        )
        pbo_value = _metric_float(pbo, {"pbo", "pbo_score", "probability_of_backtest_overfitting", "value", "score"})
        pbo_method = _metric_text(pbo, {"method"}).lower()
        if not _truthy_gate_value(pbo, max_fail_value=max_pbo) or (pbo_value is not None and pbo_value >= max_pbo):
            add(
                "candidate_pbo_threshold_missing",
                "Candidate PBO threshold is missing or too high",
                f"Provide candidate-specific PBO below {max_pbo:.2f} before final promotion.",
            )
        if isinstance(pbo, dict) and pbo_method and pbo_method != "cscv_rank_logit":
            add(
                "candidate_pbo_method_not_promotion_grade",
                "Candidate PBO method is not promotion-grade",
                "Run candidate-specific CSCV rank-logit PBO; proxy PBO is visible but cannot approve production.",
            )

        dsr = candidate_gate.get("deflated_sharpe") or _scoped_gate_evidence(
            candidate_evidence,
            {"deflated_sharpe", "dsr"},
            {"deflated_sharpe"},
        )
        mc = candidate_gate.get("monte_carlo") or _scoped_gate_evidence(
            candidate_evidence,
            {"monte_carlo", "mc", "mc_tail_risk", "tail_risk"},
            {"monte_carlo_tail_risk"},
        )
        if not _truthy_gate_value(dsr) or not _truthy_gate_value(mc):
            add(
                "candidate_dsr_mc_missing",
                "Missing candidate DSR or Monte Carlo tail-risk evidence",
                "Attach candidate-specific deflated Sharpe and Monte Carlo tail-risk evidence before promotion.",
            )

        data_snooping = candidate_gate.get("data_snooping") or _scoped_gate_evidence(
            candidate_evidence,
            {"data_snooping", "hansen_spa", "white_reality_check", "spa", "reality_check"},
            {"data_snooping_overfit_guard"},
        )
        if not _truthy_gate_value(data_snooping):
            add(
                "candidate_data_snooping_missing",
                "Missing candidate SPA / White Reality Check evidence",
                "Run Hansen SPA or White Reality Check so selected parameters are not promoted from data-snooped winners.",
            )

    if not release_gate:
        add(
            "release_train_gate_missing",
            "Missing shared release-train risk gate",
            "Run weekly/global backtest, CSCV PBO, DSR, and Monte Carlo release gate before allowing any candidate to promote.",
        )
    else:
        release_pbo = release_gate.get("pbo") or _scoped_gate_evidence(
            release_gate,
            {"pbo", "pbo_score", "probability_of_backtest_overfitting"},
            {"pbo_overfit_risk"},
        )
        release_pbo_value = _metric_float(release_pbo, {"pbo", "pbo_score", "probability_of_backtest_overfitting", "value", "score"})
        release_pbo_method = _metric_text(release_pbo, {"method"}).lower()
        if not _truthy_gate_value(release_pbo, max_fail_value=max_pbo) or (
            release_pbo_value is not None and release_pbo_value >= max_pbo
        ):
            add(
                "release_pbo_blocked",
                "Shared release PBO gate failed",
                f"Release train is frozen until global PBO is below {max_pbo:.2f} with promotion-grade evidence.",
            )
        if isinstance(release_pbo, dict) and release_pbo_method and release_pbo_method != "cscv_rank_logit":
            add(
                "release_pbo_method_not_promotion_grade",
                "Shared release PBO method is proxy-grade",
                "Run global CSCV rank-logit PBO before opening this release train.",
                severity="review",
            )

        release_dsr = release_gate.get("deflated_sharpe") or _scoped_gate_evidence(
            release_gate,
            {"deflated_sharpe", "dsr"},
            {"deflated_sharpe"},
        )
        if not _truthy_gate_value(release_dsr):
            add(
                "release_dsr_blocked",
                "Shared release DSR gate failed",
                "Release train is frozen until global deflated Sharpe evidence passes.",
            )

        release_mc = release_gate.get("monte_carlo") or _scoped_gate_evidence(
            release_gate,
            {"monte_carlo", "mc", "mc_tail_risk", "tail_risk"},
            {"monte_carlo_tail_risk"},
        )
        release_mc_mdd = _metric_float(release_mc, {"mdd_95th", "max_drawdown_95th"})
        if not _truthy_gate_value(release_mc) or (release_mc_mdd is not None and release_mc_mdd > max_mc_mdd):
            add(
                "release_monte_carlo_blocked",
                "Shared release MC tail-risk gate failed",
                f"Release train is frozen until global Monte Carlo 95% MDD is <= {max_mc_mdd:.2f}.",
            )
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
            if r is not selected_monthly and r is not selected_weekly
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
                "monthly": "select best offline_passed or stronger artifact",
                "weekly": "select only offline_strong_pass unless a newer promotion-ready monthly release supersedes it",
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
    shadow_name = legacy_model_candidate_name(model_name)
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
    rows = list_artifact_registry(limit=limit)
    selection = build_candidate_selection(rows)
    selected: dict[str, dict[str, Any]] = {}
    for model_name, model_selection in (selection.get("models") or {}).items():
        for key in ("monthly_release_candidate", "weekly_drift_candidate"):
            candidate = model_selection.get(key)
            if isinstance(candidate, dict) and candidate.get("artifact_id"):
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
        if str(row.get("state") or "") in {"archived", "rejected"}:
            continue
        if not _promotion_ready(row):
            continue
        model_name = str(row.get("model_name") or "")
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
