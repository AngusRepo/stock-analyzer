"""Read-only preflight for the Score V2 fundamental-quality D1 migration."""

from __future__ import annotations

import re
from typing import Any


SCHEMA_VERSION = "score-v2-fundamental-migration-preflight-v1"
TABLE_NAME = "canonical_fundamental_features"
MIGRATION_FILE = "worker/migration_score_v2_fundamental_quality.sql"

REQUIRED_COLUMNS = (
    "stock_id",
    "period",
    "market_segment",
    "report_date",
    "available_date",
    "revenue_growth_yoy",
    "gross_margin",
    "operating_margin",
    "roe",
    "eps",
    "pe",
    "pb",
    "dividend_yield",
    "debt_ratio",
    "current_ratio",
    "operating_cash_flow",
    "industry_quality_percentile",
    "source",
    "lineage_json",
    "as_of_date",
    "created_at",
)

REQUIRED_INDEXES = (
    "idx_canonical_fundamental_features_available",
    "idx_canonical_fundamental_features_symbol_period",
)

DISALLOWED_SQL_RE = re.compile(r"\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|REPLACE)\b", re.IGNORECASE)


def _normalized_sql(sql: str) -> str:
    return " ".join(sql.lower().split())


def _missing_columns(sql: str) -> list[str]:
    lower_sql = sql.lower()
    return [column for column in REQUIRED_COLUMNS if not re.search(rf"\b{re.escape(column)}\b", lower_sql)]


def _missing_indexes(sql: str) -> list[str]:
    lower_sql = sql.lower()
    return [name for name in REQUIRED_INDEXES if name.lower() not in lower_sql]


def _int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def build_fundamental_migration_preflight_report(
    *,
    migration_sql: str,
    table_names: list[str],
    inventory: dict[str, Any] | None = None,
    migration_file: str = MIGRATION_FILE,
) -> dict[str, Any]:
    """Return a read-only apply-readiness report; never executes migration SQL."""

    inventory = dict(inventory or {})
    tables = {str(name).strip() for name in table_names if str(name).strip()}
    normalized = _normalized_sql(migration_sql)
    disallowed = sorted({match.group(1).upper() for match in DISALLOWED_SQL_RE.finditer(migration_sql)})
    missing_columns = _missing_columns(migration_sql)
    missing_indexes = _missing_indexes(migration_sql)
    has_create_table = f"create table if not exists {TABLE_NAME}" in normalized
    has_primary_key = "primary key(stock_id, period, source)" in normalized
    table_exists = TABLE_NAME in tables
    fundamental_rows = _int(inventory.get("fundamental_total"))

    checks = [
        {
            "id": "migration_file_has_create_table",
            "passed": has_create_table,
            "value": has_create_table,
            "expected": f"CREATE TABLE IF NOT EXISTS {TABLE_NAME}",
        },
        {
            "id": "migration_file_has_required_columns",
            "passed": not missing_columns,
            "value": {"missing_columns": missing_columns},
            "expected": list(REQUIRED_COLUMNS),
        },
        {
            "id": "migration_file_has_required_indexes",
            "passed": not missing_indexes,
            "value": {"missing_indexes": missing_indexes},
            "expected": list(REQUIRED_INDEXES),
        },
        {
            "id": "migration_file_has_primary_key",
            "passed": has_primary_key,
            "value": has_primary_key,
            "expected": "PRIMARY KEY(stock_id, period, source)",
        },
        {
            "id": "migration_file_has_no_destructive_sql",
            "passed": not disallowed,
            "value": {"disallowed_statements": disallowed},
            "expected": "no DROP/DELETE/UPDATE/INSERT/TRUNCATE/REPLACE statements",
        },
    ]
    failed_checks = [check["id"] for check in checks if not check["passed"]]

    if failed_checks:
        decision = "BLOCK"
        allowed_next_action = "repair_migration_file"
    elif table_exists and fundamental_rows > 0:
        decision = "ALREADY_APPLIED"
        allowed_next_action = "run_contribution_readiness_gate"
    elif table_exists:
        decision = "SCHEMA_APPLIED_WAITING_DATA"
        allowed_next_action = "materialize_canonical_fundamental_features"
    else:
        decision = "READY_TO_APPLY"
        allowed_next_action = "request_wei_approval_before_apply"

    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "read_only",
        "decision": decision,
        "passed": decision != "BLOCK",
        "failed_checks": failed_checks,
        "checks": checks,
        "migration_file": migration_file,
        "live_schema": {
            "table_exists": table_exists,
            "fundamental_total": fundamental_rows,
            "fundamental_latest_available_date": inventory.get("fundamental_latest_available_date"),
        },
        "apply_command_hint": (
            "cd worker; npx wrangler@4 d1 execute stockvision-db --remote "
            "--file=./migration_score_v2_fundamental_quality.sql"
        ),
        "readback_sql": [
            "SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_fundamental_features';",
            "PRAGMA table_info(canonical_fundamental_features);",
            "SELECT COUNT(*) AS fundamental_total, MAX(available_date) AS latest_available_date FROM canonical_fundamental_features;",
        ],
        "allowed_next_action": allowed_next_action,
    }
