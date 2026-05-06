from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass
from typing import Any, Callable

from services.alpha_framework import DEFAULT_ALPHA_POLICY, AlphaBucket


REGIMES = ("bull", "bear", "volatile", "sideways")
BUCKETS = tuple(bucket.value for bucket in AlphaBucket)


@dataclass(frozen=True)
class GAOptimizerRequest:
    population_size: int = 24
    generations: int = 8
    mutation_rate: float = 0.25
    crossover_rate: float = 0.70
    elite_count: int = 4
    seed: int = 42
    top_k: int = 5
    plateau_tolerance: float = 0.03


Evaluator = Callable[[dict[str, Any]], dict[str, Any]]


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _to_float(value: Any, default: float) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else default
    except (TypeError, ValueError):
        return default


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _normalize_weights(weights: dict[str, Any]) -> dict[str, float]:
    cleaned = {bucket: max(0.02, _to_float(weights.get(bucket), 0.0)) for bucket in BUCKETS}
    total = sum(cleaned.values())
    if total <= 0:
        return dict(DEFAULT_ALPHA_POLICY["allocation"]["weights"]["sideways"])
    return {bucket: _round(value / total) for bucket, value in cleaned.items()}


def _apply_weight_overrides(current: dict[str, Any], overrides: dict[str, Any]) -> dict[str, float]:
    specified = {
        bucket: _clamp(_to_float(overrides[bucket], 0.0), 0.02, 0.90)
        for bucket in BUCKETS
        if bucket in overrides
    }
    if not specified:
        merged = dict(current)
        merged.update(overrides)
        return _normalize_weights(merged)

    specified_total = sum(specified.values())
    if specified_total >= 0.98:
        return _normalize_weights(specified)

    remaining_total = 1.0 - specified_total
    rest = {bucket: max(0.02, _to_float(current.get(bucket), 0.0)) for bucket in BUCKETS if bucket not in specified}
    rest_total = sum(rest.values())
    if rest_total <= 0:
        rest = {bucket: 1.0 for bucket in BUCKETS if bucket not in specified}
        rest_total = sum(rest.values())
    out = dict(specified)
    for bucket, value in rest.items():
        out[bucket] = _round((value / rest_total) * remaining_total)
    drift = _round(1.0 - sum(out.values()))
    if abs(drift) > 0 and out:
        target = max(out, key=lambda key: out[key])
        out[target] = _round(out[target] + drift)
    return out


def _default_alpha_framework() -> dict[str, Any]:
    default = copy.deepcopy(DEFAULT_ALPHA_POLICY)
    return {
        "riskOverlay": {
            "volatilityExpansionRatio": default["risk_overlay"]["volatility_expansion_ratio"],
            "volatilityExpansionMin3d": default["risk_overlay"]["volatility_expansion_min_3d"],
            "extremeVolThreshold": default["risk_overlay"]["extreme_vol_threshold"],
            "highVolThreshold": default["risk_overlay"]["high_vol_threshold"],
            "liquidityLowVolume": default["risk_overlay"]["liquidity_low_volume"],
            "liquidityThinVolume": default["risk_overlay"]["liquidity_thin_volume"],
            "skipSizingCap": default["risk_overlay"]["skip_sizing_cap"],
        },
        "allocation": {
            "slateSize": default["allocation"]["slate_size"],
            "scoreRoundDecimals": default["allocation"]["score_round_decimals"],
            "weights": copy.deepcopy(default["allocation"]["weights"]),
        },
        "scoring": {
            "bucketBonus": copy.deepcopy(default["scoring"]["bucket_bonus"]),
            "regimeWeightImpact": default["scoring"]["regime_weight_impact"],
            "overlayPenaltyImpact": default["scoring"]["overlay_penalty_impact"],
            "confidenceWeightImpact": default["scoring"]["confidence_weight_impact"],
            "confidencePenaltyImpact": default["scoring"]["confidence_penalty_impact"],
        },
    }


