"""Read-only TimesFM 2.0 vs 2.5 migration benchmark.

This runner never promotes artifacts, writes model_pool state, or retrains. It
supports a two-phase workflow because TimesFM 2.0 and 2.5 use incompatible
package APIs:

1. Run `run-candidate` under the matching timesfm package for each candidate.
2. Run `compare` on the two JSON outputs.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.research_benchmarks.common import data_slice_report, load_sequence_dataset, rank_ic  # noqa: E402
from app.sequence_training import build_sequence_window_dataset  # noqa: E402

TIMESFM20_MODEL_ID = "google/timesfm-2.0-500m-pytorch"
TIMESFM25_MODEL_ID = "google/timesfm-2.5-200m-pytorch"
DEFAULT_CONTEXTS = (256, 512, 1024, 2048)


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _mean(values: list[float]) -> float | None:
    return round(float(np.mean(values)), 8) if values else None


def _rmse(values: list[float]) -> float | None:
    return round(float(np.sqrt(np.mean(np.square(values)))), 8) if values else None


def _percentile(values: list[float], q: float) -> float | None:
    return round(float(np.percentile(values, q)), 8) if values else None


def _safe_mape(pred: np.ndarray, actual: np.ndarray) -> float | None:
    mask = np.isfinite(pred) & np.isfinite(actual) & (np.abs(actual) > 1e-9)
    if not mask.any():
        return None
    return round(float(np.mean(np.abs((pred[mask] - actual[mask]) / actual[mask]))), 8)


def _safe_smape(pred: np.ndarray, actual: np.ndarray) -> float | None:
    denom = np.abs(pred) + np.abs(actual)
    mask = np.isfinite(pred) & np.isfinite(actual) & (denom > 1e-9)
    if not mask.any():
        return None
    return round(float(np.mean(2.0 * np.abs(pred[mask] - actual[mask]) / denom[mask])), 8)


def _direction_accuracy(pred_return: np.ndarray, actual_return: np.ndarray) -> float:
    mask = np.isfinite(pred_return) & np.isfinite(actual_return) & (pred_return != 0) & (actual_return != 0)
    return round(float(np.mean(np.sign(pred_return[mask]) == np.sign(actual_return[mask]))), 8) if mask.any() else 0.0


def _monotonic_violation_rate(q: np.ndarray | None) -> float | None:
    if q is None or q.ndim != 3 or q.shape[-1] < 2:
        return None
    quantile_slice = q[:, :, 1:] if q.shape[-1] >= 10 else q
    diffs = np.diff(quantile_slice, axis=-1)
    return round(float(np.mean(diffs < -1e-9)), 8)


def _p10_p90(q: np.ndarray | None, horizon_idx: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    if q is None or q.ndim != 3 or q.shape[0] == 0:
        return None, None
    h_idx = min(max(int(horizon_idx), 0), q.shape[1] - 1)
    if q.shape[-1] >= 10:
        # TimesFM 2.5 docs: index 0 is mean, then P10..P90.
        return q[:, h_idx, 1], q[:, h_idx, -1]
    if q.shape[-1] >= 9:
        return q[:, h_idx, 0], q[:, h_idx, -1]
    return None, None


def _memory_snapshot(started_at: float) -> dict[str, Any]:
    current, peak = tracemalloc.get_traced_memory()
    rss_mb = None
    try:
        import psutil

        rss_mb = round(float(psutil.Process().memory_info().rss) / (1024 * 1024), 3)
    except Exception:  # noqa: BLE001
        rss_mb = None
    vram_peak_mb = None
    try:
        import torch

        if torch.cuda.is_available():
            vram_peak_mb = round(float(torch.cuda.max_memory_allocated()) / (1024 * 1024), 3)
    except Exception:  # noqa: BLE001
        vram_peak_mb = None
    return {
        "latency_sec": round(time.perf_counter() - started_at, 3),
        "python_tracemalloc_current_mb": round(float(current) / (1024 * 1024), 3),
        "python_tracemalloc_peak_mb": round(float(peak) / (1024 * 1024), 3),
        "rss_mb": rss_mb,
        "vram_peak_mb": vram_peak_mb,
    }


def _build_rows(
    *,
    point_forecast: np.ndarray,
    quantiles: np.ndarray | None,
    window_dataset: Any,
    oos_take: np.ndarray,
    candidate_id: str,
    context_len: int,
    horizon_idx: int,
) -> list[dict[str, Any]]:
    point = np.asarray(point_forecast, dtype=float)
    forecast_last = point[:, horizon_idx]
    actual_last = window_dataset.y_oos[oos_take, horizon_idx]
    selected_oos_index = window_dataset.oos_index[oos_take]
    p10, p90 = _p10_p90(quantiles, horizon_idx)

    rows: list[dict[str, Any]] = []
    for row_idx, dataset_idx in enumerate(selected_oos_index):
        meta = window_dataset.meta[int(dataset_idx)]
        last_close = float(meta["last_close"])
        pred_price = float(forecast_last[row_idx])
        actual_price = float(actual_last[row_idx])
        pred_return = (pred_price - last_close) / max(last_close, 1e-9)
        actual_return = (actual_price - last_close) / max(last_close, 1e-9)
        q10 = _finite(p10[row_idx]) if p10 is not None else None
        q90 = _finite(p90[row_idx]) if p90 is not None else None
        rows.append({
            "candidate_id": candidate_id,
            "context_len": int(context_len),
            "symbol": meta.get("symbol"),
            "asof_date": meta.get("asof_date"),
            "target_date": meta.get("target_date"),
            "last_close": last_close,
            "forecast_price": pred_price,
            "actual_price": actual_price,
            "pred_return": pred_return,
            "actual_return": actual_return,
            "abs_error": abs(pred_price - actual_price),
            "abs_return_error": abs(pred_return - actual_return),
            "p10": q10,
            "p90": q90,
            "covered_p10_p90": (q10 <= actual_price <= q90) if q10 is not None and q90 is not None else None,
            "quantile_crossed": (q10 > q90) if q10 is not None and q90 is not None else None,
        })
    return rows


def _metrics(rows: list[dict[str, Any]], *, quantiles: np.ndarray | None) -> dict[str, Any]:
    pred_price = np.asarray([row["forecast_price"] for row in rows], dtype=float)
    actual_price = np.asarray([row["actual_price"] for row in rows], dtype=float)
    pred_return = np.asarray([row["pred_return"] for row in rows], dtype=float)
    actual_return = np.asarray([row["actual_return"] for row in rows], dtype=float)
    price_errors = np.abs(pred_price - actual_price).tolist()
    return_errors = np.abs(pred_return - actual_return).tolist()
    extreme_threshold = float(np.percentile(np.abs(actual_return), 90)) if len(actual_return) else 0.0
    extreme_mask = np.abs(actual_return) >= extreme_threshold
    covered = [row["covered_p10_p90"] for row in rows if row.get("covered_p10_p90") is not None]
    crossed = [row["quantile_crossed"] for row in rows if row.get("quantile_crossed") is not None]
    return {
        "rows": int(len(rows)),
        "oos_ic": round(float(rank_ic(pred_return, actual_return)), 8),
        "direction_accuracy": _direction_accuracy(pred_return, actual_return),
        "price_mae": _mean(price_errors),
        "price_rmse": _rmse(price_errors),
        "price_mape": _safe_mape(pred_price, actual_price),
        "price_smape": _safe_smape(pred_price, actual_price),
        "return_mae": _mean(return_errors),
        "return_rmse": _rmse(return_errors),
        "return_p50_abs_error": _percentile(return_errors, 50),
        "return_p90_abs_error": _percentile(return_errors, 90),
        "extreme_abs_return_threshold_p90": round(extreme_threshold, 8),
        "extreme_count": int(np.sum(extreme_mask)),
        "extreme_return_mae": _mean(np.abs(pred_return[extreme_mask] - actual_return[extreme_mask]).tolist()),
        "extreme_return_rmse": _rmse(np.abs(pred_return[extreme_mask] - actual_return[extreme_mask]).tolist()),
        "p10_p90_coverage": round(float(np.mean(covered)), 8) if covered else None,
        "p10_p90_crossing_rate": round(float(np.mean(crossed)), 8) if crossed else None,
        "quantile_monotonic_violation_rate": _monotonic_violation_rate(quantiles),
    }


def _load_model(candidate_id: str, *, model_id: str, max_context: int, max_horizon: int) -> tuple[Any, dict[str, Any]]:
    import timesfm

    if candidate_id == "TimesFM25":
        if not hasattr(timesfm, "TimesFM_2p5_200M_torch"):
            raise RuntimeError("installed timesfm package does not expose TimesFM_2p5_200M_torch")
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(model_id)
        model.compile(
            timesfm.ForecastConfig(
                max_context=max_context,
                max_horizon=max_horizon,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
        return model, {
            "class_name": "TimesFM_2p5_200M_torch",
            "checkpoint_path": model_id,
            "max_context": int(max_context),
            "max_horizon": int(max_horizon),
            "forecast_flags": {
                "normalize_inputs": True,
                "use_continuous_quantile_head": True,
                "force_flip_invariance": True,
                "infer_is_positive": True,
                "fix_quantile_crossing": True,
            },
        }

    if not hasattr(timesfm, "TimesFm"):
        raise RuntimeError("installed timesfm package does not expose TimesFm")
    try:
        import torch

        backend = "gpu" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        backend = "cpu"
    context_len = min(int(max_context), 2048)
    model = timesfm.TimesFm(
        hparams=timesfm.TimesFmHparams(
            backend=backend,
            per_core_batch_size=32,
            horizon_len=max_horizon,
            num_layers=50,
            use_positional_embedding=False,
            context_len=context_len,
        ),
        checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id=model_id),
    )
    return model, {
        "class_name": "TimesFm",
        "checkpoint_path": model_id,
        "backend": backend,
        "max_context": int(context_len),
        "max_horizon": int(max_horizon),
        "forecast_flags": {},
    }


def _forecast(model: Any, *, candidate_id: str, horizon: int, inputs: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray | None, str]:
    try:
        point, quantiles = model.forecast(horizon=horizon, inputs=inputs)
        return np.asarray(point, dtype=float), None if quantiles is None else np.asarray(quantiles, dtype=float), "horizon_inputs"
    except TypeError:
        freq = [0] * len(inputs)
        point, quantiles = model.forecast(inputs, freq=freq)
        return np.asarray(point, dtype=float), None if quantiles is None else np.asarray(quantiles, dtype=float), "inputs_freq"


def run_candidate(payload: dict[str, Any], *, candidate_id: str, contexts: list[int]) -> dict[str, Any]:
    started_at = time.perf_counter()
    tracemalloc.start()
    dataset_source = load_sequence_dataset(payload)
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or 5)
    max_horizon = int(payload.get("max_horizon") or payload.get("data_slice", {}).get("max_horizon") or max(256, pred_len))
    max_oos_windows = int(payload.get("max_oos_windows") or payload.get("data_slice", {}).get("max_oos_windows") or 512)
    model_id = str(
        payload.get("model_id")
        or payload.get("data_slice", {}).get("model_id")
        or (TIMESFM25_MODEL_ID if candidate_id == "TimesFM25" else TIMESFM20_MODEL_ID)
    )
    context_reports: list[dict[str, Any]] = []
    row_evidence: list[dict[str, Any]] = []
    model = None
    model_meta: dict[str, Any] | None = None
    loaded_context = None

    for context_len in contexts:
        window_dataset = build_sequence_window_dataset(
            dataset_source.records,
            seq_len=int(context_len),
            pred_len=pred_len,
            oos_ratio=float(payload.get("oos_ratio") or payload.get("data_slice", {}).get("oos_ratio") or 0.2),
        )
        if not window_dataset.report.get("lifecycle_ready"):
            context_reports.append({
                "candidate_id": candidate_id,
                "context_len": int(context_len),
                "status": "blocked",
                "blockers": ["sequence_dataset_not_lifecycle_ready"],
                "sequence_report": window_dataset.report,
            })
            continue
        oos_take = np.arange(len(window_dataset.X_oos))
        if len(oos_take) > max_oos_windows:
            oos_take = np.linspace(0, len(oos_take) - 1, max_oos_windows).astype(int)
        try:
            if model is None or loaded_context != context_len:
                requested_max_context = int(payload.get("max_context") or payload.get("data_slice", {}).get("max_context") or 0)
                compile_max_context = max(int(context_len), requested_max_context or 1024)
                model, model_meta = _load_model(
                    candidate_id,
                    model_id=model_id,
                    max_context=compile_max_context,
                    max_horizon=max_horizon,
                )
                loaded_context = context_len
            inputs = [np.asarray(row, dtype=np.float32) for row in window_dataset.X_oos[oos_take]]
            point, quantiles, forecast_interface = _forecast(model, candidate_id=candidate_id, horizon=pred_len, inputs=inputs)
            horizon_idx = min(pred_len, point.shape[1]) - 1
            rows = _build_rows(
                point_forecast=point,
                quantiles=quantiles,
                window_dataset=window_dataset,
                oos_take=oos_take,
                candidate_id=candidate_id,
                context_len=int(context_len),
                horizon_idx=horizon_idx,
            )
            row_evidence.extend(rows)
            context_reports.append({
                "candidate_id": candidate_id,
                "context_len": int(context_len),
                "status": "available",
                "model_id": model_id,
                "model_meta": model_meta,
                "forecast_interface": forecast_interface,
                "quantile_shape": list(quantiles.shape) if quantiles is not None else None,
                "point_shape": list(point.shape),
                "sequence_report": window_dataset.report,
                "max_oos_windows": max_oos_windows,
                "metrics": _metrics(rows, quantiles=quantiles),
            })
        except Exception as exc:  # noqa: BLE001
            context_reports.append({
                "candidate_id": candidate_id,
                "context_len": int(context_len),
                "status": "blocked",
                "blockers": [f"{type(exc).__name__}:{exc}"],
                "sequence_report": window_dataset.report,
            })

    memory = _memory_snapshot(started_at)
    tracemalloc.stop()
    return {
        "schema_version": "timesfm-migration-benchmark-v1",
        "status": "completed",
        "candidate_id": candidate_id,
        "model_id": model_id,
        "production_mutation_allowed": False,
        "promotion_allowed": False,
        "runtime": memory,
        "data_slice_report": data_slice_report(
            dataset=dataset_source,
            start_date=payload.get("start_date") or payload.get("data_slice", {}).get("start_date"),
            end_date=payload.get("end_date") or payload.get("data_slice", {}).get("end_date"),
        ),
        "contexts": context_reports,
        "row_evidence": row_evidence,
    }


def _context_by_len(report: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {
        int(row.get("context_len")): row
        for row in report.get("contexts", [])
        if isinstance(row, dict) and row.get("status") == "available"
    }


def _row_keys(report: dict[str, Any], context_len: int) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    for row in report.get("row_evidence", []):
        if not isinstance(row, dict) or int(row.get("context_len") or -1) != int(context_len):
            continue
        keys.add((str(row.get("symbol")), str(row.get("asof_date")), str(row.get("target_date"))))
    return keys


def compare_reports(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_ctx = _context_by_len(before)
    after_ctx = _context_by_len(after)
    comparisons: list[dict[str, Any]] = []
    for context_len in sorted(set(before_ctx) & set(after_ctx)):
        b_metrics = before_ctx[context_len].get("metrics") or {}
        a_metrics = after_ctx[context_len].get("metrics") or {}
        row: dict[str, Any] = {
            "context_len": context_len,
            "before_candidate_id": before.get("candidate_id"),
            "after_candidate_id": after.get("candidate_id"),
            "before_model_id": before.get("model_id"),
            "after_model_id": after.get("model_id"),
            "before_status": before_ctx[context_len].get("status"),
            "after_status": after_ctx[context_len].get("status"),
        }
        before_keys = _row_keys(before, context_len)
        after_keys = _row_keys(after, context_len)
        row["row_alignment"] = {
            "before_rows": len(before_keys),
            "after_rows": len(after_keys),
            "matched_rows": len(before_keys & after_keys),
            "same_batch": before_keys == after_keys and bool(before_keys),
        }
        for key in (
            "oos_ic",
            "direction_accuracy",
            "price_mae",
            "price_rmse",
            "price_mape",
            "price_smape",
            "return_mae",
            "return_rmse",
            "return_p90_abs_error",
            "extreme_return_mae",
            "extreme_return_rmse",
            "p10_p90_coverage",
            "p10_p90_crossing_rate",
            "quantile_monotonic_violation_rate",
        ):
            before_value = _finite(b_metrics.get(key))
            after_value = _finite(a_metrics.get(key))
            row[f"before_{key}"] = before_value
            row[f"after_{key}"] = after_value
            row[f"delta_{key}"] = round(after_value - before_value, 8) if before_value is not None and after_value is not None else None
        comparisons.append(row)
    return {
        "schema_version": "timesfm-migration-comparison-v1",
        "status": "completed",
        "production_mutation_allowed": False,
        "promotion_allowed": False,
        "comparison_policy": {
            "lower_is_better": ["price_mae", "price_rmse", "price_mape", "price_smape", "return_mae", "return_rmse", "return_p90_abs_error", "extreme_return_mae", "extreme_return_rmse", "p10_p90_crossing_rate", "quantile_monotonic_violation_rate"],
            "higher_is_better": ["oos_ic", "direction_accuracy", "p10_p90_coverage"],
        },
        "contexts": comparisons,
        "runtime": {
            "before": before.get("runtime"),
            "after": after.get("runtime"),
        },
    }


def _parse_contexts(raw: str | None) -> list[int]:
    if not raw:
        return list(DEFAULT_CONTEXTS)
    return [int(item.strip()) for item in raw.split(",") if item.strip()]


def _write_or_print(payload: dict[str, Any], output: str | None) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(text, encoding="utf-8")
    else:
        print(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run-candidate")
    run_parser.add_argument("--payload", required=True)
    run_parser.add_argument("--candidate", required=True, choices=["TimesFM", "TimesFM25"])
    run_parser.add_argument("--contexts", default=None, help="Comma-separated context lengths, e.g. 256,512,1024,2048")
    run_parser.add_argument("--output", default=None)

    compare_parser = sub.add_parser("compare")
    compare_parser.add_argument("--before", required=True)
    compare_parser.add_argument("--after", required=True)
    compare_parser.add_argument("--output", default=None)

    args = parser.parse_args()
    if args.command == "run-candidate":
        payload = json.loads(Path(args.payload).read_text(encoding="utf-8-sig"))
        report = run_candidate(payload, candidate_id=str(args.candidate), contexts=_parse_contexts(args.contexts))
        _write_or_print(report, args.output)
        return 0
    before = json.loads(Path(args.before).read_text(encoding="utf-8-sig"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8-sig"))
    _write_or_print(compare_reports(before, after), args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
