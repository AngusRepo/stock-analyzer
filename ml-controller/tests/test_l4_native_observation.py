import copy,json,hashlib
from datetime import datetime,timezone
import pytest
from services import l4_native_observation as native
from services.l4_forward_materialization import digest
from test_l4_forward_refresh import RefreshTests


def test_native_snapshot_enters_same_daily_maturity_registry():
    fixture=RefreshTests();fixture.setUp()
    from services.l4_forward_refresh import refresh
    result=refresh(query=lambda *a:[],bucket=fixture.bucket,price_capture={},
        expected_identity={'id':1},cutoff='2026-10-09T10:00:00+08:00',
        native_reader=lambda *a,**k:[(fixture.snapshot,{'path':'native','sha256':'c'*64})],
        price_loader=lambda *a,**k:(fixture.calendar,fixture.prices,{}))
    assert result['latest_training_eligible_date']=='2026-10-01'
    assert result['latest_observed_signal_date']=='2026-10-01'
    assert result['source_count']==1
    assert not result['training_dispatched']


def test_incomplete_native_day_does_not_become_training_data():
    fixture=RefreshTests();fixture.setUp();fixture.prices.clear()
    from services.l4_forward_refresh import refresh
    result=refresh(query=lambda *a:[],bucket=fixture.bucket,price_capture={},
        expected_identity={'id':1},cutoff='2026-10-09T10:00:00+08:00',
        native_reader=lambda *a,**k:[(fixture.snapshot,{})],
        price_loader=lambda *a,**k:(fixture.calendar,fixture.prices,{}))
    assert result['latest_training_eligible_date'] is None
    assert result['items'][0]['status']=='incomplete_labels'


def test_reference_readback_detects_changed_original():
    fixture=RefreshTests();fixture.setUp()
    fixture.bucket.data['sealed']=b'{"version":1}'
    ref={'path':'sealed','sha256':hashlib.sha256(fixture.bucket.data['sealed']).hexdigest()}
    assert native.read_reference(fixture.bucket,ref)=={'version':1}
    fixture.bucket.data['sealed']=b'{"version":2}'
    with pytest.raises(ValueError,match='reference_hash'):native.read_reference(fixture.bucket,ref)


def test_mismatched_or_partial_prediction_universe_is_rejected():
    with pytest.raises(ValueError,match='full_inference_coverage'):
        native.projection({},identity={},day='2026-10-15',roster=[{'symbol':'1101'}],
            classification={},known_max='2026-10-01')


def test_partial_classification_cannot_shrink_pool():
    with pytest.raises(ValueError,match='classification_incomplete'):
        native.projection({'1101':{}},identity={},day='2026-10-15',roster=[{'symbol':'1101'}],
            classification={'accepted_evidence':{'1102':{'cfi':'ESVUFR'}},'excluded_symbols':[]},known_max='2026-10-01')
