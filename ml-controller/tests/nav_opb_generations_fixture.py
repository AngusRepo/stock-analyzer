"""Two original publications, not an investment-performance experiment.

Costed synthetic execution receipts exercise the real NAV reviewer and history
owner. They do not estimate either prior's actual economic benefit.
"""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess

from services import paired_nav_collection as capture, paired_nav_opb_candidate as collection
from services import paired_nav_lifecycle as lifecycle, recommendation_service as allocator
from services import opb_counterfactual_prior as producer, opb_nav_control
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
from services.paired_nav_daily_review import run_daily_nav_reviews
from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
from routers.opb_arm_prior import _registry_record
from test_paired_nav_journal import DB, packet, receipt, buy, FEES
from test_paired_nav_review_store import migrate


def verify_successor_generation(first_fixture, inputs, monkeypatch, directory, *, reentry=None):
    original = json.loads(first_fixture.read_text(encoding='utf-8'))
    published = reentry or json.loads(Path(str(first_fixture) + '.control.json').read_text(encoding='utf-8'))
    db = DB(legacy_assessments=False)
    migrate(db)
    sources = {name: {'schema': original['schemas'][name], 'rows': rows}
        for name, rows in original['tables'].items()}
    sources.update(published['tables'])
    for table, value in sources.items():
        if not db.query('SELECT name FROM sqlite_master WHERE name=?', [table]):
            db.conn.execute(value['schema'])
        for row in value['rows']:
            fields = list(row)
            db.conn.execute(f"INSERT INTO {table}({','.join(fields)}) VALUES({','.join('?' for _ in fields)})",
                [row[key] for key in fields])
    db.conn.commit()
    first_history = db.query('SELECT * FROM model_champion_history', [])
    old_journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    old_reviews = db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id', [])
    dates = ['2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-28',
        '2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-05','2026-10-06']
    if reentry:
        dates = ['2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13',
            '2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-20','2026-10-21']
    clock = lambda day: datetime.fromisoformat(day + 'T14:00:00+00:00')
    current = datetime.fromisoformat(dates[0] + 'T13:00:00+00:00')
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current.astimezone(tz) if tz else current.replace(tzinfo=None)
    config, risk = published['trading_config'], published['risk_config']
    formal = db.query('SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum FROM active8_ensemble_pointer_v1', [])[0]
    manifest = {'active8_ensemble': formal, 'active8_action_authority': {
        **formal, 'buy_authorized': True, 'production_effect': True}}
    actual = deepcopy(inputs)
    actual.update(alpha_policy=deepcopy(config['alphaFramework']), ranking_config=deepcopy(config['ranking']),
        ensemble_v2_cfg=deepcopy(config['ensemble_v2']))
    try:
        with monkeypatch.context() as local:
            for module in (producer, collection, lifecycle):
                local.setattr(module, 'datetime', Clock)
            local.setattr(opb_nav_control, '_utc_now', lambda: current)
            for module in (capture, collection):
                local.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=current))
            local.setattr(allocator, 'load_inherited_paper_weights', lambda *a, **kw: {})
            local.setattr(allocator, 'build_portfolio_ml_shadow_inputs', lambda *a, **kw: {})
            local.setattr(allocator, 'build_rfs_implementable_frontier_shadow', lambda *a, **kw: {})
            second = (json.loads(reentry['prior_payload']['prospective_validation']['candidate_payload_json']) if reentry else
                producer.build_opb_arm_prior_artifact(rows=[], price_rows=[],
                    expected_return_owner='l4_alpha_ev', trained_until='2026-08-25', min_dates=21)['artifact'])
            assert second['artifact_id'] != original['payload']['artifact_id']
            if reentry:
                retired_row, = db.query('SELECT * FROM model_artifact_registry WHERE artifact_id=?', [second['artifact_id']])
                assert retired_row['state'] == 'shadowing'
                assert retired_row['checksum'] == reentry['prior_payload']['artifact_checksum']
                assert not db.query("SELECT * FROM model_champion_pointers WHERE model_name='opb_arm_prior'", [])
            else:
                record = _registry_record(second, promoted=False, promotion_error=None)
                record['created_at'] = second['generated_at']
                db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(record) + ') VALUES('
                    + ','.join('?' for _ in record) + ')', list(record.values()))
            for index, (signal, session) in enumerate(zip(dates, dates[1:])):
                current = clock(signal)
                _, parent = capture.run_and_capture_allocation(**deepcopy(actual), trading_config=config,
                    risk_config=risk, signal_date=signal, source_run_id='successor:' + signal,
                    query=db.query, writer=db.writer, formal_model_manifest=manifest)
                assert parent['status'] == 'allocation_context_frozen', parent
                if reentry:
                    saved = read_snapshot(db.query, parent['snapshot_id'])['payload']['content']
                    assert saved['capture']['allocation_contract']['controller_effective'] == 'SparseTangent'
                else:
                    assert parent['opb_control_execution']['control_executed'] is True, parent
                collected = collection.collect_opb_allocations(snapshot_id=parent['snapshot_id'], query=db.query, writer=db.writer)
                assert len(collected['plans']) == 2 and not collected.get('candidate_failures'), collected
                for item in collected['plans']:
                    plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
                    execution = packet(session, signal if index else None)
                    execution.update({k: plan[k] for k in ('pair_id','owner','candidate_checksum','baseline_checksum')})
                    execution.update(allocation_snapshot_id=item['snapshot_id'],
                        configuration={**plan['configuration'], 'fees': FEES},
                        schedule=[{'observed_at': session + 'T00:00:00Z'}])
                    execution['configuration_checksum'] = digest(execution['configuration'])
                    sealed = freeze_snapshot(signal_date=signal, source_run_id=plan['pair_id'],
                        snapshot_kind='execution_pair', content=execution, query=db.query, writer=db.writer, now=current)
                    # Synthetic ledger fixture, not claimed allocator return attribution.
                    successor = plan['candidate_artifact_id'] == second['artifact_id']
                    stage_execution_receipt(execution=receipt(execution, sealed,
                        fills=[buy(session)] if successor and index == 0 else [],
                        marks={'2330': 105 + index * 5} if successor else {}),
                        query=db.query, writer=db.writer, now=clock(session))
                lifecycle.close_changed_comparisons(plans=collected['plans'], signal_date=signal,
                    query=db.query, writer=db.writer, now=current)
                mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=clock(session))
            day = dates[-1]
            reviewed = run_daily_nav_reviews(business_date=day, query=db.query, writer=db.writer, now=clock(day))
            assert not reviewed['failures'], reviewed
            candidates = []
            evaluated = refresh_registered_opb_nav_decisions(business_date=day, query=db.query, writer=db.writer,
                now=clock(day), adoption_candidates=candidates)
            assert not evaluated['failures'], evaluated
            payload, = [c['payload'] for c in candidates if c['payload']['artifact_id'] == second['artifact_id']]
            gate = payload['prospective_validation']
            assert gate['decision'] == 'PASS' and gate['evaluable_date_count'] == 10, gate
            prior_payload = reentry['prior_payload'] if reentry else original['payload']
            assert gate['nav_validation']['decision_checksum'] != prior_payload['prospective_validation']['nav_validation']['decision_checksum']
            if reentry:
                assert payload['artifact_checksum'] == prior_payload['artifact_checksum']
                assert db.query('SELECT created_at FROM model_artifact_registry WHERE artifact_id=?', [second['artifact_id']])[0]['created_at'] == retired_row['created_at']
            assert db.query('SELECT * FROM model_champion_history', []) == first_history
            for row in old_journals:
                assert db.query('SELECT * FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date=?',
                    [row['pair_id'], row['session_date']]) == [row]
            for row in old_reviews:
                assert db.query('SELECT * FROM paired_nav_review_records_v1 WHERE record_id=?', [row['record_id']]) == [row]
            tables = {row['name']: {'schema': row['sql'], 'rows': db.query('SELECT * FROM ' + row['name'], [])}
                for row in db.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [])}
            output = directory / ('opb-reentry-publication.json' if reentry else 'opb-successor-publication.json')
            output.write_text(json.dumps({'now': clock(day).isoformat(), 'payload': payload, 'tables': tables,
                'trading_config': config, 'risk_config': risk, 'first_history': first_history,
                'reentry': bool(reentry), 'prior_payload': prior_payload}), encoding='utf-8')
            env = dict(os.environ)
            env.pop('NODE_TEST_CONTEXT', None)
            checked = subprocess.run(['node','--import','tsx','tests/opbNavGenerations.ts',str(output)],
                cwd=Path(__file__).parents[2] / 'worker', env=env, capture_output=True,
                text=True, encoding='utf-8', timeout=90)
            assert checked.returncode == 0, checked.stdout + checked.stderr
        if not reentry:
            retired = json.loads(Path(str(output) + '.retired.json').read_text(encoding='utf-8'))
            verify_successor_generation(first_fixture, inputs, monkeypatch, directory, reentry=retired)
    finally:
        db.conn.close()
