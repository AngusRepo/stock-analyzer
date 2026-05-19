from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol


SCHEMA_VERSION = "finlab-backfill-runtime-v1"


class FinLabDatasetAdapter(Protocol):
    def get_dataset(self, api_key: str) -> Any:
        ...


@dataclass(frozen=True)
class FinLabBackfillRequest:
    api_key: str
    dataset_lane: str
    primary_keys: tuple[str, ...] = ("symbol", "date")
    compare_fields: tuple[str, ...] = ()
    years: int = 5
    market: str = "tw"
    start_date: str | None = None
    end_date: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FinLabMaterializedDataset:
    api_key: str
    dataset_lane: str
    row_count: int
    rows: tuple[dict[str, Any], ...]
    checksum: str
    generated_at: str
    raw_path: str | None = None
    clean_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["rows"] = list(self.rows)
        return payload


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return _as_jsonable(value.item())
        except Exception:
            pass
    return str(value)


def _records_from_dataframe_like(dataset: Any) -> list[dict[str, Any]]:
    if hasattr(dataset, "to_dicts"):
        return [dict(row) for row in dataset.to_dicts()]

    if hasattr(dataset, "to_dict"):
        try:
            records = dataset.to_dict(orient="records")
            if isinstance(records, list):
                return [dict(row) for row in records if isinstance(row, dict)]
        except TypeError:
            pass

    return []


def _wide_dataframe_to_long_rows(dataset: Any) -> list[dict[str, Any]]:
    if not hasattr(dataset, "reset_index") or not hasattr(dataset, "columns"):
        return []
    try:
        reset = dataset.reset_index()
        records = reset.to_dict(orient="records")
    except Exception:
        return []
    if not records:
        return []
    columns = [str(col) for col in getattr(reset, "columns", [])]
    if not columns:
        return []
    date_col = columns[0]
    long_rows: list[dict[str, Any]] = []
    for record in records:
        record_dict = dict(record)
        record_date = _as_jsonable(record_dict.get(date_col))
        for symbol, value in record_dict.items():
            if str(symbol) == date_col:
                continue
            if value is None:
                continue
            long_rows.append(
                {
                    "symbol": str(symbol),
                    "date": record_date,
                    "value": _as_jsonable(value),
                }
            )
    return long_rows


def rows_from_dataset(dataset: Any) -> list[dict[str, Any]]:
    if dataset is None:
        return []
    if isinstance(dataset, list):
        return [dict(row) for row in dataset if isinstance(row, dict)]
    if isinstance(dataset, tuple):
        return [dict(row) for row in dataset if isinstance(row, dict)]
    if isinstance(dataset, dict):
        rows = dataset.get("rows")
        if isinstance(rows, list):
            return [dict(row) for row in rows if isinstance(row, dict)]
        return [dict(dataset)]

    records = _records_from_dataframe_like(dataset)
    if records:
        has_symbol = any("symbol" in row or "stock_id" in row for row in records)
        has_date = any("date" in row for row in records)
        if has_symbol or has_date:
            return records

    wide_rows = _wide_dataframe_to_long_rows(dataset)
    return wide_rows or records


def _normalize_symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or row.get("stock_id") or row.get("證券代號") or "").strip()


def _normalize_date(row: dict[str, Any]) -> str:
    for key in ("date", "period", "published_at", "年月", "資料日期"):
        value = row.get(key)
        if value not in (None, ""):
            return str(_as_jsonable(value))[:10]
    return ""


