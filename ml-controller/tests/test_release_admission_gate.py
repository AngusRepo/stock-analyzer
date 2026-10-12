"""Execute the real release gate with local command doubles; no cloud writes."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.mark.parametrize('legacy_flag', ['0', '1'])
@pytest.mark.parametrize('admission_exit', [0, 23])
def test_candidate_admission_precedes_traffic_even_with_legacy_opt_out(tmp_path, legacy_flag, admission_exit):
    root = Path(__file__).resolve().parents[2]
    source = (root / 'deploy_ml_controller.sh').read_text(encoding='utf8')
    block = source[source.index('RELEASE_URL=$('):source.index('echo "✅ Service deploy succeeded"')]
    tool = tmp_path / 'tools' / 'verify_cloud_run_release.py'
    tool.parent.mkdir()
    tool.write_text(
        "import os,sys\n"
        "with open(os.environ['CALL_LOG'],'a') as f:f.write(sys.argv[1]+'\\n')\n"
        "if sys.argv[1]=='tag-url':print('https://candidate.invalid')\n"
        "if sys.argv[1]=='paper':sys.exit(int(os.environ['ADMISSION_EXIT']))\n",
        encoding='utf8',
    )
    log = tmp_path / 'calls.txt'
    bash = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash')
    assert bash, 'bash required to verify deployment gate'
    script = 'set -euo pipefail\ngcloud() { echo traffic-switch >> "$CALL_LOG"; }\n' + block
    env = dict(os.environ, PYTHON_BIN=Path(sys.executable).as_posix(), SCRIPT_DIR=tmp_path.as_posix(),
               CALL_LOG=log.as_posix(), ADMISSION_EXIT=str(admission_exit),
               VERIFY_PAPER_RUNTIME_ADMISSION=legacy_flag)
    for name in ('SERVICE', 'REGION', 'RELEASE_REVISION', 'RELEASE_TAG', 'SOURCE_SHA',
                 'SOURCE_TREE_SHA', 'SOURCE_BRANCH', 'SCHEDULER_MANIFEST_SHA256',
                 'ML_CONTROLLER_SECRET_SECRET', 'ML_CONTROLLER_PUBLIC_URL'):
        env[name] = 'fixture'
    result = subprocess.run([bash, '-c', script], env=env, capture_output=True, text=True, timeout=30)
    calls = log.read_text().splitlines()
    assert result.returncode == admission_exit, result.stderr
    assert calls == (['tag-url', 'health', 'paper'] if admission_exit else
                     ['tag-url', 'health', 'paper', 'traffic-switch', 'traffic', 'health'])
