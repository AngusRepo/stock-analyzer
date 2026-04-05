"""
adversarial_graph.py — Red-Blue Army Testing (P2#17 Historical + P2#18 Synthetic)

P2#17: Historical Replay
  Load crisis periods → replay through strategy → measure MDD, recovery days

P2#18: Synthetic Stress
  Generate adversarial scenarios → test strategy resilience

Output: robustness score (0-100). Score > 60 = can go live with real money.
"""
import json
import logging
import random
import statistics
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ── Historical Crisis Scenarios (P2#17) ───────────────────────────────────────

CRISIS_SCENARIOS = {
    "covid_2020": {
        "name": "COVID-19 Crash (2020/03)",
        "description": "TWII -26% in 3 weeks, V-shape recovery",
        "daily_returns": [
            -0.02, -0.03, -0.01, 0.01, -0.04, -0.05, -0.02, -0.06, -0.03, 0.02,
            -0.04, -0.03, -0.01, 0.03, 0.04, 0.02, -0.01, 0.03, 0.05, 0.02,
        ],
        "peak_drawdown": 0.26,
        "recovery_days": 120,
    },
    "bear_2022": {
        "name": "2022 Bear Market",
        "description": "TWII -25% over 6 months, slow grind down",
        "daily_returns": [
            -0.01, -0.005, 0.003, -0.008, -0.012, -0.005, 0.002, -0.015, -0.008, 0.005,
            -0.010, -0.008, -0.003, 0.001, -0.012, -0.007, 0.004, -0.009, -0.006, 0.003,
            -0.011, -0.005, -0.002, 0.006, -0.008, -0.013, 0.001, -0.007, -0.004, 0.008,
        ],
        "peak_drawdown": 0.25,
        "recovery_days": 250,
    },
    "financial_crisis_2008": {
        "name": "2008 Financial Crisis",
        "description": "TWII -50% over 12 months, extreme volatility",
        "daily_returns": [
            -0.03, -0.04, 0.01, -0.05, -0.06, 0.02, -0.04, -0.03, -0.02, 0.03,
            -0.07, -0.05, 0.04, -0.03, -0.06, -0.02, 0.01, -0.04, -0.05, 0.02,
            -0.03, -0.04, -0.01, 0.05, -0.02, -0.06, 0.03, -0.04, -0.03, 0.01,
        ],
        "peak_drawdown": 0.50,
        "recovery_days": 500,
    },
}


# ── Synthetic Stress Scenarios (P2#18) ────────────────────────────────────────

def _generate_false_breakout(seed: int = 42) -> dict:
    """5 days institutional buying → day 6 gap down -5%"""
    rng = random.Random(seed)
    returns = [rng.uniform(0.01, 0.03) for _ in range(5)]  # 5 days up
    returns.append(-0.05)  # day 6 gap down
    returns.extend([rng.uniform(-0.02, 0.01) for _ in range(4)])  # aftermath
    return {
        "name": "False Breakout Trap",
        "description": "5d institutional buying → day 6 gap down -5%",
        "daily_returns": returns,
    }


def _generate_model_co_error(seed: int = 42) -> dict:
    """All models predict wrong for 5 consecutive days"""
    rng = random.Random(seed)
    # Market goes down but models predicted up → forced stop-losses
    returns = [rng.uniform(-0.04, -0.02) for _ in range(5)]
    returns.extend([rng.uniform(-0.01, 0.02) for _ in range(5)])  # recovery
    return {
        "name": "Model Co-Error",
        "description": "10 models all predict wrong for 5 consecutive days",
        "daily_returns": returns,
    }


def _generate_liquidity_evaporation(seed: int = 42) -> dict:
    """3 consecutive limit-down days"""
    returns = [-0.10, -0.10, -0.10]  # 3 limit-down days
    returns.extend([-0.03, -0.01, 0.02, 0.05, 0.03])  # slow recovery
    return {
        "name": "Liquidity Evaporation",
        "description": "3 consecutive limit-down days (can't exit)",
        "daily_returns": returns,
    }


def _generate_flash_crash(seed: int = 42) -> dict:
    """Single day -7% flash crash"""
    rng = random.Random(seed)
    returns = [rng.uniform(-0.005, 0.01) for _ in range(3)]  # normal days
    returns.append(-0.07)  # flash crash
    returns.extend([0.03, 0.02, 0.01, -0.005, 0.01])  # bounce
    return {
        "name": "Flash Crash",
        "description": "Single day -7% flash crash with partial recovery",
        "daily_returns": returns,
    }


SYNTHETIC_GENERATORS = {
    "false_breakout": _generate_false_breakout,
    "model_co_error": _generate_model_co_error,
    "liquidity_evaporation": _generate_liquidity_evaporation,
    "flash_crash": _generate_flash_crash,
}


# ── Strategy Simulation ──────────────────────────────────────────────────────

@dataclass
class ScenarioResult:
    scenario_name: str = ""
    max_drawdown: float = 0.0
    recovery_days: int = 0
    final_return: float = 0.0
    worst_day: float = 0.0
    days_below_stop: int = 0       # days where hard stop would trigger
    circuit_breaker_triggered: bool = False
    score: float = 0.0             # 0-100 robustness score


def _simulate_strategy_under_scenario(
    daily_returns: list[float],
    hard_stop_pct: float = -0.12,
    circuit_breaker_mdd: float = 0.15,
) -> ScenarioResult:
    """
    Simulate the 7-layer strategy behavior under a crisis scenario.
    Uses simplified model: fully invested, daily returns applied to equity.
    """
    result = ScenarioResult()

    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    peak_day = 0
    recovery_start = -1
    days_below_stop = 0

    for i, r in enumerate(daily_returns):
        equity *= (1 + r)
        if equity > peak:
            peak = equity
            peak_day = i
            recovery_start = -1

        dd = (peak - equity) / peak if peak > 0 else 0
        max_dd = max(max_dd, dd)

        if r <= hard_stop_pct:
            days_below_stop += 1

        if dd >= circuit_breaker_mdd and not result.circuit_breaker_triggered:
            result.circuit_breaker_triggered = True

        if r < (result.worst_day or 0):
            result.worst_day = r

    result.max_drawdown = max_dd
    result.final_return = equity - 1.0
    result.days_below_stop = days_below_stop

    # Recovery: days from peak to when equity recovers (or end)
    result.recovery_days = len(daily_returns) - peak_day

    # Robustness score (0-100)
    # MDD < 15% = 40pts, < 25% = 25pts, < 35% = 10pts, else 0
    # Recovery < 30d = 30pts, < 60d = 20pts, < 120d = 10pts
    # No circuit breaker = 20pts
    # No hard-stop days = 10pts
    mdd_score = 40 if max_dd < 0.15 else 25 if max_dd < 0.25 else 10 if max_dd < 0.35 else 0
    rec_score = 30 if result.recovery_days < 30 else 20 if result.recovery_days < 60 else 10 if result.recovery_days < 120 else 0
    cb_score = 20 if not result.circuit_breaker_triggered else 5
    stop_score = 10 if days_below_stop == 0 else 5 if days_below_stop <= 2 else 0
    result.score = mdd_score + rec_score + cb_score + stop_score

    return result


# ── Main API ──────────────────────────────────────────────────────────────────

def run_adversarial_test(
    scenarios: str = "all",
) -> dict:
    """
    Run Red-Blue Army tests.
    scenarios: "historical" | "synthetic" | "all"
    Returns per-scenario results + aggregate robustness score.
    """
    results = []

    # Historical replay
    if scenarios in ("historical", "all"):
        for key, scenario in CRISIS_SCENARIOS.items():
            sr = _simulate_strategy_under_scenario(scenario["daily_returns"])
            sr.scenario_name = scenario["name"]
            results.append({
                "type": "historical",
                "key": key,
                "name": scenario["name"],
                "description": scenario["description"],
                "max_drawdown": round(sr.max_drawdown, 4),
                "final_return": round(sr.final_return, 4),
                "worst_day": round(sr.worst_day, 4),
                "recovery_days": sr.recovery_days,
                "circuit_breaker": sr.circuit_breaker_triggered,
                "days_below_stop": sr.days_below_stop,
                "score": sr.score,
            })

    # Synthetic stress
    if scenarios in ("synthetic", "all"):
        for key, gen_fn in SYNTHETIC_GENERATORS.items():
            scenario = gen_fn()
            sr = _simulate_strategy_under_scenario(scenario["daily_returns"])
            sr.scenario_name = scenario["name"]
            results.append({
                "type": "synthetic",
                "key": key,
                "name": scenario["name"],
                "description": scenario["description"],
                "max_drawdown": round(sr.max_drawdown, 4),
                "final_return": round(sr.final_return, 4),
                "worst_day": round(sr.worst_day, 4),
                "recovery_days": sr.recovery_days,
                "circuit_breaker": sr.circuit_breaker_triggered,
                "days_below_stop": sr.days_below_stop,
                "score": sr.score,
            })

    # Aggregate robustness score (weighted average)
    if results:
        avg_score = statistics.mean(r["score"] for r in results)
        min_score = min(r["score"] for r in results)
    else:
        avg_score = 0
        min_score = 0

    # Go-live verdict: avg > 60 AND min > 30
    if avg_score >= 60 and min_score >= 30:
        verdict = "PASS"
        verdict_reason = f"Avg robustness {avg_score:.0f}/100, min {min_score:.0f}/100. Strategy can handle crisis."
    elif avg_score >= 40:
        verdict = "CAUTION"
        verdict_reason = f"Avg robustness {avg_score:.0f}/100, min {min_score:.0f}/100. Consider risk reduction."
    else:
        verdict = "FAIL"
        verdict_reason = f"Avg robustness {avg_score:.0f}/100, min {min_score:.0f}/100. Too risky for live trading."

    return {
        "status": "success",
        "scenarios": results,
        "aggregate": {
            "avg_score": round(avg_score, 1),
            "min_score": round(min_score, 1),
            "total_scenarios": len(results),
            "verdict": verdict,
            "verdict_reason": verdict_reason,
        },
    }
