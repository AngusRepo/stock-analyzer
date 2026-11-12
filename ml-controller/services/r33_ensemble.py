"""R33 ensemble object: seven equal-weight models and the cross-fit serving table (slice A §2).

The object binds the seven base artifacts, the sealed monthly bundle it came from
and the serving calibration under one payload checksum. Every consumer validates
the whole object first, so a pointer cannot claim one identity and carry another
roster or table.
"""
from __future__ import annotations

import math
import re

from services.r33_crossfit_serving import validate_serving
from services.r33_isotonic_calibration import MODELS, checksum

EVIDENCE_KEY = "r33_rank_evidence"     # predictions[symbol][EVIDENCE_KEY], written by services.r33_rank_pool

SCHEMA = "r33-equal7-ensemble-v1"
KIND = "r33_equal7_isotonic"
_BODY = ("schema_version", "kind", "cohort_id", "model_order", "selected_models", "base_artifacts",
         "observation_artifacts", "base_artifact_set_checksum", "variant", "source_bundle",
         "serving_calibration", "validation")
_ARTIFACT = ("artifact_id", "version", "checksum")
_SOURCE = ("path", "sha256", "manifest_checksum", "oof_checks_checksum", "source_calibration_checksum")
_VALIDATION = ("decision", "oof_checks_status", "pit_certified", "pit_certification_sha256")
_HEX = re.compile(r"[0-9a-f]{64}")
_REGISTRY_CHECKSUM = re.compile(r"(?:sha256:)?[0-9a-f]{64}")     # model_artifact_registry stores "sha256:<hex>"


def _sha(value) -> bool:
    return isinstance(value, str) and _HEX.fullmatch(value) is not None


def r33_artifact_id(ensemble: dict) -> str:
    """Derived from the claimed payload checksum, like the active8 id; validate_ensemble proves it."""
    return f"r33-equal7:{ensemble.get('cohort_id')}:{str(ensemble.get('payload_checksum'))[:16]}"


def _sealed(body: dict) -> dict:
    payload = checksum(body)
    return {**body, "artifact_id": r33_artifact_id({**body, "payload_checksum": payload}), "payload_checksum": payload}


def build_ensemble(*, cohort_id: str, base_artifacts: dict, source_bundle: dict, serving_calibration: dict,
                   validation: dict) -> dict:
    artifacts = {m: {k: base_artifacts[m][k] for k in _ARTIFACT} for m in MODELS}
    body = dict(schema_version=SCHEMA, kind=KIND, cohort_id=cohort_id, model_order=list(MODELS),
                selected_models=list(MODELS), base_artifacts=artifacts,
                observation_artifacts={m: dict(v) for m, v in artifacts.items()},
                base_artifact_set_checksum=checksum(artifacts), variant=serving_calibration["variant"],
                source_bundle={k: source_bundle[k] for k in _SOURCE}, serving_calibration=serving_calibration,
                validation={k: validation[k] for k in _VALIDATION})
    ensemble = _sealed(body)
    validate_ensemble(ensemble)
    return ensemble


def is_r33(ensemble) -> bool:
    return isinstance(ensemble, dict) and ensemble.get("kind") == KIND


