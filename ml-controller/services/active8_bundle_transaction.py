"""Concurrency and lost-ACK recovery for the original Active-8 atomic publisher.

No efficacy evaluator, promotion permission, new table or alternate publisher.
Guards execute inside the same D1 batch as the original pointer/history writes.
"""
import json
import re


TABLES = frozenset({'model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
                   'active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1',
                   'paired_nav_review_records_v1', 'paired_nav_review_parts_v1'})
BASE_IDENTITY = ('artifact_id', 'model_name', 'version', 'checksum', 'candidate_type',
                 'training_run_id', 'artifact_path', 'metadata_path', 'offline_evidence_json')
ENSEMBLE_IDENTITY = ('artifact_id', 'cohort_id', 'training_run_id', 'payload_json',
                     'payload_checksum', 'base_artifact_set_checksum', 'validation_decision')


def _snapshot_guards(table, where, params, rows):
    """NULL-safe exact source snapshots; malformed JSON aborts the whole batch.

    Identifiers and predicates are internal constants, never request input.
    Separate row statements stay below D1's per-statement binding limit.
    """
    if table not in TABLES:
        raise ValueError('active8_bundle_guard_table_invalid')
    failure = "json('active8_bundle_concurrent_change')"
    guards = [(f'SELECT CASE WHEN (SELECT COUNT(*) FROM {table} WHERE {where})=? '
               f'THEN 1 ELSE {failure} END', [*params, len(rows)])]
    for row in rows:
        columns = sorted(row)
        if not columns or any(not re.fullmatch(r'[a-z][a-z0-9_]*', key) for key in columns):
            raise ValueError('active8_bundle_guard_columns_invalid')
        condition = ' AND '.join(f'{key} IS ?' for key in columns)
        guards.append((f'SELECT CASE WHEN EXISTS(SELECT 1 FROM {table} WHERE {condition}) '
                       f'THEN 1 ELSE {failure} END', [row[key] for key in columns]))
    return guards


def prepare_bundle_transaction(*, query, by_model, supplied_pointers, ensemble_row, selected_models):
    """Re-read source state, return transaction guards or a verified old commit."""
    model_names = sorted(by_model)
    placeholders = ','.join('?' for _ in model_names)
    reads = [
        ('model_artifact_registry', f'artifact_id IN ({placeholders})',
         [by_model[name]['artifact_id'] for name in model_names]),
        ('model_champion_pointers', f'model_name IN ({placeholders})', model_names),
        ('active8_ensemble_artifacts_v1', 'artifact_id=?', [ensemble_row['artifact_id']]),
        ('active8_ensemble_pointer_v1', 'singleton_id=1', []),
        ('model_champion_history', 'retired_at IS NULL AND model_name IN (' +
         ','.join('?' for _ in selected_models) + ')', selected_models),
    ]
    snapshots = [(table, where, params, query(f'SELECT * FROM {table} WHERE {where}', params))
                 for table, where, params in reads]
    base_rows, pointers, ensembles, ensemble_pointers, histories = [item[3] for item in snapshots]
    live_base = {row['model_name']: row for row in base_rows}
    live_pointers = {row['model_name']: row for row in pointers}
    expected_pointers = {row['model_name']: row for row in supplied_pointers if row['model_name'] in by_model}
    if (len(live_base) != len(base_rows) or set(live_base) != set(by_model)
            or len(ensembles) != 1 or len(ensemble_pointers) > 1
            or len(expected_pointers) != len([p for p in supplied_pointers if p['model_name'] in by_model])):
        raise RuntimeError('active8_bundle_current_source_cardinality')
    live_ensemble = ensembles[0]
    if (any(live_ensemble.get(k) != ensemble_row.get(k) for k in ENSEMBLE_IDENTITY)
            or any(live_base[name].get(k) != by_model[name].get(k)
                   for name in model_names for k in BASE_IDENTITY)):
        raise RuntimeError('active8_bundle_current_artifact_changed')
    pointer = ensemble_pointers[0] if ensemble_pointers else None
    same_owner = pointer is not None and pointer['artifact_id'] == ensemble_row['artifact_id']
    if same_owner:
        # Recovery must prove the old commit, never re-authorize or repair a
        # partial/corrupt record by mutating history a second time.
        try:
            receipt = json.loads(pointer['promotion_evidence_json'])
        except (ValueError, TypeError) as exc:
            raise RuntimeError('active8_bundle_committed_receipt_invalid') from exc
        expected_receipt = {
            'schema_version': 'active8-ensemble-atomic-promotion-evidence-v1',
            'training_run_id': ensemble_row['training_run_id'],
            'ensemble_artifact_id': ensemble_row['artifact_id'],
            'ensemble_payload_checksum': ensemble_row['payload_checksum'],
            'base_artifact_set_checksum': ensemble_row['base_artifact_set_checksum'],
            'selected_models': selected_models,
            'validation': json.loads(ensemble_row['payload_json'])['validation'],
        }
        valid = (isinstance(receipt, dict) and all(receipt.get(k) == v for k, v in expected_receipt.items())
                 and live_ensemble['state'] == 'production' and live_ensemble['production_effect'] == 1
                 and all(pointer.get(k) == ensemble_row[k] for k in ('cohort_id', 'payload_checksum', 'base_artifact_set_checksum'))
                 and bool(pointer.get('promoted_at')) and len(histories) == len(selected_models))
        for name in selected_models:
            base, current = live_base[name], live_pointers.get(name, {})
            history = [row for row in histories if row['model_name'] == name]
            valid = valid and (base['state'] == 'production'
                and current.get('champion_artifact_id') == base['artifact_id']
                and current.get('champion_version') == base['version']
                and len(history) == 1 and history[0]['artifact_id'] == base['artifact_id']
                and history[0]['version'] == base['version'] and history[0]['evidence_grade'] == 'exact')
            try:
                valid = valid and json.loads(current.get('promotion_evidence_json', '{}')) == receipt
                valid = valid and json.loads(history[0]['evidence_json']) == receipt
            except (ValueError, TypeError, IndexError):
                valid = False
        if not valid:
            raise RuntimeError('active8_bundle_committed_receipt_invalid')
        # A concurrent writer after the initial reads must not produce a mixed
        # recovery receipt. No D1/KV writes are used for recovery.
        def ordered(rows):
            return sorted(json.dumps(row, sort_keys=True, allow_nan=False) for row in rows)
        if any(ordered(query(f'SELECT * FROM {table} WHERE {where}', params)) != ordered(rows)
               for table, where, params, rows in snapshots):
            raise RuntimeError('active8_bundle_recovery_source_changed')
        return {'guards': [], 'recovered_existing_commit': True, 'confirmed_at': pointer['promoted_at'],
                'promotion_evidence': receipt}
    if live_ensemble['state'] != 'candidate' or live_ensemble['production_effect'] != 0:
        raise RuntimeError('active8_bundle_current_candidate_not_adoptable')
    if any(live_base[name]['state'] != by_model[name]['state'] for name in model_names):
        raise RuntimeError('active8_bundle_current_base_lifecycle_changed')
    if set(expected_pointers) != set(live_pointers) or any(
            live_pointers[name].get(key) != expected_pointers[name].get(key)
            for name in live_pointers for key in ('champion_artifact_id', 'champion_version')):
        raise RuntimeError('active8_bundle_current_baseline_changed')
    guards = [guard for table, where, params, rows in snapshots
              for guard in _snapshot_guards(table, where, params, rows)]
    return {'guards': guards, 'recovered_existing_commit': False,
            'current_pointers': [dict(row) for row in pointers]}
