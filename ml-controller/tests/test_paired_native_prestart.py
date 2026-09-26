from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

import pytest

from services import paired_native_prestart as repair
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from services.paired_nav_comparison import resolve_comparison
from services.paired_nav_execution_environment import execution_policy
from services.paired_native_collector import collect_frame, frame_identity
from services.native_paper_sandbox import native_execution_identity
from services.native_paper_source_capture import ImmutableNativeObjects, NativeSourceCapture
from test_native_paper_sandbox import native_runner
from test_native_paper_source_capture import Bucket
from test_paired_native_session import paired_fixture
from test_paired_nav_journal import DB
from test_paired_nav_execution_environment import environment_packet

FRIDAY = datetime(2026, 9, 4, 14, tzinfo=timezone.utc)
SUNDAY = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)


def fixture(runner):
    original, args = paired_fixture(runner)
    packet = read_snapshot(original.query, args['snapshot_id'])['payload']['content']
    original.conn.close()
    db = DB()
    migration = Path(__file__).parents[2]/'worker/domain-migrations/learning/0054_native_prestart_successions.sql'
    db.conn.executescript(migration.read_text())
    objects = ImmutableNativeObjects(Bucket())
    env = environment_packet('native-paper-v1:'+'a'*64, day='2026-09-04');env['account_id']=2
    packet['execution_owner_version'] = env['execution_owner_version']
    formal = {'payload_checksum': packet['baseline_checksum']}
    parent = freeze_snapshot(signal_date='2026-09-04', source_run_id='original-inputs', snapshot_kind='allocation_context',
        content={'formal_baseline_identity':formal,'formal_output':[], 'native_execution_environment':env},
        query=db.query, writer=db.writer, now=FRIDAY)
    configuration = {k:v for k,v in packet['configuration'].items() if k!='fees'}
    configuration.update(formal_baseline_identity=formal,native_execution_policy=execution_policy(env))
    plan = {'pair_id':digest(['original']), 'owner':'ensemble', 'candidate_checksum':packet['candidate_checksum'],
        'baseline_checksum':packet['baseline_checksum'], 'configuration':configuration,'configuration_checksum':digest(configuration),
        'allocation_context_snapshot_id':parent['snapshot_id'], 'baseline':{'output':[]}, 'candidate':{'output':[]}}
    am=freeze_snapshot(signal_date='2026-09-04', source_run_id=plan['pair_id'], snapshot_kind='allocation_pair',
        content=plan,query=db.query,writer=db.writer,now=FRIDAY)
    packet.update(pair_id=plan['pair_id'], owner=plan['owner'], allocation_snapshot_id=am['snapshot_id'],
        allocation_context_snapshot_id=parent['snapshot_id'], configuration={**configuration,'fees':packet['fees']},
        source_context=env['source_context'],kv_read_policy=env['kv_read_policy'],source_tables={},
        initial_state_objects={arm:objects.put(state) for arm,state in args['states'].items()})
    packet['model_predictions'] = {}
    packet['model_predictions_checksum'] = digest({})
    packet['model_prediction_arms'] = {arm:{'model_identity':{'artifact_id':arm,'artifact_checksum':packet[arm+'_checksum'],'cohort_id':'fixture'},'predictions':{}} for arm in ('baseline','candidate')}
    packet['model_prediction_arms_checksum'] = digest(packet['model_prediction_arms'])
    packet['configuration_checksum']=digest(packet['configuration'])
    em=freeze_snapshot(signal_date='2026-09-04',source_run_id=plan['pair_id'],snapshot_kind='execution_pair',
        content=packet,query=db.query,writer=db.writer,now=FRIDAY)
    kwargs=dict(snapshot_id=em['snapshot_id'],new_owner=native_execution_identity(runner),query=db.query,
        writer=db.writer,objects=objects,runner=runner,now=SUNDAY)
    return db,kwargs,packet


