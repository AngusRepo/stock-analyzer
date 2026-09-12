"""Original Worker/Python prior projection parity; no trading or fake approval."""
import json
import os
from pathlib import Path
import subprocess

import pytest

from services.alpha_framework import normalize_alpha_policy

CASES = [
    {}, {'opbArmPrior': None}, {'opb_arm_prior': {'artifact_id': 'legacy'}},
    {'opbArmPrior': {'artifact_id': 'canonical'}, 'opb_arm_prior': {'artifact_id': 'legacy'}},
    {'opbArmPrior': None, 'opb_arm_prior': {'artifact_id': 'legacy'}},
    {'opbArmPrior': {}, 'opb_arm_prior': {'artifact_id': 'legacy'}},
    {'opbArmPrior': [], 'opb_arm_prior': {'artifact_id': 'legacy'}},
    {'opbArmPrior': 'invalid'}, {'opbArmPrior': False}, {'opb_arm_prior': 0},
]


@pytest.fixture(scope='module')
def worker_results():
    source = """
const esbuild = require('esbuild');
const code = `import { mergeAlphaFrameworkConfig } from './src/lib/tradingConfig';
const results = JSON.parse(process.env.NAV_OPB_CONFIG_CASES).map(allocation => {
  try { return { prior: mergeAlphaFrameworkConfig({allocation}).allocation.opbArmPrior ?? null }; }
  catch (e) { return { error: e.message }; }
});
console.log(JSON.stringify(results));`;
const built = esbuild.buildSync({stdin:{contents:code,resolveDir:process.cwd(),loader:'ts'},
  bundle:true,platform:'node',format:'cjs',write:false});
eval(built.outputFiles[0].text);
"""
    checked = subprocess.run(['node', '-e', source],
        cwd=Path(__file__).parents[2] / 'worker',
        env={**os.environ, 'NAV_OPB_CONFIG_CASES': json.dumps(CASES)},
        capture_output=True, encoding='utf-8', check=True, timeout=30)
    return json.loads(checked.stdout)


@pytest.mark.parametrize('index', range(len(CASES)))
def test_python_consumes_the_same_prior_as_the_original_worker(index, worker_results):
    expected = worker_results[index]
    if 'error' in expected:
        with pytest.raises(ValueError, match=expected['error']):
            normalize_alpha_policy({'allocation': CASES[index]})
    else:
        assert normalize_alpha_policy({'allocation': CASES[index]})['allocation']['opb_arm_prior'] == expected['prior']
