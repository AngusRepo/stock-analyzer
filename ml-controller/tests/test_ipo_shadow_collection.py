import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import pytest
import services.ipo_shadow_collection as collection
from services.ev_lineage_contract import SCORE_SEMANTIC_VERSION, ENSEMBLE_SEMANTIC_VERSION, build_model_set_signature


@pytest.fixture
def inputs(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026,9,7,14,tzinfo=timezone.utc)
    monkeypatch.setattr(collection,'datetime',Clock)
    post_ml={'version':'score_v2','semanticVersion':SCORE_SEMANTIC_VERSION,
             'components':{'mlEdge':15,'fundamentalQuality':10,'chipFlow':12,'technicalStructure':8}}
    ensemble={'semantic_version':ENSEMBLE_SEMANTIC_VERSION,'artifact_versions':{'LightGBM':'frozen-v1'},
              'contributing_models':['LightGBM'],'model_set_signature':build_model_set_signature({'LightGBM':'frozen-v1'},['LightGBM']),
              'target_semantic_version':collection.MODEL_TARGET_SEMANTIC_VERSION}
    raw=[{'stock_id':1,'symbol':'2330','candidate_total_count':1,'recommendation_date':'2026-09-07',
          'prediction_generated_at':'2026-09-07T13:00:00Z','score_components':{'components':{'mlEdge':0}},
          'forecast_data':{'ensemble_v2':ensemble},'reference_feature_rejection_reason':None}]
    monkeypatch.setattr(collection,'load_allocator_ev_snapshot_candidate_rows',lambda *a,**k:raw)
    captured=[]
    def freeze(**kwargs):
        captured.append(kwargs)
        return {'status':'frozen','rows':len(kwargs['rows']),'promotion_allowed':False}
    monkeypatch.setattr(collection,'freeze_daily',freeze)
    def forbidden(*args,**kwargs):
        raise AssertionError('collector must never write outside freeze_daily')
    client=SimpleNamespace(query=lambda *a,**k:[{'symbol':'2330','score_components':json.dumps(post_ml)}], batch_execute=forbidden)
    return raw,post_ml,{name:client for name in ('core','market','learning','ops')},captured


def test_native_collector_uses_post_ml_input_not_pre_ml_zero_and_does_not_require_actionable_buys(inputs):
    raw,post_ml,clients,captured=inputs
    result=collection.collect_native_daily(signal_date='2026-09-07',source_run_id='pipeline',clients=clients)
    assert result['status']=='frozen' and result['training_dispatched'] is False
    assert captured[0]['rows'][0]['row']['score_components']==post_ml


def test_missing_ensemble_is_visible_without_zero_fill_or_partial_freeze(inputs):
    raw,_,clients,captured=inputs
    raw[0]['forecast_data']={}
    raw[0]['reference_feature_rejection_reason']='missing_point_in_time_ensemble_prediction'
    result=collection.collect_native_daily(signal_date='2026-09-07',source_run_id='pipeline',clients=clients)
    assert result['status']=='awaiting_native_inputs' and result['eligible_rows']==0
    assert 'missing_point_in_time_ensemble_prediction' in result['blockers']
    assert captured==[]


def test_dry_run_and_historical_replay_cannot_create_forward_evidence(inputs):
    _,_,clients,captured=inputs
    assert collection.collect_native_daily(signal_date='2026-09-07',source_run_id='pipeline',clients=clients,dry_run=True)['status']=='ready_to_freeze'
    assert collection.collect_native_daily(signal_date='2026-09-04',source_run_id='pipeline',clients=clients)['status']=='historical_not_prospective'
    assert captured==[]


def test_collector_runs_before_formal_snapshot_skip_and_backfill_cannot_refreeze_ipo():
    root=Path(__file__).resolve().parents[2]
    chain=(root/'worker/src/lib/postMarketChain.ts').read_text(encoding='utf-8')
    assert chain.index("'ipo-shadow-native-freeze'") < chain.index('const snapshotUnavailableInEvidenceOnlyMode')
    backfill=(root/'ml-controller/services/allocator_ev_feature_snapshot_backfill.py').read_text(encoding='utf-8')
    assert 'from services.ipo_shadow import freeze_daily' not in backfill
