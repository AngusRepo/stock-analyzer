"""Read-only promotion gate orchestration.

This service joins the latest Mode B backtest, Monte Carlo, and PBO outputs
into one fail-closed decision. It does not retrain, deploy, or promote models.
"""

from __future__ import annotations

import json
from typing import Any

from services.promotion_policy import (
    PromotionPolicy,
    _as_float,
    _as_int,
    evaluate_alpha_policy_candidate,
    evaluate_promotion_candidate,
)
from services.validation_governance import build_validation_packet


def query(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> list[dict[str, Any]]:
    from services.d1_client import query as d1_query

    return d1_query(sql, params=params, timeout=timeout)


def _safe_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        data = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _first(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    return rows[0] if rows else None


def _attach_validation_packet(result: dict[str, Any], validation_packet: dict[str, Any]) -> dict[str, Any]:
    result["validation_packet"] = validation_packet
    if str(validation_packet.get("decision") or "").upper() == "PASS":
        return result

    packet_failed = [
        f"validation_packet:{name}"
        for name in (validation_packet.get("failed_gates") or ["unavailable"])
    ]
    failed = list(result.get("failed_gates") or [])
    for name in packet_failed:
        if name not in failed:
            failed.append(name)
    result.update({
        "decision": "FAIL",
        "passed": False,
        "failed_gates": failed,
    })
    return result


def _base_risk_source(source: str) -> str:
    text = str(source or "").strip()
    if text.endswith("_curated"):
        return text[: -len("_curated")]
    return text


def normalize_latest_backtest_row(row: dict[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    raw = _safe_json(row.get("raw_results"))
    summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
    raw_mode = raw.get("mode")

    return {
        "run_date": row.get("run_date"),
        "strategy": row.get("strategy"),
        "mode": raw_mode or "legacy",
        "provenance": {
            "raw_results_present": bool(raw),
            "raw_mode_present": bool(raw_mode),
            "row_mode_ignored": row.get("mode") if row.get("mode") and not raw_mode else None,
        },
        "total_trades": _as_int(summary.get("total_trades") or row.get("total_trades"), 0),
        "sharpe": _as_float(row.get("sharpe") or summary.get("sharpe"), 0.0),
        "sortino": _as_float(row.get("sortino") or summary.get("sortino"), 0.0),
        "profit_factor": _as_float(row.get("profit_factor") or summary.get("profit_factor"), 0.0),
        "max_drawdown": _as_float(row.get("max_drawdown") or summary.get("max_drawdown"), 1.0),
        "absolute_confidence": raw.get("absolute_confidence") or "low",
        "sanity_flags": raw.get("sanity_flags") or [],
        "per_regime": raw.get("per_regime") if isinstance(raw.get("per_regime"), dict) else {},
        "parity_audit": raw.get("parity_audit") if isinstance(raw.get("parity_audit"), dict) else {},
        "walk_forward": raw.get("walk_forward") if isinstance(raw.get("walk_forward"), dict) else {},
    }


def normalize_latest_monte_carlo_row(row: dict[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    raw = _safe_json(row.get("raw_distribution"))
    curated = raw.get("curated_exclusion") if isinstance(raw.get("curated_exclusion"), dict) else None
    diagnostics = raw.get("tail_risk_diagnostics") if isinstance(raw.get("tail_risk_diagnostics"), dict) else {}
    return {
        "source": row.get("source"),
        "base_source": raw.get("base_source") or _base_risk_source(str(row.get("source") or "")),
        "n_trades": _as_int(row.get("n_trades"), 0),
        "simulation_method": raw.get("simulation_method") or row.get("simulation_method") or "unknown",
        "block_size": raw.get("block_size") or row.get("block_size"),
        "regime_counts": raw.get("regime_counts") if isinstance(raw.get("regime_counts"), dict) else {},
        "tail_risk_diagnostics": diagnostics,
        "curated_exclusion": curated,
        "mdd_95th": _as_float(row.get("mdd_95th"), 1.0),
        "go_live_verdict": row.get("go_live_verdict") or "",
    }


def normalize_latest_pbo_row(row: dict[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    raw = _safe_json(row.get("raw_details"))
    return {
        "source": row.get("source"),
        "n_trades": _as_int(row.get("n_trades"), 0),
        "method": raw.get("method") or row.get("method") or "unknown",
        "pbo": _as_float(row.get("pbo"), 1.0),
        "oos_mean_return": _as_float(row.get("oos_mean_return"), -1.0),
        "go_live_verdict": row.get("go_live_verdict") or "",
    }


def load_latest_gate_inputs(source: str = "backtest", pbo_source: str | None = None) -> dict[str, Any]:
    resolved_pbo_source = pbo_source or _base_risk_source(source)
    backtest_row = _first(query(
        """
        SELECT *
        FROM backtest_results
        ORDER BY run_date DESC, created_at DESC
        LIMIT 1
        """
    ))
    monte_carlo_row = _first(query(
        """
        SELECT *
        FROM monte_carlo_results
        WHERE source = ?
        ORDER BY run_date DESC, created_at DESC
        LIMIT 1
        """,
        [source],
    ))
    pbo_row = _first(query(
        """
        SELECT *
        FROM pbo_results
        WHERE source = ?
        ORDER BY run_date DESC, created_at DESC
        LIMIT 1
        """,
        [resolved_pbo_source],
    ))

    return {
        "source": source,
        "pbo_source": resolved_pbo_source,
        "raw_rows_present": {
            "backtest_results": backtest_row is not None,
            "monte_carlo_results": monte_carlo_row is not None,
            "pbo_results": pbo_row is not None,
        },
        "backtest": normalize_latest_backtest_row(backtest_row),
        "monte_carlo": normalize_latest_monte_carlo_row(monte_carlo_row),
        "pbo": normalize_latest_pbo_row(pbo_row),
    }


def evaluate_latest_promotion_gate(
    source: str = "backtest",
    *,
    pbo_source: str | None = None,
    policy: PromotionPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromotionPolicy.from_env()
    inputs = load_latest_gate_inputs(source=source, pbo_source=pbo_source)
    present = inputs["raw_rows_present"]
    missing = [f"missing_{name}" for name, ok in present.items() if not ok]

    if missing:
        validation_packet = build_validation_packet(
            source="promotion_gate",
            backtest=inputs["backtest"],
            monte_carlo=inputs["monte_carlo"] if present.get("monte_carlo_results") else None,
            pbo=inputs["pbo"] if present.get("pbo_results") else None,
            walk_forward=inputs["backtest"].get("walk_forward") or None,
            policy=policy,
        )
        return {
            "decision": "FAIL",
            "passed": False,
            "failed_gates": missing,
            "warnings": [],
            "policy": policy.to_dict(),
            "metrics": {},
            "validation_packet": validation_packet,
            "inputs": {
                "source": source,
                "pbo_source": inputs["pbo_source"],
                "backtest": inputs["backtest"],
                "monte_carlo": inputs["monte_carlo"],
                "pbo": inputs["pbo"],
                "raw_rows_present": present,
            },
        }

    result = evaluate_promotion_candidate(
        inputs["backtest"],
        inputs["monte_carlo"],
        inputs["pbo"],
        policy=policy,
    )
    validation_packet = build_validation_packet(
        source="promotion_gate",
        backtest=inputs["backtest"],
        monte_carlo=inputs["monte_carlo"],
        pbo=inputs["pbo"],
        walk_forward=inputs["backtest"].get("walk_forward") or None,
        policy=policy,
    )
    result = _attach_validation_packet(result, validation_packet)
    result["inputs"] = {
        "source": source,
        "pbo_source": inputs["pbo_source"],
        "backtest": inputs["backtest"],
        "monte_carlo": inputs["monte_carlo"],
        "pbo": inputs["pbo"],
        "raw_rows_present": present,
    }
    return result


def evaluate_latest_alpha_policy_gate(
    candidate: dict[str, Any],
    source: str = "backtest",
    *,
    pbo_source: str | None = None,
    policy: PromotionPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromotionPolicy.from_env()
    inputs = load_latest_gate_inputs(source=source, pbo_source=pbo_source)
    present = inputs["raw_rows_present"]
    missing = [f"missing_{name}" for name, ok in present.items() if not ok]

    if missing:
        validation_packet = build_validation_packet(
            source="alpha_policy_latest_gate",
            backtest=inputs["backtest"],
            monte_carlo=inputs["monte_carlo"] if present.get("monte_carlo_results") else None,
            pbo=inputs["pbo"] if present.get("pbo_results") else None,
            walk_forward=inputs["backtest"].get("walk_forward") or None,
            policy=policy,
        )
        return {
            "decision": "FAIL",
            "passed": False,
            "failed_gates": missing,
            "warnings": [],
            "policy": policy.to_dict(),
            "metrics": {},
            "validation_packet": validation_packet,
            "candidate": {
                "status": candidate.get("status"),
                "target": candidate.get("target") or candidate.get("stage"),
                "sample_count": _as_int(candidate.get("sample_count"), 0),
                "regime_counts": candidate.get("regime_counts") if isinstance(candidate.get("regime_counts"), dict) else {},
                "skipped_count": _as_int(candidate.get("skipped_count"), 0),
            },
            "inputs": {
                "source": source,
                "pbo_source": inputs["pbo_source"],
                "backtest": inputs["backtest"],
                "monte_carlo": inputs["monte_carlo"],
                "pbo": inputs["pbo"],
                "raw_rows_present": present,
            },
        }

    result = evaluate_alpha_policy_candidate(
        candidate,
        inputs["backtest"],
        inputs["monte_carlo"],
        inputs["pbo"],
        policy=policy,
    )
    validation_packet = build_validation_packet(
        source="alpha_policy_latest_gate",
        backtest=inputs["backtest"],
        monte_carlo=inputs["monte_carlo"],
        pbo=inputs["pbo"],
        walk_forward=inputs["backtest"].get("walk_forward") or None,
        policy=policy,
    )
    result = _attach_validation_packet(result, validation_packet)
    result["inputs"] = {
        "source": source,
        "pbo_source": inputs["pbo_source"],
        "backtest": inputs["backtest"],
        "monte_carlo": inputs["monte_carlo"],
        "pbo": inputs["pbo"],
        "raw_rows_present": present,
    }
    return result


def _candidate_id(candidate: dict[str, Any]) -> str | None:
    return (
        candidate.get("id")
        or candidate.get("sandbox_id")
        or candidate.get("source_id")
        or (candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {}).get("sandbox_id")
    )


def evaluate_alpha_policy_evidence_gate(
    candidate: dict[str, Any],
    evidence: dict[str, Any],
    *,
    policy: PromotionPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromotionPolicy.from_env()
    candidate_id = _candidate_id(candidate)
    evidence_candidate_id = evidence.get("candidate_id")
    failed: list[str] = []
    if candidate_id and evidence_candidate_id and candidate_id != evidence_candidate_id:
        failed.append("alpha_evidence_candidate_mismatch")
    if not evidence_candidate_id:
        failed.append("alpha_evidence_candidate_missing")

    backtest = evidence.get("backtest") if isinstance(evidence.get("backtest"), dict) else {}
    monte_carlo = evidence.get("monte_carlo") if isinstance(evidence.get("monte_carlo"), dict) else {}
    pbo = evidence.get("pbo") if isinstance(evidence.get("pbo"), dict) else {}
    data_snooping = evidence.get("data_snooping") if isinstance(evidence.get("data_snooping"), dict) else {}
    walk_forward = evidence.get("walk_forward") if isinstance(evidence.get("walk_forward"), dict) else {}
    for key, value in (("backtest", backtest), ("monte_carlo", monte_carlo), ("pbo", pbo)):
        if not value:
            failed.append(f"missing_alpha_evidence_{key}")

    result = evaluate_alpha_policy_candidate(
        candidate,
        backtest,
        monte_carlo,
        pbo,
        policy=policy,
    )
    validation_packet = build_validation_packet(
        source="alpha_policy_evidence_gate",
        backtest=backtest,
        monte_carlo=monte_carlo or None,
        pbo=pbo or None,
        data_snooping=data_snooping or None,
        walk_forward=walk_forward or None,
        policy=policy,
    )
    merged_failed = [*failed, *(result.get("failed_gates") or [])]
    if str(validation_packet.get("decision") or "").upper() != "PASS":
        merged_failed.extend(
            f"validation_packet:{name}"
            for name in (validation_packet.get("failed_gates") or ["unavailable"])
        )
    decision = "PASS" if not merged_failed else "FAIL"
    result.update({
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": merged_failed,
        "validation_packet": validation_packet,
        "inputs": {
            "source": "evidence_bundle",
            "candidate_id": candidate_id,
            "evidence_candidate_id": evidence_candidate_id,
            "backtest": backtest,
            "monte_carlo": monte_carlo,
            "pbo": pbo,
            "data_snooping": data_snooping,
            "walk_forward": walk_forward,
            "raw_rows_present": {
                "backtest_results": bool(backtest),
                "monte_carlo_results": bool(monte_carlo),
                "pbo_results": bool(pbo),
                "data_snooping": bool(data_snooping),
                "walk_forward": bool(walk_forward),
            },
        },
    })
    return result


def build_alpha_policy_evidence_bundle(
    *,
    candidate_id: str,
    backtest: dict[str, Any],
    monte_carlo: dict[str, Any],
    pbo: dict[str, Any],
    data_snooping: dict[str, Any] | None = None,
    walk_forward: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_backtest = normalize_latest_backtest_row(backtest)
    normalized_monte_carlo = normalize_latest_monte_carlo_row(monte_carlo)
    normalized_pbo = normalize_latest_pbo_row(pbo)
    return {
        "candidate_id": candidate_id,
        "backtest": normalized_backtest,
        "monte_carlo": normalized_monte_carlo,
        "pbo": normalized_pbo,
        "data_snooping": data_snooping or {},
        "walk_forward": walk_forward or {},
        "validation_packet": build_validation_packet(
            source="alpha_policy_evidence_bundle",
            backtest=normalized_backtest,
            monte_carlo=normalized_monte_carlo,
            pbo=normalized_pbo,
            data_snooping=data_snooping,
            walk_forward=walk_forward,
        ),
    }
