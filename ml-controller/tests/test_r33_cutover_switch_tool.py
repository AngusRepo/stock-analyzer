"""tools/r33_cutover_switch.py over in-memory KV and D1: order, rechecks, readback, rollback. No network."""
from argparse import Namespace
from copy import deepcopy
import json
import subprocess
from pathlib import Path
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import r33_cutover_switch as tool  # noqa: E402
from services import r33_switch  # noqa: E402
from test_r33_switch import _inputs  # noqa: E402


class Learning:
    def __init__(self, pointer):
        self.rows, self.pointer = {}, dict(pointer)

    def query(self, sql, params):
        if 'active8_ensemble_pointer_v1' in sql:
            return [dict(self.pointer)]
        row = self.rows.get(params[0])
        return [dict(row)] if row else []

    def execute(self, sql, params):
        if sql.startswith('INSERT'):
            columns = sql[sql.index('(') + 1:sql.index(')')].split(',')[:-2]
            self.rows.setdefault(params[0], {**dict(zip(columns, params)), 'state': 'candidate'})
        elif sql.startswith('DELETE') and self.rows.get(params[0], {}).get('state') == 'candidate':
            del self.rows[params[0]]


@pytest.fixture
def world(monkeypatch, tmp_path):
    inputs = _inputs()
    packet = r33_switch.prepare(**inputs)
    packet.update(controller_source_sha='s', serving_table_stored=False)
    r33_switch.seal(packet)
    (tmp_path / 'packet.json').write_text(json.dumps(packet))
    kv = {w['key']: deepcopy(w['before']) for w in packet['writes'].values()}
    learning = Learning(inputs['pointer'])
    writes = []

    def kv_write(key, value):
        writes.append(key)
        if value is None:
            kv.pop(key, None)
        else:
            kv[key] = deepcopy(value)

    monkeypatch.setattr(tool, '_kv_read', lambda key: deepcopy(kv.get(key)))
    monkeypatch.setattr(tool, '_kv_write', kv_write)
    monkeypatch.setattr(tool, '_snapshot_config', lambda *a: 'snapshot-1')
    monkeypatch.setattr(tool, '_learning', lambda: learning)
    blobs = {}

    class Blob:
        def __init__(self, name): self.name = name
        def upload_from_string(self, body, **kw): blobs.setdefault(self.name, body)
        def download_as_bytes(self): return blobs[self.name]
    monkeypatch.setattr(tool, '_bucket', lambda: types.SimpleNamespace(blob=Blob, name='b'))
    deployed = {'source_sha': 's'}
    head = {'sha': 's'}
    monkeypatch.setattr(tool, '_local_head', lambda: head['sha'])
    dirty = []
    monkeypatch.setattr(tool, '_checkout_changes', lambda: list(dirty))
    monkeypatch.setattr(tool, '_behavior', lambda: {'runtime_admission': packet['writes']['grant']['key']})
    monkeypatch.setitem(sys.modules, 'runtime_context', types.SimpleNamespace(load_environment=lambda: dict(deployed)))
    monkeypatch.setattr(r33_switch, 'validate_packet', _validate_at(r33_switch.validate_packet))
    from services import active8_paper_admission, worker_config_client
    granted = packet['approval']['configuration']['trading_config']
    live = {'config': inputs['merged_config']}
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config',
                        lambda: deepcopy(granted if kv['trading:config'] == packet['writes']['kv-config']['after']
                                         else live['config']))
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval',
                        lambda admission, **kw: deepcopy(kv[packet['writes']['grant']['key']]
                                                         if admission == kv.get(active8_paper_admission.KEY) else None))

    def promote(packet, *, confirm):
        if confirm:
            learning.pointer.update({k: packet['ensemble_row'][k] for k in r33_switch.IDENTITY_KEYS})
        return {'status': 'ok'} if confirm else {'status': 'dry_run', 'can_promote': True}
    monkeypatch.setattr(tool, '_promote', promote)
    run = lambda command, step, execute=False: tool.activate(
        Namespace(out=tmp_path, step=step, execute=execute), undo=command == 'rollback')
    return types.SimpleNamespace(packet=packet, kv=kv, learning=learning, writes=writes, run=run, live=live,
                                 out=tmp_path, blobs=blobs, deployed=deployed, head=head, dirty=dirty)