def _merge_alpha_framework(overrides: dict[str, Any] | None) -> dict[str, Any]:
    policy = _default_alpha_framework()
    if not isinstance(overrides, dict):
        return policy

    risk = overrides.get("riskOverlay") or overrides.get("risk_overlay")
    if isinstance(risk, dict):
        overlay = policy["riskOverlay"]
        key_bounds = {
            "volatilityExpansionRatio": (1.0, 5.0),
            "volatilityExpansionMin3d": (0.0, 0.30),
            "extremeVolThreshold": (0.01, 0.50),
            "highVolThreshold": (0.005, 0.30),
            "liquidityLowVolume": (0.0, 5_000_000.0),
            "liquidityThinVolume": (0.0, 20_000_000.0),
            "skipSizingCap": (0.10, 0.70),
        }
        aliases = {
            "volatility_expansion_ratio": "volatilityExpansionRatio",
            "volatility_expansion_min_3d": "volatilityExpansionMin3d",
            "extreme_vol_threshold": "extremeVolThreshold",
            "high_vol_threshold": "highVolThreshold",
            "liquidity_low_volume": "liquidityLowVolume",
            "liquidity_thin_volume": "liquidityThinVolume",
            "skip_sizing_cap": "skipSizingCap",
        }
        for raw_key, raw_value in risk.items():
            key = aliases.get(raw_key, raw_key)
            if key not in key_bounds:
                continue
            lo, hi = key_bounds[key]
            overlay[key] = _round(_clamp(_to_float(raw_value, overlay[key]), lo, hi))
        if overlay["extremeVolThreshold"] <= overlay["highVolThreshold"]:
            overlay["extremeVolThreshold"] = _round(min(0.50, overlay["highVolThreshold"] + 0.005))
        if overlay["liquidityThinVolume"] < overlay["liquidityLowVolume"]:
            overlay["liquidityThinVolume"] = overlay["liquidityLowVolume"]

    allocation = overrides.get("allocation")
    if isinstance(allocation, dict):
        if allocation.get("slateSize") is not None or allocation.get("slate_size") is not None:
            raw_slate = allocation.get("slateSize", allocation.get("slate_size"))
            policy["allocation"]["slateSize"] = int(_clamp(_to_float(raw_slate, policy["allocation"]["slateSize"]), 1, 30))
        weights = allocation.get("weights")
        if isinstance(weights, dict):
            for regime, regime_weights in weights.items():
                normalized_regime = regime if regime in REGIMES else "sideways"
                if isinstance(regime_weights, dict):
                    current = dict(policy["allocation"]["weights"].get(normalized_regime, {}))
                    policy["allocation"]["weights"][normalized_regime] = _apply_weight_overrides(current, regime_weights)

    scoring = overrides.get("scoring")
    if isinstance(scoring, dict):
        raw_bonus = scoring.get("bucketBonus") or scoring.get("bucket_bonus")
        if isinstance(raw_bonus, dict):
            for bucket in BUCKETS:
                if bucket in raw_bonus:
                    policy["scoring"]["bucketBonus"][bucket] = _round(_clamp(_to_float(raw_bonus[bucket], 0.0), 0.0, 8.0))
        for key, bounds in {
            "regimeWeightImpact": (0.0, 20.0),
            "overlayPenaltyImpact": (0.0, 5.0),
            "confidenceWeightImpact": (0.0, 1.0),
            "confidencePenaltyImpact": (0.0, 0.10),
        }.items():
            if key in scoring:
                policy["scoring"][key] = _round(_clamp(_to_float(scoring[key], policy["scoring"][key]), *bounds))

    return policy


def build_ga_candidate(overrides: dict[str, Any] | None, *, generation: int, candidate_index: int) -> dict[str, Any]:
    alpha_framework = _merge_alpha_framework(overrides)
    candidate_id = f"ga_optimizer:g{generation}:c{candidate_index}"
    return {
        "id": candidate_id,
        "status": "completed",
        "source": "ga_optimizer",
        "target": "meta_optimizer_learning",
        "params": {"alphaFramework": alpha_framework},
        "config": {"alphaFramework": alpha_framework},
        "alphaFramework": alpha_framework,
        "metadata": {
            "optimizer": "GAOptimizer",
            "layer": "meta_optimizer",
            "direct_prediction": False,
            "generation": generation,
            "candidate_index": candidate_index,
            "scope": ["ensemble_weights", "strategy_params", "risk_params"],
            "learning_mode": "direct",
            "apply_gate": "walk_forward+pbo+transaction_cost_sensitivity",
        },
    }


