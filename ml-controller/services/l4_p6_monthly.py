"""Explicit P6 monthly handoff. Never delegates to the legacy R2 refresh.

The input producer registers this exact L3/cutoff's sealed causal folds. Missing
preparation is pending work, not a successful skip or permission to reuse old data.
"""
import io,json,re,zipfile
from datetime import date
from services.l4_distribution import digest,validate_bundle
from services.l4_p6_recipe import RECIPE
from services.l4_p6_dispatch import read,advance
from services.training_dual_cutoff import TrainingCutoff

PREFIX='l4_distribution/p6_monthly_runs/'


def key_for(*,identity,manifest_checksum,as_of,cadence):
    return digest(dict(recipe=RECIPE,l3_identity=identity,source_manifest_checksum=manifest_checksum,
        as_of=as_of,cadence=cadence))


def completed(bucket,run_key,*,identity,manifest_checksum,as_of,cadence="monthly"):
    if not re.fullmatch('[a-f0-9]{64}',run_key):raise ValueError('p6_monthly_run_key_invalid')
    result=read(bucket,PREFIX+run_key+'/completed.json')
    if (not result or result.get('status')!='validated' or result.get('model_family')!='p6_a'
            or result.get('training_recipe')!=RECIPE or result.get('run_key')!=run_key
            or result.get('promoted') is not False):raise ValueError('p6_monthly_completion_invalid')
    from services.l4_p6_results import _read
    raw,_=_read(bucket,result['artifact_path'],result['artifact_reference']);candidate=json.loads(raw)
    source=candidate.get('challenger_training_source') or {}
    if (cadence not in ('monthly','manual') or candidate.get('cadence')!=cadence or source.get('run_key')!=run_key
            or source.get('as_of')!=as_of or source.get('source_manifest_checksum')!=manifest_checksum
            or digest(candidate)!=result['artifact_checksum']):raise ValueError('p6_monthly_candidate_binding')
    decision_day=source['first_evaluation_signal_date']
    date.fromisoformat(decision_day)
    validate_bundle(candidate,l3_identity=identity,signal_date=decision_day,require_paper_release=False)
    from services.l4_p6_bundle import validate
    validate(candidate,l3_identity=identity,signal_date=decision_day,
        load_bytes=lambda ref:_read(bucket,ref['path'],ref)[0])
    return result


def verify_phase_source(bucket,phase,source,expected_phase):
    from services.l4_p6_dispatch import validate_source
    from services.l4_p6_results import _read
    validate_source(phase)
    if phase['phase']!=expected_phase:raise ValueError('p6_monthly_phase_order')
    raw,_=_read(bucket,phase['inputs']['path'],phase['inputs'])
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if archive.namelist().count('batch-seal.json')!=1:raise ValueError('p6_monthly_seal_missing')
        seal=json.loads(archive.read('batch-seal.json'))
    if (seal.get('batch_id')!=phase['batch_id'] or digest({k:v for k,v in seal.items() if k!='batch_id'})!=phase['batch_id']
            or seal.get('phase')!=expected_phase or seal.get('recipe')!=RECIPE
            or any(seal.get('provenance',{}).get(k)!=source.get(k) for k in
                ('l3_identity','requested_cutoff','ancestor_graph_sha256','calendar_receipt_sha256','source_manifest_checksum','first_evaluation_signal_date'))):
        raise ValueError('p6_monthly_archive_provenance')


def execute(*,bucket,identity,manifest,as_of,cadence,completed_run_key=None,spawn=None):
    if cadence not in ('monthly','manual'):
        return dict(status='not_requested',reason='p6_neural_training_monthly_only',model_family='p6_a',
            cadence=cadence,training_dispatched=False,promoted=False)
    manifest_checksum=manifest['manifest_checksum']
    key=key_for(identity=identity,manifest_checksum=manifest_checksum,as_of=as_of,cadence=cadence)
    if completed_run_key is not None:
        if completed_run_key!=key:raise ValueError('p6_monthly_wrong_completed_run')
        return completed(bucket,key,identity=identity,manifest_checksum=manifest_checksum,as_of=as_of,cadence=cadence)
    root=PREFIX+key+'/'
    if read(bucket,root+'completed.json') is not None:
        return completed(bucket,key,identity=identity,manifest_checksum=manifest_checksum,as_of=as_of,cadence=cadence)
    pending=dict(status='pending',model_family='p6_a',training_recipe=RECIPE,run_key=key,
        as_of=as_of,cadence=cadence,dependency_retry_required=True,training_dispatched=False,promoted=False)
    source=read(bucket,root+'source.json')
    if source is None:return {**pending,'stage':'awaiting_p6_causal_inputs',
        'reason':'exact_new_L3_fourfold_ancestor_isolation_and_dual_cutoff_not_yet_sealed'}
    if (source.get('recipe')!=RECIPE or source.get('l3_identity')!=identity
            or source.get('source_manifest_checksum')!=manifest_checksum or source.get('as_of')!=as_of
            or source.get('cadence')!=cadence or source.get('run_key')!=key
            or not re.fullmatch('[a-f0-9]{64}',source.get('ancestor_graph_sha256',''))
            or not re.fullmatch('[a-f0-9]{64}',source.get('calendar_receipt_sha256',''))):
        raise ValueError('p6_monthly_source_binding')
    cutoff=TrainingCutoff(**source['requested_cutoff'])
    # as_of is the monthly knowledge cutoff, not the first decision day.
    # Plan A legitimately has both as_of and known_max equal to 10/1.
    decision_day=source['first_evaluation_signal_date']
    date.fromisoformat(decision_day)
    l3_known=source['l3_training_label_known_max'];date.fromisoformat(l3_known)
    if l3_known>cutoff.label_known_at_max or cutoff.label_known_at_max>as_of or cutoff.label_known_at_max>=decision_day:
        raise ValueError('p6_monthly_source_after_decision')
    verify_phase_source(bucket,source['cv_phase'],source,'cv')
    cv=advance(bucket,source['cv_phase'],spawn=spawn)
    if cv['status']!='phase_complete':return {**pending,**cv,'stage':'cv'}
    final=read(bucket,root+'final-source.json')
    if final is None:
        from services.l4_p6_monthly_collect import prepare_final_phase
        final=prepare_final_phase(bucket,source,root)
        if final.get('status')=='needs_user_decision':return final
    if (final.get('run_key')!=key or final.get('cv_batch_id')!=source['cv_phase']['batch_id']
            or not re.fullmatch('[a-f0-9]{64}',final.get('cv_collection_checksum',''))
            or final.get('requested_cutoff')!=source['requested_cutoff']
            or final.get('l3_identity')!=identity or final.get('epoch_reselection_allowed') is not False):
        raise ValueError('p6_monthly_final_binding')
    verify_phase_source(bucket,final['final_phase'],source,'final')
    refit=advance(bucket,final['final_phase'],spawn=spawn)
    if refit['status']!='phase_complete':return {**pending,**refit,'stage':'final_refit'}
    from services.l4_p6_monthly_collect import finalize_candidate
    finalize_candidate(bucket,source,final,root)
    return completed(bucket,key,identity=identity,manifest_checksum=manifest_checksum,as_of=as_of,cadence=cadence)
