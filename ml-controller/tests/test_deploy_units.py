import pytest

import tools.deploy_units as du
from tools.deploy_units import ROOT, UNFOLLOWED, entries, outside_inputs, touched_units


def write(root, rel, text=''):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def test_units_follow_relative_imports_out_of_their_directory(tmp_path):
    write(tmp_path, 'worker/src/index.ts', "import a from './lib/a'\nimport('../../schemas/s.json')\n")
    write(tmp_path, 'worker/src/lib/a.ts', "export * from './b.js'\n")
    write(tmp_path, 'worker/src/lib/b.ts', "import p from '../../../ml-controller/services/p.json'\n")
    write(tmp_path, 'worker/src/lib/a.test.ts', "import t from '../../../ml-controller/tests/fixture.json'\n")
    write(tmp_path, 'worker/src/lib/f.testSupport.ts', "import t from '../../../ml-controller/tests/fixture.json'\n")
    write(tmp_path, 'frontend/src/main.tsx', "import { c } from '../../worker/src/lib/c'\n")
    write(tmp_path, 'worker/src/lib/c.ts', "import d from './d'\n")
    write(tmp_path, 'worker/src/lib/d.ts', "import s from '../../../schemas/s.json'\n")
    write(tmp_path, 'worker/src/monitoring/index.ts', "import { c } from '../lib/c'\nimport j from './judgment/j'\n")
    write(tmp_path, 'worker/src/monitoring/judgment/j.ts', '')
    write(tmp_path, 'worker/src/monitoring/m.test.ts', "import t from '../../../ml-controller/tests/fixture.json'\n")
    for rel in ('schemas/s.json', 'ml-controller/services/p.json', 'ml-controller/tests/fixture.json'):
        write(tmp_path, rel, '{}')

    assert outside_inputs('worker', tmp_path) == {'schemas/s.json', 'ml-controller/services/p.json'}
    # The monitoring Worker shares worker/src/lib: those files are its outside inputs.
    assert outside_inputs('worker/src/monitoring', tmp_path) == {'worker/src/lib/c.ts', 'worker/src/lib/d.ts', 'schemas/s.json'}
    assert all('monitoring' not in p.as_posix() for p in entries('worker', tmp_path))
    assert outside_inputs('frontend', tmp_path) == {
        'worker/src/lib/c.ts', 'worker/src/lib/d.ts', 'schemas/s.json'}

    units = lambda *changed: touched_units(list(changed), tmp_path)
    assert units('ml-controller/services/p.json') == {'worker': True, 'pages': False, 'monitoring': False}
    assert units('worker/src/lib/d.ts') == {'worker': True, 'pages': True, 'monitoring': True}
    assert units('worker/src/lib/b.ts') == {'worker': True, 'pages': False, 'monitoring': False}
    assert units('worker/wrangler.toml') == {'worker': True, 'pages': False, 'monitoring': False}
    assert units('worker/wrangler.monitoring.toml') == {'worker': False, 'pages': False, 'monitoring': True}
    assert units('worker/src/monitoring/judgment/j.ts') == {'worker': False, 'pages': False, 'monitoring': True}
    assert units('tools/deploy_monitoring_worker_with_provenance.mjs') == {'worker': False, 'pages': False, 'monitoring': True}
    assert units('worker/package-lock.json') == {'worker': True, 'pages': False, 'monitoring': True}
    assert units('frontend/index.html') == {'worker': False, 'pages': True, 'monitoring': False}
    assert units('infra/gcp-scheduler-jobs.json') == {'worker': True, 'pages': True, 'monitoring': False}
    # Not bundled: a redeploy would only mint a new version id (and reset version-scoped state).
    assert units('worker/src/lib/a.test.ts', 'ml-controller/tests/fixture.json', 'worker/migrations/0099_x.sql',
                 'worker/scripts/x.ts', 'worker/findings.md', 'frontend/README.md', 'worker/src/monitoring/m.test.ts',
                 'worker/src/monitoring/f.testSupport.ts') == {'worker': False, 'pages': False, 'monitoring': False}


def test_unit_source_has_no_file_reference_the_scan_cannot_follow():
    hits = [f'{p.relative_to(ROOT).as_posix()}: {m.group(0)}'
            for unit in ('worker', 'frontend', 'worker/src/monitoring') for p in entries(unit, ROOT)
            for m in [UNFOLLOWED.search(p.read_text(encoding='utf-8', errors='replace'))] if m]
    assert hits == [], 'teach tools/deploy_units.py to follow these, or deploys may miss a change'


def test_repo_worker_bundles_controller_policy_files():
    assert 'ml-controller/services/paired_nav_transport_policy.json' in outside_inputs('worker', ROOT)


PUSHED = 'a' * 40  # a push event's before-SHA


