"""L4-FWD-P1: roster-invariant forward projection of an R33 allocation context.

The legacy projection (l4_forward_refresh.project) only knows the eight-slot L4 v1
features. An R33 snapshot is projected here instead, into features whose names do
not depend on the roster: E-hat, score, roster size, how many models scored the
name and how far their z disagree. Each model's z/availability is kept by name as
evidence, never as a fixed column, so a monthly roster change keeps one schema.

The roster comes from the sealed objects only: the attested rank pool, the L4
bundle and every R33 prediction's ensemble_v2 must name the same model_order;
this checkout's R33_MODELS is never read. Every row carries its own l3_identity,
model_order and calibration checksum, so a snapshot still materializes after the
monthly identity changes. The data are evaluation-only (pool contract below):
nothing trains on them until a trainer is admitted separately.
"""
from __future__ import annotations

import math

from services.l4_forward_materialization import digest

FEATURE_SCHEMA = "r33-forward-roster-invariant-v1"
FEATURE_NAMES = ("ehat", "score", "roster_size", "available_count", "available_fraction",
                 "z_mean", "z_sd", "z_range")
POOL_CONTRACT = "r33_calibration_pool_v1"
LABEL_SCHEMA = "r33-forward-pool-relative-label-v1"


def _z_stats(z: dict, available: dict, models, uninformative) -> dict:
    """Dispersion over the models that ranked the name. A missing model's z=0, and an
    uninformative model's (no spread in the pool that day, z=0 for all), are not evidence."""
    values = [float(z[m]) for m in models if available[m] and m not in uninformative]
    if not values:
        return dict(z_mean=0.0, z_sd=0.0, z_range=0.0)
    mean = sum(values) / len(values)
    return dict(z_mean=mean, z_sd=math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)),
                z_range=max(values) - min(values))


def project_r33(frozen: dict) -> dict:
    """Same snapshot shape as the legacy projection, from the verified frozen allocation context."""
    from services.l3_equal_weight_bundle import UTILITY_SEMANTIC, is_r33_bundle, validate as validate_bundle
    from services.r33_ensemble import RUNTIME_SCHEMA
    from services.r33_rank_pool import validate_rank_pool

    manifest = frozen["manifest"]
    content = frozen["payload"]["content"]
    if manifest["snapshot_kind"] != "allocation_context":
        raise ValueError("l4_forward_snapshot_kind")
    policy = content["inputs"]["alpha_policy"]["l4Distribution"]
    runtime, bundle = policy["runtime"], policy.get("artifact")
    signal_date = manifest["signal_date"]
    identity = runtime["l3_identity"]
    pool = runtime["r33_rank_pool"]
    runtime_predictions = runtime["predictions"]
    # The rank pool's rows and the evidence attached to each frozen prediction must agree.
    validate_rank_pool(pool, runtime_predictions)
    if pool["signal_date"] != signal_date or runtime.get("signal_date") != signal_date:
        raise ValueError("l4_forward_r33_signal_date_mismatch")
    if pool["l3_identity"] != identity:
        raise ValueError("l4_forward_r33_identity_mismatch")
    if not is_r33_bundle(bundle):
        raise ValueError("l4_forward_r33_bundle_missing")
    validate_bundle(bundle, l3_identity=identity, signal_date=signal_date)
    models = list(pool["model_order"])
    model = bundle["model"]
    if model["model_order"] != models or model["calibration_checksum"] != pool["calibration_checksum"]:
        raise ValueError("l4_forward_r33_roster_disagreement")
    predictions = content.get("model_predictions") or runtime_predictions
    for source in (runtime_predictions, predictions):
        for prediction in source.values():
            view = (prediction or {}).get("ensemble_v2") or {}
            # Every view of an R33 context is an R33 view of this roster; anything else is not skipped.
            if (view.get("schema_version") != RUNTIME_SCHEMA or view.get("model_order") != models
                    or view.get("calibration_checksum") != pool["calibration_checksum"]
                    or view.get("artifact_checksum") != identity.get("payload_checksum")):
                raise ValueError("l4_forward_r33_roster_disagreement")

    rows, excluded = [], []
    for row in pool["rows"]:
        if row["role"] != "pool":
            continue
        if row["score"] is None or row["expected_excess"] is None:
            excluded.append(dict(symbol=row["symbol"], reason="r33_unscored", details=[row["unscored_reason"]]))
            continue
        count = sum(bool(row["available"][m]) for m in models)
        features = dict(ehat=float(row["expected_excess"]), score=float(row["score"]), roster_size=len(models),
                        available_count=count, available_fraction=count / len(models),
                        **_z_stats(row["z"], row["available"], models, set(pool["uninformative_models"])))
        if tuple(features) != FEATURE_NAMES or not all(math.isfinite(v) for v in features.values()):
            raise ValueError("l4_forward_r33_feature_invalid")
        rows.append(dict(
            symbol=row["symbol"], features=features,
            # Copied onto every materialized row: the E-hat this snapshot priced and its roster.
            l3_baseline=dict(expected_excess=features["ehat"], semantic=UTILITY_SEMANTIC, model_order=models,
                             calibration_checksum=pool["calibration_checksum"], variant=pool["variant"]),
            evidence=dict(held=row["held"], z={m: float(row["z"][m]) for m in models},
                          available={m: bool(row["available"][m]) for m in models})))
    if not rows:
        raise ValueError("l4_forward_empty_projection")
    lineage = dict(model_order=models, roster_size=len(models), variant=pool["variant"],
                   calibration_checksum=pool["calibration_checksum"],
                   source_calibration_checksum=pool["source_calibration_checksum"],
                   pool_checksum=pool["pool_checksum"], rank_pool_checksum=pool["checksum"],
                   ensemble_payload_checksum=model["ensemble_payload_checksum"], model_checksum=bundle["model_checksum"],
                   uninformative_models=list(pool["uninformative_models"]),
                   holdings_outside_pool=sum(r["role"] != "pool" for r in pool["rows"]))
    return dict(snapshot_id=manifest["snapshot_id"], signal_date=signal_date, frozen_at=manifest["frozen_at"],
                original_sha256=manifest["payload_checksum"], verified_original_sha256=manifest["payload_checksum"],
                feature_rows=rows, features_checksum=digest(rows), eligible_symbols=[r["symbol"] for r in rows],
                feature_schema=FEATURE_SCHEMA, l3_identity=identity, pool_contract=POOL_CONTRACT,
                coverage_exclusions=excluded, original_prediction_count=len(predictions), source_manifest=manifest,
                l3_training_label_known_max=bundle["training_label_known_max"], r33_lineage=lineage)


def pool_relative_labels(rows: list[dict], receipt: dict) -> dict | None:
    """Five-session gross return minus the day's mean over the projected pool, only when every
    pool name was scored and matured (status ready, no coverage gap) and there are at least two;
    a partial day has no honest pool mean. The mean includes names whose entry opened limit-up
    (the calibration drops those; the frozen context does not record them)."""
    if receipt.get("status") != "ready" or receipt.get("coverage_blocker") or len(rows) < 2:
        return None
    mean = sum(r["gross_return"] for r in rows) / len(rows)
    values = {r["symbol"]: r["gross_return"] - mean for r in rows}
    body = dict(schema_version=LABEL_SCHEMA, signal_date=receipt["signal_date"], rows_checksum=receipt["rows_checksum"],
                pool_mean_gross_return=mean, pool_mean_includes_entry_limit_up=True, n=len(rows),
                pool_relative_excess=values)
    return {**body, "checksum": digest(body)}
