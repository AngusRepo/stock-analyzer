"""
verify_service.py — prediction verification + trade simulation (Python port)

1:1 port of worker/src/lib/predictionVerifier.ts for the V2 LangGraph pipeline.
Reads pending predictions from D1, simulates trades against actual OHLC bars,
updates predictions + model_accuracy + trade_performance.

Does NOT port updateStockMemories (cosmetic — LLM can read D1 directly).

Usage (as LangGraph node):
    from services.verify_service import run_verify_pipeline
    result = run_verify_pipeline()  # returns dict with counts
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from . import d1_client
from ._predictions_schema import (
    UPDATE_VERIFY_SQL,
    TradeSimulationResult,
)
from ._trade_simulator import simulate_trade

logger = logging.getLogger(__name__)

VERIFIABLE_MARKETS = {"TWSE", "OTC", "TPEX", "EMERGING"}


def _finite_price(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


# ═══════════════════════════════════════════════════════════════════════════════
# Main entry point
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_run_date(run_date: str | None = None) -> date:
    if run_date:
        return datetime.fromisoformat(run_date).date()
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


def _resolve_verification_prediction_window(
    as_of: date,
    lookback_days: int,
    stale_grace_days: int,
) -> tuple[str, str]:
    """
    Resolve the mature prediction window from actual price dates.

    `lookback_days` used to be applied as calendar days. That misses predictions
    around holidays/weekends (for example 2026-04-30 -> 2026-05-04 after the
    5/1 Taiwan holiday). The verification contract should follow completed
    trading sessions, so the newest verifiable prediction date is the trading
    day immediately before the latest available price date.
    """
    latest_rows = d1_client.query(
        "SELECT MAX(date) AS latest_date FROM stock_prices WHERE date <= ?",
        params=[as_of.isoformat()],
    )
    latest_price_date = latest_rows[0].get("latest_date") if latest_rows else None
    if latest_price_date:
        prev_rows = d1_client.query(
            "SELECT MAX(date) AS previous_date FROM stock_prices WHERE date < ?",
            params=[latest_price_date],
        )
        previous_price_date = prev_rows[0].get("previous_date") if prev_rows else None
        if previous_price_date:
            max_prediction_date = str(previous_price_date)
            min_prediction_date = (
                datetime.fromisoformat(max_prediction_date).date() - timedelta(days=stale_grace_days)
            ).isoformat()
            return min_prediction_date, max_prediction_date

    max_prediction_date = (as_of - timedelta(days=lookback_days)).isoformat()
    min_prediction_date = (as_of - timedelta(days=lookback_days + stale_grace_days)).isoformat()
    return min_prediction_date, max_prediction_date


def load_pending_predictions(
    lookback_days: int = 5,
    limit: int = 200,
    run_date: str | None = None,
    stale_grace_days: int = 10,
) -> list[dict]:
    """
    Load predictions that need verification.

    Load only the verifiable window for this run.

    The old query used `prediction_date <= today-lookback` with no lower bound,
    so stale unverified rows permanently sat at the front of the queue and every
    nightly verify spent money re-reading old backlog. The V2 contract now uses
    completed price sessions to avoid calendar-day gaps around holidays/weekends.
    """
    as_of = _parse_run_date(run_date)
    min_prediction_date, max_prediction_date = _resolve_verification_prediction_window(
        as_of,
        lookback_days,
        stale_grace_days,
    )
    sql = """
        SELECT p.*, s.symbol, s.market
        FROM predictions p
        JOIN stocks s ON p.stock_id = s.id
        WHERE (p.direction_correct IS NULL OR p.actual_return_pct IS NULL)
          AND p.prediction_date BETWEEN ? AND ?
          AND s.market IN ('TWSE', 'OTC', 'TPEX', 'EMERGING')
          AND p.forecast_data IS NOT NULL
        ORDER BY p.prediction_date DESC, p.generated_at ASC
        LIMIT ?
    """
    rows = d1_client.query(sql, params=[min_prediction_date, max_prediction_date, limit])
    logger.info(f"[verify] Loaded {len(rows)} pending predictions")
    return rows


def load_market_risk() -> dict:
    """Latest market_risk row for risk_level/risk_score stamping on verified predictions."""
    rows = d1_client.query(
        "SELECT risk_level, risk_score FROM market_risk ORDER BY date DESC LIMIT 1"
    )
    return rows[0] if rows else {}


def load_bars_for_prediction(stock_id: int, generated_at: str, prediction_date: str | None = None) -> list[dict]:
    """
    Load 7 days of OHLC bars starting from day after generated_at.

    Matches worker predictionVerifier.ts:81-90 exactly.
    """
    if prediction_date:
        business_date = datetime.fromisoformat(prediction_date).date()
    else:
        business_date = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).date()
    look_from = (business_date + timedelta(days=1)).isoformat()
    look_to = (business_date + timedelta(days=10)).isoformat()

    sql = """
        SELECT date, open, high, low, close
        FROM stock_prices
        WHERE stock_id=? AND date >= ? AND date <= ?
        ORDER BY date ASC LIMIT 7
    """
    return d1_client.query(sql, params=[stock_id, look_from, look_to])


def load_bars_for_predictions(predictions: list[dict], chunk_size: int = 80) -> dict[int, list[dict]]:
    """Load OHLC bars for all pending predictions in a few D1 reads."""
    if not predictions:
        return {}

    windows: list[tuple[int, str, str]] = []
    for pred in predictions:
        if pred.get("prediction_date"):
            business_date = datetime.fromisoformat(str(pred["prediction_date"])).date()
        else:
            business_date = datetime.fromisoformat(str(pred["generated_at"]).replace("Z", "+00:00")).date()
        windows.append((
            int(pred["stock_id"]),
            (business_date + timedelta(days=1)).isoformat(),
            (business_date + timedelta(days=10)).isoformat(),
        ))

    stock_ids = sorted({w[0] for w in windows})
    min_date = min(w[1] for w in windows)
    max_date = max(w[2] for w in windows)
    bars_by_stock: dict[int, list[dict]] = {}

    for i in range(0, len(stock_ids), chunk_size):
        chunk = stock_ids[i:i + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = d1_client.query(
            f"""
            SELECT stock_id, date, open, high, low, close
            FROM stock_prices
            WHERE stock_id IN ({placeholders})
              AND date >= ?
              AND date <= ?
            ORDER BY stock_id ASC, date ASC
            """,
            params=[*chunk, min_date, max_date],
        )
        for row in rows:
            bars_by_stock.setdefault(int(row["stock_id"]), []).append(row)

    return bars_by_stock


def _prediction_bar_window(pred: dict) -> tuple[str, str]:
    if pred.get("prediction_date"):
        business_date = datetime.fromisoformat(str(pred["prediction_date"])).date()
    else:
        business_date = datetime.fromisoformat(str(pred["generated_at"]).replace("Z", "+00:00")).date()
    return (
        (business_date + timedelta(days=1)).isoformat(),
        (business_date + timedelta(days=10)).isoformat(),
    )


def verify_single_prediction(
    pred: dict,
    market_risk: dict,
    bars_override: list[dict] | None = None,
) -> dict | None:
    """
    Verify a single prediction: parse forecast_data, load bars, simulate trade.

    Returns update payload dict, or None if skipped (neutral/no bars/bad data).
    Structure matches the 15-parameter UPDATE_VERIFY_SQL binding order.
    """
    # ── Parse forecast_data ──────────────────────────────────────────────────
    try:
        fd = json.loads(pred.get("forecast_data") or "{}")
    except (ValueError, TypeError):
        return None

    signal = fd.get("signal") or ""
    predicted_direction = (
        "up" if "BUY" in signal
        else "down" if "SELL" in signal
        else "neutral"
    )

    # Neutral — mark as -1 (skipped) and return
    # Predicted price (horizon midpoint, fall back to last)
    forecasts: list = fd.get("forecasts") or []
    predicted_price = None
    if forecasts:
        mid = forecasts[4] if len(forecasts) > 4 else forecasts[-1]
        if isinstance(mid, dict):
            predicted_price = mid.get("forecast")

    # ── Load bars ────────────────────────────────────────────────────────────
    if bars_override is None:
        bars = load_bars_for_prediction(pred["stock_id"], pred["generated_at"], pred.get("prediction_date"))
    else:
        bars = bars_override
    if not bars:
        return None  # data not arrived yet

    # ── Derive entry/stop/targets (fall back to defaults if null) ────────────
    actual_bar = bars[min(4, len(bars) - 1)]
    actual_price = _finite_price(actual_bar.get("close"))
    entry_price = _finite_price(pred.get("entry_price")) or _finite_price(bars[0].get("open")) or actual_price
    if actual_price is None or entry_price is None:
        return None
    is_long = predicted_direction == "up"
    stop_loss = _finite_price(pred.get("stop_loss")) or (entry_price * (0.95 if is_long else 1.05))
    target1 = _finite_price(pred.get("target1")) or (entry_price * (1.05 if is_long else 0.95))
    target2 = _finite_price(pred.get("target2")) or (entry_price * (1.08 if is_long else 0.92))

    actual_return_pct = (actual_price - entry_price) / entry_price

    # Actual direction with noise band (matches worker 1.001/0.999 bands)
    if actual_price > entry_price * 1.001:
        actual_direction = "up"
    elif actual_price < entry_price * 0.999:
        actual_direction = "down"
    else:
        actual_direction = "neutral"
    price_error_pct = None
    if predicted_price is not None:
        price_error_pct = abs((predicted_price - actual_price) / actual_price) * 100

    # Neutral/HOLD rows are not directional trade calls, but weekly IC needs
    # actual_return_pct for every per-model rank_score row.
    if predicted_direction == "neutral":
        return {
            "id": pred["id"],
            "stock_id": pred["stock_id"],
            "model_name": pred.get("model_name"),
            "bind": [
                predicted_direction,
                predicted_price,
                actual_direction,
                actual_price,
                -1,
                price_error_pct,
                market_risk.get("risk_level"),
                market_risk.get("risk_score"),
                actual_return_pct,
                None,
                None,
                None,
                None,
                None,
                pred["id"],
            ],
            "arf": None,
        }

    is_correct = 1 if predicted_direction == actual_direction else 0

    # ── Simulate trade ───────────────────────────────────────────────────────
    sim: TradeSimulationResult = simulate_trade(
        direction=predicted_direction,  # type: ignore[arg-type]
        entry=entry_price,
        stop=stop_loss,
        target1=target1,
        target2=target2,
        bars=bars,
    )

    # ── Build update binding (matches UPDATE_VERIFY_SQL parameter order) ─────
    return {
        "id": pred["id"],
        "stock_id": pred["stock_id"],
        "model_name": pred.get("model_name"),
        "bind": [
            predicted_direction,
            predicted_price,
            actual_direction,
            actual_price,
            is_correct,
            price_error_pct,
            market_risk.get("risk_level"),
            market_risk.get("risk_score"),
            actual_return_pct,
            sim.outcome,
            sim.trade_pnl_pct,
            sim.trade_pnl_r,
            sim.max_favorable,
            sim.max_adverse,
            pred["id"],
        ],
        "arf": {
            "stock_id": pred["stock_id"],
            "symbol": pred.get("symbol"),
            "predicted_direction": predicted_direction,
            "actual_direction": actual_direction,
            "actual_return_pct": actual_return_pct,
            "realized_pnl_r": sim.trade_pnl_r,
            "forecast_pct": fd.get("forecast_pct") or 0.0,
            "arf_features": fd.get("arf_features") or [],
            "prediction_id": pred["id"],
        } if (fd.get("arf_features") and len(fd.get("arf_features") or []) > 0) else None,
    }


def write_verified_predictions(updates: list[dict]) -> int:
    """Batch-update predictions table with verification results."""
    if not updates:
        return 0
    statements = [(UPDATE_VERIFY_SQL, u["bind"]) for u in updates]
    result = d1_client.batch_execute(statements)
    return result.get("changes_total", 0)


def prepare_verification_updates(pending: list[dict], market_risk: dict) -> dict:
    """Simulate pending predictions and return batched D1/ARF update payloads."""
    updates: list[dict] = []
    arf_batch: list[dict] = []
    errors: list[str] = []
    skipped_no_bars = 0
    skipped_no_update = 0
    skipped_incomplete_price_bars = 0
    bars_by_stock = load_bars_for_predictions(pending)

    for pred in pending:
        try:
            look_from, look_to = _prediction_bar_window(pred)
            pred_bars = [
                b for b in bars_by_stock.get(int(pred["stock_id"]), [])
                if look_from <= str(b.get("date")) <= look_to
            ][:7]
            if not pred_bars:
                skipped_no_bars += 1
                continue
            actual_bar = pred_bars[min(4, len(pred_bars) - 1)]
            if _finite_price(actual_bar.get("close")) is None:
                skipped_incomplete_price_bars += 1
                continue
            result = verify_single_prediction(
                pred,
                market_risk,
                bars_override=pred_bars,
            )
            if result is None:
                skipped_no_update += 1
                continue
            updates.append(result)
            if result.get("arf"):
                arf_batch.append(result["arf"])
        except Exception as e:
            msg = f"prediction {pred.get('id')} failed: {e}"
            logger.error(f"[verify] Failed pred {pred.get('id')}: {e}")
            errors.append(msg)

    return {
        "verify_updates": updates,
        "arf_feedback_items": arf_batch,
        "errors": errors,
        "metrics": {
            "skipped_no_bars": skipped_no_bars,
            "skipped_no_update": skipped_no_update,
            "skipped_incomplete_price_bars": skipped_incomplete_price_bars,
        },
    }


def summarize_verification_updates(pending_count: int, updates: list[dict]) -> dict:
    """Build stable summary metrics for verified prediction updates."""
    verified = len(updates)
    correct = sum(1 for u in updates if u["bind"][4] == 1)
    total_pnl = sum(u["bind"][10] or 0 for u in updates)
    return {
        "pending": pending_count,
        "verified": verified,
        "correct": correct,
        "total_pnl_pct": total_pnl,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# model_accuracy update (port of worker updateModelAccuracy + upsertAccuracy)
# ═══════════════════════════════════════════════════════════════════════════════

def update_model_accuracy() -> int:
    """
    Refresh model_accuracy table for all (stock, model) groups with verified preds.

    1:1 port of predictionVerifier.ts:299-418.
    Returns number of (stock_id, model_name) groups updated.
    """
    groups = d1_client.query(
        "SELECT DISTINCT stock_id, model_name FROM predictions "
        "WHERE direction_correct IN (0, 1)"
    )
    now = datetime.now(timezone.utc)
    since_30 = (now - timedelta(days=30)).isoformat()
    since_90 = (now - timedelta(days=90)).isoformat()

    count = 0
    for g in groups:
        _upsert_accuracy(g["stock_id"], g["model_name"], "all", None)
        _upsert_accuracy(g["stock_id"], g["model_name"], "30d", since_30)
        _upsert_accuracy(g["stock_id"], g["model_name"], "90d", since_90)
        count += 1
    logger.info(f"[verify] model_accuracy updated for {count} groups")
    return count


def _upsert_accuracy(
    stock_id: int, model_name: str, period: str, since: str | None
) -> None:
    """Mirrors worker upsertAccuracy (predictionVerifier.ts:315-418)."""
    if since:
        where_base = (
            "stock_id=? AND model_name=? AND direction_correct IN (0,1) "
            "AND generated_at >= ?"
        )
        params: list[Any] = [stock_id, model_name, since]
    else:
        where_base = "stock_id=? AND model_name=? AND direction_correct IN (0,1)"
        params = [stock_id, model_name]

    row = d1_client.query(
        f"SELECT COUNT(*) as total, SUM(direction_correct) as correct, "
        f"AVG(price_error_pct) as avg_err FROM predictions WHERE {where_base}",
        params=params,
    )
    if not row or (row[0].get("total") or 0) < 1:
        return
    r = row[0]

    low_risk = d1_client.query(
        f"SELECT COUNT(*) as total, SUM(direction_correct) as correct "
        f"FROM predictions WHERE {where_base} "
        f"AND market_risk_level IN ('green','yellow')",
        params=params,
    )
    high_risk = d1_client.query(
        f"SELECT COUNT(*) as total, SUM(direction_correct) as correct "
        f"FROM predictions WHERE {where_base} "
        f"AND market_risk_level IN ('red','black')",
        params=params,
    )
    win_rows = d1_client.query(
        f"SELECT AVG(actual_return_pct) as avg_win FROM predictions "
        f"WHERE {where_base} AND direction_correct=1 "
        f"AND actual_return_pct IS NOT NULL",
        params=params,
    )
    loss_rows = d1_client.query(
        f"SELECT AVG(actual_return_pct) as avg_loss FROM predictions "
        f"WHERE {where_base} AND direction_correct=0 "
        f"AND actual_return_pct IS NOT NULL",
        params=params,
    )
    trade_rows = d1_client.query(
        f"SELECT AVG(trade_pnl_pct) as avg_pnl, "
        f"AVG(trade_pnl_r) as avg_r, "
        f"SUM(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct ELSE 0 END) as gross_profit, "
        f"SUM(CASE WHEN trade_pnl_pct < 0 THEN ABS(trade_pnl_pct) ELSE 0 END) as gross_loss, "
        f"SUM(CASE WHEN trade_outcome='hit_target1' OR trade_outcome='hit_target2' "
        f"THEN 1 ELSE 0 END) as hit_target, "
        f"SUM(CASE WHEN trade_outcome='hit_stop' THEN 1 ELSE 0 END) as hit_stop, "
        f"COUNT(CASE WHEN trade_pnl_pct IS NOT NULL THEN 1 END) as trade_count "
        f"FROM predictions WHERE {where_base}",
        params=params,
    )

    total = r["total"] or 0
    correct = r["correct"] or 0
    accuracy = correct / total if total else 0
    lr = low_risk[0] if low_risk else {}
    hr = high_risk[0] if high_risk else {}
    acc_low = (lr.get("correct") / lr.get("total")) if (lr.get("total") or 0) > 0 else None
    acc_high = (hr.get("correct") / hr.get("total")) if (hr.get("total") or 0) > 0 else None
    avg_win = (win_rows[0].get("avg_win") if win_rows else None)
    avg_loss = (loss_rows[0].get("avg_loss") if loss_rows else None)
    tr = trade_rows[0] if trade_rows else {}
    profit_factor = (
        tr.get("gross_profit") / tr.get("gross_loss")
        if (tr.get("gross_loss") or 0) > 0 else None
    )
    win_rate = accuracy
    expectancy = (
        win_rate * avg_win + (1 - win_rate) * avg_loss
        if (avg_win is not None and avg_loss is not None) else None
    )
    tc = tr.get("trade_count") or 0
    hit_target_rate = tr.get("hit_target") / tc if tc > 0 else None
    hit_stop_rate = tr.get("hit_stop") / tc if tc > 0 else None

    d1_client.execute(
        """
        INSERT INTO model_accuracy (
          stock_id, model_name, period,
          total_count, correct_count, accuracy, avg_price_error,
          accuracy_in_low_risk, accuracy_in_high_risk, count_low_risk, count_high_risk,
          avg_win_pct, avg_loss_pct, profit_factor, avg_trade_pnl, avg_trade_pnl_r,
          hit_target_rate, hit_stop_rate, expectancy,
          last_updated
        ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?, datetime('now'))
        ON CONFLICT(stock_id, model_name, period) DO UPDATE SET
          total_count          = excluded.total_count,
          correct_count        = excluded.correct_count,
          accuracy             = excluded.accuracy,
          avg_price_error      = excluded.avg_price_error,
          accuracy_in_low_risk = excluded.accuracy_in_low_risk,
          accuracy_in_high_risk= excluded.accuracy_in_high_risk,
          count_low_risk       = excluded.count_low_risk,
          count_high_risk      = excluded.count_high_risk,
          avg_win_pct          = excluded.avg_win_pct,
          avg_loss_pct         = excluded.avg_loss_pct,
          profit_factor        = excluded.profit_factor,
          avg_trade_pnl        = excluded.avg_trade_pnl,
          avg_trade_pnl_r      = excluded.avg_trade_pnl_r,
          hit_target_rate      = excluded.hit_target_rate,
          hit_stop_rate        = excluded.hit_stop_rate,
          expectancy           = excluded.expectancy,
          last_updated         = datetime('now')
        """,
        params=[
            stock_id, model_name, period,
            total, correct, accuracy, r.get("avg_err"),
            acc_low, acc_high, lr.get("total") or 0, hr.get("total") or 0,
            avg_win, avg_loss, profit_factor,
            tr.get("avg_pnl"), tr.get("avg_r"),
            hit_target_rate, hit_stop_rate, expectancy,
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# trade_performance update (port of worker updateTradePerformance + upsertTradePerf)
# ═══════════════════════════════════════════════════════════════════════════════

def update_trade_performance() -> int:
    """1:1 port of predictionVerifier.ts:422-513."""
    groups = d1_client.query(
        "SELECT DISTINCT stock_id, model_name FROM predictions "
        "WHERE trade_pnl_pct IS NOT NULL"
    )
    now = datetime.now(timezone.utc)
    since_30 = (now - timedelta(days=30)).isoformat()
    since_90 = (now - timedelta(days=90)).isoformat()

    count = 0
    for g in groups:
        _upsert_trade_perf(g["stock_id"], g["model_name"], "all", None)
        _upsert_trade_perf(g["stock_id"], g["model_name"], "30d", since_30)
        _upsert_trade_perf(g["stock_id"], g["model_name"], "90d", since_90)
        count += 1
    logger.info(f"[verify] trade_performance updated for {count} groups")
    return count


def _upsert_trade_perf(
    stock_id: int, model_name: str, period: str, since: str | None
) -> None:
    """Mirrors worker upsertTradePerf (predictionVerifier.ts:438-513)."""
    if since:
        where_base = (
            "stock_id=? AND model_name=? AND trade_pnl_pct IS NOT NULL "
            "AND generated_at >= ?"
        )
        params: list[Any] = [stock_id, model_name, since]
    else:
        where_base = (
            "stock_id=? AND model_name=? AND trade_pnl_pct IS NOT NULL"
        )
        params = [stock_id, model_name]

    rows = d1_client.query(
        f"""
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN trade_pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN trade_pnl_pct < 0 THEN 1 ELSE 0 END) as losses,
          SUM(trade_pnl_pct) as total_pnl,
          AVG(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct END) as avg_win,
          AVG(CASE WHEN trade_pnl_pct < 0 THEN trade_pnl_pct END) as avg_loss,
          MAX(trade_pnl_pct) as max_win,
          MIN(trade_pnl_pct) as max_loss,
          SUM(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct ELSE 0 END) as gross_profit,
          SUM(CASE WHEN trade_pnl_pct < 0 THEN ABS(trade_pnl_pct) ELSE 0 END) as gross_loss,
          AVG(trade_pnl_r) as avg_r,
          SUM(CASE WHEN trade_outcome='hit_target1' THEN 1 ELSE 0 END) as hit_t1,
          SUM(CASE WHEN trade_outcome='hit_target2' THEN 1 ELSE 0 END) as hit_t2,
          SUM(CASE WHEN trade_outcome='hit_stop'    THEN 1 ELSE 0 END) as hit_stop,
          SUM(CASE WHEN trade_outcome='expired'     THEN 1 ELSE 0 END) as expired,
          AVG(max_favorable_pct) as avg_mfe,
          AVG(max_adverse_pct)   as avg_mae
        FROM predictions WHERE {where_base}
        """,
        params=params,
    )
    if not rows or (rows[0].get("total") or 0) < 1:
        return
    r = rows[0]
    total = r["total"]
    wins = r.get("wins") or 0
    gross_loss = r.get("gross_loss") or 0
    profit_factor = (r["gross_profit"] / gross_loss) if gross_loss > 0 else None
    win_rate = wins / total if total else 0
    avg_win = r.get("avg_win")
    avg_loss = r.get("avg_loss")
    expectancy = (
        win_rate * avg_win + (1 - win_rate) * avg_loss
        if (avg_win is not None and avg_loss is not None) else None
    )

    d1_client.execute(
        """
        INSERT INTO trade_performance (
          stock_id, model_name, period,
          total_trades, win_trades, loss_trades, total_pnl_pct,
          avg_win_pct, avg_loss_pct, max_win_pct, max_loss_pct,
          profit_factor, expectancy, avg_pnl_r,
          hit_target1_count, hit_target2_count, hit_stop_count, expired_count,
          avg_mfe, avg_mae, last_updated
        ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,datetime('now'))
        ON CONFLICT(stock_id, model_name, period) DO UPDATE SET
          total_trades      = excluded.total_trades,
          win_trades        = excluded.win_trades,
          loss_trades       = excluded.loss_trades,
          total_pnl_pct     = excluded.total_pnl_pct,
          avg_win_pct       = excluded.avg_win_pct,
          avg_loss_pct      = excluded.avg_loss_pct,
          max_win_pct       = excluded.max_win_pct,
          max_loss_pct      = excluded.max_loss_pct,
          profit_factor     = excluded.profit_factor,
          expectancy        = excluded.expectancy,
          avg_pnl_r         = excluded.avg_pnl_r,
          hit_target1_count = excluded.hit_target1_count,
          hit_target2_count = excluded.hit_target2_count,
          hit_stop_count    = excluded.hit_stop_count,
          expired_count     = excluded.expired_count,
          avg_mfe           = excluded.avg_mfe,
          avg_mae           = excluded.avg_mae,
          last_updated      = datetime('now')
        """,
        params=[
            stock_id, model_name, period,
            total, wins, r.get("losses") or 0, r.get("total_pnl"),
            avg_win, avg_loss, r.get("max_win"), r.get("max_loss"),
            profit_factor, expectancy, r.get("avg_r"),
            r.get("hit_t1") or 0, r.get("hit_t2") or 0,
            r.get("hit_stop") or 0, r.get("expired") or 0,
            r.get("avg_mfe"), r.get("avg_mae"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Public run_verify_pipeline — called by LangGraph node
# ═══════════════════════════════════════════════════════════════════════════════

def run_verify_pipeline(lookback_days: int = 5, limit: int = 200) -> dict:
    """
    Main entry: load pending → verify each → write back → update aggregates.

    Returns summary dict for LangGraph state:
        {
          'pending': int,
          'verified': int,
          'correct': int,
          'total_pnl_pct': float,
          'model_accuracy_groups': int,
          'trade_performance_groups': int,
          'arf_feedback_items': list[dict],
        }
    """
    pending = load_pending_predictions(lookback_days=lookback_days, limit=limit)
    if not pending:
        logger.info("[verify] No pending predictions to verify")
        return {
            "pending": 0, "verified": 0, "correct": 0, "total_pnl_pct": 0.0,
            "model_accuracy_groups": 0, "trade_performance_groups": 0,
            "arf_feedback_items": [],
        }

    prepared = prepare_verification_updates(pending, load_market_risk())
    updates = prepared["verify_updates"]

    # Write back all at once (batch)
    write_verified_predictions(updates)

    summary = summarize_verification_updates(len(pending), updates)

    accuracy_pct = (summary["correct"] / summary["verified"] * 100) if summary["verified"] else 0
    logger.info(
        f"[verify] Verified {summary['verified']}, correct {summary['correct']} ({accuracy_pct:.1f}%) "
        f"total simulated PnL: {summary['total_pnl_pct'] * 100:.1f}%"
    )

    ma_count = update_model_accuracy()
    tp_count = update_trade_performance()

    return {
        **summary,
        "model_accuracy_groups": ma_count,
        "trade_performance_groups": tp_count,
        "arf_feedback_items": prepared["arf_feedback_items"],
    }
