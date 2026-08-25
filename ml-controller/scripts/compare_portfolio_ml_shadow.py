"""Read-only Sparse / Static-ML / Portfolio-ML allocation comparison.

The input is an immutable local export of production domain D1 SELECT results.
No network, database write, retrain, job, or order path is used here.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.portfolio_ml_shadow_inputs import build_portfolio_ml_shadow_inputs
from services.rfs_implementable_frontier_shadow import build_rfs_implementable_frontier_shadow


def _finite(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _effective_holdings(weights: dict[str, float]) -> float:
    positive = [float(weight) for weight in weights.values() if float(weight) > 0]
    gross = sum(positive)
    concentration = sum(weight * weight for weight in positive)
    return gross * gross / concentration if concentration > 0 else 0.0


def _return_history(rows: list[dict[str, Any]]) -> dict[str, list[float]]:
    closes: dict[str, list[tuple[str, float]]] = defaultdict(list)
    symbol_by_id: dict[str, str] = {}
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        stock_id = str(row.get("stock_id") or "").strip()
        if symbol and stock_id:
            symbol_by_id[stock_id] = symbol
    price_rows = rows[0].get("_price_rows") if rows else None
    if not isinstance(price_rows, list):
        return {}
    for row in price_rows:
        symbol = symbol_by_id.get(str(row.get("stock_id") or ""))
        close = _finite(row.get("close"), -1.0)
        date = str(row.get("date") or "")[:10]
        if symbol and date and close > 0:
            closes[symbol].append((date, close))
    out: dict[str, list[float]] = {}
    for symbol, values in closes.items():
        ordered = [close for _date, close in sorted(values)]
        out[symbol] = [
            ordered[index] / ordered[index - 1] - 1.0
            for index in range(1, len(ordered))
            if ordered[index - 1] > 0
        ]
    return out


def build_report(payload: dict[str, Any]) -> dict[str, Any]:
    as_of_date = str(payload.get("as_of_date") or "")[:10]
    raw_candidates = [dict(row) for row in payload.get("candidates") or []]
    price_rows = [dict(row) for row in payload.get("price_rows") or []]
    candidates: list[dict[str, Any]] = []
    for raw in raw_candidates:
        price = _finite(raw.get("current_price"))
        volume = _finite(raw.get("avg_volume_20"))
        candidates.append({
            **raw,
            "expected_return": _finite(raw.get("expected_return")),
            "expected_return_owner": str(raw.get("expected_return_owner") or "risk_abstention"),
            "market_heat_expected_return": _finite(raw.get("market_heat_expected_return")),
            "avg_daily_turnover_twd": price * volume if price > 0 and volume > 0 else None,
            "alpha_allocation": json.dumps({
                "expected_return": _finite(raw.get("expected_return")),
                "allocation_weight": _finite(raw.get("allocation_weight")),
            }, separators=(",", ":")),
        })
    if candidates:
        candidates[0]["_price_rows"] = price_rows
    history = _return_history(candidates)
    account_payload = payload.get("paper_accounts")
    if isinstance(account_payload, list):
        account = account_payload[0] if account_payload else {}
    elif isinstance(account_payload, dict):
        account = account_payload
    else:
        account = {}
    cash = max(0.0, _finite(account.get("cash")))
    inherited = {
        "status": "ready",
        "weights": {},
        "portfolio_value_twd": cash,
        "cash_weight": 1.0,
        "position_count": 0,
        "priced_position_count": 0,
        "unresolved_symbols": [],
        "source": "production_paper_account_readonly_empty_positions",
    }
    inputs = build_portfolio_ml_shadow_inputs(
        candidates,
        as_of_date=as_of_date,
        inherited_state=inherited,
        training_rows=[dict(row) for row in payload.get("training_rows") or []],
    )
    paths = inputs.get("multi_horizon_expected_return_path") or {}
    shadow_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        symbol = str(candidate.get("symbol") or "")
        path = paths.get(symbol) if isinstance(paths, dict) else None
        normalized: list[float] = []
        if isinstance(path, dict):
            for horizon in (3, 5, 10):
                value = path.get(horizon) if horizon in path else path.get(str(horizon))
                if value is not None:
                    normalized.append(_finite(value) * 5.0 / horizon)
        if len(normalized) != 3:
            continue
        shadow_candidates.append({
            **candidate,
            "expected_return": sum(normalized) / 3.0,
            "expected_return_owner": "portfolio_ml_shadow",
            "expected_return_source": "portfolio_ml_multi_horizon_comparison_only",
        })
    incumbent_weights = {
        str(row.get("symbol") or ""): _finite(row.get("allocation_weight"))
        for row in candidates
        if _finite(row.get("allocation_weight")) > 0
    }
    packet = build_rfs_implementable_frontier_shadow(
        shadow_candidates,
        history,
        incumbent_weights=incumbent_weights,
        inherited_weights={},
        portfolio_ml_inputs=inputs,
        portfolio_value_twd=max(1.0, cash),
        max_weight=0.24,
        risk_aversion=2.0,
        l2_penalty=0.0,
        comparison_only_shadow_alpha=True,
    )
    current_formal_count = sum(
        str(row.get("expected_return_owner") or "") in {"l4_alpha_ev", "allocator_ev_fusion"}
        for row in candidates
    )
    return {
        "schema_version": "sparse-static-portfolio-ml-production-readonly-comparison-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "as_of_date": as_of_date,
        "production_effect": False,
        "comparison_scope": "single_asof_allocation_diagnostics_not_oos_performance_claim",
        "pit_contract": "training_outcome_known_date_lte_asof;prices_lte_asof;no_topk",
        "input_evidence": {
            "candidate_count": len(candidates),
            "current_formal_expected_return_owner_count": current_formal_count,
            "current_sparse_selected_count": len(incumbent_weights),
            "current_sparse_budget_used": round(sum(incumbent_weights.values()), 10),
            "current_sparse_effective_holdings": round(_effective_holdings(incumbent_weights), 6),
            "training_rows": inputs.get("training_row_count"),
            "training_dates": inputs.get("training_date_count"),
            "horizon_sample_counts": inputs.get("horizon_sample_counts"),
            "paper_position_count": 0,
            "paper_cash_twd": cash,
            "return_history_covered": sum(len(history.get(str(row.get("symbol") or ""), [])) >= 20 for row in candidates),
        },
        "portfolio_ml_inputs": {
            "status": inputs.get("status"),
            "validation_blockers": inputs.get("validation_blockers") or [],
            "multi_horizon_candidate_count": len(paths),
            "direct_weight_candidate_count": len(inputs.get("direct_weight_targets") or {}),
            "dynamic_speed_candidate_count": len(inputs.get("dynamic_trading_speeds") or {}),
        },
        "comparison_adapter": {
            "enabled": True,
            "source": "portfolio_ml_shadow_multi_horizon_path",
            "candidate_count": len(shadow_candidates),
            "formal_owner_claim": False,
            "production_eligible": False,
        },
        "allocation_packet": packet,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    report = build_report(payload)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": report["allocation_packet"].get("status"),
        "input_evidence": report["input_evidence"],
        "portfolio_ml_inputs": report["portfolio_ml_inputs"],
        "metrics": report["allocation_packet"].get("metrics") or {},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