def _validate_at(validate):
    from test_r33_switch import NOW
    return lambda packet, now: validate(packet, now=NOW)


def test_steps_run_one_at_a_time_and_only_in_order(world):
    with pytest.raises(SystemExit, match='not the next step'):
        world.run('activate', 'admission', execute=True)
    world.run('activate', 'kv-config')
    assert world.writes == [] and (world.out / 'activate-kv-config-dry-run.json').exists()
    for step in r33_switch.STEPS:
        world.run('activate', step, execute=True)
    assert world.writes == ['trading:config', 'ml:active8:paper_admission:v1', world.packet['writes']['grant']['key']]
    assert world.kv['trading:config'] == world.packet['writes']['kv-config']['after']
    assert world.learning.rows[world.packet['ensemble_row']['artifact_id']]['knowledge_cutoff_date'] == '2026-10-26'
    assert list(world.blobs) == ['r33/monthly_candidates/c1/crossfit_serving_table.json']
    receipt = json.loads((world.out / 'activate-promotion-01-receipt.json').read_text())
    assert receipt['status'] == 'written_readback_verified'


def test_kv_config_refuses_when_the_live_grant_or_config_moved(world):
    world.live['config'] = {**world.live['config'], 'fees': {'commission': 0, 'tax': 0}}
    with pytest.raises(RuntimeError, match='prior_config_not_live_config'):
        world.run('activate', 'kv-config', execute=True)
    assert world.writes == []


def test_a_foreign_value_between_steps_is_drift_and_nothing_is_written(world):
    world.run('activate', 'kv-config', execute=True)
    world.kv['ml:active8:paper_admission:v1'] = {'someone': 'else'}
    with pytest.raises(RuntimeError, match='admission=drift'):
        world.run('activate', 'admission', execute=True)
    assert world.writes == ['trading:config']


def test_rollback_undoes_the_last_done_step_and_never_republishes_a_pointer(world):
    for step in r33_switch.STEPS[:4]:
        world.run('activate', step, execute=True)
    with pytest.raises(SystemExit, match='not the last done step'):
        world.run('rollback', 'grant', execute=True)
    world.run('rollback', 'r33-row', execute=True)
    assert world.learning.rows == {}
    for step in ('grant', 'admission', 'kv-config'):
        world.run('rollback', step, execute=True)
    assert world.kv == {w['key']: w['before'] for w in world.packet['writes'].values()}
    for step in r33_switch.STEPS:
        world.run('activate', step, execute=True)
    with pytest.raises(SystemExit, match='promotion rollback'):
        world.run('rollback', 'promotion', execute=True)


def test_a_tampered_packet_is_refused(world):
    packet = json.loads((world.out / 'packet.json').read_text())
    packet['writes']['kv-config']['after']['exit']['swingHardStopPct'] = -.5
    (world.out / 'packet.json').write_text(json.dumps(packet))
    with pytest.raises(RuntimeError, match='packet_checksum_mismatch'):
        world.run('activate', 'kv-config', execute=True)


def test_readbacks_must_show_the_granted_config_and_the_cutover_grant(world, monkeypatch):
    from services import active8_paper_admission, worker_config_client
    stale, original = world.live['config'], worker_config_client.load_active_trading_config
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', lambda: deepcopy(stale))
    # check_prior passes on the live config; the post-write merged readback still shows the old one.
    with pytest.raises(RuntimeError, match='worker_merged_config_not_the_granted_config'):
        world.run('activate', 'kv-config', execute=True)
    world.kv['trading:config'] = deepcopy(world.packet['writes']['kv-config']['before'])
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', original)
    world.run('activate', 'kv-config', execute=True)
    world.run('activate', 'admission', execute=True)
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda admission, **kw: {'other': True})
    with pytest.raises(RuntimeError, match='active_grant_not_the_cutover_grant'):
        world.run('activate', 'grant', execute=True)


