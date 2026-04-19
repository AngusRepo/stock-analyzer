"""
services/modal_client.py — ML 推論呼叫封裝

兩種後端（自動選擇）：
  1. Modal Functions — MODAL_TOKEN_ID 設定時，用 .map() 真正並行（每股一個 container）
  2. Cloud Run ML Service — fallback，httpx 並行 POST /predict（受 maxScale 限制）

環境變數：
  MODAL_TOKEN_ID / MODAL_TOKEN_SECRET → Modal path
  ML_SERVICE_URL / ML_SERVICE_SECRET → Cloud Run ML path（fallback）
"""
import os
import asyncio
import logging
import httpx

logger = logging.getLogger(__name__)

_APP_NAME         = "stockvision-ml"
_ML_SERVICE_URL   = os.environ.get("ML_SERVICE_URL", "")
_ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")
_USE_MODAL        = bool(os.environ.get("MODAL_TOKEN_ID", ""))


# ══════════════════════════════════════════════════════════════════════════════
# Modal path（MODAL_TOKEN_ID 設定時使用）
# ══════════════════════════════════════════════════════════════════════════════

def _lookup(fn_name: str):
    import modal  # lazy import — 只在呼叫時才載入
    try:
        return modal.Function.from_name(_APP_NAME, fn_name)  # Modal v1.x API
    except Exception as e:
        raise RuntimeError(f"Modal lookup failed: {_APP_NAME}/{fn_name} → {e}")


async def _modal_batch_predict(payloads: list[dict]) -> list[dict]:
    """
    2026-04-08 P1 fix: use return_exceptions=True so one task timeout (e.g.
    Modal 300s per-input limit) doesn't kill the whole batch. Exception items
    are converted into error dicts downstream consumers already handle
    (graphs/daily_pipeline_v2.py:node_ml_predict filters r.get("error")).

    Before: 1 slow task → FunctionTimeoutError → fn.map.aio raises → whole
    pipeline dies at ~212s → Worker 524. See memory/project_session_2026_04_08_part5.md.
    """
    fn = _lookup("predict_single_stock")
    results: list[dict] = []
    idx = 0
    async for r in fn.map.aio(payloads, order_outputs=True, return_exceptions=True):
        if isinstance(r, BaseException):
            p = payloads[idx] if idx < len(payloads) else {}
            exc_type = type(r).__name__
            logger.warning(
                f"[modal_client] predict task failed "
                f"symbol={p.get('symbol','?')} exc={exc_type}: {r}"
            )
            results.append({
                "stock_id": p.get("stock_id", 0),
                "symbol": p.get("symbol", "?"),
                "error": f"{exc_type}: {r}",
                "signal": "NO_SIGNAL",
                "direction": "neutral",
                "confidence": 0.0,
            })
        else:
            results.append(r)
        idx += 1
    return results


async def _modal_batch_retrain(payloads: list[dict]) -> list[dict]:
    fn = _lookup("retrain_single_stock")
    results = []
    async for r in fn.map.aio(payloads, order_outputs=True):
        results.append(r)
    return results


async def _modal_prep_universal_batch(payload: dict) -> dict:
    fn = _lookup("prep_universal_batch")
    return await fn.remote.aio(payload)


async def _modal_train_universal(payload: dict) -> dict:
    fn = _lookup("train_universal_from_gcs")
    return await fn.remote.aio(payload)


async def _modal_retrain_orchestrator(payload: dict) -> dict:
    fn = _lookup("retrain_orchestrator")
    return await fn.remote.aio(payload)


async def _modal_shap_audit(payload: dict) -> dict:
    fn = _lookup("shap_feature_audit")
    return await fn.remote.aio(payload)


async def _modal_batch_arf(payloads: list[dict]) -> list[dict]:
    fn = _lookup("update_arf_reward")
    results = []
    async for r in fn.map.aio(payloads, order_outputs=True):
        results.append(r)
    return results


# ── Walk-Forward helpers (2026-04-18 #32 Sprint 6b) ───────────────────────────

async def _modal_train_wf_tree_window(payload: dict) -> dict:
    fn = _lookup("train_wf_tree_window")
    return await fn.remote.aio(payload)


async def _modal_train_wf_ftt_window(payload: dict) -> dict:
    fn = _lookup("train_wf_ftt_window")
    return await fn.remote.aio(payload)


async def _modal_train_wf_hmm_window(payload: dict) -> dict:
    fn = _lookup("train_wf_hmm_window")
    return await fn.remote.aio(payload)


def _spawn_wf_tree_window(payload: dict):
    """Spawn tree training (returns handle immediately, caller .get() later)."""
    fn = _lookup("train_wf_tree_window")
    return fn.spawn(payload)


