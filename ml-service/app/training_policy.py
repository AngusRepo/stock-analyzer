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
    permutation_mode: str = "within_date_sector"
    signal_sanity_max_workers: int = 2
    target_permutation_max_workers: int = 2
    k_sweep_n_jobs: int = 2

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
            permutation_mode=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_PERMUTATION_MODE",
                cls.permutation_mode,
            ).strip() or cls.permutation_mode,
            signal_sanity_max_workers=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_SIGNAL_SANITY_WORKERS",
                cls.signal_sanity_max_workers,
            ),
            target_permutation_max_workers=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_TARGET_PERM_WORKERS",
                cls.target_permutation_max_workers,
            ),
            k_sweep_n_jobs=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_K_SWEEP_JOBS",
                cls.k_sweep_n_jobs,
            ),
        )

    def to_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        data = asdict(self)
        overrides = overrides or {}
        return {
            "max_rounds": _coerce_int(overrides.get("max_rounds"), data["max_rounds"]),
            "alpha": _coerce_float(overrides.get("alpha"), data["alpha"]),
            "required_power": _coerce_float(overrides.get("required_power"), data["required_power"]),
            "icir_weight": _coerce_float(overrides.get("icir_weight"), data["icir_weight"]),
            "permutation_mode": str(overrides.get("permutation_mode") or data["permutation_mode"]),
            "signal_sanity_max_workers": _coerce_int(
                overrides.get("signal_sanity_max_workers"),
                data["signal_sanity_max_workers"],
            ),
            "target_permutation_max_workers": _coerce_int(
                overrides.get("target_permutation_max_workers"),
                data["target_permutation_max_workers"],
            ),
            "k_sweep_n_jobs": _coerce_int(overrides.get("k_sweep_n_jobs"), data["k_sweep_n_jobs"]),
        }

    def to_window_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        overrides = dict(overrides or {})
        overrides.setdefault("max_rounds", self.per_window_max_rounds)
        return self.to_selection_params(overrides)


@dataclass(frozen=True)
class ValidationGovernancePolicy:
    embargo_base_days: int = 10
    embargo_pct: float = 0.015
    max_embargo_days: int = 20
    cpcv_n_groups: int = 6
    cpcv_n_test_groups: int = 2
    cpcv_min_train_groups: int = 2

    @classmethod
    def from_env(cls) -> "ValidationGovernancePolicy":
        return cls(
            embargo_base_days=_env_int(
                "UNIVERSAL_VALIDATION_EMBARGO_BASE_DAYS",
                cls.embargo_base_days,
            ),
            embargo_pct=_env_float("UNIVERSAL_VALIDATION_EMBARGO_PCT", cls.embargo_pct),
            max_embargo_days=_env_int(
                "UNIVERSAL_VALIDATION_MAX_EMBARGO_DAYS",
                cls.max_embargo_days,
            ),
            cpcv_n_groups=_env_int(
                "UNIVERSAL_VALIDATION_CPCV_N_GROUPS",
                cls.cpcv_n_groups,
            ),
            cpcv_n_test_groups=_env_int(
                "UNIVERSAL_VALIDATION_CPCV_N_TEST_GROUPS",
                cls.cpcv_n_test_groups,
            ),
            cpcv_min_train_groups=_env_int(
                "UNIVERSAL_VALIDATION_CPCV_MIN_TRAIN_GROUPS",
                cls.cpcv_min_train_groups,
            ),
        )

    def to_split_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        overrides = overrides or {}
        return {
            "embargo_base_days": _coerce_int(
                overrides.get("embargo_base_days"),
                self.embargo_base_days,
            ),
            "embargo_pct": _coerce_float(overrides.get("embargo_pct"), self.embargo_pct),
            "max_embargo_days": _coerce_int(
                overrides.get("max_embargo_days"),
                self.max_embargo_days,
            ),
            "cpcv_n_groups": _coerce_int(overrides.get("cpcv_n_groups"), self.cpcv_n_groups),
            "cpcv_n_test_groups": _coerce_int(
                overrides.get("cpcv_n_test_groups"),
                self.cpcv_n_test_groups,
            ),
            "cpcv_min_train_groups": _coerce_int(
                overrides.get("cpcv_min_train_groups"),
                self.cpcv_min_train_groups,
            ),
        }


