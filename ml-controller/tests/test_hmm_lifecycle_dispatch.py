import asyncio
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from routers import regime
from services import hmm_maintenance_dispatch as dispatch
from services.hmm_decision_lineage import decision_lineage
from services.hmm_input_contract import CONTRACT_HASH, SOURCE, checksum


@pytest.fixture(autouse=True)
def no_modal_app_inventory(monkeypatch):
    # maintenance_only preflights start the Modal inventory; never reach Modal or ops D1 here.
    from services import modal_app_inventory
    monkeypatch.setattr(modal_app_inventory, 'start_background', lambda: None)


def meta(now, age=1):
    return {'trained_at': (now-timedelta(days=age)).isoformat(), 'input_contract': CONTRACT_HASH,
            'artifact_generation': '1', 'artifact_sha256': 'a'*64}


def policy():
    return {'schema_version': 'hmm-maintenance-policy-v1', 'enabled': True, 'approved_by': 'Wei',
            'approval_ref': 'TEST_ONLY', 'input_contract': CONTRACT_HASH, 'target_prefix': 'market_regime',
            'refresh_after_days': 7, 'max_age_days': 9, 'max_attempts_per_input': 2}


@pytest.mark.parametrize('days,seconds,ready', [(9,-1,True),(9,0,True),(9,1,False),(-1,0,False)])
def test_dispatch_clock_matches_exact_hard_age(days, seconds, ready):
    now = datetime(2026,10,19,tzinfo=timezone.utc)
    metadata = meta(now)
    metadata['trained_at'] = (now-timedelta(days=days,seconds=seconds)).isoformat()
    assert dispatch.model_coverage(metadata,now,now)['ready'] is ready


def test_daily_preflight_dispatches_without_waiting_for_training(monkeypatch):
    now = datetime.now(timezone.utc)
    day = now.astimezone(regime.TW_TZ).date().isoformat()
    monkeypatch.setattr(regime,'latest_hmm_input_date',lambda _:day)
    # History ends on the TW business day the preflight requests, not the UTC date
    # (they differ every day from TW 00:00 to 08:00).
    history = {(date.fromisoformat(day)-timedelta(days=i)).isoformat(): {'market_return_1d':.001,
        'market_return_5d':.005,'risk_score':10,'market_bias_20d':.01,'realized_vol_3d':.002,
        'benchmark_source':SOURCE,'risk_quality_status':'score_verified'} for i in range(40)}
    monkeypatch.setattr(regime,'_fetch_market_env_via_payload_builder',lambda _: {
        'requested_run_date':day,'hmm_input_checksum':checksum(history),'hmm_input_contract':CONTRACT_HASH,
        'history':history,'risk_quality_checksum':'c'*64})
    monkeypatch.setattr(dispatch,'read_maintenance_state',lambda:(meta(now,8),policy(),None))
    monkeypatch.setattr(dispatch,'read_maintenance_attempt',lambda _:None)
    calls=[]
    async def spawn(payload):
        calls.append(payload)
        return 'TEST_CALL'
    monkeypatch.setattr(dispatch,'dispatch_maintenance',spawn)
    result=asyncio.run(regime.regime_preflight(regime.RegimePreflightRequest(
        run_date=day,required_until=(now+timedelta(days=2)).isoformat())))
    assert result['ready'] is False and result['usable_now'] is True
    assert result['maintenance']=='dispatched' and result['maintenance_call_id']=='TEST_CALL'
    assert len(calls)==1 and calls[0]['mode']=='live'
    assert datetime.fromisoformat(calls[0]['market_env']['inference_as_of']) >= now


