"""Collect existing native inputs. Never reconstruct, train, or grant action authority."""
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from services.allocator_ev_feature_snapshot_backfill import (
    _existing_l4_payload, _parse_candidate_row, load_allocator_ev_snapshot_candidate_rows,
)
from services.active8_score_semantics import MODEL_TARGET_SEMANTIC_VERSION
from services.ev_lineage_contract import ev_feature_lineage_blockers, prediction_timing_blockers
from services.ipo_shadow import freeze_daily


def collect_native_daily(*, signal_date: str, source_run_id: str, clients: dict[str, Any],
                         dry_run: bool = False) -> dict[str, Any]:
    learning = clients['learning']
    now = datetime.now(timezone.utc)
    taipei = now + timedelta(hours=8)
    prospective_dates = {taipei.date().isoformat()}
    if taipei.hour < 9:
        prospective_dates.add((taipei.date() - timedelta(days=1)).isoformat())
    base = {'signal_date': signal_date, 'observed_at': now.isoformat(), 'production_effect': False,
            'promotion_allowed': False, 'training_dispatched': False, 'rows': 0}
    if not dry_run and signal_date not in prospective_dates:
        return {**base, 'status': 'historical_not_prospective', 'blockers': []}
    raw = load_allocator_ev_snapshot_candidate_rows(learning.query, snapshot_date=signal_date, limit=5000,
        learning_query_fn=learning.query, ops_query_fn=clients['ops'].query,
        core_query_fn=clients['core'].query, market_query_fn=clients['market'].query)
    if any(int(r.get('candidate_total_count') or 0) > len(raw) for r in raw):
        raise RuntimeError('ipo_shadow_candidate_set_truncated')
    # The canonical reference is pre-ML; use the already-recorded post-ML score
    # payload, not its seed mlEdge=0. No recomputation or imputation is allowed.
    native = clients['core'].query('SELECT symbol,score_components FROM daily_recommendations WHERE date=?', [signal_date])
    components = {str(r['symbol']): r.get('score_components') for r in native}
    rows, rejected = [], Counter()
    for item in raw:
        item = {**item, 'score_components': components.get(str(item['symbol']))}
        row, prediction = _parse_candidate_row(item)
        blockers = []
        if row.get('reference_feature_rejection_reason'):
            blockers.append(str(row['reference_feature_rejection_reason']))
        blockers += ev_feature_lineage_blockers(row) + prediction_timing_blockers(row)
        ensemble = prediction.get('ensemble_v2') or {}
        target = ensemble.get('target_semantic_version') or (prediction.get('model_score_lineage') or {}).get('target_semantic_version')
        if target != MODEL_TARGET_SEMANTIC_VERSION:
            blockers.append('target_semantic_version_missing_or_incompatible')
        if ensemble.get('generation_mode', 'native') != 'native':
            blockers.append('non_native_ensemble')
        if blockers:
            rejected.update(set(blockers))
            continue
        rows.append({'row': row, 'prediction': prediction, 'generation_mode': 'native',
            'model_set_signature': ensemble['model_set_signature'], 'target_semantic_version': target,
            'l4_payload': _existing_l4_payload(row.get('existing_alpha_allocation') or {}, snapshot_date=signal_date)})
    coverage = {'candidate_rows': len(raw), 'eligible_rows': len(rows), 'rejection_counts': dict(rejected)}
    if rejected:
        # Never publish a selection-biased subset as a complete comparison.
        return {**base, **coverage, 'status': 'awaiting_native_inputs', 'blockers': sorted(rejected)}
    if not rows:
        return {**base, **coverage, 'status': 'no_native_candidates', 'blockers': ['no_native_candidates']}
    if dry_run:
        return {**base, **coverage, 'status': 'ready_to_freeze', 'blockers': []}
    result = freeze_daily(snapshot_date=signal_date, source_run_id=source_run_id, rows=rows,
                          query=learning.query, writer=learning.batch_execute)
    return {**base, **coverage, **result, 'blockers': []}
