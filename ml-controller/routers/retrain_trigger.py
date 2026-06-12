"""
routers/retrain_trigger.py — POST /retrain/trigger

Sprint 6b: Self-contained retrain trigger.
Uses payload_builder to pull D1 data and build payloads,
then calls Modal retrain_single_stock for each stock.

Unlike /batch-retrain (which needs caller to supply payloads),
this endpoint builds everything server-side from D1.
"""
import os
import time
import json
import uuid
import logging
import asyncio
import tempfile
from urllib.parse import urlsplit, urlunsplit
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, Field
from dataclasses import asdict

from services import d1_client, retrain_lock
from services.payload_builder import (
    load_market_env,
    _bulk_load_prices,
    _bulk_load_indicators,
    _bulk_load_chips,
    _bulk_load_sentiment,
    PredictPayload,
)
from services.active9_dataset_policy import long_history_sequence_enabled, long_history_sequence_prefix
from services.training_calendar import monthly_revenue_available_date
from services.training_policy import TrainingPolicy
from services.modal_client import batch_retrain, prep_universal_batch, train_universal, shap_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/retrain", tags=["retrain"])

# ── Idempotency lock (P0-4 + persistent GCS layer) ──────────────────────────
# Protects against duplicate cron triggers (e.g. 13:37 + 13:47) AND against
# cross-instance races that the old in-memory dict missed. See
# services.retrain_lock for design (GCS CAS via if_generation_match).
_LOCK_TTL_SECONDS = 600  # 10 分鐘
_UNIVERSAL_LOCK_TTL_SECONDS = int(os.environ.get("UNIVERSAL_RETRAIN_LOCK_TTL_SECONDS", str(12 * 3600)))
_UNIVERSAL_PREP_CONCURRENCY_DEFAULT = 3
_UNIVERSAL_PREP_CONCURRENCY_MAX = 5


class RetrainTriggerRequest(BaseModel):
    use_optuna: bool = True
    limit: int = 50  # max stocks to retrain
    run_date: str | None = Field(default=None, description="Business date for scheduler/manual trigger lineage.")


class UniversalRetrainTriggerRequest(BaseModel):
    limit: int = 2500  # max stocks
    force_monthly: bool = False  # Force monthly flow, including feature selection.
    run_date: str | None = Field(default=None, description="Business date for scheduler/manual trigger lineage.")
    candidate_type: str | None = Field(default=None, description="Release-train candidate type, e.g. monthly_release or weekly_drift.")
    drift_target_models: list[str] = Field(default_factory=list)
    drift_target_families: list[str] = Field(default_factory=list)
    train_model_groups: list[str] = Field(default_factory=lambda: ["tree", "dlinear", "patchtst"])
    artifact_lifecycle_targets: list[str] = Field(default_factory=list)
    artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)
    artifact_lifecycle_only: bool = False
    sequence_gcs_prefix: str | None = Field(default=None, description="GCS prefix for sequence_records_v2 batches.")
    sequence_batch_count: int | None = Field(default=None, description="Number of sequence_records_v2 batches.")
    sequence_seq_len: int | None = Field(default=None, description="Shared L3 sequence context override.")
    dlinear_seq_len: int | None = Field(default=None, description="DLinear sequence context override.")
    patchtst_seq_len: int | None = Field(default=None, description="PatchTST sequence context override.")
    itransformer_seq_len: int | None = Field(default=None, description="iTransformer sequence context override.")


def _force_https(url: str) -> str:
    parsed = urlsplit(url.strip())
    if parsed.scheme != "http":
        return url.rstrip("/")
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1"}:
        return url.rstrip("/")
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment)).rstrip("/")


def _universal_prep_concurrency() -> int:
    raw = os.environ.get("UNIVERSAL_PREP_CONCURRENCY", str(_UNIVERSAL_PREP_CONCURRENCY_DEFAULT))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = _UNIVERSAL_PREP_CONCURRENCY_DEFAULT
    return max(1, min(_UNIVERSAL_PREP_CONCURRENCY_MAX, value))


def _parse_gcs_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise ValueError(f"invalid_gcs_uri:{uri}")
    raw = uri[5:]
    bucket, _, blob = raw.partition("/")
    if not bucket or not blob:
        raise ValueError(f"invalid_gcs_uri:{uri}")
    return bucket, blob


