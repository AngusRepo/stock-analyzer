"""Actual original daily producer -> immutable policy -> original-kernel replay.

Private native D1 and synthetic evidence only, never investment performance.
"""
import os
from pathlib import Path
import subprocess


def test_original_strategy_weight_source_native_d1():
    env = dict(os.environ)
    env.pop('NODE_TEST_CONTEXT', None)
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
        'tests/strategyWeightReplayD1.ts'], cwd=Path(__file__).parents[2] / 'worker', env=env,
        capture_output=True, text=True, encoding='utf-8', timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '# pass 11' in result.stdout and '# fail 0' in result.stdout