def _candidate_metrics(candidate: dict[str, Any], evaluator: Evaluator | None) -> dict[str, Any]:
    if evaluator is not None:
        return evaluator(candidate)
    alpha = candidate["params"]["alphaFramework"]
    bull = alpha["allocation"]["weights"]["bull"]
    high_vol = alpha["riskOverlay"]["highVolThreshold"]
    sizing_cap = alpha["riskOverlay"]["skipSizingCap"]
    balance_penalty = abs(bull["trend_following"] - 0.40) + abs(bull["breakout_vol_expansion"] - 0.32)
    risk_penalty = abs(high_vol - 0.04) * 4.0 + abs(sizing_cap - 0.35)
    score = 1.0 - balance_penalty - risk_penalty
    return {
        "score": score,
        "sharpe": 0.75 + score * 0.6,
        "max_drawdown": _clamp(0.18 + max(0.0, high_vol - 0.04), 0.05, 0.40),
        "trade_count": 120,
        "pbo": _clamp(0.30 + balance_penalty * 0.15, 0.0, 1.0),
        "mdd_95th": _clamp(0.16 + risk_penalty * 0.10, 0.05, 0.50),
    }


def _gate(metrics: dict[str, Any]) -> dict[str, Any]:
    checks = {
        "min_trade_count": _to_float(metrics.get("trade_count"), 0.0) >= 60,
        "min_sharpe": _to_float(metrics.get("sharpe"), -99.0) >= 0.50,
        "max_drawdown": _to_float(metrics.get("max_drawdown"), 99.0) <= 0.25,
        "pbo": _to_float(metrics.get("pbo"), 1.0) < 0.50,
        "monte_carlo_mdd_95th": _to_float(metrics.get("mdd_95th"), 99.0) <= 0.20,
    }
    failed = [name for name, passed in checks.items() if not passed]
    return {
        "decision": "PASS" if not failed else "REJECT",
        "passed": not failed,
        "failed_gates": failed,
        "checks": checks,
    }


def evaluate_ga_population(
    candidates: list[dict[str, Any]],
    *,
    evaluator: Evaluator | None = None,
    plateau_tolerance: float = 0.03,
) -> dict[str, Any]:
    evaluated: list[dict[str, Any]] = []
    for candidate in candidates:
        metrics = _candidate_metrics(candidate, evaluator)
        score = _to_float(metrics.get("score"), -999.0)
        evaluated.append({
            "candidate": candidate,
            "score": score,
            "metrics": metrics,
            "gate": _gate(metrics),
        })

    ranked = sorted(
        evaluated,
        key=lambda row: (1 if row["gate"]["passed"] else 0, row["score"]),
        reverse=True,
    )
    best_score = ranked[0]["score"] if ranked else 0.0
    plateau = [
        row["candidate"]["id"]
        for row in ranked
        if row["gate"]["passed"] and best_score - row["score"] <= max(0.0, plateau_tolerance)
    ]
    if not plateau and ranked:
        plateau = [ranked[0]["candidate"]["id"]]

    if ranked:
        ranked[0]["plateau"] = {
            "plateau_size": len(plateau),
            "candidate_ids": plateau,
            "score_center": _round(best_score),
            "tolerance": plateau_tolerance,
        }

    return {
        "status": "completed",
        "best": ranked[0] if ranked else None,
        "ranked": ranked,
        "plateau": ranked[0]["plateau"] if ranked else None,
    }


def _random_overrides(rng: random.Random) -> dict[str, Any]:
    weights: dict[str, dict[str, float]] = {}
    for regime in REGIMES:
        weights[regime] = _normalize_weights({bucket: rng.uniform(0.05, 0.70) for bucket in BUCKETS})
    return {
        "allocation": {"slateSize": rng.randint(6, 14), "weights": weights},
        "riskOverlay": {
            "volatilityExpansionRatio": rng.uniform(1.20, 2.80),
            "volatilityExpansionMin3d": rng.uniform(0.005, 0.06),
            "highVolThreshold": rng.uniform(0.02, 0.08),
            "extremeVolThreshold": rng.uniform(0.07, 0.16),
            "skipSizingCap": rng.uniform(0.20, 0.55),
        },
        "scoring": {
            "regimeWeightImpact": rng.uniform(6.0, 14.0),
            "overlayPenaltyImpact": rng.uniform(0.4, 1.8),
        },
    }


