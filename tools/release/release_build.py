"""Full build of the release commit's own root Dockerfile, plus the offline Linux probe.

Port of audits/rf-rehearsal3-20261025/release/prepare_build.py + submit_build.py +
deploy_when_build_passes.py (Cloud Build dd946430 PASS, 8m20s):
- context = the committed bytes (git archive, blob-id checked) of every path the commit's
  Dockerfile COPYs, plus its .dockerignore; a missing COPY source fails closed;
- recipe = the commit's Dockerfile byte-for-byte;
- the probe checks the exact runtime files, the /app/worker-dist/src .js set, the constraints,
  the native owner and (new-grant mode) the source grant inside the built image, then imports
  the native pipeline members, the pipeline graph and every production module this release
  changed (generated from the source, no per-release hand list).
Dropped (E-2 plan): the frozen offline acceptance envelope (test-wheels / node_modules copied from
old audits) and its regression step. The same-SHA ci gate plus image.yml replace it; the build has
two steps (docker build, probe).
Submit uses --gcs-source-staging-dir (the deploy SA has no project-level storage.buckets.list),
--async, then `builds describe` polling (no log streaming: no logging.viewer).
"""
from __future__ import annotations

import ast
from datetime import datetime, timezone
import fnmatch
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import time

from release_admission import MANIFEST_PATHS, MANIFESTS, git, runtime_baseline, save, sha
from runtime_context import GC, PROJECT, kv_available

BUILD_REGION = 'asia-east2'
STAGING = f'gs://{PROJECT}_cloudbuild/source'
TIMEOUT = '2400s'
WAIT_POLLS, WAIT_SECONDS = 180, 15  # 45 min: queueing plus a from-scratch apt/pip/npm/tsc build
PIPELINE_ENTRY = ('graphs.daily_pipeline_v2',)

PROBE = '''import gzip,hashlib,importlib,json,math,sys
from pathlib import Path
sys.path.insert(0,'/app')
p=json.loads(Path('/audit/probe-plan.json').read_bytes())
assert p['build_mode']=='full'
for name,checksum in p['runtime_files'].items():
    assert hashlib.sha256(Path('/app',name).read_bytes()).hexdigest()==checksum, 'exact_source_mismatch:'+name
# new-grant: the image's own Linux esbuild output must reproduce the approved (locally built) bundle.
# reuse: no new bundle was approved; the native owner check below covers the bundle bytes.
if p.get('native_bundle_sha256'):
    assert hashlib.sha256(Path('/app/worker-dist/native-paper.cjs').read_bytes()).hexdigest()==p['native_bundle_sha256'], 'linux_native_bundle_not_reproduced'
root=Path('/app/worker-dist/src')
actual={x.relative_to(root).as_posix() for x in root.rglob('*.js')}
expected=set(p['worker_dist_src_js'])
assert actual==expected, 'worker_dist_src_mismatch:missing=%s:extra=%s'%(sorted(expected-actual)[:5],sorted(actual-expected)[:5])
atomic=Path('/app/worker-dist/atomic-population.cjs')
assert atomic.is_file() and atomic.stat().st_size>0, 'atomic_population_bundle_missing'
import importlib.metadata as md,re
norm=lambda n:re.sub(r'[-_.]+','-',n).lower()
want=dict((norm(l.split('==')[0]),l.split('==')[1]) for l in (x.split('#',1)[0].strip() for x in Path('/app/constraints.txt').read_text(encoding='utf-8').splitlines()) if l)
got={norm(d.metadata['Name']):d.version for d in md.distributions()}
drift=sorted(k for k in (want.keys()|got.keys())-{'pip','setuptools','wheel'} if want.get(k)!=got.get(k))
assert not drift, 'python_packages_differ_from_constraints:'+','.join(drift[:10])
from services.native_paper_sandbox import native_execution_identity
assert native_execution_identity()==p['native_owner'], 'linux_native_owner_mismatch'
if Path('/audit/source-grant.json').exists():
    from services.active8_paper_admission import validate_runtime_approval
    grant=json.loads(Path('/audit/source-grant.json').read_bytes())
    validate_runtime_approval(grant,grant['admission'])
from services.pipeline_json_transport import iter_json_bytes,compress_json
from services.strict_json_clone import strict_json_clone
sample={'中文':'台股😀','rows':[{'x':i,'z':-0.0} for i in range(40)],'tuple':(1,2)}
expected=json.dumps(sample,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
assert b''.join(iter_json_bytes(sample,sort_keys=True,allow_nan=False))==expected
wire,size,digest=compress_json(sample,sort_keys=True)
assert gzip.decompress(wire)==expected and size==len(expected) and digest==hashlib.sha256(expected).hexdigest()
assert strict_json_clone(sample)==json.loads(expected)
try: strict_json_clone({'bad':math.nan})
except ValueError: pass
else: raise AssertionError('strict_nonfinite_accepted')
from services.pipeline_async_state_transport import (STATE_SCHEMA_V2,STATE_SCHEMA_V3,
    build_pipeline_payload_identity,encode_pipeline_state_envelope,decode_pipeline_state_envelope)
common={'market_history':[{'close':1.0}],'nested':{'source':'fixture'}}
state={'market_env':common,'trading_config':{'paper':True},'payloads':[]}
state['payloads']=[{'symbol':symbol,'market_env':common,'trading_config':state['trading_config']}
                  for symbol in ('fixture-a','fixture-b')]
state['pipeline_payload_identity']=build_pipeline_payload_identity(state['payloads'])
from services.pipeline_async_state_transport import validate_pipeline_payload_identity
validate_pipeline_payload_identity(state)
raw=encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':state})
assert json.loads(gzip.decompress(raw))['schema_version']==STATE_SCHEMA_V3
restored=decode_pipeline_state_envelope(raw)
assert restored['schema_version']==STATE_SCHEMA_V2
assert restored['state']['payloads'][0]['market_env'] is restored['state']['market_env']
assert restored['state']['payloads'][1]['trading_config'] is restored['state']['trading_config']
for name in p['import_modules']: importlib.import_module(name)
print(json.dumps({'status':'FULL_BUILD_EXACT_SOURCE_WORKER_DIST_STRICT_WIRE_V3_NATIVE_IMPORTS_PASS',
 'source_sha':p['source_sha'],'native_owner':p['native_owner'],'files':len(p['runtime_files']),
 'worker_dist_src_js':len(p['worker_dist_src_js']),'imports':len(p['import_modules']),
 'cloud_requests':0,'models_invoked':0,'chain_dispatched':False}))
'''

