"""
config_pool.py — #28b T3.5 Weekly challenger eval + auto-promote gate

Mirrors Plan A model_pool weekly IC tracker pattern, adapted for
trading:config parameter set.

Weekly Friday 19:30 TW cron (worker side) calls /config_pool/weekly_eval
which:
  1. Fetch champion config (KV trading:config) + challenger (KV
     trading:config:challenger, may be null).
  2. If no challenger → skip (return {status: 'no_challenger'}).
  3. Run replay_period on last N days (Mode A, default lookback=30d calendar)
     with each config as params. Compare sharpe / win_rate / max_dd.
  4. Update Worker D1 config_lifecycle_state via REST (worker admin endpoint)
     + append event to config_lifecycle_events.
  5. Apply promote / retire logic based on rolling win count:
       - Challenger wins (sharpe_delta > 0.2 AND win_rate >= 0.55): +1
       - Challenger loses (sharpe_delta < 0 OR win_rate < 0.45): +1 loss
       - 2+ consecutive wins → promote (calls setTradingConfig via worker
         /api/admin/optuna-push?prod=1 + X-Confirm-Prod: true — internal
         system trigger, differs from human refactor path).
       - 2+ consecutive losses OR shadow > 30 days → retire challenger.
  6. Discord alert on promote / retire / warning.

Threshold / window are KV-tunable via trading:config.optuna_l2 or a future
config_pool config section. Initial hardcoded constants mirror Plan A.
"""
from __future__ import annotations
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/config_pool", tags=["config_pool"])

# ── Gate thresholds (mirror Plan A model lifecycle) ─────────────────────────
SHARPE_DELTA_WIN_THRESHOLD = 0.2       # challenger beats champion by ≥0.2 sharpe
WIN_RATE_FLOOR = 0.55                  # challenger must have ≥55% wins
WIN_RATE_RETIRE_CEIL = 0.45            # challenger <45% counts as a loss
CONSECUTIVE_WINS_TO_PROMOTE = 2        # 2 weeks of winning → promote
CONSECUTIVE_LOSSES_TO_RETIRE = 2       # 2 weeks of losing → retire
MAX_SHADOW_DAYS = 30                   # retire if shadow > 30 days
DEFAULT_LOOKBACK_DAYS = 90             # replay window for comparison (90d quarter — longer than 30d to smooth sharpe noise when challenger was searched over 365d)

WORKER_URL_ENV = "STOCKVISION_WORKER_URL"  # match kv_pusher.py convention
WORKER_AUTH_TOKEN_ENV = "STOCKVISION_AUTH_TOKEN"


class WeeklyEvalRequest(BaseModel):
    """Weekly challenger evaluation request body."""
    lookback_days: int = Field(default=DEFAULT_LOOKBACK_DAYS, ge=7, le=180)
    apply: bool = Field(default=False, description="If true, apply promote/retire transitions + write lifecycle events. Default false = dry-run reporting only. Friday cron explicitly sends apply=true in body.")
    end_date: Optional[str] = None  # default: today TW


def _worker_url() -> str:
    url = os.environ.get(WORKER_URL_ENV)
    if not url:
        # Fallback — stockvision worker canonical
        url = "https://stockvision-worker.angus-solo-dev.workers.dev"
    return url.rstrip("/")


async def _worker_fetch(path: str, method: str = "GET", json_body: Optional[dict] = None,
                        headers: Optional[dict] = None) -> dict:
    """Helper for worker REST calls from controller side."""
    import httpx
    base_headers = {
        "Authorization": f"Bearer {os.environ.get(WORKER_AUTH_TOKEN_ENV, '')}",
        "Content-Type": "application/json",
    }
    if headers:
        base_headers.update(headers)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.request(method, _worker_url() + path,
                                  headers=base_headers,
                                  json=json_body)
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"Worker {method} {path}: {r.text[:200]}")
    return r.json()


def _canonical_json(v: Any) -> str:
    """Recursive canonical JSON (RFC 8785 style) — sorts keys at every level.
    Mirrors worker lib/tradingConfig.ts canonicalJson for hash parity."""
    import json as _json
    if v is None or not isinstance(v, (dict, list)):
        return _json.dumps(v)
    if isinstance(v, list):
        return '[' + ','.join(_canonical_json(x) for x in v) + ']'
    keys = sorted(v.keys())
    return '{' + ','.join(f'{_json.dumps(k)}:{_canonical_json(v[k])}' for k in keys) + '}'


