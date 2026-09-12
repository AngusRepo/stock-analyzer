"""In-process counterfactual EV injection, never a serving-approval bypass.

The context is entered only by the isolated allocator runner below. JSON rows,
configuration flags and candidate artifact metadata cannot activate it. Every
invocation gets deep-copied rows; the context is reset even on solver failure.
"""
from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from services.paired_nav_journal import digest, number
from services.evidence_contracts import (
    L4_ARTIFACT_CONTRACT_VERSION, L4_EXPECTED_RETURN_SEMANTIC,
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC,
)


@dataclass(frozen=True)
class _Intervention:
    forecasts: dict[str, float] | None
    owner: str | None
    candidate_checksum: str | None
    inherited_state: dict[str, Any]
    opb_prior: dict[str, Any] | None = None
    opb_arms: tuple | None = None


_ACTIVE: ContextVar[_Intervention | None] = ContextVar('isolated_nav_ev_intervention', default=None)


def active_intervention() -> _Intervention | None:
    return _ACTIVE.get()


def counterfactual_ev(row: dict[str, Any]) -> tuple[float, str, dict[str, Any]] | None:
    context = _ACTIVE.get()
    if context is None or context.forecasts is None:
        return None
    symbol = str(row.get('symbol') or '')
    if symbol not in context.forecasts:
        raise ValueError(f'paired_nav_counterfactual_forecast_missing:{symbol}')
    value = context.forecasts[symbol]
    source = 'isolated_counterfactual:' + str(context.owner)
    contract, semantic = (L4_ARTIFACT_CONTRACT_VERSION, L4_EXPECTED_RETURN_SEMANTIC) if context.owner == 'l4_alpha_ev' else (
        ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC)
    return value, source, {
        'expected_return_owner': context.owner, 'expected_return': value,
        'expected_return_semantic': semantic,
        'artifact_contract_version': contract,
        'status': 'counterfactual_not_production_approved',
        'candidate_checksum': context.candidate_checksum,
        'production_effect': False, 'promotion_allowed': False,
        'can_write_order': False,
    }


def run_isolated_allocation(*, inputs: dict[str, Any], inherited_state: dict[str, Any],
                            forecasts: dict[str, Any] | None = None,
                            owner: str | None = None, candidate_checksum: str | None = None,
                            opb_prior: dict[str, Any] | None = None,
                            decision_at: datetime | None = None) -> dict[str, Any]:
    from services.recommendation_service import apply_sparse_tangent_allocation
    from services.paired_nav_collection import allocation_projection

    if _ACTIVE.get() is not None:
        raise RuntimeError('paired_nav_nested_intervention_forbidden')
    if not inputs.get('ranking_config', {}).get('enabled', True):
        raise ValueError('paired_nav_allocator_disabled')
    copied = deepcopy(inputs)
    # Sealed metadata is used only in this isolated runner. It is NOT an accepted
    # parameter of the production allocator and cannot grant control through JSON.
    control_context = copied.pop('nav_control_context', None)
    symbols = [str(row['symbol']) for row in copied['recommendations']]
    if len(symbols) != len(set(symbols)):
        raise ValueError('paired_nav_duplicate_allocation_symbols')
    normalized = None
    opb_arms = None
    if opb_prior is not None:
        if owner != 'opb_arm_prior' or forecasts is not None:
            raise ValueError('paired_nav_opb_intervention_identity_invalid')
        from services.paired_nav_opb_prior import verify_opb_prior
        opb_arms = verify_opb_prior(opb_prior, checksum=candidate_checksum, decision_at=decision_at)
    elif forecasts is not None:
        if (owner not in {'l4_alpha_ev', 'allocator_ev_fusion'} or not isinstance(candidate_checksum, str)
                or len(candidate_checksum) != 64 or any(c not in '0123456789abcdef' for c in candidate_checksum)):
            raise ValueError('paired_nav_intervention_identity_missing')
        if set(forecasts) != set(symbols):
            raise ValueError('paired_nav_counterfactual_universe_mismatch')
        normalized = {symbol: number(value, 'forecast:' + symbol) for symbol, value in forecasts.items()}
    elif owner is not None or candidate_checksum is not None:
        raise ValueError('paired_nav_baseline_identity_without_forecasts')
    captured = []
    token = _ACTIVE.set(_Intervention(normalized, owner, candidate_checksum, deepcopy(inherited_state),
                                     deepcopy(opb_prior), opb_arms))
    try:
        from services.opb_nav_control import control_scope, replay_nav_control
        with control_scope(replay_nav_control(control_context) if control_context is not None else None):
            rows = apply_sparse_tangent_allocation(**copied, allocation_evidence_sink=lambda packet: captured.append(deepcopy(packet)))
    finally:
        _ACTIVE.reset(token)
    if len(captured) != 1:
        raise RuntimeError('paired_nav_isolated_allocation_capture_missing')
    if opb_prior is not None and (captured[0].get('opb_packet') or {}).get('status') != 'ok':
        raise RuntimeError('paired_nav_opb_candidate_not_executed')
    return {'schema_version': 'isolated-native-sparse-intervention-v1',
            'input_checksum': digest(inputs), 'candidate_checksum': candidate_checksum,
            'owner': owner or 'incumbent', 'output': allocation_projection(rows), 'capture': captured[0],
            'recommendations': deepcopy(rows),
            'production_effect': False, 'promotion_allowed': False, 'can_write_order': False,
            'execution_parity_decision': 'NOT_EVALUATED', 'nav_maturity_credit': 0}
