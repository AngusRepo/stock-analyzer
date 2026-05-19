from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


ROOT = Path.cwd()
PLAN_JSON = ROOT / "data" / "finlab_research" / "adoption_plan.json"
DEFINITIONS_JSON = ROOT / "data" / "finlab_research" / "dagster_definitions_payload.json"
MANIFEST_JSON = ROOT / "data" / "finlab_research" / "feature_lake_manifest.json"
MANIFEST_MD = ROOT / "FINLAB_FEATURE_LAKE_MANIFEST.md"

sys.path.insert(0, str(ROOT / "ml-controller"))
sys.path.insert(0, str(ROOT / "ml-service"))

from app.features import FEATURE_COLS  # noqa: E402
from services.finlab_feature_lake import (  # noqa: E402
    build_finlab_feature_lake_manifest,
    validate_finlab_feature_lake_manifest,
)


def markdown_table(rows: list[list[str]]) -> list[str]:
    if not rows:
        return []
    lines = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * len(rows[0])) + " |",
    ]
    for row in rows[1:]:
        safe = [str(cell).replace("|", "/").replace("\n", " ") for cell in row]
        lines.append("| " + " | ".join(safe) + " |")
    return lines


def write_manifest_markdown(manifest: dict) -> None:
    family_counts = Counter(family["stage"] for family in manifest["sidecar_families"])
    lines: list[str] = []
    lines.append("# FinLab Feature Lake Manifest")
    lines.append("")
    lines.append(f"Generated: {manifest['generated_at']}")
    lines.append(f"Schema: `{manifest['schema_version']}`")
    lines.append(f"Checksum: `{manifest['checksum']}`")
    lines.append(f"Source plan checksum: `{manifest['source_plan_checksum']}`")
    lines.append(f"Source Dagster payload checksum: `{manifest['source_dagster_payload_checksum']}`")
    lines.append("")
    lines.append("## Policy")
    lines.append("")
    for key, value in manifest["policy"].items():
        lines.append(f"- `{key}`: {value}")
    lines.append("")
    lines.append("## Canonical Production Features")
    lines.append("")
    contract = manifest["canonical_feature_contract"]
    lines.append(f"- source: `{contract['source_module']}`")
    lines.append(f"- schema_version: `{contract['schema_version']}`")
    lines.append(f"- feature_count: `{contract['feature_count']}`")
    lines.append(f"- features_hash: `{contract['features_hash']}`")
    lines.append(f"- production_mutation_allowed: `{contract['production_mutation_allowed']}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps({
        **manifest["summary"],
        "families_by_stage": dict(sorted(family_counts.items())),
    }, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Sidecar Families")
    lines.append("")
    table = [[
        "asset_key",
        "stage",
        "lane",
        "fields",
        "promotion_state",
        "watchlist_only",
        "row_checks",
        "use",
    ]]
    for family in manifest["sidecar_families"]:
        table.append([
            family["asset_key"],
            family["stage"],
            family["dataset_lane"],
            str(family["field_count"]),
            family["promotion_state"],
            str(family["watchlist_only"]),
            ", ".join(family["row_level_checks"]),
            family.get("stockvision_use") or "",
        ])
    lines.extend(markdown_table(table))
    lines.append("")
    lines.append("## Boundary")
    lines.append("")
    lines.append("FinLab sidecar fields do not append to `FEATURE_COLS`, do not enter production ML, and do not affect pending-buy until explicit promotion gates pass. Row-level checks remain `observed` until shadow rows are materialized.")
    lines.append("")
    MANIFEST_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    adoption_plan = json.loads(PLAN_JSON.read_text(encoding="utf-8"))
    definitions_payload = json.loads(DEFINITIONS_JSON.read_text(encoding="utf-8"))
    manifest = build_finlab_feature_lake_manifest(
        adoption_plan,
        definitions_payload,
        canonical_features=FEATURE_COLS,
    )
    errors = validate_finlab_feature_lake_manifest(manifest)
    if errors:
        raise SystemExit("finlab_feature_lake_manifest_invalid:" + ",".join(errors))

    MANIFEST_JSON.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_manifest_markdown(manifest)
    print(json.dumps({
        "manifest_json": str(MANIFEST_JSON),
        "manifest_md": str(MANIFEST_MD),
        "checksum": manifest["checksum"],
        "summary": manifest["summary"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
