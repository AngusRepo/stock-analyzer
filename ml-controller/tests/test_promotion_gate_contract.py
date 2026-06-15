from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.promotion_gate_contract import (  # noqa: E402
    PROMOTION_GATE_SCHEMA_VERSION,
    build_v4_promotion_packet,
    validate_similarity_evidence_promotion,
    validate_v4_promotion_packet,
)


def _base_candidate(**overrides) -> dict:
    candidate = {
        "candidate_id": "finlab-revenue-momentum",
        "lane": "P1",
        "candidate_type": "finlab_feature",
        "requested_runtime": "feature_lake_shadow",
    }
    candidate.update(overrides)
    return candidate


def _cleaning_evidence(**overrides) -> dict:
    evidence = {
        "source_lineage": True,
        "schema_freshness": True,
        "no_lookahead": True,
        "ic": False,
        "hit_rate": False,
        "transaction_cost": False,
        "turnover": False,
        "drawdown": False,
        "mae_mfe": False,
        "regime_split": False,
        "decision_engine_review": False,
    }
    evidence.update(overrides)
    return evidence


def _promotion_evidence(**overrides) -> dict:
    evidence = _cleaning_evidence(
        ic=True,
        hit_rate=True,
        transaction_cost=True,
        turnover=True,
        drawdown=True,
        mae_mfe=True,
        regime_split=True,
        decision_engine_review=True,
    )
    evidence.update(overrides)
    return evidence


def _paper_active_evidence(**overrides) -> dict:
    evidence = _promotion_evidence(
        backtest_reality=True,
        walk_forward=True,
        liquidity=True,
        paper_attribution=True,
    )
    evidence.update(overrides)
    return evidence


def test_p0_candidate_can_land_only_as_clean_asset_without_decision_authority():
    packet = build_v4_promotion_packet(
        _base_candidate(
            candidate_id="finlab-security-master",
            lane="P0",
            candidate_type="security_master",
            requested_runtime="clean_asset",
        ),
        _cleaning_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["schema_version"] == PROMOTION_GATE_SCHEMA_VERSION
    assert packet["decision"] == "ACCEPT_CLEAN_ASSET"
    assert packet["allowed_runtime"] == "clean_asset"
    assert packet["permissions"]["can_write_clean_asset"] is True
    assert packet["permissions"]["can_write_106_feature"] is False
    assert packet["permissions"]["can_write_ml_vote"] is False
    assert packet["permissions"]["can_write_regime"] is False
    assert packet["permissions"]["can_write_order"] is False
    assert packet["promotion_ready"] is False
    assert validate_v4_promotion_packet(packet) == []


def test_p1_candidate_can_enter_paper_active_without_order_authority():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="paper_active_challenger"),
        _paper_active_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "ALLOW_PAPER_ACTIVE_CHALLENGER"
    assert packet["allowed_runtime"] == "paper_active_challenger"
    assert packet["production_effect"] == "paper_decision_only"
    assert packet["paper_active_ready"] is True
    assert packet["promotion_ready"] is False
    assert packet["permissions"]["can_write_feature_lake"] is True
    assert packet["permissions"]["can_influence_paper_decision"] is True
    assert packet["permissions"]["can_write_paper_attribution"] is True
    assert packet["permissions"]["can_write_order"] is False
    assert validate_v4_promotion_packet(packet) == []


def test_paper_active_request_falls_back_to_shadow_when_reality_gates_fail():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="paper_active_challenger"),
        _paper_active_evidence(backtest_reality=False, liquidity=False, paper_attribution=False),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert packet["allowed_runtime"] == "feature_lake_shadow"
    assert packet["permissions"]["can_write_feature_lake"] is True
    assert packet["permissions"]["can_influence_paper_decision"] is False
    assert packet["failed_gates"] == [
        "backtest_reality",
        "liquidity",
        "paper_attribution",
    ]
    assert validate_v4_promotion_packet(packet) == []


def test_paper_primary_requires_full_promotion_and_paper_order_ab_evidence():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="paper_primary"),
        _paper_active_evidence(paper_order_ab=True, paper_non_inferiority=True),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "ALLOW_PAPER_PRIMARY"
    assert packet["allowed_runtime"] == "paper_primary"
    assert packet["production_effect"] == "paper_primary_only"
    assert packet["paper_active_ready"] is True
    assert packet["promotion_ready"] is False
    assert packet["permissions"]["can_influence_paper_decision"] is True
    assert packet["permissions"]["can_write_order"] is False
    assert validate_v4_promotion_packet(packet) == []


