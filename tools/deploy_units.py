"""Production deploy planning for .github/workflows/deploy-cloudflare.yml.

A unit's inputs are its build inputs inside its directory (tests and docs excluded), its deploy
script, the scheduler manifest every provenance record hashes, and each file outside the directory
its source reaches through relative imports (the Worker bundles ml-controller/schemas JSON; the
frontend imports worker/src).

Changes are diffed against what each unit runs live, not against the previous main commit, so a
cancelled, rejected or failed run leaves its changes for the next one.

  plan --choice changed|worker|pages|monitoring|all
                                              prints `<unit>=true|false` and `gate_base=<sha>`
                                              (monitoring=true marks a candidate, see below)
  monitoring --choice <choice> --live <sha|''>
                                              prints `deploy=true|false` and `gate_base=<sha>`
  gate --base <sha|''>                        requires a passing push-event ci gate on every
                                              pushed main commit in (base, HEAD]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Public provenance per unit. The monitoring Worker has none (every route is behind Cloudflare Access) and
# its live tag is readable only with the Cloudflare token, which only the approved cloudflare job holds: the
# plan marks it a candidate (monitoring_planned) and that job decides from live (monitoring_decision).
LIVE = {
    'worker': ('https://stockvision-worker.angus-solo-dev.workers.dev/api/health', ('provenance', 'sourceSha')),
    'pages': ('https://stockvision-frontend.pages.dev/production-provenance.json', ('sourceSha',)),
}
MONITORING_DIR = 'worker/src/monitoring'
UNITS = {
    'worker': ('worker', 'tools/deploy_worker_with_provenance.mjs'),
    'pages': ('frontend', 'tools/deploy_pages_with_provenance.mjs'),
    'monitoring': (MONITORING_DIR, 'tools/deploy_monitoring_worker_with_provenance.mjs'),
}
# Worker build inputs outside src/; everything else under worker/ (migrations, scripts, notes) is not bundled.
WORKER_CONFIG = {'worker/wrangler.toml', 'worker/package.json', 'worker/package-lock.json', 'worker/tsconfig.json'}
MONITORING_CONFIG = {'worker/wrangler.monitoring.toml', 'worker/package.json', 'worker/package-lock.json', 'worker/tsconfig.json'}
SHARED = {'infra/gcp-scheduler-jobs.json', 'tools/worker_deploy_preflight.mjs'}
UNIT_SHARED = {'worker': SHARED, 'pages': SHARED, 'monitoring': set()}
SOURCE = {'.ts', '.tsx', '.js', '.mjs'}
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
TEST = re.compile(r'(^|/)(__tests__|tests?)/|\.(test|spec)[A-Za-z]*\.[a-z]+$')
# File references the import scan cannot follow; a guard test keeps them out of unit source.
UNFOLLOWED = re.compile(r'import\.meta\.(url|glob)|\brequire\(|\?raw[\'"]')
SHA = re.compile(r'^[0-9a-f]{40}$')
# The cloudflare job step whose success means the monitoring Worker matched that run's commit (deployed
# and verified, already live, or live with no monitoring input changed since). A contract test pins it.
WORKFLOW, MONITORING_SYNC_JOB, MONITORING_SYNC_STEP = 'deploy-cloudflare.yml', 'cloudflare', 'Verify monitoring Worker'
SYNC_SCAN_RUNS = 50


def resolve(importer: Path, specifier: str, root: Path):
    target = importer.parent / specifier
    candidates = [Path(f'{target}{suffix}') for suffix in ('', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx')]
    if specifier.endswith('.js'):
        candidates.insert(0, target.with_suffix('.ts'))
    for path in candidates:
        if path.is_file():
            path = path.resolve()
            return path if path.is_relative_to(root) else None
    return None


def entries(unit_dir: str, root: Path) -> list[Path]:
    """Non-test source of a unit: <dir>/src, or the directory itself when it is a source directory
    (the monitoring Worker). The main Worker's src excludes the monitoring Worker's own directory."""
    top = (root / unit_dir / 'src') if (root / unit_dir / 'src').is_dir() else (root / unit_dir)
    found = []
    for p in top.resolve().rglob('*'):
        rel = p.relative_to(root.resolve()).as_posix()
        if p.is_file() and p.suffix in SOURCE and not TEST.search(rel) and not (unit_dir == 'worker' and rel.startswith(f'{MONITORING_DIR}/')):
            found.append(p.resolve())
    return found


def outside_inputs(unit_dir: str, root: Path = ROOT) -> set[str]:
    """Repo paths outside unit_dir that the unit's non-test source reaches."""
    pending = entries(unit_dir, root)
    seen, outside = set(pending), set()
    while pending:
        importer = pending.pop()
        for specifier in SPECIFIER.findall(importer.read_text(encoding='utf-8', errors='replace')):
            found = resolve(importer, specifier, root.resolve())
            if found is None or found in seen:
                continue
            seen.add(found)
            rel = found.relative_to(root.resolve()).as_posix()
            if not rel.startswith(f'{unit_dir}/'):
                outside.add(rel)
            if found.suffix in SOURCE:
                pending.append(found)
    return outside


