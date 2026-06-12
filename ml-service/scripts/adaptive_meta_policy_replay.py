#!/usr/bin/env python3
"""Run read-only historical replay for adaptive meta-policy candidates."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adaptive_meta_policy_replay import ReplayConfig, run_adaptive_meta_policy_replay


ACTIVE_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
    "TimesFM",
)


def _load_json_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(payload, dict) and isinstance(payload.get("results"), list):
        return list(payload["results"])
    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict) and isinstance(payload[0].get("results"), list):
            return list(payload[0]["results"])
        return [row for row in payload if isinstance(row, dict)]
    raise ValueError(f"unsupported JSON shape in {path}")


def _load_jsonl_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if isinstance(row, dict):
            rows.append(row)
    return rows


def load_rows(path: str) -> list[dict[str, Any]]:
    source = Path(path)
    suffix = source.suffix.lower()
    if suffix == ".csv":
        return pl.read_csv(source).to_dicts()
    if suffix in {".json", ".js"}:
        return _load_json_rows(source)
    if suffix in {".jsonl", ".ndjson"}:
        return _load_jsonl_rows(source)
    raise ValueError(f"unsupported input format: {source.suffix}")


def load_rows_from_d1(start_date: str | None, end_date: str | None, limit: int) -> list[dict[str, Any]]:
    from app.d1_client import query

    placeholders = ",".join(["?"] * len(ACTIVE_MODELS))
    clauses = [
        f"p.model_name IN ({placeholders})",
        "p.verified_at IS NOT NULL",
        "p.actual_return_pct IS NOT NULL",
    ]
    params: list[Any] = list(ACTIVE_MODELS)
    if start_date:
        clauses.append("date(p.prediction_date) >= date(?)")
        params.append(start_date)
    if end_date:
        clauses.append("date(p.prediction_date) <= date(?)")
        params.append(end_date)
    params.append(max(1, min(limit, 50000)))
    sql = f"""
        SELECT
          p.prediction_date AS date,
          p.stock_id,
          s.symbol,
          p.model_name,
          p.direction_correct,
          p.direction_accuracy,
          p.price_error_pct,
          p.actual_return_pct,
          p.trade_pnl_pct,
          p.forecast_data,
          p.market_risk_score,
          dr.market_segment,
          dr.recommendation_lane,
          dr.has_buy_signal,
          dr.score_components,
          dr.ml_vote_summary,
          dr.alpha_context,
          dr.alpha_allocation
        FROM predictions p
        LEFT JOIN stocks s ON s.id = p.stock_id
        LEFT JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        WHERE {' AND '.join(clauses)}
        ORDER BY date(p.prediction_date) ASC, p.stock_id ASC, p.model_name ASC
        LIMIT ?
    """
    return query(sql, params=params, timeout=120.0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="CSV/JSON/JSONL rows exported from D1")
    parser.add_argument("--from-d1", action="store_true", help="Read historical rows through app.d1_client")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--limit", type=int, default=20000)
    parser.add_argument("--min-ic-samples", type=int, default=5)
    parser.add_argument("--min-windows", type=int, default=8)
    parser.add_argument("--neural-epochs", type=int, default=80)
    parser.add_argument("--output", help="Optional JSON report path")
    args = parser.parse_args()

    sources = [bool(args.input), bool(args.from_d1)]
    if sum(sources) != 1:
        parser.error("provide exactly one of --input or --from-d1")

    if args.input:
        rows = load_rows(args.input)
    else:
        rows = load_rows_from_d1(args.start_date, args.end_date, args.limit)
    report = run_adaptive_meta_policy_replay(
        rows,
        config=ReplayConfig(
            min_ic_samples=args.min_ic_samples,
            min_windows=args.min_windows,
            neural_epochs=args.neural_epochs,
        ),
    )
    text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if report.get("status") == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
