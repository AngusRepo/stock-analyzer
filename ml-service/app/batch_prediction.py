"""Batch prediction use-case helpers.

This module gives Modal a coarse-grained prediction contract without changing
the single-stock runtime owner. It preserves the same error envelope as
``predict_single_stock`` so downstream pipeline behavior stays stable.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
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
    if (
        isinstance(pool, dict)
        and str(pool.get("source_of_truth") or "") == "frozen_pipeline_modal_serving_manifest"
    ):
        return tuple(name for name in shadow_models if name == "ResidualMLP")
    if isinstance(shadow_models, dict) and shadow_models:
        return tuple(name for name in (str(name) for name in shadow_models.keys()) if name == "ResidualMLP")
    return ("ResidualMLP",)


def _load_feature_artifact(
    model_name: str,
    explicit_path: str | None = None,
    *,
    explicit_metadata_path: str | None = None,
    expected_version: str | None = None,
    expected_artifact_id: str | None = None,
    expected_checksum: str | None = None,
    require_governed_artifact: bool = False,
) -> tuple[Any, dict | None]:
    from .model_store import load_model

    return load_model(
        0,
        model_name,
        explicit_path=explicit_path,
        explicit_metadata_path=explicit_metadata_path,
        expected_version=expected_version,
        expected_artifact_id=expected_artifact_id,
        expected_checksum=expected_checksum,
        require_governed_artifact=require_governed_artifact,
    )


def _active_model_artifact_identity(model_name: str, pool: dict) -> dict[str, str]:
    """Read the complete artifact identity from the frozen pool snapshot."""
    entry = (pool.get("models") or {}).get(model_name) if isinstance(pool, dict) else None
    if not isinstance(entry, dict):
        raise ModelPoolUnavailable(f"frozen model_pool entry missing for {model_name}")
    identity = {
        "artifact_path": str(entry.get("gcs_path") or "").strip(),
        "metadata_path": str(entry.get("metadata_path") or "").strip(),
        "version": str(entry.get("version") or "").strip(),
        "artifact_id": str(entry.get("serving_artifact_id") or "").strip(),
        "checksum": str(entry.get("checksum") or "").strip().lower(),
    }
    missing = [key for key, value in identity.items() if not value]
    if missing:
        raise ModelPoolUnavailable(
            f"frozen artifact identity incomplete for {model_name}:"
            + ",".join(missing)
        )
    return identity


def _shadow_model_artifact_identity(model_name: str, pool: dict) -> dict[str, str]:
    entry = (
        (pool.get("shadow_models") or {}).get(model_name)
        if isinstance(pool, dict)
        else None
    )
    if not isinstance(entry, dict):
        raise ModelPoolUnavailable(f"frozen shadow entry missing for {model_name}")
    identity = {
        "artifact_path": str(entry.get("gcs_path") or "").strip(),
        "metadata_path": str(entry.get("metadata_path") or "").strip(),
        "version": str(entry.get("version") or "").strip(),
        "artifact_id": str(entry.get("serving_artifact_id") or "").strip(),
        "checksum": str(entry.get("checksum") or "").strip().lower(),
    }
    missing = [key for key, value in identity.items() if not value]
    if missing:
        raise ModelPoolUnavailable(
            f"frozen shadow identity incomplete for {model_name}:"
            + ",".join(missing)
        )
    return identity


def _active8_shadow_candidate_names(pool: dict | None) -> tuple[str, ...]:
    candidates = (
        (pool or {}).get("active8_shadow_candidates", {})
        if isinstance(pool, dict)
        else {}
    )
    if not isinstance(candidates, dict):
        return ()
    return tuple(sorted(
        str(name)
        for name, entry in candidates.items()
        if isinstance(entry, dict)
        and str(entry.get("status") or "") == "challenger"
        and entry.get("production_effect") is False
        and float(entry.get("vote_weight") or 0.0) == 0.0
    ))


def _active8_shadow_candidate_entry(model_name: str, pool: dict) -> dict:
    entry = (
        (pool.get("active8_shadow_candidates") or {}).get(model_name)
        if isinstance(pool, dict)
        else None
    )
    if not isinstance(entry, dict):
        raise ModelPoolUnavailable(
            f"frozen Active-8 shadow entry missing for {model_name}"
        )
    for field in (
        "version", "gcs_path", "metadata_path", "serving_artifact_id", "checksum",
    ):
        if not str(entry.get(field) or "").strip():
            raise ModelPoolUnavailable(
                f"frozen Active-8 shadow identity incomplete for {model_name}:{field}"
            )
    if (
        str(entry.get("status") or "") != "challenger"
        or entry.get("production_effect") is not False
        or float(entry.get("vote_weight") or 0.0) != 0.0
    ):
        raise ModelPoolUnavailable(
            f"frozen Active-8 shadow policy invalid for {model_name}"
        )
    return entry


def _active8_shadow_candidate_pool(model_name: str, pool: dict) -> dict:
    entry = dict(_active8_shadow_candidate_entry(model_name, pool))
    entry["status"] = "active"
    entry["effective_status"] = "active"
    return {
        "schema_version": "model_pool_v2",
        "source_of_truth": "frozen_pipeline_modal_serving_manifest",
        "models": {model_name: entry},
    }


def _require_runtime_artifact_identity(model_name: str, artifact: Any, pool: dict) -> None:
    identity = _active_model_artifact_identity(model_name, pool)
    source_path = str(getattr(artifact, "source_path", "") or "").strip()
    version = str(getattr(artifact, "version", "") or "").strip()
    metadata = getattr(artifact, "metadata", None)
    metadata = metadata if isinstance(metadata, dict) else {}
    checksum = str(
        metadata.get("artifact_checksum") or metadata.get("checksum") or ""
    ).strip().lower()
    integrity = metadata.get("artifact_integrity_report")
    integrity = integrity if isinstance(integrity, dict) else {}
    if (
        source_path != identity["artifact_path"]
        or version != identity["version"]
        or checksum != identity["checksum"]
        or integrity.get("status") != "ok"
        or str(integrity.get("expected_checksum") or "").strip().lower()
        != identity["checksum"]
    ):
        raise ModelPoolUnavailable(
            f"runtime artifact identity mismatch for {model_name}"
        )


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
        # Production artifacts must support matrix inference. Per-symbol retry
        # hides an incompatible serving contract and creates unbounded CPU work.
        prefix = "challenger " if challenger else ""
        message = (
            f"{model_name}: {prefix}batch_contract_failed:"
            f"{type(batch_exc).__name__}: {batch_exc}"
        )
        for ctx, _x_row in rows:
            _record_feature_error(ctx, message, challenger=challenger)


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
        _require_runtime_artifact_identity("TabM", artifact, pool or {})
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


def _apply_active8_shadow_feature_predictions(
    contexts: list[_FeatureBatchContext],
    pool: dict,
) -> None:
    """Run selected registry candidates with zero production effect."""
    for model_name in _active8_shadow_candidate_names(pool):
        if model_name in {"DLinear", "PatchTST", "iTransformer"}:
            continue
        try:
            entry = _active8_shadow_candidate_entry(model_name, pool)
            if model_name in {"LightGBM", "XGBoost", "ExtraTrees"}:
                model_obj, meta = _load_feature_artifact(
                    model_name,
                    explicit_path=str(entry["gcs_path"]),
                    explicit_metadata_path=str(entry["metadata_path"]),
                    expected_version=str(entry["version"]),
                    expected_artifact_id=str(entry["serving_artifact_id"]),
                    expected_checksum=str(entry["checksum"]),
                    require_governed_artifact=True,
                )
                if model_obj is None:
                    raise RuntimeError("governed candidate artifact not found")
                _apply_artifact_batch_predictions(
                    contexts,
                    model_name,
                    model_obj,
                    meta,
                    challenger=True,
                )
                continue

            candidate_pool = _active8_shadow_candidate_pool(model_name, pool)
            if model_name == "TabM":
                from .tabm_batch_runtime import (
                    load_tabm_artifact,
                    predict_tabm_scores,
                )

                artifact = load_tabm_artifact(pool=candidate_pool)
                rows: list[tuple[_FeatureBatchContext, np.ndarray]] = []
                for ctx in contexts:
                    try:
                        rows.append((ctx, _align_latest_features(ctx, artifact.metadata)))
                    except Exception as exc:  # noqa: BLE001
                        _record_feature_error(
                            ctx,
                            f"{model_name}: shadow {exc}",
                            challenger=True,
                        )
                if rows:
                    scores = predict_tabm_scores(
                        artifact,
                        features=np.vstack([row for _ctx, row in rows]),
                    )
                    for (ctx, _row), score in zip(rows, scores):
                        _record_feature_score(
                            ctx,
                            model_name,
                            score,
                            challenger=True,
                        )
                continue

            if model_name == "GNN":
                from .gnn_batch_runtime import (
                    load_graphsage_artifact,
                    predict_graphsage_scores,
                )

                artifact = load_graphsage_artifact(pool=candidate_pool)
                rows = []
                for ctx in contexts:
                    try:
                        rows.append((ctx, _align_latest_features(ctx, artifact.metadata)))
                    except Exception as exc:  # noqa: BLE001
                        _record_feature_error(
                            ctx,
                            f"{model_name}: shadow {exc}",
                            challenger=True,
                        )
                if rows:
                    scores, _graph_report = predict_graphsage_scores(
                        artifact,
                        node_features=np.vstack([row for _ctx, row in rows]),
                        price_series=[
                            getattr(ctx.req, "prices", []) or []
                            for ctx, _row in rows
                        ],
                        context_records=[
                            _build_gnn_similarity_context_record(ctx.req)
                            for ctx, _row in rows
                        ],
                    )
                    for (ctx, _row), score in zip(rows, scores):
                        _record_feature_score(
                            ctx,
                            model_name,
                            score,
                            challenger=True,
                        )
                continue
            raise RuntimeError("unsupported Active-8 shadow model family")
        except Exception as exc:  # noqa: BLE001 - candidate cannot block champions.
            for ctx in contexts:
                _record_feature_error(
                    ctx,
                    f"{model_name}: Active-8 shadow {type(exc).__name__}: {exc}",
                    challenger=True,
                )


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
            entry = pool_models.get(name) or {}
            status = str(entry.get("status") or "").strip()
            if not status:
                raise ModelPoolUnavailable(f"model_pool status missing for {name}")
            if entry.get("serving_eligible") is False or str(entry.get("serving_block_reason") or "").strip():
                return "challenger"
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


def _active_feature_core_models(pool: dict) -> tuple[str, ...]:
    from .prediction_runtime import _FEATURE_MODEL_NAMES_V2

    model_status = _model_pool_status(pool)
    return tuple(
        name
        for name in _FEATURE_MODEL_NAMES_V2
        if name != "GNN"
        and _require_model_status(model_status, name) in {"active", "degraded"}
    )


def _feature_core_coverage_error(override: dict) -> str | None:
    from .prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY, _BATCH_MODEL_POOL_KEY

    pool = override.get(_BATCH_MODEL_POOL_KEY)
    scores = override.get(_BATCH_FEATURE_RANK_SCORES_KEY)
    scores = scores if isinstance(scores, dict) else {}
    missing_or_invalid = [
        name
        for name in _active_feature_core_models(pool)
        if name not in scores
        or not np.isfinite(float(scores.get(name)))
    ]
    if not missing_or_invalid:
        return None
    return (
        "active_feature_model_coverage_incomplete:missing_or_invalid="
        + ",".join(missing_or_invalid)
    )


def _build_feature_model_batch_runtime_overrides(
    requests: list[Any],
    *,
    pool_snapshot: dict | None = None,
) -> list[dict]:
    from .prediction_runtime import (
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
        _BATCH_CHALLENGER_RANK_SCORES_KEY,
        _BATCH_FEATURE_CONTEXT_KEY,
        _BATCH_FEATURE_MODEL_ERRORS_KEY,
        _BATCH_FEATURE_RANK_SCORES_KEY,
        _BATCH_IC_WEIGHTS_KEY,
        _BATCH_MODEL_POOL_KEY,
        _BATCH_RANK_STACKER_KEY,
        _BATCH_RANK_STACKER_AUDIT_KEY,
        _FEATURE_MODEL_NAMES_V2,
        _normalize_market_segment_for_serving,
    )
    from .ensemble import _extract_model_pool_ic

    contexts = [_build_feature_batch_context(req) for req in requests]
    pool = pool_snapshot if pool_snapshot is not None else _load_model_pool()
    model_status = _model_pool_status(pool)
    rank_stacker_bundle, rank_stacker_audit = _resolve_rank_stacker_runtime(pool)
    ic_weights_by_segment = {
        segment: _extract_model_pool_ic(pool, market_segment=segment)
        for segment in {
            _normalize_market_segment_for_serving(ctx.req)
            for ctx in contexts
        }
    }

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
            identity = _active_model_artifact_identity(model_name, pool)
            model_obj, meta = _load_feature_artifact(
                model_name,
                explicit_path=identity["artifact_path"],
                explicit_metadata_path=identity["metadata_path"],
                expected_version=identity["version"],
                expected_artifact_id=identity["artifact_id"],
                expected_checksum=identity["checksum"],
                require_governed_artifact=True,
            )
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
                if (
                    str(pool.get("source_of_truth") or "")
                    == "frozen_pipeline_modal_serving_manifest"
                ):
                    identity = _shadow_model_artifact_identity(model_name, pool)
                    shadow_path = identity["artifact_path"]
                    model_obj, meta = _load_feature_artifact(
                        model_name,
                        explicit_path=identity["artifact_path"],
                        explicit_metadata_path=identity["metadata_path"],
                        expected_version=identity["version"],
                        expected_artifact_id=identity["artifact_id"],
                        expected_checksum=identity["checksum"],
                        require_governed_artifact=True,
                    )
                else:
                    shadow_path = _get_pool_shadow_challenger_path(model_name, pool=pool)
                    if not shadow_path:
                        continue
                    model_obj, meta = _load_feature_artifact(
                        model_name,
                        explicit_path=shadow_path,
                    )
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

    _apply_active8_shadow_feature_predictions(contexts, pool)

    return [
        {
            _BATCH_FEATURE_CONTEXT_KEY: {
                "x_latest": ctx.x_latest,
                "feature_names": list(ctx.feature_names),
            },
            _BATCH_FEATURE_RANK_SCORES_KEY: dict(ctx.rank_scores),
            _BATCH_FEATURE_MODEL_ERRORS_KEY: list(ctx.model_errors),
            _BATCH_CHALLENGER_RANK_SCORES_KEY: dict(ctx.challenger_rank_scores),
            _BATCH_CHALLENGER_MODEL_ERRORS_KEY: list(ctx.challenger_errors),
            _BATCH_MODEL_POOL_KEY: pool,
            _BATCH_IC_WEIGHTS_KEY: dict(
                ic_weights_by_segment[_normalize_market_segment_for_serving(ctx.req)]
            ),
            _BATCH_RANK_STACKER_KEY: rank_stacker_bundle,
            _BATCH_RANK_STACKER_AUDIT_KEY: rank_stacker_audit,
        }
        for ctx in contexts
    ]


def predict_gnn_graphsage_batch(
    payloads: list[dict],
    *,
    pool_snapshot: dict | None = None,
) -> dict:
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
        pool = pool_snapshot if pool_snapshot is not None else _load_model_pool()
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


def _resolve_rank_stacker_runtime(
    pool: dict[str, Any],
) -> tuple[dict | None, dict[str, Any]]:
    if str(pool.get("source_of_truth") or "") != "frozen_pipeline_modal_serving_manifest":
        return None, {
            "status": "ungoverned",
            "effective_status": "excluded",
            "reason": "not_in_frozen_governance",
        }
    snapshot = pool.get("rank_stacker")
    if not isinstance(snapshot, dict):
        raise ModelPoolUnavailable("frozen rank_stacker audit missing")
    effective_status = str(snapshot.get("effective_status") or "").strip()
    reason = str(snapshot.get("reason") or "").strip()
    if effective_status != "excluded" or not reason:
        raise ModelPoolUnavailable(
            "frozen rank_stacker must remain excluded until reject-only validation"
        )
    return None, {
        "status": str(snapshot.get("status") or "unknown"),
        "effective_status": effective_status,
        "reason": reason,
        "artifact_path": str(snapshot.get("artifact_path") or "") or None,
        "metadata_path": str(snapshot.get("metadata_path") or "") or None,
        "artifact_identity": (
            dict(snapshot.get("artifact_identity"))
            if isinstance(snapshot.get("artifact_identity"), dict)
            else None
        ),
    }


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


def preload_batch_artifacts(
    payloads: list[dict],
    *,
    pool_snapshot: dict | None = None,
) -> dict:
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

    try:
        from .model_pool import load_pool

        pool = pool_snapshot if pool_snapshot is not None else load_pool()
        model_status = _model_pool_status(pool)
    except Exception as exc:  # noqa: BLE001 - telemetry reports typed serving failure.
        return {
            "active_attempted": 0,
            "active_loaded": 0,
            "challenger_attempted": 0,
            "challenger_loaded": 0,
            "errors": [f"model_pool_resolution_failed: {type(exc).__name__}: {exc}"],
        }
    active_models = [
        name
        for name in _FEATURE_MODEL_NAMES_V2
        if name not in {"GNN", "TabM"}
        and _require_model_status(model_status, name) not in {"retired", "challenger"}
    ]
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
            identity = _active_model_artifact_identity(model_name, pool)
            model_obj, _meta = load_model(
                0,
                model_name,
                explicit_path=identity["artifact_path"],
                explicit_metadata_path=identity["metadata_path"],
                expected_version=identity["version"],
                expected_artifact_id=identity["artifact_id"],
                expected_checksum=identity["checksum"],
                require_governed_artifact=True,
            )
            if model_obj is not None:
                active_loaded += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model_name}: {type(exc).__name__}: {exc}")

    try:
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


def predict_stock_v2_batch(
    payloads: list[dict],
    *,
    pool_snapshot: dict | None = None,
) -> list[dict]:
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
            if pool_snapshot is None:
                overrides_by_request = _build_feature_model_batch_runtime_overrides(valid_requests)
            else:
                overrides_by_request = _build_feature_model_batch_runtime_overrides(
                    valid_requests,
                    pool_snapshot=pool_snapshot,
                )
            if len(overrides_by_request) != len(valid_requests):
                raise RuntimeError(
                    "batch override cardinality mismatch: "
                    f"{len(overrides_by_request)} != {len(valid_requests)}"
                )
            ready_pairs: list[tuple[int, Any]] = []
            for idx, req, overrides in zip(
                valid_positions,
                valid_requests,
                overrides_by_request,
            ):
                coverage_error = _feature_core_coverage_error(overrides)
                if coverage_error:
                    results[idx] = _error_result(
                        payloads[idx],
                        RuntimeError(coverage_error),
                    )
                    continue
                ready_pairs.append((
                    idx,
                    _copy_request_with_runtime_overrides(req, overrides),
                ))
            valid_positions = [idx for idx, _req in ready_pairs]
            valid_requests = [req for _idx, req in ready_pairs]
        except Exception as exc:
            error = RuntimeError(
                f"batch_override_build_failed:{type(exc).__name__}:{exc}"
            )
            for idx in valid_positions:
                results[idx] = _error_result(payloads[idx], error)
            print(
                f"[BatchPrediction] override_build_failed count={len(valid_positions)} "
                f"error={type(exc).__name__}:{exc}",
                flush=True,
            )
            return [result for result in results if result is not None]

        if not valid_requests:
            return [result for result in results if result is not None]

        finalize_started = time.time()
        finalize_total = len(valid_requests)
        workers = max(
            1,
            min(
                8,
                finalize_total,
                int(os.environ.get("PREDICT_BATCH_V2_FINALIZE_WORKERS", "4")),
            ),
        )
        print(
            f"[BatchPrediction] finalize_start count={finalize_total} "
            f"mode=parallel_shared_context workers={workers}",
            flush=True,
        )
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(predict_fn, req): idx
                for idx, req in zip(valid_positions, valid_requests)
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                idx = futures[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:  # noqa: BLE001
                    results[idx] = _error_result(payloads[idx], exc)
                if completed == finalize_total or completed % 16 == 0:
                    print(
                        f"[BatchPrediction] finalize_progress completed={completed}/{finalize_total} "
                        f"elapsed_s={time.time() - finalize_started:.3f}",
                        flush=True,
                    )

    return [result for result in results if result is not None]


def predict_stock_v2_batch_with_metrics(
    payloads: list[dict],
    *,
    pool_snapshot: dict | None = None,
) -> dict:
    """Run batch prediction and expose container cache telemetry."""
    before = _get_model_cache_stats()
    ft_before = _get_ft_runtime_cache_stats()
    preload_t0 = time.time()
    if pool_snapshot is None:
        preload = preload_batch_artifacts(payloads or [])
    else:
        preload = preload_batch_artifacts(
            payloads or [],
            pool_snapshot=pool_snapshot,
        )
    preload_elapsed_s = round(time.time() - preload_t0, 3)
    after_preload = _get_model_cache_stats()
    predict_t0 = time.time()
    if pool_snapshot is None:
        results = predict_stock_v2_batch(payloads)
    else:
        results = predict_stock_v2_batch(
            payloads,
            pool_snapshot=pool_snapshot,
        )
    predict_elapsed_s = round(time.time() - predict_t0, 3)
    after = _get_model_cache_stats()
    ft_after = _get_ft_runtime_cache_stats()
    total_delta = _stats_delta(after, before)
    coverage_error_count = sum(
        1
        for row in results
        if "active_feature_model_coverage_incomplete"
        in str(row.get("error") or "")
    )
    return {
        "results": results,
        "metrics": {
            "batch": {
                "n_input": len(payloads or []),
                "n_error": sum(1 for r in results if r.get("error")),
                "contract": "modal_predict_batch_v2_shared_serving_context_v4",
                "finalize_mode": "parallel_signal_only_shared_serving_context",
                "active_feature_model_coverage": {
                    "status": "pass" if coverage_error_count == 0 else "fail",
                    "error_count": coverage_error_count,
                },
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


def predict_stock_v2_chunked_with_metrics(
    payloads: list[dict],
    *,
    chunk_size: int,
    batch_contract: dict | None = None,
    pool_snapshot: dict | None = None,
) -> dict:
    """Freeze one governed pool snapshot across every chunk in a Modal bundle."""
    chunk_size = max(1, int(chunk_size))
    chunks = [
        payloads[index:index + chunk_size]
        for index in range(0, len(payloads), chunk_size)
    ]
    results: list[dict] = []
    batch_responses: list[dict] = []
    resolved_pool = (
        pool_snapshot
        if pool_snapshot is not None
        else _load_model_pool()
    ) if payloads else pool_snapshot

    def chunk_error_rows(chunk: list[dict], reason: str) -> list[dict]:
        return [
            {
                "stock_id": item.get("stock_id", 0) if isinstance(item, dict) else 0,
                "symbol": item.get("symbol", "?") if isinstance(item, dict) else "?",
                "error": reason,
                "signal": "NO_SIGNAL",
                "direction": "neutral",
                "confidence": 0.0,
            }
            for item in chunk
        ]

    for chunk in chunks:
        try:
            batch = predict_stock_v2_batch_with_metrics(
                chunk,
                pool_snapshot=resolved_pool,
            )
            batch_responses.append(batch)
            chunk_results = batch.get("results") if isinstance(batch, dict) else None
            if isinstance(chunk_results, list) and len(chunk_results) == len(chunk):
                results.extend(chunk_results)
            else:
                results.extend(chunk_error_rows(
                    chunk,
                    "predict_batch_v2 returned invalid payload",
                ))
        except Exception as exc:  # noqa: BLE001
            reason = f"predict_batch_v2 chunk error: {type(exc).__name__}: {exc}"
            results.extend(chunk_error_rows(chunk, reason))

    return {
        "results": results,
        "n_input": len(payloads),
        "n_error": sum(1 for row in results if row.get("error")),
        "chunk_count": len(chunks),
        "chunk_size": chunk_size,
        "batch_contract": batch_contract or {},
        "batch_metrics": [
            batch.get("metrics") or {}
            for batch in batch_responses
        ],
    }