# Exact tsconfig shape the expected worker-dist set is derived from; any change needs review.
WORKER_TSCONFIG_SCOPE = dict(include=['src/**/*.ts', 'src/**/*.d.ts'],
                             exclude=['src/**/*.test.ts', 'src/**/*.testSupport.ts'])


def production(path: str) -> bool:
    parts = Path(path).parts
    return (path.startswith('ml-controller/') and 'tests' not in parts and '__pycache__' not in parts
            and not path.endswith(('.md', '.log', '.xml', '.pyc', '.ipynb')))


def dockerfile_copies(text: str) -> list[tuple[list[str], str]]:
    """(sources, destination) of every COPY; ADD, --from and JSON form fail closed."""
    instructions, current = [], ''
    for line in text.splitlines():
        stripped = line.strip()
        if not current and (not stripped or stripped.startswith('#')):
            continue
        if stripped.endswith('\\'):
            current += stripped[:-1] + ' '
            continue
        instructions.append(current + stripped)
        current = ''
    if current:
        raise RuntimeError('dockerfile_unterminated_continuation')
    copies = []
    for instruction in instructions:
        keyword, _, rest = instruction.partition(' ')
        keyword = keyword.upper()
        if keyword == 'ADD':
            raise RuntimeError('dockerfile_add_requires_review')
        if keyword != 'COPY':
            continue
        if rest.lstrip().startswith('['):
            raise RuntimeError('dockerfile_copy_json_form_requires_review')
        tokens = shlex.split(rest)
        if any(token.startswith('--from') for token in tokens):
            raise RuntimeError('dockerfile_copy_from_stage_requires_review')
        tokens = [token for token in tokens if not token.startswith('--')]
        if len(tokens) < 2:
            raise RuntimeError('dockerfile_copy_unparsed:' + instruction)
        copies.append((tokens[:-1], tokens[-1]))
    if not copies:
        raise RuntimeError('dockerfile_has_no_copy')
    return copies


def copy_matches(pattern: str, path: str) -> bool:
    """Docker COPY source semantics: a pattern matching a file, or a directory containing it."""
    segments = [s for s in pattern.split('/') if s not in ('', '.')]
    if not segments or '..' in segments:
        raise RuntimeError('dockerfile_copy_source_requires_review:' + pattern)
    parts = path.split('/')
    return len(parts) >= len(segments) and all(fnmatch.fnmatchcase(p, s) for p, s in zip(parts, segments))


