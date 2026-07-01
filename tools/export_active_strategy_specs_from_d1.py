from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "output" / "finlab_strategy_backtests"
SCHEMA_VERSION = "stockvision-active-strategy-spec-export-v1"


STATUS_SCOPES = {
    "active": ("active",),
    "runtime": ("active", "candidate", "shadow", "research"),
}

SELECT_STRATEGIES_SQL_TEMPLATE = """
SELECT
  strategy_id AS id,
  version,
  name,
  status,
  owner,
  family_id,
  variant_id,
  owner_type,
  promotion_status,
  alpha_bucket,
  supported_regimes_json,
  thesis,
  thresholds_json,
  candidate_policy_json,
  risk_notes_json,
  created_by
FROM strategy_spec_registry
WHERE status IN ({status_placeholders})
ORDER BY CASE status
  WHEN 'active' THEN 0
  WHEN 'candidate' THEN 1
  WHEN 'shadow' THEN 2
  WHEN 'research' THEN 3
  ELSE 4
END, strategy_id;
""".strip()

SELECT_ACTIVE_STRATEGIES_SQL_ONE_LINE = " ".join(
    SELECT_STRATEGIES_SQL_TEMPLATE.format(status_placeholders="'active'").split()
)


def _select_sql(status_scope: str) -> str:
    statuses = STATUS_SCOPES[status_scope]
    quoted = ",".join(f"'{status}'" for status in statuses)
    return " ".join(SELECT_STRATEGIES_SQL_TEMPLATE.format(status_placeholders=quoted).split())


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)


def _run(cmd: list[str], cwd: Path) -> dict[str, Any]:
    executable = shutil.which(cmd[0])
    if executable is None and os.name == "nt":
        for suffix in (".cmd", ".exe", ".bat"):
            executable = shutil.which(f"{cmd[0]}{suffix}")
            if executable:
                break
    if executable is None:
        return {
            "cmd": cmd,
            "returncode": 127,
            "stdout": "",
            "stderr": f"executable_not_found:{cmd[0]}",
        }
    proc = subprocess.run([executable, *cmd[1:]], cwd=str(cwd), capture_output=True, check=False)
    return {
        "cmd": cmd,
        "returncode": proc.returncode,
        "stdout": _strip_ansi((proc.stdout or b"").decode("utf-8", errors="replace")),
        "stderr": _strip_ansi((proc.stderr or b"").decode("utf-8", errors="replace")),
    }


def _parse_json_output(text: str) -> Any:
    cleaned = _strip_ansi(text).strip()
    for idx, ch in enumerate(cleaned):
        if ch not in "[{":
            continue
        try:
            return json.loads(cleaned[idx:].strip())
        except json.JSONDecodeError:
            continue
    raise ValueError("json_payload_not_found")


def _wrangler_results(run: dict[str, Any]) -> list[dict[str, Any]]:
    if run["returncode"] != 0:
        raise RuntimeError(f"wrangler_failed:{run['stderr'] or run['stdout']}")
    payload = _parse_json_output(run["stdout"])
    if not isinstance(payload, list) or not payload:
        raise RuntimeError("wrangler_json_shape_invalid")
    first = payload[0] if isinstance(payload[0], dict) else {}
    rows = first.get("results") if isinstance(first, dict) else []
    if not isinstance(rows, list):
        raise RuntimeError("wrangler_results_missing")
    return [row for row in rows if isinstance(row, dict)]


def _read_json_value(raw: Any, default: Any) -> Any:
    if raw in (None, ""):
        return default
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _as_list(raw: Any) -> list[Any]:
    value = _read_json_value(raw, [])
    return value if isinstance(value, list) else []


def _as_dict(raw: Any) -> dict[str, Any]:
    value = _read_json_value(raw, {})
    return value if isinstance(value, dict) else {}


