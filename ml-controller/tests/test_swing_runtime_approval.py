from copy import deepcopy
import pytest
from test_paper_runtime_approval import runtime_pair,reseal
from services import active8_paper_admission as p

@pytest.mark.parametrize('fault',[None,'missing','price_policy','unknown','source','live','declaration'])
def test_swing_requires_exact_paper_authority(runtime_pair,fault):
    old,new=runtime_pair
    before=old['configuration'];after=new['configuration']
    for key,t in p.SWING_POLICY_CHANGE['variables'].items():
        if t['previous'] is not None:before['native_execution_policy']['variables'][key]=t['previous']
        after['native_execution_policy']['variables'][key]=t['approved']
    for name,t in p.SWING_POLICY_CHANGE['allocator_sources'].items():
        before['allocator_source_identity'][name]=t['previous'];after['allocator_source_identity'][name]=t['approved']
    new['admission']=deepcopy(old)
    new['approved_single_plan_swing_change']=deepcopy(p.SWING_POLICY_CHANGE)
    if fault=='missing':new.pop('approved_single_plan_swing_change')
    if fault=='price_policy':after['native_execution_policy']['variables']['PAPER_INTRADAY_ENTRY_OWNER']='other'
    if fault=='unknown':after['native_execution_policy']['variables']['PAPER_SILENT_RISK']='off'
    if fault=='source':after['allocator_source_identity']['l4_distribution_context.py']='f'*64
    if fault=='live':after['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED']='1'
    if fault=='declaration':new['approved_single_plan_swing_change']['efficacy_status']='proven'
    reseal(new)
    if fault:
        with pytest.raises(RuntimeError):p.validate_runtime_approval(new,old)
    else:assert p.validate_runtime_approval(new,old)==new
