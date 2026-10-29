"""R33-NEW-15: switch Paper to the R33 seven-model strategy in five go-gated steps.

kv-config -> admission -> grant -> r33-row -> promotion. `prepare` builds every value
from read-only inputs; nothing here writes. Each step names one write with its before
and after value, so a step runs only when the live state is exactly what the previous
step left, and rollback is the same write reversed. The promotion step is the original
atomic publisher (7 champion pointers, 7 registry rows, 1 ensemble pointer); this module
never writes a pointer itself.
"""
from copy import deepcopy

from services.paired_nav_journal import digest

SCHEMA = 'r33-cutover-switch-packet-v1'
STEPS = ('kv-config', 'admission', 'grant', 'r33-row', 'promotion')
IDENTITY_KEYS = ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')
EXIT_FIELDS = ('swingHardStopPct', 'swingMaxHoldSessions')


def _fail(reason):
    return RuntimeError('r33_switch:' + reason)


def l3_identity(row):
    return {'schema_version': 'paired-nav-formal-ml-baseline-v1', **{k: row[k] for k in IDENTITY_KEYS}}


def ensemble_from_bundle(bundle, *, bundle_path, bundle_sha256, serving_table):
    """The R33 object (slice A section 2) from the sealed monthly bundle and its cross-fit table."""
    from services.r33_crossfit_serving import validate_serving
    from services.r33_ensemble import build_ensemble
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX, BUNDLE_SCHEMA, PROMOTION_DECISION
    checks = bundle.get('oof_checks') or {}
    if (bundle.get('schema_version') != BUNDLE_SCHEMA or bundle.get('status') != 'sealed'
            or bundle.get('promotion_decision') != PROMOTION_DECISION
            or bundle_path != f"{BUNDLE_PREFIX}/{bundle.get('cohort_id')}/bundle.json"
            or checks.get('status') != 'pass' or checks.get('pit_certified') is not True):
        raise _fail('bundle_not_sealed_pass')
    source_checksum = bundle['calibration']['payload_checksum']
    validate_serving(serving_table, source_checksum=source_checksum)
    return build_ensemble(
        cohort_id=bundle['cohort_id'], base_artifacts=bundle['artifacts'], serving_calibration=serving_table,
        source_bundle={'path': bundle_path, 'sha256': bundle_sha256, 'manifest_checksum': bundle['manifest_checksum'],
                       'oof_checks_checksum': checks['checksum'], 'source_calibration_checksum': source_checksum},
        validation={'decision': 'PASS', 'oof_checks_status': checks['status'], 'pit_certified': True,
                    'pit_certification_sha256': checks['pit_certification_sha256']})


def ensemble_row(ensemble, bundle, *, archive_uri):
    """The active8_ensemble_artifacts_v1 row for an R33 object (read by _validate_r33_row).

    schema_version is the table's row-format version: the column admits only the existing
    ARTIFACT_SCHEMA_VERSION, so an R33 row keeps it and the payload carries its own
    r33-equal7-ensemble-v1 (Wei 10/29: no migration). knowledge_cutoff_date is the bundle's
    last full-fit signal date. archive_uri names the sealed, write-once bundle the object is
    rebuilt from byte for byte.
    """
    import json
    from services.ensemble_v2 import ARTIFACT_SCHEMA_VERSION
    from services.paired_nav_l3_candidate import _validate_r33_row
    row = {'artifact_id': ensemble['artifact_id'], 'cohort_id': ensemble['cohort_id'],
           'training_run_id': bundle['training_run_id'], 'knowledge_cutoff_date': bundle['full_fit_signal_date_max'],
           'schema_version': ARTIFACT_SCHEMA_VERSION, 'payload_json': json.dumps(ensemble, sort_keys=True),
           'payload_checksum': ensemble['payload_checksum'],
           'base_artifact_set_checksum': ensemble['base_artifact_set_checksum'],
           'validation_decision': ensemble['validation']['decision'],
           'validation_json': json.dumps(ensemble['validation'], sort_keys=True), 'archive_uri': archive_uri}
    _validate_r33_row(row, ensemble)
    return row


