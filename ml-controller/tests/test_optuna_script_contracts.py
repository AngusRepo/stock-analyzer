from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.optuna_script_contracts import (  # noqa: E402
    OPTUNA_SCRIPT_CONTRACTS,
    get_optuna_script_contract,
)


def test_optuna_script_contracts_cover_active_scripts():
    expected = {
        "alpha_framework",
        "barrier",
        "conformal",
        "feature_window",
        "ga_optimizer",
        "l2_sensitivity",
        "per_regime_robust",
        "risk_params",
        "rrg",
        "screener",
        "signal",
        "sltp",
    }

    assert set(OPTUNA_SCRIPT_CONTRACTS) == expected
    assert "adaptive_l2" not in OPTUNA_SCRIPT_CONTRACTS
    assert "ft_arch" not in OPTUNA_SCRIPT_CONTRACTS
    assert all(contract.script != "optuna_adaptive_l2.py" for contract in OPTUNA_SCRIPT_CONTRACTS.values())
    assert all(contract.script != "modal_ft_arch_search" for contract in OPTUNA_SCRIPT_CONTRACTS.values())


def test_optuna_script_contract_classifies_production_bound_ranges():
    contract = get_optuna_script_contract("signal")

    assert contract.production_effect == "production_bound"
    assert contract.range_role == "production_bound_seeded_range"
    assert contract.push_target == "worker_kv_live"


def test_optuna_script_contract_classifies_kv_primary_bootstrap_ranges():
    contract = get_optuna_script_contract("l2_sensitivity")

    assert contract.production_effect == "production_bound"
    assert contract.range_role == "kv_primary_bootstrap_fallback"
    assert contract.requires_external_gate is True
    assert any("walk-forward evidence PASS" in note for note in contract.notes)


def test_optuna_script_contract_classifies_non_live_research_and_sandbox():
    assert get_optuna_script_contract("alpha_framework").production_effect == "sandbox_challenger"
    ga = get_optuna_script_contract("ga_optimizer")
    assert ga.production_effect == "meta_optimizer_learning"
    assert ga.push_target == "worker_kv_ga_optimizer_state"
    assert get_optuna_script_contract("per_regime_robust").production_effect == "sandbox_challenger"
