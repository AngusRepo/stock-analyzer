#!/usr/bin/env python3
"""
backfill_us_market.py — 回補 us_market_signals 歷史（Yahoo Finance + FRED）

拉 2023-01-01 ~ 2026-03-24 的 VIX/SOX/GSPC/DXY/TSM 日收盤 + FRED HY OAS，
計算 return/ma5/sentiment，寫入 D1 us_market_signals。

用法：
  cd stockvision-cloudflare-v12/worker
  python -u ../scripts/backfill_us_market.py [--fred-key YOUR_KEY]
"""
import json
import math
import os
import subprocess
import sys
import ssl
import tempfile
import urllib.request
import urllib.error

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

HEADERS = {"User-Agent": "Mozilla/5.0"}
WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")

# D1 already has 2026-03-25 ~ 2026-04-10, skip those
EXISTING_START = "2026-03-25"


def _http_get(url, timeout=30):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def fetch_yahoo_history(symbol: str, start: str = "2023-01-01", end: str = "2026-03-25"):
    """Fetch daily OHLCV from Yahoo Finance chart API."""
    from datetime import datetime
    period1 = int(datetime.strptime(start, "%Y-%m-%d").timestamp())
    period2 = int(datetime.strptime(end, "%Y-%m-%d").timestamp())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={period1}&period2={period2}&interval=1d"
    )
    status, text = _http_get(url, timeout=30)
    if status != 200 or not text:
        print(f"  [Yahoo] {symbol} failed: HTTP {status}")
        return {}
    data = json.loads(text)
    result = data.get("chart", {}).get("result", [])
    if not result:
        return {}
    r = result[0]
    timestamps = r.get("timestamp", [])
    quotes = r.get("indicators", {}).get("quote", [{}])[0]
    closes = quotes.get("close", [])

    out = {}
    for i, ts in enumerate(timestamps):
        dt = datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
        c = closes[i] if i < len(closes) else None
        if c is not None and not math.isnan(c) and c > 0:
            out[dt] = c
    return out


def fetch_fred_hy_history(api_key: str, start: str = "2023-01-01", end: str = "2026-03-25"):
    """Fetch BAMLH0A0HYM2 daily from FRED API."""
    url = (
        f"https://api.stlouisfed.org/fred/series/observations"
        f"?series_id=BAMLH0A0HYM2&observation_start={start}&observation_end={end}"
        f"&file_type=json&api_key={api_key}"
    )
    status, text = _http_get(url, timeout=30)
    if status != 200 or not text:
        print(f"  [FRED] HY OAS failed: HTTP {status}")
        return {}
    data = json.loads(text)
    out = {}
    for obs in data.get("observations", []):
        if obs.get("value") != ".":
            out[obs["date"]] = float(obs["value"])
    return out


