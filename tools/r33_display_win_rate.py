"""Display-only R33 win rate: P(5-session pool-centered excess > 0 | R33 score).

Fitted on the sealed R33 OOF of the production cohort, every day weighing equally, over the
segments the serving calibration itself draws (r33_crossfit_serving):
  - hinge serving curve (default): two segments, below / at-or-above the curve's knot. The
    data support "top tail vs the rest" and nothing finer (L3-EV-STEP, 2026-11-24);
  - legacy step table: one segment per serving EV block.
The result is a static JSON the Worker reads to show "校準勝率" on recommendation cards. It
never enters a decision path (L3, L4, OPB, risk, orders) and no writer reads it.

  python tools/r33_display_win_rate.py --artifact-payload <pointer artifact payload_json file> \
      --out worker/src/lib/r33DisplayWinRate.json

Honest checks: a chronological split (first 70% of days fit, last 30% evaluated, label overlap
purged), purged leave-one-day-out and purged 10-fold over contiguous days. In every check the
base-rate reference is refit on the training days only, and so is the hinge knot; a legacy step
table keeps its sealed block edges (drawn from the full OOF), as the serving table itself does.
With a rank IC near 0.09, the Brier skill of any binary win rate is small by construction
(about 0.005 at best under a Gaussian approximation); the checks show the sign is positive
out of sample, not that the number is large.

Read-only: GCS (sealed bundle, OOF, price capture) and OPS D1 (the bundle's L2 pool) through
`wrangler d1 execute --remote` from WRANGLER_DIR. Fails unless the rebuilt serving table is
byte-equal to the one sealed in the artifact, so the win rate is fit on exactly the OOF rows
behind today's EV. Writes only --out.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import numpy as np

REPO = Path(__file__).resolve().parents[1]
if str(REPO / 'ml-controller') not in sys.path:
    sys.path.insert(0, str(REPO / 'ml-controller'))
SCHEMA = 'r33-display-win-rate-v1'
METHOD_STEP = 'serving-ev-segments-each-day-equal-v1'
METHOD_HINGE = 'serving-hinge-knot-two-segments-each-day-equal-v1'
HOLDOUT_SHARE = 0.3
KFOLDS = 10


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _plain(value, digits=12):
    """Rounded numbers with integral floats as ints, so Python and JS canonical JSON agree."""
    if isinstance(value, dict):
        return {k: _bound(v) if k in _BOUNDS else _plain(v, digits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v, digits) for v in value]
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        value = round(float(value), digits)
        if not math.isfinite(value):
            raise ValueError('r33_display_win_rate_not_finite')
        if value == 0 or abs(value) < 1e-4:
            return 0
        return int(value) if value.is_integer() else value
    return value


_BOUNDS = ('score_lo', 'score_hi')


def _bound(value):
    """Segment score bounds stay exact: rounding or flushing them could make two segments touch."""
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('r33_display_win_rate_not_finite')
    return int(value) if value.is_integer() else value


def check_segments(segments) -> None:
    """The Worker's validateDisplayWinRateTable rules, so a table it would refuse is never written."""
    previous = None
    for s in segments:
        if not (s['score_lo'] <= s['score_hi'] and 0 <= s['win_rate'] <= 1):
            raise ValueError('r33_display_win_rate_segment_invalid')
        if previous is not None and not s['score_lo'] > previous['score_hi']:
            raise ValueError('r33_display_win_rate_segments_overlap')
        previous = s


def table_sha256(body: dict) -> str:
    return hashlib.sha256(canonical({k: v for k, v in body.items() if k != 'table_sha256'}).encode('utf-8')).hexdigest()


def _segment(edges, scores):
    return np.clip(np.searchsorted(np.asarray(edges, dtype=float), np.asarray(scores, dtype=float), side='right') - 1,
                   0, len(edges) - 1)


def _is_hinge(serving: dict) -> bool:
    from services.r33_crossfit_serving import HINGE_SCHEMA
    return serving.get('schema_version') == HINGE_SCHEMA


def segment_edges(serving: dict, table: dict, days) -> list[float]:
    """Lower edges of the display segments for a fit on `days` (first edge is a sentinel)."""
    if _is_hinge(serving):
        from services.r33_crossfit_serving import fit_hinge
        curve, _ = fit_hinge(table, days) if days is not None else (serving['curve'], None)
        return [-math.inf, float(curve['knot'])]
    return [-math.inf] + [float(b['score_lo']) for b in serving['blocks'][1:]]


