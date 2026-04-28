from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ConfigPoolPolicy:
    sharpe_delta_win_threshold: float = 0.2
    win_rate_floor: float = 0.55
    win_rate_retire_ceil: float = 0.45
    consecutive_wins_to_promote: int = 2
    consecutive_losses_to_retire: int = 2
    max_shadow_days: int = 30
    lookback_days: int = 90

    @classmethod
    def from_config(cls, config: dict[str, Any] | None) -> "ConfigPoolPolicy":
        section = _policy_section(config)
        defaults = cls()
        return cls(
            sharpe_delta_win_threshold=_float_value(section, "sharpeDeltaWinThreshold", defaults.sharpe_delta_win_threshold, -5.0, 5.0),
            win_rate_floor=_float_value(section, "winRateFloor", defaults.win_rate_floor, 0.0, 1.0),
            win_rate_retire_ceil=_float_value(section, "winRateRetireCeil", defaults.win_rate_retire_ceil, 0.0, 1.0),
            consecutive_wins_to_promote=_int_value(section, "consecutiveWinsToPromote", defaults.consecutive_wins_to_promote, 1, 12),
            consecutive_losses_to_retire=_int_value(section, "consecutiveLossesToRetire", defaults.consecutive_losses_to_retire, 1, 12),
            max_shadow_days=_int_value(section, "maxShadowDays", defaults.max_shadow_days, 7, 180),
            lookback_days=_int_value(section, "lookbackDays", defaults.lookback_days, 7, 180),
        )

    def is_win(self, sharpe_delta: float, challenger_win_rate: float) -> bool:
        return sharpe_delta >= self.sharpe_delta_win_threshold and challenger_win_rate >= self.win_rate_floor

    def is_loss(self, sharpe_delta: float, challenger_win_rate: float) -> bool:
        return sharpe_delta < 0 or challenger_win_rate < self.win_rate_retire_ceil

    def decide_action(self, consecutive_wins: int, consecutive_losses: int, shadow_age_days: int) -> tuple[str, str]:
        if consecutive_wins >= self.consecutive_wins_to_promote:
            return (
                "promote",
                f"{consecutive_wins} consecutive wins "
                f"(sharpe_delta >= {self.sharpe_delta_win_threshold}, win_rate >= {self.win_rate_floor})",
            )
        if consecutive_losses >= self.consecutive_losses_to_retire:
            return "retire", f"{consecutive_losses} consecutive losses"
        if shadow_age_days > self.max_shadow_days:
            return (
                "retire",
                f"shadow age {shadow_age_days}d > max {self.max_shadow_days}d without conclusive result",
            )
        return "hold", ""

    def to_dict(self) -> dict[str, float | int]:
        return {
            "sharpe_delta_win_threshold": self.sharpe_delta_win_threshold,
            "win_rate_floor": self.win_rate_floor,
            "win_rate_retire_ceil": self.win_rate_retire_ceil,
            "consecutive_wins_to_promote": self.consecutive_wins_to_promote,
            "consecutive_losses_to_retire": self.consecutive_losses_to_retire,
            "max_shadow_days": self.max_shadow_days,
            "lookback_days": self.lookback_days,
        }


DEFAULT_CONFIG_POOL_POLICY = ConfigPoolPolicy()


def _policy_section(config: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    for key in ("configPool", "config_pool"):
        value = config.get(key)
        if isinstance(value, dict):
            return value
    alpha_framework = config.get("alphaFramework") or {}
    value = alpha_framework.get("configPool") if isinstance(alpha_framework, dict) else None
    return value if isinstance(value, dict) else {}


def _int_value(section: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(section.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(value, hi))


def _float_value(section: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(section.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(value, hi))
