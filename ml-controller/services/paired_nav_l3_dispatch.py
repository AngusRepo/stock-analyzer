"""Freeze every executable candidate bundle before dispatch; no latest-only cut.

Registry candidates remain the admission owner. This does not retire a running
NAV experiment or grant serving authority when the registry changes state.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

from services.active_model_policy import ACTIVE_ALPHA_MODELS
from services.active8_score_semantics import normalize_active8_challenger_scores
from services.paired_nav_journal import digest, _timestamp, read_snapshot
from services.paired_nav_l3_candidate import _identity, _validate_payload_identity


def registered_candidate_pins(*, signal_date, query):
    """A mutable registry status cannot silently end a registered NAV account.

    Read the latest immutable registration per pair, not a mutable latest-model
    pointer. Retirement must be resolved by the NAV lifecycle owner, not by a
    training job replacing a base artifact. No retirement is inferred here.
    """
    from services.paired_nav_lifecycle import registered_pairs
    manifests = [entry['execution']['manifest']
                 for entry in registered_pairs(signal_date=signal_date, query=query)]
    pins = []
    for row in manifests:
        execution = read_snapshot(query, row['snapshot_id'])
        packet = execution['payload']['content']
        if packet.get('owner') != 'ensemble':
            continue
        allocation = read_snapshot(query, packet['allocation_snapshot_id'])
        plan = allocation['payload']['content']
        if (allocation['manifest']['snapshot_kind'] != 'allocation_pair'
                or allocation['manifest']['prospective'] != 1
                or allocation['manifest']['signal_date'] != execution['manifest']['signal_date']
                or any(packet.get(k) != plan.get(k) for k in
                       ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum'))):
            raise ValueError('paired_nav_l3_registered_pin_parent_mismatch')
        parent = read_snapshot(query, plan['allocation_context_snapshot_id'])
        selection = parent['payload']['content']['recommendation_context']['l3_candidate_selection']
        matches = [c for c in selection['candidates']
                   if c['artifact']['payload_checksum'] == plan['candidate_checksum']]
        if len(matches) != 1:
            raise ValueError('paired_nav_l3_registered_pin_candidate_missing')
        candidate = deepcopy(matches[0])
        _validate_payload_identity(candidate['registry'], candidate['artifact'])
        candidate['registered_pair'] = {k: plan[k] for k in
            ('pair_id', 'baseline_checksum', 'configuration_checksum')}
        candidate['registered_pair']['execution_snapshot_id'] = row['snapshot_id']
        pins.append(candidate)
    return pins


def prepare_candidate_requests(*, signal_date, decision_cutoff, sequence_series,
                               query, project, subsets):
    cutoff = _timestamp(decision_cutoff)
    if (cutoff.astimezone(timezone(timedelta(hours=8))).date().isoformat() < signal_date
            or cutoff.date().isoformat() > signal_date):
        raise ValueError('paired_nav_l3_dispatch_cutoff_invalid')
    selected = query("SELECT * FROM active8_ensemble_artifacts_v1 WHERE state='candidate' "
        "AND production_effect=0 AND julianday(created_at)<=julianday(?) "
        "AND knowledge_cutoff_date<=? ORDER BY created_at,artifact_id", [decision_cutoff, signal_date])
    registered = registered_candidate_pins(signal_date=signal_date, query=query)
    packets = {row['payload_checksum']: {'registry': row, 'artifact': json.loads(row['payload_json'])}
               for row in selected}
    for candidate in registered:
        key = candidate['artifact']['payload_checksum']
        if key in packets:
            if packets[key]['artifact'] != candidate['artifact']:
                raise ValueError('paired_nav_l3_registered_artifact_changed')
            packets[key].setdefault('registered_pairs', []).append(candidate['registered_pair'])
        else:
            packets[key] = {**candidate, 'registered_pairs': [candidate['registered_pair']]}
    bundles, candidates = {}, []
    for packet in packets.values():
        row, artifact = packet['registry'], packet['artifact']
        _validate_payload_identity(row, artifact)
        created = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        created = created.replace(tzinfo=timezone.utc) if created.tzinfo is None else created
        if (created > cutoff or row['state'] != 'candidate' or row['production_effect'] != 0
                or artifact['knowledge_cutoff_date'] > signal_date):
            raise ValueError('paired_nav_l3_dispatch_candidate_time_invalid')
        base = artifact['observation_artifacts']
        if set(base) != set(ACTIVE_ALPHA_MODELS):
            raise ValueError('paired_nav_l3_dispatch_base_set_invalid')
        key = digest(base)
        candidates.append({'registry': deepcopy(row), 'artifact': artifact, 'bundle_key': key,
            'registered_pairs': packet.get('registered_pairs') or []})
        if key in bundles:
            continue
        ids = [base[name]['artifact_id'] for name in ACTIVE_ALPHA_MODELS]
        rows = query('SELECT * FROM model_artifact_registry WHERE artifact_id IN ('
                     + ','.join('?' for _ in ids) + ')', ids)
        by_model = {row['model_name']: row for row in rows}
        if len(rows) != len(ids) or set(by_model) != set(base):
            raise ValueError('paired_nav_l3_dispatch_base_registry_missing')
        for name, expected in base.items():
            if _identity(by_model[name]) != expected:
                raise ValueError('paired_nav_l3_dispatch_base_identity_mismatch')
        projection = project({'selected': rows, 'suppressed': []})
        projected = projection['candidates']
        suppressed = [r for r in projection['suppressions']
                      if r.get('schema_version') != 'active8-shadow-suppression-summary-v1'
                      or r.get('total_count') != 0]
        if suppressed or len(projected) != len(ids):
            raise ValueError('paired_nav_l3_dispatch_base_contract_invalid')
        contracts = {r['model']: {**r['schema']['sequence_contract'], 'artifact_path': r['artifact_path']}
            for r in projected if r['model'] in {'DLinear', 'PatchTST', 'iTransformer'}}
        usable, _ = subsets(sequence_series, contracts=contracts)
        bundles[key] = {'bundle_key': key, 'candidates': projected,
            'sequence_series_by_model': usable, 'sequence_contracts': contracts}
    requests = list(bundles.values())
    return {'schema_version': 'paired-nav-l3-candidate-selection-v2',
        'signal_date': signal_date, 'decision_cutoff': decision_cutoff,
        'status': 'candidate_ensembles_frozen' if candidates else 'awaiting_matching_executable_ensemble',
        'candidates': candidates, 'requests': requests, 'request_checksum': digest(requests),
        'production_effect': False}


def capture_candidate_selection(*, state, predictions):
    selection = deepcopy(state['paired_nav_l3_dispatch'])
    if selection.get('status') == 'failed':
        raise ValueError('paired_nav_l3_dispatch_failed')
    if selection.get('signal_date') != state['run_date']:
        raise ValueError('paired_nav_l3_dispatch_date_mismatch')
    requests = selection['requests']
    if digest(requests) != selection['request_checksum']:
        raise ValueError('paired_nav_l3_dispatch_checksum_invalid')
    inference = (state.get('modal_prediction_bundle') or {}).get('paired_nav_l3_inference') or {}
    if (inference.get('schema_version') != 'paired-nav-l3-inference-v1'
            or inference.get('request_checksum') != selection['request_checksum']
            or inference.get('production_effect') is not False or inference.get('status') != 'complete'
            or set(inference.get('bundles') or {}) != {r['bundle_key'] for r in requests}):
        raise ValueError('paired_nav_l3_dispatch_inference_missing_or_failed')
    maps = {}
    context = state['pipeline_modal_serving_context']
    for request in requests:
        key = request['bundle_key']
        record = inference['bundles'][key]
        bundle = record.get('result') or {}
        manifest = deepcopy(context['serving_manifest'])
        manifest['active8_shadow_candidates'] = request['candidates']
        manifest['active8_shadow_suppressions'] = []
        identities = {r['model']: {k: r[k] for k in (
            'version', 'artifact_id', 'artifact_path', 'metadata_path', 'checksum')}
            for r in request['candidates']}
        if (record.get('status') != 'complete' or bundle.get('serving_manifest_digest') != digest(manifest)
                or bundle.get('active8_shadow_artifact_identities') != identities
                or bundle.get('run_date') != state['run_date']
                or bundle.get('run_id') != state.get('producer_run_id')
                or bundle.get('modal_source_sha') != context['expected_source_sha']):
            raise ValueError('paired_nav_l3_dispatch_result_identity_mismatch')
        rows = bundle.get('predict_batch_v2_results') or []
        by_symbol = {r.get('symbol'): r for r in rows}
        if len(rows) != len(by_symbol) or set(by_symbol) != set(predictions):
            raise ValueError('paired_nav_l3_dispatch_feature_universe_mismatch')
        arm = deepcopy(predictions)
        for symbol, pred in arm.items():
            row = by_symbol[symbol]
            if row.get('error'):
                raise ValueError('paired_nav_l3_dispatch_feature_failed')
            for field in ('challenger_raw_model_scores', 'challenger_model_score_lineage'):
                pred.pop(field, None)
            pred['challenger_rank_scores'] = deepcopy(row.get('challenger_rank_scores') or {})
            pred['challenger_model_signals'] = {}
        sequences = (bundle.get('active8_sequence_shadow_raw') or {}).get('candidates') or {}
        for name in request['sequence_contracts']:
            seq = sequences.get(name) or {}
            expected = {str(r.get('symbol') or r.get('stock_id'))
                        for r in request['sequence_series_by_model'][name]}
            results = seq.get('results') or []
            expected_status = 'complete' if expected else 'insufficient_sequence_input'
            if (seq.get('status') != expected_status or seq.get('identity') != identities[name]
                    or len(results) != len(expected) or {r.get('symbol') for r in results} != expected):
                raise ValueError('paired_nav_l3_dispatch_sequence_incomplete')
            for row in results:
                if row.get('error'):
                    raise ValueError('paired_nav_l3_dispatch_sequence_failed')
                arm[row['symbol']]['challenger_model_signals'][name] = deepcopy(row)
        normalize_active8_challenger_scores(arm,
            candidate_rows={r['model']: r for r in request['candidates']}, run_date=state['run_date'])
        maps[key] = arm
    selection['predictions_by_bundle'] = maps
    return selection
