from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
FIELDS = {
    "tw_business_indicators": {
        "景氣對策信號(分)": "tw_business_indicators:景氣對策信號(分)",
        "領先指標綜合指數(點)": "tw_business_indicators:領先指標綜合指數(點)",
        "同時指標綜合指數(點)": "tw_business_indicators:同時指標綜合指數(點)",
    },
    "tw_total_pmi": {
        "製造業PMI": "tw_total_pmi:製造業PMI",
    },
    "tw_total_nmi": {
        "臺灣非製造業NMI": "tw_total_nmi:臺灣非製造業NMI",
    },
    "tw_monetary_aggregates": {
        "年增率(%)": "tw_monetary_aggregates:年增率(%)",
    },
}

CANONICAL_FIELD_ALIASES = {
    "tw_business_indicators": {
        "景氣對策信號(分)": "business_signal_score",
        "領先指標綜合指數(點)": "leading_index",
        "同時指標綜合指數(點)": "coincident_index",
    },
    "tw_total_pmi": {
        "製造業PMI": "manufacturing_pmi",
    },
    "tw_total_nmi": {
        "臺灣非製造業NMI": "non_manufacturing_nmi",
    },
    "tw_monetary_aggregates": {
        "年增率(%)": "m2_yoy_pct",
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sql_quote(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def login_finlab() -> None:
    from finlab import login

    api_key = os.environ.get("FINLAB_API_KEY")
    if not api_key:
        raise RuntimeError("missing env FINLAB_API_KEY")
    login(api_key)


def latest_value(api_key: str) -> tuple[str | None, float | None]:
    from finlab import data

    df = pd.DataFrame(data.get(api_key)).copy()
    if df.empty:
        return None, None
    df.index = pd.to_datetime(df.index, errors="coerce")
    df = df[~df.index.isna()].sort_index()
    series = df.iloc[:, 0].dropna()
    if series.empty:
        return None, None
    return pd.Timestamp(series.index[-1]).strftime("%Y-%m-%d"), float(series.iloc[-1])


def collect_snapshot() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for dataset, fields in FIELDS.items():
        latest_materialization = None
        metrics: dict[str, Any] = {"generated_at": utc_now(), "fields": {}}
        missing = 0
        for label, api_key in fields.items():
            try:
                date, value = latest_value(api_key)
            except Exception as exc:
                missing += 1
                metrics["fields"][label] = {"api_key": api_key, "error": str(exc)[:180]}
                continue
            metrics["fields"][label] = {"api_key": api_key, "date": date, "value": value}
            if label == "景氣對策信號(分)":
                metrics["latest_signal_score"] = value
                metrics["latest_signal_date"] = date
            if latest_materialization is None or (date and date > latest_materialization):
                latest_materialization = date
        out.append({
            "source": "finlab",
            "dataset": dataset,
            "as_of_date": datetime.now(timezone.utc).date().isoformat(),
            "freshness_status": "ok" if missing == 0 else "partial",
            "missing_rate": missing / max(1, len(fields)),
            "duplicate_rate": 0,
            "schema_drift_status": "ok",
            "entity_link_confidence": 0.95,
            "latest_materialization": latest_materialization,
            "metrics_json": metrics,
        })
    return out


def collect_canonical_regime_context_rows(
    rows: list[dict[str, Any]],
    *,
    generated_at: str | None = None,
) -> list[dict[str, Any]]:
    timestamp = generated_at or utc_now()
    out: list[dict[str, Any]] = []
    for row in rows:
        dataset = str(row.get("dataset") or "").strip()
        fields = ((row.get("metrics_json") or {}).get("fields") or {})
        if not isinstance(fields, dict):
            continue
        for label, meta in fields.items():
            if not isinstance(meta, dict):
                continue
            date = str(meta.get("date") or "").strip()[:10]
            value = meta.get("value")
            if not date or value is None:
                continue
            field = CANONICAL_FIELD_ALIASES.get(dataset, {}).get(str(label), str(label))
            lineage = {
                "schema_version": "finlab-macro-context-snapshot-v2",
                "generated_at": timestamp,
                "api_key": meta.get("api_key"),
                "label": label,
            }
            out.append({
                "date": date,
                "dataset": dataset,
                "field": field,
                "category": "market",
                "value": float(value),
                "text_value": None,
                "source": f"finlab.{dataset}",
                "lineage_json": json.dumps(lineage, ensure_ascii=False, sort_keys=True),
                "as_of_date": timestamp[:10],
            })
    return out


def build_d1_upsert_statements(
    rows: list[dict[str, Any]],
    canonical_rows: list[dict[str, Any]] | None = None,
) -> list[tuple[str, list[Any]]]:
    statements: list[tuple[str, list[Any]]] = []
    source_quality_sql = """
      INSERT INTO source_quality_metrics (
        source, dataset, as_of_date, freshness_status, missing_rate, duplicate_rate, schema_drift_status,
        entity_link_confidence, latest_materialization, metrics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source, dataset, as_of_date) DO UPDATE SET
        freshness_status=excluded.freshness_status,
        missing_rate=excluded.missing_rate,
        duplicate_rate=excluded.duplicate_rate,
        schema_drift_status=excluded.schema_drift_status,
        entity_link_confidence=excluded.entity_link_confidence,
        latest_materialization=excluded.latest_materialization,
        metrics_json=excluded.metrics_json,
        created_at=datetime('now')
    """.strip()
    for row in rows:
        statements.append((source_quality_sql, [
            row["source"],
            row["dataset"],
            row["as_of_date"],
            row["freshness_status"],
            row["missing_rate"],
            row["duplicate_rate"],
            row["schema_drift_status"],
            row.get("entity_link_confidence"),
            row.get("latest_materialization"),
            json.dumps(row["metrics_json"], ensure_ascii=False, default=str),
        ]))

    canonical_sql = """
      INSERT INTO canonical_regime_context_daily (
        date, dataset, field, category, value, text_value, source, lineage_json, as_of_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, dataset, field, category, source) DO UPDATE SET
        value=excluded.value,
        text_value=excluded.text_value,
        lineage_json=excluded.lineage_json,
        as_of_date=excluded.as_of_date
    """.strip()
    canonical_source = canonical_rows if canonical_rows is not None else collect_canonical_regime_context_rows(rows)
    for row in canonical_source:
        statements.append((canonical_sql, [
            row["date"],
            row["dataset"],
            row["field"],
            row["category"],
            row.get("value"),
            row.get("text_value"),
            row["source"],
            row["lineage_json"],
            row["as_of_date"],
        ]))
    return statements


def _render_sql(statement: str, params: list[Any]) -> str:
    parts = statement.split("?")
    rendered = [parts[0]]
    for idx, param in enumerate(params):
        rendered.append(sql_quote(param))
        rendered.append(parts[idx + 1])
    return "".join(rendered).strip() + ";"


def write_sql_file(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [_render_sql(sql, params) for sql, params in build_d1_upsert_statements(rows)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize FinLab macro context into source_quality_metrics.")
    parser.add_argument("--sql-out", default=".tmp/finlab_macro_context.sql")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    login_finlab()
    rows = collect_snapshot()
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    if not args.dry_run:
        write_sql_file(rows, ROOT / args.sql_out)
        print(json.dumps({"sql_out": args.sql_out, "rows": len(rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
