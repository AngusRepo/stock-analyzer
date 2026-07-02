from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.model_serving_resolver import (  # noqa: E402
    DIRECT_ALPHA_MODELS,
    build_model_pool_reconcile_plan,
)


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run reconcile universal/model_pool.json pointers against a D1 champion-shaped pool JSON.",
    )
    parser.add_argument("--model-pool-json", required=True, help="Local universal/model_pool.json snapshot.")
    parser.add_argument("--champion-pool-json", required=True, help="Local D1 champion resolver pool snapshot.")
    parser.add_argument("--model", action="append", help="Model name to reconcile. Repeatable; defaults to direct alpha models.")
    parser.add_argument("--output", help="Optional path to write the dry-run plan JSON.")
    args = parser.parse_args(argv)

    plan = build_model_pool_reconcile_plan(
        model_pool=_load_json(args.model_pool_json),
        champion_pool=_load_json(args.champion_pool_json),
        model_names=tuple(args.model or DIRECT_ALPHA_MODELS),
    )
    raw = json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(raw + "\n", encoding="utf-8")
    print(raw)
    return 0 if not plan["blocked_count"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
