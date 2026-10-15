"""Two-pass capture uploads with verified remote generations and bounded I/O."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import time
from pathlib import Path


def verify_capture_upload(bucket) -> dict:
    """Exercise the real small/resumable uploader before fetching paid data."""
    from tempfile import TemporaryDirectory
    from uuid import uuid4

    prefix = 'health/preflight/finlab-capture-upload/' + uuid4().hex
    state = {}
    try:
        with TemporaryDirectory(prefix='finlab-upload-canary-') as directory:
            root = Path(directory)
            (root / 'small.json').write_bytes(b'{"canary":true}')
            # GCS selects resumable upload above 8 MiB.
            (root / 'large.bin').write_bytes(b'\0' * (9 * 1024 * 1024))
            first = upload_capture(root, bucket=bucket, prefix=prefix, uploaded_files=state)
            for path in root.iterdir():
                remote = bucket.blob(prefix + '/' + path.name).download_as_bytes()
                if hashlib.sha256(remote).digest() != hashlib.sha256(path.read_bytes()).digest():
                    raise RuntimeError('finlab_capture_canary_read_mismatch')
            second = upload_capture(root, bucket=bucket, prefix=prefix, uploaded_files=state)
            if first['objects'] != 2 or second['objects'] != 0 or second['skipped_objects'] != 2:
                raise RuntimeError('finlab_capture_canary_reuse_mismatch')
            return {'status': 'pass', 'checksum': 'crc32c', 'objects': 2,
                    'bytes': first['bytes'], 'second_pass_skipped': 2,
                    'paths': ['multipart', 'resumable'], 'prefix': prefix}
    finally:
        # Only this invocation's UUID namespace; retain generation fencing.
        for blob in bucket.list_blobs(prefix=prefix + '/'):
            blob.delete(if_generation_match=int(blob.generation))


def upload_capture(local_dir: Path, *, bucket, prefix: str, uploaded_files: dict,
                   max_workers: int = 4) -> dict:
    if not 1 <= max_workers <= 8:
        raise ValueError('finlab_upload_concurrency_invalid')
    started = time.monotonic()
    prefix = prefix.rstrip('/')
    # One metadata listing also detects deleted/replaced objects between passes.
    remote = {b.name: b for b in bucket.list_blobs(prefix=prefix + '/')}
    paths = sorted(p for p in local_dir.rglob('*') if p.is_file())
    pending, skipped, skipped_bytes = [], 0, 0
    for path in paths:
        rel = path.relative_to(local_dir).as_posix()
        name = prefix + '/' + rel
        with path.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        size = path.stat().st_size
        key = (bucket.name, name)
        prior = uploaded_files.get(key)
        blob = remote.get(name)
        generation = int(blob.generation) if blob is not None else 0
        if prior and blob is not None and generation != prior['generation']:
            raise RuntimeError('finlab_upload_remote_generation_changed:' + rel)
        if prior and blob is not None and prior['sha256'] == sha and int(blob.size) == size:
            skipped += 1
            skipped_bytes += size
            continue
        pending.append((path, rel, name, key, sha, size, generation))

    def upload(item):
        path, rel, name, key, sha, size, generation = item
        blob = bucket.blob(name)
        blob.metadata = {'sha256': sha}
        # Modal pins storage 2.18.2, which requires an explicit checksum type.
        blob.upload_from_filename(str(path), if_generation_match=generation, checksum='crc32c')
        if blob.generation is None:
            raise RuntimeError('finlab_upload_generation_missing:' + rel)
        # Do not cache a file that changed while the upload was reading it.
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != sha:
                raise RuntimeError('finlab_upload_local_file_changed:' + rel)
        return key, {'sha256': sha, 'generation': int(blob.generation), 'size': size}

    # Publication metadata follows all data. The consumer reference is last.
    def phase(item):
        rel = item[1]
        return 2 if rel == 'inference/reference.json' else 1 if Path(rel).name == 'manifest.json' else 0

    completed = {}
    for stage in (0, 1, 2):
        items = [item for item in pending if phase(item) == stage]
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            for key, record in executor.map(upload, items):
                completed[key] = record
    # Only a complete pass may be reused by the subsequent pass.
    uploaded_files.update(completed)
    return {'bucket': bucket.name, 'prefix': prefix, 'objects': len(completed),
            'bytes': sum(r['size'] for r in completed.values()),
            'skipped_objects': skipped, 'skipped_bytes': skipped_bytes,
            'total_objects': len(paths), 'elapsed_seconds': round(time.monotonic() - started, 3),
            'max_workers': max_workers}