def test_a_resealed_edit_is_still_refused_by_the_validators(world):
    packet = json.loads((world.out / 'packet.json').read_text())
    packet['writes']['kv-config']['after']['exit']['swingHardStopPct'] = 5
    r33_switch.seal(packet)
    (world.out / 'packet.json').write_text(json.dumps(packet))
    with pytest.raises(RuntimeError, match='raw_config_not_the_granted_change'):
        world.run('activate', 'kv-config', execute=True)
    assert world.writes == []


def test_a_new_controller_release_after_prepare_is_refused(world):
    world.deployed['source_sha'] = world.head['sha'] = 'other'
    with pytest.raises(SystemExit, match='deployed controller source changed'):
        world.run('activate', 'kv-config')


def test_a_checkout_that_is_not_the_deployed_source_is_refused(world):
    world.head['sha'] = 'pulled'
    with pytest.raises(SystemExit, match='is not the deployed controller source'):
        world.run('activate', 'kv-config')
    assert world.writes == []


def test_a_grant_key_that_is_not_the_deployed_runtime_key_is_refused(world, monkeypatch):
    monkeypatch.setattr(tool, '_behavior', lambda: {'runtime_admission': 'ml:active8:paper_runtime_approval:v1:other'})
    with pytest.raises(SystemExit, match='runtime_admission'):
        world.run('activate', 'kv-config')
    assert world.writes == []


def test_rollback_stays_available_after_a_new_controller_release(world):
    world.run('activate', 'kv-config', execute=True)
    world.deployed['source_sha'] = world.head['sha'] = 'later'
    with pytest.raises(SystemExit, match='deployed controller source changed'):
        world.run('activate', 'admission', execute=True)
    world.run('rollback', 'kv-config', execute=True)
    assert world.kv['trading:config'] == world.packet['writes']['kv-config']['before']


def test_a_step_whose_readback_failed_is_rechecked_before_the_next_step(world, monkeypatch):
    from services import active8_paper_admission, worker_config_client
    stale, original = world.live['config'], worker_config_client.load_active_trading_config
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', lambda: deepcopy(stale))
    with pytest.raises(RuntimeError, match='worker_merged_config_not_the_granted_config'):
        world.run('activate', 'kv-config', execute=True)
    # KV holds the new value, so kv-config reads as done; the next step still refuses.
    with pytest.raises(RuntimeError, match='worker_merged_config_not_the_granted_config'):
        world.run('activate', 'admission', execute=True)
    assert world.writes == ['trading:config']
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', original)
    world.run('activate', 'admission', execute=True)
    verify = active8_paper_admission.verify_active_approval
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda admission, **kw: {'other': True})
    with pytest.raises(RuntimeError, match='active_grant_not_the_cutover_grant'):
        world.run('activate', 'grant', execute=True)
    with pytest.raises(RuntimeError, match='active_grant_not_the_cutover_grant'):
        world.run('activate', 'r33-row', execute=True)
    assert world.learning.rows == {}
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', verify)
    world.run('activate', 'r33-row', execute=True)


@pytest.mark.parametrize('race_at', [2, 3])   # 2: before the snapshot, 3: after it, right before the PUT
def test_every_write_rechecks_the_live_value_right_before_it(world, monkeypatch, race_at):
    reads = {'n': 0}
    real = tool._kv_read

    def racing(key):
        value = real(key)
        if key == 'trading:config':
            reads['n'] += 1
            if reads['n'] >= race_at:    # someone else wrote between the step check and the write
                return {'raced': True}
        return value
    monkeypatch.setattr(tool, '_kv_read', racing)
    with pytest.raises(RuntimeError, match='live_value_changed_before_write'):
        world.run('activate', 'kv-config', execute=True)
    assert world.writes == []


