"""
recommendation_service.py — Compute recommendations + write D1
2026-04-07 LangGraph A+B refactor

Direct port of worker/src/lib/dailyRecommendation.ts:540-758 core logic:
  - filter SELL/NO_SIGNAL
  - compute ml_score (0-30)
  - hybrid ranking promotion (Sprint 3 P0-4 Architecture C)
  - build template reason / watchPoints
  - bulk D1 update via d1_client.batch_execute
"""
from __future__ import annotations
import json
import logging
import math
from numbers import Integral, Real
from typing import Any, Optional

from services import d1_client
from services._predictions_schema import (
    COL_STOCK_ID,
    COL_MODEL_NAME,
    COL_GENERATED_AT,
    COL_PREDICTION_DATE,
    COL_HORIZON,
    COL_DIRECTION_ACCURACY,
    COL_FORECAST_DATA,
    COL_ENTRY_PRICE,
    COL_STOP_LOSS,
    COL_TARGET1,
    COL_TARGET2,
    COL_TRADE_SIGNAL,
    COL_FEATURE_VERSION,
    COL_SIGNAL_RAW,
    INSERT_PREDICTIONS_SQL,
)
from services.alpha_framework import (
    apply_alpha_context,
    build_alpha_context,
    normalize_alpha_policy,
    regime_aware_allocate,
)
from services.active9_dataset_policy import gnn_return_history_lookback
from services.fundamental_quality import score_fundamental_quality
from services.market_segment_policy import normalize_segment, policy_for_segment
from services.portfolio_allocation import allocate_sparse_tangent

logger = logging.getLogger(__name__)

D1_IN_CLAUSE_CHUNK_SIZE = 80


def _dedupe_preserve_order(values: list[Any]) -> list[Any]:
    seen: set[Any] = set()
    out: list[Any] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _chunked(values: list[Any], size: int = D1_IN_CLAUSE_CHUNK_SIZE) -> list[list[Any]]:
    if size <= 0:
        raise ValueError("chunk size must be positive")
    unique_values = _dedupe_preserve_order(values)
    return [unique_values[i:i + size] for i in range(0, len(unique_values), size)]


def _prediction_delete_date_expr(run_date: str | None) -> tuple[str, list[Any]]:
    """Align prediction dedupe with the pipeline business date when available."""
    if run_date:
        return f"{COL_PREDICTION_DATE} = ?", [run_date]
    return f"{COL_PREDICTION_DATE} = date('now', '+8 hours')", []


def _require_prediction_feature_version(symbol: str, data: dict) -> str:
    feature_version = str(data.get("feature_version") or "").strip()
    if not feature_version:
        raise ValueError(
            f"missing_feature_version_contract: symbol={symbol} "
            "prediction writer requires canonical feature_version"
        )
    return feature_version


def prune_predictions_outside_universe(stock_ids: list[int], run_date: str) -> int:
    """Remove same-date prediction rows that no longer belong to the current V2 universe."""
    safe_ids = {int(stock_id) for stock_id in stock_ids if stock_id}
    if not safe_ids:
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ?",
            [run_date],
            timeout=60,
        )
        return int(((result or {}).get("meta") or {}).get("changes") or 0)

    existing_rows = d1_client.query(
        f"SELECT DISTINCT {COL_STOCK_ID} AS stock_id FROM predictions WHERE {COL_PREDICTION_DATE} = ?",
        [run_date],
        timeout=60,
    )
    stale_ids = sorted({
        int(row["stock_id"])
        for row in existing_rows or []
        if row.get("stock_id") is not None and int(row["stock_id"]) not in safe_ids
    })
    deleted = 0
    for chunk in _chunked(stale_ids):
        placeholders = ",".join("?" for _ in chunk)
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ? AND {COL_STOCK_ID} IN ({placeholders})",
            [run_date, *chunk],
            timeout=60,
        )
        deleted += int(((result or {}).get("meta") or {}).get("changes") or 0)
    return deleted


def _sanitize_non_finite(value: Any) -> tuple[Any, int]:
    """Convert NaN/Inf values to None before JSON encoding / HTTP transport."""
    if value is None or isinstance(value, (str, bool)):
        return value, 0
    if isinstance(value, Integral):
        return int(value), 0
    if isinstance(value, Real):
        numeric = float(value)
        if not math.isfinite(numeric):
            return None, 1
        return numeric, 0
    if isinstance(value, dict):
        sanitized: dict[Any, Any] = {}
        replaced = 0
        for key, nested in value.items():
            sanitized_value, nested_replaced = _sanitize_non_finite(nested)
            sanitized[key] = sanitized_value
            replaced += nested_replaced
        return sanitized, replaced
    if isinstance(value, (list, tuple, set)):
        sanitized_list: list[Any] = []
        replaced = 0
        for nested in value:
            sanitized_value, nested_replaced = _sanitize_non_finite(nested)
            sanitized_list.append(sanitized_value)
            replaced += nested_replaced
        return sanitized_list, replaced
    return value, 0


def _enrich_stock_meta_with_segment_policy(stock_meta: dict | None) -> dict:
    """Attach segment calibration/parity metadata and enforce execution hard gates."""
    meta = dict(stock_meta or {})
    segment = normalize_segment(meta.get("market_segment") or meta.get("market"))
    policy = policy_for_segment(segment)
    lane = str(meta.get("recommendation_lane") or "").strip() or policy.recommendation_lane
    if not policy.eligible_for_execution:
        lane = policy.recommendation_lane
    eligible_for_execution = bool(policy.eligible_for_execution and lane == "tradable")

    meta.update({
        "market_segment": segment,
        "recommendation_lane": lane,
        "eligible_for_ml": bool(meta.get("eligible_for_ml", policy.eligible_for_ml)),
        "eligible_for_execution": eligible_for_execution,
        "eligible_for_pending_buy": eligible_for_execution,
        "segment_serving_mode": policy.serving_mode,
        "segment_model_pool_scope": policy.model_pool_scope,
        "segment_calibration_scope": policy.calibration_scope,
        "segment_calibration_artifact_prefix": policy.calibration_artifact_prefix,
        "train_serve_parity_required": policy.train_serve_parity_required,
        "segment_min_ic_samples": policy.min_ic_samples,
        "segment_min_active_days": policy.min_active_days,
    })
    return meta


