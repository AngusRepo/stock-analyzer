"""AlphaAgentEvo runtime for self-evolving alpha trajectories.

This is a production-safe research runner: it evolves alpha expressions over
historical rows, evaluates each offspring with realized next returns, updates a
lightweight policy state from reward feedback, and returns replacement evidence.
It does not mutate production config, train a live model, or place orders.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
import json
import math
import statistics
from typing import Any


SCHEMA_VERSION = "alpha-agent-evo-runtime-v1"
DEFAULT_FEATURE_CATALOG = [
    "score_v2",
    "ml_edge",
    "chip_flow",
    "technical_structure",
    "fundamental_quality",
    "news_theme",
    "confidence",
    "forecast_pct",
    "obv_temperature",
    "squeeze_momentum",
]
OPERATOR_ORDER = [
    "add_feature",
    "reweight_positive",
    "reweight_negative",
    "drop_feature",
    "crossover",
]


def _to_float(value: object, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _date(row: dict[str, Any]) -> str:
    return str(row.get("date") or "").strip()[:10]


def _candidate_id(value: object) -> str:
    return str(value or "").strip()


def _components(row: dict[str, Any]) -> dict[str, Any]:
    payload = _json_record(row.get("score_components"))
    components = payload.get("components")
    return components if isinstance(components, dict) else {}


def _score_v2(row: dict[str, Any]) -> float | None:
    payload = _json_record(row.get("score_components"))
    value = payload.get("finalScore", payload.get("total"))
    if value is None:
        value = row.get("score")
    return _to_float(value)


def _forecast_pct(row: dict[str, Any]) -> float | None:
    for key in ("forecast_pct", "ml_forecast_pct", "expected_return", "predicted_return"):
        value = row.get(key)
        if value is not None:
            return _to_float(value)
    forecast_data = _json_record(row.get("forecast_data"))
    for key in ("forecast_pct", "ml_forecast_pct", "expected_return", "predicted_return"):
        value = forecast_data.get(key)
        if value is not None:
            return _to_float(value)
    return None


def _alpha_context(row: dict[str, Any]) -> dict[str, Any]:
    return _json_record(row.get("alpha_context"))


def _feature_value(row: dict[str, Any], feature: str) -> float | None:
    feature = str(feature or "").strip()
    direct = _to_float(row.get(feature))
    if direct is not None:
        return direct

    components = _components(row)
    aliases = {
        "score_v2": ("finalScore", "total"),
        "ml_edge": ("mlEdge", "ml_edge"),
        "chip_flow": ("chipFlow", "chip_flow"),
        "technical_structure": ("technicalStructure", "technical_structure"),
        "fundamental_quality": ("fundamentalQuality", "fundamental_quality"),
        "news_theme": ("newsTheme", "news_theme"),
    }
    if feature == "score_v2":
        return _score_v2(row)
    if feature == "confidence":
        return _to_float(row.get("confidence"))
    if feature == "forecast_pct":
        return _forecast_pct(row)
    if feature in aliases:
        for key in aliases[feature]:
            value = components.get(key)
            if value is not None:
                return _to_float(value)

    context = _alpha_context(row)
    for key in (feature, feature.replace("_", "")):
        value = context.get(key)
        if value is not None:
            return _to_float(value)
    return None


def _normalize_terms(terms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weights: dict[str, float] = defaultdict(float)
    for term in terms or []:
        feature = str(term.get("feature") or "").strip()
        weight = _to_float(term.get("weight"), 0.0) or 0.0
        if feature and abs(weight) > 1e-9:
            weights[feature] += weight
    if not weights:
        weights["score_v2"] = 1.0
    total = sum(abs(value) for value in weights.values()) or 1.0
    normalized = [
        {"feature": feature, "weight": round(weight / total, 6)}
        for feature, weight in sorted(weights.items())
        if abs(weight) > 1e-9
    ]
    return sorted(normalized, key=lambda item: (-abs(float(item["weight"])), item["feature"]))


def _expression_text(terms: list[dict[str, Any]]) -> str:
    parts = []
    for term in _normalize_terms(terms):
        weight = float(term["weight"])
        feature = str(term["feature"])
        sign = "+" if weight >= 0 else "-"
        parts.append(f"{sign}{abs(weight):.3f}*rank({feature})")
    text = " ".join(parts).strip()
    return text[1:] if text.startswith("+") else text


def _seed_candidates(seed_expressions: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    seeds = seed_expressions or [
        {"candidate_id": "seed-score-v2", "terms": [{"feature": "score_v2", "weight": 1.0}]},
        {"candidate_id": "seed-ml-edge", "terms": [{"feature": "ml_edge", "weight": 1.0}]},
    ]
    out: list[dict[str, Any]] = []
    for idx, seed in enumerate(seeds):
        terms = _normalize_terms(seed.get("terms") if isinstance(seed.get("terms"), list) else [])
        candidate_id = _candidate_id(seed.get("candidate_id")) or f"seed-{idx + 1}"
        out.append({
            "candidate_id": candidate_id,
            "generation": 0,
            "operator": "seed",
            "parent_ids": [],
            "terms": terms,
            "expression": str(seed.get("expression") or _expression_text(terms)),
        })
    return out


def _attach_realized_returns(
    recommendation_rows: list[dict[str, Any]],
    price_rows: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    rows = [dict(row) for row in recommendation_rows]
    if any(_to_float(row.get("realized_return")) is not None for row in rows):
        return rows
    if not price_rows:
        return rows

    panel: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for row in price_rows:
        symbol = _symbol(row)
        date = _date(row)
        close = _to_float(row.get("close"))
        if symbol and date and close is not None and close > 0:
            panel[symbol].append((date, close))
    for symbol in panel:
        panel[symbol] = sorted(panel[symbol], key=lambda item: item[0])

    def next_return(symbol: str, date: str) -> float | None:
        prices = panel.get(symbol, [])
        current = next((close for dt, close in reversed(prices) if dt <= date), None)
        future = next((close for dt, close in prices if dt > date), None)
        if current is None or future is None or current <= 0:
            return None
        return (future - current) / current

    for row in rows:
        realized = next_return(_symbol(row), _date(row))
        if realized is not None:
            row["realized_return"] = realized
    return rows


def _rank_percentiles(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values.items(), key=lambda item: (item[1], item[0]))
    if len(ordered) == 1:
        return {ordered[0][0]: 1.0}
    return {
        symbol: idx / (len(ordered) - 1)
        for idx, (symbol, _) in enumerate(ordered)
    }


def _daily_expression_scores(rows: list[dict[str, Any]], terms: list[dict[str, Any]]) -> dict[str, float]:
    feature_ranks: dict[str, dict[str, float]] = {}
    for term in terms:
        feature = str(term.get("feature") or "")
        raw_values = {
            _symbol(row): value
            for row in rows
            if _symbol(row) and (value := _feature_value(row, feature)) is not None
        }
        feature_ranks[feature] = _rank_percentiles(raw_values)

    scores: dict[str, float] = {}
    for row in rows:
        symbol = _symbol(row)
        if not symbol:
            continue
        score = 0.0
        for term in terms:
            feature = str(term.get("feature") or "")
            weight = _to_float(term.get("weight"), 0.0) or 0.0
            score += weight * feature_ranks.get(feature, {}).get(symbol, 0.5)
        scores[symbol] = score
    return scores


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    mean_x = statistics.mean(xs)
    mean_y = statistics.mean(ys)
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den_x = math.sqrt(sum((x - mean_x) ** 2 for x in xs))
    den_y = math.sqrt(sum((y - mean_y) ** 2 for y in ys))
    if den_x <= 0 or den_y <= 0:
        return None
    return num / (den_x * den_y)


def _portfolio_metrics(returns: list[float]) -> dict[str, Any]:
    if not returns:
        return {
            "evaluation_days": 0,
            "avg_return": None,
            "cum_return": None,
            "hit_rate": None,
            "volatility": None,
            "sharpe": None,
            "max_drawdown": None,
        }
    mean_return = statistics.mean(returns)
    volatility = statistics.stdev(returns) if len(returns) >= 2 else 0.0
    sharpe = (mean_return / volatility) * math.sqrt(252) if volatility > 0 else None
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in returns:
        equity *= 1.0 + value
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)
    return {
        "evaluation_days": len(returns),
        "avg_return": round(mean_return, 8),
        "cum_return": round(math.prod(1.0 + value for value in returns) - 1.0, 8),
        "hit_rate": round(sum(1 for value in returns if value > 0) / len(returns), 8),
        "volatility": round(volatility, 8),
        "sharpe": round(sharpe, 6) if sharpe is not None else None,
        "max_drawdown": round(max_drawdown, 8),
    }


def _evaluate_candidate(
    candidate: dict[str, Any],
    rows_by_date: dict[str, list[dict[str, Any]]],
    *,
    top_k: int,
) -> dict[str, Any]:
    terms = _normalize_terms(candidate.get("terms") if isinstance(candidate.get("terms"), list) else [])
    daily_returns: list[float] = []
    daily_ic: list[float] = []
    selected_by_date: dict[str, list[str]] = {}

    for date in sorted(rows_by_date):
        rows = [
            row for row in rows_by_date[date]
            if _symbol(row) and _to_float(row.get("realized_return")) is not None
        ]
        if len(rows) < max(1, top_k):
            continue
        scores = _daily_expression_scores(rows, terms)
        ranked = sorted(rows, key=lambda row: scores.get(_symbol(row), -999.0), reverse=True)
        selected = ranked[: max(1, top_k)]
        returns = [_to_float(row.get("realized_return"), 0.0) or 0.0 for row in selected]
        daily_returns.append(sum(returns) / len(returns))
        selected_by_date[date] = [_symbol(row) for row in selected]

        ic_rows = [
            (scores.get(_symbol(row)), _to_float(row.get("realized_return")))
            for row in rows
        ]
        xs = [float(score) for score, ret in ic_rows if score is not None and ret is not None]
        ys = [float(ret) for score, ret in ic_rows if score is not None and ret is not None]
        corr = _pearson(xs, ys)
        if corr is not None:
            daily_ic.append(corr)

    metrics = _portfolio_metrics(daily_returns)
    metrics["mean_ic"] = round(statistics.mean(daily_ic), 8) if daily_ic else None
    metrics["ic_days"] = len(daily_ic)
    metrics["selected_by_date_sample"] = dict(list(selected_by_date.items())[:5])
    return metrics


def _similarity(left_terms: list[dict[str, Any]], right_terms: list[dict[str, Any]]) -> float:
    left = {str(term["feature"]): float(term["weight"]) for term in _normalize_terms(left_terms)}
    right = {str(term["feature"]): float(term["weight"]) for term in _normalize_terms(right_terms)}
    features = set(left) | set(right)
    if not features:
        return 1.0
    overlap = len(set(left) & set(right)) / len(features)
    distance = sum(abs(left.get(feature, 0.0) - right.get(feature, 0.0)) for feature in features)
    scale = sum(abs(left.get(feature, 0.0)) + abs(right.get(feature, 0.0)) for feature in features) or 1.0
    weight_similarity = max(0.0, 1.0 - distance / scale)
    return round(0.7 * overlap + 0.3 * weight_similarity, 8)


def _reward_components(
    candidate: dict[str, Any],
    *,
    parent: dict[str, Any] | None,
    baseline: dict[str, Any],
    seen_terms: list[list[dict[str, Any]]],
    min_evaluation_days: int,
) -> tuple[dict[str, float], list[str]]:
    metrics = candidate.get("metrics") if isinstance(candidate.get("metrics"), dict) else {}
    parent_metrics = parent.get("metrics") if parent and isinstance(parent.get("metrics"), dict) else {}
    baseline_metrics = baseline.get("metrics") if isinstance(baseline.get("metrics"), dict) else {}
    blockers: list[str] = []

    evaluation_days = _to_int(metrics.get("evaluation_days"))
    sharpe = _to_float(metrics.get("sharpe"), 0.0) or 0.0
    avg_return = _to_float(metrics.get("avg_return"), 0.0) or 0.0
    max_drawdown = _to_float(metrics.get("max_drawdown"), 0.0) or 0.0
    mean_ic = _to_float(metrics.get("mean_ic"), 0.0) or 0.0
    parent_sharpe = _to_float(parent_metrics.get("sharpe"), 0.0) or 0.0
    baseline_sharpe = _to_float(baseline_metrics.get("sharpe"), 0.0) or 0.0
    baseline_avg_return = _to_float(baseline_metrics.get("avg_return"), 0.0) or 0.0

    if evaluation_days < min_evaluation_days:
        blockers.append("evaluation_days_insufficient")
    if metrics.get("sharpe") is None:
        blockers.append("sharpe_missing")

    max_similarity = max((_similarity(candidate.get("terms", []), terms) for terms in seen_terms), default=0.0)
    validity = 1.0 if not blockers else -1.0
    performance = max(-2.0, min(2.0, sharpe / 3.0 + avg_return * 25.0 - max_drawdown * 2.0))
    improvement = max(-1.0, min(1.0, (sharpe - parent_sharpe) / 3.0 + (avg_return - baseline_avg_return) * 20.0))
    direction = max(-1.0, min(1.0, mean_ic))
    exploration = 1.0 - max_similarity
    if max_similarity > 0.985 and candidate.get("operator") != "seed":
        blockers.append("duplicate_expression")
        exploration -= 0.5
    streak = 0.25 if sharpe > parent_sharpe and sharpe > baseline_sharpe else 0.0

    components = {
        "validity": round(validity, 6),
        "performance": round(performance, 6),
        "improvement": round(improvement, 6),
        "direction": round(direction, 6),
        "exploration": round(exploration, 6),
        "streak": round(streak, 6),
    }
    return components, blockers


def _total_reward(components: dict[str, float]) -> float:
    weights = {
        "validity": 0.15,
        "performance": 0.35,
        "improvement": 0.25,
        "direction": 0.10,
        "exploration": 0.10,
        "streak": 0.05,
    }
    return round(sum(components.get(key, 0.0) * weight for key, weight in weights.items()), 8)


def _features(terms: list[dict[str, Any]]) -> set[str]:
    return {str(term.get("feature") or "") for term in terms if str(term.get("feature") or "")}


def _choose_feature(
    terms: list[dict[str, Any]],
    feature_catalog: list[str],
    feature_weights: dict[str, float],
) -> str:
    used = _features(terms)
    candidates = [feature for feature in feature_catalog if feature not in used]
    if not candidates:
        candidates = list(feature_catalog)
    return sorted(candidates, key=lambda feature: (-feature_weights.get(feature, 1.0), feature))[0]


def _child(
    *,
    parent: dict[str, Any],
    generation: int,
    operator: str,
    index: int,
    terms: list[dict[str, Any]],
    extra_parent_id: str | None = None,
) -> dict[str, Any]:
    parent_id = _candidate_id(parent.get("candidate_id"))
    parent_ids = [parent_id]
    if extra_parent_id and extra_parent_id != parent_id:
        parent_ids.append(extra_parent_id)
    normalized = _normalize_terms(terms)
    return {
        "candidate_id": f"{parent_id}:g{generation}:{operator}:{index}",
        "generation": generation,
        "operator": operator,
        "parent_ids": parent_ids,
        "terms": normalized,
        "expression": _expression_text(normalized),
    }


def _generate_offspring(
    parent: dict[str, Any],
    *,
    generation: int,
    offspring_per_parent: int,
    feature_catalog: list[str],
    policy_state: dict[str, Any],
    elite_pool: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    terms = _normalize_terms(parent.get("terms") if isinstance(parent.get("terms"), list) else [])
    feature_weights = policy_state.get("feature_weights") if isinstance(policy_state.get("feature_weights"), dict) else {}
    operator_weights = policy_state.get("operator_weights") if isinstance(policy_state.get("operator_weights"), dict) else {}
    operators = sorted(OPERATOR_ORDER, key=lambda op: (-operator_weights.get(op, 1.0), OPERATOR_ORDER.index(op)))
    out: list[dict[str, Any]] = []

    for idx in range(max(1, int(offspring_per_parent))):
        operator = operators[idx % len(operators)]
        new_terms = [dict(term) for term in terms]
        extra_parent_id = None
        if operator == "add_feature":
            feature = _choose_feature(new_terms, feature_catalog, feature_weights)
            new_terms = [{"feature": term["feature"], "weight": float(term["weight"]) * 0.40} for term in new_terms]
            new_terms.append({"feature": feature, "weight": 0.60})
        elif operator == "reweight_positive":
            feature = sorted(_features(new_terms), key=lambda item: (-feature_weights.get(item, 1.0), item))[0]
            for term in new_terms:
                if term["feature"] == feature:
                    term["weight"] = float(term["weight"]) * 1.35
        elif operator == "reweight_negative":
            feature = sorted(_features(new_terms), key=lambda item: (feature_weights.get(item, 1.0), item))[0]
            for term in new_terms:
                if term["feature"] == feature:
                    term["weight"] = float(term["weight"]) * 0.65
        elif operator == "drop_feature" and len(new_terms) > 1:
            drop = sorted(new_terms, key=lambda term: (abs(float(term["weight"])), str(term["feature"])))[0]["feature"]
            new_terms = [term for term in new_terms if term["feature"] != drop]
        elif operator == "crossover" and elite_pool:
            mate = next((row for row in elite_pool if row.get("candidate_id") != parent.get("candidate_id")), None)
            if mate:
                extra_parent_id = _candidate_id(mate.get("candidate_id"))
                new_terms = [
                    {"feature": term["feature"], "weight": float(term["weight"]) * 0.55}
                    for term in new_terms
                ] + [
                    {"feature": term["feature"], "weight": float(term["weight"]) * 0.45}
                    for term in _normalize_terms(mate.get("terms") if isinstance(mate.get("terms"), list) else [])
                ]
            else:
                feature = _choose_feature(new_terms, feature_catalog, feature_weights)
                new_terms.append({"feature": feature, "weight": 0.20})
        else:
            feature = _choose_feature(new_terms, feature_catalog, feature_weights)
            new_terms.append({"feature": feature, "weight": 0.20})

        out.append(_child(
            parent=parent,
            generation=generation,
            operator=operator,
            index=idx + 1,
            terms=new_terms,
            extra_parent_id=extra_parent_id,
        ))
    return out


def _update_policy(policy_state: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    operator_weights = dict(policy_state.get("operator_weights") or {})
    feature_weights = dict(policy_state.get("feature_weights") or {})
    for candidate in candidates:
        reward = _to_float(candidate.get("reward"), 0.0) or 0.0
        operator = str(candidate.get("operator") or "unknown")
        if operator != "seed":
            operator_weights[operator] = max(0.25, operator_weights.get(operator, 1.0) + reward * 0.12)
        for feature in _features(candidate.get("terms", [])):
            feature_weights[feature] = max(0.25, feature_weights.get(feature, 1.0) + reward * 0.08)
    return {
        "operator_weights": {key: round(value, 6) for key, value in sorted(operator_weights.items())},
        "feature_weights": {key: round(value, 6) for key, value in sorted(feature_weights.items())},
    }


def _sort_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        candidates,
        key=lambda row: (
            _to_float(row.get("reward"), -999.0) or -999.0,
            _to_float((row.get("metrics") or {}).get("sharpe"), -999.0) or -999.0,
            _to_float((row.get("metrics") or {}).get("avg_return"), -999.0) or -999.0,
        ),
        reverse=True,
    )


def _evolution_path(candidate_id: str, by_id: dict[str, dict[str, Any]]) -> list[str]:
    candidate = by_id.get(candidate_id)
    if not candidate:
        return [candidate_id]
    parent_ids = candidate.get("parent_ids") if isinstance(candidate.get("parent_ids"), list) else []
    if not parent_ids:
        return [candidate_id]
    primary_parent = _candidate_id(parent_ids[0])
    return _evolution_path(primary_parent, by_id) + [candidate_id]


def _decision(
    *,
    baseline: dict[str, Any],
    champion: dict[str, Any],
    min_evaluation_days: int,
    min_sharpe_delta: float,
    max_mdd_delta: float,
) -> dict[str, Any]:
    baseline_metrics = baseline.get("metrics") if isinstance(baseline.get("metrics"), dict) else {}
    champion_metrics = champion.get("metrics") if isinstance(champion.get("metrics"), dict) else {}
    sharpe_delta = None
    if baseline_metrics.get("sharpe") is not None and champion_metrics.get("sharpe") is not None:
        sharpe_delta = round(float(champion_metrics["sharpe"]) - float(baseline_metrics["sharpe"]), 8)
    avg_return_delta = None
    if baseline_metrics.get("avg_return") is not None and champion_metrics.get("avg_return") is not None:
        avg_return_delta = round(float(champion_metrics["avg_return"]) - float(baseline_metrics["avg_return"]), 8)
    max_drawdown_delta = None
    if baseline_metrics.get("max_drawdown") is not None and champion_metrics.get("max_drawdown") is not None:
        max_drawdown_delta = round(float(champion_metrics["max_drawdown"]) - float(baseline_metrics["max_drawdown"]), 8)

    blockers = []
    if champion.get("candidate_id") == baseline.get("candidate_id"):
        blockers.append("champion_is_baseline")
    if _to_int(champion_metrics.get("evaluation_days")) < min_evaluation_days:
        blockers.append("evaluation_days_insufficient")
    if sharpe_delta is None or sharpe_delta < min_sharpe_delta:
        blockers.append("champion_does_not_improve_sharpe")
    if avg_return_delta is None or avg_return_delta <= 0:
        blockers.append("champion_does_not_improve_avg_return")
    if max_drawdown_delta is None or max_drawdown_delta > max_mdd_delta:
        blockers.append("champion_drawdown_not_better_or_within_gate")

    return {
        "eligible_to_replace_baseline": not blockers,
        "accelerated_historical_replacement_allowed": not blockers,
        "production_mutation_allowed": False,
        "baseline_id": baseline.get("candidate_id"),
        "champion_id": champion.get("candidate_id"),
        "sharpe_delta": sharpe_delta,
        "avg_return_delta": avg_return_delta,
        "max_drawdown_delta": max_drawdown_delta,
        "min_evaluation_days": min_evaluation_days,
        "min_sharpe_delta": min_sharpe_delta,
        "max_mdd_delta": max_mdd_delta,
        "blockers": blockers,
    }


def run_alpha_agent_evo_evolution(
    *,
    recommendation_rows: list[dict[str, Any]],
    price_rows: list[dict[str, Any]] | None = None,
    seed_expressions: list[dict[str, Any]] | None = None,
    feature_catalog: list[str] | None = None,
    generations: int = 3,
    offspring_per_parent: int = 4,
    survivors_per_generation: int = 3,
    top_k: int = 3,
    min_evaluation_days: int = 20,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
) -> dict[str, Any]:
    """Run a full self-evolving alpha trajectory over supplied historical rows."""
    rows = _attach_realized_returns(recommendation_rows, price_rows)
    rows_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if _date(row) and _symbol(row) and _to_float(row.get("realized_return")) is not None:
            rows_by_date[_date(row)].append(row)

    feature_catalog = [
        str(feature).strip()
        for feature in (feature_catalog or DEFAULT_FEATURE_CATALOG)
        if str(feature).strip()
    ]
    top_k = max(1, int(top_k))
    generations = max(1, int(generations))
    offspring_per_parent = max(1, int(offspring_per_parent))
    survivors_per_generation = max(1, int(survivors_per_generation))

    policy_state = {
        "operator_weights": {operator: 1.0 for operator in OPERATOR_ORDER},
        "feature_weights": {feature: 1.0 for feature in feature_catalog},
    }
    all_candidates: list[dict[str, Any]] = []
    replay_entries: list[dict[str, Any]] = []
    trajectory: list[dict[str, Any]] = []
    seen_terms: list[list[dict[str, Any]]] = []

    seeds = _seed_candidates(seed_expressions)
    for seed in seeds:
        seed["metrics"] = _evaluate_candidate(seed, rows_by_date, top_k=top_k)
        seed["reward_components"], seed["blockers"] = _reward_components(
            seed,
            parent=None,
            baseline=seed,
            seen_terms=seen_terms,
            min_evaluation_days=min_evaluation_days,
        )
        seed["reward"] = _total_reward(seed["reward_components"])
        seen_terms.append(seed["terms"])
        all_candidates.append(seed)
        replay_entries.append({
            "candidate_id": seed["candidate_id"],
            "generation": 0,
            "operator": "seed",
            "reward": seed["reward"],
            "reward_components": seed["reward_components"],
        })

    baseline = seeds[0] if seeds else {
        "candidate_id": "missing-baseline",
        "terms": [{"feature": "score_v2", "weight": 1.0}],
        "metrics": _portfolio_metrics([]),
        "reward": -999.0,
    }
    parents = _sort_candidates(seeds)[:survivors_per_generation]
    trajectory.append({
        "generation": 0,
        "parents": [],
        "offspring": [seed["candidate_id"] for seed in seeds],
        "champion_after_generation": _sort_candidates(all_candidates)[0]["candidate_id"] if all_candidates else None,
        "policy_state": policy_state,
    })

    by_id = {candidate["candidate_id"]: candidate for candidate in all_candidates}
    for generation in range(1, generations):
        offspring: list[dict[str, Any]] = []
        elite_pool = _sort_candidates(all_candidates)[:survivors_per_generation]
        for parent in parents:
            offspring.extend(_generate_offspring(
                parent,
                generation=generation,
                offspring_per_parent=offspring_per_parent,
                feature_catalog=feature_catalog,
                policy_state=policy_state,
                elite_pool=elite_pool,
            ))

        for candidate in offspring:
            parent = by_id.get(_candidate_id((candidate.get("parent_ids") or [None])[0]))
            candidate["metrics"] = _evaluate_candidate(candidate, rows_by_date, top_k=top_k)
            candidate["reward_components"], candidate["blockers"] = _reward_components(
                candidate,
                parent=parent,
                baseline=baseline,
                seen_terms=seen_terms,
                min_evaluation_days=min_evaluation_days,
            )
            candidate["reward"] = _total_reward(candidate["reward_components"])
            seen_terms.append(candidate["terms"])
            all_candidates.append(candidate)
            by_id[candidate["candidate_id"]] = candidate
            replay_entries.append({
                "candidate_id": candidate["candidate_id"],
                "generation": generation,
                "operator": candidate["operator"],
                "parent_ids": candidate["parent_ids"],
                "reward": candidate["reward"],
                "reward_components": candidate["reward_components"],
                "metrics": {
                    "sharpe": candidate["metrics"].get("sharpe"),
                    "avg_return": candidate["metrics"].get("avg_return"),
                    "max_drawdown": candidate["metrics"].get("max_drawdown"),
                    "mean_ic": candidate["metrics"].get("mean_ic"),
                },
            })

        policy_state = _update_policy(policy_state, offspring)
        parents = _sort_candidates(offspring)[:survivors_per_generation] or parents
        trajectory.append({
            "generation": generation,
            "parents": [_candidate_id(parent.get("candidate_id")) for parent in parents],
            "offspring": [_candidate_id(candidate.get("candidate_id")) for candidate in offspring],
            "champion_after_generation": _sort_candidates(all_candidates)[0]["candidate_id"] if all_candidates else None,
            "policy_state": policy_state,
        })

    champion = _sort_candidates(all_candidates)[0] if all_candidates else baseline
    by_id = {candidate["candidate_id"]: candidate for candidate in all_candidates}
    compact_candidates = []
    for candidate in _sort_candidates(all_candidates):
        compact_candidates.append({
            "candidate_id": candidate["candidate_id"],
            "generation": candidate["generation"],
            "operator": candidate["operator"],
            "parent_ids": candidate.get("parent_ids", []),
            "evolution_path": _evolution_path(candidate["candidate_id"], by_id),
            "expression": candidate["expression"],
            "terms": candidate["terms"],
            "metrics": candidate["metrics"],
            "reward": candidate["reward"],
            "reward_components": candidate["reward_components"],
            "blockers": candidate.get("blockers", []),
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "research_evidence",
        "production_mutation_allowed": False,
        "data_window": {
            "dates": sorted(rows_by_date),
            "evaluation_days": len(rows_by_date),
            "recommendation_rows": len(recommendation_rows),
            "rows_with_realized_return": sum(len(value) for value in rows_by_date.values()),
        },
        "config": {
            "generations": generations,
            "offspring_per_parent": offspring_per_parent,
            "survivors_per_generation": survivors_per_generation,
            "top_k": top_k,
            "feature_catalog": feature_catalog,
        },
        "baseline": {
            "candidate_id": baseline["candidate_id"],
            "expression": baseline["expression"],
            "metrics": baseline["metrics"],
            "reward": baseline["reward"],
        },
        "champion": {
            "candidate_id": champion["candidate_id"],
            "generation": champion["generation"],
            "operator": champion["operator"],
            "parent_ids": champion.get("parent_ids", []),
            "evolution_path": _evolution_path(champion["candidate_id"], by_id),
            "expression": champion["expression"],
            "terms": champion["terms"],
            "metrics": champion["metrics"],
            "reward": champion["reward"],
            "reward_components": champion["reward_components"],
        },
        "trajectory": trajectory,
        "candidate_pool": compact_candidates[:50],
        "replay_buffer": {
            "size": len(replay_entries),
            "top_rewards": _sort_candidates([
                {
                    "candidate_id": entry["candidate_id"],
                    "reward": entry["reward"],
                    "metrics": entry.get("metrics", {}),
                    "operator": entry.get("operator"),
                }
                for entry in replay_entries
            ])[:10],
            "entries_sample": replay_entries[-10:],
        },
        "policy_state": policy_state,
        "decision": _decision(
            baseline=baseline,
            champion=champion,
            min_evaluation_days=min_evaluation_days,
            min_sharpe_delta=min_sharpe_delta,
            max_mdd_delta=max_mdd_delta,
        ),
    }


def _start_for_price_window(start_date: str, lookback_days: int) -> str:
    return (
        datetime.fromisoformat(start_date[:10])
        - timedelta(days=max(lookback_days * 3, lookback_days + 30))
    ).strftime("%Y-%m-%d")


def _chunked_symbol_price_rows(symbols: list[str], start_date: str, end_date: str) -> list[dict[str, Any]]:
    from services import d1_client

    rows: list[dict[str, Any]] = []
    for idx in range(0, len(symbols), 80):
        chunk = symbols[idx: idx + 80]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(d1_client.query(
            f"""
            SELECT s.symbol, sp.date, sp.close
              FROM stock_prices sp
              JOIN stocks s ON s.id = sp.stock_id
             WHERE s.symbol IN ({placeholders})
               AND sp.date BETWEEN ? AND ?
             ORDER BY s.symbol, sp.date
            """,
            [*chunk, start_date, end_date],
            timeout=120,
        ))
    return rows


def load_alpha_agent_evo_historical_inputs(
    *,
    start_date: str,
    end_date: str,
    lookback_days: int = 60,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from services import d1_client

    recommendation_rows = d1_client.query(
        """
        SELECT dr.date, dr.symbol, dr.rank, dr.score, dr.confidence, dr.signal,
               dr.has_buy_signal, dr.score_components, dr.alpha_context,
               p.forecast_data
          FROM daily_recommendations dr
          LEFT JOIN stocks s ON s.symbol = dr.symbol
          LEFT JOIN predictions p ON p.id = (
            SELECT p2.id
              FROM predictions p2
             WHERE p2.stock_id = s.id
               AND p2.model_name = 'ensemble'
               AND p2.prediction_date = dr.date
             ORDER BY p2.generated_at DESC, p2.id DESC
             LIMIT 1
          )
         WHERE dr.date BETWEEN ? AND ?
         ORDER BY dr.date, dr.rank
        """,
        [start_date, end_date],
        timeout=120,
    )
    symbols = sorted({_symbol(row) for row in recommendation_rows if _symbol(row)})
    price_rows = _chunked_symbol_price_rows(
        symbols,
        _start_for_price_window(start_date, lookback_days),
        (datetime.fromisoformat(end_date[:10]) + timedelta(days=14)).strftime("%Y-%m-%d"),
    )
    return recommendation_rows, price_rows


def run_alpha_agent_evo_historical_evolution(
    *,
    start_date: str,
    end_date: str,
    seed_expressions: list[dict[str, Any]] | None = None,
    feature_catalog: list[str] | None = None,
    generations: int = 3,
    offspring_per_parent: int = 4,
    survivors_per_generation: int = 3,
    top_k: int = 3,
    lookback_days: int = 60,
    min_evaluation_days: int = 20,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
) -> dict[str, Any]:
    recommendation_rows, price_rows = load_alpha_agent_evo_historical_inputs(
        start_date=start_date,
        end_date=end_date,
        lookback_days=lookback_days,
    )
    report = run_alpha_agent_evo_evolution(
        recommendation_rows=recommendation_rows,
        price_rows=price_rows,
        seed_expressions=seed_expressions,
        feature_catalog=feature_catalog,
        generations=generations,
        offspring_per_parent=offspring_per_parent,
        survivors_per_generation=survivors_per_generation,
        top_k=top_k,
        min_evaluation_days=min_evaluation_days,
        min_sharpe_delta=min_sharpe_delta,
        max_mdd_delta=max_mdd_delta,
    )
    report["historical_loader"] = {
        "start_date": start_date,
        "end_date": end_date,
        "lookback_days": lookback_days,
    }
    return report


def apply_alpha_agent_evo_production_selection(
    recommendations: list[dict[str, Any]],
    evolution_report: dict[str, Any],
    *,
    top_k: int = 3,
    confidence_floor: float = 0.72,
    enforce_buy_signal_owner: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply an evolved champion expression to the current recommendation slate.

    AlphaAgentEvo owns alpha selection here: it scores the current candidate
    slate, promotes the topK rows to BUY, and records lineage/evidence into
    alpha_context. A downstream portfolio optimizer may still own final weights.
    """
    if not recommendations:
        return recommendations, {"status": "skipped", "reason": "empty_recommendations"}
    champion = evolution_report.get("champion") if isinstance(evolution_report, dict) else {}
    terms = champion.get("terms") if isinstance(champion, dict) and isinstance(champion.get("terms"), list) else []
    if not terms:
        return recommendations, {"status": "skipped", "reason": "missing_champion_terms"}

    top_k = max(1, int(top_k))
    scores = _daily_expression_scores(recommendations, terms)
    ranked_symbols = sorted(scores, key=lambda symbol: scores[symbol], reverse=True)
    selected_symbols = set(ranked_symbols[:top_k])
    selected_order = {symbol: idx + 1 for idx, symbol in enumerate(ranked_symbols[:top_k])}
    min_score = min(scores.values()) if scores else 0.0
    max_score = max(scores.values()) if scores else 1.0
    span = max(1e-9, max_score - min_score)

    selected: list[dict[str, Any]] = []
    tail: list[dict[str, Any]] = []
    for row in recommendations:
        symbol = _symbol(row)
        raw_score = float(scores.get(symbol, 0.0))
        normalized_score = (raw_score - min_score) / span
        alpha_score = round(normalized_score * 100.0, 6)
        row["alpha_agent_evo_score"] = alpha_score
        row["expected_return"] = max(0.0, (alpha_score - 50.0) / 5000.0)
        alpha_context = dict(row.get("alpha_context") or {})
        alpha_context["alpha_agent_evo"] = {
            "owner": "alpha_agent_evo",
            "selected": symbol in selected_symbols,
            "selection_rank": selected_order.get(symbol),
            "score": alpha_score,
            "raw_score": round(raw_score, 8),
            "champion_id": champion.get("candidate_id"),
            "champion_generation": champion.get("generation"),
            "champion_operator": champion.get("operator"),
            "expression": champion.get("expression"),
            "evolution_path": champion.get("evolution_path"),
            "metrics": champion.get("metrics"),
            "decision": (evolution_report.get("decision") or {}) if isinstance(evolution_report, dict) else {},
        }
        row["alpha_context"] = alpha_context

        allocation = dict(row.get("alpha_allocation") or {})
        allocation["alpha_selection_owner"] = "alpha_agent_evo"
        allocation["alpha_agent_evo_score"] = alpha_score
        allocation["alpha_agent_evo_rank"] = selected_order.get(symbol)
        row["alpha_allocation"] = allocation

        if symbol in selected_symbols:
            row["allocation_replaced_signal"] = {
                "signal": row.get("signal"),
                "signal_source": row.get("signal_source"),
                "has_buy_signal": row.get("has_buy_signal"),
            }
            row["signal"] = "BUY"
            row["signal_source"] = "alpha_agent_evo"
            row["has_buy_signal"] = 1
            row["confidence"] = max(_to_float(row.get("confidence"), 0.0) or 0.0, float(confidence_floor))
            row["rank"] = selected_order[symbol]
            selected.append(row)
        else:
            if enforce_buy_signal_owner:
                row["has_buy_signal"] = 0
            tail.append(row)

    selected = sorted(selected, key=lambda row: selected_order.get(_symbol(row), 999))
    tail = sorted(tail, key=lambda row: float(row.get("alpha_agent_evo_score") or 0.0), reverse=True)
    for idx, row in enumerate(tail, start=len(selected) + 1):
        row["rank"] = idx
    return selected + tail, {
        "status": "production_owner_applied",
        "owner": "alpha_agent_evo",
        "champion_id": champion.get("candidate_id"),
        "expression": champion.get("expression"),
        "selected_symbols": list(selected_order),
        "top_k": top_k,
        "enforce_buy_signal_owner": enforce_buy_signal_owner,
        "historical_evaluation_days": ((evolution_report.get("data_window") or {}).get("evaluation_days") if isinstance(evolution_report, dict) else None),
    }