def test_successor_preserves_frozen_inputs_and_runs_original_native_engine(native_runner):
    db,kw,old=fixture(native_runner)
    before=read_snapshot(db.query,kw['snapshot_id'])
    record=repair.replace_unstarted_registration(**kw)
    new=read_snapshot(db.query,record['new_snapshot_id']);packet=new['payload']['content']
    assert new['manifest']['prospective']==1 and new['manifest']['signal_date']=='2026-09-04'
    for key in ('initial_account','initial_state_objects','initial_state_checksums','source_context','schedule','fees','candidate_checksum','baseline_checksum'):
        assert packet[key]==old[key]
    assert packet['pair_id']!=old['pair_id'] and record['inherited_mature_sessions']==0
    assert read_snapshot(db.query,kw['snapshot_id'])==before
    assert resolve_comparison(query=db.query,execution=new)==resolve_comparison(query=db.query,execution=before)
    assert repair.replace_unstarted_registration(**kw)==record
    with pytest.raises(ValueError,match='superseded'):
        repair.assert_collectible(before,query=db.query)
    repair.assert_collectible(new,query=db.query)
    class ArmCapture:
        def for_arm(self, arm):
            return NativeSourceCapture(objects=kw['objects'], domain_queries={})
    result=collect_frame(snapshot_id=record['new_snapshot_id'],frame_index=0,objects=kw['objects'],query=db.query,
        capture_source=ArmCapture(),runner=native_runner,
        now=datetime.fromisoformat(packet['schedule'][0]['observed_at']))
    assert result['states']['baseline']==result['states']['candidate']
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
    from services.paired_nav_lifecycle import registered_pairs
    assert [r['execution']['manifest']['snapshot_id'] for r in registered_pairs(signal_date='2026-09-07',query=db.query)]==[record['new_snapshot_id']]


def test_first_phase_deadline_is_strict(native_runner):
    db,kw,old=fixture(native_runner)
    kw['now']=datetime.fromisoformat(old['schedule'][0]['observed_at'])
    with pytest.raises(ValueError,match='window_closed'):repair.replace_unstarted_registration(**kw)
    assert db.query('SELECT * FROM '+repair.TABLE,[])==[]


def test_existing_frame_forbids_replacement(native_runner):
    db,kw,old=fixture(native_runner)
    obj=kw['objects'];obj.publish_delivery(digest(frame_identity(kw['snapshot_id'],old['schedule'][0])),obj.put({'identity':frame_identity(kw['snapshot_id'],old['schedule'][0])}))
    with pytest.raises(ValueError,match='frame_present'):repair.replace_unstarted_registration(**kw)


def test_unknown_owner_cannot_be_published(native_runner):
    db,kw,_=fixture(native_runner);kw['new_owner']='native-paper-v1:'+'f'*64
    with pytest.raises(ValueError,match='runtime_not_current'):repair.replace_unstarted_registration(**kw)


@pytest.mark.parametrize('field',['candidate','baseline_checksum','configuration','allocation_context_snapshot_id'])
def test_rehashed_changes_beyond_execution_owner_are_rejected(native_runner,field):
    db,kw,_=fixture(native_runner);old=read_snapshot(db.query,kw['snapshot_id'])
    allocation=read_snapshot(db.query,old['payload']['content']['allocation_snapshot_id'])
    plan=repair.successor_plan(old,allocation,kw['new_owner'])
    if field=='configuration':
        plan[field]['trading_config']['fees']['commission']=.9;plan['configuration_checksum']=digest(plan[field])
    else:plan[field]={'output':['changed']} if field=='candidate' else 'f'*64
    with pytest.raises(ValueError,match='plan_changed_or_late'):
        freeze_snapshot(signal_date='2026-09-04',source_run_id=plan['pair_id'],snapshot_kind='allocation_pair',
            content=plan,query=db.query,writer=db.writer,now=SUNDAY)


def test_interrupted_activation_is_inert_and_retry_is_exact(native_runner):
    db,kw,_=fixture(native_runner)
    def interrupted(statements):
        if any('INSERT OR IGNORE INTO '+repair.TABLE in sql for sql,_ in statements):raise RuntimeError('injected interruption')
        return db.writer(statements)
    with pytest.raises(RuntimeError,match='injected'):
        repair.replace_unstarted_registration(**{**kw,'writer':interrupted})
    rows=db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair' AND snapshot_id<>?",[kw['snapshot_id']])
    assert len(rows)==1
    saved=read_snapshot(db.query,rows[0]['snapshot_id'])
    with pytest.raises(ValueError,match='uncommitted'):repair.assert_collectible(saved,query=db.query)
    repair.assert_collectible(read_snapshot(db.query,kw['snapshot_id']),query=db.query)
    result=repair.replace_unstarted_registration(**{**kw,'now':SUNDAY+timedelta(minutes=1)})
    assert result['new_snapshot_id']==rows[0]['snapshot_id']
    repair.assert_collectible(saved,query=db.query)


def test_receipt_cannot_be_overwritten_or_deleted(native_runner):
    db,kw,_=fixture(native_runner);repair.replace_unstarted_registration(**kw)
    for sql in ['DELETE FROM '+repair.TABLE, 'UPDATE '+repair.TABLE+" SET new_pair_id='changed'"]:
        with pytest.raises(sqlite3.IntegrityError,match='immutable_prestart'):db.conn.execute(sql)


