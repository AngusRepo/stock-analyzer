#!/usr/bin/env python3
"""
backfill_yahoo.py — 用 Yahoo Finance 回補所有現存股票的歷史 OHLCV

期間：2023-01-01 ~ 2025-03-24（stock_prices 最早記錄之前）
寫入：生成 SQL 分批檔 → wrangler d1 execute

Yahoo 好處：一檔股票一個 request 拉全部日期，比 TWSE 逐月快 20 倍
限制：下市股不支援（由 backfill_delisted_wrangler.py 處理）

用法：
  cd stockvision-cloudflare-v12
  python3 scripts/backfill_yahoo.py
"""
import os
import sys
import json
import time
import subprocess
import requests
import urllib3
from datetime import datetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yahoo_chunks")

# 回補期間
PERIOD1 = int(datetime(2023, 1, 1).timestamp())
PERIOD2 = int(datetime(2025, 3, 24).timestamp())

YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
BATCH_SIZE = 50  # SQL statements per wrangler execute (stocks per batch)


def fetch_stock_list_from_d1() -> list[dict]:
    """Get all TW stock symbols from D1 via wrangler."""
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --json --command="SELECT id, symbol, market FROM stocks WHERE symbol GLOB \'[0-9]*\' AND (delisted_date IS NULL OR delisted_date = \'\') ORDER BY symbol"',
        cwd=WORKER_DIR, capture_output=True, timeout=60, shell=True,
    )
    if result.returncode != 0:
        print(f"Error fetching stock list: {(result.stderr or b'')[:300]}")
        return []
    try:
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
        if isinstance(data, list) and data:
            return data[0].get("results", [])
        return []
    except (json.JSONDecodeError, UnicodeDecodeError):
        print("Could not parse JSON, trying text mode...")
        return []


def fetch_yahoo_ohlcv(symbol: str, market: str) -> list[dict]:
    """Fetch OHLCV from Yahoo Finance. Returns list of {date, open, high, low, close, volume}."""
    suffix = ".TWO" if market == "OTC" else ".TW"
    yahoo_sym = f"{symbol}{suffix}"

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_sym}?period1={PERIOD1}&period2={PERIOD2}&interval=1d"
    try:
        resp = requests.get(url, timeout=20, verify=False, headers=YAHOO_HEADERS)
        if resp.status_code != 200:
            return []
        data = resp.json()
        result = data.get("chart", {}).get("result", [])
        if not result:
            return []

        timestamps = result[0].get("timestamp", [])
        quote = result[0].get("indicators", {}).get("quote", [{}])[0]
        opens = quote.get("open", [])
        highs = quote.get("high", [])
        lows = quote.get("low", [])
        closes = quote.get("close", [])
        volumes = quote.get("volume", [])

        bars = []
        for i, ts in enumerate(timestamps):
            dt = datetime.utcfromtimestamp(ts)
            o = opens[i] if i < len(opens) and opens[i] is not None else None
            h = highs[i] if i < len(highs) and highs[i] is not None else None
            l = lows[i] if i < len(lows) and lows[i] is not None else None
            c = closes[i] if i < len(closes) and closes[i] is not None else None
            v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0

            if o is None or c is None:
                continue
            # Guard: high/low 可能為 null，用 open/close 補
            if h is None:
                h = max(o, c)
            if l is None:
                l = min(o, c)

            bars.append({
                "date": dt.strftime("%Y-%m-%d"),
                "open": round(o, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "close": round(c, 2),
                "volume": int(v),
            })
        return bars
    except Exception as e:
        print(f"    Yahoo {yahoo_sym}: {e}")
        return []


def run_wrangler_sql(sql_file: str) -> bool:
    """Execute SQL file via wrangler d1."""
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file="{sql_file}"',
        cwd=WORKER_DIR, capture_output=True, timeout=120, shell=True,
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or b"")[:200]
        print(f"  [FAIL] wrangler error: {err}")
        return False
    return True


