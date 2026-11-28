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


REAL_SYNCED = du.monitoring_synced_sha


@pytest.fixture
def repo(monkeypatch):
    """HEAD=h on main; history m0 <- c12 <- h and o1 <- o2 <- h, where c12 changed the monitoring Worker
    (#326) and h only the frontend (#329); live versions and the last confirmed monitoring commit
    (`synced`, default h) set per test."""
    live = {}
    ancestors = {('o1', 'h'), ('o2', 'h'), ('o1', 'o2'), ('m0', 'h'), ('c12', 'h'), ('m0', 'c12')}
    diffs = {('o1', 'h'): 'frontend/src/a.tsx\nworker/src/b.ts', ('o2', 'h'): 'frontend/src/a.tsx',
             ('m0', 'h'): 'worker/src/monitoring/x.ts\nfrontend/src/a.tsx', ('c12', 'h'): 'frontend/src/a.tsx'}
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
    monkeypatch.setattr(du, 'monitoring_synced_sha', lambda: live.get('synced', 'h'))
    monkeypatch.setattr(du, 'touched_units', lambda changed, root=ROOT: {
        'worker': any(c.startswith('worker/') and 'monitoring' not in c for c in changed),
        'pages': any(c.startswith('frontend/') for c in changed),
        'monitoring': any(c.startswith('worker/src/monitoring/') for c in changed)})
    return live


def test_plan_diffs_each_unit_against_its_live_version(repo):
    repo.update(worker='o2', pages='o1')
    # A run that never deployed o1..o2 (cancelled, rejected, failed) still leaves those changes here.
    # The cloudflare job runs anyway, so it also checks the monitoring Worker against its live version.
    assert du.plan('changed') == {'worker': 'false', 'pages': 'true', 'monitoring': 'true', 'gate_base': 'o1'}
    repo.update(worker='o1', pages='o2')
    assert du.plan('changed') == {'worker': 'true', 'pages': 'true', 'monitoring': 'true', 'gate_base': 'o1'}


def test_plan_skips_live_units_and_deploys_unreadable_ones(repo):
    repo.update(worker='h', pages='')
    assert du.plan('changed') == {'worker': 'false', 'pages': 'true', 'monitoring': 'true', 'gate_base': ''}
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


def runs_api(monkeypatch, runs):
    """deploy-cloudflare runs as (run_number, head_sha, conclusion of the sync step or None when the
    cloudflare job did not run); returns the gh api paths called."""
    monkeypatch.setenv('GITHUB_REPOSITORY', 'o/r')
    calls = []
    def gh(path):
        calls.append(path)
        if path.startswith('repos/o/r/actions/workflows/deploy-cloudflare.yml/runs?'):
            assert 'branch=main' in path and 'status=completed' in path
            return {'workflow_runs': [{'id': n * 10, 'run_number': n, 'head_sha': sha} for n, sha, _ in runs]}
        run_id = int(path.split('/actions/runs/')[1].split('/')[0])
        conclusion = next(c for n, _, c in runs if n * 10 == run_id)
        jobs = [{'name': 'plan', 'steps': [{'name': du.MONITORING_SYNC_STEP, 'conclusion': 'success'}]}]  # other jobs never count
        if conclusion == 'rejected':
            jobs.append({'name': 'cloudflare', 'steps': []})
        elif conclusion is not None:
            jobs.append({'name': 'cloudflare', 'steps': [{'name': 'Still the main tip', 'conclusion': 'success'},
                                                         {'name': du.MONITORING_SYNC_STEP, 'conclusion': conclusion}]})
        return {'jobs': jobs}
    monkeypatch.setattr(du, 'gh', gh)
    return calls


def test_synced_sha_is_the_newest_run_that_confirmed_the_monitoring_worker(monkeypatch):
    # Newest first: nothing planned, rejected, main moved (11/28 c12578a7: "nothing deployed by this run").
    calls = runs_api(monkeypatch, [(11, 'm0', 'success'), (14, 'x', None), (13, 'r', 'rejected'), (12, 'c12', 'skipped'), (10, 'old', 'success')])
    assert REAL_SYNCED() == 'm0'
    assert len(calls) == 1 + 4, 'stops at the first confirmed run'
    runs_api(monkeypatch, [(12, 'c12', 'skipped'), (11, 'f', 'failure')])
    assert REAL_SYNCED() == ''


