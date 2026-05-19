"""
intraday.py — Intraday ML Re-score endpoint (Sprint 5.2+ instance utilization)

Called by Worker at 10:00 and 12:00 TW to re-evaluate held positions using a
confidence-decay model. This doesn't re-run the full ML ensemble (Modal) —
instead it reads the latest D1 predictions and adjusts confidence based on
intraday price action vs predicted direction.

Logic:
  1. For each held position, read latest ensemble prediction from D1
  2. Compare prediction direction with actual price movement since entry
  3. If price moved significantly against prediction → decay confidence
  4. Return per-position action: HOLD / WARN / EXIT

Day-trade compliance (handled by Worker, not here):
  - Positions with entry_date = today: Worker will NOT auto-exit (白名單限制)
  - Positions with entry_date < today: Worker may auto-exit if adjusted_conf < threshold
  See memory/project_instance_scaling_brainstorm.md Part A for full audit.

KV thresholds (all in trading:config.intraday):
  - rescoreExitThreshold:     confidence below this → recommend EXIT (default 0.40)
  - rescoreWarnThreshold:     confidence below this → recommend WARN (default 0.55)
  - rescoreDecaySensitivity:  how fast confidence decays per % adverse move (default 5.0)
  - rescoreCooldownMin:       minutes between re-score triggers per symbol (default 60)
  - maxRescoreExitsPerDay:    max auto-exits from re-score per day (default 2)
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel

from services.d1_client import query as d1_query

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/intraday", tags=["intraday"])


class WarnHistory(BaseModel):
    today: Optional[dict] = None         # {count, first_conf, last_conf, last_at}
    prev_day: Optional[dict] = None      # same shape
    consecutive_warns: int = 0


class PositionInput(BaseModel):
    symbol: str
    shares: int
    entry_price: float
    entry_date: str             # YYYY-MM-DD
    current_price: float        # real-time from Shioaji, passed by Worker
    ml_confidence: Optional[float] = None  # original confidence at entry (optional)
    warn_history: Optional[WarnHistory] = None  # from Worker KV, if previously WARN'd


class RescoreRequest(BaseModel):
    positions: list[PositionInput]
    today: Optional[str] = None  # YYYY-MM-DD, defaults to TW today


class PositionResult(BaseModel):
    symbol: str
    original_confidence: float
    adjusted_confidence: float
    price_change_pct: float     # % change since entry
    prediction_direction: str   # 'up' / 'down' / 'hold' / 'unknown'
    action: str                 # 'HOLD' / 'WARN' / 'EXIT'
    reason: str
    is_same_day: bool           # True if entry_date == today


# ── KV defaults ──────────────────────────────────────────────────────────────

_INTRADAY_DEFAULTS = {
    "rescoreExitThreshold": 0.40,
    "rescoreWarnThreshold": 0.55,
    "rescoreDecaySensitivity": 5.0,
    "rescoreCooldownMin": 60,
    "maxRescoreExitsPerDay": 2,
}


def _get_intraday_config() -> dict:
    """Read trading:config.intraday with defaults."""
    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    tc = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[intraday] trading:config degraded: %s", cfg_result.contract.to_dict())
    intraday = tc.get("intraday", {})
    return {k: intraday.get(k, v) for k, v in _INTRADAY_DEFAULTS.items()}


# ── Main endpoint ────────────────────────────────────────────────────────────

@router.post("/rescore")
def rescore_positions(req: RescoreRequest = Body(...)):
    """
    Intraday re-score held positions using confidence-decay model.

    For each position:
    1. Read latest ensemble prediction from D1
    2. Compare price action with predicted direction
    3. If price moved against prediction → decay confidence
    4. Return action recommendation
    """
    if not req.positions:
        return {"results": [], "config": _get_intraday_config()}

    cfg = _get_intraday_config()
    exit_th = cfg["rescoreExitThreshold"]
    warn_th = cfg["rescoreWarnThreshold"]
    decay_sens = cfg["rescoreDecaySensitivity"]

    tw_today = req.today
    if not tw_today:
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        tw_today = tw_now.date().isoformat()

    symbols = [p.symbol for p in req.positions]

    # Batch-read latest ensemble predictions from D1
    predictions_map: dict[str, dict] = {}
    if symbols:
        # D1 REST API has placeholder limit ~100, batch if needed
        for sym in symbols:
            rows = d1_query("""
                SELECT p.direction_accuracy, p.trade_signal, p.signal_raw,
                       p.entry_price as pred_entry, p.stop_loss as pred_stop,
                       p.target1 as pred_t1, p.generated_at
                FROM predictions p
                JOIN stocks s ON s.id = p.stock_id
                WHERE s.symbol = ? AND p.model_name = 'ensemble'
                ORDER BY p.generated_at DESC LIMIT 1
            """, [sym])
            if rows:
                predictions_map[sym] = rows[0]

    results: list[dict] = []

    for pos in req.positions:
        is_same_day = pos.entry_date == tw_today
        pred = predictions_map.get(pos.symbol)

        # Get original confidence
        orig_conf = pos.ml_confidence
        if orig_conf is None and pred:
            orig_conf = float(pred.get("direction_accuracy") or 0.5)
        if orig_conf is None:
            orig_conf = 0.5

        # Determine prediction direction
        pred_direction = "unknown"
        if pred:
            signal = (pred.get("signal_raw") or pred.get("trade_signal") or "").lower()
            if "buy" in signal or "strong" in signal:
                pred_direction = "up"
            elif "sell" in signal:
                pred_direction = "down"
            else:
                pred_direction = "hold"

        # Price change since entry
        price_change_pct = 0.0
        if pos.entry_price > 0:
            price_change_pct = (pos.current_price - pos.entry_price) / pos.entry_price

        # Confidence decay model:
        # If price moved against predicted direction → decay
        # If price moved with predicted direction → slight boost (cap at original)
        direction_mult = 1.0 if pred_direction == "up" else (-1.0 if pred_direction == "down" else 0.0)
        aligned_return = price_change_pct * direction_mult  # positive = price moved with prediction

        adjusted_conf = orig_conf
        reason_parts = []

        if aligned_return < 0:
            # Price moved against prediction
            adverse_pct = abs(aligned_return)
            decay_factor = max(0.2, 1.0 - adverse_pct * decay_sens)
            adjusted_conf = orig_conf * decay_factor
            reason_parts.append(
                f"price {'down' if price_change_pct < 0 else 'up'} {abs(price_change_pct)*100:.1f}% "
                f"vs prediction {pred_direction} -> conf decay {decay_factor:.2f}"
            )
        elif aligned_return > 0.02:
            # Price moved with prediction >2% → slight confidence boost (max 5%)
            boost = min(0.05, aligned_return * 0.5)
            adjusted_conf = min(1.0, orig_conf + boost)
            reason_parts.append(
                f"price aligned +{aligned_return*100:.1f}% with prediction -> conf +{boost:.2f}"
            )
        else:
            reason_parts.append("price near entry, no adjustment")

        # Warn history escalation: if previously WARN'd, use stricter thresholds
        # This ensures "Day 1 WARN → Day 2 easier to EXIT" behavior
        eff_exit_th = exit_th
        eff_warn_th = warn_th
        has_warn_history = False
        if pos.warn_history and pos.warn_history.consecutive_warns > 0:
            has_warn_history = True
            n_warns = pos.warn_history.consecutive_warns
            # Each prior WARN raises thresholds by 0.05 (max +0.15)
            escalation = min(0.15, n_warns * 0.05)
            eff_exit_th = exit_th + escalation
            eff_warn_th = warn_th + escalation
            reason_parts.append(
                f"warn_history: {n_warns} prior warns -> thresholds +{escalation:.2f} "
                f"(exit {eff_exit_th:.2f}, warn {eff_warn_th:.2f})"
            )

        # Determine action
        if adjusted_conf < eff_exit_th:
            action = "EXIT"
            reason_parts.append(f"adjusted_conf {adjusted_conf:.3f} < exit_threshold {eff_exit_th}")
        elif adjusted_conf < eff_warn_th:
            action = "WARN"
            reason_parts.append(f"adjusted_conf {adjusted_conf:.3f} < warn_threshold {eff_warn_th}")
        else:
            action = "HOLD"

        # Day-trade override: same-day positions can only WARN, not EXIT
        if is_same_day and action == "EXIT":
            action = "WARN"
            reason_parts.append("same-day position: EXIT downgraded to WARN (day-trade rule)")

        results.append(PositionResult(
            symbol=pos.symbol,
            original_confidence=round(orig_conf, 4),
            adjusted_confidence=round(adjusted_conf, 4),
            price_change_pct=round(price_change_pct, 4),
            prediction_direction=pred_direction,
            action=action,
            reason=" | ".join(reason_parts),
            is_same_day=is_same_day,
        ).model_dump())

    exit_count = sum(1 for r in results if r["action"] == "EXIT")
    warn_count = sum(1 for r in results if r["action"] == "WARN")

    logger.info(
        f"[Intraday/rescore] {len(results)} positions: "
        f"{exit_count} EXIT, {warn_count} WARN, {len(results)-exit_count-warn_count} HOLD"
    )

    return {
        "results": results,
        "config": cfg,
        "today": tw_today,
        "summary": {
            "total": len(results),
            "exit": exit_count,
            "warn": warn_count,
            "hold": len(results) - exit_count - warn_count,
        },
    }
