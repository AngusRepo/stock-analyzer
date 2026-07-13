from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import d1_client  # noqa: E402
from services.model_ic_tracker import (  # noqa: E402
    ALPHA_PREDICTION_MODELS,
    IC_TARGET_SEMANTIC_VERSION,
    compute_weekly_ic_from_rows,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Active-8 production IC audit")
    parser.add_argument("--run-date", required=True)
    parser.add_argument("--lookback-days", type=int, default=35)
    args = parser.parse_args()
    placeholders = ",".join("?" for _ in ALPHA_PREDICTION_MODELS)
    rows = d1_client.query(
        f"""
        WITH price_horizons AS (
            SELECT
                sp.stock_id,
                date(sp.date) AS price_date,
                LEAD(sp.open, 1) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_open,
                LEAD(date(sp.date), 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_date,
                LEAD(sp.close, 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_close,
                LEAD(CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END, 1)
                    OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_factor,
                LEAD(CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END, 5)
                    OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_factor
            FROM stock_prices sp
            WHERE date(sp.date) >= date(?, ?, '-10 days')
              AND date(sp.date) <= date(?)
        )
        SELECT p.id, p.stock_id, p.model_name, p.direction_accuracy, p.forecast_data,
               (ph.exit_close / ph.entry_open) - 1.0 AS actual_return_pct,
               ph.exit_date AS verified_at,
               p.prediction_date, p.generated_at,
               '{IC_TARGET_SEMANTIC_VERSION}' AS verification_label_schema_version,
               ph.entry_open AS verification_label_entry_price,
               ph.exit_date AS verification_label_end_date,
               ph.exit_date AS verification_label_known_date
        FROM predictions p
        JOIN price_horizons ph
          ON ph.stock_id = p.stock_id
         AND ph.price_date = date(p.prediction_date)
        WHERE p.model_name IN ({placeholders})
          AND ph.entry_open > 0
          AND ph.exit_close > 0
          AND ph.entry_factor > 0
          AND ph.exit_factor > 0
          AND ABS((ph.exit_factor / ph.entry_factor) - 1.0) <= 0.02
          AND date(ph.exit_date) <= date(?)
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        """,
        [
            args.run_date,
            f"-{max(1, args.lookback_days)} days",
            args.run_date,
            *ALPHA_PREDICTION_MODELS,
            args.run_date,
            args.run_date,
            args.run_date,
            f"-{max(1, args.lookback_days)} days",
        ],
    )
    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=1,
        min_dates=1,
        all_tracked=ALPHA_PREDICTION_MODELS,
    )
    print(json.dumps({
        "schema_version": "active8-production-ic-audit-v2",
        "label_source": "raw_stock_prices_next_open_to_fifth_close_factor_stable",
        "run_date": args.run_date,
        "lookback_days": args.lookback_days,
        "input_rows": len(rows),
        "models": result,
    }, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
