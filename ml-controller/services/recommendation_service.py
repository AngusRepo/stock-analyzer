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
from services.market_segment_policy import normalize_segment, policy_for_segment

logger = logging.getLogger(__name__)


def _prediction_delete_date_expr(run_date: str | None) -> tuple[str, list[Any]]:
    """Align prediction dedupe with the pipeline business date when available."""
    if run_date:
        return f"{COL_PREDICTION_DATE} = ?", [run_date]
    return f"{COL_PREDICTION_DATE} = date('now', '+8 hours')", []


def prune_predictions_outside_universe(stock_ids: list[int], run_date: str) -> int:
    """Remove same-date prediction rows that no longer belong to the current V2 universe."""
    safe_ids = [int(stock_id) for stock_id in stock_ids if stock_id]
    if safe_ids:
        placeholders = ",".join("?" for _ in safe_ids)
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ? AND {COL_STOCK_ID} NOT IN ({placeholders})",
            [run_date, *safe_ids],
            timeout=60,
        )
    else:
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ?",
            [run_date],
            timeout=60,
        )
    return int(((result or {}).get("meta") or {}).get("changes") or 0)


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
        if source in {"ensemble_v2_topk_policy", "ranking_promotion"} and not contributors:
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
    return round(score * 10) / 10


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

    if source in {"ranking_promotion", "ensemble_v2_topk_policy"} or (ml or {}).get("topk_forced"):
        raw = eff_ml.get("signal_raw") or ev2.get("signal_raw") or "HOLD"
        avg_rank = ev2.get("avg_rank")
        avg_rank_text = f"{float(avg_rank):.3f}" if isinstance(avg_rank, Real) else "n/a"
        return f"排名補位候選（原始訊號 {raw}，V2 rank={avg_rank_text}，校準預期 {forecast_text}），需等 T2/debate 與盤前價格確認"

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
        "XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
        "Chronos", "DLinear", "PatchTST",
    ]
    weights = ev2.get("weights") if isinstance(ev2.get("weights"), dict) else {}
    active_weight_count = 0
    for value in weights.values():
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
        if isinstance(detail, dict) and str(detail.get("validation_status") or "").upper() == "FAIL"
    ]

    model_scores: dict[str, float] = {}
    rank_scores = (ml or {}).get("rank_scores") or {}
    if isinstance(rank_scores, dict):
        for name in tracked[:5]:
            try:
                if rank_scores.get(name) is not None:
                    model_scores[name] = float(rank_scores[name])
            except (TypeError, ValueError):
                continue
    for src_key, model_name in (("chronos", "Chronos"), ("dlinear", "DLinear"), ("patchtst", "PatchTST")):
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
            "contributingModels": ev2.get("contributing_models") or [],
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


def _round1(value: float) -> float:
    return round(float(value) * 10) / 10


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


def _score_v2_components_from_row(row: dict) -> dict[str, float]:
    payload = row.get("score_components")
    if isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION and isinstance(payload.get("components"), dict):
        components = payload["components"]
        return {
            "mlEdge": _clamp_score(components.get("mlEdge"), SCORE_V2_WEIGHTS["mlEdge"]),
            "chipFlow": _clamp_score(components.get("chipFlow"), SCORE_V2_WEIGHTS["chipFlow"]),
            "technicalStructure": _clamp_score(components.get("technicalStructure"), SCORE_V2_WEIGHTS["technicalStructure"]),
            "fundamentalQuality": _clamp_score(components.get("fundamentalQuality"), SCORE_V2_WEIGHTS["fundamentalQuality"]),
            "newsTheme": _clamp_score(components.get("newsTheme"), SCORE_V2_WEIGHTS["newsTheme"]),
        }
    return {
        "mlEdge": _rescale_score(row.get("ml_score"), 30, SCORE_V2_WEIGHTS["mlEdge"]),
        "chipFlow": _rescale_score(row.get("chip_score"), 40, SCORE_V2_WEIGHTS["chipFlow"]),
        "technicalStructure": _rescale_score(
            _score_number(row.get("tech_score")) + _score_number(row.get("momentum_score")),
            50,
            SCORE_V2_WEIGHTS["technicalStructure"],
        ),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }


