from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class DatasetSpec:
    lane: str
    kind: str
    keys: dict[str, str]


CORE_SPECS = [
    DatasetSpec(
        lane="daily_price",
        kind="wide_fields",
        keys={
            "open": "price:開盤價",
            "high": "price:最高價",
            "low": "price:最低價",
            "close": "price:收盤價",
            "volume": "price:成交股數",
            "value": "price:成交金額",
        },
    ),
    DatasetSpec(
        lane="chip_diversity",
        kind="wide_fields",
        keys={
            "foreign_net": "institutional_investors_trading_summary:外陸資買賣超股數(不含外資自營商)",
            "trust_net": "institutional_investors_trading_summary:投信買賣超股數",
            "dealer_self_net": "institutional_investors_trading_summary:自營商買賣超股數(自行買賣)",
            "dealer_hedge_net": "institutional_investors_trading_summary:自營商買賣超股數(避險)",
            "margin_balance": "margin_transactions:融資今日餘額",
            "short_balance": "margin_transactions:融券今日餘額",
        },
    ),
    DatasetSpec(
        lane="revenue",
        kind="wide_fields",
        keys={
            "revenue": "monthly_revenue:當月營收",
            "mom": "monthly_revenue:上月比較增減(%)",
            "yoy": "monthly_revenue:去年同月增減(%)",
        },
    ),
    DatasetSpec(
        lane="emerging_price_diversity",
        kind="wide_fields",
        keys={
            "open": "rotc_price:開盤價",
            "high": "rotc_price:最高價",
            "low": "rotc_price:最低價",
            "close": "rotc_price:收盤價",
            "volume": "rotc_price:成交股數",
            "value": "rotc_price:成交金額",
        },
    ),
    DatasetSpec(
        lane="emerging_revenue_diversity",
        kind="wide_fields",
        keys={
            "revenue": "rotc_monthly_revenue:當月營收",
            "mom": "rotc_monthly_revenue:上月比較增減(%)",
            "yoy": "rotc_monthly_revenue:去年同月增減(%)",
        },
    ),
    DatasetSpec(
        lane="global_context",
        kind="wide_fields",
        keys={
            "world_open": "world_index:open",
            "world_high": "world_index:high",
            "world_low": "world_index:low",
            "world_close": "world_index:close",
            "world_volume": "world_index:volume",
        },
    ),
    DatasetSpec(
        lane="security_master",
        kind="table",
        keys={"security_categories": "security_categories"},
    ),
    DatasetSpec(
        lane="taxonomy_expansion",
        kind="table",
        keys={"security_industry_themes": "security_industry_themes"},
    ),
    DatasetSpec(
        lane="emerging_chip_diversity",
        kind="rotc_broker_aggregate",
        keys={"rotc_broker_transactions": "rotc_broker_transactions"},
    ),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def start_date_for_years(years: int) -> str:
    today = datetime.now(timezone.utc).date()
    return today.replace(year=today.year - years).isoformat()


def d1_query(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    token = os.environ["CF_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    db = os.environ["CF_D1_DB_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"
    body: dict[str, Any] = {"sql": sql}
    if params:
        body["params"] = params
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode("utf-8")[:500]) from exc
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("errors") or payload)[:500])
    result = payload.get("result") or []
    return (result[0] or {}).get("results") or []


def d1_exec(sql: str, params: list[Any] | None = None) -> None:
    d1_query(sql, params)


