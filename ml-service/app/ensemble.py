"""
ensemble.py — 多模型加權投票引擎（v12 adaptive）
動態權重 × Regime Filter × Stacking Meta-Learner × GARCH 停損 × Soft Gate

三層 meta 架構：
  ① HMM Regime → ② Models + LinUCB → ③ Conformal Prediction → ARF

NOTE: 4 active feature models (XGBoost, CatBoost, ExtraTrees, LightGBM)
  share same labels + correlated features. Consensus may be inflated.
  Future: diversify via different label horizons or feature subsets.

改動（v12）：
  - Isolation Forest 從 hard gate 降級為 anomaly_score soft penalty
  - confidence/consensus 雙低才 NO_SIGNAL，單項不過降級為 HOLD
  - signal_strength 從硬階梯改為 direction_weight × confidence 連續分數
  - confidence_threshold 從 0.60 降至 0.55（adaptive via KV）
"""
import logging
import os
import time
import numpy as np
from dataclasses import dataclass
from typing import Literal, Any
from .models import ModelPrediction

logger = logging.getLogger("ensemble")
_IC_WEIGHTS_CACHE: dict[str, dict[str, float]] | None = None
_IC_WEIGHTS_CACHE_LOADED_AT: float = 0.0
_MODEL_FAMILY = {
    "XGBoost": "tree_tabular",
    "CatBoost": "tree_tabular",
    "ExtraTrees": "tree_tabular",
    "LightGBM": "tree_tabular",
    "TabM": "tabular_neural",
    "DLinear": "sequence_baseline",
    "PatchTST": "learned_sequence",
    "iTransformer": "learned_sequence",
    "TimesFM": "foundation_sequence",
    "GNN": "graph",
}


