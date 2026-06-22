"""
routers/risk.py — POST /risk-assess

Worker 傳入已計算好的市場風險資料 + 模型準確率 + 紙盤盈虧
→ Controller 計算自適應參數 → 回傳 AdaptiveParams → Worker 寫入 KV。

Worker 呼叫格式：
  POST /risk-assess
  {
    "date": "2026-03-27",
    "market": {
      "risk_score": float,          # 0~100
      "risk_level": str,            # "green"|"yellow"|"orange"|"red"|"black"
    },
    "accuracy": {
      "global_30d": float,          # ensemble 全局 30d 準確率（0~1）
      "rows_30d": [{ model_name, profit_factor, total_count }],
      "rows_90d": [{ model_name, profit_factor }],
    },
    "trading": {
      "losses_5d": int,             # 近 5 天紙盤虧損筆數
      "total_5d": int,              # 近 5 天紙盤總出場筆數
    },
    "current_version": int          # 現有 KV 版本號
  }

回傳：
  {
    "adaptive_params": { ...AdaptiveParams dict... },
    "summary": str    # 供 scheduler run log 用的摘要字串
  }
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Optional

from services.adaptive import compute_adaptive_params

logger = logging.getLogger(__name__)
router = APIRouter()


class MarketData(BaseModel):
    risk_score: float = 50.0
    risk_level: str = "medium"


class AccuracyData(BaseModel):
    global_30d: float = 0.6
    active_9_quality_30d: float | None = None
    active_9_samples_30d: int | None = None
    active_9_model_count_30d: int | None = None
    rows_30d: list[dict[str, Any]] = []
    rows_90d: list[dict[str, Any]] = []


class TradingData(BaseModel):
    losses_5d: int = 0
    total_5d: int = 0


class AdaptiveConfigData(BaseModel):
    L2_formula: dict[str, Any] = Field(default_factory=dict)
    baseline_buy_signal_score: float | None = None
    ga_optimizer: dict[str, Any] | None = None


class RiskAssessRequest(BaseModel):
    date: str
    market: MarketData = MarketData()
    accuracy: AccuracyData = AccuracyData()
    trading: TradingData = TradingData()
    adaptive_config: AdaptiveConfigData = Field(default_factory=AdaptiveConfigData)
    current_version: int = 0


@router.post("/risk-assess")
def post_risk_assess(req: RiskAssessRequest):
    if not req.adaptive_config.L2_formula:
        raise HTTPException(
            status_code=422,
            detail="adaptive_config.L2_formula is required; controller fallback defaults are disabled on /risk-assess",
        )
    params = compute_adaptive_params(
        risk_score=req.market.risk_score,
        risk_level=req.market.risk_level,
        accuracy_30d=req.accuracy.global_30d,
        rows_30d=req.accuracy.rows_30d,
        rows_90d=req.accuracy.rows_90d,
        losses_5d=req.trading.losses_5d,
        total_5d=req.trading.total_5d,
        current_version=req.current_version,
        L2_formula=req.adaptive_config.L2_formula,
        baseline_buy_signal_score=req.adaptive_config.baseline_buy_signal_score,
        active_9_quality_30d=req.accuracy.active_9_quality_30d,
        active_9_samples_30d=req.accuracy.active_9_samples_30d,
        active_9_model_count_30d=req.accuracy.active_9_model_count_30d,
        ga_optimizer_context=req.adaptive_config.ga_optimizer,
    )

    sl_tp = params.get("sl_tp_override")
    bandit_str = "explore!" if params["bandit_force_explore"] else f"maxMult={params['bandit_max_mult']}"
    sl_str = f"sl+{sl_tp['sl_add']}/tp+{sl_tp['tp_add']}" if sl_tp else "sl/tp=default"
    summary = " | ".join([
        f"v{params['version']}",
        f"conf={params['confidence_threshold']:.2f}",
        f"risk={req.market.risk_level}({req.market.risk_score:.0f})",
        f"acc30d={params['recent_accuracy_30d']*100:.0f}%",
        f"bandit={bandit_str}",
        sl_str,
    ])

    logger.info(f"[risk-assess] date={req.date} {summary}")
    return {
        "adaptive_params": params,
        "summary": summary,
    }
