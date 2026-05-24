"""
config_pool.py — #28b T3.5 Weekly challenger eval + shadow stability gate

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
  5. Apply shadow stability logic from services.config_pool_policy:
       - Challenger wins or loses are evaluated by active policy thresholds.
       - Consecutive wins emit promotion-ready signal only.
       - Consecutive losses or stale shadow age → retire challenger.
  6. Discord alert on promotion-ready / retire / warning.

Threshold / window are resolved by services.config_pool_policy from
trading:config configPool / alphaFramework.configPool with audited defaults.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

import anyio
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from services.alpha_evidence_runner import run_alpha_candidate_evidence, run_parameter_candidate_evidence
from services.alpha_policy_search import load_alpha_outcome_rows
from services.alpha_quality import evaluate_alpha_quality
from services.alpha_quality_policy import resolve_alpha_quality_inputs
from services.config_pool_policy import DEFAULT_CONFIG_POOL_POLICY, ConfigPoolPolicy
from services.market_structure_validation import load_market_structure_rows, validate_market_structure
from services.promotion_service import evaluate_alpha_policy_evidence_gate, evaluate_latest_alpha_policy_gate
from services.worker_config_client import WorkerConfigClientError, worker_fetch

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/config_pool", tags=["config_pool"])


async def fetch_worker_admin(*args, **kwargs) -> dict:
    try:
        return await worker_fetch(*args, **kwargs)
    except WorkerConfigClientError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


class WeeklyEvalRequest(BaseModel):
    """Weekly challenger evaluation request body."""
    lookback_days: int = Field(default=DEFAULT_CONFIG_POOL_POLICY.lookback_days, ge=7, le=180)
    apply: bool = Field(default=False, description="If true, apply promote/retire transitions + write lifecycle events. Default false = dry-run reporting only. Friday cron explicitly sends apply=true in body.")
    end_date: Optional[str] = None  # default: today TW


class AlphaChallengerRequest(BaseModel):
    sandbox_id: str = Field(..., description="Worker config sandbox id from source=alpha_framework")
    apply: bool = Field(default=False, description="false=dry-run gate only; true=set challenger after PASS")
    confirm: bool = Field(default=False, description="Required with apply=true")
    source: str = Field(default="backtest", pattern="^(backtest)$")
    pbo_source: Optional[str] = Field(default=None, pattern="^(backtest|optuna_l2)$")
    generate_evidence: bool = Field(
        default=False,
        description="Run candidate-specific replay, Monte Carlo, and PBO evidence before challenger gate.",
    )
    start_date: Optional[str] = Field(default=None, description="Backtest start date when generate_evidence=true.")
    end_date: Optional[str] = Field(default=None, description="Backtest end date when generate_evidence=true.")
    initial_capital: float = Field(default=1_000_000, gt=0)
    mc_simulations: int = Field(default=1000, ge=100, le=10000)
    parity_audit: Optional[dict] = Field(default=None)
    evidence: Optional[dict] = Field(
        default=None,
        description="Candidate-specific evidence bundle {candidate_id, backtest, monte_carlo, pbo}.",
    )
    note: Optional[str] = None


class ParameterCandidateValidationChainRequest(BaseModel):
    candidate_ids: list[str] = Field(default_factory=list)
    cadence: Optional[str] = None
    run_date: Optional[str] = None
    run_id: Optional[str] = None
    source: str = "manual"
    metadata: dict[str, Any] = Field(default_factory=dict)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    lookback_days: int = Field(default=180, ge=30, le=730)
    initial_capital: float = Field(default=1_000_000, gt=0)
    mc_simulations: int = Field(default=1000, ge=100, le=10000)
    limit: int = Field(default=20, ge=1, le=100)
    persist: bool = True


@router.get("/alpha_quality")
async def alpha_quality_report(
    limit: int | None = Query(default=None, ge=100, le=5000),
    min_samples: int | None = Query(default=None, ge=1, le=1000),
    min_bucket_samples: int | None = Query(default=None, ge=1, le=500),
) -> dict:
    """Read-only quality report for realized alpha bucket outcomes."""
    config = await fetch_worker_admin("/api/admin/config")
    resolved = resolve_alpha_quality_inputs(
        config,
        limit=limit,
        min_samples=min_samples,
        min_bucket_samples=min_bucket_samples,
    )
    resolved_limit = resolved["limit"]
    rows = load_alpha_outcome_rows(limit=resolved_limit)
    return {
        "source": "alpha_quality",
        "limit": resolved_limit,
        "policy_source": "trading:config.alphaFramework.quality",
        "query_overrides": resolved["query_overrides"],
        **evaluate_alpha_quality(
            rows,
            min_samples=resolved["min_samples"],
            min_bucket_samples=resolved["min_bucket_samples"],
            return_pct_per_r=resolved["return_pct_per_r"],
            direction_correct_fallback_r=resolved["direction_correct_fallback_r"],
        ),
    }


@router.get("/market_structure_validation")
async def market_structure_validation_report(
    limit: int = Query(default=1000, ge=100, le=5000),
    min_samples: int = Query(default=30, ge=1, le=1000),
):
    rows = load_market_structure_rows(limit=limit)
    return {
        "source": "market_structure_validation",
        "limit": limit,
        "method": {
            "value_band": "recent volume-weighted price +/- range envelope",
            "purpose": "validate market-structure overlay before using it as a gate",
            "not_intrinsic_value": True,
        },
        **validate_market_structure(rows, min_samples=min_samples),
    }


@router.post("/alpha_challenger")
async def alpha_challenger_gate(req: AlphaChallengerRequest = Body(default=...)):
    """Gate an alpha_framework sandbox before setting it as config challenger.

    This is intentionally not a production promotion endpoint. It only moves a
    verified sandbox candidate into the shadow/challenger slot.
    """
    sandbox = await fetch_worker_admin(f"/api/admin/config/sandbox/{req.sandbox_id}", method="GET")
    if sandbox.get("source") != "alpha_framework":
        return {
            "status": "rejected",
            "reason": "sandbox_source_not_alpha_framework",
            "sandbox_source": sandbox.get("source"),
        }
    candidate_id = _candidate_id_from_sandbox(str(sandbox.get("source") or "alpha_framework"), req.sandbox_id)
    sandbox["id"] = candidate_id
    sandbox["candidate_id"] = candidate_id

    evidence = req.evidence
    if req.generate_evidence:
        if not req.start_date or not req.end_date:
            raise HTTPException(status_code=400, detail="generate_evidence=true requires start_date and end_date")
        baseline_config = await fetch_worker_admin("/api/admin/config", method="GET")
        if not isinstance(baseline_config, dict):
            baseline_config = {}

        evidence = await anyio.to_thread.run_sync(
            lambda: run_alpha_candidate_evidence(
                sandbox,
                start_date=req.start_date or "",
                end_date=req.end_date or "",
                baseline_config=baseline_config,
                initial_capital=req.initial_capital,
                mc_simulations=req.mc_simulations,
                parity_audit=req.parity_audit,
                alpha_replay_applied=True,
            )
        )

    gate = (
        evidence.get("gate")
        if req.generate_evidence and isinstance(evidence, dict) and isinstance(evidence.get("gate"), dict)
        else evaluate_alpha_policy_evidence_gate(sandbox, evidence)
        if evidence
        else evaluate_latest_alpha_policy_gate(
            sandbox,
            source=req.source,
            pbo_source=req.pbo_source,
        )
    )
    if gate.get("decision") != "PASS":
        return {
            "status": "gate_failed",
            "sandbox_id": req.sandbox_id,
            "gate": gate,
            "evidence": evidence,
        }

    if not req.apply:
        return {
            "status": "dry_run",
            "sandbox_id": req.sandbox_id,
            "gate": gate,
            "evidence": evidence,
            "hint": "Set apply=true and confirm=true to move this alpha policy into challenger.",
        }

    if not req.confirm:
        raise HTTPException(status_code=400, detail="apply=true requires confirm=true")

    challenger = await fetch_worker_admin(
        "/api/admin/config/challenger",
        method="POST",
        json_body={
            "sandbox_id": req.sandbox_id,
            "candidate_id": candidate_id,
            "promotion_packet_id": (
                evidence.get("promotion_packet_id")
                if isinstance(evidence, dict) and evidence.get("promotion_packet_id")
                else None
            ),
            "note": req.note or "alpha_framework gate PASS",
            "gate": gate,
            "evidence_packet": (
                evidence
                if isinstance(evidence, dict)
                else {
                    "candidate_id": candidate_id,
                    "decision": gate.get("decision"),
                    "gate": gate,
                    "validation_packet": gate.get("validation_packet"),
                }
            ),
        },
    )
    return {
        "status": "applied",
        "sandbox_id": req.sandbox_id,
        "gate": gate,
        "evidence": evidence,
        "challenger": challenger,
    }


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


def _candidate_id_from_sandbox(source: str, sandbox_id: str) -> str:
    import re

    suffix = sandbox_id.replace("trading:config:sandbox:", "")
    safe_source = re.sub(r"[^A-Za-z0-9:._-]+", "_", str(source or "unknown").strip().lower())
    safe_suffix = re.sub(r"[^A-Za-z0-9:._-]+", "_", suffix)
    return f"parameter:{safe_source}:{safe_suffix}"


def _load_parameter_candidate_rows(candidate_ids: list[str], limit: int) -> list[dict[str, Any]]:
    from services.d1_client import query as d1_query

    try:
        if candidate_ids:
            placeholders = ",".join("?" for _ in candidate_ids)
            return d1_query(
                f"""
                SELECT candidate_id, source, config_hash, sandbox_id, cadence, run_id, status,
                       metadata_json, latest_evidence_json, promotion_packet_id, created_at, updated_at
                FROM parameter_candidate_registry
                WHERE candidate_id IN ({placeholders})
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                [*candidate_ids, limit],
            )
        return d1_query(
            """
            SELECT candidate_id, source, config_hash, sandbox_id, cadence, run_id, status,
                   metadata_json, latest_evidence_json, promotion_packet_id, created_at, updated_at
            FROM parameter_candidate_registry
            WHERE status IN ('SHADOW_COLLECTING', 'VALIDATION_BLOCKED', 'APPROVAL_REQUIRED')
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            [limit],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[parameter_candidates/validation_chain] registry query failed: %s", exc)
        return []


def _safe_json(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        import json as _json

        parsed = _json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


async def _persist_parameter_candidate_evidence(
    candidate_id: str,
    evidence: dict[str, Any],
    decision: str,
    *,
    source: str = "unknown",
) -> str | None:
    import json as _json

    promotion_packet_id = (
        f"promotion_packet:{candidate_id}:{int(datetime.now(timezone.utc).timestamp())}"
        if decision == "PASS"
        else None
    )
    status = "PROMOTION_READY" if decision == "PASS" else "VALIDATION_BLOCKED"
    persisted = {
        **evidence,
        "candidate_id": candidate_id,
        "decision": decision,
        "promotion_packet_id": promotion_packet_id,
    }
    await fetch_worker_admin(
        "/api/internal/d1/batch",
        method="POST",
        json_body={
            "statements": [
                {
                    "sql": (
                        "INSERT INTO parameter_candidate_registry "
                        "(candidate_id, source, status, latest_evidence_json, promotion_packet_id, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, datetime('now')) "
                        "ON CONFLICT(candidate_id) DO NOTHING"
                    ),
                    "params": [
                        candidate_id,
                        source or "unknown",
                        status,
                        _json.dumps(persisted, ensure_ascii=False),
                        promotion_packet_id,
                    ],
                },
                {
                    "sql": (
                        "INSERT INTO parameter_candidate_evidence "
                        "(candidate_id, evidence_type, decision, evidence_json, promotion_packet_id) "
                        "VALUES (?, ?, ?, ?, ?)"
                    ),
                    "params": [
                        candidate_id,
                        "candidate_specific_validation",
                        decision,
                        _json.dumps(persisted, ensure_ascii=False),
                        promotion_packet_id,
                    ],
                },
                {
                    "sql": (
                        "UPDATE parameter_candidate_registry "
                        "SET status = ?, latest_evidence_json = ?, promotion_packet_id = ?, updated_at = datetime('now') "
                        "WHERE candidate_id = ?"
                    ),
                    "params": [
                        status,
                        _json.dumps(persisted, ensure_ascii=False),
                        promotion_packet_id,
                        candidate_id,
                    ],
                },
                {
                    "sql": (
                        "INSERT INTO parameter_candidate_events "
                        "(candidate_id, event_type, detail_json) VALUES (?, ?, ?)"
                    ),
                    "params": [
                        candidate_id,
                        "candidate_specific_validation",
                        _json.dumps({
                            "decision": decision,
                            "status": status,
                            "promotion_packet_id": promotion_packet_id,
                        }, ensure_ascii=False),
                    ],
                },
            ],
        },
    )
    return promotion_packet_id


@router.post("/parameter_candidates/validation_chain")
async def parameter_candidates_validation_chain(
    req: ParameterCandidateValidationChainRequest = Body(default=ParameterCandidateValidationChainRequest()),
) -> dict:
    """Run candidate-specific validation for parameter/config challengers.

    The chain is candidate-specific: same snapshot baseline/challenger replay,
    Mode B backtest, regime-aware Monte Carlo, CSCV rank-logit PBO,
    paired partition walk-forward, and Hansen SPA data-snooping guard. Proxy
    PBO remains proxy_pbo_blocked and cannot create a promotion_packet_id.
    """
    end_date = req.end_date or req.run_date or _twdate()
    start_date = req.start_date or (datetime.fromisoformat(end_date) - timedelta(days=req.lookback_days)).strftime("%Y-%m-%d")
    await fetch_worker_admin("/api/admin/config/parameter-candidates?limit=1", method="GET")
    rows = _load_parameter_candidate_rows(req.candidate_ids, req.limit)
    if not rows:
        return {
            "status": "NO_CANDIDATE",
            "total": 0,
            "ready": 0,
            "blocked": 0,
            "shadow_stability_only": False,
            "message": "No parameter candidate rows found in D1 registry.",
        }

    baseline_config = await fetch_worker_admin("/api/admin/config", method="GET")
    baseline_config = baseline_config if isinstance(baseline_config, dict) else {}

    results: list[dict[str, Any]] = []
    for row in rows:
        candidate_id = str(row.get("candidate_id") or "")
        sandbox_id = row.get("sandbox_id")
        source = str(row.get("source") or "")
        if not sandbox_id:
            results.append({
                "candidate_id": candidate_id,
                "source": source,
                "status": "VALIDATION_BLOCKED",
                "reason": "sandbox_missing_or_non_config_shadow_state",
                "proxy_pbo_blocked": True,
            })
            continue

        try:
            sandbox = await fetch_worker_admin(f"/api/admin/config/sandbox/{sandbox_id}", method="GET")
        except HTTPException as exc:
            results.append({
                "candidate_id": candidate_id,
                "source": source,
                "status": "VALIDATION_BLOCKED",
                "reason": "sandbox_body_unavailable",
                "detail": exc.detail,
                "proxy_pbo_blocked": True,
            })
            continue

        candidate = {
            **sandbox,
            "id": candidate_id,
            "candidate_id": candidate_id,
            "sandbox_id": sandbox_id,
            "metadata": {
                **_safe_json(row.get("metadata_json")),
                "registry": {
                    "cadence": row.get("cadence"),
                    "run_id": row.get("run_id"),
                    "status": row.get("status"),
                    "source": source,
                },
            },
        }
        evidence = await anyio.to_thread.run_sync(
            lambda: run_parameter_candidate_evidence(
                candidate,
                start_date=start_date,
                end_date=end_date,
                baseline_config=baseline_config,
                initial_capital=req.initial_capital,
                mc_simulations=req.mc_simulations,
                parity_audit={"worker_parity": {"decision": "MISSING", "source": "validation_chain"}},
            )
        )
        gate = evidence.get("gate") if isinstance(evidence.get("gate"), dict) else {}
        validation_packet = gate.get("validation_packet") if isinstance(gate.get("validation_packet"), dict) else {}
        pbo_method = (((gate.get("inputs") or {}).get("pbo") or {}).get("method") if isinstance(gate.get("inputs"), dict) else None) \
            or (((evidence.get("pbo") or {}).get("method")) if isinstance(evidence.get("pbo"), dict) else None)
        proxy_pbo_blocked = str(pbo_method or "").lower() != "cscv_rank_logit"
        decision = "PASS" if gate.get("decision") == "PASS" and not proxy_pbo_blocked else "FAIL"
        if proxy_pbo_blocked:
            failed = list(gate.get("failed_gates") or [])
            if "proxy_pbo_blocked" not in failed:
                failed.append("proxy_pbo_blocked")
            gate["failed_gates"] = failed
            gate["decision"] = "FAIL"
            gate["passed"] = False
            evidence["gate"] = gate
            decision = "FAIL"

        promotion_packet_id = await _persist_parameter_candidate_evidence(candidate_id, evidence, decision, source=source) if req.persist else None
        results.append({
            "candidate_id": candidate_id,
            "source": source,
            "status": "PROMOTION_READY" if decision == "PASS" else "VALIDATION_BLOCKED",
            "decision": decision,
            "promotion_packet_id": promotion_packet_id,
            "failed_gates": gate.get("failed_gates") or [],
            "validation_packet_decision": validation_packet.get("decision"),
            "pbo_method": pbo_method,
            "proxy_pbo_blocked": proxy_pbo_blocked,
        })

    ready = sum(1 for item in results if item.get("status") == "PROMOTION_READY")
    blocked = sum(1 for item in results if item.get("status") == "VALIDATION_BLOCKED")
    return {
        "status": "completed",
        "mode": "candidate-specific",
        "start_date": start_date,
        "end_date": end_date,
        "cadence": req.cadence,
        "run_id": req.run_id,
        "source": req.source,
        "validation": {
            "backtest": "Mode B paired replay",
            "monte_carlo": "regime-aware block bootstrap",
            "pbo": "cscv_rank_logit",
            "walk_forward": "paired partition walk-forward",
            "data_snooping": "Hansen SPA / White Reality Check",
        },
        "total": len(results),
        "ready": ready,
        "blocked": blocked,
        "results": results,
    }


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


@router.post("/weekly_eval")
async def weekly_eval(
    req: WeeklyEvalRequest = Body(default=WeeklyEvalRequest()),
    apply_query: Optional[bool] = Query(
        default=None, alias="apply",
        description="URL query override for apply flag. "
                    "When present, overrides body apply (useful for CLI dry-run: "
                    "?apply=false). None = use body value (default).",
    ),
    lookback_query: Optional[int] = Query(
        default=None, alias="lookback_days", ge=7, le=180,
        description="URL query override for lookback_days (same semantic as apply query).",
    ),
):
    """
    Weekly champion vs challenger replay-based comparison. Called by worker
    Friday 19:30 TW cron chain after model promote_check.

    Query params override body for ad-hoc testing:
      ?apply=false          → force dry-run regardless of body
      ?lookback_days=30     → override lookback window
    """
    # Apply query overrides to request object (preserves body as secondary source).
    if apply_query is not None:
        req.apply = apply_query
    if lookback_query is not None:
        req.lookback_days = lookback_query

    from services.backtest_engine import BacktestDataset, replay_period

    # ── 1. Fetch both configs via worker ────────────────────────────────────
    # /api/admin/config returns bare config JSON (legacy endpoint). Hash
    # computed client-side below.
    champion_config = await fetch_worker_admin("/api/admin/config", method="GET")
    if not isinstance(champion_config, dict):
        logger.warning("[config_pool/weekly_eval] unexpected champion config type, defaulting empty")
        champion_config = {}
    policy = ConfigPoolPolicy.from_config(champion_config)
    champion_hash = _client_hash(champion_config)

    challenger_resp = await fetch_worker_admin("/api/admin/config/challenger?full=1")
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
    dataset, data_access = BacktestDataset.load_for_research(
        lane="config_pool.weekly_eval",
        start_date=start_date,
        end_date=end_date,
    )

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
    prev_state_resp = await fetch_worker_admin("/api/admin/config/challenger/state")
    prev_state = (prev_state_resp.get("state") or {}) if prev_state_resp.get("success") else {}
    consecutive_wins = int(prev_state.get("consecutive_wins", 0))
    consecutive_losses = int(prev_state.get("consecutive_losses", 0))

    # Reset counters if challenger hash changed (new challenger starts fresh)
    if prev_state.get("challenger_hash") and prev_state.get("challenger_hash") != challenger_hash:
        consecutive_wins = 0
        consecutive_losses = 0

    this_is_win = policy.is_win(sharpe_delta, challenger_perf["win_rate"])
    this_is_loss = policy.is_loss(sharpe_delta, challenger_perf["win_rate"])
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
    action, action_reason = policy.decide_action(
        consecutive_wins=consecutive_wins,
        consecutive_losses=consecutive_losses,
        shadow_age_days=shadow_age_days,
    )

    eval_result = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": req.lookback_days,
        "start_date": start_date,
        "end_date": end_date,
        "data_access": data_access,
        "champion_hash": champion_hash,
        "challenger_hash": challenger_hash,
        "shadow_since": shadow_since,
        "shadow_age_days": shadow_age_days,
        "policy": policy.to_dict(),
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
        "shadow_stability_only": True,
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
    await fetch_worker_admin("/api/admin/config/challenger/eval_commit", method="POST", json_body={
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

    # Execute shadow action if any. weekly_eval is shadow_stability_only:
    # a win can start final promotion controller review, but never writes prod.
    if action == "promote":
        eval_result["shadow_stability_only"] = True
        eval_result["promotion_signal"] = {
            "status": "PROMOTION_READY_SIGNAL",
            "reason": action_reason,
            "next_action": "run final promotion controller with candidate-specific evidence packet",
        }
    elif action == "retire":
        retire_resp = await fetch_worker_admin(
            f"/api/admin/config/challenger?reason={action_reason.replace(' ', '+')}",
            method="DELETE",
        )
        eval_result["retire_result"] = retire_resp

    return {"status": "applied", **eval_result}
