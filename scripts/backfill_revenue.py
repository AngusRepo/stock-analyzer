#!/usr/bin/env python3
"""
backfill_revenue.py — 回補 monthly_revenue 3 年歷史（FinMind API）

每 stock 拉 2022-01 ~ 2026-03 月營收，計算 YoY + MoM，寫入 D1。
需要 2022 年資料是因為 2023-01 的 YoY 需要 2022-01 作為分母。

用法：
  cd stockvision-cloudflare-v12/worker
  python -u ../scripts/backfill_revenue.py
"""
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

HEADERS = {"User-Agent": "Mozilla/5.0"}
WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")

def _http_get(url, timeout=15):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)

def wrangler_d1_exec_file(sql_file_path):
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file "{sql_file_path}"',
        capture_output=True, text=True, timeout=120, cwd=WORKER_DIR,
        shell=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        err = result.stderr[:300] if result.stderr else ""
        if "UNIQUE constraint" not in err:
            print(f"  wrangler error: {err}")
        return False
    return True

def get_stock_list():
    """Get all stock symbols + ids from D1."""
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --command "SELECT id, symbol FROM stocks WHERE delisted_date IS NULL ORDER BY symbol"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR,
        shell=True, encoding="utf-8", errors="replace",
    )
    stocks = []
    if result.returncode == 0 and result.stdout:
        for m in re.finditer(r'"id":\s*(\d+),\s*"symbol":\s*"(\w+)"', result.stdout):
            stocks.append((int(m.group(1)), m.group(2)))
    return stocks

def get_existing_revenue_stocks():
    """Get stock_ids that already have >= 24 months of revenue data."""
    result = subprocess.run(
        'npx wrangler d1 execute stockvision-db --remote --command "SELECT stock_id, COUNT(*) as cnt FROM monthly_revenue GROUP BY stock_id HAVING cnt >= 24"',
        capture_output=True, text=True, timeout=60, cwd=WORKER_DIR,
        shell=True, encoding="utf-8", errors="replace",
    )
    done = set()
    if result.returncode == 0 and result.stdout:
        for m in re.finditer(r'"stock_id":\s*(\d+)', result.stdout):
            done.add(int(m.group(1)))
    return done

def fetch_revenue(symbol, start="2022-01-01", end="2026-03-31"):
    """Fetch monthly revenue from FinMind API."""
    url = f"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id={symbol}&start_date={start}&end_date={end}"
    status, text = _http_get(url, timeout=15)
    if status != 200 or not text:
        return []
    body = json.loads(text)
    if body.get("status") != 200 or not body.get("data"):
        return []
    return body["data"]

def compute_yoy_mom(rows):
    """Compute YoY and MoM from FinMind revenue data.

    FinMind returns: date (公告日), stock_id, revenue, revenue_month, revenue_year
    revenue_month/revenue_year = 實際營收月份（不是公告日）
    """
    # Build month→revenue map
    monthly = {}
    for r in rows:
        ym = f"{r['revenue_year']:04d}-{r['revenue_month']:02d}"
        monthly[ym] = r["revenue"]

    results = []
    for ym, rev in sorted(monthly.items()):
        year, month = ym.split("-")
        prev_year_ym = f"{int(year) - 1}-{month}"
        prev_month = int(month) - 1
        if prev_month == 0:
            prev_month = 12
            prev_month_ym = f"{int(year) - 1}-12"
        else:
            prev_month_ym = f"{year}-{prev_month:02d}"

        yoy = None
        if prev_year_ym in monthly and monthly[prev_year_ym] > 0:
            yoy = (rev - monthly[prev_year_ym]) / monthly[prev_year_ym] * 100

        mom = None
        if prev_month_ym in monthly and monthly[prev_month_ym] > 0:
            mom = (rev - monthly[prev_month_ym]) / monthly[prev_month_ym] * 100

        # Only include 2023-01 onwards (2022 is just for YoY reference)
        if ym >= "2023-01":
            results.append({
                "date": ym,
                "revenue": rev,
                "revenue_yoy": yoy,
                "revenue_mom": mom,
            })
    return results

def write_revenue_batch(stock_id, rows):
    """Write revenue rows for one stock."""
    if not rows:
        return 0
    statements = []
    for r in rows:
        yoy = f"{r['revenue_yoy']:.6f}" if r["revenue_yoy"] is not None else "NULL"
        mom = f"{r['revenue_mom']:.6f}" if r["revenue_mom"] is not None else "NULL"
        stmt = (
            f"INSERT OR REPLACE INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom) "
            f"VALUES ({stock_id}, '{r['date']}', {r['revenue']}, {yoy}, {mom});"
        )
        statements.append(stmt)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(statements))
        tmp_path = f.name
    try:
        ok = wrangler_d1_exec_file(tmp_path)
        return len(rows) if ok else 0
    finally:
        os.unlink(tmp_path)

def main():
    print("[Revenue Backfill] Loading stock list...")
    stocks = get_stock_list()
    print(f"Found {len(stocks)} active stocks")

    print("Checking existing revenue data...")
    done = get_existing_revenue_stocks()
    todo = [(sid, sym) for sid, sym in stocks if sid not in done]
    print(f"TODO: {len(todo)} stocks ({len(done)} already have >= 24 months)")

    if not todo:
        print("Nothing to do!")
        return

    total_written = 0
    errors = 0
    for i, (stock_id, symbol) in enumerate(todo):
        try:
            raw = fetch_revenue(symbol)
            time.sleep(0.6)  # FinMind rate limit

            if not raw:
                if (i + 1) % 100 == 0:
                    print(f"  [{i+1}/{len(todo)}] {symbol}: no data")
                continue

            rows = compute_yoy_mom(raw)
            if not rows:
                continue

            written = write_revenue_batch(stock_id, rows)
            total_written += written

            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(todo)}] {symbol}: {written} months written (total: {total_written})")
        except Exception as e:
            errors += 1
            print(f"  [{i+1}/{len(todo)}] {symbol}: ERROR {e}")
            if "rate limit" in str(e).lower() or "429" in str(e):
                print("  Rate limited! Waiting 60s...")
                time.sleep(60)
            else:
                time.sleep(2)

    print(f"\nDone! Total: {total_written} rows written, {errors} errors")

if __name__ == "__main__":
    main()