def in_unit(unit: str, path: str) -> bool:
    if TEST.search(path) or path.endswith('.md'):
        return False
    if unit == 'worker':
        return path in WORKER_CONFIG or (path.startswith('worker/src/') and not path.startswith(f'{MONITORING_DIR}/'))
    if unit == 'monitoring':
        return path in MONITORING_CONFIG or path.startswith(f'{MONITORING_DIR}/')
    return path.startswith('frontend/')


def touched_units(changed: list[str], root: Path = ROOT) -> dict[str, bool]:
    result = {}
    for unit, (unit_dir, script) in UNITS.items():
        inputs = UNIT_SHARED[unit] | {script} | outside_inputs(unit_dir, root)
        result[unit] = any(path in inputs or in_unit(unit, path) for path in changed)
    return result


def git(*args: str) -> str:
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()


def is_ancestor(old: str, new: str) -> bool:
    """False also when old is not in this clone (e.g. a live version built from an unmerged branch)."""
    return subprocess.run(['git', 'merge-base', '--is-ancestor', old, new], cwd=ROOT,
                          capture_output=True).returncode == 0


def live_sha(unit: str) -> str:
    url, path = LIVE[unit]
    try:
        request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'stockvision-deploy-plan'})
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.load(response)
        for key in path:
            value = value[key]
    except Exception as error:  # an unreadable live version means "deploy it", never "skip"
        print(f'::warning::{unit} live version unreadable ({error}); deploying it', file=sys.stderr)
        return ''
    return value if isinstance(value, str) and SHA.match(value) else ''


def monitoring_synced_sha() -> str:
    """Newest main commit a deploy-cloudflare run confirmed the monitoring Worker at; '' when none of the
    last runs did. A run that deployed nothing (main moved, rejected, cancelled, failed) confirms nothing,
    so its changes stay in the next plan's range."""
    repo = os.environ['GITHUB_REPOSITORY']
    runs = gh(f'repos/{repo}/actions/workflows/{WORKFLOW}/runs?branch=main&status=completed&per_page={SYNC_SCAN_RUNS}')['workflow_runs']
    for run in sorted(runs, key=lambda r: r['run_number'], reverse=True):
        jobs = gh(f'repos/{repo}/actions/runs/{run["id"]}/jobs?filter=latest&per_page=100')['jobs']
        steps = next((j.get('steps') or [] for j in jobs if j['name'] == MONITORING_SYNC_JOB), [])
        if any(s['name'] == MONITORING_SYNC_STEP and s['conclusion'] == 'success' for s in steps):
            return run['head_sha']
    return ''


def monitoring_planned(choice: str, head: str, deploying: bool) -> bool:
    """Whether the cloudflare job should read the monitoring Worker's live tag and decide (a candidate).
    Tokenless, so it never needs an approval of its own: forced by units=monitoring|all; free when the job
    runs anyway (Worker or Pages); otherwise only when main changed a monitoring input since the last commit
    a run confirmed it at, or no recent run confirmed one (one approval, which records it)."""
    if choice in ('monitoring', 'all'):
        return True
    if choice != 'changed':
        return False
    if deploying:
        return True
    synced = monitoring_synced_sha()
    if synced == head:
        return False
    if not synced or not is_ancestor(synced, head):
        print(f'::notice::no recent run confirmed the monitoring Worker in main history ({synced or "none"}); '
              'the cloudflare job reads its live version', file=sys.stderr)
        return True
    return touched_units(git('diff', '--name-only', synced, head).splitlines())['monitoring']


def monitoring_decision(choice: str, live: str) -> dict[str, str]:
    """The cloudflare job's call, from the live tag the Cloudflare API reports: deploy when live..HEAD
    changes a monitoring input (or units=monitoring|all), skip when it does not or HEAD is live. An
    unreadable tag means "deploy it" (gated from HEAD only); a tag main never merged fails closed."""
    head = git('rev-parse', 'HEAD')
    if live == head:
        print(f'::notice::monitoring Worker already live at {live}', file=sys.stderr)
        return {'deploy': 'false', 'gate_base': ''}
    if not live:
        print('::warning::monitoring Worker live version unreadable; deploying it', file=sys.stderr)
        return {'deploy': 'true', 'gate_base': ''}
    if not SHA.match(live) or not is_ancestor(live, head):
        raise SystemExit(f'::error::monitoring live version {live} is not in main history; merge it into main before deploying')
    if choice == 'changed' and not touched_units(git('diff', '--name-only', live, head).splitlines())['monitoring']:
        print(f'::notice::monitoring Worker live at {live}; nothing in {live[:12]}..{head[:12]} changes it, not deploying', file=sys.stderr)
        return {'deploy': 'false', 'gate_base': ''}
    return {'deploy': 'true', 'gate_base': live}