def test_rollback_rechecks_and_reads_back(world, monkeypatch):
    from services import worker_config_client
    world.run('activate', 'kv-config', execute=True)
    world.kv['trading:config'] = {'someone': 'else'}
    with pytest.raises(RuntimeError, match='drift'):
        world.run('rollback', 'kv-config', execute=True)
    world.kv['trading:config'] = deepcopy(world.packet['writes']['kv-config']['after'])
    granted = world.packet['approval']['configuration']['trading_config']
    monkeypatch.setattr(worker_config_client, 'load_active_trading_config', lambda: deepcopy(granted))
    with pytest.raises(RuntimeError, match='worker_merged_config_not_the_prior_config'):
        world.run('rollback', 'kv-config', execute=True)


def test_r33_row_needs_the_stored_table_and_the_row_readback(world, monkeypatch):
    for step in r33_switch.STEPS[:3]:
        world.run('activate', step, execute=True)
    path = world.packet['approval']['approved_r33_cutover']['calibration']['serving_table_path']
    world.blobs[path] = b'{"other":1}'
    with pytest.raises(RuntimeError, match='stored_serving_table_differs'):
        world.run('activate', 'r33-row', execute=True)
    assert world.learning.rows == {}
    del world.blobs[path]
    monkeypatch.setattr(world.learning, 'execute', lambda sql, params: None)
    with pytest.raises(RuntimeError, match='r33_row_readback_mismatch'):
        world.run('activate', 'r33-row', execute=True)


def test_a_packet_whose_writes_differ_from_its_validated_values_is_refused(world):
    packet = json.loads((world.out / 'packet.json').read_text())
    packet['writes']['grant']['after'] = {**packet['writes']['grant']['after'], 'source_reference': 'edited'}
    r33_switch.seal(packet)
    (world.out / 'packet.json').write_text(json.dumps(packet))
    with pytest.raises(RuntimeError, match='packet_writes_not_the_validated_values'):
        world.run('activate', 'kv-config')


def test_promotion_needs_the_cutover_grant_active(world, monkeypatch):
    for step in r33_switch.STEPS[:4]:
        world.run('activate', step, execute=True)
    from services import active8_paper_admission
    monkeypatch.setattr(active8_paper_admission, 'verify_active_approval', lambda admission, **kw: {'other': True})
    with pytest.raises(RuntimeError, match='active_grant_not_the_cutover_grant'):
        world.run('activate', 'promotion', execute=True)
    assert {k: world.learning.pointer[k] for k in r33_switch.IDENTITY_KEYS} == world.packet['baseline_pointer']


def test_prepare_needs_the_deployed_checkout(world, tmp_path):
    world.head['sha'] = 'pulled'
    with pytest.raises(SystemExit, match='is not the deployed controller source'):
        tool.prepare(Namespace(out=tmp_path / 'new'))
    assert not (tmp_path / 'new').exists()


def test_a_blocked_publisher_fails_the_promotion_dry_run(world, monkeypatch):
    for step in r33_switch.STEPS[:4]:
        world.run('activate', step, execute=True)
    world.run('activate', 'promotion')
    assert json.loads((world.out / 'activate-promotion-dry-run.json').read_text())['publisher_dry_run']['can_promote']
    monkeypatch.setattr(tool, '_promote', lambda packet, *, confirm: {
        'status': 'blocked', 'decision': 'active8_bundle_contract_invalid', 'can_promote': False})
    with pytest.raises(SystemExit, match='publisher_dry_run_not_promotable:active8_bundle_contract_invalid'):
        world.run('activate', 'promotion')
    saved = json.loads((world.out / 'activate-promotion-dry-run.json').read_text())
    assert saved['publisher_dry_run']['status'] == 'blocked'    # kept for inspection
    assert {k: world.learning.pointer[k] for k in r33_switch.IDENTITY_KEYS} == world.packet['baseline_pointer']