def git_blob_id(raw: bytes) -> str:
    import hashlib
    return hashlib.sha1(b'blob %d\0' % len(raw) + raw).hexdigest()


def long_path(path: Path) -> str:
    # Windows MAX_PATH; the context holds deep worker/src paths.
    return '\\\\?\\' + str(path) if os.name == 'nt' else str(path)


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


def module_name(path: str) -> str | None:
    """Importable dotted name inside /app for a production controller .py file, else None."""
    if not production(path) or not path.endswith('.py'):
        return None
    relative = path.removeprefix('ml-controller/')[:-3]
    parts = relative.split('/')
    if parts[-1] == '__init__':
        parts = parts[:-1]
    if not parts:
        return None
    if len(parts) == 1:
        # Top-level: only job entry modules; main.py builds the app and is exercised by Cloud Run itself.
        return parts[0] if parts[0].endswith('_job_main') else None
    if parts[0] not in ('services', 'routers', 'graphs'):
        return None
    return '.'.join(parts)


def import_modules(native_source: str, changed_paths: list[str]) -> list[str]:
    names = {'services.' + name[:-3] for name in native_pipeline_members(native_source)}
    names |= set(PIPELINE_ENTRY)
    names |= {m for m in map(module_name, changed_paths) if m}
    return sorted(names)


def cloudbuild_config(image: str, commit: str, tree: str, context_sha: str) -> dict:
    return dict(images=[image], timeout=TIMEOUT,
        serviceAccount=f'projects/{PROJECT}/serviceAccounts/stockvision-cloudrun-builder@{PROJECT}.iam.gserviceaccount.com',
        options=dict(logging='CLOUD_LOGGING_ONLY', machineType='E2_HIGHCPU_8', diskSizeGb=100),
        substitutions={'_SOURCE_SHA': commit, '_SOURCE_TREE_SHA': tree, '_SOURCE_CONTEXT_SHA256': context_sha}, steps=[
            dict(name='gcr.io/cloud-builders/docker', args=['build', '--pull', '--label', 'stockvision.source=$_SOURCE_SHA',
                 '--label', 'stockvision.tree=$_SOURCE_TREE_SHA', '--label', 'stockvision.context=$_SOURCE_CONTEXT_SHA256', '-t', image, 'context']),
            dict(name='gcr.io/cloud-builders/docker', args=['run', '--rm', '--network', 'none', '--read-only',
                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '4', '--memory', '4g',
                 '--tmpfs', '/tmp:rw,size=512m', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'HOME=/tmp',
                 '-v', '/workspace:/audit:ro', '--entrypoint', 'python', image, '/audit/probe.py'])])


