"""Continue verified open Atomic registrations; never infer pins from today's picks."""
from copy import deepcopy

from services.paired_nav_journal import read_snapshot
from services.paired_nav_lifecycle import registered_pairs
from services.paired_nav_atomic_candidate import verify_atomic_comparison
from services.paired_nav_atomic_policy import validate_atomic_policy


def registered_atomic_continuations(*, signal_date, query):
    definitions = {}
    for entry in registered_pairs(signal_date=signal_date, query=query):
        plan = entry['allocation']['payload']['content']
        if plan['owner'] != 'atomic_strategy':
            continue
        parent = read_snapshot(query, plan['allocation_context_snapshot_id'])
        verify_atomic_comparison(plan, parent, query=query)
        policy = validate_atomic_policy(parent['payload']['content']['atomic_recommendation_inputs']['policy_population'])
        key = plan['candidate_checksum']
        replacement = policy['definitions'][key]['replacement']
        member = definitions.setdefault(key, {'definitionChecksum': key,
            'replacement': deepcopy(replacement), 'executionSnapshotIds': []})
        if member['replacement'] != replacement:
            raise ValueError('paired_nav_atomic_continuation_identity_conflict')
        member['executionSnapshotIds'].append(entry['execution']['manifest']['snapshot_id'])
    for member in definitions.values():
        member['executionSnapshotIds'] = sorted(member['executionSnapshotIds'])
    return [definitions[key] for key in sorted(definitions)]
