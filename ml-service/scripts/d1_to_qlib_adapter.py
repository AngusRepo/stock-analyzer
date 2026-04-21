"""
d1_to_qlib_adapter.py — #11 QuantaAlpha Phase 1 T1.2

Pulls TW stock_prices from Cloudflare D1 via REST API, dumps per-symbol CSV,
invokes Qlib's dump_bin.py to convert to binary format at /data/qlib_tw/.

Universe: `in_current_watchlist = 1` (= screener universe ~350) — P0.3 locked.
History: last 5 years (default) for enough Qlib factor training.

Usage (local):
  export CF_API_TOKEN=...
  export CF_ACCOUNT_ID=...
  export CF_D1_DB_ID=...
  python scripts/d1_to_qlib_adapter.py \
    --out-dir ./qlib_tw \
    --universe-name sv_screener_350 \
    --years 5

Usage (Modal via QuantaAlpha app):
  This script is also callable as a Modal Function — see add_local_file hook
  in modal_app_quantaalpha.py. For now, local build → upload volume is simplest.

Note: Qlib's dump_bin is part of the pyqlib package under tests/scripts/. We
call it via subprocess once CSVs are written.
"""

from __future__ import annotations

import argparse
import csv
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import List

import requests


D1_QUERY_URL_FMT = (
    "https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"
)


def d1_query(sql: str, params: List | None = None) -> list[dict]:
    """Execute D1 SQL via Cloudflare REST API and return rows."""
    account = os.environ["CF_ACCOUNT_ID"]
    db = os.environ["CF_D1_DB_ID"]
    token = os.environ["CF_API_TOKEN"]
    url = D1_QUERY_URL_FMT.format(account=account, db=db)
    payload = {"sql": sql, "params": params or []}
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=payload,
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 query failed: {data}")
    return data["result"][0].get("results", [])


def fetch_universe() -> list[str]:
    """Screener universe: in_current_watchlist=1."""
    rows = d1_query(
        "SELECT symbol FROM stocks WHERE in_current_watchlist = 1 AND market IN ('TWSE','OTC') ORDER BY symbol"
    )
    return [r["symbol"] for r in rows]


def fetch_stock_prices(symbol: str, start_date: str) -> list[dict]:
    """Fetch OHLCV for one symbol since start_date."""
    return d1_query(
        """SELECT sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume, sp.adj_close
           FROM stock_prices sp
           JOIN stocks s ON sp.stock_id = s.id
           WHERE s.symbol = ? AND sp.date >= ?
             AND sp.close IS NOT NULL AND sp.volume IS NOT NULL
           ORDER BY sp.date""",
        params=[symbol, start_date],
    )


def write_csv(csv_dir: Path, symbol: str, rows: list[dict]) -> int:
    """Write one symbol's prices as CSV (Qlib-compatible columns)."""
    if not rows:
        return 0
    csv_path = csv_dir / f"{symbol}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        # Qlib dump_bin expects: date,open,close,high,low,volume,factor
        # `factor` is adjustment factor; use adj_close / close as proxy if adj_close present.
        w.writerow(["date", "open", "close", "high", "low", "volume", "factor", "vwap"])
        for row in rows:
            close = row["close"]
            adj = row.get("adj_close") or close
            factor = (adj / close) if (close and close > 0) else 1.0
            # vwap: approximate with (high+low+close)/3 since we lack tick-level data
            vwap = (
                (row["high"] + row["low"] + close) / 3.0
                if row.get("high") and row.get("low")
                else close
            )
            w.writerow([
                row["date"],
                row.get("open") or close,
                close,
                row.get("high") or close,
                row.get("low") or close,
                row.get("volume") or 0,
                round(factor, 6),
                round(vwap, 4),
            ])
    return len(rows)


