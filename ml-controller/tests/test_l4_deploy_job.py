"""Execute the real deploy function with a process-local gcloud substitute."""
import os,shutil,subprocess
from pathlib import Path
import pytest

ROOT=Path(__file__).resolve().parents[2]
BASH=shutil.which('bash') if os.name!='nt' else r'C:/Program Files/Git/bin/bash.exe'

@pytest.mark.parametrize('exists,verb',[(True,'update'),(False,'create')])
def test_candidate_job_deployment_never_trains_and_uses_attested_runtime(exists,verb,tmp_path):
    source=(ROOT/'deploy_ml_controller.sh').read_text(encoding='utf-8-sig')
    start=source.index('sync_l4_distribution_job() {')
    body=source[start:source.index('\n}\n',start)+3]
    calls=tmp_path/'calls.txt'
    harness='\n'.join(['set -euo pipefail',
        'gcloud() {',
        'if [ "$3" = "describe" ]; then return '+('0' if exists else '1')+'; fi',
        'printf "%s\\n" "$*" >> "$CALLS"',
        '}',body,'sync_l4_distribution_job "sealed-env.yaml"'])
    env={**os.environ,'CALLS':calls.as_posix(),'L4_DISTRIBUTION_JOB_NAME':'l4-distribution-refresh',
        'REGION':'test-region','NEW_IMAGE':'image@sha256:abc','VERIFY_JOB_SERVICE_ACCOUNT':'dedicated@example.test',
        'PROVENANCE_LABELS':'source_sha=abc','RUN_SECRET_BINDINGS':'TOKEN=secret-reference:latest',
        'L4_DISTRIBUTION_JOB_TIMEOUT':'3600s'}
    proc=subprocess.run([BASH,'-c',harness],env=env,capture_output=True,text=True)
    assert proc.returncode==0,proc.stderr
    commands=calls.read_text().splitlines()
    assert len(commands)==1 and commands[0].startswith('run jobs '+verb+' l4-distribution-refresh ')
    assert '--image=image@sha256:abc' in commands[0]
    assert '--args=scripts.l4_distribution_refresh_job' in commands[0]
    assert '--service-account=dedicated@example.test' in commands[0]
    assert '--env-vars-file=sealed-env.yaml' in commands[0]
    assert 'execute' not in commands[0] and '--execute-now' not in commands[0]
    assert subprocess.run([BASH,'-n',str(ROOT/'deploy_ml_controller.sh')],capture_output=True).returncode==0
