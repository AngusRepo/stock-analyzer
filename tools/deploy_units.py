"""Production deploy planning for .github/workflows/deploy-cloudflare.yml.

A unit's inputs are its build inputs inside its directory (tests and docs excluded), its deploy
script, the scheduler manifest every provenance record hashes, and each file outside the directory
its source reaches through relative imports (the Worker bundles ml-controller/schemas JSON; the
frontend imports worker/src).

Changes are diffed against what each unit runs live, not against the previous main commit, so a
cancelled, rejected or failed run leaves its changes for the next one.

  plan --choice changed|worker|pages|all     prints `<unit>=true|false` and `gate_base=<sha>`
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
LIVE = {
    'worker': ('https://stockvision-worker.angus-solo-dev.workers.dev/api/health', ('provenance', 'sourceSha')),
    'pages': ('https://stockvision-frontend.pages.dev/production-provenance.json', ('sourceSha',)),
}
UNITS = {
    'worker': ('worker', 'tools/deploy_worker_with_provenance.mjs'),
    'pages': ('frontend', 'tools/deploy_pages_with_provenance.mjs'),
}
# Worker build inputs outside src/; everything else under worker/ (migrations, scripts, notes) is not bundled.
WORKER_CONFIG = {'worker/wrangler.toml', 'worker/package.json', 'worker/package-lock.json', 'worker/tsconfig.json'}
SHARED = {'infra/gcp-scheduler-jobs.json', 'tools/worker_deploy_preflight.mjs'}
SOURCE = {'.ts', '.tsx', '.js', '.mjs'}
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
TEST = re.compile(r'(^|/)(__tests__|tests?)/|\.(test|spec)[A-Za-z]*\.[a-z]+$')
# File references the import scan cannot follow; a guard test keeps them out of unit source.
UNFOLLOWED = re.compile(r'import\.meta\.(url|glob)|\brequire\(|\?raw[\'"]')
SHA = re.compile(r'^[0-9a-f]{40}$')


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
    top = (root / unit_dir / 'src').resolve()
    return [p.resolve() for p in top.rglob('*')
            if p.is_file() and p.suffix in SOURCE and not TEST.search(p.relative_to(root.resolve()).as_posix())]


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
        return path in WORKER_CONFIG or path.startswith('worker/src/')
    return path.startswith('frontend/')


def touched_units(changed: list[str], root: Path = ROOT) -> dict[str, bool]:
    result = {}
    for unit, (unit_dir, script) in UNITS.items():
        inputs = SHARED | {script} | outside_inputs(unit_dir, root)
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


def plan(choice: str) -> dict[str, str]:
    head = git('rev-parse', 'HEAD')
    remote = git('ls-remote', 'origin', 'refs/heads/main').split()[0]
    if remote != head:  # a newer run owns main; it diffs against live, so nothing is lost
        print(f'::notice::main moved to {remote}; leaving the deploy to that run', file=sys.stderr)
        return {'worker': 'false', 'pages': 'false', 'gate_base': ''}
    out, bases = {}, []
    for unit in UNITS:
        live = live_sha(unit)
        if live == head:
            out[unit] = False
            continue
        known = bool(live) and is_ancestor(live, head)
        if choice in (unit, 'all') or not known:
            out[unit] = choice in (unit, 'all', 'changed')
        else:
            out[unit] = choice == 'changed' and touched_units(git('diff', '--name-only', live, head).splitlines())[unit]
        if out[unit]:
            bases.append(live if known else '')
    # Gate every pushed commit since the oldest live version being replaced; an unknown one gates HEAD only.
    base = '' if not bases or '' in bases else bases[0] if len(bases) == 1 else git('merge-base', *bases)
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
    sub.add_parser('plan').add_argument('--choice', choices=['changed', 'worker', 'pages', 'all'], default='changed')
    sub.add_parser('gate').add_argument('--base', default='')
    args = parser.parse_args()
    if args.action == 'plan':
        for key, value in plan(args.choice).items():
            print(f'{key}={value}')
    else:
        gate(args.base)
