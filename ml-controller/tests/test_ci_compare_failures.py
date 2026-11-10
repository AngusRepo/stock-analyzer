"""ci/compare_failures.py: the gate blocks new failures and any failure inside the P9 scope."""
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'ci' / 'compare_failures.py'
P9_SCRIPT = REPO / 'scripts' / 'p9_gate.ps1'
SUITES = ('worker', 'controller', 'frontend', 'hygiene')
P9_TEST = 'controller: tests.test_verify_pipeline_graph::test_fixture'
OTHER_TEST = 'controller: tests.test_tabpack_core16::test_fixture'


def gate(tmp_path, head=None, base=None, flaky=(), p9_script=P9_SCRIPT):
    """Run the gate over artifacts where every suite reported; head/base map suite -> ids."""
    for side, lists in (('head', head or {}), ('base', base or {})):
        for suite in SUITES:
            out = tmp_path / f'failures-{suite}-{side}'
            out.mkdir()
            (out / 'failures.txt').write_text(''.join(f'{i}\n' for i in lists.get(suite, ())), encoding='utf-8')
    if flaky:
        (tmp_path / 'flaky-controller').mkdir()
        (tmp_path / 'flaky-controller' / 'flaky.txt').write_text(''.join(f'{i}\n' for i in flaky), encoding='utf-8')
    args = [sys.executable, str(SCRIPT), str(tmp_path)] + ([str(p9_script)] if p9_script else [])
    # Without GITHUB_STEP_SUMMARY the report only goes to stdout, not into the CI run's summary.
    env = {k: v for k, v in os.environ.items() if k != 'GITHUB_STEP_SUMMARY'} | {'PYTHONUTF8': '1'}
    return subprocess.run(args, capture_output=True, text=True, encoding='utf-8', env=env)


def test_clean_head_passes(tmp_path):
    assert gate(tmp_path).returncode == 0


def test_p9_list_is_read_from_the_gate_script():
    assert 'tests\\test_verify_pipeline_graph.py' in P9_SCRIPT.read_text(encoding='utf-8')
    assert 'test_tabpack_core16' not in P9_SCRIPT.read_text(encoding='utf-8')


def test_preexisting_controller_failure_outside_p9_scope_passes(tmp_path):
    result = gate(tmp_path, head={'controller': [OTHER_TEST]}, base={'controller': [OTHER_TEST]})
    assert result.returncode == 0, result.stdout


def test_preexisting_controller_failure_in_p9_scope_blocks(tmp_path):
    result = gate(tmp_path, head={'controller': [P9_TEST]}, base={'controller': [P9_TEST]})
    assert result.returncode == 1
    assert 'failures in the P9 scope' in result.stdout and P9_TEST in result.stdout


def test_preexisting_worker_frontend_hygiene_failures_block(tmp_path):
    for suite, failure in (('worker', 'worker: src/lib/a.test.ts :: a'), ('frontend', 'frontend: vite build'),
                           ('hygiene', 'hygiene: P12 secret scan')):
        root = tmp_path / suite
        root.mkdir()
        assert gate(root, head={suite: [failure]}, base={suite: [failure]}).returncode == 1, suite


def test_preexisting_controller_ids_without_a_test_module_block(tmp_path):
    for n, failure in enumerate(('controller worker-python: src/lib/a.test.ts :: a', 'controller-3: dependency install',
                                 'controller: worker python tests produced no report')):
        root = tmp_path / str(n)
        root.mkdir()
        assert gate(root, head={'controller': [failure]}, base={'controller': [failure]}).returncode == 1, failure


def test_new_failure_outside_p9_scope_still_blocks_unless_flaky(tmp_path):
    (tmp_path / 'new').mkdir()
    (tmp_path / 'flaky').mkdir()
    assert gate(tmp_path / 'new', head={'controller': [OTHER_TEST]}).returncode == 1
    assert gate(tmp_path / 'flaky', head={'controller': [OTHER_TEST]}, flaky=[OTHER_TEST]).returncode == 0


def test_unreadable_p9_list_blocks(tmp_path):
    for name, script in (('absent', None), ('missing', tmp_path / 'none.ps1'), ('empty', tmp_path / 'empty.ps1')):
        (tmp_path / 'empty.ps1').write_text('Write-Host no tests\n', encoding='utf-8')
        root = tmp_path / name
        root.mkdir()
        result = gate(root, p9_script=script)
        assert result.returncode == 1, name
        assert 'no controller test files read' in result.stdout
