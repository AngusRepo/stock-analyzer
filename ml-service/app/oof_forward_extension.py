"""Frozen-fold forward OOS evidence for L4/Fusion shadow evaluation.

This module never trains or promotes a model. It reuses the latest verified
outer-fold artifacts and emits an explicitly counterfactual forward manifest.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .features import FEATURE_IMPUTATION_SEMANTIC_VERSION, FEATURE_SEMANTIC_VERSION
from .model_store import _get_bucket, load_model
from .oof_lineage import save_oof_prediction_artifact
from .oof_forward_source_contract import assess_fold_forward_sources
from .research_benchmarks.common import load_sequence_dataset
from .sequence_training import SEQUENCE_RETURN_SEMANTIC_VERSION

SCHEMA_VERSION = "active8-oof-forward-extension-v2"
GENERATION_MODE = "frozen_forward_oos"
CORE_MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN")
OPTIONAL_MODELS = ("DLinear", "PatchTST", "iTransformer")


def _manifest_checksum(payload: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in payload.items() if key != "manifest_checksum"}
    return hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _load_json(bucket: Any, path: str) -> dict[str, Any]:
    blob = bucket.blob(path)
    if not blob.exists():
        raise ValueError(f"forward_extension_artifact_missing:{path}")
    value = json.loads(blob.download_as_text().lstrip("\ufeff"))
    if not isinstance(value, dict):
        raise ValueError(f"forward_extension_json_invalid:{path}")
    return value


def _runtime_source_sha() -> str:
    source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA") or "").strip().lower()
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise RuntimeError("stockvision_source_sha_missing_or_invalid")
    return source_sha


def _verify_base_manifest(bucket: Any, path: str) -> dict[str, Any]:
    manifest = _load_json(bucket, path)
    if (
        manifest.get("schema_version") != "active8-oof-cohort-manifest-v5"
        or manifest.get("status") != "ready"
        or manifest.get("generation_mode") != "purged_oof"
        or manifest.get("manifest_checksum") != _manifest_checksum(manifest)
    ):
        raise ValueError("forward_extension_base_manifest_invalid")
    windows = manifest.get("windows") or []
    if not windows:
        raise ValueError("forward_extension_base_windows_missing")
    latest = max(windows, key=lambda row: int(row.get("window_id") or 0))
    source_contract = assess_fold_forward_sources(
        latest,
        cohort_id=str(manifest.get("cohort_id") or ""),
        bucket=bucket,
    )
    if not source_contract["ready"]:
        raise ValueError("forward_extension_base_source_contract_invalid:" + ",".join(source_contract["reasons"][:10]))
    return manifest


def _verify_prep_manifest(bucket: Any, prefix: str) -> dict[str, Any]:
    manifest = _load_json(bucket, f"{prefix}/prep/manifest.json")
    if (
        manifest.get("schema_version") != "active8-canonical-adjusted-prep-v3"
        or manifest.get("status") != "ready"
        or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or manifest.get("feature_semantic_version") != FEATURE_SEMANTIC_VERSION
        or manifest.get("feature_imputation_semantic") != FEATURE_IMPUTATION_SEMANTIC_VERSION
        or manifest.get("producer_source_sha") != _runtime_source_sha()
        or manifest.get("target_semantic_version") != SEQUENCE_RETURN_SEMANTIC_VERSION
        or float(manifest.get("roundtrip_cost_bps") or 0.0) != 18.0
        or manifest.get("manifest_checksum") != _manifest_checksum(manifest)
    ):
        raise ValueError("forward_extension_prep_manifest_invalid")
    if manifest.get("schema_version") == "active8-canonical-adjusted-prep-v3" and (
        manifest.get("rank_semantic_version") != "same-market-same-date-global-percentile-v2"
        or len(str(manifest.get("source_receipt_checksum") or "")) != 64
        or len(str(manifest.get("sequence_manifest_checksum") or "")) != 64
    ):
        raise ValueError("forward_extension_prep_v2_lineage_invalid")
    paths = [f"{prefix}/prep/batch_{idx}.npz" for idx in range(len(manifest.get("batch_rows") or []))]
    checksums = dict(manifest.get("output_checksums") or {})
    if not paths or sorted(paths) != sorted(checksums):
        raise ValueError("forward_extension_prep_inventory_invalid")
    return manifest


def _load_forward_rows(
    bucket: Any,
    *,
    prep_prefix: str,
    prep_manifest: dict[str, Any],
    start_date: str,
    end_date: str,
    knowledge_cutoff_date: str,
) -> tuple[dict[str, np.ndarray], list[str]]:
    feature_names = json.loads(
        bucket.blob(f"{prep_prefix}/prep/feature_names.json").download_as_text()
    )
    staged: dict[str, list[np.ndarray]] = {
        key: [] for key in (
            "X", "target_returns", "dates", "symbols", "markets", "label_known_dates"
        )
    }
    checksums = dict(prep_manifest["output_checksums"])
    for path in sorted(checksums):
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != str(checksums[path]):
            raise ValueError(f"forward_extension_prep_checksum_mismatch:{path}")
        data = np.load(io.BytesIO(raw), allow_pickle=True)
        required = set(staged)
        if not required.issubset(data.files):
            raise ValueError(f"forward_extension_prep_arrays_missing:{path}")
        dates = np.asarray(data["dates"]).astype(str)
        known = np.asarray(data["label_known_dates"]).astype(str)
        mask = (
            (dates >= start_date)
            & (dates <= end_date)
            & (known <= knowledge_cutoff_date)
            & (known > dates)
        )
        for key in staged:
            staged[key].append(np.asarray(data[key])[mask])
    rows = {
        key: np.concatenate(parts) if parts else np.asarray([])
        for key, parts in staged.items()
    }
    if not len(rows["dates"]):
        raise ValueError("forward_extension_no_mature_rows")
    if rows["X"].ndim != 2 or rows["X"].shape[1] != len(feature_names):
        raise ValueError("forward_extension_feature_width_mismatch")
    identities = list(zip(rows["dates"].astype(str), rows["symbols"].astype(str)))
    if len(identities) != len(set(identities)):
        raise ValueError("forward_extension_duplicate_symbol_date")
    return rows, [str(name) for name in feature_names]


def _align_features(
    matrix: np.ndarray,
    serving_features: list[str],
    metadata: dict[str, Any] | None,
) -> np.ndarray:
    training_features = [str(value) for value in ((metadata or {}).get("feature_names") or [])]
    if not training_features or training_features == serving_features:
        return np.asarray(matrix, dtype=np.float32)
    medians = dict((metadata or {}).get("feature_medians") or {})
    serving_index = {name: idx for idx, name in enumerate(serving_features)}
    missing_without_default = [
        name for name in training_features
        if name not in serving_index and name not in medians
    ]
    if missing_without_default:
        raise ValueError(
            "forward_extension_feature_contract_missing:"
            + ",".join(missing_without_default[:10])
        )
    aligned = np.empty((len(matrix), len(training_features)), dtype=np.float32)
    for idx, name in enumerate(training_features):
        if name in serving_index:
            aligned[:, idx] = np.asarray(matrix[:, serving_index[name]], dtype=np.float32)
        else:
            aligned[:, idx] = float(medians[name])
    return aligned


def _artifact_version(bucket: Any, window: dict[str, Any], model_name: str) -> str:
    model = dict((window.get("model_metrics") or {}).get(model_name) or {})
    raw = bucket.blob(str(model.get("oof_artifact") or "")).download_as_bytes()
    data = np.load(io.BytesIO(raw), allow_pickle=True)
    metadata = json.loads(str(data["metadata"].item()))
    version = str(metadata.get("artifact_version") or "").strip()
    if not version:
        raise ValueError(f"forward_extension_artifact_version_missing:{model_name}")
    return version


def _validate_training_cutoff(metadata: dict[str, Any], cutoff: str, model_name: str) -> None:
    train_range = metadata.get("train_range") or []
    train_end = str(train_range[1] if isinstance(train_range, list) and len(train_range) == 2 else "")[:10]
    if not train_end:
        selection = metadata.get("selection_evidence") or {}
        report = selection.get("sequence_report") if isinstance(selection, dict) else {}
        report_range = report.get("train_range") if isinstance(report, dict) else []
        train_end = str(report_range[1] if isinstance(report_range, list) and len(report_range) == 2 else "")[:10]
    if not train_end:
        raise ValueError(f"forward_extension_training_cutoff_missing:{model_name}")
    if train_end > cutoff:
        raise ValueError(f"forward_extension_training_cutoff_violation:{model_name}:{train_end}>{cutoff}")


def _tree_source_artifact(window: dict[str, Any], model_name: str) -> dict[str, Any]:
    registrations = dict((window.get("tree_result") or {}).get("artifact_registrations") or {})
    artifact = dict(registrations.get(model_name) or {})
    if (
        artifact.get("status") != "shadow_source"
        or not str(artifact.get("gcs_path") or "").strip()
        or not str(artifact.get("metadata_path") or "").strip()
        or not str(artifact.get("checksum") or "").strip()
    ):
        raise ValueError(f"forward_extension_exact_tree_artifact_missing:{model_name}")
    return artifact


def _series_lookup(sequence_prefix: str, batch_count: int) -> dict[str, dict[str, Any]]:
    records = load_sequence_dataset({
        "sequence_gcs_prefix": sequence_prefix,
        "sequence_batch_count": batch_count,
    }).records
    output: dict[str, dict[str, Any]] = {}
    for record in records:
        symbol = str(record.get("symbol") or "").strip()
        dates = [str(value)[:10] for value in (record.get("dates") or [])]
        closes = [float(value) for value in (record.get("close") or [])]
        if symbol and len(dates) == len(closes):
            output[symbol] = {"dates": dates, "close": closes}
    return output


def _prices_until(series: dict[str, Any] | None, date: str) -> list[float]:
    if not series:
        return []
    return [
        close for row_date, close in zip(series["dates"], series["close"])
        if row_date <= date
    ]


def build_frozen_forward_extension(payload: dict[str, Any]) -> dict[str, Any]:
    """Build counterfactual forward OOS evidence without training or promotion."""

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    base_path = str(payload.get("base_manifest_path") or "").strip()
    prep_prefix = str(payload.get("prep_gcs_prefix") or "").strip().rstrip("/")
    sequence_prefix = str(payload.get("sequence_gcs_prefix") or "").strip().rstrip("/")
    sequence_batch_count = int(payload.get("sequence_batch_count") or 0)
    start_date = str(payload.get("start_date") or "")[:10]
    end_date = str(payload.get("end_date") or "")[:10]
    cutoff = str(payload.get("knowledge_cutoff_date") or "")[:10]
    if not all((base_path, prep_prefix, sequence_prefix, start_date, end_date, cutoff)):
        raise ValueError("forward_extension_required_input_missing")
    if not (start_date <= end_date <= cutoff) or sequence_batch_count < 1:
        raise ValueError("forward_extension_date_or_sequence_contract_invalid")

    base = _verify_base_manifest(bucket, base_path)
    prep = _verify_prep_manifest(bucket, prep_prefix)
    latest = max(base["windows"], key=lambda row: int(row.get("window_id") or 0))
    source_fold = f"w{int(latest.get('window_id') or 0)}"
    train_end = str((latest.get("train_range") or [None, None])[1])[:10]
    observed_source_dates: list[str] = []
    for model_name in CORE_MODELS:
        model = dict((latest.get("model_metrics") or {}).get(model_name) or {})
        raw = bucket.blob(str(model.get("oof_artifact") or "")).download_as_bytes()
        source_data = np.load(io.BytesIO(raw), allow_pickle=True)
        observed_source_dates.extend(np.asarray(source_data["dates"]).astype(str).tolist())
    observed_source_max = max(observed_source_dates) if observed_source_dates else ""
    if (
        not train_end
        or train_end >= start_date
        or not observed_source_max
        or observed_source_max >= start_date
    ):
        raise ValueError("forward_extension_temporal_boundary_invalid")

    identity = hashlib.sha256(
        "|".join((
            str(base["manifest_checksum"]), str(prep["manifest_checksum"]),
            start_date, end_date, cutoff, source_fold,
        )).encode("utf-8")
    ).hexdigest()[:12]
    extension_id = f"{base['cohort_id']}-frozen-{source_fold}-{start_date}-{end_date}-{identity}"
    manifest_path = f"walk_forward/oof_forward_extensions/{extension_id}/manifest.json"
    existing = bucket.blob(manifest_path)
    if existing.exists():
        manifest = json.loads(existing.download_as_text())
        if manifest.get("manifest_checksum") != _manifest_checksum(manifest):
            raise ValueError("forward_extension_existing_manifest_checksum_invalid")
        return {"status": "idempotent_ready", **manifest, "manifest_path": manifest_path}

    rows, feature_names = _load_forward_rows(
        bucket,
        prep_prefix=prep_prefix,
        prep_manifest=prep,
        start_date=start_date,
        end_date=end_date,
        knowledge_cutoff_date=cutoff,
    )
    sequence = _series_lookup(sequence_prefix, sequence_batch_count)
    scores_by_model: dict[str, np.ndarray] = {}
    source_artifacts: dict[str, dict[str, Any]] = {}

    for model_name in ("LightGBM", "XGBoost", "ExtraTrees"):
        source = _tree_source_artifact(latest, model_name)
        model, metadata = load_model(
            0,
            model_name,
            explicit_path=str(source["gcs_path"]),
        )
        if model is None or not metadata:
            raise ValueError(f"forward_extension_core_artifact_missing:{model_name}")
        _validate_training_cutoff(metadata, train_end, model_name)
        aligned = _align_features(rows["X"], feature_names, metadata)
        values = np.asarray(model.predict(aligned), dtype=float).reshape(-1)
        if len(values) != len(rows["dates"]) or not np.isfinite(values).all():
            raise ValueError(f"forward_extension_prediction_invalid:{model_name}")
        scores_by_model[model_name] = values
        source_artifacts[model_name] = {
            "version": _artifact_version(bucket, latest, model_name),
            "path": str(source["gcs_path"]),
            "metadata_path": str(source["metadata_path"]),
            "checksum": str(source["checksum"]),
            "training_cutoff": train_end,
        }

    tabm_result = dict(latest.get("TabM_result") or {})
    tabm_version = str(tabm_result.get("version") or (tabm_result.get("metadata") or {}).get("version") or "")
    tabm_path = str(tabm_result.get("artifact_path") or (tabm_result.get("metadata") or {}).get("artifact_path") or "")
    from .tabm_batch_runtime import load_tabm_artifact, predict_tabm_scores

    tabm = load_tabm_artifact(pool={"models": {"TabM": {
        "status": "active", "version": tabm_version, "gcs_path": tabm_path,
    }}})
    _validate_training_cutoff(tabm.metadata, train_end, "TabM")
    tabm_x = _align_features(rows["X"], feature_names, tabm.metadata)
    scores_by_model["TabM"] = predict_tabm_scores(tabm, features=tabm_x)
    source_artifacts["TabM"] = {
        "version": tabm_version, "path": tabm_path, "training_cutoff": train_end,
    }

    gnn_result = dict(latest.get("GNN_result") or {})
    gnn_version = str(gnn_result.get("version") or (gnn_result.get("metadata") or {}).get("version") or "")
    gnn_path = str(gnn_result.get("artifact_path") or (gnn_result.get("metadata") or {}).get("artifact_path") or "")
    from .gnn_batch_runtime import load_graphsage_artifact, predict_graphsage_scores

    gnn = load_graphsage_artifact(pool={"models": {"GNN": {
        "status": "active", "version": gnn_version, "gcs_path": gnn_path,
    }}})
    _validate_training_cutoff(gnn.metadata, train_end, "GNN")
    gnn_scores = np.full(len(rows["dates"]), np.nan, dtype=float)
    for date in sorted(set(rows["dates"].astype(str).tolist())):
        indices = np.flatnonzero(rows["dates"].astype(str) == date)
        aligned = _align_features(rows["X"][indices], feature_names, gnn.metadata)
        price_series = [
            _prices_until(sequence.get(str(rows["symbols"][idx])), date)
            for idx in indices
        ]
        values, _report = predict_graphsage_scores(
            gnn, node_features=aligned, price_series=price_series, context_records=None
        )
        gnn_scores[indices] = values
    if not np.isfinite(gnn_scores).all():
        raise ValueError("forward_extension_prediction_invalid:GNN")
    scores_by_model["GNN"] = gnn_scores
    source_artifacts["GNN"] = {
        "version": gnn_version, "path": gnn_path, "training_cutoff": train_end,
    }

    dlinear_result = dict(latest.get("DLinear_result") or {})
    dlinear_version = str(dlinear_result.get("version") or (dlinear_result.get("metadata") or {}).get("version") or "")
    if dlinear_version:
        from .dlinear_universal import dlinear_batch_predict, load_from_gcs

        _dlinear_model, dlinear_metadata = load_from_gcs(dlinear_version)
        if _dlinear_model is None or not dlinear_metadata:
            raise ValueError("forward_extension_optional_artifact_metadata_missing:DLinear")
        _validate_training_cutoff(dlinear_metadata, train_end, "DLinear")
        dlinear_scores = np.full(len(rows["dates"]), np.nan, dtype=float)
        for date in sorted(set(rows["dates"].astype(str).tolist())):
            indices = np.flatnonzero(rows["dates"].astype(str) == date)
            batch = [
                {
                    "symbol": str(rows["symbols"][idx]),
                    "prices": _prices_until(sequence.get(str(rows["symbols"][idx])), date),
                }
                for idx in indices
            ]
            predictions = dlinear_batch_predict(batch, horizon_used=5, version=dlinear_version)
            for idx, prediction in zip(indices, predictions):
                if isinstance(prediction, dict) and prediction.get("forecast_pct") is not None:
                    dlinear_scores[idx] = float(prediction["forecast_pct"])
        if np.isfinite(dlinear_scores).any():
            scores_by_model["DLinear"] = dlinear_scores
            source_artifacts["DLinear"] = {
                "version": dlinear_version,
                "path": f"universal/dlinear/{dlinear_version}.pt",
                "training_cutoff": train_end,
            }

    artifacts: dict[str, dict[str, Any]] = {}
    for model_name, raw_scores in scores_by_model.items():
        finite = np.isfinite(raw_scores)
        if model_name in CORE_MODELS and not finite.all():
            raise ValueError(f"forward_extension_core_coverage_incomplete:{model_name}")
        if not finite.any():
            continue
        artifact = save_oof_prediction_artifact(
            bucket=bucket,
            gcs_prefix=f"walk_forward/oof_forward_extensions/{extension_id}",
            cohort_id=extension_id,
            fold_id="frozen_forward",
            model_name=model_name,
            artifact_version=str(source_artifacts[model_name]["version"]),
            raw_scores=raw_scores[finite],
            targets=np.asarray(rows["target_returns"], dtype=float)[finite],
            dates=rows["dates"][finite],
            symbols=rows["symbols"][finite],
            markets=rows["markets"][finite],
            label_known_dates=rows["label_known_dates"][finite],
            split_metadata={
                "method": "frozen_fold_forward_inference",
                "source_fold": source_fold,
                "training_cutoff": train_end,
                "test_range": [start_date, end_date],
                "knowledge_cutoff_date": cutoff,
                "counterfactual_reconstruction": True,
            },
            generation_mode=GENERATION_MODE,
        )
        artifacts[model_name] = artifact

    missing_models = [name for name in (*CORE_MODELS, *OPTIONAL_MODELS) if name not in artifacts]
    if any(name in missing_models for name in CORE_MODELS):
        raise ValueError("forward_extension_core_model_missing_after_inference")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "generation_mode": GENERATION_MODE,
        "extension_id": extension_id,
        "base_cohort_id": base["cohort_id"],
        "base_manifest_path": base_path,
        "base_manifest_checksum": base["manifest_checksum"],
        "source_fold": source_fold,
        "source_train_range": latest.get("train_range"),
        "source_test_range": latest.get("test_range"),
        "source_observed_prediction_max": observed_source_max,
        "training_cutoff": train_end,
        "extension_range": [start_date, end_date],
        "knowledge_cutoff_date": cutoff,
        "prep_gcs_prefix": prep_prefix,
        "prep_manifest_checksum": prep["manifest_checksum"],
        "feature_semantic_version": prep["feature_semantic_version"],
        "feature_imputation_semantic": prep["feature_imputation_semantic"],
        "producer_source_sha": prep["producer_source_sha"],
        "sequence_gcs_prefix": sequence_prefix,
        "sequence_batch_count": sequence_batch_count,
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "score_semantic_version": "same-market-same-date-average-tie-percentile-rank-v2",
        "counterfactual_reconstruction": True,
        "promotion_eligible": False,
        "training_dispatched": False,
        "rows": int(len(rows["dates"])),
        "dates": sorted(set(rows["dates"].astype(str).tolist())),
        "model_artifacts": artifacts,
        "source_artifacts": source_artifacts,
        "missing_models": missing_models,
        "unavailable_reasons": {
            name: "same_fold_model_artifact_not_persisted"
            for name in missing_models
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    bucket.blob(manifest_path).upload_from_string(
        json.dumps(manifest, sort_keys=True, indent=2),
        content_type="application/json",
    )
    return {**manifest, "manifest_path": manifest_path}