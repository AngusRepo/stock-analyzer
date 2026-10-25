"""Controller + Modal release, one stage per subcommand (E-2). Linux (GitHub runner) and Windows.

  plan      [--choice changed|controller]      no credentials: prints controller=, live_sha=, gate_base=
  classify  --live <sha>                       no credentials, needs ml-controller requirements:
                                               prints identity=reuse|new-grant and the reasons
  admission --expected-live-source <sha> --out DIR [--new-grant ...]
  build     --out DIR [--submit] [--wait]      prepare the full-build packet; --submit/--wait write
  rollout   --out DIR                          staged controller + Modal + jobs + traffic (writes)
  verify    --out DIR                          read back the live release; writes <sha>/current.json
  seed-receipts ...                            one-time: publish receipts of a release made by hand

Stages share --out (out/admission, out/build, out/rollout, out/verify). With --publish (the
default in CD) each stage's directory is copied to gs://stockvision-models/release-receipts/
<sha>/<attempt>/ when the stage ends, pass or fail; the Docker context is not copied.
PRIOR comes from that store: the live Modal tag's verified rollout receipts (previous Modal
release + bootstrap) and, for a new-grant admission, the live native bundle.
Controller CD runs plan, classify, admission (reuse), build --submit --wait, rollout and verify.
A new-grant release (native identity, policy chain or allocator/L3 sources change) fails closed in
CD and goes through the manual path with operator credentials and Wei's go.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
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


def controller_inputs_changed(changed: list[str], dockerfile: str) -> bool:
    """True if a changed path can alter the controller image or the Modal app shipped with it."""
    copies = build_stage.dockerfile_copies(dockerfile)
    for path in changed:
        if TEST.search(path) or path.endswith('.md'):
            continue
        if path in ('Dockerfile', '.dockerignore') or path.startswith('ml-service/'):
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
    deploy = choice == 'controller' or controller_inputs_changed(changed, dockerfile)
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


def publish(args, stage: str) -> None:
    """Receipts are keyed by the release commit. A new-grant admission runs before its release PR
    exists, so admission receipts are (re)published with the build stage, without clobbering."""
    if not args.publish:
        return
    import release_receipts as receipts
    head = admission_stage.git(args.source, 'rev-parse', 'HEAD')
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
    """Live native bundle + components: --prior-dir, else the receipt store chain from live."""
    if args.prior_dir:
        return (args.prior_dir / 'native-paper.cjs').read_bytes(), json.loads((args.prior_dir / 'native-components.json').read_bytes())
    import release_receipts as receipts
    receipt = json.loads(receipts.read_current(live, 'admission/admission-receipt.json') or b'null')
    holder = live if receipt and receipt.get('mode') == 'new-grant' else (receipt or {}).get('native_receipt_sha')
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
        native_receipt_sha=native_receipt_sha(args.expected_live_source) if args.publish else None)


def cmd_build(args):
    out = args.out / 'build'

    def action():
        result = {}
        if not (out / 'deployment-build-packet.json').exists():
            result['prepare'] = build_stage.prepare(args.source, args.out / 'admission', out, args.expected_live_source)
        if args.submit:
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
            'modal_release': json.loads(receipts.read_current(tag, 'rollout/modal-release.json') or b'null'),
            'bootstrap': json.loads(receipts.read_current(tag, 'rollout/bootstrap-verification.json') or b'null')}


def cmd_rollout(args):
    def action():
        import release_rollout as deployer
        return deployer.rollout(source=args.source, out=args.out / 'rollout', build_dir=args.out / 'build',
                                admission_dir=args.out / 'admission', prior=rollout_prior(args), python=args.python,
                                resume_staged=args.resume_staged)
    return action


def cmd_verify(args):
    def action():
        from runtime_context import gc, load_environment, request
        from verify_cloud_run_release import verify_health, verify_traffic
        from application_job_inventory import read_live_inventory, verify_inventory
        import modal
        out = args.out / 'verify'
        out.mkdir(parents=True, exist_ok=True)
        release = json.loads((args.out / 'rollout/controller-release.json').read_bytes())
        packet = json.loads((args.out / 'build/deployment-build-packet.json').read_bytes())
        if release.get('status') != 'verified' or release['source_sha'] != packet['source_sha']:
            raise RuntimeError('rollout_not_verified')
        load_environment()
        service = json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=asia-east1', '--format=json'))
        verify_traffic(service, release['revision'])
        verify_health(request(service['status']['url'] + '/health')['body'], {'sourceSha': packet['source_sha'],
                      'sourceTreeSha': packet['tree'], 'schedulerManifestSha256': packet['scheduler_sha256']})
        provenance = modal.Function.from_name('stockvision-ml', 'deployment_provenance').remote()
        if provenance.get('source_sha') != packet['source_sha']:
            raise RuntimeError('modal_source_mismatch')
        env, jobs = read_live_inventory(gc, region='asia-east1', service='ml-controller')
        verified_jobs = verify_inventory(controller_env=env, live_jobs=jobs, expected_image=release['image'],
                                         expected_sha=packet['source_sha'])
        result = dict(status='verified', verified_at=datetime.now(timezone.utc).isoformat(), source_sha=packet['source_sha'],
                      revision=release['revision'], image=release['image'], modal_provenance=provenance,
                      jobs=sorted(verified_jobs), admission_mode=packet['admission_mode'])
        (out / 'verify.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        if args.publish:
            import release_receipts as receipts
            admission = json.loads((args.out / 'admission/admission-receipt.json').read_bytes())
            receipts.write_current(packet['source_sha'], dict(sha=packet['source_sha'], attempt=attempt_id(args.out),
                status='verified', verified_at=result['verified_at'], admission_mode=admission['mode'],
                native_receipt_sha=packet['source_sha'] if admission['mode'] == 'new-grant' else admission.get('native_receipt_sha')),
                out / 'current.json')
        return result
    return action


def cmd_seed(args):
    """One-time, by hand: publish the receipts of a release made with the audits/ tools so the next
    release can derive its PRIOR. Verifies them against the live Modal deployment first."""
    def action():
        import hashlib
        import release_receipts as receipts
        import modal
        from release_rollout import validate_bootstrap_ref
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
        receipts.write_current(args.sha, dict(sha=args.sha, attempt=attempt, status='verified', seeded=True,
            verified_at=datetime.now(timezone.utc).isoformat(), admission_mode=mode,
            native_receipt_sha=args.sha if mode == 'new-grant' else None), args.out / 'current.json')
        return {'status': 'seeded', 'sha': args.sha, 'attempt': attempt}
    return action


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = root.add_subparsers(dest='stage', required=True)
    p = sub.add_parser('plan')
    p.add_argument('--choice', choices=['changed', 'controller'], default='changed')
    p = sub.add_parser('classify')
    p.add_argument('--live', required=True)
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
    args.source, args.out = args.source.resolve(), args.out.resolve()
    if args.stage == 'admission' and args.new_grant and not all((args.new_native_bundle, args.release_id, args.authorization)):
        raise SystemExit('--new-grant needs --new-native-bundle, --release-id and --authorization')
    if args.stage == 'seed-receipts' and in_cd():
        raise SystemExit('seed-receipts is a one-time manual step')
    if args.stage == 'seed-receipts':
        print(json.dumps(cmd_seed(args)()), flush=True)
        return
    action = {'admission': cmd_admission, 'build': cmd_build, 'rollout': cmd_rollout, 'verify': cmd_verify}[args.stage](args)
    run_stage(args, args.stage, action)


if __name__ == '__main__':
    main()
