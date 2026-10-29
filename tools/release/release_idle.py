"""Idle guard before a controller/Modal rollout: no deployed component drifted from the baseline,
no Cloud Run Job execution is running, and no Modal function has queued or running inputs.

Generalized from the per-release l4_release_preflight.inspect, which hard-coded its exceptions
(the l4-three-arm-forward jobs, deleted 10/23, and a feature_selection_pipeline queue compared
against e084938e). One rule remains: a function with queued but no running inputs does not block
when the release leaves its source in ml-service/modal_app.py unchanged from the deployed Modal
tag, since the rolling deploy then serves the queue with the same code. Read-only.
"""
from __future__ import annotations

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

import httpx

from release_guard import BASE, access_token, compare, inventory

# Answering the guard's own provenance read is not work in flight.
READ_ONLY_FUNCTIONS = {'deployment_provenance'}


def modal_activity() -> dict:
    import modal
    from modal.experimental import get_app_objects

    def stats(item):
        name, fn = item
        if not isinstance(fn, modal.Function):
            raise ValueError('uninspected_modal_class:' + name)
        return name, asdict(fn.get_current_stats())
    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(pool.map(stats, get_app_objects('stockvision-ml').items()))


def running_executions(job_resources: list[str]) -> dict:
    with httpx.Client(headers={'Authorization': 'Bearer ' + access_token()}, timeout=30) as client:
        def executions(resource):
            found, params = [], {'pageSize': 100}
            for _ in range(100):
                response = client.get(BASE + '/' + resource + '/executions', params=params)
                response.raise_for_status()
                data = response.json()
                found.extend(e['name'] for e in data.get('executions', []) if not e.get('completionTime'))
                if not data.get('nextPageToken'):
                    return resource, found
                params['pageToken'] = data['nextPageToken']
            raise ValueError('incomplete_execution_inventory')
        with ThreadPoolExecutor(max_workers=4) as pool:
            return {k: v for k, v in pool.map(executions, job_resources) if v}


def function_source(raw: bytes, name: str) -> str | None:
    for node in ast.parse(raw).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.dump(node)
    return None


def unchanged_queues(busy: dict, source: Path | None, deployed_sha: str, release_sha: str | None) -> dict:
    """Queued-only functions whose modal_app.py definition is identical at the deployed and release sha."""
    queued = {k for k, v in busy.items() if v['backlog'] and not v['num_running_inputs']}
    if not queued or source is None or release_sha is None:
        return {}
    def show(sha):
        return subprocess.check_output(['git', '-C', str(source), 'show', f'{sha}:ml-service/modal_app.py'])
    deployed, release = show(deployed_sha), show(release_sha)
    return {k: busy[k] for k in sorted(queued)
            if function_source(deployed, k) is not None and function_source(deployed, k) == function_source(release, k)}


def inspect(baseline_path: Path, out: Path | None = None, source: Path | None = None, release_sha: str | None = None) -> dict:
    current = inventory()
    compare(json.loads(baseline_path.read_bytes()), current)
    activity = modal_activity()
    busy = {k: v for k, v in activity.items()
            if k not in READ_ONLY_FUNCTIONS and (v['backlog'] or v['num_running_inputs'])}
    active = running_executions([k for k in current['components'] if k.startswith('jobs/')])
    history = json.loads(subprocess.check_output([sys.executable, '-m', 'modal', 'app', 'history', 'stockvision-ml', '--json'], text=True))[0]
    preserved = unchanged_queues(busy, source, history['Tag'], release_sha)
    blocking = {k: v for k, v in busy.items() if k not in preserved}
    result = dict(observed_at=datetime.now(timezone.utc).isoformat(), baseline_unchanged=True,
                  busy_functions=blocking, preserved_unchanged_queues=preserved, active_jobs=active,
                  modal_history=history, idle=not blocking and not active)
    if out:
        out.write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--source', type=Path, help='git checkout holding both the deployed Modal tag and --release-sha')
    parser.add_argument('--release-sha')
    args = parser.parse_args()
    result = inspect(args.baseline, args.out, args.source, args.release_sha)
    print(json.dumps({k: result[k] for k in ('idle', 'busy_functions', 'preserved_unchanged_queues', 'active_jobs')}), flush=True)
    if not result['idle']:
        raise SystemExit('active_work_requires_preservation')


if __name__ == '__main__':
    main()
