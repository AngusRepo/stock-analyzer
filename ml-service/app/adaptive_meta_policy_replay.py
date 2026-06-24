"""Read-only walk-forward replay for adaptive meta-policy selection.

The replay compares LinUCB, NeuralUCB, NeuralTS and NeuCB on the same
historical family-ranking decision surface. It does not write D1/GCS state and
must not be used as a production promotion by itself.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import numpy as np

from .neural_meta_bandit import NeuralMetaBanditConfig, train_neural_meta_bandit


SCHEMA_VERSION = "adaptive-meta-policy-replay-v1"
ALLOCATOR_CANDIDATE_SCHEMA_VERSION = "allocator-policy-candidate-v1"
CONTEXT_VERSION = "meta-context-v2-python"
ARM_NAMES = (
    "tree_family",
    "tabular_neural_family",
    "graph_family",
    "time_series_family",
    "do_nothing",
)
ACTIVE_MODEL_TO_ARM = {
    "lightgbm": "tree_family",
    "xgboost": "tree_family",
    "extratrees": "tree_family",
    "extra_trees": "tree_family",
    "tabm": "tabular_neural_family",
    "gnn": "graph_family",
    "dlinear": "time_series_family",
    "patchtst": "time_series_family",
    "itransformer": "time_series_family",
}
ARM_TO_ACTIVE_MODELS = {
    "tree_family": ("LightGBM", "XGBoost", "ExtraTrees"),
    "tabular_neural_family": ("TabM",),
    "graph_family": ("GNN",),
    "time_series_family": ("DLinear", "PatchTST", "iTransformer"),
}
ALLOCATOR_POLICY_CAP = 0.15
CONTEXT_FEATURES = (
    "model_ic",
    "coverage",
    "prediction_dispersion",
    "data_quality",
    "market_breadth",
    "sector_heat",
    "liquidity",
    "fill_quality",
    "regime",
    "volatility",
    "market_risk",
    "bias",
)
NEUTRAL_CONTEXT = {
    "model_ic": 0.5,
    "coverage": 0.5,
    "prediction_dispersion": 0.5,
    "data_quality": 0.5,
    "market_breadth": 0.5,
    "sector_heat": 0.5,
    "liquidity": 0.5,
    "fill_quality": 0.5,
    "regime": 0.5,
    "volatility": 0.5,
    "market_risk": 0.5,
    "bias": 1.0,
}


@dataclass(frozen=True)
class FamilyReward:
    reward: float
    ic: float | None
    hit_rate: float | None
    pnl_mean: float | None
    n_symbols: int
    n_rank_pairs: int
    n_directional: int
    score_source: str


@dataclass(frozen=True)
class ReplaySample:
    date: str
    context: np.ndarray
    arm_rewards: dict[str, FamilyReward]


@dataclass(frozen=True)
class ReplayConfig:
    min_ic_samples: int = 5
    min_windows: int = 8
    neural_epochs: int = 80
    neural_min_train_multiplier: int = 2
    linucb_alpha: float = 0.35
    seed: int = 42


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _nested(record: dict[str, Any], path: str) -> Any:
    cur: Any = record
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _pct_decimal(value: Any) -> float | None:
    n = _float(value)
    if n is None:
        return None
    return n / 100.0 if abs(n) > 1.0 else n


def _normalize_signed(value: Any) -> float | None:
    n = _float(value)
    if n is None:
        return None
    return _clamp((n + 1.0) / 2.0, 0.0, 1.0)


def _normalize01(value: Any) -> float | None:
    n = _float(value)
    return None if n is None else _clamp(n, 0.0, 1.0)


def _normalize_percent_like(value: Any) -> float | None:
    n = _pct_decimal(value)
    return None if n is None else _clamp(abs(n), 0.0, 1.0)


def _normalize_dispersion(value: Any) -> float | None:
    n = _float(value)
    return None if n is None else _clamp(n * 5.0, 0.0, 1.0)


def _normalize_regime(value: Any) -> float | None:
    raw = str(value or "").strip().lower()
    if raw:
        if "bull" in raw:
            return 0.0
        if "bear" in raw:
            return 1.0
        if "vol" in raw:
            return 0.75
        if "side" in raw or "range" in raw or "chop" in raw:
            return 0.5
    n = _float(value)
    if n is None:
        return None
    return _clamp(n, 0.0, 1.0)


def model_family_arm(model_name: Any) -> str | None:
    name = str(model_name or "").strip().lower().replace("-", "").replace(" ", "")
    if not name:
        return "do_nothing"
    for token, arm in ACTIVE_MODEL_TO_ARM.items():
        if token.replace("_", "") in name:
            return arm
    return None


def _context_vector(row: dict[str, Any]) -> np.ndarray:
    score = _safe_json(row.get("score_components"))
    vote = _safe_json(row.get("ml_vote_summary"))
    alpha_context = _safe_json(row.get("alpha_context"))
    allocation = _safe_json(row.get("alpha_allocation"))
    forecast = _safe_json(row.get("forecast_data"))
    values = {
        "model_ic": _normalize_signed(_first_present(
            row.get("model_ic"),
            _nested(vote, "ic_4w_avg"),
            _nested(vote, "model_ic"),
            _nested(score, "model_ic"),
            _nested(forecast, "model_ic"),
        )),
        "coverage": _normalize01(_first_present(
            row.get("coverage"),
            _nested(vote, "coverage"),
            _nested(score, "ml_coverage"),
            _nested(forecast, "coverage"),
        )),
        "prediction_dispersion": _normalize_dispersion(_first_present(
            row.get("prediction_dispersion"),
            _nested(vote, "dispersion.rawRankStd"),
            _nested(vote, "raw_rank_std"),
            _nested(score, "prediction_dispersion"),
        )),
        "data_quality": _normalize01(_first_present(
            row.get("data_quality"),
            _nested(score, "data_quality"),
            _nested(alpha_context, "data_quality"),
        )),
        "market_breadth": _normalize01(_first_present(
            row.get("market_breadth"),
            _nested(alpha_context, "market_breadth"),
            _nested(allocation, "market_breadth"),
        )),
        "sector_heat": _normalize_signed(_first_present(
            row.get("sector_heat"),
            _nested(score, "sector_heat"),
            _nested(alpha_context, "sector_heat"),
            _nested(allocation, "sector_heat"),
        )),
        "liquidity": _normalize01(_first_present(
            row.get("liquidity"),
            _nested(alpha_context, "liquidity"),
            _nested(alpha_context, "liquidity_score"),
            _nested(score, "liquidity"),
        )),
        "fill_quality": _normalize01(_first_present(
            row.get("fill_quality"),
            _nested(score, "fill_quality"),
            _nested(alpha_context, "fill_quality"),
        )),
        "regime": _normalize_regime(_first_present(
            row.get("regime"),
            _nested(alpha_context, "regime"),
            _nested(allocation, "regime"),
        )),
        "volatility": _normalize_percent_like(_first_present(
            row.get("volatility"),
            _nested(alpha_context, "volatility"),
            _nested(alpha_context, "volatility_score"),
            _nested(score, "volatility"),
        )),
        "market_risk": _normalize01(_first_present(
            row.get("market_risk"),
            row.get("market_risk_score"),
            _nested(alpha_context, "market_risk"),
            _nested(alpha_context, "market_risk_score"),
            _nested(score, "market_risk"),
        )),
        "bias": 1.0,
    }
    return np.asarray([values[name] if values[name] is not None else NEUTRAL_CONTEXT[name] for name in CONTEXT_FEATURES], dtype="float32")


def _row_date(row: dict[str, Any]) -> str | None:
    raw = _first_present(row.get("date"), row.get("prediction_date"), row.get("business_date"), row.get("generated_at"))
    if raw is None:
        return None
    return str(raw)[:10]


def _symbol(row: dict[str, Any]) -> str:
    return str(_first_present(row.get("symbol"), row.get("stock_id"), "unknown"))


def _rank_score(row: dict[str, Any]) -> tuple[float | None, str]:
    forecast = _safe_json(row.get("forecast_data"))
    score = _float(_first_present(
        row.get("rank_score"),
        _nested(forecast, "rank_score"),
    ))
    if score is not None:
        return score, "forecast_data.rank_score"
    return None, "missing"


def _direction_reward(row: dict[str, Any]) -> float | None:
    value = row.get("direction_correct")
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed == 1:
        return 1.0
    if parsed == 0:
        return 0.0
    return None


def _rank_avg_ties(values: Sequence[float]) -> list[float]:
    pairs = sorted((float(v), i) for i, v in enumerate(values))
    ranks = [0.0] * len(values)
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[pairs[k][1]] = avg_rank
        i = j + 1
    return ranks


def spearman_ic(pairs: Sequence[tuple[float, float]]) -> float | None:
    if len(pairs) < 2:
        return None
    x = _rank_avg_ties([p[0] for p in pairs])
    y = _rank_avg_ties([p[1] for p in pairs])
    mx = sum(x) / len(x)
    my = sum(y) / len(y)
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    denx = math.sqrt(sum((a - mx) ** 2 for a in x))
    deny = math.sqrt(sum((b - my) ** 2 for b in y))
    if denx <= 1e-12 or deny <= 1e-12:
        return None
    return float(num / (denx * deny))


def _combine_reward(*, ic: float | None, hit_rate: float | None, pnl_mean: float | None) -> float | None:
    components: list[tuple[float, float]] = []
    if ic is not None:
        components.append((_clamp(ic, -1.0, 1.0), 0.55))
    if hit_rate is not None:
        components.append((_clamp((hit_rate - 0.5) * 2.0, -1.0, 1.0), 0.30))
    if pnl_mean is not None:
        components.append((_clamp(pnl_mean, -0.20, 0.20) / 0.20, 0.15))
    if not components:
        return None
    denom = sum(weight for _, weight in components)
    return round(_clamp(sum(value * weight for value, weight in components) / denom, -1.0, 1.0), 8)


def build_replay_samples(rows: Iterable[dict[str, Any]], config: ReplayConfig | None = None) -> list[ReplaySample]:
    cfg = config or ReplayConfig()
    contexts_by_date: dict[str, list[np.ndarray]] = {}
    by_key: dict[tuple[str, str, str], dict[str, list[float]]] = {}
    score_sources: dict[tuple[str, str], set[str]] = {}

    for row in rows:
        date = _row_date(row)
        if not date:
            continue
        arm = model_family_arm(row.get("model_name"))
        if arm is None:
            continue
        contexts_by_date.setdefault(date, []).append(_context_vector(row))
        symbol = _symbol(row)
        key = (date, arm, symbol)
        bucket = by_key.setdefault(key, {"rank": [], "actual": [], "direction": [], "pnl": []})
        rank, source = _rank_score(row)
        actual = _pct_decimal(row.get("actual_return_pct"))
        direction = _direction_reward(row)
        pnl = _pct_decimal(_first_present(row.get("trade_pnl_pct"), row.get("actual_return_pct")))
        if rank is not None:
            bucket["rank"].append(rank)
        if actual is not None:
            bucket["actual"].append(actual)
        if direction is not None:
            bucket["direction"].append(direction)
        if pnl is not None:
            bucket["pnl"].append(pnl)
        score_sources.setdefault((date, arm), set()).add(source)

    by_date_arm: dict[tuple[str, str], dict[str, list[float] | list[tuple[float, float]]]] = {}
    for (date, arm, _symbol_id), values in by_key.items():
        bucket = by_date_arm.setdefault((date, arm), {"pairs": [], "direction": [], "pnl": []})
        if values["rank"] and values["actual"]:
            bucket["pairs"].append((float(np.mean(values["rank"])), float(np.mean(values["actual"]))))  # type: ignore[union-attr]
        if values["direction"]:
            bucket["direction"].append(float(np.mean(values["direction"])))  # type: ignore[union-attr]
        if values["pnl"]:
            bucket["pnl"].append(float(np.mean(values["pnl"])))  # type: ignore[union-attr]

    samples: list[ReplaySample] = []
    for date in sorted(contexts_by_date):
        arm_rewards: dict[str, FamilyReward] = {}
        for arm in ARM_NAMES:
            bucket = by_date_arm.get((date, arm))
            if not bucket:
                continue
            pairs = list(bucket["pairs"])  # type: ignore[arg-type]
            directions = list(bucket["direction"])  # type: ignore[arg-type]
            pnls = list(bucket["pnl"])  # type: ignore[arg-type]
            ic = spearman_ic(pairs) if len(pairs) >= cfg.min_ic_samples else None
            hit_rate = float(np.mean(directions)) if directions else None
            pnl_mean = float(np.mean(pnls)) if pnls else None
            reward = _combine_reward(ic=ic, hit_rate=hit_rate, pnl_mean=pnl_mean)
            if reward is None:
                continue
            sources = ",".join(sorted(score_sources.get((date, arm), {"missing"})))
            arm_rewards[arm] = FamilyReward(
                reward=reward,
                ic=round(ic, 8) if ic is not None else None,
                hit_rate=round(hit_rate, 8) if hit_rate is not None else None,
                pnl_mean=round(pnl_mean, 8) if pnl_mean is not None else None,
                n_symbols=max(len(pairs), len(directions), len(pnls)),
                n_rank_pairs=len(pairs),
                n_directional=len(directions),
                score_source=sources,
            )
        if arm_rewards:
            context = np.mean(np.stack(contexts_by_date[date]), axis=0).astype("float32")
            samples.append(ReplaySample(date=date, context=context, arm_rewards=arm_rewards))
    return samples


class _LinearUCBPolicy:
    def __init__(self, arm_names: Sequence[str], context_dim: int, alpha: float) -> None:
        self.arm_names = list(arm_names)
        self.index = {name: idx for idx, name in enumerate(self.arm_names)}
        self.alpha = float(alpha)
        self.a = np.stack([np.eye(context_dim, dtype="float64") for _ in self.arm_names])
        self.b = np.zeros((len(self.arm_names), context_dim), dtype="float64")
        self.counts = np.zeros(len(self.arm_names), dtype="int32")

    def select(self, context: np.ndarray, available: Sequence[str]) -> str:
        available_idx = [self.index[arm] for arm in available]
        cold = [idx for idx in available_idx if self.counts[idx] == 0]
        if cold:
            return self.arm_names[cold[0]]
        scores: list[tuple[float, int]] = []
        x = context.astype("float64")
        for idx in available_idx:
            inv = np.linalg.inv(self.a[idx])
            theta = inv @ self.b[idx]
            bonus = self.alpha * math.sqrt(float(x @ inv @ x))
            scores.append((float(theta @ x) + bonus, idx))
        return self.arm_names[max(scores, key=lambda item: item[0])[1]]

    def update(self, context: np.ndarray, arm: str, reward: float) -> None:
        idx = self.index[arm]
        x = context.astype("float64")
        self.a[idx] += np.outer(x, x)
        self.b[idx] += float(reward) * x
        self.counts[idx] += 1


class _NeuralReplayPolicy:
    def __init__(self, method: str, arm_names: Sequence[str], context_dim: int, cfg: ReplayConfig) -> None:
        self.method = method
        self.arm_names = list(arm_names)
        self.index = {name: idx for idx, name in enumerate(self.arm_names)}
        self.context_dim = context_dim
        self.cfg = cfg
        self.contexts: list[np.ndarray] = []
        self.arms: list[int] = []
        self.rewards: list[float] = []

    def _mode(self) -> str:
        if self.method == "NeuralTS":
            return "ts"
        if self.method == "NeuCB":
            return "greedy"
        return "ucb"

    def select(self, context: np.ndarray, available: Sequence[str]) -> str:
        min_train = len(self.arm_names) * max(1, self.cfg.neural_min_train_multiplier)
        if len(self.rewards) < min_train:
            return available[len(self.rewards) % len(available)]
        policy_id = self.method if self.method in {"NeuralUCB", "NeuralTS", "NeuCB"} else "NeuralUCB"
        model = train_neural_meta_bandit(
            np.stack(self.contexts).astype("float32"),
            np.asarray(self.arms, dtype=np.int64),
            np.asarray(self.rewards, dtype="float32"),
            arm_names=self.arm_names,
            config=NeuralMetaBanditConfig(
                policy_id=policy_id,  # type: ignore[arg-type]
                epochs=self.cfg.neural_epochs,
                seed=self.cfg.seed,
                ucb_alpha=0.15 if self.method == "NeuralUCB" else 0.0,
            ),
        )
        scores = model.score_actions(np.asarray([context], dtype="float32"), mode=self._mode())  # type: ignore[arg-type]
        available_idx = [self.index[arm] for arm in available]
        selected_idx = max(available_idx, key=lambda idx: float(scores[0, idx]))
        return self.arm_names[selected_idx]

    def update(self, context: np.ndarray, arm: str, reward: float) -> None:
        self.contexts.append(context.astype("float32"))
        self.arms.append(self.index[arm])
        self.rewards.append(float(reward))


def _current_heuristic_action(available: Sequence[str]) -> str:
    for arm in ("tree_family", "time_series_family", "tabular_neural_family", "graph_family", "do_nothing"):
        if arm in available:
            return arm
    return available[0]


def _max_drawdown(values: Sequence[float]) -> float:
    peak = 0.0
    max_dd = 0.0
    for value in values:
        peak = max(peak, value)
        max_dd = min(max_dd, value - peak)
    return abs(max_dd)


def _summarize_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    rewards = [float(row["reward"]) for row in records]
    cumulative = np.cumsum(rewards).tolist()
    action_counts: dict[str, int] = {}
    for row in records:
        action_counts[row["action"]] = action_counts.get(row["action"], 0) + 1
    changes = sum(1 for prev, cur in zip(records, records[1:]) if prev["action"] != cur["action"])
    concentration = max(action_counts.values()) / len(records) if records else 0.0
    regrets = [float(row.get("oracle_regret", 0.0)) for row in records]
    return {
        "windows": len(records),
        "cumulative_reward": round(float(sum(rewards)), 8) if rewards else 0.0,
        "average_reward": round(float(np.mean(rewards)), 8) if rewards else 0.0,
        "reward_std": round(float(np.std(rewards)), 8) if rewards else 0.0,
        "positive_reward_rate": round(float(np.mean([r > 0 for r in rewards])), 8) if rewards else 0.0,
        "mean_oracle_regret": round(float(np.mean(regrets)), 8) if regrets else 0.0,
        "max_drawdown_reward": round(float(_max_drawdown(cumulative)), 8) if cumulative else 0.0,
        "action_stability": round(1.0 - changes / max(len(records) - 1, 1), 8) if records else 0.0,
        "action_concentration": round(float(concentration), 8),
        "action_counts": action_counts,
        "selection_score": 0.0,
    }


def _selection_score(summary: dict[str, Any]) -> float:
    score = (
        float(summary["average_reward"])
        - 0.25 * float(summary["mean_oracle_regret"])
        - 0.10 * float(summary["max_drawdown_reward"])
        - 0.05 * max(0.0, float(summary["action_concentration"]) - 0.65)
    )
    return round(score, 8)


def _approval_candidate_status(status: str) -> str:
    return "candidate_requires_approval" if status == "pass" else "research_only_failed_gate"


def _family_multiplier_from_share(share: float, equal_share: float) -> float:
    if equal_share <= 0:
        return 1.0
    # Convert learned family preference into a bounded exposure tilt. The
    # production consumer clips again, so the packet remains safe even if
    # future callers pass a larger cap by mistake.
    relative_edge = (float(share) - equal_share) / equal_share
    return round(1.0 + _clamp(relative_edge, -1.0, 1.0) * ALLOCATOR_POLICY_CAP, 6)


def _build_allocator_policy_candidate(
    *,
    status: str,
    best: dict[str, Any] | None,
    gates: list[dict[str, Any]],
    sample_windows: int,
    date_start: str,
    date_end: str,
) -> dict[str, Any] | None:
    if not best:
        return None
    action_counts = best.get("action_counts")
    if not isinstance(action_counts, dict):
        return None
    total_actions = sum(int(count or 0) for count in action_counts.values())
    if total_actions <= 0:
        return None

    allocator_arms = tuple(ARM_TO_ACTIVE_MODELS)
    equal_share = 1.0 / len(allocator_arms)
    family_weight_multipliers: dict[str, float] = {}
    for arm in allocator_arms:
        share = int(action_counts.get(arm, 0) or 0) / total_actions
        family_weight_multipliers[arm] = _family_multiplier_from_share(share, equal_share)

    model_weight_multipliers: dict[str, float] = {}
    for arm, models in ARM_TO_ACTIVE_MODELS.items():
        for model in models:
            model_weight_multipliers[model] = family_weight_multipliers[arm]

    do_nothing_share = int(action_counts.get("do_nothing", 0) or 0) / total_actions
    policy_id = f"adaptive-meta-{date_end}-{str(best.get('method') or 'unknown').lower()}"
    return {
        "schema_version": ALLOCATOR_CANDIDATE_SCHEMA_VERSION,
        "policy_id": policy_id,
        "candidate_type": "family_allocator_model_weight_multipliers",
        "source": "adaptive_meta_policy_replay",
        "status": _approval_candidate_status(status),
        "approved": False,
        "approval_status": "not_submitted",
        "approved_level": None,
        "requires_wei_approval": True,
        "production_effect": False,
        "proposed_production_effect": "capped_production_effect",
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "allowed_target": "ml:adaptive_params.model_allocator",
        "model_multiplier_cap": ALLOCATOR_POLICY_CAP,
        "production_cap": ALLOCATOR_POLICY_CAP,
        "family_weight_multipliers": family_weight_multipliers,
        "model_weight_multipliers": model_weight_multipliers,
        "risk_off_cash_bias": round(float(do_nothing_share), 8),
        "method": best.get("method"),
        "evidence": {
            "sample_windows": sample_windows,
            "date_start": date_start,
            "date_end": date_end,
            "selection_score": best.get("selection_score"),
            "average_reward": best.get("average_reward"),
            "mean_oracle_regret": best.get("mean_oracle_regret"),
            "action_concentration": best.get("action_concentration"),
            "action_counts": action_counts,
            "gates": gates,
        },
    }


def run_adaptive_meta_policy_replay(
    rows: Iterable[dict[str, Any]],
    *,
    config: ReplayConfig | None = None,
) -> dict[str, Any]:
    cfg = config or ReplayConfig()
    source_rows = list(rows)
    samples = build_replay_samples(source_rows, cfg)
    if not samples:
        return {
            "schema_version": SCHEMA_VERSION,
            "generated_at": _utc_now(),
            "production_effect": False,
            "allowed_use": "research_only",
            "status": "fail",
            "reason": "no_replay_samples",
            "source_rows": len(source_rows),
            "sample_windows": 0,
            "ranking": [],
            "methods": {},
            "gates": [{"name": "samples", "passed": False, "reason": "no_replay_samples"}],
        }

    methods: dict[str, list[dict[str, Any]]] = {
        "current_production_heuristic": [],
        "equal_weight_guarded": [],
        "LinUCB": [],
        "NeuralUCB": [],
        "NeuralTS": [],
        "NeuCB": [],
    }
    policies = {
        "LinUCB": _LinearUCBPolicy(ARM_NAMES, len(CONTEXT_FEATURES), cfg.linucb_alpha),
        "NeuralUCB": _NeuralReplayPolicy("NeuralUCB", ARM_NAMES, len(CONTEXT_FEATURES), cfg),
        "NeuralTS": _NeuralReplayPolicy("NeuralTS", ARM_NAMES, len(CONTEXT_FEATURES), cfg),
        "NeuCB": _NeuralReplayPolicy("NeuCB", ARM_NAMES, len(CONTEXT_FEATURES), cfg),
    }

    for sample in samples:
        available = sorted(sample.arm_rewards)
        best_reward = max(item.reward for item in sample.arm_rewards.values())
        baseline_arm = _current_heuristic_action(available)
        baseline_reward = sample.arm_rewards[baseline_arm].reward
        methods["current_production_heuristic"].append({
            "date": sample.date,
            "action": baseline_arm,
            "reward": baseline_reward,
            "oracle_regret": round(best_reward - baseline_reward, 8),
        })
        equal_reward = float(np.mean([item.reward for item in sample.arm_rewards.values()]))
        methods["equal_weight_guarded"].append({
            "date": sample.date,
            "action": "equal_weight_guarded",
            "reward": round(equal_reward, 8),
            "oracle_regret": round(best_reward - equal_reward, 8),
        })
        for method, policy in policies.items():
            action = policy.select(sample.context, available)
            reward = sample.arm_rewards[action].reward
            policy.update(sample.context, action, reward)
            methods[method].append({
                "date": sample.date,
                "action": action,
                "reward": reward,
                "oracle_regret": round(best_reward - reward, 8),
                "evidence": sample.arm_rewards[action].__dict__,
            })

    summaries = {method: _summarize_records(records) for method, records in methods.items()}
    for summary in summaries.values():
        summary["selection_score"] = _selection_score(summary)

    fixed_rewards = {
        arm: [sample.arm_rewards[arm].reward for sample in samples if arm in sample.arm_rewards]
        for arm in ARM_NAMES
    }
    best_fixed_arm = max(
        (arm for arm in ARM_NAMES if fixed_rewards[arm]),
        key=lambda arm: float(np.mean(fixed_rewards[arm])),
        default=None,
    )
    best_fixed = {
        "arm": best_fixed_arm,
        "average_reward": round(float(np.mean(fixed_rewards[best_fixed_arm])), 8) if best_fixed_arm else None,
        "windows": len(fixed_rewards[best_fixed_arm]) if best_fixed_arm else 0,
        "note": "hindsight upper-bound reference, not deployment evidence",
    }

    ranking = sorted(
        [
            {
                "method": method,
                **summary,
            }
            for method, summary in summaries.items()
            if method not in {"current_production_heuristic", "equal_weight_guarded"}
        ],
        key=lambda row: (float(row["selection_score"]), float(row["average_reward"]), -float(row["mean_oracle_regret"])),
        reverse=True,
    )
    baseline_avg = summaries["current_production_heuristic"]["average_reward"]
    best = ranking[0] if ranking else None
    gates = [
        {
            "name": "walk_forward_windows",
            "passed": len(samples) >= cfg.min_windows,
            "reason": "enough_windows" if len(samples) >= cfg.min_windows else f"windows={len(samples)} < {cfg.min_windows}",
        },
        {
            "name": "beats_current_heuristic",
            "passed": bool(best and float(best["average_reward"]) > float(baseline_avg)),
            "reason": "candidate_average_reward_above_current_heuristic" if best and float(best["average_reward"]) > float(baseline_avg) else "candidate_does_not_beat_current_heuristic",
        },
        {
            "name": "no_single_arm_collapse",
            "passed": bool(best and float(best["action_concentration"]) <= 0.80),
            "reason": "action_concentration_within_policy" if best and float(best["action_concentration"]) <= 0.80 else "action_concentration_too_high",
        },
        {
            "name": "positive_average_reward",
            "passed": bool(best and float(best["average_reward"]) > 0.0),
            "reason": "candidate_average_reward_positive" if best and float(best["average_reward"]) > 0.0 else "candidate_average_reward_not_positive",
        },
    ]
    status = "pass" if all(gate["passed"] for gate in gates) else "fail"
    allocator_policy_candidate = _build_allocator_policy_candidate(
        status=status,
        best=best,
        gates=gates,
        sample_windows=len(samples),
        date_start=samples[0].date,
        date_end=samples[-1].date,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "context_version": CONTEXT_VERSION,
        "generated_at": _utc_now(),
        "production_effect": False,
        "allowed_use": "research_only" if status == "fail" else "roadmap_candidate",
        "status": status,
        "source_rows": len(source_rows),
        "sample_windows": len(samples),
        "date_start": samples[0].date,
        "date_end": samples[-1].date,
        "arm_names": list(ARM_NAMES),
        "reward_policy": {
            "primary": "family_date_reward",
            "formula": "0.55*spearman_ic + 0.30*direction_hit_rate_edge + 0.15*clipped_pnl",
            "ic_source": "forecast_data.rank_score_vs_actual_return_pct",
            "fallbacks": ["direction_correct", "trade_pnl_pct_or_actual_return_pct"],
        },
        "baselines": {
            "current_production_heuristic": summaries["current_production_heuristic"],
            "equal_weight_guarded": summaries["equal_weight_guarded"],
            "best_fixed_hindsight": best_fixed,
        },
        "methods": {method: summary for method, summary in summaries.items() if method not in {"current_production_heuristic", "equal_weight_guarded"}},
        "ranking": ranking,
        "best_ranked_method": best["method"] if best else None,
        "recommended_method": best["method"] if status == "pass" and best else None,
        "allocator_policy_candidate": allocator_policy_candidate,
        "gates": gates,
        "sample_preview": [
            {
                "date": sample.date,
                "available_arms": sorted(sample.arm_rewards),
                "arm_rewards": {arm: reward.__dict__ for arm, reward in sorted(sample.arm_rewards.items())},
            }
            for sample in samples[:5]
        ],
    }
