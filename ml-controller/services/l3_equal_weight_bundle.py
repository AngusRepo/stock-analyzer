"""R33 L4 bundle: seven-model equal z with the cross-fit isotonic E-hat (R33-NEW-05).

The bundle owns no numbers of its own. z, score and E-hat come from the attested
rank pool (services.r33_rank_pool), which reads the L3 ensemble's serving table;
the bundle only binds those identities so the L4 release and the plan can be
replayed. The allocator receives E-hat as five-session pool-relative excess.
"""
from __future__ import annotations

from datetime import date

from services.l4_distribution import LABEL_SCHEMA, SCHEMA, digest
from services.r33_ensemble import validate_ensemble
from services.r33_isotonic_calibration import MODELS
from services.r33_rank_pool import IDENTITY_FIELDS, validate_rank_pool

MODEL_SCHEMA = "r33-seven-model-equal-z-isotonic-v1"
RECIPE = "r33-equal7-isotonic-v1"
FEATURE_SCHEMA = "r33-seven-model-ranks-and-availability-v1"
FEATURE_NAMES = (*(f"{m}_{k}" for m in MODELS for k in ("z", "available")), "score")
UTILITY_SEMANTIC = "five_session_relative_pool_decimal"
_EVIDENCE_FIELDS = ("role", "held", "z", "available", "score", "expected_excess", "unscored_reason")


def is_equal7(bundle) -> bool:
    return ((bundle or {}).get("model") or {}).get("schema_version") == MODEL_SCHEMA


def build_bundle(*, l3_identity: dict, ensemble: dict, training_label_known_max: str) -> dict:
    """Unreleased bundle; the paper release is attached by the release owner."""
    validate_ensemble(ensemble)
    if any(l3_identity.get(k) != ensemble.get(k) for k in IDENTITY_FIELDS):
        raise ValueError("r33_bundle_l3_identity")
    model = dict(schema_version=MODEL_SCHEMA, recipe_version=RECIPE, model_order=list(MODELS),
                 feature_names=list(FEATURE_NAMES), ensemble_payload_checksum=ensemble["payload_checksum"],
                 calibration_checksum=ensemble["serving_calibration"]["payload_checksum"])
    return dict(schema_version=SCHEMA, feature_schema=FEATURE_SCHEMA, label_schema=LABEL_SCHEMA, horizon_sessions=5,
                l3_identity=dict(l3_identity), training_label_known_max=training_label_known_max,
                model=model, model_checksum=digest(model))


def validate(bundle: dict, *, l3_identity: dict, signal_date: str) -> None:
    model = bundle.get("model") or {}
    if (not is_equal7(bundle) or bundle.get("schema_version") != SCHEMA
            or bundle.get("feature_schema") != FEATURE_SCHEMA or bundle.get("label_schema") != LABEL_SCHEMA
            or bundle.get("horizon_sessions") != 5 or model.get("recipe_version") != RECIPE
            or model.get("model_order") != list(MODELS) or model.get("feature_names") != list(FEATURE_NAMES)
            or set(model) != {"schema_version", "recipe_version", "model_order", "feature_names",
                              "ensemble_payload_checksum", "calibration_checksum"}):
        raise ValueError("r33_bundle_contract")
    if not l3_identity or bundle.get("l3_identity") != l3_identity:
        raise ValueError("r33_bundle_l3_identity")
    if model["ensemble_payload_checksum"] != l3_identity.get("payload_checksum"):
        raise ValueError("r33_bundle_ensemble_mismatch")
    if bundle.get("model_checksum") != digest(model):
        raise ValueError("r33_bundle_model_checksum")
    if date.fromisoformat(bundle["training_label_known_max"]) >= date.fromisoformat(signal_date):
        raise ValueError("r33_bundle_training_after_signal")


def project(snapshot: dict, *, bundle: dict, identity: dict, signal_date: str, candidates, holdings, predictions):
    """Allocator inputs from the attested rank pool.

    Returns (feature_rows, outputs, unscored, evidence, projection). Scored candidates are
    modeled; a candidate the pool did not score, or never saw, is unavailable for
    this day with its reason (never the whole plan). Held names keep their E-hat
    in outputs whether or not they are candidates, for the decay exit; evidence
    carries each name's z/score/E-hat (or its unscored reason) into the plan.
    """
    validate_rank_pool(snapshot, predictions)
    model = bundle["model"]
    if (snapshot["signal_date"] != signal_date or snapshot["l3_identity"] != identity
            or snapshot["model_order"] != list(MODELS)
            or snapshot["calibration_checksum"] != model["calibration_checksum"]):
        raise ValueError("r33_rank_pool_identity_mismatch")
    rows = {row["symbol"]: row for row in snapshot["rows"]}
    feature_rows, outputs, unscored, evidence = [], {}, {}, {}
    for symbol in sorted(set(candidates) | set(holdings)):
        row = rows.get(symbol)
        evidence[symbol] = None if row is None else {k: row[k] for k in _EVIDENCE_FIELDS}
        if row is None or row["expected_excess"] is None:
            reason = "r33_rank_pool_missing" if row is None else "r33_unscored:" + row["unscored_reason"]
            unscored[symbol] = [reason]
            continue
        features = {**{f"{m}_z": row["z"][m] for m in MODELS},
                    **{f"{m}_available": int(row["available"][m]) for m in MODELS}, "score": row["score"]}
        outputs[symbol] = dict(expected_return_gross=row["expected_excess"], expected_return_semantic=UTILITY_SEMANTIC,
                               score=row["score"], role=row["role"], mean_policy=RECIPE,
                               model_checksum=bundle["model_checksum"])
        if symbol in candidates:
            feature_rows.append(dict(symbol=symbol, features={k: features[k] for k in FEATURE_NAMES}))
    projection = dict(schema_version="r33-rank-pool-projection-v1", recipe=RECIPE, signal_date=signal_date,
                      pool_checksum=snapshot["pool_checksum"], rank_pool_checksum=snapshot["checksum"],
                      calibration_checksum=model["calibration_checksum"],
                      ensemble_payload_checksum=model["ensemble_payload_checksum"], model_checksum=bundle["model_checksum"],
                      coverage=snapshot["coverage"], unscored=unscored, forecasts_checksum=digest(outputs))
    return feature_rows, outputs, unscored, evidence, {**projection, "checksum": digest(projection)}

