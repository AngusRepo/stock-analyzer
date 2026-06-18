from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "tools" / "build_ml_feature_selection_contract.py"
CONTRACT = ROOT / "data" / "feature_registry" / "ml_feature_selection_contract_v1.json"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    builder = _load_module(BUILDER, "stockvision_ml_feature_selection_contract_builder")
    builder.main()
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    counts = data.get("counts") or {}
    feature_cols = int(counts.get("feature_cols") or 0)
    formal = int(counts.get("formal137_ml_training_view") or 0)
    mapped = int(counts.get("feature_cols_mapped_to_formal137") or 0)
    status_counts = data.get("formal137_status_counts") or {}
    no_201_pass = feature_cols < 201 and formal < 201
    migration_required = feature_cols != formal or mapped != formal
    status = "migration_required" if migration_required else "ok"
    result = {
        "status": status,
        "no_201_invariant_pass": no_201_pass,
        "counts": counts,
        "formal137_status_counts": status_counts,
        "migration_required_reason": (
            "current FEATURE_COLS and formal137 ml_training_view differ; production model schema must migrate through feature selection and retrain/release gate"
            if migration_required else ""
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if no_201_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
