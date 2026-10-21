"""Real Python P6 producer output must pass the Worker serving admission."""
import json,subprocess,shutil
from copy import deepcopy
from pathlib import Path
from services.l4_distribution import digest
from services.l4_distribution_lifecycle import prepare_paper_release,P6_ACCEPTANCE_CHECKS
from test_l4_p6_runtime import setup,IDENTITY

ROOT=Path(__file__).resolve().parents[2]

def test_python_p6_release_and_private_candidate_match_worker_contract():
    _,policy,_,_=setup();bundle=policy['artifact']
    receipt=dict(schema_version='l4-paper-acceptance-v1',model_checksum=bundle['model_checksum'],
        l3_identity_checksum=digest(IDENTITY),feature_schema=bundle['feature_schema'],
        checks=dict.fromkeys(P6_ACCEPTANCE_CHECKS,True),source_evidence_checksum='c'*64,
        acceptance_mode='p6_r32_paper',efficacy_status='inner_only_outer_unproven',
        inner_report_checksum=bundle['model']['inner_report']['checksum'],
        experiment_authorization=dict(scope='paper',approved=True,model_checksum=bundle['model_checksum'],source_reference='test-only'))
    linear=deepcopy(bundle);linear['model']['calibration_kind']='linear';linear['model_checksum']=digest(linear['model'])
    receipt['model_checksum']=linear['model_checksum'];receipt['experiment_authorization']['model_checksum']=linear['model_checksum']
    released=prepare_paper_release(linear,receipt,signal_date='2026-10-19')
    code=r"""
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {l4ReleaseEvidenceError,validL4FeatureSchema}=require('./src/lib/l4ReleaseEvidence.ts');
const {validateTradingConfig,buildChampionTradingConfig}=require('./src/lib/tradingConfig.ts');
const {validSingleBModel}=require('./src/lib/paperStrategyMode.ts');
const p=JSON.parse(readFileSync(0,'utf8'));
assert.equal(validL4FeatureSchema(p.bundle),true);
assert.equal(l4ReleaseEvidenceError(p.released),null);
assert.notEqual(l4ReleaseEvidenceError(p.bundle),null,'unreleased is never formal');
const privateConfig=buildChampionTradingConfig({l4Distribution:p.policy});
assert.deepEqual(validateTradingConfig(privateConfig,true),[]);
assert.notDeepEqual(validateTradingConfig(privateConfig),[]);
const b={...p.policy,scope:'paper',artifact:p.released,operating_mode:'single_b_p6_direct_excess_v1',strategy_role:'B'};
assert.equal(b.artifact.model.calibration_kind,'linear');
assert.equal(validSingleBModel(b),true);
assert.deepEqual(validateTradingConfig(buildChampionTradingConfig({l4Distribution:b})),[]);
// Each actual producer engineering check is mandatory at the consumer.
for(const key of p.checks){
  const a=structuredClone(p.released);a.release.validation_receipt.checks[key]=false;
  assert.notEqual(l4ReleaseEvidenceError(a),null,key);
}
for(const bin of [6,7,8]){
 const a=structuredClone(p.released);a.model.calibration.realized_bins.find(v=>v.bin===bin).mean=0;
 assert.equal(l4ReleaseEvidenceError(a),'p6_release_inner_gate_failed');
}
const a=structuredClone(p.released);a.model.A={};assert.equal(validL4FeatureSchema(a),false);
console.log(JSON.stringify({producer_consumer_parity:true,engineering_checks:p.checks.length,private_guard:true}));
"""
    result=subprocess.run([shutil.which('node'),'--import','tsx','-e',code],cwd=ROOT/'worker',
        input=json.dumps(dict(policy=policy,bundle=bundle,released=released,checks=P6_ACCEPTANCE_CHECKS)),
        capture_output=True,text=True,encoding='utf8',timeout=60)
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)['producer_consumer_parity']