def _state_space_overlay_payload(data: dict) -> dict[str, Any] | None:
    """Persist state-space overlays for shadow attribution, not alpha voting."""
    overlays: dict[str, Any] = {}
    for source_key, output_key in (
        ("kalman_filter", "kalman_filter"),
        ("markov_switching", "markov_switching"),
    ):
        value = data.get(source_key)
        if isinstance(value, dict):
            overlays[output_key] = value
    if not overlays:
        return None
    return {
        "schema_version": "state-space-overlays-v1",
        **overlays,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ML score calculation (port from dailyRecommendation.ts:558-568)
# ─────────────────────────────────────────────────────────────────────────────

def calculate_ml_score(prediction: dict, raw_prediction: dict | None = None) -> float:
    """Compute ml_score 0-30 from actual model evidence.

    Ranking/top-K promotion is an execution/recommendation policy, not a model
    vote. If lifecycle weighting has no positive contributors, keep the row
    eligible for downstream T2/debate via signal, but do not inflate ML score.
    """
    if not prediction:
        return 0.0
    source = str(prediction.get("signal_source") or "")
    ev2 = (raw_prediction or {}).get("ensemble_v2") or {}
    if ev2:
        weight_total = float(ev2.get("weight_total") or 0.0)
        contributors = ev2.get("contributing_models") or []
        ev2_reason = str(ev2.get("reason") or "")
        if weight_total <= 0 or ev2_reason == "no_positive_lifecycle_weight":
            return 0.0
    sig = (prediction.get("signal") or "").upper()
    score = 0.0
    if "STRONG_BUY" in sig:
        score += 25
    elif "BUY" in sig:
        score += 18
    elif sig == "HOLD":
        score += 8
    score += (prediction.get("confidence") or 0) * 10
    fc = prediction.get("forecast_pct") or 0
    if fc > 0.03:
        score += 5
    elif fc > 0.01:
        score += 2
    score = max(0.0, min(30.0, score))
    return _round1(score)


def _effective_prediction_view(ml: dict | None, use_ensemble_v2: bool = True) -> dict:
    """Normalize recommendation-facing ML fields to a single source of truth.

    When ensemble_v2 is enabled and present, downstream scoring/reasoning/storage
    should read signal/confidence/forecast from ensemble_v2 instead of the legacy
    rank_to_signal path. This keeps filter, score, and displayed signal aligned.
    """
    if not ml:
        return {
            "signal": None,
            "confidence": 0.0,
            "forecast_pct": None,
            "forecast_pct_source": "missing",
            "signal_source": "missing",
            "signal_raw": None,
        }

    legacy_signal = ml.get("signal")
    legacy_conf = (ml.get("confidence") if ml.get("confidence") is not None else 0.0) or 0.0
    legacy_forecast = (ml.get("forecast_pct") if ml.get("forecast_pct") is not None else 0.0) or 0.0

    if use_ensemble_v2:
        ev2 = ml.get("ensemble_v2") or {}
        if ev2.get("signal"):
            confidence = ev2.get("confidence") if ev2.get("confidence") is not None else legacy_conf
            return {
                "signal": ev2.get("signal"),
                "confidence": confidence,
                "forecast_pct": ev2.get("forecast_pct"),
                "forecast_pct_source": ev2.get("forecast_pct_source") or "ensemble_v2",
                "signal_source": ev2.get("signal_source") or "ensemble_v2",
                "signal_raw": ev2.get("signal_raw") or legacy_signal,
            }

    return {
        "signal": legacy_signal,
        "confidence": legacy_conf,
        "forecast_pct": legacy_forecast,
        "forecast_pct_source": "legacy",
        "signal_source": "legacy",
        "signal_raw": legacy_signal,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Filter + score (port from dailyRecommendation.ts:541-613)
# ─────────────────────────────────────────────────────────────────────────────

def _effective_signal(ml: dict | None, use_ensemble_v2: bool = True) -> str | None:
    """ML_POOL Plan A migration helper — prefer ensemble_v2.signal over legacy signal.

    Returns the signal string (uppercase) used for downstream BUY/SELL filter.
    If ensemble_v2 absent or use_ensemble_v2=False → falls back to legacy
    feature-model rank_to_signal output. When time-series models have
    no IC data yet, ensemble_v2 weight for them = 0 → ensemble_v2.signal is
    mathematically equivalent to legacy signal, so migration is no-op until
    IC tracker accumulates time-series IC (Stage 2 cron, ~3-4 weeks).
    """
    eff = _effective_prediction_view(ml, use_ensemble_v2=use_ensemble_v2)
    return (eff.get("signal") or "").upper() or None


def _is_use_ensemble_v2() -> bool:
    """Read trading:config.mlPool.useEnsembleV2 (default True). KV override."""
    try:
        from services.trading_config_loader import load_merged_trading_config
        tcfg = load_merged_trading_config()
        ml_pool_cfg = tcfg.get("mlPool", {}) or {}
        v = ml_pool_cfg.get("useEnsembleV2")
        return True if v is None else bool(v)
    except Exception:
        return True


def _sorted_payload_rows(payload: dict, key: str) -> list[dict]:
    rows = [row for row in (payload.get(key) or []) if isinstance(row, dict)]
    if any(row.get("date") for row in rows):
        return sorted(rows, key=lambda row: str(row.get("date") or ""))
    return rows


def build_ml_vote_summary(ml: dict | None, eff_ml: dict, legacy_counts: dict[str, int]) -> str:
    """Build recommendation-facing ML text from the same source used for scoring."""
    signal = str(eff_ml.get("signal") or "").upper()
    source = str(eff_ml.get("signal_source") or "")
    forecast_raw = eff_ml.get("forecast_pct")
    forecast_text = (
        "預期報酬校準不足"
        if forecast_raw is None
        else f"{float(forecast_raw) * 100:+.1f}%"
    )
    ev2 = (ml or {}).get("ensemble_v2") or {}

    contributors = ev2.get("contributing_models") or []
    if ev2 and float(ev2.get("weight_total") or 0.0) <= 0:
        return "V2 模型池暫無正 IC 權重，先以觀望處理，等待 verify/IC 樣本補齊"
    if contributors:
        label = "看多" if "BUY" in signal else "觀望" if signal == "HOLD" else "偏空"
        return f"V2 模型池{label}（{len(contributors)} 模型有權重，校準預期 {forecast_text}）"

    total = legacy_counts.get("total", 0)
    up = legacy_counts.get("up", 0)
    down = legacy_counts.get("down", 0)
    if total <= 0:
        return "ML 資料不足"
    if "BUY" in signal:
        return f"ML 看多（{up}/{total} 看漲，校準預期 {forecast_text}）"
    if signal == "HOLD":
        if up > down:
            return f"ML 觀望（{up}/{total} 偏多但共識未達門檻）"
        if down > up:
            return f"ML 觀望（{down}/{total} 偏空，暫不追價）"
        return f"ML 觀望（多空分歧 {up}/{down}）"
    return "ML 偏空"


def _forecast_fraction_to_pct(raw: Any) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return round(value * 100.0, 4)


def build_ml_vote_summary_data(ml: dict | None, legacy_counts: dict[str, int]) -> dict[str, Any]:
    """Structured ML vote evidence for UI/OBS; text reasons are derived elsewhere."""
    ev2 = (ml or {}).get("ensemble_v2") or {}
    tracked = [
        "XGBoost", "ExtraTrees", "LightGBM",
        "TabM", "GNN",
        "DLinear", "PatchTST", "iTransformer", "TimesFM",
    ]
    weights = ev2.get("weights") if isinstance(ev2.get("weights"), dict) else {}
    active_weight_count = 0
    for name, value in weights.items():
        if name not in tracked:
            continue
        numeric = _sanitize_non_finite(value)[0]
        if isinstance(numeric, Real) and float(numeric) > 0:
            active_weight_count += 1
    zero_weight_models = [
        name for name in tracked
        if name in weights and _sanitize_non_finite(weights.get(name))[0] in (0, 0.0, None)
    ]
    thresholds = ev2.get("rank_signal_thresholds") if isinstance(ev2.get("rank_signal_thresholds"), dict) else {}
    diagnostics = ev2.get("ic_weight_diagnostics") if isinstance(ev2.get("ic_weight_diagnostics"), dict) else {}
    validation_blocked_models = [
        name for name, detail in diagnostics.items()
        if name in tracked
        and isinstance(detail, dict)
        and str(detail.get("validation_status") or "").upper() == "FAIL"
    ]

    model_scores: dict[str, float] = {}
    rank_scores = (ml or {}).get("rank_scores") or {}
    if isinstance(rank_scores, dict):
        for name in ["XGBoost", "ExtraTrees", "LightGBM", "TabM", "GNN"]:
            try:
                if rank_scores.get(name) is not None:
                    model_scores[name] = float(rank_scores[name])
            except (TypeError, ValueError):
                continue
    for src_key, model_name in (
        ("dlinear", "DLinear"),
        ("patchtst", "PatchTST"),
        ("itransformer", "iTransformer"),
        ("timesfm", "TimesFM"),
    ):
        sig = (ml or {}).get(src_key) or {}
        try:
            if sig.get("forecast_pct") is not None:
                model_scores[model_name] = 1.0 / (1.0 + math.exp(-float(sig["forecast_pct"]) * 12.0))
        except (TypeError, ValueError, OverflowError):
            continue

    if model_scores:
        bullish = sum(1 for value in model_scores.values() if value >= 0.55)
        bearish = sum(1 for value in model_scores.values() if value <= 0.45)
        flat = max(0, len(model_scores) - bullish - bearish)
        raw_forecast_pct = ev2.get("forecast_pct")
        return {
            "bullish": bullish,
            "bearish": bearish,
            "flat": flat,
            "reported": len(model_scores),
            "missing": max(0, len(tracked) - len(model_scores)),
            "total": len(tracked),
            "forecast_pct": raw_forecast_pct,
            "forecastPct": _forecast_fraction_to_pct(raw_forecast_pct),
            "forecastPctSource": ev2.get("forecast_pct_source"),
            "activeWeightCount": active_weight_count,
            "zeroWeightModels": zero_weight_models,
            "thresholds": {
                "bullish": thresholds.get("buyThreshold"),
                "bearish": thresholds.get("sellThreshold"),
                "strongBullish": thresholds.get("strongBuyThreshold"),
                "strongBearish": thresholds.get("strongSellThreshold"),
            } if thresholds else None,
            "icWeightScope": ev2.get("ic_weight_scope"),
            "validationBlockedModels": validation_blocked_models,
            "source": ev2.get("signal_source") or (ml or {}).get("signal_source") or "unknown",
            "signalRaw": ev2.get("signal_raw") or (ml or {}).get("signal_raw"),
            "contributingModels": [
                name for name in (ev2.get("contributing_models") or [])
                if name in tracked
            ],
            "familyVote": ev2.get("family_vote") if isinstance(ev2.get("family_vote"), dict) else None,
        }

    models = (ml or {}).get("models") or []
    if isinstance(models, dict):
        iterable = list(models.values())
    elif isinstance(models, list):
        iterable = models
    else:
        iterable = []

    bullish = bearish = flat = 0
    for model in iterable:
        if not isinstance(model, dict):
            continue
        direction = str(model.get("direction") or model.get("signal") or "").lower()
        if "up" in direction or "buy" in direction or "bull" in direction:
            bullish += 1
        elif "down" in direction or "sell" in direction or "bear" in direction:
            bearish += 1
        else:
            flat += 1

    reported = bullish + bearish + flat
    if reported == 0:
        bullish = int(legacy_counts.get("up", 0) or 0)
        bearish = int(legacy_counts.get("down", 0) or 0)
        reported = int(legacy_counts.get("total", 0) or 0)
        flat = max(0, reported - bullish - bearish)

    total = max(8, reported)
    raw_forecast_pct = ev2.get("forecast_pct")
    return {
        "bullish": bullish,
        "bearish": bearish,
        "flat": flat,
        "reported": reported,
        "missing": max(0, total - reported),
        "total": total,
        "forecast_pct": raw_forecast_pct,
        "forecastPct": _forecast_fraction_to_pct(raw_forecast_pct),
        "forecastPctSource": ev2.get("forecast_pct_source"),
        "activeWeightCount": active_weight_count,
        "zeroWeightModels": zero_weight_models,
        "thresholds": {
            "bullish": thresholds.get("buyThreshold"),
            "bearish": thresholds.get("sellThreshold"),
            "strongBullish": thresholds.get("strongBuyThreshold"),
            "strongBearish": thresholds.get("strongSellThreshold"),
        } if thresholds else None,
        "icWeightScope": ev2.get("ic_weight_scope"),
        "validationBlockedModels": validation_blocked_models,
        "source": ev2.get("signal_source") or (ml or {}).get("signal_source") or "unknown",
        "signalRaw": ev2.get("signal_raw") or (ml or {}).get("signal_raw"),
        "contributingModels": ev2.get("contributing_models") or [],
        "familyVote": ev2.get("family_vote") if isinstance(ev2.get("family_vote"), dict) else None,
    }


def _build_alpha_adjustment_details(alpha_context: dict[str, Any], alpha_policy: dict | None = None) -> list[dict[str, Any]]:
    if not isinstance(alpha_context, dict):
        return []
    bucket = alpha_context.get("edge_bucket")
    regime_weight = alpha_context.get("regime_weight")
    risk_overlay = alpha_context.get("risk_overlay") or {}
    risk_flags = risk_overlay.get("flags") or []
    scoring = normalize_alpha_policy(alpha_policy)["scoring"]
    bucket_bonus = _float_or_none(scoring["bucket_bonus"].get(str(bucket))) if bucket else None
    regime_delta = None
    if regime_weight is not None:
        regime_delta = (float(regime_weight) - 1.0) * scoring["regime_weight_impact"]
    risk_penalty = float(risk_overlay.get("penalty") or 0.0) * scoring["overlay_penalty_impact"]
    details: list[dict[str, Any]] = []
    if bucket_bonus is not None:
        details.append({
            "key": "bucket_bonus",
            "label": "Edge bucket",
            "value": round(bucket_bonus, 2),
            "explain": "策略型態基礎加分，例如突破/波動擴張通常比防守累積更積極。",
        })
    if regime_delta is not None:
        details.append({
            "key": "regime_weight",
            "label": "Regime weight",
            "value": round(regime_delta, 2),
            "explain": "目前大盤 regime 對這種策略型態的順逆風調整。",
        })
    if risk_penalty:
        flag_text = ", ".join(str(flag) for flag in risk_flags) if risk_flags else "risk_overlay"
        details.append({
            "key": "risk_overlay",
            "label": "Risk overlay",
            "value": -round(risk_penalty, 2),
            "flags": risk_flags,
            "explain": f"風控扣分，觸發旗標：{flag_text}。",
        })
    return details


SCORE_V2_VERSION = "score_v2"
SCORE_V2_WEIGHTS = {
    "mlEdge": 25,
    "chipFlow": 25,
    "technicalStructure": 25,
    "fundamentalQuality": 20,
    "newsTheme": 5,
}


def _score_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _parse_score_components_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        payload = value
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
        payload = parsed if isinstance(parsed, dict) else None
    else:
        payload = None
    if not (isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION):
        return None
    return payload


def _round1(value: float) -> float:
    return math.floor(float(value) * 10 + 0.5) / 10


def _clamp_score(value: Any, maximum: float) -> float:
    return _round1(max(0.0, min(float(maximum), _score_number(value))))


def _rescale_score(value: Any, old_max: float, new_max: float) -> float:
    if old_max <= 0:
        return 0.0
    return _clamp_score((_score_number(value) / old_max) * new_max, new_max)


def _first_float(*values: Any) -> float | None:
    for value in values:
        parsed = _float_or_none(value)
        if parsed is not None:
            return parsed
    return None


def _score_v2_seed_inputs(row: dict) -> dict[str, float]:
    seeds = row.get("score_seed_inputs")
    if not isinstance(seeds, dict):
        seeds = row.get("seedComponents")
    if isinstance(seeds, dict):
        return {
            "chipFlowSeed40": _score_number(seeds.get("chipFlowSeed40")),
            "technicalSeed30": _score_number(seeds.get("technicalSeed30")),
            "screenerMomentumSeed20": _score_number(seeds.get("screenerMomentumSeed20")),
            "mlEdgeSeed30": _score_number(seeds.get("mlEdgeSeed30")),
            "personaAlphaSeed": _score_number(seeds.get("personaAlphaSeed")),
        }
    raise ValueError("Score V2 seed inputs required: missing score_seed_inputs")


def _score_v2_seed_inputs_from_payload(payload: dict[str, Any] | None, *, ml_score: float) -> dict[str, float] | None:
    if not payload:
        return None
    seeds = payload.get("seedComponents")
    if isinstance(seeds, dict):
        return {
            "chipFlowSeed40": _score_number(seeds.get("chipFlowSeed40")),
            "technicalSeed30": _score_number(seeds.get("technicalSeed30")),
            "screenerMomentumSeed20": _score_number(seeds.get("screenerMomentumSeed20")),
            "mlEdgeSeed30": ml_score,
            "personaAlphaSeed": 0.0,
        }
    components = payload.get("components")
    if not isinstance(components, dict):
        return None
    chip_seed = _rescale_score(components.get("chipFlow"), SCORE_V2_WEIGHTS["chipFlow"], 40)
    combined_technical_seed = _rescale_score(
        components.get("technicalStructure"),
        SCORE_V2_WEIGHTS["technicalStructure"],
        50,
    )
    technical_breakdown = payload.get("technicalBreakdown")
    volume_confirmation = (
        _score_number(technical_breakdown.get("volumeConfirmation"))
        if isinstance(technical_breakdown, dict)
        else 0.0
    )
    momentum_seed = _rescale_score(volume_confirmation, 6, 20) if volume_confirmation > 0 else 0.0
    momentum_seed = _round1(min(momentum_seed, combined_technical_seed, 20.0))
    technical_seed = _round1(min(max(combined_technical_seed - momentum_seed, 0.0), 30.0))
    if technical_seed + momentum_seed < combined_technical_seed:
        momentum_seed = _round1(min(20.0, momentum_seed + (combined_technical_seed - technical_seed - momentum_seed)))
    return {
        "chipFlowSeed40": chip_seed,
        "technicalSeed30": technical_seed,
        "screenerMomentumSeed20": momentum_seed,
        "mlEdgeSeed30": ml_score,
        "personaAlphaSeed": 0.0,
    }


def load_fundamental_quality_by_symbol(screener_recs: list[dict], decision_date: str) -> dict[str, dict[str, Any]]:
    """Read D1 fundamental inputs and return Score V2 fundamental-quality payloads.

    This is read-only and fail-soft. Missing FinLab canonical rows should not
    block the daily pipeline; they leave fundamentalQuality at 0 until FinLab
    structured materialization is available.
    """

    if not screener_recs:
        return {}
    symbols = sorted({str(row.get("symbol") or "").strip() for row in screener_recs if row.get("symbol")})
    revenue_by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
    canonical_financial_by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}

    if symbols:
        try:
            for chunk in _chunked(symbols):
                placeholders = ",".join("?" for _ in chunk)
                rows = d1_client.query(
                    f"""
                    SELECT stock_id, revenue_month, market_segment, revenue, mom, yoy, source, as_of_date
                    FROM canonical_revenue_monthly
                    WHERE stock_id IN ({placeholders})
                    ORDER BY stock_id, revenue_month
                    """,
                    chunk,
                    timeout=60,
                )
                for row in rows or []:
                    symbol = str(row.get("stock_id") or "").strip()
                    if symbol in revenue_by_symbol:
                        revenue_by_symbol[symbol].append(dict(row))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reco] canonical_revenue_monthly unavailable for fundamental quality: %s", exc)

        try:
            for chunk in _chunked(symbols):
                placeholders = ",".join("?" for _ in chunk)
                rows = d1_client.query(
                    f"""
                    SELECT stock_id, period, market_segment, report_date, available_date,
                           revenue_growth_yoy, gross_margin, operating_margin, roe, eps,
                           pe, pb, dividend_yield, debt_ratio, current_ratio,
                           operating_cash_flow, industry_quality_percentile,
                           source, as_of_date
                    FROM canonical_fundamental_features
                    WHERE stock_id IN ({placeholders})
                      AND available_date <= ?
                      AND source = 'finlab.fundamental_factor_diversity'
                    ORDER BY stock_id, available_date, period
                    """,
                    [*chunk, decision_date],
                    timeout=60,
                )
                for row in rows or []:
                    symbol = str(row.get("stock_id") or "").strip()
                    if symbol in canonical_financial_by_symbol:
                        canonical_financial_by_symbol[symbol].append(dict(row))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reco] canonical_fundamental_features unavailable for fundamental quality: %s", exc)

    out: dict[str, dict[str, Any]] = {}
    for rec in screener_recs:
        symbol = str(rec.get("symbol") or "").strip()
        if not symbol:
            continue
        out[symbol] = score_fundamental_quality(
            decision_date=decision_date,
            revenue_rows=revenue_by_symbol.get(symbol, []),
            financial_rows=canonical_financial_by_symbol.get(symbol, []),
        )
    return out


def _score_v2_components_from_row(row: dict) -> dict[str, float]:
    payload = _parse_score_components_payload(row.get("score_components"))
    if isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION and isinstance(payload.get("components"), dict):
        components = payload["components"]
        ml_edge = _clamp_score(components.get("mlEdge"), SCORE_V2_WEIGHTS["mlEdge"])
        fundamental_quality = row.get("fundamental_quality_score")
        if fundamental_quality is None and isinstance(row.get("fundamental_quality"), dict):
            fundamental_quality = row["fundamental_quality"].get("score")
        if "score_seed_inputs" in row:
            ml_edge = _rescale_score(_score_v2_seed_inputs(row)["mlEdgeSeed30"], 30, SCORE_V2_WEIGHTS["mlEdge"])
        return {
            "mlEdge": ml_edge,
            "chipFlow": _clamp_score(components.get("chipFlow"), SCORE_V2_WEIGHTS["chipFlow"]),
            "technicalStructure": _clamp_score(components.get("technicalStructure"), SCORE_V2_WEIGHTS["technicalStructure"]),
            "fundamentalQuality": _clamp_score(
                components.get("fundamentalQuality") if fundamental_quality is None else fundamental_quality,
                SCORE_V2_WEIGHTS["fundamentalQuality"],
            ),
            "newsTheme": _clamp_score(components.get("newsTheme"), SCORE_V2_WEIGHTS["newsTheme"]),
        }
    seeds = _score_v2_seed_inputs(row)
    return {
        "mlEdge": _rescale_score(seeds["mlEdgeSeed30"], 30, SCORE_V2_WEIGHTS["mlEdge"]),
        "chipFlow": _rescale_score(seeds["chipFlowSeed40"], 40, SCORE_V2_WEIGHTS["chipFlow"]),
        "technicalStructure": _rescale_score(
            seeds["technicalSeed30"] + seeds["screenerMomentumSeed20"],
            50,
            SCORE_V2_WEIGHTS["technicalStructure"],
        ),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }


