"""
routers/recommend.py — POST /recommend

Worker 傳入已從 D1 pre-query 好的股票多因子資料 → Controller 計算分數 → LLM 生成理由
→ 回傳 top5 推薦 + sector_flow → Worker 寫入 D1。

Worker 呼叫格式：
  POST /recommend
  {
    "date": "2026-03-27",
    "stocks": [ { stock_id, symbol, name, sector, current_price,
                  foreign_net_5d, trust_net_5d, foreign_consecutive,
                  rsi14, macd_hist, ma5, ma20, ma60,
                  ml_signal, ml_confidence, ml_forecast_pct,
                  hist_accuracy, hist_count } ],
    "sectors": [ { sector, foreign_net, trust_net, total_net,
                   avg_rsi, avg_momentum_5d, stock_count, up_count } ],
    "anthropic_api_key": str,   # Worker 透過 env 傳入（避免 Controller 直接存 secret）
    "top_n": 5
  }

回傳：
  {
    "recommendations": [
      { rank, stock_id, symbol, name, sector, score, chip_score, tech_score, ml_score,
        current_price, foreign_net_5d, trust_net_5d, rsi14, macd_hist,
        ml_signal, ml_confidence, reason, watch_points, has_buy_signal }
    ],
    "sectors": [ sector_flow ... ]   # pass-through（原封不動）
  }
"""
import os
import json
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any, Optional

from services.scorer import score_and_rank
from services.llm_service import generate_reasons

logger = logging.getLogger(__name__)
router = APIRouter()

_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


class RecommendRequest(BaseModel):
    date: str
    stocks: list[dict[str, Any]]
    sectors: list[dict[str, Any]] = []
    anthropic_api_key: Optional[str] = None
    top_n: int = 5


@router.post("/recommend")
def post_recommend(req: RecommendRequest):
    if not req.stocks:
        return {"recommendations": [], "sectors": req.sectors}

    # 1. 多因子評分
    scored = score_and_rank(req.stocks)
    top = scored[:req.top_n]

    if not top:
        logger.info(f"[recommend] date={req.date}: no stocks passed min_score threshold")
        return {"recommendations": [], "sectors": req.sectors}

    # 2. LLM 推薦理由
    api_key = req.anthropic_api_key or _ANTHROPIC_KEY
    reasons = generate_reasons(api_key, top, req.sectors) if api_key else []
    if len(reasons) < len(top):
        reasons += [{"reason": "量化指標呈現強勢訊號", "watch_points": []}] * (len(top) - len(reasons))

    # 3. 組裝回傳（Worker 直接用此格式寫入 D1）
    recommendations = []
    for i, (s, r) in enumerate(zip(top, reasons)):
        recommendations.append({
            "rank":            i + 1,
            "stock_id":        s.stock_id,
            "symbol":          s.symbol,
            "name":            s.name,
            "sector":          s.sector,
            "score":           s.total_score,
            "chip_score":      s.chip_score,
            "tech_score":      s.tech_score,
            "ml_score":        s.ml_score,
            "current_price":   s.current_price,
            "foreign_net_5d":  s.foreign_net_5d / 1e8,
            "trust_net_5d":    s.trust_net_5d / 1e8,
            "rsi14":           s.rsi14,
            "macd_hist":       s.macd_hist,
            "ml_signal":       s.ml_signal,
            "ml_confidence":   s.ml_confidence,
            "has_buy_signal":  1 if (s.ml_signal and "BUY" in s.ml_signal) else 0,
            "reason":          r.get("reason", "")[:500],
            "watch_points":    json.dumps(r.get("watch_points", [])[:3]),
        })

    logger.info(f"[recommend] date={req.date} top={[r['symbol'] for r in recommendations]}")
    return {"recommendations": recommendations, "sectors": req.sectors}
