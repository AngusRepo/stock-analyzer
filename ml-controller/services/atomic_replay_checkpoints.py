"""Durable deterministic replay cache, isolated from immutable pipeline evidence."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import gzip
import json
import re
from pathlib import Path
from threading import Event, Thread
import time


class AtomicReplayDeadlineExceeded(TimeoutError):
    pass


class AtomicReplayCheckpoints:
    def __init__(self, directory, runner, request, bucket=None, *, deadline=None, clock=time.monotonic):
        self.directory = Path(directory)
        self.bucket = bucket
        self.deadline, self.clock = deadline, clock
        identity = {'kernel': hashlib.sha256(Path(runner).read_bytes()).hexdigest(),
                    'signal_date': request.get('signalDate'), 'run': request.get('producerRunId')}
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.prefix = 'atomic_replay_checkpoints/v1/' + key + '/'
        self.uploaded = set()
        self.stop = Event()
        self.error = None
        self.thread = None

    def remaining(self):
        if self.deadline is None:
            return None
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise AtomicReplayDeadlineExceeded('atomic_replay_checkpoint_deadline_exceeded')
        return remaining

    def rpc_options(self):
        remaining = self.remaining()
        # A transfer gets at most the remaining shared budget. Disable the
        # SDK's independent retry deadline; a verified next replay can resume.
        return {'timeout': min(60, remaining), 'retry': None} if remaining is not None else {'timeout': 60}

    def rpc(self, call, *args, **kwargs):
        if self.deadline is None:
            return call(*args, **kwargs, **self.rpc_options())
        from google.api_core.exceptions import TooManyRequests, ServiceUnavailable, InternalServerError, DeadlineExceeded
        from requests.exceptions import ConnectionError, Timeout
        transfer_deadline=min(self.deadline,self.clock()+120)
        for attempt in range(10):
            remaining=min(self.remaining(),transfer_deadline-self.clock())
            if remaining <= 0:
                raise AtomicReplayDeadlineExceeded('atomic_replay_checkpoint_transfer_deadline_exceeded')
            try:
                return call(*args, **kwargs, timeout=min(60,remaining), retry=None)
            except (TooManyRequests, ServiceUnavailable, InternalServerError, DeadlineExceeded, ConnectionError, Timeout):
                remaining=min(self.remaining(),transfer_deadline-self.clock())
                if attempt == 9 or remaining <= 0:
                    raise
                time.sleep(min(2**attempt,30,remaining))

    @staticmethod
    def validate(name, raw):
        if not re.fullmatch(r'[a-f0-9]{64}\.json\.gz', name):
            raise ValueError('atomic_checkpoint_name_invalid')
        value = json.loads(gzip.decompress(raw))
        if (value.get('key') != name[:-8] or not isinstance(value.get('body'), str)
                or hashlib.sha256(value['body'].encode()).hexdigest() != value.get('sha256')):
            raise ValueError('atomic_checkpoint_checksum_invalid')

    def restore(self):
        if self.bucket is None:
            return
        if self.deadline is None:
            blobs = list(self.bucket.list_blobs(prefix=self.prefix))
        else:
            blobs, token = [], None
            while True:
                def fetch_page(**options):
                    listing=self.bucket.list_blobs(prefix=self.prefix, page_token=token,
                        page_size=100, **options)
                    return list(next(iter(listing.pages), [])), listing.next_page_token
                page, token=self.rpc(fetch_page)
                blobs.extend(page)
                if not token:break
        def restore(blob):
            name = blob.name[len(self.prefix):]
            raw = self.rpc(blob.download_as_bytes)
            self.validate(name, raw)
            self.remaining()
            (self.directory / name).write_bytes(raw)
            return name
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.uploaded.update(pool.map(restore, blobs))

    def flush(self):
        if self.bucket is None:
            return
        from google.api_core.exceptions import PreconditionFailed
        for path in self.directory.glob('*.json.gz'):
            if path.name in self.uploaded:
                continue
            raw = path.read_bytes()
            self.validate(path.name, raw)
            blob = self.bucket.blob(self.prefix + path.name)
            try:
                self.rpc(blob.upload_from_string, raw, content_type='application/json', if_generation_match=0)
            except PreconditionFailed:
                if self.rpc(blob.download_as_bytes) != raw:
                    raise ValueError('atomic_checkpoint_immutable_conflict')
            self.uploaded.add(path.name)

    def __enter__(self):
        self.remaining()
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
            self.thread.join(timeout=self.remaining())
            if self.thread.is_alive():
                raise AtomicReplayDeadlineExceeded('atomic_replay_checkpoint_flush_deadline_exceeded')
        self.flush()
        self.remaining()
        if self.error is not None:
            raise RuntimeError('atomic_checkpoint_persistence_failed') from self.error
