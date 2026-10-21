"""R33 model identity and forecast projection; release still has one owner."""
from datetime import date
import re

from services.l3_equal_weight import MODELS, RECIPE, calibrated_scores, validate_calibration
from services.l4_distribution import SCHEMA, LABEL_SCHEMA, digest

MODEL_SCHEMA = "r33-seven-model-equal-rank-linear-v1"
FEATURE_SCHEMA = "r33-seven-model-ranks-and-availability-v1"
FEATURE_NAMES = tuple(f"{m}_{field}" for m in MODELS for field in ("rank", "available"))


def is_equal7(bundle):
    return ((bundle or {}).get("model") or {}).get("schema_version") == MODEL_SCHEMA


def validate(bundle, *, l3_identity, signal_date):
    model = bundle.get("model") or {}
    if (not is_equal7(bundle) or bundle.get("schema_version") != SCHEMA
            or bundle.get("feature_schema") != FEATURE_SCHEMA or bundle.get("label_schema") != LABEL_SCHEMA
            or bundle.get("horizon_sessions") != 5 or model.get("recipe_version") != RECIPE
            or model.get("model_order") != list(MODELS)
            or model.get("feature_names") != list(FEATURE_NAMES)
            or set(model) & {"heads", "seeds", "residual_tabpack", "residual_mlp", "A", "gain", "loss"}):
        raise ValueError("r33_bundle_contract")
    if not l3_identity or bundle.get("l3_identity") != l3_identity:
        raise ValueError("r33_bundle_l3_identity")
    if bundle.get("model_checksum") != digest(model):
        raise ValueError("r33_bundle_model_checksum")
    known = bundle["training_label_known_max"]
    if date.fromisoformat(known) >= date.fromisoformat(signal_date):
        raise ValueError("r33_bundle_training_after_signal")
    bases = model.get("base_artifacts") or {}
    if set(bases) != set(MODELS) or l3_identity.get("base_artifact_set_checksum") != digest(bases):
        raise ValueError("r33_bundle_seven_artifact_set")
    for model_name, reference in bases.items():
        checksum = reference.get("checksum", "").removeprefix("sha256:")
        if (not re.fullmatch("[a-f0-9]{64}", checksum) or not reference.get("version")
                or not reference.get("training_label_known_max")
                or reference["training_label_known_max"] > known):
            raise ValueError("r33_bundle_base_lineage:" + model_name)
        date.fromisoformat(reference["training_label_known_max"])
    calibration = model["calibration"]
    if calibration["label_known_at_max"] > known:
        raise ValueError("r33_bundle_calibration_after_training_cutoff")
    validate_calibration(calibration, signal_date=signal_date, pool_contract=calibration["pool_contract"])


def project(snapshot, *, bundle, identity, signal_date, symbols, predictions):
    rows = snapshot.get("rank_rows") or []
    if (snapshot.get("schema_version") != "r33-attested-rank-pool-v1"
            or snapshot.get("signal_date") != signal_date or snapshot.get("l3_identity") != identity
            or snapshot.get("model_order") != list(MODELS)
            or snapshot.get("predictions_checksum") != digest({s: predictions[s] for s in symbols})
            or snapshot.get("checksum") != digest({k:v for k,v in snapshot.items() if k != "checksum"})
            or len(symbols) != len(set(symbols)) or set(symbols) != {r["symbol"] for r in rows}):
        raise ValueError("r33_rank_pool_identity_or_membership")
    for row in rows:
        packet = predictions[row['symbol']].get('r33_rank_evidence') or {}
        if (packet.get('recipe') != RECIPE or packet.get('signal_date') != signal_date
                or packet.get('l3_identity') != identity or packet.get('ranks') != row.get('ranks')
                or packet.get('availability') != row.get('availability')):
            raise ValueError('r33_routed_rank_pool_prediction_mismatch')
    forecast = calibrated_scores(rows, calibration=bundle["model"]["calibration"],
        signal_date=signal_date, pool_contract=snapshot["pool_contract"])
    feature_rows = [dict(symbol=r["symbol"], features={
        key: value for m in MODELS for key, value in (
            (m + "_rank", r["effective_ranks"][m]), (m + "_available", int(m not in r["missing_models"]))
        )}) for r in forecast]
    outputs = {r["symbol"]: {**r, "expected_return_gross": r["expected_return"],
        "mean_policy": RECIPE, "model_checksum": bundle["model_checksum"]} for r in forecast}
    evidence = dict(schema_version="r33-rank-pool-projection-v1", recipe=RECIPE,
        signal_date=signal_date, source_pool_checksum=snapshot["checksum"],
        model_checksum=bundle["model_checksum"], calibration_checksum=bundle["model"]["calibration"]["checksum"],
        source_pool_size=len(rows), denominator_models=7, missing_rank=0.5,
        stock_exclusions=0, forecasts_checksum=digest(outputs))
    return feature_rows, outputs, {**evidence, "checksum": digest(evidence)}