def validate_ensemble(ensemble: dict) -> dict:
    """The whole object, recomputed: roster, artifact set, source, serving table, checksum, id.

    payload_checksum covers every field except artifact_id (derived from it) and
    itself; this is not the active8 convention, so r33 objects are validated here only.
    """
    if not isinstance(ensemble, dict) or set(ensemble) != {*_BODY, "artifact_id", "payload_checksum"}:
        raise ValueError("r33_ensemble_contract")
    artifacts, source = ensemble["base_artifacts"], ensemble["source_bundle"]
    validation = ensemble["validation"]
    if (ensemble["schema_version"] != SCHEMA or ensemble["kind"] != KIND
            or not isinstance(ensemble["cohort_id"], str) or not ensemble["cohort_id"]
            or ensemble["model_order"] != list(MODELS) or ensemble["selected_models"] != list(MODELS)
            or not isinstance(artifacts, dict) or set(artifacts) != set(MODELS)
            or any(not isinstance(artifacts[m], dict) or set(artifacts[m]) != set(_ARTIFACT)
                   or not isinstance(artifacts[m]["artifact_id"], str) or not artifacts[m]["artifact_id"]
                   or not isinstance(artifacts[m]["version"], str) or not artifacts[m]["version"]
                   or not isinstance(artifacts[m]["checksum"], str)
                   or _REGISTRY_CHECKSUM.fullmatch(artifacts[m]["checksum"]) is None for m in MODELS)
            or ensemble["observation_artifacts"] != artifacts
            or not isinstance(source, dict) or set(source) != set(_SOURCE)
            or not isinstance(source["path"], str) or not source["path"]
            or not all(_sha(source[k]) for k in _SOURCE[1:])
            or not isinstance(validation, dict) or set(validation) != set(_VALIDATION)
            or validation["decision"] != "PASS" or validation["oof_checks_status"] != "pass"
            or validation["pit_certified"] is not True or not _sha(validation["pit_certification_sha256"])):
        raise ValueError("r33_ensemble_contract")
    if ensemble["base_artifact_set_checksum"] != checksum(artifacts):
        raise ValueError("r33_ensemble_artifact_set_checksum")
    calibration = validate_serving(ensemble["serving_calibration"],
                                   source_checksum=source["source_calibration_checksum"])
    if ensemble["variant"] != calibration["variant"]:
        raise ValueError("r33_ensemble_contract")
    if _sealed({k: ensemble[k] for k in _BODY}) != ensemble:
        raise ValueError("r33_ensemble_payload_checksum")
    return ensemble


RUNTIME_SCHEMA = "r33-equal7-runtime-v1"
RECIPE = "r33-equal7-isotonic-v1"
SIGNAL_POLICY = "r33-ehat-round-trip-cost-signal-v1"
COVERAGE_POLICY = "r33-equal7-missing-model-z0-v1"
EHAT_SEMANTIC = "five_session_relative_pool_decimal"


def round_trip_cost(fees: dict) -> float:
    """Entry plus exit cost from the trading:config.fees owner (buy_cost + sell_cost)."""
    commission, tax = float(fees["commission"]), float(fees["tax"])
    cost = commission + (commission + tax)
    if not (math.isfinite(cost) and cost > 0):
        raise ValueError("r33_round_trip_cost_invalid")
    return cost


def formal_contract(prediction: dict | None) -> dict:
    """R33 coverage contract: a missing model is z=0 and an unscored name is a per-name gap
    reported downstream (L4 unavailable with its reason), never a drop here (R4)."""
    evidence = (prediction or {}).get(EVIDENCE_KEY) if isinstance(prediction, dict) else None
    available = (evidence or {}).get("available") or {}
    reason = ("r33_rank_pool_missing" if evidence is None
              else None if evidence.get("expected_excess") is not None else "r33_unscored:" + evidence["unscored_reason"])
    return {
        "schema_version": "formal-layer3-r33-coverage-contract-v1",
        "active_models": list(MODELS), "required_models": [], "minimum_required_cross_sectional_models": 0,
        "optional_sequence_models": [], "available_models": [m for m in MODELS if available.get(m)],
        "missing_models": [m for m in MODELS if not available.get(m)], "missing_core_models": [],
        "missing_optional_models": [], "model_availability": {m: bool(available.get(m)) for m in MODELS},
        "full_active8_coverage": all(available.get(m) for m in MODELS), "complete": True,
        "coverage_policy": COVERAGE_POLICY, "finite_scores_required": True,
        "score_semantic_version": None, "target_semantic_version": EHAT_SEMANTIC,
        "lineage_blockers": [], "r33_scored": reason is None, "r33_unscored_reason": reason}


