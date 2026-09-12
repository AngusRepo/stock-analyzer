"""Frozen candidate inference -> real isolated sparse/OPB allocation plans.

This produces neither fills nor NAV. Existing EV maturity is never changed.
Candidate packets retain their genuine offline verdict and approval state.
"""
from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import date
from typing import Any

from services.expected_return_candidate_forward_evaluator import (
    _load_candidate_packet, _offline_admission,
)
from services.l4_alpha_ev_producer import _feature_value, assess_l4_artifact_cutover
from services.allocator_ev_fusion import (
    _feature_values as fusion_feature_values, materialize_allocator_ev_fusion,
)
from services.expected_return_numeric import evaluate_linear_net
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_journal import Query, Writer, digest, freeze_snapshot, number, read_snapshot


def _bucket():
    from google.cloud import storage
    name = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not name:
        raise RuntimeError('paired_nav_model_bucket_missing')
    return storage.Client().bucket(name)


def allocation_policy_identity(inputs: dict[str, Any]) -> dict[str, Any]:
    """Separate daily guard observations from the stable allocation policy.

    The full guard remains in the immutable input snapshot and BOTH actual
    allocator calls. Removing its daily observation from experiment identity
    must not disable the guard or merge a changed artifact/configuration.
    """
    policies = deepcopy({key: inputs[key] for key in ('alpha_policy', 'ranking_config', 'ensemble_v2_cfg')})
    for alias in ('allocatorEvFusion', 'allocator_ev_fusion'):
        fusion = policies['alpha_policy'].get(alias)
        if isinstance(fusion, dict):
            fusion.pop('runtime_forward_guard', None)
    return policies


def infer_candidate_values(candidate: dict[str, Any], rows: list[dict[str, Any]],
                           signal_date: str, *, l4: dict[str, float] | None = None) -> dict[str, float]:
    artifact = candidate['artifact']
    owner = candidate['registry']['model_name']
    admission = _offline_admission(candidate)
    if admission['decision'] != 'PASS':
        raise ValueError('paired_nav_candidate_integrity_not_admitted')
    cutoff = str((artifact.get('training_data') or {}).get('label_known_max_date') or '')
    if not cutoff or date.fromisoformat(cutoff[:10]) >= date.fromisoformat(signal_date):
        raise ValueError('paired_nav_training_outcome_cutoff_invalid')
    if number(artifact.get('horizon_days'), 'horizon_days') != 5:
        raise ValueError('paired_nav_candidate_horizon_incompatible')
    # Shadow permits an unapproved/efficacy-failed artifact, not an invalid one.
    # Use the serving validator without mutating its verdict or approval state.
    allowed_shadow_blockers = {'validation_packet_not_pass', 'production_approval_missing'}
    if owner == 'l4_alpha_ev':
        blockers = set(assess_l4_artifact_cutover(artifact)['blockers']) - allowed_shadow_blockers
        if blockers:
            raise ValueError('paired_nav_candidate_contract_invalid:' + ','.join(sorted(blockers)))
    values = {}
    for row in rows:
        symbol = str(row['symbol'])
        if symbol in values:
            raise ValueError('paired_nav_duplicate_prediction_symbol')
        if owner == 'l4_alpha_ev':
            prediction = row.get('forecast_data') or {}
            if isinstance(prediction, str):
                prediction = json.loads(prediction)
            features = {name: _feature_value(name, row, prediction) for name in artifact['feature_names']}
            for name, value in features.items():
                number(value, f'{symbol}.{name}')
            value, _ = evaluate_linear_net(intercept=artifact['intercept'], coefficients=artifact['coefficients'],
                features=features, artifact=artifact, clip=artifact.get('output_clip') or {})
            value = round(value, 10)
        elif owner == 'allocator_ev_fusion':
            if l4 is None or symbol not in l4:
                raise ValueError('paired_nav_exact_l4_baseline_missing')
            residual = artifact['residual_adjustment_model']
            if residual.get('status') != 'fitted' or not residual.get('coefficients'):
                raise ValueError('paired_nav_residual_model_not_fitted')
            alpha = row.get('alpha_context') or {}
            if isinstance(alpha, str):
                alpha = json.loads(alpha)
            market_heat = row.get('market_heat_expected_return')
            if market_heat is None:
                market_heat = alpha.get('market_heat_expected_return')
            if market_heat is not None:
                market_heat = max(0.0, number(market_heat, symbol + '.market_heat_expected_return'))
            validation = materialize_allocator_ev_fusion(row, l4_value=l4[symbol],
                l4_source='paired_exact_l4', l4_payload=None,
                market_heat_expected_return=market_heat, policy={'allocatorEvFusion': artifact})
            if validation is None:
                raise ValueError('paired_nav_candidate_contract_missing')
            blockers = set(validation.get('blockers') or []) - allowed_shadow_blockers
            if blockers:
                raise ValueError('paired_nav_candidate_contract_invalid:' + ','.join(sorted(blockers)))
            features = fusion_feature_values(l4_value=l4[symbol], market_heat_expected_return=market_heat, row=row)
            net, _ = evaluate_linear_net(intercept=residual['intercept'], coefficients=residual['coefficients'],
                features=features, artifact=artifact, clip=artifact.get('residual_output_clip') or {})
            value = round(l4[symbol] + net, 10)
        else:
            raise ValueError('paired_nav_candidate_owner_invalid')
        values[symbol] = number(value, symbol + '.expected_return')
    return values