@pytest.mark.parametrize('entry', ['collect', 'session', 'journal'])
def test_retired_original_blocked_at_every_execution_entry(native_runner, entry):
    db, kw, old = fixture(native_runner)
    repair.replace_unstarted_registration(**kw)
    from services.paired_native_session import run_paired_session
    from services.paired_nav_journal import materialize_pair
    with pytest.raises(ValueError, match='superseded'):
        if entry == 'collect':
            collect_frame(snapshot_id=kw['snapshot_id'], frame_index=0, query=db.query,
                objects=kw['objects'], capture_source=None, runner=native_runner, now=SUNDAY)
        elif entry == 'session':
            run_paired_session(snapshot_id=kw['snapshot_id'], query=db.query, writer=db.writer,
                tapes={}, states={}, runner=native_runner, now=SUNDAY)
        else:
            materialize_pair(snapshot_id=kw['snapshot_id'], session_date=old['session_date'],
                execution={}, query=db.query, writer=db.writer, now=SUNDAY)


def test_preflight_is_read_only_and_missing_migration_blocks_write(native_runner):
    db, kw, _ = fixture(native_runner)
    before = db.conn.total_changes
    repair.inspect_unstarted_registration(snapshot_id=kw['snapshot_id'], query=db.query,
        objects=kw['objects'], now=SUNDAY)
    assert db.conn.total_changes == before
    db.conn.execute('DROP TABLE '+repair.TABLE)
    with pytest.raises(RuntimeError, match='migration_missing'):
        repair.replace_unstarted_registration(**kw)
    assert db.conn.total_changes == before


def test_any_prior_journal_forbids_replacement(native_runner):
    db, kw, old = fixture(native_runner)
    def query(sql, values):
        if sql.startswith('SELECT session_date FROM paired_nav_daily_journal_v1'):
            return [{'session_date': '2026-09-03'}]
        return db.query(sql, values)
    with pytest.raises(ValueError, match='history_present'):
        repair.replace_unstarted_registration(**{**kw, 'query': query})


def test_corrupt_private_state_forbids_sealing(native_runner):
    db, kw, old = fixture(native_runner)
    class Corrupt:
        lookup_delivery = kw['objects'].lookup_delivery
        def get(self, key):
            state = deepcopy(kw['objects'].get(key)); state['state_sql'] += '--tamper'
            return state
    with pytest.raises(ValueError):
        repair.replace_unstarted_registration(**{**kw, 'objects': Corrupt()})
    assert db.query('SELECT * FROM '+repair.TABLE, []) == []


def test_successor_full_native_session_accounts_once(native_runner):
    from services.paired_native_session import run_paired_session
    from services.paired_nav_journal import materialize_pair
    db, kw, old = fixture(native_runner)
    record = repair.replace_unstarted_registration(**kw)
    saved = read_snapshot(db.query, record['new_snapshot_id']); packet = saved['payload']['content']
    source = {'session_date': packet['session_date'], 'complete': True,
        'schedule_checksum': digest(packet['schedule']), 'closed_at': packet['schedule'][-1]['observed_at'],
        'corporate_actions_complete': True, 'corporate_actions': [], 'closing_marks': {}}
    tapes = {arm: {'frames': {f['input_id']: f for f in packet['schedule']},
        'source_receipt': deepcopy(source)} for arm in ('baseline', 'candidate')}
    states = {arm: kw['objects'].get(packet['initial_state_objects'][arm]) for arm in ('baseline', 'candidate')}
    clock = datetime(2026, 9, 7, 7, tzinfo=timezone.utc)
    result = run_paired_session(snapshot_id=record['new_snapshot_id'], query=db.query, writer=db.writer,
        states=states, tapes=tapes, runner=native_runner, now=clock)
    params = dict(snapshot_id=record['new_snapshot_id'], session_date=packet['session_date'],
        execution=result['execution'], query=db.query, writer=db.writer, now=clock)
    journal = materialize_pair(**params)
    assert materialize_pair(**params) == journal
    assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 1
    for arm in ('baseline', 'candidate'):
        assert journal['arms'][arm]['nav'] == old['initial_account']['nav']
    assert journal['promotion_allowed'] is False


