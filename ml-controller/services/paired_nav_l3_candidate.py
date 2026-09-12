"""Frozen Active-8 candidates -> genuine recommendation/allocation contrasts.

No fit, no serving grant, no incumbent-rank fallback. Existing daily challenger
inference is reused only when EVERY base artifact identity matches the model.
"""
from copy import deepcopy
from datetime import date, datetime, timezone
import json

from services.active_model_policy import ACTIVE_ALPHA_MODELS, CORE_CROSS_SECTIONAL_ALPHA_MODELS
from services.active8_score_semantics import (
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION, normalize_active8_challenger_scores,
)
from services.ensemble_v2 import (
    validate_active8_ensemble_candidate, build_formal_model_input_contract,
    _evaluate_validated_ensemble,
)
from services.paired_nav_journal import digest, freeze_snapshot, number, read_snapshot, _timestamp


def _identity(row):
    return {key: str(row.get(key) or '').strip() for key in
            ('artifact_id', 'version', 'checksum', 'candidate_type')}


def _validate_payload_identity(row, payload):
    validate_active8_ensemble_candidate(payload)
    expected_id = f"active8-ensemble:{payload['cohort_id']}:{payload['payload_checksum'][:16]}"
    if (row.get('artifact_id') != expected_id or row.get('validation_decision') != payload['validation']['decision']
            or json.loads(row['validation_json']) != payload['validation']
            or not row.get('training_run_id') or not row.get('archive_uri')
            or any(row.get(key) != payload.get(key) for key in
                   ('cohort_id', 'knowledge_cutoff_date', 'schema_version', 'payload_checksum', 'base_artifact_set_checksum'))
            or digest(payload['base_artifacts']) != payload['base_artifact_set_checksum']
            or digest(payload['observation_artifacts']) != payload.get('observation_artifact_set_checksum')
            or any(payload['base_artifacts'][name] != payload['observation_artifacts'][name]
                   for name in payload['selected_models'])):
        raise ValueError('paired_nav_l3_artifact_registry_mismatch')


def load_candidate_ensembles(*, manifest, signal_date, decision_cutoff, query):
    """Select by frozen base identity/time, never by subsequently observed return."""
    rows = manifest.get('active8_shadow_candidates') or []
    base = {}
    for row in rows:
        name = row.get('model')
        if (name not in ACTIVE_ALPHA_MODELS or name in base
                or row.get('production_effect') is not False or row.get('vote_weight') != 0
                or row.get('status') != 'challenger' or row.get('effective_status') != 'challenger'):
            raise ValueError('paired_nav_l3_base_selection_invalid')
        base[name] = _identity(row)
    result = {'schema_version': 'paired-nav-l3-candidate-selection-v1',
        'signal_date': signal_date, 'decision_cutoff': decision_cutoff,
        'base_artifacts': base, 'candidates': [], 'production_effect': False}
    if set(base) != set(ACTIVE_ALPHA_MODELS):
        return {**result, 'status': 'awaiting_complete_base_candidate_bundle'}
    cutoff = _timestamp(decision_cutoff)
    if cutoff.astimezone(timezone.utc).date() > date.fromisoformat(signal_date):
        raise ValueError('paired_nav_l3_decision_cutoff_after_signal')
    candidates = query("SELECT * FROM active8_ensemble_artifacts_v1 WHERE state='candidate' "
        "AND production_effect=0 AND julianday(created_at)<=julianday(?) "
        "AND knowledge_cutoff_date<=? ORDER BY created_at,artifact_id", [decision_cutoff, signal_date])
    seen = set()
    for row in candidates:
        payload = json.loads(row['payload_json'])
        _validate_payload_identity(row, payload)
        # D1 CURRENT_TIMESTAMP is UTC without an offset. Do not interpret it as Taipei.
        created = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        created = created.replace(tzinfo=timezone.utc) if created.tzinfo is None else created
        if (created > cutoff or row['state'] != 'candidate' or row['production_effect'] != 0
                or date.fromisoformat(payload['knowledge_cutoff_date']) > date.fromisoformat(signal_date)):
            raise ValueError('paired_nav_l3_candidate_time_or_authority_invalid')
        if payload['observation_artifacts'] != base:
            continue
        if payload['payload_checksum'] in seen:
            raise ValueError('paired_nav_l3_duplicate_candidate')
        seen.add(payload['payload_checksum'])
        result['candidates'].append({'registry': deepcopy(row), 'artifact': payload})
    return {**result, 'status': 'candidate_ensembles_frozen' if result['candidates']
            else 'awaiting_matching_executable_ensemble'}


