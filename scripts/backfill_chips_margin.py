#!/usr/bin/env python3
"""
backfill_chips_margin.py — 回補 chip_data + margin_data 歷史（2023-01 ~ 2025-12）

資料來源：
  - chip_data:   TWSE T86 (上市三大法人) + TPEX 3itrade (上櫃三大法人)
  - margin_data: TWSE MI_MARGN (上市融資融券) + TPEX openapi (上櫃融資融券)

用法：
  python scripts/backfill_chips_margin.py --start 2023-01-03 --end 2025-12-31 --mode chips
  python scripts/backfill_chips_margin.py --start 2023-01-03 --end 2025-12-31 --mode margin
  python scripts/backfill_chips_margin.py --start 2023-01-03 --end 2025-12-31 --mode both

Rate limit: TWSE ~3s/req, TPEX ~2s/req. 預估每天 2 req × 3s = 6s，750 天 = ~75 min per mode.
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta

# TWSE SSL cert has missing Subject Key Identifier — Python 3.14 strict mode rejects it
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

# ── D1 REST API ──────────────────────────────────────────────────────────────

D1_API_URL = os.environ.get("D1_API_URL", "")
D1_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
D1_DB_ID = os.environ.get("CF_D1_DB_ID", os.environ.get("D1_DB_ID", "")).strip()
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")

def d1_url():
    if D1_API_URL:
        return D1_API_URL
    if not (D1_ACCOUNT_ID and D1_DB_ID):
        return ""
    return f"https://api.cloudflare.com/client/v4/accounts/{D1_ACCOUNT_ID}/d1/database/{D1_DB_ID}/query"

def _http_get(url: str, headers: dict = None, timeout: int = 30) -> tuple[int, str]:
    """Simple HTTP GET using urllib."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)

