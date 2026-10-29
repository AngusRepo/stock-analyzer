"""Staged controller + Modal rollout at one SHA: no-traffic revision -> candidate paper admission
-> Modal -> the release jobs -> traffic. Run by release.py rollout (CD or the manual fallback).

Port of audits/rf-rehearsal3-20261025/release/deploy_controller_modal_release.py (itself the repo
tools/deploy_controller_modal_release.py plus #50 policy-grant staging and the full-build packet).
Optimistic comparisons before each mutation and complete configuration checks afterwards; not a
provider-atomic CAS. Never dispatches a chain/job, clears a fence or grants IAM. Secrets and
complete runtime specs stay in process memory. Changes from the rehearsal3 copy:
- paths: no audits/ imports, no Windows venv path; the Python that runs `modal` is passed in.
- PRIOR: the previous Modal release and bootstrap verification come from the receipt store
  (rollout/modal-release.json, rollout/bootstrap-verification.json of the live Modal tag's
  verified attempt), not hand-copied files; this rollout writes both for the next release.
- idle guard: release_idle.inspect (no hard-coded forward-job / e084938e exceptions). The first
  boundary waits for idle up to a limit; later boundaries fail as before.
- bootstrap: the reference must equal the git-committed anchor (tools/release/trust_anchors.json)
  and the object is always re-hashed in full; receipts only carry the raw env string.
- scaler windows / job time: the rollout starts only when the idle wait, the proofs and the full
  mutation budget (rollout + rollback) fit before the next scaler window and the CD job end, and
  mutation_gate() re-checks the pushed head, the admission TW day, the window and the job time
  immediately before the first mutation.
- durable receipts: rollback.json, bootstrap-verification.json, modal-release.json and every
  controller-release.json state are copied to the receipt store the moment they are saved, so a
  run the runner kills mid-rollout (SIGINT then SIGKILL ~10 s later) can still be reconciled.
- KV: only a new-grant release stages grants, and only with operator credentials. Without KV
  (controller CD) the trading:config byte comparison is replaced by "the serving controller's
  paper runtime is still PASS with no drift" at the full boundaries.
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote

from application_job_inventory import application_jobs, read_live_inventory, verify_inventory, verify_ownership

OUT: Path | None = None
SOURCE_KEYS = ('STOCKVISION_SOURCE_SHA', 'STOCKVISION_SOURCE_TREE_SHA',
               'STOCKVISION_SOURCE_BRANCH', 'STOCKVISION_SCHEDULER_MANIFEST_SHA256')
SOURCE_LABELS = ('stockvision-source-sha', 'stockvision-provenance-schema')
JOBS = application_jobs()
AUTO_ANNOTATIONS = {'run.googleapis.com/client-name', 'run.googleapis.com/client-version',
                    'run.googleapis.com/operation-id', 'serving.knative.dev/lastModifier'}
TW = timezone(timedelta(hours=8))
# Cloud Run scaler jobs rewrite ml-controller around these TW times (CD_DESIGN.md §5).
SCALER_WINDOWS = ((0, 0), (8, 40), (13, 40))
WINDOW_MARGIN = timedelta(minutes=10)
# From the first mutation: staged rollout (30 min) plus a full rollback (15 min). Nothing in that
# span may meet a scaler window or the end of the CD job (SIGINT, then SIGKILL ~10 s later).
MUTATION_BUDGET = timedelta(minutes=45)
IDLE_WAIT = timedelta(minutes=30)            # first boundary: wait for active work to finish
PREPARE_BUDGET = timedelta(minutes=10)       # build/ownership/bootstrap/IAM proofs before mutating
START_BUDGET = IDLE_WAIT + PREPARE_BUDGET + MUTATION_BUDGET
BUILD_BUDGET = timedelta(minutes=46)         # release_build.wait: 180 polls x 15 s, plus submit
BOOTSTRAP_ANCHOR = 'finlab_daily_history_bootstrap_ref_sha256'


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


PUBLISH = None  # rollout(publish=...): copies a just-saved receipt to the receipt store


def save(name, value, *, durable=False, strict=True):
    """durable: also copy to the store at once, so a killed run leaves it behind. strict=False
    (rollback path) logs a failed copy instead of raising before the rollback runs."""
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if durable and PUBLISH is not None:
        try:
            PUBLISH(OUT / name)
        except Exception as error:
            if strict:
                raise
            print(f'::warning::receipt copy failed for {name}: {type(error).__name__}', flush=True)


def blocked_until(at: datetime, budget: timedelta = MUTATION_BUDGET) -> datetime | None:
    """None if work of length `budget` started at `at` ends before the next scaler window opens
    (with margin), else the time it may start."""
    local = at.astimezone(TW)
    for day in (-1, 0, 1):
        base = (local + timedelta(days=day)).replace(second=0, microsecond=0)
        for hour, minute in SCALER_WINDOWS:
            centre = base.replace(hour=hour, minute=minute)
            if centre - WINDOW_MARGIN - budget < local < centre + WINDOW_MARGIN:
                return (centre + WINDOW_MARGIN).astimezone(timezone.utc)
    return None


def job_deadline() -> datetime | None:
    """CD: when the runner stops this job (RELEASE_DEADLINE, epoch seconds, set by the workflow)."""
    value = os.environ.get('RELEASE_DEADLINE', '').strip()
    if not value:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            raise RuntimeError('release_deadline_missing_in_cd')
        return None
    return datetime.fromtimestamp(int(value), timezone.utc)


def wait_outside_scaler_windows(*, budget=START_BUDGET, deadline=None, clock=lambda: datetime.now(timezone.utc),
                                sleep=time.sleep, limit=timedelta(minutes=110)):
    started = clock()
    while (until := blocked_until(clock(), budget)) is not None:
        if until - started > limit or (deadline is not None and until + budget > deadline):
            raise RuntimeError('scaler_window_wait_exceeds_limit_or_job_time')
        print('Waiting for the scaler window to pass until ' + until.isoformat(), flush=True)
        sleep(max(1.0, (until - clock()).total_seconds()))


def same_tw_day(first_iso: str, second: datetime) -> bool:
    return datetime.fromisoformat(first_iso).astimezone(TW).date() == second.astimezone(TW).date()


def latest_first_mutation(start: datetime) -> datetime:
    """Worst case: when a rollout started at `start` reaches its first mutation."""
    begin = blocked_until(start, START_BUDGET) or start
    return begin + IDLE_WAIT + PREPARE_BUDGET


def require_submit_window(observed_at: str, at: datetime, deadline: datetime | None = None) -> None:
    """Before a full build: its rollout must still mutate on the admission baseline's TW day and
    finish (rollback included) inside the CD job."""
    first = latest_first_mutation(at + BUILD_BUDGET)
    if not same_tw_day(observed_at, first):
        raise RuntimeError('admission_day_ends_before_rollout_resubmit_after_tw_00_10')
    if deadline is not None and first + MUTATION_BUDGET > deadline:
        raise RuntimeError('job_time_left_below_build_and_rollout_budget')


def mutation_gate(at: datetime, *, observed_at: str, deadline: datetime | None, remote_sha: str, release_sha: str) -> None:
    """Immediately before the first mutation, after every wait: same pushed head, same TW day as
    the admission baseline, no scaler window and no job end inside the full mutation budget."""
    if remote_sha != release_sha:
        raise RuntimeError('source_remote_branch_moved_before_first_mutation')
    if not same_tw_day(observed_at, at):
        raise RuntimeError('admission_baseline_crossed_tw_midnight_readmit')
    if blocked_until(at, MUTATION_BUDGET) is not None:
        raise RuntimeError('scaler_window_inside_mutation_budget')
    if deadline is not None and at + MUTATION_BUDGET > deadline:
        raise RuntimeError('job_time_left_below_mutation_budget')


def require_worker_not_behind(source: Path, worker_sha: str | None, release_sha: str) -> None:
    """E9-d: the Worker goes first or with the release. The live Worker must run the release commit,
    a descendant of it, or an ancestor whose Worker inputs (tools/deploy_units.py) equal the
    release's; otherwise the controller and Modal would run ahead of the Worker they call."""
    if worker_sha == release_sha:
        return
    if not worker_sha or not re.fullmatch('[0-9a-f]{40}', worker_sha):
        raise RuntimeError('worker_live_source_unknown')

    def ancestor(old, new):
        return subprocess.run(['git', '-C', str(source), 'merge-base', '--is-ancestor', old, new],
                              capture_output=True, timeout=60).returncode == 0
    if ancestor(release_sha, worker_sha):
        return
    if not ancestor(worker_sha, release_sha):
        raise RuntimeError('worker_live_source_not_on_release_history')
    from deploy_units import touched_units
    changed = subprocess.check_output(['git', '-C', str(source), 'diff', '--name-only', worker_sha, release_sha],
                                      timeout=60).decode('utf-8').splitlines()
    if touched_units(changed, source)['worker']:
        raise RuntimeError('worker_behind_release_deploy_worker_first')