def roster_status(meta_layer):
    """Serving compares ml:adaptive_params meta_layer with the R33 order (verify_serving_configuration)."""
    from services.alpha_model_roster import R33_MODELS
    meta = meta_layer if isinstance(meta_layer, dict) else {}
    found = {key: meta.get(key) for key in ('alpha_vote_models', 'formal_layer3_slots')}
    return {'expected': list(R33_MODELS), **found, 'matches': all(v == list(R33_MODELS) for v in found.values())}


def check_prior(prior, *, live_prior, merged_config, admission, pointer):
    """The grant the cutover replaces must be the one KV serves now, for the config and pointer now."""
    if digest(prior) != digest(live_prior):
        raise _fail('prior_not_active_grant')
    if prior.get('admission') != admission:
        raise _fail('prior_not_active_admission')
    if digest(prior['configuration']['trading_config']) != digest(merged_config):
        raise _fail('prior_config_not_live_config')
    candidate = admission['strategy_bundle']['candidate_l3_identity']
    if any(candidate.get(k) != pointer.get(k) for k in IDENTITY_KEYS):
        raise _fail('prior_candidate_not_live_pointer')


def next_raw_config(raw, next_merged):
    """Raw KV with only the scope paths set to their next merged values; Worker merging does the rest.

    The policy block has no Worker default, so the raw block must already be the whole merged one.
    """
    from services.r33_cutover import SCOPE_PATHS, _ABSENT, _get, _set, changed_paths
    if raw.get('l4Distribution') is None:
        raise _fail('raw_policy_missing')
    result = deepcopy(raw)
    for path in SCOPE_PATHS:
        value = _get(next_merged, path)
        if value is _ABSENT:
            raise _fail('next_config_missing:' + path)
        _set(result, path, value)
    changed_paths(raw, result)
    return result


