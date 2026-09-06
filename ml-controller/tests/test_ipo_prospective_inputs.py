import ast
import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.stats import rankdata

import services.ipo_prospective_inputs as consumer
from services.ipo_shadow import checksum

DAY = '2026-09-07'
NOW = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)


def inputs():
    registry = {name: {'artifact_id': name, 'model_name': name, 'version': 'fixed-v1',
        'checksum': 'sha256:' + 'a' * 64, 'candidate_type': 'oof_full_fit_release',
        'training_run_id': 'one-frozen-run', 'source_run_date': '2026-08-30',
        'created_at': '2026-08-30T00:00:00Z'} for name in consumer.ACTIVE8_MODELS}
    signature = consumer.build_model_set_signature({m:'fixed-v1' for m in consumer.ACTIVE8_MODELS}, list(consumer.ACTIVE8_MODELS))
    rows = []
    for stock in range(1, 5):
        for model in consumer.ACTIVE8_MODELS:
            signal = {'artifact_id':model, 'artifact_version':'fixed-v1', 'artifact_checksum':'sha256:'+'a'*64,
                'candidate_type':'oof_full_fit_release', 'production_effect':False,'vote_weight':0,
                'score_semantic_version':consumer.MODEL_SCORE_SEMANTIC_VERSION,
                'target_semantic_version':consumer.MODEL_TARGET_SEMANTIC_VERSION,
                'market_segment':'LISTED','raw_score':stock,'rank_score':(stock-1)/3,
                'model_set_signature':signature}
            rows.append({'id':len(rows)+1,'stock_id':stock,'model_name':model+'::challenger',
                'generated_at':DAY+' 13:00:00','prediction_date':DAY,'availability_status':'observed',
                'model_signal':signal})
    return rows, registry


def stack(rows=None, registry=None):
    original, original_registry = inputs()
    return consumer.stack_predictions(rows if rows is not None else original, day=DAY, now=NOW,
        seal=consumer.load_seal(), registry=registry if registry is not None else original_registry)


def test_exact_persisted_weights_parity_no_fit(monkeypatch):
    import services.active8_oof_stacker as original
    def forbidden(*a, **kw):
        raise AssertionError('fit must not be called')
    for name in ('_fit_ridge', '_fit_selected_ridge', 'build_chronological_oof_stack'):
        monkeypatch.setattr(original, name, forbidden)
    result = stack()
    state = consumer.load_seal()['state']
    x = np.asarray([[s/3]*8+[1.]*8 for s in range(4)])
    expected = x @ np.asarray([state['weights'][k] for k in consumer.STACKER_FEATURE_NAMES]) + state['intercept']
    assert [r['raw'] for r in result.values()] == pytest.approx(expected)
    assert [r['rank'] for r in result.values()] == pytest.approx((rankdata(expected)-1)/3)
    assert len(result)==4


@pytest.mark.parametrize('mutation,error', [
    (lambda r: r.pop(), 'coverage_incomplete'),
    (lambda r: r.append(copy.deepcopy(r[0])), 'duplicate_model_stock'),
    (lambda r: r[0]['model_signal'].update(rank_score=.99), 'rank_universe'),
    (lambda r: r[0]['model_signal'].update(raw_score=float('nan')), 'score_missing'),
    (lambda r: r[0]['model_signal'].update(production_effect=True), 'authority_invalid'),
    (lambda r: r[0]['model_signal'].update(target_semantic_version='wrong'), 'authority_invalid'),
    (lambda r: r[0].update(generated_at='2026-09-08 02:00:00'), 'authority_invalid'),
    (lambda r: r[0].update(generated_at='2026-09-07 01:00:00'), 'authority_invalid'),
    (lambda r: r[0]['model_signal'].update(artifact_checksum='sha256:'+'b'*64), 'identity_mismatch'),
])
def test_source_contract_errors_never_create_subset(mutation, error):
    rows, _ = inputs()
    mutation(rows)
    with pytest.raises(ValueError, match=error):
        stack(rows)


def test_registry_run_mixing_is_rejected():
    _, registry = inputs()
    registry['LightGBM']['training_run_id'] = 'different-run'
    with pytest.raises(ValueError, match='mixed_run'):
        stack(registry=registry)


def test_only_explicit_sequence_history_masks_use_original_stacker_availability():
    rows, _ = inputs()
    reduced = consumer.build_model_set_signature({m:'fixed-v1' for m in consumer.ACTIVE8_MODELS[:5]}, list(consumer.ACTIVE8_MODELS[:5]))
    for row in rows:
        model=row['model_name'].removesuffix('::challenger')
        if row['stock_id']==1:
            row['model_signal']['model_set_signature']=reduced
        if model in consumer.ACTIVE8_MODELS[5:]:
            if row['stock_id']==1:
                row.update(availability_status='unavailable', missingness={
                    'schema_version':'active8-optional-model-missingness-v1',
                    'reason':'active8_sequence_history_contract_unmet_optional_masked',
                    'required_sequence_points':512,'available_sequence_points':400,'production_effect':False,'vote_weight':0})
                row['model_signal'].update(raw_score=None,rank_score=None)
            else:
                row['model_signal']['rank_score']=(row['stock_id']-2)/2
    output=stack(rows)
    assert len(output)==4 and output[1]['models']['DLinear']['raw_score'] is None
    state=consumer.load_seal()['state']
    expected=state['intercept'] + sum(state['weights'][m+'.available'] for m in consumer.ACTIVE8_MODELS[:5])
    expected+=sum(.5*state['weights'][m+'.rank'] for m in consumer.ACTIVE8_MODELS[5:])
    assert output[1]['raw']==pytest.approx(expected)
    rows[5]['missingness']['reason']='runtime_crashed'
    with pytest.raises(ValueError,match='missingness_not_attested'):
        stack(rows)


