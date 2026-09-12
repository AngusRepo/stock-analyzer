from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json

import pytest

from services import paired_nav_candidate_collection as module
from services.expected_return_artifact_identity import attach_expected_return_artifact_identity
from services.expected_return_candidate_forward_evaluator import _load_candidate_packet
from services.expected_return_numeric import evaluate_linear_net
from services.paired_nav_journal import freeze_snapshot, read_snapshot
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_collection import allocator_source_identity
from test_expected_return_candidate_forward_evaluator import _candidate, _Bucket
from test_paired_nav_intervention import inputs
from test_paired_nav_journal import DB, FEES
from test_l4_alpha_ev_producer import _artifact as l4_artifact
from test_allocator_ev_fusion_materializer import _artifact as fusion_artifact


def fixture_candidate(owner):
    registry, raw = _candidate(owner)
    packet = json.loads(raw)
    original = packet['artifact']
    artifact = (l4_artifact if owner == 'l4_alpha_ev' else fusion_artifact)(
        model_version=original['model_version'], expected_return_owner=owner,
        training_data=original['training_data'], promotion_state='shadow',
        primary_expected_return_allowed=False, promotion_tier='shadow',
        validation_packet={'decision': 'FAIL', 'failed_gates': ['walk_forward_not_stable']})
    packet['artifact'] = artifact
    artifact['training_data']['label_known_max_date'] = '2026-08-25'
    if owner == 'allocator_ev_fusion':
        artifact['residual_adjustment_model'] = {'status': 'fitted', 'intercept': .002,
                                               'coefficients': {'l4_expected_return': .1}}
    attach_expected_return_artifact_identity(artifact)
    failed = ['walk_forward_not_stable'] if owner == 'l4_alpha_ev' else ['residual_adjustment:walk_forward_not_stable']
    packet['validation_packet'] = {'decision': 'FAIL', 'failed_gates': failed}
    artifact['validation_packet'] = deepcopy(packet['validation_packet'])
    raw = json.dumps(packet, sort_keys=True).encode()
    checksum = hashlib.sha256(raw).hexdigest()
    registry.update(state='shadowing', checksum=checksum,
                    artifact_path=f"universal/ev_candidates/{packet['cohort_id']}/{owner}/{checksum}.json",
                    artifact_id=f"{owner}:{registry['version']}:{checksum}",
                    offline_gate_decision='FAIL', offline_gate_failed_gates=json.dumps(failed))
    return registry, raw


@pytest.fixture
def environment(monkeypatch, request):
    db = DB(legacy_assessments=False)
    db.conn.executescript('''CREATE TABLE model_artifact_registry (
      artifact_id TEXT PRIMARY KEY,model_name TEXT,version TEXT,state TEXT,artifact_path TEXT,checksum TEXT,
      source_run_date TEXT,offline_gate_decision TEXT,offline_gate_failed_gates TEXT,
      training_run_id TEXT,updated_at TEXT,offline_evidence_json TEXT,candidate_type TEXT,
      live_gate_status TEXT,live_evidence_json TEXT,promotion_decision TEXT);''')
    payloads = {}
    for owner in ('l4_alpha_ev', 'allocator_ev_fusion'):
        registry, raw = fixture_candidate(owner)
        keys = list(registry)
        db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(keys) + ',candidate_type,offline_evidence_json) VALUES(' + ','.join(['?'] * (len(keys) + 2)) + ')',
                        [registry[k] for k in keys] + [owner + '_refresh', '{}'])
        payloads[registry['artifact_path']] = raw
    allocation_inputs = inputs('OnlinePortfolioBandit')
    for index, row in enumerate(allocation_inputs['recommendations'], start=1):
        row['stock_id'] = index
        row['score_seed_inputs'] = {'chipFlowSeed40': 20, 'technicalSeed30': 15,
                                   'screenerMomentumSeed20': 10, 'mlEdgeSeed30': 15}
    baseline = run_isolated_allocation(inputs=allocation_inputs, inherited_state={})
    content = {'inputs': allocation_inputs, 'trading_config': {'fees': FEES},
               'risk_config': {'maxSingleNamePct': .25}, 'allocator_source_identity': allocator_source_identity(),
               'formal_output': baseline['output'], 'capture': baseline['capture'],
               'formal_baseline_identity': {'schema_version': 'paired-nav-formal-ml-baseline-v1',
                   'artifact_id': 'formal-ml', 'cohort_id': 'formal-cohort',
                   'payload_checksum': 'a' * 64, 'base_artifact_set_checksum': 'b' * 64},
               'model_predictions': {symbol: {'ensemble_v2': {'avg_rank': .7}} for symbol in ('2330', '2317')}}
    signal_date = getattr(request, 'param', '2026-09-07')
    stamp = datetime.fromisoformat(signal_date + 'T14:00:00+00:00')
    context = freeze_snapshot(signal_date=signal_date, source_run_id='native-test', snapshot_kind='allocation_context',
        content=content, query=db.query, writer=db.writer, now=stamp)
    monkeypatch.setattr(module, 'freeze_snapshot', lambda **kwargs: freeze_snapshot(**kwargs, now=stamp))
    return db, _Bucket(payloads), context, content