# 2026-04-19 ML_POOL Stage 0.1: Chronos universal batch predictor
async def _modal_chronos_universal_predict(payload: dict) -> dict:
    fn = _lookup("chronos_universal_predict")
    return await fn.remote.aio(payload)


async def chronos_batch_predict(series_list: list[dict], horizon: int = 5, num_samples: int = 20) -> dict:
    """Universal Chronos forecast for a batch of stocks.

    series_list: [{"symbol": str, "prices": list[float]}]
    Returns: {"results": [...], "n_input": int, "n_success": int}
    """
    return await _modal_chronos_universal_predict({
        "series_list": series_list,
        "horizon": horizon,
        "num_samples": num_samples,
    })


# 2026-04-19 ML_POOL Stage 0.2: DLinear universal helpers
async def _modal_dlinear_universal_predict(payload: dict) -> dict:
    fn = _lookup("dlinear_universal_predict")
    return await fn.remote.aio(payload)


async def dlinear_batch_predict(series_list: list[dict], horizon_used: int = 5, version: str = "v1") -> dict:
    """Universal DLinear forecast for a batch of stocks.

    series_list: [{"symbol": str, "prices": list[float]}]
    Returns: {"results": [...], "n_input": int, "n_success": int}
    Note: returns error rows if no trained DLinear weights exist in GCS yet.
    """
    return await _modal_dlinear_universal_predict({
        "series_list": series_list,
        "horizon_used": horizon_used,
        "version": version,
    })


async def _modal_train_dlinear_universal(payload: dict) -> dict:
    fn = _lookup("train_dlinear_universal")
    return await fn.remote.aio(payload)


async def train_dlinear_universal(series_close: list[list[float]], **hyperparams) -> dict:
    """One-shot universal DLinear training.

    series_close: list of close-price lists (one per stock).
    hyperparams: seq_len/pred_len/kernel/n_epochs/batch_size/lr/val_ratio/version
    Returns: {"saved": {weights_path, metadata_path}, "metadata": {...}, "version": str}
    """
    payload = {"series_close": series_close, **hyperparams}
    return await _modal_train_dlinear_universal(payload)


def _spawn_wf_ftt_window(payload: dict):
    """Spawn FT-T training (returns handle)."""
    fn = _lookup("train_wf_ftt_window")
    return fn.spawn(payload)


def spawn_walk_forward_orchestrator(payload: dict):
    """Spawn the Modal-resident walk-forward orchestrator and return its FunctionCall.
    Fire-and-forget from ml-controller side: orchestrator runs inside Modal for
    up to 4 hours, persists result to GCS walk_forward/runs/{start}_{end}.json.
    """
    fn = _lookup("walk_forward_orchestrator")
    return fn.spawn(payload)


# ══════════════════════════════════════════════════════════════════════════════
# Cloud Run ML path（httpx 並行，fallback）
# ══════════════════════════════════════════════════════════════════════════════

def _ml_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if _ML_SERVICE_SECRET:
        h["X-Service-Token"] = _ML_SERVICE_SECRET
    return h


async def _http_post_one(client: httpx.AsyncClient, url: str, payload: dict) -> dict:
    """單股 HTTP POST，失敗時回傳 error dict。"""
    try:
        resp = await client.post(url, json=payload, headers=_ml_headers())
        if resp.status_code == 200:
            return resp.json()
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": f"HTTP {resp.status_code}",
            "signal": "NO_SIGNAL", "direction": "neutral", "confidence": 0.0,
        }
    except Exception as e:
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": str(e),
            "signal": "NO_SIGNAL", "direction": "neutral", "confidence": 0.0,
        }


async def _http_batch(
    endpoint: str,
    payloads: list[dict],
    concurrency: int = 20,            # 2026-04-07 F2: 4→20，配合 ml-service Cloud Run max_containers=20
    per_request_timeout: float = 90.0  # 單股 timeout (Modal cold start ~30s + 11 model ensemble ~30s + buffer)
) -> list[dict]:
    """
    httpx 並行呼叫 Cloud Run ML Service。
    concurrency: 同時最多幾個請求（Cloud Run max_containers=20，並行度對齊）
    per_request_timeout: 單股 HTTP timeout（包含 cold start + model load + ensemble）

    2026-04-07 F2 fix: 之前 concurrency=4 是 524 timeout 真因。
    20 stocks 序列 × 4 並行 = 5 round × ~25s = 125s > Cloudflare 100s edge timeout。
    現在 concurrency=20 → 1 round 全部並行 → ~50-70s。
    """
    url = f"{_ML_SERVICE_URL}{endpoint}"
    sem = asyncio.Semaphore(concurrency)
    results: list[dict] = [{} for _ in payloads]

    async def run(idx: int, p: dict):
        async with sem:
            results[idx] = await _http_post_one(client, url, p)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(per_request_timeout, connect=15.0)
    ) as client:
        tasks = [run(i, p) for i, p in enumerate(payloads)]
        await asyncio.gather(*tasks)

    return results


