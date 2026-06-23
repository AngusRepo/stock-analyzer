"""
_rrg_calculator.py — RRG (Relative Rotation Graph) vs-benchmark formula

Single source of truth for RS ratio / momentum / quadrant computation.
1:1 port of worker/src/lib/dailyRecommendation.ts:170-204 (V1 formula).

Phase 6.1 of 4/8 audit — replaces:
- V1 dailyRecommendation.ts theme RRG (correct formula, wrong filter: in_current_watchlist=1)
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
import math
from dataclasses import dataclass, field
from typing import Literal, Optional

Quadrant = Literal["Leading", "Weakening", "Lagging", "Improving"]
RotationRegime = Literal[
    "improving_to_leading_breakout",
    "leading_persistent",
    "leading_confirming",
    "lagging_to_improving_recovery",
    "improving_accumulation",
    "improving_watch",
    "leading_to_weakening_distribution",
    "weakening_risk",
    "lagging_base_building",
    "lagging_risk",
    "insufficient_rotation_evidence",
]

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
    rotation_velocity: Optional[float] = None
    rotation_acceleration: Optional[float] = None
    quadrant_age: Optional[int] = None
    transition_path: Optional[str] = None
    rotation_score: Optional[float] = None
    rotation_regime: Optional[RotationRegime] = None
    rotation_hysteresis: Optional[str] = None
    rotation_window: int = 0
    rrg_tail: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class RrgHistoryPoint:
    date: str
    rs_ratio: Optional[float]
    rs_momentum: Optional[float]
    quadrant: Optional[Quadrant]


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


def classify_quadrant(rs_ratio: float, rs_momentum: Optional[float]) -> Optional[Quadrant]:
    """
    Quadrant 分類。1:1 對齊 dailyRecommendation.ts:199-203.

    Note: rs_momentum None 時當 0 處理（跟 V1 `mom = s.rs_momentum ?? 0` 一致）。
    """
    if rs_momentum is None:
        return None
    if rs_ratio >= 100 and rs_momentum >= 0:
        return "Leading"
    if rs_ratio >= 100 and rs_momentum < 0:
        return "Weakening"
    if rs_ratio < 100 and rs_momentum < 0:
        return "Lagging"
    return "Improving"


def _finite_float(value: object) -> Optional[float]:
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _round(value: Optional[float], ndigits: int = 6) -> Optional[float]:
    return round(value, ndigits) if value is not None and math.isfinite(value) else None


def _clip(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _dedup_quadrant_path(quadrants: list[Quadrant]) -> str:
    path: list[Quadrant] = []
    for q in quadrants:
        if not path or path[-1] != q:
            path.append(q)
    return "->".join(path[-4:])


def _rotation_regime(
    *,
    current: Quadrant,
    previous: Optional[Quadrant],
    quadrant_age: int,
    rs_ratio: float,
    rs_momentum: float,
    delta_rs: float,
    delta_momentum: float,
) -> RotationRegime:
    if current == "Leading":
        if previous == "Improving":
            return "improving_to_leading_breakout"
        if quadrant_age >= 3 and rs_ratio >= 100.0 and rs_momentum >= 0.0:
            return "leading_persistent"
        return "leading_confirming"
    if current == "Improving":
        if previous == "Lagging":
            return "lagging_to_improving_recovery"
        if delta_rs >= 0.0 and delta_momentum >= 0.0:
            return "improving_accumulation"
        return "improving_watch"
    if current == "Weakening":
        if previous == "Leading" or quadrant_age >= 2:
            return "leading_to_weakening_distribution"
        return "weakening_risk"
    if delta_momentum > 0.0:
        return "lagging_base_building"
    return "lagging_risk"


def _rotation_score(
    *,
    regime: RotationRegime,
    rs_ratio: float,
    rs_momentum: float,
    delta_rs: float,
    delta_momentum: float,
    quadrant_age: int,
) -> float:
    base = {
        "improving_to_leading_breakout": 0.85,
        "leading_persistent": 0.75,
        "leading_confirming": 0.55,
        "lagging_to_improving_recovery": 0.45,
        "improving_accumulation": 0.35,
        "improving_watch": 0.20,
        "leading_to_weakening_distribution": -0.35,
        "weakening_risk": -0.45,
        "lagging_base_building": -0.25,
        "lagging_risk": -0.75,
        "insufficient_rotation_evidence": 0.0,
    }[regime]
    strength = _clip((rs_ratio - 100.0) / 8.0, -0.25, 0.25)
    momentum = _clip(rs_momentum / 8.0, -0.20, 0.20)
    vector = _clip((delta_rs + delta_momentum) / 10.0, -0.15, 0.15)
    persistence = _clip((quadrant_age - 1) * 0.03, 0.0, 0.12)
    return round(_clip(base + strength + momentum + vector + persistence, -1.0, 1.0), 6)


def build_rotation_model(
    point: RrgPoint,
    history: list[RrgHistoryPoint],
    *,
    as_of_date: str,
    tail_window: int = 20,
    hysteresis_days: int = 2,
) -> RrgPoint:
    """Attach a full rotation model to a current RRG point.

    The quadrant is only the current location. Rotation features describe the
    tail: transition path, persistence, velocity, acceleration, and a bounded
    score for allocator/debate/risk sizing.
    """
    if point.rs_ratio is None or point.rs_momentum is None or point.quadrant is None:
        point.rotation_regime = "insufficient_rotation_evidence"
        point.rotation_hysteresis = "insufficient"
        point.rotation_window = 0
        point.rrg_tail = []
        return point

    tail: list[RrgHistoryPoint] = []
    for item in sorted(history, key=lambda row: row.date):
        rs = _finite_float(item.rs_ratio)
        mom = _finite_float(item.rs_momentum)
        if not item.date or rs is None or mom is None or item.quadrant is None:
            continue
        tail.append(RrgHistoryPoint(item.date, rs, mom, item.quadrant))

    tail = tail[-max(0, tail_window - 1):]
    current = RrgHistoryPoint(as_of_date, point.rs_ratio, point.rs_momentum, point.quadrant)
    full_tail = [*tail, current]
    point.rotation_window = len(full_tail)
    point.rrg_tail = [
        {
            "date": item.date,
            "rs_ratio": _round(item.rs_ratio, 4),
            "rs_momentum": _round(item.rs_momentum, 4),
            "quadrant": item.quadrant,
        }
        for item in full_tail
    ]

    previous = full_tail[-2] if len(full_tail) >= 2 else None
    prev_previous = full_tail[-3] if len(full_tail) >= 3 else None
    delta_rs = (current.rs_ratio or 0.0) - (previous.rs_ratio or current.rs_ratio or 0.0) if previous else 0.0
    delta_mom = (current.rs_momentum or 0.0) - (previous.rs_momentum or current.rs_momentum or 0.0) if previous else 0.0
    velocity = math.sqrt(delta_rs * delta_rs + delta_mom * delta_mom)
    prev_velocity = 0.0
    if previous and prev_previous:
        prev_delta_rs = (previous.rs_ratio or 0.0) - (prev_previous.rs_ratio or previous.rs_ratio or 0.0)
        prev_delta_mom = (previous.rs_momentum or 0.0) - (prev_previous.rs_momentum or previous.rs_momentum or 0.0)
        prev_velocity = math.sqrt(prev_delta_rs * prev_delta_rs + prev_delta_mom * prev_delta_mom)

    age = 0
    for item in reversed(full_tail):
        if item.quadrant != current.quadrant:
            break
        age += 1
    regime = _rotation_regime(
        current=current.quadrant,
        previous=previous.quadrant if previous else None,
        quadrant_age=age,
        rs_ratio=current.rs_ratio or 100.0,
        rs_momentum=current.rs_momentum or 0.0,
        delta_rs=delta_rs,
        delta_momentum=delta_mom,
    )

    point.rotation_velocity = _round(velocity)
    point.rotation_acceleration = _round(velocity - prev_velocity)
    point.quadrant_age = age
    point.transition_path = _dedup_quadrant_path([item.quadrant for item in full_tail if item.quadrant])
    point.rotation_regime = regime
    point.rotation_hysteresis = (
        "confirmed"
        if age >= max(1, hysteresis_days)
        else "transition_pending"
        if previous and previous.quadrant != current.quadrant
        else "developing"
    )
    point.rotation_score = _rotation_score(
        regime=regime,
        rs_ratio=current.rs_ratio or 100.0,
        rs_momentum=current.rs_momentum or 0.0,
        delta_rs=delta_rs,
        delta_momentum=delta_mom,
        quadrant_age=age,
    )
    return point


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
