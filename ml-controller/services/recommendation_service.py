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
        return f"COALESCE({COL_PREDICTION_DATE}, date({COL_GENERATED_AT}, '+8 hours')) = ?", [run_date]
    return f"date({COL_GENERATED_AT}) = date('now')", []


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
            "forecast_pct": 0.0,
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
            forecast_pct = ev2.get("forecast_pct") if ev2.get("forecast_pct") is not None else legacy_forecast
            return {
                "signal": ev2.get("signal"),
                "confidence": confidence,
                "forecast_pct": forecast_pct,
                "signal_source": ev2.get("signal_source") or "ensemble_v2",
                "signal_raw": ev2.get("signal_raw") or legacy_signal,
            }

    return {
        "signal": legacy_signal,
        "confidence": legacy_conf,
        "forecast_pct": legacy_forecast,
        "signal_source": "legacy",
        "signal_raw": legacy_signal,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Template reason / watch_points (port from dailyRecommendation.ts:406-494)
# ─────────────────────────────────────────────────────────────────────────────

def build_reason(s: dict) -> str:
    """三面向：籌碼 → 技術 → ML"""
    # ── 籌碼面 ──
    consec = s.get("foreign_consecutive") or 0
    fnet = s.get("foreign_net_5d") or 0
    tnet = s.get("trust_net_5d") or 0
    net_amount = (fnet + tnet) / 1e8

    if consec >= 5 and net_amount > 5:
        chip_reason = f"法人連買{consec}天、淨買超{net_amount:.1f}億"
    elif consec >= 3:
        chip_reason = f"法人連買{consec}天"
        if net_amount > 1:
            chip_reason += f"（{net_amount:.1f}億）"
    elif net_amount > 5:
        chip_reason = f"5日法人淨買超{net_amount:.1f}億"
    elif net_amount > 1:
        chip_reason = f"法人買超{net_amount:.1f}億"
    elif net_amount > 0:
        chip_reason = "法人小幅買超"
    elif net_amount > -1:
        chip_reason = "法人持平"
    else:
        chip_reason = f"法人賣超{abs(net_amount):.1f}億"

    # ── 技術面 ──
    rsi = s.get("rsi14") or 0
    macd_up = (s.get("macd_hist") or 0) > 0
    above_ma = bool(s.get("current_price")) and bool(s.get("ma20")) and s["current_price"] > s["ma20"]
    tech_parts: list[str] = []
    if rsi > 0:
        if rsi > 75:
            tech_parts.append(f"RSI {rsi:.0f} 強勢")
        elif rsi >= 55:
            tech_parts.append(f"RSI {rsi:.0f} 健康")
        elif rsi >= 40:
            tech_parts.append(f"RSI {rsi:.0f} 中性")
        else:
            tech_parts.append(f"RSI {rsi:.0f} 偏弱")
    tech_parts.append("MACD 多頭" if macd_up else "MACD 空頭")
    tech_parts.append("站穩月線" if above_ma else "月線下方")
    tech_reason = "、".join(tech_parts)

    # ── ML 面 ──
    sig = (s.get("_signal") or "").upper()
    vote_summary = s.get("ml_vote_summary")
    total = s.get("ml_models_total") or 0
    up = s.get("ml_models_up") or 0
    down = s.get("ml_models_down") or 0
    forecast_pct = s.get("ml_forecast_pct") or 0
    fp_str = f"{'+' if forecast_pct > 0 else ''}{forecast_pct * 100:.1f}%"

    if vote_summary:
        ml_reason = vote_summary
    elif total == 0:
        ml_reason = "ML 尚未分析"
    elif "STRONG_BUY" in sig:
        ml_reason = f"ML 強烈看多（{up}/{total}看漲，預期{fp_str}）"
    elif "BUY" in sig:
        ml_reason = f"ML 看多（{up}/{total}看漲，預期{fp_str}）"
    elif sig == "HOLD":
        if down > up:
            ml_reason = f"ML 觀望（{down}/{total}偏空但信心不足）"
        elif up > down:
            ml_reason = f"ML 觀望（{up}/{total}偏多但共識未達門檻）"
        else:
            ml_reason = f"ML 觀望（多空分歧 {up}/{down}）"
    else:
        ml_reason = "ML 觀望"

    return f"【籌碼】{chip_reason}｜【技術】{tech_reason}｜【ML】{ml_reason}"


def build_watch_points(s: dict) -> list[str]:
    """注意事項（template fallback，會被 LLM reason 覆寫）"""
    points: list[str] = []
    rsi = s.get("rsi14") or 50
    conf = s.get("ml_confidence") or 0

    if rsi > 80:
        points.append("RSI 超買，短線可能過熱")
    elif rsi > 75:
        points.append("RSI 偏高，留意回檔")
    macd_h = s.get("macd_hist") or 0
    cp = s.get("current_price") or 0
    ma20 = s.get("ma20") or 0
    if macd_h < 0 and cp > ma20:
        points.append("MACD 走弱但仍在月線上，留意趨勢轉折")

    if (s.get("foreign_net_5d") or 0) < 0:
        points.append("外資近期偏賣，留意籌碼變化")
    if (s.get("trust_net_5d") or 0) < 0 and (s.get("foreign_net_5d") or 0) > 0:
        points.append("外資買但投信賣，法人方向不一致")

    sig = (s.get("_signal") or "").lower()
    if "sell" in sig:
        points.append("ML 模型偏空，不建議新建倉位")
    elif conf < 0.45:
        points.append("ML 信心偏低，建議觀望或小量試單")
    elif 0.45 <= conf < 0.55 and sig == "hold":
        points.append("ML 信心中等，方向未明確，可等待訊號確認")

    if not points:
        points.append("留意大盤整體走勢與國際局勢")
    return points


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
        from services import kv_client
        tcfg = kv_client.get_json("trading:config", default={}) or {}
        ml_pool_cfg = tcfg.get("mlPool", {}) or {}
        v = ml_pool_cfg.get("useEnsembleV2")
        return True if v is None else bool(v)
    except Exception:
        return True


def _score_seed_row_from_payload(payload: dict) -> tuple[float, float, float | None]:
    """Build controller-owned screener seed scores when the legacy screener row is absent."""
    prices = _sorted_payload_rows(payload, "prices")
    indicators = _sorted_payload_rows(payload, "indicators")
    chips = _sorted_payload_rows(payload, "chips")
    latest_price = prices[-1].get("close") if prices else None
    latest_ind = indicators[-1] if indicators else {}

    recent_chips = chips[-5:]
    foreign_net_5d = sum((c.get("foreign_net") or 0) for c in recent_chips)
    trust_net_5d = sum((c.get("trust_net") or 0) for c in recent_chips)
    net_5d = foreign_net_5d + trust_net_5d

    recent_prices = prices[-20:]
    recent_closes = [float(p.get("close") or 0.0) for p in recent_prices if float(p.get("close") or 0.0) > 0]
    avg_volume = 0.0
    if recent_prices:
        volumes = [float(p.get("volume") or 0) for p in recent_prices]
        avg_volume = sum(volumes) / max(1, len(volumes))
    chip_intensity = (net_5d / max(avg_volume, 1.0)) if avg_volume else 0.0

    # Use a stricter accumulation scale: 5-day institutional net buy relative
    # to 20-day average volume. The old 20% threshold made many bull-market
    # names look almost perfect even without exceptional flow.
    if chip_intensity > 0.80:
        chip_score = 32.0
    elif chip_intensity > 0.45:
        chip_score = 24.0
    elif chip_intensity > 0.20:
        chip_score = 16.0
    elif chip_intensity > 0.05:
        chip_score = 8.0
    elif chip_intensity > -0.05:
        chip_score = 2.0
    else:
        chip_score = 0.0

    rsi = latest_ind.get("rsi14")
    macd_hist = latest_ind.get("macdHist") or latest_ind.get("macd_hist") or 0
    ma20 = latest_ind.get("ma20")
    tech_score = 0.0
    if isinstance(rsi, Real):
        rsi_value = float(rsi)
        if 55 <= rsi_value <= 68:
            tech_score += 10.0
        elif 68 < rsi_value <= 75:
            tech_score += 6.0
        elif 45 <= rsi_value < 55:
            tech_score += 4.0
        elif 75 < rsi_value <= 85:
            tech_score += 2.0
        elif 30 <= rsi_value < 45:
            tech_score += 2.0
        else:
            tech_score += 0.0
    if macd_hist and float(macd_hist) > 0:
        tech_score += 6.0
    if latest_price and len(recent_closes) >= 5 and float(latest_price) > (sum(recent_closes[-5:]) / 5):
        tech_score += 1.0
    if latest_price and ma20 and float(latest_price) > float(ma20):
        tech_score += 3.0
    if latest_price and len(recent_closes) >= 20 and float(latest_price) > (sum(recent_closes[-20:]) / 20):
        tech_score += 1.0

    return min(40.0, chip_score), min(30.0, tech_score), latest_price


def _sorted_payload_rows(payload: dict, key: str) -> list[dict]:
    rows = [row for row in (payload.get(key) or []) if isinstance(row, dict)]
    if any(row.get("date") for row in rows):
        return sorted(rows, key=lambda row: str(row.get("date") or ""))
    return rows


def build_screener_seed_recommendations(
    active_stocks: list[dict],
    payloads: list[dict],
    run_date: str,
) -> list[dict]:
    """
    Seed daily recommendations from controller-owned payloads when the legacy
    screener has not pre-populated daily_recommendations.
    """
    payload_by_sym = {p.get("symbol"): p for p in payloads if p.get("symbol")}
    seeds: list[dict] = []
    for stock in active_stocks:
        symbol = stock.get("symbol")
        if not symbol:
            continue
        payload = payload_by_sym.get(symbol) or {}
        chip_score, tech_score, latest_price = _score_seed_row_from_payload(payload)
        seeds.append({
            "date": run_date,
            "stock_id": stock.get("id"),
            "symbol": symbol,
            "name": stock.get("name") or symbol,
            "sector": stock.get("sector"),
            "industry": stock.get("industry"),
            "rank": 0,
            "score": round((chip_score + tech_score) * 10) / 10,
            "chip_score": chip_score,
            "tech_score": tech_score,
            "ml_score": 0.0,
            "signal": None,
            "confidence": None,
            "reason": "controller_seed",
            "watch_points": ["controller_seed"],
            "has_buy_signal": 0,
            "current_price": latest_price,
        })
    logger.info("[recommendation_service] Built %s controller screener seed rows", len(seeds))
    return seeds


def build_ml_vote_summary(ml: dict | None, eff_ml: dict, legacy_counts: dict[str, int]) -> str:
    """Build recommendation-facing ML text from the same source used for scoring."""
    signal = str(eff_ml.get("signal") or "").upper()
    source = str(eff_ml.get("signal_source") or "")
    forecast_pct = float(eff_ml.get("forecast_pct") or 0.0)
    forecast_text = f"{forecast_pct * 100:+.1f}%"
    ev2 = (ml or {}).get("ensemble_v2") or {}

    if source in {"ranking_promotion", "ensemble_v2_topk_policy"} or (ml or {}).get("topk_forced"):
        raw = eff_ml.get("signal_raw") or ev2.get("signal_raw") or "HOLD"
        avg_rank = ev2.get("avg_rank")
        avg_rank_text = f"{float(avg_rank):.3f}" if isinstance(avg_rank, Real) else "n/a"
        return f"排名補位候選（原始訊號 {raw}，V2 rank={avg_rank_text}，預期 {forecast_text}），需等 T2/debate 與盤前價格確認"

    contributors = ev2.get("contributing_models") or []
    if ev2 and float(ev2.get("weight_total") or 0.0) <= 0:
        return "V2 模型池暫無正 IC 權重，先以觀望處理，等待 verify/IC 樣本補齊"
    if contributors:
        label = "看多" if "BUY" in signal else "觀望" if signal == "HOLD" else "偏空"
        return f"V2 模型池{label}（{len(contributors)} 模型有權重，預期 {forecast_text}）"

    total = legacy_counts.get("total", 0)
    up = legacy_counts.get("up", 0)
    down = legacy_counts.get("down", 0)
    if total <= 0:
        return "ML 資料不足"
    if "BUY" in signal:
        return f"ML 看多（{up}/{total} 看漲，預期 {forecast_text}）"
    if signal == "HOLD":
        if up > down:
            return f"ML 觀望（{up}/{total} 偏多但共識未達門檻）"
        if down > up:
            return f"ML 觀望（{down}/{total} 偏空，暫不追價）"
        return f"ML 觀望（多空分歧 {up}/{down}）"
    return "ML 偏空"


def build_ml_vote_summary_data(ml: dict | None, legacy_counts: dict[str, int]) -> dict[str, Any]:
    """Structured ML vote evidence for UI/OBS; text reasons are derived elsewhere."""
    ev2 = (ml or {}).get("ensemble_v2") or {}
    active_weight_count = 0
    for value in (ev2.get("weights") or {}).values():
        numeric = _sanitize_non_finite(value)[0]
        if isinstance(numeric, Real) and float(numeric) > 0:
            active_weight_count += 1
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
    return {
        "bullish": bullish,
        "bearish": bearish,
        "flat": flat,
        "reported": reported,
        "missing": max(0, total - reported),
        "total": total,
        "forecastPct": ev2.get("forecast_pct"),
        "activeWeightCount": active_weight_count,
        "source": ev2.get("signal_source") or (ml or {}).get("signal_source") or "unknown",
        "signalRaw": ev2.get("signal_raw") or (ml or {}).get("signal_raw"),
        "contributingModels": ev2.get("contributing_models") or [],
    }


def build_score_components(row: dict, *, raw_score: float) -> dict[str, Any]:
    """Persist the score math so the UI never invents an opaque residual."""
    alpha_context = row.get("alpha_context") or {}
    alpha_adjustment = alpha_context.get("score_adjustment") if isinstance(alpha_context, dict) else 0
    final_score = row.get("score") or raw_score
    return {
        "chip": row.get("chip_score") or 0,
        "tech": row.get("tech_score") or 0,
        "screenerMomentum": row.get("momentum_score") or 0,
        "ml": row.get("ml_score") or 0,
        "persona": row.get("persona_score") or 0,
        "rawScore": raw_score,
        "alphaAdjustment": alpha_adjustment or 0,
        "finalScore": final_score,
        "formula": "chip + tech + ml + persona + alphaAdjustment",
        "alphaReason": {
            "bucket": alpha_context.get("edge_bucket") if isinstance(alpha_context, dict) else None,
            "regime": alpha_context.get("regime") if isinstance(alpha_context, dict) else None,
            "riskFlags": ((alpha_context.get("risk_overlay") or {}).get("flags") if isinstance(alpha_context, dict) else []) or [],
        },
    }


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


def build_reason(s: dict) -> str:
    """Build clean Traditional Chinese explanation for recommendation cards."""
    fnet = float(s.get("foreign_net_5d") or 0.0)
    tnet = float(s.get("trust_net_5d") or 0.0)
    dnet = float(s.get("dealer_net_5d") or 0.0)
    net_amount = fnet + tnet + dnet
    if net_amount > 5:
        chip_reason = f"法人 5 日買超 {net_amount:.1f} 億"
    elif net_amount > 1:
        chip_reason = f"法人買超 {net_amount:.1f} 億"
    elif net_amount > 0:
        chip_reason = "法人小幅買超"
    elif net_amount > -1:
        chip_reason = "法人買賣超接近平衡"
    else:
        chip_reason = f"法人賣超 {abs(net_amount):.1f} 億"

    rsi = float(s.get("rsi14") or 0.0)
    macd_up = float(s.get("macd_hist") or 0.0) > 0
    above_ma = bool(s.get("current_price")) and bool(s.get("ma20")) and float(s["current_price"]) > float(s["ma20"])
    tech_parts: list[str] = []
    if rsi > 0:
        if rsi > 75:
            tech_parts.append(f"RSI {rsi:.0f} 偏熱")
        elif rsi >= 55:
            tech_parts.append(f"RSI {rsi:.0f} 健康")
        elif rsi >= 40:
            tech_parts.append(f"RSI {rsi:.0f} 中性")
        else:
            tech_parts.append(f"RSI {rsi:.0f} 偏弱")
    tech_parts.append("MACD 多頭" if macd_up else "MACD 偏弱")
    tech_parts.append("站穩月線" if above_ma else "月線下方")
    tech_reason = "、".join(tech_parts)

    ml_reason = s.get("ml_vote_summary") or "ML 資料不足"
    return f"【籌碼】{chip_reason}｜【技術】{tech_reason}｜【ML】{ml_reason}"


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
    if float(s.get("foreign_net_5d") or 0.0) < 0:
        points.append("外資近 5 日偏賣，籌碼需再確認")
    if float(s.get("trust_net_5d") or 0.0) < 0 < float(s.get("foreign_net_5d") or 0.0):
        points.append("外資與投信方向不一致")
    if str(s.get("market_segment") or "").upper() == "EMERGING" or int(s.get("chip_rows") or 0) == 0:
        points.append("籌碼資料不足：興櫃或資料源未提供三大法人明細，籌碼分不是看壞而是不可比")
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
      - Added to chip+tech+ml to form total_score
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

        # Extract latest indicator values from payload (RSI, MACD, MA20)
        indicators = _sorted_payload_rows(payload, "indicators") if payload else []
        latest_ind = indicators[-1] if indicators else {}

        # Latest price from payload
        prices = _sorted_payload_rows(payload, "prices") if payload else []
        current_price = prices[-1]["close"] if prices else (rec.get("current_price"))

        # Foreign / trust net (5d sum from chips)
        chips = _sorted_payload_rows(payload, "chips") if payload else []
        recent_chips = chips[-5:]
        foreign_net_5d = _sum_chip_cash_billion(recent_chips, prices, "foreign_net")
        trust_net_5d = _sum_chip_cash_billion(recent_chips, prices, "trust_net")
        dealer_net_5d = _sum_chip_cash_billion(recent_chips, prices, "dealer_net")

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
            "rsi14": latest_ind.get("rsi14"),
            "macd_hist": latest_ind.get("macdHist"),
            "current_price": current_price,
            "ma20": latest_ind.get("ma20"),
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
            "reason": build_reason(reason_data),
            "watch_points": watch_points,
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "rsi14": latest_ind.get("rsi14"),
            "macd_hist": latest_ind.get("macdHist"),
        }
        if regime_label:
            alpha_context = build_alpha_context(row, eff_ml, payload, regime_label, regime_surface=regime_surface, policy=alpha_policy)
            apply_alpha_context(row, ml, alpha_context)
        row["score_components"] = build_score_components(row, raw_score=total_score)
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
    screener_denom = ranking_config.get("screenerDenominator", 60.0)
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
        screener_norm = min(1.0, ((r.get("chip_score") or 0) + (r.get("tech_score") or 0)) / screener_denom)
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


