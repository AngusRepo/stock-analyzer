"""Research model-family benchmark evidence contract.

This service intentionally does not invent benchmark numbers. A benchmark
candidate is reviewable only when an executor returns real fold metrics,
PBO/CPCV evidence, cost sensitivity, and data-slice coverage.
"""

from __future__ import annotations

import importlib.util
import math
from dataclasses import dataclass
from typing import Any

from services.model_cpcv_evidence import build_model_cpcv_evidence


MODEL_BENCHMARK_REPORT_SCHEMA_VERSION = "model-family-benchmark-report-v1"


@dataclass(frozen=True)
class BenchmarkCandidateSpec:
    candidate_id: str
    family: str
    runtime_package: str
    adapter_module: str
    expected_evidence: tuple[str, ...]
    notes: str


BENCHMARK_CANDIDATES: dict[str, BenchmarkCandidateSpec] = {
    "DLinear": BenchmarkCandidateSpec(
        candidate_id="DLinear",
        family="time_series_linear_current",
        runtime_package="torch",
        adapter_module="app.research_benchmarks.current_dlinear_adapter",
        expected_evidence=("oos_ic", "cpcv_pbo", "cost_sensitivity", "data_slice_report"),
        notes="Current StockVision in-repo DLinear baseline retained after maintained-library comparison lost.",
    ),
    "PatchTST": BenchmarkCandidateSpec(
        candidate_id="PatchTST",
        family="time_series_transformer_neuralforecast",
        runtime_package="neuralforecast",
        adapter_module="app.research_benchmarks.neuralforecast_patchtst_adapter",
        expected_evidence=("oos_ic", "cpcv_pbo", "cost_sensitivity", "data_slice_report"),
        notes="Production PatchTST slot now uses NeuralForecast PatchTST; legacy in-repo Torch adapter removed.",
    ),
    "TabM": BenchmarkCandidateSpec(
        candidate_id="TabM",
        family="tabular_deep_learning",
        runtime_package="tabm",
        adapter_module="app.research_benchmarks.tabm_adapter",
        expected_evidence=("oos_ic", "cpcv_pbo", "cost_sensitivity", "data_slice_report"),
        notes="Tabular neural benchmark; must compare against tree/FT on the same train/serve feature policy.",
    ),
    "iTransformer": BenchmarkCandidateSpec(
        candidate_id="iTransformer",
        family="time_series_transformer_neuralforecast",
        runtime_package="neuralforecast",
        adapter_module="app.research_benchmarks.neuralforecast_itransformer_adapter",
        expected_evidence=("oos_ic", "cpcv_pbo", "cost_sensitivity", "data_slice_report"),
        notes="Production iTransformer slot now uses NeuralForecast iTransformer; legacy simplified Torch adapter removed.",
    ),
    "TimesFM": BenchmarkCandidateSpec(
        candidate_id="TimesFM",
        family="foundation_time_series",
        runtime_package="timesfm",
        adapter_module="app.research_benchmarks.timesfm_adapter",
        expected_evidence=("oos_ic", "forecast_validation", "cost_sensitivity", "data_slice_report"),
        notes="Foundation time-series benchmark against the active sequence family; should not enter production without review.",
    ),
    "TimesFM25": BenchmarkCandidateSpec(
        candidate_id="TimesFM25",
        family="foundation_time_series_maintained_runtime",
        runtime_package="timesfm",
        adapter_module="app.research_benchmarks.timesfm25_adapter",
        expected_evidence=("oos_ic", "forecast_validation", "cost_sensitivity", "data_slice_report"),
        notes="TimesFM 2.5 migration benchmark; production cut requires new 2.5 config artifact and serving parity evidence.",
    ),
}


def _finite_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _package_available(package_name: str) -> bool:
    return importlib.util.find_spec(package_name) is not None


