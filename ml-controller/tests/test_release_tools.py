"""tools/release (E-2) and deploy-controller.yml (E-4b): pure logic, no cloud calls (gcloud mocked)."""
from argparse import Namespace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import production_turn  # noqa: E402
import release  # noqa: E402
import release_admission as admission  # noqa: E402
import release_build as build  # noqa: E402
import release_receipts as receipts  # noqa: E402
import release_rollout as rollout  # noqa: E402
import runtime_context  # noqa: E402

TW = timezone(timedelta(hours=8))
DOCKERFILE = (ROOT / 'Dockerfile').read_text(encoding='utf-8')
MODAL = release.modal_inputs(ROOT)
SHA = 'a' * 40


def tw(text):
    return datetime.fromisoformat(text).replace(tzinfo=TW)


def test_dockerfile_copy_parsing_fails_closed_on_unreviewed_forms():
    copies = build.dockerfile_copies('FROM x\n# c\nCOPY a b \\\n  /app/\nCOPY --chown=1 c /app/c\n')
    assert copies == [(['a', 'b'], '/app/'), (['c'], '/app/c')]
    for text, error in (('ADD a /b', 'dockerfile_add_requires_review'),
                        ('COPY ["a","b"]', 'dockerfile_copy_json_form_requires_review'),
                        ('COPY --from=x a /b', 'dockerfile_copy_from_stage_requires_review'),
                        ('FROM x', 'dockerfile_has_no_copy')):
        with pytest.raises(RuntimeError, match=error):
            build.dockerfile_copies(text)
    assert build.copy_matches('worker/', 'worker/src/a.ts')
    assert build.copy_matches('data/feature_registry/*.json', 'data/feature_registry/x.json')
    assert not build.copy_matches('data/feature_registry/*.json', 'data/x.json')
    with pytest.raises(RuntimeError, match='requires_review'):
        build.copy_matches('.', 'anything')


def test_modal_inputs_are_every_add_local_source_of_modal_app():
    assert {'tools', 'schemas', 'data/feature_registry', 'data/finlab_source_contract.json',
            'ml-controller/strategy_mining_job_main.py', 'ml-controller/services', 'ml-service/app',
            'ml-service/scripts', 'ml-service/vendor/tabpack',
            'output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv'} <= MODAL


@pytest.mark.parametrize('text,error', [
    ('img.add_local_dir(some_call(), remote_path="/x")\n', 'modal_local_input_unrecognized'),
    ('_LOCAL_X = Path("/abs")\nimg.add_local_dir(str(_LOCAL_X))\n', 'modal_local_input_unrecognized'),
    ('img.add_local_python_source("pkg")\n', 'modal_local_input_unrecognized'),
    ('img.add_local_dir(remote_path="/x")\n', 'modal_local_input_unrecognized'),
    ('x = 1\n', 'modal_local_inputs_not_found'),
    ('_LOCAL_R = _resolve_local_repo_root()\nimg.add_local_dir(str(_LOCAL_R))\n', 'modal_local_input_is_repo_root'),
    ('_LOCAL_R = _resolve_local_repo_root()\nimg.add_local_dir(str(_LOCAL_R / "schemas"))\nfrom tools.x import y\n',
     'modal_import_not_shipped:tools.x'),
])
def test_modal_input_parse_fails_closed(text, error):
    with pytest.raises(RuntimeError, match=error):
        release.modal_local_inputs(text, root_dirs={'tools', 'schemas'})


@pytest.mark.parametrize('path,deploys', [
    ('ml-controller/services/l4_distribution.py', True),
    ('ml-controller/requirements.txt', True),
    ('worker/src/lib/marketScreener.ts', True),          # screener job runs worker-dist
    ('worker/package-lock.json', True),
    ('ml-service/modal_app.py', True),                   # Modal ships at the controller SHA
    ('ml-service/vendor/tabpack/pyproject.toml', True),
    ('infra/gcp-scheduler-jobs.json', True),             # provenance hashes the manifest
    ('tools/finlab_v4_remote_backfill.py', True),
    ('tools/finlab_gcs_upload.py', True),                # Modal add_local_dir(tools) + import
    ('tools/finlab_stage_progress.py', True),
    ('tools/deploy_units.py', True),                     # all of tools/ is in the Modal image
    ('schemas/new_contract.json', True),
    ('data/feature_registry/unified.json', True),
    ('data/finlab_source_contract.json', True),
    ('ml-controller/strategy_mining_job_main.py', True),
    ('output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv', True),
    ('Dockerfile', True),
    ('.dockerignore', True),
    ('worker/src/lib/marketScreener.test.ts', False),
    ('ml-controller/tests/test_x.py', False),
    ('ml-service/tests/test_x.py', False),
    ('tools/release/README.md', False),
    ('frontend/src/main.tsx', False),
    ('output/other/report.csv', False),
    ('.github/workflows/deploy-controller.yml', False),
])
def test_controller_unit_follows_the_dockerfile_and_modal_inputs(path, deploys):
    assert release.controller_inputs_changed([path], DOCKERFILE, MODAL) is deploys


