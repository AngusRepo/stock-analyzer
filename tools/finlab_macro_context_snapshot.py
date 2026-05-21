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


def write_sql_file(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for row in rows:
        lines.append(
            "INSERT INTO source_quality_metrics "
            "(source, dataset, as_of_date, freshness_status, missing_rate, duplicate_rate, schema_drift_status, "
            "entity_link_confidence, latest_materialization, metrics_json, created_at) VALUES ("
            f"{sql_quote(row['source'])}, {sql_quote(row['dataset'])}, {sql_quote(row['as_of_date'])}, "
            f"{sql_quote(row['freshness_status'])}, {sql_quote(row['missing_rate'])}, {sql_quote(row['duplicate_rate'])}, "
            f"{sql_quote(row['schema_drift_status'])}, {sql_quote(row['entity_link_confidence'])}, "
            f"{sql_quote(row['latest_materialization'])}, {sql_quote(json.dumps(row['metrics_json'], ensure_ascii=False))}, datetime('now'));"
        )
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
