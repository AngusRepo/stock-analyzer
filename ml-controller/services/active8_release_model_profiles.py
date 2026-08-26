"""Predeclared per-model profiles for the formal Active-8 canonical OOF/full-fit release train."""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any


MODEL_PROFILE_SCHEMA_VERSION = "active8-release-model-profiles-v1"
TARGET_SEMANTIC = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
SCORE_SEMANTIC = "same-market-same-date-average-tie-percentile-rank-v2"

_CUDA_REPRODUCIBILITY = {
    "seed": 42,
    "torch_available": True,
    "torch_deterministic_algorithms": True,
    "torch_deterministic_warn_only": True,
    "cudnn_benchmark": False,
    "cublas_workspace_config": ":4096:8",
}

ACTIVE8_RELEASE_MODEL_PROFILES: dict[str, dict[str, Any]] = {
    "LightGBM": {
        "runtime": {"executor": "modal_cpu", "configuration_selection": "none"},
        "payload_config": {"seed": 42},
        "required_effective_config": {
            "estimator_params": {
                "n_estimators": 300,
                "max_depth": 6,
                "learning_rate": 0.03,
                "num_leaves": 63,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "min_child_samples": 20,
                "random_state": 42,
            },
            "target_semantic_version": TARGET_SEMANTIC,
            "score_semantic": SCORE_SEMANTIC,
        },
    },
    "XGBoost": {
        "runtime": {"executor": "modal_cpu", "configuration_selection": "none"},
        "payload_config": {"seed": 42},
        "required_effective_config": {
            "estimator_params": {
                "n_estimators": 300,
                "max_depth": 6,
                "learning_rate": 0.03,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "random_state": 42,
            },
            "target_semantic_version": TARGET_SEMANTIC,
            "score_semantic": SCORE_SEMANTIC,
        },
    },
    "ExtraTrees": {
        "runtime": {"executor": "modal_cpu", "configuration_selection": "none"},
        "payload_config": {"seed": 42},
        "required_effective_config": {
            "estimator_params": {
                "n_estimators": 300,
                "max_depth": 8,
                "min_samples_split": 10,
                "min_samples_leaf": 5,
                "max_features": "sqrt",
                "bootstrap": True,
                "random_state": 42,
            },
            "target_semantic_version": TARGET_SEMANTIC,
            "score_semantic": SCORE_SEMANTIC,
        },
    },
    "TabM": {
        "runtime": {"executor": "modal_l4", "configuration_selection": "none"},
        "payload_config": {
            "epochs": 16,
            "batch_size": 1024,
            "lr": 0.002,
            "weight_decay": 0.0003,
            "standardization_clip": 8.0,
            "seed": 42,
        },
        "required_effective_config": {
            "epochs": 16,
            "batch_size": 1024,
            "lr": 0.002,
            "weight_decay": 0.0003,
            "standardization_clip": 8.0,
            "device": "cuda",
            "seed": 42,
            "reproducibility": _CUDA_REPRODUCIBILITY,
            "target_semantic_version": TARGET_SEMANTIC,
        },
    },
    "GNN": {
        "runtime": {"executor": "modal_l4", "configuration_selection": "none"},
        "payload_config": {
            "epochs": 36,
            "hidden_dim": 64,
            "dropout": 0.12,
            "lr": 0.003,
            "weight_decay": 0.0001,
            "max_train_dates_per_epoch": 120,
            "edge_top_k": 8,
            "edge_threshold": 0.25,
            "standardization_clip": 8.0,
            "seed": 42,
        },
        "required_effective_config": {
            "epochs": 36,
            "hidden_dim": 64,
            "dropout": 0.12,
            "lr": 0.003,
            "weight_decay": 0.0001,
            "max_train_dates_per_epoch": 120,
            "edge_top_k": 8,
            "edge_threshold": 0.25,
            "standardization_clip": 8.0,
            "device": "cuda",
            "seed": 42,
            "reproducibility": _CUDA_REPRODUCIBILITY,
            "target_semantic_version": TARGET_SEMANTIC,
        },
    },
    "DLinear": {
        "runtime": {"executor": "modal_l4", "configuration_selection": "none"},
        "payload_config": {
            "seq_len": 512,
            "pred_len": 5,
            "kernel": 25,
            "n_epochs": 30,
            "batch_size": 256,
            "lr": 0.001,
            "val_ratio": 0.15,
            "seed": 42,
            "device": "cuda",
        },
        "required_effective_config": {
            "seq_len": 512,
            "pred_len": 5,
            "kernel": 25,
            "n_epochs": 30,
            "batch_size": 256,
            "lr": 0.001,
            "val_ratio": 0.15,
            "device": "cuda",
            "seed": 42,
            "reproducibility": _CUDA_REPRODUCIBILITY,
            "target_semantic_version": TARGET_SEMANTIC,
        },
    },
    "PatchTST": {
        "runtime": {
            "executor": "modal_l4",
            "configuration_selection": "none",
            "research_receipt": "patchtst-full-pit-outer-oof-5x3-2026-08-25",
            "research_receipt_sha256": "e369dc7541a91d03dad4c66d8bac6ced8092c6fc3b8e7b193f7a31336712a675",
            "research_summary_receipt_path": "ml-controller/research_receipts/patchtst-full-pit-outer-oof-5x3-2026-08-25.json",
            "research_summary_receipt_sha256": "2fd06a7531729417ce05d0f4a3292469f510761f11fcb44d02817cc252d4497e",
            "research_source_bundle_checksum": "68106ea56ca74d8c31a3475107a2ee71c589290dced584a2386a144e5a1f693a",
            "research_gate_passed": True,
            "research_production_effect": False,
            "research_runs": 15,
        },
        "payload_config": {
            "seq_len": 512,
            "pred_len": 5,
            "max_steps": 120,
            "batch_size": 256,
            "max_series": 1024,
            "validation_folds": 5,
            "seed": 42,
            "device": "cuda",
            "oof_training_history_mode": "full_pit_history",
            "trainer_deterministic": True,
            "learning_rate": 0.0001,
            "windows_batch_size": 1024,
            "inference_windows_batch_size": 1024,
            "scaler_type": "identity",
            "step_size": 1,
            "patch_len": 16,
            "stride": 8,
            "revin": True,
        },
        "required_effective_config": {
            "seq_len": 512,
            "pred_len": 5,
            "max_steps": 120,
            "batch_size": 256,
            "seed": 42,
            "max_series": 1024,
            "validation_folds": 5,
            "runtime_device": "cuda",
            "runtime_package": "neuralforecast==3.1.9",
            "reproducibility": _CUDA_REPRODUCIBILITY,
            "training_options": {
                "oof_training_history_mode": "full_pit_history",
                "trainer_deterministic": True,
                "trainer_benchmark": False,
                "learning_rate": 0.0001,
                "windows_batch_size": 1024,
                "inference_windows_batch_size": 1024,
                "scaler_type": "identity",
                "step_size": 1,
                "patch_len": 16,
                "stride": 8,
                "revin": True,
            },
            "target_semantic_version": TARGET_SEMANTIC,
        },
    },
    "iTransformer": {
        "runtime": {"executor": "modal_l4", "configuration_selection": "none"},
        "payload_config": {
            "seq_len": 512,
            "pred_len": 5,
            "max_steps": 30,
            "batch_size": 128,
            "max_series": 1024,
            "validation_folds": 5,
            "seed": 42,
            "device": "cuda",
            "oof_training_history_mode": "full_pit_history",
            "trainer_deterministic": True,
            "learning_rate": 0.001,
            "windows_batch_size": 32,
            "inference_windows_batch_size": 32,
            "scaler_type": "identity",
            "step_size": 1,
        },
        "required_effective_config": {
            "seq_len": 512,
            "pred_len": 5,
            "max_steps": 30,
            "batch_size": 128,
            "seed": 42,
            "max_series": 1024,
            "validation_folds": 5,
            "runtime_device": "cuda",
            "runtime_package": "neuralforecast==3.1.9",
            "reproducibility": _CUDA_REPRODUCIBILITY,
            "training_options": {
                "oof_training_history_mode": "full_pit_history",
                "trainer_deterministic": True,
                "trainer_benchmark": False,
                "learning_rate": 0.001,
                "windows_batch_size": 32,
                "inference_windows_batch_size": 32,
                "scaler_type": "identity",
                "step_size": 1,
            },
            "target_semantic_version": TARGET_SEMANTIC,
        },
    },
}


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_canonical(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def checksum(value: dict[str, Any]) -> str:
    raw = json.dumps(_canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def model_profile(model_name: str) -> dict[str, Any]:
    model = str(model_name or "").strip()
    if model not in ACTIVE8_RELEASE_MODEL_PROFILES:
        raise ValueError(f"release_model_profile_missing:{model}")
    return copy.deepcopy(ACTIVE8_RELEASE_MODEL_PROFILES[model])


def model_profiles() -> dict[str, dict[str, Any]]:
    return copy.deepcopy(ACTIVE8_RELEASE_MODEL_PROFILES)


def release_model_payload(model_name: str) -> dict[str, Any]:
    return copy.deepcopy(model_profile(model_name)["payload_config"])


def require_nested_subset(actual: Any, required: Any, *, path: str = "effective_config") -> None:
    if isinstance(required, dict):
        if not isinstance(actual, dict):
            raise ValueError(f"release_model_profile_type_mismatch:{path}")
        for key, value in required.items():
            if key not in actual:
                raise ValueError(f"release_model_profile_field_missing:{path}.{key}")
            require_nested_subset(actual[key], value, path=f"{path}.{key}")
        return
    if actual != required:
        raise ValueError(f"release_model_profile_value_mismatch:{path}:expected={required}:actual={actual}")


def validate_profiles(profiles: dict[str, Any]) -> dict[str, Any]:
    if profiles != ACTIVE8_RELEASE_MODEL_PROFILES:
        raise ValueError("release_model_profiles_mismatch")
    return profiles