def serving_view(prediction: dict, ensemble: dict, *, cost: float) -> dict:
    """ensemble_v2 for an R33 row: E-hat from the attested rank pool, signal from E-hat vs cost.

    The signal is display and evidence only (BUY: E-hat > round trip; SELL: E-hat <= 0;
    otherwise HOLD; NO_SIGNAL when the pool did not score the name). The allocator owns
    the decision. There is no probability and no confidence estimate for R33.
    """
    if not (isinstance(cost, float) and math.isfinite(cost) and cost > 0):
        raise ValueError("r33_round_trip_cost_invalid")
    calibration = ensemble["serving_calibration"]
    evidence = prediction.get(EVIDENCE_KEY)
    if evidence is not None and evidence.get("calibration_checksum") != calibration["payload_checksum"]:
        raise ValueError("r33_rank_evidence_calibration_mismatch")
    ehat = None if evidence is None else evidence.get("expected_excess")
    if ehat is None:
        signal = "NO_SIGNAL"
    else:
        signal = "BUY" if ehat > cost else "SELL" if ehat <= 0 else "HOLD"
    values = [float(block["mean_excess"]) for block in calibration["blocks"]]
    low, high = min(values), max(values)
    position = None if ehat is None else (0.5 if high == low else (ehat - low) / (high - low))
    contract = formal_contract(prediction)
    weights = {m: round(1 / len(MODELS), 8) for m in MODELS}
    return {
        "model_order": list(MODELS), "schema_version": RUNTIME_SCHEMA, "semantic_version": RECIPE,
        "artifact_id": ensemble["artifact_id"], "artifact_checksum": ensemble["payload_checksum"],
        "cohort_id": ensemble["cohort_id"], "base_artifact_set_checksum": ensemble["base_artifact_set_checksum"],
        "calibration_checksum": calibration["payload_checksum"], "target_semantic_version": EHAT_SEMANTIC,
        "lineage_status": "complete" if ehat is not None else "unscored",
        "lineage_blockers": [] if ehat is not None else [contract["r33_unscored_reason"]],
        "signal": signal, "unqualified_signal": signal, "advisory_signal": signal, "signal_role": "advisory_only",
        "final_decision_owner": "allocator_opb_policy",
        "signal_status": "unscored" if ehat is None else "market_hold" if signal == "HOLD" else "qualified",
        "signal_blockers": [], "qualifications": None, "signal_source": "r33_equal7_isotonic",
        "signal_policy": {"schema_version": SIGNAL_POLICY, "buy_rule": "ehat_gt_round_trip_cost",
                          "sell_rule": "ehat_le_zero", "round_trip_cost": cost,
                          "cost_owner": "trading:config.fees(buy_cost+sell_cost)", "top_k": None},
        "confidence": 0.0, "confidence_semantic": "not_estimated_r33",
        "probability_positive_net_return": None,
        "ehat_range_position": None if position is None else round(min(1.0, max(0.0, position)), 6),
        "forecast_pct": ehat, "forecast_pct_source": "r33_isotonic_pool_relative_excess",
        "forecast_return_5bar": ehat, "forecast_return_5bar_source": "r33_isotonic_pool_relative_excess",
        "forecast_return_5bar_owner": "r33_equal7_isotonic", "forecast_horizon_bars": 5,
        "ml_expected_net_return": None,
        "expected_return": None, "expected_return_source": "allocator_ev_fusion_required",
        "expected_return_owner": "allocator_ev_fusion",
        "trade_expected_return_net_pct": None, "trade_expected_return_source": "allocator_ev_fusion_required",
        "contributing_models": contract["available_models"], "model_availability": contract["model_availability"],
        "weights": weights, "weight_semantic": "r33_equal_weight_denominator_seven", "weight_total": 1.0,
        "formal_model_input_contract": contract, "validation": ensemble["validation"], "top_k": None,
        "r33": None if evidence is None else {k: evidence[k] for k in
                                              ("role", "held", "z", "available", "score", "expected_excess", "unscored_reason")},
    }
