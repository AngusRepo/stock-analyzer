"""Rate-limit-safe runner for the S12 State-space post-exit validation."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import random
import tomllib
import urllib.parse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
POST_SPEC = importlib.util.spec_from_file_location(
    "post_exit_validation",
    REPO_ROOT / "tools/s12_state_space_post_exit_validation.py",
)
assert POST_SPEC and POST_SPEC.loader
POST = importlib.util.module_from_spec(POST_SPEC)
POST_SPEC.loader.exec_module(POST)

RUNNER_SPEC = importlib.util.spec_from_file_location(
    "post_exit_runner",
    REPO_ROOT / "tools/run_s12_state_space_post_exit_validation.py",
)
assert RUNNER_SPEC and RUNNER_SPEC.loader
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER)

CACHE_DIR = REPO_ROOT / "output/s12_state_space_post_exit_validation/r2_cache"


def _tw_date(epoch_ms: int) -> str:
    return datetime.fromtimestamp((epoch_ms + 8 * 3600_000) / 1000.0, tz=timezone.utc).date().isoformat()


def select_exit_session_manifests(
    outcomes: pl.DataFrame,
    manifests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_symbol: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for manifest in manifests:
        by_symbol[POST._manifest_symbol(manifest)].append(manifest)
    selected: dict[str, dict[str, Any]] = {}
    for row in outcomes.iter_rows(named=True):
        symbol = str(row["symbol"])
        exit_ms = int(row["exit_ms"] or 0)
        if exit_ms <= 0:
            continue
        exit_date = _tw_date(exit_ms)
        candidates = sorted(
            by_symbol.get(symbol, []), key=lambda item: (str(item["business_date"]), str(item["r2_key"]))
        )
        exact = [item for item in candidates if str(item["business_date"]) == exit_date]
        later = [
            item for item in candidates
            if exit_date < str(item["business_date"])
            <= (date.fromisoformat(exit_date) + timedelta(days=4)).isoformat()
        ]
        for manifest in exact[-1:] + later[:1]:
            selected[str(manifest["r2_key"])] = manifest
    return sorted(selected.values(), key=lambda item: (str(item["business_date"]), str(item["r2_key"])))


def _cache_path(manifest: dict[str, Any]) -> Path:
    checksum = str(manifest.get("checksum") or "").removeprefix("sha256:")
    return CACHE_DIR / f"{checksum}.json"


def _validated_cached_document(manifest: dict[str, Any]) -> dict[str, Any] | None:
    path = _cache_path(manifest)
    if not path.exists():
        return None
    body = path.read_bytes()
    expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
    if hashlib.sha256(body).hexdigest() != expected:
        path.unlink(missing_ok=True)
        return None
    return json.loads(body)


async def download_reliably(
    manifests: list[dict[str, Any]],
    *,
    account_id: str,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]], dict[str, int]]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    token = str(
        tomllib.loads(POST.WRANGLER_AUTH_FILE.read_text(encoding="utf-8")).get("oauth_token") or ""
    ).strip()
    if not token:
        raise RuntimeError("wrangler_oauth_token_missing")
    documents: dict[str, dict[str, Any]] = {}
    pending: list[dict[str, Any]] = []
    for manifest in manifests:
        cached = _validated_cached_document(manifest)
        if cached is None:
            pending.append(manifest)
        else:
            documents[str(manifest["r2_key"])] = cached

    errors: list[dict[str, str]] = []
    stats = {"cache_hits": len(documents), "network_downloads": 0, "rate_limit_retries": 0}
    # One request at a time keeps the Cloudflare user API below its documented
    # rolling burst response. 429 Retry-After is authoritative.
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=45.0) as client:
        for manifest in pending:
            key = str(manifest["r2_key"])
            url = (
                f"https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/"
                f"{POST.R2_BUCKET}/objects/{urllib.parse.quote(key, safe='/')}"
            )
            last_error: Exception | None = None
            for attempt in range(8):
                try:
                    response = await client.get(url)
                    if response.status_code == 429:
                        stats["rate_limit_retries"] += 1
                        retry_after = max(1.0, float(response.headers.get("retry-after") or 1.0))
                        await asyncio.sleep(retry_after + random.uniform(0.05, 0.25))
                        continue
                    response.raise_for_status()
                    body = response.content
                    expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
                    if hashlib.sha256(body).hexdigest() != expected:
                        raise RuntimeError("checksum_mismatch")
                    document = response.json()
                    if (
                        document.get("schema_version") != "s12-research-minute-bars-v2"
                        or str(document.get("business_date")) != str(manifest.get("business_date"))
                        or not isinstance(document.get("payload", {}).get("bars"), list)
                    ):
                        raise RuntimeError("artifact_contract_mismatch")
                    _cache_path(manifest).write_bytes(body)
                    documents[key] = document
                    stats["network_downloads"] += 1
                    last_error = None
                    break
                except Exception as exc:
                    last_error = exc
                    await asyncio.sleep(min(10.0, 0.5 * (2 ** attempt)))
            if last_error is not None:
                errors.append({"r2_key": key, "error": f"{type(last_error).__name__}:{last_error}"})
    return documents, errors, stats


def main() -> int:
    source = pl.read_parquet(
        REPO_ROOT / "output/s12_state_space_pit_validation/joined_evidence.parquet"
    )
    client = POST.BASE.D1ReadClient(
        token=os.environ.get("CF_API_TOKEN", ""),
        account_id=os.environ.get("CF_ACCOUNT_ID", POST.BASE.ACCOUNT_ID_DEFAULT),
    )
    try:
        timestamps = RUNNER.load_immutable_timestamps(client, source["id"].to_list())
        source = source.join(timestamps, on="id", how="left", validate="1:1")
        profit_exits = source.filter(pl.col("exit_reason").is_in(sorted(POST.PROFIT_EXIT_REASONS)))
        start_date = min(profit_exits["trade_date"].to_list())
        end_date = (
            date.fromisoformat(max(profit_exits["trade_date"].to_list())) + timedelta(days=14)
        ).isoformat()
        manifests = POST.load_manifests(client, start_date, end_date)
    finally:
        client.close()
    selected = select_exit_session_manifests(profit_exits, manifests)
    documents, download_errors, download_stats = asyncio.run(
        download_reliably(
            selected,
            account_id=os.environ.get("CF_ACCOUNT_ID", POST.BASE.ACCOUNT_ID_DEFAULT),
        )
    )
    samples, unavailable = POST.build_post_exit_samples(profit_exits, selected, documents)
    report = POST.evaluate_post_exit(samples)
    report["source_receipt"] = {
        "profit_exit_outcomes": profit_exits.height,
        "immutable_timestamp_rows": timestamps.height,
        "manifest_window": {"start": start_date, "end": end_date},
        "manifests_scanned": len(manifests),
        "manifests_selected": len(selected),
        "artifacts_downloaded": len(documents),
        "download_stats": download_stats,
        "download_errors": download_errors,
        "unavailable": unavailable,
        "input_checksum": POST.BASE._sha256(source.to_dicts()),
        "selected_manifest_checksum": POST.BASE._sha256(selected),
    }
    report["result_checksum"] = POST.BASE._sha256(
        {key: value for key, value in report.items() if key != "result_checksum"}
    )
    output_dir = REPO_ROOT / "output/s12_state_space_post_exit_validation"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report_reliable.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    if not samples.is_empty():
        samples.write_parquet(output_dir / "post_exit_samples_reliable.parquet")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