@pytest.fixture
def repo(monkeypatch):
    """HEAD=h on main; history o1 <- o2 <- h; live versions set per test."""
    live = {}
    ancestors = {('o1', 'h'), ('o2', 'h'), ('o1', 'o2'), (PUSHED, 'h')}
    diffs = {('o1', 'h'): 'frontend/src/a.tsx\nworker/src/b.ts', ('o2', 'h'): 'frontend/src/a.tsx', (PUSHED, 'h'): 'worker/src/monitoring/x.ts'}
    def git(*args):
        if args[0] == 'rev-parse':
            return 'h'
        if args[0] == 'ls-remote':
            return f'{live.get("remote", "h")}\trefs/heads/main'
        if args[0] == 'diff':
            return diffs[(args[2], args[3])]
        if args[0] == 'merge-base':
            return 'o1'
        raise AssertionError(args)
    monkeypatch.setattr(du, 'git', git)
    monkeypatch.setattr(du, 'is_ancestor', lambda old, new: (old, new) in ancestors)
    monkeypatch.setattr(du, 'live_sha', lambda unit: live[unit])
    monkeypatch.setattr(du, 'touched_units', lambda changed, root=ROOT: {
        'worker': any(c.startswith('worker/') and 'monitoring' not in c for c in changed),
        'pages': any(c.startswith('frontend/') for c in changed),
        'monitoring': any(c.startswith('worker/src/monitoring/') for c in changed)})
    return live


def test_plan_diffs_each_unit_against_its_live_version(repo):
    repo.update(worker='o2', pages='o1')
    # A run that never deployed o1..o2 (cancelled, rejected, failed) still leaves those changes here.
    assert du.plan('changed') == {'worker': 'false', 'pages': 'true', 'monitoring': 'false', 'gate_base': 'o1'}
    repo.update(worker='o1', pages='o2')
    assert du.plan('changed') == {'worker': 'true', 'pages': 'true', 'monitoring': 'false', 'gate_base': 'o1'}


def test_plan_skips_live_units_and_deploys_unreadable_ones(repo):
    repo.update(worker='h', pages='')
    assert du.plan('changed') == {'worker': 'false', 'pages': 'true', 'monitoring': 'false', 'gate_base': ''}
    repo.update(worker='o2', pages='o2')
    assert du.plan('worker') == {'worker': 'true', 'pages': 'false', 'monitoring': 'false', 'gate_base': 'o2'}


@pytest.mark.parametrize('choice', ['changed', 'worker', 'all'])
def test_plan_refuses_to_replace_a_live_version_main_never_merged(repo, choice):
    # A side-branch release, or a newer version than this main, must reach main first; no choice overrides it.
    repo.update(worker='x-not-in-history', pages='h')
    with pytest.raises(SystemExit, match='worker live version x-not-in-history is not in main history'):
        du.plan(choice)


def test_plan_deploys_one_unit_beside_another_unit_main_never_merged(repo):
    # units=pages replaces only Pages, so a side-branch Worker does not block it.
    repo.update(worker='x-not-in-history', pages='o2')
    assert du.plan('pages') == {'worker': 'false', 'pages': 'true', 'monitoring': 'false', 'gate_base': 'o2'}


def test_plan_leaves_a_moved_main_to_the_newer_run(repo):
    repo.update(worker='o1', pages='o1', remote='newer')
    assert du.plan('all') == {'worker': 'false', 'pages': 'false', 'monitoring': 'false', 'gate_base': ''}


def test_plan_monitoring_from_the_pushed_range(repo):
    # No public live version (Access): a push plans it when the pushed range touches it; units=monitoring forces it.
    repo.update(worker='h', pages='h')
    assert du.plan('changed', PUSHED) == {'worker': 'false', 'pages': 'false', 'monitoring': 'true', 'gate_base': ''}
    assert du.plan('changed', '') == {'worker': 'false', 'pages': 'false', 'monitoring': 'false', 'gate_base': ''}
    assert du.plan('changed', 'f' * 40) == {'worker': 'false', 'pages': 'false', 'monitoring': 'false', 'gate_base': ''}, 'not in history'
    assert du.plan('monitoring') == {'worker': 'false', 'pages': 'false', 'monitoring': 'true', 'gate_base': ''}
    repo.update(worker='o2', pages='o2')
    assert du.plan('worker', PUSHED) == {'worker': 'true', 'pages': 'false', 'monitoring': 'false', 'gate_base': 'o2'}
    assert du.plan('all') == {'worker': 'true', 'pages': 'true', 'monitoring': 'true', 'gate_base': 'o1'}  # merge-base stub


def test_gate_requires_push_run_gates_since_base(monkeypatch):
    states = {'h': ['pending', 'success'], 'o2': ['none'], 'o1x': ['failure']}
    monkeypatch.setenv('GITHUB_REPOSITORY', 'o/r')
    monkeypatch.setattr(du.time, 'sleep', lambda s: None)
    monkeypatch.setattr(du, 'gate_state', lambda repo, sha: states[sha].pop(0) if len(states[sha]) > 1 else states[sha][0])
    commits = {'o1': 'h\no2', 'o0': 'h\no2\no1x'}
    monkeypatch.setattr(du, 'git', lambda *a: 'h' if a[0] == 'rev-parse' else commits[a[2].split('..')[0]])
    du.gate('o1')  # o2 was never a push tip: gated as part of h's push
    states['h'] = ['success']
    with pytest.raises(SystemExit, match='o1x: failure'):
        du.gate('o0')  # an older red gate is inherited by every later commit
    states['h'] = ['none']
    with pytest.raises(SystemExit, match='h: none'):
        du.gate('', missing_s=-1)
