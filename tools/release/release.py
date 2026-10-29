"""Controller + Modal release, one stage per subcommand (E-2). Linux (GitHub runner) and Windows.

  plan      [--choice changed|controller]      no credentials: prints controller=, live_sha=, gate_base=
  classify  --live <sha>                       no credentials, needs ml-controller requirements:
                                               prints identity=reuse|new-grant and the reasons
  admission --expected-live-source <sha> --out DIR [--new-grant ...]
  build     --out DIR [--submit] [--wait]      prepare the full-build packet; --submit/--wait write
  window                                       wait (no credentials) until a rollout can start
  rollout   --out DIR                          staged controller + Modal + jobs + traffic (writes)
  verify    --out DIR                          read back the live release; writes <sha>/current.json
  verify    --from-receipts --sha S [--attempt A] --out DIR
                                               the same, from a rollout's receipts in the store
                                               (a run whose verify step failed or was cancelled)
  seed-receipts ...                            one-time: publish receipts of a release made by hand

Stages share --out (out/admission, out/build, out/rollout, out/verify). With --publish (the
default in CD) each stage's directory is copied to gs://stockvision-models/release-receipts/
<sha>/<attempt>/ when the stage ends, pass or fail; the Docker context is not copied. The rollout
also copies its rollback anchor and every controller-release.json state the moment it saves them.
PRIOR comes from that store: the live Modal tag's verified rollout receipts (previous Modal
release + bootstrap), re-hashed against the digests in that release's current.json, and, for a
new-grant admission, the live native bundle.
Controller CD runs plan, classify, admission (reuse), build --submit --wait, window, rollout and
verify. A new-grant release (native identity inputs, policy chain or allocator/L3 sources change)
fails closed in CD and goes through the manual path with operator credentials and Wei's go.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import posixpath
import subprocess
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
ROOT = TOOLS.parent
for entry in (str(TOOLS), str(HERE)):  # tools/release first
    if entry not in sys.path:
        sys.path.insert(0, entry)

import release_admission as admission_stage  # noqa: E402
import release_build as build_stage  # noqa: E402
from deploy_units import TEST, git as repo_git, is_ancestor  # noqa: E402
from runtime_context import in_cd  # noqa: E402

CONTROLLER_HEALTH = 'https://ml-controller-530028717113.asia-east1.run.app/health'
STAGES = ('admission', 'build', 'rollout', 'verify')
DIGEST_STAGES = ('admission', 'build', 'rollout')
MODAL_APP = 'ml-service/modal_app.py'
# Receipts the next release reads; verify re-reads them from the store before writing current.json.
NEXT_RELEASE_READS = ('rollout/modal-release.json', 'rollout/bootstrap-verification.json', 'admission/admission-receipt.json')
# Saved by the rollout before traffic moves; a standalone verify rebuilds them from progress copies.
ROLLOUT_DURABLE = ('rollback.json', 'bootstrap-verification.json', 'modal-release.json', 'controller-release.json')


def _is_file_parent(node) -> bool:
    """Path(__file__).parent or Path(__file__).resolve().parent"""
    if not (isinstance(node, ast.Attribute) and node.attr == 'parent'):
        return False
    inner = node.value
    if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and inner.func.attr == 'resolve' and not inner.args:
        inner = inner.func.value
    return (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name) and inner.func.id == 'Path'
            and len(inner.args) == 1 and isinstance(inner.args[0], ast.Name) and inner.args[0].id == '__file__')


def modal_local_inputs(text: str, root_dirs=()) -> set[str]:
    """Repo paths the Modal image ships: every add_local_* / copy_local_* source of modal_app.py,
    resolved through its _LOCAL_* assignments. Anything else fails closed."""
    tree = ast.parse(text)
    assigns = {node.targets[0].id: node.value for node in tree.body
               if isinstance(node, ast.Assign) and len(node.targets) == 1
               and isinstance(node.targets[0], ast.Name) and node.targets[0].id.startswith('_LOCAL_')}

    def paths(node, depth=0) -> set[str]:
        if depth > 20:
            raise RuntimeError('modal_local_input_unrecognized:recursion')
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == 'str' and len(node.args) == 1 and not node.keywords:
                return paths(node.args[0], depth + 1)
            if node.func.id == '_resolve_local_repo_root' and not node.args:
                return {''}  # the checkout root (STOCKVISION_MODAL_REPO_ROOT in the rollout)
            if node.func.id == 'next' and len(node.args) == 2 and isinstance(node.args[0], ast.GeneratorExp):
                return paths(node.args[0].generators[0].iter, depth + 1) | paths(node.args[1], depth + 1)
        if isinstance(node, ast.Name) and node.id in assigns:
            return paths(assigns[node.id], depth + 1)
        if _is_file_parent(node):
            return {'ml-service'}
        if (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) and isinstance(node.right, ast.Constant)
                and isinstance(node.right.value, str) and '..' not in node.right.value.split('/')):
            return {posixpath.join(base, node.right.value) if base else node.right.value for base in paths(node.left, depth + 1)}
        if isinstance(node, ast.IfExp):
            return paths(node.body, depth + 1) | paths(node.orelse, depth + 1)
        if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
            return set().union(*(paths(item, depth + 1) for item in node.elts))
        if isinstance(node, ast.Subscript):
            return paths(node.value, depth + 1)  # the whole list: a superset
        raise RuntimeError(f'modal_local_input_unrecognized:{getattr(node, "lineno", "?")}')

    inputs, calls = set(), 0
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr.startswith(('add_local_', 'copy_local_'))):
            calls += 1
            source = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == 'local_path'), None)
            if source is None:
                raise RuntimeError(f'modal_local_input_unrecognized:{node.lineno}')
            inputs |= paths(source)
    if not calls or '' in inputs:
        raise RuntimeError('modal_local_inputs_not_found' if not calls else 'modal_local_input_is_repo_root')
    for node in ast.walk(tree):
        names = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                 else [node.module] if isinstance(node, ast.ImportFrom) and node.module and not node.level else [])
        for name in names:
            top = name.split('.')[0]
            if top in root_dirs and top not in inputs:
                raise RuntimeError('modal_import_not_shipped:' + name)
    return inputs


def modal_inputs(root: Path = ROOT) -> set[str]:
    dirs = {p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith('.')}
    return modal_local_inputs((root / MODAL_APP).read_text(encoding='utf-8'), dirs)


def controller_inputs_changed(changed: list[str], dockerfile: str, modal: set[str] = frozenset()) -> bool:
    """True if a changed path can alter the controller image or the Modal app shipped with it."""
    copies = build_stage.dockerfile_copies(dockerfile)
    for path in changed:
        if TEST.search(path) or path.endswith('.md'):
            continue
        if path in ('Dockerfile', '.dockerignore') or path.startswith('ml-service/'):
            return True
        if any(path == item or path.startswith(item + '/') for item in modal):
            return True
        if any(build_stage.copy_matches(pattern, path) for sources, _ in copies for pattern in sources):
            return True
    return False


def live_controller_sha(url: str = CONTROLLER_HEALTH) -> str:
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'stockvision-deploy-plan'})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    sha = (value.get('provenance') or {}).get('sourceSha') or ''
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        raise SystemExit('controller /health has no source sha; nothing can be diffed safely')
    return sha


def plan(choice: str, live: str | None = None) -> dict[str, str]:
    head = repo_git('rev-parse', 'HEAD')
    remote = repo_git('ls-remote', 'origin', 'refs/heads/main').split()[0]
    if remote != head:
        print(f'::notice::main moved to {remote}; leaving the deploy to that run', file=sys.stderr)
        return {'controller': 'false', 'live_sha': '', 'gate_base': ''}
    live = live or live_controller_sha()
    if live == head:
        return {'controller': 'false', 'live_sha': live, 'gate_base': ''}
    if not is_ancestor(live, head):
        # Admission diffs manifests and sources against live; a live build from outside main cannot be.
        raise SystemExit(f'live controller {live} is not an ancestor of main {head}; release it manually')
    changed = repo_git('diff', '--name-only', live, head).splitlines()
    dockerfile = (ROOT / 'Dockerfile').read_text(encoding='utf-8')
    deploy = choice == 'controller' or controller_inputs_changed(changed, dockerfile, modal_inputs())
    return {'controller': str(deploy).lower(), 'live_sha': live, 'gate_base': live if deploy else ''}


def attempt_id(out: Path) -> str:
    path = out / 'attempt.json'
    if path.exists():
        return json.loads(path.read_bytes())['attempt']
    if in_cd():
        value = 'gh-{}-{}'.format(os.environ['GITHUB_RUN_ID'], os.environ.get('GITHUB_RUN_ATTEMPT', '1'))
    else:
        value = 'local-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'attempt': value}) + '\n', encoding='utf-8')
    return value


def release_sha(args) -> str:
    return args.sha if getattr(args, 'from_receipts', False) else admission_stage.git(args.source, 'rev-parse', 'HEAD')


def publish(args, stage: str) -> None:
    """Receipts are keyed by the release commit. A new-grant admission runs before its release PR
    exists, so admission receipts are (re)published with the build stage, without clobbering."""
    if not args.publish:
        return
    import release_receipts as receipts
    head = release_sha(args)
    for name in (('admission', 'build') if stage == 'build' else (stage,)):
        if name == 'admission' and stage == 'admission' and args.new_grant:
            continue
        if (args.out / name).exists():
            count = receipts.publish_stage(head, attempt_id(args.out), args.out, name)
            print(json.dumps({'published': name, 'files': count, 'sha': head}), flush=True)


def run_stage(args, stage: str, action):
    attempt_id(args.out)
    try:
        result = action()
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result
    finally:
        publish(args, stage)


def prior_native(args, live: str) -> tuple[bytes, dict]:
    """Live native bundle + components: --prior-dir, else the receipt store chain from live. Either
    way new_grant() proves the bundle reproduces the git-committed live native owner."""
    if args.prior_dir:
        return (args.prior_dir / 'native-paper.cjs').read_bytes(), json.loads((args.prior_dir / 'native-components.json').read_bytes())
    import release_receipts as receipts
    holder = native_receipt_sha(live)
    bundle = receipts.read_current(holder, 'admission/native-paper.cjs') if holder else None
    components = receipts.read_current(holder, 'admission/native-components.json') if holder else None
    if bundle is None or components is None:
        raise SystemExit('live native bundle receipts not found; pass --prior-dir (the admission dir of the live release)')
    return bundle, json.loads(components)


def native_receipt_sha(live: str) -> str | None:
    """The sha whose admission receipts hold the native bundle the live owner was proven with."""
    import release_receipts as receipts
    receipt = json.loads(receipts.read_current(live, 'admission/admission-receipt.json') or b'null')
    if not receipt:
        return None
    return live if receipt.get('mode') == 'new-grant' else receipt.get('native_receipt_sha')


def cmd_admission(args):
    out = args.out / 'admission'
    if args.new_grant:
        bundle, components = prior_native(args, args.expected_live_source)
        return lambda: admission_stage.new_grant(args.source, out, args.expected_live_source,
            prior_bundle=bundle, prior_components=components, new_bundle=args.new_native_bundle,
            release_id=args.release_id, authorization=args.authorization, review=args.review,
            policy_chain=args.policy_chain)

    return lambda: admission_stage.reuse(args.source, out, args.expected_live_source,
        native_receipt_sha=native_receipt_sha(args.expected_live_source) if args.publish else None,
        identities='checked' if args.identities_checked_by_plan else None)


def cmd_build(args):
    out = args.out / 'build'

    def action():
        import release_rollout as deployer
        result = {}
        if not (out / 'deployment-build-packet.json').exists():
            result['prepare'] = build_stage.prepare(args.source, args.out / 'admission', out, args.expected_live_source)
        if args.submit:
            # The rollout refuses an admission baseline from another TW day: refuse to spend a
            # full build that could only reach its first mutation after TW midnight.
            observed = json.loads((args.out / 'admission/baseline.json').read_bytes())['observed_at']
            deployer.require_submit_window(observed, datetime.now(timezone.utc), deployer.job_deadline())
            result['submit'] = build_stage.submit(out)
        if args.wait:
            value = build_stage.wait(out)
            result['build'] = {'id': value['id'], 'status': value['status'],
                               'digest': value['results']['images'][0]['digest']}
        return result
    return action


def rollout_prior(args) -> dict:
    """Previous Modal release + bootstrap verification of the live Modal deployment."""
    if args.prior_modal_release or args.prior_bootstrap:
        return {'modal_release': json.loads(args.prior_modal_release.read_bytes()),
                'bootstrap': json.loads(args.prior_bootstrap.read_bytes()), 'attempt': 'local-files'}
    import release_receipts as receipts
    from runtime_context import load_environment
    load_environment()  # CD: Modal token from Secret Manager, exported for the modal CLI below
    history = json.loads(subprocess.check_output([args.python, '-m', 'modal', 'app', 'history', 'stockvision-ml', '--json'], text=True))[0]
    tag = history['Tag']
    pointer = receipts.current(tag)
    if pointer is None:
        return {'modal_tag': tag}
    return {'modal_tag': tag, 'attempt': pointer['attempt'],
            'modal_release': json.loads(receipts.read_current(tag, 'rollout/modal-release.json')),
            'bootstrap': json.loads(receipts.read_current(tag, 'rollout/bootstrap-verification.json'))}


def cmd_rollout(args):
    def action():
        import release_rollout as deployer
        hook = None
        if args.publish:
            import release_receipts as receipts
            head, attempt = release_sha(args), attempt_id(args.out)
            # A killed or unrolled-back attempt of this commit may have left a staged revision,
            # Modal version or job image behind: reconcile it (verify --from-receipts or by hand).
            stale = receipts.unreconciled_attempts(head, skip=attempt)
            if stale:
                raise RuntimeError('previous_rollout_attempt_unreconciled:' + ','.join(stale))

            def hook(path):
                print(json.dumps({'receipt': receipts.publish_progress(head, attempt, path, 'rollout')}), flush=True)
        return deployer.rollout(source=args.source, out=args.out / 'rollout', build_dir=args.out / 'build',
                                admission_dir=args.out / 'admission', prior=rollout_prior(args), python=args.python,
                                resume_staged=args.resume_staged, publish=hook)
    return action


def fetch_attempt(sha: str, attempt: str | None, out: Path) -> tuple[str, dict]:
    """Download a rollout attempt's receipts into out; rebuild stage files a killed run only
    left as progress copies. Returns (attempt, controller-release state)."""
    import release_receipts as receipts
    if attempt is None:
        candidates = [a for a in receipts.attempts(sha) if receipts.rollout_state(sha, a)]
        if len(candidates) != 1:
            raise RuntimeError('rollout_attempt_ambiguous_pass_--attempt:' + ','.join(candidates))
        attempt = candidates[0]
    state = receipts.rollout_state(sha, attempt)
    if state is None:
        raise RuntimeError('rollout_receipts_not_found:' + attempt)
    if out.exists() and any(out.iterdir()):
        raise RuntimeError('verify_out_not_empty')
    out.mkdir(parents=True, exist_ok=True)
    for stage in DIGEST_STAGES:
        for line in receipts.listing(receipts.prefix(sha, attempt) + '/' + stage + '/**'):
            relative = line[len(receipts.prefix(sha, attempt)) + 1:]
            if line.endswith('/') or '..' in relative.split('/'):
                continue
            raw = receipts.read(line)
            target = out / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    progress = out / 'rollout' / 'progress'
    for name in ROLLOUT_DURABLE:
        copies = sorted(progress.glob('*-' + name)) if progress.is_dir() else []
        if not (out / 'rollout' / name).exists() and copies:
            (out / 'rollout' / name).write_bytes(copies[-1].read_bytes())
    (out / 'attempt.json').write_text(json.dumps({'attempt': attempt}) + '\n', encoding='utf-8')
    return attempt, state


def verify_release(out: Path, *, publish: bool, sha: str | None = None) -> dict:
    """Read the live release back against its receipts; with publish, write <sha>/current.json."""
    from runtime_context import gc, load_environment, read_until_200, request
    from verify_cloud_run_release import verify_health, verify_paper_runtime, verify_traffic
    from application_job_inventory import read_live_inventory, verify_inventory
    import modal
    release = json.loads((out / 'rollout/controller-release.json').read_bytes())
    packet = json.loads((out / 'build/deployment-build-packet.json').read_bytes())
    admission = json.loads((out / 'admission/admission-receipt.json').read_bytes())
    if sha is not None and packet['source_sha'] != sha:
        raise RuntimeError('receipt_sha_mismatch')
    # 'staging' = a run killed after its last save; it counts only if everything below is live.
    if release.get('status') not in ('verified', 'staging') or release['source_sha'] != packet['source_sha']:
        raise RuntimeError('rollout_not_verified_or_rolled_back:' + str(release.get('status')))
    for relative in ('rollout/modal-release.json', 'rollout/bootstrap-verification.json'):
        if not (out / relative).exists():
            raise RuntimeError('rollout_receipt_missing:' + relative)
    live = load_environment()
    service = json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=asia-east1', '--format=json'))
    verify_traffic(service, release['revision'])
    if service['spec']['template']['spec']['containers'][0]['image'] != release['image']:
        raise RuntimeError('live_image_not_release_image')
    health = read_until_200(lambda: request(service['status']['url'] + '/health'))
    if health['http_status'] != 200:
        raise RuntimeError('controller_health_http_' + str(health['http_status']))
    verify_health(health['body'], {'sourceSha': packet['source_sha'],
                  'sourceTreeSha': packet['tree'], 'schedulerManifestSha256': packet['scheduler_sha256']})
    paper = request(live['url'].rstrip('/') + '/research_validation/production_bundle',
                    headers={'X-Controller-Token': os.environ['ML_CONTROLLER_SECRET']})
    if paper['http_status'] != 200:
        raise RuntimeError('paper_bundle_http_failure')
    verify_paper_runtime(paper['body'])
    provenance = modal.Function.from_name('stockvision-ml', 'deployment_provenance').remote()
    modal_release = json.loads((out / 'rollout/modal-release.json').read_bytes())
    if provenance.get('source_sha') != packet['source_sha'] or provenance != modal_release.get('provenance'):
        raise RuntimeError('modal_source_mismatch')
    env, jobs = read_live_inventory(gc, region='asia-east1', service='ml-controller')
    verified_jobs = verify_inventory(controller_env=env, live_jobs=jobs, expected_image=release['image'],
                                     expected_sha=packet['source_sha'])
    result = dict(status='verified', verified_at=datetime.now(timezone.utc).isoformat(), source_sha=packet['source_sha'],
                  revision=release['revision'], image=release['image'], modal_provenance=provenance,
                  jobs=sorted(verified_jobs), admission_mode=packet['admission_mode'],
                  rollout_receipt_status=release.get('status'))
    (out / 'verify').mkdir(parents=True, exist_ok=True)
    (out / 'verify/verify.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    if publish:
        import release_receipts as receipts
        head, attempt = packet['source_sha'], attempt_id(out)
        for stage in ('rollout', 'verify'):  # rollout: files rebuilt from progress copies
            receipts.publish_stage(head, attempt, out, stage)
        files = receipts.digests(out, DIGEST_STAGES)
        for relative in NEXT_RELEASE_READS:  # what the store now holds is what the next release reads
            receipts.read_attempt(head, attempt, relative, files)
        base = packet['base_source_sha']
        previous_raw = receipts.current_raw(base)
        receipts.write_current(head, dict(sha=head, attempt=attempt, status='verified', verified_at=result['verified_at'],
            admission_mode=admission['mode'], files=files,
            previous=dict(sha=base, current_sha256=receipts.sha256(previous_raw) if previous_raw is not None else None),
            native_receipt_sha=head if admission['mode'] == 'new-grant' else admission.get('native_receipt_sha')),
            out / 'verify/current.json')
    return result


def cmd_verify(args):
    def action():
        if args.from_receipts:
            attempt, state = fetch_attempt(args.sha, args.attempt, args.out)
            print(json.dumps({'attempt': attempt, 'rollout_status': state.get('status')}), flush=True)
            return verify_release(args.out, publish=args.publish, sha=args.sha)
        return verify_release(args.out, publish=args.publish)
    return action


def cmd_window(args):
    import release_rollout as deployer
    deployer.wait_outside_scaler_windows(deadline=deployer.job_deadline())
    return {'status': 'outside_scaler_windows', 'at': datetime.now(timezone.utc).isoformat()}


def cmd_seed(args):
    """One-time, by hand: publish the receipts of a release made with the audits/ tools so the next
    release can derive its PRIOR. Verifies them against the live Modal deployment first, and prints
    the bootstrap anchor to commit in tools/release/trust_anchors.json."""
    def action():
        import hashlib
        import release_receipts as receipts
        import modal
        from release_rollout import bootstrap_anchor_digest, validate_bootstrap_ref
        raw = args.modal_release.read_bytes()
        modal_release = json.loads(raw)
        bootstrap = json.loads(args.bootstrap_verification.read_bytes())
        capture = json.loads(args.capture_receipt.read_bytes())
        ref_raw = json.loads(capture['raw'].strip())['daily_history_bootstrap_ref']
        ref_raw = ref_raw if isinstance(ref_raw, str) else json.dumps(ref_raw)
        if (modal_release.get('status') not in ('PASS', 'verified') or modal_release.get('bootstrap_preserved') is not True
                or bootstrap.get('status') != 'PASS' or validate_bootstrap_ref(ref_raw) != bootstrap['reference']):
            raise RuntimeError('seed_receipts_inconsistent')
        actual = modal.Function.from_name('stockvision-ml', 'deployment_provenance').remote()
        history = json.loads(subprocess.check_output([args.python, '-m', 'modal', 'app', 'history', 'stockvision-ml', '--json'], text=True))[0]
        if actual != modal_release['provenance'] or history['Tag'] != actual['source_sha'] or actual['source_sha'] != args.sha:
            raise RuntimeError('seed_modal_release_not_live')
        if abs((datetime.fromisoformat(history['Time deployed']) - datetime.fromisoformat(modal_release['completed_at'])).total_seconds()) >= 300:
            raise RuntimeError('seed_modal_release_time_mismatch')
        stage = args.out / 'rollout'
        stage.mkdir(parents=True)
        admission_stage.save(stage / 'modal-release.json', {**modal_release, 'status': 'verified', 'original_status': modal_release['status'],
            'original_receipt_sha256': hashlib.sha256(raw).hexdigest(), 'modal_version': history['Version'],
            'verification_method': 'seed_prior_receipt_plus_fresh_exact_provenance_and_deployment_time'})
        admission_stage.save(stage / 'bootstrap-verification.json', {**bootstrap, 'raw_ref': ref_raw})
        attempt = attempt_id(args.out)
        receipts.publish_stage(args.sha, attempt, args.out, 'rollout')
        mode = None
        if args.admission_dir:
            target = args.out / 'admission'
            target.mkdir()
            for name in ('admission-receipt.json', 'native-paper.cjs', 'native-components.json', 'source-grant.json'):
                if (args.admission_dir / name).exists():
                    (target / name).write_bytes((args.admission_dir / name).read_bytes())
            receipt = json.loads((target / 'admission-receipt.json').read_bytes())
            mode = receipt.get('mode', 'new-grant')
            receipts.publish_stage(args.sha, attempt, args.out, 'admission')
        files = receipts.digests(args.out, ('admission', 'rollout'))
        for relative in files:
            receipts.read_attempt(args.sha, attempt, relative, files)
        receipts.write_current(args.sha, dict(sha=args.sha, attempt=attempt, status='verified', seeded=True,
            verified_at=datetime.now(timezone.utc).isoformat(), admission_mode=mode, files=files, previous=None,
            native_receipt_sha=args.sha if mode == 'new-grant' else None), args.out / 'current.json')
        return {'status': 'seeded', 'sha': args.sha, 'attempt': attempt,
                'commit_in_trust_anchors_json': {'finlab_daily_history_bootstrap_ref_sha256':
                                                 bootstrap_anchor_digest(bootstrap['reference'])}}
    return action


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = root.add_subparsers(dest='stage', required=True)
    p = sub.add_parser('plan')
    p.add_argument('--choice', choices=['changed', 'controller'], default='changed')
    p = sub.add_parser('classify')
    p.add_argument('--live', required=True)
    sub.add_parser('window')
    for name in ('admission', 'build', 'rollout', 'verify', 'seed-receipts'):
        p = sub.add_parser(name)
        p.add_argument('--source', type=Path, default=ROOT, help='release checkout (default: this repo)')
        p.add_argument('--out', type=Path, required=True)
        p.add_argument('--publish', action=argparse.BooleanOptionalAction, default=in_cd(),
                       help='copy receipts to the GCS receipt store (default: on in CD)')
        p.add_argument('--python', default=sys.executable, help='Python with the modal package')
        if name in ('admission', 'build'):
            p.add_argument('--expected-live-source', required=True)
    p = sub.choices['admission']
    p.add_argument('--identities-checked-by-plan', action='store_true',
                   help='CD: the plan job compared the allocator / L3 identities at this commit')
    p.add_argument('--new-grant', action='store_true', help='identity-changing release (manual only)')
    p.add_argument('--prior-dir', type=Path)
    p.add_argument('--new-native-bundle', type=Path)
    p.add_argument('--release-id')
    p.add_argument('--authorization')
    p.add_argument('--policy-chain', type=Path)
    p.add_argument('--review', default='')
    p = sub.choices['build']
    p.add_argument('--submit', action='store_true')
    p.add_argument('--wait', action='store_true')
    p = sub.choices['rollout']
    p.add_argument('--resume-staged', action='store_true')
    p.add_argument('--prior-modal-release', type=Path)
    p.add_argument('--prior-bootstrap', type=Path)
    p = sub.choices['verify']
    p.add_argument('--from-receipts', action='store_true', help='verify a rollout from the receipt store')
    p.add_argument('--sha', help='release commit (with --from-receipts)')
    p.add_argument('--attempt', help='rollout attempt, e.g. gh-<run id>-<run attempt> (with --from-receipts)')
    p = sub.choices['seed-receipts']
    p.add_argument('--sha', required=True)
    p.add_argument('--modal-release', type=Path, required=True)
    p.add_argument('--bootstrap-verification', type=Path, required=True)
    p.add_argument('--capture-receipt', type=Path, required=True)
    p.add_argument('--admission-dir', type=Path)
    return root


def main(argv=None) -> None:
    args = parser().parse_args(argv)
    if args.stage == 'plan':
        for key, value in plan(args.choice).items():
            print(f'{key}={value}')
        return
    if args.stage == 'classify':
        head = repo_git('rev-parse', 'HEAD')
        decision = admission_stage.classify(ROOT, args.live, head)
        print('identity=' + decision['mode'])
        for reason in decision['reasons']:
            print('::error::identity-changing release (' + reason + '); controller CD fails closed: '
                  'stage the new Paper grant with the manual release (tools/release/release.py admission --new-grant) after Wei go',
                  file=sys.stderr)
        return
    if args.stage == 'window':
        print(json.dumps(cmd_window(args)), flush=True)
        return
    args.source, args.out = args.source.resolve(), args.out.resolve()
    if args.stage == 'admission' and args.new_grant and not all((args.new_native_bundle, args.release_id, args.authorization)):
        raise SystemExit('--new-grant needs --new-native-bundle, --release-id and --authorization')
    if args.stage == 'admission' and args.identities_checked_by_plan and (args.new_grant or not in_cd()):
        raise SystemExit('--identities-checked-by-plan is for the CD deploy job only')
    if args.stage == 'verify' and args.from_receipts and not (args.sha and len(args.sha) == 40):
        raise SystemExit('--from-receipts needs --sha <40-hex release commit>')
    if args.stage == 'seed-receipts' and in_cd():
        raise SystemExit('seed-receipts is a one-time manual step')
    if args.stage == 'seed-receipts':
        print(json.dumps(cmd_seed(args)()), flush=True)
        return
    action = {'admission': cmd_admission, 'build': cmd_build, 'rollout': cmd_rollout, 'verify': cmd_verify}[args.stage](args)
    if args.stage == 'verify':
        # verify publishes its own stage, before current.json, under the rollout's attempt.
        print(json.dumps(action(), ensure_ascii=False), flush=True)
        return
    run_stage(args, args.stage, action)


if __name__ == '__main__':
    main()
