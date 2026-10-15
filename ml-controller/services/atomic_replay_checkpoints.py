"""Durable deterministic replay cache, isolated from immutable pipeline evidence."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import re
from pathlib import Path
from threading import Event, Thread


class AtomicReplayCheckpoints:
    def __init__(self, directory, runner, request, bucket=None):
        self.directory = Path(directory)
        self.bucket = bucket
        identity = {'kernel': hashlib.sha256(Path(runner).read_bytes()).hexdigest(),
                    'signal_date': request.get('signalDate'), 'run': request.get('producerRunId')}
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.prefix = 'atomic_replay_checkpoints/v1/' + key + '/'
        self.uploaded = set()
        self.stop = Event()
        self.error = None
        self.thread = None

    @staticmethod
    def validate(name, raw):
        if not re.fullmatch(r'[a-f0-9]{64}\.json', name):
            raise ValueError('atomic_checkpoint_name_invalid')
        value = json.loads(raw)
        if (value.get('key') != name[:-5] or not isinstance(value.get('body'), str)
                or hashlib.sha256(value['body'].encode()).hexdigest() != value.get('sha256')):
            raise ValueError('atomic_checkpoint_checksum_invalid')

    def restore(self):
        if self.bucket is None:
            return
        blobs = list(self.bucket.list_blobs(prefix=self.prefix))
        def restore(blob):
            name = blob.name[len(self.prefix):]
            raw = blob.download_as_bytes(timeout=60)
            self.validate(name, raw)
            (self.directory / name).write_bytes(raw)
            return name
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.uploaded.update(pool.map(restore, blobs))

    def flush(self):
        if self.bucket is None:
            return
        from google.api_core.exceptions import PreconditionFailed
        for path in self.directory.glob('*.json'):
            if path.name in self.uploaded:
                continue
            raw = path.read_bytes()
            self.validate(path.name, raw)
            blob = self.bucket.blob(self.prefix + path.name)
            try:
                blob.upload_from_string(raw, content_type='application/json', if_generation_match=0, timeout=60)
            except PreconditionFailed:
                if blob.download_as_bytes(timeout=60) != raw:
                    raise ValueError('atomic_checkpoint_immutable_conflict')
            self.uploaded.add(path.name)

    def __enter__(self):
        self.restore()
        def persist():
            while not self.stop.wait(5):
                try:
                    self.flush()
                except Exception as exc:
                    self.error = exc
                    return
        if self.bucket is not None:
            self.thread = Thread(target=persist, daemon=True)
            self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        if self.thread is not None:
            self.thread.join()
        self.flush()
        if self.error is not None:
            raise RuntimeError('atomic_checkpoint_persistence_failed') from self.error