def _score_v2_technical_breakdown(row: dict, target: float) -> dict[str, float]:
    maxima = {
        "trendStructure": 7.0,
        "volatilityStructure": 5.0,
        "reversalExtreme": 5.0,
        "volumeConfirmation": 6.0,
        "executionRisk": 2.0,
    }
    target = _clamp_score(target, SCORE_V2_WEIGHTS["technicalStructure"])

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

    detailed_values = [plus_di, minus_di, adx, atr, sar, cci, vw_rsi, vmd]
    if not any(value is not None for value in detailed_values):
        return {
            "trendStructure": _rescale_score(row.get("tech_score"), 30, maxima["trendStructure"]),
            "volatilityStructure": 0.0,
            "reversalExtreme": 0.0,
            "volumeConfirmation": _rescale_score(row.get("momentum_score"), 20, maxima["volumeConfirmation"]),
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

    if natr is not None:
        if 1.0 <= natr <= 4.0:
            raw["volatilityStructure"] += 5.0
        elif 0.5 <= natr <= 6.0:
            raw["volatilityStructure"] += 3.0
        elif natr > 0:
            raw["volatilityStructure"] += 1.0

    if sar is not None and current_price is not None and current_price > sar:
        raw["reversalExtreme"] += 2.0
    if cci is not None:
        raw["reversalExtreme"] += 2.0 if -100 <= cci <= 150 else 1.0
    if rsi is not None and 35 <= rsi <= 75:
        raw["reversalExtreme"] += 1.0

    if vmd is not None and vmd > 0:
        raw["volumeConfirmation"] += 3.0
    if vw_rsi is not None:
        raw["volumeConfirmation"] += 2.0 if 55 <= vw_rsi <= 80 else 1.0 if vw_rsi > 80 else 0.0
    raw["volumeConfirmation"] += _rescale_score(row.get("momentum_score"), 20, 1.0)

    if rsi is not None and 35 <= rsi <= 75:
        raw["executionRisk"] += 1.0
    if natr is None or natr <= 6.0:
        raw["executionRisk"] += 1.0

    clamped = {key: _clamp_score(value, maxima[key]) for key, value in raw.items()}
    raw_sum = sum(clamped.values())
    if raw_sum <= 0 or target <= 0:
        return {key: 0.0 for key in maxima}
    scale = target / raw_sum
    return {key: _clamp_score(value * scale, maxima[key]) for key, value in clamped.items()}


def build_score_components(row: dict, *, raw_score: float, alpha_policy: dict | None = None) -> dict[str, Any]:
    """Persist canonical Score V2 payload; old scalar fields are storage inputs only."""
    alpha_context = row.get("alpha_context") or {}
    alpha_adjustment = alpha_context.get("score_adjustment") if isinstance(alpha_context, dict) else 0
    chip_score = _score_number(row.get("chip_score"))
    tech_score = _score_number(row.get("tech_score"))
    momentum_score = _score_number(row.get("momentum_score"))
    ml_score = _score_number(row.get("ml_score"))
    persona_score = _score_number(row.get("persona_score"))
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
        },
        "riskFlags": list(dict.fromkeys(str(flag) for flag in risk_flags if flag)),
        "reasons": [],
        "legacyComponents": {
            "chip": chip_score,
            "tech": tech_score,
            "screenerMomentum": momentum_score,
            "ml": ml_score,
            "persona": persona_score,
        },
        "rawScore": raw_score,
        "alphaAdjustment": alpha_adjustment or 0,
        "finalScore": final_score,
        "formula": "score_v2_total + alphaAdjustment",
        "alphaReason": alpha_reason,
    }
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
        payload = build_score_components(s, raw_score=_score_number(s.get("score")))
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
        chip_context = "emerging broker chip proxy unavailable"
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
        points.append("興櫃籌碼採 FinLab 券商分點 proxy；不可與上市櫃三大法人直接同比")
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
    # BUY/SELL gate. Default True = use ensemble_v2 (8 alpha models
    # with R1+R3 lifecycle weights). KV override:
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
        chip_score = rec.get("chip_score") or 0
        tech_score = rec.get("tech_score") or 0
        momentum_score = rec.get("momentum_score") or 0

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
                        persona_applied = {
                            "trust_signal": trust.signal, "trust_strength": trust.strength,
                            "retail_signal": retail.signal, "retail_strength": retail.strength,
                        }
                except Exception as e:
                    logger.debug(f"[reco] persona_score failed for {symbol}: {e}")

        total_score = round((chip_score + tech_score + ml_score + persona_score) * 10) / 10

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
            "industry": rec.get("industry"),
            "chip_score": chip_score,
            "tech_score": tech_score,
            "momentum_score": momentum_score,
            "ml_score": ml_score,
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
        }
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