def test_plan_still_deploys_monitoring_after_a_run_that_deployed_nothing(repo, monkeypatch):
    # 11/28: c12 changed the monitoring Worker, its run found main moved and deployed nothing; the run for h
    # planned from the pushed range c12..h and skipped it. The plan now starts at the last confirmed commit.
    monkeypatch.setattr(du, 'monitoring_synced_sha', REAL_SYNCED)
    runs_api(monkeypatch, [(12, 'c12', 'skipped'), (11, 'm0', 'success')])
    repo.update(worker='h', pages='h')  # even when nothing else needs a deploy
    assert du.plan('changed') == {'worker': 'false', 'pages': 'false', 'monitoring': 'true', 'gate_base': ''}
    repo.update(worker='c12', pages='c12')  # the incident's own case: Worker and Pages deploy
    assert du.plan('changed')['monitoring'] == 'true'


def test_plan_asks_no_approval_for_an_unchanged_monitoring_worker(repo, monkeypatch):
    # The cloudflare job waits for Wei: a push that deploys nothing must not plan the monitoring Worker.
    repo.update(worker='h', pages='h')
    nothing = {'worker': 'false', 'pages': 'false', 'monitoring': 'false', 'gate_base': ''}
    assert du.plan('changed') == nothing, 'confirmed at HEAD'
    repo.update(synced='o2')
    assert du.plan('changed') == nothing, 'o2..h changes only the frontend'
    repo.update(synced='m0')
    assert du.plan('changed')['monitoring'] == 'true'
    for unknown in ('', 'x-not-in-history'):  # one approval, whose run records the confirmed commit
        repo.update(synced=unknown)
        assert du.plan('changed')['monitoring'] == 'true'


def test_plan_monitoring_follows_the_choice(repo, monkeypatch):
    def no_lookup():
        raise AssertionError('the Actions API is not needed')
    monkeypatch.setattr(du, 'monitoring_synced_sha', no_lookup)
    repo.update(worker='h', pages='h')
    assert du.plan('monitoring') == {'worker': 'false', 'pages': 'false', 'monitoring': 'true', 'gate_base': ''}
    repo.update(worker='o2', pages='o2')
    assert du.plan('changed')['monitoring'] == 'true', 'the job runs anyway'
    assert du.plan('worker') == {'worker': 'true', 'pages': 'false', 'monitoring': 'false', 'gate_base': 'o2'}
    assert du.plan('all') == {'worker': 'true', 'pages': 'true', 'monitoring': 'true', 'gate_base': 'o1'}  # merge-base stub


HEAD, STALE, QUIET, SIDE = 'e' * 40, '1' * 40, '2' * 40, '3' * 40


@pytest.fixture
def live_repo(monkeypatch):
    """HEAD on main; STALE predates a monitoring change, QUIET only predates other changes, SIDE is not in main."""
    diffs = {STALE: 'worker/src/monitoring/x.ts', QUIET: 'frontend/src/a.tsx\nworker/src/lib/b.ts'}
    monkeypatch.setattr(du, 'git', lambda *a: HEAD if a[0] == 'rev-parse' else diffs[a[2]] if a[0] == 'diff' and a[3] == HEAD else (_ for _ in ()).throw(AssertionError(a)))
    monkeypatch.setattr(du, 'is_ancestor', lambda old, new: new == HEAD and old in diffs)
    monkeypatch.setattr(du, 'touched_units', lambda changed, root=ROOT: {'monitoring': any(c.startswith('worker/src/monitoring/') for c in changed)})


def test_monitoring_decision_deploys_only_what_live_lacks(live_repo):
    skip = {'deploy': 'false', 'gate_base': ''}
    assert du.monitoring_decision('changed', HEAD) == skip, 'already live'
    assert du.monitoring_decision('changed', QUIET) == skip, 'live..HEAD changes no monitoring input'
    assert du.monitoring_decision('changed', STALE) == {'deploy': 'true', 'gate_base': STALE}
    assert du.monitoring_decision('monitoring', QUIET) == {'deploy': 'true', 'gate_base': QUIET}, 'units=monitoring forces it'
    assert du.monitoring_decision('all', HEAD) == skip, 'never mints a new version for a live commit'
    # Unreadable (no version at 100 %, no tag): deploy it, gated from HEAD only.
    assert du.monitoring_decision('changed', '') == {'deploy': 'true', 'gate_base': ''}


@pytest.mark.parametrize('choice', ['changed', 'monitoring', 'all'])
@pytest.mark.parametrize('live', [SIDE, 'not-a-sha'])
def test_monitoring_decision_refuses_a_live_version_main_never_merged(live_repo, choice, live):
    with pytest.raises(SystemExit, match=f'monitoring live version {live} is not in main history'):
        du.monitoring_decision(choice, live)


def cloudflare_workflow():
    import yaml  # PyYAML: present in the controller suite (langchain-core, optuna, dagster depend on it)
    text = (ROOT / '.github/workflows' / du.WORKFLOW).read_text(encoding='utf-8')
    jobs = yaml.safe_load(text)['jobs']
    return text, jobs, {job: {step.get('name') or step['uses']: step for step in body['steps']} for job, body in jobs.items()}


