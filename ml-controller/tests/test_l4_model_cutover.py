"""Narrow runtime succession rejects changes beyond the reviewed model/source."""
from copy import deepcopy
from datetime import datetime,timezone
import hashlib
from pathlib import Path
import pytest

from services.l4_model_cutover import validate_cutover,SCHEMA
from services.paired_nav_journal import digest
from services.l4_distribution_runtime import distribution_policy_identity
from services.l4_allocation_contract import native_opb_policy
from services.paper_strategy_mode import MLP_MODE
from test_l4_distribution_runtime import fixture
from test_full_mlp_median import full_release
from test_paper_single_b_tabpack import released


def approval(monkeypatch):
    from services import active8_paper_admission,native_paper_sandbox
    _,policy,_=fixture();policy.pop('runtime');policy['artifact']=released(policy['artifact'])
    policy.update(operating_mode='single_b_tabpack_v1',strategy_role='B')
    policy['opb']=native_opb_policy(policy['constraints'])
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,policy['artifact']['l3_identity'])
    config={'trading_config':{'l4Distribution':policy,'fees':{'commission':.001425}},
        'risk_config':{'untouched':True},'allocator_source_identity':{},'l3_inference_source_identity':{},
        'native_execution_policy':{'execution_owner_version':'native-paper-v1:'+'a'*64,
            'variables':{'LIVE_EXECUTION_CLIENT_ENABLED':'0','LIVE_EXECUTION_SUBMIT_GUARD_ENABLED':'0'}}}
    prior={'configuration':deepcopy(config)}
    monkeypatch.setattr(active8_paper_admission,'validate_runtime_approval',lambda value,*a,**k: value if value==prior else pytest.fail('wrong predecessor'))
    native='native-paper-v1:'+'b'*64
    monkeypatch.setattr(native_paper_sandbox,'native_execution_identity',lambda:native)
    new=config['trading_config']['l4Distribution'];new['artifact']=full_release(new['artifact']);new['operating_mode']=MLP_MODE
    new['opb']['approved_policy_identity']=distribution_policy_identity(new,new['artifact']['l3_identity'])
    path=Path(active8_paper_admission.__file__).with_name('l4_mlp_median.py')
    config['allocator_source_identity']['l4_mlp_median.py']=hashlib.sha256(path.read_bytes()).hexdigest()
    config['native_execution_policy']['execution_owner_version']=native
    result={'prior_runtime_approval':prior,'configuration':config,'approved_full_mlp_champion_cutover':{
        'schema_version':SCHEMA,'scope':'paper','maturity_transfer':False,'account_reset':False,'signal_date':'2026-09-21',
        'previous_configuration_checksum':digest(prior['configuration']),'next_configuration_checksum':digest(config),
        'previous_model_checksum':prior['configuration']['trading_config']['l4Distribution']['artifact']['model_checksum'],
        'next_model_checksum':new['artifact']['model_checksum']}}
    return result


def test_valid_full_cutover_preserves_predecessor_and_policy(monkeypatch):
    r=approval(monkeypatch);before=deepcopy(r)
    assert validate_cutover(r,admission={},now=datetime.now(timezone.utc))==r
    assert r==before


@pytest.mark.parametrize('fault',['risk','fees','caps','opb','source','execution','live','reset'])
def test_cutover_cannot_launder_other_changes(monkeypatch,fault):
    r=approval(monkeypatch);c=r['configuration'];p=c['trading_config']['l4Distribution']
    if fault=='risk':c['risk_config']['untouched']=False
    if fault=='fees':c['trading_config']['fees']['commission']=0
    if fault=='caps':p['constraints']['exposure_cap']=.9
    if fault=='opb':p['opb']['exploration']=.8
    if fault=='source':c['allocator_source_identity']['l4_mlp_median.py']='c'*64
    if fault=='execution':c['native_execution_policy']['execution_owner_version']='native-paper-v1:'+'c'*64
    if fault=='live':c['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED']='1'
    if fault=='reset':r['approved_full_mlp_champion_cutover']['account_reset']=True
    r['approved_full_mlp_champion_cutover']['next_configuration_checksum']=digest(c)
    with pytest.raises((RuntimeError,ValueError)):validate_cutover(r,admission={},now=datetime.now(timezone.utc))
