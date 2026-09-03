"""Daily, non-mutating prospective evidence for one frozen GA challenger."""

from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from typing import Any, Callable

from services.alpha_evidence_runner import run_parameter_candidate_evidence
from services.backtest_engine import BacktestDataset
from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.weekly_evidence_service import _resolve_snapshot


LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
EVALUATOR_VERSION = "ga-prospective-shadow-v1/mode-a-relative"


def _json_load(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    parsed = json.loads(str(value))
    if not isinstance(parsed, dict):
        raise RuntimeError("ga_shadow_json_object_required")
    return parsed


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _checksum_json(value: Any) -> str:
    return _checksum_text(_stable_json(value))


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _next_calendar_date(value: str) -> str:
    return (date.fromisoformat(value) + timedelta(days=1)).isoformat()


def _load_active_candidate() -> dict[str, Any] | None:
    rows = LEARNING_D1_CLIENT.query(
        """
        SELECT shadow_id, candidate_registry_id, ga_candidate_id, status,
               candidate_config_json, candidate_config_checksum,
               baseline_config_json, baseline_config_checksum,
               evaluator_version, enrolled_business_date,
               enrollment_snapshot_id, enrollment_snapshot_checksum,
               source_run_id, source_cadence, last_evidence_business_date
          FROM ga_optimizer_shadow_candidates_v1
         WHERE status='ACTIVE'
         ORDER BY created_at ASC
         LIMIT 1
        """
    )
    return rows[0] if rows else None


def _record_run(
    *,
    run_id: str,
    business_date: str,
    shadow_id: str | None,
    status: str,
    summary: str,
    error: str | None = None,
    evidence_id: str | None = None,
) -> None:
    LEARNING_D1_CLIENT.execute(
        """
        INSERT INTO ga_optimizer_shadow_runs_v1 (
          run_id, shadow_id, business_date, status, summary, error,
          evidence_id, production_effect, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0,
          CASE WHEN ?='RUNNING' THEN NULL ELSE datetime('now') END,
          datetime('now'))
        ON CONFLICT(run_id) DO UPDATE SET
          shadow_id=excluded.shadow_id,
          business_date=excluded.business_date,
          status=excluded.status,
          summary=excluded.summary,
          error=excluded.error,
          evidence_id=excluded.evidence_id,
          production_effect=0,
          completed_at=excluded.completed_at,
          updated_at=datetime('now')
        """,
        [
            run_id,
            shadow_id,
            business_date,
            status,
            summary[:1200],
            error[:1200] if error else None,
            evidence_id,
            status,
        ],
    )


def _compact_side(side: dict[str, Any]) -> dict[str, Any]:
    trade_returns = [_as_float(value) for value in (side.get("trade_return_series") or [])]
    partition_returns = [_as_float(value) for value in (side.get("partition_returns") or [])]
    return {
        key: side.get(key)
        for key in (
            "total_return",
            "total_trades",
            "sharpe",
            "max_drawdown",
            "profit_factor",
            "win_rate",
            "fill_rate",
        )
    } | {
        "trade_return_count": len(trade_returns),
        "trade_return_checksum": _checksum_json(trade_returns),
        "partition_count": len(partition_returns),
        "partition_checksum": _checksum_json(partition_returns),
    }


def _compact_evidence(
    evidence: dict[str, Any],
    *,
    candidate: dict[str, Any],
    run_date: str,
    replay_start: str,
    replay_end: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    comparison = evidence.get("comparison") if isinstance(evidence.get("comparison"), dict) else {}
    champion = comparison.get("champion") if isinstance(comparison.get("champion"), dict) else {}
    challenger = comparison.get("candidate") if isinstance(comparison.get("candidate"), dict) else {}
    return {
        "schema_version": "ga-prospective-shadow-evidence-v1",
        "shadow_id": candidate["shadow_id"],
        "ga_candidate_id": candidate["ga_candidate_id"],
        "candidate_registry_id": candidate["candidate_registry_id"],
        "candidate_config_checksum": candidate["candidate_config_checksum"],
        "baseline_config_checksum": candidate["baseline_config_checksum"],
        "evaluator_version": EVALUATOR_VERSION,
        "run_date": run_date,
        "replay_start_date": replay_start,
        "replay_end_date": replay_end,
        "snapshot": {
            "snapshot_id": snapshot.get("snapshot_id"),
            "snapshot_checksum": snapshot.get("checksum"),
            "snapshot_business_date": snapshot.get("business_date"),
            "snapshot_created_at": snapshot.get("created_at"),
            "snapshot_producer_run_id": snapshot.get("producer_run_id"),
        },
        "comparison": {
            "schema_version": comparison.get("schema_version"),
            "champion": _compact_side(champion),
            "candidate": _compact_side(challenger),
            "delta": comparison.get("delta") or {},
            "same_dataset": comparison.get("same_dataset") is True,
            "costs_included": comparison.get("costs_included") is True,
        },
        "walk_forward": evidence.get("walk_forward") or {},
        "pbo": evidence.get("pbo") or {},
        "monte_carlo": evidence.get("monte_carlo") or {},
        "gate": evidence.get("gate") or {},
        "provenance": {
            **(evidence.get("provenance") or {}),
            "look_ahead_check": "PASS",
            "prediction_source": "mode_a_relative_no_mutable_ml_cache",
            "production_parity": "NOT_CLAIMED",
        },
        "execution_parity": {
            "decision": "MISSING",
            "reason": "frozen replay cannot manufacture paper/live execution parity",
        },
        "production_effect": False,
    }


def _persist_evidence(
    *,
    candidate: dict[str, Any],
    business_date: str,
    run_date: str,
    run_id: str,
    snapshot: dict[str, Any],
    replay_start: str,
    replay_end: str,
    compact: dict[str, Any],
) -> dict[str, Any]:
    existing = LEARNING_D1_CLIENT.query(
        """
        SELECT evidence_id, evidence_checksum, snapshot_checksum
          FROM ga_optimizer_shadow_daily_evidence_v1
         WHERE shadow_id=? AND business_date=?
        """,
        [candidate["shadow_id"], business_date],
    )
    evidence_json = _stable_json(compact)
    evidence_checksum = _checksum_text(evidence_json)
    if existing:
        row = existing[0]
        if str(row.get("evidence_checksum") or "") != evidence_checksum:
            raise RuntimeError(
                "ga_shadow_immutable_evidence_conflict:"
                f"shadow_id={candidate['shadow_id']}:business_date={business_date}"
            )
        _record_run(
            run_id=run_id,
            business_date=run_date,
            shadow_id=candidate["shadow_id"],
            status="SUCCESS",
            summary=f"idempotent evidence readback {row.get('evidence_id')}",
            evidence_id=str(row.get("evidence_id") or ""),
        )
        return {
            "status": "IDEMPOTENT",
            "evidence_id": row.get("evidence_id"),
            "evidence_checksum": evidence_checksum,
        }

    previous_snapshot = LEARNING_D1_CLIENT.query(
        """
        SELECT business_date, snapshot_checksum
          FROM ga_optimizer_shadow_daily_evidence_v1
         WHERE shadow_id=? AND snapshot_business_date=?
         LIMIT 1
        """,
        [candidate["shadow_id"], business_date],
    )
    if previous_snapshot:
        raise RuntimeError(
            "ga_shadow_snapshot_business_date_conflict:"
            f"shadow_id={candidate['shadow_id']}:snapshot_business_date={business_date}"
        )

    comparison = compact["comparison"]
    challenger = comparison["candidate"]
    champion = comparison["champion"]
    delta = comparison["delta"]
    walk_forward = compact["walk_forward"]
    gate = compact["gate"]
    evidence_id = f"ga-shadow-evidence-v1:{candidate['shadow_id']}:{business_date}"
    statements = [
        (
            """
            INSERT INTO ga_optimizer_shadow_daily_evidence_v1 (
              evidence_id, shadow_id, business_date,
              snapshot_id, snapshot_checksum, snapshot_business_date,
              replay_start_date, replay_end_date,
              candidate_total_return, baseline_total_return, paired_return_delta,
              candidate_total_trades, baseline_total_trades,
              candidate_sharpe, baseline_sharpe,
              candidate_max_drawdown, baseline_max_drawdown,
              walk_forward_pass, gate_decision, execution_parity_decision,
              evidence_json, evidence_checksum, run_id, production_effect
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            [
                evidence_id,
                candidate["shadow_id"],
                business_date,
                snapshot.get("snapshot_id"),
                snapshot.get("checksum"),
                business_date,
                replay_start,
                replay_end,
                _as_float(challenger.get("total_return")),
                _as_float(champion.get("total_return")),
                _as_float(delta.get("total_return")),
                _as_int(challenger.get("total_trades")),
                _as_int(champion.get("total_trades")),
                challenger.get("sharpe"),
                champion.get("sharpe"),
                _as_float(challenger.get("max_drawdown")),
                _as_float(champion.get("max_drawdown")),
                1 if walk_forward.get("passed") is True else 0,
                str(gate.get("decision") or "MISSING").upper(),
                "MISSING",
                evidence_json,
                evidence_checksum,
                run_id,
            ],
        ),
        (
            """
            UPDATE ga_optimizer_shadow_candidates_v1
               SET last_evidence_business_date=?, updated_at=datetime('now')
             WHERE shadow_id=? AND status='ACTIVE'
            """,
            [business_date, candidate["shadow_id"]],
        ),
        (
            """
            INSERT INTO ga_optimizer_shadow_runs_v1 (
              run_id, shadow_id, business_date, status, summary,
              evidence_id, production_effect, completed_at, updated_at
            ) VALUES (?, ?, ?, 'SUCCESS', ?, ?, 0, datetime('now'), datetime('now'))
            ON CONFLICT(run_id) DO UPDATE SET
              shadow_id=excluded.shadow_id,
              business_date=excluded.business_date,
              status='SUCCESS',
              summary=excluded.summary,
              error=NULL,
              evidence_id=excluded.evidence_id,
              production_effect=0,
              completed_at=datetime('now'),
              updated_at=datetime('now')
            """,
            [run_id, candidate["shadow_id"], run_date, f"evidence={evidence_id}", evidence_id],
        ),
    ]
    LEARNING_D1_CLIENT.atomic_batch_execute(statements)
    readback = LEARNING_D1_CLIENT.query(
        "SELECT evidence_checksum FROM ga_optimizer_shadow_daily_evidence_v1 WHERE evidence_id=?",
        [evidence_id],
    )
    if not readback or readback[0].get("evidence_checksum") != evidence_checksum:
        raise RuntimeError("ga_shadow_evidence_readback_failed")
    return {
        "status": "PERSISTED",
        "evidence_id": evidence_id,
        "evidence_checksum": evidence_checksum,
    }


def run_ga_production_shadow(
    *,
    run_date: str,
    run_id: str,
    evidence_runner: Callable[..., dict[str, Any]] = run_parameter_candidate_evidence,
    snapshot_resolver: Callable[[str], tuple[dict[str, Any], str, str]] = _resolve_snapshot,
) -> dict[str, Any]:
    active = _load_active_candidate()
    if not active:
        _record_run(
            run_id=run_id,
            business_date=run_date,
            shadow_id=None,
            status="SKIPPED",
            summary="no active frozen GA challenger",
        )
        return {"status": "NO_ACTIVE", "run_date": run_date, "production_effect": False}

    shadow_id = str(active["shadow_id"])
    _record_run(
        run_id=run_id,
        business_date=run_date,
        shadow_id=shadow_id,
        status="RUNNING",
        summary="resolving immutable prospective snapshot",
    )
    try:
        candidate_config = _json_load(active.get("candidate_config_json"))
        baseline_config = _json_load(active.get("baseline_config_json"))
        if _checksum_json(candidate_config) != active.get("candidate_config_checksum"):
            raise RuntimeError("ga_shadow_candidate_config_checksum_mismatch")
        if _checksum_json(baseline_config) != active.get("baseline_config_checksum"):
            raise RuntimeError("ga_shadow_baseline_config_checksum_mismatch")
        if str(active.get("evaluator_version")) != EVALUATOR_VERSION:
            raise RuntimeError("ga_shadow_evaluator_version_mismatch")

        snapshot, snapshot_start, snapshot_end = snapshot_resolver(run_date)
        enrolled = str(active.get("enrolled_business_date") or "")[:10]
        replay_start = max(snapshot_start, _next_calendar_date(enrolled))
        replay_end = snapshot_end
        snapshot_business_date = str(snapshot.get("business_date") or snapshot_end)[:10]
        if replay_end < replay_start or snapshot_business_date <= enrolled:
            summary = (
                f"prospective snapshot not advanced enrolled={enrolled} "
                f"snapshot_business_date={snapshot_business_date}"
            )
            _record_run(
                run_id=run_id,
                business_date=run_date,
                shadow_id=shadow_id,
                status="SKIPPED",
                summary=summary,
            )
            return {
                "status": "NOT_READY",
                "reason": summary,
                "shadow_id": shadow_id,
                "run_date": run_date,
                "production_effect": False,
            }

        def _load_exact_snapshot(*, start_date: str, end_date: str, symbols=None):
            dataset = BacktestDataset.load_from_snapshot_manifest(
                manifest=snapshot,
                start_date=start_date,
                end_date=end_date,
                symbols=symbols,
            )
            return dataset, {
                "source": "snapshot",
                "snapshot_id": snapshot.get("snapshot_id"),
                "snapshot_checksum": snapshot.get("checksum"),
                "snapshot_business_date": snapshot_business_date,
                "look_ahead_check": "PASS",
                "prediction_source": "mode_a_relative_no_mutable_ml_cache",
            }

        evidence = evidence_runner(
            {
                "id": active["ga_candidate_id"],
                "config": candidate_config,
                "metadata": {"shadow_id": shadow_id},
            },
            start_date=replay_start,
            end_date=replay_end,
            baseline_config=baseline_config,
            mode="A",
            parity_audit={
                "worker_parity": {
                    "decision": "MISSING",
                    "reason": "prospective replay cannot manufacture execution parity",
                }
            },
            dataset_loader=_load_exact_snapshot,
        )
        comparison = evidence.get("comparison") if isinstance(evidence.get("comparison"), dict) else {}
        if comparison.get("same_dataset") is not True or comparison.get("costs_included") is not True:
            raise RuntimeError("ga_shadow_paired_comparison_contract_missing")
        compact = _compact_evidence(
            evidence,
            candidate=active,
            run_date=run_date,
            replay_start=replay_start,
            replay_end=replay_end,
            snapshot=snapshot,
        )
        persisted = _persist_evidence(
            candidate=active,
            business_date=snapshot_business_date,
            run_date=run_date,
            run_id=run_id,
            snapshot=snapshot,
            replay_start=replay_start,
            replay_end=replay_end,
            compact=compact,
        )
        count_rows = LEARNING_D1_CLIENT.query(
            "SELECT COUNT(*) AS n FROM ga_optimizer_shadow_daily_evidence_v1 WHERE shadow_id=?",
            [shadow_id],
        )
        evidence_dates = _as_int(count_rows[0].get("n") if count_rows else 0)
        return {
            "status": "COMPLETED",
            "persistence": persisted,
            "shadow_id": shadow_id,
            "ga_candidate_id": active["ga_candidate_id"],
            "run_date": run_date,
            "evidence_business_date": snapshot_business_date,
            "evidence_dates": evidence_dates,
            "paired_return_delta": compact["comparison"]["delta"].get("total_return"),
            "production_effect": False,
        }
    except Exception as exc:
        _record_run(
            run_id=run_id,
            business_date=run_date,
            shadow_id=shadow_id,
            status="ERROR",
            summary=f"{type(exc).__name__}: {exc}",
            error=f"{type(exc).__name__}: {exc}",
        )
        raise
