"""OPB v3 cutover warm start (F-B): replay pre-cutover days under the new L3's context.

A cutover changes the L3 identity, so the OPB context (and its evidence) starts
empty. The new bundle's walk-forward purged OOF already scored the recent
pre-cutover days with fold models that never saw them, so those days can be
replayed under the new context without leaking the full-fit model's training:

* scores: the OOF raw score of each model for that day, only from the fold whose
  test range contains the day (walk-forward, purged);
* E-hat: the bundle's hinge refit on OOF days whose labels were known strictly
  before the day (past-only, purged), so calibration never sees the day either;
* pool: the same L2 final_selection run the original plan used (L0-L2 checked
  against the frozen rank pool, no re-screening);
* holdings, risk envelope, fees, return history: the frozen day's own (paired:
  every arm starts from the old model's holdings, so arm deltas stay paired).

The artifact keeps its model checksum (context identity) but declares the warm
scorer's label horizon, so the runtime's training-after-signal guard still
holds. Rows are `cutover_warm_start` with score_source `fold_oof`; selection
admits them only under KV `cutover_warm_start.enabled`, newest
`max_observations` days only. Research evidence only: never a live plan.
"""
from __future__ import annotations

from bisect import bisect_right
from copy import deepcopy
from datetime import date

import numpy as np

from services.r33_crossfit_serving import fit_hinge, hinge_value
from services.r33_ensemble import EVIDENCE_KEY, validate_ensemble
from services.r33_isotonic_calibration import checksum, pool_scores
from services.r33_rank_pool import (IDENTITY_FIELDS, POOL_SOURCE, SNAPSHOT_SCHEMA, _evidence, _matrix, _outside_z,
                                    validate_rank_pool)

WARM_SCHEMA = 'l4-opb-cutover-warm-start-v1'
EHAT_SOURCE = 'past_only_purged_hinge_v1'


def fold_scores(oof_rows, day, windows, models):
    """{symbol: {model: raw}} for `day`, each from the fold whose test range holds the day.

    oof_rows: dicts with prediction_date, symbol, model_name, raw_score, fold_id.
    windows: {fold_id: {'train_end', 'test_start', 'test_end'}}. A day scored by a
    fold that does not test it, or that trained on or after it, fails closed (see
    fold_trained_before for the label-horizon purge).
    """
    scores = {}
    for row in oof_rows:
        if row['prediction_date'] != day or row['model_name'] not in models:
            continue
        window = windows.get(row['fold_id'])
        if (window is None or not window['train_end'] < window['test_start'] <= day <= window['test_end']):
            raise ValueError('l4_opb_warm_start_fold_not_out_of_sample:' + str(row['fold_id']))
        value = float(row['raw_score'])
        if not np.isfinite(value):
            continue
        cell = scores.setdefault(str(row['symbol']), {})
        if row['model_name'] in cell and cell[row['model_name']] != value:
            raise ValueError('l4_opb_warm_start_duplicate_score')
        cell[row['model_name']] = value
    return scores


def fold_trained_before(windows, fold_ids, day, table):
    """Every fold used for `day` saw labels known strictly before it (train end + horizon)."""
    index, horizon = table['calendar_index'], table['horizon']
    calendar = sorted(index, key=index.get)
    for fold in fold_ids:
        end = windows[fold]['train_end']
        # A train end before the OOF calendar: its labels are known within `horizon`
        # sessions of the calendar start at the latest.
        if end < calendar[0]:
            known = horizon - 1
        else:
            # Last OOF session on or before the train end (it may be a holiday).
            known = index[calendar[bisect_right(calendar, end) - 1]] + horizon
        if not known < index[day]:
            raise ValueError('l4_opb_warm_start_fold_labels_not_before_day:' + str(fold))


def past_only_curve(table, day):
    """Hinge refit on OOF days whose labels were known strictly before `day`."""
    index, horizon = table['calendar_index'], table['horizon']
    if day not in index:
        raise ValueError('l4_opb_warm_start_day_outside_oof_calendar')
    train = sorted(d for d in table['day_rows'] if index[d] + horizon < index[day])
    curve, _ = fit_hinge(table, train)
    calendar = sorted(index, key=index.get)
    known = index[train[-1]] + horizon
    if known >= len(calendar):
        raise ValueError('l4_opb_warm_start_label_date_outside_calendar')
    return curve, {'estimator': EHAT_SOURCE, 'train_days': len(train), 'train_first': train[0],
                   'train_last': train[-1], 'label_known_date': calendar[known]}


