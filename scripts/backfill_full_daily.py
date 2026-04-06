#!/usr/bin/env python3
"""
backfill_full_daily.py — 用 TWSE STOCK_DAY / TPEX tradingStock 補齊每一個交易日

對象：324 檔 Yahoo 沒抓到的股票（ETF + OTC 冷門股）
方式：逐檔逐月打 TWSE/TPEX API → 生成 SQL → wrangler d1 execute
時間：324 檔 x 24 月 = 7,776 requests x 2.5s = ~5.4 小時
費用：Paid plan 不限制，TWSE/TPEX 免費公開 API

用法：
  cd stockvision-cloudflare-v12
  python3 scripts/backfill_full_daily.py
"""
import os, sys, json, time, subprocess, requests, urllib3
from datetime import datetime
sys.stdout.reconfigure(line_buffering=True)  # fix Windows buffering
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "daily_chunks")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
BATCH_LIMIT = 8000  # SQL stmts per wrangler execute


def p(msg):
    print(msg, flush=True)


def parse_tw_num(s):
    s = str(s).strip().replace(",", "").replace("--", "0").replace("X", "").replace("+", "").replace(" ", "")
    try: return float(s)
    except ValueError: return 0.0


def parse_roc_date(s):
    parts = s.strip().split("/")
    y = int(parts[0]) + 1911
    return f"{y:04d}-{parts[1]}-{parts[2]}"


def run_wrangler(sql_file):
    r = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file="{sql_file}"',
        cwd=WORKER_DIR, capture_output=True, timeout=180, shell=True,
    )
    return r.returncode == 0


def get_missing_symbols():
    r = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --json --command="'
        "SELECT s.symbol, s.market FROM stocks s "
        "WHERE s.symbol GLOB '[0-9]*' "
        "AND NOT EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.stock_id = s.id AND sp.date < '2025-01-01') "
        'ORDER BY s.symbol"',
        cwd=WORKER_DIR, capture_output=True, timeout=60, shell=True,
    )
    try:
        data = json.loads(r.stdout.decode("utf-8", errors="replace"))
        if isinstance(data, list) and data:
            return data[0].get("results", [])
    except: pass
    return []


def fetch_twse_month(symbol, year, month):
    """Fetch all trading days for one TWSE stock in one month."""
    date_param = f"{year}{month:02d}01"
    url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date_param}&stockNo={symbol}"
    try:
        resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
        if resp.status_code != 200: return []
        data = resp.json()
        if data.get("stat") != "OK" or not data.get("data"): return []
        bars = []
        for row in data["data"]:
            try:
                d = parse_roc_date(row[0])
                o, h, l, c = parse_tw_num(row[3]), parse_tw_num(row[4]), parse_tw_num(row[5]), parse_tw_num(row[6])
                v = int(parse_tw_num(row[1]))
                if c > 0: bars.append({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v})
            except: pass
        return bars
    except: return []


def fetch_tpex_month(symbol, year, month):
    """Fetch all trading days for one TPEX/OTC stock in one month."""
    date_param = f"{year}/{month:02d}/01"
    url = f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date={date_param}&code={symbol}&response=json"
    try:
        resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
        if resp.status_code != 200: return []
        data = resp.json()
        tables = data.get("tables", [])
        if not tables or not tables[0].get("data"): return []
        bars = []
        for row in tables[0]["data"]:
            try:
                d = parse_roc_date(row[0])
                o, h, l, c = parse_tw_num(row[3]), parse_tw_num(row[4]), parse_tw_num(row[5]), parse_tw_num(row[6])
                v = int(parse_tw_num(row[1]) * 1000)  # lots -> shares
                if c > 0: bars.append({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v})
            except: pass
        return bars
    except: return []


def main():
    p("=" * 60)
    p("StockVision: Full Daily OHLCV Backfill (TWSE/TPEX)")
    p("324 missing stocks x 24 months = ~7,776 requests")
    p("Estimated time: ~5.4 hours")
    p("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    p("\nFetching missing symbols...")
    stocks = get_missing_symbols()
    p(f"Found {len(stocks)} stocks to backfill")

    if not stocks:
        p("Nothing to do.")
        return

    total_bars = 0
    sql_buf = []
    batch_num = 0
    start_time = time.time()

    for i, stock in enumerate(stocks):
        sym = stock["symbol"]
        market = stock.get("market", "TWSE")
        stock_bars = 0

        for year in [2023, 2024]:
            for month in range(1, 13):
                if market == "OTC":
                    bars = fetch_tpex_month(sym, year, month)
                else:
                    bars = fetch_twse_month(sym, year, month)

                for bar in bars:
                    sql_buf.append(
                        f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume) "
                        f"SELECT id, '{bar['date']}', {bar['open']}, {bar['high']}, {bar['low']}, {bar['close']}, {bar['volume']} "
                        f"FROM stocks WHERE symbol = '{sym}';"
                    )
                stock_bars += len(bars)
                time.sleep(2.5)

        total_bars += stock_bars
        elapsed = time.time() - start_time
        rate = (i + 1) / elapsed * 3600 if elapsed > 0 else 0
        eta_h = (len(stocks) - i - 1) / rate if rate > 0 else 0

        if (i + 1) % 5 == 0 or i == 0:
            p(f"  [{i+1}/{len(stocks)}] {sym} ({market}): {stock_bars} bars | total: {total_bars} | ETA: {eta_h:.1f}h")

        # Flush batch
        if len(sql_buf) >= BATCH_LIMIT:
            batch_num += 1
            sql_file = os.path.join(OUTPUT_DIR, f"batch_{batch_num:03d}.sql")
            with open(sql_file, "w", encoding="utf-8") as f:
                f.write("\n".join(sql_buf))
            p(f"  -> D1 batch {batch_num} ({len(sql_buf)} stmts)...")
            ok = run_wrangler(sql_file)
            p(f"  -> {'[OK]' if ok else '[FAIL]'}")
            try: os.remove(sql_file)
            except: pass
            sql_buf = []

    # Final flush
    if sql_buf:
        batch_num += 1
        sql_file = os.path.join(OUTPUT_DIR, f"batch_{batch_num:03d}.sql")
        with open(sql_file, "w", encoding="utf-8") as f:
            f.write("\n".join(sql_buf))
        p(f"  -> D1 final batch {batch_num} ({len(sql_buf)} stmts)...")
        ok = run_wrangler(sql_file)
        p(f"  -> {'[OK]' if ok else '[FAIL]'}")
        try: os.remove(sql_file)
        except: pass

    try: os.rmdir(OUTPUT_DIR)
    except: pass

    elapsed = time.time() - start_time
    p(f"\n{'=' * 60}")
    p(f"[DONE] {len(stocks)} stocks, {total_bars} bars, {batch_num} batches")
    p(f"Time: {elapsed/3600:.1f} hours")


if __name__ == "__main__":
    main()
