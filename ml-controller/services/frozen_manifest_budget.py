"""Bound frozen manifest identities separately from full reviewed evidence.

The existing prediction request is gzip/GCS generation/hash bound. Its logical
manifest checksum must not change just because a reviewed L4 model is larger.
No evidence is omitted; normal admission/identity validation still follows.
"""
import gzip
import json

COMPACT_MAX_BYTES = 1_048_576
EVIDENCE_MAX_BYTES = 4 * COMPACT_MAX_BYTES


def canonical_manifest_bytes(manifest: dict) -> bytes:
    def encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')

    raw = encode(manifest)
    if len(raw) <= COMPACT_MAX_BYTES:
        return raw
    context = manifest.get('active8_nav_inference')
    if (not isinstance(context, dict)
            or context.get('schema_version') != 'active8-nav-frozen-inference-v1'
            or context.get('scope') != 'frozen_compute_only'
            or len(raw) > EVIDENCE_MAX_BYTES
            or len(encode({k: v for k, v in manifest.items()
                           if k != 'active8_nav_inference'})) > COMPACT_MAX_BYTES):
        raise ValueError(f'frozen_manifest_logical_budget:{len(raw)}')
    if len(gzip.compress(raw, mtime=0)) > COMPACT_MAX_BYTES:
        raise ValueError(f'frozen_manifest_compressed_budget:{len(raw)}')
    return raw
