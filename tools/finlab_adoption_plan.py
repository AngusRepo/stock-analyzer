from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path.cwd()
CATALOG_JSON = ROOT / "data" / "finlab_research" / "api_fields.json"
PLAN_JSON = ROOT / "data" / "finlab_research" / "adoption_plan.json"
PLAN_MD = ROOT / "FINLAB_ADOPTION_PLAN.md"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_adoption_plan import (  # noqa: E402
    build_finlab_adoption_plan,
    load_finlab_catalog,
    validate_finlab_adoption_plan,
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


def write_plan_markdown(plan: dict) -> None:
    lines: list[str] = []
    lines.append("# FinLab Adoption Plan for StockVision V4")
    lines.append("")
    lines.append(f"Generated: {plan['generated_at']}")
    lines.append(f"Schema: `{plan['schema_version']}`")
    lines.append(f"Checksum: `{plan['checksum']}`")
    lines.append("")
    lines.append("## Policy")
    lines.append("")
    for key, value in plan["policy"].items():
        if isinstance(value, list):
            value = ", ".join(value)
        lines.append(f"- `{key}`: {value}")
    lines.append("")
    lines.append("## Counts")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(plan["counts"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Asset Manifest")
    lines.append("")
    table = [[
        "asset_key",
        "stage",
        "dataset_lane",
        "access_tier",
        "fields",
        "markets",
        "quality_gates",
        "use",
    ]]
    for asset in plan["assets"]:
        table.append([
            asset["asset_key"],
            asset["stage"],
            asset["dataset_lane"],
            asset["access_tier"],
            str(asset["field_count"]),
            ", ".join(asset["markets"]),
            "; ".join(asset["quality_gates"][:3]),
            asset["stockvision_use"],
        ])
    lines.extend(markdown_table(table))
    lines.append("")
    lines.append("## Dagster Mapping")
    lines.append("")
    lines.append("```text")
    lines.append("raw_finlab_<dataset_lane> -> clean_finlab_<dataset_lane> -> feature_lake_finlab_<dataset_lane>")
    lines.append("parity assets compare against current StockVision/TWSE/TPEX outputs")
    lines.append("diversity assets remain shadow until feature promotion gates pass")
    lines.append("research assets are archive/benchmark only")
    lines.append("```")
    lines.append("")
    PLAN_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    catalog = load_finlab_catalog(CATALOG_JSON)
    plan = build_finlab_adoption_plan(
        catalog,
        producer_run_id="finlab_adoption_plan",
    )
    errors = validate_finlab_adoption_plan(plan)
    if errors:
        raise SystemExit("finlab_adoption_plan_invalid:" + ",".join(errors))

    PLAN_JSON.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    write_plan_markdown(plan)
    print(json.dumps({
        "plan_json": str(PLAN_JSON),
        "plan_md": str(PLAN_MD),
        "checksum": plan["checksum"],
        "counts": plan["counts"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
