"""Discover original Worker route-owner transaction regressions from pytest.

Private workerd D1 with original publisher/evaluator/readers; not investment ROI.
"""
import os
from pathlib import Path
import subprocess


def test_native_route_owner_preserves_publication_and_atomic_retry():
    environment = dict(os.environ)
    environment.pop('NODE_TEST_CONTEXT', None)
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
        'tests/routeOwnerContinuityD1.ts'], cwd=Path(__file__).parents[2] / 'worker',
        env=environment, capture_output=True, text=True, encoding='utf-8', timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '# pass 4' in result.stdout and '# fail 0' in result.stdout
