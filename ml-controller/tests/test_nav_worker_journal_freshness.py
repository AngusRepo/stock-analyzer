"""Real numerical PASS then original cash correction; private D1, not ROI."""
import json
import os
from pathlib import Path
import subprocess

from services import paired_nav_daily_review as daily
from services.paired_nav_expected_return_gate import nav_promotion_gate, candidate_owner_payload
from test_nav_candidate_decision import environment, candidate, read
from test_paired_nav_lifecycle import stamp
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_daily_review import append_session, receipt as original_receipt


def test_worker_rejects_exported_pass_when_original_accounting_advances(environment, monkeypatch, tmp_path):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    previous = '2026-09-09'
    for index, day in enumerate(['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
            '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21']):
        append_session(environment, monkeypatch, previous, day, 150 + index * 50)
        previous = day
    assert not daily.run_daily_nav_reviews(business_date=previous, query=db.query,
        writer=db.writer, now=stamp(previous))['failures']
    c = candidate(environment)
    gate = nav_promotion_gate([], owner='l4_alpha_ev', candidate=c, business_date=previous,
        query_fn=db.query, now=stamp(previous))
    assert gate['decision'] == 'PASS'
    db.conn.execute('UPDATE model_artifact_registry SET live_evidence_json=? WHERE artifact_id=?',
        [json.dumps(gate), c['registry']['artifact_id']])
    names = ['model_artifact_registry', 'paired_nav_review_records_v1', 'paired_nav_review_parts_v1',
        'paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1', 'paired_nav_daily_journal_v1']
    tables = {name: db.query(f'SELECT * FROM {name}', []) for name in names}
    schema = [db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name])[0]['sql'] for name in names]
    def corrected(packet, seal, **kwargs):
        raw = original_receipt(packet, seal, **kwargs)
        if packet['owner'] == 'l4_alpha_ev':
            raw.update(cash_accounting_version=1, corporate_actions=[{
                'action_id': 'late-original-cash', 'symbol': '2330', 'kind': 'cash',
                'ex_date': '2026-09-10', 'payable_date': '2026-09-22',
                'cash_per_share': 2., 'stock_per_share': 0.}])
        return raw
    monkeypatch.setattr('test_paired_nav_daily_review.receipt', corrected)
    append_session(environment, monkeypatch, previous, '2026-09-22', 500)
    assert read(environment, day='2026-09-22')['reason'] == 'nav_checkpoint_accounting_restated'
    added = {name: [row for row in db.query(f'SELECT * FROM {name}', []) if row not in tables[name]]
        for name in names if name.startswith('paired_nav_frozen_') or name == 'paired_nav_daily_journal_v1'}
    assert any(json.loads(row['payload_json'])['arms']['candidate'].get('cash_corrections')
        for row in added['paired_nav_daily_journal_v1'])
    fixture = tmp_path / 'original-nav-freshness.json'
    fixture.write_text(json.dumps({'now': stamp('2026-09-22').isoformat(), 'schema': schema,
        'tables': tables, 'added': added, 'payload': candidate_owner_payload(c, gate, 'fixture-cohort')},
        ensure_ascii=False), encoding='utf-8')
    root = Path(__file__).parents[2]
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap', 'tests/navJournalFreshnessD1.ts'],
        cwd=root / 'worker', env={**os.environ, 'NAV_JOURNAL_FRESHNESS_FIXTURE': str(fixture)},
        capture_output=True, text=True, encoding='utf-8', timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '# pass 4' in result.stdout and '# fail 0' in result.stdout
