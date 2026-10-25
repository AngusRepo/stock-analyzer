"""Authenticated operational reads for release tooling; credentials stay in process memory.

Two credential sources:
- local (an operator's gcloud login): secrets come from the ml-controller service env, as the
  audits/pipeline-nightly-20261013 original did.
- CD (GITHUB_ACTIONS=true, deploy SA via WIF): only the named secrets the deploy SA may read
  (see output/herdr-handoff-20261018/cicd-phase-e-20261024/e1_wif_setup.ps1). The controller's
  own Cloudflare token is never read; Cloudflare calls use the deploy-scoped token.
Plain (non-secret) values always come from the live ml-controller service env.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

PROJECT = 'gen-lang-client-0602998820'
REGION = 'asia-east1'
SERVICE = 'ml-controller'
# shutil.which applies PATHEXT on Windows, so this finds gcloud.cmd there and gcloud on Linux.
GC = shutil.which('gcloud')
CD_SECRETS = {
    'CF_API_TOKEN': 'stockvision-cd-cf-deploy-token',
    'ML_CONTROLLER_SECRET': 'stockvision-ml-controller-secret',
    'STOCKVISION_AUTH_TOKEN': 'stockvision-stockvision-auth-token',
}
PLAIN = {'CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'STOCKVISION_WORKER_URL', 'GCS_BUCKET_NAME'}
LOCAL_SECRETS = {'CF_API_TOKEN', 'STOCKVISION_AUTH_TOKEN', 'ML_CONTROLLER_SECRET'}


def in_cd() -> bool:
    return os.environ.get('GITHUB_ACTIONS') == 'true'


def gc(*args: str) -> bytes:
    if not GC:
        raise RuntimeError('gcloud_not_found')
    # gcloud's own Python must not be whatever venv runs this tool.
    env = {**os.environ, 'CLOUDSDK_PYTHON': os.environ.get('CLOUDSDK_PYTHON', sys.executable)}
    return subprocess.check_output([GC, *args, '--project=' + PROJECT], timeout=60, env=env)


def secret(name: str) -> str:
    return gc('secrets', 'versions', 'access', 'latest', '--secret=' + name).decode().strip()


def load_environment() -> dict:
    """Export credentials and plain config into os.environ; return the live controller identity."""
    service = json.loads(gc('run', 'services', 'describe', SERVICE, '--region=' + REGION, '--format=json'))
    values = {r['name']: r for r in service['spec']['template']['spec']['containers'][0]['env']}
    plain = PLAIN | {n for n in values if n.startswith(('CF_D1_', 'MULTI_D1_'))}
    for name in plain:
        item = values.get(name)
        if item and 'value' in item:
            os.environ[name] = item['value']
    if in_cd():
        for name, secret_name in CD_SECRETS.items():
            os.environ[name] = secret(secret_name)
    else:
        for name in LOCAL_SECRETS | plain:
            item = values.get(name)
            if item and 'valueFrom' in item:
                ref = item['valueFrom']['secretKeyRef']
                os.environ[name] = gc('secrets', 'versions', 'access', ref['key'], '--secret=' + ref['name']).decode().strip()
    return {'source_sha': values['STOCKVISION_SOURCE_SHA']['value'],
            'source_tree': values['STOCKVISION_SOURCE_TREE_SHA']['value'],
            'latest_ready_revision': service['status']['latestReadyRevisionName'],
            'traffic': [r for r in service['status']['traffic'] if r.get('percent', 0)], 'url': service['status']['url']}


def request(url: str, *, method: str = 'GET', body=None, headers=None, timeout: float = 120) -> dict:
    import httpx
    response = httpx.request(method, url, json=body, headers=headers or {}, timeout=timeout, follow_redirects=False)
    try:
        value = json.loads(response.content)
    except ValueError:
        value = response.content.decode(errors='replace')
    return {'http_status': response.status_code, 'body': value}


def worker(path: str, *, method: str = 'GET', body=None) -> dict:
    return request(os.environ['STOCKVISION_WORKER_URL'].rstrip('/') + path, method=method, body=body,
                   headers={'Authorization': 'Bearer ' + os.environ['STOCKVISION_AUTH_TOKEN']})


def kv_get(key: str) -> dict:
    from urllib.parse import quote
    base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CF_ACCOUNT_ID']
    return request(base + '/storage/kv/namespaces/' + os.environ['CF_KV_NAMESPACE_ID'] + '/values/' + quote(key, safe=''),
                   headers={'Authorization': 'Bearer ' + os.environ['CF_API_TOKEN']})
