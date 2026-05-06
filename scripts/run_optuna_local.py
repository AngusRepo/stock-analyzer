#!/usr/bin/env python3
"""
Run the local Optuna bundle without reintroducing the old Pandas path.

This wrapper delegates to the production-aligned Polars scripts under
ml-service/scripts and writes a single combined JSON result.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "scripts" / "data"
ML_SERVICE_DIR = ROOT / "ml-service"


def run_step(name: str, args: list[str], output_path: Path) -> dict:
    print(f"\n[Optuna] {name}", flush=True)
    cmd = [sys.executable, *args, "--output", str(output_path)]
    completed = subprocess.run(cmd, cwd=ML_SERVICE_DIR, text=True)
    if completed.returncode != 0:
        return {"status": "failed", "returncode": completed.returncode}
    if not output_path.exists():
        return {"status": "failed", "reason": "missing output"}
    return json.loads(output_path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run all local Optuna searches")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--n-trials", type=int, default=150)
    parser.add_argument("--output", type=Path, default=DATA_DIR / "optuna_results.json")
    args = parser.parse_args()

    start = time.time()
    data_dir = args.data_dir.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    prices_csv = data_dir / "stock_prices.csv"
    orders_csv = data_dir / "paper_orders.csv"
    predictions_csv = data_dir / "predictions.csv"

    results: dict[str, object] = {}
    if prices_csv.exists():
        results["barrier"] = run_step(
            "triple barrier",
            ["scripts/optuna_barrier.py", "--csv", str(prices_csv), "--n-trials", str(args.n_trials)],
            data_dir / "optuna_barrier_results.json",
        )
    else:
        results["barrier"] = {"status": "skipped", "reason": f"missing {prices_csv.name}"}

    if orders_csv.exists() and predictions_csv.exists():
        results["signal"] = run_step(
            "signal thresholds",
            [
                "scripts/optuna_signal.py",
                "--orders-csv",
                str(orders_csv),
                "--predictions-csv",
                str(predictions_csv),
                "--n-trials",
                str(args.n_trials),
            ],
            data_dir / "optuna_signal_results.json",
        )
    else:
        results["signal"] = {
            "status": "skipped",
            "reason": "missing paper_orders.csv or predictions.csv",
        }

    if orders_csv.exists():
        results["sltp"] = run_step(
            "SL/TP trailing",
            ["scripts/optuna_sltp.py", "--orders-csv", str(orders_csv), "--n-trials", str(args.n_trials)],
            data_dir / "optuna_sltp_results.json",
        )
    else:
        results["sltp"] = {"status": "skipped", "reason": f"missing {orders_csv.name}"}

    results["elapsed_seconds"] = round(time.time() - start, 2)
    output.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved combined results to {output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
