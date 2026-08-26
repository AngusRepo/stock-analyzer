"""Canonical fail-closed contract for the eight-model canonical OOF/full-fit release train."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Iterable

from .active8_release_model_profiles import (
    ACTIVE8_RELEASE_MODEL_PROFILES,
    MODEL_PROFILE_SCHEMA_VERSION,
    checksum as profile_checksum,
    model_profiles,
    require_nested_subset,
    validate_profiles,
)


ACTIVE8_MODEL_NAMES = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
RELEASE_TRAIN_GROUPS = ("tree", "dlinear", "patchtst")
RELEASE_ARTIFACT_LIFECYCLE_TARGETS = ("GNN", "TabM", "iTransformer")
RELEASE_CONTRACT_SCHEMA_VERSION = "active8-release-training-contract-v2"
MODEL_CONFIG_ATTESTATION_SCHEMA_VERSION = "model-training-config-attestation-v2"
TARGET_SEMANTIC = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
SCORE_SEMANTIC = "same-market-same-date-average-tie-percentile-rank-v2"
RELEASE_VALIDATION_CONTRACT = {
    "split_owner": "purged_chronological_oof",
    "rank_owner": "same_market_same_date",
    "tie_method": "average_rank",
    "promotion_requires_immutable_oof": True,
    "minimum_outer_folds": 5,
    "refit_each_fold": True,
    "dlinear_single_holdout_is_diagnostic_only": True,
}


_MODEL_SPECS: dict[str, dict[str, str]] = {
    "LightGBM": {"family": "tree", "feature_schema": "formal137_selected_tabular_v1", "trainer": "universal_tree"},
    "XGBoost": {"family": "tree", "feature_schema": "formal137_selected_tabular_v1", "trainer": "universal_tree"},
    "ExtraTrees": {"family": "tree", "feature_schema": "formal137_selected_tabular_v1", "trainer": "universal_tree"},
    "TabM": {"family": "tabular_neural", "feature_schema": "formal137_selected_tabular_v1", "trainer": "tabm_artifact"},
    "GNN": {"family": "graph", "feature_schema": "graph_node_features_from_governed_tabular_universe", "trainer": "graphsage_artifact"},
    "DLinear": {"family": "sequence", "feature_schema": "close_univariate_decomposition_v1", "trainer": "dlinear_sequence"},
    "PatchTST": {"family": "learned_sequence", "feature_schema": "close_channel_independent_v1", "trainer": "neuralforecast_patchtst"},
    "iTransformer": {"family": "learned_sequence", "feature_schema": "close_cross_stock_panel_v1", "trainer": "neuralforecast_itransformer"},
}


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return "nonfinite:nan" if math.isnan(value) else ("nonfinite:inf" if value > 0 else "nonfinite:-inf")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _checksum(payload: dict[str, Any]) -> str:
    raw = json.dumps(
        _json_safe(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def normalize_release_execution_scope(
    train_groups: Iterable[str] | None,
    artifact_targets: Iterable[str] | None,
) -> tuple[list[str], list[str]]:
    """Return the one canonical execution scope; callers cannot silently omit a model."""

    requested_groups = {str(value).strip() for value in (train_groups or ()) if str(value).strip()}
    requested_targets = {str(value).strip() for value in (artifact_targets or ()) if str(value).strip()}
    unknown_groups = requested_groups - set(RELEASE_TRAIN_GROUPS)
    unknown_targets = requested_targets - set(RELEASE_ARTIFACT_LIFECYCLE_TARGETS)
    if unknown_groups:
        raise ValueError(f"release_training_group_not_allowed:{','.join(sorted(unknown_groups))}")
    if unknown_targets:
        raise ValueError(f"release_artifact_target_not_allowed:{','.join(sorted(unknown_targets))}")
    return list(RELEASE_TRAIN_GROUPS), list(RELEASE_ARTIFACT_LIFECYCLE_TARGETS)


def build_release_training_contract(
    *,
    run_date: str,
    dataset_snapshot: dict[str, Any] | None,
    producer_source_sha: str,
) -> dict[str, Any]:
    source_sha = str(producer_source_sha or "").strip().lower()
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise ValueError("release_training_source_sha_missing_or_invalid")
    business_date = str(run_date or "").strip()
    snapshot = dict(dataset_snapshot or {})
    snapshot_date = str(snapshot.get("business_date") or "").strip()
    if not business_date or snapshot_date != business_date:
        raise ValueError(
            f"release_training_snapshot_date_mismatch:run_date={business_date}:snapshot_date={snapshot_date}"
        )
    snapshot_id = str(snapshot.get("snapshot_id") or "").strip()
    if not snapshot_id:
        raise ValueError("release_training_snapshot_id_missing")
    snapshot_schema_version = str(snapshot.get("schema_version") or "unspecified").strip()
    snapshot_checksum = _checksum(snapshot)
    input_lineage: dict[str, Any] = {}
    if snapshot_schema_version == "active8-oof-full-fit-prep-lineage-v2":
        input_lineage = {
            "prep_producer_source_sha": str(snapshot.get("producer_source_sha") or "").strip().lower(),
            "prep_manifest_checksum": str(snapshot.get("manifest_checksum") or "").strip().lower(),
            "source_manifest_checksum": str(snapshot.get("source_manifest_checksum") or "").strip().lower(),
            "source_cohort_id": str(snapshot.get("source_cohort_id") or "").strip(),
            "feature_pool_checksum": str((snapshot.get("feature_pool") or {}).get("artifact_checksum") or "").strip().lower(),
            "sequence_manifest_checksum": str((snapshot.get("sequence") or {}).get("manifest_checksum") or "").strip().lower(),
        }
        if (
            len(input_lineage["prep_producer_source_sha"]) != 40
            or any(char not in "0123456789abcdef" for char in input_lineage["prep_producer_source_sha"])
            or any(len(input_lineage[key]) != 64 for key in (
                "prep_manifest_checksum", "source_manifest_checksum",
                "feature_pool_checksum", "sequence_manifest_checksum",
            ))
            or not input_lineage["source_cohort_id"]
        ):
            raise ValueError("release_training_input_lineage_missing_or_invalid")
    contract: dict[str, Any] = {
        "schema_version": RELEASE_CONTRACT_SCHEMA_VERSION,
        "run_date": business_date,
        "dataset_snapshot_id": snapshot_id,
        "dataset_snapshot_business_date": snapshot_date,
        "dataset_snapshot_schema_version": snapshot_schema_version,
        "dataset_snapshot_checksum": snapshot_checksum,
        "input_lineage": input_lineage,
        "producer_source_sha": source_sha,
        "models": list(ACTIVE8_MODEL_NAMES),
        "train_groups": list(RELEASE_TRAIN_GROUPS),
        "artifact_lifecycle_targets": list(RELEASE_ARTIFACT_LIFECYCLE_TARGETS),
        "target_semantic_version": TARGET_SEMANTIC,
        "score_semantic": SCORE_SEMANTIC,
        "model_profile_schema_version": MODEL_PROFILE_SCHEMA_VERSION,
        "model_profiles": model_profiles(),
        "validation": dict(RELEASE_VALIDATION_CONTRACT),
        "configuration_selection": {
            "release_mode": "single_predeclared_config",
            "pbo_required": False,
            "pbo_reason": "no_model_configuration_selection_is_performed_inside_canonical_release_train",
            "research_selection_requires_model_specific_pbo": True,
            "cohort_pbo_must_not_be_used_as_per_model_pbo": True,
        },
        "model_specs": _MODEL_SPECS,
    }
    contract["contract_checksum"] = _checksum(contract)
    return contract


def validate_release_training_contract(contract: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(contract, dict):
        raise ValueError("release_training_contract_missing")
    unsigned = {key: value for key, value in contract.items() if key != "contract_checksum"}
    if contract.get("schema_version") != RELEASE_CONTRACT_SCHEMA_VERSION:
        raise ValueError("release_training_contract_schema_mismatch")
    if str(contract.get("contract_checksum") or "") != _checksum(unsigned):
        raise ValueError("release_training_contract_checksum_mismatch")
    if tuple(contract.get("models") or ()) != ACTIVE8_MODEL_NAMES:
        raise ValueError("release_training_contract_model_set_mismatch")
    if tuple(contract.get("train_groups") or ()) != RELEASE_TRAIN_GROUPS:
        raise ValueError("release_training_contract_group_set_mismatch")
    if tuple(contract.get("artifact_lifecycle_targets") or ()) != RELEASE_ARTIFACT_LIFECYCLE_TARGETS:
        raise ValueError("release_training_contract_target_set_mismatch")
    if contract.get("target_semantic_version") != TARGET_SEMANTIC:
        raise ValueError("release_training_contract_target_semantic_mismatch")
    if contract.get("score_semantic") != SCORE_SEMANTIC:
        raise ValueError("release_training_contract_score_semantic_mismatch")
    if contract.get("validation") != RELEASE_VALIDATION_CONTRACT:
        raise ValueError("release_training_contract_validation_semantic_mismatch")
    if contract.get("model_profile_schema_version") != MODEL_PROFILE_SCHEMA_VERSION:
        raise ValueError("release_training_contract_profile_schema_mismatch")
    if len(str(contract.get("dataset_snapshot_checksum") or "")) != 64:
        raise ValueError("release_training_contract_snapshot_checksum_missing")
    if not str(contract.get("dataset_snapshot_schema_version") or "").strip():
        raise ValueError("release_training_contract_snapshot_schema_missing")
    input_lineage = dict(contract.get("input_lineage") or {})
    if contract.get("dataset_snapshot_schema_version") == "active8-oof-full-fit-prep-lineage-v2":
        if (
            len(str(input_lineage.get("prep_producer_source_sha") or "")) != 40
            or any(len(str(input_lineage.get(key) or "")) != 64 for key in (
                "prep_manifest_checksum", "source_manifest_checksum",
                "feature_pool_checksum", "sequence_manifest_checksum",
            ))
            or not str(input_lineage.get("source_cohort_id") or "").strip()
        ):
            raise ValueError("release_training_contract_input_lineage_invalid")
    validate_profiles(contract.get("model_profiles") or {})
    return contract


def build_model_training_config_attestation(
    *,
    contract: dict[str, Any],
    model_name: str,
    effective_config: dict[str, Any],
) -> dict[str, Any]:
    verified = validate_release_training_contract(contract)
    model = str(model_name or "").strip()
    if model not in ACTIVE8_MODEL_NAMES:
        raise ValueError(f"release_training_model_not_allowed:{model}")
    config = _json_safe(dict(effective_config or {}))
    if not config:
        raise ValueError(f"release_training_effective_config_missing:{model}")
    profile = dict((verified.get("model_profiles") or {}).get(model) or {})
    if not profile:
        raise ValueError(f"release_training_model_profile_missing:{model}")
    require_nested_subset(config, profile.get("required_effective_config") or {})
    attestation: dict[str, Any] = {
        "schema_version": MODEL_CONFIG_ATTESTATION_SCHEMA_VERSION,
        "release_contract_checksum": verified["contract_checksum"],
        "model_name": model,
        "model_spec": _MODEL_SPECS[model],
        "model_profile_schema_version": MODEL_PROFILE_SCHEMA_VERSION,
        "model_profile": profile,
        "model_profile_checksum": profile_checksum(profile),
        "configuration_selection_mode": "single_predeclared_config",
        "selection_trials": 1,
        "pbo_applicability": "not_applicable_without_model_configuration_selection",
        "effective_config": config,
        "effective_config_checksum": _checksum(config),
        "producer_source_sha": verified["producer_source_sha"],
        "run_date": verified["run_date"],
        "dataset_snapshot_id": verified["dataset_snapshot_id"],
        "dataset_snapshot_schema_version": verified["dataset_snapshot_schema_version"],
        "dataset_snapshot_checksum": verified["dataset_snapshot_checksum"],
        "input_lineage": verified["input_lineage"],
    }
    attestation["attestation_checksum"] = _checksum(attestation)
    return attestation


def validate_model_training_config_attestation(
    attestation: dict[str, Any],
    *,
    expected_model_name: str,
) -> dict[str, Any]:
    if not isinstance(attestation, dict):
        raise ValueError("model_training_config_attestation_missing")
    unsigned = {key: value for key, value in attestation.items() if key != "attestation_checksum"}
    if attestation.get("schema_version") != MODEL_CONFIG_ATTESTATION_SCHEMA_VERSION:
        raise ValueError("model_training_config_attestation_schema_mismatch")
    if str(attestation.get("model_name") or "") != str(expected_model_name or ""):
        raise ValueError("model_training_config_attestation_model_mismatch")
    if str(attestation.get("attestation_checksum") or "") != _checksum(unsigned):
        raise ValueError("model_training_config_attestation_checksum_mismatch")
    if attestation.get("configuration_selection_mode") != "single_predeclared_config":
        raise ValueError("model_training_config_attestation_selection_mode_invalid")
    if int(attestation.get("selection_trials") or 0) != 1:
        raise ValueError("model_training_config_attestation_trial_count_invalid")
    if attestation.get("model_spec") != _MODEL_SPECS[str(expected_model_name)]:
        raise ValueError("model_training_config_attestation_model_spec_mismatch")
    profile = dict(attestation.get("model_profile") or {})
    if attestation.get("model_profile_schema_version") != MODEL_PROFILE_SCHEMA_VERSION:
        raise ValueError("model_training_config_attestation_profile_schema_mismatch")
    if profile != ACTIVE8_RELEASE_MODEL_PROFILES[str(expected_model_name)]:
        raise ValueError("model_training_config_attestation_profile_mismatch")
    if str(attestation.get("model_profile_checksum") or "") != profile_checksum(profile):
        raise ValueError("model_training_config_attestation_profile_checksum_mismatch")
    require_nested_subset(dict(attestation.get("effective_config") or {}), profile.get("required_effective_config") or {})
    if attestation.get("pbo_applicability") != "not_applicable_without_model_configuration_selection":
        raise ValueError("model_training_config_attestation_pbo_applicability_invalid")
    monthly_checksum = str(attestation.get("release_contract_checksum") or "").lower()
    if len(monthly_checksum) != 64 or any(char not in "0123456789abcdef" for char in monthly_checksum):
        raise ValueError("model_training_config_attestation_monthly_checksum_invalid")
    source_sha = str(attestation.get("producer_source_sha") or "").lower()
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise ValueError("model_training_config_attestation_source_sha_invalid")
    if len(str(attestation.get("run_date") or "")) != 10:
        raise ValueError("model_training_config_attestation_run_date_invalid")
    if not str(attestation.get("dataset_snapshot_id") or "").strip():
        raise ValueError("model_training_config_attestation_snapshot_missing")
    if str(attestation.get("effective_config_checksum") or "") != _checksum(
        dict(attestation.get("effective_config") or {})
    ):
        raise ValueError("model_training_config_attestation_effective_config_checksum_mismatch")
    return attestation


def normalize_release_raw_artifact_receipt(raw_receipt: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(raw_receipt or {})
    saved = dict(raw.get("saved") or {})
    metadata = dict(raw.get("metadata") or saved.get("metadata") or {})
    return {
        "version": raw.get("version") or metadata.get("version") or metadata.get("model_pool_version"),
        "artifact_path": raw.get("gcs_path") or raw.get("artifact_path") or saved.get("weights_path") or metadata.get("artifact_path"),
        "metadata_path": raw.get("metadata_path") or saved.get("metadata_path") or metadata.get("metadata_path"),
        "checksum": raw.get("checksum") or saved.get("checksum") or metadata.get("checksum") or metadata.get("artifact_checksum"),
        "metadata": metadata,
    }


def validate_release_artifact_receipts(
    *,
    contract: dict[str, Any],
    receipts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Require one checksum-bound candidate artifact receipt for every Active-8 model."""

    verified = validate_release_training_contract(contract)
    if tuple(receipts.keys()) != ACTIVE8_MODEL_NAMES:
        raise ValueError("release_artifact_receipt_model_set_mismatch")
    normalized: dict[str, dict[str, Any]] = {}
    for model in ACTIVE8_MODEL_NAMES:
        receipt = dict(receipts.get(model) or {})
        missing = [
            key
            for key in ("version", "artifact_path", "metadata_path", "checksum", "metadata")
            if not receipt.get(key)
        ]
        if missing:
            raise ValueError(f"release_artifact_receipt_incomplete:{model}:{','.join(missing)}")
        metadata = dict(receipt["metadata"])
        receipt_checksum = str(receipt["checksum"]).lower().removeprefix("sha256:")
        metadata_checksum = str(metadata.get("checksum") or metadata.get("artifact_checksum") or "").lower().removeprefix("sha256:")
        if len(receipt_checksum) != 64 or any(char not in "0123456789abcdef" for char in receipt_checksum):
            raise ValueError(f"release_artifact_receipt_checksum_invalid:{model}")
        if metadata_checksum != receipt_checksum:
            raise ValueError(f"release_artifact_receipt_metadata_checksum_mismatch:{model}")
        metadata_version = metadata.get("version") or metadata.get("model_pool_version")
        if str(metadata_version or "") != str(receipt["version"]):
            raise ValueError(f"release_artifact_receipt_metadata_version_mismatch:{model}")
        metadata_artifact_path = str(metadata.get("artifact_path") or "")
        if metadata_artifact_path and metadata_artifact_path != str(receipt["artifact_path"]):
            raise ValueError(f"release_artifact_receipt_metadata_path_mismatch:{model}")
        attestation = validate_model_training_config_attestation(
            metadata.get("model_training_config_attestation"),
            expected_model_name=model,
        )
        if attestation["release_contract_checksum"] != verified["contract_checksum"]:
            raise ValueError(f"release_artifact_receipt_contract_mismatch:{model}")
        if attestation["dataset_snapshot_id"] != verified["dataset_snapshot_id"]:
            raise ValueError(f"release_artifact_receipt_snapshot_mismatch:{model}")
        if attestation["run_date"] != verified["run_date"]:
            raise ValueError(f"release_artifact_receipt_run_date_mismatch:{model}")
        normalized[model] = {
            "version": str(receipt["version"]),
            "artifact_path": str(receipt["artifact_path"]),
            "metadata_path": str(receipt["metadata_path"]),
            "checksum": str(receipt["checksum"]),
            "attestation_checksum": str(attestation["attestation_checksum"]),
            "model_profile_checksum": str(attestation["model_profile_checksum"]),
        }
    return {
        "status": "complete",
        "models_completed": len(normalized),
        "models_required": len(ACTIVE8_MODEL_NAMES),
        "contract_checksum": verified["contract_checksum"],
        "receipts": normalized,
    }


