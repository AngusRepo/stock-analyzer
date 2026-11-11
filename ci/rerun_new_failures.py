"""Confirm controller failures that the head has and the base does not.

  list  <artifacts-dir> <new.txt>     write head-only controller failure ids
  rerun <new.txt> <flaky.txt>         (cwd ml-controller) rerun them twice, serially;
                                      ids that pass at least once go to flaky.txt
  base  <new.txt> <flaky.txt> <stale.txt>
                                      (cwd the base checkout's ml-controller) run the files of
                                      the ids that are still new twice on the base; ids that
                                      fail both times go to stale.txt

The gate reports flaky ids but does not block on them; ids that fail both reruns stay new.
The base list may be a cached one saved by an earlier run of that commit, so a test that
depends on the date or the clock can fail on the base after its list was saved. The gate
reports ids that fail on the base run as pre-existing (stale base list) instead of new.
"""
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

PREFIX = 'controller: '
RERUNS = 2


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


def passed_ids(junit):
    """Failure ids (same format as junit_failures.py) of testcases that passed."""
    ok = set()
    for case in ET.parse(junit).getroot().iter('testcase'):
        if not any(case.find(tag) is not None for tag in ('failure', 'error', 'skipped')):
            ok.add(f"{PREFIX}{case.get('classname', '')}::{case.get('name', '')}")
    return ok


def failed_ids(junit):
    """Failure ids of testcases that failed or errored; ids missing from the run are not failures."""
    bad = set()
    for case in ET.parse(junit).getroot().iter('testcase'):
        if any(case.find(tag) is not None for tag in ('failure', 'error')):
            bad.add(f"{PREFIX}{case.get('classname', '')}::{case.get('name', '')}")
    return bad


def run_pytest(nodes, junit):
    subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--timeout=300',
                    f'--junitxml={junit}', *nodes], check=False)
    return junit.exists()


def main():
    mode = sys.argv[1]
    if mode == 'list':
        root = Path(sys.argv[2])
        head = read_ids(root / 'failures-controller-head' / 'failures.txt')
        base = read_ids(root / 'failures-controller-base' / 'failures.txt')
        new = sorted(i for i in head - base if i.startswith(PREFIX))
        Path(sys.argv[3]).write_text(''.join(i + '\n' for i in new), encoding='utf-8')
        print(f'{len(new)} head-only controller failures')
        return
    if mode == 'base':
        still_new = read_ids(sys.argv[2]) - read_ids(sys.argv[3])
        # Whole test files, one per process: naming a test the base lacks makes pytest skip the
        # run, and running the file keeps the tests' usual neighbours. Stale = failed every time.
        files = sorted({n.split('::')[0] for n in (node_id(i) for i in still_new) if n})
        stale = set(still_new) if files else set()
        for attempt in range(RERUNS):
            failed = set()
            for k, path in enumerate(files):
                junit = Path(os.environ.get('RUNNER_TEMP', '.')) / f'rerun-base-{attempt}-{k}.xml'
                if run_pytest([path], junit):
                    failed |= failed_ids(junit)
            stale &= failed
        Path(sys.argv[4]).write_text(''.join(i + '\n' for i in sorted(stale)), encoding='utf-8')
        print(f'{len(stale)} of {len(still_new)} still-new failures also fail on the base (stale base list)')
        return
    new, flaky_out = read_ids(sys.argv[2]), Path(sys.argv[3])
    nodes = {i: node_id(i) for i in new}
    runnable = sorted(n for n in nodes.values() if n)
    flaky = set()
    for attempt in range(RERUNS):
        if not runnable:
            break
        junit = Path(os.environ.get('RUNNER_TEMP', '.')) / f'rerun-{attempt}.xml'
        if run_pytest(runnable, junit):
            flaky |= passed_ids(junit) & new
        runnable = sorted(n for i, n in nodes.items() if n and i not in flaky)
    flaky_out.write_text(''.join(i + '\n' for i in sorted(flaky)), encoding='utf-8')
    print(f'{len(flaky)} of {len(new)} passed on rerun (flaky); unmapped: {sum(1 for n in nodes.values() if not n)}')


if __name__ == '__main__':
    main()
