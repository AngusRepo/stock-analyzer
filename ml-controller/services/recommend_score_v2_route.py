"""Score V2 scorer for the registered /recommend route.

The route accepts lightweight stock dictionaries, builds canonical Score V2
payloads, and ranks by Score V2 finalScore.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.recommendation_service import build_score_components as build_score_v2_payload

_SCORE_ROW_OPTIONAL_KEYS = (
    "alpha_context",
    "chip_evidence",
    "ma20",
    "plus_di14",
    "plusDi14",
    "minus_di14",
    "minusDi14",
    "adx14",
    "atr14",
    "parabolic_sar",
    "parabolicSar",
    "cci20",
    "volume_weighted_rsi14",
    "volumeWeightedRsi14",
    "volume_momentum_divergence_13_27_10",
    "volumeMomentumDivergence132710",
)


@dataclass(frozen=True)
class ScoreV2RecommendationCandidate:
    stock_id: int
    symbol: str
    name: str
    sector: str | None
    current_price: float | None
    foreign_net_5d: float
    trust_net_5d: float
    total_chip_5d: float
    foreign_consecutive: int
    rsi14: float | None
    macd_hist: float | None
    above_ma5: bool
    above_ma20: bool
    above_ma60: bool
    ml_signal: str | None
    ml_confidence: float | None
    ml_forecast_pct: float | None
    chip_flow_seed40: float
    technical_seed30: float
    screener_momentum_seed20: float
    ml_edge_seed30: float
    score_v2: dict[str, Any]

    @property
    def final_score(self) -> float:
        return float(self.score_v2.get("finalScore", self.score_v2.get("total", 0.0)) or 0.0)


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number == number and number not in (float("inf"), float("-inf")) else fallback


def _optional_number(value: Any) -> float | None:
    if value is None:
        return None
    number = _number(value, float("nan"))
    return number if number == number else None


def _chip_flow_seed_score(total_chip_5d: float, foreign_consecutive: int) -> float:
    billion = total_chip_5d / 1e8
    if billion > 10:
        score = 36.0
    elif billion > 5:
        score = 28.0
    elif billion > 2:
        score = 20.0
    elif billion > 0:
        score = 12.0
    elif billion > -2:
        score = 5.0
    else:
        score = 0.0
    if foreign_consecutive >= 5:
        score = min(40.0, score + 4.0)
    elif foreign_consecutive >= 3:
        score = min(40.0, score + 2.0)
    return score


def _technical_structure_seed_score(
    rsi14: float | None,
    macd_hist: float | None,
    above_ma5: bool,
    above_ma20: bool,
    above_ma60: bool,
) -> float:
    score = 0.0
    if rsi14 is not None:
        if 55 <= rsi14 <= 70:
            score += 12.0
        elif 50 <= rsi14 < 55:
            score += 8.0
        elif 45 <= rsi14 < 50:
            score += 4.0
        elif rsi14 > 70:
            score += 5.0
    if macd_hist is not None:
        if macd_hist > 0:
            score += 8.0
        elif macd_hist > -0.5:
            score += 3.0
    if above_ma5:
        score += 3.0
    if above_ma20:
        score += 4.0
    if above_ma60:
        score += 3.0
    return min(30.0, score)


def _ml_edge_seed_score(
    ml_signal: str | None,
    ml_confidence: float | None,
    hist_accuracy: float | None,
    hist_count: int,
) -> float:
    if not ml_signal:
        return 0.0
    if "STRONG_BUY" in ml_signal:
        base = 28.0
    elif "BUY" in ml_signal:
        base = 20.0
    elif ml_signal == "HOLD":
        base = 10.0
    elif "SELL" in ml_signal:
        base = 2.0
    else:
        base = 0.0
    if ml_confidence is not None:
        base = round(base * (0.7 + ml_confidence * 0.3))
    if hist_accuracy is not None and hist_count >= 10:
        if hist_accuracy > 0.60:
            multiplier = 1 + (hist_accuracy - 0.6) * 1.5
        elif hist_accuracy < 0.45:
            multiplier = 0.6 + hist_accuracy
        else:
            multiplier = 1.0
        base = round(base * multiplier)
    return min(30.0, base)


def _score_v2_builder_row(
    stock: dict[str, Any],
    *,
    score_seed_inputs: dict[str, float],
    current_price: float | None,
    rsi14: float | None,
    macd_hist: float | None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "score_seed_inputs": score_seed_inputs,
        "current_price": current_price,
        "rsi14": rsi14,
        "macd_hist": macd_hist,
    }
    for key in _SCORE_ROW_OPTIONAL_KEYS:
        if key in stock:
            row[key] = stock[key]
    return row


def build_score_v2_route_candidate(stock: dict[str, Any]) -> ScoreV2RecommendationCandidate:
    price = _optional_number(stock.get("current_price"))
    ma5 = _optional_number(stock.get("ma5"))
    ma20 = _optional_number(stock.get("ma20"))
    ma60 = _optional_number(stock.get("ma60"))
    foreign_5d = _number(stock.get("foreign_net_5d"))
    trust_5d = _number(stock.get("trust_net_5d"))
    total_chip = foreign_5d + trust_5d
    consecutive = int(_number(stock.get("foreign_consecutive")))
    rsi14 = _optional_number(stock.get("rsi14"))
    macd_hist = _optional_number(stock.get("macd_hist"))
    hist_accuracy = _optional_number(stock.get("hist_accuracy"))
    hist_count = int(_number(stock.get("hist_count")))
    ml_signal = stock.get("ml_signal")
    ml_confidence = _optional_number(stock.get("ml_confidence"))
    above_ma5 = price is not None and ma5 is not None and price > ma5
    above_ma20 = price is not None and ma20 is not None and price > ma20
    above_ma60 = price is not None and ma60 is not None and price > ma60
    chip_flow_seed40 = _chip_flow_seed_score(total_chip, consecutive)
    technical_seed30 = _technical_structure_seed_score(rsi14, macd_hist, above_ma5, above_ma20, above_ma60)
    screener_momentum_seed20 = _number(stock.get("screener_momentum_seed20"))
    ml_edge_seed30 = _ml_edge_seed_score(ml_signal, ml_confidence, hist_accuracy, hist_count)
    score_seed_inputs = {
        "chipFlowSeed40": chip_flow_seed40,
        "technicalSeed30": technical_seed30,
        "screenerMomentumSeed20": screener_momentum_seed20,
        "mlEdgeSeed30": ml_edge_seed30,
    }
    score_row = _score_v2_builder_row(
        stock,
        score_seed_inputs=score_seed_inputs,
        current_price=price,
        rsi14=rsi14,
        macd_hist=macd_hist,
    )
    score_v2 = build_score_v2_payload(
        score_row,
        raw_score=sum(score_seed_inputs.values()),
    )
    return ScoreV2RecommendationCandidate(
        stock_id=int(stock["stock_id"]),
        symbol=str(stock["symbol"]),
        name=str(stock.get("name", "")),
        sector=stock.get("sector"),
        current_price=price,
        foreign_net_5d=foreign_5d,
        trust_net_5d=trust_5d,
        total_chip_5d=total_chip,
        foreign_consecutive=consecutive,
        rsi14=rsi14,
        macd_hist=macd_hist,
        above_ma5=above_ma5,
        above_ma20=above_ma20,
        above_ma60=above_ma60,
        ml_signal=str(ml_signal) if ml_signal is not None else None,
        ml_confidence=ml_confidence,
        ml_forecast_pct=_optional_number(stock.get("ml_forecast_pct")),
        chip_flow_seed40=chip_flow_seed40,
        technical_seed30=technical_seed30,
        screener_momentum_seed20=screener_momentum_seed20,
        ml_edge_seed30=ml_edge_seed30,
        score_v2=score_v2,
    )


def rank_score_v2_route_candidates(stocks: list[dict[str, Any]], min_final_score: float = 30.0) -> list[ScoreV2RecommendationCandidate]:
    candidates = [build_score_v2_route_candidate(stock) for stock in stocks]
    return sorted(
        [candidate for candidate in candidates if candidate.final_score >= min_final_score],
        key=lambda candidate: candidate.final_score,
        reverse=True,
    )
