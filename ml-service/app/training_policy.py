"""Training policy helpers for Modal-side ML orchestration."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _env_str_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    values = tuple(part.strip() for part in raw.split(",") if part.strip())
    return values or default


def _coerce_str_list(value: Any, default: tuple[str, ...]) -> list[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        parsed = [part.strip() for part in value.split(",") if part.strip()]
        return parsed or list(default)
    if isinstance(value, (list, tuple, set)):
        parsed = [str(part).strip() for part in value if str(part).strip()]
        return parsed or list(default)
    return list(default)


def generated_model_pool_version(now_iso: str) -> str:
    return f"v{now_iso.replace('-', '').replace(':', '').replace('.', '')[:15]}"


def should_force_model_pool_challenger(
    *,
    gcs_prefix: str,
    walk_forward_mode: bool,
    output_model_version: str | None,
) -> bool:
    return gcs_prefix == "universal" and not walk_forward_mode and not output_model_version


@dataclass(frozen=True)
class FeatureSelectionPolicy:
    max_rounds: int = 100
    per_window_max_rounds: int = 60
    alpha: float = 0.01
    required_power: float = 0.99
    icir_weight: float = 0.1

    @classmethod
    def from_env(cls) -> "FeatureSelectionPolicy":
        return cls(
            max_rounds=_env_int("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", cls.max_rounds),
            per_window_max_rounds=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_WINDOW_MAX_ROUNDS",
                cls.per_window_max_rounds,
            ),
            alpha=_env_float("UNIVERSAL_FEATURE_SELECTION_ALPHA", cls.alpha),
            required_power=_env_float("UNIVERSAL_FEATURE_SELECTION_REQUIRED_POWER", cls.required_power),
            icir_weight=_env_float("UNIVERSAL_FEATURE_SELECTION_ICIR_WEIGHT", cls.icir_weight),
        )

    def to_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        data = asdict(self)
        overrides = overrides or {}
        return {
            "max_rounds": _coerce_int(overrides.get("max_rounds"), data["max_rounds"]),
            "alpha": _coerce_float(overrides.get("alpha"), data["alpha"]),
            "required_power": _coerce_float(overrides.get("required_power"), data["required_power"]),
            "icir_weight": _coerce_float(overrides.get("icir_weight"), data["icir_weight"]),
        }

    def to_window_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        overrides = dict(overrides or {})
        overrides.setdefault("max_rounds", self.per_window_max_rounds)
        return self.to_selection_params(overrides)


PREDICT_ONLY_MODEL_NOTES = {
    "Chronos": "Zero-shot foundation model; no monthly retrain stage",
    "KalmanFilter": "Per-stock state-space inference; no universal train artifact",
    "MarkovSwitching": "Per-stock state-space inference; shared hyperparams only",
}


TREE_MODEL_NAMES = ("XGBoost", "CatBoost", "ExtraTrees", "LightGBM")
FULL_TABULAR_MODEL_NAMES = ("FT-Transformer",)
SEQUENCE_MODEL_GROUPS = ("dlinear", "patchtst")


@dataclass(frozen=True)
class TrainingGroupFeaturePolicy:
    group: str
    models: tuple[str, ...]
    feature_source: str
    skip_feature_pool: bool
    mergeable_oos: bool
    note: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


TRAINING_GROUP_FEATURE_POLICIES: dict[str, TrainingGroupFeaturePolicy] = {
    "tree": TrainingGroupFeaturePolicy(
        group="tree",
        models=TREE_MODEL_NAMES,
        feature_source="feature_pool.tree_active",
        skip_feature_pool=False,
        mergeable_oos=True,
        note="Tree models use selected tabular features from feature_pool.tree_active.",
    ),
    "ftt": TrainingGroupFeaturePolicy(
        group="ftt",
        models=FULL_TABULAR_MODEL_NAMES,
        feature_source="feature_pool.ft_active",
        skip_feature_pool=True,
        mergeable_oos=True,
        note="FT-Transformer uses the full tabular feature set declared by feature_pool.ft_active.",
    ),
    "dlinear": TrainingGroupFeaturePolicy(
        group="dlinear",
        models=("DLinear",),
        feature_source="sequence_records.close_only",
        skip_feature_pool=True,
        mergeable_oos=False,
        note="DLinear trains on close-price sequence records, not tabular feature_pool columns.",
    ),
    "patchtst": TrainingGroupFeaturePolicy(
        group="patchtst",
        models=("PatchTST",),
        feature_source="sequence_records.close_only",
        skip_feature_pool=True,
        mergeable_oos=False,
        note="PatchTST trains on close-price sequence records, not tabular feature_pool columns.",
    ),
}


def training_group_feature_policy(group: str) -> TrainingGroupFeaturePolicy | None:
    return TRAINING_GROUP_FEATURE_POLICIES.get(str(group or "").strip().lower())


def models_for_training_group(group: str) -> list[str]:
    policy = training_group_feature_policy(group)
    return list(policy.models) if policy else []


def build_group_train_payload(base_payload: dict[str, Any], group: str) -> dict[str, Any]:
    policy = training_group_feature_policy(group)
    if policy is None:
        return dict(base_payload)
    payload = dict(base_payload)
    payload["models_filter"] = list(policy.models)
    payload["skip_feature_pool"] = policy.skip_feature_pool
    payload["feature_policy"] = policy.to_dict()
    return payload


def should_force_full_feature_pool(models_filter: list[str] | tuple[str, ...] | None) -> bool:
    if not models_filter:
        return False
    requested = {str(model) for model in models_filter}
    return bool(requested) and requested.issubset(set(FULL_TABULAR_MODEL_NAMES))


@dataclass(frozen=True)
class UniversalTrainingPolicy:
    default_train_groups: tuple[str, ...] = ("tree", "ftt", "dlinear", "patchtst")
    sequence_min_len: int = 65
    ftt_d_model: int = 128
    ftt_n_heads: int = 8
    ftt_n_layers: int = 3
    ftt_dropout: float = 0.12
    ftt_max_epochs: int = 120
    ftt_lr: float = 2e-4
    ftt_patience: int = 16
    ftt_batch_size: int = 1024
    ftt_margin: float = 0.0

    @classmethod
    def from_env(cls) -> "UniversalTrainingPolicy":
        return cls(
            default_train_groups=_env_str_list(
                "UNIVERSAL_TRAIN_MODEL_GROUPS",
                cls.default_train_groups,
            ),
            sequence_min_len=_env_int("UNIVERSAL_SEQUENCE_MIN_LEN", cls.sequence_min_len),
            ftt_d_model=_env_int("UNIVERSAL_FTT_D_MODEL", cls.ftt_d_model),
            ftt_n_heads=_env_int("UNIVERSAL_FTT_N_HEADS", cls.ftt_n_heads),
            ftt_n_layers=_env_int("UNIVERSAL_FTT_N_LAYERS", cls.ftt_n_layers),
            ftt_dropout=_env_float("UNIVERSAL_FTT_DROPOUT", cls.ftt_dropout),
            ftt_max_epochs=_env_int("UNIVERSAL_FTT_MAX_EPOCHS", cls.ftt_max_epochs),
            ftt_lr=_env_float("UNIVERSAL_FTT_LR", cls.ftt_lr),
            ftt_patience=_env_int("UNIVERSAL_FTT_PATIENCE", cls.ftt_patience),
            ftt_batch_size=_env_int("UNIVERSAL_FTT_BATCH_SIZE", cls.ftt_batch_size),
            ftt_margin=_env_float("UNIVERSAL_FTT_MARGIN", cls.ftt_margin),
        )

    def requested_groups(self, payload: dict[str, Any] | None = None) -> list[str]:
        payload = payload or {}
        return _coerce_str_list(payload.get("train_model_groups"), self.default_train_groups)

    def sequence_min_length(self, payload: dict[str, Any] | None = None) -> int:
        payload = payload or {}
        return _coerce_int(payload.get("sequence_min_len"), self.sequence_min_len)

    def to_base_train_payload(
        self,
        payload: dict[str, Any] | None,
        *,
        candidate_version: str,
    ) -> dict[str, float | int | str | bool]:
        payload = payload or {}
        return {
            "batch_count": _coerce_int(payload.get("batch_count"), 5),
            "ftt_d_model": _coerce_int(payload.get("ftt_d_model"), self.ftt_d_model),
            "ftt_n_heads": _coerce_int(payload.get("ftt_n_heads"), self.ftt_n_heads),
            "ftt_n_layers": _coerce_int(payload.get("ftt_n_layers"), self.ftt_n_layers),
            "ftt_dropout": _coerce_float(payload.get("ftt_dropout"), self.ftt_dropout),
            "ftt_max_epochs": _coerce_int(payload.get("ftt_max_epochs"), self.ftt_max_epochs),
            "ftt_lr": _coerce_float(payload.get("ftt_lr"), self.ftt_lr),
            "ftt_patience": _coerce_int(payload.get("ftt_patience"), self.ftt_patience),
            "ftt_batch_size": _coerce_int(payload.get("ftt_batch_size"), self.ftt_batch_size),
            "ftt_margin": _coerce_float(payload.get("ftt_margin"), self.ftt_margin),
            "output_model_version": candidate_version,
            "register_challengers": False,
        }
