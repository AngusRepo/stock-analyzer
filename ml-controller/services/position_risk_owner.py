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


PORTFOLIO_CONTRACT_VERSION = 'portfolio-risk-policy-v1'
PORTFOLIO_CONTRACT_FIELD = 'portfolioRiskPolicy'
PORTFOLIO_POLICY_FIELDS = (
    'dailyPnlLossLimit', 'dailyPnlLossLimitPct',
    'marketShockOrangePct', 'marketShockRedPct', 'marketShockBlackPct',
    'breadthOrangeAdvanceRatio', 'breadthRedAdvanceRatio', 'breadthBlackAdvanceRatio',
    'greenTargetExposure', 'yellowTargetExposure', 'orangeTargetExposure', 'redTargetExposure', 'blackTargetExposure',
)
# Paper merges trading:risk_config.portfolio over these program values
# (worker riskConfig.ts DEFAULT_RISK_CONFIG.portfolio, mergeProgramDefaults), so a
# field KV does not set still has this value in Paper. KV stays the owner of any
# field it sets; tests pin this mirror to the worker source.
PAPER_PORTFOLIO_PROGRAM_VALUES = {
    'dailyPnlLossLimit': -30000, 'dailyPnlLossLimitPct': -0.03,
    'marketShockOrangePct': -0.03, 'marketShockRedPct': -0.05, 'marketShockBlackPct': -0.08,
    'breadthOrangeAdvanceRatio': 0.25, 'breadthRedAdvanceRatio': 0.15, 'breadthBlackAdvanceRatio': 0.08,
    'greenTargetExposure': 0.95, 'yellowTargetExposure': 0.68, 'orangeTargetExposure': 0.45,
    'redTargetExposure': 0.20, 'blackTargetExposure': 0,
}


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


def formal_portfolio_risk(risk_config: Any) -> dict[str, Any]:
    """Paper's effective trading:risk_config.portfolio policy as a replay contract.

    Records which fields KV set and which are Paper's program values, so a
    replay result shows the policy it ran under.
    """
    if not isinstance(risk_config, dict):
        raise PositionRiskConfigUnavailable('portfolio_risk_config_unavailable:' + RISK_CONFIG_KEY)
    portfolio = risk_config.get('portfolio')
    if portfolio is None:
        portfolio = {}  # riskConfig.ts mergeProgramDefaults: `raw.portfolio ?? {}`
    if not isinstance(portfolio, dict):
        raise PositionRiskConfigUnavailable('portfolio_risk_config_invalid:' + RISK_CONFIG_KEY)
    policy, from_kv = {}, []
    for name in PORTFOLIO_POLICY_FIELDS:
        value = portfolio[name] if name in portfolio else PAPER_PORTFOLIO_PROGRAM_VALUES[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float('inf'), float('-inf')):
            raise PositionRiskConfigUnavailable(f'portfolio_risk_config_invalid:{RISK_CONFIG_KEY}:{name}')
        policy[name] = value
        if name in portfolio:
            from_kv.append(name)
    return {'contractVersion': PORTFOLIO_CONTRACT_VERSION, **policy,
            'kvFields': from_kv, 'programValueFields': [n for n in PORTFOLIO_POLICY_FIELDS if n not in from_kv],
            'sourceRiskConfigChecksum': _checksum(risk_config)}


def portfolio_risk_policy(contract: Any) -> dict[str, Any]:
    """The validated policy a Mode B replay reads; a missing or foreign contract raises."""
    if not isinstance(contract, dict) or contract.get('contractVersion') != PORTFOLIO_CONTRACT_VERSION:
        raise PositionRiskConfigUnavailable('backtest_portfolio_risk_policy_missing')
    missing = [name for name in PORTFOLIO_POLICY_FIELDS
               if isinstance(contract.get(name), bool) or not isinstance(contract.get(name), (int, float))]
    if missing:
        raise PositionRiskConfigUnavailable('backtest_portfolio_risk_policy_invalid:' + ','.join(missing))
    return {name: float(contract[name]) for name in PORTFOLIO_POLICY_FIELDS}


def _read_risk_config(timeout: float) -> Any:
    from services.kv_client import get_json

    return get_json(RISK_CONFIG_KEY, default=None, timeout=timeout)


def load_formal_position_risk(*, timeout: float = 5.0) -> dict[str, Any]:
    return formal_position_risk(_read_risk_config(timeout))


def load_risk_contracts(*, timeout: float = 5.0) -> tuple[dict[str, Any], dict[str, Any]]:
    """Both replay contracts from one trading:risk_config read."""
    raw = _read_risk_config(timeout)
    return formal_position_risk(raw), formal_portfolio_risk(raw)


def load_formal_portfolio_risk(*, timeout: float = 5.0) -> dict[str, Any]:
    return formal_portfolio_risk(_read_risk_config(timeout))


def with_formal_position_risk(
    trading_config: dict[str, Any],
    *,
    formal: dict[str, Any] | None = None,
    portfolio: dict[str, Any] | None = None,
    keep_existing: bool = False,
) -> dict[str, Any]:
    """A copy of `trading_config` carrying the KV-owned position-risk contract.

    `keep_existing` keeps a contract the config already pins (a frozen baseline
    or an explicitly supplied replay config) after validating it.

    The trading:risk_config portfolio policy (Paper's market-risk exposure caps,
    shock/breadth thresholds and daily-loss limits) rides along as
    `portfolioRiskPolicy` from the same read; a Mode B replay refuses to run
    without it. A caller passing `formal` alone (Mode A) gets no portfolio policy
    unless it passes `portfolio` too.
    """
    from services.backtest_engine import FormalPositionRiskParams

    merged = deepcopy(trading_config or {})
    existing = merged.get(CONTRACT_FIELD)
    keep_position = False
    if keep_existing and existing is not None:
        try:
            if FormalPositionRiskParams.from_config(existing) is None:
                raise ValueError('not_a_mapping')
        except (TypeError, ValueError) as exc:
            raise PositionRiskConfigUnavailable(f'position_risk_contract_invalid:{exc}') from exc
        keep_position = True
    existing_portfolio = merged.get(PORTFOLIO_CONTRACT_FIELD)
    keep_portfolio = keep_existing and existing_portfolio is not None
    if not keep_portfolio:
        merged.pop(PORTFOLIO_CONTRACT_FIELD, None)  # never carry a stale policy forward
    if keep_portfolio:
        portfolio_risk_policy(existing_portfolio)
    load_position = not keep_position and formal is None
    load_portfolio = portfolio is None and not keep_portfolio and (keep_position or formal is None)
    if load_position and load_portfolio:
        merged[CONTRACT_FIELD], merged[PORTFOLIO_CONTRACT_FIELD] = load_risk_contracts()
    elif load_position:
        merged[CONTRACT_FIELD] = load_formal_position_risk()
    elif load_portfolio:
        merged[PORTFOLIO_CONTRACT_FIELD] = load_formal_portfolio_risk()
    if formal is not None and not keep_position:
        merged[CONTRACT_FIELD] = deepcopy(formal)
    if portfolio is not None and not keep_portfolio:
        merged[PORTFOLIO_CONTRACT_FIELD] = deepcopy(portfolio)
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
