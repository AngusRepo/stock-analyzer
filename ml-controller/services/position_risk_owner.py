"""Single owner of the backtest position-risk contract (K16a).

The L4 policy-v2 activation deletes `trading:config.position.maxPctOfPortfolio`;
`trading:risk_config.position` is then the only owner of the single-name cap,
the sector limit and the correlation rule (services/l4_policy_activation.py).
Every replay entry injects that contract through this module, and
replay_period refuses to run without it instead of falling back to a cap.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

RISK_CONFIG_KEY = 'trading:risk_config'
CONTRACT_VERSION = 'position-risk-distribution-v1'
CONTRACT_FIELD = 'positionRiskDistribution'


class PositionRiskConfigUnavailable(RuntimeError):
    pass


def _checksum(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def formal_position_risk(risk_config: Any) -> dict[str, Any]:
    """The replay contract built from raw `trading:risk_config`; a missing or invalid field raises."""
    from services.backtest_engine import FormalPositionRiskParams

    position = risk_config.get('position') if isinstance(risk_config, dict) else None
    if not isinstance(position, dict):
        raise PositionRiskConfigUnavailable('position_risk_config_unavailable:' + RISK_CONFIG_KEY)
    formal = {
        'contractVersion': CONTRACT_VERSION,
        'maxPerSector': position.get('maxPerSector'),
        'maxSingleNamePct': position.get('maxSingleNamePct'),
        'correlationThreshold': position.get('correlationThreshold'),
        'correlationWindow': position.get('correlationWindow'),
        'minCorrelationOverlap': 20,
        'sourceRiskConfigChecksum': _checksum(risk_config),
    }
    try:
        FormalPositionRiskParams.from_config(formal)
    except (TypeError, ValueError) as exc:
        raise PositionRiskConfigUnavailable(f'position_risk_config_invalid:{RISK_CONFIG_KEY}:{exc}') from exc
    return formal


def load_formal_position_risk(*, timeout: float = 5.0) -> dict[str, Any]:
    from services.kv_client import get_json

    return formal_position_risk(get_json(RISK_CONFIG_KEY, default=None, timeout=timeout))


def with_formal_position_risk(
    trading_config: dict[str, Any],
    *,
    formal: dict[str, Any] | None = None,
    keep_existing: bool = False,
) -> dict[str, Any]:
    """A copy of `trading_config` carrying the KV-owned position-risk contract.

    `keep_existing` keeps a contract the config already pins (a frozen baseline
    or an explicitly supplied replay config) after validating it.
    """
    from services.backtest_engine import FormalPositionRiskParams

    merged = deepcopy(trading_config or {})
    existing = merged.get(CONTRACT_FIELD)
    if keep_existing and existing is not None:
        try:
            if FormalPositionRiskParams.from_config(existing) is None:
                raise ValueError('not_a_mapping')
        except (TypeError, ValueError) as exc:
            raise PositionRiskConfigUnavailable(f'position_risk_contract_invalid:{exc}') from exc
        return merged
    merged[CONTRACT_FIELD] = deepcopy(formal) if formal is not None else load_formal_position_risk()
    return merged


def require_position_risk_contract(config: Any) -> None:
    """Search preflight: per-trial replay errors become penalties, so a missing contract must fail here."""
    from services.backtest_engine import (
        FormalPositionRiskParams, PositionRiskContractMissing, position_risk_contract,
    )

    try:
        formal = FormalPositionRiskParams.from_config(position_risk_contract(config if isinstance(config, dict) else {}))
    except (TypeError, ValueError) as exc:
        raise PositionRiskContractMissing(f'backtest_position_risk_contract_invalid:{exc}') from exc
    if formal is None:
        raise PositionRiskContractMissing('backtest_position_risk_contract_missing')
