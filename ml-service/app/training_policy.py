"""Training policy helpers for Modal-side ML orchestration."""

from __future__ import annotations

import hashlib
import json
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


def _coerce_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "enabled"}:
        return True
    if text in {"0", "false", "no", "off", "disabled"}:
        return False
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


def should_force_artifact_candidate_version(
    *,
    gcs_prefix: str,
    walk_forward_mode: bool,
    output_model_version: str | None,
) -> bool:
    return gcs_prefix == "universal" and not walk_forward_mode and not output_model_version


def should_force_model_pool_challenger(
    *,
    gcs_prefix: str,
    walk_forward_mode: bool,
    output_model_version: str | None,
) -> bool:
    """Backward-compatible alias for older callers.

    The Active-8 direct-alpha flow no longer writes model_pool challenger slots; this helper
    only decides whether a universal train needs an artifact candidate version.
    """

    return should_force_artifact_candidate_version(
        gcs_prefix=gcs_prefix,
        walk_forward_mode=walk_forward_mode,
        output_model_version=output_model_version,
    )


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
    algorithm_profile: str = "candidate_v2"
    cluster_linkage: str = "ward"
    k_sweep_sampler: str = "nsga2"
    k_sweep_objective: str = "single_val_ic"
    k_sweep_knee_policy: str = "kneedle_080"
    k_sweep_bootstrap_rounds: int = 0
    embargo_mode: str = "dynamic"
    label_horizon_days: int = 5

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
            algorithm_profile=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_ALGO_PROFILE",
                cls.algorithm_profile,
            ).strip() or cls.algorithm_profile,
            cluster_linkage=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_CLUSTER_LINKAGE",
                cls.cluster_linkage,
            ).strip() or cls.cluster_linkage,
            k_sweep_sampler=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_K_SWEEP_SAMPLER",
                cls.k_sweep_sampler,
            ).strip() or cls.k_sweep_sampler,
            k_sweep_objective=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_K_SWEEP_OBJECTIVE",
                cls.k_sweep_objective,
            ).strip() or cls.k_sweep_objective,
            k_sweep_knee_policy=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_K_SWEEP_KNEE_POLICY",
                cls.k_sweep_knee_policy,
            ).strip() or cls.k_sweep_knee_policy,
            k_sweep_bootstrap_rounds=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_K_SWEEP_BOOTSTRAP_ROUNDS",
                cls.k_sweep_bootstrap_rounds,
            ),
            embargo_mode=os.environ.get(
                "UNIVERSAL_FEATURE_SELECTION_EMBARGO_MODE",
                cls.embargo_mode,
            ).strip() or cls.embargo_mode,
            label_horizon_days=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_LABEL_HORIZON_DAYS",
                cls.label_horizon_days,
            ),
        )

    def to_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int | str]:
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
            "algorithm_profile": str(overrides.get("algorithm_profile") or data["algorithm_profile"]),
            "cluster_linkage": str(overrides.get("cluster_linkage") or data["cluster_linkage"]),
            "k_sweep_sampler": str(overrides.get("k_sweep_sampler") or data["k_sweep_sampler"]),
            "k_sweep_objective": str(overrides.get("k_sweep_objective") or data["k_sweep_objective"]),
            "k_sweep_knee_policy": str(
                overrides.get("k_sweep_knee_policy") or data["k_sweep_knee_policy"]
            ),
            "k_sweep_bootstrap_rounds": _coerce_int(
                overrides.get("k_sweep_bootstrap_rounds"),
                data["k_sweep_bootstrap_rounds"],
            ),
            "embargo_mode": str(overrides.get("embargo_mode") or data["embargo_mode"]),
            "label_horizon_days": _coerce_int(
                overrides.get("label_horizon_days"),
                data["label_horizon_days"],
            ),
        }

    def to_window_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int | str]:
        overrides = dict(overrides or {})
        overrides.setdefault("max_rounds", self.per_window_max_rounds)
        return self.to_selection_params(overrides)


FEATURE_SELECTION_RUN_KWARG_KEYS = (
    "max_rounds",
    "alpha",
    "required_power",
    "icir_weight",
    "permutation_mode",
    "signal_sanity_max_workers",
    "target_permutation_max_workers",
    "k_sweep_n_jobs",
    "algorithm_profile",
    "cluster_linkage",
    "k_sweep_sampler",
    "k_sweep_objective",
    "k_sweep_knee_policy",
    "k_sweep_bootstrap_rounds",
    "embargo_mode",
    "label_horizon_days",
)


