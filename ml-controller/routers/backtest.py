"""
backtest.py — Weekly backtest + Monte Carlo + PBO + Sprint 6 replay endpoints

POST /backtest/run         → FIFO backtest pipeline (backtest_service, fixed config)
POST /backtest/monte-carlo → Monte Carlo MDD simulation
POST /backtest/pbo         → Probability of Backtest Overfitting (CPCV)
POST /backtest/replay      → Sprint 6 parameterized Mode A replay (Optuna objective)
"""
import json
import hashlib
import logging
import os
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional

from services.monte_carlo_service import run_monte_carlo_mdd
from services.pbo_service import run_pbo_analysis, persist_pbo_attempt_receipt
from services.weekly_evidence_service import (
    run_canonical_weekly_backtest,
    run_historical_weekly_comparison,
    taiwan_today,
)
from services.alpha_evidence_runner import run_alpha_candidate_evidence
from services.promotion_service import (
    evaluate_alpha_policy_evidence_gate,
    evaluate_latest_alpha_policy_gate,
    evaluate_latest_promotion_gate,
)
from services.backtest_result_store import persist_replay_backtest
from services.promotion_policy import PromotionPolicy
from services.validation_governance import (
    backtest_metrics_to_dict,
    build_strategy_lab_record,
    build_strategy_replay_contract,
    build_validation_packet,
    explain_backtest_metrics,
)
from services.backtest_engine import (
    replay_period_loading,
    diagnose_replay_for_date,
    BacktestDataset,
    ScreenerParams,
    RankingParams,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/backtest", tags=["backtest"])
BACKTEST_RESEARCH_JOB_NAME = (
    os.environ.get("BACKTEST_RESEARCH_JOB_NAME")
    or os.environ.get("OPTUNA_JOB_NAME")
    or "weekly-backtest-research"
).strip()


class WeeklyBacktestResearchBundleRequest(BaseModel):
    run_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    run_id: str = Field(
        min_length=48,
        max_length=96,
        pattern=r"^weekly-backtest-\d{4}-\d{2}-\d{2}-\d{10,16}-[a-f0-9]{8,32}$",
    )
    monte_carlo_n: int = Field(default=1000, ge=100, le=10000)
    pbo_partitions: int = Field(default=10, ge=4, le=20)
    pbo_source: str = Field(default="backtest", pattern="^(paper|backtest)$")
    callback_task: str = Field(default="weekly-backtest", pattern="^weekly-backtest$")
    trigger_source: str = Field(default="worker_weekly_backtest")
    dry_run: bool = Field(default=False)


@router.post("/research-bundle/run")
async def trigger_weekly_backtest_research_bundle(
    req: WeeklyBacktestResearchBundleRequest = Body(...),
):
    """Hand the long-running weekly evidence bundle to a Cloud Run Job."""
    run_date = req.run_date or taiwan_today()
    if not req.run_id.startswith(f"weekly-backtest-{run_date}-"):
        raise HTTPException(
            status_code=422,
            detail={
                "error": "weekly_backtest_run_id_date_mismatch",
                "run_date": run_date,
            },
        )
    if req.dry_run:
        return {
            "status": "not_triggered",
            "reason": "dry_run",
            "task": req.callback_task,
            "run_date": run_date,
            "run_id": req.run_id,
        }

    run_id = req.run_id
    env_overrides = {
        "OPTUNA_JOB_MODE": "weekly_backtest",
        "OPTUNA_RUN_DATE": run_date,
        "OPTUNA_RUN_ID": run_id,
        "OPTUNA_CALLBACK_TASK": req.callback_task,
        "OPTUNA_TRIGGER_SOURCE": req.trigger_source,
        "WEEKLY_BACKTEST_MONTE_CARLO_N": str(req.monte_carlo_n),
        "WEEKLY_BACKTEST_PBO_PARTITIONS": str(req.pbo_partitions),
        "WEEKLY_BACKTEST_PBO_SOURCE": req.pbo_source,
    }
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError
    try:
        execution = CloudRunJobsClient(job_name=BACKTEST_RESEARCH_JOB_NAME).run_job(
            env_overrides=env_overrides,
            reject_if_running=True,
        )
    except JobAlreadyRunningError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "weekly_backtest_research_execution_already_running",
                "execution_id": exc.execution.execution_id,
            },
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("[BacktestResearchBundle] Job dispatch failed")
        raise HTTPException(
            status_code=502,
            detail=f"Cloud Run weekly backtest Job dispatch failed: {type(exc).__name__}: {exc}",
        ) from exc

    return {
        "status": "triggered",
        "triggered": True,
        "task": req.callback_task,
        "run_date": run_date,
        "run_id": run_id,
        "execution_id": execution.execution_id,
        "execution_name": execution.execution_name,
        "backend": "cloud_run_job",
        "message": "weekly backtest research bundle triggered; callback expected",
    }


