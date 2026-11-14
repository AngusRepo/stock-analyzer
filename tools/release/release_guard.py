"""Read-only compare-and-stop guard over the deployed controller, every Cloud Run Job and Modal.

Ported from audits/daily-chain-performance-20261015/release_guard.py: same inventory shape, so a
baseline captured by either version compares with the other. Never deploys or dispatches a Job.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path

import httpx

from runtime_context import PROJECT, REGION, gc

BASE = f'https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}'


def access_token() -> str:
    return gc('auth', 'print-access-token').decode().strip()


def inventory() -> dict:
    with httpx.Client(headers={'Authorization': 'Bearer ' + access_token()}, timeout=30) as client:
        def read(resource):
            response = client.get(BASE + '/' + resource)
            response.raise_for_status()
            item = response.json()
            template = item['template']
            if resource.startswith('jobs/'):
                template = template['template']
            containers = []
            for container in template['containers']:
                containers.append({'image': container['image'], 'resources': container.get('resources'),
                    'command': container.get('command'), 'args': container.get('args'),
                    'source': {e['name']: e['value'] for e in container.get('env', [])
                        if e['name'] in ('STOCKVISION_SOURCE_SHA', 'STOCKVISION_SOURCE_TREE_SHA') and 'value' in e}})
            return resource, {'updateTime': item.get('updateTime'), 'containers': containers,
                              'traffic': item.get('traffic'), 'timeout': template.get('timeout')}
        response = client.get(BASE + '/jobs', params={'pageSize': 1000})
        response.raise_for_status()
        jobs = response.json()
        if jobs.get('nextPageToken'):
            raise RuntimeError('release_inventory_pagination_incomplete')
        resources = ['services/ml-controller'] + ['jobs/' + j['name'].rsplit('/', 1)[-1] for j in jobs.get('jobs', [])]
        with ThreadPoolExecutor(max_workers=4) as pool:
            components = dict(pool.map(read, resources))
    import modal
    components['modal/stockvision-ml'] = modal.Function.from_name('stockvision-ml', 'deployment_provenance').remote()
    return {'observed_at': datetime.now(timezone.utc).isoformat(), 'components': components}


def compare(baseline: dict, observed: dict) -> None:
    before, after = baseline['components'], observed['components']
    changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    if changed:
        raise RuntimeError('release_baseline_drift_reinspect_before_any_mutation:' + ','.join(changed))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', type=Path)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    if bool(args.capture) == bool(args.baseline):
        parser.error('choose either --capture (new file) or --baseline (verify only)')
    observed = inventory()
    if args.capture:
        with args.capture.open('x', encoding='utf-8') as output:
            json.dump(observed, output, ensure_ascii=False, indent=2)
        print('Read-only release baseline captured; no deployment or Job dispatch')
    else:
        compare(json.loads(args.baseline.read_text(encoding='utf-8')), observed)
        print('Runtime baseline unchanged; no deployment or Job dispatch')


if __name__ == '__main__':
    main()