def _normalize_market_segment(segment: Any) -> str | None:
    value = str(segment or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING"}:
        return "EMERGING"
    return None


def _coerce_ic_value(value: Any) -> float | None:
    if isinstance(value, dict):
        for key in ("ic", "rolling_ic", "ic_4w_avg", "value"):
            if key in value:
                return _coerce_ic_value(value.get(key))
        return None
    try:
        if value is not None:
            return float(value)
    except (TypeError, ValueError):
        return None
    return None


def _entry_serving_ic(entry: dict, market_segment: str | None = None) -> float | None:
    """Choose the IC that matches the prediction lane before using global IC."""
    segment = _normalize_market_segment(market_segment)
    segment_map = entry.get("last_ic_by_segment")
    if segment and isinstance(segment_map, dict):
        segment_ic = _coerce_ic_value(segment_map.get(segment))
        if segment_ic is not None:
            return segment_ic

    for key in ("ic_4w_avg", "weekly_ic", "rolling_ic"):
        value = entry.get(key)
        if key == "weekly_ic":
            history = value or []
            if history:
                value = history[-1]
            else:
                value = None
        ic_value = _coerce_ic_value(value)
        if ic_value is not None:
            return ic_value
    return None


def _coerce_sample_count(value: Any) -> int | None:
    try:
        if value is not None:
            return max(0, int(float(value)))
    except (TypeError, ValueError):
        return None
    return None


def _entry_ic_sample_count(entry: dict, market_segment: str | None = None) -> int:
    segment = _normalize_market_segment(market_segment)
    segment_map = entry.get("last_ic_by_segment")
    if segment and isinstance(segment_map, dict):
        segment_value = segment_map.get(segment)
        if isinstance(segment_value, dict):
            for key in ("n_samples", "sample_count", "samples", "coverage"):
                count = _coerce_sample_count(segment_value.get(key))
                if count is not None:
                    return count
    for key in ("last_ic_sample_count", "active_ic_samples", "ic_sample_count", "sample_count", "coverage_samples"):
        count = _coerce_sample_count(entry.get(key))
        if count is not None:
            return count
    history = entry.get("weekly_ic") or []
    if isinstance(history, list):
        return len(history)
    return 0


def _shrink_ic_weight(ic_value: float, sample_count: int) -> float:
    prior_ic = float(os.environ.get("IC_WEIGHT_PRIOR", "0.015") or "0.015")
    prior_strength = max(0.0, float(os.environ.get("IC_WEIGHT_PRIOR_STRENGTH", "20") or "20"))
    min_samples_for_hard_zero = int(os.environ.get("IC_WEIGHT_MIN_SAMPLES_FOR_HARD_ZERO", "40") or "40")
    n = max(0, int(sample_count or 0))
    alpha = n / (n + prior_strength) if (n + prior_strength) > 0 else 1.0
    posterior = (alpha * float(ic_value)) + ((1.0 - alpha) * prior_ic)
    if n >= min_samples_for_hard_zero and float(ic_value) < 0 and posterior <= 0:
        return 0.0
    return max(0.0, posterior)


def _extract_model_pool_ic(pool: dict, market_segment: str | None = None) -> dict[str, float]:
    """Extract serving IC weights from model_pool.json.

    Production serving is lane-aware: a listed stock should not have its model
    weight zeroed because the same model underperformed on OTC/emerging names.
    """
    weights: dict[str, float] = {}
    from .model_pool import ALPHA_PREDICTION_MODELS
    active_alpha_models = set(ALPHA_PREDICTION_MODELS)
    for name, entry in (pool.get("models") or {}).items():
        if name not in active_alpha_models:
            continue
        ic_value = _entry_serving_ic(entry, market_segment=market_segment)
        if ic_value is not None:
            sample_count = _entry_ic_sample_count(entry, market_segment=market_segment)
            weights[name] = _shrink_ic_weight(ic_value, sample_count)
    return weights

@dataclass
class EnsembleResult:
    # 最終訊號
    signal: Literal["STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL", "NO_SIGNAL"]
    direction: Literal["up", "down", "neutral"]
    confidence: float           # 0~1
    consensus: float            # 同向模型比例 0~1
    forecast_pct: float         # 加權平均漲跌幅預測
    forecast_range: dict        # {"low": x, "high": y}

    # 各模型結果
    models: list[dict]

    # ATR 動態停損
    entry_price: float
    stop_loss: float
    target1: float
    target2: float

    # 信心說明
    reasoning: str
    signal_strength: int        # 1~5 星


def weighted_vote(
    predictions: list[ModelPrediction],
    current_price: float,
    atr: float,
    real_accuracies: dict[str, float] | None = None,
    model_stats: dict[str, dict] | None = None,
    regime_info: dict | None = None,         # 來自 RegimeDetector.predict_regime()
    meta_bundle: Any | None = None,           # 來自 stacking.load_meta_learner()
    garch_vol: float | None = None,           # 來自 run_garch_volatility()，price 單位
    bandit_multipliers: dict[str, float] | None = None,  # 來自 LinUCB bandit（第11模型）
    adaptive_params: dict | None = None,      # 來自 KV ml:adaptive_params（T+1 自適應）
    trading_config: dict | None = None,       # B12 fix (2026-04-08): KV trading:config（Optuna baseline）
    anomaly_score: float = 0.0,               # Isolation Forest soft penalty（不再 hard gate）
    lifecycle_weights: dict[str, float] | None = None,  # 來自 model_pool.json
) -> EnsembleResult:
    """
    加權投票主邏輯（v12 + LinUCB bandit）：
    1. 動態權重 = 真實準確率 × profit_factor調整 × regime乘數 × 信心 × LinUCB乘數
    2. Stacking meta-learner 修正最終方向（若可用）
    3. GARCH 波動率取代靜態 ATR 計算動態停損
    4. 信心 + 共識門檻過濾（門檻根據 regime 動態調整）
    5. LinUCB bandit 根據市場情境動態路由，提升適合當前情境的模型權重
    """
    if not predictions:
        return _no_signal(current_price, atr, "無模型預測結果")

    real_acc    = real_accuracies or {}
    stats       = model_stats or {}
    _adaptive   = adaptive_params or {}  # adaptive KV params（T+1，safe fallback to {}）
    _trading_cfg = trading_config or {}  # B12 fix: KV trading:config baseline

    # ── Regime 乘數 ───────────────────────────────────────────────────────────
    regime_mults           = {}
    dynamic_consensus_thr  = 0.60
    if regime_info:
        regime_mults          = regime_info.get("weight_multipliers", {})
        dynamic_consensus_thr = regime_info.get("consensus_threshold", 0.60)

    # ── 計算動態權重（準確率 × profit_factor × regime × 信心）────────────────
    weights = []
    for p in predictions:
        # ① 準確率權重
        real = real_acc.get(p.model_name)
        if real is not None and real > 0:
            acc_weight = real if real >= 0.5 else max(0.05, real * 0.5)
        else:
            acc_weight = max(0.1, p.direction_accuracy)

        # ② 盈虧品質調整因子（profit_factor / expectancy）
        quality_mult = 1.0
        st = stats.get(p.model_name, {})
        if st:
            pf = st.get("profit_factor")
            exp = st.get("expectancy")

            if pf is not None:
                # profit_factor < 1 代表整體虧損，大幅降權
                if pf < 0.8:
                    quality_mult *= 0.4
                elif pf < 1.0:
                    quality_mult *= 0.7
                elif pf > 2.0:
                    quality_mult *= 1.4   # 最高品質加權（必須在 >1.5 之前判斷）
                elif pf > 1.5:
                    quality_mult *= 1.2   # 高品質訊號加權

            if exp is not None:
                # 期望值為負，代表長期必虧，嚴重降權
                if exp < -0.005:
                    quality_mult *= 0.3
                elif exp < 0:
                    quality_mult *= 0.6

        # Adaptive PF 品質乘數（來自 KV adaptive_params.pf_quality_mult，T+1）
        pf_adaptive_mult = _adaptive.get("pf_quality_mult", {}).get(p.model_name, 1.0)
        quality_mult *= pf_adaptive_mult

        conf_weight   = p.confidence
        regime_mult   = regime_mults.get(p.model_name, 1.0)
        bandit_mult   = (bandit_multipliers or {}).get(p.model_name, 1.0)
        lifecycle_mult = (lifecycle_weights or {}).get(p.model_name, 1.0)  # P1#8

        # C3 fix: log-linear combination prevents weight explosion
        # Instead of raw multiplication (ratio up to 29,500:1), use log-space
        # with clipping to bound max/min ratio to ~55:1
        import math
        log_w = (
            math.log(max(acc_weight, 0.01))
            + math.log(max(conf_weight, 0.01))
            + math.log(max(quality_mult, 0.01))
            + math.log(max(regime_mult, 0.01))
            + math.log(max(bandit_mult, 0.01))
            + math.log(max(lifecycle_mult, 0.01))
        )
        raw_w = math.exp(max(min(log_w, 2.0), -2.0))  # clip log to [-2, 2] → ratio ~55:1
        weights.append(raw_w)

    total_w = sum(weights) or 1.0
    norm_weights = [w / total_w for w in weights]

    # ── DoNothing arm 檢查：若 bandit 認為「不出手」最好，降低整體信心 ─────────
    # DoNothing 沒有 prediction，它的影響透過 bandit_multipliers 傳遞
    donothing_mult = (bandit_multipliers or {}).get("DoNothing", 1.0)
    max_model_mult = max((bandit_multipliers or {}).get(p.model_name, 1.0) for p in predictions) if predictions else 1.0
    donothing_is_best = donothing_mult > max_model_mult and donothing_mult > 1.5
    # 若 DoNothing 是 bandit 最高權重 arm → 市場混沌，所有模型都不可信
    donothing_penalty = 0.7 if donothing_is_best else 1.0

    # ── 加權方向投票 ──────────────────────────────────────────────────────────
    up_weight = sum(w for p, w in zip(predictions, norm_weights) if p.direction == "up")
    down_weight = sum(w for p, w in zip(predictions, norm_weights) if p.direction != "up")

    # ── 加權平均預測漲跌幅 ────────────────────────────────────────────────────
    weighted_pct = sum(p.forecast_pct * w for p, w in zip(predictions, norm_weights))

    # ── 共識度（同向模型數量比例）─────────────────────────────────────────────
    up_count = sum(1 for p in predictions if p.direction == "up")
    consensus = max(up_count, len(predictions) - up_count) / len(predictions)

    # ── 整體信心分數（只算贏方向的加權 confidence）──────────────────────────
    # Bug fix: 之前用全模型加權平均，UP 的低 confidence 會拉低 DOWN 的高 confidence
    # 修正：只計算勝出方向模型的加權 confidence
    winning_dir = "up" if up_weight > down_weight else "down"
    winning_conf_sum = 0.0
    winning_weight_sum = 0.0
    for p, w in zip(predictions, norm_weights):
        if p.direction == winning_dir:
            winning_conf_sum += p.confidence * w
            winning_weight_sum += w
    avg_confidence = winning_conf_sum / winning_weight_sum if winning_weight_sum > 0 else 0.5
    avg_confidence *= donothing_penalty  # DoNothing arm 修正

    # ── Anomaly soft penalty（取代 hard gate）─────────────────────────────────
    # anomaly_score 越負代表越異常，threshold 以下開始施加 penalty
    _anomaly_threshold = float(_adaptive.get("anomaly_threshold", -0.5))
    _anomaly_floor = float(_adaptive.get("anomaly_penalty_floor", 0.5))
    if anomaly_score < _anomaly_threshold:
        # 線性映射：score=threshold→1.0, 越負越低（最低 floor 折）
        anomaly_penalty = max(_anomaly_floor, 1.0 + (anomaly_score - _anomaly_threshold) * 1.0)
        avg_confidence *= anomaly_penalty

    # ── 信心門檻過濾 ─────────────────────────────────────────────────────────
    CONFIDENCE_THRESHOLD = float(_adaptive.get("confidence_threshold", 0.55))
    CONSENSUS_THRESHOLD  = dynamic_consensus_thr   # 由 regime 決定（0.55~0.72）

    below_confidence = avg_confidence < CONFIDENCE_THRESHOLD
    below_consensus  = consensus < CONSENSUS_THRESHOLD

    # 雙低 → NO_SIGNAL
    if below_confidence and below_consensus:
        return _no_signal(
            current_price, atr,
            f"信心與共識雙低（信心={avg_confidence:.2f}, 共識={consensus:.2f}, "
            f"門檻={CONSENSUS_THRESHOLD:.2f}, regime={regime_info.get('label','?') if regime_info else 'N/A'}）"
        )

    # ── Stacking Meta-Learner 修正方向（若可用）──────────────────────────────
    meta_direction, meta_confidence = None, None
    if meta_bundle is not None:
        try:
            from .stacking import meta_predict
            meta_direction, meta_confidence = meta_predict(predictions, meta_bundle)
        except Exception as e:
            logger.warning(f"[Meta] predict failed: {e}")

    # 決定最終方向：meta-learner 優先，其次加權投票
    # P1#10: dynamic stacking blend — compare 30d meta vs ensemble accuracy
    if meta_direction is not None and meta_confidence is not None:
        is_up       = meta_direction == "up"
        # Dynamic blend: if meta more accurate recently, weight it higher (up to 70%)
        meta_acc_30d = float(_adaptive.get("meta_accuracy_30d", 0))
        ensemble_acc_30d = float(_adaptive.get("recent_accuracy_30d", 0))
        if meta_acc_30d > 0 and ensemble_acc_30d > 0:
            # Higher meta accuracy → higher meta ratio (0.5 to 0.7)
            meta_ratio = np.clip(0.5 + (meta_acc_30d - ensemble_acc_30d), 0.3, 0.7)
        else:
            meta_ratio = float(_adaptive.get("meta_ratio_default", 0.6))
        final_conf  = avg_confidence * (1 - meta_ratio) + meta_confidence * meta_ratio
        reasoning_meta = f"[Meta-Learner 修正為 {'↑' if is_up else '↓'}，信心={meta_confidence:.0%}，blend={meta_ratio:.0%}] "
    else:
        is_up       = up_weight > down_weight
        final_conf  = avg_confidence
        reasoning_meta = ""

    direction: Literal["up", "down"] = "up" if is_up else "down"
    direction_weight = up_weight if is_up else down_weight

    # ── 訊號強度（連續分數，取代硬階梯）──────────────────────────────────────
    # signal_score = direction_weight × confidence 的連續映射，0~1
    signal_score = direction_weight * final_conf

    # 單項不過門檻：降低 signal_strength 但不強制 HOLD
    # 如果 signal_score 夠高（方向明確 × 信心高），仍給出 BUY/SELL
    threshold_penalty = 1 if (below_confidence or below_consensus) else 0

    # Signal score 門檻從 KV adaptive_params 讀取（Optuna 可搜尋，零 deploy 更新）
    STRONG_SIGNAL_SCORE = float(_adaptive.get("strong_signal_score", 0.72))
    BUY_SIGNAL_SCORE    = float(_adaptive.get("buy_signal_score", 0.52))
    HOLD_SIGNAL_SCORE   = float(_adaptive.get("hold_signal_score", 0.36))

    if signal_score >= STRONG_SIGNAL_SCORE:
        signal = "STRONG_BUY" if is_up else "STRONG_SELL"
        stars = max(4, 5 - threshold_penalty)
    elif signal_score >= BUY_SIGNAL_SCORE:
        signal = "BUY" if is_up else "SELL"
        stars = max(3, 4 - threshold_penalty)
    elif signal_score >= HOLD_SIGNAL_SCORE:
        if threshold_penalty:
            signal = "HOLD"  # signal_score 偏低 + 門檻沒過 → HOLD
        else:
            signal = "BUY" if is_up else "SELL"
        stars = max(2, 3 - threshold_penalty)
    else:
        signal = "HOLD"
        stars = 2

    # ── 停損/停利：GARCH 波動率優先，其次 ATR ──────────────────────────────
    # GARCH 給出的是「預測的未來波動率」，比回看 ATR 更有前瞻性
    effective_vol = garch_vol if (garch_vol and garch_vol > 0) else (atr if atr and atr > 0 else current_price * 0.02)
    vol_pct = effective_vol / current_price
    vol_source = "GARCH" if (garch_vol and garch_vol > 0) else "ATR"

    # B12 fix (2026-04-08 audit): SL/TP base multipliers 改讀 trading:config.sltp (Optuna #3 結果)
    # Sprint 5.1 Phase 7 Layer B (2026-04-09): per-vol-branch multipliers 也從 KV 讀
    # 原本 0.75/0.67/1.25/1.33 是 hardcode，從沒進 Optuna search space；現在 schema
    # 已加 slMultLow/tpMultLow/slMultHigh/tpMultHigh 欄位，defaults 等同原 hardcode。
    _sltp = _trading_cfg.get("sltp", {}) if isinstance(_trading_cfg, dict) else {}
    _sl_base = float(_sltp.get("slMultBase", _adaptive.get("sl_mult_base", 2.0)))
    _tp_base = float(_sltp.get("tpMultBase", _adaptive.get("tp_mult_base", 1.5)))
    _vol_low = float(_sltp.get("volThresholdLow", _adaptive.get("vol_threshold_low", 0.015)))
    _vol_high = float(_sltp.get("volThresholdHigh", _adaptive.get("vol_threshold_high", 0.03)))
    _sl_mult_low  = float(_sltp.get("slMultLow", 0.75))
    _tp_mult_low  = float(_sltp.get("tpMultLow", 0.67))
    _sl_mult_high = float(_sltp.get("slMultHigh", 1.25))
    _tp_mult_high = float(_sltp.get("tpMultHigh", 1.33))

    # Sprint 5.1 Phase 7 Layer C (2026-04-09): extreme low vol skip
    # 極低波動股（vol_pct < 0.5% 預設）的 R:R 幾乎必然超差（SL/TP 距離 current_price 太近），
    # 直接 NO_SIGNAL 省得下游算白工 + 壓 fill_rate 統計
    _vol_skip = float(_sltp.get("volSkipThreshold", 0.005))
    if vol_pct < _vol_skip:
        return _no_signal(
            current_price, atr,
            f"vol_pct={vol_pct:.4f} < {_vol_skip} (extreme low vol, 無法產出合理 R:R)"
        )

    if vol_pct < _vol_low:      # 低波動：收緊
        sl_mult, tp_mult = _sl_base * _sl_mult_low, _tp_base * _tp_mult_low
    elif vol_pct < _vol_high:     # 正常
        sl_mult, tp_mult = _sl_base, _tp_base
    else:                    # 高波動：放寬
        sl_mult, tp_mult = _sl_base * _sl_mult_high, _tp_base * _tp_mult_high

    # Adaptive SL/TP override（高風險 regime 加寬，避免被洗）
    sl_tp_override = _adaptive.get("sl_tp_override")
    if sl_tp_override:
        sl_mult += float(sl_tp_override.get("sl_add", 0))
        tp_mult += float(sl_tp_override.get("tp_add", 0))

    stop_loss = current_price - effective_vol * sl_mult
    target1   = current_price + effective_vol * tp_mult
    target2   = current_price + effective_vol * tp_mult * 1.5

    # ── 預測區間（各模型 95% 上下界的加權平均）───────────────────────────────
    lows, highs = [], []
    for p, w in zip(predictions, norm_weights):
        if p.forecasts:
            mid = p.forecasts[4] if len(p.forecasts) > 4 else p.forecasts[-1]
            if isinstance(mid, dict) and "lower95" in mid and "upper95" in mid:
                lows.append(mid["lower95"] * w)
                highs.append(mid["upper95"] * w)
    forecast_range = {
        "low": round(sum(lows), 2) if lows else current_price * 0.95,
        "high": round(sum(highs), 2) if highs else current_price * 1.05,
    }

    # ── 說明文字 ──────────────────────────────────────────────────────────────
    model_votes = ", ".join(
        f"{p.model_name}({'↑' if p.direction=='up' else '↓'} {p.confidence:.0%})"
        for p in predictions
    )
    regime_label = regime_info.get("label", "") if regime_info else ""
    reasoning = (
        f"{reasoning_meta}"
        f"{up_count}/{len(predictions)} 個模型看{'漲' if is_up else '跌'}，"
        f"加權信心 {final_conf:.0%}，"
        f"預測 5 日漲跌 {weighted_pct:+.1%}。"
        + (f"市場狀態：{regime_label}。" if regime_label else "")
        + (f"停損基準：{vol_source}。" if vol_source else "")
        + f"各模型：{model_votes}"
    )

    return EnsembleResult(
        signal=signal,
        direction=direction,
        confidence=round(final_conf, 3),
        consensus=round(consensus, 3),
        forecast_pct=round(weighted_pct, 4),
        forecast_range=forecast_range,
        models=[
            {
                "name": p.model_name,
                "direction": p.direction,
                "confidence": p.confidence,
                "forecast_pct": p.forecast_pct,
                "direction_accuracy": p.direction_accuracy,
                "weight": round(norm_weights[i], 3),
            }
            for i, p in enumerate(predictions)
        ],
        entry_price=round(current_price, 2),
        stop_loss=round(stop_loss, 2),
        target1=round(target1, 2),
        target2=round(target2, 2),
        reasoning=reasoning,
        signal_strength=stars,
    )


def _no_signal(current_price: float, atr: float, reason: str) -> EnsembleResult:
    atr_val = atr if atr and atr > 0 else current_price * 0.02
    return EnsembleResult(
        signal="NO_SIGNAL",
        direction="neutral",
        confidence=0.0,
        consensus=0.0,
        forecast_pct=0.0,
        forecast_range={"low": current_price * 0.95, "high": current_price * 1.05},
        models=[],
        entry_price=round(current_price, 2),
        stop_loss=round(current_price - atr_val * 2, 2),
        target1=round(current_price + atr_val * 1.5, 2),
        target2=round(current_price + atr_val * 2.5, 2),
        reasoning=f"訊號不明，建議觀望。原因：{reason}",
        signal_strength=0,
    )


# ══════════════════════════════════════════════════════════════════════════════
# 2.0 Rank → Signal 翻譯層
# ══════════════════════════════════════════════════════════════════════════════

def load_ic_weights(market_segment: str | None = None) -> dict[str, float]:
    """Load serving IC weights from model_pool.json only."""
    global _IC_WEIGHTS_CACHE, _IC_WEIGHTS_CACHE_LOADED_AT
    ttl = int(os.environ.get("IC_WEIGHTS_CACHE_TTL_SECONDS", "300") or "300")
    segment = _normalize_market_segment(market_segment) or "GLOBAL"
    if _IC_WEIGHTS_CACHE is not None and time.time() - _IC_WEIGHTS_CACHE_LOADED_AT < max(0, ttl):
        return dict(_IC_WEIGHTS_CACHE.get(segment, {}))
    try:
        from .model_pool import load_pool
        weights_by_segment: dict[str, dict[str, float]] = {}
        pool = load_pool()
        if pool:
            for key in ("GLOBAL", "LISTED", "OTC", "EMERGING"):
                weights_by_segment[key] = _extract_model_pool_ic(
                    pool,
                    market_segment=None if key == "GLOBAL" else key,
                )

        _IC_WEIGHTS_CACHE = dict(weights_by_segment)
        _IC_WEIGHTS_CACHE_LOADED_AT = time.time()
        return dict(weights_by_segment.get(segment, {}))
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# 2026-04-19 ML_POOL Plan A — Time-series signal → rank score (for ensemble)
# ─────────────────────────────────────────────────────────────────────────────


def time_series_to_rank(forecast_pct: float, scale: float = 12.0) -> float:
    """Map a single-stock 5d forecast_pct (e.g. +0.025 = +2.5%) to rank 0~1.

    Sigmoid centered at 0:
      rank = 1 / (1 + exp(-forecast_pct * scale))

    With scale=12:
      forecast=0      → rank=0.50  (neutral)
      forecast=+0.025 → rank=0.575 (mild bullish)
      forecast=+0.050 → rank=0.646 (bullish, ~BUY threshold)
      forecast=+0.100 → rank=0.769 (strong bullish, ~STRONG_BUY threshold)
      forecast=-0.050 → rank=0.354 (bearish)

    Time-series models output absolute %; sigmoid keeps them in (0,1) so
    they're directly comparable to feature-model cross-sectional ranks.
    """
    import math
    return 1.0 / (1.0 + math.exp(-forecast_pct * scale))


def merge_with_time_series(
    feature_rank_scores: dict[str, float],
    time_series_signals: dict[str, dict],
    ic_weights: dict[str, float] | None = None,
    model_status: dict[str, str] | None = None,
    degraded_dampening: float = 1.0,
    forecast_to_rank_scale: float = 12.0,
) -> tuple[dict[str, float], dict[str, float]]:
    """Combine 5 feature-model rank scores with 3 time-series forecasts.

    2026-04-19 R1+R3 hybrid (replaces hardcoded lifecycle multipliers 0/0.1/1.0):
      weight = max(0, ic) × status_filter × dampening_if_degraded
        active:     max(0, ic)
        degraded:   max(0, ic) × degraded_dampening (default 1.0 = pure IC)
        challenger: 0  (shadow)
        retired:    0  (excluded)

    Args:
      feature_rank_scores: {name: rank 0~1} from the active alpha model pool
      time_series_signals: {name: {forecast_pct, ...}} for DLinear/PatchTST
        (key absent or value None → that model contributes nothing)
      ic_weights: {name: IC} (Grinold-Kahn). None → uniform 1.0 (no IC available).
      model_status: {name: "active"|"degraded"|"challenger"|"retired"} from
        model_pool.json. None → all "active" (no ML_POOL applied).
      degraded_dampening: extra multiplier on degraded models.
        Default 1.0 (= pure IC, R3 industry standard).
        KV-driven via trading:config.mlPool.degradedDampening.
        Future: Optuna-searchable post #31 backtest Mode B.
      forecast_to_rank_scale: sigmoid sharpness for time-series → rank.

    Returns:
      (merged_rank_scores, applied_weights)
    """
    merged: dict[str, float] = dict(feature_rank_scores)
    from .model_pool import ALPHA_PREDICTION_MODELS
    active_alpha_models = set(ALPHA_PREDICTION_MODELS)
    for name, ts in (time_series_signals or {}).items():
        if name not in active_alpha_models:
            continue
        if not ts or ts.get("forecast_pct") is None:
            continue
        merged[name] = time_series_to_rank(float(ts["forecast_pct"]), scale=forecast_to_rank_scale)

    weights: dict[str, float] = {}
    status_filter_map = {"active": 1.0, "degraded": 1.0, "challenger": 0.0, "retired": 0.0}
    for name in merged:
        status = (model_status or {}).get(name, "active")
        sf = status_filter_map.get(status, 0.0)
        if sf == 0.0:
            weights[name] = 0.0
            continue
        ic_w = max(0.0, (ic_weights or {}).get(name, 0.0)) if ic_weights else 1.0
        if status == "degraded":
            ic_w *= float(degraded_dampening)
        weights[name] = ic_w
    return merged, weights


def weighted_average_rank(rank_scores: dict[str, float], weights: dict[str, float]) -> float:
    """Standard weighted average. Falls back to plain mean if all weights ≤ 0."""
    weight_total = 0.0
    weighted_sum = 0.0
    for name, score in rank_scores.items():
        w = max(0.0, weights.get(name, 0.0))
        weighted_sum += score * w
        weight_total += w
    if weight_total <= 0:
        scores = list(rank_scores.values())
        return float(np.mean(scores)) if scores else 0.5
    return weighted_sum / weight_total


def family_weighted_average_rank(rank_scores: dict[str, float], weights: dict[str, float]) -> tuple[float, dict]:
    family_rows: dict[str, dict[str, Any]] = {}
    for name, score in rank_scores.items():
        weight = max(0.0, float(weights.get(name, 0.0) or 0.0))
        if weight <= 0:
            continue
        family = _MODEL_FAMILY.get(name, "other")
        row = family_rows.setdefault(family, {"score_sum": 0.0, "weight_sum": 0.0, "members": []})
        row["score_sum"] += float(score) * weight
        row["weight_sum"] += weight
        row["members"].append(name)

    family_scores: dict[str, float] = {}
    family_weights: dict[str, float] = {}
    family_members: dict[str, list[str]] = {}
    for family, row in family_rows.items():
        member_count = max(1, len(row["members"]))
        family_scores[family] = row["score_sum"] / row["weight_sum"] if row["weight_sum"] > 0 else 0.5
        family_weights[family] = row["weight_sum"] / member_count
        family_members[family] = sorted(row["members"])

    weight_total = sum(family_weights.values())
    if weight_total <= 0:
        scores = list(rank_scores.values())
        return (float(np.mean(scores)) if scores else 0.5), {
            "scores": {},
            "weights": {},
            "members": {},
            "contributing_families": [],
        }
    avg_rank = sum(family_scores[name] * family_weights[name] for name in family_scores) / weight_total
    return avg_rank, {
        "scores": {k: round(float(v), 6) for k, v in family_scores.items()},
        "weights": {k: round(float(v), 6) for k, v in family_weights.items()},
        "members": family_members,
        "contributing_families": sorted(family_scores),
    }


def rank_to_signal(
    rank_scores: dict[str, float],
    current_price: float,
    atr: float,
    ic_weights: dict[str, float] | None = None,
    top_n: int = 5,
    strong_buy_threshold: float = 0.85,
    buy_threshold: float = 0.70,
    sell_threshold: float = 0.30,
    strong_sell_threshold: float = 0.15,
) -> EnsembleResult:
    """2.0 翻譯層：regression rank scores → EnsembleResult。

    Args:
        rank_scores: {model_name: rank_score (0~1)} from 5 regression models
        current_price: latest close
        atr: ATR for stop/target calculation
        ic_weights: {model_name: IC} — IC-weighted avg (Grinold-Kahn).
                    None → fallback to equal weight.
        top_n: cross-sectional top N filter (applied by caller, not here)
        strong_buy_threshold: rank above this → STRONG_BUY
        buy_threshold: rank above this → BUY
        sell_threshold: rank below this → SELL
        strong_sell_threshold: rank below this → STRONG_SELL

    Returns:
        EnsembleResult with signal/direction/confidence translated from rank
    """
    eps = 1e-9
    if not rank_scores:
        return _no_signal(current_price, atr, "No rank scores")

    # IC-weighted ensemble (Grinold-Kahn: contribution ∝ IC)
    family_vote: dict[str, Any] = {}
    if ic_weights:
        weight_total = 0.0
        has_observed_ic = False
        effective_weights: dict[str, float] = {}
        for name, score in rank_scores.items():
            raw_ic = float(ic_weights.get(name, 0.0) or 0.0)
            if abs(raw_ic) > 1e-12:
                has_observed_ic = True
            w = max(0.0, raw_ic)
            weight_total += w
            effective_weights[name] = w
        if weight_total > 0:
            avg_rank, family_vote = family_weighted_average_rank(rank_scores, effective_weights)
        elif not has_observed_ic:
            avg_rank, family_vote = family_weighted_average_rank(rank_scores, {name: 1.0 for name in rank_scores})
        else:
            avg_rank = 0.5
    else:
        avg_rank, family_vote = family_weighted_average_rank(rank_scores, {name: 1.0 for name in rank_scores})
    avg_rank = float(np.clip(avg_rank, 0.0, 1.0))
    scores = list(rank_scores.values())
    rank_std = float(np.std(scores)) if len(scores) > 1 else 0.0

    # Consensus: fraction of models agreeing on dominant direction (symmetric)
    n_bullish = sum(1 for s in scores if s > 0.5)
    n_bearish = len(scores) - n_bullish
    consensus = max(n_bullish, n_bearish) / len(scores)

    # Signal translation
    if avg_rank >= (strong_buy_threshold - eps):
        signal = "STRONG_BUY"
        direction = "up"
    elif avg_rank >= (buy_threshold - eps):
        signal = "BUY"
        direction = "up"
    elif avg_rank <= (strong_sell_threshold + eps):
        signal = "STRONG_SELL"
        direction = "down"
    elif avg_rank <= (sell_threshold + eps):
        signal = "SELL"
        direction = "down"
    else:
        signal = "HOLD"
        direction = "neutral"

    # Confidence: use rank directly (0~1) — higher rank = more confident bullish
    confidence = round(min(1.0, abs(avg_rank - 0.5) * 2.0), 3)

    # Signal strength: 1~5 stars based on rank percentile
    distance = abs(avg_rank - 0.5)
    if distance >= 0.40:
        strength = 5
    elif distance >= 0.30:
        strength = 4
    elif distance >= 0.20:
        strength = 3
    elif distance >= 0.10:
        strength = 2
    else:
        strength = 1

    # Forecast: approximate from rank position
    # rank 0.8 → top 20% → historically ~3-5% above market
    forecast_pct = round(max(-0.05, min(0.05, (avg_rank - 0.5) * 0.10)), 4)

    atr_val = max(atr, current_price * 0.01)

    # Model details for downstream
    model_details = [
        {"name": name, "model_name": name, "rank_score": round(score, 4),
         "direction": "up" if score > 0.5 else "down",
         "confidence": round(score, 3),
         "family": _MODEL_FAMILY.get(name, "other")}
        for name, score in rank_scores.items()
    ]
    model_details.append({
        "name": "family_vote",
        "model_name": "family_vote",
        "rank_score": round(avg_rank, 4),
        "details": family_vote,
    })

    reasoning_parts = []
    if avg_rank >= 0.70:
        reasoning_parts.append(f"排名前 {round((1-avg_rank)*100)}%")
    if consensus >= 0.8:
        reasoning_parts.append(f"{len(scores)} 個模型中 {n_bullish} 個看多")
    if rank_std < 0.1:
        reasoning_parts.append("模型共識高")
    reasoning = "；".join(reasoning_parts) if reasoning_parts else "排名中等，建議觀望"

    return EnsembleResult(
        signal=signal,
        direction=direction,
        confidence=confidence,
        consensus=round(consensus, 2),
        forecast_pct=forecast_pct,
        forecast_range={
            "low": round(current_price * (1 + forecast_pct - 0.02), 2),
            "high": round(current_price * (1 + forecast_pct + 0.02), 2),
        },
        models=model_details,
        entry_price=round(current_price, 2),
        stop_loss=round(current_price - atr_val * 2, 2),
        target1=round(current_price + atr_val * 1.5, 2),
        target2=round(current_price + atr_val * 2.5, 2),
        reasoning=reasoning,
        signal_strength=strength,
    )