def warm_rank_pool(*, day, scores, pool, holdings, ensemble, l3_identity, curve, ehat_receipt):
    """An attested rank pool for `day` from fold scores and the past-only hinge.

    Same construction as r33_rank_pool.build_rank_pool (pool z, insertion z for
    held names outside the pool, equal-weight score); only the raw scores and the
    E-hat curve differ, and the snapshot says so in `warm_start`.
    pool: (sorted members, receipt) from r33_rank_pool.load_serving_pool.
    """
    symbols, receipt = pool
    validate_ensemble(ensemble)
    if any(l3_identity.get(k) != ensemble.get(k) for k in IDENTITY_FIELDS):
        raise ValueError('l4_opb_warm_start_l3_identity_mismatch')
    if receipt.get('source') != POOL_SOURCE or receipt.get('signal_date') != day:
        raise ValueError('l4_opb_warm_start_pool_contract_mismatch')
    calibration = ensemble['serving_calibration']
    variant, models = calibration['variant'], tuple(ensemble['model_order'])
    in_pool, held = set(symbols), set(holdings)
    outside = sorted(held - in_pool)
    scored = [s for s in symbols if scores.get(s)]
    if not scored:
        raise ValueError('l4_opb_warm_start_no_scored_rows')
    pool_raw, pool_available = _matrix([scores[s] for s in scored], models)
    score, z, uninformative = pool_scores(pool_raw, pool_available, variant=variant, models=models)
    out_scored = [s for s in outside if scores.get(s)]
    out_raw, out_available = _matrix([scores[s] for s in out_scored], models)
    out_z = _outside_z(pool_raw, pool_available, out_raw, out_available, uninformative, models)
    out_score = out_z.sum(axis=1) / len(models)
    if variant == 'mean_z_restandardized' and len(out_scored):
        plain = z.sum(axis=1) / len(models)
        out_score = (out_score - plain.mean()) / plain.std()
    ehat = hinge_value(curve, np.r_[score, out_score])
    computed = {s: (z[i], pool_available[i], score[i], ehat[i]) for i, s in enumerate(scored)}
    computed.update({s: (out_z[i], out_available[i], out_score[i], ehat[len(scored) + i])
                     for i, s in enumerate(out_scored)})
    pool_checksum = checksum({'signal_date': day, 'screener_run_id': receipt['screener_run_id'],
                              'membership_sha256': receipt['membership_sha256']})
    calibration_checksum = calibration['payload_checksum']
    rows, evidence = [], {}
    for symbol in sorted(in_pool | set(outside)):
        if symbol in computed:
            zs, avail, value, expected = computed[symbol]
            row = dict(z={m: float(zs[i]) for i, m in enumerate(models)},
                       available={m: bool(avail[i]) for i, m in enumerate(models)},
                       score=float(value), expected_excess=float(expected), unscored_reason=None)
        else:
            row = dict(z={m: 0.0 for m in models}, available={m: False for m in models},
                       score=None, expected_excess=None, unscored_reason='fold_oof_missing')
        row.update(symbol=symbol, role='pool' if symbol in in_pool else 'holding_outside_pool', held=symbol in held)
        rows.append(row)
        evidence[symbol] = _evidence(row, signal_date=day, pool_checksum=pool_checksum,
                                     calibration_checksum=calibration_checksum)
    snapshot = dict(
        schema_version=SNAPSHOT_SCHEMA, signal_date=day, screener_run_id=receipt['screener_run_id'],
        pool_source=POOL_SOURCE, pool_membership_sha256=receipt['membership_sha256'], pool_checksum=pool_checksum,
        l3_identity=dict(l3_identity), model_order=list(models), variant=variant,
        calibration_checksum=calibration_checksum,
        source_calibration_checksum=ensemble['source_bundle']['source_calibration_checksum'],
        rows=rows, uninformative_models=list(uninformative),
        coverage=dict(pool_rows=len(symbols), pool_scored_rows=len(scored), holdings_outside_pool=len(outside),
                      by_model={m: int(pool_available[:, i].sum()) for i, m in enumerate(models)},
                      unscored={r['symbol']: r['unscored_reason'] for r in rows if r['unscored_reason']}),
        warm_start=dict(schema_version=WARM_SCHEMA, score_source='fold_oof', ehat=dict(ehat_receipt, curve=curve)),
        predictions_checksum=checksum(evidence))
    snapshot['checksum'] = checksum(snapshot)
    return validate_rank_pool(snapshot), evidence