def bootstrap_anchor_digest(reference: dict) -> str:
    return sha(json.dumps(reference, sort_keys=True, separators=(',', ':')).encode('utf-8'))


def require_bootstrap_anchor(source: Path, reference: dict, *, required: bool) -> str | None:
    """The FinLab bootstrap reference must equal the git-committed anchor of the release source.
    required=False (reference read fresh from the live service env) accepts an absent anchor."""
    anchors = json.loads((source / 'tools/release/trust_anchors.json').read_text(encoding='utf-8'))
    expected = anchors.get(BOOTSTRAP_ANCHOR)
    if expected is None:
        if required:
            raise RuntimeError('bootstrap_trust_anchor_not_committed_see_seed_receipts')
        return None
    if bootstrap_anchor_digest(reference) != expected:
        raise RuntimeError('bootstrap_reference_differs_from_git_anchor')
    return expected


def env_map(container):
    rows = container.get('env', [])
    result = {row['name']: copy.deepcopy(row) for row in rows}
    if len(rows) != len(result):
        raise RuntimeError('duplicate_runtime_env')
    return result


def container(resource, kind):
    task = resource['spec']['template']['spec']
    if kind == 'job':
        task = task['template']['spec']
    if len(task['containers']) != 1:
        raise RuntimeError('unreviewed_multicontainer_resource')
    return task['containers'][0]


def canonical_container(value):
    value = copy.deepcopy(value)
    value['env'] = sorted(value.get('env', []), key=lambda row: row['name'])
    return value


def desired_container(before, image, updates):
    value = copy.deepcopy(before)
    value['image'] = image
    values = env_map(value)
    values.update({key: {'name': key, 'value': item} for key, item in updates.items()})
    value['env'] = list(values.values())
    return value


def clean_annotations(value):
    return {key: item for key, item in value.items() if key not in AUTO_ANNOTATIONS}


def configuration(resource, kind, *, traffic=True):
    """Desired configuration only; never serialize this result to an audit."""
    spec = copy.deepcopy(resource['spec'])
    template = spec['template']
    metadata = template.get('metadata', {})
    metadata.pop('name', None)  # Every service revision has a new immutable name.
    if 'annotations' in metadata:
        metadata['annotations'] = clean_annotations(metadata['annotations'])
    if 'labels' in metadata:
        metadata['labels'] = {key: item for key, item in metadata['labels'].items() if key not in SOURCE_LABELS}
        if kind == 'job':
            # gcloud JobNonceChange regenerates this image-pull marker on --image.
            metadata['labels'].pop('client.knative.dev/nonce', None)
    if not traffic and kind == 'service':
        spec.pop('traffic', None)
    c = container({'spec': spec}, kind)
    c['env'] = sorted(c.get('env', []), key=lambda row: row['name'])
    top = resource.get('metadata', {})
    return {'spec': spec,
            'annotations': clean_annotations(top.get('annotations', {})),
            'labels': {k: v for k, v in top.get('labels', {}).items() if k not in SOURCE_LABELS
                       and not (kind == 'job' and k == 'run.googleapis.com/lastUpdatedTime')}}