def collect_candidate_allocations(*, snapshot_id: str, query: Query, writer: Writer, bucket=None) -> dict[str, Any]:
    from services.paired_nav_collection import shadow_failure
    from services.paired_nav_l3_candidate import collect_ensemble_allocations
    from services.paired_nav_opb_candidate import collect_opb_allocations
    # These owners share a frozen parent, not each other's execution success.
    # Keep failures explicit while returning independently verified plans.
    results, failures = {}, {}
    for owner, collect, extra in (
            ('expected_return', _collect_ev_allocations, {'bucket': bucket}),
            ('ensemble', collect_ensemble_allocations, {}),
            ('opb_arm_prior', collect_opb_allocations, {})):
        try:
            results[owner] = collect(snapshot_id=snapshot_id, query=query, writer=writer, **extra)
            candidate_failures = results[owner].get('candidate_failures') or []
            if candidate_failures:
                failures[owner] = {**candidate_failures[0], 'candidate_failures': candidate_failures}
        except Exception as exc:
            failures[owner] = shadow_failure('candidate_allocations', exc)
            results[owner] = {'status': 'failed', 'plans': []}
    ev, l3, opb = results['expected_return'], results['ensemble'], results['opb_arm_prior']
    if (not failures and l3['status'] in {'legacy_context_without_l3_selection', 'historical_not_prospective'}
            and opb['status'] in {'legacy_context_without_opb_selection', 'historical_not_prospective'}):
        return ev
    plans = [*ev['plans'], *l3['plans'], *opb['plans']]
    status = 'allocation_pairs_frozen' if plans else ev['status']
    if failures:
        status = 'partial_allocation_pairs' if plans else 'candidate_allocations_failed'
    return {**ev, 'plans': plans, 'production_effect': False, 'can_write_order': False,
            'nav_maturity_credit': 0, 'promotion_allowed': False,
            'lifecycle_transitions': [item for result in results.values() for item in result.get('lifecycle_transitions', [])],
            'lifecycle_transition_plan': [item for result in results.values() for item in result.get('lifecycle_transition_plan', [])],
            'status': status, **({'owner_failures': failures} if failures else {}),
            **({'pending_dependencies': opb['pending_dependencies']} if opb.get('pending_dependencies') else {}),
            'owner_status': {owner: result['status'] for owner, result in results.items()}}


