from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.finlab_v4_remote_backfill import CORE_SPECS, DEFAULT_CANONICAL_DATASETS  # noqa: E402


def load_catalog(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("fields") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError(f"invalid FinLab catalog shape: {path}")
    return [row for row in rows if isinstance(row, dict)]


def materialized_api_keys() -> set[str]:
    keys: set[str] = set()
    for spec in CORE_SPECS:
        for api_key in spec.keys.values():
            keys.add(str(api_key).strip())
    return {key for key in keys if key}


def summarize(rows: list[dict[str, Any]], *, limit: int) -> dict[str, Any]:
    covered = materialized_api_keys()
    tw_rows = [row for row in rows if str(row.get("market") or "").lower() == "tw"]
    production_rows = [
        row for row in tw_rows
        if str(row.get("adoption_priority") or "") in {"P0", "P1"}
        and str(row.get("dataset_lane") or "") != "research"
    ]
    covered_rows = [row for row in production_rows if str(row.get("api_key") or "").strip() in covered]
    unused_rows = [row for row in production_rows if str(row.get("api_key") or "").strip() not in covered]

    unused_by_lane: dict[str, list[str]] = defaultdict(list)
    for row in unused_rows:
        lane = str(row.get("dataset_lane") or "unknown")
        if len(unused_by_lane[lane]) < limit:
            unused_by_lane[lane].append(str(row.get("api_key") or ""))

    return {
        "catalog_fields": len(rows),
        "tw_fields": len(tw_rows),
        "production_candidate_fields": len(production_rows),
        "core_specs_api_keys": len(covered),
        "covered_production_fields": len(covered_rows),
        "unused_production_fields": len(unused_rows),
        "default_canonical_datasets": DEFAULT_CANONICAL_DATASETS,
        "coverage_by_lane": dict(Counter(str(row.get("dataset_lane") or "unknown") for row in covered_rows)),
        "unused_by_lane_count": dict(Counter(str(row.get("dataset_lane") or "unknown") for row in unused_rows)),
        "unused_examples_by_lane": dict(unused_by_lane),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare FinLab API catalog fields against StockVision materialized CORE_SPECS.")
    parser.add_argument("--catalog", default=str(ROOT / "data" / "finlab_research" / "api_fields.json"))
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    summary = summarize(load_catalog(Path(args.catalog)), limit=max(1, args.limit))
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
