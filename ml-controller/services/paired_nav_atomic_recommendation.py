"""Own Atomic seeds/ML/personas through the original recommendation functions."""
from copy import deepcopy

from services.paired_nav_journal import digest
from services.paired_nav_atomic_personas import atomic_persona_slates, compute_atomic_personas
from services.screener_core_replay import materialize_atomic_core_domains
from services.screener_candidate_merge import materialize_candidate_screener_seeds
from services.screener_seed_domain_merge import verify_canonical_seed_boundary


def prepare_atomic_recommendations(state):
    prepared = atomic_persona_slates(state)
    source = state['paired_nav_atomic_inputs']
    context = state['pipeline_screener_seed_context']
    if verify_canonical_seed_boundary(source['population'], context) != source.get('screener_seed_boundary'):
        raise ValueError('atomic_recommendation_canonical_boundary_changed')
    core = materialize_atomic_core_domains(source['population'], context)
    seeds = materialize_candidate_screener_seeds(source['population'], core, context)
    if core != source.get('core_domain_replay') or seeds != source.get('candidate_recommendation_seeds'):
        raise ValueError('atomic_recommendation_seed_source_changed')
    personas = compute_atomic_personas(prepared=prepared, run_date=state['run_date'],
                                      context=state['pipeline_persona_context'])
    if personas != state.get('paired_nav_atomic_personas'):
        raise ValueError('atomic_recommendation_persona_source_changed')
    definitions = {k: {'status': 'unavailable', 'evidence': deepcopy(v)} for k, v in prepared['unavailable'].items()}
    for key, payloads in prepared['slates'].items():
        seed = seeds.get('definitions', {}).get(key, {})
        persona = personas['definitions'][key]
        if seed.get('status') != 'materialized' or persona.get('status') != 'ready':
            definitions[key] = {'status': 'unavailable', 'seed': deepcopy(seed), 'persona': deepcopy(persona)}
            continue
        ml = state['paired_nav_atomic_ml']
        slate_key = ml['definitions'][key]['candidate_key']
        predictions = ml['slates'][slate_key]['predictions']
        rows = seed['screener_recs']
        if {r['symbol'] for r in rows} != set(predictions) or {p['symbol'] for p in payloads} != set(predictions):
            raise ValueError('atomic_recommendation_membership_changed')
        definitions[key] = dict(status='ready', screener_recs=deepcopy(rows),
            inference_lineage={k: deepcopy(ml['definitions'][key][k]) for k in ('baseline_key', 'candidate_key')},
            candidate_seed_inputs=deepcopy(seed['inputs']), predictions=deepcopy(predictions),
            payloads=deepcopy(payloads), persona_opinions=deepcopy(persona['opinions']),
            l2_summary=deepcopy(state['paired_nav_atomic_l2']['slates'][key]['summary']))
        definitions[key]['inference_lineage']['serving_manifest_digest'] = state['pipeline_modal_serving_context']['serving_manifest_digest']
        holding_predictions = []
        for scope in ml.get('holding_evaluations', []):
            if scope['definition_checksum'] != key:
                continue
            stock = scope['target_symbol']
            output = ml['slates'][scope['slate_key']]
            if output['status'] != 'ready' or output['input_checksum'] != scope['slate_key'] or stock not in output['predictions']:
                raise ValueError('atomic_recommendation_holding_prediction_missing')
            holding_predictions.append({**deepcopy(scope), 'prediction': deepcopy(output['predictions'][stock])})
        if source.get('native_holdings') is not None:
            definitions[key]['holding_predictions'] = holding_predictions
    body = dict(schema_version='paired-nav-atomic-recommendation-inputs-v1', signal_date=state['run_date'],
        policy_population={'source_checksum': source['population']['source_checksum'],
            'policy_context': deepcopy(source['population'].get('policy_context')),
            'replacements': [{k: deepcopy(r[k]) for k in ('definition_checksum', 'replacement', 'weight_policy_version') if k in r}
                for r in source['population']['replacements']]},
        input_checksum=prepared['input_checksum'], persona_checksum=personas['output_checksum'],
        seed_checksum=seeds.get('output_checksum'), definitions=definitions,
        production_effect=False, promotion_allowed=False, nav_maturity_credit=0)
    if source.get('native_holdings') is not None:
        body['native_holdings'] = deepcopy(source['native_holdings'])
    return {**body, 'input_hash': digest(body)}


