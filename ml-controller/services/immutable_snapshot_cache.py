"""Bounded process-local cache of checksum-verified immutable D1 snapshot parts."""
from collections import OrderedDict
import hashlib
import threading
import zlib


class SnapshotPartsCache:
    def __init__(self, max_bytes=512 * 1024 * 1024):
        self.max_bytes = max_bytes
        self.size = 0
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            value = self.entries.get(key)
            if value is None:
                return None
            self.entries.move_to_end(key)
            packed = value[0]
        # Fresh rows preserve caller isolation; never share mutable decoded data.
        return [{"part_no": i, "payload_text": zlib.decompress(part).decode("utf-8")}
                for i, part in enumerate(packed)]

    def put(self, key, rows):
        _, _, checksum, count = key
        if len(rows) != count:
            raise RuntimeError("paired_nav_parts_incomplete")
        hasher, packed, size = hashlib.sha256(), [], 0
        for i, row in enumerate(rows):
            if type(row.get("part_no")) is not int or row["part_no"] != i or not isinstance(row.get("payload_text"), str):
                raise RuntimeError("paired_nav_parts_incomplete")
            raw = row["payload_text"].encode("utf-8")
            hasher.update(raw)
            if packed is not None:
                part = zlib.compress(raw, level=1)
                size += len(part) + 64
                if size > self.max_bytes:
                    packed = None
                else:
                    packed.append(part)
        if hasher.hexdigest() != checksum:
            raise RuntimeError("paired_nav_snapshot_checksum_mismatch")
        if packed is None:
            return
        with self.lock:
            old = self.entries.pop(key, None)
            if old is not None:
                self.size -= old[1]
            while self.entries and self.size + size > self.max_bytes:
                _, (_, removed) = self.entries.popitem(last=False)
                self.size -= removed
            self.entries[key] = (tuple(packed), size)
            self.size += size


SNAPSHOT_PARTS_CACHE = SnapshotPartsCache()
