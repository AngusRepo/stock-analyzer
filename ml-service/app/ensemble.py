"""
ensemble.py — 多模型加權投票引擎（v12 adaptive）
動態權重 × Regime Filter × Stacking Meta-Learner × GARCH 停損 × Soft Gate

三層 meta 架構：
  ① HMM Regime → ② Models + LinUCB → ③ Conformal Prediction → ARF

改動（v12）：
  - Isolation Forest 從 hard gate 降級為 anomaly_score soft penalty
  - confidence/consensus 雙低才 NO_SIGNAL，單項不過降級為 HOLD
  - signal_strength 從硬階梯改為 direction_weight × confidence 連續分數
  - confidence_threshold 從 0.60 降至 0.55（adaptive via KV）
"""
import numpy as np
from dataclasses import dataclass
from typing import Literal, Any
from .models import ModelPrediction

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
    anomaly_score: float = 0.0,               # Isolation Forest soft penalty（不再 hard gate）
    lifecycle_weights: dict[str, float] | None = None,  # P1#8 來自 model_lifecycle（降權/影子）
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
    down_weight = 1.0 - up_weight

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
        except Exception:
            pass

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

    # SL/TP base multipliers 從 KV 讀取（Optuna #3 可搜尋）
    _sl_base = float(_adaptive.get("sl_mult_base", 2.0))
    _tp_base = float(_adaptive.get("tp_mult_base", 1.5))
    _vol_low = float(_adaptive.get("vol_threshold_low", 0.015))
    _vol_high = float(_adaptive.get("vol_threshold_high", 0.03))
    if vol_pct < _vol_low:      # 低波動：收緊
        sl_mult, tp_mult = _sl_base * 0.75, _tp_base * 0.67
    elif vol_pct < _vol_high:     # 正常
        sl_mult, tp_mult = _sl_base, _tp_base
    else:                    # 高波動：放寬
        sl_mult, tp_mult = _sl_base * 1.25, _tp_base * 1.33

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
