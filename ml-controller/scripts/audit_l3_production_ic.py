from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain  # noqa: E402

LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
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
    prediction_rows = LEARNING_D1_CLIENT.query(
        f"""SELECT id, stock_id, model_name, direction_accuracy, forecast_data,
                   prediction_date, generated_at
              FROM predictions
             WHERE model_name IN ({placeholders})
               AND date(prediction_date) <= date(?)
               AND date(prediction_date) >= date(?, ?)""",
        [*ALPHA_PREDICTION_MODELS, args.run_date, args.run_date, f"-{max(1, args.lookback_days)} days"],
    )
    price_rows = MARKET_D1_CLIENT.query(
        """SELECT stock_id, price_date, entry_open, exit_date, exit_close,
                  entry_factor, exit_factor
             FROM (
               SELECT stock_id, date(date) price_date,
                      LEAD(open, 1) OVER (PARTITION BY stock_id ORDER BY date(date)) entry_open,
                      LEAD(date(date), 5) OVER (PARTITION BY stock_id ORDER BY date(date)) exit_date,
                      LEAD(close, 5) OVER (PARTITION BY stock_id ORDER BY date(date)) exit_close,
                      LEAD(CASE WHEN close>0 AND adj_close>0 THEN adj_close/close END, 1)
                        OVER (PARTITION BY stock_id ORDER BY date(date)) entry_factor,
                      LEAD(CASE WHEN close>0 AND adj_close>0 THEN adj_close/close END, 5)
                        OVER (PARTITION BY stock_id ORDER BY date(date)) exit_factor
                 FROM stock_prices
                WHERE date(date) >= date(?, ?, '-10 days') AND date(date) <= date(?)
             )""",
        [args.run_date, f"-{max(1, args.lookback_days)} days", args.run_date],
    )
    prices = {
        (int(row["stock_id"]), str(row["price_date"])[:10]): row
        for row in price_rows if row.get("stock_id") is not None
    }
    rows = []
    for prediction in prediction_rows:
        key = (int(prediction["stock_id"]), str(prediction.get("prediction_date") or "")[:10])
        price = prices.get(key)
        if not price:
            continue
        entry = float(price.get("entry_open") or 0)
        exit_close = float(price.get("exit_close") or 0)
        entry_factor = float(price.get("entry_factor") or 0)
        exit_factor = float(price.get("exit_factor") or 0)
        exit_date = str(price.get("exit_date") or "")[:10]
        if not (entry > 0 and exit_close > 0 and entry_factor > 0 and exit_factor > 0):
            continue
        if abs(exit_factor / entry_factor - 1.0) > 0.02 or exit_date > args.run_date:
            continue
        rows.append({
            **prediction,
            "actual_return_pct": exit_close / entry - 1.0,
            "verified_at": exit_date,
            "verification_label_schema_version": IC_TARGET_SEMANTIC_VERSION,
            "verification_label_entry_price": entry,
            "verification_label_end_date": exit_date,
            "verification_label_known_date": exit_date,
        })
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
