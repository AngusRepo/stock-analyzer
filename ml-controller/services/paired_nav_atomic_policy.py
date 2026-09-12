"""Read the canonical policy owner; never rebuild a strategy from final picks."""
from copy import deepcopy
import re

from services.paired_nav_journal import digest


def validate_atomic_policy(population):
    context = population.get('policy_context')
    if not isinstance(context, dict):
        raise ValueError('paired_nav_atomic_policy_context_missing')
    if (context.get('schema_version') != 'atomic-policy-context-v1'
            or context.get('source_checksum') != population.get('source_checksum')
            or not re.fullmatch('[a-f0-9]{64}', str(context.get('source_checksum')))
            or context.get('context_checksum') != digest({k: v for k, v in context.items() if k != 'context_checksum'})):
        raise ValueError('paired_nav_atomic_policy_context_invalid')
    policy = context.get('policy') or {}
    specs, options = policy.get('specs'), policy.get('options')
    if not isinstance(specs, list) or not isinstance(options, dict):
        raise ValueError('paired_nav_atomic_policy_inputs_missing')
    stable = deepcopy(options)
    for field in ('regime', 'strategyPortfolioMetrics', 'strategySimilarityGraphEvidence',
                  'runtimeTeacherEvidence', 'previousSlateSymbols'):
        stable.pop(field, None)
    if stable.get('performanceWeightOwner') in {'formal_evidence_owner', 'ple_portfolio_metrics'}:
        stable.pop('strategyWeights', None)
        stable.pop('productionStrategyWeights', None)
    identity = {'schema_version': 'atomic-policy-identity-v1', 'specs': specs, 'options': stable}
    if context.get('identity') != identity or context.get('policy_checksum') != digest(identity):
        raise ValueError('paired_nav_atomic_policy_identity_mismatch')
    by_id = {}
    for spec in specs:
        if (not isinstance(spec, dict) or not isinstance(spec.get('id'), str) or not spec['id']
                or spec['id'] in by_id or not isinstance(spec.get('version'), str) or not spec['version']):
            raise ValueError('paired_nav_atomic_policy_spec_identity_invalid')
        by_id[spec['id']] = spec
    definitions = {}
    for item in population['replacements']:
        replacement = item.get('replacement') or {}
        candidate, incumbent = by_id.get(replacement.get('candidateId')), by_id.get(replacement.get('incumbentId'))
        if (candidate is None or incumbent is None or candidate['id'] == incumbent['id']
                or candidate['version'] != replacement.get('candidateVersion')
                or incumbent['version'] != replacement.get('incumbentVersion')):
            raise ValueError('paired_nav_atomic_policy_replacement_identity_invalid')
        definition = {'replacement': replacement, 'candidate': candidate, 'incumbent': incumbent}
        if 'weight_policy_version' in item:
            if item['weight_policy_version'] != 'strategy-original-daily-weight-owner-v1':
                raise ValueError('paired_nav_atomic_weight_policy_unsupported')
            definition['weight_policy_version'] = item['weight_policy_version']
        checksum = digest(definition)
        if checksum != item.get('definition_checksum') or checksum in definitions:
            raise ValueError('paired_nav_atomic_policy_definition_mismatch')
        definitions[checksum] = deepcopy(definition)
    return {'context': deepcopy(context), 'definitions': definitions}