def _http_post_json(url: str, body: dict, headers: dict = None, timeout: int = 30) -> tuple[int, str]:
    """Simple HTTP POST JSON using urllib."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8") if hasattr(e, "read") else ""
    except Exception as e:
        return 0, str(e)

def d1_exec(sql: str, params: list = None):
    """Execute SQL on D1."""
    if not CF_API_TOKEN:
        print("  D1 error: CF_API_TOKEN not set")
        return None
    url = d1_url()
    if not url:
        print("  D1 error: missing CF_ACCOUNT_ID/CF_D1_DB_ID (or set D1_API_URL)")
        return None
    body = {"sql": sql}
    if params:
        body["params"] = params
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    status, text = _http_post_json(url, body, headers)
    if status != 200:
        print(f"  D1 error: {status} {text[:200]}")
        return None
    data = json.loads(text)
    if isinstance(data, list):
        return data[0].get("results", [])
    return data.get("result", [{}])[0].get("results", [])

# ── TWSE/TPEX API ───────────────────────────────────────────────────────────

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

def twse_date(d: str) -> str:
    """'2024-01-15' → '20240115'"""
    return d.replace("-", "")

def roc_date(d: str) -> str:
    """'2024-01-15' → '113/01/15'"""
    dt = datetime.strptime(d, "%Y-%m-%d")
    return f"{dt.year - 1911}/{dt.month:02d}/{dt.day:02d}"

def parse_tw_num(s: str) -> int:
    """Parse TWSE number format: '1,234,567' → 1234567"""
    if not s or not isinstance(s, str):
        return 0
    return int(re.sub(r"[,\s]", "", s.strip()) or "0")

def is_stock_code(code: str) -> bool:
    """4-digit stock code."""
    return bool(re.match(r"^\d{4}$", code.strip()))

def fetch_twse_chips(date: str) -> list[dict]:
    """TWSE T86: 上市三大法人買賣超."""
    url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={twse_date(date)}&selectType=ALL&response=json"
    status, text = _http_get(url, HEADERS)
    if status != 200 or not text:
        return []
    body = json.loads(text)
    if body.get("stat") != "OK" or not body.get("data"):
        return []
    rows = []
    for r in body["data"]:
        if not is_stock_code(r[0]):
            continue
        rows.append({
            "symbol": r[0].strip(),
            "foreign_buy": parse_tw_num(r[2]),
            "foreign_sell": parse_tw_num(r[3]),
            "foreign_net": parse_tw_num(r[4]),
            "trust_buy": parse_tw_num(r[8]),
            "trust_sell": parse_tw_num(r[9]),
            "trust_net": parse_tw_num(r[10]),
            "dealer_buy": parse_tw_num(r[12]),
            "dealer_sell": parse_tw_num(r[13]),
            "dealer_net": parse_tw_num(r[11]),
        })
    return rows

def fetch_tpex_chips(date: str) -> list[dict]:
    """TPEX 3itrade: 上櫃三大法人買賣超."""
    url = f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d={roc_date(date)}&t=D&o=json"
    try:
        status, text = _http_get(url, HEADERS)
        if status != 200 or not text:
            return []
        if text.startswith("<!DOCTYPE") or text.startswith("<html"):
            return []
        body = json.loads(text)
        if body.get("stat") != "ok" or not body.get("tables", [{}])[0].get("data"):
            return []
        rows = []
        for r in body["tables"][0]["data"]:
            if not is_stock_code(r[0]):
                continue
            rows.append({
                "symbol": r[0].strip(),
                "foreign_buy": parse_tw_num(r[2]),
                "foreign_sell": parse_tw_num(r[3]),
                "foreign_net": parse_tw_num(r[4]),
                "trust_buy": parse_tw_num(r[8]),
                "trust_sell": parse_tw_num(r[9]),
                "trust_net": parse_tw_num(r[10]),
                "dealer_buy": parse_tw_num(r[12]),
                "dealer_sell": parse_tw_num(r[13]),
                "dealer_net": parse_tw_num(r[11]),
            })
        return rows
    except Exception as e:
        print(f"  TPEX chips error: {e}")
        return []

def fetch_twse_margin(date: str) -> list[dict]:
    """TWSE MI_MARGN: 上市融資融券."""
    url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={twse_date(date)}&selectType=ALL&response=json"
    status, text = _http_get(url, HEADERS)
    if status != 200 or not text:
        return []
    body = json.loads(text)
    if body.get("stat") != "OK" or not body.get("tables", [None, None])[1]:
        return []
    table = body["tables"][1]
    if not table.get("data"):
        return []
    rows = []
    for r in table["data"]:
        if not is_stock_code(r[0]):
            continue
        rows.append({
            "symbol": r[0].strip(),
            "margin_buy": parse_tw_num(r[2]),
            "margin_sell": parse_tw_num(r[3]),
            "margin_balance": parse_tw_num(r[6]),
            "short_buy": parse_tw_num(r[8]),
            "short_sell": parse_tw_num(r[9]),
            "short_balance": parse_tw_num(r[12]),
        })
    return rows

# ── D1 Write ────────────────────────────────────────────────────────────────

def write_chips_to_d1(date: str, rows: list[dict]):
    """Batch write chip_data rows."""
    if not rows:
        return 0
    # D1 batch limit ~100 params, each row has 11 params → batch 8 rows (88 params)
    BATCH = 8
    written = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        values_parts = []
        params = []
        for r in batch:
            values_parts.append("(?,?,?,?,?,?,?,?,?,?,?)")
            params.extend([
                r["symbol"], date,
                r["foreign_buy"], r["foreign_sell"], r["foreign_net"],
                r["trust_buy"], r["trust_sell"], r["trust_net"],
                r["dealer_buy"], r["dealer_sell"], r["dealer_net"],
            ])
        sql = (
            "INSERT OR IGNORE INTO chip_data "
            "(symbol, date, foreign_buy, foreign_sell, foreign_net, "
            " trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell, dealer_net) "
            f"VALUES {','.join(values_parts)}"
        )
        d1_exec(sql, params)
        written += len(batch)
    return written

def write_margin_to_d1(date: str, rows: list[dict], stock_id_map: dict):
    """Batch write margin_data rows."""
    if not rows:
        return 0
    # D1 batch limit ~100 params, each row has 8 params → batch 12 rows (96 params)
    BATCH = 12
    written = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        values_parts = []
        params = []
        for r in batch:
            sid = stock_id_map.get(r["symbol"])
            if not sid:
                continue
            values_parts.append("(?,?,?,?,?,?,?,?)")
            params.extend([
                sid, date,
                r["margin_buy"], r["margin_sell"], r["margin_balance"],
                r["short_buy"], r["short_sell"], r["short_balance"],
            ])
        if not values_parts:
            continue
        sql = (
            "INSERT OR IGNORE INTO margin_data "
            "(stock_id, date, margin_buy, margin_sell, margin_balance, "
            " short_buy, short_sell, short_balance) "
            f"VALUES {','.join(values_parts)}"
        )
        d1_exec(sql, params)
        written += len(batch)
    return written

# ── Trading Days ─────────────────────────────────────────────────────────────

def get_trading_days_from_d1(start: str, end: str) -> list[str]:
    """Get actual trading days from D1 stock_prices (most reliable source)."""
    rows = d1_exec(
        "SELECT DISTINCT date FROM stock_prices WHERE date >= ? AND date <= ? ORDER BY date",
        [start, end],
    )
    return [r["date"] for r in (rows or [])]

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Backfill chip_data + margin_data from TWSE/TPEX")
    parser.add_argument("--start", default="2023-01-03", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", default="2025-12-25", help="End date (YYYY-MM-DD)")
    parser.add_argument("--mode", choices=["chips", "margin", "both"], default="both")
    parser.add_argument("--delay", type=float, default=3.5, help="Seconds between requests")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to D1")
    args = parser.parse_args()

    if not CF_API_TOKEN:
        token_from_file = ""
        try:
            import subprocess
            result = subprocess.run(
                ["npx", "wrangler", "d1", "info", "stockvision-db"],
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            pass
        if not token_from_file:
            print("ERROR: Set CF_API_TOKEN environment variable")
            print("  export CF_API_TOKEN=cfut_...")
            sys.exit(1)

    print(f"Mode: {args.mode} | Range: {args.start} ~ {args.end} | Delay: {args.delay}s")

    # Get trading days
    print("Loading trading days from D1...")
    trading_days = get_trading_days_from_d1(args.start, args.end)
    print(f"Found {len(trading_days)} trading days")

    if not trading_days:
        print("No trading days found. Check D1 connection.")
        sys.exit(1)

    # Get existing dates to skip
    if args.mode in ("chips", "both"):
        existing_chip_dates = set()
        rows = d1_exec("SELECT DISTINCT date FROM chip_data WHERE date >= ? AND date <= ?", [args.start, args.end])
        if rows:
            existing_chip_dates = {r["date"] for r in rows}
        chip_todo = [d for d in trading_days if d not in existing_chip_dates]
        print(f"Chips: {len(chip_todo)} days to backfill ({len(existing_chip_dates)} already exist)")

    if args.mode in ("margin", "both"):
        existing_margin_dates = set()
        rows = d1_exec("SELECT DISTINCT date FROM margin_data WHERE date >= ? AND date <= ?", [args.start, args.end])
        if rows:
            existing_margin_dates = {r["date"] for r in rows}
        margin_todo = [d for d in trading_days if d not in existing_margin_dates]
        print(f"Margin: {len(margin_todo)} days to backfill ({len(existing_margin_dates)} already exist)")

        # Load stock_id map for margin_data (needs stock_id not symbol)
        print("Loading stock_id map...")
        stock_rows = d1_exec("SELECT id, symbol FROM stocks")
        stock_id_map = {r["symbol"]: r["id"] for r in (stock_rows or [])}
        print(f"Loaded {len(stock_id_map)} stock mappings")

    # ── Backfill chips ───────────────────────────────────────────────────────
    if args.mode in ("chips", "both"):
        print(f"\n{'='*60}")
        print(f"CHIP DATA BACKFILL: {len(chip_todo)} days")
        print(f"{'='*60}")

        for i, date in enumerate(chip_todo):
            try:
                twse = fetch_twse_chips(date)
                time.sleep(args.delay)
                tpex = fetch_tpex_chips(date)
                time.sleep(args.delay)

                all_chips = twse + tpex
                if not all_chips:
                    print(f"  [{i+1}/{len(chip_todo)}] {date}: no data (holiday?)")
                    continue

                if not args.dry_run:
                    written = write_chips_to_d1(date, all_chips)
                else:
                    written = len(all_chips)

                print(f"  [{i+1}/{len(chip_todo)}] {date}: TWSE={len(twse)} TPEX={len(tpex)} → {written} written")
            except Exception as e:
                print(f"  [{i+1}/{len(chip_todo)}] {date}: ERROR {e}")
                time.sleep(5)  # extra delay on error

    # ── Backfill margin ──────────────────────────────────────────────────────
    if args.mode in ("margin", "both"):
        print(f"\n{'='*60}")
        print(f"MARGIN DATA BACKFILL: {len(margin_todo)} days")
        print(f"{'='*60}")

        for i, date in enumerate(margin_todo):
            try:
                twse_margin = fetch_twse_margin(date)
                time.sleep(args.delay)
                # TPEX margin API only returns latest day, can't backfill historically
                # Skip TPEX margin for backfill

                if not twse_margin:
                    print(f"  [{i+1}/{len(margin_todo)}] {date}: no data (holiday?)")
                    continue

                if not args.dry_run:
                    written = write_margin_to_d1(date, twse_margin, stock_id_map)
                else:
                    written = len(twse_margin)

                print(f"  [{i+1}/{len(margin_todo)}] {date}: {len(twse_margin)} stocks → {written} written")
            except Exception as e:
                print(f"  [{i+1}/{len(margin_todo)}] {date}: ERROR {e}")
                time.sleep(5)

    print("\nDone!")


if __name__ == "__main__":
    main()
