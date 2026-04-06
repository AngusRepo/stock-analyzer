#!/usr/bin/env python3
"""
backfill_delisted_stocks.py — 回補下市股票資料（C1 存活偏差修正）

從 TWSE/TPEX API 拉取 2023-01-01 以來的下市股票清單，
包含其 OHLCV 歷史，寫入 D1 stocks + stock_prices 表。

資料來源（不依賴 FinMind）：
  1. TWSE 上市公司下市清單：https://www.twse.com.tw/rwd/zh/company/suspendListing
  2. TPEX 上櫃公司下市清單
  3. TWSE STOCK_DAY 個股月K歷史（支援下市股）
  4. TPEX tradingStock 個股月K歷史（支援下市股）

用法：
  CF_API_TOKEN=xxx python3 scripts/backfill_delisted_stocks.py
"""
import os
import sys
import json
import time
import requests
from datetime import datetime, timedelta

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "619a83ac9f20847d9e2f2920823b727d")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "6401a5f6-5767-4fa8-a1a7-ec8d4739ac79")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")

D1_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query"

BACKFILL_START = "2023-01-01"


def d1_exec(sql: str, params: list = None) -> bool:
    if not CF_API_TOKEN:
        print("ERROR: CF_API_TOKEN not set")
        return False
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = requests.post(D1_API, json=body, headers={
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    })
    if resp.status_code != 200:
        print(f"D1 error {resp.status_code}: {resp.text[:200]}")
        return False
    return resp.json().get("success", False)


def d1_query(sql: str, params: list = None) -> list[dict]:
    if not CF_API_TOKEN:
        return []
    body = {"sql": sql}
    if params:
        body["params"] = params
    resp = requests.post(D1_API, json=body, headers={
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    })
    if resp.status_code != 200:
        return []
    data = resp.json()
    if not data.get("success"):
        return []
    results = data.get("result", [])
    if results and isinstance(results, list) and "results" in results[0]:
        return results[0]["results"]
    return []


