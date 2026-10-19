"""Frozen prospective observation -> P6-a and incumbent forecasts; no fitting."""
from datetime import datetime,time,date,timezone
from zoneinfo import ZoneInfo
import hashlib,json
import numpy as np
from services.l4_r17_forecast_core import digest,forecast_packet
from services.l4_native_observation import read_reference


def build(*,snapshot,original,server_created_at,server_generation,entry_date,
          bundle,upstream,head,calibration,baseline,load_weights,baseline_predict=None):
    """Inputs are already fetched by checksum, including server-created metadata."""
    from services.l4_distribution import predict
    reference=snapshot['original_reference']
    projection={k:v for k,v in snapshot.items() if k not in
        ('snapshot_id','original_reference','original_sha256','verified_original_sha256','frozen_at')}
    if (original.get('projection')!=projection
            or original.get('scope')!='l4-native-pool-observation-v1'
            or digest(original)!=reference['sha256']
            or snapshot.get('verified_original_sha256')!=reference['sha256']
            or not server_generation):
        raise ValueError('r17_original_observation_proof')
    if (snapshot['l3_identity']!=baseline['l3_identity']
            or snapshot['l3_identity']['payload_checksum']!=upstream['stacker_payload_checksum']
            or snapshot['l3_identity']['base_artifact_set_checksum']!=upstream['base_artifact_set_checksum']
            or digest(baseline['model'])!=baseline['model_checksum']):
        raise ValueError('r17_upstream_or_incumbent_changed')
    rows=[{**r,'date':snapshot['signal_date'],'upstream_checksum':digest(upstream)}
          for r in snapshot['feature_rows']]
    if digest(snapshot['feature_rows'])!=snapshot['features_checksum']:
        raise ValueError('r17_observation_features_changed')
    observation={'schema':'r16-frozen-native-observation-v1','signal_date':snapshot['signal_date'],
        'rows':rows,'pool_symbols':snapshot['eligible_symbols'],'l3_identity':snapshot['l3_identity'],
        'server_created_at':server_created_at,'server_generation':server_generation,
        'original_reference':reference,'base_weight_sha256':{r['model']:r['sha256'] for r in upstream['artifacts']},
        'stacker_sha256':upstream['stacker_sha256']}
    observation['checksum']=digest(observation)
    entry=datetime.combine(date.fromisoformat(entry_date),time(9),ZoneInfo('Asia/Taipei')).isoformat()
    packet=forecast_packet(rows,bundle=bundle,head=head,calibration=calibration,load_weights=load_weights,
        signal_date=snapshot['signal_date'],captured_at=server_created_at,entry_at=entry,
        upstream_checksum=digest(upstream),pool_symbols=snapshot['eligible_symbols'])
    values=(baseline_predict or predict)(rows,baseline['model'])
    old=np.asarray([v['expected_return_gross'] for v in values],float)
    if len(old)!=len(rows) or not np.isfinite(old).all():raise ValueError('r17_incumbent_forecast_incomplete')
    packet.pop('checksum')
    packet.update(incumbent={'model_checksum':baseline['model_checksum'],'gross':old.tolist(),
                             'relative':(old-old.mean()).tolist()},
                  observation_checksum=observation['checksum'],original_reference=reference,
                  server_generation=server_generation)
    packet['checksum']=digest(packet)
    return {'forecast':packet,'observation':observation}


async def on_signal_observation(*,bucket,config,day,entry_date):
    """Continue the existing pinned full-pool inference job, never retrain heads."""
    from services.l4_native_observation import collect
    observed=await collect(bucket=bucket,config=config['native_observer'],day=day)
    if observed['status']!='captured':return observed
    snapshot=read_reference(bucket,observed['projection'])
    original=read_reference(bucket,snapshot['original_reference'])
    blob=bucket.blob(snapshot['original_reference']['path']);blob.reload()
    if blob.time_created is None:raise ValueError('r17_original_server_clock_missing')
    assets={name:read_reference(bucket,config[name]) for name in
            ('bundle','upstream','head','calibration','baseline')}
    if config['native_observer']['l3_identity']!=assets['baseline']['l3_identity']:
        raise ValueError('r17_observer_configuration_changed')
    def weights(ref):
        raw=bucket.blob(ref['path']).download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=ref['sha256']:raise ValueError('r17_weight_checksum')
        return raw
    result=build(snapshot=snapshot,original=original,server_created_at=blob.time_created.isoformat(),
        server_generation=str(blob.generation),entry_date=entry_date,load_weights=weights,**assets)
    predictions=original.get('model_predictions')
    if predictions is None:raise ValueError('r17_original_predictions_not_archived')
    return {'status':'forecast_ready',**result,'risk_reference':original['risk_reference'],
            'model_predictions':predictions}
