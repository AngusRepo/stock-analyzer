"""OPB's original paired NAV -> existing daily gate projection, no publisher.

The pre-inference frozen inventory is authoritative. Offline return diagnostics
cannot authorize or veto NAV support; bad source identities remain real errors.
Uses the SAME candidate decision, review budget and registry CAS as EV, not a
second statistical protocol or another lifecycle/pointer owner.
"""
from datetime import date, datetime, timedelta, timezone
import json

from services.expected_return_candidate_forward_evaluator import _persist_candidate_gate_state
from services.paired_nav_candidate_decision import read_nav_candidate_decision
from services.paired_nav_journal import digest, encode, _timestamp
from services.paired_nav_opb_candidate import OWNER, IDENTITY_FIELDS, _artifact, frozen_opb_selection
from services.paired_nav_population import _manifest_rows

def frozen_opb_inventory(*, business_date, query, now):
    items = {}
    for saved in _manifest_rows(query, business_date, 'allocation_context', 50):
        manifest = saved['manifest']
        if _timestamp(manifest['frozen_at']) > now:
            raise ValueError('nav_opb_source_not_observable')
        if saved['payload']['content'].get('upstream_allocation_context_snapshot_id'):
            continue
        selection = frozen_opb_selection(saved)
        if selection is None:
            continue  # Never enrich an immutable legacy parent from today's DB.
        for row in selection['registry_rows']:
            identity = {key: row.get(key) for key in IDENTITY_FIELDS}
            key = row['checksum']
            entry = items.setdefault(key, {'registry_identity': identity, 'source_snapshot_ids': [],
                'first_admission': {'registry': row, 'selection': {
                    'signal_date': selection['signal_date'],
                    'decision_cutoff_at': selection['decision_cutoff_at']}}})
            if entry['registry_identity'] != identity or identity['model_name'] != OWNER:
                raise ValueError('nav_opb_frozen_identity_conflict')
            admission = entry['first_admission']
            if _timestamp(selection['decision_cutoff_at']) < _timestamp(admission['selection']['decision_cutoff_at']):
                admission['registry'] = row
                admission['selection'] = {key: selection[key] for key in ('signal_date', 'decision_cutoff_at')}
            entry['source_snapshot_ids'].append(manifest['snapshot_id'])
    return [items[key] for key in sorted(items)]


def _original_gate(*, row, artifact, business_date, query, now):
    nav = read_nav_candidate_decision(owner=OWNER, candidate_checksum=row['checksum'],
        candidate_artifact_id=row['artifact_id'], business_date=business_date, query=query, now=now)
    reason = [] if nav['decision'] == 'PASS' else [nav['reason']]
    return {'schema_version': 'expected-return-candidate-nav-gate-v1',
        'decision': nav['decision'], 'failed_gates': reason,
        'contract_blockers': [],
        'quality_blockers': reason if nav['decision'] == 'HOLD' else [],
        'maturity_blockers': reason if nav['decision'] == 'PENDING' else [],
        'candidate_artifact_id': row['artifact_id'], 'candidate_artifact_checksum': row['checksum'],
        # Original Python canonical bytes avoid JS float/Unicode reserialization
        # changing the immutable prior checksum at the publication boundary.
        'candidate_payload_json': encode(artifact),
        'source_run_date': row['source_run_date'], 'artifact_trained_until': artifact['trained_until'],
        'minimum_evaluable_dates': nav['minimum_evaluable_dates'],
        'maximum_evaluable_dates': nav['maximum_evaluable_dates'],
        'evaluable_date_count': nav.get('evaluable_date_count', 0),
        'source_integrity': {'status': 'verified', 'schema_version': artifact['schema_version']},
        'offline_diagnostic': {**artifact['validation'], 'role': 'diagnostic_only'},
        'nav_validation': nav, 'evaluation_evidence_checksum': nav['decision_checksum'],
        'evaluation_unit': 'original_costed_paired_daily_nav',
        'comparison_mode': (nav.get('comparison') or {}).get('kind'), 'training_dispatched': False}