def reconcile_release_artifact_receipts_from_immutable_metadata(
    *,
    contract_stage: dict[str, Any],
    run_date: str,
    dataset_snapshot: dict[str, Any],
    raw_receipts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Rebuild completion only when immutable metadata recreates the exact contract."""

    stage = dict(contract_stage or {})
    if stage.get("status") != "verified":
        raise ValueError("monthly_completion_reconciliation_contract_not_verified")
    expected_checksum = str(stage.get("checksum") or "").lower()
    if len(expected_checksum) != 64 or any(char not in "0123456789abcdef" for char in expected_checksum):
        raise ValueError("monthly_completion_reconciliation_contract_checksum_invalid")
    if set(raw_receipts) != set(ACTIVE8_MODEL_NAMES):
        raise ValueError("monthly_completion_reconciliation_model_set_mismatch")

    receipts = {
        model: normalize_release_raw_artifact_receipt(raw_receipts.get(model))
        for model in ACTIVE8_MODEL_NAMES
    }
    producer_source_shas: set[str] = set()
    for model in ACTIVE8_MODEL_NAMES:
        metadata = dict(receipts[model].get("metadata") or {})
        attestation = validate_model_training_config_attestation(
            metadata.get("model_training_config_attestation"),
            expected_model_name=model,
        )
        producer_source_shas.add(str(attestation.get("producer_source_sha") or ""))
    if len(producer_source_shas) != 1:
        raise ValueError("monthly_completion_reconciliation_source_sha_mismatch")

    contract = build_release_training_contract(
        run_date=run_date,
        dataset_snapshot=dataset_snapshot,
        producer_source_sha=next(iter(producer_source_shas)),
    )
    if contract["contract_checksum"] != expected_checksum:
        raise ValueError("monthly_completion_reconciliation_contract_checksum_mismatch")
    return validate_release_artifact_receipts(contract=contract, receipts=receipts)
