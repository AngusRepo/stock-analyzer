from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
import json
import pytest
from services import l4_r2_dispatch as dispatch
from services.l4_r2_monthly import PREFIX
from test_l4_tabpack_monthly import Bucket as BaseBucket


class Bucket(BaseBucket):
    def blob(self,key):
        result=super().blob(key);result.name=key;return result


def source():
    return dict(batch_id='b'*64,inputs={'path':'input','sha256':'c'*64})


def test_retries_reuse_preparation_and_exact_three_seed_dispatches():
    bucket=Bucket();calls=[];fits=[]
    def prepare():fits.append(1);return source()
    def spawn(p):calls.append(p);return SimpleNamespace(object_id='fc-'+str(p['seed']))
    first=dispatch.dispatch(bucket,'a'*64,prepare,spawn=spawn)
    again=dispatch.dispatch(bucket,'a'*64,prepare,spawn=spawn)
    assert first['status']==again['status']=='pending'
    assert len(fits)==1 and [p['seed'] for p in calls]==[42,43,44]
    assert not again['promoted']


def test_lost_launch_reply_does_not_repeat_seed():
    bucket=Bucket();calls=[]
    def spawn(p):
        calls.append(p['seed'])
        if p['seed']==42:raise TimeoutError('reply lost')
        return SimpleNamespace(object_id='fc-'+str(p['seed']))
    with pytest.raises(TimeoutError):dispatch.dispatch(bucket,'a'*64,source,spawn=spawn)
    result=dispatch.dispatch(bucket,'a'*64,lambda:pytest.fail('source already frozen'),spawn=spawn)
    assert calls==[42,43,44] and result['status']=='pending'


def test_training_completed_without_checkpoint_verification_is_pending():
    bucket=Bucket()
    for seed in (42,43,44):
        bucket.saved[f'l4_distribution/r2_batches/'+('b'*64)+f'/seed{seed}/completed.json']=b'{"training_completed":true}'
    result=dispatch.dispatch(bucket,'a'*64,source,spawn=lambda p:SimpleNamespace(object_id='fc'))
    assert result['status']=='pending' and result['verified_seeds']==[]


def test_failed_seed_is_terminal_no_second_training():
    bucket=Bucket();bucket.saved['l4_distribution/r2_batches/'+('b'*64)+'/seed42/failed.json']=b'{"status":"failed"}'
    result=dispatch.dispatch(bucket,'a'*64,source,spawn=lambda p:pytest.fail('failed run cannot train'))
    assert result['status']=='failed' and result['failed_seed']==42
    assert not result['dependency_retry_required']


def test_overdue_claim_requires_review_instead_of_looping_forever():
    bucket=Bucket();now=datetime.now(timezone.utc)
    dispatch.dispatch(bucket,'a'*64,source,spawn=lambda p:SimpleNamespace(object_id='fc'),now=now)
    result=dispatch.dispatch(bucket,'a'*64,source,spawn=lambda p:pytest.fail('no duplicate'),now=now+timedelta(hours=9))
    assert result['status']=='failed' and result['reason']=='l4_r2_dispatch_overdue'


def test_new_family_is_candidate_selection_only():
    from services.paper_strategy_mode import refresh_family,validate_model_mode
    from routers.l4_distribution import RefreshRequest
    assert refresh_family({'l4Distribution':{'candidate_model_family':'tabpack_r2'}})=='tabpack_r2'
    assert RefreshRequest(end_date='2026-10-15',cadence='monthly',strategy_role='B',model_family='tabpack_r2').model_family=='tabpack_r2'
    with pytest.raises(ValueError):validate_model_mode({'operating_mode':'single_b_tabpack_r2_v1'})


@pytest.mark.parametrize('cadence',['daily','weekly'])
def test_r2_candidate_override_never_adds_daily_or_weekly_neural_fits(cadence):
    from scripts.l4_distribution_refresh_job import execute
    result=execute(as_of='2026-10-15',cadence=cadence,strategy_role='B',target_l3_artifact_id='parent',model_family='tabpack_r2')
    assert result['status']=='not_requested' and not result['training_dispatched']