def _require_canonical_score_v2_components(row: dict) -> dict[str, float]:
    payload = _parse_score_components_payload(row.get("score_components"))
    if not isinstance(payload, dict) or not isinstance(payload.get("components"), dict):
        symbol = row.get("symbol") or row.get("stock_id") or "unknown"
        raise ValueError(f"Score V2 score_components required for ranking promotion: {symbol}")
    return _score_v2_components_from_row({"score_components": payload})


def _score_v2_final_score_for_ranking(row: dict) -> float:
    payload = _parse_score_components_payload(row.get("score_components"))
    if not isinstance(payload, dict) or payload.get("version") != SCORE_V2_VERSION:
        symbol = row.get("symbol") or row.get("stock_id") or "unknown"
        raise ValueError(f"Score V2 score_components required for ranking promotion: {symbol}")
    final = payload.get("finalScore")
    if final is None:
        final = payload.get("total")
    if final is None:
        final = sum(_score_v2_components_from_row({"score_components": payload}).values())
    return _clamp_score(final, 100)


def _score_v2_technical_breakdown(row: dict, target: float) -> dict[str, float]:
    maxima = {
        "trendStructure": 7.0,
        "volatilityStructure": 5.0,
        "reversalExtreme": 5.0,
        "volumeConfirmation": 6.0,
        "executionRisk": 2.0,
    }
    target = _clamp_score(target, SCORE_V2_WEIGHTS["technicalStructure"])
    seeds = _score_v2_seed_inputs(row)

    current_price = _first_float(row.get("current_price"))
    ma20 = _first_float(row.get("ma20"))
    macd_hist = _first_float(row.get("macd_hist"))
    plus_di = _first_float(row.get("plus_di14"), row.get("plusDi14"))
    minus_di = _first_float(row.get("minus_di14"), row.get("minusDi14"))
    adx = _first_float(row.get("adx14"))
    atr = _first_float(row.get("atr14"))
    sar = _first_float(row.get("parabolic_sar"), row.get("parabolicSar"))
    cci = _first_float(row.get("cci20"))
    rsi = _first_float(row.get("rsi14"))
    vw_rsi = _first_float(row.get("volume_weighted_rsi14"), row.get("volumeWeightedRsi14"))
    vmd = _first_float(row.get("volume_momentum_divergence_13_27_10"), row.get("volumeMomentumDivergence132710"))
    squeeze_on = _first_float(row.get("squeeze_on"), row.get("squeezeOn"))
    squeeze_release = _first_float(row.get("squeeze_release"), row.get("squeezeRelease"))
    squeeze_momentum = _first_float(row.get("squeeze_momentum"), row.get("squeezeMomentum"))
    obv_temperature = _first_float(row.get("obv_temperature_60"), row.get("obvTemperature60"))
    adaptive_rsi_midline = _first_float(row.get("adaptive_rsi_midline_50"), row.get("adaptiveRsiMidline50"))
    adaptive_rsi_upper = _first_float(row.get("adaptive_rsi_upper_50"), row.get("adaptiveRsiUpper50"))
    adaptive_rsi_lower = _first_float(row.get("adaptive_rsi_lower_50"), row.get("adaptiveRsiLower50"))
    adaptive_rsi_overbought = _first_float(row.get("adaptive_rsi_overbought"), row.get("adaptiveRsiOverbought"))
    adaptive_rsi_oversold = _first_float(row.get("adaptive_rsi_oversold"), row.get("adaptiveRsiOversold"))

    detailed_values = [
        plus_di,
        minus_di,
        adx,
        atr,
        sar,
        cci,
        vw_rsi,
        vmd,
        squeeze_on,
        squeeze_release,
        squeeze_momentum,
        obv_temperature,
        adaptive_rsi_midline,
        adaptive_rsi_upper,
        adaptive_rsi_lower,
        adaptive_rsi_overbought,
        adaptive_rsi_oversold,
    ]
    if not any(value is not None for value in detailed_values):
        return {
            "trendStructure": _rescale_score(seeds["technicalSeed30"], 30, maxima["trendStructure"]),
            "volatilityStructure": 0.0,
            "reversalExtreme": 0.0,
            "volumeConfirmation": _rescale_score(seeds["screenerMomentumSeed20"], 20, maxima["volumeConfirmation"]),
            "executionRisk": 0.0,
        }

    natr = (atr / current_price * 100.0) if atr is not None and current_price and current_price > 0 else None
    raw = {
        "trendStructure": 0.0,
        "volatilityStructure": 0.0,
        "reversalExtreme": 0.0,
        "volumeConfirmation": 0.0,
        "executionRisk": 0.0,
    }
    if current_price is not None and ma20 is not None and current_price > ma20:
        raw["trendStructure"] += 2.0
    if macd_hist is not None and macd_hist > 0:
        raw["trendStructure"] += 1.5
    if plus_di is not None and minus_di is not None and plus_di > minus_di:
        raw["trendStructure"] += 1.5
    if adx is not None:
        raw["trendStructure"] += 2.0 if adx >= 25 else 1.0 if adx >= 18 else 0.0
    if squeeze_momentum is not None:
        raw["trendStructure"] += 1.0 if squeeze_momentum > 0 else 0.0

    if natr is not None:
        if 1.0 <= natr <= 4.0:
            raw["volatilityStructure"] += 5.0
        elif 0.5 <= natr <= 6.0:
            raw["volatilityStructure"] += 3.0
        elif natr > 0:
            raw["volatilityStructure"] += 1.0
    if squeeze_release is not None and squeeze_release > 0:
        raw["volatilityStructure"] += 3.0
    elif squeeze_on is not None and squeeze_on > 0:
        raw["volatilityStructure"] += 1.5

    if sar is not None and current_price is not None and current_price > sar:
        raw["reversalExtreme"] += 2.0
    if cci is not None:
        raw["reversalExtreme"] += 2.0 if -100 <= cci <= 150 else 1.0
    if rsi is not None:
        has_adaptive_rsi = adaptive_rsi_upper is not None and adaptive_rsi_lower is not None
        if has_adaptive_rsi:
            if adaptive_rsi_oversold is not None and adaptive_rsi_oversold > 0:
                raw["reversalExtreme"] += 1.5
            elif adaptive_rsi_overbought is not None and adaptive_rsi_overbought > 0:
                raw["reversalExtreme"] += 0.0
            elif adaptive_rsi_lower <= rsi <= adaptive_rsi_upper:
                raw["reversalExtreme"] += 1.2
        elif 35 <= rsi <= 75:
            raw["reversalExtreme"] += 1.0

    if obv_temperature is not None:
        if 60 <= obv_temperature <= 85:
            raw["volumeConfirmation"] += 3.0
        elif 45 <= obv_temperature < 60 or 85 < obv_temperature <= 95:
            raw["volumeConfirmation"] += 1.5
    if vmd is not None and vmd > 0:
        raw["volumeConfirmation"] += 1.0 if obv_temperature is not None else 2.0
    if vw_rsi is not None:
        raw["volumeConfirmation"] += 2.0 if 55 <= vw_rsi <= 80 else 1.0 if vw_rsi > 80 else 0.0
    raw["volumeConfirmation"] += _rescale_score(seeds["screenerMomentumSeed20"], 20, 1.0)

    if rsi is not None:
        if adaptive_rsi_upper is not None and adaptive_rsi_lower is not None:
            if adaptive_rsi_lower <= rsi <= adaptive_rsi_upper:
                raw["executionRisk"] += 1.0
        elif 35 <= rsi <= 75:
            raw["executionRisk"] += 1.0
    if obv_temperature is not None and 20 <= obv_temperature <= 90:
        raw["executionRisk"] += 0.5
    if natr is None or natr <= 6.0:
        raw["executionRisk"] += 1.0

    clamped = {key: _clamp_score(value, maxima[key]) for key, value in raw.items()}
    raw_sum = sum(clamped.values())
    if raw_sum <= 0 or target <= 0:
        return {key: 0.0 for key in maxima}
    scale = target / raw_sum
    return {key: _clamp_score(value * scale, maxima[key]) for key, value in clamped.items()}


def build_score_components(row: dict, *, raw_score: float, alpha_policy: dict | None = None) -> dict[str, Any]:
    """Persist canonical Score V2 payload from normalized seed inputs."""
    alpha_context = row.get("alpha_context") or {}
    alpha_adjustment = alpha_context.get("score_adjustment") if isinstance(alpha_context, dict) else 0
    seeds = _score_v2_seed_inputs(row)
    risk_flags = ((alpha_context.get("risk_overlay") or {}).get("flags") if isinstance(alpha_context, dict) else []) or []
    alpha_reason = {
        "bucket": alpha_context.get("edge_bucket") if isinstance(alpha_context, dict) else None,
        "regime": alpha_context.get("regime") if isinstance(alpha_context, dict) else None,
        "regimeWeight": alpha_context.get("regime_weight") if isinstance(alpha_context, dict) else None,
        "riskFlags": risk_flags,
        "riskPenalty": ((alpha_context.get("risk_overlay") or {}).get("penalty") if isinstance(alpha_context, dict) else 0) or 0,
        "details": _build_alpha_adjustment_details(alpha_context if isinstance(alpha_context, dict) else {}, alpha_policy),
    }
    components = _score_v2_components_from_row(row)
    total = _round1(sum(components.values()))
    technical_breakdown = _score_v2_technical_breakdown(row, components["technicalStructure"])
    final_score = _clamp_score(total + _score_number(alpha_adjustment), 100)
    payload: dict[str, Any] = {
        "version": SCORE_V2_VERSION,
        "weights": SCORE_V2_WEIGHTS,
        "components": components,
        "total": total,
        "technicalBreakdown": technical_breakdown,
        "technicalSignals": {
            "plusDi14": _first_float(row.get("plus_di14"), row.get("plusDi14")),
            "minusDi14": _first_float(row.get("minus_di14"), row.get("minusDi14")),
            "adx14": _first_float(row.get("adx14")),
            "parabolicSar": _first_float(row.get("parabolic_sar"), row.get("parabolicSar")),
            "cci20": _first_float(row.get("cci20")),
            "volumeWeightedRsi14": _first_float(row.get("volume_weighted_rsi14"), row.get("volumeWeightedRsi14")),
            "volumeMomentumDivergence132710": _first_float(row.get("volume_momentum_divergence_13_27_10"), row.get("volumeMomentumDivergence132710")),
            "squeezeOn": _first_float(row.get("squeeze_on"), row.get("squeezeOn")),
            "squeezeRelease": _first_float(row.get("squeeze_release"), row.get("squeezeRelease")),
            "squeezeMomentum": _first_float(row.get("squeeze_momentum"), row.get("squeezeMomentum")),
            "obvTemperature60": _first_float(row.get("obv_temperature_60"), row.get("obvTemperature60")),
            "adaptiveRsiMidline50": _first_float(row.get("adaptive_rsi_midline_50"), row.get("adaptiveRsiMidline50")),
            "adaptiveRsiUpper50": _first_float(row.get("adaptive_rsi_upper_50"), row.get("adaptiveRsiUpper50")),
            "adaptiveRsiLower50": _first_float(row.get("adaptive_rsi_lower_50"), row.get("adaptiveRsiLower50")),
            "adaptiveRsiOverbought": _first_float(row.get("adaptive_rsi_overbought"), row.get("adaptiveRsiOverbought")),
            "adaptiveRsiOversold": _first_float(row.get("adaptive_rsi_oversold"), row.get("adaptiveRsiOversold")),
        },
        "riskFlags": list(dict.fromkeys(str(flag) for flag in risk_flags if flag)),
        "reasons": [],
        "seedComponents": {
            **seeds,
        },
        "rawScore": raw_score,
        "alphaAdjustment": alpha_adjustment or 0,
        "finalScore": final_score,
        "formula": "score_v2_total + alphaAdjustment",
        "alphaReason": alpha_reason,
    }
    if isinstance(row.get("fundamental_quality"), dict):
        payload["fundamentalQuality"] = row["fundamental_quality"]
    if isinstance(row.get("chip_evidence"), dict):
        payload["chipEvidence"] = row["chip_evidence"]
    return payload


def _sum_chip_cash_billion(chips: list[dict], prices: list[dict], field: str) -> float:
    """Convert chip share counts to TWD billions using same-day close."""
    if not chips:
        return 0.0
    price_by_date = {p.get("date"): float(p.get("close") or 0.0) for p in prices if p.get("date")}
    fallback_close = 0.0
    for p in reversed(prices):
        close = float(p.get("close") or 0.0)
        if close > 0:
            fallback_close = close
            break
    total = 0.0
    for c in chips:
        close = price_by_date.get(c.get("date")) or fallback_close
        if close <= 0:
            continue
        total += float(c.get(field) or 0.0) * close / 1e8
    return round(total, 6)


def _sum_broker_cash_billion(chips: list[dict], prices: list[dict]) -> float:
    """Prefer FinLab estimated broker amount, fallback to broker shares * close."""
    if not chips:
        return 0.0
    total_amount = 0.0
    missing_amount_rows: list[dict] = []
    for c in chips:
        if c.get("broker_estimated_amount") is None:
            missing_amount_rows.append(c)
            continue
        total_amount += float(c.get("broker_estimated_amount") or 0.0)
    if missing_amount_rows:
        price_by_date = {p.get("date"): float(p.get("close") or 0.0) for p in prices if p.get("date")}
        fallback_close = 0.0
        for p in reversed(prices):
            close = float(p.get("close") or 0.0)
            if close > 0:
                fallback_close = close
                break
        for c in missing_amount_rows:
            close = price_by_date.get(c.get("date")) or fallback_close
            total_amount += float(c.get("broker_net_shares") or 0.0) * close
    return round(total_amount / 1e8, 6)


def _sum_numeric(chips: list[dict], field: str) -> float:
    return round(sum(float(c.get(field) or 0.0) for c in chips), 6)


