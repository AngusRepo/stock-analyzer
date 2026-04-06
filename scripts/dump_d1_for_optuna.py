#!/usr/bin/env python3
"""
dump_d1_for_optuna.py — Dump D1 tables to local CSV for Optuna search

Dumps: stock_prices, predictions, paper_orders, daily_recommendations
Uses wrangler d1 execute (no API token needed)

Output: scripts/data/*.csv
"""
import os, sys, json, subprocess, csv
sys.stdout.reconfigure(line_buffering=True)

WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def wrangler_query(sql: str) -> list[dict]:
    """Run SQL via wrangler d1 execute --json, return results."""
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --json --command="{sql}"',
        cwd=WORKER_DIR, capture_output=True, timeout=120, shell=True,
    )
    if result.returncode != 0:
        print(f"  [ERROR] wrangler failed: {(result.stderr or b'')[:200]}")
        return []
    try:
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
        if isinstance(data, list) and data:
            return data[0].get("results", [])
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass
    return []


def dump_table(name: str, sql: str, filename: str):
    """Dump a SQL query result to CSV."""
    print(f"Dumping {name}...", flush=True)
    rows = wrangler_query(sql)
    if not rows:
        print(f"  [WARN] {name}: 0 rows")
        return

    filepath = os.path.join(OUTPUT_DIR, filename)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"  [OK] {name}: {len(rows)} rows -> {filename}", flush=True)


def dump_stock_prices_chunked():
    """Stock prices is too large for one query. Dump by year."""
    print("Dumping stock_prices (chunked by year)...", flush=True)
    all_rows = []
    for year in [2023, 2024, 2025, 2026]:
        sql = (
            f"SELECT sp.date, s.symbol, sp.open, sp.high, sp.low, sp.close, sp.volume "
            f"FROM stock_prices sp JOIN stocks s ON s.id = sp.stock_id "
            f"WHERE sp.date >= '{year}-01-01' AND sp.date < '{year+1}-01-01' "
            f"ORDER BY sp.date, s.symbol"
        )
        # wrangler has row limit, need to paginate
        # Try with LIMIT/OFFSET
        offset = 0
        batch_size = 50000
        year_rows = []
        while True:
            batch_sql = f"{sql} LIMIT {batch_size} OFFSET {offset}"
            rows = wrangler_query(batch_sql)
            if not rows:
                break
            year_rows.extend(rows)
            print(f"  {year}: {len(year_rows)} rows (batch {offset//batch_size + 1})", flush=True)
            if len(rows) < batch_size:
                break
            offset += batch_size

        all_rows.extend(year_rows)
        print(f"  [OK] {year}: {len(year_rows)} rows", flush=True)

    if all_rows:
        filepath = os.path.join(OUTPUT_DIR, "stock_prices.csv")
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=all_rows[0].keys())
            writer.writeheader()
            writer.writerows(all_rows)
        print(f"  [TOTAL] stock_prices: {len(all_rows)} rows", flush=True)
    else:
        print("  [WARN] stock_prices: 0 rows total")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print("=" * 50)
    print("D1 → Local CSV Dump for Optuna")
    print("=" * 50)

    # 1. Stock prices (largest, chunked)
    dump_stock_prices_chunked()

    # 2. Predictions
    dump_table("predictions",
        "SELECT p.stock_id, s.symbol, p.signal, p.signal_raw, p.confidence, "
        "p.stop_loss, p.target_price_1, p.target_price_2, p.generated_at "
        "FROM predictions p JOIN stocks s ON s.id = p.stock_id "
        "ORDER BY p.generated_at DESC LIMIT 5000",
        "predictions.csv")

    # 3. Paper orders
    dump_table("paper_orders",
        "SELECT symbol, name, side, shares, price, commission, tax, total_cost, "
        "source, signal, confidence, note, created_at "
        "FROM paper_orders WHERE account_id=1 ORDER BY created_at",
        "paper_orders.csv")

    # 4. Daily recommendations (for signal threshold search)
    dump_table("daily_recommendations",
        "SELECT symbol, name, score, signal, confidence, chip_score, tech_score, ml_score, "
        "sector, rsi14, macd_hist, foreign_net_5d, trust_net_5d, current_price, date "
        "FROM daily_recommendations ORDER BY date DESC, score DESC LIMIT 5000",
        "daily_recommendations.csv")

    # 5. Technical indicators (for barrier label computation)
    dump_table("technical_indicators",
        "SELECT ti.stock_id, s.symbol, ti.date, ti.atr14, ti.rsi14, ti.macd_hist "
        "FROM technical_indicators ti JOIN stocks s ON s.id = ti.stock_id "
        "ORDER BY ti.date DESC LIMIT 10000",
        "technical_indicators.csv")

    print(f"\n{'=' * 50}")
    print(f"[DONE] CSVs saved to {OUTPUT_DIR}/")
    print(f"Files: {', '.join(os.listdir(OUTPUT_DIR))}")


if __name__ == "__main__":
    main()