def build_feature_selection_run_kwargs(selection_params: dict[str, Any]) -> dict[str, Any]:
    """Map policy params to run_feature_selection_pipeline kwargs."""

    return {
        key: selection_params[key]
        for key in FEATURE_SELECTION_RUN_KWARG_KEYS
        if key in selection_params
    }


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
    "KalmanFilter": "Per-stock state-space inference; no universal train artifact",
    "MarkovSwitching": "Per-stock state-space inference; shared hyperparams only",
}


TREE_MODEL_NAMES = ("LightGBM", "XGBoost", "ExtraTrees")
FULL_TABULAR_MODEL_NAMES: tuple[str, ...] = ()
SEQUENCE_MODEL_GROUPS = ("dlinear", "patchtst")
ARTIFACT_LIFECYCLE_GROUP_MODEL = {
    "patchtst": "PatchTST",
}


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


ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION = "active8-family-feature-contract-v3"
TIMESFM_L175_RELEASE_COHORT = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
)


def active8_family_feature_contract(
    model_name: str,
    *,
    feature_release_mode: str | None = None,
) -> dict[str, Any]:
    """Return the model-family input contract, not a blanket column-count rule."""

    model = str(model_name or "").strip()
    release = str(feature_release_mode or "").strip()
    if model in {"LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"}:
        timesfm_release = release == "timesfm_l175_l2_feature_release"
        return {
            "schema_version": ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION,
            "model": model,
            "family_schema": (
                "formal137_plus_timesfm_l175_v1"
                if timesfm_release
                else "formal137_selected_tabular_v1"
            ),
            "input_semantics": (
                "graph_node_features_from_governed_tabular_universe"
                if model == "GNN"
                else "selected_subset_from_governed_tabular_universe"
            ),
            "release_id": release or "formal137_baseline",
            "release_cohort": list(TIMESFM_L175_RELEASE_COHORT) if timesfm_release else [model],
            "atomic_cohort_required": timesfm_release,
            "timesfm_l175_sidecar_required": timesfm_release,
        }
    sequence_schema = {
        "DLinear": "close_univariate_decomposition_v1",
        "PatchTST": "close_channel_independent_v1",
        "iTransformer": "close_cross_stock_panel_v1",
    }.get(model)
    if sequence_schema:
        return {
            "schema_version": ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION,
            "model": model,
            "family_schema": sequence_schema,
            "input_semantics": (
                "cross_stock_series_are_variates"
                if model == "iTransformer"
                else "independent_close_series"
            ),
            "release_id": "sequence_records_v3",
            "release_cohort": [model],
            "atomic_cohort_required": False,
            "timesfm_l175_sidecar_required": False,
        }
    if model == "TimesFM":
        return {
            "schema_version": ACTIVE8_FAMILY_FEATURE_CONTRACT_VERSION,
            "model": model,
            "family_schema": "timesfm_close_sidecar_v1",
            "input_semantics": "l2_feature_sidecar_not_direct_alpha",
            "release_id": release or "timesfm_l2_sidecar",
            "release_cohort": [model],
            "atomic_cohort_required": False,
            "timesfm_l175_sidecar_required": False,
        }
    raise KeyError(f"Unknown active-8 family feature contract: {model_name}")


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
    "TabM": ModelFeaturePolicy(
        model="TabM",
        family="tabular_neural",
        feature_policy_type="selected_tabular_artifact_required",
        feature_source="feature_pool.tree_active",
        selection_owner="artifact_registration_preflight",
        selection_required=True,
        uses_missingness_mask=True,
        requires_schema_parity=True,
        mergeable_oos=True,
        allowed_selection_methods=_TABULAR_SELECTION_METHODS + ("production_artifact",),
        note="TabM is a formal L3 production slot; serving is artifact-backed and fails closed when schema parity or lifecycle evidence is missing.",
    ),
    "GNN": ModelFeaturePolicy(
        model="GNN",
        family="cross_stock_graph",
        feature_policy_type="graph_artifact_required",
        feature_source="graph_feature_contract",
        selection_owner="artifact_registration_preflight",
        selection_required=True,
        uses_missingness_mask=True,
        requires_schema_parity=True,
        mergeable_oos=True,
        allowed_selection_methods=("graph_spec", "production_artifact", "positive_ic"),
        note="GNN is a formal L3 production slot; serving is graph-artifact-backed and fails closed when graph evidence or lifecycle evidence is missing.",
    ),
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
    "iTransformer": ModelFeaturePolicy(
        model="iTransformer",
        family="sequence_transformer",
        feature_policy_type="time_series_artifact_required",
        feature_source="sequence_records.close_only",
        selection_owner="artifact_registration_preflight",
        selection_required=False,
        uses_missingness_mask=False,
        requires_schema_parity=True,
        mergeable_oos=False,
        allowed_selection_methods=("sequence_window_contract", "production_artifact", "positive_ic"),
        note="iTransformer is a formal L3 sequence production slot; serving is artifact-backed and fails closed when sequence evidence is missing.",
    ),
    "TimesFM": ModelFeaturePolicy(
        model="TimesFM",
        family="foundation_time_series",
        feature_policy_type="timesfm_l2_feature_sidecar_artifact_required",
        feature_source="sequence_records.close_only",
        selection_owner="timesfm_l2_sidecar_release",
        selection_required=False,
        uses_missingness_mask=False,
        requires_schema_parity=True,
        mergeable_oos=False,
        allowed_selection_methods=("timesfm_l2_feature_release", "forecast_validation", "production_artifact"),
        note="TimesFM is an L2 feature sidecar; serving is config-backed and contributes enriched features before active-8 L3 direct-alpha models.",
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


def dedupe_train_groups_for_artifact_lifecycle(
    requested_groups: list[str],
    artifact_lifecycle_targets: list[str] | tuple[str, ...] | set[str] | None,
    *,
    allow_duplicate: bool = False,
) -> tuple[list[str], list[dict[str, str]]]:
    """Suppress train groups that would retrain the same artifact lifecycle target."""

    if allow_duplicate:
        return list(requested_groups), []
    targets = {str(target).strip() for target in (artifact_lifecycle_targets or []) if str(target).strip()}
    deduped: list[str] = []
    suppressed: list[dict[str, str]] = []
    for group in requested_groups:
        model_name = ARTIFACT_LIFECYCLE_GROUP_MODEL.get(str(group or "").strip().lower())
        if model_name and model_name in targets:
            suppressed.append({
                "group": group,
                "model": model_name,
                "reason": "artifact_lifecycle_target_owns_training",
            })
            continue
        deduped.append(group)
    return deduped, suppressed


def build_group_train_payload(base_payload: dict[str, Any], group: str) -> dict[str, Any]:
    policy = training_group_feature_policy(group)
    if policy is None:
        return dict(base_payload)
    payload = dict(base_payload)
    timesfm_l175_feature_release = (
        str(base_payload.get("candidate_type") or "").strip() == "timesfm_l175_l2_feature_release"
        and str(group or "").strip().lower() == "tree"
    )
    payload["models_filter"] = list(policy.models)
    payload["skip_feature_pool"] = True if timesfm_l175_feature_release else policy.skip_feature_pool
    feature_policy = policy.to_dict()
    if timesfm_l175_feature_release:
        feature_policy = {
            **feature_policy,
            "feature_policy_type": "formal137_timesfm_l175_feature_release",
            "feature_source": "prep.full_formal137_plus_timesfm_l175",
            "selection_required": False,
            "note": "TimesFM L2 feature release retrains tree artifacts on full formal137 + timesfm_l175 sidecar columns.",
        }
    payload["feature_policy"] = feature_policy
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
    *,
    feature_release_mode: str | None = None,
) -> dict[str, Any]:
    policy = feature_policy_for_model(model_name)
    return {
        "feature_policy": policy.to_dict(),
        "feature_policy_schema_version": "model-feature-policy-v2",
        "family_feature_contract": active8_family_feature_contract(
            model_name,
            feature_release_mode=feature_release_mode,
        ),
        "feature_count": int(len(feature_names)),
        "selection_evidence": selection_evidence or {},
    }


