"""Read-only replay for LinUCB multiplier L2 constants.

This validates the five `bandit_*` L2 constants against historical verified
Active-8 direct-alpha prediction rows. It reuses the production LinUCB multiplier function
in memory and never reads or writes the live GCS bandit state.
"""

from __future__ import annotations

import itertools
import math
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import numpy as np

from .adaptive_meta_policy_replay import (
    _clamp,
    _first_present,
    _float,
    _nested,
    _pct_decimal,
    _row_date,
    _safe_json,
    _symbol,
)
from .linucb_bandit import ARM_NAMES, LinUCBBandit, build_context


SCHEMA_VERSION = "linucb-multiplier-replay-v1"
ADAPTIVE_CANDIDATE_SCHEMA_VERSION = "adaptive-params-candidate-v1"
ALLOCATOR_LEARNING_CANDIDATE_SCHEMA_VERSION = "allocator-learning-policy-candidate-v1"
ACTIVE_MODEL_NAMES = tuple(name for name in ARM_NAMES if name != "DoNothing")
BASELINE_BANDIT_L2 = {
    "bandit_loss_thresh_high": 0.60,
    "bandit_loss_thresh_med": 0.40,
    "bandit_max_mult_high": 1.50,
    "bandit_max_mult_med": 2.00,
    "bandit_max_mult_low": 2.50,
}
DEFAULT_SEARCH_SPACE = {
    "bandit_loss_thresh_high": [0.50, 0.60, 0.70],
    "bandit_loss_thresh_med": [0.25, 0.40, 0.50],
    "bandit_max_mult_high": [1.10, 1.50, 1.80],
    "bandit_max_mult_med": [1.50, 2.00, 2.30],
    "bandit_max_mult_low": [2.00, 2.50, 3.00],
}
LINUCB_CANDIDATE_KEYS = tuple(BASELINE_BANDIT_L2)


@dataclass(frozen=True)
class MultiplierReplayConfig:
    min_decisions: int = 30
    max_grid_evals: int = 96
    recent_loss_window: int = 5
    min_ucb_mult: float = 0.30
    seed: int = 42


@dataclass(frozen=True)
class PreparedRow:
    date: str
    symbol: str
    model_name: str
    score: float
    reward01: float
    pnl: float
    context: np.ndarray
    actual_return: float | None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _prediction_score(row: dict[str, Any]) -> float | None:
    forecast = _safe_json(row.get("forecast_data"))
    raw = _first_present(row.get("rank_score"), _nested(forecast, "rank_score"), row.get("direction_accuracy"))
    score = _float(raw)
    if score is None:
        return None
    if 0.0 <= score <= 1.0:
        return score - 0.5
    return score


def _direction_reward(row: dict[str, Any], score: float, actual_return: float | None) -> float | None:
    value = row.get("direction_correct")
    if value is not None:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = -1
        if parsed == 1:
            return 1.0
        if parsed == 0:
            return 0.0
    if actual_return is None:
        return None
    return 1.0 if (score >= 0.0) == (actual_return >= 0.0) else 0.0


def _pnl_reward(row: dict[str, Any], reward01: float, actual_return: float | None) -> float:
    pnl = _pct_decimal(_first_present(row.get("trade_pnl_pct"), row.get("actual_return_pct")))
    if pnl is not None:
        return float(pnl)
    actual = float(actual_return or 0.0)
    return actual if reward01 >= 0.5 else -abs(actual)


def _context(row: dict[str, Any]) -> np.ndarray:
    alpha_context = _safe_json(row.get("alpha_context"))
    score = _safe_json(row.get("score_components"))
    regime = _first_present(row.get("regime"), _nested(alpha_context, "regime"))
    market_risk = _first_present(
        row.get("market_risk_score"),
        row.get("market_risk"),
        _nested(alpha_context, "market_risk_score"),
        _nested(score, "market_risk"),
    )
    market_risk_float = _float(market_risk)
    if market_risk_float is None:
        market_risk_norm = 0.50
    else:
        market_risk_norm = market_risk_float / 100.0 if abs(market_risk_float) > 1.0 else market_risk_float
    volatility = _first_present(
        row.get("volatility"),
        _nested(alpha_context, "volatility"),
        _nested(alpha_context, "volatility_score"),
        _nested(score, "volatility"),
    )
    vol = _float(volatility)
    if vol is None:
        vol = 0.02
    elif abs(vol) > 1.0:
        vol = vol / 100.0
    return build_context(
        hmm_regime=regime,
        garch_vol=max(float(vol), 0.0),
        current_price=1.0,
        market_risk_score=_clamp(float(market_risk_norm), 0.0, 1.0),
    )


