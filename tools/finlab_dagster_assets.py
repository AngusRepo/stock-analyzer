from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path.cwd()
PLAN_JSON = ROOT / "data" / "finlab_research" / "adoption_plan.json"
GRAPH_JSON = ROOT / "data" / "finlab_research" / "dagster_asset_graph.json"
GRAPH_MD = ROOT / "FINLAB_DAGSTER_ASSETS.md"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_dagster_assets import (  # noqa: E402
    build_finlab_asset_graph,
    validate_finlab_asset_graph,
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


def write_graph_markdown(graph: dict) -> None:
    lines: list[str] = []
    lines.append("# FinLab Dagster Asset Graph for StockVision V4")
    lines.append("")
    lines.append(f"Generated: {graph['generated_at']}")
    lines.append(f"Schema: `{graph['schema_version']}`")
    lines.append(f"Checksum: `{graph['checksum']}`")
    lines.append(f"Source plan checksum: `{graph['source_plan_checksum']}`")
    lines.append("")
    lines.append("## Policy")
    lines.append("")
    for key, value in graph["policy"].items():
        lines.append(f"- `{key}`: {value}")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(graph["summary"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Asset Nodes")
    lines.append("")
    table = [["asset_key", "layer", "deps", "group", "fields", "use"]]
    for node in graph["nodes"]:
        table.append([
            node["asset_key"],
            node["layer"],
            ", ".join(node["deps"]),
            node["group_name"],
            str(node["field_count"]),
            node.get("stockvision_use") or "",
        ])
    lines.extend(markdown_table(table))
    lines.append("")
    lines.append("## Quality Checks")
    lines.append("")
    check_table = [["asset_key", "check_name", "severity"]]
    for check in graph["checks"]:
        check_table.append([
            check["asset_key"],
            check["check_name"],
            check["severity"],
        ])
    lines.extend(markdown_table(check_table))
    lines.append("")
    lines.append("## Next Implementation Step")
    lines.append("")
    lines.append("Use this graph as the source for Dagster `AssetSpec` / asset factory code. Dagster should orchestrate refresh, checks, lineage, and reruns only; StockVision keeps ML, regime, decision, paper-trade, and risk ownership.")
    lines.append("")
    GRAPH_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    plan = json.loads(PLAN_JSON.read_text(encoding="utf-8"))
    graph = build_finlab_asset_graph(plan)
    errors = validate_finlab_asset_graph(graph)
    if errors:
        raise SystemExit("finlab_dagster_asset_graph_invalid:" + ",".join(errors))

    GRAPH_JSON.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    write_graph_markdown(graph)
    print(json.dumps({
        "graph_json": str(GRAPH_JSON),
        "graph_md": str(GRAPH_MD),
        "checksum": graph["checksum"],
        "summary": graph["summary"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
