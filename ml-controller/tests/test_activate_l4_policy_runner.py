"""CD-NEW-07: grant/activate take the native Paper runner from the new-grant admission, not a hand-set env."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

TOOL = Path(__file__).resolve().parents[2] / 'tools/activate_l4_policy.py'
spec = importlib.util.spec_from_file_location('activate_l4_policy', TOOL)
activate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activate)


def admission(tmp_path, *, mode='new-grant', bundle=b'bundle', recorded=None):
    (tmp_path / 'native-paper.cjs').write_bytes(bundle)
    receipt = {'mode': mode, 'native_bundle_sha256': recorded if recorded is not None else hashlib.sha256(bundle).hexdigest()}
    (tmp_path / 'admission-receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    return tmp_path


def test_admission_bundle_becomes_the_native_runner(tmp_path, monkeypatch):
    monkeypatch.setenv('NATIVE_PAPER_RUNNER', '/elsewhere/native-paper.cjs')
    bundle = activate.use_admission_bundle(admission(tmp_path))
    assert activate.os.environ['NATIVE_PAPER_RUNNER'] == str(bundle) == str((tmp_path / 'native-paper.cjs').resolve())


def test_bundle_must_match_the_admission_receipt(tmp_path, monkeypatch):
    monkeypatch.delenv('NATIVE_PAPER_RUNNER', raising=False)
    with pytest.raises(RuntimeError, match='admission_native_bundle_checksum_mismatch'):
        activate.use_admission_bundle(admission(tmp_path, recorded='0' * 64))
    assert 'NATIVE_PAPER_RUNNER' not in activate.os.environ


def test_reuse_admission_has_no_bundle_to_run(tmp_path):
    with pytest.raises(SystemExit, match='new-grant admission'):
        activate.use_admission_bundle(admission(tmp_path, mode='reuse', recorded=''))


@pytest.mark.parametrize('command', ['grant', 'activate'])
def test_grant_and_activate_refuse_to_start_without_the_admission_dir(command, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['activate_l4_policy.py', command, '--workspace-root', str(tmp_path),
                                      '--out', str(tmp_path / 'out')])
    with pytest.raises(SystemExit, match='needs --admission-dir'):
        activate.main()
    assert not (tmp_path / 'out').exists()  # stopped before any directory, credential or cloud read


# M1-c: activating P1/P2 with another release's admission (e.g. r31's run-M) must stop at once.
def release(tmp_path, *, new_key='ml:active8:paper_runtime_approval:v1:wrel', admitted_key=None):
    """An admission dir, a controller tree and an --out dir as one release leaves them."""
    s_grant = {'admission': {'release': 'wrel'}, 'approval_checksum': 's' * 64,
               'configuration': {'trading_config': {'a': 0}, 'risk_config': {'r': 0}, 'native_execution_policy': 'wrel'}}
    admission_dir = tmp_path / 'admission'
    admission_dir.mkdir()
    (admission_dir / 'source-grant.json').write_text(json.dumps(s_grant), encoding='utf-8')
    behavior = tmp_path / 'controller/services/native_execution_behavior_release.json'
    behavior.parent.mkdir(parents=True)
    behavior.write_text(json.dumps({'runtime_admission': admitted_key or new_key}), encoding='utf-8')
    nav = behavior.parent / 'strategy_nav_source_release.json'
    nav.write_text(json.dumps({'source': 'wrel'}), encoding='utf-8')
    out = tmp_path / 'out'
    out.mkdir()
    (out / 'policy-chain.json').write_text(json.dumps([{'packet': 1}]), encoding='utf-8')
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    receipt = {'mode': 'new-grant', 'new_key': new_key, 'approval_checksum': 's' * 64,
               'manifest_sha256': {path.name: digest(path) for path in (behavior, nav)},
               'policy_chain_sha256': digest(out / 'policy-chain.json')}
    (admission_dir / 'admission-receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    p1 = {**s_grant, 'configuration': {**s_grant['configuration'], 'trading_config': {'a': 1}, 'risk_config': {'r': 1}},
          'approved_l4_execution_policy_change': {'activation_checksums': ['x']}, 'approval_checksum': 'p' * 64}
    (out / 'policy-grants.json').write_text(json.dumps([p1]), encoding='utf-8')
    source = tmp_path / 's.json'
    source.write_text(json.dumps(s_grant), encoding='utf-8')
    return admission_dir, tmp_path / 'controller', out, source


def bind(admission_dir, controller, out, source, command='activate'):
    return activate.bind_admission(admission_dir, command, source_grant=source, controller=controller, out=out)


def test_the_release_own_admission_binds_grant_and_activate(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    assert bind(admission_dir, controller, out, source)['new_key'].endswith(':wrel')
    assert bind(admission_dir, controller, out, source, 'grant')['approval_checksum'] == 's' * 64


def test_another_release_admission_is_refused_for_activate(tmp_path):
    admission_dir, controller, out, source = release(tmp_path, new_key='ml:active8:paper_runtime_approval:v1:r31',
                                                     admitted_key='ml:active8:paper_runtime_approval:v1:wrel')
    with pytest.raises(RuntimeError, match='admission_not_for_this_release'):
        bind(admission_dir, controller, out, source)


def test_behavior_manifest_must_be_the_one_the_admission_wrote(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    behavior = controller / 'services/native_execution_behavior_release.json'
    behavior.write_text(json.dumps({'runtime_admission': 'ml:active8:paper_runtime_approval:v1:wrel', 'other': 1}), encoding='utf-8')
    with pytest.raises(RuntimeError, match='admission_not_for_this_release'):
        bind(admission_dir, controller, out, source)


def test_policy_grants_must_derive_from_the_admission_s_grant(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    grants = json.loads((out / 'policy-grants.json').read_text())
    grants[0]['admission'] = {'release': 'r31'}
    (out / 'policy-grants.json').write_text(json.dumps(grants), encoding='utf-8')
    with pytest.raises(RuntimeError, match='policy_grant_not_derived_from_admission:P1'):
        bind(admission_dir, controller, out, source)
    (out / 'policy-grants.json').unlink()
    with pytest.raises(SystemExit, match='run grant first'):
        bind(admission_dir, controller, out, source)


def test_grant_refuses_a_source_grant_from_another_admission(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    source.write_text(json.dumps({'approval_checksum': 'r' * 64}), encoding='utf-8')
    with pytest.raises(RuntimeError, match='admission_not_for_source_grant'):
        bind(admission_dir, controller, out, source, 'grant')
    (admission_dir / 'source-grant.json').unlink()
    with pytest.raises(RuntimeError, match='admission_source_grant_not_bound_to_receipt'):
        bind(admission_dir, controller, out, source, 'grant')


def test_a_wrong_admission_stops_before_any_credential_or_cloud_read(tmp_path, monkeypatch):
    admission_dir, controller, out, source = release(tmp_path, new_key='ml:active8:paper_runtime_approval:v1:r31',
                                                     admitted_key='ml:active8:paper_runtime_approval:v1:wrel')
    bundle = b'bundle'
    (admission_dir / 'native-paper.cjs').write_bytes(bundle)
    receipt = json.loads((admission_dir / 'admission-receipt.json').read_text())
    receipt['native_bundle_sha256'] = hashlib.sha256(bundle).hexdigest()
    (admission_dir / 'admission-receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    monkeypatch.setenv('NATIVE_PAPER_RUNNER', 'unset-by-test')  # restored after the test
    monkeypatch.setitem(sys.modules, 'runtime_context', None)  # importing it (credentials) would raise ImportError
    monkeypatch.setattr(sys, 'argv', ['activate_l4_policy.py', 'activate', '--workspace-root', str(tmp_path),
                                      '--out', str(out), '--controller', str(controller), '--admission-dir', str(admission_dir),
                                      '--to', '1'])
    with pytest.raises(RuntimeError, match='admission_not_for_this_release'):
        activate.main()


def test_grant_refuses_another_release_admission_with_its_own_s_grant(tmp_path):
    # r31's admission dir and its own source-grant.json: the S grant matches the receipt,
    # but the controller is the W-REL release
    admission_dir, controller, out, _ = release(tmp_path, new_key='ml:active8:paper_runtime_approval:v1:r31',
                                                admitted_key='ml:active8:paper_runtime_approval:v1:wrel')
    with pytest.raises(RuntimeError, match='admission_not_for_this_release'):
        bind(admission_dir, controller, out, admission_dir / 'source-grant.json', 'grant')


def test_both_release_manifests_and_the_policy_chain_are_bound(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    (controller / 'services/strategy_nav_source_release.json').write_text('{"source": "r31"}', encoding='utf-8')
    with pytest.raises(RuntimeError, match='admission_not_for_this_release'):
        bind(admission_dir, controller, out, source, 'grant')
    (tmp_path / 'b').mkdir()
    admission_dir, controller, out, source = release(tmp_path / 'b')
    (out / 'policy-chain.json').write_text('[{"packet": 2}]', encoding='utf-8')
    for command in ('grant', 'activate'):
        with pytest.raises(RuntimeError, match='admission_not_for_this_policy_chain'):
            bind(admission_dir, controller, out, source, command)


def test_p_grant_may_differ_only_in_the_two_kv_configs(tmp_path):
    admission_dir, controller, out, source = release(tmp_path)
    grants = json.loads((out / 'policy-grants.json').read_text())
    grants[0]['configuration']['native_execution_policy'] = 'r31'
    (out / 'policy-grants.json').write_text(json.dumps(grants), encoding='utf-8')
    with pytest.raises(RuntimeError, match='policy_grant_not_derived_from_admission:P1'):
        bind(admission_dir, controller, out, source)