def test_unapproved_or_fresh_maintenance_does_not_load_training_data(monkeypatch):
    now=datetime.now(timezone.utc)
    monkeypatch.setattr(regime,'latest_hmm_input_date',lambda _:'2026-10-16')
    monkeypatch.setattr(regime,'_fetch_market_env_via_payload_builder',lambda _:pytest.fail('unexpected data load'))
    for metadata, approval, expected in [(meta(now),policy(),'not_due'),(meta(now,8),None,'not_approved')]:
        monkeypatch.setattr(dispatch,'read_maintenance_state',lambda:(metadata,approval,None))
        result=asyncio.run(regime.regime_preflight(regime.RegimePreflightRequest(
            required_until=(now+timedelta(days=1)).isoformat(),maintenance_only=True)))
        assert result['maintenance']==expected


def test_backfill_cannot_trigger_production_maintenance(monkeypatch):
    now=datetime.now(timezone.utc)
    monkeypatch.setattr(regime,'latest_hmm_input_date',lambda _:'2026-10-16')
    with pytest.raises(HTTPException) as err:
        asyncio.run(regime.regime_preflight(regime.RegimePreflightRequest(
            run_date='2026-10-15',required_until=(now+timedelta(days=1)).isoformat())))
    assert err.value.status_code==409


def test_lineage_requires_complete_clocks_identity_and_input_contract():
    now=datetime.now(timezone.utc)
    day=now.date().isoformat()
    contract={'run_date':day,'computed_at':now.isoformat(), 'regime_evidence':{'hmm_provenance':{
        'feature_date':day,'inference_as_of':now.isoformat(),'input_contract':CONTRACT_HASH,
        'input_checksum':'b'*64,'risk_quality_checksum':'c'*64,
        'model':{'sha256':'a'*64,'generation':'1','trained_at':(now-timedelta(days=1)).isoformat(),
                 'input_contract':CONTRACT_HASH}}}}
    assert decision_lineage(contract,day,now=now)['modelGeneration']=='1'
    for field,value in [('trained_at',(now-timedelta(days=9,seconds=1)).isoformat()),
                        ('trained_at',(now+timedelta(seconds=1)).isoformat()),
                        ('generation',''),('input_contract','legacy')]:
        bad=deepcopy(contract)
        bad['regime_evidence']['hmm_provenance']['model'][field]=value
        with pytest.raises(ValueError):decision_lineage(bad,day,now=now)


def test_live_previous_session_uses_current_clock_and_persists_new_model_provenance(monkeypatch):
    now=datetime.now(timezone.utc)
    day=(now.date()-timedelta(days=3)).isoformat()
    monkeypatch.setattr(regime,'ML_SERVICE_URL','https://ml.invalid')
    monkeypatch.setattr(regime,'latest_hmm_input_date',lambda _:day)
    env={'requested_run_date':day,'market_proxy_latest_date':day,'history':{day:{}},
         'hmm_input_checksum':'b'*64,'risk_quality_checksum':'c'*64,'inference_as_of':day+'T23:59:59+08:00'}
    monkeypatch.setattr(regime,'_fetch_market_env_via_payload_builder',lambda _:deepcopy(env))
    async def inference(client,*,market_env,**kwargs):
        assert datetime.fromisoformat(market_env['inference_as_of']) >= now
        return {'regime_label_en':'sideways','regime_index':2,'feature_date':day,
                'regime_surface':{'bull_market':.1,'volatile':.1,'sideways':.7,'bear_market':.1},
                'hmm_provenance':{'input_contract':CONTRACT_HASH,'input_checksum':'b'*64,
                    'risk_quality_checksum':'c'*64,'inference_as_of':market_env['inference_as_of']}}
    monkeypatch.setattr(regime,'_request_regime_current',inference)
    monkeypatch.setattr(regime,'build_regime_evidence_pack',lambda *a,**kw:{
        'effective_label':'sideways','transition_guard':{},'monitors':{}})
    captured={}
    monkeypatch.setattr(regime,'push_optuna_result',lambda **kw:captured.update(kw) or {'success':True})
    result=asyncio.run(regime.regime_compute(regime.RegimeComputeRequest(run_date=day,live=True)))
    assert result['kv_push_ok'] is True
    assert captured['meta']['run_date']==day
    assert datetime.fromisoformat(captured['params']['regime_evidence']['hmm_provenance']['inference_as_of']) >= now
