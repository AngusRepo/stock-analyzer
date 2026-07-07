from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.l4_alpha_ev_producer import materialize_l4_alpha_ev  # noqa: E402
from services.recommendation_service import apply_sparse_tangent_allocation  # noqa: E402


def _load_wrangle_rows(path: str) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and isinstance(raw[0].get("results"), list):
        return raw[0]["results"]
    if isinstance(raw, dict) and isinstance(raw.get("results"), list):
        return raw["results"]
    if isinstance(raw, list):
        return raw
    raise ValueError(f"unsupported rows JSON: {path}")


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _artifact(path: str) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    artifact = payload.get("artifact") if isinstance(payload, dict) else None
    if not isinstance(artifact, dict):
        raise ValueError("artifact JSON must contain top-level artifact object")
    return artifact


def _row(raw: dict[str, Any]) -> dict[str, Any]:
    allocation = _loads(raw.get("alpha_allocation"))
    forecast = _loads(raw.get("forecast_data"))
    score_components = _loads(raw.get("score_components"))
    alpha_context = _loads(raw.get("alpha_context"))
    return {
        **raw,
        "score": raw.get("score"),
        "score_components": score_components,
        "alpha_context": alpha_context,
        "forecast_data": forecast,
        "ensemble_v2": forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {},
        "s12_trade_ev": allocation.get("s12_trade_ev") if isinstance(allocation.get("s12_trade_ev"), dict) else None,
        "trade_expected_return_net_pct": (
            allocation.get("s12_trade_ev") or {}
        ).get("trade_expected_return_net_pct") if isinstance(allocation.get("s12_trade_ev"), dict) else None,
        "trade_expected_return_source": (
            allocation.get("s12_trade_ev") or {}
        ).get("trade_expected_return_source") if isinstance(allocation.get("s12_trade_ev"), dict) else None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only dry-run L4 alpha EV artifact through sparse allocator.")
    parser.add_argument("--rows-json", required=True)
    parser.add_argument("--artifact-json", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)

    artifact = _artifact(args.artifact_json)
    rows = [_row(row) for row in _load_wrangle_rows(args.rows_json)]
    policy = {
        "l4_alpha_ev": artifact,
        "allocation": {
            "engine": "sparse_tangent_inverse_risk",
            "controller": "sparse_tangent_inverse_risk",
            "buySignalCount": 5,
            "buy_signal_count": 5,
            "slateSize": 10,
            "slate_size": 10,
        },
    }
    for row in rows:
        prediction = {
            "ensemble_v2": row.get("ensemble_v2"),
            "alpha_context": row.get("alpha_context"),
        }
        payload = materialize_l4_alpha_ev(row, prediction=prediction, policy=policy)
        if isinstance(payload, dict):
            row["l4_alpha_ev"] = payload

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True, "promoteMinForecastPct": 0.005, "promoteMinMlEdge": 0.0},
        alpha_policy=policy,
    )
    buy = [
        row for row in promoted
        if row.get("signal") == "BUY"
        or row.get("has_buy_signal") == 1
        or ((_loads(row.get("alpha_allocation"))).get("selected") is True)
        or ((row.get("alpha_allocation") or {}).get("selected") is True if isinstance(row.get("alpha_allocation"), dict) else False)
    ]
    potential = [
        row for row in promoted
        if row.get("signal") == "POTENTIAL_BUY"
        or (
            isinstance(row.get("alpha_allocation"), dict)
            and row["alpha_allocation"].get("selection_reason") == "positive_edge_but_zero_weight_due_to_better_alternative"
        )
    ]
    owner_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    for row in promoted:
        alloc = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
        owner = str(alloc.get("expected_return_owner") or "missing")
        source = str(alloc.get("expected_return_source") or "missing")
        owner_counts[owner] = owner_counts.get(owner, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1
    report = {
        "schema_version": "l4-alpha-ev-artifact-dry-run-v1",
        "rows": len(promoted),
        "buy_count": len(buy),
        "potential_buy_count": len(potential),
        "owner_counts": owner_counts,
        "source_counts": dict(sorted(source_counts.items(), key=lambda item: item[1], reverse=True)[:20]),
        "buy_symbols": [str(row.get("symbol")) for row in buy],
        "potential_buy_symbols": [str(row.get("symbol")) for row in potential],
    }
    raw = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(raw + "\n", encoding="utf-8")
    print(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

