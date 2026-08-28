"""Exact paired replay for the S12-native profit continuation candidate.

The runner is read-only. It binds immutable Learning D1 outcomes to checksum-
validated R2 minute bars, then calls the production TypeScript replay engine for
both incumbent and candidate paths. It never persists D1 state and never
submits orders.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tomllib
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from statistics import NormalDist
from typing import Any, Iterable

import httpx
import numpy as np
import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
INPUT_PARQUET = REPO_ROOT / "output/s12_state_space_post_exit_validation/post_exit_samples_reliable.parquet"
CACHE_DIR = REPO_ROOT / "output/s12_state_space_post_exit_validation/r2_cache"
OUTPUT_DIR = REPO_ROOT / "output/s12_profit_continuation_paired_replay"
LEARNING_DB_ID = "73599848-b73b-4bac-9144-df638b877dbc"
MARKET_DB_ID = "067bbeb0-1247-416a-96dd-138315345319"
CORE_DB_ID = "8cc0ab1f-088c-4c21-b282-bcd4c790c7da"
OPS_DB_ID = "d9914406-bb36-45a4-bdc4-fe565ed910d3"
R2_BUCKET = "stockvision-artifacts"
ACCOUNT_ID = "619a83ac9f20847d9e2f2920823b727d"
WRANGLER_AUTH_FILE = Path.home() / "AppData/Roaming/xdg.config/.wrangler/config/default.toml"
Z90 = NormalDist().inv_cdf(0.90)
Z90_THREE_WAY = NormalDist().inv_cdf(1 - 0.10 / 3)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def checksum(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def chunks(values: list[int], size: int) -> Iterable[list[int]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def oauth_token() -> str:
    token = str(tomllib.loads(WRANGLER_AUTH_FILE.read_text(encoding="utf-8")).get("oauth_token") or "").strip()
    if not token:
        raise RuntimeError("wrangler_oauth_token_missing")
    return token


def d1_rows(
    client: httpx.Client,
    database_id: str,
    sql: str,
    params: list[Any],
) -> list[dict[str, Any]]:
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/d1/database/{database_id}/query"
    )
    response = client.post(url, json={"sql": sql, "params": params})
    response.raise_for_status()
    payload = response.json()
    if not payload.get("success"):
        raise RuntimeError(f"d1_query_failed:{database_id}:{payload.get('errors')}")
    return list((payload.get("result") or [{}])[0].get("results") or [])


def query_details(ids: list[int]) -> dict[int, dict[str, Any]]:
    details: dict[int, dict[str, Any]] = {}
    with httpx.Client(
        headers={"Authorization": f"Bearer {oauth_token()}", "Content-Type": "application/json"},
        timeout=90.0,
    ) as client:
        for id_chunk in chunks(ids, 80):
            placeholders = ",".join("?" for _ in id_chunk)
            rows = d1_rows(
                client,
                LEARNING_DB_ID,
                f"SELECT id, detail_json FROM s12_replay_trade_outcomes WHERE id IN ({placeholders})",
                id_chunk,
            )
            for row in rows:
                raw = row.get("detail_json")
                parsed = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(parsed, dict):
                    details[int(row["id"])] = parsed
    return details


def validate_daily_context(
    rows: list[dict[str, Any]],
    reference_date: str | None,
    reference_close: float | None,
) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: str(item.get("date") or "")):
        try:
            date = str(row["date"])
            open_price = float(row["open"])
            high = max(float(row["high"]), open_price, float(row["close"]))
            low = min(float(row["low"]), open_price, float(row["close"]))
            close = float(row["close"])
            volume = max(0.0, float(row.get("volume") or 0))
            start_ms = int(datetime.fromisoformat(f"{date}T01:00:00+00:00").timestamp() * 1000)
        except (KeyError, TypeError, ValueError):
            continue
        bars.append({
            "startMs": start_ms,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        })
    if not bars or not reference_date or reference_close is None or reference_close <= 0:
        return []
    latest = bars[-1]
    if tw_date_from_epoch_ms(int(latest["startMs"])) != reference_date:
        return []
    if not 0.8 <= float(latest["close"]) / reference_close <= 1.2:
        return []
    contiguous = [latest]
    for current in reversed(bars[:-1]):
        newer = contiguous[0]
        close = float(current["close"])
        ohlc_in_domain = all(0.8 <= float(current[key]) / close <= 1.2 for key in ("open", "high", "low"))
        if not ohlc_in_domain or not 0.8 <= close / float(newer["close"]) <= 1.2:
            break
        contiguous.insert(0, current)
    return contiguous


def query_daily_contexts(source: pl.DataFrame) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    requests = sorted({
        (str(row["symbol"]), str(row["trade_date"]))
        for row in source.iter_rows(named=True)
    })
    symbols = sorted({symbol for symbol, _ in requests})
    identities: dict[str, int] = {}
    with httpx.Client(
        headers={"Authorization": f"Bearer {oauth_token()}", "Content-Type": "application/json"},
        timeout=90.0,
    ) as client:
        for symbol_chunk in chunks(list(range(len(symbols))), 80):
            selected = [symbols[index] for index in symbol_chunk]
            placeholders = ",".join("?" for _ in selected)
            rows = d1_rows(
                client,
                CORE_DB_ID,
                f"SELECT id, symbol FROM stocks WHERE symbol IN ({placeholders})",
                selected,
            )
            identities.update({str(row["symbol"]): int(row["id"]) for row in rows})
        numeric_symbols = sorted({str(value) for value in identities.values()})
        numeric_collisions: set[str] = set()
        for symbol_chunk in chunks(list(range(len(numeric_symbols))), 80):
            selected = [numeric_symbols[index] for index in symbol_chunk]
            placeholders = ",".join("?" for _ in selected)
            rows = d1_rows(
                client,
                CORE_DB_ID,
                f"SELECT symbol FROM stocks WHERE symbol IN ({placeholders})",
                selected,
            )
            numeric_collisions.update(str(row["symbol"]) for row in rows)

        contexts: dict[str, list[dict[str, Any]]] = {}
        context_checksums: dict[str, str] = {}
        missing_identity = 0
        for request_chunk in chunks(list(range(len(requests))), 8):
            selected_requests = []
            for index in request_chunk:
                symbol, trade_date = requests[index]
                numeric_id = identities.get(symbol)
                if numeric_id is None:
                    missing_identity += 1
                    continue
                selected_requests.append({
                    "request_key": f"{symbol}|{trade_date}",
                    "symbol": symbol,
                    "numeric_id": numeric_id,
                    "trade_date": trade_date,
                    "numeric_collision": 1 if str(numeric_id) in numeric_collisions else 0,
                })
            if not selected_requests:
                continue
            packet = canonical_json(selected_requests)
            daily_rows = d1_rows(
                client,
                MARKET_DB_ID,
                """
                WITH requested AS (
                  SELECT
                    json_extract(value, '$.request_key') AS request_key,
                    json_extract(value, '$.symbol') AS symbol,
                    CAST(json_extract(value, '$.numeric_id') AS TEXT) AS numeric_id,
                    json_extract(value, '$.trade_date') AS trade_date,
                    CAST(json_extract(value, '$.numeric_collision') AS INTEGER) AS numeric_collision
                    FROM json_each(?)
                ),
                candidate_rows AS (
                  SELECT req.request_key, cmd.date, cmd.open, cmd.high, cmd.low, cmd.close,
                         cmd.volume, cmd.source, cmd.created_at, 0 AS namespace_rank
                    FROM requested req
                    JOIN canonical_market_daily cmd ON cmd.stock_id = req.symbol
                   WHERE cmd.date < req.trade_date
                     AND cmd.open IS NOT NULL AND cmd.high IS NOT NULL
                     AND cmd.low IS NOT NULL AND cmd.close IS NOT NULL
                  UNION ALL
                  SELECT req.request_key, cmd.date, cmd.open, cmd.high, cmd.low, cmd.close,
                         cmd.volume, cmd.source, cmd.created_at, 1 AS namespace_rank
                    FROM requested req
                    JOIN canonical_market_daily cmd ON cmd.stock_id = req.numeric_id
                   WHERE req.numeric_collision = 0
                     AND cmd.date < req.trade_date
                     AND cmd.open IS NOT NULL AND cmd.high IS NOT NULL
                     AND cmd.low IS NOT NULL AND cmd.close IS NOT NULL
                ),
                source_ranked AS (
                  SELECT *,
                         ROW_NUMBER() OVER (
                           PARTITION BY request_key, date
                           ORDER BY namespace_rank,
                                    CASE WHEN source LIKE 'finlab%' THEN 0 ELSE 1 END,
                                    created_at DESC
                         ) AS source_rank
                    FROM candidate_rows
                ),
                date_ranked AS (
                  SELECT *,
                         ROW_NUMBER() OVER (PARTITION BY request_key ORDER BY date DESC) AS date_rank
                    FROM source_ranked
                   WHERE source_rank = 1
                )
                SELECT request_key, date, open, high, low, close, volume
                  FROM date_ranked
                 WHERE date_rank <= 120
                 ORDER BY request_key, date
                """,
                [packet],
            )
            reference_rows = d1_rows(
                client,
                MARKET_DB_ID,
                """
                WITH requested AS (
                  SELECT
                    json_extract(value, '$.request_key') AS request_key,
                    CAST(json_extract(value, '$.numeric_id') AS INTEGER) AS numeric_id,
                    json_extract(value, '$.trade_date') AS trade_date
                    FROM json_each(?)
                ),
                ranked AS (
                  SELECT req.request_key, sp.date, sp.close,
                         ROW_NUMBER() OVER (PARTITION BY req.request_key ORDER BY sp.date DESC) AS row_rank
                    FROM requested req
                    JOIN stock_prices sp ON sp.stock_id = req.numeric_id
                   WHERE sp.date < req.trade_date
                     AND sp.close IS NOT NULL
                )
                SELECT request_key, date, close
                  FROM ranked
                 WHERE row_rank = 1
                """,
                [packet],
            )
            grouped: dict[str, list[dict[str, Any]]] = {}
            for row in daily_rows:
                grouped.setdefault(str(row["request_key"]), []).append(row)
            references = {
                str(row["request_key"]): (str(row["date"]), float(row["close"]))
                for row in reference_rows
            }
            for request in selected_requests:
                key = request["request_key"]
                reference = references.get(key)
                validated = validate_daily_context(
                    grouped.get(key, []),
                    reference[0] if reference else None,
                    reference[1] if reference else None,
                )
                contexts[key] = validated
                context_checksums[key] = checksum(validated)
    return contexts, {
        "requests": len(requests),
        "contexts": sum(1 for bars in contexts.values() if bars),
        "missing_identity": missing_identity,
        "context_checksum": checksum(context_checksums),
    }


def load_selected_bars(
    manifests: list[dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    by_request: dict[str, list[dict[str, Any]]] = {}
    accepted_checksums: list[str] = []
    for manifest in manifests:
        expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
        path = CACHE_DIR / f"{expected}.json"
        if not expected or not path.exists():
            raise RuntimeError(f"r2_selected_cache_missing:{manifest.get('request_key')}:{expected}")
        body = path.read_bytes()
        if hashlib.sha256(body).hexdigest() != expected:
            raise RuntimeError(f"r2_cache_checksum_mismatch:{path.name}")
        document = json.loads(body)
        if (
            document.get("schema_version") != "s12-research-minute-bars-v2"
            or str(document.get("business_date") or "") != str(manifest.get("business_date") or "")
        ):
            raise RuntimeError(f"r2_cache_contract_mismatch:{path.name}")
        payload = document.get("payload") or {}
        symbol = str(payload.get("symbol") or "").strip()
        bars = payload.get("bars")
        if symbol != str(manifest.get("symbol") or "") or not isinstance(bars, list):
            raise RuntimeError(f"r2_cache_payload_missing:{path.name}")
        target: dict[int, dict[str, Any]] = {}
        trade_date = str(manifest.get("trade_date") or "")
        for raw in bars:
            try:
                start_ms = int(raw["startMs"])
                values = {
                    "startMs": start_ms,
                    "open": float(raw["open"]),
                    "high": float(raw["high"]),
                    "low": float(raw["low"]),
                    "close": float(raw["close"]),
                    "volume": float(raw.get("volume") or 0),
                }
            except (KeyError, TypeError, ValueError):
                continue
            if (
                all(math.isfinite(values[key]) and values[key] > 0 for key in ("open", "high", "low", "close"))
                and tw_date_from_epoch_ms(start_ms) <= trade_date
            ):
                target[start_ms] = values
        request_key = str(manifest.get("request_key") or "")
        by_request[request_key] = [target[key] for key in sorted(target)]
        accepted_checksums.append(expected)
    return by_request, {
        "artifacts": len(accepted_checksums),
        "symbols": len({str(manifest.get("symbol") or "") for manifest in manifests}),
        "cache_checksum": checksum(sorted(accepted_checksums)),
        "selection_checksum": checksum(manifests),
    }


def tw_date_from_epoch_ms(epoch_ms: int) -> str:
    return datetime.fromtimestamp((epoch_ms + 8 * 3_600_000) / 1000, tz=timezone.utc).date().isoformat()


def lifecycle_dates(detail: dict[str, Any]) -> list[str]:
    diagnostics = detail.get("replay_diagnostics")
    if not isinstance(diagnostics, dict):
        return []
    return [
        value.strip()
        for value in str(diagnostics.get("lifecycle_session_dates") or "").split(",")
        if len(value.strip()) == 10
    ]


def select_and_cache_replay_artifacts(
    source: pl.DataFrame,
    details: dict[int, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    requests: set[tuple[str, str, str]] = set()
    for row in source.iter_rows(named=True):
        symbol = str(row["symbol"])
        detail = details.get(int(row["id"]))
        for session_date in lifecycle_dates(detail or {}):
            requests.add((f"{symbol}|{session_date}", symbol, session_date))
    request_rows = [
        {"request_key": request_key, "symbol": symbol, "trade_date": trade_date}
        for request_key, symbol, trade_date in requests
    ]
    packet = canonical_json(request_rows)
    with httpx.Client(
        headers={"Authorization": f"Bearer {oauth_token()}", "Content-Type": "application/json"},
        timeout=90.0,
    ) as client:
        manifests = d1_rows(
            client,
            OPS_DB_ID,
            """
            WITH requested AS (
              SELECT
                json_extract(value, '$.request_key') AS request_key,
                json_extract(value, '$.symbol') AS symbol,
                json_extract(value, '$.trade_date') AS trade_date
                FROM json_each(?)
            ),
            ranked AS (
              SELECT req.request_key, req.symbol, req.trade_date,
                     ra.r2_key, ra.checksum, ra.business_date,
                     ROW_NUMBER() OVER (
                       PARTITION BY req.request_key
                       ORDER BY ra.business_date ASC, ra.created_at DESC, ra.r2_key ASC
                     ) AS row_rank
                FROM requested req
                JOIN run_artifacts ra
                  ON ra.domain = 's12_research_minute_bars'
                 AND ra.status = 'ready'
                 AND ra.producer_run_id LIKE '%:' || req.symbol
                 AND ra.business_date >= req.trade_date
                 AND ra.business_date <= date(req.trade_date, '+7 days')
            )
            SELECT request_key, symbol, trade_date, r2_key, checksum, business_date
              FROM ranked
             WHERE row_rank = 1
             ORDER BY request_key
            """,
            [packet],
        )
        errors = []
        downloaded = 0
        for manifest in manifests:
            expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
            cache_path = CACHE_DIR / f"{expected}.json"
            if cache_path.exists() and hashlib.sha256(cache_path.read_bytes()).hexdigest() == expected:
                continue
            key = str(manifest["r2_key"])
            url = (
                f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/"
                f"{R2_BUCKET}/objects/{urllib.parse.quote(key, safe='/')}"
            )
            try:
                response = client.get(url)
                response.raise_for_status()
                body = response.content
                if not expected or hashlib.sha256(body).hexdigest() != expected:
                    raise RuntimeError("checksum_mismatch")
                document = response.json()
                if (
                    document.get("schema_version") != "s12-research-minute-bars-v2"
                    or str(document.get("business_date")) != str(manifest.get("business_date"))
                    or str(document.get("payload", {}).get("symbol") or "") != str(manifest.get("symbol") or "")
                    or not isinstance(document.get("payload", {}).get("bars"), list)
                ):
                    raise RuntimeError("artifact_contract_mismatch")
                cache_path.write_bytes(body)
                downloaded += 1
            except Exception as exc:
                errors.append({
                    "request_key": str(manifest.get("request_key") or ""),
                    "r2_key": key,
                    "error": f"{type(exc).__name__}:{exc}",
                })
    return manifests, {
        "requested": len(request_rows),
        "selected": len(manifests),
        "downloaded": downloaded,
        "errors": errors,
        "manifest_checksum": checksum(manifests),
    }


def mean_lcb(values: list[float], z_value: float = Z90) -> dict[str, Any]:
    array = np.asarray([value for value in values if math.isfinite(value)], dtype=np.float64)
    if array.size == 0:
        return {"n": 0, "mean": None, "lcb": None}
    mean = float(array.mean())
    if array.size == 1:
        return {"n": 1, "mean": mean, "lcb": None}
    return {
        "n": int(array.size),
        "mean": mean,
        "lcb": mean - z_value * float(array.std(ddof=1) / math.sqrt(array.size)),
    }


def date_means(frame: pl.DataFrame, column: str) -> list[float]:
    return [
        float(frame.filter(pl.col("signal_date") == day)[column].mean())
        for day in sorted(frame["signal_date"].unique().to_list())
    ]


def portfolio_metrics(frame: pl.DataFrame, column: str) -> dict[str, Any]:
    if frame.is_empty() or column not in frame.columns:
        returns = np.asarray([], dtype=np.float64)
    else:
        returns = np.asarray(date_means(frame, column), dtype=np.float64)
    if returns.size == 0:
        return {
            "dates": 0,
            "cumulative_return": None,
            "max_drawdown": None,
            "p10": None,
            "cvar10": None,
        }
    wealth = np.cumprod(1.0 + returns)
    running_peak = np.maximum.accumulate(wealth)
    drawdowns = wealth / running_peak - 1.0
    p10 = float(np.quantile(returns, 0.10))
    tail = returns[returns <= p10]
    return {
        "dates": int(returns.size),
        "cumulative_return": float(wealth[-1] - 1.0),
        "max_drawdown": float(drawdowns.min()),
        "p10": p10,
        "cvar10": float(tail.mean()) if tail.size else p10,
    }


def slice_report(frame: pl.DataFrame, dates: list[str]) -> dict[str, Any]:
    subset = (
        frame.filter(pl.col("signal_date").is_in(dates))
        if dates and "signal_date" in frame.columns
        else pl.DataFrame()
    )
    return {
        "start": dates[0] if dates else None,
        "end": dates[-1] if dates else None,
        "rows": subset.height,
        "dates": len(dates),
        "date_cluster_delta": mean_lcb(date_means(subset, "cost_net_delta_pct")) if dates else mean_lcb([]),
        "candidate_mean_pnl_pct": float(subset["candidate_pnl_pct"].mean()) if subset.height else None,
        "incumbent_mean_pnl_pct": float(subset["incumbent_pnl_pct"].mean()) if subset.height else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(INPUT_PARQUET))
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source = pl.read_parquet(Path(args.input).resolve())
    details = query_details([int(value) for value in source["id"].to_list()])
    selected_manifests, entry_artifact_receipt = select_and_cache_replay_artifacts(source, details)
    bars_by_request, cache_receipt = load_selected_bars(selected_manifests)
    daily_contexts, daily_context_receipt = query_daily_contexts(source)

    fixtures: list[dict[str, Any]] = []
    missing: dict[str, int] = {}
    for row in source.iter_rows(named=True):
        detail = details.get(int(row["id"]))
        if detail is None:
            missing["detail_json"] = missing.get("detail_json", 0) + 1
            continue
        requested_dates = lifecycle_dates(detail)
        if not requested_dates:
            missing["lifecycle_session_dates"] = missing.get("lifecycle_session_dates", 0) + 1
            continue
        merged_bars: dict[int, dict[str, Any]] = {}
        for session_date in requested_dates:
            for bar in bars_by_request.get(f"{row['symbol']}|{session_date}", []):
                merged_bars[int(bar["startMs"])] = bar
        bars = [merged_bars[key] for key in sorted(merged_bars)]
        if not bars:
            missing["r2_bars"] = missing.get("r2_bars", 0) + 1
            continue
        requested_date_set = set(requested_dates)
        bounded = [
            bar
            for bar in bars
            if tw_date_from_epoch_ms(int(bar["startMs"])) in requested_date_set
        ]
        observed_dates = {tw_date_from_epoch_ms(int(bar["startMs"])) for bar in bounded}
        trade_date = str(row.get("trade_date") or "")
        if not bounded or trade_date not in observed_dates:
            missing["bounded_r2_bars"] = missing.get("bounded_r2_bars", 0) + 1
            continue
        stored = {
            **row,
            "entry_ms": row.get("entry_ms") or detail.get("entry_ms"),
            "exit_ms": row.get("exit_ms") or detail.get("exit_ms"),
        }
        fixtures.append({
            "stored": stored,
            "detail": detail,
            "bars": bounded,
            "fallback15mBars": [],
            "fallback1hBars": [],
            "fallback4hBars": [],
            "fallbackDailyBars": daily_contexts.get(f'{row["symbol"]}|{row["trade_date"]}', []),
        })

    input_path = output_dir / "paired_replay_inputs.json"
    raw_path = output_dir / "paired_replay_rows.json"
    input_path.write_text(json.dumps(fixtures, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        raise RuntimeError("npx_missing")
    completed = subprocess.run(
        [npx, "tsx", "tools/s12_profit_continuation_paired_replay.ts", str(input_path), str(raw_path)],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise RuntimeError(f"typescript_replay_failed:{completed.stderr[-4000:]}")
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    rows = raw.get("rows") or []
    frame = pl.DataFrame(rows, strict=False)
    errors = frame.filter(pl.col("error").is_not_null()) if "error" in frame.columns else pl.DataFrame()
    parity = (
        frame.filter(pl.col("incumbent_parity").struct.field("exact"))
        if "incumbent_parity" in frame.columns
        else pl.DataFrame()
    )
    eligible = parity.filter(pl.col("eligible") == True) if not parity.is_empty() else pl.DataFrame()

    dates = sorted(eligible["signal_date"].unique().to_list()) if not eligible.is_empty() else []
    cut = len(dates) // 2
    deltas = eligible["cost_net_delta_pct"].drop_nulls().to_numpy() if not eligible.is_empty() else np.asarray([])
    candidate_pnl = eligible["candidate_pnl_pct"].drop_nulls().to_numpy() if not eligible.is_empty() else np.asarray([])
    incumbent_pnl = eligible["incumbent_pnl_pct"].drop_nulls().to_numpy() if not eligible.is_empty() else np.asarray([])
    date_delta = mean_lcb(date_means(eligible, "cost_net_delta_pct")) if dates else mean_lcb([])
    adjusted_delta = mean_lcb(date_means(eligible, "cost_net_delta_pct"), Z90_THREE_WAY) if dates else mean_lcb([])
    no_overnight_violations = (
        eligible.filter(pl.col("no_overnight") != True).height if not eligible.is_empty() else 0
    )
    deadline_violations = (
        eligible.filter(pl.col("deadline_respected") != True).height if not eligible.is_empty() else 0
    )
    parity_rate = parity.height / frame.height if frame.height else 0.0
    candidate_p10 = float(np.quantile(candidate_pnl, 0.10)) if candidate_pnl.size else None
    incumbent_p10 = float(np.quantile(incumbent_pnl, 0.10)) if incumbent_pnl.size else None
    candidate_worst = float(np.min(candidate_pnl)) if candidate_pnl.size else None
    incumbent_worst = float(np.min(incumbent_pnl)) if incumbent_pnl.size else None
    candidate_portfolio = portfolio_metrics(eligible, "candidate_pnl_pct") if dates else portfolio_metrics(pl.DataFrame(), "candidate_pnl_pct")
    incumbent_portfolio = portfolio_metrics(eligible, "incumbent_pnl_pct") if dates else portfolio_metrics(pl.DataFrame(), "incumbent_pnl_pct")

    gates = {
        "immutable_source_complete": (
            not missing
            and cache_receipt["artifacts"] >= 417
            and not entry_artifact_receipt["errors"]
            and entry_artifact_receipt["selected"] == entry_artifact_receipt["requested"]
        ),
        "typescript_replay_errors_zero": errors.height == 0,
        "incumbent_exact_parity_100pct": parity_rate == 1.0,
        "paired_candidate_rows_positive": eligible.height > 0,
        "date_cluster_lcb90_positive": date_delta["lcb"] is not None and date_delta["lcb"] > 0,
        "three_horizon_adjusted_lcb_positive": adjusted_delta["lcb"] is not None and adjusted_delta["lcb"] > 0,
        "date_portfolio_p10_non_degradation": (
            candidate_portfolio["p10"] is not None
            and incumbent_portfolio["p10"] is not None
            and candidate_portfolio["p10"] >= incumbent_portfolio["p10"]
        ),
        "date_portfolio_cvar10_non_degradation": (
            candidate_portfolio["cvar10"] is not None
            and incumbent_portfolio["cvar10"] is not None
            and candidate_portfolio["cvar10"] >= incumbent_portfolio["cvar10"]
        ),
        "date_portfolio_drawdown_non_degradation": (
            candidate_portfolio["max_drawdown"] is not None
            and incumbent_portfolio["max_drawdown"] is not None
            and candidate_portfolio["max_drawdown"] >= incumbent_portfolio["max_drawdown"]
        ),
        "no_overnight_violations_zero": no_overnight_violations == 0,
        "deadline_violations_zero": deadline_violations == 0,
    }
    report = {
        "schema_version": "s12-profit-continuation-paired-validation-v1",
        "contract": "s12-profit-continuation-v1",
        "production_effect": False,
        "rank_or_top_k_used": False,
        "state_space_owner": {
            "qualified": False,
            "daily_compute_recommended": False,
            "reason": "negative_incremental_purged_oos_vs_expanding_mean",
        },
        "source_receipt": {
            "input_rows": source.height,
            "detail_rows": len(details),
            "fixtures": len(fixtures),
            "missing": missing,
            **cache_receipt,
            "entry_artifact_backfill": entry_artifact_receipt,
            "daily_context": daily_context_receipt,
            "input_checksum": checksum(fixtures),
            "typescript_stdout": completed.stdout.strip(),
        },
        "incumbent_parity": {
            "exact_rows": parity.height,
            "total_rows": frame.height,
            "rate": parity_rate,
            "errors": errors.height,
        },
        "candidate": {
            "eligible_pairs": eligible.height,
            "dates": len(dates),
            "symbols": eligible["symbol"].n_unique() if not eligible.is_empty() else 0,
            "mean_whole_trade_delta_pct": float(deltas.mean()) if deltas.size else None,
            "median_whole_trade_delta_pct": float(np.median(deltas)) if deltas.size else None,
            "positive_delta_rate": float(np.mean(deltas > 0)) if deltas.size else None,
            "date_cluster_delta_lcb90": date_delta,
            "three_horizon_multiplicity_adjusted_delta": adjusted_delta,
            "candidate_mean_pnl_pct": float(candidate_pnl.mean()) if candidate_pnl.size else None,
            "incumbent_mean_pnl_pct": float(incumbent_pnl.mean()) if incumbent_pnl.size else None,
            "candidate_p10_pnl_pct": candidate_p10,
            "incumbent_p10_pnl_pct": incumbent_p10,
            "candidate_worst_pnl_pct": candidate_worst,
            "incumbent_worst_pnl_pct": incumbent_worst,
            "candidate_date_equal_weight_portfolio": candidate_portfolio,
            "incumbent_date_equal_weight_portfolio": incumbent_portfolio,
            "safety_exit_rows": eligible.filter(pl.col("safety_exit") == True).height if not eligible.is_empty() else 0,
            "no_overnight_violations": no_overnight_violations,
            "deadline_violations": deadline_violations,
            "chronological": {
                "early": slice_report(eligible, dates[:cut]),
                "late": slice_report(eligible, dates[cut:]),
            },
        },
        "promotion_gates": gates,
        "promotion_ready": all(gates.values()),
    }
    report["blockers"] = [name for name, passed in gates.items() if not passed]
    report["receipt_checksum"] = checksum(report)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    frame.write_parquet(output_dir / "paired_replay_rows.parquet")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
