"""Training policy helpers for Modal-side ML orchestration."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class FeatureSelectionPolicy:
    max_rounds: int = 100
    per_window_max_rounds: int = 60
    alpha: float = 0.01
    required_power: float = 0.99
    icir_weight: float = 0.1

    @classmethod
    def from_env(cls) -> "FeatureSelectionPolicy":
        return cls(
            max_rounds=_env_int("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", cls.max_rounds),
            per_window_max_rounds=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_WINDOW_MAX_ROUNDS",
                cls.per_window_max_rounds,
            ),
            alpha=_env_float("UNIVERSAL_FEATURE_SELECTION_ALPHA", cls.alpha),
            required_power=_env_float("UNIVERSAL_FEATURE_SELECTION_REQUIRED_POWER", cls.required_power),
            icir_weight=_env_float("UNIVERSAL_FEATURE_SELECTION_ICIR_WEIGHT", cls.icir_weight),
        )

    def to_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        data = asdict(self)
        overrides = overrides or {}
        return {
            "max_rounds": _coerce_int(overrides.get("max_rounds"), data["max_rounds"]),
            "alpha": _coerce_float(overrides.get("alpha"), data["alpha"]),
            "required_power": _coerce_float(overrides.get("required_power"), data["required_power"]),
            "icir_weight": _coerce_float(overrides.get("icir_weight"), data["icir_weight"]),
        }

    def to_window_selection_params(self, overrides: dict[str, Any] | None = None) -> dict[str, float | int]:
        overrides = dict(overrides or {})
        overrides.setdefault("max_rounds", self.per_window_max_rounds)
        return self.to_selection_params(overrides)