def _latest_broker_chip(chips: list[dict]) -> dict:
    for c in reversed(chips):
        if c.get("broker_net_shares") is not None or c.get("broker_estimated_amount") is not None:
            return c
    return {}


def _format_abs_cash_billion(value: float) -> str:
    abs_value = abs(value)
    if 0 < abs_value < 0.01:
        return f"{round(abs_value * 10000):.0f}萬"
    return f"{abs_value:.2f}億"


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _ema(values: list[float], span: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (span + 1.0)
    out = [values[0]]
    for value in values[1:]:
        out.append(value * alpha + out[-1] * (1.0 - alpha))
    return out


def _derive_technical_snapshot(payload: dict, rec: dict) -> dict[str, float | None]:
    """Return latest RSI/MACD/MA20 for recommendation text.

    The screener can emit research-only/emerging seeds before technical_indicators
    are materialized. In that case, derive the same snapshot from payload prices
    instead of treating missing fields as bearish.
    """
    indicators = _sorted_payload_rows(payload, "indicators") if payload else []
    latest_ind = indicators[-1] if indicators else {}
    prices = _sorted_payload_rows(payload, "prices") if payload else []
    closes = [
        float(p.get("close"))
        for p in prices
        if _float_or_none(p.get("close")) is not None
    ]

    ma20 = _float_or_none(latest_ind.get("ma20"))
    rsi14 = _float_or_none(latest_ind.get("rsi14"))
    macd_hist = _float_or_none(latest_ind.get("macdHist"))
    atr14 = _first_float(latest_ind.get("atr14"))
    plus_di14 = _first_float(latest_ind.get("plusDi14"), latest_ind.get("plus_di14"))
    minus_di14 = _first_float(latest_ind.get("minusDi14"), latest_ind.get("minus_di14"))
    adx14 = _first_float(latest_ind.get("adx14"))
    parabolic_sar = _first_float(latest_ind.get("parabolicSar"), latest_ind.get("parabolic_sar"))
    cci20 = _first_float(latest_ind.get("cci20"))
    volume_weighted_rsi14 = _first_float(latest_ind.get("volumeWeightedRsi14"), latest_ind.get("volume_weighted_rsi14"))
    volume_momentum_divergence = _first_float(
        latest_ind.get("volumeMomentumDivergence132710"),
        latest_ind.get("volume_momentum_divergence_13_27_10"),
    )
    squeeze_on = _first_float(latest_ind.get("squeezeOn"), latest_ind.get("squeeze_on"))
    squeeze_release = _first_float(latest_ind.get("squeezeRelease"), latest_ind.get("squeeze_release"))
    squeeze_momentum = _first_float(latest_ind.get("squeezeMomentum"), latest_ind.get("squeeze_momentum"))
    obv_temperature_60 = _first_float(latest_ind.get("obvTemperature60"), latest_ind.get("obv_temperature_60"))
    adaptive_rsi_midline_50 = _first_float(latest_ind.get("adaptiveRsiMidline50"), latest_ind.get("adaptive_rsi_midline_50"))
    adaptive_rsi_upper_50 = _first_float(latest_ind.get("adaptiveRsiUpper50"), latest_ind.get("adaptive_rsi_upper_50"))
    adaptive_rsi_lower_50 = _first_float(latest_ind.get("adaptiveRsiLower50"), latest_ind.get("adaptive_rsi_lower_50"))
    adaptive_rsi_overbought = _first_float(latest_ind.get("adaptiveRsiOverbought"), latest_ind.get("adaptive_rsi_overbought"))
    adaptive_rsi_oversold = _first_float(latest_ind.get("adaptiveRsiOversold"), latest_ind.get("adaptive_rsi_oversold"))

    if ma20 is None and len(closes) >= 20:
        ma20 = sum(closes[-20:]) / 20.0

    if rsi14 is None and len(closes) >= 15:
        gains = 0.0
        losses = 0.0
        for i in range(len(closes) - 14, len(closes)):
            delta = closes[i] - closes[i - 1]
            if delta > 0:
                gains += delta
            else:
                losses -= delta
        avg_gain = gains / 14.0
        avg_loss = losses / 14.0
        rsi14 = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

    if macd_hist is None and len(closes) >= 35:
        ema12 = _ema(closes, 12)
        ema26 = _ema(closes, 26)
        macd_line = [a - b for a, b in zip(ema12, ema26)][25:]
        signal_line = _ema(macd_line, 9)
        if macd_line and signal_line:
            macd_hist = macd_line[-1] - signal_line[-1]

    return {
        "ma20": ma20,
        "rsi14": rsi14 if rsi14 is not None else _float_or_none(rec.get("rsi14")),
        "macd_hist": macd_hist if macd_hist is not None else _float_or_none(rec.get("macd_hist")),
        "atr14": atr14,
        "plus_di14": plus_di14,
        "minus_di14": minus_di14,
        "adx14": adx14,
        "parabolic_sar": parabolic_sar,
        "cci20": cci20,
        "volume_weighted_rsi14": volume_weighted_rsi14,
        "volume_momentum_divergence_13_27_10": volume_momentum_divergence,
        "squeeze_on": squeeze_on,
        "squeeze_release": squeeze_release,
        "squeeze_momentum": squeeze_momentum,
        "obv_temperature_60": obv_temperature_60,
        "adaptive_rsi_midline_50": adaptive_rsi_midline_50,
        "adaptive_rsi_upper_50": adaptive_rsi_upper_50,
        "adaptive_rsi_lower_50": adaptive_rsi_lower_50,
        "adaptive_rsi_overbought": adaptive_rsi_overbought,
        "adaptive_rsi_oversold": adaptive_rsi_oversold,
    }


def build_reason(s: dict) -> str:
    """Build fallback reason from canonical Score V2 payload."""
    payload = s.get("score_components")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            payload = None
    if not (isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION):
        return "Score V2 missing: canonical score_components unavailable"
    components = _score_v2_components_from_row({"score_components": payload})
    final_score = _clamp_score(payload.get("finalScore", payload.get("total")), 100)
    total = _clamp_score(payload.get("total"), 100)
    alpha = _round1(_score_number(payload.get("alphaAdjustment"), final_score - total))

    market_segment = str(s.get("market_segment") or "").upper()
    broker_rows = int(s.get("broker_rows") or 0)
    broker_cash_5d = _score_number(s.get("broker_net_amount_5d"))
    if market_segment == "EMERGING" and broker_rows > 0:
        chip_context = (
            f"興櫃券商分點近5日{_format_abs_cash_billion(broker_cash_5d)}"
            f", broker_count={s.get('broker_count_latest', 'N/A')}"
        )
    elif market_segment == "EMERGING":
        chip_context = "emerging broker flow evidence unavailable"
    else:
        net_amount = _score_number(s.get("foreign_net_5d")) + _score_number(s.get("trust_net_5d")) + _score_number(s.get("dealer_net_5d"))
        chip_context = f"法人5日淨額 {net_amount:.1f} 億"

    technical_parts: list[str] = []
    rsi = _first_float(s.get("rsi14"))
    if rsi is not None:
        technical_parts.append(f"RSI {rsi:.0f}")
    macd_hist = _first_float(s.get("macd_hist"))
    if macd_hist is not None:
        technical_parts.append("MACD positive" if macd_hist > 0 else "MACD non-positive")
    adx = _first_float(s.get("adx14"))
    if adx is not None:
        plus_di = _first_float(s.get("plus_di14"))
        minus_di = _first_float(s.get("minus_di14"))
        direction = ""
        if plus_di is not None and minus_di is not None:
            direction = " bullish" if plus_di > minus_di else " bearish"
        technical_parts.append(f"ADX {adx:.0f}{direction}")
    technical_context = ", ".join(technical_parts) if technical_parts else "technical signals limited"
    ml_context = str(s.get("ml_vote_summary_text") or s.get("ml_vote_summary") or "ML evidence limited")

    return (
        f"Score V2 {final_score:.1f}/100 (base {total:.1f}, alpha {alpha:+.1f}): "
        f"ML Edge {components['mlEdge']:.1f}/25, "
        f"Chip Flow {components['chipFlow']:.1f}/25, "
        f"Technical {components['technicalStructure']:.1f}/25. "
        f"Chip Flow: {chip_context}; Technical: {technical_context}; ML Edge: {ml_context}"
    )


def build_watch_points(s: dict) -> list[str]:
    """Build concise risk watch points used when LLM reasons are unavailable."""
    points: list[str] = []
    rsi = float(s.get("rsi14") or 50.0)
    conf = float(s.get("ml_confidence") or 0.0)
    sig = str(s.get("_signal") or "").upper()
    forecast_pct = float(s.get("ml_forecast_pct") or 0.0)

    if rsi > 80:
        points.append("RSI 過熱，避免追高")
    elif rsi > 75:
        points.append("RSI 偏熱，留意短線震盪")
    if float(s.get("macd_hist") or 0.0) < 0 and float(s.get("current_price") or 0.0) > float(s.get("ma20") or 0.0):
        points.append("價格站上月線但 MACD 偏弱，需確認量能延續")
    adx = _float_or_none(s.get("adx14"))
    vmd = _float_or_none(s.get("volume_momentum_divergence_13_27_10"))
    if adx is not None and adx < 15:
        points.append("ADX 顯示趨勢強度不足，避免只看突破追價")
    if vmd is not None and vmd < 0:
        points.append("量能動量偏離轉弱，需確認資金熱度是否降溫")
    if float(s.get("foreign_net_5d") or 0.0) < 0:
        points.append("外資近 5 日偏賣，籌碼需再確認")
    if float(s.get("trust_net_5d") or 0.0) < 0 < float(s.get("foreign_net_5d") or 0.0):
        points.append("外資與投信方向不一致")
    market_segment = str(s.get("market_segment") or "").upper()
    broker_rows = int(s.get("broker_rows") or 0)
    if market_segment == "EMERGING" and broker_rows > 0:
        points.append("興櫃籌碼採 FinLab 券商分點流；不可與上市櫃三大法人直接同比")
    elif market_segment == "EMERGING" or int(s.get("chip_rows") or 0) == 0:
        points.append("興櫃券商分點資料不足；暫不以三大法人語意判讀")
    if "BUY" in sig and forecast_pct < 0:
        points.append("ML 訊號與預期報酬矛盾，禁止直接追價")
    elif conf < 0.45:
        points.append("ML 信心偏低，僅能觀察")
    elif sig == "HOLD":
        points.append("ML 尚未形成買進共識")
    if not points:
        points.append("留意盤前大盤、量能與開盤價是否支持進場")
    return points


def filter_and_score_recommendations(
    screener_recs: list[dict],
    predictions: dict[str, dict],   # symbol → ml result from ml-service
    payloads: list[dict],            # PredictPayload as dict (for reason data)
    persona_opinions: dict | None = None,  # symbol → {trust:{...}, retail:{...}}
    persona_weight: float = 1.0,   # 0 = disable, 1 = default, 0.5 = shadow mode
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    alpha_policy: dict | None = None,
    fundamental_quality_by_symbol: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[dict], int]:
    """
    Returns (final_recs, sell_filtered_count).

    For each screener_rec:
      1. Look up matching prediction
      2. Filter SELL/NO_SIGNAL → drop
      3. Compute ml_score, persona_score, total_score
      4. Build template reason / watchPoints
      5. Return updated row dict

    persona_score integration (Batch B):
      - Reads persona_opinions[symbol] → {trust, retail}
      - compute_persona_score maps to [-20, +20] scalar
      - Multiplied by persona_weight (KV-driven dial for rollout safety)
      - Stored as Score V2 alphaAdjustment before finalScore is persisted
      - Opinion-less symbols contribute 0 (NEUTRAL default)
    """
    payload_by_sym = {p["symbol"]: p for p in payloads}
    final: list[dict] = []
    sell_count = 0

    # ML_POOL Plan A migration (2026-04-19): toggle which signal drives the
    # BUY/SELL gate. Default True = use ensemble_v2 formal alpha slots
    # with lifecycle weights). KV override:
    # trading:config.mlPool.useEnsembleV2=false → fall back to legacy feature-model signal.
    use_ev2 = _is_use_ensemble_v2()

    # Lazy-import persona helpers so this module stays import-safe even if
    # persona_service has a downstream issue.
    _persona_helpers = None
    if persona_opinions and persona_weight != 0:
        try:
            from services.persona_service import (
                TrustOpinion, RetailOpinion, compute_persona_score,
            )
            _persona_helpers = (TrustOpinion, RetailOpinion, compute_persona_score)
        except Exception as e:
            logger.warning(f"[reco] persona helpers unavailable ({e}); disabling persona_score")
            _persona_helpers = None

    for rec in screener_recs:
        symbol = rec["symbol"]
        ml = predictions.get(symbol)
        eff_ml = _effective_prediction_view(ml, use_ensemble_v2=use_ev2)
        sig = (eff_ml.get("signal") or "").upper() or None

        # Filter SELL / NO_SIGNAL
        if sig and ("SELL" in sig or sig == "NO_SIGNAL"):
            sell_count += 1
            continue

        # ML score reflects model evidence only; ranking/top-K promotion is
        # tracked in signal_source/reason but should not inflate ML votes.
        ml_score = calculate_ml_score(eff_ml, ml) if ml else 0.0
        existing_score_components = _parse_score_components_payload(rec.get("score_components"))
        score_seed_inputs = _score_v2_seed_inputs_from_payload(existing_score_components, ml_score=ml_score)
        if score_seed_inputs is None:
            raise ValueError(f"Score V2 screener score_components required for {symbol}")

        # Persona score (Batch B: 投信/散戶 augmentation)
        persona_score = 0.0
        persona_applied = None  # for downstream reason text
        if _persona_helpers is not None and persona_opinions:
            TrustOp, RetailOp, compute_score = _persona_helpers
            op = persona_opinions.get(symbol)
            if op:
                try:
                    trust = TrustOp(**op.get("trust", {})) if op.get("trust") else None
                    retail = RetailOp(**op.get("retail", {})) if op.get("retail") else None
                    if trust and retail:
                        persona_score = compute_score(trust, retail) * persona_weight
                        score_seed_inputs["personaAlphaSeed"] = persona_score
                        persona_applied = {
                            "trust_signal": trust.signal, "trust_strength": trust.strength,
                            "retail_signal": retail.signal, "retail_strength": retail.strength,
                        }
                except Exception as e:
                    logger.debug(f"[reco] persona_score failed for {symbol}: {e}")

        total_score = round((
            score_seed_inputs["chipFlowSeed40"]
            + score_seed_inputs["technicalSeed30"]
            + score_seed_inputs["mlEdgeSeed30"]
            + score_seed_inputs["personaAlphaSeed"]
        ) * 10) / 10

        payload = payload_by_sym.get(symbol, {})
        raw_stock_meta = payload.get("stock_meta", {}) if payload else {}
        if not raw_stock_meta:
            raw_stock_meta = {
                "market_segment": rec.get("market_segment") or rec.get("market"),
                "recommendation_lane": rec.get("recommendation_lane"),
                "eligible_for_ml": rec.get("eligible_for_ml", True),
                "eligible_for_pending_buy": rec.get("eligible_for_pending_buy"),
            }
        stock_meta = _enrich_stock_meta_with_segment_policy(raw_stock_meta)
        recommendation_lane = stock_meta.get("recommendation_lane") or "tradable"
        market_segment = stock_meta.get("market_segment") or "UNKNOWN"
        eligible_for_pending_buy = bool(stock_meta.get("eligible_for_pending_buy", recommendation_lane == "tradable"))
        env_for_stock = payload.get("market_env", {}) if payload else {}

        # Extract latest indicator values from payload. If the indicator table
        # is not ready for a research-only seed, derive from payload prices.
        technical = _derive_technical_snapshot(payload, rec)

        # Latest price from payload
        prices = _sorted_payload_rows(payload, "prices") if payload else []
        current_price = prices[-1]["close"] if prices else (rec.get("current_price"))

        # Foreign / trust net (5d sum from chips)
        chips = _sorted_payload_rows(payload, "chips") if payload else []
        recent_chips = chips[-5:]
        foreign_net_5d = _sum_chip_cash_billion(recent_chips, prices, "foreign_net")
        trust_net_5d = _sum_chip_cash_billion(recent_chips, prices, "trust_net")
        dealer_net_5d = _sum_chip_cash_billion(recent_chips, prices, "dealer_net")
        broker_net_amount_5d = _sum_broker_cash_billion(recent_chips, prices)
        broker_net_shares_5d = _sum_numeric(recent_chips, "broker_net_shares")
        latest_broker = _latest_broker_chip(recent_chips)
        broker_rows = sum(
            1 for chip in recent_chips
            if chip.get("broker_net_shares") is not None or chip.get("broker_estimated_amount") is not None
        )
        chip_evidence = None
        if broker_rows > 0:
            chip_evidence = {
                "source": latest_broker.get("chip_source") or "finlab.rotc_broker_transactions",
                "source_date": latest_broker.get("date"),
                "broker_net_amount_5d_billion": broker_net_amount_5d,
                "broker_net_shares_5d": broker_net_shares_5d,
                "broker_count_latest": latest_broker.get("broker_count"),
                "concentration_latest": latest_broker.get("broker_concentration"),
                "as_of_date": latest_broker.get("as_of_date"),
            }

        # ML model votes from prediction
        ml_models_total = 0
        ml_models_up = 0
        ml_models_down = 0
        if ml:
            models = ml.get("models")
            # ml-service can return models as dict {name: {...}} or list [{name, ...}]
            iterable = []
            if isinstance(models, dict):
                iterable = models.values()
            elif isinstance(models, list):
                iterable = models
            for m in iterable:
                if isinstance(m, dict):
                    direction = m.get("direction") or ""
                    ml_models_total += 1
                    if direction == "up":
                        ml_models_up += 1
                    elif direction == "down":
                        ml_models_down += 1

        legacy_counts = {"total": ml_models_total, "up": ml_models_up, "down": ml_models_down}
        ml_vote_text = build_ml_vote_summary(
            ml,
            eff_ml,
            legacy_counts,
        )
        ml_vote_summary = build_ml_vote_summary_data(ml, legacy_counts)
        reason_data = {
            "foreign_consecutive": 0,  # TODO: compute consec from chips if needed
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "dealer_net_5d": dealer_net_5d,
            "broker_net_amount_5d": broker_net_amount_5d,
            "broker_net_shares_5d": broker_net_shares_5d,
            "broker_count_latest": latest_broker.get("broker_count"),
            "broker_concentration_latest": latest_broker.get("broker_concentration"),
            "broker_rows": broker_rows,
            "rsi14": technical.get("rsi14"),
            "macd_hist": technical.get("macd_hist"),
            "adx14": technical.get("adx14"),
            "cci20": technical.get("cci20"),
            "volume_weighted_rsi14": technical.get("volume_weighted_rsi14"),
            "volume_momentum_divergence_13_27_10": technical.get("volume_momentum_divergence_13_27_10"),
            "squeeze_on": technical.get("squeeze_on"),
            "squeeze_release": technical.get("squeeze_release"),
            "squeeze_momentum": technical.get("squeeze_momentum"),
            "obv_temperature_60": technical.get("obv_temperature_60"),
            "adaptive_rsi_midline_50": technical.get("adaptive_rsi_midline_50"),
            "adaptive_rsi_upper_50": technical.get("adaptive_rsi_upper_50"),
            "adaptive_rsi_lower_50": technical.get("adaptive_rsi_lower_50"),
            "adaptive_rsi_overbought": technical.get("adaptive_rsi_overbought"),
            "adaptive_rsi_oversold": technical.get("adaptive_rsi_oversold"),
            "current_price": current_price,
            "ma20": technical.get("ma20"),
            "_signal": eff_ml.get("signal"),
            "ml_confidence": eff_ml.get("confidence") or 0,
            "ml_forecast_pct": eff_ml.get("forecast_pct") or 0,
            "ml_models_total": ml_models_total,
            "ml_models_up": ml_models_up,
            "ml_models_down": ml_models_down,
            "ml_vote_summary": ml_vote_text,
            "chip_rows": len(chips),
            "market_segment": market_segment,
        }

        watch_points = build_watch_points(reason_data)
        if recommendation_lane == "emerging_watchlist" or not eligible_for_pending_buy:
            watch_points = [
                *watch_points,
                "research_only:emerging_not_for_auto_trade",
                f"market_segment:{market_segment}",
            ]

        row = {
            "date": rec["date"],
            "stock_id": rec.get("stock_id"),
            "symbol": symbol,
            "rec_id": rec.get("id"),
            "name": rec.get("name"),
            "sector": rec.get("sector"),
            "industry": rec.get("industry") or rec.get("sector"),
            "score_seed_inputs": score_seed_inputs,
            "chip_score": score_seed_inputs["chipFlowSeed40"],
            "tech_score": score_seed_inputs["technicalSeed30"],
            "momentum_score": score_seed_inputs["screenerMomentumSeed20"],
            "ml_score": score_seed_inputs["mlEdgeSeed30"],
            "persona_score": persona_score,
            "persona_applied": persona_applied,  # None if no persona data
            "score": total_score,
            "signal": eff_ml.get("signal"),
            "signal_raw": eff_ml.get("signal_raw"),
            "signal_source": eff_ml.get("signal_source"),
            "confidence": eff_ml.get("confidence"),
            "ml_forecast_pct": eff_ml.get("forecast_pct") or 0.0,
            "ml_vote_summary": ml_vote_summary,
            "ml_vote_summary_text": ml_vote_text,
            "current_price": current_price,
            "market_segment": market_segment,
            "recommendation_lane": recommendation_lane,
            "eligible_for_ml": bool(stock_meta.get("eligible_for_ml", True)),
            "eligible_for_pending_buy": eligible_for_pending_buy,
            "has_buy_signal": 1 if (eligible_for_pending_buy and sig and "BUY" in sig) else 0,
            "watch_points": watch_points,
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "chip_evidence": chip_evidence,
            "ma20": technical.get("ma20"),
            "rsi14": technical.get("rsi14"),
            "macd_hist": technical.get("macd_hist"),
            "atr14": technical.get("atr14"),
            "plus_di14": technical.get("plus_di14"),
            "minus_di14": technical.get("minus_di14"),
            "adx14": technical.get("adx14"),
            "parabolic_sar": technical.get("parabolic_sar"),
            "cci20": technical.get("cci20"),
            "volume_weighted_rsi14": technical.get("volume_weighted_rsi14"),
            "volume_momentum_divergence_13_27_10": technical.get("volume_momentum_divergence_13_27_10"),
            "squeeze_on": technical.get("squeeze_on"),
            "squeeze_release": technical.get("squeeze_release"),
            "squeeze_momentum": technical.get("squeeze_momentum"),
            "obv_temperature_60": technical.get("obv_temperature_60"),
            "adaptive_rsi_midline_50": technical.get("adaptive_rsi_midline_50"),
            "adaptive_rsi_upper_50": technical.get("adaptive_rsi_upper_50"),
            "adaptive_rsi_lower_50": technical.get("adaptive_rsi_lower_50"),
            "adaptive_rsi_overbought": technical.get("adaptive_rsi_overbought"),
            "adaptive_rsi_oversold": technical.get("adaptive_rsi_oversold"),
        }
        fundamental_quality = (fundamental_quality_by_symbol or {}).get(symbol)
        if isinstance(fundamental_quality, dict):
            row["fundamental_quality"] = fundamental_quality
        if existing_score_components:
            row["score_components"] = existing_score_components
        if regime_label:
            alpha_context = build_alpha_context(row, eff_ml, payload, regime_label, regime_surface=regime_surface, policy=alpha_policy)
            apply_alpha_context(row, ml, alpha_context)
        row["score_components"] = build_score_components(row, raw_score=total_score, alpha_policy=alpha_policy)
        row["score"] = row["score_components"]["finalScore"]
        row["reason"] = build_reason({**reason_data, **row})
        final.append(row)

    return final, sell_count


# ─────────────────────────────────────────────────────────────────────────────
# Hybrid Ranking promotion (port from dailyRecommendation.ts:639-697)
# ─────────────────────────────────────────────────────────────────────────────

def _signal_tier(sig: Optional[str]) -> float:
    if not sig:
        return 0.20
    s = sig.upper()
    if "STRONG_BUY" in s:
        return 1.00
    if "BUY" in s:
        return 0.70
    if s == "HOLD":
        return 0.35
    return 0.0


def _can_promote_ranking_candidate(row: dict, ranking_config: dict) -> bool:
    """Avoid turning a negative/weak ML expectation into a BUY label."""
    lane = row.get("recommendation_lane") or "tradable"
    if row.get("eligible_for_pending_buy") is False or lane != "tradable":
        row["promotion_blocked_reason"] = "research_only_or_not_tradable"
        return False
    forecast_pct = row.get("ml_forecast_pct", row.get("forecast_pct", 0.0))
    try:
        forecast = float(forecast_pct or 0.0)
    except (TypeError, ValueError):
        forecast = 0.0
    min_forecast = float(ranking_config.get("promoteMinForecastPct", 0.0))
    if forecast < min_forecast:
        row["promotion_blocked_reason"] = "negative_or_below_min_forecast"
        return False
    return True


def build_return_history_from_payloads(payloads: list[dict], *, lookback: int | None = None) -> dict[str, list[float]]:
    """Build close-to-close return history for allocator risk estimates."""
    history: dict[str, list[float]] = {}
    safe_lookback = max(2, min(int(lookback or gnn_return_history_lookback()), 504))
    for payload in payloads or []:
        symbol = str(payload.get("symbol") or payload.get("stock_id") or "").strip()
        if not symbol:
            continue
        prices = _sorted_payload_rows(payload, "prices")[-(safe_lookback + 1):]
        closes: list[float] = []
        for row in prices:
            close = _float_or_none(row.get("close"))
            if close is None:
                close = _float_or_none(row.get("adj_close"))
            if close is not None and close > 0:
                closes.append(close)
        returns: list[float] = []
        for idx in range(1, len(closes)):
            prev = closes[idx - 1]
            cur = closes[idx]
            if prev > 0:
                value = cur / prev - 1.0
                if math.isfinite(value):
                    returns.append(round(value, 8))
        if returns:
            history[symbol] = returns
    return history


def apply_core_ml_gate(
    recommendations: list[dict],
    predictions: dict[str, dict],
    *,
    fallback_size: int | None = None,
) -> list[dict]:
    """Keep only rows selected by the Layer 2 coarse ML gate."""
    selected_ranks: dict[str, int] = {}
    for symbol, pred in (predictions or {}).items():
        gate = pred.get("core_ml_gate") if isinstance(pred, dict) else None
        if not isinstance(gate, dict) or not gate.get("selected"):
            continue
        try:
            rank = int(gate.get("rank") or 999_999)
        except (TypeError, ValueError):
            rank = 999_999
        selected_ranks[str(symbol)] = rank
    if not selected_ranks:
        if fallback_size is None:
            return recommendations
        safe_size = max(1, min(80, int(fallback_size)))
        return sorted(recommendations, key=lambda row: float(row.get("score") or 0.0), reverse=True)[:safe_size]

    gated = [
        row for row in recommendations
        if str(row.get("symbol") or "") in selected_ranks
    ]
    for row in gated:
        gate = (predictions.get(str(row.get("symbol") or "")) or {}).get("core_ml_gate") or {}
        row["core_ml_gate"] = gate
        row["watch_points"] = [
            *(row.get("watch_points") if isinstance(row.get("watch_points"), list) else []),
            f"core_ml_gate:{gate.get('rank')}/{gate.get('target_size')}",
        ]
    return sorted(gated, key=lambda row: selected_ranks.get(str(row.get("symbol") or ""), 999_999))


_CORE_FAMILY_MODEL_GROUPS: dict[str, tuple[str, ...]] = {
    "tree": ("XGBoost", "ExtraTrees", "LightGBM"),
    "tabular_neural": ("TabM",),
    "graph": ("GNN",),
    "learned_sequence": ("DLinear", "PatchTST", "iTransformer"),
    "foundation_sequence": ("TimesFM",),
}

_SEQUENCE_MODEL_SOURCE_KEYS: dict[str, str] = {
    "DLinear": "dlinear",
    "PatchTST": "patchtst",
    "iTransformer": "itransformer",
    "TimesFM": "timesfm",
}


def _finite_rank_score(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return max(0.0, min(1.0, numeric))


def _forecast_pct_to_rank_score(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    try:
        return 1.0 / (1.0 + math.exp(-numeric * 12.0))
    except OverflowError:
        return 1.0 if numeric > 0 else 0.0


def _model_rank_score(prediction: dict, model_name: str) -> float | None:
    if model_name in _SEQUENCE_MODEL_SOURCE_KEYS:
        signal = prediction.get(_SEQUENCE_MODEL_SOURCE_KEYS[model_name])
        if not isinstance(signal, dict):
            return None
        return _forecast_pct_to_rank_score(signal.get("forecast_pct"))
    rank_scores = prediction.get("rank_scores")
    if not isinstance(rank_scores, dict):
        return None
    return _finite_rank_score(rank_scores.get(model_name))


def _positive_lifecycle_weights(prediction: dict) -> dict[str, float] | None:
    ev2 = prediction.get("ensemble_v2")
    if not isinstance(ev2, dict):
        return None
    weights = ev2.get("weights")
    if isinstance(weights, dict):
        out: dict[str, float] = {}
        for name, raw in weights.items():
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value) and value > 0:
                out[str(name)] = value
        return out
    contributors = ev2.get("contributing_models")
    if isinstance(contributors, list):
        return {str(name): 1.0 for name in contributors if str(name)}
    return None


def build_core_family_vote(
    prediction: dict | None,
    *,
    require_lifecycle_weights: bool = False,
) -> dict[str, Any]:
    """Layer 3 formal family vote from lifecycle-positive production outputs."""
    pred = prediction if isinstance(prediction, dict) else {}
    lifecycle_weights = _positive_lifecycle_weights(pred)
    families: dict[str, dict[str, Any]] = {}
    active_families: list[str] = []
    family_scores: list[float] = []
    inactive_models: list[str] = []
    inactive_lifecycle_models: list[str] = []

    for family_name, model_names in _CORE_FAMILY_MODEL_GROUPS.items():
        model_scores: dict[str, float] = {}
        weighted_sum = 0.0
        weight_sum = 0.0
        for model_name in model_names:
            lifecycle_weight = lifecycle_weights.get(model_name) if lifecycle_weights is not None else None
            if require_lifecycle_weights and lifecycle_weights is None:
                inactive_lifecycle_models.append(model_name)
                continue
            if lifecycle_weights is not None and lifecycle_weight is None:
                inactive_lifecycle_models.append(model_name)
                continue
            score = _model_rank_score(pred, model_name)
            if score is not None:
                model_scores[model_name] = round(score, 6)
                weight = float(lifecycle_weight if lifecycle_weight is not None else 1.0)
                weighted_sum += score * weight
                weight_sum += weight
            else:
                inactive_models.append(model_name)
        if model_scores:
            family_score = weighted_sum / weight_sum if weight_sum > 0 else sum(model_scores.values()) / len(model_scores)
            active_families.append(family_name)
            family_scores.append(family_score)
            families[family_name] = {
                "status": "active",
                "score": round(family_score, 6),
                "models": model_scores,
                "model_count": len(model_scores),
                "lifecycle_weighted": lifecycle_weights is not None,
            }
        else:
            families[family_name] = {
                "status": (
                    "inactive_lifecycle_weight"
                    if lifecycle_weights is not None or require_lifecycle_weights
                    else "inactive_missing_artifact"
                ),
                "score": None,
                "models": {},
                "expected_models": list(model_names),
            }

    family_score = sum(family_scores) / len(family_scores) if family_scores else 0.0
    return {
        "schema_version": "core_family_vote_v1",
        "rank_source": "formal_core_family_vote",
        "family_score": round(family_score, 6),
        "active_family_count": len(active_families),
        "active_families": active_families,
        "families": families,
        "inactive_formal_models": sorted(set(inactive_models)),
        "inactive_lifecycle_models": sorted(set(inactive_lifecycle_models)),
        "lifecycle_weight_source": (
            "ensemble_v2.weights"
            if lifecycle_weights is not None
            else "ensemble_v2_required_missing" if require_lifecycle_weights else "model_output_fallback"
        ),
    }


def _merge_core_family_vote_evidence(row: dict, vote: dict[str, Any], rank: int, target_size: int) -> None:
    row["core_family_vote"] = vote
    row["watch_points"] = [
        *(row.get("watch_points") if isinstance(row.get("watch_points"), list) else []),
        f"core_family_rank:{rank}/{target_size}:score={vote.get('family_score')}",
    ]

    summary = row.get("ml_vote_summary")
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except json.JSONDecodeError:
            summary = {"text": row.get("ml_vote_summary")}
    if not isinstance(summary, dict):
        summary = {}
    summary["coreFamilyVote"] = {
        "schema_version": vote.get("schema_version"),
        "family_score": vote.get("family_score"),
        "active_family_count": vote.get("active_family_count"),
        "active_families": vote.get("active_families"),
        "inactive_formal_models": vote.get("inactive_formal_models"),
    }
    row["ml_vote_summary"] = summary

    components = row.get("score_components")
    if isinstance(components, str):
        components = _parse_score_components_payload(components) or {"raw": row.get("score_components")}
    if isinstance(components, dict):
        components["coreFamilyVote"] = vote
        row["score_components"] = components


def apply_core_family_rank(
    recommendations: list[dict],
    predictions: dict[str, dict],
    *,
    target_size: int | None = None,
    min_active_families: int = 2,
    strict: bool = True,
    require_lifecycle_weights: bool = False,
) -> list[dict]:
    """Rank Layer 2 shortlist with formal family votes and persist evidence."""
    if not recommendations:
        return []
    safe_target = target_size or len(recommendations)
    safe_target = max(1, min(80, int(safe_target)))

    ranked_rows: list[tuple[float, float, dict]] = []
    insufficient: list[str] = []
    for row in recommendations:
        symbol = str(row.get("symbol") or "")
        pred = predictions.get(symbol) if isinstance(predictions, dict) else None
        vote = build_core_family_vote(pred, require_lifecycle_weights=require_lifecycle_weights)
        if isinstance(pred, dict):
            pred["core_family_vote"] = vote
        if int(vote.get("active_family_count") or 0) < min_active_families:
            insufficient.append(symbol)
            continue
        ranked_rows.append((
            float(vote.get("family_score") or 0.0),
            float(row.get("score") or 0.0),
            {**row, "core_family_vote": vote},
        ))

    if strict and insufficient and len(insufficient) == len(recommendations):
        raise ValueError(
            "core_family_rank_requires_2_active_families: "
            f"{len(insufficient)}/{len(recommendations)} rows lack production family breadth"
        )
    if not ranked_rows:
        return sorted(recommendations, key=lambda row: float(row.get("score") or 0.0), reverse=True)[:safe_target]

    ranked_rows.sort(key=lambda item: (item[0], item[1]), reverse=True)
    selected = [row for _, _, row in ranked_rows[:safe_target]]
    for idx, row in enumerate(selected, start=1):
        row["rank"] = idx
        _merge_core_family_vote_evidence(row, row["core_family_vote"], idx, safe_target)
    return selected


def _allocation_method(policy: dict) -> str:
    allocation = policy.get("allocation") if isinstance(policy, dict) else {}
    value = (allocation or {}).get("engine") or (allocation or {}).get("method") or ""
    return str(value or "").strip()


def _row_expected_return(row: dict) -> float:
    for key in ("ml_forecast_pct", "forecast_pct", "expected_return", "predicted_return"):
        if key not in row or row.get(key) is None:
            continue
        try:
            value = float(row.get(key))
        except (TypeError, ValueError):
            value = 0.0
        if math.isfinite(value):
            return value
    return max(0.0, (float(row.get("score") or 0.0) - 50.0) / 5000.0)


def _apply_sparse_tangent_buy_selection(
    scored: list[dict],
    ranking_config: dict,
    policy: dict,
    *,
    confidence_floor: float,
    return_history: dict[str, list[float]] | None = None,
) -> list[dict]:
    allocation = policy.get("allocation") or {}
    buy_signal_count = int(allocation.get("buy_signal_count") or 3)
    buy_signal_count = max(1, min(30, buy_signal_count))
    risk_history = return_history or {}
    allocation_contract = {
        "engine": "sparse_tangent_inverse_risk",
        "allocation_method": "sparse_tangent_inverse_risk_final_allocation",
        "input_scope": "post_l3_5_evidence_fusion_candidates",
        "selection_policy": "positive_expected_edge_sparse_weights_no_forced_fill",
        "capacity_policy": "maximum_capacity_not_minimum_fill",
        "max_capacity_not_target": True,
        "hard_minimum_fill": False,
        "allows_empty_portfolio": True,
        "legacy_rank_topk_fallback_allowed": False,
        "buy_signal_count": buy_signal_count,
    }

    eligible_rows = [
        row for row in scored
        if _can_promote_ranking_candidate(row, ranking_config)
    ]
    eligible_row_ids = {id(row) for row in eligible_rows}
    controller = str(allocation.get("controller") or "OnlinePortfolioBandit").strip()
    for row in scored:
        had_buy_signal = str(row.get("signal") or "").upper() == "BUY" or int(row.get("has_buy_signal") or 0) == 1
        row["has_buy_signal"] = 0
        if had_buy_signal:
            if "signal_raw" not in row:
                row["signal_raw"] = row.get("signal")
            if "signal_source_raw" not in row:
                row["signal_source_raw"] = row.get("signal_source")
            row["signal"] = "HOLD"
            row["signal_source"] = "sparse_tangent_inverse_risk"
            row["ranking_promoted"] = False
            row["sparse_tangent_selected"] = False
            alpha_allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
            row["alpha_allocation"] = {
                **alpha_allocation,
                **allocation_contract,
                "selected": False,
                "controller": controller,
            }

    allocation_candidates = [
        {
            "symbol": row.get("symbol"),
            "score": row.get("score"),
            "expected_return": _row_expected_return(row),
        }
        for row in eligible_rows
    ]
    opb_packet: dict[str, Any] | None = None
    if controller == "OnlinePortfolioBandit":
        try:
            from services.online_portfolio_bandit import build_online_portfolio_bandit_l2_packet

            opb_packet = build_online_portfolio_bandit_l2_packet(
                candidates=allocation_candidates,
                return_history=risk_history,
                stage="L3_production_allocation_controller",
                candidate_cap_limit=(
                    None if allocation.get("allow_controller_candidate_cap") else buy_signal_count
                ),
            )
            weights = dict(((opb_packet.get("controlled_allocation") or {}).get("weights") or {}))
        except Exception as exc:  # noqa: BLE001 - allocator must fall back deterministically.
            logger.warning("[Ranking] OnlinePortfolioBandit controller failed; fallback sparse tangent: %s", exc)
            weights = {}
    else:
        weights = {}

    if not weights:
        # `buy_signal_count` is a max candidate capacity. Sparse tangent can
        # legally return empty/fewer weights when expected edge is not positive.
        weights = allocate_sparse_tangent(
            allocation_candidates,
            risk_history,
            top_k=buy_signal_count,
            max_weight=float(allocation.get("max_weight") or allocation.get("maxWeight") or 0.55),
        )
    selected_symbols = set(weights)
    selected_by_symbol = {row.get("symbol"): row for row in eligible_rows}
    history_coverage = sum(1 for symbol in selected_symbols if risk_history.get(symbol))

    for symbol, weight in weights.items():
        row = selected_by_symbol.get(symbol)
        if not row:
            continue
        if "signal_raw" not in row:
            row["signal_raw"] = row.get("signal")
        row["signal"] = "BUY"
        if "signal_source_raw" not in row:
            row["signal_source_raw"] = row.get("signal_source")
        row["signal_source"] = "sparse_tangent_inverse_risk"
        row["has_buy_signal"] = 1
        row["confidence"] = max(float(row.get("confidence") or 0.0), confidence_floor)
        row["allocation_weight"] = round(float(weight), 8)
        row["ranking_promoted"] = False
        row["sparse_tangent_selected"] = True
        alpha_allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
        row["alpha_allocation"] = {
            **alpha_allocation,
            **allocation_contract,
            "selected": True,
            "controller": controller,
            "allocation_weight": round(float(weight), 8),
            "return_history_coverage": history_coverage,
            "return_history_symbols": sorted(symbol for symbol in selected_symbols if risk_history.get(symbol)),
            "opb_controller": {
                "enabled": opb_packet is not None,
                "stage": opb_packet.get("stage") if opb_packet else None,
                "allocation_role": opb_packet.get("allocation_role") if opb_packet else None,
                "selection_policy": opb_packet.get("selection_policy") if opb_packet else None,
                "selected_arm": opb_packet.get("selected_arm") if opb_packet else None,
            },
        }
        watch_points = row.get("watch_points")
        if not isinstance(watch_points, list):
            watch_points = []
        watch_points.append(f"allocation:sparse_tangent_inverse_risk:{round(float(weight), 6)}")
        row["watch_points"] = watch_points

    for row in scored:
        if row.get("symbol") in selected_symbols:
            continue
        alpha_allocation = row.get("alpha_allocation")
        if isinstance(alpha_allocation, dict) or id(row) in eligible_row_ids:
            row["alpha_allocation"] = {
                **(alpha_allocation if isinstance(alpha_allocation, dict) else {}),
                **allocation_contract,
                "selected": False,
                "controller": controller,
            }

    logger.info(
        "[Ranking] sparse_tangent_inverse_risk selected "
        f"{len(selected_symbols)}/{buy_signal_count} capacity BUY rows: {sorted(selected_symbols)}"
    )
    return scored


def apply_sparse_tangent_allocation(
    recommendations: list[dict],
    ranking_config: dict,
    ensemble_v2_cfg: dict | None = None,
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    alpha_policy: dict | None = None,
    return_history: dict[str, list[float]] | None = None,
) -> list[dict]:
    """Run the production allocation owner after Score V2 + ML ranking.

    Legacy top-K promotion is retired. BUY rows are now owned by
    sparse_tangent_inverse_risk, optionally controlled by OnlinePortfolioBandit.
    """
    if not ranking_config or not ranking_config.get("enabled", True):
        return recommendations

    policy = normalize_alpha_policy(alpha_policy)
    promote_min_conf = ranking_config.get("promoteMinConf", 0.60)
    effective_boost = float(promote_min_conf)

    promotion_weights = ranking_config.get("scoreV2PromotionWeights") or {}
    score_v2_weight = float(promotion_weights.get("scoreV2", 0.80))
    ml_conf_weight = float(promotion_weights.get("mlConfidence", 0.15))
    signal_tier_weight = float(promotion_weights.get("signalTier", 0.05))
    weight_total = max(1e-9, score_v2_weight + ml_conf_weight + signal_tier_weight)

    # Compute combined_score for each.
    scored = []
    for r in recommendations:
        _require_canonical_score_v2_components(r)
        score_v2_norm = min(1.0, _score_v2_final_score_for_ranking(r) / 100.0)
        ml_conf = max(0.0, min(1.0, r.get("confidence") or 0))
        tier = _signal_tier(r.get("signal"))
        combined = (
            (score_v2_weight * score_v2_norm)
            + (ml_conf_weight * ml_conf)
            + (signal_tier_weight * tier)
        ) / weight_total
        r["_combined_score"] = combined
        r["_combined_score_source"] = "score_v2_final_score_plus_ml_tiebreak"
        scored.append(r)

    if _allocation_method(policy) != "sparse_tangent_inverse_risk":
        raise ValueError(
            "legacy_topk_allocation_retired: "
            "production recommendations require sparse_tangent_inverse_risk"
        )

    allocated = regime_aware_allocate(
        scored,
        regime_label,
        slate_size=max(int(policy["allocation"].get("buy_signal_count") or 3), policy["allocation"]["slate_size"]),
        policy=policy,
        regime_surface=regime_surface,
    )
    return _apply_sparse_tangent_buy_selection(
        allocated,
        ranking_config,
        policy,
        confidence_floor=effective_boost,
        return_history=return_history,
    )


# ─────────────────────────────────────────────────────────────────────────────
# D1 writers
# ─────────────────────────────────────────────────────────────────────────────

def write_predictions_to_d1(
    predictions: dict[str, dict],
    stock_id_map: dict[str, int],
    run_date: str | None = None,
) -> int:
    """
    Write predictions table.
    predictions: {symbol: ml_result}
    stock_id_map: {symbol: stock_id} from active stocks

    Returns count written.
    """
    statements: list[tuple[str, list[Any]]] = []
    inserted_rows = 0
    use_ev2 = _is_use_ensemble_v2()
    for symbol, data in predictions.items():
        if data.get("error"):
            continue
        stock_id = stock_id_map.get(symbol)
        if not stock_id:
            continue
        feature_version = _require_prediction_feature_version(str(symbol), data)
        sanitized_count = 0
        skipped_model_rows: list[str] = []
        # ML_POOL Plan A migration: ensemble_v2 (8-model w/ R1+R3) drives the
        # stored signal. Legacy 5-feature signal kept in forecast_data for audit.
        legacy_signal = data.get("signal") or "NO_SIGNAL"
        ev2 = data.get("ensemble_v2") or {}
        ev2_signal = ev2.get("signal")
        ev2_signal_source = ev2.get("signal_source") or "ensemble_v2"
        raw_signal = (ev2_signal if (use_ev2 and ev2_signal) else legacy_signal) or "NO_SIGNAL"
        if raw_signal == "NO_SIGNAL":
            trade_signal = None
        elif "BUY" in raw_signal:
            trade_signal = "buy"
        elif "SELL" in raw_signal:
            trade_signal = "sell"
        else:
            trade_signal = "hold"

        forecast_payload, replaced = _sanitize_non_finite({
            "signal": raw_signal,
            "legacy_signal": legacy_signal,                 # feature-model signal (audit trail)
            "ensemble_v2": data.get("ensemble_v2"),         # 8-model R1+R3 (audit trail)
            "signal_source": ev2_signal_source if (use_ev2 and ev2_signal) else "legacy",
            "alpha_context": data.get("alpha_context"),
            "alpha_allocation": data.get("alpha_allocation"),
            "core_ml_gate": data.get("core_ml_gate"),
            "core_family_vote": data.get("core_family_vote"),
            "gnn": data.get("gnn"),
            "timesfm": data.get("timesfm"),
            "state_space_overlays": _state_space_overlay_payload(data),
            "formal_layer3_blockers": data.get("formal_layer3_blockers"),
            "models": data.get("models"),
            "forecasts": data.get("forecasts"),
            "arf_features": data.get("arf_features"),
            "dispersion_diagnostics": data.get("dispersion_diagnostics"),
            "stock_meta": _enrich_stock_meta_with_segment_policy(data.get("stock_meta")),
        })
        sanitized_count += replaced
        forecast_data = json.dumps(forecast_payload, ensure_ascii=False)
        confidence, replaced = _sanitize_non_finite(data.get("confidence"))
        sanitized_count += replaced
        entry_price, replaced = _sanitize_non_finite(data.get("entry_price"))
        sanitized_count += replaced
        stop_loss, replaced = _sanitize_non_finite(data.get("stop_loss"))
        sanitized_count += replaced
        target1, replaced = _sanitize_non_finite(data.get("target1"))
        sanitized_count += replaced
        target2, replaced = _sanitize_non_finite(data.get("target2"))
        sanitized_count += replaced

        delete_date_sql, delete_date_params = _prediction_delete_date_expr(run_date)
        # H2: delete stale before insert
        statements.append((
            f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}='ensemble' "
            f"AND {delete_date_sql}",
            [stock_id, *delete_date_params],
        ))
        statements.append((
            f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}!='ensemble' "
            f"AND {delete_date_sql}",
            [stock_id, *delete_date_params],
        ))
        statements.append((
            INSERT_PREDICTIONS_SQL,
            [
                stock_id,
                run_date,
                14,
                confidence,
                forecast_data,
                entry_price,
                stop_loss,
                target1,
                target2,
                trade_signal,
                feature_version,
                raw_signal,
            ],
        ))
        inserted_rows += 1

        # 2026-04-19 ML_POOL Stage 2: per-model rows for weekly IC tracking.
        # Screener refactor: production writes only formal active/family slots;
        # legacy challenger side-channel scores are intentionally ignored.
        per_model_scores = _extract_per_model_scores_for_d1(data)
        for model_name, model_score in per_model_scores.items():
            safe_model_score, replaced = _sanitize_non_finite(model_score)
            sanitized_count += replaced
            if safe_model_score is None:
                skipped_model_rows.append(model_name)
                continue
            per_model_payload, replaced = _sanitize_non_finite(
                {
                    "signal": raw_signal,
                    "rank_score": safe_model_score,
                    "source": "model_pool_stage2",
                    "stock_meta": _enrich_stock_meta_with_segment_policy(data.get("stock_meta")),
                }
            )
            sanitized_count += replaced
            per_model_forecast = json.dumps(
                per_model_payload,
                ensure_ascii=False,
            )
            # Use INSERT with explicit model_name override (INSERT_PREDICTIONS_SQL
            # hardcodes 'ensemble'; build a parallel SQL for per-model name).
            statements.append((
                _build_per_model_insert_sql(),
                [
                    stock_id, model_name,
                    run_date,
                    14,                     # horizon
                    safe_model_score,       # direction_accuracy = rank_score
                    per_model_forecast,
                    entry_price,
                    stop_loss,
                    target1,
                    target2,
                    trade_signal,
                    feature_version,
                    raw_signal,
                ],
            ))
            inserted_rows += 1
        if sanitized_count or skipped_model_rows:
            logger.warning(
                "[recommendation_service] Sanitized %s non-finite values before D1 write for %s; skipped_model_rows=%s",
                sanitized_count,
                symbol,
                skipped_model_rows or "none",
            )

    if not statements:
        return 0
    d1_client.batch_execute(statements)
    # Count inserted rows explicitly because cleanup adds delete-only statements.
    logger.info(f"[recommendation_service] Wrote {inserted_rows} prediction rows to D1 (incl. per-model)")
    return inserted_rows


