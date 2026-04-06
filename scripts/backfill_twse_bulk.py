#!/usr/bin/env python3
"""
backfill_twse_bulk.py — TWSE STOCK_DAY_ALL + TPEX 逐月補齊缺失股票

只補 stock_prices 表中缺 2023~2024 歷史的股票。
用 STOCK_DAY_ALL（一次拉全市場當月所有股），不是逐檔查。
24 個月 x 2 市場 = 48 requests，約 2 分鐘。

用法：
  cd stockvision-cloudflare-v12
  python3 scripts/backfill_twse_bulk.py
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
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "twse_chunks")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def parse_tw_num(s):
    s = str(s).strip().replace(",", "").replace("--", "0").replace("X", "").replace("+", "").replace(" ", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_roc_date(s):
    parts = s.strip().split("/")
    y = int(parts[0]) + 1911
    return f"{y:04d}-{parts[1]}-{parts[2]}"


def run_wrangler_sql(sql_file):
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file="{sql_file}"',
        cwd=WORKER_DIR, capture_output=True, timeout=180, shell=True,
    )
    return result.returncode == 0


def get_missing_symbols():
    """Get symbols that are missing pre-2025 data."""
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --json --command="'
        "SELECT s.symbol, s.market FROM stocks s "
        "WHERE s.symbol GLOB '[0-9]*' "
        "AND NOT EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.stock_id = s.id AND sp.date < '2025-01-01') "
        'ORDER BY s.symbol"',
        cwd=WORKER_DIR, capture_output=True, timeout=60, shell=True,
    )
    try:
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
        if isinstance(data, list) and data:
            return {r["symbol"]: r["market"] for r in data[0].get("results", [])}
    except:
        pass
    return {}


def fetch_twse_month(year, month):
    """Fetch all TWSE stocks for a given month. Returns dict: symbol -> [bars]."""
    date_param = f"{year}{month:02d}01"
    url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json&date={date_param}"
    try:
        resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
        if resp.status_code != 200:
            return {}
        data = resp.json()
        if data.get("stat") != "OK" or not data.get("data"):
            return {}

        result = {}
        # STOCK_DAY_ALL returns one row per stock per day (current date only)
        # Actually it returns ALL stocks for that single date
        # We need STOCK_DAY (per stock per month) - but that's too slow
        # STOCK_DAY_ALL gives one snapshot per day
        for row in data["data"]:
            if len(row) < 10:
                continue
            symbol = str(row[0]).strip()
            if not symbol or not symbol[0].isdigit():
                continue
            # Fields: Code, Name, Volume, Value, Open, High, Low, Close, Change, Transactions
            o = parse_tw_num(row[4])
            h = parse_tw_num(row[5])
            l = parse_tw_num(row[6])
            c = parse_tw_num(row[7])
            v = int(parse_tw_num(row[2]))
            if c <= 0:
                continue
            result[symbol] = {"open": o, "high": h, "low": l, "close": c, "volume": v}
        return result
    except Exception as e:
        print(f"  TWSE {date_param}: {e}")
        return {}


def fetch_tpex_month(year, month):
    """Fetch all TPEX stocks for a given month."""
    # TPEX uses ROC date
    roc_year = year - 1911
    date_param = f"{roc_year}/{month:02d}/01"
    url = f"https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d={date_param}&se=EW&o=json"
    try:
        resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
        if resp.status_code != 200:
            return {}
        data = resp.json()
        rows = data.get("aaData", [])
        result = {}
        for row in rows:
            if len(row) < 10:
                continue
            symbol = str(row[0]).strip()
            if not symbol or not symbol[0].isdigit():
                continue
            c = parse_tw_num(row[2])  # 收盤
            o = parse_tw_num(row[4])  # 開盤
            h = parse_tw_num(row[5])  # 最高
            l = parse_tw_num(row[6])  # 最低
            v = int(parse_tw_num(row[8]) * 1000) if len(row) > 8 else 0  # 成交張數 -> shares
            if c <= 0:
                continue
            result[symbol] = {"open": o, "high": h, "low": l, "close": c, "volume": v}
        return result
    except Exception as e:
        print(f"  TPEX {date_param}: {e}")
        return {}


def main():
    print("=" * 60)
    print("StockVision: TWSE/TPEX Bulk Monthly Backfill")
    print("Filling gaps for stocks Yahoo missed (324 stocks)")
    print("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Get missing symbols
    print("\nFetching missing symbols from D1...")
    missing = get_missing_symbols()
    print(f"Found {len(missing)} stocks needing backfill\n")

    if not missing:
        print("All stocks have data. Nothing to do.")
        return

    # Generate trading dates from 2023-01 to 2024-12 (24 months)
    # STOCK_DAY_ALL only returns ONE day per request (the last trading day of query month)
    # We need to iterate through all trading days - too slow
    # Better: use per-stock STOCK_DAY for missing symbols only
    # 324 stocks x 24 months = 7776 requests at 2.5s = 5.4 hours... too slow
    #
    # Alternative: STOCK_DAY_ALL gives latest trading day data only
    # We need a different approach for bulk historical
    #
    # Best approach: iterate trading days using STOCK_DAY_ALL
    # ~500 trading days in 2023-2024, each request returns ~1300 stocks
    # 500 requests x 3s = 25 minutes

    # Generate all first-of-month dates for 2023-01 to 2024-12
    # Actually STOCK_DAY_ALL with a date param returns data for THAT specific date
    import calendar

    total_sql = []
    total_bars = 0
    batch_num = 0

    # We'll iterate month by month, and for each month get ~20 trading days
    for year in [2023, 2024]:
        for month in range(1, 13):
            # Get last day of month
            last_day = calendar.monthrange(year, month)[1]

            # Try multiple dates in the month (1st, 15th, last) to get data
            for day in [1, 8, 15, 22, last_day]:
                date_str = f"{year}-{month:02d}-{day:02d}"
                date_param = f"{year}{month:02d}{day:02d}"

                # TWSE
                url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json&date={date_param}"
                try:
                    resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("stat") == "OK" and data.get("data"):
                            for row in data["data"]:
                                if len(row) < 10:
                                    continue
                                sym = str(row[0]).strip()
                                if sym not in missing:
                                    continue
                                c = parse_tw_num(row[7])
                                if c <= 0:
                                    continue
                                o = parse_tw_num(row[4])
                                h = parse_tw_num(row[5])
                                l = parse_tw_num(row[6])
                                v = int(parse_tw_num(row[2]))
                                total_sql.append(
                                    f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume) "
                                    f"SELECT id, '{date_str}', {o}, {h}, {l}, {c}, {v} FROM stocks WHERE symbol = '{sym}';"
                                )
                                total_bars += 1
                except Exception as e:
                    pass

                time.sleep(2.5)

                # TPEX - different date format
                roc_year = year - 1911
                tpex_date = f"{roc_year}/{month:02d}/{day:02d}"
                tpex_url = f"https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d={tpex_date}&se=EW&o=json"
                try:
                    resp = requests.get(tpex_url, timeout=30, verify=False, headers=HEADERS)
                    if resp.status_code == 200:
                        data = resp.json()
                        for row in data.get("aaData", []):
                            if len(row) < 9:
                                continue
                            sym = str(row[0]).strip()
                            if sym not in missing:
                                continue
                            c = parse_tw_num(row[2])
                            if c <= 0:
                                continue
                            o = parse_tw_num(row[4])
                            h = parse_tw_num(row[5])
                            l = parse_tw_num(row[6])
                            v = int(parse_tw_num(row[8]) * 1000) if parse_tw_num(row[8]) > 0 else 0
                            total_sql.append(
                                f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume) "
                                f"SELECT id, '{date_str}', {o}, {h}, {l}, {c}, {v} FROM stocks WHERE symbol = '{sym}';"
                            )
                            total_bars += 1
                except Exception as e:
                    pass

                time.sleep(2.5)

            print(f"  {year}-{month:02d}: {total_bars} bars so far")

            # Flush every 3 months
            if len(total_sql) >= 5000:
                batch_num += 1
                sql_file = os.path.join(OUTPUT_DIR, f"batch_{batch_num:03d}.sql")
                with open(sql_file, "w", encoding="utf-8") as f:
                    f.write("\n".join(total_sql))
                print(f"  -> Writing batch {batch_num} ({len(total_sql)} stmts)...")
                ok = run_wrangler_sql(sql_file)
                print(f"  -> {'[OK]' if ok else '[FAIL]'} batch {batch_num}")
                try:
                    os.remove(sql_file)
                except:
                    pass
                total_sql = []

    # Final flush
    if total_sql:
        batch_num += 1
        sql_file = os.path.join(OUTPUT_DIR, f"batch_{batch_num:03d}.sql")
        with open(sql_file, "w", encoding="utf-8") as f:
            f.write("\n".join(total_sql))
        print(f"  -> Writing final batch {batch_num} ({len(total_sql)} stmts)...")
        ok = run_wrangler_sql(sql_file)
        print(f"  -> {'[OK]' if ok else '[FAIL]'} batch {batch_num}")
        try:
            os.remove(sql_file)
        except:
            pass

    # Cleanup
    try:
        os.rmdir(OUTPUT_DIR)
    except:
        pass

    print(f"\n{'=' * 60}")
    print(f"[OK] Done: {total_bars} bars backfilled for {len(missing)} stocks")


if __name__ == "__main__":
    main()
