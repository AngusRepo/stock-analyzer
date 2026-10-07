"""Explicit zero-sample cohort successor; retains frozen M/H/T model bytes.

Never modifies the predecessor or deploys. Only the serving champion role
changes; protocol, economic accounts, original checkpoints and fixed T remain.
"""
import argparse
import ast
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ml-controller'))
from services.l4_distribution import digest, validate_bundle
from services.l4_mlp_median import SEEDS, SCHEMA


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(source,output,candidate,prior_event,effective_signal_date,weights_folder=None):
    source,output=Path(source),Path(output)
    manifest=read(source/'manifest.json')
    for relative,expected in manifest['files'].items():
        if sha(source/relative)!=expected:raise ValueError('forward_predecessor_source_changed:'+relative)
    prior=json.loads(gzip.decompress(Path(prior_event).read_bytes()))
    content=prior['content'];state=content['state']
    # The caller must also compare the live head to this exact predecessor
    # event immediately before publication. An old armed event alone is not a
    # proof that no samples were collected afterwards.
    if (content['key']!='armed' or state['runtime_sha256']!=sha(source/'manifest.json')
            or state['signals'] or state['mature_labels'] or state['last_closed_date'] is not None
            or any(a['fills'] or a['daily'] or a['plans'] for a in state['accounts'].values())):
        raise ValueError('forward_successor_requires_verified_zero_sample_predecessor')
    if weights_folder:
        from services.l4_mlp_weights import prime_folder
        prime_folder(candidate,weights_folder)
    validate_bundle(candidate,l3_identity=candidate['l3_identity'],signal_date=effective_signal_date,require_paper_release=False)
    m=candidate['model'].get('residual_mlp') or {}
    original=read(source/'models/w22-anchor-original.json')
    if (m.get('schema_version')!=SCHEMA or m.get('residual_multiplier')!=1.0
            or m.get('anchor_model_checksum')!=original['model_checksum']
            or candidate['l3_identity']!=read(source/'models/formal-tabpack-artifact.json')['l3_identity']):
        raise ValueError('forward_champion_not_original_full_mlp_median')
    for member,seed in zip(m['members'],SEEDS,strict=True):
        if member['provenance']['checkpoint_sha256']!=sha(source/f'models/w22-MLP-{seed}.pt'):
            raise ValueError('forward_champion_checkpoint_changed')
    if output.exists():raise ValueError('forward_successor_output_already_exists')
    shutil.copytree(source,output,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    transition={'schema_version':'three-arm-champion-role-transition-v1',
        'effective_signal_date':effective_signal_date,'serving_champion':'M','shadow_arms':['H','T'],
        'serving_champion_checksum':candidate['model_checksum'],
        'fixed_tabpack_checksum':read(source/'models/registration.json')['arms']['T']['model_checksum'],
        'serving_l3_identity':candidate['l3_identity'],
        'predecessor_runtime_sha256':sha(source/'manifest.json'),
        'predecessor_head_checksum':prior['checksum'],'predecessor_cohort_id':state['cohort_id'],
        'predecessor_samples':0,'protocol_sha256':sha(source/'models/protocol_three_arm_freeze.md'),
        'model_bytes_changed':False,'prior_cohort_rewritten':False,'promotion':'NO'}
    (output/'champion-role-transition.json').write_text(json.dumps(transition,indent=2,sort_keys=True),encoding='utf8')
    (output/'serving-champion-model.json').write_text(json.dumps(candidate['model'],sort_keys=True,separators=(',',':')),encoding='utf8')
    path=output/'forward_models.py';text=path.read_text(encoding='utf8')
    old="    if live.get('model_checksum') != models['registration']['arms']['T']['model_checksum']:\n        raise ValueError('forward_tabpack_changed_new_cohort_required')"
    new="    validate_champion_role(live, packet['manifest']['signal_date'], models)"
    if text.count(old)!=1:raise ValueError('forward_source_guard_layout_changed')
    text=text.replace(old,new)
    numeric_source=Path(__file__).resolve().parents[1]/'ml-controller/services/opb_nav_control.py'
    numeric_text=numeric_source.read_text(encoding='utf8')
    node=next(n for n in ast.parse(numeric_text).body if isinstance(n,ast.FunctionDef) and n.name=='_same_json')
    text+='\n\n'+ast.get_source_segment(numeric_text,node)+'\n'
    text+='''

def validate_champion_role(live, signal_date, models):
    transition = read(HERE / 'champion-role-transition.json')
    if (transition['schema_version'] != 'three-arm-champion-role-transition-v1'
            or transition['serving_l3_identity'] != models['artifact']['l3_identity']
            or transition['fixed_tabpack_checksum'] != models['registration']['arms']['T']['model_checksum']
            or transition['protocol_sha256'] != sha(HERE / 'models/protocol_three_arm_freeze.md')):
        raise ValueError('forward_champion_transition_invalid')
    expected = (transition['serving_champion_checksum'] if signal_date >= transition['effective_signal_date']
                else transition['fixed_tabpack_checksum'])
    expected_model = (read(HERE / 'serving-champion-model.json') if signal_date >= transition['effective_signal_date']
                      else models['tabpack'])
    # Worker JSON.stringify changes 0.0 into 0. Compare every field to the
    # checksum-verified original, preserving boolean/string types and all floats.
    if (native.digest(expected_model) != expected or live.get('model_checksum') != expected
            or not _same_json(live.get('model'), expected_model)
            or live.get('l3_identity') != transition['serving_l3_identity']):
        raise ValueError('forward_champion_changed_new_cohort_required')
'''
    path.write_text(text,encoding='utf8')
    manifest['champion_role_transition']=transition
    manifest['sources']['ml-controller/services/opb_nav_control.py']=sha(numeric_source)
    manifest['files']={str(p.relative_to(output)).replace('\\','/'):sha(p) for p in sorted(output.rglob('*'))
        if p.is_file() and p.name!='manifest.json' and '__pycache__' not in p.parts}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf8')
    return {'status':'LOCAL_SUCCESSOR_PREPARED','runtime_sha256':sha(output/'manifest.json'),
        'prior_head_checksum':prior['checksum'],'prior_cohort_rewritten':False,
        'requires_live_head_compare_before_publish':True,'remote_mutations_executed':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('source-runtime','output','candidate','prior-event','effective-signal-date'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--weights-folder')
    args=parser.parse_args()
    print(json.dumps(prepare(args.source_runtime,args.output,read(args.candidate),args.prior_event,args.effective_signal_date,args.weights_folder)))
