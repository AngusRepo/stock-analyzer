"""Strict recovery of completed OOF folds from immutable GCS artifacts."""

from __future__ import annotations

import hashlib
import io
import json
from typing import Any

import numpy as np

from .model_validation import rank_ic
from .oof_forward_source_contract import assess_fold_forward_sources
from .oof_lineage import OOF_PREDICTION_SCHEMA_VERSION, OOF_TARGET_SEMANTIC_VERSION


TREE_MODELS = {"XGBoost", "ExtraTrees", "LightGBM"}
SEQUENCE_MODELS = {"PatchTST", "iTransformer"}
OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION = "active8-oof-fold-model-evidence-v1"
MODEL_SLUGS = {
    "XGBoost": "xgboost",
    "ExtraTrees": "extratrees",
    "LightGBM": "lightgbm",
    "TabM": "tabm",
    "GNN": "gnn",
    "DLinear": "dlinear",
    "PatchTST": "patchtst",
    "iTransformer": "itransformer",
}
# TimeXer folds are recoverable only under the R33 attestation (non-R33 rosters with
# TimeXer keep the old behaviour: no recovery).
ALL_SLUGS = {**MODEL_SLUGS, "TimeXer": "timexer"}
DENSE_SEQUENCE_MODELS = {*SEQUENCE_MODELS, "TimeXer"}
R33_PURGE_HORIZON = 5


class _UnattestedFold(ValueError):
    """A fold artifact without the full R33 attestation: re-run the window, never recover it."""


def r33_attestation_failure(artifact_metadata: dict[str, Any], *, model_name: str, window: dict[str, Any],
                            producer_source_sha: str, feature_semantic_version: str) -> str | None:
    split = artifact_metadata.get("split_metadata")
    split = split if isinstance(split, dict) else {}
    if not producer_source_sha or artifact_metadata.get("producer_source_sha") != producer_source_sha:
        return "producer_source_sha"
    if not feature_semantic_version or artifact_metadata.get("feature_semantic_version") != feature_semantic_version:
        return "feature_semantic_version"
    known_max = split.get("train_label_known_max") or split.get("training_label_known_max")
    if not known_max or str(known_max)[:10] >= str(window["test_start"]):
        return "train_label_known_max"
    if model_name in DENSE_SEQUENCE_MODELS:
        if split.get("purge_horizon") != R33_PURGE_HORIZON or split.get("refit_inside_test") is not False:
            return "purge_horizon"
    elif split.get("method") != "walk_forward_explicit_label_purged":
        return "purge_method"
    if model_name in SEQUENCE_MODELS and (split.get("nf_require_complete_horizon") is not True
                                          or not isinstance(split.get("evaluation_row_accounting"), dict)):
        return "nf_require_complete_horizon"
    return None


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _normalize_sha256(value: object) -> str:
    raw = str(value or "").strip().lower()
    return raw[7:] if raw.startswith("sha256:") else raw


def _load_bytes(bucket: Any, path: str) -> bytes:
    blob = bucket.blob(path)
    if not blob.exists():
        raise FileNotFoundError(path)
    return blob.download_as_bytes()


def _load_json(bucket: Any, path: str) -> dict[str, Any]:
    return json.loads(_load_bytes(bucket, path).decode("utf-8").lstrip("\ufeff"))


def _canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _fold_evidence_path(prep_prefix: str, cohort_id: str, fold_id: str, model_name: str) -> str:
    return (
        f"{prep_prefix.rstrip('/')}/oof/{cohort_id}/{fold_id}/"
        f"{ALL_SLUGS[model_name]}.evidence.json"
    )


def _model_metadata_path(prep_prefix: str, model_name: str, version: str) -> str:
    slug = ALL_SLUGS[model_name]
    if model_name in TREE_MODELS:
        return f"{prep_prefix}/frozen_models/{slug}/metadata_{version}.json"
    return f"universal/{slug}/metadata_{version}.json"


def _model_cpcv(metadata: dict[str, Any]) -> dict[str, Any]:
    direct = metadata.get("model_cpcv")
    if isinstance(direct, dict):
        return direct
    selection = metadata.get("selection_evidence")
    if isinstance(selection, dict) and isinstance(selection.get("model_cpcv"), dict):
        return selection["model_cpcv"]
    raise ValueError("oof_artifact_recovery_model_cpcv_missing")


