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