def _full_fit_metadata(model, known='2026-10-30', **fit):
    return {'model_name': model, 'deployment_fit': {
        'performed': True, 'label_known_date_max': known, 'knowledge_cutoff_date': known,
        'input_scope': {'label_known_at_max': known, 'point_in_time_vintage_certified': True,
                        'pit_certification_sha256': '9' * 64}, **fit}}


@pytest.fixture
def prepare_world(world, monkeypatch, tmp_path):
    """prepare's reads up to the serving table: the label attestation runs on full-fit metadata."""
    from test_r33_switch import _bundle
    from services import d1_domain_client
    bundle = _bundle()
    blobs = {'bundle.json': json.dumps(bundle).encode(), bundle['oof_checks']['path']: b'{}'}
    for model, item in bundle['artifacts'].items():
        blobs[item['metadata_path']] = json.dumps(_full_fit_metadata(model)).encode()

    class Blob:
        def __init__(self, name): self.name = name
        def download_as_bytes(self): return blobs[self.name]
        def download_as_text(self): return blobs[self.name].decode()
    monkeypatch.setattr(tool, '_bucket', lambda: types.SimpleNamespace(blob=Blob, name='b'))
    monkeypatch.setattr(d1_domain_client, 'client_for_domain',
                        lambda domain: types.SimpleNamespace(query=lambda sql, params: [{'plan_id': 'p' * 64}]))
    monkeypatch.setattr(r33_switch, 'check_oof_checks_report', lambda raw, bundle: {})
    args = Namespace(out=tmp_path / 'prepare', bundle_path='bundle.json', serving_table=tmp_path / 'no-table.json')
    return types.SimpleNamespace(bundle=bundle, blobs=blobs, args=args)


@pytest.mark.parametrize('trainer', ['2026-10-30', '2026-10-29'])    # equal to / below the scope ceiling
def test_prepare_attests_full_fit_labels_from_deployment_fit(prepare_world, trainer):
    item = prepare_world.bundle['artifacts']['TabM']
    prepare_world.blobs[item['metadata_path']] = json.dumps(
        _full_fit_metadata('TabM', label_known_date_max=trainer)).encode()
    # Past the attestation, prepare reaches the serving table (absent here).
    with pytest.raises(FileNotFoundError, match='no-table.json'):
        tool.prepare(prepare_world.args)


@pytest.mark.parametrize('fit,reason', [
    ({'performed': False}, 'full_fit_not_performed'),
    ({'label_known_date_max': '2026-10-31'}, 'full_fit_label_known_max_exceeds_scope'),
    ({'input_scope': {'label_known_at_max': '2026-11-03', 'point_in_time_vintage_certified': True,
                      'pit_certification_sha256': '9' * 64}}, 'full_fit_label_known_max_after_cutoff'),
    ({'label_known_date_max': None, 'input_scope': {'point_in_time_vintage_certified': True,
                                                    'pit_certification_sha256': '9' * 64}},
     'full_fit_label_known_max_missing'),
    ({'input_scope': {'label_known_at_max': '2026-10-30', 'point_in_time_vintage_certified': False}},
     'full_fit_scope_not_pit_certified'),
    ({'input_scope': {'label_known_at_max': '2026-10-30', 'point_in_time_vintage_certified': True,
                      'pit_certification_sha256': '8' * 64}}, 'full_fit_scope_pit_receipt_mismatch'),
])
def test_prepare_refuses_an_unattested_full_fit_artifact(prepare_world, fit, reason):
    item = prepare_world.bundle['artifacts']['TabM']
    prepare_world.blobs[item['metadata_path']] = json.dumps(_full_fit_metadata('TabM', **fit)).encode()
    with pytest.raises(RuntimeError, match='r33_artifact_label_attestation_invalid:.*"TabM": "' + reason):
        tool.prepare(prepare_world.args)


def test_prepare_refuses_metadata_of_another_model(prepare_world):
    items = prepare_world.bundle['artifacts']
    prepare_world.blobs[items['TabM']['metadata_path']] = json.dumps(_full_fit_metadata('GNN')).encode()
    with pytest.raises(RuntimeError, match='"TabM": "full_fit_metadata_model_mismatch"'):
        tool.prepare(prepare_world.args)