def prepare_multiplier_replay_rows(rows: Iterable[dict[str, Any]]) -> list[PreparedRow]:
    prepared: list[PreparedRow] = []
    active = {name.lower(): name for name in ACTIVE_MODEL_NAMES}
    for row in rows:
        date = _row_date(row)
        if not date:
            continue
        raw_model = str(row.get("model_name") or "").strip()
        model_name = active.get(raw_model.lower())
        if not model_name:
            continue
        score = _prediction_score(row)
        actual_return = _pct_decimal(row.get("actual_return_pct"))
        if score is None or actual_return is None:
            continue
        reward = _direction_reward(row, score, actual_return)
        if reward is None:
            continue
        prepared.append(
            PreparedRow(
                date=date,
                symbol=_symbol(row),
                model_name=model_name,
                score=float(score),
                reward01=float(reward),
                pnl=_pnl_reward(row, float(reward), actual_return),
                context=_context(row),
                actual_return=actual_return,
            )
        )
    return sorted(prepared, key=lambda row: (row.date, row.symbol, row.model_name))


def bandit_protection_from_l2(losses: int, total: int, l2: dict[str, float]) -> dict[str, Any]:
    high = float(l2.get("bandit_loss_thresh_high", BASELINE_BANDIT_L2["bandit_loss_thresh_high"]))
    med = float(l2.get("bandit_loss_thresh_med", BASELINE_BANDIT_L2["bandit_loss_thresh_med"]))
    max_high = float(l2.get("bandit_max_mult_high", BASELINE_BANDIT_L2["bandit_max_mult_high"]))
    max_med = float(l2.get("bandit_max_mult_med", BASELINE_BANDIT_L2["bandit_max_mult_med"]))
    max_low = float(l2.get("bandit_max_mult_low", BASELINE_BANDIT_L2["bandit_max_mult_low"]))
    loss_rate = losses / total if total else None
    if total <= 0:
        return {"bandit_max_mult": max_low, "bandit_force_explore": False, "decision": "no_recent_reward_samples", "loss_rate": None}
    if loss_rate is not None and loss_rate > high:
        return {"bandit_max_mult": max_high, "bandit_force_explore": True, "decision": "high_recent_loss_rate_force_explore", "loss_rate": round(loss_rate, 6)}
    if loss_rate is not None and loss_rate > med:
        return {"bandit_max_mult": max_med, "bandit_force_explore": False, "decision": "medium_recent_loss_rate_cap_exposure", "loss_rate": round(loss_rate, 6)}
    return {"bandit_max_mult": max_low, "bandit_force_explore": False, "decision": "reward_ledger_ok", "loss_rate": round(float(loss_rate), 6)}


def _valid_l2(candidate: dict[str, Any]) -> bool:
    try:
        high = float(candidate["bandit_loss_thresh_high"])
        med = float(candidate["bandit_loss_thresh_med"])
        max_high = float(candidate["bandit_max_mult_high"])
        max_med = float(candidate["bandit_max_mult_med"])
        max_low = float(candidate["bandit_max_mult_low"])
    except (KeyError, TypeError, ValueError):
        return False
    return high > med and max_low >= max_med >= max_high > 0.0


def _candidate_grid(
    search_space: dict[str, Sequence[float]] | None,
    config: MultiplierReplayConfig,
) -> list[dict[str, float]]:
    space = search_space or DEFAULT_SEARCH_SPACE
    names = list(BASELINE_BANDIT_L2)
    values = [list(space.get(name) or [BASELINE_BANDIT_L2[name]]) for name in names]
    candidates = [dict(BASELINE_BANDIT_L2)]
    for combo in itertools.product(*values):
        candidate = {name: float(value) for name, value in zip(names, combo)}
        if _valid_l2(candidate) and candidate not in candidates:
            candidates.append(candidate)
        if len(candidates) >= config.max_grid_evals:
            break
    return candidates


