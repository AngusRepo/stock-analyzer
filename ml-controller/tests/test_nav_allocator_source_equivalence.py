"""Exact saved pre-patch source/allocations, not invented market ROI."""
import base64
import ast
from copy import deepcopy
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from services import paired_nav_collection as source
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_atomic_allocation import allocation_economic_evidence
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
from test_paired_nav_journal import DB, packet, receipt, FEES
from test_paired_nav_review_store import migrate

FIXTURE = Path(__file__).parent / 'fixtures/nav/opb-before-source-handoff.json.gz.b64'
FIXTURE_SHA = '02437b0c28dd8bd73a09c5204dad1044584bcc9a0fd0099f1657e60c4e0cfea0'


def original():
    raw = gzip.decompress(base64.b64decode(FIXTURE.read_text(encoding='ascii')))
    assert hashlib.sha256(raw).hexdigest() == FIXTURE_SHA
    return json.loads(raw)


def test_source_certificate_only_covers_exact_original_read_paths_and_provenance():
    base = Path(source.__file__).parent
    cert = json.loads((base / 'allocator_source_equivalence.json').read_text())
    assert cert['evidence_fixture_sha256'] == FIXTURE_SHA
    actual = source.allocator_runtime_source_identity()
    # The later approved ML-advisory/L4-selection change is NOT covered by this
    # older read-path-only certificate. Never update the certificate to pass.
    assert {name for name in actual if actual[name] != cert['runtime_source_identity'][name]} == {
        'recommendation_service.py'}
    assert source.allocator_source_identity() == actual
    archive = FIXTURE.parent / 'source-before-handoff'
    texts = {}
    for name in ('paired_nav_collection.py', 'opb_nav_control.py', 'opb_nav_serving_source.json'):
        raw = (archive / (name + '.txt')).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == cert['policy_source_identity'][name]
        texts[name] = raw.decode()
    changed = {name for name in cert['policy_source_identity']
               if cert['policy_source_identity'][name] != cert['runtime_source_identity'][name]}
    assert changed == set(texts)
    before = ast.parse(texts['opb_nav_control.py'])
    after = ast.parse((base / 'opb_nav_control.py').read_text())
    for tree in (before, after):
        tree.body = [n for n in tree.body if not isinstance(n, ast.FunctionDef) or n.name != 'capture_nav_control']
    assert ast.dump(before) == ast.dump(after)  # Every frozen replay function/global is identical.
    old_sql = json.loads(texts['opb_nav_serving_source.json'])
    new_sql = json.loads((base / 'opb_nav_serving_source.json').read_text())
    assert old_sql['ev_fence_sql'] == new_sql['ev_fence_sql']
    assert old_sql['control_snapshot_sql'].replace(" AND a.validation_decision='PASS'", '') == new_sql['control_snapshot_sql']
    old = ast.parse(texts['paired_nav_collection.py'])
    new = ast.parse((base / 'paired_nav_collection.py').read_text())
    old_hash = next(n for n in old.body if isinstance(n, ast.FunctionDef) and n.name == 'allocator_source_identity')
    new_hash = next(n for n in new.body if isinstance(n, ast.FunctionDef) and n.name == 'allocator_runtime_source_identity')
    new_hash.name = old_hash.name
    assert ast.dump(old_hash) == ast.dump(new_hash)  # Same exact raw file vector, not removed hashes.
    old.body.remove(old_hash)
    new.body.remove(new_hash)
    new.body = [n for n in new.body if not isinstance(n, ast.FunctionDef) or n.name != 'allocator_source_identity']
    metadata = ast.parse("""if previous is None:
    extra['allocator_runtime_source_identity'] = allocator_runtime_source_identity()
elif 'allocator_runtime_source_identity' in previous:
    extra['allocator_runtime_source_identity'] = previous['allocator_runtime_source_identity']
""").body[0]
    class RemoveOnlyKnownMetadata(ast.NodeTransformer):
        count = 0
        def visit_If(self, node):
            if ast.dump(node) == ast.dump(metadata):
                self.count += 1
                return None
            return self.generic_visit(node)
    strip = RemoveOnlyKnownMetadata()
    new = strip.visit(new)
    assert strip.count == 1
    assert ast.dump(old) == ast.dump(new)  # Entire original allocation/capture path otherwise unchanged.


