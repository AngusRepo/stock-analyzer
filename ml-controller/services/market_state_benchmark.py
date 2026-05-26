"""Research-only market-state benchmark gate.

Compares the current market_regime_state path against a JEPA latent-state
candidate on identical realized labels. This module is intentionally
non-mutating: it only returns adoption evidence for review.
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import date
from typing import Any


SCHEMA_VERSION = "market-state-benchmark-v1"
CANONICAL_LABELS = ("bull", "bear", "volatile", "sideways")
TRANSITION_RISK_LABELS = {"bear", "volatile"}


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _normalize_label(value: object) -> str:
    raw = _clean_text(value).lower()
    if not raw:
        return ""
    if "bull" in raw or raw in {"green", "risk_on"}:
        return "bull"
    if "bear" in raw or raw in {"red", "risk_off"}:
        return "bear"
    if "vol" in raw or "panic" in raw or raw in {"high_vol", "risk_alert"}:
        return "volatile"
    if "side" in raw or "range" in raw or "chop" in raw or "repair" in raw:
        return "sideways"
    return raw


def _parse_date(value: object) -> date | None:
    raw = _clean_text(value)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _label_date(row: dict[str, Any]) -> str:
    return _clean_text(row.get("label_date") or row.get("date") or row.get("run_date") or row.get("as_of_date"))


def _prediction_label(row: dict[str, Any]) -> str:
    for key in ("state_label", "predicted_label", "regime_label", "label", "regime_label_en"):
        label = _normalize_label(row.get(key))
        if label:
            return label
    return ""


def _prediction_index(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = _label_date(row)
        if key:
            indexed[key] = row
    return indexed


def _realized_index(rows: list[dict[str, Any]]) -> dict[str, str]:
    indexed: dict[str, str] = {}
    for row in rows:
        key = _label_date(row)
        label = _normalize_label(row.get("realized_label") or row.get("label") or row.get("regime_label"))
        if key and label:
            indexed[key] = label
    return indexed


def _probabilities(row: dict[str, Any]) -> dict[str, float]:
    raw = row.get("probabilities") or row.get("regime_surface") or row.get("state_probabilities")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in raw.items():
        label = _normalize_label(key)
        try:
            prob = float(value)
        except (TypeError, ValueError):
            continue
        if label and math.isfinite(prob) and prob >= 0:
            out[label] = prob
    total = sum(out.values())
    if total > 0:
        out = {label: prob / total for label, prob in out.items()}
    return out


def _brier_score(rows: list[tuple[dict[str, Any], str]]) -> float | None:
    scores: list[float] = []
    for row, realized in rows:
        probs = _probabilities(row)
        if not probs:
            continue
        score = 0.0
        for label in CANONICAL_LABELS:
            target = 1.0 if label == realized else 0.0
            score += (probs.get(label, 0.0) - target) ** 2
        scores.append(score)
    if not scores:
        return None
    return round(sum(scores) / len(scores), 8)


def _metrics(prediction_rows: dict[str, dict[str, Any]], realized: dict[str, str]) -> dict[str, Any]:
    paired: list[tuple[dict[str, Any], str]] = []
    confusion: Counter[str] = Counter()
    per_label_total: Counter[str] = Counter()
    per_label_hit: Counter[str] = Counter()
    for key, label in realized.items():
        row = prediction_rows.get(key)
        pred = _prediction_label(row or {})
        if not row or not pred:
            confusion[f"{label}->missing"] += 1
            per_label_total[label] += 1
            continue
        paired.append((row, label))
        confusion[f"{label}->{pred}"] += 1
        per_label_total[label] += 1
        if pred == label:
            per_label_hit[label] += 1

    n = len(realized)
    correct = sum(per_label_hit.values())
    balanced_parts = [
        per_label_hit[label] / total
        for label, total in per_label_total.items()
        if total > 0
    ]
    transition_total = sum(total for label, total in per_label_total.items() if label in TRANSITION_RISK_LABELS)
    transition_hit = sum(per_label_hit[label] for label in TRANSITION_RISK_LABELS)
    return {
        "n": n,
        "paired_predictions": len(paired),
        "accuracy": round(correct / n, 8) if n else None,
        "balanced_accuracy": round(sum(balanced_parts) / len(balanced_parts), 8) if balanced_parts else None,
        "transition_recall": round(transition_hit / transition_total, 8) if transition_total else None,
        "brier_score": _brier_score(paired),
        "confusion": dict(sorted(confusion.items())),
    }


def _detect_future_leakage(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    leaks: list[dict[str, str]] = []
    for row in rows:
        label_raw = _label_date(row)
        label_dt = _parse_date(label_raw)
        if not label_dt:
            continue
        for key in ("as_of_date", "feature_end_date"):
            observed_raw = _clean_text(row.get(key))
            observed_dt = _parse_date(observed_raw)
            if observed_dt and observed_dt > label_dt:
                leaks.append({
                    "label_date": label_raw,
                    "field": key,
                    "value": observed_raw[:10],
                })
    return leaks


def _candidate_state_label_missing(rows: list[dict[str, Any]]) -> bool:
    for row in rows:
        if _clean_text(row.get("latent_state")) and not _normalize_label(row.get("state_label")):
            return True
    return False


def _delta(left: float | None, right: float | None) -> float | None:
    if left is None or right is None:
        return None
    return round(left - right, 8)


def build_market_state_benchmark_report(
    *,
    current_regime_rows: list[dict[str, Any]],
    candidate_state_rows: list[dict[str, Any]],
    realized_rows: list[dict[str, Any]],
    min_accuracy_delta: float = 0.05,
    min_transition_recall_delta: float = 0.0,
    max_brier_delta: float = 0.0,
) -> dict[str, Any]:
    realized = _realized_index(realized_rows)
    baseline_index = _prediction_index(current_regime_rows)
    challenger_index = _prediction_index(candidate_state_rows)
    baseline_metrics = _metrics(baseline_index, realized)
    challenger_metrics = _metrics(challenger_index, realized)

    blockers: list[str] = []
    leakage = _detect_future_leakage(current_regime_rows) + _detect_future_leakage(candidate_state_rows)
    if leakage:
        blockers.append("future_leakage_detected")
    if not realized:
        blockers.append("missing_realized_labels")
    if _candidate_state_label_missing(candidate_state_rows):
        blockers.append("jepa_state_label_mapping_missing")

    accuracy_delta = _delta(challenger_metrics["accuracy"], baseline_metrics["accuracy"])
    transition_recall_delta = _delta(challenger_metrics["transition_recall"], baseline_metrics["transition_recall"])
    brier_delta = _delta(challenger_metrics["brier_score"], baseline_metrics["brier_score"])
    brier_gate = brier_delta is None or brier_delta <= max_brier_delta

    eligible = (
        not blockers
        and accuracy_delta is not None
        and accuracy_delta >= min_accuracy_delta
        and transition_recall_delta is not None
        and transition_recall_delta >= min_transition_recall_delta
        and brier_gate
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked" if blockers else "ready_for_review",
        "decision_effect": "benchmark_gate_only",
        "blockers": blockers,
        "leakage_examples": leakage[:5],
        "baseline": {
            "method": "current_market_regime_state",
            "metrics": baseline_metrics,
        },
        "challenger": {
            "method": "jepa_latent_market_state",
            "metrics": challenger_metrics,
        },
        "decision": {
            "eligible_to_fuse": eligible,
            "production_mutation_allowed": False,
            "accuracy_delta": accuracy_delta,
            "transition_recall_delta": transition_recall_delta,
            "brier_delta": brier_delta,
            "min_accuracy_delta": min_accuracy_delta,
            "min_transition_recall_delta": min_transition_recall_delta,
            "max_brier_delta": max_brier_delta,
        },
    }