def test_workflow_decides_the_monitoring_worker_from_live():
    text, jobs, steps = cloudflare_workflow()
    select = steps['plan']['Select units']
    assert select['env']['GH_TOKEN'] == '${{ github.token }}' and jobs['plan']['permissions']['actions'] == 'read'
    assert select['run'].startswith('python3 tools/deploy_units.py plan --choice "$CHOICE" |')
    assert 'event.before' not in text and '--since' not in text, 'a pushed range misses runs that deployed nothing'
    cf = steps[du.MONITORING_SYNC_JOB]
    order = list(cf)
    decide = cf['Decide monitoring Worker']
    assert decide['id'] == 'monitoring' and decide['if'] == "steps.tip.outputs.current == 'true' && env.MONITORING == 'true'"
    assert 'deploy_monitoring_worker_with_provenance.mjs --live)"' in decide['run']
    assert 'tools/deploy_units.py monitoring --choice "$CHOICE" --live "$live" | tee -a "$GITHUB_OUTPUT"' in decide['run']
    # D1 covers every monitoring deploy: it runs first, on the same decision output, and a D1 failure skips the deploy.
    decided = "steps.monitoring.outputs.deploy == 'true'"
    d1, deploy = cf['Require applied D1 migrations'], cf['Deploy monitoring Worker']
    chain = ['Decide monitoring Worker', 'Require applied D1 migrations', 'Deploy Worker', 'Verify Worker',
             'Deploy monitoring Worker', 'Deploy Pages', 'Verify Pages', du.MONITORING_SYNC_STEP]
    assert [name for name in order if name in chain] == chain
    assert decided in d1['if']
    assert deploy['if'] == f"steps.tip.outputs.current == 'true' && steps.monitoring.outcome == 'success' && {decided}"
    assert deploy['env']['BASE'] == '${{ steps.monitoring.outputs.gate_base }}' and 'deploy_units.py gate --base "$BASE"' in deploy['run']
    # Worker and Pages never wait on the monitoring decision.
    for name in ('Deploy Worker', 'Verify Worker', 'Deploy Pages', 'Verify Pages'):
        assert 'steps.monitoring' not in cf[name]['if'], name
    for name, step in cf.items():
        assert not any(f in str(step.get('if', '')) for f in ('always()', 'cancelled()', 'failure()')), name


def test_workflow_job_name_is_what_the_confirmed_point_lookup_reads():
    # The jobs API reports a job's `name:` when set, else its id; the lookup matches the id.
    _, jobs, steps = cloudflare_workflow()
    assert 'name' not in jobs[du.MONITORING_SYNC_JOB]
    # Count the raw list: the by-name dict would hide a duplicate.
    assert [step.get('name') for step in jobs[du.MONITORING_SYNC_JOB]['steps']].count(du.MONITORING_SYNC_STEP) == 1


def test_workflow_soft_fails_only_the_monitoring_decision():
    _, jobs, steps = cloudflare_workflow()
    assert all('continue-on-error' not in body for body in jobs.values())
    soft = [(job, name) for job, named in steps.items() for name, step in named.items() if 'continue-on-error' in step]
    assert soft == [(du.MONITORING_SYNC_JOB, 'Decide monitoring Worker')]
    assert steps[du.MONITORING_SYNC_JOB]['Decide monitoring Worker']['continue-on-error'] is True


@pytest.mark.parametrize('decision, deployed, code, says', [
    ('failure', '', 1, 'Decide monitoring Worker: failure'),
    ('failure', 'false', 1, 'Decide monitoring Worker: failure'),
    ('success', 'false', 0, 'needs nothing'),
    ('success', '', 1, 'no monitoring decision'),
])
def test_verify_monitoring_fails_last_when_the_decision_failed(tmp_path, decision, deployed, code, says):
    # Last step: a failed decision turns the run red after the Worker and Pages, and records no confirmed point.
    import subprocess
    _, _, steps = cloudflare_workflow()
    cf = steps[du.MONITORING_SYNC_JOB]
    assert list(cf)[-1] == du.MONITORING_SYNC_STEP
    verify = cf[du.MONITORING_SYNC_STEP]
    assert verify['env']['DECISION'] == '${{ steps.monitoring.outcome }}' and verify['env']['DEPLOYED'] == '${{ steps.monitoring.outputs.deploy }}'
    script = tmp_path / 'verify.sh'
    script.write_text(verify['run'], encoding='utf-8')
    result = subprocess.run(['bash', '-eo', 'pipefail', str(script)], capture_output=True, text=True, cwd=tmp_path,
                            env={'PATH': '/usr/bin:/bin', 'DECISION': decision, 'DEPLOYED': deployed, 'GITHUB_SHA': 'e' * 40})
    assert result.returncode == code and says in result.stdout


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
