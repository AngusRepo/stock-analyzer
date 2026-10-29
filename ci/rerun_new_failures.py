"""Confirm failures that the head has and the base does not.

  list  <artifacts-dir> <new.txt> [suite]   write head-only failure ids of suite (default controller)
  rerun <new.txt> <flaky.txt>               (cwd ml-controller) rerun them twice, serially;
                                            ids that pass at least once go to flaky.txt
  rerun-worker <new.txt> <flaky.txt>        (cwd worker) the same for Worker node:test ids (CI-NEW-35)

The gate reports flaky ids but does not block on them; ids that fail both reruns stay new.
"""
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

PREFIX = 'controller: '
WORKER_PREFIX = 'worker: '
RERUNS = 2
TOOLS = Path(__file__).resolve().parent


def read_ids(path):
    path = Path(path)
    return {l.strip() for l in path.read_text(encoding='utf-8').splitlines() if l.strip()} if path.exists() else set()


def node_id(failure_id):
    """'controller: tests.test_x.TestC::name[p]' -> 'tests/test_x.py::TestC::name[p]' (None if unmapped)."""
    classname, _, name = failure_id[len(PREFIX):].partition('::')
    parts = classname.split('.')
    for i in range(len(parts), 0, -1):
        path = '/'.join(parts[:i]) + '.py'
        if Path(path).is_file():
            return '::'.join([path, *parts[i:], name])
    return None


def worker_file(failure_id):
    """'worker: src/lib/x.test.ts :: a > b' -> 'src/lib/x.test.ts' (None if the file is not there)."""
    path = failure_id[len(WORKER_PREFIX):].partition(' :: ')[0]
    return path if path.endswith('.test.ts') and Path(path).is_file() else None


def passed_ids(junit):
    """Failure ids (same format as junit_failures.py) of testcases that passed."""
    ok = set()
    for case in ET.parse(junit).getroot().iter('testcase'):
        if not any(case.find(tag) is not None for tag in ('failure', 'error', 'skipped')):
            ok.add(f"{PREFIX}{case.get('classname', '')}::{case.get('name', '')}")
    return ok


def worker_passes(files, out):
    """Run whole files (node:test cannot select one test by id) and return the ids that passed."""
    out.unlink(missing_ok=True)
    subprocess.run(['node', '--import', 'tsx', '--test', '--test-concurrency=1',
                    '--test-reporter=dot', '--test-reporter-destination=stdout',
                    f'--test-reporter={TOOLS / "node_passes_reporter.mjs"}', f'--test-reporter-destination={out}',
                    *files], check=False)
    return read_ids(out)


def rerun_worker(new, run_files=worker_passes):
    """Ids in new that pass in at least one of RERUNS serial reruns of their files."""
    files = {i: worker_file(i) for i in new}
    flaky = set()
    for attempt in range(RERUNS):
        runnable = sorted({f for i, f in files.items() if f and i not in flaky})
        if not runnable:
            break
        out = Path(os.environ.get('RUNNER_TEMP', '.')) / f'rerun-worker-{attempt}.txt'
        flaky |= run_files(runnable, out) & new
    return flaky, sum(1 for f in files.values() if not f)


def main():
    mode = sys.argv[1]
    if mode == 'list':
        root, suite = Path(sys.argv[2]), (sys.argv[4] if len(sys.argv) > 4 else 'controller')
        head = read_ids(root / f'failures-{suite}-head' / 'failures.txt')
        base = read_ids(root / f'failures-{suite}-base' / 'failures.txt')
        new = sorted(i for i in head - base if i.startswith(f'{suite}: '))
        Path(sys.argv[3]).write_text(''.join(i + '\n' for i in new), encoding='utf-8')
        print(f'{len(new)} head-only {suite} failures')
        return
    new, flaky_out = read_ids(sys.argv[2]), Path(sys.argv[3])
    if mode == 'rerun-worker':
        flaky, unmapped = rerun_worker(new)
        flaky_out.write_text(''.join(i + '\n' for i in sorted(flaky)), encoding='utf-8')
        print(f'{len(flaky)} of {len(new)} passed on rerun (flaky); unmapped: {unmapped}')
        return
    nodes = {i: node_id(i) for i in new}
    runnable = sorted(n for n in nodes.values() if n)
    flaky = set()
    for attempt in range(RERUNS):
        if not runnable:
            break
        junit = Path(os.environ.get('RUNNER_TEMP', '.')) / f'rerun-{attempt}.xml'
        subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--timeout=300',
                        f'--junitxml={junit}', *runnable], check=False)
        if junit.exists():
            flaky |= passed_ids(junit) & new
        runnable = sorted(n for i, n in nodes.items() if n and i not in flaky)
    flaky_out.write_text(''.join(i + '\n' for i in sorted(flaky)), encoding='utf-8')
    print(f'{len(flaky)} of {len(new)} passed on rerun (flaky); unmapped: {sum(1 for n in nodes.values() if not n)}')


if __name__ == '__main__':
    main()
