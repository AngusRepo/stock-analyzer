"""Runtime hook for research-only model-family benchmarks.

This module is deliberately production-safe: it may train/evaluate research
adapters when they exist, but it never promotes, deploys, or writes production
artifacts.
"""

from __future__ import annotations

import importlib
import importlib.util
from typing import Any


BENCHMARK_ADAPTERS: dict[str, dict[str, str]] = {
    "DLinear": {
        "package": "torch",
        "module": "app.research_benchmarks.current_dlinear_adapter",
        "function": "run_benchmark",
    },
    "DartsDLinear": {
        "package": "darts",
        "module": "app.research_benchmarks.darts_dlinear_adapter",
        "function": "run_benchmark",
    },
    "PatchTST": {
        "package": "neuralforecast",
        "module": "app.research_benchmarks.neuralforecast_patchtst_adapter",
        "function": "run_benchmark",
    },
    "TabM": {
        "package": "tabm",
        "module": "app.research_benchmarks.tabm_adapter",
        "function": "run_benchmark",
    },
    "iTransformer": {
        "package": "neuralforecast",
        "module": "app.research_benchmarks.neuralforecast_itransformer_adapter",
        "function": "run_benchmark",
    },
    "TimesFM": {
        "package": "timesfm",
        "module": "app.research_benchmarks.timesfm_adapter",
        "function": "run_benchmark",
    },
    "TimesFM25": {
        "package": "timesfm",
        "module": "app.research_benchmarks.timesfm25_adapter",
        "function": "run_benchmark",
    },
}


def _package_available(package_name: str) -> bool:
    return importlib.util.find_spec(package_name) is not None


def run_research_model_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    candidate_id = str(payload.get("candidate_id") or "").strip()
    experiment_id = str(payload.get("experiment_id") or "").strip()
    spec = BENCHMARK_ADAPTERS.get(candidate_id)
    if not spec:
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
            "blockers": ["unknown_benchmark_candidate"],
            "supported_candidates": sorted(BENCHMARK_ADAPTERS),
        }

    # Test/replay hook: lets controller tests or offline research runs submit
    # real fold metrics without production mutations.
    if isinstance(payload.get("executor_result"), dict):
        result = dict(payload["executor_result"])
        result.setdefault("status", "available")
        result.setdefault("candidate_id", candidate_id)
        result.setdefault("experiment_id", experiment_id)
        return result

    blockers: list[str] = []
    if not _package_available(spec["package"]):
        blockers.append(f"missing_runtime_package:{spec['package']}")

    adapter_spec = importlib.util.find_spec(spec["module"])
    if adapter_spec is None:
        blockers.append(f"missing_benchmark_adapter:{spec['module']}")

    if blockers:
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
            "blockers": blockers,
            "required_package": spec["package"],
            "required_adapter": spec["module"],
            "expected_output": {
                "fold_metrics": "list[{fold_id,oos_ic,test_rows,coverage}]",
                "pbo": "float",
                "cost_sensitivity": "{latency_sec,estimated_modal_usd,gpu,status}",
                "data_slice_report": "{symbols,windows,start_date,end_date,market_lanes}",
            },
        }

    module = importlib.import_module(spec["module"])
    runner = getattr(module, spec["function"], None)
    if not callable(runner):
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
            "blockers": [f"missing_adapter_function:{spec['module']}.{spec['function']}"],
        }

    result = runner(payload)
    if not isinstance(result, dict):
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
            "blockers": ["adapter_returned_invalid_result"],
        }
    result.setdefault("candidate_id", candidate_id)
    result.setdefault("experiment_id", experiment_id)
    return result
