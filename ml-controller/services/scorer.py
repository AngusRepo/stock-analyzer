"""
services/scorer.py — 個股多因子評分引擎

從 Worker dailyRecommendation.ts 移植的評分邏輯（Python 版）。

輸入：Worker 從 D1 pre-query 好的 stock data dict
輸出：chip_score (0-40), tech_score (0-30), ml_score (0-30), total_score (0-100)
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass
class StockScore:
    stock_id: int
    symbol: str
    name: str
    sector: Optional[str]
    current_price: Optional[float]
    # 籌碼原始數值
    foreign_net_5d: float
    trust_net_5d: float
    total_chip_5d: float
    foreign_consecutive: int
    # 技術原始數值
    rsi14: Optional[float]
    macd_hist: Optional[float]
    above_ma5: bool
    above_ma20: bool
    above_ma60: bool
    # ML 原始數值
    ml_signal: Optional[str]
    ml_confidence: Optional[float]
    ml_forecast_pct: Optional[float]
    # 計算分數
    chip_score: int   # 0-40
    tech_score: int   # 0-30
    ml_score: int     # 0-30
    total_score: int  # 0-100


def _chip_score(
    total_chip_5d: float,      # 原始值（元），需轉億
    foreign_consecutive: int,
) -> int:
    """籌碼分數 0-40：外資+投信 5 日淨買超量 + 連買天數加分。"""
    billion = total_chip_5d / 1e8
    if   billion > 10: score = 36
    elif billion >  5: score = 28
    elif billion >  2: score = 20
    elif billion >  0: score = 12
    elif billion > -2: score = 5
    else:              score = 0

    if   foreign_consecutive >= 5: score = min(40, score + 4)
    elif foreign_consecutive >= 3: score = min(40, score + 2)
    return score


def _tech_score(
    rsi14: Optional[float],
    macd_hist: Optional[float],
    above_ma5: bool,
    above_ma20: bool,
    above_ma60: bool,
) -> int:
    """技術分數 0-30：RSI + MACD + 均線多頭排列。"""
    score = 0
    if rsi14 is not None:
        if   55 <= rsi14 <= 70: score += 12
        elif 50 <= rsi14 <  55: score += 8
        elif 45 <= rsi14 <  50: score += 4
        elif rsi14 > 70:        score += 5  # 超買但動能存在

    if macd_hist is not None:
        if   macd_hist > 0:    score += 8
        elif macd_hist > -0.5: score += 3

    if above_ma5:  score += 3
    if above_ma20: score += 4
    if above_ma60: score += 3

    return min(30, score)


def _ml_score(
    ml_signal: Optional[str],
    ml_confidence: Optional[float],
    hist_accuracy: Optional[float],    # ensemble 30d accuracy（0~1）
    hist_count: int,                   # 樣本數（< 10 時不調整）
) -> int:
    """ML 分數 0-30：訊號強度 × 信心度 × 歷史勝率加權。"""
    if not ml_signal:
        return 0

    if   "STRONG_BUY" in ml_signal: base = 28
    elif "BUY"        in ml_signal: base = 20
    elif ml_signal == "HOLD":       base = 10
    elif "SELL"       in ml_signal: base = 2
    else:                           base = 0

    # 信心度加權
    if ml_confidence:
        base = round(base * (0.7 + ml_confidence * 0.3))

    # 歷史勝率加權
    if hist_accuracy is not None and hist_count >= 10:
        if   hist_accuracy > 0.60: mult = 1 + (hist_accuracy - 0.6) * 1.5
        elif hist_accuracy < 0.45: mult = 0.6 + hist_accuracy
        else:                      mult = 1.0
        base = round(base * mult)

    return min(30, base)


def score_stock(stock: dict) -> StockScore:
    """
    計算單股分數。

    stock dict 結構（Worker 從 D1 整合好傳入）：
    {
      "stock_id": int,
      "symbol": str,
      "name": str,
      "sector": str | null,
      "current_price": float | null,
      "foreign_net_5d": float,        # 外資 5 日淨買超（元）
      "trust_net_5d": float,          # 投信 5 日淨買超（元）
      "foreign_consecutive": int,     # 連買天數（負=賣超）
      "rsi14": float | null,
      "macd_hist": float | null,
      "ma5": float | null,
      "ma20": float | null,
      "ma60": float | null,
      "ml_signal": str | null,
      "ml_confidence": float | null,
      "ml_forecast_pct": float | null,
      "hist_accuracy": float | null,  # ensemble 30d accuracy
      "hist_count": int,              # 歷史樣本數
    }
    """
    price        = stock.get("current_price")
    ma5          = stock.get("ma5")
    ma20         = stock.get("ma20")
    ma60         = stock.get("ma60")
    foreign_5d   = float(stock.get("foreign_net_5d") or 0)
    trust_5d     = float(stock.get("trust_net_5d") or 0)
    total_chip   = foreign_5d + trust_5d
    consecutive  = int(stock.get("foreign_consecutive") or 0)

    above_ma5  = price is not None and ma5  is not None and price > ma5
    above_ma20 = price is not None and ma20 is not None and price > ma20
    above_ma60 = price is not None and ma60 is not None and price > ma60

    cs = _chip_score(total_chip, consecutive)
    ts = _tech_score(
        stock.get("rsi14"),
        stock.get("macd_hist"),
        above_ma5, above_ma20, above_ma60,
    )
    ms = _ml_score(
        stock.get("ml_signal"),
        stock.get("ml_confidence"),
        stock.get("hist_accuracy"),
        int(stock.get("hist_count") or 0),
    )

    return StockScore(
        stock_id=stock["stock_id"],
        symbol=stock["symbol"],
        name=stock.get("name", ""),
        sector=stock.get("sector"),
        current_price=price,
        foreign_net_5d=foreign_5d,
        trust_net_5d=trust_5d,
        total_chip_5d=total_chip,
        foreign_consecutive=consecutive,
        rsi14=stock.get("rsi14"),
        macd_hist=stock.get("macd_hist"),
        above_ma5=above_ma5,
        above_ma20=above_ma20,
        above_ma60=above_ma60,
        ml_signal=stock.get("ml_signal"),
        ml_confidence=stock.get("ml_confidence"),
        ml_forecast_pct=stock.get("ml_forecast_pct"),
        chip_score=cs,
        tech_score=ts,
        ml_score=ms,
        total_score=cs + ts + ms,
    )


def score_and_rank(stocks: list[dict], min_total: int = 30) -> list[StockScore]:
    """
    對所有股票評分並排序。
    min_total: 低於此分數的股票過濾掉（避免雜訊）。
    """
    scored = [score_stock(s) for s in stocks]
    return sorted(
        [s for s in scored if s.total_score >= min_total],
        key=lambda s: s.total_score,
        reverse=True,
    )
