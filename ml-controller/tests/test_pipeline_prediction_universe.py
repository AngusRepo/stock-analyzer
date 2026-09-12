"""Original write-node admission is a batch identity check, not a return gate."""
import asyncio
from copy import deepcopy

import pytest

from graphs import daily_pipeline_v2 as graph


@pytest.fixture
def batch(monkeypatch):
    effects = []
    seeds = [{'symbol': '2330', 'id': 1}, {'symbol': '2317', 'id': 2}]
    predictions = {s['symbol']: {'rank_scores': {'LightGBM': .3},
        'core_family_evidence': {'formal_model_contract_passed': True}} for s in seeds}
    state = {'run_date': '2026-09-22', 'active_stocks': deepcopy(seeds), 'screener_recs': seeds,
        'predictions': predictions, 'final_recommendations': deepcopy(seeds), 'active8_action_authority': {}}
    def fake_effect(name, result):
        def call(*args, **kwargs):
            effects.append((name, args))
            return result
        return call
    for name, result in (('prune_predictions_outside_universe',0), ('write_predictions_to_d1',2),
                         ('write_layer2_timesfm_enrichment_audit',2), ('write_layer3_formal_gate_audit',2),
                         ('update_recommendations_in_d1',2), ('delete_filtered_recommendations',0),
                         ('re_rank_recommendations',0)):
        monkeypatch.setattr(graph, name, fake_effect(name, result))
    return state, effects


@pytest.mark.parametrize('fault', ['unexpected_prediction','missing_prediction','failed_prediction',
                                  'unmapped_seed','foreign_stock_map'])
def test_original_write_node_checks_full_batch_before_any_side_effect(batch, fault):
    state, effects = batch
    if fault == 'unexpected_prediction':
        state['predictions']['9999'] = deepcopy(state['predictions']['2330'])
        state['active_stocks'].append({'symbol': '9999', 'id': 3})
    elif fault == 'missing_prediction':
        state['predictions'].pop('2317')
    elif fault == 'failed_prediction':
        state['predictions']['2317'] = {'error': 'fixture_prediction_failed'}
    elif fault == 'unmapped_seed':
        state['active_stocks'].pop()
    else:
        state['active_stocks'].append({'symbol': '9999', 'id': 3})
    with pytest.raises(RuntimeError, match='prediction_universe_closure_failed'):
        asyncio.run(graph.node_write_d1(state))
    assert effects == []


def test_exact_research_or_hold_batch_is_not_a_profit_or_buy_gate(batch):
    state, effects = batch
    state['predictions']['2317']['l3_model_eligibility'] = {'eligible': False}
    state['predictions']['2317']['prediction_stage'] = 'L2'
    state['predictions']['2330']['signal'] = 'HOLD'
    result = asyncio.run(graph.node_write_d1(state))
    assert effects
    assert result['metrics']['prediction_symbol_closure_passed'] is True
    assert result['metrics']['unexpected_prediction_symbols'] == []
    assert result['metrics']['prediction_symbols'] == 2
    assert result['metrics']['l3_eligible_prediction_symbols'] == 1
