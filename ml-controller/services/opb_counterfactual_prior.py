"""Counterfactual arm-date replay for OnlinePortfolioBandit warm-start priors."""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

from services.evidence_contracts import (
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    L4_ARTIFACT_CONTRACT_VERSION,
    L4_EXPECTED_RETURN_SEMANTIC,
)
from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.allocator_ev_fusion_artifact_builder import load_allocator_ev_fusion_training_rows
from services.l4_alpha_ev_resolver import SNAPSHOT_BACKFILL_USAGE_SCOPE, extract_l4_alpha_ev
from services.online_portfolio_bandit import DEFAULT_ARMS, build_online_portfolio_bandit_l2_packet

SCHEMA_VERSION = "opb-arm-prior-artifact-v2"
EXPECTED_RETURN_SEMANTICS = {
    "l4_alpha_ev": L4_EXPECTED_RETURN_SEMANTIC,
    "allocator_ev_fusion": ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC,
}
EXPECTED_RETURN_CONTRACTS = {
    "l4_alpha_ev": L4_ARTIFACT_CONTRACT_VERSION,
    "allocator_ev_fusion": ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
}
LABEL_HORIZON_SESSIONS = 5
DEFAULT_ROUNDTRIP_COST_BPS = 18.0
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)



def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _counterfactual_expected_return(
    row: dict[str, Any],
    *,
    owner: str,
) -> tuple[float | None, str | None, str | None]:
    allocation = _loads(row.get("alpha_allocation"))
    if owner == "allocator_ev_fusion":
        payload = allocation.get("allocator_ev_fusion")
        if not isinstance(payload, dict):
            return None, None, None
        if str(payload.get("artifact_contract_version") or "").strip() != ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION:
            return None, None, None
        if str(payload.get("feature_semantic_version") or "").strip() != ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION:
            return None, None, None
        if str(payload.get("expected_return_semantic") or "").strip() != ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC:
            return None, None, None
        value = _finite(payload.get("expected_return"))
        allowed = payload.get("primary_expected_return_allowed") is True
        if value is None or not allowed:
            return None, None, None
        return (
            value,
            str(payload.get("model_version") or "unknown"),
            str(payload.get("trained_until") or "")[:10] or None,
        )

    if owner != "l4_alpha_ev":
        return None, None, None

    extractor_row = dict(row)
    if isinstance(allocation.get("l4_alpha_ev"), dict):
        extractor_row["l4_alpha_ev"] = allocation["l4_alpha_ev"]
    value, _source, payload = extract_l4_alpha_ev(
        extractor_row,
        usage_scope=SNAPSHOT_BACKFILL_USAGE_SCOPE,
    )
    if value is None or not isinstance(payload, dict):
        return None, None, None
    return (
        float(value),
        str(payload.get("model_version") or "unknown"),
        str(payload.get("trained_until") or "")[:10] or None,
    )


def _return_history(price_rows: list[dict[str, Any]], as_of: str) -> dict[str, list[float]]:
    closes: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for row in price_rows:
        day = str(row.get("price_date") or row.get("date") or "")[:10]
        symbol = str(row.get("symbol") or "").strip()
        close = _finite(row.get("close"))
        if symbol and day and day <= as_of and close is not None and close > 0:
            closes[symbol].append((day, close))
    histories: dict[str, list[float]] = {}
    for symbol, values in closes.items():
        ordered = [close for _day, close in sorted(values)[-61:]]
        histories[symbol] = [
            ordered[index] / ordered[index - 1] - 1.0
            for index in range(1, len(ordered))
            if ordered[index - 1] > 0
        ]
    return histories


def _block_bootstrap_interval(
    values: list[float],
    *,
    block_size: int = LABEL_HORIZON_SESSIONS,
    iterations: int = 1000,
) -> tuple[float | None, float | None]:
    if len(values) < 3:
        return None, None
    rng = random.Random(20260715)
    blocks = [values[index : index + block_size] for index in range(0, len(values), block_size)]
    means: list[float] = []
    for _ in range(iterations):
        sample: list[float] = []
        while len(sample) < len(values):
            sample.extend(rng.choice(blocks))
        means.append(sum(sample[: len(values)]) / len(values))
    means.sort()
    return means[int(0.05 * (iterations - 1))], means[int(0.95 * (iterations - 1))]


