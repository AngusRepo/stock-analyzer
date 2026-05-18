from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))

from services.finlab_adapter import FinLabReadOnlyAdapter  # noqa: E402
from services.finlab_dagster_runtime import run_finlab_dagster_local_materialization  # noqa: E402


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize FinLab V4 local runtime assets.")
    parser.add_argument("--adoption-plan", default=str(ROOT / "data" / "finlab_research" / "adoption_plan.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "finlab_runtime"))
    parser.add_argument("--run-id", default="finlab-v4-local")
    parser.add_argument("--years", type=int, default=5)
    parser.add_argument("--max-api-keys-per-lane", type=int, default=3)
    parser.add_argument(
        "--stockvision-rows-json",
        help="Optional JSON object keyed by dataset_lane with existing StockVision rows.",
    )
    args = parser.parse_args()

    adoption_plan = _load_json(Path(args.adoption_plan))
    stockvision_rows_by_lane = {}
    if args.stockvision_rows_json:
        stockvision_rows_by_lane = _load_json(Path(args.stockvision_rows_json))

    manifest = run_finlab_dagster_local_materialization(
        adapter=FinLabReadOnlyAdapter(),
        adoption_plan=adoption_plan,
        stockvision_rows_by_lane=stockvision_rows_by_lane,
        output_dir=args.output_dir,
        run_id=args.run_id,
        years=args.years,
        max_api_keys_per_lane=args.max_api_keys_per_lane,
    )
    print(json.dumps(manifest["summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
