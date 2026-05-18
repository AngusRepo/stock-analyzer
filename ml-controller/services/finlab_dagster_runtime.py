from __future__ import annotations

from typing import Any, Iterable

from services.finlab_backfill_runtime import (
    FinLabBackfillRequest,
    FinLabDatasetAdapter,
    FinLabLocalBackfillStore,
    run_finlab_backfill_diff,
)


SCHEMA_VERSION = "finlab-dagster-runtime-v1"


def build_runtime_requests_from_adoption_plan(
    adoption_plan: dict[str, Any],
    *,
    years: int = 5,
    include_stages: Iterable[str] = ("parity", "diversity"),
    max_api_keys_per_lane: int = 3,
) -> list[FinLabBackfillRequest]:
    stages = set(include_stages)
    requests: list[FinLabBackfillRequest] = []
    for asset in adoption_plan.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        stage = str(asset.get("stage") or "")
        lane = str(asset.get("dataset_lane") or "")
        if stage not in stages or not lane:
            continue
        sample_keys = [
            str(api_key)
            for api_key in asset.get("sample_api_keys") or []
            if str(api_key).strip()
        ][:max_api_keys_per_lane]
        compare_fields = _default_compare_fields(lane)
        primary_keys = ("symbol", "date")
        if lane == "security_master":
            primary_keys = ("symbol",)
        for api_key in sample_keys:
            requests.append(
                FinLabBackfillRequest(
                    api_key=api_key,
                    dataset_lane=lane,
                    primary_keys=primary_keys,
                    compare_fields=compare_fields,
                    years=years,
                    market=(asset.get("markets") or ["tw"])[0],
                )
            )
    return requests


def _default_compare_fields(dataset_lane: str) -> tuple[str, ...]:
    if dataset_lane == "daily_price":
        return ("open", "high", "low", "close", "volume", "value")
    if dataset_lane == "revenue":
        return ("revenue", "value")
    if "chip" in dataset_lane:
        return ("foreign_net", "trust_net", "dealer_net", "total_net", "value")
    if dataset_lane == "security_master":
        return ("name", "market", "category")
    return ("value",)


def run_finlab_dagster_local_materialization(
    *,
    adapter: FinLabDatasetAdapter,
    adoption_plan: dict[str, Any],
    stockvision_rows_by_lane: dict[str, Iterable[dict[str, Any]]] | None,
    output_dir: str,
    run_id: str,
    generated_at: str | None = None,
    years: int = 5,
    max_api_keys_per_lane: int = 3,
) -> dict[str, Any]:
    requests = build_runtime_requests_from_adoption_plan(
        adoption_plan,
        years=years,
        max_api_keys_per_lane=max_api_keys_per_lane,
    )
    result = run_finlab_backfill_diff(
        adapter=adapter,
        requests=requests,
        stockvision_rows_by_lane=stockvision_rows_by_lane,
        store=FinLabLocalBackfillStore(output_dir),
        run_id=run_id,
        generated_at=generated_at,
    )
    result["dagster_runtime"] = {
        "schema_version": SCHEMA_VERSION,
        "mode": "local_materialization",
        "request_count": len(requests),
        "lookback_years": years,
        "output_dir": output_dir,
        "schedule_ready": True,
        "prod_schedule_enabled": False,
    }
    return result
