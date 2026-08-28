"""Paired post-exit continuation validation for State-space v2.

This read-only evaluator does not invent a replacement exit formula. It asks a
strict prerequisite question on the exact incumbent S12 profit exits: did the
price continue after the recorded exit, and did the PIT State-space forecast
identify that continuation? Hard-stop and bearish-defense exits are excluded
because the candidate is never allowed to override them.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import math
import tomllib
import urllib.parse
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
BASE_SPEC = importlib.util.spec_from_file_location(
    "s12_state_space_pit_validation",
    REPO_ROOT / "tools" / "s12_state_space_pit_validation.py",
)
assert BASE_SPEC and BASE_SPEC.loader
BASE = importlib.util.module_from_spec(BASE_SPEC)
BASE_SPEC.loader.exec_module(BASE)

OPS_DB_ID = "d9914406-bb36-45a4-bdc4-fe565ed910d3"
R2_BUCKET = "stockvision-artifacts"
PROFIT_EXIT_REASONS = {"tp1", "tp2", "tp3", "time_exit"}
WRANGLER_AUTH_FILE = Path.home() / "AppData/Roaming/xdg.config/.wrangler/config/default.toml"
HORIZON_MINUTES = (30, 60, 120)


def load_manifests(
    client: Any,
    start_date: str,
    end_date: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = client.query(
            OPS_DB_ID,
            """
            SELECT r2_key, checksum, business_date, producer_run_id
              FROM run_artifacts
             WHERE domain = ? AND status = 'ready'
               AND business_date >= ? AND business_date <= ?
             ORDER BY business_date, r2_key
             LIMIT 2000 OFFSET ?
            """,
            ["s12_research_minute_bars", start_date, end_date, offset],
        )
        rows.extend(page)
        if len(page) < 2000:
            break
        offset += len(page)
    return rows


def _manifest_symbol(row: dict[str, Any]) -> str:
    return str(row.get("producer_run_id") or "").rsplit(":", 1)[-1]


def select_required_manifests(
    outcomes: pl.DataFrame,
    manifests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    requested: dict[str, list[tuple[date, date]]] = defaultdict(list)
    for row in outcomes.iter_rows(named=True):
        trade_date = date.fromisoformat(str(row["trade_date"]))
        requested[str(row["symbol"])].append((trade_date, trade_date + timedelta(days=14)))
    selected: dict[str, dict[str, Any]] = {}
    for manifest in manifests:
        symbol = _manifest_symbol(manifest)
        business_date = date.fromisoformat(str(manifest["business_date"]))
        if any(start <= business_date <= end for start, end in requested.get(symbol, [])):
            selected[str(manifest["r2_key"])] = manifest
    return sorted(selected.values(), key=lambda row: (str(row["business_date"]), str(row["r2_key"])))


def _oauth_token(path: Path = WRANGLER_AUTH_FILE) -> str:
    token = str(tomllib.loads(path.read_text(encoding="utf-8")).get("oauth_token") or "").strip()
    if not token:
        raise RuntimeError("wrangler_oauth_token_missing")
    return token


async def download_artifacts(
    manifests: list[dict[str, Any]],
    *,
    account_id: str,
    concurrency: int = 20,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    token = _oauth_token()
    semaphore = asyncio.Semaphore(max(1, concurrency))
    documents: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, str]] = []
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=45.0) as client:
        async def fetch_one(manifest: dict[str, Any]) -> None:
            key = str(manifest["r2_key"])
            url = (
                f"https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/"
                f"{R2_BUCKET}/objects/{urllib.parse.quote(key, safe='/')}"
            )
            try:
                async with semaphore:
                    response = await client.get(url)
                response.raise_for_status()
                body = response.content
                expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
                actual = hashlib.sha256(body).hexdigest()
                if not expected or actual != expected:
                    raise RuntimeError("checksum_mismatch")
                document = response.json()
                if (
                    document.get("schema_version") != "s12-research-minute-bars-v2"
                    or str(document.get("business_date")) != str(manifest.get("business_date"))
                    or not isinstance(document.get("payload", {}).get("bars"), list)
                ):
                    raise RuntimeError("artifact_contract_mismatch")
                documents[key] = document
            except Exception as exc:
                errors.append({"r2_key": key, "error": f"{type(exc).__name__}:{exc}"})

        await asyncio.gather(*(fetch_one(manifest) for manifest in manifests))
    return documents, errors


def _tw_date(epoch_ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp((epoch_ms + 8 * 3600_000) / 1000.0, tz=timezone.utc).date().isoformat()


def build_post_exit_samples(
    outcomes: pl.DataFrame,
    manifests: list[dict[str, Any]],
    documents: dict[str, dict[str, Any]],
) -> tuple[pl.DataFrame, dict[str, Any]]:
    bars_by_symbol: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for manifest in manifests:
        key = str(manifest["r2_key"])
        document = documents.get(key)
        if not document:
            continue
        symbol = str(document.get("payload", {}).get("symbol") or _manifest_symbol(manifest))
        for bar in document.get("payload", {}).get("bars", []):
            try:
                start_ms = int(bar["startMs"])
                close = float(bar["close"])
                high = float(bar["high"])
                low = float(bar["low"])
            except (KeyError, TypeError, ValueError):
                continue
            if all(math.isfinite(value) and value > 0 for value in (close, high, low)):
                bars_by_symbol[symbol][start_ms] = {
                    "startMs": start_ms,
                    "close": close,
                    "high": high,
                    "low": low,
                }

    samples: list[dict[str, Any]] = []
    unavailable: dict[str, int] = defaultdict(int)
    for row in outcomes.iter_rows(named=True):
        symbol = str(row["symbol"])
        exit_ms = int(row["exit_ms"] or 0)
        exit_price = float(row["exit_price"] or 0)
        if exit_ms <= 0 or exit_price <= 0:
            unavailable["invalid_exit_identity"] += 1
            continue
        future = sorted(
            (bar for start_ms, bar in bars_by_symbol.get(symbol, {}).items() if start_ms > exit_ms),
            key=lambda bar: int(bar["startMs"]),
        )
        if not future:
            unavailable["no_post_exit_bars"] += 1
            continue
        exit_tw_date = _tw_date(exit_ms)
        sample = dict(row)
        sample["exit_tw_date"] = exit_tw_date
        for minutes in HORIZON_MINUTES:
            deadline = exit_ms + minutes * 60_000
            eligible = [bar for bar in future if int(bar["startMs"]) <= deadline]
            sample[f"continuation_{minutes}m"] = (
                float(eligible[-1]["close"] / exit_price - 1.0) if eligible else None
            )
        same_session = [bar for bar in future if _tw_date(int(bar["startMs"])) == exit_tw_date]
        later_sessions = [bar for bar in future if _tw_date(int(bar["startMs"])) > exit_tw_date]
        sample["continuation_session_close"] = (
            float(same_session[-1]["close"] / exit_price - 1.0) if same_session else None
        )
        next_session_date = min((_tw_date(int(bar["startMs"])) for bar in later_sessions), default=None)
        next_session = [bar for bar in later_sessions if _tw_date(int(bar["startMs"])) == next_session_date]
        sample["continuation_next_session_close"] = (
            float(next_session[-1]["close"] / exit_price - 1.0) if next_session else None
        )
        horizon_60 = [bar for bar in future if int(bar["startMs"]) <= exit_ms + 60 * 60_000]
        sample["post_exit_mfe_60m"] = (
            float(max(bar["high"] for bar in horizon_60) / exit_price - 1.0) if horizon_60 else None
        )
        sample["post_exit_mae_60m"] = (
            float(min(bar["low"] for bar in horizon_60) / exit_price - 1.0) if horizon_60 else None
        )
        samples.append(sample)
    return (pl.DataFrame(samples) if samples else pl.DataFrame()), dict(unavailable)


def _mean_lcb90(values: list[float]) -> dict[str, Any]:
    array = np.asarray([value for value in values if math.isfinite(value)], dtype=np.float64)
    if array.size == 0:
        return {"n": 0, "mean": None, "lcb90": None}
    mean = float(array.mean())
    if array.size < 2:
        return {"n": 1, "mean": mean, "lcb90": None}
    lcb = mean - 1.6448536269514722 * float(array.std(ddof=1) / math.sqrt(array.size))
    return {"n": int(array.size), "mean": mean, "lcb90": lcb}


def evaluate_post_exit(samples: pl.DataFrame) -> dict[str, Any]:
    if samples.is_empty():
        return {"status": "unavailable", "reason": "no_post_exit_samples"}
    result: dict[str, Any] = {
        "status": "complete",
        "contract": "state-space-v2-s12-post-exit-continuation-v1",
        "rank_or_top_k_used": False,
        "formal_promotion_effect": False,
        "rows": samples.height,
        "dates": samples["signal_date"].n_unique(),
        "symbols": samples["symbol"].n_unique(),
        "horizons": {},
    }
    for horizon in (
        "continuation_30m",
        "continuation_60m",
        "continuation_120m",
        "continuation_session_close",
        "continuation_next_session_close",
    ):
        frame = samples.filter(pl.col(horizon).is_not_null())
        if frame.is_empty():
            result["horizons"][horizon] = {"rows": 0}
            continue
        positive = frame.filter(pl.col("forecast_positive"))
        non_positive = frame.filter(~pl.col("forecast_positive"))
        date_positive_means: list[float] = []
        date_spreads: list[float] = []
        for signal_date in frame["signal_date"].unique().to_list():
            day = frame.filter(pl.col("signal_date") == signal_date)
            day_positive = day.filter(pl.col("forecast_positive"))
            day_non_positive = day.filter(~pl.col("forecast_positive"))
            if day_positive.height:
                date_positive_means.append(float(day_positive[horizon].mean()))
            if day_positive.height and day_non_positive.height:
                date_spreads.append(float(day_positive[horizon].mean() - day_non_positive[horizon].mean()))
        x = frame["forecast_return"].to_numpy()
        y = frame[horizon].to_numpy()
        result["horizons"][horizon] = {
            "rows": frame.height,
            "dates": frame["signal_date"].n_unique(),
            "row_pearson": BASE._pearson(x, y),
            "direction_accuracy": float(
                (frame["forecast_positive"] == (frame[horizon] > 0)).mean()
            ),
            "all_mean": float(frame[horizon].mean()),
            "positive_forecast_rows": positive.height,
            "positive_forecast_mean": float(positive[horizon].mean()) if positive.height else None,
            "non_positive_forecast_rows": non_positive.height,
            "non_positive_forecast_mean": float(non_positive[horizon].mean()) if non_positive.height else None,
            "positive_date_mean_lcb90": _mean_lcb90(date_positive_means),
            "positive_minus_non_positive_date_spread": _mean_lcb90(date_spreads),
        }
    result["result_checksum"] = BASE._sha256(result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        default=str(REPO_ROOT / "output/s12_state_space_pit_validation/joined_evidence.parquet"),
    )
    parser.add_argument(
        "--output-dir",
        default=str(REPO_ROOT / "output/s12_state_space_post_exit_validation"),
    )
    args = parser.parse_args()
    source = pl.read_parquet(args.input)
    profit_exits = source.filter(pl.col("exit_reason").is_in(sorted(PROFIT_EXIT_REASONS)))
    if profit_exits.is_empty():
        raise RuntimeError("no_profit_exit_outcomes")
    start_date = min(profit_exits["trade_date"].to_list())
    end_date = (
        date.fromisoformat(max(profit_exits["trade_date"].to_list())) + timedelta(days=14)
    ).isoformat()
    import os

    client = BASE.D1ReadClient(
        token=os.environ.get("CF_API_TOKEN", ""),
        account_id=os.environ.get("CF_ACCOUNT_ID", BASE.ACCOUNT_ID_DEFAULT),
    )
    try:
        manifests = load_manifests(client, start_date, end_date)
    finally:
        client.close()
    selected = select_required_manifests(profit_exits, manifests)
    documents, download_errors = asyncio.run(
        download_artifacts(selected, account_id=os.environ.get("CF_ACCOUNT_ID", BASE.ACCOUNT_ID_DEFAULT))
    )
    samples, unavailable = build_post_exit_samples(profit_exits, selected, documents)
    report = evaluate_post_exit(samples)
    report["source_receipt"] = {
        "profit_exit_outcomes": profit_exits.height,
        "manifest_window": {"start": start_date, "end": end_date},
        "manifests_scanned": len(manifests),
        "manifests_selected": len(selected),
        "artifacts_downloaded": len(documents),
        "download_errors": download_errors,
        "unavailable": unavailable,
        "input_checksum": BASE._sha256(source.to_dicts()),
        "selected_manifest_checksum": BASE._sha256(selected),
    }
    report["result_checksum"] = BASE._sha256(
        {key: value for key, value in report.items() if key != "result_checksum"}
    )
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    if not samples.is_empty():
        samples.write_parquet(output_dir / "post_exit_samples.parquet")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