def test_real_registry_inference_allocator_and_immutable_plan_retries(environment):
    db, bucket, context, original = environment
    before = deepcopy(original)
    kwargs = dict(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    result = module.collect_candidate_allocations(**kwargs)
    assert result['status'] == 'allocation_pairs_frozen'
    assert len(result['plans']) == 2
    assert module.collect_candidate_allocations(**kwargs) == result
    assert original == before
    plans = {r['owner']: read_snapshot(db.query, r['snapshot_id'])['payload']['content'] for r in result['plans']}
    assert plans['allocator_ev_fusion']['baseline_checksum'] == plans['l4_alpha_ev']['candidate_checksum']
    assert plans['allocator_ev_fusion']['baseline']['output'] == plans['l4_alpha_ev']['candidate']['output']
    for plan in plans.values():
        assert plan['can_write_order'] is False
        assert plan['nav_maturity_credit'] == 0
    assert plans['allocator_ev_fusion']['baseline']['capture']['allocation_contract']['controller_effective'] == plans['allocator_ev_fusion']['candidate']['capture']['allocation_contract']['controller_effective']
    assert all(r['offline_gate_decision'] == 'FAIL' and r['state'] == 'shadowing'
               for r in db.query('SELECT offline_gate_decision,state FROM model_artifact_registry', []))
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    assert not db.query("SELECT name FROM sqlite_master WHERE name='paired_nav_nominations_v1'", [])
    # Efficacy-failed candidates may collect isolated evidence. Neither their
    # offline FAIL nor this new NAV accounting lane can empty the formal plan.
    formal_after = run_isolated_allocation(inputs=original['inputs'], inherited_state={})
    assert formal_after['output'] == original['formal_output']
    assert formal_after['capture']['effective_weights'] == original['capture']['effective_weights']
    assert sum(formal_after['capture']['effective_weights'].values()) > 0


def test_bad_gcs_checksum_cannot_publish_a_plan(environment):
    db, bucket, context, _ = environment
    path = db.query("SELECT artifact_path FROM model_artifact_registry WHERE model_name='l4_alpha_ev'", [])[0]['artifact_path']
    bucket.payloads[path] = b'{}'
    private = module._collect_ev_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert private['status'] == 'candidate_allocations_failed' and not private['plans']
    assert {f['reason'] for f in private['candidate_failures']} == {
        'candidate_forward_packet_checksum_mismatch', 'paired_nav_exact_l4_baseline_unavailable'}
    result = module.collect_candidate_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert result['owner_failures']['expected_return']['error_type'] == 'ValueError'
    assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])


def test_registry_cannot_relabel_artifact_cohort_to_reset_family(environment):
    db, bucket, context, _ = environment
    db.conn.execute("UPDATE model_artifact_registry SET training_run_id='active8_oof:renamed'")
    private = module._collect_ev_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert private['status'] == 'candidate_allocations_failed' and not private['plans']
    assert len(private['candidate_failures']) == 2
    assert all(f['reason'] == 'candidate_forward_training_cohort_identity_mismatch'
               for f in private['candidate_failures'])
    result = module.collect_candidate_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])
    assert not db.query("SELECT name FROM sqlite_master WHERE name='paired_nav_nominations_v1'", [])


def test_future_training_outcome_is_rejected():
    registry, raw = fixture_candidate('l4_alpha_ev')
    candidate = _load_candidate_packet(_Bucket({registry['artifact_path']: raw}), registry)
    with pytest.raises(ValueError, match='training_outcome_cutoff'):
        module.infer_candidate_values(candidate, inputs()['recommendations'], '2026-08-25')


def test_shared_math_normalizes_cost_before_clipping_and_never_twice():
    value, metadata = evaluate_linear_net(intercept=.1, coefficients={'x': 0}, features={'x': 1},
        artifact={'cost_model_bps': 18, 'output_is_net_of_costs': False}, clip={'min': -.08, 'max': .08})
    assert value == .08  # clip(.1 - .0018), not clip(.1) - .0018
    assert metadata['cost_normalization_bps'] == 18
    net, metadata = evaluate_linear_net(intercept=.04, coefficients={'x': 0}, features={'x': 1},
        artifact={'cost_model_bps': 18, 'output_is_net_of_costs': True}, clip={})
    assert net == .04
    assert metadata['cost_normalization_bps'] == 0


