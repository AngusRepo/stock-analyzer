"""Explicit single-use recovery of a verified pre-L2 checkpoint after OOM."""
from __future__ import annotations
import asyncio
import gzip
import hashlib
import json
import os
import re
from datetime import datetime, timezone


def validate_transition(original, resumed, report, *, run_date, run_id, source_sha):
    from services.pipeline_input_events import _validate_pre_l2_state
    from services.paired_nav_journal import digest
    for state in (original, resumed):
        _validate_pre_l2_state(state)
        if state['run_date'] != run_date or state['producer_run_id'] != run_id:
            raise ValueError('saved_pre_l2_identity_mismatch')
        if any(state.get(k) for k in ('payloads', 'pipeline_payload_identity', 'modal_prediction_bundle', 'saved_pre_l2_resume')):
            raise ValueError('saved_pre_l2_already_continued')
    if (report.get('status') != 'PASS' or report.get('source_sha') != source_sha
            or not re.fullmatch('[a-f0-9]{40}', source_sha)
            or report.get('business_date') != run_date or report.get('parent_run_id') != run_id
            or report.get('receipt_checksum') != digest({k:v for k,v in report.items() if k!='receipt_checksum'})
            or report.get('formal_old_new_equal') is not True or report.get('readbacks_equal') is not True
            or report.get('retry_built_slates') != 0):
        raise ValueError('saved_pre_l2_acceptance_invalid')
    old=original['pipeline_modal_serving_context'];new=resumed['pipeline_modal_serving_context']
    if old.get('expected_source_sha') != report.get('old_source_sha') or new != {**old,'expected_source_sha':source_sha}:
        raise ValueError('saved_pre_l2_context_mutated')
    if resumed.get('timexer_feature_source') != report.get('feature_source') or original.get('timexer_feature_source'):
        raise ValueError('saved_pre_l2_feature_source_mismatch')
    excluded={'pipeline_modal_serving_context','timexer_feature_source'}
    if digest({k:v for k,v in original.items() if k not in excluded}) != digest({k:v for k,v in resumed.items() if k not in excluded}):
        raise ValueError('saved_pre_l2_frozen_inputs_mutated')
    return resumed


async def resume_saved_pre_l2(*, run_date, run_id):
    from google.cloud import storage
    from services.pipeline_input_events import run_prefix
    from services.pipeline_prediction_recovery import registry_key
    from services.pipeline_saved_l2_resume import validate_context_transition
    from services.paper_strategy_mode import from_manifest
    from graphs.daily_pipeline_v2 import (_attach_pipeline_modal_serving_context,
        _continue_pipeline_before_l2, assert_canonical_window_open)
    bucket_name=os.environ.get('GCS_BUCKET_NAME','');source=os.environ.get('STOCKVISION_SOURCE_SHA','')
    uri=os.environ.get('PIPELINE_PRE_L2_ACCEPTANCE_URI','');checksum=os.environ.get('PIPELINE_PRE_L2_ACCEPTANCE_SHA256','')
    prefix=f'gs://{bucket_name}/pipeline-v2/release-acceptance/{source}/full-input-'
    if not bucket_name or not re.fullmatch('[a-f0-9]{64}',checksum) or uri != prefix+checksum+'.json':
        raise ValueError('saved_pre_l2_acceptance_pin_invalid')
    assert_canonical_window_open(run_date)
    bucket=storage.Client().bucket(bucket_name)
    def read(uri):
        blob=bucket.blob(uri.split('/',3)[3]);blob.reload()
        return blob.download_as_bytes(if_generation_match=int(blob.generation),checksum='crc32c')
    report=json.loads(await asyncio.to_thread(read,uri))
    if report.get('receipt_checksum') != checksum:raise ValueError('saved_pre_l2_acceptance_checksum_mismatch')
    async def state(key):
        path=report[key];expected=f'gs://{bucket_name}/'+run_prefix(run_id,run_date)+'checkpoints/'
        if not path.startswith(expected) or not re.fullmatch('[a-f0-9]{64}\.json\.gz',path.removeprefix(expected)):
            raise ValueError('saved_pre_l2_checkpoint_scope_mismatch')
        raw=await asyncio.to_thread(read,path)
        if path != expected+hashlib.sha256(raw).hexdigest()+'.json.gz':raise ValueError('saved_pre_l2_checkpoint_checksum_mismatch')
        envelope=json.loads(gzip.decompress(raw))
        if envelope.get('schema_version') != 'pipeline-pre-l2-state-v1':raise ValueError('saved_pre_l2_schema_invalid')
        return envelope['state']
    original=await state('original_state_uri');resumed=await state('recovery_state_uri')
    validate_transition(original,resumed,report,run_date=run_date,run_id=run_id,source_sha=source)
    del original
    old=resumed['pipeline_modal_serving_context']
    if not from_manifest(old.get('serving_manifest'),signal_date=run_date):raise ValueError('saved_pre_l2_paper_policy_required')
    if await asyncio.to_thread(bucket.blob(registry_key(run_date,run_id)).exists):raise ValueError('saved_pre_l2_prediction_already_registered')
    current=await _attach_pipeline_modal_serving_context(resumed)
    validate_context_transition(old,current,runtime_source=source)
    resumed['pipeline_modal_serving_context']=old
    lineage=dict(schema_version='pipeline-saved-pre-l2-resume-v1',acceptance_uri=uri,acceptance_checksum=checksum,
        run_id=run_id,run_date=run_date,source_sha=source,resumed_at=datetime.now(timezone.utc).isoformat(),fits=0)
    claim='pipeline-v2/saved-pre-l2-resumes/v1/'+hashlib.sha256((run_id+checksum).encode()).hexdigest()+'.json'
    await asyncio.to_thread(bucket.blob(claim).upload_from_string,json.dumps(lineage,sort_keys=True),content_type='application/json',if_generation_match=0)
    resumed['saved_pre_l2_resume']=lineage
    return await _continue_pipeline_before_l2(resumed)