def update_recommendations_in_d1(
    recommendations: list[dict],
    run_date: str,
) -> int:
    """
    Upsert daily_recommendations rows with screener + ML fields.

    The V2 controller owns the fallback seed path, so this writer must create
    rows when the legacy screener did not pre-populate the table.
    """
    if not recommendations:
        return 0

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
            INSERT INTO daily_recommendations (
                date, stock_id, symbol, name, sector, rank, score, signal,
                confidence, reason, watch_points, has_buy_signal, current_price,
                foreign_net_5d, trust_net_5d, rsi14, macd_hist, chip_score,
                tech_score, momentum_score, ml_score, industry, market_segment, recommendation_lane,
                eligible_for_ml, eligible_for_pending_buy, alpha_context, alpha_allocation,
                ml_vote_summary, score_components
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, stock_id) DO UPDATE SET
                symbol=excluded.symbol,
                name=excluded.name,
                sector=excluded.sector,
                rank=excluded.rank,
                score=excluded.score,
                signal=excluded.signal,
                confidence=excluded.confidence,
                reason=excluded.reason,
                watch_points=excluded.watch_points,
                has_buy_signal=excluded.has_buy_signal,
                current_price=excluded.current_price,
                foreign_net_5d=excluded.foreign_net_5d,
                trust_net_5d=excluded.trust_net_5d,
                rsi14=excluded.rsi14,
                macd_hist=excluded.macd_hist,
                chip_score=excluded.chip_score,
                tech_score=excluded.tech_score,
                momentum_score=excluded.momentum_score,
                ml_score=excluded.ml_score,
                industry=excluded.industry,
                market_segment=excluded.market_segment,
                recommendation_lane=excluded.recommendation_lane,
                eligible_for_ml=excluded.eligible_for_ml,
                eligible_for_pending_buy=excluded.eligible_for_pending_buy,
                alpha_context=excluded.alpha_context,
                alpha_allocation=excluded.alpha_allocation,
                ml_vote_summary=excluded.ml_vote_summary,
                score_components=excluded.score_components
            """.strip(),
            [
                run_date,
                stock_id,
                r["symbol"],
                r.get("name") or r["symbol"],
                r.get("sector"),
                r.get("rank") or idx,
                score,
                r.get("signal"),
                confidence,
                r.get("reason") or "controller_seed",
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
            ],
        ))

    if not statements:
        return 0
    d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Upserted {len(statements)} daily_recommendations rows")
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