def normalize_wide_index(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(df).copy()
    out.index = pd.to_datetime(out.index, errors="coerce")
    out = out[~out.index.isna()]
    out = out.sort_index()
    out.columns = [str(col).strip() for col in out.columns]
    return out


def filter_years(df: pd.DataFrame, years: int) -> pd.DataFrame:
    start = pd.Timestamp(start_date_for_years(years))
    return df[df.index >= start]


def non_null_cells(df: pd.DataFrame) -> int:
    return int(df.notna().sum().sum())


def latest_index(df: pd.DataFrame) -> str | None:
    if df.empty:
        return None
    return str(df.index.max().date())


def write_parquet(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, compression="zstd")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def upload_dir_to_gcs(local_dir: Path, *, bucket_name: str, prefix: str) -> dict[str, Any]:
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    uploaded = 0
    bytes_total = 0
    for path in local_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(local_dir).as_posix()
        blob = bucket.blob(f"{prefix.rstrip('/')}/{rel}")
        blob.upload_from_filename(str(path))
        uploaded += 1
        bytes_total += path.stat().st_size
    return {
        "bucket": bucket_name,
        "prefix": prefix.rstrip("/"),
        "objects": uploaded,
        "bytes": bytes_total,
    }


def d1_counts(start: str) -> dict[str, int]:
    queries = {
        "daily_price": "SELECT COUNT(*) AS n FROM stock_prices WHERE date >= ?",
        "chip_diversity": "SELECT COUNT(*) AS n FROM chip_data WHERE date >= ?",
        "revenue": "SELECT COUNT(*) AS n FROM monthly_revenue WHERE date >= ?",
        "canonical_market_daily": "SELECT COUNT(*) AS n FROM canonical_market_daily WHERE date >= ?",
        "canonical_chip_daily": "SELECT COUNT(*) AS n FROM canonical_chip_daily WHERE date >= ?",
        "canonical_revenue_monthly": "SELECT COUNT(*) AS n FROM canonical_revenue_monthly WHERE revenue_month >= ?",
    }
    counts: dict[str, int] = {}
    for key, sql in queries.items():
        rows = d1_query(sql, [start])
        counts[key] = int((rows[0] if rows else {}).get("n") or 0)
    return counts


def stockvision_count_for_lane(counts: dict[str, int], lane: str) -> int:
    if lane in {"daily_price", "emerging_price_diversity", "global_context"}:
        return counts.get("daily_price", 0)
    if lane in {"chip_diversity", "emerging_chip_diversity"}:
        return counts.get("chip_diversity", 0)
    if lane in {"revenue", "emerging_revenue_diversity"}:
        return counts.get("revenue", 0)
    return 0


def table_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    data = pd.DataFrame(df).copy()
    for col in data.columns:
        if pd.api.types.is_datetime64_any_dtype(data[col]):
            data[col] = data[col].astype(str)
        elif str(data[col].dtype) == "category":
            data[col] = data[col].astype(str)
    return data.to_dict(orient="records")


def materialize_specs(*, years: int, run_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from finlab import data, login

    api_key = os.environ["FINLAB_API_KEY"]
    login(api_key)
    start = start_date_for_years(years)
    counts = d1_counts(start)
    dataset_summaries: list[dict[str, Any]] = []
    diff_reports: list[dict[str, Any]] = []

    for spec in CORE_SPECS:
        t0 = time.time()
        lane_dir = run_dir / "raw" / spec.lane
        artifacts: list[dict[str, Any]] = []
        finlab_rows = 0
        latest = None
        schema_fields: list[str] = []

        if spec.kind == "wide_fields":
            for field, api_key_name in spec.keys.items():
                frame = filter_years(normalize_wide_index(data.get(api_key_name)), years)
                finlab_rows = max(finlab_rows, int(frame.notna().any(axis=1).sum() * frame.shape[1]))
                latest = max([x for x in [latest, latest_index(frame)] if x], default=None)
                schema_fields.append(field)
                path = lane_dir / f"{field}.parquet"
                write_parquet(path, frame)
                artifacts.append({"field": field, "api_key": api_key_name, "path": str(path), "shape": list(frame.shape), "non_null_cells": non_null_cells(frame)})
        elif spec.kind == "table":
            frame = pd.DataFrame(data.get(next(iter(spec.keys.values()))))
            path = lane_dir / "table.parquet"
            write_parquet(path, frame)
            finlab_rows = int(len(frame))
            latest = utc_now()
            schema_fields = [str(col) for col in frame.columns]
            artifacts.append({"field": next(iter(spec.keys)), "api_key": next(iter(spec.keys.values())), "path": str(path), "shape": list(frame.shape)})
        elif spec.kind == "rotc_broker_aggregate":
            frame = pd.DataFrame(data.get("rotc_broker_transactions"))
            frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
            frame = frame[frame["date"] >= pd.Timestamp(start)]
            frame["buy_shares_raw"] = pd.to_numeric(frame["買進股數"], errors="coerce").fillna(0)
            frame["sell_shares_raw"] = pd.to_numeric(frame["賣出股數"], errors="coerce").fillna(0)
            frame["broker_net"] = frame["buy_shares_raw"] - frame["sell_shares_raw"]
            broker_daily = frame.groupby(["date", "stock_id", "證券商代號"], observed=True).agg(
                broker_buy_shares=("buy_shares_raw", "sum"),
                broker_sell_shares=("sell_shares_raw", "sum"),
                broker_net=("broker_net", "sum"),
            ).reset_index()
            broker_daily["abs_broker_net"] = broker_daily["broker_net"].abs()
            dominant = (
                broker_daily.sort_values(["date", "stock_id", "abs_broker_net"], ascending=[True, True, False])
                .groupby(["date", "stock_id"], observed=True)
                .head(1)[["date", "stock_id", "證券商代號", "broker_net", "abs_broker_net"]]
                .rename(columns={
                    "證券商代號": "dominant_broker_code",
                    "broker_net": "dominant_net_shares",
                    "abs_broker_net": "dominant_abs_net_shares",
                })
            )
            pressure = broker_daily.groupby(["date", "stock_id"], observed=True).agg(
                gross_imbalance_shares=("abs_broker_net", "sum"),
                directional_broker_count=("abs_broker_net", lambda values: int((values > 0).sum())),
            ).reset_index()
            grouped = frame.groupby(["date", "stock_id"], observed=True).agg(
                buy_shares=("buy_shares_raw", "sum"),
                sell_shares=("sell_shares_raw", "sum"),
                broker_count=("證券商代號", "nunique"),
            ).reset_index()
            grouped = grouped.merge(dominant, on=["date", "stock_id"], how="left").merge(pressure, on=["date", "stock_id"], how="left")
            # Backward-compatible field consumed by older previews. The all-broker
            # net is always zero by market mechanics, so V4.1 uses the dominant
            # broker imbalance as the signed proxy instead.
            grouped["buy_sell_net"] = grouped["dominant_net_shares"].fillna(0)
            path = lane_dir / "rotc_broker_daily.parquet"
            write_parquet(path, grouped)
            finlab_rows = int(len(grouped))
            latest = str(grouped["date"].max().date()) if len(grouped) else None
            schema_fields = [
                "buy_shares",
                "sell_shares",
                "buy_sell_net",
                "broker_count",
                "dominant_broker_code",
                "dominant_net_shares",
                "dominant_abs_net_shares",
                "gross_imbalance_shares",
                "directional_broker_count",
            ]
            artifacts.append({"field": "rotc_broker_daily", "api_key": "rotc_broker_transactions", "path": str(path), "shape": list(grouped.shape)})
        else:
            raise ValueError(f"unsupported spec kind: {spec.kind}")

        stockvision_rows = stockvision_count_for_lane(counts, spec.lane)
        missing = max(finlab_rows - stockvision_rows, 0)
        conflicts = 0
        diff = {
            "schema_version": "finlab-remote-diff-aggregate-v1",
            "run_id": run_dir.name,
            "dataset_lane": spec.lane,
            "source": "finlab",
            "generated_at": utc_now(),
            "primary_keys": ["stock_id", "date"],
            "compare_fields": schema_fields,
            "aggregate_diff": True,
            "summary": {
                "finlab_rows": finlab_rows,
                "stockvision_rows": stockvision_rows,
                "matched": min(finlab_rows, stockvision_rows),
                "missing_in_stockvision": missing,
                "missing_in_finlab": max(stockvision_rows - finlab_rows, 0),
                "value_conflicts": conflicts,
                "schema_extra_fields": schema_fields,
            },
        }
        diff_reports.append(diff)
        dataset_summaries.append({
            "lane": spec.lane,
            "kind": spec.kind,
            "finlab_rows": finlab_rows,
            "stockvision_rows": stockvision_rows,
            "latest": latest,
            "seconds": round(time.time() - t0, 2),
            "artifacts": artifacts,
        })
        write_json(run_dir / "diff" / f"{spec.lane}.json", diff)

    return dataset_summaries, diff_reports


def insert_d1_summary(manifest: dict[str, Any]) -> None:
    run_id = manifest["run_id"]
    generated_at = manifest["generated_at"]
    summary = manifest["summary"]
    d1_exec(
        """
        INSERT OR REPLACE INTO finlab_backfill_runs (
          run_id, generated_at, lookback_years, dataset_count, finlab_rows,
          gap_fill_rows, value_conflicts, checksum, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            run_id,
            generated_at,
            manifest["lookback_years"],
            summary["dataset_count"],
            summary["finlab_rows"],
            summary["gap_fill_rows"],
            summary["value_conflicts"],
            manifest["checksum"],
            "ready",
            json.dumps({"artifact_root": manifest["artifact_root"], "mode": manifest["mode"]}, ensure_ascii=False, sort_keys=True),
        ],
    )

    for diff in manifest["diff_reports"]:
        diff_summary = diff["summary"]
        d1_exec(
            """
            INSERT INTO source_diff_report (
              run_id, dataset_lane, source, generated_at, finlab_rows, stockvision_rows,
              matched_rows, missing_in_stockvision, missing_in_finlab, value_conflicts,
              schema_extra_fields, report_json, checksum
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                run_id,
                diff["dataset_lane"],
                "finlab",
                diff["generated_at"],
                diff_summary["finlab_rows"],
                diff_summary["stockvision_rows"],
                diff_summary["matched"],
                diff_summary["missing_in_stockvision"],
                diff_summary["missing_in_finlab"],
                diff_summary["value_conflicts"],
                json.dumps(diff_summary["schema_extra_fields"], ensure_ascii=False),
                json.dumps(diff, ensure_ascii=False, sort_keys=True, default=str),
                f"{run_id}:{diff['dataset_lane']}",
            ],
        )
        d1_exec(
            """
            INSERT INTO source_quality_metrics (
              source, dataset, as_of_date, freshness_status, missing_rate, duplicate_rate,
              schema_drift_status, entity_link_confidence, latest_materialization, metrics_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, dataset, as_of_date) DO UPDATE SET
              freshness_status=excluded.freshness_status,
              missing_rate=excluded.missing_rate,
              duplicate_rate=excluded.duplicate_rate,
              schema_drift_status=excluded.schema_drift_status,
              entity_link_confidence=excluded.entity_link_confidence,
              latest_materialization=excluded.latest_materialization,
              metrics_json=excluded.metrics_json
            """,
            [
                "finlab",
                diff["dataset_lane"],
                generated_at[:10],
                "ok",
                0.0 if diff_summary["finlab_rows"] else 1.0,
                0.0,
                "aggregate_diff",
                0.95,
                generated_at,
                json.dumps(diff_summary, ensure_ascii=False, sort_keys=True),
            ],
        )
        if diff_summary["missing_in_stockvision"] > 0:
            d1_exec(
                """
                INSERT INTO gap_fill_candidates (
                  run_id, dataset_lane, canonical_table, stock_id, symbol, date, market_segment,
                  field, finlab_value, stockvision_value, source, lineage_json, decision, generated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    run_id,
                    diff["dataset_lane"],
                    canonical_table_for_lane(diff["dataset_lane"]),
                    None,
                    None,
                    generated_at[:10],
                    None,
                    "__aggregate_missing_rows__",
                    str(diff_summary["missing_in_stockvision"]),
                    str(diff_summary["stockvision_rows"]),
                    "finlab",
                    json.dumps({"aggregate_diff": True, "run_id": run_id, "dataset_lane": diff["dataset_lane"]}, ensure_ascii=False),
                    "candidate",
                    generated_at,
                ],
            )


def canonical_table_for_lane(lane: str) -> str:
    if "price" in lane or lane == "global_context":
        return "canonical_market_daily"
    if "chip" in lane:
        return "canonical_chip_daily"
    if "revenue" in lane:
        return "canonical_revenue_monthly"
    return "data_source_inventory"


def checksum_manifest(payload: dict[str, Any]) -> str:
    import hashlib

    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run FinLab V4 remote backfill and D1 summary writeback.")
    parser.add_argument("--years", type=int, choices=[3, 5], required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "finlab_remote_backfill"))
    parser.add_argument("--write-d1", action="store_true")
    parser.add_argument("--gcs-bucket", default=os.environ.get("GCS_BUCKET_NAME", ""))
    parser.add_argument("--gcs-prefix", default="finlab/v4/backfill")
    args = parser.parse_args()

    missing = [key for key in ["FINLAB_API_KEY", "CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"] if not os.environ.get(key)]
    if missing:
        raise SystemExit(f"missing env vars: {','.join(missing)}")

    run_id = args.run_id
    if run_id == "auto":
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        run_id = f"finlab-v4-{args.years}y-{stamp}"

    run_dir = Path(args.output_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    generated_at = utc_now()
    dataset_summaries, diff_reports = materialize_specs(years=args.years, run_dir=run_dir)
    summary = {
        "dataset_count": len(dataset_summaries),
        "finlab_rows": sum(int(item["finlab_rows"]) for item in dataset_summaries),
        "gap_fill_rows": sum(1 for item in diff_reports if item["summary"]["missing_in_stockvision"] > 0),
        "value_conflicts": sum(int(item["summary"]["value_conflicts"]) for item in diff_reports),
        "missing_in_stockvision": sum(int(item["summary"]["missing_in_stockvision"]) for item in diff_reports),
    }
    manifest = {
        "schema_version": "finlab-v4-remote-backfill-v1",
        "run_id": run_id,
        "generated_at": generated_at,
        "lookback_years": args.years,
        "mode": "remote_summary_writeback_full_artifacts",
        "artifact_root": str(run_dir),
        "summary": summary,
        "datasets": dataset_summaries,
        "diff_reports": diff_reports,
    }
    manifest["checksum"] = checksum_manifest({"run_id": run_id, "summary": summary, "datasets": dataset_summaries})
    write_json(run_dir / "manifest.json", manifest)

    if args.gcs_bucket:
        gcs = upload_dir_to_gcs(
            run_dir,
            bucket_name=args.gcs_bucket,
            prefix=f"{args.gcs_prefix.rstrip('/')}/{run_id}",
        )
        manifest["gcs_upload"] = gcs
        write_json(run_dir / "manifest.json", manifest)

    if args.write_d1:
        insert_d1_summary(manifest)

    print(json.dumps({"run_id": run_id, "years": args.years, "summary": summary, "artifact_root": str(run_dir), "gcs_upload": manifest.get("gcs_upload")}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
