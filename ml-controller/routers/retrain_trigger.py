"""
routers/retrain_trigger.py — POST /retrain/trigger

Sprint 6b: Self-contained retrain trigger.
Uses payload_builder to pull D1 data and build payloads,
then calls Modal retrain_single_stock for each stock.

Unlike /batch-retrain (which needs caller to supply payloads),
this endpoint builds everything server-side from D1.
"""
import time
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body
from pydantic import BaseModel
from dataclasses import asdict

from services import d1_client
from services.payload_builder import (
    load_market_env,
    _bulk_load_prices,
    _bulk_load_indicators,
    _bulk_load_chips,
    _bulk_load_sentiment,
    PredictPayload,
)
from services.modal_client import batch_retrain, prep_universal_batch, train_universal, shap_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/retrain", tags=["retrain"])


class RetrainTriggerRequest(BaseModel):
    use_optuna: bool = True
    limit: int = 50  # max stocks to retrain


class UniversalRetrainTriggerRequest(BaseModel):
    limit: int = 2500  # max stocks (全市場)
    force_monthly: bool = False  # 強制跑月度流程（含 feature selection）


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
    run_date = tw_now.date().isoformat()

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


@router.post("/universal")
async def trigger_universal_retrain(
    req: UniversalRetrainTriggerRequest = Body(default=UniversalRetrainTriggerRequest()),
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
    run_date = tw_now.date().isoformat()

    # ── 1. All stocks (universal covers inactive too for training diversity) ──
    stock_rows = d1_client.query(
        "SELECT id, symbol, market FROM stocks "
        "WHERE market IN ('TW','TWO','TWSE','OTC') "
        "ORDER BY id LIMIT ?",
        [req.limit],
    )
    if not stock_rows:
        return {"error": "No stocks found", "total": 0}

    stock_ids = [r["id"] for r in stock_rows]
    symbols = [r["symbol"] for r in stock_rows]
    id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}
    sym_to_id = {r["symbol"]: r["id"] for r in stock_rows}

    logger.info(f"[retrain/universal] {len(stock_rows)} stocks, run_date={run_date}")

    # ── 2. Shared market env ────────────────────────────────────────────────
    market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)

    # ── 2a. B-lite regime-conditional training window ────────────────────────
    # VIX + TWII bias proxy → decide prices lookback.
    # 後續 #7 HMM→KV 完成後改讀 kv_get("ml:regime")（改 1 行）。
    vix = getattr(market_env, "us_vix", 18) or 18
    twii_bias = getattr(market_env, "twii_bias", 0) or 0
    if vix > 25 or twii_bias < -0.05:
        regime = "bear"
        prices_lookback = 252    # 1 year — structure shifts fast, old data is toxic
    elif vix < 18 and twii_bias > 0.02:
        regime = "bull"
        prices_lookback = 900    # 3.5 years — long trend, more data helps
    else:
        regime = "sideways"
        prices_lookback = 500    # 2 years — middle ground
    logger.info(f"[retrain/universal] Regime={regime} (VIX={vix:.1f}, bias={twii_bias:.3f}) → prices_lookback={prices_lookback}d")

    # ── 2b. Monthly detection + feature pool for prep filtering ──
    # 2.0 Flow B: feature selection 在 Modal orchestrator 裡 await 完成（不再 fire-and-forget）
    # Cloud Run 這邊只讀既有 feature_pool.json 給 prep 用
    import json as _json
    from google.cloud import storage as _gcs
    is_monthly = req.force_monthly or tw_now.day <= 7
    if is_monthly:
        logger.info("[retrain/universal] Monthly detected (day 1-7) — selection will run in Modal orchestrator")

    # Read feature_pool.json from GCS for prep column filtering
    active_features = None
    try:
        _bucket = _gcs.Client().bucket("stockvision-models")
        _pool_blob = _bucket.blob("universal/feature_pool.json")
        if _pool_blob.exists():
            _pool = _json.loads(_pool_blob.download_as_text())
            active_features = _pool.get("active")
            logger.info(f"[retrain/universal] Feature pool loaded: {len(active_features)} active features")
        else:
            logger.info("[retrain/universal] No feature_pool.json found, using all features")
    except Exception as e:
        logger.warning(f"[retrain/universal] Failed to load feature pool (using all): {e}")

    # ── 3. Bulk load per-stock data (chunked — SQLite var limit is 999+) ──
    D1_CHUNK = 500
    prices_map: dict = {}
    indicators_map: dict = {}
    chips_map: dict = {}
    sentiment_map: dict = {}
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        chunk_syms = [id_to_sym[sid] for sid in chunk_ids]
        prices_map.update(_bulk_load_prices(chunk_ids, limit=prices_lookback))
        indicators_map.update(_bulk_load_indicators(chunk_ids, limit=prices_lookback))
        chips_map.update(_bulk_load_chips(chunk_syms, limit=252))
        sentiment_map.update(_bulk_load_sentiment(chunk_ids, limit=45))
    logger.info(f"[retrain/universal] D1 bulk load done: {len(prices_map)} prices")

    # ── 3b. Bulk load per-stock time-series for Wave 3 features ────────────
    # revenue_yoy (monthly, per stock) + margin_data (daily, per stock)
    per_stock_ts_map: dict[int, dict[str, dict]] = {}  # {stock_id: {date: {revenue_yoy, margin_balance, ...}}}

    # monthly_revenue: all stocks × all months
    rev_rows = d1_client.query(
        "SELECT stock_id, date, revenue_yoy FROM monthly_revenue "
        "WHERE revenue_yoy IS NOT NULL ORDER BY stock_id, date ASC",
        timeout=120.0,
    )
    for r in (rev_rows or []):
        sid = r["stock_id"]
        ym = r["date"]  # "YYYY-MM" format
        if sid not in per_stock_ts_map:
            per_stock_ts_map[sid] = {}
        # Convert "YYYY-MM" → "YYYY-MM-15" (mid-month anchor for forward-fill join)
        date_key = f"{ym}-15"
        if date_key not in per_stock_ts_map[sid]:
            per_stock_ts_map[sid][date_key] = {}
        per_stock_ts_map[sid][date_key]["revenue_yoy"] = r.get("revenue_yoy", 0)

    # margin_data: all stocks × all dates (margin_balance, short_ratio)
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        placeholders = ",".join("?" * len(chunk_ids))
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
    prep_results = []

    # Shared data: pass once per batch, not per stock (saves ~2.5GB memory)
    shared_history = asdict(market_env).get("history", {})
    # per_stock_ts: convert int keys to str for JSON serialization
    ps_ts_str = {str(k): v for k, v in per_stock_ts_map.items()} if per_stock_ts_map else {}

    for idx, batch_payloads in enumerate(batches):
        # Only include per_stock_ts for stocks in this batch
        batch_stock_ids = {str(p["stock_id"]) for p in batch_payloads}
        batch_ps_ts = {k: v for k, v in ps_ts_str.items() if k in batch_stock_ids}
        logger.info(f"[retrain/universal] Prep batch {idx}/{batch_count} ({len(batch_payloads)} stocks, {len(batch_ps_ts)} with per_stock_ts)")
        prep_payload = {
            "payloads": batch_payloads,
            "barrier_params": barrier_params,
            "batch_index": idx,
            "shared_market_history": shared_history,
            "per_stock_ts_map": batch_ps_ts,
        }
        if active_features:
            prep_payload["active_features"] = active_features
        result = await prep_universal_batch(prep_payload)
        prep_results.append(result)
        if result.get("error"):
            logger.warning(f"[retrain/universal] Batch {idx} error: {result['error']}")

    total_rows = sum(r.get("rows", 0) for r in prep_results)
    logger.info(f"[retrain/universal] Prep done: {batch_count} batches, {total_rows} total rows")

    if total_rows < 10000:
        return {
            "error": f"Total prep rows {total_rows} < 10000, aborting train",
            "prep_results": prep_results,
        }

    # ── 7. Flow B: Modal orchestrator (selection → train → SHAP) ──────────────
    # Cloud Run 觸發一次 Modal retrain_orchestrator，後面全在 Modal 內完成
    from services.modal_client import retrain_orchestrator
    logger.info(f"[retrain/universal] Flow B: spawning Modal orchestrator "
                f"(batches={batch_count}, monthly={is_monthly})")
    orchestrator_result = await retrain_orchestrator(
        payload={
            "batch_count": batch_count,
            "is_monthly": is_monthly,
            "selection_params": {"max_rounds": 100, "alpha": 0.01},
        },
        fire_and_forget=True,  # Cloud Run 不等 Modal 完成，避免 3600s timeout
    )

    elapsed = round(time.time() - t0, 2)
    logger.info(f"[retrain/universal] Done in {elapsed}s")

    return {
        "trigger_elapsed_s": elapsed,
        "stocks_sent": len(per_stock_payloads),
        "stocks_skipped": len(skipped),
        "skipped_sample": skipped[:20],
        "batch_count": batch_count,
        "total_prep_rows": total_rows,
        "prep_results": prep_results,
        "orchestrator_result": orchestrator_result,
    }
