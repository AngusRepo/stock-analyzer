"""Pre-outcome-locked evaluation for exact frozen L4/Fusion candidates.

The evaluator never trains. It may consume an immutable PIT prediction date
before artifact freeze only when that date is after the artifact training
cutoff and its outcome label was still unknown at freeze time. Every result is
bound to the candidate packet checksum plus the embedded model fingerprint.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from typing import Any, Callable

from scipy.stats import t as student_t

from services.allocator_ev_fusion_artifact_builder import (
    PRIMARY_MIN_OOS_DATES,
    _predict as _predict_fusion,
    _samples as _fusion_samples,
)
from services.expected_return_artifact_identity import expected_return_artifact_identity
from services.l4_alpha_ev_artifact_builder import _samples as _l4_samples


SCHEMA_VERSION = "expected-return-candidate-forward-evaluation-v2"
GATE_SCHEMA_VERSION = "expected-return-candidate-forward-gate-v2"
MIN_EVALUABLE_DATES = PRIMARY_MIN_OOS_DATES
MAX_EVALUABLE_DATES = 30
L4_BASELINE_OWNER = "formal_ml_buy_admission:ensemble_directional_margin"
FUSION_BASELINE_OWNER = "exact_frozen_l4_candidate"
SELECTION_ROUTE_SEMANTIC_VERSION = "strategy-semantic-continuous-affinity-v5"
SELECTION_AFFINITY_SEMANTIC_VERSION = "strategy-threshold-margin-affinity-v2"
ACTIVE_CANDIDATE_STATES = {"shadowing", "live_gate_passed", "production"}
OBSERVABLE_REJECTED_CANDIDATE_STATES = {"offline_failed", "rejected"}
ELIGIBLE_CANDIDATE_STATES = {
    "offline_passed",
    "offline_strong_pass",
    "candidate_selected",
    "shadowing",
    "live_gate_passed",
}

L4_OFFLINE_EFFICACY_FINDINGS = {
    "oos_date_cluster_corr_lcb90_not_positive",
    "oos_date_cluster_spread_lcb90_not_above_cost",
    "oos_top_quintile_return_not_positive",
    "oos_date_cluster_top_quintile_return_lcb90_not_positive",
    "walk_forward_not_stable",
}
FUSION_OFFLINE_EFFICACY_FINDINGS = {
    "residual_adjustment:oos_prediction_target_corr_lcb90_not_positive",
    "residual_adjustment:oos_top_bottom_spread_lcb90_not_economic",
    "residual_adjustment:walk_forward_not_stable",
    "residual_champion:residual_adjustment_model_not_validated",
}


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _corr(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 3:
        return None
    left_mean = _mean(left)
    right_mean = _mean(right)
    left_var = sum((value - left_mean) ** 2 for value in left)
    right_var = sum((value - right_mean) ** 2 for value in right)
    if left_var <= 0.0 or right_var <= 0.0:
        return None
    return sum(
        (x - left_mean) * (y - right_mean)
        for x, y in zip(left, right, strict=True)
    ) / math.sqrt(left_var * right_var)


def _spread(predictions: list[float], targets: list[float]) -> tuple[float, float]:
    ordered = sorted(zip(predictions, targets, strict=True), key=lambda item: item[0])
    bucket = max(1, len(ordered) // 5)
    top = _mean([target for _prediction, target in ordered[-bucket:]])
    bottom = _mean([target for _prediction, target in ordered[:bucket]])
    return top - bottom, top


def _lcb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = _mean(values)
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    standard_error = math.sqrt(variance / len(values))
    return mean - float(student_t.ppf(0.95, df=len(values) - 1)) * standard_error


def _ucb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = _mean(values)
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    standard_error = math.sqrt(variance / len(values))
    return mean + float(student_t.ppf(0.95, df=len(values) - 1)) * standard_error


def _failed_gate_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return ["offline_gate_evidence_invalid_json"]
    return [str(item) for item in parsed] if isinstance(parsed, list) else ["offline_gate_evidence_invalid_shape"]


def _offline_admission_from_failed_gates(
    owner: str,
    failed_gates: list[str],
    *,
    source_decision: str | None = None,
) -> dict[str, Any]:
    allowed_findings = (
        L4_OFFLINE_EFFICACY_FINDINGS
        if owner == "l4_alpha_ev"
        else FUSION_OFFLINE_EFFICACY_FINDINGS
    )
    efficacy_findings = [gate for gate in failed_gates if gate in allowed_findings]
    hard_blockers = [gate for gate in failed_gates if gate not in allowed_findings]
    normalized_source_decision = str(source_decision or "").upper()
    if normalized_source_decision:
        if normalized_source_decision == "PASS" and failed_gates:
            hard_blockers.append("offline_gate_pass_with_failed_gates")
        elif normalized_source_decision == "FAIL" and not failed_gates:
            hard_blockers.append("offline_gate_failure_without_failed_gates")
        elif normalized_source_decision not in {"PASS", "FAIL"}:
            hard_blockers.append("offline_gate_not_terminal")
    return {
        "schema_version": "expected-return-offline-admission-v1",
        "decision": "PASS" if not hard_blockers else "FAIL",
        "hard_blockers": hard_blockers,
        "efficacy_findings": efficacy_findings,
        "policy": "integrity_fit_and_parity_only;efficacy_owned_by_prospective_forward_gate",
    }


def _offline_admission_for_row(row: dict[str, Any]) -> dict[str, Any]:
    return _offline_admission_from_failed_gates(
        str(row.get("model_name") or ""),
        _failed_gate_list(row.get("offline_gate_failed_gates")),
        source_decision=str(row.get("offline_gate_decision") or ""),
    )


def _offline_admission(candidate: dict[str, Any]) -> dict[str, Any]:
    registry = candidate["registry"]
    owner = str(registry.get("model_name") or "")
    registry_failed = _failed_gate_list(registry.get("offline_gate_failed_gates"))
    registry_decision = str(registry.get("offline_gate_decision") or "").upper()
    validation = candidate["packet"].get("validation_packet") or {}
    packet_failed = _failed_gate_list(validation.get("failed_gates"))
    packet_decision = str(validation.get("decision") or "").upper()
    admission = _offline_admission_from_failed_gates(
        owner,
        registry_failed,
        source_decision=registry_decision,
    )
    if sorted(registry_failed) != sorted(packet_failed):
        admission["decision"] = "FAIL"
        admission["hard_blockers"] = list(dict.fromkeys([
            *admission["hard_blockers"],
            "offline_gate_registry_packet_mismatch",
        ]))
    if registry_decision != packet_decision:
        admission["decision"] = "FAIL"
        admission["hard_blockers"] = list(dict.fromkeys([
            *admission["hard_blockers"],
            "offline_gate_registry_packet_decision_mismatch",
        ]))
    admission["source_validation_decision"] = packet_decision or "PENDING"
    admission["source_failed_gates"] = registry_failed
    return admission


def _candidate_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    cohort_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, bool]]:
    rows = query_fn(
        """
        SELECT artifact_id, model_name, version, state, artifact_path, checksum,
               source_run_date, offline_gate_decision, offline_gate_failed_gates,
               training_run_id, updated_at
          FROM model_artifact_registry
         WHERE model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
           AND candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')
         ORDER BY source_run_date DESC, updated_at DESC, artifact_id DESC
         LIMIT 80
        """,
        [],
    )
    current_training_run_id = f"active8_oof:{cohort_id}"
    selected: dict[str, dict[str, Any]] = {}
    activate: dict[str, bool] = {}
    for owner in ("l4_alpha_ev", "allocator_ev_fusion"):
        owner_rows = [row for row in rows if str(row.get("model_name") or "") == owner]
        active = [
            row for row in owner_rows
            if str(row.get("state") or "") in ACTIVE_CANDIDATE_STATES
            and str(row.get("state") or "") != "production"
            and _offline_admission_for_row(row)["decision"] == "PASS"
        ]
        if active:
            # SQL is newest-first. Preserve the oldest active artifact so a new
            # weekly candidate cannot reset an in-flight prospective lane.
            selected[owner] = active[-1]
            activate[owner] = False
            continue
        eligible = [
            row for row in owner_rows
            if str(row.get("training_run_id") or "") == current_training_run_id
            and str(row.get("state") or "") in (ELIGIBLE_CANDIDATE_STATES | OBSERVABLE_REJECTED_CANDIDATE_STATES)
            and _offline_admission_for_row(row)["decision"] == "PASS"
        ]
        if eligible:
            selected[owner] = eligible[0]
            activate[owner] = True

    # Fusion is a residual over the exact L4 artifact. It may not delay an
    # independently admissible L4 lane, but it may only evaluate beside the L4
    # candidate frozen by the same cohort and source date.
    if "allocator_ev_fusion" in selected:
        fusion = selected["allocator_ev_fusion"]
        l4 = selected.get("l4_alpha_ev")
        if not l4 or any(
            str(fusion.get(field) or "") != str(l4.get(field) or "")
            for field in ("training_run_id", "source_run_date")
        ):
            selected.pop("allocator_ev_fusion", None)
            activate.pop("allocator_ev_fusion", None)
    return selected, activate


def _persist_candidate_gate_state(
    *,
    candidates: dict[str, dict[str, Any]],
    gates: dict[str, dict[str, Any]],
    activate: dict[str, bool],
    batch_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    statements: list[tuple[str, list[Any]]] = []
    for owner, candidate in candidates.items():
        gate = gates[owner]
        decision = str(gate.get("decision") or "PENDING").upper()
        state = str(candidate["registry"].get("state") or "")
        next_state = (
            "rejected"
            if decision == "FAIL"
            else "shadowing"
            if activate.get(owner, False) or state not in ACTIVE_CANDIDATE_STATES
            else state
        )
        live_status = (
            "passed" if decision == "PASS"
            else "failed" if decision == "FAIL"
            else "holding_forward_evidence" if decision == "HOLD"
            else "collecting_forward_evidence"
        )
        promotion_decision = (
            "prospective_passed" if decision == "PASS"
            else "prospective_failed" if decision == "FAIL"
            else "prospective_hold" if decision == "HOLD"
            else "prospective_collecting"
        )
        statements.append((
            """
            UPDATE model_artifact_registry
               SET state=?, live_gate_status=?, live_evidence_json=?,
                   promotion_decision=?, updated_at=CURRENT_TIMESTAMP
             WHERE artifact_id=? AND checksum=?
            """,
            [
                next_state,
                live_status,
                json.dumps(gate, ensure_ascii=False, sort_keys=True, allow_nan=False),
                promotion_decision,
                candidate["registry"]["artifact_id"],
                candidate["checksum"],
            ],
        ))
    return batch_fn(statements, timeout=30.0, chunk_size=2)


def _load_candidate_packet(bucket: Any, row: dict[str, Any]) -> dict[str, Any]:
    path = str(row.get("artifact_path") or "")
    checksum = str(row.get("checksum") or "").lower()
    raw = bucket.blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("candidate_forward_packet_checksum_mismatch")
    packet = json.loads(raw.decode("utf-8"))
    artifact = packet.get("artifact") if isinstance(packet.get("artifact"), dict) else {}
    identity = expected_return_artifact_identity(artifact)
    owner = str(row.get("model_name") or "")
    version = str(row.get("version") or "")
    expected_registry_id = f"{owner}:{version}:{checksum}"
    if (
        str(row.get("artifact_id") or "") != expected_registry_id
        or identity["artifact_id"] != f"{owner}:{version}"
        or str(artifact.get("model_fingerprint") or "") != identity["model_fingerprint"]
        or str(artifact.get("expected_return_owner") or "") != owner
        or str(packet.get("cohort_id") or "")
        != str((artifact.get("training_data") or {}).get("cohort_id") or "")
    ):
        raise ValueError("candidate_forward_packet_identity_mismatch")
    return {
        "registry": row,
        "packet": packet,
        "artifact": artifact,
        "identity": identity,
        "checksum": checksum,
        "path": path,
    }


def _bounded_prediction(value: float, clip: dict[str, Any]) -> float:
    lower = float(clip.get("min") if clip.get("min") is not None else -0.08)
    upper = float(clip.get("max") if clip.get("max") is not None else 0.08)
    return min(upper, max(lower, float(value)))


def _l4_prediction(sample: dict[str, Any], artifact: dict[str, Any]) -> float:
    intercept = float(artifact.get("intercept") or 0.0)
    coefficients = {
        str(name): float(value)
        for name, value in (artifact.get("coefficients") or {}).items()
    }
    names = [str(name) for name in (artifact.get("feature_names") or [])]
    if set(names) != set(coefficients) or any(name not in sample["features"] for name in names):
        raise ValueError("candidate_forward_l4_feature_contract_mismatch")
    raw = intercept + sum(coefficients[name] * float(sample["features"][name]) for name in names)
    return _bounded_prediction(raw, dict(artifact.get("output_clip") or {}))


def _l4_evidence_payload(
    sample: dict[str, Any],
    candidate: dict[str, Any],
    expected_return: float,
) -> dict[str, Any]:
    artifact = candidate["artifact"]
    source_row = sample["source_row"]
    prediction_date = str(sample["date"])
    trained_until = str(artifact.get("trained_until") or "")[:10]
    candidate_source_run_date = str(
        candidate["registry"].get("source_run_date") or ""
    )[:10]
    if not trained_until or trained_until > candidate_source_run_date:
        raise ValueError("candidate_forward_l4_trained_until_invalid")
    source_checksum = str(source_row.get("source_manifest_checksum") or "")
    cohort_id = str(source_row.get("cohort_id") or "")
    fold_id = str(source_row.get("fold_id") or "frozen_forward")
    return {
        "schema_version": "l4-alpha-ev-v1",
        "artifact_contract_version": artifact.get("artifact_contract_version"),
        "expected_return_owner": "l4_alpha_ev",
        "expected_return": expected_return,
        "expected_return_source": "exact_frozen_candidate_forward_evaluation",
        "feature_snapshot_version": artifact.get("feature_semantic_version"),
        "label_schema_version": artifact.get("label_schema_version"),
        "model_version": artifact.get("model_version"),
        "resolver_method": artifact.get("resolver_method"),
        "trained_until": trained_until,
        "horizon_days": artifact.get("horizon_days"),
        "cost_model_bps": artifact.get("cost_model_bps"),
        "output_is_net_of_costs": artifact.get("output_is_net_of_costs"),
        "generation_mode": "purged_oof",
        "approval_state": "purged_oof_evidence_only",
        "purged_oof_evidence_only": True,
        "cohort_id": cohort_id,
        "fold_id": fold_id,
        "source_manifest_checksum": source_checksum,
        "point_in_time_prediction_lineage": {
            "schema_version": "l4-point-in-time-prediction-lineage-v1",
            "as_of_guard": "label_known_date_strictly_before_prediction_date",
            "cohort_id": cohort_id,
            "fold_id": fold_id,
            "source_manifest_checksum": source_checksum,
            "feature_semantic_version": artifact.get("feature_semantic_version"),
            "prediction_date": prediction_date,
            "trained_until": trained_until,
            "candidate_source_run_date": candidate_source_run_date,
        },
    }


def _daily_evaluations(
    *,
    owner: str,
    candidate: dict[str, Any],
    samples: list[dict[str, Any]],
    predictions: list[float],
    baseline_predictions: list[float] | None = None,
) -> list[dict[str, Any]]:
    by_date: dict[str, list[tuple[dict[str, Any], float, float | None]]] = defaultdict(list)
    baselines = baseline_predictions or [None] * len(samples)
    for sample, prediction, baseline in zip(samples, predictions, baselines, strict=True):
        by_date[str(sample["date"])].append((sample, prediction, baseline))
    output: list[dict[str, Any]] = []
    for prediction_date, rows in sorted(by_date.items()):
        targets = [float(row[0]["actual_return_target"] if owner == "allocator_ev_fusion" else row[0]["target"]) for row in rows]
        values = [float(row[1]) for row in rows]
        corr = _corr(values, targets)
        spread, top_return = _spread(values, targets)
        baseline_values = [float(row[2]) for row in rows if row[2] is not None]
        baseline_corr = _corr(baseline_values, targets) if len(baseline_values) == len(rows) else None
        baseline_spread = _spread(baseline_values, targets)[0] if len(baseline_values) == len(rows) else None
        corr_delta = None if corr is None or baseline_corr is None else corr - baseline_corr
        spread_delta = None if baseline_spread is None else spread - baseline_spread
        baseline_complete = baseline_corr is not None and baseline_spread is not None
        if len(rows) < 20 or corr is None or not baseline_complete:
            quality = "INSUFFICIENT"
        elif owner == "l4_alpha_ev":
            quality = "PASS" if (corr_delta or 0.0) >= 0.0 and (spread_delta or 0.0) >= 0.0 and top_return > 0.0 else "DEGRADED"
        else:
            quality = "PASS" if (corr_delta or 0.0) >= 0.0 and (spread_delta or 0.0) >= 0.0 and top_return > 0.0 else "DEGRADED"
        identity_text = "|".join((
            str(candidate["registry"]["artifact_id"]),
            str(candidate["identity"]["model_fingerprint"]),
            prediction_date,
        ))
        output.append({
            "evaluation_id": hashlib.sha256(identity_text.encode("utf-8")).hexdigest(),
            "prediction_date": prediction_date,
            "label_known_date": max(
                str(row[0].get("label_known_date") or row[0].get("source_row", {}).get("label_known_date") or "")[:10]
                for row in rows
            ),
            "sample_count": len(rows),
            "prediction_corr": corr,
            "baseline_corr": baseline_corr,
            "corr_delta": corr_delta,
            "spread": spread,
            "baseline_spread": baseline_spread,
            "spread_delta": spread_delta,
            "top_return": top_return,
            "quality_decision": quality,
            "baseline_owner": (
                L4_BASELINE_OWNER if owner == "l4_alpha_ev" else FUSION_BASELINE_OWNER
            ),
        })
    return output


def _persist_evaluations(
    rows: list[dict[str, Any]],
    *,
    owner: str,
    candidate: dict[str, Any],
    cohort_id: str,
    extension_manifest_checksum: str,
    batch_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    registry = candidate["registry"]
    artifact_trained_until = str(candidate["artifact"].get("trained_until") or "")[:10]
    selection_semantic_floor_date = str(candidate.get("selection_semantic_floor_date") or "")[:10]
    statements: list[tuple[str, list[Any]]] = []
    for row in rows:
        evidence = {
            "schema_version": SCHEMA_VERSION,
            "candidate_artifact_id": registry["artifact_id"],
            "candidate_artifact_checksum": candidate["checksum"],
            "model_fingerprint": candidate["identity"]["model_fingerprint"],
            "cohort_id": cohort_id,
            "extension_manifest_checksum": extension_manifest_checksum,
            "artifact_trained_until": artifact_trained_until,
            "selection_semantic_floor_date": selection_semantic_floor_date,
            **row,
        }
        statements.append((
            """
            INSERT INTO expected_return_candidate_preoutcome_evaluations (
              evaluation_id, candidate_artifact_id, candidate_artifact_checksum,
              model_name, model_version, model_fingerprint, cohort_id,
              source_run_date, artifact_trained_until, selection_semantic_floor_date,
              extension_manifest_checksum, prediction_date,
              label_known_date, sample_count, prediction_corr, baseline_corr,
              corr_delta, spread, baseline_spread, spread_delta, top_return,
              quality_decision, evidence_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(candidate_artifact_id, model_fingerprint, prediction_date) DO UPDATE SET
              extension_manifest_checksum=excluded.extension_manifest_checksum,
              artifact_trained_until=excluded.artifact_trained_until,
              selection_semantic_floor_date=excluded.selection_semantic_floor_date,
              label_known_date=excluded.label_known_date,
              sample_count=excluded.sample_count,
              prediction_corr=excluded.prediction_corr,
              baseline_corr=excluded.baseline_corr,
              corr_delta=excluded.corr_delta,
              spread=excluded.spread,
              baseline_spread=excluded.baseline_spread,
              spread_delta=excluded.spread_delta,
              top_return=excluded.top_return,
              quality_decision=excluded.quality_decision,
              evidence_json=excluded.evidence_json,
              updated_at=CURRENT_TIMESTAMP
            """,
            [
                row["evaluation_id"], registry["artifact_id"], candidate["checksum"],
                owner, candidate["artifact"]["model_version"],
                candidate["identity"]["model_fingerprint"], cohort_id,
                str(registry.get("source_run_date") or "")[:10],
                artifact_trained_until, selection_semantic_floor_date,
                extension_manifest_checksum, row["prediction_date"],
                row["label_known_date"], row["sample_count"],
                row["prediction_corr"], row["baseline_corr"], row["corr_delta"],
                row["spread"], row["baseline_spread"], row["spread_delta"],
                row["top_return"], row["quality_decision"],
                json.dumps(evidence, ensure_ascii=False, sort_keys=True, allow_nan=False),
            ],
        ))
    return batch_fn(statements, timeout=30.0, chunk_size=20) if statements else {"changes": 0}


def _promotion_gate(
    rows: list[dict[str, Any]],
    *,
    owner: str,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    evaluable = [row for row in rows if row.get("quality_decision") in {"PASS", "DEGRADED"}]
    maturity_blockers: list[str] = []
    quality_blockers: list[str] = []
    contract_blockers: list[str] = []
    if len(evaluable) < MIN_EVALUABLE_DATES:
        maturity_blockers.append("prospective_date_count_below_floor")
    top_values = [float(row["top_return"]) for row in evaluable]
    top_lcb = _lcb90(top_values)
    top_ucb = _ucb90(top_values)
    if top_lcb is None or top_lcb <= 0.0:
        quality_blockers.append("prospective_top_return_lcb90_not_positive")
    if owner == "l4_alpha_ev":
        corr_values = [float(row["corr_delta"]) for row in evaluable if row.get("corr_delta") is not None]
        spread_values = [float(row["spread_delta"]) for row in evaluable if row.get("spread_delta") is not None]
        corr_lcb = _lcb90(corr_values)
        spread_lcb = _lcb90(spread_values)
        if corr_lcb is None or corr_lcb < 0.0:
            quality_blockers.append("prospective_corr_delta_lcb90_inferior_to_formal_ml")
        if spread_lcb is None or spread_lcb < 0.0:
            quality_blockers.append("prospective_spread_delta_lcb90_inferior_to_formal_ml")
    else:
        corr_values = [float(row["corr_delta"]) for row in evaluable if row.get("corr_delta") is not None]
        spread_values = [float(row["spread_delta"]) for row in evaluable if row.get("spread_delta") is not None]
        corr_lcb = _lcb90(corr_values)
        spread_lcb = _lcb90(spread_values)
        if corr_lcb is None or corr_lcb < 0.0:
            quality_blockers.append("prospective_corr_delta_lcb90_inferior_to_l4")
        if spread_lcb is None or spread_lcb < 0.0:
            quality_blockers.append("prospective_spread_delta_lcb90_inferior_to_l4")
        recent = evaluable[-2:]
        if len(recent) == 2 and all(
            float(row.get("corr_delta") or 0.0) < 0.0
            and float(row.get("spread_delta") or 0.0) < 0.0
            for row in recent
        ):
            quality_blockers.append("prospective_recent_two_dates_jointly_inferior")
    corr_ucb = _ucb90(corr_values)
    spread_ucb = _ucb90(spread_values)
    registry = candidate["registry"]
    offline_admission = _offline_admission(candidate)
    if offline_admission["decision"] != "PASS":
        contract_blockers.append("offline_admission_not_pass")
    parity = candidate.get("operational_parity") or candidate["packet"].get("operational_parity") or {}
    owner_parity = (parity.get("owner_decisions") or {}).get(owner) or {}
    if str(owner_parity.get("decision") or "").upper() != "PASS" or owner_parity.get("failed_gates"):
        contract_blockers.append("owner_operational_parity_not_pass")
    source_date = str(registry.get("source_run_date") or "")[:10]
    trained_until = str(candidate["artifact"].get("trained_until") or "")[:10]
    selection_semantic_floor_date = str(
        candidate.get("selection_semantic_floor_date") or ""
    )[:10]
    min_date = min((str(row["prediction_date"]) for row in evaluable), default=None)
    max_date = max((str(row["prediction_date"]) for row in evaluable), default=None)
    label_known_dates = [
        str(row.get("label_known_date") or "")[:10]
        for row in evaluable
        if len(str(row.get("label_known_date") or "")[:10]) == 10
    ]
    label_known_min = min(label_known_dates, default=None)
    label_known_max = max(label_known_dates, default=None)
    if not trained_until or trained_until > source_date:
        contract_blockers.append("candidate_trained_until_invalid")
    if min_date and min_date <= trained_until:
        contract_blockers.append("prediction_not_after_candidate_trained_until")
    if len(selection_semantic_floor_date) != 10:
        contract_blockers.append("selection_semantic_floor_missing")
    elif min_date and min_date < selection_semantic_floor_date:
        contract_blockers.append("prediction_before_selection_semantic_floor")
    if len(label_known_dates) != len(evaluable):
        contract_blockers.append("label_known_date_missing")
    if label_known_min and label_known_min <= source_date:
        contract_blockers.append("label_known_not_after_candidate_freeze")
    confidently_harmful = bool(
        (top_ucb is not None and top_ucb <= 0.0)
        or (
            corr_ucb is not None and corr_ucb < 0.0
            and spread_ucb is not None and spread_ucb < 0.0
        )
    )
    maximum_window_exhausted = len(evaluable) >= MAX_EVALUABLE_DATES
    decision = (
        "FAIL" if contract_blockers
        else "PENDING" if maturity_blockers
        else "PASS" if not quality_blockers
        else "FAIL" if confidently_harmful or maximum_window_exhausted
        else "HOLD"
    )
    failed = list(dict.fromkeys(contract_blockers + maturity_blockers + quality_blockers))
    return {
        "schema_version": GATE_SCHEMA_VERSION,
        "decision": decision,
        "failed_gates": failed,
        "maturity_blockers": maturity_blockers,
        "quality_blockers": quality_blockers,
        "contract_blockers": contract_blockers,
        "candidate_artifact_id": registry["artifact_id"],
        "candidate_artifact_checksum": candidate["checksum"],
        "model_fingerprint": candidate["identity"]["model_fingerprint"],
        "source_run_date": source_date,
        "artifact_trained_until": trained_until,
        "selection_semantic_floor_date": selection_semantic_floor_date or None,
        "minimum_evaluable_dates": MIN_EVALUABLE_DATES,
        "maximum_evaluable_dates": MAX_EVALUABLE_DATES,
        "evaluable_date_count": len(evaluable),
        "prediction_date_min": min_date,
        "prediction_date_max": max_date,
        "label_known_date_min": label_known_min,
        "label_known_date_max": label_known_max,
        "corr_or_delta_lcb90": corr_lcb,
        "corr_or_delta_ucb90": corr_ucb,
        "spread_or_delta_lcb90": spread_lcb,
        "spread_or_delta_ucb90": spread_ucb,
        "top_return_lcb90": top_lcb,
        "top_return_ucb90": top_ucb,
        "confidently_harmful": confidently_harmful,
        "maximum_window_exhausted": maximum_window_exhausted,
        "offline_admission": offline_admission,
        "operational_parity": parity,
        "baseline_owner": (
            L4_BASELINE_OWNER if owner == "l4_alpha_ev" else FUSION_BASELINE_OWNER
        ),
        "comparison_mode": "same_prediction_date_paired_cross_section",
        "evaluation_unit": "pre_outcome_locked_prediction_date",
        "no_lookahead_guard": "prediction_after_trained_until_and_label_unknown_at_freeze",
        "training_dispatched": False,
    }


def _preoutcome_locked_rows(
    snapshot_rows: list[dict[str, Any]],
    *,
    candidates: dict[str, dict[str, Any]],
    source_date: str,
    business_date: str,
    selection_semantic_floor_date: str,
) -> list[dict[str, Any]]:
    trained_until_dates = [
        str(candidate["artifact"].get("trained_until") or "")[:10]
        for candidate in candidates.values()
    ]
    if (
        not trained_until_dates
        or len(selection_semantic_floor_date) != 10
        or any(len(value) != 10 or value > source_date for value in trained_until_dates)
    ):
        return []
    evidence_trained_until = max(trained_until_dates)
    return [
        row for row in snapshot_rows
        if str(row.get("fold_id") or "") == "frozen_forward"
        and str(row.get("snapshot_date") or "")[:10] > evidence_trained_until
        and str(row.get("snapshot_date") or "")[:10] >= selection_semantic_floor_date
        and str(row.get("label_known_date") or "")[:10] > source_date
        and str(row.get("label_known_date") or "")[:10] <= business_date
    ]


def _selection_semantic_floor_date(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    business_date: str,
) -> str | None:
    rows = query_fn(
        """
        SELECT MIN(signal_date) AS selection_semantic_floor_date
          FROM strategy_route_backfill_eligibility_v1
         WHERE route_version=?
           AND affinity_version=?
           AND status IN ('eligible','pending_maturity')
           AND reference_rows > 0
           AND signal_date <= ?
        """,
        [
            SELECTION_ROUTE_SEMANTIC_VERSION,
            SELECTION_AFFINITY_SEMANTIC_VERSION,
            business_date,
        ],
    )
    value = str((rows[0] if rows else {}).get("selection_semantic_floor_date") or "")[:10]
    return value if len(value) == 10 else None


def evaluate_expected_return_candidates_forward(
    *,
    bucket: Any,
    cohort_id: str,
    business_date: str,
    extension_manifest_checksum: str,
    snapshot_rows: list[dict[str, Any]],
    native_rows: list[dict[str, Any]] | None = None,
    build_fusion_rows_fn: Callable[..., list[dict[str, Any]]],
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    batch_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Evaluate exact candidates on immutable rows whose labels were unknown at freeze."""

    selected, activate = _candidate_rows(query_fn, cohort_id)
    if not selected:
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "offline_admissible_candidate_missing",
            "promotion_ready": False,
            "training_dispatched": False,
        }
    candidates = {
        owner: _load_candidate_packet(bucket, row)
        for owner, row in selected.items()
    }
    if native_rows is not None:
        from services.ev_operational_parity import assess_ev_operational_parity

        parity = assess_ev_operational_parity(
            l4_artifact=candidates["l4_alpha_ev"]["artifact"],
            fusion_artifact=(
                candidates["allocator_ev_fusion"]["artifact"]
                if "allocator_ev_fusion" in candidates
                else {}
            ),
            native_rows=native_rows,
        )
        for candidate in candidates.values():
            candidate["operational_parity"] = parity
    source_date = str(selected["l4_alpha_ev"].get("source_run_date") or "")[:10]
    selection_semantic_floor_date = _selection_semantic_floor_date(query_fn, business_date)
    for candidate in candidates.values():
        candidate["selection_semantic_floor_date"] = selection_semantic_floor_date
    preoutcome_locked_rows = _preoutcome_locked_rows(
        snapshot_rows,
        candidates=candidates,
        source_date=source_date,
        business_date=business_date,
        selection_semantic_floor_date=selection_semantic_floor_date or "",
    )
    if not preoutcome_locked_rows:
        gates = {
            owner: _promotion_gate([], owner=owner, candidate=candidate)
            for owner, candidate in candidates.items()
        }
        terminal_contract_failure = any(gate["decision"] == "FAIL" for gate in gates.values())
        lane_persistence = _persist_candidate_gate_state(
            candidates=candidates,
            gates=gates,
            activate=activate,
            batch_fn=batch_fn,
        )
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "evaluated" if terminal_contract_failure else "waiting_for_preoutcome_locked_mature_dates",
            "candidate_source_run_date": source_date,
            "selection_semantic_floor_date": selection_semantic_floor_date,
            "candidate_artifact_ids": {
                owner: candidate["registry"]["artifact_id"]
                for owner, candidate in candidates.items()
            },
            "gates": gates,
            "lane_persistence": lane_persistence,
            "preoutcome_locked_rows": 0,
            "promotion_ready": False,
            "training_dispatched": False,
        }

    l4_candidate = candidates["l4_alpha_ev"]
    l4_sample_rows, l4_diagnostics = _l4_samples(preoutcome_locked_rows)
    l4_predictions = [_l4_prediction(sample, l4_candidate["artifact"]) for sample in l4_sample_rows]
    l4_baseline_predictions = [
        float(sample["features"]["ensemble_directional_margin"])
        for sample in l4_sample_rows
    ]
    l4_daily = _daily_evaluations(
        owner="l4_alpha_ev",
        candidate=l4_candidate,
        samples=l4_sample_rows,
        predictions=l4_predictions,
        baseline_predictions=l4_baseline_predictions,
    )
    l4_prediction_rows = []
    candidate_trained_until = str(l4_candidate["artifact"].get("trained_until") or "")[:10]
    for sample, prediction in zip(l4_sample_rows, l4_predictions, strict=True):
        source = sample["source_row"]
        payload = _l4_evidence_payload(sample, l4_candidate, prediction)
        l4_prediction_rows.append({
            "cohort_id": source["cohort_id"],
            "fold_id": source["fold_id"],
            "prediction_date": sample["date"],
            "symbol": source["symbol"],
            "market_segment": source["market_segment"],
            "eligible_for_efficacy": 1,
            "trained_until": candidate_trained_until,
            "expected_return": prediction,
            "prediction_json": json.dumps(payload, ensure_ascii=False, sort_keys=True),
        })

    fusion_daily: list[dict[str, Any]] = []
    fusion_diagnostics: dict[str, Any] = {"status": "offline_admission_not_ready"}
    if "allocator_ev_fusion" in candidates:
        fusion_rows = build_fusion_rows_fn(
            preoutcome_locked_rows,
            l4_prediction_rows,
            knowledge_cutoff_date=business_date,
            query_fn=query_fn,
        )
        fusion_samples, fusion_diagnostics = _fusion_samples(fusion_rows, execution_cost_bps=18.0)
        fusion_candidate = candidates["allocator_ev_fusion"]
        residual = fusion_candidate["artifact"].get("residual_adjustment_model") or {}
        residual_intercept = float(residual.get("intercept") or 0.0)
        residual_coefficients = {
            str(name): float(value)
            for name, value in (residual.get("coefficients") or {}).items()
        }
        residual_clip = dict(fusion_candidate["artifact"].get("residual_output_clip") or {})
        baseline_predictions = [float(sample["features"]["l4_expected_return"]) for sample in fusion_samples]
        fusion_predictions = [
            base + _bounded_prediction(
                _predict_fusion(sample, residual_intercept, residual_coefficients),
                residual_clip,
            )
            for sample, base in zip(fusion_samples, baseline_predictions, strict=True)
        ]
        fusion_daily = _daily_evaluations(
            owner="allocator_ev_fusion",
            candidate=fusion_candidate,
            samples=fusion_samples,
            predictions=fusion_predictions,
            baseline_predictions=baseline_predictions,
        )

    daily_by_owner = {
        "l4_alpha_ev": l4_daily,
        **({"allocator_ev_fusion": fusion_daily} if "allocator_ev_fusion" in candidates else {}),
    }
    persistence = {
        owner: _persist_evaluations(
            daily,
            owner=owner,
            candidate=candidates[owner],
            cohort_id=cohort_id,
            extension_manifest_checksum=extension_manifest_checksum,
            batch_fn=batch_fn,
        )
        for owner, daily in daily_by_owner.items()
    }
    gates: dict[str, dict[str, Any]] = {}
    promotion_payload: dict[str, Any] = {}
    for owner, candidate in candidates.items():
        stored = query_fn(
            """
            SELECT prediction_date, label_known_date, sample_count,
                   prediction_corr, baseline_corr, corr_delta, spread,
                   baseline_spread, spread_delta, top_return, quality_decision
              FROM expected_return_candidate_preoutcome_evaluations
             WHERE candidate_artifact_id=? AND model_fingerprint=?
             ORDER BY prediction_date
            """,
            [candidate["registry"]["artifact_id"], candidate["identity"]["model_fingerprint"]],
        )
        gate = _promotion_gate(stored, owner=owner, candidate=candidate)
        gates[owner] = gate
        if (
            gate["decision"] == "PASS"
            and str(candidate["registry"].get("state") or "") != "production"
        ):
            promotion_payload[owner] = {
                "artifact_id": candidate["registry"]["artifact_id"],
                "artifact": candidate["artifact"],
                "validation_packet": candidate["packet"].get("validation_packet") or {},
                "offline_admission": gate["offline_admission"],
                "operational_parity": candidate.get("operational_parity") or candidate["packet"].get("operational_parity") or {},
                "prospective_validation": gate,
                "cohort_id": cohort_id,
                "source_run_date": candidate["registry"]["source_run_date"],
                "cadence": "daily_candidate_forward",
                "artifact_path": candidate["path"],
                "artifact_checksum": candidate["checksum"],
            }
    lane_persistence = _persist_candidate_gate_state(
        candidates=candidates,
        gates=gates,
        activate=activate,
        batch_fn=batch_fn,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "evaluated",
        "candidate_source_run_date": source_date,
        "selection_semantic_floor_date": selection_semantic_floor_date,
        "candidate_states": {
            owner: str(candidate["registry"].get("state") or "")
            for owner, candidate in candidates.items()
        },
        "preoutcome_locked_rows": len(preoutcome_locked_rows),
        "l4_sample_audit": l4_diagnostics,
        "fusion_sample_audit": fusion_diagnostics,
        "daily_evaluations": {
            **daily_by_owner,
        },
        "gates": gates,
        "persistence": persistence,
        "lane_persistence": lane_persistence,
        "promotion_ready": bool(promotion_payload),
        "promotion_payload": promotion_payload,
        "training_dispatched": False,
    }
