"""
_rrg_calculator.py — RRG (Relative Rotation Graph) vs-benchmark formula

Single source of truth for RS ratio / momentum / quadrant computation.
1:1 port of worker/src/lib/dailyRecommendation.ts:170-204 (V1 formula).

Phase 6.1 of 4/8 audit — replaces:
- V1 dailyRecommendation.ts theme RRG (correct formula, wrong filter: is_active=1)
- V1 marketScreener.ts:calcIndustryRRG (wrong formula: Z-score, not RRG)

Formula (Julius de Kempenaer original):
    rs_ratio = (1 + group_return_5d) / (1 + benchmark_return_5d) * 100
    rs_momentum = rs_ratio_today - rs_ratio_5d_ago
    quadrant:
        rs >= 100 + mom >= 0 → Leading
        rs >= 100 + mom <  0 → Weakening
        rs <  100 + mom <  0 → Lagging
        rs <  100 + mom >= 0 → Improving
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Literal, Optional

Quadrant = Literal["Leading", "Weakening", "Lagging", "Improving"]

# 最少成分股門檻 (返回數 >= 3 才算 theme return)
MIN_MEMBERS_FOR_RS = 3


@dataclass
class RrgPoint:
    """Single group's RRG state for one date."""
    sector: str
    rs_ratio: Optional[float]
    rs_momentum: Optional[float]
    quadrant: Optional[Quadrant]
    member_count: int
    theme_return_5d: Optional[float]


def compute_rs_ratio_vs_benchmark(
    group_return_5d: float,
    benchmark_return_5d: float,
) -> float:
    """
    Core RRG formula. 1:1 對齊 dailyRecommendation.ts:177-179.

    twii_return=0 時 fallback 到 105/95/100（避免 divide-by-zero）。

    Returns rounded to 2 decimals (Math.round(x * 100) / 100 equivalent).
    """
    if benchmark_return_5d != 0:
        raw = (1.0 + group_return_5d) / (1.0 + benchmark_return_5d) * 100.0
        return round(raw * 100) / 100  # 2 decimal places
    # Edge case: TWII 5d return = 0
    if group_return_5d > 0:
        return 105.0
    if group_return_5d < 0:
        return 95.0
    return 100.0


def classify_quadrant(rs_ratio: float, rs_momentum: Optional[float]) -> Quadrant:
    """
    Quadrant 分類。1:1 對齊 dailyRecommendation.ts:199-203.

    Note: rs_momentum None 時當 0 處理（跟 V1 `mom = s.rs_momentum ?? 0` 一致）。
    """
    mom = rs_momentum if rs_momentum is not None else 0.0
    if rs_ratio >= 100 and mom >= 0:
        return "Leading"
    if rs_ratio >= 100 and mom < 0:
        return "Weakening"
    if rs_ratio < 100 and mom < 0:
        return "Lagging"
    return "Improving"


def compute_theme_return(
    member_returns: list[float],
    min_members: int = MIN_MEMBERS_FOR_RS,
) -> Optional[float]:
    """
    平均法: sum(member_returns) / len.

    V1 line 173-175: `returns.reduce((a,b)=>a+b,0)/returns.length`。
    `returns.length < 3 → continue` 對應這裡回 None。
    """
    if len(member_returns) < min_members:
        return None
    return sum(member_returns) / len(member_returns)


def build_rrg_point(
    sector: str,
    member_returns: list[float],
    benchmark_return_5d: float,
    prev_rs_ratio: Optional[float] = None,
) -> RrgPoint:
    """
    從成分股 5d returns + benchmark 5d return + 前期 rs_ratio
    算出完整 RrgPoint。prev_rs_ratio None 時 rs_momentum 也為 None。
    """
    theme_ret = compute_theme_return(member_returns)
    if theme_ret is None:
        return RrgPoint(
            sector=sector,
            rs_ratio=None,
            rs_momentum=None,
            quadrant=None,
            member_count=len(member_returns),
            theme_return_5d=None,
        )
    rs_ratio = compute_rs_ratio_vs_benchmark(theme_ret, benchmark_return_5d)
    rs_momentum: Optional[float] = None
    if prev_rs_ratio is not None:
        # 對齊 V1 rounding: Math.round((rs - prev) * 100) / 100
        rs_momentum = round((rs_ratio - prev_rs_ratio) * 100) / 100
    quadrant = classify_quadrant(rs_ratio, rs_momentum)
    return RrgPoint(
        sector=sector,
        rs_ratio=rs_ratio,
        rs_momentum=rs_momentum,
        quadrant=quadrant,
        member_count=len(member_returns),
        theme_return_5d=theme_ret,
    )
