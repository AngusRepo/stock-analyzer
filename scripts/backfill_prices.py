"""
backfill_prices.py — yfinance 歷史股價批量補齊到 D1

Usage:
  cd stockvision-cloudflare-v12
  python scripts/backfill_prices.py

Prerequisites:
  pip install yfinance

Flow:
  1. 從 D1 讀所有 stocks（symbol, id, market）
  2. yfinance batch download 1 年 OHLCV
  3. 透過 wrangler d1 execute 批次寫入 stock_prices
"""

import subprocess
import json
import sys
import time

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

# ─── Config ──────────────────────────────────────────────────────────────────
DB_NAME = "stockvision-db"
BATCH_SIZE = 30       # yfinance download batch
SQL_BATCH = 100       # D1 SQL batch
PERIOD = "1y"         # 1 year history

def run_d1(sql: str) -> list:
    """Execute D1 SQL via wrangler and return results."""
    cmd = f'npx wrangler d1 execute {DB_NAME} --remote --json --command "{sql}"'
    result = subprocess.run(cmd, capture_output=True, text=True, cwd="worker", shell=True)
    if result.returncode != 0:
        print(f"D1 error: {result.stderr[:200]}")
        return []
    try:
        data = json.loads(result.stdout)
        return data[0].get("results", []) if data else []
    except:
        return []

def run_d1_file(filepath: str):
    """Execute D1 SQL file."""
    cmd = f'npx wrangler d1 execute {DB_NAME} --remote --file={filepath}'
    result = subprocess.run(cmd, capture_output=True, text=True, cwd="worker", shell=True)
    if result.returncode != 0:
        print(f"D1 file error: {result.stderr[:200]}")

def main():
    print("=== StockVision yfinance Backfill ===\n")

    # 1. Get all stocks from D1
    print("[1/3] Reading stocks from D1...")
    stocks = run_d1("SELECT id, symbol, market FROM stocks ORDER BY id")
    if not stocks:
        print("ERROR: No stocks found in D1")
        return

    print(f"  Found {len(stocks)} stocks")

    # 2. Split TWSE (.TW) vs OTC (.TWO)
    symbols_map = {}  # yf_symbol → (stock_id, db_symbol)
    for s in stocks:
        sym = s["symbol"]
        sid = s["id"]
        market = s.get("market", "TWSE")

        # Skip non-TW stocks
        if not sym[0].isdigit():
            continue

        if market == "OTC" or market == "TPEX":
            yf_sym = f"{sym}.TWO"
        else:
            yf_sym = f"{sym}.TW"
        symbols_map[yf_sym] = (sid, sym)

    yf_symbols = list(symbols_map.keys())
    print(f"  {len(yf_symbols)} TW stocks to backfill\n")

    # 3. Batch download + write to D1
    total_rows = 0
    failed = []

    for i in range(0, len(yf_symbols), BATCH_SIZE):
        batch_syms = yf_symbols[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(yf_symbols) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"[2/3] Batch {batch_num}/{total_batches}: downloading {len(batch_syms)} stocks...")

        try:
            data = yf.download(
                batch_syms,
                period=PERIOD,
                group_by="ticker",
                threads=True,
                progress=False,
            )
        except Exception as e:
            print(f"  ERROR downloading batch: {e}")
            failed.extend(batch_syms)
            continue

        # Generate SQL inserts
        sql_lines = []
        for yf_sym in batch_syms:
            stock_id, db_sym = symbols_map[yf_sym]
            try:
                if len(batch_syms) == 1:
                    df = data  # single stock returns flat DataFrame
                else:
                    df = data[yf_sym]

                if df is None or df.empty:
                    failed.append(yf_sym)
                    continue

                for idx, row in df.iterrows():
                    date = idx.strftime("%Y-%m-%d")
                    o = row.get("Open")
                    h = row.get("High")
                    l = row.get("Low")
                    c = row.get("Close")
                    v = row.get("Volume")
                    if c is None or str(c) == "nan":
                        continue
                    sql_lines.append(
                        f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, adj_close, volume) "
                        f"VALUES ({stock_id}, '{date}', {o:.2f}, {h:.2f}, {l:.2f}, {c:.2f}, {c:.2f}, {int(v or 0)});"
                    )
                    total_rows += 1
            except Exception as e:
                failed.append(yf_sym)
                continue

        # Write to D1 in SQL batches
        if sql_lines:
            # Write to temp file and execute
            tmpfile = f"/tmp/backfill_batch_{batch_num}.sql"
            for j in range(0, len(sql_lines), SQL_BATCH):
                chunk = sql_lines[j:j+SQL_BATCH]
                with open(tmpfile, "w") as f:
                    f.write("\n".join(chunk))
                run_d1_file(tmpfile)

            print(f"  Written {len(sql_lines)} rows to D1")

        # Rate limit respect
        if i + BATCH_SIZE < len(yf_symbols):
            time.sleep(1)

    # Summary
    print(f"\n[3/3] === Summary ===")
    print(f"  Total stocks: {len(yf_symbols)}")
    print(f"  Total rows written: {total_rows}")
    print(f"  Failed: {len(failed)}")
    if failed:
        print(f"  Failed symbols: {', '.join(failed[:20])}{'...' if len(failed) > 20 else ''}")


if __name__ == "__main__":
    main()
