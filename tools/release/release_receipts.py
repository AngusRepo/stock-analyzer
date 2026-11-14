"""Release receipt store: gs://stockvision-models/release-receipts/<sha>/<attempt>/<stage>/...

Every stage writes its receipts under the local --out directory; with publishing on (always in
CD) the stage directory is copied to the bucket, never overwriting an existing object. The
rollout also copies its rollback anchor and each controller-release.json state to
<stage>/progress/ the moment it saves them, so a run killed mid-rollout (cancel, job timeout)
still leaves what is needed to reconcile it. A verified release writes <sha>/current.json: the
attempt holding that sha's receipts, the sha256 of every receipt file of that attempt, and the
previous release's current.json digest. Readers re-hash every file against those digests.

Trust: the bucket is also writable by runtime service accounts (stockvision-models), so the
store is not a trust root on its own. Nothing security-relevant is taken from it unchecked: the
FinLab bootstrap reference must equal the git-committed anchor (trust_anchors.json) and its
object is always re-hashed in full, the previous Modal release is cross-checked against the live
Modal deployment, and a prior native bundle must reproduce the git-committed native owner. A
deployer-only receipt bucket removes the remaining tamper surface (IAM step for Wei).
The bucket is private; receipts may hold paper grants and runtime metadata, so they never go to
GitHub artifacts or logs (the repo is public).
"""
from __future__ import annotations

import hashlib
import itertools
import json
from pathlib import Path
import subprocess

from runtime_context import GC, PROJECT

BUCKET = 'gs://stockvision-models/release-receipts'
# The Docker context is already in the Cloud Build source staging object.
UNPUBLISHED_DIRS = {'context'}
# Written by `release.py verify --from-receipts --reconcile` once the live controller and jobs of
# an unreconciled attempt agree again; the rollout's refusal skips that attempt from then on.
RECONCILIATION = 'reconcile/reconciliation.json'
_progress = itertools.count(1)


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def prefix(sha: str, attempt: str | None = None) -> str:
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('receipt_sha_invalid')
    if attempt is not None and (not attempt or '/' in attempt or attempt.startswith('.')):
        raise ValueError('receipt_attempt_invalid')
    return f'{BUCKET}/{sha}' + (f'/{attempt}' if attempt else '')


def published_files(stage_dir: Path) -> list[Path]:
    return sorted(p for p in stage_dir.rglob('*') if p.is_file()
                  and not UNPUBLISHED_DIRS & set(p.relative_to(stage_dir).parts))


def digests(out: Path, stages) -> dict[str, str]:
    """sha256 of every publishable receipt file, keyed by its path relative to out."""
    return {path.relative_to(out).as_posix(): sha256(path.read_bytes())
            for stage in stages if (out / stage).is_dir() for path in published_files(out / stage)}


