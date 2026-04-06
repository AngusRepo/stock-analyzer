#!/usr/bin/env python3
"""
backfill_delisted_wrangler.py — 回補下市股票資料（C1 存活偏差修正）

資料來源：TWSE + TPEX 官方 API（不依賴 FinMind）
寫入方式：生成 SQL 檔 → wrangler d1 execute（不需 CF_API_TOKEN）

用法：
  python3 scripts/backfill_delisted_wrangler.py
  # 會生成 scripts/backfill_output.sql
  # 然後自動用 wrangler d1 execute 寫入
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

BACKFILL_START = "2023-01-01"
WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")
OUTPUT_SQL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backfill_output.sql")

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def _parse_roc_date(roc_str: str) -> str:
    parts = roc_str.strip().split("/")
    y = int(parts[0]) + 1911
    return f"{y:04d}-{parts[1]}-{parts[2]}"


def _parse_num(s: str) -> float:
    s = s.strip().replace(",", "").replace("--", "0").replace("X", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _esc(s: str) -> str:
    return s.replace("'", "''")


# ─── Step 1: Fetch delisted stock list ───────────────────────────────────────

def fetch_delisted() -> list[dict]:
    stocks = []

    # TWSE
    try:
        resp = requests.get(
            "https://www.twse.com.tw/rwd/zh/company/suspendListing",
            params={"response": "json"}, timeout=30, verify=False, headers=HEADERS,
        )
        data = resp.json()
        for row in data.get("data", []):
            date_str = row[0].strip()
            symbol = row[2].strip() if len(row) > 2 else ""
            name = row[1].strip() if len(row) > 1 else ""
            # response encoding issue — name may be garbled, use symbol only
            try:
                iso = _parse_roc_date(date_str)
                if iso >= BACKFILL_START and symbol:
                    stocks.append({"symbol": symbol, "name": name, "delisted_date": iso, "market": "TWSE"})
            except (ValueError, IndexError):
                pass
        print(f"[TWSE] {len([s for s in stocks if s['market']=='TWSE'])} delisted since {BACKFILL_START}")
    except Exception as e:
        print(f"[TWSE] Failed: {e}")

    # TPEX
    try:
        resp = requests.get(
            "https://www.tpex.org.tw/web/regular_emerging/deListed/de-listed_companies.php",
            params={"l": "zh-tw", "o": "json"}, timeout=30, verify=False, headers=HEADERS,
        )
        data = resp.json()
        for row in data.get("aaData", []):
            if len(row) >= 4:
                symbol = row[0].strip()
                name = row[1].strip()
                date_str = row[3].strip()
                try:
                    iso = _parse_roc_date(date_str)
                    if iso >= BACKFILL_START and symbol:
                        stocks.append({"symbol": symbol, "name": name, "delisted_date": iso, "market": "OTC"})
                except (ValueError, IndexError):
                    pass
        print(f"[TPEX] {len([s for s in stocks if s['market']=='OTC'])} delisted since {BACKFILL_START}")
    except Exception as e:
        print(f"[TPEX] Failed: {e}")

    return stocks


# ─── Step 2: Fetch OHLCV history ─────────────────────────────────────────────

def fetch_ohlcv_twse(symbol: str, start: str, end: str) -> list[dict]:
    results = []
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    current = start_dt.replace(day=1)

    while current <= end_dt:
        date_param = current.strftime("%Y%m01")
        url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date_param}&stockNo={symbol}"
        try:
            resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("stat") == "OK" and data.get("data"):
                    for row in data["data"]:
                        try:
                            iso = _parse_roc_date(row[0])
                            if iso < start or iso > end:
                                continue
                            results.append({
                                "date": iso,
                                "open": _parse_num(row[3]),
                                "high": _parse_num(row[4]),
                                "low": _parse_num(row[5]),
                                "close": _parse_num(row[6]),
                                "volume": int(_parse_num(row[1])),
                            })
                        except (IndexError, ValueError):
                            pass
        except Exception as e:
            print(f"    [TWSE] {symbol} {date_param}: {e}")

        time.sleep(2.5)
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)

    return results


def fetch_ohlcv_tpex(symbol: str, start: str, end: str) -> list[dict]:
    results = []
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    current = start_dt.replace(day=1)

    while current <= end_dt:
        date_param = current.strftime("%Y/%m/01")
        url = f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date={date_param}&code={symbol}&response=json"
        try:
            resp = requests.get(url, timeout=30, verify=False, headers=HEADERS)
            if resp.status_code == 200:
                data = resp.json()
                tables = data.get("tables", [])
                if tables and tables[0].get("data"):
                    for row in tables[0]["data"]:
                        try:
                            iso = _parse_roc_date(row[0])
                            if iso < start or iso > end:
                                continue
                            results.append({
                                "date": iso,
                                "open": _parse_num(row[3]),
                                "high": _parse_num(row[4]),
                                "low": _parse_num(row[5]),
                                "close": _parse_num(row[6]),
                                "volume": int(_parse_num(row[1]) * 1000),
                            })
                        except (IndexError, ValueError):
                            pass
        except Exception as e:
            print(f"    [TPEX] {symbol} {date_param}: {e}")

        time.sleep(2.5)
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)

    return results


# ─── Step 3: Generate SQL + execute via wrangler ─────────────────────────────

def main():
    print("=" * 60)
    print("StockVision: Backfill Delisted Stocks (TWSE/TPEX only)")
    print(f"Period: {BACKFILL_START} ~ present")
    print("=" * 60)

    stocks = fetch_delisted()
    print(f"\nFound {len(stocks)} delisted stocks to backfill\n")

    if not stocks:
        print("No delisted stocks found.")
        return

    sql_lines = []
    total_bars = 0

    for i, stock in enumerate(stocks):
        sym = stock["symbol"]
        name = _esc(stock.get("name", sym))
        market = stock["market"]
        delisted = stock["delisted_date"]
        print(f"[{i+1}/{len(stocks)}] {sym} (delisted {delisted}, {market})")

        # INSERT stock
        sql_lines.append(
            f"INSERT OR IGNORE INTO stocks (symbol, name, market, is_active, delisted_date, added_at, updated_at) "
            f"VALUES ('{sym}', '{name}', '{market}', 0, '{delisted}', datetime('now'), datetime('now'));"
        )
        # UPDATE if exists
        sql_lines.append(
            f"UPDATE stocks SET delisted_date = '{delisted}', is_active = 0 WHERE symbol = '{sym}';"
        )

        # Fetch OHLCV
        end = delisted
        if market == "OTC":
            bars = fetch_ohlcv_tpex(sym, BACKFILL_START, end)
        else:
            bars = fetch_ohlcv_twse(sym, BACKFILL_START, end)

        print(f"  → {len(bars)} price bars")
        total_bars += len(bars)

        for bar in bars:
            sql_lines.append(
                f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume) "
                f"SELECT id, '{bar['date']}', {bar['open']}, {bar['high']}, {bar['low']}, {bar['close']}, {bar['volume']} "
                f"FROM stocks WHERE symbol = '{sym}';"
            )

    # Write SQL file
    with open(OUTPUT_SQL, "w", encoding="utf-8") as f:
        f.write("\n".join(sql_lines))
    print(f"\n{'=' * 60}")
    print(f"Generated {OUTPUT_SQL}")
    print(f"  {len(stocks)} stocks, {total_bars} price bars, {len(sql_lines)} SQL statements")

    # Execute via wrangler (batch in chunks of 100 to avoid timeout)
    print(f"\nExecuting via wrangler d1 execute...")
    chunk_size = 100
    for chunk_start in range(0, len(sql_lines), chunk_size):
        chunk = sql_lines[chunk_start:chunk_start + chunk_size]
        chunk_sql = "\n".join(chunk)
        chunk_file = OUTPUT_SQL + f".chunk{chunk_start}"
        with open(chunk_file, "w", encoding="utf-8") as f:
            f.write(chunk_sql)

        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "stockvision-db", "--remote", f"--file={chunk_file}"],
            cwd=WORKER_DIR, capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            print(f"  ❌ Chunk {chunk_start}: {result.stderr[:200]}")
        else:
            print(f"  ✅ Chunk {chunk_start}-{chunk_start + len(chunk)} ({len(chunk)} stmts)")

        # Clean up chunk file
        try:
            os.remove(chunk_file)
        except OSError:
            pass

    print(f"\n{'=' * 60}")
    print(f"✅ Done: {len(stocks)} delisted stocks, {total_bars} price bars backfilled")


if __name__ == "__main__":
    main()
