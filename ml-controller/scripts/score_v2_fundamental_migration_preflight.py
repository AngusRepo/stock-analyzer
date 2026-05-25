"""Read-only preflight for Score V2 canonical fundamental D1 migration."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services import d1_client  # noqa: E402
from services.score_v2_fundamental_migration_preflight import (  # noqa: E402
    MIGRATION_FILE,
    build_fundamental_migration_preflight_report,
)


QueryFn = Callable[[str, int], list[dict[str, Any]]]


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def _resolve_npx() -> str:
    for command in ("npx.cmd", "npx.exe", "npx"):
        resolved = shutil.which(command)
        if resolved:
            return resolved
    return "npx.cmd" if os.name == "nt" else "npx"


def _d1_query(sql: str, timeout: int = 90) -> list[dict[str, Any]]:
    return d1_client.query(sql, [], timeout=timeout)


def _wrangler_query(sql: str, timeout: int = 90, *, cwd: Path) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [
            _resolve_npx(),
            "wrangler@4",
            "d1",
            "execute",
            "stockvision-db",
            "--remote",
            "--json",
            "--command",
            " ".join(sql.split()),
        ],
        cwd=str(cwd),
        check=True,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    payload = json.loads(completed.stdout)
    if isinstance(payload, list):
        rows: list[dict[str, Any]] = []
        for item in payload:
            if isinstance(item, dict) and isinstance(item.get("results"), list):
                rows.extend(dict(row) for row in item["results"] if isinstance(row, dict))
        return rows
    if isinstance(payload, dict) and isinstance(payload.get("results"), list):
        return [dict(row) for row in payload["results"] if isinstance(row, dict)]
    return []


def _table_names(query: QueryFn) -> list[str]:
    rows = query(
        """
        SELECT name
          FROM sqlite_master
         WHERE type='table'
           AND name IN ('canonical_fundamental_features')
         ORDER BY name
        """,
        60,
    )
    return [str(row.get("name")) for row in rows or [] if row.get("name")]


def _inventory(table_names: list[str], query: QueryFn) -> dict[str, Any]:
    if "canonical_fundamental_features" not in set(table_names):
        return {"fundamental_total": 0, "fundamental_latest_available_date": None}
    rows = query(
        """
        SELECT COUNT(*) AS fundamental_total,
               MAX(available_date) AS fundamental_latest_available_date
          FROM canonical_fundamental_features
        """,
        90,
    )
    return dict(rows[0]) if rows else {}


def _report_from_input_json(payload: Any, *, migration_sql: str, migration_file: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("--input-json must contain an object")
    return build_fundamental_migration_preflight_report(
        migration_sql=migration_sql,
        migration_file=migration_file,
        table_names=[str(name) for name in payload.get("table_names") or []],
        inventory=dict(payload.get("inventory") or {}),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Score V2 fundamental migration preflight.")
    parser.add_argument("--migration-file", default=str(ROOT / MIGRATION_FILE), help="Migration SQL file to inspect.")
    parser.add_argument("--input-json", default="", help="Optional offline live-schema input JSON.")
    parser.add_argument("--output-json", default="", help="Optional output report path.")
    parser.add_argument("--wrangler", action="store_true", help="Use local Wrangler for read-only remote D1 checks.")
    parser.add_argument("--wrangler-cwd", default=str(ROOT / "worker"), help="Working directory for Wrangler.")
    parser.add_argument("--fail-on-block", action="store_true", help="Exit 2 when migration preflight blocks.")
    args = parser.parse_args()

    migration_path = Path(args.migration_file)
    migration_sql = migration_path.read_text(encoding="utf-8")

    if args.input_json:
        report = _report_from_input_json(
            _read_json(Path(args.input_json)),
            migration_sql=migration_sql,
            migration_file=str(migration_path),
        )
    else:
        query: QueryFn = (
            (lambda sql, timeout=90: _wrangler_query(sql, timeout, cwd=Path(args.wrangler_cwd)))
            if args.wrangler
            else _d1_query
        )
        table_names = _table_names(query)
        report = build_fundamental_migration_preflight_report(
            migration_sql=migration_sql,
            migration_file=str(migration_path),
            table_names=table_names,
            inventory=_inventory(table_names, query),
        )

    if args.output_json:
        _write_json(Path(args.output_json), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str))
    if args.fail_on_block and report["decision"] == "BLOCK":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