def test_tick_dispatches_only_committed_successor(native_runner):
    from services.paired_native_runtime import collect_due_execution_frames
    db, kw, old = fixture(native_runner)
    record = repair.replace_unstarted_registration(**kw)
    captures = []
    class ArmCapture:
        def for_arm(self, arm):
            return NativeSourceCapture(objects=kw['objects'], domain_queries={})
    def factory(**request):
        captures.append(request['snapshot_id']); return ArmCapture()
    result = collect_due_execution_frames(session_date=old['session_date'], query=db.query,
        writer=db.writer, objects=kw['objects'], capture_factory=factory, runner=native_runner,
        clock=lambda: datetime.fromisoformat(old['schedule'][0]['observed_at']))
    assert result['status'] == 'ok'
    assert {r['snapshot_id']:r['status'] for r in result['pairs']} == {
        kw['snapshot_id']:'superseded', record['new_snapshot_id']:'collecting'}
    assert captures == [record['new_snapshot_id']]


def test_successor_comparison_reads_large_original_context_once(native_runner):
    db, kw, old = fixture(native_runner)
    record = repair.replace_unstarted_registration(**kw)
    saved = read_snapshot(db.query, record['new_snapshot_id'])
    calls = []
    def query(sql, values):
        if sql.startswith('SELECT * FROM paired_nav_frozen_manifests_v1') and values == [old['allocation_context_snapshot_id']]:
            calls.append(values[0])
        return db.query(sql, values)
    assert resolve_comparison(query=query, execution=saved)['owner'] == old['owner']
    assert len(calls) == 1


def test_comparison_view_retains_shared_verifier_checks_without_copying_output():
    from test_paired_nav_strategy_bundle import fixture_bundle, fixture, DAY
    from services.paired_nav_strategy_bundle import verify_strategy_inputs
    from services.paired_nav_comparison import _ComparisonInputArms
    bundle, config, history = fixture_bundle()
    rows, policy, _ = fixture()
    policy = {**deepcopy(bundle['candidate_trading_config']['l4Distribution']), 'runtime':policy['runtime']}
    old = {'recommendations':rows, 'alpha_policy':{'l4AlphaEv':{}}, 'return_history':history,
        'ranking_config':{}, 'ensemble_v2_cfg':{}, 'regime_label':'x', 'regime_surface':{}}
    new = {**deepcopy(old), 'alpha_policy':{'l4Distribution':policy}}
    parent = {'inputs':old, 'strategy_allocation_input_arms':{'baseline':old,'candidate':new},
        'model_prediction_arms':{'candidate':{'predictions':deepcopy(policy['runtime']['predictions'])}}}
    ordinary = verify_strategy_inputs(config,parent,signal_date=DAY)
    assert ordinary['candidate'] == new and ordinary['candidate'] is not new
    validation = {**parent, 'strategy_allocation_input_arms':_ComparisonInputArms(parent['strategy_allocation_input_arms'])}
    assert verify_strategy_inputs(config,validation,signal_date=DAY) is None
    new['alpha_policy']['l4Distribution']['runtime']['predictions']['A']['ensemble_v2']['artifact_checksum']='d'*64
    for context in (parent, validation):
        with pytest.raises(ValueError, match='candidate_predictions_changed'):
            verify_strategy_inputs(config,context,signal_date=DAY)


def repeated_fixture(runner, monkeypatch):
    from services import native_paper_sandbox
    db, kw, original = fixture(runner)
    intermediate = 'native-paper-v1:' + 'b'*64
    with monkeypatch.context() as patch:
        patch.setattr(native_paper_sandbox, 'native_execution_identity', lambda runner=None: intermediate)
        first = repair.replace_unstarted_registration(**{**kw, 'new_owner':intermediate})
    leaf_args = {**kw, 'snapshot_id':first['new_snapshot_id'], 'now':SUNDAY+timedelta(minutes=1)}
    return db, kw, original, first, leaf_args


