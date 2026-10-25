"""Mutual exclusion between the two production deploy workflows, without a shared concurrency group.

A shared `concurrency: production` group lets a newly queued run of one workflow silently cancel
the pending run of the other, so each workflow has its own group and they take turns here
instead. Each role holds production over a critical section:
  controller  deploy-controller.yml, job `controller`, the step whose name starts with "Rollout"
  cloudflare  deploy-cloudflare.yml, job `cloudflare`, the whole job
`wait --role R` blocks while the other role's critical section that started earlier than this
run's own is in progress: a strict order by (start time, run id), so two runs never wait for
each other. Fails closed (exit 1) when the limit passes or the GitHub API cannot be read.
Stdlib only; needs GH_TOKEN with actions: read, GITHUB_REPOSITORY and GITHUB_RUN_ID.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

API = 'https://api.github.com'
ROLES = {
    'controller': ('deploy-controller.yml', 'controller', 'Rollout'),
    'cloudflare': ('deploy-cloudflare.yml', 'cloudflare', None),
}


def get(path: str) -> dict:
    request = urllib.request.Request(API + path, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stockvision-production-turn'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def section_start(jobs: list[dict], role: str) -> str | None:
    """started_at of the role's critical section if it is in progress in this run, else None."""
    _, job_name, step_prefix = ROLES[role]
    for job in jobs:
        if job.get('name') != job_name or job.get('status') != 'in_progress':
            continue
        if step_prefix is None:
            return job.get('started_at')
        for step in job.get('steps') or []:
            if step.get('name', '').startswith(step_prefix) and step.get('status') == 'in_progress':
                return step.get('started_at')
    return None


def holders(repo: str, role: str, fetch=get) -> list[tuple[str, int]]:
    """(started_at, run id) of every in-progress critical section of `role`."""
    workflow = ROLES[role][0]
    runs = fetch(f'/repos/{repo}/actions/workflows/{workflow}/runs?status=in_progress&per_page=50')['workflow_runs']
    found = []
    for run in runs:
        start = section_start(fetch(f'/repos/{repo}/actions/runs/{run["id"]}/jobs?per_page=100')['jobs'], role)
        if start:
            found.append((start, int(run['id'])))
    return found


def blockers(repo: str, role: str, run_id: int, fetch=get) -> list[tuple[str, int]]:
    mine = section_start(fetch(f'/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100')['jobs'], role)
    if not mine:
        raise RuntimeError(f'own_{role}_section_not_in_progress')
    other = 'cloudflare' if role == 'controller' else 'controller'
    return sorted(h for h in holders(repo, other, fetch) if (h[0], h[1]) < (mine, run_id))


def wait(role: str, limit_minutes: float, *, fetch=get, sleep=time.sleep, clock=time.monotonic) -> None:
    repo, run_id = os.environ['GITHUB_REPOSITORY'], int(os.environ['GITHUB_RUN_ID'])
    started = clock()
    deadline = started + limit_minutes * 60
    while True:
        try:
            ahead = blockers(repo, role, run_id, fetch)
        except RuntimeError as error:
            # The jobs API can lag the step that just started; give it a few minutes, then fail.
            if not str(error).startswith('own_') or clock() - started > 180:
                raise
            sleep(10)
            continue
        if not ahead:
            return
        if clock() >= deadline:
            raise RuntimeError('production_turn_wait_limit:' + ','.join(str(run) for _, run in ahead))
        print('Waiting for the other production deploy: runs ' + ', '.join(str(run) for _, run in ahead), flush=True)
        sleep(30)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('wait')
    p.add_argument('--role', choices=sorted(ROLES), required=True)
    p.add_argument('--limit-minutes', type=float, required=True)
    args = parser.parse_args(argv)
    try:
        wait(args.role, args.limit_minutes)
    except Exception as error:
        print(f'::error::production turn not taken: {type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
    print('production turn: ' + args.role, flush=True)


if __name__ == '__main__':
    main()
