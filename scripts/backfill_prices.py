"""
backfill_prices.py — yfinance 歷史股價批量補齊到 D1 (via REST API)

Usage:
  cd stockvision-cloudflare-v12
  python scripts/backfill_prices.py
"""

import json
import sys
import time
import os
import subprocess

try:
    import yfinance as yf
except ImportError:
    print("ERROR: pip install yfinance")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: pip install requests")
    sys.exit(1)

# ─── Config ──────────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
D1_DB_ID = os.environ.get("CF_D1_DB_ID", "").strip()
BATCH_SIZE = 20       # yfinance download batch
PERIOD = "1y"

def get_cf_token():
    """Get CF API token from wrangler config."""
    # Try env var first
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if token and CF_ACCOUNT_ID and D1_DB_ID:
        return token
    # Try wrangler whoami to check auth
    result = subprocess.run("npx wrangler whoami", shell=True, capture_output=True, text=True,
                          cwd="worker", encoding='utf-8', errors='replace')
    if "You are logged in" not in result.stdout and "Account ID" not in result.stdout:
        print("ERROR: Not logged in to wrangler. Run: npx wrangler login")
        sys.exit(1)
    # Use wrangler for D1 queries (slower but works without explicit token)
    return None

def d1_query(sql, token=None):
    """Query D1 via REST API or wrangler fallback."""
    if token:
        url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DB_ID}/query"
        resp = requests.post(url, headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }, json={"sql": sql})
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("result", [{}])[0].get("results", [])
        print(f"D1 API error: {resp.status_code} {resp.text[:200]}")
        return []
    else:
        # Wrangler fallback
        cmd = f'npx wrangler d1 execute stockvision-db --remote --json --command "{sql}"'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              cwd="worker", encoding='utf-8', errors='replace')
        try:
            data = json.loads(result.stdout)
            return data[0].get("results", []) if data else []
        except:
            return []

def d1_batch_sql(statements, token):
    """Execute batch SQL via D1 REST API."""
    if not (token and CF_ACCOUNT_ID and D1_DB_ID):
        # Wrangler fallback: write to file
        tmpfile = "/tmp/backfill_batch.sql"
        with open(tmpfile, "w", encoding='utf-8') as f:
            f.write("\n".join(statements))
        cmd = f'npx wrangler d1 execute stockvision-db --remote --file={tmpfile}'
        subprocess.run(cmd, shell=True, capture_output=True, text=True,
                      cwd="worker", encoding='utf-8', errors='replace')
        return

    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DB_ID}/query"
    # D1 REST API accepts multiple statements
    for i in range(0, len(statements), 50):
        chunk = statements[i:i+50]
        combined = "\n".join(chunk)
        resp = requests.post(url, headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }, json={"sql": combined})
        if resp.status_code != 200:
            print(f"  D1 batch error: {resp.status_code}")

def main():
    print("=== StockVision yfinance Backfill ===\n")

    token = get_cf_token()
    if token and CF_ACCOUNT_ID and D1_DB_ID:
        print(f"Using CF API token (direct REST)")
    else:
        print("Using wrangler fallback (slower)")

    # 1. Get stocks
    print("[1/3] Reading stocks from D1...")
    stocks = d1_query("SELECT id, symbol, market FROM stocks ORDER BY id", token)
    if not stocks:
        print("ERROR: No stocks")
        return
    print(f"  Found {len(stocks)} stocks")

    # 2. Build yfinance symbol map
    symbols_map = {}
    for s in stocks:
        sym = s["symbol"]
        if not sym[0].isdigit():
            continue
        market = s.get("market", "TWSE")
        yf_sym = f"{sym}.TWO" if market in ("OTC", "TPEX") else f"{sym}.TW"
        symbols_map[yf_sym] = (s["id"], sym)

    yf_symbols = list(symbols_map.keys())
    print(f"  {len(yf_symbols)} TW stocks to backfill\n")

    # 3. Batch download + write
    total_written = 0
    total_failed = 0

    for i in range(0, len(yf_symbols), BATCH_SIZE):
        batch_syms = yf_symbols[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(yf_symbols) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"[2/3] Batch {batch_num}/{total_batches} ({len(batch_syms)} stocks)...", end=" ", flush=True)

        try:
            data = yf.download(batch_syms, period=PERIOD, group_by="ticker", threads=True, progress=False)
        except Exception as e:
            print(f"DOWNLOAD FAIL: {e}")
            total_failed += len(batch_syms)
            continue

        sql_stmts = []
        batch_rows = 0
        for yf_sym in batch_syms:
            stock_id, db_sym = symbols_map[yf_sym]
            try:
                df = data[yf_sym] if len(batch_syms) > 1 else data
                if df is None or df.empty:
                    total_failed += 1
                    continue
                for idx, row in df.iterrows():
                    date = idx.strftime("%Y-%m-%d")
                    o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
                    if c is None or str(c) == "nan":
                        continue
                    # Escape single quotes in case
                    sql_stmts.append(
                        f"INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, adj_close, volume) "
                        f"VALUES ({stock_id}, '{date}', {float(o):.2f}, {float(h):.2f}, {float(l):.2f}, {float(c):.2f}, {float(c):.2f}, {int(v or 0)});"
                    )
                    batch_rows += 1
            except:
                total_failed += 1

        if sql_stmts:
            d1_batch_sql(sql_stmts, token)
            total_written += batch_rows
            print(f"{batch_rows} rows written")
        else:
            print("no data")

        time.sleep(0.5)

    print(f"\n[3/3] === Summary ===")
    print(f"  Total written: {total_written} rows")
    print(f"  Failed: {total_failed}")

if __name__ == "__main__":
    main()
