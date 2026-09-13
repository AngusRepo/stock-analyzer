"""Primary L4/Fusion efficacy gate. Legacy cross-section numbers are diagnostic."""
import json
import re
from services.paired_nav_candidate_decision import read_nav_candidate_decision


def diagnostic_failure(stage, exc):
    reason = str(exc).split(':', 1)[0]
    return {'status': 'failed', 'decision': 'MISSING', 'role': 'diagnostic_only',
        'stage': stage, 'error_type': type(exc).__name__, 'retry_required': True,
        'reason': reason if re.fullmatch(r'candidate_forward_[a-z_]+', reason)
            else 'candidate_forward_diagnostic_failed'}


def nav_promotion_gate(rows, *, owner, candidate, business_date, query_fn, diagnostic_error=None, now=None):
    from services.expected_return_candidate_forward_evaluator import _promotion_gate, _offline_admission
    nav = read_nav_candidate_decision(owner=owner, candidate_checksum=candidate['checksum'],
        candidate_artifact_id=candidate['registry']['artifact_id'],
        business_date=business_date, query=query_fn, now=now)
    # Only original NAV failures abort its decision. A diagnostic is not another
    # efficacy veto; keep its failure explicit for the existing closure retry.
    diagnostic = diagnostic_error
    if diagnostic is None:
        try:
            diagnostic = _promotion_gate(rows, owner=owner, candidate=candidate)
            # Only a real cross-section evaluation advances this timestamp.
            # NAV-only refreshes pass the retained diagnostic unchanged.
            diagnostic['evaluated_as_of_date'] = business_date
            json.dumps(diagnostic, allow_nan=False)
        except Exception as exc:
            diagnostic = diagnostic_failure('cross_section_summary', exc)
    admission = _offline_admission(candidate)
    parity = candidate.get('operational_parity') or candidate['packet'].get('operational_parity') or {}
    owner_parity = (parity.get('owner_decisions') or {}).get(owner) or {}
    blockers = []
    if admission['decision'] != 'PASS':
        blockers.append('offline_admission_not_pass')
    if str(owner_parity.get('decision') or '').upper() != 'PASS' or owner_parity.get('failed_gates'):
        blockers.append('owner_operational_parity_not_pass')
    trained = str(candidate['artifact'].get('trained_until') or '')[:10]
    source_date = str(candidate['registry'].get('source_run_date') or '')[:10]
    if not trained or not source_date or trained > source_date:
        blockers.append('candidate_trained_until_invalid')
    deferred = ['owner_operational_parity_not_pass'] if nav['decision'] == 'PENDING' else []
    terminal = [b for b in blockers if b not in deferred]
    decision = 'FAIL' if terminal else nav['decision']
    return {'schema_version': 'expected-return-candidate-nav-gate-v1',
        'decision': decision, 'failed_gates': blockers + ([] if nav['decision'] == 'PASS' else [nav['reason']]),
        'contract_blockers': blockers, 'deferred_contract_blockers': [b for b in blockers if b in deferred],
        'quality_blockers': [nav['reason']] if nav['decision'] == 'HOLD' else [],
        'maturity_blockers': [nav['reason']] if nav['decision'] == 'PENDING' else [],
        'candidate_artifact_id': candidate['registry']['artifact_id'],
        'candidate_artifact_checksum': candidate['checksum'],
        'model_fingerprint': candidate['identity']['model_fingerprint'],
        'source_run_date': source_date, 'artifact_trained_until': trained,
        'minimum_evaluable_dates': nav['minimum_evaluable_dates'],
        'maximum_evaluable_dates': nav['maximum_evaluable_dates'],
        'evaluable_date_count': nav.get('evaluable_date_count', 0),
        'offline_admission': admission, 'operational_parity': parity,
        'nav_validation': nav, 'cross_section_diagnostic': diagnostic,
        'evaluation_evidence_checksum': nav['decision_checksum'],
        'evaluation_unit': 'original_costed_paired_daily_nav',
        'comparison_mode': (nav.get('comparison') or {}).get('kind'),
        'training_dispatched': False}


def candidate_owner_payload(candidate, gate, cohort_id):
    """One unchanged wire format for new adoption and committed-pointer recovery."""
    return {
        'artifact_id': candidate['registry']['artifact_id'], 'artifact': candidate['artifact'],
        'validation_packet': candidate['packet'].get('validation_packet') or {},
        'offline_admission': gate['offline_admission'],
        'operational_parity': gate['operational_parity'],
        'prospective_validation': gate, 'cohort_id': candidate['packet']['cohort_id'],
        'evaluation_cohort_id': cohort_id,
        'source_run_date': candidate['registry']['source_run_date'],
        'cadence': 'daily_candidate_nav', 'artifact_path': candidate['path'],
        'artifact_checksum': candidate['checksum'],
    }


def candidate_promotion_payload(candidates, gates, cohort_id):
    return {owner: candidate_owner_payload(candidate, gates[owner], cohort_id)
        for owner, candidate in candidates.items()
        if gates[owner]['decision'] == 'PASS' and candidate['registry'].get('state') != 'production'}
