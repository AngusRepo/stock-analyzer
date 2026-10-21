import ast
from pathlib import Path
from types import SimpleNamespace
import pytest
from app.training_lifecycle_dispatch import start_lifecycle,collect_lifecycle


def arguments():
    return dict(base_payload=lambda name:dict(model=name,run_date='2026-10-01'),
        sequence_records=[{'symbol':'2330'}],sequence_length=lambda name:1024,
        sequence_gcs_prefix='frozen',sequence_batch_count=10,sequence_device='cuda')


def test_all_independent_models_start_before_first_wait_and_keep_payload():
    log=[];names=['GNN','TabM','iTransformer'];payloads={}
    def function(name):
        def spawn(payload):
            log.append(('spawn',name));payloads[name]=payload
            def get():
                assert [n for action,n in log if action=='spawn']==names
                log.append(('get',name));return {'model':name,'elapsed_s':2.5}
            return SimpleNamespace(get=get)
        return SimpleNamespace(spawn=spawn)
    batch=start_lifecycle(names,functions={n:function(n) for n in names},**arguments())
    assert log==[('spawn',n) for n in names]
    results,errors,_=collect_lifecycle(batch)
    assert not errors and all(r['elapsed_s']==2.5 for r in results.values())
    assert payloads['GNN']=={'model':'GNN','run_date':'2026-10-01'}
    assert payloads['iTransformer']['sequence_gcs_prefix']=='frozen'


def test_journal_owner_reused_and_one_failure_does_not_discard_other_results():
    seen=[]
    class Journal:
        def spawn(self,stage,spawn,payload):
            seen.append(stage)
            return SimpleNamespace(get=lambda: {'error':'failed'} if stage.endswith('GNN') else {'saved':True})
    functions={n:SimpleNamespace(spawn=lambda p:pytest.fail('duplicate paid spawn')) for n in ('GNN','TabM')}
    batch=start_lifecycle(['GNN','TabM'],functions=functions,journal=Journal(),**arguments())
    results,errors,_=collect_lifecycle(batch)
    assert seen==['lifecycle/GNN','lifecycle/TabM'] and errors=={'GNN':'failed'}
    assert results['TabM']['saved'] is True


def test_missing_sequence_does_not_start_its_job():
    args=arguments();args['sequence_records']=[]
    batch=start_lifecycle(['iTransformer'],functions={'iTransformer':SimpleNamespace(spawn=lambda p:pytest.fail('missing data fit'))},**args)
    assert batch['errors']=={'iTransformer':'missing_sequence_records_artifact'}


def test_actual_orchestrator_launch_precedes_primary_wait():
    path=Path(__file__).resolve().parents[2]/'ml-service/modal_app.py'
    tree=ast.parse(path.read_text(encoding='utf-8'))
    owner=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='retrain_orchestrator')
    launches=[n.lineno for n in ast.walk(owner) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='start_lifecycle']
    waits=[n.lineno for n in ast.walk(owner) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='get'
        and isinstance(n.func.value,ast.Subscript) and isinstance(n.func.value.value,ast.Name) and n.func.value.value.id=='handles']
    assert len(launches)==1 and waits and launches[0]<min(waits)
