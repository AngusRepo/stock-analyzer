from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.ml_threshold_policy import resolve_ml_threshold_policy  # noqa: E402
from services import recommendation_service  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    filter_and_score_recommendations,
    overlay_ml_threshold_policy_source_of_truth,
)


def _load_json(path: str | None, default: Any = None) -> Any:
    if not path:
        return default
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _as_list(value: Any, *, label: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a JSON array")
    return [row for row in value if isinstance(row, dict)]


def _prediction_map(value: Any) -> dict[str, dict[str, Any]]:
    if isinstance(value, dict):
        if all(isinstance(item, dict) for item in value.values()):
            return {str(symbol): item for symbol, item in value.items()}
        rows = value.get("predictions") or value.get("rows")
        if rows is not None:
            return _prediction_map(rows)
    if isinstance(value, list):
        out: dict[str, dict[str, Any]] = {}
        for row in value:
            if not isinstance(row, dict):
                continue
            symbol = row.get("symbol") or row.get("stock_id")
            if symbol:
                out[str(symbol)] = row
        return out
    raise ValueError("predictions must be a JSON object keyed by symbol or an array with symbol")


def _zero_delta_adaptive(run_date: str) -> dict[str, Any]:
    return {
        "confidence_delta": 0.0,
        "threshold_components": {
            "effective_delta": 0.0,
            "formula": "local_threshold_policy_rescore_zero_delta",
        },
        "computed_at": f"{run_date}T18:00:00+08:00",
        "provenance": {
            "owner": "local_threshold_policy_rescore",
            "source": "local_zero_delta_default",
            "schema_version": "adaptive-params-v2",
            "update_frequency": "local_preview",
            "computed_at": f"{run_date}T18:00:00+08:00",
            "fallback": False,
        },
    }


def _score_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("score_components")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    return payload if isinstance(payload, dict) else {}


def _score_components(row: dict[str, Any]) -> dict[str, float]:
    payload = _score_payload(row)
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    return {
        "mlEdge": float(components.get("mlEdge") or 0.0),
        "chipFlow": float(components.get("chipFlow") or 0.0),
        "technicalStructure": float(components.get("technicalStructure") or 0.0),
        "fundamentalQuality": float(components.get("fundamentalQuality") or 0.0),
        "newsTheme": float(components.get("newsTheme") or 0.0),
    }


def _old_score_by_symbol(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        symbol = str(row.get("symbol") or "")
        if not symbol:
            continue
        payload = _score_payload(row)
        out[symbol] = {
            "score": payload.get("finalScore", row.get("score")),
            "components": _score_components(row),
        }
    return out


def _row_summary(row: dict[str, Any], old_scores: dict[str, dict[str, Any]]) -> dict[str, Any]:
    symbol = str(row.get("symbol") or "")
    old = old_scores.get(symbol) or {}
    old_components = old.get("components") or {}
    components = _score_components(row)
    policy = row.get("ml_edge_policy") if isinstance(row.get("ml_edge_policy"), dict) else {}
    return {
        "symbol": symbol,
        "name": row.get("name"),
        "signal": row.get("signal"),
        "score": row.get("score"),
        "old_score": old.get("score"),
        "score_delta": None if old.get("score") is None else round(float(row.get("score") or 0.0) - float(old.get("score") or 0.0), 4),
        "components": components,
        "component_delta": {
            key: round(components[key] - float(old_components.get(key) or 0.0), 4)
            for key in components
        },
        "score_seed_inputs": row.get("score_seed_inputs"),
        "ml_edge_policy": policy,
        "expected_return": row.get("expected_return"),
        "expected_return_source": row.get("expected_return_source"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only local rescore using ml_threshold_policy as the ML EDGE source of truth.",
    )
    parser.add_argument("--run-date", required=True)
    parser.add_argument("--recommendations-json", required=True, help="Screener/recommendation seed rows JSON array.")
    parser.add_argument("--predictions-json", required=True, help="Predictions JSON object keyed by symbol or array.")
    parser.add_argument("--payloads-json", help="Predict payloads JSON array; defaults to empty payload list.")
    parser.add_argument("--policy-json", required=True, help="Champion/promotion policy snapshot JSON.")
    parser.add_argument("--adaptive-json", help="Adaptive params JSON. Defaults to local zero-delta as-of run_date.")
    parser.add_argument("--regime-json", help="Runtime regime contract JSON. Defaults to uncertain local preview.")
    parser.add_argument("--output", help="Optional output JSON path.")
    args = parser.parse_args(argv)

    recommendations = _as_list(_load_json(args.recommendations_json), label="recommendations")
    payloads = _as_list(_load_json(args.payloads_json, default=[]), label="payloads")
    predictions = _prediction_map(_load_json(args.predictions_json))
    policy_snapshot = _load_json(args.policy_json)
    adaptive_params = _load_json(args.adaptive_json, default=_zero_delta_adaptive(args.run_date))
    regime_contract = _load_json(args.regime_json, default={
        "alpha_regime": "uncertain",
        "source": "local_threshold_policy_rescore",
    })

    resolved = resolve_ml_threshold_policy(
        run_date=args.run_date,
        regime_contract=regime_contract,
        ev2_cfg={},
        adaptive_params=adaptive_params,
        policy_snapshot=policy_snapshot,
    )
    overlaid_predictions = overlay_ml_threshold_policy_source_of_truth(
        predictions,
        resolved.evidence(),
        force=True,
    )

    final_rows, sell_count = filter_and_score_recommendations(
        recommendations,
        overlaid_predictions,
        payloads,
    )
    final_rows = sorted(final_rows, key=lambda row: float(row.get("score") or 0.0), reverse=True)
    old_scores = _old_score_by_symbol(recommendations)
    report = {
        "schema_version": "local-threshold-policy-rescore-v1",
        "run_date": args.run_date,
        "read_only": True,
        "policy": resolved.evidence(),
        "input": {
            "recommendations": len(recommendations),
            "predictions": len(predictions),
            "payloads": len(payloads),
        },
        "output": {
            "rows": len(final_rows),
            "sell_filtered_count": sell_count,
        },
        "rows": [_row_summary(row, old_scores) for row in final_rows],
    }
    raw = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(raw + "\n", encoding="utf-8")
    print(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
