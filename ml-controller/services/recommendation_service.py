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
from typing import Any, Optional

from services import d1_client
from services._predictions_schema import (
    COL_STOCK_ID,
    COL_MODEL_NAME,
    COL_GENERATED_AT,
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

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# ML score calculation (port from dailyRecommendation.ts:558-568)
# ─────────────────────────────────────────────────────────────────────────────

def calculate_ml_score(prediction: dict) -> float:
    """Compute ml_score 0-30 from prediction signal/confidence/forecast."""
    if not prediction:
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
    total = s.get("ml_models_total") or 0
    up = s.get("ml_models_up") or 0
    down = s.get("ml_models_down") or 0
    forecast_pct = s.get("ml_forecast_pct") or 0
    fp_str = f"{'+' if forecast_pct > 0 else ''}{forecast_pct * 100:.1f}%"

    if total == 0:
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

def filter_and_score_recommendations(
    screener_recs: list[dict],
    predictions: dict[str, dict],   # symbol → ml result from ml-service
    payloads: list[dict],            # PredictPayload as dict (for reason data)
    persona_opinions: dict | None = None,  # symbol → {trust:{...}, retail:{...}}
    persona_weight: float = 1.0,   # 0 = disable, 1 = default, 0.5 = shadow mode
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
        sig = (ml.get("signal") or "").upper() if ml else None

        # Filter SELL / NO_SIGNAL
        if sig and ("SELL" in sig or sig == "NO_SIGNAL"):
            sell_count += 1
            continue

        # ML score
        ml_score = calculate_ml_score(ml) if ml else 0.0
        chip_score = rec.get("chip_score") or 0
        tech_score = rec.get("tech_score") or 0

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
        env_for_stock = payload.get("market_env", {}) if payload else {}

        # Extract latest indicator values from payload (RSI, MACD, MA20)
        indicators = payload.get("indicators", []) if payload else []
        latest_ind = indicators[-1] if indicators else {}

        # Latest price from payload
        prices = payload.get("prices", []) if payload else []
        current_price = prices[-1]["close"] if prices else (rec.get("current_price"))

        # Foreign / trust net (5d sum from chips)
        chips = payload.get("chips", []) if payload else []
        recent_chips = chips[-5:]
        foreign_net_5d = sum((c.get("foreign_net") or 0) for c in recent_chips)
        trust_net_5d = sum((c.get("trust_net") or 0) for c in recent_chips)

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

        reason_data = {
            "foreign_consecutive": 0,  # TODO: compute consec from chips if needed
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "rsi14": latest_ind.get("rsi14"),
            "macd_hist": latest_ind.get("macdHist"),
            "current_price": current_price,
            "ma20": latest_ind.get("ma20"),
            "_signal": ml.get("signal") if ml else None,
            "ml_confidence": (ml.get("confidence") if ml else 0) or 0,
            "ml_forecast_pct": (ml.get("forecast_pct") if ml else 0) or 0,
            "ml_models_total": ml_models_total,
            "ml_models_up": ml_models_up,
            "ml_models_down": ml_models_down,
        }

        final.append({
            "date": rec["date"],
            "symbol": symbol,
            "rec_id": rec.get("id"),
            "name": rec.get("name"),
            "sector": rec.get("sector"),
            "industry": rec.get("industry"),
            "chip_score": chip_score,
            "tech_score": tech_score,
            "ml_score": ml_score,
            "persona_score": persona_score,
            "persona_applied": persona_applied,  # None if no persona data
            "score": total_score,
            "signal": ml.get("signal") if ml else None,
            "confidence": ml.get("confidence") if ml else None,
            "current_price": current_price,
            "has_buy_signal": 1 if (sig and "BUY" in sig) else 0,
            "reason": build_reason(reason_data),
            "watch_points": build_watch_points(reason_data),
            "foreign_net_5d": foreign_net_5d / 1e8,
            "trust_net_5d": trust_net_5d / 1e8,
            "rsi14": latest_ind.get("rsi14"),
            "macd_hist": latest_ind.get("macdHist"),
        })

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


def hybrid_ranking_promotion(
    recommendations: list[dict],
    ranking_config: dict,
) -> list[dict]:
    """
    Sprint 3 P0-4: combined_score = α*screener_norm + β*ml_conf + γ*signal_tier
    若 has_buy_signal < topK，從 has_buy_signal=0 pool 挑 top promote。
    """
    if not ranking_config or not ranking_config.get("enabled", True):
        return recommendations

    alpha = ranking_config.get("alpha", 0.40)
    beta = ranking_config.get("beta", 0.40)
    gamma = ranking_config.get("gamma", 0.20)
    screener_denom = ranking_config.get("screenerDenominator", 60.0)
    top_k = ranking_config.get("topK", 3)
    promote_min_conf = ranking_config.get("promoteMinConf", 0.60)

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
    if current_buy >= top_k:
        logger.info(f"[Ranking] has_buy_signal={current_buy} >= topK={top_k}, no promotion")
        return scored

    need_promote = top_k - current_buy
    pool = sorted(
        [r for r in scored if r.get("has_buy_signal") == 0],
        key=lambda x: x.get("_combined_score", 0),
        reverse=True,
    )[:need_promote]

    promoted_syms = []
    for r in pool:
        r["has_buy_signal"] = 1
        r["confidence"] = max(r.get("confidence") or 0, promote_min_conf)
        promoted_syms.append(r["symbol"])

    if promoted_syms:
        logger.info(
            f"[Ranking] Promoted {len(promoted_syms)} to has_buy_signal=1 "
            f"(current={current_buy} < topK={top_k}): {promoted_syms}"
        )
    return scored


# ─────────────────────────────────────────────────────────────────────────────
# D1 writers
# ─────────────────────────────────────────────────────────────────────────────

def write_predictions_to_d1(predictions: dict[str, dict], stock_id_map: dict[str, int]) -> int:
    """
    Write predictions table.
    predictions: {symbol: ml_result}
    stock_id_map: {symbol: stock_id} from active stocks

    Returns count written.
    """
    statements: list[tuple[str, list[Any]]] = []
    for symbol, data in predictions.items():
        if data.get("error"):
            continue
        stock_id = stock_id_map.get(symbol)
        if not stock_id:
            continue
        raw_signal = data.get("signal") or "NO_SIGNAL"
        if raw_signal == "NO_SIGNAL":
            trade_signal = None
        elif "BUY" in raw_signal:
            trade_signal = "buy"
        elif "SELL" in raw_signal:
            trade_signal = "sell"
        else:
            trade_signal = "hold"

        forecast_data = json.dumps({
            "signal": raw_signal,
            "models": data.get("models"),
            "forecasts": data.get("forecasts"),
            "arf_features": data.get("arf_features"),
        }, ensure_ascii=False)

        # H2: delete stale before insert
        statements.append((
            f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}='ensemble' "
            f"AND date({COL_GENERATED_AT})=date('now')",
            [stock_id],
        ))
        statements.append((
            INSERT_PREDICTIONS_SQL,
            [
                stock_id,
                14,
                data.get("confidence"),
                forecast_data,
                data.get("entry_price"),
                data.get("stop_loss"),
                data.get("target1"),
                data.get("target2"),
                trade_signal,
                data.get("feature_version"),
                raw_signal,
            ],
        ))

        # 2026-04-19 ML_POOL Stage 2: per-model rows for weekly IC tracking.
        # Stages 2+3: active rows model_name='{name}'; challenger rows
        # model_name='{name}::challenger' (Stage 3 shadow IC tracking).
        per_model_scores = _extract_per_model_scores_for_d1(data)
        # Stage 3: also extract challenger scores (5 feature models only;
        # time-series challengers handled separately in pipeline_v2 future work)
        challenger_scores = data.get("challenger_rank_scores") or {}
        for ch_name, ch_score in (challenger_scores or {}).items():
            try:
                per_model_scores[f"{ch_name}::challenger"] = float(ch_score)
            except (TypeError, ValueError):
                pass
        for model_name, model_score in per_model_scores.items():
            per_model_forecast = json.dumps(
                {"signal": raw_signal, "rank_score": model_score, "source": "model_pool_stage2"},
                ensure_ascii=False,
            )
            statements.append((
                f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}=? "
                f"AND date({COL_GENERATED_AT})=date('now')",
                [stock_id, model_name],
            ))
            # Use INSERT with explicit model_name override (INSERT_PREDICTIONS_SQL
            # hardcodes 'ensemble'; build a parallel SQL for per-model name).
            statements.append((
                _build_per_model_insert_sql(),
                [
                    stock_id, model_name,
                    14,                     # horizon
                    float(model_score),     # direction_accuracy = rank_score
                    per_model_forecast,
                    data.get("entry_price"),
                    data.get("stop_loss"),
                    data.get("target1"),
                    data.get("target2"),
                    trade_signal,
                    data.get("feature_version"),
                    raw_signal,
                ],
            ))

    if not statements:
        return 0
    result = d1_client.batch_execute(statements)
    # Each prediction row = 2 statements (delete + insert), so written count is
    # success_count / 2. With per-model rows, total rows per stock = 1 ensemble
    # + N per-model = (1 + N) × 2 statements.
    written = result.get("success_count", result.get("total", 0)) // 2
    logger.info(f"[recommendation_service] Wrote {written} prediction rows to D1 (incl. per-model)")
    return written