def main():
    print("=" * 60)
    print("StockVision: Yahoo Finance Historical Backfill")
    print(f"Period: 2023-01-01 ~ 2025-03-24")
    print("=" * 60)

    # Create output dir
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Get stock list
    print("\nFetching stock list from D1...")
    stocks = fetch_stock_list_from_d1()

    if not stocks:
        # Fallback: use wrangler without --json
        print("Trying fallback method...")
        result = subprocess.run(
            'npx wrangler d1 execute stockvision-db --remote --command="SELECT symbol, market FROM stocks WHERE symbol GLOB \'[0-9]*\' AND (delisted_date IS NULL OR delisted_date = \'\') ORDER BY symbol"',
            cwd=WORKER_DIR, capture_output=True, timeout=60, shell=True,
        )
        # Parse from text output
        import re
        lines = result.stdout.decode("utf-8", errors="replace").split("\n")
        for line in lines:
            m = re.search(r'"symbol":\s*"(\d+)".*"market":\s*"(\w+)"', line)
            if m:
                stocks.append({"symbol": m.group(1), "market": m.group(2)})
        # If still empty, try another parse
        if not stocks:
            try:
                raw = json.loads(result.stdout.decode("utf-8", errors="replace"))
                if isinstance(raw, list):
                    for item in raw:
                        for r in item.get("results", []):
                            stocks.append(r)
            except:
                pass

    print(f"Found {len(stocks)} stocks to backfill\n")

    if not stocks:
        print("ERROR: Could not get stock list from D1. Run manually:")
        print('  npx wrangler d1 execute stockvision-db --remote --command="SELECT symbol,market FROM stocks"')
        return

    total_bars = 0
    batch_sql = []
    batch_num = 0
    failed = []

    for i, stock in enumerate(stocks):
        sym = stock["symbol"]
        market = stock.get("market", "TWSE")

        bars = fetch_yahoo_ohlcv(sym, market)

        if bars:
            total_bars += len(bars)
            for bar in bars:
                batch_sql.append(
                    f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume) "
                    f"SELECT id, '{bar['date']}', {bar['open']}, {bar['high']}, {bar['low']}, {bar['close']}, {bar['volume']} "
                    f"FROM stocks WHERE symbol = '{sym}';"
                )
        else:
            failed.append(sym)

        # Progress
        if (i + 1) % 50 == 0 or i == len(stocks) - 1:
            print(f"  [{i+1}/{len(stocks)}] {sym}: {len(bars)} bars (total: {total_bars}, failed: {len(failed)})")

        # Flush batch every BATCH_SIZE stocks
        if len(batch_sql) >= 5000 or i == len(stocks) - 1:
            if batch_sql:
                batch_num += 1
                sql_file = os.path.join(OUTPUT_DIR, f"batch_{batch_num:03d}.sql")
                with open(sql_file, "w", encoding="utf-8") as f:
                    f.write("\n".join(batch_sql))
                print(f"  → Executing batch {batch_num} ({len(batch_sql)} stmts)...")
                ok = run_wrangler_sql(sql_file)
                if ok:
                    print(f"  [OK] Batch {batch_num} done")
                batch_sql = []

        # Rate limit: 0.3s between Yahoo requests
        time.sleep(0.3)

    print(f"\n{'=' * 60}")
    print(f"[OK] Done: {len(stocks)} stocks, {total_bars} price bars")
    if failed:
        print(f"[WARN] Failed ({len(failed)}): {', '.join(failed[:20])}")
    print(f"SQL batches written to: {OUTPUT_DIR}/")

    # Cleanup
    for f in os.listdir(OUTPUT_DIR):
        try:
            os.remove(os.path.join(OUTPUT_DIR, f))
        except:
            pass
    try:
        os.rmdir(OUTPUT_DIR)
    except:
        pass


if __name__ == "__main__":
    main()