def infer_candidate_predictions(*, predictions, candidate, signal_date):
    """Use only the candidate's normalized daily scores and exact artifact IDs."""
    artifact = candidate['artifact']
    _validate_payload_identity(candidate['registry'], artifact)
    if date.fromisoformat(artifact['knowledge_cutoff_date']) > date.fromisoformat(signal_date):
        raise ValueError('paired_nav_l3_future_training_cutoff')
    # Check the complete cross-section against captured raw model outputs;
    # correct labels alone must not make reversed/altered rank values valid.
    normalized = deepcopy(predictions)
    candidate_rows = {name: {**identity, 'model': name, 'status': 'challenger',
        'effective_status': 'challenger', 'production_effect': False, 'vote_weight': 0.,
        'schema': {'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION}}
        for name, identity in artifact['observation_artifacts'].items()}
    for prediction in normalized.values():
        prediction['challenger_rank_scores'] = deepcopy(prediction.get('challenger_raw_model_scores') or {})
    normalize_active8_challenger_scores(normalized, candidate_rows=candidate_rows, run_date=signal_date)
    output = {}
    for symbol, original in predictions.items():
        lineage = original.get('challenger_model_score_lineage') or {}
        scores = original.get('challenger_rank_scores') or {}
        if (lineage.get('schema_version') != 'active8-challenger-score-lineage-v1'
                or lineage.get('semantic_version') != MODEL_SCORE_SEMANTIC_VERSION
                or lineage.get('target_semantic_version') != MODEL_TARGET_SEMANTIC_VERSION
                or lineage.get('run_date') != signal_date or lineage.get('complete') is not True
                or lineage.get('blockers') or lineage.get('production_effect') is not False
                or lineage.get('vote_weight') != 0 or not lineage.get('market_segment')
                or not (set(CORE_CROSS_SECTIONAL_ALPHA_MODELS) & set(artifact['selected_models'])).issubset(scores)
                or not set(scores).issubset(ACTIVE_ALPHA_MODELS)
                or set(scores) != set(lineage.get('available_models') or [])):
            raise ValueError('paired_nav_l3_candidate_scores_incomplete')
        for name, expected in artifact['observation_artifacts'].items():
            actual = {key: (lineage.get(field) or {}).get(name) for key, field in (
                ('artifact_id', 'candidate_artifact_ids'), ('version', 'candidate_artifact_versions'),
                ('checksum', 'candidate_artifact_checksums'), ('candidate_type', 'candidate_types_all'))}
            if actual != expected:
                raise ValueError('paired_nav_l3_candidate_prediction_identity_mismatch')
        for name, value in scores.items():
            if not 0 <= number(value, 'l3_rank') <= 1:
                raise ValueError('paired_nav_l3_rank_out_of_range')
            if (lineage.get('cross_section_sizes') or {}).get(name, 0) < max(3, lineage.get('minimum_cross_section', 3)):
                raise ValueError('paired_nav_l3_cross_section_incomplete')
        if scores != normalized[symbol]['challenger_rank_scores']:
            raise ValueError('paired_nav_l3_rank_raw_reconciliation_failed')
        pred = deepcopy(original)
        # Do not retain incumbent-derived features, votes or action authority.
        for key in ('ensemble_v2', 'ensemble_v2_error', 'formal_layer3_contract', 'core_family_evidence',
                    'core_family_vote', 'l4_alpha_ev', 'alpha_allocation', 'active8_action_authority',
                    'models', 'gnn', 'dlinear', 'patchtst', 'itransformer'):
            pred.pop(key, None)
        pred['rank_scores'] = deepcopy(scores)
        pred['raw_model_scores'] = deepcopy(original.get('challenger_raw_model_scores') or {})
        pred['model_score_lineage'] = {**deepcopy(lineage), 'schema_version': MODEL_SCORE_LINEAGE_SCHEMA_VERSION}
        pred['model_score_lineage'].update(
            coverage_policy='validated-bundle-selected-core-sequence-missingness-v1',
            ensemble_payload_checksum=artifact['payload_checksum'],
            selected_models=list(artifact['selected_models']))
        formal = build_formal_model_input_contract(pred, selected_models=artifact['selected_models'])
        if formal['complete'] is not True:
            raise ValueError('paired_nav_l3_candidate_model_contract_incomplete')
        pred['ensemble_v2'] = _evaluate_validated_ensemble(pred, artifact, formal)
        pred['ensemble_v2'].update(production_effect=False, promotion_allowed=False)
        pred['active8_action_authority'] = {'mode': 'paired_shadow_only', 'buy_authorized': False,
                                          'production_effect': False}
        output[symbol] = pred
    if not output:
        raise ValueError('paired_nav_l3_prediction_universe_empty')
    return output


def _native_predictions(predictions, identity):
    result = deepcopy(predictions)
    for pred in result.values():
        ensemble = pred.get('ensemble_v2') or {}
        if (ensemble.get('artifact_checksum') != identity['artifact_checksum']
                or ensemble.get('cohort_id') != identity['cohort_id']
                or ensemble.get('artifact_id') != identity['artifact_id']):
            raise ValueError('paired_nav_l3_arm_ensemble_identity_mismatch')
        pred['direction_accuracy'] = number(ensemble.get('confidence'), 'l3_confidence')
        pred['signal_raw'] = ensemble['signal']
    return result


def collect_ensemble_allocations(*, snapshot_id, query, writer):
    from services.paired_nav_lifecycle import resolve_pair_id, prepare_comparison_transitions
    from services.paired_nav_candidate_collection import allocation_policy_identity
    from services.paired_nav_recommendation_path import (
        replay_frozen_recommendation_allocation, run_recommendation_path, recommendation_source_identity)
    from services.paired_nav_intervention import run_isolated_allocation
    saved = read_snapshot(query, snapshot_id)
    manifest, context = saved['manifest'], saved['payload']['content']
    empty = {'plans': [], 'production_effect': False, 'nav_maturity_credit': 0}
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_allocation_context_required')
    if manifest['prospective'] != 1:
        return {**empty, 'status': 'historical_not_prospective'}
    rec_context = context.get('recommendation_context') or {}
    selection = rec_context.get('l3_candidate_selection')
    if isinstance(selection, dict) and selection.get('status') == 'failed':
        raise ValueError('paired_nav_l3_candidate_selection_failed:' + str(selection.get('reason')))
    if selection is None:
        return {**empty, 'status': 'legacy_context_without_l3_selection'}
    if (selection.get('schema_version') not in {'paired-nav-l3-candidate-selection-v1', 'paired-nav-l3-candidate-selection-v2'}
            or selection.get('signal_date') != manifest['signal_date']):
        raise ValueError('paired_nav_l3_selection_context_invalid')
    if not selection['candidates']:
        if selection.get('status') not in {'awaiting_complete_base_candidate_bundle', 'awaiting_matching_executable_ensemble'}:
            raise ValueError('paired_nav_l3_candidate_selection_incomplete')
        return {**empty, 'status': selection['status']}
    if (selection.get('status') != 'candidate_ensembles_frozen'
            or _timestamp(selection['decision_cutoff']) > _timestamp(manifest['frozen_at'])):
        raise ValueError('paired_nav_l3_selection_time_invalid')
    if not context.get('risk_config') or not context.get('trading_config'):
        raise ValueError('paired_nav_full_configuration_missing')
    incumbent = replay_frozen_recommendation_allocation(snapshot_id=snapshot_id, query=query)['allocation']
    formal = context['formal_baseline_identity']
    baseline_identity = {'artifact_id': formal['artifact_id'], 'cohort_id': formal['cohort_id'],
                         'artifact_checksum': formal['payload_checksum']}
    configuration = {key: context[key] for key in ('trading_config', 'risk_config', 'allocator_source_identity')}
    configuration.update(formal_baseline_identity=formal,
        allocator_policies=allocation_policy_identity(context['inputs']),
        l3_inference_source_identity=recommendation_source_identity())
    from services.paired_nav_execution_environment import configuration_environment
    configuration.update(configuration_environment(saved))
    config_checksum = digest(configuration)
    plans = []
    for candidate in selection['candidates']:
        registry = candidate['registry']
        for pin in candidate.get('registered_pairs') or []:
            if not pin.get('execution_snapshot_id'):
                raise ValueError('paired_nav_l3_registered_pin_invalid')
            registered = read_snapshot(query, pin['execution_snapshot_id'])
            previous_plan = read_snapshot(query, registered['payload']['content']['allocation_snapshot_id'])
            old = previous_plan['payload']['content']
            if (registered['manifest']['snapshot_kind'] != 'execution_pair'
                    or registered['manifest']['signal_date'] >= manifest['signal_date']
                    or old.get('candidate_checksum') != candidate['artifact']['payload_checksum']
                    or any(old.get(k) != pin.get(k) for k in ('pair_id', 'baseline_checksum', 'configuration_checksum'))):
                raise ValueError('paired_nav_l3_registered_pin_invalid')
        created = datetime.fromisoformat(registry['created_at'].replace('Z', '+00:00'))
        created = created.replace(tzinfo=timezone.utc) if created.tzinfo is None else created
        if (created > _timestamp(selection['decision_cutoff']) or registry.get('state') != 'candidate'
                or registry.get('production_effect') != 0
                or (selection['schema_version'] == 'paired-nav-l3-candidate-selection-v1'
                    and candidate['artifact']['observation_artifacts'] != selection['base_artifacts'])):
            raise ValueError('paired_nav_l3_frozen_candidate_time_or_identity_invalid')
        inputs = deepcopy(rec_context['inputs'])
        if selection['schema_version'] == 'paired-nav-l3-candidate-selection-v2':
            key = digest(candidate['artifact']['observation_artifacts'])
            if (candidate.get('bundle_key') != key
                    or key not in (selection.get('predictions_by_bundle') or {})):
                raise ValueError('paired_nav_l3_frozen_bundle_prediction_missing')
            inputs['predictions'] = deepcopy(selection['predictions_by_bundle'][key])
            if set(inputs['predictions']) != set(rec_context['inputs']['predictions']):
                raise ValueError('paired_nav_l3_frozen_bundle_universe_mismatch')
        inputs['predictions'] = infer_candidate_predictions(predictions=inputs['predictions'],
            candidate=candidate, signal_date=manifest['signal_date'])
        result = run_recommendation_path(inputs=inputs)
        allocation_inputs = deepcopy(context['inputs'])
        allocation_inputs['recommendations'] = result['recommendations']
        challenger = run_isolated_allocation(inputs=allocation_inputs,
            inherited_state=context['capture'].get('inherited_state') or {})
        identity = {'artifact_id': candidate['registry']['artifact_id'],
                    'cohort_id': candidate['artifact']['cohort_id'],
                    'artifact_checksum': candidate['artifact']['payload_checksum']}
        root_pair_id = digest(['ensemble', identity['artifact_checksum'], baseline_identity['artifact_checksum'], config_checksum])
        pair_id = resolve_pair_id(root_pair_id, signal_date=manifest['signal_date'], query=query)
        arms = {arm: {'model_identity': model, 'predictions': _native_predictions(pred, model)}
            for arm, model, pred in (
                ('baseline', baseline_identity, context['model_predictions']),
                ('candidate', identity, inputs['predictions']))}
        # Each ensemble gets its own immutable parent; EV comparisons must not
        # inherit another candidate's per-arm model context.
        parent_content = {**deepcopy(context), 'upstream_allocation_context_snapshot_id': snapshot_id,
            'model_predictions': arms['baseline']['predictions'], 'model_prediction_arms': arms}
        parent = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id='l3:' + pair_id,
            snapshot_kind='allocation_context', content=parent_content, query=query, writer=writer)
        seal = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id=pair_id,
            snapshot_kind='allocation_pair', query=query, writer=writer, content={
                'pair_id': pair_id, 'root_pair_id': root_pair_id, 'owner': 'ensemble', 'candidate_checksum': identity['artifact_checksum'],
                'baseline_checksum': baseline_identity['artifact_checksum'],
                'candidate_artifact_id': identity['artifact_id'],
                'candidate_training_run_id': candidate['registry']['training_run_id'],
                'allocation_context_snapshot_id': parent['snapshot_id'],
                'configuration': configuration, 'configuration_checksum': config_checksum,
                'allocation_input_checksum': digest(context['inputs']), 'baseline': incumbent, 'candidate': challenger,
                'model_predictions_checksum': digest(arms['baseline']['predictions']),
                'model_prediction_arms_checksum': digest(arms),
                'production_effect': False, 'can_write_order': False, 'nav_maturity_credit': 0})
        plans.append({'pair_id': pair_id, 'snapshot_id': seal['snapshot_id'], 'owner': 'ensemble'})
    transitions = prepare_comparison_transitions(plans=plans, signal_date=manifest['signal_date'], query=query)
    return {**empty, 'status': 'allocation_pairs_frozen', 'plans': plans,
            'lifecycle_transition_plan': transitions, 'lifecycle_transitions': []}