PREDICT_ONLY_MODEL_NOTES = {
    "Chronos": "Foundation forecast slot; zero-shot serving plus optional LoRA adapter, validated by forecast/outcome evidence",
    "KalmanFilter": "Per-stock state-space inference; no universal train artifact",
    "MarkovSwitching": "Per-stock state-space inference; shared hyperparams only",
}


TREE_MODEL_NAMES = ("XGBoost", "CatBoost", "ExtraTrees", "LightGBM")
FULL_TABULAR_MODEL_NAMES: tuple[str, ...] = ()
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


@dataclass(frozen=True)
class ModelFeaturePolicy:
    model: str
    family: str
    feature_policy_type: str
    feature_source: str
    selection_owner: str
    selection_required: bool
    uses_missingness_mask: bool
    requires_schema_parity: bool
    mergeable_oos: bool
    allowed_selection_methods: tuple[str, ...]
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


_TABULAR_SELECTION_METHODS = (
    "signal_sanity_gate",
    "target_permutation_block_date_sector",
    "correlation_clustering",
    "ic_icir_stability",
    "mutual_information",
    "stability_selection",
    "cur",
    "optuna_k_sweep",
    "diversity_guard",
)


MODEL_FEATURE_POLICIES: dict[str, ModelFeaturePolicy] = {
    **{
        name: ModelFeaturePolicy(
            model=name,
            family="tree",
            feature_policy_type="selected_tabular",
            feature_source="feature_pool.tree_active",
            selection_owner="feature_selection_pipeline",
            selection_required=True,
            uses_missingness_mask=False,
            requires_schema_parity=True,
            mergeable_oos=True,
            allowed_selection_methods=_TABULAR_SELECTION_METHODS,
            note="Tree models use selected tabular features only; no all-feature fallback in governed retrain.",
        )
        for name in TREE_MODEL_NAMES
    },
    "DLinear": ModelFeaturePolicy(
        model="DLinear",
        family="sequence",
        feature_policy_type="time_series_close_only",
        feature_source="sequence_records.close_only",
        selection_owner="sequence_training",
        selection_required=False,
        uses_missingness_mask=False,
        requires_schema_parity=False,
        mergeable_oos=False,
        allowed_selection_methods=("sequence_window_contract", "sequence_oos_ic"),
        note="DLinear follows its paper-aligned close-price sequence contract, not tabular feature selection.",
    ),
    "PatchTST": ModelFeaturePolicy(
        model="PatchTST",
        family="sequence_transformer",
        feature_policy_type="time_series_close_only",
        feature_source="sequence_records.close_only",
        selection_owner="sequence_training",
        selection_required=False,
        uses_missingness_mask=False,
        requires_schema_parity=False,
        mergeable_oos=False,
        allowed_selection_methods=("sequence_window_contract", "sequence_oos_ic"),
        note="PatchTST follows channel-independent sequence windows, not tabular all-features.",
    ),
    "Chronos": ModelFeaturePolicy(
        model="Chronos",
        family="foundation_time_series",
        feature_policy_type="chronos2_zero_shot_lora_time_series",
        feature_source="chronos2.context.close_series",
        selection_owner="chronos_universal",
        selection_required=False,
        uses_missingness_mask=False,
        requires_schema_parity=False,
        mergeable_oos=False,
        allowed_selection_methods=("chronos2_context_window", "chronos2_member_contract"),
        note="Chronos is the Chronos-2 production slot and does not consume tree/FT feature selection.",
    ),
}