def normalize_finlab_rows(
    *,
    api_key: str,
    dataset_lane: str,
    rows: Iterable[dict[str, Any]],
    generated_at: str,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for raw in rows:
        row = {str(key): _as_jsonable(value) for key, value in dict(raw).items()}
        symbol = _normalize_symbol(row)
        row_date = _normalize_date(row)
        if symbol:
            row["symbol"] = symbol
        if row_date:
            row["date"] = row_date
        row["_source"] = "finlab"
        row["_api_key"] = api_key
        row["_dataset_lane"] = dataset_lane
        row["_generated_at"] = generated_at
        normalized.append(row)
    return normalized


def _within_date_window(row: dict[str, Any], *, start_date: str | None, end_date: str | None) -> bool:
    if not start_date and not end_date:
        return True
    row_date = str(row.get("date") or "")[:10]
    if not row_date:
        return True
    if start_date and row_date < start_date:
        return False
    if end_date and row_date > end_date:
        return False
    return True


def _key(row: dict[str, Any], primary_keys: Iterable[str]) -> tuple[Any, ...]:
    return tuple(row.get(key) for key in primary_keys)


def _compare_value(value: Any) -> Any:
    if value is None:
        return None
    try:
        return round(float(value), 8)
    except (TypeError, ValueError):
        return str(value).strip()


def build_source_diff_report(
    *,
    dataset_lane: str,
    finlab_rows: Iterable[dict[str, Any]],
    stockvision_rows: Iterable[dict[str, Any]],
    primary_keys: Iterable[str],
    compare_fields: Iterable[str],
    generated_at: str | None = None,
) -> dict[str, Any]:
    keys = tuple(primary_keys)
    fields = tuple(compare_fields)
    finlab_by_key = {_key(row, keys): dict(row) for row in finlab_rows if all(row.get(key) not in (None, "") for key in keys)}
    stockvision_by_key = {_key(row, keys): dict(row) for row in stockvision_rows if all(row.get(key) not in (None, "") for key in keys)}

    missing_in_stockvision: list[dict[str, Any]] = []
    missing_in_finlab: list[dict[str, Any]] = []
    value_conflicts: list[dict[str, Any]] = []
    matched = 0

    for key, finlab_row in finlab_by_key.items():
        stockvision_row = stockvision_by_key.get(key)
        if stockvision_row is None:
            missing_in_stockvision.append(finlab_row)
            continue
        conflicts = []
        for field in fields:
            finlab_value = _compare_value(finlab_row.get(field))
            stockvision_value = _compare_value(stockvision_row.get(field))
            if finlab_value != stockvision_value:
                conflicts.append(
                    {
                        "field": field,
                        "finlab": finlab_row.get(field),
                        "stockvision": stockvision_row.get(field),
                    }
                )
        if conflicts:
            value_conflicts.append(
                {
                    "primary_key": dict(zip(keys, key, strict=False)),
                    "conflicts": conflicts,
                    "finlab_row": finlab_row,
                    "stockvision_row": stockvision_row,
                }
            )
        else:
            matched += 1

    for key, stockvision_row in stockvision_by_key.items():
        if key not in finlab_by_key:
            missing_in_finlab.append(stockvision_row)

    finlab_fields = {field for row in finlab_by_key.values() for field in row}
    stockvision_fields = {field for row in stockvision_by_key.values() for field in row}
    report = {
        "schema_version": SCHEMA_VERSION,
        "dataset_lane": dataset_lane,
        "generated_at": generated_at or utc_now(),
        "primary_keys": list(keys),
        "compare_fields": list(fields),
        "summary": {
            "finlab_rows": len(finlab_by_key),
            "stockvision_rows": len(stockvision_by_key),
            "matched": matched,
            "missing_in_stockvision": len(missing_in_stockvision),
            "missing_in_finlab": len(missing_in_finlab),
            "value_conflicts": len(value_conflicts),
            "schema_extra_fields": sorted(finlab_fields - stockvision_fields),
        },
        "missing_in_stockvision": missing_in_stockvision,
        "missing_in_finlab": missing_in_finlab,
        "value_conflicts": value_conflicts,
    }
    report["checksum"] = sha256_json(
        {
            "dataset_lane": dataset_lane,
            "primary_keys": list(keys),
            "compare_fields": list(fields),
            "summary": report["summary"],
            "missing_in_stockvision": missing_in_stockvision,
            "value_conflicts": value_conflicts,
        }
    )
    return report


def build_gap_fill_rows(diff_report: dict[str, Any]) -> list[dict[str, Any]]:
    generated_at = str(diff_report.get("generated_at") or utc_now())
    dataset_lane = str(diff_report.get("dataset_lane") or "unknown")
    fill_rows: list[dict[str, Any]] = []
    for row in diff_report.get("missing_in_stockvision") or []:
        if not isinstance(row, dict):
            continue
        fill = dict(row)
        fill["_fill_source"] = "finlab"
        fill["_fill_reason"] = "missing_in_stockvision"
        fill["_dataset_lane"] = dataset_lane
        fill["_lineage"] = {
            "diff_checksum": diff_report.get("checksum"),
            "generated_at": generated_at,
            "conflict_policy": "do_not_fill_value_conflicts",
        }
        fill_rows.append(fill)
    return fill_rows


def finlab_backfill_run_d1_row(manifest: dict[str, Any]) -> dict[str, Any]:
    summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    return {
        "run_id": manifest.get("run_id"),
        "generated_at": manifest.get("generated_at"),
        "lookback_years": (manifest.get("dagster_runtime") or {}).get("lookback_years", 5),
        "dataset_count": summary.get("dataset_count", 0),
        "finlab_rows": summary.get("finlab_rows", 0),
        "gap_fill_rows": summary.get("gap_fill_rows", 0),
        "value_conflicts": summary.get("value_conflicts", 0),
        "checksum": manifest.get("checksum"),
        "status": "ready",
        "metadata_json": json.dumps(
            {
                "schema_version": manifest.get("schema_version"),
                "dagster_runtime": manifest.get("dagster_runtime"),
                "artifact_paths": [
                    {"api_key": dataset.get("api_key"), "clean_path": dataset.get("clean_path")}
                    for dataset in manifest.get("datasets") or []
                    if isinstance(dataset, dict)
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        ),
    }


def source_diff_report_d1_rows(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    run_id = manifest.get("run_id")
    for report in manifest.get("diff_reports") or []:
        if not isinstance(report, dict):
            continue
        summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
        rows.append(
            {
                "run_id": run_id,
                "dataset_lane": report.get("dataset_lane"),
                "source": "finlab",
                "generated_at": report.get("generated_at") or manifest.get("generated_at"),
                "finlab_rows": summary.get("finlab_rows", 0),
                "stockvision_rows": summary.get("stockvision_rows", 0),
                "matched_rows": summary.get("matched", 0),
                "missing_in_stockvision": summary.get("missing_in_stockvision", 0),
                "missing_in_finlab": summary.get("missing_in_finlab", 0),
                "value_conflicts": summary.get("value_conflicts", 0),
                "schema_extra_fields": json.dumps(summary.get("schema_extra_fields") or [], ensure_ascii=False, sort_keys=True),
                "report_json": json.dumps(report, ensure_ascii=False, sort_keys=True, default=str),
                "checksum": report.get("checksum"),
            }
        )
    return rows


class FinLabLocalBackfillStore:
    def __init__(self, base_dir: str | Path) -> None:
        self.base_dir = Path(base_dir)

    def _path(self, *parts: str) -> Path:
        path = self.base_dir.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def write_jsonl(self, path: str, rows: Iterable[dict[str, Any]]) -> str:
        target = self._path(path)
        with target.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True, default=str) + "\n")
        return str(target)

    def write_json(self, path: str, payload: dict[str, Any]) -> str:
        target = self._path(path)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")
        return str(target)


def materialize_finlab_dataset(
    *,
    adapter: FinLabDatasetAdapter,
    request: FinLabBackfillRequest,
    generated_at: str | None = None,
    store: FinLabLocalBackfillStore | None = None,
    run_id: str = "local",
) -> FinLabMaterializedDataset:
    timestamp = generated_at or utc_now()
    dataset = adapter.get_dataset(request.api_key)
    clean_rows = normalize_finlab_rows(
        api_key=request.api_key,
        dataset_lane=request.dataset_lane,
        rows=rows_from_dataset(dataset),
        generated_at=timestamp,
    )
    clean_rows = [
        row
        for row in clean_rows
        if _within_date_window(row, start_date=request.start_date, end_date=request.end_date)
    ]
    checksum = sha256_json(clean_rows)
    raw_path = clean_path = None
    if store:
        safe_key = request.api_key.replace(":", "__").replace("/", "_")
        raw_path = store.write_jsonl(f"{run_id}/raw/{safe_key}.jsonl", rows_from_dataset(dataset))
        clean_path = store.write_jsonl(f"{run_id}/clean/{safe_key}.jsonl", clean_rows)

    return FinLabMaterializedDataset(
        api_key=request.api_key,
        dataset_lane=request.dataset_lane,
        row_count=len(clean_rows),
        rows=tuple(clean_rows),
        checksum=checksum,
        generated_at=timestamp,
        raw_path=raw_path,
        clean_path=clean_path,
    )


def run_finlab_backfill_diff(
    *,
    adapter: FinLabDatasetAdapter,
    requests: Iterable[FinLabBackfillRequest],
    stockvision_rows_by_lane: dict[str, Iterable[dict[str, Any]]] | None = None,
    store: FinLabLocalBackfillStore | None = None,
    run_id: str = "local",
    generated_at: str | None = None,
) -> dict[str, Any]:
    timestamp = generated_at or utc_now()
    materialized: list[FinLabMaterializedDataset] = []
    diff_reports: list[dict[str, Any]] = []
    gap_fill_rows: list[dict[str, Any]] = []
    stockvision_rows_by_lane = stockvision_rows_by_lane or {}

    for request in requests:
        dataset = materialize_finlab_dataset(
            adapter=adapter,
            request=request,
            generated_at=timestamp,
            store=store,
            run_id=run_id,
        )
        materialized.append(dataset)
        report = build_source_diff_report(
            dataset_lane=request.dataset_lane,
            finlab_rows=dataset.rows,
            stockvision_rows=stockvision_rows_by_lane.get(request.dataset_lane, []),
            primary_keys=request.primary_keys,
            compare_fields=request.compare_fields,
            generated_at=timestamp,
        )
        diff_reports.append(report)
        gap_fill_rows.extend(build_gap_fill_rows(report))
        if store:
            store.write_json(f"{run_id}/diff/{request.dataset_lane}.json", report)

    result = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "generated_at": timestamp,
        "datasets": [dataset.to_dict() for dataset in materialized],
        "diff_reports": diff_reports,
        "gap_fill_rows": gap_fill_rows,
        "summary": {
            "dataset_count": len(materialized),
            "finlab_rows": sum(dataset.row_count for dataset in materialized),
            "gap_fill_rows": len(gap_fill_rows),
            "value_conflicts": sum(report["summary"]["value_conflicts"] for report in diff_reports),
            "missing_in_stockvision": sum(report["summary"]["missing_in_stockvision"] for report in diff_reports),
        },
    }
    result["checksum"] = sha256_json(
        {
            "run_id": run_id,
            "summary": result["summary"],
            "diff_checksums": [report["checksum"] for report in diff_reports],
        }
    )
    if store:
        store.write_json(f"{run_id}/manifest.json", result)
        store.write_jsonl(f"{run_id}/gap_fill/gap_fill_rows.jsonl", gap_fill_rows)
    return result
