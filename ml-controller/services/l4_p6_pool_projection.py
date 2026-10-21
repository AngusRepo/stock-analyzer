"""Preserve P6 full-pool centering when projecting onto the routed slate.

The serving caller must first authenticate the frozen model and snapshot. This
function binds their content and never recomputes ranks or fits calibration.
"""
from datetime import date
import math
from services.l4_distribution import digest
from services.l4_forward_refresh import NATIVE_POOL
from services.l4_p6_inference import predict


def project(snapshot, *, identity, signal_date, model_checksum, seeds, head,
            calibration, calibration_kind, symbols, load_bytes):
    rows=snapshot.get('feature_rows') or []
    full=[r['symbol'] for r in rows]
    if (snapshot.get('signal_date')!=signal_date or snapshot.get('l3_identity')!=identity
            or snapshot.get('pool_contract')!=NATIVE_POOL
            or snapshot.get('features_checksum')!=digest(rows)
            or not rows or len(set(full))!=len(full)
            or full!=snapshot.get('eligible_symbols')
            or snapshot.get('coverage_exclusions')!=[]):
        raise ValueError('p6_full_pool_contract')
    if (date.fromisoformat(snapshot['l3_training_label_known_max'])>=date.fromisoformat(signal_date)
            or len(set(symbols))!=len(symbols) or set(symbols)-set(full)):
        raise ValueError('p6_projection_date_or_symbols')
    if (calibration.get('checksum')!=digest({k:v for k,v in calibration.items() if k!='checksum'})
            or calibration.get('schema_version')!='p6-frozen-oof-calibration-v1'
            or calibration.get('scope')!='full_classified_candidate_pool'
            or calibration.get('outer_updates_allowed') is not False
            or calibration.get('outer_data_used') is not False
            or calibration.get('refit_predictions_used') is not False
            or date.fromisoformat(calibration['label_known_at_max'])>=date.fromisoformat(signal_date)):
        raise ValueError('p6_projection_calibration_contract')
    if calibration_kind not in ('raw','linear'):raise ValueError('p6_projection_calibration_not_registered')
    if len(model_checksum)!=64 or any(c not in '0123456789abcdef' for c in model_checksum):
        raise ValueError('p6_projection_model_checksum')
    slope=1. if calibration_kind=='raw' else calibration['linear_b']
    if type(slope) not in (int,float) or not math.isfinite(slope):raise ValueError('p6_projection_slope_invalid')
    dated=[{**r,'date':signal_date} for r in rows]
    forecast=predict(dated,seeds=seeds,head=head,load_bytes=load_bytes)
    full_values=[]
    for i,row in enumerate(rows):
        full_values.append(dict(symbol=row['symbol'],raw_score=float(forecast['score'][i]),
            relative_score=float(forecast['relative_score'][i]),z=float(forecast['z'][i]),
            p_loss=float(forecast['p_loss'][i]),expected_return=slope*float(forecast['relative_score'][i]),
            native_features_checksum=digest(row['features'])))
    if (any(not all(math.isfinite(r[k]) for k in ('raw_score','relative_score','z','p_loss','expected_return')) for r in full_values)
            or any(not 0<=r['p_loss']<=1 for r in full_values)):
        raise ValueError('p6_projection_nonfinite')
    source=dict(schema_version='p6-full-pool-projection-v1',signal_date=signal_date,l3_identity=identity,
        model_checksum=model_checksum,source_features_checksum=snapshot['features_checksum'],
        source_pool_checksum=digest(sorted(full)),source_pool_size=len(full),
        calibration_checksum=calibration['checksum'],calibration_kind=calibration_kind,
        forecast_checksum=digest(full_values),seed_input_matrix_checksums=forecast['seed_input_matrix_checksums'],
        expected_return_semantic='five_session_relative_pool_decimal',gain_loss_A_used=False)
    by={r['symbol']:r for r in full_values};features={r['symbol']:r for r in rows}
    outputs={s:{**by[s],
        # Existing allocator consumes this compatibility field; semantic is explicit.
        'expected_return_gross':by[s]['expected_return'],'output_is_net_of_costs':False,
        'expected_return_semantic':source['expected_return_semantic'],'horizon_sessions':5,
        'mean_policy':'p6_full_native_pool_direct_excess_'+calibration_kind,
        'model_checksum':model_checksum,'source_pool_checksum':source['source_pool_checksum'],
        'source_forecast_checksum':source['forecast_checksum']} for s in symbols}
    return [features[s] for s in symbols],outputs,{**source,'checksum':digest(source)}