def test_repeated_replacement_preserves_inputs_and_resolves_active_leaf(native_runner, monkeypatch):
    from services.paired_native_runtime import register_candidate_execution_plans
    from services.paired_native_registration import register_allocation_pair
    db, kw, original, first, leaf_args = repeated_fixture(native_runner, monkeypatch)
    second = repair.replace_unstarted_registration(**leaf_args)
    leaf = repair.active_registration(db.query, kw['snapshot_id'])
    assert leaf['manifest']['snapshot_id'] == second['new_snapshot_id']
    assert resolve_comparison(query=db.query, execution=leaf) == resolve_comparison(
        query=db.query, execution=read_snapshot(db.query, kw['snapshot_id']))
    for key in ('initial_state_objects','initial_state_checksums','initial_account','source_context',
                'schedule','fees','model_prediction_arms','candidate_checksum','baseline_checksum'):
        assert leaf['payload']['content'][key] == original[key]
    assert first['inherited_mature_sessions'] == second['inherited_mature_sessions'] == 0
    assert len(db.query('SELECT * FROM '+repair.TABLE, [])) == 2
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    assert repair.replace_unstarted_registration(**leaf_args) == second
    with pytest.raises(ValueError, match='successor_changed'):
        repair.replace_unstarted_registration(**kw)
    for sid in (kw['snapshot_id'], first['new_snapshot_id']):
        with pytest.raises(ValueError, match='superseded'):
            repair.assert_collectible(read_snapshot(db.query, sid), query=db.query)
    allocation_id = original['allocation_snapshot_id']
    result = register_allocation_pair(snapshot_id=allocation_id, query=db.query, writer=db.writer,
        domain_queries={}, kv_read=None, objects=kw['objects'], account_id=2, variables={},
        kv_read_policy={}, runner=native_runner, now=SUNDAY)
    assert result['snapshot_id'] == second['new_snapshot_id']
    collection = {'plans':[{'snapshot_id':allocation_id, 'pair_id':original['pair_id'], 'owner':original['owner']}]}
    result = register_candidate_execution_plans(collection=collection, query=db.query, writer=db.writer,
        objects=kw['objects'], runner=native_runner, clock=lambda:SUNDAY)
    assert result['registrations'][0]['snapshot_id'] == second['new_snapshot_id']


@pytest.mark.parametrize('artifact', ['journal', 'execution_receipt', 'frame'])
def test_ancestor_execution_evidence_blocks_second_replacement(native_runner, monkeypatch, artifact):
    db, kw, original, first, leaf_args = repeated_fixture(native_runner, monkeypatch)
    pair_id = original['pair_id']
    def query(sql, values):
        if artifact == 'journal' and sql.startswith('SELECT session_date FROM paired_nav_daily_journal_v1') and values == [pair_id]:
            return [{'session_date':original['session_date']}]
        if artifact == 'execution_receipt' and sql.startswith('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind=') and values == [kw['snapshot_id']]:
            return [{'snapshot_id':'existing-receipt'}]
        return db.query(sql, values)
    if artifact == 'frame':
        identity = frame_identity(kw['snapshot_id'], original['schedule'][0])
        kw['objects'].publish_delivery(digest(identity), kw['objects'].put({'identity':identity}))
    with pytest.raises(ValueError, match='history_present|frame_present'):
        repair.replace_unstarted_registration(**{**leaf_args, 'query':query})
    assert len(db.query('SELECT * FROM '+repair.TABLE, [])) == 1


def test_missing_committed_predecessor_blocks_repeated_replacement(native_runner, monkeypatch):
    db, kw, original, first, leaf_args = repeated_fixture(native_runner, monkeypatch)
    def query(sql, values):
        if sql == 'SELECT * FROM '+repair.TABLE+' WHERE new_snapshot_id=?':
            return []
        return db.query(sql, values)
    with pytest.raises(ValueError, match='uncommitted'):
        repair.replace_unstarted_registration(**{**leaf_args, 'query':query})
    assert len(db.query('SELECT * FROM '+repair.TABLE, [])) == 1


def test_chain_depth_guard_restores_context_after_failure(native_runner, monkeypatch):
    db, kw, original, first, leaf_args = repeated_fixture(native_runner, monkeypatch)
    with monkeypatch.context() as patch:
        patch.setattr(repair, 'MAX_SUCCESSION_DEPTH', 1)
        with pytest.raises(ValueError, match='chain_invalid'):
            repair.inspect_unstarted_registration(snapshot_id=first['new_snapshot_id'],
                query=db.query, objects=kw['objects'], now=SUNDAY)
    assert repair._source_stack.get() == ()
    repair.inspect_unstarted_registration(snapshot_id=first['new_snapshot_id'],
        query=db.query, objects=kw['objects'], now=SUNDAY)


def test_forward_chain_cycle_fails_closed(native_runner, monkeypatch):
    db, kw, original, first, leaf_args = repeated_fixture(native_runner, monkeypatch)
    # Simulate a corrupt storage reader without weakening production triggers.
    real = repair.succession
    def cycle(query, *, old_snapshot_id=None, new_snapshot_id=None):
        if old_snapshot_id == first['new_snapshot_id']:
            return {'new_snapshot_id':kw['snapshot_id'], 'old_pair_id':'x', 'new_pair_id':original['pair_id']}
        return real(query, old_snapshot_id=old_snapshot_id, new_snapshot_id=new_snapshot_id)
    monkeypatch.setattr(repair, 'succession', cycle)
    with pytest.raises(ValueError, match='chain_invalid'):
        repair.active_registration(db.query, kw['snapshot_id'])
