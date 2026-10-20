import hashlib
import sqlite3
import pytest
from services.l4_challenger_comparison import seal
from services.l4_shadow_accounts import Accounts,PREFIX
from test_l4_challenger_registry import setup,entry
from test_native_paper_sandbox import native_runner,base_state,frame


def init(runner):
    bucket,registry,champ,formal=setup();state=registry.initialize(champ)
    challenger=entry('p6-raw-independent',letter='b')
    registry.register(challenger,expected_registry_checksum=state['checksum'])
    accounts=Accounts(registry,runner=runner)
    raw=base_state();sha=hashlib.sha256(raw.encode()).hexdigest()
    initial={}
    for model in (champ,challenger):
        initial[model['entry_id']]=accounts.initialize(model['entry_id'],state_sql=raw,state_checksum=sha,account_id=2,
            opening_receipt=seal(dict(scope='paper_shadow',state_checksum=sha,source='synthetic_native_settlement_fixture')))
    return accounts,initial,champ,challenger,bucket,formal


def cash(head):
    with sqlite3.connect(':memory:') as db:
        db.executescript(head['state_sql'])
        return dict(db.execute('SELECT id,cash FROM paper_accounts').fetchall())


def advance(accounts,model,head,day):
    f=frame(day)
    return accounts.advance(model['entry_id'],action_id=day+':settlement',expected_state_checksum=head['checksum'],
        serving_identity=model['serving_identity'],frames=[f],frame_inputs={f['input_id']:f},variables={})


def test_real_native_accounts_continue_independently_and_retries_never_settle_twice(native_runner):
    a,initial,champ,challenger,bucket,formal=init(native_runner)
    first=advance(a,champ,initial[champ['entry_id']],'2026-09-07')
    assert first['outer_acceptance_credit']==0 and not first['production_effect']
    assert cash(a.current(champ['entry_id'])[0])=={1:999999,2:92000}
    assert cash(a.current(challenger['entry_id'])[0])=={1:999999,2:90000}
    assert advance(a,champ,initial[champ['entry_id']],'2026-09-07')==first
    head=a.current(champ['entry_id'])[0]
    second=advance(a,champ,head,'2026-09-08')
    assert second['previous_checksum']==head['checksum']
    assert cash(a.current(champ['entry_id'])[0])=={1:999999,2:99000}
    advance(a,challenger,initial[challenger['entry_id']],'2026-09-07')
    assert cash(a.current(challenger['entry_id'])[0])=={1:999999,2:92000}
    assert formal[0]==champ['serving_identity']
    assert a.initialize(champ['entry_id'],state_sql=initial[champ['entry_id']]['state_sql'],
        state_checksum=initial[champ['entry_id']]['state_checksum'],account_id=2,
        opening_receipt=initial[champ['entry_id']]['opening_receipt'])['checksum']==second['state_checksum']
    assert all(p.startswith(('l4_distribution/challenger_registry/v1/',PREFIX)) for p in bucket.writes)


def test_wrong_full_chain_stale_state_and_rewind_rejected(native_runner):
    a,initial,champ,challenger,_,_=init(native_runner);head=initial[champ['entry_id']];f=frame()
    with pytest.raises(ValueError,match='identity'):
        a.advance(champ['entry_id'],action_id='x',expected_state_checksum=head['checksum'],
            serving_identity=challenger['serving_identity'],frames=[f],frame_inputs={f['input_id']:f},variables={})
    advance(a,champ,head,'2026-09-07')
    with pytest.raises(ValueError,match='stale'):
        advance(a,champ,head,'2026-09-08')
    latest=a.current(champ['entry_id'])[0]
    with pytest.raises(ValueError,match='clock'):
        a.advance(champ['entry_id'],action_id='rewind',expected_state_checksum=latest['checksum'],
            serving_identity=champ['serving_identity'],frames=[f],frame_inputs={f['input_id']:f},variables={})


def test_post_head_crash_recovers_action_without_rerunning_native(native_runner,monkeypatch):
    a,initial,champ,_,_,_=init(native_runner);head=initial[champ['entry_id']];original=a._put
    def fail_action(path,value):
        if '/actions/' in path:raise RuntimeError('simulated_delivery_failure')
        return original(path,value)
    monkeypatch.setattr(a,'_put',fail_action)
    with pytest.raises(RuntimeError,match='delivery'):
        advance(a,champ,head,'2026-09-07')
    assert cash(a.current(champ['entry_id'])[0])[2]==92000
    monkeypatch.setattr(a,'_put',original)
    import services.l4_shadow_accounts as module
    def forbidden(**kwargs):raise AssertionError('must_not_execute_twice')
    monkeypatch.setattr(module,'run_native_paper_frames',forbidden)
    receipt=advance(a,champ,head,'2026-09-07')
    assert receipt['state_checksum']==a.current(champ['entry_id'])[0]['checksum']
    assert cash(a.current(champ['entry_id'])[0])[2]==92000


def test_existing_full_session_same_minute_order_and_across_actions():
    from services.l4_shadow_accounts import validate_frame_order
    from services.paired_native_session import session_schedule, STRATEGY_SESSION_POLICY
    frames=session_schedule('2026-09-07',policy=STRATEGY_SESSION_POLICY)
    validate_frame_order(frames,None)
    assert frames[0]['observed_at']==frames[1]['observed_at']
    validate_frame_order(frames[1:],frames[0])
    with pytest.raises(ValueError,match='clock_not_forward'):
        validate_frame_order([frames[1],frames[0]],None)
    with pytest.raises(ValueError,match='clock_not_forward'):
        validate_frame_order([frames[0]],frames[0])
    with pytest.raises(ValueError,match='clock_not_forward'):
        validate_frame_order([frames[0]],frames[1])
