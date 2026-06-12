"""Contracts for active Optuna scripts and their search-space defaults."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class OptunaScriptContract:
    source: str
    script: str
    production_effect: str
    range_role: str
    push_target: str
    requires_external_gate: bool
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        data = asdict(self)
        data["notes"] = list(self.notes)
        return data


OPTUNA_SCRIPT_CONTRACTS: dict[str, OptunaScriptContract] = {
    "alpha_framework": OptunaScriptContract(
        source="alpha_framework",
        script="services.alpha_policy_search",
        production_effect="sandbox_challenger",
        range_role="historical_alpha_outcome_posterior",
        push_target="worker_kv_sandbox_by_default",
        requires_external_gate=True,
        notes=("Uses verified prediction outcomes with alpha_context; skips safely when sample size is insufficient.",),
    ),
    "barrier": OptunaScriptContract(
        source="barrier",
        script="optuna_barrier.py",
        production_effect="production_bound",
        range_role="production_bound_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=False,
    ),
    "conformal": OptunaScriptContract(
        source="conformal",
        script="optuna_conformal.py",
        production_effect="production_bound",
        range_role="production_bound_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=False,
    ),
    "feature_window": OptunaScriptContract(
        source="feature_window",
        script="optuna_feature_window.py",
        production_effect="deferred_worker_handler",
        range_role="research_bootstrap_seeded_range",
        push_target="worker_deferred",
        requires_external_gate=True,
    ),
    "ga_optimizer": OptunaScriptContract(
        source="ga_optimizer",
        script="services.ga_optimizer_service",
        production_effect="meta_optimizer_learning",
        range_role="genetic_meta_optimizer_direct_learning",
        push_target="worker_kv_ga_optimizer_state",
        requires_external_gate=False,
        notes=("Learns optimizer state directly; applying learned params to trading config still requires a separate gate.",),
    ),
    "l2_sensitivity": OptunaScriptContract(
        source="l2_sensitivity",
        script="optuna_l2_sensitivity.py",
        production_effect="production_bound",
        range_role="kv_primary_bootstrap_fallback",
        push_target="worker_kv_live",
        requires_external_gate=True,
        notes=(
            "Production caller should prefer trading:config.optuna_l2.search_space over DEFAULT_SEARCH_SPACE.",
            "KV push requires Mode B replay, CSCV rank-logit PBO PASS, and attached walk-forward evidence PASS.",
        ),
    ),
    "per_regime_robust": OptunaScriptContract(
        source="per_regime_robust",
        script="optuna_per_regime_robust.py",
        production_effect="sandbox_challenger",
        range_role="sandbox_challenger_seeded_range",
        push_target="sandbox_or_challenger_only",
        requires_external_gate=True,
    ),
    "risk_params": OptunaScriptContract(
        source="risk_params",
        script="optuna_risk_params.py",
        production_effect="production_bound",
        range_role="production_bound_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=False,
    ),
    "rrg": OptunaScriptContract(
        source="rrg",
        script="optuna_rrg.py",
        production_effect="production_bound",
        range_role="production_bound_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=False,
    ),
    "screener": OptunaScriptContract(
        source="screener",
        script="optuna_screener.py",
        production_effect="production_partial",
        range_role="kv_baseline_plus_production_seeded_range",
        push_target="worker_kv_live_partial",
        requires_external_gate=True,
        notes=("ranking.* may be searched internally but is excluded from live push.",),
    ),
    "signal": OptunaScriptContract(
        source="signal",
        script="optuna_signal.py",
        production_effect="production_bound",
        range_role="production_bound_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=False,
    ),
    "sltp": OptunaScriptContract(
        source="sltp",
        script="optuna_sltp.py",
        production_effect="production_bound",
        range_role="kv_baseline_plus_production_seeded_range",
        push_target="worker_kv_live",
        requires_external_gate=True,
    ),
}


def get_optuna_script_contract(source: str) -> OptunaScriptContract:
    try:
        return OPTUNA_SCRIPT_CONTRACTS[source]
    except KeyError as exc:
        raise KeyError(f"Unknown Optuna script source: {source}") from exc
