from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.lifecycle_promotion_gate import apply_promotion_gate_to_actions


def test_apply_promotion_gate_blocks_promote_actions_when_gate_fails():
    actions = [
        {
            "model": "XGBoost",
            "transition": "promote",
            "reason": "All promote preconditions satisfied",
        },
        {
            "model": "LightGBM",
            "transition": "demote",
            "reason": "IC decay",
        },
    ]
    gate = {
        "passed": False,
        "decision": "FAIL",
        "failed_gates": ["pbo_probability", "monte_carlo_mdd_95th"],
        "warnings": ["pbo_source_not_backtest"],
    }

    out = apply_promotion_gate_to_actions(actions, gate)

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["promotion_gate_decision"] == "FAIL"
    assert out[0]["promotion_gate_failed_gates"] == ["pbo_probability", "monte_carlo_mdd_95th"]
    assert out[1]["transition"] == "demote"


def test_apply_promotion_gate_leaves_promote_actions_when_gate_passes():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}

    out = apply_promotion_gate_to_actions(actions, gate)

    assert out[0]["transition"] == "promote"
    assert out == actions


def test_apply_promotion_gate_can_be_disabled_for_dry_legacy_audit():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": False, "decision": "FAIL", "failed_gates": ["missing_backtest_results"]}

    out = apply_promotion_gate_to_actions(actions, gate, require_gate=False)

    assert out == actions


def test_apply_promotion_gate_blocks_promote_without_model_shadow_ab_evidence():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model={},
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["shadow_ab_decision"] == "FAIL"
    assert "missing_shadow_ab:XGBoost" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_blocks_promote_when_challenger_does_not_beat_active():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    shadow_ab = {
        "XGBoost": {
            "samples": 80,
            "accuracy_lift": -0.01,
            "return_lift": 0.004,
            "decision": "FAIL",
            "failed_gates": ["shadow_accuracy_lift"],
        }
    }

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model=shadow_ab,
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["shadow_ab_decision"] == "FAIL"
    assert "shadow_ab:shadow_accuracy_lift" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_allows_promote_when_shadow_ab_passes():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    shadow_ab = {
        "XGBoost": {
            "samples": 80,
            "accuracy_lift": 0.03,
            "return_lift": 0.004,
            "decision": "PASS",
            "failed_gates": [],
        }
    }

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model=shadow_ab,
    )

    assert out == actions


def test_apply_promotion_gate_blocks_promote_without_paper_order_ab_evidence():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    shadow_ab = {"XGBoost": {"decision": "PASS", "failed_gates": []}}

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model=shadow_ab,
        require_paper_order_ab=True,
        paper_order_ab_by_model={},
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["paper_order_ab_decision"] == "FAIL"
    assert "missing_paper_order_ab:XGBoost" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_blocks_promote_when_paper_order_ab_fails():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    shadow_ab = {"XGBoost": {"decision": "PASS", "failed_gates": []}}
    paper_ab = {
        "XGBoost": {
            "decision": "FAIL",
            "failed_gates": ["paper_order_ic_lift"],
            "orders": 30,
        }
    }

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model=shadow_ab,
        require_paper_order_ab=True,
        paper_order_ab_by_model=paper_ab,
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["paper_order_ab_decision"] == "FAIL"
    assert "paper_order_ab:paper_order_ic_lift" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_allows_promote_when_shadow_and_paper_order_ab_pass():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    shadow_ab = {"XGBoost": {"decision": "PASS", "failed_gates": []}}
    paper_ab = {"XGBoost": {"decision": "PASS", "failed_gates": [], "orders": 30}}

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_shadow_ab=True,
        shadow_ab_by_model=shadow_ab,
        require_paper_order_ab=True,
        paper_order_ab_by_model=paper_ab,
    )

    assert out == actions


def test_apply_promotion_gate_blocks_promote_without_model_cpcv_evidence():
    actions = [{"model": "XGBoost", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_model_cpcv=True,
        model_cpcv_by_model={},
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["model_cpcv_decision"] == "FAIL"
    assert "missing_model_cpcv:XGBoost" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_blocks_promote_when_model_cpcv_fails():
    actions = [{"model": "TabM", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    cpcv = {
        "TabM": {
            "decision": "FAIL",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": ["cpcv_oos_ic"],
            "folds": 6,
        }
    }

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_model_cpcv=True,
        model_cpcv_by_model=cpcv,
    )

    assert out[0]["transition"] == "promote_blocked"
    assert out[0]["model_cpcv_decision"] == "FAIL"
    assert "model_cpcv:cpcv_oos_ic" in out[0]["preconditions_failed"]


def test_apply_promotion_gate_allows_promote_when_model_cpcv_passes():
    actions = [{"model": "LightGBM", "transition": "promote"}]
    gate = {"passed": True, "decision": "PASS", "failed_gates": []}
    cpcv = {
        "LightGBM": {
            "decision": "PASS",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": [],
            "folds": 8,
            "oos_ic_mean": 0.04,
        }
    }

    out = apply_promotion_gate_to_actions(
        actions,
        gate,
        require_model_cpcv=True,
        model_cpcv_by_model=cpcv,
    )

    assert out[0]["transition"] == "promote"
    assert out[0]["model_cpcv_decision"] == "PASS"
    assert out[0]["model_cpcv_folds"] == 8
