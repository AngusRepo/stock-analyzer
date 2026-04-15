#!/usr/bin/env python3
"""
backfill_margin_v2.py — 用 wrangler d1 execute 回補 margin_data（不依賴 CF API token）

用法：
  cd stockvision-cloudflare-v12/worker
  python ../scripts/backfill_margin_v2.py --start 2023-01-03 --end 2025-12-31
"""
import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")

def _http_get(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)

def twse_date(d): return d.replace("-", "")
def parse_tw_num(s):
    if not s or not isinstance(s, str): return 0
    return int(re.sub(r"[,\s]", "", s.strip()) or "0")
def is_stock_code(code): return bool(re.match(r"^\d{4}$", code.strip()))

# ── TWSE Margin fetch ──────────────────────────────────────────────────────

def fetch_twse_margin(date):
    url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={twse_date(date)}&selectType=ALL&response=json"
    status, text = _http_get(url, HEADERS)
    if status != 200 or not text: return []
    body = json.loads(text)
    if body.get("stat") != "OK" or not body.get("tables", [None, None])[1]: return []
    table = body["tables"][1]
    if not table.get("data"): return []
    rows = []
    for r in table["data"]:
        if not is_stock_code(r[0]): continue
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

# ── Wrangler D1 write ──────────────────────────────────────────────────────

def wrangler_d1_exec_file(sql_file_path):
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file "{sql_file_path}"',
        capture_output=True, text=True, timeout=120, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        err = result.stderr[:300] if result.stderr else ""
        if "UNIQUE constraint" not in err:
            print(f"  wrangler error: {err}")
        return False
    return True

def write_margin_batch(date, rows, stock_id_map):
    if not rows: return 0
    CHUNK = 50
    statements = []
    valid_count = 0
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i+CHUNK]
        values = []
        for r in chunk:
            sid = stock_id_map.get(r["symbol"])
            if not sid: continue
            values.append(
                f"({sid},'{date}',"
                f"{r['margin_buy']},{r['margin_sell']},{r['margin_balance']},"
                f"{r['short_buy']},{r['short_sell']},{r['short_balance']})"
            )
            valid_count += 1
        if not values: continue
        stmt = (
            "INSERT OR IGNORE INTO margin_data "
            "(stock_id, date, margin_buy, margin_sell, margin_balance, "
            "short_buy, short_sell, short_balance) "
            f"VALUES {','.join(values)};"
        )
        statements.append(stmt)

    if not statements: return 0
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(statements))
        tmp_path = f.name
    try:
        ok = wrangler_d1_exec_file(tmp_path)
        return valid_count if ok else 0
    finally:
        os.unlink(tmp_path)

# ── Helpers ────────────────────────────────────────────────────────────────

def get_existing_margin_dates():
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --command "SELECT date FROM margin_data GROUP BY date HAVING COUNT(*) >= 50"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    dates = set()
    if result.returncode == 0:
        for m in re.finditer(r'"date":\s*"(\d{4}-\d{2}-\d{2})"', result.stdout):
            dates.add(m.group(1))
    return dates

def get_trading_days(start, end):
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --command "SELECT DISTINCT date FROM stock_prices WHERE date >= \'{start}\' AND date <= \'{end}\' ORDER BY date"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    days = []
    if result.returncode == 0:
        for m in re.finditer(r'"date":\s*"(\d{4}-\d{2}-\d{2})"', result.stdout):
            days.append(m.group(1))
    return sorted(set(days))

def get_stock_id_map():
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --command "SELECT id, symbol FROM stocks"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    mapping = {}
    if result.returncode == 0:
        for m in re.finditer(r'"id":\s*(\d+),\s*"symbol":\s*"(\d+)"', result.stdout):
            mapping[m.group(2)] = int(m.group(1))
    return mapping

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2023-01-03")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--delay", type=float, default=3.5)
    args = parser.parse_args()

    print(f"[Margin Backfill v2] Range: {args.start} ~ {args.end} | Delay: {args.delay}s")
    print("Loading trading days...")
    trading_days = get_trading_days(args.start, args.end)
    print(f"Found {len(trading_days)} trading days")

    print("Loading existing margin dates...")
    existing = get_existing_margin_dates()
    todo = [d for d in trading_days if d not in existing]
    print(f"TODO: {len(todo)} days ({len(existing)} already done)")

    print("Loading stock_id map...")
    stock_id_map = get_stock_id_map()
    print(f"Loaded {len(stock_id_map)} stocks")

    if not todo:
        print("Nothing to do!")
        return

    for i, date in enumerate(todo):
        try:
            rows = fetch_twse_margin(date)
            time.sleep(args.delay)

            if not rows:
                print(f"  [{i+1}/{len(todo)}] {date}: no data, skip")
                continue

            written = write_margin_batch(date, rows, stock_id_map)
            print(f"  [{i+1}/{len(todo)}] {date}: {len(rows)} stocks -> {written} written")
        except Exception as e:
            print(f"  [{i+1}/{len(todo)}] {date}: ERROR {e}")
            time.sleep(5)

    print("\nDone!")

if __name__ == "__main__":
    main()