def _coverage_contract(cpcv: dict[str, Any]) -> dict[str, Any]:
    raw = cpcv.get("coverage_gate_value")
    semantics = str(cpcv.get("coverage_gate_semantics") or "").strip()
    if raw is None:
        raw = cpcv.get("coverage_mean")
        semantics = semantics or "coverage_mean"
    try:
        coverage = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("oof_artifact_recovery_coverage_invalid") from exc
    policy = cpcv.get("policy") if isinstance(cpcv.get("policy"), dict) else {}
    coverage_mode = str(policy.get("coverage_mode") or cpcv.get("coverage_mode") or "").strip()
    if (
        not np.isfinite(coverage)
        or coverage < 0.0
        or coverage > 1.0
        or not semantics
        or semantics == "unspecified"
        or not coverage_mode
    ):
        raise ValueError("oof_artifact_recovery_coverage_contract_incomplete")
    return {
        "coverage": coverage,
        "coverage_gate_semantics": semantics,
        "coverage_mode": coverage_mode,
    }


def _verify_model_source(
    bucket: Any,
    *,
    prep_prefix: str,
    cohort_id: str,
    fold_id: str,
    model_name: str,
    version: str,
    oof_path: str,
    oof_checksum: str,
) -> tuple[dict[str, Any], str, str, str]:
    slug = ALL_SLUGS[model_name]
    metadata_path = _model_metadata_path(prep_prefix, model_name, version)
    if model_name == "TimeXer" or (model_name in SEQUENCE_MODELS and not bucket.blob(metadata_path).exists()):
        evidence_path = _fold_evidence_path(prep_prefix, cohort_id, fold_id, model_name)
        evidence = _load_json(bucket, evidence_path)
        stored_checksum = _normalize_sha256(evidence.pop("evidence_checksum", ""))
        actual_checksum = _sha256(_canonical_json_bytes(evidence))
        expected = {
            "schema_version": OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION,
            "generation_mode": "purged_oof",
            "cohort_id": cohort_id,
            "fold_id": fold_id,
            "model_name": model_name,
            "version": version,
            "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
            "oof_artifact": oof_path,
            "oof_artifact_checksum": oof_checksum,
        }
        if stored_checksum != actual_checksum:
            raise ValueError(f"oof_artifact_recovery_evidence_checksum_mismatch:{model_name}")
        for key, value in expected.items():
            if evidence.get(key) != value:
                raise ValueError(f"oof_artifact_recovery_evidence_mismatch:{model_name}:{key}")
        _coverage_contract(_model_cpcv(evidence))
        if model_name != "TimeXer":
            return evidence, "", evidence_path, ""
        # TimeXer evidence also pins the content-addressed checkpoint it was scored with.
        checkpoint_metadata_path = str(evidence.get("model_metadata_path") or "")
        checkpoint = _load_json(bucket, checkpoint_metadata_path)
        artifact_path = str(checkpoint.get("artifact_path") or "")
        expected_checksum = _normalize_sha256(checkpoint.get("checksum"))
        if (checkpoint.get("model_name") != model_name or checkpoint.get("version") != version
                or checkpoint.get("metadata_path") != checkpoint_metadata_path
                or expected_checksum != _normalize_sha256(evidence.get("model_checksum"))
                or not artifact_path or len(expected_checksum) != 64):
            raise ValueError(f"oof_artifact_recovery_model_source_reference_invalid:{model_name}")
        if _sha256(_load_bytes(bucket, artifact_path)) != expected_checksum:
            raise ValueError(f"oof_artifact_recovery_model_source_checksum_mismatch:{model_name}")
        return {**evidence, "checkpoint_metadata": checkpoint}, artifact_path, checkpoint_metadata_path, expected_checksum
    metadata = _load_json(bucket, metadata_path)
    stored_version = str(metadata.get("version") or metadata.get("model_pool_version") or "")
    stored_model = str(metadata.get("model_name") or model_name)
    if stored_version != version:
        raise ValueError(f"oof_artifact_recovery_model_version_mismatch:{model_name}")
    if stored_model != model_name:
        raise ValueError(f"oof_artifact_recovery_model_name_mismatch:{model_name}")
    if metadata.get("target_semantic_version") != OOF_TARGET_SEMANTIC_VERSION:
        raise ValueError(f"oof_artifact_recovery_target_semantic_mismatch:{model_name}")

    if model_name in TREE_MODELS:
        artifact_path = f"{prep_prefix}/frozen_models/{slug}/{version}.joblib"
        expected_checksum = _normalize_sha256(metadata.get("artifact_checksum"))
    else:
        artifact_path = str(metadata.get("artifact_path") or "")
        expected_checksum = _normalize_sha256(metadata.get("checksum"))
    if not artifact_path or len(expected_checksum) != 64:
        raise ValueError(f"oof_artifact_recovery_model_source_reference_invalid:{model_name}")
    if _sha256(_load_bytes(bucket, artifact_path)) != expected_checksum:
        raise ValueError(f"oof_artifact_recovery_model_source_checksum_mismatch:{model_name}")
    return metadata, artifact_path, metadata_path, expected_checksum


