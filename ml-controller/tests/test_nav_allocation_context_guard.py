"""An unsealed NAV parent must stop L4 publication before serving writes."""
import asyncio

import pytest

from graphs.daily_pipeline_v2 import _require_frozen_allocation_context, node_write_d1


def test_l4_write_rejects_failed_parent_before_any_database_access():
    state = {
        'l4_pending_plan': {'plan_id': 'unpublished'},
        'paired_nav_collection': {
            'status': 'failed',
            'stage': 'allocation_context_seal',
            'reason': 'paired_nav_strategy_native_holdings_unavailable',
        },
    }
    with pytest.raises(RuntimeError, match=(
        'paired_nav_allocation_context_unavailable:allocation_context_seal:'
        'paired_nav_strategy_native_holdings_unavailable'
    )):
        asyncio.run(node_write_d1(state))


def test_l4_parent_requires_frozen_status_and_digest():
    snapshot_id = 'a' * 64
    assert _require_frozen_allocation_context({
        'status': 'allocation_context_frozen', 'snapshot_id': snapshot_id,
    }) == snapshot_id
    with pytest.raises(RuntimeError, match='paired_nav_allocation_context_unavailable'):
        _require_frozen_allocation_context({'status': 'allocation_context_frozen', 'snapshot_id': 'invalid'})


def test_provider_error_is_not_exposed():
    with pytest.raises(RuntimeError, match='paired_nav_source_or_capture_failed') as exc:
        _require_frozen_allocation_context({
            'status': 'failed', 'stage': 'allocation_context_seal',
            'reason': 'https://private.example/secret',
        })
    assert 'private.example' not in str(exc.value)