def build_opb_arm_prior_artifact(
    rows: list[dict[str, Any]],
    price_rows: list[dict[str, Any]],
    *,
    expected_return_owner: str,
    trained_until: str,
    min_dates: int = 20,
    roundtrip_cost_bps: float = DEFAULT_ROUNDTRIP_COST_BPS,
) -> dict[str, Any]:
    """Replay every fixed arm on every as-of date; never mix with live chosen-arm rewards."""

    if expected_return_owner not in EXPECTED_RETURN_CONTRACTS:
        raise ValueError(f"unsupported_expected_return_owner:{expected_return_owner}")

    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    source_versions: set[str] = set()
    missing_owner_rows = 0
    for row in rows:
        day = str(row.get("prediction_date") or row.get("snapshot_date") or "")[:10]
        actual_return = _finite(row.get("actual_return_pct"))
        expected_return, source_version, source_trained_until = _counterfactual_expected_return(
            row,
            owner=expected_return_owner,
        )
        if not day or actual_return is None or not (-1.0 < actual_return < 1.0):
            continue
        if expected_return is None or not source_trained_until or source_trained_until >= day:
            missing_owner_rows += 1
            continue
        if source_version:
            source_versions.add(source_version)
        by_date[day].append({
            "symbol": str(row.get("symbol") or "").strip(),
            "score": _finite(row.get("score")) or 0.0,
            "expected_return": expected_return,
            "actual_return": actual_return,
        })

    arm_rewards: dict[str, list[dict[str, Any]]] = {arm.arm_id: [] for arm in DEFAULT_ARMS}
    replay_failures: list[dict[str, str]] = []
    for day in sorted(by_date):
        candidates = [row for row in by_date[day] if row["symbol"] and row["expected_return"] > 0.0]
        if not candidates:
            continue
        actual_by_symbol = {row["symbol"]: row["actual_return"] for row in candidates}
        histories = _return_history(price_rows, day)
        for arm in DEFAULT_ARMS:
            try:
                packet = build_online_portfolio_bandit_l2_packet(
                    candidates=candidates,
                    return_history=histories,
                    reward_ledger=[],
                    exploration_alpha=0.0,
                    arms=(arm,),
                    stage="counterfactual_prior_replay",
                )
                allocation = packet.get("controlled_allocation") or {}
                weights = allocation.get("weights") if isinstance(allocation.get("weights"), dict) else {}
                exposure = sum(max(0.0, float(weight or 0.0)) for weight in weights.values())
                gross = sum(
                    max(0.0, float(weight or 0.0)) * actual_by_symbol.get(symbol, 0.0)
                    for symbol, weight in weights.items()
                )
                reward = gross - exposure * max(0.0, roundtrip_cost_bps) / 10000.0
                arm_rewards[arm.arm_id].append({
                    "date": day,
                    "reward": reward,
                    "gross_return": gross,
                    "exposure": exposure,
                    "selected_count": len(weights),
                })
            except Exception as exc:  # noqa: BLE001 - preserve date/arm evidence.
                replay_failures.append({"date": day, "arm_id": arm.arm_id, "error": str(exc)})

    all_rewards = [row["reward"] for values in arm_rewards.values() for row in values]
    global_mean = sum(all_rewards) / len(all_rewards) if all_rewards else 0.0
    arm_priors: list[dict[str, Any]] = []
    failed: list[str] = []
    for arm in DEFAULT_ARMS:
        history = arm_rewards[arm.arm_id]
        values = [float(row["reward"]) for row in history]
        dates = len(values)
        if dates < min_dates:
            failed.append(f"{arm.arm_id}:dates<{min_dates}")
        effective_samples = max(1, math.ceil(dates / LABEL_HORIZON_SESSIONS))
        raw_mean = sum(values) / dates if dates else 0.0
        shrinkage_strength = 5.0
        prior_mean = (
            (effective_samples * raw_mean + shrinkage_strength * global_mean)
            / (effective_samples + shrinkage_strength)
        )
        lcb90, ucb90 = _block_bootstrap_interval(values)
        arm_priors.append({
            "arm_id": arm.arm_id,
            "dates": dates,
            "effective_independent_dates": effective_samples,
            "raw_reward_mean": raw_mean,
            "prior_reward_mean": prior_mean,
            "prior_samples": effective_samples,
            "reward_lcb90": lcb90,
            "reward_ucb90": ucb90,
            "reward_history": history,
        })
    if replay_failures:
        failed.append("counterfactual_replay_failures")
    decision = "PASS" if not failed else "FAIL"
    fingerprint = hashlib.sha256(
        json.dumps(arm_priors, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    model_version = f"opb-prior-{expected_return_owner}-{trained_until.replace('-', '')}-{fingerprint}"
    validation = {
        "decision": decision,
        "failed_checks": failed,
        "minimum_dates_per_arm": min_dates,
        "label_horizon_sessions": LABEL_HORIZON_SESSIONS,
        "uncertainty_method": "prediction_date_block_bootstrap_90pct",
        "no_lookahead_contract": "snapshot_expected_return_as_of_date_plus_strictly_prior_price_history",
    }
    artifact = {
        "schema_version": SCHEMA_VERSION,
        "artifact_id": f"opb_arm_prior:{model_version}",
        "model_version": model_version,
        "expected_return_owner": expected_return_owner,
        "source_expected_return_contract_version": EXPECTED_RETURN_CONTRACTS[expected_return_owner],
        "source_expected_return_semantic": EXPECTED_RETURN_SEMANTICS[expected_return_owner],
        "source_model_versions": sorted(source_versions),
        "trained_until": trained_until,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "roundtrip_cost_bps": roundtrip_cost_bps,
        "reward_definition": "five_session_forward_portfolio_return_net_of_roundtrip_cost",
        "prior_method": "counterfactual_fixed_arm_replay_empirical_bayes_shrinkage",
        "live_reward_ledger_merged": False,
        "missing_owner_rows": missing_owner_rows,
        "replay_failures": replay_failures[:50],
        "arm_priors": arm_priors,
        "validation": validation,
    }
    return {"status": "validated" if decision == "PASS" else "failed_validation", "artifact": artifact}


def load_opb_counterfactual_inputs(
    *,
    end_date: str,
    lookback_days: int = 120,
    limit: int = 10000,
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
    learning_query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
    market_query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
    core_query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    # query_fn remains a backward-compatible test seam; production always splits owners.
    learning_query = query_fn or learning_query_fn or LEARNING_D1_CLIENT.query
    market_query = query_fn or market_query_fn or MARKET_D1_CLIENT.query
    core_query = query_fn or core_query_fn or CORE_D1_CLIENT.query

    rows = load_allocator_ev_fusion_training_rows(
        learning_query,
        core_query_fn=core_query,
        end_date=end_date,
        lookback_days=lookback_days,
        limit=limit,
    )
    normalized_rows = [
        {
            **row,
            "snapshot_date": row.get("snapshot_date") or row.get("prediction_date"),
            "actual_return_pct": (
                row.get("actual_return_pct")
                if row.get("actual_return_pct") is not None
                else row.get("l4_executable_return_pct")
            ),
        }
        for row in rows
    ]
    symbol_by_stock_id: dict[int, str] = {}
    for row in normalized_rows:
        try:
            stock_id = int(row.get("stock_id"))
        except (TypeError, ValueError):
            continue
        symbol = str(row.get("symbol") or "").strip()
        if symbol:
            symbol_by_stock_id[stock_id] = symbol

    price_rows: list[dict[str, Any]] = []
    stock_ids = sorted(symbol_by_stock_id)
    for offset in range(0, len(stock_ids), 80):
        chunk = stock_ids[offset : offset + 80]
        placeholders = ",".join("?" * len(chunk))
        loaded = market_query(
            f"SELECT stock_id, date(date) AS price_date, close FROM stock_prices "
            f"WHERE stock_id IN ({placeholders}) "
            f"AND date(date) <= date(?) AND date(date) >= date(?, ?) "
            f"ORDER BY stock_id ASC, date(date) ASC",
            [*chunk, end_date, end_date, f"-{max(lookback_days + 100, 220)} days"],
        )
        for row in loaded:
            symbol = symbol_by_stock_id.get(int(row.get("stock_id") or -1))
            if not symbol:
                continue
            price_rows.append({**row, "symbol": symbol})
    price_rows.sort(key=lambda row: (str(row.get("symbol") or ""), str(row.get("price_date") or "")))
    return normalized_rows, price_rows
