"""Research-only AlphaAgentEvo trajectory evaluator.

The service does not mine new factors by itself. It records and evaluates the
self-evolving trajectory that an agentic alpha miner would produce, so lineage
and validation evidence are explicit before any candidate can be queued for the
next generation.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "alpha-agent-evo-trajectory-v1"


def _to_float(value: object, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clean_id(value: object) -> str:
    return str(value or "").strip()


def _clean_ids(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_clean_id(item) for item in value if _clean_id(item)]


def _candidate_blockers(metrics: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    sharpe = _to_float(metrics.get("walk_forward_sharpe"))
    pbo = _to_float(metrics.get("pbo"))
    reality_check_p = _to_float(metrics.get("reality_check_p"))
    max_drawdown = _to_float(metrics.get("max_drawdown"))
    paper_days = _to_int(metrics.get("paper_days"))
    historical_replay_days = _to_int(metrics.get("historical_replay_days"))

    if sharpe is None:
        blockers.append("walk_forward_sharpe_missing")
    elif sharpe < 1.0:
        blockers.append("walk_forward_sharpe_too_low")

    if pbo is None:
        blockers.append("pbo_missing")
    elif pbo > 0.25:
        blockers.append("pbo_too_high")

    if reality_check_p is None:
        blockers.append("reality_check_missing")
    elif reality_check_p > 0.05:
        blockers.append("reality_check_not_significant")

    if max_drawdown is None:
        blockers.append("max_drawdown_missing")
    elif max_drawdown > 0.20:
        blockers.append("max_drawdown_too_high")

    if paper_days < 45 and historical_replay_days < 60:
        blockers.append("paper_trade_days_insufficient")

    return blockers


def _evolution_path(candidate_id: str, parent_ids: list[str], by_id: dict[str, dict[str, Any]]) -> list[str]:
    if not parent_ids:
        return [candidate_id]
    primary_parent = parent_ids[0]
    parent = by_id.get(primary_parent)
    if not parent:
        return [primary_parent, candidate_id]
    return _evolution_path(primary_parent, _clean_ids(parent.get("parent_ids")), by_id) + [candidate_id]


def build_alpha_agent_evo_trajectory_report(
    *,
    candidates: list[dict[str, Any]],
    champion_id: str | None,
) -> dict[str, Any]:
    by_id = {_clean_id(row.get("candidate_id")): row for row in candidates if _clean_id(row.get("candidate_id"))}
    trajectory: list[dict[str, Any]] = []
    next_generation_queue: list[str] = []
    champion_blockers: list[str] = ["champion_missing"]

    for row in sorted(candidates, key=lambda item: (_to_int(item.get("generation")), _clean_id(item.get("candidate_id")))):
        candidate_id = _clean_id(row.get("candidate_id"))
        if not candidate_id:
            continue
        metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
        parent_ids = _clean_ids(row.get("parent_ids"))
        blockers = _candidate_blockers(metrics)
        if candidate_id == champion_id:
            champion_blockers = list(blockers)
        if _to_int(row.get("generation")) > 0 and not parent_ids:
            blockers.append("parent_lineage_missing")
            if candidate_id == champion_id:
                champion_blockers = list(blockers)
        decision = "NEXT_GENERATION" if not blockers and candidate_id != champion_id else "HOLD_CHAMPION"
        if blockers:
            decision = "REJECT"
        if decision == "NEXT_GENERATION":
            next_generation_queue.append(candidate_id)
        trajectory.append({
            "candidate_id": candidate_id,
            "generation": _to_int(row.get("generation")),
            "operator": str(row.get("operator") or "unknown"),
            "expression": str(row.get("expression") or ""),
            "parent_ids": parent_ids,
            "evolution_path": _evolution_path(candidate_id, parent_ids, by_id),
            "metrics": metrics,
            "decision": decision,
            "blockers": blockers,
        })

    champion_ready = bool(champion_id) and not champion_blockers
    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "research_only",
        "production_mutation_allowed": False,
        "champion_id": champion_id,
        "required_evidence": [
            "walk_forward_sharpe",
            "pbo",
            "reality_check_p",
            "max_drawdown",
            "paper_days_or_historical_replay_days",
        ],
        "trajectory": trajectory,
        "next_generation_queue": next_generation_queue,
        "decision": {
            "eligible_to_replace_baseline": champion_ready,
            "accelerated_historical_replacement_allowed": champion_ready,
            "production_mutation_allowed": False,
            "champion_blockers": champion_blockers,
        },
        "gap_vs_current_poc": {
            "quantaalpha_gp_openfe_poc": "single_run_candidate_mining",
            "alpha_agent_evo": "lineage_aware_self_evolving_trajectory",
            "required_new_capabilities": [
                "parent_child_lineage",
                "mutation_operator_tracking",
                "validation_gate_per_generation",
                "reject_reason_memory",
                "next_generation_queue",
            ],
        },
    }