def _recover_model_metric(
    bucket: Any,
    *,
    prep_prefix: str,
    cohort_id: str,
    fold_id: str,
    model_name: str,
    window: dict[str, Any],
    r33_lineage: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], str, str, str]:
    version = f"{cohort_id}-{fold_id}"
    oof_path = f"{prep_prefix}/oof/{cohort_id}/{fold_id}/{ALL_SLUGS[model_name]}.npz"
    raw = _load_bytes(bucket, oof_path)
    artifact_checksum = _sha256(raw)
    artifact = np.load(io.BytesIO(raw), allow_pickle=True)
    required = {
        "metadata", "rank_scores", "targets", "dates", "symbols", "markets",
        "label_known_dates",
    }
    missing = sorted(required - set(artifact.files))
    if missing:
        raise ValueError(
            f"oof_artifact_recovery_arrays_missing:{fold_id}:{model_name}:{','.join(missing)}"
        )
    artifact_metadata = json.loads(str(artifact["metadata"].item()))
    expected = {
        "schema_version": OOF_PREDICTION_SCHEMA_VERSION,
        "generation_mode": "purged_oof",
        "cohort_id": cohort_id,
        "fold_id": fold_id,
        "model_name": model_name,
        "artifact_version": version,
        "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
    }
    for key, value in expected.items():
        if artifact_metadata.get(key) != value:
            raise ValueError(
                f"oof_artifact_recovery_metadata_mismatch:{fold_id}:{model_name}:{key}"
            )
    if r33_lineage is not None:
        failure = r33_attestation_failure(artifact_metadata, model_name=model_name, window=window, **r33_lineage)
        if failure:
            raise _UnattestedFold(f"oof_artifact_recovery_r33_unattested:{fold_id}:{model_name}:{failure}")
    split = artifact_metadata.get("split_metadata")
    split = split if isinstance(split, dict) else {}
    requested_train_range = list(
        split.get("requested_train_range")
        or split.get("train_range")
        or [split.get("train_start"), split.get("train_end")]
    )
    test_range = list(
        split.get("test_range")
        or split.get("validation_range")
        or [split.get("test_start"), split.get("test_end")]
    )
    if (
        requested_train_range != [str(window["train_start"]), str(window["train_end"])]
        or test_range != [str(window["test_start"]), str(window["test_end"])]
    ):
        raise ValueError(f"oof_artifact_recovery_split_mismatch:{fold_id}:{model_name}")

    ranks = np.asarray(artifact["rank_scores"], dtype=float).reshape(-1)
    targets = np.asarray(artifact["targets"], dtype=float).reshape(-1)
    dates = np.asarray(artifact["dates"], dtype=str).reshape(-1)
    known_dates = np.asarray(artifact["label_known_dates"], dtype=str).reshape(-1)
    if not len(ranks) or len(ranks) != len(targets) or len(dates) != len(ranks):
        raise ValueError(f"oof_artifact_recovery_row_count_invalid:{fold_id}:{model_name}")
    if np.any(known_dates <= dates):
        raise ValueError(f"oof_artifact_recovery_lookahead_contract_invalid:{fold_id}:{model_name}")
    if min(dates.tolist()) < str(window["test_start"]) or max(dates.tolist()) > str(window["test_end"]):
        raise ValueError(f"oof_artifact_recovery_test_date_out_of_range:{fold_id}:{model_name}")

    metadata, source_path, metadata_path, source_checksum = _verify_model_source(
        bucket,
        prep_prefix=prep_prefix,
        cohort_id=cohort_id,
        fold_id=fold_id,
        model_name=model_name,
        version=version,
        oof_path=oof_path,
        oof_checksum=artifact_checksum,
    )
    coverage = _coverage_contract(_model_cpcv(metadata))
    metric = {
        "status": "ready",
        "oos_ic": round(rank_ic(ranks, targets), 6),
        "test_samples": int(len(ranks)),
        "oof_artifact": oof_path,
        "artifact_checksum": artifact_checksum,
        **coverage,
    }
    return metric, metadata, source_path, metadata_path, source_checksum