def _client_hash(cfg: dict) -> str:
    """Client-side 8-hex-char SHA-256 prefix (mirrors worker hashConfig)."""
    import hashlib
    h = hashlib.sha256(_canonical_json(cfg).encode("utf-8")).digest()
    return h[:4].hex()


def _twdate(dt: Optional[datetime] = None) -> str:
    tw = timezone(timedelta(hours=8))
    return (dt or datetime.now(tw)).strftime("%Y-%m-%d")


def _perf_summary(metrics: Any) -> dict:
    """Extract comparable subset from BacktestMetrics dataclass (or dict)."""
    g = lambda k, d=None: getattr(metrics, k, d) if not isinstance(metrics, dict) else metrics.get(k, d)
    return {
        "sharpe":        float(g("sharpe") or 0.0),
        "win_rate":      float(g("win_rate") or 0.0),
        "max_drawdown":  float(g("max_drawdown") or 0.0),
        "total_trades":  int(g("total_trades") or 0),
        "total_return":  float(g("total_return") or 0.0),
        "profit_factor": float(g("profit_factor") or 0.0),
    }


def _is_win(sharpe_delta: float, challenger_win_rate: float) -> bool:
    return sharpe_delta >= SHARPE_DELTA_WIN_THRESHOLD and challenger_win_rate >= WIN_RATE_FLOOR


def _is_loss(sharpe_delta: float, challenger_win_rate: float) -> bool:
    return sharpe_delta < 0 or challenger_win_rate < WIN_RATE_RETIRE_CEIL