@pytest.mark.parametrize('owner,mutation,reason', [
    ('l4_alpha_ev', {'feature_names': ['ml_edge_norm']}, 'canonical_feature_set_mismatch'),
    ('l4_alpha_ev', {'label_schema_version': 'unknown'}, 'label_schema_version_incompatible'),
    ('allocator_ev_fusion', {'selection_model': {}}, 'third_selection_serving_head_forbidden'),
    ('allocator_ev_fusion', {'feature_semantic_version': 'unknown'}, 'feature_semantic_version_incompatible'),
])
def test_shadow_cannot_skip_native_structural_contract(owner, mutation, reason):
    registry, raw = fixture_candidate(owner)
    candidate = _load_candidate_packet(_Bucket({registry['artifact_path']: raw}), registry)
    candidate['artifact'].update(mutation)
    with pytest.raises(ValueError, match=reason):
        module.infer_candidate_values(candidate, inputs()['recommendations'], '2026-09-07',
                                      l4={'2330': .01, '2317': .01})


def test_fusion_uses_frozen_market_heat_and_cannot_replace_missing_with_zero():
    registry, raw = fixture_candidate('allocator_ev_fusion')
    candidate = _load_candidate_packet(_Bucket({registry['artifact_path']: raw}), registry)
    candidate['artifact']['residual_adjustment_model']['coefficients'] = {'market_heat_expected_return': 1.0}
    rows = inputs()['recommendations']
    for row in rows:
        row['alpha_context'] = {'market_heat_expected_return': .025}
    values = module.infer_candidate_values(candidate, rows, '2026-09-07', l4={'2330': .01, '2317': .01})
    assert values == {'2330': .037, '2317': .037}
    rows[0]['market_heat_expected_return'] = 0.0
    values = module.infer_candidate_values(candidate, rows, '2026-09-07', l4={'2330': .01, '2317': .01})
    assert values == {'2330': .012, '2317': .037}  # same row-first precedence as serving
    del rows[0]['market_heat_expected_return']
    rows[0]['alpha_context'] = {}
    with pytest.raises(ValueError, match='feature_missing:market_heat_expected_return'):
        module.infer_candidate_values(candidate, rows, '2026-09-07', l4={'2330': .01, '2317': .01})


def test_source_change_rejects_before_publishing_candidate_plan(environment, monkeypatch):
    db, bucket, context, _ = environment
    monkeypatch.setattr(module, 'allocator_source_identity', lambda: {'changed.py': 'changed'})
    with pytest.raises(ValueError, match='allocator_source_changed'):
        module._collect_ev_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    result = module.collect_candidate_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert result['owner_failures']['expected_return']['reason'] == 'paired_nav_allocator_source_changed'
    assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])


def test_policies_are_part_of_comparison_identity(environment):
    db, bucket, context, content = environment
    first = module.collect_candidate_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    altered = deepcopy(content)
    altered['inputs']['ranking_config']['promoteMinMlEdge'] = .001
    replay = run_isolated_allocation(inputs=altered['inputs'], inherited_state={})
    altered['formal_output'], altered['capture'] = replay['output'], replay['capture']
    seal = freeze_snapshot(signal_date='2026-09-07', source_run_id='changed-policy', snapshot_kind='allocation_context',
        content=altered, query=db.query, writer=db.writer, now=datetime(2026, 9, 7, 14, tzinfo=timezone.utc))
    second = module.collect_candidate_allocations(snapshot_id=seal['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert {r['pair_id'] for r in first['plans']}.isdisjoint(r['pair_id'] for r in second['plans'])


def test_new_formal_ml_bundle_does_not_mix_into_same_nav_pair(environment):
    db, bucket, context, content = environment
    first = module.collect_candidate_allocations(snapshot_id=context['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    altered = deepcopy(content)
    altered['formal_baseline_identity']['payload_checksum'] = 'd' * 64
    seal = freeze_snapshot(signal_date='2026-09-07', source_run_id='changed-formal-model', snapshot_kind='allocation_context',
        content=altered, query=db.query, writer=db.writer, now=datetime(2026, 9, 7, 14, tzinfo=timezone.utc))
    second = module.collect_candidate_allocations(snapshot_id=seal['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert {r['pair_id'] for r in first['plans']}.isdisjoint(r['pair_id'] for r in second['plans'])
    # All original plans survive. A model transition is not a delete/reset.
    assert all(read_snapshot(db.query, row['snapshot_id']) for row in first['plans'])


def test_daily_guard_observation_does_not_restart_experiment_or_disable_guard():
    original = inputs()
    original['alpha_policy']['allocatorEvFusion'] = {
        'model_version': 'frozen-model', 'coefficient': .2,
        'runtime_forward_guard': {'as_of_date': '2026-09-07', 'status': 'PASS'}}
    tomorrow = deepcopy(original)
    tomorrow['alpha_policy']['allocatorEvFusion']['runtime_forward_guard'] = {
        'as_of_date': '2026-09-08', 'status': 'HOLD'}
    first = module.allocation_policy_identity(original)
    assert module.allocation_policy_identity(tomorrow) == first
    assert tomorrow['alpha_policy']['allocatorEvFusion']['runtime_forward_guard']['status'] == 'HOLD'
    assert original['alpha_policy']['allocatorEvFusion']['runtime_forward_guard']['status'] == 'PASS'
    tomorrow['alpha_policy']['allocatorEvFusion']['coefficient'] = .3
    assert module.allocation_policy_identity(tomorrow) != first
