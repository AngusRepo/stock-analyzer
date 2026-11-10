"""Check the existing exact-source contract before expensive pipeline work."""
from __future__ import annotations

import asyncio
import os
import re

# deployment_provenance cold-starts on every call (cpu 0.25, scaledown 30 s). 10/30 it took
# 20.7 s against the old 20 s bound and failed the chain before any compute ran.
PROVENANCE_TIMEOUT_SECONDS = 120.0


def validate_modal_provenance(value: dict, expected_source_sha: str) -> dict:
    if not re.fullmatch(r'[a-f0-9]{40}', expected_source_sha):
        raise ValueError('pipeline_modal_source_sha_missing_or_invalid')
    if (not isinstance(value, dict)
            or value.get('schema_version') != 'stockvision-modal-deployment-provenance-v1'
            or not re.fullmatch(r'[a-f0-9]{40}', str(value.get('source_sha', '')))):
        raise ValueError('pipeline_modal_provenance_invalid')
    if value['source_sha'] != expected_source_sha:
        raise ValueError('pipeline_modal_source_sha_mismatch:'
                         f"expected={expected_source_sha}:actual={value['source_sha']}")
    return {'status': 'verified', 'expected_source_sha': expected_source_sha,
            'modal_source_sha': value['source_sha']}


async def verify_pipeline_runtime(*, expected_source_sha: str | None = None) -> dict:
    import modal
    expected = expected_source_sha or os.environ.get('STOCKVISION_SOURCE_SHA', '').strip()
    if not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise ValueError('pipeline_modal_source_sha_missing_or_invalid')
    async def read():
        function = modal.Function.from_name('stockvision-ml', 'deployment_provenance')
        return await function.remote.aio()
    try:
        value = await asyncio.wait_for(read(), timeout=PROVENANCE_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        raise ValueError('pipeline_modal_provenance_timeout_before_compute') from exc
    return validate_modal_provenance(value, expected)
