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
    fn = _lookup("predict_single_stock")
    results = []
    async for r in fn.map.aio(payloads, order_outputs=True):
        results.append(r)
    return results


async def _modal_batch_retrain(payloads: list[dict]) -> list[dict]:
    fn = _lookup("retrain_single_stock")
    results = []
    async for r in fn.map.aio(payloads, order_outputs=True):
        results.append(r)
    return results


async def _modal_batch_arf(payloads: list[dict]) -> list[dict]:
    fn = _lookup("update_arf_reward")
    results = []
    async for r in fn.map.aio(payloads, order_outputs=True):
        results.append(r)
    return results


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


async def _http_batch(endpoint: str, payloads: list[dict], concurrency: int = 4) -> list[dict]:
    """
    httpx 並行呼叫 Cloud Run ML Service。
    concurrency: 同時最多幾個請求（Cloud Run maxScale × ~2）
    """
    url = f"{_ML_SERVICE_URL}{endpoint}"
    sem = asyncio.Semaphore(concurrency)
    results: list[dict] = [{}] * len(payloads)

    async def run(idx: int, p: dict):
        async with sem:
            results[idx] = await _http_post_one(client, url, p)

    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as client:
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
        return await _http_batch("/predict", payloads, concurrency=4)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def batch_retrain(payloads: list[dict]) -> list[dict]:
    """並行重訓 N 支股票模型。"""
    if _USE_MODAL:
        return await _modal_batch_retrain(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel retrain × {len(payloads)}")
        return await _http_batch("/retrain", payloads, concurrency=2)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")


async def batch_update_arf(payloads: list[dict]) -> list[dict]:
    """並行更新 ARF/LinUCB reward。"""
    if _USE_MODAL:
        return await _modal_batch_arf(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel ARF × {len(payloads)}")
        return await _http_batch("/update-arf", payloads, concurrency=4)
    raise RuntimeError("Neither MODAL_TOKEN_ID nor ML_SERVICE_URL is set")
