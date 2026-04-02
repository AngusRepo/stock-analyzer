"""
fetch_taifex_history.py — TAIFEX 台指期歷史夜盤資料收集

從期交所 opendata 下載每日期貨行情，提取夜盤（盤後交易）收盤資料。
輸出 CSV 供 ML training 用（合併到 features.py 的 night_session 欄位）。

Usage:
    python scripts/fetch_taifex_history.py --start 2025-01-01 --end 2026-03-30 --output taifex_night.csv

資料來源：
    TAIFEX 每日行情：https://www.taifex.com.tw/cht/3/futDataDown
    或 MIS API（只有當日，不適合歷史）

策略：
    1. 爬 TAIFEX 每日期貨行情表（CSV 下載）
    2. 篩選 TX（台指期近月）盤後交易時段
    3. 提取 close / high / low / settlement / volume
    4. 計算 change_pct = (close - prev_settlement) / prev_settlement
    5. 輸出：date, close, settlement, change_pct, range_pct, volume

注意事項：
    - TAIFEX 每日行情包含「一般交易」和「盤後交易」兩段
    - 我們只要「盤後交易」（= 夜盤 15:00~05:00）
    - 夜盤的日期標記是 T 日（15:00 開始），但影響的是 T+1 開盤
    - 所以 label_date = session_date + 1 trading day
"""
import argparse
import csv
import io
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests


def fetch_taifex_daily(date_str: str) -> list[dict]:
    """
    從 TAIFEX 下載指定日期的期貨每日行情
    date_str: "2026/03/30" format
    """
    url = "https://www.taifex.com.tw/cht/3/futDataDown"
    # TAIFEX 用民國年
    parts = date_str.split("/")
    roc_year = int(parts[0]) - 1911
    roc_date = f"{roc_year}/{parts[1]}/{parts[2]}"

    params = {
        "down_type": "1",  # 1=每日行情
        "queryStartDate": roc_date,
        "queryEndDate": roc_date,
        "commodity_id": "TX",  # 台指期
    }

    try:
        resp = requests.get(url, params=params, timeout=30,
                          headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code != 200:
            return []

        # TAIFEX 回傳 CSV（Big5 編碼）
        text = resp.content.decode("big5", errors="replace")
        lines = text.strip().split("\n")

        results = []
        for line in lines[1:]:  # skip header
            cols = line.split(",")
            if len(cols) < 10:
                continue
            # 欄位：交易日期, 契約, 到期月份, 開盤價, 最高價, 最低價, 收盤價, 結算價, 成交量, ...
            # 最後一欄有交易時段標記
            row = {
                "date": cols[0].strip(),
                "contract": cols[1].strip(),
                "month": cols[2].strip(),
                "open": cols[3].strip(),
                "high": cols[4].strip(),
                "low": cols[5].strip(),
                "close": cols[6].strip(),
                "settlement": cols[7].strip() if len(cols) > 7 else "",
                "volume": cols[8].strip() if len(cols) > 8 else "",
                "session": cols[-1].strip() if len(cols) > 10 else "",
            }
            results.append(row)
        return results
    except Exception as e:
        print(f"  Error fetching {date_str}: {e}")
        return []


def main():
    parser = argparse.ArgumentParser(description="Fetch TAIFEX night session history")
    parser.add_argument("--start", default="2025-06-01", help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default="2026-03-30", help="End date YYYY-MM-DD")
    parser.add_argument("--output", default="taifex_night.csv", help="Output CSV path")
    args = parser.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d")
    end = datetime.strptime(args.end, "%Y-%m-%d")

    print(f"Fetching TAIFEX TX night session: {args.start} ~ {args.end}")

    all_rows = []
    prev_settlement = None
    current = start

    while current <= end:
        # Skip weekends
        if current.weekday() >= 5:
            current += timedelta(days=1)
            continue

        date_str = current.strftime("%Y/%m/%d")
        print(f"  {date_str}...", end=" ", flush=True)

        rows = fetch_taifex_daily(date_str)
        # 找盤後交易的近月合約
        night_rows = [r for r in rows if "盤後" in r.get("session", "") or "一般" not in r.get("session", "")]

        if not night_rows:
            # fallback: 用全部資料（有些日期格式可能不同）
            night_rows = [r for r in rows if r.get("contract", "").strip() == "TX"]

        if night_rows:
            # 取近月（成交量最大的）
            best = max(night_rows, key=lambda r: int(r.get("volume", "0").replace(",", "") or "0"))
            close = float(best["close"].replace(",", "")) if best["close"] else None
            high = float(best["high"].replace(",", "")) if best["high"] else None
            low = float(best["low"].replace(",", "")) if best["low"] else None
            settlement = float(best["settlement"].replace(",", "")) if best["settlement"] else None

            if close and prev_settlement and prev_settlement > 0:
                change_pct = (close - prev_settlement) / prev_settlement * 100
                range_pct = ((high - low) / prev_settlement * 100) if high and low else 0
            else:
                change_pct = 0
                range_pct = 0

            all_rows.append({
                "date": current.strftime("%Y-%m-%d"),
                "label_date": (current + timedelta(days=1)).strftime("%Y-%m-%d"),  # T+1
                "close": close,
                "settlement": settlement,
                "change_pct": round(change_pct, 4),
                "range_pct": round(range_pct, 4),
                "volume": best.get("volume", "").replace(",", ""),
            })
            prev_settlement = settlement or prev_settlement
            print(f"close={close} change={change_pct:+.2f}%")
        else:
            print("no data")

        current += timedelta(days=1)
        time.sleep(0.5)  # rate limit

    # Write CSV
    output_path = Path(args.output)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "label_date", "close", "settlement",
                                                "change_pct", "range_pct", "volume"])
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\nDone! {len(all_rows)} rows → {output_path}")
    print("Next step: merge label_date with daily features for ML training")


if __name__ == "__main__":
    main()