def _sequence_batch_count_from_manifest(manifest: dict, fallback: int) -> int:
    try:
        batch_size = int(manifest.get("batch_size") or 0)
    except (TypeError, ValueError):
        batch_size = 0
    records = 0
    for report in manifest.get("lane_reports") or []:
        if not isinstance(report, dict):
            continue
        try:
            records += int(report.get("sequence_records") or 0)
        except (TypeError, ValueError):
            continue
    if records <= 0:
        try:
            records = int((manifest.get("summary") or {}).get("symbols") or 0)
        except (TypeError, ValueError):
            records = 0
    if records <= 0 or batch_size <= 0:
        return max(1, int(fallback))
    return max(1, int((records + batch_size - 1) // batch_size))


def _infer_sequence_batch_count(sequence_gcs_prefix: str, fallback: int) -> int:
    if not sequence_gcs_prefix:
        return max(1, int(fallback))
    try:
        from google.cloud import storage as _gcs

        bucket_name = os.environ.get("GCS_BUCKET_NAME") or os.environ.get("RETRAIN_LOCK_BUCKET")
        if not bucket_name:
            return max(1, int(fallback))
        prefix = sequence_gcs_prefix.strip().rstrip("/")
        blob = _gcs.Client().bucket(bucket_name).blob(f"{prefix}/prep/sequence_manifest.json")
        if not blob.exists():
            return max(1, int(fallback))
        manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
        return _sequence_batch_count_from_manifest(manifest if isinstance(manifest, dict) else {}, fallback)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[retrain/universal] sequence manifest read failed: %s", exc)
        return max(1, int(fallback))


def _snapshot_component_uris(snapshot: dict) -> dict[str, str]:
    try:
        metadata = json.loads(snapshot.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        return {}
    component_meta = metadata.get("component_meta") or {}
    components = metadata.get("components") or {}
    out: dict[str, str] = {}
    for name, meta in component_meta.items():
        uri = meta.get("gcs_uri") if isinstance(meta, dict) else None
        if uri:
            out[str(name)] = str(uri)
    for name, uri in components.items():
        out.setdefault(str(name), str(uri))
    return out


def _read_gcs_parquet_rows(gcs_uri: str) -> list[dict]:
    import polars as pl
    from google.cloud import storage

    bucket_name, blob_name = _parse_gcs_uri(gcs_uri)
    with tempfile.TemporaryDirectory(prefix="stockvision-retrain-snapshot-") as tmp:
        local_path = Path(tmp) / Path(blob_name).name
        storage.Client().bucket(bucket_name).blob(blob_name).download_to_filename(str(local_path))
        return pl.read_parquet(local_path).to_dicts()


def _group_rows_by_key(
    rows: list[dict],
    *,
    key: str,
    allowed: set,
    limit: int,
    mapper,
) -> dict:
    grouped = {item: [] for item in allowed}
    for row in sorted(rows, key=lambda r: (str(r.get(key)), str(r.get("date") or ""))):
        value = row.get(key)
        if value not in grouped:
            continue
        grouped[value].append(mapper(row))
    for value in grouped:
        if len(grouped[value]) > limit:
            grouped[value] = grouped[value][-limit:]
    return grouped


def _snapshot_sentiment_map(rows: list[dict], stock_ids: list[int], limit: int = 45) -> dict[int, list[dict]]:
    return _group_rows_by_key(
        rows,
        key="stock_id",
        allowed=set(stock_ids),
        limit=limit,
        mapper=lambda r: {"date": r.get("date"), "score": r.get("score")},
    )


def _snapshot_per_stock_ts_map(
    *,
    monthly_revenue_rows: list[dict] | None,
    margin_rows: list[dict] | None,
    shareholding_rows: list[dict] | None,
    stock_ids: list[int],
) -> dict[int, dict[str, dict]]:
    stock_id_set = set(stock_ids)
    per_stock_ts: dict[int, dict[str, dict]] = {}

    def ensure_date(stock_id, date_key: str) -> dict:
        per_stock_ts.setdefault(stock_id, {})
        per_stock_ts[stock_id].setdefault(date_key, {})
        return per_stock_ts[stock_id][date_key]

    for row in monthly_revenue_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or row.get("revenue_yoy") is None:
            continue
        date_key = monthly_revenue_available_date(str(row.get("date") or ""))
        ensure_date(sid, date_key)["revenue_yoy"] = row.get("revenue_yoy", 0)

    for row in margin_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or not row.get("date"):
            continue
        values = ensure_date(sid, str(row.get("date")))
        if row.get("margin_balance") is not None:
            values["margin_balance"] = row["margin_balance"]
        if row.get("short_ratio") is not None:
            values["short_ratio"] = row["short_ratio"]

    for row in shareholding_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or not row.get("date") or row.get("retail_pct") is None:
            continue
        ensure_date(sid, str(row.get("date")))["retail_pct"] = row.get("retail_pct")

    return per_stock_ts


def _load_training_maps_from_snapshot(
    *,
    stock_ids: list[int],
    symbols: list[str],
    prices_lookback: int,
    as_of_business_date: str | None = None,
) -> tuple[
    dict[int, list[dict]],
    dict[int, list[dict]],
    dict[str, list[dict]],
    dict[int, list[dict]],
    dict[int, dict[str, dict]],
    dict,
] | None:
    from services.dataset_snapshots import latest_dataset_snapshot

    snapshot = latest_dataset_snapshot(
        kind="backtest_dataset",
        access_tier="compute",
        as_of_business_date=as_of_business_date,
    )
    if not snapshot or snapshot.get("manifest_errors"):
        return None
    component_uris = _snapshot_component_uris(snapshot)
    required = {"prices", "indicators", "chips"}
    if not required.issubset(component_uris):
        return None

    stock_id_set = set(stock_ids)
    symbol_set = set(symbols)
    prices_rows = _read_gcs_parquet_rows(component_uris["prices"])
    indicators_rows = _read_gcs_parquet_rows(component_uris["indicators"])
    chips_rows = _read_gcs_parquet_rows(component_uris["chips"])
    sentiment_rows = _read_gcs_parquet_rows(component_uris["sentiment"]) if component_uris.get("sentiment") else []
    monthly_revenue_rows = (
        _read_gcs_parquet_rows(component_uris["monthly_revenue"]) if component_uris.get("monthly_revenue") else []
    )
    margin_rows = _read_gcs_parquet_rows(component_uris["margin_data"]) if component_uris.get("margin_data") else []
    shareholding_rows = (
        _read_gcs_parquet_rows(component_uris["shareholding"]) if component_uris.get("shareholding") else []
    )

    prices_map = _group_rows_by_key(
        prices_rows,
        key="stock_id",
        allowed=stock_id_set,
        limit=prices_lookback,
        mapper=lambda r: {
            "date": r.get("date"),
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "close": r.get("close"),
            "volume": r.get("volume"),
            "adj_close": r.get("adj_close"),
            "avg_price": r.get("avg_price"),
        },
    )
    indicators_map = _group_rows_by_key(
        indicators_rows,
        key="stock_id",
        allowed=stock_id_set,
        limit=prices_lookback,
        mapper=lambda r: {
            "date": r.get("date"),
            "ma5": r.get("ma5"),
            "ma10": r.get("ma10"),
            "ma20": r.get("ma20"),
            "ma60": r.get("ma60"),
            "rsi14": r.get("rsi14"),
            "macdHist": r.get("macd_hist", r.get("macdHist")),
            "bb_upper": r.get("bb_upper"),
            "bb_lower": r.get("bb_lower"),
            "atr14": r.get("atr14"),
        },
    )
    chips_map = _group_rows_by_key(
        chips_rows,
        key="symbol",
        allowed=symbol_set,
        limit=252,
        mapper=lambda r: {
            "date": r.get("date"),
            "foreign_net": r.get("foreign_net"),
            "trust_net": r.get("trust_net"),
            "dealer_net": r.get("dealer_net"),
            "margin_balance": r.get("margin_balance"),
            "short_balance": r.get("short_balance"),
        },
    )
    sentiment_map = _snapshot_sentiment_map(sentiment_rows, stock_ids) if sentiment_rows else {}
    per_stock_ts_map = _snapshot_per_stock_ts_map(
        monthly_revenue_rows=monthly_revenue_rows,
        margin_rows=margin_rows,
        shareholding_rows=shareholding_rows,
        stock_ids=stock_ids,
    )
    return prices_map, indicators_map, chips_map, sentiment_map, per_stock_ts_map, {
        "snapshot_id": snapshot.get("snapshot_id"),
        "business_date": snapshot.get("business_date"),
        "row_count": snapshot.get("row_count"),
        "gcs_uri": snapshot.get("gcs_uri"),
        "components": sorted(component_uris),
    }


def _build_followup_webhook_url(request: Request | None) -> str:
    explicit = (
        os.environ.get("RETRAIN_FOLLOWUP_URL", "").strip()
        or os.environ.get("ML_CONTROLLER_PUBLIC_URL", "").strip()
    )
    if explicit:
        explicit = _force_https(explicit)
        if explicit.rstrip("/").endswith("/retrain/followup"):
            return explicit.rstrip("/")
        return f"{explicit.rstrip('/')}/retrain/followup"
    if request is not None:
        base = _force_https(str(request.base_url).rstrip("/"))
        return f"{base}/retrain/followup"
    return "http://localhost/retrain/followup"


def _upsert_retrain_status(
    run_id: str,
    *,
    status: str,
    summary: dict | None = None,
    source: str = "ml-controller",
    action: str = "retrain_followup",
    downstream_notes: str = "",
) -> None:
    payload_summary = json.dumps(summary or {}, ensure_ascii=False)
    sql = """
        INSERT INTO webhook_log
          (idempotency_key, received_at, source, action, payload_summary, status, downstream_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          received_at = excluded.received_at,
          source = excluded.source,
          action = excluded.action,
          payload_summary = excluded.payload_summary,
          status = excluded.status,
          downstream_notes = excluded.downstream_notes
    """
    d1_client.execute(
        sql,
        [
            run_id,
            datetime.now(timezone.utc).isoformat(),
            source,
            action,
            payload_summary,
            status,
            downstream_notes,
        ],
    )


@router.post("/trigger")
async def trigger_retrain(req: RetrainTriggerRequest = Body(default=RetrainTriggerRequest())):
    """
    Sprint 6b retrain trigger — builds payloads from D1, calls Modal.

    1. Load all active stocks from D1
    2. Build market_env (shared)
    3. Bulk load prices/indicators/chips/sentiment per stock
    4. Call Modal retrain_single_stock × N stocks
    """
    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    run_date = req.run_date or tw_now.date().isoformat()

    # ── 1. Active stocks ────────────────────────────────────────────────────
    stock_rows = d1_client.query(
        "SELECT id, symbol, market FROM stocks "
        "WHERE market IN ('TW','TWO','TWSE','OTC') AND in_current_watchlist=1 "
        "ORDER BY id LIMIT ?",
        [req.limit],
    )
    if not stock_rows:
        return {"error": "No active stocks found", "total": 0}

    stock_ids = [r["id"] for r in stock_rows]
    symbols = [r["symbol"] for r in stock_rows]
    id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}

    logger.info(f"[retrain/trigger] {len(stock_rows)} active stocks, run_date={run_date}")

    # ── 2. Shared market env ────────────────────────────────────────────────
    market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)

    # ── 3. Bulk load per-stock data ─────────────────────────────────────────
    prices_map = _bulk_load_prices(stock_ids, limit=500)
    indicators_map = _bulk_load_indicators(stock_ids, limit=500)
    chips_map = _bulk_load_chips(symbols, limit=300)
    sentiment_map = _bulk_load_sentiment(stock_ids, limit=90)

    # ── 4. Build payloads ───────────────────────────────────────────────────
    payloads = []
    skipped = []
    for row in stock_rows:
        sid, sym = row["id"], row["symbol"]
        px = prices_map.get(sid, [])
        if len(px) < 60:
            skipped.append(f"{sym}(prices={len(px)}<60)")
            continue
        payloads.append({
            "stock_id": sid,
            "symbol": sym,
            "market": row.get("market", "TW"),
            "prices": px,
            "indicators": indicators_map.get(sid, []),
            "chips": chips_map.get(sym, []),
            "sentiment_scores": sentiment_map.get(sid, []),
            "market_env": asdict(market_env),
            "barrier_params": barrier_params,
            "use_optuna": req.use_optuna,
        })

    if not payloads:
        return {"error": "All stocks skipped (insufficient data)", "skipped": skipped}

    logger.info(
        f"[retrain/trigger] {len(payloads)} payloads built, {len(skipped)} skipped. "
        f"Starting Modal retrain..."
    )

    # ── 5. Call Modal batch retrain ─────────────────────────────────────────
    results = await batch_retrain(payloads)

    elapsed = round(time.time() - t0, 2)
    retrained = sum(1 for r in results if not r.get("error"))
    errors = [r for r in results if r.get("error")]

    logger.info(f"[retrain/trigger] Done: {retrained}/{len(payloads)} in {elapsed}s")

    return {
        "total": len(payloads),
        "retrained": retrained,
        "errors": len(errors),
        "skipped": skipped,
        "elapsed_s": elapsed,
        "error_details": [{"symbol": e.get("symbol"), "error": e.get("error")} for e in errors[:10]],
    }


# ── Universal Model Retrain ─────────────────────────────────────────────────

# Sector → int encoding (must match ml-service/app/features/__init__.py)
_SECTOR_ENCODING: dict[str, int] = {}  # populated lazily from D1


def _build_sector_encoding() -> dict[str, int]:
    """Load distinct industry tags from D1 and assign integer codes."""
    global _SECTOR_ENCODING
    if _SECTOR_ENCODING:
        return _SECTOR_ENCODING
    rows = d1_client.query(
        "SELECT DISTINCT tag FROM stock_tags WHERE tag_type='industry' ORDER BY tag"
    )
    _SECTOR_ENCODING = {r["tag"]: i for i, r in enumerate(rows)}
    logger.info(f"[universal] sector encoding: {len(_SECTOR_ENCODING)} industries")
    return _SECTOR_ENCODING


def _estimate_cap_bucket(prices: list[dict]) -> int:
    """Estimate market_cap_bucket from avg close × avg volume (proxy).
    0=micro, 1=small, 2=mid, 3=large, 4=mega
    """
    if not prices:
        return 2
    recent = prices[-20:] if len(prices) >= 20 else prices
    avg_close = sum(float(p.get("close", 0)) for p in recent) / len(recent)
    avg_vol = sum(float(p.get("volume", 0)) for p in recent) / len(recent)
    proxy = avg_close * avg_vol  # ~daily turnover (NTD)
    if proxy > 5_000_000_000:
        return 4  # mega
    if proxy > 1_000_000_000:
        return 3  # large
    if proxy > 200_000_000:
        return 2  # mid
    if proxy > 50_000_000:
        return 1  # small
    return 0  # micro


def _volume_bucket(prices: list[dict]) -> int:
    """Avg volume bucket: 0=very low, 1=low, 2=mid, 3=high, 4=very high."""
    if not prices:
        return 2
    recent = prices[-20:] if len(prices) >= 20 else prices
    avg_vol = sum(float(p.get("volume", 0)) for p in recent) / len(recent)
    if avg_vol > 50_000_000:
        return 4
    if avg_vol > 10_000_000:
        return 3
    if avg_vol > 2_000_000:
        return 2
    if avg_vol > 500_000:
        return 1
    return 0


@router.post("/universal/run")
@router.post("/universal")
async def trigger_universal_retrain(
    req: UniversalRetrainTriggerRequest = Body(default=UniversalRetrainTriggerRequest()),
    request: Request = None,
):
    """
    全市場 universal model retrain trigger.

    1. Load ALL stocks from D1 (no in_current_watchlist filter — universal covers all)
    2. Bulk load prices/indicators/chips/sentiment
    3. Add stock_meta (sector_encoded, market_cap_bucket, avg_volume_bucket)
    4. Send pooled payload to Modal retrain_universal_model
    """
    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    run_id = f"universal-{tw_now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"

    # ── Idempotency check (P0-4, persistent via GCS) ─────────────────────────
    run_date = req.run_date or tw_now.date().isoformat()
    lock_key = f"retrain:{run_date}"
    lock_result = retrain_lock.acquire(
        lock_key,
        ttl_seconds=_UNIVERSAL_LOCK_TTL_SECONDS,
        metadata={
            "run_id": run_id,
            "run_date": run_date,
            "limit": req.limit,
            "force_monthly": req.force_monthly,
            "tw_now": tw_now.isoformat(),
        },
    )
    if not lock_result.acquired:
        logger.info(
            f"[retrain/universal] {lock_result.reason} — skip duplicate trigger "
            f"(backend={lock_result.backend})"
        )
        return {
            "status": "skipped",
            "reason": lock_result.reason,
            "lock_key": lock_key,
            "backend": lock_result.backend,
            "existing_instance": lock_result.existing_instance,
            "elapsed_since": lock_result.elapsed_since_acquire,
        }
    logger.info(
        f"[retrain/universal] Lock acquired: {lock_key} (backend={lock_result.backend}, "
        f"reason={lock_result.reason})"
    )
    _upsert_retrain_status(
        run_id,
        status="started",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "limit": req.limit,
            "force_monthly": req.force_monthly,
            "lock_backend": lock_result.backend,
            "lock_ttl_seconds": _UNIVERSAL_LOCK_TTL_SECONDS,
        },
        downstream_notes="lock_acquired",
    )

    # ── 1. All stocks (universal covers inactive too for training diversity) ──
    stock_rows = d1_client.query(
        "SELECT id, symbol, market FROM stocks "
        "WHERE market IN ('TW','TWO','TWSE','OTC') "
        "ORDER BY id LIMIT ?",
        [req.limit],
    )
    if not stock_rows:
        retrain_lock.release(lock_key)
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "reason": "no_stocks_found",
                "limit": req.limit,
            },
            downstream_notes="aborted_before_data_load",
        )
        return {"error": "No stocks found", "total": 0}

    stock_ids = [r["id"] for r in stock_rows]
    symbols = [r["symbol"] for r in stock_rows]
    id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}
    sym_to_id = {r["symbol"]: r["id"] for r in stock_rows}

    logger.info(f"[retrain/universal] {len(stock_rows)} stocks, run_date={run_date}")

    # ── 2. Shared market env ────────────────────────────────────────────────
    market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)

    # 2a. B-lite regime-conditional training window.
    # VIX + TWII bias proxy decides prices lookback via TrainingPolicy.
    # Future HMM/KV regime source should only replace TrainingPolicy inputs.
    training_policy = TrainingPolicy.from_env()
    vix = getattr(market_env, "us_vix", 18) or 18
    twii_bias = getattr(market_env, "twii_bias", 0) or 0
    regime, prices_lookback = training_policy.resolve_regime(vix=float(vix), twii_bias=float(twii_bias))
    logger.info(f"[retrain/universal] Regime={regime} (VIX={vix:.1f}, bias={twii_bias:.3f}) -> prices_lookback={prices_lookback}d")

    # 2b. Monthly detection + feature pool for prep filtering.
    # Flow B: feature selection runs inside Modal orchestrator.
    # Cloud Run only prepares feature_pool.json for prep filtering.
    import json as _json
    from google.cloud import storage as _gcs
    is_monthly = training_policy.is_monthly(force_monthly=req.force_monthly, tw_day=tw_now.day)
    if is_monthly:
        logger.info(
            "[retrain/universal] Monthly detected "
            f"(day<={training_policy.monthly_day_cutoff}) -> selection will run in Modal orchestrator"
        )

    # Prep writes the full canonical tabular matrix. Train-side policy owns
    # model-specific filtering: active tree models use feature_pool.tree_active;
    # retired tabular-neural paths are not scheduled.
    active_features = None
    logger.info("[retrain/universal] prep writes full canonical features; train-side feature policy filters active models")

    # ── 3. Bulk load per-stock data (chunked — CF D1 REST API binding limit ~100) ──
    D1_CHUNK = 80
    prices_map: dict = {}
    indicators_map: dict = {}
    chips_map: dict = {}
    sentiment_map: dict = {}
    per_stock_ts_map: dict[int, dict[str, dict]] = {}
    dataset_snapshot_info: dict | None = None
    try:
        snapshot_maps = _load_training_maps_from_snapshot(
            stock_ids=stock_ids,
            symbols=symbols,
            prices_lookback=prices_lookback,
            as_of_business_date=run_date,
        )
    except Exception as snapshot_err:  # noqa: BLE001 - D1 fallback keeps retrain available.
        logger.warning("[retrain/universal] GCS snapshot load failed, falling back to D1: %s", snapshot_err)
        snapshot_maps = None

    if snapshot_maps:
        prices_map, indicators_map, chips_map, sentiment_map, per_stock_ts_map, dataset_snapshot_info = snapshot_maps
        logger.info(
            "[retrain/universal] GCS snapshot bulk load done: "
            f"snapshot={dataset_snapshot_info.get('snapshot_id')} "
            f"business_date={dataset_snapshot_info.get('business_date')} "
            f"prices={len(prices_map)} indicators={len(indicators_map)} chips={len(chips_map)} "
            f"sentiment={len(sentiment_map)} per_stock_ts={len(per_stock_ts_map)}"
        )

    snapshot_components = set((dataset_snapshot_info or {}).get("components") or [])
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        chunk_syms = [id_to_sym[sid] for sid in chunk_ids]
        if not dataset_snapshot_info:
            prices_map.update(_bulk_load_prices(chunk_ids, limit=prices_lookback))
            indicators_map.update(_bulk_load_indicators(chunk_ids, limit=prices_lookback))
            chips_map.update(_bulk_load_chips(chunk_syms, limit=252))
        if "sentiment" not in snapshot_components:
            sentiment_map.update(_bulk_load_sentiment(chunk_ids, limit=45))
    source = "gcs_snapshot" if dataset_snapshot_info else "d1"
    if dataset_snapshot_info and "sentiment" not in snapshot_components:
        source += "+d1_sentiment"
    logger.info(
        f"[retrain/universal] Bulk load done: source={source} "
        f"prices={len(prices_map)} indicators={len(indicators_map)} chips={len(chips_map)}"
    )

    # ── 3b. Bulk load per-stock time-series for Wave 3 features ────────────
    # revenue_yoy (monthly, per stock) + margin_data (daily, per stock)
    # monthly_revenue: all stocks × all months
    rev_rows = []
    if "monthly_revenue" not in snapshot_components:
        rev_rows = d1_client.query(
            "SELECT stock_id, date, revenue_yoy FROM monthly_revenue "
            "WHERE revenue_yoy IS NOT NULL ORDER BY stock_id, date ASC",
            timeout=120.0,
        )
        for r in (rev_rows or []):
            sid = r["stock_id"]
            ym = r["date"]  # Usually revenue period "YYYY-MM"; full publication date is also accepted.
            if sid not in per_stock_ts_map:
                per_stock_ts_map[sid] = {}
            date_key = monthly_revenue_available_date(ym)
            if date_key not in per_stock_ts_map[sid]:
                per_stock_ts_map[sid][date_key] = {}
            per_stock_ts_map[sid][date_key]["revenue_yoy"] = r.get("revenue_yoy", 0)

    # margin_data: all stocks × all dates (margin_balance, short_ratio)
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        placeholders = ",".join("?" * len(chunk_ids))
        if "margin_data" not in snapshot_components:
            margin_rows = d1_client.query(
                f"SELECT stock_id, date, margin_balance, short_ratio "
                f"FROM margin_data WHERE stock_id IN ({placeholders}) "
                f"ORDER BY stock_id, date ASC",
                list(chunk_ids),
                timeout=120.0,
            )
            for r in (margin_rows or []):
                sid = r["stock_id"]
                date_key = r["date"]
                if sid not in per_stock_ts_map:
                    per_stock_ts_map[sid] = {}
                if date_key not in per_stock_ts_map[sid]:
                    per_stock_ts_map[sid][date_key] = {}
                if r.get("margin_balance") is not None:
                    per_stock_ts_map[sid][date_key]["margin_balance"] = r["margin_balance"]
                if r.get("short_ratio") is not None:
                    per_stock_ts_map[sid][date_key]["short_ratio"] = r["short_ratio"]

        # shareholding: retail_pct (same chunk)
        if "shareholding" not in snapshot_components:
            sh_rows = d1_client.query(
                f"SELECT stock_id, date, retail_pct "
                f"FROM shareholding WHERE stock_id IN ({placeholders}) "
                f"ORDER BY stock_id, date ASC",
                list(chunk_ids),
                timeout=120.0,
            )
            for r in (sh_rows or []):
                sid = r["stock_id"]
                date_key = r["date"]
                if sid not in per_stock_ts_map:
                    per_stock_ts_map[sid] = {}
                if date_key not in per_stock_ts_map[sid]:
                    per_stock_ts_map[sid][date_key] = {}
                if r.get("retail_pct") is not None:
                    per_stock_ts_map[sid][date_key]["retail_pct"] = r["retail_pct"]

    logger.info(
        f"[retrain/universal] Per-stock TS: {len(per_stock_ts_map)} stocks with history, "
        f"{len(rev_rows or [])} revenue rows, margin+shareholding chunked"
    )

    # ── 4. Sector encoding ──────────────────────────────────────────────────
    sector_enc = _build_sector_encoding()
    # Load per-symbol industry tag
    tag_rows = d1_client.query(
        "SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'"
    )
    sym_to_sector: dict[str, str] = {}
    for r in tag_rows:
        sym_to_sector[r["symbol"]] = r["tag"]

    # ── 5. Build pooled payloads ────────────────────────────────────────────
    per_stock_payloads = []
    skipped = []
    for row in stock_rows:
        sid, sym = row["id"], row["symbol"]
        px = prices_map.get(sid, [])
        if len(px) < 60:
            skipped.append(f"{sym}(prices={len(px)}<60)")
            continue
        sector_tag = sym_to_sector.get(sym, "")
        # market_env: lightweight per-stock (no history, no per_stock_ts)
        # shared data (history + per_stock_ts) passed at batch level to avoid 2500x deep copy
        me_lite = {
            "risk_score": market_env.risk_score,
            "risk_level": market_env.risk_level,
            "us_sox_return": market_env.us_sox_return,
            "us_vix": market_env.us_vix,
        }
        per_stock_payloads.append({
            "stock_id": sid,
            "symbol": sym,
            "market": row.get("market", "TW"),
            "prices": px,
            "indicators": indicators_map.get(sid, []),
            "chips": chips_map.get(sym, []),
            "sentiment_scores": sentiment_map.get(sid, []),
            "market_env": me_lite,
            "stock_meta": {
                "sector_encoded": sector_enc.get(sector_tag, 0),
                "market_cap_bucket": _estimate_cap_bucket(px),
                "avg_volume_bucket": _volume_bucket(px),
            },
        })

    if len(per_stock_payloads) < 10:
        retrain_lock.release(lock_key)
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "reason": "usable_stocks_below_threshold",
                "usable_stocks": len(per_stock_payloads),
                "stocks_skipped": len(skipped),
            },
            downstream_notes="aborted_before_batch_prep",
        )
        return {"error": f"Usable stocks < 10 ({len(per_stock_payloads)})", "skipped": skipped}

    # ── 5b. Cross-sectional features: sector peer returns ────────────────────
    # MI-LSTM 啟發：計算同產業平均報酬，注入 stock_meta
    sector_returns: dict[str, list[tuple[float, float]]] = {}  # tag → [(return_1d, return_5d), ...]
    for p in per_stock_payloads:
        px = p["prices"]
        if len(px) < 6:
            continue
        close_last = float(px[-1].get("close", 0))
        close_1d = float(px[-2].get("close", 0)) if len(px) >= 2 else close_last
        close_5d = float(px[-6].get("close", 0)) if len(px) >= 6 else close_last
        r1d = (close_last - close_1d) / close_1d if close_1d > 0 else 0
        r5d = (close_last - close_5d) / close_5d if close_5d > 0 else 0
        sym = p["symbol"]
        tag = sym_to_sector.get(sym, "")
        if tag:
            sector_returns.setdefault(tag, []).append((r1d, r5d))
        # 暫存個股報酬供 stock_vs_sector 計算
        p["_r5d"] = r5d

    # 算 sector 平均
    sector_avg: dict[str, tuple[float, float]] = {}
    for tag, returns in sector_returns.items():
        avg_1d = sum(r[0] for r in returns) / len(returns)
        avg_5d = sum(r[1] for r in returns) / len(returns)
        sector_avg[tag] = (avg_1d, avg_5d)

    # 注入 stock_meta
    for p in per_stock_payloads:
        tag = sym_to_sector.get(p["symbol"], "")
        avg = sector_avg.get(tag, (0.0, 0.0))
        p["stock_meta"]["sector_peer_return_1d"] = round(avg[0], 6)
        p["stock_meta"]["sector_peer_return_5d"] = round(avg[1], 6)
        p["stock_meta"]["stock_vs_sector"] = round(p.pop("_r5d", 0) - avg[1], 6)

    logger.info(
        f"[retrain/universal] {len(per_stock_payloads)} payloads built, "
        f"{len(skipped)} skipped, {len(sector_avg)} sectors. Starting batch prep..."
    )

    # ── 6. Batch prep — 分批送 Modal prep_universal_batch ────────────────────
    BATCH_SIZE = 500
    batches = [
        per_stock_payloads[i:i + BATCH_SIZE]
        for i in range(0, len(per_stock_payloads), BATCH_SIZE)
    ]
    batch_count = len(batches)
    # P0-3: guard log — batch_count < 2 is unexpected for full-market retrain (should be 4-5)
    if batch_count < 2:
        logger.warning(
            f"[retrain/universal] ⚠️ batch_count={batch_count} unexpectedly low "
            f"(payloads={len(per_stock_payloads)}, skipped={len(skipped)}, limit={req.limit}). "
            f"Verify D1 prices availability."
        )
    prep_results: list[dict] = []

    # Shared data: pass once per batch, not per stock (saves ~2.5GB memory)
    shared_history = asdict(market_env).get("history", {})
    # per_stock_ts: convert int keys to str for JSON serialization
    ps_ts_str = {str(k): v for k, v in per_stock_ts_map.items()} if per_stock_ts_map else {}

    prep_concurrency = min(_universal_prep_concurrency(), max(1, batch_count))
    prep_semaphore = asyncio.Semaphore(prep_concurrency)

    async def _run_prep_batch(idx: int, batch_payloads: list[dict]) -> dict:
        async with prep_semaphore:
            # Only include per_stock_ts for stocks in this batch.
            batch_stock_ids = {str(p["stock_id"]) for p in batch_payloads}
            batch_ps_ts = {k: v for k, v in ps_ts_str.items() if k in batch_stock_ids}
            logger.info(
                f"[retrain/universal] Prep batch {idx}/{batch_count} "
                f"({len(batch_payloads)} stocks, {len(batch_ps_ts)} with per_stock_ts, "
                f"concurrency={prep_concurrency})"
            )
            prep_payload = {
                "payloads": batch_payloads,
                "barrier_params": barrier_params,
                "batch_index": idx,
                "shared_market_history": shared_history,
                "per_stock_ts_map": batch_ps_ts,
                "gcs_prefix": "universal",
            }
            if active_features:
                prep_payload["active_features"] = active_features
            result = await prep_universal_batch(prep_payload)
            if not isinstance(result, dict):
                return {"batch_index": idx, "error": f"invalid prep result type: {type(result).__name__}"}
            result.setdefault("batch_index", idx)
            return result

    prep_task_results = await asyncio.gather(
        *(_run_prep_batch(idx, batch_payloads) for idx, batch_payloads in enumerate(batches)),
        return_exceptions=True,
    )
    for idx, result in enumerate(prep_task_results):
        if isinstance(result, Exception):
            result = {"batch_index": idx, "error": str(result)}
        prep_results.append(result)
        if result.get("error"):
            logger.warning(f"[retrain/universal] Batch {idx} error: {result['error']}")

    total_rows = sum(r.get("rows", 0) for r in prep_results)
    logger.info(
        f"[retrain/universal] Prep done: {batch_count} batches, "
        f"concurrency={prep_concurrency}, {total_rows} total rows"
    )
    _upsert_retrain_status(
        run_id,
        status="prep_complete",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "is_monthly": is_monthly,
            "batch_count": batch_count,
            "prep_concurrency": prep_concurrency,
            "dataset_snapshot": dataset_snapshot_info,
            "total_prep_rows": total_rows,
            "stocks_sent": len(per_stock_payloads),
            "stocks_skipped": len(skipped),
        },
        downstream_notes="await_orchestrator_dispatch",
    )

    if total_rows < 10000:
        # Abort before orchestrator spawn → release lock so next retry can run.
        logger.warning(f"[retrain/universal] Aborting: total_rows={total_rows} < 10000; releasing lock")
        retrain_lock.release(lock_key)
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "total_prep_rows": total_rows,
            },
            downstream_notes="aborted_before_orchestrator",
        )
        return {
            "error": f"Total prep rows {total_rows} < 10000, aborting train",
            "prep_results": prep_results,
            "run_id": run_id,
            "lock_key": lock_key,
        }

    # ── 7. Flow B: Modal orchestrator (selection → train → SHAP) ──────────────
    # Cloud Run 觸發一次 Modal retrain_orchestrator，後面全在 Modal 內完成
    from services.modal_client import retrain_orchestrator
    followup_webhook_url = _build_followup_webhook_url(request)
    sequence_required = (
        any(group in {"dlinear", "patchtst"} for group in (req.train_model_groups or []))
        or any(target in {"PatchTST", "iTransformer"} for target in (req.artifact_lifecycle_targets or []))
    )
    sequence_gcs_prefix = (req.sequence_gcs_prefix or "").strip().rstrip("/")
    if not sequence_gcs_prefix and sequence_required and long_history_sequence_enabled():
        sequence_gcs_prefix = long_history_sequence_prefix()
    sequence_batch_count = req.sequence_batch_count
    if sequence_gcs_prefix and not sequence_batch_count:
        sequence_batch_count = _infer_sequence_batch_count(sequence_gcs_prefix, batch_count)
    sequence_contract: dict[str, object] = {}
    if sequence_gcs_prefix:
        sequence_contract["sequence_gcs_prefix"] = sequence_gcs_prefix
        sequence_contract["sequence_batch_count"] = int(sequence_batch_count or batch_count)
    for key in ("sequence_seq_len", "dlinear_seq_len", "patchtst_seq_len", "itransformer_seq_len"):
        value = getattr(req, key, None)
        if value:
            sequence_contract[key] = int(value)
    logger.info(f"[retrain/universal] Flow B: spawning Modal orchestrator "
                f"(batches={batch_count}, monthly={is_monthly}, sequence={sequence_contract or None}, "
                f"followup={followup_webhook_url})")
    try:
        orchestrator_result = await retrain_orchestrator(
            payload={
                "batch_count": batch_count,
                "is_monthly": is_monthly,
                "candidate_type": req.candidate_type,
                "drift_target_models": req.drift_target_models,
                "drift_target_families": req.drift_target_families,
                "train_model_groups": req.train_model_groups,
                "artifact_lifecycle_targets": req.artifact_lifecycle_targets,
                "artifact_lifecycle_contracts": req.artifact_lifecycle_contracts,
                "artifact_lifecycle_only": req.artifact_lifecycle_only,
                "selection_params": training_policy.feature_selection_params(),
                "training_policy": training_policy.to_dict(),
                "dataset_snapshot": dataset_snapshot_info,
                "followup_webhook_url": followup_webhook_url,
                "gcs_prefix": "universal",
                "run_id": run_id,
                "lock_key": lock_key,
                "run_date": run_date,
                **sequence_contract,
            },
            fire_and_forget=True,  # Cloud Run 不等 Modal 完成，避免 3600s timeout
        )
    except Exception as orch_err:
        # Orchestrator dispatch failed — release lock so the next cron retry
        # is not blocked by our aborted attempt (matches pre-GCS behavior).
        logger.error(f"[retrain/universal] orchestrator dispatch failed: {orch_err}; releasing lock")
        retrain_lock.release(lock_key)
        _upsert_retrain_status(
            run_id,
            status="dispatch_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "total_prep_rows": total_rows,
                "error": str(orch_err),
            },
            downstream_notes="orchestrator_dispatch_error",
        )
        raise

    # ── Lock stays held until the Modal followup releases it. The long TTL is
    # only a safety net if the callback is lost or the orchestrator crashes.
    logger.info(f"[retrain/universal] Lock held: {lock_key} (orchestrator dispatched)")
    _upsert_retrain_status(
        run_id,
        status="orchestrator_dispatched",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "is_monthly": is_monthly,
            "batch_count": batch_count,
            "prep_concurrency": prep_concurrency,
            "sequence_contract": sequence_contract or None,
            "dataset_snapshot": dataset_snapshot_info,
            "total_prep_rows": total_rows,
            "followup_webhook_url": followup_webhook_url,
            "stocks_sent": len(per_stock_payloads),
            "stocks_skipped": len(skipped),
            "orchestrator_result": orchestrator_result,
        },
        downstream_notes="await_modal_followup",
    )

    elapsed = round(time.time() - t0, 2)
    logger.info(f"[retrain/universal] Done in {elapsed}s")

    return {
        "trigger_elapsed_s": elapsed,
        "stocks_sent": len(per_stock_payloads),
        "stocks_skipped": len(skipped),
        "skipped_sample": skipped[:20],
        "batch_count": batch_count,
        "prep_concurrency": prep_concurrency,
        "sequence_contract": sequence_contract or None,
        "dataset_snapshot": dataset_snapshot_info,
        "total_prep_rows": total_rows,
        "prep_results": prep_results,
        "orchestrator_result": orchestrator_result,
        "run_id": run_id,
        "lock_key": lock_key,
        "followup_webhook_url": followup_webhook_url,
    }
