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


def _newey_west_positive_mean_p_value(values: list[float]) -> dict[str, Any]:
    """One-sided H0: E[r] <= 0 with an automatic Newey-West lag."""

    n = len(values)
    if n < 5:
        return {"status": "pending", "reason": "observations_insufficient", "n_observations": n}
    mean = sum(values) / n
    centered = [value - mean for value in values]
    lag = min(n - 1, max(1, int(math.floor(4.0 * (n / 100.0) ** (2.0 / 9.0)))))
    short_run_variance = sum(value * value for value in centered) / n
    long_run_variance = short_run_variance
    for offset in range(1, lag + 1):
        covariance = sum(
            centered[index] * centered[index - offset]
            for index in range(offset, n)
        ) / n
        long_run_variance += 2.0 * (1.0 - offset / (lag + 1.0)) * covariance
    # Negative sample autocovariance must not make a large-search test less conservative than iid.
    standard_error = math.sqrt(max(long_run_variance, short_run_variance) / n)
    if standard_error <= 1e-15:
        z_score = math.inf if mean > 0.0 else -math.inf
        p_value = 0.0 if mean > 0.0 else 1.0
    else:
        z_score = mean / standard_error
        p_value = 0.5 * math.erfc(z_score / math.sqrt(2.0))
    return {
        "status": "computed",
        "method": "newey_west_hac_one_sided_positive_mean",
        "n_observations": n,
        "lag": lag,
        "mean_return": round(mean, 10),
        "standard_error": round(standard_error, 10),
        "z_score": z_score,
        "raw_p_value": min(1.0, max(0.0, p_value)),
    }


def _holm_bonferroni(
    tests: dict[str, dict[str, Any]],
    *,
    alpha: float = 0.05,
    extra_family_size: int = 0,
) -> dict[str, Any]:
    """Holm step-down; `extra_family_size` hypotheses with unknown p-values are ranked last."""
    computed = {
        candidate_id: item
        for candidate_id, item in tests.items()
        if item.get("status") == "computed"
    }
    ordered = sorted(computed, key=lambda candidate_id: float(computed[candidate_id]["raw_p_value"]))
    adjusted: dict[str, float] = {}
    running_max = 0.0
    family_size = len(ordered) + max(0, int(extra_family_size))
    for rank, candidate_id in enumerate(ordered, start=1):
        raw = float(computed[candidate_id]["raw_p_value"])
        running_max = max(running_max, min(1.0, (family_size - rank + 1) * raw))
        adjusted[candidate_id] = running_max
    return {
        "status": "computed" if ordered else "pending",
        "method": "holm_bonferroni",
        "alpha": alpha,
        "family_size": family_size,
        "current_run_family_size": len(ordered),
        "prior_runs_family_size": max(0, int(extra_family_size)),
        "hypothesis": "holdout_mean_excess_return_gt_zero",
        "raw_test_method": "newey_west_hac_one_sided_positive_mean",
        "adjusted_p_values": adjusted,
    }


def _walk_forward(
    matrix: dict[str, list[float]],
    purge_attestation: dict[str, Any] | None,
) -> dict[str, Any]:
    if purge_attestation is None:
        return {
            "status": "pending",
            "method": "attested_front_embargo_expanding_selection_v3",
            "reason": "purge_attestation_missing_or_invalid",
            "windows": 0,
        }
    if len(matrix) < 2:
        return {
            "status": "pending",
            "method": "attested_front_embargo_expanding_selection_v3",
            "reason": "insufficient_candidates",
            "windows": 0,
        }
    n_partitions = len(next(iter(matrix.values())))
    if n_partitions < 4 or any(len(values) != n_partitions for values in matrix.values()):
        return {
            "status": "pending",
            "method": "attested_front_embargo_expanding_selection_v3",
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
        "method": "attested_front_embargo_expanding_selection_v3",
        "purge_attestation": purge_attestation,
        "windows": len(observations),
        "oos_mean_return": round(mean_return, 8),
        "positive_window_ratio": round(positive_ratio, 6),
        "observations": observations,
    }