def test_new_capture_records_runtime_but_legacy_retry_does_not_rewrite_snapshot(monkeypatch):
    from test_paired_nav_intervention import inputs
    db = DB(legacy_assessments=False)
    fixed = datetime.fromisoformat('2026-09-07T14:00:00+00:00')
    def allocation(**kwargs):
        sink = kwargs.pop('allocation_evidence_sink')
        value = run_isolated_allocation(inputs=kwargs, inherited_state={})
        sink(value['capture'])
        return value['recommendations']
    def seal(*, legacy=False, **kwargs):
        if legacy:
            kwargs['content'].pop('allocator_runtime_source_identity', None)
        return freeze_snapshot(**kwargs, now=fixed)
    def capture(run_id):
        return source.run_and_capture_allocation(**inputs(), trading_config={'fees': FEES},
            risk_config={'maxSingleNamePct': .25}, signal_date='2026-09-07', source_run_id=run_id,
            query=db.query, writer=db.writer, run_allocation=allocation)[1]
    monkeypatch.setattr(source, 'freeze_snapshot', lambda **kw: seal(legacy=True, **kw))
    first = capture('legacy-schema-capture')
    assert first['status'] == 'allocation_context_frozen', first
    before = read_snapshot(db.query, first['snapshot_id'])
    monkeypatch.setattr(source, 'freeze_snapshot', seal)
    assert capture('legacy-schema-capture') == first
    assert read_snapshot(db.query, first['snapshot_id']) == before
    newer = capture('new-schema-capture')
    assert newer['status'] == 'allocation_context_frozen', newer
    content = read_snapshot(db.query, newer['snapshot_id'])['payload']['content']
    assert content['allocator_runtime_source_identity'] == source.allocator_runtime_source_identity()
    assert content['allocator_source_identity'] == source.allocator_source_identity()
    assert content['allocator_source_identity'] == content['allocator_runtime_source_identity']
    db.conn.close()


@pytest.fixture
def old_db():
    db = DB(legacy_assessments=False)
    migrate(db)
    f = original()
    for table, ddl in f['schemas'].items():
        if not db.query('SELECT name FROM sqlite_master WHERE type=? AND name=?', ['table', table]):
            db.conn.executescript(ddl)
        for row in f['tables'][table]:
            keys = list(row)
            db.conn.execute(f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' for _ in keys)})",
                            [row[k] for k in keys])
    db.conn.commit()
    yield db
    db.conn.close()


def parents(db):
    return [read_snapshot(db.query, row['snapshot_id']) for row in db.query(
        "SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_context' ORDER BY signal_date", [])]


def test_saved_ten_day_outputs_are_auditable_but_new_policy_cannot_borrow_identity(old_db):
    db = old_db
    before = db.conn.total_changes
    originals = parents(db)
    assert len(originals) == 10
    assert source.allocator_runtime_source_identity() == source.allocator_source_identity()
    def compare_observed_capture(before, after):
        # In these ten fixed valid-EV examples only two advisory metadata fields
        # changed. This finite observation is NOT proof for missing-EV/SELL cases.
        expected = allocation_economic_evidence(before)
        actual = allocation_economic_evidence(after)
        assert actual['allocation_contract'].pop('ml_signal_role') == 'advisory_only'
        assert actual['allocation_contract'].pop('final_decision_owner') == 'allocator_opb_policy'
        assert actual == expected
    for parent in originals:
        c = parent['payload']['content']
        assert c['allocator_source_identity'] != source.allocator_source_identity()
        with pytest.raises(ValueError, match='paired_nav_allocator_source_changed'):
            source.replay_frozen_allocation(snapshot_id=parent['manifest']['snapshot_id'], query=db.query)
        baseline = run_isolated_allocation(inputs=c['inputs'], inherited_state=c['capture'].get('inherited_state') or {})
        assert baseline['output'] == c['formal_output']
        compare_observed_capture(c['capture'], baseline['capture'])
    plans = db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])
    assert len(plans) == 10
    for row in plans:
        p = read_snapshot(db.query, row['snapshot_id'])['payload']['content']
        c = read_snapshot(db.query, p['allocation_context_snapshot_id'])['payload']['content']
        prior = json.loads(c['opb_candidate_selection']['registry_rows'][0]['offline_evidence_json'])
        candidate = run_isolated_allocation(inputs=c['inputs'], inherited_state=c['capture'].get('inherited_state') or {},
            owner='opb_arm_prior', candidate_checksum=p['candidate_checksum'], opb_prior=prior,
            decision_at=datetime.fromisoformat(c['opb_candidate_selection']['decision_cutoff_at']))
        assert candidate['output'] == p['candidate']['output']
        compare_observed_capture(p['candidate']['capture'], candidate['capture'])
    assert db.conn.total_changes == before