def wrangler_d1_exec_file(sql_file_path):
    result = subprocess.run(
        f'npx wrangler d1 execute stockvision-db --remote --file "{sql_file_path}"',
        capture_output=True, text=True, timeout=120, cwd=WORKER_DIR,
        shell=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        err = result.stderr[:300] if result.stderr else ""
        print(f"  wrangler error: {err}")
        return False
    return True


def sql_val(v):
    if v is None:
        return "NULL"
    return f"{v}"


def main():
    fred_key = None
    for i, arg in enumerate(sys.argv):
        if arg == "--fred-key" and i + 1 < len(sys.argv):
            fred_key = sys.argv[i + 1]
    if not fred_key:
        fred_key = os.environ.get("FRED_API_KEY")

    print("[US Market Backfill] Fetching Yahoo Finance history 2023~2026-03-24 ...")

    # Fetch all symbols in parallel-ish (sequential but fast)
    sox = fetch_yahoo_history("%5ESOX")
    print(f"  SOX: {len(sox)} days")
    tsm = fetch_yahoo_history("TSM")
    print(f"  TSM: {len(tsm)} days")
    gspc = fetch_yahoo_history("%5EGSPC")
    print(f"  GSPC: {len(gspc)} days")
    dxy = fetch_yahoo_history("DX-Y.NYB")
    print(f"  DXY: {len(dxy)} days")
    vix = fetch_yahoo_history("%5EVIX")
    print(f"  VIX: {len(vix)} days")

    hy = {}
    if fred_key:
        print("[US Market Backfill] Fetching FRED HY OAS history ...")
        hy = fetch_fred_hy_history(fred_key)
        print(f"  HY OAS: {len(hy)} days")
    else:
        print("[US Market Backfill] No FRED key, skipping HY OAS")

    # Merge all dates
    all_dates = sorted(set(sox.keys()) | set(gspc.keys()) | set(vix.keys()))
    # Filter out dates already in D1
    all_dates = [d for d in all_dates if d < EXISTING_START]
    print(f"\n[US Market Backfill] {len(all_dates)} trading days to backfill")

    if not all_dates:
        print("Nothing to do!")
        return

    # Build rows
    prev_sox = prev_gspc = prev_dxy = prev_hy = None
    statements = []
    for date in all_dates:
        sox_c = sox.get(date)
        tsm_c = tsm.get(date)
        gspc_c = gspc.get(date)
        dxy_c = dxy.get(date)
        vix_c = vix.get(date)
        hy_v = hy.get(date)

        sox_ret = (sox_c - prev_sox) / prev_sox if sox_c and prev_sox else None
        gspc_ret = (gspc_c - prev_gspc) / prev_gspc if gspc_c and prev_gspc else None
        dxy_ret = (dxy_c - prev_dxy) / prev_dxy if dxy_c and prev_dxy else None
        tsm_ret = None  # would need prev_tsm
        hy_chg = (hy_v - prev_hy) if hy_v is not None and prev_hy is not None else None

        # SOX MA5: need rolling 5d — compute from sox dict
        sox_ma5 = None
        idx = all_dates.index(date)
        if idx >= 4:
            window = [sox.get(all_dates[idx - j]) for j in range(5)]
            if all(w is not None for w in window):
                sox_ma5 = sum(window) / 5

        # Sentiment
        sentiment = "neutral"
        bull = 0
        bear = 0
        if sox_ret is not None and sox_ret > 0.01:
            bull += 1
        if gspc_ret is not None and gspc_ret > 0.005:
            bull += 1
        if vix_c is not None and vix_c < 20:
            bull += 1
        if sox_ret is not None and sox_ret < -0.02:
            bear += 1
        if gspc_ret is not None and gspc_ret < -0.01:
            bear += 1
        if vix_c is not None and vix_c > 30:
            bear += 1
        if hy_v is not None and hy_v > 5:
            bear += 1
        if bull >= 2:
            sentiment = "bullish"
        elif bear >= 2:
            sentiment = "bearish"

        stmt = (
            f"INSERT OR REPLACE INTO us_market_signals "
            f"(date, sox_close, sox_return, sox_ma5, tsm_close, tsm_return, tsm_premium, "
            f"gspc_close, gspc_return, dxy_close, dxy_return, hy_spread, hy_spread_chg, "
            f"vix_close, sentiment) VALUES ("
            f"'{date}', {sql_val(sox_c)}, {sql_val(sox_ret)}, {sql_val(sox_ma5)}, "
            f"{sql_val(tsm_c)}, {sql_val(tsm_ret)}, NULL, "
            f"{sql_val(gspc_c)}, {sql_val(gspc_ret)}, "
            f"{sql_val(dxy_c)}, {sql_val(dxy_ret)}, "
            f"{sql_val(hy_v)}, {sql_val(hy_chg)}, "
            f"{sql_val(vix_c)}, '{sentiment}');"
        )
        statements.append(stmt)

        if sox_c:
            prev_sox = sox_c
        if gspc_c:
            prev_gspc = gspc_c
        if dxy_c:
            prev_dxy = dxy_c
        if hy_v is not None:
            prev_hy = hy_v

    # Write in batches of 50
    total = 0
    batch_size = 50
    for i in range(0, len(statements), batch_size):
        batch = statements[i:i + batch_size]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False, encoding="utf-8") as f:
            f.write("\n".join(batch))
            tmp_path = f.name
        try:
            ok = wrangler_d1_exec_file(tmp_path)
            if ok:
                total += len(batch)
            if (i + batch_size) % 200 == 0 or i + batch_size >= len(statements):
                print(f"  [{min(i + batch_size, len(statements))}/{len(statements)}] written")
        finally:
            os.unlink(tmp_path)

    print(f"\nDone! {total} rows written to us_market_signals")


if __name__ == "__main__":
    main()
