"""Explicit paper-only resume of an exact saved L2 after transport failure.

This is not pre-open snapshot recovery. Observation timestamps and payloads stay
unchanged; only the deployed runtime source identity may change.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timezone


def validate_saved_state(envelope, *, run_date, run_id, source_sha):
    from services.pipeline_async_state_transport import validate_pipeline_payload_identity
    state = envelope.get('state') or {}
    if (envelope.get('run_date') != run_date or state.get('run_date') != run_date
            or envelope.get('producer_run_id') != run_id or state.get('producer_run_id') != run_id):
        raise ValueError('saved_l2_identity_mismatch')
    validate_pipeline_payload_identity(state)
    if state.get('modal_prediction_bundle') or state.get('modal_prediction_state_gcs_uri') or state.get('saved_l2_resume'):
        raise ValueError('saved_l2_already_continued')
    context = state.get('pipeline_modal_serving_context') or {}
    if (context.get('schema_version') != 'pipeline-modal-serving-context-v1'
            or context.get('expected_source_sha') != source_sha or not re.fullmatch('[a-f0-9]{40}', source_sha)):
        raise ValueError('saved_l2_source_mismatch')
    for key in ('pipeline_sequence_observations','payload_source_observations','timexer_feature_source'):
        if not state.get(key):
            raise ValueError('saved_l2_frozen_dependency_missing:' + key)
    return state


def validate_context_transition(old, new, *, runtime_source):
    if not re.fullmatch('[a-f0-9]{40}', runtime_source) or new.get('expected_source_sha') != runtime_source:
        raise ValueError('saved_l2_runtime_source_mismatch')
    from copy import deepcopy
    from services.paired_nav_journal import digest
    from services.frozen_manifest_budget import canonical_manifest_bytes

    def contract(context):
        value = deepcopy(context)
        manifest = value.get('serving_manifest')
        if (not isinstance(manifest, dict) or value.get('serving_manifest_digest') !=
                hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()):
            raise ValueError('saved_l2_manifest_checksum_mismatch')
        for key in ('created_at','expected_source_sha','serving_manifest_digest'):
            value.pop(key, None)
        if isinstance(value.get('serving_pool'), dict):
            value['serving_pool'].pop('last_updated', None)  # resolver read timestamp
        for section in ('serving_pool','serving_manifest'):
            nav = (value.get(section) or {}).get('active8_nav_inference')
            if nav is not None:
                if (nav.get('schema_version') != 'active8-nav-frozen-inference-v1'
                        or nav.get('context_checksum') != digest({k:v for k,v in nav.items() if k!='context_checksum'})):
                    raise ValueError('saved_l2_nav_checksum_mismatch')
                # A fresh read records a new observation time, not a new model.
                nav.pop('captured_at', None)
                nav.pop('context_checksum', None)
        return value
    if digest(contract(old)) != digest(contract(new)):
        raise ValueError('saved_l2_serving_contract_changed')



async def resume_saved_l2(*, run_date, run_id):
    from google.cloud import storage
    from services.pipeline_async_state_transport import decode_pipeline_state_envelope
    from services.pipeline_prediction_recovery import registry_key
    from services.paper_strategy_mode import from_manifest
    from graphs.daily_pipeline_v2 import (
        assert_canonical_window_open, _attach_pipeline_modal_serving_context,
        _build_pipeline_modal_prediction_payload, _write_pipeline_async_state_artifact,
        _spawn_pipeline_prediction_bundle_from_artifact,
    )
    uri = os.environ.get('PIPELINE_SAVED_L2_URI', '')
    generation = os.environ.get('PIPELINE_SAVED_L2_GENERATION', '')
    checksum = os.environ.get('PIPELINE_SAVED_L2_SHA256', '')
    source_sha = os.environ.get('PIPELINE_SAVED_L2_SOURCE_SHA', '')
    bucket_name = os.environ.get('GCS_BUCKET_NAME', '')
    prefix = f'gs://{bucket_name}/pipeline-v2/async-modal-prediction/{run_date}/'
    if (not bucket_name or not uri.startswith(prefix) or not uri.endswith('/partial_state.json.gz')
            or not generation.isdigit() or not re.fullmatch('[a-f0-9]{64}', checksum)):
        raise ValueError('saved_l2_pin_invalid')
    assert_canonical_window_open(run_date)
    bucket = storage.Client().bucket(bucket_name)
    blob = bucket.blob(uri.split('/', 3)[3], generation=int(generation))
    raw = await asyncio.to_thread(blob.download_as_bytes, if_generation_match=int(generation))
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError('saved_l2_sha256_mismatch')
    envelope = decode_pipeline_state_envelope(raw)
    del raw
    state = validate_saved_state(envelope, run_date=run_date, run_id=run_id, source_sha=source_sha)
    old = state['pipeline_modal_serving_context']
    if not from_manifest(old.get('serving_manifest'), signal_date=run_date):
        raise ValueError('saved_l2_paper_policy_required')
    # A new request must never replace an existing registered prediction.
    if await asyncio.to_thread(bucket.blob(registry_key(run_date, run_id)).exists):
        raise ValueError('saved_l2_prediction_already_registered')
    new = await _attach_pipeline_modal_serving_context(state)
    validate_context_transition(old, new, runtime_source=os.environ.get('STOCKVISION_SOURCE_SHA', ''))
    # Preserve the original observation and its checksums in the resumed state.
    state['pipeline_modal_serving_context'] = {**old, 'expected_source_sha':new['expected_source_sha']}
    lineage = {'schema_version':'pipeline-saved-l2-resume-v1', 'source_uri':uri,
        'source_generation':generation, 'source_sha256':checksum, 'source_runtime_sha':source_sha,
        'runtime_sha':new['expected_source_sha'], 'original_created_at':envelope.get('created_at'),
        'resumed_at':datetime.now(timezone.utc).isoformat(), 'scope':'paper_transport_recovery',
        'run_date':run_date, 'run_id':run_id, 'l2_rerun':False, 'fits':0}
    # Source-specific create-only claim survives all failures; no automatic replay.
    claim_key = 'pipeline-v2/saved-l2-resumes/v1/' + hashlib.sha256((run_id + checksum).encode()).hexdigest()
    await asyncio.to_thread(bucket.blob(claim_key).upload_from_string,
        json.dumps(lineage, sort_keys=True), content_type='application/json', if_generation_match=0)
    state['saved_l2_resume'] = lineage
    # The original builder still validates complete frozen sources, feature and
    # sequence contracts. All required inputs must already be in this state.
    request = await _build_pipeline_modal_prediction_payload(state, state_gcs_uri='')
    assert_canonical_window_open(run_date)
    state_uri = await asyncio.to_thread(_write_pipeline_async_state_artifact, state)
    request['state_gcs_uri'] = state_uri
    spawned = await asyncio.to_thread(_spawn_pipeline_prediction_bundle_from_artifact, request)
    return {'status':'deferred','deferred_reason':'modal_prediction_callback','run_date':run_date,
        'metrics':{'async_modal_prediction':{**spawned,'status':'triggered','state_gcs_uri':state_uri},
                   'timesfm_l2_summary':state.get('timesfm_l2_summary') or state.get('timesfm_l175_summary') or {},
                   'saved_l2_resume':lineage}, 'errors':list(state.get('errors') or [])}