def _gcloud(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    if not GC:
        raise RuntimeError('gcloud_not_found')
    return subprocess.run([GC, *args, '--project=' + PROJECT], capture_output=True, timeout=300, check=check)


def publish_stage(sha: str, attempt: str, out: Path, stage: str) -> int:
    """Copy out/<stage>/** to the bucket without clobbering. Returns the number of files sent."""
    stage_dir = out / stage
    files = published_files(stage_dir)
    for path in files:
        target = prefix(sha, attempt) + '/' + path.relative_to(out).as_posix()
        # --no-clobber: an object written by an earlier publish of the same attempt stays as it was.
        _gcloud('storage', 'cp', '--no-clobber', str(path), target)
    return len(files)


def publish_progress(sha: str, attempt: str, path: Path, stage: str) -> str:
    """Copy one just-saved receipt to <stage>/progress/<seq>-<name> (never overwritten)."""
    target = f'{prefix(sha, attempt)}/{stage}/progress/{next(_progress):03d}-{path.name}'
    _gcloud('storage', 'cp', '--no-clobber', str(path), target)
    return target


# gcloud words "no such object" differently across versions; 2026-11 gcloud on macOS says
# "The following URLs matched no objects or files", which read() used to treat as a failure.
_MISSING_MARKERS = (b'NotFound', b'404', b'No URLs matched', b'matched no objects')


def _missing(stderr: bytes) -> bool:
    return any(marker in stderr for marker in _MISSING_MARKERS)


def read(url: str) -> bytes | None:
    result = _gcloud('storage', 'cat', url, check=False)
    if result.returncode == 0:
        return result.stdout
    if _missing(result.stderr):
        return None
    raise RuntimeError('receipt_read_failed:' + url)


def listing(url: str) -> list[str]:
    result = _gcloud('storage', 'ls', url, check=False)
    if result.returncode == 0:
        return [line.strip() for line in result.stdout.decode('utf-8').splitlines() if line.strip()]
    if _missing(result.stderr):
        return []
    raise RuntimeError('receipt_list_failed:' + url)


def attempts(sha: str) -> list[str]:
    base = prefix(sha) + '/'
    return sorted(line[len(base):].rstrip('/') for line in listing(base) if line.startswith(base) and line.endswith('/'))


def rollout_receipt(sha: str, attempt: str, name: str) -> dict | None:
    """The newest copy of rollout/<name> of an attempt: the stage copy, else its last progress copy."""
    raw = read(prefix(sha, attempt) + '/rollout/' + name)
    if raw is None:
        names = [line for line in listing(prefix(sha, attempt) + '/rollout/progress/') if line.endswith('-' + name)]
        raw = read(sorted(names)[-1]) if names else None
    return json.loads(raw) if raw is not None else None


def rollout_state(sha: str, attempt: str) -> dict | None:
    return rollout_receipt(sha, attempt, 'controller-release.json')


def unreconciled(state: dict | None) -> bool:
    """A rollout that may have left a mutation behind: still staging (killed), or a failed
    rollout whose rollback was not verified."""
    if state is None:
        return False
    return state.get('status') == 'staging' or (state.get('status') == 'failed' and state.get('rollback_status') != 'verified')


def _sha_attempt(url: str) -> tuple[str, str]:
    sha, attempt = url[len(BUCKET) + 1:].split('/')[:2]
    return sha, attempt


def reconciled(state: dict | None) -> bool:
    return bool(state) and state.get('status') == 'reconciled'


def unreconciled_anywhere(skip: tuple[str, str] | None = None, superseded_after: str | None = None) -> list[str]:
    """'<sha>/<attempt>' of every attempt in the store, any commit, whose rollout may have left a
    mutation behind (unreconciled()) and that has neither a reconciliation receipt
    (RECONCILIATION, written by verify --from-receipts --reconcile) nor a verified release after
    it (superseded_after: verified_at of the live release's current.json, which proved the
    controller, Modal and every job on one sha). Three listings, then the attempts' newest
    controller-release.json copies, as rollout_receipt picks them."""
    from concurrent.futures import ThreadPoolExecutor
    from datetime import datetime
    base = BUCKET + '/'
    newest = {}
    # Progress copies in sequence order, then the stage copy, which wins.
    for line in (sorted(listing(base + '*/*/rollout/progress/*-controller-release.json'))
                 + listing(base + '*/*/rollout/controller-release.json')):
        newest[_sha_attempt(line)] = line
    markers = listing(base + '*/*/' + RECONCILIATION)
    with ThreadPoolExecutor(max_workers=8) as pool:
        done = {_sha_attempt(line) for line, raw in zip(markers, pool.map(read, markers))
                if raw is not None and reconciled(json.loads(raw))}
        keys = [key for key in sorted(newest) if key != skip and key not in done]
        states = dict(zip(keys, pool.map(lambda key: json.loads(read(newest[key]) or b'null'), keys)))
    stale = []
    for key, state in states.items():
        if not unreconciled(state):
            continue
        at = state.get('failed_at') or state.get('started_at')
        if superseded_after and at and datetime.fromisoformat(at) < datetime.fromisoformat(superseded_after):
            continue
        stale.append('/'.join(key))
    return stale


def current_raw(sha: str) -> bytes | None:
    return read(prefix(sha) + '/current.json')


def current(sha: str) -> dict | None:
    raw = current_raw(sha)
    return json.loads(raw) if raw is not None else None


def unreleased_modal(sha: str) -> dict:
    """Modal receipts of a sha with no current.json whose rollout still deployed Modal: a failed
    rollout whose rollback could not revert Modal (Modal has no rollback on this plan) leaves it
    live (2026-11-13, 033ab655). Returns the newest verified modal-release + bootstrap-verification
    pair, or {} when none. Not digest-pinned (no verified release); rollout's prior_bootstrap binds
    them to the live Modal deployment (provenance, tag, deploy time within 300 s) and the
    bootstrap reference to the git anchor, as for current.json receipts."""
    found = []
    for attempt in attempts(sha):
        modal_release = rollout_receipt(sha, attempt, 'modal-release.json')
        if (not modal_release or modal_release.get('status') != 'verified'
                or (modal_release.get('provenance') or {}).get('source_sha') != sha):
            continue
        bootstrap = rollout_receipt(sha, attempt, 'bootstrap-verification.json')
        if bootstrap:
            found.append((str(modal_release.get('completed_at', '')), attempt, modal_release, bootstrap))
    if not found:
        return {}
    _, attempt, modal_release, bootstrap = max(found)
    return {'attempt': attempt, 'modal_release': modal_release, 'bootstrap': bootstrap, 'unreleased': True}


def read_attempt(sha: str, attempt: str, relative: str, expected: dict[str, str]) -> bytes:
    """A receipt file re-hashed against its recorded digest; a missing or altered file fails."""
    if relative not in expected:
        raise RuntimeError('receipt_not_in_digest_manifest:' + relative)
    raw = read(prefix(sha, attempt) + '/' + relative)
    if raw is None or sha256(raw) != expected[relative]:
        raise RuntimeError('receipt_digest_mismatch:' + relative)
    return raw


def read_current(sha: str, relative: str) -> bytes | None:
    """A file of the verified attempt of sha, e.g. 'rollout/modal-release.json'. None when sha has
    no current.json; a file that is not in its digest manifest or does not match it fails."""
    pointer = current(sha)
    if pointer is None:
        return None
    files = pointer.get('files')
    if pointer.get('status') != 'verified' or not isinstance(files, dict):
        raise RuntimeError('current_receipt_without_digest_manifest:' + sha)
    return read_attempt(sha, pointer['attempt'], relative, files)


def write_current(sha: str, value: dict, local: Path) -> None:
    if not isinstance(value.get('files'), dict) or not value['files']:
        raise RuntimeError('current_receipt_needs_file_digests')
    local.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    result = _gcloud('storage', 'cp', '--no-clobber', str(local), prefix(sha) + '/current.json', check=False)
    if result.returncode != 0:
        raise RuntimeError('current_receipt_write_failed')
    if current(sha) != value:
        raise RuntimeError('current_receipt_points_elsewhere')