def test_p1_shadow_candidate_blocks_production_until_all_promotion_evidence_passes():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="production_feature"),
        _promotion_evidence(hit_rate=False, regime_split=False, decision_engine_review=False),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert packet["allowed_runtime"] == "feature_lake_shadow"
    assert packet["promotion_ready"] is False
    assert packet["failed_gates"] == [
        "hit_rate",
        "regime_split",
        "decision_engine_review",
    ]
    assert packet["permissions"]["can_write_106_feature"] is False
    assert validate_v4_promotion_packet(packet) == []


def test_p1_candidate_with_full_evidence_enters_review_not_direct_production():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="production_feature"),
        _promotion_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "ALLOW_PROMOTION_REVIEW"
    assert packet["allowed_runtime"] == "promotion_review"
    assert packet["production_effect"] == "review_only"
    assert packet["promotion_ready"] is True
    assert packet["permissions"]["can_write_106_feature"] is False
    assert packet["permissions"]["can_write_ml_vote"] is False
    assert packet["permissions"]["can_write_order"] is False
    assert validate_v4_promotion_packet(packet) == []


def test_p2_and_reject_lanes_never_gain_runtime_authority():
    p2 = build_v4_promotion_packet(
        _base_candidate(lane="P2", requested_runtime="production_feature"),
        _promotion_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )
    rejected = build_v4_promotion_packet(
        _base_candidate(lane="Reject", requested_runtime="feature_lake_shadow"),
        _promotion_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )

    assert p2["decision"] == "RESEARCH_BENCHMARK_ONLY"
    assert p2["allowed_runtime"] == "offline_research"
    assert p2["promotion_ready"] is False
    assert rejected["decision"] == "REJECT"
    assert rejected["allowed_runtime"] == "blocked"
    assert rejected["permissions"]["can_write_clean_asset"] is False
    assert validate_v4_promotion_packet(p2) == []
    assert validate_v4_promotion_packet(rejected) == []


def test_validator_blocks_forged_runtime_authority():
    packet = build_v4_promotion_packet(
        _base_candidate(requested_runtime="production_feature"),
        _promotion_evidence(),
        generated_at="2026-05-17T00:00:00Z",
    )
    packet["permissions"]["can_write_order"] = True
    packet["production_effect"] = "direct_alpha"

    assert validate_v4_promotion_packet(packet) == [
        "direct_alpha_production_effect_not_allowed",
        "can_write_order_not_allowed",
    ]


def test_similarity_evidence_requires_v4_promotion_gates_before_review():
    evidence = _promotion_evidence(
        no_new_selector=True,
        no_hardcoded_cluster_count=True,
        no_topk_fallback=True,
        l15_pairwise_corr_not_worse=-0.08,
        l2_l3_quality_not_down=0.01,
        l4_cluster_concentration_down=-0.12,
        backtest_sharpe_bias_fixed=True,
        evening_chain_runtime_acceptable=True,
    )
    packet = build_v4_promotion_packet(
        _base_candidate(
            candidate_id="networkx-ledoitwolf-similarity-evidence",
            candidate_type="similarity_evidence",
            requested_runtime="production_feature",
        ),
        evidence,
        generated_at="2026-06-15T00:00:00Z",
    )

    assert packet["decision"] == "ALLOW_PROMOTION_REVIEW"
    assert packet["production_effect"] == "review_only"
    assert validate_similarity_evidence_promotion(evidence) == []
    assert validate_v4_promotion_packet(packet) == []


def test_similarity_evidence_blocks_selector_or_topk_regression():
    evidence = _promotion_evidence(
        no_new_selector=False,
        no_hardcoded_cluster_count=False,
        no_topk_fallback=False,
        l15_pairwise_corr_not_worse=0.03,
        l2_l3_quality_not_down=-0.02,
        l4_cluster_concentration_down=0.11,
        backtest_sharpe_bias_fixed=False,
        evening_chain_runtime_acceptable=True,
    )
    packet = build_v4_promotion_packet(
        _base_candidate(
            candidate_id="bad-clustering-selector",
            candidate_type="similarity_evidence",
            requested_runtime="production_feature",
        ),
        evidence,
        generated_at="2026-06-15T00:00:00Z",
    )

    assert packet["decision"] == "BLOCK"
    assert packet["allowed_runtime"] == "feature_lake_shadow"
    assert packet["failed_gates"] == [
        "no_new_selector",
        "no_hardcoded_cluster_count",
        "no_topk_fallback",
        "l15_pairwise_corr_not_worse",
        "l2_l3_quality_not_down",
        "l4_cluster_concentration_down",
        "backtest_sharpe_bias_fixed",
    ]
    assert validate_v4_promotion_packet(packet) == []
