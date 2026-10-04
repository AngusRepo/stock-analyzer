from copy import deepcopy
import pytest
from test_paper_runtime_approval import runtime_pair, reseal
from services import active8_paper_admission as p

@pytest.mark.parametrize('fault',[None,'missing','source','variable','unknown','declaration','live','prior_present'])
def test_exact_tabpack_runtime_change_still_requires_explicit_signed_approval(runtime_pair,fault):
    old,new=runtime_pair
    for section,transitions in [('allocator_source_identity',p.TABPACK_RUNTIME_CHANGE['allocator_sources']),('variables',p.TABPACK_RUNTIME_CHANGE['variables'])]:
        before=old['configuration'][section] if section!='variables' else old['configuration']['native_execution_policy']['variables']
        after=new['configuration'][section] if section!='variables' else new['configuration']['native_execution_policy']['variables']
        for name,t in transitions.items():
            if t['previous'] is not None:before[name]=t['previous']
            after[name]=t['approved']
    if fault=='prior_present':old['configuration']['allocator_source_identity']['l4_tabpack_weights.py']=None
    new['admission']=deepcopy(old)
    new['approved_tabpack_runtime_change']=deepcopy(p.TABPACK_RUNTIME_CHANGE)
    if fault=='missing':new.pop('approved_tabpack_runtime_change')
    if fault=='source':new['configuration']['allocator_source_identity']['l4_tabpack_weights.py']='f'*64
    if fault=='variable':new['configuration']['native_execution_policy']['variables']['S12_INTRADAY_ASSIST_ENABLED']='1'
    if fault=='unknown':new['configuration']['risk_config']['new']='allowed'
    if fault=='declaration':new['approved_tabpack_runtime_change']['efficacy_status']='proven'
    if fault=='live':new['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED']='1'
    reseal(new)
    if fault:
        with pytest.raises(RuntimeError):p.validate_runtime_approval(new,old)
    else:assert p.validate_runtime_approval(new,old)==new
