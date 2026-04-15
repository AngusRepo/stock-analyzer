#!/usr/bin/env python3
"""
backfill_chips_v2.py — 用 wrangler d1 execute 回補 chip_data（不依賴 CF API token）

每天抓 TWSE T86 + TPEX 3itrade，組成 multi-row INSERT SQL，
透過 wrangler d1 execute --remote 寫入 D1。

用法：
  cd stockvision-cloudflare-v12/worker
  python ../scripts/backfill_chips_v2.py --start 2023-01-03 --end 2025-12-31
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

# ── HTTP helpers ────────────────────────────────────────────────────────────

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
def roc_date(d):
    from datetime import datetime
    dt = datetime.strptime(d, "%Y-%m-%d")
    return f"{dt.year - 1911}/{dt.month:02d}/{dt.day:02d}"

def parse_tw_num(s):
    if not s or not isinstance(s, str): return 0
    return int(re.sub(r"[,\s]", "", s.strip()) or "0")

def is_stock_code(code): return bool(re.match(r"^\d{4}$", code.strip()))

# ── TWSE/TPEX fetch ────────────────────────────────────────────────────────

def fetch_twse_chips(date):
    url = f"https://www.twse.com.tw/rwd/zh/fund/T86?date={twse_date(date)}&selectType=ALL&response=json"
    status, text = _http_get(url, HEADERS)
    if status != 200 or not text: return []
    body = json.loads(text)
    if body.get("stat") != "OK" or not body.get("data"): return []
    rows = []
    for r in body["data"]:
        if not is_stock_code(r[0]): continue
        rows.append({
            "symbol": r[0].strip(),
            "foreign_buy": parse_tw_num(r[2]), "foreign_sell": parse_tw_num(r[3]), "foreign_net": parse_tw_num(r[4]),
            "trust_buy": parse_tw_num(r[8]), "trust_sell": parse_tw_num(r[9]), "trust_net": parse_tw_num(r[10]),
            "dealer_buy": parse_tw_num(r[12]), "dealer_sell": parse_tw_num(r[13]), "dealer_net": parse_tw_num(r[11]),
        })
    return rows

def fetch_tpex_chips(date):
    url = f"https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d={roc_date(date)}&t=D&o=json"
    try:
        status, text = _http_get(url, HEADERS)
        if status != 200 or not text: return []
        if text.startswith("<!DOCTYPE") or text.startswith("<html"): return []
        body = json.loads(text)
        if body.get("stat") != "ok" or not body.get("tables", [{}])[0].get("data"): return []
        rows = []
        for r in body["tables"][0]["data"]:
            if not is_stock_code(r[0]): continue
            rows.append({
                "symbol": r[0].strip(),
                "foreign_buy": parse_tw_num(r[2]), "foreign_sell": parse_tw_num(r[3]), "foreign_net": parse_tw_num(r[4]),
                "trust_buy": parse_tw_num(r[8]), "trust_sell": parse_tw_num(r[9]), "trust_net": parse_tw_num(r[10]),
                "dealer_buy": parse_tw_num(r[12]), "dealer_sell": parse_tw_num(r[13]), "dealer_net": parse_tw_num(r[11]),
            })
        return rows
    except Exception as e:
        print(f"  TPEX error: {e}")
        return []

# ── Wrangler D1 write ──────────────────────────────────────────────────────

def escape_sql_str(s):
    return s.replace("'", "''")

def wrangler_d1_exec_file(sql_file_path):
    """Execute a SQL file via wrangler d1 execute --remote --file."""
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file "{sql_file_path}"',
        capture_output=True, text=True, timeout=120, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        err = result.stderr[:300] if result.stderr else ""
        if "UNIQUE constraint" not in err and "already exists" not in err:
            print(f"  wrangler error: {err}")
        return False
    return True

def write_chips_batch(date, rows):
    """Write chip rows for one date using a temp SQL file."""
    if not rows: return 0
    # Build multi-row INSERT — wrangler doesn't have param limit like REST API
    # Split into chunks of 50 rows per INSERT to avoid SQL too long
    CHUNK = 50
    statements = []
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i+CHUNK]
        values = []
        for r in chunk:
            values.append(
                f"('{escape_sql_str(r['symbol'])}','{date}',"
                f"{r['foreign_buy']},{r['foreign_sell']},{r['foreign_net']},"
                f"{r['trust_buy']},{r['trust_sell']},{r['trust_net']},"
                f"{r['dealer_buy']},{r['dealer_sell']},{r['dealer_net']})"
            )
        stmt = (
            "INSERT OR IGNORE INTO chip_data "
            "(symbol, date, foreign_buy, foreign_sell, foreign_net, "
            "trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell, dealer_net) "
            f"VALUES {','.join(values)};"
        )
        statements.append(stmt)

    # Write to temp file and execute
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(statements))
        tmp_path = f.name

    try:
        ok = wrangler_d1_exec_file(tmp_path)
        return len(rows) if ok else 0
    finally:
        os.unlink(tmp_path)

# ── Get existing dates ─────────────────────────────────────────────────────

def get_existing_chip_dates():
    """Get dates already in chip_data with decent coverage."""
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --command "SELECT date FROM chip_data GROUP BY date HAVING COUNT(*) >= 100"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    dates = set()
    if result.returncode == 0:
        for m in re.finditer(r'"date":\s*"(\d{4}-\d{2}-\d{2})"', result.stdout):
            dates.add(m.group(1))
    return dates

def get_trading_days(start, end):
    """Get trading days from D1 stock_prices."""
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --command "SELECT DISTINCT date FROM stock_prices WHERE date >= \'{start}\' AND date <= \'{end}\' ORDER BY date"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR, shell=True, encoding="utf-8", errors="replace",
    )
    days = []
    if result.returncode == 0:
        for m in re.finditer(r'"date":\s*"(\d{4}-\d{2}-\d{2})"', result.stdout):
            days.append(m.group(1))
    return sorted(set(days))

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2023-01-03")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--delay", type=float, default=3.5)
    args = parser.parse_args()

    print(f"[Chips Backfill v2] Range: {args.start} ~ {args.end} | Delay: {args.delay}s")
    print("Loading trading days...")
    trading_days = get_trading_days(args.start, args.end)
    print(f"Found {len(trading_days)} trading days")

    print("Loading existing chip dates...")
    existing = get_existing_chip_dates()
    todo = [d for d in trading_days if d not in existing]
    print(f"TODO: {len(todo)} days ({len(existing)} already done)")

    if not todo:
        print("Nothing to do!")
        return

    for i, date in enumerate(todo):
        try:
            twse = fetch_twse_chips(date)
            time.sleep(args.delay)
            tpex = fetch_tpex_chips(date)
            time.sleep(args.delay)

            all_rows = twse + tpex
            if not all_rows:
                print(f"  [{i+1}/{len(todo)}] {date}: no data (holiday?), skip")
                continue

            if len(all_rows) < 100:
                print(f"  [{i+1}/{len(todo)}] {date}: only {len(all_rows)} rows (suspect), skip")
                continue

            written = write_chips_batch(date, all_rows)
            print(f"  [{i+1}/{len(todo)}] {date}: TWSE={len(twse)} TPEX={len(tpex)} -> {written} written")
        except Exception as e:
            print(f"  [{i+1}/{len(todo)}] {date}: ERROR {e}")
            time.sleep(5)

    print("\nDone!")

if __name__ == "__main__":
    main()