def fetch_delisted_stocks_twse() -> list[dict]:
    """
    Fetch delisted stocks from TWSE.
    Returns list of {symbol, name, delisted_date, delist_reason, market}
    """
    delisted = []

    # TWSE listed companies suspension list
    try:
        url = "https://www.twse.com.tw/rwd/zh/company/suspendListing"
        resp = requests.get(url, params={"response": "json"}, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            for row in data.get("data", []):
                if len(row) >= 4:
                    symbol = row[0].strip()
                    name = row[1].strip()
                    date_str = row[2].strip()  # ROC date like 112/05/15
                    reason = row[3].strip() if len(row) > 3 else ""

                    # Convert ROC date to ISO
                    try:
                        parts = date_str.split("/")
                        y = int(parts[0]) + 1911
                        m = int(parts[1])
                        d = int(parts[2])
                        iso_date = f"{y:04d}-{m:02d}-{d:02d}"
                        if iso_date >= BACKFILL_START:
                            delist_reason = "violation" if "違反" in reason else \
                                           "merger" if "合併" in reason or "併" in reason else \
                                           "bankruptcy" if "破產" in reason or "重整" in reason else \
                                           "voluntary"
                            delisted.append({
                                "symbol": symbol,
                                "name": name,
                                "delisted_date": iso_date,
                                "delist_reason": delist_reason,
                                "market": "TWSE",
                            })
                    except (ValueError, IndexError):
                        pass
            print(f"[TWSE] Found {len(delisted)} delisted stocks since {BACKFILL_START}")
    except Exception as e:
        print(f"[TWSE] Fetch failed: {e}")

    # OTC (TPEx) delisted
    try:
        url = "https://www.tpex.org.tw/web/regular_emerging/deListed/de-listed_companies.php"
        resp = requests.get(url, params={"l": "zh-tw", "o": "json"}, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            for row in data.get("aaData", []):
                if len(row) >= 4:
                    symbol = row[0].strip()
                    name = row[1].strip()
                    date_str = row[3].strip()
                    try:
                        parts = date_str.split("/")
                        y = int(parts[0]) + 1911
                        m = int(parts[1])
                        d = int(parts[2])
                        iso_date = f"{y:04d}-{m:02d}-{d:02d}"
                        if iso_date >= BACKFILL_START:
                            delisted.append({
                                "symbol": symbol,
                                "name": name,
                                "delisted_date": iso_date,
                                "delist_reason": "voluntary",
                                "market": "OTC",
                            })
                    except (ValueError, IndexError):
                        pass
            print(f"[OTC] Total delisted: {len(delisted)}")
    except Exception as e:
        print(f"[OTC] Fetch failed: {e}")

    return delisted


def _parse_roc_date(roc_str: str) -> str:
    """Convert ROC date '114/04/01' to ISO '2025-04-01'."""
    parts = roc_str.strip().split("/")
    y = int(parts[0]) + 1911
    m = int(parts[1])
    d = int(parts[2])
    return f"{y:04d}-{m:02d}-{d:02d}"


def _parse_tw_num(s: str) -> float:
    """Parse comma-separated number string like '1,234,567' or '--'."""
    s = s.strip().replace(",", "").replace("--", "0").replace("X", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def fetch_stock_history_twse(symbol: str, start: str, end: str) -> list[dict]:
    """
    Fetch OHLCV from TWSE STOCK_DAY (month by month).
    Works for delisted stocks too.
    """
    results = []
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")

    current = start_dt.replace(day=1)
    while current <= end_dt:
        date_param = current.strftime("%Y%m01")
        url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date_param}&stockNo={symbol}"
        try:
            resp = requests.get(url, timeout=30, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            if resp.status_code == 200:
                data = resp.json()
                if data.get("stat") == "OK" and data.get("data"):
                    for row in data["data"]:
                        try:
                            iso_date = _parse_roc_date(row[0])
                            if iso_date < start or iso_date > end:
                                continue
                            results.append({
                                "date": iso_date,
                                "open": _parse_tw_num(row[3]),
                                "high": _parse_tw_num(row[4]),
                                "low": _parse_tw_num(row[5]),
                                "close": _parse_tw_num(row[6]),
                                "volume": int(_parse_tw_num(row[1])),  # shares
                            })
                        except (IndexError, ValueError):
                            pass
        except Exception as e:
            print(f"    [TWSE STOCK_DAY] {symbol} {date_param}: {e}")

        # Rate limit: 2 sec between requests
        time.sleep(2)
        # Next month
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)

    return results


def fetch_stock_history_tpex(symbol: str, start: str, end: str) -> list[dict]:
    """
    Fetch OHLCV from TPEX tradingStock (month by month).
    Works for delisted OTC stocks too.
    Volume returned in 張 (lots), converted to shares (x1000).
    """
    results = []
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")

    current = start_dt.replace(day=1)
    while current <= end_dt:
        date_param = current.strftime("%Y/%m/01")
        url = f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date={date_param}&code={symbol}&response=json"
        try:
            resp = requests.get(url, timeout=30, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            if resp.status_code == 200:
                data = resp.json()
                tables = data.get("tables", [])
                if tables and tables[0].get("data"):
                    for row in tables[0]["data"]:
                        try:
                            iso_date = _parse_roc_date(row[0])
                            if iso_date < start or iso_date > end:
                                continue
                            volume_lots = _parse_tw_num(row[1])
                            results.append({
                                "date": iso_date,
                                "open": _parse_tw_num(row[3]),
                                "high": _parse_tw_num(row[4]),
                                "low": _parse_tw_num(row[5]),
                                "close": _parse_tw_num(row[6]),
                                "volume": int(volume_lots * 1000),  # lots → shares
                            })
                        except (IndexError, ValueError):
                            pass
        except Exception as e:
            print(f"    [TPEX] {symbol} {date_param}: {e}")

        time.sleep(2)
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)

    return results


def fetch_stock_history(symbol: str, market: str, start: str, end: str) -> list[dict]:
    """Fetch OHLCV via TWSE or TPEX based on market."""
    if market == "OTC":
        return fetch_stock_history_tpex(symbol, start, end)
    else:
        return fetch_stock_history_twse(symbol, start, end)


def backfill_stock(stock: dict) -> int:
    """Insert delisted stock + its OHLCV history into D1. Returns rows inserted."""
    symbol = stock["symbol"]
    name = stock["name"]

    # Check if stock already exists
    existing = d1_query("SELECT id FROM stocks WHERE symbol = ?", [symbol])
    if existing:
        stock_id = existing[0]["id"]
        # Update with delisted info
        d1_exec(
            "UPDATE stocks SET delisted_date = ?, delist_reason = ?, listed_date = COALESCE(listed_date, '2020-01-01') WHERE id = ?",
            [stock["delisted_date"], stock["delist_reason"], stock_id],
        )
        print(f"  [{symbol}] Already exists (id={stock_id}), updated delist info")
    else:
        # Insert new stock
        d1_exec(
            """INSERT INTO stocks (symbol, name, market, is_active, listed_date, delisted_date, delist_reason, added_at, updated_at)
               VALUES (?, ?, ?, 0, '2020-01-01', ?, ?, datetime('now'), datetime('now'))""",
            [symbol, name, stock.get("market", "TWSE"), stock["delisted_date"], stock["delist_reason"]],
        )
        result = d1_query("SELECT id FROM stocks WHERE symbol = ?", [symbol])
        if not result:
            print(f"  [{symbol}] Insert failed")
            return 0
        stock_id = result[0]["id"]
        print(f"  [{symbol}] Inserted new stock (id={stock_id})")

    # Fetch OHLCV history from TWSE/TPEX (not FinMind)
    end_date = stock.get("delisted_date", datetime.now().strftime("%Y-%m-%d"))
    market = stock.get("market", "TWSE")
    history = fetch_stock_history(symbol, market, BACKFILL_START, end_date)
    if not history:
        print(f"  [{symbol}] No OHLCV history from {'TPEX' if market == 'OTC' else 'TWSE'}")
        return 0

    # Insert prices
    rows = 0
    for bar in history:
        ok = d1_exec(
            """INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [stock_id, bar["date"], bar.get("open"), bar.get("high"), bar.get("low"),
             bar.get("close"), bar.get("volume")],
        )
        if ok:
            rows += 1

    print(f"  [{symbol}] {rows}/{len(history)} price bars inserted")
    return rows


def main():
    print("=" * 60)
    print("StockVision: Backfill Delisted Stocks (C1 Fix)")
    print(f"Period: {BACKFILL_START} ~ present")
    print("=" * 60)

    if not CF_API_TOKEN:
        print("ERROR: CF_API_TOKEN not set")
        sys.exit(1)

    # Step 1: Fetch delisted stock list
    delisted = fetch_delisted_stocks_twse()
    print(f"\nFound {len(delisted)} delisted stocks to backfill\n")

    if not delisted:
        print("No delisted stocks found. Check API connectivity.")
        return

    # Step 2: Backfill each stock
    total_rows = 0
    for i, stock in enumerate(delisted):
        print(f"[{i+1}/{len(delisted)}] {stock['symbol']} {stock['name']} (delisted {stock['delisted_date']})")
        rows = backfill_stock(stock)
        total_rows += rows
        time.sleep(1)  # rate limit

    print(f"\n{'=' * 60}")
    print(f"Done: {len(delisted)} stocks, {total_rows} price bars backfilled")
    print("Run migration_stock_pit.sql to add listed_date/delisted_date columns")


if __name__ == "__main__":
    main()
