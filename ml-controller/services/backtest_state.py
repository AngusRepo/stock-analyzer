"""
backtest_state.py — Mode B per-date market state preloader + rolling metrics
2026-04-20 #28 Phase 1 (see task_plan.md Item #28 B-route)

Design citations:
  D1 (accuracy source): Harvey et al. (2015) "Backtesting" JPM — 真實 verified
       predictions 優於 self-generated（避免 reflexivity bias in Optuna loop）
  D2 (window lengths): Harvey & Liu 2015 + Pedersen 2015 — 30d accuracy 是
       noise/stale 平衡點，5d loss streak 避免 over-correction (Thorp 2006 Kelly)
  D6 (load-once pattern): Vectorbt / backtrader canonical — 一次 pull 整段 period
       進 dict-by-date，replay loop 走 O(1) lookup 避免 N+1 D1 round-trips

紀律：
  M14：dict_by_date lookup 是 hashable key，O(1) 且 deterministic（不需 sort）
       但任何 iteration 都要用 sorted(keys) 保確定性
  M11：rolling counter 邊界（window 長度、tail 長度）必須明確；不用 reset pattern
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional, Iterable, Any

from services.d1_client import query as d1_query

logger = logging.getLogger(__name__)

# ═════════════════════════════════════════════════════════════════════════════
# Row dataclasses — type-safe views of D1 tables
# ═════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class MarketRiskRow:
    """market_risk table row (per date)."""
    date: str
    risk_level: Optional[str]           # green|yellow|orange|red|black
    risk_score: Optional[int]           # 0-100
    vix: Optional[float]
    foreign_consecutive_sell: Optional[int]
    twii_vol20: Optional[float]
    bull_alignment_pct: Optional[float]  # duplicated in market_breadth; market_risk is canonical


@dataclass(frozen=True)
class MarketBreadthRow:
    """market_breadth table row."""
    date: str
    bull_alignment_pct: Optional[float]
    advance_ratio: Optional[float]
    new_high_count: Optional[int]
    new_low_count: Optional[int]


@dataclass(frozen=True)
class USMarketRow:
    """us_market_signals table row — overnight proxy via gspc_return."""
    date: str
    gspc_return: Optional[float]   # S&P 500 close-to-close %
    sox_return: Optional[float]    # 費半 %
    sentiment: Optional[str]       # 'bullish' | 'neutral' | 'bearish'


# ═════════════════════════════════════════════════════════════════════════════
# BacktestMarketState — load-once preloader (D6 citation)
# ═════════════════════════════════════════════════════════════════════════════


class BacktestMarketState:
    """Preload market state tables for [start_date, end_date] into per-date dicts.

    Reads per `replay_period()` start — one-shot D1 call per table.
    Mode B loop then calls `get_risk(date)` etc. in O(1).

    Missing rows return None — caller decides fallback (usually pass-through
    neutral defaults so Mode B can still make a decision on sparse dates).
    """

    def __init__(self, start_date: str, end_date: str):
        self.start_date = start_date
        self.end_date = end_date

        self._risk: dict[str, MarketRiskRow] = self._load_risk(start_date, end_date)
        self._breadth: dict[str, MarketBreadthRow] = self._load_breadth(start_date, end_date)
        self._us: dict[str, USMarketRow] = self._load_us(start_date, end_date)

        logger.info(
            f"[BacktestMarketState] preloaded {start_date}~{end_date}: "
            f"risk={len(self._risk)} breadth={len(self._breadth)} us={len(self._us)}"
        )

    @staticmethod
    def _load_risk(start: str, end: str) -> dict[str, MarketRiskRow]:
        rows = d1_query(
            "SELECT date, risk_level, risk_score, vix, foreign_consecutive_sell, "
            "       twii_vol20, bull_alignment_pct "
            "FROM market_risk WHERE date BETWEEN ? AND ? ORDER BY date",
            [start, end],
        )
        return {
            r["date"]: MarketRiskRow(
                date=r["date"],
                risk_level=r.get("risk_level"),
                risk_score=r.get("risk_score"),
                vix=r.get("vix"),
                foreign_consecutive_sell=r.get("foreign_consecutive_sell"),
                twii_vol20=r.get("twii_vol20"),
                bull_alignment_pct=r.get("bull_alignment_pct"),
            )
            for r in rows
        }

    @staticmethod
    def _load_breadth(start: str, end: str) -> dict[str, MarketBreadthRow]:
        rows = d1_query(
            "SELECT date, bull_alignment_pct, advance_ratio, new_high_count, new_low_count "
            "FROM market_breadth WHERE date BETWEEN ? AND ? ORDER BY date",
            [start, end],
        )
        return {
            r["date"]: MarketBreadthRow(
                date=r["date"],
                bull_alignment_pct=r.get("bull_alignment_pct"),
                advance_ratio=r.get("advance_ratio"),
                new_high_count=r.get("new_high_count"),
                new_low_count=r.get("new_low_count"),
            )
            for r in rows
        }

    @staticmethod
    def _load_us(start: str, end: str) -> dict[str, USMarketRow]:
        rows = d1_query(
            "SELECT date, gspc_return, sox_return, sentiment "
            "FROM us_market_signals WHERE date BETWEEN ? AND ? ORDER BY date",
            [start, end],
        )
        return {
            r["date"]: USMarketRow(
                date=r["date"],
                gspc_return=r.get("gspc_return"),
                sox_return=r.get("sox_return"),
                sentiment=r.get("sentiment"),
            )
            for r in rows
        }

    # O(1) lookups — None if date missing (weekend / data gap)
    def get_risk(self, date: str) -> Optional[MarketRiskRow]:
        return self._risk.get(date)

    def get_breadth(self, date: str) -> Optional[MarketBreadthRow]:
        return self._breadth.get(date)

    def get_us(self, date: str) -> Optional[USMarketRow]:
        return self._us.get(date)

    def dates_with_risk(self) -> list[str]:
        """Deterministic sorted dates — for tests / debugging (M14 discipline)."""
        return sorted(self._risk.keys())


# ═════════════════════════════════════════════════════════════════════════════
# Predictions-based rolling accuracy (D1 citation: Harvey 2015)
# ═════════════════════════════════════════════════════════════════════════════


def load_verified_predictions(start_date: str, end_date: str) -> list[dict]:
    """Pull predictions.direction_correct rows (NULL filtered) for the replay period.

    One-shot D1 call (D6 pattern). Returns rows sorted by generated_at ASC so
    `compute_rolling_accuracy_30d` can slice by tail without re-sorting.

    NULL `direction_correct` rows (未驗證) are excluded — accuracy only counts
    already-resolved predictions.
    """
    rows = d1_query(
        "SELECT generated_at, direction_correct "
        "FROM predictions "
        "WHERE generated_at BETWEEN ? AND ? "
        "  AND direction_correct IS NOT NULL "
        "ORDER BY generated_at ASC",
        [start_date, end_date],
    )
    return rows


def compute_rolling_accuracy_30d(
    verified_preds: list[dict],
    as_of: str,
    window_days: int = 30,
    min_samples: int = 10,
    fallback: float = 0.6,
) -> float:
    """Rolling verified direction-accuracy over last `window_days` trading days.

    Returns a float in [0, 1]. When fewer than `min_samples` verified predictions
    are in the window, returns `fallback` (0.6 matches adaptive.py pre-existing
    hardcode default — expressly kept consistent with production runtime).

    M11 discipline: this is a filter + count, NOT a reset-style counter.
    Window is half-open `(as_of - window_days, as_of]` so the replay day itself
    is included once it's verified (normally arrives next day in production).
    """
    if not verified_preds:
        return fallback

    cutoff = (datetime.fromisoformat(as_of) - timedelta(days=window_days)).isoformat()
    # Rows sorted by generated_at ASC — use rightmost slice
    window_rows = [r for r in verified_preds if cutoff < r["generated_at"] <= as_of + "T23:59:59"]

    if len(window_rows) < min_samples:
        return fallback

    correct = sum(1 for r in window_rows if int(r.get("direction_correct") or 0) == 1)
    return round(correct / len(window_rows), 4)


# ═════════════════════════════════════════════════════════════════════════════
# Trades-based rolling metrics (D2 citation: Pedersen + Thorp)
# ═════════════════════════════════════════════════════════════════════════════


def compute_loss_streak_5d(
    trades: Iterable[Any],
    as_of: str,
    window_days: int = 5,
) -> tuple[int, int]:
    """Return (losses, total) for trades exited within the last `window_days`.

    Window semantic `[cutoff, as_of)`:
      - `cutoff = as_of - window_days` (inclusive)
      - `as_of` excluded — represents today's decision point; trades opening
        today haven't exited yet, so they don't count in today's loss streak.

    Consumes iterable of Trade dataclass instances (backtest_engine.Trade).
    Uses `trade.exit_date` for temporal filter; `trade.profit_ratio < 0`
    as loss indicator (net of fees, matches paper.ts convention).

    Returns (0, 0) when no trades in window — caller maps to neutral bandit mult.

    M11: window is a filter with clear bounds, NOT a reset-style counter.
    """
    cutoff = (datetime.fromisoformat(as_of) - timedelta(days=window_days)).strftime("%Y-%m-%d")
    losses = 0
    total = 0
    for t in trades:
        exit_date = getattr(t, "exit_date", None)
        if exit_date is None or exit_date < cutoff or exit_date >= as_of:
            continue
        total += 1
        if getattr(t, "profit_ratio", 0.0) < 0:
            losses += 1
    return losses, total


def compute_profit_factor(
    trades: Iterable[Any],
    as_of: str,
    window_days: int = 30,
    min_trades: int = 5,
    fallback: float = 1.0,
) -> float:
    """Profit Factor = sum(wins) / |sum(losses)| over rolling window.

    Standard quant convention (reference: Dr. Ernest Chan "Quantitative Trading").
    Returns `fallback` when fewer than `min_trades` are in window to avoid
    noise-driven amplification (matches adaptive.py 1.0 neutral default).

    When losses = 0 but wins > 0, returns a capped value (5.0) since infinite
    PF causes numerical instability downstream. Clipping at replay time is
    preferred over infinity — adaptive.py `pf_quality_clip_hi` (1.8) further
    clips at consumption site.
    """
    # Same `[cutoff, as_of)` semantic as loss_streak — trades still open today
    # haven't contributed PnL yet, so today is excluded from rolling PF.
    cutoff = (datetime.fromisoformat(as_of) - timedelta(days=window_days)).strftime("%Y-%m-%d")
    wins_sum = 0.0
    losses_sum = 0.0
    count = 0
    for t in trades:
        exit_date = getattr(t, "exit_date", None)
        if exit_date is None or exit_date < cutoff or exit_date >= as_of:
            continue
        count += 1
        pnl = float(getattr(t, "profit_amount", 0.0))
        if pnl >= 0:
            wins_sum += pnl
        else:
            losses_sum += abs(pnl)

    if count < min_trades:
        return fallback
    if losses_sum <= 1e-9:
        return 5.0 if wins_sum > 0 else fallback
    return round(wins_sum / losses_sum, 4)


# ═════════════════════════════════════════════════════════════════════════════
# Equity-curve-based rolling drawdown (Sterling Ratio convention)
# ═════════════════════════════════════════════════════════════════════════════


def compute_drawdown_30d(
    equity_curve: list[tuple[str, float]],
    as_of: str,
    window_days: int = 30,
) -> float:
    """Rolling max drawdown over last `window_days`.

    Drawdown = (rolling_max - current_equity) / rolling_max in [0, 1].
    Convention: Sterling Ratio / MAR Ratio — rolling window max (not ATH)
    so a single outlier spike doesn't pin DD forever.

    Uses the last equity point <= as_of as "current" (intra-day state not tracked
    here; Mode B replay is EOD-granular). Returns 0.0 when curve is empty or
    current equity exceeds all prior values in window.

    M11: single pass filter + max, no counter reset.
    """
    if not equity_curve:
        return 0.0

    cutoff = (datetime.fromisoformat(as_of) - timedelta(days=window_days)).strftime("%Y-%m-%d")
    window = [(d, v) for (d, v) in equity_curve if cutoff < d <= as_of]
    if not window:
        return 0.0

    rolling_max = max(v for (_, v) in window)
    current = window[-1][1]  # equity_curve is chronologically ordered
    if rolling_max <= 0:
        return 0.0
    dd = (rolling_max - current) / rolling_max
    return round(max(0.0, dd), 4)


# ═════════════════════════════════════════════════════════════════════════════
# Night-drop helpers (P5 prep — us_market_signals.gspc_return convention)
# ═════════════════════════════════════════════════════════════════════════════


def get_prev_night_drop(
    state: BacktestMarketState,
    as_of: str,
    lookback_days: int = 3,
) -> Optional[float]:
    """Return the most recent US-leading close-to-close return within N days before as_of.

    Standard convention for TW open overnight adjustment: look at S&P 500 daily
    return (close-to-close) because true overnight gap needs futures tape not
    available in D1. Paper.ts uses this same proxy (see worker/src/index.ts
    us_leading consumer). None when no US data in lookback window.

    Search walks back day-by-day (max `lookback_days`) so weekend/holiday gaps
    fall through gracefully.
    """
    try:
        as_of_dt = datetime.fromisoformat(as_of)
    except ValueError:
        return None

    for offset in range(1, lookback_days + 1):
        probe_date = (as_of_dt - timedelta(days=offset)).strftime("%Y-%m-%d")
        row = state.get_us(probe_date)
        if row and row.gspc_return is not None:
            return float(row.gspc_return)
    return None