def test_prepare_refuses_labels_after_the_bundle_cutoff(prepare_world):
    for model, item in prepare_world.bundle['artifacts'].items():
        prepare_world.blobs[item['metadata_path']] = json.dumps(_full_fit_metadata(model, known='2026-11-03')).encode()
    with pytest.raises(RuntimeError, match='full_fit_label_known_max_after_cutoff'):
        tool.prepare(prepare_world.args)


def test_prepare_refuses_fold_only_metadata(prepare_world):
    # A fold artifact's split_metadata attestation is not a deployment-fit attestation.
    item = prepare_world.bundle['artifacts']['GNN']
    prepare_world.blobs[item['metadata_path']] = json.dumps(
        {'model_name': 'GNN', 'split_metadata': {'train_label_known_max': '2026-10-30'}}).encode()
    with pytest.raises(RuntimeError, match='"GNN": "full_fit_not_performed"'):
        tool.prepare(prepare_world.args)


def test_a_dirty_checkout_at_the_deployed_sha_is_refused(world, tmp_path):
    world.dirty.append('ml-controller/services/model_artifact_registry.py')
    with pytest.raises(SystemExit, match='r33_cutover_checkout_dirty:ml-controller/services/model_artifact_registry.py'):
        world.run('activate', 'kv-config')
    with pytest.raises(SystemExit, match='r33_cutover_checkout_dirty'):
        tool.prepare(Namespace(out=tmp_path / 'new'))
    assert world.writes == [] and not (tmp_path / 'new').exists()
    world.dirty.clear()
    world.run('activate', 'kv-config')


def test_a_dirty_checkout_blocks_rollback_too(world):
    # Rollback may run on a later release (no HEAD check) but never on modified local code.
    world.run('activate', 'kv-config', execute=True)
    world.dirty.append('ml-controller/services/r33_switch.py')
    with pytest.raises(SystemExit, match='r33_cutover_checkout_dirty'):
        world.run('rollback', 'kv-config', execute=True)
    assert world.kv['trading:config'] == world.packet['writes']['kv-config']['after']
    world.dirty.clear()
    world.run('rollback', 'kv-config', execute=True)
    assert world.kv['trading:config'] == world.packet['writes']['kv-config']['before']


def test_the_dirty_check_runs_before_the_environment_is_loaded(world, monkeypatch, tmp_path):
    def secrets():
        raise AssertionError('load_environment ran on a dirty checkout')
    monkeypatch.setitem(sys.modules, 'runtime_context', types.SimpleNamespace(load_environment=secrets))
    world.dirty.append('tools/release/runtime_context.py')
    for run in (lambda: tool.prepare(Namespace(out=tmp_path / 'new')), lambda: world.run('activate', 'kv-config'),
                lambda: world.run('rollback', 'kv-config')):
        with pytest.raises(SystemExit, match='r33_cutover_checkout_dirty'):
            run()


@pytest.fixture
def checkout(tmp_path):
    """A real git checkout laid out like the deployed clone (code dirs, audits/, ignored files)."""
    import subprocess
    repo = tmp_path / 'clone'

    def git(*args):
        subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
    for path, body in {'ml-controller/services/a.py': 'A = 1\n', 'tools/t.py': 'T = 1\n',
                       'audits/kept.json': '{}\n', '.gitignore': '__pycache__/\n.venv/\n*.pyc\n'}.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(body)
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
    return types.SimpleNamespace(repo=repo, git=git, changes=lambda: tool._checkout_changes(repo))