def build_model_training_config_attestation(
    model_name: str,
    payload: dict[str, Any],
    effective_config: dict[str, Any],
) -> dict[str, Any] | None:
    """Bind a monthly artifact to the exact immutable contract and effective config.

    Non-monthly and research artifacts deliberately return ``None``. A monthly
    candidate cannot be produced without a valid contract and non-empty effective
    settings, so PBO is never waived merely because a caller wrote trials=1.
    """

    contract = payload.get("monthly_training_contract")
    candidate_type = str(payload.get("candidate_type") or "").strip()
    if contract is None and candidate_type != "monthly_release":
        return None
    if not isinstance(contract, dict):
        raise ValueError("monthly_training_contract_missing")

    def canonical(value: Any) -> Any:
        if isinstance(value, dict):
            return {str(key): canonical(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [canonical(item) for item in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return str(value)

    def checksum(value: dict[str, Any]) -> str:
        raw = json.dumps(
            canonical(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    unsigned_contract = {key: value for key, value in contract.items() if key != "contract_checksum"}
    if contract.get("schema_version") != "active8-monthly-training-contract-v2":
        raise ValueError("monthly_training_contract_schema_mismatch")
    if str(contract.get("contract_checksum") or "") != checksum(unsigned_contract):
        raise ValueError("monthly_training_contract_checksum_mismatch")
    model = str(model_name or "").strip()
    model_specs = contract.get("model_specs") if isinstance(contract.get("model_specs"), dict) else {}
    if model not in model_specs or model not in (contract.get("models") or []):
        raise ValueError(f"monthly_training_model_not_attested:{model}")
    config = canonical(dict(effective_config or {}))
    if not config:
        raise ValueError(f"monthly_training_effective_config_missing:{model}")
    if contract.get("model_profile_schema_version") != "active8-monthly-model-profiles-v1":
        raise ValueError("monthly_training_contract_profile_schema_mismatch")
    profile = dict((contract.get("model_profiles") or {}).get(model) or {})
    if not profile:
        raise ValueError(f"monthly_training_model_profile_missing:{model}")

    def require_subset(actual: Any, required: Any, path: str = "effective_config") -> None:
        if isinstance(required, dict):
            if not isinstance(actual, dict):
                raise ValueError(f"monthly_model_profile_type_mismatch:{path}")
            for key, required_value in required.items():
                if key not in actual:
                    raise ValueError(f"monthly_model_profile_field_missing:{path}.{key}")
                require_subset(actual[key], required_value, f"{path}.{key}")
            return
        if actual != required:
            raise ValueError(f"monthly_model_profile_value_mismatch:{path}:expected={required}:actual={actual}")

    require_subset(config, profile.get("required_effective_config") or {})
    attestation: dict[str, Any] = {
        "schema_version": "model-training-config-attestation-v2",
        "monthly_contract_checksum": contract["contract_checksum"],
        "model_name": model,
        "model_spec": model_specs[model],
        "model_profile_schema_version": contract["model_profile_schema_version"],
        "model_profile": profile,
        "model_profile_checksum": checksum(profile),
        "configuration_selection_mode": "single_predeclared_config",
        "selection_trials": 1,
        "pbo_applicability": "not_applicable_without_model_configuration_selection",
        "effective_config": config,
        "effective_config_checksum": checksum(config),
        "producer_source_sha": contract.get("producer_source_sha"),
        "run_date": contract.get("run_date"),
        "dataset_snapshot_id": contract.get("dataset_snapshot_id"),
    }
    attestation["attestation_checksum"] = checksum(attestation)
    return attestation


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
        if payload.get("artifact_lifecycle_only") is True:
            return []
        active_groups = set(TRAINING_GROUP_FEATURE_POLICIES)
        return [
            group
            for group in _coerce_str_list(payload.get("train_model_groups"), self.default_train_groups)
            if group in active_groups
        ]

    def sequence_min_length(self, payload: dict[str, Any] | None = None) -> int:
        payload = payload or {}
        return _coerce_int(payload.get("sequence_min_len"), self.sequence_min_len)

    def to_base_train_payload(
        self,
        payload: dict[str, Any] | None,
        *,
        candidate_version: str,
    ) -> dict[str, Any]:
        payload = payload or {}
        model_cpcv_policy = payload.get("model_cpcv_policy") or {"family_adapters": {}}
        candidate_type = str(payload.get("candidate_type") or "").strip()
        selection_params = payload.get("selection_params") if isinstance(payload.get("selection_params"), dict) else {}
        label_horizon_days = _coerce_int(
            payload.get("label_horizon_days") or selection_params.get("label_horizon_days"),
            5,
        )
        base_payload = {
            "batch_count": _coerce_int(payload.get("batch_count"), 5),
            "output_model_version": candidate_version,
            "register_challengers": False,
            "model_cpcv_policy": model_cpcv_policy,
            "label_horizon_days": label_horizon_days,
            "tree_model_split": _coerce_bool(payload.get("tree_model_split"), True),
        }
        if candidate_type:
            base_payload["candidate_type"] = candidate_type
        if candidate_type == "timesfm_l175_l2_feature_release":
            base_payload["skip_feature_pool"] = True
            base_payload["feature_release_mode"] = "timesfm_l175_l2_feature_release"
        for key in (
            "run_date",
            "as_of_date",
            "max_prep_stale_days",
            "gcs_prefix",
            "feature_pool_path",
            "dataset_snapshot",
            "generation_mode",
            "cohort_id",
            "monthly_training_contract",
        ):
            if payload.get(key) is not None:
                base_payload[key] = payload[key]
        if payload.get("disable_stale_prep_guard") is not None:
            base_payload["disable_stale_prep_guard"] = bool(payload.get("disable_stale_prep_guard"))
        return base_payload