def hybrid_ranking_promotion(
    recommendations: list[dict],
    ranking_config: dict,
    ensemble_v2_cfg: dict | None = None,
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    alpha_policy: dict | None = None,
) -> list[dict]:
    """
    Sprint 3 P0-4: combined_score = α*screener_norm + β*ml_conf + γ*signal_tier
    若 has_buy_signal < topK，從 has_buy_signal=0 pool 挑 top promote。

    #B Option 1 (2026-04-21): promoted rows now also get signal="BUY" and a
    higher conf floor (ensemble_v2.topKConfidenceOverride, default 0.72). Prior
    code only flipped has_buy_signal=1 and nudged conf to 0.60 while leaving
    signal="HOLD" — downstream batch debate saw HOLD+0.60 edge candidates and
    mostly REJECTed, producing 0 pending buys for 4 consecutive trading days.
    """
    if not ranking_config or not ranking_config.get("enabled", True):
        return recommendations

    alpha = ranking_config.get("alpha", 0.40)
    beta = ranking_config.get("beta", 0.40)
    gamma = ranking_config.get("gamma", 0.20)
    top_k = ranking_config.get("topK", 3)
    policy = normalize_alpha_policy(alpha_policy)
    promote_min_conf = ranking_config.get("promoteMinConf", 0.60)
    boost_conf = float((ensemble_v2_cfg or {}).get("topKConfidenceOverride", 0.72))
    # Always use the higher of KV-driven ranking.promoteMinConf and ensemble_v2
    # boost — pick max so neither config can silently regress the other.
    effective_boost = max(float(promote_min_conf), boost_conf)

    # Compute combined_score for each
    scored = []
    for r in recommendations:
        score_v2 = _score_v2_components_from_row(r)
        screener_norm = min(
            1.0,
            (score_v2["chipFlow"] + score_v2["technicalStructure"])
            / (SCORE_V2_WEIGHTS["chipFlow"] + SCORE_V2_WEIGHTS["technicalStructure"]),
        )
        ml_conf = max(0.0, min(1.0, r.get("confidence") or 0))
        tier = _signal_tier(r.get("signal"))
        combined = alpha * screener_norm + beta * ml_conf + gamma * tier
        r["_combined_score"] = combined
        scored.append(r)

    current_buy = sum(1 for r in scored if r.get("has_buy_signal") == 1)
    controller_policy_syms = [
        r.get("symbol")
        for r in scored
        if r.get("signal_source") == "ensemble_v2_topk_policy" or r.get("topk_forced")
    ]
    if controller_policy_syms:
        logger.info(
            f"[Ranking] controller top-K policy already promoted {len(controller_policy_syms)} rows; "
            f"skip recommendation-layer promotion: {controller_policy_syms}"
        )
        return regime_aware_allocate(scored, regime_label, slate_size=max(top_k, policy["allocation"]["slate_size"]), policy=policy, regime_surface=regime_surface)
    if current_buy >= top_k:
        logger.info(f"[Ranking] has_buy_signal={current_buy} >= topK={top_k}, no promotion")
        return regime_aware_allocate(scored, regime_label, slate_size=max(top_k, policy["allocation"]["slate_size"]), policy=policy, regime_surface=regime_surface)

    need_promote = top_k - current_buy
    pool = sorted(
        [r for r in scored if r.get("has_buy_signal") == 0 and _can_promote_ranking_candidate(r, ranking_config)],
        key=lambda x: x.get("_combined_score", 0),
        reverse=True,
    )[:need_promote]

    promoted_syms = []
    for r in pool:
        r["signal_raw"] = r.get("signal")  # preserve pre-promotion for audit
        r["signal"] = "BUY"                 # make downstream "BUY" checks pass
        r["signal_source_raw"] = r.get("signal_source")
        r["signal_source"] = "ranking_promotion"
        r["has_buy_signal"] = 1
        r["confidence"] = max(r.get("confidence") or 0, effective_boost)
        r["ranking_promoted"] = True
        promoted_syms.append(r["symbol"])

    if promoted_syms:
        logger.info(
            f"[Ranking] Promoted {len(promoted_syms)} to signal=BUY "
            f"has_buy_signal=1 conf>={effective_boost} "
            f"(current={current_buy} < topK={top_k}): {promoted_syms}"
        )
    return regime_aware_allocate(scored, regime_label, slate_size=max(top_k, policy["allocation"]["slate_size"]), policy=policy, regime_surface=regime_surface)


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
                data.get("feature_version"),
                raw_signal,
            ],
        ))
        inserted_rows += 1

        # 2026-04-19 ML_POOL Stage 2: per-model rows for weekly IC tracking.
        # Stages 2+3: active rows model_name='{name}'; challenger rows
        # model_name='{name}::challenger' (Stage 3 shadow IC tracking).
        per_model_scores = _extract_per_model_scores_for_d1(data)
        # Stage 3: extract challenger scores from feature and pipeline_v2
        # time-series alpha challenger shadow predictions.
        challenger_scores = data.get("challenger_rank_scores") or {}
        for ch_name, ch_score in (challenger_scores or {}).items():
            try:
                per_model_scores[f"{ch_name}::challenger"] = float(ch_score)
            except (TypeError, ValueError):
                pass
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
                    data.get("feature_version"),
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


