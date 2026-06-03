"""Export a read-only Score V2 fundamental/news contribution readiness report."""

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
from services.score_v2_contribution_readiness import (  # noqa: E402
    build_score_v2_contribution_readiness_report,
)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


QueryFn = Callable[[str, int], list[dict[str, Any]]]


def _resolve_npx() -> str:
    for command in ("npx.cmd", "npx.exe", "npx"):
        resolved = shutil.which(command)
        if resolved:
            return resolved
    return "npx.cmd" if os.name == "nt" else "npx"


def _d1_query(sql: str, timeout: int = 90) -> list[dict[str, Any]]:
    return d1_client.query(sql, [], timeout=timeout)


def _wrangler_query(sql: str, timeout: int = 90, *, cwd: Path) -> list[dict[str, Any]]:
    compact_sql = " ".join(sql.split())
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
            compact_sql,
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
           AND name IN (
             'canonical_fundamental_features',
             'canonical_revenue_monthly',
             'theme_signals',
             'stock_theme_features',
             'external_evidence_items',
             'news',
             'stocks',
             'screener_funnel_items',
             'screener_funnel_runs'
           )
         ORDER BY name
        """,
        60,
    )
    return [str(row.get("name")) for row in rows or [] if row.get("name")]


def _inventory(table_names: list[str], query: QueryFn) -> dict[str, Any]:
    has_fundamental = "canonical_fundamental_features" in set(table_names)
    fundamental_count_sql = (
        "(SELECT COUNT(*) FROM canonical_fundamental_features "
        "WHERE source='finlab.fundamental_factor_diversity')"
    ) if has_fundamental else "0"
    fundamental_any_count_sql = "(SELECT COUNT(*) FROM canonical_fundamental_features)" if has_fundamental else "0"
    fundamental_latest_sql = (
        "(SELECT MAX(available_date) FROM canonical_fundamental_features "
        "WHERE source='finlab.fundamental_factor_diversity')"
    ) if has_fundamental else "NULL"
    rows = query(
        f"""
        SELECT
          (SELECT COUNT(*) FROM canonical_revenue_monthly) AS revenue_total,
          (SELECT MAX(revenue_month) FROM canonical_revenue_monthly) AS revenue_latest_month,
          {fundamental_count_sql} AS fundamental_total,
          {fundamental_any_count_sql} AS fundamental_any_total,
          {fundamental_latest_sql} AS fundamental_latest_available_date,
          (SELECT COUNT(*) FROM theme_signals) AS theme_total,
          (SELECT MAX(date) FROM theme_signals) AS theme_latest_date,
          (SELECT COUNT(*) FROM stock_theme_features) AS stock_theme_total,
          (SELECT MAX(date) FROM stock_theme_features) AS stock_theme_latest_date,
          (SELECT COUNT(*) FROM external_evidence_items) AS evidence_total,
          (SELECT MAX(published_at) FROM external_evidence_items) AS evidence_latest_published_at,
          (SELECT COUNT(*) FROM news WHERE published_at >= date('now', '-7 days')) AS news_7d_total
        """,
        90,
    )
    return dict(rows[0]) if rows else {}


def _daily_component_rows(query: QueryFn) -> list[dict[str, Any]]:
    return query(
        """
        SELECT date,
               COUNT(*) AS n,
               SUM(CASE WHEN json_extract(score_components, '$.components.fundamentalQuality') > 0 THEN 1 ELSE 0 END)
                 AS fundamental_nonzero,
               SUM(CASE WHEN json_extract(score_components, '$.components.newsTheme') > 0 THEN 1 ELSE 0 END)
                 AS news_nonzero
          FROM daily_recommendations
         GROUP BY date
         ORDER BY date DESC
         LIMIT 10
        """,
        90,
    )


def _theme_signal_rows(query: QueryFn) -> list[dict[str, Any]]:
    return query(
        """
        SELECT source, date, COUNT(*) AS n, ROUND(AVG(score), 4) AS avg_score
          FROM theme_signals
         WHERE date >= date('now', '-14 days')
         GROUP BY source, date
         ORDER BY date DESC, n DESC
         LIMIT 50
        """,
        90,
    )


def _funnel_stage_rows(query: QueryFn) -> list[dict[str, Any]]:
    return query(
        """
        SELECT date, stage, reason_code, decision, COUNT(*) AS n,
               ROUND(AVG(score_after - score_before), 4) AS avg_delta
          FROM screener_funnel_items
         WHERE date >= date('now', '-10 days')
           AND stage IN ('buzz_evidence', 'external_evidence_risk', 'sentiment', 'news_sentiment')
         GROUP BY date, stage, reason_code, decision
         ORDER BY date DESC, n DESC
         LIMIT 50
        """,
        90,
    )


def _report_from_input_json(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("--input-json must contain an object")
    return build_score_v2_contribution_readiness_report(
        table_names=[str(name) for name in payload.get("table_names") or []],
        inventory=dict(payload.get("inventory") or {}),
        daily_component_rows=[dict(row) for row in payload.get("daily_component_rows") or []],
        theme_signal_rows=[dict(row) for row in payload.get("theme_signal_rows") or []],
        funnel_stage_rows=[dict(row) for row in payload.get("funnel_stage_rows") or []],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Score V2 contribution readiness report.")
    parser.add_argument("--input-json", default="", help="Optional offline diagnostic input JSON.")
    parser.add_argument("--output-json", default="", help="Optional output report path.")
    parser.add_argument("--wrangler", action="store_true", help="Use local Wrangler for read-only remote D1 queries.")
    parser.add_argument("--wrangler-cwd", default=str(ROOT / "worker"), help="Working directory for Wrangler.")
    parser.add_argument("--fail-on-block", action="store_true", help="Exit 2 when readiness is blocked.")
    args = parser.parse_args()

    if args.input_json:
        report = _report_from_input_json(_read_json(Path(args.input_json)))
    else:
        query: QueryFn = (
            (lambda sql, timeout=90: _wrangler_query(sql, timeout, cwd=Path(args.wrangler_cwd)))
            if args.wrangler
            else _d1_query
        )
        table_names = _table_names(query)
        report = build_score_v2_contribution_readiness_report(
            table_names=table_names,
            inventory=_inventory(table_names, query),
            daily_component_rows=_daily_component_rows(query),
            theme_signal_rows=_theme_signal_rows(query),
            funnel_stage_rows=_funnel_stage_rows(query),
        )

    if args.output_json:
        _write_json(Path(args.output_json), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str))
    if args.fail_on_block and report["decision"] == "BLOCK":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
