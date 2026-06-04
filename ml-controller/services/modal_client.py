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
import time
import hashlib
import json
import httpx

logger = logging.getLogger(__name__)

_APP_NAME         = "stockvision-ml"
_ML_SERVICE_URL   = os.environ.get("ML_SERVICE_URL", "")
_ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")
_USE_MODAL        = bool(os.environ.get("MODAL_TOKEN_ID", ""))

_DEFAULT_MODAL_RESOURCE = {"cpu": 1.0, "memory_mb": 1024, "gpu": None}
_MODAL_RESOURCE_SPECS: dict[str, dict] = {
    "predict_single_stock": {"cpu": 1.0, "memory_mb": 2048, "gpu": None},
    "predict_batch_v2": {"cpu": 2.0, "memory_mb": 8192, "gpu": None},
    "retrain_single_stock": {"cpu": 1.0, "memory_mb": 2048, "gpu": None},
    "prep_universal_batch": {"cpu": 1.0, "memory_mb": 2048, "gpu": None},
    "retrain_orchestrator": {"cpu": 1.0, "memory_mb": 1024, "gpu": None},
    "train_universal_from_gcs": {"cpu": 1.0, "memory_mb": 4096, "gpu": "L4"},
    "train_tree_models": {"cpu": 2.0, "memory_mb": 4096, "gpu": None},
    "train_wf_tree_window": {"cpu": 2.0, "memory_mb": 4096, "gpu": None},
    "train_wf_hmm_window": {"cpu": 1.0, "memory_mb": 2048, "gpu": None},
    "walk_forward_orchestrator": {"cpu": 1.0, "memory_mb": 2048, "gpu": None},
    "shap_feature_audit": {"cpu": 1.0, "memory_mb": 4096, "gpu": "L4"},
    "feature_selection_pipeline": {"cpu": 4.0, "memory_mb": 8192, "gpu": None},
    "train_dlinear_universal": {"cpu": 1.0, "memory_mb": 8192, "gpu": "L4"},
    "dlinear_universal_predict": {"cpu": 2.0, "memory_mb": 2048, "gpu": None},
    "train_patchtst_universal": {"cpu": 1.0, "memory_mb": 8192, "gpu": "L4"},
    "patchtst_universal_predict": {"cpu": 2.0, "memory_mb": 4096, "gpu": None},
    "itransformer_universal_predict": {"cpu": 2.0, "memory_mb": 4096, "gpu": None},
    "timesfm_universal_predict": {"cpu": 1.0, "memory_mb": 8192, "gpu": "L4"},
    "research_model_benchmark": {"cpu": 2.0, "memory_mb": 8192, "gpu": "L4"},
    "breeze2_research_context": {"cpu": 1.0, "memory_mb": 1024, "gpu": None},
    "breeze2_reason_generation": {"cpu": 2.0, "memory_mb": 16384, "gpu": "L4"},
    "state_space_universal_predict": {"cpu": 2.0, "memory_mb": 2048, "gpu": None},
    "feature_selection_per_window": {"cpu": 4.0, "memory_mb": 8192, "gpu": None},
    "update_arf_reward": {"cpu": 1.0, "memory_mb": 1024, "gpu": None},
}


def _modal_resource_spec(function_name: str) -> dict:
    return {**_DEFAULT_MODAL_RESOURCE, **_MODAL_RESOURCE_SPECS.get(function_name, {})}


def _aggregate_map_compute_sec(*, wall_sec: float, item_count: int) -> float:
    return round(float(wall_sec) * max(1, int(item_count or 0)), 3)


def _chunk_payloads(payloads: list[dict], chunk_size: int) -> list[list[dict]]:
    size = max(1, int(chunk_size or 1))
    return [payloads[i:i + size] for i in range(0, len(payloads), size)]


def _modal_predict_batch_v2_enabled() -> bool:
    raw = os.environ.get("MODAL_PREDICT_BATCH_V2")
    if raw is None or not raw.strip():
        return True
    return raw.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _parse_chunk_candidates(raw: str | None) -> list[int]:
    values: list[int] = []
    for part in (raw or "20,40,80").split(","):
        try:
            value = int(part.strip())
        except ValueError:
            continue
        if value > 0 and value not in values:
            values.append(value)
    return values or [20, 40, 80]