FEATURE_SELECTION_GOVERNANCE = {
    "schema_version": "feature-selection-governance-v1",
    "primary_permutation_mode": "within_date_sector",
    "methods": {
        "target_permutation_block_date_sector": {
            "role": "Leakage-resistant signal survival test; permutes labels inside date and sector blocks.",
            "status": "active",
        },
        "correlation_clustering": {
            "role": "Reduces redundant tabular features before final active/reserve split.",
            "status": "active",
        },
        "mutual_information": {
            "role": "Nonlinear candidate evidence used as a low-weight governance tie-breaker.",
            "status": "active",
        },
        "stability_selection": {
            "role": "Block/date-aware robustness evidence used as a low-weight governance tie-breaker.",
            "status": "active",
        },
        "cur": {
            "role": "CUR-style column leverage evidence for representative feature coverage.",
            "status": "active",
        },
    },
}


def training_group_feature_policy(group: str) -> TrainingGroupFeaturePolicy | None:
    return TRAINING_GROUP_FEATURE_POLICIES.get(str(group or "").strip().lower())


def models_for_training_group(group: str) -> list[str]:
    policy = training_group_feature_policy(group)
    return list(policy.models) if policy else []


def build_group_train_payload(base_payload: dict[str, Any], group: str) -> dict[str, Any]:
    normalized_group = str(group or "").strip().lower()
    policy = training_group_feature_policy(normalized_group)
    if policy is None:
        return dict(base_payload)
    payload = dict(base_payload)
    payload["models_filter"] = list(policy.models)
    payload["skip_feature_pool"] = policy.skip_feature_pool
    payload["feature_policy"] = policy.to_dict()
    return payload


def build_tree_model_child_payloads(base_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Build one governed train payload per tree model for opt-in fan-out."""

    tree_payload = build_group_train_payload(base_payload, "tree")
    payloads: dict[str, dict[str, Any]] = {}
    for model_name in TREE_MODEL_NAMES:
        child = dict(tree_payload)
        child["models_filter"] = [model_name]
        child["tree_split_parent_models"] = list(TREE_MODEL_NAMES)
        child["tree_split_model"] = model_name
        child["training_run_suffix"] = model_name.lower()
        payloads[model_name] = child
    return payloads


def should_force_full_feature_pool(models_filter: list[str] | tuple[str, ...] | None) -> bool:
    if not models_filter:
        return False
    requested = {str(model) for model in models_filter}
    return bool(requested) and requested.issubset(set(FULL_TABULAR_MODEL_NAMES))


def feature_policy_for_model(model_name: str) -> ModelFeaturePolicy:
    key = str(model_name or "").strip()
    if key not in MODEL_FEATURE_POLICIES:
        raise KeyError(f"Unknown model feature policy: {model_name}")
    return MODEL_FEATURE_POLICIES[key]


def build_model_feature_policy_metadata(
    model_name: str,
    feature_names: list[str] | tuple[str, ...],
    selection_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy = feature_policy_for_model(model_name)
    return {
        "feature_policy": policy.to_dict(),
        "feature_policy_schema_version": "model-feature-policy-v1",
        "feature_count": int(len(feature_names)),
        "selection_evidence": selection_evidence or {},
    }


@dataclass(frozen=True)
class UniversalTrainingPolicy:
    default_train_groups: tuple[str, ...] = ("tree", "dlinear", "patchtst")
    sequence_min_len: int = 65

    @classmethod
    def from_env(cls) -> "UniversalTrainingPolicy":
        return cls(
            default_train_groups=_env_str_list(
                "UNIVERSAL_TRAIN_MODEL_GROUPS",
                cls.default_train_groups,
            ),
            sequence_min_len=_env_int("UNIVERSAL_SEQUENCE_MIN_LEN", cls.sequence_min_len),
        )

    def requested_groups(self, payload: dict[str, Any] | None = None) -> list[str]:
        payload = payload or {}
        groups = _coerce_str_list(payload.get("train_model_groups"), self.default_train_groups)
        return [group for group in groups if group in TRAINING_GROUP_FEATURE_POLICIES]

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
        model_cpcv_policy = payload.get("model_cpcv_policy") or {"family_adapters": {}}
        return {
            "batch_count": _coerce_int(payload.get("batch_count"), 5),
            "output_model_version": candidate_version,
            "register_challengers": False,
            "model_cpcv_policy": model_cpcv_policy,
        }
