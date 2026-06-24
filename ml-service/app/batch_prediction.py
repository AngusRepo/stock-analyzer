"""Batch prediction use-case helpers.

This module gives Modal a coarse-grained prediction contract without changing
the single-stock runtime owner. It preserves the same error envelope as
``predict_single_stock`` so downstream pipeline behavior stays stable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import os
import time
from typing import Any

import numpy as np

PredictRequest: Any = None
predict_stock_v2: Any = None


@dataclass
class _FeatureBatchContext:
    req: Any
    x_latest: np.ndarray
    feature_names: list[str]
    rank_scores: dict[str, float] = field(default_factory=dict)
    model_errors: list[str] = field(default_factory=list)
    challenger_rank_scores: dict[str, float] = field(default_factory=dict)
    challenger_errors: list[str] = field(default_factory=list)


def _runtime():
    global PredictRequest, predict_stock_v2
    if PredictRequest is None:
        from .schemas import PredictRequest as _PredictRequest
        PredictRequest = _PredictRequest
    if predict_stock_v2 is None:
        from .prediction_runtime import predict_stock_v2 as _predict_stock_v2
        predict_stock_v2 = _predict_stock_v2
    return PredictRequest, predict_stock_v2


def _get_model_cache_stats() -> dict[str, int]:
    try:
        from .model_store import get_model_cache_stats

        return get_model_cache_stats()
    except Exception:
        return {}


def _get_ft_runtime_cache_stats() -> dict[str, int]:
    return {}


def _stats_delta(after: dict, before: dict) -> dict[str, int]:
    return {
        key: int(after.get(key, 0) or 0) - int(before.get(key, 0) or 0)
        for key in {"hits", "misses", "gcs_downloads"}
    }


def _true_batch_enabled() -> bool:
    return str(os.environ.get("PREDICT_BATCH_V2_TRUE_BATCH", "1")).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _is_real_runtime(request_cls: Any, predict_fn: Any) -> bool:
    """Avoid surprising tests or callers that monkeypatch the runtime boundary."""
    return (
        getattr(request_cls, "__module__", "").endswith(".schemas")
        and getattr(predict_fn, "__module__", "").endswith(".prediction_runtime")
    )


class ModelPoolUnavailable(RuntimeError):
    """Raised when model_pool.json cannot be loaded for batch governance."""


def _load_model_pool() -> dict:
    from .model_pool import load_pool
    from .prediction_runtime import _require_model_pool_contract

    pool = load_pool()
    try:
        _require_model_pool_contract(pool, stage="batch_predict")
    except Exception as exc:
        raise ModelPoolUnavailable(f"model_pool.json unavailable for batch model governance: {exc}") from exc
    return pool


def _get_pool_shadow_challenger_path(model_name: str, pool: dict | None) -> str | None:
    from .model_pool import get_shadow_challenger_path

    return get_shadow_challenger_path(model_name, pool=pool)


def _shadow_challenger_names(pool: dict | None) -> tuple[str, ...]:
    shadow_models = (pool or {}).get("shadow_models", {}) if pool else {}
    if isinstance(shadow_models, dict) and shadow_models:
        return tuple(name for name in (str(name) for name in shadow_models.keys()) if name == "ResidualMLP")
    return ("ResidualMLP",)


def _load_feature_artifact(model_name: str, explicit_path: str | None = None) -> tuple[Any, dict | None]:
    from .model_store import load_model

    return load_model(0, model_name, explicit_path=explicit_path)


def _build_feature_batch_context(req: Any) -> _FeatureBatchContext:
    from .features import build_feature_matrix, get_features

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices,
        req.indicators,
        chips_input,
        req.sentiment_scores,
        req.market_env,
        barrier_params=req.barrier_params or None,
        stock_meta=getattr(req, "stock_meta", None),
    )
    x, _y, feature_names = get_features(df, target_col="target_rank", allow_missing_target=True)
    if len(x) == 0:
        raise ValueError(f"Feature matrix empty for {req.symbol}")
    return _FeatureBatchContext(
        req=req,
        x_latest=x[-1].reshape(1, -1),
        feature_names=feature_names,
    )


def _align_latest_features(ctx: _FeatureBatchContext, meta: dict | None) -> np.ndarray:
    from .artifact_contract import ArtifactValidationError, validate_serving_feature_compatibility
    from .features import safe_float

    training_features = (meta or {}).get("feature_names", [])
    training_medians = (meta or {}).get("feature_medians", {})
    if training_features and training_features != ctx.feature_names:
        try:
            validate_serving_feature_compatibility(
                training_features=training_features,
                serving_features=ctx.feature_names,
                feature_medians=training_medians,
            )
        except ArtifactValidationError as exc:
            raise ValueError(f"artifact feature compatibility failed: {exc.report}") from exc
        pred_name_to_idx = {name: idx for idx, name in enumerate(ctx.feature_names)}
        defaults = np.array(
            [safe_float(training_medians.get(name), 0.0) for name in training_features],
            dtype=np.float32,
        ).reshape(1, -1)
        aligned = defaults.copy()
        for idx, fname in enumerate(training_features):
            if fname in pred_name_to_idx:
                aligned[0, idx] = float(ctx.x_latest[0, pred_name_to_idx[fname]])
        return aligned
    return ctx.x_latest


def _clip_rank(value: Any) -> float:
    return float(np.clip(float(value), 0.0, 1.0))


def _dict_or_empty(value: Any) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _safe_context_float(value: Any) -> float | None:
    if isinstance(value, str):
        mapped = {
            "low": 0.25,
            "normal": 0.40,
            "medium": 0.50,
            "moderate": 0.50,
            "high": 0.75,
            "extreme": 1.0,
        }.get(value.strip().lower())
        if mapped is not None:
            return mapped
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(out):
        return None
    return out


def _numeric_context(source: dict, fields: tuple[str, ...]) -> dict[str, float]:
    out: dict[str, float] = {}
    for field in fields:
        value = _safe_context_float(source.get(field))
        if value is not None:
            out[field] = value
    return out


def _first_context_record(req: Any, field: str, runtime_options: dict, stock_meta: dict) -> dict:
    for source in (
        getattr(req, field, None),
        runtime_options.get(field),
        stock_meta.get(field),
    ):
        if isinstance(source, dict) and source:
            return dict(source)
    return {}


def _latest_chip_flow_record(chips: Any) -> dict[str, float]:
    if not isinstance(chips, list):
        return {}
    aliases = {
        "foreign_net": ("foreign_net", "foreign_buy_sell", "foreign_investor_net"),
        "trust_net": ("trust_net", "investment_trust_net"),
        "dealer_net": ("dealer_net", "dealer_buy_sell"),
        "margin_balance": ("margin_balance", "margin"),
        "short_balance": ("short_balance", "short"),
    }
    out: dict[str, float] = {}
    for row in reversed(chips):
        if not isinstance(row, dict):
            continue
        for target, keys in aliases.items():
            if target in out:
                continue
            for key in keys:
                value = _safe_context_float(row.get(key))
                if value is not None:
                    out[target] = value
                    break
        if len(out) == len(aliases):
            break
    institutional_parts = [
        out.get("foreign_net"),
        out.get("trust_net"),
        out.get("dealer_net"),
    ]
    if any(value is not None for value in institutional_parts):
        out["institutional_net"] = float(sum(value or 0.0 for value in institutional_parts))
    return out


def _build_gnn_similarity_context_record(req: Any) -> dict[str, Any]:
    runtime_options = _dict_or_empty(getattr(req, "runtime_options", None))
    stock_meta = _dict_or_empty(getattr(req, "stock_meta", None))
    market_env = _dict_or_empty(getattr(req, "market_env", None))
    sector_key = (
        stock_meta.get("sector")
        or stock_meta.get("sector_name")
        or stock_meta.get("industry")
        or stock_meta.get("industry_name")
        or stock_meta.get("market_segment")
    )
    return {
        "symbol": str(getattr(req, "symbol", "") or ""),
        "strategy_affinity_vector": _first_context_record(req, "strategy_affinity_vector", runtime_options, stock_meta),
        "family_affinity_vector": _first_context_record(req, "family_affinity_vector", runtime_options, stock_meta),
        "strategy_weak_label_vector": _first_context_record(req, "strategy_weak_label_vector", runtime_options, stock_meta),
        "strategy_hit_vector": _first_context_record(req, "strategy_hit_vector", runtime_options, stock_meta),
        "strategy_position_weight_vector": _first_context_record(req, "strategy_position_weight_vector", runtime_options, stock_meta),
        "strategy_overlap_vector": _first_context_record(req, "strategy_overlap_vector", runtime_options, stock_meta),
        "sector_factor": {
            **_numeric_context(
                stock_meta,
                (
                    "sector_encoded",
                    "market_cap_bucket",
                    "avg_volume_bucket",
                    "sector_peer_return_1d",
                    "sector_peer_return_5d",
                    "stock_vs_sector",
                ),
            ),
            "sector_key": str(sector_key or ""),
        },
        "finlab_chip_flow": _latest_chip_flow_record(getattr(req, "chips", None)),
        "regime": _numeric_context(
            market_env,
            (
                "risk_score",
                "risk_level",
                "us_sox_return",
                "us_gspc_return",
                "us_vix",
                "advance_ratio",
                "bull_alignment_pct",
                "revenue_yoy",
                "margin_balance",
                "short_ratio",
                "retail_pct",
            ),
        ),
    }


def _record_feature_score(
    ctx: _FeatureBatchContext,
    model_name: str,
    score: Any,
    *,
    challenger: bool = False,
) -> None:
    target = ctx.challenger_rank_scores if challenger else ctx.rank_scores
    target[model_name] = _clip_rank(score)


def _record_feature_error(
    ctx: _FeatureBatchContext,
    message: str,
    *,
    challenger: bool = False,
) -> None:
    target = ctx.challenger_errors if challenger else ctx.model_errors
    target.append(message)


def _apply_artifact_batch_predictions(
    contexts: list[_FeatureBatchContext],
    model_name: str,
    model_obj: Any,
    meta: dict | None,
    *,
    challenger: bool = False,
) -> None:
    rows: list[tuple[_FeatureBatchContext, np.ndarray]] = []
    for ctx in contexts:
        try:
            rows.append((ctx, _align_latest_features(ctx, meta)))
        except Exception as exc:  # noqa: BLE001 - keep one bad symbol/model local.
            prefix = "challenger " if challenger else ""
            _record_feature_error(ctx, f"{model_name}: {prefix}{exc}", challenger=challenger)
    if not rows:
        return

    x_batch = np.vstack([row for _ctx, row in rows])
    try:
        preds = np.asarray(model_obj.predict(x_batch)).reshape(-1)
        for (ctx, _row), pred in zip(rows, preds):
            _record_feature_score(ctx, model_name, pred, challenger=challenger)
    except Exception as batch_exc:  # noqa: BLE001
        prefix = "challenger " if challenger else ""
        for ctx, x_row in rows:
            try:
                pred = np.asarray(model_obj.predict(x_row)).reshape(-1)[0]
                _record_feature_score(ctx, model_name, pred, challenger=challenger)
            except Exception as row_exc:  # noqa: BLE001
                _record_feature_error(
                    ctx,
                    f"{model_name}: {prefix}{type(batch_exc).__name__}: {batch_exc}; row retry failed: {row_exc}",
                    challenger=challenger,
                )


def _apply_gnn_batch_context_predictions(
    contexts: list[_FeatureBatchContext],
    pool: dict | None,
    model_status: dict[str, str],
) -> None:
    try:
        status = _require_model_status(model_status, "GNN")
    except ModelPoolUnavailable as exc:
        for ctx in contexts:
            _record_feature_error(ctx, f"GNN: {exc}")
        return
    if status in ("retired", "challenger"):
        for ctx in contexts:
            _record_feature_error(ctx, f"GNN: skipped by model_pool status={status}")
        return
    try:
        from .gnn_batch_runtime import load_graphsage_artifact, predict_graphsage_scores

        artifact = load_graphsage_artifact(pool=pool)
        rows: list[tuple[_FeatureBatchContext, np.ndarray]] = []
        for ctx in contexts:
            try:
                rows.append((ctx, _align_latest_features(ctx, artifact.metadata)))
            except Exception as exc:  # noqa: BLE001
                _record_feature_error(ctx, f"GNN: {exc}")
        if not rows:
            return

        node_features = np.vstack([row for _ctx, row in rows])
        price_series = [getattr(ctx.req, "prices", []) or [] for ctx, _row in rows]
        context_records = [_build_gnn_similarity_context_record(ctx.req) for ctx, _row in rows]
        scores, graph_report = predict_graphsage_scores(
            artifact,
            node_features=node_features,
            price_series=price_series,
            context_records=context_records,
        )
        for (ctx, _row), score in zip(rows, scores):
            _record_feature_score(ctx, "GNN", score)
        for ctx in contexts:
            runtime_options = dict(getattr(ctx.req, "runtime_options", {}) or {})
            runtime_options["gnn_batch_context"] = graph_report
            ctx.req.runtime_options = runtime_options
    except Exception as exc:  # noqa: BLE001
        for ctx in contexts:
            _record_feature_error(ctx, f"GNN: {exc}")


def _apply_tabm_torch_batch_predictions(
    contexts: list[_FeatureBatchContext],
    pool: dict | None,
    model_status: dict[str, str],
) -> None:
    try:
        status = _require_model_status(model_status, "TabM")
    except ModelPoolUnavailable as exc:
        for ctx in contexts:
            _record_feature_error(ctx, f"TabM: {exc}")
        return
    if status in ("retired", "challenger"):
        for ctx in contexts:
            _record_feature_error(ctx, f"TabM: skipped by model_pool status={status}")
        return
    try:
        from .tabm_batch_runtime import load_tabm_artifact, predict_tabm_scores

        artifact = load_tabm_artifact(pool=pool)
        rows: list[tuple[_FeatureBatchContext, np.ndarray]] = []
        for ctx in contexts:
            try:
                rows.append((ctx, _align_latest_features(ctx, artifact.metadata)))
            except Exception as exc:  # noqa: BLE001
                _record_feature_error(ctx, f"TabM: {exc}")
        if not rows:
            return

        x_batch = np.vstack([row for _ctx, row in rows])
        scores = predict_tabm_scores(artifact, features=x_batch)
        for (ctx, _row), score in zip(rows, scores):
            _record_feature_score(ctx, "TabM", score)
    except Exception as exc:  # noqa: BLE001
        for ctx in contexts:
            _record_feature_error(ctx, f"TabM: {exc}")


def _summarize_result_errors(results: list[dict | None], *, limit: int = 5) -> dict:
    counts: dict[str, int] = {}
    for item in results or []:
        if not isinstance(item, dict) or not item.get("error"):
            continue
        message = str(item.get("error") or "").strip() or "unknown error"
        counts[message] = counts.get(message, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return {
        "error_count": sum(counts.values()),
        "unique_error_count": len(counts),
        "top_errors": [
            {"error": message, "count": count}
            for message, count in ranked[: max(1, int(limit))]
        ],
    }


def _model_pool_status(pool: dict | None) -> dict[str, str]:
    from .prediction_runtime import _MODEL_NAMES_V2, _require_model_pool_contract

    pool_models, formal_slots = _require_model_pool_contract(pool, stage="batch_model_pool_status")

    def resolve(name: str) -> str:
        if isinstance(pool_models.get(name), dict):
            status = str((pool_models.get(name) or {}).get("status") or "").strip()
            if not status:
                raise ModelPoolUnavailable(f"model_pool status missing for {name}")
            return status
        slot = formal_slots.get(name) if isinstance(formal_slots, dict) else None
        if isinstance(slot, dict):
            slot_status = str(slot.get("status") or "").strip()
            try:
                vote_weight = float(slot.get("vote_weight") or 0.0)
            except (TypeError, ValueError):
                vote_weight = 0.0
            direct_prediction = bool(slot.get("direct_prediction")) or vote_weight > 0.0
            if direct_prediction and slot_status in {"production_adapter_active", "active"}:
                return "retired"
            return "retired"
        raise ModelPoolUnavailable(f"model_pool status missing for {name}")

    return {name: resolve(name) for name in _MODEL_NAMES_V2}


def _require_model_status(model_status: dict[str, str], model_name: str) -> str:
    status = str((model_status or {}).get(model_name) or "").strip()
    if not status:
        raise ModelPoolUnavailable(f"model_pool status missing for {model_name}")
    return status


def _build_feature_model_batch_runtime_overrides(requests: list[Any]) -> list[dict]:
    from .prediction_runtime import (
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
        _BATCH_CHALLENGER_RANK_SCORES_KEY,
        _BATCH_FEATURE_MODEL_ERRORS_KEY,
        _BATCH_FEATURE_RANK_SCORES_KEY,
        _FEATURE_MODEL_NAMES_V2,
    )

    contexts = [_build_feature_batch_context(req) for req in requests]
    pool = _load_model_pool()
    model_status = _model_pool_status(pool)

    for model_name in _FEATURE_MODEL_NAMES_V2:
        if model_name == "GNN":
            continue
        if model_name == "TabM":
            _apply_tabm_torch_batch_predictions(contexts, pool, model_status)
            continue
        try:
            status = _require_model_status(model_status, model_name)
        except ModelPoolUnavailable as exc:
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: {exc}")
            continue
        if status in ("retired", "challenger"):
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: skipped by model_pool status={status}")
            continue
        try:
            model_obj, meta = _load_feature_artifact(model_name)
        except Exception as exc:  # noqa: BLE001
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: {exc}")
            continue
        if model_obj is None:
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: not found in GCS")
            continue
        _apply_artifact_batch_predictions(contexts, model_name, model_obj, meta)

    if pool:
        for model_name in _shadow_challenger_names(pool):
            try:
                shadow_path = _get_pool_shadow_challenger_path(model_name, pool=pool)
            except Exception as exc:  # noqa: BLE001
                for ctx in contexts:
                    _record_feature_error(ctx, f"{model_name}: shadow {exc}", challenger=True)
                continue
            if not shadow_path:
                continue
            try:
                model_obj, meta = _load_feature_artifact(model_name, explicit_path=shadow_path)
            except Exception as exc:  # noqa: BLE001
                for ctx in contexts:
                    _record_feature_error(ctx, f"{model_name}: shadow {exc}", challenger=True)
                continue
            if model_obj is None:
                for ctx in contexts:
                    _record_feature_error(
                        ctx,
                        f"{model_name}: shadow artifact missing at {shadow_path}",
                        challenger=True,
                    )
                continue
            _apply_artifact_batch_predictions(contexts, model_name, model_obj, meta, challenger=True)

    return [
        {
            _BATCH_FEATURE_RANK_SCORES_KEY: dict(ctx.rank_scores),
            _BATCH_FEATURE_MODEL_ERRORS_KEY: list(ctx.model_errors),
            _BATCH_CHALLENGER_RANK_SCORES_KEY: dict(ctx.challenger_rank_scores),
            _BATCH_CHALLENGER_MODEL_ERRORS_KEY: list(ctx.challenger_errors),
        }
        for ctx in contexts
    ]


def predict_gnn_graphsage_batch(payloads: list[dict]) -> dict:
    """Run GNN GraphSAGE over the complete candidate universe.

    This endpoint intentionally lives outside predict_batch_v2 chunking because
    GraphSAGE needs cross-stock batch context to build graph edges.
    """
    request_cls, _predict_fn = _runtime()
    contexts: list[_FeatureBatchContext] = []
    results: list[dict | None] = [None] * len(payloads or [])
    for idx, payload in enumerate(payloads or []):
        try:
            req = request_cls(**payload)
            contexts.append(_build_feature_batch_context(req))
        except Exception as exc:  # noqa: BLE001
            results[idx] = _error_result(payload, exc)

    if contexts:
        pool = _load_model_pool()
        model_status = _model_pool_status(pool)
        _apply_gnn_batch_context_predictions(contexts, pool, model_status)

        context_idx = 0
        for idx, current in enumerate(results):
            if current is not None:
                continue
            ctx = contexts[context_idx]
            context_idx += 1
            score = ctx.rank_scores.get("GNN")
            if score is None:
                results[idx] = {
                    "stock_id": getattr(ctx.req, "stock_id", 0),
                    "symbol": getattr(ctx.req, "symbol", "?"),
                    "error": "; ".join(ctx.model_errors or ["GNN: no score emitted"]),
                }
                continue
            graph_report = (getattr(ctx.req, "runtime_options", {}) or {}).get("gnn_batch_context") or {}
            results[idx] = {
                "stock_id": getattr(ctx.req, "stock_id", 0),
                "symbol": getattr(ctx.req, "symbol", "?"),
                "rank_score": _clip_rank(score),
                "confidence": 0.5,
                "model": "GNN",
                "runtime": "graphsage_full_universe",
                "graph_context": graph_report,
                "source": "gnn_graphsage_universal_predict",
            }

    output = [item for item in results if item is not None]
    error_summary = _summarize_result_errors(output)
    return {
        "results": output,
        "n_input": len(payloads or []),
        "n_success": sum(1 for item in output if not item.get("error")),
        "n_error": sum(1 for item in output if item.get("error")),
        "error_summary": error_summary,
        "metrics": {
            "runtime": "graphsage_full_universe",
            "contract": "gnn_graphsage_universal_predict_v1",
            "error_summary": error_summary,
        },
    }


def _copy_request_with_runtime_overrides(req: Any, overrides: dict) -> Any:
    runtime_options = dict(getattr(req, "runtime_options", {}) or {})
    runtime_options.update(overrides)
    if hasattr(req, "model_copy"):
        return req.model_copy(update={"runtime_options": runtime_options})
    copied = req.__class__(**getattr(req, "__dict__", {}))
    copied.runtime_options = runtime_options
    return copied


def _error_result(payload: dict, exc: Exception) -> dict:
    return {
        "stock_id": payload.get("stock_id", 0),
        "symbol": payload.get("symbol", "?"),
        "error": f"{type(exc).__name__}: {exc}",
        "signal": "NO_SIGNAL",
        "direction": "neutral",
        "confidence": 0.0,
    }


def _predict_serial(payloads: list[dict], request_cls: Any, predict_fn: Any) -> list[dict]:
    results: list[dict] = []
    for payload in payloads or []:
        try:
            req = request_cls(**payload)
            results.append(predict_fn(req))
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the batch.
            results.append(_error_result(payload, exc))
    return results


def preload_batch_artifacts(payloads: list[dict]) -> dict:
    """Warm container-local artifact cache once before the per-symbol loop."""
    if not payloads:
        return {
            "active_attempted": 0,
            "active_loaded": 0,
            "challenger_attempted": 0,
            "challenger_loaded": 0,
            "errors": [],
        }

    from .prediction_runtime import _FEATURE_MODEL_NAMES_V2

    pool = None
    try:
        from .model_pool import load_pool
        pool = load_pool()
    except Exception:
        pool = None
    active_models = [name for name in _FEATURE_MODEL_NAMES_V2 if name not in {"GNN", "TabM"}]
    errors: list[str] = []
    active_loaded = 0
    challenger_loaded = 0
    challenger_attempted = 0
    tabm_attempted = 0

    try:
        from .model_store import load_model
    except Exception as exc:  # noqa: BLE001 - telemetry must not block prediction.
        return {
            "active_attempted": len(active_models),
            "active_loaded": 0,
            "challenger_attempted": 0,
            "challenger_loaded": 0,
            "errors": [f"preload_import_failed: {type(exc).__name__}: {exc}"],
        }

    for model_name in active_models:
        try:
            model_obj, _meta = load_model(0, model_name)
            if model_obj is not None:
                active_loaded += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model_name}: {type(exc).__name__}: {exc}")

    try:
        model_status = _model_pool_status(pool)
        if _require_model_status(model_status, "TabM") not in {"retired", "challenger"}:
            tabm_attempted = 1
            from .tabm_batch_runtime import load_tabm_artifact

            load_tabm_artifact(pool=pool)
            active_loaded += 1
    except Exception as exc:  # noqa: BLE001 - preload telemetry only.
        errors.append(f"TabM: {type(exc).__name__}: {exc}")

    return {
        "active_attempted": len(active_models) + tabm_attempted,
        "active_loaded": active_loaded,
        "challenger_attempted": challenger_attempted,
        "challenger_loaded": challenger_loaded,
        "errors": errors,
    }


def predict_stock_v2_batch(payloads: list[dict]) -> list[dict]:
    request_cls, predict_fn = _runtime()
    if not payloads:
        return []
    if not _true_batch_enabled() or not _is_real_runtime(request_cls, predict_fn):
        return _predict_serial(payloads, request_cls, predict_fn)

    requests_by_position: dict[int, Any] = {}
    results: list[dict | None] = [None] * len(payloads)
    for idx, payload in enumerate(payloads):
        try:
            requests_by_position[idx] = request_cls(**payload)
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the batch.
            results[idx] = _error_result(payload, exc)

    valid_positions = list(requests_by_position)
    if valid_positions:
        valid_requests = [requests_by_position[idx] for idx in valid_positions]
        try:
            overrides_by_request = _build_feature_model_batch_runtime_overrides(valid_requests)
            valid_requests = [
                _copy_request_with_runtime_overrides(req, overrides)
                for req, overrides in zip(valid_requests, overrides_by_request)
            ]
        except Exception:
            # The serial owner remains the correctness retry path for unexpected
            # artifact/schema drift. Per-symbol error wrapping still applies.
            valid_requests = [requests_by_position[idx] for idx in valid_positions]

        for idx, req in zip(valid_positions, valid_requests):
            try:
                results[idx] = predict_fn(req)
            except Exception as exc:  # noqa: BLE001
                results[idx] = _error_result(payloads[idx], exc)

    return [result for result in results if result is not None]


def predict_stock_v2_batch_with_metrics(payloads: list[dict]) -> dict:
    """Run batch prediction and expose container cache telemetry."""
    before = _get_model_cache_stats()
    ft_before = _get_ft_runtime_cache_stats()
    preload_t0 = time.time()
    preload = preload_batch_artifacts(payloads or [])
    preload_elapsed_s = round(time.time() - preload_t0, 3)
    after_preload = _get_model_cache_stats()
    predict_t0 = time.time()
    results = predict_stock_v2_batch(payloads)
    predict_elapsed_s = round(time.time() - predict_t0, 3)
    after = _get_model_cache_stats()
    ft_after = _get_ft_runtime_cache_stats()
    total_delta = _stats_delta(after, before)
    return {
        "results": results,
        "metrics": {
            "batch": {
                "n_input": len(payloads or []),
                "n_error": sum(1 for r in results if r.get("error")),
                "contract": "modal_predict_batch_v2_true_batch",
            },
            "preload": preload,
            "timing": {
                "preload_elapsed_s": preload_elapsed_s,
                "predict_loop_elapsed_s": predict_elapsed_s,
                "total_elapsed_s": round(preload_elapsed_s + predict_elapsed_s, 3),
            },
            "model_cache": {
                **total_delta,
                "preload_delta": _stats_delta(after_preload, before),
                "total_delta": total_delta,
                "after": after,
            },
            "ft_runtime_cache": {
                "hits": int(ft_after.get("hits", 0) or 0) - int(ft_before.get("hits", 0) or 0),
                "misses": int(ft_after.get("misses", 0) or 0) - int(ft_before.get("misses", 0) or 0),
                "after": ft_after,
            },
        },
    }
