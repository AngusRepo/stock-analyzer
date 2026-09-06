"""Resolve the existing full-fit owner by immutable inputs, not calendar cadence."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any


def full_fit_input_identity(manifest: dict, plan: dict) -> str:
    # The frozen manifest binds producer source, fold configuration, prep and
    # sequence checksums. An intentionally different recipe requires a new
    # attested manifest, never a new wall-clock date for the same cohort.
    payload = {
        'schema': 'active8-full-fit-input-identity-v1',
        'manifest_checksum': manifest.get('manifest_checksum'),
        'cohort_id': manifest.get('cohort_id'),
        'release_models': sorted(plan['release_models']),
        'promotion_eligible_models': sorted(plan['promotion_eligible_models']),
        'feature_pool_checksum': (plan.get('feature_consensus') or {}).get('artifact_checksum'),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def find_prior_full_fit_receipt(*, bucket: Any, manifest: dict, plan: dict, cutoff: str) -> str | None:
    prefix = f"walk_forward/oof_cohorts/{manifest['cohort_id']}/full_fit/"
    identity = full_fit_input_identity(manifest, plan)
    candidates = []
    for blob in bucket.list_blobs(prefix=prefix):
        suffix = blob.name.removeprefix(prefix)
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json', suffix) or suffix[:10] >= cutoff:
            continue
        receipt = json.loads(blob.download_as_text())
        if receipt.get('cohort_id') != manifest['cohort_id'] or receipt.get('knowledge_cutoff_date') != suffix[:10]:
            raise ValueError('full_fit_receipt_path_identity_mismatch')
        if not receipt.get('run_id'):
            continue
        if sorted(receipt.get('release_models') or []) != sorted(plan['release_models']):
            continue
        if sorted(receipt.get('promotion_eligible_models') or []) != sorted(plan['promotion_eligible_models']):
            continue
        stored_identity = receipt.get('input_identity')
        if stored_identity:
            matches = stored_identity == identity
        else:
            # Legacy terminal receipts predate the explicit identity. Only
            # accept their existing registry binding to this exact manifest.
            registry = receipt.get('release_registry') or {}
            pool = receipt.get('feature_pool') or {}
            matches = (
                registry.get('manifest_checksum') == manifest.get('manifest_checksum')
                and len(str(manifest.get('manifest_checksum') or '')) == 64
                and registry.get('cohort_id') == manifest['cohort_id']
                and pool.get('artifact_checksum') == (plan.get('feature_consensus') or {}).get('artifact_checksum')
                and receipt.get('retry_required') is False
                and receipt.get('status') in {'completed', 'blocked'}
            )
        if matches:
            candidates.append(blob.name)
    return max(candidates) if candidates else None
