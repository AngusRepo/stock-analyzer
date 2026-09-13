"""Daily adapter for the SAME primary EV gate, before OOF diagnostics can abort.

Inventory comes from original frozen selections/allocations, not a latest-N
registry query. No new statistical owner, policy, lifecycle transition or pointer
writer. Exact current registry is only a projection destination; its deletion
cannot erase a frozen candidate from the reported denominator.
"""
from datetime import date, datetime, timedelta, timezone
import json

from services.expected_return_candidate_forward_evaluator import (
    _load_candidate_packet, _persist_candidate_gate_state,
)
from services.paired_nav_ev_selection import FIELDS, frozen_ev_selection
from services.paired_nav_expected_return_gate import nav_promotion_gate, candidate_owner_payload
from services.paired_nav_journal import digest, _timestamp
from services.paired_nav_population import _manifest_rows

OWNERS = {'l4_alpha_ev', 'allocator_ev_fusion'}


def frozen_candidate_inventory(*, business_date, query, now):
    """All original identities, including admission whose execution is missing."""
    candidates = {}
    def retain(row, snapshot_id):
        owner, checksum = row['model_name'], row['checksum']
        if owner not in OWNERS:
            raise ValueError('nav_candidate_frozen_owner_invalid')
        identity = {k: row[k] for k in FIELDS}
        key = (owner, checksum)
        entry = candidates.setdefault(key, {'registry_identity': identity, 'source_snapshot_ids': []})
        if entry['registry_identity'] != identity:
            raise ValueError('nav_candidate_frozen_identity_conflict')
        entry['source_snapshot_ids'].append(snapshot_id)
    legacy = []
    for kind in ('allocation_context', 'allocation_pair'):
        for saved in _manifest_rows(query, business_date, kind, 50):
            manifest, content = saved['manifest'], saved['payload']['content']
            if _timestamp(manifest['frozen_at']) > now:
                raise ValueError('nav_candidate_frozen_source_not_observable')
            selection = content.get('ev_candidate_selection')
            if selection is not None:
                selection = frozen_ev_selection(content)
                expected = set(selection['l4_checksums']) | set(selection['fusion_bases'])
                for row in selection['registry_rows']:
                    if row['checksum'] in expected:
                        retain(row, manifest['snapshot_id'])
            if kind == 'allocation_pair' and content.get('owner') in OWNERS:
                legacy.append((manifest['snapshot_id'], content))
    # Legacy plans lacking copied registry metadata can still name exact IDs.
    # Do not substitute a latest artifact, infer an alias, or omit missing rows.
    for snapshot_id, plan in legacy:
        key = (plan['owner'], plan['candidate_checksum'])
        if key in candidates:
            row = candidates[key]['registry_identity']
            if row['artifact_id'] != plan['candidate_artifact_id'] or row['training_run_id'] != plan['candidate_training_run_id']:
                raise ValueError('nav_candidate_frozen_identity_conflict')
            continue
        candidates[key] = {'registry_identity': {'model_name': plan['owner'],
            'checksum': plan['candidate_checksum'], 'artifact_id': plan['candidate_artifact_id'],
            'training_run_id': plan['candidate_training_run_id']}, 'source_snapshot_ids': [snapshot_id]}
    return [candidates[key] for key in sorted(candidates)]


