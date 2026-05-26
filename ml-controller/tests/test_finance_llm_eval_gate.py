import asyncio

from routers.research_benchmark import (
    FinanceLlmEvalGateRequest,
    research_finance_llm_eval_gate_dry_run,
)
from services.finance_llm_eval_gate import build_finance_llm_eval_gate


def _passing_eval():
    return {
        "task": "merger_arbitrage_news",
        "samples": 160,
        "temporal_split": {
            "train_end": "2026-03-31",
            "test_start": "2026-04-01",
            "purged": True,
        },
        "source_timestamp_coverage": 0.96,
        "label_lag_days": 1,
        "baseline": {"method": "keyword_rules", "accuracy": 0.56},
        "candidate": {
            "method": "finance_llm",
            "accuracy": 0.68,
            "calibration_error": 0.06,
        },
        "class_coverage": {"success": 70, "break": 35, "higher_bid": 18},
        "leakage_audit": {
            "future_source_count": 0,
            "as_of_date_violations": 0,
            "label_join_violations": 0,
        },
        "explanation_audit": {
            "method": "citation_trace",
            "citation_coverage": 0.92,
            "counterfactual_consistency": 0.76,
        },
    }


def test_finance_llm_eval_gate_requires_bias_and_leakage_evidence_before_fusion():
    report = build_finance_llm_eval_gate(_passing_eval(), min_accuracy_delta=0.08)

    assert report["schema_version"] == "finance-llm-eval-gate-v1"
    assert report["decision_effect"] == "llm_eval_gate_only"
    assert report["metrics"]["accuracy_delta"] == 0.12
    assert report["decision"]["eligible_for_research_fusion"] is True
    assert report["decision"]["production_mutation_allowed"] is False
    assert report["decision"]["xai_regulatory_sufficiency"] is False
    assert report["decision"]["allowed_explanation_use"] == "operator_context_not_regulatory_explanation"


def test_finance_llm_eval_gate_blocks_future_leakage_and_weak_explainability():
    evaluation = _passing_eval()
    evaluation["leakage_audit"] = {
        "future_source_count": 2,
        "as_of_date_violations": 1,
        "label_join_violations": 0,
    }
    evaluation["explanation_audit"] = {
        "method": "attention_heatmap",
        "citation_coverage": 0.20,
        "counterfactual_consistency": 0.30,
    }

    report = build_finance_llm_eval_gate(evaluation)

    assert report["status"] == "blocked"
    assert "future_leakage_detected" in report["blockers"]
    assert "explainability_audit_missing_or_weak" in report["blockers"]
    assert report["decision"]["eligible_for_research_fusion"] is False


def test_finance_llm_eval_gate_research_route_is_non_mutating():
    response = asyncio.run(research_finance_llm_eval_gate_dry_run(
        FinanceLlmEvalGateRequest(evaluation=_passing_eval())
    ))

    assert response["decision_effect"] == "llm_eval_gate_only"
    assert response["decision"]["production_mutation_allowed"] is False
