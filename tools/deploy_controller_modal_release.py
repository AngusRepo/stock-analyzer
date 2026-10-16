"""Reviewed component rollout; run explicitly by the release owner.

Uses the existing gcloud rollout protocol with optimistic comparisons before
each mutation and complete configuration checks afterwards. It is not a
provider-atomic CAS. Never dispatches a chain/job, clears a fence or grants IAM.
Secrets and complete runtime specs remain in process memory.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote

# Reuse the reviewed rollout protocol with an explicit, fresh evidence directory.
OUT = None
ROOT = None
SOURCE_KEYS = ('STOCKVISION_SOURCE_SHA', 'STOCKVISION_SOURCE_TREE_SHA',
               'STOCKVISION_SOURCE_BRANCH', 'STOCKVISION_SCHEDULER_MANIFEST_SHA256')
SOURCE_LABELS = ('stockvision-source-sha', 'stockvision-provenance-schema')
from application_job_inventory import application_jobs, read_live_inventory, verify_inventory, verify_ownership
JOBS = application_jobs()
AUTO_ANNOTATIONS = {'run.googleapis.com/client-name', 'run.googleapis.com/client-version',
                    'run.googleapis.com/operation-id'}


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


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


def main():
    global OUT, ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, required=True)
    parser.add_argument('--workspace-root', type=Path, required=True)
    parser.add_argument('--packet', type=Path, default=None)
    parser.add_argument('--build-start', type=Path, default=None)
    parser.add_argument('--admission', type=Path, default=None)
    parser.add_argument('--bootstrap-receipt', type=Path)
    parser.add_argument('--bootstrap-receipt-sha256')
    parser.add_argument('--previous-modal-release', type=Path)
    parser.add_argument('--previous-modal-release-sha256')
    parser.add_argument('--resume-staged', action='store_true')
    args = parser.parse_args()
    OUT, ROOT = args.release_dir.resolve(), args.workspace_root.resolve()
    args.packet = args.packet or OUT / 'build-preparation/deployment-build-packet.json'
    args.build_start = args.build_start or OUT / 'build-preparation/build-start.json'
    args.admission = args.admission or OUT / 'admission'
    failed_stage = load(OUT / 'controller-release.json') if args.resume_staged else None
    if failed_stage is not None and (failed_stage.get('status') != 'failed'
            or failed_stage.get('models_invoked') != 0 or (OUT / 'modal-release.json').exists()):
        raise RuntimeError('resume_requires_exact_pre_modal_failed_stage')
    if not args.resume_staged and (OUT / 'controller-release.json').exists():
        raise RuntimeError('release_attempt_exists_reconcile_before_rerun')
    components = load(OUT / 'component-commits.json')['components']
    source = Path(components[0]['source'])
    python = ROOT / 'ml-service/.venv/Scripts/python.exe'
    sys.path[:0] = [str(ROOT / 'audits/pipeline-nightly-20261013'),
                   str(ROOT / 'audits/daily-chain-performance-20261015'), str(source / 'tools')]
    os.environ['CLOUDSDK_PYTHON'] = str(python)
    from runtime_context import load_environment, kv_get, request, worker, GC, PROJECT
    from release_guard import inventory, compare
    from verify_prebuilt_release import verify
    from verify_cloud_run_release import verify_health, verify_paper_runtime, verify_traffic
    import performance_preflight
    import modal

    def gc(*argv):
        return subprocess.check_output([GC, *argv, '--project=' + PROJECT], timeout=600)

    def git(*argv):
        return subprocess.check_output(['git', '-C', str(source), *argv], timeout=60).decode('utf-8').strip()

    def service():
        return json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=asia-east1', '--format=json'))

    def job(name):
        return json.loads(gc('run', 'jobs', 'describe', name, '--region=asia-east1', '--format=json'))

    packet = load(args.packet)
    if git('status', '--porcelain', '--untracked-files=no') or git('rev-parse', 'HEAD') != packet['source_sha']:
        raise RuntimeError('source_not_clean_final_head')
    if git('rev-parse', 'HEAD^{tree}') != packet['tree'] or git('branch', '--show-current') != packet['branch']:
        raise RuntimeError('source_tree_or_branch_mismatch')
    remote = git('ls-remote', 'origin', 'refs/heads/' + packet['branch']).split()
    if len(remote) != 2 or remote[0] != packet['source_sha']:
        raise RuntimeError('source_remote_branch_not_final_head')
    updates = dict(zip(SOURCE_KEYS, (packet['source_sha'], packet['tree'], packet['branch'], packet['scheduler_sha256'])))
    if any(',' in value or '\n' in value for value in updates.values()):
        raise RuntimeError('invalid_source_env_argument')
    expected_modal = dict(schema_version='stockvision-modal-deployment-provenance-v1', source_sha=packet['source_sha'],
        tree_sha=packet['tree'], source_branch=packet['branch'], scheduler_manifest_sha256=packet['scheduler_sha256'])
    expected_health = dict(sourceSha=packet['source_sha'], sourceTreeSha=packet['tree'],
        sourceBranch=packet['branch'], schedulerManifestSha256=packet['scheduler_sha256'])
    baseline = load(OUT / 'runtime-before.json')
    expected_inventory = copy.deepcopy(baseline)
    config_before = load(OUT / 'config-before.json')
    live = load_environment()
    if live['source_sha'] != (packet['source_sha'] if args.resume_staged else packet['base_source_sha']):
        raise RuntimeError('live_controller_source_drift')
    resumed_before = None
    if args.resume_staged:
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
        baseline_hash = load(args.admission / 'baseline.json')['service_spec_sha256']
        if sha(json.dumps(resumed_before['spec'], sort_keys=True).encode()) != baseline_hash:
            raise RuntimeError('original_service_spec_cannot_be_exactly_reconstructed')
        assert_source_only(resumed_before, staged_now, 'service', failed_stage['image'], updates)
        verify_traffic(staged_now, old['service_revision'])
        current_inventory = inventory()
        if {k: v for k, v in current_inventory['components'].items() if k != 'services/ml-controller'} != {
                k: v for k, v in baseline['components'].items() if k != 'services/ml-controller'}:
            raise RuntimeError('protected_runtime_changed_since_failed_stage')
        expected_inventory['components']['services/ml-controller'] = current_inventory['components']['services/ml-controller']
        save('staged-resume-reconciliation.json', dict(status='PASS', original_spec_sha256=baseline_hash,
             exact_original_spec_reconstructed=True, reused_revision=failed_stage['revision'], image_rebuilt=False,
             models_invoked=0, chain_dispatched=False))
    worker_before = worker('/api/health')
    if worker_before['http_status'] != 200:
        raise RuntimeError('worker_health_unavailable')
    worker_provenance = worker_before['body']['provenance']
    admission = load(args.admission / 'admission-receipt.json')
    grant = load(args.admission / 'source-grant.json')
    if (admission['new_key'] != packet['grant_key'] or admission['approval_checksum'] != packet['grant_approval_checksum']
            or admission['prior_key'] == admission['new_key'] or grant['approval_checksum'] != admission['approval_checksum']):
        raise RuntimeError('new_source_grant_packet_mismatch')
    os.environ['NATIVE_PAPER_RUNNER'] = str(args.admission / 'native-paper.cjs')
    if sha(Path(os.environ['NATIVE_PAPER_RUNNER']).read_bytes()) != packet['native_bundle_sha256']:
        raise RuntimeError('native_bundle_checksum_mismatch')
    sys.path.insert(0, str(source / 'ml-controller'))
    from services.active8_paper_admission import validate_runtime_approval
    validate_runtime_approval(grant, grant['admission'])
    prior_before = kv_get(admission['prior_key'])
    if prior_before['http_status'] != 200 or prior_before['body']['approval_checksum'] != admission['prior_approval_checksum']:
        raise RuntimeError('prior_grant_preflight_mismatch')
    grant_staged = False

    def unchanged_policies(full_grants=False):
        if kv_get('trading:config') != {'http_status': 200, 'body': config_before}:
            raise RuntimeError('trading_configuration_changed')
        if full_grants and kv_get(admission['prior_key']) != prior_before:
            raise RuntimeError('prior_grant_changed')
        if full_grants and grant_staged and kv_get(admission['new_key']) != {'http_status': 200, 'body': grant}:
            raise RuntimeError('new_grant_changed')
        current_worker = worker('/api/health')
        if current_worker['http_status'] != 200 or current_worker['body'].get('provenance') != worker_provenance:
            raise RuntimeError('concurrent_worker_change')

    performance_preflight.OUT, performance_preflight.SOURCE = OUT, source
    def settled_inventory():
        value = inventory()
        time.sleep(2)  # Metadata provenance call must settle before the activity read.
        return value
    performance_preflight.inventory = settled_inventory

    def boundary(label, idle=True):
        compare(expected_inventory, inventory())
        unchanged_policies(full_grants=label in ('initial', 'before-traffic', 'final'))
        if idle:
            save('expected-runtime.json', expected_inventory)
            result = performance_preflight.inspect(OUT / 'expected-runtime.json')
            save('activity-' + label + '.json', result)
            return result

    def accept_own_change(resources):
        current = inventory()
        protected_before = {k: v for k, v in expected_inventory['components'].items() if k not in resources}
        protected_after = {k: v for k, v in current['components'].items() if k not in resources}
        if protected_before != protected_after:
            raise RuntimeError('concurrent_protected_component_change')
        for resource in resources:
            expected_inventory['components'][resource] = current['components'][resource]

    ready = boundary('initial')
    build = json.loads(gc('builds', 'describe', load(args.build_start)['id'], '--region=asia-east1', '--format=json'))
    if build.get('substitutions', {}).get('_SOURCE_CONTEXT_SHA256') != packet['context_sha256']:
        raise RuntimeError('pinned_build_context_mismatch')
    image = packet['image'].rsplit(':', 1)[0] + '@' + build['results']['images'][0]['digest']
    verify(build, image=image, source_sha=packet['source_sha'], tree_sha=packet['tree'], project=PROJECT,
           service_account='stockvision-cloudrun-builder@' + PROJECT + '.iam.gserviceaccount.com')
    expected_steps = load(args.packet.parent / 'cloudbuild.json')['steps']
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
    before = resumed_before if args.resume_staged else service()
    referenced, listed_jobs = read_live_inventory(gc, region='asia-east1', service='ml-controller')
    verify_ownership(controller_env=referenced, live_jobs=listed_jobs, expected_image=image)
    jobs_before = {name: job(name) for name in JOBS}
    if container(before, 'service')['image'] != packet['base_image']:
        raise RuntimeError('controller_base_image_drift')
    snapshot = load(args.admission / 'baseline.json')
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
    if not bootstrap:
        if not all((args.bootstrap_receipt, args.bootstrap_receipt_sha256,
                    args.previous_modal_release, args.previous_modal_release_sha256)):
            raise RuntimeError('explicit_bootstrap_and_deployment_receipts_required')
        if (sha(args.bootstrap_receipt.read_bytes()) != args.bootstrap_receipt_sha256
                or sha(args.previous_modal_release.read_bytes()) != args.previous_modal_release_sha256):
            raise RuntimeError('bootstrap_receipt_sha_mismatch')
        previous_modal = load(args.previous_modal_release)
        history = ready['modal_history']
        if (previous_modal.get('status') != 'verified' or previous_modal.get('bootstrap_preserved') is not True
                or previous_modal.get('provenance') != baseline['components']['modal/stockvision-ml']
                or history.get('Tag') != packet['base_source_sha']):
            raise RuntimeError('bootstrap_receipt_not_bound_to_current_modal_release')
        deployed_at = datetime.fromisoformat(history['Time deployed'])
        verified_at = datetime.fromisoformat(previous_modal['completed_at'])
        if abs((verified_at - deployed_at).total_seconds()) > 300:
            raise RuntimeError('bootstrap_receipt_deployment_time_mismatch')
        inspected = load(args.bootstrap_receipt)
        bootstrap = json.loads(inspected['raw'].strip())['daily_history_bootstrap_ref']
        bootstrap_source = dict(kind='explicit_current_modal_deployment_receipts',
            capture_receipt=str(args.bootstrap_receipt), capture_sha256=args.bootstrap_receipt_sha256,
            deployment_receipt=str(args.previous_modal_release), deployment_sha256=args.previous_modal_release_sha256,
            modal_version=history['Version'], source_sha=history['Tag'])
    if not bootstrap or not bucket_name:
        raise RuntimeError('live_bootstrap_or_bucket_missing')
    reference = validate_bootstrap_ref(bootstrap)
    # gcloud object read is authenticated as the operator, while IAM proof below
    # names the actual runtime service account rather than the operator.
    blob_meta = json.loads(gc('storage', 'objects', 'describe', 'gs://' + bucket_name + '/' + reference['path'], '--format=json'))
    generation = str(blob_meta.get('generation', ''))
    if not generation.isdigit():
        raise RuntimeError('bootstrap_generation_missing')
    bootstrap_process = subprocess.Popen([GC, 'storage', 'cat', 'gs://' + bucket_name + '/' + reference['path'] + '#' + generation,
                                          '--project=' + PROJECT], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    digest, size = hashlib.sha256(), 0
    while chunk := bootstrap_process.stdout.read(8 * 1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    bootstrap_process.communicate(timeout=30)
    if bootstrap_process.returncode != 0 or digest.hexdigest() != reference['sha256']:
        raise RuntimeError('live_bootstrap_checksum_mismatch')
    save('bootstrap-verification.json', dict(reference=reference, generation=generation, bytes=size,
                                           source=bootstrap_source, status='PASS'))
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
    save('rollback.json', rollback)
    boundary('before-grant')
    existing = kv_get(admission['new_key'])
    if existing['http_status'] == 404:
        url = ('https://api.cloudflare.com/client/v4/accounts/' + os.environ['CF_ACCOUNT_ID']
               + '/storage/kv/namespaces/' + os.environ['CF_KV_NAMESPACE_ID'] + '/values/' + quote(admission['new_key'], safe=''))
        reply = request(url, method='PUT', body=grant, headers={'Authorization': 'Bearer ' + os.environ['CF_API_TOKEN']})
        if reply['http_status'] != 200 or reply['body'].get('success') is not True:
            raise RuntimeError('new_source_grant_write_unconfirmed')
    elif existing != {'http_status': 200, 'body': grant}:
        raise RuntimeError('new_source_grant_collision')
    if kv_get(admission['new_key']) != {'http_status': 200, 'body': grant}:
        raise RuntimeError('new_source_grant_readback_mismatch')
    grant_staged = True
    unchanged_policies(full_grants=True)
    save('source-grant-readback.json', dict(key=admission['new_key'], checksum=grant['approval_checksum'],
        status='PASS', prior_grant_unchanged=True, configuration_changed=False, source_equivalence=False, maturity_transfer=False))

    suffix = 'perf-' + packet['source_sha'][:12] + '-' + datetime.now(timezone.utc).strftime('%H%M%S')
    revision, tag = 'ml-controller-' + suffix, 'perf-' + packet['source_sha'][:12]
    if args.resume_staged:
        revision = failed_stage['revision']
        tags = [row.get('tag') for row in service()['status']['traffic']
                if row.get('revisionName') == revision and row.get('tag') == tag]
        if tags != [tag]:
            raise RuntimeError('exact_staged_release_tag_missing')
    envarg = ','.join(key + '=' + value for key, value in updates.items())
    flags = ['--image=' + image, '--update-env-vars=' + envarg,
             '--update-labels=stockvision-source-sha=' + packet['source_sha'] + ',stockvision-provenance-schema=v1']
    receipt = dict(status='staging', started_at=now(), source_sha=packet['source_sha'], tree=packet['tree'], image=image,
                   revision=revision, build_id=build['id'], models_invoked=0, chain_dispatched=False,
                   comparison_kind='optimistic_before_and_after_not_atomic_provider_CAS')
    if args.resume_staged:
        archive = OUT / 'controller-release-attempt1.json'
        if archive.exists():
            raise RuntimeError('prior_stage_receipt_already_archived_reconcile')
        archive.write_bytes((OUT / 'controller-release.json').read_bytes())
        receipt['resumed_existing_staged_revision'] = True
    save('controller-release.json', receipt)
    staged_snapshot = None
    job_snapshots, attempted_jobs = {}, []
    modal_attempted = False

    def paper(url, artifact):
        result = request(url.rstrip('/') + '/research_validation/production_bundle',
            headers={'X-Controller-Token': os.environ['ML_CONTROLLER_SECRET']})
        if result['http_status'] != 200:
            raise RuntimeError('paper_bundle_http_failure')
        verify_paper_runtime(result['body'])
        save(artifact, result['body'])

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
        if not args.resume_staged:
            gc('run', 'services', 'update', 'ml-controller', '--region=asia-east1', *flags,
               '--revision-suffix=' + suffix, '--no-traffic', '--tag=' + tag, '--quiet')
        staged_snapshot = service()
        assert_source_only(before, staged_snapshot, 'service', image, updates)
        verify_traffic(staged_snapshot, rollback['service_revision'])
        candidate = next(row['url'] for row in staged_snapshot['status']['traffic']
            if row.get('revisionName') == revision and row.get('tag') == tag)
        verify_health(request(candidate + '/health')['body'], expected_health)
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
            result = subprocess.run([str(python), '-m', 'modal', 'deploy', '--tag', packet['source_sha'],
                '--strategy', 'rolling', 'modal_app.py'], cwd=source / 'ml-service', env=env,
                stdout=log, stderr=subprocess.STDOUT, timeout=600)
        if result.returncode:
            raise RuntimeError('modal_deploy_failed')
        modal_wait(expected_modal)
        save('modal-release.json', dict(status='PASS', provenance=expected_modal, bootstrap_preserved=True, completed_at=now()))
        accept_own_change({'modal/stockvision-ml'})
        for name in JOBS:
            boundary('before-job-' + name, idle=False)
            if job(name)['spec'] != jobs_before[name]['spec']:
                raise RuntimeError('concurrent_job_change:' + name)
            attempted_jobs.append(name)
            gc('run', 'jobs', 'update', name, '--region=asia-east1', *flags, '--quiet')
            after = job(name)
            assert_source_only(jobs_before[name], after, 'job', image, updates)
            job_snapshots[name] = after
            accept_own_change({'jobs/' + name})
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
        verify_health(request(live_after['status']['url'] + '/health')['body'], expected_health)
        paper(live_after['status']['url'], 'live-paper.json')
        accept_own_change({'services/ml-controller'})
        boundary('final')
        save('runtime-after.json', expected_inventory)
        receipt.update(status='verified', completed_at=now(), paper_runtime='PASS', native_owner=packet['native_owner'],
                       configuration_changed=False, bootstrap_preserved=True, jobs=list(JOBS))
        save('controller-release.json', receipt)
        print(json.dumps({key: receipt[key] for key in ('status', 'source_sha', 'revision', 'image', 'chain_dispatched')}))
    except BaseException as error:
        # Never clobber a concurrent owner. Reconcile ambiguous CLI completion
        # by comparing its complete expected source-only result before rollback.
        errors, reverted = [], []
        receipt.update(status='failed', failed_at=now(), error_type=type(error).__name__)
        save('controller-release.json', receipt)
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
                    performance_preflight.inspect(OUT / 'rollback-idle-baseline.json')
                    subprocess.run([str(python), '-m', 'modal', 'app', 'rollback', 'stockvision-ml',
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
                       rollback_errors=errors, new_source_grant_retained=True, prior_grant_unchanged=True)
        save('controller-release.json', receipt)
        raise RuntimeError('controller_modal_release_failed_see_receipt') from None


if __name__ == '__main__':
    main()
