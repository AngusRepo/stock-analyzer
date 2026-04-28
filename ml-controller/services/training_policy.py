"""Configurable universal training policy."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass


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


@dataclass(frozen=True)
class TrainingPolicy:
    bear_vix_threshold: float = 25.0
    bear_twii_bias_threshold: float = -0.05
    bull_vix_threshold: float = 18.0
    bull_twii_bias_threshold: float = 0.02
    bear_lookback_days: int = 252
    sideways_lookback_days: int = 500
    bull_lookback_days: int = 900
    monthly_day_cutoff: int = 7
    feature_selection_max_rounds: int = 100
    feature_selection_alpha: float = 0.01

    @classmethod
    def from_env(cls) -> "TrainingPolicy":
        return cls(
            bear_vix_threshold=_env_float("UNIVERSAL_BEAR_VIX_THRESHOLD", cls.bear_vix_threshold),
            bear_twii_bias_threshold=_env_float(
                "UNIVERSAL_BEAR_TWII_BIAS_THRESHOLD",
                cls.bear_twii_bias_threshold,
            ),
            bull_vix_threshold=_env_float("UNIVERSAL_BULL_VIX_THRESHOLD", cls.bull_vix_threshold),
            bull_twii_bias_threshold=_env_float(
                "UNIVERSAL_BULL_TWII_BIAS_THRESHOLD",
                cls.bull_twii_bias_threshold,
            ),
            bear_lookback_days=_env_int("UNIVERSAL_BEAR_LOOKBACK_DAYS", cls.bear_lookback_days),
            sideways_lookback_days=_env_int("UNIVERSAL_SIDEWAYS_LOOKBACK_DAYS", cls.sideways_lookback_days),
            bull_lookback_days=_env_int("UNIVERSAL_BULL_LOOKBACK_DAYS", cls.bull_lookback_days),
            monthly_day_cutoff=_env_int("UNIVERSAL_MONTHLY_DAY_CUTOFF", cls.monthly_day_cutoff),
            feature_selection_max_rounds=_env_int(
                "UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS",
                cls.feature_selection_max_rounds,
            ),
            feature_selection_alpha=_env_float(
                "UNIVERSAL_FEATURE_SELECTION_ALPHA",
                cls.feature_selection_alpha,
            ),
        )

    def resolve_regime(self, *, vix: float, twii_bias: float) -> tuple[str, int]:
        if vix > self.bear_vix_threshold or twii_bias < self.bear_twii_bias_threshold:
            return "bear", self.bear_lookback_days
        if vix < self.bull_vix_threshold and twii_bias > self.bull_twii_bias_threshold:
            return "bull", self.bull_lookback_days
        return "sideways", self.sideways_lookback_days

    def is_monthly(self, *, force_monthly: bool, tw_day: int) -> bool:
        return bool(force_monthly or tw_day <= self.monthly_day_cutoff)

    def feature_selection_params(self) -> dict:
        return {
            "max_rounds": int(self.feature_selection_max_rounds),
            "alpha": float(self.feature_selection_alpha),
        }

    def to_dict(self) -> dict:
        return asdict(self)