def _group_by_date_symbol(rows: list[PreparedRow]) -> list[tuple[str, str, list[PreparedRow]]]:
    groups: dict[tuple[str, str], list[PreparedRow]] = {}
    for row in rows:
        groups.setdefault((row.date, row.symbol), []).append(row)
    return [(date, symbol, sorted(items, key=lambda item: item.model_name)) for (date, symbol), items in sorted(groups.items())]


def _select_row(rows: list[PreparedRow], multipliers: dict[str, float]) -> PreparedRow:
    return max(
        rows,
        key=lambda row: (
            row.score * float(multipliers.get(row.model_name, 1.0)),
            row.score,
            row.model_name,
        ),
    )


def replay_candidate(rows: list[PreparedRow], candidate: dict[str, float], config: MultiplierReplayConfig) -> dict[str, Any]:
    bandit = LinUCBBandit()
    recent_rewards: deque[float] = deque(maxlen=max(1, config.recent_loss_window))
    records: list[dict[str, Any]] = []
    protection_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()
    multiplier_ranges: list[float] = []

    for date, symbol, symbol_rows in _group_by_date_symbol(rows):
        losses = sum(1 for reward in recent_rewards if reward < 0.5)
        total = len(recent_rewards)
        protection = bandit_protection_from_l2(losses, total, candidate)
        context = np.mean(np.stack([row.context for row in symbol_rows]), axis=0)
        multipliers = bandit.ucb_to_weight_multipliers(
            context,
            min_mult=config.min_ucb_mult,
            max_mult=float(protection["bandit_max_mult"]),
            force_explore=bool(protection["bandit_force_explore"]),
            adaptive_params={"bandit_max_mult": protection["bandit_max_mult"], "bandit_force_explore": protection["bandit_force_explore"]},
        )
        selected = _select_row(symbol_rows, multipliers)
        bandit.update(ARM_NAMES.index(selected.model_name), selected.context, selected.reward01)
        recent_rewards.append(selected.reward01)
        protection_counts[str(protection["decision"])] += 1
        action_counts[selected.model_name] += 1
        model_mults = [float(multipliers.get(row.model_name, 1.0)) for row in symbol_rows]
        multiplier_ranges.append(max(model_mults) - min(model_mults))
        records.append({
            "date": date,
            "symbol": symbol,
            "model_name": selected.model_name,
            "reward01": selected.reward01,
            "pnl": selected.pnl,
            "score": selected.score,
            "loss_rate": protection["loss_rate"],
            "protection_decision": protection["decision"],
            "bandit_max_mult": protection["bandit_max_mult"],
            "force_explore": protection["bandit_force_explore"],
        })

    rewards = [row["reward01"] for row in records]
    pnls = [row["pnl"] for row in records]
    decision_count = len(records)
    action_concentration = max(action_counts.values()) / decision_count if decision_count else 0.0
    avg_reward = float(np.mean(rewards)) if rewards else 0.0
    avg_pnl = float(np.mean(pnls)) if pnls else 0.0
    force_rate = protection_counts["high_recent_loss_rate_force_explore"] / decision_count if decision_count else 0.0
    score = avg_reward + _clamp(avg_pnl, -0.05, 0.05) - 0.05 * max(0.0, action_concentration - 0.65) - 0.02 * force_rate
    return {
        "candidate": {key: round(float(value), 6) for key, value in candidate.items()},
        "decisions": decision_count,
        "average_reward": round(avg_reward, 8),
        "average_pnl": round(avg_pnl, 8),
        "selection_score": round(float(score), 8),
        "positive_reward_rate": round(float(np.mean([reward > 0.5 for reward in rewards])), 8) if rewards else 0.0,
        "action_concentration": round(float(action_concentration), 8),
        "action_counts": dict(action_counts),
        "protection_counts": dict(protection_counts),
        "mean_multiplier_range": round(float(np.mean(multiplier_ranges)), 8) if multiplier_ranges else 0.0,
        "preview": records[:8],
    }


def _approval_candidate_status(status: str) -> str:
    return "candidate_requires_approval" if status == "pass" else "research_only_failed_gate"