def recover_completed_oof_windows(
    *,
    bucket: Any,
    requested_windows: list[dict[str, Any]],
    models: list[str],
    cohort_id: str,
    prep_prefix: str,
    prep_manifest_checksum: str,
    sequence_prefix: str,
    sequence_manifest_checksum: str,
    model_coverage: dict[str, Any],
    r33_lineage: dict[str, str] | None = None,
) -> dict[int, dict[str, Any]]:
    """Recover only complete folds; partial folds remain eligible for retraining.

    With ``r33_lineage`` ({producer_source_sha, feature_semantic_version}) every family must
    carry the full R33 attestation; a window with any unattested family is re-run whole.
    """

    recovered: dict[int, dict[str, Any]] = {}
    if any(model not in (ALL_SLUGS if r33_lineage is not None else MODEL_SLUGS) for model in models):
        return recovered

    for window in requested_windows:
        window_id = int(window["window_id"])
        fold_id = f"w{window_id}"
        paths = [
            f"{prep_prefix}/oof/{cohort_id}/{fold_id}/{ALL_SLUGS[model]}.npz"
            for model in models
        ]
        if not all(bucket.blob(path).exists() for path in paths):
            continue
        recovery_evidence_available = True
        for model_name in models:
            version = f"{cohort_id}-{fold_id}"
            metadata_path = _model_metadata_path(prep_prefix, model_name, version)
            if model_name != "TimeXer" and bucket.blob(metadata_path).exists():
                continue
            if model_name in DENSE_SEQUENCE_MODELS and bucket.blob(
                _fold_evidence_path(prep_prefix, cohort_id, fold_id, model_name)
            ).exists():
                continue
            recovery_evidence_available = False
            break
        if not recovery_evidence_available:
            continue

        result: dict[str, Any] = {
            "window_id": window_id,
            "train_range": [window["train_start"], window["train_end"]],
            "test_range": [window["test_start"], window["test_end"]],
            "model_metrics": {},
            "model_coverage": model_coverage,
            "source_prep_gcs_prefix": prep_prefix,
            "source_prep_manifest_checksum": prep_manifest_checksum,
            "source_sequence_gcs_prefix": sequence_prefix,
            "source_sequence_manifest_checksum": sequence_manifest_checksum,
            "recovered_from_immutable_artifacts": True,
            "fs_result": {
                "skipped": True,
                "reason": "immutable_exact_fold_artifact_recovery",
            },
        }
        if r33_lineage is not None:
            result["source_producer_source_sha"] = r33_lineage["producer_source_sha"]  # as a fresh fold declares
        tree_registrations: dict[str, Any] = {}
        try:
            recovered_models = [(model_name, *_recover_model_metric(
                bucket,
                prep_prefix=prep_prefix,
                cohort_id=cohort_id,
                fold_id=fold_id,
                model_name=model_name,
                window=window,
                r33_lineage=r33_lineage,
            )) for model_name in models]
        except _UnattestedFold as exc:
            print(f"[OOFRecovery] {exc}: window re-runs")
            continue
        for model_name, metric, metadata, source_path, metadata_path, source_checksum in recovered_models:
            result["model_metrics"][model_name] = metric
            version = f"{cohort_id}-{fold_id}"
            if model_name in TREE_MODELS:
                tree_registrations[model_name] = {
                    "status": "shadow_source",
                    "promotion_eligible": False,
                    "version": version,
                    "gcs_path": source_path,
                    "metadata_path": metadata_path,
                    "checksum": source_checksum,
                }
            elif model_name in {"TabM", "GNN"}:
                result[f"{model_name}_result"] = {
                    "status": "ok",
                    "version": version,
                    "artifact_path": source_path,
                    "metadata_path": metadata_path,
                    "checksum": source_checksum,
                    "metadata": metadata,
                }
            elif model_name == "TimeXer":
                # Same identity fields the forward extension reads from a fresh TimeXer_result.
                result["TimeXer_result"] = {
                    "status": "ok",
                    "version": version,
                    "artifact_path": source_path,
                    "metadata_path": metadata_path,
                    "checksum": source_checksum,
                    "metadata": metadata["checkpoint_metadata"],
                }
        result["tree_result"] = {"artifact_registrations": tree_registrations}
        forward = assess_fold_forward_sources(result, cohort_id=cohort_id, bucket=bucket)
        result["forward_source_contract"] = forward
        result["fold_blockers"] = list(forward["reasons"])
        result["missing_oof_models"] = [
            model for model in models
            if (result["model_metrics"].get(model) or {}).get("status") != "ready"
        ]
        result["oof_fold_ready"] = not result["missing_oof_models"] and forward["ready"]
        if not result["oof_fold_ready"]:
            raise ValueError(f"oof_artifact_recovery_forward_contract_failed:{fold_id}")
        recovered[window_id] = result
    return recovered
