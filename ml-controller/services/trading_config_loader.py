"""Canonical trading:config loader for controller-side workflows.

Worker `getTradingConfig()` is the production source for merged defaults. The
controller must not raw-read `trading:config` and invent its own fallback rules,
otherwise partial KV values create split-brain behavior between Worker and
Cloud Run/Modal orchestration.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import logging
from typing import Any

from services import kv_client
from services.worker_config_client import load_active_trading_config

logger = logging.getLogger(__name__)

REQUIRED_SECTIONS = (
    "ensemble_v2",
    "alphaFramework",
    "ranking",
    "signal",
    "sltp",
    "L2_formula",
)


# Minimal controller-side safety defaults. The preferred path is still the
# Worker admin endpoint, which returns the full Worker DEFAULT_TRADING_CONFIG
# merged with KV. These defaults only prevent local/offline paths from silently
# losing required sections.
DEFAULT_REQUIRED_CONFIG: dict[str, Any] = {
    "ensemble_v2": {
        "strongBuyThreshold": 0.85,
        "buyThreshold": 0.70,
        "sellThreshold": 0.30,
        "strongSellThreshold": 0.15,
        "topKOverrideEnabled": True,
        "topKCount": 3,
        "topKConfidenceOverride": 0.72,
    },
    "alphaFramework": {
        "allocation": {"slateSize": 8, "scoreRoundDecimals": 1, "weights": {}},
        "quality": {
            "outcomeLimit": 1000,
            "minSamples": 30,
            "minRegimeSamples": 6,
            "minBucketSamples": 8,
        },
    },
    "ranking": {
        "enabled": True,
        "topK": 3,
        "alpha": 0.40,
        "beta": 0.40,
        "gamma": 0.20,
        "screenerDenominator": 60.0,
        "promoteMinConf": 0.60,
    },
    "signal": {
        "strongSignalScore": 0.72,
        "buySignalScore": 0.52,
        "holdSignalScore": 0.36,
        "consensusThreshold": 0.60,
        "modelVoteBullishThreshold": 0.55,
        "modelVoteBearishThreshold": 0.45,
        "modelVoteRegimeAdjustments": {
            "bull": -0.02,
            "bear": 0.03,
            "volatile": 0.04,
            "sideways": 0.01,
        },
    },
    "sltp": {
        "slMultBase": 2.0,
        "tpMultBase": 1.5,
        "trailSwitch3pct": 0.03,
        "trailSwitch8pct": 0.08,
        "volThresholdLow": 0.015,
        "volThresholdHigh": 0.03,
    },
    "L2_formula": {
        "confidence_risk_mult": 0.15,
        "confidence_perf_mult": 0.20,
        "confidence_delta_clip_lo": -0.10,
        "confidence_delta_clip_hi": 0.20,
        "confidence_effective_clip_lo": 0.45,
        "confidence_effective_clip_hi": 0.75,
        "bandit_loss_thresh_high": 0.6,
        "bandit_loss_thresh_med": 0.4,
        "bandit_max_mult_high": 1.5,
        "bandit_max_mult_med": 2.0,
        "bandit_max_mult_low": 2.5,
    },
}


@dataclass(frozen=True)
class TradingConfigContract:
    source: str
    raw_present: bool
    degraded: bool
    missing_sections: list[str]
    defaulted_sections: list[str]
    malformed: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "raw_present": self.raw_present,
            "degraded": self.degraded,
            "missing_sections": self.missing_sections,
            "defaulted_sections": self.defaulted_sections,
            "malformed": self.malformed,
            "error": self.error,
        }


@dataclass(frozen=True)
class TradingConfigLoadResult:
    config: dict[str, Any]
    contract: TradingConfigContract


def _is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def deep_merge(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(base)
    if not isinstance(override, dict):
        return out
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def _normalize_required_aliases(config: dict[str, Any]) -> dict[str, Any]:
    out = dict(config)
    if "alphaFramework" not in out and isinstance(out.get("alpha_framework"), dict):
        out["alphaFramework"] = out["alpha_framework"]
    return out


def _missing_required_sections(raw: dict[str, Any] | None) -> list[str]:
    if not isinstance(raw, dict):
        return list(REQUIRED_SECTIONS)
    normalized = _normalize_required_aliases(raw)
    return [section for section in REQUIRED_SECTIONS if not _is_mapping(normalized.get(section))]


def _with_required_defaults(config: dict[str, Any]) -> dict[str, Any]:
    normalized = _normalize_required_aliases(config if isinstance(config, dict) else {})
    return deep_merge(DEFAULT_REQUIRED_CONFIG, normalized)


def get_raw_trading_config() -> dict[str, Any] | None:
    raw = kv_client.get_json("trading:config", default=None)
    return raw if isinstance(raw, dict) else None


def load_merged_trading_config_with_contract(
    *,
    prefer_worker: bool = True,
    timeout: float = 10.0,
) -> TradingConfigLoadResult:
    raw: dict[str, Any] | None = None
    raw_error: str | None = None
    try:
        raw = get_raw_trading_config()
    except Exception as exc:  # pragma: no cover - env/network defensive path
        raw_error = str(exc)
        logger.warning("[trading_config_loader] raw KV config read failed: %s", exc)

    raw_missing = _missing_required_sections(raw)
    raw_present = isinstance(raw, dict)

    if prefer_worker:
        worker_cfg = load_active_trading_config(timeout=timeout)
        if isinstance(worker_cfg, dict) and worker_cfg:
            merged = _normalize_required_aliases(worker_cfg)
            final_missing = _missing_required_sections(merged)
            return TradingConfigLoadResult(
                config=_with_required_defaults(merged),
                contract=TradingConfigContract(
                    source="worker_admin_config",
                    raw_present=raw_present,
                    degraded=bool(final_missing or raw_error),
                    missing_sections=final_missing,
                    defaulted_sections=raw_missing,
                    error=raw_error,
                ),
            )

    merged = _with_required_defaults(raw or {})
    return TradingConfigLoadResult(
        config=merged,
        contract=TradingConfigContract(
            source="direct_kv_merged_required_defaults" if raw_present else "required_defaults_only",
            raw_present=raw_present,
            degraded=True,
            missing_sections=raw_missing,
            defaulted_sections=raw_missing,
            malformed=not raw_present and raw is not None,
            error=raw_error,
        ),
    )


def load_merged_trading_config(*, prefer_worker: bool = True, timeout: float = 10.0) -> dict[str, Any]:
    return load_merged_trading_config_with_contract(prefer_worker=prefer_worker, timeout=timeout).config


def build_trading_config_contract_report(config: dict[str, Any] | None = None) -> dict[str, Any]:
    if config is None:
        return load_merged_trading_config_with_contract().contract.to_dict()
    missing = _missing_required_sections(config)
    return TradingConfigContract(
        source="provided_config",
        raw_present=True,
        degraded=bool(missing),
        missing_sections=missing,
        defaulted_sections=[],
    ).to_dict()
