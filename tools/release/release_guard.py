"""Read-only compare-and-stop guard over the deployed controller, every Cloud Run Job and Modal.

Ported from audits/daily-chain-performance-20261015/release_guard.py: same inventory shape, so a
baseline captured by either version compares with the other. Never deploys or dispatches a Job.

After a release, --baseline takes an allow-list (CD-NEW-08/R07): --expect-release (the controller
service, Modal and the release's application jobs) and/or --expect COMPONENT, with --expect-source
SHA. An expected component may differ from the baseline only in image, source env, updateTime and
traffic, and must now run SHA; any other difference, or a change to an unlisted component, still
stops. Worker, scheduler, KV and env are outside this inventory and are verified separately.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

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


MODAL = 'modal/stockvision-ml'
# What a source-only release rewrites on a Cloud Run service or job (release_rollout.assert_source_only).
RELEASE_FIELDS = ('updateTime', 'traffic')
RELEASE_CONTAINER_FIELDS = ('image', 'source')


def release_components() -> set[str]:
    """--expect-release: what release_rollout changes, the controller, Modal and the release jobs."""
    tools = str(Path(__file__).resolve().parents[1])
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from application_job_inventory import application_jobs
    return {'services/ml-controller', MODAL} | {'jobs/' + name for name in application_jobs()}


def _without_release_fields(component: dict) -> dict:
    value = {k: v for k, v in component.items() if k not in RELEASE_FIELDS}
    value['containers'] = [{k: v for k, v in c.items() if k not in RELEASE_CONTAINER_FIELDS}
                           for c in component.get('containers', [])]
    return value


def _runs(component: dict, key: str, sha: str) -> bool:
    if key == MODAL:
        return component.get('source_sha') == sha
    containers = component.get('containers') or []
    return bool(containers) and all(c.get('source', {}).get('STOCKVISION_SOURCE_SHA') == sha for c in containers)


def compare_release(baseline: dict, observed: dict, expected: set[str], sha: str) -> dict:
    """Allow-listed post-release comparison; returns which expected components changed."""
    before, after = baseline['components'], observed['components']
    unknown = sorted(expected - before.keys())
    if unknown:
        raise RuntimeError('release_expected_component_not_in_baseline:' + ','.join(unknown))
    unexpected = sorted(k for k in before.keys() | after.keys() if k not in expected and before.get(k) != after.get(k))
    if unexpected:
        raise RuntimeError('release_baseline_drift_reinspect_before_any_mutation:' + ','.join(unexpected))
    missing = sorted(k for k in expected if k not in after)
    if missing:
        raise RuntimeError('release_expected_component_missing:' + ','.join(missing))
    beyond = sorted(k for k in expected if k != MODAL
                    and _without_release_fields(before[k]) != _without_release_fields(after[k]))
    if beyond:
        raise RuntimeError('release_changed_more_than_image_and_source:' + ','.join(beyond))
    stale = sorted(k for k in expected if not _runs(after[k], k, sha))
    if stale:
        raise RuntimeError('release_expected_component_not_on_source:' + ','.join(stale))
    return {'changed': sorted(k for k in expected if before[k] != after[k]),
            'already_on_source': sorted(k for k in expected if before[k] == after[k])}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--expect-release', action='store_true',
                        help='with --baseline: allow the controller, Modal and release jobs to move to --expect-source')
    parser.add_argument('--expect', action='append', default=[], metavar='COMPONENT',
                        help='with --baseline: one more allowed component, e.g. jobs/<name> (repeatable)')
    parser.add_argument('--expect-source', metavar='SHA', help='the release commit expected components must run')
    args = parser.parse_args()
    if bool(args.capture) == bool(args.baseline):
        parser.error('choose either --capture (new file) or --baseline (verify only)')
    expected = (release_components() if args.expect_release else set()) | set(args.expect)
    if (expected or args.expect_source) and not args.baseline:
        parser.error('--expect-release/--expect/--expect-source only apply to --baseline')
    if bool(expected) != bool(args.expect_source):
        parser.error('--expect-release/--expect and --expect-source go together')
    if args.expect_source and (len(args.expect_source) != 40 or any(c not in '0123456789abcdef' for c in args.expect_source)):
        parser.error('--expect-source needs a 40-hex commit')
    observed = inventory()
    if args.capture:
        with args.capture.open('x', encoding='utf-8') as output:
            json.dump(observed, output, ensure_ascii=False, indent=2)
        print('Read-only release baseline captured; no deployment or Job dispatch')
    elif expected:
        result = compare_release(json.loads(args.baseline.read_text(encoding='utf-8')), observed, expected, args.expect_source)
        print(json.dumps(result))
        print('Only allow-listed components changed, all on ' + args.expect_source + '; no deployment or Job dispatch')
    else:
        compare(json.loads(args.baseline.read_text(encoding='utf-8')), observed)
        print('Runtime baseline unchanged; no deployment or Job dispatch')


if __name__ == '__main__':
    main()
