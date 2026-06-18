from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "tools" / "build_strategy_feature_ref_contract.py"
CONTRACT = ROOT / "data" / "feature_registry" / "strategy_feature_ref_contract_v1.json"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    builder = _load_module(BUILDER, "stockvision_strategy_feature_ref_builder")
    builder.main()
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    blockers = data.get("blockers") or []
    counts = data.get("counts") or {}
    if blockers:
        print(json.dumps({
            "status": "failed",
            "reason": "strategy_feature_ref_blockers",
            "counts": counts,
            "blockers": blockers,
        }, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps({
        "status": "ok",
        "counts": counts,
        "ref_type_counts": data.get("ref_type_counts"),
        "registry_status_counts": data.get("registry_status_counts"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