class WeeklyBacktestEvidenceReconciliationRequest(BaseModel):
    run_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    pbo_partitions: int = Field(default=10, ge=4, le=20)


@router.post("/research-bundle/reconcile")
async def reconcile_weekly_backtest_research_bundle(
    req: WeeklyBacktestEvidenceReconciliationRequest = Body(...),
):
    """Keep source evidence read-only; append only a production-effect-free reconciliation receipt."""
    from services.backtest_trade_evidence import canonical_weekly_evidence_error
    from services.d1_domain_client import D1DataDomain
    from services.monte_carlo_service import _d1_query, httpx

    if httpx is None:
        return {"status": "error", "error": "httpx not installed"}

    async with httpx.AsyncClient() as client:
        backtest_rows = await _d1_query(
            client,
            """SELECT id, total_trades, raw_results, created_at
                 FROM backtest_results
                WHERE run_date = ? AND strategy = 'replay_mode_b'
                ORDER BY created_at DESC LIMIT 1""",
            [req.run_date],
            domain=D1DataDomain.RESEARCH,
        )
        mc_rows = await _d1_query(
            client,
            """SELECT id, source, n_trades, go_live_verdict, raw_distribution, created_at
                 FROM monte_carlo_results
                WHERE run_date = ? AND source IN ('paper', 'backtest')
                ORDER BY created_at DESC""",
            [req.run_date],
            domain=D1DataDomain.RESEARCH,
        )
        pbo_rows = await _d1_query(
            client,
            """SELECT id, source, n_trades, pbo, go_live_verdict, raw_details, created_at
                 FROM pbo_results
                WHERE run_date = ? AND source = 'backtest'
                ORDER BY created_at DESC LIMIT 1""",
            [req.run_date],
            domain=D1DataDomain.RESEARCH,
        )

    if not backtest_rows:
        return {
            "status": "error",
            "error": "immutable_backtest_evidence_missing",
            "run_date": req.run_date,
        }
    raw_text = str(backtest_rows[0].get("raw_results") or "")
    try:
        raw = json.loads(raw_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {
            "status": "error",
            "error": "immutable_backtest_evidence_invalid_json",
            "run_date": req.run_date,
        }
    if not isinstance(raw, dict):
        return {
            "status": "error",
            "error": "immutable_backtest_evidence_invalid_shape",
            "run_date": req.run_date,
        }
    clock_error = canonical_weekly_evidence_error(raw, req.run_date)
    if clock_error:
        return {"status": "error", "error": clock_error, "run_date": req.run_date}

    mc_by_source: dict[str, dict] = {}
    for row in mc_rows:
        source = str(row.get("source") or "")
        if source and source not in mc_by_source:
            mc_by_source[source] = row
    missing_mc = sorted({"paper", "backtest"} - set(mc_by_source))
    if missing_mc:
        return {
            "status": "error",
            "error": f"immutable_monte_carlo_evidence_missing:{','.join(missing_mc)}",
            "run_date": req.run_date,
        }

    validation_blockers: list[str] = []
    for source in ("paper", "backtest"):
        row = mc_by_source[source]
        verdict = str(row.get("go_live_verdict") or "UNKNOWN").upper()
        try:
            distribution = json.loads(str(row.get("raw_distribution") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return {
                "status": "error",
                "error": f"immutable_monte_carlo_evidence_invalid_json:{source}",
                "run_date": req.run_date,
            }
        if not isinstance(distribution, dict):
            return {
                "status": "error",
                "error": f"immutable_monte_carlo_evidence_invalid_shape:{source}",
                "run_date": req.run_date,
            }
        if source == "backtest":
            provenance = distribution.get("source_provenance")
            expected_backtest_id = str(backtest_rows[0].get("id") or "")
            if (
                not isinstance(provenance, dict)
                or str(provenance.get("source_row_id") or "") != expected_backtest_id
                or str(provenance.get("source_run_date") or "")[:10] != req.run_date
            ):
                return {
                    "status": "error",
                    "error": "immutable_monte_carlo_backtest_lineage_mismatch",
                    "run_date": req.run_date,
                }
        tail_risk = str(distribution.get("tail_risk_status") or "UNKNOWN").upper()
        if verdict != "PASS":
            validation_blockers.append(f"monte_carlo:{source}:verdict={verdict}")
        if tail_risk != "FULL_SAMPLE_TAIL_RISK":
            validation_blockers.append(f"monte_carlo:{source}:tail_risk={tail_risk}")

    total_trades = int(backtest_rows[0].get("total_trades") or 0)
    has_partition_returns = bool(
        raw.get("strategy_returns_by_partition")
        or raw.get("candidate_partition_returns")
    )
    required_trades = req.pbo_partitions * 3
    pbo_evidence = pbo_rows[0] if pbo_rows else None
    pbo_attempt_id: str | None = None
    if pbo_evidence:
        try:
            pbo_details = json.loads(str(pbo_evidence.get("raw_details") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return {
                "status": "error",
                "error": "immutable_pbo_evidence_invalid_json",
                "run_date": req.run_date,
            }
        pbo_provenance = pbo_details.get("source_provenance") if isinstance(pbo_details, dict) else None
        expected_backtest_id = str(backtest_rows[0].get("id") or "")
        if (
            not isinstance(pbo_provenance, dict)
            or str(pbo_provenance.get("source_row_id") or "") != expected_backtest_id
            or str(pbo_provenance.get("source_run_date") or "")[:10] != req.run_date
        ):
            return {
                "status": "error",
                "error": "immutable_pbo_backtest_lineage_mismatch",
                "run_date": req.run_date,
            }
        pbo_verdict = str(pbo_evidence.get("go_live_verdict") or "UNKNOWN").upper()
        if pbo_verdict != "PASS":
            validation_blockers.append(f"pbo:verdict={pbo_verdict}")
    elif not has_partition_returns and total_trades < required_trades:
        validation_blockers.append(
            f"pbo:insufficient_evidence:observed={total_trades}:required={required_trades}"
        )
        async with httpx.AsyncClient() as receipt_client:
            pbo_attempt_id = await persist_pbo_attempt_receipt(
                receipt_client,
                run_date=req.run_date,
                source="backtest",
                status="insufficient_evidence",
                n_partitions=req.pbo_partitions,
                observed_trades=total_trades,
                required_trades=required_trades,
                source_provenance={
                    "source_table": "backtest_results",
                    "source_row_id": backtest_rows[0].get("id"),
                    "source_run_date": req.run_date,
                    "source_created_at": backtest_rows[0].get("created_at"),
                    "source_payload_sha256": hashlib.sha256(raw_text.encode("utf-8")).hexdigest(),
                    "receipt_origin": "read_only_source_reconciliation",
                },
                pbo_result_id=None,
            )
        if not pbo_attempt_id:
            return {
                "status": "error",
                "error": "pbo_attempt_receipt_write_failed",
                "run_date": req.run_date,
                "production_effect": False,
            }
    else:
        return {
            "status": "error",
            "error": "immutable_pbo_evidence_missing",
            "run_date": req.run_date,
            "observed_trades": total_trades,
            "required_trades": required_trades,
        }

    validation_status = "blocked" if validation_blockers else "passed"
    return {
        "status": "completed",
        "run_date": req.run_date,
        "execution_status": "success",
        "validation_status": validation_status,
        "promotion_gate_eligible": not validation_blockers,
        "production_effect": False,
        "evidence_read_only": True,
        "source_evidence_read_only": True,
        "attempt_receipt_append_only": bool(pbo_attempt_id),
        "reconciled": True,
        "blockers": validation_blockers,
        "observed_trades": total_trades,
        "required_trades": required_trades,
        "evidence_ids": {
            "backtest": backtest_rows[0].get("id"),
            "monte_carlo": {source: mc_by_source[source].get("id") for source in ("paper", "backtest")},
            "pbo": pbo_evidence.get("id") if pbo_evidence else None,
            "pbo_attempt": pbo_attempt_id,
        },
        "attempt_receipt_materialized": bool(pbo_attempt_id),
        "summary": (
            f"weekly_backtest_reconciled validation={validation_status} "
            f"run_date={req.run_date} trades={total_trades} "
            f"blockers={','.join(validation_blockers) if validation_blockers else 'none'} "
            "evidence_read_only=true"
        )[:1200],
    }


@router.post("/run")
async def trigger_backtest(
    run_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    """
    Run full backtest pipeline:
    1. Fetch OHLCV + ML signals from D1
    2. FIFO in-memory backtest per stock (7-layer cascade)
    3. Aggregate metrics (Sharpe, MDD, Win Rate, Profit Factor, Expectancy)
    4. Write results to D1 backtest_results table
    """
    logger.info("[Backtest] Triggered via API")
    try:
        return run_canonical_weekly_backtest(run_date=run_date)
    except Exception as e:
        logger.exception("[Backtest] Pipeline failed")
        return {"status": "error", "error": str(e)}


@router.post("/monte-carlo")
async def trigger_monte_carlo(
    n: int = Query(default=1000, ge=100, le=10000, description="Number of simulations"),
    source: str = Query(default="paper", pattern="^(paper|backtest)$",
                        description="Data source: paper (real trades) or backtest"),
    method: str = Query(default="block_bootstrap", pattern="^(block_bootstrap|regime_block_bootstrap|iid_shuffle)$",
                        description="Simulation method; regime/block bootstrap preserves clustered loss streaks"),
    block_size: int | None = Query(default=None, ge=1, le=60,
                                   description="Optional moving-block size for block bootstrap"),
    expected_run_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    persist: bool = Query(default=True),
    evidence_scope: str = Query(default="canonical_current", pattern="^(canonical_current|comparison_only)$"),
):
    """
    P0#5 Monte Carlo MDD Simulation:
    1. Fetch completed trades (paper_orders FIFO paired, or backtest results)
    2. Simulate trade paths N times (block bootstrap by default; iid_shuffle kept for legacy comparison)
    3. Compute MDD for each permutation
    4. Report 95th/99th percentile worst-case MDD
    5. Go-live verdict: PASS (<20%) / CAUTION (20-30%) / FAIL (>30%)
    """
    logger.info(f"[MonteCarlo] Triggered: source={source}, n={n}, method={method}, block_size={block_size}")
    try:
        return await run_monte_carlo_mdd(
            n_simulations=n,
            source=source,
            method=method,
            block_size=block_size,
            expected_run_date=expected_run_date,
            persist=persist,
            evidence_scope=evidence_scope,
        )
    except Exception as e:
        logger.exception("[MonteCarlo] Pipeline failed")
        return {"status": "error", "error": str(e)}


class ReplayRequest(BaseModel):
    """Sprint 6a POST /backtest/replay request body."""
    start_date: str = Field(..., description="Inclusive start 'YYYY-MM-DD'")
    end_date: str = Field(..., description="Inclusive end 'YYYY-MM-DD'")
    params: dict = Field(
        default_factory=dict,
        description="trading:config shape dict (screener/ranking/position/sltp/exit/fees). "
                    "Missing sections use defaults.",
    )
    initial_capital: float = Field(default=1_000_000)
    mode: str = Field(default="A", pattern="^(A|B)$")
    symbols: Optional[list[str]] = Field(
        default=None,
        description="Subset filter for smoke tests. None = full universe (~2346 stocks).",
    )
    verbose: bool = Field(default=False)
    persist_results: bool = Field(
        default=False,
        description="Persist replay result into D1 backtest_results for promotion gates.",
    )
    persist_confirm: bool = Field(
        default=False,
        description="Required with persist_results=true to avoid accidental promotion-gate writes.",
    )
    parity_audit: Optional[dict] = Field(
        default=None,
        description="Worker/API parity audit to persist with promotion-grade replay rows. "
                    "Promotion gates fail closed unless worker_parity.decision == PASS.",
    )
    hypothesis: Optional[str] = Field(
        default=None,
        description="Strategy Lab hypothesis being tested; used for read-only experiment records.",
    )
    dataset_snapshot: Optional[dict] = Field(
        default=None,
        description="Dataset/version snapshot for reproducible Strategy Lab records.",
    )
    model_versions: Optional[dict] = Field(
        default=None,
        description="Model/artifact versions used by this replay.",
    )
    follow_up: Optional[list[str]] = Field(
        default=None,
        description="Human review notes or next experiment steps.",
    )
    walk_forward_evidence: Optional[dict] = Field(
        default=None,
        description="Walk-forward evidence attached to the validation packet and persisted raw result.",
    )
    regime_label: Optional[str] = Field(
        default=None,
        description="#28b T2.4: apply params.sltp_per_regime[canonical_label] overlay "
                    "for the whole replay window. Accepts 'bull' / 'bull_market' / "
                    "'bear' / 'bear_market' / 'volatile' / 'sideways' (case-insensitive). "
                    "None = flat sltp (backward-compat).",
    )


class HistoricalWeeklyReplayRequest(BaseModel):
    """Immutable point-in-time comparison. This route never persists or promotes."""

    as_of_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    params: dict = Field(..., description="Frozen strategy config effective at as_of_date.")
    config_version: str = Field(..., min_length=1, description="Version/id of the frozen config payload.")
    config_checksum: str = Field(..., pattern=r"^[0-9a-fA-F]{64}$")
    config_effective_at: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    initial_capital: float = Field(default=1_000_000, gt=0)
    symbols: Optional[list[str]] = Field(default=None)
    mc_simulations: int = Field(default=1000, ge=100, le=10000)
    pbo_partitions: int = Field(default=10, ge=4, le=20)


@router.post("/historical-weekly-replay")
def post_historical_weekly_replay(req: HistoricalWeeklyReplayRequest = Body(...)):
    """Run frozen-snapshot Mode B + MC + PBO as comparison-only evidence."""
    try:
        return run_historical_weekly_comparison(
            as_of_date=req.as_of_date,
            params=req.params,
            config_version=req.config_version,
            config_checksum=req.config_checksum,
            config_effective_at=req.config_effective_at,
            initial_capital=req.initial_capital,
            symbols=req.symbols,
            mc_simulations=req.mc_simulations,
            pbo_partitions=req.pbo_partitions,
        )
    except Exception as exc:
        logger.exception("[HistoricalWeeklyReplay] Evaluation failed")
        return {
            "status": "error",
            "error": str(exc),
            "evidence_scope": "comparison_only",
            "production_effect": False,
            "persisted": False,
        }

class AlphaPromotionGateRequest(BaseModel):
    candidate: dict = Field(
        default_factory=dict,
        description="Alpha policy candidate metadata from /optuna/alpha_framework or Worker sandbox metadata.",
    )
    source: str = Field(default="backtest", pattern="^(backtest)$")
    pbo_source: Optional[str] = Field(default=None, pattern="^(backtest|optuna_l2)$")
    evidence: Optional[dict] = Field(
        default=None,
        description="Candidate-specific evidence bundle {candidate_id, backtest, monte_carlo, pbo}. "
                    "When provided, gate does not read latest global artifacts.",
    )


class AlphaEvidenceRequest(BaseModel):
    candidate: dict = Field(
        default_factory=dict,
        description="Alpha framework sandbox/challenger candidate.",
    )
    start_date: str = Field(..., description="Inclusive start 'YYYY-MM-DD'")
    end_date: str = Field(..., description="Inclusive end 'YYYY-MM-DD'")
    baseline_config: dict = Field(
        default_factory=dict,
        description="Current champion trading:config. Candidate config is deep-merged over this.",
    )
    initial_capital: float = Field(default=1_000_000)
    mode: str = Field(default="B", pattern="^(B)$")
    symbols: Optional[list[str]] = Field(default=None)
    mc_simulations: int = Field(default=1000, ge=100, le=10000)
    parity_audit: Optional[dict] = Field(
        default=None,
        description="Worker/API parity audit. Gate fails closed if worker_parity.decision is not PASS.",
    )


@router.post("/alpha-evidence")
def post_alpha_evidence(req: AlphaEvidenceRequest = Body(...)):
    """Generate candidate-specific alpha evidence. Read-only: no D1/KV/promote writes."""
    logger.info("[AlphaEvidence] Running candidate-specific replay/MC/PBO")
    try:
        from services.trading_config_loader import load_merged_trading_config_with_contract
        baseline_config = req.baseline_config
        if not baseline_config:
            cfg_result = load_merged_trading_config_with_contract()
            baseline_config = cfg_result.config
            if cfg_result.contract.degraded:
                logger.warning("[AlphaEvidence] trading:config degraded: %s", cfg_result.contract.to_dict())
        return {
            "status": "ok",
            **run_alpha_candidate_evidence(
                req.candidate,
                start_date=req.start_date,
                end_date=req.end_date,
                baseline_config=baseline_config,
                initial_capital=req.initial_capital,
                mode=req.mode,
                symbols=req.symbols,
                mc_simulations=req.mc_simulations,
                parity_audit=req.parity_audit,
                alpha_replay_applied=True,
            ),
        }
    except Exception as e:
        logger.exception("[AlphaEvidence] Evaluation failed")
        return {"status": "error", "error": str(e)}


@router.post("/replay")
async def trigger_replay(req: ReplayRequest = Body(...)):
    """
    Sprint 6a Mode A parameterized backtest replay.

    ⚠️ Mode A Sharpe is unreliable as absolute production prediction.
    Check response.realism_warnings + sanity_flags before acting.
    See memory/project_backtest_engine_design_rationale.md section 3.

    Typical smoke test body:
      {
        "start_date": "2024-01-01",
        "end_date": "2024-03-31",
        "params": {},
        "symbols": ["2330", "2317", "2454", "2308", "2303"],
        "verbose": true
      }

    Full-universe Optuna objective usage (do not call via HTTP per trial —
    preload dataset once and call replay_period directly to avoid D1 re-fetch):
      {
        "start_date": "2023-01-01",
        "end_date": "2024-12-31",
        "params": {...optuna trial params...}
      }
    """
    logger.info(
        f"[Replay] {req.start_date}~{req.end_date} mode={req.mode} "
        f"symbols={len(req.symbols) if req.symbols else 'full'}"
    )
    try:
        if req.persist_results and req.end_date < taiwan_today():
            return {
                "status": "error",
                "error": "historical_replay_persistence_forbidden",
                "required_path": "/backtest/historical-weekly-replay",
                "production_effect": False,
            }
        if req.end_date < taiwan_today() and not req.params:
            return {
                "status": "error",
                "error": "historical_replay_requires_frozen_config",
                "required_path": "/backtest/historical-weekly-replay",
                "production_effect": False,
            }
        from services.trading_config_loader import load_merged_trading_config_with_contract
        params = req.params
        config_contract = None
        if not params:
            cfg_result = load_merged_trading_config_with_contract()
            params = cfg_result.config
            config_contract = cfg_result.contract.to_dict()
            if cfg_result.contract.degraded:
                logger.warning("[Replay] trading:config degraded: %s", config_contract)
        metrics = replay_period_loading(
            start_date=req.start_date,
            end_date=req.end_date,
            params=params,
            initial_capital=req.initial_capital,
            mode=req.mode,
            symbols=req.symbols,
            verbose=req.verbose,
            regime_label=req.regime_label,
        )

        backtest_evidence = backtest_metrics_to_dict(metrics, parity_audit=req.parity_audit)
        validation_packet = build_validation_packet(
            source="backtest_replay",
            backtest=backtest_evidence,
            walk_forward=req.walk_forward_evidence,
            policy=PromotionPolicy.from_env(),
            external_risk_required=False,
        )
        metric_explanations = explain_backtest_metrics(backtest_evidence)
        strategy_replay_contract = build_strategy_replay_contract(
            mode=metrics.mode,
            start_date=req.start_date,
            end_date=req.end_date,
            persisted=bool(req.persist_results),
            symbols_count=len(req.symbols) if req.symbols else None,
            regime_label=req.regime_label,
        )
        strategy_lab_record = build_strategy_lab_record(
            hypothesis=req.hypothesis,
            data_slice={
                "start_date": req.start_date,
                "end_date": req.end_date,
                "mode": metrics.mode,
                "symbols": req.symbols,
                "symbols_count": len(req.symbols) if req.symbols else None,
                "regime_label": req.regime_label,
            },
            dataset_snapshot=req.dataset_snapshot,
            model_versions=req.model_versions,
            metrics=backtest_evidence,
            validation_packet=validation_packet,
            strategy_replay_contract=strategy_replay_contract,
            follow_up=req.follow_up,
            tags=["backtest_replay", f"mode_{metrics.mode.lower()}"],
        )

        persist_result = None
        if req.persist_results:
            if not req.persist_confirm:
                return {
                    "status": "error",
                    "error": "persist_results=true requires persist_confirm=true",
                }
            persist_result = persist_replay_backtest(
                metrics,
                run_date=req.end_date,
                parity_audit=req.parity_audit,
                validation_packet=validation_packet,
                metric_explanations=metric_explanations,
                strategy_lab_record=strategy_lab_record,
                walk_forward=req.walk_forward_evidence,
            )

        # Serialize BacktestMetrics to JSON-safe dict
        return {
            "status": "ok",
            "mode": metrics.mode,
            "persist_result": persist_result,
            "strategy_replay_contract": strategy_replay_contract,
            "trading_config_contract": config_contract,
            "strategy_lab_record": strategy_lab_record,
            "validation_packet": validation_packet,
            "metric_explanations": metric_explanations,
            "timerange": f"{metrics.start_date}~{metrics.end_date}",
            "initial_capital": metrics.initial_capital,
            "final_equity": round(metrics.final_equity, 2),
            "total_return": round(metrics.total_return, 4),
            "cagr": round(metrics.cagr, 4) if metrics.cagr is not None else None,
            "sharpe": round(metrics.sharpe, 3) if metrics.sharpe is not None else None,
            "sortino": round(metrics.sortino, 3) if metrics.sortino is not None else None,
            "calmar": round(metrics.calmar, 3) if metrics.calmar is not None else None,
            "max_drawdown": round(metrics.max_drawdown, 4),
            "max_dd_date": metrics.max_dd_date,
            "total_trades": metrics.total_trades,
            "wins": metrics.wins,
            "losses": metrics.losses,
            "win_rate": round(metrics.win_rate, 4),
            "profit_factor": round(metrics.profit_factor, 3),
            "expectancy": round(metrics.expectancy, 5),
            "avg_holding_days": round(metrics.avg_holding_days, 1),
            "entry_attempts": metrics.entry_attempts,
            "entries_filled": metrics.entries_filled,
            "fill_rate": round(metrics.fill_rate, 3),
            "skip_reasons": metrics.skip_reasons,
            "exit_distribution": metrics.exit_distribution,
            "per_regime": metrics.per_regime,
            "realism_warnings": metrics.realism_warnings,
            "absolute_confidence": metrics.absolute_confidence,
            "sanity_flags": metrics.sanity_flags,
            "partition_returns": metrics.partition_returns,
            # Truncate heavy fields for HTTP response (full lists are in memory still)
            "trades_sample": [
                {
                    "symbol": t.symbol,
                    "entry": t.entry_date, "exit": t.exit_date,
                    "entry_px": round(t.entry_price, 2), "exit_px": round(t.exit_price, 2),
                    "shares": t.shares, "pnl": round(t.profit_ratio, 4),
                    "entry_regime": t.entry_regime,
                    "reason": t.exit_reason, "days": t.days_held,
                }
                for t in metrics.trades[:50]
            ],
            "equity_curve_sample": metrics.equity_curve[:: max(1, len(metrics.equity_curve) // 50)][:51],
        }
    except Exception as e:
        logger.exception("[Replay] Failed")
        return {"status": "error", "error": str(e)}


class DiagnoseRequest(BaseModel):
    """B1 regression diagnostic: funnel counters per stage of
    replay_screener_for_date. Loads BacktestDataset for a short window
    ending at `date`, then runs the instrumented clone.

    Typical smoke body:
      {"date": "2024-03-08", "lookback_calendar_days": 35,
       "params": {}, "symbols": null}
    """
    date: str = Field(..., description="Decision date 'YYYY-MM-DD' (end of window)")
    lookback_calendar_days: int = Field(
        default=35, ge=7, le=120,
        description="Calendar days of history to load before `date` (must be "
                    ">= 22 trading days for screener lookback window)"
    )
    params: dict = Field(
        default_factory=dict,
        description="trading:config shape for screener/ranking. Missing keys use defaults."
    )
    symbols: Optional[list[str]] = Field(
        default=None,
        description="Subset filter. None = full universe."
    )
    max_dropped_samples: int = Field(default=10, ge=0, le=50)


@router.post("/diagnose")
async def trigger_diagnose(req: DiagnoseRequest = Body(...)):
    """
    B1 regression diagnostic endpoint (2026-04-20).

    Funnel-counter view of `replay_screener_for_date` for a single date.
    Returns:
      - dataset_sanity: _price_np cache key type + lookup test on 2330
        (reveals Polars 1.0 tuple-key bug vs str-key)
      - funnel: count at each of the 6 pipeline stages
      - dropped_samples: up to N symbol names per drop bucket
      - passed_samples: first N symbols that made it to `scored`

    Expensive: loads BacktestDataset through the research data contract.
    """
    from datetime import date as _date, timedelta as _td
    try:
        end_d = _date.fromisoformat(req.date)
    except ValueError:
        return {"status": "error", "error": f"Invalid date '{req.date}'"}
    start_d = end_d - _td(days=req.lookback_calendar_days)
    start_s = start_d.isoformat()

    logger.info(
        f"[Diagnose] date={req.date} window={start_s}~{req.date} "
        f"symbols={len(req.symbols) if req.symbols else 'full'}"
    )

    try:
        from services.trading_config_loader import load_merged_trading_config_with_contract
        params = req.params
        if not params:
            cfg_result = load_merged_trading_config_with_contract()
            params = cfg_result.config
            if cfg_result.contract.degraded:
                logger.warning("[Diagnose] trading:config degraded: %s", cfg_result.contract.to_dict())
        dataset, data_access = BacktestDataset.load_for_research(
            lane="backtest.diagnose",
            start_date=start_s,
            end_date=req.date,
            symbols=req.symbols,
        )
        screener = ScreenerParams.from_trading_config(params)
        ranking = RankingParams.from_trading_config(params)
        result = diagnose_replay_for_date(
            dataset=dataset,
            date=req.date,
            screener=screener,
            ranking=ranking,
            lookback_days=22,
            max_dropped_samples=req.max_dropped_samples,
        )
        return {"status": "ok", "data_access": data_access, **result}
    except Exception as e:
        logger.exception("[Diagnose] Failed")
        return {"status": "error", "error": str(e)}


@router.post("/pbo")
async def trigger_pbo(
    partitions: int = Query(default=10, ge=4, le=20, description="Number of time partitions"),
    source: str = Query(default="backtest", pattern="^(paper|backtest)$",
                        description="Data source: backtest or paper"),
    expected_run_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    persist: bool = Query(default=True),
    evidence_scope: str = Query(default="canonical_current", pattern="^(canonical_current|comparison_only)$"),
):
    """
    P0#6 Probability of Backtest Overfitting (CPCV):
    1. Split trades into S time partitions
    2. C(S, S/2) train/test combinations
    3. PBO = fraction where OOS return < 0
    4. Go-live verdict: PASS (PBO < 0.5) / FAIL (PBO >= 0.5)
    """
    logger.info(f"[PBO] Triggered: source={source}, partitions={partitions}")
    try:
        return await run_pbo_analysis(
            n_partitions=partitions,
            source=source,
            expected_run_date=expected_run_date,
            persist=persist,
            evidence_scope=evidence_scope,
        )
    except Exception as e:
        logger.exception("[PBO] Pipeline failed")
        return {"status": "error", "error": str(e)}


@router.get("/promotion-gate")
async def get_promotion_gate(
    source: str = Query(default="backtest", pattern="^(paper|backtest)$",
                        description="Risk source for Monte Carlo rows"),
    pbo_source: str | None = Query(default=None, pattern="^(paper|backtest|optuna_l2)$",
                                   description="PBO row source; defaults to source"),
):
    """
    Read-only production promotion gate.

    Joins latest Mode B backtest, Monte Carlo, and PBO rows, then returns a
    fail-closed PASS/FAIL decision. This endpoint never promotes by itself.
    """
    logger.info(f"[PromotionGate] Evaluating latest gate: source={source}")
    try:
        return {"status": "ok", **evaluate_latest_promotion_gate(source=source, pbo_source=pbo_source)}
    except Exception as e:
        logger.exception("[PromotionGate] Evaluation failed")
        return {"status": "error", "error": str(e)}


@router.post("/alpha-promotion-gate")
async def post_alpha_promotion_gate(req: AlphaPromotionGateRequest = Body(...)):
    """
    Read-only alpha policy promotion gate.

    Candidate must include alpha outcome provenance (sample_count/regime_counts)
    and still pass the same Mode B + Monte Carlo + PBO gates as other
    production-bound changes. This endpoint never promotes by itself.
    """
    logger.info("[AlphaPromotionGate] Evaluating alpha framework candidate")
    try:
        return {
            "status": "ok",
            **(
                evaluate_alpha_policy_evidence_gate(req.candidate, req.evidence)
                if req.evidence
                else evaluate_latest_alpha_policy_gate(
                    req.candidate,
                    source=req.source,
                    pbo_source=req.pbo_source,
                )
            ),
        }
    except Exception as e:
        logger.exception("[AlphaPromotionGate] Evaluation failed")
        return {"status": "error", "error": str(e)}
