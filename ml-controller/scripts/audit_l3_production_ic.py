from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain  # noqa: E402

LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)
from services.model_ic_tracker import (  # noqa: E402
    ALPHA_PREDICTION_MODELS,
    IC_TARGET_SEMANTIC_VERSION,
    compute_weekly_ic_from_rows,
)


def _factor(close, adjusted) -> float | None:
    close, adjusted = float(close or 0), float(adjusted or 0)
    return adjusted / close if close > 0 and adjusted > 0 else None


def build_label_rows(prediction_rows, price_rows, canonical_rows, symbols, run_date):
    """MEM-M2 (3): the corporate-action filter uses canonical finlab.price adj_close/close.

    The legacy stock_prices factor is only a fallback; any row that needed it is
    marked legacy_only (canonical finlab.price adj_close starts 2026-04-27).
    """
    canonical = {(str(r["symbol"]), str(r["date"])[:10]): r for r in canonical_rows}
    prices = {
        (int(row["stock_id"]), str(row["price_date"])[:10]): row
        for row in price_rows if row.get("stock_id") is not None
    }
    rows, counts = [], {"canonical_close_basis_mismatch_legs": 0}
    for prediction in prediction_rows:
        key = (int(prediction["stock_id"]), str(prediction.get("prediction_date") or "")[:10])
        price = prices.get(key)
        if not price:
            continue
        entry = float(price.get("entry_open") or 0)
        exit_close = float(price.get("exit_close") or 0)
        exit_date = str(price.get("exit_date") or "")[:10]
        canonical_factors = []
        for leg in ("entry", "exit"):
            observed = canonical.get((symbols.get(key[0], ""), str(price.get(f"{leg}_date") or "")[:10]))
            factor = _factor(observed.get("close"), observed.get("adj_close")) if observed else None
            if factor is not None and not math.isclose(float(observed["close"]), float(price.get(f"{leg}_close") or 0),
                                                       rel_tol=1e-8, abs_tol=1e-8):
                factor = None
                counts["canonical_close_basis_mismatch_legs"] += 1
            canonical_factors.append(factor)
        # Both legs from one source: a canonical/legacy mix compares different adjustment bases.
        source = "canonical" if None not in canonical_factors else "legacy_only"
        factors = canonical_factors if source == "canonical" else [
            _factor(price.get(f"{leg}_close"), price.get(f"{leg}_adj_close")) for leg in ("entry", "exit")]
        entry_factor, exit_factor = (f or 0.0 for f in factors)
        if not (entry > 0 and exit_close > 0 and entry_factor > 0 and exit_factor > 0):
            continue
        if abs(exit_factor / entry_factor - 1.0) > 0.02 or exit_date > run_date:
            continue
        rows.append({
            **prediction,
            "actual_return_pct": exit_close / entry - 1.0,
            "verified_at": exit_date,
            "verification_label_schema_version": IC_TARGET_SEMANTIC_VERSION,
            "verification_label_entry_price": entry,
            "verification_label_end_date": exit_date,
            "verification_label_known_date": exit_date,
            "label_factor_source": source,
        })
    return rows, counts


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
    window = [args.run_date, f"-{max(1, args.lookback_days)} days", args.run_date]
    price_rows = MARKET_D1_CLIENT.query(
        """SELECT stock_id, price_date, entry_open, entry_date, entry_close, entry_adj_close,
                  exit_date, exit_close, exit_adj_close
             FROM (
               SELECT stock_id, date(date) price_date,
                      LEAD(open, 1) OVER w entry_open,
                      LEAD(date(date), 1) OVER w entry_date,
                      LEAD(close, 1) OVER w entry_close,
                      LEAD(adj_close, 1) OVER w entry_adj_close,
                      LEAD(date(date), 5) OVER w exit_date,
                      LEAD(close, 5) OVER w exit_close,
                      LEAD(adj_close, 5) OVER w exit_adj_close
                 FROM stock_prices
                WHERE date(date) >= date(?, ?, '-10 days') AND date(date) <= date(?)
               WINDOW w AS (PARTITION BY stock_id ORDER BY date(date))
             )""",
        window,
    )
    canonical_rows = MARKET_D1_CLIENT.query(
        """SELECT stock_id AS symbol, date(date) date, close, adj_close
             FROM canonical_market_daily
            WHERE source='finlab.price'
              AND date(date) >= date(?, ?, '-10 days') AND date(date) <= date(?)
              AND date(as_of_date) <= date(?)""",
        [*window, args.run_date],
    )
    symbols = {int(r["id"]): str(r["symbol"]) for r in CORE_D1_CLIENT.query("SELECT id, symbol FROM stocks", [])}
    rows, counts = build_label_rows(prediction_rows, price_rows, canonical_rows, symbols, args.run_date)
    canonical_only = [row for row in rows if row["label_factor_source"] == "canonical"]

    def ic(selected):
        return compute_weekly_ic_from_rows(
            selected,
            min_samples=1,
            min_dates=1,
            all_tracked=ALPHA_PREDICTION_MODELS,
        )

    print(json.dumps({
        "schema_version": "active8-production-ic-audit-v3",
        "label_source": "raw_stock_prices_next_open_to_fifth_close_factor_stable",
        "factor_source": "canonical_market_daily:finlab.price, legacy stock_prices fallback marked legacy_only",
        "run_date": args.run_date,
        "lookback_days": args.lookback_days,
        "input_rows": len(rows),
        "input_rows_by_factor_source": {"canonical": len(canonical_only), "legacy_only": len(rows) - len(canonical_only)},
        "legacy_only_prediction_dates": sorted({str(row.get("prediction_date") or "")[:10]
                                                for row in rows if row["label_factor_source"] == "legacy_only"}),
        "factor_source_counts": counts,
        "models": ic(rows),
        "models_canonical_only": ic(canonical_only),
    }, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
