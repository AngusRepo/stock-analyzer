from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


ROOT = Path.cwd()
GRAPH_JSON = ROOT / "data" / "finlab_research" / "dagster_asset_graph.json"
DEFINITIONS_JSON = ROOT / "data" / "finlab_research" / "dagster_definitions_payload.json"
DEFINITIONS_MD = ROOT / "FINLAB_DAGSTER_FACTORY.md"
DAGSTER_RUNTIME_PIN = "dagster==1.13.4"
DAGSTER_CODE_LOCATION = "dagster_defs.finlab_v4"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_dagster_factory import build_finlab_definitions_payload  # noqa: E402


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


def _asset_key(spec: dict) -> str:
    return "/".join(spec["key"])


def _write_markdown(payload: dict) -> None:
    group_counts = Counter(asset["group_name"] for asset in payload["assets"])
    check_counts = Counter(check["metadata"]["severity"] for check in payload["asset_checks"])

    lines: list[str] = []
    lines.append("# FinLab Dagster Factory Contract")
    lines.append("")
    lines.append(f"Schema: `{payload['schema_version']}`")
    lines.append(f"Mode: `{payload['mode']}`")
    lines.append(f"Runtime dependency: `{DAGSTER_RUNTIME_PIN}`")
    lines.append(f"Code location module: `{DAGSTER_CODE_LOCATION}`")
    lines.append(f"Dagster runtime available in this environment: `{payload['dagster_available']}`")
    lines.append(f"Asset graph checksum: `{payload['asset_graph_checksum']}`")
    lines.append(f"Source plan checksum: `{payload['source_plan_checksum']}`")
    lines.append("")
    lines.append("## Contract")
    lines.append("")
    lines.append("- This factory is the FinLab Dagster Asset Runtime formal-shadow entrypoint.")
    lines.append("- It creates Dagster-compatible asset specs and check specs from `dagster_asset_graph.json`.")
    lines.append("- It can drive formal-shadow materialization, but production feature writes, schedules, order submit, and ML retrain remain disabled until CPD approval.")
    lines.append("- Dagster is a planned V4 runtime dependency and is now pinned in `ml-controller/requirements.txt`.")
    lines.append("- `dagster_defs.finlab_v4` loads the FinLab asset graph as formal-shadow Dagster assets.")
    lines.append("- `finlab_v4_formal_shadow_quality_checks` exposes payload checks as one Dagster multi-asset check.")
    lines.append("- Checks that require materialized rows are reported as observed until the FinLab shadow feature lake writes rows.")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps({
        "asset_count": len(payload["assets"]),
        "asset_check_count": len(payload["asset_checks"]),
        "group_counts": dict(sorted(group_counts.items())),
        "check_severity_counts": dict(sorted(check_counts.items())),
        "schedule_count": len(payload["schedules"]),
        "dagster_check_def_count": 1 if payload["asset_checks"] else 0,
    }, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Schedules")
    lines.append("")
    schedule_rows = [["name", "cron", "timezone", "enabled", "reason"]]
    for schedule in payload["schedules"]:
        schedule_rows.append([
            schedule["name"],
            schedule["cron"],
            schedule["timezone"],
            str(schedule["enabled"]),
            schedule["reason"],
        ])
    lines.extend(markdown_table(schedule_rows))
    lines.append("")
    lines.append("## Asset Specs")
    lines.append("")
    asset_rows = [["asset_key", "deps", "group", "layer", "fields", "use"]]
    for asset in payload["assets"]:
        metadata = asset["metadata"]
        asset_rows.append([
            _asset_key(asset),
            ", ".join("/".join(dep) for dep in asset["deps"]),
            asset["group_name"],
            metadata["layer"],
            str(metadata["field_count"]),
            metadata.get("stockvision_use") or "",
        ])
    lines.extend(markdown_table(asset_rows))
    lines.append("")
    lines.append("## Asset Check Specs")
    lines.append("")
    lines.append("Dagster runtime mapping: one `multi_asset_check` named `finlab_v4_formal_shadow_quality_checks`. Metadata-only checks can pass/fail immediately; row-level checks such as `null_rate`, `duplicate_rate`, and parity diff are marked `observed` until the FinLab shadow feature lake materializes rows.")
    lines.append("")
    check_rows = [["asset_key", "check_name", "severity"]]
    for check in payload["asset_checks"]:
        check_rows.append([
            "/".join(check["asset_key"]),
            check["name"],
            check["metadata"]["severity"],
        ])
    lines.extend(markdown_table(check_rows))
    lines.append("")
    lines.append("## Promotion Rule")
    lines.append("")
    lines.append("Enable Dagster schedules only after the POC can prove schema compatibility, freshness checks, lineage, and rerun semantics without changing StockVision's current 106-feature production contract.")
    lines.append("")
    DEFINITIONS_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    graph = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    payload = build_finlab_definitions_payload(graph)
    DEFINITIONS_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_markdown(payload)
    print(json.dumps({
        "definitions_json": str(DEFINITIONS_JSON),
        "definitions_md": str(DEFINITIONS_MD),
        "asset_count": len(payload["assets"]),
        "asset_check_count": len(payload["asset_checks"]),
        "schedule_count": len(payload["schedules"]),
        "dagster_available": payload["dagster_available"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