# ─────────────────────────────────────────────────────────────────────────────
# 2026-04-19 ML_POOL Stage 2 helpers (per-model row writers)
# ─────────────────────────────────────────────────────────────────────────────

# Models whose rank scores we want stored for alpha IC tracking.
# State-space overlays explain regime/risk context rather than vote as alpha.
_PER_MODEL_TRACKED = (
    "XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
    "Chronos", "DLinear", "PatchTST",
)


def _extract_per_model_scores_for_d1(pred: dict) -> dict[str, float]:
    """Pull out per-model rank scores from one stock's prediction dict.

    For 5 feature models: read pred["rank_scores"][model_name] (raw 0~1
      from predict_stock_v2).
    For 3 time-series alpha predictors: sigmoid-map .forecast_pct → 0~1
      (mirror of pipeline_v2._ts_to_rank with scale=12).

    Returns subset of _PER_MODEL_TRACKED that have a usable score in the dict.
    """
    import math
    out: dict[str, float] = {}
    rank_scores = pred.get("rank_scores") or {}
    for name in ("XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"):
        v = rank_scores.get(name)
        if v is not None:
            try:
                out[name] = float(v)
            except (TypeError, ValueError):
                pass
    # Time-series alpha predictors: forecast_pct → sigmoid rank.
    _SRC_KEY_MODEL = (
        ("chronos",          "Chronos"),
        ("dlinear",          "DLinear"),
        ("patchtst",         "PatchTST"),
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
    """Like INSERT_PREDICTIONS_SQL but accepts model_name as parameter."""
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
            f"SELECT stock_id FROM daily_recommendations WHERE date=? AND stock_id IN ({placeholders})",
            [run_date, *chunk],
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
    """Keep the run-date recommendation set owned by the current pipeline output."""
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return 0
    placeholders = ",".join("?" for _ in stock_ids)
    result = d1_client.execute(
        f"DELETE FROM daily_recommendations WHERE date = ? AND stock_id NOT IN ({placeholders})",
        [run_date, *stock_ids],
        timeout=60,
    )
    changes = int(((result or {}).get("meta") or {}).get("changes") or 0)
    if changes:
        logger.warning(
            "[recommendation_service] Deleted %s stale daily_recommendations rows for run_date=%s",
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
        ml_score, replaced_ml = _sanitize_non_finite(r.get("ml_score") or 0)
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
            replaced_ml
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
                r.get("chip_score") or 0,
                r.get("tech_score") or 0,
                r.get("momentum_score") or 0,
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
    """Delete daily_recommendations rows where symbol in filtered list (SELL/NO_SIGNAL)."""
    if not filtered_symbols:
        return 0
    statements = [
        ("DELETE FROM daily_recommendations WHERE date = ? AND symbol = ?",
         [run_date, sym])
        for sym in filtered_symbols
    ]
    d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Deleted {len(filtered_symbols)} filtered rows")
    return len(filtered_symbols)


def re_rank_recommendations(run_date: str) -> None:
    """Re-rank daily_recommendations after filter+promotion.

    The pipeline writes rows in allocation order. Keep that rank as the primary
    ordering so slate diversification does not need to inflate predictive score.
    """
    rows = d1_client.query(
        "SELECT symbol FROM daily_recommendations WHERE date = ? ORDER BY rank ASC, score DESC",
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
