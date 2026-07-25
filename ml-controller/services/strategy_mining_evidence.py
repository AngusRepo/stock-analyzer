from __future__ import annotations

import math
from typing import Any

from services.monte_carlo_service import _run_monte_carlo
from services.pbo_service import _run_cscv_rank_logit_pbo


def _compound(values: list[float]) -> float:
    equity = 1.0
    for value in values:
        equity *= 1.0 + float(value)
    return equity - 1.0


def _finite_list(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    out: list[float] = []
    for item in value:
        try:
            parsed = float(item)
        except (TypeError, ValueError):
            return []
        if not math.isfinite(parsed):
            return []
        out.append(parsed)
    return out


def _walk_forward(matrix: dict[str, list[float]]) -> dict[str, Any]:
    if len(matrix) < 2:
        return {
            "status": "pending",
            "method": "purged_expanding_candidate_selection",
            "reason": "insufficient_candidates",
            "windows": 0,
        }
    n_partitions = len(next(iter(matrix.values())))
    if n_partitions < 4 or any(len(values) != n_partitions for values in matrix.values()):
        return {
            "status": "pending",
            "method": "purged_expanding_candidate_selection",
            "reason": "insufficient_or_misaligned_partitions",
            "windows": 0,
        }

    observations: list[dict[str, Any]] = []
    for test_index in range(2, n_partitions):
        selected = max(
            matrix,
            key=lambda name: _compound(matrix[name][:test_index]),
        )
        observations.append({
            "test_partition": test_index,
            "selected_candidate": selected,
            "oos_return": matrix[selected][test_index],
        })
    returns = [float(row["oos_return"]) for row in observations]
    mean_return = sum(returns) / len(returns)
    positive_ratio = sum(1 for value in returns if value > 0.0) / len(returns)
    status = "pass" if mean_return > 0.0 and positive_ratio >= 0.5 else "failed"
    return {
        "status": status,
        "method": "purged_expanding_candidate_selection",
        "windows": len(observations),
        "oos_mean_return": round(mean_return, 8),
        "positive_window_ratio": round(positive_ratio, 6),
        "observations": observations,
    }


def build_strategy_mining_evidence(
    rows: list[dict[str, Any]],
    *,
    n_partitions: int,
    n_simulations: int = 1000,
) -> dict[str, Any]:
    """Build common-universe research evidence without manufacturing missing gates."""

    usable: dict[str, dict[str, Any]] = {}
    rejected: dict[str, str] = {}
    for row in rows:
        candidate_id = str(row.get("candidate_id") or "").strip()
        if not candidate_id or row.get("status") != "ok":
            continue
        partitions = _finite_list(row.get("holdout_partition_returns"))
        daily_returns = _finite_list(row.get("holdout_daily_returns"))
        regimes = row.get("holdout_regimes")
        if len(partitions) != int(n_partitions):
            rejected[candidate_id] = "partition_return_contract_unmet"
            continue
        if len(daily_returns) < 5:
            rejected[candidate_id] = "holdout_daily_returns_insufficient"
            continue
        if not isinstance(regimes, list) or len(regimes) != len(daily_returns):
            rejected[candidate_id] = "holdout_regime_alignment_unmet"
            continue
        usable[candidate_id] = {
            "partitions": partitions,
            "daily_returns": daily_returns,
            "regimes": [str(value or "unknown") for value in regimes],
        }

    matrix = {candidate_id: item["partitions"] for candidate_id, item in usable.items()}
    if len(matrix) < 2 or int(n_partitions) < 4:
        return {
            "schema_version": "strategy-mining-research-evidence-v2",
            "status": "pending",
            "reason": "common_candidate_return_matrix_insufficient",
            "common_candidate_matrix": {
                "candidate_count": len(matrix),
                "partition_count": int(n_partitions),
                "candidate_ids": sorted(matrix),
                "rejected": rejected,
            },
            "pbo": {"status": "pending", "reason": "matrix_insufficient"},
            "walk_forward": _walk_forward(matrix),
            "candidate_evidence": {},
        }

    pbo_result = _run_cscv_rank_logit_pbo(matrix)
    pbo_status = "pass" if pbo_result.go_live_verdict == "PASS" else "failed"
    pbo = {
        "status": pbo_status,
        "method": pbo_result.method,
        "pbo": pbo_result.pbo,
        "oos_mean_return": pbo_result.oos_mean_return,
        "n_partitions": pbo_result.n_partitions,
        "n_combinations": pbo_result.n_combinations,
        "selected_strategy_counts": pbo_result.selected_strategy_counts,
        "verdict": pbo_result.go_live_verdict,
        "reason": pbo_result.verdict_reason,
    }
    walk_forward = _walk_forward(matrix)
    candidate_evidence: dict[str, dict[str, Any]] = {}
    for candidate_id, item in usable.items():
        mc = _run_monte_carlo(
            item["daily_returns"],
            n_simulations=n_simulations,
            method="regime_block_bootstrap",
            trade_regimes=item["regimes"],
        )
        partitions = item["partitions"]
        candidate_mean = sum(partitions) / len(partitions)
        candidate_positive_ratio = sum(1 for value in partitions if value > 0.0) / len(partitions)
        failed_gates: list[str] = []
        if pbo_status != "pass":
            failed_gates.append("common_cscv_rank_logit_pbo")
        if walk_forward.get("status") != "pass":
            failed_gates.append("purged_walk_forward")
        if candidate_mean <= 0.0 or candidate_positive_ratio < 0.5:
            failed_gates.append("candidate_holdout_partition_return")
        if mc.go_live_verdict != "PASS":
            failed_gates.append("regime_block_bootstrap_monte_carlo")
        candidate_evidence[candidate_id] = {
            "status": "failed" if failed_gates else "pass",
            "failed_gates": failed_gates,
            "holdout_partition_mean_return": round(candidate_mean, 8),
            "holdout_positive_partition_ratio": round(candidate_positive_ratio, 6),
            "monte_carlo": {
                "status": "pass" if mc.go_live_verdict == "PASS" else "failed",
                "method": mc.simulation_method,
                "n_simulations": mc.n_simulations,
                "n_observations": mc.n_trades,
                "block_size": mc.block_size,
                "regime_counts": mc.regime_counts,
                "mdd_95th": mc.mdd_95th,
                "verdict": mc.go_live_verdict,
                "reason": mc.verdict_reason,
            },
        }

    overall_status = (
        "pass"
        if pbo_status == "pass"
        and walk_forward.get("status") == "pass"
        and any(item.get("status") == "pass" for item in candidate_evidence.values())
        else "failed"
    )
    return {
        "schema_version": "strategy-mining-research-evidence-v2",
        "status": overall_status,
        "common_candidate_matrix": {
            "candidate_count": len(matrix),
            "partition_count": int(n_partitions),
            "candidate_ids": sorted(matrix),
            "rejected": rejected,
        },
        "pbo": pbo,
        "walk_forward": walk_forward,
        "candidate_evidence": candidate_evidence,
    }
