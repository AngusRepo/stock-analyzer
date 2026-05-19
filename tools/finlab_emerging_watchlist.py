from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path.cwd()
FEATURE_LAKE_JSON = ROOT / "data" / "finlab_research" / "feature_lake_manifest.json"
MANIFEST_JSON = ROOT / "data" / "finlab_research" / "emerging_watchlist_manifest.json"
MANIFEST_MD = ROOT / "FINLAB_EMERGING_WATCHLIST.md"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_emerging_watchlist import (  # noqa: E402
    build_finlab_emerging_watchlist_manifest,
    validate_finlab_emerging_watchlist_manifest,
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
    lines.append("# FinLab Emerging Watchlist Manifest")
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
    lines.append("## Board Policy")
    lines.append("")
    for key, value in manifest["board_policy"].items():
        lines.append(f"- `{key}`: {value}")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(manifest["summary"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Source Contracts")
    lines.append("")
    table = [[
        "source_dataset",
        "lane",
        "fields",
        "usage",
        "period_key",
        "watchlist_only",
        "required_checks",
    ]]
    for source in manifest["source_contracts"]:
        table.append([
            source["source_dataset"],
            source["dataset_lane"],
            str(source["field_count"]),
            source["usage"],
            source["normalized_period_key"],
            str(source["watchlist_only"]),
            ", ".join(source["required_checks"]),
        ])
    lines.extend(markdown_table(table))
    lines.append("")
    lines.append("## Derived Context")
    lines.append("")
    context_table = [["name", "source_dataset", "signals", "use"]]
    for item in manifest["derived_context"]:
        context_table.append([
            item["name"],
            item["source_dataset"],
            ", ".join(item["signals"]),
            item["use"],
        ])
    lines.extend(markdown_table(context_table))
    lines.append("")
    lines.append("## Boundary")
    lines.append("")
    lines.append("Emerging-stock FinLab sources are context-only. They can enrich watchlists and manual review, but cannot create pending-buy, execution, production ML training, or direct alpha-gate output until a separate promotion decision changes this contract.")
    lines.append("")
    MANIFEST_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    feature_lake = json.loads(FEATURE_LAKE_JSON.read_text(encoding="utf-8"))
    manifest = build_finlab_emerging_watchlist_manifest(feature_lake)
    errors = validate_finlab_emerging_watchlist_manifest(manifest)
    if errors:
        raise SystemExit("finlab_emerging_watchlist_manifest_invalid:" + ",".join(errors))

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