# ─────────────────────────────────────────────────────────────────────────────
# 2026-04-19 ML_POOL Stage 2 helpers (per-model row writers)
# ─────────────────────────────────────────────────────────────────────────────

# Models whose rank scores we want stored for weekly IC tracking.
# Mirrors ml-service app/model_pool.py:MANAGED_MODELS keys.
_PER_MODEL_TRACKED = ("XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
                       "Chronos", "DLinear", "PatchTST")


def _extract_per_model_scores_for_d1(pred: dict) -> dict[str, float]:
    """Pull out per-model rank scores from one stock's prediction dict.

    For 5 feature models: read pred["rank_scores"][model_name] (raw 0~1
      from predict_stock_v2 — exposed in commit 005ebee).
    For 3 time-series: sigmoid-map pred["chronos"|"dlinear"|"patchtst"]
      .forecast_pct to a rank 0~1 (mirror of pipeline_v2._ts_to_rank).

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
    for src_key, model_name in (("chronos", "Chronos"), ("dlinear", "DLinear"), ("patchtst", "PatchTST")):
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
    {COL_STOCK_ID}, {COL_MODEL_NAME}, {COL_GENERATED_AT}, {COL_HORIZON}, {COL_DIRECTION_ACCURACY},
    {COL_FORECAST_DATA}, {COL_ENTRY_PRICE}, {COL_STOP_LOSS}, {COL_TARGET1}, {COL_TARGET2},
    {COL_TRADE_SIGNAL}, {COL_FEATURE_VERSION}, {COL_SIGNAL_RAW}
) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()


def update_recommendations_in_d1(
    recommendations: list[dict],
    run_date: str,
) -> int:
    """
    Update existing daily_recommendations rows with ml_score / signal / reason / watchPoints / etc.
    Also delete SELL-filtered rows.

    Strategy: do an UPDATE per row (D1 batch_execute), then re-rank.
    """
    if not recommendations:
        return 0

    statements: list[tuple[str, list[Any]]] = []
    for r in recommendations:
        statements.append((
            "UPDATE daily_recommendations SET "
            "ml_score = ?, score = ?, signal = ?, confidence = ?, "
            "current_price = ?, has_buy_signal = ?, "
            "reason = ?, watch_points = ?, "
            "foreign_net_5d = ?, trust_net_5d = ?, rsi14 = ?, macd_hist = ? "
            "WHERE date = ? AND symbol = ?",
            [
                r.get("ml_score") or 0,
                r.get("score") or 0,
                r.get("signal"),
                r.get("confidence"),
                r.get("current_price"),
                r.get("has_buy_signal") or 0,
                r.get("reason"),
                json.dumps(r.get("watch_points") or [], ensure_ascii=False),
                r.get("foreign_net_5d") or 0,
                r.get("trust_net_5d") or 0,
                r.get("rsi14"),
                r.get("macd_hist"),
                run_date,
                r["symbol"],
            ],
        ))

    result = d1_client.batch_execute(statements)
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
    """Re-rank daily_recommendations by score DESC after filter+promotion."""
    rows = d1_client.query(
        "SELECT symbol FROM daily_recommendations WHERE date = ? ORDER BY score DESC",
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
                r["watch_points"] = entry["watchPoints"]
