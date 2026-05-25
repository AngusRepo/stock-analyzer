from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _first_container(node: Any) -> dict[str, Any] | None:
    if isinstance(node, dict):
        containers = node.get("containers")
        if isinstance(containers, list) and containers:
            first = containers[0]
            return first if isinstance(first, dict) else None
        for value in node.values():
            found = _first_container(value)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _first_container(value)
            if found is not None:
                return found
    return None


def extract_job_args(job: dict[str, Any]) -> list[str]:
    container = _first_container(job) or {}
    args = container.get("args")
    if not isinstance(args, list):
        return []
    return [str(item) for item in args]


def validate_finlab_backfill_job_args(args: list[str]) -> dict[str, Any]:
    has_write_d1 = "--write-d1" in args
    has_apply_canonical = "--apply-canonical-d1" in args
    has_window = "--canonical-window-days" in args
    ok = (not has_write_d1) or has_apply_canonical
    result: dict[str, Any] = {
        "status": "ok" if ok else "failed",
        "has_write_d1": has_write_d1,
        "has_apply_canonical_d1": has_apply_canonical,
        "has_canonical_window_days": has_window,
        "args": args,
    }
    if not ok:
        result.update(
            {
                "reason": "job writes D1 summary tables without row-level canonical D1 apply",
                "impact": "FinLab runtime/source_quality can look fresh while canonical_chip_daily stays stale",
                "required_args": ["--apply-canonical-d1", "--canonical-window-days"],
            }
        )
    return result


def load_job_json(path: str) -> dict[str, Any]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("job JSON must be an object")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail closed when finlab-v4-backfill writes D1 without canonical D1 apply."
    )
    parser.add_argument("job_json", nargs="?", default="-", help="Path to gcloud job JSON, or '-' for stdin.")
    args = parser.parse_args(argv)

    job = load_job_json(args.job_json)
    result = validate_finlab_backfill_job_args(extract_job_args(job))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
