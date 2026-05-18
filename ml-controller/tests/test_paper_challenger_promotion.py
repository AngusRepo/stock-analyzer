from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.paper_challenger_promotion import (  # noqa: E402
    PAPER_CHALLENGER_PROMOTION_SCHEMA_VERSION,
    build_paper_challenger_postmarket_report,
    build_paper_challenger_promotion_packet,
    build_paper_decision_attribution,
    validate_paper_challenger_promotion_packet,
)


def _baseline() -> dict:
    return {
        "precision_at_k": 0.42,
        "hit_rate": 0.50,
        "avg_return_pct": 2.4,
        "max_drawdown_pct": -8.0,
        "turnover_ratio": 3.0,
    }


def test_paper_challenger_promotes_to_paper_primary_when_quality_is_noninferior_and_adds_signal():
    packet = build_paper_challenger_promotion_packet(
        candidate_id="finlab-broker-concentration",
        current_state="paper_active_challenger",
        baseline_metrics=_baseline(),
        challenger_metrics={
            "paper_decision_count": 38,
            "precision_at_k": 0.48,
            "hit_rate": 0.54,
            "avg_return_pct": 3.1,
            "max_drawdown_pct": -7.6,
            "turnover_ratio": 3.2,
            "topk_overlap": 0.72,
            "regime_split_passed": True,
            "blind_spot_coverage": "emerging_broker_flow",
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["schema_version"] == PAPER_CHALLENGER_PROMOTION_SCHEMA_VERSION
    assert packet["decision"] == "PROMOTE_TO_PAPER_PRIMARY"
    assert packet["next_state"] == "paper_primary"
    assert packet["real_trading_effect"] == "none"
    assert packet["requires_wei_approval_for_real"] is True
    assert packet["permissions"]["can_influence_paper_decision"] is True
    assert packet["permissions"]["can_write_order"] is False
    assert packet["quality_gates"]["non_inferiority"]["passed"] is True
    assert packet["quality_gates"]["incremental_value"]["passed"] is True
    assert validate_paper_challenger_promotion_packet(packet) == []


def test_paper_challenger_stays_active_when_it_is_safe_but_not_incremental_yet():
    packet = build_paper_challenger_promotion_packet(
        candidate_id="finlab-theme-context",
        current_state="paper_active_challenger",
        baseline_metrics=_baseline(),
        challenger_metrics={
            "paper_decision_count": 35,
            "precision_at_k": 0.42,
            "hit_rate": 0.50,
            "avg_return_pct": 2.35,
            "max_drawdown_pct": -8.1,
            "turnover_ratio": 3.1,
            "topk_overlap": 0.75,
            "regime_split_passed": True,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "KEEP_PAPER_ACTIVE"
    assert packet["next_state"] == "paper_active_challenger"
    assert packet["quality_gates"]["non_inferiority"]["passed"] is True
    assert packet["quality_gates"]["incremental_value"]["passed"] is False
    assert validate_paper_challenger_promotion_packet(packet) == []


def test_paper_challenger_demotes_when_quality_regresses_even_if_runtime_is_faster():
    packet = build_paper_challenger_promotion_packet(
        candidate_id="bad-fast-signal",
        current_state="paper_active_challenger",
        baseline_metrics=_baseline(),
        challenger_metrics={
            "paper_decision_count": 40,
            "precision_at_k": 0.33,
            "hit_rate": 0.42,
            "avg_return_pct": 1.1,
            "max_drawdown_pct": -12.0,
            "turnover_ratio": 6.8,
            "topk_overlap": 0.44,
            "regime_split_passed": False,
            "runtime_speedup_pct": 55.0,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert packet["decision"] == "DEMOTE_TO_CLEAN_ASSET"
    assert packet["next_state"] == "clean_asset"
    assert "non_inferiority" in packet["failed_gates"]
    assert packet["quality_gates"]["runtime_efficiency"]["passed"] is True
    assert packet["permissions"]["can_influence_paper_decision"] is False
    assert validate_paper_challenger_promotion_packet(packet) == []


def test_paper_decision_attribution_records_baseline_challenger_delta_without_writing_orders():
    attribution = build_paper_decision_attribution(
        symbol="2330",
        trade_date="2026-05-17",
        decision="candidate",
        baseline_score=0.61,
        challenger_score=0.74,
        challenger_id="finlab-broker-concentration",
        feature_set_version="finlab-v4.1",
        regime_version="market-regime-state-v4",
        evidence_sources=["finlab.rotc_broker_transactions", "finlab.security_categories"],
    )

    assert attribution["decision_delta"] == 0.13
    assert attribution["can_write_order"] is False
    assert attribution["paper_lane"] == "paper_active_challenger"
    assert attribution["audit_table"] == "paper_decision_attribution"


def test_postmarket_report_builds_promotion_packets_and_audit_events_for_candidates():
    report = build_paper_challenger_postmarket_report(
        candidates=[
            {
                "candidate_id": "finlab-broker-concentration",
                "candidate_type": "finlab_feature",
                "current_state": "paper_active_challenger",
            },
            {
                "candidate_id": "weak-fast-signal",
                "candidate_type": "external_event",
                "current_state": "paper_active_challenger",
            },
        ],
        baseline_metrics_by_candidate={
            "finlab-broker-concentration": _baseline(),
            "weak-fast-signal": _baseline(),
        },
        challenger_metrics_by_candidate={
            "finlab-broker-concentration": {
                "paper_decision_count": 40,
                "precision_at_k": 0.49,
                "hit_rate": 0.55,
                "avg_return_pct": 3.2,
                "max_drawdown_pct": -7.4,
                "turnover_ratio": 3.1,
                "topk_overlap": 0.76,
                "regime_split_passed": True,
            },
            "weak-fast-signal": {
                "paper_decision_count": 35,
                "precision_at_k": 0.35,
                "hit_rate": 0.44,
                "avg_return_pct": 1.2,
                "max_drawdown_pct": -11.0,
                "turnover_ratio": 6.0,
                "topk_overlap": 0.50,
                "regime_split_passed": False,
            },
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert report["schema_version"] == "paper-challenger-postmarket-report-v1"
    assert report["summary"]["PROMOTE_TO_PAPER_PRIMARY"] == 1
    assert report["summary"]["DEMOTE_TO_CLEAN_ASSET"] == 1
    assert len(report["promotion_packets"]) == 2
    assert len(report["audit_events"]) == 2
    assert report["audit_events"][0]["to_state"] == "paper_primary"
    assert report["audit_events"][0]["real_trading_effect"] == "none"
