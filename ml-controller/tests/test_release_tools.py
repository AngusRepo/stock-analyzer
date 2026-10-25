"""tools/release (E-2) and deploy-controller.yml (E-4b): pure logic, no cloud calls (gcloud mocked)."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import release  # noqa: E402
import release_admission as admission  # noqa: E402
import release_build as build  # noqa: E402
import release_receipts as receipts  # noqa: E402
import release_rollout as rollout  # noqa: E402
import runtime_context  # noqa: E402

TW = timezone(timedelta(hours=8))
DOCKERFILE = (ROOT / 'Dockerfile').read_text(encoding='utf-8')


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


@pytest.mark.parametrize('path,deploys', [
    ('ml-controller/services/l4_distribution.py', True),
    ('ml-controller/requirements.txt', True),
    ('worker/src/lib/marketScreener.ts', True),          # screener job runs worker-dist
    ('worker/package-lock.json', True),
    ('ml-service/modal_app.py', True),                   # Modal ships at the controller SHA
    ('infra/gcp-scheduler-jobs.json', True),             # provenance hashes the manifest
    ('tools/finlab_v4_remote_backfill.py', True),
    ('data/feature_registry/unified.json', True),
    ('Dockerfile', True),
    ('.dockerignore', True),
    ('worker/src/lib/marketScreener.test.ts', False),
    ('ml-controller/tests/test_x.py', False),
    ('ml-service/tests/test_x.py', False),
    ('ml-controller/README.md', False),
    ('frontend/src/main.tsx', False),
    ('tools/deploy_units.py', False),
    ('tools/release/release.py', False),
    ('.github/workflows/deploy-controller.yml', False),
])
def test_controller_unit_follows_the_dockerfile_and_modal_inputs(path, deploys):
    assert release.controller_inputs_changed([path], DOCKERFILE) is deploys


def test_plan_diffs_against_live_and_fails_closed_off_main(monkeypatch):
    head, live = 'b' * 40, 'a' * 40
    calls = {'rev-parse': head, 'ls-remote': head + '\trefs/heads/main', 'diff': 'ml-controller/services/x.py'}
    monkeypatch.setattr(release, 'repo_git', lambda *a: calls[a[0]])
    monkeypatch.setattr(release, 'is_ancestor', lambda old, new: True)
    assert release.plan('changed', live) == {'controller': 'true', 'live_sha': live, 'gate_base': live}
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
    config = build.cloudbuild_config('img:sha', 'a' * 40, 'b' * 40, 'c' * 64)
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


@pytest.fixture
def manifest_repo(tmp_path):
    repo = tmp_path / 'repo'
    services = repo / 'ml-controller/services'
    services.mkdir(parents=True)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    identities = {'allocator_source_identity': {'a.py': '1' * 64}, 'l3_inference_source_identity': {'b.py': '2' * 64}}
    (services / 'native_execution_behavior_release.json').write_text(json.dumps(
        {'execution_owner_version': 'native-paper-v1:' + 'f' * 64,
         'runtime_admission': admission.GRANT_PREFIX + 'r-g-20261024'}))
    (services / 'strategy_nav_source_release.json').write_text(json.dumps({'approved_sources': identities}))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'live')
    return repo, git(repo, 'rev-parse', 'HEAD'), identities


def test_classify_reuses_the_live_grant_only_without_identity_change(manifest_repo):
    repo, live, identities = manifest_repo
    (repo / 'ml-controller/services/other.py').write_text('x = 1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'source-only change')
    head = git(repo, 'rev-parse', 'HEAD')
    decision = admission.classify(repo, live, head, identities=identities)
    assert decision['mode'] == 'reuse' and decision['grant_key'].endswith('r-g-20261024')
    drifted = {**identities, 'l3_inference_source_identity': {'b.py': '3' * 64}}
    decision = admission.classify(repo, live, head, identities=drifted)
    assert decision['mode'] == 'new-grant'
    assert decision['reasons'] == ['l3_inference_source_identity_differs_from_manifest:b.py']
    behavior = repo / 'ml-controller/services/native_execution_behavior_release.json'
    behavior.write_text(json.dumps({'execution_owner_version': 'native-paper-v1:' + 'e' * 64,
                                    'runtime_admission': admission.GRANT_PREFIX + 'r-next'}))
    git(repo, 'commit', '-qam', 're-pin')
    decision = admission.classify(repo, live, git(repo, 'rev-parse', 'HEAD'), identities=identities)
    assert decision['mode'] == 'new-grant'
    assert decision['reasons'] == ['release_manifest_repinned:native_execution_behavior_release.json']


def test_main_manifest_matches_its_own_source_identities():
    """The reuse rule depends on approved_sources tracking the committed allocator / L3 sources."""
    pytest.importorskip('ijson')
    approved = json.loads((ROOT / 'ml-controller/services/strategy_nav_source_release.json').read_text())['approved_sources']
    assert admission.source_identities(ROOT) == approved


@pytest.mark.parametrize('tw,blocked', [
    ('2026-10-27T07:59', None), ('2026-10-27T08:01', '2026-10-27T08:50'), ('2026-10-27T08:49', '2026-10-27T08:50'),
    ('2026-10-27T08:50', None), ('2026-10-27T12:00', None), ('2026-10-27T13:20', '2026-10-27T13:50'),
    ('2026-10-27T23:45', '2026-10-28T00:10'), ('2026-10-28T00:05', '2026-10-28T00:10'), ('2026-10-28T00:10', None),
])
def test_rollout_never_overlaps_a_scaler_window(tw, blocked):
    at = datetime.fromisoformat(tw).replace(tzinfo=TW)
    until = rollout.blocked_until(at)
    assert (until.astimezone(TW).strftime('%Y-%m-%dT%H:%M') if until else None) == blocked


def test_scaler_window_wait_sleeps_then_gives_up():
    clock = [datetime(2026, 10, 27, 8, 30, tzinfo=TW)]
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        clock[0] += timedelta(seconds=seconds)
    rollout.wait_outside_scaler_windows(clock=lambda: clock[0], sleep=sleep)
    assert slept == [20 * 60]
    with pytest.raises(RuntimeError, match='scaler_window_wait_limit'):
        rollout.wait_outside_scaler_windows(clock=lambda: datetime(2026, 10, 27, 8, 30, tzinfo=TW),
                                            sleep=lambda s: None, limit=timedelta(minutes=5))
    assert rollout.same_tw_day('2026-10-27T15:59:00+00:00', datetime(2026, 10, 27, 15, 0, tzinfo=timezone.utc))
    assert not rollout.same_tw_day('2026-10-27T15:59:00+00:00', datetime(2026, 10, 27, 16, 1, tzinfo=timezone.utc))


def prior_receipts():
    provenance = {'schema_version': 'stockvision-modal-deployment-provenance-v1', 'source_sha': 'a' * 40}
    raw = json.dumps({'path': 'finlab/v4/x.json', 'sha256': '1' * 64})
    prior = {'modal_release': {'status': 'verified', 'bootstrap_preserved': True, 'provenance': provenance,
                               'completed_at': '2026-10-28T12:00:30+00:00'},
             'bootstrap': {'status': 'PASS', 'raw_ref': raw, 'reference': json.loads(raw), 'generation': '7'}}
    history = {'Tag': 'a' * 40, 'Time deployed': '2026-10-28T12:00:00+00:00', 'Version': 'v400'}
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
    assert receipts.publish_stage('a' * 40, 'gh-1-1', tmp_path, 'build') == 2
    assert all(args[:3] == ('storage', 'cp', '--no-clobber') for args in sent)
    assert sorted(args[4] for args in sent) == [
        'gs://stockvision-models/release-receipts/' + 'a' * 40 + '/gh-1-1/build/cloudbuild.json',
        'gs://stockvision-models/release-receipts/' + 'a' * 40 + '/gh-1-1/build/probe-plan.json']
    with pytest.raises(ValueError):
        receipts.prefix('main')
    with pytest.raises(ValueError):
        receipts.prefix('a' * 40, '../x')


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
        admission.new_grant(tmp_path, tmp_path / 'out', 'a' * 40, prior_bundle=b'', prior_components={},
                            new_bundle=tmp_path / 'x', release_id='r-x-20261028', authorization='Wei go', review='r')


def test_deploy_controller_workflow_is_inert_and_pinned():
    text = (ROOT / '.github/workflows/deploy-controller.yml').read_text(encoding='utf-8')
    assert "if: vars.CD_CONTROLLER_ENABLED == 'true' && github.ref == 'refs/heads/main'" in text
    assert 'environment: production' in text and 'cancel-in-progress: false' in text and 'group: production' in text
    assert 'stockvision-cd-deployer@gen-lang-client-0602998820.iam.gserviceaccount.com' in text
    assert 'tools/deploy_units.py gate --base' in text and "grep -qx 'identity=reuse'" in text
    assert 'secrets.' not in text and 'upload-artifact' not in text      # receipts only go to GCS
    for line in text.splitlines():
        if 'uses:' in line:
            ref = line.split('@', 1)[1].split()[0]
            assert len(ref) == 40 and all(c in '0123456789abcdef' for c in ref), line
