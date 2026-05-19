from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path.cwd()
FEATURE_LAKE_JSON = ROOT / "data" / "finlab_research" / "feature_lake_manifest.json"
MANIFEST_JSON = ROOT / "data" / "finlab_research" / "sector_flow_shadow_manifest.json"
MANIFEST_MD = ROOT / "FINLAB_SECTOR_FLOW_SHADOW.md"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_sector_flow_shadow import (  # noqa: E402
    build_finlab_sector_flow_shadow_manifest,
    validate_finlab_sector_flow_shadow_manifest,
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
    lines: list[str] = []
    lines.append("# FinLab Sector Flow Shadow Manifest")
    lines.append("")
    lines.append(f"Generated: {manifest['generated_at']}")
    lines.append(f"Schema: `{manifest['schema_version']}`")
    lines.append(f"Checksum: `{manifest['checksum']}`")
    lines.append(f"Source feature lake checksum: `{manifest['source_feature_lake_checksum']}`")
    lines.append("")
    lines.append("## Policy")
    lines.append("")
    for key, value in manifest["policy"].items():
        lines.append(f"- `{key}`: {value}")
    lines.append("")
    lines.append("## Sources")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps({
        "taxonomy_source": manifest["taxonomy_source"],
        "cash_flow_source": manifest["cash_flow_source"],
        "summary": manifest["summary"],
    }, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Layer Contract")
    lines.append("")
    table = [["tag_type", "classification", "source_kind", "source_dataset", "source_fields", "role"]]
    for layer in manifest["layers"]:
        table.append([
            layer["tag_type"],
            layer["classification"],
            layer["source_kind"],
            layer["source_dataset"],
            ", ".join(layer["source_fields"]),
            layer["role"],
        ])
    lines.extend(markdown_table(table))
    lines.append("")
    lines.append("## No Double Counting Rule")
    lines.append("")
    lines.append("Each layer is aggregated independently with isolation key `(date, sector, classification)`. The same symbol can appear in industry, industry_theme, subindustry, and concept layers, but those memberships must not be rolled up into a single cross-layer total. Within a layer, duplicate `(symbol, tag_type, tag)` rows are dropped before aggregation.")
    lines.append("")
    lines.append("## Boundary")
    lines.append("")
    lines.append("This manifest does not alter the existing `sector_flow` production write path. It defines the FinLab taxonomy shadow contract that future Dagster materialization and row-level checks must satisfy before screener or ML promotion.")
    lines.append("")
    MANIFEST_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    feature_lake = json.loads(FEATURE_LAKE_JSON.read_text(encoding="utf-8"))
    manifest = build_finlab_sector_flow_shadow_manifest(feature_lake)
    errors = validate_finlab_sector_flow_shadow_manifest(manifest)
    if errors:
        raise SystemExit("finlab_sector_flow_shadow_manifest_invalid:" + ",".join(errors))

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
