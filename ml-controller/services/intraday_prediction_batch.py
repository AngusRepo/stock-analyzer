"""Bounded D1 batch loader for intraday ensemble re-scoring."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

QueryFn = Callable[[str, list[object]], list[dict[str, Any]]]


def load_latest_ensemble_predictions(
    symbols: list[str],
    query_fn: QueryFn,
    *,
    chunk_size: int = 80,
) -> dict[str, dict[str, Any]]:
    unique_symbols = list(dict.fromkeys(str(symbol).strip() for symbol in symbols if str(symbol).strip()))
    bounded_chunk_size = max(1, min(80, int(chunk_size)))
    predictions: dict[str, dict[str, Any]] = {}

    for offset in range(0, len(unique_symbols), bounded_chunk_size):
        chunk = unique_symbols[offset:offset + bounded_chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = query_fn(
            f"""
            WITH ranked AS (
              SELECT s.symbol,
                     p.direction_accuracy, p.trade_signal, p.signal_raw,
                     p.entry_price AS pred_entry, p.stop_loss AS pred_stop,
                     p.target1 AS pred_t1, p.generated_at,
                     ROW_NUMBER() OVER (
                       PARTITION BY s.symbol
                       ORDER BY p.generated_at DESC, p.id DESC
                     ) AS row_num
              FROM predictions p
              JOIN stocks s ON s.id = p.stock_id
              WHERE s.symbol IN ({placeholders})
                AND p.model_name = 'ensemble'
            )
            SELECT symbol, direction_accuracy, trade_signal, signal_raw,
                   pred_entry, pred_stop, pred_t1, generated_at
            FROM ranked
            WHERE row_num = 1
            """,
            list(chunk),
        )
        for row in rows:
            symbol = str(row.get("symbol") or "").strip()
            if symbol:
                predictions[symbol] = row

    return predictions