def write_layer3_formal_gate_audit(
    *,
    predictions: dict[str, dict],
    recommendations: list[dict],
    layer2_symbols: list[str],
    run_date: str,
    screener_run_id: str | None,
    target_size: int | None = None,
) -> int:
    """Persist formal L3 pass/drop evidence into screener_funnel_items."""
    run_id = str(screener_run_id or "").strip()
    if not run_id:
        logger.warning("[recommendation_service] L3 audit skipped: screener_run_id missing")
        return 0

    symbols = _dedupe_preserve_order([str(symbol or "").strip() for symbol in layer2_symbols])
    symbols = [symbol for symbol in symbols if symbol]
    if not symbols:
        logger.info("[recommendation_service] L3 audit skipped: no layer2 symbols")
        return 0

    final_by_symbol = {
        str(row.get("symbol") or ""): row
        for row in recommendations
        if row.get("symbol")
    }
    statements: list[tuple[str, list[Any]]] = [
        (
            "DELETE FROM screener_funnel_items WHERE run_id = ? AND date = ? AND stage = ?",
            [run_id, run_date, "layer3_formal_ml_gate"],
        )
    ]

    for idx, symbol in enumerate(symbols, start=1):
        pred = predictions.get(symbol) if isinstance(predictions, dict) else None
        final_row = final_by_symbol.get(symbol)
        vote = {}
        ev2 = {}
        if isinstance(pred, dict):
            vote = pred.get("core_family_vote") if isinstance(pred.get("core_family_vote"), dict) else {}
            ev2 = pred.get("ensemble_v2") if isinstance(pred.get("ensemble_v2"), dict) else {}
        decision = "pass" if final_row else "drop"
        active_family_count = int((vote or {}).get("active_family_count") or 0)
        if decision == "pass":
            reason_code = "formal_family_rank_pass"
        elif not isinstance(pred, dict):
            reason_code = "formal_family_prediction_missing"
        elif not ev2:
            reason_code = "formal_family_ensemble_v2_missing"
        elif active_family_count < 2:
            reason_code = "formal_family_insufficient_active_families"
        else:
            reason_code = "formal_family_rank_not_selected"

        evidence = {
            "schema_version": "layer3_formal_ml_gate_audit_v1",
            "source": "daily_pipeline_v2.apply_core_family_rank",
            "target_size": target_size,
            "layer2_count": len(symbols),
            "active_family_count": active_family_count,
            "active_families": (vote or {}).get("active_families") or [],
            "inactive_formal_models": (vote or {}).get("inactive_formal_models") or [],
            "inactive_lifecycle_models": (vote or {}).get("inactive_lifecycle_models") or [],
            "lifecycle_weight_source": (vote or {}).get("lifecycle_weight_source"),
            "contributing_models": ev2.get("contributing_models") if isinstance(ev2, dict) else [],
            "weights": ev2.get("weights") if isinstance(ev2, dict) else {},
        }
        try:
            score_after = float((vote or {}).get("family_score"))
        except (TypeError, ValueError):
            score_after = None
        source_row = final_row or {"symbol": symbol}
        try:
            score_before = float(source_row.get("score")) if source_row.get("score") is not None else None
        except (TypeError, ValueError):
            score_before = None

        statements.append((
            """
            INSERT INTO screener_funnel_items
              (run_id, date, symbol, name, stage, decision, reason_code,
               score_before, score_after, rank, evidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                run_id,
                run_date,
                symbol,
                source_row.get("name"),
                "layer3_formal_ml_gate",
                decision,
                reason_code,
                score_before,
                score_after,
                int(final_row.get("rank") or idx) if final_row else idx,
                json.dumps(evidence, ensure_ascii=False),
            ],
        ))

    d1_client.batch_execute(statements)
    inserted = len(statements) - 1
    logger.info(
        "[recommendation_service] Wrote %s L3 formal gate audit rows run_id=%s date=%s",
        inserted,
        run_id,
        run_date,
    )
    return inserted


# ─────────────────────────────────────────────────────────────────────────────
# 2026-04-19 ML_POOL Stage 2 helpers (per-model row writers)
# ─────────────────────────────────────────────────────────────────────────────

# Models whose rank scores we want stored for alpha IC tracking.
# State-space overlays explain regime/risk context rather than vote as alpha.
_PER_MODEL_TRACKED = (
    "XGBoost", "ExtraTrees", "LightGBM",
    "TabM", "GNN",
    "DLinear", "PatchTST", "iTransformer", "TimesFM",
)


def _extract_per_model_scores_for_d1(pred: dict) -> dict[str, float]:
    """Pull out per-model rank scores from one stock's prediction dict.

    For 5 feature models: read pred["rank_scores"][model_name] (raw 0~1
      from predict_stock_v2).
    For 3 time-series alpha predictors: sigmoid-map .forecast_pct → 0~1
      (mirror of pipeline_v2._ts_to_rank with scale=12).

    Returns formal active/family slots that have a usable score in the dict.
    """
    import math
    out: dict[str, float] = {}
    rank_scores = pred.get("rank_scores") or {}
    for name in ("XGBoost", "ExtraTrees", "LightGBM", "TabM", "GNN"):
        v = rank_scores.get(name)
        if v is not None:
            try:
                out[name] = float(v)
            except (TypeError, ValueError):
                pass
    # Time-series alpha predictors: forecast_pct → sigmoid rank.
    if "GNN" not in out:
        gnn_payload = pred.get("gnn") if isinstance(pred.get("gnn"), dict) else {}
        v = gnn_payload.get("rank_score")
        if v is not None:
            try:
                out["GNN"] = float(v)
            except (TypeError, ValueError):
                pass
    _SRC_KEY_MODEL = (
        ("dlinear",          "DLinear"),
        ("patchtst",         "PatchTST"),
        ("itransformer",     "iTransformer"),
        ("timesfm",          "TimesFM"),
    )
    for src_key, model_name in _SRC_KEY_MODEL:
        sig = pred.get(src_key) or {}
        fp = sig.get("forecast_pct")
        if fp is None:
            continue
        try:
            out[model_name] = 1.0 / (1.0 + math.exp(-float(fp) * 12.0))
        except (TypeError, ValueError, OverflowError):
            pass
    return out


def _build_per_model_insert_sql() -> str:
    """Same contract as INSERT_PREDICTIONS_SQL but accepts model_name as parameter."""
    return f"""
INSERT INTO predictions (
    {COL_STOCK_ID}, {COL_MODEL_NAME}, {COL_GENERATED_AT}, {COL_PREDICTION_DATE}, {COL_HORIZON}, {COL_DIRECTION_ACCURACY},
    {COL_FORECAST_DATA}, {COL_ENTRY_PRICE}, {COL_STOP_LOSS}, {COL_TARGET1}, {COL_TARGET2},
    {COL_TRADE_SIGNAL}, {COL_FEATURE_VERSION}, {COL_SIGNAL_RAW}
) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()


def _existing_recommendation_seed_stock_ids(recommendations: list[dict], run_date: str) -> set[int]:
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return set()
    existing: set[int] = set()
    chunk_size = 80
    for i in range(0, len(stock_ids), chunk_size):
        chunk = stock_ids[i:i + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = d1_client.query(
            f"""
            WITH latest_screener_run AS (
                SELECT run_id
                  FROM screener_funnel_runs
                 WHERE date = ?
                   AND status = 'success'
                 ORDER BY created_at DESC
                 LIMIT 1
            )
            SELECT dr.stock_id
              FROM daily_recommendations dr
              JOIN screener_funnel_items sfi
                ON sfi.run_id = (SELECT run_id FROM latest_screener_run)
               AND sfi.symbol = dr.symbol
               AND (
                    (sfi.stage IN ('layer2_coarse_ml_gate', 'strategy_pool_ml_queue') AND sfi.decision = 'pass')
                 OR (sfi.stage IN ('l1_candidate_seed_after_overlay', 'final_selection') AND sfi.decision = 'selected')
               )
             WHERE dr.date = ?
               AND dr.stock_id IN ({placeholders})
            """,
            [run_date, run_date, *chunk],
        )
        existing.update(int(row["stock_id"]) for row in rows if row.get("stock_id") is not None)
    return existing


def _assert_recommendation_seed_rows_exist(recommendations: list[dict], run_date: str) -> set[int]:
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return set()
    existing = _existing_recommendation_seed_stock_ids(recommendations, run_date)
    if not existing:
        raise RuntimeError(
            "Missing screener-owned daily_recommendations seed rows for "
            f"run_date={run_date}: {stock_ids[:10]} (missing={len(stock_ids)}/{len(stock_ids)})"
        )
    return existing


def _filter_to_existing_recommendation_seed_rows(recommendations: list[dict], run_date: str) -> list[dict]:
    """Return rows that are still owned by the screener seed table.

    The pipeline may produce ML-only promotion rows that were not in the
    screener-owned daily_recommendations seed set. Those rows should remain in
    prediction/model evidence, but must not abort the post-market chain or
    create controller-owned daily_recommendations rows.
    """
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return recommendations
    existing = _assert_recommendation_seed_rows_exist(recommendations, run_date)
    missing = [sid for sid in stock_ids if sid not in existing]
    if missing:
        logger.warning(
            "[recommendation_service] Skipping %s ML-only recommendation rows without screener seed for run_date=%s: %s",
            len(missing),
            run_date,
            missing[:10],
        )
    return [r for r in recommendations if r.get("stock_id") and int(r["stock_id"]) in existing]


def _delete_stale_recommendation_rows(recommendations: list[dict], run_date: str) -> int:
    """Keep only rows owned by the latest screener candidate seed for run_date."""
    if not recommendations:
        return 0
    rows = d1_client.query(
        """
        WITH latest_screener_run AS (
            SELECT run_id
              FROM screener_funnel_runs
             WHERE date = ?
               AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
        )
        SELECT dr.stock_id
          FROM daily_recommendations dr
         WHERE dr.date = ?
           AND COALESCE(dr.recommendation_lane, 'tradable') = 'tradable'
           AND COALESCE(dr.eligible_for_ml, 1) = 1
           AND NOT EXISTS (
             SELECT 1
               FROM screener_funnel_items sfi
             WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                AND sfi.symbol = dr.symbol
                AND (
                     (sfi.stage IN ('layer2_coarse_ml_gate', 'strategy_pool_ml_queue') AND sfi.decision = 'pass')
                  OR (sfi.stage IN ('l1_candidate_seed_after_overlay', 'final_selection') AND sfi.decision = 'selected')
                )
           )
        """,
        [run_date, run_date],
        timeout=60,
    )
    if not rows:
        run = d1_client.query(
            """
            SELECT run_id
              FROM screener_funnel_runs
             WHERE date = ?
               AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
            """,
            [run_date],
            timeout=60,
        )
        if not run:
            logger.warning(
                "[recommendation_service] No latest screener candidate-seed run for run_date=%s; skip stale cleanup",
                run_date,
            )
        return 0
    stale_ids = sorted({
        int(row["stock_id"])
        for row in rows or []
        if row.get("stock_id") is not None
    })
    changes = 0
    for chunk in _chunked(stale_ids):
        placeholders = ",".join("?" for _ in chunk)
        result = d1_client.execute(
            f"DELETE FROM daily_recommendations WHERE date = ? AND stock_id IN ({placeholders})",
            [run_date, *chunk],
            timeout=60,
        )
        changes += int(((result or {}).get("meta") or {}).get("changes") or 0)
    if changes:
        logger.warning(
            "[recommendation_service] Deleted %s daily_recommendations rows outside latest screener candidate seed for run_date=%s",
            changes,
            run_date,
        )
    return changes


def update_recommendations_in_d1(
    recommendations: list[dict],
    run_date: str,
) -> int:
    """
    Update screener-owned daily_recommendations rows with ML fields.

    Screener is the only owner allowed to create seed rows. The pipeline must
    fail fast when the source-of-truth seed is missing instead of silently
    creating controller-owned fallback rows.
    """
    if not recommendations:
        return 0

    recommendations = _filter_to_existing_recommendation_seed_rows(recommendations, run_date)
    if not recommendations:
        return 0
    _delete_stale_recommendation_rows(recommendations, run_date)

    statements: list[tuple[str, list[Any]]] = []
    for idx, r in enumerate(recommendations, start=1):
        score_seed_inputs = _score_v2_seed_inputs(r)
        chip_flow_seed, replaced_chip_seed = _sanitize_non_finite(score_seed_inputs["chipFlowSeed40"])
        technical_seed, replaced_technical_seed = _sanitize_non_finite(score_seed_inputs["technicalSeed30"])
        screener_momentum_seed, replaced_momentum_seed = _sanitize_non_finite(score_seed_inputs["screenerMomentumSeed20"])
        ml_score, replaced_ml = _sanitize_non_finite(score_seed_inputs["mlEdgeSeed30"])
        score, replaced_score = _sanitize_non_finite(r.get("score") or 0)
        confidence, replaced_conf = _sanitize_non_finite(r.get("confidence"))
        current_price, replaced_price = _sanitize_non_finite(r.get("current_price"))
        foreign_net_5d, replaced_foreign = _sanitize_non_finite(r.get("foreign_net_5d") or 0)
        trust_net_5d, replaced_trust = _sanitize_non_finite(r.get("trust_net_5d") or 0)
        rsi14, replaced_rsi = _sanitize_non_finite(r.get("rsi14"))
        macd_hist, replaced_macd = _sanitize_non_finite(r.get("macd_hist"))
        watch_points, replaced_watch = _sanitize_non_finite(r.get("watch_points") or [])
        alpha_context, replaced_alpha_context = _sanitize_non_finite(r.get("alpha_context"))
        alpha_allocation, replaced_alpha_allocation = _sanitize_non_finite(r.get("alpha_allocation"))
        ml_vote_summary, replaced_ml_vote_summary = _sanitize_non_finite(r.get("ml_vote_summary"))
        score_components, replaced_score_components = _sanitize_non_finite(r.get("score_components"))
        if isinstance(score_components, dict) and score_components.get("version") == SCORE_V2_VERSION:
            score = _score_number(
                score_components.get("finalScore", score_components.get("total")),
                score,
            )
        sanitized_count = (
            replaced_chip_seed
            + replaced_technical_seed
            + replaced_momentum_seed
            + replaced_ml
            + replaced_score
            + replaced_conf
            + replaced_price
            + replaced_foreign
            + replaced_trust
            + replaced_rsi
            + replaced_macd
            + replaced_watch
            + replaced_alpha_context
            + replaced_alpha_allocation
            + replaced_ml_vote_summary
            + replaced_score_components
        )
        if sanitized_count:
            logger.warning(
                "[recommendation_service] Sanitized %s non-finite recommendation values before D1 update for %s",
                sanitized_count,
                r["symbol"],
            )
        stock_id = r.get("stock_id")
        if not stock_id:
            logger.warning("[recommendation_service] Skip recommendation without stock_id: %s", r.get("symbol"))
            continue
        statements.append((
            """
            UPDATE daily_recommendations SET
                symbol=?,
                name=?,
                sector=?,
                rank=?,
                score=?,
                signal=?,
                confidence=?,
                reason=?,
                watch_points=?,
                has_buy_signal=?,
                current_price=?,
                foreign_net_5d=?,
                trust_net_5d=?,
                rsi14=?,
                macd_hist=?,
                chip_score=?,
                tech_score=?,
                momentum_score=?,
                ml_score=?,
                industry=?,
                market_segment=?,
                recommendation_lane=?,
                eligible_for_ml=?,
                eligible_for_pending_buy=?,
                alpha_context=?,
                alpha_allocation=?,
                ml_vote_summary=?,
                score_components=?
            WHERE date=? AND stock_id=?
            """.strip(),
            [
                r["symbol"],
                r.get("name") or r["symbol"],
                r.get("sector"),
                r.get("rank") or idx,
                score,
                r.get("signal"),
                confidence,
                r.get("reason") or "pipeline_reason_unavailable",
                json.dumps(watch_points, ensure_ascii=False),
                r.get("has_buy_signal") or 0,
                current_price,
                foreign_net_5d,
                trust_net_5d,
                rsi14,
                macd_hist,
                chip_flow_seed,
                technical_seed,
                screener_momentum_seed,
                ml_score,
                r.get("industry"),
                r.get("market_segment") or "UNKNOWN",
                r.get("recommendation_lane") or "tradable",
                1 if r.get("eligible_for_ml", True) else 0,
                1 if r.get("eligible_for_pending_buy", True) else 0,
                json.dumps(alpha_context, ensure_ascii=False) if alpha_context is not None else None,
                json.dumps(alpha_allocation, ensure_ascii=False) if alpha_allocation is not None else None,
                json.dumps(ml_vote_summary, ensure_ascii=False) if ml_vote_summary is not None else None,
                json.dumps(score_components, ensure_ascii=False) if score_components is not None else None,
                run_date,
                stock_id,
            ],
        ))

    if not statements:
        return 0
    result = d1_client.batch_execute(statements)
    changes = int(result if isinstance(result, int) else (result or {}).get("changes_total") or 0)
    if changes < len(statements):
        raise RuntimeError(
            f"Recommendation update touched {changes}/{len(statements)} rows; "
            "screener seed ownership may be broken"
        )
    logger.info(f"[recommendation_service] Updated {len(statements)} daily_recommendations rows")
    return len(statements)


def delete_filtered_recommendations(filtered_symbols: list[str], run_date: str) -> int:
    """Preserve screener-owned rows and mark ML-filtered symbols as non-buy."""
    if not filtered_symbols:
        return 0
    statements = [
        (
            """
            UPDATE daily_recommendations
               SET signal = 'HOLD',
                   has_buy_signal = 0,
                   watch_points = CASE
                     WHEN json_valid(watch_points) THEN json_insert(
                       watch_points,
                       '$[#]',
                       'ml_filter:preserved_screener_seed_not_buy'
                     )
                     ELSE json_array('ml_filter:preserved_screener_seed_not_buy')
                   END
             WHERE date = ? AND symbol = ?
            """.strip(),
            [run_date, sym],
        )
        for sym in filtered_symbols
    ]
    d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Preserved {len(filtered_symbols)} ML-filtered screener seed rows")
    return len(filtered_symbols)


def re_rank_recommendations(run_date: str) -> None:
    """Re-rank daily_recommendations after filter+promotion.

    The pipeline writes rows in allocation order. Keep that rank as the primary
    ordering so slate diversification does not need to inflate predictive score.
    """
    rows = d1_client.query(
        "SELECT symbol FROM daily_recommendations WHERE date = ? "
        "ORDER BY rank ASC, CASE WHEN json_valid(score_components) THEN "
        "COALESCE(CAST(json_extract(score_components, '$.finalScore') AS REAL), "
        "CAST(json_extract(score_components, '$.total') AS REAL), 0) ELSE 0 END DESC",
        [run_date],
    )
    statements = [
        ("UPDATE daily_recommendations SET rank = ? WHERE date = ? AND symbol = ?",
         [i + 1, run_date, r["symbol"]])
        for i, r in enumerate(rows)
    ]
    if statements:
        d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Re-ranked {len(statements)} rows")


def merge_llm_reasons_into_recommendations(
    recommendations: list[dict],
    llm_reasons: dict[str, dict],
) -> None:
    """Apply LLM-generated reasons in-place. Falls back to template if LLM missing."""
    if not llm_reasons:
        return
    for r in recommendations:
        sym = r["symbol"]
        if sym in llm_reasons:
            entry = llm_reasons[sym]
            if entry.get("reason"):
                r["reason"] = entry["reason"]
            if entry.get("watchPoints"):
                llm_points = [p for p in entry["watchPoints"] if isinstance(p, str) and p.strip()]
                domain_points = [
                    p for p in (r.get("watch_points") or [])
                    if isinstance(p, str)
                    and (
                        p.startswith("Alpha bucket:")
                        or p.startswith("Alpha overlay:")
                        or p.startswith("Market structure:")
                        or p.startswith("Market structure unavailable:")
                        or p.startswith("ML ensemble:")
                    )
                ]
                r["watch_points"] = llm_points + domain_points


def merge_breeze2_reason_shadow_into_score_components(
    recommendations: list[dict],
    breeze2_shadow: dict[str, dict],
) -> None:
    """Persist Breeze2 as a side-by-side Score V2 reason variant.

    This keeps Gemini/primary reasons authoritative for the card headline while
    exposing Breeze2's advisory-only text for UI comparison.
    """
    if not breeze2_shadow:
        return
    for row in recommendations:
        symbol = str(row.get("symbol") or "").strip()
        entry = breeze2_shadow.get(symbol)
        if not isinstance(entry, dict):
            continue
        reason = str(entry.get("reason") or "").strip()
        if not reason:
            continue
        payload = _parse_score_components_payload(row.get("score_components"))
        if not payload:
            continue
        variants = payload.get("reasonVariants")
        if not isinstance(variants, dict):
            variants = {}
        watch_points = [
            str(point).strip()
            for point in (entry.get("watchPoints") or [])
            if isinstance(point, str) and point.strip()
        ][:5]
        variants["breeze2"] = {
            "source": str(entry.get("source") or "breeze2_shadow"),
            "decision_effect": "advisory_only",
            "reason": reason[:700],
            "watchPoints": watch_points,
            "breeze2_context": str(entry.get("breeze2_context") or "unknown"),
            "riskFlags": [str(flag) for flag in (entry.get("riskFlags") or []) if flag][:8],
        }
        payload["reasonVariants"] = variants
        row["score_components"] = payload