def refresh_registered_opb_nav_decisions(*, business_date, query, writer, now=None, adoption_candidates=None):
    clock = now or datetime.now(timezone.utc)
    if (clock.tzinfo is None or clock.utcoffset() is None
            or date.fromisoformat(business_date).isoformat() != business_date
            or date.fromisoformat(business_date) > clock.astimezone(timezone(timedelta(hours=8))).date()):
        raise ValueError('nav_opb_invalid_time')
    inventory = frozen_opb_inventory(business_date=business_date, query=query, now=clock)
    completed, failures = [], []
    for item in inventory:
        frozen = item['registry_identity']
        artifact_id, checksum = frozen['artifact_id'], frozen['checksum']
        stage = 'registry'
        try:
            rows = query('SELECT * FROM model_artifact_registry WHERE artifact_id=? AND checksum=?', [artifact_id, checksum])
            if len(rows) != 1:
                raise ValueError('nav_opb_registry_missing_or_ambiguous')
            row = rows[0]
            if any(row.get(key) != value for key, value in frozen.items()):
                raise ValueError('nav_opb_registry_identity_changed')
            stage = 'artifact'
            admission = item['first_admission']
            artifact = _artifact(admission['registry'], admission['selection'])
            previous = json.loads(row.get('live_evidence_json') or '{}')
            if str((previous.get('nav_validation') or {}).get('as_of_date') or '') > business_date:
                raise ValueError('nav_opb_projection_newer_than_request')
            stage = 'decision'
            gate = _original_gate(row=row, artifact=artifact, business_date=business_date, query=query, now=clock)
            stage = 'writeback'
            candidate = {'registry': row, 'checksum': checksum, 'registry_identity_guard': frozen}
            _persist_candidate_gate_state(candidates={OWNER: candidate}, gates={OWNER: gate}, activate={},
                query_fn=query, batch_fn=lambda statements, **_kw: writer(statements), preserve_state=True)
            completed.append({'owner': OWNER, 'candidate_artifact_id': artifact_id, 'candidate_checksum': checksum,
                'registry_state': row['state'], 'decision': gate['decision'],
                'nav_decision_checksum': gate['nav_validation']['decision_checksum'],
                'gate_checksum': digest(gate), 'evaluable_date_count': gate['evaluable_date_count']})
            if adoption_candidates is not None:
                adoption_candidates.append({'owner': OWNER, 'registry_state': row['state'], 'payload': {
                    'artifact_id': artifact_id, 'artifact_checksum': checksum, 'artifact': artifact,
                    'source_run_date': row['source_run_date'], 'prospective_validation': gate,
                    'evaluation_business_date': business_date, 'cadence': 'daily_candidate_nav'}})
        except Exception as exc:
            reason = str(exc) if str(exc) in {
                'nav_opb_registry_missing_or_ambiguous', 'nav_opb_registry_identity_changed',
                'nav_opb_projection_newer_than_request', 'candidate_forward_gate_state_readback_mismatch',
            } else 'nav_opb_primary_evaluation_failed'
            failures.append({'owner': OWNER, 'candidate_artifact_id': artifact_id, 'candidate_checksum': checksum,
                'stage': stage, 'reason': reason, 'error_type': type(exc).__name__})
    return {'schema_version': 'paired-nav-daily-candidates-v1', 'as_of_date': business_date,
        'status': 'partial_nav_candidate_decisions' if failures else 'nav_candidate_decisions_current',
        'inventory_checksum': digest(inventory), 'candidate_count': len(inventory),
        'evaluated_count': len(completed), 'failure_count': len(failures),
        'decisions': completed, 'decisions_checksum': digest(completed), 'failures': failures,
        'registry_state_unchanged': True, 'promotion_allowed': False}