def assert_source_only(before, after, kind, image, updates):
    wanted = copy.deepcopy(before)
    c = container(wanted, kind)
    c.clear()
    c.update(desired_container(container(before, kind), image, updates))
    if canonical_container(container(wanted, kind)) != canonical_container(container(after, kind)):
        raise RuntimeError('non_source_container_configuration_changed:' + kind)
    if configuration(wanted, kind, traffic=False) != configuration(after, kind, traffic=False):
        raise RuntimeError('non_source_resource_configuration_changed:' + kind)
    labels = copy.deepcopy(before.get('metadata', {}).get('labels', {}))
    labels.update({'stockvision-source-sha': updates['STOCKVISION_SOURCE_SHA'], 'stockvision-provenance-schema': 'v1'})
    actual_labels = copy.deepcopy(after.get('metadata', {}).get('labels', {}))
    if kind == 'job' and 'run.googleapis.com/lastUpdatedTime' in labels:
        key = 'run.googleapis.com/lastUpdatedTime'
        if datetime.fromisoformat(actual_labels.pop(key)) < datetime.fromisoformat(labels.pop(key)):
            raise RuntimeError('job_last_updated_time_went_backwards')
    if actual_labels != labels:
        raise RuntimeError('source_labels_mismatch:' + kind)
    before_template_labels = before['spec']['template'].get('metadata', {}).get('labels', {})
    after_template_labels = after['spec']['template'].get('metadata', {}).get('labels', {})
    for key in SOURCE_LABELS:
        if key in before_template_labels or key in after_template_labels:
            if after_template_labels.get(key) != labels[key]:
                raise RuntimeError('template_source_label_mismatch:' + kind)


def source_restore_flags(before, kind):
    values = env_map(container(before, kind))
    plain = {key: values[key]['value'] for key in SOURCE_KEYS if key in values and 'value' in values[key]}
    if any(key in values and 'value' not in values[key] for key in SOURCE_KEYS):
        raise RuntimeError('unreviewed_source_secret_reference')
    labels = before.get('metadata', {}).get('labels', {})
    args = ['--image=' + container(before, kind)['image']]
    if plain:
        args.append('--update-env-vars=' + ','.join(key + '=' + value for key, value in plain.items()))
    missing = [key for key in SOURCE_KEYS if key not in values]
    if missing:
        args.append('--remove-env-vars=' + ','.join(missing))
    present = {key: labels[key] for key in SOURCE_LABELS if key in labels}
    if present:
        args.append('--update-labels=' + ','.join(key + '=' + value for key, value in present.items()))
    absent = [key for key in SOURCE_LABELS if key not in labels]
    if absent:
        args.append('--remove-labels=' + ','.join(absent))
    return args


def validate_bootstrap_ref(raw):
    value = json.loads(raw)
    if (not isinstance(value, dict) or not isinstance(value.get('path'), str)
            or not value['path'] or value['path'].startswith('/') or '..' in value['path'].split('/')
            or not re.fullmatch('[a-f0-9]{64}', str(value.get('sha256', '')))):
        raise RuntimeError('live_bootstrap_reference_invalid')
    return value


def prior_bootstrap(prior: dict, baseline_modal: dict, history: dict) -> tuple[str, dict, dict]:
    """(raw ref, reference, receipt) bound to the live Modal deployment by its verified receipts."""
    modal_release, bootstrap = prior.get('modal_release'), prior.get('bootstrap')
    if not modal_release or not bootstrap:
        raise RuntimeError('previous_modal_and_bootstrap_receipts_required_seed_receipt_store')
    if (modal_release.get('status') != 'verified' or modal_release.get('bootstrap_preserved') is not True
            or modal_release.get('provenance') != baseline_modal
            or history.get('Tag') != modal_release['provenance']['source_sha']):
        raise RuntimeError('bootstrap_receipt_not_bound_to_current_modal_release')
    deployed_at = datetime.fromisoformat(history['Time deployed'])
    verified_at = datetime.fromisoformat(modal_release['completed_at'])
    if abs((verified_at - deployed_at).total_seconds()) > 300:
        raise RuntimeError('bootstrap_receipt_deployment_time_mismatch')
    raw = bootstrap.get('raw_ref')
    if bootstrap.get('status') != 'PASS' or not isinstance(raw, str) or validate_bootstrap_ref(raw) != bootstrap.get('reference'):
        raise RuntimeError('previous_bootstrap_receipt_invalid')
    return raw, bootstrap['reference'], bootstrap