def prepare(source: Path, admission: Path, out: Path, expected_live: str) -> dict:
    """Prepare the build packet; reads runtime state, never writes it."""
    if out.exists():
        raise RuntimeError('output_exists_choose_new_directory_to_preserve_receipts')
    if git(source, 'status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('tracked_source_dirty_before_build')
    commit, tree = git(source, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD^{tree}')
    branch = git(source, 'branch', '--show-current')
    remote = git(source, 'ls-remote', 'origin', 'refs/heads/' + branch).split() if branch else []
    if not branch or not remote or remote[0] != commit:
        raise RuntimeError('release_source_not_pushed_exact_branch_head')
    approved = json.loads((admission / 'admission-receipt.json').read_bytes())
    mode = approved['mode']
    subsequent = set(git(source, 'diff', '--name-only', approved['preparation_source_sha'], commit).splitlines())
    if mode == 'reuse' and approved['preparation_source_sha'] != commit:
        raise RuntimeError('reuse_admission_is_for_another_commit')
    if not subsequent.issubset(MANIFEST_PATHS):
        raise RuntimeError('unreviewed_source_changed_after_admission_preparation')
    for name in MANIFESTS:
        if sha(git(source, 'show', f'{commit}:ml-controller/services/{name}', raw=True)) != approved['manifest_sha256'][name]:
            raise RuntimeError('committed_release_manifest_drift')
    if mode == 'new-grant' and sha((admission / 'native-paper.cjs').read_bytes()) != approved['native_bundle_sha256']:
        raise RuntimeError('approved_native_bundle_drift')
    baseline = runtime_baseline(source, expected_live)
    prior = json.loads((admission / 'baseline.json').read_bytes())
    if baseline['service_spec_sha256'] != prior['service_spec_sha256'] or baseline['jobs'] != prior['jobs']:
        raise RuntimeError('runtime_drift_since_admission_reprepare')
    if mode == 'new-grant':
        if not kv_available():
            raise RuntimeError('new_grant_build_needs_operator_kv_read')
        from runtime_context import kv_get
        if kv_get(approved['new_key'])['http_status'] != 404:
            raise RuntimeError('grant_already_staged_reinspect_before_build')
        if kv_get(approved['prior_key'])['body']['approval_checksum'] != approved['prior_approval_checksum']:
            raise RuntimeError('prior_grant_drift')
    live = baseline['source_sha']
    deleted = git(source, 'diff', '--no-renames', '--name-only', '--diff-filter=D', live, commit, '--', 'ml-controller/').splitlines()
    if any(production(name) for name in deleted):
        raise RuntimeError('controller_source_deletion_requires_separate_review')
    # A requirements change needs its own review; constraints.txt must be unchanged since the live
    # source, or, on the first full build after E-3 (#70), be the one read from the live image.
    if git(source, 'show', f'{live}:ml-controller/requirements.txt', raw=True) != git(source, 'show', f'{commit}:ml-controller/requirements.txt', raw=True):
        raise RuntimeError('dependency_release_not_authorized_by_source_release')
    constraints = git(source, 'show', f'{commit}:ml-controller/constraints.txt', raw=True)
    live_has_constraints = 'ml-controller/constraints.txt' in git(source, 'ls-tree', '-r', '--name-only', live, 'ml-controller/').splitlines()
    if live_has_constraints:
        if git(source, 'show', f'{live}:ml-controller/constraints.txt', raw=True) != constraints:
            raise RuntimeError('dependency_constraints_changed_requires_separate_review')
    elif baseline['image'].split('@', 1)[1].encode() not in constraints:
        raise RuntimeError('dependency_constraints_not_read_from_live_image')

    dockerfile = git(source, 'show', f'{commit}:Dockerfile', raw=True)
    dockerignore = git(source, 'show', f'{commit}:.dockerignore', raw=True)
    copies = dockerfile_copies(dockerfile.decode('utf-8'))
    tracked = {}
    for row in git(source, 'ls-tree', '-r', '-z', '--full-tree', commit, raw=True).decode('utf-8').split('\0'):
        if row:
            meta, path = row.split('\t', 1)
            mode_bits, kind, oid = meta.split()
            tracked[path] = (mode_bits, kind, oid)
    selected = set()
    for sources, _ in copies:
        for pattern in sources:
            hit = {path for path in tracked if copy_matches(pattern, path)}
            if not hit:
                raise RuntimeError('dockerfile_copy_source_missing_from_context:' + pattern)
            selected |= hit
    for path in selected:
        if tracked[path][1] != 'blob' or tracked[path][0] not in ('100644', '100755'):
            raise RuntimeError('context_non_regular_file_requires_review:' + path)
    if {'Dockerfile', '.dockerignore'} & selected:
        raise RuntimeError('context_path_collides_with_recipe')
    roots = sorted({path.split('/', 1)[0] for path in selected})
    blobs = {}
    archived = subprocess.Popen(['git', '-C', str(source), 'archive', '--format=tar', commit, '--', *roots],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with tarfile.open(fileobj=archived.stdout, mode='r|') as archive:
        for member in archive:
            if member.isfile() and member.name in selected:
                raw = archive.extractfile(member).read()
                if git_blob_id(raw) != tracked[member.name][2]:
                    raise RuntimeError('git_archive_bytes_not_committed_blob:' + member.name)
                blobs[member.name] = raw
    # tarfile 'r|' leaves git's trailing record padding unread; drain it or git blocks on write.
    archived.stdout.read()
    error = archived.stderr.read()
    if archived.wait() != 0 or set(blobs) != selected:
        raise RuntimeError('committed_git_archive_incomplete:' + error.decode(errors='replace')[:200])
    context = out / 'context'
    context.mkdir(parents=True)
    for path, raw in sorted(blobs.items()):
        target = context / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(long_path(target), 'wb') as stream:
            stream.write(raw)
    (context / 'Dockerfile').write_bytes(dockerfile)
    (context / '.dockerignore').write_bytes(dockerignore)
    files = {path: sha(raw) for path, raw in blobs.items()}
    files['Dockerfile'], files['.dockerignore'] = sha(dockerfile), sha(dockerignore)

    # Runtime files the Linux probe checks byte-for-byte inside the built image.
    all_runtime = {}
    for path, raw in blobs.items():
        if not production(path):
            continue
        relative = path.removeprefix('ml-controller/')
        core = not relative.startswith(('scripts/', 'runbooks/', 'research_receipts/'))
        core |= relative in ('scripts/repair_active8_source_and_evaluation.py',
                             'scripts/repair_native_prestart.py', 'scripts/l4_distribution_refresh_job.py')
        if core and path.endswith(('.py', '.json', '.txt', '.cjs')):
            all_runtime[relative] = sha(raw)
    for sources, destination in copies:
        if len(sources) == 1 and sources[0] in blobs and destination.startswith('/app/') and not destination.endswith('/'):
            all_runtime[destination.removeprefix('/app/')] = sha(blobs[sources[0]])
    changed = git(source, 'diff', '--no-renames', '--name-only', '--diff-filter=ACM', live, commit, '--', 'ml-controller/').splitlines()
    changed_not_probed = sorted(name for name in changed if production(name)
                                and name.removeprefix('ml-controller/') not in all_runtime)

    tsconfig = json.loads(git(source, 'show', f'{commit}:worker/tsconfig.json', raw=True))
    options = tsconfig.get('compilerOptions', {})
    if ({k: tsconfig.get(k) for k in WORKER_TSCONFIG_SCOPE} != WORKER_TSCONFIG_SCOPE
            or options.get('allowJs') or tsconfig.get('files') or tsconfig.get('references') or tsconfig.get('extends')):
        raise RuntimeError('worker_tsconfig_scope_changed_review_expected_worker_dist')
    worker_js = sorted(path.removeprefix('worker/src/')[:-3] + '.js' for path in tracked
                       if path.startswith('worker/src/') and path.endswith('.ts')
                       and not path.endswith(('.d.ts', '.test.ts', '.testSupport.ts')))
    if not worker_js:
        raise RuntimeError('worker_dist_expected_set_empty')
    imports = import_modules(blobs['ml-controller/services/native_paper_sandbox.py'].decode('utf-8'), changed)
    plan = dict(build_mode='full', source_sha=commit, runtime_files=all_runtime, native_owner=approved['native_owner'],
                native_bundle_sha256=approved['native_bundle_sha256'], import_modules=imports,
                worker_dist_src_js=worker_js)
    (out / 'probe.py').write_text(PROBE, encoding='utf-8', newline='\n')
    save(out / 'probe-plan.json', plan)
    grant_sha = None
    if mode == 'new-grant':
        save(out / 'source-grant.json', json.loads((admission / 'source-grant.json').read_bytes()))
        grant_sha = sha((out / 'source-grant.json').read_bytes())
    context_sha = sha(json.dumps(dict(build_mode='full', files=files, recipe=dockerfile.decode('utf-8'),
                                      probe=PROBE, plan=plan, grant_sha256=grant_sha), sort_keys=True).encode())
    image = baseline['image'].split('@', 1)[0] + ':' + commit
    save(out / 'cloudbuild.json', cloudbuild_config(image, commit, tree, context_sha))
    (out / '.gcloudignore').write_text('.gcloudignore\n', encoding='utf-8', newline='\n')
    # base_image / base_source_sha name the live deployment being replaced (drift, rollback, resume).
    packet = dict(build_mode='full', admission_mode=mode, source_sha=commit, tree=tree, branch=branch, image=image,
        base_image=baseline['image'], base_source_sha=live, controller_source_sha=commit,
        context_files=files, dockerfile_sha256=sha(dockerfile), dockerignore_sha256=sha(dockerignore),
        changed_controller_files_not_probed=changed_not_probed, context_sha256=context_sha,
        scheduler_sha256=sha(git(source, 'show', f'{commit}:infra/gcp-scheduler-jobs.json', raw=True)),
        native_owner=approved['native_owner'], native_bundle_sha256=approved['native_bundle_sha256'],
        grant_key=approved['new_key'], grant_approval_checksum=approved.get('approval_checksum'),
        import_modules=len(imports), created_at=datetime.now(timezone.utc).isoformat(), preparation_only=True, cloud_writes=0)
    save(out / 'deployment-build-packet.json', packet)
    save(out / 'deploy-baseline.json', baseline)
    required = {'context/' + name for name in files} | {'probe.py', 'probe-plan.json', 'cloudbuild.json'}
    if grant_sha:
        required.add('source-grant.json')
    coverage = upload_coverage(out, required)
    save(out / 'upload-coverage.json', coverage)
    return {'status': 'prepared_not_submitted', 'build_mode': 'full', 'admission_mode': mode, 'source_sha': commit,
            'context_files': len(files), 'context_bytes': sum(len(raw) for raw in blobs.values()),
            'runtime_files_checked_by_linux_probe': len(all_runtime), 'worker_dist_src_js': len(worker_js),
            'import_modules': len(imports), 'changed_controller_files_not_probed': changed_not_probed,
            'native_owner': approved['native_owner'], 'cloud_writes': 0}


def upload_coverage(out: Path, required: set[str]) -> dict:
    """Local: what `gcloud builds submit` would upload must hold the whole context and probe inputs."""
    for _ in range(2):
        result = subprocess.run([GC, 'meta', 'list-files-for-upload'], cwd=out, capture_output=True,
                                text=True, encoding='utf8', timeout=300)
        if result.returncode != 0:
            raise RuntimeError('upload_listing_failed:' + result.stderr[-300:])
        uploaded = {name.replace('\\', '/').removeprefix('./') for name in result.stdout.splitlines()}
        missing = sorted(required - uploaded)
        if not missing:
            return {'status': 'PASS', 'files': len(required), 'missing': []}
        # Only a nested .gcloudignore may hide files; re-include them explicitly once.
        if not all(Path(name).name == '.gcloudignore' for name in missing):
            raise RuntimeError('build_upload_would_miss:' + ','.join(missing[:5]))
        with (out / '.gcloudignore').open('a', encoding='utf8') as stream:
            stream.write(''.join('!' + name + '\n' for name in missing))
    raise RuntimeError('build_upload_would_miss_after_reinclude')


def submit_args() -> list[str]:
    return ['builds', 'submit', '.', '--config=cloudbuild.json', '--region=' + BUILD_REGION,
            '--project=' + PROJECT, '--gcs-source-staging-dir=' + STAGING, '--async', '--format=json']


def submit(out: Path) -> dict:
    """Submit the prepared packet exactly once (Cloud Build write: needs approval / Wei go)."""
    if (out / 'build-start.json').exists():
        raise RuntimeError('build_already_submitted_reconcile')
    config = json.loads((out / 'cloudbuild.json').read_bytes())
    packet = json.loads((out / 'deployment-build-packet.json').read_bytes())
    if json.loads((out / 'upload-coverage.json').read_bytes())['status'] != 'PASS':
        raise RuntimeError('build_upload_coverage_not_verified')
    if (len(config['steps']) != 2 or packet['build_mode'] != 'full' or packet.get('rehearsal')
            or config['steps'][0]['args'][-1] != 'context' or config['timeout'] != TIMEOUT):
        raise RuntimeError('build_packet_shape_unexpected')
    env = {**os.environ, 'CLOUDSDK_PYTHON': os.environ.get('CLOUDSDK_PYTHON', sys.executable)}
    result = subprocess.run([GC, *submit_args()], cwd=out, capture_output=True, text=True, encoding='utf8',
                            timeout=600, env=env)
    (out / 'submission-stderr.log').write_text(result.stderr, encoding='utf8')
    if result.returncode != 0:
        raise RuntimeError('build_submit_failed:' + result.stderr[-500:])
    build = json.loads(result.stdout)
    save(out / 'build-start.json', build)
    return {'status': build['status'], 'id': build['id'], 'source': config['substitutions']['_SOURCE_SHA']}


def wait(out: Path, describe=None, sleep=time.sleep) -> dict:
    """Poll `builds describe` until SUCCESS; any other terminal status or the 45 min limit fails."""
    from runtime_context import gc
    build_id = json.loads((out / 'build-start.json').read_bytes())['id']
    describe = describe or (lambda: json.loads(gc('builds', 'describe', build_id, '--region=' + BUILD_REGION, '--format=json')))
    previous = None
    for _ in range(WAIT_POLLS):
        value = describe()
        if value['status'] != previous:
            print('Build status: ' + value['status'], flush=True)
            previous = value['status']
        if value['status'] == 'SUCCESS':
            save(out / 'build-result.json', value)
            return value
        if value['status'] not in ('QUEUED', 'WORKING', 'PENDING'):
            raise RuntimeError('pinned_build_not_successful:' + value['status'])
        sleep(WAIT_SECONDS)
    raise RuntimeError('build_wait_limit_preserve_existing_attempt')