def _stable_chunk_size(candidates: list[int], ab_key: str | None) -> int:
    if not candidates:
        return 40
    if not ab_key:
        # Health/readiness calls do not have a production universe. Keep the
        # midpoint stable, while real runs pass a universe/run key below.
        return candidates[len(candidates) // 2]
    digest = hashlib.sha256(ab_key.encode("utf-8")).hexdigest()
    return candidates[int(digest[:8], 16) % len(candidates)]


def _parse_chunk_observations(raw: str | None) -> list[dict]:
    if not raw or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if isinstance(data, dict) and isinstance(data.get("observations"), list):
        data = data["observations"]
    if isinstance(data, dict):
        observations = []
        for chunk_size, value in data.items():
            if isinstance(value, dict):
                observations.append({"chunk_size": chunk_size, **value})
        return observations
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def _num(value, default: float = 0.0) -> float:
    try:
        if value is not None:
            return float(value)
    except (TypeError, ValueError):
        pass
    return float(default)


def _int(value, default: int = 0) -> int:
    try:
        if value is not None:
            return int(float(value))
    except (TypeError, ValueError):
        pass
    return int(default)


def _select_chunk_size_from_observations(
    candidates: list[int],
    observations: list[dict],
    *,
    min_runs: int = 1,
    max_error_rate: float = 0.02,
) -> tuple[int | None, dict]:
    candidate_set = {int(c) for c in candidates if int(c) > 0}
    grouped: dict[int, dict] = {}
    for obs in observations or []:
        chunk_size = _int(obs.get("chunk_size"))
        if chunk_size not in candidate_set:
            continue
        wall_sec = _num(obs.get("wall_sec") or obs.get("duration_sec") or obs.get("elapsed_sec"))
        input_count = _int(
            obs.get("input_count")
            or obs.get("n_input")
            or obs.get("symbols")
            or obs.get("result_count")
        )
        if input_count <= 0:
            chunk_count = _int(obs.get("chunk_count"), 1)
            input_count = max(1, chunk_size * max(1, chunk_count))
        if wall_sec <= 0:
            continue
        runs = max(1, _int(obs.get("runs"), 1))
        errors = _int(
            obs.get("n_error")
            or obs.get("result_error_count")
            or obs.get("error_count")
            or obs.get("errors")
        )
        bucket = grouped.setdefault(
            chunk_size,
            {"chunk_size": chunk_size, "runs": 0, "wall_sec": 0.0, "input_count": 0, "error_count": 0},
        )
        bucket["runs"] += runs
        bucket["wall_sec"] += wall_sec
        bucket["input_count"] += input_count
        bucket["error_count"] += errors

    ranked = []
    rejected = []
    for chunk_size, bucket in grouped.items():
        input_count = max(1, int(bucket["input_count"]))
        wall_per_symbol = float(bucket["wall_sec"]) / input_count
        error_rate = int(bucket["error_count"]) / input_count
        summary = {
            "chunk_size": chunk_size,
            "runs": int(bucket["runs"]),
            "wall_sec": round(float(bucket["wall_sec"]), 3),
            "input_count": input_count,
            "error_count": int(bucket["error_count"]),
            "wall_sec_per_symbol": round(wall_per_symbol, 6),
            "error_rate": round(error_rate, 6),
        }
        if int(bucket["runs"]) < max(1, int(min_runs)):
            rejected.append({**summary, "reason": "min_runs"})
            continue
        if error_rate > max(0.0, float(max_error_rate)):
            rejected.append({**summary, "reason": "error_rate"})
            continue
        ranked.append(summary)

    ranked.sort(key=lambda item: (item["wall_sec_per_symbol"], item["error_rate"], item["chunk_size"]))
    if not ranked:
        return None, {
            "source": "observed_wall_time",
            "selected": None,
            "eligible": [],
            "rejected": rejected,
            "reason": "no_eligible_observations",
        }
    selected = ranked[0]
    return int(selected["chunk_size"]), {
        "source": "observed_wall_time",
        "selected": selected,
        "eligible": ranked,
        "rejected": rejected,
        "reason": "lowest_wall_sec_per_symbol_with_error_gate",
    }


def _batch_ab_key(payloads: list[dict]) -> str:
    symbols = [
        str(p.get("symbol") or p.get("stock_id") or "")
        for p in payloads or []
        if isinstance(p, dict)
    ]
    return "|".join(sorted(s for s in symbols if s))


def batch_predict_contract(*, ab_key: str | None = None) -> dict:
    # Larger chunks amortize universal model GCS loads across more symbols while
    # staying below the 900s Modal predict_batch_v2 timeout. When no explicit
    # size is configured, production runs rotate over 20/40/80 using a stable
    # key so we can compare real compute/runtime without random jitter.
    candidates = _parse_chunk_candidates(os.environ.get("MODAL_PREDICT_BATCH_SIZE_CANDIDATES"))
    raw_chunk_size = os.environ.get("MODAL_PREDICT_BATCH_SIZE")
    chunk_size_source = "ab"
    chunk_policy = None
    try:
        if raw_chunk_size:
            chunk_size = max(1, int(raw_chunk_size))
        else:
            observations = _parse_chunk_observations(os.environ.get("MODAL_PREDICT_BATCH_SIZE_OBSERVATIONS"))
            observed_chunk_size, chunk_policy = _select_chunk_size_from_observations(
                candidates,
                observations,
                min_runs=_int(os.environ.get("MODAL_PREDICT_BATCH_SIZE_MIN_RUNS"), 1),
                max_error_rate=_num(os.environ.get("MODAL_PREDICT_BATCH_SIZE_MAX_ERROR_RATE"), 0.02),
            )
            if observed_chunk_size:
                chunk_size = observed_chunk_size
                chunk_size_source = "observed_wall_time"
            else:
                chunk_size = _stable_chunk_size(candidates, ab_key)
        if raw_chunk_size:
            chunk_size_source = "explicit"
    except (TypeError, ValueError):
        chunk_size = _stable_chunk_size(candidates, ab_key)
    return {
        "modal_predict_batch_v2": _modal_predict_batch_v2_enabled(),
        "chunk_size": chunk_size,
        "chunk_size_source": chunk_size_source,
        "chunk_candidates": candidates,
        "ab_key": ab_key,
        "chunk_policy": chunk_policy,
    }


def _aggregate_predict_batch_metrics(batch_responses: list[dict]) -> dict:
    cache = {"hits": 0, "misses": 0, "gcs_downloads": 0}
    chunks_reported = 0
    batch_counts = {"n_input": 0, "n_error": 0}
    for response in batch_responses or []:
        if not isinstance(response, dict):
            continue
        metrics = response.get("metrics") if isinstance(response.get("metrics"), dict) else {}
        batch = metrics.get("batch") if isinstance(metrics.get("batch"), dict) else {}
        if batch:
            batch_counts["n_input"] += _int(batch.get("n_input"))
            batch_counts["n_error"] += _int(batch.get("n_error"))
        model_cache = metrics.get("model_cache") if isinstance(metrics.get("model_cache"), dict) else {}
        if not model_cache:
            continue
        chunks_reported += 1
        for key in cache:
            try:
                cache[key] += int(model_cache.get(key, 0) or 0)
            except (TypeError, ValueError):
                continue
    denom = cache["hits"] + cache["misses"]
    return {
        "chunks_reported": chunks_reported,
        "batch": batch_counts,
        "batch_error_rate": (
            round(batch_counts["n_error"] / batch_counts["n_input"], 6)
            if batch_counts["n_input"]
            else None
        ),
        "model_cache": cache,
        "model_cache_hit_ratio": round(cache["hits"] / denom, 4) if denom else None,
    }


async def _record_modal_observation(
    function_name: str,
    *,
    wall_sec: float,
    compute_sec: float | None = None,
    source: str = "modal_function",
    meta: dict | None = None,
) -> None:
    try:
        from services.cost_tracker import record_modal_call

        spec = _modal_resource_spec(function_name)
        await record_modal_call(
            source=source,
            function_name=function_name,
            compute_sec=round(compute_sec if compute_sec is not None else wall_sec, 3),
            cpu=float(spec["cpu"]),
            memory_mb=int(spec["memory_mb"]),
            gpu=spec.get("gpu"),
            meta={"wall_sec": round(wall_sec, 3), **(meta or {})},
        )
    except Exception as exc:  # noqa: BLE001 - telemetry must never break compute.
        logger.debug("[modal_client] telemetry skipped for %s: %s", function_name, exc)


# ══════════════════════════════════════════════════════════════════════════════
# Modal path（MODAL_TOKEN_ID 設定時使用）
# ══════════════════════════════════════════════════════════════════════════════

def _lookup(fn_name: str):
    import modal  # lazy import — 只在呼叫時才載入
    try:
        return modal.Function.from_name(_APP_NAME, fn_name)  # Modal v1.x API
    except Exception as e:
        raise RuntimeError(f"Modal lookup failed: {_APP_NAME}/{fn_name} → {e}")


async def _modal_remote_call(function_name: str, payload: dict, *, source: str = "modal_function") -> dict:
    t0 = time.time()
    try:
        fn = _lookup(function_name)
        return await fn.remote.aio(payload)
    finally:
        wall_sec = time.time() - t0
        await _record_modal_observation(
            function_name,
            wall_sec=wall_sec,
            source=source,
            meta={"call_type": "remote"},
        )


async def _modal_batch_predict(payloads: list[dict]) -> list[dict]:
    """
    2026-04-08 P1 fix: use return_exceptions=True so one task timeout (e.g.
    Modal 300s per-input limit) doesn't kill the whole batch. Exception items
    are converted into error dicts downstream consumers already handle
    (graphs/daily_pipeline_v2.py:node_ml_predict filters r.get("error")).

    Before: 1 slow task → FunctionTimeoutError → fn.map.aio raises → whole
    pipeline dies at ~212s → Worker 524. See memory/project_session_2026_04_08_part5.md.
    """
    function_name = "predict_single_stock"
    t0 = time.time()
    try:
        fn = _lookup(function_name)
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
    finally:
        wall_sec = time.time() - t0
        await _record_modal_observation(
            function_name,
            wall_sec=wall_sec,
            compute_sec=_aggregate_map_compute_sec(wall_sec=wall_sec, item_count=len(payloads)),
            meta={"call_type": "map", "input_count": len(payloads)},
        )


async def _modal_batch_predict_v2(payloads: list[dict]) -> list[dict]:
    function_name = "predict_batch_v2"
    ab_key = _batch_ab_key(payloads)
    contract = batch_predict_contract(ab_key=ab_key)
    chunk_size = contract["chunk_size"]
    chunks = _chunk_payloads(payloads, chunk_size)
    batch_responses: list[dict] = []
    results: list[dict] = []
    t0 = time.time()
    try:
        fn = _lookup(function_name)
        idx = 0
        async for r in fn.map.aio(
            [{"payloads": chunk} for chunk in chunks],
            order_outputs=True,
            return_exceptions=True,
        ):
            chunk = chunks[idx] if idx < len(chunks) else []
            idx += 1
            if isinstance(r, BaseException):
                results.extend({
                    "stock_id": p.get("stock_id", 0),
                    "symbol": p.get("symbol", "?"),
                    "error": f"predict_batch_v2 chunk error: {type(r).__name__}: {r}",
                    "signal": "NO_SIGNAL",
                    "direction": "neutral",
                    "confidence": 0.0,
                } for p in chunk)
                continue
            chunk_results = r.get("results", r) if isinstance(r, dict) else r
            if not isinstance(chunk_results, list):
                results.extend({
                    "stock_id": p.get("stock_id", 0),
                    "symbol": p.get("symbol", "?"),
                    "error": "predict_batch_v2 returned invalid payload",
                    "signal": "NO_SIGNAL",
                    "direction": "neutral",
                    "confidence": 0.0,
                } for p in chunk)
                continue
            if isinstance(r, dict):
                batch_responses.append(r)
            results.extend(chunk_results)
        return results
    finally:
        wall_sec = time.time() - t0
        result_count = len(results)
        result_error_count = sum(
            1 for item in results if isinstance(item, dict) and item.get("error")
        )
        batch_metrics = _aggregate_predict_batch_metrics(batch_responses)
        await _record_modal_observation(
            function_name,
            wall_sec=wall_sec,
            compute_sec=_aggregate_map_compute_sec(wall_sec=wall_sec, item_count=len(chunks)),
            meta={
                "call_type": "map_batch",
                "input_count": len(payloads),
                "chunk_count": len(chunks),
                "chunk_size": chunk_size,
                "chunk_sizes": [len(chunk) for chunk in chunks],
                "batch_contract": contract,
                "result_count": result_count,
                "result_error_count": result_error_count,
                "result_error_rate": round(result_error_count / result_count, 6) if result_count else None,
                "batch_error_rate": batch_metrics.get("batch_error_rate"),
                "model_cache_hit_ratio": batch_metrics.get("model_cache_hit_ratio"),
                "batch_metrics": batch_metrics,
            },
        )


async def _modal_batch_retrain(payloads: list[dict]) -> list[dict]:
    function_name = "retrain_single_stock"
    t0 = time.time()
    try:
        fn = _lookup(function_name)
        results = []
        async for r in fn.map.aio(payloads, order_outputs=True):
            results.append(r)
        return results
    finally:
        wall_sec = time.time() - t0
        await _record_modal_observation(
            function_name,
            wall_sec=wall_sec,
            compute_sec=_aggregate_map_compute_sec(wall_sec=wall_sec, item_count=len(payloads)),
            meta={"call_type": "map", "input_count": len(payloads)},
        )


async def _modal_prep_universal_batch(payload: dict) -> dict:
    return await _modal_remote_call("prep_universal_batch", payload)


async def _modal_train_universal(payload: dict) -> dict:
    return await _modal_remote_call("train_universal_from_gcs", payload)


async def _modal_retrain_orchestrator(payload: dict) -> dict:
    return await _modal_remote_call("retrain_orchestrator", payload)


async def _modal_shap_audit(payload: dict) -> dict:
    return await _modal_remote_call("shap_feature_audit", payload)


async def _modal_ft_arch_search(payload: dict) -> dict:
    """Retired FT-Transformer architecture-search guard."""
    return {"error": "FT-Transformer retired from the production model pool", "status": "retired"}


async def _modal_batch_arf(payloads: list[dict]) -> list[dict]:
    function_name = "update_arf_reward"
    t0 = time.time()
    try:
        fn = _lookup(function_name)
        results = []
        async for r in fn.map.aio(payloads, order_outputs=True):
            results.append(r)
        return results
    finally:
        wall_sec = time.time() - t0
        await _record_modal_observation(
            function_name,
            wall_sec=wall_sec,
            compute_sec=_aggregate_map_compute_sec(wall_sec=wall_sec, item_count=len(payloads)),
            meta={"call_type": "map", "input_count": len(payloads)},
        )


# ── Walk-Forward helpers (2026-04-18 #32 Sprint 6b) ───────────────────────────

async def _modal_train_wf_tree_window(payload: dict) -> dict:
    return await _modal_remote_call("train_wf_tree_window", payload)


async def _modal_train_wf_ftt_window(payload: dict) -> dict:
    return {"error": "FT-Transformer retired from walk-forward training", "status": "retired"}


async def _modal_train_wf_hmm_window(payload: dict) -> dict:
    return await _modal_remote_call("train_wf_hmm_window", payload)


def _spawn_wf_tree_window(payload: dict):
    """Spawn tree training (returns handle immediately, caller .get() later)."""
    fn = _lookup("train_wf_tree_window")
    return fn.spawn(payload)


# Retired Chronos guard.
async def _modal_chronos_universal_predict(payload: dict) -> dict:
    return {"error": "Chronos retired from the production model pool", "results": []}


async def chronos_batch_predict(series_list: list[dict], horizon: int = 5, num_samples: int = 20) -> dict:
    """Fail-closed retired Chronos batch endpoint."""
    return {"error": "Chronos retired from the production model pool", "results": [], "n_input": len(series_list or []), "n_success": 0}


# 2026-04-19 ML_POOL Stage 0.2: DLinear universal helpers
async def _modal_dlinear_universal_predict(payload: dict) -> dict:
    return await _modal_remote_call("dlinear_universal_predict", payload)


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
    return await _modal_remote_call("train_dlinear_universal", payload)


async def train_dlinear_universal(series_close: list[list[float]], **hyperparams) -> dict:
    """One-shot universal DLinear training.

    series_close: list of close-price lists (one per stock).
    hyperparams: seq_len/pred_len/kernel/n_epochs/batch_size/lr/val_ratio/version
    Returns: {"saved": {weights_path, metadata_path}, "metadata": {...}, "version": str}
    """
    payload = {"series_close": series_close, **hyperparams}
    return await _modal_train_dlinear_universal(payload)


# 2026-04-19 ML_POOL Stage 0.3: PatchTST universal helpers
async def _modal_patchtst_universal_predict(payload: dict) -> dict:
    return await _modal_remote_call("patchtst_universal_predict", payload)


async def patchtst_batch_predict(series_list: list[dict], horizon_used: int = 5, version: str = "v1") -> dict:
    """Universal PatchTST forecast for a batch of stocks."""
    return await _modal_patchtst_universal_predict({
        "series_list": series_list,
        "horizon_used": horizon_used,
        "version": version,
    })


async def _modal_itransformer_universal_predict(payload: dict) -> dict:
    return await _modal_remote_call("itransformer_universal_predict", payload)


async def itransformer_batch_predict(series_list: list[dict], horizon_used: int = 5, version: str = "v1") -> dict:
    """Artifact-backed iTransformer forecast for a batch of stocks."""
    return await _modal_itransformer_universal_predict({
        "series_list": series_list,
        "horizon_used": horizon_used,
        "version": version,
    })


async def _modal_timesfm_universal_predict(payload: dict) -> dict:
    return await _modal_remote_call("timesfm_universal_predict", payload)


async def timesfm_batch_predict(series_list: list[dict], horizon_used: int = 5, version: str = "v1") -> dict:
    """Config-backed TimesFM forecast for a batch of stocks."""
    return await _modal_timesfm_universal_predict({
        "series_list": series_list,
        "horizon_used": horizon_used,
        "version": version,
    })


async def _modal_train_patchtst_universal(payload: dict) -> dict:
    return await _modal_remote_call("train_patchtst_universal", payload)


async def train_patchtst_universal(series_close: list[list[float]], **hyperparams) -> dict:
    """One-shot universal PatchTST training."""
    payload = {"series_close": series_close, **hyperparams}
    return await _modal_train_patchtst_universal(payload)


async def _modal_research_model_benchmark(payload: dict) -> dict:
    return await _modal_remote_call("research_model_benchmark", payload, source="modal_research_benchmark")


async def research_model_benchmark(payload: dict) -> dict:
    """Run a research-only model-family benchmark on Modal.

    This is intentionally not part of production retrain/promote. Callers must
    treat the output as review evidence only.
    """
    if _USE_MODAL:
        return await _modal_research_model_benchmark(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/research/model-benchmark/run"
        async with httpx.AsyncClient(timeout=httpx.Timeout(7200.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}", "text": resp.text[:500]}
    raise RuntimeError("research_model_benchmark requires Modal or ML_SERVICE_URL")


async def _modal_breeze2_research_context(payload: dict) -> dict:
    return await _modal_remote_call("breeze2_research_context", payload, source="modal_breeze2")


async def breeze2_research_context(payload: dict) -> dict:
    """Run Breeze2 semantic context as a non-mutating research sidecar."""
    payload = {
        **payload,
        "allowed_use": "research_context_only",
        "mutation_allowed": False,
    }
    if _USE_MODAL:
        return await _modal_breeze2_research_context(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/breeze2/research-context"
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}", "text": resp.text[:500]}
    raise RuntimeError("breeze2_research_context requires Modal or ML_SERVICE_URL")


async def _modal_breeze2_reason_generation(payload: dict) -> dict:
    return await _modal_remote_call(
        "breeze2_reason_generation",
        payload,
        source="modal_breeze2_reason_generation",
    )


async def breeze2_reason_generation(payload: dict) -> dict:
    """Run Breeze2 text generation as a non-mutating reason shadow provider."""
    payload = {
        **payload,
        "allowed_use": "reason_shadow_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
    }
    if _USE_MODAL:
        return await _modal_breeze2_reason_generation(payload)
    if _ML_SERVICE_URL:
        url = f"{_ML_SERVICE_URL}/breeze2/reason-generation"
        async with httpx.AsyncClient(timeout=httpx.Timeout(900.0, connect=15.0)) as client:
            resp = await client.post(url, json=payload, headers=_ml_headers())
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}", "text": resp.text[:500]}
    raise RuntimeError("breeze2_reason_generation requires Modal or ML_SERVICE_URL")


# 2026-04-20 ML_POOL Stage 6.2: state-space batch predict helpers
async def _modal_state_space_predict(payload: dict) -> dict:
    return await _modal_remote_call("state_space_universal_predict", payload)


async def kalman_batch_predict(series_list: list[dict], horizon: int = 5, version: str = "v1") -> dict:
    """Universal KalmanFilter forecast batch (per-stock loop, shared hyperparams)."""
    return await _modal_state_space_predict({
        "model_name": "KalmanFilter",
        "series_list": series_list,
        "horizon": horizon,
        "version": version,
    })


async def markov_switching_batch_predict(series_list: list[dict], horizon: int = 5, version: str = "v1") -> dict:
    """Universal MarkovSwitching forecast batch."""
    return await _modal_state_space_predict({
        "model_name": "MarkovSwitching",
        "series_list": series_list,
        "horizon": horizon,
        "version": version,
    })


async def state_space_overlays_batch_predict(
    series_list: list[dict],
    *,
    horizon: int = 5,
    version_by_model: dict[str, str] | None = None,
) -> dict:
    """Run Kalman + Markov overlays through one Modal call.

    The individual kalman/markov helpers stay available as fallback-compatible
    paths, but daily serving should prefer this coalesced overlay contract.
    """
    return await _modal_state_space_predict({
        "model_names": ["KalmanFilter", "MarkovSwitching"],
        "series_list": series_list,
        "horizon": horizon,
        "version_by_model": version_by_model or {},
    })


def spawn_state_space_overlays_batch_predict(
    series_list: list[dict],
    *,
    horizon: int = 5,
    version_by_model: dict[str, str] | None = None,
) -> dict:
    """Spawn Kalman + Markov overlays without blocking the daily graph."""
    fn = _lookup("state_space_universal_predict")
    call = fn.spawn({
        "model_names": ["KalmanFilter", "MarkovSwitching"],
        "series_list": series_list,
        "horizon": horizon,
        "version_by_model": version_by_model or {},
    })
    call_id = (
        getattr(call, "object_id", None)
        or getattr(call, "function_call_id", None)
        or getattr(call, "call_id", None)
    )
    return {
        "spawned": True,
        "function_name": "state_space_universal_predict",
        "function_call_id": call_id,
        "n_input": len(series_list),
        "version_by_model": version_by_model or {},
    }


def _spawn_wf_ftt_window(payload: dict):
    """Retired FT-Transformer walk-forward guard."""
    raise RuntimeError("FT-Transformer retired from walk-forward training")


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
        if _modal_predict_batch_v2_enabled():
            logger.info(f"[ml_client] Modal.map predict_batch_v2 × {len(payloads)}")
            return await _modal_batch_predict_v2(payloads)
        logger.info(f"[ml_client] Modal.map predict × {len(payloads)}")
        return await _modal_batch_predict(payloads)
    if _ML_SERVICE_URL:
        logger.info(f"[ml_client] HTTP parallel predict × {len(payloads)} → {_ML_SERVICE_URL}")
        # B11 fix (2026-04-08 audit): concurrency 4→20，覆蓋 Part 6 F2 fix 默認值
        # 信號池天生小，concurrency 4 進一步壓縮高 conf 候選數量，疊加 Layer 2 後幾乎過不了
        return await _http_batch("/predict/v2", payloads, concurrency=20)
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
            t0 = time.time()
            await fn.spawn.aio(payload)
            await _record_modal_observation(
                "retrain_orchestrator",
                wall_sec=time.time() - t0,
                compute_sec=0.0,
                source="modal_spawn",
                meta={"call_type": "spawn", "is_monthly": payload.get("is_monthly")},
            )
            return {"status": "spawned", "is_monthly": payload.get("is_monthly")}
        else:
            logger.info(f"[ml_client] Modal.remote retrain_orchestrator (await, monthly={payload.get('is_monthly')})")
            return await _modal_remote_call("retrain_orchestrator", payload)
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
            t0 = time.time()
            await fn.spawn.aio(payload)
            await _record_modal_observation(
                "feature_selection_pipeline",
                wall_sec=time.time() - t0,
                compute_sec=0.0,
                source="modal_spawn",
                meta={"call_type": "spawn"},
            )
            return {"status": "spawned", "message": "Feature selection running in background"}
        logger.info("[ml_client] Modal.remote feature_selection_pipeline")
        return await _modal_remote_call("feature_selection_pipeline", payload)
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
