"""Serving-parity gate for OOF-trained L4 and Fusion candidates."""

from __future__ import annotations

import json
from typing import Any

from services.allocator_ev_fusion import materialize_allocator_ev_fusion
from services.l4_alpha_ev_resolver import extract_l4_alpha_ev
from services.l4_alpha_ev_artifact_builder import FEATURE_NAMES, _feature_vector
from services.l4_alpha_ev_producer import _feature_value, materialize_l4_alpha_ev

MIN_PARITY_ROWS = 20
MIN_SERVING_COVERAGE = 0.98


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def assess_ev_operational_parity(
    *,
    l4_artifact: dict[str, Any],
    fusion_artifact: dict[str, Any],
    native_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Require identical feature semantics and successful production materializers."""

    l4_validation = _loads(l4_artifact.get("validation_packet"))
    fusion_validation = _loads(fusion_artifact.get("validation_packet"))
    # This gate checks whether the exact candidate can execute through the
    # production materializers. Efficacy remains owned by the offline and
    # prospective gates, so their FAIL decision must not make parity fail by
    # construction before the materializer contract is exercised.
    l4_candidate = {
        **l4_artifact,
        "validation_packet": {
            **l4_validation,
            "decision": "PASS",
            "failed_gates": [],
        },
        "promotion_state": "production_approved",
        "approval_state": "production_approved",
    }
    fusion_candidate = {
        **fusion_artifact,
        "validation_packet": {
            **fusion_validation,
            "decision": "PASS",
            "failed_gates": [],
        },
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "operational_parity_required": False,
    }
    comparable = 0
    feature_mismatches: list[dict[str, Any]] = []
    l4_materialization_blockers: dict[str, int] = {}
    fusion_materialization_blockers: dict[str, int] = {}
    l4_loaded = 0
    fusion_loaded = 0
    for row in native_rows:
        prediction = _loads(row.get("forecast_data"))
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction"):
            prediction.pop(key, None)
        ensemble = prediction.get("ensemble_v2") if isinstance(prediction.get("ensemble_v2"), dict) else {}
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction"):
            ensemble.pop(key, None)
        parsed_row = {
            **row,
            "score_components": _loads(row.get("score_components")),
            "alpha_context": _loads(row.get("alpha_context")),
            "alpha_allocation": _loads(row.get("alpha_allocation")),
        }
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction"):
            parsed_row.pop(key, None)
        builder_features = _feature_vector(parsed_row)
        if builder_features is None:
            continue
        comparable += 1
        for name in FEATURE_NAMES:
            serving_value = _feature_value(name, parsed_row, prediction)
            if serving_value is None or abs(float(serving_value) - float(builder_features[name])) > 1e-9:
                feature_mismatches.append({
                    "symbol": row.get("symbol"),
                    "date": row.get("prediction_date") or row.get("snapshot_date") or row.get("date"),
                    "feature": name,
                    "builder": builder_features[name],
                    "serving": serving_value,
                })
        l4_payload = materialize_l4_alpha_ev(
            parsed_row,
            prediction=prediction,
            policy=l4_candidate,
        )
        if isinstance(l4_payload, dict) and l4_payload.get("status") == "loaded":
            l4_loaded += 1
            parsed_row["l4_alpha_ev"] = l4_payload
        elif isinstance(l4_payload, dict):
            for blocker in l4_payload.get("blockers") or ["l4_materializer_not_loaded"]:
                key = str(blocker)
                l4_materialization_blockers[key] = l4_materialization_blockers.get(key, 0) + 1
        l4_value, l4_source, resolved_l4_payload = extract_l4_alpha_ev(parsed_row)
        alpha_context = parsed_row.get("alpha_context") or {}
        fusion_payload = materialize_allocator_ev_fusion(
            parsed_row,
            l4_value=l4_value,
            l4_source=l4_source,
            l4_payload=resolved_l4_payload,
            market_heat_expected_return=float(alpha_context.get("market_heat_expected_return") or 0.0),
            policy=fusion_candidate,
        )
        if isinstance(fusion_payload, dict) and fusion_payload.get("status") == "loaded":
            fusion_loaded += 1
        elif isinstance(fusion_payload, dict):
            for blocker in fusion_payload.get("blockers") or ["fusion_materializer_not_loaded"]:
                key = str(blocker)
                fusion_materialization_blockers[key] = fusion_materialization_blockers.get(key, 0) + 1

    denominator = max(1, comparable)
    l4_coverage = l4_loaded / denominator
    fusion_coverage = fusion_loaded / denominator
    shared_blockers = []
    if comparable < MIN_PARITY_ROWS:
        shared_blockers.append("insufficient_complete_native_parity_rows")
    if feature_mismatches:
        shared_blockers.append("training_serving_feature_mismatch")
    l4_blockers = list(shared_blockers)
    if l4_coverage < MIN_SERVING_COVERAGE:
        l4_blockers.append("l4_serving_coverage_below_98pct")
    fusion_blockers = list(l4_blockers)
    if fusion_coverage < MIN_SERVING_COVERAGE:
        fusion_blockers.append("fusion_serving_coverage_below_98pct")
    blockers = list(dict.fromkeys([*l4_blockers, *fusion_blockers]))
    owner_decisions = {
        "l4_alpha_ev": {
            "decision": "PASS" if not l4_blockers else "FAIL",
            "failed_gates": l4_blockers,
            "serving_coverage": l4_coverage,
        },
        "allocator_ev_fusion": {
            "decision": "PASS" if not fusion_blockers else "FAIL",
            "failed_gates": fusion_blockers,
            "serving_coverage": fusion_coverage,
            "requires_l4_parity": True,
        },
    }
    return {
        "schema_version": "ev-operational-parity-v2",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "owner_decisions": owner_decisions,
        "native_rows": len(native_rows),
        "comparable_rows": comparable,
        "feature_mismatch_count": len(feature_mismatches),
        "feature_mismatch_examples": feature_mismatches[:20],
        "l4_serving_coverage": l4_coverage,
        "fusion_serving_coverage": fusion_coverage,
        "l4_materialization_blocker_counts": l4_materialization_blockers,
        "fusion_materialization_blocker_counts": fusion_materialization_blockers,
        "minimum_rows": MIN_PARITY_ROWS,
        "minimum_serving_coverage": MIN_SERVING_COVERAGE,
        "labels_required": False,
        "purpose": "training_serving_contract_and_materializer_parity_only",
        "validation_override_scope": "operational_parity_simulation_only",
    }
