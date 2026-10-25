"""Release receipt store: gs://stockvision-models/release-receipts/<sha>/<attempt>/<stage>/...

Every stage writes its receipts under the local --out directory; with publishing on (always in
CD) the stage directory is copied to the bucket, never overwriting an existing object. A rollout
that verifies writes <sha>/current.json, which points at the attempt holding that sha's
receipts. The next release derives its PRIOR from the live sha's current.json instead of a
hand-edited path. The bucket is private; receipts may hold paper grants and runtime metadata, so
they never go to GitHub artifacts or logs (the repo is public).
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

from runtime_context import GC, PROJECT

BUCKET = 'gs://stockvision-models/release-receipts'
# The Docker context is already in the Cloud Build source staging object.
UNPUBLISHED_DIRS = {'context'}


def prefix(sha: str, attempt: str | None = None) -> str:
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('receipt_sha_invalid')
    if attempt is not None and (not attempt or '/' in attempt or attempt.startswith('.')):
        raise ValueError('receipt_attempt_invalid')
    return f'{BUCKET}/{sha}' + (f'/{attempt}' if attempt else '')


def published_files(stage_dir: Path) -> list[Path]:
    return sorted(p for p in stage_dir.rglob('*') if p.is_file()
                  and not UNPUBLISHED_DIRS & set(p.relative_to(stage_dir).parts))


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


def read(url: str) -> bytes | None:
    result = _gcloud('storage', 'cat', url, check=False)
    if result.returncode == 0:
        return result.stdout
    if b'NotFound' in result.stderr or b'404' in result.stderr or b'No URLs matched' in result.stderr:
        return None
    raise RuntimeError('receipt_read_failed:' + url)


def current(sha: str) -> dict | None:
    raw = read(prefix(sha) + '/current.json')
    return json.loads(raw) if raw is not None else None


def read_current(sha: str, relative: str) -> bytes | None:
    """A file of the verified attempt of sha, e.g. 'rollout/modal-release.json'."""
    pointer = current(sha)
    if pointer is None:
        return None
    return read(prefix(sha, pointer['attempt']) + '/' + relative)


def write_current(sha: str, value: dict, local: Path) -> None:
    local.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    result = _gcloud('storage', 'cp', '--no-clobber', str(local), prefix(sha) + '/current.json', check=False)
    if result.returncode != 0:
        raise RuntimeError('current_receipt_write_failed')
    if current(sha) != value:
        raise RuntimeError('current_receipt_points_elsewhere')
