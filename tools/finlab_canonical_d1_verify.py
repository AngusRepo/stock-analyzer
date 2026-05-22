#!/usr/bin/env python3
"""Verify FinLab canonical D1 freshness against daily source tables."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORKER_DIR = ROOT / "worker"

FRESHNESS_SQL = """
WITH canonical_latest AS (
  SELECT MAX(date) AS date FROM canonical_chip_daily
),
institutional_amount_latest AS (
  SELECT MAX(date) AS date FROM canonical_institutional_amount_daily
),
legacy_chip_latest AS (
  SELECT MAX(date) AS date FROM chip_data
),
margin_latest AS (
  SELECT MAX(date) AS date FROM margin_data
)
SELECT
  (SELECT date FROM canonical_latest) AS canonical_chip_date,
  (SELECT COUNT(*) FROM canonical_chip_daily WHERE date = (SELECT date FROM canonical_latest)) AS canonical_chip_rows,
  (SELECT date FROM institutional_amount_latest) AS institutional_amount_date,
  (SELECT COUNT(*) FROM canonical_institutional_amount_daily WHERE date = (SELECT date FROM institutional_amount_latest)) AS institutional_amount_rows,
  (SELECT date FROM legacy_chip_latest) AS legacy_chip_date,
  (SELECT COUNT(*) FROM chip_data WHERE date = (SELECT date FROM legacy_chip_latest)) AS legacy_chip_rows,
  (SELECT date FROM margin_latest) AS margin_date,
  (SELECT COUNT(*) FROM margin_data WHERE date = (SELECT date FROM margin_latest)) AS margin_rows,
  (SELECT MAX(generated_at)
     FROM finlab_materialization_manifest
    WHERE json_extract(row_counts_json, '$.canonical_chip_daily') IS NOT NULL) AS manifest_generated_at
"""


def _date(value: Any) -> str | None:
  if not isinstance(value, str) or not value:
    return None
  return value[:10]


def _latest_date(*values: Any) -> str | None:
  dates = sorted(date for date in (_date(value) for value in values) if date)
  return dates[-1] if dates else None


def _days_between(start: str | None, end: str | None) -> int | None:
  if not start or not end:
    return None
  try:
    return (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days
  except ValueError:
    return None


def _number(value: Any) -> int:
  try:
    return int(value or 0)
  except (TypeError, ValueError):
    return 0


def build_freshness_check(row: dict[str, Any], min_canonical_rows: int = 1000, min_amount_rows: int = 4) -> dict[str, Any]:
  canonical_date = _date(row.get("canonical_chip_date"))
  amount_date = _date(row.get("institutional_amount_date"))
  source_latest_date = _latest_date(row.get("legacy_chip_date"), row.get("margin_date"))
  lag_days = _days_between(canonical_date, source_latest_date)
  amount_lag_days = _days_between(amount_date, source_latest_date)
  canonical_rows = _number(row.get("canonical_chip_rows"))
  amount_rows = _number(row.get("institutional_amount_rows"))
  legacy_rows = _number(row.get("legacy_chip_rows"))
  margin_rows = _number(row.get("margin_rows"))

  metrics = {
    **row,
    "source_latest_date": source_latest_date,
    "lag_days": lag_days,
    "amount_lag_days": amount_lag_days,
    "min_canonical_rows": min_canonical_rows,
    "min_amount_rows": min_amount_rows,
    "source_rows": {"chip_data": legacy_rows, "margin_data": margin_rows},
    "required_job_arg": "--apply-canonical-d1",
  }

  if not source_latest_date:
    return {
      "id": "finlab_canonical_d1_freshness",
      "status": "warn",
      "decision": "WARN",
      "summary": "FinLab daily source tables have no latest date for canonical comparison",
      "metrics": metrics,
    }

  if not canonical_date:
    return {
      "id": "finlab_canonical_d1_freshness",
      "status": "fail",
      "decision": "BLOCK",
      "summary": f"canonical_chip_daily missing while source_latest={source_latest_date}",
      "metrics": metrics,
    }

  if not amount_date:
    return {
      "id": "finlab_canonical_d1_freshness",
      "status": "fail",
      "decision": "BLOCK",
      "summary": f"canonical_institutional_amount_daily missing while source_latest={source_latest_date}",
      "metrics": metrics,
    }

  stale = (lag_days is not None and lag_days > 0) or (amount_lag_days is not None and amount_lag_days > 0)
  too_few_rows = canonical_rows < min_canonical_rows
  too_few_amount_rows = amount_rows < min_amount_rows
  status = "fail" if stale or too_few_rows or too_few_amount_rows else "ok"
  return {
    "id": "finlab_canonical_d1_freshness",
    "status": status,
    "decision": "BLOCK" if status == "fail" else "PASS",
    "summary": (
      f"canonical_chip_daily latest={canonical_date} "
      f"institutional_amount latest={amount_date} amount_lag={amount_lag_days if amount_lag_days is not None else 'n/a'}d "
      f"source_latest={source_latest_date} lag={lag_days if lag_days is not None else 'n/a'}d "
      f"rows={canonical_rows} amount_rows={amount_rows}"
    ),
    "metrics": metrics,
  }


def parse_wrangler_results(stdout: str) -> list[dict[str, Any]]:
  payload = json.loads(stdout)
  if isinstance(payload, list) and payload:
    results = payload[0].get("results", [])
  elif isinstance(payload, dict):
    results = payload.get("results", [])
  else:
    results = []
  if not isinstance(results, list):
    raise ValueError("wrangler JSON did not contain a results list")
  return [row for row in results if isinstance(row, dict)]


def _npx_command() -> str:
  return shutil.which("npx.cmd") or shutil.which("npx") or "npx"


def run_wrangler_query(database: str, worker_dir: Path, timeout_sec: int) -> list[dict[str, Any]]:
  result = subprocess.run(
    [
      _npx_command(),
      "wrangler@4",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      FRESHNESS_SQL,
    ],
    cwd=worker_dir,
    capture_output=True,
    text=True,
    timeout=timeout_sec,
  )
  if result.returncode != 0:
    raise RuntimeError((result.stderr or result.stdout or "wrangler d1 execute failed").strip())
  return parse_wrangler_results(result.stdout)


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--database", default="stockvision-db")
  parser.add_argument("--worker-dir", type=Path, default=WORKER_DIR)
  parser.add_argument("--min-canonical-rows", type=int, default=1000)
  parser.add_argument("--timeout-sec", type=int, default=120)
  parser.add_argument("--stdin", action="store_true", help="Read wrangler --json output from stdin instead of invoking wrangler.")
  args = parser.parse_args(argv)

  try:
    if args.stdin:
      rows = parse_wrangler_results(sys.stdin.read())
    else:
      rows = run_wrangler_query(args.database, args.worker_dir, args.timeout_sec)
    check = build_freshness_check(rows[0] if rows else {}, args.min_canonical_rows)
  except Exception as exc:  # pragma: no cover - exercised by shell/runtime
    check = {
      "id": "finlab_canonical_d1_freshness",
      "status": "fail",
      "decision": "BLOCK",
      "summary": f"FinLab canonical D1 verify query failed: {exc}",
    }

  print(json.dumps(check, ensure_ascii=False, sort_keys=True))
  return 0 if check.get("status") == "ok" else 2


if __name__ == "__main__":
  raise SystemExit(main())
