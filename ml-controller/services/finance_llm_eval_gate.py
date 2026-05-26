"""Research-only evaluation gate for finance LLM candidates.

LLM outputs can enrich research context only when temporal leakage, benchmark
bias, source traceability, calibration, and explanation audits are explicit.
Passing this gate never means regulatory-grade XAI.
"""

from __future__ import annotations

import math
from typing import Any


SCHEMA_VERSION = "finance-llm-eval-gate-v1"


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _temporal_split_pass(split: dict[str, Any]) -> bool:
    return (
        bool(split.get("purged"))
        and bool(_clean_text(split.get("train_end")))
        and bool(_clean_text(split.get("test_start")))
        and _clean_text(split.get("train_end")) < _clean_text(split.get("test_start"))
    )


def _leakage_count(audit: dict[str, Any]) -> int:
    return (
        _to_int(audit.get("future_source_count"))
        + _to_int(audit.get("as_of_date_violations"))
        + _to_int(audit.get("label_join_violations"))
    )


def _class_coverage_pass(raw: dict[str, Any], min_per_class: int) -> bool:
    if not raw:
        return False
    return all(_to_int(value) >= min_per_class for value in raw.values())


def build_finance_llm_eval_gate(
    evaluation: dict[str, Any],
    *,
    min_samples: int = 100,
    min_accuracy_delta: float = 0.05,
    max_calibration_error: float = 0.10,
    min_source_timestamp_coverage: float = 0.90,
    min_class_samples: int = 10,
    min_citation_coverage: float = 0.80,
    min_counterfactual_consistency: float = 0.60,
) -> dict[str, Any]:
    evaluation = evaluation if isinstance(evaluation, dict) else {}
    temporal_split = evaluation.get("temporal_split") if isinstance(evaluation.get("temporal_split"), dict) else {}
    baseline = evaluation.get("baseline") if isinstance(evaluation.get("baseline"), dict) else {}
    candidate = evaluation.get("candidate") if isinstance(evaluation.get("candidate"), dict) else {}
    leakage_audit = evaluation.get("leakage_audit") if isinstance(evaluation.get("leakage_audit"), dict) else {}
    explanation_audit = evaluation.get("explanation_audit") if isinstance(evaluation.get("explanation_audit"), dict) else {}
    class_coverage = evaluation.get("class_coverage") if isinstance(evaluation.get("class_coverage"), dict) else {}

    baseline_accuracy = _to_float(baseline.get("accuracy"))
    candidate_accuracy = _to_float(candidate.get("accuracy"))
    accuracy_delta = round(candidate_accuracy - baseline_accuracy, 8)
    calibration_error = _to_float(candidate.get("calibration_error"), 1.0)
    source_timestamp_coverage = _to_float(evaluation.get("source_timestamp_coverage"))
    citation_coverage = _to_float(explanation_audit.get("citation_coverage"))
    counterfactual_consistency = _to_float(explanation_audit.get("counterfactual_consistency"))

    blockers: list[str] = []
    if _to_int(evaluation.get("samples")) < min_samples:
        blockers.append("sample_size_too_small")
    if not _temporal_split_pass(temporal_split):
        blockers.append("temporal_split_missing_or_not_purged")
    if source_timestamp_coverage < min_source_timestamp_coverage:
        blockers.append("source_timestamp_coverage_low")
    if _to_int(evaluation.get("label_lag_days")) < 1:
        blockers.append("label_lag_missing")
    if accuracy_delta < min_accuracy_delta:
        blockers.append("baseline_delta_too_small")
    if calibration_error > max_calibration_error:
        blockers.append("calibration_error_too_high")
    if not _class_coverage_pass(class_coverage, min_class_samples):
        blockers.append("class_coverage_insufficient")
    if _leakage_count(leakage_audit) > 0:
        blockers.append("future_leakage_detected")
    if citation_coverage < min_citation_coverage or counterfactual_consistency < min_counterfactual_consistency:
        blockers.append("explainability_audit_missing_or_weak")

    eligible = not blockers
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ready_for_review" if eligible else "blocked",
        "decision_effect": "llm_eval_gate_only",
        "task": _clean_text(evaluation.get("task")) or "unknown",
        "blockers": blockers,
        "metrics": {
            "samples": _to_int(evaluation.get("samples")),
            "baseline_method": baseline.get("method"),
            "candidate_method": candidate.get("method"),
            "baseline_accuracy": baseline_accuracy,
            "candidate_accuracy": candidate_accuracy,
            "accuracy_delta": accuracy_delta,
            "calibration_error": calibration_error,
            "source_timestamp_coverage": source_timestamp_coverage,
            "leakage_violation_count": _leakage_count(leakage_audit),
            "citation_coverage": citation_coverage,
            "counterfactual_consistency": counterfactual_consistency,
        },
        "decision": {
            "eligible_for_research_fusion": eligible,
            "production_mutation_allowed": False,
            "direct_trade_signal_allowed": False,
            "xai_regulatory_sufficiency": False,
            "allowed_explanation_use": "operator_context_not_regulatory_explanation",
        },
    }
