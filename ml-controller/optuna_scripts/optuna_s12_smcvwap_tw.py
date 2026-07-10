from __future__ import annotations

import json
import re
from typing import Any


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _detail_value(detail: str, key: str) -> str | None:
    match = re.search(rf"(?:^|;){re.escape(key)}=([^;]*)", detail or "")
    return match.group(1).strip() if match and match.group(1).strip() else None


def _pipe_count(value: str | None) -> int | None:
    if value is None:
        return None
    return len([item for item in value.split("|") if item.strip()])


def normalize_s12_replay_rows(rows: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for row in rows:
        pnl_r = _finite(row.get("trade_pnl_r"))
        if pnl_r is None:
            continue
        payload: dict[str, Any] = {}
        raw = row.get("detail_json")
        if isinstance(raw, dict):
            payload = raw
        elif isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                payload = parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                payload = {}
        detail = str(payload.get("assessment_detail") or "")
        normalized.append(
            {
                "pnl_r": pnl_r,
                "mutation_score": _finite(_detail_value(detail, "equity_mutation_score")) or 0.0,
                "fast_vwap_signals": float(_pipe_count(_detail_value(detail, "vwap_fast_reasons")) or 0),
                "stop_risk_pct": _finite(_detail_value(detail, "equity_mutation_stop_risk_pct")) or 1.0,
                "stop_risk_atr": _finite(_detail_value(detail, "equity_mutation_stop_risk_atr")) or 99.0,
            }
        )
    return normalized


def _metrics(rows: list[dict[str, float]], params: dict[str, float]) -> dict[str, float]:
    selected = [
        row
        for row in rows
        if row["mutation_score"] >= params["limitedMutationMinScore"]
        and row["fast_vwap_signals"] >= params["minFastVwapSignals"]
        and row["stop_risk_pct"] <= params["maxStopRiskPct"]
        and row["stop_risk_atr"] <= params["maxStopRiskAtr"]
    ]
    if not selected:
        return {"samples": 0.0, "mean_r": -99.0, "hit_rate": 0.0, "max_drawdown_r": -99.0}
    equity = peak = drawdown = 0.0
    for row in selected:
        equity += row["pnl_r"]
        peak = max(peak, equity)
        drawdown = min(drawdown, equity - peak)
    return {
        "samples": float(len(selected)),
        "mean_r": sum(row["pnl_r"] for row in selected) / len(selected),
        "hit_rate": sum(1 for row in selected if row["pnl_r"] > 0) / len(selected),
        "max_drawdown_r": drawdown,
    }


def search_s12_smcvwap_tw(rows: list[dict[str, Any]], n_trials: int = 200) -> dict[str, Any]:
    evidence = normalize_s12_replay_rows(rows)
    if len(evidence) < 40:
        return {"status": "insufficient_data", "reason": "s12_replay_samples_lt_40", "samples": len(evidence)}
    split = max(28, int(len(evidence) * 0.7))
    train = evidence[:split]
    validation = evidence[split:]
    if len(validation) < 12:
        return {"status": "insufficient_data", "reason": "s12_validation_samples_lt_12", "samples": len(evidence)}

    try:
        import optuna
    except ImportError as exc:  # pragma: no cover - production image contract
        raise RuntimeError("optuna is required for S12 SMCVWAP TW search") from exc

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    def objective(trial: Any) -> float:
        params = {
            "limitedMutationMinScore": float(trial.suggest_int("limitedMutationMinScore", 3, 6)),
            "minFastVwapSignals": float(trial.suggest_int("minFastVwapSignals", 1, 4)),
            "maxStopRiskPct": trial.suggest_float("maxStopRiskPct", 0.02, 0.08, step=0.005),
            "maxStopRiskAtr": trial.suggest_float("maxStopRiskAtr", 1.0, 5.0, step=0.25),
        }
        metrics = _metrics(train, params)
        coverage = metrics["samples"] / len(train)
        if metrics["samples"] < 20 or coverage < 0.3:
            return -100.0 + coverage
        return metrics["mean_r"] + 0.35 * metrics["hit_rate"] + 0.1 * metrics["max_drawdown_r"]

    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=max(10, int(n_trials)), show_progress_bar=False)
    params = {key: float(value) for key, value in study.best_params.items()}
    params["strictMutationMinScore"] = min(8.0, params["limitedMutationMinScore"] + 1.0)
    train_metrics = _metrics(train, params)
    validation_metrics = _metrics(validation, params)
    validation_coverage = validation_metrics["samples"] / len(validation)
    validation_pass = (
        validation_metrics["samples"] >= 10
        and validation_coverage >= 0.35
        and validation_metrics["mean_r"] >= 0
        and validation_metrics["hit_rate"] >= 0.45
    )
    return {
        "status": "validated" if validation_pass else "rejected",
        "source": "s12_smcvwap_tw",
        "best_params": params,
        "samples": len(evidence),
        "train": train_metrics,
        "validation": {**validation_metrics, "coverage": validation_coverage},
        "validation_pass": validation_pass,
        "production_effect": "none_until_worker_artifact_guarded_promotion",
    }