def refresh_registered_ev_nav_decisions(*, business_date, query, writer, bucket_factory, now=None,
                                        adoption_candidates=None):
    """Read original NAV and persist its existing gate, without OOF prerequisites.

PENDING/HOLD/FAIL are valid evaluated outcomes, not execution failures. Source,
artifact or write failures remain explicit and retryable per frozen candidate.
This stage preserves registry lifecycle state; the existing adoption path owns
transitions and still validates original evidence at its transaction boundary.
"""
    clock = now or datetime.now(timezone.utc)
    if (clock.tzinfo is None or clock.utcoffset() is None
            or date.fromisoformat(business_date).isoformat() != business_date
            or date.fromisoformat(business_date) > clock.astimezone(timezone(timedelta(hours=8))).date()):
        raise ValueError('nav_candidate_invalid_time')
    inventory = frozen_candidate_inventory(business_date=business_date, query=query, now=clock)
    bucket, completed, failures = None, [], []
    for item in inventory:
        frozen = item['registry_identity']
        owner, checksum, artifact_id = (frozen[k] for k in ('model_name', 'checksum', 'artifact_id'))
        stage = 'registry'
        try:
            rows = query('SELECT * FROM model_artifact_registry WHERE artifact_id=? AND checksum=?', [artifact_id, checksum])
            if len(rows) != 1:
                raise ValueError('nav_candidate_registry_missing_or_ambiguous')
            row = rows[0]
            if any(row.get(k) != v for k, v in frozen.items()):
                raise ValueError('nav_candidate_registry_identity_changed')
            if str(row['source_run_date'])[:10] > business_date:
                raise ValueError('nav_candidate_registry_source_in_future')
            stage = 'artifact'
            if bucket is None:
                bucket = bucket_factory()
            candidate = _load_candidate_packet(bucket, row)
            previous = json.loads(row.get('live_evidence_json') or '{}')
            if str((previous.get('nav_validation') or {}).get('as_of_date') or '') > business_date:
                raise ValueError('nav_candidate_projection_newer_than_request')
            diagnostic = {'status': 'not_run', 'role': 'diagnostic_only',
                'reason': 'cross_section_owned_by_oof_diagnostic_stage'}
            if (previous.get('candidate_artifact_checksum') == checksum
                    and previous.get('candidate_artifact_id') == artifact_id):
                # The first NAV-only refresh may encounter the original forward
                # gate, not a NAV envelope yet. Preserve that exact diagnostic
                # rather than replacing nine existing dates with "not_run".
                diagnostic = (previous if previous.get('schema_version') ==
                    'expected-return-candidate-forward-gate-v2'
                    else previous.get('cross_section_diagnostic')) or diagnostic
                if str(diagnostic.get('evaluated_as_of_date') or '') > business_date:
                    raise ValueError('nav_candidate_projection_newer_than_request')
                # Do not erase an observed parity failure with the packet's older
                # PASS while OOF is unavailable. Only an actual parity recheck can
                # clear it. A prior PASS is never used as primary NAV evidence.
                parity = previous.get('operational_parity') or {}
                parity_owner = (parity.get('owner_decisions') or {}).get(owner) or {}
                if parity_owner.get('decision') == 'FAIL' or parity_owner.get('failed_gates'):
                    candidate['operational_parity'] = parity
            stage = 'decision'
            gate = nav_promotion_gate([], owner=owner, candidate=candidate,
                business_date=business_date, query_fn=query, diagnostic_error=diagnostic, now=clock)
            stage = 'writeback'
            _persist_candidate_gate_state(candidates={owner: candidate}, gates={owner: gate},
                activate={}, query_fn=query,
                batch_fn=lambda statements, **_kw: writer(statements), preserve_state=True)
            completed.append({'owner': owner, 'candidate_artifact_id': artifact_id,
                'candidate_checksum': checksum, 'registry_state': row['state'], 'decision': gate['decision'],
                'nav_decision_checksum': gate['nav_validation']['decision_checksum'],
                'gate_checksum': digest(gate), 'evaluable_date_count': gate['evaluable_date_count']})
            if adoption_candidates is not None:
                # Hand off only after exact gate CAS/readback. Never query latest-N
                # again, re-evaluate with another clock, or substitute a new packet.
                payload = candidate_owner_payload(candidate, gate, None)
                payload['evaluation_business_date'] = business_date
                adoption_candidates.append({'owner': owner, 'registry_state': row['state'], 'payload': payload})
        except Exception as exc:
            safe = str(exc) if str(exc) in {
                'nav_candidate_registry_missing_or_ambiguous', 'nav_candidate_registry_identity_changed',
                'nav_candidate_registry_source_in_future', 'candidate_forward_packet_checksum_mismatch',
                'nav_candidate_projection_newer_than_request',
                'candidate_forward_training_cohort_identity_mismatch', 'candidate_forward_packet_identity_mismatch',
            } else 'nav_candidate_primary_evaluation_failed'
            failures.append({'owner': owner, 'candidate_artifact_id': artifact_id, 'candidate_checksum': checksum,
                'stage': stage, 'reason': safe, 'error_type': type(exc).__name__})
    return {'schema_version': 'paired-nav-daily-candidates-v1', 'as_of_date': business_date,
        'status': 'partial_nav_candidate_decisions' if failures else 'nav_candidate_decisions_current',
        'inventory_checksum': digest(inventory), 'candidate_count': len(inventory),
        'evaluated_count': len(completed), 'failure_count': len(failures),
        'decisions': completed, 'decisions_checksum': digest(completed), 'failures': failures,
        'registry_state_unchanged': True, 'promotion_allowed': False}
