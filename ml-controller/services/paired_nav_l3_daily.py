"""Daily L3 projection from original frozen candidates and the shared NAV review.

No fit, additional efficacy gate, registry rewrite or publication. An admitted
candidate cannot disappear from the daily denominator when its live row changes.
"""
from datetime import date, datetime, timedelta, timezone
import json

from services.paired_nav_candidate_decision import read_nav_candidate_decision
from services.paired_nav_journal import digest, _timestamp
from services.paired_nav_l3_candidate import _validate_payload_identity
from services.paired_nav_population import _manifest_rows

OWNER = 'ensemble'
IDENTITY = ('artifact_id', 'cohort_id', 'training_run_id', 'knowledge_cutoff_date',
    'schema_version', 'payload_json', 'payload_checksum', 'base_artifact_set_checksum',
    'validation_decision', 'validation_json', 'archive_uri', 'created_at')


def frozen_l3_inventory(*, business_date, query, now):
    candidates = {}
    for saved in _manifest_rows(query, business_date, 'allocation_context', 50):
        manifest, context = saved['manifest'], saved['payload']['content']
        if _timestamp(manifest['frozen_at']) > now:
            raise ValueError('nav_l3_source_not_observable')
        if context.get('upstream_allocation_context_snapshot_id'):
            continue
        selection = (context.get('recommendation_context') or {}).get('l3_candidate_selection')
        if selection is None:
            continue  # Never enrich old frozen contexts from today's registry.
        if (selection.get('schema_version') not in {'paired-nav-l3-candidate-selection-v1', 'paired-nav-l3-candidate-selection-v2'}
                or selection.get('signal_date') != manifest['signal_date']
                or _timestamp(selection['decision_cutoff']) > _timestamp(manifest['frozen_at'])
                or selection.get('status') not in {'candidate_ensembles_frozen',
                    'awaiting_complete_base_candidate_bundle', 'awaiting_matching_executable_ensemble'}):
            raise ValueError('nav_l3_frozen_selection_invalid')
        for candidate in selection['candidates']:
            row, payload = candidate['registry'], candidate['artifact']
            _validate_payload_identity(row, payload)
            created = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if (created > _timestamp(selection['decision_cutoff']) or row['state'] != 'candidate'
                    or row['production_effect'] != 0 or payload['knowledge_cutoff_date'] > manifest['signal_date']):
                raise ValueError('nav_l3_frozen_candidate_time_invalid')
            identity = {key: row[key] for key in IDENTITY}
            key = row['payload_checksum']
            item = candidates.setdefault(key, {'registry_identity': identity, 'source_snapshot_ids': []})
            if item['registry_identity'] != identity:
                raise ValueError('nav_l3_frozen_identity_conflict')
            item['source_snapshot_ids'].append(manifest['snapshot_id'])
    # Preserve older named comparisons even if the original admission is absent;
    # report an explicit missing source instead of excluding them from coverage.
    for saved in _manifest_rows(query, business_date, 'allocation_pair', 50):
        plan = saved['payload']['content']
        if plan.get('owner') != OWNER:
            continue
        if _timestamp(saved['manifest']['frozen_at']) > now:
            raise ValueError('nav_l3_source_not_observable')
        key = plan['candidate_checksum']
        if key not in candidates:
            candidates[key] = {'registry_identity': {'artifact_id': plan['candidate_artifact_id'],
                'payload_checksum': key, 'training_run_id': plan['candidate_training_run_id']},
                'source_snapshot_ids': [saved['manifest']['snapshot_id']], 'admission_missing': True}
        elif (candidates[key]['registry_identity']['artifact_id'] != plan['candidate_artifact_id']
              or candidates[key]['registry_identity']['training_run_id'] != plan['candidate_training_run_id']):
            raise ValueError('nav_l3_frozen_identity_conflict')
    return [candidates[key] for key in sorted(candidates)]


def refresh_registered_l3_nav_decisions(*, business_date, query, now=None, adoption_candidates=None):
    clock = now or datetime.now(timezone.utc)
    if (clock.tzinfo is None or clock.utcoffset() is None
            or date.fromisoformat(business_date).isoformat() != business_date
            or date.fromisoformat(business_date) > clock.astimezone(timezone(timedelta(hours=8))).date()):
        raise ValueError('nav_l3_invalid_time')
    inventory = frozen_l3_inventory(business_date=business_date, query=query, now=clock)
    decisions, failures = [], []
    for item in inventory:
        identity = item['registry_identity']
        artifact_id, checksum = identity['artifact_id'], identity['payload_checksum']
        stage = 'registry'
        try:
            if item.get('admission_missing'):
                raise ValueError('nav_l3_original_admission_missing')
            rows = query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=? AND payload_checksum=?',
                         [artifact_id, checksum])
            if len(rows) != 1:
                raise ValueError('nav_l3_registry_missing_or_ambiguous')
            row = rows[0]
            if any(row.get(key) != value for key, value in identity.items()):
                raise ValueError('nav_l3_registry_identity_changed')
            if (row['state'] not in {'candidate', 'production', 'archived', 'rejected'}
                    or row['production_effect'] != int(row['state'] == 'production')):
                raise ValueError('nav_l3_registry_lifecycle_invalid')
            stage = 'artifact'
            payload = json.loads(identity['payload_json'])
            _validate_payload_identity(row, payload)
            stage = 'decision'
            nav = read_nav_candidate_decision(owner=OWNER, candidate_checksum=checksum,
                candidate_artifact_id=artifact_id, business_date=business_date, query=query, now=clock)
            decisions.append({'owner': OWNER, 'candidate_artifact_id': artifact_id, 'candidate_checksum': checksum,
                'registry_state': row['state'], 'decision': nav['decision'], 'reason': nav['reason'],
                'nav_decision_checksum': nav['decision_checksum'],
                'evaluable_date_count': nav.get('evaluable_date_count', 0),
                'offline_diagnostic_decision': payload['validation']['decision']})
            if adoption_candidates is not None and row['state'] in {'candidate', 'production'}:
                adoption_candidates.append({'owner': OWNER, 'registry_state': row['state'], 'payload': {
                    'artifact_id': artifact_id, 'artifact_checksum': checksum, 'artifact': payload,
                    'training_run_id': row['training_run_id'], 'source_run_date': row['knowledge_cutoff_date'],
                    'prospective_validation': {'decision': nav['decision'], 'nav_validation': nav},
                    'evaluation_business_date': business_date, 'cadence': 'daily_candidate_nav'}})
        except Exception as exc:
            reason = str(exc) if str(exc) in {'nav_l3_original_admission_missing',
                'nav_l3_registry_missing_or_ambiguous', 'nav_l3_registry_identity_changed',
                'nav_l3_registry_lifecycle_invalid'} else 'nav_l3_primary_evaluation_failed'
            failures.append({'owner': OWNER, 'candidate_artifact_id': artifact_id, 'candidate_checksum': checksum,
                'stage': stage, 'reason': reason, 'error_type': type(exc).__name__})
    return {'schema_version': 'paired-nav-daily-candidates-v1', 'as_of_date': business_date,
        'status': 'partial_nav_candidate_decisions' if failures else 'nav_candidate_decisions_current',
        'inventory_checksum': digest(inventory), 'candidate_count': len(inventory),
        'evaluated_count': len(decisions), 'failure_count': len(failures),
        'decisions': decisions, 'decisions_checksum': digest(decisions), 'failures': failures,
        'registry_state_unchanged': True, 'promotion_allowed': False}
