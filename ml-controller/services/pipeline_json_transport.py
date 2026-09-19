"""C-backed JSON batches: preserve wire bytes without a whole-document buffer.

Batch complete list records, not individual scalar tokens. This retains the C
encoder's throughput while bounding temporary JSON to 32 records. One oversized
record still sets the lower memory bound; this is not a general untrusted-JSON
sandbox. Inputs must remain read-only until synchronous encoding completes.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import zlib
from io import BytesIO
from typing import Any, Iterator


# Match this runtime's gzip header, including Python-version OS-byte behavior.
_GZIP_HEADER = gzip.compress(b"", compresslevel=6, mtime=0)[:10]

def iter_json_bytes(value: Any, *, sort_keys: bool = False) -> Iterator[bytes]:
    options = dict(ensure_ascii=False, sort_keys=sort_keys, separators=(",", ":"), default=str)
    active: set[int] = set()

    def encode(item: Any) -> Iterator[bytes]:
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            identity = id(item)
            if identity in active:
                raise ValueError("Circular reference detected")
            active.add(identity)
            try:
                yield b"{"
                for index, key in enumerate(sorted(item) if sort_keys else item):
                    if index:
                        yield b","
                    yield json.dumps(key, ensure_ascii=False).encode("utf-8") + b":"
                    yield from encode(item[key])
                yield b"}"
            finally:
                active.remove(identity)
        elif isinstance(item, list):
            yield b"["
            for start in range(0, len(item), 32):
                if start:
                    yield b","
                # C encoder keeps circular/type checks and numeric formatting.
                yield json.dumps(item[start:start + 32], **options)[1:-1].encode("utf-8")
            yield b"]"
        else:
            # Preserve stdlib key coercion/error behavior for non-string maps.
            yield json.dumps(item, **options).encode("utf-8")

    yield from encode(value)


def compress_json(value: Any, *, sort_keys: bool = False,
                  max_raw_bytes: int | None = None,
                  max_compressed_bytes: int | None = None,
                  error_prefix: str = "pipeline_json") -> tuple[bytes, int, str]:
    compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
    output = BytesIO()
    raw_sha = hashlib.sha256()
    raw_bytes = 0

    def write(data: bytes) -> None:
        output.write(data)
        if max_compressed_bytes is not None and output.tell() > max_compressed_bytes:
            raise ValueError(f"{error_prefix}_compressed_bytes_exceeded:{output.tell()}:{max_compressed_bytes}")

    for chunk in iter_json_bytes(value, sort_keys=sort_keys):
        raw_bytes += len(chunk)
        if max_raw_bytes is not None and raw_bytes > max_raw_bytes:
            raise ValueError(f"{error_prefix}_bytes_exceeded:{raw_bytes}:{max_raw_bytes}")
        raw_sha.update(chunk)
        write(compressor.compress(chunk))
    write(compressor.flush())
    output.seek(0)
    output.write(_GZIP_HEADER)
    return output.getvalue(), raw_bytes, raw_sha.hexdigest()
