"""Major 3: under R33 the native L4 refresh callers skip instead of failing. Synthetic only."""
import asyncio
import ast
import inspect
from types import SimpleNamespace

import pytest

from services import paper_strategy_mode
from services.paper_strategy_mode import R33_MODE, r33_native_refresh_skip


def test_skip_receipt_only_under_r33():
    skipped = r33_native_refresh_skip({'l4Distribution': {'operating_mode': R33_MODE}}, cohort_id='c', as_of='2026-11-13')
    assert skipped == {'status': 'skipped', 'reason': 'r33_has_no_native_l4_refresh', 'operating_mode': R33_MODE,
                       'training_dispatched': False, 'promoted': False, 'cohort_id': 'c', 'as_of': '2026-11-13'}
    for config in ({}, None, {'l4Distribution': {'operating_mode': paper_strategy_mode.MLP_MODE}}):
        assert r33_native_refresh_skip(config) is None
    with pytest.raises(ValueError, match='paper_r33_has_no_l4_refresh_family'):
        paper_strategy_mode.refresh_family({'l4Distribution': {'operating_mode': R33_MODE}})


@pytest.mark.parametrize('mode', [R33_MODE, paper_strategy_mode.MLP_MODE])
def test_materialize_endpoint_skips_native_refresh_under_r33(monkeypatch, mode):
    from routers import walk_forward
    from services import l4_oof_lifecycle, trading_config_loader, walk_forward_retrain
    calls = []
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
                        lambda: SimpleNamespace(config={'l4Distribution': {'operating_mode': mode}}))
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: object())

    async def native(**kwargs):
        calls.append(kwargs)
        return {'status': 'materialized'}
    monkeypatch.setattr(l4_oof_lifecycle, 'materialize_native_base', native)
    req = walk_forward.OofMaterializeRequest(cohort_id='c1', knowledge_cutoff_date='2026-11-13', dry_run=True)
    result = asyncio.run(walk_forward.materialize_walk_forward_oof(req))
    if mode == R33_MODE:
        assert result['status'] == 'skipped' and result['reason'] == 'r33_has_no_native_l4_refresh' and calls == []
    else:
        assert result == {'status': 'materialized'} and calls[0]['model_family'] == 'full_mlp_median'


def test_lifecycle_skips_before_the_native_refresh():
    """The lifecycle's native branch checks the R33 skip before refresh_family/materialize_native_base."""
    from routers import walk_forward
    tree = ast.parse(inspect.getsource(walk_forward.run_walk_forward_oof_lifecycle).lstrip())
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and any(isinstance(n, ast.Call) and getattr(n.func, 'id', None) == 'materialize_native_base'
                                            for n in ast.walk(node)):
            body = ast.unparse(node)
            assert body.index('r33_native_refresh_skip(config') < body.index('refresh_family(config)')
            assert 'return skipped' in body
            return
    raise AssertionError('native branch not found')
