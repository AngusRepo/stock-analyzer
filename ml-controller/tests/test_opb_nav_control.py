"""Actual Hono publication -> original Python allocator, never investment ROI."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
import sqlite3

import pytest

from services.opb_nav_control import capture_nav_control, control_scope, configured_prior
from services.online_portfolio_bandit import resolve_portfolio_bandit_arms
from services.paired_nav_journal import digest


def exercise_original_publication(path, inputs, monkeypatch):
    original = json.loads(path.read_text(encoding='utf-8'))
    clock = datetime.fromisoformat(original['now'])
    config, risk = original['trading_config'], original['risk_config']
    with sqlite3.connect(':memory:') as db:
        db.row_factory = sqlite3.Row
        for table, value in original['tables'].items():
            db.executescript(value['schema'])
            for row in value['rows']:
                fields = list(row)
                db.execute(f"INSERT INTO {table}({','.join(fields)}) VALUES({','.join('?' for _ in fields)})",
                    [row[key] for key in fields])
        def query(sql, params):
            return [dict(row) for row in db.execute(sql, params).fetchall()]
        source, grant = capture_nav_control(query=query, trading_config=config, risk_config=risk, now=clock)
        artifact = configured_prior(config)
        assert grant and artifact['validation']['decision'] == 'FAIL'
        # Worker JSON serialized integral floats as integers. Verify the raw
        # publication checksum, not a new hash of the lossy KV representation.
        assert digest(artifact) != grant.checksum
        ev = grant.ev_identity
        kwargs = dict(expected_return_owner=ev['expected_return_owner'],
            expected_return_contract_version=ev['expected_return_contract_version'],
            expected_return_semantic=ev['expected_return_semantic'],
            expected_return_model_version=ev['expected_return_model_version'],
            expected_return_trained_until=ev['expected_return_trained_until'])
        with control_scope(grant):
            arms, evidence = resolve_portfolio_bandit_arms(artifact, **kwargs)
        assert arms == grant.arms, evidence
        assert evidence['status'] == 'artifact_loaded'
        assert evidence['production_control_ready'] is True
        assert evidence['control_authority'] == 'original_nav_publication'
        assert evidence['publication_receipt_checksum'] == grant.receipt_checksum
        assert resolve_portfolio_bandit_arms(artifact, **kwargs)[1]['production_control_ready'] is False
        with pytest.raises(ValueError, match='unverified_grant'):
            with control_scope({'approved': True, **evidence}):
                pytest.fail('JSON cannot grant production authority')
        with control_scope(grant):
            bad = {**kwargs, 'expected_return_model_version': 'another-model'}
            assert resolve_portfolio_bandit_arms(artifact, **bad)[1]['production_control_ready'] is False
            for value in (False, True, .0001):
                corrupted = deepcopy(artifact)
                corrupted['arm_priors'][0]['prior_reward_mean'] = value
                assert resolve_portfolio_bandit_arms(corrupted, **kwargs)[1]['production_control_ready'] is False
        before = db.total_changes
        assert configured_prior(config) == artifact and db.total_changes == before
        activations = exercise_actual_allocation(db, query, config, risk, inputs, clock, grant, monkeypatch)
        for mutation in (
            "UPDATE model_champion_history SET evidence_json='{}' WHERE model_name='opb_arm_prior'",
            "UPDATE active8_ensemble_pointer_v1 SET payload_checksum='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
            "UPDATE expected_return_artifact_payloads SET artifact_json='{}'",
            "UPDATE expected_return_artifact_payloads SET serving_mode='abstention_baseline'",
            "UPDATE model_artifact_registry SET state='archived' WHERE model_name='opb_arm_prior'",
        ):
            db.execute('SAVEPOINT broken_source')
            db.execute(mutation)
            with pytest.raises(ValueError):
                capture_nav_control(query=query, trading_config=config, risk_config=risk, now=clock)
            db.execute('ROLLBACK TO broken_source')
            db.execute('RELEASE broken_source')
        wrong = deepcopy(config)
        wrong['position']['maxPctOfPortfolio'] = .125
        with pytest.raises(ValueError, match='configuration_changed'):
            capture_nav_control(query=query, trading_config=wrong, risk_config=risk, now=clock)
        db.execute('SAVEPOINT future')
        db.execute("UPDATE model_champion_history SET effective_at=? WHERE model_name='opb_arm_prior'",
            [(clock + timedelta(days=1)).isoformat()])
        with pytest.raises(ValueError, match='history_invalid'):
            capture_nav_control(query=query, trading_config=config, risk_config=risk, now=clock)
        db.execute('ROLLBACK TO future')
        assert source['content_checksum'] == digest({k:v for k,v in source.items() if k != 'content_checksum'})
        export = path.with_name(path.name + '.activation.json')
        export.write_text(json.dumps({**original, **activations}, ensure_ascii=False), encoding='utf-8')
        return export


def exercise_actual_allocation(db, query, config, risk, inputs, clock, grant, monkeypatch):
    from pathlib import Path
    from services import opb_nav_control as control, recommendation_service as service
    from services import paired_nav_collection as collection
    from services.paired_nav_journal import read_snapshot, freeze_snapshot
    from services.paired_nav_intervention import run_isolated_allocation
    from services.paired_nav_atomic_allocation import allocation_economic_evidence
    schema = Path(__file__).parents[2] / 'worker/domain-migrations/learning/0040_paired_nav_shadow_journal.sql'
    db.executescript(schema.read_text(encoding='utf-8'))
    def writer(statements):
        for sql, params in statements:
            db.execute(sql, params)
        db.commit()
        return {'success_count': len(statements), 'error_count': 0}
    actual = deepcopy(inputs)
    actual['alpha_policy'] = deepcopy(config['alphaFramework'])
    assert actual['alpha_policy']['allocation']['controller'] == 'OnlinePortfolioBandit'
    inherited = {'weights': {}, 'portfolio_value_twd': 100000.0, 'status': 'ok'}
    manifest = {'active8_ensemble': deepcopy(grant.formal_identity),
        'active8_action_authority': {**grant.formal_identity, 'buy_authorized': True, 'production_effect': True}}
    allocation_clock = clock
    variants = []
    def retain(snapshot_id, expected):
        tables = {}
        for name in ('paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1'):
            tables[name] = {'schema': db.execute('SELECT sql FROM sqlite_master WHERE name=?', [name]).fetchone()['sql'],
                'rows': query(f'SELECT * FROM {name} WHERE snapshot_id=?', [snapshot_id])}
        variants.append({'expected': expected, 'snapshot_id': snapshot_id, 'tables': tables})
    with monkeypatch.context() as local:
        local.setattr(control, '_utc_now', lambda: allocation_clock)
        local.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=allocation_clock))
        # Only the observation data adapters are fixtures. The real formal
        # allocator, OPB arm selection and sparse optimizer all execute.
        local.setattr(service, 'load_inherited_paper_weights', lambda *a, **k: deepcopy(inherited))
        local.setattr(service, 'build_portfolio_ml_shadow_inputs', lambda *a, **k: {})
        local.setattr(service, 'build_rfs_implementable_frontier_shadow', lambda *a, **k: {})
        def allocate(run_id='nav-control-live'):
            nonlocal allocation_clock
            allocation_clock += timedelta(seconds=1)
            return collection.run_and_capture_allocation(**deepcopy(actual), trading_config=config,
                risk_config=risk, signal_date=clock.date().isoformat(), source_run_id=run_id,
                query=query, writer=writer, formal_model_manifest=manifest)
        output, receipt = allocate()
        assert receipt['status'] == 'allocation_context_frozen', json.dumps(receipt)
        assert receipt['opb_control_execution']['control_executed'] is True
        retain(receipt['snapshot_id'], 'completed')
        parent = read_snapshot(query, receipt['snapshot_id'])['payload']['content']
        packet = parent['capture']['opb_packet']
        assert packet['status'] == 'ok', packet
        assert packet['prior_artifact']['production_control_ready'] is True
        assert packet['prior_artifact']['publication_receipt_checksum'] == grant.receipt_checksum
        assert parent['capture']['allocation_contract']['controller_effective'] == 'OnlinePortfolioBandit'
        replay = run_isolated_allocation(inputs=parent['inputs'], inherited_state=inherited)
        assert replay['output'] == collection.allocation_projection(output)
        assert allocation_economic_evidence(replay['capture']) == allocation_economic_evidence(parent['capture'])
        assert allocate()[1] == receipt
        for section in manifest.values():
            section['artifact_id'] = 'different-inference-model'
        _, wrong_ml = allocate('changed-inference-manifest')
        assert wrong_ml['reason'] == 'paired_nav_opb_control_runtime_ml_changed'
        for section in manifest.values():
            section['artifact_id'] = grant.formal_identity['artifact_id']
        # A caller cannot substitute different allocator knobs under the same
        # published prior. A valid empty pool, however, is a normal outcome.
        original_policy = deepcopy(actual['alpha_policy'])
        actual['alpha_policy']['allocation']['riskAversion'] = 99
        _, wrong_policy = allocate('changed-runtime-policy')
        assert wrong_policy['reason'] == 'paired_nav_opb_control_runtime_policy_changed'
        actual['alpha_policy'] = original_policy
        for key, changed in [('ranking_config', {'enabled': False}), ('ensemble_v2_cfg', {'changed': True})]:
            original_input = deepcopy(actual[key])
            actual[key] = changed
            _, wrong_config = allocate('changed-' + key)
            assert wrong_config['reason'] == 'paired_nav_opb_control_runtime_configuration_changed'
            actual[key] = original_input
        original_recommendations = actual['recommendations']
        actual['recommendations'] = []
        _, empty = allocate('empty-pool')
        assert empty['status'] == 'allocation_context_frozen', empty
        assert empty['opb_control_execution']['status'] == 'not_applicable'
        retain(empty['snapshot_id'], 'not_applicable')
        actual['recommendations'] = original_recommendations
        from services import online_portfolio_bandit as bandit
        def solver_failure(**kw):
            raise RuntimeError('fixture_solver_failed')
        with local.context() as fault:
            fault.setattr(bandit, 'build_online_portfolio_bandit_l2_packet', solver_failure)
            _, broken = allocate('broken-opb-solver')
        assert broken['status'] == 'failed' and broken['reason'] == 'paired_nav_opb_control_execution_incomplete'
        failed_parent = read_snapshot(query, broken['snapshot_id'])['payload']['content']
        assert failed_parent['opb_control_execution']['control_executed'] is False
        retain(broken['snapshot_id'], 'failed')
        from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
        preserved = complete_pipeline_shadow(broken, query=query, writer=writer)
        assert preserved['reason'] == broken['reason']
        from graphs.daily_pipeline_v2 import _pipeline_terminal_result
        terminal = _pipeline_terminal_result({'paired_nav_collection': preserved, 'errors': [], 'metrics': {}},
            run_date=clock.date().isoformat(), elapsed=0)
        assert terminal['status'] == 'error'
        assert set(pipeline_shadow_errors(preserved)) <= set(terminal['critical_errors'])
        # Replay reads only the sealed parent, even when today's ML was replaced.
        db.execute('SAVEPOINT replaced_ml')
        db.execute("UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?", ['d' * 64])
        assert collection.replay_frozen_allocation(snapshot_id=receipt['snapshot_id'], query=query)[
            'allocation_replay_decision'] == 'PASS'
        _, failed = allocate('nav-control-next-parent')
        assert failed['status'] == 'failed' and failed['reason'] == 'paired_nav_opb_control_ml_changed'
        _, retry_failed = allocate()
        assert retry_failed['status'] == 'failed' and retry_failed['reason'] == 'paired_nav_opb_control_ml_changed'
        db.execute('ROLLBACK TO replaced_ml')
        db.execute('RELEASE replaced_ml')
    return {'variants': variants, 'now': allocation_clock.isoformat()}


def test_plain_json_control_claim_has_no_authority():
    with pytest.raises(ValueError, match='unverified_grant'):
        with control_scope({'production_control_ready': True}):
            pytest.fail('JSON must never activate OPB control')
