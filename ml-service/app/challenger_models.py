"""R_PLAN §7 challenger identities (E2 cumulative re-test; never part of the 7-model roster).

Challengers write fold OOF and full-fit artifacts in the same formats as the
primary models, but they are not in ``alpha_model_roster`` and must not count
toward release completion or the ensemble stacker until Wei approves adding them.
"""
from __future__ import annotations

from typing import Any

from .formal_feature_contract import FEATURES131

CHALLENGER_SCHEMA_VERSION = "r33-s7-challengers-v1"
CHALLENGERS: dict[str, dict[str, Any]] = {
    "LinearNeutral": {
        "modal_function": "train_linear_neutral_universal",
        "payload_config": {"model_name": "LinearNeutral", "neutralization_exposures": "industry_log_mktcap", "validation_folds": 8},
        "requires_industry_sidecar": True,
        "artifact_folder": "linearneutral",
        "artifact_format": "joblib",
        "family": "linear_neutralized_tabular",
        "compares_against": None,
        "feature_policy": {
            "model": "LinearNeutral",
            "family": "linear_neutralized_tabular",
            "feature_policy_type": "formal131_full_tabular_exposure_neutralized",
            "feature_source": "prep.full_formal131",
            "selection_owner": "none_full_contract",
            "selection_required": False,
            "uses_missingness_mask": False,
            "requires_schema_parity": True,
            "mergeable_oos": True,
            "allowed_selection_methods": ["governed_full_feature_contract"],
            "note": "formal131 ranks residualized per (date, market) on PIT exposures; ridge alpha from inner purged CV.",
        },
    },
    "LinearNeutralSize": {
        "modal_function": "train_linear_neutral_universal",
        "payload_config": {"model_name": "LinearNeutralSize", "neutralization_exposures": "log_mktcap", "validation_folds": 8},
        "requires_industry_sidecar": False,
        "artifact_folder": "linearneutralsize",
        "artifact_format": "joblib",
        "family": "linear_neutralized_tabular",
        "compares_against": None,
        "feature_policy": {
            "model": "LinearNeutralSize",
            "family": "linear_neutralized_tabular",
            "feature_policy_type": "formal131_full_tabular_exposure_neutralized",
            "feature_source": "prep.full_formal131",
            "selection_owner": "none_full_contract",
            "selection_required": False,
            "uses_missingness_mask": False,
            "requires_schema_parity": True,
            "mergeable_oos": True,
            "allowed_selection_methods": ["governed_full_feature_contract"],
            "note": "Size-only arm: formal131 ranks residualized per (date, market) on PIT log market cap; fully PIT from 2023.",
        },
    },
    "GNNIndustry": {
        "modal_function": "train_gnn_industry_universal",
        "payload_config": {"graph_variant": "industry"},
        "requires_industry_sidecar": True,
        "artifact_folder": "gnn_industry",
        "artifact_format": "torch",
        "family": "cross_stock_graph",
        "compares_against": "GNN",
        "feature_policy": {
            "model": "GNNIndustry",
            "family": "cross_stock_graph",
            "feature_policy_type": "graph_artifact_required",
            "feature_source": "graph_feature_contract",
            "selection_owner": "none_full_contract",
            "selection_required": False,
            "uses_missingness_mask": False,
            "requires_schema_parity": True,
            "mergeable_oos": True,
            "allowed_selection_methods": ["graph_spec"],
            "note": "Same GraphSAGE as GNN; edges are the PIT same-industry clique of each signal date.",
        },
    },
    "GNNIndustryCosine": {
        "modal_function": "train_gnn_industry_universal",
        "payload_config": {"graph_variant": "industry_plus_cosine"},
        "requires_industry_sidecar": True,
        "artifact_folder": "gnn_industry_cosine",
        "artifact_format": "torch",
        "family": "cross_stock_graph",
        "compares_against": "GNN",
        "feature_policy": {
            "model": "GNNIndustryCosine",
            "family": "cross_stock_graph",
            "feature_policy_type": "graph_artifact_required",
            "feature_source": "graph_feature_contract",
            "selection_owner": "none_full_contract",
            "selection_required": False,
            "uses_missingness_mask": False,
            "requires_schema_parity": True,
            "mergeable_oos": True,
            "allowed_selection_methods": ["graph_spec"],
            "note": "Comparison arm: PIT same-industry clique unioned with the incumbent feature-cosine edges.",
        },
    },
}


# What the R33 lifecycle schedules (Wei 2026-10-25, option C). One linear slot whose exposure set the
# trainer resolves per fold: LinearNeutralSize until PIT industry snapshots cover the fit window, then
# LinearNeutral. The GNN industry arms wait for PIT industry coverage.
LIFECYCLE_SLOTS: dict[str, dict[str, Any]] = {
    "linear_neutral": {
        "modal_function": "train_linear_neutral_universal",
        "payload_config": {"neutralization_exposures": "auto", "validation_folds": 8},
        "industry_exposure": "optional",
        "produces": ("LinearNeutralSize", "LinearNeutral"),
    },
}
DEFERRED_CHALLENGERS = {
    "GNNIndustry": "pit_industry_snapshots_do_not_cover_training_window",
    "GNNIndustryCosine": "pit_industry_snapshots_do_not_cover_training_window",
}


def is_challenger(model_name: str) -> bool:
    return str(model_name or "") in CHALLENGERS


def challenger_feature_policy_metadata(model_name: str, feature_names, *, feature_release_mode=None) -> dict[str, Any]:
    spec = CHALLENGERS[str(model_name)]
    if feature_release_mode == "approved_full131_v1" and list(feature_names) != list(FEATURES131):
        raise ValueError("approved_full131_feature_inventory_mismatch")
    return {
        "feature_policy": dict(spec["feature_policy"]),
        "feature_policy_schema_version": "model-feature-policy-v2",
        "family_feature_contract": {
            "schema_version": CHALLENGER_SCHEMA_VERSION,
            "model": model_name,
            "family_schema": "formal131_full_tabular_v1",
            "input_semantics": (
                "graph_node_features_from_governed_tabular_universe"
                if spec["family"] == "cross_stock_graph" else "full_governed_tabular_universe"
            ),
            "release_id": feature_release_mode or "formal131_challenger",
            "release_cohort": [model_name],
            "atomic_cohort_required": False,
            "timesfm_l175_sidecar_required": False,
        },
        "feature_count": int(len(feature_names)),
        "selection_evidence": {"selection_method": "governed_full_feature_contract"},
        "challenger": {
            "schema_version": CHALLENGER_SCHEMA_VERSION,
            "roster_member": False,
            "adoption_rule": "E2_cumulative_retest_wei_approval_required",
            "compares_against": spec["compares_against"],
        },
    }