def _attestation_checksum_ok(attestation: dict[str, Any]) -> tuple[dict[str, Any], str] | None:
    import hashlib
    import json

    checksum = str(attestation.get("payload_checksum") or "").strip().lower()
    payload = {key: value for key, value in attestation.items() if key != "payload_checksum"}
    computed = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if checksum != computed:
        return None
    return payload, checksum


def _attestation_structure_ok(payload: dict[str, Any], *, n_partitions: int, dates: Any) -> bool:
    partitions = payload.get("partitions")
    embargo = int(payload.get("embargo_sessions") or 0)
    if (
        payload.get("schema_version") != "strategy-mining-purge-attestation-v1"
        or payload.get("method") != "ordered_partition_front_embargo"
        or embargo < 1
        or int(payload.get("partition_count") or 0) != int(n_partitions)
        or not isinstance(dates, list)
        or not dates
        or dates != sorted(dates)
        or len(set(dates)) != len(dates)
        or not isinstance(partitions, list)
        or len(partitions) != int(n_partitions)
    ):
        return False
    for partition_id, partition in enumerate(partitions):
        if (
            not isinstance(partition, dict)
            or int(partition.get("partition_id", -1)) != partition_id
            or int(partition.get("purged_sessions") or 0) != embargo
            or not str(partition.get("raw_start") or "")
            or not str(partition.get("raw_end") or "")
            or not str(partition.get("test_start") or "")
            or not str(partition.get("test_end") or "")
            or str(partition["raw_start"]) > str(partition["test_start"])
            or str(partition["test_start"]) > str(partition["test_end"])
            or str(partition["test_end"]) > str(partition["raw_end"])
        ):
            return False
    return True


def _validated_purge_attestation(
    row: dict[str, Any],
    *,
    n_partitions: int,
    daily_return_count: int,
) -> dict[str, Any] | None:
    """Holdout attestation carried by a finalist row (dates must match its own returns)."""
    attestation = row.get("pbo_purge_attestation")
    if not isinstance(attestation, dict):
        return None
    verified = _attestation_checksum_ok(attestation)
    if verified is None:
        return None
    payload, checksum = verified
    dates = payload.get("holdout_dates")
    if (
        not _attestation_structure_ok(payload, n_partitions=n_partitions, dates=dates)
        or dates != row.get("holdout_dates")
        or len(dates) != daily_return_count
    ):
        return None
    return {**payload, "payload_checksum": checksum}


def _validated_selection_attestation(
    attestation: Any,
    *,
    n_partitions: int,
) -> dict[str, Any] | None:
    """Report-level attestation of the selection-sample (train+validation) partitions."""
    if not isinstance(attestation, dict):
        return None
    verified = _attestation_checksum_ok(attestation)
    if verified is None:
        return None
    payload, checksum = verified
    if payload.get("sample") != "selection":
        return None
    if not _attestation_structure_ok(payload, n_partitions=n_partitions, dates=payload.get("selection_dates")):
        return None
    return {**payload, "payload_checksum": checksum}