def _normalize_fold_metrics(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows: list[dict[str, Any]] = []
    for idx, row in enumerate(value):
        if not isinstance(row, dict):
            continue
        ic = _finite_float(row.get("oos_ic", row.get("rank_ic")))
        test_rows = row.get("test_rows", row.get("samples"))
        coverage = row.get("coverage", row.get("coverage_mean", 1.0 if test_rows else 0.0))
        if ic is None:
            continue
        rows.append(
            {
                "fold_id": row.get("fold_id", idx),
                "oos_ic": ic,
                "test_rows": int(test_rows or 0),
                "coverage": float(coverage or 0.0),
            }
        )
    return rows


def _normalize_cost_sensitivity(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {
            "status": value.get("status", "available"),
            "latency_sec": _finite_float(value.get("latency_sec")),
            "estimated_modal_usd": _finite_float(value.get("estimated_modal_usd")),
            "gpu": value.get("gpu"),
            "notes": value.get("notes"),
        }
    return {
        "status": "missing",
        "latency_sec": None,
        "estimated_modal_usd": None,
        "gpu": None,
        "notes": "executor did not return cost sensitivity",
    }


def build_model_family_benchmark_report(
    *,
    candidate_id: str,
    experiment_id: str,
    start_date: str | None,
    end_date: str | None,
    data_slice: dict[str, Any] | None = None,
    executor_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec = BENCHMARK_CANDIDATES.get(candidate_id)
    if spec is None:
        return {
            "schema_version": MODEL_BENCHMARK_REPORT_SCHEMA_VERSION,
            "status": "blocked",
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
            "blockers": ["unknown_benchmark_candidate"],
            "supported_candidates": sorted(BENCHMARK_CANDIDATES),
        }

    executor_result = executor_result or {}
    fold_metrics = _normalize_fold_metrics(executor_result.get("fold_metrics"))
    blockers: list[str] = []
    if not executor_result and not _package_available(spec.runtime_package):
        blockers.append(f"missing_runtime_package:{spec.runtime_package}")
    if not executor_result:
        blockers.append("missing_executor_result")
    if not fold_metrics:
        blockers.append("missing_oos_fold_metrics")
    if "pbo" not in executor_result and "cpcv_pbo" not in executor_result:
        blockers.append("missing_pbo_cpcv")

    cpcv = build_model_cpcv_evidence(
        model=candidate_id,
        fold_metrics=fold_metrics,
        policy={
            "min_folds": 3,
            "min_test_rows": 30,
            "min_oos_ic_mean": 0.0,
            "min_positive_fold_ratio": 0.55,
            "max_oos_ic_std": 0.25,
            "min_coverage": 0.50,
        },
    )
    pbo = _finite_float(executor_result.get("pbo", executor_result.get("cpcv_pbo")))
    cost_sensitivity = _normalize_cost_sensitivity(executor_result.get("cost_sensitivity"))
    data_slice_report = executor_result.get("data_slice_report")
    if not isinstance(data_slice_report, dict):
        data_slice_report = {
            "status": "missing",
            "requested": data_slice or {},
            "start_date": start_date,
            "end_date": end_date,
        }
        blockers.append("missing_data_slice_report")

    status = "ready_for_review" if not blockers and cpcv["passed"] else "blocked"
    return {
        "schema_version": MODEL_BENCHMARK_REPORT_SCHEMA_VERSION,
        "status": status,
        "candidate_id": candidate_id,
        "experiment_id": experiment_id,
        "family": spec.family,
        "runtime_package": spec.runtime_package,
        "adapter_module": spec.adapter_module,
        "expected_evidence": list(spec.expected_evidence),
        "notes": spec.notes,
        "start_date": start_date,
        "end_date": end_date,
        "blockers": blockers,
        "oos_ic_mean": cpcv["oos_ic_mean"],
        "oos_ic_std": cpcv["oos_ic_std"],
        "folds": cpcv["folds"],
        "coverage_mean": cpcv["coverage_mean"],
        "pbo": pbo,
        "cpcv_evidence": cpcv,
        "cost_sensitivity": cost_sensitivity,
        "data_slice_report": data_slice_report,
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    }
