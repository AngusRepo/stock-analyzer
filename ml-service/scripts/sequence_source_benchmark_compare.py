"""Compare sequence family benchmarks across old vs long-history data sources.

Read-only: no model_pool writes, no artifact promotion, no production retrain.
The script loads sequence_records from two prep prefixes, aligns symbols where
possible, runs research adapters, and writes a reproducible JSON report.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.research_benchmarks.common import load_sequence_dataset  # noqa: E402
from app.research_model_benchmark_runtime import run_research_model_benchmark  # noqa: E402


DEFAULT_MODELS = ("DLinear", "PatchTST", "iTransformer", "TimesFM")
DEFAULT_CONTEXTS = (128, 256, 512, 1024)


def _record_key(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _length(row: dict[str, Any]) -> int:
    return len(row.get("close") or row.get("series_close") or [])


def _by_symbol(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in records:
        key = _record_key(row)
        if not key:
            continue
        if key not in out or _length(row) > _length(out[key]):
            out[key] = row
    return out


def _source_report(records: list[dict[str, Any]]) -> dict[str, Any]:
    lengths = [_length(row) for row in records]
    dates = [
        str(value)[:10]
        for row in records
        for value in (row.get("dates") or [])
        if str(value)
    ]
    return {
        "symbols": len(records),
        "rows": int(sum(lengths)),
        "min_len": int(min(lengths)) if lengths else 0,
        "max_len": int(max(lengths)) if lengths else 0,
        "date_min": min(dates) if dates else None,
        "date_max": max(dates) if dates else None,
    }


def _select_records(
    *,
    source_records: list[dict[str, Any]],
    peer_records: list[dict[str, Any]],
    min_len: int,
    max_series: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    source = _by_symbol(source_records)
    peer = _by_symbol(peer_records)
    common = sorted(set(source) & set(peer))
    selected_symbols = [
        symbol
        for symbol in common
        if _length(source[symbol]) >= min_len and _length(peer[symbol]) >= min_len
    ]
    alignment_mode = "common_symbols"
    if not selected_symbols:
        selected_symbols = [
            symbol
            for symbol, row in sorted(source.items())
            if _length(row) >= min_len
        ]
        alignment_mode = "source_only_symbols"
    selected_symbols = selected_symbols[:max_series]
    return [source[symbol] for symbol in selected_symbols], {
        "alignment_mode": alignment_mode,
        "selected_symbols": len(selected_symbols),
        "common_symbols_total": len(common),
        "min_len": min_len,
        "max_series": max_series,
    }


def _mean_fold(report: dict[str, Any], key: str) -> float | None:
    rows = report.get("fold_metrics")
    if not isinstance(rows, list) or not rows:
        return None
    vals: list[float] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            vals.append(float(row.get(key)))
        except (TypeError, ValueError):
            continue
    return round(sum(vals) / len(vals), 8) if vals else None


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _trim_report(report: dict[str, Any]) -> dict[str, Any]:
    data_slice = report.get("data_slice_report") if isinstance(report.get("data_slice_report"), dict) else {}
    sequence_report = data_slice.get("sequence_report") if isinstance(data_slice.get("sequence_report"), dict) else {}
    cost = report.get("cost_sensitivity") if isinstance(report.get("cost_sensitivity"), dict) else {}
    return {
        "status": report.get("status"),
        "blockers": report.get("blockers") or [],
        "folds": len(report.get("fold_metrics") or []),
        "oos_ic_mean": _mean_fold(report, "oos_ic"),
        "direction_accuracy_mean": _mean_fold(report, "direction_accuracy"),
        "pbo": _safe_float(report.get("pbo")),
        "latency_sec": _safe_float(cost.get("latency_sec")),
        "rows_metric": cost.get("rows"),
        "data_slice_report": {
            key: data_slice.get(key)
            for key in ("symbols", "rows", "min_series_len", "max_series_len", "start_date", "end_date", "source")
            if key in data_slice
        },
        "sequence_report": sequence_report,
    }


def _run_one(
    *,
    model: str,
    context_len: int,
    source_name: str,
    records: list[dict[str, Any]],
    base_payload: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        **base_payload,
        "candidate_id": model,
        "seq_len": context_len,
        "data_slice": {
            **(base_payload.get("data_slice") or {}),
            "seq_len": context_len,
        },
        "sequence_records": records,
    }
    try:
        report = run_research_model_benchmark(payload)
    except Exception as exc:  # noqa: BLE001
        report = {
            "status": "blocked",
            "candidate_id": model,
            "blockers": [f"benchmark_exception:{type(exc).__name__}:{exc}"],
        }
    return {
        "source_name": source_name,
        "model": model,
        "context_len": context_len,
        **_trim_report(report),
    }


def compare_sources(
    *,
    old_prefix: str,
    old_batch_count: int,
    new_prefix: str,
    new_batch_count: int,
    models: list[str],
    contexts: list[int],
    max_series: int,
    base_payload: dict[str, Any],
) -> dict[str, Any]:
    old_records = load_sequence_dataset({
        "sequence_gcs_prefix": old_prefix,
        "sequence_batch_count": old_batch_count,
    }).records
    new_records = load_sequence_dataset({
        "sequence_gcs_prefix": new_prefix,
        "sequence_batch_count": new_batch_count,
    }).records
    report: dict[str, Any] = {
        "schema_version": "sequence-source-benchmark-comparison-v1",
        "status": "completed",
        "production_mutation_allowed": False,
        "promotion_allowed": False,
        "old_source": {"prefix": old_prefix, "batch_count": old_batch_count, **_source_report(old_records)},
        "new_source": {"prefix": new_prefix, "batch_count": new_batch_count, **_source_report(new_records)},
        "config": {
            "models": models,
            "contexts": contexts,
            "max_series": max_series,
            "base_payload": base_payload,
        },
        "results": [],
    }
    for context_len in contexts:
        min_len = int(context_len) + int(base_payload.get("pred_len") or 5)
        old_selected, old_selection = _select_records(
            source_records=old_records,
            peer_records=new_records,
            min_len=min_len,
            max_series=max_series,
        )
        new_selected, new_selection = _select_records(
            source_records=new_records,
            peer_records=old_records,
            min_len=min_len,
            max_series=max_series,
        )
        context_result: dict[str, Any] = {
            "context_len": context_len,
            "min_len": min_len,
            "old_selection": old_selection,
            "new_selection": new_selection,
            "models": {},
        }
        for model in models:
            old_report = (
                _run_one(
                    model=model,
                    context_len=context_len,
                    source_name="current_universal",
                    records=old_selected,
                    base_payload=base_payload,
                )
                if old_selected
                else {
                    "source_name": "current_universal",
                    "model": model,
                    "context_len": context_len,
                    "status": "blocked",
                    "blockers": ["no_current_universal_records_for_context"],
                }
            )
            new_report = (
                _run_one(
                    model=model,
                    context_len=context_len,
                    source_name="long_finlab_5y_plus_3y",
                    records=new_selected,
                    base_payload=base_payload,
                )
                if new_selected
                else {
                    "source_name": "long_finlab_5y_plus_3y",
                    "model": model,
                    "context_len": context_len,
                    "status": "blocked",
                    "blockers": ["no_long_history_records_for_context"],
                }
            )
            old_ic = old_report.get("oos_ic_mean")
            new_ic = new_report.get("oos_ic_mean")
            context_result["models"][model] = {
                "old": old_report,
                "new": new_report,
                "delta_oos_ic_mean": round(float(new_ic) - float(old_ic), 8) if old_ic is not None and new_ic is not None else None,
                "delta_pbo": (
                    round(float(new_report["pbo"]) - float(old_report["pbo"]), 8)
                    if old_report.get("pbo") is not None and new_report.get("pbo") is not None
                    else None
                ),
            }
        report["results"].append(context_result)
    return report


def _parse_csv(raw: str, *, cast=str) -> list:
    return [cast(item.strip()) for item in raw.split(",") if item.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-prefix", default="universal")
    parser.add_argument("--old-batch-count", type=int, default=5)
    parser.add_argument("--new-prefix", required=True)
    parser.add_argument("--new-batch-count", type=int, default=6)
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS))
    parser.add_argument("--contexts", default=",".join(str(v) for v in DEFAULT_CONTEXTS))
    parser.add_argument("--max-series", type=int, default=256)
    parser.add_argument("--max-windows", type=int, default=8000)
    parser.add_argument("--max-oos-windows", type=int, default=512)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--max-steps", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    base_payload = {
        "pred_len": 5,
        "oos_ratio": 0.2,
        "max_windows": args.max_windows,
        "max_oos_windows": args.max_oos_windows,
        "epochs": args.epochs,
        "max_steps": args.max_steps,
        "batch_size": args.batch_size,
        "seed": 42,
        "data_slice": {
            "pred_len": 5,
            "oos_ratio": 0.2,
            "max_windows": args.max_windows,
            "max_oos_windows": args.max_oos_windows,
            "epochs": args.epochs,
            "max_steps": args.max_steps,
            "batch_size": args.batch_size,
            "seed": 42,
        },
    }
    report = compare_sources(
        old_prefix=args.old_prefix,
        old_batch_count=args.old_batch_count,
        new_prefix=args.new_prefix,
        new_batch_count=args.new_batch_count,
        models=_parse_csv(args.models, cast=str),
        contexts=_parse_csv(args.contexts, cast=int),
        max_series=args.max_series,
        base_payload=base_payload,
    )
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "output": str(out_path),
        "models": report["config"]["models"],
        "contexts": report["config"]["contexts"],
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