def _strategy_spec(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id") or "").strip(),
        "version": str(row.get("version") or "").strip(),
        "name": str(row.get("name") or "").strip(),
        "status": str(row.get("status") or "").strip(),
        "owner": str(row.get("owner") or "").strip(),
        "familyId": str(row.get("family_id") or "").strip(),
        "variantId": str(row.get("variant_id") or "").strip(),
        "ownerType": str(row.get("owner_type") or "").strip(),
        "promotionStatus": str(row.get("promotion_status") or "").strip(),
        "alphaBucket": str(row.get("alpha_bucket") or "").strip(),
        "supportedRegimes": _as_list(row.get("supported_regimes_json")),
        "thesis": str(row.get("thesis") or "").strip(),
        "thresholds": _as_dict(row.get("thresholds_json")),
        "candidatePolicy": _as_dict(row.get("candidate_policy_json")),
        "riskNotes": _as_list(row.get("risk_notes_json")),
        "createdBy": str(row.get("created_by") or "").strip(),
    }


def _validate_specs(specs: list[dict[str, Any]], *, status_scope: str) -> list[str]:
    errors: list[str] = []
    ids: set[str] = set()
    allowed_statuses = set(STATUS_SCOPES[status_scope])
    for idx, spec in enumerate(specs):
        sid = str(spec.get("id") or "").strip()
        if not sid:
            errors.append(f"spec_{idx}:id_missing")
        if sid in ids:
            errors.append(f"duplicate_id:{sid}")
        ids.add(sid)
        if spec.get("status") not in allowed_statuses:
            errors.append(f"{sid}:status_out_of_scope")
        if spec.get("owner") != "strategy":
            errors.append(f"{sid}:owner_not_strategy")
        if spec.get("ownerType") != "strategy":
            errors.append(f"{sid}:owner_type_not_strategy")
        if status_scope == "active" and spec.get("promotionStatus") != "production":
            errors.append(f"{sid}:promotion_status_not_production")
        if not isinstance(spec.get("supportedRegimes"), list):
            errors.append(f"{sid}:supported_regimes_not_array")
        if not isinstance(spec.get("riskNotes"), list):
            errors.append(f"{sid}:risk_notes_not_array")
        if not isinstance(spec.get("thresholds"), dict):
            errors.append(f"{sid}:thresholds_not_object")
        if not isinstance(spec.get("candidatePolicy"), dict):
            errors.append(f"{sid}:candidate_policy_not_object")
    return errors


def export_strategy_specs(root: Path = ROOT, *, status_scope: str = "active") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if status_scope not in STATUS_SCOPES:
        raise ValueError(f"unsupported_status_scope:{status_scope}")
    run = _run(
        [
            "npx",
            "wrangler@4",
            "d1",
            "execute",
            "stockvision-db",
            "--remote",
            "--json",
            "--command",
            _select_sql(status_scope),
        ],
        root / "worker",
    )
    rows = _wrangler_results(run)
    specs = [_strategy_spec(row) for row in rows]
    errors = _validate_specs(specs, status_scope=status_scope)
    summary = {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "read_only_d1_export",
        "production_mutation_allowed": False,
        "source": "remote_d1.strategy_spec_registry",
        "status_scope": status_scope,
        "included_statuses": list(STATUS_SCOPES[status_scope]),
        "strategy_count": len(specs),
        "errors": errors,
        "strategy_ids": [spec["id"] for spec in specs],
        "wrangler": {
            "returncode": run["returncode"],
            "stderr": run["stderr"],
        },
    }
    return specs, summary


def export_active_strategy_specs(root: Path = ROOT) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    return export_strategy_specs(root, status_scope="active")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export active StockVision StrategySpec rows from remote D1 as clean JSON.")
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--output", default=None)
    parser.add_argument("--summary-output", default=None)
    parser.add_argument("--status-scope", choices=sorted(STATUS_SCOPES), default="active")
    args = parser.parse_args()

    root = Path(args.repo)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    specs, summary = export_strategy_specs(root, status_scope=args.status_scope)
    count = int(summary["strategy_count"])
    scope = str(args.status_scope)
    output = Path(args.output) if args.output else output_dir / f"current_{scope}_{count}_strategy_specs.json"
    summary_output = Path(args.summary_output) if args.summary_output else output_dir / f"current_{scope}_{count}_strategy_specs_summary.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    summary_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(specs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {
        **summary,
        "json": output.resolve().relative_to(root.resolve()).as_posix() if output.resolve().is_relative_to(root.resolve()) else str(output),
    }
    summary_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