def plan(choice: str) -> dict[str, str]:
    head = git('rev-parse', 'HEAD')
    remote = git('ls-remote', 'origin', 'refs/heads/main').split()[0]
    if remote != head:  # a newer run owns main; it diffs against live, so nothing is lost
        print(f'::notice::main moved to {remote}; leaving the deploy to that run', file=sys.stderr)
        return {'worker': 'false', 'pages': 'false', 'monitoring': 'false', 'gate_base': ''}
    out, bases = {}, []
    for unit in LIVE:
        live = live_sha(unit)
        if live == head:
            out[unit] = False
            continue
        known = bool(live) and is_ancestor(live, head)
        if live and not known and choice in (unit, 'all', 'changed'):  # would replace a version main never merged
            raise SystemExit(f'::error::{unit} live version {live} is not in main history; merge it into main before deploying')
        if choice in (unit, 'all') or not known:
            out[unit] = choice in (unit, 'all', 'changed')
        else:
            out[unit] = choice == 'changed' and touched_units(git('diff', '--name-only', live, head).splitlines())[unit]
        if out[unit]:
            bases.append(live if known else '')
    # Gate every pushed commit since the oldest live version being replaced; an unreadable one gates HEAD only.
    base = '' if not bases or '' in bases else bases[0] if len(bases) == 1 else git('merge-base', *bases)
    out['monitoring'] = monitoring_planned(choice, head, out['worker'] or out['pages'])
    return {**{u: str(v).lower() for u, v in out.items()}, 'gate_base': base}


def gh(path: str):
    for attempt in range(4):
        result = subprocess.run(['gh', 'api', path], capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        time.sleep(15 * (attempt + 1))
    raise SystemExit(f'gh api {path} failed: {result.stderr.strip()[-300:]}')


def gate_state(repo: str, sha: str) -> str:
    """'none' (no push-event ci run), 'pending', or the gate job's conclusion."""
    runs = gh(f'repos/{repo}/actions/workflows/ci.yml/runs?head_sha={sha}&event=push&per_page=20')['workflow_runs']
    if not runs:
        return 'none'
    run = max(runs, key=lambda r: (r['run_number'], r['run_attempt']))
    jobs = gh(f'repos/{repo}/actions/runs/{run["id"]}/jobs?filter=latest&per_page=100')['jobs']
    gate = next((j for j in jobs if j['name'] == 'gate'), None)
    if gate is None or gate['status'] != 'completed':
        return 'pending' if run['status'] != 'completed' else 'missing'
    return gate['conclusion'] or 'missing'


def gate(base: str, deadline_s: int = 140 * 60, missing_s: int = 15 * 60) -> None:
    repo, head = os.environ['GITHUB_REPOSITORY'], git('rev-parse', 'HEAD')
    # Only push-event runs count: a dispatched ci run compares a commit with itself and always passes.
    # A pushed range is gated as a whole by its tip, so commits that were never a push tip have no run.
    commits = git('rev-list', '--first-parent', f'{base}..{head}').splitlines() if base else [head]
    started = time.monotonic()
    for sha in commits:
        while True:
            state = gate_state(repo, sha)
            if state == 'success' or (state == 'none' and sha != head):
                break
            if state not in ('pending', 'none') or (state == 'none' and time.monotonic() - started > missing_s):
                raise SystemExit(f'ci gate for {sha}: {state}')
            if time.monotonic() - started > deadline_s:
                raise SystemExit(f'ci gate for {sha} still {state} after {deadline_s // 60} min')
            time.sleep(60)
        print(f'ci gate ok: {sha}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    plan_args = sub.add_parser('plan')
    plan_args.add_argument('--choice', choices=['changed', 'worker', 'pages', 'monitoring', 'all'], default='changed')
    monitoring_args = sub.add_parser('monitoring')
    monitoring_args.add_argument('--choice', choices=['changed', 'monitoring', 'all'], default='changed')
    monitoring_args.add_argument('--live', default='', help="the monitoring Worker's live source SHA ('' if unreadable)")
    sub.add_parser('gate').add_argument('--base', default='')
    args = parser.parse_args()
    if args.action in ('plan', 'monitoring'):
        result = plan(args.choice) if args.action == 'plan' else monitoring_decision(args.choice, args.live)
        for key, value in result.items():
            print(f'{key}={value}')
    else:
        gate(args.base)
