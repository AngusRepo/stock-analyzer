"""Build and verify a local Paper cutover/rollback packet, never publishes."""
from copy import deepcopy
from datetime import datetime,timezone
import hashlib,json,re,sys
from pathlib import Path
import xml.etree.ElementTree as ET

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ml-controller'))
from services.l4_distribution import digest
from services.paired_nav_journal import digest as journal_digest
from services.l4_distribution_lifecycle import ACCEPTANCE_CHECKS
from services.l4_distribution_runtime import distribution_policy_identity
from services.l4_release_packet import prepare_packet
from services.l4_mlp_weights import prime_folder
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_recommendation_path import recommendation_source_identity
from services.native_paper_sandbox import native_execution_identity
from services.active8_paper_admission import validate_runtime_approval,RUNTIME_SCHEMA
from services.l4_model_cutover import SCHEMA as CUTOVER_SCHEMA


def read(path):return json.loads(Path(path).read_text(encoding='utf8'))
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value):Path(path).write_text(json.dumps(value,indent=2,allow_nan=False),encoding='utf8')


def build(folder,*,source_reference,signal_date):
    folder=Path(folder);candidate=read(folder/'candidate-compact.json');prime_folder(candidate,folder/'weights')
    config=read(folder/'current-config-private.json');prior=read(folder/'prior-runtime-approval-private.json')
    if config!=prior['configuration']['trading_config']:
        raise ValueError('cutover_current_config_prior_approval_drift')
    account=read(folder/'current-account-private.json');parity=read(folder/'compact-checkpoint-parity.json')
    pool=read(folder/'full-pool-engineering-final.json');forward=read(folder/'forward-successor-preflight.json')
    risk_forward=read(folder/'forward-risk-v3-preflight.json')
    if (parity['model_checksum']!=candidate['model_checksum'] or not parity['all_original_layers_exact']
            or parity['native_adapter_exact'] is not True or pool['model_checksum']!=candidate['model_checksum']
            or pool['pool']!=700 or pool['proof']['preselection'] is not False or not pool['proof']['within_tolerance']
            or forward['status']!='PREFLIGHT_PASS' or forward['forward_sample_count']!=0
            or risk_forward['status']!='PREFLIGHT_PASS' or risk_forward['forward_sample_count']!=0
            or risk_forward['full_pool_count']!=700 or risk_forward['max_absolute_error']>1e-6):
        raise ValueError('cutover_engineering_evidence_incomplete')
    for name in ('targeted-python.xml','final-model-tests.xml','final-lifecycle-tests.xml'):
        root=ET.parse(folder/name).getroot()
        suites=[root] if root.tag=='testsuite' else list(root)
        if not suites or any(int(s.get('failures','0')) or int(s.get('errors','0')) for s in suites):
            raise ValueError('cutover_python_evidence_failed:'+name)
    native=(folder/'native-l4-final-tests.log').read_text(encoding='utf8')
    if not re.search(r'pass 17\b',native) or not re.search(r'fail 0\b',native):
        raise ValueError('cutover_native_paper_execution_failed')
    source={'scope':'native_engineering_paper_execution','complete':True,
        'model_checksum':candidate['model_checksum'],'efficacy_status':'unproven',
        'evidence_files':{n:sha(folder/n) for n in ('compact-checkpoint-parity.json','full-pool-engineering-final.json',
            'targeted-python.xml','final-model-tests.xml','final-lifecycle-tests.xml','native-l4-final-tests.log',
            'forward-successor-preflight.json','forward-risk-v3-preflight.json',
            'staged-weights-receipt.json')},
        'diagnostic_pool_not_prospective':True,'diagnostic_plan_publication_allowed':False,
        'fresh_prospective_plan_required_after_cutover':True,'training_calls':0,
        'opb_policy':deepcopy(config['l4Distribution']['opb'])}
    source['opb_policy']['approved_policy_identity']=distribution_policy_identity({
        'artifact':candidate,'constraints':config['l4Distribution']['constraints'],
        'opb':source['opb_policy']},candidate['l3_identity'])
    acceptance={'schema_version':'l4-paper-acceptance-v1','model_checksum':candidate['model_checksum'],
        'l3_identity_checksum':digest(candidate['l3_identity']),'feature_schema':candidate['feature_schema'],
        'checks':dict.fromkeys(ACCEPTANCE_CHECKS,True),'source_evidence_checksum':digest(source),
        'acceptance_mode':'paper_experiment','efficacy_status':'unproven',
        'experiment_authorization':{'scope':'paper','approved':True,'source_reference':source_reference,
            'model_checksum':candidate['model_checksum']}}
    packet=prepare_packet(current_config=config,candidate=candidate,acceptance=acceptance,
        source_evidence=source,l3_identity=candidate['l3_identity'],constraints=config['l4Distribution']['constraints'],
        signal_date=signal_date,current_l3_identity=config['l4Distribution']['artifact']['l3_identity'],
        current_plan_id=account['active_plan_id'])
    new_configuration=deepcopy(prior['configuration']);new_configuration['trading_config']=packet['next_config']
    new_configuration['allocator_source_identity']=allocator_source_identity()
    new_configuration['l3_inference_source_identity']=recommendation_source_identity()
    new_configuration['native_execution_policy']['execution_owner_version']=native_execution_identity()
    grant={'schema_version':CUTOVER_SCHEMA,'scope':'paper','maturity_transfer':False,'account_reset':False,
        'signal_date':signal_date,'previous_configuration_checksum':journal_digest(prior['configuration']),
        'next_configuration_checksum':journal_digest(new_configuration),
        'previous_model_checksum':config['l4Distribution']['artifact']['model_checksum'],
        'next_model_checksum':candidate['model_checksum']}
    approval={'schema_version':RUNTIME_SCHEMA,'admission':deepcopy(prior['admission']),
        'configuration':new_configuration,'scope':'paper','approved':True,
        'approved_at':datetime.now(timezone.utc).isoformat(),'maturity_transfer':False,'efficacy_status':'unproven',
        'source_reference':source_reference,'prior_runtime_approval':deepcopy(prior),
        'approved_full_mlp_champion_cutover':grant}
    approval['approval_checksum']=journal_digest(approval)
    validate_runtime_approval(approval,prior['admission'])
    packet.update(production_deployment_authorized=False,production_deployed=False,
        next_runtime_approval_checksum=approval['approval_checksum'],
        prospective_plan_status='awaiting_next_canonical_signal_context',
        previous_active_plan_preserved=True,opb_prior_rewards_transferred=False,
        worker_source_base='bdf904c74e2e1e72b3c3889aa7b5e4a884905612')
    save(folder/'source-evidence.json',source);save(folder/'acceptance.json',acceptance)
    save(folder/'cutover-packet-private.json',packet);save(folder/'next-config-private.json',packet['next_config'])
    save(folder/'rollback-config-private.json',packet['rollback_config']);save(folder/'next-runtime-approval-private.json',approval)
    result={'status':'VERIFIED_LOCAL_CUTOVER_AND_ROLLBACK_PACKET','model_checksum':candidate['model_checksum'],
        'operating_mode':packet['next_config']['l4Distribution']['operating_mode'],
        'runtime_identity':native_execution_identity(),'configuration_checksums_verified':True,
        'runtime_approval_chain_verified':True,'prospective_plan_status':packet['prospective_plan_status'],
        'production_deployed':False,'source_evidence_checksum':digest(source)}
    save(folder/'packet-verification.json',result)
    return result


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--folder',required=True);p.add_argument('--source-reference',required=True);p.add_argument('--signal-date',required=True)
    a=p.parse_args();print(json.dumps(build(a.folder,source_reference=a.source_reference,signal_date=a.signal_date)))