def test_regime_checksum_and_availability_cutoff():
    import hashlib
    value={'schema_version':'market-regime-state-v1','run_date':DAY,'computed_at':DAY+'T12:00:00Z',
           'source':'hmm','regime_surface':{'bull':.4,'bear':.6}}
    raw=json.dumps(value)
    row={'run_date':DAY,'state_json':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest(),
         'computed_at':value['computed_at'],'persisted_at':DAY+' 12:01:00'}
    assert consumer.verify_regime([row],day=DAY,cutoff=NOW.isoformat())['regime_surface']['bear']==.6
    with pytest.raises(ValueError,match='time_or_semantic'):
        consumer.verify_regime([row],day=DAY,cutoff=DAY+'T11:00:00Z')
    row['state_json']+=' '
    with pytest.raises(ValueError,match='checksum'):
        consumer.verify_regime([row],day=DAY,cutoff=NOW.isoformat())


def test_prospective_boundary_never_credits_previous_research_dates():
    assert consumer.prospective_window(DAY, NOW)
    assert not consumer.prospective_window('2026-08-28', NOW)
    assert not consumer.prospective_window(DAY, datetime(2026,9,8,1,tzinfo=timezone.utc))
    assert consumer.prospective_window(DAY, datetime(2026,9,8,0,59,tzinfo=timezone.utc))
    assert not consumer.prospective_window(DAY, datetime(2026,9,7,5,29,tzinfo=timezone.utc))


@pytest.fixture
def collector(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):
            return NOW
    monkeypatch.setattr(consumer,'datetime',Clock)
    source, registry = inputs()
    candidates = [{'stock_id':s,'symbol':str(s),'feature_available':1,'feature_rejection_reason':None,
        'producer_run_id':'canonical','score_components':{'version':'score_v2',
            'components':{'mlEdge':0,'chipFlow':12,'technicalStructure':7,'fundamentalQuality':0}}}
        for s in range(1,5)]
    monkeypatch.setattr(consumer,'_query_inputs',lambda *a:(candidates,source,registry))
    fundamental = {(DAY,str(s)):{'version':'fundamental_quality_v1','score':9.} for s in range(1,5)}
    sector = {str(s):{'status':'loaded','point_in_time':True,'features':{'sector_alpha_available':1}} for s in range(1,5)}
    monkeypatch.setattr(consumer,'_load_context',lambda *a:(fundamental,sector,{}))
    names=['ml_edge_norm','fundamental_quality_norm','chip_flow_norm','technical_structure_norm','sector_alpha_available']
    monkeypatch.setattr(consumer,'_load_l4',lambda *a:{'checksum':'l4sum','artifact':{
        'feature_names':names,'coefficients':{n:.02 for n in names},'intercept':.005,
        'training_data':{'label_known_max_date':'2026-08-25'},'output_clip':{'min':-.08,'max':.08}}})
    captures=[]
    def freeze(**kwargs):
        captures.append(kwargs)
        return {'status':'frozen','rows':len(kwargs['rows'])}
    monkeypatch.setattr(consumer,'freeze_daily',freeze)
    def forbidden(*a,**kw):
        raise AssertionError('only freeze_daily may write shadow tables')
    clients={k:SimpleNamespace(query=forbidden,batch_execute=forbidden) for k in ('core','market','ops','learning')}
    return candidates,fundamental,captures,clients


def collect(collector, **kwargs):
    return consumer.collect_prospective_daily(signal_date=DAY,source_run_id='pipeline',clients=collector[-1],**kwargs)


def test_collector_full_pair_with_explicit_shadow_lineage(collector):
    result=collect(collector)
    assert result['rows']==4 and result['production_effect'] is False and result['training_dispatched'] is False
    captured=collector[2][0]['rows']
    assert all(r['generation_mode']==consumer.MODE for r in captured)
    assert all(r['input_provenance']['l4_full_features']['sector_alpha_available']==1 for r in captured)
    assert all(r['row']['score_components']['components']['fundamentalQuality']==9 for r in captured)
    assert collector[0][0]['score_components']['components']['mlEdge']==0  # source not mutated


def test_missing_fundamental_never_becomes_seed_zero_or_partial_publication(collector):
    collector[1].pop((DAY,'1'))
    result=collect(collector)
    assert result['status']=='awaiting_shadow_inputs'
    assert result['rejection_counts']=={'fundamental_pit_source_missing':1}
    assert collector[2]==[]


def test_dry_run_cannot_freeze(collector):
    assert collect(collector,dry_run=True)['prospective_credit'] is False
    assert collector[2]==[]


def test_consumer_has_no_remote_write_or_fit_call_path():
    tree=ast.parse(Path(consumer.__file__).read_text(encoding='utf-8'))
    calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call)]
    assert not any(isinstance(n.func,ast.Attribute) and n.func.attr in {'execute','fit','upload_from_string'} for n in calls)
    assert not any(isinstance(n.func,ast.Name) and n.func.id in {'build_chronological_oof_stack','_fit_ridge','build_oof_snapshot_rows'} for n in calls)
    router=(Path(consumer.__file__).parents[1]/'routers/l4_alpha_ev.py').read_text(encoding='utf-8')
    assert "req.input_mode == 'frozen_stacker_prospective'" in router
