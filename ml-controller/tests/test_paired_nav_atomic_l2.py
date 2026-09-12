"""Actual daily capture -> own-slate L2, with isolated prices/model primitives."""
import asyncio
from copy import deepcopy
import sqlite3

import pytest

from test_paired_nav_atomic_daily_inputs import _setup
import test_paired_nav_atomic_daily_inputs as daily_fixture
from services import payload_builder, modal_client
from services.paired_nav_atomic_l2 import prepare_atomic_l2
from services.paired_nav_atomic_inputs import daily_setup_status
from services.paired_nav_journal import digest


@pytest.mark.parametrize('candidate_fails', [False, True])
@pytest.mark.parametrize('formal_empty', [False, True])
def test_daily_original_l2_uses_own_slate_and_frozen_context_with_retry(monkeypatch, candidate_fails, formal_empty):
    population = daily_fixture._population()
    if formal_empty:
        population['baseline']['rows'] = []
    duplicate = deepcopy(population['replacements'][0])
    duplicate['definition_checksum'] = 'e'*64
    empty = deepcopy(duplicate)
    empty['definition_checksum'] = 'f'*64
    empty['candidate']['rows'] = []
    population['replacements'].extend([duplicate, empty])
    monkeypatch.setattr(daily_fixture, '_population', lambda: deepcopy(population))
    graph, state, _ = _setup(monkeypatch)
    if formal_empty:
        state['active_stocks'] = []
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    state.update(asyncio.run(graph.node_build_payloads(state)))
    # Include a second definition with identical complete inputs, and an empty
    # admitted slate. Neither needs an extra inference or a fabricated pick.
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE canonical_market_daily(stock_id TEXT,date TEXT,adj_close REAL,as_of_date TEXT,source TEXT)')
    for sid, rows in state['payload_source_observations']['sources']['prices_by_id'].items():
        for row in rows:
            db.execute('INSERT INTO canonical_market_daily VALUES(?,?,?,?,?)',
                (str(999 + int(sid)), row['date'], row['close'], row['date'], 'finlab.price'))
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda sql, args, **kw: [dict(r) for r in db.execute(sql, args)])
    monkeypatch.setattr(graph, 'daily_sequence_target_points', lambda: 6)
    monkeypatch.setattr(graph, '_timesfm_l175_release_policy', lambda: {})
    monkeypatch.setattr(graph, '_load_model_pool_versions', lambda: ({'TimesFM': 'active'}, {'TimesFM': 'frozen-v'}, {}, True))
    monkeypatch.setattr(graph, '_load_active8_serving_pool', lambda: ({}, {}))
    monkeypatch.setattr(graph, '_timesfm_sequence_contract_points', lambda pool: 2)
    calls = []
    def forbidden(*a, **kw):
        pytest.fail('candidate/retry must not read mutable policy, version, sequence contract or prices')
    failed_once = False
    async def predict(rows, **kw):
        nonlocal failed_once
        calls.append(deepcopy(rows))
        assert kw['version'] == 'frozen-v' and kw['sequence_contract_points'] == 2
        for name in ('_timesfm_l175_release_policy', '_load_model_pool_versions',
                     '_load_active8_serving_pool', '_timesfm_sequence_contract_points'):
            monkeypatch.setattr(graph, name, forbidden)
        monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', forbidden)
        if candidate_fails and any(r['symbol'] == '1002' for r in rows) and not failed_once:
            failed_once = True
            raise RuntimeError('isolated candidate model failure')
        return {'results': [{'symbol': r['symbol'], 'forecast_pct': .02, 'horizon': 5} for r in rows]}
    monkeypatch.setattr(modal_client, 'timesfm_batch_predict', predict)
    try:
        result = asyncio.run(graph.node_l2_timesfm_enrich(state))
        packet = result['paired_nav_atomic_l2']
        assert result['timesfm_l2_summary']['status'] == ('blocked' if formal_empty else 'ready')
        assert [r['symbol'] for r in result.get('payloads', state['payloads'])] == ([] if formal_empty else ['1000', '1001'])
        if not formal_empty:
            assert result['payloads'][0]['stock_meta']['sector_peer_return_1d'] == 0
            assert [r['symbol'] for r in calls[0]] == ['1000', '1001']
        assert [r['symbol'] for r in calls[0 if formal_empty else 1]] == ['1000', '1002']
        first_calls = 1 if formal_empty else 2
        assert len(calls) == first_calls
        assert packet['slates']['f'*64]['payloads'] == []
        assert 'd'*64 not in packet['slates'], 'unobserved semantic evidence is not empty admission'
        if candidate_fails:
            assert packet['status'] == 'incomplete'
            assert packet['slates']['c'*64]['status'] == packet['slates']['e'*64]['status'] == 'failed'
        else:
            assert packet['status'] == 'l2_payloads_built'
            assert packet['slates']['c'*64]['payloads'][0]['stock_meta']['sector_peer_return_1d'] == .2
            assert packet['slates']['c'*64]['payloads'][0]['stock_meta']['timesfm_l175_sidecar']['features']['forecast_return'] == .02
        assert packet['nav_maturity_credit'] == 0 and packet['promotion_allowed'] is False
        state['paired_nav_atomic_l2'] = deepcopy(packet)
        # A persisted retry calls the original L2 only for previously failed
        # complete-input identities, retaining completed slate outputs.
        retry = asyncio.run(prepare_atomic_l2(state, result, enrich=graph._node_l2_timesfm_enrich))
        assert retry['status'] == 'l2_payloads_built'
        assert len(calls) == first_calls + int(candidate_fails)
        assert retry['slates']['f'*64] == packet['slates']['f'*64]
        assert retry['slates']['c'*64]['payloads'][0]['stock_meta']['sector_peer_return_1d'] == .2
        state['paired_nav_atomic_l2'] = retry
        status = daily_setup_status(state)
        assert status['status'] == 'incomplete' and status['reason'] == 'requires_ml_and_native_execution'
        assert status['unavailable_replacement_count'] == 1
        state.update({k: deepcopy(v) for k, v in result.items() if k != 'paired_nav_atomic_l2'})
        whole_retry = asyncio.run(graph.node_l2_timesfm_enrich(state))
        assert whole_retry['paired_nav_atomic_l2']['status'] == 'l2_payloads_built'
        assert whole_retry['paired_nav_atomic_l2']['slates'] == retry['slates']
        assert len(calls) == first_calls + int(candidate_fails) + int(not formal_empty)
        before = deepcopy(retry)
        state['paired_nav_atomic_pre_l2']['slates']['c'*64][0]['stock_meta']['sector_peer_return_1d'] = .9
        with pytest.raises(ValueError, match='retry_inputs_changed'):
            asyncio.run(prepare_atomic_l2(state, result, enrich=graph._node_l2_timesfm_enrich))
        assert retry == before
    finally:
        db.close()
