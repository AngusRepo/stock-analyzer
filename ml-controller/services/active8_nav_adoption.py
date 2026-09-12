"""Bind the shared L3 NAV verdict to the original bundle adoption transaction.

This reads, never spends, the existing review/reservation. No caller-supplied
PASS, new evaluator or new storage owner. Current configuration comes from the
same canonical providers as the daily pipeline.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json

from services.paired_nav_candidate_decision import read_nav_candidate_decision
from services.paired_nav_journal import digest, read_snapshot, _timestamp
from services.paired_nav_l3_candidate import _validate_payload_identity
from services.paired_nav_l3_daily import frozen_l3_inventory, IDENTITY
from services.active8_bundle_transaction import _snapshot_guards
from services.paired_nav_journal_frontier import journal_frontier_guard


_SERVING_SEAL = object()
_PUBLICATION_SEAL = object()


@dataclass(frozen=True)
class _CommittedPublication:
    """Historical publication proof; deliberately NOT a live serving grant."""
    payload_json: str
    receipt_json: str
    base_source_json: str
    review_records_json: str
    observed_at: str
    published_at: str
    seal: object


@dataclass(frozen=True)
class _ServingGrant(_CommittedPublication):
    """Original publication AND currently compatible execution configuration."""
    def authorizes(self, model_name, artifact):
        if self.seal is not _SERVING_SEAL or not artifact:
            return False
        expected = json.loads(self.payload_json)['base_artifacts'].get(model_name)
        return bool(expected and all(artifact.get(key) == expected.get(key)
                    for key in ('artifact_id', 'version', 'checksum'))
                    and _base_source(artifact) == json.loads(self.base_source_json).get(model_name))


def _base_source(row):
    from services.active8_bundle_transaction import BASE_IDENTITY
    result = {key: row.get(key) for key in BASE_IDENTITY}
    raw = result['offline_evidence_json']
    if isinstance(raw, str):
        result['offline_evidence_json'] = json.loads(raw)
    return result


def is_serving_grant(value):
    return isinstance(value, _ServingGrant) and value.seal is _SERVING_SEAL


def read_original_committed_review(nav, *, query):
    """Read original immutable review linkage; no rejudgment or budget spending."""
    from services import paired_nav_review_store as store
    review = store.read_review_record(query=query, record_id=nav['review_record_id'])
    protocol = store.read_review_record(query=query, record_id=store._key(nav['protocol_id']))
    reservation = store.read_review_record(query=query,
        record_id=store._key(nav['protocol_id'], nav['family_id'], nav['review_id'], 'reservation'))
    recorded = review['body']
    findings = [h for h in recorded['family']['hypotheses'] if h['hypothesis_checksum'] == nav['hypothesis_checksum']]
    if (review['header']['payload_checksum'] != nav['review_record_checksum']
            or review['header']['record_id'] != store._key(nav['protocol_id'], nav['family_id'], nav['review_id'])
            or reservation['header']['payload_checksum'] != nav['reservation_checksum']
            or recorded['protocol_checksum'] != protocol['header']['payload_checksum']
            or recorded['reservation_checksum'] != reservation['header']['payload_checksum']
            or reservation['body']['protocol_checksum'] != protocol['header']['payload_checksum']
            or recorded['as_of_date'] != nav['checkpoint_as_of_date']
            or len(findings) != 1 or findings[0]['numerical_support'] is not True
            or any(findings[0][key] != nav[key] for key in ('effect_pair_id','mean_daily_nav_delta','holm_adjusted_p'))
            or recorded['family']['review_alpha'] != nav['review_alpha']
            or reservation['body']['review_alpha'] != nav['review_alpha']):
        raise RuntimeError('active8_nav_serving_original_review_mismatch')
    return review, protocol, reservation


def load_committed_nav_publication(*, query, now=None):
    """Verify an existing adoption, without re-evaluating or spending its review.

    Later observations/lifecycle events cannot rewrite a historical verdict.
    Current pointer/history and immutable original review must still agree.
    Downstream publishers check their OWN frozen/current configuration; they
    must not make a completed upstream publication depend on their projection.
    This return type cannot authorize the live model-pool consumer.
    """
    from services.active8_bundle_transaction import prepare_bundle_transaction
    clock = now or datetime.now(timezone.utc)
    pointers = query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    if not pointers:
        return None
    if len(pointers) != 1:
        raise RuntimeError('active8_nav_serving_pointer_ambiguous')
    pointer = pointers[0]
    receipt = json.loads(pointer.get('promotion_evidence_json') or '{}')
    if not isinstance(receipt, dict):
        raise RuntimeError('active8_nav_serving_receipt_invalid')
    if 'nav_validation' not in receipt:
        return None  # Existing legacy incumbent; no NAV authority inferred.
    rows = query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [pointer['artifact_id']])
    if len(rows) != 1:
        raise RuntimeError('active8_nav_serving_artifact_missing')
    row = rows[0]
    payload = json.loads(row['payload_json'])
    _validate_payload_identity(row, payload)
    names = sorted(payload['observation_artifacts'])
    slots = ','.join('?' for _ in names)
    base_rows = query(f'SELECT * FROM model_artifact_registry WHERE artifact_id IN ({slots})',
        [payload['observation_artifacts'][name]['artifact_id'] for name in names])
    by_model = {base['model_name']: base for base in base_rows}
    if len(base_rows) != len(names) or set(by_model) != set(names) or any(
            by_model[name].get(key) != payload['observation_artifacts'][name].get(key)
            for name in names for key in ('artifact_id', 'version', 'checksum')):
        raise RuntimeError('active8_nav_serving_base_identity_mismatch')
    model_pointers = query(f'SELECT * FROM model_champion_pointers WHERE model_name IN ({slots})', names)
    transaction = prepare_bundle_transaction(query=query, by_model=by_model,
        supplied_pointers=model_pointers, ensemble_row=row, selected_models=sorted(payload['selected_models']))
    if not transaction['recovered_existing_commit'] or transaction['promotion_evidence'] != receipt:
        raise RuntimeError('active8_nav_serving_commit_unverified')
    from services.model_serving_resolver import _artifact_structure_block_reason
    for name in payload['selected_models']:
        blocker = _artifact_structure_block_reason(by_model[name], model_name=name, artifact_role='direct_alpha')
        if blocker:
            raise RuntimeError(f'active8_nav_serving_structure_invalid:{name}:{blocker}')
    nav = receipt['nav_validation']
    body = {key: value for key, value in nav.items() if key not in ('decision_checksum', 'decision_payload_json')}
    if (nav.get('decision') != 'PASS' or nav.get('owner') != 'ensemble'
            or nav.get('candidate_artifact_id') != row['artifact_id']
            or nav.get('candidate_checksum') != row['payload_checksum']
            or nav.get('as_of_date') != receipt.get('evaluation_business_date')
            or digest(body) != nav.get('decision_checksum')
            or json.loads(nav.get('decision_payload_json') or '{}') != body):
        raise RuntimeError('active8_nav_serving_decision_invalid')
    review, protocol, reservation = read_original_committed_review(nav, query=query)
    recorded = review['body']
    # Only D1's native CURRENT_TIMESTAMP is allowed to omit an offset. Keep
    # strict timezone requirements for all external NAV evidence timestamps.
    raw_promoted = pointer['promoted_at']
    promoted = (datetime.strptime(raw_promoted, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        if isinstance(raw_promoted, str) and len(raw_promoted) == 19 and raw_promoted[10] == ' '
        else _timestamp(raw_promoted))
    saved = read_snapshot(query, nav['allocation_snapshot_id'])
    plan = saved['payload']['content']
    configuration = receipt['nav_configuration']
    if (clock.tzinfo is None or promoted > clock
            or nav['as_of_date'] > promoted.astimezone(timezone(timedelta(hours=8))).date().isoformat()
            or any(_timestamp(item['header']['created_at']) > promoted for item in (review, protocol, reservation))
            or recorded['as_of_date'] > nav['as_of_date']
            or saved['manifest']['payload_checksum'] != nav['allocation_payload_checksum']
            or _timestamp(saved['manifest']['frozen_at']) > promoted
            or plan['owner'] != 'ensemble' or plan['candidate_artifact_id'] != row['artifact_id']
            or plan['candidate_checksum'] != row['payload_checksum']
            or plan['baseline_checksum'] != nav['baseline_checksum']
            or configuration != plan['configuration'] or digest(configuration) != nav['configuration_checksum']):
        raise RuntimeError('active8_nav_serving_source_or_time_invalid')
    # Reject a mixed read if an adoption/recovery changed while anchors loaded.
    repeated = prepare_bundle_transaction(query=query, by_model=by_model,
        supplied_pointers=model_pointers, ensemble_row=row, selected_models=sorted(payload['selected_models']))
    if repeated != transaction or query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', []) != pointers:
        raise RuntimeError('active8_nav_serving_source_changed')
    return _CommittedPublication(row['payload_json'], json.dumps(receipt, sort_keys=True, allow_nan=False),
        json.dumps({name: _base_source(by_model[name]) for name in payload['selected_models']},
                   sort_keys=True, allow_nan=False),
        json.dumps([review, protocol, reservation], sort_keys=True, allow_nan=False),
        clock.isoformat(), promoted.isoformat(), _PUBLICATION_SEAL)


def load_committed_nav_serving_grant(*, query, now=None):
    """Preserve exact L3 authority across independently approved EV/OPB changes.

    Only the owners' tested projection fields may differ. ORIGINAL committed
    pointer/history/review and current configuration must authorize each change.
    Risk, source versions and every other trading knob remain checked.
    """
    clock = now or datetime.now(timezone.utc)
    publication = load_committed_nav_publication(query=query, now=clock)
    if publication is None:
        return None
    configuration = json.loads(publication.receipt_json)['nav_configuration']
    current = current_execution_configuration()
    from services.opb_nav_control import _same_json, _without_prior, needs_nav_control, capture_nav_control
    if (not current.get('trading_config') or not current.get('risk_config')
            or any(key not in configuration or not _same_json(configuration[key], value)
                   for key, value in current.items() if key != 'trading_config')):
        raise RuntimeError('active8_nav_current_configuration_changed_or_unverified')
    if not _same_json(current['trading_config'], configuration['trading_config']):
        from services.ev_nav_config_transition import verified_ev_projection
        projected = verified_ev_projection(query=query, publication=publication,
            original=configuration['trading_config'], current=current, now=clock)
        if not _same_json(current['trading_config'], projected):
            if (not needs_nav_control(current['trading_config'])
                    or not _same_json(_without_prior(current['trading_config']), _without_prior(projected))):
                raise RuntimeError('active8_nav_current_configuration_changed_or_unverified')
        if needs_nav_control(current['trading_config']):
            context, control = capture_nav_control(query=query, trading_config=current['trading_config'],
                risk_config=current['risk_config'], now=clock)
            if control is None:
                raise RuntimeError('active8_nav_current_configuration_changed_or_unverified')
            from services.opb_nav_control import _history_time
            history = json.loads(context['record']['history_json'])
            if _history_time(history[0]['effective_at']) < _timestamp(publication.published_at):
                raise RuntimeError('active8_nav_control_precedes_l3_publication')
    if (load_committed_nav_publication(query=query, now=clock) != publication
            or not _same_json(current_execution_configuration(), current)):
        raise RuntimeError('active8_nav_serving_source_changed')
    return _ServingGrant(**{**vars(publication), 'seal': _SERVING_SEAL})


def current_execution_configuration():
    from services.worker_config_client import load_active_trading_config
    from services import kv_client
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_recommendation_path import recommendation_source_identity
    from services.paired_nav_execution_environment import capture_execution_environment, execution_policy
    return {'trading_config': load_active_trading_config(),
        'risk_config': kv_client.get_json('trading:risk_config', default=None, strict=True),
        'allocator_source_identity': allocator_source_identity(),
        'l3_inference_source_identity': recommendation_source_identity(),
        'native_execution_policy': execution_policy(capture_execution_environment())}


def verify_current_configuration(configuration):
    current = current_execution_configuration()
    if (not current.get('trading_config') or not current.get('risk_config')
            or any(key not in configuration or digest(configuration[key]) != digest(value)
                   for key, value in current.items())):
        raise RuntimeError('active8_nav_current_configuration_changed_or_unverified')
    return current


def prepare_nav_adoption(*, ensemble_row, business_date, query, now=None):
    clock = now or datetime.now(timezone.utc)
    artifact = json.loads(ensemble_row['payload_json'])
    _validate_payload_identity(ensemble_row, artifact)
    inventory = frozen_l3_inventory(business_date=business_date, query=query, now=clock)
    admitted = [item for item in inventory
        if item['registry_identity']['artifact_id'] == ensemble_row['artifact_id']
        and item['registry_identity']['payload_checksum'] == ensemble_row['payload_checksum']]
    if (len(admitted) != 1 or admitted[0].get('admission_missing')
            or any(admitted[0]['registry_identity'][key] != ensemble_row.get(key) for key in IDENTITY)):
        raise RuntimeError('active8_nav_original_candidate_admission_unverified')
    nav = read_nav_candidate_decision(owner='ensemble', candidate_checksum=ensemble_row['payload_checksum'],
        candidate_artifact_id=ensemble_row['artifact_id'], business_date=business_date, query=query, now=clock)
    if nav['decision'] != 'PASS':
        return {'decision': nav['decision'], 'nav_validation': nav, 'guards': [], 'can_promote': False}
    saved = read_snapshot(query, nav['allocation_snapshot_id'])
    plan = saved['payload']['content']
    configuration = plan['configuration']
    if (saved['manifest']['payload_checksum'] != nav['allocation_payload_checksum']
            or digest(configuration) != nav['configuration_checksum']
            or plan['owner'] != 'ensemble' or plan['candidate_artifact_id'] != ensemble_row['artifact_id']
            or plan['candidate_checksum'] != ensemble_row['payload_checksum']
            or plan['baseline_checksum'] != nav['baseline_checksum']
            or _timestamp(saved['manifest']['frozen_at']) > clock):
        raise RuntimeError('active8_nav_original_allocation_mismatch')
    current = current_execution_configuration()
    required = {'trading_config', 'risk_config', 'allocator_source_identity',
                'l3_inference_source_identity', 'native_execution_policy'}
    if (set(current) != required or any(not isinstance(current[key], dict) or not current[key]
            or key not in configuration for key in required)):
        raise RuntimeError('active8_nav_current_configuration_unverified')
    pointers = query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    frozen_baseline = configuration['formal_baseline_identity']
    if len(pointers) != 1 or frozen_baseline['payload_checksum'] != nav['baseline_checksum']:
        raise RuntimeError('active8_nav_current_baseline_changed')
    keys = ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')
    baseline = {key: pointers[0].get(key) for key in keys}
    rows = query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [baseline['artifact_id']])
    if len(rows) != 1 or rows[0]['state'] != 'production' or rows[0]['production_effect'] != 1:
        raise RuntimeError('active8_nav_current_baseline_not_production')
    _validate_payload_identity(rows[0], json.loads(rows[0]['payload_json']))
    if any(rows[0].get(key) != baseline.get(key) for key in
           ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')):
        raise RuntimeError('active8_nav_current_baseline_changed')
    # Validate the CURRENT baseline before classifying an ordinary transition.
    # A dangling pointer or a broken NAV publication remains a retryable error.
    committed = load_committed_nav_publication(query=query, now=clock)
    if committed is None and rows[0]['validation_decision'] != 'PASS':
        raise RuntimeError('active8_nav_current_baseline_unverified')
    changed = sorted(key for key in required if digest(current[key]) != digest(configuration[key]))
    if any(baseline[key] != frozen_baseline.get(key) for key in keys):
        changed.append('formal_ml')
    guards = _snapshot_guards('active8_ensemble_pointer_v1', 'singleton_id=1', [], pointers)
    guards += _snapshot_guards('active8_ensemble_artifacts_v1', 'artifact_id=?', [baseline['artifact_id']], rows)
    from services import paired_nav_review_store as store
    record_ids = [nav['review_record_id'], store._key(nav['protocol_id']),
                  store._key(nav['protocol_id'], nav['family_id'], nav['review_id'], 'reservation')]
    for record_id in record_ids:
        # Existing immutable record/part triggers protect contents; the original
        # reader already validated every part, reservation and numerical result.
        record = store.read_review_record(query=query, record_id=record_id)
        guards += _snapshot_guards(store.RECORDS, 'record_id=?', [record_id], [record['header']])
        parts = query(f'SELECT * FROM {store.PARTS} WHERE record_id=?', [record_id])
        guards += _snapshot_guards(store.PARTS, 'record_id=?', [record_id], parts)
    journal_guard = journal_frontier_guard(nav)
    query(*journal_guard)
    guards.append(journal_guard)
    # New evidence/selection/lifecycle events between review and commit must
    # trigger a retry, not authorize a stale family population.
    for table, where, params in (
        ('paired_nav_frozen_manifests_v1', 'prospective=1 AND signal_date<=?', [business_date]),
        ('paired_nav_lifecycle_closures_v1', '1=1', []),
    ):
        counts = query(f'SELECT COUNT(*) AS n FROM {table} WHERE {where}', params)
        if len(counts) != 1:
            raise RuntimeError('active8_nav_population_count_unverified')
        guards.append((f'SELECT CASE WHEN (SELECT COUNT(*) FROM {table} WHERE {where})=? '
                       "THEN 1 ELSE json('active8_nav_population_changed') END", [*params, counts[0]['n']]))
    repeated = read_nav_candidate_decision(owner='ensemble', candidate_checksum=ensemble_row['payload_checksum'],
        candidate_artifact_id=ensemble_row['artifact_id'], business_date=business_date, query=query, now=clock)
    if repeated != nav:
        raise RuntimeError('active8_nav_review_changed_during_adoption')
    if changed:
        # These are read-only observations, not substitute promotion guards.
        # The original transaction still owns all writes and recovery.
        if (digest(current_execution_configuration()) != digest(current)
                or query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', []) != pointers
                or query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [baseline['artifact_id']]) != rows
                or load_committed_nav_publication(query=query, now=clock) != committed):
            raise RuntimeError('active8_nav_comparison_source_changed_during_read')
        observation = {'schema_version': 'ensemble-nav-comparison-observation-v1', 'owner': 'ensemble',
            'artifact_id': ensemble_row['artifact_id'], 'artifact_checksum': ensemble_row['payload_checksum'],
            'as_of_date': business_date, 'decision_checksum': nav['decision_checksum'],
            'frozen_configuration_checksum': nav['configuration_checksum'],
            'current_context_checksum': digest({'configuration': current, 'formal': baseline}),
            'changed_fields': changed, 'state': 'baseline_changed',
            'reason': 'awaiting_next_frozen_comparison',
            'source': 'original_nav_proof_and_current_ml_execution_config', 'read_only': True,
            'promotion_allowed': False, 'nav_maturity_credit': 0}
        return {'decision': 'HOLD', 'nav_validation': nav, 'guards': [], 'can_promote': False,
            'comparison': {**observation, 'observation_checksum': digest(observation)}}
    return {'decision': 'PASS', 'nav_validation': nav, 'configuration': deepcopy(configuration),
            'guards': guards, 'can_promote': True}
