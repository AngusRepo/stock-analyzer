"""Actual daily capture -> own-slate L2, with isolated prices/model primitives."""
import asyncio
from copy import deepcopy
from services.pipeline_slate_artifacts import load
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
    calls = []
    failed_once = False
    prepare = graph._node_prepare_sequence_inputs
    async def isolated(child):
        nonlocal failed_once
        symbols = [p['symbol'] for p in child['payloads']]
        calls.append(symbols)
        if candidate_fails and '1002' in symbols and not failed_once:
            failed_once = True
            raise ValueError('isolated candidate sequence source failure')
        return await prepare(child)
    monkeypatch.setattr(graph, '_node_prepare_sequence_inputs', isolated)
    async def forbidden(*args, **kwargs):pytest.fail('retired TimesFM inference')
    monkeypatch.setattr(modal_client, 'timesfm_batch_predict', forbidden)
    before_payloads = deepcopy(state['payloads'])
    try:
        result = asyncio.run(graph.node_prepare_sequence_inputs(state))
        packet = result['paired_nav_atomic_l2']
        assert result['sequence_input_summary']['status'] == 'ready'
        assert result.get('payloads', state['payloads']) == before_payloads
        assert load(packet['slates']['f'*64]['payloads']) == []
        assert 'd'*64 not in packet['slates']
        if candidate_fails:
            assert packet['status'] == 'incomplete'
            assert packet['slates']['c'*64]['status'] == packet['slates']['e'*64]['status'] == 'failed'
        else:
            assert packet['status'] == 'l2_payloads_built'
        first_calls = len(calls)
        state['paired_nav_atomic_l2'] = deepcopy(packet)
        monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query',
            lambda *args, **kwargs:pytest.fail('retry must use frozen prices'))
        retry = asyncio.run(prepare_atomic_l2(state, result, enrich=graph._node_prepare_sequence_inputs))
        assert retry['status'] == 'l2_payloads_built'
        assert len(calls) == first_calls + int(candidate_fails)
        assert retry['slates']['f'*64] == packet['slates']['f'*64]
        candidate = load(retry['slates']['c'*64]['payloads'])
        assert candidate[0]['stock_meta']['sector_peer_return_1d'] == .2
        assert all('timesfm_l175_sidecar' not in p.get('stock_meta', {}) for p in candidate)
        assert packet['nav_maturity_credit'] == 0 and packet['promotion_allowed'] is False
        state['paired_nav_atomic_l2'] = retry
        status = daily_setup_status(state)
        assert status['status'] == 'incomplete' and status['reason'] == 'requires_ml_and_native_execution'
        state.update({k:deepcopy(v) for k,v in result.items() if k != 'paired_nav_atomic_l2'})
        whole_retry = asyncio.run(graph.node_prepare_sequence_inputs(state))
        assert whole_retry['paired_nav_atomic_l2']['slates'] == retry['slates']
        before = deepcopy(retry)
        state['paired_nav_atomic_pre_l2']['slates']['c'*64] = load(state['paired_nav_atomic_pre_l2']['slates']['c'*64])
        state['paired_nav_atomic_pre_l2']['slates']['c'*64][0]['stock_meta']['sector_peer_return_1d'] = .9
        with pytest.raises(ValueError, match='retry_inputs_changed'):
            asyncio.run(prepare_atomic_l2(state, result, enrich=graph._node_prepare_sequence_inputs))
        assert retry == before
    finally:
        db.close()
