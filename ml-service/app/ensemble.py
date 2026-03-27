"""
ensemble.py — 多模型加權投票引擎（v11）
動態權重 × Regime Filter × Stacking Meta-Learner × GARCH 停損 × NO_SIGNAL 機制

架構：
  1. Isolation Forest 異常偵測（在 main.py 呼叫，異常直接 NO_SIGNAL）
  2. HMM Regime 偵測 → 根據市場狀態調整各模型的基礎權重
  3. 加權投票（準確率 × profit_factor × regime_multiplier × 信心）
  4. Stacking Meta-Learner 修正最終方向（若有訓練好的 meta-learner）
  5. GARCH 波動率 → 動態停損/停利倍數
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
        weights.append(acc_weight * conf_weight * quality_mult * regime_mult * bandit_mult)

    total_w = sum(weights) or 1.0
    norm_weights = [w / total_w for w in weights]

    # ── 加權方向投票 ──────────────────────────────────────────────────────────
    up_weight = sum(w for p, w in zip(predictions, norm_weights) if p.direction == "up")
    down_weight = 1.0 - up_weight

    # ── 加權平均預測漲跌幅 ────────────────────────────────────────────────────
    weighted_pct = sum(p.forecast_pct * w for p, w in zip(predictions, norm_weights))

    # ── 共識度（同向模型數量比例）─────────────────────────────────────────────
    up_count = sum(1 for p in predictions if p.direction == "up")
    consensus = max(up_count, len(predictions) - up_count) / len(predictions)

    # ── 整體信心分數 ──────────────────────────────────────────────────────────
    avg_confidence = sum(p.confidence * w for p, w in zip(predictions, norm_weights))

    # ── 信心門檻過濾（優先使用 adaptive KV 值，fallback 0.60）─────────────────
    CONFIDENCE_THRESHOLD = float(_adaptive.get("confidence_threshold", 0.60))
    CONSENSUS_THRESHOLD  = dynamic_consensus_thr   # 由 regime 決定（0.55~0.72）

    if avg_confidence < CONFIDENCE_THRESHOLD or consensus < CONSENSUS_THRESHOLD:
        return _no_signal(
            current_price, atr,
            f"信心不足（信心={avg_confidence:.2f}, 共識={consensus:.2f}, "
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
    if meta_direction is not None and meta_confidence is not None:
        is_up       = meta_direction == "up"
        final_conf  = (avg_confidence * 0.4 + meta_confidence * 0.6)  # meta 佔 60%
        reasoning_meta = f"[Meta-Learner 修正為 {'↑' if is_up else '↓'}，信心={meta_confidence:.0%}] "
    else:
        is_up       = up_weight > down_weight
        final_conf  = avg_confidence
        reasoning_meta = ""

    direction: Literal["up", "down"] = "up" if is_up else "down"
    direction_weight = up_weight if is_up else down_weight

    # 訊號強度
    if direction_weight >= 0.9 and final_conf >= 0.80:
        signal = "STRONG_BUY" if is_up else "STRONG_SELL"
        stars = 5
    elif direction_weight >= 0.75 and final_conf >= 0.70:
        signal = "BUY" if is_up else "SELL"
        stars = 4
    elif direction_weight >= 0.60:
        signal = "BUY" if is_up else "SELL"
        stars = 3
    else:
        signal = "HOLD"
        stars = 2

    # ── 停損/停利：GARCH 波動率優先，其次 ATR ──────────────────────────────
    # GARCH 給出的是「預測的未來波動率」，比回看 ATR 更有前瞻性
    effective_vol = garch_vol if (garch_vol and garch_vol > 0) else (atr if atr and atr > 0 else current_price * 0.02)
    vol_pct = effective_vol / current_price
    vol_source = "GARCH" if (garch_vol and garch_vol > 0) else "ATR"

    if vol_pct < 0.015:      # 低波動
        sl_mult, tp_mult = 1.5, 1.0
    elif vol_pct < 0.03:     # 正常
        sl_mult, tp_mult = 2.0, 1.5
    else:                    # 高波動
        sl_mult, tp_mult = 2.5, 2.0

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
