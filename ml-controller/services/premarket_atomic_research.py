"""After-close Atomic calculation from published inputs; no account registration.

The serving parent stays immutable. Additional candidate evidence is observed
after close and is explicitly retrospective, never prospective execution proof.
"""
from copy import deepcopy
from datetime import datetime, timezone

from services.paired_nav_journal import digest, read_snapshot, freeze_snapshot


def _time_and_parent(state, *, query):
    if state.get('premarket_execution_scope') != 'postclose':
        raise ValueError('atomic_research_requires_postclose_scope')
    context = state.get('premarket_context') or {}
    close = datetime.fromisoformat(context['trade_date']+'T13:30:00+08:00')
    if datetime.now(timezone.utc) < close or context['trade_date'] <= state['run_date']:
        raise ValueError('atomic_research_before_close')
    from services.premarket_publication import read
    publication = read(state['run_date'], state['producer_run_id'])
    collection = state.get('paired_nav_collection') or {}
    if (not publication or publication['context_checksum'] != context['checksum']
            or publication['allocation_snapshot_id'] != collection.get('snapshot_id')):
        raise ValueError('atomic_research_publication_mismatch')
    parent = read_snapshot(query, collection['snapshot_id'])
    if (parent['manifest']['signal_date'] != state['run_date']
            or parent['manifest']['snapshot_kind'] != 'allocation_context'):
        raise ValueError('atomic_research_parent_mismatch')
    return publication, parent


def calculate(state, *, query, writer, market_query, core_query):
    from services.paired_nav_atomic_inputs import validate_daily_inputs
    from services.paired_nav_atomic_personas import atomic_persona_slates, compute_atomic_personas
    from services.paired_nav_atomic_recommendation import prepare_atomic_recommendations, run_atomic_recommendations
    from services.paired_nav_atomic_allocation import run_atomic_allocations
    from services.recommendation_source_context import capture_recommendation_sources

    publication, parent = _time_and_parent(state, query=query)
    source = validate_daily_inputs(state.get('paired_nav_atomic_inputs'),
        signal_date=state['run_date'], producer_run_id=state['screener_run_id'],
        formal_stocks=state['active_stocks'], readonly=True)
    body = dict(schema_version='premarket-atomic-research-v1',
        signal_date=state['run_date'], run_id=state['producer_run_id'],
        publication_checksum=publication['checksum'],
        parent_snapshot_id=parent['manifest']['snapshot_id'],
        parent_payload_checksum=parent['manifest']['payload_checksum'],
        atomic_input_checksum=source['input_checksum'],
        evidence_kind='retrospective_research', production_effect=False,
        can_write_order=False, nav_maturity_credit=0, prospective=False)
    if not source['population']['replacements']:
        body.update(status='completed', reason='verified_empty_atomic_population', definition_count=0)
        return {**body, 'checksum': digest(body)}

    child_run = state['producer_run_id']+':postclose-atomic:'+publication['checksum']
    child_id = digest(['allocation_context', state['run_date'], child_run])
    existing = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [child_id])
    if existing:
        child = read_snapshot(query, child_id)
        lineage = child['payload']['content'].get('postclose_research_lineage')
        if lineage != body or child['manifest']['prospective'] != 0:
            raise ValueError('atomic_research_child_identity_changed')
    else:
        research = dict(state)
        research['paired_nav_atomic_personas'] = compute_atomic_personas(
            prepared=atomic_persona_slates(research), run_date=state['run_date'],
            context=state['pipeline_persona_context'])
        prepared = prepare_atomic_recommendations(research)
        original = parent['payload']['content']['recommendation_context']
        old_source = original['inputs']['recommendation_source_context']
        sources = capture_recommendation_sources(run_date=state['run_date'],
            formal_recs=old_source['inputs']['formal_recs'],
            candidate_recs={k:d['screener_recs'] for k,d in prepared['definitions'].items() if d['status']=='ready'},
            knowledge_cutoff=old_source['inputs']['knowledge_cutoff'],
            query=market_query, core_query=core_query)
        # A later observation cannot silently change any serving feature.
        if sources['formal'] != old_source['formal']:
            raise ValueError('atomic_research_formal_sources_changed')
        recommendation = deepcopy(original)
        recommendation['inputs']['recommendation_source_context'] = sources
        recommendation['content_checksum'] = digest({k:v for k,v in recommendation.items() if k!='content_checksum'})
        outputs = run_atomic_recommendations(prepared=prepared,
            formal_context=recommendation, source_context=sources)
        if outputs['status'] != 'recommendations_materialized':
            raise ValueError('atomic_research_recommendations_incomplete')
        content = {**deepcopy(parent['payload']['content']),
            'recommendation_context': recommendation,
            'atomic_recommendation_inputs': prepared,
            'atomic_recommendation_result': outputs,
            'postclose_research_lineage': body}
        manifest = freeze_snapshot(signal_date=state['run_date'], source_run_id=child_run,
            snapshot_kind='allocation_context', content=content, query=query, writer=writer)
        if manifest['prospective'] != 0:
            raise ValueError('atomic_research_cannot_be_prospective')
        child = read_snapshot(query, child_id)
    allocations = run_atomic_allocations(snapshot_id=child_id, query=query)
    if allocations['status'] != 'allocations_materialized':
        raise ValueError('atomic_research_allocations_incomplete')
    body.update(status='completed', reason='retrospective_allocations_verified',
        child_snapshot_id=child_id, child_payload_checksum=child['manifest']['payload_checksum'],
        definition_count=len(allocations['definitions']), allocations=allocations)
    return {**body, 'checksum': digest(body)}


def validate_result(result, state):
    if (not isinstance(result, dict) or result.get('schema_version')!='premarket-atomic-research-v1'
            or result.get('checksum')!=digest({k:v for k,v in result.items() if k!='checksum'})
            or result.get('status')!='completed' or result.get('signal_date')!=state['run_date']
            or result.get('run_id')!=state['producer_run_id']
            or result.get('parent_snapshot_id')!=(state.get('paired_nav_collection') or {}).get('snapshot_id')
            or result.get('evidence_kind')!='retrospective_research'
            or any(result.get(k) is not False for k in ('production_effect','can_write_order','prospective'))
            or type(result.get('nav_maturity_credit')) is not int or result['nav_maturity_credit']!=0):
        raise ValueError('postclose_atomic_research_not_verified')
