"""Admission: prove the live baseline and decide whether the release needs a new Paper grant.

Two modes (release.py admission):
- reuse: the release commit keeps both release manifests byte-identical to the live source, and
  its allocator / L3 source identities equal the manifest's approved_sources. The native owner is
  pinned by the same manifest and re-checked by the image build (Dockerfile native identity RUN)
  and the Linux probe, so the live runtime grant still covers the new source and nothing is
  written to KV. Read-only; this is the only mode controller CD runs.
- new-grant: the native identity, the policy chain or the allocator / L3 sources changed. It
  prepares a fresh source-only Paper grant locally (port of the rf-rehearsal3 prepare_admission),
  re-pins the two manifests in --source for a release PR, and never publishes the grant. Staging
  it in KV happens in rollout. Operator credentials only: CD fails closed (the controller deploy
  SA has no Cloudflare token, and the grant text is Wei's authorization).
PRIOR (live native bundle and components) comes from the receipt store, or --prior-dir for a
live release made before receipts existed.
"""
from __future__ import annotations

import ast
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import time

from application_job_inventory import application_jobs
from runtime_context import gc, in_cd, load_environment, request

JOBS = application_jobs()
SOURCE_ENV = ('STOCKVISION_SOURCE_SHA', 'STOCKVISION_SOURCE_TREE_SHA',
              'STOCKVISION_SOURCE_BRANCH', 'STOCKVISION_SCHEDULER_MANIFEST_SHA256')
MANIFESTS = ('native_execution_behavior_release.json', 'strategy_nav_source_release.json')
MANIFEST_PATHS = tuple('ml-controller/services/' + name for name in MANIFESTS)
GRANT_PREFIX = 'ml:active8:paper_runtime_approval:v1:'
# native_execution_identity() inputs besides its pipeline members (see new_grant's old_parts).
NATIVE_HOST = 'ml-controller/services/native_paper_sandbox.py'
NATIVE_RESCORE = 'ml-controller/routers/intraday.py'
NATIVE_ENTRY = 'worker/src/node-runner/nativePaperJobMain.ts'  # Dockerfile esbuild entry
NATIVE_RUNNER_DIR = 'worker/src/node-runner/'


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def git(source: Path, *args: str, raw: bool = False):
    result = subprocess.check_output(['git', '-C', str(source), *args], timeout=120)
    return result if raw else result.decode('utf-8').strip()


def save(path: Path, value) -> None:
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def runtime_baseline(source: Path, expected_live: str) -> dict:
    """Authenticated read-only metadata; credentials never enter return values."""
    live = load_environment()
    service = json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=asia-east1', '--format=json'))
    container = service['spec']['template']['spec']['containers'][0]
    source_env = {e['name']: e.get('value') for e in container['env'] if e['name'] in SOURCE_ENV}
    if live['source_sha'] != expected_live or source_env.get('STOCKVISION_SOURCE_SHA') != expected_live:
        raise RuntimeError('live_source_drift_reinspect_before_preparation')
    if source_env.get('STOCKVISION_SOURCE_TREE_SHA') != git(source, 'rev-parse', expected_live + '^{tree}'):
        raise RuntimeError('live_source_tree_does_not_match_git_object')
    if len(live['traffic']) != 1 or live['traffic'][0].get('percent') != 100 \
            or live['traffic'][0]['revisionName'] != live['latest_ready_revision']:
        raise RuntimeError('live_revision_not_single_verified_template')
    if '@sha256:' not in container['image']:
        raise RuntimeError('live_base_image_not_immutable')
    # followup #15: a transient non-200 /health retries twice; a 200 naming another source never does.
    for _ in range(3):
        health = request(live['url'] + '/health')
        if health['http_status'] == 200:
            break
        time.sleep(5)
    if health['http_status'] != 200 or health['body'].get('provenance', {}).get('sourceSha') != expected_live:
        raise RuntimeError('live_health_source_mismatch')
    paper = request(live['url'] + '/research_validation/production_bundle',
                    headers={'X-Controller-Token': os.environ['ML_CONTROLLER_SECRET']})
    if paper['http_status'] != 200 or paper['body'].get('status') != 'PASS':
        raise RuntimeError('live_paper_authority_not_verified')
    if not re.fullmatch('[a-f0-9]{64}', paper['body'].get('source_receipt_checksum', '')):
        raise RuntimeError('live_paper_source_receipt_missing')
    jobs = {}
    for name in JOBS:
        job = json.loads(gc('run', 'jobs', 'describe', name, '--region=asia-east1', '--format=json'))
        task = job['spec']['template']['spec']['template']['spec']
        c = task['containers'][0]
        jobs[name] = {'image': c['image'], 'source': {e['name']: e.get('value') for e in c.get('env', [])
                      if e['name'] in SOURCE_ENV}, 'service_account': task.get('serviceAccountName'),
                      'spec_sha256': sha(json.dumps(job['spec'], sort_keys=True).encode())}
    return {'observed_at': datetime.now(timezone.utc).isoformat(), 'source_sha': expected_live,
            'source_tree': live['source_tree'], 'url': live['url'], 'traffic': live['traffic'],
            'revision': live['latest_ready_revision'], 'image': container['image'], 'source': source_env,
            'service_account': service['spec']['template']['spec'].get('serviceAccountName'),
            'service_spec_sha256': sha(json.dumps(service['spec'], sort_keys=True).encode()),
            'paper': paper['body'], 'jobs': jobs}