def run_atomic_recommendations(*, prepared, formal_context, source_context):
    from services.paired_nav_recommendation_path import replay_recommendation_context, run_recommendation_path
    from services.recommendation_source_context import replay_recommendation_sources
    from services.screener_seed_domain_merge import merge_screener_seed_domains

    if prepared.get('input_hash') != digest({k: v for k, v in prepared.items() if k != 'input_hash'}):
        raise ValueError('atomic_recommendation_inputs_invalid')
    replay_recommendation_context(formal_context)
    frozen = replay_recommendation_sources(source_context)
    ready = {k: d['screener_recs'] for k, d in prepared['definitions'].items() if d['status'] == 'ready'}
    if (frozen['inputs']['candidate_recs'] != ready
            or frozen['inputs']['formal_recs'] != formal_context['inputs']['screener_recs']
            or frozen['source_checksum'] != (formal_context['inputs'].get('recommendation_source_context') or {}).get('source_checksum')
            or prepared['signal_date'] != frozen['inputs']['run_date']):
        raise ValueError('atomic_recommendation_source_scope_changed')
    definitions = {}
    for key, definition in prepared['definitions'].items():
        if definition['status'] != 'ready':
            definitions[key] = deepcopy(definition)
            continue
        evidence = frozen['definitions'][key]
        if frozen['formal']['status'] != 'captured':
            definitions[key] = {'status': 'unavailable', 'reason': 'incumbent_recommendation_sources_incomplete',
                                'evidence': deepcopy(frozen['formal'])}
            continue
        if evidence['status'] != 'captured':
            definitions[key] = {'status': 'unavailable', 'reason': 'recommendation_sources_incomplete',
                                'evidence': deepcopy(evidence)}
            continue
        try:
            rows = merge_screener_seed_domains(run_date=prepared['signal_date'], **definition['candidate_seed_inputs'])
            if rows != definition['screener_recs']:
                raise ValueError('atomic_recommendation_original_merge_mismatch')
            # Formal seed/source contexts cannot attest a different candidate.
            inputs = deepcopy({k:v for k,v in formal_context['inputs'].items()
                               if k not in {'screener_seed_context', 'recommendation_source_context'}})
            for field in ('screener_recs', 'predictions', 'payloads', 'l2_summary'):
                inputs[field] = deepcopy(definition[field])
            inputs['filter_options']['persona_opinions'] = deepcopy(definition['persona_opinions'])
            for field in ('fundamental_quality_by_symbol', 'pit_sector_alpha_by_symbol'):
                inputs['filter_options'][field] = deepcopy(evidence[field])
            before = deepcopy(inputs)
            result = run_recommendation_path(inputs=inputs)
            definitions[key] = dict(status='recommendations_materialized', inputs=before, result=result,
                                    post_predictions=deepcopy(inputs['predictions']))
        except Exception as exc:
            definitions[key] = {'status': 'unavailable', 'reason': f'{type(exc).__name__}:{exc}'}
    body = dict(schema_version='paired-nav-atomic-recommendation-v1', signal_date=prepared['signal_date'],
        input_hash=prepared['input_hash'], formal_context_checksum=formal_context['content_checksum'],
        source_checksum=source_context['source_checksum'], definitions=definitions,
        status='recommendations_materialized' if all(d['status'] == 'recommendations_materialized' for d in definitions.values()) else 'incomplete',
        production_effect=False, promotion_allowed=False, nav_maturity_credit=0)
    return {**body, 'output_checksum': digest(body)}