def test_plan_diffs_against_live_and_fails_closed_off_main(monkeypatch):
    head, live = 'b' * 40, SHA
    calls = {'rev-parse': head, 'ls-remote': head + '\trefs/heads/main', 'diff': 'ml-controller/services/x.py'}
    monkeypatch.setattr(release, 'repo_git', lambda *a: calls[a[0]])
    monkeypatch.setattr(release, 'is_ancestor', lambda old, new: True)
    assert release.plan('changed', live) == {'controller': 'true', 'live_sha': live, 'gate_base': live}
    calls['diff'] = 'schemas/x.json'                                           # Modal-only input
    assert release.plan('changed', live)['controller'] == 'true'
    calls['diff'] = 'frontend/src/main.tsx'
    assert release.plan('changed', live)['controller'] == 'false'
    assert release.plan('controller', live)['controller'] == 'true'
    assert release.plan('controller', head)['controller'] == 'false'          # already live
    monkeypatch.setattr(release, 'is_ancestor', lambda old, new: False)
    with pytest.raises(SystemExit, match='not an ancestor'):
        release.plan('changed', live)
    calls['ls-remote'] = 'c' * 40 + '\trefs/heads/main'                       # a newer run owns main
    assert release.plan('changed', live)['controller'] == 'false'


def test_import_list_is_generated_from_source():
    native = (ROOT / 'ml-controller/services/native_paper_sandbox.py').read_text(encoding='utf-8')
    members = build.native_pipeline_members(native)
    assert 'paired_native_session.py' in members and len(members) > 20
    changed = ['ml-controller/services/l4_new.py', 'ml-controller/routers/pipeline.py',
               'ml-controller/oof_materialize_job_main.py', 'ml-controller/main.py',
               'ml-controller/scripts/x.py', 'ml-controller/tests/test_x.py', 'ml-controller/services/x.json',
               'ml-controller/services/sub/__init__.py']
    modules = build.import_modules(native, changed)
    assert {'services.l4_new', 'routers.pipeline', 'oof_materialize_job_main', 'services.sub',
            'services.paired_native_session', 'graphs.daily_pipeline_v2'} <= set(modules)
    assert not {'main', 'scripts.x', 'tests.test_x'} & set(modules)
    with pytest.raises(RuntimeError, match='native_pipeline_members_not_found'):
        build.native_pipeline_members('def native_execution_identity():\n    return 1\n')


def test_build_config_has_build_and_probe_only_and_submit_is_async_with_staging():
    config = build.cloudbuild_config('img:sha', SHA, 'b' * 40, 'c' * 64)
    assert len(config['steps']) == 2 and config['timeout'] == '2400s'
    assert config['steps'][0]['args'][-1] == 'context' and config['steps'][1]['args'][-1] == '/audit/probe.py'
    assert config['serviceAccount'].endswith('/stockvision-cloudrun-builder@gen-lang-client-0602998820.iam.gserviceaccount.com')
    args = build.submit_args()
    assert '--async' in args and '--gcs-source-staging-dir=gs://gen-lang-client-0602998820_cloudbuild/source' in args
    assert '--region=asia-east2' in args


def test_build_wait_polls_describe_until_a_terminal_status(tmp_path):
    (tmp_path / 'build-start.json').write_text(json.dumps({'id': 'x'}))
    states = iter(['QUEUED', 'WORKING', 'SUCCESS'])
    value = build.wait(tmp_path, describe=lambda: {'status': next(states)}, sleep=lambda s: None)
    assert value['status'] == 'SUCCESS' and (tmp_path / 'build-result.json').exists()
    (tmp_path / 'build-result.json').unlink()
    with pytest.raises(RuntimeError, match='pinned_build_not_successful:FAILURE'):
        build.wait(tmp_path, describe=lambda: {'status': 'FAILURE'}, sleep=lambda s: None)
    with pytest.raises(RuntimeError, match='build_wait_limit'):
        build.wait(tmp_path, describe=lambda: {'status': 'WORKING'}, sleep=lambda s: None)


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


NATIVE_HOST_SOURCE = '''
def native_execution_identity():
    pipeline = ('m1.py', 'm2.py', 'm3.py', 'm4.py', 'm5.py', 'm6.py')
    return pipeline
'''


def write(repo, path, text):
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text, encoding='utf-8')


