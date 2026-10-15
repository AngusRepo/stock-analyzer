"""Durable inference fence: resume one Modal call, never infer twice on retry."""
from datetime import datetime, timezone
import json
from services.l4_forward_materialization import digest, timestamp
from services.l4_forward_refresh import publish

PREFIX = 'l4_distribution/native_observations/v1/'


async def modal_spawn(request):
    import modal
    call = await modal.Function.from_name('stockvision-ml', 'l4_native_prediction').spawn.aio(request)
    return call.object_id


async def modal_poll(call_id):
    import modal
    from modal import exception
    try:
        return dict(status='completed', result=await modal.FunctionCall.from_id(call_id).get.aio(timeout=0))
    except (TimeoutError, exception.TimeoutError):
        return dict(status='running')
    except (exception.AuthError, exception.ConnectionError, exception.InternalError, exception.ServiceError):
        return dict(status='unknown')


async def advance(bucket, key, envelope_ref, request, *, request_ref, spawn=None, poll=None, now=None):
    from google.api_core.exceptions import PreconditionFailed
    from services.l4_native_observation import read_reference
    clock = now or datetime.now(timezone.utc)
    root = PREFIX + 'dispatch/' + key + '/'
    output = bucket.blob(root + 'output.json')
    receipt = bucket.blob(root + 'receipt.json')
    if receipt.exists():
        saved = json.loads(receipt.download_as_bytes())
        if saved['envelope'] != envelope_ref or saved['request_checksum'] != digest(request):
            raise ValueError('l4_native_dispatch_input_changed')
    else:
        try:
            bucket.blob(root + 'claim.json').upload_from_string(json.dumps(dict(envelope=envelope_ref,
                created_at=clock.isoformat())), if_generation_match=0)
        except PreconditionFailed:
            raise ValueError('l4_native_dispatch_acknowledgement_missing')
        call_id = await (spawn or modal_spawn)(dict(schema_version='l4-native-request-reference-v1',
            request_reference=request_ref))
        if not isinstance(call_id, str) or not call_id:
            raise ValueError('l4_native_dispatch_acknowledgement_missing')
        saved = dict(envelope=envelope_ref, request_checksum=digest(request),
                     function_call_id=call_id, dispatched_at=clock.isoformat())
        receipt.upload_from_string(json.dumps(saved), if_generation_match=0)
    if output.exists():
        ref = json.loads(output.download_as_bytes())
        return dict(status='completed', result=read_reference(bucket, ref), reference=ref)
    result = await (poll or modal_poll)(saved['function_call_id'])
    if result['status'] == 'completed':
        ref = publish(bucket, 'native_outputs', result['result'])
        try:
            output.upload_from_string(json.dumps(ref), if_generation_match=0)
        except PreconditionFailed:
            if json.loads(output.download_as_bytes()) != ref:
                raise ValueError('l4_native_dispatch_output_changed')
        return dict(status='completed', result=result['result'], reference=ref)
    if result['status'] not in ('running', 'unknown'):
        raise ValueError('l4_native_dispatch_failed')
    # Include a bounded queue/startup allowance beyond the two-hour function.
    if (clock - timestamp(saved['dispatched_at'])).total_seconds() > 9000:
        raise ValueError('l4_native_dispatch_deadline_exceeded')
    return dict(status='pending', reason='l4_native_inference_pending',
                function_call_id=saved['function_call_id'], compute_status=result['status'],
                external_compute_pending=result['status'] == 'running',
                training_dispatched=False, promoted=False)
