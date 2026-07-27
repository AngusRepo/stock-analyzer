"""Canonical expected-return cost semantics for serving-time normalization."""
from __future__ import annotations

import math
from typing import Any

COST_CONTRACT_VERSION = "expected-return-net-cost-v1"


class ExpectedReturnCostContractError(ValueError):
    """Raised when gross/net expected-return semantics are ambiguous."""


def _finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def expected_return_cost_contract_blockers(payload: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    flag = payload.get("output_is_net_of_costs")
    if not isinstance(flag, bool):
        blockers.append("output_is_net_of_costs_missing_or_invalid")
    cost_bps = _finite_number(payload.get("cost_model_bps"))
    if cost_bps is None:
        blockers.append("cost_model_bps_missing_or_invalid")
    elif cost_bps < 0:
        blockers.append("cost_model_bps_negative")
    return blockers


def normalize_expected_return_to_net(
    value: float,
    payload: dict[str, Any],
) -> tuple[float, dict[str, Any]]:
    blockers = expected_return_cost_contract_blockers(payload)
    if blockers:
        raise ExpectedReturnCostContractError(",".join(blockers))
    cost_bps = float(payload["cost_model_bps"])
    source_is_net = payload["output_is_net_of_costs"] is True
    normalized = float(value) if source_is_net else float(value) - cost_bps / 10000.0
    return normalized, {
        "output_is_net_of_costs": True,
        "source_output_is_net_of_costs": source_is_net,
        "cost_normalization_applied": not source_is_net,
        "cost_normalization_bps": 0.0 if source_is_net else cost_bps,
        "expected_return_cost_contract_version": COST_CONTRACT_VERSION,
    }
