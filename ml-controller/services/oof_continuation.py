"""Bounded waiting for verified cloud compute, separate from failed dependencies."""

# Two serialized OOF runs may each use eight hours, followed by a five-hour
# full fit. Worker polling backs off to 30 minutes; 64 polls cover that budget.
COMPUTE_WAIT_MAX_ATTEMPTS = 64
FAILURE_MAX_ATTEMPTS = 12


def continuation_limit(result):
    full_fit = result.get('full_fit_dispatch') or {}
    running_full_fit = (
        full_fit.get('reason') == 'modal_full_fit_still_running'
        and (full_fit.get('modal_poll') or {}).get('status') == 'pending'
    )
    newly_dispatched = (full_fit.get('status') == 'dispatched'
        and bool(full_fit.get('run_id'))
        and bool(((full_fit.get('dispatch') or {}).get('orchestrator_result') or {}).get('function_call_id')))
    if (not result.get('nav_retry_required')
            and (result.get('external_compute_pending') is True or running_full_fit or newly_dispatched)):
        return COMPUTE_WAIT_MAX_ATTEMPTS
    return FAILURE_MAX_ATTEMPTS


async def probe_exact_cohort_wait(bucket, cohort_id):
    """Never replace a running call or count a failed call as healthy waiting."""
    import json
    from services.modal_client import probe_modal_function_call
    blob = bucket.blob(f'walk_forward/oof_cohorts/{cohort_id}/dispatch.json')
    if not blob.exists():
        return {}
    dispatch = json.loads(blob.download_as_text())
    call_id = dispatch.get('function_call_id')
    if not call_id:
        return {}
    probe = await probe_modal_function_call(call_id)
    if probe.get('status') == 'completed' and bucket.blob(f'walk_forward/oof_cohorts/{cohort_id}/manifest.json').exists():
        return {'manifest_published': True}
    if probe.get('status') in ('failed', 'completed'):
        raise ValueError('oof_exact_cohort_terminal_without_ready_manifest:' + probe['status'])
    return {'external_compute_pending': probe.get('status') == 'running',
            'function_call_id': call_id, 'compute_probe': probe}