def write_instruments_file(instruments_dir: Path, universe_name: str, symbol_dates: dict[str, tuple[str, str]]):
    """Qlib instruments file: <universe>.txt with `<symbol>\\t<start>\\t<end>`."""
    instruments_dir.mkdir(parents=True, exist_ok=True)
    path = instruments_dir / f"{universe_name}.txt"
    with path.open("w", encoding="utf-8") as f:
        for sym, (start, end) in sorted(symbol_dates.items()):
            f.write(f"{sym}\t{start}\t{end}\n")
    # Also write `all.txt` so Qlib default universe = all symbols
    all_path = instruments_dir / "all.txt"
    with all_path.open("w", encoding="utf-8") as f:
        for sym, (start, end) in sorted(symbol_dates.items()):
            f.write(f"{sym}\t{start}\t{end}\n")


def run_qlib_dump_bin(csv_dir: Path, qlib_dir: Path):
    """Invoke Qlib's dump_bin CLI to convert CSV → binary."""
    # Use pyqlib installed script; fallback: clone qlib and call scripts/dump_bin.py
    cmd = [
        sys.executable, "-m", "qlib.tests.data.dump_bin",  # may not exist in all versions
    ]
    # Fallback to installed dump_bin.py path if module form unavailable:
    try:
        import qlib
        qlib_root = Path(qlib.__file__).parent
        dump_bin = qlib_root / "tests" / "data" / "dump_bin.py"
        if not dump_bin.is_file():
            # Try alternate path (Qlib 0.9.x layout)
            dump_bin = qlib_root.parent / "scripts" / "dump_bin.py"
        if not dump_bin.is_file():
            raise RuntimeError(
                f"Cannot locate Qlib dump_bin.py — fallback: install qlib from git or pip show pyqlib"
            )
        cmd = [
            sys.executable, str(dump_bin),
            "dump_all",
            "--csv_path", str(csv_dir),
            "--qlib_dir", str(qlib_dir),
            "--freq", "day",
            "--max_workers", "4",
            "--date_field_name", "date",
            "--symbol_field_name", "symbol",
        ]
    except ImportError:
        raise RuntimeError("pyqlib not installed — `pip install pyqlib`")

    print(f"[dump_bin] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, required=True, help="Output Qlib binary directory")
    ap.add_argument("--universe-name", type=str, default="sv_screener_350")
    ap.add_argument("--years", type=int, default=5, help="History depth in years")
    ap.add_argument("--skip-bin", action="store_true", help="Only dump CSVs (skip Qlib binary conversion)")
    args = ap.parse_args()

    t0 = time.time()
    out_dir: Path = args.out_dir
    csv_dir = out_dir / "_csv"
    csv_dir.mkdir(parents=True, exist_ok=True)

    start_date = time.strftime("%Y-%m-%d", time.localtime(t0 - args.years * 365 * 86400))
    print(f"[adapter] universe fetch starting (start_date={start_date})")
    universe = fetch_universe()
    print(f"[adapter] universe size: {len(universe)}")

    symbol_dates: dict[str, tuple[str, str]] = {}
    written = 0
    for i, sym in enumerate(universe):
        try:
            rows = fetch_stock_prices(sym, start_date)
        except Exception as e:
            print(f"[{i+1}/{len(universe)}] {sym} fetch failed: {e}")
            continue
        n = write_csv(csv_dir, sym, rows)
        if n >= 30:  # Qlib dump_bin expects ≥ 30 rows typically
            symbol_dates[sym] = (rows[0]["date"], rows[-1]["date"])
            written += 1
        if (i + 1) % 25 == 0:
            print(f"[{i+1}/{len(universe)}] cumulative written {written} symbols, elapsed {int(time.time()-t0)}s")

    write_instruments_file(out_dir / "instruments", args.universe_name, symbol_dates)
    print(f"[adapter] CSV dump done: {written} symbols with ≥30 rows written to {csv_dir}")

    if args.skip_bin:
        print("[adapter] --skip-bin set, skipping Qlib binary conversion")
    else:
        run_qlib_dump_bin(csv_dir, out_dir)
        print(f"[adapter] Qlib binary at {out_dir}")

    print(f"[adapter] Total elapsed: {int(time.time()-t0)}s")


if __name__ == "__main__":
    main()