@pytest.fixture
def manifest_repo(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'config', 'core.autocrlf', 'false')
    identities = {'allocator_source_identity': {'a.py': '1' * 64}, 'l3_inference_source_identity': {'b.py': '2' * 64}}
    write(repo, 'ml-controller/services/native_execution_behavior_release.json', json.dumps(
        {'execution_owner_version': 'native-paper-v1:' + 'f' * 64, 'runtime_admission': admission.GRANT_PREFIX + 'r-g-20261024'}))
    write(repo, 'ml-controller/services/strategy_nav_source_release.json', json.dumps({'approved_sources': identities}))
    write(repo, admission.NATIVE_HOST, NATIVE_HOST_SOURCE)
    write(repo, admission.NATIVE_RESCORE, 'x = 1\n')
    for name in ('m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'other'):
        write(repo, f'ml-controller/services/{name}.py', 'x = 1\n')
    write(repo, admission.NATIVE_ENTRY, "import { plan } from '../lib/plan';\n// import '../lib/commented';\n")
    write(repo, 'worker/src/lib/plan.ts', "import type { T } from './types';\nexport * from './rules.js';\nexport const plan = 1;\n")
    write(repo, 'worker/src/lib/rules.ts', 'export const r = 1;\n')
    write(repo, 'worker/src/lib/types.ts', 'export type T = number;\n')
    write(repo, 'worker/src/lib/routes.ts', 'export const unrelated = 1;\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'live')
    return repo, git(repo, 'rev-parse', 'HEAD'), identities


def commit(repo, path, text):
    write(repo, path, text)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'change ' + path)
    return git(repo, 'rev-parse', 'HEAD')


def test_classify_reuses_the_live_grant_only_without_identity_change(manifest_repo):
    repo, live, identities = manifest_repo
    head = commit(repo, 'ml-controller/services/other.py', 'x = 2\n')
    decision = admission.classify(repo, live, head, identities=identities)
    assert decision['mode'] == 'reuse' and decision['grant_key'].endswith('r-g-20261024')
    assert admission.classify(repo, live, head, identities='checked')['mode'] == 'reuse'
    drifted = {**identities, 'l3_inference_source_identity': {'b.py': '3' * 64}}
    decision = admission.classify(repo, live, head, identities=drifted)
    assert decision['mode'] == 'new-grant'
    assert decision['reasons'] == ['l3_inference_source_identity_differs_from_manifest:b.py']
    head = commit(repo, 'ml-controller/services/native_execution_behavior_release.json', json.dumps(
        {'execution_owner_version': 'native-paper-v1:' + 'e' * 64, 'runtime_admission': admission.GRANT_PREFIX + 'r-next'}))
    decision = admission.classify(repo, live, head, identities=identities)
    assert decision['mode'] == 'new-grant'
    assert decision['reasons'] == ['release_manifest_repinned:native_execution_behavior_release.json']


@pytest.mark.parametrize('path,native', [
    ('ml-controller/services/m3.py', True),               # pipeline member
    (admission.NATIVE_HOST, True),                        # private host
    (admission.NATIVE_RESCORE, True),                     # rescore router
    ('worker/src/node-runner/atomicPopulationJobMain.ts', True),
    ('worker/src/lib/plan.ts', True),                     # in the bundle graph
    ('worker/src/lib/rules.ts', True),                    # re-exported, `.js` specifier
    ('worker/src/lib/types.ts', False),                   # type-only import is erased
    ('worker/src/lib/routes.ts', False),                  # not reachable from the entry
    ('ml-controller/services/other.py', False),
])
def test_classify_treats_native_identity_inputs_as_new_grant(manifest_repo, path, native):
    repo, live, identities = manifest_repo
    text = ('// changed\nexport const changed = 2;\n' if path.endswith('.ts')
            else NATIVE_HOST_SOURCE + '# changed\n' if path == admission.NATIVE_HOST else 'x = 3\n')
    head = commit(repo, path, text)
    decision = admission.classify(repo, live, head, identities=identities)
    assert (decision['mode'] == 'new-grant') is native
    if native:
        assert decision['reasons'] == ['native_identity_inputs_changed:' + path]


def test_native_bundle_import_that_resolves_nowhere_fails_closed(manifest_repo):
    repo, live, identities = manifest_repo
    head = commit(repo, 'worker/src/lib/plan.ts', "import { gone } from './gone';\n")
    with pytest.raises(RuntimeError, match='native_bundle_import_unresolved:worker/src/lib/plan.ts:./gone'):
        admission.classify(repo, live, head, identities=identities)


def test_ts_relative_imports_follow_what_the_bundler_follows():
    text = ("import type { A } from './a';\nimport { type B, c } from './c';\nimport './side';\n"
            "export { d } from '../d';\nconst e = await import('./e');\nconst f = require('./f');\n"
            "/* import { g } from './g'; */\nimport fs from 'node:fs';\nconst url = 'https://x//y';\n")
    assert sorted(admission.ts_relative_imports(text)) == ['../d', './c', './e', './f', './side']


def test_main_manifest_matches_its_own_source_identities():
    """The reuse rule depends on approved_sources tracking the committed allocator / L3 sources."""
    pytest.importorskip('ijson')
    approved = json.loads((ROOT / 'ml-controller/services/strategy_nav_source_release.json').read_text())['approved_sources']
    assert admission.source_identities(ROOT) == approved


@pytest.mark.parametrize('at,blocked', [
    ('2026-10-27T07:44', None), ('2026-10-27T07:46', '2026-10-27T08:50'), ('2026-10-27T08:49', '2026-10-27T08:50'),
    ('2026-10-27T08:50', None), ('2026-10-27T12:00', None), ('2026-10-27T12:44', None),
    ('2026-10-27T13:20', '2026-10-27T13:50'), ('2026-10-27T23:45', '2026-10-28T00:10'),
    ('2026-10-28T00:05', '2026-10-28T00:10'), ('2026-10-28T00:10', None),
])
def test_mutation_budget_never_overlaps_a_scaler_window(at, blocked):
    until = rollout.blocked_until(tw(at))
    assert (until.astimezone(TW).strftime('%Y-%m-%dT%H:%M') if until else None) == blocked


def test_scaler_window_wait_covers_idle_wait_and_mutation_budget():
    clock = [tw('2026-10-27T07:30')]                    # 70 min before 08:40: START_BUDGET blocks it
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        clock[0] += timedelta(seconds=seconds)
    rollout.wait_outside_scaler_windows(clock=lambda: clock[0], sleep=sleep)
    assert slept == [80 * 60] and clock[0] == tw('2026-10-27T08:50')
    with pytest.raises(RuntimeError, match='scaler_window_wait_exceeds_limit_or_job_time'):
        rollout.wait_outside_scaler_windows(clock=lambda: tw('2026-10-27T08:30'), sleep=lambda s: None,
                                            limit=timedelta(minutes=5))
    with pytest.raises(RuntimeError, match='scaler_window_wait_exceeds_limit_or_job_time'):
        rollout.wait_outside_scaler_windows(clock=lambda: tw('2026-10-27T08:30'), sleep=lambda s: None,
                                            deadline=tw('2026-10-27T09:30'))
    assert rollout.same_tw_day('2026-10-27T15:59:00+00:00', datetime(2026, 10, 27, 15, 0, tzinfo=timezone.utc))
    assert not rollout.same_tw_day('2026-10-27T15:59:00+00:00', datetime(2026, 10, 27, 16, 1, tzinfo=timezone.utc))


def gate(at, **overrides):
    values = dict(observed_at=tw('2026-10-27T10:00').isoformat(), deadline=None, remote_sha=SHA, release_sha=SHA)
    values.update(overrides)
    rollout.mutation_gate(tw(at), **values)


def test_mutation_gate_rechecks_head_day_window_and_job_time_after_every_wait():
    gate('2026-10-27T10:30')
    with pytest.raises(RuntimeError, match='source_remote_branch_moved_before_first_mutation'):
        gate('2026-10-27T10:30', remote_sha='c' * 40)
    # An idle wait that started outside the window can end inside the mutation budget of one.
    with pytest.raises(RuntimeError, match='scaler_window_inside_mutation_budget'):
        gate('2026-10-27T13:00')
    with pytest.raises(RuntimeError, match='admission_baseline_crossed_tw_midnight_readmit'):
        gate('2026-10-28T00:20')
    with pytest.raises(RuntimeError, match='job_time_left_below_mutation_budget'):
        gate('2026-10-27T10:30', deadline=tw('2026-10-27T11:00'))
    gate('2026-10-27T10:30', deadline=tw('2026-10-27T11:20'))


@pytest.mark.parametrize('submit,ok', [
    ('2026-10-27T21:00', True),       # rollout reaches its first mutation by ~22:26
    ('2026-10-27T22:00', False),      # the build ends inside the 00:00 window: mutation after midnight
    ('2026-10-27T23:00', False),
    ('2026-10-28T00:20', True),
])
def test_build_submit_refuses_a_rollout_that_would_cross_tw_midnight(submit, ok):
    at = tw(submit)
    observed = (at - timedelta(minutes=5)).isoformat()
    if ok:
        rollout.require_submit_window(observed, at)
    else:
        with pytest.raises(RuntimeError, match='admission_day_ends_before_rollout'):
            rollout.require_submit_window(observed, at)
    with pytest.raises(RuntimeError, match='job_time_left_below_build_and_rollout_budget'):
        rollout.require_submit_window(tw('2026-10-27T10:00').isoformat(), tw('2026-10-27T10:00'),
                                      deadline=tw('2026-10-27T11:30'))


def test_job_deadline_is_required_in_cd(monkeypatch):
    monkeypatch.delenv('RELEASE_DEADLINE', raising=False)
    monkeypatch.delenv('GITHUB_ACTIONS', raising=False)
    assert rollout.job_deadline() is None
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    with pytest.raises(RuntimeError, match='release_deadline_missing_in_cd'):
        rollout.job_deadline()
    monkeypatch.setenv('RELEASE_DEADLINE', '1793000000')
    assert rollout.job_deadline() == datetime.fromtimestamp(1793000000, timezone.utc)


def test_durable_saves_reach_the_store_at_once_and_never_block_the_rollback(tmp_path, monkeypatch):
    copied = []
    monkeypatch.setattr(rollout, 'OUT', tmp_path)
    monkeypatch.setattr(rollout, 'PUBLISH', lambda path: copied.append(path.name))
    rollout.save('rollback.json', {'service_revision': 'r1'}, durable=True)
    rollout.save('activity-initial.json', {})
    assert copied == ['rollback.json']

    def broken(path):
        raise OSError('gcs down')
    monkeypatch.setattr(rollout, 'PUBLISH', broken)
    with pytest.raises(OSError):                       # before any mutation: fail closed
        rollout.save('controller-release.json', {'status': 'staging'}, durable=True)
    rollout.save('controller-release.json', {'status': 'failed'}, durable=True, strict=False)   # rollback path
    assert json.loads((tmp_path / 'controller-release.json').read_text())['status'] == 'failed'


def test_rollout_progress_copies_are_numbered_and_never_clobbered(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(receipts, '_gcloud', lambda *args, check=True: sent.append(args))
    (tmp_path / 'rollback.json').write_text('{}')
    first = receipts.publish_progress(SHA, 'gh-1-1', tmp_path / 'rollback.json', 'rollout')
    second = receipts.publish_progress(SHA, 'gh-1-1', tmp_path / 'rollback.json', 'rollout')
    assert first != second and first.startswith(receipts.prefix(SHA, 'gh-1-1') + '/rollout/progress/')
    assert all(args[:3] == ('storage', 'cp', '--no-clobber') for args in sent)


class Store:
    """In-memory receipt bucket behind receipts.read / listing."""

    def __init__(self, files):
        self.files = {receipts.BUCKET + '/' + k: (v if isinstance(v, bytes) else json.dumps(v).encode()) for k, v in files.items()}

    def read(self, url):
        return self.files.get(url)

    def listing(self, url):
        base = url[:-2] if url.endswith('**') else url
        if url.endswith('**'):
            return sorted(k for k in self.files if k.startswith(base))
        children = {base + k[len(base):].split('/')[0] + ('/' if '/' in k[len(base):] else '') for k in self.files if k.startswith(base)}
        return sorted(children)


def use_store(monkeypatch, files):
    store = Store(files)
    monkeypatch.setattr(receipts, 'read', store.read)
    monkeypatch.setattr(receipts, 'listing', store.listing)
    return store


def test_killed_or_unrolled_back_attempts_block_a_rerun(monkeypatch):
    use_store(monkeypatch, {
        f'{SHA}/gh-1-1/rollout/progress/001-rollback.json': {},
        f'{SHA}/gh-1-1/rollout/progress/002-controller-release.json': {'status': 'staging'},
        f'{SHA}/gh-2-1/rollout/controller-release.json': {'status': 'failed', 'rollback_status': 'verified'},
        f'{SHA}/gh-3-1/rollout/controller-release.json': {'status': 'failed', 'rollback_status': 'requires_reconciliation'},
        f'{SHA}/gh-4-1/rollout/progress/001-controller-release.json': {'status': 'staging'},
        f'{SHA}/gh-4-1/rollout/progress/002-controller-release.json': {'status': 'verified'},
        f'{SHA}/gh-5-1/build/deployment-build-packet.json': {},
    })
    assert receipts.attempts(SHA) == ['gh-1-1', 'gh-2-1', 'gh-3-1', 'gh-4-1', 'gh-5-1']
    assert receipts.rollout_state(SHA, 'gh-4-1') == {'status': 'verified'}       # newest progress copy
    assert receipts.unreconciled_attempts(SHA) == ['gh-1-1', 'gh-3-1']
    assert receipts.unreconciled_attempts(SHA, skip='gh-1-1') == ['gh-3-1']
    args = Namespace(publish=True, out=Path('unused'), source=ROOT, python=sys.executable, resume_staged=False,
                     from_receipts=False)
    monkeypatch.setattr(release, 'attempt_id', lambda out: 'gh-6-1')
    monkeypatch.setattr(release, 'release_sha', lambda a: SHA)
    with pytest.raises(RuntimeError, match='previous_rollout_attempt_unreconciled:gh-1-1,gh-3-1'):
        release.cmd_rollout(args)()


def test_verify_from_receipts_rebuilds_a_killed_runs_stage_files(tmp_path, monkeypatch):
    base = f'{SHA}/gh-7-1'
    use_store(monkeypatch, {
        f'{base}/admission/admission-receipt.json': {'mode': 'reuse'},
        f'{base}/build/deployment-build-packet.json': {'source_sha': SHA},
        f'{base}/rollout/progress/001-bootstrap-verification.json': {'status': 'PASS'},
        f'{base}/rollout/progress/002-rollback.json': {'service_revision': 'r1'},
        f'{base}/rollout/progress/003-controller-release.json': {'status': 'staging'},
        f'{base}/rollout/progress/004-modal-release.json': {'status': 'verified'},
    })
    attempt, state = release.fetch_attempt(SHA, None, tmp_path / 'out')
    out = tmp_path / 'out'
    assert attempt == 'gh-7-1' and state == {'status': 'staging'}
    for name in release.ROLLOUT_DURABLE:
        assert (out / 'rollout' / name).exists(), name
    assert json.loads((out / 'attempt.json').read_text()) == {'attempt': 'gh-7-1'}
    with pytest.raises(RuntimeError, match='verify_out_not_empty'):
        release.fetch_attempt(SHA, 'gh-7-1', out)


def test_verify_refuses_a_rolled_back_or_incomplete_rollout(tmp_path):
    for name, value in (('admission/admission-receipt.json', {'mode': 'reuse'}),
                        ('build/deployment-build-packet.json', {'source_sha': SHA}),
                        ('rollout/controller-release.json', {'status': 'failed', 'source_sha': SHA})):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(json.dumps(value))
    pytest.importorskip('modal')
    with pytest.raises(RuntimeError, match='rollout_not_verified_or_rolled_back:failed'):
        release.verify_release(tmp_path, publish=False)
    (tmp_path / 'rollout/controller-release.json').write_text(json.dumps({'status': 'staging', 'source_sha': SHA}))
    with pytest.raises(RuntimeError, match='rollout_receipt_missing:rollout/modal-release.json'):
        release.verify_release(tmp_path, publish=False)
    with pytest.raises(RuntimeError, match='receipt_sha_mismatch'):
        release.verify_release(tmp_path, publish=False, sha='b' * 40)


def test_receipts_are_rehashed_against_the_current_json_digests(monkeypatch):
    modal_release = json.dumps({'status': 'verified'}).encode()
    files = {'rollout/modal-release.json': hashlib.sha256(modal_release).hexdigest()}
    store = use_store(monkeypatch, {
        f'{SHA}/current.json': {'status': 'verified', 'attempt': 'gh-1-1', 'files': files},
        f'{SHA}/gh-1-1/rollout/modal-release.json': modal_release,
    })
    assert receipts.read_current(SHA, 'rollout/modal-release.json') == modal_release
    with pytest.raises(RuntimeError, match='receipt_not_in_digest_manifest'):
        receipts.read_current(SHA, 'rollout/bootstrap-verification.json')
    store.files[f'{receipts.BUCKET}/{SHA}/gh-1-1/rollout/modal-release.json'] = b'{"status": "forged"}'
    with pytest.raises(RuntimeError, match='receipt_digest_mismatch:rollout/modal-release.json'):
        receipts.read_current(SHA, 'rollout/modal-release.json')
    store.files[f'{receipts.BUCKET}/{SHA}/current.json'] = json.dumps({'status': 'verified', 'attempt': 'gh-1-1'}).encode()
    with pytest.raises(RuntimeError, match='current_receipt_without_digest_manifest'):
        receipts.read_current(SHA, 'rollout/modal-release.json')
    assert receipts.read_current('b' * 40, 'rollout/modal-release.json') is None
    with pytest.raises(RuntimeError, match='current_receipt_needs_file_digests'):
        receipts.write_current(SHA, {'status': 'verified'}, Path('unused'))


def test_bootstrap_reference_must_match_the_git_anchor(tmp_path):
    reference = {'path': 'finlab/v4/bootstrap.parquet', 'sha256': '1' * 64}
    anchors = tmp_path / 'tools/release/trust_anchors.json'
    anchors.parent.mkdir(parents=True)
    anchors.write_text(json.dumps({rollout.BOOTSTRAP_ANCHOR: None}))
    with pytest.raises(RuntimeError, match='bootstrap_trust_anchor_not_committed'):
        rollout.require_bootstrap_anchor(tmp_path, reference, required=True)
    assert rollout.require_bootstrap_anchor(tmp_path, reference, required=False) is None   # fresh live env
    anchors.write_text(json.dumps({rollout.BOOTSTRAP_ANCHOR: rollout.bootstrap_anchor_digest(reference)}))
    assert rollout.require_bootstrap_anchor(tmp_path, reference, required=True)
    forged = {**reference, 'path': 'attacker/bootstrap.parquet'}
    with pytest.raises(RuntimeError, match='bootstrap_reference_differs_from_git_anchor'):
        rollout.require_bootstrap_anchor(tmp_path, forged, required=True)
    committed = json.loads((ROOT / 'tools/release/trust_anchors.json').read_text())
    value = committed[rollout.BOOTSTRAP_ANCHOR]
    assert value is None or re.fullmatch('[a-f0-9]{64}', value)
    # No generation shortcut: the rollout re-hashes the object on every release.
    assert 'reuse prior SHA256 proof' not in (ROOT / 'tools/release/release_rollout.py').read_text(encoding='utf-8')


def prior_receipts():
    provenance = {'schema_version': 'stockvision-modal-deployment-provenance-v1', 'source_sha': SHA}
    raw = json.dumps({'path': 'finlab/v4/x.json', 'sha256': '1' * 64})
    prior = {'modal_release': {'status': 'verified', 'bootstrap_preserved': True, 'provenance': provenance,
                               'completed_at': '2026-10-28T12:00:30+00:00'},
             'bootstrap': {'status': 'PASS', 'raw_ref': raw, 'reference': json.loads(raw), 'generation': '7'}}
    history = {'Tag': SHA, 'Time deployed': '2026-10-28T12:00:00+00:00', 'Version': 'v400'}
    return prior, provenance, history, raw


def test_prior_bootstrap_must_be_bound_to_the_live_modal_release():
    prior, provenance, history, raw = prior_receipts()
    assert rollout.prior_bootstrap(prior, provenance, history)[0] == raw
    with pytest.raises(RuntimeError, match='seed_receipt_store'):
        rollout.prior_bootstrap({}, provenance, history)
    with pytest.raises(RuntimeError, match='not_bound'):
        rollout.prior_bootstrap(prior, provenance, {**history, 'Tag': 'b' * 40})
    with pytest.raises(RuntimeError, match='not_bound'):
        rollout.prior_bootstrap(prior, {**provenance, 'source_sha': 'b' * 40}, history)
    with pytest.raises(RuntimeError, match='deployment_time_mismatch'):
        rollout.prior_bootstrap(prior, provenance, {**history, 'Time deployed': '2026-10-28T11:00:00+00:00'})
    prior['bootstrap']['reference'] = {'path': 'other', 'sha256': '1' * 64}
    with pytest.raises(RuntimeError, match='previous_bootstrap_receipt_invalid'):
        rollout.prior_bootstrap(prior, provenance, history)


def test_receipts_publish_without_clobbering_and_skip_the_docker_context(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(receipts, '_gcloud', lambda *args, check=True: sent.append(args))
    for name in ('build/cloudbuild.json', 'build/context/worker/src/a.ts', 'build/probe-plan.json'):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text('{}')
    assert receipts.publish_stage(SHA, 'gh-1-1', tmp_path, 'build') == 2
    assert all(args[:3] == ('storage', 'cp', '--no-clobber') for args in sent)
    assert sorted(args[4] for args in sent) == [
        'gs://stockvision-models/release-receipts/' + SHA + '/gh-1-1/build/cloudbuild.json',
        'gs://stockvision-models/release-receipts/' + SHA + '/gh-1-1/build/probe-plan.json']
    assert set(receipts.digests(tmp_path, ('build',))) == {'build/cloudbuild.json', 'build/probe-plan.json'}
    with pytest.raises(ValueError):
        receipts.prefix('main')
    with pytest.raises(ValueError):
        receipts.prefix(SHA, '../x')


def test_controller_cd_reads_only_its_named_secrets_and_never_kv(monkeypatch):
    assert set(runtime_context.CD_SECRETS.values()) == {
        'stockvision-ml-controller-secret', 'stockvision-stockvision-auth-token',
        'stockvision-cd-modal-token-id', 'stockvision-cd-modal-token-secret'}
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    monkeypatch.setenv('CF_API_TOKEN', 'x')
    with pytest.raises(RuntimeError, match='kv_unavailable'):
        runtime_context.kv_get('trading:config')


def test_new_grant_admission_is_refused_in_cd(monkeypatch, tmp_path):
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    with pytest.raises(RuntimeError, match='manual_only'):
        admission.new_grant(tmp_path, tmp_path / 'out', SHA, prior_bundle=b'', prior_components={},
                            new_bundle=tmp_path / 'x', release_id='r-x-20261028', authorization='Wei go', review='r')


def turn_api(runs):
    """runs: {(workflow, run id): jobs}"""
    def fetch(path):
        if '/workflows/' in path:
            workflow = path.split('/workflows/')[1].split('/')[0]
            return {'workflow_runs': [{'id': run} for (w, run) in runs if w == workflow]}
        run = int(path.split('/runs/')[1].split('/')[0])
        return {'jobs': next(jobs for (w, r), jobs in runs.items() if r == run)}
    return fetch


def controller_jobs(step_start, status='in_progress'):
    return [{'name': 'controller', 'status': 'in_progress', 'started_at': '2026-10-27T01:00:00Z',
             'steps': [{'name': 'Build', 'status': 'completed', 'started_at': '2026-10-27T01:05:00Z'},
                       {'name': 'Rollout (controller no-traffic -> ...)', 'status': status, 'started_at': step_start}]}]


def cloudflare_jobs(start):
    return [{'name': 'plan', 'status': 'completed', 'started_at': '2026-10-27T00:00:00Z'},
            {'name': 'cloudflare', 'status': 'in_progress', 'started_at': start}]


def test_production_turn_orders_the_two_workflows_without_deadlock():
    runs = {('deploy-controller.yml', 10): controller_jobs('2026-10-27T02:00:00Z'),
            ('deploy-cloudflare.yml', 20): cloudflare_jobs('2026-10-27T01:30:00Z')}
    fetch = turn_api(runs)
    # The Cloudflare job started before the controller's rollout: the controller waits, not vice versa.
    assert production_turn.blockers('o/r', 'controller', 10, fetch) == [('2026-10-27T01:30:00Z', 20)]
    assert production_turn.blockers('o/r', 'cloudflare', 20, fetch) == []
    runs[('deploy-cloudflare.yml', 20)] = cloudflare_jobs('2026-10-27T02:10:00Z')
    assert production_turn.blockers('o/r', 'controller', 10, fetch) == []
    assert production_turn.blockers('o/r', 'cloudflare', 20, fetch) == [('2026-10-27T02:00:00Z', 10)]
    # A controller run still building (no Rollout step in progress) holds nothing.
    runs[('deploy-controller.yml', 10)] = controller_jobs('2026-10-27T02:00:00Z', status='queued')
    assert production_turn.blockers('o/r', 'cloudflare', 20, fetch) == []
    with pytest.raises(RuntimeError, match='own_controller_section_not_in_progress'):
        production_turn.blockers('o/r', 'controller', 10, fetch)


def test_production_turn_wait_gives_up_after_its_limit(monkeypatch):
    monkeypatch.setenv('GITHUB_REPOSITORY', 'o/r')
    monkeypatch.setenv('GITHUB_RUN_ID', '20')
    fetch = turn_api({('deploy-controller.yml', 10): controller_jobs('2026-10-27T02:00:00Z'),
                      ('deploy-cloudflare.yml', 20): cloudflare_jobs('2026-10-27T02:10:00Z')})
    clock = [0.0]

    def sleep(seconds):
        clock[0] += seconds
    with pytest.raises(RuntimeError, match='production_turn_wait_limit:10'):
        production_turn.wait('cloudflare', 1, fetch=fetch, sleep=sleep, clock=lambda: clock[0])


def workflow(name):
    return (ROOT / '.github/workflows' / name).read_text(encoding='utf-8')


def job_block(text, job):
    return text.split('\n  ' + job + ':\n', 1)[1].split('\n  reverify:\n')[0]


def test_deploy_controller_workflow_is_inert_and_pinned():
    text = workflow('deploy-controller.yml')
    assert "if: vars.CD_CONTROLLER_ENABLED == 'true' && github.ref == 'refs/heads/main'" in text
    assert 'environment: production' in text and 'cancel-in-progress: false' in text
    assert 'stockvision-cd-deployer@gen-lang-client-0602998820.iam.gserviceaccount.com' in text
    assert 'tools/deploy_units.py gate --base' in text and "grep -qx 'identity=reuse'" in text
    assert "needs.plan.outputs.identity == 'reuse'" in text
    assert 'secrets.' not in text and 'upload-artifact' not in text      # receipts only go to GCS
    for line in text.splitlines():
        if 'uses:' in line:
            ref = line.split('@', 1)[1].split()[0]
            assert len(ref) == 40 and all(c in '0123456789abcdef' for c in ref), line


def test_the_two_deploy_workflows_never_share_a_concurrency_group():
    groups = {name: re.findall(r'^\s+group: (\S+)$', workflow(name), re.M)
              for name in ('deploy-controller.yml', 'deploy-cloudflare.yml')}
    assert groups == {'deploy-controller.yml': ['production-controller'], 'deploy-cloudflare.yml': ['production-cloudflare']}
    assert 'production_turn.py wait --role cloudflare' in workflow('deploy-cloudflare.yml')
    controller = job_block(workflow('deploy-controller.yml'), 'controller')
    rollout_step = controller.split('- name: Rollout', 1)[1].split('- name: Verify')[0]
    assert rollout_step.index('production_turn.py wait --role controller') < rollout_step.index('release.py rollout')


def test_oidc_jobs_install_only_hash_pinned_wheels():
    text = workflow('deploy-controller.yml')
    for job in ('controller', 'reverify'):
        block = job_block(text, job) if job == 'controller' else text.split('\n  reverify:\n', 1)[1]
        assert 'id-token: write' in block
        installs = [line for line in block.splitlines() if 'pip install' in line]
        assert installs == ['          python -m pip install --require-hashes --only-binary=:all: --no-deps -r tools/release/requirements-cd.txt']
        assert 'cache: pip' not in block
    plan = text.split('\n  plan:\n', 1)[1].split('\n  controller:\n')[0]
    assert 'id-token' not in plan and 'release.py classify' in plan
    assert '--identities-checked-by-plan' in job_block(text, 'controller')
    assert 'RELEASE_DEADLINE=' in job_block(text, 'controller')
    pins = (ROOT / 'tools/release/requirements-cd.txt').read_text(encoding='utf-8')
    entries = re.split(r'\n(?=[a-z])', pins.split('\n', 7)[-1].strip())
    assert entries and all('--hash=sha256:' in entry for entry in entries)
    required = (ROOT / 'ml-controller/requirements.txt').read_text(encoding='utf-8')
    for name in ('modal', 'httpx'):
        version = re.search(rf'^{name}==(\S+)', required, re.M).group(1)
        assert re.search(rf'^{name}=={re.escape(version)} ', pins, re.M), name


def test_verify_can_be_rerun_from_receipts_by_dispatch():
    text = workflow('deploy-controller.yml')
    assert 'options: [dry-run, deploy, verify]' in text
    block = text.split('\n  reverify:\n', 1)[1]
    assert "inputs.mode == 'verify'" in block and 'environment: production' in block
    assert 'release.py verify --from-receipts --sha' in block
    with pytest.raises(SystemExit):
        release.main(['verify', '--from-receipts', '--out', 'x'])
