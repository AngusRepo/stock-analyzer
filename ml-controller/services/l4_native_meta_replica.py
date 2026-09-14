"""Research-only native L3 meta replay; never a serving artifact or gate bypass.

Use the existing chronological stacker's prior-label-only fits and its exact
isotonic/conformal arithmetic. A serving release's five-outer-fold gate is not a
prerequisite for generating nested OOF training features. Replicas cannot be
registered as L3 releases. No parent validation metrics enter the replica.
"""
from copy import deepcopy
import numpy as np
from services.active8_oof_stacker import build_chronological_oof_stack,STACKER_FEATURE_NAMES
from services.active8_ensemble_artifact import _fit_isotonic,finite_sample_quantile,payload_checksum


def replica_builder(predictions,parent):
    stacked,evidence=build_chronological_oof_stack(predictions)
    states={s['prediction_date']:s for f in evidence['folds'] for s in f['date_states']}
    def build(prior,*,knowledge_cutoff_date,**_):
        days=[d for d in states if d>knowledge_cutoff_date]
        if not days:raise ValueError('native_meta_prediction_state_insufficient')
        day=min(days);state=states[day]
        honest=[r for r in stacked if r['eligible_for_efficacy'] and r['label_known_date']<day]
        if (not state['eligible_for_efficacy'] or not state['selected_models']
                or len({r['prediction_date'] for r in honest})<5):
            raise ValueError('native_meta_purged_calibration_insufficient')
        predicted=np.asarray([r['ensemble_raw'] for r in honest]);target=np.asarray([r['target_return'] for r in honest])
        xs,ys=_fit_isotonic(predicted,target)
        payload={k:deepcopy(parent[k]) for k in ('signal_policy','cohort_id','base_artifact_set_checksum')}
        payload.update(schema_version='l4-native-meta-research-replica-v1',scope='nested_oof_features_only',
            serving_eligible=False,selected_models=state['selected_models'],knowledge_cutoff_date=knowledge_cutoff_date,
            fit={'intercept':state['intercept'],'coefficients':[state['weights'][n] for n in STACKER_FEATURE_NAMES],
                 'regularization':state['regularization']},
            calibration={'probability_x_thresholds':xs,'probability_y_thresholds':ys,
                'absolute_residual_quantiles':{str(c):finite_sample_quantile(np.abs(target-predicted),c) for c in (.9,.95)}},
            validation={'decision':'FAIL','failed_gates':['research_replica_has_no_serving_qualification']},
            training={'prediction_date':day,'label_known_max':max(r['label_known_date'] for r in prior),
                'meta_train_dates':state['train_dates'],'calibration_dates':len({r['prediction_date'] for r in honest})})
        payload['payload_checksum']=payload_checksum(payload)
        return payload
    return build,evidence