def _build_adaptive_params_candidate(
    *,
    status: str,
    best: dict[str, Any] | None,
    baseline: dict[str, Any] | None,
    gates: list[dict[str, Any]],
    prepared_rows: int,
) -> dict[str, Any] | None:
    if not best or not isinstance(best.get("candidate"), dict):
        return None
    patch = {
        key: round(float(best["candidate"][key]), 6)
        for key in LINUCB_CANDIDATE_KEYS
        if key in best["candidate"]
    }
    if set(patch) != set(LINUCB_CANDIDATE_KEYS):
        return None
    baseline_patch = (
        dict(baseline.get("candidate") or {})
        if isinstance(baseline, dict)
        else {key: round(float(value), 6) for key, value in BASELINE_BANDIT_L2.items()}
    )
    return {
        "schema_version": ADAPTIVE_CANDIDATE_SCHEMA_VERSION,
        "candidate_type": "linucb_bandit_l2_constants",
        "source": "linucb_multiplier_replay",
        "status": _approval_candidate_status(status),
        "approved": False,
        "approval_status": "not_submitted",
        "approved_level": None,
        "requires_wei_approval": True,
        "production_effect": False,
        "proposed_production_effect": "capped_production_effect",
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "allowed_target": "ml:adaptive_params.bandit_l2_constants",
        "adaptive_params_patch": patch,
        "baseline_patch": baseline_patch,
        "effect_policy": {
            "scope": "linucb_bandit_multiplier_l2_constants",
            "production_effect": "capped_production_effect",
            "mutates_trading_config": False,
            "requires_approved_level": "L3",
            "numeric_bounds": {
                "bandit_loss_thresh_high": [0.0, 1.0],
                "bandit_loss_thresh_med": [0.0, 1.0],
                "bandit_max_mult_high": [1.0, 2.0],
                "bandit_max_mult_med": [1.0, 2.5],
                "bandit_max_mult_low": [1.0, 3.0],
            },
        },
        "evidence": {
            "prepared_rows": prepared_rows,
            "selection_score": best.get("selection_score"),
            "average_reward": best.get("average_reward"),
            "average_pnl": best.get("average_pnl"),
            "action_concentration": best.get("action_concentration"),
            "action_counts": best.get("action_counts"),
            "gates": gates,
        },
    }


def _model_learning_multipliers_from_counts(action_counts: dict[str, Any] | None) -> dict[str, float]:
    counts = {
        model: int((action_counts or {}).get(model, 0) or 0)
        for model in ACTIVE_MODEL_NAMES
    }
    total = sum(counts.values())
    if total <= 0:
        return {model: 1.0 for model in ACTIVE_MODEL_NAMES}
    equal_share = 1.0 / max(1, len(ACTIVE_MODEL_NAMES))
    out: dict[str, float] = {}
    for model, count in counts.items():
        share = count / total
        relative_edge = (share - equal_share) / equal_share
        out[model] = round(1.0 + _clamp(relative_edge, -1.0, 1.0) * 0.50, 6)
    return out


def _build_allocator_learning_policy_candidate(
    *,
    status: str,
    best: dict[str, Any] | None,
    gates: list[dict[str, Any]],
    prepared_rows: int,
) -> dict[str, Any] | None:
    if not best:
        return None
    action_counts = best.get("action_counts")
    if not isinstance(action_counts, dict):
        return None
    policy_id = f"linucb-learning-{str(best.get('selection_score') or 'na')}"
    return {
        "schema_version": ALLOCATOR_LEARNING_CANDIDATE_SCHEMA_VERSION,
        "policy_id": policy_id,
        "candidate_type": "linucb_model_learning_weight_multipliers",
        "source": "linucb_multiplier_replay",
        "status": _approval_candidate_status(status),
        "approved": False,
        "approval_status": "not_submitted",
        "approved_level": None,
        "requires_wei_approval": True,
        "production_effect": False,
        "proposed_production_effect": "learning_weight_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "allowed_target": "ml:adaptive_params.model_allocator.learning_weight_policy",
        "learning_weight_cap": 0.50,
        "model_learning_multipliers": _model_learning_multipliers_from_counts(action_counts),
        "evidence": {
            "prepared_rows": prepared_rows,
            "selection_score": best.get("selection_score"),
            "average_reward": best.get("average_reward"),
            "average_pnl": best.get("average_pnl"),
            "action_concentration": best.get("action_concentration"),
            "action_counts": action_counts,
            "gates": gates,
        },
    }