IDENTITY_PROBE = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_recommendation_path import recommendation_source_identity
print(json.dumps({'allocator_source_identity': allocator_source_identity(),
                  'l3_inference_source_identity': recommendation_source_identity()}))
'''


def source_identities(source: Path, python: str = sys.executable) -> dict:
    """The allocator / L3 source identities of the checkout (needs ml-controller requirements)."""
    result = subprocess.run([python, '-I', '-c', IDENTITY_PROBE, str(source / 'ml-controller')],
                            capture_output=True, text=True, timeout=120, env={**os.environ, 'PYTHONUTF8': '1'})
    if result.returncode != 0:
        raise RuntimeError('source_identity_unverifiable:' + result.stderr.strip().splitlines()[-1][:200]
                           if result.stderr.strip() else 'source_identity_unverifiable')
    return json.loads(result.stdout)


def native_pipeline_members(native_source: str) -> list[str]:
    """The `pipeline` file names native_execution_identity() hashes, read from its source."""
    for node in ast.walk(ast.parse(native_source)):
        if isinstance(node, ast.FunctionDef) and node.name == 'native_execution_identity':
            for inner in ast.walk(node):
                if isinstance(inner, ast.Tuple) and len(inner.elts) > 5 and all(
                        isinstance(e, ast.Constant) and isinstance(e.value, str) and e.value.endswith('.py')
                        for e in inner.elts):
                    return [e.value for e in inner.elts]
    raise RuntimeError('native_pipeline_members_not_found')


class GitBlobs:
    """`git cat-file --batch` reader: rev:path -> bytes, or None when the path does not exist."""

    def __init__(self, source: Path):
        self.process = subprocess.Popen(['git', '-C', str(source), 'cat-file', '--batch'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def read(self, rev: str, path: str) -> bytes | None:
        self.process.stdin.write(f'{rev}:{path}\n'.encode('utf-8'))
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode('utf-8').split()
        if len(header) != 3:
            return None  # "<rev>:<path> missing"
        raw = self.process.stdout.read(int(header[2]))
        self.process.stdout.read(1)
        return raw if header[1] == 'blob' else None

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=30)


_TS_COMMENT = re.compile(r'/\*.*?\*/|(?<![:\w"\'`])//[^\n]*', re.S)
_TS_FROM = re.compile(r'\b(?:import|export)\s+(type\s+)?[\w$*{}\s,]*?\bfrom\s*[\'"]([^\'"]+)[\'"]', re.S)
_TS_SIDE_EFFECT = re.compile(r'\bimport\s*[\'"]([^\'"]+)[\'"]')
_TS_CALL = re.compile(r'\b(?:require|import)\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)')


def ts_relative_imports(text: str) -> list[str]:
    """Relative module specifiers a bundler follows (type-only imports are erased)."""
    text = _TS_COMMENT.sub('', text)
    specs = [m.group(2) for m in _TS_FROM.finditer(text) if not m.group(1)]
    specs += _TS_SIDE_EFFECT.findall(text) + _TS_CALL.findall(text)
    return [s for s in specs if s.startswith('.')]


def ts_closure(read, entry: str) -> set[str]:
    """Files reachable from entry over relative imports (superset of the esbuild inputs). An
    import that resolves to no file fails closed."""
    seen, queue = set(), [entry]
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        raw = read(path)
        if raw is None:
            raise RuntimeError('native_bundle_input_missing:' + path)
        seen.add(path)
        for spec in ts_relative_imports(raw.decode('utf-8')):
            base = posixpath.normpath(posixpath.join(posixpath.dirname(path), spec))
            stem = base[:-3] if base.endswith('.js') else base
            for candidate in (base, stem + '.ts', stem + '.tsx', base + '.ts', base + '.js', base + '/index.ts', base + '/index.js'):
                if candidate in seen or read(candidate) is not None:
                    queue.append(candidate)
                    break
            else:
                raise RuntimeError(f'native_bundle_import_unresolved:{path}:{spec}')
    return seen


def native_identity_inputs(blobs: GitBlobs, rev: str, bundle: bool) -> set[str]:
    """Repo paths native_execution_identity() hashes at rev (the inputs of the identity delta in
    new_grant): private host, rescore router, pipeline members and, with bundle, the native
    Paper bundle's source graph."""
    host = blobs.read(rev, NATIVE_HOST)
    if host is None:
        raise RuntimeError('native_host_missing:' + rev)
    inputs = {NATIVE_HOST, NATIVE_RESCORE}
    inputs |= {'ml-controller/services/' + name for name in native_pipeline_members(host.decode('utf-8'))}
    if bundle:
        inputs |= ts_closure(lambda path: blobs.read(rev, path), NATIVE_ENTRY)
    return inputs


def native_identity_changes(source: Path, live_sha: str, head: str) -> list[str]:
    changed = git(source, 'diff', '--name-only', live_sha, head).splitlines()
    bundle = any(path.startswith('worker/src/') for path in changed)
    blobs = GitBlobs(source)
    try:
        inputs = native_identity_inputs(blobs, live_sha, bundle) | native_identity_inputs(blobs, head, bundle)
    finally:
        blobs.close()
    return sorted(path for path in changed if path in inputs or path.startswith(NATIVE_RUNNER_DIR))


def classify(source: Path, live_sha: str, head: str, identities: dict | None = None) -> dict:
    """reuse when the release keeps the live grant valid; otherwise new-grant with the reasons.
    identities=None computes the allocator / L3 identities (needs the ml-controller requirements);
    'checked' means the CD plan job already compared them at this commit (the deploy job holding
    the OIDC token installs no controller requirements)."""
    reasons = []
    for path in MANIFEST_PATHS:
        if git(source, 'show', f'{live_sha}:{path}', raw=True) != git(source, 'show', f'{head}:{path}', raw=True):
            reasons.append('release_manifest_repinned:' + path.rsplit('/', 1)[1])
    native = native_identity_changes(source, live_sha, head)
    if native:
        reasons.append('native_identity_inputs_changed:' + ','.join(native[:8]) + (',...' if len(native) > 8 else ''))
    approved = json.loads(git(source, 'show', f'{head}:{MANIFEST_PATHS[1]}', raw=True))['approved_sources']
    if identities == 'checked':
        identities = approved
    elif identities is None:
        identities = source_identities(source)
    for name in ('allocator_source_identity', 'l3_inference_source_identity'):
        if identities.get(name) != approved.get(name):
            changed = sorted(k for k in set(identities.get(name, {})) | set(approved.get(name, {}))
                             if identities.get(name, {}).get(k) != approved.get(name, {}).get(k))
            reasons.append(f'{name}_differs_from_manifest:' + ','.join(changed[:8]))
    behavior = json.loads(git(source, 'show', f'{head}:{MANIFEST_PATHS[0]}', raw=True))
    return dict(mode='new-grant' if reasons else 'reuse', reasons=reasons,
                grant_key=behavior.get('runtime_admission'), native_owner=behavior.get('execution_owner_version'))


def require_clean_pushed_head(source: Path, branch_ref: str | None) -> str:
    if git(source, 'status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('tracked_source_dirty_before_admission')
    head = git(source, 'rev-parse', 'HEAD')
    if branch_ref:
        remote = git(source, 'ls-remote', 'origin', branch_ref).split()
        if not remote or remote[0] != head:
            raise RuntimeError('release_source_not_pushed_exact_branch_head')
    return head


def reuse(source: Path, out: Path, expected_live: str, native_receipt_sha: str | None = None,
          identities: dict | str | None = None) -> dict:
    """Read-only admission for a release that keeps the live Paper grant."""
    branch = git(source, 'branch', '--show-current')
    head = require_clean_pushed_head(source, 'refs/heads/' + branch if branch else None)
    if not branch:
        raise RuntimeError('release_source_detached_head')
    if subprocess.run(['git', '-C', str(source), 'merge-base', '--is-ancestor', expected_live, head]).returncode != 0:
        raise RuntimeError('live_source_not_ancestor_of_release')
    baseline = runtime_baseline(source, expected_live)
    decision = classify(source, expected_live, head, identities)
    if decision['mode'] != 'reuse':
        raise RuntimeError('identity_changing_release_requires_manual_new_grant:' + ';'.join(decision['reasons']))
    if not decision['grant_key'] or not decision['grant_key'].startswith(GRANT_PREFIX):
        raise RuntimeError('release_manifest_runtime_admission_invalid')
    services = {name: git(source, 'show', f'{head}:ml-controller/services/{name}', raw=True) for name in MANIFESTS}
    out.mkdir(parents=True)
    save(out / 'baseline.json', baseline)
    receipt = dict(mode='reuse', status='admitted_reuse_live_grant', prepared_at=datetime.now(timezone.utc).isoformat(),
                   preparation_source_sha=head, prior_key=decision['grant_key'], new_key=decision['grant_key'],
                   native_owner=decision['native_owner'], native_bundle_sha256=None, native_receipt_sha=native_receipt_sha,
                   manifest_sha256={name: sha(raw) for name, raw in services.items()},
                   production_baseline_source=expected_live, production_baseline_image=baseline['image'],
                   source_identities_checked_by='plan_job' if identities == 'checked' else 'admission',
                   policy_keys=[], cloud_writes=0, kv_reads=0, models_invoked=0, chain_dispatched=False)
    save(out / 'admission-receipt.json', receipt)
    return receipt


def native_parts(native):
    captured, original = [], native.digest
    try:
        native.digest = lambda value: captured.append(value) or original(value)
        owner = native.native_execution_identity()
    finally:
        native.digest = original
    if len(captured) != 1:
        raise RuntimeError('native_identity_shape_changed')
    return owner, captured[0]


def changed(before, after):
    return {k: {'previous': before.get(k), 'approved': after.get(k)}
            for k in sorted(before.keys() | after.keys()) if before.get(k) != after.get(k)}


def new_grant(source: Path, out: Path, expected_live: str, *, prior_bundle: bytes, prior_components: dict,
              new_bundle: Path, release_id: str, authorization: str, review: str,
              policy_chain: Path | None = None) -> dict:
    """Local only. Port of audits/rf-rehearsal3-20261025/release/prepare_admission.py."""
    if in_cd():
        raise RuntimeError('new_grant_admission_is_manual_only')
    if not re.fullmatch('[a-z0-9][a-z0-9-]{5,90}', release_id) or not authorization.strip():
        raise RuntimeError('explicit release id and human authorization are required')
    if git(source, 'diff', '--name-only', 'HEAD'):
        raise RuntimeError('tracked_source_dirty_before_admission')
    if out.exists():
        raise RuntimeError('output_exists_choose_new_directory_to_preserve_receipts')
    baseline = runtime_baseline(source, expected_live)
    sys.path.insert(0, str(source / 'ml-controller'))
    os.environ['NATIVE_PAPER_RUNNER'] = str(new_bundle.resolve())
    from runtime_context import kv_get
    from services import native_paper_sandbox as native
    from services.paired_nav_journal import digest
    from services.active8_nav_adoption import current_execution_configuration
    from services.active8_paper_admission import runtime_configuration_identity, validate_runtime_approval

    bundle_raw = new_bundle.read_bytes()
    if sha(prior_bundle) != prior_components['current']['bundle']:
        raise RuntimeError('existing_linux_bundle_checksum_mismatch')
    owner, parts = native_parts(native)
    if parts['bundle'] != sha(bundle_raw):
        raise RuntimeError('native_identity_does_not_use_new_bundle')
    old_parts = deepcopy(parts)
    old_parts['bundle'] = sha(prior_bundle)
    live_files = set(git(source, 'ls-tree', '--name-only', expected_live, 'ml-controller/services/').split())
    for name in list(old_parts['pipeline']):
        # A pipeline member added by this release is absent from the live owner; a removed one
        # still fails the live-owner proof below.
        if 'ml-controller/services/' + name not in live_files:
            del old_parts['pipeline'][name]
            continue
        old_parts['pipeline'][name] = sha(git(source, 'show', f'{expected_live}:ml-controller/services/{name}', raw=True))
    old_parts['private_host'] = sha(git(source, 'show', f'{expected_live}:ml-controller/services/native_paper_sandbox.py', raw=True))
    old_parts['rescore'] = sha(git(source, 'show', f'{expected_live}:ml-controller/routers/intraday.py', raw=True))
    live_behavior = json.loads(git(source, 'show', f'{expected_live}:{MANIFEST_PATHS[0]}', raw=True))
    if 'native-paper-v1:' + digest(old_parts) != live_behavior['execution_owner_version']:
        raise RuntimeError('existing_linux_bundle_does_not_prove_live_native_owner')
    prior_key = live_behavior['runtime_admission']
    prior_read = kv_get(prior_key)
    if prior_read['http_status'] != 200:
        raise RuntimeError('live_paper_grant_missing')
    prior = prior_read['body']
    if (prior.get('scope') != 'paper' or prior.get('approved') is not True
            or prior.get('efficacy_status') != 'unproven' or prior.get('maturity_transfer') is not False
            or prior.get('approval_checksum') != digest({k: v for k, v in prior.items() if k != 'approval_checksum'})):
        raise RuntimeError('live_paper_grant_invalid')
    key = GRANT_PREFIX + release_id
    if key == prior_key or kv_get(key)['http_status'] != 404:
        raise RuntimeError('new_grant_key_not_empty')
    chain = json.loads(policy_chain.read_bytes()) if policy_chain else []
    policy_keys = [key + '-p' + str(n) for n in range(1, len(chain) + 1)]
    if any(kv_get(name)['http_status'] != 404 for name in policy_keys):
        raise RuntimeError('policy_grant_key_not_empty')
    current = current_execution_configuration()
    before = runtime_configuration_identity(prior['configuration'])
    after = runtime_configuration_identity(current)
    if after['native_execution_policy']['execution_owner_version'] != owner:
        raise RuntimeError('new_native_owner_is_not_raw_exact_source_owner')
    source_delta = {name: changed(before[name], after[name]) for name in
                    ('allocator_source_identity', 'l3_inference_source_identity')}
    normalized = deepcopy(after)
    for name in source_delta:
        normalized[name] = before[name]
    normalized['native_execution_policy']['execution_owner_version'] = before['native_execution_policy']['execution_owner_version']
    if digest(normalized) != digest(before):
        raise RuntimeError('source_only_release_has_economic_or_policy_drift')
    manifest = dict(schema_version='strategy-nav-source-release-v1', scope='paper', source_equivalence=False,
        maturity_transfer=False, production_baseline_verified=True, production_baseline_source=baseline['source_sha'],
        production_baseline_receipt_checksum=baseline['paper']['source_receipt_checksum'],
        prior_approval_checksum=prior['approval_checksum'], prior_configuration_checksum=digest(before),
        approved_sources={k: current[k] for k in source_delta}, execution_owner_version=owner, review=review)
    services = source / 'ml-controller/services'
    originals = {name: (services / name).read_bytes() for name in MANIFESTS}
    behavior = json.loads(originals[MANIFESTS[0]])
    behavior.update(execution_owner_version=owner, runtime_admission=key, authorization=authorization,
                    review=review, source_equivalence=False, maturity_transfer=False, efficacy_status='unproven')
    behavior.pop('policy_runtime_admission', None)
    if chain:
        from services.l4_policy_activation import with_policy_activations
        manifest, behavior = with_policy_activations(manifest, behavior,
            chain=[packet['activation'] for packet in chain], keys=policy_keys)
    now = datetime.now(timezone.utc)
    grant = dict(schema_version=prior['schema_version'], admission=prior['admission'], scope='paper', approved=True,
        maturity_transfer=False, efficacy_status='unproven', source_reference=authorization, approved_at=now.isoformat(),
        configuration=current, prior_runtime_approval=prior,
        approved_strategy_nav_source_change={'release_manifest_checksum': digest(manifest)})
    grant['approval_checksum'] = digest(grant)
    out.mkdir(parents=True)
    save(out / 'baseline.json', baseline)
    save(out / 'identity-delta.json', {'allocator_and_l3': source_delta,
        'native_pipeline': changed(old_parts['pipeline'], parts['pipeline']),
        'native_bundle': {'previous': sha(prior_bundle), 'approved': sha(bundle_raw)},
        'previous_native_owner': live_behavior['execution_owner_version'],
        'new_native_owner': owner, 'economics_unchanged': True, 'source_equivalence': False, 'maturity_transfer': False})
    for name, raw in originals.items():
        (out / (name + '.before')).write_bytes(raw)
    try:
        for name, value in zip(MANIFESTS, (behavior, manifest)):
            (services / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
        validate_runtime_approval(grant, prior['admission'], now=now)
        again = runtime_baseline(source, expected_live)
        if again['service_spec_sha256'] != baseline['service_spec_sha256'] or again['jobs'] != baseline['jobs'] \
                or kv_get(prior_key) != prior_read or kv_get(key)['http_status'] != 404 \
                or any(kv_get(name)['http_status'] != 404 for name in policy_keys):
            raise RuntimeError('live_baseline_or_grant_drift_during_preparation')
        save(out / 'source-grant.json', grant)
        (out / 'native-paper.cjs').write_bytes(bundle_raw)
        save(out / 'native-components.json', {'previous': old_parts, 'current': parts, 'owner': owner})
        receipt = dict(mode='new-grant', status='local_only_prepared_not_published', prepared_at=now.isoformat(),
            preparation_source_sha=git(source, 'rev-parse', 'HEAD'), prior_key=prior_key, new_key=key,
            prior_approval_checksum=prior['approval_checksum'], approval_checksum=grant['approval_checksum'],
            release_manifest_checksum=digest(manifest), native_owner=owner, native_bundle_sha256=sha(bundle_raw),
            production_baseline_source=baseline['source_sha'], production_baseline_image=baseline['image'],
            manifest_sha256={name: sha((services / name).read_bytes()) for name in MANIFESTS},
            policy_keys=policy_keys, policy_chain_sha256=sha(policy_chain.read_bytes()) if chain else None,
            cloud_writes=0, models_invoked=0, chain_dispatched=False)
        save(out / 'admission-receipt.json', receipt)
    except BaseException:
        for name, raw in originals.items():
            (services / name).write_bytes(raw)
        raise
    return receipt