@router.post("/weekly_eval")
async def weekly_eval(req: WeeklyEvalRequest = Body(default=WeeklyEvalRequest())):
    """
    Weekly champion vs challenger replay-based comparison. Called by worker
    Friday 19:30 TW cron chain after model promote_check.
    """
    from services.backtest_engine import replay_period_loading, BacktestDataset, replay_period

    # ── 1. Fetch both configs via worker ────────────────────────────────────
    # /api/admin/config returns bare config JSON (legacy endpoint). Hash
    # computed client-side below.
    champion_config = await _worker_fetch("/api/admin/config", method="GET")
    if not isinstance(champion_config, dict):
        logger.warning("[config_pool/weekly_eval] unexpected champion config type, defaulting empty")
        champion_config = {}
    champion_hash = _client_hash(champion_config)

    challenger_resp = await _worker_fetch("/api/admin/config/challenger?full=1")
    if not challenger_resp.get("challenger"):
        return {
            "status": "no_challenger",
            "message": "No active challenger. Skipped eval.",
        }

    challenger_state = challenger_resp["challenger"]
    challenger_config = challenger_state["config"]
    challenger_hash = challenger_state["hash"]
    shadow_since = challenger_state["shadow_since"]

    # ── 2. Resolve date range ──────────────────────────────────────────────
    end_date = req.end_date or _twdate()
    start_date = (datetime.fromisoformat(end_date) - timedelta(days=req.lookback_days)).strftime("%Y-%m-%d")

    logger.info(
        f"[config_pool/weekly_eval] range={start_date}~{end_date} "
        f"champion_hash={champion_hash} challenger_hash={challenger_hash} apply={req.apply}"
    )

    # ── 3. Run paired replays (load dataset once, both configs) ────────────
    dataset = BacktestDataset.load_from_d1(start_date=start_date, end_date=end_date)

    champion_metrics = replay_period(
        dataset=dataset, start_date=start_date, end_date=end_date,
        params=champion_config, mode="A", initial_capital=1_000_000,
    )
    challenger_metrics = replay_period(
        dataset=dataset, start_date=start_date, end_date=end_date,
        params=challenger_config, mode="A", initial_capital=1_000_000,
    )

    champion_perf = _perf_summary(champion_metrics)
    challenger_perf = _perf_summary(challenger_metrics)
    sharpe_delta = challenger_perf["sharpe"] - champion_perf["sharpe"]
    win_rate_delta = challenger_perf["win_rate"] - champion_perf["win_rate"]
    max_dd_delta = challenger_perf["max_drawdown"] - champion_perf["max_drawdown"]

    # ── 4. Fetch previous state to compute consecutive counters ────────────
    prev_state_resp = await _worker_fetch("/api/admin/config/challenger/state")
    prev_state = (prev_state_resp.get("state") or {}) if prev_state_resp.get("success") else {}
    consecutive_wins = int(prev_state.get("consecutive_wins", 0))
    consecutive_losses = int(prev_state.get("consecutive_losses", 0))

    # Reset counters if challenger hash changed (new challenger starts fresh)
    if prev_state.get("challenger_hash") and prev_state.get("challenger_hash") != challenger_hash:
        consecutive_wins = 0
        consecutive_losses = 0

    this_is_win = _is_win(sharpe_delta, challenger_perf["win_rate"])
    this_is_loss = _is_loss(sharpe_delta, challenger_perf["win_rate"])
    if this_is_win:
        consecutive_wins += 1
        consecutive_losses = 0
    elif this_is_loss:
        consecutive_losses += 1
        consecutive_wins = 0
    else:
        # Neutral — reset both (tie result doesn't progress toward either outcome)
        consecutive_wins = 0
        consecutive_losses = 0

    # Shadow age
    shadow_age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(shadow_since.replace("Z", "+00:00"))).days

    # ── 5. Decide action ────────────────────────────────────────────────────
    action = "hold"  # default — keep shadow-observing
    action_reason = ""

    if consecutive_wins >= CONSECUTIVE_WINS_TO_PROMOTE:
        action = "promote"
        action_reason = f"{consecutive_wins} consecutive wins (sharpe_delta≥{SHARPE_DELTA_WIN_THRESHOLD})"
    elif consecutive_losses >= CONSECUTIVE_LOSSES_TO_RETIRE:
        action = "retire"
        action_reason = f"{consecutive_losses} consecutive losses"
    elif shadow_age_days > MAX_SHADOW_DAYS:
        action = "retire"
        action_reason = f"shadow age {shadow_age_days}d > max {MAX_SHADOW_DAYS}d without conclusive result"

    eval_result = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": req.lookback_days,
        "start_date": start_date,
        "end_date": end_date,
        "champion_hash": champion_hash,
        "challenger_hash": challenger_hash,
        "shadow_since": shadow_since,
        "shadow_age_days": shadow_age_days,
        "champion_perf": champion_perf,
        "challenger_perf": challenger_perf,
        "sharpe_delta": round(sharpe_delta, 4),
        "win_rate_delta": round(win_rate_delta, 4),
        "max_dd_delta": round(max_dd_delta, 4),
        "this_is_win": this_is_win,
        "this_is_loss": this_is_loss,
        "consecutive_wins": consecutive_wins,
        "consecutive_losses": consecutive_losses,
        "action": action,
        "action_reason": action_reason,
        "apply": req.apply,
    }

    # ── 6. If apply=true, write state + events + execute action ────────────
    if not req.apply:
        return {"status": "dry_run", **eval_result}

    new_state = {
        "champion_hash": champion_hash,
        "challenger_hash": challenger_hash,
        "champion_perf": champion_perf,
        "challenger_perf": challenger_perf,
        "consecutive_wins": consecutive_wins,
        "consecutive_losses": consecutive_losses,
        "shadow_since": shadow_since,
        "shadow_age_days": shadow_age_days,
        "last_action": action,
    }

    # Write state + event via worker admin (single call bundles both)
    await _worker_fetch("/api/admin/config/challenger/eval_commit", method="POST", json_body={
        "state": new_state,
        "event": {
            "event_type": "eval_done",
            "challenger_hash": challenger_hash,
            "champion_hash": champion_hash,
            "sharpe_delta": sharpe_delta,
            "win_rate_delta": win_rate_delta,
            "max_dd_delta": max_dd_delta,
            "detail": eval_result,
        },
    })

    # Execute action if any
    if action == "promote":
        promote_resp = await _worker_fetch("/api/admin/config/challenger/promote_to_prod",
                                           method="POST",
                                           headers={"X-Confirm-Prod": "true"},
                                           json_body={"reason": action_reason})
        eval_result["promote_result"] = promote_resp
    elif action == "retire":
        retire_resp = await _worker_fetch(
            f"/api/admin/config/challenger?reason={action_reason.replace(' ', '+')}",
            method="DELETE",
        )
        eval_result["retire_result"] = retire_resp

    return {"status": "applied", **eval_result}