def _collect_ev_allocations(*, snapshot_id: str, query: Query, writer: Writer, bucket=None) -> dict[str, Any]:
    from services.paired_nav_lifecycle import resolve_pair_id, prepare_comparison_transitions
    saved = read_snapshot(query, snapshot_id)
    manifest, context = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_allocation_context_required')
    base = {'production_effect': False, 'can_write_order': False, 'nav_maturity_credit': 0, 'plans': []}
    if not manifest['prospective']:
        return {**base, 'status': 'historical_not_prospective'}
    if context.get('allocator_source_identity') != allocator_source_identity():
        raise ValueError('paired_nav_allocator_source_changed')
    baseline_identity = context.get('formal_baseline_identity')
    if (not isinstance(baseline_identity, dict)
            or baseline_identity.get('schema_version') != 'paired-nav-formal-ml-baseline-v1'
            or any(not baseline_identity.get(key) for key in (
                'artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum'))):
        raise ValueError('paired_nav_formal_baseline_identity_missing')
    from services.paired_nav_ev_selection import select_ev_candidates
    signal_date = manifest['signal_date']
    selection = select_ev_candidates(snapshot_id=snapshot_id, signal_date=signal_date, query=query)
    if not selection['l4_checksums']:
        return {**base, 'status': 'awaiting_frozen_l4_candidate'}
    if not context.get('risk_config') or not context.get('trading_config'):
        raise ValueError('paired_nav_full_configuration_missing')
    model_bucket = bucket if bucket is not None else _bucket()
    from services.paired_nav_collection import shadow_failure
    candidates, failures = {}, []
    registry_rows = {row['checksum']: row for row in selection['registry_rows']}
    def failure(checksum, stage, exc, dependency=None):
        row = registry_rows[checksum]
        detail = shadow_failure(stage, exc)
        # Preserve only known safe validation codes, never arbitrary private URLs.
        if str(exc) in {'candidate_forward_packet_checksum_mismatch',
                        'candidate_forward_training_cohort_identity_mismatch',
                        'candidate_forward_packet_identity_mismatch'}:
            detail['reason'] = str(exc)
        failures.append({**detail, 'owner': row['model_name'],
            'candidate_checksum': checksum, 'candidate_artifact_id': row['artifact_id'],
            **({'dependency_checksum': dependency} if dependency else {})})
    for checksum, row in registry_rows.items():
        try:
            candidate = _load_candidate_packet(model_bucket, row)
            if str(row['source_run_date'])[:10] > signal_date:
                raise ValueError('paired_nav_candidate_created_after_signal')
            candidates[checksum] = candidate
        except Exception as exc:
            failure(checksum, 'candidate_artifact_load', exc)
    inputs = context['inputs']
    inherited = context['capture'].get('inherited_state') or {}
    if context.get('recommendation_context') is not None:
        from services.paired_nav_recommendation_path import replay_frozen_recommendation_allocation
        # New daily captures verify the complete recommendation boundary, not
        # just the subset which the incumbent happened to keep. Legacy EV-only
        # snapshots remain unchanged; they cannot qualify as upstream L3 replay.
        incumbent = replay_frozen_recommendation_allocation(
            snapshot_id=snapshot_id, query=query)['allocation']
    else:
        incumbent = run_isolated_allocation(inputs=inputs, inherited_state=inherited)
    if incumbent['output'] != context['formal_output']:
        raise RuntimeError('paired_nav_incumbent_allocation_replay_mismatch')
    configuration = {key: context[key] for key in ('trading_config', 'risk_config', 'allocator_source_identity')}
    configuration['formal_baseline_identity'] = baseline_identity
    configuration['allocator_policies'] = allocation_policy_identity(inputs)
    from services.paired_nav_execution_environment import configuration_environment
    configuration.update(configuration_environment(saved))
    config_checksum = digest(configuration)
    prediction_rows = deepcopy(inputs['recommendations'])
    for row in prediction_rows:
        prediction = (context.get('model_predictions') or {}).get(str(row['symbol']))
        if prediction is not None:
            row['forecast_data'] = prediction
    plans, transitions, l4_plans = [], [], {}
    def freeze_plan(owner, candidate, baseline, challenger, baseline_checksum, l4_checksum):
        root_pair_id = digest([owner, candidate['checksum'], baseline_checksum, config_checksum])
        pair_id = resolve_pair_id(root_pair_id, signal_date=signal_date, query=query)
        old_id = digest(['allocation_pair', signal_date, pair_id])
        existing = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [old_id])
        old_plan = read_snapshot(query, old_id)['payload']['content'] if existing else None
        extra = {'ev_candidate_selection': selection} if old_plan is None or 'ev_candidate_selection' in old_plan else {}
        seal = freeze_snapshot(signal_date=signal_date, source_run_id=pair_id, snapshot_kind='allocation_pair',
            query=query, writer=writer, content={
                'pair_id': pair_id, 'root_pair_id': root_pair_id, 'owner': owner, 'candidate_checksum': candidate['checksum'],
                'baseline_checksum': baseline_checksum, 'exact_l4_checksum': l4_checksum,
                **extra,
                'candidate_artifact_id': candidate['registry']['artifact_id'],
                'candidate_training_run_id': candidate['registry']['training_run_id'],
                'allocation_context_snapshot_id': snapshot_id,
                'configuration': configuration, 'configuration_checksum': config_checksum,
                'allocation_input_checksum': digest(inputs), 'baseline': baseline, 'candidate': challenger,
                'model_predictions_checksum': digest(context.get('model_predictions')),
                'production_effect': False, 'can_write_order': False, 'nav_maturity_credit': 0,
            })
        return {'pair_id': pair_id, 'snapshot_id': seal['snapshot_id'], 'owner': owner}

    for checksum in selection['l4_checksums']:
        if checksum not in candidates:
            continue  # Load failure is already recorded; denominator unchanged.
        stage = 'candidate_inference'
        try:
            l4 = candidates[checksum]
            l4_values = infer_candidate_values(l4, prediction_rows, signal_date)
            stage = 'candidate_allocation'
            l4_plan = run_isolated_allocation(inputs=inputs, inherited_state=inherited, forecasts=l4_values,
                                             owner='l4_alpha_ev', candidate_checksum=checksum)
            stage = 'candidate_allocation_seal'
            item = freeze_plan('l4_alpha_ev', l4, incumbent, l4_plan, digest(baseline_identity), checksum)
            stage = 'candidate_lifecycle_prepare'
            changes = prepare_comparison_transitions(plans=[item], signal_date=signal_date, query=query)
            plans.append(item)
            transitions.extend(changes)
            l4_plans[checksum] = (l4_values, l4_plan)
        except Exception as exc:
            failure(checksum, stage, exc)
    for checksum, l4_checksum in selection['fusion_bases'].items():
        if checksum not in candidates:
            continue
        if l4_checksum not in l4_plans:
            failure(checksum, 'candidate_dependency', ValueError('paired_nav_exact_l4_baseline_unavailable'), l4_checksum)
            continue
        stage = 'candidate_inference'
        try:
            fusion = candidates[checksum]
            l4_values, l4_plan = l4_plans[l4_checksum]
            fused_values = infer_candidate_values(fusion, prediction_rows, signal_date, l4=l4_values)
            stage = 'candidate_allocation'
            # Only EV changes in this residual intervention; same frozen OPB priors.
            fused_plan = run_isolated_allocation(inputs=inputs, inherited_state=inherited, forecasts=fused_values,
                                                owner='l4_alpha_ev', candidate_checksum=fusion['checksum'])
            stage = 'candidate_allocation_seal'
            item = freeze_plan('allocator_ev_fusion', fusion, l4_plan, fused_plan, l4_checksum, l4_checksum)
            stage = 'candidate_lifecycle_prepare'
            changes = prepare_comparison_transitions(plans=[item], signal_date=signal_date, query=query)
            plans.append(item)
            transitions.extend(changes)
        except Exception as exc:
            failure(checksum, stage, exc)
    return {**base, 'status': ('partial_allocation_pairs' if plans else 'candidate_allocations_failed')
            if failures else 'allocation_pairs_frozen', 'plans': plans,
            **({'candidate_failures': failures} if failures else {}),
            'lifecycle_transition_plan': transitions, 'lifecycle_transitions': []}