def prepare(*, raw_config, merged_config, prior, old_admission, pointer, current_plan_id, bundle, bundle_path,
            bundle_sha256, serving_table, training_label_known_max, source_evidence, exit_rules, business_date,
            effective_signal_date, wei_approval, source_reference, approved_at, runtime_key, runtime_before,
            archive_uri, meta_layer, now):
    """Every value the five steps write, validated with the same owners serving uses."""
    from services.active8_paper_admission import (KEY, RUNTIME_SCHEMA, SCHEMA as ADMISSION_SCHEMA,
                                                  validate_admission, validate_runtime_approval)
    from services.l3_equal_weight_bundle import build_bundle
    from services.l4_distribution_lifecycle import ACCEPTANCE_CHECKS
    from services.l4_distribution import digest as packet_digest
    from services.l4_distribution_runtime import distribution_policy_identity, validate_opb_policy
    from services.l4_release_packet import prepare_packet
    from services.paper_strategy_mode import validate_model_mode
    from services.paired_nav_strategy_bundle import SCHEMA as BUNDLE_SCHEMA
    from services.r33_cutover import SCHEMA as EVIDENCE_SCHEMA, RANK_POOL_SCHEMA, changed_paths, validate_against_ensemble
    from services.r33_crossfit_serving import TABLE_NAME
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX
    from services.strategy_ab import FEE_TERMS, R33_SCHEMA, bind_r33
    if set(exit_rules) != set(EXIT_FIELDS):
        raise _fail('exit_rules_required')
    ensemble = ensemble_from_bundle(bundle, bundle_path=bundle_path, bundle_sha256=bundle_sha256,
                                    serving_table=serving_table)
    identity = l3_identity(ensemble)
    candidate = build_bundle(l3_identity=identity, ensemble=ensemble,
                             training_label_known_max=training_label_known_max)
    policy = merged_config['l4Distribution']
    opb = {k: v for k, v in policy['opb'].items() if k != 'approved_policy_identity'}
    shape = {'policy_schema': policy['policy_schema']} if policy.get('policy_schema') is not None else {}
    opb['approved_policy_identity'] = distribution_policy_identity(
        {**shape, 'artifact': candidate, 'constraints': policy['constraints'], 'opb': opb}, identity)
    source = {**deepcopy(source_evidence), 'scope': 'native_engineering_paper_execution', 'complete': True,
              'model_checksum': candidate['model_checksum'], 'efficacy_status': 'unproven',
              # The OPB starts over: the prior policy's rewards and replay do not transfer.
              'opb_prior_rewards_transferred': False, 'opb_policy': opb}
    acceptance = {'schema_version': 'l4-paper-acceptance-v1', 'model_checksum': candidate['model_checksum'],
                  'l3_identity_checksum': packet_digest(identity), 'feature_schema': candidate['feature_schema'],
                  'checks': dict.fromkeys(ACCEPTANCE_CHECKS, True), 'source_evidence_checksum': packet_digest(source),
                  'acceptance_mode': 'paper_experiment', 'efficacy_status': 'unproven',
                  'experiment_authorization': {'scope': 'paper', 'approved': True, 'source_reference': source_reference,
                                               'model_checksum': candidate['model_checksum']}}
    # prepare_packet releases the L4 bundle and checks constraints and OPB; the cutover then
    # changes only the scope paths of the live policy, so its other fields stay as they are.
    packet = prepare_packet(current_config=merged_config, candidate=candidate, acceptance=acceptance,
                            source_evidence=source, l3_identity=identity, constraints=policy['constraints'],
                            signal_date=business_date, current_l3_identity=l3_identity(pointer),
                            current_plan_id=current_plan_id)
    released = packet['next_config']['l4Distribution']
    next_policy = deepcopy(policy)
    next_policy.update(artifact=deepcopy(released['artifact']), operating_mode=released['operating_mode'],
                       strategy_role=released['strategy_role'])
    next_policy['opb']['approved_policy_identity'] = distribution_policy_identity(next_policy, identity)
    validate_model_mode(next_policy)
    validate_opb_policy(next_policy, next_policy['opb']['approved_policy_identity'], business_date)
    next_merged = deepcopy(merged_config)
    next_merged['l4Distribution'] = next_policy
    next_merged['exit'] = {**next_merged.get('exit', {}), **exit_rules}
    if digest(raw_config.get('l4Distribution')) != digest(policy):
        raise _fail('merged_policy_not_raw')
    next_raw = next_raw_config(raw_config, next_merged)

    check_prior(prior, live_prior=prior, merged_config=merged_config, admission=old_admission, pointer=pointer)
    configuration = deepcopy(prior['configuration'])
    configuration['trading_config'] = deepcopy(next_merged)
    strategy = {'schema_version': BUNDLE_SCHEMA, 'comparison_unit': 'complete_l3_l4_strategy',
                'declared_signal_date': business_date, 'baseline_l3_identity': l3_identity(pointer),
                'candidate_l3_identity': identity, 'baseline_trading_config': deepcopy(merged_config),
                'candidate_trading_config': deepcopy(next_merged),
                'source_evidence_checksum': packet['source_evidence_checksum'], 'production_effect': False}
    strategy['bundle_checksum'] = digest(strategy)
    experiment_id = digest({'schema_version': R33_SCHEMA, 'B': strategy['bundle_checksum'], 'fee_terms': FEE_TERMS})
    strategy = bind_r33(strategy, experiment_id=experiment_id, ensemble=ensemble)
    admission = {'schema_version': ADMISSION_SCHEMA, 'scope': 'paper', 'approved': True,
                 'efficacy_status': 'unproven', 'nav_gate_role': 'performance_review_after_paper_admission',
                 'source_reference': source_reference, 'approved_at': approved_at, 'business_date': business_date,
                 'strategy_bundle': strategy, 'configuration': deepcopy(configuration)}
    admission['admission_checksum'] = digest(admission)
    evidence = {'schema_version': EVIDENCE_SCHEMA, 'mode': next_merged['l4Distribution']['operating_mode'],
                'candidate_bundle': {'path': bundle_path, 'sha256': bundle_sha256, 'cohort_id': ensemble['cohort_id'],
                                     'manifest_checksum': bundle['manifest_checksum'],
                                     'oof_checks_checksum': bundle['oof_checks']['checksum'],
                                     'oof_checks_status': 'pass', 'pit_certified': True},
                'artifacts': deepcopy(ensemble['base_artifacts']),
                'base_artifact_set_checksum': ensemble['base_artifact_set_checksum'],
                'ensemble': {'artifact_id': ensemble['artifact_id'], 'payload_checksum': ensemble['payload_checksum']},
                'calibration': {'source_payload_checksum': bundle['calibration']['payload_checksum'],
                                'serving_table_path': f"{BUNDLE_PREFIX}/{ensemble['cohort_id']}/{TABLE_NAME}",
                                'serving_table_checksum': serving_table['payload_checksum']},
                'rank_pool_schema': RANK_POOL_SCHEMA, 'feature_schema': candidate['feature_schema'],
                'l4_model_checksum': candidate['model_checksum'],
                'economics_change_scope': changed_paths(merged_config, next_merged),
                'first_night': {'supersedes_plan_policy_identity': policy['opb']['approved_policy_identity'],
                                'effective_signal_date': effective_signal_date},
                'wei_approval': deepcopy(wei_approval)}
    approval = {'schema_version': RUNTIME_SCHEMA, 'admission': deepcopy(admission),
                'configuration': deepcopy(configuration), 'scope': 'paper', 'approved': True,
                'approved_at': approved_at, 'maturity_transfer': False, 'efficacy_status': 'unproven',
                'source_reference': source_reference, 'prior_runtime_approval': deepcopy(prior),
                'approved_r33_cutover': evidence}
    approval['approval_checksum'] = digest(approval)
    validate_admission(admission, artifact=ensemble, now=now)
    validate_runtime_approval(approval, admission, now=now)
    validate_against_ensemble(evidence, ensemble)
    row = ensemble_row(ensemble, bundle, archive_uri=archive_uri)
    result = {'schema_version': SCHEMA, 'ensemble': ensemble, 'ensemble_row': row, 'serving_table': serving_table,
              'l4_packet': packet, 'admission': admission, 'approval': approval,
              'baseline_pointer': {k: pointer[k] for k in IDENTITY_KEYS},
              'writes': {'kv-config': {'key': 'trading:config', 'before': raw_config, 'after': next_raw},
                         'admission': {'key': KEY, 'before': old_admission, 'after': admission},
                         'grant': {'key': runtime_key, 'before': runtime_before, 'after': approval}},
              'roster': roster_status(meta_layer),
              'e7_followup': 'trading:config is manifest-managed (E-7): upload the new raw value to GCS and '
                             'update the manifest digest by PR after the kv-config step; the drift alert is expected.'}
    result['packet_checksum'] = digest(result)
    return result