# ══════════════════════════════════════════════════════════════════════════════
# Public API（自動選擇 Modal / HTTP）
# ══════════════════════════════════════════════════════════════════════════════

async def batch_predict(payloads: list[dict]) -> list[dict]:
    """並行推論 N 支股票。"""
    if _USE_MODAL:
        logger.info(f"[ml_client] Modal.map predict × {len(payloads)}")
        return await _modal_batch_predict(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel predict × {len(payloads)} → {_ML_SERVICE_URL}")
        # B11 fix (2026-04-08 audit): concurrency 4→20，覆蓋 Part 6 F2 fix 默認值
        # 信號池天生小，concurrency 4 進一步壓縮高 conf 候選數量，疊加 Layer 2 後幾乎過不了
        return await _http_batch("/predict", payloads, concurrency=20)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def batch_retrain(payloads: list[dict]) -> list[dict]:
    """並行重訓 N 支股票模型。"""
    if _USE_MODAL:
        return await _modal_batch_retrain(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel retrain × {len(payloads)}")
        return await _http_batch("/retrain", payloads, concurrency=2)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def prep_universal_batch(payload: dict) -> dict:
    """單批 prep — build_feature_matrix → 存 GCS npz。"""
    if _USE_MODAL:
        logger.info(f"[ml_client] Modal.remote prep_universal batch_{payload.get('batch_index', '?')}")
        return await _modal_prep_universal_batch(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/retrain/universal/prep"
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}"}
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def train_universal(payload: dict) -> dict:
    """觸發 train — 從 GCS 讀 prep 結果訓練。"""
    if _USE_MODAL:
        logger.info(f"[ml_client] Modal.remote train_universal ({payload.get('batch_count', '?')} batches)")
        return await _modal_train_universal(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/retrain/universal/train"
        async with httpx.AsyncClient(timeout=httpx.Timeout(2700.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}"}
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def shap_audit(payload: dict | None = None) -> dict:
    """觸發 SHAP Feature Importance Audit（從 GCS prep data 跑）。"""
    payload = payload or {}
    if _USE_MODAL:
        logger.info(f"[ml_client] Modal.remote shap_feature_audit (samples={payload.get('shap_samples', 5000)})")
        return await _modal_shap_audit(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/audit/shap"
        async with httpx.AsyncClient(timeout=httpx.Timeout(1800.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}"}
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def retrain_orchestrator(payload: dict, fire_and_forget: bool = True) -> dict:
    """2.0 Flow B: 觸發 Modal retrain_orchestrator（selection → train → SHAP 全在 Modal 完成）。

    fire_and_forget=True (default): spawn，Cloud Run 立刻 return，不佔 HTTP 連線。
    fire_and_forget=False: await 等 Modal 完成（用於手動 debug）。
    """
    if _USE_MODAL:
        fn = _lookup("retrain_orchestrator")
        if fire_and_forget:
            logger.info(f"[ml_client] Modal.spawn retrain_orchestrator (monthly={payload.get('is_monthly')})")
            await fn.spawn.aio(payload)
            return {"status": "spawned", "is_monthly": payload.get("is_monthly")}
        else:
            logger.info(f"[ml_client] Modal.remote retrain_orchestrator (await, monthly={payload.get('is_monthly')})")
            return await fn.remote.aio(payload)
    raise RuntimeError("retrain_orchestrator requires Modal (no HTTP fallback)")


async def feature_selection(payload: dict | None = None, fire_and_forget: bool = False) -> dict:
    """觸發 V2 Feature Selection Pipeline (Silhouette → Target Permutation → Feature Pool).

    fire_and_forget=True: spawn Modal function without waiting (for monthly auto-trigger).
    """
    payload = payload or {}
    if _USE_MODAL:
        fn = _lookup("feature_selection_pipeline")
        if fire_and_forget:
            logger.info("[ml_client] Modal.spawn feature_selection_pipeline (fire-and-forget)")
            await fn.spawn.aio(payload)
            return {"status": "spawned", "message": "Feature selection running in background"}
        logger.info("[ml_client] Modal.remote feature_selection_pipeline")
        return await fn.remote.aio(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/audit/feature-selection"
        async with httpx.AsyncClient(timeout=httpx.Timeout(3600.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}"}
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def batch_update_arf(payloads: list[dict]) -> list[dict]:
    """並行更新 ARF/LinUCB reward。"""
    if _USE_MODAL:
        return await _modal_batch_arf(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel ARF × {len(payloads)}")
        return await _http_batch("/arf/update", payloads, concurrency=4)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")