def run_linucb_multiplier_replay(
    rows: Iterable[dict[str, Any]],
    *,
    candidates: list[dict[str, float]] | None = None,
    search_space: dict[str, Sequence[float]] | None = None,
    config: MultiplierReplayConfig | None = None,
) -> dict[str, Any]:
    cfg = config or MultiplierReplayConfig()
    source_rows = list(rows)
    prepared = prepare_multiplier_replay_rows(source_rows)
    if not prepared:
        return {
            "schema_version": SCHEMA_VERSION,
            "generated_at": _utc_now(),
            "production_effect": False,
            "mutation_allowed": False,
            "allowed_use": "research_only",
            "status": "fail",
            "reason": "no_prepared_rows",
            "source_rows": len(source_rows),
            "prepared_rows": 0,
            "ranking": [],
            "gates": [{"name": "prepared_rows", "passed": False, "reason": "no_prepared_rows"}],
        }

    candidate_list = [dict(BASELINE_BANDIT_L2)]
    for candidate in candidates or _candidate_grid(search_space, cfg):
        normalized = {key: float(candidate[key]) for key in BASELINE_BANDIT_L2 if key in candidate}
        if _valid_l2(normalized) and normalized not in candidate_list:
            candidate_list.append(normalized)
        if len(candidate_list) >= cfg.max_grid_evals:
            break

    ranking = sorted(
        [replay_candidate(prepared, candidate, cfg) for candidate in candidate_list],
        key=lambda row: (float(row["selection_score"]), float(row["average_reward"]), float(row["average_pnl"])),
        reverse=True,
    )
    baseline = next(row for row in ranking if row["candidate"] == {key: round(value, 6) for key, value in BASELINE_BANDIT_L2.items()})
    best = ranking[0] if ranking else None
    gates = [
        {
            "name": "min_decisions",
            "passed": bool(best and int(best["decisions"]) >= cfg.min_decisions),
            "reason": "enough_decisions" if best and int(best["decisions"]) >= cfg.min_decisions else f"decisions<{cfg.min_decisions}",
        },
        {
            "name": "beats_baseline",
            "passed": bool(best and float(best["selection_score"]) > float(baseline["selection_score"])),
            "reason": "candidate_above_baseline" if best and float(best["selection_score"]) > float(baseline["selection_score"]) else "candidate_does_not_beat_baseline",
        },
        {
            "name": "no_single_model_collapse",
            "passed": bool(best and float(best["action_concentration"]) <= 0.80),
            "reason": "action_concentration_within_policy" if best and float(best["action_concentration"]) <= 0.80 else "action_concentration_too_high",
        },
    ]
    status = "pass" if all(gate["passed"] for gate in gates) else "fail"
    adaptive_params_candidate = _build_adaptive_params_candidate(
        status=status,
        best=best,
        baseline=baseline,
        gates=gates,
        prepared_rows=len(prepared),
    )
    allocator_policy_candidate = _build_allocator_learning_policy_candidate(
        status=status,
        best=best,
        gates=gates,
        prepared_rows=len(prepared),
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _utc_now(),
        "production_effect": False,
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "allowed_use": "roadmap_candidate" if status == "pass" else "research_only",
        "status": status,
        "source_rows": len(source_rows),
        "prepared_rows": len(prepared),
        "date_start": prepared[0].date,
        "date_end": prepared[-1].date,
        "active_models": list(ACTIVE_MODEL_NAMES),
        "baseline": baseline,
        "best_candidate": best["candidate"] if best else None,
        "adaptive_params_candidate": adaptive_params_candidate,
        "allocator_policy_candidate": allocator_policy_candidate,
        "candidate_count": len(candidate_list),
        "ranking": ranking,
        "gates": gates,
        "notes": [
            "Read-only replay; does not read or write live LinUCB GCS state.",
            "Uses verified Active-8 direct-alpha per-model prediction rows and production LinUCBBandit multiplier conversion.",
        ],
    }