def build_strategy_mining_evidence(
    rows: list[dict[str, Any]],
    *,
    n_partitions: int,
    n_simulations: int = 1000,
    selection_attestation: dict[str, Any] | None = None,
    prior_holdout_family_size: int = 0,
    blocking_gates: list[str] | tuple[str, ...] = (),
    holm_alpha: float = 0.05,
) -> dict[str, Any]:
    """Research evidence without manufacturing missing gates.

    * Search-level overfitting (CSCV PBO, walk-forward) is measured on the SELECTION sample
      partitions of every evaluated candidate: that is the sample the search optimised, so it is
      the one whose selection bias PBO is meant to measure.
    * Per-candidate significance uses the sealed holdout, evaluated once, for the gate finalists
      only. The Holm family is this run's finalists PLUS every holdout hypothesis earlier runs
      tested on an overlapping holdout (`prior_holdout_family_size`); their unknown p-values are
      ranked last, which gives the largest Holm multipliers (conservative).
    * FinLab confirmation and report-level blocking gates are gate inputs, not side reports.
    """
    n_partitions = int(n_partitions)
    selection = _validated_selection_attestation(selection_attestation, n_partitions=n_partitions)
    selection_checksum = str((selection or {}).get("payload_checksum") or "")
    matrix: dict[str, list[float]] = {}
    rejected: dict[str, str] = {}
    finalists: dict[str, dict[str, Any]] = {}
    holdout_evaluated = 0
    for row in rows:
        candidate_id = str(row.get("candidate_id") or "").strip()
        if not candidate_id or row.get("status") != "ok":
            continue
        partitions = _finite_list(row.get("selection_partition_returns"))
        if row.get("holdout_status") == "evaluated":
            holdout_evaluated += 1
        if selection is None:
            rejected[candidate_id] = "selection_attestation_missing_or_invalid"
        elif str(row.get("selection_attestation_checksum") or "").lower() != selection_checksum:
            rejected[candidate_id] = "selection_attestation_mismatch"
        elif len(partitions) != n_partitions:
            rejected[candidate_id] = "partition_return_contract_unmet"
        else:
            matrix[candidate_id] = partitions
        if row.get("holdout_status") != "evaluated" or candidate_id not in matrix:
            # A finalist whose selection lineage is not attested cannot earn holdout evidence.
            continue
        daily_returns = _finite_list(row.get("holdout_daily_returns"))
        holdout_partitions = _finite_list(row.get("holdout_partition_returns"))
        regimes = row.get("holdout_regimes")
        if len(holdout_partitions) != n_partitions:
            rejected[candidate_id] = "holdout_partition_return_contract_unmet"
            continue
        if len(daily_returns) < 5:
            rejected[candidate_id] = "holdout_daily_returns_insufficient"
            continue
        if not isinstance(regimes, list) or len(regimes) != len(daily_returns):
            rejected[candidate_id] = "holdout_regime_alignment_unmet"
            continue
        purge = _validated_purge_attestation(row, n_partitions=n_partitions, daily_return_count=len(daily_returns))
        if purge is None:
            rejected[candidate_id] = "purge_attestation_missing_or_invalid"
            continue
        finalists[candidate_id] = {
            "partitions": holdout_partitions,
            "daily_returns": daily_returns,
            "regimes": [str(value or "unknown") for value in regimes],
            "purge_attestation": purge,
            "finlab_confirm_gate": row.get("finlab_confirm_gate") or {},
            "one_sided_regimes": list((row.get("holdout_excess") or {}).get("one_sided_regimes") or []),
        }

    common = {
        "candidate_count": len(matrix),
        "partition_count": n_partitions,
        "sample": "selection_excess_returns(train+validation)",
        "candidate_ids": sorted(matrix),
        "rejected": rejected,
    }
    if len(matrix) < 2 or n_partitions < 4:
        return {
            "schema_version": "strategy-mining-research-evidence-v4",
            "status": "pending",
            "reason": "common_candidate_return_matrix_insufficient",
            "common_candidate_matrix": common,
            "pbo": {"status": "pending", "reason": "matrix_insufficient"},
            "walk_forward": _walk_forward(matrix, selection),
            "blocking_gates": list(blocking_gates),
            "candidate_evidence": {},
        }

    pbo_result = _run_cscv_rank_logit_pbo(matrix)
    pbo_status = "pass" if pbo_result.go_live_verdict == "PASS" else "failed"
    pbo = {
        "status": pbo_status,
        "method": pbo_result.method,
        "sample": "selection",
        "pbo": pbo_result.pbo,
        "oos_mean_return": pbo_result.oos_mean_return,
        "n_partitions": pbo_result.n_partitions,
        "n_combinations": pbo_result.n_combinations,
        "selected_strategy_counts": pbo_result.selected_strategy_counts,
        "verdict": pbo_result.go_live_verdict,
        "reason": pbo_result.verdict_reason,
    }
    walk_forward = _walk_forward(matrix, selection)
    hac_tests = {
        candidate_id: _newey_west_positive_mean_p_value(item["daily_returns"])
        for candidate_id, item in finalists.items()
    }
    multiple_testing = _holm_bonferroni(
        hac_tests,
        alpha=float(holm_alpha),
        # Every holdout look counts, including finalists rejected below on contract grounds.
        extra_family_size=max(0, int(prior_holdout_family_size)) + max(0, holdout_evaluated - sum(1 for t in hac_tests.values() if t.get("status") == "computed")),
    )
    candidate_evidence: dict[str, dict[str, Any]] = {}
    for candidate_id, item in finalists.items():
        mc = _run_monte_carlo(
            item["daily_returns"],
            n_simulations=n_simulations,
            method="regime_block_bootstrap",
            trade_regimes=item["regimes"],
        )
        partitions = item["partitions"]
        candidate_mean = sum(partitions) / len(partitions)
        candidate_positive_ratio = sum(1 for value in partitions if value > 0.0) / len(partitions)
        failed_gates: list[str] = list(blocking_gates)
        if pbo_status != "pass":
            failed_gates.append("common_cscv_rank_logit_pbo")
        if walk_forward.get("status") != "pass":
            failed_gates.append("attested_front_embargo_walk_forward")
        if candidate_mean <= 0.0 or candidate_positive_ratio < 0.5:
            failed_gates.append("candidate_holdout_excess_partition_return")
        adjusted_p_value = multiple_testing["adjusted_p_values"].get(candidate_id)
        if multiple_testing.get("status") != "computed" or adjusted_p_value is None:
            failed_gates.append("multiple_testing_evidence_missing")
        elif float(adjusted_p_value) > float(multiple_testing["alpha"]):
            failed_gates.append("holdout_hac_holm_bonferroni")
        if mc.go_live_verdict != "PASS":
            failed_gates.append("regime_block_bootstrap_monte_carlo")
        if item["one_sided_regimes"]:
            failed_gates.append("holdout_regime_one_sided_excess")
        if (item["finlab_confirm_gate"] or {}).get("status") != "pass":
            failed_gates.append("finlab_confirm")
        candidate_evidence[candidate_id] = {
            "status": "failed" if failed_gates else "pass",
            "failed_gates": failed_gates,
            "holdout_return_basis": "excess_vs_tradable_universe_equal_weight",
            "holdout_partition_mean_return": round(candidate_mean, 8),
            "holdout_positive_partition_ratio": round(candidate_positive_ratio, 6),
            "finlab_confirm_gate": item["finlab_confirm_gate"],
            "multiple_testing": {
                **hac_tests[candidate_id],
                "adjustment_method": multiple_testing["method"],
                "family_size": multiple_testing["family_size"],
                "alpha": multiple_testing["alpha"],
                "adjusted_p_value": adjusted_p_value,
                "passed": adjusted_p_value is not None
                and float(adjusted_p_value) <= float(multiple_testing["alpha"]),
            },
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
        if not blocking_gates
        and pbo_status == "pass"
        and walk_forward.get("status") == "pass"
        and any(item.get("status") == "pass" for item in candidate_evidence.values())
        else "failed"
    )
    return {
        "schema_version": "strategy-mining-research-evidence-v4",
        "status": overall_status,
        "common_candidate_matrix": common,
        "pbo": pbo,
        "walk_forward": walk_forward,
        "purge_attestation": selection,
        "blocking_gates": list(blocking_gates),
        "multiple_testing": {
            **multiple_testing,
            "candidate_tests": hac_tests,
        },
        "candidate_evidence": candidate_evidence,
    }

