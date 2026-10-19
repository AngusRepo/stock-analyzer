from datetime import datetime,timezone
from copy import deepcopy
import pytest
from test_l4_r17_reporting import scenario
from services.l4_r17_session import publish,identity
from services.l4_r17_events import maturity_tick,execution_tick


def event_case():
    args=scenario();objects=args['objects'];reg=objects.get(args['registration_ref'])
    publish(objects,reg['identity'],reg)
    close=objects.get(args['close_ref']);close['identity']=identity('close','test',reg['session_date'])
    publish(objects,close['identity'],close)
    activation={'rules_sha':'rules','weight_timing_sha':'timing','checksum':'activation',
                'first_session_date':reg['session_date']}
    return dict(experiment='test',activation=activation,calendar=reg['calendar'],objects=objects,
                prices=args['prices'],cutoff=args['cutoff'],calendar_proof={'verified_test_fixture':True})


def test_event_census_keeps_missing_registration_days_and_immutable_mature_result():
    args=event_case();out=maturity_tick(**args)
    assert out['acceptance']['count']==1
    assert len(out['daily'])==5
    assert len(out['acceptance']['exclusions'])==4
    assert out['daily'][0]['arms']['A']['primary']==pytest.approx(.06)
    args['prices'][('2026-10-26','x')]['adj_close']=999
    again=maturity_tick(**args)
    assert again==out # Later revised price cannot rewrite the sealed verdict.


def test_pending_labels_not_published_as_mature_and_recomputed_on_next_event():
    args=event_case();args['cutoff']='2026-10-26T12:00:00+08:00'
    out=maturity_tick(**args)
    assert out['acceptance']['count']==0 and out['acceptance']['pending']==['2026-10-19']
    args['cutoff']='2026-10-27T00:00:00+08:00'
    assert maturity_tick(**args)['acceptance']['count']==1


def test_expired_unobserved_frame_never_fetches_current_market_to_backfill():
    args=scenario();objects=args['objects'];reg=objects.get(args['registration_ref'])
    reg['schedule']=[{'stage':'intraday','observed_at':'2026-10-20T09:00:00+08:00'}]
    reg['identity']=identity('registration','missing-frame',reg['session_date'])
    ref=objects.put(reg)
    def forbidden(_):raise AssertionError('must not query market')
    out=execution_tick(registration_ref=ref,objects=objects,runner=None,
        capture_factory=forbidden,source_receipt_factory=forbidden,
        clock=lambda:datetime(2026,10,20,1,2,tzinfo=timezone.utc))
    assert out['status']=='execution_gap' and out['outer_credit']==0


def test_calendar_provenance_required():
    args=event_case();args['calendar_proof']={}
    with pytest.raises(ValueError,match='official_price_calendar'):
        maturity_tick(**args)


def test_delayed_close_is_recoverable_before_label_maturity():
    args=event_case();objects=args['objects'];day=args['activation']['first_session_date']
    from services.paired_nav_journal import digest
    close_key=digest(identity('close','test',day));ref=objects.deliveries.pop(close_key)
    args['cutoff']='2026-10-26T12:00:00+08:00'
    result=maturity_tick(**args)
    assert result['daily'][0]['label_status']=='pending'
    assert objects.lookup_delivery(digest(identity('mature_report','test','2026-10-19'))) is None
    objects.deliveries[close_key]=ref
    args['cutoff']='2026-10-27T00:00:00+08:00'
    assert maturity_tick(**args)['acceptance']['count']==1