def step_states(packet, observed):
    """done / pending / drift per step from the live values; done steps must form a prefix."""
    pointer = observed['pointer']
    candidate = {k: packet['ensemble_row'][k] for k in IDENTITY_KEYS}
    states = {}
    for name, write in packet['writes'].items():
        value = observed[write['key']]
        states[name] = ('done' if digest(value) == digest(write['after'])
                        else 'pending' if digest(value) == digest(write['before']) else 'drift')
    row = observed['r33_row']
    states['r33-row'] = ('pending' if row is None
                         else 'done' if all(row.get(k) == v for k, v in packet['ensemble_row'].items()) else 'drift')
    current = {k: (pointer or {}).get(k) for k in IDENTITY_KEYS}
    states['promotion'] = ('done' if current == candidate
                           else 'pending' if current == packet['baseline_pointer'] else 'drift')
    order = [states[name] for name in STEPS]
    if 'drift' in order or order != sorted(order, key=lambda s: s != 'done'):
        raise _fail('live_state_drift:' + ','.join(f'{n}={states[n]}' for n in STEPS))
    return states


def next_step(packet, observed):
    states = step_states(packet, observed)
    return next((name for name in STEPS if states[name] == 'pending'), None), states


def rollback_step(packet, observed):
    """The last done step; undoing it is its write reversed (promotion: the atomic publisher back to baseline)."""
    states = step_states(packet, observed)
    return next((name for name in reversed(STEPS) if states[name] == 'done'), None), states
