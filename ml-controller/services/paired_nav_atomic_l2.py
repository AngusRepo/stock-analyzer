"""Own-slate L2 continuation using the original daily node and frozen policy.

No alternate feature owner, model training, promotion or maturity authority.
Completed slate outputs survive retries; failed slates remain explicit.
"""
from copy import deepcopy

from services.paired_nav_journal import digest
from services.paired_nav_collection import shadow_failure
from services.pipeline_slate_artifacts import load, load_owned, verify, is_ref, keep, content_digest, checkpoint_async
from services.paired_nav_atomic_inputs import validate_daily_inputs


async def prepare_atomic_l2(state, formal_result, *, enrich):
    pre = state.get('paired_nav_atomic_pre_l2') or {}
    if pre.get('status') != 'pre_l2_payloads_built':
        raise ValueError('paired_nav_atomic_pre_l2_missing')
    source = validate_daily_inputs(state.get('paired_nav_atomic_inputs'), signal_date=state['run_date'],
        producer_run_id=state['screener_run_id'], formal_stocks=state['active_stocks'])
    if (pre.get('input_checksum') != source.get('input_checksum')
            or pre.get('source_checksum') != (state.get('payload_source_observations') or {}).get('source_checksum')):
        raise ValueError('paired_nav_atomic_l2_source_mismatch')
    if set(pre.get('slates', {})) != set(source['candidate_stocks']):
        raise ValueError('paired_nav_atomic_l2_population_changed')
    if set(pre.get('holding_slates', {})) != set(source.get('holding_scopes', {})):
        raise ValueError('paired_nav_atomic_l2_holdings_changed')
    context = state.get('pipeline_timesfm_context')
    sequence = state.get('pipeline_sequence_observations')
    if not context or not sequence:
        raise ValueError('paired_nav_atomic_l2_frozen_context_missing')
    if formal_result.get('timesfm_l2_summary', {}).get('status') not in {'ready', 'blocked', 'skipped'}:
        raise ValueError('paired_nav_atomic_l2_formal_inference_failed')
    formal_payloads = formal_result.get('payloads', state['payloads'])
    saved = state.get('paired_nav_atomic_l2')
    formal_input_checksum = digest(state['payloads'])
    if saved is not None and saved.get('status') != 'failed':
        if (saved.get('output_checksum') != digest({k: v for k, v in saved.items() if k != 'output_checksum'})
                or formal_input_checksum not in {saved.get('formal_input_payload_checksum'), saved.get('formal_payload_checksum')}):
            raise ValueError('paired_nav_atomic_l2_retry_inputs_changed')
        # The saved daily state contains post-L2 payloads. Accept exactly the
        # recorded input OR output, not arbitrary metadata stripped for retry.
        formal_input_checksum = saved['formal_input_payload_checksum']
    else:
        saved = {}
    input_checksum = digest([pre, context, sequence, formal_input_checksum, digest(formal_payloads)])
    if saved and saved.get('input_checksum') != input_checksum:
        raise ValueError('paired_nav_atomic_l2_retry_inputs_changed')
    # Identical complete inputs can share computation. Symbols alone cannot:
    # eligibility, peer features and per-slate sidecar context may differ.
    # The wrapper also returns the full frozen sequence/context for persistence.
    # They are not L2 slate outputs: copying them here only to discard them below
    # duplicates the whole observation pool. Keep the same isolated copies of
    # the only two fields consumed from each cached result.
    scope = state.get('pipeline_slate_scope')
    # Cache references, not all completed payload lists. Inline legacy input
    # keeps its compatibility behavior; new production state always has a scope.
    cache = {formal_input_checksum: {
        'payloads': keep(formal_payloads, state),
        'timesfm_l2_summary': deepcopy(formal_result['timesfm_l2_summary'])}}
    policy_key = digest([context, sequence])

    failures = {}

    async def enrich_group(group):
        outputs = {}
        for definition, reference in pre.get(group, {}).items():
            key = None
            prior = (saved.get(group) or {}).get(definition)
            if prior and prior.get('status') == 'ready':
                if is_ref(prior['payloads']):
                    verify(prior['payloads'], scope)
                outputs[definition] = deepcopy(prior)
                continue
            try:
                key = content_digest(reference)
                if key in failures:
                    outputs[definition] = deepcopy(failures[key])
                    continue
                if key not in cache:
                    async def compute():
                        payloads = load_owned(reference, scope)
                        child = {'run_date': state['run_date'], 'payloads': payloads,
                            'pipeline_timesfm_context': deepcopy(context),
                            'pipeline_sequence_observations': deepcopy(sequence)}
                        result = await enrich(child)
                        status = (result.get('timesfm_l2_summary') or {}).get('status')
                        if status not in {'ready', 'blocked', 'skipped'}:
                            raise ValueError('paired_nav_atomic_l2_inference_failed')
                        # A no-output result must retain the original input even
                        # if an injected/legacy enrichment mutated its private copy.
                        output_payloads = result['payloads'] if 'payloads' in result else load(reference, scope)
                        return {'payloads': keep(output_payloads, state),
                                'timesfm_l2_summary': deepcopy(result['timesfm_l2_summary'])}
                    if scope:
                        record = await checkpoint_async(scope, ['l2', policy_key, key], compute)
                        cache[key] = load(record, scope)
                    else:
                        cache[key] = await compute()
                result = cache[key]
                outputs[definition] = {'status': 'ready', 'payloads': deepcopy(result['payloads']),
                    'summary': deepcopy(result['timesfm_l2_summary']), 'input_payload_checksum': key}
            except Exception as exc:
                outputs[definition] = shadow_failure('atomic_l2_slate', exc)
                if key is not None:
                    failures[key] = outputs[definition]
        return outputs
    outputs = await enrich_group('slates')
    holding_outputs = await enrich_group('holding_slates')
    body = {'schema_version': 'paired-nav-atomic-l2-v1', 'signal_date': state['run_date'],
        'input_checksum': input_checksum, 'slates': outputs, 'holding_slates': holding_outputs,
        'status': 'l2_payloads_built' if all(r['status'] == 'ready'
            for r in [*outputs.values(), *holding_outputs.values()]) else 'incomplete',
        'formal_input_payload_checksum': formal_input_checksum,
        'formal_payload_checksum': digest(formal_payloads),
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
