"""Research-only native L3 meta replay; never a serving artifact or gate bypass.

Use the existing chronological stacker's prior-label-only fits and its exact
isotonic/conformal arithmetic. A serving release's five-outer-fold gate is not a
prerequisite for generating nested OOF training features. Replicas cannot be
registered as L3 releases. No parent validation metrics enter the replica.
"""
from copy import deepcopy
from services.alpha_model_roster import model_order, stacker_features
import numpy as np
from services.active8_oof_stacker import build_chronological_oof_stack
from services.active8_ensemble_artifact import _fit_isotonic,finite_sample_quantile,payload_checksum


def replica_builder(predictions,parent,*,excluded_label_fold=None,stacker_recipe=None,qualification_context=None):
    order = model_order(row["model_name"] for row in predictions)
    if parent.get("observation_artifacts") and model_order(parent["observation_artifacts"], complete=True) != order:
        raise ValueError("native_meta_parent_roster_mismatch")
    names = stacker_features(order)
    from services.active8_stacker_recipe import validate_parent_recipe, prepare_qualification_context
    stacker_recipe = validate_parent_recipe(parent,stacker_recipe,order)
    if stacker_recipe is not None:
        qualification_context = prepare_qualification_context(qualification_context,order,
            required=stacker_recipe['mode']=='mean_loss_causal_prior',excluded_label_fold=excluded_label_fold,
            source_manifest_checksum=parent.get('source_manifest_checksum'))
    elif qualification_context is not None:
        raise ValueError('active8_qualification_without_recipe')
    stacked,evidence=build_chronological_oof_stack(predictions, **(
        {'excluded_label_fold':excluded_label_fold} if excluded_label_fold is not None else {}),
        **({'stacker_recipe':stacker_recipe,'qualification_context':qualification_context}
           if stacker_recipe is not None else {}))
    states={s['prediction_date']:s for f in evidence['folds'] for s in f['date_states']}
    def build(prior,*,knowledge_cutoff_date,**_):
        if excluded_label_fold is not None and any(excluded_label_fold.excludes(
                r['prediction_date'],r['label_known_date']) for r in prior):
            raise ValueError('native_meta_forbidden_label_ancestor')
        days=[d for d in states if d>knowledge_cutoff_date]
        if not days:raise ValueError('native_meta_prediction_state_insufficient')
        day=min(days);state=states[day]
        honest=[r for r in stacked if r['eligible_for_efficacy'] and r['label_known_date']<day
            and (excluded_label_fold is None or not excluded_label_fold.excludes(
                r['prediction_date'],r['label_known_date']))]
        if (not state['eligible_for_efficacy'] or not state['selected_models']
                or len({r['prediction_date'] for r in honest})<5):
            raise ValueError('native_meta_purged_calibration_insufficient')
        predicted=np.asarray([r['ensemble_raw'] for r in honest]);target=np.asarray([r['target_return'] for r in honest])
        xs,ys=_fit_isotonic(predicted,target)
        payload={k:deepcopy(parent[k]) for k in ('signal_policy','cohort_id','base_artifact_set_checksum')}
        payload.update(model_order=list(order),schema_version='l4-native-meta-research-replica-v1',scope='nested_oof_features_only',
            serving_eligible=False,selected_models=state['selected_models'],knowledge_cutoff_date=knowledge_cutoff_date,
            fit={'intercept':state['intercept'],'coefficients':[state['weights'][n] for n in names],
                 'regularization':state['regularization']},
            calibration={'probability_x_thresholds':xs,'probability_y_thresholds':ys,
                'absolute_residual_quantiles':{str(c):finite_sample_quantile(np.abs(target-predicted),c) for c in (.9,.95)}},
            validation={'decision':'FAIL','failed_gates':['research_replica_has_no_serving_qualification']},
            training={'prediction_date':day,'label_known_max':max(r['label_known_date'] for r in prior),
                'meta_train_dates':state['train_dates'],'calibration_dates':len({r['prediction_date'] for r in honest})})
        if stacker_recipe is not None:
            payload['stacker_recipe']=deepcopy(stacker_recipe)
            payload['training']['recipe_fit_receipt']=deepcopy(state['recipe_fit_receipt'])
        payload['payload_checksum']=payload_checksum(payload)
        return payload
    return build,evidence