@pytest.mark.parametrize('name', [
    'recommendation_service.py', 'portfolio_allocation.py', 'online_portfolio_bandit.py',
    'alpha_framework.py', 'l4_alpha_ev_producer.py', 'allocator_ev_fusion.py', 'paired_nav_intervention.py',
    'expected_return_numeric.py', 'active_model_policy.py', 'paired_nav_collection.py', 'paired_nav_opb_prior.py',
    'opb_nav_control.py', 'opb_nav_serving_source.json'])
def test_unknown_change_in_any_source_cannot_reuse_old_identity(old_db, monkeypatch, name):
    actual = source.allocator_runtime_source_identity()
    actual[name] = '0' * 64
    monkeypatch.setattr(source, 'allocator_runtime_source_identity', lambda: actual)
    assert source.allocator_source_identity() == actual
    with pytest.raises(ValueError, match='paired_nav_allocator_source_changed'):
        source.replay_frozen_allocation(snapshot_id=parents(old_db)[-1]['manifest']['snapshot_id'], query=old_db.query)


def test_changed_selection_policy_preserves_old_ten_sessions_without_transferring_them(old_db, monkeypatch):
    from services import paired_nav_opb_candidate as opb, paired_nav_lifecycle as lifecycle
    from services.paired_nav_evidence import read_verified_nav_evidence
    from services.paired_nav_daily_review import run_daily_nav_reviews
    db = old_db
    originals = {t: db.query(f'SELECT * FROM {t} ORDER BY 1', []) for t in
        ('paired_nav_daily_journal_v1', 'paired_nav_review_records_v1', 'paired_nav_review_parts_v1')}
    assert len(originals['paired_nav_daily_journal_v1']) == 10
    old_pair = originals['paired_nav_daily_journal_v1'][0]['pair_id']
    clock = datetime.fromisoformat('2026-09-21T14:01:00+00:00')
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
    monkeypatch.setattr(lifecycle, 'datetime', Clock)
    monkeypatch.setattr(opb, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
    context = deepcopy(parents(db)[-1]['payload']['content'])
    context.update(allocator_source_identity=source.allocator_source_identity(),
        allocator_runtime_source_identity=source.allocator_runtime_source_identity(),
        opb_candidate_selection=opb.select_opb_candidates(query=db.query, signal_date='2026-09-21', now=clock))
    parent = freeze_snapshot(signal_date='2026-09-21', source_run_id='approved-read-path-patch',
        snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer, now=clock)
    collected = opb.collect_opb_allocations(snapshot_id=parent['snapshot_id'], query=db.query, writer=db.writer)
    assert len(collected['plans']) == 1 and collected['plans'][0]['pair_id'] != old_pair, collected
    assert len(collected['lifecycle_transition_plan']) == 1
    assert collected['lifecycle_transition_plan'][0]['inherited_mature_sessions'] == 0
    assert not collected['lifecycle_transitions']
    item = collected['plans'][0]
    plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    # New comparator's first session, not a missing previous journal to invent.
    execution = packet('2026-09-22')
    execution.update({k: plan[k] for k in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
    execution.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
        schedule=[{'observed_at': '2026-09-22T00:00:00Z'}])
    execution['configuration_checksum'] = digest(execution['configuration'])
    sealed = freeze_snapshot(signal_date='2026-09-21', source_run_id=old_pair, snapshot_kind='execution_pair',
        content=execution, query=db.query, writer=db.writer, now=clock)
    clock = datetime.fromisoformat('2026-09-22T14:00:00+00:00')
    stage_execution_receipt(execution=receipt(execution, sealed, fills=[], marks={'2330': 155}),
        query=db.query, writer=db.writer, now=clock)
    mature_staged_pairs(business_date='2026-09-22', query=db.query, writer=db.writer, now=clock)
    evidence = read_verified_nav_evidence(business_date='2026-09-22', query=db.query, now=clock)
    matching = [p for p in evidence.pairs if p.pair_id == old_pair]
    assert len(matching) == 1 and len(matching[0].observations) == 10
    new_matching = [p for p in evidence.pairs if p.pair_id == item['pair_id']]
    assert len(new_matching) == 1 and len(new_matching[0].observations) == 1
    reviewed = run_daily_nav_reviews(business_date='2026-09-22', query=db.query, writer=db.writer, now=clock)
    assert not reviewed['failures'], reviewed
    for table, rows in originals.items():
        after = db.query(f'SELECT * FROM {table} ORDER BY 1', [])
        assert all(row in after for row in rows)
        assert len(after) == len(rows) + (1 if table == 'paired_nav_daily_journal_v1' else 0)