def test_checkout_changes_clean_tree_and_runbook_outputs_pass(checkout):
    assert checkout.changes() == []
    # The runbook's audits/ inputs and cutover --out directory, plus ignored runtime files.
    for path in ('audits/slicea-release/crossfit_serving_table.json', 'audits/slicea-cutover-x/packet.json',
                 'audits/slicea-cutover-x/notes.py', 'ml-controller/services/__pycache__/a.cpython-312.pyc',
                 'ml-controller/.venv/lib/site.py', 'ml-controller/services/scratch.txt'):
        (checkout.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (checkout.repo / path).write_text('x')
    (checkout.repo / 'tools/.venv').symlink_to(checkout.repo / 'ml-controller/.venv')    # a linked venv
    assert checkout.changes() == []


def test_checkout_changes_ignore_the_callers_git_environment(checkout, monkeypatch, tmp_path):
    (checkout.repo / 'tools/t.py').write_text('T = 2\n')
    other = tmp_path / 'other'
    subprocess.run(['git', 'init', '-q', str(other)], check=True)
    monkeypatch.setenv('GIT_DIR', str(other / '.git'))
    monkeypatch.setenv('GIT_INDEX_FILE', str(other / '.git' / 'index'))
    assert checkout.changes() == ['tools/t.py']


@pytest.mark.parametrize('change,expected', [
    (lambda c: (c.repo / 'ml-controller/services/a.py').write_text('A = 2\n'), 'ml-controller/services/a.py'),
    (lambda c: ((c.repo / 'tools/t.py').write_text('T = 2\n'), c.git('add', 'tools/t.py')), 'tools/t.py'),
    (lambda c: (c.repo / 'ml-controller/services/a.py').unlink(), 'ml-controller/services/a.py'),
    (lambda c: ((c.repo / 'ml-controller/services/a.py').write_text('A = 3\n'),
                c.git('update-index', '--assume-unchanged', 'ml-controller/services/a.py')), 'ml-controller/services/a.py'),
    (lambda c: ((c.repo / 'tools/t.py').write_text('T = 3\n'),
                c.git('update-index', '--skip-worktree', 'tools/t.py')), 'tools/t.py'),
    (lambda c: (c.repo / 'ml-controller/services/json.py').write_text('x'), 'ml-controller/services/json.py'),
    (lambda c: (c.repo / 'tools/release_shadow.py').write_text('x'), 'tools/release_shadow.py'),
    # ignored by .gitignore but still importable (sys.path puts code dirs before the stdlib)
    (lambda c: (c.repo / 'ml-controller/ssl.pyc').write_bytes(b'x'), 'ml-controller/ssl.pyc'),
    (lambda c: (c.repo / 'tools/fast.cpython-312-darwin.so').write_bytes(b'x'), 'tools/fast.cpython-312-darwin.so'),
    # git lists these as one entry each and never expands them, yet each can shadow a package
    (lambda c: ((c.repo / 'ml-controller/json').mkdir(), (c.repo / 'ml-controller/json/__init__.py').write_text('x'),
                subprocess.run(['git', 'init', '-q', str(c.repo / 'ml-controller/json')], check=True)), 'ml-controller/json/'),
    (lambda c: ((c.repo.parent / 'elsewhere').mkdir(), (c.repo.parent / 'elsewhere/__init__.py').write_text('x'),
                (c.repo / 'tools/numpy').symlink_to(c.repo.parent / 'elsewhere')), 'tools/numpy'),
    (lambda c: (c.repo / 'tools/\u00e9.py').write_text('x'), 'tools/\u00e9.py'),
    (lambda c: (c.git('mv', 'tools/t.py', 'tools/u.py')), 'tools/u.py'),
])
def test_checkout_changes_report_modified_staged_hidden_and_untracked_code(checkout, change, expected):
    change(checkout)
    assert expected in checkout.changes()


def _held_table_world(prepare_world, monkeypatch, estimator):
    from services import r33_crossfit_serving as serving
    held = {'inputs': {'estimator': estimator}, 'payload_checksum': 'h' * 64}
    prepare_world.args.serving_table.write_text(json.dumps(held))
    seen = []

    def rebuild(bundle, *, bucket, ops_query, round_trip_cost, estimator):
        seen.append(estimator)
        return held, {'passed': True}
    monkeypatch.setattr(serving, 'rebuild_and_check', rebuild)
    monkeypatch.setattr(tool._bucket().blob, 'exists', lambda self: self.name in prepare_world.blobs, raising=False)
    return held, seen


@pytest.mark.parametrize('estimator', ['r33-purged-cv-hinge-v1', 'r33-purged-crossfit-recalibrated-v1'])
def test_prepare_rebuilds_with_the_tables_own_estimator_and_never_overwrites_its_stored_table(
        prepare_world, monkeypatch, estimator):
    from services import r33_crossfit_serving as serving
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX
    _, seen = _held_table_world(prepare_world, monkeypatch, estimator)
    path = f"{BUNDLE_PREFIX}/{prepare_world.bundle['cohort_id']}/{serving.table_name(estimator)}"
    prepare_world.blobs[path] = serving.table_bytes({'inputs': {'estimator': estimator}, 'payload_checksum': 's' * 64})
    with pytest.raises(RuntimeError, match='stored_serving_table_differs'):
        tool.prepare(prepare_world.args)
    assert seen == [estimator]


@pytest.mark.parametrize('migrated', [True, False])
def test_a_new_estimator_in_a_stored_cohort_goes_to_the_recalibration_check(prepare_world, monkeypatch, tmp_path,
                                                                            migrated):
    # The legacy table stays at its own path; prepare hands the live object and Wei's approval to
    # r33_switch.prepare, which refuses a same-cohort swap without that approval. Before learning
    # 0072 the second row of the cohort cannot be inserted, so prepare stops before any write.
    from services import r33_crossfit_serving as serving
    from services import r33_switch
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX
    held, _ = _held_table_world(prepare_world, monkeypatch, serving.HINGE_ESTIMATOR)
    cohort = prepare_world.bundle['cohort_id']
    prepare_world.blobs[f"{BUNDLE_PREFIX}/{cohort}/{serving.TABLE_NAME}"] = b'{"legacy": true}'
    live = {'artifact_id': 'r33-roster:' + cohort + ':live', 'payload_checksum': 'l' * 64}

    probe = json.loads((ROOT / 'tools/d1/overrides.json').read_text())['probes']['learning'][tool.MIGRATION_0072]

    class Learning:
        def query(self, sql, params):
            if sql == probe:
                return [{'ok': 1 if migrated else 0}]
            if 'active8_ensemble_artifacts_v1' in sql:
                return [{'payload_json': json.dumps(live), 'payload_checksum': live['payload_checksum']}]
            return [{'plan_id': 'p' * 64, 'artifact_id': live['artifact_id'], 'cohort_id': cohort}]
    monkeypatch.setattr(tool, '_learning', lambda: Learning())
    approval = tmp_path / 'recalibration.json'
    approval.write_text(json.dumps({'schema_version': r33_switch.RECALIBRATION_SCHEMA}))
    (tmp_path / 'evidence.json').write_text('{}')
    (tmp_path / 'wei.json').write_text('{}')
    for name, value in dict(recalibration_approval=approval, source_evidence=tmp_path / 'evidence.json',
                            wei_approval=tmp_path / 'wei.json', swing_hard_stop_pct=-0.1, swing_max_hold_sessions=10,
                            business_date='2026-11-24', effective_signal_date='2026-11-24',
                            source_reference='SYNTHETIC').items():
        setattr(prepare_world.args, name, value)
    captured = {}

    def stop(**kwargs):
        captured.update(kwargs)
        raise RuntimeError('reached_r33_switch_prepare')
    monkeypatch.setattr(r33_switch, 'prepare', stop)
    if not migrated:
        with pytest.raises(RuntimeError, match='recalibration_needs_learning_migration_0072'):
            tool.prepare(prepare_world.args)
        assert captured == {}
        return
    with pytest.raises(RuntimeError, match='reached_r33_switch_prepare'):
        tool.prepare(prepare_world.args)
    assert captured['serving_table'] == held and captured['live_ensemble'] == live
    assert captured['recalibration_approval'] == {'schema_version': r33_switch.RECALIBRATION_SCHEMA}