def warm_artifact(bundle, *, day, label_known_max):
    """The new bundle declaring the warm scorer's label horizon (model checksum unchanged)."""
    if not date.fromisoformat(label_known_max) < date.fromisoformat(day):
        raise ValueError('l4_opb_warm_start_labels_not_before_day')
    return {**deepcopy(bundle), 'training_label_known_max': label_known_max}


def frozen_override(*, day, scores, pool, ensemble, l3_identity, curve, ehat_receipt):
    """runtime/recommendations of the frozen day -> the same day under the new L3.

    The rank pool is built against the frozen day's own holdings, and the frozen
    plan's rank pool must come from the same L2 run (no re-screening)."""
    def apply(runtime, recommendations):
        holdings = [h['symbol'] for h in runtime['account']['holdings']]
        snapshot, evidence = warm_rank_pool(day=day, scores=scores, pool=pool, holdings=holdings, ensemble=ensemble,
                                            l3_identity=l3_identity, curve=curve, ehat_receipt=ehat_receipt)
        frozen_pool = runtime.get('r33_rank_pool') or {}
        if (runtime['signal_date'] != day or frozen_pool.get('screener_run_id') != snapshot['screener_run_id']
                or frozen_pool.get('pool_membership_sha256') != snapshot['pool_membership_sha256']):
            raise ValueError('l4_opb_warm_start_l2_pool_mismatch')
        predictions = {}
        for symbol, prediction in (runtime.get('predictions') or {}).items():
            body = {k: v for k, v in (prediction or {}).items() if k != EVIDENCE_KEY}
            if symbol in evidence:
                body[EVIDENCE_KEY] = deepcopy(evidence[symbol])
            predictions[symbol] = body
        for symbol in set(evidence) - set(predictions):
            predictions[symbol] = {EVIDENCE_KEY: deepcopy(evidence[symbol])}
        validate_rank_pool(snapshot, predictions)
        return {**runtime, 'l3_identity': dict(l3_identity), 'r33_rank_pool': snapshot,
                'predictions': predictions}, recommendations
    return apply


def replay_warm_day(*, live, day, cutover_business_date, oof_rows, windows, table, pool, ensemble, clients, run=None):
    """One pre-cutover day under the new context (row_kind cutover_warm_start)."""
    from services.l4_opb_arm_replay import replay_day_v3
    from services.l4_opb_selection import HORIZON_SESSIONS, ROW_CUTOVER_WARM_START, market_proxy
    sessions = [str(r['date'])[:10] for r in clients['market'].query(
        "SELECT date FROM canonical_market_daily WHERE stock_id=? AND source='finlab.price' "
        "AND date>? ORDER BY date LIMIT ?", [market_proxy(live), day, HORIZON_SESSIONS])]
    if len(sessions) < HORIZON_SESSIONS or sessions[-1] >= cutover_business_date:
        # After cutover the nightly job never continues an old-L3 day, so only
        # holds that closed before the cutover are booked (complete, five pieces).
        return {'status': 'skipped', 'reason': 'hold_not_closed_before_cutover'}
    identity = live['artifact']['l3_identity']
    models = tuple(ensemble['model_order'])
    fold_scores(oof_rows, day, windows, models)
    fold_trained_before(windows, sorted({r['fold_id'] for r in oof_rows if r['prediction_date'] == day
                                         and r['model_name'] in models}), day, table)
    curve, receipt = past_only_curve(table, day)
    override = frozen_override(day=day, scores=fold_scores(oof_rows, day, windows, models),
                               pool=pool, ensemble=ensemble, l3_identity=identity, curve=curve, ehat_receipt=receipt)
    return replay_day_v3(live=live, signal_date=day, business_date=cutover_business_date, paper=clients['paper'],
                         learning=clients['learning'], market=clients['market'], run=run,
                         row_kind=ROW_CUTOVER_WARM_START, frozen_override=override, score_source='fold_oof',
                         artifact=warm_artifact(live['artifact'], day=day, label_known_max=receipt['label_known_date']))
