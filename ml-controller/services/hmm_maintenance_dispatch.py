"""Dispatch HMM maintenance without waiting for fitting in a daily request."""
import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone

from .hmm_input_contract import CONTRACT_HASH


def stamp(value):
    result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('HMM_CLOCK_UNZONED')
    return result.astimezone(timezone.utc)


def model_coverage(metadata, now, required_until):
    try:
        trained = stamp(metadata['trained_at'])
        compatible = (metadata.get('input_contract') == CONTRACT_HASH
                      and str(metadata.get('artifact_generation') or '').isdigit()
                      and bool(re.fullmatch('[a-f0-9]{64}', str(metadata.get('artifact_sha256') or ''))))
        valid_now = compatible and timedelta(0) <= now - trained <= timedelta(days=9)
        covered = valid_now and timedelta(0) <= required_until - trained <= timedelta(days=9)
        due = not covered or now - trained >= timedelta(days=7)
        return {'usable_now': valid_now, 'ready': covered, 'refresh_due': due,
                'model': {'sha256': metadata.get('artifact_sha256'), 'generation': metadata.get('artifact_generation'),
                          'trained_at': metadata.get('trained_at'), 'input_contract': metadata.get('input_contract')}}
    except (ValueError, TypeError, KeyError, OverflowError):
        return {'usable_now': False, 'ready': False, 'refresh_due': True, 'model': None}


def read_maintenance_state():
    from google.cloud import storage
    from google.api_core.exceptions import NotFound
    bucket = storage.Client().bucket(os.environ.get('GCS_BUCKET_NAME', 'stockvision-models'))
    def read(name):
        try:
            return json.loads(bucket.blob('market_regime/' + name).download_as_text())
        except NotFound:
            return None
    return read('metadata.json'), read('maintenance-policy.json'), read('maintenance-lease.json')


def read_maintenance_attempt(input_key):
    from google.cloud import storage
    from google.api_core.exceptions import NotFound
    bucket = storage.Client().bucket(os.environ.get('GCS_BUCKET_NAME', 'stockvision-models'))
    try:
        return json.loads(bucket.blob('market_regime/maintenance-attempts/' + input_key + '.json').download_as_text())
    except NotFound:
        return None


async def dispatch_maintenance(payload):
    from .modal_client import _lookup
    function = await asyncio.to_thread(_lookup, 'maintain_production_hmm')
    call = await function.spawn.aio(payload)
    return str(call.object_id)


def policy_enabled(policy):
    return bool(isinstance(policy, dict) and policy.get('enabled') is True
        and policy.get('schema_version') == 'hmm-maintenance-policy-v1' and policy.get('approved_by') == 'Wei'
        and str(policy.get('approval_ref') or '').strip() and policy.get('input_contract') == CONTRACT_HASH
        and policy.get('target_prefix') == 'market_regime' and policy.get('refresh_after_days') == 7
        and policy.get('max_age_days') == 9 and policy.get('max_attempts_per_input') == 2)
