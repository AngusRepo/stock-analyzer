"""
_trade_simulator.py — pure function port of worker simulateTrade

1:1 port of worker/src/lib/predictionVerifier.ts:210-295
Must match Worker output exactly. Any divergence breaks parity test.

Used by verify_service.py during prediction verification.
"""
from ._predictions_schema import TradeSimulationResult, Direction, Bar


def simulate_trade(
    direction: Direction,
    entry: float,
    stop: float,
    target1: float,
    target2: float,
    bars: list[dict],   # list of bars with .high/.low/.close (dict or Bar)
) -> TradeSimulationResult:
    """
    Simulate a trade by stepping bar-by-bar through OHLC data.

    Mirrors worker simulateTrade exactly:
    - hit_target2 — full TP
    - hit_target1 — partial TP, stop loss disabled after this point
    - hit_stop — stop loss before target1
    - expired — bars exhausted, exit at last close
    """
    is_long = direction == "up"
    risk_per_share = abs(entry - stop)  # 1R

    max_favorable = 0.0
    max_adverse = 0.0
    outcome = "expired"
    exit_price = (bars[-1].get("close") if bars else None) or entry
    hit_target1 = False

    for bar in bars:
        high = bar.get("high") if bar.get("high") is not None else bar.get("close")
        low = bar.get("low") if bar.get("low") is not None else bar.get("close")
        if high is None or low is None:
            continue

        if is_long:
            favorable = (high - entry) / entry
            adverse = (entry - low) / entry
            if favorable > max_favorable:
                max_favorable = favorable
            if adverse > max_adverse:
                max_adverse = adverse

            if high >= target2:
                outcome = "hit_target2"
                exit_price = target2
                break
            if high >= target1:
                outcome = "hit_target1"
                exit_price = target1
                hit_target1 = True
                # don't break — keep looking for target2

            if not hit_target1 and low <= stop:
                outcome = "hit_stop"
                exit_price = stop
                break
        else:
            # short side
            favorable = (entry - low) / entry
            adverse = (high - entry) / entry
            if favorable > max_favorable:
                max_favorable = favorable
            if adverse > max_adverse:
                max_adverse = adverse

            if low <= target2:
                outcome = "hit_target2"
                exit_price = target2
                break
            if low <= target1:
                outcome = "hit_target1"
                exit_price = target1
                hit_target1 = True

            if not hit_target1 and high >= stop:
                outcome = "hit_stop"
                exit_price = stop
                break

    # PnL
    raw_pnl = (
        (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
    )
    trade_pnl_r = (raw_pnl * entry / risk_per_share) if risk_per_share > 0 else 0.0

    return TradeSimulationResult(
        outcome=outcome,                                     # type: ignore[arg-type]
        trade_pnl_pct=round(raw_pnl * 10000) / 10000,
        trade_pnl_r=round(trade_pnl_r * 100) / 100,
        max_favorable=round(max_favorable * 10000) / 10000,
        max_adverse=round(max_adverse * 10000) / 10000,
    )