def _mutate(overrides: dict[str, Any], rng: random.Random, mutation_rate: float) -> dict[str, Any]:
    child = copy.deepcopy(overrides)
    for regime in REGIMES:
        weights = child["allocation"]["weights"][regime]
        for bucket in BUCKETS:
            if rng.random() < mutation_rate:
                weights[bucket] = _clamp(weights[bucket] + rng.uniform(-0.12, 0.12), 0.02, 0.85)
        child["allocation"]["weights"][regime] = _normalize_weights(weights)

    overlay = child["riskOverlay"]
    if rng.random() < mutation_rate:
        overlay["highVolThreshold"] = _clamp(overlay["highVolThreshold"] + rng.uniform(-0.015, 0.015), 0.005, 0.30)
    if rng.random() < mutation_rate:
        overlay["extremeVolThreshold"] = _clamp(overlay["extremeVolThreshold"] + rng.uniform(-0.025, 0.025), 0.01, 0.50)
    if overlay["extremeVolThreshold"] <= overlay["highVolThreshold"]:
        overlay["extremeVolThreshold"] = min(0.50, overlay["highVolThreshold"] + 0.005)
    if rng.random() < mutation_rate:
        overlay["skipSizingCap"] = _clamp(overlay["skipSizingCap"] + rng.uniform(-0.08, 0.08), 0.10, 0.70)
    return child


def _crossover(left: dict[str, Any], right: dict[str, Any], rng: random.Random, crossover_rate: float) -> dict[str, Any]:
    if rng.random() > crossover_rate:
        return copy.deepcopy(left)
    child = copy.deepcopy(left)
    for regime in REGIMES:
        if rng.random() < 0.5:
            child["allocation"]["weights"][regime] = copy.deepcopy(right["allocation"]["weights"][regime])
    for key in child["riskOverlay"]:
        if key in right["riskOverlay"] and rng.random() < 0.5:
            child["riskOverlay"][key] = right["riskOverlay"][key]
    for key in child["scoring"]:
        if key in right["scoring"] and rng.random() < 0.5:
            child["scoring"][key] = right["scoring"][key]
    return child


def run_ga_optimizer(req: GAOptimizerRequest, *, evaluator: Evaluator | None = None) -> dict[str, Any]:
    population_size = max(6, min(int(req.population_size), 200))
    generations = max(1, min(int(req.generations), 50))
    elite_count = max(1, min(int(req.elite_count), population_size // 2))
    top_k = max(1, min(int(req.top_k), population_size))
    rng = random.Random(req.seed)

    population = [_random_overrides(rng) for _ in range(population_size)]
    best_generation: dict[str, Any] | None = None
    history: list[dict[str, Any]] = []

    for generation in range(generations):
        candidates = [
            build_ga_candidate(overrides, generation=generation, candidate_index=index)
            for index, overrides in enumerate(population)
        ]
        evaluated = evaluate_ga_population(
            candidates,
            evaluator=evaluator,
            plateau_tolerance=req.plateau_tolerance,
        )
        ranked = evaluated["ranked"]
        history.append({
            "generation": generation,
            "best_score": ranked[0]["score"] if ranked else None,
            "best_candidate_id": ranked[0]["candidate"]["id"] if ranked else None,
            "passed_count": sum(1 for row in ranked if row["gate"]["passed"]),
            "plateau_size": evaluated["plateau"]["plateau_size"] if evaluated["plateau"] else 0,
        })
        if best_generation is None or ranked[0]["score"] > best_generation["best"]["score"]:
            best_generation = evaluated

        elites = [row["candidate"]["alphaFramework"] for row in ranked[:elite_count]]
        next_population = []
        for elite in elites:
            next_population.append({
                "allocation": copy.deepcopy(elite["allocation"]),
                "riskOverlay": copy.deepcopy(elite["riskOverlay"]),
                "scoring": copy.deepcopy(elite.get("scoring", {})),
            })
        while len(next_population) < population_size:
            left = rng.choice(next_population)
            right = rng.choice(next_population)
            next_population.append(_mutate(_crossover(left, right, rng, req.crossover_rate), rng, req.mutation_rate))
        population = next_population[:population_size]

    ranked = (best_generation or {"ranked": []})["ranked"][:top_k]
    return {
        "status": "completed",
        "optimizer": "GAOptimizer",
        "population_size": population_size,
        "generations": generations,
        "history": history,
        "best": (best_generation or {}).get("best"),
        "ranked": ranked,
        "contract": {
            "source": "ga_optimizer",
            "layer": "meta_optimizer",
            "target": "meta_optimizer_learning_state",
            "applies_to_production": False,
            "push_target": "worker_kv_ga_optimizer_state",
            "effective_fields": [
                "alphaFramework.allocation.weights",
                "alphaFramework.riskOverlay",
                "alphaFramework.scoring",
            ],
            "learning_mode": "direct",
            "apply_gate": "walk_forward+pbo+transaction_cost_sensitivity",
        },
    }