def fit_segments(edges, score, win, weight, bounds=None):
    """Each-day-equal share of wins per segment. `bounds` are the displayed (score_lo, score_hi)
    of each segment (the serving blocks' own edges); without them, the score range it holds."""
    seg = _segment(edges, score)
    out = []
    for k in range(len(edges)):
        m = seg == k
        if not m.any() or not weight[m].sum() > 0:
            raise ValueError(f'r33_display_win_rate_empty_segment:{k}')
        lo, hi = bounds[k] if bounds is not None else (
            float(score[m].min()) if k == 0 else float(edges[k]), float(score[m].max()))
        out.append(dict(score_lo=lo, score_hi=hi, win_rate=float(np.average(win[m], weights=weight[m])), n=int(m.sum()),
                        days_weight=float(weight[m].sum())))
    return out


def _bounds(serving):
    return None if _is_hinge(serving) else [(b['score_lo'], b['score_hi']) for b in serving['blocks']]


def predict(segments, scores):
    edges = [-math.inf] + [s['score_lo'] for s in segments[1:]]
    return np.array([s['win_rate'] for s in segments])[_segment(edges, scores)]


def _brier(p, y, w, base):
    base = np.broadcast_to(np.asarray(base, dtype=float), np.shape(y))
    brier, ref = float(np.average((p - y) ** 2, weights=w)), float(np.average((base - y) ** 2, weights=w))
    return dict(brier=brier, brier_base_rate=ref, brier_skill=1 - brier / ref)


def _reliability(segments, score, y, w):
    seg = _segment([-math.inf] + [s['score_lo'] for s in segments[1:]], score)
    return [dict(segment=k, predicted=s['win_rate'], realized=float(np.average(y[seg == k], weights=w[seg == k])),
                 n=int((seg == k).sum()), days_weight=float(w[seg == k].sum()))
            for k, s in enumerate(segments) if (seg == k).any()]


def validate_fit(table: dict, serving: dict) -> dict:
    """Full-OOF segments plus three honest checks; edges and reference refit on training days."""
    days = sorted(table['day_rows'])
    index, horizon = table['calendar_index'], int(table['horizon'])
    score, weight = table['score'], table['weight']
    win = (table['excess'] > 0).astype(float)

    def rows(ds):
        return np.concatenate([table['day_rows'][d] for d in ds])

    def fit(train):
        r = rows(train)
        return fit_segments(segment_edges(serving, table, train), score[r], win[r], weight[r]), \
            float(np.average(win[r], weights=weight[r]))

    def crossfit(folds):
        p, ref = np.full(len(score), np.nan), np.full(len(score), np.nan)
        for train, held in folds:
            segments, base = fit(train)
            r = rows(held)
            p[r], ref[r] = predict(segments, score[r]), base
        r = rows(sorted({d for _, held in folds for d in held}))
        return _brier(p[r], win[r], weight[r], ref[r])

    every = rows(days)
    segments = fit_segments(segment_edges(serving, table, None), score[every], win[every], weight[every],
                            bounds=_bounds(serving))
    cut = int(round(len(days) * (1 - HOLDOUT_SHARE)))
    train = days[:cut]
    test = [d for d in days[cut:] if index[d] - index[train[-1]] >= horizon]
    tr, te = rows(train), rows(test)
    fit_tr, base_tr = fit(train)
    holdout = dict(train=dict(start=train[0], end=train[-1], days=len(train)),
                   test=dict(start=test[0], end=test[-1], days=len(test), rows=int(len(te))),
                   purge_sessions=horizon, train_base_rate=base_tr,
                   **_brier(predict(fit_tr, score[te]), win[te], weight[te], base_tr),
                   reliability=_reliability(fit_tr, score[te], win[te], weight[te]))
    lodo = [([d for d in days if abs(index[d] - index[day]) >= horizon], [day]) for day in days]
    kfold = []
    for block in np.array_split(np.arange(len(days)), KFOLDS):
        held = [days[i] for i in block]
        lo, hi = index[held[0]], index[held[-1]]
        kfold.append(([d for d in days if index[d] <= lo - horizon or index[d] >= hi + horizon], held))
    base = float(np.average(win[every], weights=weight[every]))
    return dict(segments=segments, base_rate=base, oof=dict(start=days[0], end=days[-1], days=len(days), rows=int(len(every))),
                holdout=holdout, purged_leave_one_day_out=crossfit(lodo), purged_kfold=dict(folds=KFOLDS, **crossfit(kfold)),
                in_sample_full_oof=_brier(predict(segments, score[every]), win[every], weight[every], base))


