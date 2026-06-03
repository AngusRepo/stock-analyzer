"""
cost_tracker.py #43 Cost Tracking (2026-04-21)

Records LLM + Modal cost events into D1 `cost_events` table via CF REST API.
Fire-and-forget: failures never block the caller.

Rationale (ship-day):
  QuantaAlpha POC burned $1.43+ ephemeral + persistent Modal cost with zero
  visibility. Production LLM spend ($24/mo -> $1/mo after #45 migration, but
  growing again post Debate FinMem) also needs tracking. All instrumented
  calls record here so Wei + Discord alerts can see daily / monthly spend.

Pricing table (USD per 1M tokens, input / output, 2026-04 rates):
  claude-sonnet-4-6:          3.00 / 15.00
  claude-opus-4-7:           15.00 / 75.00
  gemini-3.1-flash-lite:      0.075 / 0.30
  gemini-2.5-flash-lite:      0.10 / 0.40
  deepseek-v3:                0.14 / 0.28
  gemma-27b (via Gemini API): 0.05 / 0.10  (published-rate estimate)

Modal cost estimation:
  Uses public per-second Modal rates for CPU, memory, and common GPUs.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json as _json
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
_CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
_CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
_CF_D1_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
    f"/d1/database/{_CF_D1_DB_ID}/query"
) if _CF_ACCOUNT_ID and _CF_D1_DB_ID else ""

# Price per 1K tokens (simpler math vs per-1M)
_PRICE_PER_1K: dict[str, tuple[float, float]] = {
    "claude-sonnet-4-6":              (0.003, 0.015),
    "claude-sonnet-4-5-20250929":     (0.003, 0.015),
    "claude-opus-4-7":                (0.015, 0.075),
    "gemini-3.1-flash-lite":          (0.000075, 0.00030),
    "gemini-3.1-flash-lite-preview":  (0.000075, 0.00030),
    "gemini-2.5-flash-lite":          (0.0001, 0.00040),
    "deepseek-v3":                    (0.00014, 0.00028),
    "gemma-27b":                      (0.00005, 0.00010),
}

_MODAL_CPU_CORE_SEC_PRICE = 0.0000131
_MODAL_MEMORY_GIB_SEC_PRICE = 0.00000222
_MODAL_GPU_SEC_PRICE: dict[str, float] = {
    "T4": 0.000164,
    "L4": 0.000222,
    "A10": 0.000306,
    "L40S": 0.000542,
    "A100-40GB": 0.000583,
    "A100-80GB": 0.000694,
    "H100": 0.001097,
    "H200": 0.001261,
    "B200": 0.001736,
}


def _est_llm_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    """Estimate LLM cost in USD. Falls back to 0 for unknown models."""
    if not model:
        return 0.0
    # Normalise: strip dated suffixes such as '-20250929'
    key = model.lower().strip()
    # Try exact match first, then prefix match.
    rate = _PRICE_PER_1K.get(key)
    if rate is None:
        for k, v in _PRICE_PER_1K.items():
            if key.startswith(k):
                rate = v
                break
    if rate is None:
        return 0.0
    pi, po = rate
    return (tokens_in / 1000.0) * pi + (tokens_out / 1000.0) * po


def estimate_modal_cost(
    *,
    compute_sec: float,
    cpu: float = 1.0,
    memory_mb: int = 0,
    gpu: Optional[str] = None,
) -> float:
    """Estimate Modal cost from aggregate billable compute seconds.

    `compute_sec` should be aggregate container seconds. For Modal map calls,
    callers should multiply wall-clock seconds by item count or measured
    container count, not pass controller wall-clock seconds only.
    """
    sec = max(0.0, float(compute_sec))
    cpu_cost = sec * max(0.0, float(cpu)) * _MODAL_CPU_CORE_SEC_PRICE
    mem_gib = max(0.0, float(memory_mb or 0) / 1024.0)
    memory_cost = sec * mem_gib * _MODAL_MEMORY_GIB_SEC_PRICE
    gpu_key = str(gpu or "").upper()
    gpu_cost = sec * _MODAL_GPU_SEC_PRICE.get(gpu_key, 0.0)
    return round(cpu_cost + memory_cost + gpu_cost, 6)


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    numeric = _float_or_none(value)
    return int(numeric) if numeric is not None else None


def _first_int(meta: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _int_or_none(meta.get(key))
        if value is not None:
            return value
    return None


def _first_float(meta: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = _float_or_none(meta.get(key))
        if value is not None:
            return value
    return None


def _artifact_count(meta: dict[str, Any]) -> int | None:
    explicit = _first_int(meta, ("artifact_count", "artifacts_count", "n_artifacts", "model_artifact_count"))
    if explicit is not None:
        return explicit
    for key in ("artifacts", "model_artifacts", "artifact_paths", "models"):
        value = meta.get(key)
        if isinstance(value, (list, tuple, set)):
            return len(value)
        if isinstance(value, dict):
            return len(value)
    return None


def build_modal_compute_profile(
    *,
    source: str,
    function_name: str,
    compute_sec: float,
    est_usd: float,
    cpu: float = 1.0,
    memory_mb: int = 0,
    gpu: Optional[str] = None,
    meta: Optional[dict] = None,
) -> dict[str, Any]:
    """Build the normalized Modal profile persisted to compute_profile_events."""
    meta = dict(meta or {})
    wall_sec = _float_or_none(meta.get("wall_sec"))
    if wall_sec is None:
        wall_sec = _float_or_none(meta.get("duration_sec")) or _float_or_none(compute_sec) or 0.0
    profile = {
        "provider": "modal",
        "job_name": function_name,
        "source": source,
        "run_id": meta.get("run_id") or meta.get("modal_run_id") or meta.get("pipeline_run_id"),
        "wall_sec": round(float(wall_sec), 3),
        "compute_sec": round(float(compute_sec), 3),
        "await_sec": _first_float(meta, ("await_sec", "orchestration_await_sec", "remote_wait_sec")),
        "compute_owner": meta.get("compute_owner") or "modal",
        "remote_function": meta.get("remote_function") or function_name,
        "cpu": float(cpu),
        "memory_mb": int(memory_mb or 0),
        "gpu": gpu,
        "est_usd": round(float(est_usd), 6),
        "rows": _first_int(meta, ("rows", "n_rows", "row_count", "total_samples", "sample_count", "train_samples")),
        "features": _first_int(meta, ("features", "n_features", "feature_count")),
        "symbols": _first_int(meta, ("symbols", "n_symbols", "symbol_count", "input_count")),
        "trials": _first_int(meta, ("trials", "n_trials", "trial_count")),
        "artifact_count": _artifact_count(meta),
        "cache_hit_ratio": _first_float(meta, ("cache_hit_ratio", "model_cache_hit_ratio")),
        "meta": meta,
    }
    return profile


def build_compute_profile_event_payload(
    *,
    profile: dict[str, Any],
    event_date: str,
    include_wait_columns: bool = True,
) -> dict[str, Any]:
    """Build a D1 insert payload for compute_profile_events."""
    wait_columns = "await_sec, compute_owner, remote_function, " if include_wait_columns else ""
    wait_placeholders = "?, ?, ?, " if include_wait_columns else ""
    wait_params = [
        _float_or_none(profile.get("await_sec")),
        profile.get("compute_owner"),
        profile.get("remote_function"),
    ] if include_wait_columns else []
    return {
        "sql": (
            "INSERT INTO compute_profile_events "
            f"(event_date, provider, job_name, run_id, wall_sec, compute_sec, {wait_columns}"
            "cpu, memory_mb, gpu, est_usd, rows, features, "
            "symbols, trials, cache_hit_ratio, profile_json) "
            f"VALUES (?, ?, ?, ?, ?, ?, {wait_placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "params": [
            event_date,
            str(profile.get("provider") or "unknown"),
            str(profile.get("job_name") or "unknown"),
            profile.get("run_id"),
            _float_or_none(profile.get("wall_sec")),
            _float_or_none(profile.get("compute_sec")),
            *wait_params,
            _float_or_none(profile.get("cpu")),
            _int_or_none(profile.get("memory_mb")),
            profile.get("gpu"),
            _float_or_none(profile.get("est_usd")),
            _int_or_none(profile.get("rows")),
            _int_or_none(profile.get("features")),
            _int_or_none(profile.get("symbols")),
            _int_or_none(profile.get("trials")),
            _float_or_none(profile.get("cache_hit_ratio")),
            _json.dumps(profile),
        ],
    }


async def _record(
    source: str,
    provider: Optional[str],
    model: Optional[str],
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    compute_sec: float = 0.0,
    est_usd: float = 0.0,
    meta: Optional[dict] = None,
) -> None:
    """Insert one cost event. Fire-and-forget — logs warning on failure."""
    if not _CF_D1_URL or not _CF_API_TOKEN:
        logger.debug("[cost_tracker] skip — CF env not configured")
        return

    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    payload = {
        "sql": (
            "INSERT INTO cost_events "
            "(ts, date, source, provider, model, tokens_in, tokens_out, compute_sec, est_usd, meta) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "params": [
            now.isoformat(),
            tw_date,
            source,
            provider,
            model,
            int(tokens_in),
            int(tokens_out),
            float(compute_sec),
            float(est_usd),
            _json.dumps(meta) if meta else None,
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                _CF_D1_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {_CF_API_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if r.status_code != 200:
                logger.warning(f"[cost_tracker] D1 insert failed {r.status_code}: {r.text[:200]}")
    except Exception as e:  # noqa: BLE001 — fire-and-forget
        logger.warning(f"[cost_tracker] exception (non-fatal): {e}")


async def _record_compute_profile_event(profile: dict[str, Any]) -> None:
    if not _CF_D1_URL or not _CF_API_TOKEN:
        logger.debug("[cost_tracker] skip compute profile - CF env not configured")
        return

    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    payload = build_compute_profile_event_payload(profile=profile, event_date=tw_date)

    def _missing_wait_columns(message: str) -> bool:
        normalized = message.lower()
        return (
            "await_sec" in normalized
            or "compute_owner" in normalized
            or "remote_function" in normalized
        ) and ("no such column" in normalized or "has no column named" in normalized or "no column" in normalized)

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                _CF_D1_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {_CF_API_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if r.status_code != 200:
                message = r.text[:200]
                if "no such table" in message.lower():
                    logger.debug("[cost_tracker] compute profile table missing; skip")
                elif _missing_wait_columns(message):
                    legacy_payload = build_compute_profile_event_payload(
                        profile=profile,
                        event_date=tw_date,
                        include_wait_columns=False,
                    )
                    retry = await client.post(
                        _CF_D1_URL,
                        json=legacy_payload,
                        headers={
                            "Authorization": f"Bearer {_CF_API_TOKEN}",
                            "Content-Type": "application/json",
                        },
                    )
                    if retry.status_code != 200:
                        logger.warning(f"[cost_tracker] legacy compute profile insert failed {retry.status_code}: {retry.text[:200]}")
                else:
                    logger.warning(f"[cost_tracker] compute profile insert failed {r.status_code}: {message}")
    except Exception as e:  # noqa: BLE001 - telemetry must never block callers.
        logger.warning(f"[cost_tracker] compute profile exception (non-fatal): {e}")


async def record_llm_call(
    source: str,
    provider: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    meta: Optional[dict] = None,
) -> None:
    """Record one LLM API call. Caller picks source label (e.g. 'llm_reason',
    'llm_debate', 'llm_newsanalyst'). provider = 'anthropic'/'gemini'/etc."""
    est = _est_llm_cost(model, tokens_in, tokens_out)
    await _record(
        source, provider, model,
        tokens_in=tokens_in, tokens_out=tokens_out,
        est_usd=est, meta=meta,
    )


async def record_modal_call(
    source: str,
    function_name: str,
    compute_sec: float,
    cpu: float = 1.0,
    memory_mb: int = 0,
    gpu: Optional[str] = None,
    meta: Optional[dict] = None,
) -> None:
    """Record one Modal function invocation."""
    est = estimate_modal_cost(
        compute_sec=compute_sec,
        cpu=cpu,
        memory_mb=memory_mb,
        gpu=gpu,
    )
    meta = dict(meta or {})
    meta.update({"cpu": cpu, "memory_mb": memory_mb, "gpu": gpu})
    profile = build_modal_compute_profile(
        source=source,
        function_name=function_name,
        compute_sec=compute_sec,
        est_usd=est,
        cpu=cpu,
        memory_mb=memory_mb,
        gpu=gpu,
        meta=meta,
    )
    await asyncio.gather(
        _record(
            source, "modal", function_name,
            compute_sec=compute_sec, est_usd=est, meta=meta,
        ),
        _record_compute_profile_event(profile),
        return_exceptions=True,
    )


def record_llm_call_sync(
    source: str,
    provider: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    meta: Optional[dict] = None,
) -> None:
    """Blocking version (requests-based) for code paths that can't await."""
    import requests
    if not _CF_D1_URL or not _CF_API_TOKEN:
        return
    est = _est_llm_cost(model, tokens_in, tokens_out)
    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    try:
        requests.post(
            _CF_D1_URL,
            json={
                "sql": (
                    "INSERT INTO cost_events "
                    "(ts, date, source, provider, model, tokens_in, tokens_out, compute_sec, est_usd, meta) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
                ),
                "params": [
                    now.isoformat(), tw_date, source, provider, model,
                    int(tokens_in), int(tokens_out), est,
                    _json.dumps(meta) if meta else None,
                ],
            },
            headers={
                "Authorization": f"Bearer {_CF_API_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=5.0,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[cost_tracker.sync] exception (non-fatal): {e}")