def rollout(*, source: Path, out: Path, build_dir: Path, admission_dir: Path, prior: dict, python: str,
            resume_staged: bool = False, idle_wait=IDLE_WAIT, publish=None) -> dict:
    global OUT, PUBLISH
    from release_admission import grant_size, grant_size_warn_bytes
    warn_bytes = grant_size_warn_bytes()  # CD-NEW-09: a bad threshold stops here, before any wait
    OUT, PUBLISH = out, publish
    out.mkdir(parents=True, exist_ok=True)
    packet_path, build_start = build_dir / 'deployment-build-packet.json', build_dir / 'build-start.json'
    failed_stage = load(OUT / 'controller-release.json') if resume_staged else None
    if failed_stage is not None and (failed_stage.get('status') != 'failed'
            or failed_stage.get('models_invoked') != 0 or (OUT / 'modal-release.json').exists()):
        raise RuntimeError('resume_requires_exact_pre_modal_failed_stage')
    if not resume_staged and (OUT / 'controller-release.json').exists():
        raise RuntimeError('release_attempt_exists_reconcile_before_rerun')
    from runtime_context import GC, PROJECT, kv_available, load_environment, read_until_200, request, worker
    from release_guard import compare, inventory
    from release_idle import inspect as idle_inspect
    from verify_prebuilt_release import verify
    from verify_cloud_run_release import verify_health, verify_paper_runtime, verify_traffic
    import modal

    def gc(*argv):
        return subprocess.check_output([GC, *argv, '--project=' + PROJECT], timeout=600)

    def git(*argv):
        return subprocess.check_output(['git', '-C', str(source), *argv], timeout=60).decode('utf-8').strip()

    def service():
        return json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=asia-east1', '--format=json'))

    def job(name):
        return json.loads(gc('run', 'jobs', 'describe', name, '--region=asia-east1', '--format=json'))

    packet = load(packet_path)
    admission = load(admission_dir / 'admission-receipt.json')
    new_grant = admission['mode'] == 'new-grant'
    use_kv = kv_available()
    if new_grant and not use_kv:
        raise RuntimeError('identity_changing_release_requires_manual_rollout_with_kv')
    if packet.get('build_mode') != 'full' or packet.get('rehearsal') or packet.get('admission_mode') != admission['mode']:
        raise RuntimeError('release_packet_not_full_build_or_rehearsal')
    if git('status', '--porcelain', '--untracked-files=no') or git('rev-parse', 'HEAD') != packet['source_sha']:
        raise RuntimeError('source_not_clean_final_head')
    if git('rev-parse', 'HEAD^{tree}') != packet['tree'] or git('branch', '--show-current') != packet['branch']:
        raise RuntimeError('source_tree_or_branch_mismatch')
    remote = git('ls-remote', 'origin', 'refs/heads/' + packet['branch']).split()
    if len(remote) != 2 or remote[0] != packet['source_sha']:
        raise RuntimeError('source_remote_branch_not_final_head')
    observed_at = load(admission_dir / 'baseline.json')['observed_at']
    deadline = job_deadline()
    updates = dict(zip(SOURCE_KEYS, (packet['source_sha'], packet['tree'], packet['branch'], packet['scheduler_sha256'])))
    if any(',' in value or '\n' in value for value in updates.values()):
        raise RuntimeError('invalid_source_env_argument')
    expected_modal = dict(schema_version='stockvision-modal-deployment-provenance-v1', source_sha=packet['source_sha'],
        tree_sha=packet['tree'], source_branch=packet['branch'], scheduler_manifest_sha256=packet['scheduler_sha256'])
    expected_health = dict(sourceSha=packet['source_sha'], sourceTreeSha=packet['tree'],
        sourceBranch=packet['branch'], schedulerManifestSha256=packet['scheduler_sha256'])
    wait_outside_scaler_windows(deadline=deadline)
    if not same_tw_day(observed_at, datetime.now(timezone.utc)):
        raise RuntimeError('admission_baseline_crossed_tw_midnight_readmit')
    if deadline is not None:
        # Shorten the idle wait so the proofs and the whole mutation budget still fit in the job.
        idle_wait = min(idle_wait, deadline - datetime.now(timezone.utc) - PREPARE_BUDGET - MUTATION_BUDGET)
        if idle_wait < timedelta(0):
            raise RuntimeError('job_time_left_below_rollout_budget')
    live = load_environment()
    if live['source_sha'] != (packet['source_sha'] if resume_staged else packet['base_source_sha']):
        raise RuntimeError('live_controller_source_drift')
    # Baseline capture (was capture_runtime_baseline.py): every component, and the trading config when KV is readable.
    baseline = inventory()
    save('runtime-before.json', baseline)
    expected_inventory = copy.deepcopy(baseline)
    if use_kv:
        from runtime_context import kv_get
        config_before = kv_get('trading:config')
        if config_before['http_status'] != 200:
            raise RuntimeError('trading_configuration_unreadable')
        save('config-before.json', config_before['body'])
    resumed_before = None
    if resume_staged:
        if failed_stage['source_sha'] != packet['source_sha']:
            raise RuntimeError('staged_source_mismatch')
        staged_now = service()
        old = load(OUT / 'rollback.json')
        resumed_before = copy.deepcopy(staged_now)
        old_container = container(resumed_before, 'service')
        old_container['image'] = old['service_image']
        for row in old_container['env']:
            name = row['name']
            if name in old['service_source']:
                row.clear()
                row.update(name=name, value=old['service_source'][name])
        metadata = resumed_before['spec']['template']['metadata']
        metadata['name'] = old['service_revision']
        for labels in (metadata['labels'], resumed_before['metadata']['labels']):
            labels['stockvision-source-sha'] = packet['base_source_sha']
            labels['stockvision-provenance-schema'] = 'v1'
        resumed_before['spec']['traffic'] = [row for row in resumed_before['spec']['traffic']
                                             if row.get('revisionName') != failed_stage['revision']]
        baseline_hash = load(admission_dir / 'baseline.json')['service_spec_sha256']
        if sha(json.dumps(resumed_before['spec'], sort_keys=True).encode()) != baseline_hash:
            raise RuntimeError('original_service_spec_cannot_be_exactly_reconstructed')
        assert_source_only(resumed_before, staged_now, 'service', failed_stage['image'], updates)
        verify_traffic(staged_now, old['service_revision'])
        save('staged-resume-reconciliation.json', dict(status='PASS', original_spec_sha256=baseline_hash,
             exact_original_spec_reconstructed=True, reused_revision=failed_stage['revision'], image_rebuilt=False,
             models_invoked=0, chain_dispatched=False))
    worker_before = read_until_200(lambda: worker('/api/health'))
    if worker_before['http_status'] != 200:
        raise RuntimeError('worker_health_unavailable')
    worker_provenance = worker_before['body']['provenance']
    require_worker_not_behind(source, worker_provenance.get('sourceSha'), packet['source_sha'])
    if admission['new_key'] != packet['grant_key'] or admission.get('approval_checksum') != packet['grant_approval_checksum']:
        raise RuntimeError('admission_packet_mismatch')
    sys_path_entry = str(source / 'ml-controller')
    if sys_path_entry not in sys.path:
        sys.path.insert(0, sys_path_entry)
    grant, policy_grants = None, []
    if new_grant:
        grant = load(admission_dir / 'source-grant.json')
        if admission['prior_key'] == admission['new_key'] or grant['approval_checksum'] != admission['approval_checksum']:
            raise RuntimeError('new_source_grant_packet_mismatch')
        grant_size(grant, admission['new_key'], warn_bytes)  # CD-NEW-09: warning only
        os.environ['NATIVE_PAPER_RUNNER'] = str(admission_dir / 'native-paper.cjs')
        if sha(Path(os.environ['NATIVE_PAPER_RUNNER']).read_bytes()) != packet['native_bundle_sha256']:
            raise RuntimeError('native_bundle_checksum_mismatch')
        from services.active8_paper_admission import validate_runtime_approval
        validate_runtime_approval(grant, grant['admission'])
        # Optional L4 policy grants (P1..Pn): same source, reviewed chain of next configurations.
        # They are staged beside S and only selected once the activation tool writes KV.
        policy_path = admission_dir / 'policy-grants.json'
        policy_grants = load(policy_path) if policy_path.exists() else []
        if policy_grants:
            from services.l4_policy_activation import policy_keys
            behavior = json.loads((source / 'ml-controller/services/native_execution_behavior_release.json').read_text())
            keys = admission.get('policy_keys')
            if (behavior.get('runtime_admission') != admission['new_key'] or keys != policy_keys(behavior)
                    or len(keys) != len(policy_grants) or len(set(keys)) != len(keys)
                    or set(keys) & {admission['new_key'], admission['prior_key']}
                    or any(g.get('approved_l4_execution_policy_change') is None for g in policy_grants)):
                raise RuntimeError('policy_grant_packet_mismatch')
            for key, policy_grant in zip(keys, policy_grants):
                validate_runtime_approval(policy_grant, policy_grant['admission'])
                grant_size(policy_grant, key, warn_bytes)
    kv_state = {}
    if use_kv:
        kv_state['config'] = {'http_status': 200, 'body': load(OUT / 'config-before.json')}
        kv_state['prior'] = kv_get(admission['prior_key'])
        if kv_state['prior']['http_status'] != 200 or (new_grant and kv_state['prior']['body']['approval_checksum'] != admission['prior_approval_checksum']):
            raise RuntimeError('prior_grant_preflight_mismatch')
        if policy_grants:
            kv_state['risk'] = kv_get('trading:risk_config')
    grant_staged, policy_staged = False, 0
    serving = {'url': live['url']}

    def health(url):
        reply = read_until_200(lambda: request(url.rstrip('/') + '/health'))
        if reply['http_status'] != 200:
            raise RuntimeError('controller_health_http_' + str(reply['http_status']))
        return reply['body']

    def paper(url, artifact=None):
        result = request(url.rstrip('/') + '/research_validation/production_bundle',
            headers={'X-Controller-Token': os.environ['ML_CONTROLLER_SECRET']})
        if result['http_status'] != 200:
            raise RuntimeError('paper_bundle_http_failure')
        verify_paper_runtime(result['body'])
        if artifact:
            save(artifact, result['body'])
        return result['body']

    def unchanged_policies(full_grants=False):
        if use_kv:
            if kv_get('trading:config') != kv_state['config']:
                raise RuntimeError('trading_configuration_changed')
            if full_grants and kv_get(admission['prior_key']) != kv_state['prior']:
                raise RuntimeError('prior_grant_changed')
            if full_grants and grant_staged and kv_get(admission['new_key']) != {'http_status': 200, 'body': grant}:
                raise RuntimeError('new_grant_changed')
            if policy_grants and kv_get('trading:risk_config') != kv_state['risk']:
                raise RuntimeError('risk_configuration_changed')
            staged = list(zip(admission.get('policy_keys', []), policy_grants))[:policy_staged]
            for key, policy_grant in staged if full_grants else []:
                if kv_get(key) != {'http_status': 200, 'body': policy_grant}:
                    raise RuntimeError('policy_grant_changed:' + key)
        elif full_grants:
            # No KV in controller CD: the serving controller re-derives its configuration from KV and
            # must still match the grant it runs under (status PASS, no drift fields).
            paper(serving['url'])
        current_worker = read_until_200(lambda: worker('/api/health'))
        if current_worker['http_status'] != 200 or current_worker['body'].get('provenance') != worker_provenance:
            raise RuntimeError('concurrent_worker_change')

    def boundary(label, idle=True, wait=timedelta(0)):
        compare(expected_inventory, inventory())
        unchanged_policies(full_grants=label in ('initial', 'before-traffic', 'final'))
        if not idle:
            return None
        save('expected-runtime.json', expected_inventory)
        wait_until = time.monotonic() + wait.total_seconds()
        while True:
            result = idle_inspect(OUT / 'expected-runtime.json', source=source, release_sha=packet['source_sha'])
            if result['idle'] or time.monotonic() >= wait_until:
                break
            print('Waiting for active work: ' + json.dumps({k: sorted(result[k]) for k in ('busy_functions', 'active_jobs')}), flush=True)
            time.sleep(60)
        save('activity-' + label + '.json', result)
        if not result['idle']:
            raise RuntimeError('active_work_requires_preservation:' + label)
        return result

    def accept_own_change(resources):
        current = inventory()
        protected_before = {k: v for k, v in expected_inventory['components'].items() if k not in resources}
        protected_after = {k: v for k, v in current['components'].items() if k not in resources}
        if protected_before != protected_after:
            raise RuntimeError('concurrent_protected_component_change')
        for resource in resources:
            expected_inventory['components'][resource] = current['components'][resource]

    ready = boundary('initial', wait=idle_wait)
    build = json.loads(gc('builds', 'describe', load(build_start)['id'], '--region=asia-east2', '--format=json'))
    if build.get('substitutions', {}).get('_SOURCE_CONTEXT_SHA256') != packet['context_sha256']:
        raise RuntimeError('pinned_build_context_mismatch')
    image = packet['image'].rsplit(':', 1)[0] + '@' + build['results']['images'][0]['digest']
    verify(build, image=image, source_sha=packet['source_sha'], tree_sha=packet['tree'], project=PROJECT,
           service_account='stockvision-cloudrun-builder@' + PROJECT + '.iam.gserviceaccount.com')
    expected_steps = load(build_dir / 'cloudbuild.json')['steps']

    def expanded(value):
        if isinstance(value, str):
            for key, replacement in build.get('substitutions', {}).items():
                value = value.replace('${' + key + '}', replacement).replace('$' + key, replacement)
            return value
        if isinstance(value, list):
            return [expanded(item) for item in value]
        if isinstance(value, dict):
            return {key: expanded(item) for key, item in value.items()}
        return value
    expected_steps = expanded(expected_steps)
    if len(build.get('steps', [])) != len(expected_steps) or any(
            actual.get('status') != 'SUCCESS' or any(actual.get(key) != value for key, value in expected.items())
            for expected, actual in zip(expected_steps, build['steps'])):
        raise RuntimeError('pinned_build_steps_or_linux_probe_mismatch')
    save('verified-build.json', build)
    before = resumed_before if resume_staged else service()
    referenced, listed_jobs = read_live_inventory(gc, region='asia-east1', service='ml-controller')
    verify_ownership(controller_env=referenced, live_jobs=listed_jobs, expected_image=image)
    jobs_before = {name: job(name) for name in JOBS}
    if container(before, 'service')['image'] != packet['base_image']:
        raise RuntimeError('controller_base_image_drift')
    snapshot = load(admission_dir / 'baseline.json')
    for name, value in jobs_before.items():
        old = snapshot['jobs'][name]
        if (sha(json.dumps(value['spec'], sort_keys=True).encode()) != old['spec_sha256']
                or container(value, 'job')['image'] != old['image']):
            raise RuntimeError('job_individual_baseline_drift:' + name)

    # Preserve the current bootstrap, never a date/path copied from a prior rollout.
    values = env_map(container(before, 'service'))
    bootstrap = values.get('FINLAB_DAILY_HISTORY_BOOTSTRAP_REF', {}).get('value')
    bucket_name = values.get('GCS_BUCKET_NAME', {}).get('value') or os.environ.get('GCS_BUCKET_NAME')
    bootstrap_source = {'kind': 'fresh_live_service_env'}
    from_receipts = not bootstrap
    if from_receipts:
        history = ready['modal_history']
        bootstrap, _, _ = prior_bootstrap(prior, baseline['components']['modal/stockvision-ml'], history)
        bootstrap_source = dict(kind='receipt_store_previous_modal_release', modal_version=history['Version'],
                                source_sha=history['Tag'], receipt_attempt=prior.get('attempt'))
    if not bootstrap or not bucket_name:
        raise RuntimeError('live_bootstrap_or_bucket_missing')
    reference = validate_bootstrap_ref(bootstrap)
    # The receipt store is writable by runtime service accounts: the reference must match the
    # git-committed anchor, and the object is always re-hashed in full (no generation shortcut).
    anchor = require_bootstrap_anchor(source, reference, required=from_receipts)
    blob_meta = json.loads(gc('storage', 'objects', 'describe', 'gs://' + bucket_name + '/' + reference['path'], '--format=json'))
    generation = str(blob_meta.get('generation', ''))
    if not generation.isdigit():
        raise RuntimeError('bootstrap_generation_missing')
    stream = subprocess.Popen([GC, 'storage', 'cat', 'gs://' + bucket_name + '/' + reference['path'] + '#' + generation,
                               '--project=' + PROJECT], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    digest, size = hashlib.sha256(), 0
    while chunk := stream.stdout.read(8 * 1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    stream.communicate(timeout=60)
    if stream.returncode != 0 or digest.hexdigest() != reference['sha256']:
        raise RuntimeError('live_bootstrap_checksum_mismatch')
    verification = dict(reference=reference, generation=generation, bytes=size, status='PASS',
                        verification='fresh full SHA256 read', git_anchor=anchor)
    save('bootstrap-verification.json', dict(verification, raw_ref=bootstrap, source=bootstrap_source), durable=True)
    policy = json.loads(gc('storage', 'buckets', 'get-iam-policy', 'gs://' + bucket_name, '--format=json'))
    runtime_sa = before['spec']['template']['spec'].get('serviceAccountName')
    if not runtime_sa or not any(row.get('role') == 'roles/storage.objectAdmin' and not row.get('condition')
            and 'serviceAccount:' + runtime_sa in row.get('members', []) for row in policy.get('bindings', [])):
        raise RuntimeError('guard_runtime_sa_unconditional_object_admin_not_proven')
    save('guard-iam-verification.json', dict(status='PASS', bucket=bucket_name, runtime_service_account=runtime_sa,
        role='roles/storage.objectAdmin', condition=None, policy_sha256=sha(json.dumps(policy, sort_keys=True).encode()),
        iam_changed=False, guard_state_written=False))

    rollback = dict(service_revision=live['traffic'][0]['revisionName'], service_image=container(before, 'service')['image'],
        service_source={k: values[k].get('value') for k in SOURCE_KEYS if k in values},
        jobs={name: dict(image=container(value, 'job')['image'],
            source={k: row.get('value') for k, row in env_map(container(value, 'job')).items() if k in SOURCE_KEYS},
            spec_sha256=sha(json.dumps(value['spec'], sort_keys=True).encode())) for name, value in jobs_before.items()},
        modal_history=ready['modal_history'], modal_provenance=baseline['components']['modal/stockvision-ml'])
    save('rollback.json', rollback, durable=True)
    boundary('before-grant')
    mutation_gate(datetime.now(timezone.utc), observed_at=observed_at, deadline=deadline, release_sha=packet['source_sha'],
                  remote_sha=(git('ls-remote', 'origin', 'refs/heads/' + packet['branch']).split() or [''])[0])

    def kv_put(key, value, label):
        url = ('https://api.cloudflare.com/client/v4/accounts/' + os.environ['CF_ACCOUNT_ID']
               + '/storage/kv/namespaces/' + os.environ['CF_KV_NAMESPACE_ID'] + '/values/' + quote(key, safe=''))
        reply = request(url, method='PUT', body=value, headers={'Authorization': 'Bearer ' + os.environ['CF_API_TOKEN']})
        if reply['http_status'] != 200 or reply['body'].get('success') is not True:
            raise RuntimeError(label + '_write_unconfirmed:' + key)

    if new_grant:
        existing = kv_get(admission['new_key'])
        if existing['http_status'] == 404:
            kv_put(admission['new_key'], grant, 'new_source_grant')
        elif existing != {'http_status': 200, 'body': grant}:
            raise RuntimeError('new_source_grant_collision')
        if kv_get(admission['new_key']) != {'http_status': 200, 'body': grant}:
            raise RuntimeError('new_source_grant_readback_mismatch')
        grant_staged = True
        unchanged_policies(full_grants=True)
        save('source-grant-readback.json', dict(key=admission['new_key'], checksum=grant['approval_checksum'],
            status='PASS', prior_grant_unchanged=True, configuration_changed=False, source_equivalence=False, maturity_transfer=False))
        for key, policy_grant in zip(admission.get('policy_keys', []), policy_grants):
            existing = kv_get(key)
            if existing['http_status'] == 404:
                kv_put(key, policy_grant, 'policy_grant')
            elif existing != {'http_status': 200, 'body': policy_grant}:
                raise RuntimeError('policy_grant_collision:' + key)
            if kv_get(key) != {'http_status': 200, 'body': policy_grant}:
                raise RuntimeError('policy_grant_readback_mismatch:' + key)
            policy_staged += 1
            unchanged_policies(full_grants=True)
        if policy_grants:
            save('policy-grants-readback.json', dict(status='PASS', grants=[
                dict(key=key, checksum=g['approval_checksum']) for key, g in zip(admission['policy_keys'], policy_grants)],
                configuration_changed=False, selected_only_after_activation=True, maturity_transfer=False))

    suffix = 'perf-' + packet['source_sha'][:12] + '-' + datetime.now(timezone.utc).strftime('%H%M%S')
    revision, tag = 'ml-controller-' + suffix, 'perf-' + packet['source_sha'][:12]
    if resume_staged:
        revision = failed_stage['revision']
        tags = [row.get('tag') for row in service()['status']['traffic']
                if row.get('revisionName') == revision and row.get('tag') == tag]
        if tags != [tag]:
            raise RuntimeError('exact_staged_release_tag_missing')
    envarg = ','.join(key + '=' + value for key, value in updates.items())
    flags = ['--image=' + image, '--update-env-vars=' + envarg,
             '--update-labels=stockvision-source-sha=' + packet['source_sha'] + ',stockvision-provenance-schema=v1']
    receipt = dict(status='staging', started_at=now(), source_sha=packet['source_sha'], tree=packet['tree'], image=image,
                   revision=revision, build_id=build['id'], build_mode=packet['build_mode'], admission_mode=admission['mode'],
                   base_image=packet['base_image'], base_source_sha=packet['base_source_sha'], models_invoked=0,
                   chain_dispatched=False, comparison_kind='optimistic_before_and_after_not_atomic_provider_CAS')
    if resume_staged:
        archive = OUT / 'controller-release-attempt1.json'
        if archive.exists():
            raise RuntimeError('prior_stage_receipt_already_archived_reconcile')
        archive.write_bytes((OUT / 'controller-release.json').read_bytes())
        receipt['resumed_existing_staged_revision'] = True
    save('controller-release.json', receipt, durable=True)
    staged_snapshot = None
    job_snapshots, attempted_jobs = {}, []
    modal_attempted = False

    def modal_provenance():
        return modal.Function.from_name('stockvision-ml', 'deployment_provenance').remote()

    def modal_wait(expected):
        for attempt in range(8):
            actual = modal_provenance()
            if actual == expected:
                return actual
            if attempt < 7:
                time.sleep(3)
        raise RuntimeError('modal_source_mismatch')

    try:
        boundary('before-stage')
        if not resume_staged:
            gc('run', 'services', 'update', 'ml-controller', '--region=asia-east1', *flags,
               '--revision-suffix=' + suffix, '--no-traffic', '--tag=' + tag, '--quiet')
        staged_snapshot = service()
        assert_source_only(before, staged_snapshot, 'service', image, updates)
        verify_traffic(staged_snapshot, rollback['service_revision'])
        candidate = next(row['url'] for row in staged_snapshot['status']['traffic']
            if row.get('revisionName') == revision and row.get('tag') == tag)
        verify_health(health(candidate), expected_health)
        paper(candidate, 'candidate-paper.json')
        accept_own_change({'services/ml-controller'})
        boundary('before-modal')
        env = {**os.environ, **updates, 'STOCKVISION_MODAL_REPO_ROOT': str(source), 'PYTHONPATH': str(source / 'ml-service'),
               'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1', 'GCS_BUCKET_NAME': bucket_name,
               'FINLAB_DAILY_HISTORY_BOOTSTRAP_REF': bootstrap}
        for key in ('FINLAB_API_KEY', 'FINLAB_REFRESH_TOKEN', 'FINLAB_SESSION_ID'):
            env.pop(key, None)
        modal_attempted = True
        with (OUT / 'modal-deploy.log').open('w', encoding='utf-8') as log:
            result = subprocess.run([python, '-m', 'modal', 'deploy', '--tag', packet['source_sha'],
                '--strategy', 'rolling', 'modal_app.py'], cwd=source / 'ml-service', env=env,
                stdout=log, stderr=subprocess.STDOUT, timeout=900)
        if result.returncode:
            raise RuntimeError('modal_deploy_failed')
        modal_wait(expected_modal)
        save('modal-release.json', dict(status='verified', provenance=expected_modal, bootstrap_preserved=True,
                                        verification_method='fresh_exact_deployment_provenance', completed_at=now()),
             durable=True)
        accept_own_change({'modal/stockvision-ml'})
        # These independent templates share identical source-only updates.
        # Retain fresh batch boundaries and complete per-template comparisons.
        from concurrent.futures import ThreadPoolExecutor
        boundary('before-jobs')

        def update_owned_job(name):
            if job(name)['spec'] != jobs_before[name]['spec']:
                raise RuntimeError('concurrent_job_change:' + name)
            gc('run', 'jobs', 'update', name, '--region=asia-east1', *flags, '--quiet')
            after = job(name)
            assert_source_only(jobs_before[name], after, 'job', image, updates)
            return name, after
        attempted_jobs.extend(JOBS)
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(update_owned_job, name) for name in JOBS]
            failures = []
            for future in futures:
                try:
                    name, after = future.result()
                    job_snapshots[name] = after
                except BaseException as error:
                    failures.append(error)
            if failures:
                raise failures[0]
        accept_own_change({'jobs/' + name for name in JOBS})
        boundary('before-traffic')
        referenced, listed_jobs = read_live_inventory(gc, region='asia-east1', service='ml-controller')
        verified_jobs = verify_inventory(controller_env=referenced, live_jobs=listed_jobs,
            expected_image=image, expected_sha=packet['source_sha'])
        save('application-job-acceptance.json', dict(status='verified', jobs=verified_jobs,
            independently_listed_jobs=len(listed_jobs), completed_at=now()))
        current = service()
        if configuration(current, 'service') != configuration(staged_snapshot, 'service'):
            raise RuntimeError('concurrent_service_change_before_traffic')
        verify_traffic(current, rollback['service_revision'])
        gc('run', 'services', 'update-traffic', 'ml-controller', '--region=asia-east1', '--to-revisions=' + revision + '=100', '--quiet')
        live_after = service()
        assert_source_only(before, live_after, 'service', image, updates)
        verify_traffic(live_after, revision)
        staged_snapshot = live_after
        verify_health(health(live_after['status']['url']), expected_health)
        paper(live_after['status']['url'], 'live-paper.json')
        serving['url'] = live_after['status']['url']
        accept_own_change({'services/ml-controller'})
        boundary('final')
        save('runtime-after.json', expected_inventory)
        receipt.update(status='verified', completed_at=now(), paper_runtime='PASS', native_owner=packet['native_owner'],
                       configuration_changed=False, bootstrap_preserved=True, jobs=list(JOBS))
        save('controller-release.json', receipt, durable=True, strict=False)
        return {key: receipt[key] for key in ('status', 'source_sha', 'revision', 'image', 'chain_dispatched')}
    except BaseException as error:
        # Never clobber a concurrent owner. Reconcile ambiguous CLI completion
        # by comparing its complete expected source-only result before rollback.
        errors, reverted = [], []
        receipt.update(status='failed', failed_at=now(), error_type=type(error).__name__, error=str(error)[:300])
        save('controller-release.json', receipt, durable=True, strict=False)
        try:
            current = service()
            if configuration(current, 'service') != configuration(before, 'service'):
                assert_source_only(before, current, 'service', image, updates)
                if staged_snapshot is not None and configuration(current, 'service', traffic=False) != configuration(staged_snapshot, 'service', traffic=False):
                    raise RuntimeError('concurrent_service_change_blocks_rollback')
                routed = [row for row in current['status']['traffic'] if row.get('percent', 0)]
                if any(row['revisionName'] not in (revision, rollback['service_revision']) for row in routed):
                    raise RuntimeError('concurrent_traffic_change_blocks_rollback')
                gc('run', 'services', 'update-traffic', 'ml-controller', '--region=asia-east1',
                   '--to-revisions=' + rollback['service_revision'] + '=100', '--quiet')
                verify_traffic(service(), rollback['service_revision'])
                reverted.append('service-traffic')
        except BaseException as exc:
            errors.append(dict(component='service-traffic', error_type=type(exc).__name__, reason=str(exc)[:160]))
        for name in reversed(attempted_jobs):
            try:
                current = job(name)
                if configuration(current, 'job') == configuration(jobs_before[name], 'job'):
                    continue
                assert_source_only(jobs_before[name], current, 'job', image, updates)
                if name in job_snapshots and configuration(current, 'job') != configuration(job_snapshots[name], 'job'):
                    raise RuntimeError('concurrent_job_change_blocks_rollback')
                gc('run', 'jobs', 'update', name, '--region=asia-east1', *source_restore_flags(jobs_before[name], 'job'), '--quiet')
                if configuration(job(name), 'job') != configuration(jobs_before[name], 'job'):
                    raise RuntimeError('job_rollback_configuration_mismatch')
                reverted.append('jobs/' + name)
            except BaseException as exc:
                errors.append(dict(component='jobs/' + name, error_type=type(exc).__name__, reason=str(exc)[:160]))
        if modal_attempted:
            try:
                actual = modal_provenance()
                if actual != rollback['modal_provenance']:
                    if actual != expected_modal:
                        raise RuntimeError('concurrent_modal_change_blocks_rollback')
                    # Reconcile our own versions before the existing full idle
                    # gate; never bypass active functions/jobs during rollback.
                    current_inventory = inventory()
                    permitted = {'services/ml-controller', 'modal/stockvision-ml'} | {'jobs/' + name for name in attempted_jobs}
                    if ({k: v for k, v in current_inventory['components'].items() if k not in permitted}
                            != {k: v for k, v in expected_inventory['components'].items() if k not in permitted}):
                        raise RuntimeError('concurrent_protected_change_blocks_modal_rollback')
                    save('rollback-idle-baseline.json', current_inventory)
                    if not idle_inspect(OUT / 'rollback-idle-baseline.json', source=source, release_sha=packet['source_sha'])['idle']:
                        raise RuntimeError('active_work_blocks_modal_rollback')
                    subprocess.run([python, '-m', 'modal', 'app', 'rollback', 'stockvision-ml',
                                    rollback['modal_history']['Version']], check=True, timeout=180)
                    modal_wait(rollback['modal_provenance'])
                    reverted.append('modal/stockvision-ml')
            except BaseException as exc:
                errors.append(dict(component='modal/stockvision-ml', error_type=type(exc).__name__, reason=str(exc)[:160]))
        try:
            current = service()
            if configuration(current, 'service', traffic=False) != configuration(before, 'service', traffic=False):
                assert_source_only(before, current, 'service', image, updates)
                gc('run', 'services', 'update', 'ml-controller', '--region=asia-east1',
                   *source_restore_flags(before, 'service'), '--revision-suffix=' + suffix + '-rb', '--no-traffic', '--quiet')
                restored = service()
                if configuration(restored, 'service', traffic=False) != configuration(before, 'service', traffic=False):
                    raise RuntimeError('service_rollback_configuration_mismatch')
                verify_traffic(restored, rollback['service_revision'])
                reverted.append('service-template')
            # Remove only this attempt's tag; preserve the previously observed
            # tags and routing. An unrelated tag is a concurrent owner change.
            current = service()
            original_tags = {row['tag']: row.get('revisionName') for row in before['status']['traffic'] if row.get('tag')}
            current_tags = {row['tag']: row.get('revisionName') for row in current['status']['traffic'] if row.get('tag')}
            if {k: v for k, v in current_tags.items() if k != tag} != original_tags:
                raise RuntimeError('concurrent_service_tag_change_blocks_rollback')
            if tag in current_tags:
                if current_tags[tag] != revision:
                    raise RuntimeError('concurrent_release_tag_retarget_blocks_rollback')
                gc('run', 'services', 'update-traffic', 'ml-controller', '--region=asia-east1', '--remove-tags=' + tag, '--quiet')
            restored = service()
            verify_traffic(restored, rollback['service_revision'])
            if canonical_container(container(restored, 'service')) != canonical_container(container(before, 'service')):
                raise RuntimeError('final_service_rollback_container_mismatch')
            if restored.get('metadata', {}).get('labels', {}) != before.get('metadata', {}).get('labels', {}):
                raise RuntimeError('final_service_rollback_labels_mismatch')
        except BaseException as exc:
            errors.append(dict(component='service-template', error_type=type(exc).__name__, reason=str(exc)[:160]))
        receipt.update(rollback_status='requires_reconciliation' if errors else 'verified', reverted=reverted,
                       rollback_errors=errors, new_source_grant_retained=grant_staged, prior_grant_unchanged=True)
        save('controller-release.json', receipt, durable=True, strict=False)
        raise RuntimeError('controller_modal_release_failed_see_receipt') from None