def build_table(*, artifact_payload: dict, serving: dict, table: dict, built_from_source_sha: str) -> dict:
    sealed = artifact_payload['serving_calibration']
    if serving['payload_checksum'] != sealed['payload_checksum']:
        raise ValueError('r33_display_win_rate_serving_not_reproduced')
    fit = validate_fit(table, sealed)
    inputs = sealed['inputs']
    body = _plain(dict(
        schema_version=SCHEMA, purpose='display_only', decision_effect='none',
        target='P(daily_pool_centered_excess_return > 0)', horizon_sessions=int(sealed['horizon_sessions']),
        method=METHOD_HINGE if _is_hinge(sealed) else METHOD_STEP, weighting='each_day_equal',
        score_variant=sealed['variant'], model_order=list(artifact_payload['model_order']),
        identity=dict(cohort_id=artifact_payload['cohort_id'], ensemble_artifact_id=artifact_payload['artifact_id'],
                      ensemble_payload_checksum=artifact_payload['payload_checksum'],
                      base_artifact_set_checksum=artifact_payload['base_artifact_set_checksum'],
                      serving_calibration_checksum=sealed['payload_checksum'],
                      source_calibration_checksum=inputs['source_calibration_checksum'],
                      oof_manifest_checksum=inputs['manifest_checksum'],
                      pool_membership_sha256=inputs['pool']['membership_sha256']),
        built_from_source_sha=built_from_source_sha,
        segments=fit['segments'], base_rate=fit['base_rate'], oof=fit['oof'],
        validation=dict(holdout=fit['holdout'], purged_leave_one_day_out=fit['purged_leave_one_day_out'],
                        purged_kfold=fit['purged_kfold'], in_sample_full_oof=fit['in_sample_full_oof'])))
    check_segments(body['segments'])
    body['table_sha256'] = table_sha256(body)
    return body


def _ops_query_via_wrangler(wrangler_dir: str):
    def d1(sql):
        for _ in range(3):
            p = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'OPS_DB', '--remote', '--json', '--command', sql],
                               cwd=wrangler_dir, capture_output=True, text=True, timeout=300)
            if p.returncode == 0:
                return json.loads(p.stdout)[0]['results']
            time.sleep(3)
        raise RuntimeError('ops_d1_read_failed')

    def query(sql, params):
        # load_l2_pool's rows through SEARCH-only paths: runs by date, then items by (run_id, stage).
        if "stage='final_selection'" not in sql or len(params) != 2:
            raise ValueError('unexpected_ops_query')
        start, end = params
        runs = d1(f"SELECT run_id, created_at FROM screener_funnel_runs "
                  f"WHERE date BETWEEN date('{start}','-7 days') AND date('{end}','+7 days')")
        created = {r['run_id']: r['created_at'] for r in runs}
        ids, out = sorted(created), []
        for i in range(0, len(ids), 40):
            marks = ','.join("'" + x.replace("'", "''") + "'" for x in ids[i:i + 40])
            for r in d1(f"SELECT date, run_id, symbol, decision FROM screener_funnel_items WHERE run_id IN ({marks}) "
                        f"AND stage='final_selection' AND date BETWEEN '{start}' AND '{end}'"):
                out.append(dict(r, created_at=created[r['run_id']]))
        out.sort(key=lambda r: (r['date'], str(r['created_at']), r['symbol']))
        return out
    return query


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--artifact-payload', required=True, help='payload_json of the pointer artifact (local file)')
    parser.add_argument('--out', required=True)
    parser.add_argument('--bucket', default=os.environ.get('R33_MODELS_BUCKET', 'stockvision-models'))
    parser.add_argument('--wrangler-dir', default=os.environ.get('WRANGLER_DIR', str(REPO / 'worker')))
    parser.add_argument('--timeout', type=int, default=2400)
    args = parser.parse_args(argv)
    signal.alarm(args.timeout)
    os.environ.setdefault('STOCKVISION_SOURCE_SHA', subprocess.run(['git', '-C', str(REPO), 'rev-parse', 'HEAD'],
                                                                   capture_output=True, text=True, check=True).stdout.strip())
    from google.cloud import storage
    from services.r33_calibration_job import pool_score_table
    from services.r33_crossfit_serving import build_serving_table, estimator_of, load_bundle_inputs

    payload = json.loads(Path(args.artifact_payload).read_text(encoding='utf-8'))
    bucket = storage.Client().bucket(args.bucket)
    raw = bucket.blob(payload['source_bundle']['path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != payload['source_bundle']['sha256']:
        raise ValueError('r33_display_win_rate_bundle_checksum_mismatch')
    source, oof, pool = load_bundle_inputs(json.loads(raw), bucket=bucket, ops_query=_ops_query_via_wrangler(args.wrangler_dir))
    serving = build_serving_table(source=source, oof=oof, pool_by_date=pool,
                                  estimator=estimator_of(payload['serving_calibration']))
    body = build_table(artifact_payload=payload, serving=serving, table=pool_score_table(oof, pool, variant=source['variant']),
                       built_from_source_sha=os.environ['STOCKVISION_SOURCE_SHA'])
    Path(args.out).write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps({'out': args.out, 'table_sha256': body['table_sha256'],
                      'segments': [(s['score_lo'], s['win_rate'], s['n']) for s in body['segments']]}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
