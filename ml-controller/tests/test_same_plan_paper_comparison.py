import json,sqlite3
from copy import deepcopy
import pytest
from tests.test_native_paper_sandbox import native_runner,base_state,frame,read_state,ROOT
from services.same_plan_paper_comparison import compare_same_plan,inspect_state

def state():
    db=sqlite3.connect(':memory:');db.executescript(base_state())
    for name in ('0005_l4_distribution.sql','0007_daily_plan_reviews.sql'):
        db.executescript((ROOT/'worker/domain-migrations/paper'/name).read_text(encoding='utf8'))
    db.execute("INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,revision,payload_json) VALUES(2,'2026-09-07','fixture','plan',0,'{}')")
    db.execute("INSERT INTO paper_daily_plan_heads_v1 VALUES(2,'2026-09-07','fixture','plan')")
    raw='\n'.join(db.iterdump());db.close();return raw

def test_actual_native_pair_and_next_day_continuation(native_runner):
    raw=state();frames=[frame()];source={f['input_id']:f for f in frames};saved=deepcopy(source)
    result=compare_same_plan(states={'fixed_tp':raw,'swing_no_tp':raw},frames=frames,frame_inputs=source,
        account_id=2,variables={},runner=native_runner)
    assert source==saved and not result['production_effect']
    assert result['nav_maturity_credit']==0 and result['paired_nav']==[]
    for value in result['arms'].values():
        with read_state(value) as db:assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0]==92000
    next_frames=[frame('2026-09-08')]
    nxt=compare_same_plan(states={k:v['state_sql'] for k,v in result['arms'].items()},frames=next_frames,
        frame_inputs={f['input_id']:f for f in next_frames},account_id=2,variables={},runner=native_runner,continuation=result['continuation'])
    for value in nxt['arms'].values():
        with read_state(value) as db:assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0]==99000

def test_mismatched_plan_and_reselection_are_rejected_before_execution():
    raw=state();frames=[frame()];args=dict(states={'fixed_tp':raw,'swing_no_tp':raw},frames=frames,
        frame_inputs={f['input_id']:f for f in frames},account_id=2,variables={},runner=ROOT/'not-a-runner')
    args['states']['swing_no_tp']=raw+"\nUPDATE paper_daily_plan_heads_v1 SET plan_id='different';"
    with pytest.raises(ValueError,match='initial_accounts_differ'):compare_same_plan(**args)
    args['states']['swing_no_tp']=raw;args['frames']=[frame(stage='morning')]
    with pytest.raises(ValueError,match='non_execution_frame'):compare_same_plan(**args)

def test_failed_native_pair_produces_no_comparison(native_runner):
    raw=state();frames=[frame()]
    failed=raw+"\nCREATE TRIGGER fail_update BEFORE UPDATE ON paper_accounts BEGIN SELECT RAISE(ABORT,'fixture_fail'); END;"
    with pytest.raises(RuntimeError,match='fixture_fail'):
        compare_same_plan(states={'fixed_tp':failed,'swing_no_tp':failed},frames=frames,
            frame_inputs={f['input_id']:f for f in frames},account_id=2,variables={},runner=native_runner)
